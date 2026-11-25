/**
 * Server-side sessions in PostgreSQL (T-037, D-019, D-052, D-068, D-069).
 * The table is `0010_sessions.sql`'s; tokens, time limits and CSRF tokens
 * are core's `sessions.ts`.
 *
 * - **Two stages.** `beginSession` checks the password (`signIn`, with its
 *   throttle) and makes a session that is only *waiting for its second
 *   step*: for 10 minutes it can be read with `readPendingSession` (so the
 *   code screen knows whose code to check), ended, and promoted, nothing
 *   else. `resolveSession` and everything that acts for a person refuse it.
 *   `promoteSession` makes it full, with a new token, and needs a proof
 *   that only T-038's verifier (second-factor.ts) makes (`second-step.ts`),
 *   and the database a pass for that session written in the same
 *   transaction (0014, D-077).
 * - **Tokens** are 256-bit random, given out once, stored only as SHA-256,
 *   in one spelling (core's `isSessionToken`; anything else is refused
 *   before the database is asked). A new token at promotion, at a change of
 *   organization (a new session), at re-entering the password and on
 *   `rotateSession` (T-019d's site unlocks and T-041's role changes call
 *   it). An old token stops working the moment the change commits.
 * - **Time limits in the query.** Every lookup has the database decide, by
 *   its own clock: `expires_at` (absolute, from the password) and
 *   `last_seen_at + idle_seconds`, and `session_access_ok`: the account is
 *   active, the sign-in is after its `sessions_valid_after`, and it may work
 *   in the session's organization. An expired session is refused even if
 *   the cleanup never runs. Use refreshes `last_seen_at`.
 * - **One organization** per session (D-019). `switchOrganization` makes a
 *   new session for the other organization (same sign-in, same end) and
 *   ends the old one.
 * - **Ending sessions can't race making them** (review B1). Making or
 *   copying a session (`beginSession`'s insert, promotion, switching) holds
 *   the user row FOR SHARE; every path that ends a user's sessions
 *   (`endOtherSessions`, `endUserSessions`, `endAllSessionsForUser`,
 *   disabling, removing a membership) locks it first. Ending all of them
 *   also moves `users.sessions_valid_after` to now, so a copy made at the
 *   same moment is dead even if a DELETE missed it, and re-enabling an
 *   account revives nothing.
 * - **Re-entering the password** for a sensitive change: `reauthenticate`
 *   records the time and gives a new token, and `resolveSession` says
 *   whether it was recent (`recentlyAuthenticated`, 10 minutes by default).
 *   It asks for the second step too (D-052), so it lives in second-factor.ts.
 * - **A person's own sessions:** `listSessions` (no tokens, no hashes, no
 *   addresses, only their own), `endOwnSession`, `endOtherSessions`.
 *   `endSession` is sign-out. `endUserSessions` is a system admin's, from
 *   their own recently re-authenticated session (D-052, ASVS 7.4.5);
 *   `endAllSessionsForUser` is for T-039's reset, inside its own
 *   transaction.
 * - **Database failures** (as client.ts's `isDatabaseFailure` judges them,
 *   S-016) never reach the caller as they are: they become a fixed
 *   `SessionFailure` (`retry`, `timeout`, `database_unavailable`), and the
 *   raw error goes only to the `onError` option. Programming errors are
 *   thrown. `internal_error` is for a statement that returned nothing.
 * - **A sign-in can't outrun a password change or "end all"** (second
 *   review, R1): the session is made only if the account still has the
 *   password hash that was checked and the same `sessions_valid_after`.
 * - **Cleanup:** `runCleanup` (the `db:cleanup` command) deletes ended
 *   sessions and old sign-in counters.
 *
 * Every refusal for a token (unknown, malformed, ended, expired, another
 * stage, a disabled account) is the same frozen `NO_SESSION`.
 */
import {
  DEFAULT_SESSION_POLICY,
  RECENT_AUTHENTICATION_SECONDS,
  clientLabel,
  hashSessionToken,
  isOrganizationId,
  isPlainObject,
  isRecentAuthenticationWindow,
  isSessionId,
  isSessionToken,
  isUserId,
  newSessionId,
  newSessionToken,
  validateSessionPolicy,
  type OrganizationId,
  type SessionId,
  type SessionPolicy,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  INVALID_CREDENTIALS,
  deleteExpiredSignInThrottles,
  signInChecked,
  type SignInFailure,
  type VerifiedSignIn,
} from "./accounts.js";
import { isDatabaseFailure, isDatabaseTimeout, type Database, type Queryable } from "./client.js";
import { readSystemSettings } from "./permissions.js";
import {
  readSecondStepProof,
  secondStepGuardRefused,
  spendSecondStepProof,
  writeSecondStepPass,
  type SecondStepProof,
} from "./second-step.js";
import { sql } from "./sql.js";

/**
 * What the writer role needs on `sessions`, beyond SELECT (D-067, D-069):
 * INSERT (sign-in, switching), UPDATE (use, promotion, rotation, re-entry;
 * also what `SELECT … FOR UPDATE` needs) and DELETE (sign-out, ending, the
 * cleanup, and the triggers that end sessions on disable). Locking a user
 * row uses the writer's existing UPDATE on `users`.
 */
export const SESSION_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sessions: Object.freeze(["INSERT", "UPDATE", "DELETE"]),
});

// ---------------------------------------------------------------------------
// Results

/** The one refusal for any token that isn't a usable session of the kind asked for. */
export interface NoSession {
  readonly ok: false;
  readonly code: "no_session";
  readonly message: string;
}

export const NO_SESSION: NoSession = Object.freeze({
  ok: false,
  code: "no_session",
  message: "You are not signed in, or your session has ended. Sign in again.",
});

/** A database failure, as fixed text: never the database's own message. */
export interface SessionFailure {
  readonly ok: false;
  readonly code: "retry" | "timeout" | "database_unavailable" | "internal_error";
  readonly message: string;
}

