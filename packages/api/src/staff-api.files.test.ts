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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import { organizationFileBytes, sql } from "@oculus/db";
import { createService, openFileStore, type FileStore } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
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
const SMALL_ROOM = 10 * 1024;

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

async function serve(world: World, files: FileStore): Promise<FastifyInstance> {
  const service = createService(world.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files,
  });
  const server = await buildServer({
    env: { OCULUS_ORIGINS: ORIGIN },
    logger: { stream: { write: (line: string) => serverLog.push(line) } },
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
  if (method !== "GET" && s.chunked !== true) headers["content-length"] = String(total);
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
        await new Promise((r) => setImmediate(r));
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
    for (const path of filesUnder(filesDir)) {
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
    // A second server over the same database whose store allows 10 KiB more
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
    // The same content on another asset adds nothing; sent without a length
    // (a declared length is counted before the content is known).
    expect(
      (await upload(twin, { as: "stranger", body: [six], chunked: true, to: smallBase })).status,
    ).toBe(201);
    // New content past the total: refused, before reading when the length is declared...
    const more = await upload(asset, { as: "stranger", body: fakePng(6 * 1024), to: smallBase });
    expect(more.status).toBe(413);
    expect(more.json).toEqual({ error: "quota_exceeded" });
    // ...and after it, under the lock, when it isn't.
    const chunked = await upload(asset, {
      as: "stranger",
      body: [fakePng(3 * 1024), randomBytes(3 * 1024)],
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
    const { writeFileSync } = await import("node:fs");
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
