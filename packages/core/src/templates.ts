/**
 * Field templates (PLATFORM_PLAN.md §1, decision D-010).
 *
 * A template says which fields a kind of record has: their keys, labels,
 * help text and kinds, which are required, which repeat, which are staff
 * only, which are inherited down the archival hierarchy, and which standard
 * element each one maps to. Templates are data, not code, because admins
 * edit them in the browser. So a template is untrusted input too:
 * `validateTemplate` checks one strictly before anything uses it.
 *
 * `checkRecordAgainstTemplate` then checks a record's `fields` against its
 * template: unknown fields, missing required fields, single values given as
 * lists (and the reverse), and each value's shape for its kind.
 *
 * Field kinds and the value each stores:
 * - `text`: one line of text, trimmed.
 * - `long_text`: text that may run over several lines and paragraphs.
 * - `date`: an EDTF date as text, checked with `parseEdtf` (D-008).
 * - `list`: one choice from the options the template lists (a pick list).
 *   Several choices is a repeatable `list` field.
 * - `controlled_term`: `{ label, uri?, vocabulary? }`, a term from a
 *   vocabulary such as LCSH, or a local term with no URI. A term with no
 *   vocabulary is a local term (D-014), so it is allowed wherever `local`
 *   is. A field's `vocabularies` may list only the codes in
 *   `VOCABULARY_CODES` (vocabularies.ts).
 * - `identifier`: `{ type, value }`, such as an accession number. The type
 *   and a field's `identifierTypes` follow the identifier type key rule
 *   (`isIdentifierTypeKey`, D-031): no hyphens.
 * - `link`: `{ url, label? }`, a web link (http or https).
 * - `rights`: `{ uri, note? }`, a rights statement or license URI. One per
 *   record: the kind is only allowed in a single, public, non-repeating field
 *   with the key `rights`, the field the publish rule reads (rights.ts,
 *   D-011, D-015). The note is kept staff-side and is not published (D-016,
 *   superseding D-015); still keep donor names and contact details out of
 *   it, and put private rights notes in a separate staff field.
 * - `place`: `{ label, uri?, recordId? }`, a place by name, with a gazetteer
 *   URI (GNIS) or the ID of a place record if known.
 *
 * Only the structure of the last five is checked here. Whether a term is in
 * its vocabulary (T-009), an identifier type exists and is unique (T-004), a
 * rights URI is a known statement (T-007) or a place record exists is for
 * those modules: they plug in through `TemplateCheckOptions.checkers`.
 * The ready-made ones are in `field-checkers.ts` (D-015) and
 * `vocabularies.ts` (D-014). The rights and controlled term checkers run by
 * default. The identifier checker needs the organization's
 * identifier types, so the caller must pass one (`makeIdentifierChecker`):
 * without it, identifier values are refused with `unchecked`, never accepted
 * unchecked.
 *
 * A field is `required` (the record must have a value) and/or `repeatable`
 * (the value is a list of one or more values; otherwise it is one value).
 * An empty value is left out, never stored as "", null or [].
 *
 * `visibility` has no default: every field says `public` or `staff`, so a
 * template can't make a field public by leaving something out. Staff-only
 * fields must never reach public output (T-010).
 *
 * **A record names its template** (`templateKey`, D-029). The checks take
 * either one template or a registry from `indexTemplates`, the organization's
 * templates validated once and found by key. Either way, a record whose
 * `templateKey` names a different template than the one given is refused
 * (`template_mismatch`), never checked against it: a record moved silently
 * to another template could have its staff values published under a key the
 * other template makes public.
 *
 * **A template belongs to one organization** (`organizationId`, D-019,
 * D-030, T-019a). Each organization has its own templates, so a template of
 * another organization is never used for a record: `templateOfRecord` (and
 * so the record check, `effectiveRecord` and `publicOutput`) refuses it with
 * `wrong_organization`, and `indexTemplates` refuses a list holding two
 * organizations' templates (`mixed_organizations`). Presets (presets.ts)
 * have no organization; `templateFromPreset` makes an organization's copy.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import {
  FORBIDDEN_KEYS,
  IssueList,
  readPlainData,
  shown,
  type JsonValue,
  type ReadLimits,
} from "./plain-data.js";
import { parseEdtf } from "./edtf.js";
import { checkRightsValue } from "./field-checkers.js";
import { RIGHTS_FIELD_KEY } from "./rights.js";
// vocabularies.ts imports this module too. Neither reads the other's exports
// while the modules load, only when their functions run, so the order in
// which they load doesn't matter.
import { VOCABULARY_CODES, controlledTermChecker } from "./vocabularies.js";
import { isRecordId } from "./record-id.js";
import { IDENTIFIER_TYPE_KEY_RULE, isIdentifierTypeKey } from "./identifiers.js";
import {
  RECORD_KINDS,
  isRecordKind,
  isTemplateKey,
  validateRecord,
  type CatalogRecord,
  type RecordKind,
} from "./records.js";
import { types } from "node:util";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  oneOrganization,
  type OrganizationId,
} from "./organizations.js";

export const FIELD_KINDS = [
  "text",
  "long_text",
  "date",
  "list",
  "controlled_term",
  "identifier",
  "link",
  "rights",
  "place",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const FIELD_VISIBILITIES = ["public", "staff"] as const;
/** `public`: may be published. `staff`: never leaves the staff catalog. */
export type FieldVisibility = (typeof FIELD_VISIBILITIES)[number];

/** The standard element a field maps to, e.g. DACS 2.4 or Dublin Core `date`. */
export interface StandardMapping {
  /** Short code for the standard: `dacs`, `spectrum`, `dcterms` … */
  readonly standard: string;
  /** The element within it, e.g. `2.4 Date` or `date`. */
  readonly element: string;
  /** The element's published URI, if it has one. */
  readonly uri?: string;
}

/** One choice in a `list` field. */
export interface ListOption {
  /** What is stored in the record. */
  readonly value: string;
  /** What people see. */
  readonly label: string;
}

export interface FieldDefinition {
  /** Stable key used in `record.fields`; never changes once records use it. */
  readonly key: string;
  readonly label: string;
  /** Help shown beside the field in the editor. */
  readonly help?: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly visibility: FieldVisibility;
  /** Lower levels of the archival hierarchy take this value unless they set their own (T-008). */
  readonly inherited: boolean;
  readonly standards?: readonly StandardMapping[];
  /** `list` fields only, and required there: the choices. */
  readonly options?: readonly ListOption[];
  /** `controlled_term` fields only: the vocabularies a term may come from. */
  readonly vocabularies?: readonly string[];
  /** `identifier` fields only: the identifier types allowed. */
  readonly identifierTypes?: readonly string[];
  /** `text` and `long_text` fields only: a lower length limit than the default. */
  readonly maxLength?: number;
}

