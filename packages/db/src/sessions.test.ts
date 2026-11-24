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
  hashPassword,
  hashSessionToken,
  newOrganizationId,
  newSessionId,
  newSessionToken,
  throttleAccountKey,
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
import { openDatabase, type Database, type Queryable, type Row } from "./client.js";
import { migrate } from "./migrate.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import { SECOND_STEP_PROOF_MS, passedSecondStep } from "./second-step.js";
import {
  NO_SESSION,
  SESSION_TABLE_PRIVILEGES,
  beginSession,
  deleteExpiredSessions,
  endAllSessionsForUser,
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

/**
 * A full session without a password check (no scrypt, so race loops stay
 * fast): a waiting session inserted directly, as the owner, then promoted.
 */
async function fastFull(
  userId: UserId,
  organizationId: OrganizationId,
): Promise<{ token: string; sessionId: SessionId }> {
  const token = newSessionToken();
  const id = newSessionId();
  await db.execute(sql`
    INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
      created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at)
    SELECT ${id}::uuid, ${hashSessionToken(token)}, ${userId}::uuid, ${organizationId}::uuid,
      'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
    FROM (SELECT clock_timestamp() AS t) c`);
  const r = await promoteSession(db, token, passedSecondStep(id, userId));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { token: r.token, sessionId: id };
}

/** Sessions of `userId` the database would still accept. */
async function liveRowsOf(userId: UserId): Promise<number> {
  const rows = await db.rows<{ n: string }>(sql`
    SELECT count(*) AS n FROM public.sessions s
    WHERE user_id = ${userId}::uuid AND public.session_live(s)
      AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)`);
  return Number(rows[0]?.n ?? "0");
}

/** Ends all of a user's sessions as T-039's reset will, outside the races. */
async function endAllDirect(userId: UserId): Promise<void> {
  await db.transaction((tx) => endAllSessionsForUser(tx, userId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RACE_ROUNDS = 30;

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
    expect(await endSession(db, p.token)).toEqual({ ok: true, ended: true });
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

  it("asks a system admin with no memberships to name the organization", async () => {
    await ready();
    const p = await pending({ email: ADMIN_EMAIL });
    const proof = passedSecondStep(p.sessionId, admin);
    expect(await promoteSession(db, p.token, proof)).toMatchObject({
      ok: false,
      code: "organization_required",
    });
    expect(
      await promoteSession(db, p.token, proof, { organizationId: newOrganizationId() }),
    ).toMatchObject({ ok: false, code: "not_permitted" });
    const org = await organization();
    expect(await promoteSession(db, p.token, proof, { organizationId: org })).toMatchObject({
      ok: true,
      session: { organizationId: org, systemAdmin: true },
    });
  });

  it("counts a system admin's sign-in to an organization that doesn't exist as a failed attempt", async () => {
    await ready();
    const key = throttleAccountKey(ADMIN_EMAIL);
    await db.execute(sql`DELETE FROM public.sign_in_throttles WHERE key = ${key}`);
    expect(
      await beginSession(db, {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        source: source(),
        organizationId: newOrganizationId(),
      }),
    ).toBe(INVALID_CREDENTIALS);
    const rows = await db.rows<{ failures: number }>(
      sql`SELECT failures FROM public.sign_in_throttles WHERE key = ${key}`,
    );
    expect(rows[0]?.failures).toBe(1);
  });

  it("is allowed only to sessions.ts and the session tests (the second step is T-038's)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // A speed bump, not the control: code review is (D-069).
    const repo = join(import.meta.dirname, "..", "..", "..");
    const allowed = new Set([
      "packages/db/src/sessions.ts",
      "packages/db/src/sessions.test.ts",
      "packages/db/src/second-step.ts",
    ]);
    const dirs = [
      ...readdirSync(join(repo, "packages")).map((pkg) => join("packages", pkg, "src")),
      "scripts",
      "tools",
    ];
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(join(repo, dir), { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.split(/[\\/]/).includes("node_modules")) continue;
        if (!/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|py)$/.test(file)) continue;
        const name = join(dir, file).split("\\").join("/");
        const text = readFileSync(join(repo, dir, file), "utf8");
        scanned += 1;
        if (/second-step|passedSecondStep|promoteSession/.test(text) && !allowed.has(name)) {
          offenders.push(name);
        }
      }
    }
    expect(scanned).toBeGreaterThan(50);
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
      expect(await endSession(db, form)).toEqual({ ok: true, ended: false });
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
    if (!again.ok) throw new Error("not re-authenticated");
    // A new token (ASVS session rotation on re-authentication); the old one is dead.
    expect(again.token).not.toBe(s.token);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect(await resolveSession(db, again.token)).toMatchObject({
      session: { sessionId: s.session.sessionId, recentlyAuthenticated: true },
    });
    // Wrong guesses count toward the sign-in wait (D-068): after 5, a wait.
    for (let i = 0; i < 5; i++) {
      await reauthenticate(db, again.token, { password: `wrong ${String(i)}`, source: source() });
    }
    expect(
      await reauthenticate(db, again.token, { password: PASSWORD, source: source() }),
    ).toMatchObject({ ok: false, code: "throttled" });
    // The database refuses a recent re-entry without a new token.
    await expect(
      db.execute(sql`UPDATE public.sessions SET password_at = clock_timestamp()
        WHERE id = ${s.session.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_times" });
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
    expect(await endSession(db, mine.token)).toEqual({ ok: true, ended: true });
    expect(await resolveSession(db, mine.token)).toBe(NO_SESSION);
    expect(await endSession(db, mine.token)).toEqual({ ok: true, ended: false });
  });

  it("can all be ended by a system admin, and by nobody else", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await member(org);
    const s = await full(person, org);
    const notAdmin = await full(other, org);
    expect(codesOf(await endUserSessions(db, notAdmin.token, person.userId))).toEqual([
      "not_permitted",
    ]);
    // A user ID alone is not enough: it takes an admin's own live session.
    expect(codesOf(await endUserSessions(db, newSessionToken(), person.userId))).toEqual([
      "no_session",
    ]);
    expect((await resolveSession(db, s.token)).ok).toBe(true);
    const adminSession = await full({ email: ADMIN_EMAIL }, org);
    expect(ok(await endUserSessions(db, adminSession.token, person.userId))).toEqual({
      ended: 1,
    });
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect((await resolveSession(db, adminSession.token)).ok).toBe(true);
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
    // Re-enabling revives nothing: the row is from before sessions_valid_after.
    await db.execute(
      sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
    );
    expect((await rowsOf(person.userId)).length).toBe(1);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    // The cleanup removes it, and a new sign-in works.
    await runCleanup(db);
    expect(await rowsOf(person.userId)).toEqual([]);
    expect((await full(person, org)).session.userId).toBe(person.userId);
  });

  it("sessions_valid_after only moves forward and never past now, for any writer", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    await expect(
      db.execute(sql`UPDATE public.users SET sessions_valid_after = clock_timestamp() + interval '1 day'
        WHERE id = ${person.userId}::uuid`),
    ).rejects.toMatchObject({ constraint: "users_sessions_valid_after" });
    expect((await resolveSession(db, s.token)).ok).toBe(true);
    await db.execute(sql`UPDATE public.users SET sessions_valid_after = clock_timestamp()
      WHERE id = ${person.userId}::uuid`);
    expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
    expect(await rowsOf(person.userId)).toEqual([]);
    await expect(
      db.execute(sql`UPDATE public.users SET sessions_valid_after = '-infinity'
        WHERE id = ${person.userId}::uuid`),
    ).rejects.toMatchObject({ constraint: "users_sessions_valid_after" });
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

describe("database errors", () => {
  /** A connection whose every query fails with `error`. */
  function failing(error: Error): Database {
    const fail = () => Promise.reject(error);
    return {
      rows: fail,
      execute: fail,
      transaction: fail,
      close: () => Promise.resolve(),
    };
  }

  it("come back as fixed refusals, the raw error only to onError, never a token", async () => {
    const token = newSessionToken();
    for (const [code, expected] of [
      ["57014", "timeout"],
      ["40001", "retry"],
      ["40P01", "retry"],
      ["08006", "database_unavailable"],
      ["53300", "database_unavailable"],
      ["57P01", "database_unavailable"],
      ["XX000", "database_unavailable"],
      ["55P03", "timeout"],
      ["ENOENT", "database_unavailable"],
      ["ECONNREFUSED", "database_unavailable"],
    ] as const) {
      // A server error, or a Node system error from the socket (with its
      // syscall), as client.ts's isDatabaseFailure judges them (S-016).
      const error = Object.assign(
        new Error(`failed near ${token}`),
        code.startsWith("E") ? { code, syscall: "connect" } : { code },
      );
      const seen: unknown[] = [];
      const onError = (e: unknown) => seen.push(e);
      const conn = failing(error);
      for (const r of [
        await resolveSession(conn, token, { onError }),
        await readPendingSession(conn, token, { onError }),
        await rotateSession(conn, token, { onError }),
        await listSessions(conn, token, { onError }),
        await endSession(conn, token, { onError }),
        await endOtherSessions(conn, token, { onError }),
        await switchOrganization(conn, token, newOrganizationId(), { onError }),
      ]) {
        expect(r).toMatchObject({ ok: false, code: expected });
        expect(JSON.stringify(r)).not.toContain(token);
      }
      expect(codesOf(await endOwnSession(conn, token, newSessionId(), { onError }))).toEqual([
        expected,
      ]);
      expect(seen.length).toBeGreaterThanOrEqual(8);
      expect(seen.every((e) => e === error)).toBe(true);
    }
  });

  it("ignore a failing onError, and throw what isn't a database error", async () => {
    const token = newSessionToken();
    const conn = failing(Object.assign(new Error("x"), { code: "57014" }));
    expect(
      await resolveSession(conn, token, {
        onError: () => {
          throw new Error("log down");
        },
      }),
    ).toMatchObject({ code: "timeout" });
    await expect(resolveSession(failing(new Error("a bug")), token)).rejects.toThrow("a bug");
    // Programming and permission errors are thrown, not hidden (S-016).
    for (const code of ["42501", "42P01", "22P02", "ERR_INVALID_ARG_TYPE"]) {
      const error = Object.assign(new Error(code), { code });
      await expect(resolveSession(failing(error), token)).rejects.toBe(error);
      await expect(endOwnSession(failing(error), token, newSessionId())).rejects.toBe(error);
    }
    // pg's own code-less connection error counts as the database's failure.
    expect(
      await resolveSession(failing(new Error("Connection terminated unexpectedly")), token),
    ).toMatchObject({ code: "database_unavailable" });
    await expect(
      resolveSession(conn, token, { onError: "no" } as unknown as { onError: () => void }),
    ).rejects.toThrow(TypeError);
  });
});

describe(
  "ending sessions while they are being made (review B1, two connections, looped)",
  { timeout: 120_000 },
  () => {
    it("sign out everywhere else ends a copy being switched at the same moment", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const orgA = await organization();
        const orgB = await organization();
        const person = await member(orgA, orgB);
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const caller = await fastFull(person.userId, orgA);
          const thief = await fastFull(person.userId, orgA);
          const [ended, moved] = await Promise.all([
            endOtherSessions(db, caller.token),
            switchOrganization(other, thief.token, orgB),
          ]);
          expect({ round, ok: ended.ok }).toEqual({ round, ok: true });
          expect(await resolveSession(db, thief.token)).toBe(NO_SESSION);
          if (moved.ok) expect(await resolveSession(db, moved.token)).toBe(NO_SESSION);
          expect((await resolveSession(db, caller.token)).ok).toBe(true);
          expect({ round, live: await liveRowsOf(person.userId) }).toEqual({ round, live: 1 });
          await endSession(db, caller.token);
        }
      } finally {
        await other.close();
      }
    });

    it("sign out everywhere else ends a copy whose switch is provably mid-way (ordered, not left to timing)", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      const holder = openDatabase(testDb.url, { max: 1 });
      try {
        const orgA = await organization();
        const orgB = await organization();
        const person = await member(orgA, orgB);
        for (let round = 0; round < 10; round++) {
          const caller = await fastFull(person.userId, orgA);
          const thief = await fastFull(person.userId, orgA);
          // A third connection holds the thief's session row, so the switch
          // stops inside its transaction, at its row lock, after whatever it
          // took before.
          let release = (): void => undefined;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let held = (): void => undefined;
          const holding = new Promise<void>((resolve) => {
            held = resolve;
          });
          const holderDone = holder.transaction(async (q) => {
            await q.rows(sql`SELECT 1 FROM public.sessions
            WHERE id = ${thief.sessionId}::uuid FOR UPDATE`);
            held();
            await gate;
          });
          await holding;
          const moving = switchOrganization(other, thief.token, orgB);
          await sleep(100);
          const ending = endOtherSessions(db, caller.token);
          await sleep(100);
          release();
          await holderDone;
          const [moved, ended] = await Promise.all([moving, ending]);
          expect({ round, ok: ended.ok }).toEqual({ round, ok: true });
          if (moved.ok) expect(await resolveSession(db, moved.token)).toBe(NO_SESSION);
          expect({ round, live: await liveRowsOf(person.userId) }).toEqual({ round, live: 1 });
          expect((await resolveSession(db, caller.token)).ok).toBe(true);
          await endSession(db, caller.token);
        }
      } finally {
        await holder.close();
        await other.close();
      }
    });

    it("the caller's own switch at the same moment keeps the caller signed in", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const orgA = await organization();
        const orgB = await organization();
        const person = await member(orgA, orgB);
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const caller = await fastFull(person.userId, orgA);
          const elsewhere = await fastFull(person.userId, orgA);
          const [ended, moved] = await Promise.all([
            endOtherSessions(db, caller.token),
            switchOrganization(other, caller.token, orgB),
          ]);
          // Whichever ran first, the caller's own session survives, moved.
          if (!moved.ok) throw new Error(`round ${String(round)}: ${JSON.stringify(moved)}`);
          expect((await resolveSession(db, moved.token)).ok).toBe(true);
          expect(await resolveSession(db, caller.token)).toBe(NO_SESSION);
          if (ended.ok) {
            // It ran first: the other session is gone.
            expect(await resolveSession(db, elsewhere.token)).toBe(NO_SESSION);
          } else {
            // The switch ran first, so the old token was gone: nothing ended.
            expect(ended).toBe(NO_SESSION);
          }
          await endAllDirect(person.userId);
        }
      } finally {
        await other.close();
      }
    });

    it("a system admin ending someone's sessions ends a copy being switched at the same moment", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const orgA = await organization();
        const orgB = await organization();
        const person = await member(orgA, orgB);
        const adminSession = await fastFull(admin, orgA);
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await fastFull(person.userId, orgA);
          const [ended, moved] = await Promise.all([
            endUserSessions(db, adminSession.token, person.userId),
            switchOrganization(other, s.token, orgB),
          ]);
          expect({ round, ok: ended.ok }).toEqual({ round, ok: true });
          if (moved.ok) expect(await resolveSession(db, moved.token)).toBe(NO_SESSION);
          expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
          expect({ round, live: await liveRowsOf(person.userId) }).toEqual({ round, live: 0 });
        }
      } finally {
        await other.close();
      }
    });

    it("disabling an account ends a copy being switched, and re-enabling revives nothing", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const orgA = await organization();
        const orgB = await organization();
        const person = await member(orgA, orgB);
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const s = await fastFull(person.userId, orgA);
          const [, moved] = await Promise.all([
            sleep(round % 3).then(() =>
              db.execute(
                sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
              ),
            ),
            switchOrganization(other, s.token, orgB),
          ]);
          await db.execute(
            sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
          );
          expect(await resolveSession(db, s.token)).toBe(NO_SESSION);
          if (moved.ok) expect(await resolveSession(db, moved.token)).toBe(NO_SESSION);
          expect({ round, rows: (await rowsOf(person.userId)).length }).toEqual({ round, rows: 0 });
        }
      } finally {
        await other.close();
      }
    });

    it("disabling an account during a sign-in leaves no session that re-enabling revives", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const org = await organization();
        const person = await member(org);
        let made = 0;
        for (let round = 0; round < RACE_ROUNDS; round++) {
          // A sign-in refused because the account was disabled counts as a
          // failure (D-068); start each round with no wait.
          await db.execute(sql`DELETE FROM public.sign_in_throttles
          WHERE key = ${throttleAccountKey(person.email)}`);
          const [started] = await Promise.all([
            beginSession(other, {
              email: person.email,
              password: PASSWORD,
              source: source(),
              organizationId: org,
            }),
            sleep((round * 37) % 300).then(() =>
              db.execute(
                sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
              ),
            ),
          ]);
          await db.execute(
            sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
          );
          if (started.ok) {
            made += 1;
            expect(await readPendingSession(db, started.token)).toBe(NO_SESSION);
          } else {
            expect(started).toBe(INVALID_CREDENTIALS);
          }
          expect({ round, rows: (await rowsOf(person.userId)).length }).toEqual({ round, rows: 0 });
        }
        // Both orders happened at least once, or the loop proved little.
        expect(made).toBeGreaterThan(0);
        expect(made).toBeLessThan(RACE_ROUNDS);
      } finally {
        await other.close();
      }
    });

    it("removing a membership ends a copy being switched into that organization", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        for (let round = 0; round < 5; round++) {
          const orgA = await organization();
          const orgB = await organization();
          const person = await member(orgA, orgB);
          const s = await fastFull(person.userId, orgA);
          const [, moved] = await Promise.all([
            db.execute(sql`DELETE FROM public.organization_members
            WHERE user_id = ${person.userId}::uuid AND organization_id = ${orgB}::uuid`),
            switchOrganization(other, s.token, orgB),
          ]);
          if (moved.ok) expect(await resolveSession(db, moved.token)).toBe(NO_SESSION);
          const left = await db.rows(sql`SELECT 1 FROM public.sessions
          WHERE user_id = ${person.userId}::uuid AND organization_id = ${orgB}::uuid`);
          expect({ round, left: left.length }).toEqual({ round, left: 0 });
        }
      } finally {
        await other.close();
      }
    });
  },
);

describe(
  "a sign-in can't outrun a password change or 'end all' (second review, R1)",
  { timeout: 180_000 },
  () => {
    /**
     * `base`, except that the first query whose text `match`es waits for
     * `hook` (run on another connection, committed) before it runs: an
     * ordering pinned down rather than left to timing.
     */
    function before(
      base: Database,
      match: (text: string) => boolean,
      hook: () => Promise<void>,
    ): Database {
      let fired = false;
      const gate = async (query: Sql): Promise<void> => {
        if (!fired && match(query.text)) {
          fired = true;
          await hook();
        }
      };
      const wrap = (q: Queryable): Queryable => ({
        rows: async <R extends Row = Row>(query: Sql): Promise<R[]> => {
          await gate(query);
          return q.rows<R>(query);
        },
        execute: async (query: Sql): Promise<number> => {
          await gate(query);
          return q.execute(query);
        },
      });
      return {
        ...wrap(base),
        transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
          base.transaction((tx) => work(wrap(tx))),
        close: () => base.close(),
      };
    }

    /** As T-039's reset will: end every session and set a new password, in one transaction. */
    async function resetPassword(conn: Database, userId: UserId, password: string): Promise<void> {
      const hash = await hashPassword(password);
      await conn.transaction(async (tx) => {
        await endAllSessionsForUser(tx, userId);
        await tx.execute(sql`UPDATE public.users SET password_hash = ${hash},
        password_changed_at = now() WHERE id = ${userId}::uuid`);
      });
    }

    const atInsert = (text: string) =>
      text.includes("sessions_valid_after =") && text.includes("FOR SHARE");

    it("refuses the session when a reset, an 'end all' or a password change commits after the check", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 2 });
      try {
        const org = await organization();
        for (const change of ["reset", "end all", "password only"] as const) {
          const person = await member(org);
          const hook = async (): Promise<void> => {
            if (change === "reset")
              await resetPassword(other, person.userId, "a new invented passphrase");
            else if (change === "end all")
              await other.transaction((tx) =>
                endAllSessionsForUser(tx, person.userId).then(() => undefined),
              );
            else
              await other.execute(sql`UPDATE public.users
              SET password_hash = ${await hashPassword("a new invented passphrase")}
              WHERE id = ${person.userId}::uuid`);
          };
          const r = await beginSession(before(db, atInsert, hook), {
            email: person.email,
            password: PASSWORD,
            source: source(),
            organizationId: org,
          });
          expect({ change, r }).toEqual({ change, r: INVALID_CREDENTIALS });
          expect({ change, rows: await rowsOf(person.userId) }).toEqual({ change, rows: [] });
        }
      } finally {
        await other.close();
      }
    });

    it("doesn't mark a session recently authenticated with a password changed meanwhile", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 2 });
      try {
        const org = await organization();
        const person = await member(org);
        const s = await full(person, org);
        await age(s.session.sessionId, 11 * 60);
        const r = await reauthenticate(
          before(
            db,
            (text) => text.includes("password_at = clock_timestamp()"),
            async () => {
              await other.execute(sql`UPDATE public.users
              SET password_hash = ${await hashPassword("a new invented passphrase")}
              WHERE id = ${person.userId}::uuid`);
            },
          ),
          s.token,
          { password: PASSWORD, source: source() },
        );
        expect(r).toBe(INVALID_CREDENTIALS);
        expect(await resolveSession(db, s.token)).toMatchObject({
          ok: true,
          session: { recentlyAuthenticated: false },
        });
      } finally {
        await other.close();
      }
    });

    it("leaves no live session after a reset racing a sign-in (two connections, looped)", async () => {
      await ready();
      const other = openDatabase(testDb.url, { max: 4 });
      try {
        const org = await organization();
        const person = await member(org);
        let password = PASSWORD;
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const next = `an invented passphrase for round ${String(round)}`;
          const [started] = await Promise.all([
            beginSession(other, {
              email: person.email,
              password,
              source: source(),
              organizationId: org,
            }),
            sleep((round * 41) % 400).then(() => resetPassword(db, person.userId, next)),
          ]);
          // Whichever order: no session from the old password is left alive.
          if (started.ok) {
            expect(await readPendingSession(db, started.token)).toBe(NO_SESSION);
          }
          expect({ round, live: await liveRowsOf(person.userId) }).toEqual({ round, live: 0 });
          password = next;
          await db.execute(sql`DELETE FROM public.sign_in_throttles
          WHERE key = ${throttleAccountKey(person.email)}`);
        }
      } finally {
        await other.close();
      }
    });
  },
);

describe("locks and clocks (second review, items 1 and 2)", { timeout: 180_000 }, () => {
  it("an admin ending their own sessions while another of theirs ends the rest never deadlocks", async () => {
    await ready();
    const deadlocks = async (): Promise<number> => {
      await db.rows(sql`SELECT pg_stat_clear_snapshot()`);
      const rows = await db.rows<{ n: string }>(sql`
        SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`);
      return Number(rows[0]?.n ?? "0");
    };
    const org = await organization();
    const orgB = await organization();
    const a = openDatabase(testDb.url, { max: 2 });
    const b = openDatabase(testDb.url, { max: 2 });
    const start = await deadlocks();
    try {
      for (let round = 0; round < 20; round++) {
        const first = await fastFull(admin, org);
        const second = await fastFull(admin, org);
        const third = await fastFull(admin, org);
        const results = await Promise.all([
          endUserSessions(a, first.token, admin),
          endOtherSessions(b, second.token),
          switchOrganization(b, third.token, orgB),
        ]);
        for (const r of results) {
          expect(JSON.stringify(r)).not.toMatch(/retry|database_unavailable/);
        }
      }
    } finally {
      // Statistics are written when a connection ends.
      await a.close();
      await b.close();
    }
    await sleep(500);
    expect(await deadlocks()).toBe(start);
  });

  it("asks an admin to enter their password again before ending someone's sessions", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person, org);
    // Earlier tests ended the admin's sessions, which moved the admin's
    // sessions_valid_after to then; put it back (as the owner, trigger off
    // inside this transaction only) so aging the new session below
    // doesn't put its sign-in before that time.
    await db.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.users DISABLE TRIGGER users_sessions_valid_after`);
      await q.execute(sql`UPDATE public.users SET sessions_valid_after = '-infinity'
        WHERE id = ${admin}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_sessions_valid_after`,
      );
    });
    const adminSession = await full({ email: ADMIN_EMAIL }, org);
    await age(adminSession.session.sessionId, 11 * 60);
    expect(codesOf(await endUserSessions(db, adminSession.token, person.userId))).toEqual([
      "reauthentication_required",
    ]);
    expect((await resolveSession(db, s.token)).ok).toBe(true);
    const again = await reauthenticate(db, adminSession.token, {
      password: ADMIN_PASSWORD,
      source: source(),
    });
    if (!again.ok) throw new Error("not re-authenticated");
    expect(ok(await endUserSessions(db, again.token, person.userId))).toEqual({ ended: 1 });
  });

  it("disabling, or ending all, kills a session stamped ahead of the clock, and re-enabling revives nothing", async () => {
    await ready();
    const org = await organization();
    for (const how of ["disable", "end all"] as const) {
      const person = await member(org);
      const s = await full(person, org);
      // As if the server's clock stepped back an hour after this sign-in.
      // Such a session can't be used until the clock catches up (its
      // last_seen_at is ahead), but then it would live again.
      await age(s.session.sessionId, -3600);
      const stamped = await db.rows<{ ahead: boolean }>(sql`
        SELECT signed_in_at > clock_timestamp() + interval '50 minutes' AS ahead
        FROM public.sessions WHERE id = ${s.session.sessionId}::uuid`);
      expect(stamped).toEqual([{ ahead: true }]);
      if (how === "disable") {
        await db.execute(
          sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
        );
        await db.execute(
          sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
        );
      } else {
        await db.transaction((tx) => endAllSessionsForUser(tx, person.userId));
      }
      expect({ how, r: await resolveSession(db, s.token) }).toEqual({ how, r: NO_SESSION });
      expect({ how, rows: await rowsOf(person.userId) }).toEqual({ how, rows: [] });
      // Past the stamp, so even a copy of it that escaped could never live.
      const after = await db.rows<{ past: boolean }>(sql`
        SELECT sessions_valid_after > clock_timestamp() + interval '50 minutes' AS past
        FROM public.users WHERE id = ${person.userId}::uuid`);
      expect({ how, after }).toEqual({ how, after: [{ past: true }] });
      // The price (D-069): until the clock passes that stamp, a new sign-in
      // for this account makes no session.
      expect(
        await beginSession(db, {
          email: person.email,
          password: PASSWORD,
          source: source(),
          organizationId: org,
        }),
      ).toBe(INVALID_CREDENTIALS);
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
        AND (c.relname = 'sessions' OR t.tgname LIKE '%end_sessions'
             OR t.tgname = 'users_sessions_valid_after')
      ORDER BY 1`);
    expect(rows).toEqual([
      { name: "organization_members.organization_members_end_sessions", enabled: "A" },
      { name: "sessions.sessions_check_change", enabled: "A" },
      { name: "sessions.sessions_check_new", enabled: "A" },
      { name: "sessions.zzzz_sessions_keep_identity", enabled: "A" },
      { name: "users.users_end_sessions", enabled: "A" },
      { name: "users.users_sessions_valid_after", enabled: "A" },
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
      const re = await reauthenticate(writer, moved.token, {
        password: PASSWORD,
        source: source(),
      });
      if (!re.ok) throw new Error("not re-authenticated");
      const list = await listSessions(writer, re.token);
      expect(list.ok && list.sessions.length).toBe(1);
      const second = await full(person, orgA, writer);
      expect(await endOtherSessions(writer, re.token)).toEqual({ ok: true, ended: 1 });
      expect(await resolveSession(writer, second.token)).toBe(NO_SESSION);
      const adminSession = await full({ email: ADMIN_EMAIL }, orgA, writer);
      expect(ok(await endUserSessions(writer, adminSession.token, person.userId))).toEqual({
        ended: 1,
      });
      const last = await full(person, orgA, writer);
      expect(await endSession(writer, last.token)).toEqual({ ok: true, ended: true });
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
