/**
 * TEST REFERENCE ONLY: `term-duplicates.ts` exactly as it was before S-005a
 * (commit 9a21c6c), kept so the tests can show the faster code finds the
 * very same pairs on randomized inputs and on the hostile 50,000-term
 * shapes. It is left out of the build (`tsconfig.build.json` excludes every
 * `.fixtures.ts` file under `src`) and `index.ts` doesn't export it, so
 * nothing ships two copies of this code. Don't change it; the module
 * comment below describes the code as it was.
 *
 * Finding terms that may be duplicates, for Data Cleaning (decision D-014).
 *
 * Local terms drift: "Railroad depots", "railroad depot", "Rail-road depots",
 * "GH&H Railroad" next to "Galveston, Houston and Henderson Railroad".
 * `findNearDuplicateTerms` lists pairs of terms that may be the same, each
 * with a reason a person can check. It never merges, renames or changes
 * anything: what to do with a pair is a person's decision.
 *
 * Only classical text methods are used (no AI, D-004):
 * - `same_uri`: two entries whose URIs have the same `termUriKey` (so http
 *   and https copies of a Nomenclature or GNIS address meet), so the same term.
 * - `same_label`: the labels match once case, accents, spacing and
 *   punctuation are ignored, `&` is read as "and", and spaced initials are
 *   run together ("G. H. & H." is "GHH").
 * - `same_words`: the same words in another order, ignoring small words
 *   such as "and", "of" and "the" ("History of Dickinson", "Dickinson history").
 * - `abbreviation`: one label has the initials of a run of 2 to 8 of the
 *   other's words where the other has the words ("GH&H Railroad", "G H H
 *   Railroad"). The abbreviated label has at most 12 significant words.
 * - `similar_spelling`: the comparison keys are at most 1 edit apart (2 for
 *   keys of 10 or more letters), counting a swap of two neighbouring letters
 *   as one edit. Keys shorter than 5 letters aren't compared this way.
 *
 * Designators must match. For every reason but `same_uri`, the two labels
 * must have the same designators, as separate tokens: numbers ("Box 1-2" and
 * "Box 12", "Size 1.5" and "Size 15" differ), tokens mixing letters and
 * digits ("12a", "1B"), single letters ("Folder A") and Roman numerals written
 * in capitals from I to XXXIX ("World War II", "Henry VIII", "Louis XIV").
 * A different designator is a different thing.
 *
 * Accents are removed only from Latin, Greek and Cyrillic letters. Other
 * scripts keep their combining marks, because in Devanagari and many other
 * scripts they are vowels ("कमल" and "कमला" are different words).
 *
 * Which pairs are looked at: a pair where at least one term has no URI (every
 * local term, and outside terms entered without one). Two terms that both
 * have URIs are different terms unless the URIs match, so they are only
 * paired by `same_uri`. A group of terms sharing one key is reported as
 * pairs with one of its members, so n terms give n - 1 pairs, not n².
 *
 * Messy data doesn't stop the check: a term the vocabulary rules refuse, or
 * whose label is too long to compare once normalized (some characters expand
 * to many letters), is left out and listed in `skipped` with the reason.
 *
 * It is not quadratic, and its work is budgeted. Exact reasons come from
 * grouping by a key in a Map. Spelling compares only terms with the same
 * designators that share a block: one of their first 16 words, the first or
 * last three letters of the key, and for keys under 10 letters every key with
 * one letter removed (which finds every pair one edit apart), for longer keys
 * letters 4 to 6 from each end. A pair of keys of 10 or more letters with no
 * word in common is missed only when one edit is an insertion or deletion
 * among the first three letters and the other among the last three. A block
 * with more than 20 terms is sorted and each term compared with its 8
 * nearest neighbours on each side. A pair whose keys differ in more letters,
 * or in how many times letters appear, than the edits allowed could change
 * is passed over without working out its distance. Every pair visited is
 * charged against `MAX_SPELLING_CELLS` (at least 500 cells, or the product of
 * the two keys' lengths when their distance is worked out), and visited once
 * however many blocks it shares. When any limit cuts the search short,
 * `truncated` is true and `limitsReached` says which.
 */
import { type Issue, type Validated } from "./issues.js";
import { IssueList, shown } from "./plain-data.js";
import { types } from "node:util";
import { termUriKey, validateControlledTerm, type ControlledTerm } from "./vocabularies.js";

export const DUPLICATE_REASONS = [
  "same_uri",
  "same_label",
  "same_words",
  "abbreviation",
  "similar_spelling",
] as const;

export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/** One pair of terms that may be the same. Indexes are positions in the list given. */
export interface DuplicateCandidate {
  /** The lower index of the two. */
  readonly first: number;
  readonly second: number;
  readonly reason: DuplicateReason;
  /** A plain-English explanation naming both labels. */
  readonly message: string;
  /** For `similar_spelling`: how many edits apart the comparison keys are. */
  readonly distance?: number;
}

/** A term left out of the comparison. */
export interface SkippedTerm {
  readonly index: number;
  /** Why, with paths starting at its index. */
  readonly issues: readonly Issue[];
}