export interface FieldTemplate {
  /** Stable key for the template, e.g. `dacs-archival-unit`. Unique within its organization. */
  readonly key: string;
  /** The organization the template belongs to (D-030). Never changes. */
  readonly organizationId: OrganizationId;
  readonly label: string;
  readonly description?: string;
  /** The record kinds this template can describe. */
  readonly appliesTo: readonly RecordKind[];
  readonly fields: readonly FieldDefinition[];
}

// ---------------------------------------------------------------------------
// Limits.

export const MAX_TEMPLATE_FIELDS = 200;
export const MAX_LABEL_LENGTH = 200;
export const MAX_HELP_LENGTH = 2000;
export const MAX_LIST_OPTIONS = 500;
/** Vocabularies or identifier types a field may list. */
export const MAX_ALLOWED_CODES = 100;
export const MAX_STANDARD_MAPPINGS = 20;
/** The longest a `text` value may be, unless the field sets a lower `maxLength`. */
export const MAX_TEXT_LENGTH = 1000;
/** The longest a `long_text` value may be (the same as any text in a record). */
export const MAX_LONG_TEXT_LENGTH = 100_000;
/** The most values a repeatable field may hold. */
export const MAX_REPEATS = 500;
export const MAX_URL_LENGTH = 2000;
/** The longest an identifier value, a term label or a place name may be. */
export const MAX_SHORT_TEXT_LENGTH = 500;

/** All the options in all a template's list fields together. */
export const MAX_TEMPLATE_OPTIONS = 10_000;

// Room for a template at every per-item limit: up to 200 fields of about 400
// values each without options (80,000), plus 10,000 options of 5 values each
// (50,000). Text: 10,000 options with two 200-character parts (4,000,000),
// plus help text and labels on every field.
const TEMPLATE_READ_LIMITS: ReadLimits = {
  maxDepth: 6,
  maxValues: 150_000,
  maxStringLength: MAX_HELP_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 5_000_000,
};

/** The same rule `validateRecord` applies to keys in `fields`. */
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * Template keys, standard codes and vocabulary codes. Identifier types follow
 * the identifier type key rule instead (`isIdentifierTypeKey`, no hyphens).
 */
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
/** A code that matches CODE and isn't a prototype key (`constructor`, `prototype`). */
function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value) && !FORBIDDEN_KEYS.has(value);
}
const LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

const TEMPLATE_KEYS: ReadonlySet<string> = new Set([
  "key",
  "organizationId",
  "label",
  "description",
  "appliesTo",
  "fields",
]);
const FIELD_PROPS: ReadonlySet<string> = new Set([
  "key",
  "label",
  "help",
  "kind",
  "required",
  "repeatable",
  "visibility",
  "inherited",
  "standards",
  "options",
  "vocabularies",
  "identifierTypes",
  "maxLength",
]);
/** Properties that only some kinds may have. */
const KIND_ONLY: ReadonlyMap<string, readonly FieldKind[]> = new Map<string, readonly FieldKind[]>([
  ["options", ["list"]],
  ["vocabularies", ["controlled_term"]],
  ["identifierTypes", ["identifier"]],
  ["maxLength", ["text", "long_text"]],
]);

export function isFieldKind(value: unknown): value is FieldKind {
  return (FIELD_KINDS as readonly unknown[]).includes(value);
}

/** True if `key` can be used as a field key in a template and in `record.fields`. */
export function isFieldKey(key: unknown): key is string {
  return typeof key === "string" && FIELD_KEY.test(key) && !FORBIDDEN_KEYS.has(key);
}

/**
 * Why `text` isn't an acceptable web address, or undefined if it is. Only
 * http and https, with a host and no user name or password (which would be
 * published with the link). Backslashes are refused: browsers and servers
 * read them differently (`https://example.org\@evil.example/`).
 *
 * This is a check on what is stored, not a fetch guard. It does not block
 * internal hosts (`localhost`, `10.0.0.1`, `169.254.169.254`), so anything
 * that later fetches these URLs (a link checker) must do its own SSRF checks.
 */
