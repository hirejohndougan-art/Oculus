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
 * **One organization per set** (D-019, D-030). A set holding records of
 * more than one organization (valid or not), or an entry that doesn't say
 * which, is refused whole (`mixed_organizations`),
 * so a record can never inherit from, or be published with, another
 * organization's units.
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
 *
 * **Identifier values** (D-022, D-041). Identifier types are staff only
 * unless marked public, and only the identifier checker in `options.checkers`
 * (from `makeIdentifierChecker`) knows which are public. Checkers judge an
 * inherited value by its effective visibility, so a staff-type number
 * inherited into a staff field stays. One inherited into a public field is
 * kept too, marked `staff` with an `inherited_staff_identifier` note, so the
 * staff copy the parent holds doesn't vanish on the child and the rest of a
 * list isn't lost with it; nothing of it is published, and publishing the
 * child is not refused, because the mistake is on the record that holds the
 * number. A public field whose own value is of a staff type, or any
 * identifier value when no identifier checker made by
 * `makeIdentifierChecker` is given, is kept but marked `staff`, with a note
 * (`private_identifier_type`, `identifier_types_unknown`), and
 * `effectivePublishIssues` refuses to publish the record until it is fixed.
 * The public view holds an identifier as `{ value }` only, never its type.
 *
 * **Numbers live in `RecordIdentifiers`** (D-038). An identifier field only
 * points at one of its record's current identifiers. `options.identifiers`
 * gives the identifiers of the record and its ancestors; a public identifier
 * value its source record (the record itself, or the ancestor it is
 * inherited from) doesn't hold as current is kept but marked `staff`
 * (`identifier_not_held`), and without `options.identifiers` every public
 * identifier value is (`identifiers_unknown`). Either note refuses publishing.
 *
 * **Links to other records** (T-015, D-039, D-045). The public view holds
 * no `record_link` value at all, not even its label: the record linked to
 * may be unpublished, held back by a deed or (by mistake) another
 * organization's, and a label copied from it (a donor's name, a private
 * item's title) would reveal it. A place is held as `{ label, uri? }`, never
 * with the ID of a place record, and only when it names no place record or
 * `options.checkers.place` (from `makeRecordLinkChecker`, for this
 * organization) holds the one it names as a place (D-048); otherwise it is
 * left out. Only `publicOutput` reads links, from the
 * effective record, and puts out a link (its URL and label) only when it can
 * prove the record is published, not held back and the organization's own;
 * otherwise nothing of it. The effective record (staff) keeps every link.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { RIGHTS_FIELD_KEY, rightsPublishIssues } from "./rights.js";
import { markEffective, markPublicView } from "./effective-brand.js";
import { deedHoldsOf } from "./accession-holds.js";
import { placeNameMayShow } from "./record-link-brand.js";
import { shown } from "./plain-data.js";
import { isOtherOrganizationsChecker, publicIdentifierTypesOf } from "./field-checkers.js";
import { types } from "node:util";
import { MAX_ARRANGEMENT_DEPTH, canFileUnder } from "./arrangement.js";
import { isRecordId, type RecordId } from "./record-id.js";
import { mixedOrganizationsIssue, organizationIdOf, type OrganizationId } from "./organizations.js";
import {
  holdsCurrentIdentifier,
  readIdentifierSets,
  type RecordIdentifiers,
} from "./identifiers.js";
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
  isTemplateRegistry,
  valueFitsField,
  templateOfRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldVisibility,
  type TemplateCheckOptions,
  type TemplateRegistry,
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
 * Public `record_link` entries are not in it at all (D-045), and a place
 * value whose place record isn't vouched for is left out (D-048): public
 * pages must take links to other records from `publicOutput`, which puts
 * out only those that may be named.
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
  /**
   * The identifiers (`RecordIdentifiers`) of the record and of the ancestors
   * it inherits from, all of its organization (D-038). A public identifier
   * value is published only when the record it comes from holds it as a
   * current identifier; without this option, none is. Sets for other
   * records of the organization may be included and are ignored. A record
   * with no set here holds no identifiers. The sets must already have
   * passed `validateRecordIdentifiers` and `uniquenessIssues` on the save
   * path; here only the rules one set can be checked for on its own are
   * checked again (exactly one primary, no current number twice:
   * `invalid_identifiers`). A held value of a type that isn't one of the
   * organization's public types is still refused by the identifier checker.
   */
  readonly identifiers?: readonly RecordIdentifiers[];
}

