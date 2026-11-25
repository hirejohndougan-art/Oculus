/**
 * Image decoding for thumbnails (M-003, D-097), run in a worker thread
 * (thumbnails.ts) so a slow or hostile image never stalls the server.
 *
 * - **The format is told, never guessed.** Each decoder is called only for
 *   the type Oculus sniffed when the file was stored (D-086), and only for
 *   JPEG (jpeg-js, BSD-3-Clause), PNG (pngjs, MIT), GIF (omggif, MIT) and
 *   WebP (@jsquash/webp, Apache-2.0: libwebp's decoder, BSD-3-Clause,
 *   built to WebAssembly; loaded from its own file, never fetched). The
 *   bytes must start with that format's signature; nothing is
 *   auto-detected. Every other type gets no thumbnail.
 * - **Decompression bombs are refused before decoding.** The dimensions are
 *   read from the header first (`imageDimensions`): more than
 *   `THUMBNAIL_LIMITS.maxPixels` pixels or a side longer than `maxSide` is
 *   refused without allocating anything. A PNG's compressed data is
 *   inflated with a ceiling of exactly the bytes its header allows
 *   (`zlib.inflateSync`'s `maxOutputLength`), interlaced or not, before
 *   pngjs sees it (pngjs inflates an interlaced image without any ceiling).
 *   JPEG's own limits (`maxResolutionInMP`, `maxMemoryUsageInMB`) are set as
 *   a second line; a GIF's first frame must lie inside its screen. A WebP's
 *   RIFF size must not claim more than the file holds, and an animated
 *   WebP is refused (libwebp's still-image decoder checks that the frame
 *   matches the canvas before it allocates). The
 *   worker itself runs with a heap limit and a time limit (thumbnails.ts).
 * - The output is always a baseline JPEG, transparency flattened onto
 *   white, scaled down (never up) to fit a square box.
 *
 * This file has no relative imports, so the worker can be started from the
 * build or, in tests, from the source with Node's type stripping.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
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
const ascii = (b: Uint8Array, i: number, text: string): boolean =>
  b.length >= i + text.length &&
  Array.from({ length: text.length }, (_, k) => k).every((k) => b[i + k] === text.charCodeAt(k));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jpegDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Markers without a length: TEM, RST0–7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // The image data or its end came before any frame header.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(b, i + 2);
    if (length < 2) return undefined;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (i + 9 > b.length) return undefined;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
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
  readonly idat: readonly Uint8Array[];
}

/**
 * Walks a PNG's chunks strictly (review B1: pngjs decodes by the last
 * IHDR, so a second one could smuggle a larger image past the limits):
 * the signature, then exactly one IHDR of length 13 first; at most one
 * PLTE, before the image data, present for colour type 3 and absent for
 * grey types; the IDAT chunks consecutive; IEND last with nothing after
 * it; every length within the file. Anything else is refused.
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
  const idat: Uint8Array[] = [];
  let palettes = 0;
  let idatState: "before" | "in" | "after" = "before";
  let i = 8 + 25;
  for (;;) {
    if (i + 12 > bytes.length) throw new ImageRefused("png_truncated");
    const length = u32be(bytes, i);
    const end = i + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) throw new ImageRefused("png_truncated");
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageRefused("png_chunk");
    if (type === "IHDR") throw new ImageRefused("png_second_header");
    if (type === "IDAT") {
      if (idatState === "after") throw new ImageRefused("png_chunk");
      idatState = "in";
      idat.push(bytes.subarray(i + 8, i + 8 + length));
    } else {
      if (idatState === "in") idatState = "after";
      if (type === "PLTE") {
        palettes++;
        if (palettes > 1 || idatState !== "before" || colorType === 0 || colorType === 4) {
          throw new ImageRefused("png_palette");
        }
      }
      if (type === "IEND") {
        if (end !== bytes.length) throw new ImageRefused("png_after_end");
        break;
      }
    }
    i = end;
  }
  if (idat.length === 0) throw new ImageRefused("png_truncated");
  if (colorType === 3 && palettes !== 1) throw new ImageRefused("png_palette");
  return { width, height, depth, colorType, interlaced: interlace === 1, idat };
}

/**
 * Inflates a PNG's image data with a ceiling of exactly what its header
 * allows, so a few kilobytes that inflate to gigabytes are refused there.
 */
function checkPngData(layout: PngLayout): void {
  const channels = PNG_CHANNELS[layout.colorType] ?? 4;
  const ceiling = pngInflatedBytes(
    layout.width,
    layout.height,
    layout.depth * channels,
    layout.interlaced,
  );
  try {
    inflateSync(Buffer.concat(layout.idat), { maxOutputLength: ceiling });
  } catch {
    // Over the ceiling (a bomb) or not valid zlib data.
    throw new ImageRefused("png_data");
  }
}

