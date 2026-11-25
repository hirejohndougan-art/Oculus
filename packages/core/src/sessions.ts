/**
 * Sessions: IDs, tokens, time limits and CSRF tokens (T-037, D-052, D-069).
 * No database here; `packages/db/src/sessions.ts` stores them.
 *
 * **The session token** is 32 random bytes (256 bits; ASVS 5.0 7.2.3 asks
 * for 128) as base64url text without padding: 43 characters, one spelling
 * only (`isSessionToken` refuses a token whose last character has stray low
 * bits, padding, the standard alphabet's `+` and `/`, or spaces). It is
 * shown once, in the `__Host-oculus_session` cookie (D-052), and stored only
 * as its SHA-256 (`hashSessionToken`): a database leak gives no usable
 * session. A plain hash is enough for a random value this long (the same
 * reasoning as D-068's invitation tokens).
 *
 * **The CSRF token** of a session is derived from its token
 * (`csrfTokenFor`: HMAC-SHA-256 keyed by the session token's bytes, over a
 * fixed label), so it needs no storage, changes whenever the session token
 * is rotated, and can't be worked back to the session token. The admin
 * reads it over a same-origin request and sends it with every change;
 * `checkCsrfToken` compares in constant time. Together with the HTTP
 * layer's Origin check (D-058) this is D-052's CSRF protection.
 *
 * **Time limits** (D-052): 30 minutes idle (T-062, D-098) and 12 hours absolute by default.
 * A system manager may change them within `SESSION_POLICY_BOUNDS`. A session
 * waiting for its second step lasts `SECOND_STEP_SECONDS` (10 minutes) and
 * grants nothing else.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

declare const sessionIdBrand: unique symbol;

/** A lowercase version 4 UUID naming one session (shown in the person's list; not a secret). */
export type SessionId = string & { readonly [sessionIdBrand]: true };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Make a new random session ID. */
export function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/** True if `value` is a well-formed session ID. */
export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && UUID_V4.test(value);
}

// ---------------------------------------------------------------------------
// Tokens

const TOKEN_BYTES = 32;
/** base64url without padding: 32 bytes are 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new session token: given to the browser once, stored only as `hashSessionToken`. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * True only for a token in its one canonical spelling: 43 base64url
 * characters that decode to exactly 32 bytes and encode back to the same
 * text (the last character carries only 4 bits; the other 2 must be zero).
 */
export function isSessionToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

/** The stored form of a session token: its SHA-256, 32 bytes. */
export function hashSessionToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

const CSRF_LABEL = "oculus session csrf v1";

/**
 * The CSRF token for a session token (43 base64url characters), or
 * `undefined` if `sessionToken` isn't one. Changes when the session token is
 * rotated.
 */
export function csrfTokenFor(sessionToken: unknown): string | undefined {
  if (!isSessionToken(sessionToken)) return undefined;
  return createHmac("sha256", Buffer.from(sessionToken, "base64url"))
    .update(CSRF_LABEL, "utf8")
    .digest("base64url");
}

/**
 * True if `presented` is the CSRF token of `sessionToken`. Both must be in
 * canonical form; the comparison is constant-time.
 */
export function checkCsrfToken(sessionToken: unknown, presented: unknown): boolean {
  const expected = csrfTokenFor(sessionToken);
  if (expected === undefined || !isSessionToken(presented)) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(presented, "utf8"));
}

// ---------------------------------------------------------------------------
// Time limits

/** How long a session may sit unused, and how long it may last in all, in seconds. */
export interface SessionPolicy {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

/**
 * 30 minutes idle (John, Q-8, 2026-11-24; T-062, D-098, replacing D-052's 4
 * hours) and 12 hours absolute (D-052).
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  idleSeconds: 30 * 60,
  absoluteSeconds: 12 * 60 * 60,
});

/**
 * What a system manager may choose (the database's CHECKs say the same):
 * idle 5 minutes to 12 hours, absolute 1 to 24 hours, idle no longer than
 * absolute.
 */
export const SESSION_POLICY_BOUNDS = Object.freeze({
  minIdleSeconds: 5 * 60,
  maxIdleSeconds: 12 * 60 * 60,
  minAbsoluteSeconds: 60 * 60,
  maxAbsoluteSeconds: 24 * 60 * 60,
});

/** How long a session waits for its second step (T-038) after the password: 10 minutes. */
export const SECOND_STEP_SECONDS = 10 * 60;

/** How recently the password must have been entered for a sensitive change, by default: 10 minutes. */
export const RECENT_AUTHENTICATION_SECONDS = 10 * 60;
/** The range a caller may ask for instead: 1 minute to 1 hour. */
export const RECENT_AUTHENTICATION_BOUNDS = Object.freeze({ min: 60, max: 60 * 60 });

function wholeIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The policy as given, if it is within `SESSION_POLICY_BOUNDS` and has only
 * the two keys as own data properties; otherwise `undefined`.
 */
export function validateSessionPolicy(value: unknown): SessionPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("idleSeconds") || !keys.includes("absoluteSeconds")) {
    return undefined;
  }
  const read = (key: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
  };
  const idleSeconds = read("idleSeconds");
  const absoluteSeconds = read("absoluteSeconds");
  const b = SESSION_POLICY_BOUNDS;
  if (!wholeIn(idleSeconds, b.minIdleSeconds, b.maxIdleSeconds)) return undefined;
  if (!wholeIn(absoluteSeconds, b.minAbsoluteSeconds, b.maxAbsoluteSeconds)) return undefined;
  if (idleSeconds > absoluteSeconds) return undefined;
  return Object.freeze({ idleSeconds, absoluteSeconds });
}

/** True if `value` is a window `RECENT_AUTHENTICATION_BOUNDS` allows. */
export function isRecentAuthenticationWindow(value: unknown): value is number {
  return wholeIn(value, RECENT_AUTHENTICATION_BOUNDS.min, RECENT_AUTHENTICATION_BOUNDS.max);
}

// ---------------------------------------------------------------------------
// Client labels

/** Longest label shown in a person's list of sessions ("Firefox on Linux"). */
export const MAX_CLIENT_LABEL_LENGTH = 200;
const LABEL_REFUSED = /[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/**
 * A label for a person's list of sessions, made by the caller (for example
 * from the browser's User-Agent): cut to 200 characters, spaces at the ends
 * trimmed (cut by code points, so a long label may end inside an emoji
 * sequence), and `undefined` if empty or holding control characters, line
 * breaks, lone surrogates or direction overrides. Never an address or anything secret.
 */
export function clientLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Cut in UTF-16 units first, so a huge header costs nothing to split;
  // then to 200 code points.
  const cut = Array.from(value.slice(0, MAX_CLIENT_LABEL_LENGTH * 2))
    .slice(0, MAX_CLIENT_LABEL_LENGTH)
    .join("")
    .trim();
  if (cut === "" || LABEL_REFUSED.test(cut)) return undefined;
  return cut;
}
