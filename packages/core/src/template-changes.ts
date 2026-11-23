/**
 * Safe template changes (roadmap T-005a, security S-002, decision D-023).
 *
 * A template edit can publish data or strand it. A value entered while its
 * field was `staff` is published as soon as the field is made `public`, and
 * the same happens when a staff field is removed (its values stay in the
 * records as left-over keys, which are staff) and a public field is later
 * added with the same key. `templateChanges(oldTemplate, newTemplate,
 * records?)` compares two versions of one template before the new one is
 * saved and lists what needs a person's confirmation:
 *
 * - `made_public`: a field goes from staff to public, or a new public field
 *   uses a key that records already hold left-over (staff) values for.
 *   Always needs confirmation. Without records, every new public field is
 *   reported, since its key may hold left-overs nobody can see.
 * - `key_reused`: a new field uses a key the old template lacked, and records
 *   hold left-over values for it, which will now be read as the new field's.
 *   Without records, every new field is reported.
 * - `kind_added`: `appliesTo` gains a record kind. Records of that kind may
 *   hold values (stored under another template, possibly staff) under keys
 *   this template publishes. Needs confirmation when the template has any
 *   public field.
 * - `key_removed`: a field is gone; records keep its values as left-overs.
 * - `kind_changed`: stored values may no longer fit the field.
 * - `repeatable_changed`: stored lists or single values no longer fit; when
 *   a field stops repeating, `recordsWithSeveralValues` lists the records
 *   that can't be converted without dropping values.
 * - `option_removed`: a list option is gone (`option` names it).
 * - `max_length_lowered`: `maxLength` drops below some stored values.
 * - `vocabulary_removed`, `identifier_type_removed`: `vocabularies` or
 *   `identifierTypes` narrows (`removedCodes` names the codes dropped; a
 *   list where there was none narrows from "any"); `recordIds` are the
 *   records with a value the new list doesn't allow. A term with no
 *   vocabulary counts as `local`.
 * - `record_kind_removed`: a `record_link` field's `recordKinds` narrows
 *   (`removedCodes` names the record kinds dropped; no `recordKinds` allowed
 *   all six). `recordIds` are the records with a link to a record of a kind
 *   the field no longer allows. The kinds of linked records come from the
 *   organization's record link checker (`makeRecordLinkChecker`), given as
 *   `options.linkChecker`; without it every record holding a link under the
 *   key is listed, since any of them may be affected. A link the checker
 *   can't resolve to a kind (a record it doesn't hold, such as a deleted one
 *   or one added after it was made, an ID used twice, an invalid record) is
 *   counted too, since its kind is unknown. A place field always links to place records, so it can't
 *   narrow; changing a field between `record_link` and `place` is
 *   `kind_changed`, which lists every record holding a value.
 * - `made_required`: `required` turns on; `recordIds` are the records
 *   without a value.
 * - `inherited_changed`: needs confirmation when a field starts being
 *   inherited, since lower levels then take values from above.
 * - `made_staff`: informational.
 *
 * Removing an inherited field, or making a field inherited, also changes
 * what descendants using other templates receive (D-013's strictest
 * visibility along the way). Those descendants are not in `recordIds`;
 * such changes always need confirmation instead.
 *
 * When `records` (the records that use the template) are given, each change
 * lists the IDs of the records holding a value for its key (or, for the
 * codes above that say so, the records the change strands). An empty list
 * means "there are no records": pass nothing when they are unknown. Without them,
 * left-over keys can't be seen, so `recordsChecked` is false and every change
 * that could affect records needs confirmation. Callers saving a template
 * should pass the records.
 *
 * A record link checker made from another organization's records is refused
 * (`wrong_organization_checker`), as is one that belongs to no organization
 * (`no_organization_checker`: made from an empty set with no organization
 * given) and anything else given as one (`not_a_link_checker`), before any record is read: its record kinds would
 * describe another organization's records. Messages name neither.
 *
 * Every record given must name this template in its `templateKey`
 * (`record_not_for_template` refuses the whole comparison otherwise, D-029).
 * Records with no `templateKey` are allowed, since older records have none,
 * but are counted in `legacyRecords`: nothing confirms they use this template.
 *
 * Messages name keys and give counts only: they never quote a stored value,
 * since a staff value is exactly what this guards. Everything is validated
 * first (the old template with `validateLegacyTemplate`, so a template
 * stored with hyphenated identifier type codes can still be fixed, the new
 * one with `validateTemplate`, every record with
 * `validateRecord`); any doubt refuses the whole comparison with issues. The
 * work is linear in the records times the keys that changed. Never throws.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { shown, type JsonValue } from "./plain-data.js";
import { validateRecord, type CatalogRecord, type RecordKind } from "./records.js";
import { mixedOrganizationsIssue, oneOrganization } from "./organizations.js";
import type { RecordId } from "./record-id.js";
import {
  MAX_LONG_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
  validateLegacyTemplate,
  validateTemplate,
  type FieldDefinition,
  type FieldTemplate,
} from "./templates.js";
import { MAX_RECORD_SET } from "./effective.js";
import { isMadeLinkChecker, linkCheckerOrganization, linkTargetKind } from "./record-link-brand.js";
import { RECORD_KINDS } from "./records.js";
import type { OrganizationId } from "./organizations.js";
import { types } from "node:util";

export const TEMPLATE_CHANGE_CODES = [
  "made_public",
  "key_reused",
  "kind_added",
  "key_removed",
  "kind_changed",
  "repeatable_changed",
  "option_removed",
  "max_length_lowered",
  "vocabulary_removed",
  "identifier_type_removed",
  "record_kind_removed",
  "made_required",
  "inherited_changed",
  "made_staff",
] as const;
export type TemplateChangeCode = (typeof TEMPLATE_CHANGE_CODES)[number];

/** The most record IDs one change lists; `recordCount` always gives the full number. */
export const MAX_LISTED_RECORDS = 10_000;

