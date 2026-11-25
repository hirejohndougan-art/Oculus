/**
 * Virus scan results of stored content (S-040, D-113; migration 0041).
 *
 * One row per organization and SHA-256: content is stored once however many
 * assets hold it (D-086), so its scan result is shared by all of them. The
 * service is the only writer (D-067): the attach queues a scan (`pending`),
 * the queue puts contents stored before scanning was turned on in line
 * (`unscanned`, still served), claims due rows and records what the scanner
 * said, and a system manager's rescan asks for every content to be scanned
 * again. **Only an infected verdict takes a served file away:** a clean
 * content asked to be rescanned stays clean while it waits, and a failed
 * scan of a clean or unscanned content leaves it as it was. An infected
 * content is quarantined for good: the database refuses to change it back
 * or to change its signature (`file_scans_quarantine_holds`), and nothing
 * deletes a row.
 *
 * **Rescans during a scan aren't lost:** each rescan request moves the
 * row's `generation` on; the claim hands out the generation it saw, and a
 * clean or failed result claimed under an older one isn't stored (the row
 * stays queued and is scanned again). An infected verdict is always stored.
 *
 * Every query names one organization (D-019), except the queue's jobs,
 * which run over every organization and hand back the one they took.
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
export const SCAN_STATES = ["pending", "unscanned", "clean", "infected", "failed"] as const;
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
  /** When the queue will take it (again); `null` when it won't by itself. */
  readonly nextAttemptAt: string | null;
  /** A clean content waiting to be scanned again. */
  readonly rescanRequested: boolean;
}

interface ScanRow {
  sha256: string;
  state: string;
  failure: string | null;
  signature: string | null;
  attempts: number;
  scanned_at: string | null;
  next_attempt_at: string | null;
  rescan_requested: boolean;
}

const MS = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const COLUMNS = sql`
  s.sha256, s.state, s.failure, s.signature, s.attempts,
  to_char(s.scanned_at AT TIME ZONE 'UTC', ${MS}) AS scanned_at,
  to_char(s.next_attempt_at AT TIME ZONE 'UTC', ${MS}) AS next_attempt_at,
  s.rescan_requested_at IS NOT NULL AS rescan_requested`;

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
    nextAttemptAt: row.next_attempt_at,
    rescanRequested: row.rescan_requested,
  });
}

function checkOrganization(organizationId: unknown): void {
  if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
}

function checkHash(sha256: unknown): void {
  if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
}

function checkGeneration(generation: unknown): void {
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 2_147_483_647
  ) {
    throw new TypeError("Not a scan generation.");
  }
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
 * Queues a newly uploaded content for scanning (`pending`: not served until
 * clean). A content that already has a result keeps it (clean stays clean,
 * infected stays quarantined), except one stored before scanning was turned
 * on and not scanned yet: uploaded again, it waits for its scan like any
 * new upload. `true` when the row was made or moved to pending.
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
    ON CONFLICT (organization_id, sha256) DO UPDATE
    SET state = 'pending', failure = NULL, attempts = 0, next_attempt_at = clock_timestamp()
    WHERE file_scans.state = 'unscanned'`);
  return made > 0;
}

/**
 * Puts up to `limit` stored contents that have no scan result at all
 * (stored before scanning was turned on) in the queue as `unscanned`: still
 * served until their first scan, so turning scanning on locks nothing. A
 * job over every organization; answers how many were queued.
 */
export async function queueUnscanned(tx: Queryable, limit: number): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Not a limit.");
  return tx.execute(sql`
    INSERT INTO public.file_scans (organization_id, sha256, state)
    SELECT c.organization_id, c.sha256, 'unscanned'
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
  /** The row's generation when it was claimed (`recordScanResult` checks it). */
  readonly generation: number;
}

/**
 * Takes the next due content that some stored file still names and that no
 * worker holds, and holds it for `leaseSeconds` (`leased_until`), so no
 * other worker takes it meanwhile, whatever a rescan or an upload does to
 * its next attempt, and a crash only delays it. Organizations take turns: the
 * first after `after` (by ID, going round) that has something due. A job
 * over every organization. `undefined` when nothing is due.
 */
