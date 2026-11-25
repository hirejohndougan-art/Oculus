/**
 * What OAI-PMH needs from the staff connection (T-050c, D-105): which
 * records are published on a site, in datestamp order, and their datestamps.
 *
 * These run on the server's **staff** connection, never the public reader's
 * (as T-034d's counts do, D-095): a listing function for the public reader
 * would hand it the IDs of published records that public output holds back.
 * Nothing here leaves the server as it is: the OAI-PMH routes read every
 * listed record again through `readPublicRecord` on the public reader, and
 * show only the ones that come back.
 *
 * A record's datestamp is the later of when its current version was
 * written (`record_versions.recorded_at`: every edit and every workflow
 * move writes a version) and when its template's stored Dublin Core
 * mapping last changed (D-096), since either changes its `oai_dc` record.
 * It doesn't follow changes to other records (a parent's title, a linked
 * record) or to vocabulary labels; D-105 says so.
 */
import { isOrganizationId, isRecordId, isSiteId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql, type Sql } from "./sql.js";

/** The most candidates one call returns. */
export const MAX_OAI_CANDIDATES = 500;

/** A datestamp as the database writes it: UTC, whole milliseconds. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OaiCandidate {
  readonly id: string;
  /** `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  readonly stamp: string;
}

export interface OaiListOptions {
  /** Only records after this one, in (stamp, id) order: a resumption point. */
  readonly after?: OaiCandidate;
  /** Datestamps at or after this instant (an ISO string with `Z`). */
  readonly from?: string;
  /** Datestamps before this instant (exclusive; the caller widens `until`). */
  readonly before?: string;
  readonly limit: number;
}

function isStamp(value: unknown): value is string {
  return typeof value === "string" && STAMP.test(value) && !Number.isNaN(Date.parse(value));
}

/** The published records on `site`, each with its datestamp (one row per record). */
function stamped(organizationId: string, siteId: string): Sql {
  return sql`
    SELECT r.id,
           -- Whole milliseconds, as the token carries it: changed_at has
           -- microseconds, and a finer stamp than the token's would resume
           -- before the page it ended (D-105).
           date_trunc('milliseconds',
                      greatest(coalesce(v.recorded_at, r.updated_at),
                               coalesce(m.changed_at, '-infinity'::timestamptz))) AS stamp
    FROM public.records r
    LEFT JOIN public.record_versions v
      ON v.organization_id = r.organization_id AND v.record_id = r.id AND v.version = r.version
    LEFT JOIN public.dublin_core_mappings m
      ON m.organization_id = r.organization_id AND m.template_key = r.template_key
    WHERE r.organization_id = ${organizationId}::uuid
      AND public.record_public_on_site(r, ${siteId}::uuid)`;
}

function bad(): never {
  throw new TypeError("invalid OAI-PMH listing arguments");
}

/**
 * Up to `limit` published records on the site, oldest datestamp first (ties
 * by ID), after `after` and within `from`/`before`. Throws `TypeError` on
 * malformed arguments (the routes check theirs first).
 */
export async function listPublishedForOai(
  db: Queryable,
  organizationId: string,
  siteId: string,
  options: OaiListOptions,
): Promise<OaiCandidate[]> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) bad();
  const { after, from, before, limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OAI_CANDIDATES) bad();
  if (after !== undefined && (!isRecordId(after.id) || !isStamp(after.stamp))) bad();
  if (from !== undefined && !isStamp(from)) bad();
  if (before !== undefined && !isStamp(before)) bad();
  const rows = await db.rows<{ id: string; stamp: string }>(sql`
    WITH c AS (${stamped(organizationId, siteId)})
    SELECT c.id::text AS id,
           to_char(c.stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp
    FROM c
    WHERE TRUE
      ${from === undefined ? sql`` : sql`AND c.stamp >= ${from}::timestamptz`}
      ${before === undefined ? sql`` : sql`AND c.stamp < ${before}::timestamptz`}
      ${
        after === undefined
          ? sql``
          : sql`AND (c.stamp, c.id) > (${after.stamp}::timestamptz, ${after.id}::uuid)`
      }
    ORDER BY c.stamp, c.id
    LIMIT ${limit}`);
  return rows.map((row) => Object.freeze({ id: row.id, stamp: row.stamp }));
}

/** One published record's datestamp on the site, or `undefined` if it isn't published there. */
export async function oaiDatestamp(
  db: Queryable,
  organizationId: string,
  siteId: string,
  recordId: string,
): Promise<string | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(recordId)) {
    return undefined;
  }
  const [row] = await db.rows<{ stamp: string }>(sql`
    WITH c AS (${stamped(organizationId, siteId)})
    SELECT to_char(c.stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp
    FROM c WHERE c.id = ${recordId}::uuid`);
  return row?.stamp;
}

/**
 * What Identify says of the site: its name, and a lower bound for every
 * datestamp (the day before the site was made: a version written in a
 * transaction that started before the site existed can carry an earlier
 * `now()`). Not the earliest
 * record's stamp: that record may be one public output holds back (D-105).
 * Every record on the site was put there by a version written after then.
 */
export async function oaiRepository(
  db: Queryable,
  organizationId: string,
  siteId: string,
): Promise<{ name: string; earliest: string } | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) return undefined;
  const [row] = await db.rows<{ name: string; earliest: string }>(sql`
    SELECT s.name,
           to_char(date_trunc('day', s.created_at AT TIME ZONE 'UTC') - interval '1 day',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS earliest
    FROM public.sites s
    WHERE s.organization_id = ${organizationId}::uuid AND s.id = ${siteId}::uuid`);
  return row === undefined ? undefined : { name: row.name, earliest: row.earliest };
}
