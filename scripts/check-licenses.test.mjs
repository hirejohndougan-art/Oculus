import { describe, expect, it } from "vitest";
import { isAllowed } from "./check-licenses.mjs";

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
