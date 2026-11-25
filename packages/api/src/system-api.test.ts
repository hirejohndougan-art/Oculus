// The System settings routes of the staff API (T-048a, D-087) over HTTP,
// against a fresh migrated database: making and renaming sites, and reading
// and changing the sign-in rules. Only system managers may; a site manager,
// a cataloger and another organization's member are refused; a session that
// isn't recent is told to sign in again; an unknown site is 404. Every
// person and site is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newSiteId, type OrganizationId, type UserId } from "@oculus/core";
import { sql } from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import { ageSession, fullSession, makeWorld, type World } from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld({ onError: serviceErrorLogger((r) => logged.push(r)) });
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: (r) => logged.push(r) }),
  });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("stranger", w.stranger, w.b);
  // A system manager whose password was given 11 minutes ago: still signed
  // in, but not recently enough for these changes.
  const stale = await fullSession(w.db, w.root, w.a);
  await ageSession(w.db, stale.sessionId, 11 * 60);
  tokens.stale = stale.token;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Call {
  as?: string;
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
}

async function call(method: string, url: string, c: Call = {}) {
  const token = c.as === undefined ? undefined : tokens[c.as];
  const headers: Record<string, string> = { origin: SAME_ORIGIN.origin, ...c.headers };
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if ((c.csrf ?? method !== "GET") && token !== undefined) {
    headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  }
  let payload: string | undefined;
  if (c.body !== undefined) {
    payload = JSON.stringify(c.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.inject({
    method: method as "GET",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // Not JSON: the test looks at the status.
  }
  return { status: res.statusCode, json, res };
}

const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

async function siteName(id: string): Promise<string | undefined> {
  const rows = await w.db.rows<{ name: string }>(
    sql`SELECT name FROM public.sites WHERE id = ${id}::uuid`,
  );
  return rows[0]?.name;
}

async function siteCount(): Promise<number> {
  const rows = await w.db.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.sites`);
  return rows[0]?.n ?? 0;
}

describe("every System settings route needs a usable session", () => {
  const routes = () => [
    { method: "POST", url: "/api/sites", body: { name: "Invented" } },
    { method: "PUT", url: `/api/sites/${w.a1}`, body: { name: "Invented" } },
    { method: "GET", url: "/api/system-settings" },
    {
      method: "PUT",
      url: "/api/system-settings",
      body: { settings: { sessionIdleMinutes: 240, sessionAbsoluteMinutes: 720 } },
      headers: { "if-none-match": "*" },
    },
  ];

  it("no session: 401, and nothing changes", async () => {
    const before = await siteCount();
    for (const r of routes()) {
      const reply = await call(r.method, r.url, {
        ...(r.body === undefined ? {} : { body: r.body }),
        ...(r.headers === undefined ? {} : { headers: r.headers }),
      });
      expect([r.url, reply.status, reply.json]).toEqual([r.url, 401, { error: "unauthenticated" }]);
    }
    expect(await siteCount()).toBe(before);
  });

  it("a change without the session's CSRF token: 403 csrf_failed, even for a system manager", async () => {
    for (const r of routes().filter((x) => x.method !== "GET")) {
      const reply = await call(r.method, r.url, {
        as: "root",
        csrf: false,
        ...(r.body === undefined ? {} : { body: r.body }),
        ...(r.headers === undefined ? {} : { headers: r.headers }),
      });
      expect([r.url, reply.status, reply.json]).toEqual([r.url, 403, { error: "csrf_failed" }]);
    }
  });

  it("anyone but a system manager is refused, and is never asked to sign in again", async () => {
    const before = await siteCount();
    for (const who of ["manager", "cataloger", "stranger"]) {
      for (const r of routes()) {
        const reply = await call(r.method, r.url, {
          as: who,
          ...(r.body === undefined ? {} : { body: r.body }),
          ...(r.headers === undefined ? {} : { headers: r.headers }),
        });
        expect([who, r.method, r.url, reply.status, reply.json]).toEqual([
          who,
          r.method,
          r.url,
          403,
          { error: "not_permitted" },
        ]);
      }
    }
    expect(await siteCount()).toBe(before);
    expect(await siteName(w.a1)).toBe("Invented archive site");
  });
});

describe("sites", () => {
  it("a system manager makes a site in the session's organization, or in another one", async () => {
    const here = await call("POST", "/api/sites", { as: "root", body: { name: "Invented annex" } });
    expect(here.status).toBe(201);
    const site = here.json.site as { id: string; organizationId: string; name: string };
    expect(site.organizationId).toBe(w.a);
    expect(site.name).toBe("Invented annex");
    expect(await siteName(site.id)).toBe("Invented annex");

    const there = await call("POST", "/api/sites", {
      as: "root",
      body: { name: "Invented reading room", organizationId: w.b },
    });
    expect(there.status).toBe(201);
    expect((there.json.site as { organizationId: string }).organizationId).toBe(w.b);
  });

  it("a site needs a name; unknown keys and an unknown organization are refused", async () => {
    const before = await siteCount();
    const empty = await call("POST", "/api/sites", { as: "root", body: { name: "  " } });
    expect(empty.status).toBe(422);
    const extra = await call("POST", "/api/sites", {
      as: "root",
      body: { name: "Invented", id: newSiteId() },
    });
    expect(extra.status).toBe(422);
    const nowhere = await call("POST", "/api/sites", {
      as: "root",
      body: { name: "Invented", organizationId: "1b4e28ba-2fa1-4d3b-a3f5-ef19e2a7d1c0" },
    });
    expect(nowhere.status).toBe(422);
    expect(await siteCount()).toBe(before);
  });

  it("a system manager renames a site, of the session's organization or another", async () => {
    const renamed = await call("PUT", `/api/sites/${w.a2}`, {
      as: "root",
      body: { name: "Invented second site, renamed" },
    });
    expect(renamed.status).toBe(200);
    expect((renamed.json.site as { name: string }).name).toBe("Invented second site, renamed");
    expect(await siteName(w.a2)).toBe("Invented second site, renamed");

    const other = await call("PUT", `/api/sites/${w.b1}`, {
      as: "root",
      body: { name: "Invented library site, renamed", organizationId: w.b },
    });
    expect(other.status).toBe(200);
    expect(await siteName(w.b1)).toBe("Invented library site, renamed");
  });

  it("an unknown site, a site named with the wrong organization and a malformed ID are all 404", async () => {
    for (const [url, body] of [
      [`/api/sites/${newSiteId()}`, { name: "Invented" }],
      // B1 is B's: named as A's (the session's), it isn't found.
      [`/api/sites/${w.b1}`, { name: "Invented" }],
      ["/api/sites/not-a-site", { name: "Invented" }],
    ] as const) {
      const reply = await call("PUT", url, { as: "root", body });
      expect([url, reply.status, reply.json]).toEqual([url, 404, { error: "not_found" }]);
    }
    expect(await siteName(w.b1)).toBe("Invented library site, renamed");
  });

  it("a rename needs a name", async () => {
    const reply = await call("PUT", `/api/sites/${w.a1}`, { as: "root", body: { name: "" } });
    expect(reply.status).toBe(422);
    expect(await siteName(w.a1)).toBe("Invented archive site");
  });
});

describe("a recent sign-in", () => {
  it("making or renaming a site and changing the rules need one; reading the rules doesn't", async () => {
    const before = await siteCount();
    const make = await call("POST", "/api/sites", { as: "stale", body: { name: "Invented" } });
    expect([make.status, make.json]).toEqual([403, { error: "reauthentication_required" }]);
    const rename = await call("PUT", `/api/sites/${w.a1}`, {
      as: "stale",
      body: { name: "Invented" },
    });
    expect([rename.status, rename.json]).toEqual([403, { error: "reauthentication_required" }]);
    const change = await call("PUT", "/api/system-settings", {
      as: "stale",
      headers: { "if-none-match": "*" },
      body: { settings: { sessionIdleMinutes: 60, sessionAbsoluteMinutes: 120 } },
    });
    expect([change.status, change.json]).toEqual([403, { error: "reauthentication_required" }]);
    expect(await siteCount()).toBe(before);
    expect(await siteName(w.a1)).toBe("Invented archive site");

    const read = await call("GET", "/api/system-settings", { as: "stale" });
    expect(read.status).toBe(200);
  });
});

describe("the sign-in rules", () => {
  it("read at version 0, changed first with If-None-Match, then with If-Match; a stale edit is 412", async () => {
    const first = await call("GET", "/api/system-settings", { as: "root" });
    expect(first.status).toBe(200);
    // The default idle limit is 30 minutes since T-062 (D-098; it was 240).
    expect(first.json).toEqual({
      settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 720 },
      version: 0,
    });
    expect(first.res.headers.etag).toBeUndefined();

    const noPrecondition = await call("PUT", "/api/system-settings", {
      as: "root",
      body: { settings: { sessionIdleMinutes: 60, sessionAbsoluteMinutes: 720 } },
    });
    expect(noPrecondition.status).toBe(428);

    const changed = await call("PUT", "/api/system-settings", {
      as: "root",
      headers: { "if-none-match": "*" },
      body: { settings: { sessionIdleMinutes: 60, sessionAbsoluteMinutes: 720 } },
    });
    expect(changed.status).toBe(200);
    expect(changed.json.version).toBe(1);
    expect(changed.res.headers.etag).toBe('"v1"');

    const again = await call("PUT", "/api/system-settings", {
      as: "root",
      headers: { "if-none-match": "*" },
      body: { settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 720 } },
    });
    expect(again.status).toBe(412);

    const next = await call("PUT", "/api/system-settings", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 } },
    });
    expect(next.status).toBe(200);
    expect(next.json.version).toBe(2);

    const stale = await call("PUT", "/api/system-settings", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { settings: { sessionIdleMinutes: 45, sessionAbsoluteMinutes: 600 } },
    });
    expect(stale.status).toBe(412);
    expect(codes(stale)).toContain("version_conflict");

    const read = await call("GET", "/api/system-settings", { as: "root" });
    expect(read.json).toEqual({
      settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 },
      version: 2,
    });
    expect(read.res.headers.etag).toBe('"v2"');
  });

  it("rules out of bounds, an idle time longer than the whole session and unknown keys are refused", async () => {
    for (const settings of [
      { sessionIdleMinutes: 1, sessionAbsoluteMinutes: 600 },
      { sessionIdleMinutes: 700, sessionAbsoluteMinutes: 600 },
      { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600, siteNames: "x" },
      { sessionIdleMinutes: 30 },
    ]) {
      const reply = await call("PUT", "/api/system-settings", {
        as: "root",
        headers: { "if-match": '"v2"' },
        body: { settings },
      });
      expect([settings, reply.status]).toEqual([settings, 422]);
    }
    const extra = await call("PUT", "/api/system-settings", {
      as: "root",
      headers: { "if-match": '"v2"' },
      body: { settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 }, version: 2 },
    });
    expect(extra.status).toBe(422);
    const read = await call("GET", "/api/system-settings", { as: "root" });
    expect(read.json.version).toBe(2);
  });

  it("nothing from the database reaches a reply or the log", () => {
    for (const r of logged) {
      expect(Object.keys(r).every((k) => ["event", "operation", "code", "name"].includes(k))).toBe(
        true,
      );
    }
  });
});
