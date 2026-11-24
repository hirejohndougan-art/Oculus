// The sign-in routes over HTTP (T-045, D-081), against a fresh migrated
// database: for every route, no session, a session waiting for its code, a
// wrong or missing CSRF token, a foreign Origin, the throttles (the
// per-address limit, and the database's own where it answers), and the
// happy paths: password then code, password then setting up (QR link and
// recovery codes shown once), a recovery code, choosing an organization,
// switching organization, signing out and out everywhere else, and a
// password reset from request to new password. Identical replies where the
// database gives one (a wrong password and an unknown address; every reset
// request let through). Every person, address and organization is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeBase32, totpAt, type OrganizationId, type UserId } from "@oculus/core";
import {
  completeSecondStep,
  resetSecondFactor,
  sql,
  type EnrolmentMessage,
  type PasswordResetMessage,
} from "@oculus/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { TEST_PASSWORD } from "../../service/src/people.fixtures.js";
import {
  giveTestFactor,
  testKeyring,
  type TestFactor,
} from "../../db/src/second-factor.fixtures.js";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { signInRoutes } from "./sign-in-api.js";
import { CSRF_HEADER, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import { makeWorld, pendingSession, type World } from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const keys = testKeyring();
let w: World;
let app: FastifyInstance;
let limited: FastifyInstance;
const logged: ApiLogRecord[] = [];
const resets: PasswordResetMessage[] = [];
const factors = new Map<UserId, TestFactor>();
let nextAddress = 0;

/** A fresh documentation address (RFC 5737) for each sign-in, so throttles don't mix. */
function address(): string {
  nextAddress += 1;
  return `192.0.2.${String(1 + (nextAddress % 250))}`;
}

async function emailOf(userId: UserId): Promise<string> {
  const rows = await w.db.rows<{ email: string }>(
    sql`SELECT email FROM public.users WHERE id = ${userId}::uuid`,
  );
  const email = rows[0]?.email;
  if (email === undefined) throw new Error("no such user");
  return email;
}

async function factorOf(userId: UserId): Promise<TestFactor> {
  let factor = factors.get(userId);
  if (factor === undefined) {
    factor = await giveTestFactor(w.db, keys, userId, 20);
    factors.set(userId, factor);
  }
  return factor;
}

interface Call {
  readonly cookie?: string | undefined;
  readonly csrf?: string;
  readonly origin?: string | null;
  readonly ip?: string;
  readonly server?: FastifyInstance;
}

function post(path: string, body: unknown, call: Call = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.origin !== null) headers.origin = call.origin ?? SAME_ORIGIN.origin;
  if (call.cookie !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${call.cookie}`;
  if (call.csrf !== undefined) headers[CSRF_HEADER] = call.csrf;
  return (call.server ?? app).inject({
    method: "POST",
    url: path,
    headers,
    payload: JSON.stringify(body),
    remoteAddress: call.ip ?? address(),
  });
}

function get(path: string, call: Call = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (call.cookie !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${call.cookie}`;
  return (call.server ?? app).inject({
    method: "GET",
    url: path,
    headers,
    remoteAddress: call.ip ?? address(),
  });
}

/** The session token a reply wrote, from its Set-Cookie. */
function cookieOf(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const text = Array.isArray(header) ? header[0] : header;
  const match = /^__Host-oculus_session=([A-Za-z0-9_-]+);/.exec(text ?? "");
  return match?.[1];
}

/** Signs in with the password; returns the waiting session's cookie and CSRF token. */
async function password(userId: UserId, ip = address()) {
  const response = await post(
    "/api/sign-in",
    { email: await emailOf(userId), password: TEST_PASSWORD },
    { ip },
  );
  expect(response.statusCode).toBe(200);
  const cookie = cookieOf(response);
  const body = response.json<{ csrfToken: string; next: string; setUpLinkRequired: boolean }>();
  if (cookie === undefined) throw new Error("no cookie");
  return { cookie, csrf: body.csrfToken, next: body.next, linkRequired: body.setUpLinkRequired };
}

/** A full session through the routes, with the person's next recovery code. */
async function signedIn(userId: UserId, organizationId?: OrganizationId) {
  const factor = await factorOf(userId);
  const waiting = await password(userId);
  const response = await post(
    "/api/sign-in/code",
    {
      recoveryCode: factor.codes.pop(),
      ...(organizationId === undefined ? {} : { organizationId }),
    },
    waiting,
  );
  expect(response.statusCode).toBe(200);
  const cookie = cookieOf(response);
  const csrf = response.json<{ session: { csrfToken: string } }>().session.csrfToken;
  if (cookie === undefined) throw new Error("no cookie");
  return { cookie, csrf };
}

beforeAll(async () => {
  w = await makeWorld();
  const routes = (rateLimits = {}) => [
    ...staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
    ...signInRoutes({
      db: w.db,
      keys,
      service: w.service,
      deliverReset: (message) => {
        resets.push(message);
        return Promise.resolve();
      },
      log: (record) => logged.push(record),
      rateLimits,
      resetOptions: { backgroundDelayMs: { min: 0, max: 0 } },
    }),
  ];
  app = await buildServer({ env: TEST_ENV, routes: routes() });
  limited = await buildServer({ env: TEST_ENV, routes: routes({ credentials: 2, write: 1 }) });
}, 120_000);

afterAll(async () => {
  await app.close();
  await limited.close();
  await w.db.close();
  await w.testDb.drop();
});

describe("POST /api/sign-in", () => {
  it("answers a right password with a waiting session in the cookie and its CSRF token", async () => {
    await factorOf(w.cataloger);
    const response = await post("/api/sign-in", {
      email: await emailOf(w.cataloger),
      password: TEST_PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toMatch(
      /^__Host-oculus_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      "csrfToken",
      "expiresAt",
      "next",
      "setUpLinkRequired",
    ]);
    expect(body.next).toBe("code");
    // The session token is in the cookie only.
    expect(response.body).not.toContain(cookieOf(response));
  });

  it("gives a wrong password and an unknown address the same reply", async () => {
    const wrong = await post("/api/sign-in", {
      email: await emailOf(w.manager),
      password: "Not the invented password at all",
    });
    const unknown = await post("/api/sign-in", {
      email: "nobody-here@example.org",
      password: "Not the invented password at all",
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.body).toBe('{"error":"invalid_credentials"}');
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("is throttled by the database after five wrong passwords for one address typed", async () => {
    const email = "throttled-person@example.org";
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/sign-in", { email, password: "Wrong invented password" });
      expect(r.statusCode).toBe(401);
    }
    const sixth = await post("/api/sign-in", { email, password: "Wrong invented password" });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: "throttled" });
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("is limited per client address before the database is asked", async () => {
    const ip = address();
    const body = { email: "limit@example.org", password: "Wrong invented password" };
    expect((await post("/api/sign-in", body, { ip, server: limited })).statusCode).toBe(401);
    expect((await post("/api/sign-in", body, { ip, server: limited })).statusCode).toBe(401);
    const third = await post("/api/sign-in", body, { ip, server: limited });
    expect(third.statusCode).toBe(429);
    expect(third.body).toBe('{"error":"rate_limited"}');
  });

  it("refuses a foreign or missing Origin, a bad body and other content types", async () => {
    const body = { email: "x@example.org", password: "Whatever invented" };
    expect(
      (await post("/api/sign-in", body, { origin: "https://evil.example.com" })).statusCode,
    ).toBe(403);
    expect((await post("/api/sign-in", body, { origin: null })).statusCode).toBe(403);
    expect((await post("/api/sign-in", { email: "x@example.org" })).statusCode).toBe(400);
    expect((await post("/api/sign-in", { ...body, organizationId: 7 })).statusCode).toBe(400);
    const form = await app.inject({
      method: "POST",
      url: "/api/sign-in",
      headers: { ...SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      payload: "email=x&password=y",
    });
    expect(form.statusCode).toBe(415);
    const big = await post("/api/sign-in", { email: "x@example.org", password: "a".repeat(9000) });
    expect(big.statusCode).toBe(413);
  });
});

describe("GET /api/sign-in/pending", () => {
  it("says which screen comes next, with the CSRF token", async () => {
    await factorOf(w.manager);
    const waiting = await password(w.manager);
    const response = await get("/api/sign-in/pending", { cookie: waiting.cookie });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      next: "code",
      setUpLinkRequired: false,
      csrfToken: waiting.csrf,
    });
  });

  it("answers no session and a full session alike: 401", async () => {
    expect((await get("/api/sign-in/pending")).statusCode).toBe(401);
    const full = await signedIn(w.manager);
    const response = await get("/api/sign-in/pending", { cookie: full.cookie });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('{"error":"unauthenticated"}');
  });
});

describe("POST /api/sign-in/code", () => {
  it("makes the session full with a TOTP code and a new token", async () => {
    const factor = await factorOf(w.cataloger);
    const waiting = await password(w.cataloger);
    const code = totpAt(factor.secret, Math.floor(Date.now() / 1000));
    const response = await post("/api/sign-in/code", { code }, waiting);
    expect(response.statusCode).toBe(200);
    const full = cookieOf(response);
    expect(full).toBeDefined();
    expect(full).not.toBe(waiting.cookie);
    const session = response.json<{ session: Record<string, unknown> }>().session;
    expect(session.organizationId).toBe(w.a);
    expect(session.csrfToken).not.toBe(waiting.csrf);
    // The old token is gone; the new one works on the staff API.
    expect((await get("/api/sign-in/pending", { cookie: waiting.cookie })).statusCode).toBe(401);
    expect((await get("/api/session", { cookie: full })).statusCode).toBe(200);
  });

  it("refuses without a session, without CSRF, with another session's CSRF and from another origin", async () => {
    const factor = await factorOf(w.other);
    const waiting = await password(w.other);
    const other = await password(w.other);
    const body = { recoveryCode: factor.codes[factor.codes.length - 1] };
    expect((await post("/api/sign-in/code", body)).statusCode).toBe(401);
    const none = await post("/api/sign-in/code", body, { cookie: waiting.cookie });
    expect(none.statusCode).toBe(403);
    expect(none.body).toBe('{"error":"csrf_failed"}');
    expect(
      (await post("/api/sign-in/code", body, { cookie: waiting.cookie, csrf: other.csrf }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post("/api/sign-in/code", body, {
          ...waiting,
          origin: "https://archive.example.com",
        })
      ).statusCode,
    ).toBe(403);
    // Nothing was used up: the same recovery code still works.
    expect((await post("/api/sign-in/code", body, waiting)).statusCode).toBe(200);
    factor.codes.pop();
  });

  it("refuses a full session's cookie as if there were none", async () => {
    const full = await signedIn(w.manager);
    const response = await post("/api/sign-in/code", { code: "123456" }, full);
    expect(response.statusCode).toBe(401);
  });

  it("answers wrong codes with invalid_code, and the fifth ends the waiting session", async () => {
    const waiting = await password(w.manager);
    for (let i = 0; i < 4; i++) {
      const r = await post(
        "/api/sign-in/code",
        { recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" },
        waiting,
      );
      expect(r.statusCode).toBe(422);
      expect(r.body).toBe('{"error":"invalid_code"}');
    }
    const fifth = await post(
      "/api/sign-in/code",
      { recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" },
      waiting,
    );
    expect(fifth.statusCode).toBe(401);
    expect(fifth.body).toBe('{"error":"too_many_attempts"}');
    expect((await get("/api/sign-in/pending", { cookie: waiting.cookie })).statusCode).toBe(401);
  });

  it("is limited per client address", async () => {
    const ip = address();
    const waiting = await password(w.manager);
    const body = { recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" };
    expect(
      (await post("/api/sign-in/code", body, { ...waiting, ip, server: limited })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/sign-in/code", body, { ...waiting, ip, server: limited })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/sign-in/code", body, { ...waiting, ip, server: limited })).statusCode,
    ).toBe(429);
  });

  it("asks a system admin with no membership to choose, by name, then takes the same code", async () => {
    const factor = await factorOf(w.root);
    const waiting = await password(w.root);
    const code = factor.codes.pop();
    const ask = await post("/api/sign-in/code", { recoveryCode: code }, waiting);
    expect(ask.statusCode).toBe(409);
    const choices = ask.json<{
      error: string;
      organizations: { organizationId: string; name: string }[];
    }>();
    expect(choices.error).toBe("choose_organization");
    expect(choices.organizations.map((o) => o.name)).toEqual(
      expect.arrayContaining(["Invented Archive", "Invented Library"]),
    );
    const done = await post(
      "/api/sign-in/code",
      { recoveryCode: code, organizationId: w.b },
      waiting,
    );
    expect(done.statusCode).toBe(200);
    expect(done.json<{ session: { organizationId: string } }>().session.organizationId).toBe(w.b);
  });
});

describe("setting up two-step sign-in (POST /api/sign-in/set-up, /set-up/confirm)", () => {
  it("gives the secret and otpauth link once, then confirms with a code and shows recovery codes once", async () => {
    const waiting = await password(w.reader);
    expect(waiting.next).toBe("set_up");
    // A code before setting up says so.
    const early = await post("/api/sign-in/code", { code: "123456" }, waiting);
    expect(early.statusCode).toBe(409);
    expect(early.body).toBe('{"error":"set_up_required"}');
    const start = await post("/api/sign-in/set-up", {}, waiting);
    expect(start.statusCode).toBe(200);
    const { secret, otpauthUri } = start.json<{ secret: string; otpauthUri: string }>();
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Oculus:/);
    expect(otpauthUri).toContain(`secret=${secret}`);
    const bytes = decodeBase32(secret);
    if (bytes === undefined) throw new Error("bad secret");
    const wrong = await post("/api/sign-in/set-up/confirm", { code: "000000" }, waiting);
    expect(wrong.statusCode).toBe(422);
    const code = totpAt(bytes, Math.floor(Date.now() / 1000));
    const done = await post("/api/sign-in/set-up/confirm", { code }, waiting);
    expect(done.statusCode).toBe(200);
    const body = done.json<{ recoveryCodes: string[]; session: { organizationId: string } }>();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.session.organizationId).toBe(w.a);
    const full = cookieOf(done);
    expect((await get("/api/me", { cookie: full })).statusCode).toBe(200);
    // Set up now: the next sign-in asks for a code, and setting up again is refused.
    const again = await password(w.reader);
    expect(again.next).toBe("code");
    const second = await post("/api/sign-in/set-up", {}, again);
    expect(second.statusCode).toBe(409);
    expect(second.body).toBe('{"error":"already_set_up"}');
  });

  it("needs the emailed one-time link after a system admin's reset", async () => {
    const target = w.donor;
    await factorOf(target);
    // The system admin resets the person's two-step sign-in (D-077), from a full session.
    const rootFactor = await factorOf(w.root);
    const rootWaiting = await pendingSession(w.db, w.root, w.a);
    const rootFull = await completeSecondStep(w.db, keys, rootWaiting.token, {
      recoveryCode: rootFactor.codes.pop() ?? "",
      source: address(),
    });
    if (!rootFull.ok) throw new Error(JSON.stringify(rootFull));
    const sent: EnrolmentMessage[] = [];
    const reset = await resetSecondFactor(
      w.db,
      keys,
      rootFull.token,
      target,
      { recoveryCode: rootFactor.codes.pop() ?? "", source: address() },
      (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    );
    expect(reset.ok).toBe(true);
    factors.delete(target);
    const waiting = await password(target);
    expect(waiting.next).toBe("set_up");
    expect(waiting.linkRequired).toBe(true);
    const without = await post("/api/sign-in/set-up", {}, waiting);
    expect(without.statusCode).toBe(403);
    expect(without.body).toBe('{"error":"set_up_link_required"}');
    const wrong = await post("/api/sign-in/set-up", { setUpLink: "x".repeat(43) }, waiting);
    expect(wrong.statusCode).toBe(403);
    const withLink = await post("/api/sign-in/set-up", { setUpLink: sent[0]?.token }, waiting);
    expect(withLink.statusCode).toBe(200);
  });

  it("refuses without a session, without CSRF and from another origin", async () => {
    expect((await post("/api/sign-in/set-up", {})).statusCode).toBe(401);
    expect((await post("/api/sign-in/set-up/confirm", { code: "123456" })).statusCode).toBe(401);
    const waiting = await password(w.manager);
    expect((await post("/api/sign-in/set-up", {}, { cookie: waiting.cookie })).statusCode).toBe(
      403,
    );
    expect(
      (await post("/api/sign-in/set-up/confirm", { code: "123456" }, { cookie: waiting.cookie }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post("/api/sign-in/set-up", {}, { ...waiting, origin: "https://evil.example.com" }))
        .statusCode,
    ).toBe(403);
    expect((await post("/api/sign-in/set-up", { extra: "x" }, waiting)).statusCode).toBe(400);
  });

  it("is limited per client address", async () => {
    const ip = address();
    const waiting = await password(w.manager);
    for (let i = 0; i < 2; i++) {
      const r = await post("/api/sign-in/set-up", {}, { ...waiting, ip, server: limited });
      expect(r.statusCode).toBe(409);
    }
    const third = await post("/api/sign-in/set-up", {}, { ...waiting, ip, server: limited });
    expect(third.statusCode).toBe(429);
  });
});

describe("POST /api/sign-out and /api/sign-out/others", () => {
  it("signs a full session out and clears the cookie", async () => {
    const full = await signedIn(w.manager);
    const response = await post("/api/sign-out", {}, full);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toMatch(/^__Host-oculus_session=; .*Max-Age=0/);
    expect((await get("/api/me", { cookie: full.cookie })).statusCode).toBe(401);
  });

  it("signs a waiting session out too, with its own CSRF token", async () => {
    const waiting = await password(w.manager);
    expect((await post("/api/sign-out", {}, waiting)).statusCode).toBe(200);
    expect((await get("/api/sign-in/pending", { cookie: waiting.cookie })).statusCode).toBe(401);
  });

  it("clears the cookie without a session, and refuses a session without its CSRF token", async () => {
    expect((await post("/api/sign-out", {})).statusCode).toBe(200);
    const full = await signedIn(w.manager);
    const response = await post("/api/sign-out", {}, { cookie: full.cookie, csrf: "x" });
    expect(response.statusCode).toBe(403);
    expect((await get("/api/me", { cookie: full.cookie })).statusCode).toBe(200);
    expect(
      (await post("/api/sign-out", {}, { ...full, origin: "https://evil.example.com" })).statusCode,
    ).toBe(403);
  });

  it("ends every other session of the person and keeps this one", async () => {
    const one = await signedIn(w.manager);
    const two = await signedIn(w.manager);
    const response = await post("/api/sign-out/others", {}, one);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ended: number }>().ended).toBeGreaterThanOrEqual(1);
    expect((await get("/api/me", { cookie: one.cookie })).statusCode).toBe(200);
    expect((await get("/api/me", { cookie: two.cookie })).statusCode).toBe(401);
  });

  it("refuses everywhere-else without a session, with a waiting one, without CSRF, and over the limit", async () => {
    expect((await post("/api/sign-out/others", {})).statusCode).toBe(401);
    const waiting = await password(w.manager);
    expect((await post("/api/sign-out/others", {}, waiting)).statusCode).toBe(401);
    const full = await signedIn(w.manager);
    expect((await post("/api/sign-out/others", {}, { cookie: full.cookie })).statusCode).toBe(403);
    expect((await post("/api/sign-out/others", {}, { ...full, server: limited })).statusCode).toBe(
      200,
    );
    expect((await post("/api/sign-out/others", {}, { ...full, server: limited })).statusCode).toBe(
      429,
    );
  });
});

describe("GET /api/me and POST /api/organization", () => {
  it("names the person, the organization and only the sites they hold a role on", async () => {
    const full = await signedIn(w.cataloger);
    const response = await get("/api/me", { cookie: full.cookie });
    expect(response.statusCode).toBe(200);
    const me = response.json<{
      displayName: string;
      organizationName: string;
      sites: { siteId: string }[];
      csrfToken: string;
    }>();
    expect(me.displayName).toBe("Invented Cataloger");
    expect(me.organizationName).toBe("Invented Archive");
    expect(me.sites.map((s) => s.siteId)).toEqual([w.a1]);
    expect(me.csrfToken).toBe(full.csrf);
  });

  it("refuses no session and a waiting one alike", async () => {
    expect((await get("/api/me")).body).toBe('{"error":"unauthenticated"}');
    const waiting = await password(w.manager);
    expect((await get("/api/me", { cookie: waiting.cookie })).body).toBe(
      '{"error":"unauthenticated"}',
    );
  });

  it("switches organization with a new session and token", async () => {
    const full = await signedIn(w.root, w.a);
    const response = await post("/api/organization", { organizationId: w.b }, full);
    expect(response.statusCode).toBe(200);
    const token = cookieOf(response);
    expect(token).toBeDefined();
    expect(token).not.toBe(full.cookie);
    expect(response.json<{ session: { organizationId: string } }>().session.organizationId).toBe(
      w.b,
    );
    expect((await get("/api/me", { cookie: full.cookie })).statusCode).toBe(401);
    const me = await get("/api/me", { cookie: token });
    expect(me.json<{ organizationName: string }>().organizationName).toBe("Invented Library");
  });

  it("refuses an organization the person can't work in, without CSRF, without a session and from another origin", async () => {
    const full = await signedIn(w.manager);
    const other = await post("/api/organization", { organizationId: w.b }, full);
    expect(other.statusCode).toBe(403);
    expect(other.body).toBe('{"error":"not_permitted"}');
    expect(
      (await post("/api/organization", { organizationId: w.b }, { cookie: full.cookie }))
        .statusCode,
    ).toBe(403);
    expect((await post("/api/organization", { organizationId: w.b })).statusCode).toBe(401);
    expect(
      (
        await post(
          "/api/organization",
          { organizationId: w.b },
          { ...full, origin: "https://evil.example.com" },
        )
      ).statusCode,
    ).toBe(403);
    const waiting = await password(w.manager);
    expect((await post("/api/organization", { organizationId: w.b }, waiting)).statusCode).toBe(
      401,
    );
    expect((await post("/api/organization", { organizationId: "nope" }, full)).statusCode).toBe(
      403,
    );
  });
});

describe("password reset (POST /api/password-reset, /complete)", () => {
  async function settled(count: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (logged.filter((r) => r.event === "reset_settled").length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the reset work didn't settle");
  }

  it("answers an account and an unknown address the same, and sends a link only to the account", async () => {
    await factorOf(w.other);
    const before = logged.filter((r) => r.event === "reset_settled").length;
    const known = await post("/api/password-reset", { email: await emailOf(w.other) });
    const unknown = await post("/api/password-reset", { email: "no-account@example.org" });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    await settled(before + 2);
    expect(resets).toHaveLength(1);
    // The log never holds the address or the token.
    const text = JSON.stringify(logged);
    expect(text).not.toContain(resets[0]?.token);
    expect(text).not.toContain("example.org");

    const weak = await post("/api/password-reset/complete", {
      token: resets[0]?.token,
      password: "short",
    });
    expect(weak.statusCode).toBe(422);
    expect(weak.json()).toMatchObject({ error: "invalid_password" });
    const done = await post("/api/password-reset/complete", {
      token: resets[0]?.token,
      password: "A brand new invented passphrase 77",
    });
    expect(done.statusCode).toBe(200);
    expect(done.headers["set-cookie"]).toBeUndefined();
    const reused = await post("/api/password-reset/complete", {
      token: resets[0]?.token,
      password: "Another invented passphrase 78",
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.body).toBe('{"error":"invalid_reset"}');
    const made = await post("/api/password-reset/complete", {
      token: "A".repeat(43),
      password: "Another invented passphrase 78",
    });
    expect(made.body).toBe(reused.body);
    // The new password signs in.
    const signIn = await post("/api/sign-in", {
      email: await emailOf(w.other),
      password: "A brand new invented passphrase 77",
    });
    expect(signIn.statusCode).toBe(200);
  });

  it("is throttled per address typed, and limited per client address", async () => {
    const email = "reset-throttle@example.org";
    for (let i = 0; i < 3; i++) {
      expect((await post("/api/password-reset", { email })).statusCode).toBe(202);
    }
    const fourth = await post("/api/password-reset", { email });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ error: "throttled" });
    const ip = address();
    const other = { email: "reset-limit@example.org" };
    expect((await post("/api/password-reset", other, { ip, server: limited })).statusCode).toBe(
      202,
    );
    expect((await post("/api/password-reset", other, { ip, server: limited })).statusCode).toBe(
      202,
    );
    expect((await post("/api/password-reset", other, { ip, server: limited })).statusCode).toBe(
      429,
    );
    const complete = { token: "A".repeat(43), password: "Whatever invented 1" };
    expect(
      (await post("/api/password-reset/complete", complete, { ip, server: limited })).statusCode,
    ).toBe(429);
  });

  it("refuses a foreign Origin and a bad body", async () => {
    expect(
      (
        await post(
          "/api/password-reset",
          { email: "x@example.org" },
          { origin: "https://evil.example.com" },
        )
      ).statusCode,
    ).toBe(403);
    expect((await post("/api/password-reset", { email: 5 })).statusCode).toBe(400);
    expect(
      (
        await post(
          "/api/password-reset/complete",
          { token: "x" },
          { origin: "https://evil.example.com" },
        )
      ).statusCode,
    ).toBe(403);
    expect((await post("/api/password-reset/complete", { token: "x" })).statusCode).toBe(400);
  });
});

describe("the client address", () => {
  it("refuses a request whose client address can't be read", async () => {
    const response = await post(
      "/api/sign-in",
      { email: "x@example.org", password: "Whatever invented" },
      { ip: "not-an-address" },
    );
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"client_address_unknown"}');
    expect(logged).toContainEqual({ event: "client_address_warning", code: "unreadable" });
  });
});
