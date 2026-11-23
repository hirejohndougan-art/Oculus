/**
 * Safe record type changes (roadmap T-013a, decisions D-037, D-053).
 *
 * A record names its record type in `recordTypeKey`, and `checkRecordType`
 * refuses a record whose type is missing (`unknown_record_type`) or of
 * another kind (`wrong_kind`). Editing a type's key or kind, or deleting it,
 * can therefore strand records. Before a type is saved,
 * `recordTypeChanges(oldType, newType, existing?)` compares the two versions,
 * and before one is deleted, `recordTypeDeletion(type, existing?)` checks
 * what uses it, as `templateChanges` (D-023) and `identifierTypeChanges`
 * (D-031) do. Both list the changes with the records they affect:
 *
 * - `key_changed`: the key is renamed. Records keep naming the old key, so
 *   they stop passing `checkRecordType` until they are moved to the new one.
 *   `recordIds` are the records naming the old key. A new key another type
 *   already has is refused (`key_taken`).
 * - `key_adopts_records`: records already name the new key, left from a
 *   deleted type; the renamed type takes them over. `recordIds` lists them,
 *   `mismatchRecordIds` those whose kind isn't the type's (they would fail
 *   with `wrong_kind`); `mismatchCount` counts them all. Without `existing`
 *   it is reported in case there are.
 * - `kind_changed`: the kind changes. `recordIds` are the records of the
 *   type (naming the old key) whose kind isn't the new one; a record's kind
 *   decides its fields and structure, so these fail with `wrong_kind`.
 * - `type_deleted`: `recordIds` are the records naming the type.
 * - `unverified`: `recordTypeChanges` without `existing`. The old type is
 *   then only the caller's word (it may be stale, or already claim the new
 *   kind), so the edit always needs confirmation, even when the two versions
 *   look the same.
 *
 * Each needs confirmation when it affects records, and whenever `existing`
 * isn't given. The label, description and default template are not
 * reported: the type is a label and a starting point, and changing them
 * changes nothing a record holds or publishes (D-037). This doesn't check
 * the new type's default template either; save it only after
 * `validateRecordType` passes (a new kind usually needs a new default).
 *
 * `existing` is `{ recordTypes, records }`, both required: the
 * organization's record types as they are now (which must contain `oldType`
 * exactly, else `type_not_listed`), and every catalog record of the
 * organization. An empty list means "there are none": pass nothing when they
 * are unknown, and `recordsChecked` is false.
 *
 * Every list is checked to be the type's organization's before any entry is
 * validated or any key looked up in it (`mixed_organizations`), so another
 * organization's data never shows in a message. Each list slot and property
 * is read once, as a plain own data property: getters never run, Proxies are
 * refused, and a polluted `Object.prototype` adds nothing. Any invalid
 * entry, duplicate key or record ID refuses the whole check (an unreadable
 * record could hide one this change strands). Messages name type keys and
 * counts only, never a record's title or values. Never throws.
 */
import { types } from "node:util";
import { issue, isPlainObject, type Validated } from "./issues.js";
import { shown } from "./plain-data.js";
import { validateRecord, type CatalogRecord, type RecordKind } from "./records.js";
import type { RecordId } from "./record-id.js";
import { MAX_RECORD_TYPES, readRecordType, type RecordType } from "./record-types.js";
import { MAX_LISTED_RECORDS } from "./template-changes.js";
import { MAX_RECORD_SET } from "./effective.js";
import { mixedOrganizationsIssue, oneOrganization, organizationIdOf } from "./organizations.js";

export const RECORD_TYPE_CHANGE_CODES = [
  "unverified",
  "key_changed",
  "key_adopts_records",
  "kind_changed",
  "type_deleted",
] as const;
export type RecordTypeChangeCode = (typeof RECORD_TYPE_CHANGE_CODES)[number];

export interface RecordTypeChange {
  readonly code: RecordTypeChangeCode;
  /** The type's key as it was (the old key, for `key_changed`); for `key_adopts_records`, the new key. */
  readonly type: string;
  /** True when a person must confirm the change before the type is saved or deleted. */
  readonly needsConfirmation: boolean;
  /** Plain English; names type keys and counts, never a record's title or values. */
  readonly message: string;
  /** The records the change affects (see the module header). At most `MAX_LISTED_RECORDS`. */
  readonly recordIds: readonly RecordId[];
  /** How many records it affects, even beyond the listed IDs. */
  readonly recordCount: number;
  /** `key_adopts_records` only: adopted records whose kind isn't the type's. At most `MAX_LISTED_RECORDS`. */
  readonly mismatchRecordIds?: readonly RecordId[];
  /** `key_adopts_records` only: how many adopted records are of another kind, even beyond the listed IDs. */
  readonly mismatchCount?: number;
}

