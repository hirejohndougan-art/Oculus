/**
 * Two-step sign-in (T-038, D-052, D-068, D-069, D-077): setting up a TOTP
 * authenticator at first sign-in, checking codes and recovery codes, making
 * a new set of recovery codes, re-entering the password with the second
 * step, and a system admin's reset. Tables and guards are
 * `0014_second_factors.sql`; TOTP, base32 and recovery-code rules are core's
 * `totp.ts`; the secret key is `secret-key.ts`.
 *
 * - **Required for everyone** (D-052, John). A session waiting for its second
 *   step whose person has no factor yet must set one up: `startEnrolment`
 *   (a new secret, shown once as base32 text and an `otpauth://` link for
 *   the QR code) and `confirmEnrolment` (a code from the app; then 10
 *   recovery codes, shown once, and the session becomes full). Everyone
 *   else completes sign-in with `completeSecondStep` (a code or a recovery
 *   code). There is no way to turn it off; a system admin can only reset it
 *   (`resetSecondFactor`), which ends the person's sessions and makes them
 *   set it up again at their next sign-in.
 * - **The secret** is sealed with `OCULUS_SECRET_KEY` (AES-256-GCM) and opened
 *   only here, for one check, then wiped. It is never returned (except once
 *   at set-up), logged or put into an error. Database errors reach
 *   `onError` only as their SQLSTATE and constraint (no message, detail or
 *   `where`, which can carry the values sent).
 * - **Codes:** RFC 6238, the database's clock, one step either side, never a
 *   step at or before the last one used; compared in constant time.
 * - **Throttled** per person (core's `SECOND_STEP_THROTTLE`: D-068's rules,
 *   counted up front, waits up to an hour, never a permanent lockout) and,
 *   at sign-in, per waiting session: after `MAX_PENDING_CODE_FAILURES` wrong
 *   codes the session is ended and the person signs in again.
 * - **Bound in the database** (0014): every success writes a pass in the
 *   same transaction as what it allows (promotion, the password entered
 *   again, new recovery codes, a reset), and the database refuses those
 *   without it. A pass needs the next link of the factor's TOTP ratchet
 *   (computed here from the secret) or a real unused recovery code. Two
 *   uses of one code race on the factor row: one wins, the other is
 *   `invalid_code`.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  MAX_PENDING_CODE_FAILURES,
  RECENT_AUTHENTICATION_SECONDS,
  hashSessionToken,
  newSessionToken,
  RECOVERY_CODE_COUNT,
  SECOND_STEP_THROTTLE,
  hashRecoveryCode,
  isOrganizationId,
  isUserId,
  matchTotpStep,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  encodeBase32,
  otpauthUri,
  throttleAttempt,
  type OrganizationId,
  type SessionId,
  type ThrottleState,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  signInChecked,
  type SignInFailure,
  type VerifiedSignIn,
} from "./accounts.js";
import type { Database, Queryable } from "./client.js";
import {
  passedSecondStep,
  secondStepGuardRefused,
  writeSecondStepPass,
  type PassMaterial,
} from "./second-step.js";
import {
  assertSecretKeyring,
  openSecret,
  sealSecret,
  sealedUnderOldKey,
  type SecretKeyring,
} from "./secret-key.js";
import {
  CODE_REFUSED,
  LIVE_FULL,
  NO_SESSION,
  callOptions,
  endAllSessionsForUser,
  failureFor,
  fullColumns,
  fullSession,
  hasOnly,
  inTransaction,
  own,
  promoteSession,
  readPendingSession,
  refused,
  refusedFor,
  resolveSession,
  tokenHash,
  type FullRow,
  type FullSession,
  type IssuedSession,
  type NoSession,
  type PromotionRefusal,
  type SessionCallOptions,
  type SessionFailure,
} from "./sessions.js";
import { sql } from "./sql.js";

/** The recent re-authentication window (10 minutes). */
const RECENT_SECONDS = RECENT_AUTHENTICATION_SECONDS;

/**
 * What the writer role needs on 0014's tables, beyond SELECT (D-067,
 * D-077): factors are inserted (set-up) and updated (the ratchet, confirming,
 * re-sealing, a reset; UPDATE is also what the pass trigger's `FOR UPDATE`
 * needs); passes are only inserted; recovery codes are inserted and updated
 * (used, superseded); the wrong-code counters as `sign_in_throttles`.
 * Nothing deletes a factor, a pass or a recovery code.
 */
export const SECOND_FACTOR_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    second_factors: Object.freeze(["INSERT", "UPDATE"]),
    second_step_passes: Object.freeze(["INSERT"]),
    second_step_recovery_codes: Object.freeze(["INSERT", "UPDATE"]),
    second_step_throttles: Object.freeze(["INSERT", "UPDATE", "DELETE"]),
  });

/** The issuer shown in authenticator apps unless the caller names another. */
export const DEFAULT_TOTP_ISSUER = "Oculus";

/** How many times one waiting session may start setting up a factor. */
export const MAX_ENROLMENT_STARTS = 5;

