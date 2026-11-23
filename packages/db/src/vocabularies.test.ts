// The vocabulary tables (0004_vocabularies.sql) and their data-access module,
// on a freshly migrated database: stored terms round-trip through core's
// validators and are stored once per organization; the usage index counts
// records per term without reading records, follows a record's changes when
// refreshed and shows when it is stale; and direct SQL can't move rows or
// point across organizations (D-019, D-062).
import { afterAll, describe, expect, it } from "vitest";
import {
  STANDARD_PRESETS,
  createRecord,
  findNearDuplicateTerms,
  newOrganizationId,
  templateFromPreset,
  validateControlledTerm,
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
  readTemplate,
} from "./catalog.js";
import { migrate } from "./migrate.js";
import { sql, type Sql } from "./sql.js";
import {
  freshDatabase,
  storeDirectVersion,
  writeRecordDirectly,
  type TestDatabase,
} from "./test-database.fixtures.js";
import {
  clearRecordTerms,
  readTerm,
  readTerms,
  recordsUsingTerm,
  recordsWithStaleTerms,
  refreshRecordTerms,
  saveTerm,
  canonicalTermUri,
  termKey,
  termUsageCounts,
  type StoredTerms,
  type StaleRecords,
  type TermCounts,
} from "./vocabularies.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, set up lazily inside each test.

const T = "2026-11-20T16:05:00.000Z";
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

function codes(result: Validated<unknown> | undefined): string[] {
  if (result === undefined) throw new Error("not found");
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function tx<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

async function refusedBy(query: Sql): Promise<{ code: string; constraint?: string }> {
  try {
    await tx((q) => q.execute(query));
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return {
      code: e.code ?? "",
      ...(e.constraint === undefined ? {} : { constraint: e.constraint }),
    };
  }
  throw new Error("The statement was not refused.");
}

const FOREIGN_KEY = "23503";
const CHECK = "23514";
const IDENTITY = "23000";

// ---------------------------------------------------------------------------
// Invented sample data. The LCSH URI is in id.loc.gov's canonical form; the
// Nomenclature addresses and local terms are made up.

const LCSH = {
  label: "Railroads",
  vocabulary: "lcsh",
  uri: "http://id.loc.gov/authorities/subjects/sh85110870",
};
const CHAIR = {
  label: "Chair",
  vocabulary: "nomenclature",
  uri: "https://nomenclature.info/nom/1",
};
const DEPOT = { label: "Invented Street depot" };
const WOOD = { label: "Wood", vocabulary: "local" };

/** A new organization with the spectrum-object template. */
async function organization(name = "Invented Historical Society"): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(db, { id: org, name }));
  const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
  ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org))));
  return org;
}

async function record(org: OrganizationId, fields: Record<string, JsonValue>): Promise<RecordId> {
  const made = ok(
    createRecord(
      {
        organizationId: org,
        kind: "object",
        title: "An invented chair",
        templateKey: "spectrum-object",
        fields,
      },
      new Date(T),
    ),
  );
  ok(await db.transaction((tx) => insertRecord(tx, made, { actor: "system:test" })));
  return made.id;
}

const refresh = (org: OrganizationId, id: RecordId): ReturnType<typeof refreshRecordTerms> =>
  tx((q) => refreshRecordTerms(q, org, id));

const keyOf = (term: unknown): string => ok(termKey(term));

/**
 * Each term's count, by its stored label, else its URI, else its key (a term
 * not stored has no label), for compact expectations.
 */
async function countsByLabel(
  org: OrganizationId,
  fieldKey?: string,
): Promise<Record<string, number>> {
  const result = ok(await termUsageCounts(db, org, fieldKey === undefined ? {} : { fieldKey }));
  return Object.fromEntries(
    result.counts.map((c) => [c.stored?.term.label ?? c.uri ?? c.termKey, c.records]),
  );
}

/** A promise and the function that settles it, to step two transactions in turn. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until some connection to the test database is waiting for a lock. */
async function someoneWaitsForALock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("No connection waited for a lock.");
}

// ---------------------------------------------------------------------------

