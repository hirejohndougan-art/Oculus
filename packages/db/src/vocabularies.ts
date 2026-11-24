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
 * are the same (D-014). Spellings that differ are different terms, including
 * labels that differ only invisibly (a composed and a decomposed accent, NFC
 * and NFD), exactly as core compares labels: finding them is Data Cleaning's
 * (`findNearDuplicateTerms` pairs those as `same_label`), never this key's. It
 * is stored as the SHA-256 of that text, in hex, so it always fits in an index.
 *
 * **The usage index is kept here, not by a trigger** (D-062). Which fields of
 * a record hold terms is in its template, and the key needs core's
 * `termUriKey`, so `refreshRecordTerms` rebuilds a record's usages from the
 * record and its template as stored. Whoever saves a record calls it in the
 * same transaction (the service layer, T-032); `recordsWithStaleTerms` finds
 * any record changed without it, from what each index was built from. A
 * refresh that is refused because the
 * record or its template no longer validates removes the record's usages and
 * its index row, so nothing old is counted and the record reads as stale.
 *
 * **The counts and lists here are STAFF-ONLY.** They count every usage in
 * every field of every record, published or not; the index keeps no field
 * visibility and has no public option. Public Subjects counts are never
 * worked out from this index: they come from what is published (`publicOutput`
 * or the public views of published records, or an index built from those at
 * publish time), the service and public layers' job (T-034, T-050). Nothing
 * typed in a record is ever shown as a term's name or address: a term the
 * organization hasn't stored is shown by its key, vocabulary and, for a URI
 * term, the canonical URI rebuilt from what the key is made of (scheme and
 * host lower case, dot segments resolved, no user name, password or trailing
 * slash), never a URI or label as a record holds it.
 *
 * Every read and write names one organization (D-019, D-030): the tables'
 * keys and foreign keys all include it, so another organization's terms,
 * records and usages are never read, counted or listed. Writes run inside a
 * savepoint of the caller's transaction, so a refusal (`term_exists`) leaves
 * it usable; call them inside `Database.transaction` (outside one they
 * throw).
 *
 * Stored terms and usages say whose they are (T-019b2, D-071): a
 * `StoredTerm` is core's `StoredTerm` (`organizationId`, `id`, `term`) plus
 * its `termKey`, and every `TermUsage` and `RecordTerms` carries the
 * organization too, so either can be handed straight to core's Data
 * Cleaning functions (`findNearDuplicateTerms`, `findLcTermsWithoutUri`),
 * which refuse a list mixing organizations. The term key is the SHA-256 of
 * core's `termIdentity`, so core and the database share one rule.
 *
 * Left to later tasks: renaming or merging a term in the records that use
 * it, and deleting stored terms (Data Cleaning); inherited values, which are
 * counted only on the record that holds them.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  isFieldKey,
  isOrganizationId,
  isRecordId,
  issue,
  termIdentity,
  termUriKey,
  validateControlledTerm,
  type ControlledTerm,
  type StoredTerm as CoreStoredTerm,
  type Issue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import { readRecord, readTemplate } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * A stored term of an organization: core's `StoredTerm` (its organization, a
 * random version 4 UUID made when it is first saved, which never changes,
 * and the term) with its term key.
 */
export interface StoredTerm extends CoreStoredTerm {
  readonly termKey: string;
}

/** One term a record uses in one field, as the record holds it. */
export interface TermUsage {
  /** The record's organization, so usages can go to core's Data Cleaning checks. */
  readonly organizationId: OrganizationId;
  readonly fieldKey: string;
  readonly termKey: string;
  readonly term: ControlledTerm;
}

/** A record's usage index, as `refreshRecordTerms` built it. */
export interface RecordTerms {
  readonly organizationId: OrganizationId;
  readonly recordId: RecordId;
  readonly templateKey: string;
  readonly templateVersion: number;
  /** In field order, then value order; one per field and term key. */
  readonly usages: readonly TermUsage[];
  /** Values in term fields that aren't terms core accepts: not indexed. */
  readonly skipped: readonly Issue[];
}

/** How many records use one term (staff-only, see the header). */
export interface TermCount {
  readonly termKey: string;
  /** The term's vocabulary; `local` for a local term. */
  readonly vocabulary: string;
  /**
   * The organization's stored copy of the term, if it stored one: the only
   * label a count shows.
   */
  readonly stored?: StoredTerm;
  /**
   * For a term the organization hasn't stored that has a URI: its canonical
   * URI (`canonicalTermUri`), rebuilt from the parts its key is made of, so
   * nothing a record typed beyond the term's address (dot segments, a user
   * name) is shown. Its scheme is that of one counted usage. A term not
   * stored has no label here: a record's label could be from a staff field or
   * an unpublished record. List its records with `recordsUsingTerm`.
   */
  readonly uri?: string;
  readonly records: number;
}

