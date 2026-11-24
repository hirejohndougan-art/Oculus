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
 * - a represented record (digital assets) that still exists.
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
 * change between the checks and the write. Templates, types and other
 * records are not locked: a change committed in that instant can slip past
 * the checks, as for any save until the service layer re-checks inside its
 * own transaction (T-032).
 *
 * `updatedAt` becomes the later of the stored one and now (D-063: it never
 * goes backwards); `createdAt`, the ID, the organization and the kind never
 * change, so they are the stored ones anyway. Runs in a savepoint of the
 * caller's transaction (outside one it throws). Everything here is
 * staff-only.
 */
import {
  MAX_ARRANGEMENT_DEPTH,
  canFileUnder,
  checkRecordAgainstTemplate,
  checkRecordType,
  compareRecords,
  identifierFieldIssues,
  isOrganizationId,
  isRecordId,
  issue,
  makeIdentifierChecker,
  makeRecordLinkChecker,
  type ArchivalLevel,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import {
  inSavepoint,
  readRecordType,
  readRecordsForChecks,
  readStoredRecord,
  readTemplate,
  updateRecord,
  versionConflict,
  type RecordUpdate,
  type RecordUpdateResult,
} from "./catalog.js";
import type { Queryable } from "./client.js";
import { readIdentifierTypes, readRecordIdentifiers } from "./identifiers.js";
import { MAX_REASON_LENGTH, readVersion, validateRecordChange } from "./record-versions.js";
import { sql } from "./sql.js";

/** Options for `restoreVersion`. */
export interface RestoreOptions {
  /** The clock, for tests. Default: now. */
  readonly now?: Date;
}

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
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return refused(["now"], "invalid_time", "The clock gave an invalid time.");
  }

  const result = await inSavepoint(db, "update", async (): Promise<RecordUpdateResult> => {
    // Locked first: the record and its identifiers (whose save takes the same
    // lock) can't change between the checks and the write.
    const [locked] = await db.rows<{ version: number }>(sql`
      SELECT version FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid
      FOR NO KEY UPDATE`);
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
    const current = await readStoredRecord(db, organizationId, recordId);
    if (current === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (!current.ok) return current;
    const old = await readVersion(db, organizationId, recordId, version);
    if (old === undefined) {
      return refused(["version"], "unknown_version", "The record has no such version.");
    }
    if (!old.ok) {
      return {
        ok: false,
        issues: old.issues.map((i) => issue(["version", ...i.path], i.code, i.message)),
      };
    }
    const stored = current.value.record;
    const candidate = {
      ...old.value.record,
      updatedAt: later(stored.updatedAt, now.toISOString()),
    } as CatalogRecord;
    const compared = compareRecords(stored, candidate);
    if (!compared.ok) return compared;
    if (compared.value.differences.length === 0) {
      return refused(
        ["version"],
        "no_changes",
        `Version ${String(version)} is the same as the record is now; there is nothing to restore.`,
      );
    }
    const problems = await todaysChecks(db, candidate, stored);
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

function isWholeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value < 2 ** 31 - 1;
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

/** The IDs a record's fields link to (`record_link` and place `recordId` values). */
function linkedIds(record: CatalogRecord): RecordId[] {
  const ids = new Set<RecordId>();
  for (const value of Object.values(record.fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const id = (item as Readonly<Record<string, unknown>>).recordId;
      if (isRecordId(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** Every problem the candidate has against today's rules; empty when it passes. */
async function todaysChecks(
  db: Queryable,
  candidate: CatalogRecord,
  stored: CatalogRecord,
): Promise<Issue[]> {
  const org = candidate.organizationId;
  const problems: Issue[] = [];

  // The records it points at, as they are now (and itself, for self-links).
  const parentId = candidate.kind === "archival_unit" ? candidate.parentId : undefined;
  const represents = candidate.kind === "digital_asset" ? candidate.represents : undefined;
  const wanted = new Set<RecordId>([candidate.id, ...linkedIds(candidate)]);
  if (parentId !== undefined) wanted.add(parentId);
  if (represents !== undefined) wanted.add(represents);
  const others = await readRecordsForChecks(db, org, [...wanted]);
  const found = new Map(others.map((r) => [r.id as string, r]));

  // The template as it is now, with the organization's checkers.
  const template = await readTemplate(db, org, candidate.templateKey ?? "");
  if (template === undefined) {
    problems.push(
      issue(
        ["templateKey"],
        "unknown_template",
        "The template this version used no longer exists.",
      ),
    );
  } else if (!template.ok) {
    problems.push(
      ...template.issues.map((i) => issue(["templateKey", ...i.path], i.code, i.message)),
    );
  } else {
    const types = await readIdentifierTypes(db, org);
    if (!types.ok) return [...types.issues];
    const identifier = makeIdentifierChecker(types.value, org);
    if (!identifier.ok) return [...identifier.issues];
    const links = makeRecordLinkChecker(others, org);
    if (!links.ok) return [...links.issues];
    problems.push(
      ...checkRecordAgainstTemplate(candidate, template.value.template, {
        checkers: { identifier: identifier.value, record_link: links.value, place: links.value },
        allowMissingInherited: candidate.kind === "archival_unit",
      }),
    );
    const held = await readRecordIdentifiers(db, org, candidate.id);
    if (held === undefined) {
      problems.push(issue(["id"], "unknown_record", "The organization has no such record."));
    } else if (!held.ok) {
      problems.push(
        ...held.issues.map((i) => issue(["identifiers", ...i.path], i.code, i.message)),
      );
    } else {
      problems.push(...identifierFieldIssues(candidate, template.value.template, held.value));
    }
  }

  // Its record type as it is now.
  if (candidate.recordTypeKey !== undefined) {
    const type = await readRecordType(db, org, candidate.recordTypeKey);
    if (type === undefined) {
      problems.push(
        issue(
          ["recordTypeKey"],
          "unknown_record_type",
          "The record type this version used no longer exists.",
        ),
      );
    } else if (!type.ok) {
      problems.push(
        ...type.issues.map((i) => issue(["recordTypeKey", ...i.path], i.code, i.message)),
      );
    } else {
      problems.push(...checkRecordType(candidate, type.value.recordType));
    }
  }

  // A represented record that still exists.
  if (represents !== undefined && !found.has(represents)) {
    problems.push(
      issue(
        ["represents"],
        "unknown_record",
        "The record this version represents no longer exists.",
      ),
    );
  }

  // The arrangement, when the parent or the level would change.
  if (candidate.kind === "archival_unit" && stored.kind === "archival_unit") {
    problems.push(...(await arrangementIssues(db, candidate, stored, found)));
  }
  return problems;
}

/** Problems filing the restored unit where the old version had it, as the tree is now. */
async function arrangementIssues(
  db: Queryable,
  unit: CatalogRecord & { kind: "archival_unit" },
  stored: CatalogRecord & { kind: "archival_unit" },
  found: ReadonlyMap<string, Record<string, unknown>>,
): Promise<Issue[]> {
  const org = unit.organizationId;
  const problems: Issue[] = [];
  const parentChanged = unit.parentId !== stored.parentId;
  if (unit.level !== stored.level) {
    // Its children stay where they are: they must still fit under it.
    const children = await db.rows<{ level: ArchivalLevel }>(sql`
      SELECT DISTINCT level FROM public.records
      WHERE organization_id = ${org}::uuid AND parent_id = ${unit.id}::uuid`);
    for (const child of children) {
      if (!canFileUnder(child.level, unit.level)) {
        problems.push(
          issue(
            ["level"],
            "wrong_level",
            `This unit holds a ${child.level} now, which can't be filed under a ${unit.level}.`,
          ),
        );
      }
    }
  }
  if (unit.parentId === undefined || (!parentChanged && unit.level === stored.level)) {
    return problems;
  }
  const parent = found.get(unit.parentId);
  if (parent?.kind !== "archival_unit") {
    problems.push(
      issue(
        ["parentId"],
        "missing_parent",
        "The unit this version was filed under no longer exists, or is no longer an archival unit.",
      ),
    );
    return problems;
  }
  if (!canFileUnder(unit.level, parent.level as ArchivalLevel)) {
    problems.push(
      issue(
        ["parentId"],
        "wrong_level",
        `A ${unit.level} can't be filed under a ${String(parent.level)}.`,
      ),
    );
  }
  if (!parentChanged) return problems;
  // The new parent's ancestors, up to the top or the depth limit, stopping
  // at the unit itself (a loop).
  const up = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 1 FROM public.records
      WHERE organization_id = ${org}::uuid AND id = ${unit.parentId}::uuid
      UNION ALL
      SELECT r.id, r.parent_id, up.depth + 1
      FROM up JOIN public.records r ON r.organization_id = ${org}::uuid AND r.id = up.parent_id
      WHERE up.depth <= ${MAX_ARRANGEMENT_DEPTH}::integer AND up.id <> ${unit.id}::uuid
    )
    SELECT id::text AS id FROM up`);
  if (up.some((row) => row.id === unit.id)) {
    problems.push(
      issue(
        ["parentId"],
        "loop",
        "The unit this version was filed under is now inside this unit, so it would be filed inside itself.",
      ),
    );
    return problems;
  }
  // How far its own descendants go down, to the depth limit.
  const [below] = await db.rows<{ height: number }>(sql`
    WITH RECURSIVE down(id, depth) AS (
      SELECT id, 1 FROM public.records
      WHERE organization_id = ${org}::uuid AND parent_id = ${unit.id}::uuid
      UNION ALL
      SELECT r.id, down.depth + 1
      FROM down JOIN public.records r ON r.organization_id = ${org}::uuid AND r.parent_id = down.id
      WHERE down.depth <= ${MAX_ARRANGEMENT_DEPTH}::integer
    )
    SELECT coalesce(max(depth), 0)::integer AS height FROM down`);
  const deepest = up.length + 1 + (below?.height ?? 0);
  if (deepest > MAX_ARRANGEMENT_DEPTH) {
    problems.push(
      issue(
        ["parentId"],
        "too_deep",
        `Filed there, its tree would be ${String(deepest)} levels deep; the limit is ${String(MAX_ARRANGEMENT_DEPTH)}.`,
      ),
    );
  }
  return problems;
}
