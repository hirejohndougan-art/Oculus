// The root `build` script names every workspace explicitly, in dependency
// order (T-042, D-079): npm's own `--workspaces` order is alphabetical, which
// would build `@oculus/api` before the packages it imports. This test keeps
// the list complete, so a new package (the admin, D-073) can't be left out
// of the build silently, and keeps each package after the ones it uses.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("the root build script", () => {
  it("builds every workspace once, after the workspaces it depends on", () => {
    const script = read(join(root, "package.json")).scripts.build;
    const order = [...script.matchAll(/npm run build -w (\S+)/g)].map((m) => m[1]);
    const packages = readdirSync(join(root, "packages"))
      .map((dir) => join(root, "packages", dir, "package.json"))
      .filter((file) => existsSync(file))
      .map((file) => read(file))
      .filter((pkg) => pkg.scripts?.build !== undefined);
    expect([...order].sort()).toEqual(packages.map((p) => p.name).sort());
    expect(new Set(order).size).toBe(order.length);
    for (const pkg of packages) {
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
        order.includes(d),
      );
      for (const dep of deps) {
        expect(order.indexOf(dep), `${dep} before ${pkg.name}`).toBeLessThan(
          order.indexOf(pkg.name),
        );
      }
    }
  });
});
