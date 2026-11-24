/**
 * Staff search (T-028, D-066): find an organization's records by the words
 * in their titles and fields, and by any number they hold or held.
 *
 * ===========================================================================
 * STAFF ONLY. `searchRecords` searches every record of the organization,
 * published or not, through every field, staff-only fields (donor and
 * accession notes, staff numbers) included, and finds records by former and
 * staff-only identifiers. Its results, ranks and counts must never reach a
 * public site, a public API or anything a visitor can see or time. The
 * public search (Phase 4) indexes only the published public views of
 * published records (`publicOutput`), in an index of its own, and never
 * reads `records.search_document`, never calls this function and never
 * uses it to pick, count or order public results: a hit on a staff-only
 * word would reveal that the word is there. There is deliberately no
 * option for a public scope; unknown options are refused.
 * ===========================================================================
 *
 * **Text.** `records.search_document` (migration 0007) is a stored generated
 * column, so the database keeps it in step with every record write, by any
 * writer; nothing here maintains it. It holds the title (weight A) and every
 * string in the fields (weight C), folded by `public.search_fold` (NFKD,
 * Latin, Greek and Cyrillic diacritics removed, ß/æ/œ/ø/ł… spelled out,
 * lowercase), with the 'simple' configuration: no stemming, no stop words.
 * Hebrew and Arabic vowel marks (and Indic vowel signs) are kept, so
 * vocalized and unvocalized Hebrew or Arabic text do not match each other.
 * The query is folded by the same SQL function and parsed by
 * `websearch_to_tsquery` as a parameter, never built into SQL text: quotes
 * for phrases, `or`, `-` to exclude; anything else is just words.
 *
 * A query that a record holding none of its words would match finds nothing
 * by text (`querytree` is `T`): an exclusion alone (`-chair`, `-a -b`) and
 * any exclusion OR'd with the rest (`chair or -table`, `"a b" or -c`), which
 * would otherwise mean every record without the excluded word, unindexed.
 * So `chair or -table` does not find the chair either. An exclusion ANDed
 * with words (`chair -table`, `chair or lamp -table`) runs as usual. The
 * identifier lookup runs for every query.
 *
 * **Cost.** `ts_rank` is computed for every matching record of the
 * organization on every page (ranking can't use the index), and the GIN
 * index has no organization column, so a common word costs in proportion to
 * how many records hold it, across all organizations (about 260-540 ms at
 * 50,000 records). Whatever exposes this over HTTP must set a
 * `statement_timeout` or cap the matches first (D-066): the service's
 * `searchRecords` (T-042, D-079) runs it under a `statement_timeout`.
 *
 * **Sites.** `sites` (T-042, D-074) narrows the search to records whose
 * home site is one of the given sites: `"all"` (the default) searches
 * every record of the organization, records on no site included; a list
 * never matches a record on no site. It only narrows, never widens: it is
 * not a public scope, and the service passes the sites the person may see
 * every record of, so a hit, a page's length or its cursor never says that
 * a record of another site matched.
 *
 * **Filters** (T-046, D-083): `state` (a workflow state) and `recordType`
 * (a record type key) narrow the search further, in the same SQL as
 * `sites`, so a page's length and cursor say nothing about records outside
 * them. Like `sites` they only narrow.
 *
 * **Identifiers.** The whole query is also looked up as a number, by core's
 * `identifierKey` in `identifier_holdings` (current and former numbers of
 * every type, the same key uniqueness uses, D-009, D-061), so `dhs 0001`,
 * `ＤＨＳ－０００１` and a Cyrillic look-alike find `DHS-0001`, and an old
 * number finds the record that held it. Holdings are written by the
 * identifier saves themselves, so they are always in step.
 *
 * **Order and pages.** Identifier matches come first, then by text rank
 * (`ts_rank`, scaled to a whole number so pages compare exactly), then by
 * record ID. `next` is an opaque cursor for the following page; pass it back
 * as `after` with the same query.
 *
 * Every query names one organization (D-019): the organization is in every
 * WHERE, so another organization's records, numbers and words are never
 * read, matched or counted.
 */
