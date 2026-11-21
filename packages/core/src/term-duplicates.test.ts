import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUPLICATE_CANDIDATES,
  DUPLICATE_REASONS,
  boundedDistance,
  findNearDuplicateTerms,
  termMatchKey,
  termWords,
  type DuplicateCandidate,
} from "./index.js";

const RAILROADS = "http://id.loc.gov/authorities/subjects/sh85110904";
const HURRICANES = "http://id.loc.gov/authorities/subjects/sh85063195";

function find(terms: unknown[], maxCandidates?: number): readonly DuplicateCandidate[] {
  const r = findNearDuplicateTerms(terms, maxCandidates === undefined ? {} : { maxCandidates });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.candidates;
}

const summary = (c: readonly DuplicateCandidate[]): [number, number, string][] =>
  c.map((x) => [x.first, x.second, x.reason]);

describe("termWords and termMatchKey", () => {
  it("ignore case, accents, spacing and punctuation", () => {
    expect(termWords("Dickinson (Tex.)--History")).toEqual(["dickinson", "tex", "history"]);
    expect(termMatchKey("Rail-road  Depots")).toBe(termMatchKey("railroad depots"));
    expect(termMatchKey("Café")).toBe("cafe");
    expect(termMatchKey("Ｄｅｐｏｔ")).toBe("depot");
    expect(termMatchKey("St. Mary’s")).toBe("stmarys");
  });

  it("read & between words as 'and', and drop it inside a word", () => {
    expect(termWords("Smith & Sons")).toEqual(["smith", "and", "sons"]);
    expect(termWords("GH&H Railroad")).toEqual(["ghh", "railroad"]);
    expect(termWords("G.H.&H. Railroad")).toEqual(["ghh", "railroad"]);
  });
});

describe("boundedDistance", () => {
  const d = (a: string, b: string, limit = 2): number =>
    boundedDistance(Array.from(a), Array.from(b), limit);

  it("counts insertions, deletions, substitutions and neighbour swaps", () => {
    expect(d("depot", "depot")).toBe(0);
    expect(d("depot", "depots")).toBe(1);
    expect(d("depots", "depot")).toBe(1);
    expect(d("depot", "dapot")).toBe(1);
    expect(d("depot", "edpot")).toBe(1);
    expect(d("hurricanes", "huricanse")).toBe(2);
    expect(d("", "ab")).toBe(2);
  });

  it("stops at limit + 1", () => {
    expect(d("railroad", "highway")).toBe(3);
    expect(d("abc", "abcdef")).toBe(3);
    expect(d("abcdef", "badcfe", 1)).toBe(2);
    expect(d("x".repeat(400), "y".repeat(400))).toBe(3);
  });

  it("matches a full calculation on many invented pairs", () => {
    const full = (a: string, b: string): number => {
      const w = b.length + 1;
      const t = new Array<number>((a.length + 1) * w).fill(0);
      const at = (i: number, j: number): number => t[i * w + j] ?? 0;
      for (let j = 0; j <= b.length; j += 1) t[j] = j;
      for (let i = 0; i <= a.length; i += 1) t[i * w] = i;
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          let v = Math.min(
            at(i - 1, j) + 1,
            at(i, j - 1) + 1,
            at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            v = Math.min(v, at(i - 2, j - 2) + 1);
          }
          t[i * w + j] = v;
        }
      }
      return at(a.length, b.length);
    };
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 2000; k += 1) {
      const a = Array.from({ length: rand(9) }, () => "abc"[rand(3)]).join("");
      const b = Array.from({ length: rand(9) }, () => "abc"[rand(3)]).join("");
      for (const limit of [1, 2]) {
        expect(d(a, b, limit), `${a} ${b}`).toBe(Math.min(full(a, b), limit + 1));
      }
    }
  });
});

