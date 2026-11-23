/**
 * What `makeRecordLinkChecker` (record-links.ts) remembers about each checker
 * it made, in a module of its own so `effective.ts` can ask it without
 * importing `record-links.ts` (which imports `effective.ts`). Not exported
 * from the package.
 */
import { isRecordId, type RecordId } from "./record-id.js";
import type { OrganizationId } from "./organizations.js";
import type { RecordKind } from "./records.js";

interface MadeLinkChecker {
  /** The organization of the records; undefined when made from an empty set. */
  readonly organizationId: OrganizationId | undefined;
  /** Each record's kind by ID, or undefined for an ID that can't be used. */
  readonly kinds: ReadonlyMap<RecordId, RecordKind | undefined>;
}

/** Keyed by the checker itself, never by shape. */
const MADE = new WeakMap<object, MadeLinkChecker>();

/** For `record-links.ts` only. */
export function markLinkChecker(
  checker: object,
  organizationId: OrganizationId | undefined,
  kinds: ReadonlyMap<RecordId, RecordKind | undefined>,
): void {
  MADE.set(checker, Object.freeze({ organizationId, kinds }));
}

/**
 * The kind of the record `recordId` names, when `checker` was made by
 * `makeRecordLinkChecker` from `organizationId`'s records and holds a usable
 * record with that ID; otherwise undefined (any other checker, another
 * organization's, an unknown or unusable ID). Never throws.
 */
export function linkTargetKind(
  checker: unknown,
  organizationId: unknown,
  recordId: unknown,
): RecordKind | undefined {
  if (typeof checker !== "function" || !isRecordId(recordId)) return undefined;
  const made = MADE.get(checker);
  if (made?.organizationId === undefined || made.organizationId !== organizationId) {
    return undefined;
  }
  return made.kinds.get(recordId);
}

/** True for a checker `makeRecordLinkChecker` made (from any organization's records, or none). */
export function isMadeLinkChecker(checker: unknown): boolean {
  return typeof checker === "function" && MADE.has(checker);
}

/**
 * True for a checker `makeRecordLinkChecker` made from the records of an
 * organization other than `organizationId`.
 */
export function isOtherOrganizationsLinkChecker(
  checker: unknown,
  organizationId: unknown,
): boolean {
  if (typeof checker !== "function") return false;
  const made = MADE.get(checker)?.organizationId;
  return made !== undefined && made !== organizationId;
}

/**
 * True when a place value's name may be shown publicly (D-048): it names no
 * place record, or `checker` (from `makeRecordLinkChecker`, for
 * `organizationId`) holds the record it names as a place record of that
 * organization, and it isn't `selfId`. A place value whose `recordId` can't
 * be vouched for this way may be some other value left in a field a template
 * edit made a place (a record link's label, say), so it isn't shown at all.
 * Never throws.
 */
export function placeNameMayShow(
  value: unknown,
  checker: unknown,
  organizationId: unknown,
  selfId: unknown,
): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const d = Object.getOwnPropertyDescriptor(value, "recordId");
    if (d === undefined) return true;
    if (!("value" in d)) return false;
    const recordId: unknown = d.value;
    if (recordId === selfId) return false;
    return linkTargetKind(checker, organizationId, recordId) === "place";
  } catch {
    return false;
  }
}
