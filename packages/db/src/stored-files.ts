/**
 * Stored files (M-002, D-086): the rows saying which digital asset holds
 * which content (`public.stored_files`, migration 0025). The bytes are on
 * disk, named by organization and SHA-256 only (service `file-store.ts`);
 * nothing here touches the file system.
 *
 * ===========================================================================
 * STAFF ONLY: original file names and who attached what. Never for a public
 * site (M-003 decides what a public site may show of a file).
 * ===========================================================================
 *
 * Every query names one organization (D-019). The service is the only
 * writer (D-067): it checks the person may edit the asset, locks the
 * organization's files (`lockOrganizationFiles`), checks the organization's
 * total, then inserts.
 */
import {
  isClaimedMediaType,
  isOrganizationId,
  isRecordId,
  isSha256Hex,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { isActorId } from "./record-versions.js";
import { sql } from "./sql.js";

/**
 * What the writer may do to the table (D-067's allowlist): insert a file,
 * delete one (removing it from its asset); never change one.
 */
export const STORED_FILE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    stored_files: Object.freeze(["INSERT", "DELETE"]),
    // Every attach and removal, append-only (0026).
    stored_file_events: Object.freeze(["INSERT"]),
    // The files folder's install ID, made once (0026).
    file_store_binding: Object.freeze(["INSERT"]),
    // The folder's lease, a new epoch at each start, hour and purge (0026).
    file_store_epochs: Object.freeze(["INSERT"]),
  });