// ---------------------------------------------------------------------------
// Results

/** A refusal of the second step itself. */
export type SecondStepRefusal =
  | { readonly ok: false; readonly code: "invalid_code"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "throttled";
      readonly message: string;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly ok: false;
      /** Too many wrong codes for this sign-in: the session has ended. */
      readonly code: "too_many_attempts";
      readonly message: string;
    }
  | { readonly ok: false; readonly code: "enrolment_required"; readonly message: string }
  | { readonly ok: false; readonly code: "already_enrolled"; readonly message: string }
  | {
      readonly ok: false;
      /** The secret can't be opened (the server's key changed or is wrong): use a recovery code. */
      readonly code: "second_step_unavailable";
      readonly message: string;
    }
  | { readonly ok: false; readonly code: "invalid_request"; readonly message: string };

const INVALID_CODE = CODE_REFUSED as SecondStepRefusal;

const TOO_MANY: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "too_many_attempts",
  message: "Too many wrong codes. Sign in again.",
});

const ENROLMENT_REQUIRED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "enrolment_required",
  message: "Set up two-step sign-in with an authenticator app first.",
});

const ALREADY_ENROLLED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "already_enrolled",
  message: "Two-step sign-in is already set up for this account.",
});

const UNAVAILABLE: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "second_step_unavailable",
  message:
    "Codes from your authenticator app can't be checked just now. Use one of your recovery codes, or ask a system admin to reset your two-step sign-in.",
});

const INVALID_REQUEST: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "invalid_request",
  message: "Give the 6-digit code from your authenticator app, or one recovery code.",
});

function throttled(retryAfterSeconds: number): SecondStepRefusal {
  return {
    ok: false,
    code: "throttled",
    message: "Too many wrong codes. Wait a little and try again.",
    retryAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Errors for the log

/** A database error as the log may see it: SQLSTATE and constraint only. */
export class SecondStepDatabaseError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly constraint: string | undefined,
  ) {
    super(`Database error ${code ?? "(no SQLSTATE)"}${constraint ? ` (${constraint})` : ""}.`);
  }
}
SecondStepDatabaseError.prototype.name = "SecondStepDatabaseError";

function summarize(error: unknown): SecondStepDatabaseError {
  const fields =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof fields.code === "string" ? fields.code : undefined;
  const constraint = typeof fields.constraint === "string" ? fields.constraint : undefined;
  return new SecondStepDatabaseError(code, constraint);
}

/**
 * The call's options with `onError` seeing only a summary of each error: a
 * failed statement here may have carried a ratchet link or a recovery code
 * as a parameter, and pg's `where` and `detail` can repeat parameters
 * (D-068).
 */
function safeOptions(options: unknown, extra: readonly string[] = []): SessionCallOptions {
  const call = callOptions(options, extra);
  const onError = call.onError;
  return onError === undefined
    ? {}
    : {
        onError: (error) => {
          onError(summarize(error));
        },
      };
}

// ---------------------------------------------------------------------------
// Codes as given

type CodeInput =
  | { readonly kind: "totp"; readonly code: string }
  | { readonly kind: "recovery"; readonly code: string };

