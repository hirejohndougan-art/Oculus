// Reading files (M-003, D-097) over real HTTP against a fresh migrated
// database and a throwaway files folder: who may download, view and get
// thumbnails (identical 404s for hidden, other-site, other-organization and
// missing records and files); every type downloads as octet-stream, polyglots
// included; inline only for sniffed JPEG, PNG, GIF and WebP; Content-
// Disposition with awkward names; decompression bombs refused without a
// memory blow-up; a thumbnail cache that can't be poisoned across
// organizations; the sweep taking thumbnails with their bytes; and no file
// names in any log. Every person, record, name and pixel is invented.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import {
  createService,
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
  hugeGif,
  hugeJpeg,
  makeGif,
  makeJpeg,
  makePng,
  pngBombs,
  jpegSmuggles,
  makeWebp,
  webpHeader,
} from "../../service/src/images.fixtures.js";

const ORIGIN = "http://localhost";
const MAX_FILE = 64 * 1024 * 1024;

let w: World;
let filesDir: string;
let store: FileStore;
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
  const service = createService(w.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files: store,
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
  downloads?: { perSession?: number; perUser?: number; minBytes?: number; windowMs?: number },
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
        // Thumbnails are off (T-072): someone who may see the file gets 422.
        const expected = what === "thumbnail" && status === 200 ? 422 : status;
        expect(r.status, `${who} ${what} ${asset}`).toBe(expected);
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

describe("thumbnails (off until T-072, D-097)", () => {
  it("answers 422 no_thumbnail for every file, HEAD too, and makes or caches nothing", async () => {
    for (const kind of ["jpeg", "png", "gif", "webp", ...Object.keys(ACTIVE)]) {
      for (const size of ["small", "medium"]) {
        const url = `${fileUrl(ids.a1 ?? "", fileIds[kind] ?? "", "thumbnail")}?size=${size}`;
        const r = await send(url, { as: "reader" });
        expect(r.status, `${kind} ${size}`).toBe(422);
        expect(r.text).toBe('{"error":"no_thumbnail"}');
        expect((await send(url, { as: "reader", method: "HEAD" })).status).toBe(422);
      }
    }
    // Still only for people who may see the file: a hidden one is the same 404.
    const hidden = await send(fileUrl(ids.a2 ?? "", fileIds.a2 ?? "", "thumbnail"), {
      as: "cataloger",
    });
    expect(hidden.text).toBe('{"error":"not_found"}');
    // Nothing was written for thumbnails.
    expect(existsSync(join(filesDir, w.a, "thumbnails"))).toBe(false);
  });

  it("never reaches the renderer, so no worker starts", async () => {
    let calls = 0;
    const spy: ThumbnailRenderer = {
      render: () => {
        calls++;
        return Promise.resolve({ ok: false, code: "refused" });
      },
      close: () => Promise.resolve(),
    };
    const to = await serveAlso({ thumbnails: spy });
    const r = await send(fileUrl(ids.a1 ?? "", fileIds.jpeg ?? "", "thumbnail"), {
      as: "reader",
      to,
    });
    expect(r.status).toBe(422);
    expect(calls).toBe(0);
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

describe("review fixes: the JPEG walk, GIF frames and downloads", () => {
  it("refuses to show a JPEG whose markers would be read two ways (B2a)", async () => {
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
