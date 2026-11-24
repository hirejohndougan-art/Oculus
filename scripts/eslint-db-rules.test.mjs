// The lint rules that keep the driver inside packages/db (D-050), run through
// the repository's real eslint.config.js on snippets. The only change to the
// config is letting the virtual snippet files (which aren't on disk) into
// TypeScript's default project, so typed linting can parse them.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const PROBES = [
  "lint-probe/*.ts",
  "lint-probe/*.mts",
  "lint-probe/*.cts",
  "lint-probe/*.tsx",
  "packages/db/src/lint-probe.ts",
  "scripts/lint-probe.ts",
];

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfig: [
    {
      files: ["**/*.{ts,mts,cts,tsx}"],
      languageOptions: { parserOptions: { projectService: { allowDefaultProject: PROBES } } },
    },
  ],
});

const DB_RULES = new Set(["no-restricted-imports", "no-restricted-syntax"]);

/** The db rules' findings for a snippet; fails on a parse error. */
async function problems(code, filename) {
  const [result] = await eslint.lintText(code, { filePath: `${process.cwd()}/${filename}` });
  const parseErrors = result.messages.filter((m) => m.ruleId === null);
  expect(parseErrors.map((m) => m.message)).toEqual([]);
  return result.messages.filter((m) => DB_RULES.has(m.ruleId)).map((m) => m.ruleId);
}

const OUTSIDE = "lint-probe/example.ts";
const INSIDE = "packages/db/src/lint-probe.ts";
const CLIENT = "packages/db/src/client.ts";

// Linting with type information is slow on a busy two-core machine; the first call can pass 5 s (U-005).
describe("pg stays inside packages/db", { timeout: 60_000 }, () => {
  const imports = [
    'import pg from "pg";\nexport const a = pg;',
    'import type { Pool } from "pg";\nexport type A = Pool;',
    'import { Pool } from "pg-pool";\nexport const a = Pool;',
    'import "pg/lib/client.js";',
    'import x from "pg-protocol";\nexport const a = x;',
    'import postgres from "postgres";\nexport const a = postgres;',
    'export { Client } from "pg";',
    'export * from "pg";',
  ];

  it("refuses static imports and re-exports of the driver outside packages/db", async () => {
    for (const code of imports) {
      expect(await problems(code, OUTSIDE), code).toContain("no-restricted-imports");
      expect(await problems(code, "scripts/lint-probe.ts"), code).toContain(
        "no-restricted-imports",
      );
    }
  });

  it("refuses dynamic imports and require of the driver outside packages/db", async () => {
    for (const code of [
      'export const a = await import("pg");',
      'export const a = await import("pg-pool");',
      'import pg = require("pg");\nexport const a = pg;',
    ]) {
      expect(await problems(code, OUTSIDE), code).toContain("no-restricted-syntax");
    }
    expect(
      await problems('const pg = require("pg");\nconsole.log(pg);', "scripts/lint-probe.cjs"),
    ).toContain("no-restricted-syntax");
  });

  it("parses .mts, .cts and .tsx files as TypeScript and applies the rules there", async () => {
    for (const file of ["lint-probe/a.mts", "lint-probe/a.cts", "lint-probe/a.tsx"]) {
      const typed = 'import type { Pool } from "pg";\nexport type A = Pool;';
      expect(await problems(typed, file), file).toContain("no-restricted-imports");
      expect(
        await problems(
          "declare const client: { query(s: string): void };\nclient.query('x');",
          file,
        ),
        file,
      ).toContain("no-restricted-syntax");
    }
    expect(await problems("export const el = <div>{String(1)}</div>;", "lint-probe/a.tsx")).toEqual(
      [],
    );
  });

  it("covers plain JavaScript files too", async () => {
    expect(
      await problems('import pg from "pg";\nconsole.log(pg);', "scripts/lint-probe.mjs"),
    ).toContain("no-restricted-imports");
  });

  it("allows the driver inside packages/db, and other packages elsewhere", async () => {
    for (const code of imports) expect(await problems(code, INSIDE), code).toEqual([]);
    for (const code of [
      'export { sql } from "@oculus/db";',
      'export * from "pgx-unrelated";',
      'export * from "./pg.js";',
    ]) {
      expect(await problems(code, OUTSIDE), code).toEqual([]);
    }
  });
});

describe(".query() only in client.ts, and sql only as a tag", { timeout: 60_000 }, () => {
  const queries =
    'declare const client: { query(s: string): void };\nclient.query("DROP TABLE t");\nclient["query"]("DROP TABLE t");';

  it("refuses .query(), also by a computed name, everywhere but client.ts", async () => {
    expect(await problems(queries, OUTSIDE)).toEqual([
      "no-restricted-syntax",
      "no-restricted-syntax",
    ]);
    expect(await problems(queries, INSIDE)).toEqual([
      "no-restricted-syntax",
      "no-restricted-syntax",
    ]);
    expect(await problems(queries, CLIENT)).toEqual([]);
  });

  it("refuses .query() with a computed name in single quotes, and with a template literal", async () => {
    const declare =
      "declare const client: { query(s: string): void };\ndeclare const pool: { query(s: string): void };\ndeclare const x: string;\n";
    for (const call of ["client['query'](x);", "pool.query(`SELECT ${x}`);"]) {
      expect(await problems(declare + call, OUTSIDE), call).toEqual(["no-restricted-syntax"]);
      expect(await problems(declare + call, "scripts/lint-probe.ts"), call).toEqual([
        "no-restricted-syntax",
      ]);
      expect(await problems(declare + call, CLIENT), call).toEqual([]);
    }
  });

  it("refuses calling sql as a function, even in client.ts", async () => {
    const declare = "declare const sql: (...a: unknown[]) => unknown;\n";
    for (const call of [
      'sql(["DROP TABLE t"]);',
      'sql.call(null, ["DROP TABLE t"]);',
      'sql.apply(null, [["DROP TABLE t"]]);',
    ]) {
      expect(await problems(declare + call, OUTSIDE), call).toContain("no-restricted-syntax");
      expect(await problems(declare + call, CLIENT), call).toContain("no-restricted-syntax");
    }
    expect(await problems(`${declare}sql\`SELECT \${1}\`;`, OUTSIDE)).toEqual([]);
  });
});