/** Exactly one of `code` (6 digits) or `recoveryCode`, or `undefined`. */
function codeInput(input: unknown): CodeInput | undefined {
  const code = own(input, "code");
  const recovery = own(input, "recoveryCode");
  if (code !== undefined && recovery === undefined) {
    const digits = normalizeTotpCode(code);
    return digits === undefined ? undefined : { kind: "totp", code: digits };
  }
  if (recovery !== undefined && code === undefined) {
    const canonical = normalizeRecoveryCode(recovery);
    return canonical === undefined ? undefined : { kind: "recovery", code: canonical };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factors and the ratchet

interface FactorRow {
  id: string;
  state: "pending" | "active";
  secret_box: Buffer;
  generation: string;
  last_step: string;
  enrol_session_id: string;
}

async function liveFactor(q: Queryable, userId: UserId): Promise<FactorRow | undefined> {
  const rows = await q.rows<FactorRow>(sql`
    SELECT id::text AS id, state, secret_box, ratchet_generation::text AS generation,
           last_step::text AS last_step, enrol_session_id::text AS enrol_session_id
    FROM public.second_factors WHERE user_id = ${userId}::uuid AND state <> 'revoked'`);
  return rows[0];
}

/** The additional data a factor's secret is sealed with. Not exported from `@oculus/db`. */
export function secretContext(factorId: string, userId: UserId): string {
  return `oculus totp secret v1\u0000${factorId}\u0000${userId}`;
}

/** The ratchet's link r_g for a factor (0014). Not exported from `@oculus/db`. */
export function ratchetLink(secret: Uint8Array, factorId: string, generation: bigint): Buffer {
  return createHmac("sha256", secret)
    .update(`oculus second step ratchet v1\u0000${factorId}\u0000${generation.toString()}`, "utf8")
    .digest();
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** The current TOTP step by the database's clock (D-052: one clock decides). */
async function stepNow(q: Queryable): Promise<bigint> {
  const rows = await q.rows<{ step: string }>(sql`SELECT public.totp_step_now()::text AS step`);
  const step = rows[0]?.step;
  if (step === undefined) throw new Error("The database gave no time.");
  return BigInt(step);
}

type Verified =
  | { readonly ok: true; readonly pass: PassMaterial }
  | { readonly ok: false; readonly why: "wrong" | "unavailable" };

/** Checks a code against a factor; on success, the pass for the database. Wipes the secret. */
async function verifyCode(
  db: Queryable,
  keys: SecretKeyring,
  userId: UserId,
  factor: FactorRow,
  input: CodeInput,
): Promise<Verified> {
  if (input.kind === "recovery") {
    const found = await db.rows(sql`
      SELECT 1 FROM public.second_step_recovery_codes c
      WHERE c.user_id = ${userId}::uuid AND c.factor_id = ${factor.id}::uuid
        AND c.code_hash = ${hashRecoveryCode(input.code)}
        AND c.used_at IS NULL AND c.superseded_at IS NULL`);
    if (factor.state !== "active" || found.length !== 1) return { ok: false, why: "wrong" };
    return { ok: true, pass: { method: "recovery", factorId: factor.id, code: input.code } };
  }
  const secret = openSecret(keys, factor.secret_box, secretContext(factor.id, userId));
  if (secret === undefined) return { ok: false, why: "unavailable" };
  try {
    const now = await stepNow(db);
    const step = matchTotpStep(secret, input.code, now, BigInt(factor.last_step));
    if (step === undefined) return { ok: false, why: "wrong" };
    const generation = BigInt(factor.generation);
    return {
      ok: true,
      pass: {
        method: "totp",
        factorId: factor.id,
        step,
        reveal: ratchetLink(secret, factor.id, generation),
        nextAnchor: sha256(ratchetLink(secret, factor.id, generation + 1n)),
      },
    };
  } finally {
    secret.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Throttling (core's SECOND_STEP_THROTTLE, D-068's way of counting)

interface Who {
  readonly userId: UserId;
  /** The session waiting for its second step, at sign-in only. */
  readonly pendingSessionId?: SessionId;
}

function keysFor(who: Who): string[] {
  const keys = [`user:${who.userId}`];
  if (who.pendingSessionId !== undefined) keys.push(`session:${who.pendingSessionId}`);
  return keys.sort();
}

type Attempt =
  | { readonly allowed: true; readonly sessionFailures: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly exhausted: true };

/**
 * Counts this attempt up front against the person's counter (and the
 * waiting session's), in one short transaction with both rows locked in
 * key order, so codes sent at once are counted one by one; or says how long
 * to wait. An attempt during a wait is not counted (D-068).
 */
async function takeCodeAttempt(db: Database, who: Who): Promise<Attempt> {
  const userKey = `user:${who.userId}`;
  const sessionKey =
    who.pendingSessionId === undefined ? undefined : `session:${who.pendingSessionId}`;
  const keys = keysFor(who);
  for (let round = 1; ; round++) {
    const decided = await inTransaction(db, async (tx): Promise<Attempt | "row_gone"> => {
      for (const key of keys) {
        await tx.execute(sql`
          INSERT INTO public.second_step_throttles (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`);
      }
      const rows = await tx.rows<{ key: string; failures: number; last_ms: number | null }>(sql`
        SELECT key, failures, (extract(epoch FROM last_failure_at) * 1000)::float8 AS last_ms
        FROM public.second_step_throttles WHERE key = ANY(${keys}::text[])
        ORDER BY key FOR UPDATE`);
      if (rows.length !== keys.length) return "row_gone";
      const clock = await tx.rows<{ now_ms: number }>(sql`
        SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`);
      const now = clock[0]?.now_ms;
      if (now === undefined) throw new Error("The database gave no time.");
      const userRow = rows.find((r) => r.key === userKey);
      const sessionRow = rows.find((r) => r.key === sessionKey);
      if (sessionRow !== undefined && sessionRow.failures >= MAX_PENDING_CODE_FAILURES) {
        return { allowed: false, exhausted: true };
      }
      const state: ThrottleState | undefined =
        userRow === undefined
          ? undefined
          : { failures: userRow.failures, lastFailureAt: userRow.last_ms };
      const decision = throttleAttempt(SECOND_STEP_THROTTLE, state, now);
      if (!decision.allowed)
        return { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
      await tx.execute(sql`
        UPDATE public.second_step_throttles
        SET failures = ${decision.next.failures},
            last_failure_at = to_timestamp(${decision.next.lastFailureAt}::float8 / 1000)
        WHERE key = ${userKey}`);
      let sessionFailures = 0;
      if (sessionKey !== undefined) {
        sessionFailures = (sessionRow?.failures ?? 0) + 1;
        await tx.execute(sql`
          UPDATE public.second_step_throttles
          SET failures = ${sessionFailures}, last_failure_at = clock_timestamp()
          WHERE key = ${sessionKey}`);
      }
      return { allowed: true, sessionFailures };
    });
    if (decided !== "row_gone") return decided;
    if (round >= 3) return { allowed: false, retryAfterSeconds: 1 };
  }
}

/** A right code: the counters start again. */
async function clearCodeAttempts(db: Queryable, who: Who): Promise<void> {
  await db.execute(
    sql`DELETE FROM public.second_step_throttles WHERE key = ANY(${keysFor(who)}::text[])`,
  );
}

/** An attempt counted up front whose code couldn't be checked (the secret didn't open). */
async function giveBackCodeAttempt(db: Queryable, who: Who): Promise<void> {
  await db.execute(sql`
    UPDATE public.second_step_throttles SET failures = greatest(failures - 1, 0)
    WHERE key = ANY(${keysFor(who)}::text[])`);
}

/** Ends a waiting session after its last allowed wrong code. */
async function endPending(db: Queryable, sessionId: SessionId): Promise<void> {
  await db.execute(sql`
    DELETE FROM public.sessions WHERE id = ${sessionId}::uuid AND stage = 'second_step'`);
}

/** After a wrong code (already counted): `invalid_code`, or the session ends. */
async function wrongCode(
  db: Queryable,
  who: Who,
  sessionFailures: number,
): Promise<SecondStepRefusal> {
  if (who.pendingSessionId !== undefined && sessionFailures >= MAX_PENDING_CODE_FAILURES) {
    await endPending(db, who.pendingSessionId);
    return TOO_MANY;
  }
  return INVALID_CODE;
}

type Checked =
  | { readonly ok: true; readonly pass: PassMaterial; readonly sessionFailures: number }
  | SecondStepRefusal;

/** The throttle, then the code. On success the counters are left for the caller to clear once the pass is in. */
async function checkCode(
  db: Database,
  keys: SecretKeyring,
  who: Who,
  factor: FactorRow,
  input: CodeInput,
): Promise<Checked> {
  const attempt = await takeCodeAttempt(db, who);
  if (!attempt.allowed) {
    if ("exhausted" in attempt) {
      if (who.pendingSessionId !== undefined) await endPending(db, who.pendingSessionId);
      return TOO_MANY;
    }
    return throttled(attempt.retryAfterSeconds);
  }
  const verified = await verifyCode(db, keys, who.userId, factor, input);
  if (verified.ok)
    return { ok: true, pass: verified.pass, sessionFailures: attempt.sessionFailures };
  if (verified.why === "unavailable") {
    await giveBackCodeAttempt(db, who);
    return UNAVAILABLE;
  }
  return wrongCode(db, who, attempt.sessionFailures);
}

// ---------------------------------------------------------------------------
// Completing sign-in

/** What `completeSecondStep` takes: one code, and the organization if one must be chosen. */
export interface SecondStepInput {
  /** The 6 digits from the authenticator app (spaces allowed). */
  readonly code?: string;
  /** Or one recovery code. */
  readonly recoveryCode?: string;
  /** The organization to work in, if the person must choose (`choose_organization`). */
  readonly organizationId?: OrganizationId;
}

/**
 * Completes a sign-in: checks a TOTP code or a recovery code for the person
 * whose session `token` is waiting for its second step, and makes the
 * session full, with a **new token**. A recovery code is used up.
 * Refusals: `invalid_code`, `throttled`, `too_many_attempts` (the session
 * ended), `enrolment_required` (set it up first), `second_step_unavailable`
 * (the secret key can't open the secret: use a recovery code),
 * `invalid_request`, and promotion's own (`choose_organization` and the
 * rest: nothing is used up then, so send the same code again with the
 * organization).
 */
export async function completeSecondStep(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  input: SecondStepInput,
  options: SessionCallOptions = {},
): Promise<
  IssuedSession<FullSession> | NoSession | PromotionRefusal | SecondStepRefusal | SessionFailure
> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!hasOnly(input, ["code", "recoveryCode", "organizationId"])) return INVALID_REQUEST;
  const code = codeInput(input);
  const organizationId = own(input, "organizationId");
  if (code === undefined || (organizationId !== undefined && !isOrganizationId(organizationId))) {
    return INVALID_REQUEST;
  }
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    const who: Who = { userId, pendingSessionId: sessionId };
    const factor = await liveFactor(db, userId);
    if (factor?.state !== "active") return ENROLMENT_REQUIRED;
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return checked;
    const proof = passedSecondStep(sessionId, userId, checked.pass);
    const done = await promoteSession(
      db,
      token,
      proof,
      organizationId === undefined ? {} : { organizationId },
      call,
    );
    if (!done.ok && done.code === "invalid_code") {
      return await wrongCode(db, who, checked.sessionFailures);
    }
    if (
      done.ok ||
      done.code === "choose_organization" ||
      done.code === "organization_required" ||
      done.code === "not_permitted"
    ) {
      await clearCodeAttempts(db, who);
    }
    return done;
  } catch (error) {
    return failureFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// Setting up at first sign-in

/** What `startEnrolment` gives, once: the new secret for the authenticator app. */
export interface EnrolmentStart {
  readonly ok: true;
  /** The secret as base32 text, for typing into the app. Shown once; never stored or logged. */
  readonly secret: string;
  /** The `otpauth://` link, for the QR code (T-045 renders it). Holds the secret. */
  readonly otpauthUri: string;
}

/** Options for `startEnrolment`. */
export interface EnrolmentOptions extends SessionCallOptions {
  /** Shown in the app as the issuer (no `:`): "Oculus" by default. */
  readonly issuer?: string;
}

/**
 * Starts setting up two-step sign-in for the person whose session `token`
 * is waiting for its second step and who has no factor in use: a new
 * 160-bit secret, sealed and stored as pending, returned once as base32
 * text and an `otpauth://` link. Starting again replaces an unconfirmed one
 * (at most `MAX_ENROLMENT_STARTS` per waiting session). Refuses with
 * `already_enrolled` if a factor is in use.
 */
export async function startEnrolment(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  options: EnrolmentOptions = {},
): Promise<EnrolmentStart | NoSession | SecondStepRefusal | SessionFailure> {
  assertSecretKeyring(keys);
  const call = safeOptions(options, ["issuer"]);
  const issuer = own(options, "issuer") ?? DEFAULT_TOTP_ISSUER;
  if (typeof issuer !== "string") throw new TypeError("issuer is text.");
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    const secret = newTotpSecret();
    try {
      const factorId = randomUUID();
      const box = sealSecret(keys, secret, secretContext(factorId, userId));
      const anchor = sha256(ratchetLink(secret, factorId, 0n));
      const made = await inTransaction(db, async (tx) => {
        // One set-up at a time per person.
        const users = await tx.rows<{ email: string }>(sql`
          SELECT email FROM public.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`);
        const email = users[0]?.email;
        if (email === undefined) return NO_SESSION;
        const existing = await tx.rows<{ state: string; starts: number }>(sql`
          SELECT (SELECT state FROM public.second_factors
                  WHERE user_id = ${userId}::uuid AND state <> 'revoked') AS state,
                 (SELECT count(*)::int FROM public.second_factors
                  WHERE enrol_session_id = ${sessionId}::uuid) AS starts`);
        if (existing[0]?.state === "active") return ALREADY_ENROLLED;
        if ((existing[0]?.starts ?? 0) >= MAX_ENROLMENT_STARTS) return TOO_MANY;
        await tx.execute(sql`
          UPDATE public.second_factors SET state = 'revoked'
          WHERE user_id = ${userId}::uuid AND state = 'pending'`);
        await tx.execute(sql`
          INSERT INTO public.second_factors
            (id, user_id, kind, state, secret_box, ratchet_anchor, ratchet_generation, last_step,
             enrol_session_id, created_at)
          VALUES (${factorId}::uuid, ${userId}::uuid, 'totp', 'pending', ${box}, ${anchor}, 0, -1,
                  ${sessionId}::uuid, clock_timestamp())`);
        return { email };
      });
      if (!("email" in made)) return made;
      return {
        ok: true,
        secret: encodeBase32(secret),
        otpauthUri: otpauthUri(secret, { issuer, account: made.email }),
      };
    } finally {
      secret.fill(0);
    }
  } catch (error) {
    // The session ended or the account changed between the read and the insert.
    if (secondStepGuardRefused(error) || sessionGuardOf(error)) return NO_SESSION;
    return failureFor(error, call);
  }
}

function sessionGuardOf(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { constraint } = error as { constraint?: unknown };
  return constraint === "second_factors_new_session" || constraint === "second_factors_one_live";
}

/** A finished set-up: the full session and the recovery codes, shown once. */
export interface EnrolmentDone extends IssuedSession<FullSession> {
  /** 10 single-use recovery codes, formatted. Shown once; only their hashes are stored. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Finishes setting up: checks a code from the app against the secret
 * `startEnrolment` gave this same waiting session, then in one transaction
 * makes the factor active, stores 10 new recovery codes (hashed) and makes
 * the session full with a new token. The codes are returned once.
 * `choose_organization` and the like leave everything as it was: send the
 * same code again with the organization.
 */
export async function confirmEnrolment(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  input: { readonly code: string; readonly organizationId?: OrganizationId },
  options: SessionCallOptions = {},
): Promise<EnrolmentDone | NoSession | PromotionRefusal | SecondStepRefusal | SessionFailure> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!hasOnly(input, ["code", "organizationId"])) return INVALID_REQUEST;
  const code = codeInput(input);
  const organizationId = own(input, "organizationId");
  if (
    code?.kind !== "totp" ||
    (organizationId !== undefined && !isOrganizationId(organizationId))
  ) {
    return INVALID_REQUEST;
  }
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    const who: Who = { userId, pendingSessionId: sessionId };
    const factor = await liveFactor(db, userId);
    if (factor?.state === "active") return ALREADY_ENROLLED;
    if (factor?.enrol_session_id !== sessionId) return ENROLMENT_REQUIRED;
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return checked;
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    const proof = passedSecondStep(sessionId, userId, checked.pass, (tx) =>
      storeRecoveryCodes(tx, userId, factor.id, recoveryCodes),
    );
    const done = await promoteSession(
      db,
      token,
      proof,
      organizationId === undefined ? {} : { organizationId },
      call,
    );
    if (!done.ok && done.code === "invalid_code") {
      return await wrongCode(db, who, checked.sessionFailures);
    }
    if (!done.ok) {
      if (done.code === "choose_organization" || done.code === "organization_required") {
        await clearCodeAttempts(db, who);
      }
      return done;
    }
    await clearCodeAttempts(db, who);
    return { ...done, recoveryCodes: Object.freeze(recoveryCodes) };
  } catch (error) {
    return failureFor(error, call);
  }
}

/** Stores a new set of recovery codes (hashed); the database supersedes the old set. */
async function storeRecoveryCodes(
  tx: Queryable,
  userId: UserId,
  factorId: string,
  codes: readonly string[],
): Promise<void> {
  const setId = randomUUID();
  for (const code of codes) {
    const canonical = normalizeRecoveryCode(code);
    if (canonical === undefined) throw new Error("A new recovery code didn't read back.");
    await tx.execute(sql`
      INSERT INTO public.second_step_recovery_codes
        (user_id, factor_id, set_id, code_hash, created_at, created_xact)
      VALUES (${userId}::uuid, ${factorId}::uuid, ${setId}::uuid, ${hashRecoveryCode(canonical)},
              clock_timestamp(), pg_current_xact_id())`);
  }
}

// ---------------------------------------------------------------------------
// From a full session

/** Thrown inside a transaction to roll it back; never leaves this module. */
class RollBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back");
  }
}