/** One file attached to a digital asset. */
export interface StoredFile {
  readonly id: string;
  readonly recordId: RecordId;
  readonly sha256: string;
  /** Bytes. */
  readonly size: number;
  /** Sniffed from the bytes (core `sniffMediaType`). */
  readonly mediaType: string;
  /** What the client said it was, a hint only; `null` when it said nothing usable. */
  readonly claimedType: string | null;
  /** The name it was uploaded with: metadata, shown as text only. */
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface NewStoredFile {
  readonly organizationId: OrganizationId;
  readonly id: string;
  readonly recordId: RecordId;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly claimedType: string | null;
  readonly name: string;
  readonly createdBy: string;
  /** Whole milliseconds. */
  readonly createdAt: Date;
}

interface FileRow {
  id: string;
  record_id: string;
  sha256: string;
  byte_size: number;
  media_type: string;
  claimed_type: string | null;
  original_name: string;
  created_by: string;
  created_at: string;
}

const COLUMNS = sql`
  f.id::text AS id, f.record_id::text AS record_id, f.sha256, f.byte_size::float8 AS byte_size,
  f.media_type, f.claimed_type, f.original_name, f.created_by,
  to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

function fromRow(row: FileRow): StoredFile {
  if (!isRecordId(row.record_id) || !isSha256Hex(row.sha256)) {
    throw new Error("A stored file row doesn't read as a stored file.");
  }
  return Object.freeze({
    id: row.id,
    recordId: row.record_id,
    sha256: row.sha256,
    size: row.byte_size,
    mediaType: row.media_type,
    claimedType: row.claimed_type,
    name: row.original_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

function checkOrganization(organizationId: unknown): void {
  if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
}

/**
 * Takes the organization's file lock until the transaction ends (exclusive,
 * advisory, classid 69: 65 to 67 are the arrangement and definition locks,
 * 68 the invitations', 85 T-040's alert notices).
 * Every attach takes it before reading the total, so two uploads can't both
 * pass the organization's cap, and the copy on disk is placed while it is
 * held.
 */
export async function lockOrganizationFiles(
  tx: Queryable,
  organizationId: OrganizationId,
): Promise<void> {
  checkOrganization(organizationId);
  await tx.rows(sql`SELECT pg_advisory_xact_lock(69, hashtext(${organizationId}::text))`);
}

/** Bytes the organization stores: each content counted once, however many assets hold it. */
export async function organizationFileBytes(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<number> {
  checkOrganization(organizationId);
  const rows = await db.rows<{ total: number }>(sql`
    SELECT coalesce(sum(byte_size), 0)::float8 AS total
    FROM (
      SELECT DISTINCT ON (sha256) byte_size
      FROM public.stored_files
      WHERE organization_id = ${organizationId}::uuid
      ORDER BY sha256
    ) contents`);
  return rows[0]?.total ?? 0;
}

/** Whether the organization already stores this content (so attaching it adds no bytes). */
export async function organizationHasContent(
  db: Queryable,
  organizationId: OrganizationId,
  sha256: string,
): Promise<boolean> {
  checkOrganization(organizationId);
  if (!isSha256Hex(sha256)) throw new TypeError("Not a SHA-256.");
  const rows = await db.rows(sql`
    SELECT 1 FROM public.stored_files
    WHERE organization_id = ${organizationId}::uuid AND sha256 = ${sha256}
    LIMIT 1`);
  return rows.length > 0;
}

/** The asset's file with this content, if it has one. */
export async function findStoredFile(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  sha256: string,
): Promise<StoredFile | undefined> {
  checkOrganization(organizationId);
  if (!isRecordId(recordId) || !isSha256Hex(sha256)) return undefined;
  const rows = await db.rows<FileRow>(sql`
    SELECT ${COLUMNS} FROM public.stored_files f
    WHERE f.organization_id = ${organizationId}::uuid AND f.record_id = ${recordId}::uuid
      AND f.sha256 = ${sha256}`);
  const row = rows[0];
  return row === undefined ? undefined : fromRow(row);
}

/** The most files one asset lists. */
export const MAX_FILES_PER_LIST = 1000;

/** STAFF ONLY: the asset's files, oldest first (at most `MAX_FILES_PER_LIST`). */
export async function listStoredFiles(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<readonly StoredFile[]> {
  checkOrganization(organizationId);
  if (!isRecordId(recordId)) return [];
  const rows = await db.rows<FileRow>(sql`
    SELECT ${COLUMNS} FROM public.stored_files f
    WHERE f.organization_id = ${organizationId}::uuid AND f.record_id = ${recordId}::uuid
    ORDER BY f.created_at, f.id
    LIMIT ${MAX_FILES_PER_LIST}::integer`);
  return Object.freeze(rows.map(fromRow));
}

/**
 * Inserts one stored file row. The caller (the service) has checked the
 * person, the asset and the organization's total under
 * `lockOrganizationFiles`; the database checks the asset is a digital asset
 * and that one content has one size (0025).
 */
export async function insertStoredFile(tx: Queryable, file: NewStoredFile): Promise<StoredFile> {
  checkOrganization(file.organizationId);
  if (!isRecordId(file.recordId) || !isRecordId(file.id)) throw new TypeError("Not an ID.");
  if (!isSha256Hex(file.sha256)) throw new TypeError("Not a SHA-256.");
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new TypeError("Not a size.");
  if (!isClaimedMediaType(file.mediaType)) throw new TypeError("Not a media type.");
  if (file.claimedType !== null && !isClaimedMediaType(file.claimedType)) {
    throw new TypeError("Not a media type.");
  }
  if (!isActorId(file.createdBy)) throw new TypeError("Not an actor.");
  const rows = await tx.rows<FileRow>(sql`
    INSERT INTO public.stored_files AS f (organization_id, id, record_id, sha256, byte_size,
      media_type, claimed_type, original_name, created_by, created_at)
    VALUES (${file.organizationId}::uuid, ${file.id}::uuid, ${file.recordId}::uuid, ${file.sha256},
      ${file.size}::bigint, ${file.mediaType}, ${file.claimedType}, ${file.name}, ${file.createdBy},
      ${file.createdAt}::timestamptz)
    RETURNING ${COLUMNS}`);
  const row = rows[0];
  if (row === undefined) throw new Error("The stored file wasn't inserted.");
  return fromRow(row);
}

/**
 * Removes one file from its asset: `true` if the row was there. The copy on
 * disk stays until the sweep finds that no row names its content.
 */
export async function deleteStoredFile(
  tx: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  fileId: string,
): Promise<boolean> {
  checkOrganization(organizationId);
  if (!isRecordId(recordId) || !isRecordId(fileId)) return false;
  const deleted = await tx.execute(sql`
    DELETE FROM public.stored_files
    WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid
      AND id = ${fileId}::uuid`);
  return deleted > 0;
}

/** Which of these contents some row of the organization still names. */
export async function namedContents(
  db: Queryable,
  organizationId: OrganizationId,
  hashes: readonly string[],
): Promise<ReadonlySet<string>> {
  checkOrganization(organizationId);
  const wanted = hashes.filter((h) => isSha256Hex(h));
  if (wanted.length === 0) return new Set();
  const rows = await db.rows<{ sha256: string }>(sql`
    SELECT DISTINCT sha256 FROM public.stored_files
    WHERE organization_id = ${organizationId}::uuid AND sha256 = ANY(${wanted}::text[])`);
  return new Set(rows.map((r) => r.sha256));
}

/** One file of an asset by its ID, if the asset has it. */
export async function findStoredFileById(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  fileId: string,
): Promise<StoredFile | undefined> {
  checkOrganization(organizationId);
  if (!isRecordId(recordId) || !isRecordId(fileId)) return undefined;
  const rows = await db.rows<FileRow>(sql`
    SELECT ${COLUMNS} FROM public.stored_files f
    WHERE f.organization_id = ${organizationId}::uuid AND f.record_id = ${recordId}::uuid
      AND f.id = ${fileId}::uuid`);
  const row = rows[0];
  return row === undefined ? undefined : fromRow(row);
}

/** What happened to a file: `stored_file_events`' kinds. */
export const STORED_FILE_EVENT_KINDS = ["placing", "attached", "removed"] as const;
export type StoredFileEventKind = (typeof STORED_FILE_EVENT_KINDS)[number];

/** Logs an attach or a removal (the database stamps the time). */
export async function insertStoredFileEvent(
  tx: Queryable,
  organizationId: OrganizationId,
  kind: StoredFileEventKind,
  file: Pick<StoredFile, "id" | "recordId" | "sha256" | "size">,
  actor: string,
): Promise<void> {
  checkOrganization(organizationId);
  if (!(STORED_FILE_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError("Not an event kind.");
  }
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  await tx.execute(sql`
    INSERT INTO public.stored_file_events (organization_id, id, kind, file_id, record_id, sha256,
      byte_size, actor)
    VALUES (${organizationId}::uuid, gen_random_uuid(), ${kind}, ${file.id}::uuid,
      ${file.recordId}::uuid, ${file.sha256}, ${file.size}::bigint, ${actor})`);
}

/** How long a removed file's bytes stay on disk before the purge may take them. */
export const REMOVED_FILE_GRACE_SECONDS = 7 * 24 * 3600;
/** How long a copy placed by an attach that never committed stays before the purge may take it. */
export const PLACING_GRACE_SECONDS = 24 * 3600;

/** One content the purge would delete, with what this database last did with it. */
export interface PurgeCandidate {
  readonly sha256: string;
  readonly size: number;
  readonly lastEvent: "removed" | "placing";
  readonly lastEventAt: string;
}

/**
 * The contents among `hashes` the operator's purge may delete (D-086,
 * fourth review), **denying by default**. Events before `since` (the last
 * `files:adopt`) count as if they didn't exist. A content qualifies only if
 * no row names it and either
 * - this database's newest event for it is a removal older than
 *   `REMOVED_FILE_GRACE_SECONDS` (so no placing or attach came after it); or
 * - its newest event is a placing (an attach that never committed) older
 *   than `PLACING_GRACE_SECONDS`, and no removal of it happened within the
 *   last `REMOVED_FILE_GRACE_SECONDS` (a failed attach never shortens a
 *   removal's grace).
 * Everything else, content with no event here included, is kept.
 */
export async function purgeCandidates(
  db: Queryable,
  organizationId: OrganizationId,
  hashes: readonly string[],
  since: string | null,
): Promise<readonly PurgeCandidate[]> {
  checkOrganization(organizationId);
  const wanted = hashes.filter((h) => isSha256Hex(h));
  if (wanted.length === 0) return [];
  const rows = await db.rows<{
    sha256: string;
    kind: string;
    at: string;
    size: number;
    old: boolean;
    recent_removal: boolean;
  }>(sql`
    SELECT h.sha256, last.kind, last.byte_size::float8 AS size,
      to_char(last.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      last.occurred_at < clock_timestamp() - make_interval(secs =>
        CASE last.kind WHEN 'removed' THEN ${REMOVED_FILE_GRACE_SECONDS}::integer
                       ELSE ${PLACING_GRACE_SECONDS}::integer END) AS old,
      EXISTS (SELECT 1 FROM public.stored_file_events r
              WHERE r.organization_id = ${organizationId}::uuid AND r.sha256 = h.sha256
                AND r.kind = 'removed'
                AND (${since}::timestamptz IS NULL OR r.occurred_at >= ${since}::timestamptz)
                AND r.occurred_at >= clock_timestamp()
                  - make_interval(secs => ${REMOVED_FILE_GRACE_SECONDS}::integer)) AS recent_removal
    FROM unnest(${wanted}::text[]) AS h(sha256)
    JOIN LATERAL (
      SELECT e.kind, e.occurred_at, e.byte_size FROM public.stored_file_events e
      WHERE e.organization_id = ${organizationId}::uuid AND e.sha256 = h.sha256
        AND (${since}::timestamptz IS NULL OR e.occurred_at >= ${since}::timestamptz)
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    ) last ON true
    WHERE NOT EXISTS (SELECT 1 FROM public.stored_files f
                      WHERE f.organization_id = ${organizationId}::uuid AND f.sha256 = h.sha256)
    ORDER BY h.sha256`);
  const out: PurgeCandidate[] = [];
  for (const row of rows) {
    if (!row.old) continue;
    if (row.kind === "removed") {
      out.push(
        Object.freeze({
          sha256: row.sha256,
          size: row.size,
          lastEvent: "removed",
          lastEventAt: row.at,
        }),
      );
    } else if (row.kind === "placing" && !row.recent_removal) {
      out.push(
        Object.freeze({
          sha256: row.sha256,
          size: row.size,
          lastEvent: "placing",
          lastEventAt: row.at,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** The folder's lease as this database holds it: the newest epoch, and the last adopt's time. */
export interface FileStoreLease {
  readonly epoch: string;
  readonly kind: "bind" | "renew" | "adopt";
  readonly madeAt: string;
  /** The last `files:adopt` (events before it are unknown to the purge), or null. */
  readonly since: string | null;
}

/** The current epoch, or undefined before the folder is first bound. */
export async function readFileStoreLease(db: Queryable): Promise<FileStoreLease | undefined> {
  const rows = await db.rows<{
    epoch: string;
    kind: string;
    made_at: string;
    since: string | null;
  }>(sql`
    SELECT e.epoch::text AS epoch, e.kind,
      to_char(e.made_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS made_at,
      (SELECT to_char(max(a.made_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       FROM public.file_store_epochs a WHERE a.kind = 'adopt') AS since
    FROM public.file_store_epochs e
    ORDER BY e.made_at DESC, e.epoch DESC
    LIMIT 1`);
  const row = rows[0];
  if (row === undefined) return undefined;
  if (row.kind !== "bind" && row.kind !== "renew" && row.kind !== "adopt") {
    throw new Error("A file store epoch doesn't read as one.");
  }
  return Object.freeze({ epoch: row.epoch, kind: row.kind, madeAt: row.made_at, since: row.since });
}

/**
 * Takes the lease's lock until the transaction ends (advisory, classid 70,
 * one key for the whole install), so two starts, renewals or purges of one
 * database never move the epoch past each other.
 */
export async function lockFileStoreLease(tx: Queryable): Promise<void> {
  await tx.rows(sql`SELECT pg_advisory_xact_lock(70, 0)`);
}

/** Records a new epoch (the database stamps the time). */
export async function insertFileStoreEpoch(
  tx: Queryable,
  epoch: string,
  kind: "bind" | "renew" | "adopt",
  databaseIdentity: string,
): Promise<void> {
  if (!isRecordId(epoch)) throw new TypeError("Not an epoch.");
  await tx.execute(sql`
    INSERT INTO public.file_store_epochs (epoch, kind, database_identity)
    VALUES (${epoch}::uuid, ${kind}, ${databaseIdentity})`);
}

/**
 * Something that tells this database apart from a dump of it restored
 * elsewhere, or under the same name: its OID (a restore makes a new
 * database) and, where the role may read it, the cluster's system
 * identifier (a different cluster). A physical clone keeps both; the
 * sweep's deny-by-default rule is what protects that case.
 */
export async function databaseIdentity(db: Queryable): Promise<string> {
  const rows = await db.rows<{ oid: string }>(sql`
    SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname = current_database()`);
  let system = "-";
  try {
    const control = await db.rows<{ id: string }>(sql`
      SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()`);
    system = control[0]?.id ?? "-";
  } catch {
    // Not readable by this role: the OID alone.
  }
  return `${system}:${rows[0]?.oid ?? "-"}`;
}

/** Which of these organization IDs exist in this database. */
export async function existingOrganizations(
  db: Queryable,
  organizationIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = organizationIds.filter((id) => isOrganizationId(id));
  if (wanted.length === 0) return new Set();
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.organizations WHERE id = ANY(${wanted}::uuid[])`);
  return new Set(rows.map((r) => r.id));
}

/** The files folder's install ID this database holds, if it has one yet. */
export async function readFileStoreBinding(db: Queryable): Promise<string | undefined> {
  const rows = await db.rows<{ store_id: string }>(sql`
    SELECT store_id::text AS store_id FROM public.file_store_binding WHERE singleton`);
  return rows[0]?.store_id;
}

/**
 * Records the files folder's install ID, once: returns the ID the database
 * holds afterwards (another server may have made one first).
 */
export async function insertFileStoreBinding(db: Queryable, storeId: string): Promise<string> {
  if (!isRecordId(storeId)) throw new TypeError("Not an ID.");
  await db.execute(sql`
    INSERT INTO public.file_store_binding (singleton, store_id) VALUES (true, ${storeId}::uuid)
    ON CONFLICT (singleton) DO NOTHING`);
  const held = await readFileStoreBinding(db);
  if (held === undefined) throw new Error("The files folder's ID wasn't stored.");
  return held;
}
