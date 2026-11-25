// The organization's time zone over HTTP (T-034e, D-103): anyone with access
// reads it with the organization's local day; only system managers with a
// recent sign-in change it, for their session's organization only; an
// unknown zone is refused. Every person is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
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
const PATH = "/api/organization/time-zone";

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
  const stale = await fullSession(w.db, w.root, w.a);
  await ageSession(w.db, stale.sessionId, 11 * 60);
  tokens.stale = stale.token;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

async function call(method: "GET" | "PUT", as: string | undefined, body?: unknown) {
  const token = as === undefined ? undefined : tokens[as];
  const headers: Record<string, string> = { origin: SAME_ORIGIN.origin };
  if (token !== undefined) {
    headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
    if (method !== "GET") headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  }
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await app.inject({
    method,
    url: PATH,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

const zoneOf = async (org: OrganizationId) =>
  (
    await w.db.rows<{ time_zone: string }>(
      sql`SELECT time_zone FROM public.organizations WHERE id = ${org}::uuid`,
    )
  )[0]?.time_zone;

const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

describe("the organization's time zone", () => {
  it("needs a session", async () => {
    expect((await call("GET", undefined)).status).toBe(401);
    expect((await call("PUT", undefined, { timeZone: "America/Chicago" })).status).toBe(401);
  });

  it("can be read, with the local day, by anyone with access to the organization", async () => {
    const read = await call("GET", "cataloger");
    expect(read.status).toBe(200);
    expect(read.json.timeZone).toBe("UTC");
    expect(read.json.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("can be changed only by a system manager, and only with a recent sign-in", async () => {
    for (const who of ["manager", "cataloger"]) {
      const refused = await call("PUT", who, { timeZone: "America/Chicago" });
      expect([who, refused.status]).toEqual([who, 403]);
    }
    const stale = await call("PUT", "stale", { timeZone: "America/Chicago" });
    expect([stale.status, stale.json]).toEqual([403, { error: "reauthentication_required" }]);
    expect(await zoneOf(w.a)).toBe("UTC");

    const changed = await call("PUT", "root", { timeZone: "America/Chicago" });
    expect(changed.status).toBe(200);
    expect(changed.json.timeZone).toBe("America/Chicago");
    expect(await zoneOf(w.a)).toBe("America/Chicago");
    // Only the session's organization.
    expect(await zoneOf(w.b)).toBe("UTC");
  });

  it("refuses an unknown zone and anything but { timeZone }", async () => {
    const before = await zoneOf(w.a);
    const unknown = await call("PUT", "root", { timeZone: "Mars/Olympus_Mons" });
    expect(unknown.status).toBe(422);
    expect(codes(unknown)).toContain("unknown_time_zone");
    const extra = await call("PUT", "root", { timeZone: "UTC", organizationId: w.b });
    expect(extra.status).toBe(422);
    expect(codes(extra)).toContain("unknown_property");
    expect(await zoneOf(w.a)).toBe(before);
    expect(await zoneOf(w.b)).toBe("UTC");
  });

  it("another organization's member can't change this one", async () => {
    const before = await zoneOf(w.a);
    const other = await call("PUT", "stranger", { timeZone: "Europe/London" });
    expect(other.status).toBe(403);
    expect(await zoneOf(w.a)).toBe(before);
  });
});
