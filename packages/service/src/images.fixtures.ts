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
  private bytes = new Uint8Array(1 << 16);
  private length = 0;
  private value = 0;
  private count = 0;
  /** Bits written so far. */
  get bits(): number {
    return this.length * 8 + this.count;
  }
  /** Up to 24 bits of `value`, least significant first. */
  write(value: number, bits: number): void {
    this.value |= (value & ((1 << bits) - 1)) << this.count;
    this.count += bits;
    while (this.count >= 8) {
      if (this.length === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.bytes[this.length++] = this.value & 0xff;
      this.value >>>= 8;
      this.count -= 8;
    }
  }
  /** A prefix code's bits, first bit of the code first. */
  writeCode(code: number, length: number): void {
    let reversed = 0;
    for (let k = 0; k < length; k++) reversed |= ((code >>> k) & 1) << (length - 1 - k);
    this.write(reversed, length);
  }
  /** Another writer's bits, appended. */
  append(other: BitWriter): void {
    const { bytes, length, value, count } = other;
    for (let i = 0; i < length; i++) this.write(bytes[i] ?? 0, 8);
    if (count > 0) this.write(value, count);
  }
  finish(): Buffer {
    const out = Buffer.from(this.bytes.subarray(0, this.length));
    return this.count > 0 ? Buffer.concat([out, Buffer.from([this.value & 0xff])]) : out;
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

/** A JPEG SOF0 segment claiming `width` × `height`, three components (luma sampled `luma`). */
function sof0(width: number, height: number, luma = 0x22): Buffer {
  const b = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0,
    0,
    0,
    0,
    0x03,
    1,
    luma,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
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

// ---------------------------------------------------------------------------
// The third review's repros (T-072), built here: no binary fixtures.

/**
 * A JPEG of `width` × `height` whose every 8 × 8 block is flat grey (DC
 * difference 0, end of block), with the jpeg-js encoder's standard tables:
 * any size in a few hundred kilobytes, and quick to make.
 */
export function flatJpeg(width: number, height: number): Buffer {
  const model = makeJpeg(16, 16);
  const parts: Buffer[] = [model.subarray(0, 2)];
  let i = 2;
  for (;;) {
    const marker = model[i + 1] ?? 0;
    const length = model.readUInt16BE(i + 2);
    const segment = Buffer.from(model.subarray(i, i + 2 + length));
    if (marker === 0xc0) {
      segment.writeUInt16BE(height, 5);
      segment.writeUInt16BE(width, 7);
    }
    parts.push(segment);
    i += 2 + length;
    if (marker === 0xda) break;
  }
  // Per MCU (three components, 1 × 1): luma DC 0 "00", EOB "1010";
  // chroma DC 0 "00", EOB "00", twice. 14 bits, never eight ones in a row.
  const mcus = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = "001010" + "0000" + "0000";
  const out = Buffer.alloc(Math.ceil((mcus * bits.length) / 8) + 1);
  let bit = 0;
  for (let m = 0; m < mcus; m++) {
    for (const c of bits) {
      if (c === "1") out[bit >> 3] = (out[bit >> 3] ?? 0) | (0x80 >> (bit & 7));
      bit++;
    }
  }
  // Pad the last byte with ones, as encoders do.
  while ((bit & 7) !== 0) {
    out[bit >> 3] = (out[bit >> 3] ?? 0) | (0x80 >> (bit & 7));
    bit++;
  }
  parts.push(out.subarray(0, bit >> 3), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** The segments of a JPEG up to its first SOS: [marker, start, end] each. */
function jpegSegments(b: Buffer): [number, number, number][] {
  const out: [number, number, number][] = [];
  let i = 2;
  for (;;) {
    const marker = b[i + 1] ?? 0;
    const end = i + 2 + b.readUInt16BE(i + 2);
    out.push([marker, i, end]);
    if (marker === 0xda) return out;
    i = end;
  }
}

/**
 * Repro A (review 3): a DRI whose length is 4 + N, its slack holding a
 * 3,800² SOF0 and then `FF FE` and a comment length covering the next
 * segment, a real 16 × 16 SOF0; then 3,800²'s entropy data. jpeg-js steps
 * past the DRI by the 4 bytes it reads, so it decodes the hidden frame; a
 * walk trusting the length sees only the 16 × 16 one.
 */
export function jpegDriSlack(size = 3800): Buffer {
  const real = flatJpeg(size, size);
  const sof = jpegSegments(real).find(([marker]) => marker === 0xc0);
  if (sof === undefined) throw new Error("no frame header");
  const [, at, end] = sof;
  const small = sof0(16, 16);
  const slack = Buffer.concat([
    real.subarray(at, end),
    Buffer.from([0xff, 0xfe, 0x00, 2 + small.length]),
  ]);
  const dri = Buffer.concat([Buffer.from([0xff, 0xdd, 0x00, 0x00, 0x00, 0x00]), slack]);
  dri.writeUInt16BE(4 + slack.length, 2);
  return Buffer.concat([real.subarray(0, at), dri, small, real.subarray(end)]);
}

/**
 * Repro B (review 3): a 16 × 16 JPEG whose SOF0 length is 19 bytes longer
 * than its three components need, the slack holding a 5,000² SOF0, which
 * jpeg-js parses (and allocates for) as a second frame.
 */
export function jpegSofSlack(): Buffer {
  const real = makeJpeg(16, 16);
  const sof = jpegSegments(real).find(([marker]) => marker === 0xc0);
  if (sof === undefined) throw new Error("no frame header");
  const [, at, end] = sof;
  const hidden = sof0(5000, 5000, 0x11);
  const grown = Buffer.concat([real.subarray(at, end), hidden]);
  grown.writeUInt16BE(end - at - 2 + hidden.length, 2);
  return Buffer.concat([real.subarray(0, at), grown, real.subarray(end)]);
}

/** Canonical prefix codes for code lengths (VP8L assigns them as deflate does). */
function canonicalCodes(lengths: Uint8Array): Int32Array {
  const count = new Int32Array(16);
  for (const len of lengths) if (len > 0) count[len] = (count[len] ?? 0) + 1;
  const next = new Int32Array(16);
  let code = 0;
  for (let len = 1; len < 16; len++) {
    code = (code + (count[len - 1] ?? 0)) << 1;
    next[len] = code;
  }
  // Each length's codes in order of symbol.
  return Int32Array.from(lengths, (len) => {
    if (len === 0) return 0;
    const value = next[len] ?? 0;
    next[len] = value + 1;
    return value;
  });
}

/** A prefix code ready for writing symbols (one symbol: no bits). */
interface WriteCode {
  readonly lengths: Uint8Array;
  readonly codes: Int32Array;
  readonly single: boolean;
}

function writeCodeOf(lengths: Uint8Array): WriteCode {
  const used = lengths.filter((len) => len > 0).length;
  return { lengths, codes: canonicalCodes(lengths), single: used === 1 };
}

function writeSymbol(w: BitWriter, code: WriteCode, symbol: number): void {
  if (!code.single) w.writeCode(code.codes[symbol] ?? 0, code.lengths[symbol] ?? 0);
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/**
 * Writes a normal prefix code with these code lengths (RFC 9649 §3.7.2.1.2):
 * runs as repeat codes 16, 17 and 18, the code-length code complete and at
 * most 7 bits a length. Lengths must form a complete code (or one symbol).
 */
function writeNormalCode(w: BitWriter, lengths: Uint8Array): WriteCode {
  const tokens: [number, number, number][] = [];
  for (let i = 0; i < lengths.length;) {
    const v = lengths[i] ?? 0;
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    i += run;
    let left = run;
    if (v === 0) {
      while (left >= 11) {
        const take = Math.min(138, left);
        tokens.push([18, 7, take - 11]);
        left -= take;
      }
      if (left >= 3) {
        tokens.push([17, 3, left - 3]);
        left = 0;
      }
    } else {
      tokens.push([v, 0, 0]);
      left--;
      while (left >= 3) {
        const take = Math.min(6, left);
        tokens.push([16, 2, take - 3]);
        left -= take;
      }
    }
    for (; left > 0; left--) tokens.push([v, 0, 0]);
  }
  // The code-length code: the commonest token 1 bit, the rest a complete
  // code of the other half at the smallest depth.
  const freq = new Map<number, number>();
  for (const [t] of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const ranked = [...freq.keys()].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));
  const clLengths = new Uint8Array(19);
  const [commonest = 0, ...rest] = ranked;
  clLengths[commonest] = 1;
  // m leaves under the other half: 2^d − m at depth d, the rest at d + 1.
  const d = Math.ceil(Math.log2(Math.max(1, rest.length)));
  const shallow = 2 ** d - rest.length;
  rest.forEach((t, k) => {
    clLengths[t] = k < shallow ? d : d + 1;
  });
  w.write(0, 1); // normal
  let last = 3;
  CODE_LENGTH_ORDER.forEach((t, k) => {
    if (clLengths[t] !== 0) last = Math.max(last, k);
  });
  w.write(last + 1 - 4, 4);
  for (let k = 0; k <= last; k++) w.write(clLengths[CODE_LENGTH_ORDER[k] ?? 0] ?? 0, 3);
  w.write(0, 1); // every symbol of the alphabet
  const clCode = writeCodeOf(clLengths);
  for (const [t, bits, extra] of tokens) {
    writeSymbol(w, clCode, t);
    if (bits > 0) w.write(extra, bits);
  }
  return writeCodeOf(lengths);
}

/** A one-symbol simple code for any symbol below 256. */
function oneSymbolOf(w: BitWriter, symbol: number): WriteCode {
  w.write(1, 1); // simple
  w.write(0, 1); // one symbol
  if (symbol < 2) {
    w.write(0, 1);
    w.write(symbol, 1);
  } else {
    w.write(1, 1);
    w.write(symbol, 8);
  }
  const lengths = new Uint8Array(symbol + 1);
  lengths[symbol] = 1;
  return writeCodeOf(lengths);
}

/** An LZ77 length or distance as its prefix symbol and extra bits (RFC 9649 §3.6.2.2). */
function lz77Prefix(value: number): { symbol: number; bits: number; extra: number } {
  if (value <= 4) return { symbol: value - 1, bits: 0, extra: 0 };
  const v = value - 1;
  const high = 31 - Math.clz32(v);
  const second = (v >> (high - 1)) & 1;
  return { symbol: 2 * high + second, bits: high - 1, extra: v & ((1 << (high - 1)) - 1) };
}

/**
 * Green code lengths for a colour cache of `cacheBits` (alphabet 280 + 2^bits)
 * that makes libwebp's table about as large as it gets: 2,304 symbols of
 * 15 bits (18 second-level tables of 128 entries), and literal 0 and the
 * longest length prefix short. Needs `cacheBits` of 11.
 */
function bigGreenLengths(cacheBits: number): Uint8Array {
  const alphabet = 280 + (1 << cacheBits);
  const lengths = new Uint8Array(alphabet);
  const short: [number, number][] = [
    [0, 1],
    [279, 2],
    [1, 3],
    [2, 5],
    [3, 6],
    [4, 7],
  ];
  for (const [symbol, len] of short) lengths[symbol] = len;
  let long = 0;
  for (let s = 5; s < alphabet && long < 18 * 128; s++) {
    if (s === 279) continue;
    lengths[s] = 15;
    long++;
  }
  if (long !== 18 * 128) throw new Error("alphabet too small");
  return lengths;
}

/**
 * A VP8L image stream of `width` × `height` (after the 5-byte header, so
 * also an ALPH chunk's compressed data): no transforms, a colour cache of
 * `cacheBits`, a prefix-code group for every 4 × 4 block, each group with a
 * large green code (`bigGreenLengths`), then all pixels black: one literal
 * and copies of the pixel before.
 */
function vp8lBigTablesStream(width: number, height: number, cacheBits: number): BitWriter {
  const w = new BitWriter();
  w.write(0, 1); // no transform
  w.write(1, 1); // a colour cache
  w.write(cacheBits, 4);
  w.write(1, 1); // meta prefix codes
  w.write(0, 3); // prefix bits 2: 4 × 4 blocks
  const groups = Math.ceil(width / 4) * Math.ceil(height / 4);
  w.write(0, 1); // the entropy image has no colour cache
  eightBitLiterals(w, 256 + 24);
  eightBitLiterals(w, 256);
  oneSymbol(w, 0);
  oneSymbol(w, 0);
  oneSymbol(w, 0);
  for (let g = 0; g < groups; g++) {
    w.writeCode(g & 0xff, 8);
    w.writeCode(g >> 8, 8);
  }
  // One group's codes, written once and repeated.
  const group = new BitWriter();
  const green = writeNormalCode(group, bigGreenLengths(cacheBits));
  for (let c = 0; c < 3; c++) oneSymbolOf(group, 0); // red, blue, alpha: 0
  oneSymbolOf(group, 1); // distance prefix 1: distance code 2, the pixel to the left
  for (let g = 0; g < groups; g++) w.append(group);
  // Pixels: one black literal, then copies of up to 4,096.
  writeSymbol(w, green, 0);
  let left = width * height - 1;
  while (left > 0) {
    const length = Math.min(4096, left);
    const { symbol, bits, extra } = lz77Prefix(length);
    writeSymbol(w, green, 256 + symbol);
    if (bits > 0) w.write(extra, bits);
    left -= length;
  }
  return w;
}

/**
 * Repro C (review 3): a lossless WebP of `size`² (780² by default) with a
 * group for every 4 × 4 block (38,025), colour-cache bits 11 and full
 * green codes, so each group's tables cost some 15 KB, not 6.5. It decodes.
 */
export function vp8lBigTables(size = 780, cacheBits = 11): Buffer {
  const w = new BitWriter();
  w.write(0x2f, 8);
  w.write(size - 1, 14);
  w.write(size - 1, 14);
  w.write(0, 1);
  w.write(0, 3);
  w.append(vp8lBigTablesStream(size, size, cacheBits));
  return riff([riffChunk("VP8L", w.finish())]);
}

/**
 * Repro D (review 3): a lossy WebP of `size`² (1,000² by default) whose
 * ALPH chunk is compressed as VP8L with repro C's shape (a group per 4 × 4
 * block, cache bits 11): planned before as if it were plain lossy.
 */
export async function alphBigTables(size = 1000): Promise<Buffer> {
  const lossy = await makeWebp(size, size);
  const alpha = Buffer.concat([Buffer.from([0x01]), vp8lBigTablesStream(size, size, 11).finish()]);
  return riff([vp8x(0x10, size, size), riffChunk("ALPH", alpha), chunksOf(lossy)]);
}

// ---------------------------------------------------------------------------
// The T-072 review's walk bombs (B2): millions of tiny segments, chunks or
// frames in just under the 100 MiB a thumbnail is made from, each built by
// filling a repeated pattern (quick, and nothing on disk).

/** Just under the 100 MiB a thumbnail is made from. */
const WALK_BOMB_BYTES = 100 * 1024 * 1024 - 64 * 1024;

/** `head`, then `pattern` repeated to fill, then `tail`, `total` bytes at most. */
function repeated(head: Uint8Array, pattern: Uint8Array, tail: Uint8Array, total: number): Buffer {
  const count = Math.floor((total - head.length - tail.length) / pattern.length);
  const out = Buffer.alloc(head.length + count * pattern.length + tail.length);
  out.set(head, 0);
  out.fill(pattern, head.length, head.length + count * pattern.length);
  out.set(tail, head.length + count * pattern.length);
  return out;
}

/** J1: SOI, some 17 million `FF DD 00 04 00 00` DRI segments, then an 8 × 8 image. */
export function jpegManyDri(total = WALK_BOMB_BYTES): Buffer {
  const tail = makeJpeg(8, 8).subarray(2);
  return repeated(Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xdd, 0, 4, 0, 0]), tail, total);
}

/** P1: an 8 × 8 PNG's header, some 8.7 million zero-length IDAT chunks, its data and IEND. */
export function pngEmptyIdats(total = WALK_BOMB_BYTES): Buffer {
  const png = makePng(8, 8);
  return repeated(png.subarray(0, 33), chunk("IDAT", new Uint8Array(0)), png.subarray(33), total);
}

/** P2: an 8 × 8 PNG's header, some 8.7 million empty tEXt chunks, its data and IEND. */
export function pngEmptyTexts(total = WALK_BOMB_BYTES): Buffer {
  const png = makePng(8, 8);
  return repeated(png.subarray(0, 33), chunk("tEXt", new Uint8Array(0)), png.subarray(33), total);
}

/** W1: a 16 × 16 WebP's VP8X, some 13 million empty unknown chunks, then its frame. */
export async function webpManyChunks(total = WALK_BOMB_BYTES): Promise<Buffer> {
  const frame = chunksOf(await makeWebp(16, 16));
  const head = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
    vp8x(0, 16, 16),
  ]);
  const out = repeated(head, Buffer.from("ABCD\0\0\0\0", "latin1"), frame, total);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** G1: a 1 × 1 GIF of some 6.6 million 1 × 1 frames (omggif makes an object for each). */
export function gifManyFrames(total = WALK_BOMB_BYTES): Buffer {
  // Screen 1 × 1 with a 2-colour table; each frame a descriptor, LZW size 2,
  // one sub-block (clear, 0, end: 0x44 0x01), the block end.
  const head = Buffer.from([
    ...Buffer.from("GIF89a"),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xff,
    0xff,
  ]);
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]);
  return repeated(head, frame, Buffer.from([0x3b]), total);
}

