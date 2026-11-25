/**
 * Sharing items between sites (T-041b, D-074, D-094): the rows of
 * `0024_record_shares.sql`. Who may offer, decide and end a share is the
 * service's (packages/service `shares.ts`); these functions only read and
 * write, each in the caller's transaction.
 *
 * - `insertShare` adds an offer; `lockShare` reads one share `FOR UPDATE`;
 *   `moveShare` changes its state (the database allows only the moves of
 *   the migration's header and fills nothing in itself).
 * - `sharesIntoSite` and `sharesOfRecord` list shares, newest first, at most
 *   `MAX_SHARE_PAGE`.
 * - `sharedItemView` builds what a second site may see of an accepted item:
 *   its title, kind and workflow state, the fields its template makes
 *   public (never staff-only fields, ID numbers or history), and the names
 *   of its home site and organization.
 */
import {
  isOrganizationId,
  isRecordId,
  isSiteId,
  isUserId,
  type CatalogRecord,
  type FieldValue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
} from "@oculus/core";
import { readStoredRecord, readTemplate } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** The writer's privileges on the shares (roles.ts): never DELETE (rows go with their record). */
export const SHARE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  record_shares: ["INSERT", "UPDATE"],
});

export const SHARE_STATES = ["offered", "accepted", "declined", "withdrawn", "removed"] as const;
export type ShareState = (typeof SHARE_STATES)[number];

/** The most shares one list returns. */
export const MAX_SHARE_PAGE = 200;

/** A share as stored. */
export interface Share {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly recordId: RecordId;
  readonly targetOrganizationId: OrganizationId;
  readonly targetSiteId: SiteId;
  readonly state: ShareState;
  readonly offeredBy: UserId;
  readonly offeredAt: string;
  readonly decidedAt: string | null;
  readonly endedAt: string | null;
}

interface ShareRow {
  id: string;
  organization_id: string;
  record_id: string;
  target_organization_id: string;
  target_site_id: string;
  state: ShareState;
  offered_by: string;
  offered_at: string;
  decided_at: string | null;
  ended_at: string | null;
}

const COLUMNS = sql`
  id::text AS id, organization_id::text AS organization_id, record_id::text AS record_id,
  target_organization_id::text AS target_organization_id, target_site_id::text AS target_site_id,
  state, offered_by::text AS offered_by,
  to_char(offered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS offered_at,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
  to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ended_at`;

function toShare(row: ShareRow): Share {
  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id as OrganizationId,
    recordId: row.record_id as RecordId,
    targetOrganizationId: row.target_organization_id as OrganizationId,
    targetSiteId: row.target_site_id as SiteId,
    state: row.state,
    offeredBy: row.offered_by as UserId,
    offeredAt: row.offered_at,
    decidedAt: row.decided_at,
    endedAt: row.ended_at,
  });
}

/** A version 4 UUID, as share IDs are. */
export function isShareId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

/** A new offer. The caller has checked who may offer it and that the site exists. */
export async function insertShare(
  tx: Queryable,
  share: {
    readonly id: string;
    readonly organizationId: OrganizationId;
    readonly recordId: RecordId;
    readonly targetOrganizationId: OrganizationId;
    readonly targetSiteId: SiteId;
    readonly offeredBy: UserId;
  },
): Promise<Share> {
  const [row] = await tx.rows<ShareRow>(sql`
    INSERT INTO public.record_shares
      (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
    VALUES (${share.id}::uuid, ${share.organizationId}::uuid, ${share.recordId}::uuid,
            ${share.targetOrganizationId}::uuid, ${share.targetSiteId}::uuid,
            ${share.offeredBy}::uuid)
    RETURNING ${COLUMNS}`);
  if (row === undefined) throw new Error("insertShare: no row");
  return toShare(row);
}

/** The share, locked `FOR UPDATE` until COMMIT, or `undefined`. */
export async function lockShare(tx: Queryable, id: unknown): Promise<Share | undefined> {
  if (!isShareId(id)) return undefined;
  const [row] = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares WHERE id = ${id}::uuid FOR UPDATE`);
  return row === undefined ? undefined : toShare(row);
}

/** The share as it is now, without a lock, or `undefined`. */
export async function readShare(tx: Queryable, id: unknown): Promise<Share | undefined> {
  if (!isShareId(id)) return undefined;
  const [row] = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares WHERE id = ${id}::uuid`);
  return row === undefined ? undefined : toShare(row);
}

