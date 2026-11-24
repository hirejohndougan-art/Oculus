/**
 * Restoring an old version of a record (T-030, D-065).
 *
 * `restoreVersion` writes a **new** version whose content is an old one's:
 * history is never deleted or rewound, so the restore itself shows in the
 * History tab ("restored version 3"), and restoring can be undone by
 * restoring again. It goes through `updateRecord`, with the version the
 * person was looking at as `expectedVersion` (T-031: if someone saved since,
 * nothing is stored and the conflict says what they changed), an actor and
 * the reason `restored version N`.
 *
 * **Today's checks first.** An old version passed the rules of its day; the
 * template, the identifier types, the linked records or the arrangement may
 * have changed since. So the old content is checked as a save would be now,
 * and if it no longer passes, nothing is stored and every problem is
 * returned for the person to fix in the editor instead:
 * - its template as it is now (`checkRecordAgainstTemplate`: unknown and
 *   missing fields, value shapes, the rights checker's accepted statements,
 *   the identifier checker against today's identifier types, record links
 *   and place links to records of the organization that exist now, of the
 *   kinds the field allows; a template that no longer applies to the kind);
 * - identifier fields against the record's identifiers **as they are now**
 *   (`identifierFieldIssues`: a field may only show a number the record
 *   currently holds);
 * - its record type as it is now (`checkRecordType`), if it names one;
 * - a parent (archival units) that still exists, is an archival unit it can
 *   be filed under, isn't the record itself or one of its descendants, and
 *   keeps the tree within `MAX_ARRANGEMENT_DEPTH`; and, if the level changes
 *   back, that its children can still be filed under it;
 * - a represented record (digital assets) that still exists;
 * - unless `confirmMadePublic` lists exactly these fields, no restored value lands in a field
 *   public today with a value other than the record's current one
 *   (`public_field_restored`): the field may have been staff-only when the
 *   value was stored and made public after it was removed, so the value was
 *   never confirmed for publishing.
 * Every problem is returned, not only the first, with fixed messages (code
 * and path kept): core's messages may quote old values, and a refusal must
 * not reveal an old version. A restore that succeeds does reveal it, so the
 * service layer requires the permission to read the record's history as
 * well as to edit it (T-032, T-041).
 *
 * **Identifiers are not restored.** A version holds the record row only;
 * identifier sets live in their own tables (D-061), are not versioned, and
 * keep their own history (former numbers with when and why). Restoring
 * leaves the record's current and former numbers exactly as they are, so it
 * can never break identifier uniqueness; an identifier field of the old
 * version that names a number the record no longer holds is reported
 * (`identifier_not_held`), and the number must be added back through the
 * identifier save first (which runs the uniqueness rules).
 *
 * The record row is locked (`FOR NO KEY UPDATE`) before anything is read, so
 * neither the record nor its identifiers (whose save takes the same lock)
 * change between the checks and the write; the checks (`record-checks.ts`)
 * lock the template's and record type's versions, the identifier types and
 * the linked records until the transaction ends (T-032, D-067), so nothing
 * they checked against can change before COMMIT. When the parent or level changes (decided
 * up front from the version and the row), the organization's arrangement
 * lock (0006) is taken before the record row's lock and held to COMMIT, and the database's guard refuses any loop
 * whoever writes. Read Committed only (`read_committed_required`). The
 * service layer must wrap a restore like any save (T-032: permissions,
 * `refreshRecordTerms`, T-034's publish re-check).
 *
 * `updatedAt` becomes the later of the stored one and now (D-063: it never
 * goes backwards); `createdAt`, the ID, the organization and the kind never
 * change, so they are the stored ones anyway. Runs in a savepoint of the
 * caller's transaction (outside one it throws). Everything here is
 * staff-only.
 */
