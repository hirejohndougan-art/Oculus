/**
 * Image decoding for thumbnails (M-003, T-072, D-097), run in a decoder
 * process of its own (thumbnails.ts) so a slow or hostile image never
 * stalls the server, and memory a plan misses is held by a hard cap.
 *
 * - **The format is told, never guessed.** Each decoder is called only for
 *   the type Oculus sniffed when the file was stored (D-086), and only for
 *   JPEG (jpeg-js, BSD-3-Clause), PNG (pngjs, MIT), GIF (omggif, MIT) and
 *   WebP (@jsquash/webp, Apache-2.0: libwebp's decoder, BSD-3-Clause,
 *   built to WebAssembly; loaded from its own file, never fetched). The
 *   bytes must start with that format's signature; nothing is
 *   auto-detected. Every other type gets no thumbnail.
 * - **Every decode is planned first** (`planDecode`): the file walked
 *   strictly as its decoder reads it, its size within `THUMBNAIL_LIMITS`,
 *   and what decoding it costs within `DECODE_BUDGET_BYTES`. A JPEG is
 *   rebuilt from its walk, every segment exactly as long as what jpeg-js
 *   reads of it, before jpeg-js sees it; a PNG's image data is inflated
 *   with a ceiling of exactly what its header allows; a VP8L stream (a
 *   lossless WebP, or a compressed alpha channel) is read as far as its
 *   prefix-code groups, so their tables are counted at libwebp's largest.
 * - **The plan is not the last guard.** The decoder process is killed when
 *   its resident memory grows past `DECODE_MEMORY_CAP_BYTES`, or when it
 *   takes too long (thumbnails.ts).
 * - The output is always a baseline JPEG, transparency flattened onto
 *   white, scaled down (never up) to fit a square box. Originals (WebP
 *   included) are never changed.
 *
 * This file has no relative imports, so the decoder process can be
 * started from the build or, in tests, from the source with Node's type
 * stripping.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fstatSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

/** The formats Oculus makes thumbnails of (sniffed types, D-086). */
export const THUMBNAIL_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** The formats the admin may show inline (D-086's binding allow-list). */
export const VIEW_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface ImageLimits {
  /** The most pixels (width × height). */
  readonly maxPixels: number;
  /** The longest side, in pixels. */
  readonly maxSide: number;
}

/** What a thumbnail may be made from: 50 megapixels, 20,000 pixels a side. */
export const THUMBNAIL_LIMITS: ImageLimits = Object.freeze({
  maxPixels: 50_000_000,
  maxSide: 20_000,
});

/** What may be shown inline: 100 megapixels, 30,000 pixels a side. */
export const VIEW_LIMITS: ImageLimits = Object.freeze({ maxPixels: 100_000_000, maxSide: 30_000 });

/** The thumbnail sizes: the longest side of the box, in pixels. */
export const THUMBNAIL_BOXES = Object.freeze({ small: 160, medium: 480 });
export type ThumbnailSize = keyof typeof THUMBNAIL_BOXES;

/** JPEG quality of the thumbnails (jpeg-js, 1 to 100). */
const QUALITY = 80;

interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

// The codecs are CommonJS without bundled types (but jpeg-js's): loaded
// through createRequire and typed here with only what is used.
const load = createRequire(import.meta.url);
const jpeg = load("jpeg-js") as {
  decode(
    data: Uint8Array,
    options: {
      useTArray: true;
      formatAsRGBA: true;
      tolerantDecoding: boolean;
      maxResolutionInMP: number;
      maxMemoryUsageInMB: number;
    },
  ): Rgba;
  encode(image: Rgba, quality: number): { data: Uint8Array };
};
const pngjs = load("pngjs") as {
  PNG: {
    sync: {
      read(
        data: Buffer,
        options: { checkCRC: boolean },
      ): { width: number; height: number; data: Buffer };
    };
  };
};
const omggif = load("omggif") as {
  GifReader: new (data: Uint8Array) => {
    readonly width: number;
    readonly height: number;
    numFrames(): number;
    frameInfo(index: number): { x: number; y: number; width: number; height: number };
    decodeAndBlitFrameRGBA(index: number, pixels: Uint8Array): void;
  };
};

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number): number => u16be(b, i) * 65_536 + u16be(b, i + 2);
/** Whether `text` (ASCII) is at `i`: byte for byte, no strings made (B2). */
function ascii(b: Uint8Array, i: number, text: string): boolean {
  if (b.length < i + text.length) return false;
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** One component of a JPEG frame, as its frame header gives it. */
interface JpegComponent {
  readonly id: number;
  /** Horizontal and vertical sampling factors (1 to 4). */
  readonly h: number;
  readonly v: number;
}

/** What the strict JPEG walk found: the one frame, and the file rebuilt from what was walked. */
interface JpegLayout {
  readonly width: number;
  readonly height: number;
  readonly components: readonly JpegComponent[];
  /**
   * The file as jpeg-js is given it (T-072): SOI, every DQT, DHT, DRI, SOF
   * and SOS segment exactly as walked (each scan's entropy-coded data
   * copied), an Adobe APP14 marker normalised to the 12 bytes jpeg-js
   * reads, then EOI. Comments and other APPn segments are dropped. Only
   * with `whole` and `rebuild`.
   */
  readonly canonical?: Uint8Array;
}

/** Markers allowed as segments (with a length) before and between scans. */
const JPEG_SEGMENTS = new Set([
  0xc4, // DHT
  0xdb, // DQT
  0xdd, // DRI
  0xfe, // COM
  ...Array.from({ length: 16 }, (_, k) => 0xe0 + k), // APP0–15
]);
/** The frame types jpeg-js decodes: baseline, extended, progressive. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);
/** The largest sampling factor JPEG allows (ITU T.81 B.2.2); jpeg-js takes up to 15. */
const JPEG_MAX_SAMPLING = 4;
/**
 * The most segments a JPEG may have (review of T-072, B2: millions of tiny
 * segments cost time and, kept, memory): 64 DHT, DQT and DRI together,
 * 1,000 scans, 4,096 segments of any kind. Real files have a few dozen.
 */
export const JPEG_LIMITS = Object.freeze({ tables: 64, scans: 1000, segments: 4096 });

/**
 * Checks a segment's length against exactly what jpeg-js reads of it
 * (T-072: jpeg-js steps past SOF, SOS, DRI, DHT and DQT by what it
 * parsed, not by the length, so slack inside one could hide a second
 * frame header from a walk that trusts the length). Returns the frame of a
 * SOF; throws `ImageRefused` otherwise.
 */
function checkJpegSegment(
  b: Uint8Array,
  marker: number,
  at: number,
  length: number,
  frame: JpegLayout | undefined,
): JpegLayout | undefined {
  const data = at + 4;
  const end = at + 2 + length;
  if (JPEG_FRAMES.has(marker)) {
    // SOF: precision, height, width, Nc, then 3 bytes a component.
    const count = b[data + 5] ?? 0;
    if (length !== 8 + 3 * count || count < 1 || count > 4) throw new ImageRefused("jpeg_segment");
    if (b[data] !== 8) throw new ImageRefused("jpeg_precision");
    const components: JpegComponent[] = [];
    for (let k = 0; k < count; k++) {
      const c = data + 6 + 3 * k;
      const id = b[c] ?? 0;
      const h = (b[c + 1] ?? 0) >> 4;
      const v = (b[c + 1] ?? 0) & 0x0f;
      if (h < 1 || v < 1 || h > JPEG_MAX_SAMPLING || v > JPEG_MAX_SAMPLING) {
        throw new ImageRefused("jpeg_sampling");
      }
      if ((b[c + 2] ?? 0) > 3 || components.some((o) => o.id === id)) {
        throw new ImageRefused("jpeg_segment");
      }
      components.push({ id, h, v });
    }
    return { height: u16be(b, data + 1), width: u16be(b, data + 3), components };
  }
  switch (marker) {
    case 0xda: {
      // SOS: Ns, 2 bytes a component, then Ss, Se, Ah/Al.
      const count = b[data] ?? 0;
      if (length !== 6 + 2 * count || count < 1 || count > 4) {
        throw new ImageRefused("jpeg_segment");
      }
      const seen = new Set<number>();
      for (let k = 0; k < count; k++) {
        const id = b[data + 1 + 2 * k] ?? 0;
        if (seen.has(id) || frame?.components.some((c) => c.id === id) !== true) {
          throw new ImageRefused("jpeg_segment");
        }
        seen.add(id);
      }
      return frame;
    }
    case 0xdd:
      if (length !== 4) throw new ImageRefused("jpeg_segment");
      return frame;
    case 0xc4: {
      // DHT: tables of class/id, 16 counts and their values, filling it exactly.
      let i = data;
      while (i < end) {
        const spec = b[i] ?? 0;
        if (spec >> 4 > 1 || (spec & 0x0f) > 3 || i + 17 > end) {
          throw new ImageRefused("jpeg_segment");
        }
        let sum = 0;
        for (let k = 1; k <= 16; k++) sum += b[i + k] ?? 0;
        if (sum > 256) throw new ImageRefused("jpeg_segment");
        i += 17 + sum;
      }
      if (i !== end || length < 2 + 17) throw new ImageRefused("jpeg_segment");
      return frame;
    }
    case 0xdb: {
      // DQT: whole tables of 1 + 64 or 1 + 128 bytes, filling it exactly.
      let i = data;
      while (i < end) {
        const spec = b[i] ?? 0;
        if (spec >> 4 > 1 || (spec & 0x0f) > 3) throw new ImageRefused("jpeg_segment");
        i += 1 + 64 * ((spec >> 4) + 1);
      }
      if (i !== end || length < 2 + 65) throw new ImageRefused("jpeg_segment");
      return frame;
    }
    default:
      // APPn and COM: skipped by their length, as jpeg-js does.
      return frame;
  }
}

/**
 * Walks a JPEG's markers strictly, as its decoder reads them: SOI, then
 * only DHT, DQT, DRI, APPn, COM and exactly one SOF0, SOF1 or SOF2 before
 * the first SOS; `FF 00`, fill bytes, restart markers and every other
 * marker where a marker belongs are refused (review B2a), and every SOF,
 * SOS, DRI, DHT and DQT must be exactly as long as what jpeg-js reads of it
 * (T-072). With `whole`, the scans are walked too (their entropy-coded
 * data skipped by its `FF 00` stuffing and RST markers): a second frame
 * header, or anything but those segments, SOS and EOI, is refused, the
 * file must reach EOI, and the file is rebuilt from what was walked
 * (`canonical`, with `rebuild`: only the decoder needs the copy), so
 * jpeg-js reads exactly the segments checked here. Without `whole`, the
 * walk ends at the first SOS (the inline view's check).
 */
function walkJpeg(b: Uint8Array, whole: boolean, rebuild = false): JpegLayout {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new ImageRefused("header");
  let frame: JpegLayout | undefined;
  let scanned = false;
  // What is kept, as start and end offsets (never views, B2): SOI, tables, the frame, scans, EOI.
  const kept = new Uint32Array(2 * (2 + JPEG_LIMITS.tables + 1 + JPEG_LIMITS.scans + 1));
  let keptCount = 0;
  const keep = (start: number, end: number): void => {
    kept[2 * keptCount] = start;
    kept[2 * keptCount + 1] = end;
    keptCount++;
  };
  keep(0, 2);
  let adobe: Uint8Array | undefined;
  let tables = 0;
  let scans = 0;
  let segments = 0;
  let i = 2;
  for (;;) {
    if (i + 2 > b.length) throw new ImageRefused("jpeg_truncated");
    if (b[i] !== 0xff) throw new ImageRefused("jpeg_marker");
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd9) {
      if (!scanned || frame === undefined) throw new ImageRefused("jpeg_truncated");
      if (!rebuild) return frame;
      keep(i, i + 2);
      let total = adobe?.length ?? 0;
      for (let k = 0; k < keptCount; k++) total += (kept[2 * k + 1] ?? 0) - (kept[2 * k] ?? 0);
      const canonical = new Uint8Array(total);
      let at = 0;
      for (let k = 0; k < keptCount; k++) {
        const part = b.subarray(kept[2 * k] ?? 0, kept[2 * k + 1] ?? 0);
        canonical.set(part, at);
        at += part.length;
        // The Adobe marker right after SOI.
        if (k === 0 && adobe !== undefined) {
          canonical.set(adobe, at);
          at += adobe.length;
        }
      }
      return { ...frame, canonical };
    }
    if (!JPEG_FRAMES.has(marker) && marker !== 0xda && !JPEG_SEGMENTS.has(marker)) {
      // FF 00, fill bytes, RST, TEM, DNL and every other marker.
      throw new ImageRefused("jpeg_marker");
    }
    if (++segments > JPEG_LIMITS.segments) throw new ImageRefused("jpeg_segments");
    if ((marker === 0xc4 || marker === 0xdb || marker === 0xdd) && ++tables > JPEG_LIMITS.tables) {
      throw new ImageRefused("jpeg_segments");
    }
    if (marker === 0xda && ++scans > JPEG_LIMITS.scans) throw new ImageRefused("jpeg_segments");
    if (i + 4 > b.length) throw new ImageRefused("jpeg_truncated");
    const length = u16be(b, i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > b.length) throw new ImageRefused("jpeg_truncated");
    if (JPEG_FRAMES.has(marker) && (frame !== undefined || scanned)) {
      throw new ImageRefused("jpeg_second_frame");
    }
    if (marker === 0xda && frame === undefined) throw new ImageRefused("jpeg_marker");
    frame = checkJpegSegment(b, marker, i, length, frame);
    if (marker === 0xee && length >= 2 + 12 && ascii(b, i + 4, "Adobe\0")) {
      // jpeg-js reads the first 12 bytes of an Adobe APP14 (the last one wins).
      adobe = new Uint8Array([0xff, 0xee, 0x00, 0x0e, ...b.subarray(i + 4, i + 16)]);
    }
    if (marker === 0xda) {
      scanned = true;
      if (!whole) return frame ?? { width: 0, height: 0, components: [] };
      // The entropy-coded data: up to the next marker that isn't stuffing or RST.
      let j = end;
      for (;;) {
        j = b.indexOf(0xff, j);
        if (j < 0 || j + 1 >= b.length) throw new ImageRefused("jpeg_truncated");
        const next = b[j + 1] ?? 0;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          j += 2;
          continue;
        }
        break;
      }
      keep(i, j);
      i = j;
      continue;
    }
    if (marker < 0xe0) keep(i, end);
    i = end;
  }
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  try {
    const layout = walkJpeg(b, false);
    return { width: layout.width, height: layout.height };
  } catch {
    return undefined;
  }
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return undefined;
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a || b.length < 30) return undefined;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f || b.length < 25) return undefined;
    const b1 = b[21] ?? 0;
    const b2 = b[22] ?? 0;
    const b3 = b[23] ?? 0;
    const b4 = b[24] ?? 0;
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (ascii(b, 12, "VP8X")) {
    if (b.length < 30) return undefined;
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return undefined;
}

