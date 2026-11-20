/**
 * Permanent internal record IDs.
 *
 * Every Oculus record gets a random UUID (RFC 9562, version 4) when it is
 * created. It never changes and is never shown as a catalog number; the
 * organization's own identifiers (accession numbers and so on) are separate.
 */
import { randomUUID } from "node:crypto";

declare const recordIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one record forever. */
export type RecordId = string & { readonly [recordIdBrand]: true };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Make a new random record ID. */
export function newRecordId(): RecordId {
  return randomUUID() as RecordId;
}

/** True if `value` is a well-formed record ID (lowercase version 4 UUID). */
export function isRecordId(value: unknown): value is RecordId {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Read a record ID from untrusted input. Surrounding spaces are trimmed and
 * upper case is accepted, because people copy IDs by hand; anything else
 * returns `undefined` rather than a guess.
 */
export function parseRecordId(value: unknown): RecordId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isRecordId(normalized) ? normalized : undefined;
}