import {
  compareRecords,
  isOrganizationId,
  isRecordId,
  issue,
  isFieldKey,
  type CatalogRecord,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import {
  inSavepoint,
  readStoredRecord,
  updateRecord,
  versionConflict,
  type RecordUpdate,
  type RecordUpdateResult,
} from "./catalog.js";
import type { Queryable } from "./client.js";
import { fixedMessages, recordCheckIssues } from "./record-checks.js";
import { MAX_REASON_LENGTH, readVersion, validateRecordChange } from "./record-versions.js";
import { sql } from "./sql.js";

export { MAX_DESCENDANTS_WALKED } from "./record-checks.js";

/** Options for `restoreVersion`. */
export interface RestoreOptions {
  /** The clock, for tests. Default: now. */
  readonly now?: Date;
  /**
   * The field keys of the `public_field_restored` list the person saw and
   * confirmed: restored values that land in fields public today and differ
   * from what the record holds now (D-065). The restore goes ahead only if
   * this is exactly today's list (in any order); otherwise it is refused
   * with today's list, so a list that changed since the person saw it is
   * shown again.
   */
  readonly confirmMadePublic?: readonly string[];
  /**
   * Records the person may not view (T-041, D-072): links to them that the
   * restore would add are checked as links to records that don't exist.
   */
  readonly hiddenLinks?: ReadonlySet<RecordId>;
}

/** At most this many confirmed field keys (no template has more fields). */
const MAX_CONFIRMED_FIELDS = 1000;

const OPTION_KEYS: ReadonlySet<string> = new Set(["now", "confirmMadePublic", "hiddenLinks"]);
const CHANGE_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "actor", "reason"]);

function refused(path: readonly (string | number)[], code: string, message: string) {
  return { ok: false as const, issues: [issue(path, code, message)] };
}

/** The reason stored with a restore: `restored version N`, then the person's own, if given. */
export function restoreReason(version: number, reason?: string): string {
  const base = `restored version ${String(version)}`;
  return reason === undefined ? base : `${base}: ${reason}`;
}

/**
 * Restores version `version` of the organization's record as its next
 * version, after today's checks (module header). `change` is the
 * `updateRecord` input without the record: `expectedVersion` (the version
 * the person was looking at), `actor` and an optional `reason`, stored after
 * `restored version N: `.
 *
 * Refused, storing nothing: `unknown_record` (also another organization's),
 * `unknown_version`, `version_conflict` with `conflict` (T-031),
 * `no_changes` (the version's content is the record as it is now), and the
 * issues of every check the old content no longer passes, at their paths
 * in the record (`fields.<key>`, `parentId` …). Otherwise as `updateRecord`.
 */
