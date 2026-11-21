/**
 * The effective record (decision D-013).
 *
 * An archival unit takes the values of its `inherited` fields from the units
 * above it (fonds › series › collection › file › item, D-007), unless it has
 * its own value. Rights or a creator set once on a fonds then apply to every
 * item below it. `effectiveRecord` works out what a record looks like after
 * inheriting: each field's value, the record it came from (or the record's
 * own value), and the visibility that applies to it. This is what the
 * Effective Record screen shows and what publishing (T-010) starts from.
 * Publishing checks rights with `effectivePublishIssues` and publishes only
 * `publicView`; `rightsPublishIssues` refuses an effective record outright
 * (`use_effective_publish_issues`), because it can't see the visibility rule.
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
 * - The value is only inherited when every definition of the key on the way
 *   (the source's, the receiver's and any unit's in between) has the same
 *   kind and the same `repeatable`, and it passes the record's own template
 *   check (list options, lengths, allowed codes) and the caller's checkers.
 *   Otherwise the field is left out and a note says why. There is no second
 *   try further up.
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
 * Every record is checked with `validateRecord` when the set is indexed, so
 * an index is one consistent, frozen snapshot of the set, never the caller's
 * objects. Later edits to those objects are not seen: build a new index after
 * any edit. Templates are validated afresh for every record on every call.
 *
 * **Public output must only ever come from `publicView`.** The effective
 * record itself holds staff-only values (in `fields`, `entries`, `record`)
 * and `notes`, which can quote values and staff labels. `publicView` keeps
 * only the entries whose effective visibility is `public` and whose key is in
 * the record's template. `effectivePublishIssues` is the rights publish
 * check (`rightsPublishIssues`) run on that public view, and also refuses
 * rights that are staff-only here. Nothing here throws.
 */
import { issue, type Issue, type Validated } from "./issues.js";
import { RIGHTS_FIELD_KEY, rightsPublishIssues } from "./rights.js";
import { markEffective, markPublicView } from "./effective-brand.js";
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
  type TemplateCheckOptions,
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
  /** The effective values, keyed by field key. Includes staff values: never publish; use `publicView`. */
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** The same values in template order (left-over fields last), with their source and visibility. */
  readonly entries: readonly EffectiveField[];
  /** From the top of the tree down; the last step is the record itself. */
  readonly chain: readonly ChainStep[];
  /** Inherited values that were left out, and why. Staff only: may quote values and labels. */
  readonly notes: readonly Issue[];
  /** The record as stored (a validated, frozen copy). Staff only. */
  readonly record: CatalogRecord;
}

/** One field as the public may see it. */
export interface PublicField {
  readonly key: string;
  readonly label: string;
  readonly value: FieldValue;
  /** True when the value is the record's own; false when inherited. */
  readonly own: boolean;
}

/**
 * The only part of an effective record that may be published: the entries
 * whose effective visibility is `public` and whose key is in the record's
 * template. No notes, no stored record, and no ancestors' IDs or titles.
 */
export interface PublicRecord {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly title: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly entries: readonly PublicField[];
}

export interface EffectiveOptions {
  /**
   * The same plug-in checks `checkRecordAgainstTemplate` takes. Inherited
   * values go through them against the receiving record's template, and a
   * value they refuse is left out. The record a checker is given is the
   * receiving record (frozen) holding only its inherited values, which may
   * be staff only: checkers see staff data and must not publish or log it.
   */
  readonly checkers?: TemplateCheckOptions["checkers"];
}

/**
 * Gives the template a record uses. Called once per record on the way up,
 * with a frozen copy. Returning undefined or throwing fails the result. What
 * it returns is validated (copied) each time, so returning one object that
 * changes between calls can't make one record use another's definitions.
 */
export type TemplateLookup = (record: CatalogRecord) => FieldTemplate | undefined;

/** A frozen snapshot of a set of records, indexed by ID, from `indexRecords`. Opaque. */
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
  /** Validated, frozen copies, by ID, or why the ID can't be used. Never changed after indexing. */
  readonly byId: ReadonlyMap<RecordId, Fetched>;
}

/** Lookups made by `indexRecords`; anything else passed as one is refused. */
const LOOKUPS = new WeakMap<object, LookupState>();

