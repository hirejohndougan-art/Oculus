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
 * It also runs the public output's template check on the public values
 * (`publicTemplateIssues`, S-026, D-091), so a record `readPublicRecord`
 * would refuse, such as one showing a number that no longer fits its
 * type's changed format, fails the publish check too.
 * The service runs it before publishing and after every write of a
 * published record (an edit, a restore, an identifier change), refusing the
 * write when it fails.
 *
 * `readPublicRecord` is the public output (D-016) of one record on one
 * public site, for public sites, APIs and OAI-PMH (T-050): the record and
 * everything `publicOutput` compares it with are read in one Repeatable
 * Read, read-only transaction, through the database function
 * `public_record_snapshot` (0017, S-019, D-080), which answers only for a
 * record public on that site (published, with the site as its home site)
 * and needs no table privilege, so public sites connect with a role that
 * can read no table. Which linked records count as public comes from the
 * stored states and sites in that same snapshot, never from a caller
 * (replacing D-016's `published` option for every caller outside core). A
 * record that isn't public on the site, doesn't exist or is another
 * organization's gets one and the same answer (`not_available`), and links
 * to records that aren't public on the site go out as nothing at all
 * (D-045).
 */
import {
  applyWorkflowAction,
  effectivePublishIssues,
  effectiveRecord,
  indexAccessionHolds,
  indexRecords,
  isOrganizationId,
  isRecordId,
  isSiteId,
  isWorkflowAction,
  isWorkflowState,
  issue,
  makeIdentifierChecker,
  makeRecordLinkChecker,
  publicOutput,
  publicTemplateIssues,
  publicView,
  type PublicRecord,
  validateRecord,
  type AccessionHold,
  type CatalogRecord,
  type DublinCoreMapping,
  type FieldValueChecker,
  type FieldTemplate,
  type IdentifierType,
  type Issue,
  type OrganizationId,
  type PublicOutput,
  type RecordId,
  type RecordIdentifiers,
  type SiteId,
  type Validated,
  type WorkflowAction,
  type WorkflowState,
} from "@oculus/core";
import {
  inSavepoint,
  readRecordClosure,
  readStoredRecord,
  readTemplate,
  recordFromRow,
  storedTemplate,
  versionConflict,
  type RecordRow,
  type RecordUpdate,
  type StoredTemplate,
  type VersionConflict,
} from "./catalog.js";
import type { Database, Queryable } from "./client.js";
import {
  checkTypes,
  readIdentifierTypes,
  readRecordIdentifiers,
  recordIdentifiersFromRows,
  type CurrentRow,
  type FormerRow,
  type StoredRecordIdentifiers,
} from "./identifiers.js";
import { holdsFrom, readAccessionHolds } from "./accessions.js";
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

/** A record in a workflow state, as `recordsInState` lists it (staff only). */
export interface StateListEntry {
  readonly id: RecordId;
  readonly kind: string;
  readonly title: string;
  readonly siteId: SiteId | null;
  /** The record's version now: a move needs it as `expectedVersion`. */
  readonly version: number;
  readonly updatedAt: string;
}

export const MAX_STATE_LIST_LIMIT = 200;

/**
 * The organization's records in `state` (T-043's approval queue: records
 * sent for review), ordered by ID, `limit` (1 to 200) at a time after the
 * ID `after`, on the given home sites only (`"all"`: every record, records
 * on no site included). Staff only: titles of unpublished records. The
 * site filter is in the query, so neither the page nor its length says
 * anything about records on other sites. `truncated`: there are more.
 */
export async function recordsInState(
  db: Queryable,
  organizationId: OrganizationId,
  state: WorkflowState,
  options: {
    readonly sites: "all" | readonly SiteId[];
    /**
     * Scoped grants that also reach records (T-063): a record in `unit`'s
     * subtree (core's rule: the unit, units filed below it, digital assets
     * standing for one of those) whose home site is `siteId`, or any site
     * for `null`. Never a record on no site.
     */
    readonly scopes?: readonly { readonly siteId: SiteId | null; readonly unit: RecordId }[];
    readonly after?: RecordId;
    readonly limit: number;
  },
): Promise<
  Validated<{ readonly records: readonly StateListEntry[]; readonly truncated: boolean }>
> {
  if (!isOrganizationId(organizationId)) {
    return {
      ok: false,
      issues: [issue(["organizationId"], "invalid_organization", "Not an organization ID.")],
    };
  }
  if (!isWorkflowState(state)) {
    return { ok: false, issues: [issue(["state"], "invalid_state", "Not a workflow state.")] };
  }
  const { sites, after, limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STATE_LIST_LIMIT) {
    return { ok: false, issues: [issue(["limit"], "invalid_limit", "The limit is 1 to 200.")] };
  }
  if (after !== undefined && !isRecordId(after)) {
    return { ok: false, issues: [issue(["after"], "invalid_id", "Not a record ID.")] };
  }
  if (sites !== "all" && !sites.every((site) => isSiteId(site))) {
    return { ok: false, issues: [issue(["sites"], "invalid_sites", "Not a list of site IDs.")] };
  }
  const scopes = options.scopes ?? [];
  if (!scopes.every((g) => isRecordId(g.unit) && (g.siteId === null || isSiteId(g.siteId)))) {
    return { ok: false, issues: [issue(["scopes"], "invalid_scopes", "Not a list of scopes.")] };
  }
  const all = sites === "all";
  const scoped = !all && scopes.length > 0;
  const rows = await db.rows<{
    id: RecordId;
    kind: string;
    title: string;
    site_id: SiteId | null;
    version: number;
    updated_at: string;
  }>(sql`
    WITH RECURSIVE scope(unit, site) AS (
      SELECT * FROM unnest(${scopes.map((g) => g.unit)}::uuid[],
                           ${scopes.map((g) => g.siteId)}::uuid[])
    ),
    -- Every record in each scope's subtree, as core's coveredBy reads it
    -- from below (permissions.ts unitsFrom, mirrored): the unit, units filed
    -- under it at most 70 levels down, and digital assets standing for one
    -- of those through at most 8 assets in between (70 and 8 are
    -- unitsHolding's walk limits). With the scope's site.
    covered(id, kind, site, dist, hops) AS (
      SELECT r.id, r.kind, scope.site, 0, 0
      FROM scope JOIN public.records r
        ON r.organization_id = ${organizationId}::uuid AND r.id = scope.unit
      WHERE ${scoped}::boolean AND r.kind = 'archival_unit'
      UNION
      SELECT r.id, r.kind, c.site,
             CASE WHEN r.kind = 'archival_unit' THEN c.dist + 1 ELSE c.dist END,
             CASE WHEN r.kind = 'archival_unit' THEN 0 ELSE c.hops + 1 END
      FROM covered c JOIN public.records r ON r.organization_id = ${organizationId}::uuid
      WHERE (c.kind = 'archival_unit' AND r.kind = 'archival_unit' AND r.parent_id = c.id
             AND c.dist < 70)
         OR (r.kind = 'digital_asset' AND r.represents_id = c.id
             AND ((c.kind = 'archival_unit' AND c.dist < 70)
                  OR (c.kind = 'digital_asset' AND c.hops < 9)))
    )
    SELECT id::text AS id, kind, title, site_id::text AS site_id, version,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM public.records rec
    WHERE organization_id = ${organizationId}::uuid
      AND workflow_state = ${state}
      AND (${all}::boolean
           OR site_id = ANY(${all ? [] : [...sites]}::uuid[])
           OR (site_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM covered c
                 WHERE c.id = rec.id AND (c.site IS NULL OR c.site = rec.site_id))))
      AND (${after ?? null}::uuid IS NULL OR id > ${after ?? null}::uuid)
    ORDER BY id
    LIMIT ${limit + 1}::integer`);
  return {
    ok: true,
    value: Object.freeze({
      records: Object.freeze(
        rows.slice(0, limit).map((r) =>
          Object.freeze({
            id: r.id,
            kind: r.kind,
            title: r.title,
            siteId: r.site_id,
            version: r.version,
            updatedAt: r.updated_at,
          }),
        ),
      ),
      truncated: rows.length > limit,
    }),
  };
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
 * Where a snapshot's parts come from: the tables, in the caller's
 * transaction (the publish check; `tableSource`), or one row of
 * `public.public_record_snapshot` (the public output, S-019;
 * `publicSource`). The snapshot is built the same way from either.
 */
interface SnapshotSource {
  /** The records `ids` lead to through parents and represented records, by ID; undefined if too many. */
  closure(ids: readonly RecordId[]): Promise<Record<string, unknown>[] | undefined>;
  template(key: string): Promise<Validated<StoredTemplate> | undefined>;
  types(): Promise<Validated<readonly IdentifierType[]>>;
  identifiers(recordId: RecordId): Promise<StoredRecordIdentifiers | undefined>;
  /** Of `ids`, those public now (published; on the public site, for the public output). */
  published(ids: readonly RecordId[]): Promise<readonly RecordId[]>;
  /** The holds of the accessions that produced any of `ids` (D-114): never their contents. */
  holds(ids: readonly RecordId[]): Promise<readonly AccessionHold[] | undefined>;
}

/** The tables, in the caller's transaction; with `lock`, definitions locked (shared) until COMMIT. */
function tableSource(db: Queryable, org: OrganizationId, lock: boolean): SnapshotSource {
  return {
    closure: (ids) => readRecordClosure(db, org, ids),
    template: async (key) => {
      if (lock) {
        await db.execute(
          sql`SELECT public.definition_lock(${org}::uuid, 'template', ${key}, false)`,
        );
      }
      return readTemplate(db, org, key);
    },
    types: async () => {
      if (lock) {
        await db.rows(sql`
          SELECT 1 FROM public.identifier_types WHERE organization_id = ${org}::uuid
          ORDER BY key COLLATE "C"
          FOR SHARE`);
      }
      return readIdentifierTypes(db, org);
    },
    identifiers: (recordId) => readRecordIdentifiers(db, org, recordId),
    holds: (ids) => readAccessionHolds(db, org, ids, { lock }),
    published: async (ids) =>
      (
        await db.rows<{ id: string }>(sql`
          SELECT id::text AS id FROM public.records
          WHERE organization_id = ${org}::uuid AND workflow_state = 'published'
            AND id = ANY(${[...ids]}::uuid[])
          ORDER BY id`)
      ).map((r) => r.id as RecordId),
  };
}

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
  return buildSnapshot(db, org, recordId, tableSource(db, org, lock));
}

async function buildSnapshot(
  db: Queryable,
  org: OrganizationId,
  recordId: RecordId,
  source: SnapshotSource,
): Promise<Validated<Snapshot>> {
  const chainRows = await source.closure([recordId]);
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
  const linkedRows = await source.closure(linked);
  if (linkedRows === undefined) return refused([], "too_many_records", CANT_CHECK);
  const records = [...chain];
  for (const row of linkedRows) {
    if (chainIds.has(row.id as RecordId)) continue;
    // A linked record that doesn't validate refuses the whole output
    // (fails closed): one bad linked row hides every record that links to it.
    const valid = validateRecord(row);
    if (!valid.ok) return refused(["records"], "unreadable_record", CANT_CHECK);
    records.push(valid.value);
  }

  const keys = [...new Set(records.map((r) => r.templateKey ?? ""))].sort();
  const templates = new Map<string, FieldTemplate>();
  for (const key of keys) {
    const template = await source.template(key);
    if (template?.ok) templates.set(key, template.value.template);
  }
  const types = await source.types();
  if (!types.ok) return refused(["identifierTypes"], "unreadable_types", CANT_CHECK);
  const identifier = makeIdentifierChecker(types.value, org);
  const links = makeRecordLinkChecker(records, org);
  if (!identifier.ok || !links.ok) return refused([], "unreadable_checkers", CANT_CHECK);

  const identifiers: RecordIdentifiers[] = [];
  for (const r of chain) {
    const held = await source.identifiers(r.id);
    if (held === undefined) continue;
    if (!held.ok) return refused(["identifiers"], "unreadable_identifiers", CANT_CHECK);
    identifiers.push(held.value);
  }

  // The organization's own calendar day (T-034e, D-056, D-103), never the
  // server's UTC day: a restriction ends on the organization's day. Read
  // through organization_local_day, which the public reader may run too.
  // The holds of stored accessions (T-018c, D-114): only their deed
  // status, access restriction and which of these records they produced.
  const [day] = await db.rows<{ today: string | null }>(
    sql`SELECT public.organization_local_day(${org}::uuid) AS today`,
  );
  const today = day?.today ?? "";
  const holds = await source.holds(records.map((r) => r.id));
  // Holds that can't be read refuse, never "none" (D-114).
  if (holds === undefined) return refused(["accessions"], "unreadable_accessions", CANT_CHECK);
  const register = indexAccessionHolds(org, {
    holds,
    records,
    today,
  });
  // An empty day (the stored zone no longer known to PostgreSQL) makes
  // indexAccessionHolds refuse (invalid_today), so this refuses: never a guess.
  if (!register.ok) return refused(["accessions"], "unreadable_accessions", CANT_CHECK);

  return {
    ok: true,
    value: {
      records,
      templateFor: (r) => templates.get(r.templateKey ?? ""),
      checkers: { identifier: identifier.value, record_link: links.value, place: links.value },
      identifiers,
      accessions: register.value,
      published: await source.published(records.map((r) => r.id)),
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
  const blocked = effectivePublishIssues(effective.value, { accessions: s.accessions });
  // The public output's own template check, with the same checkers, so a
  // record it would refuse (a number that no longer fits a changed format:
  // S-026, D-091) fails here too, after every other reason.
  const template = publicTemplateIssues(effective.value, s.checkers);
  return template.length === 0 ? blocked : Object.freeze([...blocked, ...template]);
}

/**
 * What the public is shown of a record now (T-041c, D-094), in the caller's
 * transaction (which should be one REPEATABLE READ snapshot: `sharedItemViews`
 * opens one). `undefined` unless the public could see it: published, on a
 * home site (D-080's `record_public_on_site`), and passing the publish check
 * public output runs (`effectivePublishIssues`: identifiers, rights, misfit
 * values, deeds and access restrictions). Then `publicView` of its
 * effective record: inherited public values in; staff-only fields,
 * `record_link` values and labels, rights notes, place record IDs and
 * non-public identifiers out. (Which public fields a site's Dublin Core
 * mapping puts out is the public page's business, T-050b.)
 */
export async function publishedRecordView(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<PublicRecord | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const [row] = await db.rows<{ public: boolean }>(sql`
    SELECT workflow_state = 'published' AND site_id IS NOT NULL AS public
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  if (row?.public !== true) return undefined;
  const snapshot = await readSnapshot(db, organizationId, recordId, false);
  if (!snapshot.ok) return undefined;
  const s = snapshot.value;
  const index = indexRecords(s.records);
  if (!index.ok) return undefined;
  const effective = effectiveRecord(recordId, index.value, s.templateFor, {
    checkers: s.checkers,
    identifiers: s.identifiers,
  });
  if (!effective.ok) return undefined;
  if (effectivePublishIssues(effective.value, { accessions: s.accessions }).length > 0) {
    return undefined;
  }
  return publicView(effective.value);
}

/** One value a record's public output takes from another record (S-020). */
export interface PublicValueSource {
  /** The field of the record whose value comes from `source`. */
  readonly field: string;
  readonly source: RecordId;
}

/**
 * What the record's public output would show from other records (S-020):
 * for every public value it inherits, the field and the record it comes
 * from (an ancestor, or for a digital asset the record it represents or one
 * of that record's ancestors), and for a digital asset the record it
 * represents (field `""`), read in the caller's transaction as
 * `publishCheckIssues` reads them. Sorted by field, then source.
 * `undefined` if the record or what it depends on can't be read (then the
 * publish check refuses anyway). The service asks that the person may view
 * every source before publishing, and before any write adds a (field,
 * source) pair to a published record's output.
 */
export async function publicValueSources(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: { readonly lock?: boolean } = {},
): Promise<readonly PublicValueSource[] | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const snapshot = await readSnapshot(db, organizationId, recordId, options.lock === true);
  if (!snapshot.ok) return undefined;
  const s = snapshot.value;
  const index = indexRecords(s.records);
  if (!index.ok) return undefined;
  const effective = effectiveRecord(recordId, index.value, s.templateFor, {
    checkers: s.checkers,
    identifiers: s.identifiers,
  });
  if (!effective.ok) return undefined;
  const pairs = new Map<string, PublicValueSource>();
  const add = (field: string, source: RecordId): void => {
    if (source !== recordId) pairs.set(`${field}\u0000${source}`, Object.freeze({ field, source }));
  };
  for (const entry of effective.value.entries) {
    if (!entry.own && entry.inTemplate && entry.visibility === "public") {
      add(entry.key, entry.from.id);
    }
  }
  const record = effective.value.record;
  if (record.kind === "digital_asset" && record.represents !== undefined) {
    add("", record.represents);
  }
  return [...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/** One value a record takes from a record above it, as the editor shows it (T-046). */
export interface InheritedValue {
  /** The field of the record. */
  readonly key: string;
  readonly value: unknown;
  /** The record above it that holds the value. */
  readonly from: RecordId;
}

/**
 * STAFF ONLY. The values the record inherits now (D-013's effective record:
 * fields it has no value of its own for, from the units above it), with
 * the record each comes from and the IDs of every record above it
 * (`chain`, so the caller can refuse to show anything when one of them is
 * out of the person's sight). Read in the caller's transaction without
 * locks, as `publicValueSources` reads them; `undefined` when the record or
 * anything above it can't be read (then the editor shows no inherited
 * values). Staff values are included: the admin shows them to staff.
 */
export async function inheritedValues(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<
  { readonly values: readonly InheritedValue[]; readonly chain: readonly RecordId[] } | undefined
> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const snapshot = await readSnapshot(db, organizationId, recordId, false);
  if (!snapshot.ok) return undefined;
  const s = snapshot.value;
  const index = indexRecords(s.records);
  if (!index.ok) return undefined;
  const effective = effectiveRecord(recordId, index.value, s.templateFor, {
    checkers: s.checkers,
    identifiers: s.identifiers,
  });
  if (!effective.ok) return undefined;
  const values = effective.value.entries
    .filter((entry) => !entry.own && entry.inTemplate && entry.from.id !== recordId)
    .map((entry) => Object.freeze({ key: entry.key, value: entry.value, from: entry.from.id }));
  return Object.freeze({
    values: Object.freeze(values),
    chain: Object.freeze(
      effective.value.chain.map((step) => step.id).filter((id) => id !== recordId),
    ),
  });
}

/**
 * The records whose public output can depend on the record (S-020): every
 * record below it (units filed under it, at any depth) and every digital
 * asset representing it or one of those, with whether each is published
 * now. Read without locks, in the caller's transaction; the record itself
 * is not listed.
 */
export async function recordDependents(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<readonly { readonly id: RecordId; readonly published: boolean }[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return [];
  const rows = await db.rows<{ id: string; published: boolean }>(sql`
    WITH RECURSIVE down(id) AS (
      SELECT ${recordId}::uuid
      UNION
      SELECT r.id FROM public.records r
      JOIN down ON r.organization_id = ${organizationId}::uuid
               AND (r.parent_id = down.id OR r.represents_id = down.id)
    )
    SELECT r.id::text AS id, r.workflow_state = 'published' AS published
    FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid AND r.id IN (SELECT id FROM down)
      AND r.id <> ${recordId}::uuid
    ORDER BY r.id`);
  return rows.map((r) => Object.freeze({ id: r.id as RecordId, published: r.published }));
}

/**
 * The IDs of `ids` and every record above them (parents, represented
 * records, their parents …), sorted; `undefined` past `MAX_CLOSURE_RECORDS`.
 * Read without locks, in the caller's transaction (S-020).
 */
export async function recordClosureIds(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<readonly RecordId[] | undefined> {
  if (!isOrganizationId(organizationId) || !ids.every((id) => isRecordId(id))) return undefined;
  const rows = await readRecordClosure(db, organizationId, ids);
  return rows?.map((r) => r.id as RecordId).sort();
}

/**
 * Locks the organization's records `ids` `FOR SHARE`, in ID order, in one
 * statement (S-020): none of them can then be changed, moved or have its
 * state changed (which take `FOR NO KEY UPDATE`) before COMMIT. Returns the
 * IDs it locked (those that exist).
 */
export async function lockRecordsShared(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<readonly RecordId[]> {
  if (ids.length === 0 || !isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ANY(${[...ids]}::uuid[])
    ORDER BY id
    FOR SHARE`);
  return rows.map((r) => r.id as RecordId);
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
   * it against the template and the organization (D-047). Left out: the
   * template's stored mapping (T-050b, D-096), read in the same snapshot
   * through `public_dublin_core_mapping`, which the public reader may call.
   */
  readonly mappings?: readonly DublinCoreMapping[];
  /**
   * The `statement_timeout` (milliseconds) each of the read's statements
   * runs under (S-037), so one slow snapshot can't hold a public reader
   * connection as long as it takes: past it the read throws (SQLSTATE
   * 57014, `isDatabaseTimeout`). A read is three statements that can take
   * time (the snapshot, the organization's local day and the mapping), so
   * its database work is about three times this at most. Default `PUBLIC_READ_TIME_LIMIT_MS`; a whole number
   * from 1 to `MAX_PUBLIC_READ_TIME_LIMIT_MS`.
   */
  readonly timeLimitMs?: number;
}

/** `readPublicRecord`'s default time limit per statement (S-037). */
export const PUBLIC_READ_TIME_LIMIT_MS = 5_000;
/** The largest time limit `readPublicRecord` takes. */
export const MAX_PUBLIC_READ_TIME_LIMIT_MS = 60_000;

/** The answer for a record that isn't published, doesn't exist or is another organization's. */
const NOT_AVAILABLE: readonly Issue[] = Object.freeze([
  Object.freeze(issue([], "not_available", "This record is not available.")),
]);

/** What `public.public_record_snapshot` returns (migration 0017, S-019). */
interface PublicSnapshotRow {
  readonly tooMany?: boolean;
  readonly records?: readonly RecordRow[] | null;
  readonly public?: readonly string[] | null;
  readonly templates?: readonly { key: string; version: number; definition: unknown }[] | null;
  readonly identifierTypes?: readonly { key: string; definition: unknown }[] | null;
  readonly identifiers?:
    | readonly {
        recordId: string;
        current: readonly CurrentRow[] | null;
        former: readonly FormerRow[] | null;
      }[]
    | null;
  /** The holds of the accessions behind these records (migration 0046, D-114). */
  readonly accessionHolds?: unknown;
}

/**
 * A snapshot source over one row of `public_record_snapshot`: the records
 * a public record's output depends on and nothing else (S-019). Closures
 * are walked over those rows only, so nothing outside them can be reached.
 */
function publicSource(org: OrganizationId, row: PublicSnapshotRow): SnapshotSource {
  const rows = new Map((row.records ?? []).map((r) => [r.id, r] as const));
  const publicIds = new Set(row.public ?? []);
  const templates = new Map((row.templates ?? []).map((t) => [t.key, t] as const));
  const typeRows = row.identifierTypes ?? [];
  const held = new Map((row.identifiers ?? []).map((i) => [i.recordId, i] as const));
  return {
    closure: (ids) => {
      const seen = new Map<string, RecordRow>();
      const todo: string[] = [...ids];
      for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
        const r = rows.get(id);
        if (r === undefined || seen.has(id)) continue;
        seen.set(id, r);
        for (const next of [r.parent_id, r.represents_id]) if (next !== null) todo.push(next);
      }
      return Promise.resolve(
        [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => recordFromRow(r)),
      );
    },
    template: (key) => {
      const t = templates.get(key);
      return Promise.resolve(
        t === undefined ? undefined : storedTemplate(t.version, t.definition, org, key),
      );
    },
    types: () => Promise.resolve(checkTypes(typeRows, org)),
    identifiers: (recordId) => {
      const i = held.get(recordId);
      return Promise.resolve(
        i === undefined
          ? undefined
          : recordIdentifiersFromRows(org, recordId, i.current ?? [], i.former ?? [], typeRows),
      );
    },
    published: (ids) => Promise.resolve(ids.filter((id) => publicIds.has(id))),
    // Computed by public_record_snapshot for exactly the records it returns.
    holds: () => Promise.resolve(holdsFrom(row.accessionHolds)),
  };
}

/**
 * The public output (D-016) of the organization's record on one of its
 * public sites (S-019), if it is public there now (see the module header):
 * published, and its home site is `siteId` (records shared into a site
 * come with T-041b, through the database's `record_public_on_site`).
 * Records on no site are never public. Links and places resolve only to
 * records public on the same site; anything else goes out as nothing
 * (D-045, D-048).
 *
 * Everything is read through the database functions
 * `public_record_snapshot` (SECURITY DEFINER, migration 0017) and, when no
 * `mappings` are given, `public_dublin_core_mapping` (0022, D-096), in one
 * Repeatable Read, read-only transaction, so the state, the records, the
 * templates, the identifiers and the mapping all come from one moment, and the
 * connection needs no table privilege at all: use a role made by
 * `grantPublicReaderRole` and checked by `checkPublicReaderConnection`
 * (roles.ts). It writes nothing.
 *
 * Refused with exactly `not_available` for a record that isn't published,
 * isn't the site's, doesn't exist or belongs to another organization, and
 * for a site that isn't the organization's, so a public caller can't tell
 * them apart. Any other issue is staff only (D-016, S-007): a public site
 * shows the record as not available and never passes issues (or
 * `staffWarnings`) on.
 */
export async function readPublicRecord(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  recordId: RecordId,
  options: PublicRecordOptions,
): Promise<Validated<PublicOutput>> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(recordId)) {
    return { ok: false, issues: NOT_AVAILABLE };
  }
  const baseUrl = ownValue(options, "baseUrl");
  const mappings = ownValue(options, "mappings");
  const givenLimit = ownValue(options, "timeLimitMs");
  const timeLimitMs = givenLimit === undefined ? PUBLIC_READ_TIME_LIMIT_MS : givenLimit;
  if (typeof baseUrl !== "string" || (mappings !== undefined && !Array.isArray(mappings))) {
    return refused([], "invalid_options", "Give { baseUrl, mappings?, timeLimitMs? }.");
  }
  if (
    typeof timeLimitMs !== "number" ||
    !Number.isInteger(timeLimitMs) ||
    timeLimitMs < 1 ||
    timeLimitMs > MAX_PUBLIC_READ_TIME_LIMIT_MS
  ) {
    return refused(
      ["timeLimitMs"],
      "invalid_options",
      `timeLimitMs must be a whole number from 1 to ${String(MAX_PUBLIC_READ_TIME_LIMIT_MS)}.`,
    );
  }
  return db.transaction(async (tx) => {
    // One snapshot for every read below, and nothing written.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    // S-037: each statement below may take at most this long (local to the
    // transaction, so the pooled connection keeps its own setting after).
    await tx.execute(
      sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeLimitMs)}, true)`,
    );
    const read = await publicRecordIn(
      tx,
      organizationId,
      siteId,
      recordId,
      baseUrl,
      mappings as readonly unknown[] | undefined,
    );
    return read.ok ? { ok: true, value: read.value.output } : read;
  });
}

/** Where a shared item lives (T-041f, D-111): its home organization and site, by ID and name. */
export interface SharedHome {
  readonly organizationId: OrganizationId;
  readonly siteId: SiteId;
  readonly organizationName: string;
  readonly siteName: string;
}

/** A shared item's public output on a second site, and where it comes from. */
export interface SharedPublicRecord {
  readonly output: PublicOutput;
  readonly home: SharedHome;
}

/** How a public site asks for a shared item's output (`readSharedPublicRecord`). */
export interface SharedPublicRecordOptions {
  /**
   * The URL the item's home site publishes records under, ending in `/`:
   * the item's own URL and its links are its home site's (one identity per
   * record, D-111). Called once, with the home organization and site.
   */
  readonly baseUrlFor: (home: SharedHome) => string;
  /** As `PublicRecordOptions.timeLimitMs` (S-037): each statement's time limit. */
  readonly timeLimitMs?: number;
}

/**
 * The public output (D-016) of a record accepted into one of the
 * organization's sites from another site, possibly another organization's
 * (D-074, D-094; T-041f, D-111): exactly what the record's home site
 * shows the public (`readPublicRecord` for the home organization and site,
 * its stored mapping included), with the home site and organization named.
 * Only while the share is accepted, the record is public on its home site,
 * and it isn't already the site's own item (`shared_record_home`, 0036);
 * otherwise exactly `not_available`, as `readPublicRecord` answers, so a
 * public caller can't tell a shared item that ended from one never shared.
 *
 * Read in one Repeatable Read, read-only transaction (the share and the
 * output from one moment), through SECURITY DEFINER functions only, so the
 * public reader (D-080) needs no table privilege. It writes nothing.
 */
export async function readSharedPublicRecord(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  recordId: RecordId,
  options: SharedPublicRecordOptions,
): Promise<Validated<SharedPublicRecord>> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(recordId)) {
    return { ok: false, issues: NOT_AVAILABLE };
  }
  const baseUrlFor = ownValue(options, "baseUrlFor");
  const givenLimit = ownValue(options, "timeLimitMs");
  const timeLimitMs = givenLimit === undefined ? PUBLIC_READ_TIME_LIMIT_MS : givenLimit;
  if (typeof baseUrlFor !== "function") {
    return refused([], "invalid_options", "Give { baseUrlFor, timeLimitMs? }.");
  }
  if (
    typeof timeLimitMs !== "number" ||
    !Number.isInteger(timeLimitMs) ||
    timeLimitMs < 1 ||
    timeLimitMs > MAX_PUBLIC_READ_TIME_LIMIT_MS
  ) {
    return refused(
      ["timeLimitMs"],
      "invalid_options",
      `timeLimitMs must be a whole number from 1 to ${String(MAX_PUBLIC_READ_TIME_LIMIT_MS)}.`,
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    // S-037: each statement may take at most this long, as readPublicRecord's.
    await tx.execute(
      sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeLimitMs)}, true)`,
    );
    const [found] = await tx.rows<{ home: Record<string, unknown> | null }>(sql`
      SELECT public.shared_record_home(${organizationId}::uuid, ${siteId}::uuid,
                                       ${recordId}::uuid) AS home`);
    const raw = found?.home ?? null;
    if (raw === null) return { ok: false, issues: NOT_AVAILABLE };
    const homeOrg = raw.organizationId;
    const homeSite = raw.siteId;
    const orgName = raw.organizationName;
    const siteName = raw.siteName;
    if (
      !isOrganizationId(homeOrg) ||
      !isSiteId(homeSite) ||
      typeof orgName !== "string" ||
      typeof siteName !== "string"
    ) {
      return { ok: false, issues: NOT_AVAILABLE };
    }
    const home: SharedHome = Object.freeze({
      organizationId: homeOrg,
      siteId: homeSite,
      organizationName: orgName,
      siteName,
    });
    const baseUrl: unknown = (baseUrlFor as (h: SharedHome) => unknown)(home);
    if (typeof baseUrl !== "string") {
      return refused([], "invalid_options", "baseUrlFor must give a URL.");
    }
    const read = await publicRecordIn(tx, homeOrg, homeSite, recordId, baseUrl, undefined);
    if (!read.ok) return read;
    return { ok: true, value: Object.freeze({ output: read.value.output, home }) };
  });
}

