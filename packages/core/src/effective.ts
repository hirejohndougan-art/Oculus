/**
 * The effective record (decision D-013).
 *
 * An archival unit takes the values of its `inherited` fields from the units
 * above it (fonds › series › collection › file › item, D-007), unless it has
 * its own value. Rights or a creator set once on a fonds then apply to every
 * item below it. `effectiveRecord` works out what a record looks like after
 * inheriting: each field's value, the record it came from (or the record's
 * own value), and the visibility that applies to it. This is what the
 * Effective Record screen shows and what publishing (T-010) starts from, so
 * the rights publish check (`rightsPublishIssues`) runs on this result.
 *
 * The rules, for one field key, looking up from the record:
 * - The record's own value wins. A repeatable field's own list replaces the
 *   inherited list; lists are never merged.
 * - Only a field whose definition in the record's template says
 *   `inherited: true` inherits.
 * - Going up, a unit whose template doesn't have the key is passed over. A
 *   unit whose template has the key but not as `inherited` stops the search:
 *   the value doesn't come down past that level.
 * - The nearest unit with a stored value decides. An empty stored value
 *   (`null`, blank text or `[]`, which templates refuse anyway) means "none":
 *   nothing is inherited from it or from above it, so an empty value can
 *   never let an ancestor's value through by accident.
 * - The value is only inherited when the two definitions have the same kind
 *   and the same `repeatable`, and it passes the record's own template check
 *   (list options, lengths, allowed codes). Otherwise the field is left out
 *   and a note says why. There is no second try further up.
 * - **Visibility is the strictest along the way.** Records in one tree can
 *   use different templates, and each template sets visibility for its own
 *   fields. An inherited value is `staff` if the field is `staff` in the
 *   template of the record it came from, of the record receiving it, or of
 *   any unit in between that has the key. A staff value can't become public
 *   by being inherited into a template that marks the key public.
 * - Values the record holds for keys its template doesn't have (left over
 *   after a template edit) are kept as its own, marked `staff` and
 *   `inTemplate: false`. They are never inherited.
 *
 * Parents are found by `parentId` in a set of records given by the caller
 * (there is no database yet). Building the lookup is linear in the size of
 * the set; `indexRecords` builds it once so many records can be worked out
 * from one set without going quadratic. A loop of parents, a parent missing
 * from the set, an ID used twice, a parent at the wrong level or a tree
 * deeper than MAX_ARRANGEMENT_DEPTH makes the whole result fail, because a
 * record whose ancestors can't be trusted can't be published safely.
 *
 * Every record on the way up is re-checked with `validateRecord`, so the
 * result is built from frozen copies, never from the caller's objects. The
 * result is frozen. Nothing here throws.
 */
import { issue, type Issue, type Validated } from "./issues.js";
import { shown } from "./plain-data.js";
import { types } from "node:util";
import { MAX_ARRANGEMENT_DEPTH, canFileUnder } from "./arrangement.js";
import { isRecordId, type RecordId } from "./record-id.js";
import {
  validateRecord,
  type ArchivalLevel,
  type ArchivalUnitRecord,
  type CatalogRecord,
  type FieldValue,
  type RecordKind,
} from "./records.js";
import {
  checkRecordAgainstTemplate,
  validateTemplate,
  type FieldDefinition,
  type FieldTemplate,
  type FieldVisibility,
} from "./templates.js";

/** The most records a set given to `indexRecords` or `effectiveRecord` may hold. */
export const MAX_RECORD_SET = 1_000_000;

/** One record on the way from the top of the tree down to the record itself. */
export interface ChainStep {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly title: string;
  /** For archival units only. */
  readonly level?: ArchivalLevel;
}

/** One field of the effective record, with where its value came from. */
export interface EffectiveField {
  readonly key: string;
  /** The label in the record's own template (the key itself for a left-over field). */
  readonly label: string;
  readonly value: FieldValue;
  /** True when the value is the record's own; false when inherited. */
  readonly own: boolean;
  /** The record the value came from: the record itself when `own`. */
  readonly from: ChainStep;
  /** The strictest visibility along the way (see the module header). */
  readonly visibility: FieldVisibility;
  /** False for a value whose key isn't in the record's template; always `staff`. */
  readonly inTemplate: boolean;
}

