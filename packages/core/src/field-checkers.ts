/**
 * Ready-made checkers for template field kinds (decisions D-010, D-015).
 *
 * `checkRecordAgainstTemplate` (templates.ts) checks the structure of each
 * value itself, and leaves the rules that belong to other modules to
 * checkers that plug in through `TemplateCheckOptions.checkers`. This file
 * holds the checkers for two of them:
 *
 * - `checkRightsValue`, for the `rights` kind: the `uri` must be the exact
 *   canonical URI of an accepted rights statement or license
 *   (`validateRightsUri`, rights.ts, D-011). It needs nothing from the
 *   organization, so `checkRecordAgainstTemplate` runs it by default.
 * - `makeIdentifierChecker(types)`, for the `identifier` kind: the `type`
 *   must be one of the organization's identifier types, and the `value` must
 *   follow the rules every identifier follows and fit that type's format
 *   (identifiers.ts, D-009). It needs the organization's types, so it can't
 *   be a default. Instead `checkRecordAgainstTemplate` refuses identifier
 *   values when no checker is given, rather than letting them through
 *   unchecked.
 *
 * Neither checks anything that needs other records: uniqueness of an
 * identifier is for `checkNewIdentifier` and `uniquenessIssues`, run on all
 * records' identifiers when saving.
 *
 * Checkers never throw, and return frozen lists of problems whose paths are
 * relative to the value (`["uri"]`, `["type"]`, `["value"]`).
 */
import { isPlainObject, type Validated } from "./issues.js";
import { shown } from "./plain-data.js";
import { validateRightsUri } from "./rights.js";
import { checkNewIdentifier, validateIdentifierTypes, type IdentifierType } from "./identifiers.js";
import type { FieldProblem, FieldValueChecker } from "./templates.js";

const NONE: readonly FieldProblem[] = Object.freeze([]);

function problems(list: readonly FieldProblem[]): readonly FieldProblem[] {
  return Object.freeze(
    list.map((p) =>
      Object.freeze({ code: p.code, message: p.message, path: Object.freeze([...(p.path ?? [])]) }),
    ),
  );
}

const UNREADABLE: readonly FieldProblem[] = problems([
  { code: "unreadable", message: "This value could not be read as plain data." },
]);

/** An own property of a plain object, or undefined. Never reads inherited values. */
function own(value: unknown, key: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) return undefined;
  return value[key];
}

/**
 * The checker for `rights` values (`{ uri, note? }`): the `uri` must be the
 * exact canonical URI of an accepted value. A variant (https for http,
 * `/page/` for `/vocab/`, no trailing slash) is refused with `not_canonical`
 * and the message names the canonical form; `normalizeRightsUri` is how an
 * editor offers the fix. Runs by default in `checkRecordAgainstTemplate`.
 */
export const checkRightsValue: FieldValueChecker = (value) => {
  try {
    if (!isPlainObject(value)) {
      return problems([
        { code: "not_an_object", message: "A rights value must be { uri, note? }." },
      ]);
    }
    const checked = validateRightsUri(own(value, "uri"));
    if (checked.ok) return NONE;
    return problems(
      checked.issues.map((i) => ({ code: i.code, message: i.message, path: ["uri"] })),
    );
  } catch {
    return UNREADABLE;
  }
};

/**
 * Make the checker for `identifier` values (`{ type, value }`) from the
 * organization's identifier types. The types are untrusted (they are edited
 * in the admin screens), so they are checked first with
 * `validateIdentifierTypes`; if they aren't valid, no checker is made.
 *
 * The checker reports `unknown_type` for a type the organization doesn't
 * have, and the identifier problems `checkNewIdentifier` reports for the
 * value (`untrimmed`, `too_long`, `control_characters`,
 * `invisible_characters`, `format_mismatch` …), except uniqueness, which
 * needs every record. Never throws.
 */
export function makeIdentifierChecker(identifierTypes: unknown): Validated<FieldValueChecker> {
  const checked = validateIdentifierTypes(identifierTypes);
  if (!checked.ok) return checked;
  const byKey = new Map<string, IdentifierType>();
  for (const type of checked.value) byKey.set(type.key, type);

  const checker: FieldValueChecker = (value, _field, record) => {
    try {
      if (!isPlainObject(value)) {
        return problems([
          { code: "not_an_object", message: "An identifier must be { type, value }." },
        ]);
      }
      const typeKey = own(value, "type");
      const type = typeof typeKey === "string" ? byKey.get(typeKey) : undefined;
      if (type === undefined) {
        return problems([
          {
            code: "unknown_type",
            message: `${shown(typeKey)} is not one of this organization's identifier types.`,
            path: ["type"],
          },
        ]);
      }
      // Only this type is passed, and no other records, so the format and
      // value rules run but uniqueness can't (see the header).
      const text = own(value, "value");
      const found = checkNewIdentifier(
        text === undefined ? { type: type.key } : { type: type.key, value: text },
        record.id,
        [],
        [type],
      );
      return found.length === 0 ? NONE : problems(found);
    } catch {
      return UNREADABLE;
    }
  };
  return { ok: true, value: checker };
}