export interface RecordTypeChanges {
  /** Every change, frozen, in the order of `RECORD_TYPE_CHANGE_CODES`. */
  readonly changes: readonly RecordTypeChange[];
  /** True if any change needs confirmation. */
  readonly needsConfirmation: boolean;
  /** False when `existing` wasn't given, so no record was checked. */
  readonly recordsChecked: boolean;
}

/** What a record type is used by. Both lists are required; an empty list means "none". */
export interface RecordTypeUse {
  /** The organization's record types as they are now, including the one being changed. */
  readonly recordTypes: readonly RecordType[];
  /** Every catalog record of the organization. */
  readonly records: readonly CatalogRecord[];
}

/**
 * Compare a record type with the version about to replace it, and list the
 * changes that strand records (see the module header). Leave `existing` out
 * only when the records are unknown. Never throws.
 */
export function recordTypeChanges(
  oldType: unknown,
  newType: unknown,
  existing?: unknown,
): Validated<RecordTypeChanges> {
  return guarded(() => {
    // The new type's organization is compared before its shape is checked,
    // so another organization's type, valid or not, gets no message about
    // its properties. Non-objects and Proxies are left to the shape check.
    const owner = organizationIdOf(oldType);
    if (
      owner !== undefined &&
      typeof newType === "object" &&
      newType !== null &&
      !types.isProxy(newType) &&
      organizationIdOf(newType) !== owner
    ) {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["newType", "organizationId"], "These record types")],
      };
    }
    const before = readType(oldType, "oldType");
    const after = readType(newType, "newType");
    if (!before.ok || !after.ok) {
      return {
        ok: false,
        issues: [...(before.ok ? [] : before.issues), ...(after.ok ? [] : after.issues)],
      };
    }
    const was = before.value;
    const now = after.value;
    // Checked before anything else is compared, so nothing of another
    // organization's type is shown.
    if (now.organizationId !== was.organizationId) {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["newType", "organizationId"], "These record types")],
      };
    }
    let use: Use | undefined;
    if (existing !== undefined) {
      const u = readUse(existing, was);
      if (!u.ok) return u;
      use = u.value;
      if (now.key !== was.key && use.typeKeys.has(now.key)) {
        return fail(
          ["newType", "key"],
          "key_taken",
          `Another record type already uses the key ${shown(now.key)}.`,
        );
      }
    }
    const unchecked = use === undefined;
    const changes: RecordTypeChange[] = [];
    // Without the stored list the old type is only the caller's word: it may
    // be stale or claim the new kind or key already, hiding a change that
    // strands every record of the type. So it always needs confirmation.
    if (unchecked) changes.push(change("unverified", was.key, undefined, true));
    if (now.key !== was.key) {
      const held = use === undefined ? undefined : naming(use, was.key);
      changes.push(
        change("key_changed", was.key, held, unchecked || (held?.count ?? 0) > 0, now.key),
      );
      if (use === undefined) {
        changes.push(change("key_adopts_records", now.key, undefined, true));
      } else {
        const adopted = naming(use, now.key);
        if (adopted.count > 0) {
          const mismatched = naming(use, now.key, now.kind);
          changes.push(
            Object.freeze({
              ...change("key_adopts_records", now.key, adopted, true, undefined, mismatched.count),
              mismatchRecordIds: Object.freeze([...mismatched.ids]),
              mismatchCount: mismatched.count,
            }),
          );
        }
      }
    }
    if (now.kind !== was.kind) {
      const held = use === undefined ? undefined : naming(use, was.key, now.kind);
      changes.push(
        change("kind_changed", was.key, held, unchecked || (held?.count ?? 0) > 0, now.kind),
      );
    }
    return done(changes, use);
  });
}

/**
 * List what deleting a record type would strand: one `type_deleted` change
 * with the records naming the type. Leave `existing` out only when the
 * records are unknown. Never throws.
 */
export function recordTypeDeletion(
  type: unknown,
  existing?: unknown,
): Validated<RecordTypeChanges> {
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
    const held = use === undefined ? undefined : naming(use, t.key);
    return done([change("type_deleted", t.key, held, held === undefined || held.count > 0)], use);
  });
}

function done(
  changes: readonly RecordTypeChange[],
  use: Use | undefined,
): Validated<RecordTypeChanges> {
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
  /** Every key in the organization's list. */
  readonly typeKeys: ReadonlySet<string>;
  /** Each record's ID, kind and own `recordTypeKey`, for records that name one. */
  readonly typed: readonly { id: RecordId; kind: RecordKind; typeKey: string }[];
}