/**
 * A limit that cut the search short:
 * - `candidates`: more candidates were found than `maxCandidates`.
 * - `collected`: more than 100,000 candidates were found before sorting.
 * - `spelling_budget`: the spelling check used up `MAX_SPELLING_CELLS`.
 * - `large_blocks`: a block of different keys was compared by sorted
 *   neighbours only.
 * - `block_words`: a label had more than 16 different words, and only the
 *   first 16 were used to find spelling partners.
 * - `abbreviation_matches`: more than 20 different labels had the same
 *   significant words in the same order, and only 20 of them were checked
 *   against expanded forms. (Copies of one label count once: they are paired
 *   with each other by `same_label`, and the abbreviation with one of them.)
 * - `abbreviation_budget`: the abbreviation check used up
 *   `MAX_ABBREVIATION_WORK`.
 * - `long_labels`: some labels were too long to compare once normalized,
 *   and are listed in `skipped`.
 */
export type DuplicateLimit =
  | "candidates"
  | "collected"
  | "spelling_budget"
  | "large_blocks"
  | "block_words"
  | "abbreviation_matches"
  | "abbreviation_budget"
  | "long_labels";

const LIMIT_ORDER: readonly DuplicateLimit[] = [
  "candidates",
  "collected",
  "spelling_budget",
  "large_blocks",
  "block_words",
  "abbreviation_matches",
  "abbreviation_budget",
  "long_labels",
];

export interface DuplicateReport {
  /** Strongest reasons first, in `DUPLICATE_REASONS` order, then by index. */
  readonly candidates: readonly DuplicateCandidate[];
  /** True when there may be candidates that weren't found or returned. */
  readonly truncated: boolean;
  /** Which limits were reached; empty when the search was complete. */
  readonly limitsReached: readonly DuplicateLimit[];
  /** Terms left out, in index order. */
  readonly skipped: readonly SkippedTerm[];
}

export interface DuplicateOptions {
  /** How many candidates to return, 1 to `MAX_DUPLICATE_CANDIDATES`. Default 500. */
  readonly maxCandidates?: number;
}

/** The most terms one call reads. */
export const MAX_DUPLICATE_TERMS = 50_000;
export const DEFAULT_DUPLICATE_CANDIDATES = 500;
export const MAX_DUPLICATE_CANDIDATES = 10_000;
/**
 * The spelling check's work budget, in character cells. Each pair visited
 * costs `VISIT_CELLS`; a pair whose distance is worked out costs the product
 * of the two keys' lengths if that is more. It also bounds the pairs
 * remembered as visited (at most 4,000,000).
 */
export const MAX_SPELLING_CELLS = 2_000_000_000;
const VISIT_CELLS = 500;
/**
 * The abbreviation check's work budget: one unit per run of words looked at,
 * plus the characters of each shortened form built to look up.
 */
export const MAX_ABBREVIATION_WORK = 20_000_000;
/** The longest normalized label compared, in UTF-16 units. */
export const MAX_COMPARED_KEY_LENGTH = 2000;

/** A block bigger than this is compared by sorted neighbours, not all pairs. */
const BLOCK_ALL_PAIRS = 20;
const NEIGHBOURS = 8;
/** Words of a label used as spelling blocks. */
const MAX_BLOCK_WORDS = 16;
/** Abbreviations replace a run of 2 to 8 words. */
const MIN_RUN = 2;
const MAX_RUN = 8;
/**
 * An abbreviated label has at most this many significant words ("GHH
 * Railroad" has two), so its expanded form has at most 12 + 7.
 */
const MAX_ABBREVIATED_WORDS = 12;
/** Labels kept for one word sequence, as partners of an abbreviation. */
const MAX_PER_KEY = 20;
/** Candidates kept before sorting; past this the report is truncated. */
const MAX_COLLECTED = 100_000;

const SMALL_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
]);

const RANK: ReadonlyMap<DuplicateReason, number> = new Map(DUPLICATE_REASONS.map((r, i) => [r, i]));

interface Prepared {
  /** The term's position in the caller's list. */
  readonly index: number;
  readonly term: ControlledTerm;
  readonly hasUri: boolean;
  /** All words run together: the comparison key. */
  readonly key: string;
  /** The key for edit distance: the key itself, or its code points if it has any above U+FFFF. */
  readonly chars: ArrayLike<string>;
  /** Words without the small words, in order. */
  readonly significant: readonly string[];
  /** Numbers, letter-digit tokens, single letters and Roman numerals, in order. */
  readonly designators: string;
  /** The same, sorted, for `same_words`. */
  readonly sortedDesignators: string;
}

interface Analysed {
  readonly words: string[];
  readonly designators: string[];
}

/**
 * Words of a label for comparison: compatibility forms unfolded (NFKD),
 * accents removed from Latin, Greek and Cyrillic letters, case folded, `.`
 * and apostrophes dropped, `&` inside a word dropped ("GH&H" → "ghh") and `&`
 * between words read as "and", split at anything not a letter, mark or
 * digit, and runs of single letters joined ("G H and H" → "ghh").
 */
export function termWords(label: string): string[] {
  return analyse(label).words;
}

/** The comparison key for a label: its words run together. */
export function termMatchKey(label: string): string {
  return termWords(label).join("");
}

