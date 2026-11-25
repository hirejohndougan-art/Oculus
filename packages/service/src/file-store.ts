/**
 * The file store on local disk (M-002, D-086): where uploaded bytes go.
 *
 * Layout under the configured folder (`OCULUS_FILES_DIR`, an absolute path
 * to an existing directory owned by the server's user and writable by it
 * alone):
 *
 *     <dir>/<organization id>/sha256/<first two hex digits>/<sha256>
 *     <dir>/<organization id>/incoming/<random>.part
 *
 * Every path is built from an organization ID (checked as a UUID) and a
 * SHA-256 this module computed itself, or a random name; **no part of a
 * path ever comes from a client** (a file's original name is metadata in
 * the database only). One copy per organization and content: two assets
 * holding the same bytes share it, and organizations never share one
 * (D-019). **No link is ever followed below the root**: every folder on the
 * way is checked with `lstat` (a real directory, ours, not writable by
 * group or others) before it is used, and files are opened `O_NOFOLLOW`.
 *
 * `receive` streams a body into a new temporary file (`O_EXCL`,
 * `O_NOFOLLOW`, mode 0600) while hashing and counting it. It stops as soon
 * as the per-file cap, the organization's total (what it stores plus every
 * upload of it in flight in this process) or the free-space floor would be
 * passed, removing the partial file before it returns; then it fsyncs, and
 * reads the file back to check the SHA-256 again. The result is an opaque
 * handle; its temporary path stays in this module.
 *
 * `place` (called by the service inside the attach transaction, under the
 * organization's file lock) hard-links the temporary file to its content
 * path (or renames it there, on a file system without hard links), removes
 * the temporary name and fsyncs the folders, all before the lock is
 * released, so a stored copy has exactly one link. If the content is
 * already there it is kept only when it is a regular file with one link,
 * owned by us, of the same size and SHA-256; anything else is replaced in
 * one step by rename. Nothing is ever written in place. `discard` removes
 * the temporary file and releases its share of the organization's total.
 *
 * **The folder belongs to one install**: a marker file in its root
 * (`STORE_MARKER`) holds the install's ID, which the database holds too
 * (the service's `bindFileStore`), and the folder's lease epoch, which must
 * equal the database's current one. Servers note themselves in
 * `.oculus-servers` (`claimServer`), so a second database on this machine
 * can't use the folder at the same time.
 *
 * **Nothing automatic deletes a stored copy** (D-086, fourth review). The
 * automatic sweep (the service's `sweepFiles`) only removes temporary
 * uploads (`staleIncoming`: older than an upload may run, by the file
 * system's own clock, never one this process is still writing) and empties
 * the trash a stopped purge left. Only the operator's purge
 * (`npm run files:purge`) moves copies into the trash (`trash`, under the
 * organization's file lock) and deletes them (`emptyTrash`, after it);
 * `listContents` gives it regular files only (anything else at a content
 * path is counted and left alone).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, openSync, rmSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { SNIFF_BYTES, isOrganizationId, isSha256Hex, type OrganizationId } from "@oculus/core";

/** Bytes in a mebibyte. */
const MIB = 1024 * 1024;
/** The default largest file: 500 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 500 * MIB;
/** The default total per organization: 20 GiB. */
export const DEFAULT_MAX_ORGANIZATION_BYTES = 20 * 1024 * MIB;
/** No cap may be set above this: 1 TiB (0032's column check). */
export const MAX_CAP_BYTES = 1024 * 1024 * MIB;
/** The default free-space floor: 5% of the disk or 2 GiB, whichever is smaller. */
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * MIB;
export const DEFAULT_MIN_FREE_FRACTION = 0.05;
/** How often the free space is looked at again while a file streams in. */
const FREE_SPACE_EVERY = 64 * MIB;

export interface FileStoreOptions {
  /** An absolute path to an existing directory, ours and writable by us alone. */
  readonly dir: string;
  /** The largest file, in bytes (default 500 MiB). */
  readonly maxFileBytes?: number;
  /** The most an organization may store, each content once (default 20 GiB). */
  readonly maxOrganizationBytes?: number;
  /**
   * Uploads are refused when they would leave less than this free on the
   * disk (default: 5% of it or 2 GiB, whichever is smaller). 0 turns the
   * check off.
   */
  readonly minFreeBytes?: number;
  /** The free space on the disk (tests). Default: `statfs`. */
  readonly freeSpace?: (dir: string) => Promise<{ free: number; total: number }>;
}

