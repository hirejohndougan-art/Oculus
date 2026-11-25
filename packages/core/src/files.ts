/**
 * Stored files (M-002, D-086): what Oculus decides about an uploaded file's
 * bytes and name, without trusting the browser.
 *
 * - `sniffMediaType(head)` names the file's media type from its first bytes
 *   (`SNIFF_BYTES`), with a small magic-number table of our own: images,
 *   PDF, audio and video containers, archives, and the active types (HTML,
 *   XML, SVG) recognised the way the WHATWG MIME Sniffing standard does, so
 *   that serving (M-001, M-003) can treat them as active. Anything else is
 *   `text/plain` when it reads as UTF-8 text without binary control bytes,
 *   otherwise `application/octet-stream`. The type a browser claims is never
 *   used for this; it may be kept beside the sniffed one as a hint only.
 * - `cleanFileName(text)` turns the name a client sent into metadata: the
 *   last path segment only, NFC, at most `MAX_FILE_NAME_LENGTH` characters,
 *   and refused (`undefined`) when it holds control characters, bidirectional
 *   formatting characters (a right-to-left override can make a name ending
 *   in "fdp.exe" read as one ending in "exe.pdf"), or nothing but dots. A file name is **never** part of a
 *   path on disk: files are stored under their SHA-256 (service
 *   `file-store.ts`).
 * - `isSha256Hex` and `isClaimedMediaType` check stored values.
 *
 * Pure: no I/O.
 */

/** How many leading bytes `sniffMediaType` looks at. */
export const SNIFF_BYTES = 4096;

/** The longest original file name kept, in Unicode code points. */
export const MAX_FILE_NAME_LENGTH = 255;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True for a lowercase hexadecimal SHA-256 digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** The pattern of records' `mediaType` (records.ts), lowercase `type/subtype`. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** True for a media type as records store them: lowercase `type/subtype`, no parameters. */
export function isClaimedMediaType(value: unknown): value is string {
  return typeof value === "string" && MEDIA_TYPE.test(value);
}

function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (head[at + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
}

/** Magic numbers at offset 0 (or the given offset), most specific first. */
const MAGIC: readonly {
  readonly bytes: readonly number[];
  readonly at?: number;
  readonly type: string;
}[] = [
  { bytes: [0xff, 0xd8, 0xff], type: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: "image/png" },
  { bytes: ascii("GIF87a"), type: "image/gif" },
  { bytes: ascii("GIF89a"), type: "image/gif" },
  { bytes: [0x49, 0x49, 0x2a, 0x00], type: "image/tiff" },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], type: "image/tiff" },
  // BigTIFF.
  { bytes: [0x49, 0x49, 0x2b, 0x00], type: "image/tiff" },
  { bytes: [0x4d, 0x4d, 0x00, 0x2b], type: "image/tiff" },
  {
    bytes: [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
    type: "image/jp2",
  },
  { bytes: ascii("8BPS"), type: "image/vnd.adobe.photoshop" },
  { bytes: [0x00, 0x00, 0x01, 0x00], type: "image/vnd.microsoft.icon" },
  { bytes: ascii("BM"), type: "image/bmp" },
  { bytes: ascii("AT&TFORM"), type: "image/vnd.djvu" },
  { bytes: ascii("%PDF-"), type: "application/pdf" },
  { bytes: ascii("{\\rtf"), type: "application/rtf" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: "application/zip" },
  { bytes: [0x50, 0x4b, 0x05, 0x06], type: "application/zip" },
  { bytes: [0x1f, 0x8b], type: "application/gzip" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: "application/x-7z-compressed" },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], type: "application/x-ole-storage" },
  { bytes: ascii("OggS"), type: "application/ogg" },
  { bytes: ascii("fLaC"), type: "audio/flac" },
  { bytes: ascii("ID3"), type: "audio/mpeg" },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], type: "video/webm" },
];

/** RIFF containers: the form type at offset 8. */
const RIFF: Readonly<Record<string, string>> = {
  WEBP: "image/webp",
  WAVE: "audio/wav",
  "AVI ": "video/x-msvideo",
};

/** ISO base media (`ftyp` at offset 4): the major brand at offset 8. */
const FTYP_BRANDS: Readonly<Record<string, string>> = {
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  avif: "image/avif",
  avis: "image/avif",
  "qt  ": "video/quicktime",
  "M4A ": "audio/mp4",
  "M4B ": "audio/mp4",
  "M4V ": "video/mp4",
  isom: "video/mp4",
  iso2: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  avc1: "video/mp4",
  dash: "video/mp4",
  "3gp4": "video/3gpp",
  "3gp5": "video/3gpp",
  "3g2a": "video/3gpp2",
};

function text4(head: Uint8Array, at: number): string {
  return String.fromCharCode(...head.subarray(at, at + 4));
}