/** A shape-checked type, every optional property read as an own property. */
function readType(input: unknown, root: string): Validated<RecordType> {
  const r = readRecordType(input);
  if (!r.ok) {
    return { ok: false, issues: r.issues.map((i) => issue([root, ...i.path], i.code, i.message)) };
  }
  return { ok: true, value: normal(r.value) };
}

function normal(t: RecordType): RecordType {
  const description = own(t, "description");
  return Object.freeze({
    key: t.key,
    organizationId: t.organizationId,
    label: t.label,
    ...(typeof description === "string" ? { description } : {}),
    kind: t.kind,
    defaultTemplateKey: t.defaultTemplateKey,
  });
}

function sameType(a: RecordType, b: RecordType): boolean {
  return (
    a.key === b.key &&
    a.organizationId === b.organizationId &&
    a.label === b.label &&
    own(a, "description") === own(b, "description") &&
    a.kind === b.kind &&
    a.defaultTemplateKey === b.defaultTemplateKey
  );
}

function readUse(input: unknown, type: RecordType): Validated<Use> {
  if (types.isProxy(input) || !isPlainObject(input)) {
    return fail(
      ["existing"],
      "not_an_object",
      "existing must be an object with recordTypes and records.",
    );
  }
  for (const name of Object.keys(input)) {
    if (name !== "recordTypes" && name !== "records") {
      return fail(
        ["existing", name],
        "unknown_property",
        `${shown(name)} is not a property of existing.`,
      );
    }
  }
  // Both lists are read slot by slot, once, and their organization checked
  // before any entry is validated, so another organization's data gets no
  // message naming its keys.
  const typeSlots = readSlots(own(input, "recordTypes"), "recordTypes", MAX_RECORD_TYPES);
  if (!typeSlots.ok) return typeSlots;
  const recordSlots = readSlots(own(input, "records"), "records", MAX_RECORD_SET);
  if (!recordSlots.ok) return recordSlots;
  for (const [name, slots] of [
    ["recordTypes", typeSlots.value],
    ["records", recordSlots.value],
  ] as const) {
    if (oneOrganization([type, ...slots]) === "mixed") {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["existing", name], `The type and existing.${name}`)],
      };
    }
  }

  const typeKeys = new Set<string>();
  let listed = false;
  for (let i = 0; i < typeSlots.value.length; i += 1) {
    const checked = readRecordType(typeSlots.value[i]);
    if (!checked.ok) return invalidEntry("recordTypes", i);
    const t = normal(checked.value);
    // A second line: the slots were all this organization's.
    if (t.organizationId !== type.organizationId) {
      return {
        ok: false,
        issues: [
          mixedOrganizationsIssue(["existing", "recordTypes"], "The type and existing.recordTypes"),
        ],
      };
    }
    if (typeKeys.has(t.key)) {
      return fail(
        ["existing", "recordTypes", i],
        "duplicate_key",
        `More than one record type in existing.recordTypes has the key ${shown(t.key)}.`,
      );
    }
    typeKeys.add(t.key);
    if (t.key === type.key) listed = sameType(t, type);
  }
  if (!listed) {
    return fail(
      ["existing", "recordTypes"],
      "type_not_listed",
      `The record type ${shown(type.key)} isn't in the organization's list as given, so the change can't be checked safely.`,
    );
  }

  const typed: { id: RecordId; kind: RecordKind; typeKey: string }[] = [];
  const seen = new Set<RecordId>();
  for (let i = 0; i < recordSlots.value.length; i += 1) {
    const checked = validateRecord(recordSlots.value[i]);
    // A record that can't be read could hide one this change strands.
    if (!checked.ok) return invalidEntry("records", i);
    const r = checked.value;
    if (r.organizationId !== type.organizationId) {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["existing", "records"], "The type and existing.records")],
      };
    }
    if (seen.has(r.id)) {
      return fail(
        ["existing", "records", i],
        "duplicate_id",
        `Entry ${String(i)} in existing.records uses a record ID already in the list.`,
      );
    }
    seen.add(r.id);
    // An own property only: a polluted Object.prototype must not give every
    // record a type.
    const typeKey = own(r, "recordTypeKey");
    if (typeof typeKey === "string") typed.push({ id: r.id, kind: r.kind, typeKey });
  }
  return { ok: true, value: { typeKeys, typed } };
}

/**
 * A real array of at most `max` entries, each slot read once as a plain own
 * data property. Too long a list is refused before any slot is read.
 */
