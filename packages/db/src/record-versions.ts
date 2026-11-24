/**
 * Record versions (`0005_record_versions.sql`, T-029, D-063): the
 * append-only history of every record, one full copy per write.
 *
 * `insertRecord` and `updateRecord` (`catalog.ts`) write a record and its
 * version together, inside one savepoint of the caller's transaction, through
 * `writeVersion` here. The database refuses anything else: a record written
 * without its version can't commit, a version can only be the next number of
 * a record written in the same transaction and must hold exactly the record
 * row, and versions are never updated, deleted or truncated (triggers, and
 * the app role's grants, D-063). The database fills in when (its own clock)
 * and which fields changed; the writer says who (`actor`) and, optionally,
 * why (`reason`).
 *
 * **Who** is an opaque actor ID until user accounts exist: `user:` and a
 * lowercase version 4 UUID, or `system:` and a lower-case name
 * (`system:import`, `system:migration_0005`). T-036 ties `user:` IDs to its
 * users table; until then nothing checks a user exists, so the service layer
 * (T-032) must pass the signed-in person's ID, never one a request names.
 *
 * Reads take the organization (D-019) and validate every snapshot again with
 * core's `validateRecord`, so a row changed behind the application's back by
 * the owner comes out as issues. History is staff-only data: a version holds
 * every field of the record, staff fields and unpublished values included,
 * so nothing here may reach public output (T-030, T-043 decide what is shown).
 */
import {
  compareRecords,
  isOrganizationId,
  isRecordId,
  issue,
  validateRecord,
  type CatalogRecord,
  type OrganizationId,
  type RecordDifference,
  type RecordId,
  type Validated,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** Who made a change and, optionally, why. */
export interface RecordChange {
  /** `user:<uuid v4>` or `system:<name>`, see `isActorId`. */
  readonly actor: string;
  /** Why, if the person said: trimmed, 1–2000 characters, no control characters but line breaks. */
  readonly reason?: string;
}

/** One stored version of a record. */
export interface RecordVersion {
  readonly organizationId: OrganizationId;
  readonly recordId: RecordId;
  /** 1 for the first write, then 2, 3 … with no gaps. */
  readonly version: number;
  /** The whole record as it was written, validated by core again on reading. */
  readonly record: CatalogRecord;
  readonly actor: string;
  /** The database's clock at the write, in core's form (`2026-11-23T17:05:00.000Z`). */
  readonly recordedAt: string;
  /**
   * What changed since the previous version (every property for version 1),
   * worked out by the database: core's property names (`title`, `parentId`,
   * `coordinates` …) and `fields.<key>` for template fields, sorted. Never
   * `id`, `organizationId`, `createdAt` or `updatedAt`.
   */
  readonly changedFields: readonly string[];
  readonly reason?: string;
  /**
   * `save` for every write of the record, `delete` for its deletion (T-032,
   * D-067): a deletion version holds the record as it was when deleted, is
   * always the record's last, and its `changedFields` is empty.
   */
  readonly action: RecordAction;
}

/** What a version records: a write of the record, or its deletion. */
export type RecordAction = "save" | "delete";

export interface RecordVersions {
  /** Oldest first. */
  readonly versions: readonly RecordVersion[];
  /** True when there were more than `limit`: ask again with `after` the last version. */
  readonly truncated: boolean;
}

export const DEFAULT_VERSION_LIST_LIMIT = 100;
export const MAX_VERSION_LIST_LIMIT = 1000;
export const MAX_REASON_LENGTH = 2000;

const ACTOR =
  /^(?:user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z][a-z0-9_-]{0,63})$/;
// eslint-disable-next-line no-control-regex -- control characters are what it finds.
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const CHANGE_KEYS: ReadonlySet<string> = new Set(["actor", "reason"]);
const BAD_ORGANIZATION = "The organization ID must be a lowercase version 4 UUID.";
const BAD_RECORD = "The record ID must be a lowercase version 4 UUID.";
const MAX_VERSION = 2 ** 31 - 1;

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** True for an actor ID the change log accepts: `user:<uuid v4>` or `system:<name>`. */
export function isActorId(value: unknown): value is string {
  return typeof value === "string" && ACTOR.test(value);
}

function isReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REASON_LENGTH &&
    value.replace(/^[ \n]+|[ \n]+$/g, "") === value &&
    !CONTROL_BUT_NEWLINE.test(value)
  );
}

