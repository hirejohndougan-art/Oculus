// Public record reads (T-050d, D-100): `GET /records/:id` on a public host
// answers a published record's Dublin Core and JSON-LD through the public
// reader role and the template's stored mapping, and nothing else; every
// other case (the admin's host, an unpublished record, another site's or
// organization's, a malformed ID) is the unknown path's 404; a client
// address is braked per minute. Every person and record is invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRecordId, newSiteId } from "@oculus/core";
import {
  grantPublicReaderRole,
  insertTemplateVersion,
  openDatabase,
  readPublicRecord,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { testServerUrl } from "../../db/src/test-database.fixtures.js";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import { loadAdminFiles } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import {
  clientKey,
  PUBLIC_POOL_SIZE,
  PUBLIC_POOL_WAIT_MS,
  PUBLIC_QUERY_TIMEOUT_MS,
  publicApiRoutes,
  publicPoolOptions,
} from "./public-api.js";
import { checkPublicSites } from "./public-sites.js";
import { buildServer } from "./server.js";
import { actorOf, makeObject, makeWorld, ok, publishAs, type World } from "./staff-api.fixtures.js";

const ADMIN = "http://localhost";
const PUBLIC = "http://127.0.0.1";

let w: World;
let reader: Database;
let readerRole: string;
let app: FastifyInstance;
let dir: string;
let filesDir: string;
let published: string;
let draft: string;
let otherSite: string;
let otherOrg: string;
let unmapped: string;

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

beforeAll(async () => {
  w = await makeWorld();
  readerRole = `oculus_t050d_reader_${newSiteId().slice(0, 8)}`;
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", readerRole));
  } finally {
    await server.close();
  }
  await w.db.transaction((q) => grantPublicReaderRole(q, readerRole));
  const url = new URL(w.testDb.url);
  url.username = readerRole;
  reader = openDatabase(url.toString(), { max: 2 });

  // The object template's mapping, as a system manager stores it (D-096).
  ok(
    await w.service.saveDublinCoreMapping(
      { organizationId: w.a, actor: actorOf(w.root) },
      "t-object",
      {
        entries: [
          { field: "rights", term: "rights" },
          { field: "note", term: "description" },
        ],
      },
      { expectedVersion: 0 },
    ),
  );
  ok(
    await w.service.saveDublinCoreMapping(
      { organizationId: w.b, actor: actorOf(w.root) },
      "t-object",
      { entries: [{ field: "rights", term: "rights" }] },
      { expectedVersion: 0 },
    ),
  );
  published = (await makeObject(w, w.a, w.a1, "An invented public lantern")).id;
  await publishAs(w, w.a, published);
  draft = (await makeObject(w, w.a, w.a1, "An invented draft lantern")).id;
  otherSite = (await makeObject(w, w.a, w.a2, "An invented lantern on A2")).id;
  await publishAs(w, w.a, otherSite);
  otherOrg = (await makeObject(w, w.b, w.b1, "An invented library lantern")).id;
  await publishAs(w, w.b, otherOrg);
  // A published record whose template has no stored mapping.
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-object-plain",
      organizationId: w.a,
      label: "Plain object",
      appliesTo: ["object"],
      fields: [
        {
          key: "rights",
          label: "rights",
          kind: "rights",
          required: false,
          repeatable: false,
          visibility: "public",
          inherited: false,
        },
      ],
    }),
  );
  const plain = ok(
    await w.service.createRecord(
      { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 },
      {
        kind: "object",
        title: "An invented unmapped lantern",
        templateKey: "t-object-plain",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      },
    ),
  );
  unmapped = plain.record.id;
  await publishAs(w, w.a, unmapped);

  dir = mkdtempSync(join(tmpdir(), "oculus-t050d-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  mkdirSync(join(dir, "assets"));
  filesDir = mkdtempSync(join(tmpdir(), "oculus-t050d-files-"));
  app = await buildAdminServer({
    db: w.db,
    publicDb: reader,
    env: {
      NODE_ENV: "development",
      OCULUS_ORIGINS: `${ADMIN},${PUBLIC}`,
      OCULUS_ADMIN_ORIGIN: ADMIN,
      OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
      OCULUS_PUBLIC_SITES: `${PUBLIC}=${w.a1}`,
      OCULUS_FILES_DIR: filesDir,
    },
    adminFiles: loadAdminFiles(dir),
    log: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
  await reader.close();
  await w.db.close();
  await w.testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I", readerRole));
  } finally {
    await server.close();
  }
});

const get = (host: string, url: string, server = app) =>
  server.inject({ method: "GET", url, headers: { host } });

describe("GET /records/:id on a public host", () => {
  it("answers a published record's public output only: its URL, Dublin Core and JSON-LD", async () => {
    const reply = await get("127.0.0.1", `/records/${published}`);
    expect(reply.statusCode).toBe(200);
    const body = reply.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["dublinCore", "id", "jsonLd"]);
    expect(body.id).toBe(`${PUBLIC}/records/${published}`);
    expect(JSON.stringify(body.dublinCore)).toContain("Tin.");
    expect(reply.body).toContain("An invented public lantern");
    // Staff values and staff warnings never leave.
    expect(reply.body).not.toContain("Back room.");
    expect(reply.body).not.toContain("staffWarnings");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("on a public host, everything else is the unknown path's 404, byte for byte", async () => {
    const unknown = await get("127.0.0.1", "/no-such-path");
    for (const [host, url] of [
      ["127.0.0.1", `/records/${unmapped}`],
      ["127.0.0.1", `/records/${draft}`],
      ["127.0.0.1", `/records/${otherSite}`],
      ["127.0.0.1", `/records/${otherOrg}`],
      ["127.0.0.1", `/records/${newRecordId()}`],
      ["127.0.0.1", "/records/not-an-id"],
      ["127.0.0.1", `/records/${published.toUpperCase()}`],
    ] as const) {
      const reply = await get(host, url);
      expect([host, url, reply.statusCode, reply.body]).toEqual([host, url, 404, unknown.body]);
    }
  });

  it("the admin's host and other hosts get 404 for any record", async () => {
    for (const host of ["localhost", "unlisted.example.org", "127.0.0.1:8080"]) {
      const reply = await get(host, `/records/${published}`);
      expect([host, reply.statusCode, reply.json()]).toEqual([host, 404, { error: "not_found" }]);
    }
  });

  it("only GET: a change is refused", async () => {
    const reply = await app.inject({
      method: "POST",
      url: `/records/${published}`,
      headers: { host: "127.0.0.1", origin: PUBLIC, "content-type": "application/json" },
      payload: "{}",
    });
    expect(reply.statusCode).toBe(405);
  });

  it("a client address is braked per minute", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    let now = 1_000_000;
    const braked = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: publicApiRoutes({ db: reader, sites, rateLimits: { public: 2 }, clock: () => now }),
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++)
        codes.push((await get("127.0.0.1", `/records/${published}`, braked)).statusCode);
      expect(codes).toEqual([200, 200, 429]);
      now += 61_000;
      expect((await get("127.0.0.1", `/records/${published}`, braked)).statusCode).toBe(200);
    } finally {
      await braked.close();
    }
  });

  it("refuses at once past the reads allowed at a time, and counts IPv6 by its /64", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const capped = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: publicApiRoutes({ db: reader, sites, maxConcurrent: 1 }),
    });
    try {
      const replies = await Promise.all(
        Array.from({ length: 4 }, () => get("127.0.0.1", `/records/${published}`, capped)),
      );
      const codes = replies.map((r) => r.statusCode).sort();
      expect(codes[0]).toBe(200);
      expect(codes.every((c) => c === 200 || c === 503)).toBe(true);
      for (const r of replies.filter((x) => x.statusCode === 503)) {
        expect(r.json()).toEqual({ error: "busy" });
      }
      // The slot is given back: a later read works.
      expect((await get("127.0.0.1", `/records/${published}`, capped)).statusCode).toBe(200);
    } finally {
      await capped.close();
    }
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("2001:0db8:0001:0002::5")).toBe("2001:db8:1:2::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });

  it("a read stalled past its time limit is 503 busy, and the connection keeps its own setting (S-037)", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const logged: unknown[] = [];
    const limited = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: publicApiRoutes({
        db: reader,
        sites,
        timeLimitMs: 200,
        log: (r) => logged.push(r),
      }),
    });
    // The attack's effect: something holds the records table, so a public
    // snapshot would wait for as long as it is held.
    const owner = openDatabase(w.testDb.url, { max: 1 });
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = owner.transaction(async (q) => {
      await q.execute(sql`LOCK TABLE public.records IN ACCESS EXCLUSIVE MODE`);
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    try {
      await holding;
      const started = Date.now();
      const stalled = await get("127.0.0.1", `/records/${published}`, limited);
      expect(stalled.statusCode).toBe(503);
      expect(stalled.json()).toEqual({ error: "busy" });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logged).toEqual([
        { event: "service_error", operation: "readPublicRecord", name: "timeout" },
      ]);
    } finally {
      release();
      await held;
      await owner.close();
    }
    try {
      // The lock is gone: the same read works, on the same pooled connections.
      expect((await get("127.0.0.1", `/records/${published}`, limited)).statusCode).toBe(200);
      // The limit was the transaction's own: the pool's connections keep the role's setting.
      const settings = await Promise.all(
        [0, 1].map(() =>
          reader.rows<{ t: string }>(sql`SELECT current_setting('statement_timeout') AS t`),
        ),
      );
      for (const [row] of settings) expect(row?.t).toBe("0");
    } finally {
      await limited.close();
    }
  });

  it("a read that can't get a connection in time is 503 busy (S-037)", async () => {
    const url = new URL(w.testDb.url);
    url.username = readerRole;
    const small = openDatabase(url.toString(), { max: 1, connectionTimeoutMillis: 100 });
    const sites = await checkPublicSites(w.db, small, [{ origin: PUBLIC, siteId: w.a1 }]);
    // More slots than connections, so a read waits on the pool itself.
    const waiting = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: publicApiRoutes({ db: small, sites, maxConcurrent: 2 }),
    });
    let release: () => void = () => undefined;
    let taken: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const held = small.transaction(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          taken();
        }),
    );
    try {
      await holding;
      const reply = await get("127.0.0.1", `/records/${published}`, waiting);
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toEqual({ error: "busy" });
    } finally {
      release();
      await held;
    }
    try {
      expect((await get("127.0.0.1", `/records/${published}`, waiting)).statusCode).toBe(200);
    } finally {
      await waiting.close();
      await small.close();
    }
  });

  it("the public pool's options wait a bounded time for a connection (S-037)", () => {
    expect(publicPoolOptions()).toEqual({
      applicationName: "oculus-public",
      max: PUBLIC_POOL_SIZE,
      connectionTimeoutMillis: PUBLIC_POOL_WAIT_MS,
      queryTimeoutMillis: PUBLIC_QUERY_TIMEOUT_MS,
    });
    // Above every statement limit (at most 60 s), so it only fires on a dead
    // server or network (S-051).
    expect(PUBLIC_QUERY_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(PUBLIC_POOL_WAIT_MS).toBeGreaterThan(0);
    expect(PUBLIC_POOL_WAIT_MS).toBeLessThanOrEqual(10_000);
  });

  it("readPublicRecord takes only a whole-number time limit within bounds (S-037)", async () => {
    const read = (timeLimitMs: unknown) =>
      readPublicRecord(
        reader,
        w.a,
        w.a1,
        published as never,
        {
          baseUrl: `${PUBLIC}/records/`,
          timeLimitMs,
        } as never,
      );
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN, "200", null]) {
      const result = await read(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(["invalid_options"]);
    }
    for (const good of [1_000, 60_000, undefined]) expect((await read(good)).ok).toBe(true);
  });

  it("the routes refuse a time limit every read would refuse (S-037)", () => {
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(() => publicApiRoutes({ db: reader, sites: [], timeLimitMs: bad })).toThrow(
        RangeError,
      );
    }
    expect(() => publicApiRoutes({ db: reader, sites: [], timeLimitMs: 60_000 })).not.toThrow();
  });
});