export const FAILURES: Readonly<Record<SessionFailure["code"], SessionFailure>> = Object.freeze({
  retry: Object.freeze({
    ok: false,
    code: "retry",
    message: "Other changes were happening at the same moment. Try again.",
  }),
  timeout: Object.freeze({
    ok: false,
    code: "timeout",
    message: "That took too long and was stopped. Try again.",
  }),
  database_unavailable: Object.freeze({
    ok: false,
    code: "database_unavailable",
    message: "The database couldn't be reached just now. Try again in a moment.",
  }),
  internal_error: Object.freeze({
    ok: false,
    code: "internal_error",
    message: "Something went wrong with your session. Try again.",
  }),
});

/** Options every session function takes. */
export interface SessionCallOptions {
  /**
   * Gets a database error before it becomes a fixed `SessionFailure` (for
   * the server's log). It must not log the token; none is passed to it. A
   * throw from it is ignored.
   */
  readonly onError?: (error: unknown) => void;
}

/** A full session, as the caller acts on it. Never holds the token or its hash. */
export interface FullSession {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly systemAdmin: boolean;
  /** When the password was checked for this sign-in (core's ISO form). */
  readonly signedInAt: string;
  /** The absolute end. */
  readonly expiresAt: string;
  /** When it ends if not used again (refreshed by this lookup, unless it was background). */
  readonly idleExpiresAt: string;
  /**
   * How long it may sit unused, in seconds: the limit it was made with
   * (D-069), which the admin's own idle timer follows (T-062, D-098).
   */
  readonly idleSeconds: number;
  /**
   * Seconds until the idle end by the database's clock, as of this lookup
   * (whole seconds, rounded down): so the admin can set its timer by the
   * server without comparing clocks (T-062, D-098).
   */
  readonly idleSecondsLeft: number;
  /** When the password was last entered in this session. */
  readonly passwordAt: string;
  /** Whether that was within the window asked for (10 minutes by default). */
  readonly recentlyAuthenticated: boolean;
}

/** A session waiting for its second step. */
export interface PendingSession {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  /** Chosen at the password, or `null` to be chosen at promotion. */
  readonly organizationId: OrganizationId | null;
  readonly expiresAt: string;
}

/** A new token for the caller to put in the cookie, with the session it now names. */
export interface IssuedSession<S> {
  readonly ok: true;
  readonly token: string;
  readonly session: S;
}

/** One line of a person's list of their own sessions. */
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly organizationId: OrganizationId | null;
  readonly stage: "second_step" | "full";
  readonly signedInAt: string;
  readonly lastSeenAt: string;
  /** The earlier of the absolute end and the idle end. */
  readonly endsAt: string;
  readonly clientLabel: string | null;
  /** True for the session the list was asked from. */
  readonly current: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers

export function own(input: unknown, key: string): unknown {
  if (!isPlainObject(input)) return undefined;
  const d = Object.getOwnPropertyDescriptor(input, key);
  return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
}

export function hasOnly(input: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(input)) return false;
  return Reflect.ownKeys(input).every((k) => typeof k === "string" && keys.includes(k));
}

export function refused<T>(code: string, message: string): Validated<T> {
  return { ok: false, issues: [{ path: [], code, message }] };
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { constraint } = error as { constraint?: unknown };
  return typeof constraint === "string" ? constraint : undefined;
}

/**
 * True for a refusal by 0010's session checks: the session ended or lost
 * access between the query's own conditions and the trigger's (the clock
 * moves within a statement), or a disable committed meanwhile. The caller
 * answers `NO_SESSION`.
 */
function sessionGuardRefused(error: unknown): boolean {
  const state = sqlState(error);
  return (
    (state === "23000" || state === "23514") &&
    constraintOf(error)?.startsWith("sessions_") === true
  );
}

/** The options as given, checked: only `onError`, a function if present. */
export function callOptions(options: unknown, extra: readonly string[] = []): SessionCallOptions {
  if (options === undefined) return {};
  const onError = own(options, "onError");
  if (
    !hasOnly(options, ["onError", ...extra]) ||
    (onError !== undefined && typeof onError !== "function")
  ) {
    throw new TypeError("Session options take onError (a function) only, besides their own.");
  }
  return onError === undefined ? {} : { onError: onError as (error: unknown) => void };
}

/**
 * A thrown error as the caller's answer: `NO_SESSION` for 0010's session
 * guards; for a database or connection failure as client.ts's
 * `isDatabaseFailure` judges it (S-016), a fixed `SessionFailure` (the raw
 * error to `onError` only): `retry` for class 40 (deadlock, serialization),
 * `timeout` for a statement or lock timeout, `database_unavailable` for the
 * rest. Anything else (a programming error, a permission error, a bad
 * option) is thrown again, as everywhere else in this package. A lock
 * timeout (55P03, which T-051's `lock_timeout` raises) is answered `timeout`
 * too, though its class isn't one of S-016's. Also used by
 * password-resets.ts; not exported from `@oculus/db`.
 */
export function failureFor(
  error: unknown,
  options: SessionCallOptions,
): NoSession | SessionFailure {
  if (sessionGuardRefused(error)) return NO_SESSION;
  const state = sqlState(error);
  if (state !== "55P03" && !isDatabaseFailure(error)) throw error;
  try {
    options.onError?.(error);
  } catch {
    // The log's own failure changes nothing.
  }
  if (state?.startsWith("40") === true) return FAILURES.retry;
  // A wait for a free pooled connection past the pool's limit (S-063) is
  // load, like a statement or lock timeout, not an outage.
  if (state === "57014" || state === "55P03" || isDatabaseTimeout(error)) return FAILURES.timeout;
  return FAILURES.database_unavailable;
}

/** `failureFor` as a `Validated` refusal. */
export function refusedFor<T>(error: unknown, options: SessionCallOptions): Validated<T> {
  const f = failureFor(error, options);
  return refused(f.code, f.message);
}

const RETRYABLE = new Set(["40P01", "40001"]);

export async function inTransaction<T>(
  db: Database,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= 3 || !RETRYABLE.has(sqlState(error) ?? "")) throw error;
    }
  }
}

/** The hash of a token in canonical form, or `undefined` (never sent to the database). */
export function tokenHash(token: unknown): Uint8Array | undefined {
  return isSessionToken(token) ? hashSessionToken(token) : undefined;
}

/**
 * Locks the user row of the session `hash` names (`FOR SHARE` to make or
 * copy a session, `FOR NO KEY UPDATE` to end some), before the session row
 * is locked, and returns the user ID, or `undefined` if no such session.
 * Every path takes the user row first, so they serialise without deadlock.
 */