/** Options for `effectivePublishIssues`. */
export interface PublishCheckOptions {
  /**
   * The organization's accession register from `indexAccessions`, made at
   * publish time. Required to publish an object, archival unit or digital
   * asset (D-043): without it they are refused (`accessions_unknown`).
   */
  readonly accessions?: unknown;
}

/**
 * Gives the template a record uses. Called once per record on the way up,
 * with a frozen copy. Returning undefined or throwing fails the result. What
 * it returns is validated (copied) each time, so returning one object that
 * changes between calls can't make one record use another's definitions.
 * For a record with a `templateKey`, the template returned must have that
 * key (`template_mismatch`, D-029). Prefer a registry from `indexTemplates`,
 * which finds each record's template by its `templateKey`; a function is
 * the only way to work out records stored without one.
 */
export type TemplateLookup = (record: CatalogRecord) => FieldTemplate | undefined;

/** Where each record's template comes from: a registry (preferred) or a lookup function. */
export type TemplateSource = TemplateRegistry | TemplateLookup;

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
 * remembered, and using one fails. Entries of more than one organization
 * (valid or not, whenever their organizationId can be read) fail the whole
 * index (`mixed_organizations`). Never throws.
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
  let organization: OrganizationId | undefined;
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
    // Every organization is kept completely separate (D-019): a set holding
    // records of two organizations is refused whole, never filtered, so a
    // query that forgot its organization filter fails instead of reading
    // across (D-030). Every entry counts, valid or not, whenever its
    // organizationId can be read. An entry whose organizationId is missing,
    // not an organization ID or behind a getter could be any organization's,
    // so it refuses the set too, rather than sitting in it as "invalid".
    const owner = checked.ok ? checked.value.organizationId : organizationIdOf(record);
    organization ??= owner;
    if (owner === undefined || owner !== organization) {
      const mixed = mixedOrganizationsIssue([i], "The records in the set");
      fail(mixed.path, mixed.code, mixed.message);
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
 * from one set, index it once. `templateFor` gives each record's template:
 * a registry from `indexTemplates` (each record's template is the one its
 * `templateKey` names) or a lookup function (whose answer must have the
 * record's `templateKey`, when it has one). Fails, with one issue, when the
 * record or any ancestor can't be found, read or trusted. Never throws.
 */
export function effectiveRecord(
  recordId: RecordId,
  records: RecordLookup | readonly CatalogRecord[],
  templateFor: TemplateSource,
  options: EffectiveOptions = {},
): Validated<EffectiveRecord> {
  try {
    if (!isRecordId(recordId)) fail([], "invalid_id", "The record ID must be a record ID.");
    if (!isTemplateSource(templateFor)) {
      fail(
        [],
        "no_template_lookup",
        "templateFor must be a registry from indexTemplates or a function.",
      );
    }
    const state = lookupFor(records);
    const up = ancestry(recordId, state);
    const templates = templatesFor(up, templateFor);
    const checkers = ownSetting(options, "checkers");
    const identifiers = identifierSets(ownSetting(options, "identifiers"), up);
    const effective = compose(up, templates, checkers, identifiers);
    REPRESENTED.set(effective, representedIn(up[0], state));
    return { ok: true, value: effective };
  } catch (error) {
    return failure(error);
  }
}

/**
 * For a digital asset, the record it represents and that record's ancestors
 * (and so on, when what it represents is itself a digital asset that
 * represents something), as the records set held them when the effective
 * record was made; `null` when any of them couldn't be found or trusted.
 * Absent for anything that represents nothing. Read by the deed check.
 */
const REPRESENTED = new WeakMap<object, readonly RecordId[] | null>();

const MAX_REPRESENTS_HOPS = 8;

/** The represented records' IDs, with their ancestries, or null when not all can be found. */
function representedIn(
  record: CatalogRecord | undefined,
  state: LookupState,
): readonly RecordId[] | null {
  const ids: RecordId[] = [];
  const seen = new Set<RecordId>();
  let at = record;
  for (let hop = 0; hop <= MAX_REPRESENTS_HOPS; hop += 1) {
    if (at?.kind !== "digital_asset" || at.represents === undefined) {
      return Object.freeze(ids);
    }
    if (seen.has(at.represents)) return Object.freeze(ids);
    seen.add(at.represents);
    let up: readonly CatalogRecord[];
    try {
      up = ancestry(at.represents, state);
    } catch {
      return null;
    }
    for (const r of up) ids.push(r.id);
    at = up[0];
  }
  return null;
}

/**
 * For `public-output.ts` only: what `record` represents, with ancestries, in
 * `records` (a list or a lookup from `indexRecords`) as they are now, or null
 * when any of it can't be found or trusted. Never throws.
 */
export function currentRepresented(
  record: CatalogRecord,
  records: unknown,
): readonly RecordId[] | null {
  try {
    return representedIn(record, lookupFor(records));
  } catch {
    return null;
  }
}

/**
 * For `public-output.ts` only (not exported from the package): `records` as
 * one index, so every later check reads the same snapshot: a lookup from
 * `indexRecords` as it is, or a list indexed (and validated) once now. Fails
 * with the issue `indexRecords` gives. Never throws.
 */
export function recordIndex(records: unknown): Validated<RecordLookup> {
  if (typeof records === "object" && records !== null && LOOKUPS.has(records)) {
    return { ok: true, value: records as RecordLookup };
  }
  return indexRecords(records);
}

/**
 * For `public-output.ts` only (not exported from the package): the record and
 * its ancestors as they are in `records` now, the record first, found exactly
 * as `effectiveRecord` finds them (a list or a lookup from `indexRecords`).
 * Fails, with the issue `effectiveRecord` would give, when the record or any
 * ancestor can't be found, read or trusted. Never throws.
 */
export function currentAncestry(
  recordId: RecordId,
  records: unknown,
): Validated<readonly CatalogRecord[]> {
  try {
    if (!isRecordId(recordId)) fail([], "invalid_id", "The record ID must be a record ID.");
    return { ok: true, value: Object.freeze(ancestry(recordId, lookupFor(records))) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * For `record-links.ts` only (not exported from the package): every record in
 * `records` (a list or a lookup from `indexRecords`) by ID, as the validated,
 * frozen copy the index holds, or undefined for an ID used twice or a record
 * that isn't valid. A set mixing organizations, or one that can't be read, is
 * refused with the issue `indexRecords` gives. Never throws.
 */
export function recordsById(
  records: unknown,
): Validated<ReadonlyMap<RecordId, CatalogRecord | undefined>> {
  try {
    const state = lookupFor(records);
    const out = new Map<RecordId, CatalogRecord | undefined>();
    for (const [id, got] of state.byId) out.set(id, got.ok ? got.record : undefined);
    return { ok: true, value: out };
  } catch (error) {
    return failure(error);
  }
}

/** The index for `records`: the one `indexRecords` made, or a new one built from a list. */
function lookupFor(records: unknown): LookupState {
  // Callers may pass anything at run time, whatever the type says.
  const state = typeof records === "object" && records !== null ? LOOKUPS.get(records) : undefined;
  return state ?? stateOf(buildLookup(records));
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

/** True for a registry from `indexTemplates` or a function (not a Proxy). */
export function isTemplateSource(value: unknown): value is TemplateSource {
  if (isTemplateRegistry(value)) return true;
  return typeof value === "function" && !types.isProxy(value);
}

/**
 * For this module and `public-output.ts` only (not exported from the
 * package): the validated template `record` follows, from a registry or a
 * lookup function, refusing one whose key isn't the record's `templateKey`.
 * Issues name the record by ID; messages may quote its title (staff side).
 * A lookup function's answer is validated (copied) on every call, even when
 * the same object comes back twice: the lookup may have changed it in between.
 */
export function templateFromSource(
  record: CatalogRecord,
  source: TemplateSource,
): Validated<FieldTemplate> {
  let given: unknown = source;
  if (!isTemplateRegistry(source)) {
    try {
      given = source(record);
    } catch {
      return failed(
        [record.id],
        "template_lookup_failed",
        `Finding the template for ${shown(record.title)} failed.`,
      );
    }
    if (given === undefined) {
      return failed([record.id], "no_template", `${shown(record.title)} has no template.`);
    }
  }
  const result = templateOfRecord(record, given);
  if (result.ok) return result;
  const problem = result.issues[0];
  if (problem?.code === "invalid_template") {
    return failed(
      [record.id],
      "invalid_template",
      `The template for ${shown(record.title)} is not valid. Check it with validateTemplate.`,
    );
  }
  return failed(
    [record.id, ...(problem?.path ?? [])],
    problem?.code ?? "unreadable",
    problem?.message ?? "The record's template could not be found.",
  );
}

function failed(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return Object.freeze({
    ok: false,
    issues: Object.freeze([Object.freeze(issue(path, code, message))]),
  });
}

/** Each record's validated template, in the same order as `up`. */
function templatesFor(
  up: readonly CatalogRecord[],
  templateFor: TemplateSource,
): readonly CheckedTemplate[] {
  return up.map((record) => {
    const result = templateFromSource(record, templateFor);
    if (!result.ok) {
      const problem = result.issues[0];
      fail(
        problem?.path ?? [record.id],
        problem?.code ?? "unreadable",
        problem?.message ?? "The record's template could not be found.",
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

/**
 * The caller's identifier sets, read once (D-038), or undefined when none
 * were given. Sets of another organization than the records', or a set
 * given twice for one record, fail the whole result: a set that might not
 * be the record's can't vouch for its numbers.
 */
function identifierSets(
  given: unknown,
  up: readonly CatalogRecord[],
): ReadonlyMap<RecordId, RecordIdentifiers> | undefined {
  if (given === undefined) return undefined;
  const read = readIdentifierSets(given);
  if (!read.ok) {
    const problem = read.issues[0];
    if (problem?.code === "mixed_organizations") {
      const mixed = mixedOrganizationsIssue(["identifiers"], "These records and identifiers");
      fail(mixed.path, mixed.code, mixed.message);
    }
    if (problem?.code === "duplicate_identifiers") {
      fail(["identifiers"], problem.code, problem.message);
    }
    fail(
      ["identifiers"],
      "invalid_identifiers",
      "The identifiers option must be a list of records' identifiers. Check each with validateRecordIdentifiers.",
    );
  }
  const owner = up[0]?.organizationId;
  for (const set of read.value.values()) {
    if (set.organizationId !== owner) {
      const mixed = mixedOrganizationsIssue(["identifiers"], "These records and identifiers");
      fail(mixed.path, mixed.code, mixed.message);
    }
  }
  return read.value;
}

function compose(
  up: readonly CatalogRecord[],
  templates: readonly CheckedTemplate[],
  checkers: unknown,
  identifiers: ReadonlyMap<RecordId, RecordIdentifiers> | undefined,
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

  const fitting = dropUnfit(target, own.template, candidates, up, notes, checkers);
  const shaped = withholdMisfits(fitting, own.byKey, notes);
  const typed = withholdIdentifiers(shaped, own.byKey, notes, checkers, target.organizationId);
  const kept = withholdUnheld(typed, own.byKey, notes, up, identifiers);

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
  const publicEntries = entries.filter((e) => e.visibility === "public" && e.inTemplate);
  // A record link may point at a record that isn't published, is held back
  // or isn't this organization's, which the view can't know: so it holds no
  // record link at all, not even the label (D-045). `publicOutput` adds the
  // links it can prove may be named, from the effective record.
  const isLink = (e: { readonly key: string }): boolean =>
    own.byKey.get(e.key)?.kind === "record_link";
  // A place value naming a place record shows its name only when the
  // organization's own place checker holds that record as a place (D-048).
  const placeChecker = ownChecker(checkers, "place");
  const shownPlaces = (value: FieldValue): FieldValue | undefined => {
    const shows = (item: FieldValue): boolean =>
      placeNameMayShow(item, placeChecker, target.organizationId, target.id);
    if (!Array.isArray(value)) return shows(value) ? value : undefined;
    const kept = value.filter(shows);
    return kept.length === 0 ? undefined : Object.freeze(kept);
  };
  const shownEntries = publicEntries
    .filter((e) => !isLink(e))
    .flatMap((e) => {
      const kind = own.byKey.get(e.key)?.kind;
      const value = kind === "place" ? shownPlaces(e.value) : e.value;
      if (value === undefined) return [];
      return [
        Object.freeze({
          key: e.key,
          label: e.label,
          value: e.key === RIGHTS_FIELD_KEY ? withoutRightsNote(value) : publicValue(value, kind),
          own: e.own,
        }),
      ];
    });
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
    chain: Object.freeze(
      up.map((record, i) => {
        const used = templates[i];
        if (used === undefined) fail([], "unreadable", "The record could not be read.");
        return Object.freeze({ record, template: used.template });
      }),
    ),
    links: Object.freeze(publicEntries.filter(isLink).map((e) => e.key)),
    ...(target.kind === "archival_unit" ? { level: target.level } : {}),
  });
  return effective;
}

/**
 * A rights value without its `note`: rights notes are kept staff-side and
 * never published (D-016), so the public view doesn't hold them. Anything
 * that isn't a plain rights object is left as it is, for the publish check
 * to refuse.
 */
function withoutRightsNote(value: FieldValue): FieldValue {
  if (!isPlainObject(value) || !Object.hasOwn(value, "note")) return value;
  // Object.fromEntries defines own properties, so no key can reach a prototype.
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "note")));
}

/**
 * Notes that mean a public value was held back (an identifier, or a value
 * that doesn't fit its field): publishing must wait.
 */
const WITHHELD_IDENTIFIER: ReadonlySet<string> = new Set([
  "private_identifier_type",
  "identifier_types_unknown",
  "wrong_organization_checker",
  "identifiers_unknown",
  "identifier_not_held",
  "does_not_fit_field",
]);

/**
 * Mark `staff`, with a note that blocks publishing, every public value whose
 * structure doesn't fit its field as the template has it now: a value kept
 * from before a template edit (a record link, an identifier with its type,
 * a rights value with its note, left in a field since made text) must never
 * be copied into the public view as it is (D-039). Inherited values were
 * already checked by `dropUnfit`; this catches own values. The note never
 * quotes the value.
 */
function withholdMisfits(
  candidates: readonly Candidate[],
  byKey: ReadonlyMap<string, FieldDefinition>,
  notes: Issue[],
): readonly Candidate[] {
  return candidates.map((c) => {
    if (c.visibility !== "public" || !c.inTemplate) return c;
    const def = byKey.get(c.key);
    if (def !== undefined && valueFitsField(c.value, def)) return c;
    notes.push(
      issue(
        ["fields", c.key],
        "does_not_fit_field",
        `${shown(c.label)} holds a value that doesn't fit the field as it is now, so it is kept staff only and the record can't be published. Correct the value, or check it with checkRecordAgainstTemplate.`,
      ),
    );
    return { ...c, visibility: "staff" };
  });
}

/**
 * Mark `staff`, with a note, every public identifier value the public may not
 * see: one whose type (or any of whose types, for a list) isn't public, or
 * any at all when the identifier checker can't say which types are public
 * (D-022). The value stays in the effective record for staff.
 */
function withholdIdentifiers(
  candidates: readonly Candidate[],
  byKey: ReadonlyMap<string, FieldDefinition>,
  notes: Issue[],
  checkers: unknown,
  organizationId: OrganizationId,
): readonly Candidate[] {
  const checker = ownChecker(checkers, "identifier");
  // Another organization's checker says nothing about this one's types (D-030).
  const otherOrganization = isOtherOrganizationsChecker(checker, organizationId);
  const publicTypes = publicIdentifierTypesOf(checker, organizationId);
  return candidates.map((c) => {
    if (c.visibility !== "public" || !c.inTemplate || byKey.get(c.key)?.kind !== "identifier") {
      return c;
    }
    if (otherOrganization) {
      notes.push(
        issue(
          ["fields", c.key],
          "wrong_organization_checker",
          `${shown(c.label)} is kept staff only: checkers.identifier was made from another organization's identifier types.`,
        ),
      );
      return { ...c, visibility: "staff" };
    }
    if (publicTypes === undefined) {
      notes.push(
        issue(
          ["fields", c.key],
          "identifier_types_unknown",
          `${shown(c.label)} is kept staff only: without checkers.identifier from makeIdentifierChecker, there is no telling whether its identifier type is public.`,
        ),
      );
      return { ...c, visibility: "staff" };
    }
    const items = Array.isArray(c.value) ? c.value : [c.value];
    const allPublic = items.every((item) => {
      if (!isPlainObject(item) || !Object.hasOwn(item, "type")) return false;
      const type = item.type;
      return typeof type === "string" && publicTypes.has(type);
    });
    if (allPublic) return c;
    notes.push(
      issue(
        ["fields", c.key],
        "private_identifier_type",
        `${shown(c.label)} holds a number of a staff only identifier type, so it is kept staff only and the record can't be published. Mark the type public, or move the number to a staff field.`,
      ),
    );
    return { ...c, visibility: "staff" };
  });
}

/**
 * Mark `staff`, with a note, every public identifier value that isn't one of
 * the current identifiers of the record it comes from: the record itself for
 * its own value, the ancestor for an inherited one (D-038). With no
 * identifier sets given, every public identifier value. The value stays in
 * the effective record for staff.
 */
function withholdUnheld(
  candidates: readonly Candidate[],
  byKey: ReadonlyMap<string, FieldDefinition>,
  notes: Issue[],
  up: readonly CatalogRecord[],
  identifiers: ReadonlyMap<RecordId, RecordIdentifiers> | undefined,
): readonly Candidate[] {
  return candidates.map((c) => {
    if (c.visibility !== "public" || !c.inTemplate || byKey.get(c.key)?.kind !== "identifier") {
      return c;
    }
    if (identifiers === undefined) {
      notes.push(
        issue(
          ["fields", c.key],
          "identifiers_unknown",
          `${shown(c.label)} is kept staff only: without the identifiers option there is no telling whether the record holds this number.`,
        ),
      );
      return { ...c, visibility: "staff" };
    }
    const source = up[c.from];
    const set = source === undefined ? undefined : identifiers.get(source.id);
    const items: readonly FieldValue[] = Array.isArray(c.value) ? c.value : [c.value];
    if (items.length > 0 && items.every((item) => holdsCurrentIdentifier(set, item))) return c;
    notes.push(
      issue(
        ["fields", c.key],
        "identifier_not_held",
        `${shown(c.label)} is kept staff only: it shows a number that isn't one of ${c.from === 0 ? "this record's" : "its source record's"} current identifiers, so the record can't be published. Add the number to the record's identifiers, or choose one it has.`,
      ),
    );
    return { ...c, visibility: "staff" };
  });
}

/** A checker given as an own data property of `checkers`, or undefined. */
function ownChecker(checkers: unknown, kind: string): unknown {
  if (!isPlainObject(checkers)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(checkers, kind);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * A public entry's value as the public view holds it: identifiers without
 * their type, and links to records without the ID linked to (D-039).
 */
function publicValue(value: FieldValue, kind: FieldDefinition["kind"] | undefined): FieldValue {
  if (kind === "identifier") return withoutIdentifierType(value);
  // Every kind: a public view never holds a linked record ID (D-039), even
  // if a value of another shape ever got this far.
  return withoutRecordId(value);
}

/**
 * A place value (or anything else) without its `recordId`: whether the record
 * linked to may be named is for `publicOutput` to decide (D-016, D-039).
 * `record_link` values never get here: the view leaves them out (D-045).
 * Anything that isn't a plain object is left as it is, for the publish check
 * to refuse.
 */
function withoutRecordId(value: FieldValue): FieldValue {
  const strip = (item: FieldValue): FieldValue =>
    isPlainObject(item) && Object.hasOwn(item, "recordId")
      ? // Object.fromEntries defines own properties, so no key can reach a prototype.
        Object.freeze(Object.fromEntries(Object.entries(item).filter(([k]) => k !== "recordId")))
      : item;
  return Array.isArray(value) ? Object.freeze(value.map(strip)) : strip(value);
}

/**
 * An identifier value as `{ value }` only: identifier types are never
 * published (D-016), so the public view doesn't hold them. Only values whose
 * every item is a plain object with a public type get here.
 */
function withoutIdentifierType(value: FieldValue): FieldValue {
  const strip = (item: FieldValue): FieldValue =>
    isPlainObject(item) && Object.hasOwn(item, "value")
      ? Object.freeze({ value: item.value as FieldValue })
      : Object.freeze({});
  return Array.isArray(value) ? Object.freeze(value.map(strip)) : strip(value);
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
 * check also stands in case a staff rights field is ever allowed.
 *
 * **The deed check** (T-016, D-043) runs last. For an object, archival unit
 * or digital asset, `options.accessions` must be the organization's register
 * from `indexAccessions`, made at publish time: without it the record is
 * refused (`accessions_unknown`), with anything else (`invalid_accessions`)
 * or another organization's register (`mixed_organizations`) too. A record
 * the register holds back, or whose ancestor or represented record it holds
 * back, is refused (`deed_not_signed`); the message names no donor,
 * accession or number. The record, its current ancestry and, for a
 * digital asset, the record it represents with that record's ancestry (from
 * the records `effectiveRecord` was given; `represented_record_unknown` when
 * they aren't there) must all be records the register knows
 * (`accessions_out_of_date`). The check is only as fresh as the register:
 * make it at publish time, as T-034 will. Returns an empty list when the record can be
 * published. Never throws.
 */
export function effectivePublishIssues(
  effective: EffectiveRecord,
  options?: PublishCheckOptions,
): readonly Issue[] {
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
    const withheld = effective.notes.filter((n) => WITHHELD_IDENTIFIER.has(n.code));
    if (withheld.length > 0) {
      return Object.freeze(withheld.map((n) => Object.freeze(issue(n.path, n.code, n.message))));
    }
    const found = rightsPublishIssues(view);
    // Last, so every other reason is reported first; any reason blocks.
    if (found.length === 0) return deedIssues(effective, options);
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

function representsSomething(record: CatalogRecord): boolean {
  return record.kind === "digital_asset" && record.represents !== undefined;
}

/**
 * For `public-output.ts` only: the deed check again, with what a digital
 * asset represents found in the records as they are now
 * (`currentRepresented`). Never throws.
 */
export function deedIssuesNow(
  effective: EffectiveRecord,
  accessions: unknown,
  represented: readonly RecordId[] | null,
): readonly Issue[] {
  try {
    return deedIssues(effective, accessions === undefined ? {} : { accessions }, represented);
  } catch {
    return Object.freeze([
      Object.freeze(issue([], "unreadable", "The effective record could not be read.")),
    ]);
  }
}

/**
 * For `public-output.ts` only: the deed check for link targets (D-043). The
 * function it returns says whether a link to `id` (whose kind, as the link
 * checker saw it, is `kind`) may go out live as far as deeds go. A target of
 * an accessioned kind, as the checker or the records now have it, may be
 * linked only when the target, found in `records` (the records as they are
 * now; `publicOutput` passes the one lookup from `indexRecords` it uses for
 * every check), its current ancestry and, for a digital asset, what
 * it represents with that record's ancestry (found exactly as the record's
 * own check finds them, with the same loop and hop rules) are all known to
 * `accessions` (a register of `organizationId`) and none is held back.
 * Anything that can't be found, read or trusted answers false. Never throws.
 */
export function linkDeedCheck(
  accessions: unknown,
  records: unknown,
  organizationId: OrganizationId,
): (id: RecordId, kind: string) => boolean {
  const holds = deedHoldsOf(accessions);
  let state: LookupState | undefined;
  try {
    state = records === undefined ? undefined : lookupFor(records);
  } catch {
    state = undefined;
  }
  return (id, kind) => {
    try {
      const got = state === undefined ? undefined : fetchRecord(state, id);
      const now = got?.ok === true ? got.record : undefined;
      // Not of an accessioned kind, by the checker or by the records now.
      if (!ACCESSIONED.has(kind) && (now === undefined || !ACCESSIONED.has(now.kind))) {
        return true;
      }
      if (holds?.organizationId !== organizationId) return false;
      if (state === undefined || now === undefined) return false;
      if (now.organizationId !== organizationId) return false;
      const up = ancestry(id, state);
      const shows = representedIn(up[0], state);
      if (shows === null) return false;
      const ids = [...up.map((r) => r.id), ...shows];
      return ids.every((at) => holds.isKnown(at) && !holds.isHeld(at));
    } catch {
      return false;
    }
  };
}

/** The kinds an accession can produce, so the only ones the deed check applies to. */
const ACCESSIONED: ReadonlySet<string> = new Set(["object", "archival_unit", "digital_asset"]);

/**
 * The deed check (D-043): fails closed. Reads only the register's
 * organization and held record IDs (`accession-holds.ts`), never an
 * accession. Throws only on unreadable options, which the caller turns
 * into `unreadable`.
 */
function deedIssues(
  effective: EffectiveRecord,
  options: unknown,
  represented?: readonly RecordId[] | null,
): readonly Issue[] {
  const refuse = (code: string, message: string): readonly Issue[] =>
    Object.freeze([Object.freeze(issue(["accessions"], code, message))]);
  let given: unknown;
  try {
    given = ownSetting(options, "accessions");
  } catch {
    return refuse("invalid_options", "The options must be a plain object { accessions }.");
  }
  const record = effective.record;
  const needed = ACCESSIONED.has(record.kind);
  if (given === undefined) {
    return needed
      ? refuse(
          "accessions_unknown",
          "Publishing this record needs the organization's accession register (indexAccessions), to check its deed of gift is signed.",
        )
      : Object.freeze([]);
  }
  const holds = deedHoldsOf(given);
  if (holds === undefined) {
    return refuse(
      "invalid_accessions",
      "The accessions option must be the register made by indexAccessions.",
    );
  }
  if (holds.organizationId !== record.organizationId) {
    return Object.freeze([
      Object.freeze(mixedOrganizationsIssue(["accessions"], "This record and these accessions")),
    ]);
  }
  if (!needed) return Object.freeze([]);
  const ids: RecordId[] = effective.chain.map((step) => step.id);
  // What a digital asset shows: the represented record's ancestors aren't in
  // this record's chain, so they are found from the records too.
  const shows = represented === undefined ? REPRESENTED.get(effective) : represented;
  if (shows === null || (shows === undefined && representsSomething(record))) {
    return refuse(
      "represented_record_unknown",
      "This digital asset represents a record that isn't in the records given (or one of its parents isn't), so its deed of gift can't be checked.",
    );
  }
  ids.push(...(shows ?? []));
  // A register that doesn't know a record can't say a deed doesn't hold it.
  if (!ids.every((id) => holds.isKnown(id))) {
    return refuse(
      "accessions_out_of_date",
      "The accession register doesn't know this record, a record above it or the record it shows. Make the register again from the organization's records as they are now.",
    );
  }
  if (ids.some((id) => holds.isHeld(id))) {
    return refuse(
      "deed_not_signed",
      "This record came from an accession whose deed of gift isn't signed yet, so it is held back from the public site. Mark the deed as signed in Deeds once the signed copy is on file.",
    );
  }
  return Object.freeze([]);
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
  // Checkers judge each inherited value by its effective visibility, not the
  // receiving field's: a value staff along the way is checked as staff, so a
  // staff-type identifier inherited into a public field isn't refused for
  // going public when it never will (D-022). Rights fields must be public in
  // every template, so they are never made staff here.
  const staffHere = new Set(inherited.filter((c) => c.visibility === "staff").map((c) => c.key));
  // Frozen, so a checker can't change a value after it was checked (or
  // before another checker sees it). The values themselves are already
  // frozen copies from validateRecord.
  const probeFields: Readonly<Record<string, FieldValue>> = Object.freeze(
    Object.fromEntries(inherited.map((c) => [c.key, c.value])),
  );
  const probe = Object.freeze({ ...target, fields: probeFields }) as CatalogRecord;
  const check = (): { unfit: Map<string, Issue[]>; unsure: boolean } => {
    const loose: FieldTemplate = {
      ...template,
      fields: template.fields.map((f) =>
        staffHere.has(f.key) && f.kind !== "rights"
          ? { ...f, required: false, visibility: "staff" as const }
          : { ...f, required: false },
      ),
    };
    const problems = checkRecordAgainstTemplate(
      probe,
      loose,
      (checkers === undefined ? {} : { checkers }) as TemplateCheckOptions,
    );
    const unfit = new Map<string, Issue[]>();
    let unsure = false;
    for (const problem of problems) {
      const [where, key] = problem.path;
      if (where === "fields" && typeof key === "string") {
        const list = unfit.get(key);
        if (list === undefined) unfit.set(key, [problem]);
        else list.push(problem);
      } else {
        // A problem we can't place (the check stopped early, or couldn't run):
        // keep none of the inherited values, rather than guess.
        unsure = true;
      }
    }
    return { unfit, unsure };
  };
  const first = check();
  // An identifier value inherited as public whose only problem is a number
  // of a staff only type (a mistake on the unit it came from, which can't be
  // published until it is fixed) is kept for staff (D-041): it is checked
  // again as staff, so every number's format is still checked, and if that
  // passes it is kept, marked staff, so neither the staff-type number nor
  // the rest of the list reaches the public view.
  const madeStaff = new Set<string>();
  if (!first.unsure) {
    for (const c of inherited) {
      const found = first.unfit.get(c.key);
      if (
        c.visibility === "public" &&
        template.fields.some((f) => f.key === c.key && f.kind === "identifier") &&
        found?.every((p) => p.code === "private_identifier_type") === true
      ) {
        madeStaff.add(c.key);
        staffHere.add(c.key);
      }
    }
  }
  // Only the keys made staff are judged by the second check; every other key
  // keeps the first check's answer, so loosening one field can't drop a
  // value that already passed.
  const asStaff = madeStaff.size > 0 ? check() : undefined;
  const kept: Candidate[] = [];
  for (const c of candidates) {
    if (c.from === 0) {
      kept.push(c);
      continue;
    }
    const result = madeStaff.has(c.key) && asStaff !== undefined ? asStaff : first;
    const problem = result.unsure ? undefined : result.unfit.get(c.key)?.[0];
    // A key made staff holds a staff-type number: never quote the checker's
    // message (it can name the number) in another record's notes.
    const why = result.unsure
      ? "it could not be checked against this record's template."
      : problem === undefined
        ? undefined
        : madeStaff.has(c.key)
          ? "it holds a number of a staff only identifier type that doesn't pass this record's checks."
          : problem.message;
    const checked = ownField(probeFields, c.key);
    if (why === undefined && checked === c.value) {
      // Keep exactly the value that was checked.
      if (madeStaff.has(c.key)) {
        notes.push(
          issue(
            ["fields", c.key],
            "inherited_staff_identifier",
            `${shown(c.label)} is inherited from ${shown(up[c.from]?.title)} with a number of a staff only identifier type, so here it is staff only and isn't published.`,
          ),
        );
        kept.push({ ...c, value: checked, visibility: "staff" });
      } else {
        kept.push({ ...c, value: checked });
      }
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
