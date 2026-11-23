/**
 * Typed reads and writes for the vocabulary tables of `0004_vocabularies.sql`
 * (T-027, D-062): an organization's stored terms, and the index of which of
 * its records use which terms.
 *
 * As in `catalog.ts` and `identifiers.ts`, every term goes in and comes out
 * through `@oculus/core`: writes validate it with `validateControlledTerm`
 * and store the validated copy with its term key beside it; reads validate
 * again and check the stored key is still the term's, so a row changed by
 * hand, or a key worked out by an older rule (changing `termKey` is a
 * migration), reads as issues.
 *
 * **The term key** says which term a value is, for the unique stored copy and
 * for counting: a term with a URI is its vocabulary and `termUriKey(uri)`
 * (so an http and an https copy of one Nomenclature address are one term, and
 * a record's stale label for an LCSH heading still counts under the heading);
 * any other is its vocabulary and its exact label. No vocabulary and `local`
 * are the same (D-014). Spellings that differ are different terms: finding
 * them is Data Cleaning's (`findNearDuplicateTerms`), never this key's. It is
 * stored as the SHA-256 of that text, in hex, so it always fits in an index.
 *
 * **The usage index is kept here, not by a trigger** (D-062). Which fields of
 * a record hold terms is in its template, and the key needs core's
 * `termUriKey`, so `refreshRecordTerms` rebuilds a record's usages from the
 * record and its template as stored. Whoever saves a record calls it in the
 * same transaction (the service layer, T-032); `recordsWithStaleTerms` finds
 * any record changed without it, from what each index was built from.
 *
 * Every read and write names one organization (D-019, D-030): the tables'
 * keys and foreign keys all include it, so another organization's terms,
 * records and usages are never read, counted or listed. Writes run inside a
 * savepoint of the caller's transaction, so a refusal (`term_exists`) leaves
 * it usable; call them inside `Database.transaction` (outside one they
 * throw).
 *
 * Left to later tasks: an `organizationId` on stored terms in core itself
 * (T-019b2: here the row's organization is checked, and the term value is
 * core's `ControlledTerm`); renaming or merging a term in the records that
 * use it, and deleting stored terms (Data Cleaning); inherited values, which
 * are counted only on the record that holds them.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  isFieldKey,
  isOrganizationId,
  isRecordId,
  issue,
  termUriKey,
  validateControlledTerm,
  type ControlledTerm,
  type Issue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import { readRecord, readTemplate } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** A stored term of an organization. */
export interface StoredTerm {
  readonly organizationId: OrganizationId;
  /** A random version 4 UUID, made when the term is first saved; never changes. */
  readonly id: string;
  readonly term: ControlledTerm;
  readonly termKey: string;
}

/** One term a record uses in one field, as the record holds it. */
export interface TermUsage {
  readonly fieldKey: string;
  readonly termKey: string;
  readonly term: ControlledTerm;
}

/** A record's usage index, as `refreshRecordTerms` built it. */
export interface RecordTerms {
  readonly recordId: RecordId;
  readonly templateKey: string;
  readonly templateVersion: number;
  /** In field order, then value order; one per field and term key. */
  readonly usages: readonly TermUsage[];
  /** Values in term fields that aren't terms core accepts: not indexed. */
  readonly skipped: readonly Issue[];
}

/** How many records use one term. */
export interface TermCount {
  readonly termKey: string;
  /** The stored term, or (if it isn't stored) the term as one record holds it. */
  readonly term: ControlledTerm;
  /** The stored term's ID, if the organization stored it. */
  readonly storedTermId?: string;
  readonly records: number;
}

export interface TermCounts {
  /** Most used first, then by label (byte order) and key. */
  readonly counts: readonly TermCount[];
  /** True when there were more than `limit`. */
  readonly truncated: boolean;
}

export interface TermUsers {
  /** By record ID. */
  readonly records: readonly {
    readonly recordId: RecordId;
    readonly fieldKeys: readonly string[];
  }[];
  /** True when there were more than `limit`: ask again with `after` the last ID. */
  readonly truncated: boolean;
}

