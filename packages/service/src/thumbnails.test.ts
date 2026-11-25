// Thumbnails (M-003, T-072, D-097): reading sizes from headers as the
// format named, the limits, decoding JPEG, PNG, GIF and WebP and refusing
// everything else, decompression bombs refused before or at the inflate
// ceiling, the scaling, the decoder process's queue, time limit, closing
// and hard memory cap, and the third review's four repros. Every image is
// invented (images.fixtures.ts), and made here.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  THUMBNAIL_LIMITS,
  VIEW_LIMITS,
  DECODE_BUDGET_BYTES,
  DECODE_MEMORY_CAP_BYTES,
  DECODER_MARKER_FD,
  GIF_MAX_SUB_BLOCKS,
  KILL_HEADROOM_BYTES,
  THUMBNAIL_HEADER_BYTES,
  procMemory,
  spawnDecoder,
  precheckThumbnail,
  decodeAny,
  decodeImage,
  gifExtent,
  planDecode,
  viewDimensions,
  fitInBox,
  imageDimensions,
  renderThumbnail,
  vp8lGroupBytes,
  withinLimits,
} from "./thumbnail-worker.js";
import { DESCRIPTOR_PAUSE_MS, createThumbnailRenderer } from "./thumbnails.js";
import {
  alphBigTables,
  decodeJpeg,
  flatJpeg,
  gifFrameOutside,
  gifManyFrames,
  jpegManyDri,
  pngEmptyIdats,
  pngEmptyTexts,
  pngShortTrns,
  webpManyChunks,
  hugeGif,
  hugeJpeg,
  makeGif,
  makeJpeg,
  makePng,
  pngBombs,
  pngOf,
  ihdr,
  jpegDriSlack,
  jpegSmuggles,
  jpegSofSlack,
  makeWebp,
  noisePng,
  pngFrom,
  vp8lBigTables,
  vp8lIncompleteCode,
  vp8lManyGroups,
  webpAttacks,
  zeroPng,
  webpHeader,
} from "./images.fixtures.js";

const renderers: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const r of renderers) await r.close();
});

describe("image sizes from headers", () => {
  it("reads each format as named, and nothing as another format", () => {
    expect(imageDimensions("image/jpeg", makeJpeg(40, 30))).toEqual({ width: 40, height: 30 });
    expect(imageDimensions("image/png", makePng(41, 31))).toEqual({ width: 41, height: 31 });
    expect(imageDimensions("image/gif", makeGif(42, 32))).toEqual({ width: 42, height: 32 });
    expect(imageDimensions("image/webp", webpHeader(4000, 3000))).toEqual({
      width: 4000,
      height: 3000,
    });
    // Never guessed: a PNG read as a JPEG, a GIF or a WebP has no size.
    const png = makePng(8, 8);
    expect(imageDimensions("image/jpeg", png)).toBeUndefined();
    expect(imageDimensions("image/gif", png)).toBeUndefined();
    expect(imageDimensions("image/webp", png)).toBeUndefined();
    expect(imageDimensions("image/svg+xml", png)).toBeUndefined();
    expect(imageDimensions("image/png", Buffer.from("GIF89a<script>alert(1)</script>"))).toBe(
      undefined,
    );
    expect(imageDimensions("image/jpeg", Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it("finds a JPEG's frame header after other segments, and none after the image data", () => {
    const real = makeJpeg(16, 12);
    const comment = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x10, 0x02]),
      Buffer.alloc(0x1000, 0x41),
    ]);
    const withComment = Buffer.concat([real.subarray(0, 2), comment, real.subarray(2)]);
    expect(imageDimensions("image/jpeg", withComment)).toEqual({ width: 16, height: 12 });
    const sosFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions("image/jpeg", sosFirst)).toBeUndefined();
  });

  it("holds sizes to the limits", () => {
    expect(withinLimits({ width: 7000, height: 7000 }, THUMBNAIL_LIMITS)).toBe(true);
    expect(withinLimits({ width: 7072, height: 7072 }, THUMBNAIL_LIMITS)).toBe(false);
    expect(withinLimits({ width: 20_001, height: 1 }, THUMBNAIL_LIMITS)).toBe(false);
    expect(withinLimits({ width: 0, height: 10 }, THUMBNAIL_LIMITS)).toBe(false);
    expect(withinLimits({ width: 10_000, height: 10_000 }, VIEW_LIMITS)).toBe(true);
    expect(withinLimits({ width: 10_001, height: 10_000 }, VIEW_LIMITS)).toBe(false);
    expect(withinLimits(undefined, VIEW_LIMITS)).toBe(false);
  });
});

