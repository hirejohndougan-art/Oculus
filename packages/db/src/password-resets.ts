/**
 * Password reset links (T-039, D-052, D-068, D-069, D-078). The table is
 * `0015_password_resets.sql`'s; tokens, lives and throttle rules are core's
 * `password-reset.ts`, password rules core's `passwords.ts`.
 *
 * - **Asking for a link** (`requestPasswordReset`) takes an address typed
 *   and the client address. It counts the request on the reset counters
 *   (per address typed and per client address, D-068's throttle with rules
 *   of its own) and answers at once with the one frozen `RESET_REQUESTED`,
 *   whatever the address: an account, no account, a disabled one or one with
 *   no organization. Everything that depends on the account (looking it up,
 *   storing the link, sending it) happens **after** the reply, in the
 *   background, so the reply and its timing are the same for every address
 *   (ASVS 5.0 6.3.8 applied to resets; OWASP Forgot Password cheat sheet).
 *   The background work starts after a random 1–10 s wait and does dummy
 *   work of the same shape for an address with no usable account, so it
 *   doesn't show in the next request's timing either (review L1).
 * - **A link** is a 256-bit token in one spelling, stored only as SHA-256,
 *   lasting 30 minutes by default (5 to 60), one pending per account (a
 *   newer one revokes the older), committed before it is sent and sent
 *   through a `deliver` function with a time limit, as invitations are
 *   (D-068). A link that couldn't be sent is revoked. **The token goes only
 *   into the message for the account's own address**: never into a reply, a
 *   log, an error or a callback (D-068's secrecy rule).
 * - **Using a link** (`completePasswordReset`) takes the token and a new
 *   password (D-068's rules: NFC, length, common passwords, context words),
 *   and in one transaction consumes the token, sets the new hash and ends
 *   every session of the account (`endAllSessionsForUser`, which moves
 *   `sessions_valid_after`, D-069). It **does not sign the person in**: they
 *   sign in afresh, with their second step. It does not remove the second
 *   factor (only an admin's reset of two-step sign-in does, T-038).
 * - **A system admin** can send the same kind of link to someone
 *   (`sendPasswordReset`), from their own full session with the password
 *   entered in the last 10 minutes (D-052). Their reply says what happened,
 *   since they already know the account exists.
 */
import {
  DEFAULT_RESET_SECONDS,
  PasswordWorkBusyError,
  RESET_ACCOUNT_THROTTLE,
  RESET_NETWORK_THROTTLE,
  RESET_SOURCE_THROTTLE,
  checkNewPassword,
  hashPassword,
  hashResetToken,
  hashSessionToken,
  isPlainObject,
  isResetLife,
  isResetToken,
  isSessionToken,
  isUserId,
  newResetToken,
  normalizeEmail,
  passwordText,
  resetThrottleAccountKey,
  resetThrottleNetworkKey,
  resetThrottleSourceKey,
  throttleAccountKey,
  type Issue,
  type UserId,
  type Validated,
} from "@oculus/core";
import { randomInt } from "node:crypto";
import {
  DEFAULT_DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_TIMEOUT_MS,
  deliverWithin,
  takeAttempt,
} from "./accounts.js";
import { isDatabaseFailure, type Database, type Queryable } from "./client.js";
import {
  endAllSessionsForUser,
  failureFor,
  isMemberIn,
  memberOfOption,
  readActingSession,
} from "./sessions.js";
import { sql } from "./sql.js";

/**
 * What the writer role needs on `password_resets`, beyond SELECT (D-067,
 * D-078): INSERT (a new link), UPDATE (use, revoke; also what
 * `SELECT … FOR UPDATE` needs) and DELETE (the cleanup). The reset counters
 * live in `sign_in_throttles`, whose grants D-068 already gives.
 */
export const PASSWORD_RESET_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    password_resets: Object.freeze(["INSERT", "UPDATE", "DELETE"]),
  });

// ---------------------------------------------------------------------------
// Types

/** What is handed to the delivery: the only place a reset token goes. */
export interface PasswordResetMessage {
  /** The account's own address, the only one a link is ever sent to. */
  readonly email: string;
  readonly token: string;
  /** In core's form, `2026-11-24T17:35:00.000Z`. */
  readonly expiresAt: string;
  /** Who asked: the person (from the sign-in page) or a system admin. */
  readonly requestedBy: "self" | "system_admin";
}

