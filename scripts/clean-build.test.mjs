// U-007: the gate's first step removes every package's build output, and
// nothing else.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeBuildOutput } from "./clean-build.mjs";

let root;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("removeBuildOutput", () => {
  it("removes packages/*/dist and leaves sources and other folders", () => {
    root = mkdtempSync(join(tmpdir(), "oculus-clean-"));
    for (const name of ["core", "admin"]) {
      mkdirSync(join(root, "packages", name, "dist", "deep"), { recursive: true });
      writeFileSync(join(root, "packages", name, "dist", "deep", "old.js"), "old");
      mkdirSync(join(root, "packages", name, "src"), { recursive: true });
      writeFileSync(join(root, "packages", name, "src", "index.ts"), "new");
    }
    mkdirSync(join(root, "packages", "db", "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "README"), "not a package");

    const removed = removeBuildOutput(root);
    expect(removed.sort()).toEqual(
      [join(root, "packages", "admin", "dist"), join(root, "packages", "core", "dist")].sort(),
    );
    expect(existsSync(join(root, "packages", "core", "dist"))).toBe(false);
    expect(existsSync(join(root, "packages", "core", "src", "index.ts"))).toBe(true);
    expect(existsSync(join(root, "dist"))).toBe(true);
    expect(removeBuildOutput(root)).toEqual([]);
  });

  it("does nothing without a packages folder", () => {
    root = mkdtempSync(join(tmpdir(), "oculus-clean-"));
    expect(removeBuildOutput(root)).toEqual([]);
  });
});
