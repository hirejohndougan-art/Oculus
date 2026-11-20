// `npm run gate`: every check in docs/AUTOPILOT.md "The gate", in order.
// Stops at the first failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

// Start clean so the baseline check can never read an old test report.
rmSync(".gate", { recursive: true, force: true });
mkdirSync(".gate", { recursive: true });

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
  ["npm audit (high and critical)", "npm", ["run", "audit"]],
  ["License check", "npm", ["run", "licenses"]],
  ["tests_passing baseline", "npm", ["run", "baseline"]],
];

for (const [name, cmd, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nGATE FAIL at: ${name}`);
    process.exit(1);
  }
}
console.log("\nGATE PASS");