function analyse(label: string, unfolded = label.normalize("NFKD")): Analysed {
  const text = stripAccents(unfolded)
    // Periods go, except between digits ("1.5" stays two numbers).
    .replace(/['\u2019]|\.(?!\p{N})|(?<!\p{N})\./gu, "")
    .replace(/(?<=[\p{L}\p{M}\p{N}])&(?=[\p{L}\p{M}\p{N}])/gu, "")
    .replace(/&/g, " and ");
  const raw = text.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 0);
  const anyNumber = /\p{N}/u.test(text);
  const words: string[] = [];
  const designators: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i] ?? "";
    if (isLetter(token)) {
      // A run of single letters, maybe with "and" between: initials.
      let run = token;
      let j = i + 1;
      while (j < raw.length) {
        const next = raw[j] ?? "";
        if (isLetter(next)) {
          run += next;
          j += 1;
        } else if (next.toLowerCase() === "and" && isLetter(raw[j + 1] ?? "")) {
          j += 1;
        } else {
          break;
        }
      }
      if (j > i + 1) {
        words.push(run.toLowerCase());
        i = j - 1;
        continue;
      }
    }
    const lower = token.toLowerCase();
    words.push(lower);
    // "a" is an article, not a designator ("A history of Texas").
    if (
      (anyNumber && /\p{N}/u.test(token)) ||
      (lower !== "a" && isLetter(token)) ||
      isRoman(token)
    ) {
      designators.push(lower);
    }
  }
  return { words, designators };
}

/** One letter (one code point, plus any marks it kept). */
function isLetter(token: string): boolean {
  const c = token.charCodeAt(0);
  if (token.length === 1 && c < 128) return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  // Longer tokens starting with an ASCII character are never one letter
  // (accents on Latin letters were removed).
  if (c < 128 || token.length > 8) return false;
  return /^\p{L}\p{M}*$/u.test(token);
}

function isRoman(token: string): boolean {
  const c = token.charCodeAt(0);
  return (c === 73 || c === 86 || c === 88) && token.length <= 8 && ROMAN.test(token);
}

/** A Roman numeral in capitals, I to XXXIX. */
const ROMAN = /^(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})$/;

/**
 * Remove combining accents (U+0300–U+036F and the other combining
 * diacritical mark blocks) that follow a Latin, Greek or Cyrillic letter.
 * Marks on other scripts are kept. One pass, no regex: linear time.
 */
function stripAccents(text: string): string {
  let any = false;
  for (let i = 0; i < text.length && !any; i += 1) any = isDiacritic(text.charCodeAt(i));
  if (!any) return text;
  // Copy the text in runs between the accents that go.
  const parts: string[] = [];
  let runStart = 0;
  let latinLike = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (isDiacritic(c)) {
      if (latinLike) {
        parts.push(text.slice(runStart, i));
        runStart = i + 1;
      }
      continue;
    }
    // The last letter decides whether accents after it go. Cyrillic's own
    // combining marks (titlo and the like) keep the Cyrillic letter's state.
    if (!isOtherMark(c)) latinLike = isLatinGreekCyrillic(c);
  }
  parts.push(text.slice(runStart));
  return parts.join("");
}

function isDiacritic(c: number): boolean {
  return (
    (c >= 0x0300 && c <= 0x036f) ||
    (c >= 0x1ab0 && c <= 0x1aff) ||
    (c >= 0x1dc0 && c <= 0x1dff) ||
    (c >= 0x20d0 && c <= 0x20ff) ||
    (c >= 0xfe20 && c <= 0xfe2f)
  );
}

/** Combining marks of the Cyrillic block (titlo and the like), which never end a letter. */
function isOtherMark(c: number): boolean {
  return c >= 0x0483 && c <= 0x0489;
}

function isLatinGreekCyrillic(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) ||
    (c >= 0x370 && c <= 0x52f) ||
    (c >= 0x1c80 && c <= 0x1c8f) ||
    (c >= 0x1e00 && c <= 0x1fff) ||
    (c >= 0x2c60 && c <= 0x2c7f) ||
    (c >= 0x2de0 && c <= 0x2dff) ||
    (c >= 0xa640 && c <= 0xa69f) ||
    (c >= 0xa720 && c <= 0xa7ff) ||
    (c >= 0xab30 && c <= 0xab6f)
  );
}

/**
 * List pairs of terms that may be duplicates. `input` is a list of terms in
 * the `controlled_term` shape. Each is checked with `validateControlledTerm`;
 * one that fails, or whose label is too long to compare, is left out and
 * listed in `skipped`, and the rest are still compared. Fails only when
 * `input` isn't a readable list or `options` is bad. Never changes the input
 * and never throws.
 */
export function findNearDuplicateTerms(
  input: unknown,
  options: DuplicateOptions = {},
): Validated<DuplicateReport> {
  const issues = new IssueList();
  try {
    const max = readMax(options, issues);
    if (
      !Array.isArray(input) ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Array.prototype
    ) {
      issues.add([], "not_a_list", "The terms must be an ordinary list.");
    } else if (input.length > MAX_DUPLICATE_TERMS) {
      issues.add(
        [],
        "too_many",
        `At most ${String(MAX_DUPLICATE_TERMS)} terms can be compared at once.`,
      );
    }
    if (issues.count > 0) return { ok: false, issues: Object.freeze([...issues.items]) };
    const list = input as readonly unknown[];
    const terms: Prepared[] = [];
    const skipped: SkippedTerm[] = [];
    let tooLong = false;
    const length = list.length;
    const read: Validated<ControlledTerm>[] = [];
    for (let i = 0; i < length; i += 1) read.push(readTerm(list, i));
    // Only pairs with a term that has no URI can pair by label. With none,
    // only same_uri applies, so the labels needn't be analysed at all.
    const byLabel = read.some((r) => r.ok && r.value.uri === undefined);
    for (let i = 0; i < length; i += 1) {
      const result = read[i];
      if (result === undefined) continue;
      const prepared = result.ok ? prepare(result.value, i, byLabel) : undefined;
      if (prepared !== undefined) {
        terms.push(prepared);
      } else {
        if (result.ok) tooLong = true;
        skipped.push(
          Object.freeze({
            index: i,
            issues: result.ok
              ? Object.freeze([
                  Object.freeze({
                    path: Object.freeze([i, "label"]),
                    code: "too_long_to_compare",
                    message: `This label is too long to compare once its characters are unfolded (more than ${String(MAX_COMPARED_KEY_LENGTH)}).`,
                  }),
                ])
              : result.issues,
          }),
        );
      }
    }
    const out = new Collector(terms, max);
    if (tooLong) out.limits.add("long_labels");
    return { ok: true, value: findIn(terms, out, Object.freeze(skipped), byLabel) };
  } catch {
    issues.add([], "unreadable", "The terms could not be read as plain data.");
    return { ok: false, issues: Object.freeze([...issues.items]) };
  }
}

