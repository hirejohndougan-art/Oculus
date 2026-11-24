// Password reset links (0015_password_resets.sql, password-resets.ts, D-078)
// on a freshly migrated database: the same reply and about the same time for
// every address, the reset counters, single use, expiry, a newer link
// revoking the older, links dying when the account changes, the new password
// rules, every session ended and nobody signed in, delivery after commit
// with a time limit, the token never leaking, a system admin's link, two
// connections at once, the database's own guards (replica mode included),
// the writer role with exactly WRITER_PRIVILEGES, and the cleanup. Every
// person, address and password is invented (example.org is reserved for
// examples, RFC 2606; addresses are from RFC 1918's private ranges).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  hashResetToken,
  hashSessionToken,
  newOrganizationId,
  newResetToken,
  newSessionToken,
  newUserId,
  resetThrottleAccountKey,
  resetThrottleNetworkKey,
  resetThrottleSourceKey,
  throttleAccountKey,
  throttleSourceKey,
  type OrganizationId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  acceptInvitation,
  acceptInvitationForUser,
  clearSignInThrottle,
  createFirstSystemAdmin,
  createInvitation,
  deleteExpiredSignInThrottles,
  signIn,
  type InvitationMessage,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable, type Row } from "./client.js";
import { migrate } from "./migrate.js";
import {
  MAX_RESET_WORK,
  PASSWORD_RESET_TABLE_PRIVILEGES,
  RESET_REQUESTED,
  completePasswordReset,
  requestPasswordReset,
  sendPasswordReset,
  type PasswordResetDelivery,
  type PasswordResetMessage,
  type ResetOutcome,
  type ResetRequestOptions,
  type ResetRequestReply,
} from "./password-resets.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import {
  NO_SESSION,
  beginSession,
  endAllSessionsForUser,
  readPendingSession,
  resolveSession,
  runCleanup,
} from "./sessions.js";
import { sql, type Sql } from "./sql.js";
import { giveTestFactor, testKeyring, type TestFactor } from "./second-factor.fixtures.js";
import { completeSecondStep, resetSecondFactor, startEnrolment } from "./second-factor.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, with its bootstrap admin.

const ADMIN_EMAIL = "reset.admin@example.org";
const ADMIN_PASSWORD = "a first admin passphrase, invented";
const PASSWORD = "an invented passphrase for tests";
const NEW_PASSWORD = "a different invented passphrase";

let setup: Promise<{ testDb: TestDatabase; db: Database; admin: UserId }> | undefined;
const keys = testKeyring();
/** Each person's test factor (T-038); every full session uses up one recovery code. */
const factors = new Map<UserId, TestFactor>();
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
      displayName: "Reset Admin",
      password: ADMIN_PASSWORD,
    });
    const adminId = ok(made).userId;
    factors.set(adminId, await giveTestFactor(d, keys, adminId));
    return { testDb: t, db: d, admin: adminId };
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

function codeOf(result: Validated<unknown>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

let counter = 0;
function unique(): number {
  counter += 1;
  return counter;
}
function email(): string {
  return `reset.person${String(unique())}@example.org`;
}
/** A client address of its own (a private range, RFC 1918). */
function source(): string {
  const n = unique();
  return `10.39.${String(Math.floor(n / 250))}.${String(1 + (n % 250))}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

async function organization(): Promise<OrganizationId> {
  const id = newOrganizationId();
  ok(await insertOrganization(db, { id, name: `Invented Society ${String(unique())}` }));
  return id;
}

/**
 * A new person in `organizationId`, with a second factor in use (T-038),
 * unless `withFactor` is false (they never set it up).
 */
async function member(
  organizationId: OrganizationId,
  { withFactor = true }: { withFactor?: boolean } = {},
): Promise<{ userId: UserId; email: string; organizationId: OrganizationId }> {
  const address = email();
  const box: InvitationMessage[] = [];
  ok(
    await createInvitation(db, { organizationId, email: address, invitedBy: admin }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const userId = ok(
    await acceptInvitation(db, {
      token: box[0]?.token ?? "",
      organizationId,
      email: address,
      displayName: "Invented Person",
      password: PASSWORD,
    }),
  ).userId;
  if (withFactor) factors.set(userId, await giveTestFactor(db, keys, userId));
  return { userId, email: address, organizationId };
}

/** A delivery double that keeps every message. */
function mailbox(): { deliver: PasswordResetDelivery; messages: PasswordResetMessage[] } {
  const messages: PasswordResetMessage[] = [];
  return {
    messages,
    deliver: (m) => {
      messages.push(m);
      return Promise.resolve();
    },
  };
}

/**
 * Asks for a link and waits for the background work: the reply, what became
 * of it (undefined if nothing was started) and the messages sent.
 */
async function ask(
  address: string,
  options: {
    from?: string;
    deliver?: PasswordResetDelivery;
    extra?: Omit<ResetRequestOptions, "onSettled">;
    conn?: Database;
  } = {},
): Promise<{
  reply: ResetRequestReply;
  outcome: ResetOutcome | undefined;
  messages: PasswordResetMessage[];
}> {
  const box = mailbox();
  let settle: (o: ResetOutcome) => void = () => undefined;
  const settled = new Promise<ResetOutcome>((resolve) => {
    settle = resolve;
  });
  const reply = await requestPasswordReset(
    options.conn ?? db,
    { email: address, source: options.from ?? source() },
    options.deliver ?? box.deliver,
    { backgroundDelayMs: NO_DELAY, ...options.extra, onSettled: settle },
  );
  const outcome = reply.ok ? await settled : undefined;
  return { reply, outcome, messages: box.messages };
}

/** Asks for a link for `address` and returns its token (clearing the reset counter first). */
async function linkFor(address: string, conn: Database = db): Promise<string> {
  await clearResetCounter(address);
  const r = await ask(address, { conn });
  const token = r.messages[0]?.token;
  if (r.outcome !== "sent" || token === undefined) throw new Error(`no link: ${String(r.outcome)}`);
  return token;
}

async function clearResetCounter(address: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM public.sign_in_throttles WHERE key = ${resetThrottleAccountKey(address)}`);
}

async function clearSignInCounter(address: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM public.sign_in_throttles WHERE key = ${throttleAccountKey(address)}`);
}

/**
 * A full session through a real sign-in and a real second step (T-038): the
 * password, then one of the person's test recovery codes, which
 * `completeSecondStep` checks and the database binds to a pass (0014).
 * `passwordAgo` then dates the sign-in back, as the owner (the change guards
 * off inside that transaction only, back on ALWAYS before it commits), so
 * the password wasn't entered recently.
 */
async function fullSession(
  userId: UserId,
  organizationId: OrganizationId,
  passwordAgo = 0,
  password?: string,
): Promise<string> {
  const users = await db.rows<{ email: string }>(sql`
    SELECT email FROM public.users WHERE id = ${userId}::uuid`);
  const address = users[0]?.email ?? "";
  const started = await beginSession(db, {
    email: address,
    password: password ?? (address === ADMIN_EMAIL ? ADMIN_PASSWORD : PASSWORD),
    source: source(),
    organizationId,
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const code = factors.get(userId)?.codes.pop();
  if (code === undefined) throw new Error("no test recovery code left");
  const r = await completeSecondStep(db, keys, started.token, {
    recoveryCode: code,
    source: source(),
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  if (passwordAgo > 0) {
    await db.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`);
      await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER zzzz_sessions_keep_identity`);
      await q.execute(sql`
        UPDATE public.sessions SET
          signed_in_at = signed_in_at - make_interval(secs => ${passwordAgo}),
          created_at = created_at - make_interval(secs => ${passwordAgo}),
          rotated_at = rotated_at - make_interval(secs => ${passwordAgo}),
          password_at = password_at - make_interval(secs => ${passwordAgo}),
          second_step_at = second_step_at - make_interval(secs => ${passwordAgo}),
          expires_at = expires_at - make_interval(secs => ${passwordAgo}),
          last_seen_at = last_seen_at - make_interval(secs => ${passwordAgo})
        WHERE token_hash = ${hashSessionToken(r.token)}`);
      await q.execute(sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change`);
      await q.execute(
        sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity`,
      );
    });
  }
  return r.token;
}

/** A session waiting for its second step, through a real sign-in. */
async function pendingSession(
  who: { email: string },
  password = PASSWORD,
  conn: Database = db,
): Promise<string> {
  const r = await beginSession(conn, { email: who.email, password, source: source() });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.token;
}

/** Sessions of `userId` the database would still accept. */
async function liveSessions(userId: UserId): Promise<number> {
  const rows = await db.rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.sessions s
    WHERE user_id = ${userId}::uuid AND public.session_live(s)
      AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)`);
  return rows[0]?.n ?? 0;
}

