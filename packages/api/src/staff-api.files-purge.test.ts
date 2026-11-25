// The safe purge of removed files (S-052, D-086), against a fresh migrated
// database and a throwaway files folder (never OCULUS_FILES_DIR): a dry run
// changing nothing; the two steps (to the trash after 7 days by the
// database's clock and the file system's, deleted a day later by both),
// thumbnails going with their copy, and the change log; clock skew between
// the app, the database and the file system; restoring from the trash on an
// upload; an upload during a purge; a lease that runs out or moves in the
// middle of a run, and one moved by another database putting the trash
// back; the fifth review's RV1 and RV2 (a dump taken while its epoch still
// matched the folder's, used after production attached the content again);
// the admin's routes (system managers, a recent sign-in, the change log);
// and the timer off unless turned on. Every person, record and file is
// invented.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
import {
  openDatabase,
  purgeCandidates,
  databaseIdentity,
  readAuditTrail,
  readFileStoreLease,
  queueScan,
  sql,
  Sql,
  type Database,
} from "@oculus/db";
import {
  ADOPT_QUIET_MS,
  AUTOMATIC_PURGE_EVERY_MS,
  LEASE_LOCK,
  LeaseLockBusy,
  hostKey,
  leaseGenerations,
  STORE_MARKER,
  createService,
  openFileStore,
  type FileStore,
  type RecordService,
} from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { createDatabase, dropDatabase, withDatabaseName } from "../../db/src/client.js";
import { findTools } from "../../db/src/backup.js";
import { testServerUrl } from "../../db/src/test-database.fixtures.js";
import { actorOf } from "../../service/src/people.fixtures.js";
import { automaticPurgeFromEnv } from "./admin-server.js";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  INC,
  ageSession,
  fullSession,
  makeAs,
  makeWorld,
  type World,
} from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const DAY = 86_400_000;

let w: World;
let dir: string;
let store: FileStore;
let service: RecordService;
let app: FastifyInstance;
let asset: string;
const tokens: Record<string, string> = {};

const assetDraft = (title: string) => ({
  kind: "digital_asset",
  mediaType: "image/tiff",
  title,
  templateKey: "t-asset",
  fields: { rights: { uri: INC } },
});

beforeAll(async () => {
  w = await makeWorld();
  dir = mkdtempSync(join(tmpdir(), "oculus-files-purge-"));
  store = await openFileStore({ dir });
  service = createService(w.db, { files: store });
  expect(await service.bindFileStore()).toEqual({ ok: true });
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service, files: store, log: () => undefined }),
  });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  // A system manager whose password was given 11 minutes ago.
  const stale = await fullSession(w.db, w.root, w.a);
  await ageSession(w.db, stale.sessionId, 11 * 60);
  tokens.stale = stale.token;
  asset = await makeAs(w, w.a, w.a1, assetDraft("An invented purge scan"));
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (n = 700) => Buffer.concat([Buffer.from("invented purge bytes "), randomBytes(n)]);
const ctx = () => ({ organizationId: w.a, actor: actorOf(w.root) });
const copyOf = (body: Buffer) => store.pathFor(w.a, sha(body));
const has = (body: Buffer) => existsSync(copyOf(body)) && readFileSync(copyOf(body)).equals(body);
const trashOf = (body: Buffer) => join(dir, w.a, "trash", sha(body));

/** Attaches bytes to an asset through the service (as an upload would); the file's ID. */
async function attach(
  body: Buffer,
  to: string = asset,
  via: RecordService = service,
): Promise<string> {
  const received = await store.receive(
    w.a,
    (async function* () {
      await Promise.resolve();
      yield body;
    })(),
  );
  if (!received.ok) throw new Error(received.code);
  const done = await via.attachFile(ctx(), to as never, received.file, {
    name: "invented.bin",
    expectedVersion: 1,
  });
  if (!done.ok) throw new Error(JSON.stringify(done.issues));
  return done.value.file.id;
}

async function remove(fileId: string, via: RecordService = service): Promise<void> {
  const done = await via.removeFile(ctx(), asset as never, fileId, { expectedVersion: 1 });
  if (!done.ok) throw new Error(JSON.stringify(done.issues));
}

/** Sets a stored copy's time `days` back (by the file system: its mtime). */
function ageCopy(body: Buffer, days: number): void {
  const past = new Date(Date.now() - days * DAY);
  utimesSync(copyOf(body), past, past);
}

/** Moves a content's file events back (the database's clock), as the owner. */
async function ageEvents(db: Database, body: Buffer, days: number): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.stored_file_events DISABLE TRIGGER stored_file_events_append_only`,
    );
    await q.execute(sql`
      UPDATE public.stored_file_events SET occurred_at = occurred_at - make_interval(days => ${days})
      WHERE sha256 = ${sha(body)}`);
    await q.execute(
      sql`ALTER TABLE public.stored_file_events ENABLE ALWAYS TRIGGER stored_file_events_append_only`,
    );
  });
}

/** Moves a content's purge steps back by `hours` (the database's clock). */
async function ageSteps(db: Database, body: Buffer | undefined, hours: number): Promise<void> {
  const hash = body === undefined ? null : sha(body);
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.file_purge_steps DISABLE TRIGGER file_purge_steps_append_only`,
    );
    await q.execute(sql`
      UPDATE public.file_purge_steps SET occurred_at = occurred_at - make_interval(hours => ${hours})
      WHERE ${hash}::text IS NULL OR sha256 = ${hash}::text`);
    await q.execute(
      sql`ALTER TABLE public.file_purge_steps ENABLE ALWAYS TRIGGER file_purge_steps_append_only`,
    );
  });
}

/** Moves a trashed content's mark back by `hours` (the file system's clock). */
function ageMark(body: Buffer, hours: number): void {
  const past = new Date(Date.now() - hours * 3600_000);
  utimesSync(join(trashOf(body), "marked"), past, past);
}

/** A file attached, its copy last used `copyDays` ago, removed, the removal `dbDays` old. */
async function removedLongAgo(
  { copyDays = 10, dbDays = 8 }: { copyDays?: number; dbDays?: number } = {},
  db: Database = w.db,
): Promise<{ body: Buffer; fileId: string }> {
  const body = bytes();
  const fileId = await attach(body);
  ageCopy(body, copyDays);
  await remove(fileId);
  await ageEvents(db, body, dbDays);
  return { body, fileId };
}

