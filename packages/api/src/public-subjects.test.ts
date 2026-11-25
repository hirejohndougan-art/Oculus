// Cached public Subjects counts (S-038, D-106): worked out in the background
// on a pool of their own, served from memory by `GET /subjects` on a public
// host (never per request), counted again when what public output reads
// changes or the counts grow old, the last good result kept through a
// refused or failed count; staff see when they were made and how many
// public records were left out and why. Every person and record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
import { insertTemplateVersion, openDatabase, sql, type Database } from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { PublicSubjects, publicSubjectsRoutes } from "./public-subjects.js";
import type { PublicSite } from "./public-sites.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  INC,
  actorOf,
  field,
  fullSession,
  makeObject,
  makeWorld,
  ok,
  publishAs,
  type World,
} from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const PUBLIC = "http://127.0.0.1";
const LIGHT = "http://id.loc.gov/authorities/subjects/sh85077022";

let w: World;
let counts: Database;
let site: PublicSite;
let now = 1_800_000_000_000;
let subjects: PublicSubjects;
let pub: FastifyInstance;
let staff: FastifyInstance;
const tokens: Record<string, string> = {};

const term = (label: string, uri?: string) =>
  uri === undefined ? { label } : { label, uri, vocabulary: "lcsh" };

async function subjectRecord(siteId: string, title: string, subject: unknown[], publish = true) {
  const made = ok(
    await w.service.createRecord(
      { organizationId: w.a, actor: actorOf(w.root), siteId: siteId as never },
      {
        kind: "object",
        title,
        templateKey: "t-subj",
        fields: { rights: { uri: INC }, subject, hidden: term("Secret staff term") },
      },
    ),
  );
  if (publish) await publishAs(w, w.a, made.record.id);
  return made.record.id;
}

beforeAll(async () => {
  w = await makeWorld();
  counts = openDatabase(w.testDb.url, { max: 1 });
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-subj",
      organizationId: w.a,
      label: "Subject object",
      appliesTo: ["object"],
      fields: [
        field("rights", "rights"),
        field("subject", "controlled_term", { repeatable: true }),
        field("hidden", "controlled_term", { visibility: "staff" }),
      ],
    }),
  );
  ok(
    await w.service.saveDublinCoreMapping(
      { organizationId: w.a, actor: actorOf(w.root) },
      "t-subj",
      {
        entries: [
          { field: "rights", term: "rights" },
          { field: "subject", term: "subject" },
        ],
      },
      { expectedVersion: 0 },
    ),
  );
  await subjectRecord(w.a1, "An invented lantern", [term("Lighthouses", LIGHT), term("Fishing")]);
  await subjectRecord(w.a1, "An invented net", [term("Fishing")]);
  await subjectRecord(w.a1, "An invented draft", [term("Unpublished term")], false);
  await subjectRecord(w.a2, "An invented lantern on A2", [term("Other site term")]);
  // Published on A1, but held back: t-object has no stored mapping.
  const held = await makeObject(w, w.a, w.a1, "An invented held-back lamp");
  await publishAs(w, w.a, held.id);

  site = { origin: PUBLIC, siteId: w.a1, organizationId: w.a };
  subjects = new PublicSubjects({ db: counts, sites: [site], clock: () => now, minGapMs: 0 });
  pub = await buildServer({
    env: { OCULUS_ORIGINS: PUBLIC },
    routes: publicSubjectsRoutes({ subjects }),
  });
  staff = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({
      db: w.db,
      service: w.service,
      log: () => undefined,
      publicSubjects: subjects,
    }),
  });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("stranger", w.stranger, w.b);
}, 180_000);

afterAll(async () => {
  await subjects.stop();
  await pub.close();
  await staff.close();
  await counts.close();
  await w.db.close();
  await w.testDb.drop();
});

const get = (host = "127.0.0.1") =>
  pub.inject({ method: "GET", url: "/subjects", headers: { host } });

async function status(as: string, siteId: string) {
  const token = tokens[as] ?? "";
  const res = await staff.inject({
    method: "GET",
    url: `/api/sites/${siteId}/public-subjects`,
    headers: {
      origin: SAME_ORIGIN.origin,
      cookie: `${OCULUS_COOKIES.session}=${token}`,
      [CSRF_HEADER]: csrfTokenFor(token) ?? "",
    },
  });
  return { code: res.statusCode, json: res.json<Record<string, unknown>>() };
}

