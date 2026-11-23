/**
 * Organization-defined record types (PLATFORM_PLAN.md §1, decision D-037).
 *
 * The plan says admins can add more record types. The six record kinds
 * (`RECORD_KINDS`, D-007) stay a fixed list, because code depends on them:
 * the arrangement tree, a digital asset's media type, an agent's type, a
 * place's position, which Dublin Core class a record publishes as. What an
 * organization adds is a **record type built on one of the six**: "Oral
 * history" is a kind of `digital_asset`, "Photograph" a kind of `object`,
 * "Scrapbook" a kind of `archival_unit`. A type has a key, a label, an
 * optional description, its kind and a default template:
 *
 * ```ts
 * { key: "oral-history", organizationId, label: "Oral history",
 *   kind: "digital_asset", defaultTemplateKey: "oral-history" }
 * ```
 *
 * **A type belongs to one organization** (`organizationId`, D-019, D-030),
 * like a template. Its default template must be a template of the same
 * organization (`wrong_organization`) that applies to the type's kind
 * (`template_wrong_kind`): `validateRecordType` checks both, against the
 * organization's template registry or the one template. `indexRecordTypes`
 * refuses a list naming two organizations (`mixed_organizations`).
 *
 * **How a record uses its type.** A record names its type in
 * `recordTypeKey` (records.ts). The type is a label and a starting point:
 * `recordTypeDefaults` gives the `kind`, `recordTypeKey` and `templateKey`
 * (the type's default template) for a new record, and `checkRecordType`
 * checks that the record's type exists in its organization and is of the
 * record's kind. The record's own `templateKey` stays the one source of the
 * template it follows (D-029): the checks and publishing never pick a
 * template from the type, so a record can be moved to another template of
 * its kind without changing its type, and a type edit never changes what a
 * record publishes.
 *
 * Messages name record type and template keys only, never a record's title
 * or values, and never another organization's keys.
 */
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { IssueList, readPlainData, shown, type JsonValue, type ReadLimits } from "./plain-data.js";
import {
  RECORD_KINDS,
  isRecordKind,
  isRecordTypeKey,
  isTemplateKey,
  validateRecord,
  type CatalogRecord,
  type RecordKind,
} from "./records.js";
import {
  MAX_HELP_LENGTH,
  MAX_LABEL_LENGTH,
  isTemplateRegistry,
  registeredTemplate,
  templateRegistryOrganization,
  validateTemplate,
  type FieldTemplate,
  type TemplateRegistry,
} from "./templates.js";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  oneOrganization,
  type OrganizationId,
} from "./organizations.js";

/** One record type an organization defines on top of a record kind. */
export interface RecordType {
  /** Unique within the organization, e.g. `oral-history`. The template key rule. */
  readonly key: string;
  /** The organization the type belongs to (D-030). It never changes. */
  readonly organizationId: OrganizationId;
  /** What people see, e.g. "Oral history". One line. */
  readonly label: string;
  /** Help for catalogers choosing a type. */
  readonly description?: string;
  /** The record kind every record of this type has. */
  readonly kind: RecordKind;
  /**
   * The key of the template a new record of this type follows. It must be
   * one of the organization's templates, and apply to `kind`.
   */
  readonly defaultTemplateKey: string;
}

/** What `recordTypeDefaults` gives for a new record of a type. */
export interface RecordTypeDefaults {
  readonly organizationId: OrganizationId;
  readonly kind: RecordKind;
  readonly recordTypeKey: string;
  readonly templateKey: string;
}

/** The most record types one registry from `indexRecordTypes` may hold. */
export const MAX_RECORD_TYPES = 1000;

/**
 * An organization's record types, each validated once against its templates
 * and found by key, from `indexRecordTypes`. Opaque and frozen: one
 * consistent snapshot, built again after a type or template is edited.
 */
export interface RecordTypeRegistry {
  /** How many types it holds. */
  readonly size: number;
}

const TYPE_KEYS: ReadonlySet<string> = new Set([
  "key",
  "organizationId",
  "label",
  "description",
  "kind",
  "defaultTemplateKey",
]);

const READ_LIMITS: ReadLimits = {
  maxDepth: 2,
  maxValues: 20,
  maxStringLength: MAX_HELP_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 10_000,
};

const LINE_BREAKS = /[\t\n\r\u2028\u2029]/;
const KEY_RULE =
  "1 to 64 lower case letters, digits, hyphens and underscores, starting with a letter";

interface RegistryEntry {
  readonly organizationId: OrganizationId | undefined;
  readonly byKey: ReadonlyMap<string, RecordType>;
}

