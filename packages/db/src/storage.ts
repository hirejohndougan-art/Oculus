/**
 * Stored storage levels, locations and moves (T-018d, D-115): the rows of
 * `0047_storage.sql`. Core validates the organization's whole storage
 * before every save (storage.ts: `indexLocations`, `indexMoves`, `withMove`,
 * `reindexLocations`); who may do what is the service's (packages/service
 * `storage.ts`). These functions only read and write, each in the caller's
 * transaction, always within one organization.
 *
 * - `lockStorage` takes the organization's storage lock (a transaction-level
 *   advisory lock, classid 115): every save takes it before reading, so each
 *   save validates the storage exactly as it is when it commits.
 * - `readStorage` reads the levels, every location and the whole move log.
 * - `saveStorageLevels`, `saveStorageLocation` (expected version; 0 makes
 *   one), `insertStorageMove` (moves are never changed or deleted).
 *
 * STAFF ONLY: nothing here may reach a public reply.
 */
import { isOrganizationId, isRecordId, type OrganizationId, type RecordId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** The writer's privileges (roles.ts): moves are insert only. */
export const STORAGE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  storage_levels: ["INSERT", "UPDATE"],
  storage_locations: ["INSERT", "UPDATE"],
  storage_moves: ["INSERT"],
});

/** A stored, versioned definition (levels or a location). */
export interface StoredDefinition {
  readonly definition: unknown;
  readonly version: number;
  readonly updatedAt: string;
}

/** The organization's whole storage, as stored. */
export interface StoredStorage {
  /** Undefined until the levels are first saved (core's defaults apply). */
  readonly levels: StoredDefinition | undefined;
  readonly locations: readonly StoredDefinition[];
  readonly moves: readonly unknown[];
}

/** The organization's storage lock (D-115): every storage save takes it first. */
export async function lockStorage(db: Queryable, organizationId: OrganizationId): Promise<void> {
  await db.rows(sql`SELECT pg_advisory_xact_lock(115, hashtext(${organizationId}::text))`);
}

/** The database's clock now, as core writes times (ISO 8601 UTC, milliseconds). */
export async function storageNow(db: Queryable): Promise<string> {
  const [row] = await db.rows<{ now: string }>(sql`
    SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
  if (row === undefined) throw new Error("the database's clock could not be read");
  return row.now;
}

interface DefinitionRow {
  definition: unknown;
  version: number;
  updated_at: string;
}

const STAMP = sql`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function stored(row: DefinitionRow): StoredDefinition {
  return Object.freeze({
    definition: row.definition,
    version: row.version,
    updatedAt: row.updated_at,
  });
}

/** The organization's levels, locations and moves (oldest written first). */
export async function readStorage(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<StoredStorage> {
  if (!isOrganizationId(organizationId)) {
    return Object.freeze({ levels: undefined, locations: [], moves: [] });
  }
  const [levels] = await db.rows<DefinitionRow>(sql`
    SELECT definition, version, ${STAMP} AS updated_at FROM public.storage_levels
    WHERE organization_id = ${organizationId}::uuid`);
  const locations = await db.rows<DefinitionRow>(sql`
    SELECT definition, version, ${STAMP} AS updated_at FROM public.storage_locations
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY id`);
  const moves = await db.rows<{ definition: unknown }>(sql`
    SELECT definition FROM public.storage_moves
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY recorded_at, id`);
  return Object.freeze({
    levels: levels === undefined ? undefined : stored(levels),
    locations: Object.freeze(locations.map(stored)),
    moves: Object.freeze(moves.map((m) => m.definition)),
  });
}

export type StorageSaveOutcome =
  | { readonly ok: true; readonly value: StoredDefinition }
  | { readonly ok: false; readonly code: "version_conflict" | "missing_record" };

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Saves the levels (a new row when `expectedVersion` is 0). */
export async function saveStorageLevels(
  db: Queryable,
  organizationId: OrganizationId,
  definition: unknown,
  userId: string,
  expectedVersion: number,
): Promise<StorageSaveOutcome> {
  const rows =
    expectedVersion === 0
      ? await db.rows<DefinitionRow>(sql`
          INSERT INTO public.storage_levels (organization_id, definition, updated_by)
          VALUES (${organizationId}::uuid, ${JSON.stringify(definition)}::jsonb, ${userId}::uuid)
          ON CONFLICT (organization_id) DO NOTHING
          RETURNING definition, version, ${STAMP} AS updated_at`)
      : await db.rows<DefinitionRow>(sql`
          UPDATE public.storage_levels
          SET definition = ${JSON.stringify(definition)}::jsonb, version = version + 1,
              updated_by = ${userId}::uuid
          WHERE organization_id = ${organizationId}::uuid AND version = ${expectedVersion}
          RETURNING definition, version, ${STAMP} AS updated_at`);
  const [row] = rows;
  return row === undefined
    ? { ok: false, code: "version_conflict" }
    : { ok: true, value: stored(row) };
}

/** Saves one location (a new one when `expectedVersion` is 0). */
export async function saveStorageLocation(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
  definition: unknown,
  userId: string,
  expectedVersion: number,
): Promise<StorageSaveOutcome> {
  try {
    const rows =
      expectedVersion === 0
        ? await db.rows<DefinitionRow>(sql`
            INSERT INTO public.storage_locations (organization_id, id, definition, updated_by)
            VALUES (${organizationId}::uuid, ${id}::uuid, ${JSON.stringify(definition)}::jsonb,
                    ${userId}::uuid)
            ON CONFLICT (organization_id, id) DO NOTHING
            RETURNING definition, version, ${STAMP} AS updated_at`)
        : await db.rows<DefinitionRow>(sql`
            UPDATE public.storage_locations
            SET definition = ${JSON.stringify(definition)}::jsonb, version = version + 1,
                updated_by = ${userId}::uuid
            WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid
              AND version = ${expectedVersion}
            RETURNING definition, version, ${STAMP} AS updated_at`);
    const [row] = rows;
    return row === undefined
      ? { ok: false, code: "version_conflict" }
      : { ok: true, value: stored(row) };
  } catch (error) {
    if (pgCode(error) === "23503") return { ok: false, code: "missing_record" };
    throw error;
  }
}

/** Writes one move, written down at `recordedAt` (the move's own, from `storageNow`). */
export async function insertStorageMove(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
  definition: unknown,
  userId: string,
  recordedAt: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "missing_record" }> {
  try {
    await db.execute(sql`
      INSERT INTO public.storage_moves (organization_id, id, definition, recorded_by, recorded_at)
      VALUES (${organizationId}::uuid, ${id}::uuid, ${JSON.stringify(definition)}::jsonb,
              ${userId}::uuid, ${recordedAt}::timestamptz)`);
    return { ok: true };
  } catch (error) {
    if (pgCode(error) === "23503") return { ok: false, code: "missing_record" };
    throw error;
  }
}

/** Whether `recordId` has moves, or is an outside location's agent (record deletion). */
export async function storageUses(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<{ readonly moves: boolean; readonly agent: boolean }> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) {
    return { moves: false, agent: false };
  }
  const [row] = await db.rows<{ moves: boolean; agent: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM public.storage_moves
              WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid)
        AS moves,
      EXISTS (SELECT 1 FROM public.storage_locations
              WHERE organization_id = ${organizationId}::uuid AND agent_id = ${recordId}::uuid)
        AS agent`);
  return { moves: row?.moves === true, agent: row?.agent === true };
}