export interface StaleRecords {
  readonly recordIds: readonly RecordId[];
  readonly truncated: boolean;
}

export const DEFAULT_TERM_LIST_LIMIT = 500;
export const MAX_TERM_LIST_LIMIT = 10_000;

const BAD_ORGANIZATION = "The organization ID must be a lowercase version 4 UUID.";
const BAD_RECORD = "The record ID must be a lowercase version 4 UUID.";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERM_KEY = /^[0-9a-f]{64}$/;
const SAVE_KEYS: ReadonlySet<string> = new Set(["organizationId", "id", "term"]);

const UNIQUE = "23505";
const FOREIGN_KEY = "23503";

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** The SQLSTATE and constraint of a database error, if it is one. */
function dbError(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== "string") return undefined;
  return { code, constraint: typeof constraint === "string" ? constraint : "" };
}

/**
 * Runs `work` inside a savepoint of the caller's transaction, as
 * `identifiers.ts` does: if it throws, what it did is rolled back to the
 * savepoint and the error returned for the caller to map.
 */
async function inSavepoint<T>(
  db: Queryable,
  work: () => Promise<T>,
): Promise<{ done: true; value: T } | { done: false; error: unknown }> {
  try {
    await db.execute(sql`SAVEPOINT oculus_vocabularies`);
  } catch (error) {
    if (dbError(error)?.code === "25P01") {
      throw new Error("Term writes must run inside a transaction (Database.transaction).", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const value = await work();
    await db.execute(sql`RELEASE SAVEPOINT oculus_vocabularies`);
    return { done: true, value };
  } catch (error) {
    try {
      await db.execute(sql`ROLLBACK TO SAVEPOINT oculus_vocabularies`);
      await db.execute(sql`RELEASE SAVEPOINT oculus_vocabularies`);
    } catch {
      throw new Error("Rolling back a term write failed.", { cause: error });
    }
    return { done: false, error };
  }
}

/** An own data property, never through a getter or a proxy's trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Term keys

/** The key of a term core already accepted (see the header). */
function keyOf(term: ControlledTerm): string {
  const vocab = term.vocabulary ?? "local";
  const text =
    term.uri === undefined
      ? `${vocab}\u0000label\u0000${term.label}`
      : `${vocab}\u0000uri\u0000${termUriKey(term.uri)}`;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A term's key (see the header), after checking it with `validateControlledTerm`. */
export function termKey(input: unknown): Validated<string> {
  const valid = validateControlledTerm(input);
  return valid.ok ? { ok: true, value: keyOf(valid.value) } : valid;
}

interface TermColumns {
  vocabulary: string | null;
  uri: string | null;
  label: string;
  term_key: string;
}

/** The core term a row's columns hold, validated, with its key checked. */
function termFromRow(row: TermColumns): Validated<ControlledTerm> {
  const value: { label: string; uri?: string; vocabulary?: string } = { label: row.label };
  if (row.uri !== null) value.uri = row.uri;
  if (row.vocabulary !== null) value.vocabulary = row.vocabulary;
  const valid = validateControlledTerm(value);
  if (!valid.ok) return valid;
  if (keyOf(valid.value) !== row.term_key) {
    return refused([], "row_mismatch", "A stored term doesn't match its term key.");
  }
  return valid;
}

/** Each row's term, or the first row's issues with its index in front. */
function termsFromRows<R extends TermColumns, T>(
  rows: readonly R[],
  make: (row: R, term: ControlledTerm) => T,
): Validated<readonly T[]> {
  const out: T[] = [];
  for (const [index, row] of rows.entries()) {
    const term = termFromRow(row);
    if (!term.ok) {
      return {
        ok: false,
        issues: term.issues.map((i) => issue([index, ...i.path], i.code, i.message)),
      };
    }
    out.push(make(row, term.value));
  }
  return { ok: true, value: Object.freeze(out) };
}

// ---------------------------------------------------------------------------
// Stored terms

interface TermRow extends TermColumns {
  id: string;
}

function storedTerm(org: OrganizationId, row: TermRow, term: ControlledTerm): StoredTerm {
  return Object.freeze({ organizationId: org, id: row.id, term, termKey: row.term_key });
}

/**
 * Stores a term for an organization: `{ organizationId, term }` stores a new
 * one with a new ID; `{ organizationId, id, term }` replaces the stored term
 * with that ID (a local term renamed, a URI added). The term is checked with
 * `validateControlledTerm`. An organization stores each term once: a term
 * whose key another of its stored terms has is refused (`term_exists`), also
 * when two saves race. Records using the old term are not changed. Run inside
 * a transaction.
 */
export async function saveTerm(db: Queryable, input: unknown): Promise<Validated<StoredTerm>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refused([], "not_an_object", "A term to save must be { organizationId, id?, term }.");
  }
  let keys: string[];
  try {
    keys = Reflect.ownKeys(input).map(String);
  } catch {
    return refused([], "unreadable", "This term could not be read.");
  }
  for (const key of keys) {
    if (!SAVE_KEYS.has(key)) {
      return refused([key], "unknown_property", "Only organizationId, id and term can be given.");
    }
  }
  const org = ownValue(input, "organizationId");
  if (!isOrganizationId(org)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const given = ownValue(input, "id");
  if (given !== undefined && !(typeof given === "string" && UUID_V4.test(given))) {
    return refused(["id"], "invalid_id", "A term ID is a lowercase version 4 UUID.");
  }
  const valid = validateControlledTerm(ownValue(input, "term"));
  if (!valid.ok) {
    return {
      ok: false,
      issues: valid.issues.map((i) => issue(["term", ...i.path], i.code, i.message)),
    };
  }
  const term = valid.value;
  const key = keyOf(term);
  const id = given ?? randomUUID();
  const result = await inSavepoint(db, async (): Promise<Validated<StoredTerm>> => {
    const changed =
      given === undefined
        ? await db.execute(sql`
            INSERT INTO public.terms (organization_id, id, vocabulary, uri, label, term_key)
            VALUES (${org}::uuid, ${id}::uuid, ${term.vocabulary ?? null}, ${term.uri ?? null},
                    ${term.label}, ${key})`)
        : await db.execute(sql`
            UPDATE public.terms
            SET vocabulary = ${term.vocabulary ?? null}, uri = ${term.uri ?? null},
                label = ${term.label}, term_key = ${key}, updated_at = now()
            WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`);
    if (changed !== 1) {
      return refused(["id"], "unknown_term", "The organization has no stored term with this ID.");
    }
    return { ok: true, value: Object.freeze({ organizationId: org, id, term, termKey: key }) };
  });
  if (result.done) return result.value;
  const error = dbError(result.error);
  if (error?.code === UNIQUE && error.constraint === "terms_one_per_key") {
    return refused(["term"], "term_exists", "The organization already has this term.");
  }
  if (error?.code === FOREIGN_KEY && error.constraint === "terms_organization_id_fkey") {
    return refused(["organizationId"], "unknown_organization", "There is no such organization.");
  }
  throw result.error;
}

/** The organization's stored term with this ID, or `undefined` if it has none. */
export async function readTerm(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
): Promise<Validated<StoredTerm> | undefined> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!UUID_V4.test(id)) {
    return refused(["id"], "invalid_id", "A term ID is a lowercase version 4 UUID.");
  }
  const rows = await db.rows<TermRow>(sql`
    SELECT id::text AS id, vocabulary, uri, label, term_key FROM public.terms
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid`);
  const [row] = rows;
  if (row === undefined) return undefined;
  const term = termFromRow(row);
  return term.ok ? { ok: true, value: storedTerm(organizationId, row, term.value) } : term;
}