async function purge(apply = true, via: RecordService = service) {
  const result = await via.purgeFiles({ apply });
  if (!result.ok) throw new Error(result.problem);
  return result.value;
}

/** Ends a test with nothing left in the trash: ages every step and mark, and runs the purge. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await ageSteps(w.db, undefined, 25);
    const bin = join(dir, w.a, "trash");
    if (existsSync(bin)) {
      const past = new Date(Date.now() - 25 * 3600_000);
      for (const name of readdirSync(bin)) utimesSync(join(bin, name, "marked"), past, past);
    }
    await purge();
  }
  expect(await store.trashEntries(w.a)).toEqual([]);
}

describe("the purge's steps", () => {
  it("a dry run says what a step would do and changes nothing", async () => {
    const { body } = await removedLongAgo();
    const marker = readFileSync(join(dir, STORE_MARKER), "utf8");
    const epoch = (await readFileStoreLease(w.db))?.epoch;
    const report = await purge(false);
    expect(report).toMatchObject({
      dryRun: true,
      trashed: { files: 1, bytes: body.length },
      deleted: { files: 0 },
      waiting: { files: 1, bytes: body.length },
    });
    // Nothing changed: the marker, the lease, the copy, the log.
    expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(marker);
    expect((await readFileStoreLease(w.db))?.epoch).toBe(epoch);
    expect(has(body)).toBe(true);
    expect(existsSync(join(dir, w.a, "trash"))).toBe(false);
    const steps = await w.db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.file_purge_steps`,
    );
    expect(steps[0]?.n).toBe(0);
    const logged = await w.db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.system_events`,
    );
    expect(logged[0]?.n).toBe(0);
    await drain();
  });

  it("moves a copy to the trash with its thumbnails, deletes it a day later by both clocks, and logs each step", async () => {
    const { body } = await removedLongAgo();
    const kept = bytes();
    await attach(kept);
    ageCopy(kept, 30);
    // A cached thumbnail of the removed content.
    await store.writeThumbnail(w.a, sha(body), "small", "none");
    const before = (await readFileStoreLease(w.db))?.epoch;
    const started = (await w.db.rows<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`))[0]
      ?.t;
    const first = await purge();
    expect(first).toMatchObject({ dryRun: false, trashed: { files: 1 }, deleted: { files: 0 } });
    // The lease moved: the run took it.
    expect((await readFileStoreLease(w.db))?.epoch).not.toBe(before);
    expect((await readFileStoreLease(w.db))?.kind).toBe("purge");
    expect(existsSync(copyOf(body))).toBe(false);
    expect(readFileSync(join(trashOf(body), "content")).equals(body)).toBe(true);
    expect(readdirSync(trashOf(body)).sort()).toEqual([
      "content",
      "marked",
      "thumbnail-small-v1.none",
    ]);
    expect(await store.readThumbnail(w.a, sha(body), "small")).toBeUndefined();
    // A file still attached is never touched, however old its copy.
    expect(has(kept)).toBe(true);
    // Not a day yet: a second run deletes nothing.
    expect((await purge()).deleted.files).toBe(0);
    await ageSteps(w.db, body, 25);
    ageMark(body, 25);
    const second = await purge();
    expect(second.deleted).toEqual({ files: 1, bytes: body.length });
    expect(existsSync(trashOf(body))).toBe(false);
    expect(existsSync(copyOf(body))).toBe(false);
    expect(has(kept)).toBe(true);
    // The steps and the change log.
    const steps = await w.db.rows<{ kind: string; actor: string }>(sql`
      SELECT kind, actor FROM public.file_purge_steps WHERE sha256 = ${sha(body)}
      ORDER BY occurred_at`);
    expect(steps).toEqual([
      { kind: "trashed", actor: "system:files-purge" },
      { kind: "deleted", actor: "system:files-purge" },
    ]);
    const log = await w.db.rows<{ kind: string; file_count: number; byte_count: string }>(sql`
      SELECT kind, file_count, byte_count::text AS byte_count FROM public.system_events
      WHERE occurred_at >= ${started ?? null}::timestamptz ORDER BY occurred_at`);
    expect(log).toEqual([
      { kind: "files_trashed", file_count: 1, byte_count: String(body.length) },
      { kind: "files_deleted", file_count: 1, byte_count: String(body.length) },
    ]);
    const trail = await readAuditTrail(
      w.db,
      w.a,
      { records: [], people: [], system: true },
      { from: started ?? "" },
    );
    expect(
      trail.entries.map((e) => (e.type === "system" ? [e.kind, e.files, e.bytes] : e.type)),
    ).toEqual([
      ["files_deleted", 1, body.length],
      ["files_trashed", 1, body.length],
    ]);
    await drain();
  });

  it("goes by the database's clock and the file system's, never the app's (clock skew)", async () => {
    // The app's clock 30 days ahead decides nothing.
    const skewed = createService(w.db, {
      files: store,
      now: () => new Date(Date.now() + 30 * DAY),
    });
    const fresh = bytes();
    await remove(await attach(fresh));
    expect((await skewed.purgeFiles({ apply: true })).ok).toBe(true);
    expect(has(fresh)).toBe(true);
    // The database says 8 days, the file system says just now: kept.
    const dbOld = bytes();
    await remove(await attach(dbOld));
    await ageEvents(w.db, dbOld, 8);
    // The file system says 10 days, the database just now: kept.
    const fsOld = bytes();
    const fsId = await attach(fsOld);
    ageCopy(fsOld, 10);
    await remove(fsId);
    expect((await purge()).trashed.files).toBe(0);
    expect(has(dbOld) && has(fsOld)).toBe(true);
    // Both old: to the trash.
    await ageEvents(w.db, fsOld, 8);
    expect((await purge()).trashed.files).toBe(1);
    expect(existsSync(copyOf(fsOld))).toBe(false);
    // Step 2 the same way: a day by the database only, then by the file system only.
    await ageSteps(w.db, fsOld, 25);
    expect((await purge()).deleted.files).toBe(0);
    await ageSteps(w.db, fsOld, -25);
    ageMark(fsOld, 25);
    expect((await purge()).deleted.files).toBe(0);
    expect(existsSync(join(trashOf(fsOld), "content"))).toBe(true);
    await ageSteps(w.db, fsOld, 25);
    expect((await purge()).deleted.files).toBe(1);
    expect(existsSync(trashOf(fsOld))).toBe(false);
    await drain();
  });

  it("an upload of a trashed content brings it back, and a later step records it", async () => {
    const { body } = await removedLongAgo();
    expect((await purge()).trashed.files).toBe(1);
    expect(existsSync(copyOf(body))).toBe(false);
    // Uploaded again: back from the trash, the same bytes, used now.
    await attach(body);
    expect(has(body)).toBe(true);
    expect(existsSync(trashOf(body))).toBe(false);
    expect(Date.now() - statSync(copyOf(body)).mtimeMs).toBeLessThan(60_000);
    // A day later the purge finds it in use: put back, never deleted.
    await ageSteps(w.db, body, 25);
    const later = await purge();
    expect(later.deleted.files).toBe(0);
    expect(later.restored.files).toBe(1);
    const newest = await w.db.rows<{ kind: string }>(sql`
      SELECT kind FROM public.file_purge_steps WHERE sha256 = ${sha(body)}
      ORDER BY occurred_at DESC LIMIT 1`);
    expect(newest[0]?.kind).toBe("restored");
    expect(has(body)).toBe(true);
    await drain();
    expect(has(body)).toBe(true);
  });

  it("an upload during a purge keeps the copy: before its step, and at the same moment", async () => {
    // The upload lands between the purge's listing and its step: the step's
    // check inside the lock finds the row.
    const { body } = await removedLongAgo();
    const report = await service.purgeFiles({
      apply: true,
      beforeContent: async (step, _org, hash) => {
        if (step === "trash" && hash === sha(body)) await attach(body);
      },
    });
    expect(report.ok && report.value.trashed.files).toBe(0);
    expect(has(body)).toBe(true);
    // At the same moment, many times over: whatever the order, the copy is there.
    for (let i = 0; i < 4; i++) {
      const other = await removedLongAgo();
      await Promise.all([purge(), attach(other.body)]);
      expect(has(other.body)).toBe(true);
      await drain();
      expect(has(other.body)).toBe(true);
    }
  });

  it("stops when the lease runs out in the middle of a run, and the next run goes on", async () => {
    const one = await removedLongAgo();
    const two = await removedLongAgo();
    let calls = 0;
    // The lease's start, then one step's check within it; the next is past it.
    const monotonic = () => (calls++ < 2 ? 0 : 10 * 60_000 + 1);
    const result = await service.purgeFiles({ apply: true, monotonic });
    expect(result.ok && result.value).toMatchObject({
      stopped: "lease_expired",
      trashed: { files: 1 },
    });
    expect([has(one.body), has(two.body)].sort()).toEqual([false, true]);
    expect((await purge()).trashed.files).toBe(1);
    expect(has(one.body) || has(two.body)).toBe(false);
    await drain();
  });

  it("stops when the lease moves in the middle of a run (a renewal), and every step checks it", async () => {
    const { body } = await removedLongAgo();
    const result = await service.purgeFiles({
      apply: true,
      beforeContent: async () => {
        expect(await service.renewFileLease()).toBe(true);
      },
    });
    expect(result.ok && result.value).toMatchObject({
      stopped: "lease_lost",
      trashed: { files: 0 },
    });
    expect(has(body)).toBe(true);
    await drain();
  });
});

describe("the review's fixes (S-052 review)", () => {
  /** A file's bytes as a download reads them. */
  async function download(fileId: string): Promise<Buffer | undefined> {
    const read = await service.fileContent(ctx(), asset as never, fileId, "download");
    if (!read.ok) return undefined;
    const parts: Buffer[] = [];
    for await (const chunk of read.value.open()) parts.push(chunk as Buffer);
    return Buffer.concat(parts);
  }

  it("B2: uploading the same file again puts back a copy that went missing", async () => {
    const body = bytes();
    const fileId = await attach(body);
    rmSync(copyOf(body));
    expect(await download(fileId)).toBeUndefined();
    // The same bytes to the same asset: the row is there, and now the copy too.
    expect(await attach(body)).toBe(fileId);
    expect((await download(fileId))?.equals(body)).toBe(true);
    expect(Date.now() - statSync(copyOf(body)).mtimeMs).toBeLessThan(60_000);
  });

  it("refuses to purge where the file system doesn't keep exact times", async () => {
    const { body } = await removedLongAgo();
    const coarse: FileStore = { ...store, mtimeSelfTest: () => Promise.resolve(false) };
    const careless = createService(w.db, { files: coarse });
    for (const apply of [false, true]) {
      expect(await careless.purgeFiles({ apply })).toEqual({
        ok: false,
        problem: "mtime_unreliable",
      });
    }
    expect(has(body)).toBe(true);
    // This one does.
    expect(await store.mtimeSelfTest()).toBe(true);
    await drain();
  });

  it("leaves a trash entry that isn't a plain copy alone, and reports it as stuck", async () => {
    const { body } = await removedLongAgo();
    expect((await purge()).trashed.files).toBe(1);
    // A second hard link to the trashed copy: not Oculus's alone any more.
    const extra = join(dir, "someone-elses-link");
    linkSync(join(trashOf(body), "content"), extra);
    await ageSteps(w.db, body, 25);
    ageMark(body, 25);
    const dry = await purge(false);
    expect(dry.stuck).toEqual({ files: 1, bytes: body.length });
    expect(dry.deleted.files).toBe(0);
    const run = await purge();
    expect(run).toMatchObject({
      stuck: { files: 1 },
      deleted: { files: 0 },
      restored: { files: 0 },
    });
    expect(readFileSync(join(trashOf(body), "content")).equals(body)).toBe(true);
    const newest = await w.db.rows<{ kind: string }>(sql`
      SELECT kind FROM public.file_purge_steps WHERE sha256 = ${sha(body)}
      ORDER BY occurred_at DESC LIMIT 1`);
    expect(newest[0]?.kind).toBe("trashed");
    // Once someone removes the extra link, the next step goes on.
    rmSync(extra);
    expect((await purge()).deleted.files).toBe(1);
    await drain();
  });

  it("removes a file whose copy's time is before 1970, logs no time for it, and never purges it", async () => {
    const body = bytes();
    const fileId = await attach(body);
    // A Date: Node reads a negative number of seconds as "now".
    utimesSync(copyOf(body), new Date(-86_400_000), new Date(-86_400_000));
    await remove(fileId);
    const logged = await w.db.rows<{ t: string | null }>(sql`
      SELECT copy_mtime_ns::text AS t FROM public.stored_file_events
      WHERE sha256 = ${sha(body)} AND kind = 'removed'`);
    expect(logged).toEqual([{ t: null }]);
    await ageEvents(w.db, body, 30);
    expect((await purge()).trashed.files).toBe(0);
    expect(has(body)).toBe(true);
  });

  it("writes the change log per step, and calls the daily run the timer", async () => {
    const one = await removedLongAgo();
    const two = await removedLongAgo();
    const started = (await w.db.rows<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`))[0]
      ?.t;
    let steps = 0;
    const result = await service.purgeFiles({
      apply: true,
      via: "timer",
      beforeContent: async () => {
        steps++;
        // Before the second step, the first is already in the change log.
        if (steps === 2) {
          const so = await w.db.rows<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM public.system_events
            WHERE occurred_at >= ${started ?? null}::timestamptz`);
          expect(so[0]?.n).toBe(1);
        }
      },
    });
    expect(result.ok && result.value.trashed.files).toBe(2);
    const log = await w.db.rows<{
      source: string | null;
      actor_id: string | null;
      bytes: string;
    }>(sql`
      SELECT source, actor_id::text AS actor_id, byte_count::text AS bytes FROM public.system_events
      WHERE occurred_at >= ${started ?? null}::timestamptz ORDER BY occurred_at`);
    expect(log).toHaveLength(2);
    expect(log.every((r) => r.source === "timer" && r.actor_id === null)).toBe(true);
    expect(log.map((r) => Number(r.bytes)).sort()).toEqual(
      [one.body.length, two.body.length].sort(),
    );
    const trail = await readAuditTrail(
      w.db,
      w.a,
      { records: [], people: [], system: true },
      { from: started ?? "" },
    );
    expect(trail.entries.map((e) => e.actor)).toEqual(["timer", "timer"]);
    const actors = await w.db.rows<{ actor: string }>(sql`
      SELECT DISTINCT actor FROM public.file_purge_steps WHERE occurred_at >= ${started ?? null}::timestamptz`);
    expect(actors).toEqual([{ actor: "system:files-purge-timer" }]);
    // A day and an hour between runs, so a step 2 due in a day is never just missed.
    expect(AUTOMATIC_PURGE_EVERY_MS).toBe(25 * 3600_000);
    await drain();
  });

  it("a renewal waits for a purge step holding the folder's lease lock, so no lease moves inside one", async () => {
    const { body } = await removedLongAgo();
    let renewal: Promise<boolean> | undefined;
    const events: string[] = [];
    const currentLock = async (): Promise<string> =>
      readFileSync(
        join(dir, `${LEASE_LOCK}.${String((await leaseGenerations(dir))[0] ?? 0)}`),
        "utf8",
      );
    const result = await service.purgeFiles({
      apply: true,
      beforeContent: async () => {
        // Hold the lock as a step would, start a renewal, then let go.
        await store.withLeaseLock(async () => {
          renewal = service.renewFileLease().then((r) => {
            events.push("renewed");
            return r;
          });
          await new Promise((r) => setTimeout(r, 300));
          expect(await currentLock()).not.toBe("released\n");
          events.push("step");
        });
        await renewal;
      },
    });
    expect(await renewal).toBe(true);
    expect(events).toEqual(["step", "renewed"]);
    // The renewal moved the lease after the step's lock: the run stopped there.
    expect(result.ok && result.value.stopped).toBe("lease_lost");
    expect(has(body)).toBe(true);
    expect(await currentLock()).toBe("released\n");
    await drain();
  });
});