export async function claimDueScan(
  db: Queryable,
  leaseSeconds: number,
  after?: OrganizationId,
): Promise<ClaimedScan | undefined> {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new TypeError("Not a lease.");
  }
  if (after !== undefined) checkOrganization(after);
  const rows = await db.rows<{
    organization_id: string;
    sha256: string;
    attempts: number;
    generation: number;
    size: number | null;
  }>(sql`
    WITH next AS (
      SELECT s.organization_id, s.sha256 FROM public.file_scans s
      WHERE s.state <> 'infected' AND s.next_attempt_at <= clock_timestamp()
        AND (s.leased_until IS NULL OR s.leased_until <= clock_timestamp())
        AND EXISTS (SELECT 1 FROM public.stored_files f
                    WHERE f.organization_id = s.organization_id AND f.sha256 = s.sha256)
      ORDER BY (${after ?? null}::uuid IS NOT NULL AND s.organization_id <= ${after ?? null}::uuid),
        s.organization_id, s.next_attempt_at
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE public.file_scans s
    SET leased_until = clock_timestamp() + make_interval(secs => ${leaseSeconds}::integer)
    FROM next
    WHERE s.organization_id = next.organization_id AND s.sha256 = next.sha256
    RETURNING s.organization_id::text AS organization_id, s.sha256, s.attempts, s.generation,
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
    generation: row.generation,
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

/** What `recordScanResult` did. */
export type RecordedScan =
  /** Stored (and logged). */
  | "stored"
  /** A rescan came in after the claim: not stored; the rescan queued it again. */
  | "stale"
  /** Already infected (or gone): nothing changed. */
  | "unchanged";

/**
 * Stores a scan's result and logs it (`file_scan_events`), for the
 * generation the claim saw:
 * - infected: always (a new verdict takes the file away), quarantined with
 *   its first quarantine time;
 * - clean: only if no rescan came in since the claim; otherwise the row is
 *   queued again at once (`stale`);
 * - failed: the same rule; a pending or failed content becomes failed, while
 *   a clean or unscanned one keeps its state (and stays served) and is
 *   tried again after the backoff.
 * A content already infected never changes (`unchanged`).
 */
export async function recordScanResult(
  tx: Queryable,
  organizationId: OrganizationId,
  sha256: string,
  result: ScanResult,
  actor: string,
  generation: number,
): Promise<RecordedScan> {
  checkOrganization(organizationId);
  checkHash(sha256);
  checkGeneration(generation);
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  const log = async (extra: {
    kind: "clean" | "infected" | "failed";
    signature?: string;
    failure?: ScanFailure;
  }): Promise<void> => {
    await tx.execute(sql`
      INSERT INTO public.file_scan_events (organization_id, id, kind, sha256, signature, failure,
        actor)
      VALUES (${organizationId}::uuid, gen_random_uuid(), ${extra.kind}, ${sha256},
        ${extra.signature ?? null}, ${extra.failure ?? null}, ${actor})`);
  };
  /**
   * A clean or failed result claimed before the latest rescan: nothing is
   * written. The rescan already made the row due; it is taken again when
   * this worker's lease runs out.
   */
  const stale = (): RecordedScan => "stale";
  /** Whether the row is infected (or gone): then nothing changes at all. */
  const isInfected = async (): Promise<boolean> => {
    const rows = await tx.rows<{ state: string }>(sql`
      SELECT state FROM public.file_scans
      WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}`);
    return rows[0] === undefined || rows[0].state === "infected";
  };
  switch (result.state) {
    case "infected": {
      if (!isScanSignature(result.signature)) throw new TypeError("Not a signature name.");
      const changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = 'infected', failure = NULL, signature = ${result.signature},
          next_attempt_at = NULL, rescan_requested_at = NULL, scanned_at = clock_timestamp(),
          leased_until = NULL, quarantined_at = coalesce(quarantined_at, clock_timestamp())
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected'`);
      if (changed === 0) return "unchanged";
      await log({ kind: "infected", signature: result.signature });
      return "stored";
    }
    case "clean": {
      const changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = 'clean', failure = NULL, attempts = 0, next_attempt_at = NULL,
          rescan_requested_at = NULL, scanned_at = clock_timestamp(), leased_until = NULL
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected' AND generation = ${generation}::integer`);
      if (changed === 0) return (await isInfected()) ? "unchanged" : stale();
      await log({ kind: "clean" });
      return "stored";
    }
    case "failed": {
      if (!(SCAN_FAILURES as readonly string[]).includes(result.failure)) {
        throw new TypeError("Not a scan failure.");
      }
      const retry = result.retryInSeconds;
      if (retry !== null && (!Number.isSafeInteger(retry) || retry < 1)) {
        throw new TypeError("Not a retry time.");
      }
      // A clean content not retried by itself (too large, say) is no longer
      // waiting for a rescan: it stays clean.
      const changed = await tx.execute(sql`
        UPDATE public.file_scans
        SET state = CASE WHEN state IN ('clean', 'unscanned') THEN state ELSE 'failed' END,
          failure = ${result.failure},
          attempts = least(attempts + 1, 1000000),
          next_attempt_at = CASE WHEN ${retry}::integer IS NULL THEN NULL
            ELSE clock_timestamp() + make_interval(secs => ${retry}::integer) END,
          rescan_requested_at = CASE WHEN ${retry}::integer IS NULL THEN NULL
            ELSE rescan_requested_at END,
          leased_until = NULL
        WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
          AND state <> 'infected' AND generation = ${generation}::integer`);
      if (changed === 0) return (await isInfected()) ? "unchanged" : stale();
      await log({ kind: "failed", failure: result.failure });
      return "stored";
    }
    default:
      throw new TypeError("Not a scan result.");
  }
}