export function webUrlProblem(text: string): string | undefined {
  if (text.length > MAX_URL_LENGTH) {
    return `is longer than ${String(MAX_URL_LENGTH)} characters`;
  }
  if (!/^https?:\/\/[^\s/?#\\]/.test(text) || /[\s\\]/.test(text)) {
    return "must be a web address starting with http:// or https://, with no spaces or backslashes";
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "is not a valid web address";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be a web address starting with http:// or https://";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a user name or password";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Validating a template.

/**
 * Check an untrusted template (from the admin editor, an import or a stored
 * row) and return a frozen copy, or every problem found. Never throws.
 */
export function validateTemplate(input: unknown): Validated<FieldTemplate> {
  return readTemplate(input, IDENTIFIER_CODE, true);
}

/**
 * As `validateTemplate`, but `organizationId` may be left out (if present it
 * must still be valid), so a preset can be checked too. Only for checks
 * about a template's fields, such as a Dublin Core mapping (dublin-core.ts);
 * never for choosing the template a record follows. Not exported from the
 * package. Never throws.
 */
export function validateTemplateShape(
  input: unknown,
): Validated<FieldTemplate | Omit<FieldTemplate, "organizationId">> {
  return readTemplate(input, IDENTIFIER_CODE, false);
}

/**
 * Read a template stored before identifier type codes followed the
 * identifier type key rule (D-031): as `validateTemplate`, but an
 * `identifierTypes` list may still hold hyphenated codes. Use it only to read
 * an existing template, such as the old side of `templateChanges`, so it can
 * be fixed; new and edited templates go through `validateTemplate`, which
 * refuses them. Never throws.
 */
export function validateLegacyTemplate(input: unknown): Validated<FieldTemplate> {
  return readTemplate(input, LEGACY_IDENTIFIER_CODE, true);
}

/** The most templates `legacyTemplateIssues` looks through at once. */
export const MAX_TEMPLATE_SET = 10_000;

/** A stored template that `validateTemplate` would refuse. */
export interface LegacyTemplateProblem {
  /** Where it is in the list given. */
  readonly index: number;
  /** Its key, when it has a readable one. */
  readonly key?: string;
  /**
   * True when it is valid except for identifier type codes the key rule
   * (D-031) no longer allows: fix those codes and save it again
   * (`templateChanges` reads it). False when it is invalid for other reasons too.
   */
  readonly fixable: boolean;
  /** The identifier type codes that no longer follow the rule. */
  readonly identifierTypes: readonly string[];
}

/**
 * Find stored templates that `validateTemplate` refuses, such as ones whose
 * `identifierTypes` hold hyphenated codes from before D-031, so an upgrade
 * can have them re-saved before the records using them stop being checked
 * and published. Never throws.
 */
export function legacyTemplateIssues(
  templates: unknown,
): Validated<readonly LegacyTemplateProblem[]> {
  try {
    if (types.isProxy(templates) || !Array.isArray(templates)) {
      return { ok: false, issues: [issue([], "not_a_list", "The templates must be a list.")] };
    }
    const length = templates.length;
    if (length > MAX_TEMPLATE_SET) {
      return {
        ok: false,
        issues: [
          issue(
            [],
            "too_many",
            `At most ${String(MAX_TEMPLATE_SET)} templates can be checked at once.`,
          ),
        ],
      };
    }
    const out: LegacyTemplateProblem[] = [];
    for (let i = 0; i < length; i += 1) {
      const slot = Object.getOwnPropertyDescriptor(templates, i);
      const item: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
      if (validateTemplate(item).ok) continue;
      const legacy = validateLegacyTemplate(item);
      // Read from a safe copy, so a template invalid for other reasons still
      // shows which of its codes the key rule refuses.
      const copy =
        legacy.ok || types.isProxy(item) || !isPlainObject(item)
          ? undefined
          : readPlainData(item, [], TEMPLATE_READ_LIMITS, new IssueList());
      const view = legacy.ok
        ? legacy.value
        : copy !== undefined && isPlainObject(copy)
          ? ownOnly(copy)
          : undefined;
      const codes: string[] = [];
      const fieldList: unknown = view?.fields;
      if (Array.isArray(fieldList)) {
        for (const f of fieldList as unknown[]) {
          if (!isPlainObject(f)) continue;
          const listed: unknown = Object.hasOwn(f, "identifierTypes")
            ? f.identifierTypes
            : undefined;
          if (!Array.isArray(listed)) continue;
          for (const c of listed as unknown[]) {
            if (isCode(c) && !isIdentifierTypeKey(c) && !codes.includes(c)) codes.push(c);
          }
        }
      }
      const key: unknown = view?.key;
      out.push(
        Object.freeze({
          index: i,
          ...(isCode(key) ? { key } : {}),
          fixable: legacy.ok,
          identifierTypes: Object.freeze(codes),
        }),
      );
    }
    return { ok: true, value: Object.freeze(out) };
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "These templates could not be read as plain data.")],
    };
  }
}

function readTemplate(
  input: unknown,
  identifierCode: CodeRule,
  needsOrganization: boolean,
): Validated<FieldTemplate> {
  try {
    return checkTemplate(input, identifierCode, needsOrganization);
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "This template could not be read as plain data.")],
    };
  }
}

function checkTemplate(
  input: unknown,
  identifierCode: CodeRule,
  needsOrganization: boolean,
): Validated<FieldTemplate> {
  if (types.isProxy(input) || !isPlainObject(input)) {
    return {
      ok: false,
      issues: [issue([], "not_an_object", "A template must be a plain object.")],
    };
  }
  const issues = new IssueList();
  const copy = readPlainData(input, [], TEMPLATE_READ_LIMITS, issues);
  if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
  const t = ownOnly(copy);

  unknownProps(t, TEMPLATE_KEYS, [], "a template", issues);
  if (!isTemplateKey(t.key)) {
    issues.add(
      ["key"],
      "invalid_key",
      "The template key is 1 to 64 lower case letters, digits, hyphens and underscores, starting with a letter.",
    );
  }
  if (
    (needsOrganization || t.organizationId !== undefined) &&
    !isOrganizationId(t.organizationId)
  ) {
    issues.add(
      ["organizationId"],
      "invalid_organization",
      "Every template belongs to one organization: organizationId must be an organization ID.",
    );
  }
  checkLabel(t.label, ["label"], "The template", issues);
  if (t.description !== undefined) checkHelp(t.description, ["description"], issues);
  checkAppliesTo(t.appliesTo, issues);

  const fields = t.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.add(["fields"], "required", "A template needs a list of at least one field.");
  } else if (fields.length > MAX_TEMPLATE_FIELDS) {
    issues.add(
      ["fields"],
      "too_many",
      `A template can have at most ${String(MAX_TEMPLATE_FIELDS)} fields.`,
    );
  } else {
    const seen = new Set<string>();
    let options = 0;
    let reported = false;
    (fields as readonly JsonValue[]).forEach((field, i) => {
      if (issues.full) return;
      if (isPlainObject(field) && Object.hasOwn(field, "options")) {
        const list = field.options;
        options += Array.isArray(list) ? list.length : 0;
        if (options > MAX_TEMPLATE_OPTIONS && !reported) {
          reported = true;
          issues.add(
            ["fields", i, "options"],
            "too_many_options",
            `All the list fields together can have at most ${String(MAX_TEMPLATE_OPTIONS)} options; this field goes over.`,
          );
        }
      }
      const key = checkField(field, ["fields", i], issues, identifierCode);
      if (key === undefined) return;
      if (seen.has(key)) {
        issues.add(["fields", i, "key"], "duplicate_key", `Two fields use the key ${shown(key)}.`);
      }
      seen.add(key);
    });
  }

  if (issues.count > 0) return { ok: false, issues: issues.items };
  // The copy is plain, frozen data, and every property was checked above.
  return { ok: true, value: copy as unknown as FieldTemplate };
}

function checkAppliesTo(value: JsonValue | undefined, issues: IssueList): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(
      ["appliesTo"],
      "required",
      `appliesTo must list at least one record kind: ${RECORD_KINDS.join(", ")}.`,
    );
    return;
  }
  const seen = new Set<string>();
  (value as readonly JsonValue[]).forEach((kind, i) => {
    if (!isRecordKind(kind)) {
      issues.add(["appliesTo", i], "invalid_kind", `Record kinds are: ${RECORD_KINDS.join(", ")}.`);
    } else if (seen.has(kind)) {
      issues.add(["appliesTo", i], "duplicate", `${kind} is listed twice.`);
    } else {
      seen.add(kind);
    }
  });
}

