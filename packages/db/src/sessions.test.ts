// Sessions (0010_sessions.sql, sessions.ts, second-step.ts, D-069) on a
// freshly migrated database: the second-step stage that grants nothing,
// promotion only with a proof, tokens in one spelling and stored hashed,
// rotation, idle and absolute limits decided by the database, re-entering
// the password, a person's own list, sign-out, switching organization,
// disabled accounts and removed memberships, two connections at once, the
// database's own guards (replica mode included), the writer role with
// exactly WRITER_PRIVILEGES, the cleanup, and the same answer (and about the
// same time) for every unusable token. Every person, address and password is
// invented (example.org is reserved for examples, RFC 2606).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCsrfToken,
  csrfTokenFor,
  hashSessionToken,
  newOrganizationId,
  newSessionId,
  newSessionToken,
  type OrganizationId,
  type SessionId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  acceptInvitation,
  acceptInvitationForUser,
  createFirstSystemAdmin,
  createInvitation,
  type InvitationMessage,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { runCleanupCli } from "./cleanup-cli.js";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { migrate } from "./migrate.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import { SECOND_STEP_PROOF_MS, passedSecondStep } from "./second-step.js";
import {
  NO_SESSION,
  SESSION_TABLE_PRIVILEGES,
  beginSession,
  deleteExpiredSessions,
  endOtherSessions,
  endOwnSession,
  endSession,
  endUserSessions,
  listSessions,
  promoteSession,
  readPendingSession,
  reauthenticate,
  resolveSession,
  rotateSession,
  runCleanup,
  switchOrganization,
  type FullSession,
} from "./sessions.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, with its bootstrap admin.

const ADMIN_EMAIL = "session.admin@example.org";
const ADMIN_PASSWORD = "a first admin passphrase, invented";
const PASSWORD = "an invented passphrase for tests";

let setup: Promise<{ testDb: TestDatabase; db: Database; admin: UserId }> | undefined;
let db: Database;
let admin: UserId;
let testDb: TestDatabase;
const cleanups: (() => Promise<void>)[] = [];

async function ready(): Promise<void> {
  setup ??= (async () => {
    const t = await freshDatabase();
    await migrate({ connectionString: t.url });
    const d = openDatabase(t.url, { max: 6 });
    const made = await createFirstSystemAdmin(d, {
      email: ADMIN_EMAIL,
      displayName: "Session Admin",
      password: ADMIN_PASSWORD,
    });
    return { testDb: t, db: d, admin: ok(made).userId };
  })();
  ({ db, admin, testDb } = await setup);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
    await done.testDb.drop();
  }
  for (const cleanup of cleanups) await cleanup();
});

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

let counter = 0;
function unique(): number {
  counter += 1;
  return counter;
}
function email(): string {
  return `session.person${String(unique())}@example.org`;
}
/** A client address of its own (a private range, RFC 1918). */
function source(): string {
  const n = unique();
  return `10.37.${String(Math.floor(n / 250))}.${String(1 + (n % 250))}`;
}

async function organization(): Promise<OrganizationId> {
  const id = newOrganizationId();
  ok(await insertOrganization(db, { id, name: `Invented Society ${String(unique())}` }));
  return id;
}

/** A new person in `organizationId` (and then each of `more`). */
async function member(
  organizationId: OrganizationId,
  ...more: OrganizationId[]
): Promise<{ userId: UserId; email: string }> {
  const address = email();
  let userId: UserId | undefined;
  for (const org of [organizationId, ...more]) {
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(db, { organizationId: org, email: address, invitedBy: admin }, (m) => {
        box.push(m);
        return Promise.resolve();
      }),
    );
    const token = box[0]?.token ?? "";
    if (userId === undefined) {
      userId = ok(
        await acceptInvitation(db, {
          token,
          organizationId: org,
          email: address,
          displayName: "Invented Person",
          password: PASSWORD,
        }),
      ).userId;
    } else {
      // An existing account joins with its own (signed-in) acceptance.
      ok(await acceptInvitationForUser(db, { token, organizationId: org, userId }));
    }
  }
  if (userId === undefined) throw new Error("no user");
  return { userId, email: address };
}