describe("decoding", () => {
  it("decodes JPEG, PNG (8- and 16-bit, palette, interlaced) and a GIF's first frame", () => {
    expect(decodeImage("image/jpeg", makeJpeg(20, 10), THUMBNAIL_LIMITS)).toMatchObject({
      width: 20,
      height: 10,
    });
    expect(decodeImage("image/png", makePng(9, 7), THUMBNAIL_LIMITS)).toMatchObject({
      width: 9,
      height: 7,
    });
    // 16-bit grey, 3 × 2: rows with a filter byte each.
    const grey16 = pngOf(3, 2, deflateSync(Buffer.alloc(2 * (1 + 6), 0)), { depth: 16 });
    expect(decodeImage("image/png", grey16, THUMBNAIL_LIMITS).data.length).toBe(3 * 2 * 4);
    // Interlaced 8-bit grey, 9 × 9 (Adam7's seven passes, all filled).
    const passes = [
      [2, 2],
      [1, 2],
      [3, 1],
      [2, 3],
      [5, 2],
      [4, 5],
      [9, 4],
    ];
    const interlacedData = Buffer.concat(
      passes.map(([w = 0, h = 0]) => Buffer.alloc((w + 1) * h, 0)),
    );
    const interlaced = pngOf(9, 9, deflateSync(interlacedData), { interlace: 1 });
    expect(decodeImage("image/png", interlaced, THUMBNAIL_LIMITS)).toMatchObject({
      width: 9,
      height: 9,
    });
    const gif = decodeImage("image/gif", makeGif(6, 4), THUMBNAIL_LIMITS);
    expect(gif).toMatchObject({ width: 6, height: 4 });
    // The first frame: blue on the left (palette entry 1), not the second frame's black.
    expect([...gif.data.subarray(0, 4)]).toEqual([0x22, 0x55, 0xaa, 255]);
  });

  it("never decodes a format other than the one named", () => {
    for (const [format, bytes] of [
      ["image/jpeg", makePng(4, 4)],
      ["image/png", makeJpeg(4, 4)],
      ["image/gif", makePng(4, 4)],
      ["image/webp", webpHeader(4, 4)],
      ["image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")],
      ["image/gif", Buffer.from("GIF89a<script>alert(1)</script>")],
    ] as const) {
      expect(() => decodeImage(format, bytes, THUMBNAIL_LIMITS), format).toThrow();
    }
  });

  it("refuses decompression bombs before decoding or at the inflate ceiling", async () => {
    const bombs = await pngBombs(64);
    for (const [name, bytes, code] of [
      ["huge PNG", bombs.huge, "too_large"],
      ["small PNG holding 64 MiB", bombs.small, "png_data"],
      ["interlaced PNG holding 64 MiB", bombs.interlaced, "png_data"],
      ["huge JPEG", hugeJpeg(), "too_large"],
      ["huge GIF", hugeGif(), "too_large"],
      ["GIF frame outside its screen", gifFrameOutside(), "gif_frame"],
    ] as const) {
      const before = process.memoryUsage().arrayBuffers;
      expect(
        () =>
          decodeImage(
            name.includes("PNG") ? "image/png" : name.includes("JPEG") ? "image/jpeg" : "image/gif",
            bytes,
            THUMBNAIL_LIMITS,
          ),
        name,
      ).toThrow(code);
      // Nothing near the claimed size was allocated.
      expect(process.memoryUsage().arrayBuffers - before, name).toBeLessThan(32 * 1024 * 1024);
    }
  });

  it("refuses a truncated PNG and one with a bad header", () => {
    const png = makePng(8, 8);
    expect(() =>
      decodeImage("image/png", png.subarray(0, png.length - 20), THUMBNAIL_LIMITS),
    ).toThrow();
    const badDepth = pngOf(4, 4, deflateSync(Buffer.alloc(20)), { depth: 3 });
    expect(() => decodeImage("image/png", badDepth, THUMBNAIL_LIMITS)).toThrow("png_header");
  });
});

describe("WebP", () => {
  it("decodes lossy, lossless and alpha WebP, told the format", async () => {
    const lossy = await makeWebp(120, 80);
    const lossless = await makeWebp(33, 21, { lossless: true });
    const alpha = await makeWebp(40, 30, { alpha: true });
    expect(lossy.subarray(12, 16).toString()).toBe("VP8 ");
    expect(lossless.subarray(12, 16).toString()).toBe("VP8L");
    expect(alpha.subarray(12, 16).toString()).toBe("VP8X");
    for (const [bytes, width, height] of [
      [lossy, 120, 80],
      [lossless, 33, 21],
      [alpha, 40, 30],
    ] as const) {
      expect(imageDimensions("image/webp", bytes)).toEqual({ width, height });
      const image = await decodeAny("image/webp", bytes, THUMBNAIL_LIMITS);
      expect({ width: image.width, height: image.height }).toEqual({ width, height });
      expect(image.data.length).toBe(width * height * 4);
    }
    // Lossless keeps the exact pixels: the first is the gradient's start.
    const exact = await decodeAny("image/webp", lossless, THUMBNAIL_LIMITS);
    expect([...exact.data.subarray(0, 4)]).toEqual([0, 0, 96, 255]);
    // Alpha survives decoding (the right edge is transparent) and becomes white in the thumbnail.
    const withAlpha = await decodeAny("image/webp", alpha, THUMBNAIL_LIMITS);
    expect(withAlpha.data[(10 * 40 + 39) * 4 + 3]).toBeLessThan(20);
    const thumb = decodeJpeg(await renderThumbnail("image/webp", alpha, 160));
    expect({ width: thumb.width, height: thumb.height }).toEqual({ width: 40, height: 30 });
    expect(thumb.data[(10 * 40 + 39) * 4]).toBeGreaterThan(230);
    // Never decoded as another format, nor another format as WebP.
    expect(() => decodeImage("image/webp", lossy, THUMBNAIL_LIMITS)).toThrow("format");
    await expect(decodeAny("image/webp", makePng(8, 8), THUMBNAIL_LIMITS)).rejects.toThrow(
      "header",
    );
    await expect(decodeAny("image/png", lossy, THUMBNAIL_LIMITS)).rejects.toThrow();
  });

  it("refuses size bombs, a lying RIFF size, a frame bigger than its canvas and animation", async () => {
    const attacks = await webpAttacks();
    for (const [name, bytes, code] of [
      ["16,384² lossless header", attacks.hugeLossless, "too_large"],
      ["16,384² canvas over a 16² frame", attacks.hugeCanvas, "webp_canvas"],
      ["RIFF size past the file", attacks.lyingRiff, "webp_riff"],
      ["animated", attacks.animated, "webp_animated"],
    ] as const) {
      const before = process.memoryUsage().arrayBuffers;
      await expect(decodeAny("image/webp", bytes, THUMBNAIL_LIMITS), name).rejects.toThrow(code);
      expect(process.memoryUsage().arrayBuffers - before, name).toBeLessThan(32 * 1024 * 1024);
    }
    // A 2,000 × 2,000 frame under a 16 × 16 canvas: refused by the walk,
    // before libwebp sees it.
    expect(() => planDecode("image/webp", attacks.smallCanvas, THUMBNAIL_LIMITS)).toThrow(
      "webp_canvas",
    );
  });

  it(
    "renders WebP thumbnails in the decoder process and refuses the attacks there",
    { timeout: 60_000 },
    async () => {
      const renderer = createThumbnailRenderer();
      renderers.push(renderer);
      const ok = await renderer.render("image/webp", await makeWebp(640, 480), 160);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(decodeJpeg(ok.jpeg)).toMatchObject({ width: 160, height: 120 });
      // Over 4 megapixels: rendered, then the process (its WebAssembly memory
      // grown) is replaced, and the next job still works.
      const large = await renderer.render("image/webp", await makeWebp(2100, 2000), 160);
      expect(large.ok).toBe(true);
      expect((await renderer.render("image/webp", await makeWebp(50, 50), 160)).ok).toBe(true);
      const attacks = await webpAttacks();
      for (const bytes of Object.values(attacks)) {
        expect(await renderer.render("image/webp", bytes, 160)).toMatchObject({
          ok: false,
          code: "refused",
        });
      }
    },
  );
});