/**
 * An image's width and height from its header, read as the format named
 * (never guessed); `undefined` when the bytes don't start as that format
 * does or the header isn't within them.
 */
export function imageDimensions(
  format: string,
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  switch (format) {
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/png":
      if (!PNG_SIGNATURE.every((v, i) => bytes[i] === v) || !ascii(bytes, 12, "IHDR")) {
        return undefined;
      }
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    case "image/gif":
      if (!ascii(bytes, 0, "GIF87a") && !ascii(bytes, 0, "GIF89a")) return undefined;
      if (bytes.length < 10) return undefined;
      return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    case "image/webp":
      return webpDimensions(bytes);
    default:
      return undefined;
  }
}

/** Whether dimensions are within the limits (and not zero). */
export function withinLimits(
  size: { readonly width: number; readonly height: number } | undefined,
  limits: ImageLimits,
): boolean {
  if (size === undefined) return false;
  const { width, height } = size;
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= limits.maxSide &&
    height <= limits.maxSide &&
    width * height <= limits.maxPixels
  );
}

/** Thrown for an image that is refused; its message is a fixed code, never content. */
export class ImageRefused extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ImageRefused";
  }
}

/** Bytes a PNG's image data inflates to at most (each pass's rows plus filter bytes). */
function pngInflatedBytes(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlaced: boolean,
) {
  const rowBytes = (w: number): number => Math.ceil((w * bitsPerPixel) / 8) + 1;
  if (!interlaced) return rowBytes(width) * height;
  // Adam7: the seven passes' starting points and steps.
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (w > 0 && h > 0) total += rowBytes(w) * h;
  }
  return total;
}

