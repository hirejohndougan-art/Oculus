// The sql tag and the client against a real server: injection attempts through
// values, identifiers and nested fragments change nothing, and the type
// parsers return text where pg would otherwise lose precision or shift days.
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./client.js";
import { joinSql, sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

// Set up lazily inside each test (not in beforeAll), so with no database
// every test fails on its own rather than being reported as skipped.
let setup: Promise<{ testDb: TestDatabase; db: Database }> | undefined;
let db: Database;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    const opened = openDatabase(testDb.url, { max: 3 });
    await opened.execute(sql`CREATE TABLE victims (id int PRIMARY KEY, title text NOT NULL)`);
    await opened.execute(sql`INSERT INTO victims VALUES (1, 'kept'), (2, 'also kept')`);
    return { testDb, db: opened };
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

async function victimsIntact(): Promise<void> {
  const rows = await db.rows<{ id: number; title: string }>(
    sql`SELECT id, title FROM victims ORDER BY id`,
  );
  expect(rows).toEqual([
    { id: 1, title: "kept" },
    { id: 2, title: "also kept" },
  ]);
}

const ATTACKS = [
  "'; DROP TABLE victims; --",
  "1'; DELETE FROM victims WHERE '1'='1",
  "x' OR '1'='1",
  "$$; DROP TABLE victims; $$",
  "\\'; DROP TABLE victims; --",
  "'); UPDATE victims SET title = 'pwned'; --",
  "1 UNION SELECT name, sha256 FROM oculus_migrations",
  "ʼ; DROP TABLE victims; --",
];

describe("values are only ever data", () => {
  it("round-trips every attack string exactly and runs none of it", async () => {
    await ready();
    for (const attack of ATTACKS) {
      const rows = await db.rows<{ v: string }>(sql`SELECT ${attack}::text AS v`);
      expect(rows).toEqual([{ v: attack }]);
      const found = await db.rows(sql`SELECT id FROM victims WHERE title = ${attack}`);
      expect(found).toEqual([]);
    }
    await victimsIntact();
  });

  it("can't stack a second statement through a value", async () => {
    await ready();
    await expect(
      db.execute(sql`UPDATE victims SET title = title WHERE id = ${"1; DROP TABLE victims"}`),
    ).rejects.toThrow(/invalid input syntax for type integer/);
    await victimsIntact();
  });

  it("can't use a value as a table or column name", async () => {
    await ready();
    await expect(db.rows(sql`SELECT * FROM ${"victims; DROP TABLE victims"}`)).rejects.toThrow(
      /syntax error/,
    );
    const rows = await db.rows<{ c: string }>(
      sql`SELECT ${"title FROM victims; DROP TABLE victims; --"}::text AS c`,
    );
    expect(rows).toEqual([{ c: "title FROM victims; DROP TABLE victims; --" }]);
    await victimsIntact();
  });

  it("keeps attacks in nested fragments as parameters", async () => {
    await ready();
    const evil = "kept' OR '1'='1";
    const condition = sql`title = ${evil}`;
    const either = sql`(${condition}) OR (${sql`id = ${-1}`})`;
    const rows = await db.rows(sql`SELECT id FROM victims WHERE ${either}`);
    expect(rows).toEqual([]);
    const ids = joinSql(
      [1, 2].map((id) => sql`${id}`),
      sql`, `,
    );
    const listed = await db.rows<{ id: number }>(
      sql`SELECT id FROM victims WHERE id IN (${ids}) AND title <> ${evil} ORDER BY id`,
    );
    expect(listed).toEqual([{ id: 1 }, { id: 2 }]);
    await victimsIntact();
  });

  it("passes JSON only as a parameter, including keys", async () => {
    await ready();
    const doc = { "a'); DROP TABLE victims; --": "v", n: 1 };
    const rows = await db.rows<{ value: string | null; n: number }>(
      sql`SELECT (${JSON.stringify(doc)}::jsonb) ->> ${"a'); DROP TABLE victims; --"} AS value,
                 ((${JSON.stringify(doc)}::jsonb) -> ${"n"})::int AS n`,
    );
    expect(rows).toEqual([{ value: "v", n: 1 }]);
    await victimsIntact();
  });

  it("sends arrays, bytes, booleans and bigints as typed parameters", async () => {
    await ready();
    const [row] = await db.rows<{ a: string[]; b: string; c: boolean; d: string; e: number }>(
      sql`SELECT ${["x'y", 'q"z', null, "{,}"]}::text[] AS a,
                 encode(${new Uint8Array([0, 39, 255])}::bytea, 'hex') AS b,
                 ${true}::boolean AS c,
                 ${9007199254740993n}::int8 AS d,
                 array_length(${[1, 2, 3]}::int[], 1) AS e`,
    );
    expect(row).toEqual({
      a: ["x'y", 'q"z', null, "{,}"],
      b: "0027ff",
      c: true,
      d: "9007199254740993",
      e: 3,
    });
  });

  it("runs one statement only, even when the query has no values", async () => {
    await ready();
    await expect(db.execute(sql`SELECT 1; DROP TABLE victims`)).rejects.toThrow(
      /multiple commands/,
    );
    await expect(
      db.transaction((tx) => tx.execute(sql`SELECT 1; DELETE FROM victims`)),
    ).rejects.toThrow(/multiple commands/);
    await victimsIntact();
  });

  it("refuses a query that wasn't made by the tag", async () => {
    await ready();
    const raw = { text: "DROP TABLE victims", values: [] } as unknown as ReturnType<typeof sql>;
    await expect(db.execute(raw)).rejects.toThrow(/sql tag/);
    await victimsIntact();
  });
});

describe("type parsers and session settings", () => {
  it("returns int8 and numeric as strings and dates as the server's text", async () => {
    await ready();
    const [row] = await db.rows(
      sql`SELECT 9007199254740993::int8 AS big,
                 12345678901234567890.123456789::numeric AS num,
                 DATE '0099-01-02' AS day,
                 TIMESTAMP '2026-03-08 02:30:00' AS ts,
                 TIMESTAMPTZ '2026-11-23 12:00:00+00' AS tstz,
                 INTERVAL '1 day 2 hours' AS span,
                 ARRAY[1::int8, 2::int8] AS bigs,
                 ARRAY[1.10::numeric] AS nums,
                 ARRAY[DATE '2026-01-02'] AS days,
                 5::int4 AS small,
                 current_setting('TimeZone') AS tz`,
    );
    expect(row).toEqual({
      big: "9007199254740993",
      num: "12345678901234567890.123456789",
      day: "0099-01-02",
      ts: "2026-03-08 02:30:00",
      tstz: "2026-11-23 12:00:00+00",
      span: "P1DT2H",
      bigs: ["1", "2"],
      nums: ["1.10"],
      days: ["2026-01-02"],
      small: 5,
      tz: "UTC",
    });
  });
});

describe("transactions", () => {
  it("commits on success and rolls back on failure", async () => {
    await ready();
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO victims VALUES (${3}, ${"temp"})`);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM victims`);
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await db.execute(sql`DELETE FROM victims WHERE id = ${3}`)).toBe(1);
    await victimsIntact();
  });
});
