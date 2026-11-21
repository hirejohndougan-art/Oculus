/**
 * Safe identifier type changes (roadmap T-005a, decision D-0XX).
 *
 * Editing or deleting one of the organization's identifier types (D-009) can
 * strand stored numbers, give a used number out again, or publish numbers
 * that were staff only (D-022). Before a type is saved,
 * `identifierTypeChanges(oldType, newType, existing?)` compares the two
 * versions, and before one is deleted, `identifierTypeDeletion(type,
 * existing?)` checks what uses it. Both list the changes that need a
 * person's confirmation:
 *
 * - `key_changed`: the key is renamed. Every stored value still names the
 *   old key: current ones stop passing the check (`unknown_type`), and
 *   former ones no longer count for the type's uniqueness or auto-numbering,
 *   so their numbers can be given out again under the new key. `recordIds`
 *   are the records holding any value of the type.
 * - `type_deleted`: the same, for a type being deleted.
 * - `made_public`: `public` goes from false (or left out) to true, which
 *   publishes values that were staff only. **Always needs confirmation**,
 *   like a field made public (D-023). `recordIds` are the records holding a
 *   value of the type.
 * - `format_changed`: the format is added or changed; `recordIds` are the
 *   records holding a current value (in their identifiers or in a template
 *   `identifier` field) that no longer fits. Former identifiers are history
 *   and never checked against a format (D-009).
 * - `uniqueness_tightened`: `none` → `current` or `all_time`, or `current` →
 *   `all_time`; `recordIds` are the records whose values (compared with
 *   `identifierKey`, former ones too under `all_time`) clash with another
 *   record's under the new rule.
 * - `auto_number_changed`: auto-numbering is added or changed. `recordIds`
 *   are the records holding a number the new numbering would give out again
 *   written differently (another separator, a prefix without its dash), so
 *   the uniqueness check, which compares exact keys, wouldn't catch it, or
 *   held only in a template field, which `nextIdentifier` doesn't count.
 *   Needs confirmation only when there are such records.
 * - `reserved_key`: a type stored with the key `constructor` or `prototype`
 *   (allowed before D-0XX) is edited without renaming it; needs
 *   confirmation, and renaming onto a reserved key is refused.
 * - `made_staff`: `public` goes from true to false. A staff type is refused
 *   in public template fields (D-022), so `recordIds` are the records holding
 *   a value of it in a field public for their kind in some template (any
 *   field when `templates` isn't given); needs confirmation when there are.
 * - `uniqueness_loosened`, auto-numbering removed: informational.
 *
 * `existing` holds what the type is used by: `identifierTypes` (the
 * organization's current list, which must contain `oldType` exactly),
 * `identifiers` (every record's identifiers) and `records` (the catalog
 * records, whose template `identifier` fields hold `{ type, value }`), and
 * optionally `templates`. Stored identifier sets are read leniently: a value
 * of a removed type or one that never fit its format is already stranded, and
 * is counted, not refused. An
 * empty list means "there are none": pass nothing when they are unknown.
 * Without it, `recordsChecked` is false and every change that could affect
 * records needs confirmation.
 *
 * Messages name the type key and give counts only: they never quote a
 * stored value. Everything is validated first (the types with
 * `validateIdentifierType` and `validateIdentifierTypes`, each identifier
 * set for shape and safety only, each template with `validateLegacyTemplate`, each record with `validateRecord`);
 * any doubt refuses the whole comparison with issues. The work is linear in
 * the identifiers and field values, each matched at most once against a
 * format, the same work as validating them. Never throws.
 */
import { issue, isPlainObject, type Validated } from "./issues.js";
import { shown, type JsonValue } from "./plain-data.js";
import { validateRecord, type CatalogRecord } from "./records.js";
import type { RecordId } from "./record-id.js";
import {
  MAX_AUTO_NUMBER,
  validateIdentifierType,
  isIdentifierTypeKey,
  readStoredIdentifiers,
  validateIdentifierTypes,
  type AutoNumbering,
  type IdentifierType,
  type RecordIdentifiers,
  type UniquenessRule,
} from "./identifiers.js";
import { identifierKey } from "./identifier-key.js";
import {
  matchesIdentifierPattern,
  parseIdentifierPattern,
  type IdentifierPattern,
} from "./identifier-pattern.js";
import { MAX_LISTED_RECORDS } from "./template-changes.js";
import { validateLegacyTemplate, type FieldTemplate } from "./templates.js";
import { MAX_RECORD_SET } from "./effective.js";
import { types } from "node:util";

