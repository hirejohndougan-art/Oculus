// Two-step sign-in (0014_second_factors.sql, second-factor.ts, second-step.ts,
// secret-key.ts; T-038, D-052, D-077) on a freshly migrated database: set-up
// from a session waiting for its second step, codes at the window's edges,
// no replay, throttling and the end of a waiting session after 5 wrong
// codes, recovery codes used once and replaced, re-entering the password
// with the second step, a system admin's reset, the database refusing every
// promotion without a real check (the writer role with direct SQL included),
// races on two connections, other people's and other organizations' codes,
// the secret never leaving the package, the secret key's rules and
// rotation, and the triggers firing ALWAYS. Every person, address, password
// and key is invented (example.org, RFC 2606); the keys are hashes of
// phrases saying they are fake.
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeBase32,
  hashSessionToken,
  hotp,
  newOrganizationId,
  newSessionId,
  newSessionToken,
  normalizeRecoveryCode,
  throttleAccountKey,
  throttleReauthKey,
  throttleSourceKey,
  type OrganizationId,
  type SessionId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  acceptInvitation,
  createFirstSystemAdmin,
  createInvitation,
  signIn,
  type InvitationMessage,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable, type Row } from "./client.js";
import { migrate } from "./migrate.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import {
  SECOND_FACTOR_TABLE_PRIVILEGES,
  SecondStepDatabaseError,
  completeSecondStep,
  confirmEnrolment,
  reauthenticate,
  regenerateRecoveryCodes,
  resealSecondFactorSecrets,
  resetSecondFactor,
  secondFactorStatus,
  startEnrolment,
  type EnrolmentDelivery,
  type EnrolmentMessage,
} from "./second-factor.js";
import {
  FAKE_TEST_SECRET_KEY,
  FAKE_TEST_SECRET_KEY_2,
  giveTestFactor,
  testKeyring,
  type TestFactor,
} from "./second-factor.fixtures.js";
import {
  SecretKeyError,
  isSecretKeyring,
  loadSecretKeyring,
  openSecret,
  sealSecret,
} from "./secret-key.js";
import {
  NO_SESSION,
  beginSession,
  resolveSession,
  runCleanup,
  switchOrganization,
} from "./sessions.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

const ADMIN_EMAIL = "second.admin@example.org";
const ADMIN_PASSWORD = "a first admin passphrase, invented";
const PASSWORD = "an invented passphrase for tests";

const keys = testKeyring();
let setup: Promise<{ testDb: TestDatabase; db: Database; admin: UserId }> | undefined;
let db: Database;
let admin: UserId;
let testDb: TestDatabase;
const cleanups: (() => Promise<void>)[] = [];
const factors = new Map<UserId, TestFactor>();

async function ready(): Promise<void> {
  setup ??= (async () => {
    const t = await freshDatabase();
    await migrate({ connectionString: t.url });
    const d = openDatabase(t.url, { max: 6 });
    const made = await createFirstSystemAdmin(d, {
      email: ADMIN_EMAIL,
      displayName: "Second Admin",
      password: ADMIN_PASSWORD,
    });
    if (!made.ok) throw new Error("no admin");
    factors.set(made.value.userId, await giveTestFactor(d, keys, made.value.userId, 50));
    return { testDb: t, db: d, admin: made.value.userId };
  })();
  ({ db, admin, testDb } = await setup);
}

// Warm the setup before the first test, under the suite's longer hook limit
// (U-008). A failure stays in `setup`, so with no database each test still
// fails on its own when it calls ready().
beforeAll(() => ready().catch(() => undefined));

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
function source(): string {
  const n = unique();
  return `10.38.${String(Math.floor(n / 250))}.${String(1 + (n % 250))}`;
}

async function organization(): Promise<OrganizationId> {
  const id = newOrganizationId();
  ok(await insertOrganization(db, { id, name: `Invented Society ${String(unique())}` }));
  return id;
}

/** A new person in `org`; with `factor`, a test factor (active, with recovery codes). */
async function member(
  org: OrganizationId,
  { factor = true }: { factor?: boolean } = {},
): Promise<{ userId: UserId; email: string }> {
  const email = `second.person${String(unique())}@example.org`;
  const box: InvitationMessage[] = [];
  ok(
    await createInvitation(db, { organizationId: org, email, invitedBy: admin }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const userId = ok(
    await acceptInvitation(db, {
      token: box[0]?.token ?? "",
      organizationId: org,
      email,
      displayName: "Invented Person",
      password: PASSWORD,
    }),
  ).userId;
  if (factor) factors.set(userId, await giveTestFactor(db, keys, userId, 20));
  return { userId, email };
}

/** A session waiting for its second step, inserted as the owner (no scrypt run). */
async function pending(
  userId: UserId,
  org: OrganizationId | null,
): Promise<{ token: string; sessionId: SessionId }> {
  const token = newSessionToken();
  const id = newSessionId();
  await db.execute(sql`
    INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
      created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at)
    SELECT ${id}::uuid, ${hashSessionToken(token)}, ${userId}::uuid, ${org}::uuid,
      'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
    FROM (SELECT clock_timestamp() AS t) c`);
  return { token, sessionId: id };
}

async function stepNow(q: Queryable = db): Promise<bigint> {
  const rows = await q.rows<{ s: string }>(sql`SELECT public.totp_step_now()::text AS s`);
  return BigInt(rows[0]?.s ?? "0");
}

/** The TOTP code `offset` steps from now for `secret`. */
async function codeAt(secret: Uint8Array, offset = 0n): Promise<string> {
  return hotp(secret, (await stepNow()) + offset);
}

/** The code of someone's test factor for a step not used yet (moves on a step if needed). */
async function freshCode(userId: UserId): Promise<string> {
  const f = factors.get(userId);
  if (f === undefined) throw new Error("no factor");
  const rows = await db.rows<{ last: string }>(sql`
    SELECT last_step::text AS last FROM public.second_factors
    WHERE user_id = ${userId}::uuid AND state = 'active'`);
  const last = BigInt(rows[0]?.last ?? "-1");
  // The current step first (one step back may leave the window before the
  // check); if it and the next are used, wait for the clock to move on.
  for (let i = 0; i < 70; i++) {
    const now = await stepNow();
    for (const step of [now, now + 1n]) if (step > last) return hotp(f.secret, step);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no unused step in the window");
}

function recovery(userId: UserId): string {
  const code = factors.get(userId)?.codes.pop();
  if (code === undefined) throw new Error("no recovery code left");
  return code;
}

/** Signs in fully with a code. */
async function full(
  userId: UserId,
  org: OrganizationId,
): Promise<{ token: string; sessionId: SessionId }> {
  const p = await pending(userId, org);
  const r = await completeSecondStep(db, keys, p.token, {
    source: source(),
    recoveryCode: recovery(userId),
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { token: r.token, sessionId: p.sessionId };
}

async function counters(userId: UserId): Promise<number> {
  const rows = await db.rows<{ n: number }>(sql`
    SELECT failures AS n FROM public.second_step_throttles WHERE key = ${`user:${userId}`}`);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------

describe("the secret key", () => {
  it("refuses a missing, malformed, short or patterned key, never echoing it", () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{}, "secret_key_missing"],
      [{ OCULUS_SECRET_KEY: "" }, "secret_key_missing"],
      [{ OCULUS_SECRET_KEY: "fake key with spaces, not a secret" }, "secret_key_malformed"],
      [{ OCULUS_SECRET_KEY: "FAKEshortkey" }, "secret_key_weak"],
      [{ OCULUS_SECRET_KEY: "a".repeat(64) }, "secret_key_weak"],
      [{ OCULUS_SECRET_KEY: Buffer.alloc(48, 7).toString("base64url") }, "secret_key_weak"],
      [
        { OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY, OCULUS_SECRET_KEY_PREVIOUS: "FAKE" },
        "secret_key_previous_invalid",
      ],
    ];
    for (const [env, code] of cases) {
      let caught: unknown;
      try {
        loadSecretKeyring(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretKeyError);
      expect((caught as SecretKeyError).code).toBe(code);
      for (const value of Object.values(env)) {
        if (value !== undefined && value !== "") {
          expect((caught as Error).message).not.toContain(value);
          expect(inspect(caught)).not.toContain(value);
        }
      }
    }
  });

  it("accepts base64url, base64 and hex, and shows nothing secret when logged", () => {
    const bytes = Buffer.from(FAKE_TEST_SECRET_KEY, "base64url");
    const a = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY });
    const b = loadSecretKeyring({ OCULUS_SECRET_KEY: bytes.toString("base64") });
    const c = loadSecretKeyring({ OCULUS_SECRET_KEY: bytes.toString("hex") });
    expect(a.currentKeyId).toBe(b.currentKeyId);
    expect(a.currentKeyId).toBe(c.currentKeyId);
    expect(isSecretKeyring(a)).toBe(true);
    expect(isSecretKeyring({ currentKeyId: a.currentKeyId })).toBe(false);
    for (const shown of [JSON.stringify(a), inspect(a, { showHidden: true, depth: 9 })]) {
      expect(shown).not.toContain(FAKE_TEST_SECRET_KEY);
      expect(shown).not.toContain(bytes.toString("hex"));
    }
  });

  it("seals with AES-256-GCM bound to the row, and opens only with the right key and row", () => {
    const secret = new Uint8Array(20).fill(9);
    const box = sealSecret(keys, secret, "row A");
    expect(openSecret(keys, box, "row A")).toEqual(Buffer.from(secret));
    expect(openSecret(keys, box, "row B")).toBeUndefined();
    const tampered = Buffer.from(box);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(openSecret(keys, tampered, "row A")).toBeUndefined();
    const other = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 });
    expect(openSecret(other, box, "row A")).toBeUndefined();
    // Two seals of one secret differ (a random nonce each time).
    expect(sealSecret(keys, secret, "row A").equals(box)).toBe(false);
  });

  it("refuses to set anything up without a real keyring", async () => {
    await ready();
    const fake = { currentKeyId: keys.currentKeyId };
    await expect(startEnrolment(db, fake, newSessionToken())).rejects.toThrow(TypeError);
    await expect(
      completeSecondStep(db, fake, newSessionToken(), { source: source(), code: "123456" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("setting up at first sign-in", () => {
  it("from a session waiting for its second step: secret once, confirm, 10 recovery codes, a full session", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const signIn = await beginSession(db, {
      email: person.email,
      password: PASSWORD,
      source: source(),
      organizationId: org,
    });
    if (!signIn.ok) throw new Error("no sign-in");
    const p = signIn.token;
    // Nothing to check yet.
    expect(
      await completeSecondStep(db, keys, p, { source: source(), code: "123456" }),
    ).toMatchObject({
      code: "enrolment_required",
    });
    const start = await startEnrolment(db, keys, p, { issuer: "Invented Society" });
    if (!start.ok) throw new Error(JSON.stringify(start));
    const secret = decodeBase32(start.secret);
    if (secret === undefined) throw new Error("not base32");
    expect(secret).toHaveLength(20);
    expect(start.otpauthUri).toBe(
      `otpauth://totp/Invented%20Society:${encodeURIComponent(person.email)}?secret=${start.secret}&issuer=Invented%20Society&algorithm=SHA1&digits=6&period=30`,
    );
    // Stored sealed: the secret's bytes and text are nowhere in the row.
    const stored = await db.rows<{ row: string; box: Buffer }>(sql`
      SELECT to_jsonb(f)::text AS row, secret_box AS box FROM public.second_factors f
      WHERE user_id = ${person.userId}::uuid`);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.row).not.toContain(Buffer.from(secret).toString("hex"));
    expect(stored[0]?.row).not.toContain(start.secret);
    expect(stored[0]?.box.includes(Buffer.from(secret))).toBe(false);
    // A wrong code doesn't confirm it.
    const right = await codeAt(secret);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(await confirmEnrolment(db, keys, p, { source: source(), code: wrong })).toMatchObject({
      code: "invalid_code",
    });
    const done = await confirmEnrolment(db, keys, p, { source: source(), code: right });
    if (!done.ok) throw new Error(JSON.stringify(done));
    expect(done.recoveryCodes).toHaveLength(10);
    expect(new Set(done.recoveryCodes).size).toBe(10);
    expect(done.token).not.toBe(p);
    expect(await resolveSession(db, done.token)).toMatchObject({
      ok: true,
      session: { userId: person.userId, organizationId: org },
    });
    // Only hashes are stored.
    const codes = await db.rows<{ row: string }>(sql`
      SELECT to_jsonb(c)::text AS row FROM public.second_step_recovery_codes c
      WHERE user_id = ${person.userId}::uuid`);
    expect(codes).toHaveLength(10);
    for (const c of done.recoveryCodes) {
      const canonical = normalizeRecoveryCode(c) ?? "";
      expect(codes.map((r) => r.row).join("")).not.toContain(canonical);
    }
    expect(await secondFactorStatus(db, done.token)).toMatchObject({
      ok: true,
      enrolled: true,
      recoveryCodesLeft: 10,
    });
    // A second set-up is refused while this one is in use.
    const again = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, again.token)).toMatchObject({
      code: "already_enrolled",
    });
    // And the code just used can't sign in again (no replay).
    expect(
      await completeSecondStep(db, keys, again.token, { source: source(), code: right }),
    ).toMatchObject({
      code: "invalid_code",
    });
    // A recovery code from the set does.
    const r = await completeSecondStep(db, keys, again.token, {
      source: source(),
      recoveryCode: (done.recoveryCodes[3] ?? "").toLowerCase().replaceAll("-", " "),
    });
    expect(r.ok).toBe(true);
  });

  it("confirms only in the session that started it, and a restart replaces the secret", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const a = await pending(person.userId, org);
    const b = await pending(person.userId, org);
    const first = await startEnrolment(db, keys, a.token);
    if (!first.ok) throw new Error("no start");
    const secret = decodeBase32(first.secret) ?? new Uint8Array();
    expect(
      await confirmEnrolment(db, keys, b.token, { source: source(), code: await codeAt(secret) }),
    ).toMatchObject({ code: "enrolment_required" });
    const second = await startEnrolment(db, keys, a.token);
    if (!second.ok) throw new Error("no restart");
    expect(second.secret).not.toBe(first.secret);
    // The first secret no longer works.
    expect(
      await confirmEnrolment(db, keys, a.token, { source: source(), code: await codeAt(secret) }),
    ).toMatchObject({ code: "invalid_code" });
    const states = await db.rows<{ state: string }>(sql`
      SELECT state FROM public.second_factors WHERE user_id = ${person.userId}::uuid ORDER BY created_at`);
    expect(states.map((s) => s.state)).toEqual(["revoked", "pending"]);
    // At most 5 starts per waiting session.
    for (let i = 0; i < 3; i++) expect((await startEnrolment(db, keys, a.token)).ok).toBe(true);
    expect(await startEnrolment(db, keys, a.token)).toMatchObject({ code: "too_many_attempts" });
    // A full session or no session can't start one.
    expect(await startEnrolment(db, keys, newSessionToken())).toBe(NO_SESSION);
  });

  it("asks a person in several organizations to choose without using the code up", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const person = await member(orgA, { factor: false });
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(
        db,
        { organizationId: orgB, email: person.email, invitedBy: admin },
        (m) => {
          box.push(m);
          return Promise.resolve();
        },
      ),
    );
    const { acceptInvitationForUser } = await import("./accounts.js");
    ok(
      await acceptInvitationForUser(db, {
        token: box[0]?.token ?? "",
        organizationId: orgB,
        userId: person.userId,
      }),
    );
    const p = await pending(person.userId, null);
    const start = await startEnrolment(db, keys, p.token);
    if (!start.ok) throw new Error("no start");
    const code = await codeAt(decodeBase32(start.secret) ?? new Uint8Array());
    expect(await confirmEnrolment(db, keys, p.token, { source: source(), code })).toMatchObject({
      code: "choose_organization",
      organizationIds: [orgA, orgB].sort(),
    });
    const done = await confirmEnrolment(db, keys, p.token, {
      source: source(),
      code,
      organizationId: orgB,
    });
    expect(done).toMatchObject({ ok: true, session: { organizationId: orgB } });
  });
});