describe("strict walks and the memory budget (review B1, B2)", () => {
  const idat = deflateSync(Buffer.alloc(4 * (1 + 4)));
  const plain = (extra: readonly (readonly [string, Uint8Array])[] = []) =>
    pngFrom([["IHDR", ihdr(4, 4)], ...extra, ["IDAT", idat], ["IEND", new Uint8Array(0)]]);

  it("takes a well-formed PNG", () => {
    expect(planDecode("image/png", plain(), THUMBNAIL_LIMITS)).toMatchObject({
      width: 4,
      height: 4,
    });
    expect(decodeImage("image/png", plain(), THUMBNAIL_LIMITS).data.length).toBe(64);
  });

  it("refuses a second IHDR (pngjs would decode by the last), and every other misplaced chunk", () => {
    const end = ["IEND", new Uint8Array(0)] as const;
    const cases: [string, Buffer, string][] = [
      // B1's file: a small first header, a large second one.
      [
        "second IHDR",
        pngFrom([["IHDR", ihdr(4, 4)], ["IHDR", ihdr(12_000, 12_000)], ["IDAT", idat], end]),
        "png_second_header",
      ],
      [
        "IHDR of 14 bytes",
        pngFrom([["IHDR", Buffer.concat([ihdr(4, 4), Buffer.alloc(1)])], ["IDAT", idat], end]),
        "png_header",
      ],
      ["IDAT first", pngFrom([["IDAT", idat], ["IHDR", ihdr(4, 4)], end]), "png_header"],
      ["data after IEND", Buffer.concat([plain(), Buffer.from("trailing")]), "png_after_end"],
      [
        "chunk after IEND",
        Buffer.concat([plain(), pngFrom([["tEXt", Buffer.from("x")]]).subarray(8)]),
        "png_after_end",
      ],
      [
        "IDAT split by another chunk",
        pngFrom([
          ["IHDR", ihdr(4, 4)],
          ["IDAT", idat],
          ["tEXt", Buffer.from("x")],
          ["IDAT", idat],
          end,
        ]),
        "png_chunk",
      ],
      [
        "palette PNG without PLTE",
        pngFrom([["IHDR", ihdr(4, 4, 8, 3)], ["IDAT", idat], end]),
        "png_palette",
      ],
      [
        "PLTE after IDAT",
        pngFrom([["IHDR", ihdr(4, 4, 8, 3)], ["IDAT", idat], ["PLTE", Buffer.alloc(3)], end]),
        "png_palette",
      ],
      [
        "two PLTE",
        pngFrom([
          ["IHDR", ihdr(4, 4, 8, 3)],
          ["PLTE", Buffer.alloc(3)],
          ["PLTE", Buffer.alloc(3)],
          ["IDAT", idat],
          end,
        ]),
        "png_palette",
      ],
      ["PLTE in a grey PNG", plain([["PLTE", Buffer.alloc(3)]]), "png_palette"],
      ["no IEND", plain().subarray(0, plain().length - 12), "png_truncated"],
      ["8-bit depth 3", pngFrom([["IHDR", ihdr(4, 4, 3)], ["IDAT", idat], end]), "png_header"],
    ];
    for (const [name, bytes, code] of cases) {
      expect(() => planDecode("image/png", bytes, THUMBNAIL_LIMITS), name).toThrow(code);
      expect(() => decodeImage("image/png", bytes, THUMBNAIL_LIMITS), name).toThrow(code);
    }
  });

  it("holds every format to the memory budget, 16-bit PNGs far lower", async () => {
    // 3,000² RGBA: within the pixel limit, but 16-bit costs more than the budget allows.
    const rgba16 = await zeroPng(3000, 3000, 16, 6);
    expect(() => planDecode("image/png", rgba16, THUMBNAIL_LIMITS)).toThrow("too_large");
    const rgba8 = await zeroPng(3000, 3000, 8, 6);
    expect(planDecode("image/png", rgba8, THUMBNAIL_LIMITS).bytes).toBeLessThan(
      DECODE_BUDGET_BYTES,
    );
    // A 7,000² JPEG header (49 MP, within the old pixel limit) is over the budget.
    const jpeg7000 = Buffer.from(makeJpeg(8, 8));
    for (let i = 2; i + 9 < jpeg7000.length;) {
      const marker = jpeg7000[i + 1] ?? 0;
      if (marker === 0xc0) {
        jpeg7000.writeUInt16BE(7000, i + 5);
        jpeg7000.writeUInt16BE(7000, i + 7);
        break;
      }
      i += 2 + jpeg7000.readUInt16BE(i + 2);
    }
    expect(() => planDecode("image/jpeg", jpeg7000, THUMBNAIL_LIMITS)).toThrow("too_large");
  });

  it("walks JPEG markers as jpeg-js reads them, for thumbnails and the view (review B2a)", () => {
    const tricks = jpegSmuggles(600, 400);
    for (const [name, bytes, code] of [
      ["FF 00 then a fake frame in a comment", tricks.ff00Smuggle, "jpeg_marker"],
      ["a fill byte before a marker", tricks.fill, "jpeg_marker"],
      ["a second frame after the scan", tricks.sofAfterScan, "jpeg_second_frame"],
      ["SOF3", tricks.unknownMarker, "jpeg_marker"],
    ] as const) {
      expect(() => planDecode("image/jpeg", bytes, THUMBNAIL_LIMITS), name).toThrow(code);
    }
    // The view's check of the file's start agrees.
    for (const bytes of [tricks.ff00Smuggle, tricks.fill, tricks.unknownMarker]) {
      expect(viewDimensions("image/jpeg", bytes)).toBeUndefined();
    }
    // A fake frame header inside a well-formed comment is just a comment.
    const real = makeJpeg(600, 400);
    const fake = Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    ]);
    const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 2 + fake.length]), fake]);
    const honest = Buffer.concat([real.subarray(0, 2), com, real.subarray(2)]);
    expect(planDecode("image/jpeg", honest, THUMBNAIL_LIMITS)).toMatchObject({
      width: 600,
      height: 400,
    });
    expect(decodeImage("image/jpeg", honest, THUMBNAIL_LIMITS)).toMatchObject({
      width: 600,
      height: 400,
    });
  });

  it("plans lossless WebP for the groups its entropy image names, at libwebp's largest tables (B2b, T-072)", () => {
    // The review's file shape: 1,024² with a group per 4 × 4 block (65,536
    // groups in under 300 KB), which grew a decode by about 400 MiB.
    const attack = vp8lManyGroups(1024, 1024);
    expect(attack.length).toBeLessThan(300 * 1024);
    expect(() => planDecode("image/webp", attack, THUMBNAIL_LIMITS)).toThrow("too_large");
    // The groups are read from the stream: 150² of them at 600², each at
    // kTableSize[0] × 4 bytes (no colour cache), and within the budget.
    const groups = 150 * 150;
    const plan = planDecode("image/webp", vp8lManyGroups(600, 600), THUMBNAIL_LIMITS);
    expect(plan.bytes).toBeGreaterThan(groups * vp8lGroupBytes(0));
    expect(plan.bytes).toBeLessThanOrEqual(DECODE_BUDGET_BYTES);
    // A group with colour-cache bits 11 is planned at 20 KB, not 6.5 (finding 2).
    expect(vp8lGroupBytes(11)).toBeGreaterThan(20_000);
    expect(vp8lGroupBytes(0)).toBeGreaterThan(11_800);
    // The server's header check lets it through; the decoder process's plan doesn't.
    const big = vp8lBigTables();
    expect(() => {
      precheckThumbnail("image/webp", big.subarray(0, THUMBNAIL_HEADER_BYTES), THUMBNAIL_LIMITS);
    }).not.toThrow();
    expect(() => planDecode("image/webp", big, THUMBNAIL_LIMITS)).toThrow("too_large");
  });

  it("reads every group's prefix codes and refuses an incomplete one before libwebp 1.1.0 sees it (CVE-2023-4863)", async () => {
    const bad = vp8lIncompleteCode();
    expect(() => planDecode("image/webp", bad, THUMBNAIL_LIMITS)).toThrow("webp_lossless");
    await expect(decodeAny("image/webp", bad, THUMBNAIL_LIMITS)).rejects.toThrow("webp_lossless");
    // The same file with every code valid is planned.
    expect(planDecode("image/webp", vp8lManyGroups(64, 64), THUMBNAIL_LIMITS).width).toBe(64);
  });

  it("walks WebP strictly: animation chunks, a second frame, chunks out of order", async () => {
    const lossy = await makeWebp(16, 16);
    const frame = lossy.subarray(12);
    const riffOf = (...parts: Buffer[]) => {
      const body = Buffer.concat([Buffer.from("WEBP"), ...parts]);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(body.length);
      return Buffer.concat([Buffer.from("RIFF"), size, body]);
    };
    const chunkOf = (type: string, data: Buffer) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return Buffer.concat([
        Buffer.from(type),
        size,
        data,
        data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
      ]);
    };
    const vp8x = (flags: number) => {
      const d = Buffer.alloc(10);
      d[0] = flags;
      d.writeUIntLE(15, 4, 3);
      d.writeUIntLE(15, 7, 3);
      return chunkOf("VP8X", d);
    };
    expect(planDecode("image/webp", riffOf(vp8x(0), frame), THUMBNAIL_LIMITS)).toMatchObject({
      width: 16,
    });
    for (const [name, bytes, code] of [
      ["ANIM chunk", riffOf(vp8x(0), chunkOf("ANIM", Buffer.alloc(6)), frame), "webp_animated"],
      ["ANMF chunk", riffOf(vp8x(0), chunkOf("ANMF", Buffer.alloc(16))), "webp_animated"],
      ["second frame", riffOf(vp8x(0), frame, frame), "webp_second_frame"],
      [
        "ALPH after the frame",
        riffOf(vp8x(0x10), frame, chunkOf("ALPH", Buffer.alloc(2))),
        "webp_chunk",
      ],
      ["ALPH in a simple file", riffOf(chunkOf("ALPH", Buffer.alloc(2)), frame), "webp_chunk"],
      ["VP8X not first", riffOf(frame, vp8x(0)), "webp_chunk"],
      ["no frame", riffOf(vp8x(0)), "webp_frame"],
    ] as const) {
      expect(() => planDecode("image/webp", bytes, THUMBNAIL_LIMITS), name).toThrow(code);
    }
  });

  it("finds a GIF's full extent from every frame, for the inline view", () => {
    const gif = makeGif(4, 4);
    expect(gifExtent(gif)).toEqual({ width: 4, height: 4 });
    // A frame placed far outside the 4 × 4 screen widens what the browser draws.
    const wide = Buffer.from(gif);
    const at = wide.indexOf(0x2c, 13 + 12);
    wide.writeUInt16LE(30_000, at + 1);
    expect(viewDimensions("image/gif", wide)).toEqual({ width: 30_004, height: 4 });
    // A GIF cut short is not known.
    expect(gifExtent(gif.subarray(0, gif.length - 4))).toBeUndefined();
  });
});

