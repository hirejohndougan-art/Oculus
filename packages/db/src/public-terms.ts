/**
 * Public Subjects counts (T-034d, D-095, on D-062): how many of the records
 * public on a site show each controlled term in their public output.
 *
 * The staff index of `vocabularies.ts` (`record_terms`, `termUsageCounts`)
 * counts every field of every record, published or not, so it is never
 * read here. `publicTermCounts` works the counts out from the public output
 * itself, as a public site would see it: every record public on the site
 * (`public_site_record_ids`, migration 0023) goes through `publicRecordIn`
 * (`readPublicRecord`'s own path through `public_record_snapshot`, 0017),
 * all in one Repeatable Read, read-only transaction, so the counts are of
 * one moment. A record counts for a term when its public output was made
 * (anything the public output refuses counts for nothing) and the term is
 * the value, or one of the values, of a `controlled_term` field of its
 * template that its Dublin Core mapping maps: exactly the terms its public
 * output shows. Inherited values count where they are shown, on the record
 * that shows them. A record showing a term twice counts once for it.
 *
 * Terms are told apart by core's `termIdentity` (as the staff index does:
 * vocabulary and `termUriKey`, or vocabulary and exact label), stored as its
 * SHA-256, so an http and an https copy of one address count as one term.
 * Each count shows the label and URI as public output shows them: those of
 * the counted records, the one most of them show (ties to the lowest in code
 * unit order), never a stored staff copy or anything an unpublished record
 * holds. The connection needs no table privilege: use the public reader
 * (`grantPublicReaderRole`). Nothing is written.
 *
 * The work grows with the records on the site (one snapshot each), so a
 * public site should cache the answer; an index kept at publish time is left
 * for later (see D-095). At most `MAX_PUBLIC_COUNT_RECORDS` records are
 * read: a site with more is refused (`too_many_records`), never counted in
 * part. The issues are for staff, as every public read's are (D-016, S-007).
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
/** IDs read per call of `public_site_record_ids`. */
const PAGE = 1_000;

/** How many of a site's public records show one term. */
export interface PublicTermCount {
  /** SHA-256 of core's `termIdentity`, as `termKey` in `vocabularies.ts`. */
  readonly termKey: string;
  /** The term's vocabulary; `local` for a local term. */
  readonly vocabulary: string;
  /** The label most of the counted records' public output shows. */
  readonly label: string;
  /** The URI shown with that label, when it has one. */
  readonly uri?: string;
  readonly records: number;
}

export interface PublicTermCounts {
  /** Most records first, then by label, then by term key. */
  readonly counts: readonly PublicTermCount[];
  /** How many records public on the site were read. */
  readonly recordsRead: number;
}

export interface PublicTermCountOptions {
  /** As `readPublicRecord`'s: the URL records are published under, ending in `/`. */
  readonly baseUrl: string;
  /** As `readPublicRecord`'s: the organization's Dublin Core mappings. */
  readonly mappings: readonly unknown[];
  /** Only these fields count (for a Subjects page, the subject fields); all when left out. */
  readonly fields?: readonly string[];
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

function readOptions(options: unknown): Validated<{
  baseUrl: string;
  mappings: readonly unknown[];
  fields: ReadonlySet<string> | undefined;
}> {
  const bad = (): Validated<never> =>
    refused([], "invalid_options", "Give { baseUrl, mappings, fields? }.");
  if (typeof options !== "object" || options === null) return bad();
  for (const key of Object.keys(options)) {
    if (key !== "baseUrl" && key !== "mappings" && key !== "fields") return bad();
  }
  const baseUrl = own(options, "baseUrl");
  const mappings = own(options, "mappings");
  if (typeof baseUrl !== "string" || !Array.isArray(mappings)) return bad();
  const fieldList = own(options, "fields");
  if (fieldList === undefined) {
    return Object.hasOwn(options, "fields")
      ? bad()
      : { ok: true, value: { baseUrl, mappings, fields: undefined } };
  }
  if (!Array.isArray(fieldList) || fieldList.length > 200 || !fieldList.every(isFieldKey)) {
    return refused(["fields"], "invalid_fields", "fields must be a list of field keys.");
  }
  return { ok: true, value: { baseUrl, mappings, fields: new Set<string>(fieldList) } };
}

interface Tally {
  vocabulary: string;
  records: number;
  /** How many counted records show each `label\0uri`. */
  shown: Map<string, number>;
}

/**
 * How many of the records public on `siteId` show each controlled term in
 * their public output (see the module header). Refused with `not_available`
 * alone for an organization or site ID that isn't one, as `readPublicRecord`
 * is; a site that isn't the organization's has no public records, so its
 * counts are empty.
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
  const { baseUrl, mappings, fields } = read.value;
  return db.transaction(async (tx) => {
    // One snapshot for every read below, and nothing written.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const ids: RecordId[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await tx.rows<{ id: string }>(sql`
        SELECT id::text AS id
        FROM public.public_site_record_ids(${organizationId}::uuid, ${siteId}::uuid,
                                           ${after}::uuid, ${PAGE + 1}) AS id`);
      for (const row of page.slice(0, PAGE)) {
        if (!isRecordId(row.id)) return refused([], "unreadable_record", CANT_COUNT);
        ids.push(row.id);
      }
      if (ids.length > MAX_PUBLIC_COUNT_RECORDS) {
        return refused(
          [],
          "too_many_records",
          `More than ${String(MAX_PUBLIC_COUNT_RECORDS)} records are public on this site, so they can't be counted here.`,
        );
      }
      if (page.length <= PAGE) break;
      after = ids[ids.length - 1] ?? null;
    }
    const tallies = new Map<string, Tally>();
    for (const id of ids) {
      const one = await publicRecordIn(tx, organizationId, siteId, id, baseUrl, mappings);
      // What the public output refuses shows nothing, so it counts for nothing.
      if (!one.ok) continue;
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
          tally = { vocabulary: term.vocabulary ?? "local", records: 0, shown: new Map() };
          tallies.set(key, tally);
        }
        tally.records += 1;
        const shown = `${term.label}\u0000${term.uri ?? ""}`;
        tally.shown.set(shown, (tally.shown.get(shown) ?? 0) + 1);
      }
    }
    const counts = [...tallies.entries()].map(([termKey, t]) => {
      const [label = "", uri = ""] = mostShown(t.shown).split("\u0000");
      return Object.freeze({
        termKey,
        vocabulary: t.vocabulary,
        label,
        ...(uri === "" ? {} : { uri }),
        records: t.records,
      });
    });
    counts.sort(
      (a, b) => b.records - a.records || compare(a.label, b.label) || compare(a.termKey, b.termKey),
    );
    return {
      ok: true as const,
      value: Object.freeze({ counts: Object.freeze(counts), recordsRead: ids.length }),
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
