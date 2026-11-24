/**
 * Safe identifier type changes (roadmap T-005a, decision D-031).
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
 * - `key_adopts_values`: the new key already has values stored under it,
 *   left from a deleted type (they were staff, since a removed type's values
 *   are read leniently and never published). The type takes them over:
 *   `recordIds` lists them, `misfitRecordIds` those that don't fit its
 *   format and `clashRecordIds` those clashing under its uniqueness rule.
 *   Always needs confirmation; a public type also reports `made_public`
 *   for them. `identifierTypeCreation(type, existing?)` runs the same check
 *   for a new type.
 * - `type_deleted`: as `key_changed`, for a type being deleted.
 * - `templates_reference_type`: on a rename or deletion, when `templates`
 *   are given, the templates whose `identifierTypes` name the old key
 *   (`templateKeys`). Needs confirmation.
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
 *   (allowed before D-031) is edited without renaming it; needs
 *   confirmation, and renaming onto a reserved key is refused.
 * - `made_staff`: `public` goes from true to false. A staff type is refused
 *   in public template fields (D-022), so `recordIds` are the records holding
 *   a value of it in a field public in the template the record names (its
 *   `templateKey`; for a record naming none, public for its kind in some
 *   template; any field when `templates` isn't given or lacks the record's
 *   template); needs confirmation when there are.
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
  validateNewIdentifierType,
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
import { mixedOrganizationsIssue, oneOrganization } from "./organizations.js";
import { types } from "node:util";

export const IDENTIFIER_TYPE_CHANGE_CODES = [
  "reserved_key",
  "key_changed",
  "key_adopts_values",
  "type_deleted",
  "templates_reference_type",
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
  /**
   * The key of the type as it was (the old key, for `key_changed`); for
   * `key_adopts_values` and the `made_public` that comes with it, the key
   * whose stored values the type takes over.
   */
  readonly type: string;
  /** True when a person must confirm the change before the type is saved or deleted. */
  readonly needsConfirmation: boolean;
  /** Plain English; names the key and counts, never a stored value. */
  readonly message: string;
  /** The records the change affects (see the module header). At most `MAX_LISTED_RECORDS`. */
  readonly recordIds: readonly RecordId[];
  /** How many records it affects, even beyond the listed IDs. */
  readonly recordCount: number;
  /** `key_adopts_values` only: adopted values' records that don't fit the type's format. */
  readonly misfitRecordIds?: readonly RecordId[];
  /** `key_adopts_values` only: records whose values clash under the type's uniqueness rule. */
  readonly clashRecordIds?: readonly RecordId[];
  /** `templates_reference_type` only: the templates whose `identifierTypes` name the key. */
  readonly templateKeys?: readonly string[];
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
    const changes = [change("type_deleted", t.key, held, held === undefined || held.count > 0)];
    const refs = use === undefined ? undefined : referencing(use, t.key);
    if (refs !== undefined) changes.push(refs);
    return done(changes, use);
  });
}

/**
 * Check an identifier type about to be created (`validateNewIdentifierType`,
 * and its key must be free). Values stored under that key, left from a
 * deleted type, become this type's: `key_adopts_values` lists them (with
 * those that don't fit its format or clash under its uniqueness rule), and a
 * public type also reports `made_public`, since left-over values were staff.
 * Leave `existing` out only when the records are unknown. Never throws.
 */
export function identifierTypeCreation(
  type: unknown,
  existing?: unknown,
): Validated<IdentifierTypeChanges> {
  return guarded(() => {
    if (types.isProxy(type)) {
      return fail(["type"], "not_an_object", "An identifier type must be a plain object.");
    }
    const checked = validateNewIdentifierType(type);
    if (!checked.ok) {
      return {
        ok: false,
        issues: checked.issues.map((i) => issue(["type", ...i.path], i.code, i.message)),
      };
    }
    const t = normal(checked.value);
    let use: Use | undefined;
    if (existing !== undefined) {
      const u = readUse(existing, t, false);
      if (!u.ok) return u;
      use = u.value;
    }
    const changes = adoption(t, [], use);
    if (use !== undefined && t.autoNumber !== undefined) {
      // Adopted left-overs are counted by nextIdentifier only in exactly its form.
      const held = reissued(use, t.key, t.autoNumber, t.pattern);
      if (held.count > 0) changes.push(change("auto_number_changed", t.key, held, true));
    }
    return done(changes, use);
  });
}

