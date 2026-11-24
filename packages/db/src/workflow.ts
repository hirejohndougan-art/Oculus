/**
 * Workflow states in the database (T-034b, T-034c, D-076, on D-075's states
 * and moves in core's `workflow.ts`).
 *
 * Every record has a stored state (`records.workflow_state`, migration
 * 0012): `draft`, `ready_for_review`, `published` or `withdrawn`. It
 * changes only through `changeWorkflowState`, as the record's next version
 * (`record_versions.action` is the workflow action, `workflow_state` the
 * state after it), so history says who published or withdrew a record, when
 * and why. The database refuses any other change of state, by any writer
 * (0012's version check).
 *
 * `publishCheckIssues` is core's publish check (`effectivePublishIssues`,
 * D-013, with the deed and access-restriction register, D-043, D-056) run on
 * the record as it is now, with everything it needs read in the caller's
 * transaction, never handed in (D-054): the record's ancestry and
 * represented records, the records its values link to, the templates of all
 * of them, the organization's identifier types and the record's identifiers.
 * The service runs it before publishing and after every write of a
 * published record (an edit, a restore, an identifier change), refusing the
 * write when it fails.
 *
 * `readPublicRecord` is the public output (D-016) of one record, for public
 * sites, APIs and OAI-PMH (T-050): the record and everything `publicOutput`
 * compares it with are read in one Repeatable Read, read-only transaction,
 * and the list of published records comes from the stored states in that
 * same snapshot, never from a caller (replacing D-016's `published` option
 * for every caller outside core). A record that isn't published, doesn't
 * exist or is another organization's gets one and the same answer
 * (`not_available`), and links to records that aren't published go out as
 * nothing at all (D-045).
 */
import {
  applyWorkflowAction,
  effectivePublishIssues,
  effectiveRecord,
  indexAccessions,
  indexRecords,
  isOrganizationId,
  isRecordId,
  isWorkflowAction,
  isWorkflowState,
  issue,
  makeIdentifierChecker,
  makeRecordLinkChecker,
  publicOutput,
  publicView,
  validateRecord,
  type CatalogRecord,
  type DublinCoreMapping,
  type FieldValueChecker,
  type FieldTemplate,
  type Issue,
  type OrganizationId,
  type PublicOutput,
  type RecordId,
  type RecordIdentifiers,
  type Validated,
  type WorkflowAction,
  type WorkflowState,
} from "@oculus/core";
import {
  inSavepoint,
  readRecordClosure,
  readStoredRecord,
  readTemplate,
  versionConflict,
  type RecordUpdate,
  type VersionConflict,
} from "./catalog.js";
import type { Database, Queryable } from "./client.js";
import { readIdentifierTypes, readRecordIdentifiers } from "./identifiers.js";
import { linkedIds } from "./record-checks.js";
import { validateRecordChange, writeVersion, type RecordVersion } from "./record-versions.js";
import { sql } from "./sql.js";

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
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

/** The first own key not in `allowed` (or one that can't be read), if any. */
function keyBeyond(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof value !== "object" || value === null) return "(not an object)";
  try {
    const key = Reflect.ownKeys(value).find((k) => typeof k !== "string" || !allowed.has(k));
    return key === undefined ? undefined : String(key);
  } catch {
    return "(unreadable)";
  }
}

const CHANGE_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "actor", "reason"]);
const NO_RECORD = "The organization has no such record.";

/**
 * The organization's record's workflow state and version as now committed
 * (no lock), or `undefined` if it has no such record (including when
 * another organization has). Staff only: the admin shows it.
 */
