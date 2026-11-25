/**
 * Stored files (M-002, D-086): the rows saying which digital asset holds
 * which content (`public.stored_files`, migration 0022). The bytes are on
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
 * advisory, classid 68; 65 to 67 are the arrangement and definition locks).
 * Every attach takes it before reading the total, so two uploads can't both
 * pass the organization's cap, and the copy on disk is placed while it is
 * held.
 */
export async function lockOrganizationFiles(
  tx: Queryable,
  organizationId: OrganizationId,
): Promise<void> {
  checkOrganization(organizationId);
  await tx.rows(sql`SELECT pg_advisory_xact_lock(68, hashtext(${organizationId}::text))`);
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
 * and that one content has one size (0022).
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
