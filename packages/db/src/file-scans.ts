/**
 * Virus scan results of stored content (S-040, D-113; migration 0041).
 *
 * One row per organization and SHA-256: content is stored once however many
 * assets hold it (D-086), so its scan result is shared by all of them. No
 * row means the content has never been scanned. The service is the only
 * writer (D-067): the attach queues a scan, the scan queue claims due rows
 * and records what the scanner said, and a system manager's rescan puts
 * clean and failed contents back in the queue. An infected content is
 * quarantined for good: the database refuses to change it back
 * (`file_scans_quarantine_holds`) and nothing deletes a row.
 *
 * Every query names one organization (D-019), except the queue's claim,
 * which is a job over every organization and hands back the one it took.
 */
import { isOrganizationId, isSha256Hex, type OrganizationId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { isActorId } from "./record-versions.js";
import { sql } from "./sql.js";

/** What the writer may do to the tables (D-067's allowlist). */
export const FILE_SCAN_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    // Queued by INSERT, moved along by UPDATE (also the queue's FOR UPDATE).
    file_scans: Object.freeze(["INSERT", "UPDATE"]),
    // Every result and rescan, append-only.
    file_scan_events: Object.freeze(["INSERT"]),
  });

/** A stored scan state (0041). */
export const SCAN_STATES = ["pending", "clean", "infected", "failed"] as const;
export type ScanState = (typeof SCAN_STATES)[number];

/** Why a scan failed. */
export const SCAN_FAILURES = [
  "timeout",
  "unavailable",
  "too_large",
  "refused",
  "protocol",
  "unreadable",
] as const;
export type ScanFailure = (typeof SCAN_FAILURES)[number];

/** A scanner's name for what it found, as the table keeps it. */
const SIGNATURE = /^[!-~]{1,200}$/;

export function isScanSignature(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE.test(value);
}

/** One content's scan result. */
export interface StoredScan {
  readonly sha256: string;
  readonly state: ScanState;
  readonly failure: ScanFailure | null;
  readonly signature: string | null;
  readonly attempts: number;
  readonly scannedAt: string | null;
}

interface ScanRow {
  sha256: string;
  state: string;
  failure: string | null;
  signature: string | null;
  attempts: number;
  scanned_at: string | null;
}

const COLUMNS = sql`
  s.sha256, s.state, s.failure, s.signature, s.attempts,
  to_char(s.scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scanned_at`;

function fromRow(row: ScanRow): StoredScan {
  if (
    !(SCAN_STATES as readonly string[]).includes(row.state) ||
    (row.failure !== null && !(SCAN_FAILURES as readonly string[]).includes(row.failure))
  ) {
    throw new Error("A file scan row doesn't read as one.");
  }
  return Object.freeze({
    sha256: row.sha256,
    state: row.state as ScanState,
    failure: row.failure as ScanFailure | null,
    signature: row.signature,
    attempts: row.attempts,
    scannedAt: row.scanned_at,
  });
}

function checkOrganization(organizationId: unknown): void {
  if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
}

function checkHash(sha256: unknown): void {
  if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
}

