// `npm run db:migrate` must work on a fresh clone, where nothing is built:
// @oculus/db's build reads @oculus/core's built types, so the script builds
// core first (D-060). This copies the two packages, without any dist, into a
// temporary checkout that shares this one's installed dependencies, and runs
// the script there with no OCULUS_DATABASE_URL: the CLI's own "is not set"
// message (exit code 2) shows both builds ran and the CLI started.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = process.cwd();
const checkout = mkdtempSync(join(tmpdir(), "oculus-clean-"));

afterAll(() => {
  rmSync(checkout, { recursive: true, force: true });
});

function copy(path) {
  cpSync(join(repo, path), join(checkout, path), { recursive: true });
}

describe("npm run db:migrate from a clean checkout", () => {
  it("builds @oculus/core first, then runs the CLI", () => {
    for (const path of ["package.json", "tsconfig.base.json"]) copy(path);
    for (const pkg of ["core", "db"]) {
      for (const entry of ["package.json", "tsconfig.json", "tsconfig.build.json", "src"]) {
        copy(join("packages", pkg, entry));
      }
    }
    copy("packages/db/migrations");
    // The installed dependencies, except the workspace links, which must
    // point into this checkout so nothing already built is used.
    const modules = join(checkout, "node_modules");
    mkdirSync(join(modules, "@oculus"), { recursive: true });
    for (const entry of readdirSync(join(repo, "node_modules"))) {
      if (entry !== "@oculus") symlinkSync(join(repo, "node_modules", entry), join(modules, entry));
    }
    for (const pkg of ["core", "db"]) {
      symlinkSync(join(checkout, "packages", pkg), join(modules, "@oculus", pkg));
    }
    expect(existsSync(join(checkout, "packages/core/dist"))).toBe(false);
    expect(existsSync(join(checkout, "packages/db/dist"))).toBe(false);

    // A plain environment: no npm settings from the run that started this
    // test, and no database.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toLowerCase().startsWith("npm_") && !key.startsWith("OCULUS_"),
      ),
    );
    const result = spawnSync("npm", ["run", "db:migrate"], {
      cwd: checkout,
      env,
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("OCULUS_DATABASE_URL is not set");
    expect(result.status).not.toBe(0);
    expect(existsSync(join(checkout, "packages/core/dist/index.js"))).toBe(true);
    expect(existsSync(join(checkout, "packages/db/dist/migrate-cli.js"))).toBe(true);
  }, 120_000);
});
