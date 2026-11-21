import { describe, expect, it } from "vitest";
import {
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_SLOTS,
  matchesIdentifierPattern,
  parseIdentifierPattern,
  type IdentifierPattern,
} from "./index.js";

function compile(source: string): IdentifierPattern {
  const result = parseIdentifierPattern(source);
  if (!result.ok) throw new Error(`${source}: ${result.issues.map((i) => i.code).join(", ")}`);
  return result.value;
}

function code(source: unknown): string | undefined {
  const result = parseIdentifierPattern(source);
  return result.ok ? undefined : result.issues[0]?.code;
}

describe("parseIdentifierPattern", () => {
  it("compiles a format and reports its length range", () => {
    const p = compile("DHS-####");
    expect(p.source).toBe("DHS-####");
    expect(p.minLength).toBe(8);
    expect(p.maxLength).toBe(8);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.slots)).toBe(true);
  });

  it("expands {n} and {n,m}", () => {
    const p = compile("#{4}.#{3,5}");
    expect(p.minLength).toBe(8);
    expect(p.maxLength).toBe(10);
  });

  it.each<[unknown, string]>([
    [42, "not_text"],
    ["", "empty"],
    ["#".repeat(MAX_PATTERN_LENGTH + 1), "too_long"],
    [" ###", "untrimmed"],
    ["###\n", "bad_characters"],
    ["A\tB", "bad_characters"],
    ["A\u202eB", "bad_characters"],
    ["A\u00adB", "bad_characters"],
    ["A\u2800B", "bad_characters"], // Braille blank (S-003)
    [`A${"\u0301".repeat(9)}B`, "bad_characters"], // too many marks (S-003)
    ["{3}", "invalid_repeat"],
    ["#{3", "invalid_repeat"],
    ["#}", "invalid_repeat"],
    ["#{a}", "invalid_repeat"],
    ["#{ 3}", "invalid_repeat"],
    ["#{5,2}", "invalid_repeat"],
    ["#{0}", "invalid_repeat"],
    ["#{101}", "invalid_repeat"],
    ["#{2}{3}", "invalid_repeat"],
    ["A\\", "invalid_escape"],
    ["#{0,3}", "matches_nothing"],
    ["#{100}#{100}#", "too_complex"],
  ])("refuses %j (%s)", (source, expected) => {
    expect(code(source)).toBe(expected);
  });

  it("allows exactly the slot limit", () => {
    expect(compile("#{100}@{100}").maxLength).toBe(MAX_PATTERN_SLOTS);
  });

  it("never throws, even for odd input", () => {
    for (const input of [null, undefined, {}, [], Symbol("x"), () => 1]) {
      expect(() => parseIdentifierPattern(input)).not.toThrow();
      expect(parseIdentifierPattern(input).ok).toBe(false);
    }
  });
});

describe("matchesIdentifierPattern", () => {
  it.each<[string, string, boolean]>([
    ["DHS-####", "DHS-0001", true],
    ["DHS-####", "DHS-001", false],
    ["DHS-####", "DHS-00012", false],
    ["DHS-####", "dhs-0001", false],
    ["DHS-####", "DHS-00a1", false],
    ["####.###", "2026.015", true],
    ["####.###", "2026-015", false],
    ["#{4}.#{1,4}", "2026.1", true],
    ["#{4}.#{1,4}", "2026.1234", true],
    ["#{4}.#{1,4}", "2026.12345", false],
    ["#{4}.#{1,4}", "2026.", false],
    ["@@-#", "Ab-3", true],
    ["@@-#", "A1-3", false],
    ["***", "a1Z", true],
    ["***", "a-Z", false],
    ["A-{0,1}#", "A1", true],
    ["A-{0,1}#", "A-1", true],
    ["A-{0,1}#", "A--1", false],
    ["\\#\\{#\\}", "#{5}", true],
    ["Box #{1,3}", "Box 12", true],
    ["Box #{1,3}", "Box12", false],
    ["Č-#", "Č-1", true],
    ["😀#", "😀1", true],
    // A class must not swallow what a later literal needs (no greedy trap).
    ["*{1,5}#", "AB12", true],
    ["#{1,3}#{1,3}", "1234", true],
    ["#{1,3}1", "111", true],
  ])("%s on %j is %s", (source, value, expected) => {
    expect(matchesIdentifierPattern(compile(source), value)).toBe(expected);
  });

  it("refuses lookalike digits and letters: classes are ASCII only", () => {
    const p = compile("@@-##");
    expect(matchesIdentifierPattern(p, "AB-12")).toBe(true);
    expect(matchesIdentifierPattern(p, "ＡＢ-12")).toBe(false); // full-width letters
    expect(matchesIdentifierPattern(p, "AB-١٢")).toBe(false); // Arabic-Indic digits
    expect(matchesIdentifierPattern(p, "АВ-12")).toBe(false); // Cyrillic А and В
  });

  it("compares accented letters in composed form (review fix)", () => {
    const composed = compile("\u00c9-#");
    const decomposed = compile("E\u0301-#");
    for (const p of [composed, decomposed]) {
      expect(matchesIdentifierPattern(p, "\u00c9-1")).toBe(true);
      expect(matchesIdentifierPattern(p, "E\u0301-1")).toBe(true);
    }
    expect(decomposed.source).toBe("E\u0301-#");
  });

  it("refuses non-text values", () => {
    expect(matchesIdentifierPattern(compile("#"), 1 as unknown as string)).toBe(false);
  });
});

describe("attacks: formats can't make matching slow", () => {
  it("handles the classic ReDoS shapes in linear time", () => {
    // As regexes, (a+)+b, (a|a)*b or a?{n}a{n} take exponential time on
    // "aaaa\u2026c". Here the closest formats are bounded and checked without
    // backtracking.
    const patterns = [
      compile("*{1,100}*{1,99}#"),
      compile("@{0,100}@{1,99}!"),
      compile("a{0,100}a{1,99}"),
    ];
    const hostile = "a".repeat(199) + "!";
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) {
      for (const p of patterns) matchesIdentifierPattern(p, hostile);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses very long values before looking at them", () => {
    const p = compile("*{1,100}");
    const started = performance.now();
    expect(matchesIdentifierPattern(p, "a".repeat(10_000_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("treats regex syntax as plain characters", () => {
    const p = compile("(a+)+$");
    expect(matchesIdentifierPattern(p, "(a+)+$")).toBe(true);
    expect(matchesIdentifierPattern(p, "aaa")).toBe(false);
    expect(matchesIdentifierPattern(compile(".+"), "anything")).toBe(false);
    expect(matchesIdentifierPattern(compile(".+"), ".+")).toBe(true);
  });
});

describe("D-019's two organizations' numbers", () => {
  it("covers the archives' DS5C740001 and the library's unpadded DPL1, DPL2, DPL3", () => {
    const archive = parseIdentifierPattern("DS5C74####");
    const library = parseIdentifierPattern("DPL#{1,9}");
    if (!archive.ok || !library.ok) throw new Error("pattern refused");
    expect(matchesIdentifierPattern(archive.value, "DS5C740001")).toBe(true);
    expect(matchesIdentifierPattern(archive.value, "DS5C74001")).toBe(false);
    for (const value of ["DPL1", "DPL2", "DPL3", "DPL123456789"]) {
      expect(matchesIdentifierPattern(library.value, value)).toBe(true);
    }
    expect(matchesIdentifierPattern(library.value, "DPL")).toBe(false);
    expect(matchesIdentifierPattern(library.value, "DPL1234567890")).toBe(false);
  });
});
