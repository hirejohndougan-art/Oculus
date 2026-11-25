/**
 * Stored files (M-002, D-086): the rows saying which digital asset holds
 * which content (`public.stored_files`, migration 0038). The bytes are on
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
    // Every attach and removal, append-only (0039).
    stored_file_events: Object.freeze(["INSERT"]),
    // The files folder's install ID, made once (0039).
    file_store_binding: Object.freeze(["INSERT"]),
    // The folder's lease, a new epoch at each start, hour and purge (0039).
    file_store_epochs: Object.freeze(["INSERT"]),
    // The purge's two steps, append-only (0042, S-052).
    file_purge_steps: Object.freeze(["INSERT"]),
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

/**
 * STAFF ONLY: one file of the asset by its ID (M-003), `undefined` when the
 * asset has no such file (a malformed ID included).
 */
export async function storedFileById(
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
 * and that one content has one size (0038).
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

/**
 * Logs an attach or a removal (the database stamps the time). A removal
 * also keeps the stored copy's modification time as the file system gave
 * it (`copyMtimeNs`, nanoseconds; S-052): the purge takes the copy only
 * while its time is still that one.
 */
export async function insertStoredFileEvent(
  tx: Queryable,
  organizationId: OrganizationId,
  kind: StoredFileEventKind,
  file: Pick<StoredFile, "id" | "recordId" | "sha256" | "size">,
  actor: string,
  copyMtimeNs?: bigint,
): Promise<void> {
  checkOrganization(organizationId);
  if (!(STORED_FILE_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError("Not an event kind.");
  }
  if (!isActorId(actor)) throw new TypeError("Not an actor.");
  if (copyMtimeNs !== undefined && (kind !== "removed" || copyMtimeNs < 0n)) {
    throw new TypeError("Only a removal keeps the copy's time.");
  }
  const mtime = copyMtimeNs === undefined ? null : copyMtimeNs.toString();
  await tx.execute(sql`
    INSERT INTO public.stored_file_events (organization_id, id, kind, file_id, record_id, sha256,
      byte_size, actor, copy_mtime_ns)
    VALUES (${organizationId}::uuid, gen_random_uuid(), ${kind}, ${file.id}::uuid,
      ${file.recordId}::uuid, ${file.sha256}, ${file.size}::bigint, ${actor}, ${mtime}::bigint)`);
}

/** How long a removed file's bytes stay before the purge may move them to the trash (7 days). */
export const REMOVED_FILE_GRACE_SECONDS = 7 * 24 * 3600;
/** How long a copy stays in the trash before the purge may delete it (24 hours). */
export const TRASH_GRACE_SECONDS = 24 * 3600;

/**
 * A content the purge may move to the trash (step 1), by the database's
 * side of the rules; the file system's side is the service's.
 */
export interface PurgeCandidate {
  readonly sha256: string;
  readonly size: number;
  /** The removal the purge acts on: this database's newest event for the content. */
  readonly removalId: string;
  readonly removedAt: string;
  /** The copy's modification time logged with that removal (nanoseconds). */
  readonly copyMtimeNs: bigint;
}

/**
 * The organization's contents the purge may move to the trash (S-052,
 * D-086), **denying by default**: nothing keeps the content (the one list
 * of what does is the database's `stored_content_kept`, 0042: today a
 * stored_files row; S-040's quarantine adds one line there); this
 * database's newest event for it (counting only events since `since`, the
 * last `files:adopt`) is a removal that logged the copy's time, at least
 * `REMOVED_FILE_GRACE_SECONDS` old by the database's clock; and it isn't
 * in the trash already (its newest purge step after that removal isn't
 * `trashed`). Copies an attach placed but never committed, and content
 * this database has no removal of, are kept. `only` limits it to some
 * contents (a re-check inside a transaction).
 */
export async function purgeCandidates(
  db: Queryable,
  organizationId: OrganizationId,
  since: string | null,
  only?: readonly string[],
): Promise<readonly PurgeCandidate[]> {
  checkOrganization(organizationId);
  const wanted = only === undefined ? null : only.filter((h) => isSha256Hex(h));
  if (wanted?.length === 0) return [];
  const rows = await db.rows<{
    sha256: string;
    size: number;
    removal_id: string;
    removed_at: string;
    copy_mtime_ns: string;
  }>(sql`
    WITH last AS (
      SELECT DISTINCT ON (e.sha256) e.sha256, e.id, e.kind, e.byte_size, e.occurred_at,
        e.copy_mtime_ns
      FROM public.stored_file_events e
      WHERE e.organization_id = ${organizationId}::uuid
        AND (${wanted}::text[] IS NULL OR e.sha256 = ANY(${wanted}::text[]))
        AND (${since}::timestamptz IS NULL OR e.occurred_at >= ${since}::timestamptz)
      ORDER BY e.sha256, e.occurred_at DESC, e.id DESC
    )
    SELECT l.sha256, l.byte_size::float8 AS size, l.id::text AS removal_id,
      to_char(l.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS removed_at,
      l.copy_mtime_ns::text AS copy_mtime_ns
    FROM last l
    WHERE l.kind = 'removed' AND l.copy_mtime_ns IS NOT NULL
      AND l.occurred_at <= clock_timestamp()
        - make_interval(secs => ${REMOVED_FILE_GRACE_SECONDS}::integer)
      AND NOT public.stored_content_kept(${organizationId}::uuid, l.sha256)
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT p.kind FROM public.file_purge_steps p
          WHERE p.organization_id = ${organizationId}::uuid AND p.sha256 = l.sha256
            AND p.removal_id = l.id
          ORDER BY p.occurred_at DESC, p.id DESC LIMIT 1) newest
        WHERE newest.kind IN ('trashed', 'deleted'))
    ORDER BY l.sha256`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        sha256: r.sha256,
        size: r.size,
        removalId: r.removal_id,
        removedAt: r.removed_at,
        copyMtimeNs: BigInt(r.copy_mtime_ns),
      }),
    ),
  );
}