/** The reset rows of `userId`, oldest first. */
async function resetsOf(
  userId: UserId,
): Promise<{ used: boolean; revoked: string | null; requested_by: string | null }[]> {
  return db.rows(sql`
    SELECT used_at IS NOT NULL AS used, revoked_reason AS revoked, requested_by::text AS requested_by
    FROM public.password_resets WHERE user_id = ${userId}::uuid ORDER BY created_at`);
}

/**
 * Moves a link (and, with `account`, the account's password change and
 * end-all times) back by `seconds`, as the owner, with the guards off inside
 * this transaction only and back on ALWAYS before it commits.
 */
async function ageLink(token: string, seconds: number, account = true): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.password_resets DISABLE TRIGGER password_resets_check_change`,
    );
    await q.execute(
      sql`ALTER TABLE public.password_resets DISABLE TRIGGER zzzz_password_resets_keep_identity`,
    );
    await q.execute(sql`ALTER TABLE public.users DISABLE TRIGGER users_password_changed_at`);
    await q.execute(sql`
      UPDATE public.password_resets SET
        created_at = created_at - make_interval(secs => ${seconds}),
        expires_at = expires_at - make_interval(secs => ${seconds})
      WHERE token_hash = ${hashResetToken(token)}`);
    if (account) {
      await q.execute(sql`
        UPDATE public.users u SET
          password_changed_at = u.password_changed_at - make_interval(secs => ${seconds + 60})
        FROM public.password_resets r
        WHERE r.token_hash = ${hashResetToken(token)} AND u.id = r.user_id`);
    }
    await q.execute(
      sql`ALTER TABLE public.password_resets ENABLE ALWAYS TRIGGER password_resets_check_change`,
    );
    await q.execute(
      sql`ALTER TABLE public.password_resets ENABLE ALWAYS TRIGGER zzzz_password_resets_keep_identity`,
    );
    await q.execute(sql`ALTER TABLE public.users ENABLE ALWAYS TRIGGER users_password_changed_at`);
  });
}

/** Tests start the background work at once (the default waits 1 to 10 s). */
const NO_DELAY = { min: 0, max: 0 };

const INVALID = { ok: false, issues: [{ path: [], code: "invalid_reset" }] };

// ---------------------------------------------------------------------------

describe("asking for a link", () => {
  it("gives the same reply for an account, no account, a disabled one and one with no organization, and sends only to the account", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const disabled = await member(org);
    await db.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${disabled.userId}::uuid`,
    );
    const alone = await member(org);
    await db.execute(sql`DELETE FROM public.organization_members
      WHERE user_id = ${alone.userId}::uuid`);
    const cases = {
      account: person.email,
      accountInCapitals: person.email.toUpperCase(),
      none: "nobody.here@example.org",
      malformed: "not an address",
      disabled: disabled.email,
      noOrganization: alone.email,
    };
    const outcomes: Record<string, ResetOutcome | undefined> = {};
    const sentTo: string[] = [];
    for (const [kind, address] of Object.entries(cases)) {
      const r = await ask(address);
      expect(r.reply).toBe(RESET_REQUESTED);
      outcomes[kind] = r.outcome;
      sentTo.push(...r.messages.map((m) => m.email));
      if (kind === "account") {
        expect(r.messages).toEqual([
          {
            email: person.email,
            token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
            expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string,
            requestedBy: "self",
          },
        ]);
      }
    }
    expect(outcomes).toEqual({
      account: "sent",
      accountInCapitals: "sent",
      none: "not_sent",
      malformed: "not_sent",
      disabled: "not_sent",
      noOrganization: "not_sent",
    });
    // Only ever to the account's own stored address.
    expect(sentTo).toEqual([person.email, person.email]);
    // The second request replaced the first.
    expect(await resetsOf(person.userId)).toEqual([
      { used: false, revoked: "superseded", requested_by: null },
      { used: false, revoked: null, requested_by: null },
    ]);
    expect(await resetsOf(disabled.userId)).toEqual([]);
    expect(await resetsOf(alone.userId)).toEqual([]);
  });

  it("answers in about the same time whatever the address", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const disabled = await member(org);
    await db.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${disabled.userId}::uuid`,
    );
    const kinds: Record<string, string> = {
      account: person.email,
      none: "also.nobody@example.org",
      disabled: disabled.email,
    };
    const times: Record<string, number[]> = { account: [], none: [], disabled: [] };
    for (let round = 0; round < 25; round++) {
      for (const [kind, address] of Object.entries(kinds)) {
        await clearResetCounter(address);
        let settle: () => void = () => undefined;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const start = performance.now();
        const reply = await requestPasswordReset(
          db,
          { email: address, source: source() },
          () => Promise.resolve(),
          {
            backgroundDelayMs: NO_DELAY,
            onSettled: () => {
              settle();
            },
          },
        );
        times[kind]?.push(performance.now() - start);
        expect(reply).toBe(RESET_REQUESTED);
        // The background work ends before the next one starts timing.
        await settled;
      }
    }
    const medians = Object.values(times).map(median);
    // Only the counters are touched before the reply, the same for every
    // address; what depends on the account comes after it.
    expect(Math.max(...medians)).toBeLessThan(Math.min(...medians) * 2 + 1);
  });

  it("is throttled per address typed (in any case) and per client address, apart from sign-in", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const variants = [person.email, person.email.toUpperCase(), ` ${person.email}`.trim()];
    for (const address of variants) {
      expect((await ask(address)).outcome).toBe("sent");
    }
    const fourth = await ask(person.email);
    expect(fourth.reply).toEqual({
      ok: false,
      code: "throttled",
      message: expect.any(String) as string,
      retryAfterSeconds: expect.any(Number) as number,
    });
    expect(!fourth.reply.ok && "retryAfterSeconds" in fourth.reply).toBe(true);
    if (!fourth.reply.ok && "retryAfterSeconds" in fourth.reply) {
      expect(fourth.reply.retryAfterSeconds).toBeGreaterThanOrEqual(55);
      expect(fourth.reply.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(fourth.messages).toEqual([]);
    // An address with no account is throttled exactly the same way.
    const nobody = "nobody.throttled@example.org";
    for (let i = 0; i < 3; i++) expect((await ask(nobody)).reply).toBe(RESET_REQUESTED);
    expect((await ask(nobody)).reply).toMatchObject({ code: "throttled" });
    // Asking for links never makes anyone wait to sign in.
    const signedIn = await signIn(db, {
      email: person.email,
      password: PASSWORD,
      source: source(),
    });
    expect(signedIn.ok).toBe(true);
    // Ten requests from one client address, then a wait, whatever the address.
    const from = source();
    for (let i = 0; i < 10; i++) {
      expect(
        (await ask(`someone${String(i)}.${String(unique())}@example.org`, { from })).reply,
      ).toBe(RESET_REQUESTED);
    }
    const eleventh = await ask(`someone.else.${String(unique())}@example.org`, { from });
    expect(eleventh.reply).toMatchObject({ code: "throttled" });
    expect(eleventh.outcome).toBeUndefined();
  });

  it("starts the background work 1 to 10 s after the reply by default, and checks the range", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    let sentAt = 0;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const start = performance.now();
    const reply = await requestPasswordReset(
      db,
      { email: person.email, source: source() },
      () => {
        sentAt = performance.now();
        return Promise.resolve();
      },
      {
        onSettled: () => {
          settle();
        },
      },
    );
    const repliedAt = performance.now();
    expect(reply).toBe(RESET_REQUESTED);
    await settled;
    expect(sentAt - start).toBeGreaterThanOrEqual(1000);
    expect(sentAt - repliedAt).toBeLessThan(15_000);
    for (const backgroundDelayMs of [
      { min: 5, max: 1 },
      { min: -1, max: 0 },
      { min: 0, max: 60_001 },
      { min: 0 },
      { min: 0, max: 1.5 },
      { min: 0, max: 0, extra: 1 },
    ]) {
      await expect(
        requestPasswordReset(
          db,
          { email: person.email, source: source() },
          () => Promise.resolve(),
          {
            backgroundDelayMs: backgroundDelayMs as { min: number; max: number },
          },
        ),
      ).rejects.toThrow(TypeError);
    }
  }, 30_000);

  it("refuses a malformed request before counting anything", async () => {
    await ready();
    const before = await db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.sign_in_throttles`,
    );
    const box = mailbox();
    for (const input of [
      { email: 42, source: "10.39.250.1" },
      { email: "a@example.org" },
      { email: "a@example.org", source: "10.39.250.1", extra: true },
      { email: "a\u0000@example.org", source: "10.39.250.1" },
      { email: "a\ud800@example.org", source: "10.39.250.1" },
      { email: "a".repeat(2000), source: "10.39.250.1" },
      null,
    ]) {
      expect(
        await requestPasswordReset(
          db,
          input as unknown as { email: string; source: string },
          box.deliver,
        ),
      ).toMatchObject({ ok: false, code: "invalid_request" });
    }
    const after = await db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.sign_in_throttles`,
    );
    expect(after).toEqual(before);
    await expect(
      requestPasswordReset(db, { email: "a@example.org", source: "x" }, box.deliver, {
        lifeSeconds: 2 * 3600,
      }),
    ).rejects.toThrow(TypeError);
    expect(box.messages).toEqual([]);
  });

  it("stores only the token's SHA-256, for 30 minutes by default or 5 to 60 if chosen", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const r = await ask(person.email);
    const token = r.messages[0]?.token ?? "";
    const rows = await db.rows<{ hash: Uint8Array; life: number; text: string }>(sql`
      SELECT token_hash AS hash, extract(epoch FROM expires_at - created_at)::int AS life,
             row_to_json(r)::text AS text
      FROM public.password_resets r WHERE user_id = ${person.userId}::uuid`);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]?.hash ?? []).toString("hex")).toBe(
      Buffer.from(hashResetToken(token)).toString("hex"),
    );
    expect(rows[0]?.life).toBe(1800);
    expect(rows[0]?.text).not.toContain(token);
    const short = await ask(person.email, { extra: { lifeSeconds: 300 } });
    expect(short.outcome).toBe("sent");
    const lives = await db.rows<{ life: number }>(sql`
      SELECT extract(epoch FROM expires_at - created_at)::int AS life
      FROM public.password_resets WHERE user_id = ${person.userId}::uuid
        AND revoked_at IS NULL`);
    expect(lives).toEqual([{ life: 300 }]);
  });

  it("work that finds every slot taken waits again, then goes ahead or is dropped loudly", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    let releases: (() => void)[] = [];
    const outcomes: ResetOutcome[] = [];
    const blocked: PasswordResetDelivery = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    /** Fills every work slot with a request held in its delivery. */
    async function fill(): Promise<void> {
      releases = [];
      for (let i = 0; i < MAX_RESET_WORK; i++) {
        await clearResetCounter(person.email);
        expect(
          await requestPasswordReset(db, { email: person.email, source: source() }, blocked, {
            onSettled: (o) => outcomes.push(o),
            deliveryTimeoutMs: 60_000,
            backgroundDelayMs: NO_DELAY,
          }),
        ).toBe(RESET_REQUESTED);
        for (let wait = 0; releases.length <= i && wait < 400; wait++) await sleep(25);
      }
      expect(releases).toHaveLength(MAX_RESET_WORK);
    }
    const one = async (): Promise<{ outcome: Promise<ResetOutcome>; loud: unknown[] }> => {
      await clearResetCounter(person.email);
      const loud: unknown[] = [];
      let settle: (o: ResetOutcome) => void = () => undefined;
      const outcome = new Promise<ResetOutcome>((resolve) => {
        settle = resolve;
      });
      const box = mailbox();
      expect(
        await requestPasswordReset(db, { email: person.email, source: source() }, box.deliver, {
          backgroundDelayMs: NO_DELAY,
          onError: (e) => loud.push(e),
          onSettled: settle,
        }),
      ).toBe(RESET_REQUESTED);
      return { outcome, loud };
    };
    // Slots free up while it waits: it goes ahead.
    await fill();
    const later = await one();
    await sleep(300);
    for (const release of releases) release();
    expect(await later.outcome).toBe("sent");
    expect(later.loud).toEqual([]);
    // They never free up: after its waits it is dropped, and the log hears.
    await fill();
    const dropped = await one();
    expect(await dropped.outcome).toBe("busy");
    expect(dropped.loud).toHaveLength(1);
    expect(String(dropped.loud[0])).toMatch(/Password reset work is full/);
    expect(String(dropped.loud[0])).not.toContain(person.email);
    for (const release of releases) release();
    for (let wait = 0; outcomes.length < 2 * MAX_RESET_WORK && wait < 400; wait++) await sleep(25);
    expect(outcomes).toEqual(Array.from({ length: 2 * MAX_RESET_WORK }, () => "sent"));
    const pending = (await resetsOf(person.userId)).filter((r) => !r.used && r.revoked === null);
    expect(pending).toHaveLength(1);
  }, 60_000);

  it("requests still waiting to start hold no work slot, so they can't keep a member's link back", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const waiting: Promise<ResetOutcome>[] = [];
    // More waiting requests than work slots, from many addresses.
    for (let i = 0; i < MAX_RESET_WORK + 8; i++) {
      let settle: (o: ResetOutcome) => void = () => undefined;
      waiting.push(
        new Promise<ResetOutcome>((resolve) => {
          settle = resolve;
        }),
      );
      expect(
        await requestPasswordReset(
          db,
          { email: `waiting${String(unique())}@example.org`, source: source() },
          () => Promise.resolve(),
          { backgroundDelayMs: { min: 4000, max: 4000 }, onSettled: settle },
        ),
      ).toBe(RESET_REQUESTED);
    }
    const start = performance.now();
    const r = await ask(person.email);
    expect(r.outcome).toBe("sent");
    expect(r.messages).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(await Promise.all(waiting)).toEqual(waiting.map(() => "not_sent"));
  }, 30_000);

  it("counts IPv6 clients per /48 as well as per /64", async () => {
    await ready();
    const site = `2001:db8:${(0x3900 + (unique() % 200)).toString(16)}`;
    for (let i = 0; i < 30; i++) {
      const r = await ask(`net${String(unique())}@example.org`, {
        from: `${site}:${(i + 1).toString(16)}::7`,
      });
      expect(r.reply).toBe(RESET_REQUESTED);
    }
    // A 31st /64 of the same /48 waits; another /48 doesn't.
    expect(
      (await ask(`net${String(unique())}@example.org`, { from: `${site}:ff::7` })).reply,
    ).toMatchObject({ code: "throttled" });
    expect(
      (await ask(`net${String(unique())}@example.org`, { from: "2001:db8:77ff:1::7" })).reply,
    ).toBe(RESET_REQUESTED);
  });
});

describe("using a link", () => {
  it("sets the new password once, ends every session, signs nobody in and clears the sign-in counter", async () => {
    await ready();
    const org = await organization();
    const second = await organization();
    const person = await member(org);
    // Into a second organization directly, as the owner would after an
    // accepted invitation (the membership needs an accepted invitation).
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(
        db,
        { organizationId: second, email: person.email, invitedBy: admin },
        (m) => {
          box.push(m);
          return Promise.resolve();
        },
      ),
    );
    ok(
      await acceptInvitationForUser(db, {
        token: box[0]?.token ?? "",
        organizationId: second,
        userId: person.userId,
      }),
    );
    const a = await fullSession(person.userId, org);
    const b = await fullSession(person.userId, second);
    const waiting = await pendingSession(person);
    expect((await resolveSession(db, a)).ok).toBe(true);
    // A few wrong guesses on the sign-in counter.
    for (let i = 0; i < 3; i++) {
      expect(
        await signIn(db, { email: person.email, password: "wrong guess here", source: source() }),
      ).toBe(INVALID_CREDENTIALS);
    }
    const before = await db.rows<{ after: string }>(sql`
      SELECT sessions_valid_after::text AS after FROM public.users WHERE id = ${person.userId}::uuid`);
    const token = await linkFor(person.email);
    const done = await completePasswordReset(db, { token, password: NEW_PASSWORD });
    // Nothing that signs anyone in: no token, no session.
    expect(done).toEqual({ ok: true, value: { reset: true } });
    expect(await resolveSession(db, a)).toBe(NO_SESSION);
    expect(await resolveSession(db, b)).toBe(NO_SESSION);
    expect(await readPendingSession(db, waiting)).toBe(NO_SESSION);
    expect(await liveSessions(person.userId)).toBe(0);
    const rows = await db.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.sessions WHERE user_id = ${person.userId}::uuid`);
    expect(rows).toEqual([{ n: 0 }]);
    const after = await db.rows<{ moved: boolean; counter: number }>(sql`
      SELECT sessions_valid_after > ${before[0]?.after ?? ""}::timestamptz AS moved,
             (SELECT count(*)::int FROM public.sign_in_throttles
              WHERE key IN (${throttleAccountKey(person.email)},
                            ${resetThrottleAccountKey(person.email)})) AS counter
      FROM public.users WHERE id = ${person.userId}::uuid`);
    expect(after).toEqual([{ moved: true, counter: 0 }]);
    // The old password no longer signs in; the new one does (to the second
    // step only, as every sign-in).
    expect(await signIn(db, { email: person.email, password: PASSWORD, source: source() })).toBe(
      INVALID_CREDENTIALS,
    );
    const fresh = await beginSession(db, {
      email: person.email,
      password: NEW_PASSWORD,
      source: source(),
    });
    expect(fresh).toMatchObject({ ok: true, session: { userId: person.userId } });
    // Single use.
    expect(
      await completePasswordReset(db, { token, password: "yet another invented phrase" }),
    ).toMatchObject(INVALID);
    expect(await resetsOf(person.userId)).toEqual([
      { used: true, revoked: null, requested_by: null },
    ]);
  });

  it("refuses an unknown, malformed, used, replaced or expired link with the same answer", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const first = await linkFor(person.email);
    const second = await linkFor(person.email);
    // A newer request revoked the older one.
    expect(await completePasswordReset(db, { token: first, password: NEW_PASSWORD })).toMatchObject(
      INVALID,
    );
    // Expired: 31 minutes old.
    await ageLink(second, 31 * 60);
    expect(
      await completePasswordReset(db, { token: second, password: NEW_PASSWORD }),
    ).toMatchObject(INVALID);
    const third = await linkFor(person.email);
    const bytes = Buffer.from(third, "base64url");
    const answers: Validated<{ readonly reset: true }>[] = [];
    for (const t of [
      newResetToken(),
      `${third}=`,
      bytes.toString("base64"),
      ` ${third}`,
      third.slice(0, 42),
      newSessionToken(),
      42,
    ]) {
      answers.push(await completePasswordReset(db, { token: t as string, password: NEW_PASSWORD }));
    }
    expect(answers.every((a) => JSON.stringify(a) === JSON.stringify(answers[0]))).toBe(true);
    expect(answers[0]).toMatchObject(INVALID);
    // The real one still works after all that.
    expect(ok(await completePasswordReset(db, { token: third, password: NEW_PASSWORD }))).toEqual({
      reset: true,
    });
  });

  it("checks the new password by D-068's rules, in NFC, keeping the link for another try", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const orgName = (
      await db.rows<{ name: string }>(
        sql`SELECT name FROM public.organizations WHERE id = ${org}::uuid`,
      )
    )[0]?.name;
    const token = await linkFor(person.email);
    const local = person.email.split("@")[0] ?? "";
    for (const [password, code] of [
      ["short", "too_short"],
      ["password1", "common_password"],
      ["x".repeat(1025), "too_long"],
      ["Invented Person", "context_words"],
      [`${local}1`, "context_words"],
      [(orgName ?? "").replace(/ /g, ""), "context_words"],
      ["broken \ud800 text here", "invalid_text"],
    ] as const) {
      const r = await completePasswordReset(db, { token, password });
      expect({ password: password.slice(0, 20), r }).toMatchObject({
        r: { ok: false, issues: [{ path: ["password"], code }] },
      });
    }
    // NFC: "é" typed as "e" and a combining accent is the same password.
    const decomposed = "cafe\u0301 au lait sans sucre";
    ok(await completePasswordReset(db, { token, password: decomposed }));
    const signedIn = await signIn(db, {
      email: person.email,
      password: "caf\u00e9 au lait sans sucre",
      source: source(),
    });
    expect(signedIn.ok).toBe(true);
  });

  it("dies when the account is disabled, its sessions are all ended or its password changes", async () => {
    await ready();
    const org = await organization();
    for (const change of ["disable", "end all", "password", "membership"] as const) {
      const person = await member(org);
      const token = await linkFor(person.email);
      await sleep(2);
      if (change === "disable") {
        await db.execute(
          sql`UPDATE public.users SET disabled_at = now() WHERE id = ${person.userId}::uuid`,
        );
        // Re-enabling brings nothing back.
        await db.execute(
          sql`UPDATE public.users SET disabled_at = NULL WHERE id = ${person.userId}::uuid`,
        );
      } else if (change === "end all") {
        await db.transaction((tx) => endAllSessionsForUser(tx, person.userId));
      } else if (change === "password") {
        await db.execute(sql`UPDATE public.users SET password_changed_at = clock_timestamp()
          WHERE id = ${person.userId}::uuid`);
      } else {
        await db.execute(sql`DELETE FROM public.organization_members
          WHERE user_id = ${person.userId}::uuid`);
      }
      expect({
        change,
        r: await completePasswordReset(db, { token, password: NEW_PASSWORD }),
      }).toMatchObject({
        change,
        r: INVALID,
      });
    }
  });

  it("is revoked for good when the account loses its last membership, and kept while one is left", async () => {
    await ready();
    const org = await organization();
    const second = await organization();
    const person = await member(org);
    const token = await linkFor(person.email);
    await db.execute(sql`DELETE FROM public.organization_members
      WHERE user_id = ${person.userId}::uuid`);
    expect(await resetsOf(person.userId)).toEqual([
      { used: false, revoked: "no_membership", requested_by: null },
    ]);
    // Invited back: the old link stays dead.
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(
        db,
        { organizationId: second, email: person.email, invitedBy: admin },
        (m) => {
          box.push(m);
          return Promise.resolve();
        },
      ),
    );
    ok(
      await acceptInvitationForUser(db, {
        token: box[0]?.token ?? "",
        organizationId: second,
        userId: person.userId,
      }),
    );
    expect(await completePasswordReset(db, { token, password: NEW_PASSWORD })).toMatchObject(
      INVALID,
    );
    // Losing one of two memberships leaves the link alone.
    const again = await linkFor(person.email);
    const box2: InvitationMessage[] = [];
    ok(
      await createInvitation(
        db,
        { organizationId: org, email: person.email, invitedBy: admin },
        (m) => {
          box2.push(m);
          return Promise.resolve();
        },
      ),
    );
    ok(
      await acceptInvitationForUser(db, {
        token: box2[0]?.token ?? "",
        organizationId: org,
        userId: person.userId,
      }),
    );
    await db.execute(sql`DELETE FROM public.organization_members
      WHERE user_id = ${person.userId}::uuid AND organization_id = ${second}::uuid`);
    ok(await completePasswordReset(db, { token: again, password: NEW_PASSWORD }));
  });

  it("can be asked for again at once after a system admin clears the address's counters", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    await clearResetCounter(person.email);
    for (let i = 0; i < 3; i++) expect((await ask(person.email)).outcome).toBe("sent");
    expect((await ask(person.email)).reply).toMatchObject({ code: "throttled" });
    expect(
      ok(await clearSignInThrottle(db, { email: person.email.toUpperCase(), by: admin })),
    ).toEqual({
      cleared: true,
    });
    expect((await ask(person.email)).outcome).toBe("sent");
  });

  it("changes only the account it was sent for", async () => {
    await ready();
    const org = await organization();
    const alice = await member(org);
    const bob = await member(org);
    const bobSession = await fullSession(bob.userId, org);
    const token = await linkFor(alice.email);
    // The completion takes no account at all: nothing to point elsewhere.
    expect(
      await completePasswordReset(db, {
        token,
        password: NEW_PASSWORD,
        userId: bob.userId,
      } as unknown as { token: string; password: string }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid_request" }] });
    ok(await completePasswordReset(db, { token, password: NEW_PASSWORD }));
    expect((await signIn(db, { email: bob.email, password: PASSWORD, source: source() })).ok).toBe(
      true,
    );
    expect(await signIn(db, { email: bob.email, password: NEW_PASSWORD, source: source() })).toBe(
      INVALID_CREDENTIALS,
    );
    expect((await resolveSession(db, bobSession)).ok).toBe(true);
    // Bob's own link is untouched by Alice's request and use.
    const bobLink = await linkFor(bob.email);
    await linkFor(alice.email);
    ok(await completePasswordReset(db, { token: bobLink, password: NEW_PASSWORD }));
    expect((await resetsOf(alice.userId)).map((r) => r.used)).toEqual([true, false]);
  });
});

