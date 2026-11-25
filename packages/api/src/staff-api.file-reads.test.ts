// Reading files (M-003, T-072, D-097) over real HTTP against a fresh migrated
// database and a throwaway files folder: who may download, view and get
// thumbnails (identical 404s for hidden, other-site, other-organization and
// missing records and files); every type downloads as octet-stream, polyglots
// included; inline only for sniffed JPEG, PNG, GIF and WebP; Content-
// Disposition with awkward names; decompression bombs refused without a
// memory blow-up (the third review's repros among them, and a decode killed
// at the memory cap remembered); a thumbnail cache that can't be poisoned across
// organizations; the sweep taking thumbnails with their bytes; and no file
// names in any log. Every person, record, name and pixel is invented.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import { endSession, sql } from "@oculus/db";
import {
  createService,
  createThumbnailRenderer,
  openFileStore,
  type FileStore,
  type ThumbnailRenderer,
} from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { safeFileName } from "./file-replies.js";
import { buildServer } from "./server.js";
import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  FILE_TYPE_HEADER,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import {
  INC,
  fullSession,
  makeAs,
  makeWorld,
  pendingSession,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";
import {
  alphBigTables,
  decodeJpeg,
  hugeGif,
  hugeJpeg,
  makeGif,
  makeJpeg,
  makePng,
  pngBombs,
  jpegDriSlack,
  jpegSmuggles,
  jpegSofSlack,
  makeWebp,
  vp8lBigTables,
  vp8lManyGroups,
  webpAttacks,
  webpHeader,
} from "../../service/src/images.fixtures.js";

const ORIGIN = "http://localhost";
const MAX_FILE = 64 * 1024 * 1024;

let w: World;
let filesDir: string;
let store: FileStore;
let renderer: ThumbnailRenderer;
let app: FastifyInstance;
let base: { host: string; port: number };
const logged: ApiLogRecord[] = [];
const serverLog: string[] = [];
const tokens: Record<string, string> = {};

const assetDraft = (title: string) => ({
  kind: "digital_asset",
  mediaType: "image/jpeg",
  title,
  templateKey: "t-asset",
  fields: { rights: { uri: INC } },
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: Record<string, unknown>;
}

function send(
  path: string,
  s: {
    as?: string;
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
    to?: { host: string; port: number };
  } = {},
): Promise<Reply> {
  const method = s.method ?? "GET";
  const token = s.as === undefined ? undefined : tokens[s.as];
  const headers: Record<string, string> = { host: "localhost", origin: ORIGIN, ...s.headers };
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if (method !== "GET" && method !== "HEAD" && token !== undefined) {
    headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  }
  if (s.body !== undefined) headers["content-length"] = String(s.body.length);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: (s.to ?? base).host, port: (s.to ?? base).port, method, path, headers, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          const body = Buffer.concat(parts);
          const text = body.toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(s.body);
  });
}

/** Uploads bytes to an asset as someone; returns the file's ID. */
async function add(
  asset: string,
  body: Buffer,
  name: string,
  as = "cataloger",
  claimed?: string,
): Promise<string> {
  const r = await send(`/api/records/${asset}/files`, {
    as,
    method: "POST",
    body,
    headers: {
      "content-type": "application/octet-stream",
      "if-match": '"v1"',
      [FILE_NAME_HEADER]: encodeURIComponent(name),
      ...(claimed === undefined ? {} : { [FILE_TYPE_HEADER]: claimed }),
    },
  });
  expect([200, 201], r.text).toContain(r.status);
  return (r.json.file as { id: string }).id;
}

