// Thumbnails (M-003, D-097): reading sizes from headers as the format
// named, the limits, decoding JPEG, PNG and GIF and refusing everything
// else, decompression bombs refused before or at the inflate ceiling, the
// scaling, and the worker's queue, time limit and closing. Every image is
// invented (images.fixtures.ts).
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  THUMBNAIL_LIMITS,
  VIEW_LIMITS,
  DECODE_BUDGET_BYTES,
  decodeAny,
  decodeImage,
  gifExtent,
  planDecode,
  viewDimensions,
  fitInBox,
  imageDimensions,
  renderThumbnail,
  withinLimits,
} from "./thumbnail-worker.js";
import { createThumbnailRenderer } from "./thumbnails.js";
import {
  decodeJpeg,
  gifFrameOutside,
  hugeGif,
  hugeJpeg,
  makeGif,
  makeJpeg,
  makePng,
  pngBombs,
  pngOf,
  ihdr,
  makeWebp,
  pngFrom,
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
    "renders WebP thumbnails in the worker and refuses the attacks there",
    { timeout: 60_000 },
    async () => {
      const renderer = createThumbnailRenderer();
      renderers.push(renderer);
      const ok = await renderer.render("image/webp", await makeWebp(640, 480), 160);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(decodeJpeg(ok.jpeg)).toMatchObject({ width: 160, height: 120 });
      // Over 4 megapixels: rendered, then the worker (its WebAssembly memory
      // grown) is replaced, and the next job still works.
      const large = await renderer.render("image/webp", await makeWebp(2100, 2000), 160);
      expect(large.ok).toBe(true);
      expect((await renderer.render("image/webp", await makeWebp(50, 50), 160)).ok).toBe(true);
      const attacks = await webpAttacks();
      for (const bytes of Object.values(attacks)) {
        expect(await renderer.render("image/webp", bytes, 160)).toEqual({
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

describe("the worker", () => {
  it("renders in a worker and refuses what the decoder refuses", async () => {
    const renderer = createThumbnailRenderer();
    renderers.push(renderer);
    const ok = await renderer.render("image/jpeg", makeJpeg(300, 200), 160);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(decodeJpeg(ok.jpeg)).toMatchObject({ width: 160, height: 107 });
    expect(await renderer.render("image/png", makeJpeg(30, 20), 160)).toEqual({
      ok: false,
      code: "refused",
    });
    const bombs = await pngBombs(64);
    expect(await renderer.render("image/png", bombs.interlaced, 160)).toEqual({
      ok: false,
      code: "refused",
    });
  });

  it("answers busy past its queue, stops a job past its time limit, and starts again", async () => {
    const renderer = createThumbnailRenderer({ maxQueued: 1, timeoutMs: 1 });
    renderers.push(renderer);
    const big = makeJpeg(1500, 1500);
    const first = renderer.render("image/jpeg", big, 160);
    const second = renderer.render("image/jpeg", big, 160);
    expect(await renderer.render("image/jpeg", big, 160)).toEqual({ ok: false, code: "busy" });
    expect(await first).toEqual({ ok: false, code: "timeout" });
    expect(await second).toEqual({ ok: false, code: "timeout" });
    const patient = createThumbnailRenderer({ timeoutMs: 20_000 });
    renderers.push(patient);
    expect((await patient.render("image/jpeg", makeJpeg(50, 50), 160)).ok).toBe(true);
    await patient.close();
    expect(await patient.render("image/jpeg", makeJpeg(50, 50), 160)).toEqual({
      ok: false,
      code: "busy",
    });
  });
});

/** The peak RSS growth while `run` runs, sampled every 10 ms. */
async function peakGrowth(run: () => Promise<unknown>): Promise<number> {
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  return peak - base;
}

describe("peak memory of the largest images accepted (review B2)", () => {
  const MIB = 1024 * 1024;
  it("keeps each decode's peak well under 512 MiB", { timeout: 300_000 }, async () => {
    const cases: [string, string, () => Promise<Buffer> | Buffer][] = [
      ["JPEG 2,780²", "image/jpeg", () => makeJpeg(2780, 2780)],
      ["PNG RGBA16 2,800²", "image/png", () => zeroPng(2800, 2800, 16, 6)],
      ["PNG RGBA8 3,900²", "image/png", () => zeroPng(3900, 3900, 8, 6)],
      ["GIF 5,500²", "image/gif", () => makeGif(5500, 5500)],
      ["WebP lossy 4,900²", "image/webp", () => makeWebp(4900, 4900)],
      ["WebP lossless 4,300²", "image/webp", () => makeWebp(4300, 4300, { lossless: true })],
    ];
    const peaks: string[] = [];
    const outcomes: [string, boolean, number][] = [];
    for (const [name, format, make] of cases) {
      const bytes = await make();
      const plan = planDecode(format, bytes, THUMBNAIL_LIMITS);
      expect(plan.bytes, name).toBeLessThanOrEqual(DECODE_BUDGET_BYTES);
      const renderer = createThumbnailRenderer({ timeoutMs: 120_000 });
      // The worker started and its decoders loaded first (a fixed cost of
      // some 40 MiB, paid once): the growth below is the decode's own.
      await renderer.render("image/png", makePng(4, 4), 160);
      await renderer.render("image/webp", await makeWebp(4, 4), 160);
      let result: Awaited<ReturnType<typeof renderer.render>> | undefined;
      const growth = await peakGrowth(async () => {
        result = await renderer.render(format, bytes, 160);
      });
      await renderer.close();
      outcomes.push([name, result?.ok === true, growth]);
      peaks.push(
        `${name}: ${String(Math.round(growth / MIB))} MiB (budget ${String(Math.round(plan.bytes / MIB))} MiB)`,
      );
    }
    console.log(`Peak RSS growth: ${peaks.join("; ")}`);
    for (const [name, ok, growth] of outcomes) {
      expect(ok, name).toBe(true);
      expect(growth, name).toBeLessThan(400 * MIB);
    }
  });
});