const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** The bit depths each colour type allows (PNG 3rd edition, table 11.1). */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/** A PNG's one header and its image data, as the strict walk found them. */
interface PngLayout {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  readonly interlaced: boolean;
  /** Each IDAT chunk's data as start and end offsets (never views, B2). */
  readonly idat: Uint32Array;
  readonly idatBytes: number;
}

/**
 * The most chunks a PNG may have (review of T-072, B2): 65,536, room for
 * libpng's 8 KiB IDAT chunks in a 100 MiB file, far below the millions of
 * empty chunks a hostile file can hold.
 */
export const PNG_MAX_CHUNKS = 65_536;

/** Whether four bytes are a PNG chunk type (letters only), compared as bytes. */
function pngType(b: Uint8Array, i: number): boolean {
  for (let k = 0; k < 4; k++) {
    const c = (b[i + k] ?? 0) | 0x20;
    if (c < 0x61 || c > 0x7a) return false;
  }
  return true;
}

/**
 * Walks a PNG's chunks strictly (review B1: pngjs decodes by the last
 * IHDR, so a second one could smuggle a larger image past the limits):
 * the signature, then exactly one IHDR of length 13 first; at most one
 * PLTE, before the image data, present for colour type 3 and absent for
 * grey types; the IDAT chunks consecutive and none empty; IEND last with
 * nothing after it; every length within the file; at most `PNG_MAX_CHUNKS`
 * chunks. Anything else is refused.
 */
function walkPng(bytes: Uint8Array): PngLayout {
  if (!PNG_SIGNATURE.every((v, i) => bytes[i] === v)) throw new ImageRefused("png_header");
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, "IHDR")) throw new ImageRefused("png_header");
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  const depth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  const compression = bytes[26] ?? 0;
  const filter = bytes[27] ?? 0;
  const interlace = bytes[28] ?? 0;
  if (
    PNG_DEPTHS[colorType]?.includes(depth) !== true ||
    compression !== 0 ||
    filter !== 0 ||
    interlace > 1
  ) {
    throw new ImageRefused("png_header");
  }
  let idat = new Uint32Array(64);
  let idatCount = 0;
  let idatBytes = 0;
  let palettes = 0;
  let chunks = 1;
  let idatState: "before" | "in" | "after" = "before";
  let i = 8 + 25;
  for (;;) {
    if (++chunks > PNG_MAX_CHUNKS) throw new ImageRefused("png_chunks");
    if (i + 12 > bytes.length) throw new ImageRefused("png_truncated");
    const length = u32be(bytes, i);
    const end = i + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) throw new ImageRefused("png_truncated");
    if (!pngType(bytes, i + 4)) throw new ImageRefused("png_chunk");
    if (ascii(bytes, i + 4, "IHDR")) throw new ImageRefused("png_second_header");
    if (ascii(bytes, i + 4, "IDAT")) {
      if (idatState === "after" || length === 0) throw new ImageRefused("png_chunk");
      idatState = "in";
      if (2 * idatCount + 2 > idat.length) {
        const grown = new Uint32Array(idat.length * 2);
        grown.set(idat);
        idat = grown;
      }
      idat[2 * idatCount] = i + 8;
      idat[2 * idatCount + 1] = i + 8 + length;
      idatCount++;
      idatBytes += length;
    } else {
      if (idatState === "in") idatState = "after";
      if (ascii(bytes, i + 4, "PLTE")) {
        palettes++;
        if (palettes > 1 || idatState !== "before" || colorType === 0 || colorType === 4) {
          throw new ImageRefused("png_palette");
        }
      }
      if (ascii(bytes, i + 4, "IEND")) {
        if (end !== bytes.length) throw new ImageRefused("png_after_end");
        break;
      }
    }
    i = end;
  }
  if (idatCount === 0) throw new ImageRefused("png_truncated");
  if (colorType === 3 && palettes !== 1) throw new ImageRefused("png_palette");
  return {
    width,
    height,
    depth,
    colorType,
    interlaced: interlace === 1,
    idat: idat.subarray(0, 2 * idatCount),
    idatBytes,
  };
}

/**
 * Inflates a PNG's image data with a ceiling of exactly what its header
 * allows, so a few kilobytes that inflate to gigabytes are refused there.
 */
function checkPngData(bytes: Uint8Array, layout: PngLayout): void {
  const channels = PNG_CHANNELS[layout.colorType] ?? 4;
  const ceiling = pngInflatedBytes(
    layout.width,
    layout.height,
    layout.depth * channels,
    layout.interlaced,
  );
  const data = new Uint8Array(layout.idatBytes);
  for (let k = 0, at = 0; k < layout.idat.length; k += 2) {
    const part = bytes.subarray(layout.idat[k] ?? 0, layout.idat[k + 1] ?? 0);
    data.set(part, at);
    at += part.length;
  }
  try {
    inflateSync(data, { maxOutputLength: ceiling });
  } catch {
    // Over the ceiling (a bomb) or not valid zlib data.
    throw new ImageRefused("png_data");
  }
}

/** A WebP's ALPH chunk, as the walk found it. */
interface WebpAlpha {
  /** 0: raw alpha values; 1: compressed as a headerless VP8L image stream. */
  readonly compression: number;
  /** Where the compressed stream starts (after the 1-byte header) and ends. */
  readonly start: number;
  readonly end: number;
}

/** The chunks of a WebP file, walked strictly. */
interface WebpLayout {
  readonly width: number;
  readonly height: number;
  readonly lossless: boolean;
  /** The bytes the RIFF size names. */
  readonly body: Uint8Array;
  /** The VP8 or VP8L frame's data, within `body`. */
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly alpha?: WebpAlpha;
}

/** The most chunks a WebP may have (B2; real files have a handful). */
export const WEBP_MAX_CHUNKS = 64;

/** Width and height from a VP8 or VP8L chunk's own data. */
function webpFrameSize(
  type: string,
  b: Uint8Array,
  at: number,
  length: number,
): { width: number; height: number } {
  if (type === "VP8 ") {
    if (length < 10 || b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) {
      throw new ImageRefused("webp_frame");
    }
    return { width: u16le(b, at + 6) & 0x3fff, height: u16le(b, at + 8) & 0x3fff };
  }
  // VP8L: the signature, then 14 + 14 bits of size, the alpha hint and a version of 0.
  if (length < 5 || b[at] !== 0x2f || (b[at + 4] ?? 0) >> 5 !== 0) {
    throw new ImageRefused("webp_frame");
  }
  const b1 = b[at + 1] ?? 0;
  const b2 = b[at + 2] ?? 0;
  const b3 = b[at + 3] ?? 0;
  const b4 = b[at + 4] ?? 0;
  return {
    width: 1 + (b1 | ((b2 & 0x3f) << 8)),
    height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
  };
}

/**
 * Walks a WebP's RIFF container strictly: the RIFF size within the file
 * (only those bytes are decoded); a simple file (one VP8 or VP8L chunk) or
 * an extended one (VP8X first, then at most one ICCP and, for a VP8 frame
 * only, at most one ALPH, then exactly one VP8 or VP8L chunk, then
 * metadata); no animation (the VP8X flag, ANIM or ANMF chunks); every chunk
 * within the RIFF size; the frame's own size equal to the VP8X canvas. The
 * size used for the limits is the frame's. An ALPH chunk's header must be
 * one libwebp accepts (T-072: its compression is planned for).
 */
