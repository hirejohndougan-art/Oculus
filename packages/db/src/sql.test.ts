import { describe, expect, it } from "vitest";
import { isSql, joinSql, MAX_PARAMETERS, Sql, sql } from "./sql.js";

describe("sql tag", () => {
  it("turns every value into a numbered parameter", () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${"x"} AND c = ${null}`;
    expect(q.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
    expect(q.values).toEqual([1, "x", null]);
  });

  it("has no parameters for plain text", () => {
    const q = sql`SELECT 1`;
    expect(q.text).toBe("SELECT 1");
    expect(q.values).toEqual([]);
  });

  it("never puts a value in the text, whatever it holds", () => {
    const attacks = [
      "'; DROP TABLE oculus_migrations; --",
      "1 OR 1=1",
      "$1",
      "$$; DROP TABLE x; $$",
      "\\'; SELECT pg_sleep(10); --",
      '"; DROP TABLE x; --',
      "x\u0000y",
      "*/ DROP TABLE x /*",
    ];
    for (const attack of attacks) {
      const q = sql`SELECT * FROM records WHERE title = ${attack}`;
      expect(q.text).toBe("SELECT * FROM records WHERE title = $1");
      expect(q.values).toEqual([attack]);
    }
  });

  it("makes an attempted identifier a parameter, not a name", () => {
    const table = "oculus_migrations; DROP TABLE oculus_migrations";
    const column = "name FROM oculus_migrations --";
    const q = sql`SELECT ${column} FROM ${table}`;
    expect(q.text).toBe("SELECT $1 FROM $2");
    expect(q.values).toEqual([column, table]);
  });

  it("splices nested fragments and renumbers their parameters", () => {
    const where = sql`a = ${"one"} AND b = ${"two"}`;
    const q = sql`SELECT ${"zero"} FROM t WHERE ${where} AND c = ${"three"}`;
    expect(q.text).toBe("SELECT $1 FROM t WHERE a = $2 AND b = $3 AND c = $4");
    expect(q.values).toEqual(["zero", "one", "two", "three"]);
  });

  it("keeps attack strings in nested fragments as parameters", () => {
    const evil = "'); DROP TABLE t; --";
    const inner = sql`title = ${evil}`;
    const middle = sql`(${inner}) OR (${inner})`;
    const q = sql`SELECT 1 WHERE ${middle} AND ${evil} = ${evil}`;
    expect(q.text).toBe("SELECT 1 WHERE (title = $1) OR (title = $2) AND $3 = $4");
    expect(q.values).toEqual([evil, evil, evil, evil]);
  });

  it("handles a fragment at the start, at the end and an empty one", () => {
    const q = sql`${sql`SELECT ${1}`}${sql``} + ${2}${sql` + ${3}`}`;
    expect(q.text).toBe("SELECT $1 + $2 + $3");
    expect(q.values).toEqual([1, 2, 3]);
  });

  it("treats something that only looks like a fragment as a value, and refuses it", () => {
    const fake = { text: "1; DROP TABLE t", values: [] };
    expect(() => sql`SELECT ${fake}`).toThrow(TypeError);
    const fake2 = Object.create(Sql.prototype) as Sql;
    expect(isSql(fake2)).toBe(false);
    expect(() => sql`SELECT ${fake2}`).toThrow(TypeError);
  });

  it("can't be called with a made-up strings array", () => {
    const call = sql as unknown as (strings: unknown, ...values: unknown[]) => Sql;
    expect(() => call(["DROP TABLE t"])).toThrow(TypeError);
    expect(() => call("DROP TABLE t")).toThrow(TypeError);
    const looksFrozen = Object.freeze(Object.assign(["SELECT ", ""], { raw: ["SELECT ", ""] }));
    expect(() => call(looksFrozen, 1)).toThrow(TypeError);
    const wrongCount = Object.freeze(
      Object.assign(["SELECT "], { raw: Object.freeze(["SELECT "]) }),
    );
    expect(() => call(wrongCount, 1)).toThrow(TypeError);
  });

  it("can't be constructed directly", () => {
    const Ctor = Sql as unknown as new (token: symbol, parts: string[], values: unknown[]) => Sql;
    expect(() => new Ctor(Symbol("oculus.sql"), ["DROP TABLE t"], [])).toThrow(TypeError);
  });

  it("is frozen, and values are copies", () => {
    const list = ["a", "b"];
    const q = sql`SELECT ${list}`;
    expect(Object.isFrozen(q)).toBe(true);
    list.push("c");
    expect(q.values).toEqual([["a", "b"]]);
    const values = q.values;
    values.push("x");
    expect(q.values).toHaveLength(1);
    expect(isSql(q)).toBe(true);
    expect(isSql({ text: "", values: [] })).toBe(false);
  });

  it("accepts the scalar types that map onto parameters", () => {
    const date = new Date("2026-01-02T00:00:00Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const q = sql`SELECT ${"s"}, ${1.5}, ${10n}, ${true}, ${null}, ${date}, ${bytes}, ${[1, [2, null]]}`;
    expect(q.values).toEqual(["s", 1.5, 10n, true, null, date, bytes, [1, [2, null]]]);
    date.setFullYear(1900);
    bytes[0] = 9;
    expect((q.values[5] as Date).getUTCFullYear()).toBe(2026);
    expect((q.values[6] as Uint8Array)[0]).toBe(1);
  });

  it("refuses values that are not plain parameters", () => {
    const refused: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date("not a date"),
      { a: 1 },
      { toPostgres: () => "1; DROP TABLE t" },
      () => "x",
      Symbol("x"),
      new Map(),
      [undefined],
      [{ a: 1 }],
      [sql`1`],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 2],
    ];
    for (const value of refused) {
      expect(() => sql`SELECT ${value}`).toThrow(TypeError);
    }
  });

  it("refuses arrays nested too deeply", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 8; i++) deep = [deep];
    expect(() => sql`SELECT ${deep}`).toThrow(/too deeply/);
  });

  it("refuses more parameters than PostgreSQL allows", () => {
    const many = Array.from({ length: MAX_PARAMETERS + 1 }, (_, i) => sql`${i}`);
    expect(() => joinSql(many, sql`, `)).toThrow(RangeError);
    const ok = joinSql(many.slice(0, MAX_PARAMETERS), sql`, `);
    expect(ok.values).toHaveLength(MAX_PARAMETERS);
    expect(() => sql`${ok}, ${1}`).toThrow(RangeError);
  });
});

describe("placeholders can't run into the text around them", () => {
  it("refuses a digit, letter, _ or $ right after a value", () => {
    for (const make of [
      () => sql`SELECT ${"a"}0`,
      () => sql`SELECT ${"a"}_x`,
      () => sql`SELECT ${"a"}abc`,
      () => sql`SELECT ${"a"}$`,
      () => sql`SELECT ${sql`${"a"}`}1`,
      () => sql`SELECT ${"a"}${sql`9`}`,
    ]) {
      expect(make).toThrow(/touches the text/);
    }
  });

  it("refuses an identifier character or $ right before a value", () => {
    for (const make of [
      () => sql`SELECT col${"a"}`,
      () => sql`SELECT $${"a"}`,
      () => sql`SELECT 1${"a"}`,
      () => sql`SELECT é${"a"}`,
      () => sql`SELECT ${sql`x`}${"a"}`,
    ]) {
      expect(make).toThrow(/touches the text/);
    }
  });

  it("allows spaces, operators, casts and brackets", () => {
    const q = sql`SELECT (${1})::int, ${2}+${3}, ARRAY[${4}], ${5},${6}`;
    expect(q.text).toBe("SELECT ($1)::int, $2+$3, ARRAY[$4], $5,$6");
  });
});

describe("joinSql", () => {
  it("joins fragments with a separator and renumbers", () => {
    const q = sql`SELECT * FROM t WHERE id IN (${joinSql(
      ["a", "b", "c"].map((id) => sql`${id}`),
      sql`, `,
    )})`;
    expect(q.text).toBe("SELECT * FROM t WHERE id IN ($1, $2, $3)");
    expect(q.values).toEqual(["a", "b", "c"]);
  });

  it("gives empty text for no fragments", () => {
    expect(joinSql([], sql`, `).text).toBe("");
  });

  it("refuses anything that isn't sql", () => {
    const join = joinSql as unknown as (items: unknown[], sep: unknown) => Sql;
    expect(() => join(["a; DROP TABLE t"], sql`, `)).toThrow(TypeError);
    expect(() => join([sql`a`, sql`b`], "; DROP TABLE t; ")).toThrow(TypeError);
  });
});
