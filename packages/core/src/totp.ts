/**
 * Two-step sign-in codes (T-038, D-052, D-077): TOTP (RFC 6238) on HOTP
 * (RFC 4226), base32 (RFC 4648 §6), the `otpauth://` link authenticator
 * apps read, and recovery codes. Pure: no database, no stored secrets.
 * `packages/db/src/second-factor.ts` keeps the secrets (encrypted) and the
 * last step used.
 *
 * - **TOTP** is HMAC-SHA-1, 6 digits, 30-second steps from the Unix epoch
 *   (RFC 6238 §4: T0 = 0, X = 30), the settings every authenticator app
 *   supports. One step either side of the server's step is accepted for
 *   clock drift and typing time (RFC 6238 §5.2 recommends at most one).
 *   Steps are `bigint`, so times past 2038 work (§4).
 * - **Every comparison is constant-time** and looks at every step of the
 *   window whatever matched, so the time taken says nothing about which
 *   step (if any) was right.
 * - **No replay** (RFC 6238 §5.2): `matchTotpStep` only accepts a step after
 *   the last one used, which the caller stores.
 * - **Recovery codes** are 120 random bits as 24 Crockford base32 characters
 *   in six groups of four (D-052), stored only as SHA-256 of the canonical
 *   form (ASVS 5.0 6.5.2 allows a plain hash at 112 bits or more).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ThrottleRule } from "./sign-in-throttle.js";

/** Seconds per TOTP step (RFC 6238's default X). */
export const TOTP_STEP_SECONDS = 30;
/** Digits in a code. */
export const TOTP_DIGITS = 6;
/** Steps accepted either side of the current one. */
export const TOTP_WINDOW_STEPS = 1;
/** Bytes in a new TOTP secret: 160 bits, RFC 4226 §4 R6's recommended length. */
export const TOTP_SECRET_BYTES = 20;

/** A new random TOTP secret (20 bytes). */
export function newTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(TOTP_SECRET_BYTES));
}

const MAX_COUNTER = (1n << 64n) - 1n;

/**
 * HOTP (RFC 4226 §5.3): HMAC-SHA-1 of the 8-byte big-endian counter,
 * dynamic truncation (offset from the low 4 bits of the last byte, the top
 * bit masked off) and the last `digits` decimal digits, zero-padded.
 */
export function hotp(secret: Uint8Array, counter: bigint, digits: number = TOTP_DIGITS): string {
  if (!(secret instanceof Uint8Array) || secret.length < 16) {
    throw new TypeError("An HOTP secret is at least 16 bytes (RFC 4226 R6).");
  }
  if (typeof counter !== "bigint" || counter < 0n || counter > MAX_COUNTER) {
    throw new TypeError("An HOTP counter is a whole number from 0 to 2^64 - 1.");
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new TypeError("An HOTP code has 6 to 8 digits.");
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, "0");
}

/** The TOTP step for a Unix time in seconds (RFC 6238 §4: floor(t / 30)). */
export function totpStep(unixSeconds: number): bigint {
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0) {
    throw new TypeError("A TOTP time is a Unix time in seconds, 0 or later.");
  }
  return BigInt(Math.floor(unixSeconds / TOTP_STEP_SECONDS));
}

/** The TOTP code at a Unix time in seconds. */
export function totpAt(
  secret: Uint8Array,
  unixSeconds: number,
  digits: number = TOTP_DIGITS,
): string {
  return hotp(secret, totpStep(unixSeconds), digits);
}

/**
 * A code as typed, as its 6 digits (spaces dropped), or `undefined` for
 * anything else. Authenticator apps often show "123 456".
 */
export function normalizeTotpCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 20) return undefined;
  const digits = value.replace(/[ \u00a0]/g, "");
  return /^[0-9]{6}$/.test(digits) ? digits : undefined;
}

/**
 * The step `code` (6 digits, as `normalizeTotpCode` gives) matches within
 * one step of `currentStep`, if that step is after `lastStep`; otherwise
 * `undefined`. Every step of the window is computed and compared in
 * constant time, whatever matched. A step at or before `lastStep` is never
 * accepted (RFC 6238 §5.2: no second use).
 */