/** Signs in to the second-step stage. */
async function pending(
  who: { email: string },
  organizationId?: OrganizationId,
  conn: Database = db,
): Promise<{ token: string; sessionId: SessionId; userId: UserId }> {
  const r = await beginSession(conn, {
    email: who.email,
    password: who.email === ADMIN_EMAIL ? ADMIN_PASSWORD : PASSWORD,
    source: source(),
    ...(organizationId === undefined ? {} : { organizationId }),
    clientLabel: "Invented Browser on Test",
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { token: r.token, sessionId: r.session.sessionId, userId: r.session.userId };
}

/** Signs in all the way, as T-038 will after a code passes. */
async function full(
  who: { email: string },
  organizationId?: OrganizationId,
  conn: Database = db,
): Promise<{ token: string; session: FullSession }> {
  const p = await pending(who, organizationId, conn);
  const r = await promoteSession(conn, p.token, passedSecondStep(p.sessionId, p.userId));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { token: r.token, session: r.session };
}

/**
 * Moves a session back in time by `seconds`, as the owner: the change
 * triggers are off inside this transaction only and back on ALWAYS before
 * it commits (D-067). With `keepLastSeen`, `last_seen_at` stays (the
 * session was used just now, but started long ago).
 */
async function age(
  sessionId: SessionId,
  seconds: number,
  { keepLastSeen = false }: { keepLastSeen?: boolean } = {},
): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`);
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER zzzz_sessions_keep_identity`);
    await q.execute(sql`
      UPDATE public.sessions SET
        signed_in_at = signed_in_at - make_interval(secs => ${seconds}),
        created_at = created_at - make_interval(secs => ${seconds}),
        rotated_at = rotated_at - make_interval(secs => ${seconds}),
        password_at = password_at - make_interval(secs => ${seconds}),
        second_step_at = second_step_at - make_interval(secs => ${seconds}),
        expires_at = expires_at - make_interval(secs => ${seconds}),
        last_seen_at = CASE WHEN ${keepLastSeen} THEN last_seen_at
                            ELSE last_seen_at - make_interval(secs => ${seconds}) END
      WHERE id = ${sessionId}::uuid`);
    await q.execute(sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change`);
    await q.execute(
      sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity`,
    );
  });
}