import {
  identifierKey,
  isOrganizationId,
  isRecordId,
  isRecordTypeKey,
  isSiteId,
  isWorkflowState,
  issue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type Validated,
  type WorkflowState,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** The most characters (UTF-16 units) a search query may have. */
export const MAX_SEARCH_QUERY_LENGTH = 500;
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;

/** How a hit was found: by a number it holds or held, or by its words. */
export type MatchedBy = "identifier" | "text";

export interface SearchHit {
  readonly recordId: RecordId;
  /** The record's stored title (staff data). */
  readonly title: string;
  /** Text rank, 0 for a record found only by number; higher is better. */
  readonly rank: number;
  /** `identifier` and/or `text`, in that order. */
  readonly matchedBy: readonly MatchedBy[];
  /** The record's kind, record type (or null), home site (or null) and workflow state (T-046). */
  readonly kind: string;
  readonly recordTypeKey: string | null;
  readonly siteId: string | null;
  readonly state: string;
  /** The record's version and when it last changed, for the items list. */
  readonly version: number;
  readonly updatedAt: string;
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  /** Present when there are more hits: pass it as `after` for the next page. */
  readonly next?: string;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly after?: string;
  /** Only records whose home site is one of these; `"all"` (default) for every record. */
  readonly sites?: "all" | readonly string[];
  /** Only records in this workflow state (T-046). */
  readonly state?: WorkflowState;
  /** Only records of this record type (its key, T-046). */
  readonly recordType?: string;
}

/** The most sites one search may name. */
const MAX_SEARCH_SITES = 1000;

const OPTIONS: ReadonlySet<string> = new Set(["limit", "after", "sites", "state", "recordType"]);
/** The rank is ts_rank times this, as a whole number. */
const RANK_SCALE = 1_000_000;
/** group (0 identifier, 1 text only) . rank key . record ID */
const CURSOR = /^([01])\.(0|[1-9][0-9]{0,14})\.([0-9a-f-]{36})$/;
/** C0 and C1 controls (NUL can't be sent to PostgreSQL) and lone surrogates. */
const UNSENDABLE =
  /[\p{Cc}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** An own data property, never through a getter or a proxy's trap. */
function ownValue(value: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(value, key);
  return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
}

interface Cursor {
  readonly group: number;
  readonly rankKey: string;
  readonly id: RecordId;
}

interface ReadOptions {
  limit: number;
  after: Cursor | null;
  sites: readonly SiteId[] | null;
  state: WorkflowState | null;
  recordType: string | null;
}

function readSites(value: unknown): Validated<readonly SiteId[] | null> {
  if (value === undefined || value === "all") return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > MAX_SEARCH_SITES) {
    return refused(["sites"], "invalid_sites", 'sites is "all" or a list of site IDs.');
  }
  const sites: SiteId[] = [];
  for (const site of value as unknown[]) {
    if (!isSiteId(site)) {
      return refused(["sites"], "invalid_sites", 'sites is "all" or a list of site IDs.');
    }
    sites.push(site);
  }
  return { ok: true, value: Object.freeze(sites) };
}

function readOptions(options: unknown): Validated<ReadOptions> {
  if (options === undefined) {
    return {
      ok: true,
      value: {
        limit: DEFAULT_SEARCH_LIMIT,
        after: null,
        sites: null,
        state: null,
        recordType: null,
      },
    };
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return refused(["options"], "invalid_options", "The options are an object.");
  }
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(options);
  } catch {
    return refused(["options"], "invalid_options", "The options are an object.");
  }
  for (const key of keys) {
    if (typeof key !== "string" || !OPTIONS.has(key)) {
      return refused(
        [String(key)],
        "unknown_option",
        "Only limit, after, sites, state and recordType can be given: staff search has no other scope.",
      );
    }
  }
  let limitValue: unknown;
  let afterValue: unknown;
  let sitesValue: unknown;
  let stateValue: unknown;
  let typeValue: unknown;
  try {
    limitValue = ownValue(options, "limit");
    afterValue = ownValue(options, "after");
    sitesValue = ownValue(options, "sites");
    stateValue = ownValue(options, "state");
    typeValue = ownValue(options, "recordType");
  } catch {
    return refused(["options"], "invalid_options", "The options are an object.");
  }
  const limit = limitValue ?? DEFAULT_SEARCH_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SEARCH_LIMIT
  ) {
    return refused(
      ["limit"],
      "invalid_limit",
      `The limit is a whole number from 1 to ${String(MAX_SEARCH_LIMIT)}.`,
    );
  }
  const sites = readSites(sitesValue);
  if (!sites.ok) return sites;
  if (stateValue !== undefined && !isWorkflowState(stateValue)) {
    return refused(["state"], "invalid_state", "state is a workflow state.");
  }
  if (typeValue !== undefined && !isRecordTypeKey(typeValue)) {
    return refused(["recordType"], "invalid_record_type", "recordType is a record type key.");
  }
  const filters = {
    sites: sites.value,
    state: stateValue ?? null,
    recordType: typeValue ?? null,
  };
  if (afterValue === undefined) return { ok: true, value: { limit, after: null, ...filters } };
  const match = typeof afterValue === "string" ? CURSOR.exec(afterValue) : null;
  const id = match?.[3];
  if (!match || !isRecordId(id)) {
    return refused(["after"], "invalid_cursor", "That is not a cursor from an earlier page.");
  }
  return {
    ok: true,
    value: {
      limit,
      after: { group: Number(match[1]), rankKey: match[2] ?? "0", id },
      ...filters,
    },
  };
}

interface HitRow {
  id: string;
  title: string;
  kind: string;
  record_type_key: string | null;
  site_id: string | null;
  workflow_state: string;
  version: number;
  updated_at: string;
  by_identifier: boolean;
  by_text: boolean;
  grp: number;
  rank_key: string;
}