export const IDENTIFIER_TYPE_CHANGE_CODES = [
  "reserved_key",
  "key_changed",
  "type_deleted",
  "made_public",
  "format_changed",
  "uniqueness_tightened",
  "auto_number_changed",
  "uniqueness_loosened",
  "made_staff",
] as const;
export type IdentifierTypeChangeCode = (typeof IDENTIFIER_TYPE_CHANGE_CODES)[number];

export interface IdentifierTypeChange {
  readonly code: IdentifierTypeChangeCode;
  /** The key of the type as it was (the old key, for `key_changed`). */
  readonly type: string;
  /** True when a person must confirm the change before the type is saved or deleted. */
  readonly needsConfirmation: boolean;
  /** Plain English; names the key and counts, never a stored value. */
  readonly message: string;
  /** The records the change affects (see the module header). At most `MAX_LISTED_RECORDS`. */
  readonly recordIds: readonly RecordId[];
  /** How many records it affects, even beyond the listed IDs. */
  readonly recordCount: number;
}

export interface IdentifierTypeChanges {
  /** Every change, frozen, in the order of `IDENTIFIER_TYPE_CHANGE_CODES`. */
  readonly changes: readonly IdentifierTypeChange[];
  /** True if any change needs confirmation. */
  readonly needsConfirmation: boolean;
  /** False when `existing` wasn't given, so no record was checked. */
  readonly recordsChecked: boolean;
}

/**
 * What an identifier type is used by. `identifierTypes`, `identifiers` and
 * `records` are required; an empty list means "none". `templates` is
 * optional: without it, every field is treated as possibly public.
 */
export interface IdentifierTypeUse {
  /** The organization's identifier types as they are now, including the one being changed. */
  readonly identifierTypes: readonly IdentifierType[];
  /** Every record's identifiers. */
  readonly identifiers: readonly RecordIdentifiers[];
  /** Every catalog record, for `{ type, value }` values in template `identifier` fields. */
  readonly records: readonly CatalogRecord[];
  /** The organization's templates (as stored), to tell which fields are public. */
  readonly templates?: readonly FieldTemplate[];
}

/**
 * Compare an identifier type with the version about to replace it, and list
 * the changes that need confirmation (see the module header). Leave
 * `existing` out only when the records are unknown. Never throws.
 */
export function identifierTypeChanges(
  oldType: unknown,
  newType: unknown,
  existing?: unknown,
): Validated<IdentifierTypeChanges> {
  return guarded(() => compare(oldType, newType, existing));
}

/**
 * List what deleting an identifier type would strand: one `type_deleted`
 * change with the records holding any value of the type. Leave `existing`
 * out only when the records are unknown. Never throws.
 */
export function identifierTypeDeletion(
  type: unknown,
  existing?: unknown,
): Validated<IdentifierTypeChanges> {
  return guarded(() => {
    const read = readType(type, "type");
    if (!read.ok) return read;
    const t = read.value;
    let use: Use | undefined;
    if (existing !== undefined) {
      const u = readUse(existing, t);
      if (!u.ok) return u;
      use = u.value;
    }
    const held = use === undefined ? undefined : holders(use, t.key);
    return done([change("type_deleted", t.key, held, held === undefined || held.count > 0)], use);
  });
}

// ---------------------------------------------------------------------------

