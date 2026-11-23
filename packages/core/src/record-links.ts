/**
 * Links between records (roadmap T-015, decision D-039).
 *
 * A `record_link` field (templates.ts) holds `{ recordId, label }`: a link
 * from one record to another of the same organization, such as an item's
 * creator on the Authorities list (an agent record), the event a photograph
 * shows, or a related record. A place value's optional `recordId` is the
 * same kind of link, to a place record.
 *
 * `makeRecordLinkChecker(records)` makes the checker for both, from the
 * organization's records (a list or a lookup from `indexRecords`, which
 * refuses a set mixing organizations, D-030). Pass it as
 * `checkers.record_link` and `checkers.place`. For each value it checks:
 *
 * - the record being checked belongs to the organization the checker was made
 *   for (`wrong_organization_checker`), so one organization's records never
 *   vouch for another's links;
 * - the record linked to is in the set and valid (`unknown_record`; an ID
 *   used twice or a record that isn't valid is `unusable_record`), so a link
 *   can never point at another organization's record, whose ID is simply not
 *   in the set;
 * - its kind is one the field allows (`wrong_record_kind`): a place
 *   record for a place value, one of `recordKinds` for a `record_link`;
 * - it is not the record itself (`self_link`).
 *
 * Messages never quote the linked record's title or values, and never say
 * whether an ID belongs to another organization: an ID that isn't this
 * organization's is "not found", whatever it is.
 *
 * The checker holds a snapshot of each record's ID, kind and organization
 * only, taken when it is made: make it again after records are added,
 * removed or changed kind. `publicOutput` reads the same snapshot (through
 * `linkTargetKind`) to decide whether a link may name the record it points
 * at: only one made by this function, for the record's own organization,
 * can; with any other checker, links go out as their labels alone.
 *
 * Checkers never throw, and return frozen lists of problems whose paths are
 * relative to the value (`["recordId"]`).
 */
import { type Validated } from "./issues.js";
import { RECORD_KINDS, type RecordKind } from "./records.js";
import { isRecordId, type RecordId } from "./record-id.js";
import { organizationIdOf, type OrganizationId } from "./organizations.js";
import { recordsById } from "./effective.js";
import type { FieldProblem, FieldValueChecker } from "./templates.js";
import { isPlainObject } from "./issues.js";

/** What `makeRecordLinkChecker` remembers about each checker it made. */
interface MadeLinkChecker {
  /** The organization of the records; undefined when made from an empty set. */
  readonly organizationId: OrganizationId | undefined;
  /** Each record's kind by ID, or undefined for an ID that can't be used. */
  readonly kinds: ReadonlyMap<RecordId, RecordKind | undefined>;
}

/** Keyed by the checker itself, never by shape. */
const MADE = new WeakMap<object, MadeLinkChecker>();

const NONE: readonly FieldProblem[] = Object.freeze([]);

function problem(
  code: string,
  message: string,
  path: readonly string[] = [],
): readonly FieldProblem[] {
  return Object.freeze([Object.freeze({ code, message, path: Object.freeze([...path]) })]);
}

const UNREADABLE = problem("unreadable", "This value could not be read as plain data.");

/** An own data property of a plain object, or undefined. Never runs a getter. */
function own(value: unknown, key: string): unknown {
  if (!isPlainObject(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
}

/** The kinds a field's values may link to. */
function allowedKinds(field: unknown): readonly RecordKind[] | undefined {
  const kind = own(field, "kind");
  if (kind === "place") return ["place"];
  if (kind !== "record_link") return undefined;
  const listed = own(field, "recordKinds");
  if (listed === undefined) return RECORD_KINDS;
  return Array.isArray(listed) ? (listed as RecordKind[]) : [];
}

/**
 * Make the checker for `record_link` values and for the `recordId` of place
 * values, from the organization's records: a list, or a lookup from
 * `indexRecords`. A set that holds records of more than one organization, or
 * can't be read, makes no checker (the issue `indexRecords` gives). See the
 * module header for what it checks. Never throws.
 */
export function makeRecordLinkChecker(records: unknown): Validated<FieldValueChecker> {
  const found = recordsById(records);
  if (!found.ok) return found;
  const kinds = new Map<RecordId, RecordKind | undefined>();
  let organizationId: OrganizationId | undefined;
  for (const [id, record] of found.value) {
    kinds.set(id, record?.kind);
    // The set is one organization's (indexRecords refuses a mixed one).
    organizationId ??= record?.organizationId;
  }

  const checker: FieldValueChecker = (value, field, record) => {
    try {
      // The type says a record, but callers may pass anything at run time.
      if (typeof (record as unknown) !== "object" || (record as unknown) === null) {
        return UNREADABLE;
      }
      const owner = organizationIdOf(record);
      if (organizationId !== undefined && owner !== organizationId) {
        return problem(
          "wrong_organization_checker",
          "This record link checker was made from another organization's records, so it can't check this record's links.",
        );
      }
      const allowed = allowedKinds(field);
      if (allowed === undefined) {
        return problem(
          "wrong_checker",
          "The record link checker is for record_link and place values only.",
        );
      }
      if (!isPlainObject(value)) {
        return problem("not_an_object", "A link to a record must be an object with a recordId.");
      }
      const target = own(value, "recordId");
      // A place may name no place record; a record_link must name one.
      if (target === undefined && own(field, "kind") === "place") return NONE;
      if (!isRecordId(target)) {
        return problem("invalid_id", "recordId must be a record ID.", ["recordId"]);
      }
      if (target === own(record, "id")) {
        return problem("self_link", "A record can't link to itself.", ["recordId"]);
      }
      if (organizationId === undefined || !kinds.has(target)) {
        return problem(
          "unknown_record",
          "There is no record with this ID in this organization's records.",
          ["recordId"],
        );
      }
      const kind = kinds.get(target);
      if (kind === undefined) {
        return problem(
          "unusable_record",
          "The record this links to can't be used: its ID is used twice, or it isn't valid.",
          ["recordId"],
        );
      }
      if (!allowed.includes(kind)) {
        return problem(
          "wrong_record_kind",
          `This field links to ${allowed.join(" or ")} records, not ${kind} records.`,
          ["recordId"],
        );
      }
      return NONE;
    } catch {
      return UNREADABLE;
    }
  };
  MADE.set(checker, Object.freeze({ organizationId, kinds }));
  return { ok: true, value: checker };
}

/**
 * The kind of the record `recordId` names, when `checker` was made by
 * `makeRecordLinkChecker` from `organizationId`'s records and holds a usable
 * record with that ID; otherwise undefined (any other checker, another
 * organization's, an unknown or unusable ID). For `public-output.ts` only
 * (not exported from the package). Never throws.
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

/**
 * True for a checker `makeRecordLinkChecker` made from the records of an
 * organization other than `organizationId`. For `public-output.ts` only.
 */
export function isOtherOrganizationsLinkChecker(
  checker: unknown,
  organizationId: unknown,
): boolean {
  if (typeof checker !== "function") return false;
  const made = MADE.get(checker)?.organizationId;
  return made !== undefined && made !== organizationId;
}
