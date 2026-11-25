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
 *   (`resetSecondFactor`), which ends the person's sessions and sends them a
 *   one-time enrolment link without which they can't set it up again.
 * - **The secret** is sealed with `OCULUS_SECRET_KEY` (AES-256-GCM) and opened
 *   only here, for one check, then wiped. It is never returned (except once
 *   at set-up), logged or put into an error. Database errors reach
 *   `onError` only as their SQLSTATE and constraint (no message, detail or
 *   `where`, which can carry the values sent).
 * - **Codes:** RFC 6238, the database's clock, one step either side, never a
 *   step at or before the last one used; compared in constant time.
 * - **Throttled** (D-077): TOTP codes per person (core's
 *   `SECOND_STEP_THROTTLE`, waits up to 15 minutes, never a permanent
 *   lockout, each wait recorded in `second_step_alerts` for a notice);
 *   wrong TOTP codes no right code in the same session explained are kept
 *   for 30 days (`wrong:<user>`), and the next sign-in's first code records
 *   an alert for them (S-045), so a few guesses a day are told too;
 *   every code, recovery codes included, per session (a waiting session
 *   ends after 5 wrong codes, a full one is signed out) and per client
 *   address. Recovery codes (120 bits) skip the per-person counter, so
 *   someone guessing TOTP codes with the password can't keep the person out.
 * - **Bound in the database** (0014): every success writes a pass in the
 *   same transaction as what it allows (promotion, the password entered
 *   again, new recovery codes, a reset), and the database refuses those
 *   without it. A pass needs the next link back of the factor's hash chain
 *   (computed here from the secret) or a real unused recovery code. Two
 *   uses of one code race on the factor row: one wins; the loser is told
 *   the code was used, and isn't counted as a wrong guess.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  MAX_PENDING_CODE_FAILURES,
  RECENT_AUTHENTICATION_SECONDS,
  RECOVERY_CODE_COUNT,
  SECOND_STEP_THROTTLE,
  SOURCE_THROTTLE,
  encodeBase32,
  hashRecoveryCode,
  hashSessionToken,
  isOrganizationId,
  isUserId,
  matchTotpStep,
  newRecoveryCode,
  newSessionToken,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  otpauthUri,
  throttleAttempt,
  throttleSourceKey,
  type OrganizationId,
  type SessionId,
  type ThrottleDecision,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  markKnownSource,
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
  isMemberIn,
  memberOfOption,
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
 * D-077): factors are inserted (set-up) and updated (the chain, confirming,
 * re-sealing, a reset; UPDATE is also what the pass trigger's `FOR UPDATE`
 * needs); passes and alerts are only inserted; recovery codes and enrolment
 * tokens are inserted and updated (used, superseded); the wrong-code
 * counters as `sign_in_throttles`. Nothing deletes a factor, a pass, a
 * recovery code, a token or an alert.
 */
export const SECOND_FACTOR_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    second_factors: Object.freeze(["INSERT", "UPDATE"]),
    second_step_passes: Object.freeze(["INSERT"]),
    second_step_recovery_codes: Object.freeze(["INSERT", "UPDATE"]),
    second_step_throttles: Object.freeze(["INSERT", "UPDATE", "DELETE"]),
    second_step_alerts: Object.freeze(["INSERT"]),
    second_step_enrolment_tokens: Object.freeze(["INSERT", "UPDATE"]),
  });

/** The issuer shown in authenticator apps unless the caller names another. */
export const DEFAULT_TOTP_ISSUER = "Oculus";

/** How many times one waiting session may start setting up a factor. */
export const MAX_ENROLMENT_STARTS = 5;

/**
 * Links in a new factor's hash chain: how many TOTP passes (sign-ins and
 * re-entries) it takes before it is used up. 20,000 is about 5 years at 10 a
 * day; computing a link costs at most 20,000 SHA-256 runs (about 50 ms).
 */
export const TOTP_CHAIN_LENGTH = 20_000;

/** How long an enrolment link after a reset works. */
export const ENROLMENT_TOKEN_SECONDS = 3 * 24 * 60 * 60;

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
      /** Too many wrong codes in this session: it has ended. */
      readonly code: "too_many_attempts";
      readonly message: string;
    }
  | { readonly ok: false; readonly code: "enrolment_required"; readonly message: string }
  | {
      readonly ok: false;
      /** After a reset: the one-time enrolment link sent to the person is needed. */
      readonly code: "enrolment_token_required";
      readonly message: string;
    }
  | { readonly ok: false; readonly code: "already_enrolled"; readonly message: string }
  | {
      readonly ok: false;
      /** Enter the password and a code again first (the last 10 minutes). */
      readonly code: "reauthentication_required";
      readonly message: string;
    }
  | {
      readonly ok: false;
      /** The secret can't be opened (key changed or wrong) or its chain is used up: use a recovery code. */
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

const TOO_MANY_STARTS: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "too_many_attempts",
  message: "Too many tries at setting up. Sign in again.",
});

const ENROLMENT_REQUIRED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "enrolment_required",
  message: "Set up two-step sign-in with an authenticator app first.",
});

