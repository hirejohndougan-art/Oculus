/**
 * One home for a record's numbers (T-014, decision D-038).
 *
 * A record's numbers live in its `RecordIdentifiers` (identifiers.ts): the
 * current ones, exactly one primary, and the former ones. That is where
 * uniqueness, auto-numbering, retiring and search work. A template field of
 * kind `identifier` (`reference_code`, `object_number`, `other_numbers`, a
 * digital asset's `identifier`) holds no number of its own: its value
 * `{ type, value }` only says which of the record's current identifiers is
 * shown in that field, so it must name one of them exactly (same type key,
 * same value, character for character). A number typed into a field and
 * nowhere else, a former number, or a value relabelled with another type is
 * refused.
 *
 * The rule is enforced in three places:
 * - **Saving.** `identifierFieldIssues(record, template, identifiers)` is the
 *   check the save path runs beside `checkRecordAgainstTemplate`: every
 *   identifier value the record stores in an `identifier` field of its
 *   template must be one of its current identifiers (`identifier_not_held`).
 *   Retiring a number a field shows therefore makes the record fail this
 *   check until the field is pointed at another number or emptied.
 * - **The effective record.** `effectiveRecord`'s `identifiers` option takes
 *   the identifiers of the record and its ancestors. A public identifier
 *   value whose source record doesn't hold it as current, or any public
 *   identifier value when `identifiers` isn't given, is kept for staff but
 *   marked `staff` with a note (`identifier_not_held`,
 *   `identifiers_unknown`), and `effectivePublishIssues` refuses publishing.
 * - **Public output.** `publicOutput`'s `identifiers` option checks again,
 *   at the boundary, that every published number is still a current
 *   identifier of the record it came from (`identifier_changed`). A view
 *   holding identifier values is refused without it (`identifiers_unknown`).
 *
 * `identifierFieldIssues` has no caller inside this package yet: the save
 * path that must run it on every record save is the service layer (T-032).
 * Until then nothing stops a stored field from pointing at a number the
 * record doesn't hold, but such a number is never published (the second
 * and third points above).
 *
 * Which numbers may be published is still the type's `public` flag (D-022):
 * the record's primary number, like any other, reaches public output only
 * through a public `identifier` field, and only when its type is public.
 * Identifier sets are one organization's (D-030): sets of another
 * organization, or of another record, are refused, never filtered.
 */
import { issue, type Issue } from "./issues.js";
import { shown } from "./plain-data.js";
import { holdsCurrentIdentifier, readIdentifierSets } from "./identifiers.js";
import { mixedOrganizationsIssue } from "./organizations.js";
import { validateRecord, type FieldValue } from "./records.js";
import { templateOfRecord } from "./templates.js";

/**
 * Check that every identifier value `record` stores in an `identifier`
 * field of `template` names one of its current identifiers in
 * `identifiers` (its own `RecordIdentifiers`), matched by type key and
 * exact value. Returns every problem; empty means the record's fields and
 * identifiers agree. The record is validated with `validateRecord`, the
 * template with `templateOfRecord` (so another organization's template, or
 * one the record doesn't name, is refused), and `identifiers` must be the
 * same record's (`wrong_record`) and organization's (`mixed_organizations`).
 * Messages name fields, never values. Values in keys the template doesn't
 * have are left-overs, staff only, and not checked here. Never throws.
 */
export function identifierFieldIssues(
  record: unknown,
  template: unknown,
  identifiers: unknown,
): readonly Issue[] {
  try {
    return Object.freeze(check(record, template, identifiers).map((i) => Object.freeze(i)));
  } catch {
    return Object.freeze([
      Object.freeze(
        issue([], "unreadable", "This record or its identifiers could not be read as plain data."),
      ),
    ]);
  }
}

function check(recordInput: unknown, templateInput: unknown, identifiers: unknown): Issue[] {
  const checked = validateRecord(recordInput);
  if (!checked.ok) {
    return [issue([], "invalid_record", "This record isn't valid. Check it with validateRecord.")];
  }
  const record = checked.value;
  const template = templateOfRecord(record, templateInput);
  if (!template.ok) return [...template.issues];
  const sets = readIdentifierSets([identifiers]);
  if (!sets.ok) {
    const problem = sets.issues[0];
    if (problem?.code === "mixed_organizations") return [problem];
    return [
      issue(
        ["identifiers"],
        "invalid_identifiers",
        "These are not a record's identifiers. Check them with validateRecordIdentifiers.",
      ),
    ];
  }
  const set = sets.value.get(record.id);
  if (set === undefined) {
    return [
      issue(["identifiers", "recordId"], "wrong_record", "These are another record's identifiers."),
    ];
  }
  if (set.organizationId !== record.organizationId) {
    return [mixedOrganizationsIssue(["identifiers"], "This record and these identifiers")];
  }
  const issues: Issue[] = [];
  for (const field of template.value.fields) {
    if (field.kind !== "identifier" || !Object.hasOwn(record.fields, field.key)) continue;
    const stored: FieldValue | undefined = record.fields[field.key];
    if (stored === undefined || stored === null) continue;
    const items: readonly FieldValue[] = Array.isArray(stored) ? stored : [stored];
    items.forEach((item, index) => {
      if (holdsCurrentIdentifier(set, item)) return;
      issues.push(
        issue(
          Array.isArray(stored) ? ["fields", field.key, index] : ["fields", field.key],
          "identifier_not_held",
          `${shown(field.label)} must show one of this record's current identifiers. Add the number to the record's identifiers first, or choose one it has.`,
        ),
      );
    });
  }
  return issues;
}