function compare(
  oldInput: unknown,
  newInput: unknown,
  existing: unknown,
): Validated<IdentifierTypeChanges> {
  const before = readType(oldInput, "oldType");
  const after = readType(newInput, "newType");
  if (!before.ok || !after.ok) {
    return {
      ok: false,
      issues: [...(before.ok ? [] : before.issues), ...(after.ok ? [] : after.issues)],
    };
  }
  const was = before.value;
  const now = after.value;
  let use: Use | undefined;
  if (existing !== undefined) {
    const u = readUse(existing, was);
    if (!u.ok) return u;
    use = u.value;
    if (now.key !== was.key && use.identifierTypes.some((t) => t.key === now.key)) {
      return fail(
        ["newType", "key"],
        "key_taken",
        `Another identifier type already uses the key ${shown(now.key)}.`,
      );
    }
  }
  const key = was.key;
  const changes: IdentifierTypeChange[] = [];
  const unchecked = use === undefined;

  // `constructor` and `prototype` were allowed before D-0XX: a stored type
  // keeps working, but can't be created, and an edit must rename it.
  if (!isIdentifierTypeKey(now.key)) {
    if (now.key !== was.key) {
      return fail(["newType", "key"], "reserved_key", `${shown(now.key)} can't be used as a key.`);
    }
    changes.push(
      change("reserved_key", key, use === undefined ? undefined : holders(use, key), true),
    );
  }

  if (now.key !== was.key) {
    const held = use === undefined ? undefined : holders(use, key);
    changes.push(change("key_changed", key, held, unchecked || (held?.count ?? 0) > 0, now.key));
  }
  if (was.public !== true && now.public === true) {
    changes.push(
      change("made_public", key, use === undefined ? undefined : holders(use, key), true),
    );
  }
  if (now.pattern !== undefined && now.pattern !== was.pattern) {
    const held = use === undefined ? undefined : misfits(use, key, now.pattern);
    changes.push(change("format_changed", key, held, unchecked || (held?.count ?? 0) > 0));
  }
  const tightened = strictness(now.uniqueness) > strictness(was.uniqueness);
  if (tightened) {
    const held = use === undefined ? undefined : clashes(use, key, now.uniqueness);
    changes.push(change("uniqueness_tightened", key, held, unchecked || (held?.count ?? 0) > 0));
  }
  if (!sameAuto(was.autoNumber, now.autoNumber)) {
    if (now.autoNumber === undefined) {
      changes.push(
        change(
          "auto_number_changed",
          key,
          use === undefined ? undefined : new Held(),
          false,
          undefined,
          true,
        ),
      );
    } else {
      const held = use === undefined ? undefined : reissued(use, key, now.autoNumber, now.pattern);
      changes.push(change("auto_number_changed", key, held, unchecked || (held?.count ?? 0) > 0));
    }
  }
  if (strictness(now.uniqueness) < strictness(was.uniqueness)) {
    changes.push(
      change(
        "uniqueness_loosened",
        key,
        use === undefined ? undefined : new Held(),
        false,
        now.uniqueness,
      ),
    );
  }
  if (was.public === true && now.public !== true) {
    const held = use === undefined ? undefined : inPublicFields(use, key);
    changes.push(change("made_staff", key, held, unchecked || (held?.count ?? 0) > 0));
  }
  return done(changes, use);
}