/**
 * Writes a pass for `who` in a transaction and runs `then` in it, mapping a
 * refused pass (a code used meanwhile) to a wrong code. The counters are
 * cleared on success.
 */
async function withPass<T>(
  db: Database,
  who: Who,
  checked: { readonly pass: PassMaterial; readonly sessionFailures: number },
  pass: {
    readonly sessionId: SessionId;
    readonly purpose: "reauth" | "recovery_codes" | "admin_reset";
    readonly targetUserId?: UserId;
  },
  then: (tx: Queryable, passId: string) => Promise<T>,
): Promise<T | SecondStepRefusal> {
  try {
    const result = await inTransaction(db, async (tx) => {
      const passId = await writeSecondStepPass(
        tx,
        {
          userId: who.userId,
          sessionId: pass.sessionId,
          purpose: pass.purpose,
          ...(pass.targetUserId === undefined ? {} : { targetUserId: pass.targetUserId }),
        },
        checked.pass,
      );
      return then(tx, passId);
    });
    await clearCodeAttempts(db, who);
    return result;
  } catch (error) {
    if (secondStepGuardRefused(error)) return wrongCode(db, who, checked.sessionFailures);
    throw error;
  }
}

/** What `reauthenticate` takes: the password, the client address, and the second step. */
export interface ReauthenticationInput {
  readonly password: string;
  readonly source: string;
  readonly code?: string;
  readonly recoveryCode?: string;
}