describe("term keys", () => {
  it("name a term by vocabulary and URI, or by vocabulary and exact label", () => {
    expect(keyOf(DEPOT)).toBe(keyOf({ ...DEPOT, vocabulary: "local" }));
    expect(keyOf(DEPOT)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(DEPOT)).not.toBe(keyOf({ label: "invented street depot" }));
    // A URI term is its URI: a stale label is still the same term.
    expect(keyOf(LCSH)).toBe(keyOf({ ...LCSH, label: "Railroad" }));
    expect(keyOf(CHAIR)).toBe(keyOf({ ...CHAIR, uri: "http://nomenclature.info/nom/1/" }));
    // The same label without a URI, or in another vocabulary, is another term.
    expect(keyOf(LCSH)).not.toBe(keyOf({ label: "Railroads", vocabulary: "lcsh" }));
    expect(keyOf({ label: "Railroads", vocabulary: "lcsh" })).not.toBe(
      keyOf({ label: "Railroads" }),
    );
  });

  it("are given only for terms core accepts", () => {
    expect(codes(termKey({ label: "Railroads", uri: LCSH.uri }))).toEqual(["vocabulary_missing"]);
    expect(codes(termKey({ label: " padded" }))).toEqual(["invalid_text"]);
  });
});

describe("stored terms", () => {
  it("round-trip through validateControlledTerm, local and authority terms alike", async () => {
    await ready();
    const org = await organization();
    for (const term of [LCSH, CHAIR, DEPOT, WOOD]) {
      const saved = ok(await tx((q) => saveTerm(q, { organizationId: org, term })));
      expect(saved.term).toEqual(ok(validateControlledTerm(term)));
      expect(saved.termKey).toBe(keyOf(term));
      expect(ok(await readTerm(db, org, saved.id))).toEqual(saved);
    }
    const all = ok(await readTerms(db, org));
    expect(all.truncated).toBe(false);
    expect(all.terms.map((s) => s.termKey)).toEqual([LCSH, CHAIR, DEPOT, WOOD].map(keyOf).sort());
    expect(all.terms.every((s) => s.organizationId === org)).toBe(true);
  });

  it("are stored once per organization, also when written two ways", async () => {
    await ready();
    const org = await organization();
    ok(await tx((q) => saveTerm(q, { organizationId: org, term: DEPOT })));
    await tx(async (q) => {
      const again = await saveTerm(q, {
        organizationId: org,
        term: { ...DEPOT, vocabulary: "local" },
      });
      expect(codes(again)).toEqual(["term_exists"]);
      // The refusal left the transaction usable.
      ok(await saveTerm(q, { organizationId: org, term: WOOD }));
    });
    expect(
      codes(
        await tx((q) =>
          saveTerm(q, {
            organizationId: org,
            term: { ...CHAIR, uri: "http://nomenclature.info/nom/1" },
          }),
        ),
      ),
    ).toEqual([]);
    expect(codes(await tx((q) => saveTerm(q, { organizationId: org, term: CHAIR })))).toEqual([
      "term_exists",
    ]);
    expect(ok(await readTerms(db, org)).terms).toHaveLength(3);
  });

  it("can be renamed by ID, never onto another stored term", async () => {
    await ready();
    const org = await organization();
    const depot = ok(await tx((q) => saveTerm(q, { organizationId: org, term: DEPOT })));
    ok(await tx((q) => saveTerm(q, { organizationId: org, term: WOOD })));
    const renamed = ok(
      await tx((q) =>
        saveTerm(q, { organizationId: org, id: depot.id, term: { label: "Invented depot" } }),
      ),
    );
    expect(renamed.id).toBe(depot.id);
    expect(ok(await readTerm(db, org, depot.id)).term).toEqual({ label: "Invented depot" });
    expect(
      codes(await tx((q) => saveTerm(q, { organizationId: org, id: depot.id, term: WOOD }))),
    ).toEqual(["term_exists"]);
    expect(
      codes(
        await tx((q) => saveTerm(q, { organizationId: org, id: crypto.randomUUID(), term: DEPOT })),
      ),
    ).toEqual(["unknown_term"]);
  });

  it("refuses bad input before the database, with clean issues", async () => {
    await ready();
    const org = await organization();
    const save = (input: unknown): Promise<Validated<unknown>> => tx((q) => saveTerm(q, input));
    expect(codes(await save(null))).toEqual(["not_an_object"]);
    expect(codes(await save({ organizationId: "nope", term: DEPOT }))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(await save({ organizationId: org, term: DEPOT, extra: 1 }))).toEqual([
      "unknown_property",
    ]);
    expect(codes(await save({ organizationId: org, id: "1", term: DEPOT }))).toEqual([
      "invalid_id",
    ]);
    const local = await save({ organizationId: org, term: { label: "Depot", uri: LCSH.uri } });
    expect(local.ok ? [] : local.issues.map((i) => i.path)).toEqual([["term", "uri"]]);
    // A getter is never run: the organization reads as missing.
    const sneaky = { term: DEPOT };
    Object.defineProperty(sneaky, "organizationId", { get: () => org, enumerable: true });
    expect(codes(await save(sneaky))).toEqual(["invalid_organization"]);
    expect(codes(await save({ organizationId: newOrganizationId(), term: DEPOT }))).toEqual([
      "unknown_organization",
    ]);
    await expect(saveTerm(db, { organizationId: org, term: DEPOT })).rejects.toThrow(
      /inside a transaction/,
    );
  });

  it("read as issues when a row was changed by hand", async () => {
    await ready();
    const org = await organization();
    const saved = ok(await tx((q) => saveTerm(q, { organizationId: org, term: DEPOT })));
    await db.execute(sql`UPDATE public.terms SET label = 'Changed by hand'
                         WHERE organization_id = ${org}::uuid AND id = ${saved.id}::uuid`);
    expect(codes(await readTerm(db, org, saved.id))).toEqual(["row_mismatch"]);
    const list = await readTerms(db, org);
    expect(list.ok ? [] : list.issues.map((i) => [i.path, i.code])).toEqual([
      [[0], "row_mismatch"],
    ]);
  });

  it("refuse what core refuses with checks, for direct SQL", async () => {
    await ready();
    const org = await organization();
    const key = "a".repeat(64);
    const insert = (vocabulary: string | null, uri: string | null, label: string, k = key): Sql =>
      sql`INSERT INTO public.terms (organization_id, id, vocabulary, uri, label, term_key)
          VALUES (${org}::uuid, ${crypto.randomUUID()}::uuid, ${vocabulary}, ${uri}, ${label}, ${k})`;
    expect(await refusedBy(insert(null, LCSH.uri, "x"))).toEqual({
      code: CHECK,
      constraint: "terms_local_without_uri",
    });
    expect(await refusedBy(insert("local", LCSH.uri, "x"))).toMatchObject({ code: CHECK });
    expect(await refusedBy(insert("mesh", null, "x"))).toMatchObject({ code: CHECK });
    expect(await refusedBy(insert(null, null, "two lines"))).toMatchObject({ code: CHECK });
    expect(await refusedBy(insert(null, null, "x", "short"))).toMatchObject({ code: CHECK });
  });
});

