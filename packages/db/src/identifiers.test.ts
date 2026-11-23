// The identifier tables (0003_identifiers.sql) and their data-access module,
// on a freshly migrated database: types and identifiers round-trip through
// core's validators; the unique indexes enforce each type's rule within one
// organization only, also when two saves race; auto-numbering never gives a
// number out twice; and direct SQL can't move rows, forge a rule or point
// across organizations (D-019, D-061).
import { afterAll, describe, expect, it } from "vitest";
import {
  STANDARD_PRESETS,
  createRecord,
  identifierKey,
  newOrganizationId,
  templateFromPreset,
  type IdentifierType,
  type OrganizationId,
  type RecordId,
  type RecordIdentifiers,
  type Validated,
} from "@oculus/core";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { insertOrganization, insertRecord, insertTemplateVersion } from "./catalog.js";
import {
  allocateIdentifier,
  insertIdentifierType,
  readIdentifierTypes,
  readRecordIdentifiers,
  saveRecordIdentifiers,
  updateIdentifierType,
} from "./identifiers.js";
import { migrate } from "./migrate.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, set up lazily inside each test.

const T = "2026-11-20T16:05:00.000Z";
let setup: Promise<{ testDb: TestDatabase; db: Database }> | undefined;
let db: Database;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    return { testDb, db: openDatabase(testDb.url, { max: 12 }) };
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

/** Runs `work` in its own transaction. */
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
const UNIQUE = "23505";
const IDENTITY = "23000";

// ---------------------------------------------------------------------------
// Invented sample data.

/** A new organization with the spectrum-object template and its usual types. */
async function organization(name = "Invented Historical Society"): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(db, { id: org, name }));
  const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
  ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org))));
  for (const type of sampleTypes(org)) ok(await tx((q) => insertIdentifierType(q, type)));
  return org;
}

function sampleTypes(org: OrganizationId): IdentifierType[] {
  return [
    {
      organizationId: org,
      key: "accession_number",
      label: "Accession number",
      pattern: "####.###",
      uniqueness: "all_time",
      autoNumber: { style: "year", separator: ".", digits: 3 },
      public: true,
    },
    {
      organizationId: org,
      key: "object_number",
      label: "Object number",
      uniqueness: "current",
      autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 },
      public: true,
    },
    { organizationId: org, key: "box_label", label: "Box label", uniqueness: "none" },
  ];
}

async function record(org: OrganizationId, title = "An invented chair"): Promise<RecordId> {
  const made = ok(
    createRecord(
      {
        organizationId: org,
        kind: "object",
        title,
        templateKey: "spectrum-object",
      },
      new Date(T),
    ),
  );
  ok(await insertRecord(db, made));
  return made.id;
}

function numbers(
  org: OrganizationId,
  recordId: RecordId,
  current: [string, string][],
  former: { type: string; value: string; retiredAt?: string; note?: string }[] = [],
): RecordIdentifiers {
  return {
    recordId,
    organizationId: org,
    current: current.map(([type, value], i) => ({ type, value, primary: i === 0 })),
    former,
  };
}

const save = (set: unknown): Promise<Validated<RecordIdentifiers>> =>
  tx((q) => saveRecordIdentifiers(q, set));

/** Waits until some session of the test database is waiting on a lock. */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nothing started waiting.");
}

// ---------------------------------------------------------------------------