describe("checking codes", () => {
  it("accepts the steps either side of now and refuses two away", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const f = factors.get(person.userId);
    if (f === undefined) throw new Error("no factor");
    for (const offset of [2n, -2n]) {
      const p = await pending(person.userId, org);
      const now = await stepNow();
      const near = [-1n, 0n, 1n].map((d) => hotp(f.secret, now + d));
      const code = await codeAt(f.secret, offset);
      if (near.includes(code)) continue;
      expect(await completeSecondStep(db, keys, p.token, { source: source(), code })).toMatchObject(
        {
          code: "invalid_code",
        },
      );
    }
    for (const offset of [-1n, 0n, 1n]) {
      const p = await pending(person.userId, org);
      const r = await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: await codeAt(f.secret, offset),
      });
      expect({ offset, ok: r.ok }).toEqual({ offset, ok: true });
    }
    // Every step up to now+1 is used: none of them works again (no replay).
    const p = await pending(person.userId, org);
    for (const offset of [-1n, 0n, 1n]) {
      expect(
        await completeSecondStep(db, keys, p.token, {
          source: source(),
          code: await codeAt(f.secret, offset),
        }),
      ).toMatchObject({ code: "invalid_code" });
    }
  });

  it("refuses malformed input without counting it", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    for (const input of [
      {},
      { code: "12345" },
      { code: "123456", recoveryCode: recovery(person.userId) },
      { recoveryCode: "not a code" },
      { code: "123456", extra: 1 },
    ]) {
      expect(await completeSecondStep(db, keys, p.token, input as never)).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(await counters(person.userId)).toBe(0);
  });

  it("ends a waiting session after 5 wrong codes, counting codes sent at once one by one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      const right = await freshCode(person.userId);
      const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          completeSecondStep(i % 2 === 0 ? db : other, keys, p.token, {
            source: source(),
            code: wrong,
          }),
        ),
      );
      const codes = results.map((r) => (r.ok ? "ok" : r.code)).sort();
      expect(codes.filter((c) => c === "invalid_code")).toHaveLength(4);
      expect(codes.filter((c) => c === "ok")).toHaveLength(0);
      expect(codes.filter((c) => c === "too_many_attempts").length).toBeGreaterThanOrEqual(1);
      expect(await counters(person.userId)).toBe(5);
      // The session is gone: even the right code can't finish it now.
      expect(await completeSecondStep(db, keys, p.token, { source: source(), code: right })).toBe(
        NO_SESSION,
      );
    } finally {
      await other.close();
    }
  });

  it("makes a guesser at the cap wait for TOTP, but the person still gets in with a recovery code", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // A password holder guessing TOTP codes, spaced out, has reached the cap.
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`user:${person.userId}`}, 40, clock_timestamp())`);
    const p = await pending(person.userId, org);
    const r = await completeSecondStep(db, keys, p.token, {
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(r).toMatchObject({ ok: false, code: "throttled" });
    // At most 15 minutes (D-068's cap), never longer.
    const wait = !r.ok && r.code === "throttled" ? r.retryAfterSeconds : 0;
    expect(wait).toBeGreaterThan(800);
    expect(wait).toBeLessThanOrEqual(900);
    expect(await counters(person.userId)).toBe(40);
    // The real person, from their own address, signs in with a recovery code.
    const done = await completeSecondStep(db, keys, p.token, {
      source: source(),
      recoveryCode: recovery(person.userId),
    });
    expect(done.ok).toBe(true);
    // The guesser's counter on TOTP stays.
    expect(await counters(person.userId)).toBe(40);
    // Once the wait is over, a right code clears it.
    await db.execute(sql`UPDATE public.second_step_throttles
      SET last_failure_at = clock_timestamp() - interval '20 minutes'
      WHERE key = ${`user:${person.userId}`}`);
    const q = await pending(person.userId, org);
    expect(
      (
        await completeSecondStep(db, keys, q.token, {
          source: source(),
          code: await freshCode(person.userId),
        })
      ).ok,
    ).toBe(true);
    expect(await counters(person.userId)).toBe(0);
  });

  it("records an alert when a person's wrong codes start a wait, for the notice", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const right = await freshCode(person.userId);
    const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
    // Five wrong codes over two waiting sessions (four in one, one in another).
    const a = await pending(person.userId, org);
    for (let i = 0; i < 4; i++) {
      await completeSecondStep(db, keys, a.token, { source: source(), code: wrong });
    }
    const alerts = async () =>
      (
        await db.rows<{ failures: number }>(sql`
          SELECT failures FROM public.second_step_alerts WHERE user_id = ${person.userId}::uuid`)
      ).map((x) => x.failures);
    expect(await alerts()).toEqual([]);
    const b = await pending(person.userId, org);
    await completeSecondStep(db, keys, b.token, { source: source(), code: wrong });
    expect(await alerts()).toEqual([5]);
    // Recovery codes, never a wait for the person, raise none.
    await completeSecondStep(db, keys, b.token, {
      source: source(),
      recoveryCode: "0000-0000-0000-0000-0000-0000",
    });
    expect(await alerts()).toEqual([5]);
  });

  it("limits wrong codes, recovery codes included, per client address", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const from = source();
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`source:v4:${from}`}, 30, clock_timestamp())`);
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: from,
        recoveryCode: recovery(person.userId),
      }),
    ).toMatchObject({ code: "throttled" });
  });

  it("stops taking TOTP codes when the hash chain is used up; recovery codes still work", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    factors.set(person.userId, await giveTestFactor(db, keys, person.userId, 5, 2));
    for (let i = 0; i < 2; i++) {
      const p = await pending(person.userId, org);
      const r = await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: await freshCode(person.userId),
      });
      expect(r.ok).toBe(true);
      // The stored anchor is now the link just revealed: it hashes to the one before.
    }
    const chain = await db.rows<{ generation: string; anchor: Buffer }>(sql`
      SELECT ratchet_generation::text AS generation, ratchet_anchor AS anchor
      FROM public.second_factors WHERE user_id = ${person.userId}::uuid`);
    expect(chain[0]?.generation).toBe("2");
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: hotp(
          factors.get(person.userId)?.secret ?? new Uint8Array(20),
          (await stepNow()) + 1n,
        ),
      }),
    ).toMatchObject({ code: "second_step_unavailable" });
    expect(
      (
        await completeSecondStep(db, keys, p.token, {
          source: source(),
          recoveryCode: recovery(person.userId),
        })
      ).ok,
    ).toBe(true);
  });

  it("says when the secret can't be opened, and recovery codes still work then", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const otherKeys = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 });
    expect(
      await completeSecondStep(db, otherKeys, p.token, {
        source: source(),
        code: await freshCode(person.userId),
      }),
    ).toMatchObject({ code: "second_step_unavailable" });
    expect(await counters(person.userId)).toBe(0);
    expect(
      (
        await completeSecondStep(db, otherKeys, p.token, {
          source: source(),
          recoveryCode: recovery(person.userId),
        })
      ).ok,
    ).toBe(true);
  });
});