describe("the usage index", () => {
  it("indexes a record's term fields from the stored record and template", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, {
      object_name: CHAIR,
      materials: [WOOD, { label: "Wood" }, { label: "Iron" }],
      subjects: [LCSH, { ...LCSH, label: "Railroad" }, DEPOT, { label: "Bad", vocabulary: "mesh" }],
      title_notes: "not a term field",
    });
    const built = ok(await refresh(org, id));
    expect(built.templateKey).toBe("spectrum-object");
    expect(built.templateVersion).toBe(1);
    expect(built.usages.map((u) => [u.fieldKey, u.term.label])).toEqual([
      ["object_name", "Chair"],
      ["materials", "Wood"],
      ["materials", "Iron"],
      ["subjects", "Railroads"],
      ["subjects", "Invented Street depot"],
    ]);
    expect(built.skipped.map((i) => [i.path, i.code])).toEqual([
      [["fields", "subjects", 3, "vocabulary"], "unknown_vocabulary"],
    ]);
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([]);
  });

  it("counts records per term, stored or not, without counting a record twice", async () => {
    await ready();
    const org = await organization();
    ok(await tx((q) => saveTerm(q, { organizationId: org, term: DEPOT })));
    const unused = ok(
      await tx((q) => saveTerm(q, { organizationId: org, term: { label: "Unused" } })),
    );
    const a = await record(org, { subjects: [LCSH, DEPOT], materials: [DEPOT] });
    const b = await record(org, { subjects: [{ ...LCSH, label: "Railroad" }] });
    const c = await record(org, { object_name: CHAIR });
    for (const id of [a, b, c]) ok(await refresh(org, id));

    const counts = ok(await termUsageCounts(db, org, {}));
    expect(counts.truncated).toBe(false);
    expect(counts.counts.map((x) => x.termKey)).toEqual(
      [LCSH, CHAIR, DEPOT, { label: "Unused" }].map(keyOf).sort(),
    );
    expect(await countsByLabel(org)).toEqual({
      [LCSH.uri]: 2,
      [CHAIR.uri]: 1,
      "Invented Street depot": 1,
      Unused: 0,
    });
    const byKey = new Map(counts.counts.map((c) => [c.termKey, c]));
    expect(byKey.get(keyOf({ label: "Unused" }))?.stored?.id).toBe(unused.id);
    // A term not stored is shown by vocabulary and URI, never a record's label.
    expect(byKey.get(keyOf(LCSH))).toEqual({
      termKey: keyOf(LCSH),
      vocabulary: "lcsh",
      uri: LCSH.uri,
      records: 2,
    });
    expect(await countsByLabel(org, "subjects")).toEqual({
      [LCSH.uri]: 2,
      "Invented Street depot": 1,
    });
    expect(await countsByLabel(org, "materials")).toEqual({ "Invented Street depot": 1 });

    const users = ok(await recordsUsingTerm(db, org, keyOf(DEPOT)));
    expect(users.records).toEqual([{ recordId: a, fieldKeys: ["materials", "subjects"] }]);
    const [low, high] = a < b ? [a, b] : [b, a];
    const first = ok(await recordsUsingTerm(db, org, keyOf(LCSH), { limit: 1 }));
    expect(first).toEqual({
      records: [{ recordId: low, fieldKeys: ["subjects"] }],
      truncated: true,
    });
    const next = ok(await recordsUsingTerm(db, org, keyOf(LCSH), { limit: 1, after: low }));
    expect(next.records.map((r) => r.recordId)).toEqual([high]);
    expect(next.truncated).toBe(false);

    const top = ok(await termUsageCounts(db, org, { limit: 1 }));
    expect(top.counts).toHaveLength(1);
    expect(top.truncated).toBe(true);
  });

  it("follows a record's changes when refreshed, and shows when it wasn't", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [DEPOT] });
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([id]);
    ok(await refresh(org, id));
    expect(await countsByLabel(org)).toEqual({ [keyOf(DEPOT)]: 1 });

    await writeRecordDirectly(
      db,
      sql`
        UPDATE public.records
        SET fields = ${JSON.stringify({ subjects: [LCSH] })}::jsonb, version = version + 1
        WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`,
      org,
      id,
    );
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([id]);
    ok(await refresh(org, id));
    expect(await countsByLabel(org)).toEqual({ [LCSH.uri]: 1 });
    expect(ok(await recordsUsingTerm(db, org, keyOf(DEPOT))).records).toEqual([]);
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([]);

    // A new template version may change which fields hold terms.
    const template = ok(await readTemplate(db, org, "spectrum-object")).template;
    ok(await insertTemplateVersion(db, { ...template, label: "Objects, renamed" }));
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([id]);
    expect(ok(await refresh(org, id)).templateVersion).toBe(2);

    // Saving the record and refreshing in one transaction keeps them together.
    await tx(async (q) => {
      await q.execute(sql`
        UPDATE public.records SET fields = '{}'::jsonb, version = version + 1
        WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`);
      await storeDirectVersion(q, org, id);
      ok(await refreshRecordTerms(q, org, id));
    });
    expect(ok(await termUsageCounts(db, org, {})).counts).toEqual([]);
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([]);
  });

  it("must be cleared before an indexed record is deleted", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [DEPOT, LCSH] });
    ok(await refresh(org, id));
    const where = sql`organization_id = ${org}::uuid AND id = ${id}::uuid`;
    expect(await refusedBy(sql`DELETE FROM public.records WHERE ${where}`)).toMatchObject({
      code: FOREIGN_KEY,
    });
    expect(ok(await tx((q) => clearRecordTerms(q, org, id)))).toBe(2);
    await db.execute(sql`DELETE FROM public.records WHERE ${where}`);
    expect(await countsByLabel(org)).toEqual({});
  });

  it("refuses bad arguments and records it can't read", async () => {
    await ready();
    const org = await organization();
    expect(codes(await refresh(org, crypto.randomUUID() as RecordId))).toEqual(["unknown_record"]);
    expect(codes(await refresh(org, "x" as RecordId))).toEqual(["invalid_id"]);
    expect(codes(await termUsageCounts(db, org, { limit: 0 }))).toEqual(["invalid_limit"]);
    expect(codes(await termUsageCounts(db, org, { fieldKey: "Bad-Key" }))).toEqual([
      "invalid_field_key",
    ]);
    // There is no public option: asking for one is refused, never ignored.
    const publicScope = { scope: "public_fields" } as Parameters<typeof termUsageCounts>[2];
    expect(codes(await termUsageCounts(db, org, publicScope))).toEqual(["unknown_option"]);
    expect(codes(await recordsWithStaleTerms(db, org, { after: "x" as RecordId }))).toEqual([
      "invalid_id",
    ]);
    expect(codes(await termUsageCounts(db, org, { after: "abc" }))).toEqual(["invalid_term_key"]);
    expect(codes(await readTerms(db, org, { after: "abc" }))).toEqual(["invalid_term_key"]);
    expect(codes(await readTerms(db, org, { limit: 10_001 }))).toEqual(["invalid_limit"]);
    expect(codes(await recordsUsingTerm(db, org, "abc"))).toEqual(["invalid_term_key"]);
    expect(
      codes(await recordsUsingTerm(db, org, keyOf(DEPOT), { after: "x" as RecordId })),
    ).toEqual(["invalid_id"]);
    await expect(refreshRecordTerms(db, org, crypto.randomUUID() as RecordId)).rejects.toThrow(
      /inside a transaction/,
    );
  });
});

