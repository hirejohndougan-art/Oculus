/**
 * Public Subjects counts (T-034d, D-095, on D-062): how many of the records
 * public on a site show each controlled term in their public output.
 *
 * The staff index of `vocabularies.ts` (`record_terms`, `termUsageCounts`)
 * counts every field of every record, published or not, so it is never
 * read here. `publicTermCounts` works the counts out from the public output
 * itself: every record public on the site (by 0017's `record_public_on_site`)
 * goes through `publicRecordIn` (`readPublicRecord`'s own path through
 * `public_record_snapshot`), all in one Repeatable Read, read-only
 * transaction, so the counts are of one moment. A record counts for a term
 * when its public output was made (anything the public output refuses, such
 * as a record a deed or restriction holds back, counts for nothing) and the
 * term is the value, or one of the values, of a `controlled_term` field of
 * its template that its Dublin Core mapping maps: exactly the terms its
 * public output shows. Inherited values count where they are shown, on the
 * record that shows them. A record showing a term twice counts once for it.
 *
 * **What comes out is public; how it is worked out is not.** The listing
 * reads the records table, so the connection is the server's staff one (the
 * writer role, which a public site's process already holds), never the
 * public reader: giving the public reader a list of every published record
 * would hand it the IDs of records the public output holds back, whose
 * snapshots carry staff values (review of T-034d). The result holds only
 * what the public output shows: each term's label and URI and how many
 * records show it, and how many records' public output was counted. It
 * never holds a vocabulary key, a term key, an ID or a count of records
 * held back.
 *
 * Terms are told apart by what the public sees: a term with a URI by
 * `termUriKey(uri)` (so an http and an https copy of one address count as
 * one term), any other by its exact label. The vocabulary is never read,
 * since public output never shows it. Each count shows the label and URI the
 * most counted records show (ties to the lowest in code unit order).
 *
 * The work grows with the records on the site (one snapshot each), so a
 * public site must cache the answer, never work it out per request. At most
 * `MAX_PUBLIC_COUNT_RECORDS` records are read, and the work stops after
 * `timeLimitMs` (default 30 seconds): either refuses the whole count
 * (`too_many_records`, `too_slow`), never a part. Issues are for staff.
 */
import {
  isFieldKey,
  isOrganizationId,
  isRecordId,
  isSiteId,
  issue,
  termUriKey,
  validateDublinCoreMapping,
  type FieldValue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type Validated,
} from "@oculus/core";
import type { Database, Queryable } from "./client.js";
import { sql } from "./sql.js";
import { publicRecordIn } from "./workflow.js";

/** At most this many records public on one site are counted (more refuses). */
export const MAX_PUBLIC_COUNT_RECORDS = 10_000;

/** How many of a site's public records show one term. */
export interface PublicTermCount {
  /** The label most of the counted records' public output shows. */
  readonly label: string;
  /** The URI shown with that label, when it has one. */
  readonly uri?: string;
  readonly records: number;
}

export interface PublicTermCounts {
  /** Most records first, then by label, then by URI. */
  readonly counts: readonly PublicTermCount[];
  /** How many records' public output was counted (records held back aren't). */
  readonly recordsCounted: number;
}

export interface PublicTermCountOptions {
  /** As `readPublicRecord`'s: the URL records are published under, ending in `/`. */
  readonly baseUrl: string;
  /** As `readPublicRecord`'s: the organization's Dublin Core mappings; the stored ones when left out. */
  readonly mappings?: readonly unknown[];
  /** Only these fields count; all when left out. */
  readonly fields?: readonly string[];
  /**
   * Only fields the record's mapping maps to these Dublin Core terms count
   * (a Subjects page: `["subject"]`, S-038); all mapped fields when left out.
   */
  readonly terms?: readonly string[];
  /** Stop and refuse (`too_slow`) after this long; default 30 000, at most 300 000. */
  readonly timeLimitMs?: number;
}

/** What only a server-side caller may add (S-038): a way to stop a count early. */
export interface StaffCountControl {
  /** Checked before each record; true stops the count, refused as `stopped`. */
  readonly shouldStop?: () => boolean;
}

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** An own data property, never a getter or an inherited one. */
function own(obj: unknown, name: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, name);
  return d !== undefined && "value" in d ? d.value : undefined;
}

const DEFAULT_TIME_LIMIT_MS = 30_000;
const MAX_TIME_LIMIT_MS = 300_000;