describe("wrong codes no right code explained raise an alert (S-045)", () => {
  async function alertsOf(userId: UserId): Promise<number[]> {
    return (
      await db.rows<{ failures: number }>(sql`
        SELECT failures FROM public.second_step_alerts WHERE user_id = ${userId}::uuid
        ORDER BY created_at, id`)
    ).map((x) => x.failures);
  }
  async function unexplained(userId: UserId): Promise<number> {
    const rows = await db.rows<{ n: number }>(sql`
      SELECT failures AS n FROM public.second_step_throttles WHERE key = ${`wrong:${userId}`}`);
    return rows[0]?.n ?? 0;
  }
  /** Moves every counter of the person's back by `hours`, as if that time had passed. */
  async function later(userId: UserId, hours: number): Promise<void> {
    await db.execute(sql`
      UPDATE public.second_step_throttles
      SET last_failure_at = last_failure_at - make_interval(hours => ${hours})
      WHERE key IN (${`user:${userId}`}, ${`wrong:${userId}`})`);
  }
  async function wrongFor(userId: UserId): Promise<string> {
    const right = await freshCode(userId);
    return String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
  }

  it("tells a password holder's four guesses a day, which never start a wait", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const wrong = await wrongFor(person.userId);
    // Day 1: someone with the password tries 4 codes and gives up.
    const a = await pending(person.userId, org);
    for (let i = 0; i < 4; i++) {
      expect(
        await completeSecondStep(db, keys, a.token, { source: source(), code: wrong }),
      ).toMatchObject({ code: "invalid_code" });
    }
    expect(await alertsOf(person.userId)).toEqual([]);
    // Day 2: the person's counter is forgotten; the guesser's next session's
    // first code is the one that tells the 4 from before.
    await later(person.userId, 25);
    const b = await pending(person.userId, org);
    await completeSecondStep(db, keys, b.token, { source: source(), code: wrong });
    expect(await alertsOf(person.userId)).toEqual([4]);
    // Each is told once: three more in B, then the person signs in with the
    // right code in a new session: the alert tells B's 4.
    for (let i = 0; i < 3; i++) {
      await completeSecondStep(db, keys, b.token, { source: source(), code: wrong });
    }
    expect(await alertsOf(person.userId)).toEqual([4]);
    await later(person.userId, 25);
    const c = await pending(person.userId, org);
    const signedIn = await completeSecondStep(db, keys, c.token, {
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(signedIn.ok).toBe(true);
    expect(await alertsOf(person.userId)).toEqual([4, 4]);
    expect(await unexplained(person.userId)).toBe(0);
    // And nothing more to tell at the next sign-in.
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([4, 4]);
  });

  it("a recovery code in a new session tells them too", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const wrong = await wrongFor(person.userId);
    const a = await pending(person.userId, org);
    await completeSecondStep(db, keys, a.token, { source: source(), code: wrong });
    await completeSecondStep(db, keys, a.token, { source: source(), code: wrong });
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([2]);
  });

  it("a typo followed by the right code in the same session raises none", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    {
      const p = await pending(person.userId, org);
      const wrong = await wrongFor(person.userId);
      for (let i = 0; i < 2; i++) {
        expect(
          await completeSecondStep(db, keys, p.token, { source: source(), code: wrong }),
        ).toMatchObject({ code: "invalid_code" });
      }
      const r = await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: await freshCode(person.userId),
      });
      expect(r.ok).toBe(true);
      expect(await unexplained(person.userId)).toBe(0);
    }
    // A typo, then a recovery code, explains the typo too.
    const p = await pending(person.userId, org);
    await completeSecondStep(db, keys, p.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    const r = await completeSecondStep(db, keys, p.token, {
      source: source(),
      recoveryCode: recovery(person.userId),
    });
    expect(r.ok).toBe(true);
    expect(await unexplained(person.userId)).toBe(0);
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([]);
  });

  it("the cleanup tells the codes of a sign-in that never finished, an hour on, without waiting for the next", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const recent = await member(org);
    for (const who of [person, recent]) {
      const a = await pending(who.userId, org);
      for (let i = 0; i < 3; i++) {
        await completeSecondStep(db, keys, a.token, {
          source: source(),
          code: await wrongFor(who.userId),
        });
      }
    }
    // The person's 3 are two hours old; the other's are minutes old and
    // could still be explained.
    await later(person.userId, 2);
    const done = await runCleanup(db);
    expect(done.secondStepAlerts).toBe(1);
    expect(await alertsOf(person.userId)).toEqual([3]);
    expect(await unexplained(person.userId)).toBe(0);
    expect(await alertsOf(recent.userId)).toEqual([]);
    expect(await unexplained(recent.userId)).toBe(3);
    // Told once: neither a second cleanup nor the next sign-in tells them again.
    await runCleanup(db);
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([3]);
  });

  it("tells codes the wait's alert already told only once, and old rows before they go", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const old = await member(org);
    const a = await pending(person.userId, org);
    const wrong = await wrongFor(person.userId);
    for (let i = 0; i < 5; i++) {
      await completeSecondStep(db, keys, a.token, { source: source(), code: wrong });
    }
    // The 5th started the person's wait: one alert, with all 5.
    expect(await alertsOf(person.userId)).toEqual([5]);
    expect(await unexplained(person.userId)).toBe(0);
    // A row 31 days old that still holds codes is told before it is deleted.
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`wrong:${old.userId}`}, 2, clock_timestamp() - interval '31 days')`);
    await later(person.userId, 2);
    await runCleanup(db);
    expect(await alertsOf(person.userId)).toEqual([5]);
    expect(await alertsOf(old.userId)).toEqual([2]);
    expect(await unexplained(old.userId)).toBe(0);
  });

  /** How many hours before now each alert's newest code was typed (S-054c), oldest alert first. */
  async function codeAgesOf(userId: UserId): Promise<(number | null)[]> {
    return (
      await db.rows<{ hours: number | null }>(sql`
        SELECT (extract(epoch FROM clock_timestamp() - last_code_at) / 3600)::float8 AS hours
        FROM public.second_step_alerts WHERE user_id = ${userId}::uuid
        ORDER BY created_at, id`)
    ).map((x) => (x.hours === null ? null : Math.round(x.hours)));
  }

  it("the wait's alert carries the unexplained codes its day's count doesn't have (S-054c)", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // Four codes today (one short of a wait), and six other unexplained codes
    // the day's count doesn't have (left, say, before a full session's right
    // code cleared the person's counter, with no cleanup run since).
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`user:${person.userId}`}, 4, clock_timestamp() - interval '10 minutes'),
             (${`wrong:${person.userId}`}, 6, clock_timestamp() - interval '20 minutes')`);
    const a = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, a.token, {
        source: source(),
        code: await wrongFor(person.userId),
      }),
    ).toMatchObject({ code: "invalid_code" });
    // The 5th of the day starts the wait. Its alert used to say 5 and take
    // all 7 unexplained codes off the counter, so 2 were never told.
    expect(await alertsOf(person.userId)).toEqual([7]);
    expect(await unexplained(person.userId)).toBe(0);
    // Nothing is told twice: not by the cleanup, nor by the next sign-in.
    await later(person.userId, 25);
    await runCleanup(db);
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([7]);
  });

  it("the wait's alert says the day's count when that is the larger (S-054c)", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // A full session's wrong re-entry codes count for the day, not as unexplained.
    const s = await full(person.userId, org);
    for (let i = 0; i < 4; i++) {
      await reauthenticate(db, keys, s.token, {
        password: PASSWORD,
        source: source(),
        code: await wrongFor(person.userId),
      });
    }
    expect(await unexplained(person.userId)).toBe(0);
    const a = await pending(person.userId, org);
    await completeSecondStep(db, keys, a.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    expect(await alertsOf(person.userId)).toEqual([5]);
    expect(await unexplained(person.userId)).toBe(0);
  });

  it("each alert keeps when its newest code was typed, which the notice gives (S-054c)", async () => {
    await ready();
    const org = await organization();
    const told = await member(org);
    const cleaned = await member(org);
    const waited = await member(org);
    // A sign-in's first code tells codes another session left a day before:
    // the alert is written now, but the codes are from then.
    const a = await pending(told.userId, org);
    for (let i = 0; i < 2; i++) {
      await completeSecondStep(db, keys, a.token, {
        source: source(),
        code: await wrongFor(told.userId),
      });
    }
    await later(told.userId, 25);
    await full(told.userId, org);
    expect(await alertsOf(told.userId)).toEqual([2]);
    expect(await codeAgesOf(told.userId)).toEqual([25]);
    // The cleanup tells codes three hours old: their time, not the cleanup's.
    const b = await pending(cleaned.userId, org);
    await completeSecondStep(db, keys, b.token, {
      source: source(),
      code: await wrongFor(cleaned.userId),
    });
    await later(cleaned.userId, 3);
    await runCleanup(db);
    expect(await alertsOf(cleaned.userId)).toEqual([1]);
    expect(await codeAgesOf(cleaned.userId)).toEqual([3]);
    // A wait's alert is about the code that started it: now.
    const c = await pending(waited.userId, org);
    const wrong = await wrongFor(waited.userId);
    for (let i = 0; i < 5; i++) {
      await completeSecondStep(db, keys, c.token, { source: source(), code: wrong });
    }
    expect(await alertsOf(waited.userId)).toEqual([5]);
    expect(await codeAgesOf(waited.userId)).toEqual([0]);
  });

  it("doesn't count a signed-in person's re-entry codes, which come after a whole sign-in", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person.userId, org);
    expect(
      await reauthenticate(db, keys, s.token, {
        password: PASSWORD,
        source: source(),
        code: await wrongFor(person.userId),
      }),
    ).toMatchObject({ ok: false });
    expect(await unexplained(person.userId)).toBe(0);
    await later(person.userId, 2);
    await runCleanup(db);
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([]);
  });

  it("forgets them after 30 days without another if no cleanup ran", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const a = await pending(person.userId, org);
    await completeSecondStep(db, keys, a.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    await later(person.userId, 24 * 31);
    await full(person.userId, org);
    expect(await alertsOf(person.userId)).toEqual([]);
  });

  it("isn't counted while the person's counter makes them wait, and a given-back code isn't one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`user:${person.userId}`}, 40, clock_timestamp())`);
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: await wrongFor(person.userId),
      }),
    ).toMatchObject({ code: "throttled" });
    expect(await unexplained(person.userId)).toBe(0);
    expect(await alertsOf(person.userId)).toEqual([]);
  });
});