describe("delivery and secrecy", () => {
  it("revokes a link that couldn't be sent or took too long, and never lets the token out", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const tokens: string[] = [];
    const seen: unknown[] = [];
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        seen.push(args);
      }),
    );
    const failing: PasswordResetDelivery = (m) => {
      tokens.push(m.token);
      // A mailer that puts the message in its error: it must go nowhere.
      return Promise.reject(new Error(`could not send ${m.token} to ${m.email}`));
    };
    await clearResetCounter(person.email);
    const errors: unknown[] = [];
    const failed = await ask(person.email, {
      deliver: failing,
      extra: { onError: (e) => errors.push(e) },
    });
    expect(failed.outcome).toBe("delivery_failed");
    let aborted: boolean | undefined;
    const slow: PasswordResetDelivery = (m, signal) => {
      tokens.push(m.token);
      return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = signal.aborted;
          reject(new Error(`gave up on ${m.token}`));
        });
      });
    };
    await clearResetCounter(person.email);
    const timedOut = await ask(person.email, {
      deliver: slow,
      extra: { deliveryTimeoutMs: 50, onError: (e) => errors.push(e) },
    });
    expect(timedOut.outcome).toBe("delivery_failed");
    expect(aborted).toBe(true);
    expect(await resetsOf(person.userId)).toEqual([
      { used: false, revoked: "delivery_failed", requested_by: null },
      { used: false, revoked: "delivery_failed", requested_by: null },
    ]);
    for (const token of tokens) {
      expect(await completePasswordReset(db, { token, password: NEW_PASSWORD })).toMatchObject(
        INVALID,
      );
    }
    // A sent one, used, and every answer along the way.
    const good = await ask(person.email, { extra: { onError: (e) => errors.push(e) } });
    const token = good.messages[0]?.token ?? "";
    tokens.push(token);
    const done = await completePasswordReset(
      db,
      { token, password: NEW_PASSWORD },
      {
        onError: (e) => errors.push(e),
      },
    );
    const adminSession = await fullSession(admin, org);
    const box = mailbox();
    const sent = await sendPasswordReset(db, adminSession, person.userId, box.deliver, {
      onError: (e) => errors.push(e),
    });
    tokens.push(box.messages[0]?.token ?? "");
    const everything = JSON.stringify([
      failed.reply,
      failed.outcome,
      timedOut.reply,
      timedOut.outcome,
      good.reply,
      good.outcome,
      done,
      sent,
      errors.map(String),
      seen,
    ]);
    expect(tokens).toHaveLength(4);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(everything).not.toContain(t);
      expect(everything).not.toContain(Buffer.from(hashResetToken(t)).toString("hex"));
    }
    expect(errors).toEqual([]);
    expect(seen).toEqual([]);
    for (const spy of consoles) spy.mockRestore();
    // Stored as hashes only.
    const stored = await db.rows<{ text: string }>(sql`
      SELECT string_agg(row_to_json(r)::text, ' ') AS text FROM public.password_resets r
      WHERE user_id = ${person.userId}::uuid`);
    for (const t of tokens) expect(stored[0]?.text).not.toContain(t);
  });
});