export async function restoreVersion(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  version: number,
  change: RecordUpdate,
  options: RestoreOptions = {},
): Promise<RecordUpdateResult> {
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
  if (!isWholeVersion(version)) {
    return refused(["version"], "invalid_version", "A version is a whole number from 1.");
  }
  const extraChange = keyBeyond(change, CHANGE_KEYS);
  if (extraChange !== undefined) {
    return refused(
      ["change", extraChange],
      "unknown_property",
      "A restore names only expectedVersion, actor and reason.",
    );
  }
  const extraOption = keyBeyond(options, OPTION_KEYS);
  if (extraOption !== undefined) {
    return refused(
      ["options", extraOption],
      "unknown_property",
      "The options are only now, confirmMadePublic and hiddenLinks.",
    );
  }
  const confirm = ownValue(options, "confirmMadePublic");
  if (
    confirm !== undefined &&
    (!Array.isArray(confirm) ||
      confirm.length > MAX_CONFIRMED_FIELDS ||
      !confirm.every((key) => isFieldKey(key)))
  ) {
    return refused(
      ["options", "confirmMadePublic"],
      "invalid_option",
      "This is the list of field keys the person confirmed.",
    );
  }
  const confirmed: ReadonlySet<string> = new Set(confirm ?? []);
  const hidden = ownValue(options, "hiddenLinks");
  if (hidden !== undefined && !(hidden instanceof Set)) {
    return refused(["options", "hiddenLinks"], "invalid_option", "hiddenLinks is a set of IDs.");
  }
  const clock = ownValue(options, "now");
  if (clock !== undefined && !(clock instanceof Date)) {
    return refused(["options", "now"], "invalid_option", "The clock is a Date.");
  }
  const expected = ownValue(change, "expectedVersion");
  if (!isWholeVersion(expected)) {
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
  const storedReason = restoreReason(version, who.value.reason);
  if (storedReason.length > MAX_REASON_LENGTH) {
    return refused(
      ["change", "reason"],
      "invalid_reason",
      `With "restored version N: " in front, the reason must still be at most ${String(MAX_REASON_LENGTH)} characters.`,
    );
  }
  const now = clock ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return refused(["now"], "invalid_time", "The clock gave an invalid time.");
  }

  const result = await inSavepoint(db, "restore", async (): Promise<RecordUpdateResult> => {
    // The arrangement lock below relies on each statement seeing what
    // committed while it waited (D-061, D-065): Read Committed only.
    await db.execute(sql`SELECT public.arrangement_require_read_committed()`);
    // Decided up front, from the version and the row as they are: if the
    // restore files the unit elsewhere or changes its level, the
    // organization's arrangement lock is taken BEFORE the record row's lock
    // (D-065), and held to COMMIT (the database's guard takes the same lock).
    const [seen] = await db.rows<{
      version: number;
      parent_id: string | null;
      level: string | null;
    }>(sql`
      SELECT version, parent_id::text AS parent_id, level FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
    if (seen === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (seen.version !== expected) return conflictRefusal(expected, seen.version);
    const old = await readVersion(db, organizationId, recordId, version);
    if (old === undefined) {
      return refused(["version"], "unknown_version", "The record has no such version.");
    }
    if (!old.ok) return { ok: false, issues: fixedMessages(old.issues, ["version"]) };
    const was = old.value.record;
    if (
      was.kind === "archival_unit" &&
      ((was.parentId ?? null) !== seen.parent_id || was.level !== seen.level)
    ) {
      await db.execute(sql`SELECT public.arrangement_lock(${organizationId}::uuid)`);
    }
    // Then the row: the record and its identifiers (whose save takes the same
    // lock) can't change between the checks and the write. Its version is
    // still the expected one only if nothing was written since `seen`, so the
    // decision above still holds.
    const [locked] = await db.rows<{ version: number }>(sql`
      SELECT version FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid
      FOR NO KEY UPDATE`);
    if (locked === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (locked.version !== expected) return conflictRefusal(expected, locked.version);
    const current = await readStoredRecord(db, organizationId, recordId);
    if (current === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (!current.ok) return { ok: false, issues: fixedMessages(current.issues, []) };
    const stored = current.value.record;
    const candidate = {
      ...old.value.record,
      updatedAt: later(stored.updatedAt, now.toISOString()),
    } as CatalogRecord;
    const compared = compareRecords(stored, candidate);
    if (!compared.ok) return { ok: false, issues: fixedMessages(compared.issues, []) };
    if (compared.value.differences.length === 0) {
      return refused(
        ["version"],
        "no_changes",
        `Version ${String(version)} is the same as the record is now; there is nothing to restore.`,
      );
    }
    const problems = await recordCheckIssues(db, candidate, stored, {
      messages: "fixed",
      confirmedPublic: confirmed,
      identifierFields: true,
      ...(hidden === undefined ? {} : { hiddenLinks: hidden as ReadonlySet<RecordId> }),
    });
    if (problems.length > 0) return { ok: false, issues: problems };
    return updateRecord(db, candidate, {
      expectedVersion: expected,
      actor: who.value.actor,
      reason: storedReason,
    });
  });
  // A conflict found by the lock above (updateRecord's own carry theirs).
  if (
    result.ok ||
    "conflict" in result ||
    !result.issues.some((i) => i.code === "version_conflict")
  ) {
    return result;
  }
  const conflict = await versionConflict(db, organizationId, recordId, expected);
  return conflict === undefined ? result : { ...result, conflict };
}

function conflictRefusal(expected: number, now: number): RecordUpdateResult {
  return refused(
    ["expectedVersion"],
    "version_conflict",
    `The record was saved by someone else since version ${String(expected)}; it is now at version ${String(now)}. Read it again.`,
  );
}

function isWholeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value < 2 ** 31 - 1;
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

/** The later of two times in core's form. */
function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