describe("the inline view's checks (review 2)", () => {
  it("counts a GIF's sub-blocks against a cap", () => {
    // One 1 × 1 frame whose data is split into more 1-byte sub-blocks than the cap.
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
      255,
      255,
      255,
    ]);
    const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2]);
    const many = Buffer.alloc(2 * (GIF_MAX_SUB_BLOCKS + 1), Buffer.from([1, 0]));
    const gif = Buffer.concat([head, frame, many, Buffer.from([0, 0x3b])]);
    expect(gifExtent(gif)).toBeUndefined();
    expect(viewDimensions("image/gif", gif)).toBeUndefined();
    expect(gifExtent(makeGif(30, 20))).toEqual({ width: 30, height: 20 });
  });

  it("sizes a WebP longer than what was read from its first chunk", async () => {
    // A 16 × 16 lossy WebP with 2 MiB of metadata after its frame.
    const small = await makeWebp(16, 16);
    const exif = Buffer.concat([Buffer.from("EXIF"), Buffer.alloc(4), Buffer.alloc(2 * MIB)]);
    exif.writeUInt32LE(2 * MIB, 4);
    const big = Buffer.concat([small, exif]);
    big.writeUInt32LE(big.length - 8, 4);
    expect(viewDimensions("image/webp", big.subarray(0, MIB))).toEqual({ width: 16, height: 16 });
    // Read whole, it is walked strictly (and its metadata is allowed).
    expect(viewDimensions("image/webp", big)).toEqual({ width: 16, height: 16 }); // Never a RIFF larger than the stored file (review 3).
    expect(viewDimensions("image/webp", big.subarray(0, MIB), big.length - 1)).toBeUndefined();
    expect(viewDimensions("image/webp", big.subarray(0, MIB), big.length)).toEqual({
      width: 16,
      height: 16,
    });
    // Never an animated VP8X (review 3).
    const vp8x = Buffer.alloc(18);
    vp8x.write("VP8X", 0, "latin1");
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = 0x02;
    vp8x.writeUIntLE(15, 12, 3);
    vp8x.writeUIntLE(15, 15, 3);
    const animated = Buffer.concat([small.subarray(0, 12), vp8x, small.subarray(12), exif]);
    animated.writeUInt32LE(animated.length - 8, 4);
    expect(viewDimensions("image/webp", animated.subarray(0, MIB))).toBeUndefined();
    animated[20] = 0;
    expect(viewDimensions("image/webp", animated.subarray(0, MIB))).toEqual({
      width: 16,
      height: 16,
    });
  });
});