describe("staff-only counts (nothing typed in a record shown as a term)", () => {
  it("never shows a record's label for a term the organization hasn't stored", async () => {
    await ready();
    const org = await organization();
    // A staff note typed as the label of an LCSH heading.
    const secret = { ...LCSH, label: "AAA secret note about donor" };
    const a = await record(org, { subjects: [LCSH], techniques: [secret] });
    const b = await record(org, { techniques: [{ label: "Secret donor family" }] });
    const built = ok(await refresh(org, a));
    expect(built.usages.map((u) => u.fieldKey)).toEqual(["techniques", "subjects"]);
    ok(await refresh(org, b));

    const staff = ok(await termUsageCounts(db, org, {}));
    expect(JSON.stringify(staff)).not.toMatch(/secret/i);
    expect(staff.counts.find((c) => c.termKey === keyOf(LCSH))).toEqual({
      termKey: keyOf(LCSH),
      vocabulary: "lcsh",
      uri: LCSH.uri,
      records: 1,
    });
    // A local term not stored: its key only, never its label.
    expect(staff.counts.find((c) => c.termKey === keyOf({ label: "Secret donor family" }))).toEqual(
      { termKey: keyOf({ label: "Secret donor family" }), vocabulary: "local", records: 1 },
    );

    // Every field counts: these counts are staff-only.
    expect(await countsByLabel(org, "techniques")).toEqual({
      [LCSH.uri]: 1,
      [keyOf({ label: "Secret donor family" })]: 1,
    });

    // A stored term shows the organization's own label, whatever records hold.
    ok(await tx((q) => saveTerm(q, { organizationId: org, term: LCSH })));
    const named = ok(await termUsageCounts(db, org, {}));
    expect(JSON.stringify(named)).not.toMatch(/secret/i);
    expect(named.counts.find((c) => c.termKey === keyOf(LCSH))?.stored?.term.label).toBe(
      "Railroads",
    );
  });

  it("shows a term's canonical URI, never the URI as a record typed it", async () => {
    await ready();
    const org = await organization();
    // The same term key as CHAIR (dot segments resolve, the scheme is ignored),
    // with a staff note hidden in the path.
    const typed = "http://nomenclature.info/nom/AAA-secret-note/../1";
    const odd = { label: "Chair", vocabulary: "nomenclature", uri: typed };
    expect(ok(validateControlledTerm(odd)).uri).toBe(typed);
    expect(keyOf(odd)).toBe(keyOf(CHAIR));
    expect(canonicalTermUri(typed)).toBe("http://nomenclature.info/nom/1");
    const a = await record(org, { object_name: CHAIR });
    const b = await record(org, { techniques: [odd] });
    for (const id of [a, b]) ok(await refresh(org, id));

    const all = ok(await termUsageCounts(db, org));
    expect(JSON.stringify(all)).not.toMatch(/secret|\.\./i);
    expect(all.counts).toEqual([
      {
        termKey: keyOf(CHAIR),
        vocabulary: "nomenclature",
        uri: "http://nomenclature.info/nom/1",
        records: 2,
      },
    ]);
    // Only the odd spelling counted (one field): still the canonical form.
    const inField = ok(await termUsageCounts(db, org, { fieldKey: "techniques" }));
    expect(JSON.stringify(inField)).not.toMatch(/secret|\.\./i);
    expect(inField.counts.map((c) => [c.uri, c.records])).toEqual([
      ["http://nomenclature.info/nom/1", 1],
    ]);
    // A stored term shows the organization's own URI.
    ok(await tx((q) => saveTerm(q, { organizationId: org, term: CHAIR })));
    const named = ok(await termUsageCounts(db, org));
    expect(JSON.stringify(named)).not.toMatch(/secret/i);
    expect(named.counts.map((c) => [c.stored?.term.uri, c.uri, c.records])).toEqual([
      [CHAIR.uri, undefined, 2],
    ]);
  });

  it("canonical URIs: scheme and host lower case, dot segments resolved, no credentials", () => {
    expect(canonicalTermUri("HTTPS://Nomenclature.INFO/nom/./a/../1/")).toBe(
      "https://nomenclature.info/nom/1",
    );
    expect(canonicalTermUri("https://user:pass@example.org:8443/x?q=1#f")).toBe(
      "https://example.org:8443/x?q=1#f",
    );
    expect(canonicalTermUri("not a url")).toBe("not a url");
  });

  it("reads a usage whose URI doesn't match its key as row_mismatch", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [LCSH] });
    ok(await refresh(org, id));
    // Another LCSH heading's URI, under this heading's key.
    await db.execute(sql`UPDATE public.record_terms
                         SET uri = 'http://id.loc.gov/authorities/subjects/sh85021262'
                         WHERE organization_id = ${org}::uuid`);
    const read = await termUsageCounts(db, org, {});
    expect(read.ok ? [] : read.issues.map((i) => [i.path, i.code])).toEqual([
      [[0], "row_mismatch"],
    ]);
  });
});