export interface TemplateChange {
  readonly code: TemplateChangeCode;
  /** The field key the change is about; for `kind_added`, the record kind added. */
  readonly key: string;
  /** True when the change must be confirmed by a person before the template is saved. */
  readonly needsConfirmation: boolean;
  /** Plain English; names the key and counts, never a stored value. */
  readonly message: string;
  /**
   * Records holding a value for `key`. For `option_removed`, those using
   * `option`; for `max_length_lowered`, `vocabulary_removed`,
   * `identifier_type_removed` and `record_kind_removed`, those holding a
   * value the new field refuses (for `record_kind_removed` without a link
   * checker, every record holding a link);
   * for `made_required`, those without a value. For `kind_added`, the given
   * records of that kind, usually none yet, since they used another
   * template: the change is reported whatever the count. At most
   * `MAX_LISTED_RECORDS`.
   */
  readonly recordIds: readonly RecordId[];
  /** How many records hold such a value, even beyond the listed IDs. */
  readonly recordCount: number;
  /** `option_removed` only: the option value the template dropped. */
  readonly option?: string;
  /**
   * `vocabulary_removed` and `identifier_type_removed` only: the codes dropped
   * (empty when narrowing from any). `record_kind_removed`: the record kinds
   * dropped (from all six when the field had no `recordKinds`).
   */
  readonly removedCodes?: readonly string[];
  /** `repeatable_changed` from true to false only: records holding more than one value. */
  readonly recordsWithSeveralValues?: readonly RecordId[];
}

export interface TemplateChangeOptions {
  /**
   * The organization's record link checker, from `makeRecordLinkChecker`
   * made from all of its records: it tells the kind of each linked record,
   * for `record_kind_removed`. Another organization's checker, or any other
   * function, refuses the comparison.
   */
  readonly linkChecker?: unknown;
}

