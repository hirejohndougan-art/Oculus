import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMS_WITHOUT_URI,
  MAX_DUPLICATE_TERMS,
  MAX_TERMS_WITHOUT_URI,
  type TermsWithoutUriReport,
} from "./index.js";
import { findLcTermsWithoutUriOf as findLcTermsWithoutUri } from "./stored-terms.fixtures.js";

const RAILROADS = "http://id.loc.gov/authorities/subjects/sh85110904";

function report(terms: unknown, maxTerms?: number): TermsWithoutUriReport {
  const r = findLcTermsWithoutUri(terms, maxTerms === undefined ? {} : { maxTerms });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

describe("findLcTermsWithoutUri", () => {
  it("lists LCSH, LCNAF and LCGFT terms with no URI, and nothing else", () => {
    const r = report([
      { label: "Railroads", vocabulary: "lcsh", uri: RAILROADS },
      { label: "Dickinson (Tex.)--History", vocabulary: "lcsh" },
      { label: "Postcards", vocabulary: "lcgft" },
      { label: "Smith, John, 1850-1920", vocabulary: "lcnaf" },
      { label: "Depot", vocabulary: "local" },
      { label: "Depot" },
      { label: "Bottle", vocabulary: "nomenclature" },
      { label: "Dickinson", vocabulary: "gnis" },
    ]);
    expect(r.terms).toEqual([
      { vocabulary: "lcsh", label: "Dickinson (Tex.)--History", indexes: [1] },
      { vocabulary: "lcnaf", label: "Smith, John, 1850-1920", indexes: [3] },
      { vocabulary: "lcgft", label: "Postcards", indexes: [2] },
    ]);
    expect(r.counts).toEqual({ lcsh: 1, lcnaf: 1, lcgft: 1 });
    expect(r.truncated).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it("groups one heading used many times, by exact label and vocabulary", () => {
    const r = report([
      { label: "Hurricanes", vocabulary: "lcsh" },
      { label: "Hurricanes", vocabulary: "lcgft" },
      { label: "hurricanes", vocabulary: "lcsh" },
      { label: "Hurricanes", vocabulary: "lcsh" },
      {
        label: "Hurricanes",
        vocabulary: "lcsh",
        uri: "http://id.loc.gov/authorities/subjects/sh85063195",
      },
    ]);
    expect(r.terms).toEqual([
      { vocabulary: "lcsh", label: "Hurricanes", indexes: [0, 3] },
      { vocabulary: "lcsh", label: "hurricanes", indexes: [2] },
      { vocabulary: "lcgft", label: "Hurricanes", indexes: [1] },
    ]);
    expect(r.counts).toEqual({ lcsh: 3, lcnaf: 0, lcgft: 1 });
  });

  it("treats labels such as __proto__ as ordinary text", () => {
    const r = report([
      { label: "__proto__", vocabulary: "lcsh" },
      { label: "constructor", vocabulary: "lcsh" },
      { label: "__proto__", vocabulary: "lcsh" },
    ]);
    expect(r.terms.map((t) => [t.label, t.indexes])).toEqual([
      ["__proto__", [0, 2]],
      ["constructor", [1]],
    ]);
  });

  it("skips terms the vocabulary rules refuse, and a getter term (via the wrapper), and reads the rest", () => {
    const list: unknown[] = [
      {
        label: "Railroads",
        vocabulary: "lcsh",
        uri: "https://id.loc.gov/authorities/subjects/sh85110904",
      },
      { label: " Spaces ", vocabulary: "lcsh" },
      { label: "Parks", vocabulary: "lcsh" },
      "not a term",
    ];
    // The wrapper (stored-terms.fixtures.ts) moves this slot getter onto the
    // entry's `term`, so this is a getter term: one entry's problem. A getter
    // slot or a hole refuses the whole list (stored-terms.attacks.test.ts).
    Object.defineProperty(list, 4, {
      get: () => ({ label: "x", vocabulary: "lcsh" }),
      enumerable: true,
    });
    const r = report(list);
    expect(r.terms).toEqual([{ vocabulary: "lcsh", label: "Parks", indexes: [2] }]);
    expect(r.skipped.map((s) => [s.index, s.issues[0]?.code])).toEqual([
      [0, "not_canonical"],
      [1, "invalid_text"],
      [3, "not_an_object"],
      [4, "not_plain_data"],
    ]);
    expect(r.skipped[0]?.issues[0]?.path).toEqual([0, "term", "uri"]);
  });

  it("returns at most maxTerms groups, counts every term, and says it was cut short", () => {
    const terms = Array.from({ length: 30 }, (_, i) => ({
      label: `Heading ${String(i)}`,
      vocabulary: "lcsh",
    }));
    const r = report(terms, 10);
    expect(r.terms).toHaveLength(10);
    expect(r.terms[9]?.label).toBe("Heading 9");
    expect(r.counts.lcsh).toBe(30);
    expect(r.truncated).toBe(true);
    expect(report(terms, 30).truncated).toBe(false);
  });

  it("defaults to 500 groups", () => {
    const terms = Array.from({ length: 501 }, (_, i) => ({
      label: `H ${String(i)}`,
      vocabulary: "lcnaf",
    }));
    const r = report(terms);
    expect(DEFAULT_TERMS_WITHOUT_URI).toBe(500);
    expect(r.terms).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  it("returns frozen results and never changes the input", () => {
    const input = [{ label: "Parks", vocabulary: "lcsh" }];
    const copy = structuredClone(input);
    const r = report(input);
    expect(input).toEqual(copy);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.terms)).toBe(true);
    expect(Object.isFrozen(r.terms[0])).toBe(true);
    expect(Object.isFrozen(r.terms[0]?.indexes)).toBe(true);
    expect(Object.isFrozen(r.counts)).toBe(true);
  });

  it("refuses what isn't an ordinary list, too many terms, and bad options", () => {
    const codes = (input: unknown, options?: unknown): string[] => {
      const r = findLcTermsWithoutUri(input, options as never);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes("x")).toEqual(["not_a_list"]);
    expect(codes({ length: 1, 0: {} })).toEqual(["not_a_list"]);
    expect(codes(new Proxy([], {}))).toEqual(["not_a_list"]);
    class Sub extends Array {}
    expect(codes(new Sub())).toEqual(["not_a_list"]);
    expect(codes(new Array(MAX_DUPLICATE_TERMS + 1))).toEqual(["too_many"]);
    for (const maxTerms of [0, -1, 1.5, MAX_TERMS_WITHOUT_URI + 1, "10", Number.NaN]) {
      expect(codes([], { maxTerms }), String(maxTerms)).toEqual(["invalid_option"]);
    }
    expect(codes([], null)).toEqual(["invalid_option"]);
    const getter = Object.defineProperty({}, "maxTerms", { get: () => 5 });
    expect(codes([], getter)).toEqual(["invalid_option"]);
  });

  it("reads 50,000 terms quickly", () => {
    const terms = Array.from({ length: MAX_DUPLICATE_TERMS }, (_, i) => ({
      label: `Heading ${String(i % 1000)}`,
      vocabulary: i % 2 === 0 ? "lcsh" : "local",
    }));
    const start = performance.now();
    const r = report(terms, MAX_TERMS_WITHOUT_URI);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(r.counts.lcsh).toBe(25_000);
    expect(r.terms).toHaveLength(500);
    expect(r.terms[0]?.indexes).toHaveLength(50);
  });
});
