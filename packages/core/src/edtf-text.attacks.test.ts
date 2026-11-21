import { describe, expect, it } from "vitest";
import { edtfFromText } from "./edtf-text.js";

/** What a call comes to: the EDTF it gives, or the first issue code. */
function outcome(text: string): string {
  const result = edtfFromText(text);
  return result.ok ? `edtf ${result.value.edtf}` : `issue ${result.issues[0]?.code ?? "?"}`;
}

// Every dash-like character a cataloger, a word processor or a pasted web page
// can put where "-" belongs.
const DASHES: readonly (readonly [string, string])[] = [
  ["hyphen U+2010", "‐"],
  ["non-breaking hyphen U+2011", "‑"],
  ["figure dash U+2012", "‒"],
  ["en dash U+2013", "–"],
  ["em dash U+2014", "—"],
  ["horizontal bar U+2015", "―"],
  ["hyphen bullet U+2043", "⁃"],
  ["minus sign U+2212", "−"],
  ["small em dash U+FE58", "﹘"],
  ["small hyphen-minus U+FE63", "﹣"],
  ["full-width hyphen-minus U+FF0D", "－"],
];

// Every ASCII case from edtf-text.test.ts that has a dash: the two-way forms
// it must flag, and the forms it reads.
const ASCII_CASES = [
  // Flagged
  "1925-20",
  "1920-25",
  "1920-21",
  "ca. 1920-25",
  "c. 1920-21",
  "probably 1920-22",
  "ca. 1920-25?",
  "1920-25.",
  "1920-25?",
  "1920-1925?",
  "1920 - 1925 ?",
  "ca. 1920-1925?",
  "1920s-1930s?",
  "1920-21~",
  "1901-12",
  "1901-05",
  "1905-08",
  "-1920",
  "- 1920",
  "1925-1920",
  // Read
  "1985-04-12",
  "1920-1925",
  "1920 - 1925",
  "1920-45",
  "1920 - 25",
  "1920s-1930s",
  "1920-06 to 1921-05",
  "1985-04-12 - 1985-05-01",
  "1920-12-25 to 1921",
  "mid-1950s to late 1960s",
  "mid-1950s",
  "1920-06",
  "1920-06~",
  "1920-06/1921-05",
  "ca. 1920-1925",
  "probably 1920-1925",
  "06-05-1920",
];

describe("edtfFromText with dashes other than ASCII '-' (S-004)", () => {
  it.each(["1920–25", "1920—25", "1901–05", "ca. 1920–25", "1920−25", "1920－25", "−1920"])(
    "flags %j as ambiguous instead of reading a season or month",
    (text) => {
      expect(outcome(text)).toBe("issue ambiguous");
    },
  );

  for (const [name, dash] of DASHES) {
    it.each(ASCII_CASES)(`%j with the ${name} gives the same result as with "-"`, (ascii) => {
      const variant = ascii.replaceAll("-", dash);
      expect(variant).not.toBe(ascii);
      expect(outcome(variant)).toBe(outcome(ascii));
    });
  }

  it("never stores a non-ASCII dash in the EDTF", () => {
    for (const [, dash] of DASHES) {
      const result = edtfFromText(`1985${dash}04${dash}12`);
      expect(result.ok && result.value.edtf).toBe("1985-04-12");
    }
  });

  it.each(["１９２０-25", "１９２０", "١٩٢٠-25"])(
    "does not read non-ASCII digits in %j as a date",
    (text) => {
      expect(edtfFromText(text).ok).toBe(false);
    },
  );
});
