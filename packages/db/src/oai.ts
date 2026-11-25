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
 * The lists read the stored datestamps (S-041, D-108: `oai_datestamps`,
 * written by `writeOaiStamps` from the background pass's fingerprints of
 * each record's oai_dc). `oaiDatestamp` below is the computed fallback for
 * GetRecord before a site's first pass. A computed datestamp is the later of when its current version was
 * written (`record_versions.recorded_at`: every edit and every workflow
 * move writes a version) and when its template's stored Dublin Core
 * mapping last changed (D-096), since either changes its `oai_dc` record.
 * It doesn't follow changes to other records (a parent's title, a linked
 * record) or to vocabulary labels; D-105 says so.
 *
 * Every statement here runs under a server-side time limit (S-043a): the
 * lists' at most 30 seconds (they wait on purpose for a datestamp write in
 * progress), and the one-record reads' and Identify's `timeLimitMs` (5
 * seconds by default), so a slow or locked staff database can't hold an
 * OAI-PMH slot for long. A statement that runs out of time throws an
 * `isDatabaseTimeout` error, which the routes answer `503 busy`. Not yet
 * bounded (S-051): the wait for a free staff connection, and a server or
 * network that stops answering altogether.
 */
import { isOrganizationId, isRecordId, isSiteId } from "@oculus/core";
import type { Database, Queryable } from "./client.js";
import { sql, type Sql } from "./sql.js";

/** The most candidates one call returns. */
export const MAX_OAI_CANDIDATES = 500;

/** A one-record read's or Identify's statement time limit when none is given (S-043a). */
export const OAI_READ_TIME_LIMIT_MS = 5_000;
/** The longest time limit those reads take. */
const MAX_OAI_READ_TIME_LIMIT_MS = 60_000;

export interface OaiReadOptions {
  /** The read's statement time limit, in whole milliseconds from 1 to 60000. */
  readonly timeLimitMs?: number;
}

/**
 * Runs `work` in a transaction whose statements, lock waits included, are
 * cancelled after the time limit (SQLSTATE 57014, an `isDatabaseTimeout`).
 * Only `statement_timeout`, not `lock_timeout`: a lock wait running out must
 * read as a time limit too, never as a failure. Throws `RangeError` on a
 * limit it couldn't use.
 */
async function bounded<T>(
  db: Database,
  { timeLimitMs = OAI_READ_TIME_LIMIT_MS }: OaiReadOptions,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (
    !Number.isInteger(timeLimitMs) ||
    timeLimitMs < 1 ||
    timeLimitMs > MAX_OAI_READ_TIME_LIMIT_MS
  ) {
    throw new RangeError(
      `timeLimitMs must be a whole number from 1 to ${String(MAX_OAI_READ_TIME_LIMIT_MS)}`,
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeLimitMs)}, true)`,
    );
    return work(tx);
  });
}

/** A datestamp as the database writes it: UTC, whole milliseconds. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OaiCandidate {
  readonly id: string;
  /** `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  readonly stamp: string;
  /** The record has stopped being shown on the site (S-041): a deleted header. */
  readonly deleted?: boolean;
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
 * Up to `limit` of the site's stored datestamps (S-041, D-108), oldest
 * first (ties by ID), after `after` and within `from`/`before`: records
 * shown on the site, and records that have stopped being shown (`deleted`).
 * Empty until the background pass has stamped the site. Throws `TypeError`
 * on malformed arguments (the routes check theirs first).
 */
export async function listPublishedForOai(
  db: Database,
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
  return db.transaction(async (tx) => {
    // Wait for a datestamp write in progress to commit (SHARE conflicts with
    // its ROW EXCLUSIVE): its rows carry a time from before they could be
    // seen, so a list that ran meanwhile, with a later responseDate, would
    // miss them for good (review of S-041). Bounded, never a hang.
    await tx.execute(
      sql`SELECT pg_catalog.set_config('lock_timeout', '30000', true),
                 pg_catalog.set_config('statement_timeout', '30000', true)`,
    );
    await tx.execute(sql`LOCK TABLE public.oai_datestamps IN SHARE MODE`);
    return listIn(tx, organizationId, siteId, options);
  });
}

async function listIn(
  tx: Queryable,
  organizationId: string,
  siteId: string,
  { after, from, before, limit }: OaiListOptions,
): Promise<OaiCandidate[]> {
  const rows = await tx.rows<{ id: string; stamp: string; deleted: boolean }>(sql`
    SELECT d.record_id::text AS id, d.deleted,
           to_char(d.stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp
    FROM public.oai_datestamps d
    WHERE d.organization_id = ${organizationId}::uuid AND d.site_id = ${siteId}::uuid
      ${from === undefined ? sql`` : sql`AND d.stamp >= ${from}::timestamptz`}
      ${before === undefined ? sql`` : sql`AND d.stamp < ${before}::timestamptz`}
      ${
        after === undefined
          ? sql``
          : sql`AND (d.stamp, d.record_id) > (${after.stamp}::timestamptz, ${after.id}::uuid)`
      }
    ORDER BY d.stamp, d.record_id
    LIMIT ${limit}`);
  return rows.map((row) =>
    Object.freeze({ id: row.id, stamp: row.stamp, ...(row.deleted ? { deleted: true } : {}) }),
  );
}