/** The live share (offered or accepted) of the record into the site, if any. */
export async function liveShare(
  tx: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  targetOrganizationId: OrganizationId,
  targetSiteId: SiteId,
): Promise<Share | undefined> {
  const [row] = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND target_organization_id = ${targetOrganizationId}::uuid
      AND target_site_id = ${targetSiteId}::uuid AND state IN ('offered', 'accepted')`);
  return row === undefined ? undefined : toShare(row);
}

/**
 * Moves a locked share to `to` by `by`: `accepted` and `declined` record the
 * decision, `withdrawn` and `removed` the end. The database refuses any
 * other move.
 */
export async function moveShare(
  tx: Queryable,
  id: string,
  to: "accepted" | "declined" | "withdrawn" | "removed",
  by: UserId,
): Promise<Share> {
  if (!isShareId(id) || !isUserId(by)) throw new Error("moveShare: bad ID");
  const decision = to === "accepted" || to === "declined";
  const [row] = await tx.rows<ShareRow>(
    decision
      ? sql`UPDATE public.record_shares
            SET state = ${to}, decided_by = ${by}::uuid, decided_at = clock_timestamp()
            WHERE id = ${id}::uuid RETURNING ${COLUMNS}`
      : sql`UPDATE public.record_shares
            SET state = ${to}, ended_by = ${by}::uuid, ended_at = clock_timestamp()
            WHERE id = ${id}::uuid RETURNING ${COLUMNS}`,
  );
  if (row === undefined) throw new Error("moveShare: no row");
  return toShare(row);
}

/** Shares into a site in `states`, newest first. */
export async function sharesIntoSite(
  tx: Queryable,
  targetOrganizationId: OrganizationId,
  targetSiteId: SiteId,
  states: readonly ShareState[],
): Promise<readonly Share[]> {
  if (!isOrganizationId(targetOrganizationId) || !isSiteId(targetSiteId)) return [];
  const wanted = states.filter((s) => (SHARE_STATES as readonly string[]).includes(s));
  if (wanted.length === 0) return [];
  const rows = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares
    WHERE target_organization_id = ${targetOrganizationId}::uuid
      AND target_site_id = ${targetSiteId}::uuid
      AND state = ANY(${wanted}::text[])
    ORDER BY offered_at DESC, id
    LIMIT ${MAX_SHARE_PAGE}`);
  return rows.map(toShare);
}

/** A record's shares, newest first. */
export async function sharesOfRecord(
  tx: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<readonly Share[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return [];
  const rows = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
    ORDER BY offered_at DESC, id
    LIMIT ${MAX_SHARE_PAGE}`);
  return rows.map(toShare);
}

/** What a second site sees of a shared item (D-094). */
export interface SharedItemView {
  readonly title: string;
  readonly kind: CatalogRecord["kind"];
  readonly published: boolean;
  /** Only the fields the item's template makes public, by key. */
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly homeSite: string | null;
  readonly homeOrganization: string;
}

/**
 * The view of a shared item as it is now (module header), or `undefined`
 * when the record is gone. Fields whose template field isn't `public`, and
 * every field when the template can't be read, are left out.
 */
export async function sharedItemView(
  tx: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<SharedItemView | undefined> {
  const stored = await readStoredRecord(tx, organizationId, recordId);
  if (!stored?.ok) return undefined;
  const record = stored.value.record;
  const fields: Record<string, FieldValue> = {};
  const templateKey = record.templateKey;
  const template =
    templateKey === undefined ? undefined : await readTemplate(tx, organizationId, templateKey);
  if (template?.ok) {
    const recordFields = record.fields;
    for (const field of template.value.template.fields) {
      if (field.visibility !== "public") continue;
      const own = Object.getOwnPropertyDescriptor(recordFields, field.key);
      if (own !== undefined && "value" in own) fields[field.key] = own.value as FieldValue;
    }
  }
  const [names] = await tx.rows<{
    organization: string;
    site: string | null;
    state: string;
  }>(sql`
    SELECT o.name AS organization, s.name AS site, r.workflow_state AS state
    FROM public.records r
    JOIN public.organizations o ON o.id = r.organization_id
    LEFT JOIN public.sites s ON s.organization_id = r.organization_id AND s.id = r.site_id
    WHERE r.organization_id = ${organizationId}::uuid AND r.id = ${recordId}::uuid`);
  if (names === undefined) return undefined;
  return Object.freeze({
    title: record.title,
    kind: record.kind,
    published: names.state === "published",
    fields: Object.freeze(fields),
    homeSite: names.site,
    homeOrganization: names.organization,
  });
}
