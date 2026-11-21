/**
 * Comparing identifiers (decision D-009).
 *
 * People type the same number in different ways: `dhs-0001`, `DHS 0001`,
 * a full-width `ＤＨＳ－０００１` pasted from a PDF, or a Cyrillic `С` that looks
 * exactly like a Latin `C`. Stored identifiers are never changed; instead
 * `identifierKey` makes a comparison key, and two identifiers are "the same"
 * when their keys are equal. The key:
 *
 * 1. removes all spaces, invisible (default-ignorable) characters and the
 *    few visible characters that draw nothing at all (`BLANK_CHARACTERS`),
 *    first, so one between a letter and its accent can't keep them apart
 *    (the Ogham space mark, which draws a dash, becomes `-` instead);
 * 2. applies Unicode NFKC, which turns full-width, superscript, ligature and
 *    other compatibility forms into their plain letters and digits, then NFD,
 *    which splits every accented letter into its base letter and combining
 *    marks (Cyrillic `Ӧ` becomes `О` + diaeresis, Greek `Ά` becomes `Α` +
 *    acute; the Greek tonos and the Latin acute are the same mark after NFD);
 * 3. turns Cyrillic, Greek and Armenian base letters that look like Latin
 *    letters into those Latin letters, the Greek perispomeni into a tilde,
 *    and every kind of dash or minus into `-`; other combining marks are
 *    kept, so `Ӧ` meets `Ö` and not `O`;
 * 4. folds case (upper, then lower, so `ß` and `SS` meet);
 * 5. recomposes (NFKC), so an accented letter typed as one character and as
 *    letter + mark meet, while `Č` and `C` stay different, and removes the
 *    spaces and invisible characters NFKC itself may have produced.
 *
 * Cost: Unicode normalization sorts each run of combining marks, which takes
 * time growing with the square of the run's length. So the key first splits
 * every character on its own (NFKD, one character at a time, which needs no
 * sorting) and measures the runs of marks. Canonically equivalent spellings
 * (`Ö` + marks, `O` + diaeresis + marks, the same marks in another order)
 * always give the same runs. Text with a run of more than `MAX_MARK_RUN`
 * marks skips steps 2 and 5: its marks are sorted by code point instead, so
 * equivalent spellings still meet, and the key costs time in proportion to
 * the text's length. `identifiers.ts` refuses such runs in stored values,
 * prefixes and formats, so only queries and old data take that path.
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
  ["Ү", "Y"],
  ["ү", "y"],
  ["Ӕ", "Æ"],
  ["ӕ", "æ"],
  ["Ә", "Ə"],
  ["ә", "ə"],
  ["Ө", "Ɵ"],
  ["ө", "ɵ"],
  ["Ѵ", "V"],
  ["ѵ", "v"],
  ["Ҫ", "Ç"],
  ["ҫ", "ç"],
  ["Ϳ", "J"],
  ["ϳ", "j"],
  // The Greek perispomeni (in `ᾶ`) is drawn as a tilde in most fonts.
  ["\u0342", "\u0303"],
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

/**
 * The most combining marks one letter may carry, counted after splitting
 * accented letters (`ǘ` is u + two marks). Real identifiers use one or two.
 */
export const MAX_MARK_RUN = 8;
const MARK_RUN = /\p{M}+/gu;
const LOW_SURROGATES = /[\uDC00-\uDFFF]/g;

/** The number of code points: UTF-16 length less the trailing surrogates. */
function codePoints(text: string): number {
  return text.length - (text.match(LOW_SURROGATES)?.length ?? 0);
}

/** Whether the text has more than `MAX_MARK_RUN` marks in a row. One pass. */
function hasLongRun(text: string): boolean {
  for (const run of text.matchAll(MARK_RUN)) {
    if (run[0].length > MAX_MARK_RUN && codePoints(run[0]) > MAX_MARK_RUN) return true;
  }
  return false;
}

/**
 * The text with spaces, invisibles and blanks removed and every character
 * decomposed on its own (NFKD), and whether it has a run of more than
 * `MAX_MARK_RUN` marks. This is NFKD except that marks are not yet put in
 * canonical order, the step that can be slow; so the answer is the same for
 * every canonically equivalent spelling, and the work is linear. Decomposing
 * the whole text at once is not safe: characters that are not marks can
 * decompose into marks (half-width `ﾞ` U+FF9E becomes U+3099) and so build a
 * long run no check on the text before decomposing would see.
 */
function decompose(value: string): { readonly text: string; readonly long: boolean } {
  const visible = value.replace(OGHAM_SPACE, "-").replace(SPACE_OR_INVISIBLE, "");
  const split = visible.replace(NOT_ASCII, (ch) => ch.normalize("NFKD"));
  // NFKD can give a space before a mark (U+00A8 is space + diaeresis): those go too.
  const text = split.replace(SPACE_OR_INVISIBLE, "");
  return { text, long: hasLongRun(text) };
}

/**
 * Whether some letter in the text carries more than `MAX_MARK_RUN` combining
 * marks, counted the way `identifierKey` counts them. Linear time.
 */
export function hasTooManyMarks(value: string): boolean {
  return decompose(value).long;
}

/**
 * Starts the key of text with an over-long run of marks. Other keys never
 * contain U+FEFF, which is default-ignorable and so always removed.
 */
const SORTED_MARKS = "\ufeff";

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const ANY_CHAR = /./gsu;
/** Printable ASCII is already decomposed; the rest is split one character at a time. */
const NOT_ASCII = /[^ -~]/gu;
/** The Ogham space mark counts as a space to `\s`, but is drawn as a dash. */
const OGHAM_SPACE = /\u1680/gu;
const SPACE_OR_INVISIBLE = new RegExp(
  `(?:[\\s\\p{Default_Ignorable_Code_Point}]|${BLANK_CHARACTERS})+`,
  "gu",
);

/**
 * The comparison key for an identifier. Equal keys mean "treat as the same
 * identifier". Never shown to people and never stored as the identifier.
 */
export function identifierKey(value: string): string {
  const { text, long } = decompose(value);
  const mapped = text.replace(ANY_CHAR, (ch) => LOOKALIKES.get(ch) ?? ch);
  if (long) {
    // Marks sorted by code point instead of canonical order: equivalent
    // spellings meet, and so may a few that differ only in mark order.
    // Sorted before case folding, which turns U+0345 (a mark) into `ι` and
    // would otherwise split a run at a place that depends on the order.
    const sorted = mapped.replace(MARK_RUN, (run) => Array.from(run).sort(byCodePoint).join(""));
    return SORTED_MARKS + sorted.toUpperCase().toLowerCase();
  }
  const folded = mapped.toUpperCase().toLowerCase();
  // Every run of marks is short, so this is linear in the text's length.
  return folded.normalize("NFKC").replace(SPACE_OR_INVISIBLE, "");
}
