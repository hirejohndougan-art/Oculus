import { describe, expect, it } from "vitest";
import { identifierKey } from "./index.js";
import { hasTooManyMarks } from "./identifier-key.js";

const same = (a: string, b: string): boolean => identifierKey(a) === identifierKey(b);

describe("identifierKey", () => {
  it("ignores case", () => {
    expect(same("DHS-0001", "dhs-0001")).toBe(true);
    expect(same("STRASSE", "straße")).toBe(true);
  });

  it("ignores spaces of every kind", () => {
    expect(same("DHS-0001", "DHS - 0001")).toBe(true);
    expect(same("2026.015", "2026.\u00a0015")).toBe(true);
    expect(same("2026.015", "2026.\u3000015")).toBe(true);
  });

  it("folds full-width and other compatibility forms (NFKC)", () => {
    expect(same("DHS-0001", "ＤＨＳ－０００１")).toBe(true);
    expect(same("2026.015", "２０２６．０１５")).toBe(true);
    expect(same("No 5", "№ 5")).toBe(true);
  });

  it("composes accents, so typed and pasted forms meet", () => {
    expect(same("Č-1", "C\u030c-1")).toBe(true);
    expect(same("Č-1", "C-1")).toBe(false);
  });

  it("treats Cyrillic and Greek lookalikes as Latin", () => {
    expect(same("ABC-1", "АВС-1")).toBe(true); // Cyrillic А В С
    expect(same("TOP-1", "ΤΟΡ-1")).toBe(true); // Greek Τ Ο Ρ
    expect(same("box", "Ьox")).toBe(false); // Cyrillic soft sign doesn't look like b
  });

  it("maps capital and small forms to the Latin letter each looks like (review fix)", () => {
    expect(same("HAN-1", "ΗΑΝ-1")).toBe(true); // Greek capitals Η Α Ν
    expect(same("nav-1", "ηαν-1")).toBe(true); // Greek small η α ν look like n a v
    expect(same("nu-1", "пս-1")).toBe(true); // Cyrillic п, Armenian ս
    expect(same("ro-1", "гօ-1")).toBe(true); // Cyrillic г, Armenian օ
    expect(same("Ηη", "ΗΗ")).toBe(false); // the documented cost, inside Greek text
  });

  it("splits accented lookalikes before mapping, and keeps the accent (S-003)", () => {
    expect(same("Ö-1", "\u04e6-1")).toBe(true); // Cyrillic Ӧ
    expect(same("Ä-1", "\u04d2-1")).toBe(true); // Cyrillic Ӓ
    expect(same("Ă-1", "\u04d0-1")).toBe(true); // Cyrillic Ӑ
    expect(same("Ë-1", "\u0401-1")).toBe(true); // Cyrillic Ё, still
    expect(same("Á-1", "\u0386-1")).toBe(true); // Greek Ά
    expect(same("é-1", "\u03ad-1")).toBe(true); // Greek έ
    expect(same("ó-1", "\u03cc-1")).toBe(true); // Greek ό
    expect(same("Á-1", "\u0391\u0341-1")).toBe(true); // Greek Α + tone mark U+0341
    expect(same("Á-1", "A\u0301-1")).toBe(true);
    // The accent still counts: a lookalike with a mark is not the bare letter.
    expect(same("O-1", "\u04e6-1")).toBe(false);
    expect(same("A-1", "\u0386-1")).toBe(false);
    expect(same("Ö-1", "O-1")).toBe(false);
    expect(same("Ö-1", "Ó-1")).toBe(false);
  });

  it("maps lookalikes that have no Latin decomposition (S-003 review)", () => {
    expect(same("YÆƏƟV-1", "\u04ae\u04d4\u04d8\u04e8\u0474-1")).toBe(true);
    expect(same("yæəɵv-1", "\u04af\u04d5\u04d9\u04e9\u0475-1")).toBe(true);
    expect(same("ÇJ-1", "\u04aa\u037f-1")).toBe(true);
    expect(same("çj-1", "\u04ab\u03f3-1")).toBe(true);
    expect(same("ã-1", "\u1fb6-1")).toBe(true); // Greek ᾶ
    expect(same("DHS-1", "DHS\u16801")).toBe(true); // Ogham space mark draws a dash
    expect(same("DHS-1", "DHS 1")).toBe(false);
  });

  it("removes invisibles before composing accents (S-003 review)", () => {
    expect(same("Á-1", "A\u2800\u0301-1")).toBe(true);
    expect(same("Á-1", "A\u200d\u0301-1")).toBe(true);
    expect(same("Ä-1", "A\u00a8-1")).toBe(true); // NFKC gives space + diaeresis
    expect(same("\uac00", "\u1100\u1160\u1161")).toBe(true);
  });

  it("gives equivalent spellings with long runs of marks one key", () => {
    const long = "A".repeat(5000);
    expect(same(long, long.toLowerCase())).toBe(true);
    const marks = "a" + "\u0301".repeat(31);
    expect(same(marks, "A" + "\u0301".repeat(31))).toBe(true);
    expect(same(marks, "\u00e1" + "\u0301".repeat(30))).toBe(true);
    expect(same(marks, "a" + "\u0301".repeat(30))).toBe(false);
  });

  it("counts marks that only appear after decomposing (S-003 third review)", () => {
    // Half-width ﾞ (U+FF9E) is not a mark, but NFKD turns it into U+3099.
    const sneaky = "a" + "\u0301".repeat(8) + "\uff9e";
    expect(hasTooManyMarks(sneaky)).toBe(true);
    expect(identifierKey(sneaky).startsWith("\ufeff")).toBe(true); // the sorted-marks path
    expect(hasTooManyMarks("a" + "\u0301".repeat(7) + "\uff9e")).toBe(false);
    expect(same("ｶﾞ-1", "ガ-1")).toBe(true);
  });

  it("long runs that grow on decomposing stay linear (S-003 third review)", () => {
    const value = "a" + ("\u0301".repeat(8) + "\uff9e").repeat(20_000);
    const started = performance.now();
    identifierKey(value);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("U+0345 sorts with the other marks before case folding (S-003 third review)", () => {
    const acutes = "\u0301".repeat(9);
    expect(same(`\u03b1\u0345${acutes}-1`, `\u03b1${acutes}\u0345-1`)).toBe(true);
    expect(`\u03b1\u0345${acutes}`.normalize("NFD")).toBe(`\u03b1${acutes}\u0345`.normalize("NFD"));
  });

  it("treats blank-looking characters as spaces (S-003)", () => {
    for (const blank of [
      "\u2800",
      "\u{16FE4}",
      "\u{1D159}",
      "\u3164",
      "\u115f",
      "\u1160",
      "\uffa0",
    ]) {
      expect(same("DHS-0001", `DHS-${blank}0001`)).toBe(true);
    }
  });

  it("treats every dash and minus as a hyphen", () => {
    for (const dash of ["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"]) {
      expect(same("DHS-0001", `DHS${dash}0001`)).toBe(true);
    }
  });

  it("removes invisible characters", () => {
    expect(same("DHS-0001", "DHS-\u200d0001")).toBe(true);
    expect(same("DHS-0001", "DHS-\u00ad0001")).toBe(true);
    expect(same("DHS-0001", "DHS-0001\ufe0f")).toBe(true);
  });

  it("keeps digits and letters apart, and keeps punctuation", () => {
    expect(same("B0X-1", "BOX-1")).toBe(false);
    expect(same("A-11", "A-ll")).toBe(false);
    expect(same("2026.015", "2026015")).toBe(false);
    expect(same("2026.015", "2026-015")).toBe(false);
  });

  it("doesn't change what is given to it", () => {
    const value = "ＤＨＳ－０００１";
    identifierKey(value);
    expect(value).toBe("ＤＨＳ－０００１");
  });
});
