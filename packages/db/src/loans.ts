/**
 * Stored loans and condition checks (T-018b with T-018a and S-013, D-118):
 * the rows of `0067_loans.sql`. Core checks every loan against the whole
 * move log and every other loan (loans.ts: `indexLoans`, `withLoan`) and
 * every check (condition-checks.ts); who may do what is the service's
 * (packages/service `loans.ts`). These functions only read and write, each
 * in the caller's transaction, always within one organization.
 *
 * Loan saves take the organization's storage lock (storage.ts, classid 115)
 * exclusive before reading, like moves: a loan is checked against the move
 * log and the other loans exactly as they are when it commits. Reads take it
 * shared.
 *
 * - `readLoans` reads every loan with its version; `insertLoan` and
 *   `updateLoan` (expected version) save one; a number already used that
 *   way is `duplicate_number`.
 * - `readLoanHistory` reads a loan's saved versions, oldest first.
 * - `readAccessionRecordsMap` gives core which accessions name which
 *   records (D-118: what `keptByAccessionId` is checked against), read here,
 *   never taken from a request.
 * - `readConditionChecks`, `insertConditionCheck` (insert only).
 * - `loanUses` says whether a record is on a loan or its lender or borrower,
 *   or has condition checks (record deletion).
 *
 * STAFF ONLY: nothing here may reach a public reply.
 */
import {
  isOrganizationId,
  isRecordId,
  type AccessionRecords,
  type Loan,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * The writer's privileges (roles.ts): loans are made and changed, never
 * deleted; checks are insert only. `loan_records` and `loan_versions` are
 * written by the migration's trigger, not the writer.
 */
export const LOAN_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  loans: ["INSERT", "UPDATE"],
  condition_checks: ["INSERT"],
});