/**
 * STAFF ONLY (see the header): the organization's records matching `query`
 * by text or by a current or former identifier, best first, at most `limit`
 * (default 50, at most 200) after the cursor `after`.
 *
 * Refused, with nothing read: `invalid_organization`, `invalid_query` (not a
 * string), `empty_query` (nothing but spaces and control characters),
 * `query_too_long` (over `MAX_SEARCH_QUERY_LENGTH`), `invalid_limit`,
 * `invalid_cursor`, `unknown_option`, `invalid_options`. Control characters
 * and unpaired surrogates in the query count as spaces.
 */
export async function searchRecords(
  db: Queryable,
  organizationId: OrganizationId,
  query: string,
  options?: SearchOptions,
): Promise<Validated<SearchResults>> {
  if (!isOrganizationId(organizationId)) {
    return refused(
      ["organizationId"],
      "invalid_organization",
      "The organization ID must be a lowercase version 4 UUID.",
    );
  }
  const read = readOptions(options);
  if (!read.ok) return read;
  if (typeof query !== "string") {
    return refused(["query"], "invalid_query", "The search query is text.");
  }
  // Measured before any other work, so a huge query costs nothing.
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return refused(
      ["query"],
      "query_too_long",
      `A search query has at most ${String(MAX_SEARCH_QUERY_LENGTH)} characters.`,
    );
  }
  const text = query.replace(UNSENDABLE, " ").trim();
  if (text === "") return refused(["query"], "empty_query", "Type something to search for.");
  const key = identifierKey(text);
  const numberKey = key === "" ? null : key;
  const { limit, after, sites, state, recordType } = read.value;
  const org = organizationId;
  // Every record (null), or only those whose home site is listed; and the
  // state and record type filters (T-046), all in the query (narrowing only).
  const onSites = sql`(${sites === null}::boolean OR r.site_id = ANY(${sites ?? []}::uuid[]))
    AND (${state}::text IS NULL OR r.workflow_state = ${state}::text)
    AND (${recordType}::text IS NULL OR r.record_type_key = ${recordType}::text)`;

  const tsq = sql`websearch_to_tsquery('pg_catalog.simple'::regconfig, public.search_fold(${text}::text))`;
  const rows = await db.rows<HitRow>(sql`
    WITH by_identifier AS (
      SELECT DISTINCT h.record_id AS id
      FROM public.identifier_holdings h
      WHERE h.organization_id = ${org}::uuid AND h.key = ${numberKey}::text
    ), by_text AS (
      SELECT r.id, (ts_rank(r.search_document, ${tsq}) * ${RANK_SCALE}::double precision)::bigint AS rank_key
      FROM public.records r
      WHERE r.organization_id = ${org}::uuid
        AND ${onSites}
        AND querytree(${tsq}) <> 'T'
        AND r.search_document @@ ${tsq}
    ), hits AS (
      SELECT r.id, r.title, r.kind, r.record_type_key, r.site_id, r.workflow_state,
             r.version, r.updated_at,
             i.id IS NOT NULL AS by_identifier,
             t.id IS NOT NULL AS by_text,
             CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END AS grp,
             coalesce(t.rank_key, 0) AS rank_key
      FROM (SELECT id FROM by_identifier UNION SELECT id FROM by_text) m
      JOIN public.records r ON r.organization_id = ${org}::uuid AND r.id = m.id AND ${onSites}
      LEFT JOIN by_identifier i ON i.id = m.id
      LEFT JOIN by_text t ON t.id = m.id
    )
    SELECT id::text AS id, title, kind, record_type_key, site_id::text AS site_id,
           workflow_state, version,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
           by_identifier, by_text, grp, rank_key::text AS rank_key
    FROM hits
    WHERE ${after?.group ?? null}::integer IS NULL
       OR grp > ${after?.group ?? null}::integer
       OR (grp = ${after?.group ?? null}::integer
           AND (rank_key < ${after?.rankKey ?? null}::bigint
                OR (rank_key = ${after?.rankKey ?? null}::bigint AND id > ${after?.id ?? null}::uuid)))
    -- The hits' own columns, not the text output columns of the same names:
    -- ordered as text, a rank with fewer digits would sort above a higher one.
    ORDER BY hits.grp, hits.rank_key DESC, hits.id
    LIMIT ${limit + 1}::integer`);

  const hits = rows.slice(0, limit).map((row): SearchHit => {
    if (!isRecordId(row.id)) throw new Error("A stored record ID is not a record ID.");
    const matchedBy: MatchedBy[] = [];
    if (row.by_identifier) matchedBy.push("identifier");
    if (row.by_text) matchedBy.push("text");
    return Object.freeze({
      recordId: row.id,
      title: row.title,
      rank: Number(row.rank_key) / RANK_SCALE,
      matchedBy: Object.freeze(matchedBy),
      kind: row.kind,
      recordTypeKey: row.record_type_key,
      siteId: row.site_id,
      state: row.workflow_state,
      version: row.version,
      updatedAt: row.updated_at,
    });
  });
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    ok: true,
    value: Object.freeze({
      hits: Object.freeze(hits),
      ...(last === undefined ? {} : { next: `${String(last.grp)}.${last.rank_key}.${last.id}` }),
    }),
  };
}
