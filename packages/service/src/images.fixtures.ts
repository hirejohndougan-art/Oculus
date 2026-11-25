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

/** A PNG from chunks given as [type, data] (valid CRCs), for strict-walk tests. */
export function pngFrom(chunks: readonly (readonly [string, Uint8Array])[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks.map(([type, data]) => chunk(type, data)),
  ]);
}

/** An IHDR chunk's data. */
export function ihdr(
  width: number,
  height: number,
  depth = 8,
  colorType = 0,
  interlace = 0,
): Buffer {
  return Buffer.concat([
    u32be(width),
    u32be(height),
    Buffer.from([depth, colorType, 0, 0, interlace]),
  ]);
}

/** Exactly `bytes` zero bytes compressed with zlib, streamed (never all in memory). */
export async function zlibZeroBytes(bytes: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 6 });
  const parts: Buffer[] = [];
  deflate.on("data", (c: Buffer) => parts.push(c));
  const ended = new Promise((resolve) => deflate.once("end", resolve));
  const zero = Buffer.alloc(1024 * 1024);
  let left = bytes;
  while (left > 0) {
    const piece = left >= zero.length ? zero : zero.subarray(0, left);
    left -= piece.length;
    if (!deflate.write(piece)) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await ended;
  return Buffer.concat(parts);
}

/** A valid all-black PNG of any size and format (zero filter bytes and samples). */
export async function zeroPng(
  width: number,
  height: number,
  depth = 8,
  colorType = 6,
): Promise<Buffer> {
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 4;
  const rowBytes = Math.ceil((width * depth * channels) / 8) + 1;
  return pngOf(width, height, await zlibZeroBytes(rowBytes * height), { depth, colorType });
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

/** Writes bits least significant first, as VP8L reads them. */
class BitWriter {
  private readonly bytes: number[] = [];
  private value = 0;
  private count = 0;
  write(value: number, bits: number): void {
    for (let k = 0; k < bits; k++) {
      this.value |= ((value >>> k) & 1) << this.count;
      this.count++;
      if (this.count === 8) {
        this.bytes.push(this.value);
        this.value = 0;
        this.count = 0;
      }
    }
  }
  /** A prefix code's bits, first bit of the code first. */
  writeCode(code: number, length: number): void {
    for (let k = length - 1; k >= 0; k--) this.write((code >>> k) & 1, 1);
  }
  finish(): Buffer {
    if (this.count > 0) this.bytes.push(this.value);
    return Buffer.from(this.bytes);
  }
}

/** A simple prefix code of one symbol (0 or 1): no bits per use. */
function oneSymbol(w: BitWriter, symbol: 0 | 1): void {
  w.write(1, 1); // simple
  w.write(0, 1); // one symbol
  w.write(0, 1); // a 1-bit symbol
  w.write(symbol, 1);
}

/**
 * A normal prefix code giving symbols 0–255 eight bits each and the rest
 * of the alphabet none (so a literal is its 8-bit value).
 */
function eightBitLiterals(w: BitWriter, alphabet: number): void {
  w.write(0, 1); // normal
  // Code-length code: symbols 0 and 8, one bit each. In the stored order
  // (17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8) 0 is third and 8 twelfth.
  w.write(12 - 4, 4);
  const order = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8];
  for (const symbol of order) w.write(symbol === 0 || symbol === 8 ? 1 : 0, 3);
  w.write(0, 1); // no max_symbol: every symbol of the alphabet
  for (let s = 0; s < alphabet; s++) w.writeCode(s < 256 ? 1 : 0, 1); // 8 → "1", 0 → "0"
}

/**
 * A valid lossless WebP (VP8L) whose meta prefix image gives every 4 × 4
 * block a prefix-code group of its own: (width/4) × (height/4) groups, each
 * with five one-symbol codes, all pixels black. The review's attack: 1,024²
 * makes 65,536 groups in under 300 KB.
 */
export function vp8lManyGroups(width: number, height: number): Buffer {
  const w = new BitWriter();
  w.write(0x2f, 8);
  w.write(width - 1, 14);
  w.write(height - 1, 14);
  w.write(0, 1); // no alpha
  w.write(0, 3); // version
  w.write(0, 1); // no transform
  w.write(0, 1); // no colour cache
  w.write(1, 1); // meta prefix codes
  w.write(0, 3); // prefix bits 2: 4 × 4 blocks
  const mw = Math.ceil(width / 4);
  const mh = Math.ceil(height / 4);
  const groups = mw * mh;
  // The meta image: no colour cache, its five codes, then each block's group.
  w.write(0, 1);
  eightBitLiterals(w, 256 + 24); // green
  eightBitLiterals(w, 256); // red
  oneSymbol(w, 0); // blue
  oneSymbol(w, 0); // alpha
  oneSymbol(w, 0); // distance
  for (let g = 0; g < groups; g++) {
    w.writeCode(g & 0xff, 8); // green: the group's low byte
    w.writeCode(g >> 8, 8); // red: its high byte
  }
  // Every group's five codes, one symbol each: pixels cost no bits.
  for (let g = 0; g < groups; g++) for (let c = 0; c < 5; c++) oneSymbol(w, 0);
  const data = w.finish();
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const chunk = Buffer.concat([Buffer.from("VP8L"), u32le(data.length), data, pad]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

/** A JPEG SOF0 segment claiming `width` × `height`, three components. */
function sof0(width: number, height: number): Buffer {
  const b = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  b.writeUInt16BE(height, 5);
  b.writeUInt16BE(width, 7);
  return b;
}

/**
 * JPEG parser disagreements (review B2a): `ff00Smuggle` starts with `FF 00`
 * (jpeg-js skips it as two bytes) followed by a comment holding a fake
 * 16 × 16 frame header and then a real `width` × `height` JPEG; `fill`
 * puts a fill byte before a marker; `sofAfterScan` adds a second frame
 * header after the image data; `unknownMarker` uses SOF3.
 */
export function jpegSmuggles(
  width: number,
  height: number,
): {
  ff00Smuggle: Buffer;
  fill: Buffer;
  sofAfterScan: Buffer;
  unknownMarker: Buffer;
} {
  const real = makeJpeg(width, height);
  const fake = sof0(16, 16);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(2), fake]);
  com.writeUInt16BE(2 + fake.length, 2);
  const body = real.subarray(2);
  const eoi = real.length - 2;
  const sof3 = Buffer.from(sof0(16, 16));
  sof3[1] = 0xc3;
  return {
    ff00Smuggle: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), com, body]),
    fill: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), body]),
    sofAfterScan: Buffer.concat([real.subarray(0, eoi), sof0(width, height), real.subarray(eoi)]),
    unknownMarker: Buffer.concat([Buffer.from([0xff, 0xd8]), sof3, body]),
  };
}

/** A PNG of noise-like pixels (so its memory is really touched when decoded). */
export function noisePng(width: number, height: number, depth: 8 | 16 = 8): Buffer {
  const row = width * 4 * (depth / 8) + 1;
  const raw = Buffer.alloc(row * height);
  let x = 12345;
  for (let i = 0; i < raw.length; i++) {
    if (i % row === 0) continue; // filter byte 0
    x = (x * 1103515245 + 12345) >>> 0;
    raw[i] = x >>> 24;
  }
  return pngOf(width, height, deflateSync(raw, { level: 1 }), { depth, colorType: 6 });
}
