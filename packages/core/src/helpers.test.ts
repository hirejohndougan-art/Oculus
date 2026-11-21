// Direct tests for small public helpers that were only used indirectly by
// other tests: the kind and level guards, isLeapYear and
// patternMismatchMessage.
import { describe, expect, it } from "vitest";
import {
  ARCHIVAL_LEVELS,
  FIELD_KINDS,
  PATTERN_HELP,
  RECORD_KINDS,
  isArchivalLevel,
  isFieldKind,
  isLeapYear,
  isRecordKind,
  parseIdentifierPattern,
} from "./index.js";
import { patternMismatchMessage } from "./identifier-pattern.js";

const NOT_NAMES: unknown[] = [
  "",
  "Object",
  " item",
  "item ",
  "toString",
  "__proto__",
  null,
  undefined,
  0,
  {},
  ["object"],
];

describe("isRecordKind", () => {
  it.each([...RECORD_KINDS])("accepts %s", (kind) => {
    expect(isRecordKind(kind)).toBe(true);
  });
  it.each(NOT_NAMES)("refuses %j", (value) => {
    expect(isRecordKind(value)).toBe(false);
  });
  it("refuses an archival level", () => {
    expect(isRecordKind("fonds")).toBe(false);
  });
});

describe("isArchivalLevel", () => {
  it.each([...ARCHIVAL_LEVELS])("accepts %s", (level) => {
    expect(isArchivalLevel(level)).toBe(true);
  });
  it.each(NOT_NAMES)("refuses %j", (value) => {
    expect(isArchivalLevel(value)).toBe(false);
  });
  it("refuses a record kind", () => {
    expect(isArchivalLevel("object")).toBe(false);
  });
});

describe("isFieldKind", () => {
  it.each([...FIELD_KINDS])("accepts %s", (kind) => {
    expect(isFieldKind(kind)).toBe(true);
  });
  it.each(NOT_NAMES)("refuses %j", (value) => {
    expect(isFieldKind(value)).toBe(false);
  });
  it("refuses near misses", () => {
    expect(isFieldKind("longtext")).toBe(false);
    expect(isFieldKind("TEXT")).toBe(false);
  });
});

describe("isLeapYear", () => {
  it.each([
    [2024, true],
    [2000, true],
    [1600, true],
    [0, true],
    [-4, true],
    [-400, true],
    [2023, false],
    [1900, false],
    [2100, false],
    [-100, false],
    [1, false],
  ])("%i → %s", (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe("patternMismatchMessage", () => {
  function pattern(source: string) {
    const result = parseIdentifierPattern(source);
    if (!result.ok) throw new Error(`bad test pattern ${source}`);
    return result.value;
  }

  it("names the value and the format, then gives the format help", () => {
    expect(patternMismatchMessage(pattern("DHS-####"), "DHS-12")).toBe(
      `"DHS-12" doesn't match the format "DHS-####". ${PATTERN_HELP}`,
    );
  });

  it("escapes invisible and direction-changing characters in the value", () => {
    const message = patternMismatchMessage(pattern("####"), "12‮34");
    expect(message).toContain("\\u202e");
    expect(message).not.toContain("‮");
  });

  it("shortens a very long value", () => {
    const message = patternMismatchMessage(pattern("####"), "9".repeat(500));
    expect(message.length).toBeLessThan(200);
    expect(message).toContain("…");
  });
});