describe("paging", () => {
  it("reads counts and stored terms in pages by term key", async () => {
    await ready();
    const org = await organization();
    const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    for (const label of labels.slice(0, 3)) {
      ok(await tx((q) => saveTerm(q, { organizationId: org, term: { label } })));
    }
    const id = await record(org, { subjects: labels.slice(2).map((label) => ({ label })) });
    ok(await refresh(org, id));
    const keys = labels.map((label) => keyOf({ label })).sort();

    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page: TermCounts = ok(
        await termUsageCounts(db, org, {
          limit: 2,
          ...(after === undefined ? {} : { after }),
        }),
      );
      seen.push(...page.counts.map((c) => c.termKey));
      after = page.counts.at(-1)?.termKey;
      if (!page.truncated) break;
    }
    expect(seen).toEqual(keys);

    const stored: string[] = [];
    after = undefined;
    for (;;) {
      const page: StoredTerms = ok(
        await readTerms(db, org, { limit: 1, ...(after === undefined ? {} : { after }) }),
      );
      stored.push(...page.terms.map((t) => t.termKey));
      after = page.terms.at(-1)?.termKey;
      if (!page.truncated) break;
    }
    expect(stored).toEqual(
      labels
        .slice(0, 3)
        .map((label) => keyOf({ label }))
        .sort(),
    );
  });
});