describe("recovery codes", () => {
  it("are single use, and a new set stops the old one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const code = recovery(person.userId);
    const p = await pending(person.userId, org);
    const s = await completeSecondStep(db, keys, p.token, { source: source(), recoveryCode: code });
    if (!s.ok) throw new Error("no sign-in");
    const q = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, q.token, { source: source(), recoveryCode: code }),
    ).toMatchObject({
      code: "invalid_code",
    });
    const old = recovery(person.userId);
    const made = await regenerateRecoveryCodes(db, keys, s.token, {
      source: source(),
      code: await freshCode(person.userId),
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(made.recoveryCodes).toHaveLength(10);
    expect(
      await completeSecondStep(db, keys, q.token, { source: source(), recoveryCode: old }),
    ).toMatchObject({
      code: "invalid_code",
    });
    expect(await secondFactorStatus(db, s.token)).toMatchObject({ recoveryCodesLeft: 10 });
    expect(
      (
        await completeSecondStep(db, keys, q.token, {
          source: source(),
          recoveryCode: made.recoveryCodes[0] ?? "",
        })
      ).ok,
    ).toBe(true);
    // Each use is logged as a pass.
    const used = await db.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.second_step_passes
      WHERE user_id = ${person.userId}::uuid AND method = 'recovery'`);
    expect(used[0]?.n).toBe(2);
    // A new set needs a second step.
    expect(
      await regenerateRecoveryCodes(db, keys, s.token, { source: source(), code: "000000" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("are replaced only after a recent re-entry, with at most 5 wrong codes per session", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person.userId, org);
    await ageSession(s.sessionId, 11 * 60);
    // A stolen session cookie alone, without the password: refused before any code.
    expect(
      await regenerateRecoveryCodes(db, keys, s.token, {
        source: source(),
        code: await freshCode(person.userId),
      }),
    ).toMatchObject({ code: "reauthentication_required" });
    const again = await reauthenticate(db, keys, s.token, {
      password: PASSWORD,
      source: source(),
      recoveryCode: recovery(person.userId),
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    const right = await freshCode(person.userId);
    const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await regenerateRecoveryCodes(db, keys, again.token, {
        source: source(),
        code: wrong,
      });
      results.push(r.ok ? "ok" : r.code);
    }
    expect(results).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
    ]);
    // The session is signed out.
    expect(await resolveSession(db, again.token)).toBe(NO_SESSION);
  });

  it("can't be used by another person, or for another person's session", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const alice = await member(orgA);
    const bob = await member(orgB);
    const p = await pending(bob.userId, orgB);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        recoveryCode: recovery(alice.userId),
      }),
    ).toMatchObject({ code: "invalid_code" });
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        code: await freshCode(alice.userId),
      }),
    ).toMatchObject({ code: "invalid_code" });
    expect(
      (
        await completeSecondStep(db, keys, p.token, {
          source: source(),
          code: await freshCode(bob.userId),
        })
      ).ok,
    ).toBe(true);
  });
});

describe("races on two connections", () => {
  it("one code promotes one of two waiting sessions, and one session once", async () => {
    await ready();
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      const org = await organization();
      const person = await member(org);
      for (let round = 0; round < 2; round++) {
        const a = await pending(person.userId, org);
        const b = await pending(person.userId, org);
        const code = await freshCode(person.userId);
        const both = await Promise.all([
          completeSecondStep(db, keys, a.token, { source: source(), code }),
          completeSecondStep(other, keys, b.token, { source: source(), code }),
        ]);
        expect(both.filter((r) => r.ok)).toHaveLength(1);
        expect(both.find((r) => !r.ok)).toMatchObject({ code: "invalid_code" });
        const c = await pending(person.userId, org);
        const rc = recovery(person.userId);
        const same = await Promise.all([
          completeSecondStep(db, keys, c.token, { source: source(), recoveryCode: rc }),
          completeSecondStep(other, keys, c.token, { source: source(), recoveryCode: rc }),
        ]);
        expect(same.filter((r) => r.ok)).toHaveLength(1);
      }
    } finally {
      await other.close();
    }
  });
});

describe("after a reset, only the emailed token lets anyone set up again (second review)", () => {
  /** A fresh admin session (recent by its own sign-in) resets `userId`; returns the token sent. */
  async function resetBy(userId: UserId, org: OrganizationId): Promise<string> {
    const adminSession = await full(admin, org);
    const sent: EnrolmentMessage[] = [];
    ok(
      await resetSecondFactor(
        db,
        keys,
        adminSession.token,
        userId,
        { source: source(), recoveryCode: recovery(admin) },
        deliverTo(sent),
      ),
    );
    return sent[0]?.token ?? "";
  }

  it("even for someone with no factor in use", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    await resetBy(person.userId, org);
    const p = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, p.token)).toMatchObject({
      code: "enrolment_token_required",
    });
  });

  it("refuses a start without it before any work, making no factor and counting no start", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const token = await resetBy(person.userId, org);
    const p = await pending(person.userId, org);
    for (let i = 0; i < 8; i++) {
      expect(await startEnrolment(db, keys, p.token)).toMatchObject({
        code: "enrolment_token_required",
      });
    }
    const made = await db.rows(sql`SELECT 1 FROM public.second_factors
      WHERE user_id = ${person.userId}::uuid AND state = 'pending'`);
    expect(made).toHaveLength(0);
    expect((await startEnrolment(db, keys, p.token, { enrolmentToken: token })).ok).toBe(true);
  });

  it("isn't lifted by deleting the reset's pass", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    await resetBy(person.userId, org);
    const required = async () =>
      (
        await db.rows<{ r: boolean }>(sql`
          SELECT public.second_step_token_required(${person.userId}::uuid) AS r`)
      )[0]?.r;
    expect(await required()).toBe(true);
    // As the owner (the writer has no DELETE), with 0066's guard off just
    // for that (S-065): the pass goes, the token stays.
    await db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.second_step_passes DISABLE TRIGGER second_step_passes_no_delete`,
      );
      await q.execute(sql`DELETE FROM public.second_step_passes
        WHERE purpose = 'admin_reset' AND target_user_id = ${person.userId}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.second_step_passes ENABLE ALWAYS TRIGGER second_step_passes_no_delete`,
      );
    });
    expect(await required()).toBe(true);
    const p = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, p.token)).toMatchObject({
      code: "enrolment_token_required",
    });
  });

  it("isn't lifted by a clock that stepped back (order, not time)", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // The factor was confirmed while the clock was an hour ahead; then the
    // clock stepped back and an admin reset the person.
    await db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.second_factors DISABLE TRIGGER second_factors_check_change`,
      );
      await q.execute(sql`UPDATE public.second_factors SET confirmed_at = now() + interval '1 hour'
        WHERE user_id = ${person.userId}::uuid AND state = 'active'`);
      await q.execute(
        sql`ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_check_change`,
      );
    });
    const token = await resetBy(person.userId, org);
    const p = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, p.token)).toMatchObject({
      code: "enrolment_token_required",
    });
    expect((await startEnrolment(db, keys, p.token, { enrolmentToken: token })).ok).toBe(true);
  });

  it("and a second reset replaces the first token", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const first = await resetBy(person.userId, org);
    const second = await resetBy(person.userId, org);
    const p = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, p.token, { enrolmentToken: first })).toMatchObject({
      code: "enrolment_token_required",
    });
    expect((await startEnrolment(db, keys, p.token, { enrolmentToken: second })).ok).toBe(true);
  });

  it("refuses the writer role's re-enrolment by every route the review found (A, B, G)", async () => {
    await ready();
    const writer = await writerDatabase();
    try {
      const org = await organization();
      const wrongToken = await import("node:crypto").then((c) => c.randomBytes(32));
      /** The writer's own pending factor for `userId` from waiting session `sessionId`, with a chain of 2. */
      const writersFactor = (userId: UserId, sessionId: SessionId, id: string, l0: Buffer) =>
        sql`INSERT INTO public.second_factors (id, user_id, kind, state, secret_box,
              ratchet_anchor, ratchet_generation, chain_length, last_step, enrol_session_id,
              created_at)
            VALUES (${id}::uuid, ${userId}::uuid, 'totp', 'pending', ${Buffer.alloc(60, 7)},
              sha256(sha256(${l0})), 0, 2, -1, ${sessionId}::uuid, now())`;

      // (A) The person starts with the token in S; the writer revokes that
      // pending factor and puts its own in with enrol_session_id = S.
      const victim = await member(org);
      const token = await resetBy(victim.userId, org);
      const s = await pending(victim.userId, org);
      expect((await startEnrolment(db, keys, s.token, { enrolmentToken: token })).ok).toBe(true);
      await expect(
        writer.execute(sql`UPDATE public.second_factors SET state = 'revoked'
          WHERE user_id = ${victim.userId}::uuid AND state = 'pending'`),
      ).rejects.toMatchObject({ constraint: "second_factors_state" });
      await expect(
        writer.transaction(async (tx) => {
          // Even inside one transaction with a revocation it can't make.
          await tx.execute(writersFactor(victim.userId, s.sessionId, newSessionId(), wrongToken));
        }),
      ).rejects.toMatchObject({
        constraint: matching(/^second_factors_/),
      });
      // Presenting a made-up token is refused by its hash.
      await expect(
        writer.execute(sql`UPDATE public.second_step_enrolment_tokens
          SET presented = ${wrongToken.toString("base64url")}
          WHERE user_id = ${victim.userId}::uuid`),
      ).rejects.toMatchObject({ constraint: "second_step_enrolment_tokens_use" });

      // (B) After a second reset, a waiting session the writer makes itself,
      // or the old enrol session's ID: still no set-up without the token.
      await resetBy(victim.userId, org);
      const own = newSessionId();
      await writer.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
          created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds,
          expires_at)
        SELECT ${own}::uuid, ${hashSessionToken(newSessionToken())}, ${victim.userId}::uuid,
          ${org}::uuid, 'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() AS t) c`);
      for (const session of [own, s.sessionId]) {
        await expect(
          writer.execute(writersFactor(victim.userId, session, newSessionId(), wrongToken)),
        ).rejects.toMatchObject({
          constraint: matching(/^second_factors_new_(token|session)$/),
        });
      }

      // (G) An account that never set up: the writer can set one up (the
      // password alone allows it, D-052), but after a reset evicts it, it
      // can't come back, by its old session or a new one, and no column it
      // can set changes that.
      const fresh = await member(org, { factor: false });
      const g = newSessionId();
      await writer.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
          created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds,
          expires_at)
        SELECT ${g}::uuid, ${hashSessionToken(newSessionToken())}, ${fresh.userId}::uuid,
          ${org}::uuid, 'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() AS t) c`);
      const gFactor = newSessionId();
      const l0 = Buffer.alloc(32, 9);
      await writer.execute(writersFactor(fresh.userId, g, gFactor, l0));
      // A pass for a pending factor only from the session that set it up.
      const other = newSessionId();
      await writer.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
          created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds,
          expires_at)
        SELECT ${other}::uuid, ${hashSessionToken(newSessionToken())}, ${fresh.userId}::uuid,
          ${org}::uuid, 'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() AS t) c`);
      await expect(
        writer.execute(sql`INSERT INTO public.second_step_passes (id, user_id, factor_id,
            session_id, purpose, method, step, created_at, created_xact, reveal)
          VALUES (gen_random_uuid(), ${fresh.userId}::uuid, ${gFactor}::uuid, ${other}::uuid,
            'sign_in', 'totp', public.totp_step_now(), now(), pg_current_xact_id(),
            sha256(${l0}))`),
      ).rejects.toMatchObject({ constraint: "second_step_passes_factor" });
      // Activated by a moving UPDATE (its own chain link): allowed, as set-up is.
      await writer.execute(sql`UPDATE public.second_factors
        SET ratchet_anchor = sha256(${l0}), ratchet_generation = 1,
            last_step = public.totp_step_now(), state = 'active'
        WHERE id = ${gFactor}::uuid`);
      await resetBy(fresh.userId, org);
      const back = newSessionId();
      await writer.execute(sql`
        INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage, signed_in_at,
          created_at, last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds,
          expires_at)
        SELECT ${back}::uuid, ${hashSessionToken(newSessionToken())}, ${fresh.userId}::uuid,
          ${org}::uuid, 'second_step', t, t, t, t, t, 14400, 43200, t + interval '10 minutes'
        FROM (SELECT clock_timestamp() AS t) c`);
      for (const session of [back, g]) {
        await expect(
          writer.execute(writersFactor(fresh.userId, session, newSessionId(), l0)),
        ).rejects.toMatchObject({
          constraint: matching(/^second_factors_new_(token|session)$/),
        });
      }
      // There is no column left that would let a later insert skip the token.
      const columns = await db.rows<{ name: string }>(sql`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = 'public.second_factors'::regclass AND attnum > 0 AND NOT attisdropped`);
      expect(columns.map((c) => c.name)).not.toContain("token_authorized");
    } finally {
      await writer.close();
    }
  });
});

describe("re-entering the password can't deadlock with a reset (second review)", () => {
  it("locks the session row before the factor row", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person.userId, org);
    const adminSession = await full(admin, org);
    const deadlocks = async () =>
      Number(
        (
          await db.rows<{ n: string }>(sql`
            SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`)
        )[0]?.n ?? "0",
      );
    const before = await deadlocks();
    const reauthConn = openDatabase(testDb.url, { max: 2 });
    const resetConn = openDatabase(testDb.url, { max: 2 });
    try {
      // The re-entry pauses just before its session UPDATE (after its pass),
      // until the reset is waiting on a lock.
      let resetting: Promise<unknown> | undefined;
      const paused = pauseBefore(
        reauthConn,
        (text) => text.includes("reauth_pass ="),
        async (tx) => {
          resetting = resetSecondFactor(
            resetConn,
            keys,
            adminSession.token,
            person.userId,
            { source: source(), recoveryCode: recovery(admin) },
            deliverTo([]),
          );
          // Wait for the reset itself to queue behind this transaction (U-008).
          await waitUntilBlockedBy(await backendPid(tx));
        },
      );
      const r = await reauthenticate(paused, keys, s.token, {
        password: PASSWORD,
        source: source(),
        recoveryCode: recovery(person.userId),
      });
      expect(r.ok).toBe(true);
      expect(ok((await resetting) as Validated<{ reset: boolean }>)).toMatchObject({
        reset: true,
      });
    } finally {
      await reauthConn.close();
      await resetConn.close();
    }
    expect(await deadlocks()).toBe(before);
    // Room for the setup's sign-ins plus waitUntilBlockedBy's own 20 s, so a
    // stuck race reports its clear message, not a bare timeout (U-008).
  }, 60_000);
});