function walkWebp(bytes: Uint8Array): WebpLayout {
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) throw new ImageRefused("header");
  const riffSize =
    (bytes[4] ?? 0) +
    (bytes[5] ?? 0) * 256 +
    (bytes[6] ?? 0) * 65_536 +
    (bytes[7] ?? 0) * 16_777_216;
  if (riffSize < 12 || riffSize + 8 > bytes.length) throw new ImageRefused("webp_riff");
  const body = bytes.subarray(0, riffSize + 8);
  let canvas: { width: number; height: number } | undefined;
  let frame:
    { width: number; height: number; lossless: boolean; start: number; end: number } | undefined;
  let alpha: WebpAlpha | undefined;
  let iccp = false;
  let i = 12;
  let first = true;
  let chunks = 0;
  while (i < body.length) {
    if (++chunks > WEBP_MAX_CHUNKS) throw new ImageRefused("webp_chunks");
    if (i + 8 > body.length) throw new ImageRefused("webp_chunk");
    const is = (fourcc: string): boolean => ascii(body, i, fourcc);
    const length =
      (body[i + 4] ?? 0) +
      (body[i + 5] ?? 0) * 256 +
      (body[i + 6] ?? 0) * 65_536 +
      (body[i + 7] ?? 0) * 16_777_216;
    const end = i + 8 + length + (length % 2);
    if (end > body.length && i + 8 + length !== body.length) throw new ImageRefused("webp_chunk");
    if (is("VP8X")) {
      if (!first || length !== 10) throw new ImageRefused("webp_chunk");
      if (((body[i + 8] ?? 0) & 0x02) !== 0) throw new ImageRefused("webp_animated");
      canvas = { width: 1 + u24le(body, i + 12), height: 1 + u24le(body, i + 15) };
    } else if (is("ANIM") || is("ANMF")) {
      throw new ImageRefused("webp_animated");
    } else if (is("VP8 ") || is("VP8L")) {
      const lossless = is("VP8L");
      if (frame !== undefined) throw new ImageRefused("webp_second_frame");
      if (!first && canvas === undefined) throw new ImageRefused("webp_chunk");
      // libwebp ignores ALPH for a lossless frame (its alpha is its own): refused.
      if (lossless && alpha !== undefined) throw new ImageRefused("webp_chunk");
      frame = {
        ...webpFrameSize(lossless ? "VP8L" : "VP8 ", body, i + 8, length),
        lossless,
        start: i + 8,
        end: i + 8 + length,
      };
    } else if (is("ALPH")) {
      if (canvas === undefined || frame !== undefined || alpha !== undefined || length < 1) {
        throw new ImageRefused("webp_chunk");
      }
      // Reserved (2 bits, zero), pre-processing (at most 1), filtering, compression (0 or 1).
      const header = body[i + 8] ?? 0;
      if (header >> 6 !== 0 || ((header >> 4) & 3) > 1 || (header & 3) > 1) {
        throw new ImageRefused("webp_alpha");
      }
      alpha = { compression: header & 3, start: i + 9, end: i + 8 + length };
    } else if (is("ICCP")) {
      if (canvas === undefined || frame !== undefined || iccp) throw new ImageRefused("webp_chunk");
      iccp = true;
    } else if (first) {
      throw new ImageRefused("webp_chunk");
    }
    first = false;
    i = end;
  }
  if (frame === undefined) throw new ImageRefused("webp_frame");
  if (canvas !== undefined && (canvas.width !== frame.width || canvas.height !== frame.height)) {
    throw new ImageRefused("webp_canvas");
  }
  return {
    width: frame.width,
    height: frame.height,
    lossless: frame.lossless,
    body,
    frameStart: frame.start,
    frameEnd: frame.end,
    ...(alpha === undefined ? {} : { alpha }),
  };
}

/**
 * libwebp's largest table for one prefix-code group, by colour-cache bits
 * (`kTableSize` in `src/dec/vp8l_dec.c`, libwebp main, read 2026-11-25:
 * 630 × 3 + 410 entries for red, blue, alpha and distance, plus green's,
 * which grows with the cache), in 4-byte `HuffmanCode` entries.
 */
const VP8L_TABLE_ENTRIES = [654, 656, 658, 662, 670, 686, 718, 782, 912, 1168, 1680, 2704].map(
  (green) => 630 * 3 + 410 + green,
);
/** A group's `HTreeGroup` (five table pointers, flags, a 64-entry packed table), rounded up. */
const VP8L_GROUP_STRUCT_BYTES = 640;

/** What one VP8L prefix-code group can cost libwebp, at most, for these cache bits. */
export function vp8lGroupBytes(cacheBits: number): number {
  return (
    (VP8L_TABLE_ENTRIES[cacheBits] ?? VP8L_TABLE_ENTRIES[11] ?? 0) * 4 + VP8L_GROUP_STRUCT_BYTES
  );
}

/** Reads a VP8L bitstream, least significant bit first; past its end is a refusal. */
class Vp8lBits {
  private pos = 0;
  private readonly b: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  // No parameter properties: this file runs under Node's type stripping.
  constructor(b: Uint8Array, start: number, end: number) {
    this.b = b;
    this.start = start;
    this.end = end;
  }
  read(n: number): number {
    let value = 0;
    let got = 0;
    while (got < n) {
      const at = this.start + (this.pos >>> 3);
      if (at >= this.end) throw new ImageRefused("webp_lossless");
      const bit = this.pos & 7;
      const take = Math.min(8 - bit, n - got);
      value |= (((this.b[at] ?? 0) >>> bit) & ((1 << take) - 1)) << got;
      got += take;
      this.pos += take;
    }
    return value >>> 0;
  }
}

/** A canonical prefix code for reading (one symbol: no bits). */
interface Vp8lCode {
  readonly single: number;
  readonly count: Int32Array;
  readonly symbols: Int32Array;
}

/** The code for these lengths: complete, or a single symbol, as libwebp accepts. */
function vp8lCode(lengths: Uint8Array): Vp8lCode {
  const count = new Int32Array(16);
  let used = 0;
  let last = -1;
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s] ?? 0;
    if (len > 0) {
      count[len] = (count[len] ?? 0) + 1;
      used++;
      last = s;
    }
  }
  if (used === 0) throw new ImageRefused("webp_lossless");
  if (used === 1) return { single: last, count, symbols: new Int32Array(0) };
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = 2 * left - (count[len] ?? 0);
    if (left < 0) throw new ImageRefused("webp_lossless");
  }
  if (left !== 0) throw new ImageRefused("webp_lossless");
  const offsets = new Int32Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = (offsets[len] ?? 0) + (count[len] ?? 0);
  // Symbols by length, then by value: the canonical order.
  const symbols = new Int32Array(used);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s] ?? 0;
    if (len === 0) continue;
    const at = offsets[len] ?? 0;
    symbols[at] = s;
    offsets[len] = at + 1;
  }
  return { single: -1, count, symbols };
}

function vp8lSymbol(br: Vp8lBits, code: Vp8lCode): number {
  if (code.single >= 0) return code.single;
  let value = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    value |= br.read(1);
    const n = code.count[len] ?? 0;
    if (value - first < n) return code.symbols[index + value - first] ?? 0;
    index += n;
    first = (first + n) << 1;
    value <<= 1;
  }
  throw new ImageRefused("webp_lossless");
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** One prefix code over an alphabet (RFC 9649 §3.7.2.1). */
function vp8lReadCode(br: Vp8lBits, alphabet: number): Vp8lCode {
  const lengths = new Uint8Array(alphabet);
  if (br.read(1) === 1) {
    // A simple code: one or two symbols.
    const two = br.read(1) === 1;
    const first = br.read(br.read(1) === 1 ? 8 : 1);
    if (first < alphabet) lengths[first] = 1;
    if (two) {
      const second = br.read(8);
      if (second < alphabet) lengths[second] = 1;
    }
    return vp8lCode(lengths);
  }
  const lengthLengths = new Uint8Array(19);
  const n = 4 + br.read(4);
  for (let k = 0; k < n; k++) lengthLengths[CODE_LENGTH_ORDER[k] ?? 0] = br.read(3);
  const lengthCode = vp8lCode(lengthLengths);
  let max = alphabet;
  if (br.read(1) === 1) {
    max = 2 + br.read(2 + 2 * br.read(3));
    if (max > alphabet) throw new ImageRefused("webp_lossless");
  }
  let symbol = 0;
  let previous = 8;
  while (symbol < alphabet) {
    if (max-- === 0) break;
    const len = vp8lSymbol(br, lengthCode);
    if (len < 16) {
      lengths[symbol++] = len;
      if (len !== 0) previous = len;
      continue;
    }
    const slot = len - 16;
    const repeat = br.read([2, 3, 7][slot] ?? 0) + ([3, 3, 11][slot] ?? 0);
    if (symbol + repeat > alphabet) throw new ImageRefused("webp_lossless");
    lengths.fill(len === 16 ? previous : 0, symbol, symbol + repeat);
    symbol += repeat;
  }
  return vp8lCode(lengths);
}

/** An LZ77 length or distance from its prefix symbol (RFC 9649 §3.6.2.2). */
function vp8lPrefixValue(br: Vp8lBits, symbol: number): number {
  if (symbol < 4) return symbol + 1;
  const extra = (symbol - 2) >> 1;
  return ((2 + (symbol & 1)) << extra) + br.read(extra) + 1;
}

/**
 * The distance map for distance codes 1 to 120 (RFC 9649 figure 20), as
 * (x, y) offset pairs: the distance is x + y × width, at least 1.
 */
