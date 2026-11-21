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
 *   punctuation are ignored, and `&` is read as "and".
 * - `same_words`: the same words in another order, ignoring small words
 *   such as "and", "of" and "the" ("History of Dickinson", "Dickinson history").
 * - `abbreviation`: one label has the initials of a run of the other's words
 *   where the other has the words ("GH&H Railroad").
 * - `similar_spelling`: the comparison keys are at most 1 edit apart (2 for
 *   keys of 10 or more letters), counting a swap of two neighbouring letters
 *   as one edit. Keys shorter than 5 letters aren't compared this way.
 * For every reason but `same_uri`, the numbers in the two labels must be the
 * same numbers, as separate numbers: "Hurricane, 1900" and "Hurricane, 1915",
 * "Box 1-2" and "Box 12", "Size 1.5" and "Size 15" are never paired, because
 * a different number is a different thing.
 *
 * Which pairs are looked at: a pair where at least one term has no URI (every
 * local term, and outside terms entered without one). Two terms that both
 * have URIs are different terms unless the URIs match, so they are only
 * paired by `same_uri`. A group of terms sharing one key is reported as
 * pairs with one of its members, so n terms give n - 1 pairs, not n².
 *
 * Messy data doesn't stop the check: a term the vocabulary rules refuse is
 * left out and listed in `skipped` with its problems.
 *
 * It is not quadratic, and its work is budgeted. Exact reasons come from
 * grouping by a key in a Map. Spelling compares only terms that share a
 * block (a word, or the first or last three letters of the key); a block
 * with more than 20 terms is sorted and each term is compared with its 8
 * nearest neighbours. The spelling check's work is counted in character
 * cells (the two keys' lengths multiplied, for each pair compared) against
 * `MAX_SPELLING_CELLS`. When any limit cuts the search short, `truncated` is
 * true and `limitsReached` says which.
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

/** A term left out because it isn't a valid term. */
export interface SkippedTerm {
  readonly index: number;
  /** Its problems, with paths starting at its index. */
  readonly issues: readonly Issue[];
}

/**
 * A limit that cut the search short:
 * - `candidates`: more candidates were found than `maxCandidates`.
 * - `collected`: more than 100,000 candidates were found before sorting.
 * - `spelling_budget`: the spelling check used up `MAX_SPELLING_CELLS`.
 * - `large_blocks`: a block of different keys was compared by sorted
 *   neighbours only.
 * - `abbreviation_matches`: more than 20 labels had the same words, and only
 *   20 of them were checked as expansions of an abbreviation.
 * - `abbreviation_budget`: the abbreviation check used up its budget of
 *   `MAX_ABBREVIATION_CHARS` characters of expanded forms.
 * - `long_labels`: labels with more than 12 significant words weren't
 *   checked for abbreviations.
 */
export type DuplicateLimit =
  | "candidates"
  | "collected"
  | "spelling_budget"
  | "large_blocks"
  | "abbreviation_matches"
  | "abbreviation_budget"
  | "long_labels";

export interface DuplicateReport {
  /** Strongest reasons first, in `DUPLICATE_REASONS` order, then by index. */
  readonly candidates: readonly DuplicateCandidate[];
  /** True when there may be candidates that weren't found or returned. */
  readonly truncated: boolean;
  /** Which limits were reached; empty when the search was complete. */
  readonly limitsReached: readonly DuplicateLimit[];
  /** Terms left out because they aren't valid, in index order. */
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
 * The spelling check's work budget, in character cells: for each pair
 * compared, the product of the two keys' lengths (at least 64, for the fixed
 * cost of a comparison). Sized to keep the check under about a second.
 */
export const MAX_SPELLING_CELLS = 2_000_000_000;

/**
 * The abbreviation check's work budget: the characters of the shortened forms
 * it builds to look up. One is built only when its initials are a word some
 * label uses, so ordinary lists use a small part of this.
 */
export const MAX_ABBREVIATION_CHARS = 20_000_000;

/** A block bigger than this is compared by sorted neighbours, not all pairs. */
const BLOCK_ALL_PAIRS = 20;
const NEIGHBOURS = 8;
/** Abbreviations replace a run of 2 to 8 words, in labels of at most 12 significant words. */
const MIN_RUN = 2;
const MAX_RUN = 8;
const MAX_WORDS_FOR_ABBREVIATION = 12;
/** Labels kept for one word sequence, as expansions of an abbreviation. */
const MAX_PER_KEY = 20;
/** Candidates kept before sorting; past this the report is truncated. */
const MAX_COLLECTED = 100_000;
const MIN_CELLS_PER_PAIR = 64;

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
  /** The key as code points, for edit distance. */
  readonly chars: readonly string[];
  /** Words without the small words, in order. */
  readonly significant: readonly string[];
  /** The numbers in the label, each one separately, in order. */
  readonly numbers: string;
  /** The same numbers sorted, for `same_words`. */
  readonly sortedNumbers: string;
}

/**
 * Words of a label for comparison: accents and case removed, `.` and
 * apostrophes dropped, `&` inside a word dropped ("GH&H" → "ghh") and `&`
 * between words read as "and", then split at anything not a letter or digit.
 */
