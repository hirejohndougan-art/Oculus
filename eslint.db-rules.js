// Lint rules that keep the database driver inside packages/db (D-050):
// - only packages/db may import `pg` (or its parts, or another driver);
// - only packages/db/src/client.ts may call `.query()`, and it takes only
//   values made by the `sql` tag;
// - `sql` is only ever used as a tag, never called with a made-up array.
// Exported on their own so scripts/eslint-db-rules.test.mjs can check them.

const DRIVER = "^(?:pg|pg-[a-z0-9-]+|pgpass|postgres|postgres-[a-z0-9-]+|@types/pg)(?:/.*)?$";
// The same pattern inside an esquery selector, where "/" ends the regex.
const DRIVER_IN_SELECTOR = DRIVER.replaceAll("/", "\\/");
const DRIVER_MESSAGE = "Only packages/db talks to PostgreSQL (D-050); import @oculus/db instead.";

const driverImports = {
  "no-restricted-imports": ["error", { patterns: [{ regex: DRIVER, message: DRIVER_MESSAGE }] }],
};

const dynamicDriverImports = [
  { selector: `ImportExpression[source.value=/${DRIVER_IN_SELECTOR}/]`, message: DRIVER_MESSAGE },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${DRIVER_IN_SELECTOR}/]`,
    message: DRIVER_MESSAGE,
  },
  {
    selector: `TSExternalModuleReference[expression.value=/${DRIVER_IN_SELECTOR}/]`,
    message: DRIVER_MESSAGE,
  },
];

const queryCalls = [
  {
    selector: "CallExpression[callee.property.name='query']",
    message:
      "Only packages/db/src/client.ts calls .query(); write queries with the sql tag and run them through @oculus/db (D-050).",
  },
];

const sqlCalls = [
  {
    selector: "CallExpression[callee.name='sql']",
    message: "Use sql only as a tagged template: sql`...` (D-050).",
  },
  {
    selector:
      "CallExpression[callee.object.name='sql'][callee.property.name=/^(call|apply|bind)$/]",
    message: "Use sql only as a tagged template: sql`...` (D-050).",
  },
];

const CODE = ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs"];

export const dbRules = [
  {
    files: CODE,
    rules: {
      ...driverImports,
      "no-restricted-syntax": ["error", ...dynamicDriverImports, ...queryCalls, ...sqlCalls],
    },
  },
  {
    files: ["packages/db/**"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": ["error", ...queryCalls, ...sqlCalls],
    },
  },
  {
    files: ["packages/db/src/client.ts"],
    rules: { "no-restricted-syntax": ["error", ...sqlCalls] },
  },
];
