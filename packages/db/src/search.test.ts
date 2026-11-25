// Staff search (0007_staff_search.sql, search.ts, D-066) on a freshly
// migrated database: accent-insensitive words, ranking, lookup by current and
// former numbers through the identifier key, the index following every
// record write, organizations kept apart, hostile and oversized queries, and
// paging. All data is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STANDARD_PRESETS,
  createRecord,
  newOrganizationId,
  templateFromPreset,
  type CatalogRecord,
  type JsonValue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import { openDatabase, type Database, type Queryable } from "./client.js";
import {
  insertOrganization,
  insertRecord,
  insertTemplateVersion,
  updateRecord,
} from "./catalog.js";
import { insertIdentifierType, saveRecordIdentifiers } from "./identifiers.js";
import { migrate } from "./migrate.js";
import { restoreVersion } from "./record-restore.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  searchRecords,
  type SearchOptions,
  type SearchResults,
} from "./search.js";
import { sql } from "./sql.js";
import { freshDatabase, writeRecordDirectly, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, set up lazily inside each test.

const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:00:00.000Z";
let setup: Promise<{ testDb: TestDatabase; db: Database }> | undefined;
let db: Database;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    return { testDb, db: openDatabase(testDb.url, { max: 4 }) };
  })();
  db = (await setup).db;
}

// Warm the setup before the first test, under the suite's longer hook limit
// (U-008). A failure stays in `setup`, so with no database each test still
// fails on its own when it calls ready().
beforeAll(() => ready().catch(() => undefined));

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
    await done.testDb.drop();
  }
});

function ok<T>(result: Validated<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function tx<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

/** A new organization with the spectrum-object template and an object number type. */
async function organization(): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(db, { id: org, name: "Invented Historical Society" }));
  const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
  ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org))));
  // A template with nothing required, for restoring old versions.
  ok(
    await insertTemplateVersion(db, {
      key: "invented-note",
      organizationId: org,
      label: "Invented notes",
      appliesTo: ["object"],
      fields: [
        {
          key: "note",
          label: "Note",
          kind: "text",
          required: false,
          repeatable: false,
          visibility: "staff",
          inherited: false,
        },
      ],
    }),
  );
  ok(
    await tx((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "object_number",
        label: "Object number",
        uniqueness: "current",
      }),
    ),
  );
  return org;
}

async function record(
  org: OrganizationId,
  title: string,
  fields: Record<string, JsonValue> = {},
  templateKey = "spectrum-object",
): Promise<CatalogRecord> {
  const made = ok(
    createRecord({ organizationId: org, kind: "object", title, templateKey, fields }, new Date(T)),
  );
  ok(await tx((q) => insertRecord(q, made, { actor: "system:test" })));
  return made;
}

async function numbers(
  org: OrganizationId,
  recordId: RecordId,
  current: string[],
  former: string[] = [],
): Promise<void> {
  ok(
    await tx((q) =>
      saveRecordIdentifiers(q, {
        recordId,
        organizationId: org,
        current: current.map((value, i) => ({ type: "object_number", value, primary: i === 0 })),
        former: former.map((value) => ({ type: "object_number", value })),
      }),
    ),
  );
}

async function search(
  org: OrganizationId,
  query: string,
  options?: SearchOptions,
): Promise<SearchResults> {
  return ok(await searchRecords(db, org, query, options));
}

async function ids(org: OrganizationId, query: string): Promise<RecordId[]> {
  return (await search(org, query, { limit: MAX_SEARCH_LIMIT })).hits.map((h) => h.recordId);
}

// ---------------------------------------------------------------------------

