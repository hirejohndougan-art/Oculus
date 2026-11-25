/**
 * Stored accessions and donor contacts (T-018c, D-114): the rows of
 * `0046_accessions.sql`. Core validates every definition (accessions.ts:
 * `indexAccessions`, `validateDonorContact`); who may read and change them
 * is the service's (packages/service `accessions.ts`: Donor relations,
 * D-036). These functions only read and write, each in the caller's
 * transaction, always within one organization.
 *
 * - `readAccession`, `listAccessions` read definitions with their versions;
 *   `insertAccession` and `updateAccession` (expected version) save one;
 *   a number already used is `duplicate_number`.
 * - `readAccessionHolds` gives, for the publish check, only what core's
 *   deed check needs (`AccessionHold`: deed status, access restriction,
 *   produced records among `ids`), locked `FOR SHARE` on request.
 * - `readDonorContact`, `saveDonorContact`, `deleteDonorContact`.
 *
 * STAFF ONLY: nothing here may reach a public reply (the public output gets
 * holds through `public_record_snapshot` only).
 */
import {
  isOrganizationId,
  isRecordId,
  validateRecord,
  type Accession,
  type AccessionHold,
  type CatalogRecord,
  type DonorContact,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import { readRecordClosure } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * The writer's privileges (roles.ts): accessions are made and changed, never
 * deleted here; donor contacts may be deleted. `accession_records` and
 * `accession_versions` are written by the migration's trigger, not the
 * writer.
 */
export const ACCESSION_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    accessions: ["INSERT", "UPDATE"],
    donor_contacts: ["INSERT", "UPDATE", "DELETE"],
  });

/** The most accessions `listAccessions` reads at once. */
export const MAX_ACCESSION_PAGE = 200;