/**
 * The HTML signatures of the WHATWG MIME Sniffing standard §7.1 ("rules for
 * identifying an unknown MIME type"), matched case-insensitively after
 * leading white space and followed by a space or `>`. They make a file
 * `text/html`, an active type, whatever it claims to be.
 */
const HTML_TAGS = [
  "<!doctype html",
  "<html",
  "<head",
  "<script",
  "<iframe",
  "<h1",
  "<div",
  "<font",
  "<table",
  "<a",
  "<style",
  "<title",
  "<b",
  "<body",
  "<br",
  "<p",
];

const WHITE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** The markup-based types: HTML, SVG, XML, sniffed from text after white space and a BOM. */
function markupType(head: Uint8Array): string | undefined {
  let i = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < head.length && WHITE.has(head[i] ?? 0)) i++;
  if (head[i] !== 0x3c) return undefined;
  const rest = String.fromCharCode(
    ...head.subarray(i, Math.min(head.length, i + 64)),
  ).toLowerCase();
  if (rest.startsWith("<!--")) {
    // A comment first: look at everything we have, as a browser might.
    return activeMarkupIn(head) ?? "text/html";
  }
  for (const tag of HTML_TAGS) {
    if (!rest.startsWith(tag)) continue;
    const after = rest.charCodeAt(tag.length);
    if (after === 0x20 || after === 0x3e || Number.isNaN(after) || WHITE.has(after)) {
      return "text/html";
    }
  }
  if (rest.startsWith("<svg")) return "image/svg+xml";
  if (rest.startsWith("<?xml")) return activeMarkupIn(head) ?? "text/xml";
  return undefined;
}

/** Within markup text: an `<svg` or `<html` element anywhere in the head makes it that type. */
function activeMarkupIn(head: Uint8Array): string | undefined {
  const text = String.fromCharCode(...head).toLowerCase();
  if (/<svg[\s>]/.test(text)) return "image/svg+xml";
  if (/<html[\s>]|<script[\s>]/.test(text)) return "text/html";
  return undefined;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * True when the bytes read as UTF-8 text (allowing a sequence cut at the
 * end of the sample) with no NUL or other binary control bytes but tab, LF,
 * FF, CR and ESC.
 */
function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  for (const b of head) {
    if (
      (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) ||
      b === 0x7f
    ) {
      return false;
    }
  }
  // Up to three bytes may belong to a character the sample cut in two.
  for (let cut = 0; cut <= Math.min(3, head.length - 1); cut++) {
    try {
      UTF8.decode(head.subarray(0, head.length - cut));
      return true;
    } catch {
      // Try with one byte fewer.
    }
  }
  return false;
}

/**
 * The media type of a file from its first bytes (at most `SNIFF_BYTES` are
 * looked at). Never throws; anything unrecognised is
 * `application/octet-stream`. An empty file is `application/octet-stream`.
 */
export function sniffMediaType(input: Uint8Array): string {
  const head = input.subarray(0, SNIFF_BYTES);
  for (const magic of MAGIC) {
    if (startsWith(head, magic.bytes, magic.at)) return magic.type;
  }
  if (startsWith(head, ascii("RIFF")) && head.length >= 12) {
    const form = RIFF[text4(head, 8)];
    if (form !== undefined) return form;
  }
  if (head.length >= 12 && text4(head, 4) === "ftyp") {
    const brand = FTYP_BRANDS[text4(head, 8)];
    if (brand !== undefined) return brand;
  }
  // MPEG audio frame sync (no ID3 tag): 11 set bits, a valid layer.
  if (
    head.length >= 2 &&
    head[0] === 0xff &&
    ((head[1] ?? 0) & 0xe0) === 0xe0 &&
    ((head[1] ?? 0) & 0x06) !== 0
  ) {
    return "audio/mpeg";
  }
  const markup = markupType(head);
  if (markup !== undefined) return markup;
  if (looksLikeText(head)) return "text/plain";
  return "application/octet-stream";
}

/**
 * Controls (C0, C1, DEL: `Cc`), every format character (`Cf`: the
 * bidirectional ones, zero-width ones, soft hyphen, BOM), lone surrogates
 * (`Cs`) and the line and paragraph separators.
 */
const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

/**
 * The name a client gave a file, as metadata: the part after the last `/`
 * or `\`, NFC, trimmed of spaces, 1 to `MAX_FILE_NAME_LENGTH` code points.
 * `undefined` when it is empty, all dots, too long, or holds a control, a
 * format character, a lone surrogate or a line or paragraph separator. The result is shown as text only and
 * never used in a path.
 */
export function cleanFileName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  if (UNSAFE_NAME_CHARACTER.test(input)) return undefined;
  const last = input.split(/[/\\]/).at(-1) ?? "";
  const name = last.normalize("NFC").trim();
  if (name === "" || /^\.+$/.test(name)) return undefined;
  if (Array.from(name).length > MAX_FILE_NAME_LENGTH) return undefined;
  return name;
}
