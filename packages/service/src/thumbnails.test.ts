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
  decodeImage,
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

describe("scaling", () => {
  it("fits the box and never scales up", () => {
    expect(fitInBox(4000, 3000, 160)).toEqual({ width: 160, height: 120 });
    expect(fitInBox(300, 6000, 480)).toEqual({ width: 24, height: 480 });
    expect(fitInBox(100, 50, 480)).toEqual({ width: 100, height: 50 });
    expect(fitInBox(10_000, 1, 160)).toEqual({ width: 160, height: 1 });
  });

  it("renders a JPEG thumbnail, transparency on white", () => {
    const thumb = decodeJpeg(renderThumbnail("image/png", makePng(640, 320, true), 160));
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