export interface TemplateChanges {
  /** Every change, frozen, in the order of the old template's fields, then the new fields. */
  readonly changes: readonly TemplateChange[];
  /** True if any change needs confirmation. */
  readonly needsConfirmation: boolean;
  /** False when no records were given, so left-over keys and affected records weren't checked. */
  readonly recordsChecked: boolean;
  /**
   * How many of the records given name no template (stored before records
   * did, D-029). Their template can't be confirmed, so a caller should treat
   * them as possibly belonging to another template. 0 with no records.
   */
  readonly legacyRecords: number;
}

/**
 * Compare a template with the version about to replace it, and list the
 * changes that need confirmation (see the module header). `records` are the
 * records that use the template; leave it out only when there are none to
 * check, since left-over keys are found only through them. `options` may
 * give the organization's record link checker (`linkChecker`). Never throws.
 */
export function templateChanges(
  oldTemplate: unknown,
  newTemplate: unknown,
  records?: unknown,
  options?: TemplateChangeOptions,
): Validated<TemplateChanges> {
  try {
    return compare(oldTemplate, newTemplate, records, options);
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "These templates or records could not be read.")],
    };
  }
}

function compare(
  oldInput: unknown,
  newInput: unknown,
  recordsInput: unknown,
  optionsInput: unknown,
): Validated<TemplateChanges> {
  const issues: Issue[] = [];
  // The stored version may predate the identifier type key rule (D-031).
  const before = validateLegacyTemplate(oldInput);
  if (!before.ok) issues.push(...prefixed("oldTemplate", before.issues));
  const after = validateTemplate(newInput);
  if (!after.ok) issues.push(...prefixed("newTemplate", after.issues));
  if (!before.ok || !after.ok) return { ok: false, issues };
  if (before.value.key !== after.value.key) {
    return {
      ok: false,
      issues: [
        issue(
          ["newTemplate", "key"],
          "different_template",
          `These are two different templates (${shown(before.value.key)} and ${shown(after.value.key)}), not two versions of one.`,
        ),
      ],
    };
  }

  // A template never moves between organizations (D-030), and its records
  // are its organization's: anything else would compare or list another
  // organization's data.
  if (after.value.organizationId !== before.value.organizationId) {
    return {
      ok: false,
      issues: [mixedOrganizationsIssue(["newTemplate", "organizationId"], "These two templates")],
    };
  }

  // The link checker is checked before any record is read.
  const linkChecker = readLinkChecker(optionsInput, after.value.organizationId);
  if (!linkChecker.ok) return linkChecker;
  const organizationId = after.value.organizationId;
  const kindOf =
    linkChecker.value === undefined
      ? undefined
      : (recordId: unknown) => linkTargetKind(linkChecker.value, organizationId, recordId);

  let records: readonly CatalogRecord[] | undefined;
  if (recordsInput !== undefined) {
    const read = readRecords(recordsInput);
    if (!read.ok) return read;
    records = read.value;
    if (
      records.length > 0 &&
      oneOrganization([after.value, ...records]) !== after.value.organizationId
    ) {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue(["records"], "The template and these records")],
      };
    }
  }
  // Only records that follow this template may be counted for it (D-029):
  // another template's record would be listed in this one's confirmation.
  let legacyRecords = 0;
  for (const [i, record] of (records ?? []).entries()) {
    // An own data property only: a `templateKey` inherited from a polluted
    // `Object.prototype` (or a getter there) must not decide whose record it is.
    const templateKey = own(record, "templateKey");
    if (templateKey === undefined) {
      legacyRecords += 1;
    } else if (templateKey !== after.value.key) {
      return {
        ok: false,
        issues: [
          issue(
            ["records", i, "templateKey"],
            "record_not_for_template",
            `Record ${String(i)} in the list follows another template, not ${shown(after.value.key)}, so the change can't be checked against it.`,
          ),
        ],
      };
    }
  }

  const oldFields = byKey(before.value);
  const newFields = byKey(after.value);
  const found: Found[] = [];
  for (const [key, was] of oldFields) {
    const now = newFields.get(key);
    if (now === undefined) {
      found.push({ code: "key_removed", key, wasInherited: was.inherited });
      continue;
    }
    if (was.visibility === "staff" && now.visibility === "public") {
      found.push({ code: "made_public", key });
    }
    if (was.kind !== now.kind) found.push({ code: "kind_changed", key });
    if (was.repeatable !== now.repeatable) {
      found.push({ code: "repeatable_changed", key, toSingle: was.repeatable });
    }
    if (was.kind === "list" && now.kind === "list") {
      const kept = new Set((now.options ?? []).map((o) => o.value));
      for (const o of was.options ?? []) {
        if (!kept.has(o.value)) found.push({ code: "option_removed", key, option: o.value });
      }
    }
    if (was.kind === now.kind) found.push(...stranding(key, was, now, kindOf));
    if (was.inherited !== now.inherited) {
      found.push({ code: "inherited_changed", key, nowInherited: now.inherited });
    }
    if (was.visibility === "public" && now.visibility === "staff") {
      found.push({ code: "made_staff", key });
    }
  }
  // New keys: only records can show whether they hold left-over values.
  const added: FieldDefinition[] = [];
  for (const [key, now] of newFields) if (!oldFields.has(key)) added.push(now);

  const oldKinds = new Set<RecordKind>(before.value.appliesTo);
  const newKinds = after.value.appliesTo.filter((k) => !oldKinds.has(k));
  const hasPublic = after.value.fields.some((f) => f.visibility === "public");

  const usage = records === undefined ? undefined : scan(records, found, added, newKinds);
  const changes: TemplateChange[] = [];
  for (const f of found) changes.push(finish(f, usage));
  for (const now of added) {
    // Without records, any new key may hold left-overs nobody can see.
    const held = usage?.byKey.get(now.key);
    if (usage !== undefined && (held === undefined || held.count === 0)) continue;
    if (now.visibility === "public") {
      changes.push(finish({ code: "made_public", key: now.key, leftOver: true }, usage));
    }
    changes.push(finish({ code: "key_reused", key: now.key }, usage));
  }
  for (const kind of newKinds) {
    changes.push(finish({ code: "kind_added", key: kind, hasPublic }, usage));
  }

  return {
    ok: true,
    value: Object.freeze({
      changes: Object.freeze(changes),
      needsConfirmation: changes.some((c) => c.needsConfirmation),
      recordsChecked: records !== undefined,
      legacyRecords,
    }),
  };
}