/**
 * Records that the person entered their password **and** passed the second
 * step again in this session, for a sensitive change (D-052, ASVS 5.0
 * 7.5.1), and gives the session a **new token** (the old one stops). The
 * password is checked as at sign-in (`signIn`'s throttle and failures are
 * passed on); only then the code, with its own throttle. The database
 * records the re-entry only with a pass for this session made in the same
 * transaction (0014). Afterwards `resolveSession` gives
 * `recentlyAuthenticated: true` for the window asked.
 */
export async function reauthenticate(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  input: ReauthenticationInput,
  options: SessionCallOptions = {},
): Promise<
  IssuedSession<FullSession> | NoSession | SignInFailure | SecondStepRefusal | SessionFailure
> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  if (!hasOnly(input, ["password", "source", "code", "recoveryCode"])) return NO_SESSION;
  const code = codeInput(input);
  if (code === undefined) return INVALID_REQUEST;
  const newToken = newSessionToken();
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return current;
    const { userId, sessionId, organizationId } = current.session;
    const users = await db.rows<{ email: string }>(sql`
      SELECT email FROM public.users WHERE id = ${userId}::uuid`);
    const email = users[0]?.email;
    if (email === undefined) return NO_SESSION;
    const out: { verified?: VerifiedSignIn } = {};
    const checkedPassword = await signInChecked(
      db,
      {
        email,
        password: own(input, "password") as string,
        source: own(input, "source") as string,
        organizationId,
      },
      out,
    );
    if (!checkedPassword.ok) return checkedPassword;
    const verified = out.verified;
    if (checkedPassword.userId !== userId || verified === undefined) return NO_SESSION;
    const factor = await liveFactor(db, userId);
    if (factor?.state !== "active") return ENROLMENT_REQUIRED;
    const who: Who = { userId };
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return checked;
    try {
      return await withPass(
        db,
        who,
        checked,
        { sessionId, purpose: "reauth" },
        async (tx, passId) => {
          // Stamped only if the password checked is still the account's and no
          // "end all" came in between (T-037's second review, R1).
          const rows = await tx.rows<FullRow>(sql`
          UPDATE public.sessions s
          SET password_at = clock_timestamp(), last_seen_at = clock_timestamp(),
              token_hash = ${hashSessionToken(newToken)}, rotated_at = clock_timestamp(),
              reauth_pass = ${passId}::uuid
          FROM public.users u
          WHERE s.token_hash = ${hash} AND s.id = ${sessionId}::uuid AND ${LIVE_FULL}
            AND u.password_hash = ${verified.passwordHash}
            AND u.sessions_valid_after = ${verified.sessionsValidAfter}::timestamptz
          RETURNING ${fullColumns(RECENT_SECONDS)}`);
          const row = rows[0];
          if (row === undefined) throw new RollBack(undefined);
          return { ok: true, token: newToken, session: fullSession(row) } as const;
        },
      );
    } catch (error) {
      if (!(error instanceof RollBack)) throw error;
      // Either the session ended or the password changed under it.
      const alive = await db.rows(sql`
        SELECT 1 FROM public.sessions s JOIN public.users u ON u.id = s.user_id
        WHERE s.token_hash = ${hash} AND ${LIVE_FULL}`);
      return alive.length === 1 ? INVALID_CREDENTIALS : NO_SESSION;
    }
  } catch (error) {
    return failureFor(error, call);
  }
}

