/**
 * Dublin Core mappings for publishing (PLATFORM_PLAN.md §1, decision D-012).
 *
 * A mapping says which of a template's fields are published as which DCMI
 * Metadata Term: `{ template, entries: [{ field, term }] }`. It is data, kept
 * beside the template rather than inside it, because publishing (T-010) needs
 * one answer to "what goes out as Dublin Core", and that answer must never
 * include a staff-only field.
 *
 * `validateDublinCoreMapping` checks a mapping against the template it is
 * for: every entry names a field the template has, the field is `public`,
 * and the term is one of the DCMI terms listed here. A mapping is untrusted
 * data (an admin can edit it, and a template's field can later be switched to
 * `staff`), so publishing must check it against the record's current template
 * every time, not once when the mapping is saved. A field that is not in the
 * mapping is not published as Dublin Core.
 *
 * The record's own `title` is always Dublin Core `title`; it is not a
 * template field, so it is not in a mapping.
 *
 * Terms are names from the `http://purl.org/dc/terms/` namespace, taken from
 * DCMI Metadata Terms (2020-01-20, read 2026-11-20). Only terms whose URIs
 * were confirmed there are listed. Lookups use Sets and Maps, so text such
 * as "constructor" can't match a built-in.
 */
import { issue, isPlainObject, type Validated } from "./issues.js";
import { IssueList, readPlainData, shown, type JsonValue, type ReadLimits } from "./plain-data.js";
import { RIGHTS_FIELD_KEY } from "./rights.js";
import { isFieldKey, validateTemplate, type FieldDefinition } from "./templates.js";
import { types } from "node:util";

export const DCTERMS_NAMESPACE = "http://purl.org/dc/terms/";

/** The DCMI terms a field can be published as. */
export const DUBLIN_CORE_TERMS = [
  "title",
  "alternative",
  "creator",
  "contributor",
  "publisher",
  "date",
  "created",
  "description",
  "abstract",
  "type",
  "format",
  "extent",
  "medium",
  "identifier",
  "bibliographicCitation",
  "source",
  "language",
  "relation",
  "isPartOf",
  "hasPart",
  "isFormatOf",
  "hasFormat",
  "coverage",
  "spatial",
  "temporal",
  "subject",
  "rights",
  "accessRights",
  "license",
  "rightsHolder",
  "provenance",
] as const;
export type DublinCoreTerm = (typeof DUBLIN_CORE_TERMS)[number];

const TERM_SET: ReadonlySet<string> = new Set(DUBLIN_CORE_TERMS);

export function isDublinCoreTerm(value: unknown): value is DublinCoreTerm {
  return typeof value === "string" && TERM_SET.has(value);
}

/** The term's URI, e.g. `http://purl.org/dc/terms/created`. */
export function dublinCoreTermUri(term: DublinCoreTerm): string {
  return `${DCTERMS_NAMESPACE}${term}`;
}

/** One published field: the template field `field` goes out as `term`. */
export interface DublinCoreEntry {
  readonly field: string;
  readonly term: DublinCoreTerm;
}

export interface DublinCoreMapping {
  /** The key of the template this mapping is for. */
  readonly template: string;
  readonly entries: readonly DublinCoreEntry[];
}

/** The most entries a mapping may have. */
export const MAX_DUBLIN_CORE_ENTRIES = 400;

const READ_LIMITS: ReadLimits = {
  maxDepth: 4,
  // Room for one entry over the limit, so `too_many` is what gets reported.
  maxValues: 10 * MAX_DUBLIN_CORE_ENTRIES,
  maxStringLength: 200,
  maxKeyLength: 64,
  maxTotalChars: 100_000,
};