/**
 * Checks who and why for a write. Only own data properties `actor` and
 * `reason` are read (never through a getter or a proxy's trap); anything else
 * is refused, so a misspelt `reasons` is never silently dropped.
 */
export function validateRecordChange(input: unknown): Validated<RecordChange> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refused([], "invalid_change", "A change names its actor (and optionally a reason).");
  }
  let actor: unknown;
  let reason: unknown;
  try {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !CHANGE_KEYS.has(key)) {
        return refused([String(key)], "unknown_property", "A change has only actor and reason.");
      }
      const slot = Object.getOwnPropertyDescriptor(input, key);
      if (slot === undefined || !("value" in slot)) {
        return refused([key], "unreadable", "This value could not be read as plain data.");
      }
      if (key === "actor") actor = slot.value;
      else reason = slot.value;
    }
  } catch {
    return refused([], "unreadable", "This change could not be read as plain data.");
  }
  if (!isActorId(actor)) {
    return refused(
      ["actor"],
      "invalid_actor",
      "The actor is user: and a lowercase version 4 UUID, or system: and a lower-case name.",
    );
  }
  if (reason !== undefined && !isReason(reason)) {
    return refused(
      ["reason"],
      "invalid_reason",
      `A reason is 1 to ${String(MAX_REASON_LENGTH)} characters, with no spaces or line breaks at its ends and no control characters but line breaks.`,
    );
  }
  return {
    ok: true,
    value: Object.freeze(reason === undefined ? { actor } : { actor, reason }),
  };
}

/** The columns every version read selects. */
interface VersionRow {
  version: number;
  record: unknown;
  actor: string;
  recorded_at: string;
  changed_fields: unknown;
  reason: string | null;
  action: string;
}

const VERSION_COLUMNS = sql`version, record, actor, action,
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
  changed_fields, reason`;

/**
 * @internal Stores the version of a record just written in this transaction
 * (`catalog.ts` calls it inside its savepoint, after the record row). The
 * database checks `version` is the row's and the next, and `record` is the
 * row; it fills in when and what changed.
 */
export async function writeVersion(
  db: Queryable,
  record: CatalogRecord,
  version: number,
  change: RecordChange,
): Promise<RecordVersion> {
  const [row] = await db.rows<VersionRow>(sql`
    INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, reason)
    VALUES (${record.organizationId}::uuid, ${record.id}::uuid, ${version}::integer,
            ${JSON.stringify(record)}::jsonb, ${change.actor}, ${change.reason ?? null})
    RETURNING ${VERSION_COLUMNS}`);
  if (row === undefined) throw new Error("The record version was not stored.");
  const stored = versionFromRow(record.organizationId, record.id, row);
  if (!stored.ok) throw new Error("The stored record version doesn't read back as written.");
  return stored.value;
}

function versionFromRow(
  organizationId: OrganizationId,
  recordId: RecordId,
  row: VersionRow,
): Validated<RecordVersion> {
  const record = validateRecord(row.record);
  if (!record.ok) return record;
  if (record.value.organizationId !== organizationId || record.value.id !== recordId) {
    return refused([], "row_mismatch", "The stored version doesn't match its row.");
  }
  const changed = row.changed_fields;
  if (
    !Number.isInteger(row.version) ||
    row.version < 1 ||
    !isActorId(row.actor) ||
    (row.reason !== null && !isReason(row.reason)) ||
    !Array.isArray(changed) ||
    !changed.every((name): name is string => typeof name === "string") ||
    (row.action !== "save" && row.action !== "delete")
  ) {
    return refused([], "row_mismatch", "The stored version doesn't match its row.");
  }
  return {
    ok: true,
    value: Object.freeze({
      organizationId,
      recordId,
      version: row.version,
      record: record.value,
      actor: row.actor,
      recordedAt: row.recorded_at,
      changedFields: Object.freeze([...changed]),
      ...(row.reason === null ? {} : { reason: row.reason }),
      action: row.action,
    }),
  };
}

function checkIds<T>(organizationId: OrganizationId, recordId: RecordId): Validated<T> | undefined {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isRecordId(recordId)) return refused(["recordId"], "invalid_id", BAD_RECORD);
  return undefined;
}

function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;
}