// ---------------------------------------------------------------------------

interface Found {
  readonly code: TemplateChangeCode;
  readonly key: string;
  readonly option?: string;
  /** repeatable_changed: the field stops repeating. */
  readonly toSingle?: boolean;
  /** made_public: the key was only a left-over in the records. */
  readonly leftOver?: boolean;
  /** key_removed: the field was inherited, so descendants may change. */
  readonly wasInherited?: boolean;
  /** inherited_changed: the field is inherited now. */
  readonly nowInherited?: boolean;
  /** kind_added: the new template has a public field. */
  readonly hasPublic?: boolean;
  /** True for one stored value the changed field no longer accepts. */
  readonly refuses?: (item: JsonValue) => boolean;
  /** made_required: the affected records are those without a value. */
  readonly missing?: boolean;
  /** record_kind_removed: no link checker, so every link may be affected. */
  readonly targetsUnchecked?: boolean;
  readonly removedCodes?: readonly string[];
}

/** Changes to a field of the same kind that leave stored values or records not fitting it. */
function stranding(
  key: string,
  was: FieldDefinition,
  now: FieldDefinition,
  kindOf: ((recordId: unknown) => RecordKind | undefined) | undefined,
): Found[] {
  const out: Found[] = [];
  if (now.kind === "text" || now.kind === "long_text") {
    const cap = now.kind === "text" ? MAX_TEXT_LENGTH : MAX_LONG_TEXT_LENGTH;
    const max = now.maxLength ?? cap;
    if (max < (was.maxLength ?? cap)) {
      out.push({
        code: "max_length_lowered",
        key,
        refuses: (item) => typeof item === "string" && item.length > max,
      });
    }
  }
  if (now.kind === "controlled_term") {
    const f = narrowing("vocabulary_removed", key, was.vocabularies, now.vocabularies, (item) =>
      isPlainObject(item) && typeof item.vocabulary === "string" ? item.vocabulary : "local",
    );
    if (f !== undefined) out.push(f);
  }
  if (now.kind === "identifier") {
    const f = narrowing(
      "identifier_type_removed",
      key,
      was.identifierTypes,
      now.identifierTypes,
      (item) => (isPlainObject(item) && typeof item.type === "string" ? item.type : undefined),
    );
    if (f !== undefined) out.push(f);
  }
  if (now.kind === "record_link" && now.recordKinds !== undefined) {
    const allowed = new Set<RecordKind>(now.recordKinds);
    const removed = (was.recordKinds ?? RECORD_KINDS).filter((k) => !allowed.has(k));
    if (removed.length > 0) {
      out.push({
        code: "record_kind_removed",
        key,
        removedCodes: Object.freeze(removed),
        ...(kindOf === undefined ? { targetsUnchecked: true } : {}),
        refuses: (item) => {
          if (!isPlainObject(item) || !Object.hasOwn(item, "recordId")) return false;
          if (kindOf === undefined) return true;
          // A link the checker can't resolve to a kind (not in its records,
          // an ID used twice, an invalid record, or a checker made before the
          // record was) may well be affected: fail closed.
          const kind = kindOf(item.recordId);
          return kind === undefined || !allowed.has(kind);
        },
      });
    }
  }
  if (!was.required && now.required) out.push({ code: "made_required", key, missing: true });
  return out;
}