describe("scaling", () => {
  it("fits the box and never scales up", () => {
    expect(fitInBox(4000, 3000, 160)).toEqual({ width: 160, height: 120 });
    expect(fitInBox(300, 6000, 480)).toEqual({ width: 24, height: 480 });
    expect(fitInBox(100, 50, 480)).toEqual({ width: 100, height: 50 });
    expect(fitInBox(10_000, 1, 160)).toEqual({ width: 160, height: 1 });
  });

  it("renders a JPEG thumbnail, transparency on white", async () => {
    const thumb = decodeJpeg(await renderThumbnail("image/png", makePng(640, 320, true), 160));
    expect({ width: thumb.width, height: thumb.height }).toEqual({ width: 160, height: 80 });
    // The right edge was fully transparent: near white.
    const i = (40 * 160 + 159) * 4;
    expect(thumb.data[i]).toBeGreaterThan(230);
    expect(thumb.data[i + 1]).toBeGreaterThan(230);
  });
});

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("the decoder process", () => {
  it("renders in a process of its own and refuses what the decoder refuses", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    const ok = await renderer.render("image/jpeg", makeJpeg(300, 200), 160);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(decodeJpeg(ok.jpeg)).toMatchObject({ width: 160, height: 107 });
    expect(await renderer.render("image/png", makeJpeg(30, 20), 160)).toMatchObject({
      ok: false,
      code: "refused",
    });
    const bombs = await pngBombs(64);
    expect(await renderer.render("image/png", bombs.interlaced, 160)).toMatchObject({
      ok: false,
      code: "refused",
    });
  });

  it("starts a fresh process for every job", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    expect((await renderer.render("image/jpeg", makeJpeg(40, 30), 160)).ok).toBe(true);
    expect((await renderer.render("image/jpeg", jpegSofSlack(), 160)).ok).toBe(false);
    expect((await renderer.render("image/webp", await makeWebp(20, 10), 160)).ok).toBe(true);
    expect((await renderer.render("image/gif", makeGif(20, 10), 160)).ok).toBe(true);
    expect(renderer.processesStarted()).toBe(4);
  });

  it("reads the file from a descriptor it is given, never moved or closed by it", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    const path = join(tmpdir(), `oculus-thumb-test-${String(process.pid)}.jpg`);
    writeFileSync(path, makeJpeg(200, 100));
    const fd = openSync(path, "r");
    try {
      const first = await renderer.render("image/jpeg", { fd }, 160);
      const second = await renderer.render("image/jpeg", { fd }, 160);
      expect(first.ok && second.ok).toBe(true);
      if (first.ok) expect(decodeJpeg(first.jpeg)).toMatchObject({ width: 160, height: 80 });
      // Still open, at its start: read by position only.
      const probe = Buffer.alloc(2);
      expect(readSync(fd, probe, 0, 2, null)).toBe(2);
      expect([...probe]).toEqual([0xff, 0xd8]);
    } finally {
      closeSync(fd);
      rmSync(path, { force: true });
    }
  });

  it("refuses an image a decoder throws on (a RangeError from pngjs), so it is remembered", async () => {
    expect(() => decodeImage("image/png", pngShortTrns(), THUMBNAIL_LIMITS)).toThrow("decode");
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    expect(await renderer.render("image/png", pngShortTrns(), 160)).toMatchObject({
      ok: false,
      code: "refused",
    });
  });

  it("doesn't count a process's start against a job's time limit (review)", async () => {
    const quick = createThumbnailRenderer({ timeoutMs: 400 });
    renderers.push(quick);
    // The first job starts the process, which compiles the WebP decoder first.
    expect((await quick.render("image/webp", await makeWebp(40, 30), 160)).ok).toBe(true);
    expect((await quick.render("image/jpeg", makeJpeg(40, 30), 160)).ok).toBe(true);
    expect(await quick.render("image/webp", vp8lManyGroups(1024, 1024), 160)).toMatchObject({
      ok: false,
      code: "refused",
    });
  });

  it("answers busy past its queue, kills a job past its time limit, and starts again", async () => {
    const renderer = createThumbnailRenderer({ maxQueued: 1, timeoutMs: 1 });
    renderers.push(renderer);
    const big = makeJpeg(1500, 1500);
    const first = renderer.render("image/jpeg", big, 160);
    const second = renderer.render("image/jpeg", big, 160);
    expect(await renderer.render("image/jpeg", big, 160)).toEqual({ ok: false, code: "busy" });
    expect(await first).toEqual({ ok: false, code: "timeout" });
    expect(await second).toEqual({ ok: false, code: "timeout" });
    expect(renderer.processesStarted()).toBe(2);
    const patient = createThumbnailRenderer({ timeoutMs: 20_000 });
    renderers.push(patient);
    expect((await patient.render("image/jpeg", makeJpeg(50, 50), 160)).ok).toBe(true);
    await patient.close();
    expect(await patient.render("image/jpeg", makeJpeg(50, 50), 160)).toEqual({
      ok: false,
      code: "busy",
    });
  });

  it("makes JPEG thumbnails of JPEG, PNG, GIF and WebP (lossy, lossless, alpha), never touching the original", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    const cases: [string, string, Buffer, number, number][] = [
      ["JPEG", "image/jpeg", makeJpeg(320, 240), 160, 120],
      ["PNG", "image/png", makePng(240, 320), 120, 160],
      ["GIF", "image/gif", makeGif(64, 32), 64, 32],
      ["WebP lossy", "image/webp", await makeWebp(640, 360), 160, 90],
      ["WebP lossless", "image/webp", await makeWebp(300, 300, { lossless: true }), 160, 160],
      ["WebP alpha", "image/webp", await makeWebp(400, 200, { alpha: true }), 160, 80],
    ];
    for (const [name, format, bytes, width, height] of cases) {
      const before = sha(bytes);
      const result = await renderer.render(format, bytes, 160);
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      // A baseline JPEG, whatever the original was.
      expect([...result.jpeg.subarray(0, 3)], name).toEqual([0xff, 0xd8, 0xff]);
      expect(decodeJpeg(result.jpeg), name).toMatchObject({ width, height });
      // The original is unchanged (a WebP stays the WebP it was).
      expect(sha(bytes), name).toBe(before);
    }
    // The alpha WebP's transparent right edge is white in its thumbnail.
    const alpha = await renderer.render("image/webp", await makeWebp(40, 30, { alpha: true }), 160);
    if (alpha.ok) expect(decodeJpeg(alpha.jpeg).data[(10 * 40 + 39) * 4]).toBeGreaterThan(230);
  });
});