export async function lockUserOf(
  tx: Queryable,
  hash: Uint8Array,
  mode: "share" | "update",
): Promise<UserId | undefined> {
  const found = await tx.rows<{ user_id: UserId }>(sql`
    SELECT user_id::text AS user_id FROM public.sessions WHERE token_hash = ${hash}`);
  const userId = found[0]?.user_id;
  if (userId === undefined) return undefined;
  await (mode === "share"
    ? tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${userId}::uuid FOR SHARE`)
    : tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`));
  return userId;
}

function recentWindow(options: unknown): number {
  const seconds = own(options, "recentAuthenticationSeconds") ?? RECENT_AUTHENTICATION_SECONDS;
  if (!isRecentAuthenticationWindow(seconds)) {
    throw new TypeError("recentAuthenticationSeconds is a whole number from 60 to 3,600.");
  }
  return seconds;
}

export const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export interface FullRow {
  id: SessionId;
  user_id: UserId;
  organization_id: OrganizationId;
  system_admin: boolean;
  signed_in_at: string;
  expires_at: string;
  idle_expires_at: string;
  idle_seconds: number;
  idle_left: number;
  password_at: string;
  recent: boolean;
}

export function fullSession(row: FullRow): FullSession {
  return Object.freeze({
    sessionId: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    systemAdmin: row.system_admin,
    signedInAt: row.signed_in_at,
    expiresAt: row.expires_at,
    idleExpiresAt: row.idle_expires_at,
    idleSeconds: row.idle_seconds,
    idleSecondsLeft: row.idle_left,
    passwordAt: row.password_at,
    recentlyAuthenticated: row.recent,
  });
}

/** The RETURNING list of a full session (`s` the session, `u` its user). */
export function fullColumns(recentSeconds: number) {
  return sql`
    s.id::text AS id, s.user_id::text AS user_id, s.organization_id::text AS organization_id,
    u.system_admin,
    to_char(s.signed_in_at AT TIME ZONE 'UTC', ${ISO}) AS signed_in_at,
    to_char(s.expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at,
    to_char(least(s.expires_at, s.last_seen_at + make_interval(secs => s.idle_seconds))
            AT TIME ZONE 'UTC', ${ISO}) AS idle_expires_at,
    s.idle_seconds,
    greatest(0, floor(extract(epoch FROM
      least(s.expires_at, s.last_seen_at + make_interval(secs => s.idle_seconds))
      - clock_timestamp())))::integer AS idle_left,
    to_char(s.password_at AT TIME ZONE 'UTC', ${ISO}) AS password_at,
    s.password_at > clock_timestamp() - make_interval(secs => ${recentSeconds}) AS recent`;
}

/** Whether session `s` is usable (time limits and `session_access_ok`), by the database's clock. */
export const VALID = sql`public.session_live(s)
  AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)`;

/** The conditions for a usable full session `s` of user `u`. */
export const LIVE_FULL = sql`s.stage = 'full' AND u.id = s.user_id AND ${VALID}`;

// ---------------------------------------------------------------------------
// Signing in

/** What `beginSession` takes: the sign-in form, the client address and a label. */
export interface SessionStart {
  readonly email: string;
  readonly password: string;
  /** The client address from the HTTP layer (D-058), for the throttle. */
  readonly source: string;
  /**
   * The organization to work in; if left out, chosen at promotion. One the
   * person can't enter (for a system admin: one that doesn't exist) is
   * `invalid_credentials` and counts as a failed attempt.
   */
  readonly organizationId?: OrganizationId;
  /** Shown in the person's list of sessions (core's `clientLabel` cleans it). */
  readonly clientLabel?: string;
}

/** Options for `beginSession`: the time limits a system manager chose (D-052). */
export interface SessionOptions extends SessionCallOptions {
  /**
   * The time limits. Left out (as the HTTP layer will), they come from
   * System settings as they are at sign-in (D-072), or the defaults when
   * those were never changed or can't be read; reading them never refuses a
   * sign-in.
   */
  readonly policy?: SessionPolicy;
}

/**
 * The time limits a system manager chose in System settings (D-072:
 * `sessionIdleMinutes`, `sessionAbsoluteMinutes`), or the defaults when
 * they were never changed, can't be read or are out of bounds. Never throws:
 * a sign-in is never refused because of the settings.
 */
async function policyFromSettings(db: Queryable): Promise<SessionPolicy> {
  try {
    const stored = await readSystemSettings(db);
    if (!stored.ok) return DEFAULT_SESSION_POLICY;
    const { sessionIdleMinutes, sessionAbsoluteMinutes } = stored.value.settings;
    return (
      validateSessionPolicy({
        idleSeconds: sessionIdleMinutes * 60,
        absoluteSeconds: sessionAbsoluteMinutes * 60,
      }) ?? DEFAULT_SESSION_POLICY
    );
  } catch {
    return DEFAULT_SESSION_POLICY;
  }
}

function policyFrom(options: unknown): SessionPolicy | undefined {
  const given = own(options, "policy");
  if (given === undefined) return undefined;
  const policy = validateSessionPolicy(given);
  if (policy === undefined) {
    throw new TypeError(
      "A session policy is { idleSeconds, absoluteSeconds }: idle 300–43,200, absolute 3,600–86,400, idle ≤ absolute.",
    );
  }
  return policy;
}

const INVALID_START: SignInFailure = Object.freeze({
  ok: false,
  code: "invalid_request",
  message:
    "Give an email address, a password, the client address and optionally an organization and label.",
});

/**
 * Checks the password (`signIn`, D-068: throttled, the same reply and cost
 * for an unknown address) and, if it is right, makes a session **waiting
 * for its second step**: it lasts 10 minutes and grants nothing but
 * `readPendingSession`, `endSession` and promotion. The token is given here
 * once. Every `signIn` failure is passed on as it is.
 */