describe("identifier types", () => {
  it("round-trip through core, ordered by key, one organization's only", async () => {
    await ready();
    const org = await organization();
    const other = await organization("Invented Public Library");
    const types = ok(await readIdentifierTypes(db, org));
    expect(types).toEqual([...sampleTypes(org)].sort((a, b) => (a.key < b.key ? -1 : 1)));
    expect(types.every((t) => t.organizationId === org)).toBe(true);
    expect(ok(await readIdentifierTypes(db, other)).every((t) => t.organizationId === other)).toBe(
      true,
    );
    expect(ok(await readIdentifierTypes(db, newOrganizationId()))).toEqual([]);
    expect(codes(await readIdentifierTypes(db, "nope" as OrganizationId))).toEqual([
      "invalid_organization",
    ]);
  });

  it("refuses an invalid or reserved type, a taken key and an unknown organization", async () => {
    await ready();
    const org = await organization();
    const [first] = sampleTypes(org);
    expect(codes(await tx((q) => insertIdentifierType(q, { ...first, key: "Bad-Key" })))).toEqual([
      "invalid_key",
    ]);
    expect(
      codes(await tx((q) => insertIdentifierType(q, { ...first, key: "constructor" }))),
    ).toEqual(["reserved_key"]);
    expect(codes(await tx((q) => insertIdentifierType(q, first)))).toEqual(["key_taken"]);
    expect(
      codes(
        await tx((q) => insertIdentifierType(q, { ...first, organizationId: newOrganizationId() })),
      ),
    ).toEqual(["unknown_organization"]);
  });

  it("an organization holds at most MAX_IDENTIFIER_TYPES types", async () => {
    await ready();
    const org = await organization();
    await tx(async (q) => {
      for (let i = 0; i < 97; i++) {
        ok(
          await insertIdentifierType(q, {
            organizationId: org,
            key: `extra_${String(i)}`,
            label: `Extra ${String(i)}`,
            uniqueness: "none",
          }),
        );
      }
    });
    expect(
      codes(
        await tx((q) =>
          insertIdentifierType(q, {
            organizationId: org,
            key: "one_too_many",
            label: "One too many",
            uniqueness: "none",
          }),
        ),
      ),
    ).toEqual(["too_many"]);
    expect(ok(await readIdentifierTypes(db, org))).toHaveLength(100);
  });

  it("an edit round-trips; an unknown key is refused", async () => {
    await ready();
    const org = await organization();
    const [, objectNumber] = sampleTypes(org);
    const edited = { ...objectNumber, label: "Object no." };
    ok(await tx((q) => updateIdentifierType(q, edited)));
    expect(ok(await readIdentifierTypes(db, org)).find((t) => t.key === "object_number")).toEqual(
      edited,
    );
    expect(codes(await tx((q) => updateIdentifierType(q, { ...edited, key: "missing" })))).toEqual([
      "unknown_type",
    ]);
  });

  it("tightening a rule over clashing values is refused by the database; loosening and clean tightening work", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [["box_label", "Box 1"]])));
    ok(await save(numbers(org, b, [["box_label", "box 1"]])));
    const box = sampleTypes(org)[2];
    expect(
      codes(await tx((q) => updateIdentifierType(q, { ...box, uniqueness: "current" }))),
    ).toEqual(["uniqueness_clash"]);
    expect(ok(await readIdentifierTypes(db, org)).find((t) => t.key === "box_label")).toEqual(box);
    // Once one record lets go of it as current, `current` fits but `all_time` doesn't.
    ok(
      await save(
        numbers(org, b, [["box_label", "Box 2"]], [{ type: "box_label", value: "box 1" }]),
      ),
    );
    expect(
      codes(await tx((q) => updateIdentifierType(q, { ...box, uniqueness: "all_time" }))),
    ).toEqual(["uniqueness_clash"]);
    ok(await tx((q) => updateIdentifierType(q, { ...box, uniqueness: "current" })));
    // The cascaded rule is enforced from now on.
    const c = await record(org);
    expect(codes(await save(numbers(org, c, [["box_label", "BOX 2"]])))).toEqual(["not_unique"]);
  });
});