const fileUrl = (asset: string, file: string, what: string) =>
  `/api/records/${asset}/files/${file}/${what}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const JPEG = makeJpeg(640, 480);
const PNG = makePng(300, 600);
const GIF = makeGif(40, 30);
/** A real lossy WebP (made in beforeAll). */
let WEBP: Buffer;
const ACTIVE: Record<string, Buffer> = {
  html: Buffer.from("<!doctype html><title>invented</title><script>alert(1)</script>"),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  pdf: Buffer.from("%PDF-1.4\n% invented\n1 0 obj << /JS (alert(1)) >> endobj\n%%EOF\n"),
  polyglot: Buffer.from("GIF89a<script>alert(1)</script><html><body>invented</body></html>"),
  text: Buffer.from("invented-content-marker plain text"),
};

const ids: Record<string, string> = {};
const fileIds: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld();
  filesDir = mkdtempSync(join(tmpdir(), "oculus-file-reads-"));
  store = await openFileStore({ dir: filesDir, maxFileBytes: MAX_FILE });
  // This test database's own folder (D-086): bound while it is empty.
  expect(await createService(w.db, { files: store }).bindFileStore()).toEqual({ ok: true });
  renderer = createThumbnailRenderer();
  const service = createService(w.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files: store,
    thumbnails: renderer,
    thumbnailLimits: { perMinute: 10_000 },
  });
  app = await buildServer({
    env: { OCULUS_ORIGINS: ORIGIN },
    logger: { stream: { write: (line: string) => serverLog.push(line) } },
    routes: staffApiRoutes({
      db: w.db,
      service,
      files: store,
      log: (r) => logged.push(r),
      rateLimits: { write: 10_000, read: 10_000 },
    }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  base = { host: address.address, port: address.port };
  const scanner: UserId = await w.member(w.a, "Scanner");
  await grant(w.service, w.root, w.a, { userId: scanner, role: "scanner", siteId: w.a1 });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("reader", w.reader, w.a);
  await make("other", w.other, w.a);
  await make("stranger", w.stranger, w.b);
  await make("donor", w.donor, w.a);
  await make("scanner", scanner, w.a);
  tokens.pending = (await pendingSession(w.db, w.cataloger, w.a)).token;
  ids.a1 = await makeAs(w, w.a, w.a1, assetDraft("An invented photograph"));
  ids.a2 = await makeAs(w, w.a, w.a2, assetDraft("An invented second-site photograph"));
  ids.b1 = await makeAs(w, w.b, w.b1, assetDraft("An invented library photograph"));
  fileIds.jpeg = await add(ids.a1, JPEG, "depot photograph.jpg");
  fileIds.png = await add(ids.a1, PNG, "map.png");
  fileIds.gif = await add(ids.a1, GIF, "banner.gif");
  WEBP = await makeWebp(800, 600);
  fileIds.webp = await add(ids.a1, WEBP, "sky.webp");
  for (const [kind, bytes] of Object.entries(ACTIVE)) {
    // Each claims to be a PNG and is named like one: neither counts.
    fileIds[kind] = await add(ids.a1, bytes, `invented-${kind}.png`, "cataloger", "image/png");
  }
  fileIds.a2 = await add(ids.a2, makeJpeg(20, 20), "second site.jpg", "other");
  fileIds.b1 = await add(ids.b1, makeJpeg(21, 21), "library.jpg", "stranger");
}, 120_000);

/** Servers of the tests below with their own limits; closed at the end. */
const extra: { close(): Promise<unknown> }[] = [];

async function serveAlso(
  serviceOptions: Partial<Parameters<typeof createService>[1]>,
  downloads?: {
    perSession?: number;
    perUser?: number;
    minBytes?: number;
    windowMs?: number;
    sessionCheckMs?: number;
  },
): Promise<{ host: string; port: number }> {
  const service = createService(w.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files: store,
    ...serviceOptions,
  });
  const other = await buildServer({
    env: { OCULUS_ORIGINS: ORIGIN },
    logger: { stream: { write: (line: string) => serverLog.push(line) } },
    routes: staffApiRoutes({
      db: w.db,
      service,
      files: store,
      log: (r) => logged.push(r),
      rateLimits: { write: 10_000, read: 10_000 },
      ...(downloads === undefined ? {} : { downloads }),
    }),
  });
  await other.listen({ host: "127.0.0.1", port: 0 });
  extra.push(other);
  const address = other.server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

afterAll(async () => {
  for (const server of extra) await server.close();
  await app.close();
  await renderer.close();
  await w.db.close();
  await w.testDb.drop();
  rmSync(filesDir, { recursive: true, force: true });
});

/** What a refusal sends that could tell two refusals apart. */
const shape = (r: Reply) => ({
  status: r.status,
  text: r.text,
  type: r.headers["content-type"],
  length: r.headers["content-length"],
  disposition: r.headers["content-disposition"],
  etag: r.headers.etag,
});

describe("who may read a file", () => {
  it("needs a full session", async () => {
    for (const what of ["content", "view", "thumbnail"]) {
      const url = fileUrl(ids.a1 ?? "", fileIds.jpeg ?? "", what);
      expect((await send(url)).status).toBe(401);
      expect((await send(url, { as: "pending" })).status).toBe(401);
    }
  });

  it("follows the view permission by role and site, on every route", async () => {
    const table: [string, string, string, number][] = [
      ["root", "a1", "jpeg", 200],
      ["manager", "a1", "jpeg", 200],
      ["cataloger", "a1", "jpeg", 200],
      ["reader", "a1", "jpeg", 200],
      ["scanner", "a1", "jpeg", 200],
      ["donor", "a1", "jpeg", 404],
      ["other", "a1", "jpeg", 404],
      ["stranger", "a1", "jpeg", 404],
      ["other", "a2", "a2", 200],
      ["cataloger", "a2", "a2", 404],
      ["stranger", "b1", "b1", 200],
      ["root", "b1", "b1", 404],
    ];
    for (const [who, asset, file, status] of table) {
      for (const what of ["content", "view", "thumbnail"]) {
        const r = await send(fileUrl(ids[asset] ?? "", fileIds[file] ?? "", what), { as: who });
        expect(r.status, `${who} ${what} ${asset}`).toBe(status);
      }
    }
  });

  it("answers hidden, other-site, other-organization and missing records and files byte for byte alike", async () => {
    for (const what of ["content", "view", "thumbnail?size=medium"]) {
      const replies = [
        // A record out of sight (another site's), another organization's, a missing one.
        await send(fileUrl(ids.a2 ?? "", fileIds.a2 ?? "", what), { as: "cataloger" }),
        await send(fileUrl(ids.b1 ?? "", fileIds.b1 ?? "", what), { as: "cataloger" }),
        await send(fileUrl(newRecordId(), fileIds.jpeg ?? "", what), { as: "cataloger" }),
        await send(fileUrl("not-an-id", fileIds.jpeg ?? "", what), { as: "cataloger" }),
        // A visible record and a file it doesn't have: another asset's, another
        // organization's, a missing one, a malformed one.
        await send(fileUrl(ids.a1 ?? "", fileIds.a2 ?? "", what), { as: "cataloger" }),
        await send(fileUrl(ids.a1 ?? "", fileIds.b1 ?? "", what), { as: "cataloger" }),
        await send(fileUrl(ids.a1 ?? "", newRecordId(), what), { as: "cataloger" }),
        await send(fileUrl(ids.a1 ?? "", "1234", what), { as: "cataloger" }),
      ];
      const [head] = replies;
      if (head === undefined) throw new Error("no replies");
      const first = shape(head);
      expect(first.status).toBe(404);
      expect(first.text).toBe('{"error":"not_found"}');
      for (const r of replies) expect(shape(r), what).toEqual(first);
    }
  });
});

describe("downloads", () => {
  it("sends every file as an application/octet-stream attachment with its exact bytes", async () => {
    const all: [string, Buffer][] = [
      ["jpeg", JPEG],
      ["png", PNG],
      ["gif", GIF],
      ["webp", WEBP],
      ...Object.entries(ACTIVE),
    ];
    for (const [kind, bytes] of all) {
      const r = await send(fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "content"), {
        as: "reader",
      });
      expect(r.status, kind).toBe(200);
      expect(r.headers["content-type"], kind).toBe("application/octet-stream");
      expect(r.headers["content-disposition"], kind).toMatch(/^attachment; /);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toContain("sandbox");
      expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(r.headers["content-length"]).toBe(String(bytes.length));
      expect(r.headers["accept-ranges"]).toBeUndefined();
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.body.equals(bytes), kind).toBe(true);
    }
  });

  it("answers HEAD with the headers only", async () => {
    const r = await send(fileUrl(ids.a1 ?? "", fileIds.jpeg ?? "", "content"), {
      as: "reader",
      method: "HEAD",
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe(String(JPEG.length));
    expect(r.body.length).toBe(0);
  });

  it("names the file in Content-Disposition by RFC 6266 and 8187, whatever the name", async () => {
    const names = [
      'quote" and; semicolon=evil.html',
      "..\\..\\windows\\system.ini",
      "../../etc/passwd",
      "résumé 日本語 📷.jpg",
      "percent %0d%0a and %22.jpg",
      "x".repeat(240) + ".jpg",
      "CON.jpg",
      "filename*=UTF-8''evil.exe",
      "   .hidden  ",
    ];
    for (const name of names) {
      const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented named photograph"));
      const body = Buffer.concat([makeJpeg(4, 4), Buffer.from(name)]);
      const id = await add(asset, body, name);
      const r = await send(fileUrl(asset, id, "content"), { as: "cataloger" });
      expect(r.status, name).toBe(200);
      const header = r.headers["content-disposition"] ?? "";
      const match =
        /^attachment; filename="([\x20-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9%!#$&+.^_`|~-]*)$/.exec(
          header,
        );
      expect(match, `${name}: ${header}`).not.toBeNull();
      const [, ascii = "", encoded = ""] = match ?? [];
      expect(ascii).not.toMatch(/["\\;/]/);
      // The UTF-8 form is the cleaned name, and never names a folder.
      const decoded = decodeURIComponent(encoded);
      expect(decoded).toBe(
        safeFileName(
          name
            .replace(/^.*[/\\]/u, "")
            .normalize("NFC")
            .trim(),
        ),
      );
      expect(decoded).not.toMatch(/[/\\]/);
    }
  });

  it("answers a stored copy that is gone with a plain 500, naming nothing", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented lost photograph"));
    const body = Buffer.concat([makeJpeg(5, 5), Buffer.from("lost copy")]);
    const id = await add(asset, body, "lost copy.jpg");
    rmSync(store.pathFor(w.a, sha(body)));
    const r = await send(fileUrl(asset, id, "content"), { as: "cataloger" });
    expect(r.status).toBe(500);
    expect(r.text).toBe('{"error":"internal_error"}');
  });
});