/** Registries made by `indexRecordTypes`. */
const REGISTRIES = new WeakMap<object, RegistryEntry>();

// ---------------------------------------------------------------------------
// Validating a record type.

/**
 * Check an untrusted record type (from the admin screens, an import or a
 * stored row) and return a frozen copy, or every problem found. Its default
 * template is checked against `templates`, the organization's template
 * registry from `indexTemplates` or the one template it names: the template
 * must exist (`unknown_template`, `template_mismatch`), belong to the type's
 * organization (`wrong_organization`) and apply to the type's kind
 * (`template_wrong_kind`). Never throws.
 */
export function validateRecordType(
  input: unknown,
  templates: FieldTemplate | TemplateRegistry,
): Validated<RecordType> {
  try {
    const shape = readRecordType(input);
    if (!shape.ok) return shape;
    const problems = defaultTemplateIssues(shape.value, templates);
    if (problems.length > 0) return { ok: false, issues: problems };
    return shape;
  } catch {
    return refused([], "unreadable", "This record type could not be read as plain data.");
  }
}

/** The shape checks only, without the default template. Never throws. */
function readRecordType(input: unknown): Validated<RecordType> {
  try {
    if (types.isProxy(input) || !isPlainObject(input)) {
      return refused([], "not_an_object", "A record type must be a plain object.");
    }
    const issues = new IssueList();
    const copy = readPlainData(input, [], READ_LIMITS, issues);
    if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
    const t = ownOnly(copy);

    for (const key of Object.keys(t)) {
      if (!TYPE_KEYS.has(key)) {
        issues.add([key], "unknown_property", `${shown(key)} is not a property of a record type.`);
      }
    }
    if (!isRecordTypeKey(t.key)) {
      issues.add(["key"], "invalid_key", `The record type key is ${KEY_RULE}.`);
    }
    if (!isOrganizationId(t.organizationId)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "Every record type belongs to one organization: organizationId must be an organization ID.",
      );
    }
    const label = lineProblem(t.label);
    if (label !== undefined) {
      issues.add(["label"], "invalid_label", `The record type needs a label that ${label}.`);
    }
    if (t.description !== undefined) {
      if (typeof t.description !== "string" || t.description.trim().length === 0) {
        issues.add(["description"], "invalid_text", "This must be text, or be left out.");
      } else if (t.description.length > MAX_HELP_LENGTH) {
        issues.add(
          ["description"],
          "too_long",
          `This can be at most ${String(MAX_HELP_LENGTH)} characters.`,
        );
      }
    }
    if (!isRecordKind(t.kind)) {
      issues.add(["kind"], "invalid_kind", `Kind must be one of: ${RECORD_KINDS.join(", ")}.`);
    }
    if (!isTemplateKey(t.defaultTemplateKey)) {
      issues.add(
        ["defaultTemplateKey"],
        "invalid_template_key",
        `The default template key is ${KEY_RULE}.`,
      );
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    // The copy is plain, frozen data, and every property was checked above.
    return { ok: true, value: copy as unknown as RecordType };
  } catch {
    return refused([], "unreadable", "This record type could not be read as plain data.");
  }
}