/**
 * Sends a reset link to the account's address (T-040 builds the email one;
 * tests use a double). Called after the link is committed, outside any
 * transaction, with a time limit: `signal` aborts at the limit. If it
 * throws, rejects or runs out of time, the link is revoked. It must never
 * show, log or keep the token anywhere but the message to that address
 * (D-068); what it throws is dropped unread, since it might hold the token.
 */
export type PasswordResetDelivery = (
  message: PasswordResetMessage,
  signal: AbortSignal,
) => Promise<void>;

/**
 * What became of a request, after the reply (for the server's log; never
 * shown to the person who asked, and never holding the token or address):
 * - `sent`: a link was stored and sent;
 * - `not_sent`: no account there can use one (none, disabled, no
 *   organization, or a malformed address);
 * - `needs_admin`: the account has no second factor in use (never set up,
 *   or reset by a system admin), so no link is sent: a mailbox alone must
 *   not lead to a new password *and* a new authenticator. A system admin can
 *   still `sendPasswordReset` (D-078, review L7);
 * - `delivery_failed`: stored, not sent, and revoked;
 * - `delivery_failed_may_be_pending`: not sent, and the revocation failed
 *   twice (the link was shown to nobody and expires within the hour);
 * - `busy`: too many requests were being handled at once; nothing was done
 *   (also reported to `onError`, so the log shows it loudly);
 * - `database_unavailable`: the database failed before a link was stored.
 */
export type ResetOutcome =
  | "sent"
  | "not_sent"
  | "needs_admin"
  | "delivery_failed"
  | "delivery_failed_may_be_pending"
  | "busy"
  | "database_unavailable";

/** Options for `requestPasswordReset`. */
export interface ResetRequestOptions {
  /** How long the link lasts: 300 to 3,600 seconds, 1,800 by default. */
  readonly lifeSeconds?: number;
  /** How long `deliver` may take (default 30 s, at most 5 minutes). */
  readonly deliveryTimeoutMs?: number;
  /**
   * The background work starts after a random wait in this range, in
   * milliseconds (default 1,000 to 10,000; 0 to 60,000 allowed): so it
   * doesn't land on the next request (D-078, review L1). Tests pass 0.
   */
  readonly backgroundDelayMs?: { readonly min: number; readonly max: number };
  /** Called once, after the background work, with what became of it. A throw is ignored. */
  readonly onSettled?: (outcome: ResetOutcome) => void;
  /**
   * Gets a database error before it becomes a fixed answer (for the
   * server's log). Never gets anything `deliver` threw. A throw is ignored.
   */
  readonly onError?: (error: unknown) => void;
}

/** What `requestPasswordReset` takes: the form and the client address (D-058). */
export interface ResetRequest {
  readonly email: string;
  readonly source: string;
}

/** The reply to a reset request. The same for every address that isn't throttled. */
export type ResetRequestReply =
  | { readonly ok: true; readonly code: "requested"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "throttled";
      readonly message: string;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "retry" | "timeout" | "database_unavailable";
      readonly message: string;
    };

/** The one reply to every reset request let through, whatever the address. */
export const RESET_REQUESTED: ResetRequestReply = Object.freeze({
  ok: true,
  code: "requested",
  message:
    "If that address belongs to an account that can sign in, a link to choose a new password is on its way to it. The link works once, for a short time.",
});

const INVALID_RESET_REQUEST: ResetRequestReply = Object.freeze({
  ok: false,
  code: "invalid_request",
  message: "Give an email address and the client address.",
});

// ---------------------------------------------------------------------------
// Small helpers

function own(input: unknown, key: string): unknown {
  if (!isPlainObject(input)) return undefined;
  const d = Object.getOwnPropertyDescriptor(input, key);
  return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
}

function hasOnly(input: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(input)) return false;
  return Reflect.ownKeys(input).every((k) => typeof k === "string" && keys.includes(k));
}