export async function beginSession(
  db: Database,
  input: SessionStart,
  options: SessionOptions = {},
): Promise<IssuedSession<PendingSession> | SignInFailure | SessionFailure> {
  const call = callOptions(options, ["policy"]);
  const policy = policyFrom(options);
  if (!hasOnly(input, ["email", "password", "source", "organizationId", "clientLabel"])) {
    return INVALID_START;
  }
  const label = clientLabel(own(input, "clientLabel")) ?? null;
  const organizationId = own(input, "organizationId");
  const signInInput = {
    email: own(input, "email") as string,
    password: own(input, "password") as string,
    source: own(input, "source") as string,
    ...(organizationId === undefined ? {} : { organizationId: organizationId as OrganizationId }),
  };
  const sessionId = newSessionId();
  const token = newSessionToken();
  const org = (organizationId as OrganizationId | undefined) ?? null;
  try {
    const out: { verified?: VerifiedSignIn } = {};
    const checked = await signInChecked(db, signInInput, out);
    if (!checked.ok) return checked;
    const verified = out.verified;
    if (verified === undefined) return FAILURES.internal_error;
    // The caller's policy (tests), or System settings' as they are now.
    const limits = policy ?? (await policyFromSettings(db));
    // One transaction: the user row FOR SHARE (so a disable or "end all"
    // under way finishes first), then the account must still have the hash
    // the password matched and the same sessions_valid_after it had when the
    // password was checked. A password change or "end all sessions" that
    // committed after the check wins: the sign-in is refused (second
    // review, R1). Not counted against the throttle: the password was right
    // when checked.
    const made = await inTransaction(db, async (tx) => {
      const still = await tx.rows(sql`
        SELECT 1 FROM public.users
        WHERE id = ${checked.userId}::uuid AND disabled_at IS NULL
          AND password_hash = ${verified.passwordHash}
          AND sessions_valid_after = ${verified.sessionsValidAfter}::timestamptz
        FOR SHARE`);
      if (still.length !== 1) return undefined;
      return tx.rows<{ expires_at: string }>(sql`
      INSERT INTO public.sessions
        (id, token_hash, user_id, organization_id, stage, signed_in_at, created_at,
         last_seen_at, rotated_at, password_at, idle_seconds, absolute_seconds, expires_at,
         client_label)
      SELECT ${sessionId}::uuid, ${hashSessionToken(token)}, ${checked.userId}::uuid,
             ${org}::uuid, 'second_step', t, t, t, t, t,
             ${limits.idleSeconds}, ${limits.absoluteSeconds}, t + interval '10 minutes', ${label}
      FROM (SELECT clock_timestamp() AS t) c
      RETURNING to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at`);
    });
    if (made === undefined) return INVALID_CREDENTIALS;
    const expiresAt = made[0]?.expires_at;
    if (expiresAt === undefined) return FAILURES.internal_error;
    return {
      ok: true,
      token,
      session: Object.freeze({ sessionId, userId: checked.userId, organizationId: org, expiresAt }),
    };
  } catch (error) {
    // Disabled or removed between the password check and the insert.
    if (sessionGuardRefused(error)) return INVALID_CREDENTIALS;
    return failureFor(error, call) as SessionFailure;
  }
}

/**
 * The session waiting for its second step that `token` names, for T-038's
 * code screen, or `NO_SESSION` (also for a full session, an expired one or
 * a disabled account). Grants nothing.
 */
export async function readPendingSession(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<{ readonly ok: true; readonly session: PendingSession } | NoSession | SessionFailure> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  try {
    const rows = await db.rows<{
      id: SessionId;
      user_id: UserId;
      organization_id: OrganizationId | null;
      expires_at: string;
    }>(sql`
      SELECT s.id::text AS id, s.user_id::text AS user_id, s.organization_id::text AS organization_id,
             to_char(s.expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at
      FROM public.sessions s
      WHERE s.token_hash = ${hash} AND s.stage = 'second_step' AND ${VALID}`);
    const row = rows[0];
    if (row === undefined) return NO_SESSION;
    return {
      ok: true,
      session: Object.freeze({
        sessionId: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        expiresAt: row.expires_at,
      }),
    };
  } catch (error) {
    return failureFor(error, call);
  }
}

/** A refusal at promotion other than `NO_SESSION`. */
export type PromotionRefusal =
  | {
      readonly ok: false;
      readonly code: "choose_organization";
      readonly message: string;
      /** The user's own organizations, sorted (shown after the second step passed). */
      readonly organizationIds: readonly OrganizationId[];
    }
  | {
      readonly ok: false;
      /** A system admin with no memberships must name the organization. */
      readonly code: "organization_required";
      readonly message: string;
    }
  | { readonly ok: false; readonly code: "not_permitted"; readonly message: string }
  | {
      readonly ok: false;
      /** The database refused the pass: the code was used meanwhile, or the race was lost. */
      readonly code: "invalid_code";
      readonly message: string;
    };

/** The code was right when checked but the database refused its pass (used meanwhile). */
export const CODE_REFUSED = Object.freeze({
  ok: false,
  code: "invalid_code",
  message: "That code isn't right, or was used already. Try the next code.",
} as const);

export const NOT_PERMITTED_HERE = Object.freeze({
  ok: false,
  code: "not_permitted",
  message: "You can't work in that organization.",
} as const);

const ORGANIZATION_REQUIRED = Object.freeze({
  ok: false,
  code: "organization_required",
  message: "You aren't a member of any organization. Name the organization to work in.",
} as const);

/**
 * Makes a session waiting for its second step full, with a **new token**
 * (the old one stops working). Needs a proof from `passedSecondStep`
 * (second-step.ts) for this very session and its user, under a minute old,
 * which is then spent. **For T-038 only; not exported from `@oculus/db`.**
 *
 * The organization is the one chosen at the password; otherwise
 * `organizationId` here; otherwise the user's only membership; otherwise
 * `choose_organization` with their organizations, or `organization_required`
 * for a system admin with none (the proof is kept either way, so the person
 * can choose without a new code). An organization they can't work in is
 * `not_permitted`. The session then ends `absoluteSeconds` after the
 * password, not after promotion.
 */
