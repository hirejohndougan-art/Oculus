// The admin's copy of the design tokens matches design/tokens/tokens.css,
// and every CSS Module's type file lists exactly its class names.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const admin = join(import.meta.dirname, "..");
const repo = join(admin, "..", "..", "..");

function variables(css: string): Record<string, string> {
  const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    // Prettier writes the copy with double quotes and spaces after commas.
    if (m[1] !== undefined && m[2] !== undefined) {
      out[m[1]] = m[2].trim().replace(/'/g, '"').replace(/,\s*/g, ",");
    }
  }
  return out;
}

describe("styles", () => {
  it("keeps the design tokens as design/tokens/tokens.css has them", () => {
    const design = variables(readFileSync(join(repo, "design", "tokens", "tokens.css"), "utf8"));
    const copy = variables(readFileSync(join(admin, "styles", "tokens.css"), "utf8"));
    expect(Object.keys(design).length).toBeGreaterThan(40);
    expect(copy).toEqual(design);
  });

  it("loads nothing from another origin (the admin's CSP allows 'self' only)", () => {
    for (const name of ["tokens.css", "fonts.css", "global.css"]) {
      const text = readFileSync(join(admin, "styles", name), "utf8");
      expect(text, name).not.toMatch(/@import|https?:\/\//);
    }
  });

  it("types every CSS Module with exactly its class names", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const modules = walk(admin).filter((f) => f.endsWith(".module.css"));
    expect(modules.length).toBeGreaterThan(3);
    for (const file of modules) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const classes = [
        ...new Set([...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1])),
      ].sort();
      const types = readFileSync(file.replace(/\.module\.css$/, ".module.d.css.ts"), "utf8");
      const typed = [...types.matchAll(/readonly ([A-Za-z_][A-Za-z0-9_-]*): string;/g)]
        .map((m) => m[1])
        .sort();
      expect(typed, file).toEqual(classes);
    }
  });
});