/** A 16-bit grey PNG with a 1-byte tRNS chunk (pngjs throws a RangeError on it). */
export function pngShortTrns(): Buffer {
  const rows = deflateSync(Buffer.alloc(4 * (1 + 8)));
  return pngFrom([
    ["IHDR", ihdr(4, 4, 16, 0)],
    ["tRNS", Buffer.from([0])],
    ["IDAT", rows],
    ["IEND", new Uint8Array(0)],
  ]);
}

/**
 * A lossless WebP like `vp8lManyGroups`, but its last group's green code
 * is incomplete (two symbols of lengths 1 and 2: three quarters of the
 * code space), the kind of code libwebp before 1.3.2 wrote past its tables
 * for (CVE-2023-4863). The plan must read every group's codes and refuse it.
 */
export function vp8lIncompleteCode(size = 64): Buffer {
  const w = new BitWriter();
  w.write(0x2f, 8);
  w.write(size - 1, 14);
  w.write(size - 1, 14);
  w.write(0, 1);
  w.write(0, 3);
  w.write(0, 1); // no transform
  w.write(0, 1); // no colour cache
  w.write(1, 1); // meta prefix codes
  w.write(0, 3); // 4 × 4 blocks
  const groups = Math.ceil(size / 4) ** 2;
  w.write(0, 1);
  eightBitLiterals(w, 256 + 24);
  eightBitLiterals(w, 256);
  oneSymbol(w, 0);
  oneSymbol(w, 0);
  oneSymbol(w, 0);
  for (let g = 0; g < groups; g++) {
    w.writeCode(g & 0xff, 8);
    w.writeCode(g >> 8, 8);
  }
  for (let g = 0; g < groups; g++) {
    if (g === groups - 1) {
      const lengths = new Uint8Array(280);
      lengths[0] = 1;
      lengths[1] = 2;
      writeNormalCode(w, lengths);
    } else {
      oneSymbol(w, 0);
    }
    for (let c = 1; c < 5; c++) oneSymbol(w, 0);
  }
  return riff([riffChunk("VP8L", w.finish())]);
}