export async function readWorkflowState(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<{ readonly state: WorkflowState; readonly version: number } | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const [row] = await db.rows<{ workflow_state: string; version: number }>(sql`
    SELECT workflow_state, version FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  if (row === undefined || !isWorkflowState(row.workflow_state)) return undefined;
  return Object.freeze({ state: row.workflow_state, version: row.version });
}

/** What a change of state returns: the version it wrote, or why not. */
export type WorkflowChangeResult =
  | { readonly ok: true; readonly value: RecordVersion }
  | { readonly ok: false; readonly issues: readonly Issue[]; readonly conflict?: VersionConflict };

/**
 * Moves the organization's record along one of D-075's moves (`action`)
 * and stores the move as the record's next version, together: both or
 * neither. The record must still be at `expectedVersion`, the version the
 * person was looking at (`version_conflict` otherwise, with what changed
 * since). The record's content doesn't change: the version holds it as it
 * is. Refused: `invalid_action`; `unknown_record`; `workflow_move` when the
 * action can't be taken from the record's state (core's issue code, e.g.
 * publishing a published record is `action_not_allowed`); `retry`.
 *
 * **This checks only the move.** Whether the record may be published
 * (`publishCheckIssues`) and whether the person may take the action are
 * the service's (T-034b, T-041), in the same transaction, before calling
 * this. The record's row is locked here (`FOR NO KEY UPDATE`, as an edit
 * locks it), so an edit and a change of state never run at once.
 *
 * As `updateRecord`, the organization is trusted as given: the service
 * passes the session's. Runs in a savepoint of the caller's transaction.
 */
export async function changeWorkflowState(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  action: WorkflowAction,
  change: RecordUpdate,
): Promise<WorkflowChangeResult> {
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
  if (!isWorkflowAction(action)) {
    return refused(
      ["action"],
      "invalid_action",
      "The action is submit_for_review, return_to_draft, publish or withdraw.",
    );
  }
  const extra = keyBeyond(change, CHANGE_KEYS);
  if (extra !== undefined) {
    return refused(
      ["change", extra],
      "unknown_property",
      "A change of state names only expectedVersion, actor and reason.",
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
  const result = await inSavepoint(db, "workflow", async (): Promise<Validated<RecordVersion>> => {
    const [locked] = await db.rows<{ version: number; workflow_state: string }>(sql`
      SELECT version, workflow_state FROM public.records
      WHERE organization_id = ${org}::uuid AND id = ${recordId}::uuid
      FOR NO KEY UPDATE`);
    if (locked === undefined) return refused(["recordId"], "unknown_record", NO_RECORD);
    if (locked.version !== expected) {
      return refused(
        ["expectedVersion"],
        "version_conflict",
        `The record was saved by someone else since version ${String(expected)}; it is now at version ${String(locked.version)}. Read it again.`,
      );
    }
    const move = applyWorkflowAction(locked.workflow_state, action);
    if (!move.ok) {
      return {
        ok: false,
        issues: move.issues.map((i) => issue(["workflowState"], i.code, i.message)),
      };
    }
    const stored = await readStoredRecord(db, org, recordId);
    if (stored === undefined) return refused(["recordId"], "unknown_record", NO_RECORD);
    if (!stored.ok) {
      return refused(
        ["recordId"],
        "unreadable_record",
        "The stored record no longer reads as a valid record; it needs repair.",
      );
    }
    const [row] = await db.rows<{ version: number }>(sql`
      UPDATE public.records SET workflow_state = ${move.value.to}, version = version + 1
      WHERE organization_id = ${org}::uuid AND id = ${recordId}::uuid
        AND version = ${expected}::integer
      RETURNING version`);
    if (row === undefined) {
      return refused(
        ["expectedVersion"],
        "version_conflict",
        "The record changed while its state was being changed. Read it again.",
      );
    }
    return {
      ok: true,
      value: await writeVersion(db, stored.value.record, row.version, who.value, action),
    };
  });
  if (result.ok || !result.issues.some((i) => i.code === "version_conflict")) return result;
  const conflict = await versionConflict(db, org, recordId, expected);
  return conflict === undefined ? result : { ...result, conflict };
}

// ---------------------------------------------------------------------------
// What the publish check and the public output read, in one transaction.

/** Everything core's publish check and public output compare a record with, read now. */
interface Snapshot {
  readonly records: readonly CatalogRecord[];
  readonly templateFor: (record: CatalogRecord) => FieldTemplate | undefined;
  readonly checkers: {
    readonly identifier: FieldValueChecker;
    readonly record_link: FieldValueChecker;
    readonly place: FieldValueChecker;
  };
  readonly identifiers: readonly RecordIdentifiers[];
  readonly accessions: unknown;
  /** The IDs of every record in `records` whose state is `published` now. */
  readonly published: readonly RecordId[];
}

const CANT_CHECK = "The record and what it depends on can't be read for the publish check.";

/**
 * Reads, in the caller's transaction, everything the publish check and the
 * public output need for `recordId`: its ancestry and what it represents,
 * the records its values (its own and its ancestors') link to with their
 * ancestry, every one's template (with the shared definition lock when
 * `lock` is set, so none changes before COMMIT), the identifier types, the
 * identifiers of the record and its ancestors, and an accession register.
 * The issues are fixed text: they never quote a record.
 */
async function readSnapshot(
  db: Queryable,
  org: OrganizationId,
  recordId: RecordId,
  lock: boolean,
): Promise<Validated<Snapshot>> {
  const chainRows = await readRecordClosure(db, org, [recordId]);
  if (chainRows === undefined) return refused([], "too_many_records", CANT_CHECK);
  if (!chainRows.some((r) => r.id === recordId)) {
    return refused(["recordId"], "unknown_record", NO_RECORD);
  }
  const chain: CatalogRecord[] = [];
  for (const row of chainRows) {
    const valid = validateRecord(row);
    if (!valid.ok) return refused(["records"], "unreadable_record", CANT_CHECK);
    chain.push(valid.value);
  }
  const chainIds = new Set(chain.map((r) => r.id));
  const linked = [...new Set(chain.flatMap(linkedIds))].filter((id) => !chainIds.has(id));
  const linkedRows = await readRecordClosure(db, org, linked);
  if (linkedRows === undefined) return refused([], "too_many_records", CANT_CHECK);
  const records = [...chain];
  for (const row of linkedRows) {
    if (chainIds.has(row.id as RecordId)) continue;
    // A linked record that doesn't validate is passed on as it is: the link
    // checker marks it unusable, as it does for any invalid record.
    const valid = validateRecord(row);
    if (!valid.ok) return refused(["records"], "unreadable_record", CANT_CHECK);
    records.push(valid.value);
  }

  const keys = [...new Set(records.map((r) => r.templateKey ?? ""))].sort();
  const templates = new Map<string, FieldTemplate>();
  for (const key of keys) {
    if (lock) {
      await db.execute(sql`SELECT public.definition_lock(${org}::uuid, 'template', ${key}, false)`);
    }
    const template = await readTemplate(db, org, key);
    if (template?.ok) templates.set(key, template.value.template);
  }
  if (lock) {
    await db.rows(sql`
      SELECT 1 FROM public.identifier_types WHERE organization_id = ${org}::uuid
      ORDER BY key COLLATE "C"
      FOR SHARE`);
  }
  const types = await readIdentifierTypes(db, org);
  if (!types.ok) return refused(["identifierTypes"], "unreadable_types", CANT_CHECK);
  const identifier = makeIdentifierChecker(types.value, org);
  const links = makeRecordLinkChecker(records, org);
  if (!identifier.ok || !links.ok) return refused([], "unreadable_checkers", CANT_CHECK);

  const identifiers: RecordIdentifiers[] = [];
  for (const r of chain) {
    const held = await readRecordIdentifiers(db, org, r.id);
    if (held === undefined) continue;
    if (!held.ok) return refused(["identifiers"], "unreadable_identifiers", CANT_CHECK);
    identifiers.push(held.value);
  }

  // Accessions are not stored yet (T-018b), so the register holds none and
  // holds nothing back; the day matters only once they are, when T-034e
  // works it out from the organization's time zone (D-056).
  const [day] = await db.rows<{ today: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today`,
  );
  const register = indexAccessions(org, {
    accessions: [],
    records,
    identifierTypes: types.value,
    today: day?.today ?? "",
  });
  if (!register.ok) return refused(["accessions"], "unreadable_accessions", CANT_CHECK);

  const ids = records.map((r) => r.id);
  const publishedRows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.records
    WHERE organization_id = ${org}::uuid AND workflow_state = 'published'
      AND id = ANY(${ids}::uuid[])
    ORDER BY id`);

  return {
    ok: true,
    value: {
      records,
      templateFor: (r) => templates.get(r.templateKey ?? ""),
      checkers: { identifier: identifier.value, record_link: links.value, place: links.value },
      identifiers,
      accessions: register.value,
      published: publishedRows.map((r) => r.id as RecordId),
    },
  };
}

/**
 * Core's publish check on the organization's record as it is now in this
 * transaction (see the module header): empty when it may be published.
 * With `lock`, the templates and identifier types it read are locked
 * (shared) until the transaction ends, so the answer holds until COMMIT;
 * the service passes it. Never throws for a record it can't read: the
 * issues say so in fixed text.
 */
export async function publishCheckIssues(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: { readonly lock?: boolean } = {},
): Promise<readonly Issue[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) {
    return [issue(["recordId"], "unknown_record", NO_RECORD)];
  }
  const snapshot = await readSnapshot(db, organizationId, recordId, options.lock === true);
  if (!snapshot.ok) return snapshot.issues;
  const s = snapshot.value;
  const index = indexRecords(s.records);
  if (!index.ok) return [issue(["records"], "unreadable_record", CANT_CHECK)];
  const effective = effectiveRecord(recordId, index.value, s.templateFor, {
    checkers: s.checkers,
    identifiers: s.identifiers,
  });
  if (!effective.ok) {
    return effective.issues.map((i) =>
      issue(i.path, i.code, "The record or a record above it can't be read for publishing."),
    );
  }
  return effectivePublishIssues(effective.value, { accessions: s.accessions });
}

// ---------------------------------------------------------------------------
// The public output

/** How a public site asks for a record's output. */
export interface PublicRecordOptions {
  /** As `publicOutput`'s: the URL records are published under, ending in `/`. */
  readonly baseUrl: string;
  /**
   * The organization's Dublin Core mappings; the one for the record's
   * template is used. Configuration, not record data: `publicOutput` checks
   * it against the template and the organization (D-047).
   */
  readonly mappings: readonly DublinCoreMapping[];
}

/** The answer for a record that isn't published, doesn't exist or is another organization's. */
const NOT_AVAILABLE: readonly Issue[] = Object.freeze([
  Object.freeze(issue([], "not_available", "This record is not available.")),
]);

/**
 * The public output (D-016) of the organization's record, if it is
 * published now (see the module header). Opens its own Repeatable Read,
 * read-only transaction on `db`, so the state, the records, the templates
 * and the identifiers all come from one moment. Any connection that can
 * read the tables will do; it writes nothing.
 *
 * Refused with exactly `not_available` for a record that isn't published,
 * doesn't exist or belongs to another organization, so a public caller
 * can't tell them apart. Any other issue is staff only (D-016, S-007): a
 * public site shows the record as not available and never passes issues
 * (or `staffWarnings`) on.
 */
export async function readPublicRecord(
  db: Database,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: PublicRecordOptions,
): Promise<Validated<PublicOutput>> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) {
    return { ok: false, issues: NOT_AVAILABLE };
  }
  const baseUrl = ownValue(options, "baseUrl");
  const mappings = ownValue(options, "mappings");
  if (typeof baseUrl !== "string" || !Array.isArray(mappings)) {
    return refused([], "invalid_options", "Give { baseUrl, mappings }.");
  }
  return db.transaction(async (tx) => {
    // One snapshot for every read below, and nothing written.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const [state] = await tx.rows<{ workflow_state: string; template_key: string }>(sql`
      SELECT workflow_state, template_key FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
    if (state?.workflow_state !== "published") {
      return { ok: false, issues: NOT_AVAILABLE };
    }
    const snapshot = await readSnapshot(tx, organizationId, recordId, false);
    if (!snapshot.ok) return snapshot;
    const s = snapshot.value;
    // The record itself is published (checked above, in this snapshot).
    if (!s.published.includes(recordId)) return { ok: false, issues: NOT_AVAILABLE };
    const index = indexRecords(s.records);
    if (!index.ok) return refused(["records"], "unreadable_record", CANT_CHECK);
    const effective = effectiveRecord(recordId, index.value, s.templateFor, {
      checkers: s.checkers,
      identifiers: s.identifiers,
    });
    if (!effective.ok) return refused([], "unreadable_record", CANT_CHECK);
    const view = publicView(effective.value);
    if (view === undefined) return refused([], "unreadable_record", CANT_CHECK);
    const mapping = (mappings as readonly unknown[]).find(
      (m) => ownValue(m, "template") === state.template_key,
    );
    if (mapping === undefined) {
      return refused(
        ["mappings"],
        "no_mapping",
        "No Dublin Core mapping is given for this record's template.",
      );
    }
    return publicOutput(view, mapping, {
      baseUrl,
      published: s.published,
      records: index.value,
      templateFor: s.templateFor,
      checkers: s.checkers,
      identifiers: s.identifiers,
      accessions: s.accessions,
    });
  });
}
