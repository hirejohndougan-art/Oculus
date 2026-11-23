/**
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

/**
 * The most terms one call reads. It must stay at or below
 * `MAX_PAIR_SET_TERMS`, which a test checks: the spelling check's set of
 * visited pairs holds a pair of positions as one 32-bit number.
 */
export const MAX_DUPLICATE_TERMS = 50_000;
/**
 * The most terms `PairSet` can hold pairs of: a pair of positions below n is
 * at most n² - n - 1, which must be below 2^32 - 1.
 */
export const MAX_PAIR_SET_TERMS = 65_536;
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
/** Word places indexed per entered label: more than `MAX_ABBREVIATED_WORDS`. */
const PLACES = 16;
/**
 * Numbers kept per term for the spelling check: length, key number, letter
 * set, letter counts, designators number.
 */
const FACTS = 5;
/** The kinds of spelling block (see `spelling`). */
const BLOCK_W = 0;
const BLOCK_P = 1;
const BLOCK_S = 2;
const BLOCK_X = 3;
const BLOCK_M = 4;
const BLOCK_N = 5;
const BLOCK_KINDS = 6;
/** Pairs of positions at most this far apart are kept as bits (a multiple of 32). */
const NEAR = 128;
/** Keys up to this many characters are copied into one array for the spelling check. */
const POOLED_LENGTH = 128;
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
  // its initials are one of these, which keeps the work small. They are
  // filed by a hash of their UTF-16 units (`unitHash`), so initials can be
  // looked up as they grow, a character at a time, without making text.
  // Also where they stand: `atPlace[count * PLACES + p]` holds the words at
  // place p of the entered labels with `count` words. A shortened form can
  // only be one of them if its initials are among the words at its own place
  // in labels of its own length, so the rest are never built.
  const shortWords = new Map<number, string[]>();
  const atPlace: (Set<string> | undefined)[] = [];
  const hashed = new Set<string>();
  for (const list of byWords.values()) {
    // Every label in a list has these significant words.
    const words = terms[list[0] ?? -1]?.significant ?? [];
    words.forEach((w, p) => {
      if (w.length < MIN_RUN || w.length > MAX_RUN * 2) return;
      (atPlace[words.length * PLACES + p] ??= new Set()).add(w);
      if (hashed.has(w)) return;
      hashed.add(w);
      let h = 0;
      for (let k = 0; k < w.length; k += 1) h = unitHash(h, w.charCodeAt(k));
      const same = shortWords.get(h);
      if (same === undefined) shortWords.set(h, [w]);
      else same.push(w);
    });
  }
  let work = 0;
  for (let j = 0; j < terms.length; j += 1) {
    const words = terms[j]?.significant ?? [];
    // The shortened form has words.length - len + 1 words, at most
    // MAX_ABBREVIATED_WORDS, so longer labels can't be expanded forms.
    if (words.length < MIN_RUN || words.length > MAX_ABBREVIATED_WORDS + MAX_RUN - 1) continue;
    if (out.full) return;
    // Each word's first character (as a code point) and whether it is a
    // number, and the label's length, worked out once per label rather than
    // once per run.
    const firsts: number[] = [];
    const numeric: boolean[] = [];
    let total = words.length - 1;
    for (const w of words) {
      firsts.push(w.codePointAt(0) ?? 0);
      // Initials of numbers would make "1900 1915" into "11".
      numeric.push(/^\p{N}/u.test(w));
      total += w.length;
    }
    /** The short word whose units are the initials of words start to end, if any. */
    const initialsWord = (hash: number, start: number, end: number): string | undefined =>
      shortWords.get(hash)?.find((w) => {
        let pos = 0;
        for (let k = start; k <= end; k += 1) {
          const c = firsts[k] ?? 0;
          if (c > 0xffff) {
            if (w.charCodeAt(pos) !== 0xd800 + ((c - 0x10000) >> 10)) return false;
            if (w.charCodeAt(pos + 1) !== 0xdc00 + ((c - 0x10000) & 0x3ff)) return false;
            pos += 2;
          } else {
            if (w.charCodeAt(pos) !== c) return false;
            pos += 1;
          }
        }
        return pos === w.length;
      });
    for (let start = 0; start < words.length; start += 1) {
      // The initials' hash and length in UTF-16 units, and the characters of
      // the run's words and the spaces between them.
      let hash = 0;
      let initials = 0;
      let run = -1;
      for (let len = 1; len <= MAX_RUN && start + len <= words.length; len += 1) {
        work += 1;
        if (work > MAX_ABBREVIATION_WORK) {
          out.limits.add("abbreviation_budget");
          return;
        }
        const at = start + len - 1;
        if (numeric[at] === true) break;
        const c = firsts[at] ?? 0;
        if (c > 0xffff) {
          hash = unitHash(
            unitHash(hash, 0xd800 + ((c - 0x10000) >> 10)),
            0xdc00 + ((c - 0x10000) & 0x3ff),
          );
          initials += 2;
        } else {
          hash = unitHash(hash, c);
          initials += 1;
        }
        run += (words[at]?.length ?? 0) + 1;
        const count = words.length - len + 1;
        if (len < MIN_RUN || count > MAX_ABBREVIATED_WORDS) continue;
        const word = initialsWord(hash, start, at);
        if (word === undefined) continue;
        // Charged as if the shortened form were built, so the budget runs
        // out at the same place whether or not it is.
        work += total - run + initials;
        if (atPlace[count * PLACES + start]?.has(word) !== true) continue;
        const short = [...words.slice(0, start), word, ...words.slice(start + len)].join(" ");
        for (const i of byWords.get(short) ?? []) {
          if (!out.has(i, j)) out.add(i, j, "abbreviation");
        }
      }
    }
  }
}