async function rowsOf(userId: UserId): Promise<{ id: string; stage: string }[]> {
  return db.rows(sql`SELECT id::text, stage FROM public.sessions WHERE user_id = ${userId}::uuid`);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------

describe("signing in gives only a session waiting for its second step", () => {
  it("refuses a wrong password or an unknown address exactly as signIn does, storing nothing", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const before = await db.rows(sql`SELECT count(*) AS n FROM public.sessions`);
    for (const attempt of [
      { email: person.email, password: "not the passphrase at all" },
      { email: "nobody.here@example.org", password: PASSWORD },
    ]) {
      expect(await beginSession(db, { ...attempt, source: source() })).toBe(INVALID_CREDENTIALS);
    }
    // An organization the person isn't in: the same refusal.
    expect(
      await beginSession(db, {
        email: person.email,
        password: PASSWORD,
        source: source(),
        organizationId: await organization(),
      }),
    ).toBe(INVALID_CREDENTIALS);
    expect(await db.rows(sql`SELECT count(*) AS n FROM public.sessions`)).toEqual(before);
    expect(
      await beginSession(db, {
        email: person.email,
        password: PASSWORD,
        source: source(),
        x: 1,
      } as never),
    ).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("grants nothing but reading it, ending it and promotion", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person, org);
    const read = await readPendingSession(db, p.token);
    expect(read).toMatchObject({
      ok: true,
      session: { sessionId: p.sessionId, userId: person.userId, organizationId: org },
    });
    expect(await resolveSession(db, p.token)).toBe(NO_SESSION);
    expect(await rotateSession(db, p.token)).toBe(NO_SESSION);
    expect(await listSessions(db, p.token)).toBe(NO_SESSION);
    expect(await endOtherSessions(db, p.token)).toBe(NO_SESSION);
    expect(await switchOrganization(db, p.token, org)).toBe(NO_SESSION);
    expect(await reauthenticate(db, p.token, { password: PASSWORD, source: source() })).toBe(
      NO_SESSION,
    );
    expect(codesOf(await endOwnSession(db, p.token, p.sessionId))).toEqual(["no_session"]);
    expect(await rowsOf(person.userId)).toEqual([{ id: p.sessionId, stage: "second_step" }]);
    // Sign-out works in this stage.
    expect(await endSession(db, p.token)).toEqual({ ended: true });
    expect(await readPendingSession(db, p.token)).toBe(NO_SESSION);
  });

  it("stores only the token's SHA-256, never the token", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person, org);
    const rows = await db.rows<{ row: string; hash: Uint8Array }>(sql`
      SELECT to_jsonb(s)::text AS row, token_hash AS hash FROM public.sessions s
      WHERE id = ${p.sessionId}::uuid`);
    expect(Buffer.from(rows[0]?.hash ?? [])).toEqual(Buffer.from(hashSessionToken(p.token)));
    expect(rows[0]?.row).not.toContain(p.token);
    expect(rows[0]?.row).not.toContain(Buffer.from(p.token, "base64url").toString("hex"));
  });

  it("lasts 10 minutes, then can't be read or promoted", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person, org);
    await age(p.sessionId, 9 * 60);
    expect((await readPendingSession(db, p.token)).ok).toBe(true);
    await age(p.sessionId, 61);
    expect(await readPendingSession(db, p.token)).toBe(NO_SESSION);
    expect(await promoteSession(db, p.token, passedSecondStep(p.sessionId, person.userId))).toBe(
      NO_SESSION,
    );
    // The database refuses to revive or promote it as well.
    await expect(
      db.execute(sql`UPDATE public.sessions SET stage = 'full', second_step_at = clock_timestamp(),
          organization_id = ${org}::uuid, token_hash = ${hashSessionToken(newSessionToken())},
          rotated_at = clock_timestamp(),
          expires_at = signed_in_at + make_interval(secs => absolute_seconds)
        WHERE id = ${p.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_ended" });
  });
});

function codesOf(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("promotion needs a proof that only the second step makes", () => {
  it("refuses a look-alike proof, another session's proof and a used proof", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await member(org);
    const p = await pending(person, org);
    const q = await pending(other, org);
    const fake = Object.freeze({ sessionId: p.sessionId, userId: person.userId });
    expect(await promoteSession(db, p.token, fake)).toBe(NO_SESSION);
    expect(await promoteSession(db, p.token, passedSecondStep(q.sessionId, other.userId))).toBe(
      NO_SESSION,
    );
    expect(await promoteSession(db, p.token, passedSecondStep(p.sessionId, other.userId))).toBe(
      NO_SESSION,
    );
    expect(await promoteSession(db, q.token, passedSecondStep(p.sessionId, person.userId))).toBe(
      NO_SESSION,
    );
    const proof = passedSecondStep(p.sessionId, person.userId);
    const done = await promoteSession(db, p.token, proof);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // A new token; the old one is dead in both stages.
    expect(done.token).not.toBe(p.token);
    expect(await readPendingSession(db, p.token)).toBe(NO_SESSION);
    expect(await resolveSession(db, p.token)).toBe(NO_SESSION);
    expect(await resolveSession(db, done.token)).toMatchObject({
      ok: true,
      session: { sessionId: p.sessionId, userId: person.userId, organizationId: org },
    });
    // Spent, and a full session can't be promoted again.
    expect(await promoteSession(db, done.token, proof)).toBe(NO_SESSION);
    expect(await promoteSession(db, done.token, passedSecondStep(p.sessionId, person.userId))).toBe(
      NO_SESSION,
    );
  });

  it("refuses a proof older than a minute", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person, org);
    const start = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(start);
    const proof = passedSecondStep(p.sessionId, person.userId);
    clock.mockReturnValue(start + SECOND_STEP_PROOF_MS + 1);
    expect(await promoteSession(db, p.token, proof)).toBe(NO_SESSION);
    clock.mockReturnValue(start);
    // Forgotten once stale.
    expect(await promoteSession(db, p.token, proof)).toBe(NO_SESSION);
  });

  it("asks a person in several organizations to choose, keeping the proof, and refuses one they aren't in", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const stranger = await organization();
    const person = await member(orgA, orgB);
    const p = await pending(person);
    const proof = passedSecondStep(p.sessionId, person.userId);
    const choose = await promoteSession(db, p.token, proof);
    expect(choose).toEqual({
      ok: false,
      code: "choose_organization",
      message: expect.any(String) as string,
      organizationIds: [orgA, orgB].sort(),
    });
    expect(await promoteSession(db, p.token, proof, { organizationId: stranger })).toMatchObject({
      ok: false,
      code: "not_permitted",
    });
    const done = await promoteSession(db, p.token, proof, { organizationId: orgB });
    expect(done).toMatchObject({ ok: true, session: { organizationId: orgB } });
    // The organization chosen at the password can't be swapped at promotion.
    const q = await pending(person, orgA);
    expect(
      await promoteSession(db, q.token, passedSecondStep(q.sessionId, person.userId), {
        organizationId: orgB,
      }),
    ).toMatchObject({ ok: false, code: "not_permitted" });
  });

  it("is allowed only to sessions.ts and the session tests (the second step is T-038's)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..", "..");
    const allowed = new Set([
      "db/src/sessions.ts",
      "db/src/sessions.test.ts",
      "db/src/second-step.ts",
    ]);
    const offenders: string[] = [];
    for (const pkg of readdirSync(root)) {
      const dir = join(root, pkg, "src");
      let files: string[];
      try {
        files = readdirSync(dir, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/\.(ts|mts|cts|js|mjs)$/.test(file)) continue;
        const name = `${pkg}/src/${file}`;
        const text = readFileSync(join(dir, file), "utf8");
        if (
          /second-step(\.js)?["']|passedSecondStep|promoteSession/.test(text) &&
          !allowed.has(name)
        ) {
          offenders.push(name);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Not part of the package's public surface either.
    const index = await import("./index.js");
    expect(Object.keys(index)).not.toContain("promoteSession");
    expect(Object.keys(index)).not.toContain("passedSecondStep");
  });
});

describe("full sessions", () => {
  it("end after the idle limit, and use keeps them going", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    await age(s.session.sessionId, 4 * 3600 - 60);
    const used = await resolveSession(db, s.token);
    expect(used.ok).toBe(true);
    // Just used: another 4 hours from now.
    await age(s.session.sessionId, 60, { keepLastSeen: true });
    expect((await resolveSession(db, s.token)).ok).toBe(true);
    await age(s.session.sessionId, 4 * 3600 + 1);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    // Nothing revives it, even a direct write.
    await expect(
      db.execute(sql`UPDATE public.sessions SET last_seen_at = clock_timestamp()
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_ended" });
  });

  it("end 12 hours after the password however much they are used", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    await age(s.session.sessionId, 12 * 3600 - 30, { keepLastSeen: true });
    const near = await resolveSession(db, s.token);
    expect(near.ok).toBe(true);
    await age(s.session.sessionId, 31, { keepLastSeen: true });
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
  });

  it("keep a system manager's shorter limits", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const r = await beginSession(
      db,
      { email: person.email, password: PASSWORD, source: source(), organizationId: org },
      { policy: { idleSeconds: 300, absoluteSeconds: 3600 } },
    );
    if (!r.ok) throw new Error("not signed in");
    const done = await promoteSession(
      db,
      r.token,
      passedSecondStep(r.session.sessionId, person.userId),
    );
    if (!done.ok) throw new Error("not promoted");
    await age(r.session.sessionId, 301);
    expect(await resolveSession(db, done.token)).toBe(NO_SESSION);
    await expect(
      beginSession(
        db,
        { email: person.email, password: PASSWORD, source: source() },
        { policy: { idleSeconds: 7200, absoluteSeconds: 3600 } },
      ),
    ).rejects.toThrow(TypeError);
  });

  it("rotate to a new token and CSRF token, and the old token stops at once", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    const csrf = csrfTokenFor(s.token);
    const r = await rotateSession(db, s.token);
    if (!r.ok) throw new Error("not rotated");
    expect(r.token).not.toBe(s.token);
    expect(r.session.sessionId).toBe(s.session.sessionId);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect((await resolveSession(db, r.token)).ok).toBe(true);
    expect(checkCsrfToken(r.token, csrf)).toBe(false);
    expect(checkCsrfToken(r.token, csrfTokenFor(r.token))).toBe(true);
    expect(await rotateSession(db, s.token)).toBe(NO_SESSION);
  });

  it("refuse every other spelling of a real token before asking the database", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(s.token.at(-1) ?? "A");
    const forms = [
      ...[1, 2, 3].map((d) => s.token.slice(0, -1) + (alphabet[(last & ~3) + d] ?? "")),
      `${s.token}=`,
      Buffer.from(s.token, "base64url").toString("base64"),
      ` ${s.token}`,
      `${s.token}\u0000`,
      s.token.toUpperCase(),
      Buffer.from(s.token, "base64url").toString("hex"),
    ].filter((f) => f !== s.token);
    expect(forms.length).toBeGreaterThan(6);
    for (const form of forms) {
      expect({ form, r: await resolveSession(db, form) }).toEqual({ form, r: NO_SESSION });
      expect(await endSession(db, form)).toEqual({ ended: false });
    }
    expect((await resolveSession(db, s.token)).ok).toBe(true);
  });

  it("say whether the password was entered recently, and re-entering it is throttled like sign-in", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    expect(await resolveSession(db, s.token)).toMatchObject({
      ok: true,
      session: { recentlyAuthenticated: true },
    });
    await age(s.session.sessionId, 11 * 60);
    expect(await resolveSession(db, s.token)).toMatchObject({
      session: { recentlyAuthenticated: false },
    });
    expect(await resolveSession(db, s.token, { recentAuthenticationSeconds: 3600 })).toMatchObject({
      session: { recentlyAuthenticated: true },
    });
    await expect(resolveSession(db, s.token, { recentAuthenticationSeconds: 30 })).rejects.toThrow(
      TypeError,
    );
    const from = source();
    expect(await reauthenticate(db, s.token, { password: "wrong passphrase", source: from })).toBe(
      INVALID_CREDENTIALS,
    );
    expect(await resolveSession(db, s.token)).toMatchObject({
      session: { recentlyAuthenticated: false },
    });
    const again = await reauthenticate(db, s.token, { password: PASSWORD, source: from });
    expect(again).toMatchObject({ ok: true, session: { recentlyAuthenticated: true } });
    // Wrong guesses count toward the sign-in wait (D-068): after 5, a wait.
    for (let i = 0; i < 5; i++) {
      await reauthenticate(db, s.token, { password: `wrong ${String(i)}`, source: source() });
    }
    expect(
      await reauthenticate(db, s.token, { password: PASSWORD, source: source() }),
    ).toMatchObject({ ok: false, code: "throttled" });
  });
});

