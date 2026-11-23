// The lint rules that keep the driver inside packages/db (D-050), run on
// snippets with the same parser the repository uses.
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { dbRules } from "../eslint.db-rules.js";

const linter = new Linter({ configType: "flat" });
const config = [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } }, ...dbRules];

function problems(code, filename) {
  return linter.verify(code, config, { filename }).map((m) => m.ruleId ?? m.message);
}

const OUTSIDE = "packages/core/src/example.ts";
const INSIDE = "packages/db/src/example.ts";
const CLIENT = "packages/db/src/client.ts";

describe("pg stays inside packages/db", () => {
  const imports = [
    'import pg from "pg";',
    'import type { Pool } from "pg";',
    'import { Pool } from "pg-pool";',
    'import "pg/lib/client.js";',
    'import x from "pg-protocol";',
    'import postgres from "postgres";',
    'export { Client } from "pg";',
    'export * from "pg";',
  ];

  it("refuses static imports and re-exports of the driver outside packages/db", () => {
    for (const code of imports) {
      expect(problems(code, OUTSIDE), code).toContain("no-restricted-imports");
      expect(problems(code, "scripts/example.ts"), code).toContain("no-restricted-imports");
    }
  });

  it("refuses dynamic imports and require of the driver outside packages/db", () => {
    for (const code of [
      'await import("pg");',
      'await import("pg-pool");',
      'const pg = require("pg");',
      'import pg = require("pg");',
    ]) {
      expect(problems(code, OUTSIDE), code).toContain("no-restricted-syntax");
    }
  });

  it("covers plain JavaScript files too", () => {
    expect(problems('import pg from "pg";', "scripts/example.mjs")).toContain(
      "no-restricted-imports",
    );
    expect(problems('const pg = await import("pg");', "scripts/example.mjs")).toContain(
      "no-restricted-syntax",
    );
  });

  it("allows the driver inside packages/db, and other packages elsewhere", () => {
    for (const code of imports) expect(problems(code, INSIDE), code).toEqual([]);
    for (const code of [
      'import { sql } from "@oculus/db";',
      'import x from "pgx-unrelated";',
      'import x from "./pg.js";',
    ]) {
      expect(problems(code, OUTSIDE), code).toEqual([]);
    }
  });
});

describe(".query() only in client.ts, and sql only as a tag", () => {
  it("refuses .query() everywhere but client.ts", () => {
    const code = 'client.query("DROP TABLE t");\npool.query(`SELECT ${x}`);';
    expect(problems(code, OUTSIDE)).toEqual(["no-restricted-syntax", "no-restricted-syntax"]);
    expect(problems(code, INSIDE)).toEqual(["no-restricted-syntax", "no-restricted-syntax"]);
    expect(problems(code, CLIENT)).toEqual([]);
  });

  it("refuses calling sql as a function, even in client.ts", () => {
    for (const code of [
      'sql(["DROP TABLE t"]);',
      'sql.call(null, ["DROP TABLE t"]);',
      'sql.apply(null, [["DROP TABLE t"]]);',
    ]) {
      expect(problems(code, OUTSIDE), code).toContain("no-restricted-syntax");
      expect(problems(code, CLIENT), code).toContain("no-restricted-syntax");
    }
    expect(problems("sql`SELECT ${1}`;", OUTSIDE)).toEqual([]);
  });
});
