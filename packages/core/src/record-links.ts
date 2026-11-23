/**
 * Links between records (roadmap T-015, decisions D-039 and D-045).
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
 * The checker belongs to the organization of the set it was made from, read
 * from every entry, valid or not, or to the `organizationId` given for an
 * empty set (records of another organization than the one given are
 * refused). One made from an empty set with no organization belongs to
 * none: it refuses every value that names a record (`no_organization_checker`;
 * a place with only a name needs no record), and nothing
 * that accepts a checker trusts it (T-015a review).
 *
 * The checker holds a snapshot of each record's ID, kind and organization
 * only, taken when it is made: make it again after records are added,
 * removed or changed kind. `publicOutput` reads the same snapshot (through
 * `linkTargetKind`) to decide whether a link may name the record it points
 * at: only one made by this function, for the record's own organization,
 * can.
 *
 * **Public sites show nothing of a link they can't follow** (D-045). A
 * `record_link` whose record is unpublished, held back by a deed (D-043),
 * another organization's, or can't be vouched for (any other checker) puts
 * nothing in public output: no ID, no label, no placeholder, since a label
 * copied from the record (a donor's name, a private item's title) would
 * reveal it. The public view (`publicView`) holds no `record_link` values
 * at all. Staff views (the effective record) keep every link. A link whose
 * record no longer exists (`unknown_record` from this checker) is left out
 * the same way when publishing, and `publicOutput` reports it to staff as
 * `link_target_missing` in `staffWarnings` rather than refusing the record;
 * saving it is still refused (S-011c).
 *
 * **A place value naming a place record shows its name only when vouched
 * for** (D-048): the checker given as `checkers.place` (to `effectiveRecord`
 * and to `publicOutput`) must be one made here, for the record's own
 * organization, holding that record as a place. Then the name (and gazetteer
 * URI) is shown even when the place record isn't published, never its ID or
 * a link. Otherwise the whole value is left out of the public view and
 * output: it may be another kind of value, such as a record link's label,
 * left in a field a template edit made a place.
 *
 * A template edit that narrows a field's `recordKinds` is reported by
 * `templateChanges` as `record_kind_removed` when given this checker
 * (`options.linkChecker`); labels that no longer match the linked record's
 * title are listed by `findStaleLinkLabels` (link-label-report.ts, staff
 * only). Both are T-015a (D-055).
 *
 * Checkers never throw, and return frozen lists of problems whose paths are
 * relative to the value (`["recordId"]`).
 */
import { type Validated } from "./issues.js";
import { RECORD_KINDS, type RecordKind } from "./records.js";
import { isRecordId, type RecordId } from "./record-id.js";
import { isOrganizationId, organizationIdOf, type OrganizationId } from "./organizations.js";
import { recordSet } from "./effective.js";
import type { FieldProblem, FieldValueChecker } from "./templates.js";
import { isPlainObject } from "./issues.js";
import { markLinkChecker } from "./record-link-brand.js";

export { isOtherOrganizationsLinkChecker, linkTargetKind } from "./record-link-brand.js";

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
 *
 * The checker's organization is the set's, read from every entry, valid or
 * not, so a set of another organization's invalid records still makes that
 * organization's checker. Give `organizationId` to say whose records these
 * must be: a set of another organization is refused (`wrong_organization`,
 * naming nothing), and an empty set then makes that organization's checker,
 * which holds no records. A checker made from an empty set without
 * `organizationId` belongs to no organization: it refuses every link, and
 * nothing that accepts a checker trusts it for anything.
 */
export function makeRecordLinkChecker(
  records: unknown,
  organizationId?: unknown,
): Validated<FieldValueChecker> {
  if (organizationId !== undefined && !isOrganizationId(organizationId)) {
    return {
      ok: false,
      issues: [
        Object.freeze({
          path: Object.freeze(["organizationId"]),
          code: "invalid_organization",
          message: "Give a valid organization ID.",
        }),
      ],
    };
  }
  const found = recordSet(records);
  if (!found.ok) return found;
  if (
    organizationId !== undefined &&
    found.value.organizationId !== undefined &&
    found.value.organizationId !== organizationId
  ) {
    return {
      ok: false,
      issues: [
        Object.freeze({
          path: Object.freeze([]),
          code: "wrong_organization",
          message:
            "These records belong to another organization, so they can't make this organization's record link checker.",
        }),
      ],
    };
  }
  const owner: OrganizationId | undefined = found.value.organizationId ?? organizationId;
  const kinds = new Map<RecordId, RecordKind | undefined>();
  for (const [id, record] of found.value.byId) kinds.set(id, record?.kind);

  const checker: FieldValueChecker = (value, field, record) => {
    try {
      // The type says a record, but callers may pass anything at run time.
      if (typeof (record as unknown) !== "object" || (record as unknown) === null) {
        return UNREADABLE;
      }
      if (owner !== undefined && organizationIdOf(record) !== owner) {
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
      // A checker of no organization vouches for no record (a name-only
      // place, above, needs none).
      if (owner === undefined) {
        return problem(
          "no_organization_checker",
          "This record link checker was made from no records and for no organization, so it can't check any link.",
        );
      }
      if (!isRecordId(target)) {
        return problem("invalid_id", "recordId must be a record ID.", ["recordId"]);
      }
      if (target === own(record, "id")) {
        return problem("self_link", "A record can't link to itself.", ["recordId"]);
      }
      if (!kinds.has(target)) {
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
  markLinkChecker(checker, owner, kinds);
  return { ok: true, value: checker };
}