/** Read item `i` as its own value: a hole or getter is that item's problem only. */
function readTerm(list: readonly unknown[], i: number): Validated<ControlledTerm> {
  const fail = (code: string, message: string): Validated<ControlledTerm> => ({
    ok: false,
    issues: Object.freeze([Object.freeze({ path: Object.freeze([i]), code, message })]),
  });
  const descriptor = Object.getOwnPropertyDescriptor(list, i);
  if (descriptor === undefined) return fail("holes", "This place in the list is empty.");
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    return fail("not_plain_data", "List items can't be getters, setters or hidden.");
  }
  const result = validateControlledTerm(descriptor.value);
  if (result.ok) return result;
  return {
    ok: false,
    issues: Object.freeze(
      result.issues.map((x) => Object.freeze({ ...x, path: Object.freeze([i, ...x.path]) })),
    ),
  };
}

function readMax(options: unknown, issues: IssueList): number {
  if (typeof options !== "object" || options === null) {
    issues.add(["options"], "invalid_option", "The options must be an object.");
    return DEFAULT_DUPLICATE_CANDIDATES;
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "maxCandidates");
  if (descriptor === undefined) return DEFAULT_DUPLICATE_CANDIDATES;
  const value: unknown = "value" in descriptor ? descriptor.value : undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_DUPLICATE_CANDIDATES
  ) {
    issues.add(
      ["options", "maxCandidates"],
      "invalid_option",
      `maxCandidates must be a whole number from 1 to ${String(MAX_DUPLICATE_CANDIDATES)}.`,
    );
    return DEFAULT_DUPLICATE_CANDIDATES;
  }
  return value;
}

/** The term ready to compare, or undefined when its label is too long once normalized. */
function prepare(term: ControlledTerm, index: number, byLabel: boolean): Prepared | undefined {
  if (!byLabel) {
    return {
      index,
      term,
      hasUri: term.uri !== undefined,
      key: "",
      chars: "",
      significant: [],
      designators: "",
      sortedDesignators: "",
    };
  }
  // NFKD can make one character many (U+FDFA becomes 18), so check the
  // unfolded length before doing anything else with it.
  const unfolded = term.label.normalize("NFKD");
  if (unfolded.length > MAX_COMPARED_KEY_LENGTH) return undefined;
  const { words, designators } = analyse(term.label, unfolded);
  const key = words.join("");
  if (key.length > MAX_COMPARED_KEY_LENGTH) return undefined;
  return {
    index,
    term,
    hasUri: term.uri !== undefined,
    key,
    chars: /[\ud800-\udfff]/.test(key) ? Array.from(key) : key,
    significant: words.filter((w) => !SMALL_WORDS.has(w)),
    designators: designators.join(","),
    sortedDesignators: [...designators].sort().join(","),
  };
}

class Collector {
  readonly found: DuplicateCandidate[] = [];
  private readonly seen = new Set<number>();
  readonly limits = new Set<DuplicateLimit>();
  constructor(
    private readonly terms: readonly Prepared[],
    private readonly max: number,
  ) {}

  /** Pairs worth a look: at least one term without a URI and the same designators, or a shared URI. */
  eligible(i: number, j: number, reason: DuplicateReason): boolean {
    const a = this.terms[i];
    const b = this.terms[j];
    if (a === undefined || b === undefined || i === j) return false;
    if (reason === "same_uri") return true;
    const same =
      reason === "same_words"
        ? a.sortedDesignators === b.sortedDesignators
        : a.designators === b.designators;
    return (!a.hasUri || !b.hasUri) && same;
  }

  /** True if this pair was already reported (under a stronger reason). */
  has(i: number, j: number): boolean {
    return this.seen.has(pairId(i, j, this.terms.length));
  }

  add(i: number, j: number, reason: DuplicateReason, distance?: number): void {
    if (!this.eligible(i, j, reason)) return;
    const id = pairId(i, j, this.terms.length);
    if (this.seen.has(id)) return;
    if (this.found.length >= MAX_COLLECTED) {
      this.limits.add("collected");
      return;
    }
    this.seen.add(id);
    const [x, y] = i < j ? [i, j] : [j, i];
    const candidate: DuplicateCandidate = {
      first: this.terms[x]?.index ?? x,
      second: this.terms[y]?.index ?? y,
      reason,
      message: this.message(x, y, reason, distance),
      ...(distance === undefined ? {} : { distance }),
    };
    this.found.push(Object.freeze(candidate));
  }

  get full(): boolean {
    return this.found.length >= MAX_COLLECTED;
  }

