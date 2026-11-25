/**
 * The file store on local disk (M-002, D-086): where uploaded bytes go.
 *
 * Layout under the configured folder (`OCULUS_FILES_DIR`, an absolute path
 * to an existing directory):
 *
 *     <dir>/<organization id>/sha256/<first two hex digits>/<sha256>
 *     <dir>/<organization id>/incoming/<random>.part
 *
 * Every path is built from an organization ID (checked as a UUID) and a
 * SHA-256 this module computed itself, or a random name; **no part of a
 * path ever comes from a client** (a file's original name is metadata in
 * the database only). One copy per organization and content: two assets
 * holding the same bytes share it, and organizations never share one
 * (D-019).
 *
 * `receive` streams a body into a new temporary file (`O_EXCL`,
 * `O_NOFOLLOW`, mode 0600) while hashing and counting it, stops as soon as
 * the per-file cap is passed (the partial file is removed before it
 * returns), fsyncs it, then reads it back and checks the SHA-256 again. The
 * result is an opaque handle; its temporary path stays in this module.
 * `place` (called by the service inside the attach transaction, under the
 * organization's file lock) hard-links the temporary file to its content
 * path (or renames it there, on a file system without hard links) and
 * fsyncs the directory; if the content is already there it is
 * checked (a regular file of the same size and SHA-256) and kept, or
 * replaced atomically by rename when it isn't. Nothing is ever written in
 * place, and nothing here deletes a stored copy. `discard` removes the
 * temporary file.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SNIFF_BYTES, isOrganizationId, isSha256Hex, type OrganizationId } from "@oculus/core";

/** Bytes in a mebibyte. */
const MIB = 1024 * 1024;
/** The default largest file: 500 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 500 * MIB;
/** The default total per organization: 20 GiB. */
export const DEFAULT_MAX_ORGANIZATION_BYTES = 20 * 1024 * MIB;
/** No cap may be set above this: 1 TiB (0022's column check). */
export const MAX_CAP_BYTES = 1024 * 1024 * MIB;

export interface FileStoreOptions {
  /** An absolute path to an existing, writable directory. */
  readonly dir: string;
  /** The largest file, in bytes (default 500 MiB). */
  readonly maxFileBytes?: number;
  /** The most an organization may store, each content once (default 20 GiB). */
  readonly maxOrganizationBytes?: number;
}

/** A received file: what the service needs, and nothing that names a path. */
export interface ReceivedFile {
  readonly organizationId: OrganizationId;
  readonly sha256: string;
  readonly size: number;
  /** The first bytes (at most `SNIFF_BYTES`), for sniffing the media type. */
  readonly head: Uint8Array;
}

export type ReceiveResult =
  | { readonly ok: true; readonly file: ReceivedFile }
  | { readonly ok: false; readonly code: "file_too_large" | "empty_file" };

export interface FileStore {
  readonly maxFileBytes: number;
  readonly maxOrganizationBytes: number;
  /**
   * Streams `chunks` into a temporary file. Refuses (removing what was
   * written) a body over `maxFileBytes` as soon as it passes it, and an
   * empty one. Throws if the stream fails (the client went away) or
   * `signal` fires, also after removing the partial file.
   */
  receive(
    organizationId: OrganizationId,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ReceiveResult>;
  /** Puts the received bytes at their content path (see the module header). */
  place(file: ReceivedFile): Promise<"stored" | "already_stored">;
  /** Removes the temporary file; safe to call more than once. */
  discard(file: ReceivedFile): Promise<void>;
  /** Where the content is stored (for reading in M-003 and in tests). */
  pathFor(organizationId: OrganizationId, sha256: string): string;
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
  if (process.platform === "win32") return;
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

/**
 * Opens the store. Refuses a relative path and a path that isn't an
 * existing, writable directory, so a misconfigured server never starts.
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
  const info = await stat(root).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new Error("The files folder must be an existing directory.");
  }
  await access(root, constants.W_OK | constants.X_OK).catch(() => {
    throw new Error("The files folder must be writable.");
  });

  /** The temporary path of each received file, never handed out. */
  const temporary = new WeakMap<ReceivedFile, string>();

  function organizationDir(organizationId: OrganizationId): string {
    if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
    return join(root, organizationId);
  }

  function pathFor(organizationId: OrganizationId, sha256: string): string {
    if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
    return join(organizationDir(organizationId), "sha256", sha256.slice(0, 2), sha256);
  }

  const store: FileStore = {
    maxFileBytes,
    maxOrganizationBytes,
    pathFor,

    async receive(organizationId, chunks, signal): Promise<ReceiveResult> {
      const incoming = join(organizationDir(organizationId), "incoming");
      await mkdir(incoming, { recursive: true, mode: 0o700 });
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
      let refused: "file_too_large" | "empty_file" | undefined;
      let closed = false;
      try {
        for await (const chunk of chunks) {
          signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new TypeError("A body chunk is bytes.");
          size += chunk.byteLength;
          if (size > maxFileBytes) {
            refused = "file_too_large";
            break;
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
        if (refused !== undefined) {
          await rm(path, { force: true });
          return { ok: false, code: refused };
        }
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
        return { ok: true, file };
      } catch (error) {
        if (!closed) await handle.close().catch(() => undefined);
        await rm(path, { force: true });
        throw error;
      }
    },

    async place(file) {
      const path = temporary.get(file);
      if (path === undefined) throw new Error("Not a file this store received.");
      const target = pathFor(file.organizationId, file.sha256);
      const folder = join(organizationDir(file.organizationId), "sha256", file.sha256.slice(0, 2));
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try {
        await link(path, target);
        await syncDirectory(folder);
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
          await syncDirectory(folder);
          return "stored";
        }
      }
      // Already there: keep it only if it is the same content.
      const existing = await lstat(target);
      if (
        existing.isFile() &&
        existing.size === file.size &&
        (await hashFile(target)) === file.sha256
      ) {
        return "already_stored";
      }
      // A damaged or foreign copy: replaced in one step.
      await rename(path, target);
      await syncDirectory(folder);
      return "stored";
    },

    async discard(file) {
      const path = temporary.get(file);
      if (path === undefined) return;
      temporary.delete(file);
      await rm(path, { force: true });
    },
  };
  return Object.freeze(store);
}
