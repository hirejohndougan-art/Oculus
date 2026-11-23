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
import {
  boundedDistance as referenceDistance,
  findNearDuplicateTerms as referenceFind,
} from "./term-duplicates.fixtures.js";
import { cpuClock, hangGuard } from "./cpu-time.fixtures.js";

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

  it("join spaced initials into one word", () => {
    expect(termWords("G. H. & H. Railroad")).toEqual(["ghh", "railroad"]);
    expect(termWords("G H H Railroad")).toEqual(["ghh", "railroad"]);
    expect(termWords("G H and H Railroad")).toEqual(["ghh", "railroad"]);
  });

  it("keep a decimal point between digits as a break", () => {
    expect(termWords("Size 1.5 inches")).toEqual(["size", "1", "5", "inches"]);
  });

  it("remove accents only from Latin, Greek and Cyrillic letters", () => {
    expect(termMatchKey("Ἀθῆναι")).toBe("αθηναι");
    expect(termMatchKey("Ёлка")).toBe("елка");
    // Devanagari vowel signs are letters of the word, not accents.
    expect(termMatchKey("कमल")).not.toBe(termMatchKey("कमला"));
    expect(termMatchKey("किताब")).not.toBe(termMatchKey("कातिब"));
    expect(termMatchKey("किताब")).toBe("किताब".normalize("NFKD"));
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

  it("takes a limit past the keys' length, or one that isn't a number, as their length", () => {
    // The work and the memory follow the limit, so a huge limit must not
    // make it allocate for that limit (it used to be bounded by the keys).
    const full = (a: string, b: string, limit: number): number =>
      referenceDistance(Array.from(a), Array.from(b), limit);
    let seed = 3;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 500; k += 1) {
      const a = Array.from({ length: rand(10) }, () => "abc"[rand(3)]).join("");
      const b = Array.from({ length: rand(10) }, () => "abc"[rand(3)]).join("");
      const exact = full(a, b, Math.max(a.length, b.length));
      for (const limit of [Math.max(a.length, b.length), 1e9, Number.POSITIVE_INFINITY, NaN]) {
        expect(boundedDistance(a, b, limit), `${a} ${b} ${String(limit)}`).toBe(exact);
        expect(boundedDistance(Array.from(a), Array.from(b), limit)).toBe(exact);
      }
    }
    expect(boundedDistance("abc", "abd", Number.POSITIVE_INFINITY)).toBe(1);
    expect(boundedDistance("a".repeat(600), "b".repeat(600), 1e9)).toBe(600);
  });

  // Its limit was vitest's default 5-second timeout; now it is CPU time
  // (U-003), so a busy machine can't fail it. The timeout is a hang guard.
  it(
    "gives what the code before S-005a gave, for strings and lists, on every short pair",
    hangGuard(5000),
    () => {
      const elapsed = cpuClock();
      // Every pair of keys of up to 7 letters from two letters, then long
      // random keys from two and three letters: the narrower band and the
      // strings read as needed must not change a single answer.
      const keys = [""];
      for (let length = 1; length <= 7; length += 1) {
        for (let x = 0; x < 2 ** length; x += 1) {
          keys.push(Array.from({ length }, (_, k) => ((x >> k) & 1 ? "b" : "a")).join(""));
        }
      }
      const check = (a: string, b: string, limit: number): void => {
        const expected = referenceDistance(Array.from(a), Array.from(b), limit);
        expect(boundedDistance(a, b, limit), `${a} ${b} ${String(limit)}`).toBe(expected);
        expect(boundedDistance(Array.from(a), Array.from(b), limit)).toBe(expected);
      };
      for (const a of keys) {
        for (const b of keys) {
          if (Math.abs(a.length - b.length) <= 3) for (const limit of [1, 2, 3]) check(a, b, limit);
        }
      }
      let seed = 11;
      const rand = (n: number): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let k = 0; k < 20_000; k += 1) {
        const letters = k % 2 === 0 ? "ab" : "abc";
        const a = Array.from({ length: 10 + rand(50) }, () => letters[rand(letters.length)]).join(
          "",
        );
        // Mostly near copies, so many pairs are within the limit.
        let b = a;
        for (let e = rand(4); e > 0; e -= 1) {
          const at = rand(b.length + 1);
          const c = letters[rand(letters.length)] ?? "a";
          const op = rand(4);
          if (op === 0) b = b.slice(0, at) + c + b.slice(at);
          else if (op === 1) b = b.slice(0, at) + b.slice(at + 1);
          else if (op === 2) b = b.slice(0, at) + c + b.slice(at + 1);
          else b = b.slice(0, at) + b.slice(at + 1, at + 2) + b.slice(at, at + 1) + b.slice(at + 2);
        }
        if (k % 5 === 0)
          b = Array.from({ length: a.length + rand(3) }, () => letters[rand(2)]).join("");
        check(a, b, 1 + rand(2));
      }
      expect(elapsed()).toBeLessThan(5000);
    },
  );
});