// prettier-ignore
const VP8L_DISTANCE_MAP = [
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2,
  -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0,
  1, 3, -1, 3, 3, 1, -3, 1, 2, 3, -2, 3, 3, 2,
  -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1,
  3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5,
  3, 4, -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5,
  5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4,
  -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6, 0,
  1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2,
  -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6,
  6, 3, -6, 3, 0, 7, 7, 0, 1, 7, -1, 7, 5, 5,
  -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4,
  2, 7, -2, 7, 7, 2, -7, 2, 3, 7, -3, 7, 7, 3,
  -7, 3, 5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7,
  -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6, -6, 6,
  8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7,
  -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6,
  8, 7,
];

/** A sub-image of `width` × `height` pixels: one group of codes, its own colour cache. */
function vp8lSubImage(br: Vp8lBits, width: number, height: number): Uint32Array {
  const cacheBits = vp8lCacheBits(br);
  const cacheSize = cacheBits > 0 ? 1 << cacheBits : 0;
  const [green, red, blue, alphaCode, distance] = [256 + 24 + cacheSize, 256, 256, 256, 40].map(
    (size) => vp8lReadCode(br, size),
  ) as [Vp8lCode, Vp8lCode, Vp8lCode, Vp8lCode, Vp8lCode];
  const total = width * height;
  const pixels = new Uint32Array(total);
  const cache = cacheSize > 0 ? new Uint32Array(cacheSize) : undefined;
  const shift = 32 - cacheBits;
  const insert = (px: number): void => {
    if (cache !== undefined) cache[Math.imul(px, 0x1e35a7bd) >>> shift] = px;
  };
  let pos = 0;
  while (pos < total) {
    const g = vp8lSymbol(br, green);
    if (g < 256) {
      const r = vp8lSymbol(br, red);
      const b = vp8lSymbol(br, blue);
      const a = vp8lSymbol(br, alphaCode);
      const px = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
      pixels[pos++] = px;
      insert(px);
    } else if (g < 256 + 24) {
      const length = vp8lPrefixValue(br, g - 256);
      const code = vp8lPrefixValue(br, vp8lSymbol(br, distance));
      let dist: number;
      if (code > 120) {
        dist = code - 120;
      } else {
        const dx = VP8L_DISTANCE_MAP[2 * (code - 1)] ?? 0;
        const dy = VP8L_DISTANCE_MAP[2 * (code - 1) + 1] ?? 0;
        dist = Math.max(1, dx + dy * width);
      }
      if (dist > pos || length > total - pos) throw new ImageRefused("webp_lossless");
      for (let k = 0; k < length; k++) {
        const px = pixels[pos - dist] ?? 0;
        pixels[pos++] = px;
        insert(px);
      }
    } else {
      if (cache === undefined) throw new ImageRefused("webp_lossless");
      const px = cache[g - 280] ?? 0;
      pixels[pos++] = px;
      insert(px);
    }
  }
  return pixels;
}

function vp8lCacheBits(br: Vp8lBits): number {
  if (br.read(1) === 0) return 0;
  const bits = br.read(4);
  if (bits < 1 || bits > 11) throw new ImageRefused("webp_lossless");
  return bits;
}

/** What a VP8L image stream's prefix codes will cost libwebp (T-072). */
interface Vp8lCost {
  /** Prefix-code groups of the main image: the largest in its entropy image, plus one. */
  readonly groups: number;
  /** The main image's colour-cache bits (0 for none). */
  readonly cacheBits: number;
  /** Pixels of the transforms' and entropy image's sub-images, all together. */
  readonly subPixels: number;
  /** Sub-images read (each has one group of its own). */
  readonly subImages: number;
  /**
   * Reads every group's five prefix codes and checks each is valid
   * (CVE-2023-4863): call once the plan is within the budget.
   */
  readonly checkGroups: () => void;
}

/**
 * Reads a VP8L image stream (RFC 9649) as far as libwebp allocates its
 * prefix-code tables (T-072, review finding 2): every transform (each
 * sub-image decoded, so the stream is followed exactly), the colour-cache
 * bits, and the entropy image, whose largest group index says how many
 * groups libwebp makes. Nothing of the main image's own pixels is read.
 * `start` is the stream after VP8L's 5-byte header, or an ALPH chunk's
 * compressed data (which has none). Throws `ImageRefused` for a stream
 * that isn't valid as far as it is read.
 */
function vp8lCost(
  b: Uint8Array,
  start: number,
  end: number,
  width: number,
  height: number,
): Vp8lCost {
  const br = new Vp8lBits(b, start, end);
  let xsize = width;
  let subPixels = 0;
  let subImages = 0;
  let seen = 0;
  const sub = (w: number, h: number): Uint32Array => {
    subPixels += w * h;
    subImages++;
    return vp8lSubImage(br, w, h);
  };
  const scaled = (size: number, bits: number): number => (size + (1 << bits) - 1) >> bits;
  while (br.read(1) === 1) {
    const type = br.read(2);
    if ((seen & (1 << type)) !== 0) throw new ImageRefused("webp_lossless");
    seen |= 1 << type;
    if (type === 0 || type === 1) {
      const bits = br.read(3) + 2;
      sub(scaled(xsize, bits), scaled(height, bits));
    } else if (type === 3) {
      const colours = br.read(8) + 1;
      sub(colours, 1);
      xsize = scaled(xsize, colours > 16 ? 0 : colours > 4 ? 1 : colours > 2 ? 2 : 3);
    }
  }
  const cacheBits = vp8lCacheBits(br);
  let groups = 1;
  if (br.read(1) === 1) {
    const bits = br.read(3) + 2;
    const entropy = sub(scaled(xsize, bits), scaled(height, bits));
    let largest = 0;
    for (const px of entropy) largest = Math.max(largest, (px >> 8) & 0xffff);
    groups = largest + 1;
  }
  const checkGroups = (): void => {
    const green = 256 + 24 + (cacheBits > 0 ? 1 << cacheBits : 0);
    for (let g = 0; g < groups; g++) {
      for (const size of [green, 256, 256, 256, 40]) vp8lReadCode(br, size);
    }
  };
  return { groups, cacheBits, subPixels, subImages, checkGroups };
}

/** What libwebp's prefix-code tables and sub-images cost for one VP8L stream, at most. */
function vp8lTableBytes(cost: Vp8lCost): number {
  return (
    cost.groups * vp8lGroupBytes(cost.cacheBits) +
    cost.subImages * vp8lGroupBytes(11) +
    cost.subPixels * 4
  );
}

/**
 * The most memory one decode may take, input and every copy included
 * (review B2: `resourceLimits` bounds only the JavaScript heap, and pixel
 * buffers live outside it): 320 MiB. Each format's cost per pixel below
 * was measured (thumbnails.test.ts, peak RSS) and rounded up. The plan is
 * the first guard; the decoder process's hard cap (`DECODE_MEMORY_CAP_BYTES`)
 * is the one that holds whatever a plan misses (T-072).
 */
export const DECODE_BUDGET_BYTES = 320 * 1024 * 1024;

/**
 * The hard cap on a decoder process's resident memory growth (T-072): its
 * resident size never grows past its size after start-up by more than
 * this (thumbnails.ts). Above the budget, so a planned decode is never
 * killed; far below what would trouble a small server.
 */
export const DECODE_MEMORY_CAP_BYTES = 384 * 1024 * 1024;

/**
 * How far below the cap the decoder process is killed: what a decode can
 * add between two samples (measured for the review's repros on a loaded
 * two-core machine: 1 to 11 MiB past the trigger at 10 ms), with room to
 * spare, so the peak stays within the cap. The trigger (352 MiB) is still
 * above the budget, so a planned decode is never killed.
 */
export const KILL_HEADROOM_BYTES = 32 * 1024 * 1024;