/** Options for `blockJpeg` (T-074a). */
export interface BlockJpegOptions {
  /** Sampling factors per component (1, 3 or 4 components); `[[1, 1], [1, 1], [1, 1]]` by default. */
  readonly sampling?: readonly (readonly [number, number])[];
  /** Progressive: a DC scan of all components, then an AC scan of each, every block an EOB. */
  readonly progressive?: boolean;
  /** Progressive only: the first DC scan drops this many low bits, and refinement scans add them back. */
  readonly successive?: number;
  /** Restart interval in MCUs (0: none). */
  readonly restart?: number;
  /** Adds an Adobe APP14 with this transform flag (needed for four components). */
  readonly adobe?: number;
  /** The DC quantizer of every table (1 to 255); 8 by default, so a level is DC + 128. */
  readonly q0?: number;
  /** Interleaved DC scans (several components at once) or one scan per component; interleaved by default. */
  readonly interleaved?: boolean;
}

/**
 * A JPEG whose every block is flat (DC only, then EOB), its level chosen
 * per component and block by `level` (0 to 255): real, standard Huffman
 * tables (ITU T.81 K.3 for DC), baseline or progressive, any sampling,
 * restart markers, so jpeg-js decodes it to the same flat blocks the DC
 * decoder reads (T-074a). Invented pixels only.
 */
