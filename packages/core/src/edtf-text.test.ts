import { describe, expect, it } from "vitest";
import { MAX_DATE_TEXT_LENGTH, edtfFromText, type EdtfFromTextOptions } from "./edtf-text.js";

function read(text: string, options?: EdtfFromTextOptions): { edtf: string; note?: string } {
  const result = edtfFromText(text, options);
  if (!result.ok) throw new Error(`${text}: ${JSON.stringify(result.issues)}`);
  const { edtf, note } = result.value;
  return note === undefined ? { edtf } : { edtf, note };
}

function code(text: unknown, options?: EdtfFromTextOptions): string | undefined {
  const result = edtfFromText(text, options);
  return result.ok ? undefined : result.issues[0]?.code;
}

describe("edtfFromText", () => {
  it.each([
    ["1920", "1920"],
    ["1985-04-12", "1985-04-12"],
    ["  1920~ ", "1920~"],
    ["[1667,1668]", "[1667,1668]"],
  ])("keeps valid EDTF %j", (text, edtf) => {
    expect(read(text)).toEqual({ edtf });
  });

  it.each([
    ["about 1920", "1920~"],
    ["About 1920", "1920~"],
    ["circa 1920", "1920~"],
    ["ca. 1920", "1920~"],
    ["ca 1920", "1920~"],
    ["c. 1920", "1920~"],
    ["c1920", "1920~"],
    ["approx. 1920", "1920~"],
    ["1920?", "1920?"],
    ["probably 1920", "1920?"],
    ["ca. 1920?", "1920%"],
    ["about June 1920", "1920-06~"],
  ])("qualifies %j", (text, edtf) => {
    expect(read(text).edtf).toBe(edtf);
  });

  it.each([
    ["1950s", "195X"],
    ["1950's", "195X"],
    ["the 1950s", "195X"],
    ["ca. 1950s", "195X~"],
  ])("decade %j", (text, edtf) => {
    expect(read(text)).toEqual({ edtf });
  });

  it.each([
    ["late 1920s", "192X"],
    ["early 1920s", "192X"],
    ["mid-1950s", "195X"],
    ["mid 1950s", "195X"],
  ])("part of a decade %j keeps a note", (text, edtf) => {
    const result = read(text);
    expect(result.edtf).toBe(edtf);
    expect(result.note).toContain(text);
  });

  it.each([
    ["19th century", "18XX"],
    ["20th century", "19XX"],
    ["early 20th century", "19XX"],
    ["1st century", "00XX"],
  ])("century %j", (text, edtf) => {
    const result = read(text);
    expect(result.edtf).toBe(edtf);
    expect(result.note).toContain(text);
  });

  it.each([
    ["June 1920", "1920-06"],
    ["Jun. 1920", "1920-06"],
    ["Sept 1920", "1920-09"],
    ["June 5, 1920", "1920-06-05"],
    ["June 5th, 1920", "1920-06-05"],
    ["5 June 1920", "1920-06-05"],
    ["5th of June 1920", "1920-06-05"],
    ["spring 1920", "1920-21"],
    ["Fall of 1920", "1920-23"],
    ["winter, 1920", "1920-24"],
  ])("named month or season %j", (text, edtf) => {
    expect(read(text)).toEqual({ edtf });
  });

  it.each([
    ["13/5/1920", undefined, "1920-05-13"],
    ["5/13/1920", undefined, "1920-05-13"],
    ["5/5/1920", undefined, "1920-05-05"],
    ["6/5/1920", { numericOrder: "month-day-year" }, "1920-06-05"],
    ["6/5/1920", { numericOrder: "day-month-year" }, "1920-05-06"],
    ["06-05-1920", { numericOrder: "month-day-year" }, "1920-06-05"],
    ["6.5.1920", { numericOrder: "day-month-year" }, "1920-05-06"],
  ] as const)("numeric %j", (text, options, edtf) => {
    expect(read(text, options).edtf).toBe(edtf);
  });

  it.each([
    ["1920-1925", "1920/1925"],
    ["1920 - 1925", "1920/1925"],
    ["1920–1925", "1920/1925"],
    ["1920 to 1925", "1920/1925"],
    ["between 1920 and 1925", "1920/1925"],
    ["from June 1920 to May 1921", "1920-06/1921-05"],
    ["1920-45", "1920/1945"],
    ["1920 - 25", "1920/1925"],
    ["1920s-1930s", "192X/193X"],
    ["ca. 1920-1925", "1920~/1925~"],
  ])("range %j", (text, edtf) => {
    expect(read(text).edtf).toBe(edtf);
  });

  it.each([
    ["1900s", "ambiguous"],
    ["1800s", "ambiguous"],
    ["'50s", "ambiguous"],
    ["the fifties", "ambiguous"],
    ["6/5/1920", "ambiguous"],
    ["1925-20", "ambiguous"],
    ["1920-25", "ambiguous"],
    ["1920-21", "ambiguous"],
    ["undated", "undated"],
    ["n.d.", "undated"],
    ["Unknown", "undated"],
    ["before 1920", "unreadable"],
    ["after 1920", "unreadable"],
    ["Christmas 1920", "unreadable"],
    ["constructor 1920", "unreadable"],
    ["__proto__ 5, 1920", "unreadable"],
    ["cat 1920", "unreadable"],
    ["June 31, 1920", "invalid_day"],
    ["13/13/1920", "invalid_month"],
    ["1925-1920", "interval_backwards"],
    ["", "empty"],
    ["   ", "empty"],
    [42, "not_text"],
    ["1".repeat(MAX_DATE_TEXT_LENGTH + 1), "too_long"],
  ])("flags %j as %s", (text, expected) => {
    expect(code(text)).toBe(expected);
  });

  it("returns the parsed date with sort fields", () => {
    const result = edtfFromText("about 1920");
    expect(result.ok && result.value.date.sortYear).toBe(1920);
    expect(result.ok && result.value.date.approximate).toBe(true);
  });

  it("shows hostile text safely in messages", () => {
    const result = edtfFromText("‮June 1920 to Smarch 1921");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.issues[0]?.message ?? "";
      expect(message).not.toContain("‮");
    }
  });

  it("never throws and stays fast on long hostile text", () => {
    const start = performance.now();
    for (const text of [
      "-".repeat(MAX_DATE_TEXT_LENGTH),
      " - ".repeat(66),
      "1920 to ".repeat(25),
      "between ".repeat(25),
      "ca. ".repeat(50),
      "1".repeat(MAX_DATE_TEXT_LENGTH),
    ]) {
      expect(() => edtfFromText(text)).not.toThrow();
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});