export interface TermCounts {
  /** By term key, for paging: sorting for display is the caller's. */
  readonly counts: readonly TermCount[];
  /** True when there were more than `limit`: ask again with `after` the last key. */
  readonly truncated: boolean;
}

export interface StoredTerms {
  /** By term key, for paging. */
  readonly terms: readonly StoredTerm[];
  /** True when there were more than `limit`: ask again with `after` the last key. */
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
  /** By record ID. */
  readonly recordIds: readonly RecordId[];
  /** True when there were more than `limit`: ask again with `after` the last ID. */
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
const DEADLOCK = "40P01";
const SERIALIZATION = "40001";

/** A deadlock or serialization failure, as a clean `retry` issue; else undefined. */
function retryIssue<T>(error: unknown): Validated<T> | undefined {
  const code = dbError(error)?.code;
  return code === DEADLOCK || code === SERIALIZATION
    ? refused(
        [],
        "retry",
        "Another change to this record ran at the same time. Roll back the transaction and try it again.",
      )
    : undefined;
}

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

/**
 * The key of a term core already accepted (see the header): the SHA-256 of
 * core's `termIdentity`, in hex.
 */
function keyOf(term: ControlledTerm): string {
  const text = termIdentity(term);
  if (!text.ok) throw new Error("keyOf takes a term core has already accepted.");
  return createHash("sha256").update(text.value, "utf8").digest("hex");
}

/**
 * The canonical form of a term URI, for display: for a web address, its
 * scheme followed by `termUriKey(uri)`, i.e. rebuilt from the parsed parts
 * the key is made of (scheme and host lower case, dot segments resolved, the
 * scheme's default port, user name and password and trailing slashes and
 * dots dropped). Two URIs with one key differ here at most in scheme. Any
 * other URI is its own key, so it is returned as it is.
 */
export function canonicalTermUri(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return uri;
  return `${url.protocol}${termUriKey(uri)}`;
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
 * The organization's stored terms, validated, by term key: at most `limit`
 * (default `DEFAULT_TERM_LIST_LIMIT`, at most `MAX_TERM_LIST_LIMIT`) after the
 * key `after`, for reading a long list in pages (the order is stable while
 * terms are added or renamed). Sorting by label for display is the caller's.
 * A row that doesn't validate refuses the page, with its index in the path.
 */
export async function readTerms(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly limit?: number; readonly after?: string } = {},
): Promise<Validated<StoredTerms>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  const after = checkAfterKey(options.after);
  if (!after.ok) return after;
  const rows = await db.rows<TermRow>(sql`
    SELECT id::text AS id, vocabulary, uri, label, term_key FROM public.terms
    WHERE organization_id = ${organizationId}::uuid
      AND (${after.value}::text IS NULL OR term_key > ${after.value}::text)
    ORDER BY term_key
    LIMIT ${limit.value + 1}::integer`);
  const read = termsFromRows(rows.slice(0, limit.value), (row, term) =>
    storedTerm(organizationId, row, term),
  );
  if (!read.ok) return read;
  return {
    ok: true,
    value: Object.freeze({ terms: read.value, truncated: rows.length > limit.value }),
  };
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
 * organization doesn't have (`unknown_record`); a record or template that no
 * longer validates (their issues), in which case the record's usages and its
 * index row are removed, so no old usage is counted and
 * `recordsWithStaleTerms` lists the record until a refresh succeeds; and a
 * deadlock or serialization failure with a concurrent change (`retry`: roll
 * back and run the transaction again). Run inside a transaction.
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
    const where = sql`organization_id = ${org}::uuid AND record_id = ${recordId}::uuid`;
    /** Refused: the old usages go, so they are never counted, and the record reads as stale. */
    const unindexed = async (issues: readonly Issue[]): Promise<Validated<RecordTerms>> => {
      await db.execute(sql`DELETE FROM public.record_terms WHERE ${where}`);
      await db.execute(sql`DELETE FROM public.record_term_index WHERE ${where}`);
      return { ok: false, issues };
    };
    // The row is locked, so this reads the same fields the digest was made of.
    const record = await readRecord(db, org, recordId);
    if (record === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (!record.ok) return unindexed(record.issues);
    const templateKey = record.value.templateKey;
    if (templateKey === undefined) {
      return unindexed([
        issue(["templateKey"], "no_template_key", "The record names no template."),
      ]);
    }
    const stored = await readTemplate(db, org, templateKey);
    if (stored === undefined) {
      return unindexed([
        issue(["templateKey"], "unknown_template", "The record's template is gone."),
      ]);
    }
    if (!stored.ok) return unindexed(stored.issues);
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
        usages.push(
          Object.freeze({
            organizationId: org,
            fieldKey: field.key,
            termKey: key,
            term: term.value,
          }),
        );
      });
    }

    await db.execute(sql`DELETE FROM public.record_terms WHERE ${where}`);
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
        SELECT ${org}::uuid, ${recordId}::uuid, u.field_key, u.term_key,
               u.vocabulary, u.uri, u.label
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
        organizationId: org,
        recordId,
        templateKey,
        templateVersion: version,
        usages: Object.freeze(usages),
        skipped: Object.freeze(skipped),
      }),
    };
  });
  if (result.done) return result.value;
  const retry = retryIssue<RecordTerms>(result.error);
  if (retry) return retry;
  throw result.error;
}

