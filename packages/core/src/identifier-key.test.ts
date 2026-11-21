import { describe, expect, it } from "vitest";
import { identifierKey } from "./index.js";

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
