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
 * Terms are told apart by core's `termIdentity` (vocabulary and
 * `termUriKey`, or vocabulary and exact label), as the staff index tells
 * them apart, so an http and an https copy of one address count as one
 * term. Each count shows the label and URI the most counted records show
 * (ties to the lowest in code unit order).
 *
 * The work grows with the records on the site (one snapshot each), so a
 * public site must cache the answer, never work it out per request. At most
 * `MAX_PUBLIC_COUNT_RECORDS` records are read, and the work stops after
 * `timeLimitMs` (default 30 seconds): either refuses the whole count
 * (`too_many_records`, `too_slow`), never a part. Issues are for staff.
 */
import { createHash } from "node:crypto";
import {
  isFieldKey,
  isOrganizationId,
  isRecordId,
  isSiteId,
  issue,
  termIdentity,
  validateControlledTerm,
  validateDublinCoreMapping,
  type ControlledTerm,
  type FieldValue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type Validated,
} from "@oculus/core";
import type { Database } from "./client.js";
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
  /** As `readPublicRecord`'s: the organization's Dublin Core mappings. */
  readonly mappings: readonly unknown[];
  /** Only these fields count (for a Subjects page, the subject fields); all when left out. */
  readonly fields?: readonly string[];
  /** Stop and refuse (`too_slow`) after this long; default 30 000, at most 300 000. */
  readonly timeLimitMs?: number;
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

function readOptions(options: unknown): Validated<{
  baseUrl: string;
  mappings: readonly unknown[];
  fields: ReadonlySet<string> | undefined;
  timeLimitMs: number;
}> {
  const bad = (): Validated<never> =>
    refused([], "invalid_options", "Give { baseUrl, mappings, fields?, timeLimitMs? }.");
  if (typeof options !== "object" || options === null) return bad();
  for (const key of Object.keys(options)) {
    if (!["baseUrl", "mappings", "fields", "timeLimitMs"].includes(key)) return bad();
  }
  const baseUrl = own(options, "baseUrl");
  const mappings = own(options, "mappings");
  if (typeof baseUrl !== "string" || !Array.isArray(mappings)) return bad();
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
  const fieldList = own(options, "fields");
  if (fieldList === undefined) {
    return Object.hasOwn(options, "fields")
      ? bad()
      : { ok: true, value: { baseUrl, mappings, fields: undefined, timeLimitMs } };
  }
  if (!Array.isArray(fieldList) || fieldList.length > 200 || !fieldList.every(isFieldKey)) {
    return refused(["fields"], "invalid_fields", "fields must be a list of field keys.");
  }
  return {
    ok: true,
    value: { baseUrl, mappings, fields: new Set<string>(fieldList), timeLimitMs },
  };
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
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) {
    return refused([], "not_available", "This record is not available.");
  }
  const read = readOptions(options);
  if (!read.ok) return read;
  const { baseUrl, mappings, fields, timeLimitMs } = read.value;
  try {
    return await countIn(db, organizationId, siteId, baseUrl, mappings, fields, timeLimitMs);
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
  baseUrl: string,
  mappings: readonly unknown[],
  fields: ReadonlySet<string> | undefined,
  timeLimitMs: number,
): Promise<Validated<PublicTermCounts>> {
  const deadline = Date.now() + timeLimitMs;
  return db.transaction(async (tx) => {
    // One snapshot for every read below, and nothing written.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeLimitMs)}, true)`);
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
    for (const id of ids) {
      if (Date.now() > deadline) return tooSlow();
      const one = await publicRecordIn(tx, organizationId, siteId, id, baseUrl, mappings);
      // What the public output refuses shows nothing, so it counts for nothing.
      if (!one.ok) continue;
      counted += 1;
      const { view, template, mapping } = one.value;
      const mapped = validateDublinCoreMapping(mapping, template);
      if (!mapped.ok) continue;
      const shownFields = new Set(mapped.value.entries.map((e) => e.field));
      const termFields = new Set(
        template.fields.filter((f) => f.kind === "controlled_term").map((f) => f.key),
      );
      const seen = new Map<string, ControlledTerm>();
      for (const entry of view.entries) {
        if (!termFields.has(entry.key) || !shownFields.has(entry.key)) continue;
        if (fields !== undefined && !fields.has(entry.key)) continue;
        for (const term of termsOf(entry.value)) {
          const key = keyOf(term);
          if (key !== undefined && !seen.has(key)) seen.set(key, term);
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
      value: Object.freeze({ counts: Object.freeze(counts), recordsCounted: counted }),
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

/** The terms a shown value holds: one term, or each term of a list; anything else, none. */
function termsOf(value: FieldValue): ControlledTerm[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const out: ControlledTerm[] = [];
  for (const item of items) {
    const term = validateControlledTerm(item);
    if (term.ok) out.push(term.value);
  }
  return out;
}

function keyOf(term: ControlledTerm): string | undefined {
  const text = termIdentity(term);
  return text.ok ? createHash("sha256").update(text.value, "utf8").digest("hex") : undefined;
}