/**
 * Asks for every content of the organization that a stored file still names
 * to be scanned again (after the scanner's signatures were updated, say),
 * and logs the request. Clean contents stay clean, and served, while they
 * wait; failed ones are tried again now; pending and unscanned ones are
 * queued already, and a scan of them running now is done again. Infected
 * contents stay quarantined. Every touched row's generation moves on, so a
 * scan running now doesn't store an answer from before the request.
 * Answers how many were queued.
 */
export async function rescanContents(
  tx: Queryable,
  organizationId: OrganizationId,
  actor: string,
): Promise<number> {
  checkOrganization(organizationId);
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  const queued = await tx.execute(sql`
    UPDATE public.file_scans s
    SET state = CASE WHEN s.state = 'failed' THEN 'pending' ELSE s.state END,
      failure = NULL, attempts = 0, next_attempt_at = clock_timestamp(),
      rescan_requested_at = CASE WHEN s.state = 'clean' THEN clock_timestamp() END,
      generation = CASE WHEN s.generation >= 2147483647 THEN 0 ELSE s.generation + 1 END
    WHERE s.organization_id = ${organizationId}::uuid AND s.state <> 'infected'
      AND EXISTS (SELECT 1 FROM public.stored_files f
                  WHERE f.organization_id = s.organization_id AND f.sha256 = s.sha256)`);
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
  /** Failed and tried again later. */
  readonly failed: number;
  /** A new upload's scan failed as too large: not served, not tried again by itself. */
  readonly failedTooLarge: number;
  /**
   * Stored before scanning was on, or clean before the scanner's limit was
   * lowered, and too large to scan now: served, never scanned (D-113).
   */
  readonly tooLargeToScan: number;
  /** Stored before scanning was on and not scanned yet (served meanwhile). */
  readonly unscanned: number;
  /** Clean contents waiting to be scanned again (served meanwhile). */
  readonly rescanning: number;
}

/**
 * Counts by state over the contents some stored file of the organization
 * names. With `scanLimitBytes` (scanning on), a clean content larger than
 * it counts as too large to scan.
 */
export async function scanCounts(
  db: Queryable,
  organizationId: OrganizationId,
  scanLimitBytes?: number,
): Promise<ScanCounts> {
  checkOrganization(organizationId);
  if (
    scanLimitBytes !== undefined &&
    (!Number.isSafeInteger(scanLimitBytes) || scanLimitBytes < 1)
  ) {
    throw new TypeError("Not a limit.");
  }
  const rows = await db.rows<{ bucket: string; n: number }>(sql`
    SELECT CASE
        WHEN s.state IN ('unscanned', 'clean') AND s.failure = 'too_large'
          AND s.next_attempt_at IS NULL THEN 'tooLargeToScan'
        WHEN s.state = 'clean' AND ${scanLimitBytes ?? null}::bigint IS NOT NULL
          AND c.size > ${scanLimitBytes ?? null}::bigint THEN 'tooLargeToScan'
        WHEN s.state IS NULL OR s.state = 'unscanned' THEN 'unscanned'
        WHEN s.state = 'failed' AND s.next_attempt_at IS NULL THEN 'failedTooLarge'
        ELSE s.state END AS bucket,
      count(*)::integer AS n
    FROM (SELECT f.sha256, max(f.byte_size) AS size FROM public.stored_files f
          WHERE f.organization_id = ${organizationId}::uuid GROUP BY f.sha256) c
    LEFT JOIN public.file_scans s
      ON s.organization_id = ${organizationId}::uuid AND s.sha256 = c.sha256
    GROUP BY 1
    UNION ALL
    SELECT 'rescanning', count(*)::integer FROM public.file_scans s
    WHERE s.organization_id = ${organizationId}::uuid AND s.state = 'clean'
      AND s.rescan_requested_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.stored_files f
                  WHERE f.organization_id = s.organization_id AND f.sha256 = s.sha256)`);
  const count = (bucket: string): number =>
    rows.filter((r) => r.bucket === bucket).reduce((n, r) => n + r.n, 0);
  return Object.freeze({
    pending: count("pending"),
    clean: count("clean"),
    infected: count("infected"),
    failed: count("failed"),
    failedTooLarge: count("failedTooLarge"),
    tooLargeToScan: count("tooLargeToScan"),
    unscanned: count("unscanned"),
    rescanning: count("rescanning"),
  });
}