/**
 * Stores what the background pass saw of a site (S-041, D-108): every
 * record shown, with a fingerprint of its oai_dc record. A new record, or one
 * whose fingerprint changed or that comes back, gets the time now; a stored
 * record not in `shown` is marked deleted, with the time now. One statement,
 * so the time is the write's own. Returns how many rows moved.
 */
export async function writeOaiStamps(
  db: Database,
  organizationId: string,
  siteId: string,
  shown: ReadonlyMap<string, string>,
): Promise<number> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) bad();
  const ids: string[] = [];
  const prints: string[] = [];
  for (const [id, print] of shown) {
    if (!isRecordId(id) || !/^[0-9a-f]{64}$/.test(print)) bad();
    ids.push(id);
    prints.push(print);
  }
  return db.transaction(async (tx) => {
    // Bounded (a migration's lock can't hang the pass), and one writer per
    // site at a time across server processes, so two can't deadlock.
    await tx.execute(
      sql`SELECT pg_catalog.set_config('lock_timeout', '30000', true),
                 pg_catalog.set_config('statement_timeout', '60000', true)`,
    );
    await tx.execute(
      sql`SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended(${`oai:${siteId}`}, 0))`,
    );
    return writeIn(tx, organizationId, siteId, ids, prints);
  });
}

async function writeIn(
  tx: Queryable,
  organizationId: string,
  siteId: string,
  ids: readonly string[],
  prints: readonly string[],
): Promise<number> {
  const [row] = await tx.rows<{ moved: string }>(sql`
    -- Never earlier than the site's latest datestamp, so a clock stepping
    -- back can't give a change a datestamp harvesters have already passed.
    WITH now_ms(at) AS (
      SELECT greatest(
        date_trunc('milliseconds', clock_timestamp()),
        (SELECT max(d.stamp) + interval '1 millisecond' FROM public.oai_datestamps d
          WHERE d.organization_id = ${organizationId}::uuid AND d.site_id = ${siteId}::uuid))
    ),
    incoming(record_id, fingerprint) AS (
      SELECT * FROM unnest(${ids}::uuid[], ${prints}::text[])
    ),
    up AS (
      INSERT INTO public.oai_datestamps AS d
        (organization_id, site_id, record_id, stamp, fingerprint)
      SELECT ${organizationId}::uuid, ${siteId}::uuid, i.record_id, n.at, i.fingerprint
      FROM incoming i CROSS JOIN now_ms n
      ON CONFLICT (organization_id, site_id, record_id) DO UPDATE
        SET stamp = EXCLUDED.stamp, fingerprint = EXCLUDED.fingerprint, deleted = false
        WHERE d.fingerprint <> EXCLUDED.fingerprint OR d.deleted
      RETURNING 1
    ),
    gone AS (
      UPDATE public.oai_datestamps d SET deleted = true, stamp = (SELECT at FROM now_ms)
      WHERE d.organization_id = ${organizationId}::uuid AND d.site_id = ${siteId}::uuid
        AND NOT d.deleted
        AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.record_id = d.record_id)
      RETURNING 1
    )
    SELECT ((SELECT count(*) FROM up) + (SELECT count(*) FROM gone))::text AS moved`);
  return Number(row?.moved ?? 0);
}

/** A record's stored datestamp on the site, and whether it has stopped being shown. */
export async function oaiStoredStamp(
  db: Database,
  organizationId: string,
  siteId: string,
  recordId: string,
  options: OaiReadOptions = {},
): Promise<{ stamp: string; deleted: boolean } | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(recordId)) {
    return undefined;
  }
  const [row] = await bounded(db, options, (tx) =>
    tx.rows<{ stamp: string; deleted: boolean }>(sql`
    SELECT d.deleted,
           to_char(d.stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp
    FROM public.oai_datestamps d
    WHERE d.organization_id = ${organizationId}::uuid AND d.site_id = ${siteId}::uuid
      AND d.record_id = ${recordId}::uuid`),
  );
  return row === undefined ? undefined : { stamp: row.stamp, deleted: row.deleted };
}

/** One published record's datestamp on the site, or `undefined` if it isn't published there. */
export async function oaiDatestamp(
  db: Database,
  organizationId: string,
  siteId: string,
  recordId: string,
  options: OaiReadOptions = {},
): Promise<string | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(recordId)) {
    return undefined;
  }
  const [row] = await bounded(db, options, (tx) =>
    tx.rows<{ stamp: string }>(sql`
    WITH c AS (${stamped(organizationId, siteId)})
    SELECT to_char(c.stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp
    FROM c WHERE c.id = ${recordId}::uuid`),
  );
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
  db: Database,
  organizationId: string,
  siteId: string,
  options: OaiReadOptions = {},
): Promise<{ name: string; earliest: string } | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) return undefined;
  const [row] = await bounded(db, options, (tx) =>
    tx.rows<{ name: string; earliest: string }>(sql`
    SELECT s.name,
           to_char(date_trunc('day', s.created_at AT TIME ZONE 'UTC') - interval '1 day',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS earliest
    FROM public.sites s
    WHERE s.organization_id = ${organizationId}::uuid AND s.id = ${siteId}::uuid`),
  );
  return row === undefined ? undefined : { name: row.name, earliest: row.earliest };
}