  report(skipped: readonly SkippedTerm[]): DuplicateReport {
    const sorted = [...this.found].sort(
      (x, y) =>
        (RANK.get(x.reason) ?? 0) - (RANK.get(y.reason) ?? 0) ||
        (x.distance ?? 0) - (y.distance ?? 0) ||
        x.first - y.first ||
        x.second - y.second,
    );
    if (sorted.length > this.max) this.limits.add("candidates");
    const limitsReached = Object.freeze(LIMIT_ORDER.filter((l) => this.limits.has(l)));
    return Object.freeze({
      candidates: Object.freeze(sorted.slice(0, this.max)),
      truncated: limitsReached.length > 0,
      limitsReached,
      skipped,
    });
  }

  private message(i: number, j: number, reason: DuplicateReason, distance?: number): string {
    const a = this.terms[i];
    const b = this.terms[j];
    const la = shown(a?.term.label ?? "");
    const lb = shown(b?.term.label ?? "");
    switch (reason) {
      case "same_uri":
        return `${la} and ${lb} have the same URI, so they are the same term.`;
      case "same_label":
        return `${la} and ${lb} differ only in capital letters, accents, spacing or punctuation.`;
      case "same_words":
        return `${la} and ${lb} have the same words in a different order.`;
      case "abbreviation": {
        const [short, long] =
          (a?.significant.length ?? 0) < (b?.significant.length ?? 0) ? [la, lb] : [lb, la];
        return `${short} may be an abbreviation of ${long}.`;
      }
      case "similar_spelling":
        return `${la} and ${lb} are spelled almost the same (${String(distance ?? 0)} ${distance === 1 ? "letter differs" : "letters differ"}).`;
    }
  }
}

function pairId(i: number, j: number, n: number): number {
  return Math.min(i, j) * n + Math.max(i, j);
}

function findIn(
  terms: readonly Prepared[],
  out: Collector,
  skipped: readonly SkippedTerm[],
  byLabel: boolean,
): DuplicateReport {
  // Exact groupings, strongest first. The designators are part of the key,
  // so "Box 1-2" and "Box 12" (key "box12" both) never meet.
  groupPairs(terms, out, "same_uri", (t) =>
    t.term.uri === undefined ? undefined : termUriKey(t.term.uri),
  );
  if (!byLabel) return out.report(skipped);
  groupPairs(terms, out, "same_label", (t) =>
    t.key === "" ? undefined : `${t.designators}|${t.key}`,
  );
  // Sorting every label's words is slow for long labels, so terms are first
  // grouped by an order-free hash of their words; only terms that share a
  // hash get the exact sorted key.
  const hashCount = new Map<string, number>();
  const wordHash = terms.map((t) => {
    if (t.significant.length < 2) return undefined;
    const h = `${t.sortedDesignators}|${unorderedHash(t.significant)}`;
    hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    return h;
  });
  // Copies of one label have one sorted key: work it out once.
  const sortedByLabel = new Map<string, string>();
  groupPairs(terms, out, "same_words", (t, i) => {
    const h = wordHash[i];
    if (h === undefined || (hashCount.get(h) ?? 0) < 2) return undefined;
    const labelKey = `${t.designators}|${t.key}`;
    let sorted = sortedByLabel.get(labelKey);
    if (sorted === undefined) {
      sorted = `${t.sortedDesignators}|${[...t.significant].sort().join(" ")}`;
      sortedByLabel.set(labelKey, sorted);
    }
    return sorted;
  });
  abbreviations(terms, out);
  spelling(terms, out);
  return out.report(skipped);
}

/** A hash of a list of words that ignores their order (two 32-bit FNV-1a sums). */
function unorderedHash(words: readonly string[]): string {
  let sum = 0;
  let mix = 0;
  for (const w of words) {
    let h = 0x811c9dc5;
    for (let k = 0; k < w.length; k += 1) {
      h ^= w.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    sum = (sum + (h >>> 0)) >>> 0;
    mix = (mix + Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)) >>> 0;
  }
  return `${String(words.length)}:${String(sum)}:${String(mix)}`;
}

function groupPairs(
  terms: readonly Prepared[],
  out: Collector,
  reason: DuplicateReason,
  keyOf: (t: Prepared, i: number) => string | undefined,
): void {
  const groups = new Map<string, number[]>();
  terms.forEach((t, i) => {
    const key = keyOf(t, i);
    if (key === undefined) return;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [i]);
    else list.push(i);
  });
  for (const list of groups.values()) {
    if (out.full) return;
    if (list.length < 2) continue;
    // The hub is a term every other member may pair with: any member for a
    // shared URI, otherwise one without a URI.
    const hub = reason === "same_uri" ? list[0] : list.find((i) => terms[i]?.hasUri === false);
    if (hub === undefined) continue;
    for (const i of list) if (i !== hub) out.add(hub, i, reason);
  }
}