describe("words", () => {
  it("match without regard to accents, case or compatibility forms, both ways", async () => {
    await ready();
    const org = await organization();
    const brulee = await record(org, "Crème brûlée recipe card", {
      brief_description: "Printed in Øresund for a Straße café",
    });
    const plain = await record(org, "Cafe menu", { brief_description: "Plain ASCII creme, fixed" });
    for (const query of ["creme brulee", "CRÈME BRÛLÉE", "Cre\u0300me", "oresund", "STRASSE"]) {
      expect(await ids(org, query), query).toContain(brulee.id);
    }
    // Accented query, plain record, and the other way round.
    expect((await ids(org, "café")).sort()).toEqual([brulee.id, plain.id].sort());
    expect((await ids(org, "crème")).sort()).toEqual([brulee.id, plain.id].sort());
    // Full-width letters and a ligature fold to plain letters.
    expect(await ids(org, "ＭＥＮＵ")).toEqual([plain.id]);
    expect(await ids(org, "\ufb01xed")).toEqual([plain.id]);
    // Greek and Cyrillic fold case on any server locale.
    const greek = await record(org, "ΣΟΦΙΑ in Москва");
    expect(await ids(org, "σοφια")).toEqual([greek.id]);
    expect(await ids(org, "МОСКВА")).toEqual([greek.id]);
  });

  it("keep Hebrew and Arabic vowel marks: vocalized and unvocalized text don't match", async () => {
    await ready();
    const org = await organization();
    const hebrew = await record(org, "\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd"); // with niqqud
    const arabic = await record(org, "\u0643\u064e\u062a\u064e\u0628\u064e"); // with harakat
    expect(await ids(org, "\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd")).toEqual([hebrew.id]);
    expect(await ids(org, "\u05e9\u05dc\u05d5\u05dd")).toEqual([]);
    expect(await ids(org, "\u0643\u064e\u062a\u064e\u0628\u064e")).toEqual([arabic.id]);
    expect(await ids(org, "\u0643\u062a\u0628")).toEqual([]);
  });

  it("search every string in the fields, staff-only ones and nested values too", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "An invented chair", {
      brief_description: "Oak",
      // An invented field holding a donor note; staff search sees it.
      donor_note: "Given by an invented donor in Galvez",
      materials: [{ label: "Walnut veneer", vocabulary: "local" }],
    });
    expect(await ids(org, "galvez")).toEqual([r.id]);
    expect(await ids(org, "walnut veneer")).toEqual([r.id]);
    // Object keys are not words.
    expect(await ids(org, "donor_note")).toEqual([]);
    expect(await ids(org, "vocabulary")).toEqual([]);
  });

  it("follow websearch syntax: phrases, or, and exclusion; exclusion alone finds nothing", async () => {
    await ready();
    const org = await organization();
    const a = await record(org, "Bayou ferry landing");
    const b = await record(org, "Ferry to the bayou");
    const c = await record(org, "Ferry tickets");
    expect((await ids(org, "bayou ferry")).sort()).toEqual([a.id, b.id].sort());
    expect(await ids(org, '"bayou ferry"')).toEqual([a.id]);
    expect((await ids(org, "ferry -bayou")).sort()).toEqual([c.id]);
    expect((await ids(org, "landing or tickets")).sort()).toEqual([a.id, c.id].sort());
    expect(await ids(org, "-bayou")).toEqual([]);
    expect(await ids(org, "!!! ...")).toEqual([]);
  });

  it("find nothing by text for a query a record with none of its words would match", async () => {
    await ready();
    const org = await organization();
    const chair = await record(org, "Invented chair");
    const table = await record(org, "Invented table");
    const other = await record(org, "Invented lamp");
    await numbers(org, other.id, ["CHAIR OR -TABLE"]);
    // An exclusion that stands alone or is OR'd with words would match
    // every record lacking the excluded word, so no text search is run:
    // not even the chair is found by its word. The number lookup still runs.
    for (const query of [
      "-table",
      "-chair -table",
      "chair or -table",
      '"invented chair" or -table',
    ]) {
      const result = await search(org, query, { limit: MAX_SEARCH_LIMIT });
      expect(
        result.hits.filter((h) => h.matchedBy.includes("text")),
        query,
      ).toEqual([]);
    }
    expect(await ids(org, "chair or -table")).toEqual([other.id]);
    // An exclusion ANDed with a word, or beside OR'd words, is run as usual.
    expect((await ids(org, "invented -table")).sort()).toEqual([chair.id, other.id].sort());
    expect((await ids(org, "chair or lamp -table")).sort()).toEqual([chair.id, other.id].sort());
    expect(await ids(org, "table")).toEqual([table.id]);
  });

  it("rank a title match above a field match", async () => {
    await ready();
    const org = await organization();
    const inField = await record(org, "Ledger", { brief_description: "A lighthouse keeper's log" });
    const inTitle = await record(org, "Lighthouse keeper's log");
    const both = await record(org, "Lighthouse photograph", {
      brief_description: "lighthouse lighthouse lighthouse",
    });
    const result = await search(org, "lighthouse");
    expect(result.hits.map((h) => h.recordId)).toEqual([both.id, inTitle.id, inField.id]);
    const ranks = result.hits.map((h) => h.rank);
    expect(ranks[0]).toBeGreaterThan(ranks[1] ?? 0);
    expect(ranks[1]).toBeGreaterThan(ranks[2] ?? 0);
    expect(ranks[2]).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.matchedBy.join() === "text")).toBe(true);
    expect(result.hits[1]?.title).toBe("Lighthouse keeper's log");
  });
});

