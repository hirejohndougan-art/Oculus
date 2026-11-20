// Key metric for the gate: tests_passing must never fall below the floor in
// gate-baseline.json. Reads the Vitest JSON report written by scripts/gate.mjs.
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(".gate/vitest.json", "utf8"));
const baseline = JSON.parse(readFileSync("gate-baseline.json", "utf8"));
const passing = report.numPassedTests;
const floor = baseline.tests_passing;

if (!Number.isInteger(passing) || !Number.isInteger(floor)) {
  console.error("Baseline check failed: could not read tests_passing.");
  process.exit(1);
}
if (report.numFailedTests > 0 || passing < floor) {
  console.error(`Baseline check failed: tests_passing ${passing} (floor ${floor}).`);
  process.exit(1);
}
console.log(`tests_passing ${passing} (floor ${floor})`);
