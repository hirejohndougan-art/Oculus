/**
 * Deleting a record, with a tombstone (T-032, D-067, migration 0008).
 *
 * A deletion is the record's last version: `action = 'delete'`, the record
 * exactly as it was, who deleted it, when (the database's clock) and why,
 * stored in the same savepoint as the DELETE. History stays (versions have no
 * foreign key to records, D-063) and the ID is never used again. The database
 * refuses a DELETE without that version and a deletion version without its
 * DELETE, for every writer.
 *
 * Refused, storing nothing, while anything still needs the record:
 * - `has_children`: archival units are filed under it (move or delete them
 *   first);
 * - `represented`: digital assets are scans of it;
 * - `linked_from`: other records' fields link to it (`record_link` values or
 *   place values naming it); the message gives how many, never which, since
 *   the person may not be allowed to see them (T-041);
 * - `holds_identifiers`: it holds current or former numbers. Numbers are
 *   removed through the identifier save first, where dropping one is shown
 *   and confirmed (D-061: a number gone from every record is free again, also
 *   under `all_time`);
 * - `has_files`: files are attached to it (a digital asset, M-002, D-086);
 *   they are removed first, one by one, from its Files panel;
 * - `has_role_grants`: roles are granted for this unit's subtree (D-072);
 *   those grants are changed first (granting one locks the unit `FOR KEY
 *   SHARE` through its foreign key, so it waits for or blocks a deletion).
 * Its term usages are removed in the same savepoint (`clearRecordTerms`).
 *
 * **Locking.** The record row is locked `FOR UPDATE` first. Every save that
 * links to it, files a unit under it, scans it or saves its numbers holds a
 * lock on it that conflicts (`FOR KEY SHARE` from the save's checks and
 * foreign keys, `FOR NO KEY UPDATE` from an identifier save), so either that
 * save committed before the lock was granted (and the checks below, new
 * statements under Read Committed, see it) or it waits until the deletion
 * commits and then finds no record. Only writers that skip the service's
 * checks (direct SQL with the writer role) can add a link in `fields`
 * meanwhile: links inside `fields` are JSON, with no foreign key (D-060).
 *
 * Runs in a savepoint of the caller's transaction (outside one it throws).
 * The organization is the caller's: the service passes the signed-in
 * session's (D-019). Another organization's record is `unknown_record`, as
 * one that doesn't exist.
 */
import {
  isOrganizationId,
  isRecordId,
  issue,
  type Issue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import {
  inSavepoint,
  versionConflict,
  type RecordUpdate,
  type VersionConflict,
} from "./catalog.js";
import type { Queryable } from "./client.js";
import { validateRecordChange } from "./record-versions.js";
import { sql } from "./sql.js";
import { clearRecordTerms } from "./vocabularies.js";

/** A record's deletion as stored: its deletion version, without the snapshot. */
export interface RecordDeletion {
  readonly organizationId: OrganizationId;
  readonly recordId: RecordId;
  /** The deletion version's number: one past the record's last write. */
  readonly version: number;
  readonly actor: string;
  /** The database's clock at the deletion, in core's form. */
  readonly recordedAt: string;
  readonly reason?: string;
}

/** What `deleteRecord` returns. */
export type RecordDeletionResult =
  | { readonly ok: true; readonly value: RecordDeletion }
  | {
      readonly ok: false;
      readonly issues: readonly Issue[];
      /** Set when the refusal is `version_conflict`. */
      readonly conflict?: VersionConflict;
    };

function refused(path: readonly (string | number)[], code: string, message: string) {
  return { ok: false as const, issues: [issue(path, code, message)] };
}

const CHANGE_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "actor", "reason"]);

/**
 * Deletes the organization's record, storing its deletion version (module
 * header). `change` is as for `updateRecord`: the version the person was
 * looking at (`expectedVersion`; someone saved since: `version_conflict`
 * with what they changed), the actor and an optional reason. Returns the
 * deletion version (its snapshot is the record as it was, `readVersion`).
 */
