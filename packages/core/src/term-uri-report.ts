/**
 * Library of Congress terms with no URI, for Data Cleaning (T-009a, D-014).
 *
 * A term from LCSH, LCNAF or LCGFT may be stored without a URI (D-014): a
 * heading built with subdivisions often has no authority record of its own,
 * and a term may have been typed in before anyone looked it up. Those terms
 * can't be linked in public output (it gives a label only) and can't be
 * matched to the same heading by URI. `findLcTermsWithoutUri` lists them so a
 * person can look each one up on id.loc.gov and add its URI, or decide it
 * has none. It never changes anything and never guesses a URI.
 *
 * Terms are grouped by vocabulary and exact label, so a heading used on many
 * records is one line with every place it was used. Groups come in
 * vocabulary order (LCSH, LCNAF, LCGFT), then by where they first appear.
 * Like `findNearDuplicateTerms`, a term the vocabulary rules refuse is left
 * out and listed in `skipped`, and the rest are still read; terms from other
 * vocabularies, and terms that have a URI, are not listed. Never throws.
 */
import { type Validated } from "./issues.js";
import { IssueList } from "./plain-data.js";
import { types } from "node:util";
import { MAX_DUPLICATE_TERMS, readTerm, type SkippedTerm } from "./term-duplicates.js";
import { type VocabularyCode } from "./vocabularies.js";

/** The vocabularies this report covers, in the order it lists them. */
export const LC_VOCABULARY_CODES = ["lcsh", "lcnaf", "lcgft"] as const;
export type LcVocabularyCode = (typeof LC_VOCABULARY_CODES)[number] & VocabularyCode;

/** One LC heading with no URI, and every position in the list where it was used. */
export interface TermWithoutUri {
  readonly vocabulary: LcVocabularyCode;
  readonly label: string;
  /** Positions in the list given, in order. */
  readonly indexes: readonly number[];
}

export interface TermsWithoutUriReport {
  readonly terms: readonly TermWithoutUri[];
  /** How many list items had no URI, per vocabulary (all of them, even past `maxTerms`). */
  readonly counts: Readonly<Record<LcVocabularyCode, number>>;
  /** True when there were more groups than `maxTerms`, so some aren't listed. */
  readonly truncated: boolean;
  /** Terms left out because the vocabulary rules refuse them, in index order. */
  readonly skipped: readonly SkippedTerm[];
}

export interface TermsWithoutUriOptions {
  /** How many groups to return, 1 to `MAX_TERMS_WITHOUT_URI`. Default 500. */
  readonly maxTerms?: number;
}

export const DEFAULT_TERMS_WITHOUT_URI = 500;
export const MAX_TERMS_WITHOUT_URI = 10_000;

const LC_ORDER: ReadonlyMap<string, number> = new Map(LC_VOCABULARY_CODES.map((c, i) => [c, i]));

/**
 * List the LCSH, LCNAF and LCGFT terms in `input` (a list of terms in the
 * `controlled_term` shape, at most `MAX_DUPLICATE_TERMS`) that have no URI.
 * Fails only when `input` isn't a readable list or `options` is bad.
 */
export function findLcTermsWithoutUri(
  input: unknown,
  options: TermsWithoutUriOptions = {},
): Validated<TermsWithoutUriReport> {
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
        `At most ${String(MAX_DUPLICATE_TERMS)} terms can be read at once.`,
      );
    }
    if (issues.count > 0) return { ok: false, issues: Object.freeze([...issues.items]) };
    const list = input as readonly unknown[];
    const length = list.length;
    // One Map of labels per vocabulary: labels are compared exactly, and a
    // Map can't be fooled by a label such as "__proto__".
    const groups = new Map<LcVocabularyCode, Map<string, { first: number; indexes: number[] }>>();
    const counts = { lcsh: 0, lcnaf: 0, lcgft: 0 };
    const skipped: SkippedTerm[] = [];
    for (let i = 0; i < length; i += 1) {
      const result = readTerm(list, i);
      if (!result.ok) {
        skipped.push(Object.freeze({ index: i, issues: result.issues }));
        continue;
      }
      const term = result.value;
      const code = term.vocabulary;
      if (term.uri !== undefined || code === undefined || !LC_ORDER.has(code)) continue;
      const vocab = code as LcVocabularyCode;
      counts[vocab] += 1;
      let labels = groups.get(vocab);
      if (labels === undefined) {
        labels = new Map();
        groups.set(vocab, labels);
      }
      const group = labels.get(term.label);
      if (group === undefined) labels.set(term.label, { first: i, indexes: [i] });
      else group.indexes.push(i);
    }
    const all: TermWithoutUri[] = [];
    for (const vocab of LC_VOCABULARY_CODES) {
      const labels = groups.get(vocab);
      if (labels === undefined) continue;
      // Map order is insertion order, which is the order of first use.
      for (const [label, group] of labels) {
        all.push(
          Object.freeze({ vocabulary: vocab, label, indexes: Object.freeze([...group.indexes]) }),
        );
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        terms: Object.freeze(all.slice(0, max)),
        counts: Object.freeze(counts),
        truncated: all.length > max,
        skipped: Object.freeze(skipped),
      }),
    };
  } catch {
    issues.add([], "unreadable", "The terms could not be read as plain data.");
    return { ok: false, issues: Object.freeze([...issues.items]) };
  }
}

function readMax(options: unknown, issues: IssueList): number {
  if (typeof options !== "object" || options === null) {
    issues.add(["options"], "invalid_option", "The options must be an object.");
    return DEFAULT_TERMS_WITHOUT_URI;
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "maxTerms");
  if (descriptor === undefined) return DEFAULT_TERMS_WITHOUT_URI;
  const value: unknown = "value" in descriptor ? descriptor.value : undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TERMS_WITHOUT_URI
  ) {
    issues.add(
      ["options", "maxTerms"],
      "invalid_option",
      `maxTerms must be a whole number from 1 to ${String(MAX_TERMS_WITHOUT_URI)}.`,
    );
    return DEFAULT_TERMS_WITHOUT_URI;
  }
  return value;
}
