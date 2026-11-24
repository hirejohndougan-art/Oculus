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
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeBase32,
  hashSessionToken,
  hotp,
  newOrganizationId,
  newSessionId,
  newSessionToken,
  normalizeRecoveryCode,
  type OrganizationId,
  type SessionId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  acceptInvitation,
  createFirstSystemAdmin,
  createInvitation,
  type InvitationMessage,
} from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable } from "./client.js";
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
import { NO_SESSION, beginSession, resolveSession, switchOrganization } from "./sessions.js";
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
  const now = await stepNow();
  for (const step of [now - 1n, now, now + 1n]) if (step > last) return hotp(f.secret, step);
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
  const r = await completeSecondStep(db, keys, p.token, { recoveryCode: recovery(userId) });
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
      completeSecondStep(db, fake, newSessionToken(), { code: "123456" }),
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
    expect(await completeSecondStep(db, keys, p, { code: "123456" })).toMatchObject({
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
    expect(await confirmEnrolment(db, keys, p, { code: wrong })).toMatchObject({
      code: "invalid_code",
    });
    const done = await confirmEnrolment(db, keys, p, { code: right });
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
    expect(await completeSecondStep(db, keys, again.token, { code: right })).toMatchObject({
      code: "invalid_code",
    });
    // A recovery code from the set does.
    const r = await completeSecondStep(db, keys, again.token, {
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
    expect(await confirmEnrolment(db, keys, b.token, { code: await codeAt(secret) })).toMatchObject(
      { code: "enrolment_required" },
    );
    const second = await startEnrolment(db, keys, a.token);
    if (!second.ok) throw new Error("no restart");
    expect(second.secret).not.toBe(first.secret);
    // The first secret no longer works.
    expect(await confirmEnrolment(db, keys, a.token, { code: await codeAt(secret) })).toMatchObject(
      { code: "invalid_code" },
    );
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
    expect(await confirmEnrolment(db, keys, p.token, { code })).toMatchObject({
      code: "choose_organization",
      organizationIds: [orgA, orgB].sort(),
    });
    const done = await confirmEnrolment(db, keys, p.token, { code, organizationId: orgB });
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
      expect(await completeSecondStep(db, keys, p.token, { code })).toMatchObject({
        code: "invalid_code",
      });
    }
    for (const offset of [-1n, 0n, 1n]) {
      const p = await pending(person.userId, org);
      const r = await completeSecondStep(db, keys, p.token, {
        code: await codeAt(f.secret, offset),
      });
      expect({ offset, ok: r.ok }).toEqual({ offset, ok: true });
    }
    // Every step up to now+1 is used: none of them works again (no replay).
    const p = await pending(person.userId, org);
    for (const offset of [-1n, 0n, 1n]) {
      expect(
        await completeSecondStep(db, keys, p.token, { code: await codeAt(f.secret, offset) }),
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
          completeSecondStep(i % 2 === 0 ? db : other, keys, p.token, { code: wrong }),
        ),
      );
      const codes = results.map((r) => (r.ok ? "ok" : r.code)).sort();
      expect(codes.filter((c) => c === "invalid_code")).toHaveLength(4);
      expect(codes.filter((c) => c === "ok")).toHaveLength(0);
      expect(codes.filter((c) => c === "too_many_attempts").length).toBeGreaterThanOrEqual(1);
      expect(await counters(person.userId)).toBe(5);
      // The session is gone: even the right code can't finish it now.
      expect(await completeSecondStep(db, keys, p.token, { code: right })).toBe(NO_SESSION);
    } finally {
      await other.close();
    }
  });

  it("makes a person wait after repeated wrong codes, across sessions, without checking the code", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    await db.execute(sql`
      INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${`user:${person.userId}`}, 20, clock_timestamp())`);
    const p = await pending(person.userId, org);
    const r = await completeSecondStep(db, keys, p.token, {
      code: await freshCode(person.userId),
    });
    expect(r).toMatchObject({ ok: false, code: "throttled" });
    expect(!r.ok && r.code === "throttled" && r.retryAfterSeconds).toBeGreaterThan(3000);
    expect(await counters(person.userId)).toBe(20);
    // Recovery codes wait too.
    expect(
      await completeSecondStep(db, keys, p.token, { recoveryCode: recovery(person.userId) }),
    ).toMatchObject({ code: "throttled" });
    // Once the wait is over, a right code clears the counter.
    await db.execute(sql`UPDATE public.second_step_throttles
      SET last_failure_at = clock_timestamp() - interval '2 hours'
      WHERE key = ${`user:${person.userId}`}`);
    expect(
      (await completeSecondStep(db, keys, p.token, { code: await freshCode(person.userId) })).ok,
    ).toBe(true);
    expect(await counters(person.userId)).toBe(0);
  });

  it("says when the secret can't be opened, and recovery codes still work then", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const p = await pending(person.userId, org);
    const otherKeys = loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 });
    expect(
      await completeSecondStep(db, otherKeys, p.token, { code: await freshCode(person.userId) }),
    ).toMatchObject({ code: "second_step_unavailable" });
    expect(await counters(person.userId)).toBe(0);
    expect(
      (await completeSecondStep(db, otherKeys, p.token, { recoveryCode: recovery(person.userId) }))
        .ok,
    ).toBe(true);
  });
});

