// Attacks on identifier types and identifiers. Each must be refused or
// neutralized, and nothing may throw or take more than linear time.
import { describe, expect, it } from "vitest";
import {
  MAX_FORMER_IDENTIFIERS,
  checkNewIdentifier,
  findByIdentifier,
  findIdentifierConflicts,
  identifierKey,
  newRecordId,
  nextIdentifier,
  uniquenessIssues,
  validateIdentifierType,
  validateIdentifierTypes,
  validateRecordIdentifiers,
  type IdentifierType,
  type RecordIdentifiers,
  type Validated,
} from "./index.js";

const BOX: IdentifierType = { key: "box_label", label: "Box label", uniqueness: "current" };
const TYPES = [BOX];

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("built-in names can't stand in for identifier types", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "%s is an unknown type unless the organization defines it",
    (type) => {
      const r = validateRecordIdentifiers(
        { recordId: newRecordId(), current: [{ type, value: "1", primary: true }], former: [] },
        TYPES,
      );
      expect(codes(r)).toEqual(["unknown_type"]);
      expect(
        checkNewIdentifier({ type, value: "1" }, newRecordId(), [], TYPES).map((i) => i.code),
      ).toEqual(["unknown_type"]);
    },
  );

  it("a type the organization names 'constructor' works like any other", () => {
    const type = { key: "constructor", label: "Odd", uniqueness: "current" } as const;
    expect(validateIdentifierType(type).ok).toBe(true);
    const r = validateRecordIdentifiers(
      {
        recordId: newRecordId(),
        current: [{ type: "constructor", value: "1", primary: true }],
        former: [],
      },
      [type],
    );
    expect(r.ok).toBe(true);
  });

  it("__proto__ keys are refused, not merged", () => {
    const input = JSON.parse(
      '{"key":"box","label":"Box","uniqueness":"none","__proto__":{"pattern":"#"}}',
    ) as unknown;
    expect(codes(validateIdentifierType(input))).toEqual(["forbidden_key"]);
    const set = JSON.parse(
      `{"recordId":"${newRecordId()}","current":[],"former":[],"__proto__":{"x":1}}`,
    ) as unknown;
    expect(codes(validateRecordIdentifiers(set, TYPES))).toEqual(["forbidden_key"]);
  });
});

describe("hostile objects", () => {
  it("Proxies, getters and throwing getters are refused without throwing", () => {
    const proxy = new Proxy({ ...BOX }, {});
    expect(codes(validateIdentifierType(proxy))).toEqual(["not_an_object"]);
    expect(codes(validateIdentifierTypes(new Proxy([BOX], {})))).toEqual(["not_a_list"]);

    let reads = 0;
    const getter = {
      ...BOX,
      get label() {
        reads += 1;
        return reads === 1 ? "Box" : "\u202eevil";
      },
    };
    expect(codes(validateIdentifierType(getter))).toEqual(["not_plain_data"]);

    const throwing = {
      recordId: newRecordId(),
      current: [],
      get former(): never {
        throw new Error("boom");
      },
    };
    expect(() => validateRecordIdentifiers(throwing, TYPES)).not.toThrow();
    expect(validateRecordIdentifiers(throwing, TYPES).ok).toBe(false);
    expect(() => checkNewIdentifier(throwing, newRecordId(), [], TYPES)).not.toThrow();
  });

  it("a Proxy whose traps throw is refused", () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    expect(codes(validateRecordIdentifiers(evil, TYPES))).toEqual(["not_an_object"]);
    expect(checkNewIdentifier(evil, newRecordId(), [], TYPES).map((i) => i.code)).toEqual([
      "not_an_object",
    ]);
  });

  it("the result is a frozen copy the caller can't change afterwards", () => {
    const input = {
      recordId: newRecordId(),
      current: [{ type: "box_label", value: "A", primary: true }],
      former: [],
    };
    const r = validateRecordIdentifiers(input, TYPES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = input.current[0];
    if (first !== undefined) first.value = "changed";
    expect(r.value.current[0]?.value).toBe("A");
    expect(Object.isFrozen(r.value.current)).toBe(true);
  });
});