/**
 * The record link checker in `options`, if any: one `makeRecordLinkChecker`
 * made, from this organization's records (or none). Anything else refuses
 * the comparison, with messages that name nothing.
 */
function readLinkChecker(options: unknown, organizationId: OrganizationId): Validated<unknown> {
  if (options === undefined) return { ok: true, value: undefined };
  const bad = (code: string, message: string): Validated<unknown> => ({
    ok: false,
    issues: [issue(["options"], code, message)],
  });
  if (types.isProxy(options) || !isPlainObject(options)) {
    return bad("invalid_options", "The options must be a plain object.");
  }
  const d = Object.getOwnPropertyDescriptor(options, "linkChecker");
  if (d === undefined) return { ok: true, value: undefined };
  if (!("value" in d)) {
    return bad("invalid_options", "linkChecker must be a plain property, not a getter.");
  }
  const checker: unknown = d.value;
  if (checker === undefined) return { ok: true, value: undefined };
  if (!isMadeLinkChecker(checker)) {
    return bad(
      "not_a_link_checker",
      "linkChecker must be a record link checker made by makeRecordLinkChecker.",
    );
  }
  const owner = linkCheckerOrganization(checker);
  if (owner === undefined) {
    return bad(
      "no_organization_checker",
      "This record link checker was made from no records and for no organization. Make it from this organization's records, or give makeRecordLinkChecker the organization.",
    );
  }
  if (owner !== organizationId) {
    return bad(
      "wrong_organization_checker",
      "This record link checker was made from another organization's records, so it can't be used for this template.",
    );
  }
  return { ok: true, value: checker };
}

/** A change when `now` allows fewer codes than `was` (undefined allows any). */
function narrowing(
  code: TemplateChangeCode,
  key: string,
  was: readonly string[] | undefined,
  now: readonly string[] | undefined,
  codeOf: (item: JsonValue) => string | undefined,
): Found | undefined {
  if (now === undefined) return undefined;
  const allowed = new Set(now);
  const removed = was === undefined ? [] : was.filter((c) => !allowed.has(c));
  if (was !== undefined && removed.length === 0) return undefined;
  return {
    code,
    key,
    removedCodes: Object.freeze(removed),
    refuses: (item) => {
      const c = codeOf(item);
      return c !== undefined && !allowed.has(c);
    },
  };
}