describe("accounts without a second factor in use (review L7)", () => {
  it("get the same reply but no link from the sign-in page; a system admin can still send one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { withFactor: false });
    const r = await ask(person.email);
    expect(r.reply).toBe(RESET_REQUESTED);
    expect(r.outcome).toBe("needs_admin");
    expect(r.messages).toEqual([]);
    expect(await resetsOf(person.userId)).toEqual([]);
    // The database refuses such a link from any writer too.
    await expect(
      db.execute(sql`
        INSERT INTO public.password_resets (id, user_id, token_hash, created_at, expires_at)
        SELECT gen_random_uuid(), ${person.userId}::uuid, ${hashResetToken(newResetToken())}, t,
               t + interval '10 minutes' FROM (SELECT clock_timestamp() AS t) c`),
    ).rejects.toMatchObject({ constraint: "password_resets_needs_factor" });
    const session = await fullSession(admin, org);
    const box = mailbox();
    ok(await sendPasswordReset(db, session, person.userId, box.deliver));
    ok(
      await completePasswordReset(db, {
        token: box.messages[0]?.token ?? "",
        password: NEW_PASSWORD,
      }),
    );
  });

  it("after a system admin resets someone's two-step sign-in: old links die, new ones need an admin, and a reset keeps the enrolment token required", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const before = await linkFor(person.email);
    const adminSession = await fullSession(admin, org);
    const adminCode = factors.get(admin)?.codes.pop() ?? "";
    const enrolment: string[] = [];
    ok(
      await resetSecondFactor(
        db,
        keys,
        adminSession,
        person.userId,
        { recoveryCode: adminCode, source: source() },
        (m) => {
          enrolment.push(m.token);
          return Promise.resolve();
        },
      ),
    );
    // The link sent before the reset died with the account's sessions.
    expect(
      await completePasswordReset(db, { token: before, password: NEW_PASSWORD }),
    ).toMatchObject(INVALID);
    await clearResetCounter(person.email);
    expect((await ask(person.email)).outcome).toBe("needs_admin");
    // An admin's link works, and the new password still leads only to set-up
    // with the emailed enrolment token.
    const box = mailbox();
    ok(await sendPasswordReset(db, await fullSession(admin, org), person.userId, box.deliver));
    ok(
      await completePasswordReset(db, {
        token: box.messages[0]?.token ?? "",
        password: NEW_PASSWORD,
      }),
    );
    const required = await db.rows<{ required: boolean }>(sql`
      SELECT public.second_step_token_required(${person.userId}::uuid) AS required`);
    expect(required).toEqual([{ required: true }]);
    const waiting = await pendingSession(person, NEW_PASSWORD);
    expect(await startEnrolment(db, keys, waiting)).toMatchObject({
      ok: false,
      code: "enrolment_token_required",
    });
    expect(enrolment).toHaveLength(1);
  });
});