/**
 * The changes when `type` takes over values already stored under its key
 * (`alsoKeys`: other keys whose values it keeps, for the uniqueness check).
 */
function adoption(
  type: IdentifierType,
  alsoKeys: readonly string[],
  use: Use | undefined,
  reportPublic = true,
): IdentifierTypeChange[] {
  const out: IdentifierTypeChange[] = [];
  if (use === undefined) {
    out.push(change("key_adopts_values", type.key, undefined, true));
    if (type.public === true && reportPublic) {
      out.push(change("made_public", type.key, undefined, true, { leftOver: true }));
    }
    return out;
  }
  const adopted = holders(use, type.key);
  if (adopted.count === 0) return out;
  const misfit = type.pattern === undefined ? new Held() : misfits(use, type.key, type.pattern);
  const clash =
    type.uniqueness === "none"
      ? new Held()
      : clashes(use, [type.key, ...alsoKeys], type.uniqueness);
  out.push(
    Object.freeze({
      ...change("key_adopts_values", type.key, adopted, true, {
        misfits: misfit.count,
        clashes: clash.count,
      }),
      misfitRecordIds: Object.freeze([...misfit.ids]),
      clashRecordIds: Object.freeze([...clash.ids]),
    }),
  );
  if (type.public === true && reportPublic) {
    out.push(change("made_public", type.key, adopted, true, { leftOver: true }));
  }
  return out;
}

/** Templates whose `identifierTypes` lists name `key`, when templates were given. */
function referencing(use: Use, key: string): IdentifierTypeChange | undefined {
  if (use.templates === undefined) return undefined;
  const keys: string[] = [];
  for (const t of use.templates) {
    if (t.fields.some((f) => f.identifierTypes?.includes(key) === true)) keys.push(t.key);
  }
  if (keys.length === 0) return undefined;
  const base = change("templates_reference_type", key, new Held(), true, {
    text: String(keys.length),
  });
  return Object.freeze({ ...base, templateKeys: Object.freeze(keys) });
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
  if (now.organizationId !== was.organizationId) {
    return {
      ok: false,
      issues: [mixedOrganizationsIssue(["newType", "organizationId"], "These identifier types")],
    };
  }
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

  // Without stored data the old type isn't checked either: it may claim to be
  // public already when the stored one is staff.
  const madePublic = now.public === true && (was.public !== true || unchecked);

  // `constructor` and `prototype` were allowed before D-031: a stored type
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
    changes.push(
      change("key_changed", key, held, unchecked || (held?.count ?? 0) > 0, { text: now.key }),
    );
    // Values left under the new key by a deleted type become this type's.
    // A type made public here reports the adopted values in its own made_public.
    changes.push(...adoption(now, [key], use, !madePublic));
    const refs = use === undefined ? undefined : referencing(use, key);
    if (refs !== undefined) changes.push(refs);
  }
  if (madePublic) {
    let held: Held | undefined;
    if (use !== undefined) {
      held = holders(use, key);
      if (now.key !== key) for (const id of holders(use, now.key).all()) held.add(id);
    }
    changes.push(
      change(
        "made_public",
        key,
        held,
        true,
        unchecked && was.public === true ? { text: "unverified" } : {},
      ),
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
        change("auto_number_changed", key, use === undefined ? undefined : new Held(), false, {
          removed: true,
        }),
      );
    } else {
      // After a rename nextIdentifier counts the new key's values (adopted
      // left-overs), not the old key's.
      const held =
        use === undefined
          ? undefined
          : reissued(use, now.key, now.autoNumber, now.pattern, now.key === key ? [] : [key]);
      changes.push(change("auto_number_changed", key, held, unchecked || (held?.count ?? 0) > 0));
    }
  }
  if (strictness(now.uniqueness) < strictness(was.uniqueness)) {
    changes.push(
      change("uniqueness_loosened", key, use === undefined ? undefined : new Held(), false, {
        text: now.uniqueness,
      }),
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
  /**
   * Public identifier field keys in some template, by record kind, for
   * records that name no template; undefined when templates weren't given.
   */
  readonly publicKeys: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Public identifier field keys by template key (T-012a); undefined when unknown. */
  readonly publicKeysByTemplate: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** The templates given, or undefined. */
  readonly templates: readonly FieldTemplate[] | undefined;
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
    organizationId: t.organizationId,
    key: t.key,
    label: t.label,
    uniqueness: t.uniqueness,
    public: Object.hasOwn(t, "public") && t.public === true,
    ...(pattern === undefined ? {} : { pattern }),
    ...(autoNumber === undefined ? {} : { autoNumber }),
  });
}