const MAPPING_KEYS: ReadonlySet<string> = new Set(["template", "entries"]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(["field", "term"]);

/**
 * Check an untrusted mapping against the template it is for and return a
 * frozen copy, or every problem found. The template is validated here too,
 * and an invalid one fails closed with `invalid_template`. Never throws.
 */
export function validateDublinCoreMapping(
  mapping: unknown,
  template: unknown,
): Validated<DublinCoreMapping> {
  try {
    return checkMapping(mapping, template);
  } catch {
    return unreadable();
  }
}

function unreadable(): Validated<never> {
  return {
    ok: false,
    issues: [issue([], "unreadable", "This mapping could not be read as plain data.")],
  };
}

function invalidTemplate(): Validated<never> {
  return {
    ok: false,
    issues: [
      issue(
        [],
        "invalid_template",
        "The template is not valid, so the mapping can't be checked against it. Check it with validateTemplate.",
      ),
    ],
  };
}

function notAnObject(): Validated<never> {
  return {
    ok: false,
    issues: [issue([], "not_an_object", "A mapping must be { template, entries }.")],
  };
}

function checkMapping(mapping: unknown, template: unknown): Validated<DublinCoreMapping> {
  const checked = validateTemplate(template);
  if (!checked.ok) return invalidTemplate();
  if (types.isProxy(mapping) || !isPlainObject(mapping)) return notAnObject();
  const issues = new IssueList();
  const copy = readPlainData(mapping, [], READ_LIMITS, issues);
  if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
  const m = ownOnly(copy);
  unknownProps(m, MAPPING_KEYS, [], "a mapping", issues);

  const tpl = checked.value;
  if (m.template !== tpl.key) {
    issues.add(
      ["template"],
      "wrong_template",
      `This mapping is for ${shown(m.template)}, not the template ${shown(tpl.key)}.`,
    );
  }

  const byKey = new Map<string, FieldDefinition>();
  for (const field of tpl.fields) byKey.set(field.key, field);

  const entries = m.entries;
  if (!Array.isArray(entries)) {
    issues.add(["entries"], "required", "entries must be a list of { field, term }.");
  } else if (entries.length > MAX_DUBLIN_CORE_ENTRIES) {
    issues.add(
      ["entries"],
      "too_many",
      `A mapping can have at most ${String(MAX_DUBLIN_CORE_ENTRIES)} entries.`,
    );
  } else {
    const seen = new Set<string>();
    (entries as readonly JsonValue[]).forEach((entry, i) => {
      if (issues.full) return;
      const path = ["entries", i];
      if (!isPlainObject(entry)) {
        issues.add(path, "not_an_object", "Each entry must be { field, term }.");
        return;
      }
      const e = ownOnly(entry);
      unknownProps(e, ENTRY_KEYS, path, "an entry", issues);
      const field = e.field;
      if (!isFieldKey(field)) {
        issues.add([...path, "field"], "invalid_field_key", "field must be a field key.");
      } else {
        const def = byKey.get(field);
        if (def === undefined) {
          issues.add(
            [...path, "field"],
            "unknown_field",
            `${shown(field)} is not a field in the template ${shown(tpl.key)}.`,
          );
        } else if (def.visibility !== "public") {
          issues.add(
            [...path, "field"],
            "staff_field",
            `${shown(field)} is a staff-only field, so it can't be published.`,
          );
        }
      }
      if (!isDublinCoreTerm(e.term)) {
        issues.add(
          [...path, "term"],
          "unknown_term",
          `${shown(e.term)} is not a DCMI term this mapping can use.`,
        );
      }
      if (typeof field === "string" && typeof e.term === "string") {
        // A plain key, not JSON.stringify, so a polluted toJSON can't make
        // every entry look like a duplicate. Field keys and terms never hold NUL.
        const pair = `${field}\u0000${e.term}`;
        if (seen.has(pair)) issues.add(path, "duplicate", "This entry is listed twice.");
        seen.add(pair);
      }
    });
  }

  if (issues.count > 0) return { ok: false, issues: issues.items };
  // The copy is plain, frozen data, and every property was checked above.
  return { ok: true, value: copy as unknown as DublinCoreMapping };
}

function unknownProps(
  obj: Readonly<Record<string, JsonValue | undefined>>,
  allowed: ReadonlySet<string>,
  path: readonly (string | number)[],
  what: string,
  issues: IssueList,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      issues.add([...path, key], "unknown_property", `${shown(key)} is not a property of ${what}.`);
    }
  }
}

