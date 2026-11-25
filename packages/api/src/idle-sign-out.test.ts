// Signing out after a period of no use, on the server (T-062, D-098): a
// session unused past its idle limit is refused at its next use exactly as
// any ended session is; a read marked `X-Oculus-Background: 1` is served but
// is not a use, so polling never holds the limit off; the header takes one
// spelling and only on reads; `GET /api/session` gives the admin's timer
// the session's limits; and the limit comes from System settings at sign-in
// (30 minutes by default). Time is moved by ageing the session's stamps in
// the database (as the owner), never by waiting. Everything is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, DEFAULT_SESSION_POLICY, type UserId } from "@oculus/core";
import { sql } from "@oculus/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { TEST_PASSWORD } from "../../service/src/people.fixtures.js";
import { giveTestFactor, testKeyring } from "../../db/src/second-factor.fixtures.js";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { signInRoutes } from "./sign-in-api.js";
import { BACKGROUND_HEADER, CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import { ageSession, fullSession, makeWorld, type World } from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const keys = testKeyring();
let w: World;
let app: FastifyInstance;
let nextAddress = 0;

beforeAll(async () => {
  w = await makeWorld();
  app = await buildServer({
    env: TEST_ENV,
    routes: [
      ...staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
      ...signInRoutes({
        db: w.db,
        keys,
        service: w.service,
        deliverReset: () => Promise.resolve(),
        log: () => undefined,
      }),
    ],
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Call {
  readonly token?: string;
  readonly background?: string;
  readonly body?: unknown;
}

function request(method: "GET" | "POST" | "PUT", url: string, c: Call = {}) {
  nextAddress += 1;
  const headers: Record<string, string> = { origin: SAME_ORIGIN.origin };
  if (c.token !== undefined) {
    headers.cookie = `${OCULUS_COOKIES.session}=${c.token}`;
    if (method !== "GET") headers[CSRF_HEADER] = csrfTokenFor(c.token) ?? "";
  }
  if (c.background !== undefined) headers[BACKGROUND_HEADER] = c.background;
  if (c.body !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    remoteAddress: `192.0.2.${String(1 + (nextAddress % 250))}`,
    ...(c.body === undefined ? {} : { payload: JSON.stringify(c.body) }),
  });
}

/** A full session with a 30-minute idle limit (the default). */
async function session(user: UserId = w.cataloger) {
  return fullSession(w.db, user, w.a, DEFAULT_SESSION_POLICY.idleSeconds);
}

async function lastSeen(sessionId: string): Promise<string> {
  const rows = await w.db.rows<{ t: string }>(
    sql`SELECT last_seen_at::text AS t FROM public.sessions WHERE id = ${sessionId}::uuid`,
  );
  const t = rows[0]?.t;
  if (t === undefined) throw new Error("no such session");
  return t;
}

function expectEnded(r: LightMyRequestResponse) {
  expect(r.statusCode).toBe(401);
  expect(r.body).toBe('{"error":"unauthenticated"}');
}

describe("the default", () => {
  it("is 30 minutes unused (John, Q-8)", () => {
    expect(DEFAULT_SESSION_POLICY.idleSeconds).toBe(1800);
  });
});

describe("GET /api/session", () => {
  it("gives the session's idle limit", async () => {
    const s = await session();
    const r = await request("GET", "/api/session", { token: s.token });
    expect(r.statusCode).toBe(200);
    const body = r.json<Record<string, unknown>>();
    expect(body.idleSeconds).toBe(1800);
    expect(typeof body.idleExpiresAt).toBe("string");
    expect(r.body).not.toContain(s.token);
  });

  it("is 401 without a session", async () => {
    expectEnded(await request("GET", "/api/session"));
  });

  it("is carried by GET /api/me too", async () => {
    const s = await session();
    const me = await request("GET", "/api/me", { token: s.token });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ idleSeconds: number }>().idleSeconds).toBe(1800);
  });
});

describe("a session unused past its idle limit", () => {
  it("is refused at its next use, as an unknown or expired session is", async () => {
    const s = await session();
    await ageSession(w.db, s.sessionId, 30 * 60 - 30);
    expect((await request("GET", "/api/session", { token: s.token })).statusCode).toBe(200);
    // Just used: another 30 minutes from now.
    await ageSession(w.db, s.sessionId, 30 * 60 - 30);
    expect((await request("GET", "/api/record-types", { token: s.token })).statusCode).toBe(200);
    await ageSession(w.db, s.sessionId, 30 * 60 + 1);
    const staff = await request("GET", "/api/record-types", { token: s.token });
    const me = await request("GET", "/api/me", { token: s.token });
    const change = await request("POST", "/api/sign-out/others", { token: s.token, body: {} });
    const unknown = await request("GET", "/api/me", { token: "A".repeat(43) });
    for (const r of [staff, me, change, unknown]) expectEnded(r);
    // Absolute end, for comparison: the same answer, byte for byte.
    const old = await session();
    await ageSession(w.db, old.sessionId, 13 * 3600);
    const absolute = await request("GET", "/api/me", { token: old.token });
    expect(absolute.body).toBe(me.body);
    expect(absolute.headers["content-type"]).toBe(me.headers["content-type"]);
  });

  it("stays refused: no later request brings it back", async () => {
    const s = await session();
    await ageSession(w.db, s.sessionId, 30 * 60 + 1);
    expectEnded(await request("GET", "/api/session", { token: s.token }));
    expectEnded(await request("GET", "/api/session", { token: s.token }));
    expectEnded(await request("GET", "/api/session", { token: s.token, background: "1" }));
  });
});

describe("a background read", () => {
  it("is served, but doesn't move the last use", async () => {
    const s = await session();
    await ageSession(w.db, s.sessionId, 60);
    const before = await lastSeen(s.sessionId);
    for (const url of ["/api/session", "/api/me", "/api/record-types"]) {
      const r = await request("GET", url, { token: s.token, background: "1" });
      expect(r.statusCode, url).toBe(200);
    }
    expect(await lastSeen(s.sessionId)).toBe(before);
    // A use does move it.
    expect((await request("GET", "/api/session", { token: s.token })).statusCode).toBe(200);
    expect(await lastSeen(s.sessionId)).not.toBe(before);
  });

  it("never keeps a session from idling out, however often it polls", async () => {
    const s = await session();
    for (let i = 0; i < 3; i++) {
      await ageSession(w.db, s.sessionId, 9 * 60);
      const r = await request("GET", "/api/me", { token: s.token, background: "1" });
      expect(r.statusCode).toBe(200);
    }
    // 30 minutes and a second since the last use: polling didn't count.
    await ageSession(w.db, s.sessionId, 3 * 60 + 1);
    expectEnded(await request("GET", "/api/me", { token: s.token, background: "1" }));
    expectEnded(await request("GET", "/api/me", { token: s.token }));
  });

  it("says the idle end hasn't moved", async () => {
    const s = await session();
    const first = await request("GET", "/api/session", { token: s.token });
    await ageSession(w.db, s.sessionId, 5);
    const polled = await request("GET", "/api/session", { token: s.token, background: "1" });
    const a = Date.parse(first.json<{ idleExpiresAt: string }>().idleExpiresAt);
    const b = Date.parse(polled.json<{ idleExpiresAt: string }>().idleExpiresAt);
    // Aged 5 seconds back and not refreshed: the end is 5 seconds nearer.
    expect(a - b).toBeGreaterThanOrEqual(4_900);
    expect(a - b).toBeLessThanOrEqual(5_100);
  });

  it("takes one spelling, and only on reads", async () => {
    const s = await session();
    for (const value of ["0", "true", "yes", "1, 1", " 1", "01", ""]) {
      const r = await request("GET", "/api/session", { token: s.token, background: value });
      expect(r.statusCode, JSON.stringify(value)).toBe(400);
      const staff = await request("GET", "/api/record-types", {
        token: s.token,
        background: value,
      });
      expect(staff.statusCode, JSON.stringify(value)).toBe(400);
    }
    // A change is always a use: marking one as background is refused, and
    // nothing changes.
    const other = await session();
    const r = await request("POST", "/api/sign-out/others", {
      token: s.token,
      background: "1",
      body: {},
    });
    expect(r.body).toBe('{"error":"bad_request"}');
    expect((await request("GET", "/api/session", { token: other.token })).statusCode).toBe(200);
    const staff = await request("POST", "/api/records", {
      token: s.token,
      background: "1",
      body: { siteId: w.a1, record: {} },
    });
    expect(staff.body).toBe('{"error":"bad_request"}');
  });
});

describe("the idle limit is a System setting", () => {
  async function signInByRoutes(user: UserId): Promise<string> {
    const factor = await giveTestFactor(w.db, keys, user, 2);
    const rows = await w.db.rows<{ email: string }>(
      sql`SELECT email FROM public.users WHERE id = ${user}::uuid`,
    );
    const password = await request("POST", "/api/sign-in", {
      body: { email: rows[0]?.email, password: TEST_PASSWORD },
    });
    expect(password.statusCode).toBe(200);
    const waiting = /__Host-oculus_session=([A-Za-z0-9_-]+);/.exec(
      String(password.headers["set-cookie"]),
    )?.[1];
    if (waiting === undefined) throw new Error("no cookie");
    const code = await request("POST", "/api/sign-in/code", {
      token: waiting,
      body: { recoveryCode: factor.codes.pop() },
    });
    expect(code.statusCode).toBe(200);
    const token = /__Host-oculus_session=([A-Za-z0-9_-]+);/.exec(
      String(code.headers["set-cookie"]),
    )?.[1];
    if (token === undefined) throw new Error("no cookie");
    return token;
  }

  it("is 30 minutes for a sign-in when it was never changed", async () => {
    const person = await w.member(w.a, "IdleDefault");
    const token = await signInByRoutes(person);
    const r = await request("GET", "/api/session", { token });
    expect(r.json<{ idleSeconds: number }>().idleSeconds).toBe(1800);
  });

  it("only a system manager may change it, within 5 to 720 minutes, and new sign-ins follow it", async () => {
    const root = await session(w.root);
    const manager = await session(w.manager);
    const put = (token: string, idle: unknown, version?: number) =>
      app.inject({
        method: "PUT",
        url: "/api/system-settings",
        headers: {
          origin: SAME_ORIGIN.origin,
          cookie: `${OCULUS_COOKIES.session}=${token}`,
          [CSRF_HEADER]: csrfTokenFor(token) ?? "",
          "content-type": "application/json",
          ...(version === undefined
            ? { "if-none-match": "*" }
            : { "if-match": `"v${String(version)}"` }),
        },
        payload: JSON.stringify({
          settings: { sessionIdleMinutes: idle, sessionAbsoluteMinutes: 720 },
        }),
      });
    expect((await put(manager.token, 10)).statusCode).toBe(403);
    for (const bad of [4, 721, 10.5, "10", null]) {
      expect((await put(root.token, bad)).statusCode, String(bad)).toBe(422);
    }
    expect((await put(root.token, 5)).statusCode).toBe(200);
    // A later sign-in gets the new limit; a session made before keeps its own.
    const person = await w.member(w.a, "IdleShort");
    const token = await signInByRoutes(person);
    const fresh = await request("GET", "/api/session", { token });
    expect(fresh.json<{ idleSeconds: number }>().idleSeconds).toBe(300);
    const earlier = await request("GET", "/api/session", { token: manager.token });
    expect(earlier.json<{ idleSeconds: number }>().idleSeconds).toBe(1800);
    // Back to the default for the other tests.
    expect((await put(root.token, 30, 1)).statusCode).toBe(200);
  });
});
