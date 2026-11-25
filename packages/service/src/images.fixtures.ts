// Invented test images for thumbnails and views (M-003): real JPEG, PNG and
// GIF files made here, a WebP header, and decompression bombs. Every pixel
// is generated; nothing comes from a real collection.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDeflate, deflateSync } from "node:zlib";

const load = createRequire(import.meta.url);
const jpeg = load("jpeg-js") as {
  encode(
    image: { width: number; height: number; data: Uint8Array },
    quality: number,
  ): {
    data: Buffer;
  };
  decode(
    data: Uint8Array,
    options: { useTArray: true },
  ): { width: number; height: number; data: Uint8Array };
};
const pngjs = load("pngjs") as {
  PNG: {
    sync: {
      write(
        image: { width: number; height: number; data: Buffer },
        options?: { bitDepth?: number; colorType?: number; inputHasAlpha?: boolean },
      ): Buffer;
    };
  };
};
const omggif = load("omggif") as {
  GifWriter: new (
    buffer: Uint8Array,
    width: number,
    height: number,
    options: { palette: number[]; loop?: number },
  ) => {
    addFrame(
      x: number,
      y: number,
      w: number,
      h: number,
      pixels: Uint8Array,
      options?: { delay?: number },
    ): number;
    end(): number;
  };
};

/** A gradient, RGBA, with alpha falling off to the right when `alpha` is set. */
export function gradient(width: number, height: number, alpha = false): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[i + 2] = 96;
      data[i + 3] = alpha ? 255 - Math.round((x / Math.max(1, width - 1)) * 255) : 255;
    }
  }
  return data;
}

export function makeJpeg(width: number, height: number): Buffer {
  return jpeg.encode({ width, height, data: gradient(width, height) }, 85).data;
}

export function makePng(width: number, height: number, alpha = true): Buffer {
  return pngjs.PNG.sync.write({ width, height, data: Buffer.from(gradient(width, height, alpha)) });
}

/** A GIF of two frames (the second a different colour). */
export function makeGif(width: number, height: number): Buffer {
  const buffer = new Uint8Array(width * height * 4 + 4096);
  const writer = new omggif.GifWriter(buffer, width, height, {
    palette: [0xffffff, 0x2255aa, 0xaa5522, 0x000000],
    loop: 0,
  });
  const first = new Uint8Array(width * height).map((_, i) => (i % width < width / 2 ? 1 : 2));
  const second = new Uint8Array(width * height).fill(3);
  writer.addFrame(0, 0, width, height, first, { delay: 10 });
  writer.addFrame(0, 0, width, height, second, { delay: 10 });
  return Buffer.from(buffer.subarray(0, writer.end()));
}