describe("a record's identifiers", () => {
  it("round-trip through core: order, primary, former history, two spellings, a reinstated number", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    const set: RecordIdentifiers = {
      recordId: id,
      organizationId: org,
      current: [
        { type: "box_label", value: "Box 7", primary: false },
        { type: "object_number", value: "DHS-0001", primary: true },
        { type: "accession_number", value: "2026.001", primary: false },
      ],
      former: [
        { type: "object_number", value: "DHS-0001", retiredAt: T, note: "Reinstated later." },
        { type: "object_number", value: "dhs 0001" },
        { type: "omeka_id", value: "omeka 812", note: "From the old site;\nimported." },
        { type: "accession_number", value: "1998.12", retiredAt: "2026-11-21T09:30:00.250Z" },
      ],
    };
    expect(ok(await save(set))).toEqual(set);
    expect(ok(await readRecordIdentifiers(db, org, id))).toEqual(set);
    // Each value's comparison key is stored beside it.
    const keys = await db.rows<{ value: string; key: string }>(sql`
      SELECT value, key FROM public.former_identifiers
      WHERE organization_id = ${org}::uuid AND record_id = ${id}::uuid ORDER BY position`);
    expect(keys.map((k) => k.key)).toEqual(set.former.map((f) => identifierKey(f.value)));
    // A save replaces what was there.
    const fewer = numbers(org, id, [["object_number", "DHS-0002"]]);
    expect(ok(await save(fewer))).toEqual(fewer);
    expect(ok(await readRecordIdentifiers(db, org, id))).toEqual(fewer);
  });

  it("a record with none reads as empty lists; another organization's record reads as nothing", async () => {
    await ready();
    const org = await organization();
    const other = await organization("Invented Public Library");
    const id = await record(org);
    expect(ok(await readRecordIdentifiers(db, org, id))).toEqual(numbers(org, id, []));
    expect(await readRecordIdentifiers(db, other, id)).toBeUndefined();
    expect(codes(await readRecordIdentifiers(db, org, "x" as RecordId))).toEqual(["invalid_id"]);
  });

  it("core refuses bad sets before the database; an unknown record is refused", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    expect(codes(await save(numbers(org, id, [["accession_number", "26.1"]])))).toEqual([
      "format_mismatch",
    ]);
    expect(codes(await save(numbers(org, id, [["shelf_mark", "A1"]])))).toEqual(["unknown_type"]);
    expect(codes(await save({ ...numbers(org, id, []), organizationId: "x" }))).toContain(
      "invalid_organization",
    );
    const stranger = await organization("Invented Public Library");
    // The record exists, but in another organization.
    expect(codes(await save(numbers(stranger, id, [["object_number", "DHS-0001"]])))).toEqual([
      "unknown_record",
    ]);
  });

  it("must run inside a transaction", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    await expect(saveRecordIdentifiers(db, numbers(org, id, []))).rejects.toThrow(
      /inside a transaction/,
    );
    await expect(allocateIdentifier(db, org, "object_number")).rejects.toThrow(
      /inside a transaction/,
    );
  });

  it("a stored value changed by hand reads as issues (key_outdated)", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    ok(await save(numbers(org, id, [["object_number", "DHS-0001"]])));
    await db.execute(sql`
      UPDATE public.record_identifiers SET value = 'DHS-0099'
      WHERE organization_id = ${org}::uuid AND record_id = ${id}::uuid`);
    expect(codes(await readRecordIdentifiers(db, org, id))).toEqual(["key_outdated"]);
  });
});

describe("uniqueness rules, enforced by the database", () => {
  it("current: no two records hold a number as current; a former one is free", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(
      await save(
        numbers(
          org,
          a,
          [["object_number", "DHS-0001"]],
          [{ type: "object_number", value: "DHS-0000" }],
        ),
      ),
    );
    ok(await save(numbers(org, b, [["object_number", "DHS-0002"]])));
    // A lookalike spelling is the same number.
    const result = await save(numbers(org, b, [["object_number", "dhs‑0001"]]));
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: ["current", 0, "value"],
          code: "not_unique",
          message: 'Object number "dhs‑0001" is already used by another record.',
        },
      ],
    });
    // Nothing changed: b keeps its number.
    expect(ok(await readRecordIdentifiers(db, org, b))).toEqual(
      numbers(org, b, [["object_number", "DHS-0002"]]),
    );
    // a's former number is free under `current`.
    ok(await save(numbers(org, b, [["object_number", "DHS-0000"]])));
  });

  it("all_time: a number once held by a record, even as former, is never another's", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(
      await save(
        numbers(
          org,
          a,
          [["accession_number", "2026.002"]],
          [{ type: "accession_number", value: "2026.001" }],
        ),
      ),
    );
    expect(codes(await save(numbers(org, b, [["accession_number", "2026.001"]])))).toEqual([
      "not_unique",
    ]);
    expect(
      codes(
        await save(
          numbers(
            org,
            b,
            [["box_label", "Box 1"]],
            [{ type: "accession_number", value: "2026.002" }],
          ),
        ),
      ),
    ).toEqual(["not_unique"]);
    // The same record may hold it as current and former (reinstated).
    ok(
      await save(
        numbers(
          org,
          a,
          [["accession_number", "2026.001"]],
          [
            { type: "accession_number", value: "2026.001" },
            { type: "accession_number", value: "2026.002" },
          ],
        ),
      ),
    );
  });

  it("none: any number of records may share a value", async () => {
    await ready();
    const org = await organization();
    for (let i = 0; i < 3; i++) {
      ok(await save(numbers(org, await record(org), [["box_label", "Box 1"]])));
    }
  });

  it("a refusal leaves the caller's transaction usable and the other writes in it", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [["object_number", "DHS-0001"]])));
    const outcome = await tx(async (q) => {
      ok(await saveRecordIdentifiers(q, numbers(org, b, [["object_number", "DHS-0003"]])));
      const refusal = await saveRecordIdentifiers(
        q,
        numbers(org, b, [["object_number", "DHS-0001"]]),
      );
      const [row] = await q.rows<{ one: number }>(sql`SELECT 1 AS one`);
      return { refusal, row };
    });
    expect(codes(outcome.refusal)).toEqual(["not_unique"]);
    expect(outcome.row).toEqual({ one: 1 });
    expect(ok(await readRecordIdentifiers(db, org, b))).toEqual(
      numbers(org, b, [["object_number", "DHS-0003"]]),
    );
  });

  it("two organizations can hold the same number under every rule", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    const current: [string, string][] = [
      ["accession_number", "2026.001"],
      ["object_number", "DHS-0001"],
      ["box_label", "Box 1"],
    ];
    const mine = numbers(archives, await record(archives), current);
    const theirs = numbers(library, await record(library), current);
    ok(await save(mine));
    ok(await save(theirs));
    expect(ok(await readRecordIdentifiers(db, archives, mine.recordId))).toEqual(mine);
    expect(ok(await readRecordIdentifiers(db, library, theirs.recordId))).toEqual(theirs);
  });

  it("two saves of one number at the same moment: one wins, the other is refused cleanly", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let savedA = (): void => undefined;
    const aSaved = new Promise<void>((resolve) => {
      savedA = resolve;
    });
    const first = tx(async (q) => {
      const result = await saveRecordIdentifiers(
        q,
        numbers(org, a, [["object_number", "DHS-0007"]]),
      );
      savedA();
      await held;
      return result;
    });
    await aSaved;
    // b's save starts while a's is uncommitted, and waits on the unique index.
    const second = tx(async (q) => {
      const result = await saveRecordIdentifiers(
        q,
        numbers(org, b, [["object_number", "dhs-0007"]]),
      );
      const [row] = await q.rows<{ one: number }>(sql`SELECT 1 AS one`);
      return { result, row };
    });
    await someoneWaits();
    release();
    ok(await first);
    const { result, row } = await second;
    expect(codes(result)).toEqual(["not_unique"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["current", 0, "value"]);
    expect(row).toEqual({ one: 1 });
    expect(ok(await readRecordIdentifiers(db, org, b))).toEqual(numbers(org, b, []));

    // And unorchestrated, many at once: exactly one wins.
    const racers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => record(org)));
    const results = await Promise.all(
      racers.map((id) => save(numbers(org, id, [["accession_number", "2026.050"]]))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => codes(r))).toEqual(
      Array.from({ length: 5 }, () => ["not_unique"]),
    );
  });
});