/** Checks one field definition; returns its key if the key itself is usable. */
function checkField(
  value: JsonValue,
  path: readonly (string | number)[],
  issues: IssueList,
  identifierCode: CodeRule,
): string | undefined {
  if (!isPlainObject(value)) {
    issues.add(path, "not_an_object", "Each field must be an object.");
    return undefined;
  }
  const f = ownOnly(value);
  unknownProps(f, FIELD_PROPS, path, "a field", issues);

  let key: string | undefined;
  if (isFieldKey(f.key)) {
    key = f.key;
  } else {
    issues.add(
      [...path, "key"],
      "invalid_field_key",
      "Field keys are 1 to 64 lower case letters, digits and underscores, starting with a letter.",
    );
  }
  checkLabel(f.label, [...path, "label"], "Each field", issues);
  if (f.help !== undefined) checkHelp(f.help, [...path, "help"], issues);
  for (const flag of ["required", "repeatable", "inherited"] as const) {
    if (typeof f[flag] !== "boolean") {
      issues.add([...path, flag], "required", `${flag} must be true or false.`);
    }
  }
  if (!(FIELD_VISIBILITIES as readonly unknown[]).includes(f.visibility)) {
    issues.add(
      [...path, "visibility"],
      "invalid_visibility",
      'visibility must be "public" or "staff". It has no default, so no field is made public by mistake.',
    );
  }
  if (f.standards !== undefined) checkStandards(f.standards, [...path, "standards"], issues);

  const kind = f.kind;
  if (!isFieldKind(kind)) {
    issues.add([...path, "kind"], "invalid_kind", `Field kinds are: ${FIELD_KINDS.join(", ")}.`);
    return key;
  }
  for (const [prop, kinds] of KIND_ONLY) {
    if (f[prop] !== undefined && !kinds.includes(kind)) {
      issues.add(
        [...path, prop],
        "not_for_kind",
        `${prop} is only for ${kinds.join(" and ")} fields, not ${kind}.`,
      );
    }
  }
  if (kind === "rights" || f.key === RIGHTS_FIELD_KEY) checkRightsField(f, kind, path, issues);
  if (kind === "list") checkOptions(f.options, [...path, "options"], issues);
  if (kind === "controlled_term" && f.vocabularies !== undefined) {
    checkCodes(f.vocabularies, [...path, "vocabularies"], "vocabulary", issues);
    checkVocabularyCodes(f.vocabularies, [...path, "vocabularies"], issues);
  }
  if (kind === "identifier" && f.identifierTypes !== undefined) {
    checkCodes(
      f.identifierTypes,
      [...path, "identifierTypes"],
      "identifier type",
      issues,
      identifierCode,
    );
  }
  if ((kind === "text" || kind === "long_text") && f.maxLength !== undefined) {
    const cap = kind === "text" ? MAX_TEXT_LENGTH : MAX_LONG_TEXT_LENGTH;
    if (typeof f.maxLength !== "number" || !Number.isInteger(f.maxLength) || f.maxLength < 1) {
      issues.add([...path, "maxLength"], "invalid_number", "maxLength must be a whole number.");
    } else if (f.maxLength > cap) {
      issues.add(
        [...path, "maxLength"],
        "too_large",
        `maxLength for ${kind} can be at most ${String(cap)}.`,
      );
    }
  }
  return key;
}

/**
 * The publish rule reads one rights value from `fields.rights` and publishes
 * its URI; the note is not published (D-011, D-015, D-016). So the `rights` kind and the key `rights`
 * go together, the field holds one value, and it is public. Duplicate keys
 * are refused elsewhere, so a template has at most one rights field.
 */
function checkRightsField(
  f: Readonly<Record<string, JsonValue | undefined>>,
  kind: FieldKind,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  if (kind !== "rights") {
    issues.add(
      [...path, "kind"],
      "rights_key_kind",
      `The field ${shown(RIGHTS_FIELD_KEY)} must have the kind rights, because publishing reads it as the record's rights.`,
    );
    return;
  }
  if (f.key !== RIGHTS_FIELD_KEY) {
    issues.add(
      [...path, "key"],
      "rights_kind_key",
      `A rights field must use the key ${shown(RIGHTS_FIELD_KEY)}, so a template has one and publishing finds it.`,
    );
  }
  if (f.repeatable === true) {
    issues.add(
      [...path, "repeatable"],
      "rights_repeatable",
      "A record has one rights value, so the rights field can't repeat.",
    );
  }
  if (f.visibility === "staff") {
    issues.add(
      [...path, "visibility"],
      "rights_not_public",
      'The rights field is published with the record, so its visibility must be "public". Keep private rights notes in a separate staff field.',
    );
  }
}

function checkOptions(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(path, "required", "A list field needs at least one option.");
    return;
  }
  if (value.length > MAX_LIST_OPTIONS) {
    issues.add(path, "too_many", `A list can have at most ${String(MAX_LIST_OPTIONS)} options.`);
    return;
  }
  const seen = new Set<string>();
  (value as readonly JsonValue[]).forEach((option, i) => {
    if (!isPlainObject(option)) {
      issues.add([...path, i], "not_an_object", "Each option must be { value, label }.");
      return;
    }
    const o = ownOnly(option);
    unknownProps(o, new Set(["value", "label"]), [...path, i], "an option", issues);
    const problem = lineProblem(o.value, MAX_LABEL_LENGTH);
    if (problem !== undefined) {
      issues.add([...path, i, "value"], "invalid_option", `The option value ${problem}.`);
    } else if (typeof o.value === "string") {
      if (seen.has(o.value)) {
        issues.add([...path, i, "value"], "duplicate", `${shown(o.value)} is listed twice.`);
      }
      seen.add(o.value);
    }
    checkLabel(o.label, [...path, i, "label"], "Each option", issues);
  });
}

/** Codes that are well formed but not a vocabulary Oculus knows (D-014). */
function checkVocabularyCodes(
  value: JsonValue,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  if (!Array.isArray(value)) return;
  const known: readonly string[] = VOCABULARY_CODES;
  (value as readonly JsonValue[]).forEach((code, i) => {
    if (isCode(code) && !known.includes(code)) {
      issues.add(
        [...path, i],
        "unknown_vocabulary",
        `${shown(code)} is not a vocabulary Oculus knows (${known.join(", ")}).`,
      );
    }
  });
}

