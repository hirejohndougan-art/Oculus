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
 *    other compatibility forms into their plain letters and digits, then NFD,
 *    which splits every accented letter into its base letter and combining
 *    marks (Cyrillic `Ӧ` becomes `О` + diaeresis, Greek `Ά` becomes `Α` +
 *    acute; the Greek tonos and the Latin acute are the same mark after NFD);
 * 2. turns Cyrillic, Greek and Armenian base letters that look like Latin
 *    letters into those Latin letters, and every kind of dash or minus into
 *    `-`; combining marks are kept, so `Ӧ` meets `Ö` and not `O`;
 * 3. folds case (upper, then lower, so `ß` and `SS` meet);
 * 4. recomposes (NFKC), so an accented letter typed as one character and as
 *    letter + mark meet, while `Č` and `C` stay different;
 * 5. removes all spaces, invisible (default-ignorable) characters and the
 *    few visible characters that draw nothing at all (`BLANK_CHARACTERS`).
 *
 * The key is deliberately conservative: it can make two different
 * identifiers compare equal (a Cyrillic small `в`, shaped like a small
 * capital B, meets a Latin `b`), but it should
 * never let two identifiers that look the same compare different. For a
 * uniqueness check or a search, a false "same" is a question for a person; a
 * false "different" is a duplicate number nobody notices. Digits and letters
 * are not folded into each other (`0` and `O`, `1` and `l` stay different),
 * because real numbering schemes use both.
 */

/**
 * Cyrillic, Greek and Armenian letters that look like a Latin letter, and that
 * letter. Applied before case folding, with capital and small forms listed
 * separately, because they can look like different Latin letters (Greek `Η`
 * looks like `H`, small `η` like `n`). The cost: inside Greek or Cyrillic text,
 * such a capital and its small form no longer compare equal. Only base
 * letters are listed: accented forms (`Ё`, `Ӧ`, `Ά`, `έ` …) are split by NFD
 * first and reach this table as base letter + mark.
 */
const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ["А", "A"],
  ["В", "B"],
  ["Е", "E"],
  ["К", "K"],
  ["М", "M"],
  ["Н", "H"],
  ["О", "O"],
  ["Р", "P"],
  ["С", "C"],
  ["Т", "T"],
  ["У", "Y"],
  ["Х", "X"],
  ["Ѕ", "S"],
  ["І", "I"],
  ["Ј", "J"],
  ["Һ", "H"],
  ["Ԛ", "Q"],
  ["Ԝ", "W"],
  ["Ӏ", "I"],
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
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
  ["ј", "j"],
  ["ԁ", "d"],
  ["һ", "h"],
  ["ԛ", "q"],
  ["ԝ", "w"],
  ["ӏ", "l"],
  ["п", "n"],
  ["г", "r"],
  ["Α", "A"],
  ["Β", "B"],
  ["Ε", "E"],
  ["Ζ", "Z"],
  ["Η", "H"],
  ["Ι", "I"],
  ["Κ", "K"],
  ["Μ", "M"],
  ["Ν", "N"],
  ["Ο", "O"],
  ["Ρ", "P"],
  ["Τ", "T"],
  ["Υ", "Y"],
  ["Χ", "X"],
  ["Ϲ", "C"],
  ["α", "a"],
  ["ε", "e"],
  ["ι", "i"],
  ["κ", "k"],
  ["ν", "v"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  ["η", "n"],
  ["ϲ", "c"],
  ["օ", "o"],
  ["ս", "u"],
  ["հ", "h"],
  ["ո", "n"],
  ["ց", "g"],
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

/**
 * Visible characters that draw nothing, are not spaces to `\s` and are not
 * default-ignorable: U+2800 BRAILLE PATTERN BLANK, U+16FE4 KHITAN SMALL SCRIPT
 * FILLER and U+1D159 MUSICAL SYMBOL NULL NOTEHEAD. The key treats them as
 * spaces (removed), and `identifiers.ts` refuses them in stored values like
 * invisible characters. The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0)
 * need no entry: they are default-ignorable already. Written as regex
 * alternatives, not a character class, because U+16FE4 is a combining mark.
 */
export const BLANK_CHARACTERS = String.raw`\u2800|\u{16FE4}|\u{1D159}`;

const ANY_CHAR = /./gsu;
const SPACE_OR_INVISIBLE = new RegExp(
  `(?:[\\s\\p{Default_Ignorable_Code_Point}]|${BLANK_CHARACTERS})+`,
  "gu",
);

/**
 * The comparison key for an identifier. Equal keys mean "treat as the same
 * identifier". Never shown to people and never stored as the identifier.
 */
export function identifierKey(value: string): string {
  // Every step is a single pass over the text, so the key stays linear-time.
  const split = value.normalize("NFKC").normalize("NFD");
  const mapped = split.replace(ANY_CHAR, (ch) => LOOKALIKES.get(ch) ?? ch);
  const folded = mapped.toUpperCase().toLowerCase();
  return folded.normalize("NFKC").replace(SPACE_OR_INVISIBLE, "");
}