function done(
  changes: readonly IdentifierTypeChange[],
  use: Use | undefined,
): Validated<IdentifierTypeChanges> {
  return {
    ok: true,
    value: Object.freeze({
      changes: Object.freeze([...changes]),
      needsConfirmation: changes.some((c) => c.needsConfirmation),
      recordsChecked: use !== undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reading the input

interface Use {
  readonly identifierTypes: readonly IdentifierType[];
  readonly identifiers: readonly RecordIdentifiers[];
  readonly records: readonly CatalogRecord[];
  /** Field keys that are public in some template, by record kind; undefined when unknown. */
  readonly publicKeys: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}

function readType(input: unknown, root: string): Validated<IdentifierType> {
  if (types.isProxy(input)) {
    return fail([root], "not_an_object", "An identifier type must be a plain object.");
  }
  const r = validateIdentifierType(input);
  if (!r.ok) {
    return { ok: false, issues: r.issues.map((i) => issue([root, ...i.path], i.code, i.message)) };
  }
  return { ok: true, value: normal(r.value) };
}

/**
 * A validated type with every optional property read as an own property, so
 * a polluted `Object.prototype` can't add a format, auto-numbering or
 * `public: true` that the type doesn't have (D-022).
 */
function normal(t: IdentifierType): IdentifierType {
  const pattern = Object.hasOwn(t, "pattern") ? t.pattern : undefined;
  const autoNumber = Object.hasOwn(t, "autoNumber") ? t.autoNumber : undefined;
  return Object.freeze({
    key: t.key,
    label: t.label,
    uniqueness: t.uniqueness,
    public: Object.hasOwn(t, "public") && t.public === true,
    ...(pattern === undefined ? {} : { pattern }),
    ...(autoNumber === undefined ? {} : { autoNumber }),
  });
}

function readUse(input: unknown, type: IdentifierType): Validated<Use> {
  if (types.isProxy(input) || !isPlainObject(input)) {
    return fail(
      ["existing"],
      "not_an_object",
      "existing must be an object with identifierTypes, identifiers and records.",
    );
  }
  for (const name of Object.keys(input)) {
    if (
      name !== "identifierTypes" &&
      name !== "identifiers" &&
      name !== "records" &&
      name !== "templates"
    ) {
      return fail(
        ["existing", name],
        "unknown_property",
        `${shown(name)} is not a property of existing.`,
      );
    }
  }
  const typesRead = validateIdentifierTypes(own(input, "identifierTypes"));
  if (!typesRead.ok) {
    return {
      ok: false,
      issues: typesRead.issues.map((i) =>
        issue(["existing", "identifierTypes", ...i.path], i.code, i.message),
      ),
    };
  }
  const listed = typesRead.value.find((t) => t.key === type.key);
  if (listed === undefined || !sameType(normal(listed), type)) {
    return fail(
      ["existing", "identifierTypes"],
      "type_not_listed",
      `The identifier type ${shown(type.key)} isn't in the organization's list as given, so the change can't be checked safely.`,
    );
  }
  const identifiers = readList(
    own(input, "identifiers"),
    "identifiers",
    // Stored sets may already hold stranded values (a removed type, a value
    // that never fit the format): those are read, not refused.
    readStoredIdentifiers,
    (set) => set.recordId,
  );
  if (!identifiers.ok) return identifiers;
  const records = readList(own(input, "records"), "records", validateRecord, (r) => r.id);
  if (!records.ok) return records;
  let publicKeys: Map<string, Set<string>> | undefined;
  const templatesInput = own(input, "templates");
  if (templatesInput !== undefined || Object.hasOwn(input, "templates")) {
    const templates = readList(templatesInput, "templates", validateLegacyTemplate);
    if (!templates.ok) return templates;
    publicKeys = new Map();
    for (const t of templates.value) {
      for (const f of t.fields) {
        if (f.kind !== "identifier" || f.visibility !== "public") continue;
        for (const kind of t.appliesTo) {
          let keys = publicKeys.get(kind);
          if (keys === undefined) {
            keys = new Set();
            publicKeys.set(kind, keys);
          }
          keys.add(f.key);
        }
      }
    }
  }
  return {
    ok: true,
    value: {
      identifierTypes: typesRead.value,
      identifiers: identifiers.value,
      records: records.value,
      publicKeys,
    },
  };
}

/** An own data property, never a getter or an inherited one. */
function own(obj: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d !== undefined && "value" in d ? d.value : undefined;
}

/** Validate every item; any invalid item, or an ID used twice, refuses them all. */
function readList<T>(
  input: unknown,
  name: string,
  validate: (item: unknown) => Validated<T>,
  idOf?: (item: T) => RecordId,
): Validated<readonly T[]> {
  if (types.isProxy(input) || !Array.isArray(input)) {
    return fail(["existing", name], "not_a_list", `existing.${name} must be a list.`);
  }
  const length = input.length;
  if (length > MAX_RECORD_SET) {
    return fail(
      ["existing", name],
      "too_many_records",
      `At most ${String(MAX_RECORD_SET)} can be checked at once.`,
    );
  }
  const out: T[] = [];
  const seen = new Set<RecordId>();
  for (let i = 0; i < length; i += 1) {
    const checked = validate(own(input, String(i)));
    // An entry that can't be read could hide a value this change affects.
    if (!checked.ok) {
      return fail(
        ["existing", name, i],
        "invalid_entry",
        `Entry ${String(i)} in existing.${name} is not valid, so the change can't be checked safely.`,
      );
    }
    const id = idOf?.(checked.value);
    if (id !== undefined && seen.has(id)) {
      return fail(
        ["existing", name, i],
        "duplicate_id",
        `Entry ${String(i)} in existing.${name} uses a record ID already in the list.`,
      );
    }
    if (id !== undefined) seen.add(id);
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

function sameType(a: IdentifierType, b: IdentifierType): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.pattern === b.pattern &&
    a.uniqueness === b.uniqueness &&
    (a.public === true) === (b.public === true) &&
    sameAuto(a.autoNumber, b.autoNumber)
  );
}

function sameAuto(a: AutoNumbering | undefined, b: AutoNumbering | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.style !== b.style || a.digits !== b.digits) return false;
  if (a.style === "year" && b.style === "year") return a.separator === b.separator;
  if (a.style === "prefix" && b.style === "prefix") return a.prefix === b.prefix;
  return false;
}

// ---------------------------------------------------------------------------
// Finding the records affected

/** Records found for one change, each counted once. */
class Held {
  readonly ids: RecordId[] = [];
  private readonly seen = new Set<RecordId>();
  add(id: RecordId): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.ids.length < MAX_LISTED_RECORDS) this.ids.push(id);
  }
  get count(): number {
    return this.seen.size;
  }
}

/** Each `{ type, value }` identifier value in a record's fields, as a field holds it. */
function* fieldIdentifiers(
  record: CatalogRecord,
): Generator<{ type: string; value: string; field: string }> {
  for (const name of Object.keys(record.fields)) {
    const value: JsonValue | undefined = record.fields[name];
    if (value === undefined) continue;
    const list: readonly JsonValue[] = Array.isArray(value)
      ? (value as readonly JsonValue[])
      : [value];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      const type = Object.hasOwn(item, "type") ? item.type : undefined;
      const v = Object.hasOwn(item, "value") ? item.value : undefined;
      if (typeof type === "string" && typeof v === "string") yield { type, value: v, field: name };
    }
  }
}

