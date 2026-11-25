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
import type { Readable } from "node:stream";
import {
  claimDueScan,
  queueScan,
  queueUnscanned,
  recordScanResult,
  rescanContents,
  sql,
} from "@oculus/db";
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
  s: {
    as?: string;
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
    /** Sent in chunks without a Content-Length. */
    chunked?: boolean;
  } = {},
): Promise<Reply> {
  const method = s.method ?? "GET";
  const token = s.as === undefined ? undefined : tokens[s.as];
  const headers: Record<string, string> = { host: "localhost", origin: ORIGIN, ...s.headers };
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if (method !== "GET" && method !== "HEAD" && token !== undefined) {
    headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  }
  if (s.body !== undefined && s.chunked !== true) {
    headers["content-length"] = String(s.body.length);
  }
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
    req.on("error", (error: NodeJS.ErrnoException) => {
      // A refused upload may close before the whole body is written.
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      reject(error);
    });
    if (s.chunked === true && s.body !== undefined) {
      for (let at = 0; at < s.body.length; at += 64 * 1024) {
        req.write(s.body.subarray(at, at + 64 * 1024));
      }
      req.end();
    } else {
      req.end(s.body);
    }
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
async function add(
  to: Base,
  asset: string,
  body: Buffer,
  name: string,
  as = "cataloger",
): Promise<string> {
  const r = await send(to, `/api/records/${asset}/files`, {
    as,
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

/** Asks for a rescan as someone. */
function rescanAs(who: string): Promise<Reply> {
  return send(scanned.base, "/api/system/file-scans/rescan", {
    as: who,
    method: "POST",
    body: Buffer.from("{}"),
    headers: { "content-type": "application/json" },
  });
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
    // The too-large one isn't tried again: counted on its own.
    expect(counts.failedTooLarge).toBe(1);
    for (const who of ["cataloger", "manager"]) {
      expect((await send(scanned.base, "/api/system/file-scans", { as: who })).status, who).toBe(
        403,
      );
      expect((await rescanAs(who)).status, who).toBe(403);
    }
    // A scanner that hangs: the rescan's scans stay unfinished for a while.
    clamd.mode = "silent";
    const scansBefore = clamd.connections();
    const rescan = await rescanAs("root");
    expect(rescan.status).toBe(200);
    // Every content a stored file names but the infected one.
    expect(rescan.json.queued).toBe(
      (counts.clean ?? 0) + (counts.failed ?? 0) + (counts.failedTooLarge ?? 0),
    );
    // Clean files stay clean, and served, while they wait (review S2).
    expect((await listed(scanned.base, ids.a ?? ""))[ids.cleanFile ?? ""]).toBe("clean");
    expect(
      (await send(scanned.base, content(ids.a ?? "", ids.cleanFile ?? ""), { as: "cataloger" }))
        .status,
    ).toBe(200);
    const waiting = await send(scanned.base, "/api/system/file-scans", { as: "root" });
    expect((waiting.json.counts as Record<string, number>).rescanning).toBe(counts.clean);
    // Their scans time out: still clean and served, tried again later.
    await scanned.service.scanQueuedFiles();
    expect(
      (await send(scanned.base, content(ids.a ?? "", ids.cleanFile ?? ""), { as: "cataloger" }))
        .status,
    ).toBe(200);
    const rescanned = await w.db.rows<{ state: string; failure: string | null; queued: boolean }>(
      sql`SELECT s.state, s.failure, s.rescan_requested_at IS NOT NULL AS queued
          FROM public.file_scans s JOIN public.stored_files f
            ON f.organization_id = s.organization_id AND f.sha256 = s.sha256
          WHERE f.id = ${ids.cleanFile ?? ""}::uuid`,
    );
    expect(rescanned).toEqual([{ state: "clean", failure: "timeout", queued: true }]);
    // Then the scanner answers: clean again, no longer waiting.
    clamd.mode = "detect";
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
      WHERE next_attempt_at IS NOT NULL`);
    await scanned.service.scanQueuedFiles();
    expect(clamd.connections()).toBeGreaterThan(scansBefore);
    expect((await scanRow({ asset: ids.a ?? "", file: ids.infectedA ?? "" }))[0]?.state).toBe(
      "infected",
    );
    expect((await scanRow({ asset: ids.a ?? "", file: ids.cleanFile ?? "" }))[0]).toMatchObject({
      state: "clean",
      failure: null,
      due: null,
    });
    const logs = await w.db.rows<{ kind: string; queued: number; actor: string }>(sql`
      SELECT kind, queued, actor FROM public.file_scan_events WHERE kind = 'rescan'`);
    expect(logs).toEqual([{ kind: "rescan", queued: rescan.json.queued, actor: `user:${w.root}` }]);
  });

  it("takes a file away after a rescan only when it is now found infected", async () => {
    const body = Buffer.from(`An invented page, clean at first. ${FAKE_VIRUS_MARKER}`);
    clamd.mode = "ok";
    const file = await add(scanned.base, ids.b ?? "", body, "later found.txt");
    await scanned.service.scanQueuedFiles();
    expect((await listed(scanned.base, ids.b ?? ""))[file]).toBe("clean");
    // New signatures: the same bytes are now found.
    clamd.mode = "detect";
    expect((await rescanAs("root")).status).toBe(200);
    await scanned.service.scanQueuedFiles();
    expect((await listed(scanned.base, ids.b ?? ""))[file]).toBe("infected");
    const r = await send(scanned.base, content(ids.b ?? "", file), { as: "cataloger" });
    expect([r.status, r.json]).toEqual([423, { error: "quarantined" }]);
  });

  it("doesn't lose a rescan asked for while the content is being scanned (review S3)", async () => {
    const file = await add(
      plain.base,
      ids.c ?? "",
      Buffer.from("An invented page scanned while a rescan comes in."),
      "race.txt",
    );
    const [sha] = await w.db.rows<{ sha256: string }>(sql`
      SELECT sha256 FROM public.stored_files WHERE id = ${file}::uuid`);
    const hash = sha?.sha256 ?? "";
    await w.db.transaction((tx) => queueScan(tx, w.a, hash));
    // Only this content due, so the claim takes it.
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp() + interval '1 hour'
      WHERE sha256 <> ${hash} AND next_attempt_at IS NOT NULL`);
    const claimed = await claimDueScan(w.db, 60);
    expect(claimed?.sha256).toBe(hash);
    // A rescan comes in while it is scanned…
    await w.db.transaction((tx) => rescanContents(tx, w.a, `user:${w.root}`));
    // …and a second worker can't take it meanwhile, although the rescan made
    // it due, nor after an upload queues it (review L-a: the lease holds).
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp() + interval '1 hour'
      WHERE sha256 <> ${hash} AND next_attempt_at IS NOT NULL`);
    expect(await claimDueScan(w.db, 60)).toBeUndefined();
    await w.db.transaction((tx) => queueScan(tx, w.a, hash));
    expect(await claimDueScan(w.db, 60)).toBeUndefined();
    // The clean answer from before the rescan isn't stored, and nothing is
    // written (review M2): the row stays as the rescan left it.
    const before = await w.db.rows(sql`
      SELECT state, generation, next_attempt_at, leased_until, updated_at FROM public.file_scans
      WHERE organization_id = ${w.a}::uuid AND sha256 = ${hash}`);
    const recorded = await w.db.transaction((tx) =>
      recordScanResult(
        tx,
        w.a,
        hash,
        { state: "clean" },
        "system:virus-scan",
        claimed?.generation ?? 0,
      ),
    );
    expect(recorded).toBe("stale");
    const after = await w.db.rows(sql`
      SELECT state, generation, next_attempt_at, leased_until, updated_at FROM public.file_scans
      WHERE organization_id = ${w.a}::uuid AND sha256 = ${hash}`);
    expect(after).toEqual(before);
    const [row] = await w.db.rows<{ state: string; due: boolean }>(sql`
      SELECT state, next_attempt_at <= clock_timestamp() AS due FROM public.file_scans
      WHERE organization_id = ${w.a}::uuid AND sha256 = ${hash}`);
    expect(row).toEqual({ state: "pending", due: true });
    // Once the lease runs out (here: ended by hand), it is taken again.
    await w.db.execute(sql`
      UPDATE public.file_scans SET leased_until = NULL WHERE sha256 = ${hash}`);
    // An infected verdict is stored even after a later rescan: it takes the file away.
    const again = await claimDueScan(w.db, 60);
    expect(again?.sha256).toBe(hash);
    await w.db.transaction((tx) => rescanContents(tx, w.a, `user:${w.root}`));
    expect(
      await w.db.transaction((tx) =>
        recordScanResult(
          tx,
          w.a,
          hash,
          { state: "infected", signature: FAKE_SIGNATURE },
          "system:virus-scan",
          again?.generation ?? 0,
        ),
      ),
    ).toBe("stored");
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("infected");
    expect(
      (await w.db.rows(sql`SELECT leased_until FROM public.file_scans WHERE sha256 = ${hash}`))[0],
    ).toEqual({ leased_until: null });
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
      WHERE next_attempt_at IS NOT NULL`);
  });

  it("refuses an upload larger than the scanner takes, declared or not (review S1)", async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x63);
    const r = await send(scanned.base, `/api/records/${ids.a ?? ""}/files`, {
      as: "cataloger",
      method: "POST",
      body: big,
      headers: {
        "content-type": "application/octet-stream",
        "if-match": '"v1"',
        [FILE_NAME_HEADER]: "big.bin",
      },
    });
    expect([r.status, r.json]).toEqual([413, { error: "too_large_to_scan" }]);
    const chunked = await send(scanned.base, `/api/records/${ids.a ?? ""}/files`, {
      as: "cataloger",
      method: "POST",
      body: big,
      chunked: true,
      headers: {
        "content-type": "application/octet-stream",
        "if-match": '"v1"',
        [FILE_NAME_HEADER]: "big.bin",
      },
    });
    expect([chunked.status, chunked.json]).toEqual([413, { error: "too_large_to_scan" }]);
    const rows = await w.db.rows(sql`
      SELECT 1 FROM public.stored_files WHERE original_name = 'big.bin'`);
    expect(rows).toEqual([]);
    // The list tells the admin the scanner's limit, so it refuses before sending.
    const list = await send(scanned.base, `/api/records/${ids.a ?? ""}/files`, { as: "cataloger" });
    expect(list.json.maxFileBytes).toBe(1024 * 1024);
    const plainList = await send(plain.base, `/api/records/${ids.a ?? ""}/files`, {
      as: "cataloger",
    });
    expect(plainList.json.maxFileBytes).toBe(8 * 1024 * 1024);
  });

  it("keeps serving files from before scanning was turned on until their first scan", async () => {
    const body = Buffer.from("An invented page uploaded while scanning was off.");
    const file = await add(plain.base, ids.c ?? "", body, "before.txt");
    expect(await scanRow({ asset: ids.c ?? "", file })).toEqual([]);
    // With a scanner it has no result yet: not yet scanned, still served.
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("not_yet_scanned");
    expect((await send(scanned.base, content(ids.c ?? "", file), { as: "cataloger" })).status).toBe(
      200,
    );
    // Queued as unscanned; a failed first scan leaves it served.
    clamd.mode = "silent";
    const failedPass = await scanned.service.scanQueuedFiles();
    expect(failedPass.queued).toBe(1);
    expect((await scanRow({ asset: ids.c ?? "", file }))[0]).toMatchObject({
      state: "unscanned",
      failure: "timeout",
    });
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("not_yet_scanned");
    expect((await send(scanned.base, content(ids.c ?? "", file), { as: "cataloger" })).status).toBe(
      200,
    );
    clamd.mode = "detect";
    await dueNow();
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
      WHERE state = 'unscanned'`);
    const pass = await scanned.service.scanQueuedFiles();
    // Each pass counts its own scans (review L4).
    expect(pass.clean).toBeGreaterThanOrEqual(1);
    expect((await listed(scanned.base, ids.c ?? ""))[file]).toBe("clean");
  });

  it("makes the same bytes uploaded again wait for their scan, even if stored before", async () => {
    const body = Buffer.from("An invented page from before scanning, uploaded again.");
    const before = await add(plain.base, ids.a ?? "", body, "old.txt");
    await w.db.transaction((tx) => queueUnscanned(tx, 100));
    expect((await listed(scanned.base, ids.a ?? ""))[before]).toBe("not_yet_scanned");
    clamd.mode = "silent";
    const again = await add(scanned.base, ids.b ?? "", body, "old again.txt");
    expect((await listed(scanned.base, ids.b ?? ""))[again]).toBe("pending");
    expect(
      (await send(scanned.base, content(ids.b ?? "", again), { as: "cataloger" })).status,
    ).toBe(409);
    await scanned.service.scanQueuedFiles();
    clamd.mode = "detect";
    await dueNow();
    await scanned.service.scanQueuedFiles();
    expect((await listed(scanned.base, ids.b ?? ""))[again]).toBe("clean");
  });

  it("lets organizations take turns in the queue (review L6)", async () => {
    const theirs = await makeAs(w, w.b, w.b1, assetDraft("An invented library letter"));
    await add(
      plain.base,
      theirs,
      Buffer.from("An invented library page."),
      "library.txt",
      "stranger",
    );
    for (let i = 0; i < 3; i++) {
      await add(
        plain.base,
        ids.a ?? "",
        Buffer.from(`An invented archive page ${String(i)}.`),
        `a${String(i)}.txt`,
      );
    }
    await w.db.transaction((tx) => queueUnscanned(tx, 100));
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
      WHERE state = 'unscanned'`);
    const first = await claimDueScan(w.db, 60, w.a);
    expect(first?.organizationId).toBe(w.b);
    const second = await claimDueScan(w.db, 60, w.b);
    expect(second?.organizationId).toBe(w.a);
    // Scanned in the end, every one (the two leases ended by hand).
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp(), leased_until = NULL
      WHERE next_attempt_at IS NOT NULL`);
    await scanned.service.scanQueuedFiles();
    const left = await w.db.rows(sql`
      SELECT 1 FROM public.file_scans WHERE state = 'unscanned'`);
    expect(left).toEqual([]);
  });

  it("queues the scan when the same asset gets the same bytes again (review L-b)", async () => {
    const body = Buffer.from("An invented page from before scanning, added to its asset again.");
    const first = await add(plain.base, ids.c ?? "", body, "twice.txt");
    await w.db.transaction((tx) => queueUnscanned(tx, 100));
    expect((await listed(scanned.base, ids.c ?? ""))[first]).toBe("not_yet_scanned");
    clamd.mode = "silent";
    const r = await send(scanned.base, `/api/records/${ids.c ?? ""}/files`, {
      as: "cataloger",
      method: "POST",
      body,
      headers: {
        "content-type": "application/octet-stream",
        "if-match": '"v1"',
        [FILE_NAME_HEADER]: "twice again.txt",
      },
    });
    expect([r.status, (r.json.file as { id: string }).id]).toEqual([200, first]);
    // Uploaded again, it waits for its scan like any new upload (D-113).
    expect((await listed(scanned.base, ids.c ?? ""))[first]).toBe("pending");
    await scanned.service.scanQueuedFiles();
    clamd.mode = "detect";
    await dueNow();
    await scanned.service.scanQueuedFiles();
    expect((await listed(scanned.base, ids.c ?? ""))[first]).toBe("clean");
  });

  it("serves old files too large to scan, and says so (review M1)", async () => {
    // Stored before scanning, larger than the scanner's 1 MiB.
    const big = Buffer.alloc(1024 * 1024 + 100, 0x64);
    const file = await add(plain.base, ids.b ?? "", big, "big old scan.tif");
    await w.db.transaction((tx) => queueUnscanned(tx, 100));
    await w.db.execute(sql`
      UPDATE public.file_scans SET next_attempt_at = clock_timestamp()
      WHERE next_attempt_at IS NOT NULL`);
    await scanned.service.scanQueuedFiles();
    expect((await scanRow({ asset: ids.b ?? "", file }))[0]).toMatchObject({
      state: "unscanned",
      failure: "too_large",
      due: null,
    });
    const list = await send(scanned.base, `/api/records/${ids.b ?? ""}/files`, {
      as: "cataloger",
    });
    const entry = (list.json.files as { id: string; scan: string; scanQueued: boolean }[]).find(
      (f) => f.id === file,
    );
    expect(entry).toMatchObject({ scan: "too_large_to_scan", scanQueued: false });
    const r = await send(scanned.base, content(ids.b ?? "", file), { as: "cataloger" });
    expect(r.status).toBe(200);
    const status = await send(scanned.base, "/api/system/file-scans", { as: "root" });
    const counts = status.json.counts as Record<string, number>;
    expect(counts.tooLargeToScan).toBe(1);

    // A clean file, after the scanner's limit is lowered below its size.
    const lowered = createService(w.db, {
      files: store,
      scanner: clamdScanner({ address: clamd.address, timeoutMs: 600, streamMaxBytes: 10 }),
    });
    const low = await serve(lowered);
    try {
      expect((await listed(low.base, ids.a ?? ""))[ids.cleanFile ?? ""]).toBe("too_large_to_scan");
      expect(
        (await send(low.base, content(ids.a ?? "", ids.cleanFile ?? ""), { as: "cataloger" }))
          .status,
      ).toBe(200);
      const lowStatus = await send(low.base, "/api/system/file-scans", { as: "root" });
      expect(
        (lowStatus.json.counts as Record<string, number>).tooLargeToScan,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await lowered.stopFileScans();
      await low.app.close();
    }
  });

  it("starts every row queued and keeps an infected signature fixed (review L2)", async () => {
    const hash = "f".repeat(64);
    await expect(
      w.db.execute(sql`INSERT INTO public.file_scans (organization_id, sha256, state)
        VALUES (${w.a}::uuid, ${hash}, 'clean')`),
    ).rejects.toThrow(/starts queued/);
    await expect(
      w.db.execute(sql`INSERT INTO public.file_scans (organization_id, sha256, state, attempts)
        VALUES (${w.a}::uuid, ${hash}, 'pending', 3)`),
    ).rejects.toThrow(/starts queued/);
    await expect(
      w.db.execute(sql`UPDATE public.file_scans SET signature = 'Something.Else'
        WHERE state = 'infected'`),
    ).rejects.toThrow(/stays quarantined/);
  });

  it("closes the file it scanned, whatever the scanner did with it (review L3)", async () => {
    const opened: Readable[] = [];
    const lazy = createService(w.db, {
      files: store,
      scanner: {
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
        // Reads nothing and answers clean.
        scan: (source) => {
          opened.push(source);
          return Promise.resolve({ ok: true, verdict: "clean" });
        },
      },
    });
    await add(
      plain.base,
      ids.c ?? "",
      Buffer.from("An invented page for the lazy scanner."),
      "lazy.txt",
    );
    await lazy.scanQueuedFiles();
    await lazy.stopFileScans();
    expect(opened.length).toBeGreaterThanOrEqual(1);
    for (const source of opened) expect(source.destroyed).toBe(true);
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
