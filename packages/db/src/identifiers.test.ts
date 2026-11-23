// The identifier tables (0003_identifiers.sql) and their data-access module,
// on a freshly migrated database: types and identifiers round-trip through
// core's validators; the unique indexes enforce each type's rule within one
// organization only, also when two saves race; auto-numbering never gives a
// number out twice; and direct SQL can't move rows, forge a rule or point
// across organizations (D-019, D-061).
import { afterAll, describe, expect, it, vi } from "vitest";
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
import { openDatabase, openSession, type Database, type Queryable } from "./client.js";
import { insertOrganization, insertRecord, insertTemplateVersion } from "./catalog.js";
import {
  allocateIdentifier,
  allocateIdentifiers,
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

// The races below poll for a session waiting on a lock, and give up after
// POLL_LIMIT_MS with a clear error: well before the test itself times out,
// so a slow machine sees why, not a bare timeout.
const POLL_LIMIT_MS = 5_000;
vi.setConfig({ testTimeout: 30_000 });

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
  ok(await db.transaction((tx) => insertRecord(tx, made, { actor: "system:test" })));
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

/** Waits until `count` sessions of the test database are waiting on a lock. */
async function someoneWaits(count = 1): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Fewer than ${String(count)} sessions started waiting on a lock within ${String(POLL_LIMIT_MS)} ms.`,
  );
}

/**
 * Resolves when `work` has settled or some session waits on a lock, whichever
 * comes first: to orchestrate a race that must work with or without waiting.
 */
async function settledOrWaiting(work: Promise<unknown>): Promise<void> {
  const state = { done: false };
  const settled = work.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline && !state.done) {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) > 0) return;
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 10))]);
  }
  if (!state.done) {
    throw new Error(
      `The work neither settled nor waited on a lock within ${String(POLL_LIMIT_MS)} ms.`,
    );
  }
}

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Runs `work` in a transaction that stays open until `until` resolves. */
function heldOpen<T>(
  work: (q: Queryable) => Promise<T>,
  until: Promise<void>,
): { done: Promise<T>; ran: Promise<T> } {
  let ran!: (value: T) => void;
  let failed!: (error: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    ran = resolve;
    failed = reject;
  });
  const done = tx(async (q) => {
    try {
      const value = await work(q);
      ran(value);
      await until;
      return value;
    } catch (error) {
      failed(error);
      throw error;
    }
  });
  return { done, ran: result };
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

describe("reading a record's identifiers after its types changed", () => {
  it("a value stranded by an allowed format change is read, with an issue beside it (D-031)", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    const set = numbers(
      org,
      id,
      [
        ["object_number", "DHS-0001"],
        ["box_label", "Box 1"],
      ],
      [{ type: "object_number", value: "old 7" }],
    );
    ok(await save(set));
    const box = sampleTypes(org)[2];
    ok(await tx((q) => updateIdentifierType(q, { ...box, pattern: "B-###" })));
    const read = await readRecordIdentifiers(db, org, id);
    expect(read).toEqual({
      ok: true,
      value: set,
      issues: [expect.objectContaining({ path: ["current", 1, "value"], code: "format_mismatch" })],
    });
    // A save of the same set is still refused: new values must fit.
    expect(codes(await save(set))).toEqual(["format_mismatch"]);
  });

  it("current and former identifiers are read from one moment", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    const before = numbers(org, id, [["object_number", "DHS-0001"]]);
    const after = numbers(
      org,
      id,
      [["object_number", "DHS-0002"]],
      [{ type: "object_number", value: "DHS-0001" }],
    );
    ok(await save(before));
    // Right after the reader reads the current identifiers, another session
    // renumbers the record.
    let first = true;
    const interrupted: Queryable = {
      async rows(query) {
        const rows = await db.rows(query);
        if (first && query.text.includes("record_identifiers")) {
          first = false;
          ok(await save(after));
        }
        return rows as never;
      },
      execute: (query) => db.execute(query),
    };
    const read = ok(await readRecordIdentifiers(interrupted, org, id));
    expect([before, after]).toContainEqual(read);
  });
});

describe("savepoints", () => {
  it("when rolling back to the savepoint fails too, the first error is kept as the cause", async () => {
    const original = new Error("the work failed");
    const broken: Queryable = {
      rows: () => Promise.reject(original),
      execute: (query) =>
        query.text.startsWith("ROLLBACK")
          ? Promise.reject(new Error("the rollback failed"))
          : Promise.resolve(0),
    };
    const thrown = await allocateIdentifier(broken, newOrganizationId(), "object_number").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(original);
  });

  it("a full lock table (53200, out of shared memory) is a clean retry, never the raw error", async () => {
    const full: Queryable = {
      rows: <R extends object>() =>
        Promise.resolve([{ level: "read committed" }] as unknown as R[]),
      execute: (query) =>
        query.text.includes("UPDATE public.identifier_types")
          ? Promise.reject(Object.assign(new Error("out of shared memory"), { code: "53200" }))
          : Promise.resolve(0),
    };
    const [, , boxLabel] = sampleTypes(newOrganizationId());
    expect(codes(await updateIdentifierType(full, boxLabel))).toEqual(["retry"]);
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

describe("races between saves, type changes and allocations", () => {
  const omeka = (org: OrganizationId): IdentifierType => ({
    organizationId: org,
    key: "omeka_id",
    label: "Omeka ID",
    uniqueness: "all_time",
  });

  /** Holdings of the type left with no rule although the type exists. */
  async function ruleless(org: OrganizationId, typeKey: string): Promise<number> {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.identifier_holdings h
      WHERE h.organization_id = ${org}::uuid AND h.type_key = ${typeKey}
        AND h.uniqueness IS NULL
        AND EXISTS (SELECT 1 FROM public.identifier_types t
                    WHERE t.organization_id = h.organization_id AND t.key = h.type_key)`);
    return row?.n ?? 0;
  }

  /**
   * Runs the writes `start` makes with every holding write of `org` held at a
   * test-only trigger until all of them wait there, then lets them all go at
   * once: each has done everything before its first holding write.
   */
  async function paused<T>(org: OrganizationId, start: () => Promise<T>[]): Promise<T[]> {
    const PAUSE = 715026;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS public.test_paused (organization_id uuid PRIMARY KEY)`);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION public.test_pause_holdings() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.test_paused WHERE organization_id = NEW.organization_id) THEN
          PERFORM pg_advisory_xact_lock_shared(715026);
        END IF;
        RETURN NEW;
      END $$`);
    await db.execute(sql`
      CREATE OR REPLACE TRIGGER aaaa_test_pause BEFORE INSERT OR UPDATE ON public.identifier_holdings
      FOR EACH ROW EXECUTE FUNCTION public.test_pause_holdings()`);
    await db.execute(sql`INSERT INTO public.test_paused VALUES (${org}::uuid)`);
    const release = gate();
    const holder = heldOpen(
      (q) => q.execute(sql`SELECT pg_advisory_xact_lock(${PAUSE})`),
      release.opened,
    );
    try {
      await holder.ran;
      const writes = start();
      await someoneWaits(writes.length);
      release.open();
      await holder.done;
      return await Promise.all(writes);
    } finally {
      release.open();
      await holder.done.catch(() => undefined);
      await db.execute(sql`DROP TRIGGER aaaa_test_pause ON public.identifier_holdings`);
      await db.execute(sql`DELETE FROM public.test_paused WHERE organization_id = ${org}::uuid`);
    }
  }

  it("a save before a type is created, committed after: the new type still counts its number", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    const commit = gate();
    // a's save writes a former number of a type that doesn't exist yet, and stays uncommitted.
    const saving = heldOpen(
      (q) => saveRecordIdentifiers(q, numbers(org, a, [], [{ type: "omeka_id", value: "812" }])),
      commit.opened,
    );
    ok(await saving.ran);
    // The type is created meanwhile: it must wait for the save, or it can't see a's number.
    const creating = tx((q) => insertIdentifierType(q, omeka(org)));
    await settledOrWaiting(creating);
    commit.open();
    ok(await saving.done);
    ok(await creating);
    expect(await ruleless(org, "omeka_id")).toBe(0);
    expect(codes(await save(numbers(org, b, [], [{ type: "omeka_id", value: "812" }])))).toEqual([
      "not_unique",
    ]);
  });

  it("a type created before a save, committed after: the save still takes its rule", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    const commit = gate();
    const creating = heldOpen((q) => insertIdentifierType(q, omeka(org)), commit.opened);
    ok(await creating.ran);
    // a's save of a former number under the uncommitted type's key.
    const saving = save(numbers(org, a, [], [{ type: "omeka_id", value: "812" }]));
    await settledOrWaiting(saving);
    commit.open();
    ok(await creating.done);
    ok(await saving);
    expect(await ruleless(org, "omeka_id")).toBe(0);
    expect(codes(await save(numbers(org, b, [], [{ type: "omeka_id", value: "812" }])))).toEqual([
      "not_unique",
    ]);
  });

  it("two records swapping numbers at the same moment get not_unique, never a deadlock", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [["object_number", "DHS-0001"]])));
    ok(await save(numbers(org, b, [["object_number", "DHS-0002"]])));
    const results = await paused(org, () => [
      save(numbers(org, a, [["object_number", "DHS-0002"]])),
      save(numbers(org, b, [["object_number", "DHS-0001"]])),
    ]);
    expect(results.map((r) => codes(r))).toEqual([["not_unique"], ["not_unique"]]);
    expect(ok(await readRecordIdentifiers(db, org, a))).toEqual(
      numbers(org, a, [["object_number", "DHS-0001"]]),
    );
  });

  it("allocations of two types in opposite order: in one call, no deadlock; in two, a clean retry", async () => {
    await ready();
    const org = await organization();
    const year = { year: 2026 };
    // The fixed order is the types' lock buckets' (the same in every
    // organization); these two types are in different buckets.
    const order = await db.rows<{ key: string; bucket: number }>(sql`
      SELECT k AS key, public.identifier_type_lock_bucket(k) AS bucket
      FROM unnest(ARRAY['accession_number', 'object_number']) AS k ORDER BY 2`);
    const [lower, higher] = order.map((row) => row.key);
    expect(new Set(order.map((row) => row.bucket)).size).toBe(2);
    if (lower === undefined || higher === undefined) throw new Error("no order");
    const ask = (typeKey: string) =>
      typeKey === "accession_number" ? { typeKey, ...year } : { typeKey };
    const nth = (typeKey: string, n: number): string =>
      typeKey === "accession_number" ? `2026.00${String(n)}` : `DHS-000${String(n)}`;
    // T1 takes the lower bucket's type, then the higher's (the fixed order);
    // T2 asks for both in one call, the other way round. T2 must wait for T1
    // without holding the higher one, or T1 and T2 wait for each other.
    const tookFirst = gate();
    const next = gate();
    const tookSecond = gate();
    const first = tx(async (q) => {
      try {
        const a = ok(await allocateIdentifiers(q, org, [ask(lower)]));
        tookFirst.open();
        await next.opened;
        const b = ok(await allocateIdentifiers(q, org, [ask(higher)]));
        return [...a, ...b];
      } finally {
        tookFirst.open();
        tookSecond.open();
      }
    });
    await tookFirst.opened;
    const second = tx((q) => allocateIdentifiers(q, org, [ask(higher), ask(lower)]));
    await someoneWaits();
    next.open();
    await tookSecond.opened;
    expect(await first).toEqual([nth(lower, 1), nth(higher, 1)]);
    expect(ok(await second)).toEqual([nth(higher, 2), nth(lower, 2)]);

    // Two calls in opposite order can deadlock: the database picks one, which
    // gets a clean `retry` (its transaction still usable), and the other goes on.
    const tookA = gate();
    const tookB = gate();
    const run = (mine: string, theirs: string, took: () => void, wait: Promise<void>) =>
      tx(async (q) => {
        ok(await allocateIdentifier(q, org, mine, year));
        took();
        await wait;
        const result = await allocateIdentifier(q, org, theirs, year);
        const [row] = await q.rows<{ one: number }>(sql`SELECT 1 AS one`);
        return { result, row };
      });
    const one = run("object_number", "accession_number", tookA.open, tookB.opened);
    const two = run("accession_number", "object_number", tookB.open, tookA.opened);
    const outcomes = await Promise.all([one, two]);
    expect(outcomes.map((o) => codes(o.result)).sort()).toEqual([[], ["retry"]]);
    expect(outcomes.map((o) => o.row)).toEqual([{ one: 1 }, { one: 1 }]);
  });

  it("an allocation waits for a save typing the next number by hand, and gives out the one after", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    const commit = gate();
    const saving = heldOpen(
      (q) => saveRecordIdentifiers(q, numbers(org, id, [["object_number", "DHS-0001"]])),
      commit.opened,
    );
    ok(await saving.ran);
    const allocating = tx((q) => allocateIdentifier(q, org, "object_number"));
    await settledOrWaiting(allocating);
    commit.open();
    ok(await saving.done);
    expect(ok(await allocating)).toBe("DHS-0002");
  });

  /**
   * Advisory locks this transaction holds: lock objects, each counted once
   * (pg_locks lists one row per mode, and allocating holds a bucket both
   * shared and exclusive).
   */
  async function advisoryLocks(q: Queryable): Promise<number> {
    const [row] = await q.rows<{ n: number }>(sql`
      SELECT count(DISTINCT (classid, objid, objsubid))::integer AS n FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
    return row?.n ?? 0;
  }

  /** 500 former numbers, each of its own type key no type has. */
  const unknownTypes = (prefix: string): { type: string; value: string }[] =>
    Array.from({ length: 500 }, (_, i) => ({
      type: `${prefix}_${String(i).padStart(3, "0")}`,
      value: "1",
    }));

  it("the type key locks are bounded: 500 unknown former types take at most 64 per organization, save after save", async () => {
    await ready();
    const org = await organization();
    const library = await organization("Invented Public Library");
    const ids = [await record(org), await record(org), await record(org)];
    const theirs = await record(library);
    const counts = await tx(async (q) => {
      const seen: number[] = [];
      for (const [n, id] of ids.entries()) {
        ok(
          await saveRecordIdentifiers(
            q,
            numbers(
              org,
              id,
              [["object_number", `DHS-000${String(n + 1)}`]],
              unknownTypes(`old${String(n)}`),
            ),
          ),
        );
        seen.push(await advisoryLocks(q));
      }
      ok(await allocateIdentifier(q, org, "object_number"));
      seen.push(await advisoryLocks(q));
      // Another organization's buckets are its own: at most 64 more.
      ok(await saveRecordIdentifiers(q, numbers(library, theirs, [], unknownTypes("old0"))));
      seen.push(await advisoryLocks(q));
      return seen;
    });
    expect(counts.slice(0, 4).every((n) => n > 1 && n <= 64)).toBe(true);
    expect(counts[4]).toBeGreaterThan(64);
    expect(counts[4]).toBeLessThanOrEqual(128);
  });

  it("a write outside Read Committed is refused cleanly, by the functions and by the database", async () => {
    await ready();
    const org = await organization();
    const id = await record(org);
    for (const level of [
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
      sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`,
    ]) {
      const results = await tx(async (q) => {
        await q.execute(level);
        const outcomes = [
          await saveRecordIdentifiers(q, numbers(org, id, [["object_number", "DHS-0001"]])),
          await allocateIdentifier(q, org, "object_number"),
          await insertIdentifierType(q, omeka(org)),
          await updateIdentifierType(q, { ...omeka(org), uniqueness: "current" }),
        ];
        // The transaction is still usable.
        const [row] = await q.rows<{ one: number }>(sql`SELECT 1 AS one`);
        return { outcomes, row };
      });
      expect(results.outcomes.map((r) => codes(r))).toEqual([
        ["read_committed_required"],
        ["read_committed_required"],
        ["read_committed_required"],
        ["read_committed_required"],
      ]);
      expect(results.row).toEqual({ one: 1 });
    }
    expect(ok(await readRecordIdentifiers(db, org, id))).toEqual(numbers(org, id, []));
    expect(ok(await readIdentifierTypes(db, org)).map((t) => t.key)).not.toContain("omeka_id");
    // Direct writers too: holdings, types and the lock function check it.
    const direct = async (statement: Sql): Promise<string> =>
      tx(async (q) => {
        await q.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await q.execute(statement);
      }).then(
        () => "",
        (error: unknown) => (error as { code?: string }).code ?? "",
      );
    expect(
      await direct(sql`
        INSERT INTO public.identifier_holdings (organization_id, record_id, type_key, key, current)
        VALUES (${org}::uuid, ${id}::uuid, 'omeka_id', '812', false)`),
    ).toBe("OC061");
    expect(
      await direct(sql`
        INSERT INTO public.identifier_types (organization_id, key, uniqueness, definition)
        VALUES (${org}::uuid, 'omeka_id', 'all_time', ${JSON.stringify(omeka(org))}::jsonb)`),
    ).toBe("OC061");
    expect(
      await direct(sql`SELECT public.identifier_type_locks(${org}::uuid, ARRAY['omeka_id'], true)`),
    ).toBe("OC061");
  });

  it("on a database defaulting to Repeatable Read, transactions are still Read Committed: never a duplicate", async () => {
    await ready();
    if (setup === undefined) throw new Error("not set up");
    const { testDb } = await setup;
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    const alter = async (change: string): Promise<void> => {
      const session = await openSession(testDb.url);
      try {
        await session.runScript(`ALTER DATABASE ${testDb.name} ${change}`);
      } finally {
        await session.close();
      }
    };
    await alter("SET default_transaction_isolation = 'repeatable read'");
    // New connections see the new default.
    const other = openDatabase(testDb.url, { max: 4 });
    try {
      // A statement outside Database.transaction runs under the default: refused.
      const refusal = await other
        .execute(
          sql`
          INSERT INTO public.identifier_holdings (organization_id, record_id, type_key, key, current)
          VALUES (${org}::uuid, ${b}::uuid, 'stray_id', '1', false)`,
        )
        .then(
          () => "",
          (error: unknown) => (error as { code?: string }).code ?? "",
        );
      expect(refusal).toBe("OC061");
      // The race of a save and a type created at the same moment, as above.
      const commit = gate();
      let saved = (): void => undefined;
      const ran = new Promise<void>((resolve) => {
        saved = resolve;
      });
      const saving = other.transaction(async (q) => {
        const result = await saveRecordIdentifiers(
          q,
          numbers(org, a, [], [{ type: "omeka_id", value: "812" }]),
        );
        saved();
        await commit.opened;
        return result;
      });
      await ran;
      const creating = other.transaction((q) => insertIdentifierType(q, omeka(org)));
      await settledOrWaiting(creating);
      commit.open();
      ok(await saving);
      ok(await creating);
      expect(await ruleless(org, "omeka_id")).toBe(0);
      expect(
        codes(
          await other.transaction((q) =>
            saveRecordIdentifiers(q, numbers(org, b, [], [{ type: "omeka_id", value: "812" }])),
          ),
        ),
      ).toEqual(["not_unique"]);
    } finally {
      await other.close();
      await alter("RESET default_transaction_isolation");
    }
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

  it("a type inserted by direct SQL adopts the former numbers already stored under its key", async () => {
    await ready();
    const org = await organization();
    const [a, b] = [await record(org), await record(org)];
    ok(await save(numbers(org, a, [], [{ type: "omeka_id", value: "812" }])));
    const omeka: IdentifierType = {
      organizationId: org,
      key: "omeka_id",
      label: "Omeka ID",
      uniqueness: "all_time",
    };
    await db.execute(sql`
      INSERT INTO public.identifier_types (organization_id, key, uniqueness, definition)
      VALUES (${org}::uuid, 'omeka_id', 'all_time', ${JSON.stringify(omeka)}::jsonb)`);
    expect(codes(await save(numbers(org, b, [["omeka_id", "812"]])))).toEqual(["not_unique"]);
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