describe("GET /subjects on a public host", () => {
  it("is not ready before the first count, then shows the public records' subjects only", async () => {
    const before = await get();
    expect([before.statusCode, before.headers["retry-after"], before.json()]).toEqual([
      503,
      "30",
      { error: "not_ready" },
    ]);
    await subjects.check();
    const reply = await get();
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ subjects: unknown[]; recordsCounted: number; asOf: string }>();
    expect(body.subjects).toEqual([
      { label: "Fishing", records: 2 },
      { label: "Lighthouses", uri: LIGHT, records: 1 },
    ]);
    expect(body.recordsCounted).toBe(2);
    expect(body.asOf).toBe(`${new Date(now).toISOString().slice(0, 19)}Z`);
    for (const hidden of [
      "Secret staff term",
      "Unpublished term",
      "Other site term",
      "held-back",
    ]) {
      expect(reply.body).not.toContain(hidden);
    }
    // Nothing about records left out reaches the public.
    expect(reply.body).not.toMatch(/leftOut|recordsLeftOut|[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it("is the unknown path's 404 on any other host", async () => {
    for (const host of ["localhost", "unlisted.example.org"]) {
      const reply = await get(host);
      expect([host, reply.statusCode, reply.json()]).toEqual([host, 404, { error: "not_found" }]);
    }
  });

  it("serves the last result until a check sees a change, and counts again only then or when old", async () => {
    await subjects.check();
    const first = (await get()).json<{ asOf: string }>().asOf;
    // Nothing changed: a check keeps the counts it has.
    now += 120_000;
    await subjects.check();
    expect((await get()).json<{ asOf: string }>().asOf).toBe(first);
    // Publishing changes the counts, but only at the next check.
    await subjectRecord(w.a1, "An invented buoy", [term("Buoys")]);
    expect(JSON.stringify((await get()).json())).not.toContain("Buoys");
    now += 60_000;
    await subjects.check();
    const after = (await get()).json<{ subjects: { label: string }[]; asOf: string }>();
    expect(after.subjects.map((s) => s.label)).toContain("Buoys");
    expect(after.asOf).not.toBe(first);
    // A draft saved elsewhere moves the marker, but the public result is the
    // same, so its asOf doesn't move: the public can't watch staff work.
    await subjectRecord(w.a2, "An invented draft elsewhere", [term("Draft term")], false);
    now += 60_000;
    await subjects.check();
    expect((await get()).json<{ asOf: string }>().asOf).toBe(after.asOf);
    // Withdrawing takes the record's subject away at the next count.
    const buoy =
      (
        await w.db.rows<{ id: string }>(
          sql`SELECT id::text AS id FROM public.records WHERE title = 'An invented buoy'`,
        )
      )[0]?.id ?? "";
    ok(
      await w.service.withdraw({ organizationId: w.a, actor: actorOf(w.root) }, buoy as never, {
        expectedVersion: 2,
      }),
    );
    now += 60_000;
    await subjects.check();
    expect(JSON.stringify((await get()).json())).not.toContain("Buoys");
  });

  it("waits minGapMs between counts after a change, and counts old results again only when due", async () => {
    let t = now;
    const gap = new PublicSubjects({
      db: counts,
      sites: [site],
      clock: () => t,
      minGapMs: 300_000,
    });
    await gap.check();
    const first = gap.statusFor(w.a, w.a1)?.asOf;
    await subjectRecord(w.a1, "An invented anchor", [term("Anchors")]);
    t += 60_000;
    await gap.check();
    expect(JSON.stringify(gap.forOrigin(PUBLIC))).not.toContain("Anchors");
    t += 300_000;
    await gap.check();
    expect(JSON.stringify(gap.forOrigin(PUBLIC))).toContain("Anchors");
    expect(gap.statusFor(w.a, w.a1)?.asOf).not.toBe(first);
    await gap.stop();
  });

  it("keeps the last good result when a count fails, and says so to staff", async () => {
    const pool = openDatabase(w.testDb.url, { max: 1 });
    const logged: string[] = [];
    const own = new PublicSubjects({
      db: pool,
      sites: [site],
      clock: () => now,
      log: (r) => logged.push(r.event),
    });
    await own.check();
    const good = own.forOrigin(PUBLIC);
    expect(good?.recordsCounted).toBeGreaterThan(0);
    await pool.close();
    now += 60_000;
    await own.check();
    // For a while the last good counts are still shown...
    expect(own.forOrigin(PUBLIC)).toEqual(good);
    expect(own.statusFor(w.a, w.a1)?.lastProblem?.code).toBe("unavailable");
    expect(logged).toContain("service_error");
    // ...but not once they may be out of date for longer than staleMs.
    now += 1_800_001;
    expect(own.forOrigin(PUBLIC)).toBeNull();
    expect(own.statusFor(w.a, w.a1)?.shown).toBe(false);
    await own.stop();
  });
});

describe("the staff view of the counts", () => {
  it("shows a system manager and the site's manager when they were made and what was left out", async () => {
    await subjects.check();
    for (const who of ["root", "manager"]) {
      const r = await status(who, w.a1);
      expect([who, r.code]).toEqual([who, 200]);
      expect(r.json.recordsLeftOut).toBe(1);
      expect(Object.values(r.json.leftOut as Record<string, number>)).toContain(1);
      expect(r.json.lastProblem).toBeNull();
      expect(typeof r.json.asOf).toBe("string");
      // Codes and counts only: no record ID or title.
      expect(JSON.stringify(r.json)).not.toMatch(/held-back|[0-9a-f]{8}-[0-9a-f]{4}-4/);
    }
  });

  it("refuses everyone else, and a site that isn't public is not found", async () => {
    expect((await status("cataloger", w.a1)).code).toBe(403);
    expect((await status("stranger", w.a1)).code).toBe(403);
    expect((await status("root", w.a2)).code).toBe(404);
  });
});

describe("PublicSubjects", () => {
  it("refuses settings out of range, and stop() ends the background checks", async () => {
    expect(() => new PublicSubjects({ db: counts, sites: [], checkEveryMs: 10 })).toThrow(
      RangeError,
    );
    expect(() => new PublicSubjects({ db: counts, sites: [], timeLimitMs: 400_000 })).toThrow(
      RangeError,
    );
    const quiet = new PublicSubjects({ db: counts, sites: [site], checkEveryMs: 1000 });
    quiet.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await quiet.stop();
    // Stopped: a check does nothing, so nothing runs on a closed pool.
    await quiet.check();
  });

  it("stop() ends a count in progress at its next record", async () => {
    const slow = new PublicSubjects({ db: counts, sites: [site] });
    const pass = slow.check();
    await slow.stop();
    await pass;
    // Either finished first or stopped: never left running.
    expect(slow.statusFor(w.a, w.a1)?.counting).toBe(false);
  });
});