/** How a kind of code is checked, and the rule in words. */
interface CodeRule {
  readonly test: (value: unknown) => value is string;
  readonly rule: string;
}
const GENERAL_CODE: CodeRule = {
  test: isCode,
  rule: "lower case letters, digits, hyphens and underscores, starting with a letter",
};
/** The identifier type key rule (D-031): a template can name only a type that could exist. */
const IDENTIFIER_CODE: CodeRule = { test: isIdentifierTypeKey, rule: IDENTIFIER_TYPE_KEY_RULE };
/** Stored templates only: the old rule, hyphens allowed (`validateLegacyTemplate`). */
const LEGACY_IDENTIFIER_CODE: CodeRule = GENERAL_CODE;

function checkCodes(
  value: JsonValue,
  path: readonly (string | number)[],
  what: string,
  issues: IssueList,
  rule: CodeRule = GENERAL_CODE,
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_CODES) {
    issues.add(
      path,
      "invalid_list",
      `This must list 1 to ${String(MAX_ALLOWED_CODES)} ${what} codes, or be left out to allow any.`,
    );
    return;
  }
  const seen = new Set<string>();
  (value as readonly JsonValue[]).forEach((code, i) => {
    if (!rule.test(code)) {
      issues.add(
        [...path, i],
        "invalid_code",
        `${/^[aeiou]/.test(what) ? "An" : "A"} ${what} code is ${rule.rule}.`,
      );
    } else if (seen.has(code)) {
      issues.add([...path, i], "duplicate", `${shown(code)} is listed twice.`);
    } else {
      seen.add(code);
    }
  });
}

function checkStandards(
  value: JsonValue,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STANDARD_MAPPINGS) {
    issues.add(
      path,
      "invalid_list",
      `standards must list 1 to ${String(MAX_STANDARD_MAPPINGS)} mappings, or be left out.`,
    );
    return;
  }
  const seen = new Set<string>();
  (value as readonly JsonValue[]).forEach((mapping, i) => {
    if (!isPlainObject(mapping)) {
      issues.add(
        [...path, i],
        "not_an_object",
        "Each mapping must be { standard, element, uri? }.",
      );
      return;
    }
    const m = ownOnly(mapping);
    unknownProps(m, new Set(["standard", "element", "uri"]), [...path, i], "a mapping", issues);
    if (!isCode(m.standard)) {
      issues.add(
        [...path, i, "standard"],
        "invalid_code",
        "The standard is a short code such as dacs, spectrum or dcterms.",
      );
    }
    const problem = lineProblem(m.element, MAX_LABEL_LENGTH);
    if (problem !== undefined) {
      issues.add([...path, i, "element"], "invalid_element", `The element ${problem}.`);
    }
    if (m.uri !== undefined) checkUrl(m.uri, [...path, i, "uri"], issues);
    if (typeof m.standard === "string" && typeof m.element === "string") {
      // JSON keeps the two parts apart whatever characters they contain.
      const pair = JSON.stringify([m.standard, m.element]);
      if (seen.has(pair)) {
        issues.add([...path, i], "duplicate", "This mapping is listed twice.");
      }
      seen.add(pair);
    }
  });
}

function checkLabel(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  who: string,
  issues: IssueList,
): void {
  const problem = lineProblem(value, MAX_LABEL_LENGTH);
  if (problem !== undefined)
    issues.add(path, "invalid_label", `${who} needs a label that ${problem}.`);
}

function checkHelp(value: JsonValue, path: readonly (string | number)[], issues: IssueList): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(path, "invalid_text", "This must be text, or be left out.");
  } else if (value.length > MAX_HELP_LENGTH) {
    issues.add(path, "too_long", `This can be at most ${String(MAX_HELP_LENGTH)} characters.`);
  }
}

// ---------------------------------------------------------------------------
// The template registry: an organization's templates, found by key.

/** The most templates one registry from `indexTemplates` may hold. */
export const MAX_REGISTRY_TEMPLATES = 1000;

/**
 * An organization's templates, each validated once and found by its key,
 * from `indexTemplates`. Opaque and frozen: one consistent snapshot, which
 * must be built again after any template is edited. Anything else passed as
 * one is not a registry.
 */
export interface TemplateRegistry {
  /** How many templates it holds. */
  readonly size: number;
}

/** Registries made by `indexTemplates`, with their validated templates by key. */
const REGISTRIES = new WeakMap<object, ReadonlyMap<string, FieldTemplate>>();

/** True when `template` and `record` belong to the same organization. */
function sameOrganization(template: FieldTemplate, record: CatalogRecord): boolean {
  return oneOrganization([template, record]) === template.organizationId;
}

const WRONG_ORGANIZATION = (key: string) =>
  issue(
    ["organizationId"],
    "wrong_organization",
    `The template ${shown(key)} belongs to another organization than this record. Each organization uses only its own templates.`,
  );

/**
 * Validate a list of templates once and index them by key, for
 * `checkRecordAgainstTemplate`, `effectiveRecord` and `publicOutput`. Each
 * template is validated (copied) now, so later changes to the caller's
 * objects are not seen. Any invalid template, a key used twice, a hole,
 * getter or Proxy refuses the whole list: a registry that quietly left one
 * out could not say which template a record follows. The keys come from the
 * templates themselves, never from a separate map that could disagree with
 * them. All the templates must belong to one organization
 * (`mixed_organizations`): a registry is one organization's templates.
 * Never throws.
 */
export function indexTemplates(templates: unknown): Validated<TemplateRegistry> {
  try {
    if (types.isProxy(templates) || !Array.isArray(templates)) {
      return refused([], "not_a_list", "The templates must be given as a list.");
    }
    const length = templates.length;
    if (length > MAX_REGISTRY_TEMPLATES) {
      return refused(
        [],
        "too_many",
        `A registry can hold at most ${String(MAX_REGISTRY_TEMPLATES)} templates.`,
      );
    }
    const byKey = new Map<string, FieldTemplate>();
    const owners: FieldTemplate[] = [];
    const issues = new IssueList();
    for (let i = 0; i < length && !issues.full; i += 1) {
      // Read each slot as a plain data property, so a getter can't run.
      const slot = Object.getOwnPropertyDescriptor(templates, i);
      const given: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
      const checked = validateTemplate(given);
      if (!checked.ok) {
        for (const found of checked.issues) {
          issues.add([i, ...found.path], found.code, found.message);
        }
        continue;
      }
      const key = checked.value.key;
      if (byKey.has(key)) {
        issues.add(
          [i, "key"],
          "duplicate_key",
          `More than one template has the key ${shown(key)}.`,
        );
        continue;
      }
      byKey.set(key, checked.value);
      owners.push(checked.value);
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    if (oneOrganization(owners) === "mixed") {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These templates")] };
    }
    const registry: TemplateRegistry = Object.freeze({ size: byKey.size });
    REGISTRIES.set(registry, byKey);
    return { ok: true, value: registry };
  } catch {
    return refused([], "unreadable", "The templates could not be read as plain data.");
  }
}

/** True if `value` is a registry made by `indexTemplates`. */
export function isTemplateRegistry(value: unknown): value is TemplateRegistry {
  return typeof value === "object" && value !== null && REGISTRIES.has(value);
}

function refused(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: [issue(path, code, message)] };
}