describe("the second review's fixes (S-052)", () => {
  const markerText = () => readFileSync(join(dir, STORE_MARKER), "utf8");
  const markerLines = () => markerText().split("\n");

  /** `w.db`, but `pg_control_system()` fails with `code` (42501: not allowed). */
  function failingControl(code: string): Database {
    return {
      rows: (q) =>
        Sql.parts(q).join("").includes("pg_control_system")
          ? Promise.reject(Object.assign(new Error("invented failure"), { code }))
          : w.db.rows(q),
      execute: (q) => w.db.execute(q),
      transaction: (work) => w.db.transaction(work),
      close: () => Promise.resolve(),
    };
  }

  it("R2-B1: an identity without the cluster's system identifier never purges, and a renewal never holds by it", async () => {
    const { body } = await removedLongAgo();
    const blind = failingControl("42501");
    expect((await databaseIdentity(blind)).startsWith("-:")).toBe(true);
    const unknown = createService(blind, { files: store });
    const before = markerText();
    for (const apply of [false, true]) {
      expect(await unknown.purgeFiles({ apply })).toEqual({
        ok: false,
        problem: "identity_unknown",
      });
    }
    expect(markerText()).toBe(before);
    expect(has(body)).toBe(true);
    // Its renewal finds the marker naming the full identity: it holds nothing.
    expect(await unknown.bindFileStore()).toEqual({
      ok: true,
      warning: "files_identity_changed",
    });
    expect(markerText()).toBe(before);
    await drain();
  });

  it("R2-B2: a transient error reading the identity is thrown, never taken as a mismatch", async () => {
    const timedOut = failingControl("57014");
    await expect(databaseIdentity(timedOut)).rejects.toThrow("invented failure");
    const before = markerText();
    await expect(createService(timedOut, { files: store }).renewFileLease()).rejects.toThrow();
    await expect(
      createService(timedOut, { files: store }).purgeFiles({ apply: false }),
    ).rejects.toThrow();
    // An adopt (past its quiet wait) never writes `-:` after a failed read.
    const quiet = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(join(dir, STORE_MARKER), quiet, quiet);
    await expect(createService(timedOut, { files: store }).adoptFileStore()).rejects.toThrow();
    expect(markerText()).toBe(before);
    expect(await service.renewFileLease()).toBe(true);
  });

  it("R4: after a pg_upgrade (the identity read changes) the purge refuses and writes nothing, and only an adopt goes on", async () => {
    const { body } = await removedLongAgo();
    const real = await databaseIdentity(w.db);
    // The identity read as pg_upgrade would leave it: a new system
    // identifier, the same database and tables.
    const upgraded: Database = {
      rows: (q) =>
        Sql.parts(q).join("").includes("pg_control_system")
          ? Promise.resolve([{ id: "1111111111111111111" }] as never)
          : w.db.rows(q),
      execute: (q) => w.db.execute(q),
      transaction: (work) => w.db.transaction(work),
      close: () => Promise.resolve(),
    };
    const after = createService(upgraded, { files: store });
    const before = markerText();
    expect(await after.bindFileStore()).toEqual({ ok: true, warning: "files_identity_changed" });
    expect(await after.renewFileLease()).toBe(true);
    for (const apply of [false, true]) {
      expect(await after.purgeFiles({ apply })).toEqual({
        ok: false,
        problem: "identity_changed",
      });
    }
    // Nothing was written: not by the bind, the renewal or either purge.
    expect(markerText()).toBe(before);
    expect(has(body)).toBe(true);
    // No way round the wait: accepting is gone (fourth review), here and over HTTP.
    expect("acceptFileStoreIdentity" in after).toBe(false);
    expect(
      (await callPath("POST", "/api/system/files/cleanup/accept-identity", "root", {})).status,
    ).toBe(404);
    expect(await after.adoptFileStore()).toEqual({ ok: false, problem: "epoch_moving" });
    const quiet = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(join(dir, STORE_MARKER), quiet, quiet);
    expect(await after.adoptFileStore()).toEqual({ ok: true });
    expect(markerLines()[1]).toBe(`1111111111111111111:${real.split(":")[1] ?? ""}`);
    expect((await readFileStoreLease(w.db))?.kind).toBe("adopt");
    // Adopted: it purges again, but removals from before the adopt are kept.
    const run = await after.purgeFiles({ apply: true });
    expect(run.ok && run.value.trashed.files).toBe(0);
    expect(has(body)).toBe(true);
    // And back to the real identity, the same way.
    expect(await service.purgeFiles({ apply: false })).toEqual({
      ok: false,
      problem: "identity_changed",
    });
    utimesSync(join(dir, STORE_MARKER), quiet, quiet);
    expect(await service.adoptFileStore()).toEqual({ ok: true });
    expect(markerLines()[1]).toBe(real);
    await ageEpochsOf(w.db, 30);
    await drain();
  });

  it("L-e: nothing writes the marker or an epoch once its lease lock isn't held (paused past it)", async () => {
    const lost: FileStore = {
      ...store,
      withLeaseLock: (work) => store.withLeaseLock(() => work(() => Promise.resolve(false))),
    };
    const careless = createService(w.db, { files: lost });
    const marker = markerText();
    const epoch = (await readFileStoreLease(w.db))?.epoch;
    expect(await careless.purgeFiles({ apply: true })).toEqual({
      ok: false,
      problem: "lease_busy",
    });
    await expect(careless.renewFileLease()).rejects.toBeInstanceOf(LeaseLockBusy);
    // Adopt looks at the marker's quiet time again inside the lock too.
    const quiet = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(join(dir, STORE_MARKER), quiet, quiet);
    expect(await careless.adoptFileStore()).toEqual({ ok: false, problem: "epoch_moving" });
    expect(markerText()).toBe(marker);
    expect((await readFileStoreLease(w.db))?.epoch).toBe(epoch);
    expect(await service.renewFileLease()).toBe(true);
  });

  it("L3: a step whose lease lock isn't its own any more right before the rename stops, moving nothing", async () => {
    const { body } = await removedLongAgo();
    // Held while the run takes the lease (its two checks), lost by the step.
    let checks = 0;
    const taken: FileStore = {
      ...store,
      withLeaseLock: (work) =>
        store.withLeaseLock((held) => work(async () => checks++ < 2 && (await held()))),
    };
    const result = await createService(w.db, { files: taken }).purgeFiles({ apply: true });
    expect(result.ok && result.value).toMatchObject({
      stopped: "lease_lost",
      trashed: { files: 0 },
    });
    expect(has(body)).toBe(true);
    await drain();
  });

  it("R2-B2: a poisoned marker is never poisoned again, so an adopt can find it quiet with servers running", async () => {
    const [storeId = "", database = ""] = markerLines();
    writeFileSync(join(dir, STORE_MARKER), `${storeId}\n${database}\n${randomUUID()}\n`);
    expect(await service.renewFileLease()).toBe(false);
    const poisoned = markerText();
    expect(poisoned.split("\n")[1]?.startsWith("poisoned:")).toBe(true);
    const old = new Date(Date.now() - 4 * 3600_000);
    utimesSync(join(dir, STORE_MARKER), old, old);
    // The next renewals, a bind and dry and real purges write nothing.
    expect(await service.renewFileLease()).toBe(false);
    expect((await service.bindFileStore()).ok).toBe(true);
    expect(await service.purgeFiles({ apply: false })).toEqual({
      ok: false,
      problem: "lease_mismatch",
    });
    expect(await service.purgeFiles({ apply: true })).toEqual({
      ok: false,
      problem: "lease_mismatch",
    });
    expect(markerText()).toBe(poisoned);
    expect(Date.now() - statSync(join(dir, STORE_MARKER)).mtimeMs).toBeGreaterThan(3 * 3600_000);
    // So the adopt goes through without stopping this server.
    expect(await service.adoptFileStore()).toEqual({ ok: true });
    await ageEpochsOf(w.db, 30);
    expect(await service.renewFileLease()).toBe(true);
  }, 30_000);

  it("a copy whose time can't be changed still attaches, is never purged, and is logged as a warning", async () => {
    const warned: string[] = [];
    const stuckClock: FileStore = { ...store, touch: () => Promise.resolve("unchanged" as const) };
    const careless = createService(w.db, {
      files: stuckClock,
      onError: (error) => warned.push(String((error as { code?: unknown }).code)),
    });
    const body = bytes();
    const fileId = await attach(body, asset, careless);
    expect(warned).toContain("copy_time_unchanged");
    const flagged = await w.db.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.stored_file_events
      WHERE sha256 = ${sha(body)} AND touch_failed`);
    expect(flagged[0]?.n).toBeGreaterThan(0);
    ageCopy(body, 10);
    await remove(fileId);
    await ageEvents(w.db, body, 8);
    expect((await purge()).trashed.files).toBe(0);
    expect(has(body)).toBe(true);
  });

  it("writes files_restored rows for an upload's restore and for trash put back when the lease moved", async () => {
    const one = await removedLongAgo();
    expect((await purge()).trashed.files).toBe(1);
    await attach(one.body);
    const byUpload = await w.db.rows<{ actor_id: string | null; source: string | null }>(sql`
      SELECT actor_id::text AS actor_id, source FROM public.system_events
      WHERE kind = 'files_restored' ORDER BY occurred_at DESC LIMIT 1`);
    expect(byUpload).toEqual([{ actor_id: w.root, source: null }]);
    const two = await removedLongAgo();
    expect((await purge()).trashed.files).toBe(1);
    const [storeId = "", database = ""] = markerLines();
    writeFileSync(join(dir, STORE_MARKER), `${storeId}\n${database}\n${randomUUID()}\n`);
    expect(await service.renewFileLease()).toBe(false);
    expect(has(two.body)).toBe(true);
    const byLease = await w.db.rows<{ actor_id: string | null; source: string | null }>(sql`
      SELECT actor_id::text AS actor_id, source FROM public.system_events
      WHERE kind = 'files_restored' ORDER BY occurred_at DESC LIMIT 1`);
    expect(byLease).toEqual([{ actor_id: null, source: "lease" }]);
    const past = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(join(dir, STORE_MARKER), past, past);
    expect(await service.adoptFileStore()).toEqual({ ok: true });
    await ageEpochsOf(w.db, 30);
    await drain();
  }, 30_000);

  it("allows source = 'timer' or 'lease' only on the purge's kinds", async () => {
    await expect(
      w.db.execute(sql`
        INSERT INTO public.system_events (id, kind, version, source)
        VALUES (${randomUUID()}::uuid, 'update_installed', '1.0.0', 'timer')`),
    ).rejects.toThrow(/system_events_source_known/);
  });

  it("L3: starting while another server holds the lease lock is a warning, not a refusal", async () => {
    // The next generation, held by a live process on this host (the parent).
    const lock = join(dir, `${LEASE_LOCK}.${String(((await leaseGenerations(dir))[0] ?? 0) + 1)}`);
    writeFileSync(lock, `${hostKey() ?? "-"}\n${String(process.ppid)}\nlive\n`);
    try {
      expect(await service.bindFileStore()).toEqual({ ok: true, warning: "files_lease_busy" });
    } finally {
      writeFileSync(lock, "released\n");
    }
    expect(await service.renewFileLease()).toBe(true);
  }, 30_000);
});

/** Moves a database's lease epochs back (their order kept), as the owner. */
async function ageEpochsOf(db: Database, days: number): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.file_store_epochs DISABLE TRIGGER file_store_epochs_append_only`,
    );
    await q.execute(sql`
      UPDATE public.file_store_epochs SET made_at = made_at - make_interval(days => ${days})`);
    await q.execute(
      sql`ALTER TABLE public.file_store_epochs ENABLE ALWAYS TRIGGER file_store_epochs_append_only`,
    );
  });
}

