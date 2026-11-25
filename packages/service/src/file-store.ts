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
 * The sweep (the service's `sweepFiles`) uses `staleIncoming` (temporary
 * files older than an upload may run) and `contents`/`removeContent` (copies
 * no row names, under the organization's file lock).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, openSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { SNIFF_BYTES, isOrganizationId, isSha256Hex, type OrganizationId } from "@oculus/core";

/** Bytes in a mebibyte. */
const MIB = 1024 * 1024;
/** The default largest file: 500 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 500 * MIB;
/** The default total per organization: 20 GiB. */
export const DEFAULT_MAX_ORGANIZATION_BYTES = 20 * 1024 * MIB;
/** No cap may be set above this: 1 TiB (0022's column check). */
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

export interface ReceiveOptions {
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
  ): Promise<Uint8Array | "none" | undefined>;
  /** Caches a thumbnail (or `"none"`): written to a temporary file, then renamed into place. */
  writeThumbnail(
    organizationId: OrganizationId,
    sha256: string,
    size: string,
    jpeg: Uint8Array | "none",
  ): Promise<void>;
  /** The contents an organization has cached thumbnails of (their hashes), for the sweep. */
  thumbnailContents(organizationId: OrganizationId): Promise<readonly string[]>;
  /** The organizations with a folder here. */
  organizations(): Promise<readonly OrganizationId[]>;
  /** The contents stored for an organization (their hashes). */
  contents(organizationId: OrganizationId): Promise<readonly string[]>;
  /**
   * Deletes a stored copy and its cached thumbnails (call under the
   * organization's file lock, once no row names it).
   */
  removeContent(organizationId: OrganizationId, sha256: string): Promise<void>;
  /** Deletes temporary files older than `maxAgeMs`; returns how many. */
  staleIncoming(maxAgeMs: number): Promise<number>;
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

  async function lowOnSpace(extra: number): Promise<boolean> {
    if (minFree === 0) return false;
    const { free, total } = await freeSpace(root);
    const floor = minFree ?? Math.min(DEFAULT_MIN_FREE_BYTES, total * DEFAULT_MIN_FREE_FRACTION);
    return free - extra < floor;
  }

  const store: FileStore = {
    maxFileBytes,
    maxOrganizationBytes,
    pathFor,
    lowOnSpace,

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
      return (await plainFile(join(folder, `${sha256}.v1.none`), 0)) ? "none" : undefined;
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
          if (jpeg !== "none") await writeAll(handle, jpeg);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A rename replaces whatever is at the name (a planted link
        // included) in one step. Nothing else is deleted here: only the
        // sweep deletes (removeContent); a JPEG beside a ".none" wins.
        const name = jpeg === "none" ? `${sha256}.v1.none` : `${sha256}.v1.jpg`;
        await rename(temporaryPath, join(folder, name));
        placed = true;
      } finally {
        if (!placed) await rm(temporaryPath, { force: true });
      }
    },

    async thumbnailContents(organizationId) {
      const base = join(organizationDir(organizationId), "thumbnails");
      const top = await lstat(base).catch(() => undefined);
      if (top?.isDirectory() !== true) return [];
      const out = new Set<string>();
      for (const size of await readdir(base, { withFileTypes: true })) {
        if (!size.isDirectory() || !THUMBNAIL_SIZE.test(size.name)) continue;
        for (const prefix of await readdir(join(base, size.name), { withFileTypes: true })) {
          if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
          const folder = join(base, size.name, prefix.name);
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const sha256 = entry.name.slice(0, 64);
            if (isSha256Hex(sha256) && sha256.startsWith(prefix.name)) out.add(sha256);
          }
        }
      }
      return [...out].sort();
    },

    async receive(organizationId, chunks, options = {}): Promise<ReceiveResult> {
      const { signal } = options;
      const used = options.usedBytes ?? 0;
      organizationDir(organizationId);
      const incoming = await safeFolder(organizationId, "incoming");
      if (await lowOnSpace(0)) return { ok: false, code: "disk_full" };
      const path = join(incoming, `${randomBytes(16).toString("hex")}.part`);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
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
            if (await lowOnSpace(chunk.byteLength)) {
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
        if (!closed) await handle.close().catch(() => undefined);
        if (!kept) {
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
    },

    async organizations() {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && isOrganizationId(e.name))
        .map((e) => e.name as OrganizationId)
        .sort();
    },

    async contents(organizationId) {
      const base = join(organizationDir(organizationId), "sha256");
      const top = await lstat(base).catch(() => undefined);
      if (top?.isDirectory() !== true) return [];
      const out: string[] = [];
      for (const prefix of await readdir(base, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
        for (const entry of await readdir(join(base, prefix.name), { withFileTypes: true })) {
          if (isSha256Hex(entry.name) && entry.name.startsWith(prefix.name)) out.push(entry.name);
        }
      }
      return out.sort();
    },

    async removeContent(organizationId, sha256) {
      const target = pathFor(organizationId, sha256);
      await rm(target, { force: true });
      await syncDirectory(
        join(organizationDir(organizationId), "sha256", sha256.slice(0, 2)),
      ).catch(() => undefined);
      // Its cached thumbnails, every size and every version.
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
        const entries = await readdir(folder).catch(() => [] as string[]);
        for (const entry of entries) {
          if (entry.startsWith(`${sha256}.`)) await rm(join(folder, entry), { force: true });
        }
      }
    },

    async staleIncoming(maxAgeMs) {
      let removed = 0;
      const cutoff = Date.now() - maxAgeMs;
      for (const organizationId of await store.organizations()) {
        const incoming = join(organizationDir(organizationId), "incoming");
        const folder = await lstat(incoming).catch(() => undefined);
        if (folder?.isDirectory() !== true) continue;
        for (const entry of await readdir(incoming, { withFileTypes: true })) {
          if (!entry.name.endsWith(".part")) continue;
          const path = join(incoming, entry.name);
          const info = await lstat(path).catch(() => undefined);
          if (info === undefined || info.mtimeMs > cutoff) continue;
          await rm(path, { force: true });
          removed++;
        }
      }
      return removed;
    },
  };
  return Object.freeze(store);
}
