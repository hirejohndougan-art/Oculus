// `npm run gate`: every check in docs/AUTOPILOT.md "The gate", in order.
// Stops at the first failure.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { removeBuildOutput } from "./clean-build.mjs";
import { findPostgresBin, startTestDatabase } from "./test-database.mjs";

// Start clean so the baseline check can never read an old test report.
rmSync(".gate", { recursive: true, force: true });
mkdirSync(".gate", { recursive: true });
// And from no build (U-007): the type check, tests and build must not lean
// on an old `packages/*/dist`.
removeBuildOutput(process.cwd());

const steps = [
  ["Format (Prettier)", "npm", ["run", "format:check"]],
  ["Lint (ESLint)", "npm", ["run", "lint"]],
  ["Type check (tsc)", "npm", ["run", "typecheck"]],
  [
    "Tests (Vitest)",
    "npx",
    [
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=.gate/vitest.json",
    ],
  ],
  ["Build", "npm", ["run", "build"]],
  // The built admin served by Fastify against its own throwaway database, in
  // a browser, with Siteimprove Alfa's accessibility rules (D-073, D-081).
  ["End-to-end (Playwright, Alfa)", "npm", ["run", "e2e", "-w", "@oculus/admin"]],
  ["npm audit (high and critical)", "npm", ["run", "audit"]],
  ["License check", "npm", ["run", "licenses"]],
  ["tests_passing baseline", "npm", ["run", "baseline"]],
];

// The database the tests use (D-049): OCULUS_TEST_DATABASE_URL if set (CI),
// otherwise a throwaway server started just for the test step and stopped and
// deleted afterwards, even on failure. Steps run as async child processes, so a
// SIGINT, SIGTERM or SIGHUP to the gate is handled at once: the running step is
// stopped, then the server.
let testDatabase;
let child;
const stopTestDatabase = () => {
  testDatabase?.stop();
  testDatabase = undefined;
};
process.on("exit", stopTestDatabase);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.error(`\nGATE FAIL: stopped by ${signal}`);
    // Each step runs in its own process group, so this reaches npx's children too.
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The step had already ended.
      }
    }
    stopTestDatabase();
    process.exit(1);
  });
}

function testEnvironment() {
  if (process.env.OCULUS_TEST_DATABASE_URL) {
    console.log("Using the database server in OCULUS_TEST_DATABASE_URL.");
    return process.env;
  }
  const bin = findPostgresBin();
  if (!bin) {
    throw new Error(
      "No PostgreSQL for the database tests. Install PostgreSQL 15 or newer (so `pg_config --bindir` finds initdb and pg_ctl), set PG_BIN to its bin directory, or set OCULUS_TEST_DATABASE_URL to a server where tests may create databases.",
    );
  }
  testDatabase = startTestDatabase({ bin });
  return { ...process.env, OCULUS_TEST_DATABASE_URL: testDatabase.url };
}

function runStep(cmd, args, env) {
  return new Promise((resolve) => {
    child = spawn(cmd, args, { stdio: "inherit", env, detached: true });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("close", (code) => {
      child = undefined;
      resolve(code ?? 1);
    });
  });
}

for (const [name, cmd, args] of steps) {
  console.log(`\n=== ${name} ===`);
  let status;
  try {
    const env = name.startsWith("Tests") ? testEnvironment() : process.env;
    status = await runStep(cmd, args, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    status = 1;
  } finally {
    stopTestDatabase();
  }
  if (status !== 0) {
    console.error(`\nGATE FAIL at: ${name}`);
    process.exit(1);
  }
}
console.log("\nGATE PASS");