/**
 * The record's `templateKey`: undefined only when the record has no own
 * `templateKey` property at all (a record stored before records named their
 * template). An own property that is undefined, a getter or anything not a
 * valid key is refused (`invalid_template_key`), never read as "no key": that
 * would let the record be checked against any template. For this module,
 * `effective.ts` and `public-output.ts` (not exported from the package).
 * Never runs a getter; never throws.
 */
export function storedTemplateKey(record: unknown): Validated<string | undefined> {
  try {
    if (typeof record !== "object" || record === null || types.isProxy(record)) {
      return refused([], "invalid_record", "This is not a record. Check it with validateRecord.");
    }
    const d = Object.getOwnPropertyDescriptor(record, "templateKey");
    if (d === undefined) return { ok: true, value: undefined };
    const value: unknown = "value" in d ? d.value : undefined;
    if (!("value" in d) || !isTemplateKey(value)) {
      return refused(
        ["templateKey"],
        "invalid_template_key",
        "The record's templateKey is not a valid template key, so its template can't be found.",
      );
    }
    return { ok: true, value };
  } catch {
    return refused([], "unreadable", "The record's template could not be found.");
  }
}

/**
 * The validated template `record` follows: from a registry, the one its
 * `templateKey` names; otherwise `given`, validated, which must have the
 * record's `templateKey` (if it has one) as its key. Either way the template
 * must belong to the record's organization (`wrong_organization`). For this module,
 * `effective.ts` and `public-output.ts` (not exported from the package).
 * Messages name template keys only, never a record's title or values.
 * Never throws.
 */
export function templateOfRecord(record: CatalogRecord, given: unknown): Validated<FieldTemplate> {
  try {
    const key = storedTemplateKey(record);
    if (!key.ok) return key;
    const stored = key.value;
    const registered = isTemplateRegistry(given) ? REGISTRIES.get(given) : undefined;
    if (registered !== undefined) {
      if (stored === undefined) {
        return refused(
          ["templateKey"],
          "no_template_key",
          "This record doesn't say which template it follows, so its template can't be found in the registry. Give it a templateKey.",
        );
      }
      const template = registered.get(stored);
      if (template === undefined) {
        return refused(
          ["templateKey"],
          "unknown_template",
          `There is no template with the key ${shown(stored)} in the registry.`,
        );
      }
      if (!sameOrganization(template, record)) {
        return { ok: false, issues: [WRONG_ORGANIZATION(template.key)] };
      }
      return { ok: true, value: template };
    }
    const checked = validateTemplate(given);
    if (!checked.ok) {
      return refused(
        [],
        "invalid_template",
        "The template is not valid, so the record can't be checked against it. Check it with validateTemplate.",
      );
    }
    if (stored !== undefined && checked.value.key !== stored) {
      return refused(
        ["templateKey"],
        "template_mismatch",
        `This record follows the template ${shown(stored)}, not ${shown(checked.value.key)}, so it can't be checked against that one.`,
      );
    }
    if (!sameOrganization(checked.value, record)) {
      return { ok: false, issues: [WRONG_ORGANIZATION(checked.value.key)] };
    }
    return checked;
  } catch {
    return refused([], "unreadable", "The record's template could not be found.");
  }
}

// ---------------------------------------------------------------------------
// Checking a record against its template.

/** A problem a plugged-in checker found, relative to the value it was given. */
export interface FieldProblem {
  readonly code: string;
  readonly message: string;
  /** Where inside the value, e.g. `["uri"]`. Empty or missing for the whole value. */
  readonly path?: readonly (string | number)[];
}

/**
 * Extra checks for one field kind, run on each value after its structure
 * passed. This is how identifier types (T-004), rights statements (T-007),
 * vocabularies (T-009) and place records plug in. Returns no problems for a
 * good value. A checker that throws or returns something else makes the
 * value fail with `check_failed`, never pass.
 */
export type FieldValueChecker = (
  value: JsonValue,
  field: FieldDefinition,
  record: CatalogRecord,
) => readonly FieldProblem[];

export interface TemplateCheckOptions {
  /**
   * Checkers by field kind. One given here replaces the default for its kind
   * (`rights` has one). Leaving a kind out, or giving `undefined`, keeps the
   * default, so a default can't be switched off by accident; to skip a check
   * on purpose, pass a checker that returns `[]`. Values of the `identifier`
   * kind are refused (`unchecked`) unless a checker is given.
   */
  readonly checkers?: Readonly<Partial<Record<FieldKind, FieldValueChecker | undefined>>>;
  /**
   * Don't report a missing required field that is `inherited`, because a
   * unit higher up may supply it. Use when saving one unit; check the
   * effective record (T-008) with this off.
   */
  readonly allowMissingInherited?: boolean;
}

/**
 * Check a record's `fields` against its template. The record must already
 * be validated (`validateRecord`). The template is validated again here, so
 * a template that never went through `validateTemplate` fails closed with
 * `invalid_template` instead of letting values through. Returns every
 * problem found, or an empty list. Never throws.
 *
 * In place of the template, a registry from `indexTemplates` may be given:
 * the template is then the one the record's `templateKey` names
 * (`no_template_key` without one, `unknown_template` if the registry doesn't
 * have it). A template given directly must have the record's `templateKey`
 * as its key (`template_mismatch`); a record with no `templateKey` (stored
 * before records named their template) is checked against it as before.
 * The template must belong to the record's organization
 * (`wrong_organization`, D-030).
 *
 * Optional settings, in the template and in `options`, are read only as own
 * properties, so a polluted `Object.prototype` can't change them.
 */
