/**
 * User accounts and invitations: IDs, email addresses, names and invitation
 * tokens (T-036, D-019, D-068). No database here; `packages/db` stores them.
 *
 * A user is one sign-in for the whole install (D-019: "one sign-in with
 * separate roles in each" organization). What they may reach is their
 * memberships, one per organization, each made by accepting an invitation
 * bound to that organization and that email address. There is no public
 * sign-up.
 *
 * **Email addresses** are compared ignoring case and stored in lower case:
 * `normalizeEmail` accepts printable ASCII only (no spaces, quotes, angle
 * brackets or the like), one `@`, a local part of 1–64 characters and a
 * domain of letters, digits and hyphens with at least one dot, 254
 * characters in all. Lower-casing the local part is not what RFC 5321
 * allows a mail server to do, but two people at one domain whose addresses
 * differ only in case is not a case worth an account mix-up.
 *
 * **Invitation tokens** are 32 random bytes (256 bits) as base64url text,
 * shown once (in the invitation link) and stored only as their SHA-256
 * hash. A plain hash is enough for a random value this long (ASVS 5.0
 * 6.5.2's reasoning for recovery codes, and its 7.2.3 for session tokens).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

declare const userIdBrand: unique symbol;
declare const invitationIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one user forever. */
export type UserId = string & { readonly [userIdBrand]: true };
/** A lowercase version 4 UUID that identifies one invitation. */
export type InvitationId = string & { readonly [invitationIdBrand]: true };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Make a new random user ID. */
export function newUserId(): UserId {
  return randomUUID() as UserId;
}

/** True if `value` is a well-formed user ID. */
export function isUserId(value: unknown): value is UserId {
  return typeof value === "string" && UUID_V4.test(value);
}

/** Make a new random invitation ID. */
export function newInvitationId(): InvitationId {
  return randomUUID() as InvitationId;
}

/** True if `value` is a well-formed invitation ID. */
export function isInvitationId(value: unknown): value is InvitationId {
  return typeof value === "string" && UUID_V4.test(value);
}

// ---------------------------------------------------------------------------
// Email addresses

/** Most characters in an email address (RFC 5321's path limit less the brackets). */
export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART = 64;
// Printable ASCII but space and the characters that need quoting in an address.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The stored form of an email address (lower case), or `undefined` if it
 * isn't one Oculus accepts. Spaces around it are not trimmed: a form sends
 * what was typed, and the caller decides.
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_EMAIL_LENGTH) return undefined;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return undefined;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (local.length > MAX_LOCAL_PART || !LOCAL_PART.test(local)) return undefined;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return undefined;
  return `${local.toLowerCase()}@${domain}`;
}

// ---------------------------------------------------------------------------
// Display names

export const MAX_DISPLAY_NAME_LENGTH = 200;
// Control characters, line and paragraph separators, and the Unicode
// direction overrides that can make a name read as something else.
const NAME_REFUSED = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/**
 * Checks a person's name as shown in the admin: 1–200 characters, no
 * spaces at either end, no control characters, line breaks or direction
 * overrides. Returns it unchanged or `undefined`.
 */
export function validateDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "" || value.length > MAX_DISPLAY_NAME_LENGTH) return undefined;
  if (value.trim() !== value || NAME_REFUSED.test(value)) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Invitation tokens

const TOKEN_BYTES = 32;
/** base64url without padding: 32 bytes are 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Default life of an invitation: 7 days. */
export const DEFAULT_INVITATION_SECONDS = 7 * 24 * 60 * 60;
/** Shortest an invitation may last: 1 hour. */
export const MIN_INVITATION_SECONDS = 60 * 60;
/** Longest an invitation may last: 14 days (the database refuses more). */
export const MAX_INVITATION_SECONDS = 14 * 24 * 60 * 60;

/** A new invitation token: shown once, stored only as `hashInvitationToken`. */
export function newInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** True if `value` has the shape of an invitation token. */
export function isInvitationToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  // Exactly 32 bytes: the last character carries only 4 bits, so the rest
  // must be zero (a token is never accepted in two spellings).
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

/** The stored form of an invitation token: its SHA-256, 32 bytes. */
export function hashInvitationToken(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}