const MIB = 1024 * 1024;

/** The four repros of the third review (D-097), built in code. */
async function repros(): Promise<[string, string, Buffer, string][]> {
  return [
    ["A: DRI slack hiding a 3,800² frame", "image/jpeg", jpegDriSlack(), "jpeg_segment"],
    ["B: SOF slack hiding a 5,000² frame", "image/jpeg", jpegSofSlack(), "jpeg_segment"],
    ["C: VP8L, a group a block, cache bits 11", "image/webp", vp8lBigTables(), "too_large"],
    ["D: VP8L-compressed ALPH in lossy WebP", "image/webp", await alphBigTables(), "too_large"],
  ];
}

describe("a decoder process that can't start (review 2, B1)", () => {
  it("answers failed when the spawn throws (ENOMEM), and the next job still runs", async () => {
    let calls = 0;
    const renderer = createThumbnailRenderer({
      spawn: (options) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("spawn ENOMEM"), { code: "ENOMEM" });
        return spawnDecoder(options);
      },
    });
    renderers.push(renderer);
    expect(await renderer.render("image/jpeg", makeJpeg(40, 30), 160)).toEqual({
      ok: false,
      code: "failed",
    });
    expect((await renderer.render("image/jpeg", makeJpeg(40, 30), 160)).ok).toBe(true);
  });

  it("answers failed for a child with no stdio that reports EMFILE, never crashing, then pauses (review 3)", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const renderer = createThumbnailRenderer({
      now: () => clock,
      spawn: (options) => {
        calls++;
        if (calls > 1) return spawnDecoder(options);
        // What Node gives when the spawn fails for want of descriptors:
        // no process ID, no stdio, an 'error' event a moment later.
        const fake = Object.assign(new EventEmitter(), {
          pid: undefined,
          stdio: undefined,
          kill: () => false,
        });
        setImmediate(() =>
          fake.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })),
        );
        return fake as unknown as ChildProcess;
      },
    });
    renderers.push(renderer);
    expect(await renderer.render("image/png", makePng(20, 20), 160)).toEqual({
      ok: false,
      code: "failed",
    });
    // For a minute no process is started: busy at once.
    clock += DESCRIPTOR_PAUSE_MS - 1;
    expect(await renderer.render("image/png", makePng(20, 20), 160)).toEqual({
      ok: false,
      code: "busy",
    });
    expect(calls).toBe(1);
    clock += 2;
    expect((await renderer.render("image/png", makePng(20, 20), 160)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("starts no process with too few descriptors free (review 3)", async () => {
    const renderer = createThumbnailRenderer({ minFreeDescriptors: Number.MAX_SAFE_INTEGER });
    renderers.push(renderer);
    expect(await renderer.render("image/jpeg", makeJpeg(20, 10), 160)).toEqual({
      ok: false,
      code: "busy",
    });
    expect(renderer.processesStarted()).toBe(0);
  });

  it("answers failed, not lost, for a process that dies before its watchdog took the job (review 3)", async () => {
    const renderer = createThumbnailRenderer({
      spawn: (options) => {
        const child = spawnDecoder(options);
        // Killed while still starting (it takes some 300 ms to be ready).
        setTimeout(() => child.kill("SIGKILL"), 30);
        return child;
      },
    });
    renderers.push(renderer);
    expect(await renderer.render("image/jpeg", makeJpeg(20, 10), 160)).toEqual({
      ok: false,
      code: "failed",
    });
  });

  it("answers failed when the bytes can't be written for it, and keeps going", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), "no-such-folder-for-oculus");
    try {
      expect(await renderer.render("image/jpeg", makeJpeg(40, 30), 160)).toEqual({
        ok: false,
        code: "failed",
      });
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect((await renderer.render("image/jpeg", makeJpeg(40, 30), 160)).ok).toBe(true);
  });

  it("answers lost, not killed, for a SIGKILL nothing confirmed as the cap (review 2)", async () => {
    let child: ChildProcess | undefined;
    const renderer = createThumbnailRenderer({
      spawn: (options) => (child = spawnDecoder(options)),
    });
    renderers.push(renderer);
    const pending = renderer.render("image/jpeg", flatJpeg(2480, 2480), 160);
    // Killed from outside (as the system's out-of-memory killer would) once
    // the decode is well under way (100 MiB over its start-up size).
    let start: number | undefined;
    for (let k = 0; k < 5000; k++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const rss = child?.pid === undefined ? undefined : procMemory(child.pid)?.rss;
      if (rss === undefined) continue;
      start ??= rss;
      if (rss - start > 100 * MIB) break;
    }
    child?.kill("SIGKILL");
    expect(await pending).toMatchObject({ ok: false, code: "lost" });
    // Not retried: only a confirmed kill is.
    expect(renderer.processesStarted()).toBe(1);
  });

  it("ends a job past its deadline from inside the process, without the parent (review 2)", async () => {
    const file = join(tmpdir(), `oculus-deadline-${String(process.pid)}.jpg`);
    writeFileSync(file, flatJpeg(2480, 2480));
    const fd = openSync(file, "r");
    try {
      const child = spawnDecoder({
        fd,
        killAt: DECODE_MEMORY_CAP_BYTES - KILL_HEADROOM_BYTES,
        heapMiB: 384,
      });
      const pipe = (child.stdio as readonly unknown[])[DECODER_MARKER_FD] as NodeJS.ReadableStream;
      let report = "";
      pipe.on("data", (c: Buffer) => {
        report += c.toString();
      });
      let sentAt = 0;
      child.on("message", (message: { ready?: boolean }) => {
        if (message.ready === true) {
          sentAt = Date.now();
          child.send({ id: 1, format: "image/jpeg", box: 160, timeoutMs: 200 });
        }
      });
      const [, signal] = await new Promise<[number | null, string | null]>((resolve) =>
        child.on("close", (code, sig) => {
          resolve([code, sig]);
        }),
      );
      expect(signal).toBe("SIGKILL");
      expect(report.startsWith("timeout")).toBe(true);
      expect(Date.now() - sentAt).toBeLessThan(1000);
    } finally {
      closeSync(fd);
      rmSync(file, { force: true });
    }
  });
});

