/**
 * Image decoding for thumbnails (M-003, D-095), run in a worker thread
 * (thumbnails.ts) so a slow or hostile image never stalls the server.
 *
 * - **The format is told, never guessed.** Each decoder is called only for
 *   the type Oculus sniffed when the file was stored (D-086), and only for
 *   JPEG (jpeg-js, BSD-3-Clause), PNG (pngjs, MIT) and GIF (omggif, MIT).
 *   The bytes must start with that format's signature; nothing is
 *   auto-detected. WebP and every other type get no thumbnail.
 * - **Decompression bombs are refused before decoding.** The dimensions are
 *   read from the header first (`imageDimensions`): more than
 *   `THUMBNAIL_LIMITS.maxPixels` pixels or a side longer than `maxSide` is
 *   refused without allocating anything. A PNG's compressed data is
 *   inflated with a ceiling of exactly the bytes its header allows
 *   (`zlib.inflateSync`'s `maxOutputLength`), interlaced or not, before
 *   pngjs sees it (pngjs inflates an interlaced image without any ceiling).
 *   JPEG's own limits (`maxResolutionInMP`, `maxMemoryUsageInMB`) are set as
 *   a second line; a GIF's first frame must lie inside its screen. The
 *   worker itself runs with a heap limit and a time limit (thumbnails.ts).
 * - The output is always a baseline JPEG, transparency flattened onto
 *   white, scaled down (never up) to fit a square box.
 *
 * This file has no relative imports, so the worker can be started from the
 * build or, in tests, from the source with Node's type stripping.
 */
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { inflateSync } from "node:zlib";

/** The formats Oculus makes thumbnails of (sniffed types, D-086). */
export const THUMBNAIL_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
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

/**
 * Checks a PNG before pngjs reads it: the chunks are walked (lengths within
 * the file), and the image data is inflated with a ceiling of exactly what
 * the header allows, so a few kilobytes that inflate to gigabytes are
 * refused at the ceiling.
 */
function checkPng(bytes: Uint8Array, width: number, height: number): void {
  const depth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  const interlace = bytes[28] ?? 0;
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth) || interlace > 1) {
    throw new ImageRefused("png_header");
  }
  const parts: Uint8Array[] = [];
  let i = 8;
  let ended = false;
  while (i + 12 <= bytes.length) {
    const length = u32be(bytes, i);
    const end = i + 12 + length;
    if (end > bytes.length) throw new ImageRefused("png_truncated");
    if (ascii(bytes, i + 4, "IDAT")) parts.push(bytes.subarray(i + 8, i + 8 + length));
    if (ascii(bytes, i + 4, "IEND")) {
      ended = true;
      break;
    }
    i = end;
  }
  if (!ended || parts.length === 0) throw new ImageRefused("png_truncated");
  const ceiling = pngInflatedBytes(width, height, depth * channels, interlace === 1);
  try {
    inflateSync(Buffer.concat(parts), { maxOutputLength: ceiling });
  } catch {
    // Over the ceiling (a bomb) or not valid zlib data.
    throw new ImageRefused("png_data");
  }
}

/** Decodes an image of the format named to RGBA pixels, within the limits. */
export function decodeImage(format: string, bytes: Uint8Array, limits: ImageLimits): Rgba {
  if (!THUMBNAIL_TYPES.has(format)) throw new ImageRefused("format");
  const size = imageDimensions(format, bytes);
  if (size === undefined) throw new ImageRefused("header");
  if (!withinLimits(size, limits)) throw new ImageRefused("too_large");
  try {
    if (format === "image/jpeg") {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: limits.maxPixels / 1_000_000,
        maxMemoryUsageInMB: 1024,
      });
      return { width: image.width, height: image.height, data: image.data };
    }
    if (format === "image/png") {
      checkPng(bytes, size.width, size.height);
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
    if (error instanceof ImageRefused) throw error;
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
export function renderThumbnail(format: string, bytes: Uint8Array, box: number): Uint8Array {
  const image = flatten(decodeImage(format, bytes, THUMBNAIL_LIMITS));
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
  | { readonly id: number; readonly ok: true; readonly jpeg: Uint8Array }
  | { readonly id: number; readonly ok: false; readonly code: string };

/** Marks the worker started by thumbnails.ts (and only it). */
export const WORKER_MARK = "oculus-thumbnail-worker";

const port = parentPort;
if (port !== null && (workerData as { mark?: unknown } | null)?.mark === WORKER_MARK) {
  port.on("message", (job: ThumbnailJob) => {
    let answer: ThumbnailAnswer;
    try {
      answer = { id: job.id, ok: true, jpeg: renderThumbnail(job.format, job.bytes, job.box) };
    } catch (error) {
      answer = {
        id: job.id,
        ok: false,
        code: error instanceof ImageRefused ? error.message : "decode",
      };
    }
    port.postMessage(answer);
  });
}