/** The scan results of these contents (those with none are missing from the map). */
export async function scanStates(
  db: Queryable,
  organizationId: OrganizationId,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, StoredScan>> {
  checkOrganization(organizationId);
  const wanted = [...new Set(hashes.filter((h) => isSha256Hex(h)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.rows<ScanRow>(sql`
    SELECT ${COLUMNS} FROM public.file_scans s
    WHERE s.organization_id = ${organizationId}::uuid AND s.sha256 = ANY(${wanted}::text[])`);
  return new Map(rows.map((row) => [row.sha256, fromRow(row)]));
}

/** One content's scan result, if it has one. */
export async function scanState(
  db: Queryable,
  organizationId: OrganizationId,
  sha256: string,
): Promise<StoredScan | undefined> {
  checkHash(sha256);
  return (await scanStates(db, organizationId, [sha256])).get(sha256);
}

/**
 * Queues a content for scanning, unless it already has a result (the same
 * bytes attached again keep theirs: clean stays clean, infected stays
 * quarantined). `true` when a new row was made.
 */
export async function queueScan(
  tx: Queryable,
  organizationId: OrganizationId,
  sha256: string,
): Promise<boolean> {
  checkOrganization(organizationId);
  checkHash(sha256);
  const made = await tx.execute(sql`
    INSERT INTO public.file_scans (organization_id, sha256, state)
    VALUES (${organizationId}::uuid, ${sha256}, 'pending')
    ON CONFLICT (organization_id, sha256) DO NOTHING`);
  return made > 0;
}

/**
 * Queues up to `limit` stored contents that have no scan result at all
 * (attached before scanning was set up). A job over every organization;
 * answers how many were queued.
 */
export async function queueUnscanned(tx: Queryable, limit: number): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Not a limit.");
  return tx.execute(sql`
    INSERT INTO public.file_scans (organization_id, sha256, state)
    SELECT c.organization_id, c.sha256, 'pending'
    FROM (SELECT DISTINCT f.organization_id, f.sha256 FROM public.stored_files f
          WHERE NOT EXISTS (SELECT 1 FROM public.file_scans s
                            WHERE s.organization_id = f.organization_id AND s.sha256 = f.sha256)
          LIMIT ${limit}::integer) c
    ON CONFLICT (organization_id, sha256) DO NOTHING`);
}

/** A content the queue took to scan. */
export interface ClaimedScan {
  readonly organizationId: OrganizationId;
  readonly sha256: string;
  readonly size: number;
  readonly attempts: number;
}

/**
 * Takes the next due content (pending, or failed and due again) that some
 * stored file still names, and moves its next attempt `leaseSeconds` ahead,
 * so no other worker takes it meanwhile and a crash only delays it. A job
 * over every organization. `undefined` when nothing is due.
 */
export async function claimDueScan(
  db: Queryable,
  leaseSeconds: number,
): Promise<ClaimedScan | undefined> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new TypeError("Not a lease.");
  }
  const rows = await db.rows<{
    organization_id: string;
    sha256: string;
    attempts: number;
    size: number | null;
  }>(sql`
    WITH next AS (
      SELECT s.organization_id, s.sha256 FROM public.file_scans s
      WHERE s.state IN ('pending', 'failed') AND s.next_attempt_at <= clock_timestamp()
        AND EXISTS (SELECT 1 FROM public.stored_files f
                    WHERE f.organization_id = s.organization_id AND f.sha256 = s.sha256)
      ORDER BY s.next_attempt_at
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE public.file_scans s
    SET next_attempt_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}::integer)
    FROM next
    WHERE s.organization_id = next.organization_id AND s.sha256 = next.sha256
    RETURNING s.organization_id::text AS organization_id, s.sha256, s.attempts,
      (SELECT f.byte_size FROM public.stored_files f
       WHERE f.organization_id = s.organization_id AND f.sha256 = s.sha256
       LIMIT 1)::float8 AS size`);
  const row = rows[0];
  if (row === undefined) return undefined;
  if (!isOrganizationId(row.organization_id) || !isSha256Hex(row.sha256) || row.size === null) {
    throw new Error("A claimed scan doesn't read as one.");
  }
  return Object.freeze({
    organizationId: row.organization_id,
    sha256: row.sha256,
    size: row.size,
    attempts: row.attempts,
  });
}

/** What a scan found, as `recordScanResult` stores it. */
export type ScanResult =
  | { readonly state: "clean" }
  | { readonly state: "infected"; readonly signature: string }
  | {
      readonly state: "failed";
      readonly failure: ScanFailure;
      /** Seconds until it is tried again; `null` for never by itself (until a rescan). */
      readonly retryInSeconds: number | null;
    };

/**
 * Stores a scan's result and logs it (`file_scan_events`). An infected
 * content is quarantined (its first quarantine time kept); a content
 * already infected is never changed by a later result (`false`).
 */
export async function recordScanResult(
  tx: Queryable,
  organizationId: OrganizationId,
  sha256: string,
  result: ScanResult,
  actor: string,
): Promise<boolean> {
  checkOrganization(organizationId);
  checkHash(sha256);
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  let changed: number;
  switch (result.state) {
    case "clean":
      changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = 'clean', failure = NULL, attempts = 0, next_attempt_at = NULL,
          scanned_at = clock_timestamp()
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected'`);
      if (changed > 0) {
        await tx.execute(sql`
          INSERT INTO public.file_scan_events (organization_id, id, kind, sha256, actor)
          VALUES (${organizationId}::uuid, gen_random_uuid(), 'clean', ${sha256}, ${actor})`);
      }
      break;
    case "infected": {
      if (!isScanSignature(result.signature)) throw new TypeError("Not a signature name.");
      changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = 'infected', failure = NULL, signature = ${result.signature},
          next_attempt_at = NULL, scanned_at = clock_timestamp(),
          quarantined_at = coalesce(quarantined_at, clock_timestamp())
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected'`);
      if (changed > 0) {
        await tx.execute(sql`
          INSERT INTO public.file_scan_events (organization_id, id, kind, sha256, signature, actor)
          VALUES (${organizationId}::uuid, gen_random_uuid(), 'infected', ${sha256},
            ${result.signature}, ${actor})`);
      }
      break;
    }
    case "failed": {
      if (!(SCAN_FAILURES as readonly string[]).includes(result.failure)) {
        throw new TypeError("Not a scan failure.");
      }
      const retry = result.retryInSeconds;
      if (retry !== null && (!Number.isSafeInteger(retry) || retry < 1)) {
        throw new TypeError("Not a retry time.");
      }
      changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = 'failed', failure = ${result.failure},
          attempts = least(attempts + 1, 1000000),
          next_attempt_at = CASE WHEN ${retry}::integer IS NULL THEN NULL
            ELSE clock_timestamp() + make_interval(secs => ${retry}::integer) END
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected'`);
      if (changed > 0) {
        await tx.execute(sql`
          INSERT INTO public.file_scan_events (organization_id, id, kind, sha256, failure, actor)
          VALUES (${organizationId}::uuid, gen_random_uuid(), 'failed', ${sha256},
            ${result.failure}, ${actor})`);
      }
      break;
    }
    default:
      throw new TypeError("Not a scan result.");
  }
  return changed > 0;
}

/**
 * Puts every clean and failed content of the organization back in the
 * queue (after the scanner's signatures were updated, say), and logs the
 * request. Infected contents stay quarantined; pending ones are queued
 * already. Answers how many were queued.
 */
export async function rescanContents(
  tx: Queryable,
  organizationId: OrganizationId,
  actor: string,
): Promise<number> {
  checkOrganization(organizationId);
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  const queued = await tx.execute(sql`
    UPDATE public.file_scans
    SET state = 'pending', failure = NULL, attempts = 0, next_attempt_at = clock_timestamp()
    WHERE organization_id = ${organizationId}::uuid AND state IN ('clean', 'failed')`);
  await tx.execute(sql`
    INSERT INTO public.file_scan_events (organization_id, id, kind, queued, actor)
    VALUES (${organizationId}::uuid, gen_random_uuid(), 'rescan', ${queued}::integer, ${actor})`);
  return queued;
}

/** How many of the organization's stored contents are in each state. */
export interface ScanCounts {
  readonly pending: number;
  readonly clean: number;
  readonly infected: number;
  readonly failed: number;
  /** Stored contents with no scan result at all. */
  readonly unscanned: number;
}

/** Counts by state over the contents some stored file of the organization names. */
export async function scanCounts(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<ScanCounts> {
  checkOrganization(organizationId);
  const rows = await db.rows<{ state: string | null; n: number }>(sql`
    SELECT s.state, count(*)::integer AS n
    FROM (SELECT DISTINCT f.sha256 FROM public.stored_files f
          WHERE f.organization_id = ${organizationId}::uuid) c
    LEFT JOIN public.file_scans s
      ON s.organization_id = ${organizationId}::uuid AND s.sha256 = c.sha256
    GROUP BY s.state`);
  const count = (state: string | null): number => rows.find((r) => r.state === state)?.n ?? 0;
  return Object.freeze({
    pending: count("pending"),
    clean: count("clean"),
    infected: count("infected"),
    failed: count("failed"),
    unscanned: count(null),
  });
}