describe("findNearDuplicateTerms: reasons", () => {
  it("finds the same label written differently", () => {
    const c = find([
      { label: "Railroad depots" },
      { label: "railroad  depots" },
      { label: "Rail-road depots" },
    ]);
    expect(summary(c)).toEqual([
      [0, 1, "same_label"],
      [0, 2, "same_label"],
    ]);
    expect(c[0]?.message).toBe(
      '"Railroad depots" and "railroad  depots" differ only in capital letters, accents, spacing or punctuation.',
    );
  });

  it("finds the same words in another order, ignoring small words", () => {
    const c = find([{ label: "History of Dickinson" }, { label: "Dickinson history" }]);
    expect(summary(c)).toEqual([[0, 1, "same_words"]]);
  });

  it("finds an abbreviation (the Data Cleaning example)", () => {
    const c = find([
      { label: "Galveston, Houston and Henderson Railroad" },
      { label: "GH&H Railroad" },
    ]);
    expect(summary(c)).toEqual([[0, 1, "abbreviation"]]);
    expect(c[0]?.message).toBe(
      '"GH&H Railroad" may be an abbreviation of "Galveston, Houston and Henderson Railroad".',
    );
  });

  it("finds near spellings within the edit limit", () => {
    const c = find([
      { label: "Hurricanes" },
      { label: "Huricanes" },
      { label: "Strawberry industry" },
      { label: "Strawbery industyr" },
    ]);
    expect(c.map((x) => [x.first, x.second, x.reason, x.distance])).toEqual([
      [0, 1, "similar_spelling", 1],
      [2, 3, "similar_spelling", 2],
    ]);
    expect(c[0]?.message).toContain("(1 letter differs)");
    expect(c[1]?.message).toContain("(2 letters differ)");
  });

  it("finds a near spelling when no word is shared (prefix and ending blocks)", () => {
    expect(summary(find([{ label: "Depotz" }, { label: "Depots" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
    expect(summary(find([{ label: "Xepots" }, { label: "Depots" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
  });

  it("finds two entries with the same URI, even from outside vocabularies", () => {
    const c = find([
      { label: "Hurricanes", uri: HURRICANES, vocabulary: "lcsh" },
      { label: "Hurricanes (storms)", uri: HURRICANES, vocabulary: "lcsh" },
    ]);
    expect(summary(c)).toEqual([[0, 1, "same_uri"]]);
  });

  it("pairs a local term with a matching outside term", () => {
    const c = find([
      { label: "Railroads", uri: RAILROADS, vocabulary: "lcsh" },
      { label: "railroads", vocabulary: "local" },
    ]);
    expect(summary(c)).toEqual([[0, 1, "same_label"]]);
  });
});

describe("findNearDuplicateTerms: what it leaves alone", () => {
  it("never pairs two outside terms with different URIs", () => {
    expect(
      find([
        { label: "Railroads", uri: RAILROADS, vocabulary: "lcsh" },
        {
          label: "Railroads",
          uri: "http://id.loc.gov/authorities/names/n00000001",
          vocabulary: "lcnaf",
        },
        { label: "Railroad", vocabulary: "lcsh" },
      ]),
    ).toEqual([]);
  });

  it("doesn't pair labels whose numbers differ", () => {
    expect(find([{ label: "Hurricane, 1900" }, { label: "Hurricane, 1915" }])).toEqual([]);
    expect(find([{ label: "Box 12" }, { label: "Box 13" }])).toEqual([]);
  });

  it("doesn't compare short keys by spelling", () => {
    expect(find([{ label: "Ohio" }, { label: "Ohia" }])).toEqual([]);
  });

  it("doesn't pair different words", () => {
    expect(
      find([{ label: "Railroads" }, { label: "Hurricanes" }, { label: "Strawberry industry" }]),
    ).toEqual([]);
  });

  it("reports each pair once, under its strongest reason", () => {
    const c = find([{ label: "Depot" }, { label: "depot" }, { label: "Depots" }]);
    expect(summary(c)).toEqual([
      [0, 1, "same_label"],
      [0, 2, "similar_spelling"],
      [1, 2, "similar_spelling"],
    ]);
  });

  it("doesn't change its input", () => {
    const terms = [{ label: "Depot" }, { label: "depot" }];
    const before = JSON.stringify(terms);
    find(terms);
    expect(JSON.stringify(terms)).toBe(before);
  });
});

describe("findNearDuplicateTerms: results and limits", () => {
  it("orders by reason strength, then by index, and freezes the report", () => {
    const r = findNearDuplicateTerms([
      { label: "Huricanes" },
      { label: "Hurricanes" },
      { label: "Depot" },
      { label: "DEPOT" },
    ]);
    if (!r.ok) throw new Error("expected ok");
    expect(summary(r.value.candidates)).toEqual([
      [2, 3, "same_label"],
      [0, 1, "similar_spelling"],
    ]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.candidates)).toBe(true);
    expect(Object.isFrozen(r.value.candidates[0])).toBe(true);
    expect(DUPLICATE_REASONS[0]).toBe("same_uri");
  });

  it("caps the candidates and says so", () => {
    const terms = Array.from({ length: 30 }, () => ({ label: "Depot" }));
    const capped = findNearDuplicateTerms(terms, { maxCandidates: 5 });
    expect(capped.ok && [capped.value.candidates.length, capped.value.truncated]).toEqual([
      5,
      true,
    ]);
    const all = findNearDuplicateTerms(terms);
    expect(all.ok && [all.value.candidates.length, all.value.truncated]).toEqual([29, false]);
    const many = findNearDuplicateTerms(Array.from({ length: 600 }, () => ({ label: "Depot" })));
    expect(many.ok && many.value.candidates.length).toBe(DEFAULT_DUPLICATE_CANDIDATES);
  });

  it("returns an empty report for an empty list", () => {
    expect(findNearDuplicateTerms([])).toEqual({
      ok: true,
      value: { candidates: [], truncated: false },
    });
  });

  it("fails with every bad term's problem rather than skipping it", () => {
    const r = findNearDuplicateTerms([
      { label: "Depot" },
      { label: "" },
      { label: "X", uri: "https://example.org/x", vocabulary: "local" },
    ]);
    expect(r.ok ? [] : r.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["1.label", "invalid_text"],
      ["2.uri", "local_uri"],
    ]);
  });

  it("refuses bad input and options", () => {
    const code = (r: ReturnType<typeof findNearDuplicateTerms>): string | undefined =>
      r.ok ? undefined : r.issues[0]?.code;
    expect(code(findNearDuplicateTerms("Depot"))).toBe("not_a_list");
    expect(code(findNearDuplicateTerms([], { maxCandidates: 0 }))).toBe("invalid_option");
    expect(code(findNearDuplicateTerms([], { maxCandidates: 10_001 }))).toBe("invalid_option");
    expect(code(findNearDuplicateTerms([], { maxCandidates: 1.5 }))).toBe("invalid_option");
    expect(code(findNearDuplicateTerms([], null as never))).toBe("invalid_option");
  });
});