function abbreviations(terms: readonly Prepared[], out: Collector): void {
  // Every label's significant words in order, so a shortened form can be
  // looked up. Shortened forms are built from the longer label, so each list
  // holds the labels that might be the abbreviation.
  // Labels with the same key (already paired by same_label) are entered
  // once, by one member, preferring one without a URI, so copies of one
  // label don't fill a list.
  const byWords = new Map<string, number[]>();
  const entered = new Map<string, number>();
  terms.forEach((t, i) => {
    if (t.significant.length === 0 || t.significant.length > MAX_ABBREVIATED_WORDS) return;
    const key = t.significant.join(" ");
    const labelKey = `${t.designators}|${t.key}`;
    const before = entered.get(labelKey);
    if (before !== undefined) {
      // Swap in this one if the entered member has a URI and this one hasn't.
      if (terms[before]?.hasUri === true && !t.hasUri) {
        const list = byWords.get(key);
        const at = list?.indexOf(before) ?? -1;
        if (list !== undefined && at >= 0) {
          list[at] = i;
          entered.set(labelKey, i);
        }
      }
      return;
    }
    const list = byWords.get(key);
    if (list === undefined) byWords.set(key, [i]);
    else if (list.length < MAX_PER_KEY) list.push(i);
    else {
      out.limits.add("abbreviation_matches");
      return;
    }
    entered.set(labelKey, i);
  });
  // Words that could be an abbreviation: a shortened form is only built when
  // its initials are one of these, which keeps the work small.
  const shortWords = new Set<string>();
  for (const key of byWords.keys()) {
    for (const w of key.split(" ")) {
      if (w.length >= MIN_RUN && w.length <= MAX_RUN * 2) shortWords.add(w);
    }
  }
  let work = 0;
  for (let j = 0; j < terms.length; j += 1) {
    const words = terms[j]?.significant ?? [];
    // The shortened form has words.length - len + 1 words, at most
    // MAX_ABBREVIATED_WORDS, so longer labels can't be expanded forms.
    if (words.length < MIN_RUN || words.length > MAX_ABBREVIATED_WORDS + MAX_RUN - 1) continue;
    if (out.full) return;
    for (let start = 0; start < words.length; start += 1) {
      let initials = "";
      for (let len = 1; len <= MAX_RUN && start + len <= words.length; len += 1) {
        work += 1;
        if (work > MAX_ABBREVIATION_WORK) {
          out.limits.add("abbreviation_budget");
          return;
        }
        const w = words[start + len - 1] ?? "";
        // Initials of numbers would make "1900 1915" into "11".
        if (/^\p{N}/u.test(w)) break;
        initials += Array.from(w)[0] ?? "";
        if (len < MIN_RUN || words.length - len + 1 > MAX_ABBREVIATED_WORDS) continue;
        if (!shortWords.has(initials)) continue;
        const short = [...words.slice(0, start), initials, ...words.slice(start + len)].join(" ");
        work += short.length;
        for (const i of byWords.get(short) ?? []) {
          if (!out.has(i, j)) out.add(i, j, "abbreviation");
        }
      }
    }
  }
}

