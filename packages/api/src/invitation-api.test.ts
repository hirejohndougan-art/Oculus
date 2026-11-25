// Accepting an invitation over HTTP (T-075, D-068): a new person with the
// token from the link, their address, a name and a password, then straight
// on to setting up two-step sign-in; a person who already has an account,
// signed in, with the token alone. Every reason a link can't be used reads
// the same; a bad name or password says what's wrong and leaves the
// invitation usable; the address is never confirmed to an incomplete form;
// the usual Origin, CSRF, session and per-address rules. Every person,
// address and organization is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InvitationId, OrganizationId, UserId } from "@oculus/core";
import { createInvitation, revokeInvitation, sql, type InvitationMessage } from "@oculus/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { TEST_PASSWORD } from "../../service/src/people.fixtures.js";
import { giveTestFactor, testKeyring } from "../../db/src/second-factor.fixtures.js";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { signInRoutes } from "./sign-in-api.js";
import { CSRF_HEADER, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import { makeWorld, type World } from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const keys = testKeyring();
let w: World;
let app: FastifyInstance;
let limited: FastifyInstance;
const logged: ApiLogRecord[] = [];
let nextAddress = 0;
let nextPerson = 0;
const tokens: string[] = [];

function address(): string {
  nextAddress += 1;
  return `198.51.100.${String(1 + (nextAddress % 250))}`;
}

function newEmail(): string {
  nextPerson += 1;
  return `invited-${String(nextPerson)}-${String(Date.now() % 100_000)}@example.org`;
}

interface Call {
  readonly cookie?: string;
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

function cookieOf(response: LightMyRequestResponse): string | undefined {
  const header = response.headers["set-cookie"];
  const text = Array.isArray(header) ? header[0] : header;
  return /^__Host-oculus_session=([A-Za-z0-9_-]+);/.exec(text ?? "")?.[1];
}

/** Invites `email` to `organizationId` as the first system manager; the token from the email. */
async function invite(
  email: string,
  organizationId: OrganizationId = w.a,
): Promise<{ token: string; invitationId: InvitationId }> {
  const box: InvitationMessage[] = [];
  const made = await createInvitation(
    w.db,
    { organizationId, email, invitedBy: w.root },
    (message) => {
      box.push(message);
      return Promise.resolve();
    },
  );
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  const token = box[0]?.token;
  if (token === undefined) throw new Error("not delivered");
  tokens.push(token);
  return { token, invitationId: made.value.invitationId };
}

async function emailOf(userId: UserId): Promise<string> {
  const rows = await w.db.rows<{ email: string }>(
    sql`SELECT email FROM public.users WHERE id = ${userId}::uuid`,
  );
  const email = rows[0]?.email;
  if (email === undefined) throw new Error("no such user");
  return email;
}

/** A full session for an existing person, through the routes. */
async function signedIn(userId: UserId): Promise<{ cookie: string; csrf: string }> {
  const factor = await giveTestFactor(w.db, keys, userId, 4);
  const waiting = await post("/api/sign-in", {
    email: await emailOf(userId),
    password: TEST_PASSWORD,
  });
  expect(waiting.statusCode).toBe(200);
  const cookie = cookieOf(waiting);
  if (cookie === undefined) throw new Error("no cookie");
  const full = await post(
    "/api/sign-in/code",
    { recoveryCode: factor.codes.pop() },
    { cookie, csrf: waiting.json<{ csrfToken: string }>().csrfToken },
  );
  expect(full.statusCode).toBe(200);
  const fullCookie = cookieOf(full);
  if (fullCookie === undefined) throw new Error("no cookie");
  return {
    cookie: fullCookie,
    csrf: full.json<{ session: { csrfToken: string } }>().session.csrfToken,
  };
}

const NAME = "Invented Newcomer";
const PASSWORD = "An invented passphrase for joining";

beforeAll(async () => {
  w = await makeWorld();
  const routes = (rateLimits = {}) => [
    ...staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
    ...signInRoutes({
      db: w.db,
      keys,
      service: w.service,
      deliverReset: () => Promise.resolve(),
      log: (record) => logged.push(record),
      rateLimits,
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

describe("POST /api/invitation/accept", () => {
  it("makes the account, joins the invitation's organization and signs in for set-up", async () => {
    const email = newEmail();
    const { token } = await invite(email);
    const response = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ joined: true, signedIn: true, next: "set_up" });
    expect(Object.keys(body).sort()).toEqual([
      "csrfToken",
      "expiresAt",
      "joined",
      "next",
      "setUpLinkRequired",
      "signedIn",
    ]);
    expect(body.setUpLinkRequired).toBe(false);
    const cookie = cookieOf(response);
    expect(cookie).toBeDefined();
    // Neither the session token nor the invitation token is in the reply.
    expect(response.body).not.toContain(cookie);
    expect(response.body).not.toContain(token);
    const rows = await w.db.rows<{ display_name: string; organization_id: string }>(sql`
      SELECT u.display_name, m.organization_id::text AS organization_id
      FROM public.users u JOIN public.organization_members m ON m.user_id = u.id
      WHERE u.email = ${email}`);
    expect(rows).toEqual([{ display_name: NAME, organization_id: w.a }]);
    // The waiting session leads to setting up two-step sign-in.
    const pending = await app.inject({
      method: "GET",
      url: "/api/sign-in/pending",
      headers: { cookie: `${OCULUS_COOKIES.session}=${cookie ?? ""}` },
      remoteAddress: address(),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ next: "set_up" });
    // A link works once.
    const again = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(400);
    expect(again.body).toBe('{"error":"invalid_invitation"}');
  });

  it("gives every reason a link can't be used one reply, and keeps the invitation for the right form", async () => {
    const email = newEmail();
    const { token } = await invite(email);
    const form = { token, email, displayName: NAME, password: PASSWORD };
    const revoked = await invite(newEmail());
    const revokedOk = await revokeInvitation(w.db, {
      organizationId: w.a,
      invitationId: revoked.invitationId,
      by: w.root,
    });
    expect(revokedOk.ok).toBe(true);
    const expired = await invite(newEmail());
    // Made to look 8 days old, as the owner, as the database tests do (D-067).
    await w.db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.invitations DISABLE TRIGGER zzzz_invitations_keep_identity`,
      );
      await q.execute(sql`
        UPDATE public.invitations
        SET created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days'
        WHERE id = ${expired.invitationId}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.invitations ENABLE ALWAYS TRIGGER zzzz_invitations_keep_identity`,
      );
    });
    const answers = [
      await post("/api/invitation/accept", { ...form, token: "x".repeat(43) }),
      await post("/api/invitation/accept", { ...form, token: "not a token" }),
      await post("/api/invitation/accept", { ...form, email: newEmail() }),
      await post("/api/invitation/accept", { ...form, email: "not an address" }),
      await post("/api/invitation/accept", { ...form, token: revoked.token }),
      await post("/api/invitation/accept", { ...form, token: expired.token }),
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(400);
      expect(answer.body).toBe('{"error":"invalid_invitation"}');
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    const right = await post("/api/invitation/accept", form);
    expect(right.statusCode).toBe(201);
  });

  it("says what's wrong with a name or password, and the invitation can still be used", async () => {
    const email = newEmail();
    const { token } = await invite(email);
    const weak = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: "short",
    });
    expect(weak.statusCode).toBe(422);
    const weakBody = weak.json<{ error: string; issues: { path: string[] }[] }>();
    expect(weakBody.error).toBe("invalid_form");
    expect(weakBody.issues.every((i) => i.path[0] === "password")).toBe(true);
    const unnamed = await post("/api/invitation/accept", {
      token,
      email,
      displayName: " ",
      password: PASSWORD,
    });
    expect(unnamed.statusCode).toBe(422);
    expect(unnamed.json<{ issues: { path: string[] }[] }>().issues[0]?.path).toEqual([
      "displayName",
    ]);
    expect(weak.headers["set-cookie"]).toBeUndefined();
    const right = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: PASSWORD,
    });
    expect(right.statusCode).toBe(201);
  });

  it("tells a complete form only that the address has an account, and doesn't use the invitation", async () => {
    const email = await emailOf(w.reader);
    const { token } = await invite(email, w.b);
    // An incomplete form learns nothing about the address.
    const weak = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: "short",
    });
    expect(weak.statusCode).toBe(422);
    const exists = await post("/api/invitation/accept", {
      token,
      email,
      displayName: NAME,
      password: PASSWORD,
    });
    expect(exists.statusCode).toBe(409);
    expect(exists.body).toBe('{"error":"account_exists"}');
    expect(exists.headers["set-cookie"]).toBeUndefined();
    const pending = await w.db.rows<{ accepted: boolean }>(sql`
      SELECT accepted_at IS NOT NULL AS accepted FROM public.invitations
      WHERE organization_id = ${w.b}::uuid AND email = ${email}`);
    expect(pending).toEqual([{ accepted: false }]);
  });

  it("refuses a foreign or missing Origin and a bad body", async () => {
    const body = {
      token: "x".repeat(43),
      email: newEmail(),
      displayName: NAME,
      password: PASSWORD,
    };
    expect(
      (await post("/api/invitation/accept", body, { origin: "https://evil.example.com" }))
        .statusCode,
    ).toBe(403);
    expect((await post("/api/invitation/accept", body, { origin: null })).statusCode).toBe(403);
    expect(
      (await post("/api/invitation/accept", { ...body, password: undefined })).statusCode,
    ).toBe(400);
    expect(
      (await post("/api/invitation/accept", { ...body, organizationId: w.b })).statusCode,
    ).toBe(400);
    expect((await post("/api/invitation/accept", { ...body, email: 7 })).statusCode).toBe(400);
    const big = await post("/api/invitation/accept", { ...body, password: "a".repeat(9000) });
    expect(big.statusCode).toBe(413);
  });

  it("is limited per client address before the database is asked", async () => {
    const ip = address();
    const body = {
      token: "x".repeat(43),
      email: newEmail(),
      displayName: NAME,
      password: PASSWORD,
    };
    expect((await post("/api/invitation/accept", body, { ip, server: limited })).statusCode).toBe(
      400,
    );
    expect((await post("/api/invitation/accept", body, { ip, server: limited })).statusCode).toBe(
      400,
    );
    const third = await post("/api/invitation/accept", body, { ip, server: limited });
    expect(third.statusCode).toBe(429);
    expect(third.body).toBe('{"error":"rate_limited"}');
    expect(third.headers["retry-after"]).toBe("60");
  });
});

describe("POST /api/invitation/accept-signed-in", () => {
  it("adds the signed-in person to the invitation's organization, once", async () => {
    const email = await emailOf(w.other);
    const { token } = await invite(email, w.b);
    const session = await signedIn(w.other);
    const joined = await post("/api/invitation/accept-signed-in", { token }, session);
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ joined: true, organizationId: w.b });
    expect(joined.body).not.toContain(token);
    const rows = await w.db.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.organization_members
      WHERE organization_id = ${w.b}::uuid AND user_id = ${w.other}::uuid`);
    expect(rows).toEqual([{ n: 1 }]);
    const again = await post("/api/invitation/accept-signed-in", { token }, session);
    expect(again.statusCode).toBe(400);
    expect(again.body).toBe('{"error":"invalid_invitation"}');
  });

  it("refuses an invitation for someone else's address like a dead link", async () => {
    const { token } = await invite(newEmail(), w.b);
    const session = await signedIn(w.manager);
    const answer = await post("/api/invitation/accept-signed-in", { token }, session);
    expect(answer.statusCode).toBe(400);
    expect(answer.body).toBe('{"error":"invalid_invitation"}');
    const dead = await post("/api/invitation/accept-signed-in", { token: "y".repeat(43) }, session);
    expect(dead.body).toBe(answer.body);
  });

  it("refuses without a session, without CSRF, with a waiting session and from another origin", async () => {
    const { token } = await invite(newEmail(), w.b);
    expect((await post("/api/invitation/accept-signed-in", { token })).statusCode).toBe(401);
    const session = await signedIn(w.stranger);
    expect(
      (await post("/api/invitation/accept-signed-in", { token }, { cookie: session.cookie }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          "/api/invitation/accept-signed-in",
          { token },
          { ...session, origin: "https://evil.example.com" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post("/api/invitation/accept-signed-in", { token, userId: w.root }, session))
        .statusCode,
    ).toBe(400);
    const waiting = await post("/api/sign-in", {
      email: await emailOf(w.stranger),
      password: TEST_PASSWORD,
    });
    const waitingCookie = cookieOf(waiting) ?? "";
    expect(
      (
        await post(
          "/api/invitation/accept-signed-in",
          { token },
          { cookie: waitingCookie, csrf: waiting.json<{ csrfToken: string }>().csrfToken },
        )
      ).statusCode,
    ).toBe(401);
  });
});

describe("secrecy", () => {
  it("never logs a token, an address or a password", () => {
    const text = JSON.stringify(logged);
    expect(text).not.toMatch(/@example\.org/);
    expect(text).not.toContain(PASSWORD);
    expect(tokens.length).toBeGreaterThan(5);
    for (const token of tokens) expect(text).not.toContain(token);
  });
});
