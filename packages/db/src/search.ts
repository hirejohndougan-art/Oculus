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
 * diacritics removed, ß/æ/œ/ø/ł… spelled out, lowercase), with the 'simple'
 * configuration: no stemming, no stop words. The query is folded by the same
 * SQL function and parsed by `websearch_to_tsquery` as a parameter, never
 * built into SQL text: quotes for phrases, `or`, `-` to exclude; anything
 * else is just words. A query that can only exclude (`-chair`) matches
 * nothing by text, rather than scanning every record.
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
  issue,
  type OrganizationId,
  type RecordId,
  type Validated,
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
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  /** Present when there are more hits: pass it as `after` for the next page. */
  readonly next?: string;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly after?: string;
}

const OPTIONS: ReadonlySet<string> = new Set(["limit", "after"]);
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

function readOptions(options: unknown): Validated<{ limit: number; after: Cursor | null }> {
  if (options === undefined)
    return { ok: true, value: { limit: DEFAULT_SEARCH_LIMIT, after: null } };
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
        "Only limit and after can be given: staff search has no other scope.",
      );
    }
  }
  let limitValue: unknown;
  let afterValue: unknown;
  try {
    limitValue = ownValue(options, "limit");
    afterValue = ownValue(options, "after");
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
  if (afterValue === undefined) return { ok: true, value: { limit, after: null } };
  const match = typeof afterValue === "string" ? CURSOR.exec(afterValue) : null;
  const id = match?.[3];
  if (!match || !isRecordId(id)) {
    return refused(["after"], "invalid_cursor", "That is not a cursor from an earlier page.");
  }
  return {
    ok: true,
    value: { limit, after: { group: Number(match[1]), rankKey: match[2] ?? "0", id } },
  };
}

interface HitRow {
  id: string;
  title: string;
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
  const { limit, after } = read.value;
  const org = organizationId;

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
        AND querytree(${tsq}) <> 'T'
        AND r.search_document @@ ${tsq}
    ), hits AS (
      SELECT r.id, r.title,
             i.id IS NOT NULL AS by_identifier,
             t.id IS NOT NULL AS by_text,
             CASE WHEN i.id IS NOT NULL THEN 0 ELSE 1 END AS grp,
             coalesce(t.rank_key, 0) AS rank_key
      FROM (SELECT id FROM by_identifier UNION SELECT id FROM by_text) m
      JOIN public.records r ON r.organization_id = ${org}::uuid AND r.id = m.id
      LEFT JOIN by_identifier i ON i.id = m.id
      LEFT JOIN by_text t ON t.id = m.id
    )
    SELECT id::text AS id, title, by_identifier, by_text, grp, rank_key::text AS rank_key
    FROM hits
    WHERE ${after?.group ?? null}::integer IS NULL
       OR grp > ${after?.group ?? null}::integer
       OR (grp = ${after?.group ?? null}::integer
           AND (rank_key < ${after?.rankKey ?? null}::bigint
                OR (rank_key = ${after?.rankKey ?? null}::bigint AND id > ${after?.id ?? null}::uuid)))
    ORDER BY grp, rank_key DESC, id
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