function refused<T>(code: string, message: string, path: (string | number)[] = []): Validated<T> {
  return { ok: false, issues: [{ path, code, message }] };
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

/** A refusal by 0015's own checks (the account or the link changed at that very moment). */
function resetGuardRefused(error: unknown): boolean {
  const state = sqlState(error);
  return (
    (state === "23000" || state === "23514" || state === "23505") &&
    constraintOf(error)?.startsWith("password_resets_") === true
  );
}

const RETRYABLE = new Set(["40P01", "40001"]);

async function inTransaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (attempt >= 3 || !RETRYABLE.has(sqlState(error) ?? "")) throw error;
    }
  }
}

/** Calls a caller's hook, ignoring anything it throws. */
function notify<A>(hook: ((arg: A) => void) | undefined, arg: A): void {
  try {
    hook?.(arg);
  } catch {
    // The log's own failure changes nothing.
  }
}

interface CheckedOptions {
  readonly life: number;
  readonly timeoutMs: number;
  readonly delay: { readonly min: number; readonly max: number };
  readonly onSettled?: (outcome: ResetOutcome) => void;
  readonly onError?: (error: unknown) => void;
}

function checkOptions(options: unknown, allowed: readonly string[]): CheckedOptions {
  const life = own(options, "lifeSeconds") ?? DEFAULT_RESET_SECONDS;
  const timeoutMs = own(options, "deliveryTimeoutMs") ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const onSettled = own(options, "onSettled");
  const onError = own(options, "onError");
  const delay = own(options, "backgroundDelayMs") ?? DEFAULT_BACKGROUND_DELAY_MS;
  const delayMin = own(delay, "min");
  const delayMax = own(delay, "max");
  if (
    (options !== undefined && !hasOnly(options, allowed)) ||
    !hasOnly(delay, ["min", "max"]) ||
    typeof delayMin !== "number" ||
    typeof delayMax !== "number" ||
    !Number.isInteger(delayMin) ||
    !Number.isInteger(delayMax) ||
    delayMin < 0 ||
    delayMin > delayMax ||
    delayMax > 60_000 ||
    !isResetLife(life) ||
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_DELIVERY_TIMEOUT_MS ||
    (onSettled !== undefined && typeof onSettled !== "function") ||
    (onError !== undefined && typeof onError !== "function")
  ) {
    throw new TypeError(
      `Reset options are ${allowed.join(", ")}: a life of 300 to 3,600 whole seconds, a delivery time limit of 1 to 300,000 ms, a background delay { min, max } within 0 to 60,000 ms, and functions.`,
    );
  }
  return {
    life,
    timeoutMs,
    delay: { min: delayMin, max: delayMax },
    ...(onSettled === undefined ? {} : { onSettled: onSettled as (outcome: ResetOutcome) => void }),
    ...(onError === undefined ? {} : { onError: onError as (error: unknown) => void }),
  };
}

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** The default wait before a request's background work: 1 to 10 seconds. */
export const DEFAULT_BACKGROUND_DELAY_MS = Object.freeze({ min: 1_000, max: 10_000 });

/** A user ID no account has (version 4 shape, all zero bits), for dummy work. */
const NO_USER = "00000000-0000-4000-8000-000000000000";

/**
 * The statements `storeReset` runs, on an ID no account has: so a request
 * for an address with no usable account does work of the same shape (a
 * locking read of users, an UPDATE of password_resets) in the background
 * as one for an account (review L1). Only the INSERT is missing.
 */
async function dummyStore(tx: Queryable): Promise<void> {
  await tx.rows(sql`
    SELECT public.password_reset_user_ok(id, clock_timestamp()) AS ok
    FROM public.users WHERE id = ${NO_USER}::uuid FOR NO KEY UPDATE`);
  await revokePending(tx, NO_USER);
}