/**
 * One version of the organization's record: the given one, or the latest
 * (which is always the record as it now is, D-063). `undefined` if there is
 * none, including for another organization's record. A deleted record's
 * versions are still found.
 */
export async function readVersion(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  version?: number,
): Promise<Validated<RecordVersion> | undefined> {
  const bad = checkIds<RecordVersion>(organizationId, recordId);
  if (bad) return bad;
  if (version !== undefined && !isVersionNumber(version)) {
    return refused(["version"], "invalid_version", "A version is a whole number from 1.");
  }
  const [row] = await db.rows<VersionRow>(sql`
    SELECT ${VERSION_COLUMNS} FROM public.record_versions
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND (${version ?? null}::integer IS NULL OR version = ${version ?? null}::integer)
    ORDER BY version DESC
    LIMIT 1`);
  return row === undefined ? undefined : versionFromRow(organizationId, recordId, row);
}

/**
 * The organization's versions of a record, oldest first, `limit` at a time
 * (default 100, at most 1000) after version `after`. An unknown record (or
 * another organization's) has none. Refused as a whole if any version no
 * longer validates, with that version's number first in each issue's path.
 */
export async function readVersions(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: { after?: number; limit?: number } = {},
): Promise<Validated<RecordVersions>> {
  const bad = checkIds<RecordVersions>(organizationId, recordId);
  if (bad) return bad;
  const limit = options.limit ?? DEFAULT_VERSION_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERSION_LIST_LIMIT) {
    return refused(
      ["limit"],
      "invalid_limit",
      `The limit is a whole number from 1 to ${String(MAX_VERSION_LIST_LIMIT)}.`,
    );
  }
  const after = options.after ?? 0;
  if (after !== 0 && !isVersionNumber(after)) {
    return refused(["after"], "invalid_version", "A version is a whole number from 1.");
  }
  const rows = await db.rows<VersionRow>(sql`
    SELECT ${VERSION_COLUMNS} FROM public.record_versions
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND version > ${after}::integer
    ORDER BY version
    LIMIT ${limit + 1}::integer`);
  const versions: RecordVersion[] = [];
  for (const row of rows.slice(0, limit)) {
    const one = versionFromRow(organizationId, recordId, row);
    if (!one.ok) {
      return {
        ok: false,
        issues: one.issues.map((i) => issue([row.version, ...i.path], i.code, i.message)),
      };
    }
    versions.push(one.value);
  }
  return {
    ok: true,
    value: Object.freeze({ versions: Object.freeze(versions), truncated: rows.length > limit }),
  };
}

/** Two versions of one record, compared (`compareVersions`). */
export interface VersionComparison {
  readonly from: number;
  readonly to: number;
  /** What differs from `from` to `to`, sorted by name (`compareRecords`). */
  readonly differences: readonly RecordDifference[];
}

/**
 * Compares two stored versions of the organization's record, field by field
 * (`compareRecords`, T-030): what differs from version `from` to version
 * `to` (either may be the older). Both are read in one statement, so from
 * one moment, and validated again. `unknown_version` if either isn't stored
 * for this organization's record (another organization's record has no
 * versions here). Staff-only, like the versions.
 */
export async function compareVersions(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  from: number,
  to: number,
): Promise<Validated<VersionComparison>> {
  const bad = checkIds<VersionComparison>(organizationId, recordId);
  if (bad) return bad;
  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!isVersionNumber(value)) {
      return refused([name], "invalid_version", "A version is a whole number from 1.");
    }
  }
  const rows = await db.rows<VersionRow>(sql`
    SELECT ${VERSION_COLUMNS} FROM public.record_versions
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND version IN (${from}::integer, ${to}::integer)`);
  const read = (version: number, name: "from" | "to"): Validated<RecordVersion> => {
    const row = rows.find((r) => r.version === version);
    if (row === undefined) {
      return refused([name], "unknown_version", "The record has no such version.");
    }
    const one = versionFromRow(organizationId, recordId, row);
    return one.ok
      ? one
      : { ok: false, issues: one.issues.map((i) => issue([name, ...i.path], i.code, i.message)) };
  };
  const a = read(from, "from");
  if (!a.ok) return a;
  const b = read(to, "to");
  if (!b.ok) return b;
  const compared = compareRecords(a.value.record, b.value.record);
  if (!compared.ok) return compared;
  return {
    ok: true,
    value: Object.freeze({ from, to, differences: compared.value.differences }),
  };
}