/**
 * A new set of 10 recovery codes for the signed-in person, after a code (or
 * one of their current recovery codes); the old set stops working at once.
 * Returned once; only hashes are stored.
 */
export async function regenerateRecoveryCodes(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  input: { readonly code?: string; readonly recoveryCode?: string },
  options: SessionCallOptions = {},
): Promise<
  | { readonly ok: true; readonly recoveryCodes: readonly string[] }
  | NoSession
  | SecondStepRefusal
  | SessionFailure
> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!hasOnly(input, ["code", "recoveryCode"])) return INVALID_REQUEST;
  const code = codeInput(input);
  if (code === undefined) return INVALID_REQUEST;
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return current;
    const { userId, sessionId } = current.session;
    const factor = await liveFactor(db, userId);
    if (factor?.state !== "active") return ENROLMENT_REQUIRED;
    const who: Who = { userId };
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return checked;
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    return await withPass(
      db,
      who,
      checked,
      { sessionId, purpose: "recovery_codes" },
      async (tx) => {
        await storeRecoveryCodes(tx, userId, factor.id, recoveryCodes);
        return { ok: true, recoveryCodes: Object.freeze(recoveryCodes) } as const;
      },
    );
  } catch (error) {
    return failureFor(error, call);
  }
}

/** What the person's own settings screen shows. */
export interface SecondFactorStatus {
  readonly ok: true;
  readonly enrolled: boolean;
  /** When it was set up (core's ISO form), if it is. */
  readonly enrolledAt: string | null;
  /** Unused codes of the current set. */
  readonly recoveryCodesLeft: number;
}