describe("a refused refresh", () => {
  it("removes the record's old usages and leaves it stale", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [DEPOT, LCSH] });
    ok(await refresh(org, id));
    const usages = async (): Promise<unknown[]> =>
      db.rows(sql`SELECT term_key FROM public.record_terms
                  WHERE organization_id = ${org}::uuid AND record_id = ${id}::uuid`);
    expect(await usages()).toHaveLength(2);
    // The record no longer validates (a field key core refuses).
    await writeRecordDirectly(
      db,
      sql`
        UPDATE public.records
        SET fields = ${JSON.stringify({ "Bad Key": [DEPOT] })}::jsonb, version = version + 1
        WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`,
      org,
      id,
    );
    const refused = await refresh(org, id);
    expect(refused.ok).toBe(false);
    expect(codes(refused)).not.toContain("unknown_record");
    expect(await usages()).toEqual([]);
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([id]);
    expect(await countsByLabel(org)).toEqual({});
    expect(ok(await recordsUsingTerm(db, org, keyOf(DEPOT))).records).toEqual([]);
  });
});

describe("stale records", () => {
  it("are listed in pages, so records that stay stale never hide the rest", async () => {
    await ready();
    const org = await organization();
    // Three records whose refresh is always refused (fields core refuses)...
    const broken: RecordId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await record(org, { subjects: [DEPOT] });
      await writeRecordDirectly(
        db,
        sql`
          UPDATE public.records
          SET fields = ${JSON.stringify({ "Bad Key": [DEPOT] })}::jsonb, version = version + 1
          WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`,
        org,
        id,
      );
      expect((await refresh(org, id)).ok).toBe(false);
      broken.push(id);
    }
    // ...and one good stale record, after all of them by ID.
    const highest = [...broken].sort().at(-1) ?? "";
    let good = await record(org, { subjects: [LCSH] });
    while (good < highest) {
      await db.execute(sql`DELETE FROM public.records
                           WHERE organization_id = ${org}::uuid AND id = ${good}::uuid`);
      good = await record(org, { subjects: [LCSH] });
    }

    // A job refreshing everything stale, a page of 3 at a time.
    const seen: RecordId[] = [];
    let after: RecordId | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page: StaleRecords = ok(
        await recordsWithStaleTerms(db, org, {
          limit: 3,
          ...(after === undefined ? {} : { after }),
        }),
      );
      for (const id of page.recordIds) {
        seen.push(id);
        await refresh(org, id);
      }
      after = page.recordIds.at(-1);
      if (!page.truncated) break;
    }
    expect(seen).toContain(good);
    expect(await countsByLabel(org)).toEqual({ [LCSH.uri]: 1 });
    expect(ok(await recordsWithStaleTerms(db, org)).recordIds).toEqual([...broken].sort());
  });
});