/** Records holding any value of the type: current, former, or in a field. */
function holders(use: Use, key: string): Held {
  const held = new Held();
  for (const set of use.identifiers) {
    if (set.current.some((i) => i.type === key) || set.former.some((i) => i.type === key)) {
      held.add(set.recordId);
    }
  }
  for (const record of use.records) {
    for (const item of fieldIdentifiers(record)) {
      if (item.type === key) {
        held.add(record.id);
        break;
      }
    }
  }
  return held;
}

/**
 * Records holding a value of the type in a template field that is public for
 * their kind in some template (records don't name their template yet,
 * T-012), or in any field when the templates weren't given. A staff type is
 * refused in public fields (D-022), so these stop passing the check.
 */
function inPublicFields(use: Use, key: string): Held {
  const held = new Held();
  for (const record of use.records) {
    const publicHere = use.publicKeys?.get(record.kind);
    if (use.publicKeys !== undefined && publicHere === undefined) continue;
    for (const item of fieldIdentifiers(record)) {
      if (item.type === key && (publicHere === undefined || publicHere.has(item.field))) {
        held.add(record.id);
        break;
      }
    }
  }
  return held;
}

/** Records holding a current value of the type that the new format refuses. */
function misfits(use: Use, key: string, source: string): Held {
  const held = new Held();
  const parsed = parseIdentifierPattern(source);
  // validateIdentifierType already parsed it; this can't fail.
  if (!parsed.ok) return held;
  const pattern = parsed.value;
  const fits = (value: string): boolean => matchesIdentifierPattern(pattern, value);
  for (const set of use.identifiers) {
    if (set.current.some((i) => i.type === key && !fits(i.value))) held.add(set.recordId);
  }
  for (const record of use.records) {
    for (const item of fieldIdentifiers(record)) {
      if (item.type === key && !fits(item.value)) {
        held.add(record.id);
        break;
      }
    }
  }
  return held;
}

function strictness(rule: UniquenessRule): number {
  return rule === "none" ? 0 : rule === "current" ? 1 : 2;
}

/**
 * Records whose values of the type clash with another record's under the new
 * rule, compared by `identifierKey` as `uniquenessIssues` does (former values
 * count under `all_time`). Values in template fields aren't part of the
 * uniqueness check (D-009), so they aren't counted here either.
 */