function spelling(terms: readonly Prepared[], out: Collector): void {
  // Only pairs with a term that has no URI can pair; with none, nothing to do.
  if (!terms.some((t) => !t.hasUri)) return;
  // A term can only pair by spelling with one that has the same designators
  // and one of the two has no URI; terms with no such partner get no blocks.
  const groupsByDesignators = new Map<string, { count: number; withoutUri: number }>();
  for (const t of terms) {
    const g = groupsByDesignators.get(t.designators) ?? { count: 0, withoutUri: 0 };
    g.count += 1;
    if (!t.hasUri) g.withoutUri += 1;
    groupsByDesignators.set(t.designators, g);
  }
  const blocks = new Map<string, number[]>();
  const put = (key: string, i: number): void => {
    const list = blocks.get(key);
    if (list === undefined) blocks.set(key, [i]);
    else list.push(i);
  };
  terms.forEach((t, i) => {
    const n = t.chars.length;
    if (n < 5) return;
    const group = groupsByDesignators.get(t.designators);
    if (group === undefined || group.count < 2) return;
    if (group.withoutUri === 0) return;
    // Designators must match, so they are part of every block key.
    const d = `${t.designators}|`;
    const slice = (from: number, to: number): string => {
      let s = "";
      for (let k = from; k < to; k += 1) s += t.chars[k] ?? "";
      return s;
    };
    const words = new Set<string>();
    for (const w of t.significant) {
      if (w.length < 3 || words.has(w)) continue;
      if (words.size === MAX_BLOCK_WORDS) {
        out.limits.add("block_words");
        break;
      }
      words.add(w);
    }
    for (const w of words) put(`${d}w:${w}`, i);
    put(`${d}p:${slice(0, 3)}`, i);
    put(`${d}s:${slice(n - 3, n)}`, i);
    if (n < 10) {
      // Every key with one letter removed: two keys one edit apart always
      // share one (a key one letter longer shares the shorter key itself).
      put(`${d}x:${slice(0, n)}`, i);
      for (let k = 0; k < n; k += 1) put(`${d}x:${slice(0, k)}${slice(k + 1, n)}`, i);
    } else {
      put(`${d}m:${slice(3, 6)}`, i);
      put(`${d}n:${slice(n - 6, n - 3)}`, i);
    }
  });

  // Every term's place in key order, forwards and from the end, worked out
  // once, so sorting a big block is sorting numbers.
  let cached: { forward: number[]; backward: number[] } | undefined;
  const ranks = (): { forward: number[]; backward: number[] } => {
    if (cached !== undefined) return cached;
    const order = (cmp: (x: number, y: number) => number): number[] => {
      const rank = new Array<number>(terms.length).fill(0);
      terms
        .map((_, i) => i)
        .sort((x, y) => cmp(x, y) || x - y)
        .forEach((i, r) => (rank[i] = r));
      return rank;
    };
    cached = {
      forward: order((x, y) => {
        const a = terms[x]?.key ?? "";
        const b = terms[y]?.key ?? "";
        return a < b ? -1 : a > b ? 1 : 0;
      }),
      backward: order((x, y) => compareFromEnd(terms[x]?.chars ?? "", terms[y]?.chars ?? "")),
    };
    return cached;
  };

  // Two summaries of each key's letters, by code point as `chars` holds
  // them: which letters it has, folded into 32 buckets, and how many of each,
  // folded into 8 buckets of 4 bits that count round from 15 to 0. One edit
  // takes away at most one letter and adds at most one, so it changes the
  // first by at most two buckets and the counts by at most two in all
  // (folding, and measuring counts the short way round, only make
  // differences smaller). Keys whose summaries differ by more than
  // 2 × limit can't be within the limit, and their distance needn't be
  // worked out.
  const letterSets = new Int32Array(terms.length);
  const letterCounts = new Int32Array(terms.length);
  terms.forEach((t, i) => {
    let set = 0;
    let counts = 0;
    for (const c of t.key) {
      const code = c.codePointAt(0) ?? 0;
      set |= 1 << (code & 31);
      const shift = (code & 7) * 4;
      const count = (counts >>> shift) & 15;
      counts = (counts & ~(15 << shift)) | (((count + 1) & 15) << shift);
    }
    letterSets[i] = set;
    letterCounts[i] = counts;
  });
  const lettersWithin = (i: number, j: number, limit: number): boolean => {
    if (bitCount((letterSets[i] ?? 0) ^ (letterSets[j] ?? 0)) > 2 * limit) return false;
    const x = letterCounts[i] ?? 0;
    const y = letterCounts[j] ?? 0;
    let apart = 0;
    for (let shift = 0; shift < 32; shift += 4) {
      const gap = Math.abs(((x >>> shift) & 15) - ((y >>> shift) & 15));
      apart += Math.min(gap, 16 - gap);
    }
    return apart <= 2 * limit;
  };

  const visited = new PairSet();
  let cells = 0;
  /** Visit one pair; false when the budget has run out. */
  const visit = (i: number, j: number): boolean => {
    // Remembered now: if the budget stops the search below, it stops for good.
    if (!visited.add(i, j)) return true;
    const a = terms[i];
    const b = terms[j];
    if (a === undefined || b === undefined) return true;
    const product = a.chars.length * b.chars.length;
    const needsDistance =
      a.key !== b.key && !out.has(i, j) && out.eligible(i, j, "similar_spelling");
    const limit = Math.min(a.chars.length, b.chars.length) >= 10 ? 2 : 1;
    // Charged only for the work done: a pair passed over costs a visit.
    const worked = needsDistance && lettersWithin(i, j, limit);
    const cost = worked ? Math.max(VISIT_CELLS, product) : VISIT_CELLS;
    if (cells + cost > MAX_SPELLING_CELLS) {
      out.limits.add("spelling_budget");
      return false;
    }
    if (out.full) {
      out.limits.add("collected");
      return false;
    }
    cells += cost;
    if (!worked) return true;
    const d = boundedDistance(a.chars, b.chars, limit);
    if (d <= limit) out.add(i, j, "similar_spelling", d);
    return true;
  };

  for (const [key, list] of blocks) {
    if (list.length < 2) continue;
    // A block with only URI terms can't give a pair.
    if (!list.some((i) => terms[i]?.hasUri === false)) continue;
    if (list.length <= BLOCK_ALL_PAIRS) {
      for (let x = 0; x < list.length; x += 1) {
        for (let y = x + 1; y < list.length; y += 1) {
          const i = list[x] ?? 0;
          const j = list[y] ?? 0;
          if (terms[i]?.hasUri === true && terms[j]?.hasUri === true) continue;
          if (!visit(i, j)) return;
        }
      }
      continue;
    }
    // Sorted neighbourhood: sort by the key (by the reversed key for a block
    // of shared endings) and compare each term without a URI with the
    // nearest few on each side. Only neighbours are compared, so a pair
    // further apart can be missed, unless every key in the block is the same.
    const first = terms[list[0] ?? 0]?.key;
    if (list.some((i) => terms[i]?.key !== first)) out.limits.add("large_blocks");
    const rank = key.includes("|s:") || key.includes("|n:") ? ranks().backward : ranks().forward;
    const sorted = [...list].sort((x, y) => (rank[x] ?? 0) - (rank[y] ?? 0));
    for (let x = 0; x < sorted.length; x += 1) {
      const i = sorted[x] ?? 0;
      if (terms[i]?.hasUri !== false) continue;
      const from = Math.max(0, x - NEIGHBOURS);
      const to = Math.min(sorted.length - 1, x + NEIGHBOURS);
      for (let y = from; y <= to; y += 1) {
        const j = sorted[y] ?? 0;
        // Looking back, only at terms with a URI: a term without one before
        // this one already looked forward at it.
        if (y === x || (y < x && terms[j]?.hasUri !== true)) continue;
        if (!visit(i, j)) return;
      }
    }
  }
}

/** How many bits of a 32-bit number are set. */
function bitCount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/**
 * A set of pairs of term positions (each below 2^31), in typed arrays with
 * open addressing: far less memory and time than a `Set` of numbers that
 * outgrow small integers. Pairs are unordered.
 */
class PairSet {
  private low = new Int32Array(1 << 12).fill(-1);
  private high = new Int32Array(1 << 12);
  private size = 0;