describe("identifiers", () => {
  it("find current and former numbers through the identifier key, look-alikes included", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "An invented chair");
    await numbers(org, r.id, ["DHS-0001"], ["1985.004"]);
    for (const query of [
      "DHS-0001",
      "dhs - 0001",
      " \uff44\uff48\uff53\uff0d\uff10\uff10\uff10\uff11 ",
      "D\u041dS-0001", // Cyrillic Н
      "DHS\u20130001", // en dash
      "1985.004",
      "1985 .004",
    ]) {
      const result = await search(org, query);
      expect(
        result.hits.map((h) => h.recordId),
        query,
      ).toEqual([r.id]);
      expect(result.hits[0]?.matchedBy, query).toEqual(["identifier"]);
    }
    // Digits and letters stay apart (0 is not O).
    expect(await ids(org, "DHS-OOO1")).toEqual([]);
  });

  it("follow identifier saves: a renumbered record is found by its new and old numbers", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "An invented chair");
    await numbers(org, r.id, ["DHS-0002"]);
    expect(await ids(org, "DHS-0003")).toEqual([]);
    await numbers(org, r.id, ["DHS-0003"], ["DHS-0002"]);
    expect(await ids(org, "dhs-0003")).toEqual([r.id]);
    expect(await ids(org, "dhs-0002")).toEqual([r.id]);
    // A number dropped altogether no longer finds it.
    await numbers(org, r.id, ["DHS-0003"]);
    expect(await ids(org, "dhs-0002")).toEqual([]);
  });

  it("put identifier matches first and say when a record matched both ways", async () => {
    await ready();
    const org = await organization();
    const titled = await record(org, "Box 1907 of letters");
    const numbered = await record(org, "Letters");
    await numbers(org, numbered.id, ["1907"]);
    const both = await record(org, "Ledger 1907");
    // A former number may share its key with another record's current one.
    await numbers(org, both.id, ["1907-B"], ["1907"]);
    const result = await search(org, "1907");
    // Identifier matches first (by text rank among them), then text only.
    expect(result.hits.map((h) => [h.recordId, h.matchedBy.join("+")])).toEqual([
      [both.id, "identifier+text"],
      [numbered.id, "identifier"],
      [titled.id, "text"],
    ]);
    expect(result.hits[1]?.rank).toBe(0);
  });
});