/** What decoding and scaling an image costs at most, in bytes (see `DECODE_BUDGET_BYTES`). */
export interface DecodePlan {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** The headroom on every plan (measured peaks vary by some 10% between runs). */
const PLAN_MARGIN = 1.1;

/**
 * What one of jpeg-js's coefficient blocks costs: an `Int32Array(64)` of
 * its own, so 256 bytes of data and some 450 of V8's bookkeeping (measured:
 * 670–770 bytes a block, rows included).
 */
export const JPEG_BLOCK_BYTES = 720;

/** Scaling after decoding: flattening in place, then halving (⅓ more at most). */
const SCALE_BYTES_PER_PIXEL = 4 * (4 / 3);

/**
 * What jpeg-js allocates for a frame, beyond its RGBA output (T-072):
 * coefficient blocks for whole MCUs (`prepareComponents`: rounded up to
 * the largest sampling factors, so a thin image with large factors costs
 * far more than its pixels), each component's sample lines, and the
 * interleaved samples (`getData`).
 */
function jpegFrameBytes(layout: JpegLayout): number {
  const { width, height, components } = layout;
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcusX = Math.ceil(width / 8 / maxH);
  const mcusY = Math.ceil(height / 8 / maxV);
  let bytes = width * height * components.length;
  for (const c of components) {
    bytes += mcusX * c.h * mcusY * c.v * JPEG_BLOCK_BYTES;
    const lineBlocks = Math.ceil((Math.ceil(width / 8) * c.h) / maxH);
    const columnBlocks = Math.ceil((Math.ceil(height / 8) * c.v) / maxV);
    bytes += lineBlocks * 8 * columnBlocks * 8;
  }
  return bytes;
}

/** How much of a file's start the server reads before handing it to the decoder process (64 KiB). */
export const THUMBNAIL_HEADER_BYTES = 64 * 1024;

/**
 * The server's own check before a thumbnail is queued (review of T-072,
 * B2): only `head`, at most `THUMBNAIL_HEADER_BYTES` of the file's start,
 * so it costs the server nothing whatever the file holds. The bytes must
 * start as the format named does, and a size its header declares within
 * them must be within the limits; anything the header doesn't settle is
 * left to the decoder process, which walks and plans the whole file.
 * Throws `ImageRefused` for a file to remember as having no thumbnail.
 */
export function precheckThumbnail(format: string, head: Uint8Array, limits: ImageLimits): void {
  if (!THUMBNAIL_TYPES.has(format)) throw new ImageRefused("format");
  const bounded = head.subarray(0, THUMBNAIL_HEADER_BYTES);
  const signed =
    format === "image/jpeg"
      ? bounded[0] === 0xff && bounded[1] === 0xd8
      : format === "image/png"
        ? PNG_SIGNATURE.every((v, i) => bounded[i] === v)
        : format === "image/gif"
          ? ascii(bounded, 0, "GIF87a") || ascii(bounded, 0, "GIF89a")
          : ascii(bounded, 0, "RIFF") && ascii(bounded, 8, "WEBP");
  if (!signed) throw new ImageRefused("header");
  const size = imageDimensions(format, bounded);
  if (size !== undefined && !withinLimits(size, limits)) throw new ImageRefused("too_large");
}

/**
 * Checks an image as the format named (never guessed), walking it strictly
 * for JPEG, PNG, WebP and GIF, against the limits and the memory budget,
 * and returns what decoding it will cost; throws `ImageRefused` otherwise.
 * It reads the whole file (a VP8L stream's sub-images included), so it
 * runs in the decoder process only (review of T-072, B2): the server
 * checks just the header (`precheckThumbnail`).
 */
export function planDecode(format: string, bytes: Uint8Array, limits: ImageLimits): DecodePlan {
  if (!THUMBNAIL_TYPES.has(format)) throw new ImageRefused("format");
  let width: number;
  let height: number;
  let perPixel: number;
  let extra = 0;
  let check: (() => number) | undefined;
  if (format === "image/png") {
    const layout = walkPng(bytes);
    ({ width, height } = layout);
    const channels = PNG_CHANNELS[layout.colorType] ?? 4;
    const inflated = pngInflatedBytes(width, height, layout.depth * channels, layout.interlaced);
    // Our ceiling check's inflate, pngjs's inflate and its unfiltered copy;
    // a 16-bit image's 16-bit bitmap; the RGBA output; scaling.
    extra = 3 * inflated;
    perPixel = (layout.depth === 16 ? 8 : 0) + 4 + SCALE_BYTES_PER_PIXEL;
  } else if (format === "image/webp") {
    const layout = walkWebp(bytes);
    ({ width, height } = layout);
    // libwebp's output in WebAssembly memory, its copy out, scaling; for
    // lossless, its ARGB working buffer; and a VP8L stream's prefix-code
    // tables (T-072): every group at libwebp's largest table for its
    // colour-cache bits (about 12–20 KB), for the groups its entropy image
    // names, read from the stream itself.
    perPixel = 4 + 4 + (layout.lossless ? 4 : 0) + SCALE_BYTES_PER_PIXEL;
    extra = 2 * bytes.length;
    const alpha = layout.alpha;
    if (alpha !== undefined) {
      // The alpha plane; a compressed one also a 32-bit working buffer (T-072, finding 3).
      extra += width * height * (alpha.compression === 1 ? 5 : 1);
    }
    const { body } = layout;
    // libwebp here is 1.1.0, before 1.3.2's fix for CVE-2023-4863 (a
    // crafted prefix code overflowing its tables): every code of every
    // group is read and must be complete (or one symbol) before libwebp
    // sees the stream, so the tables never pass kTableSize.
    const stream = layout.lossless
      ? { start: layout.frameStart + 5, end: layout.frameEnd }
      : alpha?.compression === 1
        ? { start: alpha.start, end: alpha.end }
        : undefined;
    if (stream !== undefined) {
      check = () => {
        const cost = vp8lCost(body, stream.start, stream.end, width, height);
        const tables = vp8lTableBytes(cost);
        if (
          Math.ceil((width * height * perPixel + extra + tables + bytes.length) * PLAN_MARGIN) <=
          DECODE_BUDGET_BYTES
        ) {
          cost.checkGroups();
        }
        return tables;
      };
    }
  } else if (format === "image/jpeg") {
    const layout = walkJpeg(bytes, true);
    ({ width, height } = layout);
    // jpeg-js's copy of the input, ours rebuilt from the walk, its blocks,
    // lines and samples (whole MCUs), then RGBA and scaling.
    extra = 2 * bytes.length + (withinLimits(layout, limits) ? jpegFrameBytes(layout) : 0);
    perPixel = 4 + SCALE_BYTES_PER_PIXEL;
  } else {
    const size = imageDimensions(format, bytes);
    if (size === undefined) throw new ImageRefused("header");
    // Every block walked to the trailer, at most GIF_MAX_BLOCKS of them (B2).
    if (gifExtent(bytes) === undefined) throw new ImageRefused("gif_blocks");
    ({ width, height } = size);
    // omggif: one index byte a pixel of the first frame, the RGBA screen, scaling.
    perPixel = 1 + 4 + SCALE_BYTES_PER_PIXEL;
  }
  if (!withinLimits({ width, height }, limits)) throw new ImageRefused("too_large");
  const plan = (): number =>
    Math.ceil((width * height * perPixel + extra + bytes.length) * PLAN_MARGIN);
  // The cheap estimate first: past the budget, nothing more is read.
  if (plan() > DECODE_BUDGET_BYTES) throw new ImageRefused("too_large");
  if (check !== undefined) extra += check();
  const cost = plan();
  if (cost > DECODE_BUDGET_BYTES) throw new ImageRefused("too_large");
  return { width, height, bytes: cost };
}

/** The most frames and extension blocks a GIF may have (B2). */
export const GIF_MAX_BLOCKS = 10_000;

/**
 * The extent a GIF's frames reach (the largest of its logical screen and
 * every image descriptor), walking its blocks; `undefined` when the walk
 * doesn't reach the trailer within `bytes` (review: the browser draws
 * every frame, not only the screen).
 */
export function gifExtent(b: Uint8Array): { width: number; height: number } | undefined {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return undefined;
  if (b.length < 13) return undefined;
  let blocks = 0;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const flags = b[10] ?? 0;
  let i = 13 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  const skipSubBlocks = (): boolean => {
    for (;;) {
      if (i >= b.length) return false;
      const size = b[i] ?? 0;
      i += 1;
      if (size === 0) return true;
      i += size;
    }
  };
  for (;;) {
    if (i >= b.length) return undefined;
    const block = b[i];
    if (block === 0x3b) return { width, height };
    // Frames and extensions together, at most GIF_MAX_BLOCKS (B2: omggif
    // makes an object for every frame before it decodes the first).
    if (++blocks > GIF_MAX_BLOCKS) return undefined;
    if (block === 0x21) {
      i += 2;
      if (!skipSubBlocks()) return undefined;
    } else if (block === 0x2c) {
      if (i + 10 > b.length) return undefined;
      const x = u16le(b, i + 1);
      const y = u16le(b, i + 3);
      width = Math.max(width, x + u16le(b, i + 5));
      height = Math.max(height, y + u16le(b, i + 7));
      const local = b[i + 9] ?? 0;
      i += 10 + ((local & 0x80) !== 0 ? 3 * 2 ** ((local & 0x07) + 1) : 0);
      i += 1; // LZW minimum code size
      if (!skipSubBlocks()) return undefined;
    } else {
      return undefined;
    }
  }
}

/**
 * The size a browser would draw an image at, read as the format named, for
 * the inline view's limits: the GIF's every frame, a WebP walked strictly;
 * `undefined` when it can't be told from `bytes`.
 */
export function viewDimensions(
  format: string,
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (format === "image/gif") return gifExtent(bytes);
  if (format === "image/webp") {
    try {
      const layout = walkWebp(bytes);
      return { width: layout.width, height: layout.height };
    } catch {
      return undefined;
    }
  }
  return imageDimensions(format, bytes);
}

/** libwebp's decoder (@jsquash/webp), loaded once per worker from its own files. */
type WebpDecode = (data: ArrayBuffer) => Promise<{
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}>;
let webpDecoder: Promise<WebpDecode> | undefined;
/** Node's WebAssembly (the project's type library has no DOM types). */
const wasm = (
  globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } }
).WebAssembly;

