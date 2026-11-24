/**
 * Comparing two versions of one record (T-030, D-065).
 *
 * `compareRecords(before, after)` lists what differs between two copies of
 * the same record, field by field: the History tab's compare, the edit
 * conflict's "what changed since" (T-031) and restoring an old version all
 * use it. It is pure: it reads only the two records it is given.
 *
 * Each difference is named the way the database names a version's changed
 * fields (D-063): core's property names (`title`, `kind`, `templateKey`,
 * `recordTypeKey`, `parentId`, `level`, `coordinates` …) and `fields.<key>`
 * for template fields, sorted. `id`, `organizationId`, `createdAt` and
 * `updatedAt` are never compared: the first three never change for a
 * record, and `updatedAt` is the writer's clock, not content. So comparing a
 * version with the version after it gives exactly that later version's
 * `changedFields`.
 *
 * Both records must be the same record of the same organization: copies of
 * two records, or of two organizations' records, are refused
 * (`different_records`, `mixed_organizations`), never compared (D-019,
 * D-030). Values are compared as JSON data: object keys in any order are the
 * same object, so a record read back from `jsonb` (keys sorted) compares
 * equal to the one written.
 *
 * The result holds the records' values (`before`, `after`), staff fields and
 * unpublished values included: it is staff-only, like the versions it comes
 * from, and must never reach public output.
 */
import { issue, type Validated } from "./issues.js";
import type { JsonValue } from "./plain-data.js";
import { validateRecord, type CatalogRecord } from "./records.js";
import { mixedOrganizationsIssue } from "./organizations.js";

/** How one property or field differs. */
export type RecordChangeKind = "added" | "removed" | "changed";

/** One difference between two versions of a record. */
export interface RecordDifference {
  /** `title`, `parentId`, `fields.<key>` …, as `RecordVersion.changedFields` names it. */
  readonly name: string;
  /** `added`: only `after` has it; `removed`: only `before`; `changed`: both, different. */
  readonly change: RecordChangeKind;
  /** The value before; absent when added. */
  readonly before?: JsonValue;
  /** The value after; absent when removed. */
  readonly after?: JsonValue;
}

/** What differs between two versions of one record, sorted by name. */
export interface RecordComparison {
  readonly differences: readonly RecordDifference[];
}

/** Properties never compared: they identify the record or are the writer's clock. */
const NOT_COMPARED: ReadonlySet<string> = new Set([
  "id",
  "organizationId",
  "createdAt",
  "updatedAt",
  "fields",
]);

/**
 * What differs from `before` to `after`, two copies of the same record (both
 * validated with `validateRecord` first; an invalid one is refused with its
 * issues, under `before` or `after` in the path). Never throws.
 */
export function compareRecords(before: unknown, after: unknown): Validated<RecordComparison> {
  const a = validateRecord(before);
  const b = validateRecord(after);
  if (!a.ok || !b.ok) {
    const issues = [
      ...(a.ok ? [] : a.issues.map((i) => issue(["before", ...i.path], i.code, i.message))),
      ...(b.ok ? [] : b.issues.map((i) => issue(["after", ...i.path], i.code, i.message))),
    ];
    return { ok: false, issues };
  }
  if (a.value.organizationId !== b.value.organizationId) {
    return { ok: false, issues: [mixedOrganizationsIssue([], "These two records")] };
  }
  if (a.value.id !== b.value.id) {
    return {
      ok: false,
      issues: [
        issue(
          ["id"],
          "different_records",
          "These are two different records; only versions of one record are compared.",
        ),
      ],
    };
  }
  return { ok: true, value: Object.freeze({ differences: differences(a.value, b.value) }) };
}

function differences(a: CatalogRecord, b: CatalogRecord): readonly RecordDifference[] {
  const found: RecordDifference[] = [];
  const top = (r: CatalogRecord): Map<string, JsonValue> => {
    const map = new Map<string, JsonValue>();
    for (const [key, value] of Object.entries(r as object) as [string, unknown][]) {
      if (!NOT_COMPARED.has(key) && value !== undefined) map.set(key, value as JsonValue);
    }
    for (const [key, value] of Object.entries(r.fields)) map.set(`fields.${key}`, value);
    return map;
  };
  const from = top(a);
  const to = top(b);
  const names = new Set([...from.keys(), ...to.keys()]);
  for (const name of names) {
    const was = from.get(name);
    const now = to.get(name);
    if (was === undefined && now !== undefined) {
      found.push(Object.freeze({ name, change: "added", after: now }));
    } else if (was !== undefined && now === undefined) {
      found.push(Object.freeze({ name, change: "removed", before: was }));
    } else if (was !== undefined && now !== undefined && !sameJson(was, now)) {
      found.push(Object.freeze({ name, change: "changed", before: was, after: now }));
    }
  }
  // Names are ASCII (property names and field keys), so this is the
  // database's byte order (COLLATE "C") too.
  found.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return Object.freeze(found);
}

/** True when two JSON values hold the same data (object key order aside). */
export function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const left: readonly JsonValue[] = a;
    const right: readonly JsonValue[] = b;
    return left.every((item, index) => {
      const other = right[index];
      return other !== undefined && sameJson(item, other);
    });
  }
  const left = a as Readonly<Record<string, JsonValue>>;
  const right = b as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(right, key)) return false;
    const x = left[key];
    const y = right[key];
    return x !== undefined && y !== undefined && sameJson(x, y);
  });
}
