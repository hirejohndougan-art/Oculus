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

/** The most candidates of each kind read in one page. */
export const MAX_HOLD_CANDIDATES = 5000;

const capped = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), MAX_HOLD_CANDIDATES)) : 1;

/** IDs above `after` (a page's last), or all. */
const AFTER_NONE = "00000000-0000-0000-0000-000000000000";

/** Every organization's ID, in order. */
export async function organizationIds(db: Queryable): Promise<readonly OrganizationId[]> {
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.organizations ORDER BY id`);
  return Object.freeze(rows.map((r) => r.id as OrganizationId));
}

/**
 * The organization's day (D-103), or `undefined` when its stored time zone
 * is no longer known to PostgreSQL (the pass then leaves it alone).
 */
export async function organizationDay(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<string | undefined> {
  const [row] = await db.rows<{ today: string | null }>(
    sql`SELECT public.organization_local_day(${organizationId}::uuid) AS today`,
  );
  return row?.today ?? undefined;
}

/**
 * Published records an accession holds back on `today`: those produced by
 * an accession whose deed isn't signed (`missing` or `sent`) or whose access
 * restriction is in force (anything but a `closed_until` whose day has
 * come), the units filed below them and the digital assets representing
 * any of those (as `publishedBelow` walks). One page: at most `limit`
 * (default `MAX_HOLD_CANDIDATES`) with IDs above `after`, in ID order. The
 * publish check decides each one.
 */
export async function publishedPerhapsHeld(
  db: Queryable,
  organizationId: OrganizationId,
  today: string,
  page: { readonly after?: RecordId; readonly limit?: number } = {},
): Promise<readonly RecordId[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE down(id) AS (
      SELECT ar.record_id
      FROM public.accession_records ar
      JOIN public.accessions a
        ON a.organization_id = ar.organization_id AND a.id = ar.accession_id
      WHERE a.organization_id = ${organizationId}::uuid
        AND (a.deed_status IN ('missing', 'sent')
             OR (a.access_restriction IS NOT NULL
                 AND (a.access_restriction ->> 'kind' IS DISTINCT FROM 'closed_until'
                      OR (a.access_restriction ->> 'until') IS NULL
                      OR (a.access_restriction ->> 'until') COLLATE "C" > ${today} COLLATE "C")))
      UNION
      SELECT r.id FROM public.records r JOIN down ON r.organization_id = ${organizationId}::uuid
        AND (r.parent_id = down.id OR r.represents_id = down.id)
    )
    SELECT r.id::text AS id FROM public.records r JOIN down ON r.id = down.id
    WHERE r.organization_id = ${organizationId}::uuid AND r.workflow_state = 'published'
      AND r.id > ${page.after ?? AFTER_NONE}::uuid
    ORDER BY r.id
    LIMIT ${capped(page.limit ?? MAX_HOLD_CANDIDATES)}::integer`);
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * Withdrawn records whose newest version of any kind is a withdrawal by
 * `actor` (the pass's own): the ones it may publish again. A record anyone
 * has changed since in any way (edited, moved, withdrawn, sent for review)
 * is never among them: it is a person's to publish. One page, as
 * `publishedPerhapsHeld`.
 */
export async function withdrawnBy(
  db: Queryable,
  organizationId: OrganizationId,
  actor: string,
  page: { readonly after?: RecordId; readonly limit?: number } = {},
): Promise<readonly RecordId[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    SELECT r.id::text AS id FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid AND r.workflow_state = 'withdrawn'
      AND r.id > ${page.after ?? AFTER_NONE}::uuid
      AND EXISTS (
        SELECT 1 FROM public.record_versions v
        WHERE v.organization_id = r.organization_id AND v.record_id = r.id
          AND v.version = r.version AND v.action = 'withdraw' AND v.actor = ${actor})
    ORDER BY r.id
    LIMIT ${capped(page.limit ?? MAX_HOLD_CANDIDATES)}::integer`);
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * Under the record's row lock (`FOR NO KEY UPDATE`, as an edit and a change
 * of state take it): its state and version, and who withdrew it when its
 * newest version (of any kind) is a withdrawal, or `undefined`
 * if the organization has no such record.
 */
export async function lockRecordState(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<
  | {
      readonly state: string;
      readonly version: number;
      /** The actor when the newest version is a withdrawal, else null. */
      readonly lastWithdrawnBy: string | null;
    }
  | undefined
> {
  const [row] = await db.rows<{ workflow_state: string; version: number }>(sql`
    SELECT workflow_state, version FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid
    FOR NO KEY UPDATE`);
  if (row === undefined) return undefined;
  // The version row of the record's current version: its newest change of any kind.
  const [move] = await db.rows<{ actor: string; action: string }>(sql`
    SELECT actor, action FROM public.record_versions
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND version = ${row.version}::integer`);
  return Object.freeze({
    state: row.workflow_state,
    version: row.version,
    lastWithdrawnBy: move?.action === "withdraw" ? move.actor : null,
  });
}

/**
 * Whether anyone but `actor` has written a version of any record above
 * `recordId` (its parents and the records it represents, all the way up)
 * since `recordId`'s version `version` was written: a change whose values
 * the record would show (inherited, D-013) that nobody decided to publish
 * through it. True also when that version can't be found.
 */
export async function changedAboveSince(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  version: number,
  actor: string,
): Promise<boolean> {
  const [row] = await db.rows<{ changed: boolean }>(sql`
    WITH RECURSIVE up(id) AS (
      SELECT x.id FROM public.records r
      CROSS JOIN LATERAL (VALUES (r.parent_id), (r.represents_id)) AS x(id)
      WHERE r.organization_id = ${organizationId}::uuid AND r.id = ${recordId}::uuid
        AND x.id IS NOT NULL
      UNION
      SELECT x.id FROM public.records r JOIN up ON r.id = up.id
      CROSS JOIN LATERAL (VALUES (r.parent_id), (r.represents_id)) AS x(id)
      WHERE r.organization_id = ${organizationId}::uuid AND x.id IS NOT NULL
    ),
    since AS (
      SELECT recorded_at FROM public.record_versions
      WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
        AND version = ${version}::integer
    )
    SELECT NOT EXISTS (SELECT 1 FROM since)
        OR EXISTS (
          SELECT 1 FROM public.record_versions v JOIN up ON v.record_id = up.id, since
          WHERE v.organization_id = ${organizationId}::uuid
            AND v.actor <> ${actor} AND v.recorded_at > since.recorded_at
        ) AS changed`);
  return row?.changed !== false;
}