export function termWords(label: string): string[] {
  const text = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/(?<=[\p{L}\p{N}])&(?=[\p{L}\p{N}])/gu, "")
    .replace(/&/g, " and ");
  return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** The comparison key for a label: its words run together. */
export function termMatchKey(label: string): string {
  return termWords(label).join("");
}

/**
 * List pairs of terms that may be duplicates. `input` is a list of terms in
 * the `controlled_term` shape. Each is checked with `validateControlledTerm`;
 * one that fails is left out and listed in `skipped`, and the rest are still
 * compared. Fails only when `input` isn't a readable list or `options` is
 * bad. Never changes the input and never throws.
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
    const length = list.length;
    for (let i = 0; i < length; i += 1) {
      const result = readTerm(list, i);
      if (result.ok) terms.push(prepare(result.value, i));
      else skipped.push(Object.freeze({ index: i, issues: result.issues }));
    }
    return { ok: true, value: findIn(terms, max, Object.freeze(skipped)) };
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

function prepare(term: ControlledTerm, index: number): Prepared {
  const words = termWords(term.label);
  const key = words.join("");
  const numbers = term.label.normalize("NFKC").match(/\p{Nd}+/gu) ?? [];
  return {
    index,
    term,
    hasUri: term.uri !== undefined,
    key,
    chars: Array.from(key),
    significant: words.filter((w) => !SMALL_WORDS.has(w)),
    numbers: numbers.join(","),
    sortedNumbers: [...numbers].sort().join(","),
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

  /** Pairs worth a look: at least one term without a URI, or a shared URI. */
  eligible(i: number, j: number, reason: DuplicateReason): boolean {
    const a = this.terms[i];
    const b = this.terms[j];
    if (a === undefined || b === undefined || i === j) return false;
    if (reason === "same_uri") return true;
    const sameNumbers =
      reason === "same_words" ? a.sortedNumbers === b.sortedNumbers : a.numbers === b.numbers;
    return (!a.hasUri || !b.hasUri) && sameNumbers;
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
    const order: readonly DuplicateLimit[] = [
      "candidates",
      "collected",
      "spelling_budget",
      "large_blocks",
      "abbreviation_matches",
      "abbreviation_budget",
      "long_labels",
    ];
    const limitsReached = Object.freeze(order.filter((l) => this.limits.has(l)));
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
  max: number,
  skipped: readonly SkippedTerm[],
): DuplicateReport {
  const out = new Collector(terms, max);
  // Exact groupings, strongest first. The numbers are part of the key, so
  // "Box 1-2" and "Box 12" (key "box12" both) never meet.
  groupPairs(terms, out, "same_uri", (t) =>
    t.term.uri === undefined ? undefined : termUriKey(t.term.uri),
  );
  groupPairs(terms, out, "same_label", (t) => (t.key === "" ? undefined : `${t.numbers}|${t.key}`));
  groupPairs(terms, out, "same_words", (t) =>
    t.significant.length < 2
      ? undefined
      : `${t.sortedNumbers}|${[...t.significant].sort().join(" ")}`,
  );
  abbreviations(terms, out);
  spelling(terms, out);
  return out.report(skipped);
}