/**
 * The organization's stored terms, validated, ordered by vocabulary (local
 * terms first) and label (byte order). A row that doesn't validate refuses
 * the list, with its index in the path.
 */
export async function readTerms(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<Validated<readonly StoredTerm[]>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const rows = await db.rows<TermRow>(sql`
    SELECT id::text AS id, vocabulary, uri, label, term_key FROM public.terms
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY coalesce(vocabulary, 'local') = 'local' DESC, vocabulary COLLATE "C" NULLS FIRST,
             label COLLATE "C", id`);
  return termsFromRows(rows, (row, term) => storedTerm(organizationId, row, term));
}

// ---------------------------------------------------------------------------
// The usage index

/**
 * Rebuilds the index of the terms one record uses, from the record and the
 * current version of its template as stored (never from what the caller
 * holds): every value of every `controlled_term` field of the template that
 * core accepts as a term, one usage per field and term key. A value core
 * refuses is left out and listed in `skipped`. Values of fields the template
 * doesn't have are not indexed. The record is locked for the rest of the
 * transaction, so two refreshes of it never interleave, and what the index
 * was built from is kept for `recordsWithStaleTerms`.
 *
 * Call it in the transaction that saves the record. Refused: a record the
 * organization doesn't have (`unknown_record`), and a record or template
 * that no longer validates (their issues). Run inside a transaction.
 */