describe("concurrent changes", () => {
  it("clearing a record's terms waits for a concurrent save instead of deadlocking", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [DEPOT] });
    ok(await refresh(org, id));
    const where = sql`organization_id = ${org}::uuid AND id = ${id}::uuid`;
    const saved = signal();
    const go = signal();
    // B saves the record (locking it), then refreshes its terms when told.
    const save = tx(async (q) => {
      await q.execute(sql`
        UPDATE public.records
        SET fields = ${JSON.stringify({ subjects: [DEPOT, LCSH] })}::jsonb, version = version + 1
        WHERE ${where}`);
      await storeDirectVersion(q, org, id);
      saved.resolve();
      await go.promise;
      return refreshRecordTerms(q, org, id);
    });
    await saved.promise;
    // A clears the record's terms and deletes it.
    const remove = tx(async (q) => {
      const cleared = await clearRecordTerms(q, org, id);
      await q.execute(sql`DELETE FROM public.records WHERE ${where}`);
      return cleared;
    });
    // A is now waiting for B's lock on the record.
    await someoneWaitsForALock();
    go.resolve();
    const [refreshed, cleared] = await Promise.allSettled([save, remove]);
    expect(refreshed.status).toBe("fulfilled");
    expect(cleared.status).toBe("fulfilled");
    if (refreshed.status === "fulfilled") expect(ok(refreshed.value).usages).toHaveLength(2);
    // A cleared what B had just indexed, then deleted the record.
    if (cleared.status === "fulfilled") expect(ok(cleared.value)).toBe(2);
    expect(await db.rows(sql`SELECT 1 FROM public.records WHERE ${where}`)).toEqual([]);
    expect(await countsByLabel(org)).toEqual({});
  });

  it("refuses with retry when a concurrent change makes the transaction fail", async () => {
    await ready();
    const org = await organization();
    const id = await record(org, { subjects: [DEPOT] });
    ok(await refresh(org, id));
    const where = sql`organization_id = ${org}::uuid AND id = ${id}::uuid`;
    await tx(async (q) => {
      await q.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await q.rows(sql`SELECT 1 FROM public.records WHERE ${where}`);
      // Another connection changes the record after this snapshot.
      await writeRecordDirectly(
        db,
        sql`UPDATE public.records SET fields = '{}'::jsonb, version = version + 1 WHERE ${where}`,
        org,
        id,
      );
      expect(codes(await clearRecordTerms(q, org, id))).toEqual(["retry"]);
      expect(codes(await refreshRecordTerms(q, org, id))).toEqual(["retry"]);
    });
    // Nothing was changed by the refused calls.
    expect(await countsByLabel(org)).toEqual({ [keyOf(DEPOT)]: 1 });
  });
});

describe("labels that differ only invisibly", () => {
  it("are separate terms by design, and Data Cleaning pairs them", () => {
    const composed = { label: "Café" };
    const decomposed = { label: "Café" };
    expect(keyOf(composed)).not.toBe(keyOf(decomposed));
    const report = ok(findNearDuplicateTerms([composed, decomposed]));
    expect(JSON.stringify(report)).toMatch(/same_label/);
  });
});