/** A stored loan: its core definition and its row's bookkeeping. */
export interface StoredLoan {
  readonly definition: unknown;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** One saved version of a loan. */
export interface StoredLoanVersion {
  readonly version: number;
  readonly definition: unknown;
  readonly savedBy: string;
  readonly savedAt: string;
}

export type LoanSaveOutcome =
  | { readonly ok: true; readonly value: StoredLoan }
  | {
      readonly ok: false;
      readonly code: "version_conflict" | "duplicate_number" | "missing_record";
    };

interface LoanRow {
  definition: unknown;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

const COLUMNS = sql`definition, version, created_by::text AS created_by,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  updated_by::text AS updated_by,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

function stored(row: LoanRow): StoredLoan {
  return Object.freeze({
    definition: row.definition,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
}

function pgError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== "object" || error === null) return {};
  const e = error as { code?: unknown; constraint?: unknown };
  return {
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.constraint === "string" ? { constraint: e.constraint } : {}),
  };
}

function refusedSave(error: unknown): LoanSaveOutcome {
  const e = pgError(error);
  if (e.code === "23505" && e.constraint === "loans_number_unique") {
    return { ok: false, code: "duplicate_number" };
  }
  // A record, the lender or the borrower deleted meanwhile (the foreign keys).
  if (e.code === "23503") return { ok: false, code: "missing_record" };
  throw error;
}

/** Every loan of the organization (oldest first), with its version. */
export async function readLoans(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly StoredLoan[]> {
  if (!isOrganizationId(organizationId)) return Object.freeze([]);
  const rows = await db.rows<LoanRow>(sql`
    SELECT ${COLUMNS} FROM public.loans
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY created_at, id`);
  return Object.freeze(rows.map(stored));
}

/** Saves a new loan. */
export async function insertLoan(
  db: Queryable,
  loan: Loan,
  numberKey: string,
  userId: string,
): Promise<LoanSaveOutcome> {
  try {
    const [row] = await db.rows<LoanRow>(sql`
      INSERT INTO public.loans (organization_id, id, definition, number_key, created_by, updated_by)
      VALUES (${loan.organizationId}::uuid, ${loan.id}::uuid, ${JSON.stringify(loan)}::jsonb,
              ${numberKey}, ${userId}::uuid, ${userId}::uuid)
      RETURNING ${COLUMNS}`);
    if (row === undefined) throw new Error("the loan was not saved");
    return { ok: true, value: stored(row) };
  } catch (error) {
    return refusedSave(error);
  }
}

/** Replaces the loan's definition if its version is still `expectedVersion`. */
export async function updateLoan(
  db: Queryable,
  loan: Loan,
  numberKey: string,
  userId: string,
  expectedVersion: number,
): Promise<LoanSaveOutcome> {
  try {
    const [row] = await db.rows<LoanRow>(sql`
      UPDATE public.loans
      SET definition = ${JSON.stringify(loan)}::jsonb, number_key = ${numberKey},
          version = version + 1, updated_by = ${userId}::uuid
      WHERE organization_id = ${loan.organizationId}::uuid AND id = ${loan.id}::uuid
        AND version = ${expectedVersion}
      RETURNING ${COLUMNS}`);
    return row === undefined
      ? { ok: false, code: "version_conflict" }
      : { ok: true, value: stored(row) };
  } catch (error) {
    return refusedSave(error);
  }
}

/** A loan's saved versions, oldest first (empty for another organization's). */
export async function readLoanHistory(
  db: Queryable,
  organizationId: OrganizationId,
  loanId: string,
): Promise<readonly StoredLoanVersion[]> {
  const rows = await db.rows<{
    version: number;
    definition: unknown;
    saved_by: string;
    saved_at: string;
  }>(sql`
    SELECT version, definition, saved_by::text AS saved_by,
           to_char(saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS saved_at
    FROM public.loan_versions
    WHERE organization_id = ${organizationId}::uuid AND loan_id = ${loanId}::uuid
    ORDER BY version`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        version: r.version,
        definition: r.definition,
        savedBy: r.saved_by,
        savedAt: r.saved_at,
      }),
    ),
  );
}

/** Which of the organization's accessions name which records (from `accession_records`). */
export async function readAccessionRecordsMap(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<AccessionRecords> {
  const rows = await db.rows<{ accession_id: string; records: string[] }>(sql`
    SELECT accession_id::text AS accession_id, array_agg(record_id::text ORDER BY record_id) AS records
    FROM public.accession_records
    WHERE organization_id = ${organizationId}::uuid
    GROUP BY accession_id`);
  const map = new Map<string, readonly RecordId[]>();
  for (const row of rows) {
    map.set(
      row.accession_id,
      Object.freeze(row.records.filter((id): id is RecordId => isRecordId(id))),
    );
  }
  return map;
}

/** Every condition check of the organization, oldest written first. */
export async function readConditionChecks(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly unknown[]> {
  if (!isOrganizationId(organizationId)) return Object.freeze([]);
  const rows = await db.rows<{ definition: unknown }>(sql`
    SELECT definition FROM public.condition_checks
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY recorded_at, id`);
  return Object.freeze(rows.map((r) => r.definition));
}

/** Writes one condition check, written down at `recordedAt` (its own, from `storageNow`). */
export async function insertConditionCheck(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
  definition: unknown,
  userId: string,
  recordedAt: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "missing_record" }> {
  try {
    await db.execute(sql`
      INSERT INTO public.condition_checks (organization_id, id, definition, recorded_by, recorded_at)
      VALUES (${organizationId}::uuid, ${id}::uuid, ${JSON.stringify(definition)}::jsonb,
              ${userId}::uuid, ${recordedAt}::timestamptz)`);
    return { ok: true };
  } catch (error) {
    if (pgError(error).code === "23503") return { ok: false, code: "missing_record" };
    throw error;
  }
}

/** Whether `recordId` is on a loan, is a loan's lender or borrower, or has condition checks. */
export async function loanUses(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<{ readonly onLoan: boolean; readonly agent: boolean; readonly checks: boolean }> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) {
    return { onLoan: false, agent: false, checks: false };
  }
  const [row] = await db.rows<{ on_loan: boolean; agent: boolean; checks: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM public.loan_records
              WHERE organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid)
        AS on_loan,
      EXISTS (SELECT 1 FROM public.loans
              WHERE organization_id = ${organizationId}::uuid AND agent_id = ${recordId}::uuid)
        AS agent,
      EXISTS (SELECT 1 FROM public.condition_checks
              WHERE organization_id = ${organizationId}::uuid
                AND (record_id = ${recordId}::uuid OR checker_id = ${recordId}::uuid))
        AS checks`);
  return {
    onLoan: row?.on_loan === true,
    agent: row?.agent === true,
    checks: row?.checks === true,
  };
}
