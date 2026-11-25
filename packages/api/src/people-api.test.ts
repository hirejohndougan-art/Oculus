// People, roles and the audit trail over HTTP (T-048, D-084), against a
// fresh migrated database: every route with no session, a waiting one and
// CSRF or Origin missing; who may see and change whom (system managers,
// site managers on their own sites only, nobody else); privilege
// escalation (granting oneself or others more than one holds, appointing
// site managers, roles on every site or on another site, acting on system
// managers); the last system manager; other organizations' people answered
// exactly as missing ones; no account enumeration by address; the re-entry
// rule; D-078's warning before a reset link for an account with no second
// factor in use; tokens that never reach a reply or a log; and an audit
// trail that shows only what the viewer may see, deleted records' histories
// to system managers only. Every person, address, site and record is
// invented (example.org, RFC 2606).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type RecordId, type UserId } from "@oculus/core";
import {
  openDatabase,
  endUserSessions,
  resetSecondFactor,
  resolveSession,
  sendPasswordReset,
  setAccountDisabled,
  sql,
  type EnrolmentMessage,
  type InvitationMessage,
  type PasswordResetMessage,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { signInRoutes } from "./sign-in-api.js";
import { CSRF_HEADER, serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import {
  actorOf,
  fullSession,
  makeObject,
  makeWorld,
  ok,
  pendingSession,
  spareRecoveryCode,
  staleReauth,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";
import { testKeyring } from "../../db/src/second-factor.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};
const sessionIds: Record<string, string> = {};
const invitations: InvitationMessage[] = [];
const enrolments: EnrolmentMessage[] = [];
const resets: PasswordResetMessage[] = [];
/** A member of A with no role at all (just invited). */
let newcomer: UserId;
/** A second cataloger on A1, for disabling and ending sessions. */
let helper: UserId;
let a1Record: string;
let a2Record: string;
let deletedRecord: string;

beforeAll(async () => {
  w = await makeWorld({
    onError: serviceErrorLogger((r) => logged.push(r)),
    // Short, so the audit trail's statement_timeout test is quick.
    searchTimeoutMs: 1_000,
  });
  const keys = testKeyring();
  app = await buildServer({
    env: TEST_ENV,
    routes: [
      ...staffApiRoutes({
        db: w.db,
        service: w.service,
        log: (r) => logged.push(r),
        people: {
          keys,
          deliverInvitation: (message) => {
            invitations.push(message);
            return Promise.resolve();
          },
          deliverEnrolment: (message) => {
            enrolments.push(message);
            return Promise.resolve();
          },
          deliverReset: (message) => {
            resets.push(message);
            return Promise.resolve();
          },
        },
      }),
      ...signInRoutes({
        db: w.db,
        keys,
        service: w.service,
        deliverReset: () => Promise.resolve(),
        log: (r) => logged.push(r),
      }),
    ],
  });
  newcomer = await w.member(w.a, "Newcomer");
  helper = await w.member(w.a, "Helper");
  await grant(w.service, w.root, w.a, { userId: helper, role: "cataloger", siteId: w.a1 });
  const make = async (name: string, user: UserId, org = w.a) => {
    const s = await fullSession(w.db, user, org);
    tokens[name] = s.token;
    sessionIds[name] = s.sessionId;
  };
  await make("root", w.root);
  await make("manager", w.manager);
  await make("cataloger", w.cataloger);
  await make("reader", w.reader);
  await make("other", w.other);
  await make("stranger", w.stranger, w.b);
  await make("helper", helper);
  await make("helper2", helper);
  tokens.pending = (await pendingSession(w.db, w.manager, w.a)).token;
  // Records on each site, and one on A1 deleted (its history stays).
  a1Record = (await makeObject(w, w.a, w.a1, "An invented A1 lamp")).id;
  a2Record = (await makeObject(w, w.a, w.a2, "An invented A2 jug")).id;
  const doomed = await makeObject(w, w.a, w.a1, "An invented broken cup");
  deletedRecord = doomed.id;
  ok(
    await w.service.deleteRecord(
      { organizationId: w.a, actor: actorOf(w.root) },
      doomed.id as RecordId,
      { expectedVersion: doomed.version },
    ),
  );
}, 180_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Call {
  as?: string;
  body?: unknown;
  csrf?: boolean | string;
  origin?: string | null;
}

async function call(method: string, url: string, c: Call = {}) {
  const token = c.as === undefined ? undefined : tokens[c.as];
  const headers: Record<string, string> = {};
  if (c.origin !== null) headers.origin = c.origin ?? SAME_ORIGIN.origin;
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  const csrf = c.csrf ?? method !== "GET";
  if (csrf === true && token !== undefined) headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  if (typeof csrf === "string") headers[CSRF_HEADER] = csrf;
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
    // Not JSON.
  }
  return { status: res.statusCode, json, res };
}

/** Status, body and headers but the date: what must match for identical replies. */
function shape(r: Awaited<ReturnType<typeof call>>) {
  const headers = { ...r.res.headers };
  delete headers.date;
  return { status: r.status, body: r.res.body, headers };
}

const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

const MADE_UP = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

async function events(kind: string): Promise<number> {
  const [row] = await w.db.rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM public.people_events WHERE kind = ${kind}`,
  );
  return row?.n ?? 0;
}

async function grantCount(userId: UserId): Promise<number> {
  const [row] = await w.db.rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM public.role_assignments WHERE user_id = ${userId}::uuid`,
  );
  return row?.n ?? 0;
}

describe("the session rules (D-079)", () => {
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/people"],
    ["GET", `/api/people/${MADE_UP}`],
    ["GET", "/api/roles"],
    ["GET", "/api/audit"],
    ["POST", "/api/invitations", { email: "someone@example.org" }],
    ["POST", `/api/people/${MADE_UP}/disable`],
    ["POST", `/api/people/${MADE_UP}/enable`],
    ["POST", `/api/people/${MADE_UP}/roles`, { role: "cataloger", siteId: null, scope: null }],
    ["DELETE", `/api/role-assignments/${MADE_UP}`],
    ["POST", `/api/people/${MADE_UP}/reset-two-step`, { recoveryCode: "x" }],
    ["POST", `/api/people/${MADE_UP}/password-reset`],
    ["POST", `/api/people/${MADE_UP}/end-sessions`],
  ];

  it("refuses every route without a full session", async () => {
    for (const [method, url, body] of routes) {
      expect((await call(method, url, { body })).status, url).toBe(401);
      expect((await call(method, url, { as: "pending", body })).status, url).toBe(401);
    }
  });

  it("refuses every change without the CSRF token or from another origin", async () => {
    for (const [method, url, body] of routes.filter(([m]) => m !== "GET")) {
      expect((await call(method, url, { as: "root", body, csrf: false })).status).toBe(403);
      const wrong = csrfTokenFor(tokens.manager ?? "") ?? "";
      expect((await call(method, url, { as: "root", body, csrf: wrong })).status).toBe(403);
      expect(
        (await call(method, url, { as: "root", body, origin: "https://elsewhere.example" })).status,
      ).toBe(403);
    }
    expect(await events("invited")).toBe(0);
  });
});

describe("seeing people", () => {
  it("shows a system manager every member of the organization, with system manager flags", async () => {
    const r = await call("GET", "/api/people", { as: "root" });
    expect(r.status).toBe(200);
    const people = r.json.people as { userId: string; systemAdmin?: boolean; roles: unknown[] }[];
    const ids = people.map((p) => p.userId);
    for (const id of [w.manager, w.cataloger, w.reader, w.other, w.donor, newcomer, helper]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain(w.stranger);
    expect(people.every((p) => typeof p.systemAdmin === "boolean")).toBe(true);
    expect((r.json.rights as { manageAccounts: boolean }).manageAccounts).toBe(true);
  });

  it("shows a site manager only people of their sites (or with no role), and only the roles they manage", async () => {
    const r = await call("GET", "/api/people", { as: "manager" });
    expect(r.status).toBe(200);
    const people = r.json.people as {
      userId: string;
      systemAdmin?: boolean;
      roles: { role: string; siteId: string | null }[];
    }[];
    const ids = people.map((p) => p.userId);
    expect(ids).toContain(w.cataloger);
    expect(ids).toContain(newcomer);
    // Works only on A2: not shown (D-074).
    expect(ids).not.toContain(w.other);
    expect(ids).not.toContain(w.stranger);
    for (const p of people) {
      expect(p.systemAdmin).toBeUndefined();
      for (const g of p.roles) {
        expect(g.siteId).toBe(w.a1);
        expect(g.role).not.toBe("site_manager");
      }
    }
    expect((r.json.rights as { manageAccounts: boolean }).manageAccounts).toBe(false);
  });

  it("shows a site manager someone with no role by name only; a system manager sees all (John, Q-10)", async () => {
    type Seen = Record<string, unknown> & { userId: string };
    const asManager = (await call("GET", "/api/people", { as: "manager" })).json.people as Seen[];
    const lone = asManager.find((p) => p.userId === newcomer);
    expect(lone).toEqual({
      userId: newcomer,
      displayName: "Invented Newcomer",
      roles: [],
      nameOnly: true,
    });
    const withRole = asManager.find((p) => p.userId === w.cataloger);
    expect(typeof withRole?.email).toBe("string");
    expect(withRole?.nameOnly).toBeUndefined();

    const one = await call("GET", `/api/people/${newcomer}`, { as: "manager" });
    expect(one.status).toBe(200);
    expect(one.json.person).toEqual({
      userId: newcomer,
      displayName: "Invented Newcomer",
      roles: [],
      nameOnly: true,
    });
    expect(JSON.stringify(one.json)).not.toMatch(/@|addedAt|lastSignInAt|disabled/);

    const asRoot = (await call("GET", "/api/people", { as: "root" })).json.people as Seen[];
    const full = asRoot.find((p) => p.userId === newcomer);
    expect(typeof full?.email).toBe("string");
    expect(full?.nameOnly).toBeUndefined();
    const rootOne = await call("GET", `/api/people/${newcomer}`, { as: "root" });
    expect(typeof (rootOne.json.person as Seen).addedAt).toBe("string");
  });

  it("refuses people who manage nobody", async () => {
    for (const as of ["cataloger", "reader", "other"]) {
      expect((await call("GET", "/api/people", { as })).status).toBe(403);
      expect((await call("GET", "/api/roles", { as })).status).toBe(403);
    }
  });

  it("answers a missing, malformed, hidden or other organization's person byte for byte alike", async () => {
    const missing = shape(await call("GET", `/api/people/${MADE_UP}`, { as: "manager" }));
    expect(missing.status).toBe(404);
    expect(missing.body).toBe('{"error":"not_found"}');
    for (const id of [w.stranger, w.other, "not-an-id", w.root]) {
      expect(shape(await call("GET", `/api/people/${id}`, { as: "manager" }))).toEqual(missing);
    }
    // A system manager sees anyone in the organization, but not another organization's member.
    expect(shape(await call("GET", `/api/people/${w.stranger}`, { as: "root" }))).toEqual(missing);
    expect((await call("GET", `/api/people/${w.other}`, { as: "root" })).status).toBe(200);
  });

  it("shows sessions (no token, hash or address) and two-step status to system managers only", async () => {
    const r = await call("GET", `/api/people/${helper}`, { as: "root" });
    expect(r.status).toBe(200);
    const sessions = r.json.sessions as Record<string, unknown>[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual(
        ["label", "lastSeenAt", "organizationId", "sessionId", "signedInAt", "stage"].sort(),
      );
    }
    expect(r.res.body).not.toContain(tokens.helper);
    expect((r.json.secondStep as { inUse: boolean }).inUse).toBe(true);
    const m = await call("GET", `/api/people/${helper}`, { as: "manager" });
    expect(m.status).toBe(200);
    expect(m.json.sessions).toBeUndefined();
    expect(m.json.secondStep).toBeUndefined();
  });
});

describe("granting and revoking roles (D-072)", () => {
  it("lets a site manager grant a role below site manager on their own site, logged", async () => {
    const r = await call("POST", `/api/people/${helper}/roles`, {
      as: "manager",
      body: { role: "read_only", siteId: w.a1, scope: null },
    });
    expect(r.status).toBe(201);
    expect(r.json.role).toBe("read_only");
    expect(await events("role_granted")).toBe(1);
    const revoke = await call("DELETE", `/api/role-assignments/${String(r.json.id)}`, {
      as: "manager",
    });
    expect(revoke.status).toBe(200);
    expect(await events("role_revoked")).toBe(1);
  });

  it("refuses every escalation by a site manager, and writes nothing", async () => {
    const before = await grantCount(w.manager);
    const attempts: [string, unknown][] = [
      // Appointing a site manager, even oneself, or on their own site.
      [w.manager, { role: "site_manager", siteId: w.a1, scope: null }],
      [newcomer, { role: "site_manager", siteId: w.a1, scope: null }],
      // A role on every site.
      [w.manager, { role: "cataloger", siteId: null, scope: null }],
      [newcomer, { role: "reviewer", siteId: null, scope: null }],
      // A site they don't manage.
      [w.manager, { role: "cataloger", siteId: w.a2, scope: null }],
      [newcomer, { role: "cataloger", siteId: w.a2, scope: null }],
      // Another organization's site.
      [newcomer, { role: "cataloger", siteId: w.b1, scope: null }],
    ];
    for (const [userId, body] of attempts) {
      const r = await call("POST", `/api/people/${userId}/roles`, { as: "manager", body });
      expect(r.status, JSON.stringify(body)).toBe(403);
    }
    expect(await grantCount(w.manager)).toBe(before);
  });

  it("refuses granting by people without site.people, even to themselves", async () => {
    for (const as of ["cataloger", "reader", "other", "stranger"]) {
      const self = as === "cataloger" ? w.cataloger : as === "reader" ? w.reader : w.other;
      const r = await call("POST", `/api/people/${self}/roles`, {
        as,
        body: { role: "site_manager", siteId: w.a1, scope: null },
      });
      expect(r.status, as).toBe(403);
    }
  });

  it("answers another organization's member as unknown (a system manager too)", async () => {
    const r = await call("POST", `/api/people/${w.stranger}/roles`, {
      as: "root",
      body: { role: "cataloger", siteId: w.a1, scope: null },
    });
    expect(shape(r)).toEqual(
      shape(
        await call("POST", `/api/people/${MADE_UP}/roles`, {
          as: "root",
          body: { role: "cataloger", siteId: w.a1, scope: null },
        }),
      ),
    );
    expect(r.status).toBe(404);
  });

  it("answers an assignment the site manager can't manage exactly as a missing one", async () => {
    const [otherGrant] = await w.db.rows<{ id: string }>(
      sql`SELECT id::text AS id FROM public.role_assignments WHERE user_id = ${w.other}::uuid`,
    );
    const [ownGrant] = await w.db.rows<{ id: string }>(
      sql`SELECT id::text AS id FROM public.role_assignments WHERE user_id = ${w.manager}::uuid`,
    );
    const missing = shape(
      await call("DELETE", `/api/role-assignments/${MADE_UP}`, { as: "manager" }),
    );
    expect(missing.status).toBe(404);
    for (const id of [otherGrant?.id, ownGrant?.id, "nonsense"]) {
      expect(
        shape(await call("DELETE", `/api/role-assignments/${String(id)}`, { as: "manager" })),
      ).toEqual(missing);
    }
    expect(await grantCount(w.other)).toBe(1);
    expect(await grantCount(w.manager)).toBe(1);
  });

  it("the database still refuses a grant recorded by someone who may not grant (0018)", async () => {
    await expect(
      w.db.execute(sql`
        INSERT INTO public.role_assignments (organization_id, id, user_id, role, site_id, granted_by)
        VALUES (${w.a}::uuid, gen_random_uuid(), ${w.manager}::uuid, 'site_manager', ${w.a2}::uuid,
                ${w.manager}::uuid)`),
    ).rejects.toMatchObject({ constraint: "role_assignments_granted_by" });
  });

  it("needs the password and a code entered in the last 10 minutes, after the permission", async () => {
    const s = await fullSession(w.db, w.manager, w.a);
    await staleReauth(w.db, s.sessionId, 11 * 60);
    tokens.staleManager = s.token;
    const before = await grantCount(helper);
    const r = await call("POST", `/api/people/${helper}/roles`, {
      as: "staleManager",
      body: { role: "reviewer", siteId: w.a1, scope: null },
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("reauthentication_required");
    expect(await grantCount(helper)).toBe(before);
    // Without the permission, the answer is the permission's.
    const denied = await call("POST", `/api/people/${helper}/roles`, {
      as: "staleManager",
      body: { role: "site_manager", siteId: w.a1, scope: null },
    });
    expect(denied.json.error).toBe("not_permitted");
  });

  it("re-entering the password and a recovery code makes the session recent again, with a new token", async () => {
    const wrong = await call("POST", "/api/reauthenticate", {
      as: "staleManager",
      body: { password: "Not the invented password", recoveryCode: spareRecoveryCode(w.manager) },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error).toBe("invalid_credentials");
    const right = await call("POST", "/api/reauthenticate", {
      as: "staleManager",
      body: {
        password: "Invented river bend lantern 2026",
        recoveryCode: spareRecoveryCode(w.manager),
      },
    });
    expect(right.status).toBe(200);
    const cookie = String(right.res.headers["set-cookie"]);
    const token = /__Host-oculus_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(token).not.toBe(tokens.staleManager);
    tokens.freshManager = token;
    const r = await call("POST", `/api/people/${helper}/roles`, {
      as: "freshManager",
      body: { role: "reviewer", siteId: w.a1, scope: null },
    });
    expect(r.status).toBe(201);
  }, 30_000);

  it("a site manager can't grant to someone with no role: answered as a missing person (John, Q-10)", async () => {
    const lone = await w.member(w.a, "Lone");
    const body = { role: "read_only", siteId: w.a1, scope: null };
    const refusedLone = await call("POST", `/api/people/${lone}/roles`, { as: "manager", body });
    const missing = await call("POST", `/api/people/${MADE_UP}/roles`, { as: "manager", body });
    expect(refusedLone.status).toBe(404);
    expect(shape(refusedLone)).toEqual(shape(missing));
    // Someone whose only role is on a site they don't manage is the same.
    const elsewhere = await call("POST", `/api/people/${w.other}/roles`, { as: "manager", body });
    expect(shape(elsewhere)).toEqual(shape(missing));
    expect(await grantCount(lone)).toBe(0);
    // A system manager gives the first role; then the site manager may add more.
    const first = await call("POST", `/api/people/${lone}/roles`, { as: "root", body });
    expect(first.status).toBe(201);
    const more = await call("POST", `/api/people/${lone}/roles`, {
      as: "manager",
      body: { role: "reviewer", siteId: w.a1, scope: null },
    });
    expect(more.status).toBe(201);
    expect(await grantCount(lone)).toBe(2);
  });
});

describe("who a site manager sees, and may grant to (T-064 review)", () => {
  const body = (role: string, siteId: string | null = w.a1, scope: string | null = null) => ({
    role,
    siteId,
    scope,
  });

  it("a member whose only role is on every site is seen in full and can be granted to, by every site manager (John, S-042)", async () => {
    const boss = await w.member(w.a, "Boss");
    const target = await w.member(w.a, "Target");
    expect(
      (
        await call("POST", `/api/people/${boss}/roles`, {
          as: "root",
          body: body("site_manager", null),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("POST", `/api/people/${target}/roles`, {
          as: "root",
          body: body("read_only", null),
        })
      ).status,
    ).toBe(201);
    tokens.boss = (await fullSession(w.db, boss, w.a)).token;

    for (const as of ["boss", "manager"]) {
      const listed = (await call("GET", "/api/people", { as })).json.people as {
        userId: string;
        email?: string;
        nameOnly?: boolean;
      }[];
      const seen = listed.find((p) => p.userId === target);
      expect([as, typeof seen?.email, seen?.nameOnly]).toEqual([as, "string", undefined]);
      const one = (await call("GET", `/api/people/${target}`, { as })).json.person as {
        email?: string;
        addedAt?: string;
      };
      expect([as, typeof one.email, typeof one.addedAt]).toEqual([as, "string", "string"]);
    }
    const more = await call("POST", `/api/people/${target}/roles`, {
      as: "manager",
      body: body("reviewer"),
    });
    expect(more.status).toBe(201);
    expect(await grantCount(target)).toBe(2);
    // The every-site role itself stays out of a site manager's view (D-072).
    const roles = (await call("GET", `/api/people/${target}`, { as: "manager" })).json.person as {
      roles: { siteId: string | null }[];
    };
    expect(roles.roles.every((g) => g.siteId === w.a1)).toBe(true);
    // Someone with no role at all is still name-only (Q-10 kept).
    const lone = await w.member(w.a, "Alone");
    const loneSeen = (await call("GET", `/api/people/${lone}`, { as: "boss" })).json.person;
    expect(loneSeen).toEqual({
      userId: lone,
      displayName: "Invented Alone",
      roles: [],
      nameOnly: true,
    });
  });

  it("a member whose only role is site manager on the manager's site is seen in full and can be granted to", async () => {
    const peer = await w.member(w.a, "Peer");
    expect(
      (await call("POST", `/api/people/${peer}/roles`, { as: "root", body: body("site_manager") }))
        .status,
    ).toBe(201);
    const seen = (await call("GET", `/api/people/${peer}`, { as: "manager" })).json.person as {
      email?: string;
      nameOnly?: boolean;
    };
    expect(typeof seen.email).toBe("string");
    expect(seen.nameOnly).toBeUndefined();
    const more = await call("POST", `/api/people/${peer}/roles`, {
      as: "manager",
      body: body("reviewer"),
    });
    expect(more.status).toBe(201);
  });

  it("a role-less target is a missing person before its scope or its role is looked at", async () => {
    const lone = await w.member(w.a, "Solo");
    const missingPerson = shape(
      await call("POST", `/api/people/${MADE_UP}/roles`, { as: "manager", body: body("reviewer") }),
    );
    for (const b of [body("reviewer", w.a1, MADE_UP), body("reviewer", w.a1, a1Record)]) {
      const r = await call("POST", `/api/people/${lone}/roles`, { as: "manager", body: b });
      expect(shape(r)).toEqual(missingPerson);
    }
    expect(await grantCount(lone)).toBe(0);
  });
});

describe("accounts: system managers only", () => {
  it("refuses site managers and others every account action on anyone, system managers included", async () => {
    for (const as of ["manager", "cataloger"]) {
      for (const target of [w.root, helper, w.manager]) {
        for (const action of ["disable", "enable", "end-sessions", "password-reset"]) {
          const r = await call("POST", `/api/people/${target}/${action}`, { as });
          expect(r.status, `${as} ${action}`).toBe(403);
        }
        const reset = await call("POST", `/api/people/${target}/reset-two-step`, {
          as,
          body: { recoveryCode: "0000-0000-0000-0000-0000-0000" },
        });
        expect(reset.status).toBe(403);
      }
      const invite = await call("POST", "/api/invitations", {
        as,
        body: { email: "nobody-yet@example.org" },
      });
      expect(invite.status).toBe(403);
    }
    expect(invitations).toHaveLength(0);
    expect(resets).toHaveLength(0);
    expect(enrolments).toHaveLength(0);
  });

  it("never disables the last active system manager, not even themselves", async () => {
    const r = await call("POST", `/api/people/${w.root}/disable`, { as: "root" });
    // The system manager isn't a member of A: unknown there.
    expect(r.status).toBe(404);
    await expect(
      w.db.execute(sql`UPDATE public.users SET disabled_at = now() WHERE id = ${w.root}::uuid`),
    ).rejects.toMatchObject({ constraint: "users_last_system_admin" });
    const refused = await w.db.transaction((tx) => setAccountDisabled(tx, w.root, true));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.issues.map((i) => i.code)).toEqual(["last_system_manager"]);
  });

  it("disables a member (ending their sessions) and re-enables them (reviving none), logged", async () => {
    const d = await call("POST", `/api/people/${helper}/disable`, { as: "root" });
    expect(d.status).toBe(200);
    expect(d.json.changed).toBe(true);
    expect((await resolveSession(w.db, tokens.helper)).ok).toBe(false);
    expect((await call("GET", `/api/people/${helper}`, { as: "root" })).json.person).toMatchObject({
      disabled: true,
    });
    const again = await call("POST", `/api/people/${helper}/disable`, { as: "root" });
    expect(again.json.changed).toBe(false);
    const e = await call("POST", `/api/people/${helper}/enable`, { as: "root" });
    expect(e.json.changed).toBe(true);
    expect((await resolveSession(w.db, tokens.helper2)).ok).toBe(false);
    expect(await events("account_disabled")).toBe(1);
    expect(await events("account_enabled")).toBe(1);
    // Other organizations' members are unknown.
    expect((await call("POST", `/api/people/${w.stranger}/disable`, { as: "root" })).status).toBe(
      404,
    );
  });

  it("ends every session of a member", async () => {
    const s = await fullSession(w.db, helper, w.a);
    const r = await call("POST", `/api/people/${helper}/end-sessions`, { as: "root" });
    expect(r.status).toBe(200);
    expect(r.json.ended).toBeGreaterThanOrEqual(1);
    expect((await resolveSession(w.db, s.token)).ok).toBe(false);
    expect(await events("sessions_ended")).toBe(1);
  });

  it("resets two-step sign-in with the admin's own code; the set-up token reaches only the mailbox", async () => {
    const wrong = await call("POST", `/api/people/${helper}/reset-two-step`, {
      as: "root",
      body: { recoveryCode: "0000-0000-0000-0000-0000-0000" },
    });
    expect(wrong.status).toBe(422);
    expect(enrolments).toHaveLength(0);
    const r = await call("POST", `/api/people/${helper}/reset-two-step`, {
      as: "root",
      body: { recoveryCode: spareRecoveryCode(w.root) },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ hadFactor: true, delivered: true });
    expect(enrolments).toHaveLength(1);
    const token = enrolments[0]?.token ?? "";
    expect(r.res.body).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(await events("second_factor_reset")).toBe(1);
  });

  it("warns before a reset link to an account with no second factor in use (D-078)", async () => {
    // Just reset above: no factor in use.
    const r = await call("POST", `/api/people/${helper}/password-reset`, { as: "root" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("confirmation_required");
    expect(codes(r)).toEqual(["confirm_mailbox_only"]);
    expect(resets).toHaveLength(0);
    const confirmed = await call("POST", `/api/people/${helper}/password-reset`, {
      as: "root",
      body: { confirmMailboxOnly: true },
    });
    expect(confirmed.status).toBe(200);
    expect(resets).toHaveLength(1);
    expect(confirmed.res.body).not.toContain(resets[0]?.token ?? "?");
    expect(JSON.stringify(logged)).not.toContain(resets[0]?.token ?? "?");
    // Someone with a factor in use gets the link without the warning.
    const plain = await call("POST", `/api/people/${w.cataloger}/password-reset`, { as: "root" });
    expect(plain.status).toBe(200);
    expect(await events("password_reset_sent")).toBe(2);
  });

  it("needs a recent re-entry for account actions", async () => {
    const s = await fullSession(w.db, w.root, w.a);
    await staleReauth(w.db, s.sessionId, 11 * 60);
    tokens.staleRoot = s.token;
    for (const action of ["disable", "end-sessions"]) {
      const r = await call("POST", `/api/people/${w.cataloger}/${action}`, { as: "staleRoot" });
      expect(r.json.error, action).toBe("reauthentication_required");
    }
    expect((await resolveSession(w.db, tokens.cataloger)).ok).toBe(true);
  });
});

describe("invitations", () => {
  it("sends the token to the mailbox only, never in the reply or the log", async () => {
    const r = await call("POST", "/api/invitations", {
      as: "root",
      body: { email: "fresh.volunteer@example.org" },
    });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["email", "expiresAt", "invitationId"]);
    const token = invitations.at(-1)?.token ?? "";
    expect(token.length).toBeGreaterThan(20);
    expect(r.res.body).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(await events("invited")).toBe(1);
  });

  it("says nothing about whether an address has an account in another organization", async () => {
    const [row] = await w.db.rows<{ email: string }>(
      sql`SELECT email FROM public.users WHERE id = ${w.stranger}::uuid`,
    );
    const elsewhere = await call("POST", "/api/invitations", {
      as: "root",
      body: { email: row?.email },
    });
    const fresh = await call("POST", "/api/invitations", {
      as: "root",
      body: { email: "never.seen@example.org" },
    });
    expect(elsewhere.status).toBe(fresh.status);
    expect(Object.keys(elsewhere.json).sort()).toEqual(Object.keys(fresh.json).sort());
  });

  it("needs the password and code entered in the last 10 minutes (John, Q-11)", async () => {
    const s = await fullSession(w.db, w.root, w.a);
    await staleReauth(w.db, s.sessionId, 11 * 60);
    tokens.staleInviter = s.token;
    const before = invitations.length;
    const beforeEvents = await events("invited");
    const stale = await call("POST", "/api/invitations", {
      as: "staleInviter",
      body: { email: "too.late@example.org" },
    });
    expect([stale.status, stale.json.error]).toEqual([403, "reauthentication_required"]);
    expect(invitations).toHaveLength(before);
    expect(await events("invited")).toBe(beforeEvents);
    const [made] = await w.db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.invitations WHERE email = 'too.late@example.org'`,
    );
    expect(made?.n).toBe(0);

    // Entered just now (a new full sign-in): the same invitation goes out.
    tokens.freshInviter = (await fullSession(w.db, w.root, w.a)).token;
    const fresh = await call("POST", "/api/invitations", {
      as: "freshInviter",
      body: { email: "too.late@example.org" },
    });
    expect(fresh.status).toBe(201);
    expect(invitations).toHaveLength(before + 1);
  });

  it("asks a site manager for nothing more: still refused as not permitted, never asked to sign in again", async () => {
    const s = await fullSession(w.db, w.manager, w.a);
    await staleReauth(w.db, s.sessionId, 11 * 60);
    tokens.staleInviteManager = s.token;
    const r = await call("POST", "/api/invitations", {
      as: "staleInviteManager",
      body: { email: "someone.else@example.org" },
    });
    expect([r.status, r.json.error]).toEqual([403, "not_permitted"]);
  });

  it("refuses a malformed address and bad lives", async () => {
    expect(
      (await call("POST", "/api/invitations", { as: "root", body: { email: "not an address" } }))
        .status,
    ).toBe(422);
    expect(
      (
        await call("POST", "/api/invitations", {
          as: "root",
          body: { email: "a@example.org", expiresInDays: 99 },
        })
      ).status,
    ).toBe(422);
  });
});

describe("the audit trail", () => {
  interface Entry {
    type: string;
    recordId?: string;
    kind?: string;
    siteId?: string | null;
  }
  async function trail(as: string, query = "") {
    const r = await call("GET", `/api/audit${query}`, { as });
    return { ...r, entries: (r.json.entries ?? []) as Entry[] };
  }

  it("shows a system manager everything, deleted records' histories included", async () => {
    const r = await trail("root", "?limit=100");
    expect(r.status).toBe(200);
    const records = new Set(r.entries.filter((e) => e.type === "record").map((e) => e.recordId));
    expect(records).toContain(a1Record);
    expect(records).toContain(a2Record);
    expect(records).toContain(deletedRecord);
    const kinds = new Set(r.entries.filter((e) => e.type === "people").map((e) => e.kind));
    for (const kind of ["role_granted", "account_disabled", "invited", "second_factor_reset"]) {
      expect(kinds).toContain(kind);
    }
  });

  it("shows a site manager their sites' records and role changes, nothing else", async () => {
    const r = await trail("manager", "?limit=100");
    expect(r.status).toBe(200);
    const records = new Set(r.entries.filter((e) => e.type === "record").map((e) => e.recordId));
    expect(records).toContain(a1Record);
    expect(records).not.toContain(a2Record);
    expect(records).not.toContain(deletedRecord);
    for (const e of r.entries.filter((x) => x.type === "people")) {
      expect(["role_granted", "role_revoked"]).toContain(e.kind);
      expect(e.siteId).toBe(w.a1);
    }
    expect(r.res.body).not.toContain("fresh.volunteer@example.org");
  });

  it("shows a cataloger their site's records only, and refuses people with no history right", async () => {
    const c = await trail("cataloger", "?limit=100");
    expect(c.status).toBe(200);
    expect(c.entries.every((e) => e.type === "record")).toBe(true);
    expect(c.entries.map((e) => e.recordId)).not.toContain(a2Record);
    expect((await trail("reader")).status).toBe(403);
    const s = await trail("stranger", "?limit=100");
    expect(s.entries.map((e) => e.recordId)).not.toContain(a1Record);
  });

  it("answers a filter on a hidden record exactly as one on a missing record", async () => {
    const hidden = await trail("manager", `?record=${a2Record}`);
    const missing = await trail("manager", `?record=${MADE_UP}`);
    expect(hidden.res.body).toBe(missing.res.body);
    expect(hidden.entries).toEqual([]);
    const deleted = await trail("manager", `?record=${deletedRecord}`);
    expect(deleted.res.body).toBe(missing.res.body);
    expect((await trail("root", `?record=${deletedRecord}`)).entries.length).toBe(2);
  });

  it("filters by person and date, and pages", async () => {
    const byManager = await trail("root", `?person=${w.manager}&limit=100`);
    expect(byManager.entries.length).toBeGreaterThan(0);
    const future = await trail("root", "?from=2999-01-01");
    expect(future.entries).toEqual([]);
    const first = await trail("root", "?limit=2");
    expect(first.entries).toHaveLength(2);
    const next = String(first.json.next);
    const second = await trail("root", `?limit=2&after=${encodeURIComponent(next)}`);
    expect(second.status).toBe(200);
    expect(second.entries[0]).not.toEqual(first.entries[0]);
    expect((await trail("root", "?after=nonsense")).status).toBe(422);
    expect((await trail("root", "?from=yesterday")).status).toBe(422);
  });
});

describe("review fixes", () => {
  it("answers impossible cursors and dates 422, never 500", async () => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    for (const query of [
      `after=${encodeURIComponent(`2026-13-45T99:99:99.999999_e${id}`)}`,
      `after=${encodeURIComponent(`0000-01-01T00:00:00.000000_e${id}`)}`,
      `after=${encodeURIComponent(`2026-02-30T10:00:00.000000_e${id}`)}`,
      "from=2026-02-30",
      "to=2026-13-01",
      "from=2026-02-28T25:00Z",
    ]) {
      const r = await call("GET", `/api/audit?${query}`, { as: "root" });
      expect(r.status, query).toBe(422);
    }
    const fine = await call("GET", `/api/audit?from=2024-02-29&to=2026-02-28`, { as: "root" });
    expect(fine.status).toBe(200);
  });

  it("stops a slow audit trail with 503 timeout", async () => {
    const holder = openDatabase(w.testDb.url, { max: 1 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locking = holder.transaction(async (q) => {
      await q.execute(sql`LOCK TABLE public.people_events IN ACCESS EXCLUSIVE MODE`);
      await held;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const r = await call("GET", "/api/audit", { as: "root" });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe("timeout");
    } finally {
      release();
      await locking;
      await holder.close();
    }
  }, 30_000);

  it("answers a malformed person ID on a grant exactly as a missing person", async () => {
    const body = { role: "cataloger", siteId: w.a1, scope: null };
    const bad = await call("POST", "/api/people/not-an-id/roles", { as: "root", body });
    const missing = await call("POST", `/api/people/${MADE_UP}/roles`, { as: "root", body });
    expect(bad.status).toBe(404);
    expect(shape(bad)).toEqual(shape(missing));
  });

  it("logs an invitation whose message failed", async () => {
    const before = await events("invited");
    const made = await w.service.invitePerson(
      { organizationId: w.a, actor: actorOf(w.root), sessionToken: tokens.root ?? "" },
      { email: "unlucky@example.org" },
      () => Promise.reject(new Error("the invented mail server is down")),
    );
    expect(made.ok ? [] : made.issues.map((i) => i.code)).toEqual(["delivery_failed"]);
    expect(await events("invited")).toBe(before + 1);
  });

  it("re-checks membership in the account functions' own transactions (memberOf)", async () => {
    const stranger = await fullSession(w.db, w.stranger, w.b);
    const ended = await endUserSessions(w.db, tokens.root, w.stranger, { memberOf: w.a });
    expect(ended.ok ? [] : ended.issues.map((i) => i.code)).toEqual(["unknown_user"]);
    expect((await resolveSession(w.db, stranger.token)).ok).toBe(true);
    const sent = await sendPasswordReset(w.db, tokens.root, w.stranger, () => Promise.resolve(), {
      memberOf: w.a,
    });
    expect(sent.ok ? [] : sent.issues.map((i) => i.code)).toEqual(["unknown_user"]);
    const reset = await resetSecondFactor(
      w.db,
      testKeyring(),
      tokens.root,
      w.stranger,
      { recoveryCode: spareRecoveryCode(w.root), source: "10.43.0.1" },
      () => Promise.resolve(),
      { memberOf: w.a },
    );
    expect(reset.ok ? [] : reset.issues.map((i) => i.code)).toEqual(["unknown_user"]);
    expect((await resolveSession(w.db, stranger.token)).ok).toBe(true);
  });
});

describe("the log", () => {
  it("holds no token, address or record title", () => {
    const text = JSON.stringify(logged);
    for (const token of Object.values(tokens)) expect(text).not.toContain(token);
    expect(text).not.toContain("example.org");
    expect(text).not.toContain("invented");
  });
});