function readSlots(input: unknown, name: string, max: number): Validated<readonly unknown[]> {
  if (types.isProxy(input) || !Array.isArray(input)) {
    return fail(["existing", name], "not_a_list", `existing.${name} must be a list.`);
  }
  const length = input.length;
  if (length > max) {
    return fail(
      ["existing", name],
      "too_many",
      `At most ${String(max)} can be checked at once in existing.${name}.`,
    );
  }
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) out.push(own(input, String(i)));
  return { ok: true, value: out };
}

function invalidEntry<T>(name: string, i: number): Validated<T> {
  return fail(
    ["existing", name, i],
    "invalid_entry",
    `Entry ${String(i)} in existing.${name} is not valid, so the change can't be checked safely.`,
  );
}

/** An own data property, never a getter or an inherited one. */
function own(obj: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d !== undefined && "value" in d ? d.value : undefined;
}

// ---------------------------------------------------------------------------
// Finding the records affected

/** Records found for one change. Record IDs are unique, so each is counted once. */
class Held {
  readonly ids: RecordId[] = [];
  count = 0;
  add(id: RecordId): void {
    this.count += 1;
    if (this.ids.length < MAX_LISTED_RECORDS) this.ids.push(id);
  }
}

/** Records naming `key`; with `notKind`, only those whose kind isn't it. */
function naming(use: Use, key: string, notKind?: RecordKind): Held {
  const held = new Held();
  for (const r of use.typed) {
    if (r.typeKey === key && (notKind === undefined || r.kind !== notKind)) held.add(r.id);
  }
  return held;
}

// ---------------------------------------------------------------------------
// Results and messages

function change(
  code: RecordTypeChangeCode,
  type: string,
  held: Held | undefined,
  needsConfirmation: boolean,
  /** key_changed: the new key; kind_changed: the new kind. */
  text?: string,
  /** key_adopts_records: how many are of another kind. */
  mismatches = 0,
): RecordTypeChange {
  const count = held?.count ?? 0;
  return Object.freeze({
    code,
    type,
    needsConfirmation,
    message: message(code, type, held === undefined ? undefined : count, text ?? "", mismatches),
    recordIds: Object.freeze([...(held?.ids ?? [])]),
    recordCount: count,
  });
}

function message(
  code: RecordTypeChangeCode,
  type: string,
  count: number | undefined,
  text: string,
  mismatches: number,
): string {
  const key = shown(type);
  const unchecked = "Records weren't checked, so any record may be affected.";
  const some = (what: string, after: string): string =>
    count === undefined
      ? `${unchecked} ${after}`
      : count === 0
        ? "No record is affected."
        : `${agree(count, what)}. ${after}`;
  switch (code) {
    case "unverified":
      return `The record type ${key} wasn't checked against the stored type or records, so its key or kind may already differ from what is stored, and saving could strand every record of it. Confirm first.`;
    case "key_changed":
      return `The record type ${key} gets the new key ${shown(text)}. ${some(
        "name the old key",
        "They would no longer pass the record type check until they are moved to the new key. Confirm first.",
      )}`;
    case "key_adopts_records":
      if (count === undefined) {
        return `Records weren't checked, so records may already name the key ${key} (left from a deleted type); this type would take them over. Confirm first.`;
      }
      return `${agree(count, "already name the key")} ${key}, left from a deleted type; this type takes them over.${
        mismatches > 0
          ? ` ${agree(mismatches, "are of another kind")} and would not pass the check.`
          : ""
      } Confirm first.`;
    case "kind_changed":
      return `The record type ${key} changes to the kind ${text}. ${some(
        "of this type are of another kind",
        "They would no longer pass the record type check. Confirm first.",
      )}`;
    case "type_deleted":
      return `The record type ${key} is deleted. ${some(
        "name it",
        "They would no longer pass the record type check until they are given another type. Confirm first.",
      )}`;
  }
}

/** "1 record names …" or "3 records name …". */
function agree(n: number, verb: string): string {
  if (n === 1) {
    const singular = verb
      .replace(/^name\b/, "names")
      .replace(/^already name\b/, "already names")
      .replace(/^are\b/, "is")
      .replace(/^of this type are\b/, "of this type is");
    return `1 record ${singular}`;
  }
  return `${String(n)} records ${verb}`;
}

function fail<T>(path: readonly (string | number)[], code: string, text: string): Validated<T> {
  return { ok: false, issues: [issue([...path], code, text)] };
}

function guarded(run: () => Validated<RecordTypeChanges>): Validated<RecordTypeChanges> {
  try {
    return run();
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "These record types or records could not be read.")],
    };
  }
}