describe("a lost race isn't a wrong code", () => {
  it("gives back the attempt of a right code another connection used first", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const a = await pending(person.userId, org);
    const b = await pending(person.userId, org);
    const code = await freshCode(person.userId);
    const holder = openDatabase(testDb.url, { max: 1 });
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      // Both check the code before either writes its pass: the factor row
      // is held until both are waiting on it.
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((r) => (locked = r));
      const holding = holder.transaction(async (tx) => {
        await tx.rows(sql`SELECT 1 FROM public.second_factors
          WHERE user_id = ${person.userId}::uuid AND state = 'active' FOR UPDATE`);
        locked();
        await held;
      });
      // The holder has the row before either racer starts.
      await taken;
      const racing = Promise.all([
        completeSecondStep(db, keys, a.token, { source: source(), code }),
        completeSecondStep(other, keys, b.token, { source: source(), code }),
      ]);
      for (let i = 0; i < 200; i++) {
        const waiting = await db.rows(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (waiting.length >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await holding;
      const both = await racing;
      expect(both.filter((r) => r.ok)).toHaveLength(1);
      expect(both.find((r) => !r.ok)).toMatchObject({ code: "invalid_code" });
      const loser = both[0].ok ? b : a;
      const rows = await db.rows<{ key: string; failures: number }>(sql`
        SELECT key, failures FROM public.second_step_throttles
        WHERE key IN (${`user:${person.userId}`}, ${`session:${loser.sessionId}`})`);
      expect(rows.every((r) => r.failures === 0)).toBe(true);
    } finally {
      await holder.close();
      await other.close();
    }
  });

  it("serialises two set-up starts for one person, counting nothing", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const p = await pending(person.userId, org);
    const other = openDatabase(testDb.url, { max: 2 });
    try {
      const both = await Promise.all([
        startEnrolment(db, keys, p.token),
        startEnrolment(other, keys, p.token),
      ]);
      expect(both.every((r) => r.ok)).toBe(true);
      const live = await db.rows(sql`SELECT 1 FROM public.second_factors
        WHERE user_id = ${person.userId}::uuid AND state = 'pending'`);
      expect(live).toHaveLength(1);
      expect(await counters(person.userId)).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("re-entering the password needs the second step", () => {
  it("refuses a wrong code, then marks the session recently authenticated with a new token", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person.userId, org);
    await db.execute(sql`UPDATE public.second_step_throttles SET failures = 0`);
    expect(
      await reauthenticate(db, keys, s.token, {
        password: PASSWORD,
        source: source(),
        code: "000000",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await reauthenticate(db, keys, s.token, { password: PASSWORD, source: source() }),
    ).toMatchObject({ code: "invalid_request" });
    const r = await reauthenticate(db, keys, s.token, {
      password: PASSWORD,
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(r).toMatchObject({ ok: true, session: { recentlyAuthenticated: true } });
    // The database refuses a re-entry without its pass, even with a new token.
    await expect(
      db.execute(sql`UPDATE public.sessions SET password_at = clock_timestamp(),
          token_hash = ${hashSessionToken(newSessionToken())}, rotated_at = clock_timestamp()
        WHERE id = ${s.sessionId}::uuid`),
    ).rejects.toMatchObject({ constraint: "sessions_reauth_pass" });
  });
});

describe("only a whole sign-in makes an address known (S-044)", () => {
  async function knownSources(email: string): Promise<string[]> {
    const rows = await db.rows<{ source_key: string }>(sql`
      SELECT source_key FROM public.sign_in_known_sources
      WHERE account_key = ${throttleAccountKey(email)} ORDER BY source_key`);
    return rows.map((r) => r.source_key);
  }

  it("someone with only the password can't push the person's own address out and keep them waiting", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const home = source();
    // The person signs in from home: password, then their code.
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ ok: true });
    expect(await knownSources(person.email)).toEqual([]);
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: home,
        recoveryCode: recovery(person.userId),
      }),
    ).toMatchObject({ ok: true });
    expect(await knownSources(person.email)).toEqual([throttleSourceKey(home)]);
    // The attack: the right password from 25 fresh addresses, never the code …
    for (let i = 0; i < 25; i++) {
      expect(
        await signIn(db, { email: person.email, password: PASSWORD, source: source() }),
      ).toMatchObject({ ok: true });
    }
    // … then one wrong guess per wait keeps the account counter waiting.
    await signIn(db, { email: person.email, password: "attacker guess", source: source() });
    await db.execute(sql`
      UPDATE public.sign_in_throttles SET failures = 400, last_failure_at = clock_timestamp()
      WHERE key = ${throttleAccountKey(person.email)}`);
    // Home is still known, and the person still gets in from there.
    expect(await knownSources(person.email)).toEqual([throttleSourceKey(home)]);
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: home }),
    ).toMatchObject({ ok: true });
    await db.execute(sql`
      DELETE FROM public.sign_in_throttles WHERE key = ${throttleAccountKey(person.email)}`);
  }, 30_000);

  it("a wrong code, or setting up at first sign-in, counts the same way", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const from = source();
    const begun = await beginSession(db, {
      email: person.email,
      password: PASSWORD,
      source: from,
      organizationId: org,
    });
    if (!begun.ok) throw new Error("no sign-in");
    expect(await knownSources(person.email)).toEqual([]);
    const start = await startEnrolment(db, keys, begun.token, { issuer: "Invented Society" });
    if (!start.ok) throw new Error(JSON.stringify(start));
    const secret = decodeBase32(start.secret);
    if (secret === undefined) throw new Error("not base32");
    const right = await codeAt(secret);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(
      await confirmEnrolment(db, keys, begun.token, { source: from, code: wrong }),
    ).toMatchObject({ code: "invalid_code" });
    expect(await knownSources(person.email)).toEqual([]);
    expect(
      await confirmEnrolment(db, keys, begun.token, { source: from, code: right }),
    ).toMatchObject({ ok: true });
    expect(await knownSources(person.email)).toEqual([throttleSourceKey(from)]);
  });
});

describe('"last sign-in" is stamped only by a whole sign-in (S-053)', () => {
  async function lastSignIn(userId: UserId): Promise<string | null> {
    const rows = await db.rows<{ at: string | null }>(sql`
      SELECT last_sign_in_at::text AS at FROM public.users WHERE id = ${userId}::uuid`);
    return rows[0]?.at ?? null;
  }

  it("the right password and a wrong code leave it alone; the right code stamps it", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const from = source();
    const begun = await beginSession(db, {
      email: person.email,
      password: PASSWORD,
      source: from,
      organizationId: org,
    });
    if (!begun.ok) throw new Error("no sign-in");
    expect(await lastSignIn(person.userId)).toBeNull();
    const right = await freshCode(person.userId);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(
      await completeSecondStep(db, keys, begun.token, { source: from, code: wrong }),
    ).toMatchObject({ code: "invalid_code" });
    expect(await lastSignIn(person.userId)).toBeNull();
    expect(
      await completeSecondStep(db, keys, begun.token, { source: from, code: right }),
    ).toMatchObject({ ok: true });
    const stamped = await lastSignIn(person.userId);
    expect(stamped).not.toBeNull();
    // Someone with only the password, later, from elsewhere: no new stamp.
    for (let i = 0; i < 3; i++) {
      expect(
        await signIn(db, { email: person.email, password: PASSWORD, source: source() }),
      ).toMatchObject({ ok: true });
    }
    expect(await lastSignIn(person.userId)).toBe(stamped);
  });

  it("is stamped when setting up at first sign-in finishes, not before", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const from = source();
    const begun = await beginSession(db, {
      email: person.email,
      password: PASSWORD,
      source: from,
      organizationId: org,
    });
    if (!begun.ok) throw new Error("no sign-in");
    const start = await startEnrolment(db, keys, begun.token, { issuer: "Invented Society" });
    if (!start.ok) throw new Error(JSON.stringify(start));
    const secret = decodeBase32(start.secret);
    if (secret === undefined) throw new Error("not base32");
    const right = await codeAt(secret);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(
      await confirmEnrolment(db, keys, begun.token, { source: from, code: wrong }),
    ).toMatchObject({ code: "invalid_code" });
    expect(await lastSignIn(person.userId)).toBeNull();
    expect(
      await confirmEnrolment(db, keys, begun.token, { source: from, code: right }),
    ).toMatchObject({ ok: true });
    expect(await lastSignIn(person.userId)).not.toBeNull();
  });

  it("a promotion refused for the organization stamps nothing until it goes through", async () => {
    await ready();
    const one = await organization();
    const two = await organization();
    const person = await member(one);
    // A second membership, so the person must choose.
    const box: InvitationMessage[] = [];
    ok(
      await createInvitation(
        db,
        { organizationId: two, email: person.email, invitedBy: admin },
        (m) => {
          box.push(m);
          return Promise.resolve();
        },
      ),
    );
    const { acceptInvitationForUser } = await import("./accounts.js");
    ok(
      await acceptInvitationForUser(db, {
        token: box[0]?.token ?? "",
        organizationId: two,
        userId: person.userId,
      }),
    );
    const p = await pending(person.userId, null);
    const code = recovery(person.userId);
    expect(
      await completeSecondStep(db, keys, p.token, { source: source(), recoveryCode: code }),
    ).toMatchObject({ code: "choose_organization" });
    expect(await lastSignIn(person.userId)).toBeNull();
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        recoveryCode: code,
        organizationId: two,
      }),
    ).toMatchObject({ ok: true });
    expect(await lastSignIn(person.userId)).not.toBeNull();
  });
});