describe("auto-numbering", () => {
  it("follows core's nextIdentifier: highest held, current or former, plus one", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    ok(
      await save(
        numbers(
          org,
          id,
          [["object_number", "DHS-0040"]],
          [{ type: "object_number", value: "dhs-41" }],
        ),
      ),
    );
    expect(ok(await tx((q) => allocateIdentifier(q, org, "object_number")))).toBe("DHS-0042");
    // Year-based numbering restarts each year.
    expect(
      ok(await tx((q) => allocateIdentifier(q, org, "accession_number", { year: 2026 }))),
    ).toBe("2026.001");
    expect(
      ok(await tx((q) => allocateIdentifier(q, org, "accession_number", { year: 2027 }))),
    ).toBe("2027.001");
    expect(codes(await tx((q) => allocateIdentifier(q, org, "accession_number")))).toEqual([
      "year_required",
    ]);
    expect(codes(await tx((q) => allocateIdentifier(q, org, "box_label")))).toEqual([
      "no_auto_number",
    ]);
    expect(codes(await tx((q) => allocateIdentifier(q, org, "shelf_mark")))).toEqual([
      "unknown_type",
    ]);
    expect(codes(await tx((q) => allocateIdentifier(q, org, "Bad")))).toEqual(["invalid_type"]);
  });

  it("a number given out is never given out again, even if its save never came", async () => {
    await ready();
    const org = await organization();
    expect(ok(await tx((q) => allocateIdentifier(q, org, "object_number")))).toBe("DHS-0001");
    expect(ok(await tx((q) => allocateIdentifier(q, org, "object_number")))).toBe("DHS-0002");
    // Rolled back with its transaction: then it was never given out.
    await expect(
      tx(async (q) => {
        ok(await allocateIdentifier(q, org, "object_number"));
        throw new Error("save failed");
      }),
    ).rejects.toThrow("save failed");
    expect(ok(await tx((q) => allocateIdentifier(q, org, "object_number")))).toBe("DHS-0003");
  });

  it("concurrent allocations never give out the same number, whatever the type's rule", async () => {
    await ready();
    const org = await organization();
    // A type with no uniqueness rule: only the counter's lock keeps numbers apart.
    ok(
      await tx((q) =>
        insertIdentifierType(q, {
          organizationId: org,
          key: "loan_number",
          label: "Loan number",
          uniqueness: "none",
          autoNumber: { style: "prefix", prefix: "L-", digits: 3 },
        }),
      ),
    );
    const ids = await Promise.all(Array.from({ length: 10 }, () => record(org)));
    const given = await Promise.all(
      ids.map((id) =>
        tx(async (q) => {
          const loan = ok(await allocateIdentifier(q, org, "loan_number"));
          const accession = ok(
            await allocateIdentifier(q, org, "accession_number", { year: 2026 }),
          );
          ok(
            await saveRecordIdentifiers(
              q,
              numbers(org, id, [
                ["loan_number", loan],
                ["accession_number", accession],
              ]),
            ),
          );
          return [loan, accession];
        }),
      ),
    );
    const loans = given.map(([loan]) => loan);
    const accessions = given.map(([, accession]) => accession);
    expect(new Set(loans).size).toBe(10);
    expect(new Set(accessions).size).toBe(10);
    expect([...loans].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `L-${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("another organization's numbers are never counted", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    ok(await save(numbers(archives, await record(archives), [["object_number", "DHS-0500"]])));
    expect(ok(await tx((q) => allocateIdentifier(q, library, "object_number")))).toBe("DHS-0001");
  });
});

describe("organizations stay separate, even through direct SQL", () => {
  it("no holding, identifier or counter can point at another organization's record, holding or type", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    const theirRecord = await record(library);
    const myRecord = await record(archives);
    ok(await save(numbers(library, theirRecord, [["object_number", "DHS-0001"]])));
    // A holding of the archives naming the library's record.
    expect(
      await refusedBy(sql`
        INSERT INTO public.identifier_holdings (organization_id, record_id, type_key, key, current)
        VALUES (${archives}::uuid, ${theirRecord}::uuid, 'object_number', 'dhs-0001', true)`),
    ).toMatchObject({ code: FOREIGN_KEY });
    // An archives identifier row pointing at the library's holding.
    expect(
      await refusedBy(sql`
        INSERT INTO public.record_identifiers
          (organization_id, record_id, position, type_key, value, key, is_primary)
        VALUES (${archives}::uuid, ${theirRecord}::uuid, 0, 'object_number', 'DHS-0001',
                'dhs-0001', true)`),
    ).toMatchObject({ code: FOREIGN_KEY });
    // A current number of a type only the library has.
    ok(
      await tx((q) =>
        insertIdentifierType(q, {
          organizationId: library,
          key: "call_number",
          label: "Call number",
          uniqueness: "current",
        }),
      ),
    );
    expect(
      await refusedBy(sql`
        INSERT INTO public.identifier_holdings (organization_id, record_id, type_key, key, current)
        VALUES (${archives}::uuid, ${myRecord}::uuid, 'call_number', 'x1', true)`),
    ).toEqual({ code: CHECK, constraint: "identifier_holdings_current_has_type" });
    // A counter for a type only the library has.
    expect(
      await refusedBy(sql`
        INSERT INTO public.identifier_counters (organization_id, type_key, series)
        VALUES (${archives}::uuid, 'call_number', '')`),
    ).toMatchObject({ code: FOREIGN_KEY });
  });

  it("a holding's rule is always its type's: a writer can't forge one to dodge the indexes", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [["accession_number", "2026.001"]])));
    // Inserted as a former holding with no rule, it still takes all_time.
    expect(
      await refusedBy(sql`
        INSERT INTO public.identifier_holdings
          (organization_id, record_id, type_key, key, uniqueness, current)
        VALUES (${org}::uuid, ${b}::uuid, 'accession_number', '2026.001', NULL, false)`),
    ).toEqual({ code: UNIQUE, constraint: "identifier_holdings_all_time_unique" });
    expect(
      await refusedBy(sql`
        INSERT INTO public.identifier_holdings
          (organization_id, record_id, type_key, key, uniqueness, current)
        VALUES (${org}::uuid, ${b}::uuid, 'accession_number', '2026.001', 'none', true)`),
    ).toEqual({ code: UNIQUE, constraint: "identifier_holdings_all_time_unique" });
    // Nor can an update set it to something else.
    await db.execute(sql`
      UPDATE public.identifier_holdings SET uniqueness = 'none'
      WHERE organization_id = ${org}::uuid AND record_id = ${a}::uuid`);
    const [row] = await db.rows<{ uniqueness: string }>(sql`
      SELECT uniqueness FROM public.identifier_holdings
      WHERE organization_id = ${org}::uuid AND record_id = ${a}::uuid`);
    expect(row?.uniqueness).toBe("all_time");
  });

  it("former numbers of a type created later count under its rule; a clash refuses the type", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [], [{ type: "omeka_id", value: "812" }])));
    ok(await save(numbers(org, b, [], [{ type: "omeka_id", value: "812" }])));
    const omeka: IdentifierType = {
      organizationId: org,
      key: "omeka_id",
      label: "Omeka ID",
      uniqueness: "all_time",
    };
    expect(codes(await tx((q) => insertIdentifierType(q, omeka)))).toEqual([
      "adopted_values_clash",
    ]);
    ok(await save(numbers(org, b, [])));
    ok(await tx((q) => insertIdentifierType(q, omeka)));
    expect(codes(await save(numbers(org, b, [], [{ type: "omeka_id", value: "812" }])))).toEqual([
      "not_unique",
    ]);
  });

  it("what identifies a row never changes: organization, record, type, key, position, series", async () => {
    await ready();
    const archives = await organization();
    const library = await organization("Invented Public Library");
    const id = await record(archives);
    const other = await record(archives);
    ok(
      await save(
        numbers(archives, id, [["object_number", "DHS-0001"]], [{ type: "box_label", value: "B" }]),
      ),
    );
    ok(await tx((q) => allocateIdentifier(q, archives, "object_number")));
    const mine = sql`organization_id = ${archives}::uuid`;
    const attempts: [Sql, string][] = [
      [
        sql`UPDATE public.identifier_types SET organization_id = ${library}::uuid,
              definition = jsonb_set(definition, '{organizationId}', to_jsonb(${library}::text))
            WHERE ${mine} AND key = 'box_label'`,
        "identifier_types_organization_id_fixed",
      ],
      [
        sql`UPDATE public.identifier_types SET key = 'renamed',
              definition = jsonb_set(definition, '{key}', '"renamed"')
            WHERE ${mine} AND key = 'box_label'`,
        "identifier_types_key_fixed",
      ],
      [
        sql`UPDATE public.identifier_holdings SET record_id = ${other}::uuid
            WHERE ${mine} AND record_id = ${id}::uuid AND type_key = 'box_label'`,
        "identifier_holdings_record_id_fixed",
      ],
      [
        sql`UPDATE public.identifier_holdings SET key = 'c'
            WHERE ${mine} AND record_id = ${id}::uuid AND type_key = 'box_label'`,
        "identifier_holdings_key_fixed",
      ],
      [
        sql`UPDATE public.record_identifiers SET position = 3 WHERE ${mine} AND record_id = ${id}::uuid`,
        "record_identifiers_position_fixed",
      ],
      [
        sql`UPDATE public.former_identifiers SET organization_id = ${library}::uuid
            WHERE ${mine} AND record_id = ${id}::uuid`,
        "former_identifiers_organization_id_fixed",
      ],
      [
        sql`UPDATE public.identifier_counters SET series = '2026' WHERE ${mine}`,
        "identifier_counters_series_fixed",
      ],
      [
        sql`UPDATE public.identifier_counters SET organization_id = ${library}::uuid WHERE ${mine}`,
        "identifier_counters_organization_id_fixed",
      ],
    ];
    for (const [query, constraint] of attempts) {
      expect(await refusedBy(query)).toEqual({ code: IDENTITY, constraint });
    }
    expect(ok(await readRecordIdentifiers(db, archives, id)).current).toHaveLength(1);
  });

  it("a type, record or holding in use can't be deleted", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    ok(await save(numbers(org, id, [["object_number", "DHS-0001"]])));
    expect(
      await refusedBy(
        sql`DELETE FROM public.identifier_types WHERE organization_id = ${org}::uuid AND key = 'object_number'`,
      ),
    ).toMatchObject({ code: FOREIGN_KEY });
    expect(
      await refusedBy(
        sql`DELETE FROM public.records WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`,
      ),
    ).toMatchObject({ code: FOREIGN_KEY });
    expect(
      await refusedBy(
        sql`DELETE FROM public.identifier_holdings WHERE organization_id = ${org}::uuid AND record_id = ${id}::uuid`,
      ),
    ).toMatchObject({ code: FOREIGN_KEY });
  });
});
