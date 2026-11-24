/**
 * Password reset tokens and their rules (T-039, D-052, D-068, D-078). No
 * database here; `packages/db/src/password-resets.ts` stores them.
 *
 * - **The token** is 32 random bytes (256 bits) as base64url text in one
 *   canonical spelling, like an invitation's or a session's: it goes once,
 *   in the link sent to the account's own address, and only its SHA-256 is
 *   stored. A plain hash is enough at 256 bits (ASVS 5.0 6.5.2's reasoning,
 *   7.2.3).
 * - **Short-lived:** 30 minutes by default; a caller may choose 5 to 60
 *   minutes (`RESET_LIFE_BOUNDS`), and the table refuses anything else.
 * - **Throttled** like sign-in (D-068) but on counters of its own, so asking
 *   for a link never makes anyone wait to sign in: one per address typed
 *   (`RESET_ACCOUNT_THROTTLE`), one per client address
 *   (`RESET_SOURCE_THROTTLE`). Every request counts, since each may send an
 *   email. The keys are the sign-in keys with `reset:` in front.
 */
import { createHash, randomBytes } from "node:crypto";
import { throttleAccountKey, throttleSourceKey, type ThrottleRule } from "./sign-in-throttle.js";

const TOKEN_BYTES = 32;
/** base64url without padding: 32 bytes are 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new reset token: sent once, stored only as `hashResetToken`. */
export function newResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * True only for a token in its one canonical spelling: 43 base64url
 * characters that decode to exactly 32 bytes and encode back to the same
 * text (the last character's 2 spare bits must be zero).
 */
export function isResetToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

/** The stored form of a reset token: its SHA-256, 32 bytes. */
export function hashResetToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}

/** How long a reset link lasts by default: 30 minutes. */
export const DEFAULT_RESET_SECONDS = 30 * 60;

/** The shortest and longest a reset link may last (the table refuses others). */
export const RESET_LIFE_BOUNDS = Object.freeze({ min: 5 * 60, max: 60 * 60 });

/** True if `value` is an allowed life for a reset link, in whole seconds. */
export function isResetLife(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RESET_LIFE_BOUNDS.min &&
    value <= RESET_LIFE_BOUNDS.max
  );
}

/**
 * Requests for one address typed: 3 free, then waits of 1, 2, 4 … minutes up
 * to an hour, forgotten after a day without one. About a dozen links a day
 * at most, so nobody's mailbox can be flooded through Oculus.
 */
export const RESET_ACCOUNT_THROTTLE: ThrottleRule = Object.freeze({
  free: 3,
  baseSeconds: 60,
  maxSeconds: 60 * 60,
  resetAfterSeconds: 24 * 60 * 60,
});

/**
 * Requests from one client address (IPv4 address, IPv6 /64): 10 free, then
 * waits of 30 s, 1, 2 … minutes up to an hour, forgotten after an hour
 * without one (offices share addresses).
 */
export const RESET_SOURCE_THROTTLE: ThrottleRule = Object.freeze({
  free: 10,
  baseSeconds: 30,
  maxSeconds: 60 * 60,
  resetAfterSeconds: 60 * 60,
});

/**
 * Requests from one IPv6 /48 (a site's usual allocation, RFC 6177), beside
 * the /64 counter: 30 free, then waits of 30 s, 1, 2 … minutes up to an
 * hour, forgotten after an hour. So one site can't spread requests over its
 * 65,536 /64s to flood the background work (second review, M1).
 */
export const RESET_NETWORK_THROTTLE: ThrottleRule = Object.freeze({
  free: 30,
  baseSeconds: 30,
  maxSeconds: 60 * 60,
  resetAfterSeconds: 60 * 60,
});

/**
 * The /48 counter's key for a client address (`reset:source:v6:2001:db8:0::/48`),
 * or `undefined` for anything but IPv6 (IPv4, IPv4 written as IPv6, and
 * unreadable addresses have only the address counter).
 */
export function resetThrottleNetworkKey(address: unknown): string | undefined {
  const key = throttleSourceKey(address);
  const m = /^source:v6:([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return m === null ? undefined : `reset:source:v6:${m[1] ?? ""}:${m[2] ?? ""}:${m[3] ?? ""}::/48`;
}

/** The reset counter's key for an address typed: `reset:` and the sign-in key. */
export function resetThrottleAccountKey(typed: string): string {
  return `reset:${throttleAccountKey(typed)}`;
}

/** The reset counter's key for a client address: `reset:` and the sign-in key. */
export function resetThrottleSourceKey(address: unknown): string {
  return `reset:${throttleSourceKey(address)}`;
}