/**
 * Removes a record's usage index, for a record about to be deleted (nothing
 * cascades: the index's foreign key refuses deleting an indexed record).
 * Locks the record first (`FOR UPDATE`, as deleting it will), so it waits for
 * a concurrent save and refresh of the record instead of deadlocking with
 * it: the same order as `refreshRecordTerms`, record before index. Returns
 * how many usages were removed (0 for a record the organization doesn't
 * have). A deadlock or serialization failure is refused as `retry`. Run
 * inside a transaction.
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
    await db.rows(sql`
      SELECT 1 FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid
      FOR UPDATE`);
    const where = sql`organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid`;
    const removed = await db.execute(sql`DELETE FROM public.record_terms WHERE ${where}`);
    await db.execute(sql`DELETE FROM public.record_term_index WHERE ${where}`);
    return removed;
  });
  if (result.done) return { ok: true, value: result.value };
  const retry = retryIssue<number>(result.error);
  if (retry) return retry;
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

function checkAfterKey(after: string | undefined): Validated<string | null> {
  if (after === undefined) return { ok: true, value: null };
  return typeof after === "string" && TERM_KEY.test(after)
    ? { ok: true, value: after }
    : refused(["after"], "invalid_term_key", "A term key is 64 lowercase hex digits.");
}

function checkFieldKey(fieldKey: string | undefined): Validated<string | null> {
  if (fieldKey === undefined) return { ok: true, value: null };
  return isFieldKey(fieldKey)
    ? { ok: true, value: fieldKey }
    : refused(["fieldKey"], "invalid_field_key", "That is not a field key.");
}

interface CountRow {
  term_key: string;
  stored_id: string | null;
  stored_vocabulary: string | null;
  stored_uri: string | null;
  stored_label: string | null;
  used_vocabulary: string | null;
  used_uri: string | null;
  records: number;
}

const COUNT_OPTIONS: ReadonlySet<string> = new Set(["fieldKey", "limit", "after"]);

/** A count row as a `TermCount`, its stored term or URI checked against its key. */
function countFromRow(org: OrganizationId, row: CountRow): Validated<TermCount> {
  if (row.stored_id !== null && row.stored_label !== null) {
    const id = row.stored_id;
    const term = termFromRow({
      vocabulary: row.stored_vocabulary,
      uri: row.stored_uri,
      label: row.stored_label,
      term_key: row.term_key,
    });
    if (!term.ok) return term;
    return {
      ok: true,
      value: Object.freeze({
        termKey: row.term_key,
        vocabulary: term.value.vocabulary ?? "local",
        stored: Object.freeze({ organizationId: org, id, term: term.value, termKey: row.term_key }),
        records: row.records,
      }),
    };
  }
  const vocabulary = row.used_vocabulary ?? "local";
  if (row.used_uri === null) {
    // A local or label-only term: its key is all that is shown.
    return {
      ok: true,
      value: Object.freeze({ termKey: row.term_key, vocabulary, records: row.records }),
    };
  }
  // Never the URI as a record holds it (it can carry text the key ignores,
  // such as dot segments): its canonical form, rebuilt from the key's parts.
  // A URI term's key doesn't depend on its label, so a placeholder label
  // checks the vocabulary and URI against the key without reading a label.
  const uri = canonicalTermUri(row.used_uri);
  const checked = validateControlledTerm({ label: "-", vocabulary, uri });
  if (!checked.ok) return checked;
  if (keyOf(checked.value) !== row.term_key) {
    return refused([], "row_mismatch", "A term usage doesn't match its term key.");
  }
  return {
    ok: true,
    value: Object.freeze({
      termKey: row.term_key,
      vocabulary,
      uri,
      records: row.records,
    }),
  };
}