/**
 * Index a set of records by ID, once, for many `effectiveRecord` calls.
 * Every record is validated now, so the index is one consistent snapshot:
 * later changes to the caller's objects are not seen, and an index must be
 * built again after any edit. A record that fails validation is remembered
 * as invalid under the ID it carries. An entry with no ID that can be read
 * as plain data (a hole, a getter, a Proxy, not a record) fails the whole
 * index, since it could hide a duplicate. IDs used more than once are
 * remembered, and using one fails. Never throws.
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
  const byId = new Map<RecordId, Fetched>();
  for (let i = 0; i < length; i += 1) {
    // Read each slot as a plain data property, so a getter can't run.
    const slot = Object.getOwnPropertyDescriptor(records, i);
    const record: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
    const checked = validateRecord(record);
    const id = checked.ok ? checked.value.id : idOf(record);
    // An entry whose ID can't be read plainly could be hiding a duplicate,
    // so the whole set is refused rather than the entry skipped.
    if (id === undefined) {
      fail(
        [i],
        "unreadable_entry",
        `Entry ${String(i)} in the set has no ID that can be read as plain data.`,
      );
    }
    byId.set(
      id,
      byId.has(id)
        ? DUPLICATE
        : checked.ok
          ? Object.freeze({ ok: true, record: checked.value })
          : INVALID,
    );
  }
  const lookup: RecordLookup = Object.freeze({ size: byId.size });
  LOOKUPS.set(lookup, { byId });
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

const DUPLICATE: Fetched = Object.freeze({ ok: false, why: "duplicate" });
const INVALID: Fetched = Object.freeze({ ok: false, why: "invalid" });
const MISSING: Fetched = Object.freeze({ ok: false, why: "missing" });

function fetchRecord(state: LookupState, id: RecordId): Fetched {
  return state.byId.get(id) ?? MISSING;
}

// ---------------------------------------------------------------------------

/**
 * The effective record for `recordId`: its own values plus what it inherits
 * from the units above it, each with its source and effective visibility
 * (see the module header for the rules). `records` is the set to find the
 * record and its parents in, either a list or a lookup from `indexRecords`.
 * Passing a list validates the whole list on every call; for many records
 * from one set, index it once. `templateFor` gives each record's template.
 * Fails, with one issue, when the record or any ancestor can't be found,
 * read or trusted. Never throws.
 */
export function effectiveRecord(
  recordId: RecordId,
  records: RecordLookup | readonly CatalogRecord[],
  templateFor: TemplateLookup,
  options: EffectiveOptions = {},
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
    const checkers = ownSetting(options, "checkers");
    return { ok: true, value: compose(up, templates, checkers) };
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
          `${article(child.level)} can't be filed under ${article(record.level).toLowerCase()} (${shown(child.title)} under ${shown(record.title)}).`,
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
  // Validated (copied) for every record, even when the same object comes back
  // twice: the lookup may have changed it in between.
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
    const checked: CheckedTemplate = { template: result.value, byKey };
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
  checkers: unknown,
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

  const kept = dropUnfit(target, own.template, candidates, up, notes, checkers);

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
  const effective: EffectiveRecord = Object.freeze({
    id: target.id,
    kind: target.kind,
    title: target.title,
    fields,
    entries: Object.freeze(entries),
    chain: Object.freeze([...chainUp].reverse()),
    notes: Object.freeze(notes.map((n) => Object.freeze(n))),
    record: target,
  });
  const shownEntries = entries
    .filter((e) => e.visibility === "public" && e.inTemplate)
    .map((e) => Object.freeze({ key: e.key, label: e.label, value: e.value, own: e.own }));
  markEffective(effective);
  const view: PublicRecord = Object.freeze({
    id: target.id,
    kind: target.kind,
    title: target.title,
    fields: Object.freeze(Object.fromEntries(shownEntries.map((e) => [e.key, e.value]))),
    entries: Object.freeze(shownEntries),
  });
  PUBLIC_VIEWS.set(effective, view);
  // So public output (T-010) can recognise this view and find its checks.
  markPublicView(view, {
    effective,
    template: own.template,
    ...(target.kind === "archival_unit" ? { level: target.level } : {}),
  });
  return effective;
}

/** The public view of each effective record made here, made at the same time. */
const PUBLIC_VIEWS = new WeakMap<object, PublicRecord>();

/**
 * The only part of an effective record that may be published (see
 * `PublicRecord`). Undefined for anything `effectiveRecord` didn't return, so
 * a hand-made or altered object can't be passed off as checked. Never throws.
 */
export function publicView(effective: EffectiveRecord): PublicRecord | undefined {
  const given: unknown = effective;
  return typeof given === "object" && given !== null ? PUBLIC_VIEWS.get(given) : undefined;
}