  /** Add the pair; false if it was there already. */
  add(i: number, j: number): boolean {
    const x = Math.min(i, j);
    const y = Math.max(i, j);
    const at = this.slot(x, y);
    if (this.low[at] !== -1) return false;
    this.low[at] = x;
    this.high[at] = y;
    this.size += 1;
    if (this.size * 2 > this.low.length) this.grow();
    return true;
  }

  /** Where the pair is, or the empty slot where it would go. */
  private slot(x: number, y: number): number {
    const mask = this.low.length - 1;
    // Mixed with MurmurHash3's finaliser, so evenly spaced positions spread.
    let h = Math.imul(x, 0x9e3779b1) ^ y;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    let at = (h ^ (h >>> 16)) & mask;
    for (;;) {
      const l = this.low[at] ?? -1;
      if (l === -1 || (l === x && this.high[at] === y)) return at;
      at = (at + 1) & mask;
    }
  }

  private grow(): void {
    const low = this.low;
    const high = this.high;
    this.low = new Int32Array(low.length * 2).fill(-1);
    this.high = new Int32Array(low.length * 2);
    for (let k = 0; k < low.length; k += 1) {
      const x = low[k] ?? -1;
      if (x === -1) continue;
      const y = high[k] ?? 0;
      const at = this.slot(x, y);
      this.low[at] = x;
      this.high[at] = y;
    }
  }
}

/** Compare two keys character by character from the end. */
function compareFromEnd(a: ArrayLike<string>, b: ArrayLike<string>): number {
  const n = Math.min(a.length, b.length);
  for (let k = 1; k <= n; k += 1) {
    const x = a[a.length - k] ?? "";
    const y = b[b.length - k] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * The optimal string alignment distance between `a` and `b` (insertions,
 * deletions, substitutions and swaps of two neighbouring characters), or
 * `limit + 1` as soon as it is known to be more than `limit`. `a` and `b`
 * are lists of characters (a string works when it has no characters above
 * U+FFFF). Only cells within `limit` of the diagonal are computed, so the
 * cost is about length × (2 × limit + 1).
 */
export function boundedDistance(a: ArrayLike<string>, b: ArrayLike<string>, limit: number): number {
  const over = limit + 1;
  if (Math.abs(a.length - b.length) > limit) return over;
  const n = a.length;
  const m = b.length;
  // Compared as numbers, which is much faster than as one-letter strings.
  if (codesA.length < n) codesA = new Int32Array(n * 2);
  if (codesB.length < m) codesB = new Int32Array(m * 2);
  const ca = codesA;
  const cb = codesB;
  if (typeof a === "string" && typeof b === "string") {
    for (let k = 0; k < n; k += 1) ca[k] = a.charCodeAt(k);
    for (let k = 0; k < m; k += 1) cb[k] = b.charCodeAt(k);
  } else {
    // Lists of characters: number each different character.
    const ids = new Map<string, number>();
    const id = (c: string | undefined): number => {
      const key = c ?? "";
      let v = ids.get(key);
      if (v === undefined) ids.set(key, (v = ids.size));
      return v;
    };
    for (let k = 0; k < n; k += 1) ca[k] = id(a[k]);
    for (let k = 0; k < m; k += 1) cb[k] = id(b[k]);
  }
  // Three rows, reused across calls: two back (for swaps), previous and
  // current. Each row is written only around its band, plus one cell either
  // side set to "over", which is all the next rows read, so nothing needs
  // clearing between calls.
  if (scratch.length < 3 * (m + 1)) scratch = new Int32Array(3 * (m + 1) * 2);
  const rows = scratch;
  let prev2 = 0;
  let prev = m + 1;
  let cur = 2 * (m + 1);
  // Row 0: only its first limit + 2 cells are ever read.
  for (let j = 0; j <= Math.min(m, limit + 1); j += 1) rows[prev + j] = Math.min(j, over);
  for (let i = 1; i <= n; i += 1) {
    const from = Math.max(1, i - limit);
    const to = Math.min(m, i + limit);
    for (let j = Math.max(0, from - 1); j <= Math.min(m, to + 1); j += 1) rows[cur + j] = over;
    let best = over;
    if (from === 1) {
      rows[cur] = i <= limit ? i : over;
      best = Math.min(over, (rows[cur] ?? over) + Math.abs(n - i - m));
    }
    const ai = ca[i - 1] ?? -1;
    const aPrev = i > 1 ? (ca[i - 2] ?? -1) : -2;
    for (let j = from; j <= to; j += 1) {
      const bj = cb[j - 1] ?? -1;
      const cost = ai === bj ? 0 : 1;
      let v = Math.min(
        (rows[prev + j] ?? over) + 1,
        (rows[cur + j - 1] ?? over) + 1,
        (rows[prev + j - 1] ?? over) + cost,
      );
      if (j > 1 && ai === (cb[j - 2] ?? -1) && aPrev === bj) {
        v = Math.min(v, (rows[prev2 + j - 2] ?? over) + 1);
      }
      v = Math.min(v, over);
      rows[cur + j] = v;
      // What's left of the two keys differs in length by this much, so at
      // least that many more edits are needed from this cell.
      const atLeast = v + Math.abs(n - i - (m - j));
      if (atLeast < best) best = atLeast;
    }
    if (best > limit) return over;
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return Math.min(rows[prev + m] ?? over, over);
}

/** Rows and codes for `boundedDistance`, kept between calls (it never runs re-entrantly). */
let scratch = new Int32Array(3 * 64);
let codesA = new Int32Array(64);
let codesB = new Int32Array(64);