export async function refreshRecordTerms(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<Validated<RecordTerms>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isRecordId(recordId)) return refused(["recordId"], "invalid_id", BAD_RECORD);
  const org = organizationId;
  const result = await inSavepoint(db, async (): Promise<Validated<RecordTerms>> => {
    const [locked] = await db.rows<{ digest: string }>(sql`
      SELECT md5(fields::text) AS digest FROM public.records
      WHERE organization_id = ${org}::uuid AND id = ${recordId}::uuid
      FOR NO KEY UPDATE`);
    if (locked === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    // The row is locked, so this reads the same fields the digest was made of.
    const record = await readRecord(db, org, recordId);
    if (record === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (!record.ok) return record;
    const templateKey = record.value.templateKey;
    if (templateKey === undefined) {
      return refused(["templateKey"], "no_template_key", "The record names no template.");
    }
    const stored = await readTemplate(db, org, templateKey);
    if (stored === undefined) {
      return refused(["templateKey"], "unknown_template", "The record's template is gone.");
    }
    if (!stored.ok) return stored;
    const { version, template } = stored.value;

    const usages: TermUsage[] = [];
    const skipped: Issue[] = [];
    const seen = new Set<string>();
    const fields = record.value.fields;
    for (const field of template.fields) {
      if (field.kind !== "controlled_term" || !Object.hasOwn(fields, field.key)) continue;
      const value = fields[field.key];
      // Indexed whatever the record holds: a list or one value. Whether that
      // fits the field is checkRecordAgainstTemplate's, when it is saved.
      const values = Array.isArray(value) ? value : [value];
      const listed = Array.isArray(value);
      values.forEach((one, i) => {
        const path = listed ? ["fields", field.key, i] : ["fields", field.key];
        const term = validateControlledTerm(one);
        if (!term.ok) {
          for (const problem of term.issues) {
            skipped.push(issue([...path, ...problem.path], problem.code, problem.message));
          }
          return;
        }
        const key = keyOf(term.value);
        const id = `${field.key}\u0000${key}`;
        if (seen.has(id)) return;
        seen.add(id);
        usages.push(Object.freeze({ fieldKey: field.key, termKey: key, term: term.value }));
      });
    }

    await db.execute(sql`
      DELETE FROM public.record_terms
      WHERE organization_id = ${org}::uuid AND record_id = ${recordId}::uuid`);
    await db.execute(sql`
      INSERT INTO public.record_term_index
        (organization_id, record_id, template_key, template_version, fields_digest)
      VALUES (${org}::uuid, ${recordId}::uuid, ${templateKey}, ${version}::integer,
              ${locked.digest})
      ON CONFLICT (organization_id, record_id) DO UPDATE
        SET template_key = EXCLUDED.template_key, template_version = EXCLUDED.template_version,
            fields_digest = EXCLUDED.fields_digest, indexed_at = now()`);
    if (usages.length > 0) {
      await db.execute(sql`
        INSERT INTO public.record_terms
          (organization_id, record_id, field_key, term_key, vocabulary, uri, label)
        SELECT ${org}::uuid, ${recordId}::uuid, u.field_key, u.term_key, u.vocabulary, u.uri,
               u.label
        FROM unnest(${usages.map((u) => u.fieldKey)}::text[],
                    ${usages.map((u) => u.termKey)}::text[],
                    ${usages.map((u) => u.term.vocabulary ?? null)}::text[],
                    ${usages.map((u) => u.term.uri ?? null)}::text[],
                    ${usages.map((u) => u.term.label)}::text[])
             AS u(field_key, term_key, vocabulary, uri, label)`);
    }
    return {
      ok: true,
      value: Object.freeze({
        recordId,
        templateKey,
        templateVersion: version,
        usages: Object.freeze(usages),
        skipped: Object.freeze(skipped),
      }),
    };
  });
  if (result.done) return result.value;
  throw result.error;
}

/**
 * Removes a record's usage index, for a record about to be deleted (nothing
 * cascades: the index's foreign key refuses deleting an indexed record).
 * Returns how many usages were removed. Run inside a transaction.
 */
export async function clearRecordTerms(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<Validated<number>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isRecordId(recordId)) return refused(["recordId"], "invalid_id", BAD_RECORD);
  const result = await inSavepoint(db, async () => {
    const where = sql`organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid`;
    const removed = await db.execute(sql`DELETE FROM public.record_terms WHERE ${where}`);
    await db.execute(sql`DELETE FROM public.record_term_index WHERE ${where}`);
    return removed;
  });
  if (result.done) return { ok: true, value: result.value };
  throw result.error;
}

