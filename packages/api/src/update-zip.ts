/**
 * A small, strict ZIP reader and writer for Oculus update packages (T-060,
 * D-092). Only Oculus's own release command writes these packages, so the
 * reader accepts exactly what the writer makes and refuses everything else:
 *
 * - The end-of-central-directory record must end the file (no archive
 *   comment, nothing appended), on one disk, with no ZIP64 values.
 * - Entries are regular files only: no directories, symbolic links or other
 *   types in the Unix mode, no encryption, no data descriptors, and only
 *   "stored" (0) or "deflate" (8).
 * - Names are UTF-8-flagged printable ASCII, relative, with `/` between
 *   segments; no `.`/`..` or empty segments, no backslash, colon or control
 *   character. Two names that differ only in letter case, and a file whose
 *   name is a folder of another (`a` and `a/b`), are refused, so unpacking
 *   on a case-insensitive disk can't overwrite one file with another.
 * - Each local header must agree with its central entry, and the entries
 *   must lie one after another from the first byte to the directory, as
 *   the writer puts them: no overlaps (the overlapping-entries zip bomb)
 *   and no bytes hidden before, between or after them.
 * - Limits: entry count, central directory size, each entry's size and the
 *   total unpacked size. Inflating stops at the size the entry declares,
 *   and the CRC-32 is checked.
 *
 * The reader works on an open file and reads one entry at a time, so a
 * package never has to fit in memory whole.
 */
import { open, type FileHandle } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { WINDOWS_DEVICE_NAME } from "./file-replies.js";

export interface ZipLimits {
  /** Bytes in the whole file. */
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  /** Bytes of one unpacked entry. */
  readonly maxEntryBytes: number;
  /** Bytes of all unpacked entries together. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxFileBytes: 256 * 1024 * 1024,
  maxEntries: 60_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 768 * 1024 * 1024,
});

/** Why a ZIP file was refused; `message` names no file content. */
export class ZipError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Where the entry's compressed bytes start in the file. */
  readonly dataOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const UTF8_FLAG = 0x0800;
const MAX_NAME_LENGTH = 400;
const MAX_CENTRAL_BYTES = 32 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
/** "Made by" Unix, ZIP version 2.0. */
const MADE_BY_UNIX = (3 << 8) | 20;
const VERSION_NEEDED = 20;

/** Printable ASCII except `\` and `:`; checked per segment below. */
const NAME_CHARACTERS = /^[\x20-\x7e]+$/;

/** The problem with an entry name, or `undefined` when it is safe to unpack. */
export function zipNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return "length";
  if (!NAME_CHARACTERS.test(name)) return "characters";
  if (name.includes("\\") || name.includes(":")) return "characters";
  if (name.startsWith("/") || name.endsWith("/")) return "not_relative_file";
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "segment";
    if (segment.startsWith(" ") || segment.endsWith(" ") || segment.endsWith(".")) {
      return "segment";
    }
    // CON, nul.txt, aux.js, COM1 … can't be written on Windows (S-050).
    if (WINDOWS_DEVICE_NAME.test(segment)) return "device_name";
  }
  return undefined;
}

/**
 * Refuses names that collide on a case-insensitive disk and files that are
 * also another file's folder. Throws `ZipError`.
 */
export function checkNameSet(names: readonly string[]): void {
  const files = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (files.has(key)) throw new ZipError("duplicate_name", "Two entries have the same name.");
    files.add(key);
  }
  for (const key of files) {
    let i = key.indexOf("/");
    while (i !== -1) {
      if (files.has(key.slice(0, i))) {
        throw new ZipError("name_conflict", "An entry's name is the folder of another entry.");
      }
      i = key.indexOf("/", i + 1);
    }
  }
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError("truncated", "The file ends too early.");
    done += bytesRead;
  }
  return buffer;
}

/** An open package: its entries in file order, and a way to read each one. */
export class ZipReader {
  private constructor(
    private readonly file: FileHandle,
    readonly entries: readonly ZipEntry[],
    private readonly limits: ZipLimits,
  ) {}