export async function deleteRecord(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  change: RecordUpdate,
): Promise<RecordDeletionResult> {
  if (!isOrganizationId(organizationId)) {
    return refused(
      ["organizationId"],
      "invalid_organization",
      "The organization ID must be a lowercase version 4 UUID.",
    );
  }
  if (!isRecordId(recordId)) {
    return refused(["recordId"], "invalid_id", "The record ID must be a lowercase version 4 UUID.");
  }
  const extra = keyBeyond(change, CHANGE_KEYS);
  if (extra !== undefined) {
    return refused(
      ["change", extra],
      "unknown_property",
      "A deletion names only expectedVersion, actor and reason.",
    );
  }
  const expected = ownValue(change, "expectedVersion");
  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    expected >= 2 ** 31 - 1
  ) {
    return refused(
      ["expectedVersion"],
      "invalid_version",
      "Name the version the person was looking at: a whole number from 1.",
    );
  }
  const reason = ownValue(change, "reason");
  const who = validateRecordChange({
    actor: ownValue(change, "actor"),
    ...(reason === undefined ? {} : { reason }),
  });
  if (!who.ok) {
    return {
      ok: false,
      issues: who.issues.map((i) => issue(["change", ...i.path], i.code, i.message)),
    };
  }
  const org = organizationId;
  const where = sql`organization_id = ${org}::uuid`;
  const result = await inSavepoint(db, "delete", async (): Promise<Validated<RecordDeletion>> => {
    const [locked] = await db.rows<{ version: number; workflow_state: string }>(sql`
      SELECT version, workflow_state FROM public.records
      WHERE ${where} AND id = ${recordId}::uuid
      FOR UPDATE`);
    if (locked === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (locked.version !== expected) {
      return refused(
        ["expectedVersion"],
        "version_conflict",
        `The record was saved by someone else since version ${String(expected)}; it is now at version ${String(locked.version)}. Read it again.`,
      );
    }
    // A published record leaves the public only by being withdrawn (D-075,
    // D-076); the database refuses its deletion version too.
    if (locked.workflow_state === "published") {
      return refused(
        ["recordId"],
        "published",
        "This record is published. Unpublish it before deleting it.",
      );
    }
    const [uses] = await db.rows<{
      children: number;
      scans: number;
      numbers: number;
      linkers: number;
      grants: number;
      files: number;
    }>(sql`
      SELECT
        (SELECT count(*)::integer FROM public.records
         WHERE ${where} AND parent_id = ${recordId}::uuid) AS children,
        (SELECT count(*)::integer FROM public.records
         WHERE ${where} AND represents_id = ${recordId}::uuid) AS scans,
        (SELECT count(*)::integer FROM public.identifier_holdings
         WHERE ${where} AND record_id = ${recordId}::uuid) AS numbers,
        (SELECT count(*)::integer FROM public.records r
         WHERE r.organization_id = ${org}::uuid AND r.id <> ${recordId}::uuid
           AND jsonb_path_exists(r.fields, '$.** ? (@.recordId == $id)',
                                 jsonb_build_object('id', ${recordId}::text))) AS linkers,
        (SELECT count(*)::integer FROM public.role_assignments
         WHERE ${where} AND scope_record_id = ${recordId}::uuid) AS grants,
        (SELECT count(*)::integer FROM public.stored_files
         WHERE ${where} AND record_id = ${recordId}::uuid) AS files`);
    const problems: Issue[] = [];
    if ((uses?.children ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "has_children",
          `${String(uses?.children)} archival unit(s) are filed under this one. Move or delete them first.`,
        ),
      );
    }
    if ((uses?.scans ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "represented",
          `${String(uses?.scans)} digital asset(s) are scans of this record. Delete them or point them elsewhere first.`,
        ),
      );
    }
    if ((uses?.linkers ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "linked_from",
          `${String(uses?.linkers)} other record(s) link to this one. Remove those links first.`,
        ),
      );
    }
    if ((uses?.numbers ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "holds_identifiers",
          "This record holds identifiers (current or former). Remove them through the identifier save first.",
        ),
      );
    }
    if ((uses?.files ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "has_files",
          "Files are attached to this record. Remove its files first, then delete it.",
        ),
      );
    }
    if ((uses?.grants ?? 0) > 0) {
      problems.push(
        issue(
          ["recordId"],
          "has_role_grants",
          "Roles are granted for this unit and what is below it. Change those grants first.",
        ),
      );
    }
    if (problems.length > 0) return { ok: false, issues: problems };
    const cleared = await clearRecordTerms(db, org, recordId);
    if (!cleared.ok) return cleared;
    // The snapshot is the row as stored, whether or not core still accepts
    // it (a row changed by hand can be deleted too).
    const [tombstone] = await db.rows<{ version: number; recorded_at: string }>(sql`
      INSERT INTO public.record_versions (organization_id, record_id, version, record, actor,
                                          reason, action)
      SELECT organization_id, id, version + 1, public.record_snapshot(r), ${who.value.actor},
             ${who.value.reason ?? null}, 'delete'
      FROM public.records r
      WHERE ${where} AND id = ${recordId}::uuid
      RETURNING version,
        to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at`);
    if (tombstone === undefined) throw new Error("The deletion version was not stored.");
    await db.execute(sql`DELETE FROM public.records WHERE ${where} AND id = ${recordId}::uuid`);
    return {
      ok: true,
      value: Object.freeze({
        organizationId: org,
        recordId,
        version: tombstone.version,
        actor: who.value.actor,
        recordedAt: tombstone.recorded_at,
        ...(who.value.reason === undefined ? {} : { reason: who.value.reason }),
      }),
    };
  });
  if (result.ok || !result.issues.some((i) => i.code === "version_conflict")) return result;
  const conflict = await versionConflict(db, org, recordId, expected);
  return conflict === undefined ? result : { ...result, conflict };
}

/** The first own key not in `allowed` (or one that can't be read), if any. */
function keyBeyond(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const key = Reflect.ownKeys(value).find((k) => typeof k !== "string" || !allowed.has(k));
    return key === undefined ? undefined : String(key);
  } catch {
    return "(unreadable)";
  }
}

/** An own data property, never through a getter or a proxy's trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}