async function revokePending(tx: Queryable, userId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.password_resets
    SET revoked_at = clock_timestamp(), revoked_reason = 'superseded'
    WHERE user_id = ${userId}::uuid AND used_at IS NULL AND revoked_at IS NULL`);
}

/**
 * Stores a new pending link for `userId` in the caller's transaction, after
 * locking the user row (`FOR NO KEY UPDATE`, the order every reset path and
 * `endAllSessionsForUser` use: the user row, then reset or session rows):
 * any pending link of the account is revoked as `superseded` first, then
 * the new one is made by the database's clock, so it is after any password
 * change or "end all" that committed before the lock. Returns its expiry,
 * or `undefined` if the account can't be sent one (no such account,
 * disabled, can't sign in, or changed meanwhile), or `"needs_admin"` for a
 * link the person asked for (`requestedBy` null) when the account has no
 * second factor in use (D-078, review L7; the insert trigger refuses it too).
 */
async function storeReset(
  tx: Queryable,
  userId: UserId,
  tokenHash: Uint8Array,
  requestedBy: UserId | null,
  life: number,
): Promise<{ resetId: string; expiresAt: string } | "needs_admin" | undefined> {
  const users = await tx.rows<{ ok: boolean; factor: boolean }>(sql`
    SELECT public.password_reset_user_ok(id, clock_timestamp()) AS ok,
           public.password_reset_has_factor(id) AS factor
    FROM public.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`);
  if (users[0]?.ok !== true || (requestedBy === null && !users[0].factor)) {
    // The same shape of work as a link being made (review L1).
    await revokePending(tx, NO_USER);
    return users[0]?.ok === true ? "needs_admin" : undefined;
  }
  await revokePending(tx, userId);
  const made = await tx.rows<{ id: string; expires_at: string }>(sql`
    INSERT INTO public.password_resets (id, user_id, token_hash, requested_by, created_at, expires_at)
    SELECT gen_random_uuid(), ${userId}::uuid, ${tokenHash}, ${requestedBy}::uuid,
           c.t, c.t + make_interval(secs => ${life})
    FROM (SELECT clock_timestamp() AS t) c
    RETURNING id::text AS id, to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at`);
  const row = made[0];
  if (row === undefined) throw new Error("The reset link was not stored.");
  return { resetId: row.id, expiresAt: row.expires_at };
}

/**
 * Sends a stored link, with the time limit; if it isn't sent, revokes it
 * (twice at most, as invitations do, S-016). `true` if sent.
 */
async function deliverStored(
  db: Database,
  resetId: string,
  message: PasswordResetMessage,
  deliver: PasswordResetDelivery,
  options: CheckedOptions,
): Promise<"sent" | "delivery_failed" | "delivery_failed_may_be_pending"> {
  if (await deliverWithin(deliver, message, options.timeoutMs)) return "sent";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await inTransaction(db, (tx) =>
        tx.execute(sql`
          UPDATE public.password_resets
          SET revoked_at = clock_timestamp(), revoked_reason = 'delivery_failed'
          WHERE id = ${resetId}::uuid AND used_at IS NULL AND revoked_at IS NULL`),
      );
      return "delivery_failed";
    } catch (error) {
      if (!isDatabaseFailure(error)) throw error;
      notify(options.onError, error);
    }
  }
  return "delivery_failed_may_be_pending";
}

// ---------------------------------------------------------------------------
// Asking for a link

/**
 * Most reset requests worked on (database and send) at once in a process.
 * A slot is taken only when the work starts, after the random wait; work
 * that finds them all taken waits again (`RESET_WORK_RETRIES` times, a
 * random 0.5 to 2 s each) and is dropped as `busy` only after that (second
 * review, M1).
 */
export const MAX_RESET_WORK = 32;
/** Most requests waiting to start (their timers) at once; beyond, `busy` at once. */
export const MAX_WAITING_RESETS = 10_000;
/** How many times work that finds every slot taken waits again before it is dropped. */
export const RESET_WORK_RETRIES = 5;
let resetWork = 0;
let resetWaiting = 0;

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks for a reset link for the address typed (the "Forgot your password?"
 * form). In order:
 * 1. The request's shape (`invalid_request`: not text, absurdly long, NUL,
 *    or not well-formed text). Says nothing about any account.
 * 2. The reset counters (`throttled`, with `retryAfterSeconds`): one per
 *    address typed (lower case, whether or not an account has it), one
 *    per client address and, for IPv6, one per /48, counted now. Every
 *    request counts.
 * 3. The reply, **`RESET_REQUESTED`, the same object for every address**,
 *    before anything about the account is read.
 * 4. Then, in the background: if an active account that can sign in has
 *    that address, a new link is stored (revoking any older one), committed,
 *    and sent with `deliver`; a link that can't be sent is revoked.
 *    `onSettled` hears what became of it (never the token or the address).
 *
 * A database failure while counting is a fixed `retry`, `timeout` or
 * `database_unavailable` (the raw error to `onError` only); programming
 * errors are thrown. Background failures never throw: they go to
 * `onError` and `onSettled`.
 */
export async function requestPasswordReset(
  db: Database,
  input: ResetRequest,
  deliver: PasswordResetDelivery,
  options: ResetRequestOptions = {},
): Promise<ResetRequestReply> {
  if (typeof deliver !== "function") throw new TypeError("requestPasswordReset needs a delivery.");
  const checked = checkOptions(options, [
    "lifeSeconds",
    "deliveryTimeoutMs",
    "backgroundDelayMs",
    "onSettled",
    "onError",
  ]);
  if (!hasOnly(input, ["email", "source"])) return INVALID_RESET_REQUEST;
  const typed = own(input, "email");
  const source = own(input, "source");
  if (
    typeof typed !== "string" ||
    typed.length > 1024 ||
    typeof source !== "string" ||
    typed.includes("\u0000") ||
    passwordText(typed) === undefined
  ) {
    return INVALID_RESET_REQUEST;
  }
  let attempt: Awaited<ReturnType<typeof takeAttempt>>;
  // IPv6 clients are counted per /48 too, so one site's 65,536 /64s don't
  // each get the free requests (second review, M1).
  const network = resetThrottleNetworkKey(source);
  try {
    attempt = await takeAttempt(
      db,
      resetThrottleAccountKey(typed),
      resetThrottleSourceKey(source),
      {
        account: RESET_ACCOUNT_THROTTLE,
        source: RESET_SOURCE_THROTTLE,
      },
      network === undefined ? [] : [{ key: network, rule: RESET_NETWORK_THROTTLE }],
    );
  } catch (error) {
    const failure = failureFor(
      error,
      checked.onError === undefined ? {} : { onError: checked.onError },
    );
    if (failure.code === "no_session") throw error;
    return failure as ResetRequestReply;
  }
  if (!attempt.allowed) {
    return {
      ok: false,
      code: "throttled",
      message: "Too many requests for a new password. Wait a little and try again.",
      retryAfterSeconds: attempt.retryAfterSeconds,
    };
  }
  // Everything that depends on the account happens after the reply.
  const email = normalizeEmail(typed);
  const dropped = (why: string): ResetOutcome => {
    // Loudly: a request was answered but dropped (review L4).
    notify(
      checked.onError,
      new Error(`Password reset work is full: ${why}; a request was answered but not worked on.`),
    );
    return "busy";
  };
  if (resetWaiting >= MAX_WAITING_RESETS) {
    queueMicrotask(() => {
      notify(checked.onSettled, dropped(`${String(MAX_WAITING_RESETS)} requests waiting`));
    });
    return RESET_REQUESTED;
  }
  resetWaiting += 1;
  void (async (): Promise<ResetOutcome> => {
    // Let the reply go first, then wait a random while, so the work doesn't
    // land on (and slow) the next request the same client sends (review L1).
    // Waiting holds no work slot (second review, M1).
    let waiting = true;
    try {
      const { min, max } = checked.delay;
      await waitMs(min === max ? min : randomInt(min, max + 1));
      for (let retry = 0; resetWork >= MAX_RESET_WORK; retry++) {
        if (retry >= RESET_WORK_RETRIES) {
          return dropped(
            `${String(MAX_RESET_WORK)} at work after ${String(RESET_WORK_RETRIES)} more waits`,
          );
        }
        await waitMs(randomInt(500, 2001));
      }
      resetWaiting -= 1;
      waiting = false;
      resetWork += 1;
    } finally {
      if (waiting) resetWaiting -= 1;
    }
    try {
      if (email === undefined) {
        // The same shape of work as for an address with no account (review L1).
        await inTransaction(db, dummyStore);
        return "not_sent";
      }
      return await sendToAddress(db, email, deliver, checked);
    } finally {
      resetWork -= 1;
    }
  })()
    .catch((error: unknown): ResetOutcome => {
      // A programming error or a database failure must not crash the process
      // from the background; it goes to the log hook.
      notify(checked.onError, error);
      return "database_unavailable";
    })
    .then((outcome) => {
      notify(checked.onSettled, outcome);
    });
  return RESET_REQUESTED;
}

/** The background half of `requestPasswordReset`. */
async function sendToAddress(
  db: Database,
  email: string,
  deliver: PasswordResetDelivery,
  options: CheckedOptions,
): Promise<ResetOutcome> {
  const token = newResetToken();
  let stored: { resetId: string; expiresAt: string } | "needs_admin" | undefined;
  try {
    stored = await inTransaction(db, async (tx) => {
      const found = await tx.rows<{ id: UserId }>(sql`
        SELECT id::text AS id FROM public.users WHERE email = ${email}`);
      const userId = found[0]?.id;
      if (userId === undefined) {
        await dummyStore(tx);
        return undefined;
      }
      return storeReset(tx, userId, hashResetToken(token), null, options.life);
    });
  } catch (error) {
    if (resetGuardRefused(error)) return "not_sent";
    if (!isDatabaseFailure(error)) throw error;
    notify(options.onError, error);
    return "database_unavailable";
  }
  if (stored === undefined) return "not_sent";
  if (stored === "needs_admin") return "needs_admin";
  return deliverStored(
    db,
    stored.resetId,
    { email, token, expiresAt: stored.expiresAt, requestedBy: "self" },
    deliver,
    options,
  );
}

// ---------------------------------------------------------------------------
// A system admin sends a link

/** Options for `sendPasswordReset`. */
export interface AdminResetOptions {
  /** Only a member of this organization (T-048), checked in the link's own transaction. */
  readonly memberOf?: string;
  readonly lifeSeconds?: number;
  readonly deliveryTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * A system admin sends `userId` a reset link (D-019: system managers reset
 * passwords), acting from their own full session (`adminToken`) with their
 * password entered in the last 10 minutes (D-052). The link is the same
 * kind as a self-service one, sent to the account's own address only; the
 * admin never sees it. It doesn't end the account's sessions or change its
 * password until it is used (`endUserSessions` ends sessions at once if the
 * account may be in someone else's hands).
 *
 * Answers: `ok` with the expiry (stored, sent and still pending);
 * `no_session`, `not_permitted`, `reauthentication_required`;
 * `unknown_user`, `account_disabled`, `cannot_sign_in` (no organization);
 * `account_changed` (disabled or its password changed at that very moment);
 * `superseded` (a newer link replaced it while it was sent; the newer one
 * works); `delivery_failed` (not sent, revoked);
 * `delivery_failed_may_be_pending`; `retry`, `timeout`,
 * `database_unavailable`.
 */
export async function sendPasswordReset(
  db: Database,
  adminToken: unknown,
  userId: unknown,
  deliver: PasswordResetDelivery,
  options: AdminResetOptions = {},
): Promise<Validated<{ readonly expiresAt: string }>> {
  if (typeof deliver !== "function") throw new TypeError("sendPasswordReset needs a delivery.");
  const checked = checkOptions(options, [
    "lifeSeconds",
    "deliveryTimeoutMs",
    "onError",
    "memberOf",
  ]);
  const memberOf = memberOfOption(options);
  const call = checked.onError === undefined ? {} : { onError: checked.onError };
  if (!isUserId(userId)) return refused("invalid_request", "That isn't a user ID.");
  if (!isSessionToken(adminToken)) return refused("no_session", NO_SESSION_MESSAGE);
  const adminHash = hashSessionToken(adminToken);
  const token = newResetToken();
  let stored: Validated<{ resetId: string; expiresAt: string; email: string }>;
  try {
    stored = await inTransaction(
      db,
      async (tx): Promise<Validated<{ resetId: string; expiresAt: string; email: string }>> => {
        const admin = await readActingSession(tx, adminHash);
        if (admin === undefined) return refused("no_session", NO_SESSION_MESSAGE);
        if (!admin.systemAdmin) return refused("not_permitted", "Only a system admin can do that.");
        if (!admin.recent) {
          return refused(
            "reauthentication_required",
            "Enter your password again to send someone a reset link.",
          );
        }
        const users = await tx.rows<{ email: string; disabled: boolean; can_sign_in: boolean }>(sql`
          SELECT u.email, u.disabled_at IS NOT NULL AS disabled,
                 (u.system_admin OR EXISTS (SELECT 1 FROM public.organization_members m
                                            WHERE m.user_id = u.id)) AS can_sign_in
          FROM public.users u WHERE u.id = ${userId}::uuid`);
        const user = users[0];
        if (user === undefined) return refused("unknown_user", "There is no such account.");
        if (memberOf !== undefined && !(await isMemberIn(tx, memberOf, userId))) {
          return refused("unknown_user", "There is no such account.");
        }
        if (user.disabled) {
          return refused("account_disabled", "That account is disabled; enable it first.");
        }
        if (!user.can_sign_in) {
          return refused(
            "cannot_sign_in",
            "That account isn't in any organization, so it can't sign in.",
          );
        }
        const made = await storeReset(
          tx,
          userId,
          hashResetToken(token),
          admin.userId,
          checked.life,
        );
        if (made === undefined || made === "needs_admin") {
          return refused("account_changed", "That account changed just now. Try again.");
        }
        return { ok: true, value: { ...made, email: user.email } };
      },
    );
  } catch (error) {
    if (resetGuardRefused(error)) {
      return refused("account_changed", "That account changed just now. Try again.");
    }
    const failure = failureFor(error, call);
    return refused(failure.code, failure.message);
  }
  if (!stored.ok) return stored;
  const { resetId, expiresAt, email } = stored.value;
  const sent = await deliverStored(
    db,
    resetId,
    { email, token, expiresAt, requestedBy: "system_admin" },
    deliver,
    checked,
  );
  if (sent === "delivery_failed") {
    return refused(
      "delivery_failed",
      "The reset link couldn't be sent, so it was withdrawn. Try again later.",
    );
  }
  if (sent === "delivery_failed_may_be_pending") {
    return refused(
      "delivery_failed_may_be_pending",
      "The reset link couldn't be sent, and it couldn't be withdrawn either; it expires within the hour. Sending a new one replaces it.",
    );
  }
  // A newer link (the person's own request, say) may have replaced it while
  // it was being sent.
  try {
    const rows = await db.rows<{ superseded: boolean }>(sql`
      SELECT revoked_reason = 'superseded' AS superseded
      FROM public.password_resets WHERE id = ${resetId}::uuid`);
    if (rows[0]?.superseded === true) {
      return refused(
        "superseded",
        "A newer reset link replaced this one while it was being sent; the newer one works.",
      );
    }
  } catch (error) {
    // It was stored and sent, which is the answer.
    if (!isDatabaseFailure(error)) throw error;
    notify(checked.onError, error);
  }
  return { ok: true, value: { expiresAt } };
}

const NO_SESSION_MESSAGE = "You are not signed in, or your session has ended. Sign in again.";

// ---------------------------------------------------------------------------
// Using a link

/** What `completePasswordReset` takes: the token from the link and the new password. */
export interface ResetCompletion {
  readonly token: string;
  readonly password: string;
}

const INVALID_RESET = "This reset link can't be used. Ask for a new one.";
const BUSY_MESSAGE = "Too many passwords are being checked right now. Try again in a moment.";

/**
 * Sets a new password with a reset link. Every reason a link can't be used
 * (unknown, malformed, used, revoked, replaced by a newer one, expired, an
 * account disabled, without an organization, or whose password or sessions
 * changed since the link was made) gives the same `invalid_reset`. Then the
 * new password is checked by D-068's rules (`password`-path issues: too
 * short or long, common, mostly context words such as the person's name,
 * address or organization), in NFC. Then, in one transaction with the user
 * row locked: the link is consumed (only if still usable), the new hash and
 * `password_changed_at` are written, every session of the account ends
 * (`endAllSessionsForUser`). After the commit the address's sign-in and
 * reset counters are cleared (D-068). Nobody is signed in: the reply carries
 * no session or token.
 *
 * `busy` if too many passwords are being hashed; `retry`, `timeout` or
 * `database_unavailable` for database failures (raw error to `onError`).
 */
export async function completePasswordReset(
  db: Database,
  input: ResetCompletion,
  options: { readonly onError?: (error: unknown) => void } = {},
): Promise<Validated<{ readonly reset: true }>> {
  const onError = own(options, "onError");
  if (!hasOnly(options, ["onError"]) || (onError !== undefined && typeof onError !== "function")) {
    throw new TypeError("completePasswordReset's options take onError (a function) only.");
  }
  const call = onError === undefined ? {} : { onError: onError as (error: unknown) => void };
  if (!hasOnly(input, ["token", "password"])) {
    return refused("invalid_request", "Give the token and the new password only.");
  }
  const token = own(input, "token");
  if (!isResetToken(token)) return refused("invalid_reset", INVALID_RESET);
  const tokenHash = hashResetToken(token);
  try {
    const found = await db.rows<{
      id: string;
      user_id: UserId;
      email: string;
      display_name: string;
      organization_names: string[];
    }>(sql`
      SELECT r.id::text AS id, u.id::text AS user_id, u.email, u.display_name,
             ARRAY(SELECT o.name FROM public.organization_members m
                   JOIN public.organizations o ON o.id = m.organization_id
                   WHERE m.user_id = u.id ORDER BY 1) AS organization_names
      FROM public.password_resets r JOIN public.users u ON u.id = r.user_id
      WHERE r.token_hash = ${tokenHash} AND r.used_at IS NULL AND r.revoked_at IS NULL
        AND r.expires_at > clock_timestamp()
        AND public.password_reset_user_ok(r.user_id, r.created_at)`);
    const reset = found[0];
    if (reset === undefined) return refused("invalid_reset", INVALID_RESET);
    const password = checkNewPassword(own(input, "password"), {
      email: reset.email,
      displayName: reset.display_name,
      words: reset.organization_names,
    });
    if (!password.ok) {
      return {
        ok: false,
        issues: password.issues.map((i): Issue => ({ ...i, path: ["password", ...i.path] })),
      };
    }
    let hash: string;
    try {
      hash = await hashPassword(password.value);
    } catch (error) {
      if (error instanceof PasswordWorkBusyError) return refused("busy", BUSY_MESSAGE);
      throw error;
    }
    const done = await inTransaction(
      db,
      async (tx): Promise<Validated<{ readonly reset: true }>> => {
        // The user row first, as every path that makes, copies or ends
        // sessions or links does, so a sign-in, a new request or another use
        // of this link at the same moment waits or finds it settled.
        await tx.rows(
          sql`SELECT 1 FROM public.users WHERE id = ${reset.user_id}::uuid FOR NO KEY UPDATE`,
        );
        const claimed = await tx.rows<{ user_id: UserId }>(sql`
        UPDATE public.password_resets r SET used_at = clock_timestamp()
        WHERE r.token_hash = ${tokenHash} AND r.id = ${reset.id}::uuid
          AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > clock_timestamp()
          AND public.password_reset_user_ok(r.user_id, r.created_at)
        RETURNING r.user_id::text AS user_id`);
        if (claimed[0]?.user_id !== reset.user_id) return refused("invalid_reset", INVALID_RESET);
        await tx.execute(sql`
        UPDATE public.users SET password_hash = ${hash}, password_changed_at = clock_timestamp()
        WHERE id = ${reset.user_id}::uuid`);
        await endAllSessionsForUser(tx, reset.user_id);
        return { ok: true, value: Object.freeze({ reset: true as const }) };
      },
    );
    if (done.ok) {
      // After the commit, in a statement of its own: signIn's success
      // transaction deletes this counter row and then updates the user row,
      // so clearing it inside the transaction above (user row first) could
      // deadlock with a sign-in at the same moment (review L3). The sign-in
      // and reset counters of the address are both cleared (D-068 asked a
      // reset to clear the sign-in one; review L4 the reset one). The reset
      // is done either way; a failure here only leaves a wait in place.
      try {
        await db.execute(sql`
          DELETE FROM public.sign_in_throttles
          WHERE key IN (${throttleAccountKey(reset.email)}, ${resetThrottleAccountKey(reset.email)})`);
      } catch (error) {
        if (!isDatabaseFailure(error)) throw error;
        notify(call.onError, error);
      }
    }
    return done;
  } catch (error) {
    if (resetGuardRefused(error)) return refused("invalid_reset", INVALID_RESET);
    const failure = failureFor(error, call);
    return refused(failure.code, failure.message);
  }
}