/** `listed`: the type must be in the list exactly (an edit or deletion), or absent from it (a creation). */
function readUse(input: unknown, type: IdentifierType, listed = true): Validated<Use> {
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
  const typesInput = own(input, "identifierTypes");
  const mixedTypes = (): Validated<Use> => ({
    ok: false,
    issues: [
      mixedOrganizationsIssue(
        ["existing", "identifierTypes"],
        "The type and existing.identifierTypes",
      ),
    ],
  });
  // validateIdentifierTypes checks every entry's organization (as a plain own
  // data property) against the type's before anything else, so another
  // organization's list, valid or not, gets no message naming its keys
  // (S-009a, S-009b).
  const typesRead = validateIdentifierTypes(typesInput, type.organizationId);
  if (!typesRead.ok) {
    if (typesRead.issues.some((i) => i.code === "mixed_organizations")) return mixedTypes();
    return {
      ok: false,
      issues: typesRead.issues.map((i) =>
        issue(["existing", "identifierTypes", ...i.path], i.code, i.message),
      ),
    };
  }
  // Checked again on the validated copy before any key is looked up in it,
  // so another organization's list can't reveal which keys it holds (S-009).
  if (oneOrganization([type, ...typesRead.value]) === "mixed") return mixedTypes();
  const found = typesRead.value.find((t) => t.key === type.key);
  if (!listed && found !== undefined) {
    return fail(
      ["type", "key"],
      "key_taken",
      `Another identifier type already uses the key ${shown(type.key)}.`,
    );
  }
  if (listed && (found === undefined || !sameType(normal(found), type))) {
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
  let publicKeysByTemplate: Map<string, Set<string>> | undefined;
  let templateList: readonly FieldTemplate[] | undefined;
  const templatesInput = own(input, "templates");
  if (templatesInput !== undefined || Object.hasOwn(input, "templates")) {
    const templates = readList(templatesInput, "templates", validateLegacyTemplate);
    if (!templates.ok) return templates;
    templateList = templates.value;
    publicKeys = new Map();
    publicKeysByTemplate = new Map();
    for (const t of templates.value) {
      // Every listed template gets an entry, so a template with no public
      // identifier field is known to have none.
      let mine = publicKeysByTemplate.get(t.key);
      if (mine === undefined) {
        mine = new Set();
        publicKeysByTemplate.set(t.key, mine);
      }
      for (const f of t.fields) {
        if (f.kind !== "identifier" || f.visibility !== "public") continue;
        mine.add(f.key);
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
  // Every list belongs to the type's organization (D-030): a set, record or
  // type of another one, or one that doesn't say, refuses the check.
  for (const [name, list] of [
    ["identifierTypes", typesRead.value],
    ["identifiers", identifiers.value],
    ["records", records.value],
    ["templates", templateList ?? []],
  ] as const) {
    const owner = oneOrganization([type, ...list]);
    if (owner === "mixed") {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["existing", name], `The type and existing.${name}`)],
      };
    }
  }
  return {
    ok: true,
    value: {
      identifierTypes: typesRead.value,
      identifiers: identifiers.value,
      records: records.value,
      publicKeys,
      publicKeysByTemplate,
      templates: templateList,
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
    a.organizationId === b.organizationId &&
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
  /** Every record found, beyond the listed ones too. */
  all(): IterableIterator<RecordId> {
    return this.seen.values();
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
 * Records holding a value of the type in a template field that is public in
 * the template the record names (its `templateKey`, T-012a, D-029), or in
 * any field when the templates weren't given or don't include the record's.
 * A record that names no template (stored before records did) is matched,
 * as before, against the fields public for its kind in any template. A staff
 * type is refused in public fields (D-022), so these stop passing the check.
 */
function inPublicFields(use: Use, key: string): Held {
  const held = new Held();
  for (const record of use.records) {
    const templateKey = own(record, "templateKey");
    const publicHere =
      typeof templateKey === "string"
        ? use.publicKeysByTemplate?.get(templateKey)
        : use.publicKeys?.get(record.kind);
    if (
      typeof templateKey !== "string" &&
      use.publicKeys !== undefined &&
      publicHere === undefined
    ) {
      continue;
    }
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
function clashes(use: Use, key: string | readonly string[], rule: UniquenessRule): Held {
  const keys = new Set(typeof key === "string" ? [key] : key);
  const owners = new Map<string, RecordId | null>();
  const add = (value: string, id: RecordId): void => {
    const k = identifierKey(value);
    const first = owners.get(k);
    if (first === undefined) owners.set(k, id);
    else if (first !== id) owners.set(k, null);
  };
  for (const set of use.identifiers) {
    for (const i of set.current) if (keys.has(i.type)) add(i.value, set.recordId);
    if (rule === "all_time")
      for (const i of set.former) if (keys.has(i.type)) add(i.value, set.recordId);
  }
  const held = new Held();
  for (const set of use.identifiers) {
    const values = [...set.current, ...(rule === "all_time" ? set.former : [])];
    if (values.some((i) => keys.has(i.type) && owners.get(identifierKey(i.value)) === null)) {
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
/**
 * `key` is the key the type has after the change, whose values
 * `nextIdentifier` will count; `alsoKeys` are keys whose values it keeps
 * but `nextIdentifier` won't count (the old key of a renamed type), so
 * every one of them is a candidate, even of exactly the new form.
 */
function reissued(
  use: Use,
  key: string,
  auto: AutoNumbering,
  source: string | undefined,
  alsoKeys: readonly string[] = [],
): Held {
  const uncounted = new Set(alsoKeys);
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
    const k = identifierKey(value);
    // Walk past the head's letters and digits (any separators between them).
    const want = auto.style === "year" ? 4 : prefixHead.length;
    let head = "";
    let i = 0;
    while (i < k.length && head.length < want) {
      const ch = String.fromCodePoint(k.codePointAt(i) ?? 0);
      if (/[\p{L}\p{N}]/u.test(ch)) head += ch;
      i += ch.length;
    }
    if (auto.style === "year" ? !/^[0-9]{4}$/.test(head) : head !== prefixHead) return undefined;
    // Then only separators and one run of digits: `DHS-2026-0015` isn't a
    // DHS- number, it has two.
    const tail = /^([^\p{L}\p{N}]*)([0-9]+)$/u.exec(k.slice(i));
    const sep = tail?.[1];
    const rest = tail?.[2];
    if (sep === undefined || rest === undefined || !NUMBER.test(rest)) return undefined;
    // With nothing between them, the split is a guess (`123456` read as year
    // 1234): only a sequence at least as wide as the numbering pads to counts.
    if (sep.length === 0 && rest.length < auto.digits) return undefined;
    return { head, n: Number(rest) };
  };

  const highest = new Map<string, number>();
  const others: { id: RecordId; head: string; n: number }[] = [];
  for (const set of use.identifiers) {
    for (const item of [...set.current, ...set.former]) {
      if (uncounted.has(item.type)) {
        const l = exact(item.value) ?? loose(item.value);
        if (l !== undefined && l.n >= 1 && l.n <= MAX_AUTO_NUMBER)
          others.push({ id: set.recordId, ...l });
        continue;
      }
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
      if (item.type !== key && !uncounted.has(item.type)) continue;
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

/** Extra detail for one message. */
interface Detail {
  /** key_changed: the new key; uniqueness_loosened: the new rule; templates_reference_type: the template count. */
  readonly text?: string;
  /** auto_number_changed: numbering removed. */
  readonly removed?: boolean;
  /** made_public: the values were left under the key by a deleted type. */
  readonly leftOver?: boolean;
  /** key_adopts_values: how many records don't fit the format, and how many clash. */
  readonly misfits?: number;
  readonly clashes?: number;
}

function change(
  code: IdentifierTypeChangeCode,
  type: string,
  held: Held | undefined,
  needsConfirmation: boolean,
  detail: Detail = {},
): IdentifierTypeChange {
  const count = held?.count ?? 0;
  return Object.freeze({
    code,
    type,
    needsConfirmation,
    message: message(code, type, held === undefined ? undefined : count, detail),
    recordIds: Object.freeze([...(held?.ids ?? [])]),
    recordCount: count,
  });
}

function message(
  code: IdentifierTypeChangeCode,
  type: string,
  count: number | undefined,
  detail: Detail,
): string {
  const key = shown(type);
  const unchecked = "Records weren't checked, so any record may be affected.";
  /** "1 record holds …" or "3 records hold …". */
  const agree = (n: number, verb: string): string =>
    `${records(n)} ${n === 1 ? verb.replace(/^hold\b/, "holds") : verb}`;
  const some = (what: string, after: string): string =>
    count === undefined
      ? `${unchecked} ${after}`
      : count === 0
        ? "No record is affected."
        : `${agree(count, what)}. ${after}`;
  switch (code) {
    case "reserved_key":
      return `The identifier type key ${key} is no longer allowed (it is a reserved word). Rename the type; ${
        count === undefined
          ? "records weren't checked, so any record may hold values of it."
          : count === 0
            ? "no record holds values of it."
            : `${agree(count, "hold values of it")}, which must move to the new key.`
      }`;
    case "key_changed":
      return `The identifier type ${key} gets the new key ${shown(detail.text ?? "")}. ${some(
        "hold values of it",
        "Their values keep the old key: current ones would no longer pass the check, and former ones would stop protecting their numbers from being given out again. Confirm first.",
      )}`;
    case "key_adopts_values":
      if (count === undefined) {
        return `Records weren't checked, so values may already be stored under the key ${key} (left from a deleted type, and staff only); this type would take them over. Confirm first.`;
      }
      return `${agree(count, "hold values")} stored under the key ${key}, left from a deleted type; this type takes them over.${
        (detail.misfits ?? 0) > 0
          ? ` ${agree(detail.misfits ?? 0, "hold one that doesn't fit its format")}.`
          : ""
      }${
        (detail.clashes ?? 0) > 0
          ? ` ${agree(detail.clashes ?? 0, "hold one another record also holds")}, against its uniqueness rule.`
          : ""
      } Confirm first.`;
    case "type_deleted":
      return `The identifier type ${key} is deleted. ${some(
        "hold values of it",
        "Current values would no longer pass the check, and former ones would stop protecting their numbers from being given out again. Confirm first.",
      )}`;
    case "templates_reference_type":
      return `${detail.text === "1" ? "1 template lists" : `${detail.text ?? "Some"} templates list`} the identifier type ${key} in a field's allowed types; update ${detail.text === "1" ? "it" : "them"} too, or the fields will name a type that doesn't exist. Confirm first.`;
    case "made_public":
      if (detail.leftOver === true) {
        return count === undefined
          ? `The new public type ${key} may take over staff-only values left under its key. Records weren't checked, so saving could publish them. Confirm first.`
          : `The public type ${key} takes over values left under its key by a deleted type, which were staff only; ${agree(count, "hold them")}. Saving publishes them. Confirm first.`;
      }
      if (detail.text === "unverified") {
        return `The identifier type ${key} is public. It wasn't checked against the stored type or records, so it may have been staff, and saving could publish every value stored while it was. Confirm first.`;
      }
      return `The identifier type ${key} changes from staff to public, which publishes every value of it in public fields. ${
        count === undefined
          ? "Records weren't checked, so any record may hold one."
          : count === 0
            ? "No record holds one now."
            : `${agree(count, "hold values of it")}.`
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
      if (detail.removed === true) {
        return `The identifier type ${key} stops giving out numbers automatically.`;
      }
      return `Auto-numbering changes for the identifier type ${key}. ${some(
        "hold a number it would give out again, written differently (with another separator or prefix) or only in a template field",
        "Confirm first.",
      )}`;
    case "uniqueness_loosened":
      return detail.text === "none"
        ? `The identifier type ${key} no longer has to be unique, so two records may share a value.`
        : `The identifier type ${key} only has to be unique among current values, so a retired number may be given to another record.`;
    case "made_staff":
      return `The identifier type ${key} changes from public to staff, so its values will no longer be published. ${some(
        "hold one in a public template field",
        "Those would no longer pass the check, since a staff type isn't allowed there.",
      )}`;
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