describe("a person's own sessions", () => {
  it("lists only their own, without tokens or hashes, and ends only their own", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await member(org);
    const mine = await full(person, org);
    const mine2 = await full(person, org);
    const minePending = await pending(person, org);
    const theirs = await full(other, org);
    const list = await listSessions(db, mine.token);
    if (!list.ok) throw new Error("no list");
    expect(list.sessions.map((s) => s.sessionId).sort()).toEqual(
      [mine.session.sessionId, mine2.session.sessionId, minePending.sessionId].sort(),
    );
    for (const s of list.sessions) {
      expect(Object.keys(s).sort()).toEqual([
        "clientLabel",
        "current",
        "endsAt",
        "lastSeenAt",
        "organizationId",
        "sessionId",
        "signedInAt",
        "stage",
      ]);
      expect(s.current).toBe(s.sessionId === mine.session.sessionId);
      expect(s.clientLabel).toBe("Invented Browser on Test");
    }
    const text = JSON.stringify(list);
    for (const t of [mine.token, mine2.token, minePending.token, theirs.token]) {
      expect(text).not.toContain(t);
      expect(text).not.toContain(Buffer.from(hashSessionToken(t)).toString("hex"));
    }
    // Someone else's session ID is unknown here, and theirs keeps working.
    expect(codesOf(await endOwnSession(db, mine.token, theirs.session.sessionId))).toEqual([
      "unknown_session",
    ]);
    expect(codesOf(await endOwnSession(db, mine.token, newSessionId()))).toEqual([
      "unknown_session",
    ]);
    expect(codesOf(await endOwnSession(db, mine.token, "not an id"))).toEqual(["unknown_session"]);
    expect((await resolveSession(db, theirs.token)).ok).toBe(true);
    ok(await endOwnSession(db, mine.token, mine2.session.sessionId));
    expect(await resolveSession(db, mine2.token)).toBe(NO_SESSION);
    // Sign out everywhere else: the pending one goes too, theirs stays.
    expect(await endOtherSessions(db, mine.token)).toEqual({ ok: true, ended: 1 });
    expect(await readPendingSession(db, minePending.token)).toBe(NO_SESSION);
    expect((await resolveSession(db, mine.token)).ok).toBe(true);
    expect((await resolveSession(db, theirs.token)).ok).toBe(true);
    // Sign-out.
    expect(await endSession(db, mine.token)).toEqual({ ended: true });
    expect(await resolveSession(db, mine.token)).toBe(NO_SESSION);
    expect(await endSession(db, mine.token)).toEqual({ ended: false });
  });

  it("can all be ended by a system admin, and by nobody else", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await member(org);
    const s = await full(person, org);
    expect(codesOf(await endUserSessions(db, { userId: person.userId, by: other.userId }))).toEqual(
      ["not_permitted"],
    );
    expect((await resolveSession(db, s.token)).ok).toBe(true);
    expect(ok(await endUserSessions(db, { userId: person.userId, by: admin }))).toEqual({
      ended: 1,
    });
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
  });
});