/** A received file: what the service needs, and nothing that names a path. */
export interface ReceivedFile {
  readonly organizationId: OrganizationId;
  readonly sha256: string;
  readonly size: number;
  /** The first bytes (at most `SNIFF_BYTES`), for sniffing the media type. */
  readonly head: Uint8Array;
}

export type ReceiveRefusal = "file_too_large" | "empty_file" | "quota_exceeded" | "disk_full";

export type ReceiveResult =
  | { readonly ok: true; readonly file: ReceivedFile }
  | { readonly ok: false; readonly code: ReceiveRefusal };

/** The marker file in the root that names the install the folder belongs to. */
export const STORE_MARKER = ".oculus-store-id";

/**
 * What the marker holds: the install's ID (line 1), the identity of the
 * database that last bound or adopted the folder (line 2, for people to
 * read; nothing is decided by it), and the folder's lease epoch (line 3,
 * which must equal the database's current epoch, D-086's fourth review).
 */
export interface StoreMarker {
  readonly storeId: string;
  readonly database?: string;
  readonly epoch?: string;
}

/** Where the servers using the folder note themselves (`claimServer`). */
const SERVERS_FOLDER = ".oculus-servers";

const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKER_DATABASE = /^[0-9A-Za-z_.:-]{1,100}$/;

export interface ReceiveOptions {
  /** The declared length, if any: held against the free-space floor from the start. */
  readonly declaredBytes?: number;
  /** Aborts the upload (the partial file is removed). */
  readonly signal?: AbortSignal;
  /** What the organization stores now (each content once), for its total. */
  readonly usedBytes?: number;
}