/** Records found for one key or one option. */
class Held {
  readonly ids: RecordId[] = [];
  count = 0;
  add(id: RecordId): void {
    this.count += 1;
    if (this.ids.length < MAX_LISTED_RECORDS) this.ids.push(id);
  }
}

interface Usage {
  /** Records holding any value, by key. */
  readonly byKey: ReadonlyMap<string, Held>;
  /** Records holding a list value, by key, then option value. */
  readonly byOption: ReadonlyMap<string, ReadonlyMap<string, Held>>;
  /** Records holding more than one value, by key. */
  readonly several: ReadonlyMap<string, Held>;
  /** Records of each record kind `appliesTo` gained. */
  readonly byKind: ReadonlyMap<string, Held>;
  /** Records a stranding change affects, by change. */
  readonly byFound: ReadonlyMap<Found, Held>;
}

/** One pass over the records, looking only at the keys that changed or are new. */
function scan(
  records: readonly CatalogRecord[],
  found: readonly Found[],
  added: readonly FieldDefinition[],
  newKinds: readonly RecordKind[],
): Usage {
  const byKind = new Map<string, Held>();
  for (const kind of newKinds) byKind.set(kind, new Held());
  const byKey = new Map<string, Held>();
  const byOption = new Map<string, Map<string, Held>>();
  const several = new Map<string, Held>();
  for (const f of found) {
    byKey.set(f.key, new Held());
    if (f.code === "option_removed" && f.option !== undefined) {
      let options = byOption.get(f.key);
      if (options === undefined) {
        options = new Map<string, Held>();
        byOption.set(f.key, options);
      }
      options.set(f.option, new Held());
    }
    if (f.code === "repeatable_changed" && f.toSingle === true) several.set(f.key, new Held());
  }
  for (const now of added) byKey.set(now.key, new Held());

  const keys = [...byKey];
  const byFound = new Map<Found, Held>();
  for (const f of found)
    if (f.refuses !== undefined || f.missing === true) byFound.set(f, new Held());
  const tests = [...byFound];
  for (const record of records) {
    byKind.get(record.kind)?.add(record.id);
    for (const [f, held] of tests) {
      const has = Object.hasOwn(record.fields, f.key);
      if (f.missing === true) {
        if (!has) held.add(record.id);
        continue;
      }
      if (!has || f.refuses === undefined) continue;
      const value = record.fields[f.key];
      if (value === undefined) continue;
      const list: readonly JsonValue[] = Array.isArray(value)
        ? (value as readonly JsonValue[])
        : [value];
      if (list.some(f.refuses)) held.add(record.id);
    }
    for (const [key, held] of keys) {
      if (!Object.hasOwn(record.fields, key)) continue;
      const value: JsonValue | undefined = record.fields[key];
      if (value === undefined) continue;
      held.add(record.id);
      const list: readonly JsonValue[] = Array.isArray(value)
        ? (value as readonly JsonValue[])
        : [value];
      if (list.length > 1) several.get(key)?.add(record.id);
      const options = byOption.get(key);
      if (options === undefined) continue;
      const seen = new Set<string>();
      for (const item of list) {
        if (typeof item !== "string" || seen.has(item)) continue;
        seen.add(item);
        options.get(item)?.add(record.id);
      }
    }
  }
  return { byKey, byOption, several, byKind, byFound };
}