describe("viewing inline", () => {
  it("shows only sniffed JPEG, PNG, GIF and WebP, as their bare type with the file headers", async () => {
    for (const [kind, type] of [
      ["jpeg", "image/jpeg"],
      ["png", "image/png"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
    ] as const) {
      const r = await send(fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "view"), { as: "reader" });
      expect(r.status, kind).toBe(200);
      expect(r.headers["content-type"]).toBe(type);
      expect(r.headers["content-disposition"]).toMatch(/^inline; /);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toMatch(/default-src 'none'.*sandbox/);
    }
  });

  it("refuses everything else, whatever its name and claimed type say", async () => {
    for (const kind of Object.keys(ACTIVE)) {
      const r = await send(fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "view"), { as: "reader" });
      if (kind === "polyglot") {
        // Sniffed as GIF, but its "screen" is garbage: never shown, never HTML.
        expect(r.headers["content-type"]).not.toMatch(/html|xml|svg/);
      }
      expect(r.status, kind).toBe(422);
      expect(r.text).toBe('{"error":"not_viewable"}');
    }
  });

  it("refuses an image too large to show, by its header", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented huge photograph"));
    const bombs = await pngBombs(1);
    for (const [name, bytes] of [
      ["huge.png", bombs.huge],
      ["huge.jpg", hugeJpeg()],
      ["huge.gif", hugeGif()],
      ["huge.webp", webpHeader(16_000, 16_000)],
    ] as const) {
      const id = await add(asset, bytes, name);
      const r = await send(fileUrl(asset, id, "view"), { as: "cataloger" });
      expect(r.status, name).toBe(422);
      expect(r.json.error).toBe("not_viewable");
    }
  });
});