function clashes(use: Use, key: string, rule: UniquenessRule): Held {
  const owners = new Map<string, RecordId | null>();
  const add = (value: string, id: RecordId): void => {
    const k = identifierKey(value);
    const first = owners.get(k);
    if (first === undefined) owners.set(k, id);
    else if (first !== id) owners.set(k, null);
  };
  for (const set of use.identifiers) {
    for (const i of set.current) if (i.type === key) add(i.value, set.recordId);
    if (rule === "all_time")
      for (const i of set.former) if (i.type === key) add(i.value, set.recordId);
  }
  const held = new Held();
  for (const set of use.identifiers) {
    const values = [...set.current, ...(rule === "all_time" ? set.former : [])];
    if (values.some((i) => i.type === key && owners.get(identifierKey(i.value)) === null)) {
      held.add(set.recordId);
    }
  }
  return held;
}

/** The longest run of digits read as a number, as `nextIdentifier` reads them. */
const NUMBER = /^[0-9]{1,15}$/;
/** Everything but letters and digits, ignored when two numbers are compared loosely. */
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;

/**
 * Records holding a number the new auto-numbering would give out again,
 * written differently, or held only in a template field. `nextIdentifier` counts only values of exactly the new
 * form (`DHS-0007` for prefix `DHS-`) and gives out the highest plus one. A
 * value of another form that reads the same once separators are ignored
 * (`DHS 0009`, `DHS0009` or `DHS/0009`), with a number above that highest,
 * will be given out again in the new form; its key differs, so the
 * uniqueness check won't catch it.
 */
function reissued(use: Use, key: string, auto: AutoNumbering, source: string | undefined): Held {
  let pattern: IdentifierPattern | undefined;
  if (source !== undefined) {
    const parsed = parseIdentifierPattern(source);
    if (parsed.ok) pattern = parsed.value;
  }
  const format = (n: number, year: string): string => {
    const digits = String(n).padStart(auto.digits, "0");
    return auto.style === "year" ? `${year}${auto.separator}${digits}` : `${auto.prefix}${digits}`;
  };
  const prefixHead =
    auto.style === "prefix" ? identifierKey(auto.prefix).replace(NOT_LETTER_OR_DIGIT, "") : "";
  const prefixStart = auto.style === "prefix" ? identifierKey(auto.prefix) : "";
  /** The group (year, or "" for a prefix) and number of a value of exactly the new form. */
  const exact = (value: string): { head: string; n: number } | undefined => {
    const k = identifierKey(value);
    let head: string;
    let start: string;
    if (auto.style === "year") {
      head = k.slice(0, 4);
      if (!/^[0-9]{4}$/.test(head)) return undefined;
      start = identifierKey(`${head}${auto.separator}`);
    } else {
      head = prefixHead;
      start = prefixStart;
    }
    if (!k.startsWith(start)) return undefined;
    const rest = k.slice(start.length);
    if (!NUMBER.test(rest)) return undefined;
    const n = Number(rest);
    if (n > MAX_AUTO_NUMBER) return undefined;
    if (pattern !== undefined && !matchesIdentifierPattern(pattern, format(n, head)))
      return undefined;
    return { head, n };
  };
  /**
   * The group and number a value would have in the new form once separators
   * are ignored: the type's whole prefix (`M1-` reads `M1 0009` as 9), or a
   * four-digit year (`2026015` is 2026, number 15), then the sequence.
   */
  const loose = (value: string): { head: string; n: number } | undefined => {
    const k = identifierKey(value).replace(NOT_LETTER_OR_DIGIT, "");
    const head = auto.style === "year" ? k.slice(0, 4) : prefixHead;
    if (auto.style === "year" ? !/^[0-9]{4}$/.test(head) : !k.startsWith(head)) return undefined;
    const rest = k.slice(head.length);
    if (!NUMBER.test(rest)) return undefined;
    return { head, n: Number(rest) };
  };

  const highest = new Map<string, number>();
  const others: { id: RecordId; head: string; n: number }[] = [];
  for (const set of use.identifiers) {
    for (const item of [...set.current, ...set.former]) {
      if (item.type !== key) continue;
      const e = exact(item.value);
      if (e !== undefined) {
        if (e.n > (highest.get(e.head) ?? 0)) highest.set(e.head, e.n);
        continue;
      }
      const l = loose(item.value);
      if (l !== undefined && l.n >= 1 && l.n <= MAX_AUTO_NUMBER)
        others.push({ id: set.recordId, ...l });
    }
  }
  // nextIdentifier doesn't see numbers held only in template fields, so any
  // of them, even of exactly the new form, can be given out again.
  for (const record of use.records) {
    for (const item of fieldIdentifiers(record)) {
      if (item.type !== key) continue;
      const l = exact(item.value) ?? loose(item.value);
      if (l !== undefined && l.n >= 1 && l.n <= MAX_AUTO_NUMBER)
        others.push({ id: record.id, ...l });
    }
  }
  const held = new Held();
  for (const o of others) {
    if (o.n <= (highest.get(o.head) ?? 0)) continue;
    // A number the new format can't produce will never be given out.
    if (pattern !== undefined && !matchesIdentifierPattern(pattern, format(o.n, o.head))) continue;
    held.add(o.id);
  }
  return held;
}