function loadWebp(): Promise<WebpDecode> {
  webpDecoder ??= (async () => {
    const folder = dirname(load.resolve("@jsquash/webp/package.json"));
    const module = (await import(pathToFileURL(join(folder, "decode.js")).href)) as {
      init(wasm: object): Promise<void>;
      default: WebpDecode;
    };
    // The WebAssembly is compiled from the package's own file: nothing is fetched.
    await module.init(await wasm.compile(readFileSync(join(folder, "codec/dec/webp_dec.wasm"))));
    return module.default;
  })();
  return webpDecoder;
}

/** A decoder that couldn't be loaded. */
class Unavailable extends Error {
  constructor(cause: unknown) {
    super("decoder unavailable", { cause });
    this.name = "Unavailable";
  }
}

/** A failure that says nothing about the file (an allocation, no decoder): never remembered. */
function transient(error: unknown): boolean {
  // Only an allocation that failed (or a decoder that didn't load) says
  // nothing about the file; every other exception inside a decoder (a
  // RangeError from pngjs on a malformed tRNS, say) is a refusal, the same
  // every time, and remembered (review of T-072).
  if (error instanceof Unavailable) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("allocation failed") ||
    message.includes("out of memory") ||
    message.includes("could not allocate")
  );
}

/**
 * How a decode is checked first. `planned` (always, but in the tests of
 * the decoder process's memory cap): the plan, its walks and the budget.
 * `unplanned`: the decoder is given the bytes as they are, so a test can
 * show the hard cap holding what a plan would have missed. Nothing outside
 * the tests asks for it.
 */
export type DecodeCheck = "planned" | "unplanned";

/**
 * Decodes an image of the format named to RGBA pixels, within the limits
 * and the memory budget (`planDecode` first). Throws `ImageRefused` for an
 * image it won't decode (the same every time), anything else for a
 * failure that may pass (memory).
 */
export async function decodeAny(
  format: string,
  bytes: Uint8Array,
  limits: ImageLimits,
  check: DecodeCheck = "planned",
): Promise<Rgba> {
  if (format !== "image/webp") return decodeImage(format, bytes, limits, check);
  const plan = check === "planned" ? planDecode(format, bytes, limits) : undefined;
  const body = check === "planned" ? walkWebp(bytes).body : bytes;
  let image: Awaited<ReturnType<WebpDecode>>;
  // The decoder failing to load says nothing about the file.
  const decode = await loadWebp().catch((error: unknown) => {
    throw new Unavailable(error);
  });
  try {
    // A copy of its own (a Buffer's slice would share its pool): never the caller's buffer.
    image = await decode(Uint8Array.from(body).buffer);
  } catch (error) {
    if (transient(error)) throw error;
    throw new ImageRefused("decode");
  }
  if (plan !== undefined && (image.width !== plan.width || image.height !== plan.height)) {
    throw new ImageRefused("webp_header");
  }
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
  };
}

/** Decodes a JPEG, PNG or GIF (WebP: `decodeAny`) within the limits and the budget. */
export function decodeImage(
  format: string,
  bytes: Uint8Array,
  limits: ImageLimits,
  check: DecodeCheck = "planned",
): Rgba {
  if (format === "image/webp") throw new ImageRefused("format");
  const size = check === "planned" ? planDecode(format, bytes, limits) : undefined;
  const same = (width: number, height: number): boolean =>
    size === undefined || (width === size.width && height === size.height);
  try {
    if (format === "image/jpeg") {
      // jpeg-js reads the file rebuilt from the strict walk (T-072): only
      // the segments walked, each exactly as long as what it reads.
      const canonical = check === "planned" ? walkJpeg(bytes, true, true).canonical : undefined;
      if (check === "planned" && canonical === undefined) throw new ImageRefused("jpeg_marker");
      const input = canonical ?? bytes;
      const image = jpeg.decode(input, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: limits.maxPixels / 1_000_000,
        maxMemoryUsageInMB: Math.ceil(DECODE_BUDGET_BYTES / (1024 * 1024)),
      });
      // The size decoded must be the size planned (review B2a).
      if (!same(image.width, image.height)) throw new ImageRefused("jpeg_header");
      return { width: image.width, height: image.height, data: image.data };
    }
    if (format === "image/png") {
      // One header (walkPng refused a second), so pngjs decodes this size.
      if (check === "planned") checkPngData(bytes, walkPng(bytes));
      const image = pngjs.PNG.sync.read(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        { checkCRC: true },
      );
      if (!same(image.width, image.height)) throw new ImageRefused("png_header");
      return { width: image.width, height: image.height, data: image.data };
    }
    const reader = new omggif.GifReader(bytes);
    if (!same(reader.width, reader.height) || reader.numFrames() < 1) {
      throw new ImageRefused("gif_header");
    }
    // The first frame, which must lie inside the screen.
    const frame = reader.frameInfo(0);
    if (frame.x + frame.width > reader.width || frame.y + frame.height > reader.height) {
      throw new ImageRefused("gif_frame");
    }
    const data = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, data);
    return { width: reader.width, height: reader.height, data };
  } catch (error) {
    if (error instanceof ImageRefused || transient(error)) throw error;
    // The decoder's own refusal (its message may quote the file): a fixed code.
    throw new ImageRefused("decode");
  }
}

/** The pixels with transparency flattened onto white (in place), every alpha 255. */
function flatten(image: Rgba): Rgba {
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 255;
    if (a === 255) continue;
    const keep = a / 255;
    const white = 255 * (1 - keep);
    d[i] = Math.round((d[i] ?? 0) * keep + white);
    d[i + 1] = Math.round((d[i + 1] ?? 0) * keep + white);
    d[i + 2] = Math.round((d[i + 2] ?? 0) * keep + white);
    d[i + 3] = 255;
  }
  return image;
}

/** Halves an image (2×2 averages; an odd last row or column is repeated). */
function halve(image: Rgba): Rgba {
  const width = Math.max(1, Math.floor(image.width / 2));
  const height = Math.max(1, Math.floor(image.height / 2));
  const src = image.data;
  const sw = image.width;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.min(2 * y, image.height - 1);
    const y1 = Math.min(2 * y + 1, image.height - 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.min(2 * x, sw - 1);
      const x1 = Math.min(2 * x + 1, sw - 1);
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] =
          ((src[a + k] ?? 0) + (src[b + k] ?? 0) + (src[c + k] ?? 0) + (src[d + k] ?? 0) + 2) >> 2;
      }
    }
  }
  return { width, height, data: out };
}

/** Scales to exactly `width` × `height` by bilinear interpolation. */
function bilinear(image: Rgba, width: number, height: number): Rgba {
  if (image.width === width && image.height === height) return image;
  const src = image.data;
  const sw = image.width;
  const sh = image.height;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top =
          (src[(y0 * sw + x0) * 4 + k] ?? 0) * (1 - wx) + (src[(y0 * sw + x1) * 4 + k] ?? 0) * wx;
        const bottom =
          (src[(y1 * sw + x0) * 4 + k] ?? 0) * (1 - wx) + (src[(y1 * sw + x1) * 4 + k] ?? 0) * wx;
        out[o + k] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width, height, data: out };
}