/** A stored accession: its core definition and its row's bookkeeping. */
export interface StoredAccession {
  readonly definition: unknown;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** A stored donor contact. */
export interface StoredDonorContact {
  readonly definition: unknown;
  readonly version: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

interface AccessionRow {
  definition: unknown;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

function stored(row: AccessionRow): StoredAccession {
  return Object.freeze({
    definition: row.definition,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
}

const COLUMNS = sql`definition, version, created_by::text AS created_by,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  updated_by::text AS updated_by,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

/** A thrown database error's SQLSTATE and constraint, if it has them. */
function pgError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== "object" || error === null) return {};
  const e = error as { code?: unknown; constraint?: unknown };
  return {
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.constraint === "string" ? { constraint: e.constraint } : {}),
  };
}

/** The organization's accession `id`, or undefined. With `lock`, its row is locked `FOR UPDATE`. */
export async function readAccession(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<StoredAccession | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(id)) return undefined;
  const query = sql`SELECT ${COLUMNS} FROM public.accessions
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid`;
  const [row] = await db.rows<AccessionRow>(
    options.lock === true ? sql`${query} FOR UPDATE` : query,
  );
  return row === undefined ? undefined : stored(row);
}

/**
 * A page of the organization's accessions, newest first (by when they were
 * made, then ID); `before` is the last ID of the page before.
 */
export async function listAccessions(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly before?: string; readonly limit?: number } = {},
): Promise<readonly StoredAccession[]> {
  if (!isOrganizationId(organizationId)) return [];
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? MAX_ACCESSION_PAGE)), 1000);
  const before = options.before;
  const after =
    before !== undefined && isRecordId(before)
      ? sql`AND (created_at, id) < (SELECT created_at, id FROM public.accessions
                                     WHERE organization_id = ${organizationId}::uuid
                                       AND id = ${before}::uuid)`
      : sql``;
  const rows = await db.rows<AccessionRow>(sql`
    SELECT ${COLUMNS} FROM public.accessions
    WHERE organization_id = ${organizationId}::uuid ${after}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}`);
  return Object.freeze(rows.map(stored));
}

/** The accessions that produced `recordId`, oldest first. */
export async function accessionsProducing(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<readonly StoredAccession[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return [];
  const rows = await db.rows<AccessionRow>(sql`
    SELECT ${COLUMNS} FROM public.accessions a
    WHERE a.organization_id = ${organizationId}::uuid
      AND EXISTS (SELECT 1 FROM public.accession_records ar
                  WHERE ar.organization_id = a.organization_id AND ar.accession_id = a.id
                    AND ar.record_id = ${recordId}::uuid)
    ORDER BY a.created_at, a.id`);
  return Object.freeze(rows.map(stored));
}

export type SaveOutcome =
  | { readonly ok: true; readonly value: StoredAccession }
  | {
      readonly ok: false;
      readonly code: "duplicate_number" | "version_conflict" | "missing_record";
    };

/** Saves a new accession (version 1) made by `userId`. */
export async function insertAccession(
  db: Queryable,
  accession: Accession,
  numberKey: string,
  userId: string,
): Promise<SaveOutcome> {
  try {
    const [row] = await db.rows<AccessionRow>(sql`
      INSERT INTO public.accessions (organization_id, id, definition, number_key, created_by,
                                     updated_by)
      VALUES (${accession.organizationId}::uuid, ${accession.id}::uuid,
              ${JSON.stringify(accession)}::jsonb, ${numberKey}, ${userId}::uuid, ${userId}::uuid)
      RETURNING ${COLUMNS}`);
    if (row === undefined) throw new Error("the accession was not saved");
    return { ok: true, value: stored(row) };
  } catch (error) {
    return refusedSave(error);
  }
}

/** Replaces the accession's definition if its version is still `expectedVersion`. */
export async function updateAccession(
  db: Queryable,
  accession: Accession,
  numberKey: string,
  userId: string,
  expectedVersion: number,
): Promise<SaveOutcome> {
  try {
    const [row] = await db.rows<AccessionRow>(sql`
      UPDATE public.accessions
      SET definition = ${JSON.stringify(accession)}::jsonb, number_key = ${numberKey},
          version = version + 1, updated_by = ${userId}::uuid
      WHERE organization_id = ${accession.organizationId}::uuid AND id = ${accession.id}::uuid
        AND version = ${expectedVersion}
      RETURNING ${COLUMNS}`);
    return row === undefined
      ? { ok: false, code: "version_conflict" }
      : { ok: true, value: stored(row) };
  } catch (error) {
    return refusedSave(error);
  }
}

function refusedSave(error: unknown): SaveOutcome {
  const e = pgError(error);
  if (e.code === "23505" && e.constraint === "accessions_number_unique") {
    return { ok: false, code: "duplicate_number" };
  }
  // A produced record or the source deleted meanwhile (the foreign keys).
  if (e.code === "23503") return { ok: false, code: "missing_record" };
  throw error;
}

/**
 * The organization's accession holds lock (D-114), a transaction-level
 * advisory lock (classid 114): every accession save takes it exclusive
 * before anything else, and a publish check that locks takes it shared
 * before it reads the holds. So a publish and a save never pass each other:
 * the publish's check sees the saved accession, or the save's `nowHeld`
 * sees the committed publish.
 */
export async function lockAccessionHolds(
  db: Queryable,
  organizationId: OrganizationId,
  mode: "shared" | "exclusive",
): Promise<void> {
  await db.rows(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(114, hashtext(${organizationId}::text))`
      : sql`SELECT pg_advisory_xact_lock(114, hashtext(${organizationId}::text))`,
  );
}

/**
 * The holds of the accessions that produced any of `ids` (D-114): only
 * their deed status, access restriction and which of `ids` they produced.
 * With `lock`, the organization's holds lock is taken shared first
 * (`lockAccessionHolds`), so no accession save runs until the caller
 * commits, and the caller waits for one in flight.
 */
export async function readAccessionHolds(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
  options: { readonly lock?: boolean } = {},
): Promise<readonly AccessionHold[] | undefined> {
  if (!isOrganizationId(organizationId) || ids.length === 0) return [];
  const wanted = ids.filter((id) => isRecordId(id));
  if (options.lock === true) await lockAccessionHolds(db, organizationId, "shared");
  const [row] = await db.rows<{ holds: unknown }>(sql`
    SELECT public.accession_holds_of(${organizationId}::uuid, ${wanted}::uuid[]) AS holds`);
  return holdsFrom(row?.holds);
}

/**
 * The holds in `accession_holds_of`'s shape, as core's `indexAccessionHolds`
 * takes them (a null restriction left out). Core checks them; this only
 * reshapes.
 */
export function holdsFrom(value: unknown): readonly AccessionHold[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.freeze(
    value.map((h: unknown) => {
      const entry = (typeof h === "object" && h !== null ? h : {}) as Record<string, unknown>;
      const restriction = entry.accessRestriction;
      return {
        deedStatus: entry.deedStatus,
        ...(restriction === null || restriction === undefined
          ? {}
          : { accessRestriction: restriction }),
        records: Array.isArray(entry.records) ? entry.records : [],
      } as unknown as AccessionHold;
    }),
  );
}

/** Whether `recordId` is named by an accession, as produced or as its source, or has a donor contact. */
export async function accessionUses(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<{ readonly produced: boolean; readonly source: boolean }> {
  const [row] = await db.rows<{ produced: boolean; source: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM public.accession_records
              WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid)
        AS produced,
      EXISTS (SELECT 1 FROM public.accessions
              WHERE organization_id = ${organizationId}::uuid
                AND source_agent_id = ${recordId}::uuid)
      OR EXISTS (SELECT 1 FROM public.donor_contacts
                 WHERE organization_id = ${organizationId}::uuid
                   AND agent_id = ${recordId}::uuid) AS source`);
  return { produced: row?.produced === true, source: row?.source === true };
}

// ---------------------------------------------------------------- contacts

interface ContactRow {
  definition: unknown;
  version: number;
  updated_by: string;
  updated_at: string;
}

const CONTACT_COLUMNS = sql`definition, version, updated_by::text AS updated_by,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

function storedContact(row: ContactRow): StoredDonorContact {
  return Object.freeze({
    definition: row.definition,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
}

/** The donor contact of the organization's agent `agentId`, or undefined. */
export async function readDonorContact(
  db: Queryable,
  organizationId: OrganizationId,
  agentId: string,
): Promise<StoredDonorContact | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(agentId)) return undefined;
  const [row] = await db.rows<ContactRow>(sql`
    SELECT ${CONTACT_COLUMNS} FROM public.donor_contacts
    WHERE organization_id = ${organizationId}::uuid AND agent_id = ${agentId}::uuid`);
  return row === undefined ? undefined : storedContact(row);
}

/**
 * Saves `contact`: a new one when `expectedVersion` is 0, otherwise only if
 * the stored one is still at that version.
 */
export async function saveDonorContact(
  db: Queryable,
  contact: DonorContact,
  userId: string,
  expectedVersion: number,
): Promise<
  | { readonly ok: true; readonly value: StoredDonorContact }
  | { readonly ok: false; readonly code: "version_conflict" | "missing_record" }
> {
  try {
    const rows =
      expectedVersion === 0
        ? await db.rows<ContactRow>(sql`
            INSERT INTO public.donor_contacts (organization_id, agent_id, definition, updated_by)
            VALUES (${contact.organizationId}::uuid, ${contact.agentId}::uuid,
                    ${JSON.stringify(contact)}::jsonb, ${userId}::uuid)
            ON CONFLICT (organization_id, agent_id) DO NOTHING
            RETURNING ${CONTACT_COLUMNS}`)
        : await db.rows<ContactRow>(sql`
            UPDATE public.donor_contacts
            SET definition = ${JSON.stringify(contact)}::jsonb, version = version + 1,
                updated_by = ${userId}::uuid
            WHERE organization_id = ${contact.organizationId}::uuid
              AND agent_id = ${contact.agentId}::uuid AND version = ${expectedVersion}
            RETURNING ${CONTACT_COLUMNS}`);
    const [row] = rows;
    return row === undefined
      ? { ok: false, code: "version_conflict" }
      : { ok: true, value: storedContact(row) };
  } catch (error) {
    if (pgError(error).code === "23503") return { ok: false, code: "missing_record" };
    throw error;
  }
}

/** Deletes the contact if it is still at `expectedVersion`; true if it was deleted. */
export async function deleteDonorContact(
  db: Queryable,
  organizationId: OrganizationId,
  agentId: string,
  expectedVersion: number,
): Promise<boolean> {
  if (!isOrganizationId(organizationId) || !isRecordId(agentId)) return false;
  return (
    (await db.execute(sql`
      DELETE FROM public.donor_contacts
      WHERE organization_id = ${organizationId}::uuid AND agent_id = ${agentId}::uuid
        AND version = ${expectedVersion}`)) === 1
  );
}

/**
 * The organization's records `ids` as core reads them (with their
 * ancestry), for checking an accession's links; an unreadable row is left
 * out (core then refuses the link to it).
 */
export async function readAccessionRecords(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<readonly CatalogRecord[] | undefined> {
  const wanted = [...new Set(ids.filter((id) => isRecordId(id)))];
  const rows = await readRecordClosure(db, organizationId, wanted);
  if (rows === undefined) return undefined;
  const out: CatalogRecord[] = [];
  for (const row of rows) {
    const valid = validateRecord(row);
    if (valid.ok) out.push(valid.value);
  }
  return Object.freeze(out);
}

/**
 * Of `ids` and everything below them (units filed under them, digital
 * assets that represent any of those), the records published now: what an
 * accession that holds would hold back (D-043's T-034 note).
 */
export async function publishedBelow(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<readonly RecordId[]> {
  const wanted = ids.filter((id) => isRecordId(id));
  if (!isOrganizationId(organizationId) || wanted.length === 0) return [];
  const rows = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE down(id) AS (
      SELECT unnest(${wanted}::uuid[])
      UNION
      SELECT r.id FROM public.records r JOIN down ON r.organization_id = ${organizationId}::uuid
        AND (r.parent_id = down.id OR r.represents_id = down.id)
    )
    SELECT r.id::text AS id FROM public.records r JOIN down ON r.id = down.id
    WHERE r.organization_id = ${organizationId}::uuid AND r.workflow_state = 'published'
    ORDER BY r.id
    LIMIT 10001`);
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/** Whether another accession than `accessionId` has ever had `numberKey` (all_time types). */
export async function numberUsedBefore(
  db: Queryable,
  organizationId: OrganizationId,
  numberKey: string,
  accessionId: string,
): Promise<boolean> {
  const [row] = await db.rows<{ used: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.accession_numbers
                   WHERE organization_id = ${organizationId}::uuid
                     AND number_key = ${numberKey}
                     AND accession_id <> ${accessionId}::uuid) AS used`);
  return row?.used === true;
}

/**
 * The home sites of `ids` and of everything below them (units filed under
 * them, digital assets representing any of those): what an accession naming
 * `ids` would hold back. `null` stands for a record on no site.
 */
export async function sitesBelow(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<readonly (string | null)[]> {
  const wanted = ids.filter((id) => isRecordId(id));
  if (!isOrganizationId(organizationId) || wanted.length === 0) return [];
  const rows = await db.rows<{ site_id: string | null }>(sql`
    WITH RECURSIVE down(id) AS (
      SELECT unnest(${wanted}::uuid[])
      UNION
      SELECT r.id FROM public.records r JOIN down ON r.organization_id = ${organizationId}::uuid
        AND (r.parent_id = down.id OR r.represents_id = down.id)
    )
    SELECT DISTINCT r.site_id::text AS site_id FROM public.records r JOIN down ON r.id = down.id
    WHERE r.organization_id = ${organizationId}::uuid
    LIMIT 1000`);
  return Object.freeze(rows.map((r) => r.site_id));
}
