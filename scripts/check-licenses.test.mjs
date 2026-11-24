import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFonts, findFontFiles, isAllowed } from "./check-licenses.mjs";

describe("license check (D-002)", () => {
  it.each(["MIT", "ISC", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0"])(
    "allows %s",
    (license) => {
      expect(isAllowed(license)).toBe(true);
    },
  );

  it.each([
    "GPL-3.0",
    "GPL-2.0-only",
    "AGPL-3.0-or-later",
    "LGPL-2.1",
    "MPL-2.0",
    "EPL-2.0",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.md",
    "",
    "Apache-2.0 WITH LLVM-exception",
  ])("rejects %j", (license) => {
    expect(isAllowed(license)).toBe(false);
  });

  it("rejects a missing license", () => {
    expect(isAllowed(undefined)).toBe(false);
  });

  it("allows a choice when any option is permissive", () => {
    expect(isAllowed("(MIT OR GPL-3.0)")).toBe(true);
    expect(isAllowed("GPL-3.0 OR Apache-2.0")).toBe(true);
  });

  it("requires every part of an AND to be permissive", () => {
    expect(isAllowed("MIT AND BSD-3-Clause")).toBe(true);
    expect(isAllowed("MIT AND GPL-3.0")).toBe(false);
  });

  it("follows SPDX precedence and parentheses", () => {
    // AND binds tighter: GPL-3.0 OR (MIT AND ISC) -> allowed through the right side
    expect(isAllowed("GPL-3.0 OR MIT AND ISC")).toBe(true);
    // (MIT OR GPL) AND LGPL -> LGPL is required, so not allowed
    expect(isAllowed("(MIT OR GPL-3.0) AND LGPL-2.1")).toBe(false);
    expect(isAllowed("(MIT OR GPL-3.0) AND (ISC OR AGPL-3.0)")).toBe(true);
  });

  it("fails closed on malformed expressions", () => {
    expect(isAllowed("(MIT OR")).toBe(false);
    expect(isAllowed("MIT)")).toBe(false);
    expect(isAllowed("MIT ISC")).toBe(false);
    expect(isAllowed("OR MIT")).toBe(false);
  });
});

describe("font files (D-073)", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fontBytes = Buffer.from("not really a font");
  const sha = createHash("sha256").update(fontBytes).digest("hex");
  function tree(manifest, { license = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "oculus-fonts-"));
    dirs.push(root);
    const fonts = join(root, "public", "fonts");
    mkdirSync(fonts, { recursive: true });
    writeFileSync(join(fonts, "a.woff2"), fontBytes);
    if (license) writeFileSync(join(fonts, "OFL.txt"), "SIL Open Font License 1.1");
    if (manifest !== undefined) writeFileSync(join(fonts, "FONTS.json"), manifest);
    // Fonts inside dependencies and builds are not the repository's.
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "b.ttf"), "dependency font");
    return root;
  }
  const entry = (over = {}) =>
    JSON.stringify({
      files: { "a.woff2": { license: "OFL-1.1", licenseFile: "OFL.txt", sha256: sha, ...over } },
    });

  it("passes a listed OFL-1.1 font with its license text and hash", () => {
    const root = tree(entry());
    expect(findFontFiles(root)).toHaveLength(1);
    expect(checkFonts(root)).toEqual([]);
  });

  it("refuses an unlisted font, a copyleft font, a missing license text and a changed file", () => {
    expect(checkFonts(tree(undefined))[0]).toMatch(/not listed/);
    expect(checkFonts(tree("{"))[0]).toMatch(/can't be read/);
    expect(checkFonts(tree(entry({ license: "GPL-3.0" })))[0]).toMatch(/not allowed/);
    expect(checkFonts(tree(entry(), { license: false }))[0]).toMatch(/license text/);
    expect(checkFonts(tree(entry({ licenseFile: "../OFL.txt" })))[0]).toMatch(/license text/);
    expect(checkFonts(tree(entry({ sha256: "0".repeat(64) })))[0]).toMatch(/SHA-256/);
  });

  it("keeps OFL-1.1 out of the dependency rule", () => {
    expect(isAllowed("OFL-1.1")).toBe(false);
  });

  it("finds the admin's fonts in this repository, all passing", () => {
    const root = join(import.meta.dirname, "..");
    expect(findFontFiles(root).length).toBeGreaterThan(0);
    expect(checkFonts(root)).toEqual([]);
  });
});