// ---------------------------------------------------------------------------
// Results and messages

function change(
  code: IdentifierTypeChangeCode,
  type: string,
  held: Held | undefined,
  needsConfirmation: boolean,
  detail?: string,
  removed?: boolean,
): IdentifierTypeChange {
  const count = held?.count ?? 0;
  return Object.freeze({
    code,
    type,
    needsConfirmation,
    message: message(code, type, held === undefined ? undefined : count, detail, removed === true),
    recordIds: Object.freeze([...(held?.ids ?? [])]),
    recordCount: count,
  });
}

function message(
  code: IdentifierTypeChangeCode,
  type: string,
  count: number | undefined,
  detail: string | undefined,
  removed: boolean,
): string {
  const key = shown(type);
  const unchecked = "Records weren't checked, so any record may be affected.";
  const some = (what: string, after: string): string =>
    count === undefined
      ? `${unchecked} ${after}`
      : count === 0
        ? "No record is affected."
        : `${records(count)} ${what}. ${after}`;
  switch (code) {
    case "reserved_key":
      return `The identifier type key ${key} is no longer allowed (it is a reserved word). Rename the type; ${
        count === undefined
          ? "records weren't checked, so any record may hold values of it."
          : `${records(count)} hold values of it, which must move to the new key.`
      }`;
    case "key_changed":
      return `The identifier type ${key} gets the new key ${shown(detail ?? "")}. ${some(
        "hold values of it",
        "Their values keep the old key: current ones would no longer pass the check, and former ones would stop protecting their numbers from being given out again. Confirm first.",
      )}`;
    case "type_deleted":
      return `The identifier type ${key} is deleted. ${some(
        "hold values of it",
        "Current values would no longer pass the check, and former ones would stop protecting their numbers from being given out again. Confirm first.",
      )}`;
    case "made_public":
      return `The identifier type ${key} changes from staff to public, which publishes every value of it in public fields. ${
        count === undefined
          ? "Records weren't checked, so any record may hold one."
          : count === 0
            ? "No record holds one now."
            : `${records(count)} hold values of it.`
      } Confirm first.`;
    case "format_changed":
      return `The identifier type ${key} gets a new format. ${some(
        "hold a current value that doesn't fit it",
        "Those would no longer pass the check: fix them or retire them first.",
      )}`;
    case "uniqueness_tightened":
      return `The identifier type ${key} gets a stricter uniqueness rule. ${some(
        "hold a value another record also holds",
        "Those would no longer pass the uniqueness check.",
      )}`;
    case "auto_number_changed":
      if (removed) return `The identifier type ${key} stops giving out numbers automatically.`;
      return `Auto-numbering changes for the identifier type ${key}. ${some(
        "hold a number it would give out again, written differently (with another separator or prefix)",
        "Confirm first.",
      )}`;
    case "uniqueness_loosened":
      return detail === "none"
        ? `The identifier type ${key} no longer has to be unique, so two records may share a value.`
        : `The identifier type ${key} only has to be unique among current values, so a retired number may be given to another record.`;
    case "made_staff":
      return `The identifier type ${key} changes from public to staff, so its values will no longer be published.`;
  }
}

function records(count: number): string {
  return count === 1 ? "1 record" : `${String(count)} records`;
}

function fail<T>(path: readonly (string | number)[], code: string, text: string): Validated<T> {
  return { ok: false, issues: [issue([...path], code, text)] };
}

function guarded(run: () => Validated<IdentifierTypeChanges>): Validated<IdentifierTypeChanges> {
  try {
    return run();
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "These identifier types or records could not be read.")],
    };
  }
}