function checkLimit(limit: number | undefined): Validated<number> {
  const n = limit ?? DEFAULT_TERM_LIST_LIMIT;
  return Number.isInteger(n) && n >= 1 && n <= MAX_TERM_LIST_LIMIT
    ? { ok: true, value: n }
    : refused(
        ["limit"],
        "invalid_limit",
        `The limit is a whole number from 1 to ${String(MAX_TERM_LIST_LIMIT)}.`,
      );
}

function checkFieldKey(fieldKey: string | undefined): Validated<string | null> {
  if (fieldKey === undefined) return { ok: true, value: null };
  return isFieldKey(fieldKey)
    ? { ok: true, value: fieldKey }
    : refused(["fieldKey"], "invalid_field_key", "That is not a field key.");
}

interface CountRow extends TermColumns {
  stored_id: string | null;
  records: number;
}

/**
 * How many of the organization's records use each term, from the index (the
 * Subjects counts): every term an indexed record uses, and every stored term,
 * with 0 when no record uses it (an unused term, for Data Cleaning). With
 * `fieldKey`, only usages in that field count, and terms no record uses
 * there are left out. A record using a term twice counts once.
 */
export async function termUsageCounts(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly fieldKey?: string; readonly limit?: number } = {},
): Promise<Validated<TermCounts>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  const field = checkFieldKey(options.fieldKey);
  if (!field.ok) return field;
  const org = organizationId;
  const rows = await db.rows<CountRow>(sql`
    WITH used AS (
      SELECT term_key, count(DISTINCT record_id)::integer AS records
      FROM public.record_terms
      WHERE organization_id = ${org}::uuid
        AND (${field.value}::text IS NULL OR field_key = ${field.value}::text)
      GROUP BY term_key
    ), sample AS (
      SELECT DISTINCT ON (u.term_key) u.term_key, u.vocabulary, u.uri, u.label
      FROM public.record_terms u
      WHERE u.organization_id = ${org}::uuid
        AND (${field.value}::text IS NULL OR u.field_key = ${field.value}::text)
      ORDER BY u.term_key, u.label COLLATE "C", u.record_id, u.field_key
    ), stored AS (
      SELECT id, term_key, vocabulary, uri, label FROM public.terms
      WHERE organization_id = ${org}::uuid
    )
    SELECT coalesce(t.term_key, s.term_key) AS term_key,
           t.id::text AS stored_id,
           CASE WHEN t.term_key IS NULL THEN s.vocabulary ELSE t.vocabulary END AS vocabulary,
           CASE WHEN t.term_key IS NULL THEN s.uri ELSE t.uri END AS uri,
           coalesce(t.label, s.label) AS label,
           coalesce(used.records, 0) AS records
    FROM sample s
    JOIN used ON used.term_key = s.term_key
    FULL JOIN stored t ON t.term_key = s.term_key
    WHERE ${field.value}::text IS NULL OR s.term_key IS NOT NULL
    ORDER BY coalesce(used.records, 0) DESC, coalesce(t.label, s.label) COLLATE "C",
             coalesce(t.term_key, s.term_key)
    LIMIT ${limit.value + 1}::integer`);
  const truncated = rows.length > limit.value;
  const read = termsFromRows(rows.slice(0, limit.value), (row, term): TermCount =>
    Object.freeze({
      termKey: row.term_key,
      term,
      ...(row.stored_id === null ? {} : { storedTermId: row.stored_id }),
      records: row.records,
    }),
  );
  if (!read.ok) return read;
  return { ok: true, value: Object.freeze({ counts: read.value, truncated }) };
}

