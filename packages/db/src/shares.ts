/**
 * Sharing items between sites (T-041b, D-074, D-094): the rows of
 * `0024_record_shares.sql`. Who may offer, decide and end a share is the
 * service's (packages/service `shares.ts`); these functions only read and
 * write, each in the caller's transaction.
 *
 * - `insertShare` adds an offer; `lockShare` reads one share `FOR UPDATE`;
 *   `moveShare` changes its state (the database allows only the moves of
 *   the migration's header and fills nothing in itself).
 * - `sharesIntoSite` and `sharesOfRecord` list shares, newest first, a page
 *   of at most `MAX_SHARE_PAGE` at a time, the next page asked for with the
 *   last share's ID as `before` (S-036a).
 * - `sharedItemViews` builds what a second site may see of shares:
 *   exactly what its home site's public pages show of it (`publicRecordIn`,
 *   D-111: published on a home site, passing the publish check, with a
 *   stored Dublin Core mapping), its fields limited to those the mapping
 *   publishes and named by the home template's labels, with the names of
 *   its home site and organization.
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
import type { Database, Queryable } from "./client.js";
import { sql } from "./sql.js";
import { publicRecordIn } from "./workflow.js";

/** The writer's privileges on the shares (roles.ts): never DELETE (rows go with their record). */
export const SHARE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  record_shares: ["INSERT", "UPDATE"],
});

export const SHARE_STATES = ["offered", "accepted", "declined", "withdrawn", "removed"] as const;
export type ShareState = (typeof SHARE_STATES)[number];

/**
 * The most shares one list page returns (S-036a). Each accepted share on a
 * page costs a view to build (`sharedItemViews`), so a site manager's
 * screen (offers and accepted items) builds at most twice this many.
 */
export const MAX_SHARE_PAGE = 50;

/** A page of a share list: newest first, after `before` (a share ID) when given. */
export interface SharePageOptions {
  readonly before?: unknown;
}

/**
 * The page condition: shares strictly older than `before` in the lists'
 * order (newest first, then by ID), or no rows for a `before` that isn't a
 * share of the same site (or record), in any state. `scope` limits which share may be a
 * cursor, so another list's (or organization's) share can't be one.
 */
function pageAfter(before: unknown, scope: ReturnType<typeof sql>): ReturnType<typeof sql> {
  if (before === undefined) return sql`TRUE`;
  if (!isShareId(before)) return sql`FALSE`;
  return sql`(sh.offered_at, sh.id) < (
    SELECT c.offered_at, c.id FROM public.record_shares c
    WHERE c.id = ${before}::uuid AND ${scope})`;
}

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

/**
 * A new offer, or `undefined` when the record already has a live share into
 * that site (two offers at once: the second gets nothing). The caller has
 * checked who may offer it and that the site exists.
 */
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
): Promise<Share | undefined> {
  const [row] = await tx.rows<ShareRow>(sql`
    INSERT INTO public.record_shares
      (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
    VALUES (${share.id}::uuid, ${share.organizationId}::uuid, ${share.recordId}::uuid,
            ${share.targetOrganizationId}::uuid, ${share.targetSiteId}::uuid,
            ${share.offeredBy}::uuid)
    ON CONFLICT (organization_id, record_id, target_organization_id, target_site_id)
      WHERE state IN ('offered', 'accepted') DO NOTHING
    RETURNING ${COLUMNS}`);
  return row === undefined ? undefined : toShare(row);
}

/**
 * The share, locked `FOR UPDATE` until COMMIT, or `undefined`: only a share
 * whose home organization (`side: "home"`) or second site's organization
 * (`"target"`) is `organizationId`, so no other organization's session can
 * lock (or time) a share it has nothing to do with.
 */
export async function lockShare(
  tx: Queryable,
  id: unknown,
  side: "home" | "target",
  organizationId: OrganizationId,
): Promise<Share | undefined> {
  if (!isShareId(id) || !isOrganizationId(organizationId)) return undefined;
  const [row] = await tx.rows<ShareRow>(
    side === "home"
      ? sql`SELECT ${COLUMNS} FROM public.record_shares
            WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`
      : sql`SELECT ${COLUMNS} FROM public.record_shares
            WHERE id = ${id}::uuid AND target_organization_id = ${organizationId}::uuid
            FOR UPDATE`,
  );
  return row === undefined ? undefined : toShare(row);
}