export interface FileStore {
  readonly maxFileBytes: number;
  readonly maxOrganizationBytes: number;
  /**
   * Streams `chunks` into a temporary file; see the module header. Throws if
   * the stream fails (the client went away) or the signal fires, also after
   * removing the partial file.
   */
  receive(
    organizationId: OrganizationId,
    chunks: AsyncIterable<Uint8Array>,
    options?: ReceiveOptions,
  ): Promise<ReceiveResult>;
  /** Whether `extra` more bytes would leave the disk below the free-space floor. */
  lowOnSpace(extra: number): Promise<boolean>;
  /** The marker in the root, if there is one. */
  readMarker(): Promise<StoreMarker | undefined>;
  /** Writes the marker (only into a folder that has none). */
  writeMarker(marker: Required<StoreMarker>): Promise<void>;
  /** Replaces the marker in one step (a rename), fsynced. */
  replaceMarker(marker: Required<StoreMarker>): Promise<void>;
  /** Whether another server is writing the marker right now (its temporary file exists). */
  markerInProgress(): Promise<boolean>;
  /** Milliseconds since the marker last changed, by the file system's own clock. */
  markerAge(): Promise<number | undefined>;
  /**
   * Notes this server as using the folder for `key` (the install, the
   * database and where it lives) until `release` or the process ends.
   * Refused when another live server on this machine uses it for another
   * key: two databases must never share one folder (D-086).
   */
  claimServer(
    key: string,
  ): Promise<{ readonly ok: true; release(): void } | { readonly ok: false }>;
  /** Whether the root holds anything at all. */
  isEmpty(): Promise<boolean>;
  /** Marks the store as checked against the database: the sweep may delete. */
  bind(storeId: string): void;
  /** The install ID the store was bound to, if it has been. */
  readonly boundTo: () => string | undefined;
  /** Puts the received bytes at their content path (see the module header). */
  place(file: ReceivedFile): Promise<"stored" | "already_stored">;
  /** Removes the temporary file and releases its share; safe to call more than once. */
  discard(file: ReceivedFile): Promise<void>;
  /** Where the content is stored (for reading in M-003 and in tests). */
  pathFor(organizationId: OrganizationId, sha256: string): string;
  /**
   * A stored copy, checked before anything is read (M-003): every folder on
   * the way a real directory of ours, the file a regular file of ours with
   * one link and exactly `size` bytes. Returns a function that opens a
   * stream of it (`O_NOFOLLOW`), or `undefined` when the copy is missing
   * or isn't what it should be.
   */
  openContent(
    organizationId: OrganizationId,
    sha256: string,
    size: number,
  ): Promise<(() => Readable) | undefined>;
  /**
   * Up to `maxBytes` of a stored copy from its start, checked as
   * `openContent` checks it; `undefined` when it is missing or isn't right.
   */
  readContent(
    organizationId: OrganizationId,
    sha256: string,
    size: number,
    maxBytes: number,
  ): Promise<Uint8Array | undefined>;
  /**
   * A cached thumbnail (M-003): its JPEG bytes, `"none"` when an earlier
   * attempt found it can't be made, or `undefined` when nothing is cached.
   * Kept per organization beside the copies (`thumbnails/<size>/<2
   * hex>/<sha256>.v1.jpg` or `.v1.none`), checked as the copies are.
   */
  readThumbnail(
    organizationId: OrganizationId,
    sha256: string,
    size: string,
  ): Promise<Uint8Array | "none" | { readonly timedOutAt: number } | undefined>;
  /**
   * Caches a thumbnail, `"none"` (the decoder refused it: never tried
   * again) or `"timeout"` (too slow: tried again after a while): written
   * to a temporary file, then renamed into place.
   */
  writeThumbnail(
    organizationId: OrganizationId,
    sha256: string,
    size: string,
    jpeg: Uint8Array | "none" | "timeout",
  ): Promise<void>;
  /**
   * Moves a content's cached thumbnails (every size and version) aside, for
   * `emptyTrash` to delete (the sweep, M-003).
   */
  trashThumbnails(organizationId: OrganizationId, sha256: string): Promise<void>;
  /** The organizations with a folder here. */
  organizations(): Promise<readonly OrganizationId[]>;
  /** The contents stored for an organization (their hashes). */
  contents(organizationId: OrganizationId): Promise<readonly string[]>;
  /** The same, with how many entries at content paths aren't regular files (left alone). */
  listContents(
    organizationId: OrganizationId,
  ): Promise<{ readonly hashes: readonly string[]; readonly skipped: number }>;
  /**
   * Moves a stored copy and its cached thumbnails (M-003) aside (call under
   * the organization's file lock); `emptyTrash` deletes them.
   */
  trash(organizationId: OrganizationId, sha256: string): Promise<void>;
  /** Deletes what `trash` moved aside; returns how many. */
  emptyTrash(organizationId: OrganizationId): Promise<number>;
  /** Deletes temporary files older than `maxAgeMs`; returns how many. */
  staleIncoming(maxAgeMs: number, organizations?: readonly string[]): Promise<number>;
}

function checkCap(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CAP_BYTES) {
    throw new RangeError(`${name} is a whole number of bytes from 1 to ${String(MAX_CAP_BYTES)}.`);
  }
  return value;
}

/** What `link` answers on a file system without hard links. */
const NO_LINKS: ReadonlySet<string> = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
]);

const WINDOWS = process.platform === "win32";
const MY_UID = typeof process.getuid === "function" ? process.getuid() : undefined;

/** Ours (where uids exist) and not writable by group or others (where modes mean that). */
function safeOwnership(info: { uid: number; mode: number }): boolean {
  if (WINDOWS) return true;
  if (MY_UID !== undefined && info.uid !== MY_UID) return false;
  return (info.mode & 0o022) === 0;
}

/** Writes all of `chunk` (a write may be short). */
async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("A write to the file store made no progress.");
    offset += bytesWritten;
  }
}

/**
 * Fsyncs a directory, so a link or rename in it survives a crash. Windows
 * can't open a directory for this (and NTFS journals the change itself).
 */
async function syncDirectory(path: string): Promise<void> {
  if (WINDOWS) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The SHA-256 of a file's bytes, read without following a link. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function defaultFreeSpace(dir: string): Promise<{ free: number; total: number }> {
  const info = await statfs(dir);
  return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
}

/**
 * Opens the store. Refuses a relative path, a path that isn't an existing
 * directory, and one owned by someone else or writable by group or others,
 * so a misconfigured server never starts. The messages name no path.
 */