/** One record's public output, with the view and template it was made from (`publicRecordIn`). */
export interface PublicRecordRead {
  readonly output: PublicOutput;
  readonly view: PublicRecord;
  readonly template: FieldTemplate;
  readonly mapping: unknown;
}

/**
 * `readPublicRecord`'s work inside the caller's transaction, which must
 * already be Repeatable Read and read only (`publicTermCounts` reads many
 * records in one). Arguments are checked by the caller. Without `mappings`,
 * the record's template's stored mapping is used, read in the same snapshot
 * (T-050b). Not exported from `@oculus/db`.
 */
export async function publicRecordIn(
  tx: Queryable,
  organizationId: OrganizationId,
  siteId: SiteId,
  recordId: RecordId,
  baseUrl: string,
  mappings: readonly unknown[] | undefined,
): Promise<Validated<PublicRecordRead>> {
  const [found] = await tx.rows<{ snapshot: PublicSnapshotRow | null }>(sql`
    SELECT public.public_record_snapshot(${organizationId}::uuid, ${siteId}::uuid,
                                         ${recordId}::uuid) AS snapshot`);
  const row = found?.snapshot ?? null;
  if (row === null) return { ok: false, issues: NOT_AVAILABLE };
  if (row.tooMany === true) return refused([], "too_many_records", CANT_CHECK);
  const snapshot = await buildSnapshot(
    tx,
    organizationId,
    recordId,
    publicSource(organizationId, row),
  );
  if (!snapshot.ok) return snapshot;
  const s = snapshot.value;
  // The record itself is public on the site (checked by the function, in this snapshot).
  if (!s.published.includes(recordId)) return { ok: false, issues: NOT_AVAILABLE };
  const record = s.records.find((r) => r.id === recordId);
  if (record === undefined) return { ok: false, issues: NOT_AVAILABLE };
  const template = s.templateFor(record);
  if (template === undefined) return refused([], "unreadable_record", CANT_CHECK);
  const index = indexRecords(s.records);
  if (!index.ok) return refused(["records"], "unreadable_record", CANT_CHECK);
  const effective = effectiveRecord(recordId, index.value, s.templateFor, {
    checkers: s.checkers,
    identifiers: s.identifiers,
  });
  if (!effective.ok) return refused([], "unreadable_record", CANT_CHECK);
  const view = publicView(effective.value);
  if (view === undefined) return refused([], "unreadable_record", CANT_CHECK);
  let mapping: unknown;
  if (mappings === undefined) {
    // The stored one, from the same snapshot (Repeatable Read, the caller's).
    const [stored] = await tx.rows<{ mapping: unknown }>(sql`
      SELECT public.public_dublin_core_mapping(${organizationId}::uuid, ${siteId}::uuid,
                                               ${recordId}::uuid) AS mapping`);
    mapping = stored?.mapping ?? undefined;
    if (mapping === null) mapping = undefined;
  } else {
    mapping = mappings.find((m) => ownValue(m, "template") === record.templateKey);
  }
  if (mapping === undefined) {
    return refused(
      ["mappings"],
      "no_mapping",
      "No Dublin Core mapping is given for this record's template.",
    );
  }
  const output = publicOutput(view, mapping, {
    baseUrl,
    published: s.published,
    records: index.value,
    templateFor: s.templateFor,
    checkers: s.checkers,
    identifiers: s.identifiers,
    accessions: s.accessions,
  });
  if (!output.ok) return output;
  return { ok: true, value: Object.freeze({ output: output.value, view, template, mapping }) };
}