/**
 * STAFF-ONLY: how many of the organization's records use each term, from the
 * index: every field, every record, published or not. Never for a public
 * site (see the header: public Subjects counts come from published output,
 * T-034/T-050). Every term a counted usage has, and every stored term, with 0
 * when no record uses it (an unused term, for Data Cleaning). With
 * `fieldKey`, only usages in that field count, and terms no record uses there
 * are left out. A record using a term twice counts once. A term the
 * organization hasn't stored is shown by key, vocabulary and canonical URI,
 * never by a label or URI as a record holds it. Any option but `fieldKey`,
 * `limit` and `after` is refused (`unknown_option`).
 *
 * By term key, at most `limit` after the key `after`, for reading in pages;
 * ranking (most used first) is the caller's, over all pages.
 */
export async function termUsageCounts(
  db: Queryable,
  organizationId: OrganizationId,
  options: {
    readonly fieldKey?: string;
    readonly limit?: number;
    readonly after?: string;
  } = {},
): Promise<Validated<TermCounts>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  // A caller asking for something these counts don't do (such as a public
  // scope, which they never had a safe form of) is refused, not ignored.
  for (const key of Object.keys(options)) {
    if (!COUNT_OPTIONS.has(key)) {
      return refused(
        [key],
        "unknown_option",
        "Only fieldKey, limit and after can be given: these counts are staff-only.",
      );
    }
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  const field = checkFieldKey(options.fieldKey);
  if (!field.ok) return field;
  const after = checkAfterKey(options.after);
  if (!after.ok) return after;
  const org = organizationId;
  const rows = await db.rows<CountRow>(sql`
    WITH used AS (
      SELECT term_key, count(DISTINCT record_id)::integer AS records,
             min(coalesce(vocabulary, 'local')) AS vocabulary, min(uri COLLATE "C") AS uri
      FROM public.record_terms
      WHERE organization_id = ${org}::uuid
        AND (${field.value}::text IS NULL OR field_key = ${field.value}::text)
        AND (${after.value}::text IS NULL OR term_key > ${after.value}::text)
      GROUP BY term_key
    ), stored AS (
      SELECT id, term_key, vocabulary, uri, label FROM public.terms
      WHERE organization_id = ${org}::uuid
        AND (${after.value}::text IS NULL OR term_key > ${after.value}::text)
    )
    SELECT coalesce(t.term_key, u.term_key) AS term_key,
           t.id::text AS stored_id, t.vocabulary AS stored_vocabulary, t.uri AS stored_uri,
           t.label AS stored_label, u.vocabulary AS used_vocabulary, u.uri AS used_uri,
           coalesce(u.records, 0) AS records
    FROM used u
    FULL JOIN stored t ON t.term_key = u.term_key
    WHERE ${field.value}::text IS NULL OR u.term_key IS NOT NULL
    ORDER BY coalesce(t.term_key, u.term_key)
    LIMIT ${limit.value + 1}::integer`);
  const counts: TermCount[] = [];
  for (const [index, row] of rows.slice(0, limit.value).entries()) {
    const count = countFromRow(org, row);
    if (!count.ok) {
      return {
        ok: false,
        issues: count.issues.map((i) => issue([index, ...i.path], i.code, i.message)),
      };
    }
    counts.push(count.value);
  }
  return {
    ok: true,
    value: Object.freeze({ counts: Object.freeze(counts), truncated: rows.length > limit.value }),
  };
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
 * (the counts never do): refresh what it lists. By record ID, at most `limit`
 * after the ID `after`: a record whose refresh keeps being refused stays
 * stale, so a job working through the list passes `after` the last ID it saw
 * and so reaches the records beyond a page of ones it can't fix.
 */
export async function recordsWithStaleTerms(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly limit?: number; readonly after?: RecordId } = {},
): Promise<Validated<StaleRecords>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  const limit = checkLimit(options.limit);
  if (!limit.ok) return limit;
  if (options.after !== undefined && !isRecordId(options.after)) {
    return refused(["after"], "invalid_id", BAD_RECORD);
  }
  const after = options.after ?? null;
  const rows = await db.rows<{ id: string }>(sql`
    SELECT r.id::text AS id
    FROM public.records r
    LEFT JOIN public.record_term_index i
      ON i.organization_id = r.organization_id AND i.record_id = r.id
    WHERE r.organization_id = ${organizationId}::uuid
      AND (${after}::uuid IS NULL OR r.id > ${after}::uuid)
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