/** The header of a lossless WebP of this size (enough for sniffing and its size). */
export function webpHeader(width: number, height: number): Buffer {
  const w = width - 1;
  const h = height - 1;
  const bits = Buffer.from([
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
  ]);
  const chunk = Buffer.concat([Buffer.from("VP8L"), u32le(bits.length), bits, Buffer.alloc(1)]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

export function decodeJpeg(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  return jpeg.decode(bytes, { useTArray: true });
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

/** A PNG from its header fields and already-compressed image data (valid CRCs). */
export function pngOf(
  width: number,
  height: number,
  idat: Uint8Array,
  options: { depth?: number; colorType?: number; interlace?: number } = {},
): Buffer {
  const ihdr = Buffer.concat([
    u32be(width),
    u32be(height),
    Buffer.from([options.depth ?? 8, options.colorType ?? 0, 0, 0, options.interlace ?? 0]),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Zeros compressed with zlib: `mib` MiB of them in a few hundred KiB. */
export async function zlibZeros(mib: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (c: Buffer) => parts.push(c));
  const ended = new Promise((resolve) => deflate.once("end", resolve));
  const zero = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < mib; i++) {
    if (!deflate.write(zero)) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await ended;
  return Buffer.concat(parts);
}

/**
 * Decompression bombs: `huge` claims 60,000 × 60,000 pixels in a tiny file;
 * `small` and `interlaced` claim 64 × 64 grey pixels but hold `mib` MiB of
 * compressed zeros (pngjs would inflate the interlaced one without a limit).
 */
export async function pngBombs(mib: number): Promise<{
  huge: Buffer;
  small: Buffer;
  interlaced: Buffer;
}> {
  const zeros = await zlibZeros(mib);
  return {
    huge: pngOf(60_000, 60_000, deflateSync(Buffer.alloc(60_001 * 4))),
    small: pngOf(64, 64, zeros),
    interlaced: pngOf(64, 64, zeros, { interlace: 1 }),
  };
}

/** A JPEG whose frame header claims 65,000 × 65,000 pixels. */
export function hugeJpeg(): Buffer {
  const real = makeJpeg(8, 8);
  const out = Buffer.from(real);
  for (let i = 2; i + 9 < out.length;) {
    const marker = out[i + 1] ?? 0;
    const length = out.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      out.writeUInt16BE(65_000, i + 5);
      out.writeUInt16BE(65_000, i + 7);
      return out;
    }
    i += 2 + length;
  }
  throw new Error("no frame header");
}

/** A GIF whose screen is 65,535 × 65,535 pixels. */
export function hugeGif(): Buffer {
  const out = Buffer.from(makeGif(4, 4));
  out.writeUInt16LE(65_535, 6);
  out.writeUInt16LE(65_535, 8);
  return out;
}

/** A GIF whose first frame lies outside its 4 × 4 screen. */
export function gifFrameOutside(): Buffer {
  const out = Buffer.from(makeGif(4, 4));
  // The first image descriptor (0x2c): x at +1, y at +3, width at +5.
  const at = out.indexOf(0x2c, 13 + 12);
  out.writeUInt16LE(60_000, at + 5);
  out.writeUInt16LE(60_000, at + 7);
  return out;
}

/** libwebp's encoder (@jsquash/webp), for making test WebPs only. */
let webpEncoder:
  | Promise<
      (
        image: { data: Uint8ClampedArray; width: number; height: number },
        options: { quality?: number; lossless?: number },
      ) => Promise<ArrayBuffer>
    >
  | undefined;

function encoder() {
  webpEncoder ??= (async () => {
    const folder = dirname(load.resolve("@jsquash/webp/package.json"));
    const module = (await import(pathToFileURL(join(folder, "encode.js")).href)) as {
      init(wasm: object): Promise<void>;
      default: (
        image: { data: Uint8ClampedArray; width: number; height: number },
        options: { quality?: number; lossless?: number },
      ) => Promise<ArrayBuffer>;
    };
    const wasm = (
      globalThis as unknown as { WebAssembly: { compile(b: Uint8Array): Promise<object> } }
    ).WebAssembly;
    await module.init(await wasm.compile(readFileSync(join(folder, "codec/enc/webp_enc.wasm"))));
    return module.default;
  })();
  return webpEncoder;
}

/** A real WebP: lossy (VP8, or VP8X with an alpha chunk) or lossless (VP8L). */
export async function makeWebp(
  width: number,
  height: number,
  options: { lossless?: boolean; alpha?: boolean } = {},
): Promise<Buffer> {
  const encode = await encoder();
  const data = new Uint8ClampedArray(gradient(width, height, options.alpha === true));
  const bytes = await encode(
    { data, width, height },
    options.lossless === true ? { lossless: 1 } : { quality: 75 },
  );
  return Buffer.from(bytes);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(type, "latin1"), u32le(data.length), data, pad]);
}

/** A VP8X chunk: flags and a canvas size. */
function vp8x(flags: number, width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riffChunk("VP8X", data);
}

/** The chunks after "WEBP" in a WebP file. */
function chunksOf(webp: Buffer): Buffer {
  return webp.subarray(12);
}

/**
 * WebP attacks: `hugeLossless` and `hugeCanvas` claim 16,384 × 16,384 pixels
 * in a few bytes; `smallCanvas` puts a 2,000 × 2,000 frame under a 16 × 16
 * canvas; `lyingRiff` claims more bytes than the file holds; `animated` sets
 * the animation flag.
 */
export async function webpAttacks(): Promise<{
  hugeLossless: Buffer;
  hugeCanvas: Buffer;
  smallCanvas: Buffer;
  lyingRiff: Buffer;
  animated: Buffer;
}> {
  const small = await makeWebp(16, 16);
  const big = await makeWebp(2000, 2000);
  const lyingRiff = Buffer.from(small);
  lyingRiff.writeUInt32LE(small.length * 1000, 4);
  return {
    hugeLossless: webpHeader(16_384, 16_384),
    hugeCanvas: riff([vp8x(0, 16_384, 16_384), chunksOf(small)]),
    smallCanvas: riff([vp8x(0, 16, 16), chunksOf(big)]),
    lyingRiff,
    animated: riff([vp8x(0x02, 16, 16), chunksOf(small)]),
  };
}