describe("one organization per session", () => {
  it("switching makes a new session for the same sign-in and ends the old one", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const stranger = await organization();
    const person = await member(orgA, orgB);
    const s = await full(person, orgA);
    expect(await switchOrganization(db, s.token, stranger)).toMatchObject({
      ok: false,
      code: "not_permitted",
    });
    // An organization that doesn't exist gets the same answer.
    expect(await switchOrganization(db, s.token, newOrganizationId())).toEqual(
      await switchOrganization(db, s.token, stranger),
    );
    expect(await switchOrganization(db, s.token, orgA)).toMatchObject({
      code: "same_organization",
    });
    const moved = await switchOrganization(db, s.token, orgB);
    if (!moved.ok) throw new Error("not switched");
    expect(moved.session.organizationId).toBe(orgB);
    expect(moved.session.sessionId).not.toBe(s.session.sessionId);
    expect(moved.session.signedInAt).toBe(s.session.signedInAt);
    expect(moved.session.expiresAt).toBe(s.session.expiresAt);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect(await resolveSession(db, moved.token)).toMatchObject({
      ok: true,
      session: { organizationId: orgB, userId: person.userId },
    });
    expect((await rowsOf(person.userId)).length).toBe(1);
  });

  it("a system admin may work in any organization that exists", async () => {
    await ready();
    const org = await organization();
    const s = await full({ email: ADMIN_EMAIL }, org);
    expect(s.session).toMatchObject({ organizationId: org, systemAdmin: true });
    const other = await organization();
    expect(await switchOrganization(db, s.token, other)).toMatchObject({
      ok: true,
      session: { organizationId: other },
    });
    expect(await switchOrganization(db, s.token, other)).toBe(NO_SESSION);
  });

  it("the database never moves a session or makes a full one out of nothing", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA, orgB);
    const s = await full(person, orgA);
    await expect(
      db.execute(sql`UPDATE public.sessions SET organization_id = ${orgB}::uuid
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_organization" });
    await expect(
      db.execute(sql`UPDATE public.sessions SET stage = 'second_step', second_step_at = NULL
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) as string });
    const forged = (signedIn: Sql) => sql`
      INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
        created_at, last_seen_at, rotated_at, password_at, second_step_at, idle_seconds,
        absolute_seconds, expires_at)
      SELECT gen_random_uuid(), ${hashSessionToken(newSessionToken())}, ${person.userId}::uuid,
        ${orgB}::uuid, 'full', t0, t, t, t, t0, t0, 14400, 43200, t0 + interval '12 hours'
      FROM (SELECT clock_timestamp() AS t, ${signedIn} AS t0) c`;
    await expect(db.execute(forged(sql`clock_timestamp()`))).rejects.toMatchObject({
      constraint: "sessions_new_full",
    });
    await expect(
      db.execute(forged(sql`clock_timestamp() - interval '1 hour'`)),
    ).rejects.toMatchObject({ constraint: "sessions_new_full" });
    // A waiting session can't be inserted back-dated, or in an organization
    // the person isn't in.
    await expect(
      db.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, stage, signed_in_at, created_at,
          last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at)
        SELECT gen_random_uuid(), ${hashSessionToken(newSessionToken())}, ${person.userId}::uuid,
          'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() - interval '1 minute' AS t) c`),
    ).rejects.toMatchObject({ constraint: "sessions_new_now" });
    const stranger = await organization();
    await expect(
      db.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
          created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at)
        SELECT gen_random_uuid(), ${hashSessionToken(newSessionToken())}, ${person.userId}::uuid,
          ${stranger}::uuid, 'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() AS t) c`),
    ).rejects.toMatchObject({ constraint: "sessions_access" });
    // Promotion always changes the token.
    const p = await pending(person, orgA);
    await expect(
      db.execute(sql`UPDATE public.sessions SET stage = 'full', second_step_at = clock_timestamp(),
          expires_at = signed_in_at + make_interval(secs => absolute_seconds)
        WHERE id = ${p.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_promotion_rotates" });
    // Times never run ahead of the clock.
    await expect(
      db.execute(sql`UPDATE public.sessions SET last_seen_at = clock_timestamp() + interval '1 day'
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_times" });
    await expect(
      db.execute(sql`UPDATE public.sessions SET idle_seconds = 43200
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ code: "23000" });
  });
});

describe("accounts and memberships", () => {
  it("disabling an account ends all its sessions, and a disabled account can't use one", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA, orgB);
    const a = await full(person, orgA);
    const b = await full(person, orgB);
    const p = await pending(person, orgA);
    await db.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
    );
    expect(await rowsOf(person.userId)).toEqual([]);
    for (const t of [a.token, b.token]) expect(await resolveSession(db, t)).toBe(NO_SESSION);
    expect(await readPendingSession(db, p.token)).toBe(NO_SESSION);
    expect(
      await beginSession(db, { email: person.email, password: PASSWORD, source: source() }),
    ).toBe(INVALID_CREDENTIALS);
  });

  it("a disabled account is refused by the lookup itself, even if its rows were left", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    await db.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.users DISABLE TRIGGER users_end_sessions`);
      await q.execute(
        sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
      );
      await q.execute(sql`ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_end_sessions`);
    });
    expect((await rowsOf(person.userId)).length).toBe(1);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect(await listSessions(db, s.token)).toBe(NO_SESSION);
  });

  it("removing a membership ends the sessions in that organization only", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA, orgB);
    const a = await full(person, orgA);
    const b = await full(person, orgB);
    await db.execute(sql`DELETE FROM public.organization_members
      WHERE user_id = ${person.userId}::uuid AND organization_id = ${orgA}::uuid`);
    expect(await resolveSession(db, a.token)).toBe(NO_SESSION);
    expect((await resolveSession(db, b.token)).ok).toBe(true);
    expect(await switchOrganization(db, b.token, orgA)).toMatchObject({ code: "not_permitted" });
  });
});