/** A content in the trash, as this database's newest purge step for it says. */
export interface TrashedContent {
  readonly sha256: string;
  readonly size: number;
  readonly removalId: string;
  readonly copyMtimeNs: bigint;
  readonly trashedAt: string;
  /** At least `TRASH_GRACE_SECONDS` in the trash by the database's clock. */
  readonly dayOld: boolean;
  /**
   * The removal is still this database's newest event for the content (no
   * placing or attach since) and nothing keeps it (`stored_content_kept`).
   */
  readonly stillRemoved: boolean;
}

/** The organization's contents whose newest purge step is `trashed` (`only`: some of them). */
export async function trashedContents(
  db: Queryable,
  organizationId: OrganizationId,
  only?: readonly string[],
): Promise<readonly TrashedContent[]> {
  checkOrganization(organizationId);
  const wanted = only === undefined ? null : only.filter((h) => isSha256Hex(h));
  if (wanted?.length === 0) return [];
  const rows = await db.rows<{
    sha256: string;
    size: number;
    removal_id: string;
    copy_mtime_ns: string;
    trashed_at: string;
    day_old: boolean;
    still_removed: boolean;
  }>(sql`
    WITH newest AS (
      SELECT DISTINCT ON (p.sha256) p.sha256, p.kind, p.byte_size, p.removal_id,
        p.copy_mtime_ns, p.occurred_at
      FROM public.file_purge_steps p
      WHERE p.organization_id = ${organizationId}::uuid
        AND (${wanted}::text[] IS NULL OR p.sha256 = ANY(${wanted}::text[]))
      ORDER BY p.sha256, p.occurred_at DESC, p.id DESC
    )
    SELECT n.sha256, n.byte_size::float8 AS size, n.removal_id::text AS removal_id,
      n.copy_mtime_ns::text AS copy_mtime_ns,
      to_char(n.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS trashed_at,
      n.occurred_at <= clock_timestamp() - make_interval(secs => ${TRASH_GRACE_SECONDS}::integer)
        AS day_old,
      (NOT public.stored_content_kept(${organizationId}::uuid, n.sha256)
       AND (SELECT e.id FROM public.stored_file_events e
            WHERE e.organization_id = ${organizationId}::uuid AND e.sha256 = n.sha256
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) = n.removal_id) AS still_removed
    FROM newest n
    WHERE n.kind = 'trashed'
    ORDER BY n.sha256`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        sha256: r.sha256,
        size: r.size,
        removalId: r.removal_id,
        copyMtimeNs: BigInt(r.copy_mtime_ns),
        trashedAt: r.trashed_at,
        dayOld: r.day_old,
        stillRemoved: r.still_removed,
      }),
    ),
  );
}

/** One of the purge's steps for a content (the database stamps the time). */
export async function insertFilePurgeStep(
  tx: Queryable,
  organizationId: OrganizationId,
  step: {
    readonly kind: "trashed" | "deleted" | "restored";
    readonly sha256: string;
    readonly size: number;
    readonly removalId: string;
    readonly copyMtimeNs: bigint;
    readonly epoch: string;
    readonly actor: string;
  },
): Promise<void> {
  checkOrganization(organizationId);
  if (
    !["trashed", "deleted", "restored"].includes(step.kind) ||
    !isSha256Hex(step.sha256) ||
    !isRecordId(step.removalId) ||
    !isRecordId(step.epoch) ||
    step.copyMtimeNs < 0n ||
    !isActorId(step.actor)
  ) {
    throw new TypeError("Not a purge step.");
  }
  await tx.execute(sql`
    INSERT INTO public.file_purge_steps (organization_id, id, kind, sha256, byte_size, removal_id,
      copy_mtime_ns, epoch, actor)
    VALUES (${organizationId}::uuid, gen_random_uuid(), ${step.kind}, ${step.sha256},
      ${step.size}::bigint, ${step.removalId}::uuid, ${step.copyMtimeNs.toString()}::bigint,
      ${step.epoch}::uuid, ${step.actor})`);
}

/** The folder's lease as this database holds it: the newest epoch, and the last adopt's time. */
export interface FileStoreLease {
  readonly epoch: string;
  readonly kind: "bind" | "renew" | "adopt" | "purge";
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
  if (row.kind !== "bind" && row.kind !== "renew" && row.kind !== "adopt" && row.kind !== "purge") {
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
  kind: "bind" | "renew" | "adopt" | "purge",
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