describe("organization separation", () => {
  it("keeps two organizations' terms and counts apart", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    // Both can store the same term.
    ok(await tx((q) => saveTerm(q, { organizationId: archives, term: DEPOT })));
    const theirs = ok(await tx((q) => saveTerm(q, { organizationId: library, term: DEPOT })));
    const mine = await record(archives, { subjects: [DEPOT] });
    const other = await record(library, { subjects: [DEPOT, LCSH] });
    ok(await refresh(archives, mine));
    ok(await refresh(library, other));

    expect(await countsByLabel(archives)).toEqual({ "Invented Street depot": 1 });
    expect(ok(await recordsUsingTerm(db, archives, keyOf(DEPOT))).records).toEqual([
      { recordId: mine, fieldKeys: ["subjects"] },
    ]);
    expect(ok(await recordsUsingTerm(db, archives, keyOf(LCSH))).records).toEqual([]);
    expect(await readTerm(db, archives, theirs.id)).toBeUndefined();
    expect(ok(await readTerms(db, archives)).terms).toHaveLength(1);
    // Another organization's record isn't found, and its index is untouched.
    expect(codes(await refresh(archives, other))).toEqual(["unknown_record"]);
    expect(ok(await recordsWithStaleTerms(db, archives)).recordIds).toEqual([]);
    expect(
      codes(await tx((q) => saveTerm(q, { organizationId: archives, id: theirs.id, term: WOOD }))),
    ).toEqual(["unknown_term"]);
    expect(ok(await tx((q) => clearRecordTerms(q, archives, other)))).toBe(0);
    expect(await countsByLabel(library)).toEqual({
      "Invented Street depot": 1,
      [LCSH.uri]: 1,
    });
  });

  it("refuses direct SQL that points at another organization's rows", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    const mine = await record(archives, { subjects: [DEPOT] });
    const other = await record(library, { subjects: [DEPOT] });
    ok(await refresh(library, other));
    // A template version only the library has.
    const theirs = ok(await readTemplate(db, library, "spectrum-object")).template;
    ok(await insertTemplateVersion(db, { ...theirs, label: "Library objects" }));
    const key = keyOf(DEPOT);
    const attempts: Sql[] = [
      // An index row of one organization for another's record.
      sql`INSERT INTO public.record_term_index
            (organization_id, record_id, template_key, template_version, fields_digest)
          VALUES (${archives}::uuid, ${other}::uuid, 'spectrum-object', 1, ${"0".repeat(32)})`,
      // An index row built from another organization's template.
      sql`INSERT INTO public.record_term_index
            (organization_id, record_id, template_key, template_version, fields_digest)
          SELECT ${archives}::uuid, ${mine}::uuid, key, version, ${"0".repeat(32)}
          FROM public.template_versions WHERE organization_id = ${library}::uuid AND version = 2`,
      // A usage of one organization on another's indexed record.
      sql`INSERT INTO public.record_terms
            (organization_id, record_id, field_key, term_key, label)
          VALUES (${archives}::uuid, ${other}::uuid, 'subjects', ${key}, 'x')`,
      // A stored term of an organization that doesn't exist.
      sql`INSERT INTO public.terms (organization_id, id, label, term_key)
          VALUES (${newOrganizationId()}::uuid, ${crypto.randomUUID()}::uuid, 'x', ${key})`,
    ];
    for (const query of attempts) {
      expect(await refusedBy(query)).toMatchObject({ code: FOREIGN_KEY });
    }
    expect(await countsByLabel(archives)).toEqual({});
  });

  it("never lets an update move a row or change what identifies it", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    const saved = ok(await tx((q) => saveTerm(q, { organizationId: archives, term: DEPOT })));
    const id = await record(archives, { subjects: [DEPOT] });
    const other = await record(archives, {});
    ok(await refresh(archives, id));
    ok(await refresh(archives, other));
    const mine = sql`organization_id = ${archives}::uuid`;
    const attempts: [Sql, string][] = [
      [
        sql`UPDATE public.terms SET organization_id = ${library}::uuid WHERE ${mine}`,
        "terms_organization_id_fixed",
      ],
      [
        sql`UPDATE public.terms SET id = ${crypto.randomUUID()}::uuid WHERE ${mine} AND id = ${saved.id}::uuid`,
        "terms_id_fixed",
      ],
      [
        sql`UPDATE public.record_term_index SET organization_id = ${library}::uuid
            WHERE ${mine} AND record_id = ${id}::uuid`,
        "record_term_index_organization_id_fixed",
      ],
      [
        sql`UPDATE public.record_term_index SET record_id = ${crypto.randomUUID()}::uuid
            WHERE ${mine} AND record_id = ${other}::uuid`,
        "record_term_index_record_id_fixed",
      ],
      [
        sql`UPDATE public.record_terms SET organization_id = ${library}::uuid WHERE ${mine}`,
        "record_terms_organization_id_fixed",
      ],
      [
        sql`UPDATE public.record_terms SET record_id = ${other}::uuid WHERE ${mine}`,
        "record_terms_record_id_fixed",
      ],
      [
        sql`UPDATE public.record_terms SET field_key = 'materials' WHERE ${mine}`,
        "record_terms_field_key_fixed",
      ],
      [
        sql`UPDATE public.record_terms SET term_key = ${"b".repeat(64)} WHERE ${mine}`,
        "record_terms_term_key_fixed",
      ],
    ];
    for (const [query, constraint] of attempts) {
      expect(await refusedBy(query)).toEqual({ code: IDENTITY, constraint });
    }
    expect(await countsByLabel(archives)).toEqual({ "Invented Street depot": 1 });
  });
});