/** The size that fits `box` × `box`, never larger than the image. */
export function fitInBox(
  width: number,
  height: number,
  box: number,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, box / width, box / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Scales an image down to fit the box: halving first, then bilinear. */
export function scaleDown(image: Rgba, box: number): Rgba {
  const target = fitInBox(image.width, image.height, box);
  let current = image;
  while (current.width >= target.width * 2 && current.height >= target.height * 2) {
    current = halve(current);
  }
  return bilinear(current, target.width, target.height);
}

/** The thumbnail of an image as JPEG bytes; throws `ImageRefused` for one it won't make. */
export async function renderThumbnail(
  format: string,
  bytes: Uint8Array,
  box: number,
  check: DecodeCheck = "planned",
): Promise<Uint8Array> {
  const image = flatten(await decodeAny(format, bytes, THUMBNAIL_LIMITS, check));
  const small = scaleDown(image, box);
  return jpeg.encode(small, QUALITY).data;
}

/** The largest file a thumbnail is made from (100 MiB): the decoder process reads it whole. */
export const THUMBNAIL_SOURCE_MAX_BYTES = 100 * 1024 * 1024;

/** A job sent to the decoder process (its file is its descriptor 4), and its answer. */
export interface ThumbnailJob {
  readonly id: number;
  readonly format: string;
  readonly box: number;
  /** Tests of the memory cap only (`DecodeCheck`). */
  readonly check?: DecodeCheck;
}
export type ThumbnailAnswer =
  | { readonly id: number; readonly ok: true; readonly jpeg: Uint8Array }
  | { readonly id: number; readonly ok: false; readonly code: string };

/** The code of a failure that says nothing about the file (never remembered). */
export const TRANSIENT = "transient";

/** The argument that marks a decoder process started by `spawnDecoder` (and only it). */
export const WORKER_MARK = "oculus-thumbnail-decoder";

/** The decoder process's descriptors: the file it decodes, and the pipe its watchdog reports on. */
export const DECODER_FILE_FD = 4;
export const DECODER_MARKER_FD = 5;

/** The exit code of a decoder process its watchdog killed (where a signal can't say so). */
export const KILLED_EXIT_CODE = 137;

/**
 * A process's resident size (swap included) and its peak since last
 * reset, from Linux's /proc (bytes); `undefined` elsewhere.
 */
export function procMemory(pid: number | "self"): { rss: number; peak: number } | undefined {
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, "latin1");
    const field = (key: string): number => {
      const at = status.indexOf(`\n${key}:`);
      if (at < 0) return Number.NaN;
      return Number.parseInt(status.slice(at + key.length + 2).trimStart(), 10) * 1024;
    };
    const rss = field("VmRSS") + (field("VmSwap") || 0);
    const peak = field("VmHWM");
    return Number.isFinite(rss) && Number.isFinite(peak) ? { rss, peak } : undefined;
  } catch {
    return undefined;
  }
}

/** Resets this process's peak resident size to its current size (Linux; else nothing). */
function resetPeak(): void {
  try {
    writeFileSync("/proc/self/clear_refs", "5");
  } catch {
    // Not Linux, or not allowed: the peak then counts from the start.
  }
}

/**
 * The decoder process's own guard (review of T-072, B1: the parent's
 * sampler stalls whenever the server's event loop is busy, and dies with
 * it): a thread of the decoder process, started before any job, that every
 * 5 ms reads the process's resident size plus swap (/proc/self/status,
 * else `process.memoryUsage.rss()`) and kills the whole process once it
 * has grown past `killAt`, after writing "killed <peak growth>" to the
 * marker pipe; and that kills it at once if its parent is gone (its parent
 * process ID changed). The decode runs on the main thread, so only another
 * thread can watch it, whatever the main thread is doing (WebAssembly
 * included).
 */
const WATCHDOG = `
const { workerData } = require("node:worker_threads");
const { readFileSync, writeSync } = require("node:fs");
const { killAt, parent, marker } = workerData;
const field = (status, key) => {
  const at = status.indexOf("\\n" + key + ":");
  return at < 0 ? 0 : Number.parseInt(status.slice(at + key.length + 2).trimStart(), 10) * 1024 || 0;
};
const read = () => {
  try {
    const status = readFileSync("/proc/self/status", "latin1");
    return { now: field(status, "VmRSS") + field(status, "VmSwap"), peak: field(status, "VmHWM") };
  } catch {
    const rss = process.memoryUsage.rss();
    return { now: rss, peak: rss };
  }
};
const base = read().now;
const die = (line) => {
  try { writeSync(marker, line + "\\n"); } catch {}
  process.kill(process.pid, "SIGKILL");
};
setInterval(() => {
  if (process.ppid !== parent) die("orphan");
  const m = read();
  if (m.now - base > killAt) die("killed " + String(Math.max(m.now, m.peak) - base));
}, 5);
`;

/** Reads the whole file on a descriptor by position (a retry's process reads it again). */
function readDescriptor(fd: number): Uint8Array {
  const size = fstatSync(fd).size;
  if (size > THUMBNAIL_SOURCE_MAX_BYTES) throw new ImageRefused("too_large");
  const bytes = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    const read = readSync(fd, bytes, filled, size - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  if (filled !== size) throw new ImageRefused("truncated");
  return bytes;
}

/**
 * The decoder process (T-072): started by `spawnDecoder` for one job. It
 * loads the decoders and warms them up, starts its watchdog, resets its
 * peak and says it is ready; then it decodes the one job it is sent, from
 * the file on its descriptor 4, and answers. Its parent kills it after the
 * answer, past the memory cap or the time limit; if its parent goes, so
 * does it.
 */
async function serve(
  send: (message: unknown) => void,
  killAt: number,
  parent: number,
): Promise<void> {
  process.on("disconnect", () => process.exit(0));
  const { Worker } = await import("node:worker_threads");
  const watchdog = new Worker(WATCHDOG, {
    eval: true,
    workerData: { killAt, parent, marker: DECODER_MARKER_FD },
  });
  watchdog.unref();
  await new Promise((resolve) => watchdog.once("online", resolve));
  // Warm-up: every decoder loaded and run once, so the baseline holds them.
  await loadWebp().catch(() => undefined);
  const tiny = jpeg.encode({ width: 8, height: 8, data: new Uint8Array(256) }, QUALITY).data;
  await renderThumbnail("image/jpeg", tiny, 160).catch(() => undefined);
  resetPeak();
  process.on("message", (job: ThumbnailJob) => {
    void (async () => {
      let answer: ThumbnailAnswer;
      try {
        const bytes = readDescriptor(DECODER_FILE_FD);
        const jpegBytes = await renderThumbnail(job.format, bytes, job.box, job.check);
        answer = { id: job.id, ok: true, jpeg: jpegBytes };
      } catch (error) {
        // A refusal is the same every time; a failed allocation may pass.
        answer = {
          id: job.id,
          ok: false,
          code:
            error instanceof ImageRefused ? error.message : transient(error) ? TRANSIENT : "decode",
        };
      }
      send(answer);
    })();
  });
  send({ ready: true });
}

/**
 * Starts a decoder process for one job on the file open on `fd` (T-072):
 * this very file, run by the same Node.js with heap flags and an empty
 * environment (none of the server's variables, no NODE_OPTIONS), its
 * output discarded; the file on its descriptor 4 (it reads it itself, so
 * no bytes are copied over IPC), its watchdog's pipe on descriptor 5.
 */
export function spawnDecoder(options: {
  readonly fd: number;
  readonly killAt: number;
  readonly heapMiB: number;
}): ChildProcess {
  const root = process.env.SystemRoot;
  return spawn(
    process.execPath,
    [
      `--max-old-space-size=${String(options.heapMiB)}`,
      "--max-semi-space-size=16",
      fileURLToPath(import.meta.url),
      WORKER_MARK,
      String(options.killAt),
      String(process.pid),
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc", options.fd, "pipe"],
      serialization: "advanced",
      env: root === undefined ? {} : { SystemRoot: root },
      windowsHide: true,
    },
  );
}

if (process.argv[2] === WORKER_MARK && typeof process.send === "function") {
  const send = process.send.bind(process);
  void serve(
    (message) => send(message),
    Number(process.argv[3] ?? 0) || DECODE_MEMORY_CAP_BYTES - KILL_HEADROOM_BYTES,
    Number(process.argv[4] ?? 0),
  );
}