export async function promoteSession(
  db: Database,
  token: unknown,
  proof: SecondStepProof,
  input: { readonly organizationId?: OrganizationId } = {},
  options: SessionCallOptions = {},
): Promise<IssuedSession<FullSession> | NoSession | PromotionRefusal | SessionFailure> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  const record = readSecondStepProof(proof);
  if (hash === undefined || record === undefined) return NO_SESSION;
  if (!hasOnly(input, ["organizationId"])) return NO_SESSION;
  const asked = own(input, "organizationId");
  if (asked !== undefined && !isOrganizationId(asked)) return NOT_PERMITTED_HERE;
  const newToken = newSessionToken();
  try {
    return await inTransaction(db, async (tx) => {
      if ((await lockUserOf(tx, hash, "share")) === undefined) return NO_SESSION;
      const rows = await tx.rows<{
        id: SessionId;
        user_id: UserId;
        organization_id: OrganizationId | null;
        system_admin: boolean;
        memberships: OrganizationId[];
      }>(sql`
        SELECT s.id::text AS id, s.user_id::text AS user_id,
               s.organization_id::text AS organization_id, u.system_admin,
               ARRAY(SELECT m.organization_id::text FROM public.organization_members m
                     WHERE m.user_id = s.user_id ORDER BY 1) AS memberships
        FROM public.sessions s JOIN public.users u ON u.id = s.user_id
        WHERE s.token_hash = ${hash} AND s.stage = 'second_step' AND ${VALID}
        FOR UPDATE OF s`);
      const row = rows[0];
      // The proof must be for this session and this user.
      if (row?.id !== record.sessionId || row.user_id !== record.userId) return NO_SESSION;
      let organizationId: OrganizationId;
      if (row.organization_id !== null) {
        if (asked !== undefined && asked !== row.organization_id) return NOT_PERMITTED_HERE;
        organizationId = row.organization_id;
      } else if (asked !== undefined) {
        organizationId = asked;
      } else if (row.memberships.length === 1 && row.memberships[0] !== undefined) {
        organizationId = row.memberships[0];
      } else if (row.memberships.length === 0) {
        return ORGANIZATION_REQUIRED;
      } else {
        return {
          ok: false,
          code: "choose_organization",
          message: "Choose the organization to work in.",
          organizationIds: Object.freeze([...row.memberships]),
        } as const;
      }
      const access = await tx.rows<{ ok: boolean }>(sql`
        SELECT public.session_access_ok(s.user_id, ${organizationId}::uuid, s.signed_in_at) AS ok
        FROM public.sessions s WHERE s.id = ${row.id}::uuid`);
      if (access[0]?.ok !== true) return NOT_PERMITTED_HERE;
      // The pass, in this transaction (0014): the database promotes only
      // with it, and it moves the ratchet or uses the recovery code up.
      const passId = await writeSecondStepPass(
        tx,
        { userId: row.user_id, sessionId: row.id, purpose: "sign_in" },
        record.pass,
      );
      await record.afterPass?.(tx);
      const promoted = await tx.rows<FullRow>(sql`
        UPDATE public.sessions s
        SET stage = 'full', token_hash = ${hashSessionToken(newToken)},
            organization_id = ${organizationId}::uuid, second_step_pass = ${passId}::uuid,
            second_step_at = clock_timestamp(), rotated_at = clock_timestamp(),
            last_seen_at = clock_timestamp(),
            expires_at = s.signed_in_at + make_interval(secs => s.absolute_seconds)
        FROM public.users u
        WHERE s.id = ${row.id}::uuid AND u.id = s.user_id
        RETURNING ${fullColumns(RECENT_AUTHENTICATION_SECONDS)}`);
      const done = promoted[0];
      if (done === undefined) return NO_SESSION;
      spendSecondStepProof(proof);
      return { ok: true, token: newToken, session: fullSession(done) } as const;
    });
  } catch (error) {
    // The pass was refused: the code was used meanwhile (another
    // connection), or the session or account changed. Nothing committed.
    if (secondStepGuardRefused(error)) return CODE_REFUSED;
    return failureFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// Using a session

/** Options for `resolveSession`. */
export interface ResolveOptions extends SessionCallOptions {
  /** The window for `recentlyAuthenticated`: 60 to 3,600 seconds, 600 by default. */
  readonly recentAuthenticationSeconds?: number;
  /**
   * Whether this lookup is a use of the session (T-062, D-098): `true` (the
   * default) moves `last_seen_at` to now; `false`, for a request the admin
   * marks as background (polling, a check of whether the session is still
   * alive), checks every limit the same way but leaves `last_seen_at` alone,
   * so background requests never keep an unattended session going. It can
   * only make a session end sooner, never later.
   */
  readonly activity?: boolean;
}

/**
 * The full session `token` names, refreshed (`last_seen_at`; not for a
 * background lookup, `activity: false`), or `NO_SESSION`. One statement: the database checks the stage, the absolute
 * and idle limits by its own clock, that the account is active, that the
 * sign-in is after its `sessions_valid_after`, and that it may still work
 * in the session's organization. A session waiting for its second step is
 * `NO_SESSION` here. The caller checks the CSRF token (core's
 * `checkCsrfToken`) on every change.
 */
export async function resolveSession(
  db: Queryable,
  token: unknown,
  options: ResolveOptions = {},
): Promise<{ readonly ok: true; readonly session: FullSession } | NoSession | SessionFailure> {
  const call = callOptions(options, ["recentAuthenticationSeconds", "activity"]);
  const recent = recentWindow(options);
  const activity = own(options, "activity") ?? true;
  if (typeof activity !== "boolean") throw new TypeError("activity is true or false.");
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  try {
    // The same conditions either way; a background lookup only reads, so
    // the idle limit keeps counting from the last real use.
    const rows = activity
      ? await db.rows<FullRow>(sql`
      UPDATE public.sessions s SET last_seen_at = clock_timestamp()
      FROM public.users u
      WHERE s.token_hash = ${hash} AND ${LIVE_FULL}
      RETURNING ${fullColumns(recent)}`)
      : await db.rows<FullRow>(sql`
      SELECT ${fullColumns(recent)}
      FROM public.sessions s JOIN public.users u ON u.id = s.user_id
      WHERE s.token_hash = ${hash} AND ${LIVE_FULL}`);
    const row = rows[0];
    return row === undefined ? NO_SESSION : { ok: true, session: fullSession(row) };
  } catch (error) {
    return failureFor(error, call);
  }
}

/**
 * Gives a full session a new token (ASVS 5.0 7.2.4): for any change of what
 * it may do (T-019d's site unlocks, T-041's role changes). The old token
 * stops working at once.
 */
export async function rotateSession(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<IssuedSession<FullSession> | NoSession | SessionFailure> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  const newToken = newSessionToken();
  try {
    const rows = await db.rows<FullRow>(sql`
      UPDATE public.sessions s
      SET token_hash = ${hashSessionToken(newToken)}, rotated_at = clock_timestamp(),
          last_seen_at = clock_timestamp()
      FROM public.users u
      WHERE s.token_hash = ${hash} AND ${LIVE_FULL}
      RETURNING ${fullColumns(RECENT_AUTHENTICATION_SECONDS)}`);
    const row = rows[0];
    return row === undefined
      ? NO_SESSION
      : { ok: true, token: newToken, session: fullSession(row) };
  } catch (error) {
    return failureFor(error, call);
  }
}

/**
 * Moves to another organization (D-019): a new session, with a new token,
 * for the same sign-in (same absolute end; the password must be entered
 * again for a sensitive change there), and the old session ends, in one
 * transaction that holds the user row FOR SHARE, so ending the person's
 * sessions at the same moment ends the new one too (review B1). An
 * organization the person can't work in, or one that doesn't exist, is the
 * same `not_permitted`; the current one is `same_organization`.
 */
export async function switchOrganization(
  db: Database,
  token: unknown,
  organizationId: unknown,
  options: SessionCallOptions = {},
): Promise<
  | IssuedSession<FullSession>
  | NoSession
  | typeof NOT_PERMITTED_HERE
  | { readonly ok: false; readonly code: "same_organization"; readonly message: string }
  | SessionFailure
> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  if (!isOrganizationId(organizationId)) return NOT_PERMITTED_HERE;
  const newToken = newSessionToken();
  const newId = newSessionId();
  try {
    return await inTransaction(db, async (tx) => {
      if ((await lockUserOf(tx, hash, "share")) === undefined) return NO_SESSION;
      const rows = await tx.rows<{ id: SessionId; organization_id: string; access: boolean }>(sql`
        SELECT s.id::text AS id, s.organization_id::text AS organization_id,
               public.session_access_ok(s.user_id, ${organizationId}::uuid, s.signed_in_at) AS access
        FROM public.sessions s JOIN public.users u ON u.id = s.user_id
        WHERE s.token_hash = ${hash} AND ${LIVE_FULL}
        FOR UPDATE OF s`);
      const row = rows[0];
      if (row === undefined) return NO_SESSION;
      if (row.organization_id === organizationId) {
        return {
          ok: false,
          code: "same_organization",
          message: "You are already working in that organization.",
        } as const;
      }
      if (!row.access) return NOT_PERMITTED_HERE;
      await tx.execute(sql`
        INSERT INTO public.sessions
          (id, token_hash, user_id, organization_id, stage, signed_in_at, created_at,
           last_seen_at, rotated_at, password_at, second_step_at, second_step_pass, idle_seconds,
           absolute_seconds, expires_at, client_label)
        SELECT ${newId}::uuid, ${hashSessionToken(newToken)}, o.user_id, ${organizationId}::uuid,
               'full', o.signed_in_at, c.t, c.t, c.t, o.signed_in_at, o.second_step_at,
               o.second_step_pass, o.idle_seconds, o.absolute_seconds, o.expires_at, o.client_label
        FROM public.sessions o, (SELECT clock_timestamp() AS t) c
        WHERE o.id = ${row.id}::uuid`);
      await tx.execute(sql`DELETE FROM public.sessions WHERE id = ${row.id}::uuid`);
      const made = await tx.rows<FullRow>(sql`
        SELECT ${fullColumns(RECENT_AUTHENTICATION_SECONDS)}
        FROM public.sessions s JOIN public.users u ON u.id = s.user_id
        WHERE s.id = ${newId}::uuid`);
      const session = made[0];
      if (session === undefined) return FAILURES.internal_error;
      return { ok: true, token: newToken, session: fullSession(session) } as const;
    });
  } catch (error) {
    return failureFor(error, call);
  }
}