describe("two connections at once", () => {
  it("share a session, and a rotation on one ends the old token on the other", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      const org = await organization();
      const person = await member(org);
      const s = await full(person, org);
      const both = await Promise.all(
        Array.from({ length: 8 }, (_, i) => resolveSession(i % 2 === 0 ? db : other, s.token)),
      );
      expect(both.every((r) => r.ok)).toBe(true);
      const rotated = await rotateSession(db, s.token);
      if (!rotated.ok) throw new Error("not rotated");
      expect(await resolveSession(other, s.token)).toBe(NO_SESSION);
      expect((await resolveSession(other, rotated.token)).ok).toBe(true);
      // Two rotations of one token at once: exactly one wins.
      const race = await Promise.all([
        rotateSession(db, rotated.token),
        rotateSession(other, rotated.token),
      ]);
      expect(race.filter((r) => r.ok)).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("one proof promotes once, and one token switches once", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      const orgA = await organization();
      const orgB = await organization();
      const person = await member(orgA, orgB);
      const p = await pending(person, orgA);
      const proof = passedSecondStep(p.sessionId, person.userId);
      const promoted = await Promise.all([
        promoteSession(db, p.token, proof),
        promoteSession(other, p.token, proof),
      ]);
      const winners = promoted.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const token = winners[0]?.ok === true ? winners[0].token : "";
      const switched = await Promise.all([
        switchOrganization(db, token, orgB),
        switchOrganization(other, token, orgB),
      ]);
      expect(switched.filter((r) => r.ok)).toHaveLength(1);
      expect((await rowsOf(person.userId)).length).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("a session disabled on one connection is refused on the other at once", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 2 });
    try {
      const org = await organization();
      const person = await member(org);
      const s = await full(person, org);
      expect((await resolveSession(other, s.token)).ok).toBe(true);
      await db.execute(
        sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
      );
      expect(await resolveSession(other, s.token)).toBe(NO_SESSION);
    } finally {
      await other.close();
    }
  });
});