export interface EffectiveRecord {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly title: string;
  /** The effective values, keyed by field key. Includes staff fields; filter by `entries`. */
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** The same values in template order (left-over fields last), with their source and visibility. */
  readonly entries: readonly EffectiveField[];
  /** From the top of the tree down; the last step is the record itself. */
  readonly chain: readonly ChainStep[];
  /** Inherited values that were left out, and why. */
  readonly notes: readonly Issue[];
  /** The record as stored (a validated, frozen copy). */
  readonly record: CatalogRecord;
}

/**
 * Gives the template a record uses. Called at most once per record on the
 * way up, with a frozen copy. Returning undefined or throwing fails the
 * result. The template is validated before it is used.
 */
export type TemplateLookup = (record: CatalogRecord) => FieldTemplate | undefined;

/** A set of records indexed by ID, from `indexRecords`. Opaque. */
export interface RecordLookup {
  /** How many records were indexed. */
  readonly size: number;
}

// ---------------------------------------------------------------------------

/** Thrown inside this module only; the public functions turn it into an issue. */
class EffectiveError extends Error {
  constructor(
    readonly path: readonly (string | number)[],
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(path: readonly (string | number)[], code: string, message: string): never {
  throw new EffectiveError(path, code, message);
}

type Fetched =
  | { readonly ok: true; readonly record: CatalogRecord }
  | { readonly ok: false; readonly why: "missing" | "duplicate" | "invalid" };

interface LookupState {
  /** The caller's objects, by the ID they had when indexed. */
  readonly raw: ReadonlyMap<RecordId, unknown>;
  readonly duplicated: ReadonlySet<RecordId>;
  /** Validated copies (or why not), so each record is checked once per lookup. */
  readonly checked: Map<RecordId, Fetched>;
}

/** Lookups made by `indexRecords`; anything else passed as one is refused. */
const LOOKUPS = new WeakMap<object, LookupState>();

/**
 * Index a set of records by ID, once, for many `effectiveRecord` calls.
 * Entries that aren't plain records with a valid ID are skipped (a parent
 * that is skipped is then reported missing). IDs used more than once are
 * remembered, and using one fails. Each record is validated the first time
 * it is needed, and that frozen copy is used from then on. Never throws.
 */
export function indexRecords(records: unknown): Validated<RecordLookup> {
  try {
    return { ok: true, value: buildLookup(records) };
  } catch (error) {
    return failure(error);
  }
}

function buildLookup(records: unknown): RecordLookup {
  if (types.isProxy(records) || !Array.isArray(records)) {
    fail([], "not_a_list", "The records must be given as a list.");
  }
  const length = records.length;
  if (length > MAX_RECORD_SET) {
    fail(
      [],
      "too_many_records",
      `At most ${String(MAX_RECORD_SET)} records can be looked through at once.`,
    );
  }
  const raw = new Map<RecordId, unknown>();
  const duplicated = new Set<RecordId>();
  for (let i = 0; i < length; i += 1) {
    // Read each slot as a plain data property, so a getter can't run.
    const slot = Object.getOwnPropertyDescriptor(records, i);
    if (slot === undefined || !("value" in slot)) continue;
    const record: unknown = slot.value;
    const id = idOf(record);
    if (id === undefined) continue;
    if (raw.has(id)) duplicated.add(id);
    else raw.set(id, record);
  }
  const lookup: RecordLookup = Object.freeze({ size: raw.size });
  LOOKUPS.set(lookup, { raw, duplicated, checked: new Map() });
  return lookup;
}

/** The record's own `id`, read without running a getter, or undefined. */
function idOf(record: unknown): RecordId | undefined {
  if (typeof record !== "object" || record === null || types.isProxy(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, "id");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const id: unknown = descriptor.value;
  return isRecordId(id) ? id : undefined;
}

function fetchRecord(state: LookupState, id: RecordId): Fetched {
  const known = state.checked.get(id);
  if (known !== undefined) return known;
  let result: Fetched;
  if (state.duplicated.has(id)) {
    result = { ok: false, why: "duplicate" };
  } else if (!state.raw.has(id)) {
    result = { ok: false, why: "missing" };
  } else {
    const checked = validateRecord(state.raw.get(id));
    // The copy must still carry the ID it was indexed under.
    result =
      checked.ok && checked.value.id === id
        ? { ok: true, record: checked.value }
        : { ok: false, why: "invalid" };
  }
  state.checked.set(id, result);
  return result;
}

// ---------------------------------------------------------------------------

/**
 * The effective record for `recordId`: its own values plus what it inherits
 * from the units above it, each with its source and effective visibility
 * (see the module header for the rules). `records` is the set to find the
 * record and its parents in, either a list or a lookup from `indexRecords`.
 * `templateFor` gives each record's template. Fails, with one issue, when
 * the record or any ancestor can't be found, read or trusted. Never throws.
 */
export function effectiveRecord(
  recordId: RecordId,
  records: RecordLookup | readonly CatalogRecord[],
  templateFor: TemplateLookup,
): Validated<EffectiveRecord> {
  try {
    if (!isRecordId(recordId)) fail([], "invalid_id", "The record ID must be a record ID.");
    if (typeof templateFor !== "function") {
      fail([], "no_template_lookup", "templateFor must be a function.");
    }
    // Callers may pass anything at run time, whatever the type says.
    const given: unknown = records;
    const state = typeof given === "object" && given !== null ? LOOKUPS.get(given) : undefined;
    const lookup = state ?? stateOf(buildLookup(records));
    const up = ancestry(recordId, lookup);
    const templates = templatesFor(up, templateFor);
    return { ok: true, value: compose(up, templates) };
  } catch (error) {
    return failure(error);
  }
}

function stateOf(lookup: RecordLookup): LookupState {
  const state = LOOKUPS.get(lookup);
  if (state === undefined) fail([], "unreadable", "The records could not be indexed.");
  return state;
}

function failure(error: unknown): { readonly ok: false; readonly issues: readonly Issue[] } {
  const found =
    error instanceof EffectiveError
      ? issue(error.path, error.code, error.message)
      : // Only hostile input (or a template lookup that throws oddly) gets here.
        issue([], "unreadable", "The effective record could not be worked out from this data.");
  return Object.freeze({ ok: false, issues: Object.freeze([Object.freeze(found)]) });
}

/** The record and its ancestors, the record first. */
function ancestry(recordId: RecordId, state: LookupState): readonly CatalogRecord[] {
  const up: CatalogRecord[] = [];
  const seen = new Set<RecordId>();
  let id: RecordId | undefined = recordId;
  let child: ArchivalUnitRecord | undefined;
  while (id !== undefined) {
    if (seen.has(id)) {
      fail([id], "loop", `${shown(child?.title)} is filed inside itself, through a loop of units.`);
    }
    if (up.length >= MAX_ARRANGEMENT_DEPTH) {
      fail(
        [recordId],
        "too_deep",
        `The record is more than ${String(MAX_ARRANGEMENT_DEPTH)} levels deep.`,
      );
    }
    const got = fetchRecord(state, id);
    if (!got.ok) fetchFailed(id, got.why, child);
    const record = got.record;
    if (child !== undefined) {
      if (record.kind !== "archival_unit") {
        fail(
          [child.id, "parentId"],
          "not_a_unit",
          `${shown(child.title)} is filed under ${shown(record.title)}, which isn't an archival unit.`,
        );
      }
      if (!canFileUnder(child.level, record.level)) {
        fail(
          [child.id, "parentId"],
          "wrong_level",
          `A ${child.level} can't be filed under a ${record.level} (${shown(child.title)} under ${shown(record.title)}).`,
        );
      }
    }
    seen.add(id);
    up.push(record);
    if (record.kind === "archival_unit") {
      child = record;
      id = record.parentId;
    } else {
      id = undefined;
    }
  }
  return up;
}

function fetchFailed(
  id: RecordId,
  why: "missing" | "duplicate" | "invalid",
  child: ArchivalUnitRecord | undefined,
): never {
  if (child === undefined) {
    const [code, message] = RECORD_PROBLEMS[why];
    fail([id], code, message);
  }
  const [code, message] = PARENT_PROBLEMS[why];
  fail([child.id, "parentId"], code, `${shown(child.title)} ${message}`);
}

const RECORD_PROBLEMS = {
  missing: ["not_found", "There is no record with this ID in the set."],
  duplicate: ["duplicate_id", "More than one record in the set uses this ID."],
  invalid: ["invalid_record", "This record isn't valid. Check it with validateRecord."],
} as const;

const PARENT_PROBLEMS = {
  missing: ["missing_parent", "is filed under a unit that isn't in the set."],
  duplicate: ["ambiguous_parent", "is filed under an ID that more than one record uses."],
  invalid: [
    "invalid_parent",
    "is filed under a unit that isn't valid. Check it with validateRecord.",
  ],
} as const;

interface CheckedTemplate {
  readonly template: FieldTemplate;
  readonly byKey: ReadonlyMap<string, FieldDefinition>;
}

/** Each record's validated template, in the same order as `up`. */
function templatesFor(
  up: readonly CatalogRecord[],
  templateFor: TemplateLookup,
): readonly CheckedTemplate[] {
  // The same template object is validated once per call.
  const seen = new Map<unknown, CheckedTemplate>();
  return up.map((record) => {
    let given: unknown;
    try {
      given = templateFor(record);
    } catch {
      fail(
        [record.id],
        "template_lookup_failed",
        `Finding the template for ${shown(record.title)} failed.`,
      );
    }
    if (given === undefined) {
      fail([record.id], "no_template", `${shown(record.title)} has no template.`);
    }
    let checked = seen.get(given);
    if (checked === undefined) {
      const result = validateTemplate(given);
      if (!result.ok) {
        fail(
          [record.id],
          "invalid_template",
          `The template for ${shown(record.title)} is not valid. Check it with validateTemplate.`,
        );
      }
      const byKey = new Map<string, FieldDefinition>();
      for (const field of result.value.fields) byKey.set(field.key, field);
      checked = { template: result.value, byKey };
      seen.set(given, checked);
    }
    if (!checked.template.appliesTo.includes(record.kind)) {
      fail(
        [record.id],
        "wrong_template",
        `The template ${shown(checked.template.key)} is not for ${record.kind} records (${shown(record.title)}).`,
      );
    }
    return checked;
  });
}

// ---------------------------------------------------------------------------

interface Candidate {
  readonly key: string;
  readonly label: string;
  readonly value: FieldValue;
  /** Index into `up`: 0 is the record itself. */
  readonly from: number;
  readonly visibility: FieldVisibility;
  readonly inTemplate: boolean;
}

function compose(
  up: readonly CatalogRecord[],
  templates: readonly CheckedTemplate[],
): EffectiveRecord {
  const target = up[0];
  const own = templates[0];
  if (target === undefined || own === undefined) {
    fail([], "unreadable", "The record could not be read.");
  }
  const notes: Issue[] = [];
  const candidates: Candidate[] = [];

  for (const field of own.template.fields) {
    const stored = ownField(target.fields, field.key);
    if (stored !== undefined) {
      if (isEmpty(stored)) {
        if (field.inherited) {
          notes.push(
            issue(
              ["fields", field.key],
              "empty_value",
              `${shown(field.label)} is stored empty on this record, so nothing is inherited for it.`,
            ),
          );
        }
        continue;
      }
      candidates.push({
        key: field.key,
        label: field.label,
        value: stored,
        from: 0,
        visibility: field.visibility,
        inTemplate: true,
      });
      continue;
    }
    if (!field.inherited) continue;
    const found = inherit(field, up, templates, notes);
    if (found !== undefined) candidates.push(found);
  }

  // Values for keys the template doesn't have: kept, staff only, never inherited.
  for (const key of Object.keys(target.fields)) {
    if (own.byKey.has(key)) continue;
    const stored = ownField(target.fields, key);
    if (stored === undefined || isEmpty(stored)) continue;
    candidates.push({
      key,
      label: key,
      value: stored,
      from: 0,
      visibility: "staff",
      inTemplate: false,
    });
  }

  const kept = dropUnfit(target, own.template, candidates, up, notes);

  const chainUp = up.map(step);
  const entries = kept.map((c) => {
    const from = chainUp[c.from];
    if (from === undefined) fail([], "unreadable", "The record could not be read.");
    return Object.freeze({
      key: c.key,
      label: c.label,
      value: c.value,
      own: c.from === 0,
      from,
      visibility: c.visibility,
      inTemplate: c.inTemplate,
    });
  });
  // Object.fromEntries defines own properties, so no key can reach a prototype.
  const fields = Object.freeze(Object.fromEntries(entries.map((e) => [e.key, e.value])));
  return Object.freeze({
    id: target.id,
    kind: target.kind,
    title: target.title,
    fields,
    entries: Object.freeze(entries),
    chain: Object.freeze([...chainUp].reverse()),
    notes: Object.freeze(notes.map((n) => Object.freeze(n))),
    record: target,
  });
}

/** The value the nearest ancestor gives for `field`, or undefined. */
function inherit(
  field: FieldDefinition,
  up: readonly CatalogRecord[],
  templates: readonly CheckedTemplate[],
  notes: Issue[],
): Candidate | undefined {
  let visibility = field.visibility;
  for (let i = 1; i < up.length; i += 1) {
    const record = up[i];
    const definition = templates[i]?.byKey.get(field.key);
    if (record === undefined) return undefined;
    // A unit whose template doesn't have the key is passed over.
    if (definition === undefined) continue;
    // A unit that has the key but doesn't pass it down stops the search.
    if (!definition.inherited) return undefined;
    visibility = strictest(visibility, definition.visibility);
    const stored = ownField(record.fields, field.key);
    if (stored === undefined) continue;
    if (isEmpty(stored)) return undefined;
    if (definition.kind !== field.kind || definition.repeatable !== field.repeatable) {
      notes.push(
        issue(
          ["fields", field.key],
          "incompatible_field",
          `${shown(field.label)} isn't inherited from ${shown(record.title)}: the field there is ${describe(definition)}, here it is ${describe(field)}.`,
        ),
      );
      return undefined;
    }
    return {
      key: field.key,
      label: field.label,
      value: stored,
      from: i,
      visibility,
      inTemplate: true,
    };
  }
  return undefined;
}

/**
 * Check the inherited values against the record's own template and leave out
 * any that don't fit (a list option it doesn't have, a lower length limit).
 * Own values are the record's business and aren't checked here. Required
 * fields are not checked either: that's for whoever checks the record.
 */
function dropUnfit(
  target: CatalogRecord,
  template: FieldTemplate,
  candidates: readonly Candidate[],
  up: readonly CatalogRecord[],
  notes: Issue[],
): readonly Candidate[] {
  const inherited = candidates.filter((c) => c.from !== 0);
  if (inherited.length === 0) return candidates;
  const loose: FieldTemplate = {
    ...template,
    fields: template.fields.map((f) => ({ ...f, required: false })),
  };
  const probe = {
    ...target,
    fields: Object.fromEntries(inherited.map((c) => [c.key, c.value])),
  } as CatalogRecord;
  const problems = checkRecordAgainstTemplate(probe, loose);
  const unfit = new Map<string, string>();
  let unsure = false;
  for (const problem of problems) {
    const [where, key] = problem.path;
    if (where === "fields" && typeof key === "string") {
      if (!unfit.has(key)) unfit.set(key, problem.message);
    } else {
      // A problem we can't place (the check stopped early, or couldn't run):
      // keep none of the inherited values, rather than guess.
      unsure = true;
    }
  }
  return candidates.filter((c) => {
    if (c.from === 0) return true;
    const why = unsure
      ? "it could not be checked against this record's template."
      : unfit.get(c.key);
    if (why === undefined) return true;
    notes.push(
      issue(
        ["fields", c.key],
        "not_valid_here",
        `${shown(c.label)} isn't inherited from ${shown(up[c.from]?.title)}: ${why}`,
      ),
    );
    return false;
  });
}

function step(record: CatalogRecord): ChainStep {
  return Object.freeze(
    record.kind === "archival_unit"
      ? { id: record.id, kind: record.kind, title: record.title, level: record.level }
      : { id: record.id, kind: record.kind, title: record.title },
  );
}

/** An own property of a record's fields, or undefined. Validated records hold only data properties. */
function ownField(
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
): FieldValue | undefined {
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

/** `null`, blank text or an empty list: stored, but saying "none". */
function isEmpty(value: FieldValue): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return Array.isArray(value) && value.length === 0;
}

function strictest(a: FieldVisibility, b: FieldVisibility): FieldVisibility {
  return a === "staff" || b === "staff" ? "staff" : "public";
}

function describe(field: FieldDefinition): string {
  return `${field.repeatable ? "a repeatable" : "a single"} ${field.kind.replace("_", " ")}`;
}
