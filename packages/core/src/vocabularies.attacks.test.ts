// Hostile input for controlled terms and near-duplicate detection. Each test
// tries one attack; each must be refused or neutralized, and nothing may throw.
import { describe, expect, it } from "vitest";
import {
  MAX_DUPLICATE_TERMS,
  MAX_PAIR_SET_TERMS,
  controlledTermChecker,
  findNearDuplicateTerms,
  normalizeTermUri,
  validateControlledTerm,
  vocabulary,
  type CatalogRecord,
  type FieldDefinition,
} from "./index.js";
import { findNearDuplicateTerms as referenceFind } from "./term-duplicates.fixtures.js";
import { cpuClock, hangGuard } from "./cpu-time.fixtures.js";

const HURRICANES = "http://id.loc.gov/authorities/subjects/sh85063195";

const codeOf = (r: { ok: boolean; issues?: readonly { code: string }[] }): string | undefined =>
  r.ok ? undefined : r.issues?.[0]?.code;

describe("controlled terms can't be fooled", () => {
  it("ignores a vocabulary or URI inherited from Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.vocabulary = "local";
    proto.uri = HURRICANES;
    try {
      const r = validateControlledTerm({ label: "Hurricanes" });
      expect(r).toEqual({ ok: true, value: { label: "Hurricanes" } });
      if (r.ok) {
        expect(Object.hasOwn(r.value, "vocabulary")).toBe(false);
        expect(Object.hasOwn(r.value, "uri")).toBe(false);
      }
    } finally {
      delete proto.vocabulary;
      delete proto.uri;
    }
  });

  it("refuses prototype keys, getters, hidden properties and Proxies", () => {
    expect(codeOf(validateControlledTerm(JSON.parse('{"label":"X","__proto__":{}}')))).toBe(
      "forbidden_key",
    );
    const getter = {
      label: "X",
      get vocabulary() {
        return "lcsh";
      },
    };
    expect(codeOf(validateControlledTerm(getter))).toBe("not_plain_data");
    const hidden = { label: "X" };
    Object.defineProperty(hidden, "vocabulary", { value: "lcsh", enumerable: false });
    expect(codeOf(validateControlledTerm(hidden))).toBe("not_plain_data");
    expect(codeOf(validateControlledTerm(new Proxy({ label: "X" }, {})))).toBe("not_plain_data");
  });

  it("doesn't throw for a Proxy whose traps throw", () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
        getPrototypeOf() {
          throw new Error("boom");
        },
      },
    );
    expect(validateControlledTerm(evil).ok).toBe(false);
    expect(findNearDuplicateTerms(evil).ok).toBe(false);
    const r = findNearDuplicateTerms([evil]);
    expect(r.ok && r.value.skipped.map((x) => x.index)).toEqual([0]);
  });

  it("treats built-in names as unknown vocabularies", () => {
    for (const v of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(vocabulary(v)).toBeUndefined();
      expect(codeOf(validateControlledTerm({ label: "X", vocabulary: v }))).toBe(
        "unknown_vocabulary",
      );
    }
  });

  it("escapes direction-changing characters echoed in messages", () => {
    const r = validateControlledTerm({ label: "X", vocabulary: "lc‮sh" });
    expect(r.ok).toBe(false);
    // Refused while reading, before it can be shown.
    expect(codeOf(r)).toBe("bad_characters");
    const n = normalizeTermUri("http://id.loc.gov/authorities/subjects/sh85063195?⁦x");
    expect(codeOf(n)).toBe("bad_characters");
    const w = validateControlledTerm({ label: "X", vocabulary: "a b" });
    expect(codeOf(w)).toBe("unknown_vocabulary");
    expect(w.ok ? "" : (w.issues[0]?.message ?? "")).toContain("\\u2028");
  });

  it("isn't fooled by look-alike or disguised hosts", () => {
    for (const uri of [
      "http://id.loc.gov.example.org/authorities/subjects/sh85063195",
      "http://example.org/id.loc.gov/authorities/subjects/sh85063195",
      "http://id.loc.gov@example.org/authorities/subjects/sh85063195",
      "http://user:pw@id.loc.gov/authorities/subjects/sh85063195",
      "http://id.loc.gov\\@example.org/authorities/subjects/sh85063195",
      "http://id.lοc.gov/authorities/subjects/sh85063195", // Greek omicron
      "javascript:alert(1)//id.loc.gov/authorities/subjects/sh85063195",
    ]) {
      const r = validateControlledTerm({ label: "Hurricanes", uri, vocabulary: "lcsh" });
      expect(r.ok, uri).toBe(false);
      expect(normalizeTermUri(uri).ok, uri).toBe(false);
    }
    expect(
      validateControlledTerm({
        label: "Lantern",
        uri: "https://nomenclature.info@example.org/nom/1",
        vocabulary: "nomenclature",
      }).ok,
    ).toBe(false);
  });

  // CPU time, not the wall clock (U-003): a busy machine can't fail it.
  it("doesn't take long on a huge or pathological URI", hangGuard(1000), () => {
    const elapsed = cpuClock();
    const long = `http://id.loc.gov/${"a/".repeat(240)}`;
    expect(normalizeTermUri(long).ok).toBe(false);
    expect(normalizeTermUri(`http://id.loc.gov/${"9".repeat(480)}`).ok).toBe(false);
    expect(
      validateControlledTerm({
        label: "X",
        uri: `https://e.org/${"x".repeat(5000)}`,
        vocabulary: "gnis",
      }).ok,
    ).toBe(false);
    expect(elapsed()).toBeLessThan(1000);
  });

  it("the checker never throws, even when given something that isn't a term", () => {
    const field = {} as FieldDefinition;
    const record = {} as CatalogRecord;
    for (const v of [null, 1, "x", [], { label: 1 }]) {
      const problems = controlledTermChecker(v, field, record);
      expect(problems.length).toBeGreaterThan(0);
    }
  });
});