/** Whether the signed-in person has two-step sign-in set up, and how many recovery codes are left. */
export async function secondFactorStatus(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<SecondFactorStatus | NoSession | SessionFailure> {
  const call = safeOptions(options);
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return current;
    const rows = await db.rows<{ enrolled_at: string | null; left: number }>(sql`
      SELECT to_char(f.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS enrolled_at,
             (SELECT count(*)::int FROM public.second_step_recovery_codes c
              WHERE c.factor_id = f.id AND c.used_at IS NULL AND c.superseded_at IS NULL) AS left
      FROM public.second_factors f
      WHERE f.user_id = ${current.session.userId}::uuid AND f.state = 'active'`);
    const row = rows[0];
    return Object.freeze({
      ok: true,
      enrolled: row !== undefined,
      enrolledAt: row?.enrolled_at ?? null,
      recoveryCodesLeft: row?.left ?? 0,
    });
  } catch (error) {
    return failureFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// A system admin's reset

/**
 * Resets `targetUserId`'s two-step sign-in (D-019, D-052): their factor is
 * revoked, their recovery codes stop working, their wrong-code counter is
 * cleared, and **every session of theirs ends**; at their next sign-in they
 * set it up again. For a system admin acting from their own full session
 * (`adminToken`), who entered their password and second step in the last
 * 10 minutes (`reauthentication_required`) **and** gives a code (or
 * recovery code) of their own now: the database revokes a factor in use
 * only with a system admin's pass for that person made in the same
 * transaction (0014). Returns whether there was a factor and how many
 * sessions ended.
 */
export async function resetSecondFactor(
  db: Database,
  keys: SecretKeyring,
  adminToken: unknown,
  targetUserId: unknown,
  input: { readonly code?: string; readonly recoveryCode?: string },
  options: SessionCallOptions = {},
): Promise<Validated<{ readonly reset: boolean; readonly ended: number }>> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!isUserId(targetUserId)) return refused("invalid_request", "That isn't a user ID.");
  if (!hasOnly(input, ["code", "recoveryCode"]))
    return refused(INVALID_REQUEST.code, INVALID_REQUEST.message);
  const code = codeInput(input);
  if (code === undefined) return refused(INVALID_REQUEST.code, INVALID_REQUEST.message);
  const hash = tokenHash(adminToken);
  if (hash === undefined) return refused(NO_SESSION.code, NO_SESSION.message);
  try {
    // Read, not refreshed or locked, as endUserSessions does (T-037's second review, item 1).
    const admins = await db.rows<{
      id: SessionId;
      user_id: UserId;
      system_admin: boolean;
      recent: boolean;
    }>(sql`
      SELECT s.id::text AS id, s.user_id::text AS user_id, u.system_admin,
             s.password_at > clock_timestamp() - make_interval(secs => ${RECENT_SECONDS}) AS recent
      FROM public.sessions s JOIN public.users u ON u.id = s.user_id
      WHERE s.token_hash = ${hash} AND ${LIVE_FULL}`);
    const admin = admins[0];
    if (admin === undefined) return refused(NO_SESSION.code, NO_SESSION.message);
    const known = await db.rows(sql`SELECT 1 FROM public.users WHERE id = ${targetUserId}::uuid`);
    if (!admin.system_admin) return refused("not_permitted", "Only a system admin can do that.");
    if (!admin.recent) {
      return refused(
        "reauthentication_required",
        "Enter your password and code again to reset someone's two-step sign-in.",
      );
    }
    if (known.length !== 1) return refused("unknown_user", "There is no such user.");
    const factor = await liveFactor(db, admin.user_id);
    if (factor?.state !== "active")
      return refused(ENROLMENT_REQUIRED.code, ENROLMENT_REQUIRED.message);
    const who: Who = { userId: admin.user_id };
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return refused(checked.code, checked.message);
    const done = await withPass(
      db,
      who,
      checked,
      { sessionId: admin.id, purpose: "admin_reset", targetUserId },
      async (tx, passId) => {
        // The target's row first, as every path that ends sessions does.
        const target = await tx.rows(sql`
          SELECT 1 FROM public.users WHERE id = ${targetUserId}::uuid FOR NO KEY UPDATE`);
        if (target.length !== 1) throw new RollBack("unknown_user");
        const ended = await endAllSessionsForUser(tx, targetUserId);
        const reset = await tx.execute(sql`
          UPDATE public.second_factors
          SET state = 'revoked',
              revoked_by_pass = CASE WHEN state = 'active' THEN ${passId}::uuid END
          WHERE user_id = ${targetUserId}::uuid AND state <> 'revoked'`);
        await tx.execute(sql`
          DELETE FROM public.second_step_throttles WHERE key = ${`user:${targetUserId}`}`);
        return { ok: true as const, value: { reset: reset > 0, ended } };
      },
    );
    if (!done.ok) return refused(done.code, done.message);
    return done;
  } catch (error) {
    if (error instanceof RollBack) return refused("unknown_user", "There is no such user.");
    return refusedFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// Key rotation

/** What `resealSecondFactorSecrets` did. */
export interface ResealResult {
  /** Secrets moved to the current key. */
  readonly resealed: number;
  /** Secrets no loaded key opens: those people need a recovery code or a reset. */
  readonly unreadable: number;
}

/**
 * Re-seals every factor's secret that isn't under the current key yet, for
 * key rotation (secret-key.ts). Each is changed only if it is still the box
 * read. Run it as the writer role after setting the new key, with the old
 * one in `OCULUS_SECRET_KEY_PREVIOUS`, until `resealed` is 0. Database
 * errors are thrown (it is an operator's command).
 */
export async function resealSecondFactorSecrets(
  db: Database,
  keys: SecretKeyring,
): Promise<ResealResult> {
  assertSecretKeyring(keys);
  const rows = await db.rows<{ id: string; user_id: UserId; secret_box: Buffer }>(sql`
    SELECT id::text AS id, user_id::text AS user_id, secret_box
    FROM public.second_factors WHERE state <> 'revoked' ORDER BY id`);
  let resealed = 0;
  let unreadable = 0;
  for (const row of rows) {
    if (!sealedUnderOldKey(keys, row.secret_box)) continue;
    const context = secretContext(row.id, row.user_id);
    const secret = openSecret(keys, row.secret_box, context);
    if (secret === undefined) {
      unreadable += 1;
      continue;
    }
    try {
      resealed += await db.execute(sql`
        UPDATE public.second_factors SET secret_box = ${sealSecret(keys, secret, context)}
        WHERE id = ${row.id}::uuid AND secret_box = ${row.secret_box} AND state <> 'revoked'`);
    } finally {
      secret.fill(0);
    }
  }
  return Object.freeze({ resealed, unreadable });
}
