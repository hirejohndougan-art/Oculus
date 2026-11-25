// Virus scanning of uploaded files (S-040, D-113) over real HTTP against a
// fresh migrated database, a throwaway files folder and a fake clamd
// (clamd.fixtures.ts): uploads answer before their scan; only clean files
// are read while a scanner is set up (409 scan_pending, 409 scan_failed,
// 423 quarantined); a clamd that never answers leaves the file failed and
// it is retried; one that goes down mid-stream too; an infected content is
// quarantined, logged, shared by every asset holding the same bytes, kept
// quarantined by the database and never deleted; System settings' status
// and rescan for system managers only; and without a scanner files are
// not_scanned and served as before, an infected one still never.
// No real virus sample: the fake "finds" an invented marker.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "@oculus/core";
import { sql } from "@oculus/db";
import {
  clamdScanner,
  createService,
  openFileStore,
  type FileStore,
  type RecordService,
} from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import {
  CSRF_HEADER,
  FILE_NAME_HEADER,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import { INC, fullSession, makeAs, makeWorld, type World } from "./staff-api.fixtures.js";
import {
  FAKE_SIGNATURE,
  FAKE_VIRUS_MARKER,
  startFakeClamd,
  type FakeClamd,
} from "../../service/src/clamd.fixtures.js";

const ORIGIN = "http://localhost";

let w: World;
let filesDir: string;
let store: FileStore;
let clamd: FakeClamd;
/** The server with a scanner, and its service (to wait for the queue). */
let scanned: { base: Base; service: RecordService; app: FastifyInstance };
/** The same database and folder served without a scanner. */
let plain: { base: Base; app: FastifyInstance };
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

interface Base {
  host: string;
  port: number;
}

interface Reply {
  status: number;
  body: Buffer;
  json: Record<string, unknown>;
}

function send(
  to: Base,
  path: string,
  s: { as?: string; method?: string; body?: Buffer; headers?: Record<string, string> } = {},
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
      { host: to.host, port: to.port, method, path, headers, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          const body = Buffer.concat(parts);
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(s.body);
  });
}

const assetDraft = (title: string) => ({
  kind: "digital_asset",
  mediaType: "text/plain",
  title,
  templateKey: "t-asset",
  fields: { rights: { uri: INC } },
});

/** Uploads bytes to an asset; returns the file's ID. Answers before the scan. */
async function add(to: Base, asset: string, body: Buffer, name: string): Promise<string> {
  const r = await send(to, `/api/records/${asset}/files`, {
    as: "cataloger",
    method: "POST",
    body,
    headers: {
      "content-type": "application/octet-stream",
      "if-match": '"v1"',
      [FILE_NAME_HEADER]: encodeURIComponent(name),
    },
  });
  expect([200, 201], r.body.toString()).toContain(r.status);
  return (r.json.file as { id: string }).id;
}

const content = (asset: string, file: string, what = "content") =>
  `/api/records/${asset}/files/${file}/${what}`;

async function listed(to: Base, asset: string): Promise<Record<string, string>> {
  const r = await send(to, `/api/records/${asset}/files`, { as: "cataloger" });
  expect(r.status).toBe(200);
  const files = r.json.files as { id: string; scan: string }[];
  return Object.fromEntries(files.map((f) => [f.id, f.scan]));
}