/** The share as it is now, without a lock, under the same rule as `lockShare`. */
export async function readShare(
  tx: Queryable,
  id: unknown,
  side: "home" | "target",
  organizationId: OrganizationId,
): Promise<Share | undefined> {
  if (!isShareId(id) || !isOrganizationId(organizationId)) return undefined;
  const [row] = await tx.rows<ShareRow>(
    side === "home"
      ? sql`SELECT ${COLUMNS} FROM public.record_shares
            WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid`
      : sql`SELECT ${COLUMNS} FROM public.record_shares
            WHERE id = ${id}::uuid AND target_organization_id = ${organizationId}::uuid`,
  );
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

/**
 * Shares into a site in one state, newest first, a page of at most
 * `MAX_SHARE_PAGE` (after `options.before`). Offers and accepted items are
 * asked for separately, so a flood of offers never pushes accepted items
 * out of a list. A share into what is now the record's own home site (it
 * was moved there since) is always left out. Unless `includeHidden`, so is
 * one whose record isn't published on a home site, before the limit; with
 * it (a site manager's own list, S-036a) such shares stay in, so the manager
 * can see and remove them. One whose public output is refused for another
 * reason (`sharedItemViews`) is left out by the caller after the limit; a
 * caller pages past it with `before`.
 */
export async function sharesIntoSite(
  tx: Queryable,
  targetOrganizationId: OrganizationId,
  targetSiteId: SiteId,
  state: ShareState,
  options: SharePageOptions & { readonly includeHidden?: boolean } = {},
): Promise<readonly Share[]> {
  if (!isOrganizationId(targetOrganizationId) || !isSiteId(targetSiteId)) return [];
  if (!(SHARE_STATES as readonly string[]).includes(state)) return [];
  const visible =
    options.includeHidden === true
      ? sql`r.organization_id IS NOT NULL`
      : sql`r.workflow_state = 'published' AND r.site_id IS NOT NULL`;
  // The cursor is any share into this site (any state: one that was
  // decided or ended since the page before still marks where it ended).
  const page = pageAfter(
    options.before,
    sql`c.target_organization_id = ${targetOrganizationId}::uuid
        AND c.target_site_id = ${targetSiteId}::uuid`,
  );
  const rows = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares sh
    WHERE sh.target_organization_id = ${targetOrganizationId}::uuid
      AND sh.target_site_id = ${targetSiteId}::uuid
      AND sh.state = ${state}
      AND ${page}
      -- Items the second site could be shown (or, for its manager, could
      -- remove), before the limit, so items nobody there may see never fill
      -- the page; never one moved onto the second site itself.
      AND EXISTS (
        SELECT 1 FROM public.records r
        WHERE r.organization_id = sh.organization_id AND r.id = sh.record_id
          AND ${visible}
          AND NOT (sh.organization_id = sh.target_organization_id
                   AND r.site_id IS NOT DISTINCT FROM sh.target_site_id))
    ORDER BY sh.offered_at DESC, sh.id DESC
    LIMIT ${MAX_SHARE_PAGE}`);
  return rows.map(toShare);
}

/** A record's shares, newest first, a page of at most `MAX_SHARE_PAGE` (after `options.before`). */
export async function sharesOfRecord(
  tx: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: SharePageOptions = {},
): Promise<readonly Share[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return [];
  const page = pageAfter(
    options.before,
    sql`c.organization_id = ${organizationId}::uuid AND c.record_id = ${recordId}::uuid`,
  );
  const rows = await tx.rows<ShareRow>(sql`
    SELECT ${COLUMNS} FROM public.record_shares sh
    WHERE sh.organization_id = ${organizationId}::uuid AND sh.record_id = ${recordId}::uuid
      AND ${page}
    ORDER BY sh.offered_at DESC, sh.id DESC
    LIMIT ${MAX_SHARE_PAGE}`);
  return rows.map(toShare);
}

/**
 * What a second site sees of a shared item (D-094, S-036a): what its home
 * site's public pages show.
 */
export interface SharedItemView {
  readonly title: string;
  readonly kind: CatalogRecord["kind"];
  /**
   * The public values, own and inherited, that the home template's stored
   * Dublin Core mapping publishes, by field key.
   */
  readonly fields: Readonly<Record<string, FieldValue>>;
  /** Each of `fields`' keys' label in the home template (the key itself if it has none). */
  readonly labels: Readonly<Record<string, string>>;
  readonly homeSite: string | null;
  readonly homeOrganization: string;
}

/** Only used to satisfy `publicOutput`'s URL check; no URL leaves `sharedItemViews`. */
const VIEW_BASE_URL = "https://oculus.invalid/records/";

/** The field keys a stored mapping publishes (`entries[].field`), or undefined. */
function mappedFields(mapping: unknown): ReadonlySet<string> | undefined {
  if (typeof mapping !== "object" || mapping === null) return undefined;
  const entries = (mapping as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  const keys = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const field = (entry as { field?: unknown }).field;
    if (typeof field === "string") keys.add(field);
  }
  return keys;
}

/** A share that, in the view's snapshot, is no longer in the state it was listed in (S-036a). */
export const SHARE_CHANGED = "changed" as const;

/**
 * The views of `shares` as the public sees them now, by share ID, built in
 * one REPEATABLE READ, read-only transaction of its own (one snapshot: no
 * view mixes moments). A share whose state changed since it was listed, or
 * whose record is now on the second site itself, maps to `SHARE_CHANGED`
 * (its caller leaves it out). One whose home site's public pages wouldn't
 * show the record (`publicRecordIn` for the home organization and site,
 * with its stored mapping, D-111) is left out of the map (hidden).
 */
export async function sharedItemViews(
  db: Database,
  shares: readonly Share[],
): Promise<ReadonlyMap<string, SharedItemView | typeof SHARE_CHANGED>> {
  const out = new Map<string, SharedItemView | typeof SHARE_CHANGED>();
  if (shares.length === 0) return out;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    for (const share of shares.slice(0, 2 * MAX_SHARE_PAGE)) {
      const [names] = await tx.rows<{
        organization: string;
        site: string | null;
        site_id: string | null;
        state: string;
      }>(sql`
        SELECT o.name AS organization, s.name AS site, r.site_id::text AS site_id,
               sh.state
        FROM public.record_shares sh
        JOIN public.records r ON r.organization_id = sh.organization_id AND r.id = sh.record_id
        JOIN public.organizations o ON o.id = r.organization_id
        LEFT JOIN public.sites s ON s.organization_id = r.organization_id AND s.id = r.site_id
        WHERE sh.id = ${share.id}::uuid`);
      if (names?.state !== share.state) {
        out.set(share.id, SHARE_CHANGED);
        continue;
      }
      if (
        share.organizationId === share.targetOrganizationId &&
        names.site_id === share.targetSiteId
      ) {
        out.set(share.id, SHARE_CHANGED);
        continue;
      }
      if (names.site_id === null || !isSiteId(names.site_id)) continue;
      const read = await publicRecordIn(
        tx,
        share.organizationId,
        names.site_id,
        share.recordId,
        VIEW_BASE_URL,
        undefined,
      );
      if (!read.ok) continue;
      const published = mappedFields(read.value.mapping);
      if (published === undefined) continue;
      const labelOf = new Map(read.value.template.fields.map((f) => [f.key, f.label] as const));
      const fields: Record<string, FieldValue> = {};
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(read.value.view.fields)) {
        if (!published.has(key)) continue;
        fields[key] = value;
        labels[key] = labelOf.get(key) ?? key;
      }
      out.set(
        share.id,
        Object.freeze({
          title: read.value.view.title,
          kind: read.value.view.kind,
          fields: Object.freeze(fields),
          labels: Object.freeze(labels),
          homeSite: names.site,
          homeOrganization: names.organization,
        }),
      );
    }
  });
  return out;
}
