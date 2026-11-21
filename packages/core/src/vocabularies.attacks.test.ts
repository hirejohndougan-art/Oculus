// Hostile input for controlled terms and near-duplicate detection. Each test
// tries one attack; each must be refused or neutralized, and nothing may throw.
import { describe, expect, it } from "vitest";
import {
  MAX_DUPLICATE_TERMS,
  controlledTermChecker,
  findNearDuplicateTerms,
  normalizeTermUri,
  validateControlledTerm,
  vocabulary,
  type CatalogRecord,
  type FieldDefinition,
} from "./index.js";

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
    expect(findNearDuplicateTerms([evil]).ok).toBe(false);
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

  it("doesn't take long on a huge or pathological URI", () => {
    const start = Date.now();
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
    expect(Date.now() - start).toBeLessThan(1000);
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

  it("refuses a sparse list and a list with extra properties", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the attack
    expect(codeOf(findNearDuplicateTerms([{ label: "A" }, , { label: "B" }]))).toBe("holes");
    const extra = [{ label: "A" }] as unknown[] & { forEach?: unknown };
    extra.forEach = () => undefined;
    expect(codeOf(findNearDuplicateTerms(extra))).toBe("not_plain_data");
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

  it("stays fast on many terms that share a word, a prefix and an ending", () => {
    // 20,000 invented labels in one huge block: compared with neighbours only.
    const terms = Array.from({ length: 20_000 }, (_, i) => ({
      label: `Railroad depot ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + (Math.floor(i / 676) % 26))} depot`,
    }));
    const start = Date.now();
    const r = findNearDuplicateTerms(terms, { maxCandidates: 10 });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.candidates).toHaveLength(10);
      expect(r.value.truncated).toBe(true);
    }
  });

  it("gives n - 1 pairs, not n², for many copies of the same term", () => {
    const terms = Array.from({ length: 5000 }, () => ({ label: "Depot" }));
    const r = findNearDuplicateTerms(terms, { maxCandidates: 10_000 });
    expect(r.ok && r.value.candidates.length).toBe(4999);
    expect(r.ok && r.value.truncated).toBe(false);
  });
});