interface ReadOptions {
  baseUrl: string;
  mappings: readonly unknown[] | undefined;
  fields: ReadonlySet<string> | undefined;
  terms: ReadonlySet<string> | undefined;
  timeLimitMs: number;
}

function readOptions(options: unknown): Validated<ReadOptions> {
  const bad = (): Validated<never> =>
    refused([], "invalid_options", "Give { baseUrl, mappings?, fields?, terms?, timeLimitMs? }.");
  if (typeof options !== "object" || options === null) return bad();
  for (const key of Object.keys(options)) {
    if (!["baseUrl", "mappings", "fields", "terms", "timeLimitMs"].includes(key)) return bad();
  }
  const baseUrl = own(options, "baseUrl");
  const mappings = own(options, "mappings");
  if (typeof baseUrl !== "string") return bad();
  if (Object.hasOwn(options, "mappings") && !Array.isArray(mappings)) return bad();
  const mappingList = Array.isArray(mappings) ? (mappings as readonly unknown[]) : undefined;
  const limit = own(options, "timeLimitMs");
  if (Object.hasOwn(options, "timeLimitMs")) {
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TIME_LIMIT_MS
    ) {
      return refused(
        ["timeLimitMs"],
        "invalid_time_limit",
        `timeLimitMs must be a whole number of milliseconds from 1 to ${String(MAX_TIME_LIMIT_MS)}.`,
      );
    }
  }
  const timeLimitMs = typeof limit === "number" ? limit : DEFAULT_TIME_LIMIT_MS;
  let fields: ReadonlySet<string> | undefined;
  if (Object.hasOwn(options, "fields")) {
    const fieldList = own(options, "fields");
    if (fieldList === undefined) return bad();
    if (!Array.isArray(fieldList) || fieldList.length > 200 || !fieldList.every(isFieldKey)) {
      return refused(["fields"], "invalid_fields", "fields must be a list of field keys.");
    }
    fields = new Set<string>(fieldList);
  }
  let terms: ReadonlySet<string> | undefined;
  if (Object.hasOwn(options, "terms")) {
    const termList = own(options, "terms");
    if (
      !Array.isArray(termList) ||
      termList.length > 50 ||
      !termList.every((t) => typeof t === "string" && /^[a-zA-Z]{1,40}$/.test(t))
    ) {
      return refused(["terms"], "invalid_terms", "terms must be a list of Dublin Core terms.");
    }
    terms = new Set<string>(termList as string[]);
  }
  return { ok: true, value: { baseUrl, mappings: mappingList, fields, terms, timeLimitMs } };
}

interface Tally {
  records: number;
  /** How many counted records show each `label\0uri`. */
  shown: Map<string, number>;
}

/**
 * How many of the records public on `siteId` show each controlled term in
 * their public output (see the module header). `db` is the server's staff
 * connection (it reads the records table), never the public reader's.
 * Refused with `not_available` alone for an organization or site ID that
 * isn't one, as `readPublicRecord` is; a site that isn't the organization's
 * has no public records, so its counts are empty.
 */
export async function publicTermCounts(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  options: PublicTermCountOptions,
): Promise<Validated<PublicTermCounts>> {
  const result = await publicTermCountsForStaff(db, organizationId, siteId, options);
  return result.ok ? { ok: true, value: result.value.counts } : result;
}

/** The counts, and for staff only: how many public records were left out, by reason. */
export interface PublicTermCountsForStaff {
  /** What a public site may show (no ID, no count of records held back). */
  readonly counts: PublicTermCounts;
  /**
   * Staff only (S-038): how many records public on the site were left out
   * because their public output was refused, by each refusal's issue code
   * (a record refused for two reasons counts under both). Never shown to
   * the public.
   */
  readonly leftOut: Readonly<Record<string, number>>;
  /** Staff only: how many records were left out in all. */
  readonly recordsLeftOut: number;
}

/** As `publicTermCounts`, with the staff-only count of records left out and why. */
export async function publicTermCountsForStaff(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  options: PublicTermCountOptions,
  control: StaffCountControl = {},
): Promise<Validated<PublicTermCountsForStaff>> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) {
    return refused([], "not_available", "This record is not available.");
  }
  const read = readOptions(options);
  if (!read.ok) return read;
  try {
    return await countIn(db, organizationId, siteId, read.value, control.shouldStop);
  } catch (error) {
    // The statement timeout cancelled a read (57014): the same refusal as the deadline.
    if ((error as { code?: unknown } | null)?.code === QUERY_CANCELED) return tooSlow();
    throw error;
  }
}