// Re-entering the password (`reauthenticate`) asks for the second step as
// well (D-052), so it lives with the verifier in second-factor.ts.

// ---------------------------------------------------------------------------
// A person's own sessions

/** Most sessions `listSessions` returns (newest use first). */
export const MAX_LISTED_SESSIONS = 200;

/**
 * The signed-in person's own sessions that haven't ended, in every
 * organization, newest use first (ASVS 5.0 7.5.2). Never a token, a hash or
 * a client address; never anyone else's. Needs a full session.
 */
export async function listSessions(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<
  { readonly ok: true; readonly sessions: readonly SessionSummary[] } | NoSession | SessionFailure
> {
  const call = callOptions(options);
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return current;
    const rows = await db.rows<{
      id: SessionId;
      organization_id: OrganizationId | null;
      stage: "second_step" | "full";
      signed_in_at: string;
      last_seen_at: string;
      ends_at: string;
      client_label: string | null;
    }>(sql`
      SELECT s.id::text AS id, s.organization_id::text AS organization_id, s.stage,
             to_char(s.signed_in_at AT TIME ZONE 'UTC', ${ISO}) AS signed_in_at,
             to_char(s.last_seen_at AT TIME ZONE 'UTC', ${ISO}) AS last_seen_at,
             to_char(CASE WHEN s.stage = 'full'
                          THEN least(s.expires_at, s.last_seen_at + make_interval(secs => s.idle_seconds))
                          ELSE s.expires_at END AT TIME ZONE 'UTC', ${ISO}) AS ends_at,
             s.client_label
      FROM public.sessions s
      WHERE s.user_id = ${current.session.userId}::uuid AND ${VALID}
      ORDER BY s.last_seen_at DESC, s.id
      LIMIT ${MAX_LISTED_SESSIONS}`);
    return {
      ok: true,
      sessions: Object.freeze(
        rows.map((r) =>
          Object.freeze({
            sessionId: r.id,
            organizationId: r.organization_id,
            stage: r.stage,
            signedInAt: r.signed_in_at,
            lastSeenAt: r.last_seen_at,
            endsAt: r.ends_at,
            clientLabel: r.client_label,
            current: r.id === current.session.sessionId,
          }),
        ),
      ),
    };
  } catch (error) {
    return failureFor(error, call);
  }
}

/**
 * Signs out: deletes the session `token` names, whatever its stage or
 * state. `ended` says whether there was one; the caller clears the cookie
 * either way.
 */