describe("thumbnails", () => {
  it("makes JPEG thumbnails of JPEG, PNG, GIF and WebP that fit the size asked", async () => {
    for (const [kind, size, box] of [
      ["jpeg", "small", { width: 160, height: 120 }],
      ["jpeg", "medium", { width: 480, height: 360 }],
      ["png", "small", { width: 80, height: 160 }],
      ["gif", "medium", { width: 40, height: 30 }],
      ["webp", "medium", { width: 480, height: 360 }],
    ] as const) {
      const r = await send(
        `${fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "thumbnail")}?size=${size}`,
        {
          as: "reader",
        },
      );
      expect(r.status, `${kind} ${size}`).toBe(200);
      expect(r.headers["content-type"]).toBe("image/jpeg");
      expect(r.headers["content-disposition"]).toBe(
        "inline; filename=\"thumbnail.jpg\"; filename*=UTF-8''thumbnail.jpg",
      );
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      const image = decodeJpeg(r.body);
      expect({ width: image.width, height: image.height }).toEqual(box);
    }
    // Lossless and alpha WebP too: JPEG thumbnails, and every WebP original
    // downloads exactly as it was stored (John: originals kept unchanged).
    const lossless = await makeWebp(400, 300, { lossless: true });
    const alpha = await makeWebp(300, 400, { alpha: true });
    for (const [name, bytes, box] of [
      ["lossless", lossless, { width: 160, height: 120 }],
      ["alpha", alpha, { width: 120, height: 160 }],
      ["lossy", WEBP, { width: 160, height: 120 }],
    ] as const) {
      const id =
        name === "lossy" ? (fileIds.webp ?? "") : await add(ids.a1 ?? "", bytes, `${name}.webp`);
      const thumb = await send(fileUrl(ids.a1 ?? "", id, "thumbnail"), { as: "reader" });
      expect(thumb.status, name).toBe(200);
      expect(thumb.headers["content-type"], name).toBe("image/jpeg");
      expect(decodeJpeg(thumb.body), name).toMatchObject(box);
      const original = await send(fileUrl(ids.a1 ?? "", id, "content"), { as: "reader" });
      expect(original.body.equals(bytes), name).toBe(true);
      expect(original.body.subarray(8, 12).toString("latin1"), name).toBe("WEBP");
    }
    // small is the default; anything else is refused.
    const plain = await send(fileUrl(ids.a1 ?? "", fileIds.jpeg ?? "", "thumbnail"), {
      as: "reader",
    });
    expect(decodeJpeg(plain.body).width).toBe(160);
    for (const bad of ["large", "", "small&size=medium", "../small"]) {
      const r = await send(
        `${fileUrl(ids.a1 ?? "", fileIds.jpeg ?? "", "thumbnail")}?size=${encodeURIComponent(bad)}`,
        { as: "reader" },
      );
      expect(r.status, bad).toBe(400);
    }
  });

  it("caches thumbnails beside the copies, for this user alone", () => {
    const folder = join(filesDir, w.a, "thumbnails", "small", sha(JPEG).slice(0, 2));
    const path = join(folder, `${sha(JPEG)}.v1.jpg`);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(filesDir, w.a, "thumbnails")).mode & 0o777).toBe(0o700);
  });

  it("makes none of active types or anything else", async () => {
    for (const kind of Object.keys(ACTIVE)) {
      const r = await send(fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "thumbnail"), {
        as: "reader",
      });
      expect(r.status, kind).toBe(422);
      expect(r.text).toBe('{"error":"no_thumbnail"}');
    }
  });

  it("refuses decompression bombs without a memory blow-up, and remembers them", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented bomb"));
    const bombs = await pngBombs(512);
    const webp = await webpAttacks();
    const added: [string, string][] = [];
    for (const [name, bytes] of [
      ["huge.png", bombs.huge],
      ["small-header.png", bombs.small],
      ["interlaced.png", bombs.interlaced],
      ["huge.jpg", hugeJpeg()],
      ["huge.gif", hugeGif()],
      ["huge-lossless.webp", webp.hugeLossless],
      ["huge-canvas.webp", webp.hugeCanvas],
      ["small-canvas.webp", webp.smallCanvas],
      ["lying-riff.webp", webp.lyingRiff],
      ["animated.webp", webp.animated],
      ["many-groups.webp", vp8lManyGroups(1024, 1024)],
      // The third review's repros (T-072).
      ["dri-slack.jpg", jpegDriSlack()],
      ["sof-slack.jpg", jpegSofSlack()],
      ["big-tables.webp", vp8lBigTables()],
      ["alpha-tables.webp", await alphBigTables()],
    ] as const) {
      added.push([name, await add(asset, bytes, name)]);
    }
    const before = process.memoryUsage().rss;
    for (const [name, id] of added) {
      const r = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" });
      expect(r.status, name).toBe(422);
      expect(r.json.error).toBe("no_thumbnail");
    }
    // Each holds 512 MiB once inflated; nothing near that was ever allocated.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
    // Remembered: a ".none" marker, and the second answer is the same.
    const marker = join(
      filesDir,
      w.a,
      "thumbnails",
      "small",
      sha(bombs.interlaced).slice(0, 2),
      `${sha(bombs.interlaced)}.v1.none`,
    );
    expect(existsSync(marker)).toBe(true);
    const again = await send(fileUrl(asset, added[2]?.[1] ?? "", "thumbnail"), { as: "cataloger" });
    expect(again.status).toBe(422);
  }, 120_000);

  it("can't be poisoned across organizations: each organization's cache is its own", async () => {
    // The same bytes in both organizations.
    const shared = makeJpeg(200, 100);
    const theirs = await makeAs(w, w.b, w.b1, assetDraft("An invented shared photograph"));
    const ours = await makeAs(w, w.a, w.a1, assetDraft("An invented shared photograph"));
    const theirId = await add(theirs, shared, "shared.jpg", "stranger");
    const ourId = await add(ours, shared, "shared.jpg");
    const prefix = sha(shared).slice(0, 2);
    // Organization A's cache entry is planted with another picture.
    const planted = makeJpeg(7, 7);
    const aFolder = join(filesDir, w.a, "thumbnails", "small", prefix);
    mkdirSync(aFolder, { recursive: true, mode: 0o700 });
    writeFileSync(join(aFolder, `${sha(shared)}.v1.jpg`), planted, { mode: 0o600 });
    // B gets its own thumbnail, never A's entry.
    const b = await send(fileUrl(theirs, theirId, "thumbnail"), { as: "stranger" });
    expect(b.status).toBe(200);
    expect(decodeJpeg(b.body).width).toBe(160);
    expect(b.body.equals(planted)).toBe(false);
    // A's cache (and only A's) holds what was planted in it.
    const a = await send(fileUrl(ours, ourId, "thumbnail"), { as: "cataloger" });
    expect(a.body.equals(planted)).toBe(true);
    // A link planted in B's cache, to A's entry, is never followed: B's
    // thumbnail is made again and the link replaced by a plain file.
    const bPath = join(filesDir, w.b, "thumbnails", "medium", prefix, `${sha(shared)}.v1.jpg`);
    mkdirSync(join(filesDir, w.b, "thumbnails", "medium", prefix), {
      recursive: true,
      mode: 0o700,
    });
    symlinkSync(join(aFolder, `${sha(shared)}.v1.jpg`), bPath);
    const linked = await send(`${fileUrl(theirs, theirId, "thumbnail")}?size=medium`, {
      as: "stranger",
    });
    expect(linked.status).toBe(200);
    expect(linked.body.equals(planted)).toBe(false);
    expect(lstatSync(bPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(aFolder, `${sha(shared)}.v1.jpg`)).equals(planted)).toBe(true);
    // A linked folder is refused too: no cache read through it.
    const cFolder = join(filesDir, w.b, "thumbnails", "small");
    rmSync(cFolder, { recursive: true, force: true });
    symlinkSync(join(filesDir, w.a, "thumbnails", "small"), cFolder);
    const viaLink = await send(fileUrl(theirs, theirId, "thumbnail"), { as: "stranger" });
    expect(viaLink.body.equals(planted)).toBe(false);
    rmSync(cFolder);
  });

  it("are never deleted on their own (not by removal or the sweep), and go to the purge's trash with their copy (S-052)", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented removable photograph"));
    const body = makeJpeg(90, 60);
    const id = await add(asset, body, "removable.jpg");
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" })).status).toBe(200);
    expect(
      (await send(`${fileUrl(asset, id, "thumbnail")}?size=medium`, { as: "cataloger" })).status,
    ).toBe(200);
    const thumb = (size: string) =>
      join(filesDir, w.a, "thumbnails", size, sha(body).slice(0, 2), `${sha(body)}.v1.jpg`);
    // The copy last used ten days ago by the file system's clock, so the
    // purge may take it (S-052).
    const tenDays = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(store.pathFor(w.a, sha(body)), tenDays, tenDays);
    const removed = await send(`/api/records/${asset}/files/${id}`, {
      as: "cataloger",
      method: "DELETE",
      headers: { "if-match": '"v1"' },
    });
    expect(removed.status).toBe(200);
    // Eight days later (moved back as the owner, the append-only trigger off
    // inside this transaction only and back on ALWAYS).
    await w.db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.stored_file_events DISABLE TRIGGER stored_file_events_append_only`,
      );
      await q.execute(sql`
        UPDATE public.stored_file_events SET occurred_at = occurred_at - interval '8 days'
        WHERE file_id = ${id}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_append_only`,
      );
    });
    const sweeper = createService(w.db, { files: store });
    expect(await sweeper.sweepFiles(0)).toMatchObject({ unbound: false, failed: 0 });
    // The sweep took nothing: the copy and both thumbnails are all there.
    expect(existsSync(store.pathFor(w.a, sha(body)))).toBe(true);
    expect(existsSync(thumb("small"))).toBe(true);
    expect(existsSync(thumb("medium"))).toBe(true);
    // The purge's first step moves the copy and both thumbnails to the trash together.
    const purged = await sweeper.purgeFiles({ apply: true });
    expect(purged.ok && purged.value.trashed.files).toBe(1);
    expect(existsSync(store.pathFor(w.a, sha(body)))).toBe(false);
    expect(existsSync(thumb("small")) || existsSync(thumb("medium"))).toBe(false);
    expect(readdirSync(join(filesDir, w.a, "trash", sha(body))).sort()).toEqual([
      "content",
      "marked",
      "thumbnail-medium-v1.jpg",
      "thumbnail-small-v1.jpg",
    ]);
  });
});

describe("the logs", () => {
  it("hold no file name and no file content", () => {
    const text = [...serverLog, ...logged.map((r) => JSON.stringify(r))].join("\n");
    expect(serverLog.length).toBeGreaterThan(0);
    for (const secret of [
      "depot photograph",
      "invented-",
      "semicolon",
      "passwd",
      "system.ini",
      "résumé",
      "r%C3%A9sum",
      "lost copy",
      "shared.jpg",
      "alert(1)",
      "invented-content-marker",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("review fixes: timeouts, budgets, HEAD, failures and downloads", () => {
  const thumbPath = (body: Buffer, kind: string, size = "small") =>
    join(filesDir, w.a, "thumbnails", size, sha(body).slice(0, 2), `${sha(body)}.v1.${kind}`);

  it("remembers a timeout for a day, then tries again (B3)", async () => {
    const slow = createThumbnailRenderer({ timeoutMs: 1 });
    const to = await serveAlso({ thumbnails: slow, thumbnailLimits: { perMinute: 1000 } });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented slow photograph"));
    const body = makeJpeg(900, 700);
    const id = await add(asset, body, "slow.jpg");
    const first = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to });
    expect(first.status).toBe(422);
    expect(first.json.error).toBe("no_thumbnail");
    const marker = thumbPath(body, "timeout");
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(thumbPath(body, "none"))).toBe(false);
    // Asked again within the day: answered from the marker, no new attempt.
    const before = statSync(marker).mtimeMs;
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status).toBe(422);
    expect(statSync(marker).mtimeMs).toBe(before);
    // A day later it is tried again (and here, too slow again).
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    utimesSync(marker, old, old);
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status).toBe(422);
    expect(statSync(marker).mtimeMs).toBeGreaterThan(old.getTime() + 3600 * 1000);
    // The normal server, with time enough, makes it then.
    const made = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" });
    expect(made.status).toBe(422);
    utimesSync(marker, old, old);
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" })).status).toBe(200);
    await slow.close();
  });

  it("answers 503 busy past an organization's thumbnails a minute, and serves the cache still (B3)", async () => {
    const to = await serveAlso({ thumbnails: renderer, thumbnailLimits: { perMinute: 2 } });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented busy photograph"));
    const ids3 = [];
    for (let n = 0; n < 3; n++)
      ids3.push(await add(asset, makeJpeg(30 + n, 20), `busy ${String(n)}.jpg`));
    const statuses = [];
    for (const id of ids3) {
      statuses.push((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status);
    }
    expect(statuses).toEqual([200, 200, 503]);
    // Cached ones don't count.
    expect(
      (await send(fileUrl(asset, ids3[0] ?? "", "thumbnail"), { as: "cataloger", to })).status,
    ).toBe(200);
  });

  it("never remembers a worker failure as no thumbnail (B3)", async () => {
    // A worker that ran out of memory or crashed: "failed", a 500, nothing cached.
    const broken: ThumbnailRenderer = {
      render: () => Promise.resolve({ ok: false, code: "failed" }),
      processesStarted: () => 0,
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({ thumbnails: broken, thumbnailLimits: { perMinute: 1000 } });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented unlucky photograph"));
    const body = makeJpeg(41, 29);
    const id = await add(asset, body, "unlucky.jpg");
    const r = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to });
    expect(r.status).toBe(500);
    expect(existsSync(thumbPath(body, "none"))).toBe(false);
    expect(existsSync(thumbPath(body, "timeout"))).toBe(false);
    // The normal server makes it.
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" })).status).toBe(200);
    await broken.close();
  });

  it("remembers a decode killed at the memory cap as no thumbnail, and never tries it again (T-072)", async () => {
    // A renderer that skips its plan (tests only), so repro C passes the
    // server's cheap check, reaches the decoder process and is killed there.
    const capped = createThumbnailRenderer({ check: "unplanned", timeoutMs: 60_000 });
    const to = await serveAlso({ thumbnails: capped, thumbnailLimits: { perMinute: 1000 } });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented killed photograph"));
    // Repro C's shape at 784² (bytes of its own: the bomb test above cached 780²'s).
    const body = vp8lBigTables(784);
    const id = await add(asset, body, "killed.webp");
    const r = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("no_thumbnail");
    expect(existsSync(thumbPath(body, "none"))).toBe(true);
    // Killed, tried once more in a fresh process, killed again: then remembered.
    expect(capped.processesStarted()).toBe(2);
    // Asked again: the cache answers, and no decoder process is started.
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status).toBe(422);
    expect(capped.processesStarted()).toBe(2);
    await capped.close();
  }, 120_000);

  it("remembers an unconfirmed kill only for a while, like a timeout (review 2)", async () => {
    const lost: ThumbnailRenderer = {
      render: () => Promise.resolve({ ok: false, code: "lost" }),
      processesStarted: () => 0,
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({ thumbnails: lost, thumbnailLimits: { perMinute: 1000 } });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented lost photograph"));
    const body = makeJpeg(44, 28);
    const id = await add(asset, body, "lost.jpg");
    expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status).toBe(422);
    expect(existsSync(thumbPath(body, "timeout"))).toBe(true);
    expect(existsSync(thumbPath(body, "none"))).toBe(false);
  });

  it("frees its slot and closes the copy when the renderer throws (review 2, B1)", async () => {
    let calls = 0;
    const throwing: ThumbnailRenderer = {
      render: () => {
        calls++;
        return Promise.reject(new Error("invented failure"));
      },
      processesStarted: () => 0,
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({
      thumbnails: throwing,
      thumbnailLimits: { perMinute: 1000, atOnce: 1 },
    });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented throwing photograph"));
    const id = await add(asset, makeJpeg(45, 27), "throwing.jpg");
    // Again and again: a 500 each time, never a stuck slot's 503.
    for (let k = 0; k < 3; k++) {
      expect((await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger", to })).status).toBe(
        500,
      );
    }
    expect(calls).toBe(3);
  });

  it("takes the organizations in turn: one waits after three in a row while another was turned away (review 2)", async () => {
    // A slow renderer that makes nothing (so nothing is cached and the same files can be asked for again).
    const slow: ThumbnailRenderer = {
      render: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve({ ok: false, code: "failed" });
          }, 300),
        ),
      processesStarted: () => 0,
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({
      thumbnails: slow,
      thumbnailLimits: { perMinute: 1000, atOnce: 1 },
    });
    const ours = await makeAs(w, w.a, w.a1, assetDraft("An invented turn-taking photograph"));
    const theirs = await makeAs(w, w.b, w.b1, assetDraft("An invented waiting photograph"));
    const a = await add(ours, makeJpeg(46, 26), "ours.jpg");
    const b = await add(theirs, makeJpeg(47, 25), "theirs.jpg", "stranger");
    const askA = () => send(fileUrl(ours, a, "thumbnail"), { as: "cataloger", to });
    const askB = () => send(fileUrl(theirs, b, "thumbnail"), { as: "stranger", to });
    // A's first is being made; B is turned away for want of the one slot.
    const first = askA();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await askB()).status).toBe(503);
    expect((await first).status).toBe(500);
    // A's second and third; then A has had three in a row while B waits.
    expect((await askA()).status).toBe(500);
    expect((await askA()).status).toBe(500);
    expect((await askA()).status).toBe(503);
    // B's turn, then A again.
    expect((await askB()).status).toBe(500);
    expect((await askA()).status).toBe(500);
  });

  it("can still be turned off: 422 for every file, HEAD too, nothing made, cached or decoded", async () => {
    let calls = 0;
    const spy: ThumbnailRenderer = {
      render: () => {
        calls++;
        return Promise.resolve({ ok: false, code: "refused" });
      },
      processesStarted: () => 0,
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({ thumbnails: spy, thumbnailsEnabled: false });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented unthumbnailed photograph"));
    const body = makeJpeg(43, 27);
    const id = await add(asset, body, "off.jpg");
    for (const method of ["GET", "HEAD"]) {
      const r = await send(fileUrl(asset, id, "thumbnail"), { as: "reader", method, to });
      expect(r.status, method).toBe(422);
    }
    // Still only for people who may see the file: a hidden one is the same 404.
    const hidden = await send(fileUrl(ids.a2 ?? "", fileIds.a2 ?? "", "thumbnail"), {
      as: "cataloger",
      to,
    });
    expect(hidden.text).toBe('{"error":"not_found"}');
    expect(calls).toBe(0);
    expect(existsSync(thumbPath(body, "jpg"))).toBe(false);
    expect(existsSync(thumbPath(body, "none"))).toBe(false);
  });

  it("answers HEAD on a thumbnail from the cache only (item 6)", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented HEAD photograph"));
    const body = makeJpeg(52, 31);
    const id = await add(asset, body, "head.jpg");
    const url = fileUrl(asset, id, "thumbnail");
    expect((await send(url, { as: "cataloger", method: "HEAD" })).status).toBe(405);
    expect(existsSync(thumbPath(body, "jpg"))).toBe(false);
    expect((await send(url, { as: "cataloger" })).status).toBe(200);
    const head = await send(url, { as: "cataloger", method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers["content-type"]).toBe("image/jpeg");
    expect(head.body.length).toBe(0);
  });

  it("makes one thumbnail at a time per organization (review)", async () => {
    const to = await serveAlso({
      thumbnails: renderer,
      thumbnailLimits: { perMinute: 1000, atOnce: 2 },
    });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented pair of photographs"));
    const one = await add(asset, makeJpeg(1500, 1100), "pair one.jpg");
    const two = await add(asset, makeJpeg(1501, 1100), "pair two.jpg");
    const [a, b] = await Promise.all([
      send(fileUrl(asset, one, "thumbnail"), { as: "cataloger", to }),
      send(fileUrl(asset, two, "thumbnail"), { as: "cataloger", to }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 503]);
  });

  it("refuses to show or thumbnail a JPEG whose markers would be read two ways (B2a)", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented smuggled photograph"));
    const id = await add(asset, jpegSmuggles(900, 700).ff00Smuggle, "smuggled.jpg");
    const view = await send(fileUrl(asset, id, "view"), { as: "cataloger" });
    expect(view.status).toBe(422);
    expect(view.json.error).toBe("not_viewable");
    const thumb = await send(fileUrl(asset, id, "thumbnail"), { as: "cataloger" });
    expect(thumb.status).toBe(422);
    expect(thumb.json.error).toBe("no_thumbnail");
  });

  it("refuses to show a GIF whose frames reach past the limits (item 3)", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented wide animation"));
    const wide = Buffer.from(makeGif(4, 4));
    const at = wide.indexOf(0x2c, 13 + 12);
    wide.writeUInt16LE(60_000, at + 5);
    wide.writeUInt16LE(60_000, at + 7);
    const id = await add(asset, wide, "wide.gif");
    const r = await send(fileUrl(asset, id, "view"), { as: "cataloger" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("not_viewable");
  });

  it("stops a running download once its session ends, and only that one (S-060b)", async () => {
    const to = await serveAlso(
      {},
      { perSession: 4, perUser: 8, minBytes: 1, windowMs: 60_000, sessionCheckMs: 100 },
    );
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented scan, session ends"));
    const body = Buffer.concat([makeJpeg(8, 8), Buffer.alloc(40 * 1024 * 1024, 9)]);
    const id = await add(asset, body, "ending.jpg");
    const url = fileUrl(asset, id, "content");
    const ending = (await fullSession(w.db, w.cataloger, w.a)).token;
    const staying = (await fullSession(w.db, w.cataloger, w.a)).token;
    const open: { destroy(): void }[] = [];
    /** A download whose body is never read (a paused reader): its status once headers come. */
    const start = (as: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: to.host,
            port: to.port,
            path: url,
            headers: { host: "localhost", cookie: `${OCULUS_COOKIES.session}=${as}` },
            agent: false,
          },
          (res) => {
            res.pause();
            res.on("error", () => undefined);
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        open.push(req);
        req.end();
      });
    // A paused client doesn't notice the server cutting it off; the
    // server's log says so (by code only), as for one too slow.
    const cutOff = () => serverLog.filter((l) => l.includes("file_stream_storage")).length;
    const before = cutOff();
    expect([await start(ending), await start(staying)]).toEqual([200, 200]);
    await new Promise((r) => setTimeout(r, 500));
    expect(cutOff()).toBe(before);
    // Signed out: the running download stops within a few checks.
    await endSession(w.db, ending);
    const deadline = Date.now() + 5_000;
    while (cutOff() < before + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(cutOff()).toBe(before + 1);
    // The other session's download keeps going.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(cutOff()).toBe(before + 1);
    for (const req of open) req.destroy();
  }, 30_000);

  it("limits streamed files per session and cuts off one too slow (item 5)", async () => {
    const to = await serveAlso({}, { perSession: 2, minBytes: 2 * 1024 * 1024, windowMs: 300 });
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented large scan"));
    const body = Buffer.concat([makeJpeg(8, 8), Buffer.alloc(40 * 1024 * 1024, 7)]);
    const id = await add(asset, body, "large.jpg");
    const url = fileUrl(asset, id, "content");
    const token = tokens.cataloger ?? "";
    /** A download whose body is never read (the reader paused): its status once headers come. */
    const stalled: { destroy(): void }[] = [];
    const startStalled = (as = token) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: to.host,
            port: to.port,
            path: url,
            headers: { host: "localhost", cookie: `${OCULUS_COOKIES.session}=${as}` },
            agent: false,
          },
          (res) => {
            res.pause();
            res.on("error", () => undefined);
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        stalled.push(req);
        req.end();
      });
    const cutBefore = serverLog.filter((l) => l.includes("file_stream_storage")).length;
    expect(await startStalled()).toBe(200);
    expect(await startStalled()).toBe(200);
    // A third at once is refused.
    const third = await send(url, { as: "cataloger", to });
    expect(third.status).toBe(429);
    expect(third.json.error).toBe("too_many_downloads");
    // The stalled ones are cut off by the server within a few windows (a
    // paused client doesn't notice; the server's log says so, by code only).
    const deadline = Date.now() + 10_000;
    while (
      serverLog.filter((l) => l.includes("file_stream_storage")).length < cutBefore + 2 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(serverLog.filter((l) => l.includes("file_stream_storage")).length).toBe(cutBefore + 2);
    // Then the session may download again, whole.
    const again = await send(url, { as: "cataloger", to });
    expect(again.status).toBe(200);
    expect(again.body.equals(body)).toBe(true);
    for (const req of stalled) req.destroy();
    // Per person too, across sessions: a server allowing 3 a session and 2
    // a person refuses a second session's second stream.
    const perUser = await serveAlso(
      {},
      { perSession: 3, perUser: 2, minBytes: 1, windowMs: 60_000 },
    );
    const otherSession = (await fullSession(w.db, w.cataloger, w.a)).token;
    const stalled2: { destroy(): void }[] = [];
    const startOn = (as: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: perUser.host,
            port: perUser.port,
            path: url,
            headers: { host: "localhost", cookie: `${OCULUS_COOKIES.session}=${as}` },
            agent: false,
          },
          (res) => {
            res.pause();
            res.on("error", () => undefined);
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        stalled2.push(req);
        req.end();
      });
    expect(await startOn(token)).toBe(200);
    expect(await startOn(otherSession)).toBe(200);
    const refused = await send(url, { as: "cataloger", to: perUser });
    expect(refused.status).toBe(429);
    for (const req of stalled2) req.destroy();
  }, 30_000);
});