export function blockJpeg(
  width: number,
  height: number,
  level: (component: number, bx: number, by: number) => number,
  options: BlockJpegOptions = {},
): Buffer {
  const sampling = options.sampling ?? [
    [1, 1],
    [1, 1],
    [1, 1],
  ];
  const q0 = options.q0 ?? 8;
  const al = options.progressive ? (options.successive ?? 0) : 0;
  const restart = options.restart ?? 0;
  const maxH = Math.max(...sampling.map(([h]) => h));
  const maxV = Math.max(...sampling.map(([, v]) => v));
  const mcusX = Math.ceil(width / (8 * maxH));
  const mcusY = Math.ceil(height / (8 * maxV));
  const seg = (marker: number, body: number[] | Buffer): Buffer => {
    const out = Buffer.alloc(4 + body.length);
    out[0] = 0xff;
    out[1] = marker;
    out.writeUInt16BE(2 + body.length, 2);
    Buffer.from(body).copy(out, 4);
    return out;
  };
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (options.adobe !== undefined) {
    parts.push(
      seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, options.adobe]),
    );
  }
  parts.push(seg(0xdb, [0x00, q0, ...Array.from({ length: 63 }, () => 1)]));
  // DC: the standard luminance table (K.3); AC: one code, "0" = 0x00 (EOB, or EOBRUN 1).
  const dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  parts.push(seg(0xc4, [0x00, ...dcCounts, ...dcValues]));
  parts.push(seg(0xc4, [0x10, 1, ...Array.from({ length: 15 }, () => 0), 0x00]));
  if (restart > 0) parts.push(seg(0xdd, [restart >> 8, restart & 0xff]));
  const ids = sampling.map((_, k) => k + 1);
  parts.push(
    seg(options.progressive ? 0xc2 : 0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      sampling.length,
      ...sampling.flatMap(([h, v], k) => [ids[k] ?? 0, (h << 4) | v, 0]),
    ]),
  );
  // DC codes from K.3: category → [code, length].
  const dcCode: [number, number][] = [];
  {
    let code = 0;
    let k = 0;
    for (let l = 1; l <= 16; l++) {
      for (let n = 0; n < (dcCounts[l - 1] ?? 0); n++) dcCode[dcValues[k++] ?? 0] = [code++, l];
      code <<= 1;
    }
  }
  const writer = (): {
    put: (value: number, length: number) => void;
    align: () => void;
    out: number[];
  } => {
    const out: number[] = [];
    let acc = 0;
    let n = 0;
    const flush = (): void => {
      out.push(acc);
      if (acc === 0xff) out.push(0x00);
      acc = 0;
      n = 0;
    };
    return {
      out,
      put(value, length) {
        for (let k = length - 1; k >= 0; k--) {
          acc = (acc << 1) | ((value >> k) & 1);
          if (++n === 8) flush();
        }
      },
      align() {
        while (n !== 0) {
          acc = (acc << 1) | 1;
          if (++n === 8) flush();
        }
      },
    };
  };
  const blocksOf = (k: number): [number, number] => {
    const [h, v] = sampling[k] ?? [1, 1];
    return [
      Math.ceil(Math.ceil((width * h) / maxH) / 8),
      Math.ceil(Math.ceil((height * v) / maxV) / 8),
    ];
  };
  const value = (k: number, bx: number, by: number): number =>
    Math.round(((Math.max(0, Math.min(255, level(k, bx, by))) - 128) * 8) / q0);
  const scanOf = (
    comps: readonly number[],
    each: (w: ReturnType<typeof writer>, k: number, bx: number, by: number, pred: number[]) => void,
    header: number[],
  ): void => {
    const w = writer();
    const pred = comps.map(() => 0);
    const single = comps.length === 1;
    const first = comps[0] ?? 0;
    const [bw, bh] = blocksOf(first);
    const total = single ? bw * bh : mcusX * mcusY;
    let rst = 0;
    for (let m = 0; m < total; m++) {
      if (restart > 0 && m > 0 && m % restart === 0) {
        w.align();
        w.out.push(0xff, 0xd0 + (rst++ % 8));
        pred.fill(0);
      }
      if (single) {
        each(w, first, m % bw, Math.floor(m / bw), pred);
        continue;
      }
      const mx = m % mcusX;
      const my = Math.floor(m / mcusX);
      comps.forEach((k, slot) => {
        const [h, v] = sampling[k] ?? [1, 1];
        for (let y = 0; y < v; y++) {
          for (let x = 0; x < h; x++) {
            const p = [pred[slot] ?? 0];
            each(w, k, mx * h + x, my * v + y, p);
            pred[slot] = p[0] ?? 0;
          }
        }
      });
    }
    w.align();
    parts.push(seg(0xda, header), Buffer.from(w.out));
  };
  const dcDiff = (w: ReturnType<typeof writer>, diff: number): void => {
    const s = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    const [code, length] = dcCode[s] ?? [0, 0];
    w.put(code, length);
    if (s > 0) w.put(diff < 0 ? diff - 1 + (1 << s) : diff, s);
  };
  const dcScans = options.interleaved === false ? ids.map((_, k) => [k]) : [ids.map((_, k) => k)];
  for (const comps of dcScans) {
    scanOf(
      comps,
      (w, k, bx, by, pred) => {
        const dc = value(k, bx, by) >> al;
        dcDiff(w, dc - (pred[0] ?? 0));
        pred[0] = dc;
        if (!options.progressive) w.put(0, 1); // EOB
      },
      [
        comps.length,
        ...comps.flatMap((k) => [ids[k] ?? 0, 0x00]),
        0,
        options.progressive ? 0 : 63,
        al,
      ],
    );
  }
  if (options.progressive) {
    for (let bit = al - 1; bit >= 0; bit--) {
      for (const comps of dcScans) {
        scanOf(
          comps,
          (w, k, bx, by) => {
            w.put((value(k, bx, by) >> bit) & 1, 1);
          },
          [
            comps.length,
            ...comps.flatMap((k) => [ids[k] ?? 0, 0x00]),
            0,
            0,
            ((bit + 1) << 4) | bit,
          ],
        );
      }
    }
    for (let k = 0; k < ids.length; k++) {
      scanOf(
        [k],
        (w) => {
          w.put(0, 1); // EOBRUN of 1
        },
        [1, ids[k] ?? 0, 0x00, 1, 63, 0],
      );
    }
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/**
 * A baseline JPEG of seeded noise over a gradient at quality 95 (T-074a):
 * real AC data in every block and several megabytes of it, so a decode's
 * reading of AC codes and the plan's count of the input are both measured.
 */
export function noiseJpeg(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  let seed = 12_345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[i] =
      i % 4 === 3
        ? 255
        : Math.round(((seed >> 16) & 255) * 0.4 + ((i >> 2) % width) * (150 / width));
  }
  return jpeg.encode({ width, height, data }, 95).data;
}