export async function endSession(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<{ readonly ok: true; readonly ended: boolean } | SessionFailure> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return { ok: true, ended: false };
  try {
    const n = await db.execute(sql`DELETE FROM public.sessions WHERE token_hash = ${hash}`);
    return { ok: true, ended: n > 0 };
  } catch (error) {
    return failureFor(error, call) as SessionFailure;
  }
}

/**
 * Ends one of the signed-in person's own sessions by its ID (from
 * `listSessions`). Anyone else's ID, an ended one or a malformed one is the
 * same `unknown_session`. Needs a full session.
 */
export async function endOwnSession(
  db: Queryable,
  token: unknown,
  sessionId: unknown,
  options: SessionCallOptions = {},
): Promise<Validated<{ readonly ended: true }>> {
  const call = callOptions(options);
  try {
    const current = await resolveSession(db, token, call);
    if (!current.ok) return refused(current.code, current.message);
    if (!isSessionId(sessionId)) {
      return refused("unknown_session", "You have no session by that ID.");
    }
    const n = await db.execute(sql`
      DELETE FROM public.sessions
      WHERE id = ${sessionId}::uuid AND user_id = ${current.session.userId}::uuid`);
    return n === 1
      ? { ok: true, value: { ended: true } }
      : refused("unknown_session", "You have no session by that ID.");
  } catch (error) {
    return refusedFor(error, call);
  }
}

/**
 * "Sign out everywhere else" (D-052, ASVS 5.0 7.4.3): ends every other
 * session of the signed-in person, in every organization and stage. Needs
 * a full session. The user row is locked first, so a session being copied
 * to another organization at the same moment (from a stolen token, say) is
 * either already committed and deleted here, or made after and finds its
 * source gone (review B1).
 */
