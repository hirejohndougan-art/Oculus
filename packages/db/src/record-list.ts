/**
 * The staff items list (T-046, D-083): an organization's records, a page at
 * a time, newest change first or by title, narrowed by home sites, workflow
 * state and record type. The admin's Item records screen shows it when no
 * search words are given (with words it uses staff search, search.ts).
 *
 * ===========================================================================
 * STAFF ONLY, like search.ts: titles and states of unpublished records.
 * Never for a public site.
 * ===========================================================================
 *
 * **Every filter is in the SQL**, so neither a page, its length nor its
 * `next` says anything about records outside them: the service passes the
 * home sites the person may see every record of (D-074, D-079), and the
 * filters only narrow. **Pages are offsets** (at most `MAX_LIST_OFFSET`),
 * not a cursor of the last row's sort key, so no title or time is ever sent
 * back in a request: a record changed between two pages may show twice or
 * be skipped, which a staff list can live with. Every query names one
 * organization (D-019).
 */
import {
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

/** One record as the items list shows it. */
export interface ListedRecord {
  readonly recordId: RecordId;
  readonly title: string;
  readonly kind: string;
  readonly recordTypeKey: string | null;
  readonly siteId: string | null;
  readonly state: WorkflowState;
  readonly version: number;
  readonly updatedAt: string;
}

export interface RecordList {
  readonly records: readonly ListedRecord[];
  /** Present when there are more: the offset of the next page. */
  readonly next?: number;
}

export type RecordListSort = "updated" | "title";

export interface RecordListOptions {
  /** Only records whose home site is one of these; `"all"` for every record (on no site too). */
  readonly sites: "all" | readonly SiteId[];
  readonly state?: WorkflowState;
  readonly recordType?: string;
  /** `updated` (default): last changed first; `title`: A to Z. */
  readonly sort?: RecordListSort;
  /** Rows to skip (0 to `MAX_LIST_OFFSET`). */
  readonly offset?: number;
  /** 1 to `MAX_LIST_LIMIT`, default 50. */
  readonly limit?: number;
}

export const MAX_LIST_LIMIT = 100;
/** The deepest page: past it, staff search or a filter finds the record. */
export const MAX_LIST_OFFSET = 10_000;

function refused<T>(path: readonly string[], code: string, message: string): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/**
 * STAFF ONLY: the organization's records on `sites`, filtered and sorted.
 * Refused, with nothing read: `invalid_organization`, `invalid_sites`,
 * `invalid_state`, `invalid_record_type`, `invalid_sort`, `invalid_offset`,
 * `invalid_limit`.
 */
export async function listRecords(
  db: Queryable,
  organizationId: OrganizationId,
  options: RecordListOptions,
): Promise<Validated<RecordList>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", "Not an organization ID.");
  }
  const { sites, state, recordType } = options;
  const sort: unknown = options.sort ?? "updated";
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (sites !== "all" && (!Array.isArray(sites) || !sites.every((s) => isSiteId(s)))) {
    return refused(["sites"], "invalid_sites", 'sites is "all" or a list of site IDs.');
  }
  if (state !== undefined && !isWorkflowState(state)) {
    return refused(["state"], "invalid_state", "state is a workflow state.");
  }
  if (recordType !== undefined && !isRecordTypeKey(recordType)) {
    return refused(["recordType"], "invalid_record_type", "recordType is a record type key.");
  }
  if (sort !== "updated" && sort !== "title") {
    return refused(["sort"], "invalid_sort", "sort is updated or title.");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_LIST_OFFSET) {
    return refused(
      ["offset"],
      "invalid_offset",
      `The offset is a whole number from 0 to ${String(MAX_LIST_OFFSET)}.`,
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return refused(
      ["limit"],
      "invalid_limit",
      `The limit is a whole number from 1 to ${String(MAX_LIST_LIMIT)}.`,
    );
  }
  const all = sites === "all";
  const order =
    sort === "title"
      ? sql`ORDER BY lower(r.title), r.title, r.id`
      : sql`ORDER BY r.updated_at DESC, r.id`;
  const rows = await db.rows<{
    id: string;
    title: string;
    kind: string;
    record_type_key: string | null;
    site_id: string | null;
    workflow_state: string;
    version: number;
    updated_at: string;
  }>(sql`
    SELECT r.id::text AS id, r.title, r.kind, r.record_type_key, r.site_id::text AS site_id,
           r.workflow_state, r.version,
           to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid
      AND (${all}::boolean OR r.site_id = ANY(${all ? [] : [...sites]}::uuid[]))
      AND (${state ?? null}::text IS NULL OR r.workflow_state = ${state ?? null}::text)
      AND (${recordType ?? null}::text IS NULL OR r.record_type_key = ${recordType ?? null}::text)
    ${order}
    OFFSET ${offset}::integer
    LIMIT ${limit + 1}::integer`);
  const records = rows.slice(0, limit).map((row): ListedRecord => {
    if (!isRecordId(row.id) || !isWorkflowState(row.workflow_state)) {
      throw new Error("A stored record row doesn't read as a record.");
    }
    return Object.freeze({
      recordId: row.id,
      title: row.title,
      kind: row.kind,
      recordTypeKey: row.record_type_key,
      siteId: row.site_id,
      state: row.workflow_state,
      version: row.version,
      updatedAt: row.updated_at,
    });
  });
  const more = rows.length > limit && offset + limit <= MAX_LIST_OFFSET;
  return {
    ok: true,
    value: Object.freeze({
      records: Object.freeze(records),
      ...(more ? { next: offset + limit } : {}),
    }),
  };
}

/** One record type as the admin lists it. */
export interface RecordTypeSummary {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: string;
  readonly defaultTemplateKey: string;
}

/**
 * The organization's record types at their current versions, by key (at
 * most 1000). The definitions are read as stored and only the listed
 * properties of well-formed ones are returned; a type that no longer reads
 * is left out (the editor offers only types it can use).
 */
export async function listRecordTypes(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly RecordTypeSummary[]> {
  if (!isOrganizationId(organizationId)) throw new TypeError("Not an organization ID.");
  const rows = await db.rows<{ key: string; definition: unknown }>(sql`
    SELECT DISTINCT ON (key) key, definition
    FROM public.record_type_versions
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY key, version DESC
    LIMIT 1000`);
  const out: RecordTypeSummary[] = [];
  for (const row of rows) {
    const d = row.definition;
    if (typeof d !== "object" || d === null || Array.isArray(d)) continue;
    const def = d as Record<string, unknown>;
    const { label, kind, defaultTemplateKey, description, organizationId: org } = def;
    if (
      org !== organizationId ||
      def.key !== row.key ||
      typeof label !== "string" ||
      typeof kind !== "string" ||
      typeof defaultTemplateKey !== "string"
    ) {
      continue;
    }
    out.push(
      Object.freeze({
        key: row.key,
        label,
        kind,
        defaultTemplateKey,
        ...(typeof description === "string" ? { description } : {}),
      }),
    );
  }
  return Object.freeze(out);
}