function finish(f: Found, usage: Usage | undefined): TemplateChange {
  const held =
    usage === undefined
      ? undefined
      : f.code === "option_removed" && f.option !== undefined
        ? usage.byOption.get(f.key)?.get(f.option)
        : f.code === "kind_added"
          ? usage.byKind.get(f.key)
          : (usage.byFound.get(f) ?? usage.byKey.get(f.key));
  const count = held?.count ?? 0;
  const affected = usage === undefined || count > 0;
  let needsConfirmation: boolean;
  switch (f.code) {
    case "made_public":
      needsConfirmation = true;
      break;
    case "made_staff":
      needsConfirmation = false;
      break;
    case "inherited_changed":
      // Descendants on other templates aren't in the records checked here.
      needsConfirmation = f.nowInherited === true;
      break;
    case "kind_added":
      needsConfirmation = f.hasPublic === true;
      break;
    case "key_removed":
      needsConfirmation = affected || f.wasInherited === true;
      break;
    default:
      needsConfirmation = affected;
  }
  const several = f.toSingle === true ? usage?.several.get(f.key) : undefined;
  const change: TemplateChange = {
    code: f.code,
    key: f.key,
    needsConfirmation,
    message: message(f, usage === undefined ? undefined : count, several?.count ?? 0),
    recordIds: Object.freeze([...(held?.ids ?? [])]),
    recordCount: count,
    ...(f.option === undefined ? {} : { option: f.option }),
    ...(f.removedCodes === undefined ? {} : { removedCodes: f.removedCodes }),
    ...(f.toSingle === true && usage !== undefined
      ? { recordsWithSeveralValues: Object.freeze([...(several?.ids ?? [])]) }
      : {}),
  };
  return Object.freeze(change);
}