describe("messages can't be used to hide or reorder text", () => {
  it("escapes line separators and quotes in echoed values", () => {
    const r = validateRecordIdentifiers(
      {
        recordId: newRecordId(),
        current: [{ type: 'x"\u2028', value: "1", primary: true }],
        former: [],
      },
      TYPES,
    );
    const message = r.ok ? "" : (r.issues[0]?.message ?? "");
    expect(message).toContain("\\u2028");
    expect(message).not.toContain("\u2028");
    expect(message).toContain('\\"');
  });

  it("shortens long echoed values", () => {
    const r = validateRecordIdentifiers(
      {
        recordId: newRecordId(),
        current: [{ type: "box_label", value: "A", primary: true, ["k".repeat(64)]: 1 }],
        former: [],
      },
      TYPES,
    );
    expect(r.ok ? "" : r.issues[0]?.message).toContain("\u2026");
  });
});

describe("lookalike identifiers can't both be held (S-003)", () => {
  // Each pair looks the same on screen: a Latin accented letter, and a
  // precomposed Cyrillic or Greek one that NFKC alone keeps apart.
  const PAIRS: [string, string][] = [
    ["Ä-1", "\u04d2-1"], // Cyrillic Ӓ
    ["Ö-1", "\u04e6-1"], // Cyrillic Ӧ
    ["Ă-1", "\u04d0-1"], // Cyrillic Ӑ
    ["Á-1", "\u0386-1"], // Greek Ά (tonos)
    ["é-1", "\u03ad-1"], // Greek έ
    ["ó-1", "\u03cc-1"], // Greek ό
    ["Á-1", "\u0391\u0341-1"], // Greek Α + combining tone mark
    // Review fixes: lookalikes with no Latin decomposition
    ["Y-1", "\u04ae-1"], // Cyrillic Ү
    ["Æ-1", "\u04d4-1"], // Cyrillic Ӕ
    ["ə-1", "\u04d9-1"], // Cyrillic ә
    ["Ɵ-1", "\u04e8-1"], // Cyrillic Ө
    ["V-1", "\u0474-1"], // Cyrillic Ѵ
    ["Ç-1", "\u04aa-1"], // Cyrillic Ҫ
    ["J-1", "\u037f-1"], // Greek Ϳ
    ["ã-1", "\u1fb6-1"], // Greek ᾶ (perispomeni drawn as a tilde)
    ["DHS-0001", "DHS\u16800001"], // Ogham space mark, drawn as a dash
  ];
  const holding = (value: string): RecordIdentifiers => ({
    recordId: newRecordId(),
    current: [{ type: "box_label", value, primary: true }],
    former: [],
  });

  it.each(PAIRS)("%s and %s are one identifier", (latin, other) => {
    const a = holding(latin);
    const b = holding(other);
    expect(validateRecordIdentifiers(a, TYPES).ok).toBe(true);
    expect(validateRecordIdentifiers(b, TYPES).ok).toBe(true);
    expect(uniquenessIssues([a, b], TYPES).map((i) => i.code)).toEqual([
      "not_unique",
      "not_unique",
    ]);
    expect(
      checkNewIdentifier({ type: "box_label", value: other }, newRecordId(), [a], TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["not_unique"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: latin }, newRecordId(), [b], TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["not_unique"]);
  });

  it("the accent still tells identifiers apart", () => {
    const a = holding("\u04e6-1"); // Cyrillic Ӧ
    expect(uniquenessIssues([a, holding("O-1")], TYPES)).toEqual([]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "O-1" }, newRecordId(), [a], TYPES),
    ).toEqual([]);
  });

  const BLANKS = ["\u2800", "\u{16FE4}", "\u{1D159}", "\u3164", "\u115f", "\u1160", "\uffa0"];

  it.each(BLANKS)("a blank-looking %j is refused in a value", (blank) => {
    for (const value of [`DHS-${blank}0001`, `DHS-0001${blank}`, blank]) {
      expect(codes(validateRecordIdentifiers(holding(value), TYPES))).toContain(
        "invisible_characters",
      );
      expect(
        checkNewIdentifier({ type: "box_label", value }, newRecordId(), [], TYPES).map(
          (i) => i.code,
        ),
      ).toContain("invisible_characters");
    }
  });

  it.each(BLANKS)("a value with %j already stored still clashes with the plain one", (blank) => {
    // Values that got in before this check (or from an import) still meet.
    const odd = holding(`DHS-0001${blank}`);
    expect(uniquenessIssues([odd, holding("DHS-0001")], TYPES).map((i) => i.code)).toEqual([
      "not_unique",
      "not_unique",
    ]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "DHS-0001" }, newRecordId(), [odd], TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["not_unique"]);
  });

  it.each(["\u2800", "\u200d", "\u3164", " "])(
    "%j between a letter and its accent doesn't keep them apart (review fix)",
    (blank) => {
      // Stored before the value check, or from an import.
      const odd = holding(`A${blank}\u0301-1`);
      expect(uniquenessIssues([odd, holding("Á-1")], TYPES)).toHaveLength(2);
      expect(
        findIdentifierConflicts({ type: "box_label", value: "Á-1" }, newRecordId(), [odd], TYPES),
      ).toHaveLength(1);
    },
  );

  it("a Hangul filler between jamo doesn't keep them from the syllable (review fix)", () => {
    expect(identifierKey("\u1100\u1160\u1161-1")).toBe(identifierKey("\uac00-1"));
  });

  it("long runs of combining marks cost linear time, even with no length cap (review fix)", () => {
    // Normalization sorts each run of marks in time growing with its square.
    const longRun = "a" + "\u0323\u0301".repeat(100_000);
    const shortRuns = ("a" + "\u0323\u0301".repeat(15)).repeat(30); // under the length cap
    const started = performance.now();
    expect(
      findIdentifierConflicts({ type: "box_label", value: longRun }, newRecordId(), [], TYPES),
    ).toEqual([]);
    const stored = Array.from({ length: 2000 }, () => holding(shortRuns));
    expect(uniquenessIssues([...stored, holding(longRun), holding(longRun)], TYPES).length).toBe(
      201,
    );
    // An unnormalized key still finds exactly the same text.
    expect(identifierKey(longRun)).toBe(identifierKey(longRun));
    expect(identifierKey(longRun)).not.toBe(identifierKey(`A${longRun.slice(1)}`));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("size limits", () => {
  it("refuses too many former identifiers", () => {
    const former = Array.from({ length: MAX_FORMER_IDENTIFIERS + 1 }, (_, i) => ({
      type: "box_label",
      value: `B${String(i)}`,
    }));
    expect(
      codes(validateRecordIdentifiers({ recordId: newRecordId(), current: [], former }, TYPES)),
    ).toEqual(["too_many"]);
  });

  it("refuses a huge or deeply nested input quickly", () => {
    const started = performance.now();
    const huge = { recordId: newRecordId(), current: [], former: new Array(1_000_000).fill(0) };
    expect(validateRecordIdentifiers(huge, TYPES).ok).toBe(false);
    let deep: unknown = "x";
    for (let i = 0; i < 10_000; i += 1) deep = [deep];
    expect(
      validateRecordIdentifiers({ recordId: newRecordId(), current: deep, former: [] }, TYPES).ok,
    ).toBe(false);
    expect(validateIdentifierTypes(new Array(1_000_000).fill(BOX)).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("uniqueness, search and numbering stay linear over many records", () => {
    const all: RecordIdentifiers[] = Array.from({ length: 20_000 }, (_, i) => ({
      recordId: newRecordId(),
      current: [{ type: "box_label", value: `B-${String(i % 10_000)}`, primary: true }],
      former: [],
    }));
    const auto: IdentifierType = {
      ...BOX,
      autoNumber: { style: "prefix", prefix: "B-", digits: 1 },
    };
    const started = performance.now();
    const found = uniquenessIssues(all, TYPES);
    expect(found).toHaveLength(201); // 200 issues, then "too_many_issues"
    expect(found[200]?.code).toBe("too_many_issues");
    expect(findByIdentifier("b-9999", all)).toHaveLength(2);
    expect(nextIdentifier(auto, all)).toEqual({ ok: true, value: "B-10000" });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("a query is capped before it is normalized", () => {
    // U+FDFA expands to 18 characters under NFKC.
    const started = performance.now();
    expect(findByIdentifier("\ufdfa".repeat(1_000_000), [])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