describe("near-duplicate detection can't be overloaded", () => {
  it("refuses a list over the limit before reading it", () => {
    const huge = new Array<unknown>(MAX_DUPLICATE_TERMS + 1);
    expect(codeOf(findNearDuplicateTerms(huge))).toBe("too_many");
  });

  it("skips holes and getters in the list, and never runs a getter", () => {
    let ran = false;
    // eslint-disable-next-line no-sparse-arrays -- the hole is the attack
    const list: unknown[] = [{ label: "Depot" }, , { label: "depot" }];
    Object.defineProperty(list, 3, {
      get() {
        ran = true;
        return { label: "Depot" };
      },
      enumerable: true,
    });
    const r = findNearDuplicateTerms(list);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.skipped.map((x) => [x.index, x.issues[0]?.code])).toEqual([
      [1, "holes"],
      [3, "not_plain_data"],
    ]);
    expect(r.value.candidates.map((c) => [c.first, c.second])).toEqual([[0, 2]]);
    expect(ran).toBe(false);
  });

  it("only reads the list's items, so extra properties can't run", () => {
    let ran = false;
    const extra = [{ label: "A" }] as unknown[] & { forEach?: unknown };
    extra.forEach = () => {
      ran = true;
    };
    expect(findNearDuplicateTerms(extra).ok).toBe(true);
    expect(ran).toBe(false);
  });

  it("refuses a Proxy list or an array with another prototype", () => {
    expect(codeOf(findNearDuplicateTerms(new Proxy([{ label: "A" }], {})))).toBe("not_a_list");
    const odd = [{ label: "A" }];
    Object.setPrototypeOf(odd, null);
    expect(codeOf(findNearDuplicateTerms(odd))).toBe("not_a_list");
  });

  it("ignores a maxCandidates inherited from Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.maxCandidates = 0;
    try {
      expect(findNearDuplicateTerms([{ label: "A" }]).ok).toBe(true);
    } finally {
      delete proto.maxCandidates;
    }
  });

  it("refuses a maxCandidates getter instead of running it", () => {
    let ran = false;
    const options = {
      get maxCandidates() {
        ran = true;
        return 5;
      },
    };
    expect(codeOf(findNearDuplicateTerms([{ label: "A" }], options))).toBe("invalid_option");
    expect(ran).toBe(false);
  });

  it(
    "stays fast on many terms that share a word, a prefix and an ending",
    hangGuard(10_000),
    () => {
      // 20,000 invented labels in one huge block: compared with neighbours only.
      const terms = Array.from({ length: 20_000 }, (_, i) => ({
        label: `Railroad depot ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + (Math.floor(i / 676) % 26))} depot`,
      }));
      const elapsed = cpuClock();
      const r = findNearDuplicateTerms(terms, { maxCandidates: 10 });
      expect(elapsed()).toBeLessThan(10_000);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.candidates).toHaveLength(10);
        expect(r.value.truncated).toBe(true);
      }
    },
  );

  it("gives n - 1 pairs, not n², for many copies of the same term", () => {
    const terms = Array.from({ length: 5000 }, () => ({ label: "Depot" }));
    const r = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
    expect(r.ok && r.value.candidates.length).toBe(4999);
    expect(r.ok && r.value.truncated).toBe(false);
  });

  // The worst inputs found in review, at the full 50,000 terms. Each must
  // finish in about 2 seconds; the bound leaves room for a slow CI machine.
  // Times are this thread's CPU time (U-003), so a busy machine can't fail
  // them; the wall-clock timeout is only a hang guard.
  const N = 50_000;
  const tag = (i: number): string =>
    String.fromCharCode(
      97 + (i % 26),
      97 + (Math.floor(i / 26) % 26),
      97 + (Math.floor(i / 676) % 26),
      97 + (Math.floor(i / 17576) % 26),
    );
  const shared = Array.from({ length: 120 }, (_, i) => tag(i * 37).slice(0, 3)).join(" ");
  const fast = hangGuard(5000);
  const timed = (terms: unknown[]): { ms: number; limits: readonly string[]; found: number } => {
    const elapsed = cpuClock();
    const r = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
    const ms = elapsed();
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return { ms, limits: r.value.limitsReached, found: r.value.candidates.length };
  };

  it("is fast on long labels sharing 120 words, told apart by a number", fast, () => {
    const r = timed(Array.from({ length: N }, (_, i) => ({ label: `${shared} ${String(i)}` })));
    expect(r.found).toBe(0);
    expect(r.ms).toBeLessThan(5000);
  });

  it("stays within budget on long labels sharing 120 words, told apart by a word", fast, () => {
    const r = timed(
      Array.from({ length: N }, (_, i) => ({ label: `${tag(i)} ${shared}`.slice(0, 500) })),
    );
    expect(r.limits).toContain("spelling_budget");
    expect(r.ms).toBeLessThan(5000);
  });

  it("is fast when every term has a GNIS URI (only same_uri can apply)", fast, () => {
    const r = timed(
      Array.from({ length: N }, (_, i) => ({
        label: `${tag(i)} ${shared}`.slice(0, 500),
        uri: `https://example.org/gnis/${String(i)}`,
        vocabulary: "gnis",
      })),
    );
    expect([r.found, r.limits]).toEqual([0, []]);
    expect(r.ms).toBeLessThan(5000);
  });

  it("is fast with one local term among long GNIS terms", fast, () => {
    const r = timed([
      { label: `${tag(1)} ${shared}`.slice(0, 500) },
      ...Array.from({ length: N - 1 }, (_, i) => ({
        label: `${tag(i)} ${shared}`.slice(0, 500),
        uri: `https://example.org/gnis/${String(i)}`,
        vocabulary: "gnis",
      })),
    ]);
    expect(r.ms).toBeLessThan(5000);
  });

  // Labels of short random words: short keys in hundreds of big blocks of
  // different keys. These assert what was searched (a loaded machine can't
  // change that), and the 30 seconds that used to be the test's own
  // timeout, now as CPU time (U-003).
  const randomWords = (seed: number, vocabulary: readonly string[], words: number): unknown[] => {
    let s = seed;
    const next = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    return Array.from({ length: N }, () => ({
      label: Array.from(
        { length: words },
        () => vocabulary[Math.floor(next() * vocabulary.length)] ?? "",
      ).join(" "),
    }));
  };
  const allWords = (letters: string, length: number): string[] =>
    Array.from({ length: letters.length ** length }, (_, i) =>
      Array.from(
        { length },
        (_, k) => letters[Math.floor(i / letters.length ** k) % letters.length],
      ).join(""),
    );
  const SLOW_MS = 30_000;
  const slow = hangGuard(SLOW_MS);

  it("searches every neighbour of labels of six short random words", slow, () => {
    const consonants = allWords("bcdfghjklmnpqrstvwxz", 3).filter((_, i) => i % 67 === 0);
    const r = timed(randomWords(42, consonants, 6));
    expect(r.limits).not.toContain("spelling_budget");
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  it("searches every neighbour when every key has the same four letters", slow, () => {
    // No pair is passed over for having different letters, so each needs
    // its distance, and the budget must still not cut the search short.
    const r = timed(randomWords(7, allWords("bcdf", 3), 6));
    expect(r.limits).not.toContain("spelling_budget");
    expect(r.found).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  it("charges a pair passed over without its distance as a visit only", slow, () => {
    // 44-letter keys from two letters: pairs needing a distance used to be
    // charged 44 × 44 cells each, even when their letter counts rule them out.
    const r = timed(randomWords(9, allWords("ab", 4), 11));
    expect(r.limits).not.toContain("spelling_budget");
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  // S-005a. The shapes that took longest, each compared with the code as it
  // was before S-005a (term-duplicates.fixtures.ts) on the same 50,000
  // terms, in the same process: the whole report must be identical (so no
  // pair is lost and the limits are reported the same, budgets included),
  // and the new code must be clearly faster. The ratio is what is asserted,
  // not the seconds: a wall clock bound either passes for the old code too
  // or turns flaky. Both runs are timed in this thread's CPU time (U-003):
  // on the wall clock, load that came or went between the two runs moved
  // the ratio past its bound.
  const against = (terms: unknown[]): { ratio: number; ms: number; limits: readonly string[] } => {
    // The new code runs first, so it pays for warming up anything the two
    // share: the ratio can only understate how much faster it is.
    const elapsed = cpuClock();
    const now = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
    const ms = elapsed();
    const before = cpuClock();
    const old = referenceFind(terms, { maxCandidates: 10_000 });
    const oldMs = Math.max(1, before());
    expect(now).toEqual(old);
    if (!now.ok) throw new Error(JSON.stringify(now.issues));
    return { ratio: ms / oldMs, ms, limits: now.value.limitsReached };
  };

  it("is fast on 44-letter keys from two letters, and finds the same pairs", slow, () => {
    // About 3.2-4 s before (mostly the edit distance of ~700,000 pairs, the
    // set of ~4.9 million pair visits and the abbreviation pass); about
    // 1.5-1.9 s now on the machine this was measured on, under the 2 s
    // target. The same ~455 pairs are found. The 2 s itself can't be
    // asserted here: this machine runs several builds at once, which can
    // double any wall-clock figure, so the test holds the ratio between the
    // two runs and the run's own report records the seconds measured.
    const r = against(randomWords(9, allWords("ab", 4), 11));
    expect(r.ratio).toBeLessThan(0.8);
    expect(r.ms).toBeLessThan(5000);
  });

  it("finds the same pairs when every key has the same four letters", slow, () => {
    const r = against(randomWords(7, allWords("bcdf", 3), 6));
    expect(r.ratio).toBeLessThan(0.9);
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  it("reaches the same limits when the spelling budget runs out", slow, () => {
    const r = against(
      Array.from({ length: N }, (_, i) => ({ label: `${tag(i)} ${shared}`.slice(0, 500) })),
    );
    expect(r.limits).toContain("spelling_budget");
    expect(r.limits).toContain("candidates");
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  it("stops the abbreviation check at the same place", slow, () => {
    // The shape from term-duplicates.test.ts: every run of words has
    // initials that are a word some label uses.
    const runs = "aa aaa aaaa aaaaa aaaaaa aaaaaaa aaaaaaaa";
    const r = against([
      { label: runs },
      ...Array.from({ length: 12_000 }, (_, i) => ({
        label: `${"alpha ".repeat(11)}a${String.fromCharCode(97 + (i % 26), 97 + (Math.floor(i / 26) % 26), 97 + (Math.floor(i / 676) % 26))}`,
      })),
    ]);
    expect(r.limits).toContain("abbreviation_budget");
    expect(r.ms).toBeLessThan(SLOW_MS);
  });

  it("holds pairs of positions as numbers only while the term limit allows it", () => {
    // The spelling check's set of visited pairs keeps a pair of positions as
    // one 32-bit number, so raising MAX_DUPLICATE_TERMS past this needs a
    // different set, not a bigger limit.
    expect(MAX_DUPLICATE_TERMS).toBeLessThanOrEqual(MAX_PAIR_SET_TERMS);
    // The largest pair is the last position with itself: a term can share a
    // block with itself (two ways of dropping a letter from "aabbc" give the
    // same shortened key), so that pair must fit below the empty mark too.
    expect(MAX_PAIR_SET_TERMS ** 2 - 1).toBeLessThan(2 ** 32 - 1);
  });

  // Its limit was vitest's default 5-second timeout; now CPU time (U-003).
  it("doesn't run out of memory on labels that unfold to many characters", fast, () => {
    // U+FDFA unfolds to 18 characters: 450 of them would be an 8,100-letter key.
    const elapsed = cpuClock();
    const r = findNearDuplicateTerms(
      Array.from({ length: N }, (_, i) => ({ label: `${"\ufdfa".repeat(450)} ${tag(i)}` })),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.skipped).toHaveLength(N);
    expect(r.value.skipped[0]?.issues[0]?.code).toBe("too_long_to_compare");
    expect(r.value.limitsReached).toEqual(["long_labels"]);
    expect(elapsed()).toBeLessThan(5000);
  });
});