function groupPairs(
  terms: readonly Prepared[],
  out: Collector,
  reason: DuplicateReason,
  keyOf: (t: Prepared) => string | undefined,
): void {
  const groups = new Map<string, number[]>();
  terms.forEach((t, i) => {
    const key = keyOf(t);
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
  // Every label's significant words in order, so an expanded form can be looked up.
  const byWords = new Map<string, number[]>();
  terms.forEach((t, i) => {
    if (t.significant.length === 0) return;
    if (t.significant.length > MAX_WORDS_FOR_ABBREVIATION) {
      out.limits.add("long_labels");
      return;
    }
    const key = t.significant.join(" ");
    const list = byWords.get(key);
    if (list === undefined) byWords.set(key, [i]);
    else if (list.length < MAX_PER_KEY) list.push(i);
    // A label of one word can't be the expansion of an abbreviation.
    else if (t.significant.length >= MIN_RUN) out.limits.add("abbreviation_matches");
  });
  // Words that could be an abbreviation: a short form is only built when its
  // initials are one of these, which keeps the work small.
  const shortWords = new Set<string>();
  for (const key of byWords.keys()) {
    for (const w of key.split(" "))
      if (w.length >= MIN_RUN && w.length <= MAX_RUN) shortWords.add(w);
  }
  let chars = 0;
  for (let j = 0; j < terms.length; j += 1) {
    const words = terms[j]?.significant ?? [];
    if (words.length < MIN_RUN || words.length > MAX_WORDS_FOR_ABBREVIATION) continue;
    if (out.full) return;
    for (let start = 0; start < words.length; start += 1) {
      let initials = "";
      for (let len = 1; len <= MAX_RUN && start + len <= words.length; len += 1) {
        const w = words[start + len - 1] ?? "";
        // Initials of words that are numbers would make "1900 1915" into "11".
        if (/^\p{N}/u.test(w)) break;
        initials += Array.from(w)[0] ?? "";
        if (len < MIN_RUN || !shortWords.has(initials)) continue;
        const short = [...words.slice(0, start), initials, ...words.slice(start + len)].join(" ");
        chars += short.length;
        if (chars > MAX_ABBREVIATION_CHARS) {
          out.limits.add("abbreviation_budget");
          return;
        }
        for (const i of byWords.get(short) ?? []) {
          if (!out.has(i, j)) out.add(i, j, "abbreviation");
        }
      }
    }
  }
}

function spelling(terms: readonly Prepared[], out: Collector): void {
  const blocks = new Map<string, number[]>();
  const put = (key: string, i: number): void => {
    const list = blocks.get(key);
    if (list === undefined) blocks.set(key, [i]);
    else list.push(i);
  };
  terms.forEach((t, i) => {
    if (t.chars.length < 5) return;
    for (const w of new Set(t.significant)) if (w.length >= 3) put(`w:${w}`, i);
    put(`p:${t.chars.slice(0, 3).join("")}`, i);
    put(`s:${t.chars.slice(-3).join("")}`, i);
  });
  // A pair that shares several blocks is compared once.
  const compared = new Set<number>();
  let cells = 0;
  const compare = (i: number, j: number): boolean => {
    const a = terms[i];
    const b = terms[j];
    if (a === undefined || b === undefined) return true;
    const cost = Math.max(MIN_CELLS_PER_PAIR, a.chars.length * b.chars.length);
    if (cells + cost > MAX_SPELLING_CELLS || out.full) {
      out.limits.add(out.full ? "collected" : "spelling_budget");
      return false;
    }
    const id = pairId(i, j, terms.length);
    if (compared.has(id)) return true;
    // Checks that need no edit distance are charged the fixed cost only.
    if (out.has(i, j) || !out.eligible(i, j, "similar_spelling") || a.key === b.key) {
      cells += MIN_CELLS_PER_PAIR;
      return true;
    }
    cells += cost;
    compared.add(id);
    const limit = Math.min(a.chars.length, b.chars.length) >= 10 ? 2 : 1;
    const d = boundedDistance(a.chars, b.chars, limit);
    if (d <= limit) out.add(i, j, "similar_spelling", d);
    return true;
  };
  for (const [key, list] of blocks) {
    if (list.length < 2) continue;
    if (list.length <= BLOCK_ALL_PAIRS) {
      for (let x = 0; x < list.length; x += 1) {
        for (let y = x + 1; y < list.length; y += 1) {
          if (!compare(list[x] ?? 0, list[y] ?? 0)) return;
        }
      }
      continue;
    }
    // Sorted neighbourhood: sort by the key (by the reversed key for a
    // block of shared endings) and compare each term with the next few.
    // Only neighbours are compared, so a pair further apart can be missed,
    // unless every key in the block is the same (then there is nothing to find).
    const first = terms[list[0] ?? 0]?.key;
    if (list.some((i) => terms[i]?.key !== first)) out.limits.add("large_blocks");
    const reversed = key.startsWith("s:");
    const sortKey = (i: number): string => {
      const chars = terms[i]?.chars ?? [];
      return (reversed ? [...chars].reverse() : chars).join("");
    };
    const sorted = list
      .map((i) => [sortKey(i), i] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]))
      .map(([, i]) => i);
    for (let x = 0; x < sorted.length; x += 1) {
      for (let y = x + 1; y <= x + NEIGHBOURS && y < sorted.length; y += 1) {
        if (!compare(sorted[x] ?? 0, sorted[y] ?? 0)) return;
      }
    }
  }
}

/**
 * The optimal string alignment distance between `a` and `b` (insertions,
 * deletions, substitutions and swaps of two neighbouring characters), or
 * `limit + 1` as soon as it is known to be more than `limit`. Only cells
 * within `limit` of the diagonal are computed, so the cost is about
 * length × (2 × limit + 1).
 */
export function boundedDistance(a: readonly string[], b: readonly string[], limit: number): number {
  const over = limit + 1;
  if (Math.abs(a.length - b.length) > limit) return over;
  const n = a.length;
  const m = b.length;
  // Three rows, reused: two back (for swaps), previous and current. Each row
  // is written only around its band, plus one cell either side set to
  // "over", which is all the next rows read.
  let prev2 = new Array<number>(m + 1).fill(over);
  let prev = new Array<number>(m + 1).fill(over);
  let cur = new Array<number>(m + 1).fill(over);
  for (let j = 0; j <= Math.min(m, limit); j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    const from = Math.max(1, i - limit);
    const to = Math.min(m, i + limit);
    for (let j = Math.max(0, from - 1); j <= Math.min(m, to + 1); j += 1) cur[j] = over;
    let best = over;
    if (from === 1) {
      cur[0] = i <= limit ? i : over;
      best = cur[0];
    }
    for (let j = from; j <= to; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] ?? over) + 1,
        (cur[j - 1] ?? over) + 1,
        (prev[j - 1] ?? over) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? over) + 1);
      }
      v = Math.min(v, over);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return over;
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return Math.min(prev[m] ?? over, over);
}