/** A view of `obj` where anything not an own property reads as undefined. */
function ownOnly(
  obj: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue | undefined>> {
  const view = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(obj)) view[key] = obj[key];
  return view;
}

// ---------------------------------------------------------------------------
// The mappings for the built-in presets (`presets.ts`).

function mapping(
  template: string,
  pairs: readonly (readonly [string, DublinCoreTerm])[],
): DublinCoreMapping {
  return Object.freeze({
    template,
    entries: Object.freeze(pairs.map(([field, term]) => Object.freeze({ field, term }))),
  });
}

export const DACS_DUBLIN_CORE: DublinCoreMapping = mapping("dacs-archival-unit", [
  ["reference_code", "identifier"],
  ["date", "date"],
  ["extent", "extent"],
  ["creators", "creator"],
  ["scope_and_content", "description"],
  ["access_conditions", "accessRights"],
  [RIGHTS_FIELD_KEY, "rights"],
  ["languages", "language"],
  ["related_materials", "relation"],
  ["subjects", "subject"],
  ["places", "spatial"],
]);

export const SPECTRUM_DUBLIN_CORE: DublinCoreMapping = mapping("spectrum-object", [
  ["object_number", "identifier"],
  ["object_name", "type"],
  ["brief_description", "description"],
  ["physical_description", "description"],
  ["materials", "medium"],
  ["dimensions", "extent"],
  ["production_date", "created"],
  ["makers", "creator"],
  ["subjects", "subject"],
  ["associated_places", "spatial"],
  [RIGHTS_FIELD_KEY, "rights"],
]);

export const DIGITAL_ASSET_DUBLIN_CORE: DublinCoreMapping = mapping("dublin-core-digital-asset", [
  ["identifier", "identifier"],
  ["resource_type", "type"],
  ["date_created", "created"],
  ["creators", "creator"],
  ["description", "description"],
  ["extent", "extent"],
  ["languages", "language"],
  ["subjects", "subject"],
  ["places", "spatial"],
  [RIGHTS_FIELD_KEY, "rights"],
]);

const BY_TEMPLATE: ReadonlyMap<string, DublinCoreMapping> = new Map(
  [DACS_DUBLIN_CORE, SPECTRUM_DUBLIN_CORE, DIGITAL_ASSET_DUBLIN_CORE].map((m) => [m.template, m]),
);

/**
 * The built-in mapping for a preset's template key, or undefined. For a
 * template copied from a preset under a new key, use `mappingForTemplate`.
 */
export function presetDublinCoreMapping(templateKey: unknown): DublinCoreMapping | undefined {
  return typeof templateKey === "string" ? BY_TEMPLATE.get(templateKey) : undefined;
}

/**
 * Re-target a mapping to another template, such as a preset's mapping for a
 * template copied from that preset under a new key, and check it against
 * that template. Only the `template` property is replaced; every entry is
 * checked as `validateDublinCoreMapping` does, so a field the copy removed or
 * made staff-only is reported, never dropped quietly. Never throws.
 */
export function mappingForTemplate(
  mapping: unknown,
  template: unknown,
): Validated<DublinCoreMapping> {
  try {
    const checked = validateTemplate(template);
    if (!checked.ok) return invalidTemplate();
    if (types.isProxy(mapping) || !isPlainObject(mapping)) return notAnObject();
    // Copy own, enumerable data properties only; a getter or a hidden
    // property throws and is reported as unreadable.
    const retargeted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(mapping)) {
      const d = Object.getOwnPropertyDescriptor(mapping, key);
      if (typeof key !== "string" || d === undefined || !("value" in d) || d.enumerable !== true) {
        throw new TypeError("not plain data");
      }
      if (key !== "template") retargeted[key] = d.value;
    }
    retargeted.template = checked.value.key;
    return validateDublinCoreMapping({ ...retargeted }, checked.value);
  } catch {
    return unreadable();
  }
}