/** A request to a purge route, as `as`. */
async function callPath(method: "GET" | "POST", url: string, as: string, body?: unknown) {
  const token = tokens[as] ?? "";
  const headers: Record<string, string> = {
    origin: SAME_ORIGIN.origin,
    cookie: `${OCULUS_COOKIES.session}=${token}`,
  };
  if (method !== "GET") headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

const call = (method: "GET" | "POST", as: string, body?: unknown) =>
  callPath(method, "/api/system/files/cleanup", as, body);

describe("with S-040's virus scans", () => {
  /** A service whose scanner answers `verdict` for everything it is shown, counting what it opened. */
  function scanning(verdict: "clean" | "infected") {
    const seen: string[] = [];
    const scanned = createService(w.db, {
      files: store,
      scanner: {
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
        scan: async (source) => {
          const parts: Buffer[] = [];
          for await (const chunk of source) parts.push(chunk as Buffer);
          seen.push(sha(Buffer.concat(parts)));
          return verdict === "clean"
            ? { ok: true as const, verdict: "clean" as const }
            : {
                ok: true as const,
                verdict: "infected" as const,
                signature: "Invented.Test.Signature",
              };
        },
      },
    });
    return { scanned, seen };
  }

  /** Queued for a scan as an upload with a scanner would be, with no scanner running. */
  const queuedScan = async (body: Buffer): Promise<void> => {
    await w.db.transaction((tx) => queueScan(tx, w.a, sha(body)));
  };

  const scanStateOf = async (body: Buffer): Promise<string | undefined> =>
    (
      await w.db.rows<{ state: string }>(sql`
        SELECT state FROM public.file_scans WHERE organization_id = ${w.a}::uuid
          AND sha256 = ${sha(body)}`)
    )[0]?.state;

  it("never trashes a quarantined (infected) content, removed or not; a pending scan doesn't keep one", async () => {
    const { scanned } = scanning("infected");
    const bad = bytes();
    const badId = await attach(bad, asset, scanned);
    await scanned.scanQueuedFiles();
    await scanned.stopFileScans();
    expect(await scanStateOf(bad)).toBe("infected");
    ageCopy(bad, 10);
    await remove(badId);
    await ageEvents(w.db, bad, 30);
    expect((await purge(false)).trashed.files).toBe(0);
    expect((await purge()).trashed.files).toBe(0);
    expect(has(bad)).toBe(true);
    // Pending (queued, never scanned): taken like any other.
    const waiting = bytes();
    const waitingId = await attach(waiting);
    await queuedScan(waiting);
    expect(await scanStateOf(waiting)).toBe("pending");
    ageCopy(waiting, 10);
    await remove(waitingId);
    await ageEvents(w.db, waiting, 8);
    expect((await purge()).trashed.files).toBe(1);
    expect(has(waiting)).toBe(false);
    await drain();
  });

  it("the scan queue skips purged content and never records clean for bytes it can't read", async () => {
    // Queued, removed and purged before its scan: never claimed.
    const gone = bytes();
    const goneId = await attach(gone);
    await queuedScan(gone);
    ageCopy(gone, 10);
    await remove(goneId);
    await ageEvents(w.db, gone, 8);
    expect((await purge()).trashed.files).toBe(1);
    const { scanned: later, seen: laterSeen } = scanning("clean");
    await later.scanQueuedFiles();
    await later.stopFileScans();
    expect(laterSeen).not.toContain(sha(gone));
    expect(await scanStateOf(gone)).toBe("pending");
    // A content still named whose copy is missing: failed, never clean.
    const lost = bytes();
    await attach(lost);
    await queuedScan(lost);
    rmSync(copyOf(lost));
    const { scanned: again, seen } = scanning("clean");
    await again.scanQueuedFiles();
    await again.stopFileScans();
    expect(await scanStateOf(lost)).toBe("failed");
    expect(seen).not.toContain(sha(lost));
    await drain();
  });

  it("putting a copy back from the trash leaves its scan as it was", async () => {
    const { scanned } = scanning("clean");
    const body = bytes();
    const fileId = await attach(body, asset, scanned);
    await scanned.scanQueuedFiles();
    await scanned.stopFileScans();
    expect(await scanStateOf(body)).toBe("clean");
    ageCopy(body, 10);
    await remove(fileId);
    await ageEvents(w.db, body, 8);
    expect((await purge()).trashed.files).toBe(1);
    // Uploaded again: back from the trash, still clean, and downloadable.
    const back = await attach(body, asset, scanned);
    await scanned.stopFileScans();
    expect(has(body)).toBe(true);
    expect(await scanStateOf(body)).toBe("clean");
    const read = await scanned.fileContent(ctx(), asset as never, back, "download");
    expect(read.ok).toBe(true);
    await drain();
  });
});

describe("Clean up removed files in the admin", () => {
  it("is for system managers; a step needs a recent sign-in and goes to the change log", async () => {
    const { body } = await removedLongAgo();
    expect((await call("GET", "manager")).status).toBe(403);
    expect((await call("POST", "manager", {})).status).toBe(403);
    const status = await call("GET", "root");
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ available: true, dryRun: true, trashed: { files: 1 } });
    // Not signed in recently: refused before anything changes.
    expect(await call("POST", "stale", {})).toEqual({
      status: 403,
      json: { error: "reauthentication_required" },
    });
    expect(has(body)).toBe(true);
    expect((await call("POST", "root", { extra: true })).status).toBe(422);
    const ran = await call("POST", "root", {});
    expect(ran.status).toBe(200);
    expect(ran.json).toMatchObject({ dryRun: false, trashed: { files: 1 } });
    expect(existsSync(copyOf(body))).toBe(false);
    const steps = await w.db.rows<{ actor: string }>(sql`
      SELECT actor FROM public.file_purge_steps WHERE sha256 = ${sha(body)}`);
    expect(steps).toEqual([{ actor: actorOf(w.root) }]);
    const log = await w.db.rows<{ actor_id: string }>(sql`
      SELECT actor_id::text AS actor_id FROM public.system_events
      WHERE kind = 'files_trashed' ORDER BY occurred_at DESC LIMIT 1`);
    expect(log[0]?.actor_id).toBe(w.root);
    await drain();
  });

  it("never runs on a timer unless OCULUS_FILES_AUTO_PURGE is on", () => {
    expect(automaticPurgeFromEnv({})).toBe(false);
    expect(automaticPurgeFromEnv({ OCULUS_FILES_AUTO_PURGE: "" })).toBe(false);
    expect(automaticPurgeFromEnv({ OCULUS_FILES_AUTO_PURGE: "off" })).toBe(false);
    expect(automaticPurgeFromEnv({ OCULUS_FILES_AUTO_PURGE: "on" })).toBe(true);
    expect(() => automaticPurgeFromEnv({ OCULUS_FILES_AUTO_PURGE: "yes" })).toThrow(/on or off/);
  });
});