describe("the third review's repros (T-072)", () => {
  it("refuses each one by its plan, and in the decoder process", { timeout: 120_000 }, async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    for (const [name, format, bytes, code] of await repros()) {
      expect(() => planDecode(format, bytes, THUMBNAIL_LIMITS), name).toThrow(code);
      const result = await renderer.render(format, bytes, 160);
      expect(result, name).toMatchObject({ ok: false, code: "refused" });
      // Refused from the plan: the process barely grew.
      expect(result.peakBytes ?? 0, name).toBeLessThan(64 * MIB);
    }
    // A fresh process after each refusal.
    expect(renderer.processesStarted()).toBe(4);
  });

  it(
    "kills each one under the memory cap when the plan is skipped, the peak within the cap",
    { timeout: 300_000 },
    async () => {
      // One at a time: each would take 550 MiB to 1 GiB uncapped.
      const peaks: string[] = [];
      for (const [name, format, bytes] of await repros()) {
        const renderer = createThumbnailRenderer({ check: "unplanned", timeoutMs: 60_000 });
        renderers.push(renderer);
        const result = await renderer.render(format, bytes, 160);
        expect(result, name).toMatchObject({ ok: false, code: "killed" });
        peaks.push(`${name}: ${String(Math.round((result.peakBytes ?? 0) / MIB))} MiB`);
        expect(result.peakBytes, name).toBeGreaterThan(DECODE_MEMORY_CAP_BYTES / 2);
        expect(result.peakBytes, name).toBeLessThanOrEqual(DECODE_MEMORY_CAP_BYTES);
        // Killed twice (a kill is tried once more in a fresh process before it counts).
        expect(renderer.processesStarted(), name).toBe(2);
        expect((await renderer.render("image/jpeg", makeJpeg(30, 20), 160)).ok, name).toBe(true);
        await renderer.close();
      }
      process.stdout.write(`Killed at: ${peaks.join("; ")}\n`);
    },
  );

  it(
    "holds the cap by the process's own watchdog alone (the parent not watching)",
    { timeout: 300_000 },
    async () => {
      const peaks: string[] = [];
      const all = await repros();
      for (const [name, format, bytes] of [all[0], all[3]].filter((r) => r !== undefined)) {
        const renderer = createThumbnailRenderer({ check: "unplanned", parentWatch: false });
        renderers.push(renderer);
        const result = await renderer.render(format, bytes, 160);
        // The watchdog's own report gives the peak.
        expect(result, name).toMatchObject({ ok: false, code: "killed" });
        peaks.push(`${name}: ${String(Math.round((result.peakBytes ?? 0) / MIB))} MiB`);
        expect(result.peakBytes, name).toBeGreaterThan(DECODE_MEMORY_CAP_BYTES / 2);
        expect(result.peakBytes, name).toBeLessThanOrEqual(DECODE_MEMORY_CAP_BYTES);
        await renderer.close();
      }
      process.stdout.write(`Watchdog alone killed at: ${peaks.join("; ")}\n`);
    },
  );

  it(
    "holds the cap while the server's event loop is blocked for a second at a time (review B1)",
    { timeout: 300_000 },
    async () => {
      const [, format, bytes] = (await repros())[3] ?? [];
      const renderer = createThumbnailRenderer({ check: "unplanned", timeoutMs: 120_000 });
      renderers.push(renderer);
      let done: Awaited<ReturnType<typeof renderer.render>> | undefined;
      void renderer.render(format ?? "", bytes ?? Buffer.alloc(0), 160).then((r) => {
        done = r;
      });
      // The parent's sampler can't run while this loop spins; the watchdog can.
      while (done === undefined) {
        const until = Date.now() + 1000;
        while (Date.now() < until) {
          // Blocked.
        }
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const result = done;
      process.stdout.write(
        `Parent blocked, killed at: ${String(Math.round((result.peakBytes ?? 0) / MIB))} MiB\n`,
      );
      expect(result).toMatchObject({ ok: false, code: "killed" });
      expect(result.peakBytes).toBeLessThanOrEqual(DECODE_MEMORY_CAP_BYTES);
    },
  );

  it(
    "ends a decoder process whose parent died mid-decode (review B1)",
    { timeout: 120_000 },
    async () => {
      // A stand-in server: starts a decoder on a slow, legal decode, says its
      // process ID once the job is sent, then is killed.
      const dir = tmpdir();
      const file = join(dir, `oculus-orphan-${String(process.pid)}.jpg`);
      writeFileSync(file, flatJpeg(2480, 2480));
      const worker = fileURLToPath(new URL("./thumbnail-worker.ts", import.meta.url));
      const script = `
        const m = await import(${JSON.stringify(worker)});
        const { openSync } = await import("node:fs");
        const child = m.spawnDecoder({ fd: openSync(${JSON.stringify(file)}, "r"), killAt: m.DECODE_MEMORY_CAP_BYTES - m.KILL_HEADROOM_BYTES, heapMiB: 384 });
        child.on("message", (message) => {
          if (message.ready) {
            child.send({ id: 1, format: "image/jpeg", box: 160 });
            process.stdout.write(String(child.pid) + "\\n");
          }
        });
      `;
      const server = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "" },
      });
      try {
        const pid = await new Promise<number>((resolve, reject) => {
          let out = "";
          server.stdout.on("data", (c: Buffer) => {
            out += c.toString();
            if (out.includes("\n")) resolve(Number(out.trim()));
          });
          server.on("exit", () => {
            reject(new Error("the stand-in server ended first"));
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        // Alive: there, and not a zombie waiting to be reaped.
        const alive = (): boolean => {
          try {
            return !/^State:\s*Z/m.test(readFileSync(`/proc/${String(pid)}/status`, "latin1"));
          } catch {
            return false;
          }
        };
        expect(alive()).toBe(true);
        server.kill("SIGKILL");
        const killedAt = Date.now();
        while (alive() && Date.now() - killedAt < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const gone = Date.now() - killedAt;
        process.stdout.write(`Orphaned decoder gone after ${String(gone)} ms\n`);
        // Its watchdog sees the parent gone within a few milliseconds; the
        // decode alone would take far longer.
        expect(alive()).toBe(false);
        expect(gone).toBeLessThan(500);
      } finally {
        server.kill("SIGKILL");
        rmSync(file, { force: true });
      }
    },
  );
});

describe("walk bombs: the server reads only a header (review of T-072, B2)", () => {
  it(
    "keeps the server's event loop free and its memory flat; each is refused in the decoder process",
    { timeout: 600_000 },
    async () => {
      const cases: [string, string, () => Promise<Buffer> | Buffer, string][] = [
        ["J1: 17 million DRI segments", "image/jpeg", () => jpegManyDri(), "refused"],
        ["P1: 8.7 million empty IDAT chunks", "image/png", () => pngEmptyIdats(), "refused"],
        ["P2: 8.7 million empty tEXt chunks", "image/png", () => pngEmptyTexts(), "refused"],
        ["W1: 13 million unknown WebP chunks", "image/webp", () => webpManyChunks(), "refused"],
        ["G1: 6.6 million 1 × 1 GIF frames", "image/gif", () => gifManyFrames(), "refused"],
      ];
      const lines: string[] = [];
      for (const [name, format, make, code] of cases) {
        const path = join(tmpdir(), `oculus-walk-bomb-${String(process.pid)}`);
        {
          const bytes = await make();
          expect(bytes.length, name).toBeGreaterThan(99 * MIB);
          writeFileSync(path, bytes);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const fd = openSync(path, "r");
        try {
          const before = process.memoryUsage.rss();
          const delay = monitorEventLoopDelay({ resolution: 10 });
          delay.enable();
          // What the server does (files.ts): the header, then the descriptor.
          const head = Buffer.alloc(THUMBNAIL_HEADER_BYTES);
          readSync(fd, head, 0, head.length, 0);
          let result: { ok: boolean; code?: string; peakBytes?: number } | undefined;
          try {
            precheckThumbnail(format, head, THUMBNAIL_LIMITS);
          } catch {
            result = { ok: false, code: "refused" };
          }
          if (result === undefined) {
            const renderer = createThumbnailRenderer();
            renderers.push(renderer);
            result = await renderer.render(format, { fd }, 160);
          }
          delay.disable();
          const grew = process.memoryUsage.rss() - before;
          const worst = delay.max / 1e6;
          lines.push(
            `${name}: ${result.ok ? "made" : String(result.code)}, event loop delay max ${worst.toFixed(0)} ms, server RSS ${grew >= 0 ? "+" : ""}${String(Math.round(grew / MIB))} MiB, decoder ${String(Math.round((result.peakBytes ?? 0) / MIB))} MiB`,
          );
          expect(result, name).toMatchObject({ ok: false, code });
          expect(worst, name).toBeLessThan(100);
          expect(grew, name).toBeLessThan(32 * MIB);
        } finally {
          closeSync(fd);
          rmSync(path, { force: true });
        }
      }
      process.stdout.write(`Walk bombs: ${lines.join("; ")}\n`);
    },
  );

  it("refuses each in the plan as soon as its count passes the limit", async () => {
    for (const [name, format, bytes, code] of [
      ["J1", "image/jpeg", jpegManyDri(1_000_000), "jpeg_segments"],
      ["P1", "image/png", pngEmptyIdats(1_000_000), "png_chunk"],
      ["P2", "image/png", pngEmptyTexts(1_000_000), "png_chunks"],
      ["W1", "image/webp", await webpManyChunks(1_000_000), "webp_chunks"],
      ["G1", "image/gif", gifManyFrames(1_000_000), "gif_blocks"],
    ] as const) {
      expect(() => planDecode(format, bytes, THUMBNAIL_LIMITS), name).toThrow(code);
    }
    // Small ones of the same shapes are real images.
    expect(planDecode("image/png", pngEmptyTexts(4000), THUMBNAIL_LIMITS).width).toBe(8);
    expect(planDecode("image/gif", gifManyFrames(4000), THUMBNAIL_LIMITS).width).toBe(1);
  });
});

describe("peak memory of the largest images accepted (review B2, T-072)", () => {
  it(
    "keeps each decode's peak, measured in the decoder process, under its plan and the cap",
    { timeout: 600_000 },
    async () => {
      const cases: [string, string, () => Promise<Buffer> | Buffer][] = [
        ["JPEG 2,480² (4:4:4)", "image/jpeg", () => flatJpeg(2480, 2480)],
        ["PNG RGBA16 2,660² (noise)", "image/png", () => noisePng(2660, 2660, 16)],
        ["PNG RGBA8 3,700² (noise)", "image/png", () => noisePng(3700, 3700)],
        ["GIF 5,240²", "image/gif", () => makeGif(5240, 5240)],
        ["WebP lossy 4,650²", "image/webp", () => makeWebp(4650, 4650)],
        ["WebP lossless 2,500²", "image/webp", () => makeWebp(2500, 2500, { lossless: true })],
        // The second review's shape at the largest size accepted: a group per 4 × 4 block.
        ["WebP lossless 616², 23,716 groups", "image/webp", () => vp8lManyGroups(616, 616)],
        // Repros C and D's shapes at the largest sizes accepted.
        ["WebP lossless 476², cache bits 11", "image/webp", () => vp8lBigTables(476)],
        ["WebP lossy 476², VP8L alpha", "image/webp", () => alphBigTables(476)],
      ];
      const peaks: string[] = [];
      for (const [name, format, make] of cases) {
        const bytes = await make();
        const plan = planDecode(format, bytes, THUMBNAIL_LIMITS);
        expect(plan.bytes, name).toBeLessThanOrEqual(DECODE_BUDGET_BYTES);
        // A fresh decoder process for each, so each baseline is its own.
        const renderer = createThumbnailRenderer({ timeoutMs: 120_000 });
        const result = await renderer.render(format, bytes, 160);
        await renderer.close();
        expect(result.ok, name).toBe(true);
        const growth = result.peakBytes ?? Number.NaN;
        peaks.push(
          `${name}: ${String(Math.round(growth / MIB))} MiB (plan ${String(Math.round(plan.bytes / MIB))} MiB)`,
        );
        // The plan is an upper bound, and the cap is never near.
        expect(growth, name).toBeLessThan(plan.bytes);
        expect(growth, name).toBeLessThan(DECODE_MEMORY_CAP_BYTES);
      }
      process.stdout.write(`Peak RSS growth: ${peaks.join("; ")}\n`);
    },
  );
});