export function checkRecordAgainstTemplate(
  record: CatalogRecord,
  untrustedTemplate: FieldTemplate | TemplateRegistry,
  options: TemplateCheckOptions = {},
): Issue[] {
  const issues = new IssueList();
  try {
    // The record is validated here too, so a hand-made record (a templateKey
    // that is undefined or a getter, say) can't pass as an older keyless one.
    const valid = validateRecord(record);
    if (!valid.ok) {
      issues.add(
        [],
        "invalid_record",
        "The record is not valid, so it can't be checked against a template. Check it with validateRecord.",
      );
      return issues.items;
    }
    record = valid.value;
    const found = templateOfRecord(record, untrustedTemplate);
    if (!found.ok) return [...found.issues];
    const template = found.value;
    const settings: CheckSettings = {
      allowMissingInherited: ownValue(options, "allowMissingInherited") === true,
      checkers: ownValue(options, "checkers"),
    };
    if (!template.appliesTo.includes(record.kind)) {
      issues.add(
        ["kind"],
        "wrong_template",
        `The template ${shown(template.key)} is not for ${record.kind} records.`,
      );
      return issues.items;
    }
    // Null-prototype copies: an optional setting that isn't there reads as
    // undefined, never as something inherited.
    const fields = template.fields.map(
      (f) => Object.freeze(Object.assign(Object.create(null) as object, f)) as FieldDefinition,
    );
    const byKey = new Map<string, FieldDefinition>();
    for (const field of fields) byKey.set(field.key, field);

    for (const key of Object.keys(record.fields)) {
      if (!byKey.has(key)) {
        issues.add(
          ["fields", key],
          "unknown_field",
          `${shown(key)} is not a field in the template ${shown(template.key)}.`,
        );
      }
    }

    for (const field of fields) {
      if (issues.full) break;
      const path = ["fields", field.key];
      const value = Object.hasOwn(record.fields, field.key) ? record.fields[field.key] : undefined;
      if (value === undefined) {
        if (field.required && !(field.inherited && settings.allowMissingInherited)) {
          issues.add(path, "required", `${shown(field.label)} is required.`);
        }
        continue;
      }
      if (value === null) {
        issues.add(path, "empty_value", `${shown(field.label)} is empty. Leave it out instead.`);
        continue;
      }
      if (field.repeatable) {
        checkRepeated(value, field, path, record, settings, issues);
      } else if (Array.isArray(value)) {
        issues.add(path, "not_repeatable", `${shown(field.label)} takes one value, not a list.`);
      } else {
        checkOne(value, field, path, record, settings, issues);
      }
    }
  } catch {
    issues.add([], "unreadable", "This record could not be checked against its template.");
  }
  return issues.items;
}

function checkRepeated(
  value: JsonValue,
  field: FieldDefinition,
  path: readonly (string | number)[],
  record: CatalogRecord,
  settings: CheckSettings,
  issues: IssueList,
): void {
  if (!Array.isArray(value)) {
    issues.add(path, "not_a_list", `${shown(field.label)} repeats, so its value must be a list.`);
    return;
  }
  const list = value as readonly JsonValue[];
  if (list.length === 0) {
    issues.add(
      path,
      "empty_value",
      `${shown(field.label)} is an empty list. Leave it out instead.`,
    );
    return;
  }
  if (list.length > MAX_REPEATS) {
    issues.add(
      path,
      "too_many",
      `${shown(field.label)} can hold at most ${String(MAX_REPEATS)} values.`,
    );
    return;
  }
  const seen = new Set<string>();
  list.forEach((item, i) => {
    if (issues.full) return;
    const before = issues.count;
    if (item === null || Array.isArray(item)) {
      issues.add([...path, i], "invalid_value", "Each value in the list must be a single value.");
      return;
    }
    checkOne(item, field, [...path, i], record, settings, issues);
    if (issues.count > before) return;
    // Exact repeats only: the same object with its keys in another order
    // isn't caught, which is harmless.
    const text = JSON.stringify(item);
    if (seen.has(text)) issues.add([...path, i], "duplicate", "This value is listed twice.");
    seen.add(text);
  });
}

function checkOne(
  value: JsonValue,
  field: FieldDefinition,
  path: readonly (string | number)[],
  record: CatalogRecord,
  settings: CheckSettings,
  issues: IssueList,
): void {
  const before = issues.count;
  checkShape(value, field, path, issues);
  if (issues.count > before) return;
  const given = ownValue(settings.checkers, field.kind);
  const checker = given === undefined ? defaultChecker(field.kind) : given;
  if (checker === undefined) {
    if (CHECKER_REQUIRED.has(field.kind)) {
      issues.add(
        path,
        "unchecked",
        `${shown(field.label)} can't be checked without the organization's identifier types, so it can't be accepted. Pass checkers.identifier (makeIdentifierChecker).`,
      );
    }
    return;
  }
  let problems: unknown;
  try {
    problems =
      typeof checker === "function"
        ? (checker as FieldValueChecker)(value, field, record)
        : undefined;
  } catch {
    problems = undefined;
  }
  if (!Array.isArray(problems)) {
    issues.add(path, "check_failed", `${shown(field.label)} could not be checked.`);
    return;
  }
  for (const p of problems as readonly unknown[]) {
    if (
      !isPlainObject(p) ||
      typeof p.code !== "string" ||
      typeof p.message !== "string" ||
      (p.path !== undefined && !Array.isArray(p.path))
    ) {
      issues.add(path, "check_failed", `${shown(field.label)} could not be checked.`);
      return;
    }
    const sub = (p.path ?? []) as readonly unknown[];
    const parts = sub.filter(
      (x): x is string | number => typeof x === "string" || Number.isInteger(x),
    );
    if (parts.length !== sub.length) {
      issues.add(path, "check_failed", `${shown(field.label)} could not be checked.`);
      return;
    }
    issues.add([...path, ...parts], p.code, p.message);
  }
}