describe("every unusable token", () => {
  it("gets the same answer, in about the same time, whether unknown or known but unusable", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const expired = await full(person, org);
    await age(expired.session.sessionId, 5 * 3600);
    const ended = await full(person, org);
    await endSession(db, ended.token);
    const waiting = await pending(person, org);
    const kinds: Record<string, () => string> = {
      unknown: () => newSessionToken(),
      expired: () => expired.token,
      ended: () => ended.token,
      waiting: () => waiting.token,
    };
    const times: Record<string, number[]> = { unknown: [], expired: [], ended: [], waiting: [] };
    for (let round = 0; round < 60; round++) {
      for (const [kind, token] of Object.entries(kinds)) {
        const t = token();
        const start = performance.now();
        const r = await resolveSession(db, t);
        times[kind]?.push(performance.now() - start);
        expect(r).toBe(NO_SESSION);
      }
    }
    const medians = Object.values(times).map(median);
    // Every lookup is one indexed statement; a known-but-unusable token must
    // not stand out from an unknown one.
    expect(Math.max(...medians)).toBeLessThan(Math.min(...medians) * 2.5 + 0.5);
  });
});

describe("the cleanup", () => {
  it("deletes ended sessions and old sign-in counters, and keeps live ones", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const live = await full(person, org);
    const idle = await full(person, org);
    await age(idle.session.sessionId, 4 * 3600 + 5);
    const stalePending = await pending(person, org);
    await age(stalePending.sessionId, 11 * 60);
    const freshPending = await pending(person, org);
    await db.execute(sql`INSERT INTO public.sign_in_throttles (key, failures, last_failure_at)
      VALUES ('source:v4:10.37.250.250', 3, now() - interval '2 days')`);
    const done = await runCleanup(db);
    expect(done.sessions).toBeGreaterThanOrEqual(2);
    expect(done.signInThrottles).toBeGreaterThanOrEqual(1);
    const left = (await rowsOf(person.userId)).map((r) => r.id).sort();
    expect(left).toEqual([live.session.sessionId, freshPending.sessionId].sort());
    expect(await deleteExpiredSessions(db)).toBe(0);
  });

  it("runs as a command, without printing the address", async () => {
    await ready();
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runCleanupCli(
        {},
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(2);
    expect(err.join("")).toContain("OCULUS_DATABASE_URL");
    out.length = 0;
    err.length = 0;
    expect(
      await runCleanupCli(
        { OCULUS_DATABASE_URL: testDb.url },
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/^Done: \d+ ended session\(s\) and \d+ old sign-in counter/);
    expect(out.join("\n")).not.toContain(testDb.name);
    expect(err).toEqual([]);
  });
});

describe("guards in replica mode and the writer role", () => {
  it("fire every session trigger always", async () => {
    await ready();
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND (c.relname = 'sessions' OR t.tgname LIKE '%end_sessions')
      ORDER BY 1`);
    expect(rows).toEqual([
      { name: "organization_members.organization_members_end_sessions", enabled: "A" },
      { name: "sessions.sessions_check_change", enabled: "A" },
      { name: "sessions.sessions_check_new", enabled: "A" },
      { name: "sessions.zzzz_sessions_keep_identity", enabled: "A" },
      { name: "users.users_end_sessions", enabled: "A" },
    ]);
    const org = await organization();
    const second = await organization();
    const person = await member(org, second);
    const s = await full(person, org);
    const replica = (statement: Sql) =>
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(statement);
      });
    await expect(
      replica(sql`UPDATE public.sessions SET organization_id = ${second}::uuid
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_organization" });
    await replica(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
    );
    expect(await rowsOf(person.userId)).toEqual([]);
  });

  it("the writer, with exactly WRITER_PRIVILEGES, can do everything sessions need and no more", async () => {
    await ready();
    const role = `oculus_test_t037_${unique().toString()}_${String(process.pid)}`;
    const run = async (statement: string, q: Queryable): Promise<void> => {
      await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                              set_config('oculus_test.statement', ${statement}, true)`);
      await q.execute(sql`DO $$ BEGIN
        EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
      END $$`);
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction((q) => run("CREATE ROLE %I LOGIN", q));
    } finally {
      await server.close();
    }
    cleanups.push(async () => {
      const s = openDatabase(testServerUrl(), { max: 1 });
      try {
        await s.transaction((q) => run("DROP ROLE IF EXISTS %I", q));
      } finally {
        await s.close();
      }
    });
    await db.transaction((q) => grantWriterRole(q, role));
    const url = new URL(testDb.url);
    url.username = role;
    const writer = openDatabase(url.toString(), { max: 3 });
    try {
      expect(await checkWriterConnection(writer)).toEqual([]);
      expect(WRITER_PRIVILEGES.sessions).toEqual(SESSION_TABLE_PRIVILEGES.sessions);
      for (const extra of [
        "GRANT TRUNCATE ON public.sessions TO %I",
        "GRANT TRIGGER ON public.sessions TO %I",
        "GRANT REFERENCES ON public.sessions TO %I",
      ]) {
        await db.transaction((q) => run(extra, q));
        try {
          expect((await checkWriterConnection(writer)).map((p) => p.code)).toEqual([
            "extra_privilege",
          ]);
        } finally {
          await db.transaction((q) =>
            run(extra.replace("GRANT", "REVOKE").replace(" TO ", " FROM "), q),
          );
        }
      }
      expect(await checkWriterConnection(writer)).toEqual([]);
      // The whole life of a session, as the writer.
      const orgA = await organization();
      const orgB = await organization();
      const person = await member(orgA, orgB);
      const s = await full(person, orgA, writer);
      expect((await resolveSession(writer, s.token)).ok).toBe(true);
      const r = await rotateSession(writer, s.token);
      if (!r.ok) throw new Error("not rotated");
      const moved = await switchOrganization(writer, r.token, orgB);
      if (!moved.ok) throw new Error("not switched");
      expect(
        await reauthenticate(writer, moved.token, { password: PASSWORD, source: source() }),
      ).toMatchObject({ ok: true });
      const list = await listSessions(writer, moved.token);
      expect(list.ok && list.sessions.length).toBe(1);
      const second = await full(person, orgA, writer);
      expect(await endOtherSessions(writer, moved.token)).toEqual({ ok: true, ended: 1 });
      expect(await resolveSession(writer, second.token)).toBe(NO_SESSION);
      expect(ok(await endUserSessions(writer, { userId: person.userId, by: admin }))).toEqual({
        ended: 1,
      });
      const last = await full(person, orgA, writer);
      expect(await endSession(writer, last.token)).toEqual({ ended: true });
      await runCleanup(writer);
      // Disabling (as T-048 will, through the writer) ends sessions.
      const again = await full(person, orgA, writer);
      await writer.execute(
        sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
      );
      expect(await resolveSession(writer, again.token)).toBe(NO_SESSION);
      // What the writer can't do with direct SQL.
      const other = await member(orgA, orgB);
      const o = await full(other, orgA, writer);
      for (const attempt of [
        sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`,
        sql`TRUNCATE public.sessions`,
        sql`SET session_replication_role = replica`,
      ]) {
        await expect(writer.execute(attempt)).rejects.toMatchObject({
          code: expect.stringMatching(/^42/) as string,
        });
      }
      await expect(
        writer.execute(sql`UPDATE public.sessions SET organization_id = ${orgB}::uuid
          WHERE id = ${o.session.sessionId}::uuid`),
      ).rejects.toMatchObject({ constraint: "sessions_organization" });
      await expect(
        writer.execute(sql`
          INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
            created_at, last_seen_at, rotated_at, password_at, second_step_at, idle_seconds,
            absolute_seconds, expires_at)
          SELECT gen_random_uuid(), ${hashSessionToken(newSessionToken())}, ${other.userId}::uuid,
            ${orgA}::uuid, 'full', t, t, t, t, t, t, 14400, 43200, t + interval '12 hours'
          FROM (SELECT clock_timestamp() AS t) c`),
      ).rejects.toMatchObject({ constraint: "sessions_new_full" });
    } finally {
      await writer.close();
    }
  });
});