/** The message for one change. `count` is undefined when no records were given. */
function message(f: Found, count: number | undefined, several: number): string {
  const key = shown(f.key);
  const held =
    count === undefined
      ? "Records weren't checked, so any record may hold a value for it."
      : count === 0
        ? "No record holds a value for it."
        : `${records(count)} hold a value for it.`;
  switch (f.code) {
    case "made_public":
      if (f.leftOver === true && count === undefined) {
        return `The new public field ${key} may use a key that records still hold staff-only left-over values for. Records weren't checked, so saving could publish them. Confirm first.`;
      }
      return f.leftOver === true
        ? `The new public field ${key} uses a key that ${records(count ?? 0)} still hold values for from a removed field. Left-over values are staff only; saving publishes them. Confirm first.`
        : `The field ${key} changes from staff to public, which publishes every value stored while it was staff. ${held} Confirm first.`;
    case "key_reused":
      if (count === undefined) {
        return `The new field ${key} may use a key that records hold left-over values for. Records weren't checked. Check that any such values fit.`;
      }
      return `The new field ${key} uses a key that ${records(count)} hold left-over values for. Those values will be read as this field's. Check that they fit.`;
    case "key_removed":
      return `The field ${key} is removed. ${held} Those values stay in the records as staff-only left-overs.${f.wasInherited === true ? " It was inherited, so lower levels using other templates may change what they show." : ""}`;
    case "kind_added":
      return `The template now also applies to ${key} records. ${
        count === undefined
          ? "Records weren't checked."
          : `${records(count)} of that kind were given.`
      }${f.hasPublic === true ? " Their values under this template's public field keys, including ones stored as staff, would be published. Confirm first." : ""}`;
    case "kind_changed":
      return `The field ${key} changes kind. ${held} Those values may no longer fit.`;
    case "repeatable_changed":
      return f.toSingle === true
        ? `The field ${key} stops repeating. ${held}${several > 0 ? ` ${records(several)} hold more than one value, which can't be kept in one.` : ""}`
        : `The field ${key} starts repeating. ${held} Each value must become a list.`;
    case "option_removed":
      return `An option is removed from the list field ${key}. ${
        count === undefined
          ? "Records weren't checked, so any record may use it."
          : count === 0
            ? "No record uses it."
            : `${records(count)} use it.`
      }`;
    case "max_length_lowered":
      return `The field ${key} gets a lower length limit. ${stranded(count, "hold a value longer than the new limit")}`;
    case "vocabulary_removed":
      return `The field ${key} allows fewer vocabularies. ${stranded(count, "hold a term the field no longer allows")}`;
    case "identifier_type_removed":
      return `The field ${key} allows fewer identifier types. ${stranded(count, "hold an identifier of a type the field no longer allows")}`;
    case "record_kind_removed":
      if (f.targetsUnchecked === true && count !== undefined) {
        return `The field ${key} links to fewer kinds of record. ${
          count === 0
            ? "No record holds a link for it."
            : `Linked records weren't checked, so the ${records(count)} holding links for it may link to a kind it no longer allows.`
        }`;
      }
      return `The field ${key} links to fewer kinds of record. ${stranded(count, "link to a record of a kind the field no longer allows, or to one the record link checker doesn't know")}`;
    case "made_required":
      return `The field ${key} becomes required. ${stranded(count, "have no value for it")}`;
    case "inherited_changed":
      return f.nowInherited === true
        ? `The field ${key} is now inherited, so lower levels, including ones using other templates, take its value from above. Confirm first.`
        : `The field ${key} is no longer inherited by lower levels.`;
    case "made_staff":
      return `The field ${key} changes from public to staff, so it will no longer be published.`;
  }
}

function stranded(count: number | undefined, what: string): string {
  if (count === undefined) return "Records weren't checked, so any record may be affected.";
  if (count === 0) return "No record is affected.";
  return `${records(count)} ${what}, and would no longer pass the template check.`;
}

function records(count: number): string {
  return count === 1 ? "1 record" : `${String(count)} records`;
}

function byKey(template: FieldTemplate): ReadonlyMap<string, FieldDefinition> {
  const map = new Map<string, FieldDefinition>();
  for (const f of template.fields) map.set(f.key, f);
  return map;
}

function prefixed(root: string, list: readonly Issue[]): Issue[] {
  return list.map((i) => issue([root, ...i.path], i.code, i.message));
}

/** An own data property, never a getter or an inherited one. */
function own(obj: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d !== undefined && "value" in d ? d.value : undefined;
}

/** Validate every record; any unreadable record, or an ID used twice, refuses them all. */
function readRecords(input: unknown): Validated<readonly CatalogRecord[]> {
  if (types.isProxy(input) || !Array.isArray(input)) {
    return {
      ok: false,
      issues: [issue(["records"], "not_a_list", "The records must be given as a list.")],
    };
  }
  const length = input.length;
  if (length > MAX_RECORD_SET) {
    return {
      ok: false,
      issues: [
        issue(
          ["records"],
          "too_many_records",
          `At most ${String(MAX_RECORD_SET)} records can be checked at once.`,
        ),
      ],
    };
  }
  const out: CatalogRecord[] = [];
  const seen = new Set<RecordId>();
  for (let i = 0; i < length; i += 1) {
    // Read each slot as a plain data property, so a getter can't run.
    const slot = Object.getOwnPropertyDescriptor(input, i);
    const checked = validateRecord(slot !== undefined && "value" in slot ? slot.value : undefined);
    // A record that can't be read could hide a staff value, so nothing is guessed.
    if (!checked.ok) {
      return {
        ok: false,
        issues: [
          issue(
            ["records", i],
            "invalid_record",
            `Record ${String(i)} in the list is not a valid record, so the change can't be checked safely.`,
          ),
        ],
      };
    }
    // One organization's records only (D-019, D-030): a list that mixes in
    // another organization's records is refused, never filtered.
    const first = out[0];
    if (first !== undefined && first.organizationId !== checked.value.organizationId) {
      return { ok: false, issues: [mixedOrganizationsIssue(["records", i], "The records")] };
    }
    if (seen.has(checked.value.id)) {
      return {
        ok: false,
        issues: [
          issue(
            ["records", i],
            "duplicate_id",
            `Record ${String(i)} uses an ID already in the list.`,
          ),
        ],
      };
    }
    seen.add(checked.value.id);
    out.push(checked.value);
  }
  return { ok: true, value: out };
}