/** The built-in structure check for one value of `field`'s kind. */
function checkShape(
  value: JsonValue,
  field: FieldDefinition,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  const label = shown(field.label);
  switch (field.kind) {
    case "text": {
      const max = field.maxLength ?? MAX_TEXT_LENGTH;
      const problem = lineProblem(value, max);
      if (problem !== undefined) issues.add(path, "invalid_text", `${label} ${problem}.`);
      return;
    }
    case "long_text": {
      const max = field.maxLength ?? MAX_LONG_TEXT_LENGTH;
      if (typeof value !== "string") {
        issues.add(path, "not_text", `${label} must be text.`);
      } else if (value.trim().length === 0) {
        issues.add(path, "empty_value", `${label} is empty. Leave it out instead.`);
      } else if (value.length > max) {
        issues.add(path, "too_long", `${label} can be at most ${String(max)} characters.`);
      }
      return;
    }
    case "date": {
      const parsed = parseEdtf(value);
      if (!parsed.ok) {
        const first = parsed.issues[0];
        issues.add(
          path,
          "invalid_date",
          `${label} must be an EDTF date such as 1909, 1909~ or 195X${first === undefined ? "" : `: ${first.message}`}`,
        );
      }
      return;
    }
    case "list": {
      const allowed = (field.options ?? []).some((o) => o.value === value);
      if (!allowed) {
        issues.add(path, "not_an_option", `${label} must be one of the template's options.`);
      }
      return;
    }
    case "controlled_term": {
      const v = objectValue(value, ["label", "uri", "vocabulary"], path, label, issues);
      if (v === undefined) return;
      requiredLine(v.label, [...path, "label"], "The term", issues);
      if (v.uri !== undefined) checkUrl(v.uri, [...path, "uri"], issues);
      if (v.vocabulary !== undefined) {
        checkAllowedCode(
          v.vocabulary,
          field.vocabularies,
          [...path, "vocabulary"],
          "vocabulary",
          issues,
        );
      } else if (field.vocabularies !== undefined && !field.vocabularies.includes("local")) {
        // No vocabulary means a local term (D-014).
        issues.add(
          [...path, "vocabulary"],
          "required",
          `This field takes terms from ${field.vocabularies.join(", ")}, not local terms, so the term needs its vocabulary.`,
        );
      }
      return;
    }
    case "identifier": {
      const v = objectValue(value, ["type", "value"], path, label, issues);
      if (v === undefined) return;
      checkAllowedCode(
        v.type,
        field.identifierTypes,
        [...path, "type"],
        "identifier type",
        issues,
        IDENTIFIER_CODE,
      );
      requiredLine(v.value, [...path, "value"], "The identifier", issues);
      return;
    }
    case "link": {
      const v = objectValue(value, ["url", "label"], path, label, issues);
      if (v === undefined) return;
      if (v.url === undefined) issues.add([...path, "url"], "required", "A link needs a url.");
      else checkUrl(v.url, [...path, "url"], issues);
      if (v.label !== undefined)
        requiredLine(v.label, [...path, "label"], "The link label", issues);
      return;
    }
    case "rights": {
      const v = objectValue(value, ["uri", "note"], path, label, issues);
      if (v === undefined) return;
      if (v.uri === undefined) {
        issues.add(
          [...path, "uri"],
          "required",
          "A rights value needs the statement or license URI.",
        );
      } else {
        checkUrl(v.uri, [...path, "uri"], issues);
      }
      if (v.note !== undefined) checkHelp(v.note, [...path, "note"], issues);
      return;
    }
    case "place": {
      const v = objectValue(value, ["label", "uri", "recordId"], path, label, issues);
      if (v === undefined) return;
      requiredLine(v.label, [...path, "label"], "The place", issues);
      if (v.uri !== undefined) checkUrl(v.uri, [...path, "uri"], issues);
      if (v.recordId !== undefined && !isRecordId(v.recordId)) {
        issues.add([...path, "recordId"], "invalid_id", "recordId must be a record ID.");
      }
      return;
    }
    default:
      // Unreachable for a validated template; fail closed if it ever happens.
      issues.add(
        path,
        "invalid_kind",
        "This field's kind is unknown, so no value can be accepted.",
      );
  }
}

/**
 * The checker that runs when the caller gives none for the kind (D-014,
 * D-015). A function, not a table built at load time, because
 * vocabularies.ts and this module import each other.
 */
function defaultChecker(kind: FieldKind): FieldValueChecker | undefined {
  if (kind === "rights") return checkRightsValue;
  if (kind === "controlled_term") return controlledTermChecker;
  return undefined;
}
/** Kinds whose values are refused when no checker is given, because no default can exist. */
const CHECKER_REQUIRED: ReadonlySet<FieldKind> = new Set<FieldKind>(["identifier"]);

interface CheckSettings {
  readonly allowMissingInherited: boolean;
  readonly checkers: unknown;
}

/** `obj[key]` if it is an own property of an object, otherwise undefined. */
function ownValue(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || !Object.hasOwn(obj, key)) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function objectValue(
  value: JsonValue,
  allowed: readonly string[],
  path: readonly (string | number)[],
  label: string,
  issues: IssueList,
): Readonly<Record<string, JsonValue | undefined>> | undefined {
  if (!isPlainObject(value)) {
    issues.add(path, "not_an_object", `${label} must be { ${allowed.join(", ")} }.`);
    return undefined;
  }
  const v = ownOnly(value);
  const before = issues.count;
  unknownProps(v, new Set(allowed), path, `${label}'s value`, issues);
  return issues.count > before ? undefined : v;
}

function requiredLine(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  who: string,
  issues: IssueList,
): void {
  const problem = lineProblem(value, MAX_SHORT_TEXT_LENGTH);
  if (problem !== undefined) issues.add(path, "invalid_text", `${who} ${problem}.`);
}

function checkAllowedCode(
  value: JsonValue | undefined,
  allowed: readonly string[] | undefined,
  path: readonly (string | number)[],
  what: string,
  issues: IssueList,
  rule: CodeRule = GENERAL_CODE,
): void {
  if (value === undefined) {
    issues.add(path, "required", `This value needs a ${what}.`);
  } else if (!rule.test(value)) {
    issues.add(path, "invalid_code", `The ${what} is a code of ${rule.rule}.`);
  } else if (allowed !== undefined && !allowed.includes(value)) {
    issues.add(
      path,
      "not_allowed",
      `${shown(value)} is not a ${what} this field allows (${allowed.join(", ")}).`,
    );
  }
}

function checkUrl(value: JsonValue, path: readonly (string | number)[], issues: IssueList): void {
  const problem = typeof value === "string" ? webUrlProblem(value) : "must be text";
  if (problem !== undefined) issues.add(path, "invalid_url", `The web address ${problem}.`);
}

// ---------------------------------------------------------------------------

/** Why `value` isn't one trimmed, non-empty line of at most `max` characters. */
function lineProblem(value: JsonValue | undefined, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "must be text, and not empty";
  if (value.trim().length === 0) return "is only spaces";
  if (value !== value.trim()) return "starts or ends with spaces";
  if (LINE_BREAKS.test(value)) return "must be one line, with no tabs or line breaks";
  if (value.length > max) return `can be at most ${String(max)} characters`;
  return undefined;
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