describe("findNearDuplicateTerms finds what the code before S-005a found", () => {
  // Randomized lists built to reach every part of the search: abbreviations
  // and their expanded forms, near spellings from two or three letters (big
  // blocks of different keys, compared by sorted neighbours), designators,
  // terms with URIs, copies and short keys. The whole report must be the same.
  const makeTerms = (seed: number, size: number): unknown[] => {
    let s = seed;
    const rand = (n: number): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.floor((s / 2 ** 32) * n);
    };
    const pick = <T>(list: readonly T[]): T => list[rand(list.length)] as T;
    // Deseret letters are above U+FFFF (two UTF-16 units each).
    const plain = [
      "Galveston",
      "Houston",
      "Henderson",
      "Railroad",
      "Depot",
      "Bay",
      "Clear",
      "Creek",
      "𐐔𐐯𐑅𐐨𐑉𐐯𐐻",
      "𐐨𐐯𐐻",
    ];
    const twoLetter = ["ab", "ba", "aab", "abab", "bbaa", "abba", "baab", "aaa", "bbb"];
    const designators = ["", "", "", " 2", " 1900", " II", " 12a", " B"];
    const terms: unknown[] = [];
    for (let i = 0; i < size; i += 1) {
      const shape = rand(10);
      let label: string;
      if (shape < 4) {
        label = Array.from({ length: 1 + rand(11) }, () => pick(twoLetter)).join(" ");
      } else if (shape < 7) {
        label = Array.from({ length: 2 + rand(6) }, () => pick(plain)).join(" ");
      } else if (shape < 9 && terms.length > 0) {
        // An earlier label changed: a run of words shortened to initials,
        // a letter changed, or two neighbouring letters swapped.
        const earlier = (pick(terms) as { label: string }).label;
        const words = earlier.split(" ");
        const change = rand(3);
        if (change === 0 && words.length >= 2) {
          const start = rand(words.length - 1);
          const len = 2 + rand(Math.min(7, words.length - start - 1));
          const initials = words
            .slice(start, start + len)
            .map((w) => Array.from(w)[0] ?? "")
            .join(rand(2) === 0 ? "" : " ");
          label = [...words.slice(0, start), initials, ...words.slice(start + len)].join(" ");
        } else {
          const at = rand(Math.max(1, earlier.length - 1));
          label =
            change === 1
              ? earlier.slice(0, at) + pick(["a", "b", "x"]) + earlier.slice(at + 1)
              : earlier.slice(0, at) +
                earlier.slice(at + 1, at + 2) +
                earlier.slice(at, at + 1) +
                earlier.slice(at + 2);
        }
      } else if (rand(2) === 0) {
        // Keys of more than 128 letters, which the spelling check reads
        // another way.
        label = Array.from({ length: 18 + rand(6) }, () => pick(plain)).join(" ");
      } else {
        label = pick(plain);
      }
      label = (label.trim() || "Depot") + pick(designators);
      terms.push(
        rand(8) === 0
          ? { label, uri: `https://example.org/gnis/${String(rand(50))}`, vocabulary: "gnis" }
          : { label },
      );
    }
    return terms;
  };

  // The 60 seconds that were the test's timeout are CPU time now (U-003).
  it("on many randomized lists of terms", hangGuard(60_000), () => {
    const elapsed = cpuClock();
    let pairs = 0;
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const terms = makeTerms(seed, seed % 4 === 0 ? 3000 : 400);
      const now = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
      const before = referenceFind(terms, { maxCandidates: 10_000 });
      expect(now, `seed ${String(seed)}`).toEqual(before);
      if (now.ok) {
        pairs += now.value.candidates.length;
        for (const c of now.value.candidates) reasons.add(c.reason);
      }
    }
    // The lists really did reach every reason, so the comparison means something.
    expect(pairs).toBeGreaterThan(1000);
    expect([...reasons].sort()).toEqual([...DUPLICATE_REASONS].sort());
    expect(elapsed()).toBeLessThan(60_000);
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
  it("never pairs two terms that both have URIs, unless the URIs match", () => {
    expect(
      find([
        { label: "Railroads", uri: RAILROADS, vocabulary: "lcsh" },
        {
          label: "Railroads",
          uri: "http://id.loc.gov/authorities/names/n00000001",
          vocabulary: "lcnaf",
        },
        { label: "Railroad", uri: "https://example.org/gnis/1", vocabulary: "gnis" },
      ]),
    ).toEqual([]);
  });

  it("does compare outside terms entered without a URI", () => {
    expect(
      summary(
        find([
          { label: "Railroads", vocabulary: "lcsh" },
          { label: "railroads", vocabulary: "lcsh" },
          { label: "Railroad", uri: RAILROADS, vocabulary: "lcsh" },
        ]),
      ),
    ).toEqual([
      [0, 1, "same_label"],
      [0, 2, "similar_spelling"],
      [1, 2, "similar_spelling"],
    ]);
  });

  it("doesn't pair labels whose numbers differ", () => {
    expect(find([{ label: "Hurricane, 1900" }, { label: "Hurricane, 1915" }])).toEqual([]);
    expect(find([{ label: "Box 12" }, { label: "Box 13" }])).toEqual([]);
  });

  it("treats numbers as separate numbers for every reason", () => {
    // Same key once punctuation and spaces go, but different numbers.
    expect(find([{ label: "Box 1-2" }, { label: "Box 12" }])).toEqual([]);
    expect(find([{ label: "Size 1.5 inches" }, { label: "Size 15 inches" }])).toEqual([]);
    expect(find([{ label: "Route 6, 6" }, { label: "Route 66" }])).toEqual([]);
    // Same words in another order, numbers split differently.
    expect(find([{ label: "Box 1 2 depot" }, { label: "depot box 12" }])).toEqual([]);
    // An abbreviation whose numbers differ.
    expect(
      find([{ label: "Galveston Houston Henderson Railroad 1 2" }, { label: "GHH Railroad 12" }]),
    ).toEqual([]);
    // The same numbers still pair.
    expect(summary(find([{ label: "Box 1-2" }, { label: "box 1 2" }]))).toEqual([
      [0, 1, "same_label"],
    ]);
    expect(summary(find([{ label: "Depot 1900, box 3" }, { label: "box 3 depot 1900" }]))).toEqual([
      [0, 1, "same_words"],
    ]);
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
    expect(
      capped.ok && [
        capped.value.candidates.length,
        capped.value.truncated,
        capped.value.limitsReached,
      ],
    ).toEqual([5, true, ["candidates"]]);
    const all = findNearDuplicateTerms(terms);
    expect(all.ok && [all.value.candidates.length, all.value.truncated]).toEqual([29, false]);
    const many = findNearDuplicateTerms(Array.from({ length: 600 }, () => ({ label: "Depot" })));
    expect(many.ok && many.value.candidates.length).toBe(DEFAULT_DUPLICATE_CANDIDATES);
  });

  it("returns an empty report for an empty list", () => {
    expect(findNearDuplicateTerms([])).toEqual({
      ok: true,
      value: { candidates: [], truncated: false, limitsReached: [], skipped: [] },
    });
  });

  it("skips invalid terms, lists them with their problems, and compares the rest", () => {
    const r = findNearDuplicateTerms([
      { label: "Depot" },
      { label: "" },
      { label: "X", uri: "https://example.org/x", vocabulary: "local" },
      { label: "depot" },
      "Depot",
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(summary(r.value.candidates)).toEqual([[0, 3, "same_label"]]);
    expect(
      r.value.skipped.map((x) => [x.index, x.issues.map((i) => [i.path.join("."), i.code])]),
    ).toEqual([
      [1, [["1.label", "invalid_text"]]],
      [2, [["2.uri", "local_uri"]]],
      [4, [["4", "not_an_object"]]],
    ]);
    expect(Object.isFrozen(r.value.skipped)).toBe(true);
    expect(r.value.truncated).toBe(false);
  });

  it("matches URIs by termUriKey, so http and https copies are the same", () => {
    const c = find([
      { label: "Lantern", uri: "http://nomenclature.info/nom/1234", vocabulary: "nomenclature" },
      { label: "Lanterns", uri: "https://NOMENCLATURE.info/nom/1234/", vocabulary: "nomenclature" },
      { label: "Lamp", uri: "https://nomenclature.info/nom/1235", vocabulary: "nomenclature" },
    ]);
    expect(summary(c)).toEqual([[0, 1, "same_uri"]]);
  });

  it("never pairs labels told apart by a letter, Roman numeral or letter-digit designator", () => {
    for (const [a, b] of [
      ["World War I", "World War II"],
      ["Henry VII", "Henry VIII"],
      ["Louis XIV", "Louis XV"],
      ["Box 12a", "Box 12b"],
      ["Folder A", "Folder B"],
      ["Series 1A", "Series 1B"],
      ["Railroad depot, part I", "Railroad depot, part V"],
    ] as const) {
      expect(find([{ label: a }, { label: b }]), `${a} / ${b}`).toEqual([]);
    }
    // The same designators still pair, and "a" is an article, not a designator.
    expect(summary(find([{ label: "World War II" }, { label: "world war II" }]))).toEqual([
      [0, 1, "same_label"],
    ]);
    expect(summary(find([{ label: "A history of Texas" }, { label: "Texas history" }]))).toEqual([
      [0, 1, "same_words"],
    ]);
  });

  it("pairs spaced initials with the full name", () => {
    const c = find([
      { label: "Galveston, Houston and Henderson Railroad" },
      { label: "G. H. & H. Railroad" },
      { label: "G H H Railroad" },
    ]);
    expect(summary(c)).toEqual([
      [1, 2, "same_label"],
      [0, 1, "abbreviation"],
    ]);
  });

  it("finds an abbreviation however many copies of it there are", () => {
    const r = findNearDuplicateTerms(
      [
        { label: "Galveston Houston Henderson" },
        ...Array.from({ length: 21 }, () => ({ label: "GHH" })),
      ],
      { maxCandidates: 1000 },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.candidates.filter((c) => c.reason === "abbreviation")).toHaveLength(1);
    expect(r.value.limitsReached).toEqual([]);
  });

  it("finds every pair one edit apart among short keys, whatever the position", () => {
    // No shared word, prefix or ending: found through keys with a letter removed.
    expect(summary(find([{ label: "Depot" }, { label: "Dexot" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
    expect(summary(find([{ label: "Depot" }, { label: "Deopt" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
    expect(summary(find([{ label: "Depots" }, { label: "Depos" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
  });

  it("finds long keys changed at both ends through their middle letters", () => {
    expect(summary(find([{ label: "Xailroadstations" }, { label: "railroadstationZ" }]))).toEqual([
      [0, 1, "similar_spelling"],
    ]);
  });

  it("finds every pair within the edit limit among many keys with the same letters", () => {
    // Keys from six letters, each a few edits from one of eight stems: every
    // pair a full comparison finds must be found, none passed over unworked.
    let seed = 11;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * n);
    };
    const letters = "abcdef";
    const stems = Array.from({ length: 8 }, (_, k) =>
      Array.from({ length: 5 + k }, () => letters[rand(6)]).join(""),
    );
    const labels = Array.from({ length: 48 }, () => {
      const key = Array.from(stems[rand(8)] ?? "");
      for (let e = rand(3); e > 0; e -= 1) {
        const at = rand(key.length);
        const kind = rand(3);
        if (kind === 0) key.splice(at, 1);
        else if (kind === 1) key.splice(at, 0, letters[rand(6)] ?? "");
        else key[at] = letters[rand(6)] ?? "";
      }
      return key.join("");
    });
    const r = findNearDuplicateTerms(
      labels.map((label) => ({ label })),
      { maxCandidates: 10_000 },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.limitsReached).toEqual([]);
    const found = new Set(r.value.candidates.map((c) => `${String(c.first)} ${String(c.second)}`));
    let near = 0;
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i] ?? "";
        const b = labels[j] ?? "";
        if (a === b || Math.min(a.length, b.length) < 5) continue;
        const limit = Math.min(a.length, b.length) >= 10 ? 2 : 1;
        if (boundedDistance(a, b, limit) > limit) continue;
        near += 1;
        expect(found.has(`${String(i)} ${String(j)}`), `${a} ${b}`).toBe(true);
      }
    }
    expect(near).toBeGreaterThan(20);
  });

  it("doesn't mark an ordinary long heading as truncated", () => {
    const r = findNearDuplicateTerms([
      {
        label:
          "Galveston, Houston and Henderson Railroad Company--History--19th century--Pictorial works--Texas--Galveston County--Maps--Sources",
      },
    ]);
    expect(r.ok && [r.value.truncated, r.value.limitsReached]).toEqual([false, []]);
  });

  it("only compares URIs when every term has one", () => {
    const r = findNearDuplicateTerms([
      { label: "Depot", uri: "https://example.org/gnis/1", vocabulary: "gnis" },
      { label: "Depot", uri: "https://example.org/gnis/2", vocabulary: "gnis" },
      { label: "Depot", uri: "http://example.org/gnis/1", vocabulary: "gnis" },
    ]);
    expect(r.ok && summary(r.value.candidates)).toEqual([[0, 2, "same_uri"]]);
  });

  it("says which limits cut the search short", () => {
    const limits = (terms: unknown[]): readonly string[] => {
      const r = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
      return r.ok ? r.value.limitsReached : ["failed"];
    };
    // 25 different keys sharing a word: only neighbours are compared.
    const letters = "abcdefghijklmnopqrstuvwxy";
    expect(limits(Array.from(letters, (ch) => ({ label: `Depot ${ch}${ch}${ch}x` })))).toEqual([
      "large_blocks",
    ]);
    // 21 different labels with the same significant words: only 20 are kept.
    const small = ["the", "of", "and", "a", "an", "at", "by", "for", "in", "on", "to"];
    const variants = small.flatMap((p) => small.map((q) => `${p} GH ${q} Railroad`)).slice(0, 21);
    expect(
      limits([{ label: "Galveston Houston Railroad" }, ...variants.map((label) => ({ label }))]),
    ).toContain("abbreviation_matches");
    // More than 16 different words: only the first 16 make spelling blocks.
    const words = Array.from({ length: 17 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    expect(limits([{ label: words.join(" ") }, { label: "wordq" }])).toEqual(["block_words"]);
  });

  it("skips labels too long to compare once unfolded, and says so", () => {
    // U+FDFA unfolds to 18 characters, so 450 of them are 8,100.
    const r = findNearDuplicateTerms([
      { label: "\ufdfa".repeat(450) },
      { label: "Depot" },
      { label: "depot" },
    ]);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.skipped.map((x) => [x.index, x.issues[0]?.code])).toEqual([
      [0, "too_long_to_compare"],
    ]);
    expect(r.value.limitsReached).toEqual(["long_labels"]);
    expect(summary(r.value.candidates)).toEqual([[1, 2, "same_label"]]);
  });

  // Its limit was vitest's default 5-second timeout; now CPU time (U-003).
  it("stops the abbreviation check at its budget and says so", hangGuard(5000), () => {
    const elapsed = cpuClock();
    // Every run of words has initials that are a word some label uses.
    const runs = "aa aaa aaaa aaaaa aaaaaa aaaaaaa aaaaaaaa";
    const terms = [
      { label: runs },
      ...Array.from({ length: 12_000 }, (_, i) => ({
        label: `${"alpha ".repeat(11)}a${String.fromCharCode(97 + (i % 26), 97 + (Math.floor(i / 26) % 26), 97 + (Math.floor(i / 676) % 26))}`,
      })),
    ];
    const r = findNearDuplicateTerms(terms);
    expect(r.ok && r.value.limitsReached).toContain("abbreviation_budget");
    expect(elapsed()).toBeLessThan(5000);
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
