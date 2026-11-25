// The gate starts from no build (U-007): every package's `dist` is removed
// first, so a local run can't pass on an old build that CI wouldn't have
// (how U-006 went unseen). Only `packages/<name>/dist` folders are touched.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Removes each `packages/*\/dist` under `root`; returns the folders removed. */
export function removeBuildOutput(root) {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  const removed = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dist = join(packages, entry.name, "dist");
    if (!existsSync(dist)) continue;
    rmSync(dist, { recursive: true, force: true });
    removed.push(dist);
  }
  return removed;
}