export async function endOtherSessions(
  db: Database,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<{ readonly ok: true; readonly ended: number } | NoSession | SessionFailure> {
  const call = callOptions(options);
  const hash = tokenHash(token);
  if (hash === undefined) return NO_SESSION;
  try {
    return await inTransaction(db, async (tx) => {
      if ((await lockUserOf(tx, hash, "update")) === undefined) return NO_SESSION;
      const current = await resolveSession(tx, token, call);
      if (!current.ok) return current;
      const ended = await tx.execute(sql`
        DELETE FROM public.sessions
        WHERE user_id = ${current.session.userId}::uuid
          AND id <> ${current.session.sessionId}::uuid`);
      return { ok: true, ended } as const;
    });
  } catch (error) {
    return failureFor(error, call);
  }
}

/**
 * Ends every session of `userId` at once, inside the caller's transaction:
 * locks the user row, deletes the sessions, and moves
 * `sessions_valid_after` to now, so any session signed in until now is dead
 * even if made at this moment by another transaction. For T-039's password
 * reset and `endUserSessions`; it checks no permission. Returns how many
 * rows went. Not exported from `@oculus/db`.
 */
export async function endAllSessionsForUser(tx: Queryable, userId: UserId): Promise<number> {
  await tx.rows(sql`SELECT 1 FROM public.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`);
  // Counted while the user row is locked, so no session is made meanwhile.
  const counted = await tx.rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.sessions WHERE user_id = ${userId}::uuid`);
  // The time first, while the sessions are still there, so the trigger
  // moves it past any stamped ahead of the clock (second review, item 2);
  // its AFTER trigger then deletes them all.
  await tx.execute(sql`
    UPDATE public.users SET sessions_valid_after = greatest(sessions_valid_after, clock_timestamp())
    WHERE id = ${userId}::uuid`);
  // In case the time didn't move (already ahead of the clock).
  await tx.execute(sql`DELETE FROM public.sessions WHERE user_id = ${userId}::uuid`);
  return counted[0]?.n ?? 0;
}

/**
 * T-048 (D-084): the `memberOf` option of `endUserSessions`,
 * `resetSecondFactor` and `sendPasswordReset`: an organization ID, or
 * `undefined` when not given; anything else is a TypeError.
 */
export function memberOfOption(options: unknown): OrganizationId | undefined {
  const value = own(options, "memberOf");
  if (value === undefined) return undefined;
  if (!isOrganizationId(value)) throw new TypeError("memberOf is an organization ID.");
  return value;
}

/** Whether `userId` is a member of `organizationId`, read in the caller's transaction. */
export async function isMemberIn(
  tx: Queryable,
  organizationId: OrganizationId,
  userId: UserId,
): Promise<boolean> {
  const rows = await tx.rows(sql`
    SELECT 1 FROM public.organization_members
    WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`);
  return rows.length > 0;
}

/**
 * The live full session whose token hashes to `hash`, as the person acting
 * through it: their user ID, whether they are a system admin and whether
 * they entered their password in the last 10 minutes. Read without locking
 * or refreshing the session (second review, item 1), in the caller's
 * transaction. For `endUserSessions` and password-resets.ts's admin reset;
 * not exported from `@oculus/db`.
 */
export async function readActingSession(
  tx: Queryable,
  hash: Uint8Array,
): Promise<{ userId: UserId; systemAdmin: boolean; recent: boolean } | undefined> {
  const rows = await tx.rows<{ user_id: UserId; system_admin: boolean; recent: boolean }>(sql`
    SELECT s.user_id::text AS user_id, u.system_admin,
           s.password_at > clock_timestamp()
             - make_interval(secs => ${RECENT_AUTHENTICATION_SECONDS}) AS recent
    FROM public.sessions s JOIN public.users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND ${LIVE_FULL}`);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { userId: row.user_id, systemAdmin: row.system_admin, recent: row.recent };
}

/**
 * Ends every session of `userId` (ASVS 5.0 7.4.5), for a system admin
 * acting from their own full session (`adminToken`), who must have entered
 * their password in the last 10 minutes (`reauthentication_required`,
 * D-052's rule for sensitive changes). If it is their own account, their own
 * session ends too. Returns how many ended.
 *
 * The admin's session is read, not locked or refreshed, so the only row
 * lock taken is the target user row's, first (second review, item 1: a
 * locked admin session row before the user row deadlocked with
 * `endOtherSessions` and switching). The read is in the same transaction as
 * the ending; an admin disabled or signed out at that moment can at worst
 * finish this one request.
 */
export async function endUserSessions(
  db: Database,
  adminToken: unknown,
  userId: unknown,
  options: SessionCallOptions & { readonly memberOf?: string } = {},
): Promise<Validated<{ readonly ended: number }>> {
  const call = callOptions(options, ["memberOf"]);
  const memberOf = memberOfOption(options);
  if (!isUserId(userId)) return refused("invalid_request", "That isn't a user ID.");
  const hash = tokenHash(adminToken);
  if (hash === undefined) return refused(NO_SESSION.code, NO_SESSION.message);
  try {
    return await inTransaction(db, async (tx) => {
      const admin = await readActingSession(tx, hash);
      if (admin === undefined) return refused(NO_SESSION.code, NO_SESSION.message);
      if (!admin.systemAdmin) return refused("not_permitted", "Only a system admin can do that.");
      if (!admin.recent) {
        return refused(
          "reauthentication_required",
          "Enter your password again to end someone's sessions.",
        );
      }
      // T-048: with memberOf, only a member of that organization, read in
      // this same transaction (no gap between the check and the ending).
      if (memberOf !== undefined && !(await isMemberIn(tx, memberOf, userId))) {
        return refused("unknown_user", "There is no such user.");
      }
      const ended = await endAllSessionsForUser(tx, userId);
      return { ok: true, value: { ended } };
    });
  } catch (error) {
    return refusedFor(error, call);
  }
}

// ---------------------------------------------------------------------------
// Cleanup

/**
 * Deletes sessions that have ended: past their absolute end, (full ones)
 * unused for longer than their idle limit, or no longer allowed
 * (`session_access_ok`: a disabled account, a sign-in before
 * `sessions_valid_after`, a lost membership). Returns how many went.
 * Lookups refuse them anyway; this only keeps the table small. Database
 * errors are thrown (the command reports only their SQLSTATE).
 */
export async function deleteExpiredSessions(db: Queryable): Promise<number> {
  return db.execute(sql`DELETE FROM public.sessions s WHERE NOT (${VALID})`);
}

/**
 * Deletes password reset links that ended more than a day ago (D-078): every
 * link ends at most an hour after it was made, used, revoked or expired, so
 * a day past its end it is only a record. Returns how many went.
 */
export async function deleteOldPasswordResets(db: Queryable): Promise<number> {
  return db.execute(sql`
    DELETE FROM public.password_resets
    WHERE expires_at < clock_timestamp() - interval '1 day'`);
}

/** What `runCleanup` removed. */
export interface CleanupResult {
  readonly sessions: number;
  readonly signInThrottles: number;
  readonly passwordResets: number;
  /** Wrong-code counters (T-038) a day old (unexplained ones, S-045: 30 days), and those of sessions that have ended. */
  readonly secondStepThrottles: number;
  /** Alerts written for unexplained wrong codes an hour old (S-045). */
  readonly secondStepAlerts: number;
}

/**
 * How long wrong TOTP codes that no right code in their session explained
 * are kept (S-045, D-077): 30 days without a new code.
 */
export const WRONG_CODE_MEMORY_SECONDS = 30 * 24 * 60 * 60;

/**
 * Unexplained wrong codes this old are told by the cleanup command (S-045):
 * a waiting session lives 10 minutes, so no right code can explain them now.
 */
export const UNEXPLAINED_TOLD_AFTER_SECONDS = 60 * 60;

/**
 * The cleanup command's work (`npm run db:cleanup`, D-035: any scheduler can
 * run it, hourly is plenty): ended sessions, sign-in and reset counters no
 * longer needed (D-068) and reset links a day past their end (D-078). Run it
 * as the writer role.
 */
export async function runCleanup(db: Queryable): Promise<CleanupResult> {
  const sessions = await deleteExpiredSessions(db);
  const signInThrottles = await deleteExpiredSignInThrottles(db);
  // core's SECOND_STEP_THROTTLE forgets a counter after a day without a
  // failure; a waiting session's counter is useless once the session is gone.
  // A person's unexplained wrong codes (`wrong:`, S-045) an hour old can't
  // be explained any more (a waiting session lives 10 minutes): they are told
  // now, as an alert, and taken off; the row itself is kept 30 days.
  const told = await db.rows<{ n: number }>(sql`
    WITH old AS (
      SELECT key, failures FROM public.second_step_throttles
      WHERE key LIKE 'wrong:%' AND failures > 0
        AND last_failure_at < clock_timestamp() - make_interval(secs => ${UNEXPLAINED_TOLD_AFTER_SECONDS})
      ORDER BY key FOR UPDATE
    ), cleared AS (
      UPDATE public.second_step_throttles t SET failures = 0
      FROM old WHERE t.key = old.key RETURNING old.key, old.failures
    ), alerted AS (
      INSERT INTO public.second_step_alerts (id, user_id, failures)
      SELECT gen_random_uuid(), u.id, c.failures
      FROM cleared c JOIN public.users u ON 'wrong:' || u.id::text = c.key
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM alerted`);
  const secondStepAlerts = told[0]?.n ?? 0;
  // Locked in key order first (S-054a), as a code attempt locks its
  // counters: a delete in the table's own order could hold `wrong:` while
  // waiting on the same person's `user:`, which an attempt holds while
  // waiting on `wrong:`.
  const secondStepThrottles = await db.execute(sql`
    WITH gone AS (
      SELECT t.key FROM public.second_step_throttles t
      WHERE t.last_failure_at IS NULL
         OR (t.key NOT LIKE 'wrong:%' AND t.last_failure_at < clock_timestamp() - interval '1 day')
         OR (t.key LIKE 'wrong:%'
             AND t.last_failure_at < clock_timestamp() - make_interval(secs => ${WRONG_CODE_MEMORY_SECONDS}))
         OR (t.key LIKE 'session:%' AND NOT EXISTS (
               SELECT 1 FROM public.sessions s WHERE 'session:' || s.id::text = t.key))
      ORDER BY t.key FOR UPDATE OF t
    )
    DELETE FROM public.second_step_throttles t USING gone WHERE t.key = gone.key`);
  const passwordResets = await deleteOldPasswordResets(db);
  return Object.freeze({
    sessions,
    signInThrottles,
    secondStepThrottles,
    secondStepAlerts,
    passwordResets,
  });
}
