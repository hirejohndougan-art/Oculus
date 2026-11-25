// Uploading files to digital assets (M-002, D-086) over real HTTP (a
// listening server, Node's http client, so bodies really stream), against a
// fresh migrated database and a throwaway files folder: sessions, CSRF and
// Origin; the upload route's own type list and the JSON routes refusing
// upload types; permissions by role and site; identical replies for hidden
// and missing records; If-Match; the per-file cap hit mid-stream leaving no
// partial file; the organization's cap; de-duplication and two uploads of
// the same file at once; path traversal in names; the sniffed type beating
// a lying Content-Type; and no file content or names in any log. Every
// person, site, record and file is invented.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import {
  migrate,
  openDatabase,
  organizationFileBytes,
  purgeCandidates,
  databaseIdentity,
  readFileStoreBinding,
  readFileStoreLease,
  sql,
  Sql,
  type Database,
} from "@oculus/db";
import {
  ADOPT_QUIET_MS,
  STORE_MARKER,
  createService,
  openFileStore,
  type FileStore,
} from "@oculus/service";
import { freshDatabase, testServerUrl } from "../../db/src/test-database.fixtures.js";
import { createDatabase, dropDatabase, withDatabaseName } from "../../db/src/client.js";
import { findTools } from "../../db/src/backup.js";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { UPLOAD_TIMEOUTS, buildServer, type UploadTimeouts } from "./server.js";
import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  FILE_TYPE_HEADER,
  SITE_HEADER,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import {
  INC,
  actorOf,
  fullSession,
  makeAs,
  makeObject,
  makeWorld,
  pendingSession,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";

/** The per-file cap in these tests: 64 KiB, so a cap hit costs little. */
const MAX_FILE = 64 * 1024;
/** What the small-quota server allows beyond what the organization already stores. */
const SMALL_ROOM = 13 * 1024;

const ORIGIN = "http://localhost";

let w: World;
let filesDir: string;
let store: FileStore;
let app: FastifyInstance;
let base: { host: string; port: number };
let smallDir: string;
const logged: ApiLogRecord[] = [];
const serverLog: string[] = [];
const tokens: Record<string, string> = {};
let scanner: UserId;

const assetDraft = (title: string, siteRepresents?: string) => ({
  kind: "digital_asset",
  mediaType: "image/tiff",
  title,
  templateKey: "t-asset",
  fields: { rights: { uri: INC } },
  ...(siteRepresents === undefined ? {} : { represents: siteRepresents }),
});

/** Assets: on A1, on A2, in organization B; an object on A1. */
const ids: Record<string, string> = {};

async function serve(
  world: World,
  files: FileStore,
  uploadTimeouts?: Partial<UploadTimeouts>,
): Promise<FastifyInstance> {
  const service = createService(world.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files,
  });
  const server = await buildServer({
    env: { OCULUS_ORIGINS: ORIGIN },
    logger: { stream: { write: (line: string) => serverLog.push(line) } },
    ...(uploadTimeouts === undefined ? {} : { uploadTimeouts }),
    routes: staffApiRoutes({
      db: world.db,
      service,
      files,
      log: (r) => logged.push(r),
      rateLimits: { write: 10_000, read: 10_000 },
    }),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  return server;
}

function addressOf(server: FastifyInstance): { host: string; port: number } {
  const address = server.server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

beforeAll(async () => {
  w = await makeWorld();
  filesDir = mkdtempSync(join(tmpdir(), "oculus-files-test-"));
  smallDir = mkdtempSync(join(tmpdir(), "oculus-files-small-"));
  store = await openFileStore({ dir: filesDir, maxFileBytes: MAX_FILE });
  // This test database's own folder (D-086): bound while it is empty.
  expect(await createService(w.db, { files: store }).bindFileStore()).toEqual({ ok: true });
  app = await serve(w, store);
  base = addressOf(app);
  scanner = await w.member(w.a, "Scanner");
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
  ids.a1 = await makeAs(w, w.a, w.a1, assetDraft("An invented scan"));
  ids.a2 = await makeAs(w, w.a, w.a2, assetDraft("An invented second-site scan"));
  ids.b1 = await makeAs(w, w.b, w.b1, assetDraft("An invented library scan"));
  ids.object = (await makeObject(w, w.a, w.a1)).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
  rmSync(filesDir, { recursive: true, force: true });
  rmSync(smallDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

interface Send {
  as?: string;
  method?: string;
  /** The whole body, or chunks written one at a time. */
  body?: Buffer | Buffer[];
  headers?: Record<string, string>;
  csrf?: boolean | string;
  /** `null` sends no Origin (and no Sec-Fetch-Site). */
  origin?: string | null;
  ifMatch?: string | null;
  contentType?: string | null;
  name?: string | null;
  site?: string;
  to?: { host: string; port: number };
  /** Send no Content-Length (chunked). */
  chunked?: boolean;
  /** Milliseconds between chunks (default: none). */
  pace?: number;
}

/** One real HTTP request; resolves with the reply even if the server stops reading early. */
function send(path: string, s: Send = {}): Promise<Reply> {
  const method = s.method ?? "POST";
  const token = s.as === undefined ? undefined : tokens[s.as];
  const headers: Record<string, string> = { ...s.headers };
  if (s.origin !== null) headers.origin = s.origin ?? ORIGIN;
  headers.host = "localhost";
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  const csrf = s.csrf ?? method !== "GET";
  if (csrf === true && token !== undefined) headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  if (typeof csrf === "string") headers[CSRF_HEADER] = csrf;
  if (s.site !== undefined) headers[SITE_HEADER] = s.site;
  if (method !== "GET") {
    if (s.ifMatch !== null) headers["if-match"] = s.ifMatch ?? '"v1"';
    if (s.contentType !== null)
      headers["content-type"] = s.contentType ?? "application/octet-stream";
    if (s.name !== null) headers[FILE_NAME_HEADER] = encodeURIComponent(s.name ?? "scan.tif");
  }
  const chunks = s.body === undefined ? [] : Array.isArray(s.body) ? s.body : [s.body];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (method !== "GET" && s.chunked !== true) headers["content-length"] ??= String(total);
  const target = s.to ?? base;
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      { host: target.host, port: target.port, method, path, headers, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("error", () => undefined);
        res.on("end", () => {
          settled = true;
          const text = Buffer.concat(parts).toString("utf8");
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    // The server may answer and close before the whole body is written.
    req.on("error", (error) => {
      if (!settled)
        setTimeout(() => {
          if (!settled) reject(error);
        }, 500);
    });
    void (async () => {
      for (const chunk of chunks) {
        if (req.destroyed) return;
        const more = req.write(chunk);
        if (!more) await new Promise((r) => req.once("drain", r));
        await new Promise((r) => (s.pace === undefined ? setImmediate(r) : setTimeout(r, s.pace)));
      }
      req.end();
    })();
  });
}

const upload = (id: string, s: Send = {}) => send(`/api/records/${id}/files`, s);

/** Invented bytes: a PNG signature and random filler (never a real image). */
function fakePng(bytes = 2048, marker = "invented-content-marker"): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker),
    randomBytes(bytes),
  ]);
}

/** Every regular file under a folder, as paths relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function rowsFor(id: string): Promise<number> {
  const rows = await w.db.rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM public.stored_files WHERE record_id = ${id}::uuid`,
  );
  return rows[0]?.n ?? 0;
}

describe("uploads: who may send one", () => {
  it("needs a full session, CSRF and a same-origin request, before any byte is stored", async () => {
    const body = fakePng();
    const before = filesUnder(filesDir);
    expect((await upload(ids.a1 ?? "", { body })).status).toBe(401);
    expect((await upload(ids.a1 ?? "", { as: "pending", body })).status).toBe(401);
    expect((await upload(ids.a1 ?? "", { as: "cataloger", csrf: false, body })).json).toEqual({
      error: "csrf_failed",
    });
    const otherCsrf = csrfTokenFor(tokens.manager ?? "") ?? "";
    expect((await upload(ids.a1 ?? "", { as: "cataloger", csrf: otherCsrf, body })).status).toBe(
      403,
    );
    const foreign = await upload(ids.a1 ?? "", {
      as: "cataloger",
      origin: "https://elsewhere.example.org",
      body,
    });
    expect(foreign.json).toEqual({ error: "cross_origin" });
    expect((await upload(ids.a1 ?? "", { as: "cataloger", origin: null, body })).status).toBe(403);
    expect((await upload(ids.a1 ?? "", { as: "cataloger", ifMatch: null, body })).json).toEqual({
      error: "precondition_required",
    });
    expect((await upload(ids.a1 ?? "", { as: "cataloger", ifMatch: "v1", body })).json).toEqual({
      error: "bad_if_match",
    });
    expect(filesUnder(filesDir)).toEqual(before);
    expect(await rowsFor(ids.a1 ?? "")).toBe(0);
  });

  it("takes only the upload types, and the JSON routes take none of them", async () => {
    const body = fakePng();
    for (const type of [
      "application/json",
      "text/html",
      "image/svg+xml",
      "multipart/form-data; boundary=x",
      "application/octet-stream; charset=utf-8",
    ]) {
      const r = await upload(ids.a1 ?? "", { as: "cataloger", contentType: type, body });
      expect(r.status, type).toBe(415);
    }
    expect((await upload(ids.a1 ?? "", { as: "cataloger", contentType: null, body })).status).toBe(
      415,
    );
    // A JSON route refuses an upload type.
    const put = await send(`/api/records/${ids.a1 ?? ""}`, {
      as: "cataloger",
      method: "PUT",
      contentType: "application/octet-stream",
      body: Buffer.from("{}"),
    });
    expect(put.status).toBe(415);
    expect(await rowsFor(ids.a1 ?? "")).toBe(0);
  });

  it("follows the edit permission by role and site", async () => {
    const table: [string, string, number][] = [
      ["root", "a1", 201],
      ["manager", "a1", 201],
      ["cataloger", "a1", 201],
      ["scanner", "a1", 201],
      ["reader", "a1", 403],
      ["donor", "a1", 404],
      ["other", "a1", 404],
      ["stranger", "a1", 404],
      ["other", "a2", 201],
      ["cataloger", "a2", 404],
      ["stranger", "b1", 201],
    ];
    for (const [who, asset, status] of table) {
      const r = await upload(ids[asset] ?? "", { as: who, body: fakePng(512), name: `${who}.png` });
      expect(r.status, `${who} on ${asset}`).toBe(status);
    }
    // Reading the list: anyone who may view the asset.
    expect(
      (await send(`/api/records/${ids.a1 ?? ""}/files`, { as: "reader", method: "GET" })).status,
    ).toBe(200);
    expect(
      (await send(`/api/records/${ids.a1 ?? ""}/files`, { as: "other", method: "GET" })).status,
    ).toBe(404);
    const listed = await send(`/api/records/${ids.a1 ?? ""}/files`, {
      as: "cataloger",
      method: "GET",
    });
    expect((listed.json.files as unknown[]).length).toBe(4);
  });

  it("answers a hidden asset, another organization's and a missing one byte for byte alike", async () => {
    const replies: string[] = [];
    for (const id of [ids.a2 ?? "", ids.b1 ?? "", newRecordId(), "not-a-record-id"]) {
      const r = await upload(id, { as: "cataloger", body: fakePng(256) });
      expect(r.status).toBe(404);
      replies.push(
        JSON.stringify({
          status: r.status,
          body: r.text,
          type: r.headers["content-type"],
          length: r.headers["content-length"],
        }),
      );
      const list = await send(`/api/records/${id}/files`, { as: "cataloger", method: "GET" });
      replies.push(JSON.stringify({ status: list.status, body: list.text }));
    }
    expect(new Set(replies.filter((_, i) => i % 2 === 0)).size).toBe(1);
    expect(new Set(replies.filter((_, i) => i % 2 === 1)).size).toBe(1);
  });

  it("refuses a record that isn't an asset, and a stale If-Match, without reading the body", async () => {
    const r = await upload(ids.object ?? "", { as: "cataloger", body: fakePng(256) });
    expect(r.status).toBe(422);
    expect((r.json.issues as { code: string }[])[0]?.code).toBe("not_an_asset");
    const stale = await upload(ids.a1 ?? "", {
      as: "cataloger",
      ifMatch: '"v7"',
      body: fakePng(256),
    });
    expect(stale.status).toBe(412);
    expect(stale.json.error).toBe("version_conflict");
  });
});

describe("uploads: what is stored", () => {
  it("stores by content hash, de-duplicates per organization, and keeps the name as metadata", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented dedup scan"));
    const twin = await makeAs(w, w.a, w.a1, assetDraft("An invented twin scan"));
    const body = fakePng(4000);
    const first = await upload(asset, { as: "cataloger", body, name: "Ledger page 1.png" });
    expect(first.status).toBe(201);
    const file = first.json.file as Record<string, unknown>;
    expect(file).toMatchObject({
      sha256: sha(body),
      size: body.length,
      mediaType: "image/png",
      name: "Ledger page 1.png",
      recordId: asset,
    });
    const path = store.pathFor(w.a, sha(body));
    expect(readFileSync(path).equals(body)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Again to the same asset: the same row.
    const again = await upload(asset, { as: "cataloger", body, name: "Other name.png" });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect((again.json.file as Record<string, unknown>).id).toBe(file.id);
    // To another asset: a new row, one copy on disk.
    const other = await upload(twin, { as: "cataloger", body });
    expect(other.status).toBe(201);
    expect(filesUnder(filesDir).filter((p) => p.endsWith(sha(body)))).toHaveLength(1);
    // Another organization's copy is its own.
    const theirs = await makeAs(w, w.b, w.b1, assetDraft("An invented library twin"));
    expect((await upload(theirs, { as: "stranger", body })).status).toBe(201);
    expect(existsSync(store.pathFor(w.b, sha(body)))).toBe(true);
    // No temporary files are left.
    expect(filesUnder(filesDir).filter((p) => p.includes("incoming"))).toEqual([]);
  });

  it("sniffs the type from the bytes, whatever the request claims", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented sniffed scan"));
    const html = Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>");
    const lying = await upload(asset, {
      as: "cataloger",
      contentType: "image/jpeg",
      body: html,
      name: "photo.jpg",
    });
    expect(lying.status).toBe(201);
    expect(lying.json.file).toMatchObject({ mediaType: "text/html", claimedType: "image/jpeg" });
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const claimed = await upload(asset, {
      as: "cataloger",
      body: svg,
      headers: { [FILE_TYPE_HEADER]: "image/png" },
      name: "picture.png",
    });
    expect(claimed.json.file).toMatchObject({
      mediaType: "image/svg+xml",
      claimedType: "image/png",
    });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(300)]);
    const plain = await upload(asset, { as: "cataloger", body: pdf, name: "notes.txt" });
    expect(plain.json.file).toMatchObject({ mediaType: "application/pdf", claimedType: null });
    expect(
      (
        await upload(asset, {
          as: "cataloger",
          body: pdf,
          headers: { [FILE_TYPE_HEADER]: "not a type" },
        })
      ).json,
    ).toEqual({ error: "bad_file_type" });
  });

  it("never puts a name in a path: traversal, separators and odd names", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented traversal scan"));
    const cases: [string, number, string | undefined][] = [
      ["../../../../etc/passwd", 201, "passwd"],
      ["..\\..\\windows\\system.ini", 201, "system.ini"],
      ["/absolute/name.png", 201, "name.png"],
      ["%2e%2e%2fencoded.png", 201, "%2e%2e%2fencoded.png"],
      ["..", 400, undefined],
      ["../", 400, undefined],
      ["invoice\u202efdp.exe", 400, undefined],
      ["line\nbreak.png", 400, undefined],
      ["nul\u0000.png", 400, undefined],
      ["x".repeat(256), 400, undefined],
    ];
    for (const [name, status, stored] of cases) {
      const r = await upload(asset, { as: "cataloger", body: fakePng(64, name), name });
      expect(r.status, JSON.stringify(name)).toBe(status);
      if (stored !== undefined) expect((r.json.file as { name: string }).name).toBe(stored);
      else expect(r.json).toEqual({ error: "bad_file_name" });
    }
    // A header that isn't percent-encoding.
    const raw = await upload(asset, {
      as: "cataloger",
      body: fakePng(64),
      headers: { [FILE_NAME_HEADER]: "%E0%A4%A" },
      name: null,
    });
    expect(raw.json).toEqual({ error: "bad_file_name" });
    // Everything stored is under the folder, named by organization and hash.
    for (const path of filesUnder(filesDir).filter((p) => p !== STORE_MARKER)) {
      expect(path).toMatch(/^[0-9a-f-]{36}\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    }
    expect(existsSync(join(filesDir, "..", "passwd"))).toBe(false);
  });

  it("stops at the per-file cap while streaming and leaves no partial file", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented oversized scan"));
    const before = filesUnder(filesDir);
    // Declared too large: refused before a byte is read.
    const declared = await upload(asset, { as: "cataloger", body: fakePng(MAX_FILE + 10) });
    expect(declared.status).toBe(413);
    expect(declared.json).toEqual({ error: "payload_too_large" });
    expect(declared.headers.connection).toBe("close");
    // No length declared (chunked): the cap is hit mid-stream.
    const chunks = Array.from({ length: 24 }, () => randomBytes(4096));
    const streamed = await upload(asset, { as: "cataloger", body: chunks, chunked: true });
    expect(streamed.status).toBe(413);
    expect(streamed.json).toEqual({ error: "payload_too_large" });
    expect(filesUnder(filesDir)).toEqual(before);
    expect(await rowsFor(asset)).toBe(0);
    // An empty file is refused.
    expect((await upload(asset, { as: "cataloger", body: Buffer.alloc(0) })).json).toEqual({
      error: "empty_file",
    });
    expect((await upload(asset, { as: "cataloger", body: [], chunked: true })).json).toEqual({
      error: "empty_file",
    });
    // Exactly the cap is fine.
    const exact = Buffer.concat([fakePng(0), randomBytes(MAX_FILE - fakePng(0).length)]);
    expect((await upload(asset, { as: "cataloger", body: exact })).status).toBe(201);
  });

  it("refuses cleanly past the organization's total, counting each content once", async () => {
    const asset = await makeAs(w, w.b, w.b1, assetDraft("An invented quota scan"));
    const twin = await makeAs(w, w.b, w.b1, assetDraft("An invented quota twin"));
    // A second server over the same database whose store allows 13 KiB more
    // than organization B already stores.
    const used = await organizationFileBytes(w.db, w.b);
    const small = await openFileStore({
      dir: smallDir,
      maxFileBytes: MAX_FILE,
      maxOrganizationBytes: used + SMALL_ROOM,
    });
    const smallApp = await serve(w, small);
    const smallBase = addressOf(smallApp);
    const six = fakePng(6 * 1024 - 31);
    const first = await upload(asset, { as: "stranger", body: six, to: smallBase });
    expect(first.status).toBe(201);
    // The same content on another asset adds nothing to the total once
    // attached (while it streams it counts, as the content isn't known yet;
    // a declared length is counted the same way).
    expect(
      (await upload(twin, { as: "stranger", body: [six], chunked: true, to: smallBase })).status,
    ).toBe(201);
    expect(await organizationFileBytes(w.db, w.b)).toBe(used + six.length);
    // New content past the total: refused before reading when the length is declared...
    const seven = () => fakePng(7300);
    const more = await upload(asset, { as: "stranger", body: seven(), to: smallBase });
    expect(more.status).toBe(413);
    expect(more.json).toEqual({ error: "quota_exceeded" });
    // ...and while it streams when it isn't.
    const chunked = await upload(asset, {
      as: "stranger",
      body: [seven().subarray(0, 3000), seven().subarray(3000)],
      chunked: true,
      to: smallBase,
    });
    expect(chunked.json).toEqual({ error: "quota_exceeded" });
    expect(filesUnder(smallDir).filter((p) => p.includes("incoming"))).toEqual([]);
    expect(filesUnder(smallDir).filter((p) => p.includes("sha256"))).toHaveLength(1);
    await smallApp.close();
  });

  it("takes two uploads of the same file at once: one row, one copy", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented concurrent scan"));
    const twin = await makeAs(w, w.a, w.a1, assetDraft("An invented concurrent twin"));
    const body = fakePng(MAX_FILE - 100);
    const replies = await Promise.all([
      upload(asset, { as: "cataloger", body }),
      upload(asset, { as: "manager", body }),
      upload(twin, { as: "cataloger", body }),
    ]);
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201, 201]);
    expect(await rowsFor(asset)).toBe(1);
    expect(await rowsFor(twin)).toBe(1);
    expect(filesUnder(filesDir).filter((p) => p.endsWith(sha(body)))).toHaveLength(1);
    expect(readFileSync(store.pathFor(w.a, sha(body))).equals(body)).toBe(true);
    expect(filesUnder(filesDir).filter((p) => p.includes("incoming"))).toEqual([]);
  });

  it("replaces a damaged stored copy instead of trusting it", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented repaired scan"));
    const twin = await makeAs(w, w.a, w.a1, assetDraft("An invented repaired twin"));
    const body = fakePng(1000);
    expect((await upload(asset, { as: "cataloger", body })).status).toBe(201);
    const path = store.pathFor(w.a, sha(body));
    // Damage it in place (as rot or a stray write would).
    writeFileSync(path, Buffer.concat([body.subarray(0, 100), Buffer.alloc(body.length - 100)]));
    expect((await upload(twin, { as: "cataloger", body })).status).toBe(201);
    expect(readFileSync(path).equals(body)).toBe(true);
  });

  it("refuses a row change and a non-asset row in the database itself", async () => {
    await expect(
      w.db.execute(sql`UPDATE public.stored_files SET original_name = 'renamed.png'`),
    ).rejects.toThrow();
    await expect(
      w.db.execute(sql`
        INSERT INTO public.stored_files (organization_id, id, record_id, sha256, byte_size,
          media_type, original_name, created_by, created_at)
        VALUES (${w.a}::uuid, ${newRecordId()}::uuid, ${ids.object ?? ""}::uuid, ${"a".repeat(64)},
          10, 'image/png', 'x.png', ${actorOf(w.root)}, date_trunc('milliseconds', now()))`),
    ).rejects.toThrow(/digital assets/);
    const triggers = await w.db.rows<{ tgname: string; tgenabled: string }>(sql`
      SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'public.stored_files'::regclass AND NOT tgisinternal`);
    expect(triggers.length).toBe(2);
    expect(triggers.every((t) => t.tgenabled === "A")).toBe(true);
  });
});

describe("uploads: the logs", () => {
  it("hold no file content and no file name", () => {
    const text = [...serverLog, ...logged.map((r) => JSON.stringify(r))].join("\n");
    expect(serverLog.length).toBeGreaterThan(0);
    for (const secret of [
      "invented-content-marker",
      "Ledger page 1",
      "passwd",
      "system.ini",
      "invoice",
      "photo.jpg",
      "alert(1)",
      "<svg",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("uploads: stalls, trickles and time limits", () => {
  const warnings: string[] = [];
  const onWarning = (w: Error & { code?: string }) => {
    warnings.push(w.code ?? w.name);
  };

  it("removes the partial file of a client that stalls or trickles, and of a declared length too large", async () => {
    process.on("warning", onWarning);
    const dir = mkdtempSync(join(tmpdir(), "oculus-files-slow-"));
    const slowStore = await openFileStore({ dir, maxFileBytes: 1024 * 1024 });
    const slow = await serve(w, slowStore, { idle: 400, request: 1500 });
    const to = addressOf(slow);
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented stalled scan"));
    const incoming = () => filesUnder(dir).filter((p) => p.includes("incoming"));

    // Stalls: 40 KB of a declared 100,000 bytes, then silence.
    const stalled = upload(asset, {
      as: "cataloger",
      to,
      headers: { "content-length": "100000" },
      body: [fakePng(40 * 1024)],
    }).catch((error: unknown) => error);
    await new Promise((r) => setTimeout(r, 200));
    expect(incoming()).toHaveLength(1);
    await stalled;
    await new Promise((r) => setTimeout(r, 300));
    expect(incoming()).toEqual([]);

    // Trickles: 1 KB every 100 ms, past the whole-upload limit.
    const trickled = await upload(asset, {
      as: "cataloger",
      to,
      chunked: true,
      pace: 100,
      body: Array.from({ length: 40 }, () => randomBytes(1024)),
    }).catch((error: unknown) => error);
    if (!(trickled instanceof Error)) expect((trickled as Reply).status).toBe(503);
    await new Promise((r) => setTimeout(r, 300));
    expect(incoming()).toEqual([]);
    expect(await rowsFor(asset)).toBe(0);

    // A declared length over 1 TiB or of 17 digits is refused outright.
    for (const length of ["1099511627777", "10000000000000000"]) {
      const r = await upload(asset, { as: "cataloger", to, headers: { "content-length": length } });
      expect(r.status, length).toBe(413);
      expect(r.json).toEqual({ error: "payload_too_large" });
    }
    // Other routes keep their usual limits on the same server.
    const ok = await send(`/api/records/${asset}/files`, { as: "cataloger", method: "GET", to });
    expect(ok.status).toBe(200);
    await slow.close();
    rmSync(dir, { recursive: true, force: true });
    process.off("warning", onWarning);
    expect(warnings.filter((code) => code === "DEP0137")).toEqual([]);
  });

  it("raises Node's whole-request limit to the upload's on a server with upload routes", () => {
    expect(app.server.requestTimeout).toBe(UPLOAD_TIMEOUTS.request);
  });
});

/** Moves this database's file events for a file or a content back in time (as the owner). */
async function backdate(
  db: Database,
  where: { fileId?: string; sha256?: string },
  interval: string,
): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.stored_file_events DISABLE TRIGGER stored_file_events_append_only`,
    );
    await q.execute(sql`
      UPDATE public.stored_file_events SET occurred_at = occurred_at - ${interval}::interval
      WHERE (${where.fileId ?? null}::uuid IS NULL OR file_id = ${where.fileId ?? null}::uuid)
        AND (${where.sha256 ?? null}::text IS NULL OR sha256 = ${where.sha256 ?? null}::text)`);
    await q.execute(
      sql`ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_append_only`,
    );
  });
}

/** Puts bytes in the store as an attach that placed its copy and never committed. */
async function placeOrphan(db: Database, body: Buffer, assetId: string): Promise<void> {
  const received = await store.receive(
    w.a,
    (async function* () {
      await Promise.resolve();
      yield body;
    })(),
  );
  if (!received.ok) throw new Error(received.code);
  await store.place(received.file);
  await store.discard(received.file);
  await db.execute(sql`
    INSERT INTO public.stored_file_events (organization_id, id, kind, file_id, record_id, sha256,
      byte_size, actor)
    VALUES (${w.a}::uuid, ${newRecordId()}::uuid, 'placing', ${newRecordId()}::uuid,
      ${assetId}::uuid, ${sha(body)}, ${body.length}, ${actorOf(w.root)})`);
}

describe("removing files", () => {
  it("removes a file with the edit rule and If-Match; nothing deletes its bytes", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented removable scan"));
    const body = fakePng(700);
    const added = await upload(asset, { as: "cataloger", body, name: "remove me.png" });
    const fileId = (added.json.file as { id: string }).id;
    const path = `/api/records/${asset}/files/${fileId}`;
    const del = (as: string, extra: Partial<Send> = {}) =>
      send(path, { as, method: "DELETE", contentType: null, name: null, ...extra });
    // Hidden, missing and other refusals.
    expect((await del("reader")).status).toBe(403);
    expect((await del("other")).status).toBe(404);
    const missing = await send(`/api/records/${asset}/files/${newRecordId()}`, {
      as: "cataloger",
      method: "DELETE",
      contentType: null,
      name: null,
    });
    expect(missing.status).toBe(404);
    expect(missing.text).toBe('{"error":"not_found"}');
    expect((await del("cataloger", { ifMatch: '"v9"' })).status).toBe(412);
    // A Scanner may remove only the files they attached themselves.
    expect((await del("scanner")).status).toBe(403);
    // The asset can't be deleted while it has files.
    const refusedDelete = await send(`/api/records/${asset}`, {
      as: "root",
      method: "DELETE",
      contentType: null,
      name: null,
    });
    expect(refusedDelete.status).toBe(422);
    const blocker = (refusedDelete.json.issues as { code: string; message: string }[])[0];
    expect(blocker?.code).toBe("has_files");
    expect(blocker?.message).toMatch(/Remove its files first/);
    // Removed: the row goes; the bytes stay.
    expect((await del("cataloger")).status).toBe(200);
    expect(await rowsFor(asset)).toBe(0);
    const copy = store.pathFor(w.a, sha(body));
    const service = createService(w.db, { files: store });
    await backdate(w.db, { fileId }, "8 days");
    // The automatic sweep never deletes a stored copy, however old; the
    // purge (S-052) keeps it too: by the file system's clock the copy was
    // used just now, whatever the database's clock says.
    const swept = await service.sweepFiles(0);
    expect(swept).toMatchObject({ unbound: false, failed: 0 });
    expect((await service.purgeFiles({ apply: true })).ok).toBe(true);
    expect(readFileSync(copy).equals(body)).toBe(true);
    expect(filesUnder(filesDir).filter((p) => p.includes("trash"))).toEqual([]);
    // The log holds the intent, the attach and the removal, by whom.
    const events = await w.db.rows<{ kind: string; actor: string }>(sql`
      SELECT kind, actor FROM public.stored_file_events WHERE file_id = ${fileId}::uuid
      ORDER BY occurred_at`);
    expect(events).toEqual([
      { kind: "placing", actor: actorOf(w.cataloger) },
      { kind: "attached", actor: actorOf(w.cataloger) },
      { kind: "removed", actor: actorOf(w.cataloger) },
    ]);
    // Now the asset can be deleted.
    expect(
      (
        await send(`/api/records/${asset}`, {
          as: "root",
          method: "DELETE",
          contentType: null,
          name: null,
        })
      ).status,
    ).toBe(200);
  });

  it("lets a Scanner remove a file they attached", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented scanner's scan"));
    const added = await upload(asset, { as: "scanner", body: fakePng(300) });
    const fileId = (added.json.file as { id: string }).id;
    const removed = await send(`/api/records/${asset}/files/${fileId}`, {
      as: "scanner",
      method: "DELETE",
      contentType: null,
      name: null,
    });
    expect(removed.status).toBe(200);
  });
});

describe("the purge's rule on the database's side (S-052)", () => {
  it("takes only old removals with the copy's time logged: never a failed attach, a relapse, a re-attach or unknown content", async () => {
    const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented purge scan"));
    // An orphan: an attach placed its copy two days ago and never committed.
    const orphan = fakePng(810);
    await placeOrphan(w.db, orphan, asset);
    await backdate(w.db, { sha256: sha(orphan) }, "2 days");
    // L1: removed two days ago, then a failed attach of the same content a
    // day and a half ago: the removal's 7 days still hold.
    const relapse = fakePng(820);
    const added = await upload(asset, { as: "cataloger", body: relapse });
    const relapseId = (added.json.file as { id: string }).id;
    expect(
      (
        await send(`/api/records/${asset}/files/${relapseId}`, {
          as: "cataloger",
          method: "DELETE",
          contentType: null,
          name: null,
        })
      ).status,
    ).toBe(200);
    await backdate(w.db, { sha256: sha(relapse) }, "2 days");
    await placeOrphan(w.db, relapse, asset);
    await backdate(w.db, { sha256: sha(relapse) }, "36 hours");
    // Removed eight days ago, then attached again: named, kept.
    const back = fakePng(830);
    const first = await upload(asset, { as: "cataloger", body: back });
    const firstId = (first.json.file as { id: string }).id;
    await send(`/api/records/${asset}/files/${firstId}`, {
      as: "cataloger",
      method: "DELETE",
      contentType: null,
      name: null,
    });
    await backdate(w.db, { sha256: sha(back) }, "8 days");
    expect((await upload(asset, { as: "cataloger", body: back })).status).toBe(201);
    // Removed eight days ago and not attached since.
    const old = fakePng(835);
    const oldAdded = await upload(asset, { as: "cataloger", body: old });
    await send(`/api/records/${asset}/files/${(oldAdded.json.file as { id: string }).id}`, {
      as: "cataloger",
      method: "DELETE",
      contentType: null,
      name: null,
    });
    await backdate(w.db, { sha256: sha(old) }, "8 days");
    // A content this database has no record of at all.
    const stray = sha(fakePng(840));

    const hashes = [orphan, relapse, back, old].map(sha).concat(stray);
    const listed = (await purgeCandidates(w.db, w.a, null, hashes)).map((c) => c.sha256);
    expect(listed).toEqual([sha(old)]);
    // The removal logged the copy's own time.
    const [candidate] = await purgeCandidates(w.db, w.a, null, [sha(old)]);
    expect(candidate?.copyMtimeNs).toBe(
      statSync(store.pathFor(w.a, sha(old)), { bigint: true }).mtimeNs,
    );
    // Nothing was deleted.
    for (const kept of [orphan, relapse, back, old]) {
      expect(readFileSync(store.pathFor(w.a, sha(kept))).equals(kept)).toBe(true);
    }
  });

  it("turns the lease against a marker whose epoch isn't this database's", async () => {
    const service = createService(w.db, { files: store });
    const marker = readFileSync(join(filesDir, STORE_MARKER), "utf8");
    const [storeId, database] = marker.split("\n");
    writeFileSync(
      join(filesDir, STORE_MARKER),
      `${storeId ?? ""}\n${database ?? ""}\n${newRecordId()}\n`,
    );
    expect(await service.renewFileLease()).toBe(false);
    // Put back as it was, and the lease moves on again.
    writeFileSync(join(filesDir, STORE_MARKER), marker);
    expect(await service.renewFileLease()).toBe(true);
  }, 30_000);
});

describe("every attach touches the stored copy (fifth review)", () => {
  it("sets the copy's time to now on a new attach, a shared content and the same one again", async () => {
    const one = await makeAs(w, w.a, w.a1, assetDraft("An invented touched scan"));
    const two = await makeAs(w, w.a, w.a1, assetDraft("An invented second touched scan"));
    const body = fakePng(860);
    const path = store.pathFor(w.a, sha(body));
    const age = (): number => Date.now() - statSync(path).mtimeMs;
    const month = new Date(Date.now() - 30 * 86_400_000);
    expect((await upload(one, { as: "cataloger", body })).status).toBe(201);
    expect(age()).toBeLessThan(60_000);
    // The same content on another asset: one copy, touched.
    utimesSync(path, month, month);
    expect((await upload(two, { as: "cataloger", body })).status).toBe(201);
    expect(age()).toBeLessThan(60_000);
    // The same content on the same asset again (the row already there).
    utimesSync(path, month, month);
    expect((await upload(one, { as: "cataloger", body })).status).toBe(200);
    expect(age()).toBeLessThan(60_000);
    // `placing` touches it too: an attach refused for its name, a check
    // made after the intent is committed.
    utimesSync(path, month, month);
    const received = await store.receive(
      w.a,
      (async function* () {
        await Promise.resolve();
        yield body;
      })(),
    );
    if (!received.ok) throw new Error(received.code);
    const refused = await createService(w.db, { files: store }).attachFile(
      { organizationId: w.a, actor: actorOf(w.root) },
      one as never,
      received.file,
      { name: "bad\u202ename.png", expectedVersion: 1 },
    );
    expect(refused.ok).toBe(false);
    expect(age()).toBeLessThan(60_000);
  });
});

describe("the files folder belongs to one install", () => {
  it("refuses another install's folder, a folder without the expected marker, and a full folder without one", async () => {
    const service = createService(w.db, { files: store });
    // The same folder again: fine, and the lease moves on.
    const before = readFileSync(join(filesDir, STORE_MARKER), "utf8").split("\n")[2];
    expect(await service.bindFileStore()).toEqual({ ok: true });
    const [marker, database, epoch] = readFileSync(join(filesDir, STORE_MARKER), "utf8").split(
      "\n",
    );
    expect(await readFileStoreBinding(w.db)).toBe(marker);
    expect(database).toBe(await databaseIdentity(w.db));
    expect(epoch).not.toBe(before);
    expect((await readFileStoreLease(w.db))?.epoch).toBe(epoch);
    const folder = async (setup: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "oculus-files-bind-"));
      setup(dir);
      return { dir, store: await openFileStore({ dir }) };
    };
    // This database has a folder: an empty other one has no marker.
    const empty = await folder(() => undefined);
    expect(await createService(w.db, { files: empty.store }).bindFileStore()).toEqual({
      ok: false,
      problem: "marker_missing",
    });
    const foreign = await folder((dir) => {
      writeFileSync(join(dir, STORE_MARKER), `${newRecordId()}\n`);
    });
    expect(await createService(w.db, { files: foreign.store }).bindFileStore()).toEqual({
      ok: false,
      problem: "other_install",
    });
    // A fresh database: another install's folder, and a full folder with no marker.
    const fresh = await freshDatabase();
    await migrate({ connectionString: fresh.url });
    const db = openDatabase(fresh.url, { max: 2 });
    try {
      expect(await createService(db, { files: store }).bindFileStore()).toEqual({
        ok: false,
        problem: "other_install",
      });
      const full = await folder((dir) => {
        writeFileSync(join(dir, "someone-elses.txt"), "x");
      });
      expect(await createService(db, { files: full.store }).bindFileStore()).toEqual({
        ok: false,
        problem: "not_empty",
      });
      // A marker naming this fresh database, with no binding row yet (a
      // crash between the two steps): taken only with a readable system
      // identifier. By the OID alone (`-:<oid>`) it could be another
      // cluster's database: refused (fifth review).
      const identity = await databaseIdentity(db);
      const oid = identity.split(":")[1] ?? "";
      const blind: Database = {
        rows: (q) =>
          Sql.parts(q).join("").includes("pg_control_system")
            ? Promise.reject(new Error("permission denied"))
            : db.rows(q),
        execute: (q) => db.execute(q),
        transaction: (work) => db.transaction(work),
        close: () => Promise.resolve(),
      };
      expect(await databaseIdentity(blind)).toBe(`-:${oid}`);
      const byOid = await folder((dir) => {
        writeFileSync(join(dir, STORE_MARKER), `${newRecordId()}\n-:${oid}\n${newRecordId()}\n`);
      });
      expect(await createService(blind, { files: byOid.store }).bindFileStore()).toEqual({
        ok: false,
        problem: "other_install",
      });
      expect(await readFileStoreBinding(db)).toBeUndefined();
      const crashed = await folder((dir) => {
        writeFileSync(join(dir, STORE_MARKER), `${newRecordId()}\n${identity}\n${newRecordId()}\n`);
      });
      expect((await createService(db, { files: crashed.store }).bindFileStore()).ok).toBe(true);
      for (const f of [byOid, crashed]) rmSync(f.dir, { recursive: true, force: true });
      const swept = await createService(db, { files: full.store }).sweepFiles(0);
      expect(swept).toMatchObject({ unbound: true, contents: 0, incoming: 0 });
      // A database that never bound the folder can't purge it.
      expect(await createService(db, { files: store }).purgeFiles({ apply: true })).toEqual({
        ok: false,
        problem: "not_bound",
      });
      for (const f of [empty, foreign, full]) rmSync(f.dir, { recursive: true, force: true });
    } finally {
      await db.close();
      await fresh.drop();
    }
  }, 30_000);

  it("never touches another organization's folder or anything at a content path", async () => {
    const stranger = newRecordId();
    const hash = "ab".repeat(32);
    const theirs = join(filesDir, stranger, "sha256", "ab");
    mkdirSync(theirs, { recursive: true, mode: 0o700 });
    writeFileSync(join(theirs, hash), "another install's bytes");
    const odd = join(filesDir, w.a, "sha256", "cd");
    mkdirSync(join(odd, "cd".repeat(32)), { recursive: true, mode: 0o700 });
    const service = createService(w.db, { files: store });
    expect(await service.sweepFiles(0)).toMatchObject({ unbound: false, failed: 0 });
    expect(readFileSync(join(theirs, hash), "utf8")).toBe("another install's bytes");
    expect(existsSync(join(odd, "cd".repeat(32)))).toBe(true);
    rmSync(join(filesDir, stranger), { recursive: true, force: true });
    rmSync(odd, { recursive: true, force: true });
  });
});

/** pg_dump of a database into a file, and pg_restore of it into a new, empty one. */
async function dumpTo(url: string, file: string): Promise<void> {
  const bin = await findTools(process.env, ["pg_dump", "pg_restore"]);
  const result = spawnSync(join(bin, "pg_dump"), ["-Fc", "--no-owner", "-f", file, "-d", url], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`pg_dump failed: ${result.stderr}`);
}

async function restoreInto(file: string, name: string): Promise<string> {
  const bin = await findTools(process.env, ["pg_dump", "pg_restore"]);
  await createDatabase(testServerUrl(), name);
  const url = withDatabaseName(testServerUrl(), name);
  const result = spawnSync(
    join(bin, "pg_restore"),
    ["--no-owner", "--no-acl", "--exit-on-error", "-d", url, file],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`pg_restore failed: ${result.stderr}`);
  return url;
}

/** Removes a file through the service of another database (no HTTP server for it). */
async function removeVia(db: Database, assetId: string, fileId: string): Promise<void> {
  const removed = await createService(db, { files: store }).removeFile(
    { organizationId: w.a, actor: actorOf(w.root) },
    assetId as never,
    fileId,
    { expectedVersion: 1 },
  );
  if (!removed.ok) throw new Error(JSON.stringify(removed.issues));
}

/** Sets a content's stored copy's time `days` back (a copy last used long ago). */
function ageCopy(body: Buffer, days: number): void {
  const past = new Date(Date.now() - days * 86_400_000);
  utimesSync(store.pathFor(w.a, sha(body)), past, past);
}

/** The marker as if it had stood still long enough for adopt (three renewals and a minute). */
function quiet(): void {
  const past = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
  utimesSync(join(filesDir, STORE_MARKER), past, past);
}

describe("a second database on the folder never deletes production's files (fourth and fifth reviews, S-052)", () => {
  it("R1a: a copy that removes a file production names deletes nothing, and the lease shows the sharing", async () => {
    const work = mkdtempSync(join(tmpdir(), "oculus-files-r1a-"));
    const name = `oculus_test_r1a_${randomBytes(6).toString("hex")}`;
    let copy: Database | undefined;
    try {
      const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented R1a scan"));
      const x = fakePng(900);
      const added = await upload(asset, { as: "cataloger", body: x });
      const xId = (added.json.file as { id: string }).id;
      // X's copy last used long ago, so by every other rule the copy could take it.
      ageCopy(x, 10);
      await dumpTo(w.testDb.url, join(work, "a.dump"));
      // Production starts (or its hourly renewal runs): the epoch moves.
      expect(await createService(w.db, { files: store }).renewFileLease()).toBe(true);
      copy = openDatabase(await restoreInto(join(work, "a.dump"), name), { max: 3 });
      const copyService = createService(copy, { files: store });
      expect(await copyService.bindFileStore()).toEqual({
        ok: true,
        warning: "files_shared_or_restored",
      });
      await removeVia(copy, asset, xId);
      await backdate(copy, { fileId: xId }, "8 days");
      expect(await copyService.sweepFiles(0)).toMatchObject({ failed: 0 });
      // The copy's epoch isn't the folder's: refused before anything moves.
      expect(await copyService.purgeFiles({ apply: true })).toEqual({
        ok: false,
        problem: "lease_mismatch",
      });
      expect(await copyService.purgeFiles({ apply: false })).toEqual({
        ok: false,
        problem: "lease_mismatch",
      });
      expect(await createService(w.db, { files: store }).renewFileLease()).toBe(false);
      expect(readFileSync(store.pathFor(w.a, sha(x))).equals(x)).toBe(true);
    } finally {
      await copy?.close();
      await dropDatabase(testServerUrl(), name).catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
      await readopt();
    }
  }, 120_000);

  it("R1b: a clone taken right after production's renewal is caught at production's next renewal", async () => {
    const work = mkdtempSync(join(tmpdir(), "oculus-files-r1b-"));
    const name = `oculus_test_r1b_${randomBytes(6).toString("hex")}`;
    let copy: Database | undefined;
    try {
      const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented R1b scan"));
      const x = fakePng(910);
      const added = await upload(asset, { as: "cataloger", body: x });
      const xId = (added.json.file as { id: string }).id;
      ageCopy(x, 10);
      expect(await createService(w.db, { files: store }).renewFileLease()).toBe(true);
      // The copy holds the very epoch the folder has.
      await dumpTo(w.testDb.url, join(work, "a.dump"));
      copy = openDatabase(await restoreInto(join(work, "a.dump"), name), { max: 3 });
      const copyService = createService(copy, { files: store });
      expect(await copyService.bindFileStore()).toEqual({ ok: true });
      // Production's next hourly renewal finds the folder moved on without it.
      expect(await createService(w.db, { files: store }).renewFileLease()).toBe(false);
      await removeVia(copy, asset, xId);
      await backdate(copy, { fileId: xId }, "8 days");
      expect(await copyService.sweepFiles(0)).toMatchObject({ failed: 0 });
      expect(await copyService.purgeFiles({ apply: true })).toEqual({
        ok: false,
        problem: "lease_mismatch",
      });
      expect(readFileSync(store.pathFor(w.a, sha(x))).equals(x)).toBe(true);
      expect(await store.trashEntries(w.a)).toEqual([]);
    } finally {
      await copy?.close();
      await dropDatabase(testServerUrl(), name).catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
      await readopt();
    }
  }, 120_000);

  it("R2 and R5: adopting a restored database waits for the folder to be quiet, and keeps everything from before", async () => {
    const work = mkdtempSync(join(tmpdir(), "oculus-files-r2-"));
    const name = `oculus_test_r2_${randomBytes(6).toString("hex")}`;
    let copy: Database | undefined;
    try {
      const asset = await makeAs(w, w.a, w.a1, assetDraft("An invented R2 scan"));
      const x = fakePng(920);
      const added = await upload(asset, { as: "cataloger", body: x });
      const xId = (added.json.file as { id: string }).id;
      ageCopy(x, 10);
      // Last night's dump; production attaches Y afterwards.
      await dumpTo(w.testDb.url, join(work, "a.dump"));
      const y = fakePng(930);
      expect((await upload(asset, { as: "cataloger", body: y })).status).toBe(201);
      copy = openDatabase(await restoreInto(join(work, "a.dump"), name), { max: 3 });
      const restored = createService(copy, { files: store });
      expect((await restored.bindFileStore()).ok).toBe(true);
      // The restored database removed X before it was adopted.
      await removeVia(copy, asset, xId);
      await backdate(copy, { fileId: xId }, "8 days");
      // Adopt refuses while the marker keeps moving, and two hours of
      // quiet are not enough (three renewals).
      expect(await restored.adoptFileStore()).toEqual({ ok: false, problem: "epoch_moving" });
      const twoHours = new Date(Date.now() - 2 * 3600_000);
      utimesSync(join(filesDir, STORE_MARKER), twoHours, twoHours);
      expect(await restored.adoptFileStore()).toEqual({ ok: false, problem: "epoch_moving" });
      quiet();
      expect(await restored.adoptFileStore()).toEqual({ ok: true });
      // After the adopt the restored database may purge, but only what it
      // removes from now on: X (removed before the adopt) and Y (never known
      // to it) stay.
      expect(await restored.sweepFiles(0)).toMatchObject({ failed: 0 });
      const purged = await restored.purgeFiles({ apply: true });
      expect(purged.ok && purged.value.trashed.files).toBe(0);
      expect(await store.trashEntries(w.a)).toEqual([]);
      expect(readFileSync(store.pathFor(w.a, sha(x))).equals(x)).toBe(true);
      expect(readFileSync(store.pathFor(w.a, sha(y))).equals(y)).toBe(true);
      // Production now finds the folder isn't its own, and can't purge either.
      expect(await createService(w.db, { files: store }).renewFileLease()).toBe(false);
      expect(await createService(w.db, { files: store }).purgeFiles({ apply: true })).toEqual({
        ok: false,
        problem: "lease_mismatch",
      });
    } finally {
      await copy?.close();
      await dropDatabase(testServerUrl(), name).catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
      await readopt();
    }
  }, 120_000);
});

/** After a test that handed the folder to another database: this test database's own again. */
async function readopt(): Promise<void> {
  quiet();
  const adopted = await createService(w.db, { files: store }).adoptFileStore();
  if (!adopted.ok) throw new Error(adopted.problem);
}