/**
 * The organization's records that use the term with this key (`termKey`),
 * from the index, by record ID, with the fields each uses it in. With
 * `fieldKey`, only usages in that field. At most `limit` records after the
 * ID `after`, for reading a long list in pages.
 */
export async function recordsUsingTerm(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
  options: { readonly fieldKey?: string; readonly limit?: number; readonly after?: RecordId } = {},
): Promise<Validated<TermUsers>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (typeof key !== "string" || !TERM_KEY.test(key)) {
    return refused(["termKey"], "invalid_term_key", "A term key is 64 lowercase hex digits.");
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  const field = checkFieldKey(options.fieldKey);
  if (!field.ok) return field;
  if (options.after !== undefined && !isRecordId(options.after)) {
    return refused(["after"], "invalid_id", BAD_RECORD);
  }
  const rows = await db.rows<{ record_id: string; field_keys: string[] }>(sql`
    SELECT record_id::text AS record_id, array_agg(field_key ORDER BY field_key COLLATE "C") AS field_keys
    FROM public.record_terms
    WHERE organization_id = ${organizationId}::uuid AND term_key = ${key}
      AND (${field.value}::text IS NULL OR field_key = ${field.value}::text)
      AND (${options.after ?? null}::uuid IS NULL OR record_id > ${options.after ?? null}::uuid)
    GROUP BY record_id
    ORDER BY record_id
    LIMIT ${limit.value + 1}::integer`);
  const records = rows.slice(0, limit.value).map((row) => {
    if (!isRecordId(row.record_id)) throw new Error("A stored record ID is not a record ID.");
    return Object.freeze({ recordId: row.record_id, fieldKeys: Object.freeze(row.field_keys) });
  });
  return {
    ok: true,
    value: Object.freeze({ records: Object.freeze(records), truncated: rows.length > limit.value }),
  };
}

/**
 * The organization's records whose usage index is missing or out of date:
 * never refreshed, or whose fields, template or template version changed
 * since. A maintenance check that reads every record of the organization
 * (the counts never do): refresh what it lists.
 */
export async function recordsWithStaleTerms(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly limit?: number } = {},
): Promise<Validated<StaleRecords>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  const rows = await db.rows<{ id: string }>(sql`
    SELECT r.id::text AS id
    FROM public.records r
    LEFT JOIN public.record_term_index i
      ON i.organization_id = r.organization_id AND i.record_id = r.id
    WHERE r.organization_id = ${organizationId}::uuid
      AND (i.record_id IS NULL
           OR i.template_key <> r.template_key
           OR i.fields_digest <> md5(r.fields::text)
           OR i.template_version <> (
             SELECT max(v.version) FROM public.template_versions v
             WHERE v.organization_id = r.organization_id AND v.key = r.template_key))
    ORDER BY r.id
    LIMIT ${limit.value + 1}::integer`);
  const recordIds = rows.slice(0, limit.value).map((row) => {
    if (!isRecordId(row.id)) throw new Error("A stored record ID is not a record ID.");
    return row.id;
  });
  return {
    ok: true,
    value: Object.freeze({
      recordIds: Object.freeze(recordIds),
      truncated: rows.length > limit.value,
    }),
  };
}