describe("another database on the folder (fifth review RV1, RV2; review B1; R1b's window)", () => {
  async function dumpTo(file: string): Promise<void> {
    const bin = await findTools(process.env, ["pg_dump", "pg_restore"]);
    const result = spawnSync(
      join(bin, "pg_dump"),
      ["-Fc", "--no-owner", "-f", file, "-d", w.testDb.url],
      { encoding: "utf8" },
    );
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

  /** Moves a database's lease epochs back (their order kept), as the owner. */
  async function ageEpochs(db: Database, days: number): Promise<void> {
    await db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.file_store_epochs DISABLE TRIGGER file_store_epochs_append_only`,
      );
      await q.execute(sql`
        UPDATE public.file_store_epochs SET made_at = made_at - make_interval(days => ${days})`);
      await q.execute(
        sql`ALTER TABLE public.file_store_epochs ENABLE ALWAYS TRIGGER file_store_epochs_append_only`,
      );
    });
  }

  /** This test database's folder again, after a test handed it to a copy. */
  async function readopt(): Promise<void> {
    const past = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(join(dir, STORE_MARKER), past, past);
    const adopted = await service.adoptFileStore();
    if (!adopted.ok) throw new Error(adopted.problem);
    // The adopt's time moved back with the events later tests move back.
    await ageEpochs(w.db, 30);
    await drain();
  }

  async function withCopy(
    name: string,
    work: (dump: () => Promise<{ s: RecordService; db: Database }>) => Promise<void>,
  ): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), `oculus-files-${name}-`));
    const database = `oculus_test_${name}_${randomBytes(6).toString("hex")}`;
    let copy: Database | undefined;
    let file: string | undefined;
    try {
      await work(async () => {
        if (file === undefined) {
          file = join(folder, "a.dump");
          await dumpTo(file);
          return { s: service, db: w.db };
        }
        copy = openDatabase(await restoreInto(file, database), { max: 3 });
        // An earlier test's adopt is in the dump: its time moved back with
        // the events these tests move back, so it doesn't hide them.
        await ageEpochs(copy, 30);
        return { s: createService(copy, { files: store }), db: copy };
      });
    } finally {
      await copy?.close();
      await dropDatabase(testServerUrl(), database).catch(() => undefined);
      rmSync(folder, { recursive: true, force: true });
      await readopt();
    }
  }

  /**
   * Makes the marker name the copy's identity, as a physical clone of the
   * cluster (a file-level copy) would: it keeps the original's identity, so
   * the marker can't tell it apart. pg_dump/pg_restore can't make one.
   */
  async function asPhysicalClone(copy: Database): Promise<void> {
    const [storeId = "", , epoch = ""] = readFileSync(join(dir, STORE_MARKER), "utf8").split("\n");
    writeFileSync(
      join(dir, STORE_MARKER),
      `${storeId}\n${await databaseIdentity(copy)}\n${epoch}\n`,
    );
  }

  it("RV1: a clone with the folder's epoch never purges what production attached again after it was taken", async () => {
    await withCopy("rv1", async (step) => {
      // Production removed X long ago (its copy last used 20 days ago).
      const { body } = await removedLongAgo({ copyDays: 20, dbDays: 9 });
      // The clone, while its epoch still matches the folder's.
      await step();
      // Production attaches X again, then stops (no renewal after the clone).
      // Its attach was 8 days ago by the file system's clock.
      await attach(body);
      ageCopy(body, 8);
      // The clone starts on the folder: its epoch matches, and as a physical
      // clone its identity does too, so it holds the lease.
      const copy = await step();
      await asPhysicalClone(copy.db);
      expect(await copy.s.bindFileStore()).toEqual({ ok: true });
      // By the database alone the clone would take X (no row there names it).
      expect((await purgeCandidates(copy.db, w.a, null)).map((c) => c.sha256)).toContain(sha(body));
      // But X's copy was used after the clone's removal: kept, dry run or not.
      const dry = await copy.s.purgeFiles({ apply: false });
      expect(dry.ok && dry.value.trashed.files).toBe(0);
      const run = await copy.s.purgeFiles({ apply: true });
      expect(run.ok && run.value.trashed.files).toBe(0);
      expect(has(body)).toBe(true);
      expect(existsSync(trashOf(body))).toBe(false);
    });
  }, 120_000);

  it("RV2 and review B1: a logical restore of a backup taken while production was stopped holds the folder's epoch but not its identity: refused, dry run included, and nothing is trashed", async () => {
    await withCopy("rv2", async (step) => {
      // The review's repro. Production attaches X; its copy was last used
      // 20 days ago.
      const body = bytes();
      const fileId = await attach(body);
      ageCopy(body, 20);
      // Production stops; a dump is taken and restored as a copy whose epoch
      // matches the folder's.
      await step();
      const copy = await step();
      expect((await readFileStoreLease(copy.db))?.epoch).toBe(
        readFileSync(join(dir, STORE_MARKER), "utf8").split("\n")[2],
      );
      // Starting, it finds the marker names another database: not its
      // lease, and it writes nothing to the marker.
      const marker = readFileSync(join(dir, STORE_MARKER), "utf8");
      expect(await copy.s.bindFileStore()).toEqual({
        ok: true,
        warning: "files_identity_changed",
      });
      // The copy removes X, and by its clocks X is old.
      await remove(fileId, copy.s);
      await ageEvents(copy.db, body, 9);
      for (const apply of [false, true]) {
        expect(await copy.s.purgeFiles({ apply })).toEqual({
          ok: false,
          problem: "identity_changed",
        });
      }
      expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(marker);
      expect(await store.trashEntries(w.a)).toEqual([]);
      expect(has(body)).toBe(true);
      // Production starts again and still holds its lease.
      expect(await service.bindFileStore()).toEqual({ ok: true });
      expect((await copy.s.purgeFiles({ apply: true })).ok).toBe(false);
      expect(has(body)).toBe(true);
    });
  }, 120_000);

  it("a dry run in a logical copy writes nothing: not the marker, not the trash, and production keeps its lease", async () => {
    await withCopy("b1dry", async (step) => {
      // Production trashed Y in a step; then a dump is restored and asked.
      const { body } = await removedLongAgo();
      expect((await purge()).trashed.files).toBe(1);
      await step();
      const copy = await step();
      const marker = readFileSync(join(dir, STORE_MARKER), "utf8");
      for (const apply of [false, true]) {
        expect(await copy.s.purgeFiles({ apply })).toEqual({
          ok: false,
          problem: "identity_changed",
        });
      }
      expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(marker);
      expect(existsSync(join(trashOf(body), "content"))).toBe(true);
      expect(await service.renewFileLease()).toBe(true);
    });
  }, 120_000);

  it("R3-B1/R4-B1: a logical copy holding the folder's epoch can neither accept nor purge; only an adopt could make it the owner", async () => {
    await withCopy("r4b1", async (step) => {
      const body = bytes();
      const fileId = await attach(body);
      ageCopy(body, 20);
      await step();
      const copy = await step();
      expect(await copy.s.bindFileStore()).toEqual({
        ok: true,
        warning: "files_identity_changed",
      });
      const marker = readFileSync(join(dir, STORE_MARKER), "utf8");
      expect("acceptFileStoreIdentity" in copy.s).toBe(false);
      // The reviewer's steps: remove X, purge twice a day apart.
      await remove(fileId, copy.s);
      await ageEvents(copy.db, body, 9);
      for (const apply of [false, true, true]) {
        expect(await copy.s.purgeFiles({ apply })).toEqual({
          ok: false,
          problem: "identity_changed",
        });
      }
      expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(marker);
      expect(has(body)).toBe(true);
      expect(await store.trashEntries(w.a)).toEqual([]);
      // Adopting waits for three quiet hours, which production's renewals
      // never leave while it runs.
      expect(await service.renewFileLease()).toBe(true);
      expect(await copy.s.adoptFileStore()).toEqual({ ok: false, problem: "epoch_moving" });
    });
  }, 120_000);

  it("R1b's window: a physical clone with the folder's very epoch may trash, but production's next renewal puts it back", async () => {
    await withCopy("r1bw", async (step) => {
      const body = bytes();
      const fileId = await attach(body);
      ageCopy(body, 20);
      await step();
      const clone = await step();
      await asPhysicalClone(clone.db);
      expect(await clone.s.bindFileStore()).toEqual({ ok: true });
      await remove(fileId, clone.s);
      await ageEvents(clone.db, body, 9);
      const run = await clone.s.purgeFiles({ apply: true });
      expect(run.ok && run.value.trashed.files).toBe(1);
      // Production's hourly renewal finds the folder moved on: the copy comes back.
      expect(await service.renewFileLease()).toBe(false);
      expect(has(body)).toBe(true);
      await ageSteps(clone.db, body, 25);
      expect((await clone.s.purgeFiles({ apply: true })).ok).toBe(false);
      expect(has(body)).toBe(true);
    });
  }, 120_000);

  it("documents the limit (D-086): a physical clone run while production stays stopped for over a day can delete what the clone removed", async () => {
    await withCopy("limit", async (step) => {
      const body = bytes();
      const fileId = await attach(body);
      ageCopy(body, 20);
      await step();
      const clone = await step();
      await asPhysicalClone(clone.db);
      expect(await clone.s.bindFileStore()).toEqual({ ok: true });
      await remove(fileId, clone.s);
      await ageEvents(clone.db, body, 9);
      expect((await clone.s.purgeFiles({ apply: true })).ok).toBe(true);
      expect(await clone.s.renewFileLease()).toBe(true);
      await ageSteps(clone.db, body, 25);
      ageMark(body, 25);
      const second = await clone.s.purgeFiles({ apply: true });
      expect(second.ok && second.value.deleted.files).toBe(1);
      // Production, started again, still names X, and its copy is gone:
      // the clone is indistinguishable from production, so this is the one
      // case the purge can't refuse. D-086, DESKTOP.md and the README say so.
      const rows = await w.db.rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM public.stored_files WHERE sha256 = ${sha(body)}`);
      expect(rows[0]?.n).toBe(1);
      expect(existsSync(copyOf(body))).toBe(false);
    });
  }, 120_000);
});