const ENROLMENT_TOKEN_REQUIRED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "enrolment_token_required",
  message:
    "Your two-step sign-in was reset. Open the set-up link sent to your email address to set it up again.",
});

const ALREADY_ENROLLED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "already_enrolled",
  message: "Two-step sign-in is already set up for this account.",
});

const REAUTHENTICATION_REQUIRED: SecondStepRefusal = Object.freeze({
  ok: false,
  code: "reauthentication_required",
  message: "Enter your password and a code again first.",
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
  message:
    "Give the 6-digit code from your authenticator app, or one recovery code, and the client address.",
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
 * failed statement here may have carried a chain link, a recovery code or
 * an enrolment token as a parameter, and pg's `where` and `detail` can
 * repeat parameters (D-068).
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

/** The client address as given (a string up to 100 characters), or `undefined`. */
function sourceOf(input: unknown): string | undefined {
  const source = own(input, "source");
  return typeof source === "string" && source.length <= 100 ? source : undefined;
}

// ---------------------------------------------------------------------------
// Factors and the hash chain

interface FactorRow {
  id: string;
  state: "pending" | "active";
  secret_box: Buffer;
  generation: string;
  chain_length: number;
  last_step: string;
  enrol_session_id: string;
}

async function liveFactor(q: Queryable, userId: UserId): Promise<FactorRow | undefined> {
  const rows = await q.rows<FactorRow>(sql`
    SELECT id::text AS id, state, secret_box, ratchet_generation::text AS generation,
           chain_length, last_step::text AS last_step, enrol_session_id::text AS enrol_session_id
    FROM public.second_factors WHERE user_id = ${userId}::uuid AND state <> 'revoked'`);
  return rows[0];
}

/** The additional data a factor's secret is sealed with. Not exported from `@oculus/db`. */
export function secretContext(factorId: string, userId: UserId): string {
  return `oculus totp secret v1\u0000${factorId}\u0000${userId}`;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/**
 * Link `k` of a factor's hash chain (0014): L_0 = HMAC-SHA-256(secret,
 * label ‖ factor), L_{k+1} = SHA-256(L_k). The factor stores L_N at set-up;
 * the pass after `g` earlier ones reveals L_{N-g-1}. Not exported from
 * `@oculus/db`.
 */
export function chainLink(secret: Uint8Array, factorId: string, k: number): Buffer {
  let link: Buffer = createHmac("sha256", secret)
    .update(`oculus second step chain v1\u0000${factorId}`, "utf8")
    .digest();
  for (let i = 0; i < k; i++) link = sha256(link);
  return link;
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
  const left = factor.chain_length - Number(factor.generation);
  if (left < 1) return { ok: false, why: "unavailable" };
  const secret = openSecret(keys, factor.secret_box, secretContext(factor.id, userId));
  if (secret === undefined) return { ok: false, why: "unavailable" };
  try {
    const now = await stepNow(db);
    const step = matchTotpStep(secret, input.code, now, BigInt(factor.last_step));
    if (step === undefined) return { ok: false, why: "wrong" };
    return {
      ok: true,
      pass: {
        method: "totp",
        factorId: factor.id,
        step,
        reveal: chainLink(secret, factor.id, left - 1),
      },
    };
  } finally {
    secret.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Throttling (D-068's way of counting; D-077's counters)

interface Who {
  readonly userId: UserId;
  /** The session the code is typed in: waiting for its second step, or full. */
  readonly sessionId?: SessionId;
  /** The client address, for its own counter. */
  readonly source?: string;
}

interface Counted {
  readonly keys: readonly string[];
  readonly sessionFailures: number;
  /** The person's unexplained wrong-code counter (S-045), always locked; never a wait. */
  readonly wrongKey: string;
  /** Whether this attempt added one to it (TOTP codes only). */
  readonly wrongCounted: boolean;
}

/**
 * How long wrong TOTP codes that no right code in their session explained
 * are kept for an alert (S-045): 30 days without a new one.
 */
export const WRONG_CODE_MEMORY_SECONDS = 30 * 24 * 60 * 60;

function wrongKeyOf(userId: UserId): string {
  return `wrong:${userId}`;
}

/** The counters an attempt with `input` counts against, in key order. */
function keysFor(who: Who, input: CodeInput): string[] {
  const keys: string[] = [];
  // Recovery codes (120 bits) skip the person's counter, so someone
  // guessing TOTP codes with the password can't keep the person out.
  if (input.kind === "totp") keys.push(`user:${who.userId}`);
  if (who.sessionId !== undefined) keys.push(`session:${who.sessionId}`);
  if (who.source !== undefined) keys.push(throttleSourceKey(who.source));
  return keys.sort();
}

type Attempt =
  | ({ readonly allowed: true } & Counted)
  | { readonly allowed: false; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly exhausted: true };

/**
 * Counts this attempt up front against its counters, in one short
 * transaction with the rows locked in key order, so codes sent at once are
 * counted one by one; or says how long to wait. An attempt during a wait is
 * not counted (D-068). An alert row is written for the notice when the
 * person's counter starts a wait (and every 10 wrong codes after), or
 * (S-045) when a session's first code finds wrong TOTP codes from other
 * sessions that no right code explained: someone with the password tried
 * codes and gave up, which the person's counter, cleared by their next right
 * code and forgotten after a day, would never show. An alert takes those
 * codes off the unexplained counter, so each is told once.
 */
async function takeCodeAttempt(db: Database, who: Who, input: CodeInput): Promise<Attempt> {
  const keys = keysFor(who, input);
  const wrongKey = wrongKeyOf(who.userId);
  const wrongCounted = input.kind === "totp";
  // Every counter, the unexplained one included, locked in key order.
  const locked = [...keys, wrongKey].sort();
  for (let round = 1; ; round++) {
    const decided = await inTransaction(db, async (tx): Promise<Attempt | "row_gone"> => {
      for (const key of locked) {
        await tx.execute(sql`
          INSERT INTO public.second_step_throttles (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING`);
      }
      const rows = await tx.rows<{ key: string; failures: number; last_ms: number | null }>(sql`
        SELECT key, failures, (extract(epoch FROM last_failure_at) * 1000)::float8 AS last_ms
        FROM public.second_step_throttles WHERE key = ANY(${locked}::text[])
        ORDER BY key FOR UPDATE`);
      if (rows.length !== locked.length) return "row_gone";
      const clock = await tx.rows<{ now_ms: number }>(sql`
        SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`);
      const now = clock[0]?.now_ms;
      if (now === undefined) throw new Error("The database gave no time.");
      const decisions: { key: string; next: number | ThrottleDecision }[] = [];
      let wait = 0;
      let sessionFailures = 0;
      let unexplained = 0;
      for (const row of rows) {
        if (row.key === wrongKey) {
          // Forgotten after WRONG_CODE_MEMORY_SECONDS without a new one.
          const fresh =
            row.last_ms !== null && now - row.last_ms < WRONG_CODE_MEMORY_SECONDS * 1000;
          unexplained = fresh ? row.failures : 0;
          continue;
        }
        if (row.key.startsWith("session:")) {
          if (row.failures >= MAX_PENDING_CODE_FAILURES) return { allowed: false, exhausted: true };
          sessionFailures = row.failures + 1;
          decisions.push({ key: row.key, next: sessionFailures });
          continue;
        }
        const rule = row.key.startsWith("user:") ? SECOND_STEP_THROTTLE : SOURCE_THROTTLE;
        const d = throttleAttempt(
          rule,
          { failures: row.failures, lastFailureAt: row.last_ms },
          now,
        );
        if (!d.allowed) wait = Math.max(wait, d.retryAfterSeconds);
        decisions.push({ key: row.key, next: d });
      }
      if (wait > 0) return { allowed: false, retryAfterSeconds: wait };
      // This session's own share of the unexplained counter: the codes it
      // has sent (at most; recovery codes aren't on it), this one included
      // if it is a TOTP code.
      const counted = unexplained + (wrongCounted ? 1 : 0);
      const sent = who.sessionId === undefined ? 0 : sessionFailures - 1;
      const mine = Math.min(counted, sent + (wrongCounted ? 1 : 0));
      const fromOthers = counted - mine;
      let alertFailures: number | undefined;
      for (const { key, next } of decisions) {
        if (typeof next === "number") {
          await tx.execute(sql`
            UPDATE public.second_step_throttles
            SET failures = ${next}, last_failure_at = clock_timestamp() WHERE key = ${key}`);
        } else if (next.allowed) {
          await tx.execute(sql`
            UPDATE public.second_step_throttles
            SET failures = ${next.next.failures},
                last_failure_at = to_timestamp(${next.next.lastFailureAt}::float8 / 1000)
            WHERE key = ${key}`);
          const over = next.next.failures - SECOND_STEP_THROTTLE.free;
          if (key.startsWith("user:") && over >= 0 && over % 10 === 0) {
            alertFailures = next.next.failures;
          }
        }
      }
      // A session's first code finding other sessions' unexplained wrong codes (S-045).
      if (alertFailures === undefined && sessionFailures <= 1 && fromOthers > 0) {
        alertFailures = fromOthers;
      }
      if (alertFailures !== undefined) {
        await tx.execute(sql`
          INSERT INTO public.second_step_alerts (id, user_id, failures)
          VALUES (${randomUUID()}::uuid, ${who.userId}::uuid, ${alertFailures})`);
      }
      // Told now (or nothing to tell): only this session's own codes stay unexplained.
      const left = alertFailures === undefined ? counted : mine;
      if (wrongCounted || left !== unexplained) {
        await tx.execute(sql`
          UPDATE public.second_step_throttles
          SET failures = ${left},
              last_failure_at = CASE WHEN ${wrongCounted} THEN clock_timestamp() ELSE last_failure_at END
          WHERE key = ${wrongKey}`);
      }
      return { allowed: true, keys, sessionFailures, wrongKey, wrongCounted };
    });
    if (decided !== "row_gone") return decided;
    if (round >= 3) return { allowed: false, retryAfterSeconds: 1 };
  }
}

/**
 * A right code: the person's and the session's counters start again; the
 * address's loses one; and the wrong codes this session sent are explained
 * (a typo then the right code), so they come off the unexplained counter
 * (S-045). Recovery codes the session sent count there too, so this can take
 * off a few more than the session added; other sessions' codes were already
 * told by this session's first code, so at most those of a session started
 * since are lost.
 */
async function clearCodeAttempts(db: Queryable, counted: Counted): Promise<void> {
  const personal = counted.keys.filter((k) => !k.startsWith("source:"));
  const sources = counted.keys.filter((k) => k.startsWith("source:"));
  // The session's codes, less this one if it is a recovery code (not on the counter).
  const explained = Math.max(
    counted.sessionFailures - (counted.wrongCounted ? 0 : 1),
    counted.wrongCounted ? 1 : 0,
  );
  await db.execute(
    sql`DELETE FROM public.second_step_throttles WHERE key = ANY(${personal}::text[])`,
  );
  await db.execute(sql`
    UPDATE public.second_step_throttles SET failures = greatest(failures - 1, 0)
    WHERE key = ANY(${sources}::text[])`);
  // Last, as `wrong:` sorts after the others (the lock order of takeCodeAttempt).
  await db.execute(sql`
    UPDATE public.second_step_throttles SET failures = greatest(failures - ${explained}, 0)
    WHERE key = ${counted.wrongKey}`);
}

/**
 * An attempt counted up front that says nothing about the guesser: the
 * code couldn't be checked (the secret didn't open), or it was right but
 * lost a race (used meanwhile on another connection).
 */
async function giveBackCodeAttempt(db: Queryable, counted: Counted): Promise<void> {
  const keys = counted.wrongCounted ? [...counted.keys, counted.wrongKey] : [...counted.keys];
  await db.execute(sql`
    UPDATE public.second_step_throttles SET failures = greatest(failures - 1, 0)
    WHERE key = ANY(${keys}::text[])`);
}

/** Ends a session after its last allowed wrong code. */
async function endSessionById(db: Queryable, sessionId: SessionId): Promise<void> {
  await db.execute(sql`DELETE FROM public.sessions WHERE id = ${sessionId}::uuid`);
}

/** After a wrong code (already counted): `invalid_code`, or the session ends. */
async function wrongCode(db: Queryable, who: Who, counted: Counted): Promise<SecondStepRefusal> {
  if (who.sessionId !== undefined && counted.sessionFailures >= MAX_PENDING_CODE_FAILURES) {
    await endSessionById(db, who.sessionId);
    return TOO_MANY;
  }
  return INVALID_CODE;
}

/** A right code whose pass the database refused because another use won the race. */
async function lostRace(db: Queryable, counted: Counted): Promise<SecondStepRefusal> {
  await giveBackCodeAttempt(db, counted);
  return INVALID_CODE;
}

type Checked = ({ readonly ok: true; readonly pass: PassMaterial } & Counted) | SecondStepRefusal;

/** The throttle, then the code. On success the counters are left for the caller to clear once the pass is in. */
async function checkCode(
  db: Database,
  keys: SecretKeyring,
  who: Who,
  factor: FactorRow,
  input: CodeInput,
): Promise<Checked> {
  const attempt = await takeCodeAttempt(db, who, input);
  if (!attempt.allowed) {
    if ("exhausted" in attempt) {
      if (who.sessionId !== undefined) await endSessionById(db, who.sessionId);
      return TOO_MANY;
    }
    return throttled(attempt.retryAfterSeconds);
  }
  const verified = await verifyCode(db, keys, who.userId, factor, input);
  if (verified.ok) {
    return {
      ok: true,
      pass: verified.pass,
      keys: attempt.keys,
      sessionFailures: attempt.sessionFailures,
      wrongKey: attempt.wrongKey,
      wrongCounted: attempt.wrongCounted,
    };
  }
  if (verified.why === "unavailable") {
    await giveBackCodeAttempt(db, attempt);
    return UNAVAILABLE;
  }
  return wrongCode(db, who, attempt);
}

// ---------------------------------------------------------------------------
// Completing sign-in

/** What `completeSecondStep` takes: one code, the client address, and the organization if one must be chosen. */
export interface SecondStepInput {
  /** The 6 digits from the authenticator app (spaces allowed). */
  readonly code?: string;
  /** Or one recovery code. */
  readonly recoveryCode?: string;
  /** The client address from the HTTP layer (D-058), for its counter. */
  readonly source: string;
  /** The organization to work in, if the person must choose (`choose_organization`). */
  readonly organizationId?: OrganizationId;
}

/**
 * Completes a sign-in: checks a TOTP code or a recovery code for the person
 * whose session `token` is waiting for its second step, and makes the
 * session full, with a **new token**. A recovery code is used up.
 * Refusals: `invalid_code`, `throttled`, `too_many_attempts` (the session
 * ended), `enrolment_required` (set it up first), `second_step_unavailable`
 * (the secret can't be opened or its chain is used up: use a recovery code),
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
  if (!hasOnly(input, ["code", "recoveryCode", "source", "organizationId"])) return INVALID_REQUEST;
  const code = codeInput(input);
  const source = sourceOf(input);
  const organizationId = own(input, "organizationId");
  if (
    code === undefined ||
    source === undefined ||
    (organizationId !== undefined && !isOrganizationId(organizationId))
  ) {
    return INVALID_REQUEST;
  }
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    const who: Who = { userId, sessionId, source };
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
    if (!done.ok && done.code === "invalid_code") return await lostRace(db, checked);
    if (
      done.ok ||
      done.code === "choose_organization" ||
      done.code === "organization_required" ||
      done.code === "not_permitted"
    ) {
      await clearCodeAttempts(db, checked);
    }
    // Only a whole sign-in makes the address known (S-044).
    if (done.ok) await markKnownSource(db, userId, source);
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
  /** After a system admin's reset: the token from the link sent to the person, on every start until a factor is confirmed. */
  readonly enrolmentToken?: string;
}

/**
 * Starts setting up two-step sign-in for the person whose session `token`
 * is waiting for its second step and who has no factor in use: a new
 * 160-bit secret and its hash chain, sealed and stored as pending, returned
 * once as base32 text and an `otpauth://` link. Starting again replaces an
 * unconfirmed one (at most `MAX_ENROLMENT_STARTS` per waiting session).
 * Refuses with `already_enrolled` if a factor is in use, and with
 * `enrolment_token_required` after a system admin's reset unless the token
 * sent to the person is given: **on every start**, until a factor is
 * confirmed or the token expires (the newest token only). Every refusal is
 * decided by one read before the chain is computed.
 */
export async function startEnrolment(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  options: EnrolmentOptions = {},
): Promise<EnrolmentStart | NoSession | SecondStepRefusal | SessionFailure> {
  assertSecretKeyring(keys);
  const call = safeOptions(options, ["issuer", "enrolmentToken"]);
  const issuer = own(options, "issuer") ?? DEFAULT_TOTP_ISSUER;
  if (typeof issuer !== "string") throw new TypeError("issuer is text.");
  const enrolmentToken = own(options, "enrolmentToken");
  if (enrolmentToken !== undefined && typeof enrolmentToken !== "string") {
    throw new TypeError("enrolmentToken is text.");
  }
  const presented =
    typeof enrolmentToken === "string" && enrolmentToken.length <= 100 ? enrolmentToken : null;
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    // Everything that can refuse comes before the chain's 20,000 hashes
    // (second review, lower item 2), and again under the lock below.
    const refusal = await enrolmentRefusal(db, userId, sessionId, presented);
    if (refusal !== undefined) return refusal;
    const secret = newTotpSecret();
    try {
      const factorId = randomUUID();
      const box = sealSecret(keys, secret, secretContext(factorId, userId));
      const anchor = chainLink(secret, factorId, TOTP_CHAIN_LENGTH);
      const made = await inTransaction(db, async (tx) => {
        // One set-up at a time per person.
        const users = await tx.rows<{ email: string }>(sql`
          SELECT email FROM public.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`);
        const email = users[0]?.email;
        if (email === undefined) return NO_SESSION;
        const again = await enrolmentRefusal(tx, userId, sessionId, presented);
        if (again !== undefined) return again;
        const required = await tokenRequired(tx, userId);
        if (required && presented !== null) {
          // The trigger checks it against its hash, that it is the newest,
          // unexpired, with nothing confirmed since; the factor's insert
          // trigger then sees it presented in this transaction.
          await tx.execute(sql`
            UPDATE public.second_step_enrolment_tokens
            SET presented = ${presented}
            WHERE user_id = ${userId}::uuid
              AND token_hash = sha256(convert_to(${presented}, 'UTF8'))`);
        }
        await tx.execute(sql`
          UPDATE public.second_factors SET state = 'revoked'
          WHERE user_id = ${userId}::uuid AND state = 'pending'`);
        await tx.execute(sql`
          INSERT INTO public.second_factors
            (id, user_id, kind, state, secret_box, ratchet_anchor, ratchet_generation,
             chain_length, last_step, enrol_session_id, created_at)
          VALUES (${factorId}::uuid, ${userId}::uuid, 'totp', 'pending', ${box}, ${anchor}, 0,
                  ${TOTP_CHAIN_LENGTH}, -1, ${sessionId}::uuid, clock_timestamp())`);
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
    if (constraintOf(error) === "second_factors_new_token") return ENROLMENT_TOKEN_REQUIRED;
    // The session ended or the account changed between the read and the insert.
    if (secondStepGuardRefused(error)) return NO_SESSION;
    return failureFor(error, call);
  }
}

/** Whether the person must present an enrolment token (reset, nothing confirmed since). */
async function tokenRequired(q: Queryable, userId: UserId): Promise<boolean> {
  const rows = await q.rows<{ required: boolean }>(sql`
    SELECT public.second_step_token_required(${userId}::uuid) AS required`);
  return rows[0]?.required === true;
}

/**
 * Why a set-up can't start, or `undefined`: a factor in use, too many starts
 * in this waiting session, or (after a reset) no valid enrolment token:
 * the person's newest, unexpired, nothing confirmed since. Presenting it is
 * what the database checks; this read only spares the work.
 */
async function enrolmentRefusal(
  q: Queryable,
  userId: UserId,
  sessionId: SessionId,
  presented: string | null,
): Promise<SecondStepRefusal | undefined> {
  const rows = await q.rows<{
    state: string | null;
    starts: number;
    required: boolean;
    valid: boolean;
  }>(sql`
    SELECT (SELECT state FROM public.second_factors
            WHERE user_id = ${userId}::uuid AND state <> 'revoked') AS state,
           (SELECT count(*)::int FROM public.second_factors
            WHERE enrol_session_id = ${sessionId}::uuid) AS starts,
           public.second_step_token_required(${userId}::uuid) AS required,
           EXISTS (
             SELECT 1 FROM public.second_step_enrolment_tokens t
             WHERE t.user_id = ${userId}::uuid
               AND t.token_hash = sha256(convert_to(${presented ?? ""}, 'UTF8'))
               AND t.expires_at > clock_timestamp()
               AND NOT EXISTS (SELECT 1 FROM public.second_step_enrolment_tokens n
                               WHERE n.user_id = t.user_id AND n.order_no > t.order_no)
               AND NOT EXISTS (SELECT 1 FROM public.second_factors c
                               WHERE c.user_id = t.user_id AND c.confirmed_order > t.order_no))
             AS valid`);
  const row = rows[0];
  if (row?.state === "active") return ALREADY_ENROLLED;
  if ((row?.starts ?? 0) >= MAX_ENROLMENT_STARTS) return TOO_MANY_STARTS;
  if (row?.required === true && (presented === null || !row.valid)) {
    return ENROLMENT_TOKEN_REQUIRED;
  }
  return undefined;
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { constraint } = error as { constraint?: unknown };
  return typeof constraint === "string" ? constraint : undefined;
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
  input: {
    readonly code: string;
    readonly source: string;
    readonly organizationId?: OrganizationId;
  },
  options: SessionCallOptions = {},
): Promise<EnrolmentDone | NoSession | PromotionRefusal | SecondStepRefusal | SessionFailure> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!hasOnly(input, ["code", "source", "organizationId"])) return INVALID_REQUEST;
  const code = codeInput(input);
  const source = sourceOf(input);
  const organizationId = own(input, "organizationId");
  if (
    code?.kind !== "totp" ||
    source === undefined ||
    (organizationId !== undefined && !isOrganizationId(organizationId))
  ) {
    return INVALID_REQUEST;
  }
  try {
    const pending = await readPendingSession(db, token, call);
    if (!pending.ok) return pending;
    const { sessionId, userId } = pending.session;
    const who: Who = { userId, sessionId, source };
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
    if (!done.ok && done.code === "invalid_code") return await lostRace(db, checked);
    if (!done.ok) {
      if (done.code === "choose_organization" || done.code === "organization_required") {
        await clearCodeAttempts(db, checked);
      }
      return done;
    }
    await clearCodeAttempts(db, checked);
    await markKnownSource(db, userId, source);
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
 * Writes a pass for `who` in a transaction (after `first`, which takes the
 * row locks every path takes before a factor row) and runs `then` in it. A
 * refused pass (the code used meanwhile) is a lost race, not counted. The
 * counters are cleared on success.
 */
async function withPass<T>(
  db: Database,
  who: Who,
  checked: { readonly pass: PassMaterial } & Counted,
  pass: {
    readonly sessionId: SessionId;
    readonly purpose: "reauth" | "recovery_codes" | "admin_reset";
    readonly targetUserId?: UserId;
  },
  then: (tx: Queryable, passId: string) => Promise<T>,
  first?: (tx: Queryable) => Promise<void>,
): Promise<T | SecondStepRefusal> {
  try {
    const result = await inTransaction(db, async (tx) => {
      await first?.(tx);
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
    await clearCodeAttempts(db, checked);
    return result;
  } catch (error) {
    if (secondStepGuardRefused(error)) return lostRace(db, checked);
    throw error;
  }
}

/**
 * Locks the session row before the pass locks the factor row: every path
 * takes user rows, then session rows, then factor rows (second review,
 * lower item 1: without it a re-entry held the factor row while a reset
 * held the session row, a deadlock). Not the user row: that would also
 * hold off a password change, which must win (T-037's R1).
 */
function lockSessionRow(sessionId: SessionId): (tx: Queryable) => Promise<void> {
  return async (tx) => {
    await tx.rows(sql`SELECT 1 FROM public.sessions WHERE id = ${sessionId}::uuid FOR UPDATE`);
  };
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
 * password is checked as at sign-in (`signIn`'s replies), counted on the
 * person's own re-entry counter and the address counter, never on the
 * account counter anyone can push from the sign-in form (S-018); only then
 * the code, with its own counters (the person's, the
 * session's: 5 wrong codes end it, the address's). The database records
 * the re-entry only with a pass for this session made in the same
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
  const source = sourceOf(input);
  if (code === undefined || source === undefined) return INVALID_REQUEST;
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
      { email, password: own(input, "password") as string, source, organizationId },
      out,
      // Its own counter (S-018): strangers typing the address at sign-in
      // can't keep a signed-in person from re-entering the password.
      { reauthOf: userId },
    );
    if (!checkedPassword.ok) return checkedPassword;
    const verified = out.verified;
    if (checkedPassword.userId !== userId || verified === undefined) return NO_SESSION;
    const factor = await liveFactor(db, userId);
    if (factor?.state !== "active") return ENROLMENT_REQUIRED;
    const who: Who = { userId, sessionId, source };
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
        lockSessionRow(sessionId),
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
 * A new set of 10 recovery codes for the signed-in person; the old set stops
 * working at once. Needs the password and a code entered again in the last
 * 10 minutes (`reauthenticate`; `reauthentication_required` otherwise) **and**
 * a code (or one of their current recovery codes) now, counted per session
 * (5 wrong codes sign it out) and per client address, so a stolen session
 * cookie alone can neither replace the codes nor move the person's counter.
 * Returned once; only hashes are stored.
 */
export async function regenerateRecoveryCodes(
  db: Database,
  keys: SecretKeyring,
  token: unknown,
  input: { readonly code?: string; readonly recoveryCode?: string; readonly source: string },
  options: SessionCallOptions = {},
): Promise<
  | { readonly ok: true; readonly recoveryCodes: readonly string[] }
  | NoSession
  | SecondStepRefusal
  | SessionFailure
> {
  assertSecretKeyring(keys);
  const call = safeOptions(options);
  if (!hasOnly(input, ["code", "recoveryCode", "source"])) return INVALID_REQUEST;
  const code = codeInput(input);
  const source = sourceOf(input);
  if (code === undefined || source === undefined) return INVALID_REQUEST;
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return current;
    if (!current.session.recentlyAuthenticated) return REAUTHENTICATION_REQUIRED;
    const { userId, sessionId } = current.session;
    const factor = await liveFactor(db, userId);
    if (factor?.state !== "active") return ENROLMENT_REQUIRED;
    const who: Who = { userId, sessionId, source };
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
      lockSessionRow(sessionId),
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
  /** TOTP passes left before the authenticator must be set up again (warn when low). */
  readonly totpPassesLeft: number;
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
    const rows = await db.rows<{ enrolled_at: string | null; left: number; passes: number }>(sql`
      SELECT to_char(f.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS enrolled_at,
             (SELECT count(*)::int FROM public.second_step_recovery_codes c
              WHERE c.factor_id = f.id AND c.used_at IS NULL AND c.superseded_at IS NULL) AS left,
             (f.chain_length - f.ratchet_generation)::int AS passes
      FROM public.second_factors f
      WHERE f.user_id = ${current.session.userId}::uuid AND f.state = 'active'`);
    const row = rows[0];
    return Object.freeze({
      ok: true,
      enrolled: row !== undefined,
      enrolledAt: row?.enrolled_at ?? null,
      recoveryCodesLeft: row?.left ?? 0,
      totpPassesLeft: row?.passes ?? 0,
    });
  } catch (error) {
    return failureFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// A system admin's reset

/** The message `resetSecondFactor` sends: the person's address and their one-time set-up token. */
export interface EnrolmentMessage {
  readonly email: string;
  /**
   * 32 random bytes, base64url. **Secret to the person** (D-068's rule for
   * invitation tokens): only in the message to their address, never in a
   * log, a response or a screen.
   */
  readonly token: string;
  /** When it stops working (core's ISO form). */
  readonly expiresAt: string;
}

/** Sends an enrolment message (T-040 makes it email). Rejects if it couldn't be sent. */
export type EnrolmentDelivery = (message: EnrolmentMessage) => Promise<void>;

/** Thrown inside the reset's transaction to roll it back when `memberOf` no longer holds. */
class NotAMember extends Error {
  constructor() {
    super("not_a_member");
    this.name = "NotAMember";
  }
}

/**
 * Resets `targetUserId`'s two-step sign-in (D-019, D-052): their factor is
 * revoked, their recovery codes stop working, their wrong-code counter is
 * cleared, **every session of theirs ends**, and a one-time enrolment token
 * (3 days) is sent to their address with `deliver`: without it they can't
 * set it up again, so their password alone (which the writer role could
 * set) is not enough. For a system admin acting from their own full session
 * (`adminToken`), who entered their password and second step in the last
 * 10 minutes (`reauthentication_required`) **and** gives a code (or
 * recovery code) of their own now: the database revokes a factor in use and
 * makes a token only with a system admin's pass for that person made in the
 * same transaction (0014). Resetting someone with no factor in use just
 * sends a new token. Locks the user rows first (in ID order), then factor
 * rows, as every other path does. Returns whether there was a factor, how
 * many sessions ended and whether the message went (if not, reset again to
 * send a new one).
 */
export async function resetSecondFactor(
  db: Database,
  keys: SecretKeyring,
  adminToken: unknown,
  targetUserId: unknown,
  input: { readonly code?: string; readonly recoveryCode?: string; readonly source: string },
  deliver: EnrolmentDelivery,
  options: SessionCallOptions & { readonly memberOf?: string } = {},
): Promise<
  Validated<{ readonly reset: boolean; readonly ended: number; readonly delivered: boolean }>
> {
  assertSecretKeyring(keys);
  const call = safeOptions(options, ["memberOf"]);
  const memberOf = memberOfOption(options);
  if (typeof deliver !== "function") throw new TypeError("deliver is a function.");
  if (!isUserId(targetUserId)) return refused("invalid_request", "That isn't a user ID.");
  if (!hasOnly(input, ["code", "recoveryCode", "source"])) {
    return refused(INVALID_REQUEST.code, INVALID_REQUEST.message);
  }
  const code = codeInput(input);
  const source = sourceOf(input);
  if (code === undefined || source === undefined) {
    return refused(INVALID_REQUEST.code, INVALID_REQUEST.message);
  }
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
    if (!admin.system_admin) return refused("not_permitted", "Only a system admin can do that.");
    if (!admin.recent) {
      return refused(
        "reauthentication_required",
        "Enter your password and code again to reset someone's two-step sign-in.",
      );
    }
    const targets = await db.rows<{ email: string }>(sql`
      SELECT email FROM public.users WHERE id = ${targetUserId}::uuid`);
    const email = targets[0]?.email;
    if (email === undefined) return refused("unknown_user", "There is no such user.");
    if (memberOf !== undefined && !(await isMemberIn(db, memberOf, targetUserId))) {
      return refused("unknown_user", "There is no such user.");
    }
    const factor = await liveFactor(db, admin.user_id);
    if (factor?.state !== "active") {
      return refused(ENROLMENT_REQUIRED.code, ENROLMENT_REQUIRED.message);
    }
    const who: Who = { userId: admin.user_id, sessionId: admin.id, source };
    const checked = await checkCode(db, keys, who, factor, code);
    if (!checked.ok) return refused(checked.code, checked.message);
    const enrolmentToken = randomBytes(32).toString("base64url");
    const done = await withPass(
      db,
      who,
      checked,
      { sessionId: admin.id, purpose: "admin_reset", targetUserId },
      async (tx, passId) => {
        // T-048: the membership again, in the transaction that resets
        // (after the user rows are locked), so it can't change in between.
        if (memberOf !== undefined && !(await isMemberIn(tx, memberOf, targetUserId))) {
          throw new NotAMember();
        }
        const ended = await endAllSessionsForUser(tx, targetUserId);
        const reset = await tx.execute(sql`
          UPDATE public.second_factors
          SET state = 'revoked',
              revoked_by_pass = CASE WHEN state = 'active' THEN ${passId}::uuid END
          WHERE user_id = ${targetUserId}::uuid AND state <> 'revoked'`);
        const expiry = await tx.rows<{ expires_at: string }>(sql`
          INSERT INTO public.second_step_enrolment_tokens
            (user_id, token_hash, created_by_pass, created_at, expires_at)
          VALUES (${targetUserId}::uuid, ${sha256(Buffer.from(enrolmentToken, "utf8"))},
                  ${passId}::uuid, clock_timestamp(),
                  clock_timestamp() + make_interval(secs => ${ENROLMENT_TOKEN_SECONDS}))
          RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            AS expires_at`);
        await tx.execute(sql`
          DELETE FROM public.second_step_throttles WHERE key = ${`user:${targetUserId}`}`);
        return { reset: reset > 0, ended, expiresAt: expiry[0]?.expires_at ?? "" };
      },
      // The user rows first, in ID order (the target's to end its sessions,
      // the admin's as a promotion holds it), then the factor rows: the
      // order promotion and the rest take (review item 4).
      async (tx) => {
        const ids = [...new Set([admin.user_id, targetUserId])].sort();
        for (const id of ids) {
          await (id === targetUserId
            ? tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${id}::uuid FOR NO KEY UPDATE`)
            : tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${id}::uuid FOR SHARE`));
        }
        // Then the target's session rows (the admin's own among them when
        // they reset themselves), before any factor row.
        await tx.rows(sql`
          SELECT 1 FROM public.sessions WHERE user_id = ${targetUserId}::uuid ORDER BY id FOR UPDATE`);
      },
    );
    if (!("reset" in done)) return refused(done.code, done.message);
    // Sent after the commit, outside any transaction (as invitations, D-068).
    let delivered = true;
    try {
      await deliver(Object.freeze({ email, token: enrolmentToken, expiresAt: done.expiresAt }));
    } catch {
      delivered = false;
    }
    return { ok: true, value: { reset: done.reset, ended: done.ended, delivered } };
  } catch (error) {
    if (error instanceof NotAMember) return refused("unknown_user", "There is no such user.");
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
