/**
 * Every example string in the Library of Congress EDTF specification
 * (https://www.loc.gov/standards/datetime/edtf.html, dated 4 February 2019),
 * read on 2026-11-21 for T-003a. Each must parse at the level the spec lists
 * it under (or a lower one: `2004-06-11%` appears under level 2 group
 * qualification but is already level 1), except exponential years and
 * significant digits, which D-008 leaves out on purpose.
 */
import { describe, expect, it } from "vitest";
import { parseEdtf } from "./edtf.js";

const LEVEL_0 = [
  // Date
  "1985-04-12",
  "1985-04",
  "1985",
  // Date and time
  "1985-04-12T23:20:30",
  "1985-04-12T23:20:30Z",
  "1985-04-12T23:20:30-04",
  "1985-04-12T23:20:30+04:30",
  // Time interval
  "1964/2008",
  "2004-06/2006-08",
  "2004-02-01/2005-02-08",
  "2004-02-01/2005-02",
  "2004-02-01/2005",
  "2005/2006-02",
];

const LEVEL_1 = [
  // Letter-prefixed calendar year
  "Y170000002",
  "Y-170000002",
  // Seasons
  "2001-21",
  // Qualification of a date (complete)
  "1984?",
  "2004-06~",
  "2004-06-11%",
  // Unspecified digit(s) from the right
  "201X",
  "20XX",
  "2004-XX",
  "1985-04-XX",
  "1985-XX-XX",
  // Extended interval: open and unknown ends
  "1985-04-12/..",
  "1985-04/..",
  "1985/..",
  "../1985-04-12",
  "../1985-04",
  "../1985",
  "1985-04-12/",
  "1985-04/",
  "1985/",
  "/1985-04-12",
  "/1985-04",
  "/1985",
  // Negative calendar year
  "-1985",
];

const LEVEL_2 = [
  // Sub-year groupings
  "2001-34",
  // Set representation
  "[1667,1668,1670..1672]",
  "[..1760-12-03]",
  "[1760-12..]",
  "[1760-01,1760-02,1760-12..]",
  "[1667,1760-12]",
  "[..1984]",
  "{1667,1668,1670..1672}",
  "{1960,1961-12}",
  "{..1984}",
  // Qualification: group, then individual component
  "2004-06-11%",
  "2004-06~-11",
  "2004?-06-11",
  "?2004-06-~11",
  "2004-%06-11",
  // Unspecified digit
  "156X-12-25",
  "15XX-12-25",
  "XXXX-12-XX",
  "1XXX-XX",
  "1XXX-12",
  "1984-1X",
  // Interval
  "2004-06-~01/2004-06-~20",
  "2004-06-XX/2004-07-03",
];

// Level 2 exponential years and significant digits (D-008: not for collections).
const LEFT_OUT = ["Y-17E7", "1950S2", "Y171010000S3", "Y3388E2S3"];

describe("EDTF spec examples (LoC 2019)", () => {
  it.each([
    ...LEVEL_0.map((s) => [s, 0] as const),
    ...LEVEL_1.map((s) => [s, 1] as const),
    ...LEVEL_2.map((s) => [s, 2] as const),
  ])("%s parses at level %i or lower", (text, level) => {
    const result = parseEdtf(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.edtf).toBe(text);
      expect(result.value.level).toBeLessThanOrEqual(level);
    }
  });

  it("puts examples at the spec's own level, not just any lower one", () => {
    const levelOf = (s: string) => {
      const r = parseEdtf(s);
      return r.ok ? r.value.level : undefined;
    };
    expect(LEVEL_0.map(levelOf)).toEqual(LEVEL_0.map(() => 0));
    expect(LEVEL_1.map(levelOf)).toEqual(LEVEL_1.map(() => 1));
    expect(LEVEL_2.filter((s) => s !== "2004-06-11%").map(levelOf)).toEqual(
      LEVEL_2.filter((s) => s !== "2004-06-11%").map(() => 2),
    );
  });

  it.each(LEFT_OUT)("%s is reported as unsupported", (text) => {
    const result = parseEdtf(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("unsupported");
  });

  it.each([
    // Group qualification: a qualifier applies to its part and those to its left.
    ["2004-06~-11", false, true],
    ["2004?-06-11", true, false],
    // Individual qualification: only the part it is in front of.
    ["?2004-06-~11", true, true],
    ["2004-%06-11", true, true],
  ] as const)("%s has the spec's meaning", (text, uncertain, approximate) => {
    const result = parseEdtf(text);
    expect(result.ok && result.value.uncertain).toBe(uncertain);
    expect(result.ok && result.value.approximate).toBe(approximate);
  });

  it("bounds the spec's level 2 interval example by its days", () => {
    const result = parseEdtf("2004-06-XX/2004-07-03");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.earliest).toEqual({ year: 2004, month: 6, day: 1 });
      expect(result.value.latest).toEqual({ year: 2004, month: 7, day: 3 });
    }
  });
});

describe("two suffix qualifiers (not among the spec's examples)", () => {
  it("is refused, with the same meaning written as prefixes", () => {
    const result = parseEdtf("2004?-06~-11");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("%2004-~06-11");
  });

  it("suggests a form that parses with the same flags", () => {
    const suggested = parseEdtf("%2004-~06-11");
    expect(suggested.ok && suggested.value.uncertain).toBe(true);
    expect(suggested.ok && suggested.value.approximate).toBe(true);
  });

  it("merges a prefix already on the part into the suggestion", () => {
    const result = parseEdtf("2004?-~06~-11");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("%2004-~06-11");
  });
});