/**
 * The rights publish check for an effective record: `rightsPublishIssues`
 * run on its public view, so rights that are inherited count, and rights
 * that aren't public here don't (`rights_not_public`). Templates require the
 * `rights` field to be public (T-007a), so today that happens only for a
 * left-over `rights` value whose key isn't in the record's template; the
 * check also stands in case a staff rights field is ever allowed. Returns an
 * empty list when the rights can be published. Never throws.
 */
export function effectivePublishIssues(effective: EffectiveRecord): readonly Issue[] {
  try {
    const view = publicView(effective);
    if (view === undefined) {
      return Object.freeze([
        Object.freeze(
          issue(
            [],
            "not_effective",
            "This is not an effective record from effectiveRecord, so it can't be checked.",
          ),
        ),
      ]);
    }
    const found = rightsPublishIssues(view);
    if (found.length === 0) return found;
    const hidden = effective.entries.some(
      (e) => e.key === RIGHTS_FIELD_KEY && (e.visibility !== "public" || !e.inTemplate),
    );
    if (!hidden) return found;
    return Object.freeze([
      Object.freeze(
        issue(
          ["fields", RIGHTS_FIELD_KEY],
          "rights_not_public",
          "The rights value is staff only for this record, so it can't be published. Make the rights field public in every template along the way, or give the record its own public rights.",
        ),
      ),
    ]);
  } catch {
    return Object.freeze([
      Object.freeze(issue([], "unreadable", "The effective record could not be read.")),
    ]);
  }
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
    if (stored !== undefined && isEmpty(stored)) return undefined;
    // Every unit on the way that has the key must agree on its shape, even
    // one in between with no value of its own.
    if (definition.kind !== field.kind || definition.repeatable !== field.repeatable) {
      notes.push(
        issue(
          ["fields", field.key],
          "incompatible_field",
          `${shown(field.label)} isn't inherited through ${shown(record.title)}: the field there is ${describe(definition)}, here it is ${describe(field)}.`,
        ),
      );
      return undefined;
    }
    if (stored === undefined) continue;
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
 * Check the inherited values against the record's own template, with the
 * caller's plug-in checkers, and leave out any that don't fit (a list option
 * it doesn't have, a lower length limit, a value a checker refuses).
 * Own values are the record's business and aren't checked here. Required
 * fields are not checked either: that's for whoever checks the record.
 */
function dropUnfit(
  target: CatalogRecord,
  template: FieldTemplate,
  candidates: readonly Candidate[],
  up: readonly CatalogRecord[],
  notes: Issue[],
  checkers: unknown,
): readonly Candidate[] {
  const inherited = candidates.filter((c) => c.from !== 0);
  if (inherited.length === 0) return candidates;
  const loose: FieldTemplate = {
    ...template,
    fields: template.fields.map((f) => ({ ...f, required: false })),
  };
  // Frozen, so a checker can't change a value after it was checked (or
  // before another checker sees it). The values themselves are already
  // frozen copies from validateRecord.
  const probeFields: Readonly<Record<string, FieldValue>> = Object.freeze(
    Object.fromEntries(inherited.map((c) => [c.key, c.value])),
  );
  const probe = Object.freeze({ ...target, fields: probeFields }) as CatalogRecord;
  const problems = checkRecordAgainstTemplate(
    probe,
    loose,
    (checkers === undefined ? {} : { checkers }) as TemplateCheckOptions,
  );
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
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (c.from === 0) {
      kept.push(c);
      continue;
    }
    const why = unsure
      ? "it could not be checked against this record's template."
      : unfit.get(c.key);
    const checked = ownField(probeFields, c.key);
    if (why === undefined && checked === c.value) {
      // Keep exactly the value that was checked.
      kept.push({ ...c, value: checked });
      continue;
    }
    notes.push(
      issue(
        ["fields", c.key],
        "not_valid_here",
        `${shown(c.label)} isn't inherited from ${shown(up[c.from]?.title)}: ${why ?? "it changed while being checked."}`,
      ),
    );
  }
  return kept;
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

function article(level: ArchivalLevel): string {
  return `${level === "item" ? "An" : "A"} ${level}`;
}

/**
 * An own data property of the caller's options, or undefined when it isn't
 * there. Options that can't be read plainly (a Proxy, a getter) fail the
 * result, so plug-in checks are never skipped without saying so.
 */
function ownSetting(options: unknown, key: string): unknown {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || types.isProxy(options)) {
    fail([], "invalid_options", "The options must be a plain object.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    fail([], "invalid_options", `The ${key} option can't be a getter.`);
  }
  const value: unknown = descriptor.value;
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    fail([], "invalid_options", `The ${key} option can't be a Proxy.`);
  }
  return value;
}