const QUERY_CANCELED = "57014";

function tooSlow(): Validated<never> {
  return refused([], "too_slow", "Counting the records public on this site took too long.");
}

async function countIn(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  { baseUrl, mappings, fields, terms, timeLimitMs }: ReadOptions,
  shouldStop: (() => boolean) | undefined,
): Promise<Validated<PublicTermCountsForStaff>> {
  const deadline = Date.now() + timeLimitMs;
  return db.transaction(async (tx) => {
    // One snapshot for every read below, and nothing written.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const remaining = async (): Promise<boolean> => {
      const left = deadline - Date.now();
      if (left < 1) return false;
      // Each statement may take only what is left, so the limit is a ceiling.
      await tx.execute(
        sql`SELECT pg_catalog.set_config('statement_timeout', ${String(left)}, true)`,
      );
      return true;
    };
    if (!(await remaining())) return tooSlow();
    const rows = await tx.rows<{ id: string }>(sql`
      SELECT r.id::text AS id FROM public.records r
      WHERE r.organization_id = ${organizationId}::uuid
        AND public.record_public_on_site(r, ${siteId}::uuid)
      ORDER BY r.id
      LIMIT ${MAX_PUBLIC_COUNT_RECORDS + 1}`);
    if (rows.length > MAX_PUBLIC_COUNT_RECORDS) {
      return refused(
        [],
        "too_many_records",
        `More than ${String(MAX_PUBLIC_COUNT_RECORDS)} records are public on this site, so they can't be counted here.`,
      );
    }
    const ids: RecordId[] = [];
    for (const row of rows) {
      if (!isRecordId(row.id)) return refused([], "unreadable_record", CANT_COUNT);
      ids.push(row.id);
    }
    const tallies = new Map<string, Tally>();
    let counted = 0;
    let leftOutRecords = 0;
    const leftOut = new Map<string, number>();
    for (const id of ids) {
      if (shouldStop?.() === true) return refused([], "stopped", "The count was stopped.");
      if (!(await remaining())) return tooSlow();
      const one = await publicRecordIn(tx, organizationId, siteId, id, baseUrl, mappings);
      // What the public output refuses shows nothing, so it counts for nothing.
      if (!one.ok) {
        leftOutRecords += 1;
        for (const code of new Set(one.issues.map((i) => i.code))) {
          leftOut.set(code, (leftOut.get(code) ?? 0) + 1);
        }
        continue;
      }
      counted += 1;
      const { view, template, mapping } = one.value;
      const mapped = validateDublinCoreMapping(mapping, template);
      if (!mapped.ok) continue;
      const shownFields = new Set(
        mapped.value.entries
          .filter((e) => terms === undefined || terms.has(e.term))
          .map((e) => e.field),
      );
      const termFields = new Set(
        template.fields.filter((f) => f.kind === "controlled_term").map((f) => f.key),
      );
      const seen = new Map<string, ShownTerm>();
      for (const entry of view.entries) {
        if (!termFields.has(entry.key) || !shownFields.has(entry.key)) continue;
        if (fields !== undefined && !fields.has(entry.key)) continue;
        for (const term of termsOf(entry.value)) {
          const key = keyOf(term);
          if (!seen.has(key)) seen.set(key, term);
        }
      }
      for (const [key, term] of seen) {
        let tally = tallies.get(key);
        if (tally === undefined) {
          tally = { records: 0, shown: new Map() };
          tallies.set(key, tally);
        }
        tally.records += 1;
        const shown = `${term.label}\u0000${term.uri ?? ""}`;
        tally.shown.set(shown, (tally.shown.get(shown) ?? 0) + 1);
      }
    }
    const counts = [...tallies.values()].map((t) => {
      const [label = "", uri = ""] = mostShown(t.shown).split("\u0000");
      return Object.freeze({ label, ...(uri === "" ? {} : { uri }), records: t.records });
    });
    counts.sort(
      (a, b) =>
        b.records - a.records || compare(a.label, b.label) || compare(a.uri ?? "", b.uri ?? ""),
    );
    return {
      ok: true as const,
      value: Object.freeze({
        counts: Object.freeze({ counts: Object.freeze(counts), recordsCounted: counted }),
        leftOut: Object.freeze(Object.fromEntries([...leftOut].sort(([a], [b]) => compare(a, b)))),
        recordsLeftOut: leftOutRecords,
      }),
    };
  });
}