export async function openFileStore(options: FileStoreOptions): Promise<FileStore> {
  const root = options.dir;
  if (typeof root !== "string" || root === "" || !isAbsolute(root)) {
    throw new Error("The files folder must be an absolute path.");
  }
  const maxFileBytes = checkCap("maxFileBytes", options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxOrganizationBytes = checkCap(
    "maxOrganizationBytes",
    options.maxOrganizationBytes,
    DEFAULT_MAX_ORGANIZATION_BYTES,
  );
  const minFree = options.minFreeBytes;
  if (minFree !== undefined && (!Number.isSafeInteger(minFree) || minFree < 0)) {
    throw new RangeError("minFreeBytes is a whole number of bytes, 0 or more.");
  }
  const freeSpace = options.freeSpace ?? defaultFreeSpace;
  const info = await stat(root).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new Error("The files folder must be an existing directory.");
  }
  if (!safeOwnership(info)) {
    throw new Error(
      "The files folder must belong to the user Oculus runs as and be writable by it alone.",
    );
  }

  /** The temporary path of each received file, never handed out. */
  const temporary = new WeakMap<ReceivedFile, string>();
  /** Bytes each received file holds against its organization's total until discarded. */
  const reserved = new WeakMap<ReceivedFile, number>();
  /** Bytes of each organization's uploads in flight or waiting to be attached, in this process. */
  const inFlight = new Map<string, number>();

  const addInFlight = (organizationId: string, bytes: number): number => {
    const now = (inFlight.get(organizationId) ?? 0) + bytes;
    if (now <= 0) inFlight.delete(organizationId);
    else inFlight.set(organizationId, now);
    return now;
  };

  function organizationDir(organizationId: OrganizationId): string {
    if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
    return join(root, organizationId);
  }

  function pathFor(organizationId: OrganizationId, sha256: string): string {
    if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
    return join(organizationDir(organizationId), "sha256", sha256.slice(0, 2), sha256);
  }

  /** The sizes thumbnails are cached for: a fixed word each, never a client's text. */
  const THUMBNAIL_SIZE = /^[a-z]{1,16}$/;

  function thumbnailParts(organizationId: OrganizationId, sha256: string, size: string): string[] {
    organizationDir(organizationId);
    if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
    if (!THUMBNAIL_SIZE.test(size)) throw new TypeError("Not a thumbnail size.");
    return [organizationId, "thumbnails", size, sha256.slice(0, 2)];
  }

  /**
   * Checks each folder from the root down without making any: a real
   * directory, never a link, ours and writable by us alone. False when one
   * is missing or isn't.
   */
  async function existingFolder(...parts: string[]): Promise<string | undefined> {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      const folder = await lstat(path).catch(() => undefined);
      if (folder === undefined || !folder.isDirectory() || !safeOwnership(folder)) {
        return undefined;
      }
    }
    return path;
  }

  /** A regular file of ours with one link (and `size` bytes, when given), never a link. */
  async function plainFile(path: string, size?: number): Promise<boolean> {
    const info = await lstat(path).catch(() => undefined);
    return (
      info !== undefined &&
      info.isFile() &&
      info.nlink === 1 &&
      safeOwnership(info) &&
      (size === undefined || info.size === size)
    );
  }

  /** The stored copy's path once it has been checked, else `undefined`. */
  async function checkedContent(
    organizationId: OrganizationId,
    sha256: string,
    size: number,
  ): Promise<string | undefined> {
    const target = pathFor(organizationId, sha256);
    const folder = await existingFolder(organizationId, "sha256", sha256.slice(0, 2));
    if (folder === undefined) return undefined;
    return (await plainFile(target, size)) ? target : undefined;
  }

  /** Reads at most `maxBytes` from the start of a file, opened without following a link. */
  async function readStart(path: string, maxBytes: number): Promise<Uint8Array> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Not a plain file.");
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  /** The largest cached thumbnail read back (a sanity bound; they are far smaller). */
  const MAX_THUMBNAIL_BYTES = 4 * MIB;

  /**
   * Makes (if needed) and checks each folder from the root down: a real
   * directory, never a link, ours and writable by us alone.
   */
  async function safeFolder(...parts: string[]): Promise<string> {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      });
      const folder = await lstat(path);
      if (!folder.isDirectory() || !safeOwnership(folder)) {
        throw new Error("A folder in the file store is not a plain folder of Oculus's own.");
      }
    }
    return path;
  }

  /**
   * Bytes uploads in this process are still expected to write: a declared
   * length less what is written so far. Held against the floor, so many
   * uploads starting at once can't each see the same free space.
   */
  let pendingSpace = 0;
  /** Temporary files this process is writing (never swept). */
  const active = new Set<string>();
  let boundTo: string | undefined;

  async function lowOnSpace(extra: number): Promise<boolean> {
    if (minFree === 0) return false;
    const { free, total } = await freeSpace(root);
    const floor = minFree ?? Math.min(DEFAULT_MIN_FREE_BYTES, total * DEFAULT_MIN_FREE_FRACTION);
    return free - pendingSpace - extra < floor;
  }

  /** Writes the marker through a temporary file, fsynced, then linked or renamed into place. */
  async function writeMarkerFile(
    marker: Required<StoreMarker>,
    how: "link" | "rename",
  ): Promise<void> {
    if (
      !MARKER_ID.test(marker.storeId) ||
      !MARKER_DATABASE.test(marker.database) ||
      !MARKER_ID.test(marker.epoch)
    ) {
      throw new TypeError("Not a marker.");
    }
    const temp = join(root, `${STORE_MARKER}.${randomBytes(8).toString("hex")}`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await writeAll(
        handle,
        Buffer.from(`${marker.storeId}\n${marker.database}\n${marker.epoch}\n`, "utf8"),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (how === "link") await link(temp, join(root, STORE_MARKER));
      else await rename(temp, join(root, STORE_MARKER));
    } finally {
      await rm(temp, { force: true });
    }
    await syncDirectory(root);
  }

  /** "Now" by the file system's own clock: the time of a file written just now in `folder`. */
  async function fileSystemNow(folder: string): Promise<number> {
    const probe = join(folder, `.now-${randomBytes(8).toString("hex")}`);
    await writeFile(probe, "", { mode: 0o600, flag: "wx" });
    try {
      return (await lstat(probe)).mtimeMs;
    } finally {
      await rm(probe, { force: true });
    }
  }

  const store: FileStore = {
    maxFileBytes,
    maxOrganizationBytes,
    pathFor,
    lowOnSpace,
    boundTo: () => boundTo,

    bind(storeId) {
      if (!MARKER_ID.test(storeId)) {
        throw new TypeError("Not an install ID.");
      }
      boundTo = storeId;
    },

    async readMarker() {
      const path = join(root, STORE_MARKER);
      const info = await lstat(path).catch(() => undefined);
      if (info === undefined) return undefined;
      if (!info.isFile() || info.size > 300) {
        throw new Error("The files folder's marker isn't a marker file.");
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const [storeId = "", database = "", epoch = ""] = text.split("\n").map((line) => line.trim());
      if (
        !MARKER_ID.test(storeId) ||
        (database !== "" && !MARKER_DATABASE.test(database)) ||
        (epoch !== "" && !MARKER_ID.test(epoch))
      ) {
        throw new Error("The files folder's marker can't be read.");
      }
      return Object.freeze({
        storeId,
        ...(database === "" ? {} : { database }),
        ...(epoch === "" ? {} : { epoch }),
      });
    },

    async writeMarker(marker) {
      // Never over an existing marker: link fails if one appeared meanwhile.
      await writeMarkerFile(marker, "link");
    },

    async replaceMarker(marker) {
      await writeMarkerFile(marker, "rename");
    },

    async markerAge() {
      const info = await lstat(join(root, STORE_MARKER)).catch(() => undefined);
      if (info === undefined) return undefined;
      return Math.max(0, (await fileSystemNow(root)) - info.mtimeMs);
    },

    async claimServer(key) {
      if (!/^[\x21-\x7e]{1,300}$/.test(key)) throw new TypeError("Not a server key.");
      const folder = await safeFolder(SERVERS_FOLDER);
      const host = hostname()
        .replace(/[^A-Za-z0-9.-]/g, "_")
        .slice(0, 100);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const match = /^(.+)-([0-9]{1,10})$/.exec(entry.name);
        if (!entry.isFile() || match?.[1] !== host) continue;
        const pid = Number(match[2]);
        const path = join(folder, entry.name);
        let alive = pid !== process.pid;
        if (alive) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            alive = (error as { code?: unknown }).code === "EPERM";
          }
        }
        if (!alive) {
          // A server that has gone (or this process, starting again).
          await rm(path, { force: true });
          continue;
        }
        const theirs = (await readFile(path, "utf8").catch(() => "")).trim();
        if (theirs !== key) return { ok: false };
      }
      const mine = join(folder, `${host}-${String(process.pid)}`);
      await writeFile(mine, `${key}\n`, { mode: 0o600 });
      const release = (): void => {
        try {
          rmSync(mine, { force: true });
        } catch {
          // Gone already.
        }
      };
      process.once("exit", release);
      return {
        ok: true,
        release: () => {
          process.removeListener("exit", release);
          release();
        },
      };
    },

    async markerInProgress() {
      const entries = await readdir(root);
      return entries.some((name) => name.startsWith(`${STORE_MARKER}.`));
    },

    async isEmpty() {
      return (await readdir(root)).filter((name) => name !== SERVERS_FOLDER).length === 0;
    },

    async openContent(organizationId, sha256, size) {
      const path = await checkedContent(organizationId, sha256, size);
      if (path === undefined) return undefined;
      // Opened only when the reply goes out (file-replies.ts); O_NOFOLLOW
      // again at that moment, and the reply's exact length checks the rest.
      return () => {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        return createReadStream("", { fd, autoClose: true });
      };
    },

    async readContent(organizationId, sha256, size, maxBytes) {
      const path = await checkedContent(organizationId, sha256, size);
      if (path === undefined) return undefined;
      return readStart(path, maxBytes).catch(() => undefined);
    },

    async readThumbnail(organizationId, sha256, size) {
      const parts = thumbnailParts(organizationId, sha256, size);
      const folder = await existingFolder(...parts);
      if (folder === undefined) return undefined;
      const jpeg = join(folder, `${sha256}.v1.jpg`);
      if (await plainFile(jpeg)) {
        const bytes = await readStart(jpeg, MAX_THUMBNAIL_BYTES + 1).catch(() => undefined);
        // A JPEG of a sane size, or nothing (it is made again).
        if (
          bytes !== undefined &&
          bytes.length >= 4 &&
          bytes.length <= MAX_THUMBNAIL_BYTES &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8
        ) {
          return bytes;
        }
        return undefined;
      }
      if (await plainFile(join(folder, `${sha256}.v1.none`), 0)) return "none";
      const timeout = join(folder, `${sha256}.v1.timeout`);
      if (await plainFile(timeout, 0)) {
        const info = await lstat(timeout);
        return { timedOutAt: info.mtimeMs };
      }
      return undefined;
    },

    async writeThumbnail(organizationId, sha256, size, jpeg) {
      const parts = thumbnailParts(organizationId, sha256, size);
      const incoming = await safeFolder(organizationId, "incoming");
      const folder = await safeFolder(...parts);
      const temporaryPath = join(incoming, `${randomBytes(16).toString("hex")}.part`);
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let placed = false;
      try {
        try {
          if (typeof jpeg !== "string") await writeAll(handle, jpeg);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A rename replaces whatever is at the name (a planted link
        // included) in one step. Nothing else is deleted here: only the
        // sweep deletes (trash, then emptyTrash); a JPEG beside a ".none" wins.
        const name =
          jpeg === "none" || jpeg === "timeout" ? `${sha256}.v1.${jpeg}` : `${sha256}.v1.jpg`;
        await rename(temporaryPath, join(folder, name));
        placed = true;
      } finally {
        if (!placed) await rm(temporaryPath, { force: true });
      }
    },

    async receive(organizationId, chunks, options = {}): Promise<ReceiveResult> {
      const { signal } = options;
      const used = options.usedBytes ?? 0;
      organizationDir(organizationId);
      const incoming = await safeFolder(organizationId, "incoming");
      const declared = options.declaredBytes ?? 0;
      if (!Number.isSafeInteger(declared) || declared < 0) throw new TypeError("Not a length.");
      // Reserved before the free space is read, so uploads starting at once
      // each see the others' declared lengths (and its own).
      let reservedSpace = declared;
      pendingSpace += reservedSpace;
      const unreserve = (bytes: number): void => {
        const release = Math.min(reservedSpace, bytes);
        reservedSpace -= release;
        pendingSpace -= release;
      };
      if (await lowOnSpace(0)) {
        unreserve(reservedSpace);
        return { ok: false, code: "disk_full" };
      }
      const path = join(incoming, `${randomBytes(16).toString("hex")}.part`);
      active.add(path);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        unreserve(reservedSpace);
        active.delete(path);
        throw error;
      }
      const hash = createHash("sha256");
      const head = new Uint8Array(SNIFF_BYTES);
      let headLength = 0;
      let size = 0;
      /** What this upload has added to the organization's in-flight bytes. */
      let counted = 0;
      let nextSpaceCheck = FREE_SPACE_EVERY;
      let refused: ReceiveRefusal | undefined;
      let closed = false;
      let kept = false;
      try {
        for await (const chunk of chunks) {
          signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new TypeError("A body chunk is bytes.");
          size += chunk.byteLength;
          if (size > maxFileBytes) {
            refused = "file_too_large";
            break;
          }
          // The organization's total, with every upload of it in flight here.
          counted += chunk.byteLength;
          if (used + addInFlight(organizationId, chunk.byteLength) > maxOrganizationBytes) {
            refused = "quota_exceeded";
            break;
          }
          if (size >= nextSpaceCheck) {
            nextSpaceCheck += FREE_SPACE_EVERY;
            // What is still reserved counts already; a chunk beyond it, too.
            if (await lowOnSpace(Math.max(0, chunk.byteLength - reservedSpace))) {
              refused = "disk_full";
              break;
            }
          }
          hash.update(chunk);
          if (headLength < SNIFF_BYTES) {
            const take = chunk.subarray(0, SNIFF_BYTES - headLength);
            head.set(take, headLength);
            headLength += take.byteLength;
          }
          await writeAll(handle, chunk);
          // Written: no longer pending, it is on the disk now.
          unreserve(chunk.byteLength);
        }
        signal?.throwIfAborted();
        if (refused === undefined && size === 0) refused = "empty_file";
        if (refused === undefined) await handle.sync();
        closed = true;
        await handle.close();
        if (refused !== undefined) return { ok: false, code: refused };
        const sha256 = hash.digest("hex");
        // The checksum check: what is on disk is what was received.
        if ((await hashFile(path)) !== sha256) {
          throw new Error("The stored copy doesn't match what was received.");
        }
        const file: ReceivedFile = Object.freeze({
          organizationId,
          sha256,
          size,
          // A copy (typed arrays can't be frozen); the service only reads it.
          head: head.slice(0, headLength),
        });
        temporary.set(file, path);
        reserved.set(file, counted);
        kept = true;
        return { ok: true, file };
      } finally {
        unreserve(reservedSpace);
        if (!closed) await handle.close().catch(() => undefined);
        if (!kept) {
          active.delete(path);
          // What this upload counted against the total, and its partial file.
          addInFlight(organizationId, -counted);
          await rm(path, { force: true });
        }
      }
    },

    async place(file) {
      const path = temporary.get(file);
      if (path === undefined) throw new Error("Not a file this store received.");
      const target = pathFor(file.organizationId, file.sha256);
      const folder = await safeFolder(file.organizationId, "sha256", file.sha256.slice(0, 2));
      const incoming = join(organizationDir(file.organizationId), "incoming");
      const settle = async (): Promise<void> => {
        // The temporary name goes before the lock is released, so a stored
        // copy has exactly one link (the "already stored" check needs it).
        await rm(path, { force: true });
        temporary.delete(file);
        active.delete(path);
        await syncDirectory(folder);
        await syncDirectory(incoming);
      };
      try {
        await link(path, target);
        await settle();
        return "stored";
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== "EEXIST" && !NO_LINKS.has(String(code))) throw error;
        // A file system without hard links (some network and removable
        // ones): the caller holds the organization's file lock, so nothing
        // else places this content meanwhile; rename it into place if it is
        // missing.
        if (code !== "EEXIST" && (await lstat(target).catch(() => undefined)) === undefined) {
          await rename(path, target);
          await settle();
          return "stored";
        }
      }
      // Already there: keep it only if it is surely the same content.
      const existing = await lstat(target);
      if (
        existing.isFile() &&
        existing.nlink === 1 &&
        safeOwnership(existing) &&
        existing.size === file.size &&
        (await hashFile(target)) === file.sha256
      ) {
        await settle();
        return "already_stored";
      }
      // A damaged, foreign, linked or shared copy: replaced in one step.
      await rename(path, target);
      await settle();
      return "stored";
    },

    async discard(file) {
      const share = reserved.get(file);
      if (share !== undefined) {
        reserved.delete(file);
        addInFlight(file.organizationId, -share);
      }
      const path = temporary.get(file);
      if (path === undefined) return;
      temporary.delete(file);
      await rm(path, { force: true });
      active.delete(path);
    },

    async organizations() {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && isOrganizationId(e.name))
        .map((e) => e.name as OrganizationId)
        .sort();
    },

    async contents(organizationId) {
      return (await store.listContents(organizationId)).hashes;
    },

    async listContents(organizationId) {
      const base = join(organizationDir(organizationId), "sha256");
      const top = await lstat(base).catch(() => undefined);
      if (top?.isDirectory() !== true) return { hashes: [], skipped: 0 };
      const hashes: string[] = [];
      let skipped = 0;
      for (const prefix of await readdir(base, { withFileTypes: true })) {
        if (!/^[0-9a-f]{2}$/.test(prefix.name)) continue;
        if (!prefix.isDirectory()) {
          skipped++;
          continue;
        }
        for (const entry of await readdir(join(base, prefix.name), { withFileTypes: true })) {
          if (!isSha256Hex(entry.name) || !entry.name.startsWith(prefix.name)) continue;
          // A folder, link or anything else at a content path: left alone.
          if (entry.isFile()) hashes.push(entry.name);
          else skipped++;
        }
      }
      return { hashes: hashes.sort(), skipped };
    },

    async trash(organizationId, sha256) {
      const target = pathFor(organizationId, sha256);
      const info = await lstat(target).catch(() => undefined);
      if (info?.isFile() !== true) return;
      const bin = await safeFolder(organizationId, "trash");
      await rename(target, join(bin, `${sha256}.${randomBytes(8).toString("hex")}`));
    },

    async trashThumbnails(organizationId, sha256) {
      if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
      const thumbnails = await existingFolder(organizationId, "thumbnails");
      if (thumbnails === undefined) return;
      for (const size of await readdir(thumbnails, { withFileTypes: true })) {
        if (!size.isDirectory() || !THUMBNAIL_SIZE.test(size.name)) continue;
        const folder = await existingFolder(
          organizationId,
          "thumbnails",
          size.name,
          sha256.slice(0, 2),
        );
        if (folder === undefined) continue;
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(`${sha256}.`)) continue;
          const bin = await safeFolder(organizationId, "trash");
          await rename(
            join(folder, entry.name),
            join(bin, `${sha256}.${randomBytes(8).toString("hex")}`),
          );
        }
      }
    },

    async emptyTrash(organizationId) {
      const bin = join(organizationDir(organizationId), "trash");
      const folder = await lstat(bin).catch(() => undefined);
      if (folder?.isDirectory() !== true) return 0;
      let removed = 0;
      for (const entry of await readdir(bin, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        await rm(join(bin, entry.name), { force: true });
        removed++;
      }
      await syncDirectory(bin).catch(() => undefined);
      await syncDirectory(join(organizationDir(organizationId), "sha256")).catch(() => undefined);
      return removed;
    },

    async staleIncoming(maxAgeMs, organizations) {
      let removed = 0;
      const only = organizations === undefined ? undefined : new Set(organizations);
      for (const organizationId of await store.organizations()) {
        if (only !== undefined && !only.has(organizationId)) continue;
        const incoming = join(organizationDir(organizationId), "incoming");
        const folder = await lstat(incoming).catch(() => undefined);
        if (folder?.isDirectory() !== true || !safeOwnership(folder)) continue;
        // "Now" by the file system's own clock (a file written just now), so
        // a skewed or network clock can't make fresh uploads look old.
        const probe = join(incoming, `.now-${randomBytes(8).toString("hex")}`);
        await writeFile(probe, "", { mode: 0o600, flag: "wx" });
        const now = (await lstat(probe)).mtimeMs;
        await rm(probe, { force: true });
        for (const entry of await readdir(incoming, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
          const path = join(incoming, entry.name);
          // Never one this process is still writing or holding for an attach.
          if (active.has(path)) continue;
          const info = await lstat(path).catch(() => undefined);
          if (info === undefined || now - info.mtimeMs < maxAgeMs) continue;
          await rm(path, { force: true });
          removed++;
        }
      }
      return removed;
    },
  };
  return Object.freeze(store);
}