/** A hash of UTF-16 units, one unit at a time (31 × hash + unit, in 32 bits). */
function unitHash(hash: number, unit: number): number {
  return (Math.imul(hash, 31) + unit) | 0;
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
  // A block is the terms with the same designators sharing one of: a word
  // (w), the first three letters (p), the last three (s), for keys under 10
  // letters the key with one letter removed (x), and for longer keys letters
  // 4 to 6 from the start (m) or from the end (n). Blocks are searched in the
  // order they were first made; each is found through its designators, its
  // kind and its text, and `fromEnd` marks the kinds sorted from the end.
  const blocks: number[][] = [];
  const fromEnd: boolean[] = [];
  const blockIndex = new Map<string, Map<string, number>[]>();
  const put = (byKind: Map<string, number>[], kind: number, text: string, i: number): void => {
    const index = byKind[kind];
    if (index === undefined) return;
    const at = index.get(text);
    if (at === undefined) {
      index.set(text, blocks.length);
      blocks.push([i]);
      fromEnd.push(kind === BLOCK_S || kind === BLOCK_N);
    } else {
      blocks[at]?.push(i);
    }
  };
  terms.forEach((t, i) => {
    const n = t.chars.length;
    if (n < 5) return;
    const group = groupsByDesignators.get(t.designators);
    if (group === undefined || group.count < 2) return;
    if (group.withoutUri === 0) return;
    // Designators must match, so they choose the blocks' index.
    let byKind = blockIndex.get(t.designators);
    if (byKind === undefined) {
      byKind = Array.from({ length: BLOCK_KINDS }, () => new Map<string, number>());
      blockIndex.set(t.designators, byKind);
    }
    const chars = t.chars;
    const slice = (from: number, to: number): string => {
      // A key without characters above U+FFFF is its own list of characters.
      if (typeof chars === "string") return chars.slice(from, to);
      let s = "";
      for (let k = from; k < to; k += 1) s += chars[k] ?? "";
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
    for (const w of words) put(byKind, BLOCK_W, w, i);
    put(byKind, BLOCK_P, slice(0, 3), i);
    put(byKind, BLOCK_S, slice(n - 3, n), i);
    if (n < 10) {
      // Every key with one letter removed: two keys one edit apart always
      // share one (a key one letter longer shares the shorter key itself).
      put(byKind, BLOCK_X, slice(0, n), i);
      for (let k = 0; k < n; k += 1) put(byKind, BLOCK_X, slice(0, k) + slice(k + 1, n), i);
    } else {
      put(byKind, BLOCK_M, slice(3, 6), i);
      put(byKind, BLOCK_N, slice(n - 6, n - 3), i);
    }
  });

  // Every term's place in key order, forwards and from the end, worked out
  // once, so sorting a big block is sorting numbers. Places are all
  // different (ties go by position), so `byRank` turns a place back into
  // the term.
  const order = (cmp: (x: number, y: number) => number): Order => {
    const rank = new Int32Array(terms.length);
    const byRank = Int32Array.from(terms.map((_, i) => i).sort((x, y) => cmp(x, y) || x - y));
    byRank.forEach((i, r) => (rank[i] = r));
    return { rank, byRank };
  };
  // The pairs are visited by forward place, not by position in the list:
  // what is kept about each term below is laid out in key order, so the
  // neighbours a big block compares sit close together in memory. With no
  // big block, nothing is sorted and a term's place is its position.
  if (!blocks.some((list) => list.length >= 2)) return;
  const forward = blocks.some((list) => list.length > BLOCK_ALL_PAIRS)
    ? order((x, y) => {
        const a = terms[x]?.key ?? "";
        const b = terms[y]?.key ?? "";
        return a < b ? -1 : a > b ? 1 : 0;
      })
    : { rank: Int32Array.from(terms, (_, i) => i), byRank: Int32Array.from(terms, (_, i) => i) };
  let backwardOrder: Order | undefined;
  const backward = (): Order => {
    if (backwardOrder !== undefined) return backwardOrder;
    // A key with no characters above U+FFFF compares from the end exactly as
    // its reverse compares from the start, which is much faster.
    const reversed = terms.map((t) => {
      if (typeof t.chars !== "string") return undefined;
      // Keys are at most MAX_COMPARED_KEY_LENGTH units, few enough to spread.
      const units = new Array<number>(t.chars.length);
      for (let k = 0; k < units.length; k += 1) units[k] = t.chars.charCodeAt(units.length - 1 - k);
      return String.fromCharCode(...units);
    });
    backwardOrder = order((x, y) => {
      const a = reversed[x];
      const b = reversed[y];
      if (a !== undefined && b !== undefined) return a < b ? -1 : a > b ? 1 : 0;
      return compareFromEnd(terms[x]?.chars ?? "", terms[y]?.chars ?? "");
    });
    return backwardOrder;
  };
  const place = forward.rank;
  const termAt = forward.byRank;

  // Two summaries of each key's letters, by code point as `chars` holds
  // them: which letters it has, folded into 32 buckets, and how many of each,
  // folded into 8 buckets of 4 bits that count round from 15 to 0. One edit
  // takes away at most one letter and adds at most one, so it changes the
  // first by at most two buckets and the counts by at most two in all
  // (folding, and measuring counts the short way round, only make
  // differences smaller). Keys whose summaries differ by more than
  // 2 × limit can't be within the limit, and their distance needn't be
  // worked out.
  //
  // These, each key's length in characters and a number for each different
  // key sit side by side in `facts`, FACTS numbers for each place, so
  // passing over a pair reads two short runs of memory instead of two terms
  // and their keys. `uri` says which places hold a term with a URI.
  const facts = new Int32Array(terms.length * FACTS);
  const uri = new Uint8Array(terms.length);
  const keyIds = new Map<string, number>();
  const designatorIds = new Map<string, number>();
  termAt.forEach((i, r) => {
    const t = terms[i];
    if (t === undefined) return;
    let set = 0;
    let counts = 0;
    for (const c of t.key) {
      const code = c.codePointAt(0) ?? 0;
      set |= 1 << (code & 31);
      const shift = (code & 7) * 4;
      const count = (counts >>> shift) & 15;
      counts = (counts & ~(15 << shift)) | (((count + 1) & 15) << shift);
    }
    let keyId = keyIds.get(t.key);
    if (keyId === undefined) keyIds.set(t.key, (keyId = keyIds.size));
    facts[r * FACTS] = t.chars.length;
    facts[r * FACTS + 1] = keyId;
    facts[r * FACTS + 2] = set;
    facts[r * FACTS + 3] = counts;
    let designatorId = designatorIds.get(t.designators);
    if (designatorId === undefined) {
      designatorIds.set(t.designators, (designatorId = designatorIds.size));
    }
    facts[r * FACTS + 4] = designatorId;
    uri[r] = t.hasUri ? 1 : 0;
  });
  // Each key of at most POOLED_LENGTH characters as numbers (its code
  // points), one after another in key order, so working out a distance reads
  // neighbouring runs of one array rather than two strings anywhere in
  // memory. `pooledAt` is where a place's key starts, or -1 for a longer key.
  const pooledAt = new Int32Array(terms.length).fill(-1);
  let pooledLength = 0;
  termAt.forEach((i, r) => {
    const length = terms[i]?.chars.length ?? POOLED_LENGTH + 1;
    if (length > POOLED_LENGTH) return;
    pooledAt[r] = pooledLength;
    pooledLength += length;
  });
  const pool = new Int32Array(pooledLength);
  termAt.forEach((i, r) => {
    const chars = terms[i]?.chars ?? "";
    const start = pooledAt[r] ?? -1;
    if (start < 0) return;
    for (let k = 0; k < chars.length; k += 1) {
      pool[start + k] =
        typeof chars === "string" ? chars.charCodeAt(k) : (chars[k]?.codePointAt(0) ?? 0);
    }
  });
  const lettersWithin = (p: number, q: number, limit: number): boolean => {
    const setA = facts[p * FACTS + 2] ?? 0;
    const setB = facts[q * FACTS + 2] ?? 0;
    if (bitCount(setA ^ setB) > 2 * limit) return false;
    const x = facts[p * FACTS + 3] ?? 0;
    const y = facts[q * FACTS + 3] ?? 0;
    let apart = 0;
    for (let shift = 0; shift < 32; shift += 4) {
      const gap = Math.abs(((x >>> shift) & 15) - ((y >>> shift) & 15));
      apart += Math.min(gap, 16 - gap);
    }
    return apart <= 2 * limit;
  };

  const visited = new PairSet(terms.length);
  let cells = 0;
  /** Visit the pair at places p and q; false when the budget has run out. */
  const visit = (p: number, q: number): boolean => {
    // Remembered now: if the budget stops the search below, it stops for good.
    if (!visited.add(p, q)) return true;
    const lengthA = facts[p * FACTS] ?? 0;
    const lengthB = facts[q * FACTS] ?? 0;
    const product = lengthA * lengthB;
    const limit = Math.min(lengthA, lengthB) >= 10 ? 2 : 1;
    const i = termAt[p] ?? 0;
    const j = termAt[q] ?? 0;
    // Charged only for the work done: a pair passed over costs a visit. The
    // cheapest tests come first; none of them changes anything. Different
    // keys, a term without a URI and the same designators are what
    // `out.eligible` asks for a spelling pair (different keys mean two
    // different terms).
    const worked =
      facts[p * FACTS + 1] !== facts[q * FACTS + 1] &&
      (uri[p] === 0 || uri[q] === 0) &&
      facts[p * FACTS + 4] === facts[q * FACTS + 4] &&
      lettersWithin(p, q, limit) &&
      !out.has(i, j);
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
    const startA = pooledAt[p] ?? -1;
    const startB = pooledAt[q] ?? -1;
    let d: number;
    if (startA >= 0 && startB >= 0) {
      d = codeDistance(pool, startA, lengthA, pool, startB, lengthB, limit);
    } else {
      const a = terms[i];
      const b = terms[j];
      if (a === undefined || b === undefined) return true;
      d = boundedDistance(a.chars, b.chars, limit);
    }
    if (d <= limit) out.add(i, j, "similar_spelling", d);
    return true;
  };

  for (let block = 0; block < blocks.length; block += 1) {
    const list = blocks[block] ?? [];
    if (list.length < 2) continue;
    // Places, in the list's order.
    const places = new Int32Array(list.length);
    for (let k = 0; k < list.length; k += 1) places[k] = place[list[k] ?? 0] ?? 0;
    // A block with only URI terms can't give a pair.
    if (!places.some((p) => uri[p] === 0)) continue;
    if (places.length <= BLOCK_ALL_PAIRS) {
      for (let x = 0; x < places.length; x += 1) {
        for (let y = x + 1; y < places.length; y += 1) {
          const p = places[x] ?? 0;
          const q = places[y] ?? 0;
          if (uri[p] === 1 && uri[q] === 1) continue;
          if (!visit(p, q)) return;
        }
      }
      continue;
    }
    // Sorted neighbourhood: sort by the key (by the reversed key for a block
    // of shared endings) and compare each term without a URI with the
    // nearest few on each side. Only neighbours are compared, so a pair
    // further apart can be missed, unless every key in the block is the same.
    const first = facts[(places[0] ?? 0) * FACTS + 1];
    if (places.some((p) => facts[p * FACTS + 1] !== first)) out.limits.add("large_blocks");
    let sorted: Int32Array;
    if (fromEnd[block] === true) {
      const { rank, byRank } = backward();
      sorted = Int32Array.from(list, (i) => rank[i] ?? 0)
        .sort()
        .map((r) => place[byRank[r] ?? 0] ?? 0);
    } else {
      sorted = places.sort();
    }
    for (let x = 0; x < sorted.length; x += 1) {
      const p = sorted[x] ?? 0;
      if (uri[p] !== 0) continue;
      const from = Math.max(0, x - NEIGHBOURS);
      const to = Math.min(sorted.length - 1, x + NEIGHBOURS);
      for (let y = from; y <= to; y += 1) {
        const q = sorted[y] ?? 0;
        // Looking back, only at terms with a URI: a term without one before
        // this one already looked forward at it.
        if (y === x || (y < x && uri[q] !== 1)) continue;
        if (!visit(p, q)) return;
      }
    }
  }
}

/** A term's place in an order of all terms, and the term at each place. */
interface Order {
  readonly rank: Int32Array;
  readonly byRank: Int32Array;
}

/** How many bits of a 32-bit number are set. */
function bitCount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/**
 * A set of pairs of term positions (of a list of at most 65,535 terms), in
 * one typed array with open addressing, four bytes a pair: far less memory
 * and time than a `Set` of numbers that outgrow small integers. Pairs are
 * unordered.
 */
class PairSet {
  /**
   * Each pair is one number, lower × n + higher, which is below n² and so
   * at most n² - n - 1 and so below 2^32 - 1 (the empty mark -1 as 32 bits)
   * for n up to MAX_PAIR_SET_TERMS; stored as its 32 bits.
   */
  private table = new Int32Array(1 << 12).fill(-1);
  private size = 0;
  /**
   * Pairs of positions 1 to NEAR apart, which are most of them when the
   * positions are places in key order, as one bit each: bit d - 1 of the
   * lower position's NEAR bits. Far fewer cache misses than the table.
   */
  private readonly near: Int32Array;

  constructor(private readonly n: number) {
    if (n > MAX_PAIR_SET_TERMS) {
      throw new RangeError(`PairSet holds at most ${String(MAX_PAIR_SET_TERMS)} terms.`);
    }
    this.near = new Int32Array(n * (NEAR / 32));
  }

  /** Add the pair; false if it was there already. */
  add(i: number, j: number): boolean {
    const x = Math.min(i, j);
    const y = Math.max(i, j);
    const gap = y - x - 1;
    if (gap >= 0 && gap < NEAR) {
      const at = x * (NEAR / 32) + (gap >>> 5);
      const bit = 1 << (gap & 31);
      const word = this.near[at] ?? 0;
      if ((word & bit) !== 0) return false;
      this.near[at] = word | bit;
      return true;
    }
    const key = (x * this.n + y) | 0;
    const at = this.slot(key);
    if (this.table[at] !== -1) return false;
    this.table[at] = key;
    this.size += 1;
    if (this.size * 2 > this.table.length) this.grow();
    return true;
  }

  /** Where the pair is, or the empty slot where it would go. */
  private slot(key: number): number {
    const table = this.table;
    const mask = table.length - 1;
    // MurmurHash3's finaliser, so evenly spaced pairs spread.
    let h = Math.imul(key ^ (key >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    let at = (h ^ (h >>> 16)) & mask;
    for (;;) {
      const k = table[at] ?? -1;
      if (k === -1 || k === key) return at;
      at = (at + 1) & mask;
    }
  }

  private grow(): void {
    const old = this.table;
    this.table = new Int32Array(old.length * 2).fill(-1);
    for (const key of old) if (key !== -1) this.table[this.slot(key)] = key;
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
 * U+FFFF). See `codeDistance` for how it is worked out.
 */
export function boundedDistance(a: ArrayLike<string>, b: ArrayLike<string>, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const n = a.length;
  const m = b.length;
  // Compared as numbers, which is much faster than as one-letter strings.
  if (codesA.length < n) codesA = new Int32Array(n * 2);
  if (codesB.length < m) codesB = new Int32Array(m * 2);
  if (typeof a === "string" && typeof b === "string") {
    for (let k = 0; k < n; k += 1) codesA[k] = a.charCodeAt(k);
    for (let k = 0; k < m; k += 1) codesB[k] = b.charCodeAt(k);
  } else {
    // Lists of characters: number each different character.
    const ids = new Map<string, number>();
    const id = (c: string | undefined): number => {
      const key = c ?? "";
      let v = ids.get(key);
      if (v === undefined) ids.set(key, (v = ids.size));
      return v;
    };
    for (let k = 0; k < n; k += 1) codesA[k] = id(a[k]);
    for (let k = 0; k < m; k += 1) codesB[k] = id(b[k]);
  }
  return codeDistance(codesA, 0, n, codesB, 0, m, limit);
}

/**
 * `boundedDistance` of `n` characters of `ca` from `startA` and `m` of `cb`
 * from `startB`, given as numbers that are equal exactly when the
 * characters are (never negative).
 *
 * It follows diagonals rather than filling a table (Ukkonen, "Algorithms
 * for approximate string matching", 1985; Landau and Vishkin, 1989): cell
 * (i, j) is on diagonal j - i, and for e = 0, 1, … up to `limit` it keeps,
 * for each diagonal, the furthest row reachable with at most e edits. From
 * the furthest rows with e - 1 edits, one more edit (a substitution, an
 * insertion, a deletion, or a swap of the two characters after the furthest
 * row) gives a new row, and matching characters then slide it along its
 * diagonal for free. The distance is the first e that reaches the end. This
 * is the same table's answer because, along a diagonal, its values never go
 * down, so only the furthest row with each count matters; the tests check
 * it against the full table on every pair of short keys. Only diagonals
 * low to high are followed: a path of at most `limit` edits from diagonal 0
 * to diagonal m - n leaves the diagonal only by inserting or deleting, one
 * diagonal per edit, so it never goes further. The work is about
 * (limit + 1)² steps plus the characters slid over, so keys that differ
 * early are given up at once.
 */
function codeDistance(
  ca: Int32Array,
  startA: number,
  n: number,
  cb: Int32Array,
  startB: number,
  m: number,
  limit: number,
): number {
  const over = limit + 1;
  if (Math.abs(n - m) > limit) return over;
  const delta = m - n;
  const low = Math.ceil((delta - limit) / 2);
  const high = Math.floor((delta + limit) / 2);
  // One spare diagonal either side, never reached, so d - 1 and d + 1 can be
  // read without checks. Diagonal d is at d + shift.
  const width = high - low + 3;
  if (rowsA.length < width) {
    rowsA = new Int32Array(width * 2);
    rowsB = new Int32Array(width * 2);
  }
  let before = rowsA;
  let now = rowsB;
  before.fill(UNREACHED, 0, width);
  now.fill(UNREACHED, 0, width);
  const shift = 1 - low;
  /** Slide along diagonal d from row r while the characters match. */
  const slide = (r: number, d: number): number => {
    let row = r;
    while (row < n && row + d < m && ca[startA + row] === cb[startB + row + d]) row += 1;
    return row;
  };
  before[shift] = slide(0, 0);
  if (delta === 0 && before[shift] === n) return 0;
  for (let e = 1; e <= limit; e += 1) {
    const from = Math.max(low, -e);
    const to = Math.min(high, e);
    for (let d = from; d <= to; d += 1) {
      const at = d + shift;
      // Already reached with fewer edits.
      const stay = before[at] ?? UNREACHED;
      let r = stay;
      // A substitution: one row and one column on.
      if (stay >= 0 && stay < n && stay + d < m && stay + 1 > r) r = stay + 1;
      // An insertion: one column on, from diagonal d - 1.
      const inserted = before[at - 1] ?? UNREACHED;
      if (inserted >= 0 && inserted + d <= m && inserted > r) r = inserted;
      // A deletion: one row on, from diagonal d + 1.
      const deleted = before[at + 1] ?? UNREACHED;
      if (deleted >= 0 && deleted < n && deleted + 1 > r) r = deleted + 1;
      // A swap of the next two characters.
      if (
        stay >= 0 &&
        stay + 2 <= n &&
        stay + d + 2 <= m &&
        ca[startA + stay] === cb[startB + stay + d + 1] &&
        ca[startA + stay + 1] === cb[startB + stay + d] &&
        stay + 2 > r
      ) {
        r = stay + 2;
      }
      now[at] = r >= 0 ? slide(r, d) : UNREACHED;
    }
    if (now[delta + shift] === n) return e;
    const spare = before;
    before = now;
    now = spare;
  }
  return over;
}

/** A diagonal not reached (yet). */
const UNREACHED = -1_000_000_000;
/** Codes and diagonals for the distance, kept between calls (it never runs re-entrantly). */
let rowsA = new Int32Array(16);
let rowsB = new Int32Array(16);
let codesA = new Int32Array(64);
let codesB = new Int32Array(64);