describe("re-entering the password has a counter strangers can't push (S-018)", () => {
  it("lets a signed-in person re-enter while strangers keep the sign-in counter waiting", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const s = await full(person.userId, org);
    // Strangers guess at the sign-in form until the account counter waits.
    for (let i = 0; i < 6; i++) {
      await signIn(db, { email: person.email, password: "stranger guess", source: source() });
    }
    expect(
      await signIn(db, { email: person.email, password: PASSWORD, source: source() }),
    ).toMatchObject({ code: "throttled" });
    const counter = async (key: string): Promise<number | undefined> =>
      (
        await db.rows<{ failures: number }>(
          sql`SELECT failures FROM public.sign_in_throttles WHERE key = ${key}`,
        )
      )[0]?.failures;
    const before = await counter(throttleAccountKey(person.email));
    // Re-entry in the person's own session is not held by that wait.
    const r = await reauthenticate(db, keys, s.token, {
      password: PASSWORD,
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(r).toMatchObject({ ok: true, session: { recentlyAuthenticated: true } });
    if (!r.ok) return;
    // Wrong passwords at re-entry count on the person's own counter, not the account's.
    for (let i = 0; i < 6; i++) {
      await reauthenticate(db, keys, r.token, {
        password: "a mistyped passphrase",
        source: source(),
        code: "000000",
      });
    }
    expect(await counter(throttleReauthKey(person.userId))).toBe(5);
    expect(await counter(throttleAccountKey(person.email))).toBe(before);
    expect(
      await reauthenticate(db, keys, r.token, {
        password: PASSWORD,
        source: source(),
        code: await freshCode(person.userId),
      }),
    ).toMatchObject({ ok: false, code: "throttled" });
  });
});

describe("a system admin's reset", () => {
  it("needs a recent re-entry and the admin's code, ends the person's sessions and asks them to set up again", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const theirs = await full(person.userId, org);
    const adminSession = await full(admin, org);
    const sent: EnrolmentMessage[] = [];
    // A person who isn't a system admin can't.
    expect(
      codesOf(
        await resetSecondFactor(
          db,
          keys,
          theirs.token,
          admin,
          { source: source(), recoveryCode: recovery(person.userId) },
          deliverTo(sent),
        ),
      ),
    ).toEqual(["not_permitted"]);
    // Recent means within 10 minutes of entering the password again.
    await db.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`);
      await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER zzzz_sessions_keep_identity`);
      await q.execute(sql`UPDATE public.sessions SET password_at = password_at - interval '11 minutes',
          signed_in_at = signed_in_at - interval '11 minutes',
          created_at = created_at - interval '11 minutes',
          rotated_at = rotated_at - interval '11 minutes',
          second_step_at = second_step_at - interval '11 minutes',
          expires_at = expires_at - interval '11 minutes'
        WHERE id = ${adminSession.sessionId}::uuid`);
      await q.execute(sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change`);
      await q.execute(
        sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity`,
      );
    });
    expect(
      codesOf(
        await resetSecondFactor(
          db,
          keys,
          adminSession.token,
          person.userId,
          { source: source(), recoveryCode: recovery(admin) },
          deliverTo(sent),
        ),
      ),
    ).toEqual(["reauthentication_required"]);
    const again = await reauthenticate(db, keys, adminSession.token, {
      password: ADMIN_PASSWORD,
      source: source(),
      recoveryCode: recovery(admin),
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(
      codesOf(
        await resetSecondFactor(
          db,
          keys,
          again.token,
          person.userId,
          { source: source(), code: "000000" },
          deliverTo(sent),
        ),
      ),
    ).toEqual(["invalid_code"]);
    expect(
      codesOf(
        await resetSecondFactor(
          db,
          keys,
          again.token,
          newSessionId() as unknown as UserId,
          { source: source(), recoveryCode: recovery(admin) },
          deliverTo(sent),
        ),
      ),
    ).toEqual(["unknown_user"]);
    const done = await resetSecondFactor(
      db,
      keys,
      again.token,
      person.userId,
      { source: source(), recoveryCode: recovery(admin) },
      deliverTo(sent),
    );
    expect(ok(done)).toEqual({ reset: true, ended: 1, delivered: true });
    expect(await resolveSession(db, theirs.token)).toBe(NO_SESSION);
    // One message, to their address, with a token that appears nowhere else.
    expect(sent).toHaveLength(1);
    const message = sent[0];
    if (message === undefined) throw new Error("nothing sent");
    expect(message.email).toBe(person.email);
    expect(JSON.stringify(done)).not.toContain(message.token);
    const stored = await db.rows<{ row: string }>(sql`
      SELECT to_jsonb(t)::text AS row FROM public.second_step_enrolment_tokens t
      WHERE user_id = ${person.userId}::uuid`);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.row).not.toContain(message.token);
    // Their old recovery codes and authenticator stop; they must set up again.
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, {
        source: source(),
        recoveryCode: recovery(person.userId),
      }),
    ).toMatchObject({ code: "enrolment_required" });
    // The password alone (a waiting session) isn't enough: the emailed token is.
    expect(await startEnrolment(db, keys, p.token)).toMatchObject({
      code: "enrolment_token_required",
    });
    expect(
      await startEnrolment(db, keys, p.token, { enrolmentToken: newSessionToken() }),
    ).toMatchObject({ code: "enrolment_token_required" });
    const start = await startEnrolment(db, keys, p.token, { enrolmentToken: message.token });
    expect(start.ok).toBe(true);
    // Every start presents it, the same waiting session included.
    expect(await startEnrolment(db, keys, p.token)).toMatchObject({
      code: "enrolment_token_required",
    });
    expect((await startEnrolment(db, keys, p.token, { enrolmentToken: message.token })).ok).toBe(
      true,
    );
    // It works from another waiting session too until a factor is confirmed,
    // never without it.
    const q = await pending(person.userId, org);
    expect(await startEnrolment(db, keys, q.token)).toMatchObject({
      code: "enrolment_token_required",
    });
    const restart = await startEnrolment(db, keys, q.token, { enrolmentToken: message.token });
    if (!restart.ok) throw new Error(JSON.stringify(restart));
    const confirmed = await confirmEnrolment(db, keys, q.token, {
      source: source(),
      code: await codeAt(decodeBase32(restart.secret) ?? new Uint8Array()),
    });
    expect(confirmed.ok).toBe(true);
    // Once a factor is confirmed the token is spent.
    const presented = await db
      .execute(
        sql`UPDATE public.second_step_enrolment_tokens SET presented = ${message.token}
          WHERE user_id = ${person.userId}::uuid`,
      )
      .catch((e: unknown) => e);
    expect(presented).toMatchObject({ constraint: "second_step_enrolment_tokens_use" });
    // The admin's own session is untouched.
    expect((await resolveSession(db, again.token)).ok).toBe(true);
    // The writer can't mint an enrolment token without a reset.
    await expect(
      db.execute(sql`INSERT INTO public.second_step_enrolment_tokens
          (user_id, token_hash, created_by_pass, created_at, expires_at)
        SELECT ${person.userId}::uuid, sha256('FAKE token'::bytea), id, now(),
               now() + interval '1 day'
        FROM public.second_step_passes WHERE purpose = 'admin_reset' LIMIT 1`),
    ).rejects.toMatchObject({ constraint: "second_step_enrolment_tokens_new" });
  });

  it("locks user rows before factor rows, so it can't deadlock with a promotion", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const deadlocks = async () =>
      Number(
        (
          await db.rows<{ n: string }>(sql`
            SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`)
        )[0]?.n ?? "0",
      );
    const adminSession = await full(admin, org);
    const again = await reauthenticate(db, keys, adminSession.token, {
      password: ADMIN_PASSWORD,
      source: source(),
      recoveryCode: recovery(admin),
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    const before = await deadlocks();
    const holder = openDatabase(testDb.url, { max: 1 });
    const resetter = openDatabase(testDb.url, { max: 2 });
    try {
      // A promotion of the person, pinned mid-way: it holds their user row
      // FOR SHARE and is about to lock the admin's factor (as a pass would).
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      let holderPid!: (pid: number) => void;
      const holderPidKnown = new Promise<number>((r) => (holderPid = r));
      const holding = holder.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${person.userId}::uuid FOR SHARE`);
        holderPid(await backendPid(tx));
        await held;
        await tx.rows(sql`SELECT 1 FROM public.second_factors
          WHERE user_id = ${admin}::uuid AND state = 'active' FOR UPDATE`);
      });
      const resetting = resetSecondFactor(
        resetter,
        keys,
        again.token,
        person.userId,
        { source: source(), recoveryCode: recovery(admin) },
        deliverTo([]),
      );
      // Wait until the reset is waiting on the holder's lock (the person's
      // user row), not just any lock (U-008).
      await waitUntilBlockedBy(await holderPidKnown);
      release();
      await holding;
      expect(ok(await resetting)).toMatchObject({ reset: true });
    } finally {
      await holder.close();
      await resetter.close();
    }
    expect(await deadlocks()).toBe(before);
    // Room for the setup's sign-ins plus waitUntilBlockedBy's own 20 s, so a
    // stuck race reports its clear message, not a bare timeout (U-008).
  }, 60_000);
});

/** Moves a session back in time by `seconds`, as the owner, with its guards off inside the transaction only. */
async function ageSession(sessionId: SessionId, seconds: number): Promise<void> {
  await db.transaction(async (q) => {
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER sessions_check_change`);
    await q.execute(sql`ALTER TABLE public.sessions DISABLE TRIGGER zzzz_sessions_keep_identity`);
    await q.execute(sql`UPDATE public.sessions SET
        password_at = password_at - make_interval(secs => ${seconds}),
        signed_in_at = signed_in_at - make_interval(secs => ${seconds}),
        created_at = created_at - make_interval(secs => ${seconds}),
        rotated_at = rotated_at - make_interval(secs => ${seconds}),
        second_step_at = second_step_at - make_interval(secs => ${seconds}),
        expires_at = expires_at - make_interval(secs => ${seconds})
      WHERE id = ${sessionId}::uuid`);
    await q.execute(sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER sessions_check_change`);
    await q.execute(
      sql`ALTER TABLE public.sessions ENABLE ALWAYS TRIGGER zzzz_sessions_keep_identity`,
    );
  });
}

/** The server process behind `q` (inside a transaction, the one holding its locks). */
async function backendPid(q: Queryable): Promise<number> {
  const [row] = await q.rows<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  if (row === undefined) throw new Error("no backend pid");
  return row.pid;
}

/**
 * Waits until a backend of this database is waiting on a lock that backend
 * `pid` holds (U-008). Waiting for "any lock wait" could match the wrong
 * backend, and giving up quietly after a few seconds let a busy machine release
 * the holder before the race was set up; this fails clearly instead.
 */
async function waitUntilBlockedBy(pid: number, withinMs = 20_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const waiting = await db.rows(sql`
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`);
    if (waiting.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `no backend waited on a lock held by ${String(pid)} within ${String(withinMs)} ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** `base`, with `hook` awaited once before the first statement `match` picks. */
function pauseBefore(
  base: Database,
  match: (text: string) => boolean,
  hook: (q: Queryable) => Promise<void>,
): Database {
  let fired = false;
  const gate = async (q: Queryable, query: Sql): Promise<void> => {
    if (!fired && match(query.text)) {
      fired = true;
      await hook(q);
    }
  };
  const wrap = (q: Queryable): Queryable => ({
    rows: async <R extends Row = Row>(query: Sql): Promise<R[]> => {
      await gate(q, query);
      return q.rows<R>(query);
    },
    execute: async (query: Sql): Promise<number> => {
      await gate(q, query);
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

/** A login role made by grantWriterRole, connected to the test database (dropped after the file). */
async function writerDatabase(): Promise<Database> {
  const role = `oculus_test_t038w_${unique().toString()}_${String(process.pid)}`;
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
  expect(await checkWriterConnection(writer)).toEqual([]);
  return writer;
}

/** An asymmetric matcher typed as the string it stands for. */
function matching(pattern: RegExp): string {
  const matcher: unknown = expect.stringMatching(pattern);
  return matcher as string;
}

function deliverTo(box: EnrolmentMessage[]): EnrolmentDelivery {
  return (message) => {
    box.push(message);
    return Promise.resolve();
  };
}

function codesOf(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("the secret never leaves the package", () => {
  it("is in no result but set-up's, and errors reach onError only as SQLSTATE and constraint", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const p = await pending(person.userId, org);
    const start = await startEnrolment(db, keys, p.token);
    if (!start.ok) throw new Error("no start");
    const secret = decodeBase32(start.secret) ?? new Uint8Array();
    const hex = Buffer.from(secret).toString("hex");
    const seen: unknown[] = [];
    const results: unknown[] = [];
    results.push(await confirmEnrolment(db, keys, p.token, { source: source(), code: "000000" }));
    const done = await confirmEnrolment(db, keys, p.token, {
      source: source(),
      code: await codeAt(secret),
    });
    results.push(done);
    if (!done.ok) throw new Error("no set-up");
    results.push(await secondFactorStatus(db, done.token));
    // A database failure: the statement timeout, as a host might set it.
    const slow = openDatabase(testDb.url, { max: 1 });
    try {
      await slow.execute(sql`SET statement_timeout = 1`);
      await slow.execute(sql`SELECT 1`);
      const q = await pending(person.userId, org);
      results.push(
        await completeSecondStep(
          slow,
          keys,
          q.token,
          { source: source(), recoveryCode: done.recoveryCodes[0] ?? "" },
          { onError: (e) => seen.push(e) },
        ),
      );
    } finally {
      await slow.close();
    }
    for (const r of results) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(start.secret);
      expect(text).not.toContain(hex);
    }
    for (const e of seen) {
      expect(e).toBeInstanceOf(SecondStepDatabaseError);
      expect(Object.keys(e as object).sort()).toEqual(["code", "constraint"]);
      expect(inspect(e)).not.toContain(normalizeRecoveryCode(done.recoveryCodes[0]) ?? "x");
    }
  });
});

describe("key rotation", () => {
  it("re-seals secrets under the new key while the old one is given, then codes still work", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const rotated = loadSecretKeyring({
      OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2,
      OCULUS_SECRET_KEY_PREVIOUS: FAKE_TEST_SECRET_KEY,
    });
    const first = await resealSecondFactorSecrets(db, rotated);
    expect(first.resealed).toBeGreaterThanOrEqual(1);
    expect(await resealSecondFactorSecrets(db, rotated)).toEqual({ resealed: 0, unreadable: 0 });
    const onlyNew = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 });
    const p = await pending(person.userId, org);
    expect(
      (
        await completeSecondStep(db, onlyNew, p.token, {
          source: source(),
          code: await freshCode(person.userId),
        })
      ).ok,
    ).toBe(true);
    // Back to the test key for the rest of the file.
    const back = loadSecretKeyring({
      OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
      OCULUS_SECRET_KEY_PREVIOUS: FAKE_TEST_SECRET_KEY_2,
    });
    expect((await resealSecondFactorSecrets(db, back)).unreadable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The database's own guards

describe("the database promotes only with a real second step", () => {
  it("fires every 0014 trigger always, and holds in replica mode", async () => {
    await ready();
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND c.relname IN ('second_factors', 'second_step_passes', 'second_step_recovery_codes')
      ORDER BY 1`);
    expect(rows.map((r) => r.name)).toEqual([
      "second_factors.second_factors_check_change",
      "second_factors.second_factors_check_new",
      "second_factors.second_factors_reset_ends_sessions",
      "second_factors.zzzz_second_factors_keep_identity",
      "second_step_passes.second_step_passes_append_only",
      "second_step_passes.second_step_passes_check_new",
      "second_step_passes.second_step_passes_no_delete",
      "second_step_passes.second_step_passes_no_truncate",
      "second_step_recovery_codes.second_step_recovery_codes_check_change",
      "second_step_recovery_codes.second_step_recovery_codes_check_new",
      "second_step_recovery_codes.second_step_recovery_codes_supersede",
      "second_step_recovery_codes.zzzz_second_step_recovery_codes_keep_identity",
    ]);
    expect(rows.every((r) => r.enabled === "A")).toBe(true);
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    await expect(
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(promoteBy(p.sessionId, org, newSessionId()));
      }),
    ).rejects.toMatchObject({ constraint: "sessions_second_step_pass" });
  });

  it("refuses the writer role every way around a code check, and checkWriterConnection accepts exactly its grants", async () => {
    await ready();
    const role = `oculus_test_t038_${unique().toString()}_${String(process.pid)}`;
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
      for (const [table, privileges] of Object.entries(SECOND_FACTOR_TABLE_PRIVILEGES)) {
        expect(WRITER_PRIVILEGES[table]).toEqual(privileges);
      }
      for (const extra of [
        "GRANT DELETE ON public.second_factors TO %I",
        "GRANT UPDATE ON public.second_step_passes TO %I",
        "GRANT DELETE ON public.second_step_recovery_codes TO %I",
      ]) {
        await db.transaction((q) => run(extra, q));
        try {
          expect((await checkWriterConnection(writer)).map((x) => x.code)).toEqual([
            "extra_privilege",
          ]);
        } finally {
          await db.transaction((q) =>
            run(extra.replace("GRANT", "REVOKE").replace(" TO ", " FROM "), q),
          );
        }
      }
      // Everything works as the writer.
      const orgA = await organization();
      const orgB = await organization();
      const person = await member(orgA);
      const p = await pending(person.userId, orgA);
      const s = await completeSecondStep(writer, keys, p.token, {
        source: source(),
        code: await freshCode(person.userId),
      });
      if (!s.ok) throw new Error(JSON.stringify(s));
      const newcomer = await member(orgA, { factor: false });
      const np = await pending(newcomer.userId, orgA);
      const start = await startEnrolment(writer, keys, np.token);
      if (!start.ok) throw new Error("no start");
      const enrolled = await confirmEnrolment(writer, keys, np.token, {
        source: source(),
        code: await codeAt(decodeBase32(start.secret) ?? new Uint8Array()),
      });
      expect(enrolled.ok).toBe(true);
      expect(
        (
          await regenerateRecoveryCodes(writer, keys, s.token, {
            source: source(),
            recoveryCode: recovery(person.userId),
          })
        ).ok,
      ).toBe(true);

      // What direct SQL can't do. A waiting session of an enrolled person:
      const victim = await member(orgA);
      const v = await pending(victim.userId, orgA);
      const vFactor = factors.get(victim.userId)?.factorId ?? "";
      const refusedWith = async (statement: Sql, constraint: string | RegExp) => {
        await expect(writer.execute(statement)).rejects.toMatchObject({
          constraint:
            typeof constraint === "string"
              ? constraint
              : (expect.stringMatching(constraint) as unknown as string),
        });
      };
      // 1. Promote by UPDATE, with no pass or another session's pass.
      await refusedWith(promoteBy(v.sessionId, orgA, null), "sessions_second_step_pass");
      const someoneElsesPass = await db.rows<{ id: string }>(sql`
        SELECT id::text AS id FROM public.second_step_passes WHERE user_id = ${newcomer.userId}::uuid LIMIT 1`);
      await refusedWith(
        promoteBy(v.sessionId, orgA, someoneElsesPass[0]?.id ?? null),
        "sessions_second_step_pass",
      );
      // 2. Write a pass with a made-up ratchet link or recovery code.
      for (const [method, step, reveal, code] of [
        ["totp", (await stepNow()).toString(), Buffer.alloc(32, 1), null],
        ["recovery", null, null, "0123456789ABCDEFGHJKMNPQ"],
      ] as const) {
        await refusedWith(
          sql`INSERT INTO public.second_step_passes (id, user_id, factor_id, session_id, purpose,
                method, step, created_at, created_xact, reveal, recovery_code)
              VALUES (gen_random_uuid(), ${victim.userId}::uuid, ${vFactor}::uuid,
                ${v.sessionId}::uuid, 'sign_in', ${method}, ${step}::bigint, now(),
                pg_current_xact_id(), ${reveal}::bytea, ${code})`,
          /^(second_factors_ratchet|second_step_passes_code)$/,
        );
      }
      // 3. Move the chain to an anchor of its choosing, lengthen it, or move
      // the last step directly.
      await refusedWith(
        sql`UPDATE public.second_factors SET ratchet_anchor = ${Buffer.alloc(32, 2)},
              ratchet_generation = ratchet_generation + 1, last_step = public.totp_step_now()
            WHERE id = ${vFactor}::uuid`,
        "second_factors_ratchet",
      );
      await refusedWith(
        sql`UPDATE public.second_factors SET chain_length = chain_length + 1000
            WHERE id = ${vFactor}::uuid`,
        "second_factors_ratchet",
      );
      await refusedWith(
        sql`UPDATE public.second_factors SET last_step = last_step + 1 WHERE id = ${vFactor}::uuid`,
        "second_factors_ratchet",
      );
      // 4. Revoke the factor (to set up its own), or start a second one beside it.
      await refusedWith(
        sql`UPDATE public.second_factors SET state = 'revoked' WHERE id = ${vFactor}::uuid`,
        "second_factors_state",
      );
      await expect(
        writer.execute(sql`INSERT INTO public.second_factors (id, user_id, kind, state, secret_box,
            ratchet_anchor, ratchet_generation, chain_length, last_step, enrol_session_id,
            created_at)
          VALUES (gen_random_uuid(), ${victim.userId}::uuid, 'totp', 'pending',
            ${Buffer.alloc(60, 4)}, ${Buffer.alloc(32, 5)}, 0, 100, -1, ${v.sessionId}::uuid, now())`),
      ).rejects.toMatchObject({ code: "23505" });
      // 5. Add recovery codes it knows, or use one up without it.
      await refusedWith(
        sql`INSERT INTO public.second_step_recovery_codes
              (user_id, factor_id, set_id, code_hash, created_at, created_xact)
            VALUES (${victim.userId}::uuid, ${vFactor}::uuid, gen_random_uuid(),
              sha256('0123456789ABCDEFGHJKMNPQ'::bytea), now(), pg_current_xact_id())`,
        "second_step_recovery_codes_new",
      );
      await refusedWith(
        sql`UPDATE public.second_step_recovery_codes SET used_at = now()
            WHERE user_id = ${victim.userId}::uuid`,
        "second_step_recovery_codes_use",
      );
      // 6. Mark recent re-entry of the password without a pass.
      await refusedWith(
        sql`UPDATE public.sessions SET password_at = clock_timestamp(),
              token_hash = ${hashSessionToken(newSessionToken())}, rotated_at = clock_timestamp()
            WHERE id = ${p.sessionId}::uuid`,
        "sessions_reauth_pass",
      );
      // 7. Copy a full session with another pass. (A copy with the source's own
      // pass is a switch, which the writer can still make: D-077.)
      await refusedWith(
        sql`INSERT INTO public.sessions (id, token_hash, user_id, organization_id, stage,
              signed_in_at, created_at, last_seen_at, rotated_at, password_at, second_step_at,
              second_step_pass, idle_seconds, absolute_seconds, expires_at)
            SELECT gen_random_uuid(), ${hashSessionToken(newSessionToken())}, o.user_id,
              ${orgA}::uuid, 'full', o.signed_in_at, c.t, c.t, c.t, o.signed_in_at,
              o.second_step_at, ${someoneElsesPass[0]?.id ?? null}::uuid, o.idle_seconds,
              o.absolute_seconds, o.expires_at
            FROM public.sessions o, (SELECT clock_timestamp() AS t) c
            WHERE o.id = ${p.sessionId}::uuid`,
        "sessions_new_full",
      );
      // 8. Change or delete a pass; delete a factor.
      await expect(
        writer.execute(sql`UPDATE public.second_step_passes SET purpose = 'reauth'`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(writer.execute(sql`DELETE FROM public.second_factors`)).rejects.toMatchObject({
        code: "42501",
      });
      // The victim's session is still waiting, and their real code still works.
      expect(
        (
          await completeSecondStep(writer, keys, v.token, {
            source: source(),
            code: await freshCode(victim.userId),
          })
        ).ok,
      ).toBe(true);
      // Switching copies the pass along (the database checks it matches).
      const memberOfB = await member(orgA);
      const { acceptInvitationForUser } = await import("./accounts.js");
      const box: InvitationMessage[] = [];
      ok(
        await createInvitation(
          db,
          { organizationId: orgB, email: memberOfB.email, invitedBy: admin },
          (m) => {
            box.push(m);
            return Promise.resolve();
          },
        ),
      );
      ok(
        await acceptInvitationForUser(db, {
          token: box[0]?.token ?? "",
          organizationId: orgB,
          userId: memberOfB.userId,
        }),
      );
      const mb = await full(memberOfB.userId, orgA);
      expect((await switchOrganization(writer, mb.token, orgB)).ok).toBe(true);
    } finally {
      await writer.close();
    }
  });
});

/** An UPDATE promoting a waiting session to full with a token of the caller's choosing. */
function promoteBy(sessionId: SessionId, org: OrganizationId, passId: string | null): Sql {
  return sql`UPDATE public.sessions SET stage = 'full', second_step_at = clock_timestamp(),
      organization_id = ${org}::uuid, token_hash = ${hashSessionToken(newSessionToken())},
      rotated_at = clock_timestamp(), second_step_pass = ${passId}::uuid,
      expires_at = signed_in_at + make_interval(secs => absolute_seconds)
    WHERE id = ${sessionId}::uuid`;
}

describe("wrong-code counters are changed in key order, and a reset forgets unexplained codes (S-054a)", () => {
  const deadlocks = async (): Promise<number> =>
    Number(
      (
        await db.rows<{ n: string }>(sql`
          SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()`)
      )[0]?.n ?? "0",
    );

  /**
   * Runs `work` on a connection that reads second_step_throttles in the
   * table's own order (no index scans), pausing before the statement `match`
   * picks. Meanwhile another transaction locks `first`, waits until that
   * statement waits on it, then locks `second` (a later key), as a code
   * attempt locks its counters in key order. A statement that locks in key
   * order waits on `first` holding nothing; one that already holds `second`
   * deadlocks. `before` runs at the pause, before the locks.
   */
  async function raceInKeyOrder<T>(
    match: (text: string) => boolean,
    first: string,
    second: string,
    work: (conn: Database) => Promise<T>,
    before?: () => Promise<void>,
  ): Promise<T> {
    const start = await deadlocks();
    const base = openDatabase(testDb.url, { max: 1 });
    const holder = openDatabase(testDb.url, { max: 1 });
    try {
      for (const setting of ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]) {
        await base.rows(sql`SELECT set_config(${setting}, 'off', false)`);
      }
      let holding: Promise<void> | undefined;
      const paused = pauseBefore(base, match, async () => {
        await before?.();
        let firstLocked!: () => void;
        const locked = new Promise<void>((resolve) => (firstLocked = resolve));
        holding = holder.transaction(async (tx) => {
          await tx.rows(sql`
            SELECT 1 FROM public.second_step_throttles WHERE key = ${first} FOR UPDATE`);
          firstLocked();
          for (let i = 0; i < 200; i++) {
            const waiting = await db.rows(sql`
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`);
            if (waiting.length > 0) break;
            await new Promise((r) => setTimeout(r, 25));
          }
          await tx.rows(sql`
            SELECT 1 FROM public.second_step_throttles WHERE key = ${second} FOR UPDATE`);
        });
        holding.catch(() => undefined);
        await locked;
      });
      const result = await work(paused);
      expect(holding).toBeDefined();
      await holding;
      expect(await deadlocks()).toBe(start);
      return result;
    } finally {
      await base.close();
      await holder.close();
    }
  }

  /** Moves `key`'s row to the end of the table (a new row version), so a scan in the table's order meets it last. */
  async function toTheEnd(key: string): Promise<void> {
    await db.execute(sql`
      UPDATE public.second_step_throttles SET failures = failures WHERE key = ${key}`);
  }

  async function wrongFor(userId: UserId): Promise<string> {
    const right = await freshCode(userId);
    return String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
  }

  async function rowsOf(keys: readonly string[]): Promise<Record<string, number>> {
    const rows = await db.rows<{ key: string; failures: number }>(sql`
      SELECT key, failures FROM public.second_step_throttles WHERE key = ANY(${keys}::text[])`);
    return Object.fromEntries(rows.map((r) => [r.key, r.failures]));
  }

  it("the cleanup's delete can't deadlock with an attempt holding the person's counter", async () => {
    await ready();
    const org = await organization();
    const person = await member(org, { factor: false });
    const userKey = `user:${person.userId}`;
    const wrongKey = `wrong:${person.userId}`;
    // Both old enough to go; `wrong:` first in the table.
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${wrongKey}, 0, clock_timestamp() - interval '31 days')`);
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${userKey}, 1, clock_timestamp() - interval '2 days')`);
    await raceInKeyOrder(
      (text) => text.includes("DELETE FROM public.second_step_throttles t"),
      userKey,
      wrongKey,
      (conn) => runCleanup(conn),
    );
    expect(await rowsOf([userKey, wrongKey])).toEqual({});
  });

  it("giving back a code that couldn't be checked can't deadlock with an attempt", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const otherKeys = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 });
    const p = await pending(person.userId, org);
    const sessionKey = `session:${p.sessionId}`;
    const userKey = `user:${person.userId}`;
    const r = await raceInKeyOrder(
      (text) => text.includes("second_step_throttles") && text.includes("- 1, 0)"),
      sessionKey,
      userKey,
      (conn) =>
        completeSecondStep(conn, otherKeys, p.token, {
          source: source(),
          code: "123456",
        }),
      () => toTheEnd(sessionKey),
    );
    expect(r).toMatchObject({ code: "second_step_unavailable" });
    // Given back: nothing is left counted against the person or the session.
    expect(await rowsOf([sessionKey, userKey, `wrong:${person.userId}`])).toEqual({
      [sessionKey]: 0,
      [userKey]: 0,
      [`wrong:${person.userId}`]: 0,
    });
  });

  it("clearing the counters after a right code can't deadlock with an attempt", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const sessionKey = `session:${p.sessionId}`;
    const userKey = `user:${person.userId}`;
    const code = await freshCode(person.userId);
    const r = await raceInKeyOrder(
      (text) => text.includes("DELETE FROM public.second_step_throttles"),
      sessionKey,
      userKey,
      (conn) => completeSecondStep(conn, keys, p.token, { source: source(), code }),
      () => toTheEnd(sessionKey),
    );
    expect(r.ok).toBe(true);
    expect(await rowsOf([sessionKey, userKey])).toEqual({});
  });

  it("an admin reset forgets the person's unexplained codes, so they are never told as someone else's", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // The person, on a broken authenticator, types two wrong codes, gives up
    // and asks for a reset.
    const p = await pending(person.userId, org);
    const wrong = await wrongFor(person.userId);
    for (let i = 0; i < 2; i++) {
      expect(
        await completeSecondStep(db, keys, p.token, { source: source(), code: wrong }),
      ).toMatchObject({ code: "invalid_code" });
    }
    expect(await rowsOf([`wrong:${person.userId}`])).toEqual({ [`wrong:${person.userId}`]: 2 });
    const adminSession = await full(admin, org);
    ok(
      await resetSecondFactor(
        db,
        keys,
        adminSession.token,
        person.userId,
        { source: source(), recoveryCode: recovery(admin) },
        deliverTo([]),
      ),
    );
    expect(await rowsOf([`user:${person.userId}`, `wrong:${person.userId}`])).toEqual({});
    // Two hours on, the cleanup has nothing of theirs to tell.
    await db.execute(sql`
      UPDATE public.second_step_throttles SET last_failure_at = last_failure_at - interval '2 hours'
      WHERE key = ${`wrong:${person.userId}`}`);
    await runCleanup(db);
    const alerts = await db.rows(sql`
      SELECT 1 FROM public.second_step_alerts WHERE user_id = ${person.userId}::uuid`);
    expect(alerts).toEqual([]);
  });
});

describe("each sign-in's own unexplained codes, counted once known wrong (S-054b)", () => {
  async function alertsOf(userId: UserId): Promise<number[]> {
    return (
      await db.rows<{ failures: number }>(sql`
        SELECT failures FROM public.second_step_alerts WHERE user_id = ${userId}::uuid
        ORDER BY created_at, id`)
    ).map((x) => x.failures);
  }
  async function unexplained(userId: UserId): Promise<number> {
    const rows = await db.rows<{ n: number }>(sql`
      SELECT failures AS n FROM public.second_step_throttles WHERE key = ${`wrong:${userId}`}`);
    return rows[0]?.n ?? 0;
  }
  /** Two hours on for the person's unexplained codes, then the cleanup. */
  async function cleanupLater(userId: UserId): Promise<void> {
    await db.execute(sql`
      UPDATE public.second_step_throttles
      SET last_failure_at = last_failure_at - interval '2 hours'
      WHERE key = ${`wrong:${userId}`}`);
    await runCleanup(db);
  }
  async function wrongFor(userId: UserId): Promise<string> {
    const right = await freshCode(userId);
    return String((Number(right) + 500_000) % 1_000_000).padStart(6, "0");
  }
  /** `work` on its own connection, pausing once before the statement `match` picks to run `hook`. */
  async function pausedAt<T>(
    match: (text: string) => boolean,
    hook: () => Promise<void>,
    work: (conn: Database) => Promise<T>,
  ): Promise<{ result: T; fired: boolean }> {
    const base = openDatabase(testDb.url, { max: 1 });
    let fired = false;
    try {
      const result = await work(
        pauseBefore(base, match, async () => {
          fired = true;
          await hook();
        }),
      );
      return { result, fired };
    } finally {
      await base.close();
    }
  }

  it("a right code takes off only its own session's codes, never a later session's", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const wrong = await wrongFor(person.userId);
    // A: two wrong codes, still open.
    const a = await pending(person.userId, org);
    for (let i = 0; i < 2; i++) {
      await completeSecondStep(db, keys, a.token, { source: source(), code: wrong });
    }
    // B's first code tells A's 2; B adds 2 of its own.
    const b = await pending(person.userId, org);
    for (let i = 0; i < 2; i++) {
      await completeSecondStep(db, keys, b.token, { source: source(), code: wrong });
    }
    expect(await alertsOf(person.userId)).toEqual([2]);
    expect(await unexplained(person.userId)).toBe(2);
    // A day on for the person's counter (its wait is another matter), so
    // A's right code doesn't start one.
    await db.execute(sql`
      UPDATE public.second_step_throttles SET last_failure_at = last_failure_at - interval '25 hours'
      WHERE key = ${`user:${person.userId}`}`);
    // A signs in: its own 2 were already told; B's 2 stay to be told.
    const r = await completeSecondStep(db, keys, a.token, {
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(r.ok).toBe(true);
    expect(await unexplained(person.userId)).toBe(2);
    await cleanupLater(person.userId);
    expect(await alertsOf(person.userId)).toEqual([2, 2]);
  });

  it("recovery codes aren't a session's share: a right code after one takes off only its TOTP codes", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const other = await pending(person.userId, org);
    const mine = await pending(person.userId, org);
    // Mine: a wrong recovery code first (its first code; nothing to tell yet),
    // then one wrong TOTP code. The other session then sends 1 wrong code.
    await completeSecondStep(db, keys, mine.token, {
      source: source(),
      recoveryCode: "aaaa-bbbb-cccc-dddd-eeee-ffff",
    });
    await completeSecondStep(db, keys, mine.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    // The other session's first code tells my 1 and starts a new round.
    await completeSecondStep(db, keys, other.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    expect(await alertsOf(person.userId)).toEqual([1]);
    await completeSecondStep(db, keys, mine.token, {
      source: source(),
      code: await wrongFor(person.userId),
    });
    expect(await unexplained(person.userId)).toBe(2);
    const r = await completeSecondStep(db, keys, mine.token, {
      source: source(),
      code: await freshCode(person.userId),
    });
    expect(r.ok).toBe(true);
    // My one code since the round began came off; the other session's stays.
    expect(await unexplained(person.userId)).toBe(1);
  });

  it("another session's first code can't tell a right code on its way to the clear", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const a = await pending(person.userId, org);
    const b = await pending(person.userId, org);
    const code = await freshCode(person.userId);
    const wrong = await wrongFor(person.userId);
    const { result, fired } = await pausedAt(
      // After the promotion, before the clear's first statement.
      (text) =>
        text.includes("DELETE FROM public.second_step_throttles") || text.includes("mine AS ("),
      async () => {
        expect(
          await completeSecondStep(db, keys, b.token, { source: source(), code: wrong }),
        ).toMatchObject({ code: "invalid_code" });
      },
      (conn) => completeSecondStep(conn, keys, a.token, { source: source(), code }),
    );
    expect(fired).toBe(true);
    expect(result.ok).toBe(true);
    // A's right code was never on the counter: nothing told; B's code stays.
    expect(await alertsOf(person.userId)).toEqual([]);
    expect(await unexplained(person.userId)).toBe(1);
  });

  it("a right code whose sign-in stopped for another reason is given back, and never told", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    // The session ends between the code check and the promotion.
    const p = await pending(person.userId, org);
    const { result, fired } = await pausedAt(
      (text) => text.includes("s.stage = 'second_step'") && text.includes("FOR UPDATE OF s"),
      async () => {
        await db.execute(sql`DELETE FROM public.sessions WHERE id = ${p.sessionId}::uuid`);
      },
      async (conn) =>
        completeSecondStep(conn, keys, p.token, {
          source: source(),
          code: await freshCode(person.userId),
        }),
    );
    expect(fired).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(await counters(person.userId)).toBe(0);
    expect(await unexplained(person.userId)).toBe(0);
    // And when the promotion fails with an error.
    const q = await pending(person.userId, org);
    const code = await freshCode(person.userId);
    await expect(
      pausedAt(
        (text) => text.includes("s.stage = 'second_step'") && text.includes("FOR UPDATE OF s"),
        () => Promise.reject(new Error("the connection broke (invented)")),
        (conn) => completeSecondStep(conn, keys, q.token, { source: source(), code }),
      ),
    ).rejects.toThrow("the connection broke (invented)");
    expect(await counters(person.userId)).toBe(0);
    expect(await unexplained(person.userId)).toBe(0);
    await cleanupLater(person.userId);
    expect(await alertsOf(person.userId)).toEqual([]);
  });

  it("a wrong code is still counted when its own session ends while it is checked (review)", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const wrong = await wrongFor(person.userId);
    // The guesser signs out (or uses up the session) while the code is checked.
    const { result, fired } = await pausedAt(
      (text) => text.includes("INSERT INTO public.second_step_throttles (key) VALUES"),
      async () => {
        await db.execute(sql`DELETE FROM public.sessions WHERE id = ${p.sessionId}::uuid`);
      },
      (conn) => completeSecondStep(conn, keys, p.token, { source: source(), code: wrong }),
    );
    expect(fired).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(await unexplained(person.userId)).toBe(1);
    await cleanupLater(person.userId);
    expect(await alertsOf(person.userId)).toEqual([1]);
  });

  it("a wrong code in flight across an admin reset isn't counted, so it is never told as someone else's", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const wrong = await wrongFor(person.userId);
    const adminSession = await full(admin, org);
    // The attempt is past its session and factor checks when the reset commits.
    const { result, fired } = await pausedAt(
      (text) => text.includes("INSERT INTO public.second_step_throttles (key) VALUES"),
      async () => {
        ok(
          await resetSecondFactor(
            db,
            keys,
            adminSession.token,
            person.userId,
            { source: source(), recoveryCode: recovery(admin) },
            deliverTo([]),
          ),
        );
      },
      (conn) => completeSecondStep(conn, keys, p.token, { source: source(), code: wrong }),
    );
    expect(fired).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(await unexplained(person.userId)).toBe(0);
    await cleanupLater(person.userId);
    expect(await alertsOf(person.userId)).toEqual([]);
  });
});