const CANT_COUNT = "The records public on this site can't be read for counting.";
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The `label\0uri` most records show; ties to the lowest in code unit order. */
function mostShown(shown: ReadonlyMap<string, number>): string {
  let best = "";
  let most = -1;
  for (const [text, n] of shown) {
    if (n > most || (n === most && compare(text, best) < 0)) {
      best = text;
      most = n;
    }
  }
  return best;
}

/** A term as public output shows it: its label, and its URI if it has one. */
interface ShownTerm {
  readonly label: string;
  readonly uri?: string;
}

/**
 * The terms a shown value holds, as public output shows them (label and URI,
 * D-016): one term, or each term of a list. A value with no label shows no
 * term. The vocabulary is never read: public output doesn't show it.
 */
function termsOf(value: FieldValue): ShownTerm[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const out: ShownTerm[] = [];
  for (const item of items) {
    const label = own(item, "label");
    const uri = own(item, "uri");
    if (typeof label !== "string" || label === "") continue;
    out.push(typeof uri === "string" && uri !== "" ? { label, uri } : { label });
  }
  return out;
}

/**
 * Which term a shown term is, by what the public sees: its URI as
 * `termUriKey` compares URIs (so http and https copies of one address are
 * one term), or its exact label when it has no URI.
 */
function keyOf(term: ShownTerm): string {
  if (term.uri === undefined) return `label\u0000${term.label}`;
  let key: string;
  try {
    key = termUriKey(term.uri);
  } catch {
    key = term.uri;
  }
  return `uri\u0000${key}`;
}

/**
 * A marker that changes whenever something a site's public output reads may
 * have changed in the organization (S-038): a record's version (every edit,
 * publish and withdraw writes one), its identifiers (saved without a new
 * version), a stored mapping, a template version, an identifier type.
 * Compared, never shown. Counts and versions catch every insert and delete;
 * the row versions (`xmin`) catch every update, whatever its `now()` (a
 * transaction's start, so a timestamp can go backwards). Its cost grows with
 * the organization's rows in those tables (one index-only or sequential pass
 * each, a minute apart).
 */
export async function publicOutputMarker(
  db: Database,
  organizationId: OrganizationId,
  timeLimitMs = 30_000,
): Promise<string> {
  if (!isOrganizationId(organizationId)) throw new TypeError("not an organization ID");
  if (!Number.isInteger(timeLimitMs) || timeLimitMs < 1 || timeLimitMs > MAX_TIME_LIMIT_MS) {
    throw new RangeError("timeLimitMs out of range");
  }
  const org = organizationId;
  // A time limit of its own, so a lock (a migration) or a large organization
  // can't hold the caller up: past it the query is cancelled and throws.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(
      sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeLimitMs)}, true),
                 pg_catalog.set_config('lock_timeout', ${String(timeLimitMs)}, true)`,
    );
    return markerIn(tx, org);
  });
}

async function markerIn(tx: Queryable, org: OrganizationId): Promise<string> {
  const [row] = await tx.rows<{ marker: string }>(sql`
    SELECT concat_ws('|',
      (SELECT count(*)::text || ':' || coalesce(max(recorded_at)::text, '')
         FROM public.record_versions WHERE organization_id = ${org}::uuid),
      (SELECT count(*)::text || ':' || coalesce(sum(version), 0)::text
         FROM public.dublin_core_mappings WHERE organization_id = ${org}::uuid),
      (SELECT count(*)::text FROM public.template_versions WHERE organization_id = ${org}::uuid),
      (SELECT count(*)::text || ':' || coalesce(sum(xmin::text::numeric), 0)::text
         FROM public.identifier_types WHERE organization_id = ${org}::uuid),
      (SELECT count(*)::text || ':' || coalesce(sum(xmin::text::numeric), 0)::text
         FROM public.record_identifiers WHERE organization_id = ${org}::uuid),
      (SELECT count(*)::text || ':' || coalesce(sum(xmin::text::numeric), 0)::text
         FROM public.former_identifiers WHERE organization_id = ${org}::uuid)
    ) AS marker`);
  return row?.marker ?? "";
}