describe("a system admin sends a link", () => {
  it("needs a system admin who entered their password in the last 10 minutes", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await member(org);
    const box = mailbox();
    const mine = await fullSession(other.userId, org);
    expect(codeOf(await sendPasswordReset(db, mine, person.userId, box.deliver))).toBe(
      "not_permitted",
    );
    const stale = await fullSession(admin, org, 11 * 60);
    expect(codeOf(await sendPasswordReset(db, stale, person.userId, box.deliver))).toBe(
      "reauthentication_required",
    );
    expect(codeOf(await sendPasswordReset(db, newSessionToken(), person.userId, box.deliver))).toBe(
      "no_session",
    );
    expect(codeOf(await sendPasswordReset(db, "not a token", person.userId, box.deliver))).toBe(
      "no_session",
    );
    expect(codeOf(await sendPasswordReset(db, mine, "not a user", box.deliver))).toBe(
      "invalid_request",
    );
    expect(box.messages).toEqual([]);
    expect(await resetsOf(person.userId)).toEqual([]);
  });

  it("sends the same kind of link to the account's own address, and says what happened", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const disabled = await member(org);
    await db.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${disabled.userId}::uuid`,
    );
    const alone = await member(org);
    await db.execute(
      sql`DELETE FROM public.organization_members WHERE user_id = ${alone.userId}::uuid`,
    );
    const session = await fullSession(admin, org);
    const box = mailbox();
    expect(codeOf(await sendPasswordReset(db, session, newUserId(), box.deliver))).toBe(
      "unknown_user",
    );
    expect(codeOf(await sendPasswordReset(db, session, disabled.userId, box.deliver))).toBe(
      "account_disabled",
    );
    expect(codeOf(await sendPasswordReset(db, session, alone.userId, box.deliver))).toBe(
      "cannot_sign_in",
    );
    expect(box.messages).toEqual([]);
    const personSession = await fullSession(person.userId, org);
    const sent = await sendPasswordReset(db, session, person.userId, box.deliver, {
      lifeSeconds: 3600,
    });
    expect(sent).toEqual({ ok: true, value: { expiresAt: box.messages[0]?.expiresAt } });
    expect(box.messages).toEqual([
      {
        email: person.email,
        token: expect.any(String) as string,
        expiresAt: expect.any(String) as string,
        requestedBy: "system_admin",
      },
    ]);
    expect(await resetsOf(person.userId)).toEqual([
      { used: false, revoked: null, requested_by: admin },
    ]);
    // Sending a link changes nothing until it is used.
    expect((await resolveSession(db, personSession)).ok).toBe(true);
    ok(
      await completePasswordReset(db, {
        token: box.messages[0]?.token ?? "",
        password: NEW_PASSWORD,
      }),
    );
    expect(await resolveSession(db, personSession)).toBe(NO_SESSION);
    // A link that couldn't be sent is withdrawn and said so.
    const failed = await sendPasswordReset(db, session, person.userId, () =>
      Promise.reject(new Error("no mail today")),
    );
    expect(codeOf(failed)).toBe("delivery_failed");
    // Replaced while it was being sent, by the person's own request.
    const raced = await sendPasswordReset(db, session, person.userId, async () => {
      await clearResetCounter(person.email);
      expect((await ask(person.email)).outcome).toBe("sent");
    });
    expect(codeOf(raced)).toBe("superseded");
    expect((await resetsOf(person.userId)).slice(-2)).toEqual([
      { used: false, revoked: "superseded", requested_by: admin },
      { used: false, revoked: null, requested_by: null },
    ]);
  });
});

describe("two connections at once", { timeout: 180_000 }, () => {
  it("one link is used once, whichever connection is first", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 2 });
    try {
      const org = await organization();
      const person = await member(org);
      for (let round = 0; round < 5; round++) {
        const token = await linkFor(person.email);
        const results = await Promise.all([
          completePasswordReset(db, { token, password: `${NEW_PASSWORD} ${String(round)} a` }),
          completePasswordReset(other, { token, password: `${NEW_PASSWORD} ${String(round)} b` }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.find((r) => !r.ok)).toMatchObject(INVALID);
      }
    } finally {
      await other.close();
    }
  });

  it("a use racing a new request: the old link never outlives it, and the new link always works", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 3 });
    try {
      const org = await organization();
      const person = await member(org);
      const seen = new Set<string>();
      for (let round = 0; round < 8; round++) {
        const old = await linkFor(person.email);
        await clearResetCounter(person.email);
        const [used, asked] = await Promise.all([
          completePasswordReset(other, {
            token: old,
            password: `${NEW_PASSWORD} ${String(round)}`,
          }),
          sleep((round * 37) % 250).then(() => ask(person.email)),
        ]);
        seen.add(used.ok ? "used first" : "replaced first");
        const fresh = asked.messages[0]?.token ?? "";
        expect(asked.outcome).toBe("sent");
        // The old link is settled either way; the new one is the only one
        // pending, and it works whatever the order.
        expect(
          await completePasswordReset(db, { token: old, password: NEW_PASSWORD }),
        ).toMatchObject(INVALID);
        const pending = (await resetsOf(person.userId)).filter(
          (r) => !r.used && r.revoked === null,
        );
        expect(pending).toHaveLength(1);
        ok(
          await completePasswordReset(db, {
            token: fresh,
            password: `${NEW_PASSWORD} again ${String(round)}`,
          }),
        );
      }
      expect(seen.size).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });

  it("a sign-in racing a use never keeps a live session from the old password (looped)", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 3 });
    try {
      const org = await organization();
      const person = await member(org);
      let password = PASSWORD;
      for (let round = 0; round < 8; round++) {
        const token = await linkFor(person.email);
        await clearSignInCounter(person.email);
        const next = `an invented passphrase for round ${String(round)}`;
        const [started, reset] = await Promise.all([
          beginSession(other, { email: person.email, password, source: source() }),
          sleep((round * 41) % 300).then(() =>
            completePasswordReset(db, { token, password: next }),
          ),
        ]);
        expect(reset.ok).toBe(true);
        if (started.ok) expect(await readPendingSession(db, started.token)).toBe(NO_SESSION);
        expect({ round, live: await liveSessions(person.userId) }).toEqual({ round, live: 0 });
        password = next;
      }
    } finally {
      await other.close();
    }
  });

  it("a use and a sign-in succeeding at the same moment never deadlock (ordered)", async () => {
    await ready();
    const deadlocks = async (): Promise<number> => {
      await db.rows(sql`SELECT pg_stat_clear_snapshot()`);
      const rows = await db.rows<{ n: string }>(sql`
        SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`);
      return Number(rows[0]?.n ?? "0");
    };
    const a = openDatabase(testDb.url, { max: 2 });
    const b = openDatabase(testDb.url, { max: 2 });
    const start = await deadlocks();
    try {
      const org = await organization();
      for (let round = 0; round < 3; round++) {
        const person = await member(org);
        const token = await linkFor(person.email);
        // A wrong guess, so the sign-in's success deletes a counter row.
        await signIn(db, {
          email: person.email,
          password: "a wrong invented guess",
          source: source(),
        });
        // The sign-in's success transaction has deleted the address's counter
        // and is about to update the user row when the use starts; the
        // sign-in goes on once the use is waiting on a lock (or done).
        let fired = false;
        let use: Promise<Validated<{ readonly reset: true }>> | undefined;
        const gate = async (query: Sql): Promise<void> => {
          if (!fired && query.text.includes("SET last_sign_in_at = now()")) {
            fired = true;
            use = completePasswordReset(b, { token, password: `${NEW_PASSWORD} ${String(round)}` });
            const state = { settled: false };
            void use.then(() => {
              state.settled = true;
            });
            for (let wait = 0; wait < 200 && !state.settled; wait++) {
              const waiting = await db.rows(sql`
                SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`);
              if (waiting.length > 0) break;
              await sleep(25);
            }
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
        const pinned: Database = {
          ...wrap(a),
          transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
            a.transaction((tx) => work(wrap(tx))),
          close: () => a.close(),
        };
        const signedIn = await signIn(pinned, {
          email: person.email,
          password: PASSWORD,
          source: source(),
        });
        expect(fired).toBe(true);
        expect(signedIn.ok).toBe(true);
        expect(await use).toEqual({ ok: true, value: { reset: true } });
      }
    } finally {
      // Statistics are written when a connection ends.
      await a.close();
      await b.close();
    }
    await sleep(500);
    expect(await deadlocks()).toBe(start);
  });

  it("a sign-in whose password was checked just before a use commits gets no session (ordered)", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 2 });
    try {
      const org = await organization();
      const person = await member(org);
      const token = await linkFor(person.email);
      // The use commits on another connection between the sign-in's password
      // check and its insert.
      let fired = false;
      const gate = async (query: Sql): Promise<void> => {
        if (
          !fired &&
          query.text.includes("sessions_valid_after =") &&
          query.text.includes("FOR SHARE")
        ) {
          fired = true;
          ok(await completePasswordReset(other, { token, password: NEW_PASSWORD }));
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
      const pinned: Database = {
        ...wrap(db),
        transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
          db.transaction((tx) => work(wrap(tx))),
        close: () => db.close(),
      };
      const r = await beginSession(pinned, {
        email: person.email,
        password: PASSWORD,
        source: source(),
      });
      expect(fired).toBe(true);
      expect(r).toBe(INVALID_CREDENTIALS);
      expect(await liveSessions(person.userId)).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("the database's guards", () => {
  it("fire always, in replica mode too", async () => {
    await ready();
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND (c.relname = 'password_resets' OR t.tgname = 'users_password_changed_at')
      ORDER BY 1`);
    expect(rows).toEqual([
      { name: "password_resets.password_resets_check_change", enabled: "A" },
      { name: "password_resets.password_resets_check_new", enabled: "A" },
      { name: "password_resets.zzzz_password_resets_keep_identity", enabled: "A" },
      { name: "users.users_password_changed_at", enabled: "A" },
    ]);
    const org = await organization();
    const person = await member(org);
    const token = await linkFor(person.email);
    ok(await completePasswordReset(db, { token, password: NEW_PASSWORD }));
    const replica = (statement: Sql) =>
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(statement);
      });
    await expect(
      replica(sql`UPDATE public.password_resets SET used_at = NULL
        WHERE token_hash = ${hashResetToken(token)}`),
    ).rejects.toMatchObject({ constraint: "password_resets_settled" });
    await expect(
      replica(sql`UPDATE public.users SET password_changed_at = password_changed_at - interval '1 hour'
        WHERE id = ${person.userId}::uuid`),
    ).rejects.toMatchObject({ constraint: "users_password_changed_at" });
  });

  it("the writer, with exactly WRITER_PRIVILEGES, can do all of this and its direct SQL is limited as D-078 lists", async () => {
    await ready();
    const role = `oculus_test_t039_${unique().toString()}_${String(process.pid)}`;
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
      expect(WRITER_PRIVILEGES.password_resets).toEqual(
        PASSWORD_RESET_TABLE_PRIVILEGES.password_resets,
      );
      for (const extra of [
        "GRANT TRUNCATE ON public.password_resets TO %I",
        "GRANT TRIGGER ON public.password_resets TO %I",
        "GRANT REFERENCES ON public.password_resets TO %I",
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

      // Everything resets need, as the writer.
      const org = await organization();
      const person = await member(org);
      const token = await linkFor(person.email, writer);
      const session = await fullSession(person.userId, org);
      ok(await completePasswordReset(writer, { token, password: NEW_PASSWORD }));
      expect(await resolveSession(writer, session)).toBe(NO_SESSION);
      const adminSession = await fullSession(admin, org);
      const box = mailbox();
      ok(await sendPasswordReset(writer, adminSession, person.userId, box.deliver));
      await runCleanup(writer);

      // What it can do with direct SQL: insert a pending link of its own
      // for an active account (which then works), revoke or delete links.
      const own = newResetToken();
      const insert = (values: Sql, user: UserId = person.userId): Promise<number> =>
        writer.execute(sql`
          INSERT INTO public.password_resets
            (id, user_id, token_hash, requested_by, created_at, expires_at, used_at, revoked_at,
             revoked_reason)
          SELECT gen_random_uuid(), ${user}::uuid, ${hashResetToken(newResetToken())}, v.*
          FROM (${values}) v`);
      await writer.execute(sql`UPDATE public.password_resets SET revoked_at = clock_timestamp(),
        revoked_reason = 'superseded' WHERE user_id = ${person.userId}::uuid
        AND used_at IS NULL AND revoked_at IS NULL`);
      await writer.execute(sql`
        INSERT INTO public.password_resets (id, user_id, token_hash, created_at, expires_at)
        SELECT gen_random_uuid(), ${person.userId}::uuid, ${hashResetToken(own)}, t,
               t + interval '10 minutes' FROM (SELECT clock_timestamp() AS t) c`);
      ok(await completePasswordReset(writer, { token: own, password: "the writer's own phrase" }));

      // What it can't.
      const disabled = await member(org);
      await db.execute(
        sql`UPDATE public.users SET disabled_at = now() WHERE id = ${disabled.userId}::uuid`,
      );
      const other = await member(org);
      const refusals: [string, () => Promise<unknown>][] = [
        [
          "password_resets_new_pending",
          () =>
            insert(sql`SELECT NULL::uuid, clock_timestamp(), clock_timestamp() + interval '10 minutes',
            clock_timestamp(), NULL::timestamptz, NULL::text`),
        ],
        [
          "password_resets_new_pending",
          () =>
            insert(sql`SELECT NULL::uuid, clock_timestamp(), clock_timestamp() + interval '10 minutes',
            NULL::timestamptz, clock_timestamp(), 'superseded'`),
        ],
        [
          "password_resets_new_now",
          () =>
            insert(sql`SELECT NULL::uuid, now() - interval '1 hour', now() - interval '50 minutes',
            NULL::timestamptz, NULL::timestamptz, NULL::text`),
        ],
        [
          "password_resets_user",
          () =>
            insert(
              sql`SELECT NULL::uuid, clock_timestamp(), clock_timestamp() + interval '10 minutes',
              NULL::timestamptz, NULL::timestamptz, NULL::text`,
              disabled.userId,
            ),
        ],
        [
          "password_resets_requested_by",
          () =>
            insert(
              sql`SELECT ${other.userId}::uuid, clock_timestamp(), clock_timestamp() + interval '10 minutes',
              NULL::timestamptz, NULL::timestamptz, NULL::text`,
              other.userId,
            ),
        ],
        [
          // A second pending link for the account.
          "password_resets_one_pending",
          async () => {
            await linkFor(other.email, writer);
            return insert(
              sql`SELECT NULL::uuid, clock_timestamp(), clock_timestamp() + interval '10 minutes',
                NULL::timestamptz, NULL::timestamptz, NULL::text`,
              other.userId,
            );
          },
        ],
      ];
      for (const [constraint, attempt] of refusals) {
        await expect(attempt(), constraint).rejects.toMatchObject({ constraint });
      }
      // Longer than an hour: the table's own check.
      await expect(
        insert(
          sql`SELECT NULL::uuid, clock_timestamp(), clock_timestamp() + interval '2 hours',
            NULL::timestamptz, NULL::timestamptz, NULL::text`,
          other.userId,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      // Changes to a link: no reuse, revival, extension or move.
      const used = hashResetToken(own);
      const pendingHash = (
        await db.rows<{ h: Uint8Array }>(sql`
          SELECT token_hash AS h FROM public.password_resets
          WHERE user_id = ${other.userId}::uuid AND used_at IS NULL AND revoked_at IS NULL`)
      )[0]?.h;
      if (pendingHash === undefined) throw new Error("no pending link");
      const changes: [string, Sql][] = [
        [
          "password_resets_settled",
          sql`UPDATE public.password_resets SET used_at = NULL WHERE token_hash = ${used}`,
        ],
        [
          "password_resets_settled",
          sql`UPDATE public.password_resets SET used_at = NULL, revoked_at = clock_timestamp(),
            revoked_reason = 'superseded' WHERE token_hash = ${used}`,
        ],
        [
          "password_resets_expires_at_fixed",
          sql`UPDATE public.password_resets SET expires_at = expires_at + interval '5 minutes'
            WHERE token_hash = ${pendingHash}`,
        ],
        [
          "password_resets_user_id_fixed",
          sql`UPDATE public.password_resets SET user_id = ${person.userId}::uuid
            WHERE token_hash = ${pendingHash}`,
        ],
        [
          "password_resets_token_hash_fixed",
          sql`UPDATE public.password_resets SET token_hash = ${hashResetToken(newResetToken())}
            WHERE token_hash = ${pendingHash}`,
        ],
        [
          "password_resets_settled_now",
          sql`UPDATE public.password_resets SET used_at = now() - interval '1 minute'
            WHERE token_hash = ${pendingHash}`,
        ],
        [
          "users_password_changed_at",
          sql`UPDATE public.users SET password_changed_at = password_changed_at - interval '1 hour'
            WHERE id = ${person.userId}::uuid`,
        ],
        [
          "users_password_changed_at",
          sql`UPDATE public.users SET password_changed_at = clock_timestamp() + interval '1 hour'
            WHERE id = ${person.userId}::uuid`,
        ],
      ];
      for (const [constraint, statement] of changes) {
        await expect(writer.execute(statement), constraint).rejects.toMatchObject({ constraint });
      }
      // Used after it expired (aged by the owner).
      const late = await linkFor(other.email, writer);
      await ageLink(late, 40 * 60);
      await expect(
        writer.execute(sql`UPDATE public.password_resets SET used_at = clock_timestamp()
          WHERE token_hash = ${hashResetToken(late)}`),
      ).rejects.toMatchObject({ constraint: "password_resets_expired" });
      for (const attempt of [
        sql`ALTER TABLE public.password_resets DISABLE TRIGGER password_resets_check_change`,
        sql`TRUNCATE public.password_resets`,
        sql`SET session_replication_role = replica`,
      ]) {
        await expect(writer.execute(attempt)).rejects.toMatchObject({
          code: expect.stringMatching(/^42/) as string,
        });
      }
      // Deleting a link only stops it working.
      expect(
        await writer.execute(
          sql`DELETE FROM public.password_resets WHERE token_hash = ${hashResetToken(late)}`,
        ),
      ).toBe(1);
      expect(
        await completePasswordReset(writer, { token: late, password: NEW_PASSWORD }),
      ).toMatchObject(INVALID);
    } finally {
      await writer.close();
    }
  });
});

describe("the cleanup", () => {
  it("forgets each kind of counter by its own rule's reset time", async () => {
    await ready();
    const n = unique();
    const keys = {
      account: throttleAccountKey(`cleanup${String(n)}@example.org`),
      source: throttleSourceKey(`10.39.249.${String(1 + (n % 250))}`),
      resetAccount: resetThrottleAccountKey(`cleanup${String(n)}@example.org`),
      resetSource: resetThrottleSourceKey(`10.39.249.${String(1 + (n % 250))}`),
      resetAccountOld: resetThrottleAccountKey(`cleanup.old${String(n)}@example.org`),
      resetNetwork:
        resetThrottleNetworkKey(`2001:db8:${(0x3a00 + (n % 200)).toString(16)}:1::1`) ?? "",
    };
    const ages: Record<keyof typeof keys, number> = {
      account: 2,
      source: 2,
      resetAccount: 2,
      resetSource: 2,
      resetAccountOld: 25,
      resetNetwork: 2,
    };
    for (const [name, key] of Object.entries(keys) as [keyof typeof keys, string][]) {
      await db.execute(sql`
        INSERT INTO public.sign_in_throttles (key, failures, last_failure_at)
        VALUES (${key}, 1, clock_timestamp() - make_interval(hours => ${ages[name]}))`);
    }
    await deleteExpiredSignInThrottles(db);
    const left = await db.rows<{ key: string }>(sql`
      SELECT key FROM public.sign_in_throttles WHERE key = ANY(${Object.values(keys)}::text[])
      ORDER BY key`);
    // Account counters (sign-in and reset) last a day; address counters an hour.
    expect(left.map((r) => r.key)).toEqual([keys.account, keys.resetAccount].sort());
  });

  it("deletes links a day past their end and keeps newer ones", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const old = await linkFor(person.email);
    await ageLink(old, 26 * 3600);
    const fresh = await linkFor(person.email);
    const done = await runCleanup(db);
    expect(done.passwordResets).toBeGreaterThanOrEqual(1);
    const left = await db.rows<{ h: Uint8Array }>(sql`
      SELECT token_hash AS h FROM public.password_resets WHERE user_id = ${person.userId}::uuid`);
    expect(left.map((r) => Buffer.from(r.h).toString("hex"))).toEqual([
      Buffer.from(hashResetToken(fresh)).toString("hex"),
    ]);
  });
});