  /** Opens and checks the whole directory of `path`; throws `ZipError`. */
  static async open(path: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipReader> {
    const file = await open(path, "r");
    try {
      const entries = await readDirectory(file, limits);
      return new ZipReader(file, entries, limits);
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** The unpacked bytes of one entry, checked against its size and CRC-32. */
  async read(entry: ZipEntry): Promise<Buffer> {
    const packed = await readAt(this.file, entry.dataOffset, entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = packed;
    } else {
      try {
        data = inflateRawSync(packed, {
          maxOutputLength: Math.max(1, Math.min(entry.size, this.limits.maxEntryBytes)),
          finishFlush: 0,
        });
      } catch {
        throw new ZipError("bad_data", "An entry's compressed data can't be read.");
      }
    }
    if (data.length !== entry.size) {
      throw new ZipError("bad_size", "An entry's size isn't what the directory says.");
    }
    if (crc32(data) !== entry.crc) {
      throw new ZipError("bad_crc", "An entry's checksum doesn't match.");
    }
    return data;
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}

async function readDirectory(file: FileHandle, limits: ZipLimits): Promise<ZipEntry[]> {
  const { size: fileSize } = await file.stat();
  if (fileSize > limits.maxFileBytes) throw new ZipError("too_large", "The file is too large.");
  if (fileSize < EOCD_SIZE) throw new ZipError("not_zip", "This isn't an Oculus update package.");
  const end = await readAt(file, fileSize - EOCD_SIZE, EOCD_SIZE);
  if (end.readUInt32LE(0) !== EOCD_SIGNATURE) {
    throw new ZipError("not_zip", "This isn't an Oculus update package.");
  }
  const disk = end.readUInt16LE(4);
  const cdDisk = end.readUInt16LE(6);
  const onDisk = end.readUInt16LE(8);
  const count = end.readUInt16LE(10);
  const cdSize = end.readUInt32LE(12);
  const cdOffset = end.readUInt32LE(16);
  const commentLength = end.readUInt16LE(20);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count || commentLength !== 0) {
    throw new ZipError("unsupported", "Split archives and archive comments aren't accepted.");
  }
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("unsupported", "ZIP64 archives aren't accepted.");
  }
  if (count === 0) throw new ZipError("empty", "The package is empty.");
  if (count > limits.maxEntries) throw new ZipError("too_many_entries", "Too many entries.");
  if (cdSize > MAX_CENTRAL_BYTES || cdOffset + cdSize !== fileSize - EOCD_SIZE) {
    throw new ZipError("bad_directory", "The archive's directory is out of place.");
  }
  const central = await readAt(file, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_SIZE > central.length || central.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new ZipError("bad_directory", "The archive's directory is damaged.");
    }
    const madeBy = central.readUInt16LE(p + 4);
    const flags = central.readUInt16LE(p + 8);
    const method = central.readUInt16LE(p + 10);
    const crc = central.readUInt32LE(p + 16);
    const compressedSize = central.readUInt32LE(p + 20);
    const size = central.readUInt32LE(p + 24);
    const nameLength = central.readUInt16LE(p + 28);
    const extraLength = central.readUInt16LE(p + 30);
    const entryComment = central.readUInt16LE(p + 32);
    const entryDisk = central.readUInt16LE(p + 34);
    const external = central.readUInt32LE(p + 38);
    const localOffset = central.readUInt32LE(p + 42);
    const next = p + CENTRAL_SIZE + nameLength + extraLength + entryComment;
    if (next > central.length) {
      throw new ZipError("bad_directory", "The archive's directory is damaged.");
    }
    if ((flags & ~UTF8_FLAG) !== 0 || (flags & UTF8_FLAG) === 0) {
      throw new ZipError("unsupported", "Encrypted entries and data descriptors aren't accepted.");
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError("unsupported", "Only stored and deflated entries are accepted.");
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("unsupported", "ZIP64 entries aren't accepted.");
    }
    if (entryComment !== 0 || entryDisk !== 0) {
      throw new ZipError("unsupported", "Entry comments and split archives aren't accepted.");
    }
    if (method === 0 && compressedSize !== size) {
      throw new ZipError("bad_size", "A stored entry's sizes disagree.");
    }
    if (madeBy >> 8 === 3) {
      const mode = external >>> 16;
      if (mode !== 0 && (mode & S_IFMT) !== S_IFREG) {
        throw new ZipError("not_a_file", "Only regular files are accepted (no links or folders).");
      }
    }
    if ((external & 0x10) !== 0) {
      throw new ZipError("not_a_file", "Only regular files are accepted (no links or folders).");
    }
    const name = central.toString("latin1", p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLength);
    const problem = zipNameProblem(name);
    if (problem !== undefined)
      throw new ZipError("bad_name", `An entry's name is unsafe (${problem}).`);
    if (size > limits.maxEntryBytes) throw new ZipError("too_large", "An entry is too large.");
    total += size;
    if (total > limits.maxTotalBytes)
      throw new ZipError("too_large", "The package unpacks too large.");
    entries.push({ name, method, crc, compressedSize, size, dataOffset: localOffset });
    p = next;
  }
  if (p !== central.length) {
    throw new ZipError("bad_directory", "The archive's directory has extra bytes.");
  }
  checkNameSet(entries.map((e) => e.name));

  // Each local header must agree; the data ranges must not overlap.
  const placed: ZipEntry[] = [];
  for (const entry of entries) {
    const header = await readAt(file, entry.dataOffset, LOCAL_SIZE);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError("bad_entry", "An entry's header is missing.");
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if (
      header.readUInt16LE(6) !== UTF8_FLAG ||
      header.readUInt16LE(8) !== entry.method ||
      header.readUInt32LE(14) !== entry.crc ||
      header.readUInt32LE(18) !== entry.compressedSize ||
      header.readUInt32LE(22) !== entry.size ||
      nameLength !== entry.name.length ||
      extraLength !== 0
    ) {
      throw new ZipError("bad_entry", "An entry's header disagrees with the directory.");
    }
    const localName = await readAt(file, entry.dataOffset + LOCAL_SIZE, nameLength);
    if (localName.toString("latin1") !== entry.name) {
      throw new ZipError("bad_entry", "An entry's header disagrees with the directory.");
    }
    placed.push({
      ...entry,
      dataOffset: entry.dataOffset + LOCAL_SIZE + nameLength + extraLength,
    });
  }
  const byStart = placed
    .map((e, i) => ({ start: entries[i]?.dataOffset ?? 0, end: e.dataOffset + e.compressedSize }))
    .sort((a, b) => a.start - b.start);
  // As the writer lays them out: from byte 0, one after another, up to the
  // directory. Nothing hidden before, between or after them.
  let expected = 0;
  for (const here of byStart) {
    if (here.start < expected) throw new ZipError("overlap", "The archive's entries overlap.");
    if (here.start > expected)
      throw new ZipError("gap", "The archive has bytes outside its entries.");
    expected = here.end;
  }
  if (expected > cdOffset) throw new ZipError("overlap", "The archive's entries overlap.");
  if (expected < cdOffset) throw new ZipError("gap", "The archive has bytes outside its entries.");
  return placed;
}

/** One file to write: its name in the archive and its bytes. */
export interface ZipInput {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * Writes a package the reader accepts: UTF-8-flagged names, regular files
 * (mode 0644), deflated when that is smaller, no comment, no ZIP64. Throws
 * `ZipError` for a name the reader would refuse or sizes past 4 GiB.
 */
export function writeZip(inputs: readonly ZipInput[]): Buffer {
  for (const input of inputs) {
    const problem = zipNameProblem(input.name);
    if (problem !== undefined) {
      throw new ZipError("bad_name", `"${input.name}" can't go in a package (${problem}).`);
    }
  }
  checkNameSet(inputs.map((i) => i.name));
  if (inputs.length > DEFAULT_ZIP_LIMITS.maxEntries) {
    throw new ZipError("too_many_entries", "Too many files for a package.");
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // A fixed time (1980-01-01 00:00) keeps packages byte-for-byte repeatable.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const input of inputs) {
    const raw = Buffer.from(input.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw);
    const name = Buffer.from(input.name, "latin1");
    if (offset + body.length > 0xfffffffe || raw.length > 0xfffffffe) {
      throw new ZipError("too_large", "The package would be larger than 4 GiB.");
    }
    const local = Buffer.alloc(LOCAL_SIZE);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(CENTRAL_SIZE);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((S_IFREG | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += LOCAL_SIZE + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(EOCD_SIZE);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(inputs.length, 8);
  end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