/** Problems with a (shape-checked) type's default template. */
function defaultTemplateIssues(type: RecordType, templates: unknown): readonly Issue[] {
  const wanted = type.defaultTemplateKey;
  let template: FieldTemplate;
  if (isTemplateRegistry(templates)) {
    // The whole registry must be the type's organization's, checked before
    // the lookup, so the answer never shows which keys another organization
    // has.
    const owner = templateRegistryOrganization(templates);
    if (owner !== undefined && owner !== type.organizationId) {
      return [
        issue(
          ["defaultTemplateKey"],
          "wrong_organization",
          "These templates belong to another organization than the record type. Each organization uses only its own templates.",
        ),
      ];
    }
    const found = registeredTemplate(templates, wanted);
    if (found === undefined) {
      return [
        issue(
          ["defaultTemplateKey"],
          "unknown_template",
          `There is no template with the key ${shown(wanted)} for this record type to use.`,
        ),
      ];
    }
    template = found;
  } else {
    const checked = validateTemplate(templates);
    if (!checked.ok) {
      return [
        issue(
          ["defaultTemplateKey"],
          "invalid_template",
          "The template is not valid, so the record type can't be checked against it. Check it with validateTemplate.",
        ),
      ];
    }
    // Checked before the key, so nothing about another organization's
    // template is compared or shown.
    if (oneOrganization([checked.value, type]) !== type.organizationId) {
      return [
        issue(
          ["defaultTemplateKey"],
          "wrong_organization",
          "The template given belongs to another organization than the record type. Each organization uses only its own templates.",
        ),
      ];
    }
    if (checked.value.key !== wanted) {
      return [
        issue(
          ["defaultTemplateKey"],
          "template_mismatch",
          `The record type's default template is ${shown(wanted)}, not ${shown(checked.value.key)}.`,
        ),
      ];
    }
    template = checked.value;
  }
  if (template.organizationId !== type.organizationId) {
    // A registry holds one organization's templates, so this is a second line.
    return [
      issue(
        ["defaultTemplateKey"],
        "wrong_organization",
        "The default template belongs to another organization than the record type. Each organization uses only its own templates.",
      ),
    ];
  }
  if (!template.appliesTo.includes(type.kind)) {
    return [
      issue(
        ["defaultTemplateKey"],
        "template_wrong_kind",
        `The template ${shown(wanted)} is not for records of the kind ${type.kind}, so it can't be this record type's default.`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The record type registry.

/**
 * Validate an organization's record types once, each against `templates`
 * (its template registry from `indexTemplates`), and index them by key. Any
 * invalid type, a key used twice, a hole, getter or Proxy refuses the whole
 * list. The types must all belong to one organization
 * (`mixed_organizations`, checked first, so no issue ever quotes another
 * organization's type), and so must the templates (`wrong_organization`).
 * Never throws.
 */
export function indexRecordTypes(
  recordTypes: unknown,
  templates: TemplateRegistry,
): Validated<RecordTypeRegistry> {
  try {
    if (!isTemplateRegistry(templates)) {
      return refused(
        [],
        "no_template_registry",
        "Record types are checked against the organization's templates: give a registry from indexTemplates.",
      );
    }
    if (types.isProxy(recordTypes) || !Array.isArray(recordTypes)) {
      return refused([], "not_a_list", "The record types must be given as a list.");
    }
    const length = recordTypes.length;
    if (length > MAX_RECORD_TYPES) {
      return refused(
        [],
        "too_many",
        `A registry can hold at most ${String(MAX_RECORD_TYPES)} record types.`,
      );
    }
    // Read each slot once, as a plain data property, so a getter can't run
    // and every later step sees the same entries.
    const items: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      const slot = Object.getOwnPropertyDescriptor(recordTypes, i);
      items.push(slot !== undefined && "value" in slot ? slot.value : undefined);
    }
    if (oneOrganization(items) === "mixed") {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These record types")] };
    }
    const byKey = new Map<string, RecordType>();
    const issues = new IssueList();
    for (let i = 0; i < length && !issues.full; i += 1) {
      const checked = validateRecordType(items[i], templates);
      if (!checked.ok) {
        for (const found of checked.issues)
          issues.add([i, ...found.path], found.code, found.message);
        continue;
      }
      const key = checked.value.key;
      if (byKey.has(key)) {
        issues.add(
          [i, "key"],
          "duplicate_key",
          `More than one record type has the key ${shown(key)}.`,
        );
        continue;
      }
      byKey.set(key, checked.value);
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    const owner = oneOrganization(byKey.values());
    if (owner === "mixed") {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These record types")] };
    }
    const registry: RecordTypeRegistry = Object.freeze({ size: byKey.size });
    REGISTRIES.set(registry, { organizationId: owner, byKey });
    return { ok: true, value: registry };
  } catch {
    return refused([], "unreadable", "The record types could not be read as plain data.");
  }
}

/** True if `value` is a registry made by `indexRecordTypes`. */
export function isRecordTypeRegistry(value: unknown): value is RecordTypeRegistry {
  return typeof value === "object" && value !== null && REGISTRIES.has(value);
}

/**
 * What a new record of the type `key` starts with: its organization, kind,
 * `recordTypeKey` and `templateKey` (the type's default template), from a
 * registry from `indexRecordTypes`, so the template was checked to exist and
 * fit. Spread it into `createRecord` with the kind's own properties (a
 * digital asset's `mediaType`, say). Never throws.
 */
export function recordTypeDefaults(
  registry: RecordTypeRegistry,
  key: unknown,
): Validated<RecordTypeDefaults> {
  try {
    const entry = isRecordTypeRegistry(registry) ? REGISTRIES.get(registry) : undefined;
    if (entry === undefined) {
      return refused(
        [],
        "no_record_type_registry",
        "Give the organization's record types as a registry from indexRecordTypes.",
      );
    }
    if (!isRecordTypeKey(key)) {
      return refused([], "invalid_record_type_key", `The record type key is ${KEY_RULE}.`);
    }
    const type = entry.byKey.get(key);
    if (type === undefined) {
      return refused(
        [],
        "unknown_record_type",
        `There is no record type with the key ${shown(key)}.`,
      );
    }
    return {
      ok: true,
      value: Object.freeze({
        organizationId: type.organizationId,
        kind: type.kind,
        recordTypeKey: type.key,
        templateKey: type.defaultTemplateKey,
      }),
    };
  } catch {
    return refused([], "unreadable", "The record type could not be read.");
  }
}

// ---------------------------------------------------------------------------
// Checking a record's type.

/**
 * Check a record's `recordTypeKey` against its organization's record types:
 * a registry from `indexRecordTypes`, or the one type it names. The record
 * is validated first (`invalid_record`). A record with no type is
 * `no_record_type`; through a registry, the registry must be the record's
 * organization's (`wrong_organization`, checked before the lookup) and hold
 * the key (`unknown_record_type`); a type given directly must have the
 * record's key (`record_type_mismatch`) and organization
 * (`wrong_organization`). The type's kind must be the record's kind
 * (`wrong_kind`). The record's template is not compared with the type's
 * default: `templateKey` is checked by the template checks (D-029, D-037).
 * Returns every problem found, or an empty list. Never throws.
 */
export function checkRecordType(
  record: CatalogRecord,
  given: RecordType | RecordTypeRegistry,
): readonly Issue[] {
  try {
    const valid = validateRecord(record);
    if (!valid.ok) {
      return refusedList(
        [],
        "invalid_record",
        "The record is not valid, so its record type can't be checked. Check it with validateRecord.",
      );
    }
    const r = valid.value;
    const key = r.recordTypeKey;
    if (key === undefined) {
      return refusedList(
        ["recordTypeKey"],
        "no_record_type",
        "This record doesn't name a record type.",
      );
    }
    let type: RecordType;
    const entry = isRecordTypeRegistry(given) ? REGISTRIES.get(given) : undefined;
    if (entry !== undefined) {
      if (entry.organizationId !== undefined && entry.organizationId !== r.organizationId) {
        return refusedList(
          ["organizationId"],
          "wrong_organization",
          "These record types belong to another organization than this record. Each organization uses only its own record types.",
        );
      }
      const found = entry.byKey.get(key);
      if (found === undefined) {
        return refusedList(
          ["recordTypeKey"],
          "unknown_record_type",
          `There is no record type with the key ${shown(key)}.`,
        );
      }
      type = found;
    } else {
      const checked = readRecordType(given);
      if (!checked.ok) {
        return refusedList(
          [],
          "invalid_record_type",
          "The record type is not valid, so the record can't be checked against it. Check it with validateRecordType.",
        );
      }
      // Checked before the key, so nothing of another organization's type is shown.
      if (oneOrganization([checked.value, r]) !== r.organizationId) {
        return refusedList(
          ["organizationId"],
          "wrong_organization",
          "The record type given belongs to another organization than this record. Each organization uses only its own record types.",
        );
      }
      if (checked.value.key !== key) {
        return refusedList(
          ["recordTypeKey"],
          "record_type_mismatch",
          `This record is of the record type ${shown(key)}, not ${shown(checked.value.key)}.`,
        );
      }
      type = checked.value;
    }
    if (type.organizationId !== r.organizationId) {
      return refusedList(
        ["organizationId"],
        "wrong_organization",
        "The record type belongs to another organization than this record. Each organization uses only its own record types.",
      );
    }
    if (type.kind !== r.kind) {
      return refusedList(
        ["kind"],
        "wrong_kind",
        `The record type ${shown(key)} is for records of the kind ${type.kind}, but this record is of the kind ${r.kind}.`,
      );
    }
    return Object.freeze([]);
  } catch {
    return refusedList([], "unreadable", "The record's type could not be checked.");
  }
}

// ---------------------------------------------------------------------------
// Helpers

function refused(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: [issue(path, code, message)] };
}

function refusedList(
  path: readonly (string | number)[],
  code: string,
  message: string,
): readonly Issue[] {
  return Object.freeze([Object.freeze(issue(path, code, message))]);
}

/** Why `value` isn't an acceptable one-line label, or undefined if it is. */
function lineProblem(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return "is not empty";
  if (value !== value.trim()) return "doesn't start or end with spaces";
  if (value.length > MAX_LABEL_LENGTH) {
    return `is at most ${String(MAX_LABEL_LENGTH)} characters`;
  }
  if (LINE_BREAKS.test(value)) return "is one line, with no tabs or line breaks";
  return undefined;
}

/** A view of `obj` where anything not an own property reads as undefined. */
function ownOnly(
  obj: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue | undefined>> {
  const view = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(obj)) view[key] = obj[key];
  return view;
}
