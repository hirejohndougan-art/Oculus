/**
 * Which records the access-holds pass (T-034f, D-120) looks at. The pass
 * itself is the service's (`applyAccessHolds`); this only finds candidates.
 * Every candidate is checked again, one at a time, under its row lock and
 * the organization's holds lock, by the publish check itself: these lists
 * only keep the pass from reading every published record.
 *
 * STAFF ONLY: run on the writer's connection, never the public reader's.
 */
import { isOrganizationId, type OrganizationId, type RecordId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** The most candidates of each kind one pass reads for an organization. */
export const MAX_HOLD_CANDIDATES = 5000;

// One more than the most, so a caller can tell there were more.
const capped = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), MAX_HOLD_CANDIDATES + 1)) : 1;

/** Every organization's ID, in order. */
export async function organizationIds(db: Queryable): Promise<readonly OrganizationId[]> {
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.organizations ORDER BY id`);
  return Object.freeze(rows.map((r) => r.id as OrganizationId));
}

/**
 * Published records an accession might hold back now: those produced by an
 * accession whose deed isn't signed (`missing` or `sent`) or that has an
 * access restriction, the units filed below them and the digital assets
 * representing any of those (as `publishedBelow` walks). Whether a
 * restriction is in force today is left to the publish check. At most
 * `limit` (default `MAX_HOLD_CANDIDATES`; up to one more, so a caller can
 * tell there were more), in ID order.
 */
export async function publishedPerhapsHeld(
  db: Queryable,
  organizationId: OrganizationId,
  limit: number = MAX_HOLD_CANDIDATES,
): Promise<readonly RecordId[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE down(id) AS (
      SELECT ar.record_id
      FROM public.accession_records ar
      JOIN public.accessions a
        ON a.organization_id = ar.organization_id AND a.id = ar.accession_id
      WHERE a.organization_id = ${organizationId}::uuid
        AND (a.deed_status IN ('missing', 'sent') OR a.access_restriction IS NOT NULL)
      UNION
      SELECT r.id FROM public.records r JOIN down ON r.organization_id = ${organizationId}::uuid
        AND (r.parent_id = down.id OR r.represents_id = down.id)
    )
    SELECT r.id::text AS id FROM public.records r JOIN down ON r.id = down.id
    WHERE r.organization_id = ${organizationId}::uuid AND r.workflow_state = 'published'
    ORDER BY r.id
    LIMIT ${capped(limit)}::integer`);
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * Withdrawn records whose newest change of state was a withdrawal by
 * `actor` (the pass's own): the ones it may publish again. A record anyone
 * else withdrew, published, sent for review or returned to draft since is
 * never among them. At most `limit`, in ID order.
 */
export async function withdrawnBy(
  db: Queryable,
  organizationId: OrganizationId,
  actor: string,
  limit: number = MAX_HOLD_CANDIDATES,
): Promise<readonly RecordId[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    SELECT r.id::text AS id FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid AND r.workflow_state = 'withdrawn'
      AND ${actor} = (
        SELECT v.actor FROM public.record_versions v
        WHERE v.organization_id = r.organization_id AND v.record_id = r.id
          AND v.action IN ('submit_for_review', 'return_to_draft', 'publish', 'withdraw')
        ORDER BY v.version DESC
        LIMIT 1)
    ORDER BY r.id
    LIMIT ${capped(limit)}::integer`);
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * Under the record's row lock (`FOR NO KEY UPDATE`, as an edit and a change
 * of state take it): its state and version, and the actor and action of its
 * newest change of state, or `undefined` if the organization has no such
 * record.
 */
export async function lockRecordState(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<
  | {
      readonly state: string;
      readonly version: number;
      readonly lastMoveActor: string | null;
    }
  | undefined
> {
  const [row] = await db.rows<{ workflow_state: string; version: number }>(sql`
    SELECT workflow_state, version FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid
    FOR NO KEY UPDATE`);
  if (row === undefined) return undefined;
  const [move] = await db.rows<{ actor: string }>(sql`
    SELECT actor FROM public.record_versions
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND action IN ('submit_for_review', 'return_to_draft', 'publish', 'withdraw')
    ORDER BY version DESC
    LIMIT 1`);
  return Object.freeze({
    state: row.workflow_state,
    version: row.version,
    lastMoveActor: move?.actor ?? null,
  });
}