async function serve(service: RecordService): Promise<{ base: Base; app: FastifyInstance }> {
  const app = await buildServer({
    env: { OCULUS_ORIGINS: ORIGIN },
    logger: false,
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
  return { base: { host: address.address, port: address.port }, app };
}

/** A content's stored scan row, read as the owner. */
async function scanRow(sha256OfFile: { asset: string; file: string }) {
  const rows = await w.db.rows<{
    state: string;
    failure: string | null;
    signature: string | null;
    attempts: number;
    due: boolean | null;
  }>(sql`
    SELECT s.state, s.failure, s.signature, s.attempts,
      s.next_attempt_at <= clock_timestamp() AS due
    FROM public.file_scans s
    JOIN public.stored_files f ON f.organization_id = s.organization_id AND f.sha256 = s.sha256
    WHERE f.id = ${sha256OfFile.file}::uuid`);
  return rows;
}

/** Makes every failed scan due now (in place of waiting out its backoff). */
async function dueNow(): Promise<void> {
  await w.db.execute(sql`
    UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
    WHERE state = 'failed' AND next_attempt_at IS NOT NULL`);
}

beforeAll(async () => {
  w = await makeWorld();
  filesDir = mkdtempSync(join(tmpdir(), "oculus-file-scans-"));
  store = await openFileStore({ dir: filesDir, maxFileBytes: 8 * 1024 * 1024 });
  expect(await createService(w.db, { files: store }).bindFileStore()).toEqual({ ok: true });
  clamd = await startFakeClamd({ mode: "detect" });
  const service = createService(w.db, {
    onError: serviceErrorLogger((r) => logged.push(r)),
    files: store,
    scanner: clamdScanner({ address: clamd.address, timeoutMs: 600, streamMaxBytes: 1024 * 1024 }),
    scanQueue: { concurrency: 2 },
  });
  scanned = { ...(await serve(service)), service };
  plain = await serve(
    createService(w.db, { onError: serviceErrorLogger((r) => logged.push(r)), files: store }),
  );
  tokens.root = (await fullSession(w.db, w.root, w.a)).token;
  tokens.cataloger = (await fullSession(w.db, w.cataloger, w.a)).token;
  tokens.manager = (await fullSession(w.db, w.manager, w.a)).token;
  tokens.stranger = (await fullSession(w.db, w.stranger, w.b)).token;
  ids.a = await makeAs(w, w.a, w.a1, assetDraft("An invented letter"));
  ids.b = await makeAs(w, w.a, w.a1, assetDraft("An invented second letter"));
  ids.c = await makeAs(w, w.a, w.a1, assetDraft("An invented third letter"));
}, 120_000);

afterAll(async () => {
  await scanned.service.stopFileScans();
  await scanned.app.close();
  await plain.app.close();
  await clamd.close();
  await w.db.close();
  await w.testDb.drop();
  rmSync(filesDir, { recursive: true, force: true });
});

describe("with a scanner", () => {
  it("answers the upload at once, refuses reads while pending, and serves the file once clean", async () => {
    clamd.mode = "silent";
    const body = Buffer.from("An invented, harmless letter about the depot.");
    const file = await add(scanned.base, ids.a ?? "", body, "letter.txt");
    // The upload didn't wait for its scan: it is still pending.
    expect((await listed(scanned.base, ids.a ?? ""))[file]).toBe("pending");
    for (const what of ["content", "view", "thumbnail"]) {
      const r = await send(scanned.base, content(ids.a ?? "", file, what), { as: "cataloger" });
      expect([r.status, r.json], what).toEqual([409, { error: "scan_pending" }]);
    }
    // The fake never answers: the time limit leaves the file failed.
    await scanned.service.scanQueuedFiles();
    expect(await scanRow({ asset: ids.a ?? "", file })).toEqual([
      { state: "failed", failure: "timeout", signature: null, attempts: 1, due: false },
    ]);
    expect((await listed(scanned.base, ids.a ?? ""))[file]).toBe("failed");
    const failed = await send(scanned.base, content(ids.a ?? "", file), { as: "cataloger" });
    expect([failed.status, failed.json]).toEqual([409, { error: "scan_failed" }]);
    // Not tried again before its backoff…
    clamd.mode = "detect";
    const before = clamd.connections();
    await scanned.service.scanQueuedFiles();
    expect(clamd.connections()).toBe(before);
    // …and then retried: clean, served.
    await dueNow();
    await scanned.service.scanQueuedFiles();
    expect(await scanRow({ asset: ids.a ?? "", file })).toEqual([
      { state: "clean", failure: null, signature: null, attempts: 0, due: null },
    ]);
    const r = await send(scanned.base, content(ids.a ?? "", file), { as: "cataloger" });
    expect(r.status).toBe(200);
    expect(r.body.equals(body)).toBe(true);
    ids.cleanFile = file;
  });

  it("fails a scan when clamd goes down mid-stream, and retries it", async () => {
    clamd.mode = "drop";
    // Larger than one 64 KiB chunk, so the fake drops the connection mid-stream.
    const body = Buffer.alloc(300_000, 0x62);
    const file = await add(scanned.base, ids.c ?? "", body, "big.txt");
    await scanned.service.scanQueuedFiles();
    expect((await scanRow({ asset: ids.c ?? "", file }))[0]).toMatchObject({
      state: "failed",
      failure: "unavailable",
    });
    clamd.mode = "detect";
    await dueNow();
    await scanned.service.scanQueuedFiles();
    expect((await scanRow({ asset: ids.c ?? "", file }))[0]?.state).toBe("clean");
  });

  it("fails garbage and a size-limit reply too, never as clean", async () => {
    for (const [mode, failure] of [
      ["garbage", "protocol"],
      ["size_limit", "too_large"],
    ] as const) {
      clamd.mode = mode;
      clamd.limit = 10;
      const file = await add(
        scanned.base,
        ids.c ?? "",
        Buffer.from(`invented ${mode} content that is long enough`),
        `${mode}.txt`,
      );
      await scanned.service.scanQueuedFiles();
      const row = (await scanRow({ asset: ids.c ?? "", file }))[0];
      expect(row, mode).toMatchObject({ state: "failed", failure });
      const r = await send(scanned.base, content(ids.c ?? "", file), { as: "cataloger" });
      expect(r.status, mode).toBe(409);
    }
    // A file too large isn't retried by itself: only a rescan queues it.
    const tooLarge = await w.db.rows<{ next: string | null }>(sql`
      SELECT next_attempt_at::text AS next FROM public.file_scans WHERE failure = 'too_large'`);
    expect(tooLarge).toEqual([{ next: null }]);
    clamd.mode = "detect";
  });

  it("quarantines an infected file, logs it, shares it across assets and never serves it", async () => {
    clamd.mode = "detect";
    const body = Buffer.from(`An invented attachment. ${FAKE_VIRUS_MARKER} The end.`);
    const first = await add(scanned.base, ids.a ?? "", body, "attachment.txt");
    await scanned.service.scanQueuedFiles();
    expect(await scanRow({ asset: ids.a ?? "", file: first })).toEqual([
      { state: "infected", failure: null, signature: FAKE_SIGNATURE, attempts: 0, due: null },
    ]);
    // The same bytes on another asset: one content, one state, no new scan.
    const scansBefore = clamd.connections();
    const second = await add(scanned.base, ids.b ?? "", body, "copy of attachment.txt");
    await scanned.service.scanQueuedFiles();
    expect(clamd.connections()).toBe(scansBefore);
    expect((await listed(scanned.base, ids.b ?? ""))[second]).toBe("infected");
    for (const [asset, file] of [
      [ids.a ?? "", first],
      [ids.b ?? "", second],
    ] as const) {
      for (const what of ["content", "view", "thumbnail"]) {
        const r = await send(scanned.base, content(asset, file, what), { as: "cataloger" });
        expect([r.status, r.json], what).toEqual([423, { error: "quarantined" }]);
      }
    }
    // Logged in the scan log (the content, the signature, who: the queue).
    const events = await w.db.rows<{ kind: string; signature: string | null; actor: string }>(sql`
      SELECT e.kind, e.signature, e.actor FROM public.file_scan_events e
      JOIN public.stored_files f ON f.organization_id = e.organization_id AND f.sha256 = e.sha256
      WHERE f.id = ${first}::uuid`);
    expect(events).toEqual([
      { kind: "infected", signature: FAKE_SIGNATURE, actor: "system:virus-scan" },
    ]);
    // The blob stays on disk, where it was.
    const sha = await w.db.rows<{ sha256: string }>(sql`
      SELECT sha256 FROM public.stored_files WHERE id = ${first}::uuid`);
    expect(existsSync(store.pathFor(w.a, sha[0]?.sha256 ?? ""))).toBe(true);
    // The database keeps the quarantine and the row, whatever a writer asks.
    await expect(
      w.db.execute(sql`UPDATE public.file_scans SET state = 'clean', signature = NULL,
        quarantined_at = NULL WHERE sha256 = ${sha[0]?.sha256 ?? ""}`),
    ).rejects.toThrow(/stays quarantined/);
    await expect(
      w.db.execute(sql`DELETE FROM public.file_scans WHERE sha256 = ${sha[0]?.sha256 ?? ""}`),
    ).rejects.toThrow(/never removed/);
    await expect(w.db.execute(sql`TRUNCATE public.file_scan_events`)).rejects.toThrow();
    ids.infectedA = first;
    ids.infectedB = second;
  });

  it("shares a clean result across assets holding the same bytes", async () => {
    const body = Buffer.from("An invented, harmless shared page.");
    const one = await add(scanned.base, ids.b ?? "", body, "shared.txt");
    await scanned.service.scanQueuedFiles();
    const scansBefore = clamd.connections();
    const two = await add(scanned.base, ids.c ?? "", body, "shared again.txt");
    await scanned.service.scanQueuedFiles();
    expect(clamd.connections()).toBe(scansBefore);
    expect((await listed(scanned.base, ids.b ?? ""))[one]).toBe("clean");
    expect((await listed(scanned.base, ids.c ?? ""))[two]).toBe("clean");
    const rows = await w.db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.file_scans s
      JOIN (SELECT DISTINCT organization_id, sha256 FROM public.stored_files
            WHERE id IN (${one}::uuid, ${two}::uuid)) f
        ON f.organization_id = s.organization_id AND f.sha256 = s.sha256`);
    expect(rows).toEqual([{ n: 1 }]);
    expect((await send(scanned.base, content(ids.c ?? "", two), { as: "cataloger" })).status).toBe(
      200,
    );
  });

  it("keeps hidden files hidden: another organization's is the same 404", async () => {
    const r = await send(scanned.base, content(ids.a ?? "", ids.infectedA ?? ""), {
      as: "stranger",
    });
    expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
  });

  it("shows system managers the status and lets them rescan; nobody else", async () => {
    const status = await send(scanned.base, "/api/system/file-scans", { as: "root" });
    expect(status.status).toBe(200);
    expect(status.json.scanning).toBe(true);
    const counts = status.json.counts as Record<string, number>;
    expect(counts.infected).toBe(1);
    expect(counts.clean).toBeGreaterThanOrEqual(3);
    for (const who of ["cataloger", "manager"]) {
      expect((await send(scanned.base, "/api/system/file-scans", { as: who })).status, who).toBe(
        403,
      );
      const r = await send(scanned.base, "/api/system/file-scans/rescan", {
        as: who,
        method: "POST",
        body: Buffer.from("{}"),
        headers: { "content-type": "application/json" },
      });
      expect(r.status, who).toBe(403);
    }
    const scansBefore = clamd.connections();
    const rescan = await send(scanned.base, "/api/system/file-scans/rescan", {
      as: "root",
      method: "POST",
      body: Buffer.from("{}"),
      headers: { "content-type": "application/json" },
    });
    expect(rescan.status).toBe(200);
    // Every clean and failed content (the too-large one included); not the infected one.
    expect(rescan.json.queued).toBe((counts.clean ?? 0) + (counts.failed ?? 0));
    await scanned.service.scanQueuedFiles();
    expect(clamd.connections()).toBeGreaterThan(scansBefore);
    expect((await scanRow({ asset: ids.a ?? "", file: ids.infectedA ?? "" }))[0]?.state).toBe(
      "infected",
    );
    expect((await scanRow({ asset: ids.a ?? "", file: ids.cleanFile ?? "" }))[0]?.state).toBe(
      "clean",
    );
    const logs = await w.db.rows<{ kind: string; queued: number; actor: string }>(sql`
      SELECT kind, queued, actor FROM public.file_scan_events WHERE kind = 'rescan'`);
    expect(logs).toEqual([{ kind: "rescan", queued: rescan.json.queued, actor: `user:${w.root}` }]);
  });

  it("queues files attached before scanning was set up", async () => {
    const body = Buffer.from("An invented page uploaded while scanning was off.");
    const file = await add(plain.base, ids.c ?? "", body, "before.txt");
    expect(await scanRow({ asset: ids.c ?? "", file })).toEqual([]);
    // With a scanner it has no result yet: pending, not served.
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("pending");
    expect((await send(scanned.base, content(ids.c ?? "", file), { as: "cataloger" })).status).toBe(
      409,
    );
    const pass = await scanned.service.scanQueuedFiles();
    expect(pass.queued).toBe(1);
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("clean");
  });
});

describe("without a scanner", () => {
  it("lists files as not scanned and serves them as before", async () => {
    const body = Buffer.from("An invented note uploaded without a scanner.");
    const file = await add(plain.base, ids.b ?? "", body, "note.txt");
    expect((await listed(plain.base, ids.b ?? ""))[file]).toBe("not_scanned");
    const r = await send(plain.base, content(ids.b ?? "", file), { as: "cataloger" });
    expect(r.status).toBe(200);
    expect(r.body.equals(body)).toBe(true);
    // Clean results found earlier still show as clean.
    expect((await listed(plain.base, ids.a ?? ""))[ids.cleanFile ?? ""]).toBe("clean");
  });

  it("still never serves a file found infected earlier", async () => {
    expect((await listed(plain.base, ids.b ?? ""))[ids.infectedB ?? ""]).toBe("infected");
    const r = await send(plain.base, content(ids.b ?? "", ids.infectedB ?? ""), {
      as: "cataloger",
    });
    expect([r.status, r.json]).toEqual([423, { error: "quarantined" }]);
  });

  it("says scanning is off, and refuses a rescan", async () => {
    const status = await send(plain.base, "/api/system/file-scans", { as: "root" });
    expect(status.json.scanning).toBe(false);
    const r = await send(plain.base, "/api/system/file-scans/rescan", {
      as: "root",
      method: "POST",
      body: Buffer.from("{}"),
      headers: { "content-type": "application/json" },
    });
    expect([r.status, r.json]).toEqual([409, { error: "scanning_off" }]);
  });
});

describe("logs", () => {
  it("logged no unexpected errors", () => {
    expect(logged.filter((r) => r.event === "service_error")).toEqual([]);
  });
});
