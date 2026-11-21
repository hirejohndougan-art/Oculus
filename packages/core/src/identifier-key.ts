/**
 * Comparing identifiers (decision D-009).
 *
 * People type the same number in different ways: `dhs-0001`, `DHS 0001`,
 * a full-width `ＤＨＳ－０００１` pasted from a PDF, or a Cyrillic `С` that looks
 * exactly like a Latin `C`. Stored identifiers are never changed; instead
 * `identifierKey` makes a comparison key, and two identifiers are "the same"
 * when their keys are equal. The key:
 *
 * 1. applies Unicode NFKC, which turns full-width, superscript, ligature and
 *    other compatibility forms into their plain letters and digits;
 * 2. folds case (upper, then lower, so `ß` and `SS` meet);
 * 3. turns Cyrillic and Greek letters that look like Latin letters into those
 *    Latin letters, and every kind of dash or minus into `-`;
 * 4. removes all spaces and invisible (default-ignorable) characters.
 *
 * The key is deliberately conservative: it can make two different
 * identifiers compare equal (a Cyrillic `в` meets a Latin `b`), but it should
 * never let two identifiers that look the same compare different. For a
 * uniqueness check or a search, a false "same" is a question for a person; a
 * false "different" is a duplicate number nobody notices. Digits and letters
 * are not folded into each other (`0` and `O`, `1` and `l` stay different),
 * because real numbering schemes use both.
 */

/** Lowercase Cyrillic and Greek letters (after case folding) and the Latin letter they look like. */
const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  // Cyrillic, lower case forms of letters that look Latin in either case
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
  ["ё", "ë"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["ѕ", "s"],
  ["і", "i"],
  ["ї", "ï"],
  ["ј", "j"],
  ["ԁ", "d"],
  ["һ", "h"],
  ["ԛ", "q"],
  ["ԝ", "w"],
  ["ӏ", "l"],
  // Greek
  ["α", "a"],
  ["β", "b"],
  ["ε", "e"],
  ["ζ", "z"],
  ["η", "h"],
  ["ι", "i"],
  ["κ", "k"],
  ["μ", "m"],
  ["ν", "n"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "y"],
  ["χ", "x"],
  // Latin dotless i
  ["ı", "i"],
  // Dashes and minus signs (full-width and small forms are handled by NFKC)
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2043", "-"],
  ["\u2212", "-"],
]);

const ANY_CHAR = /./gsu;
const SPACE_OR_INVISIBLE = /[\s\p{Default_Ignorable_Code_Point}]+/gu;

/**
 * The comparison key for an identifier. Equal keys mean "treat as the same
 * identifier". Never shown to people and never stored as the identifier.
 */
export function identifierKey(value: string): string {
  const folded = value.normalize("NFKC").toUpperCase().toLowerCase();
  const mapped = folded.replace(ANY_CHAR, (ch) => LOOKALIKES.get(ch) ?? ch);
  return mapped.normalize("NFKC").replace(SPACE_OR_INVISIBLE, "");
}
