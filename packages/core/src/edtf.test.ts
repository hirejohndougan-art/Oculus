import { describe, expect, it } from "vitest";
import {
  MAX_EDTF_LENGTH,
  MAX_SET_MEMBERS,
  compareEdtf,
  dayKey,
  daysInMonth,
  isEdtf,
  parseEdtf,
  type CalendarDay,
  type EdtfDate,
} from "./edtf.js";

function ok(text: string): EdtfDate {
  const result = parseEdtf(text);
  if (!result.ok) throw new Error(`${text}: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function code(text: unknown): string | undefined {
  const result = parseEdtf(text);
  return result.ok ? undefined : result.issues[0]?.code;
}

const day = (s: string): CalendarDay => {
  const [year = NaN, month = NaN, d = NaN] = s.split("|").map(Number);
  return { year, month, day: d };
};

describe("level 0", () => {
  it.each([
    ["1985-04-12", "1985|4|12", "1985|4|12"],
    ["1985-04", "1985|4|1", "1985|4|30"],
    ["1985", "1985|1|1", "1985|12|31"],
    ["0000", "0|1|1", "0|12|31"],
    ["2000-02", "2000|2|1", "2000|2|29"],
    ["1900-02", "1900|2|1", "1900|2|28"],
  ])("%s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(0);
    expect(d.kind).toBe("date");
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
    expect(d.uncertain || d.approximate || d.unspecified).toBe(false);
  });

  it.each([
    "1985-04-12T23:20:30",
    "1985-04-12T23:20:30Z",
    "1985-04-12T23:20:30-04",
    "1985-04-12T23:20:30+04:30",
  ])("date-time %s", (text) => {
    const d = ok(text);
    expect(d.kind).toBe("datetime");
    expect(d.level).toBe(0);
    expect(d.earliest).toEqual(day("1985|4|12"));
    expect(d.sortKey).toBe(19850412);
  });

  it.each([
    ["1964/2008", "1964|1|1", "2008|12|31"],
    ["2004-06/2006-08", "2004|6|1", "2006|8|31"],
    ["2004-02-01/2005-02-08", "2004|2|1", "2005|2|8"],
    ["2004-02-01/2004-02-01", "2004|2|1", "2004|2|1"],
  ])("interval %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.kind).toBe("interval");
    expect(d.level).toBe(0);
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
  });
});

describe("level 1", () => {
  it("letter-prefixed years", () => {
    expect(ok("Y170000002")).toMatchObject({ level: 1, sortYear: 170000002 });
    expect(ok("Y-170000002")).toMatchObject({ level: 1, sortYear: -170000002 });
  });

  it("negative years", () => {
    const d = ok("-1985");
    expect(d.level).toBe(1);
    expect(d.earliest).toEqual(day("-1985|1|1"));
    expect(d.sortYear).toBe(-1985);
  });

  it.each([
    ["2001-21", "2001|3|1", "2001|5|31"],
    ["2001-22", "2001|6|1", "2001|8|31"],
    ["2001-23", "2001|9|1", "2001|11|30"],
    ["2001-24", "2001|1|1", "2002|2|28"],
    ["2003-24", "2003|1|1", "2004|2|29"],
  ])("season %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(1);
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
  });

  it.each([
    ["1984?", true, false],
    ["2004-06~", false, true],
    ["2004-06-11%", true, true],
  ])("qualified %s", (text, uncertain, approximate) => {
    const d = ok(text);
    expect(d.level).toBe(1);
    expect(d.uncertain).toBe(uncertain);
    expect(d.approximate).toBe(approximate);
  });

  it("does not widen approximate dates", () => {
    expect(ok("1920~").earliest).toEqual(day("1920|1|1"));
    expect(ok("1920~").latest).toEqual(day("1920|12|31"));
  });

  it.each([
    ["201X", "2010|1|1", "2019|12|31"],
    ["20XX", "2000|1|1", "2099|12|31"],
    ["2004-XX", "2004|1|1", "2004|12|31"],
    ["1985-04-XX", "1985|4|1", "1985|4|30"],
    ["1985-XX-XX", "1985|1|1", "1985|12|31"],
  ])("unspecified %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(1);
    expect(d.unspecified).toBe(true);
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
  });

  it.each([
    ["1985-04-12/..", "1985|4|12", null],
    ["1985-04-12/", "1985|4|12", null],
    ["../1985-04-12", null, "1985|4|12"],
    ["/1985-04-12", null, "1985|4|12"],
    ["1985-04/..", "1985|4|1", null],
    ["1984~/2004-06", "1984|1|1", "2004|6|30"],
    ["1984?/2004%", "1984|1|1", "2004|12|31"],
  ])("extended interval %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(1);
    expect(d.earliest).toEqual(earliest === null ? null : day(earliest));
    expect(d.latest).toEqual(latest === null ? null : day(latest));
  });

  it("sorts an open-start interval by its end", () => {
    const d = ok("../1950");
    expect(d.sortKey).toBe(19501231);
    expect(d.sortYear).toBe(1950);
  });
});

describe("level 2", () => {
  it.each([
    ["2004-06~-11", false, true],
    ["2004?-06-11", true, false],
    ["?2004-06-~11", true, true],
    ["2004-?06-11", true, false],
  ])("qualified part %s", (text, uncertain, approximate) => {
    const d = ok(text);
    expect(d.level).toBe(2);
    expect(d.uncertain).toBe(uncertain);
    expect(d.approximate).toBe(approximate);
    expect(d.earliest).toEqual(day("2004|6|11"));
  });

  it.each([
    ["156X-12-25", "1560|12|25", "1569|12|25"],
    ["15XX-12-25", "1500|12|25", "1599|12|25"],
    ["XXXX-12-XX", "0|12|1", "9999|12|31"],
    ["1XXX-XX", "1000|1|1", "1999|12|31"],
    ["1XXX-12", "1000|12|1", "1999|12|31"],
    ["1984-1X", "1984|10|1", "1984|12|31"],
    ["1985-XX-12", "1985|1|12", "1985|12|12"],
    ["1985-X2", "1985|2|1", "1985|12|31"],
    ["-1XXX", "-1999|1|1", "-1000|12|31"],
  ])("unspecified anywhere %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(2);
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
  });

  it("keeps a 29 February with unspecified years inside the bounds", () => {
    const d = ok("1XXX-02-29");
    expect(dayKey(d.earliest ?? day("0|0|0"))).toBeLessThanOrEqual(10040229);
    expect(dayKey(d.latest ?? day("0|0|0"))).toBeGreaterThanOrEqual(19960229);
  });

  it.each([
    ["2001-25", "2001|3|1", "2001|5|31"],
    ["2001-29", "2001|9|1", "2001|11|30"],
    ["2001-32", "2001|6|1", "2001|8|31"],
    ["2001-33", "2001|1|1", "2001|3|31"],
    ["2001-36", "2001|10|1", "2001|12|31"],
    ["2001-38", "2001|5|1", "2001|8|31"],
    ["2001-40", "2001|1|1", "2001|6|30"],
    ["2001-41", "2001|7|1", "2001|12|31"],
  ])("sub-year grouping %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.level).toBe(2);
    expect(d.earliest).toEqual(day(earliest));
    expect(d.latest).toEqual(day(latest));
  });

  it.each([
    ["[1667,1668,1670..1672]", "1667|1|1", "1672|12|31"],
    ["[..1760-12-03]", null, "1760|12|3"],
    ["[1760-12..]", "1760|12|1", null],
    ["[1667,1760-12]", "1667|1|1", "1760|12|31"],
    ["[..1984]", null, "1984|12|31"],
    ["{1667,1668,1670..1672}", "1667|1|1", "1672|12|31"],
    ["{1960,1961-12}", "1960|1|1", "1961|12|31"],
    ["{..1984}", null, "1984|12|31"],
    ["[1990,1985]", "1985|1|1", "1990|12|31"],
  ])("set %s", (text, earliest, latest) => {
    const d = ok(text);
    expect(d.kind).toBe("set");
    expect(d.level).toBe(2);
    expect(d.earliest).toEqual(earliest === null ? null : day(earliest));
    expect(d.latest).toEqual(latest === null ? null : day(latest));
  });

  it.each([
    ["2004-06-~01/2004-06-~20", 2],
    ["2004-06-XX/2004-07-03", 1],
  ])("interval of level 2 parts %s", (text, level) => {
    expect(ok(text).level).toBe(level);
  });
});

describe("rejects", () => {
  it.each([
    [42, "not_text"],
    [null, "not_text"],
    ["", "empty"],
    ["x".repeat(MAX_EDTF_LENGTH + 1), "too_long"],
    ["1985 ", "invalid_syntax"],
    ["about 1920", "invalid_syntax"],
    ["85", "invalid_syntax"],
    ["1985-4-12", "invalid_syntax"],
    ["19850412", "invalid_syntax"],
    ["1985-13", "invalid_month"],
    ["1985-00", "invalid_month"],
    ["1985-20", "invalid_month"],
    ["1985-42", "invalid_month"],
    ["1985-04-31", "invalid_day"],
    ["1985-02-29", "invalid_day"],
    ["1900-02-29", "invalid_day"],
    ["1985-04-00", "invalid_day"],
    ["1985-04-32", "invalid_day"],
    ["1985-02-3X", "invalid_day"],
    ["2001-21-05", "invalid_day"],
    ["-0000", "invalid_year"],
    ["Y1985", "invalid_year"],
    ["Y01700000", "invalid_year"],
    ["Y1700000000", "invalid_year"],
    ["Y170000002-01", "invalid_syntax"],
    ["Y-17E7", "unsupported"],
    ["1950S2", "unsupported"],
    ["1985-04-12T24:00:00", "invalid_time"],
    ["1985-04-12T23:60:00", "invalid_time"],
    ["1985-04-12T23:20:30+15:00", "invalid_time"],
    ["1985-04-31T10:00:00", "invalid_day"],
    ["1985-04-12T23:20", "invalid_syntax"],
    ["-1985-04-12T23:20:30", "invalid_syntax"],
    ["2008/1964", "interval_backwards"],
    ["1985/1990/1995", "invalid_interval"],
    ["/", "invalid_interval"],
    ["../..", "invalid_interval"],
    ["1985-04-12T10:00:00/1986", "invalid_interval"],
    ["[]", "invalid_set"],
    ["[1985", "invalid_set"],
    ["{1985]", "invalid_set"],
    ["[1985,,1986]", "invalid_set"],
    ["[1985,..1990]", "invalid_set"],
    ["[1985..,1990]", "invalid_set"],
    ["[..]", "invalid_set"],
    ["[1985/1990]", "invalid_set"],
    ["[1985...1990]", "invalid_set"],
    ["[1972..1970]", "range_backwards"],
    [`[${Array.from({ length: MAX_SET_MEMBERS + 1 }, () => "1985").join(",")}]`, "set_too_large"],
  ])("%j → %s", (text, expected) => {
    expect(code(text)).toBe(expected);
  });

  it("never throws, whatever the input", () => {
    const pieces = [
      "1985",
      "-",
      "X",
      "?",
      "~",
      "%",
      "/",
      "..",
      "[",
      "]",
      "{",
      "}",
      ",",
      "Y",
      "T",
      "0",
    ];
    for (let i = 0; i < 5000; i++) {
      let text = "";
      const n = 1 + (i % 12);
      for (let j = 0; j < n; j++) text += pieces[(i * 7 + j * 13 + j * j) % pieces.length] ?? "";
      expect(() => parseEdtf(text)).not.toThrow();
    }
  });

  it("handles long hostile input quickly", () => {
    const start = performance.now();
    for (const text of [
      "1".repeat(MAX_EDTF_LENGTH),
      "-".repeat(MAX_EDTF_LENGTH),
      "?".repeat(MAX_EDTF_LENGTH),
      `[${"..,".repeat(300)}]`,
      `1985${"-XX".repeat(300)}`,
    ]) {
      expect(parseEdtf(text).ok).toBe(false);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("helpers", () => {
  it("isEdtf", () => {
    expect(isEdtf("1985")).toBe(true);
    expect(isEdtf("circa 1985")).toBe(false);
  });

  it("daysInMonth follows the Gregorian leap rules", () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(0, 2)).toBe(29);
    expect(daysInMonth(-4, 2)).toBe(29);
    expect(daysInMonth(2023, 9)).toBe(30);
  });

  it("sort keys order dates correctly, including BCE years", () => {
    const texts = [
      "1985-04-12",
      "-1985",
      "1920~",
      "../1900",
      "195X",
      "Y170000002",
      "-1984-12",
      "1985",
      "0000",
    ];
    const sorted = texts
      .map(ok)
      .sort(compareEdtf)
      .map((d) => d.edtf);
    expect(sorted).toEqual([
      "-1985",
      "-1984-12",
      "0000",
      "../1900",
      "1920~",
      "195X",
      "1985",
      "1985-04-12",
      "Y170000002",
    ]);
  });

  it("puts the shorter date first when the starts match", () => {
    expect(compareEdtf(ok("1985-01-01"), ok("1985"))).toBeLessThan(0);
    expect(compareEdtf(ok("1985"), ok("1985/.."))).toBeLessThan(0);
    expect(compareEdtf(ok("1985"), ok("1985~"))).toBe(0);
  });

  it("returns frozen results", () => {
    expect(Object.isFrozen(ok("1985"))).toBe(true);
  });
});