export function matchTotpStep(
  secret: Uint8Array,
  code: string,
  currentStep: bigint,
  lastStep: bigint,
): bigint | undefined {
  const presented = Buffer.from(normalizeTotpCode(code) ?? "xxxxxx", "utf8");
  let matched: bigint | undefined;
  for (let d = -TOTP_WINDOW_STEPS; d <= TOTP_WINDOW_STEPS; d++) {
    const step = currentStep + BigInt(d);
    if (step < 0n) continue;
    const expected = Buffer.from(hotp(secret, step), "utf8");
    const equal = timingSafeEqual(expected, presented);
    if (equal && step > lastStep && matched === undefined) matched = step;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648 §6) and the otpauth link

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, without padding (as authenticator apps take it). */
export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/**
 * Base32 text (either case, spaces and `=` padding ignored) as bytes, or
 * `undefined` if it isn't base32 or has stray low bits.
 */
export function decodeBase32(text: unknown): Uint8Array | undefined {
  if (typeof text !== "string" || text.length > 1024) return undefined;
  const clean = text.replace(/[ =]/g, "").toUpperCase();
  if (!/^[A-Z2-7]*$/.test(clean)) return undefined;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits >= 5 || buffer !== 0) return undefined;
  return new Uint8Array(out);
}

/** What `otpauthUri` shows in the authenticator app. */
export interface OtpauthLabel {
  /** Who issued it ("Oculus", or an organization's name): no `:`, 1–100 characters. */
  readonly issuer: string;
  /** Whose it is (the sign-in address): 1–320 characters. */
  readonly account: string;
}

// Control characters (C0, DEL and C1).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The `otpauth://totp/…` link for a secret (the Key Uri Format authenticator
 * apps read; shown as a QR code by the admin screen, T-045, or typed as the
 * base32 key): issuer and account, SHA1, 6 digits, 30 seconds. The link
 * holds the secret: it is shown once, at set-up, and never stored or logged.
 */
export function otpauthUri(secret: Uint8Array, label: OtpauthLabel): string {
  const { issuer, account } = label;
  if (
    typeof issuer !== "string" ||
    issuer.length === 0 ||
    issuer.length > 100 ||
    issuer.includes(":") ||
    CONTROL.test(issuer) ||
    typeof account !== "string" ||
    account.length === 0 ||
    account.length > 320 ||
    CONTROL.test(account)
  ) {
    throw new TypeError(
      "An otpauth label needs an issuer (no ':') and an account, without control characters.",
    );
  }
  const path = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = [
    `secret=${encodeBase32(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    "algorithm=SHA1",
    `digits=${String(TOTP_DIGITS)}`,
    `period=${String(TOTP_STEP_SECONDS)}`,
  ].join("&");
  return `otpauth://totp/${path}?${query}`;
}

// ---------------------------------------------------------------------------
// Recovery codes

/** Codes in a set (D-052). */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 15; // 120 bits: 24 base32 characters.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CANONICAL_RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{24}$/;

/** A new recovery code, formatted for showing ("ABCD-EFGH-…", six groups of four). */
export function newRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let text = "";
  for (let i = 23; i >= 0; i--) text += CROCKFORD.charAt(Number((bits >> BigInt(i * 5)) & 31n));
  return formatRecoveryCode(text);
}

/** A canonical code in six groups of four, joined by `-`. */
export function formatRecoveryCode(canonical: string): string {
  return canonical.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * A recovery code as typed, in canonical form (24 characters, upper case,
 * no separators; Crockford's look-alikes O → 0 and I, L → 1 accepted), or
 * `undefined` for anything else.
 */
export function normalizeRecoveryCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const text = value.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return CANONICAL_RECOVERY_CODE.test(text) ? text : undefined;
}

/** True for a recovery code in canonical form. */
export function isCanonicalRecoveryCode(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_RECOVERY_CODE.test(value);
}

/** The stored form of a canonical recovery code: SHA-256 of its ASCII text. */
export function hashRecoveryCode(canonical: string): Uint8Array {
  if (!isCanonicalRecoveryCode(canonical)) {
    throw new TypeError("Only a canonical recovery code is hashed.");
  }
  return new Uint8Array(createHash("sha256").update(canonical, "ascii").digest());
}

// ---------------------------------------------------------------------------
// Throttling code attempts

/**
 * The per-person counter for wrong codes (RFC 4226 §7.3, ASVS 5.0 6.3.1),
 * with D-068's rules (`throttleAttempt`: counted up front, no wait grows
 * while someone keeps trying, never a permanent lockout) but a longer
 * longest wait: a code has only a million values, and only someone who
 * already has the password can reach it. 5 free, then 1, 2, 4 … s up to an
 * hour, forgotten after a day without a failure. Someone who has the
 * password and keeps guessing gets about 17 tries in the first hour and 24
 * a day after that: with three codes valid at any moment, about a 1 in 4,500
 * chance a day, and about 3% over a whole year of trying. A notice to the
 * person after repeated wrong codes (a follow-up for the admin screens)
 * would cut that further.
 */
export const SECOND_STEP_THROTTLE: ThrottleRule = Object.freeze({
  free: 5,
  baseSeconds: 1,
  maxSeconds: 60 * 60,
  resetAfterSeconds: 24 * 60 * 60,
});

/** Wrong codes after which a session waiting for its second step is ended. */
export const MAX_PENDING_CODE_FAILURES = 5;