/** The chunks of a WebP file, walked strictly. */
interface WebpLayout {
  readonly width: number;
  readonly height: number;
  readonly lossless: boolean;
  /** The bytes the RIFF size names. */
  readonly body: Uint8Array;
}

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
  if (length < 5 || b[at] !== 0x2f) throw new ImageRefused("webp_frame");
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
 * an extended one (VP8X first, then optionally ICCP and ALPH, then exactly
 * one VP8 or VP8L chunk, then metadata); no animation (the VP8X flag, ANIM
 * or ANMF chunks); every chunk within the RIFF size; the frame's own size
 * equal to the VP8X canvas. The size used for the limits is the frame's.
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
  let frame: { width: number; height: number; lossless: boolean } | undefined;
  let i = 12;
  let first = true;
  while (i < body.length) {
    if (i + 8 > body.length) throw new ImageRefused("webp_chunk");
    const type = String.fromCharCode(...body.subarray(i, i + 4));
    const length =
      (body[i + 4] ?? 0) +
      (body[i + 5] ?? 0) * 256 +
      (body[i + 6] ?? 0) * 65_536 +
      (body[i + 7] ?? 0) * 16_777_216;
    const end = i + 8 + length + (length % 2);
    if (end > body.length && i + 8 + length !== body.length) throw new ImageRefused("webp_chunk");
    if (type === "VP8X") {
      if (!first || length !== 10) throw new ImageRefused("webp_chunk");
      if (((body[i + 8] ?? 0) & 0x02) !== 0) throw new ImageRefused("webp_animated");
      canvas = { width: 1 + u24le(body, i + 12), height: 1 + u24le(body, i + 15) };
    } else if (type === "ANIM" || type === "ANMF") {
      throw new ImageRefused("webp_animated");
    } else if (type === "VP8 " || type === "VP8L") {
      if (frame !== undefined) throw new ImageRefused("webp_second_frame");
      if (!first && canvas === undefined) throw new ImageRefused("webp_chunk");
      frame = { ...webpFrameSize(type, body, i + 8, length), lossless: type === "VP8L" };
    } else if (type === "ALPH" || type === "ICCP") {
      if (canvas === undefined || frame !== undefined) throw new ImageRefused("webp_chunk");
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
  return { width: frame.width, height: frame.height, lossless: frame.lossless, body };
}

/**
 * The most memory one decode may take, input and every copy included
 * (review B2: `resourceLimits` bounds only the JavaScript heap, and pixel
 * buffers live outside it): 320 MiB. Each format's cost per pixel below
 * was measured (thumbnails.test.ts, peak RSS) and rounded up.
 */
export const DECODE_BUDGET_BYTES = 320 * 1024 * 1024;

/** What decoding and scaling an image costs at most, in bytes (see `DECODE_BUDGET_BYTES`). */
export interface DecodePlan {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Scaling after decoding: flattening in place, then halving (⅓ more at most). */
const SCALE_BYTES_PER_PIXEL = 4 * (4 / 3);

function jpegComponents(b: Uint8Array): number | undefined {
  let i = 2;
  while (i + 3 < b.length) {
    const marker = b[i + 1] ?? 0;
    if (b[i] !== 0xff) return undefined;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(b, i + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return b[i + 9];
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * Checks an image's header as the format named (never guessed), strictly
 * for PNG and WebP, against the limits and the memory budget, and returns
 * what decoding it will cost; throws `ImageRefused` otherwise. Cheap: no
 * pixel is decoded, so the server runs it before queueing a job too.
 */
export function planDecode(format: string, bytes: Uint8Array, limits: ImageLimits): DecodePlan {
  if (!THUMBNAIL_TYPES.has(format)) throw new ImageRefused("format");
  let width: number;
  let height: number;
  let perPixel: number;
  let extra = 0;
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
    // libwebp's output in WebAssembly memory, its copy out, scaling; and
    // for lossless, its ARGB working buffer.
    perPixel = 4 + 4 + (layout.lossless ? 4 : 0) + SCALE_BYTES_PER_PIXEL;
    extra = 2 * bytes.length;
  } else if (format === "image/jpeg") {
    const size = jpegDimensions(bytes);
    const components = jpegComponents(bytes);
    if (size === undefined || components === undefined || components < 1 || components > 4) {
      throw new ImageRefused("header");
    }
    ({ width, height } = size);
    // jpeg-js: its coefficient blocks and sample planes per component, then
    // RGBA (measured in the worker: up to 39 bytes a pixel at its peak for
    // three components, so about 7.8 megapixels fit the budget).
    perPixel = components * 11 + 4 + SCALE_BYTES_PER_PIXEL;
  } else {
    const size = imageDimensions(format, bytes);
    if (size === undefined) throw new ImageRefused("header");
    ({ width, height } = size);
    // omggif: one index byte a pixel of the first frame, the RGBA screen, scaling.
    perPixel = 1 + 4 + SCALE_BYTES_PER_PIXEL;
  }
  if (!withinLimits({ width, height }, limits)) throw new ImageRefused("too_large");
  const cost = Math.ceil(width * height * perPixel + extra + bytes.length);
  if (cost > DECODE_BUDGET_BYTES) throw new ImageRefused("too_large");
  return { width, height, bytes: cost };
}

/**
 * The extent a GIF's frames reach (the largest of its logical screen and
 * every image descriptor), walking its blocks; `undefined` when the walk
 * doesn't reach the trailer within `bytes` (review: the browser draws
 * every frame, not only the screen).
 */
export function gifExtent(b: Uint8Array): { width: number; height: number } | undefined {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return undefined;
  if (b.length < 13) return undefined;
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

/** A failure that says nothing about the file (memory, a crash): never remembered. */
function transient(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (error instanceof Error &&
      /memory/i.test(error.message) &&
      !error.message.includes("maxMemoryUsageInMB"))
  );
}

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
): Promise<Rgba> {
  const plan = planDecode(format, bytes, limits);
  if (format === "image/webp") {
    const layout = walkWebp(bytes);
    let image: Awaited<ReturnType<WebpDecode>>;
    try {
      const decode = await loadWebp();
      // A copy the decoder may keep: never the caller's buffer.
      image = await decode(layout.body.slice().buffer);
    } catch (error) {
      if (transient(error)) throw error;
      throw new ImageRefused("decode");
    }
    if (image.width !== plan.width || image.height !== plan.height) {
      throw new ImageRefused("webp_header");
    }
    return {
      width: image.width,
      height: image.height,
      data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    };
  }
  return decodeImage(format, bytes, limits);
}

/** Decodes a JPEG, PNG or GIF (WebP: `decodeAny`) within the limits and the budget. */
export function decodeImage(format: string, bytes: Uint8Array, limits: ImageLimits): Rgba {
  if (format === "image/webp") throw new ImageRefused("format");
  const size = planDecode(format, bytes, limits);
  try {
    if (format === "image/jpeg") {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: limits.maxPixels / 1_000_000,
        maxMemoryUsageInMB: Math.ceil(DECODE_BUDGET_BYTES / (1024 * 1024)),
      });
      return { width: image.width, height: image.height, data: image.data };
    }
    if (format === "image/png") {
      // One header (walkPng refused a second), so pngjs decodes this size.
      checkPngData(walkPng(bytes));
      const image = pngjs.PNG.sync.read(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        { checkCRC: true },
      );
      if (image.width !== size.width || image.height !== size.height) {
        throw new ImageRefused("png_header");
      }
      return { width: image.width, height: image.height, data: image.data };
    }
    const reader = new omggif.GifReader(bytes);
    if (reader.width !== size.width || reader.height !== size.height || reader.numFrames() < 1) {
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
): Promise<Uint8Array> {
  const image = flatten(await decodeAny(format, bytes, THUMBNAIL_LIMITS));
  const small = scaleDown(image, box);
  return jpeg.encode(small, QUALITY).data;
}

/** A job sent to the worker, and its answer. */
export interface ThumbnailJob {
  readonly id: number;
  readonly format: string;
  readonly bytes: Uint8Array;
  readonly box: number;
}
export type ThumbnailAnswer =
  | {
      readonly id: number;
      readonly ok: true;
      readonly jpeg: Uint8Array;
      /** Start a new worker after this one: WebAssembly memory grown for a large WebP never shrinks. */
      readonly recycle: boolean;
    }
  | { readonly id: number; readonly ok: false; readonly code: string; readonly recycle: boolean };

/** A WebP above this many pixels leaves its worker to be replaced (its WebAssembly memory stays grown). */
export const WEBP_RECYCLE_PIXELS = 4_000_000;

/** The code of a failure that says nothing about the file (never remembered). */
export const TRANSIENT = "transient";

/** Marks the worker started by thumbnails.ts (and only it). */
export const WORKER_MARK = "oculus-thumbnail-worker";

const port = parentPort;
if (port !== null && (workerData as { mark?: unknown } | null)?.mark === WORKER_MARK) {
  port.on("message", (job: ThumbnailJob) => {
    void (async () => {
      const size = job.format === "image/webp" ? imageDimensions(job.format, job.bytes) : undefined;
      const recycle = size !== undefined && size.width * size.height > WEBP_RECYCLE_PIXELS;
      let answer: ThumbnailAnswer;
      try {
        const jpegBytes = await renderThumbnail(job.format, job.bytes, job.box);
        answer = { id: job.id, ok: true, jpeg: jpegBytes, recycle };
      } catch (error) {
        answer = {
          id: job.id,
          ok: false,
          // A refusal is the same every time; anything else (memory) may pass.
          code: error instanceof ImageRefused ? error.message : TRANSIENT,
          // After a failure that isn't a refusal, start afresh.
          recycle: recycle || !(error instanceof ImageRefused),
        };
      }
      port.postMessage(answer);
    })();
  });
}