describe("keeping the index in step", () => {
  it("follows updates and restores, and no writer can set the document", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "Invented steamboat whistle", {}, "invented-note");
    expect(await ids(org, "steamboat")).toEqual([r.id]);
    ok(
      await tx((q) =>
        updateRecord(
          q,
          { ...r, title: "Invented locomotive whistle", updatedAt: LATER },
          { expectedVersion: 1, actor: "system:test" },
        ),
      ),
    );
    expect(await ids(org, "steamboat")).toEqual([]);
    expect(await ids(org, "locomotive")).toEqual([r.id]);
    ok(
      await tx((q) =>
        restoreVersion(q, org, r.id, 1, { expectedVersion: 2, actor: "system:test" }),
      ),
    );
    expect(await ids(org, "steamboat")).toEqual([r.id]);
    expect(await ids(org, "locomotive")).toEqual([]);

    // A direct SQL writer follows too, and can't write the document itself.
    await writeRecordDirectly(
      db,
      sql`UPDATE public.records SET title = 'Invented foghorn', version = version + 1
          WHERE organization_id = ${org}::uuid AND id = ${r.id}::uuid`,
      org,
      r.id,
    );
    expect(await ids(org, "foghorn")).toEqual([r.id]);
    for (const statement of [
      sql`UPDATE public.records SET search_document = to_tsvector('simple', 'forged')
          WHERE organization_id = ${org}::uuid AND id = ${r.id}::uuid`,
      sql`INSERT INTO public.records (organization_id, id, kind, template_key, title, fields,
                                      created_at, updated_at, search_document)
          VALUES (${org}::uuid, gen_random_uuid(), 'object', 'spectrum-object', 'x', '{}',
                  now(), now(), to_tsvector('simple', 'forged'))`,
    ]) {
      await expect(tx((q) => q.execute(statement))).rejects.toMatchObject({ code: "428C9" });
    }
    expect(await ids(org, "forged")).toEqual([]);
  });

  it("rebuilds every stored document with rebuild_search_documents, without touching versions", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "Invented weathervane");
    const versionsBefore = await db.rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM public.record_versions`,
    );
    // A plain UPDATE to recompute the documents is refused: every record
    // write needs a version of its own (D-063).
    await expect(
      tx((q) =>
        q.execute(
          sql`UPDATE public.records SET title = title WHERE organization_id = ${org}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    // Only the table's owner can rebuild: a role with the app's grants is
    // refused and nothing changes (the role is created and dropped by the
    // rolled-back transaction).
    await expect(
      tx((q) =>
        q.execute(sql`DO $$ BEGIN
          CREATE ROLE oculus_test_t028_not_owner NOLOGIN;
          GRANT USAGE ON SCHEMA public TO oculus_test_t028_not_owner;
          GRANT SELECT, INSERT, UPDATE ON public.records TO oculus_test_t028_not_owner;
          SET LOCAL ROLE oculus_test_t028_not_owner;
          PERFORM public.rebuild_search_documents();
        END $$`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Stand-in for a server whose Unicode tables or locale changed: the fold
    // now spells "w" as "v". Stored documents keep the old fold, so the
    // folded query no longer meets them until they are rebuilt.
    await db.execute(sql`ALTER FUNCTION public.search_fold(text) RENAME TO search_fold_saved`);
    try {
      await db.execute(sql`
        CREATE FUNCTION public.search_fold(t text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
        SET search_path = pg_catalog, pg_temp
        AS $$ SELECT replace(lower(t), 'w', 'v') $$`);
      expect(await ids(org, "weathervane")).toEqual([]);
      await db.execute(sql`SELECT public.rebuild_search_documents()`);
      expect(await ids(org, "weathervane")).toEqual([r.id]);
      const [doc] = await db.rows<{ doc: string }>(
        sql`SELECT search_document::text AS doc FROM public.records
            WHERE organization_id = ${org}::uuid AND id = ${r.id}::uuid`,
      );
      expect(doc?.doc).toContain("veathervane");
    } finally {
      await db.execute(sql`DROP FUNCTION public.search_fold(text)`);
      await db.execute(sql`ALTER FUNCTION public.search_fold_saved(text) RENAME TO search_fold`);
      await db.execute(sql`SELECT public.rebuild_search_documents()`);
    }
    expect(await ids(org, "weathervane")).toEqual([r.id]);
    // Same rows, same versions, same index; still not writable.
    const [stored] = await db.rows<{ version: number; title: string }>(
      sql`SELECT version, title FROM public.records
          WHERE organization_id = ${org}::uuid AND id = ${r.id}::uuid`,
    );
    expect(stored).toEqual({ version: 1, title: "Invented weathervane" });
    expect(
      await db.rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM public.record_versions`),
    ).toEqual(versionsBefore);
    expect(
      await db.rows<{ def: string }>(
        sql`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'records_search'`,
      ),
    ).toEqual([
      { def: "CREATE INDEX records_search ON public.records USING gin (search_document)" },
    ]);
    await expect(
      tx((q) =>
        q.execute(sql`UPDATE public.records SET search_document = to_tsvector('simple', 'forged')
                      WHERE organization_id = ${org}::uuid`),
      ),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  it("stays under the 1 MB tsvector limit for the densest text known (hyphenated pairs)", async () => {
    await ready();
    const org = await organization();
    // "X-Y" gives three words (X-Y, X and Y) for four characters: with
    // distinct 4-byte letters, the most tsvector bytes per character found
    // (D-066). 166 pairs fill the 1,000-unit title; 3 fields of 16,000
    // pairs are well past the 100,000-character cap.
    const pair = (n: number): string =>
      String.fromCodePoint(0x20000 + ((2 * n) % 65_536), 0x2d) +
      String.fromCodePoint(0x20000 + ((2 * n + 1) % 65_536));
    const pairs = (from: number, count: number): string =>
      Array.from({ length: count }, (_, i) => pair(from + i)).join(" ");
    const fields: Record<string, JsonValue> = {};
    for (let i = 0; i < 3; i += 1) fields[`text_${String(i)}`] = pairs(i * 16_000, 16_000);
    const dense = await record(org, pairs(60_000, 166), fields);
    // The part PostgreSQL limits to under 1 MB is the lexemes and their
    // positions: the whole value less its 8-byte header and 4 bytes a word.
    const [size] = await db.rows<{ data: number }>(
      sql`SELECT (pg_column_size(search_document) - 8 - 4 * length(search_document))::integer AS data
          FROM public.records WHERE organization_id = ${org}::uuid AND id = ${dense.id}::uuid`,
    );
    const data = size?.data ?? Infinity;
    // About 765,000 bytes: roughly a quarter under the limit. Raising the
    // 100,000-character cap must redo this (D-066).
    expect(data).toBeGreaterThan(700_000);
    expect(data).toBeLessThan(800_000);
    expect(data).toBeLessThan(1_048_576);
    expect(await ids(org, pair(0))).toEqual([dense.id]);
  });

  it("stores the largest record core allows, indexing its first 100,000 characters of field text", async () => {
    await ready();
    const org = await organization();
    // Nine fields of almost 100,000 UTF-16 units each: short words of 4-byte
    // characters, all distinct, the hardest text to fit in a tsvector (1 MB).
    const word = (n: number): string =>
      String.fromCodePoint(0x20000 + (n % 40_000), 0x20000 + Math.floor(n / 40_000));
    const words = (from: number, count: number): string =>
      Array.from({ length: count }, (_, i) => word(from + i)).join(" ");
    const fields: Record<string, JsonValue> = {};
    for (let i = 0; i < 9; i += 1) {
      const prefix = i === 0 ? "needle " : i === 8 ? "haystack " : "";
      fields[`text_${String(i)}`] = prefix + words(i * 20_000, 19_998);
    }
    // jsonb sorts keys by length, then bytes: text_8 comes last.
    const big = await record(org, "Invented transcript", fields);
    expect(await ids(org, "needle")).toEqual([big.id]);
    // Beyond the first 100,000 characters, words are not indexed.
    expect(await ids(org, "haystack")).toEqual([]);
  });
});

describe("organizations", () => {
  it("never see each other's records, words or numbers", async () => {
    await ready();
    const one = await organization();
    const two = await organization();
    const a = await record(one, "Invented shared title", { brief_description: "lantern" });
    const b = await record(two, "Invented shared title", { brief_description: "lantern" });
    await numbers(one, a.id, ["DHS-0100"]);
    await numbers(two, b.id, ["DHS-0100"]);
    for (const query of ["invented shared title", "lantern", "DHS-0100"]) {
      expect(await ids(one, query), query).toEqual([a.id]);
      expect(await ids(two, query), query).toEqual([b.id]);
    }
    const onlyTwo = await record(two, "Invented sextant");
    await numbers(two, onlyTwo.id, ["SX-1"], ["OLD-1"]);
    for (const query of ["sextant", "SX-1", "OLD-1"]) {
      expect(await ids(one, query), query).toEqual([]);
    }
    // A cursor from one organization's page shows nothing of the other's.
    const page = await search(two, "invented", { limit: 1 });
    expect(page.next).toBeDefined();
    const after = page.next ?? "";
    expect((await search(one, "invented", { after })).hits.every((h) => h.recordId !== b.id)).toBe(
      true,
    );
    // An organization that doesn't exist finds nothing.
    expect((await search(newOrganizationId(), "invented")).hits).toEqual([]);
  });
});

describe("hostile and oversized queries", () => {
  it("treat SQL, tsquery operators and control characters as plain text", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "Invented drop leaf table");
    for (const query of [
      "'); DROP TABLE public.records; --",
      "drop' OR '1'='1",
      "table & !leaf | (drop:* <-> x)",
      '"unbalanced phrase',
      "\\x00 $1 $$ ${x} %s",
      "drop\u0000table",
      "drop\ud800table",
      "):*",
      "' || pg_sleep(5) || '",
    ]) {
      const result = await searchRecords(db, org, query);
      expect(result.ok, query).toBe(true);
    }
    expect(await ids(org, "'); DROP TABLE; --")).toEqual([r.id]);
    expect(await ids(org, "'); DROP TABLE public.records; --")).toEqual([]);
    expect(await ids(org, "drop\u0000table")).toEqual([r.id]);
    expect(await ids(org, "table & !leaf")).toEqual([r.id]);
    const [row] = await db.rows<{ n: number }>(
      sql`SELECT count(*)::integer AS n FROM public.records WHERE organization_id = ${org}::uuid`,
    );
    expect(row?.n).toBe(1);
  });

  it("refuse queries that are too long, empty or not text, before any work", async () => {
    await ready();
    const org = await organization();
    const r = await record(org, "Invented telegraph key");
    const longest = `telegraph ${"x".repeat(MAX_SEARCH_QUERY_LENGTH - 10)}`;
    expect(longest).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(
      ok(await searchRecords(db, org, `telegraph or ${"y ".repeat(243)}`)).hits[0]?.recordId,
    ).toBe(r.id);
    expect(ok(await searchRecords(db, org, longest)).hits).toEqual([]);
    expect(codes(await searchRecords(db, org, `${longest}x`))).toEqual(["query_too_long"]);
    const started = Date.now();
    expect(codes(await searchRecords(db, org, "a ".repeat(5_000_000)))).toEqual(["query_too_long"]);
    expect(Date.now() - started).toBeLessThan(1000);
    for (const query of ["", "   ", "\u0000\u0007\n\t"]) {
      expect(codes(await searchRecords(db, org, query)), JSON.stringify(query)).toEqual([
        "empty_query",
      ]);
    }
    expect(codes(await searchRecords(db, org, 42 as unknown as string))).toEqual(["invalid_query"]);
  });

  it("refuse bad organizations and options, and any scope but staff", async () => {
    await ready();
    const org = await organization();
    expect(codes(await searchRecords(db, "nope" as OrganizationId, "x"))).toEqual([
      "invalid_organization",
    ]);
    const bad = (options: unknown): Promise<Validated<SearchResults>> =>
      searchRecords(db, org, "x", options as SearchOptions);
    expect(codes(await bad({ public: true }))).toEqual(["unknown_option"]);
    expect(codes(await bad({ scope: "public" }))).toEqual(["unknown_option"]);
    expect(codes(await bad({ [Symbol("x")]: 1 }))).toEqual(["unknown_option"]);
    expect(codes(await bad("limit"))).toEqual(["invalid_options"]);
    // `sites` (T-042) only narrows: "all", or a list of site IDs.
    for (const sites of ["public", "every", [""], ["nope"], [7], {}, null]) {
      expect(codes(await bad({ sites })), JSON.stringify(sites)).toEqual(["invalid_sites"]);
    }
    expect((await bad({ sites: "all" })).ok).toBe(true);
    expect((await bad({ sites: [] })).ok).toBe(true);
    for (const limit of [0, -1, 1.5, MAX_SEARCH_LIMIT + 1, "10", Number.NaN]) {
      expect(codes(await bad({ limit })), String(limit)).toEqual(["invalid_limit"]);
    }
    for (const after of [
      "",
      "x",
      "2.0.00000000-0000-4000-8000-000000000000",
      "0.-1.00000000-0000-4000-8000-000000000000",
      "0.1.not-a-uuid-------------------------",
      "0.1.00000000-0000-1000-8000-000000000000",
      "0.1234567890123456.00000000-0000-4000-8000-000000000000",
      42,
    ]) {
      expect(codes(await bad({ after })), String(after)).toEqual(["invalid_cursor"]);
    }
    const getter = {};
    Object.defineProperty(getter, "limit", { get: () => 5, enumerable: true });
    expect(ok(await bad(getter)).hits).toEqual([]);
  });
});

describe("paging", () => {
  it("walks every hit once, in order, across pages", async () => {
    await ready();
    const org = await organization();
    const made: RecordId[] = [];
    for (let i = 0; i < 7; i += 1) {
      // Ranks differ (title vs field, repetitions) and some tie.
      const fields: Record<string, JsonValue> =
        i % 3 === 0 ? { brief_description: "invented lamp ".repeat(i + 1) } : {};
      made.push(
        (await record(org, i % 2 === 0 ? `Lamp ${String(i)}` : `Object ${String(i)}`, fields)).id,
      );
    }
    const numbered = await record(org, "Unrelated");
    await numbers(org, numbered.id, ["LAMP"]);
    made.push(numbered.id);
    const all = await search(org, "lamp", { limit: MAX_SEARCH_LIMIT });
    expect(all.next).toBeUndefined();
    expect(new Set(all.hits.map((h) => h.recordId))).toEqual(
      new Set(made.filter((_, i) => i % 2 === 0 || i % 3 === 0 || i === 7)),
    );
    expect(all.hits[0]?.recordId).toBe(numbered.id);
    const walked: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await search(
        org,
        "lamp",
        after === undefined ? { limit: 2 } : { limit: 2, after },
      );
      expect(page.hits.length).toBeLessThanOrEqual(2);
      walked.push(...page.hits.map((h) => h.recordId));
      after = page.next;
      pages += 1;
    } while (after !== undefined && pages < 20);
    expect(walked).toEqual(all.hits.map((h) => h.recordId));
    expect(pages).toBe(Math.ceil(all.hits.length / 2));
    // Ranks never rise within the text group.
    const textRanks = all.hits.slice(1).map((h) => h.rank);
    expect([...textRanks].sort((x, y) => y - x)).toEqual(textRanks);
  });

  it("orders and pages by numeric rank when ranks have different numbers of digits", async () => {
    await ready();
    const org = await organization();
    // Rank keys of about 150,000 (one word in the title), 60,000 (two words
    // in a field) and 30,000 (one word in a field): sorted as text, the
    // 6-digit best hit sorts after the 5-digit ones ("1..." < "3..." < "6...").
    const title = await record(org, "Lamp");
    const oneWord = await record(org, "Ledger", { brief_description: "lamp" });
    const twoWords = await record(org, "Ledger two", { brief_description: "lamp zzz" });
    const query = "lamp or zzz or yyy or www";
    const all = await search(org, query, { limit: MAX_SEARCH_LIMIT });
    const keys = all.hits.map((h) => String(Math.round(h.rank * 1_000_000)).length);
    expect(new Set(keys).size).toBeGreaterThan(1);
    const ranks = all.hits.map((h) => h.rank);
    expect([...ranks].sort((x, y) => y - x)).toEqual(ranks);
    expect(all.hits.map((h) => h.recordId)).toEqual([title.id, twoWords.id, oneWord.id]);
    // A walk one hit at a time sees every hit exactly once, in rank order.
    const walked: RecordId[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await search(
        org,
        query,
        after === undefined ? { limit: 1 } : { limit: 1, after },
      );
      walked.push(...page.hits.map((h) => h.recordId));
      after = page.next;
      pages += 1;
    } while (after !== undefined && pages < 10);
    expect(walked).toEqual(all.hits.map((h) => h.recordId));
    expect(new Set(walked).size).toBe(3);
  });

  it("uses the default limit", async () => {
    await ready();
    const org = await organization();
    for (let i = 0; i < DEFAULT_SEARCH_LIMIT + 1; i += 1)
      await record(org, `Invented spoon ${String(i)}`);
    const first = await search(org, "spoon");
    expect(first.hits).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(first.next).toBeDefined();
    const rest = await search(org, "spoon", { after: first.next ?? "" });
    expect(rest.hits).toHaveLength(1);
    expect(rest.next).toBeUndefined();
  });
});