describe("recovery codes", () => {
  it("are single use, and a new set stops the old one", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const code = recovery(person.userId);
    const p = await pending(person.userId, org);
    const s = await completeSecondStep(db, keys, p.token, { recoveryCode: code });
    if (!s.ok) throw new Error("no sign-in");
    const q = await pending(person.userId, org);
    expect(await completeSecondStep(db, keys, q.token, { recoveryCode: code })).toMatchObject({
      code: "invalid_code",
    });
    const old = recovery(person.userId);
    const made = await regenerateRecoveryCodes(db, keys, s.token, {
      code: await freshCode(person.userId),
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(made.recoveryCodes).toHaveLength(10);
    expect(await completeSecondStep(db, keys, q.token, { recoveryCode: old })).toMatchObject({
      code: "invalid_code",
    });
    expect(await secondFactorStatus(db, s.token)).toMatchObject({ recoveryCodesLeft: 10 });
    expect(
      (await completeSecondStep(db, keys, q.token, { recoveryCode: made.recoveryCodes[0] ?? "" }))
        .ok,
    ).toBe(true);
    // Each use is logged as a pass.
    const used = await db.rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM public.second_step_passes
      WHERE user_id = ${person.userId}::uuid AND method = 'recovery'`);
    expect(used[0]?.n).toBe(2);
    // A new set needs a second step.
    expect(await regenerateRecoveryCodes(db, keys, s.token, { code: "000000" })).toMatchObject({
      ok: false,
    });
  });

  it("can't be used by another person, or for another person's session", async () => {
    await ready();
    const orgA = await organization();
    const orgB = await organization();
    const alice = await member(orgA);
    const bob = await member(orgB);
    const p = await pending(bob.userId, orgB);
    expect(
      await completeSecondStep(db, keys, p.token, { recoveryCode: recovery(alice.userId) }),
    ).toMatchObject({ code: "invalid_code" });
    expect(
      await completeSecondStep(db, keys, p.token, { code: await freshCode(alice.userId) }),
    ).toMatchObject({ code: "invalid_code" });
    expect(
      (await completeSecondStep(db, keys, p.token, { code: await freshCode(bob.userId) })).ok,
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
      for (let round = 0; round < 3; round++) {
        const a = await pending(person.userId, org);
        const b = await pending(person.userId, org);
        const code = await freshCode(person.userId);
        const both = await Promise.all([
          completeSecondStep(db, keys, a.token, { code }),
          completeSecondStep(other, keys, b.token, { code }),
        ]);
        expect(both.filter((r) => r.ok)).toHaveLength(1);
        expect(both.find((r) => !r.ok)).toMatchObject({ code: "invalid_code" });
        const c = await pending(person.userId, org);
        const rc = recovery(person.userId);
        const same = await Promise.all([
          completeSecondStep(db, keys, c.token, { recoveryCode: rc }),
          completeSecondStep(other, keys, c.token, { recoveryCode: rc }),
        ]);
        expect(same.filter((r) => r.ok)).toHaveLength(1);
      }
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

describe("a system admin's reset", () => {
  it("needs a recent re-entry and the admin's code, ends the person's sessions and asks them to set up again", async () => {
    await ready();
    const org = await organization();
    const person = await member(org);
    const theirs = await full(person.userId, org);
    const adminSession = await full(admin, org);
    // A person who isn't a system admin can't.
    expect(
      codesOf(
        await resetSecondFactor(db, keys, theirs.token, admin, {
          recoveryCode: recovery(person.userId),
        }),
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
        await resetSecondFactor(db, keys, adminSession.token, person.userId, {
          recoveryCode: recovery(admin),
        }),
      ),
    ).toEqual(["reauthentication_required"]);
    const again = await reauthenticate(db, keys, adminSession.token, {
      password: ADMIN_PASSWORD,
      source: source(),
      recoveryCode: recovery(admin),
    });
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(
      codesOf(await resetSecondFactor(db, keys, again.token, person.userId, { code: "000000" })),
    ).toEqual(["invalid_code"]);
    expect(
      codesOf(
        await resetSecondFactor(db, keys, again.token, newSessionId() as unknown as UserId, {
          recoveryCode: recovery(admin),
        }),
      ),
    ).toEqual(["unknown_user"]);
    const done = await resetSecondFactor(db, keys, again.token, person.userId, {
      recoveryCode: recovery(admin),
    });
    expect(ok(done)).toEqual({ reset: true, ended: 1 });
    expect(await resolveSession(db, theirs.token)).toBe(NO_SESSION);
    // Their old recovery codes and authenticator stop; they must set up again.
    const p = await pending(person.userId, org);
    expect(
      await completeSecondStep(db, keys, p.token, { recoveryCode: recovery(person.userId) }),
    ).toMatchObject({ code: "enrolment_required" });
    const start = await startEnrolment(db, keys, p.token);
    expect(start.ok).toBe(true);
    // The admin's own session is untouched.
    expect((await resolveSession(db, again.token)).ok).toBe(true);
  });
});

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
    results.push(await confirmEnrolment(db, keys, p.token, { code: "000000" }));
    const done = await confirmEnrolment(db, keys, p.token, { code: await codeAt(secret) });
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
          { recoveryCode: done.recoveryCodes[0] ?? "" },
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
      (await completeSecondStep(db, onlyNew, p.token, { code: await freshCode(person.userId) })).ok,
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
        code: await freshCode(person.userId),
      });
      if (!s.ok) throw new Error(JSON.stringify(s));
      const newcomer = await member(orgA, { factor: false });
      const np = await pending(newcomer.userId, orgA);
      const start = await startEnrolment(writer, keys, np.token);
      if (!start.ok) throw new Error("no start");
      const enrolled = await confirmEnrolment(writer, keys, np.token, {
        code: await codeAt(decodeBase32(start.secret) ?? new Uint8Array()),
      });
      expect(enrolled.ok).toBe(true);
      expect(
        (
          await regenerateRecoveryCodes(writer, keys, s.token, {
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
                method, step, created_at, created_xact, reveal, next_anchor, recovery_code)
              VALUES (gen_random_uuid(), ${victim.userId}::uuid, ${vFactor}::uuid,
                ${v.sessionId}::uuid, 'sign_in', ${method}, ${step}::bigint, now(),
                pg_current_xact_id(), ${reveal}::bytea, ${reveal}::bytea, ${code})`,
          /^(second_factors_ratchet|second_step_passes_code)$/,
        );
      }
      // 3. Move the ratchet or the last step directly.
      await refusedWith(
        sql`UPDATE public.second_factors SET ratchet_anchor = ${Buffer.alloc(32, 2)},
              ratchet_generation = ratchet_generation + 1, ratchet_reveal = ${Buffer.alloc(32, 3)}
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
            ratchet_anchor, ratchet_generation, last_step, enrol_session_id, created_at)
          VALUES (gen_random_uuid(), ${victim.userId}::uuid, 'totp', 'pending',
            ${Buffer.alloc(60, 4)}, ${Buffer.alloc(32, 5)}, 0, -1, ${v.sessionId}::uuid, now())`),
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
        (await completeSecondStep(writer, keys, v.token, { code: await freshCode(victim.userId) }))
          .ok,
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
