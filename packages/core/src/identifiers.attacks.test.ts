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
  retireIdentifier,
  uniquenessIssues,
  validateIdentifierType,
  validateNewIdentifierType,
  validateIdentifierTypes,
  validateRecordIdentifiers,
  type IdentifierType,
  type RecordIdentifiers,
  type Validated,
  newOrganizationId,
} from "./index.js";

/** The list from a Validated result; fails the test if it was refused. */
function listed<T>(result: Validated<readonly T[]>): readonly T[] {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

const ORG = newOrganizationId();

const BOX: IdentifierType = {
  key: "box_label",
  label: "Box label",
  organizationId: ORG,
  uniqueness: "current",
};
const TYPES = [BOX];

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("built-in names can't stand in for identifier types", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "%s is an unknown type unless the organization defines it",
    (type) => {
      const r = validateRecordIdentifiers(
        {
          recordId: newRecordId(),
          organizationId: ORG,
          current: [{ type, value: "1", primary: true }],
          former: [],
        },
        TYPES,
      );
      expect(codes(r)).toEqual(["unknown_type"]);
      expect(
        checkNewIdentifier({ type, value: "1" }, newRecordId(), [], TYPES).map((i) => i.code),
      ).toEqual(["unknown_type"]);
    },
  );

  it("a stored type named 'constructor' still works; a new one is refused (D-031)", () => {
    const type = {
      key: "constructor",
      label: "Odd",
      organizationId: ORG,
      uniqueness: "current",
    } as const;
    expect(validateIdentifierType(type).ok).toBe(true);
    expect(validateIdentifierTypes([type]).ok).toBe(true);
    const r = validateRecordIdentifiers(
      {
        recordId: newRecordId(),
        organizationId: ORG,
        current: [{ type: "constructor", value: "1", primary: true }],
        former: [{ type: "prototype", value: "0" }],
      },
      [type],
    );
    expect(r.ok).toBe(true);
    for (const key of ["constructor", "prototype"]) {
      expect(codes(validateNewIdentifierType({ ...type, key }))).toEqual(["reserved_key"]);
    }
    expect(validateNewIdentifierType({ ...type, key: "accession" }).ok).toBe(true);
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
      organizationId: ORG,
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
      organizationId: ORG,
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
        organizationId: ORG,
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
        organizationId: ORG,
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
    organizationId: ORG,
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
        listed(
          findIdentifierConflicts({ type: "box_label", value: "Á-1" }, newRecordId(), [odd], TYPES),
        ),
      ).toHaveLength(1);
    },
  );

  it("a Hangul filler between jamo doesn't keep them from the syllable (review fix)", () => {
    expect(identifierKey("\u1100\u1160\u1161-1")).toBe(identifierKey("\uac00-1"));
  });

  it("long runs of combining marks cost linear time, at any length (review fix)", () => {
    // Normalization sorts each run of marks in time growing with its square.
    const longRun = "a" + "\u0323\u0301".repeat(100_000);
    const shortRuns = ("a" + "\u0323\u0301".repeat(4)).repeat(100); // runs of 8: allowed
    const started = performance.now();
    expect(
      listed(
        findIdentifierConflicts({ type: "box_label", value: longRun }, newRecordId(), [], TYPES),
      ),
    ).toEqual([]);
    const stored = Array.from({ length: 500 }, () => holding(shortRuns));
    expect(uniquenessIssues([...stored, holding(longRun), holding(longRun)], TYPES).length).toBe(
      201,
    );
    expect(listed(findByIdentifier(longRun.slice(0, 900), [holding(longRun)]))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("equivalent spellings with many marks take the same path (second review)", () => {
  const holding = (value: string): RecordIdentifiers => ({
    recordId: newRecordId(),
    organizationId: ORG,
    current: [{ type: "box_label", value, primary: true }],
    former: [],
  });
  const acutes = (n: number): string => "\u0301".repeat(n);
  // Each pair is canonically equivalent (or a lookalike of it), with the
  // first spelling's raw run one mark shorter than the second's.
  const PROBES: [string, string][] = [
    [`\u00d6${acutes(30)}-1`, `O\u0308${acutes(30)}-1`],
    [`\u00d6${acutes(30)}-1`, `\u041e\u0308${acutes(30)}-1`], // Cyrillic О
    [`\u00e1${acutes(30)}-1`, `a${acutes(31)}-1`],
    [`a\u0323\u0301${acutes(30)}-1`, `a\u0301\u0323${acutes(30)}-1`], // marks reordered
    [`\u00d6${acutes(7)}-1`, `O\u0308${acutes(7)}-1`], // at the limit
  ];

  it.each(PROBES)("%j and %j get one key", (a, b) => {
    expect(identifierKey(a)).toBe(identifierKey(b));
    // Stored before the check (old data): uniqueness and search still meet.
    const x = holding(a);
    const y = holding(b);
    expect(uniquenessIssues([x, y], TYPES).map((i) => i.code)).toEqual([
      "not_unique",
      "not_unique",
    ]);
    expect(listed(findByIdentifier(b, [x]))).toHaveLength(1);
    expect(listed(findByIdentifier(a, [y]))).toHaveLength(1);
    // One record holding both: a duplicate within the record, or refused.
    const both = {
      recordId: newRecordId(),
      organizationId: ORG,
      current: [
        { type: "box_label", value: a, primary: true },
        { type: "box_label", value: b, primary: false },
      ],
      former: [],
    };
    const found = codes(validateRecordIdentifiers(both, TYPES));
    expect(found.includes("duplicate") || found.includes("too_many_marks")).toBe(true);
  });

  it("at the limit, one record can't hold both spellings", () => {
    const [a, b] = PROBES[4] ?? ["", ""];
    const both = {
      recordId: newRecordId(),
      organizationId: ORG,
      current: [
        { type: "box_label", value: a, primary: true },
        { type: "box_label", value: b, primary: false },
      ],
      former: [],
    };
    expect(codes(validateRecordIdentifiers(both, TYPES))).toEqual(["duplicate"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: b }, newRecordId(), [holding(a)], TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["not_unique"]);
  });

  it.each(PROBES.slice(0, 4))("a value with %j's marks is refused", (a, b) => {
    for (const value of [a, b]) {
      expect(codes(validateRecordIdentifiers(holding(value), TYPES))).toContain("too_many_marks");
      expect(
        checkNewIdentifier({ type: "box_label", value }, newRecordId(), [], TYPES).map(
          (i) => i.code,
        ),
      ).toContain("too_many_marks");
    }
  });

  it("eight marks on one letter are allowed, nine are not", () => {
    expect(validateRecordIdentifiers(holding(`a${acutes(8)}-1`), TYPES).ok).toBe(true);
    expect(validateRecordIdentifiers(holding(`\u00e1${acutes(7)}-1`), TYPES).ok).toBe(true);
    expect(codes(validateRecordIdentifiers(holding(`\u00e1${acutes(8)}-1`), TYPES))).toContain(
      "too_many_marks",
    );
  });
});

describe("size limits", () => {
  it("refuses too many former identifiers", () => {
    const former = Array.from({ length: MAX_FORMER_IDENTIFIERS + 1 }, (_, i) => ({
      type: "box_label",
      value: `B${String(i)}`,
    }));
    expect(
      codes(
        validateRecordIdentifiers(
          { recordId: newRecordId(), organizationId: ORG, current: [], former },
          TYPES,
        ),
      ),
    ).toEqual(["too_many"]);
  });

  it("refuses a huge or deeply nested input quickly", () => {
    const started = performance.now();
    const huge = {
      recordId: newRecordId(),
      organizationId: ORG,
      current: [],
      former: new Array(1_000_000).fill(0),
    };
    expect(validateRecordIdentifiers(huge, TYPES).ok).toBe(false);
    let deep: unknown = "x";
    for (let i = 0; i < 10_000; i += 1) deep = [deep];
    expect(
      validateRecordIdentifiers(
        { recordId: newRecordId(), organizationId: ORG, current: deep, former: [] },
        TYPES,
      ).ok,
    ).toBe(false);
    expect(validateIdentifierTypes(new Array(1_000_000).fill(BOX)).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("uniqueness, search and numbering stay linear over many records", () => {
    const all: RecordIdentifiers[] = Array.from({ length: 20_000 }, (_, i) => ({
      recordId: newRecordId(),
      organizationId: ORG,
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
    expect(listed(findByIdentifier("b-9999", all))).toHaveLength(2);
    expect(nextIdentifier(auto, all)).toEqual({ ok: true, value: "B-10000" });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("a query is capped before it is normalized", () => {
    // U+FDFA expands to 18 characters under NFKC.
    const started = performance.now();
    expect(listed(findByIdentifier("\ufdfa".repeat(1_000_000), []))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("one organization's numbers can't be read or mixed with another's (D-019)", () => {
  // D-019's case: two organizations in one install, both numbering `DPL1`.
  const OTHER = newOrganizationId();
  const OTHER_BOX: IdentifierType = { ...BOX, organizationId: OTHER, label: "Other box" };
  const mine = newRecordId();
  const theirs = newRecordId();
  const ownSet: RecordIdentifiers = {
    recordId: mine,
    organizationId: ORG,
    current: [{ type: "box_label", value: "DPL1", primary: true }],
    former: [],
  };
  const otherSet: RecordIdentifiers = {
    recordId: theirs,
    organizationId: OTHER,
    current: [{ type: "box_label", value: "DPL1", primary: true }],
    former: [{ type: "box_label", value: "DPL7" }],
  };

  it("uniquenessIssues refuses a mixed set instead of reporting the other organization's holder", () => {
    for (const all of [
      [ownSet, otherSet],
      [otherSet, ownSet],
    ]) {
      const issues = uniquenessIssues(all, TYPES);
      expect(issues.map((i) => i.code)).toEqual(["mixed_organizations"]);
      expect(JSON.stringify(issues)).not.toContain(theirs);
    }
    expect(uniquenessIssues([ownSet], [BOX, OTHER_BOX]).map((i) => i.code)).toEqual([
      "mixed_organizations",
    ]);
  });

  it("checkNewIdentifier won't look at another organization's records or use its types", () => {
    const fresh = newRecordId();
    // Without the check, this would say "already used by another record",
    // telling one organization what the other holds.
    const mixed = checkNewIdentifier(
      { type: "box_label", value: "DPL1" },
      fresh,
      [otherSet],
      TYPES,
    );
    expect(mixed.map((i) => i.code)).toEqual(["mixed_organizations"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "X" }, fresh, [ownSet, otherSet], TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["mixed_organizations"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "X" }, fresh, [ownSet], [OTHER_BOX]).map(
        (i) => i.code,
      ),
    ).toEqual(["mixed_organizations"]);
  });

  it("nextIdentifier won't count another organization's numbers", () => {
    const auto: IdentifierType = {
      ...BOX,
      autoNumber: { style: "prefix", prefix: "DPL", digits: 1 },
    };
    expect(codes(nextIdentifier(auto, [ownSet, otherSet]))).toEqual(["mixed_organizations"]);
    expect(codes(nextIdentifier({ ...auto, organizationId: OTHER }, [ownSet]))).toEqual([
      "mixed_organizations",
    ]);
  });

  it("validateRecordIdentifiers won't check a record's numbers against another organization's types", () => {
    expect(codes(validateRecordIdentifiers(ownSet, [OTHER_BOX]))).toEqual(["mixed_organizations"]);
    expect(codes(validateRecordIdentifiers(ownSet, [BOX, OTHER_BOX]))).toEqual([
      "mixed_organizations",
    ]);
    const unowned = { recordId: mine, current: ownSet.current, former: [] };
    expect(codes(validateRecordIdentifiers(unowned, TYPES))).toEqual(["invalid_organization"]);
  });

  it("validateIdentifierTypes names no key of a list mixing organizations (S-009a)", () => {
    const theirs = (key: string): IdentifierType => ({ ...OTHER_BOX, key });
    const unowned = (key: string) => ({ key, label: "Unowned", uniqueness: "none" });
    for (const list of [
      [BOX, theirs("secret_key"), theirs("secret_key")],
      [theirs("secret_key"), theirs("secret_key"), BOX],
      [BOX, theirs("secret_key"), { ...theirs("secret_key"), uniqueness: "maybe" }],
      [BOX, unowned("secret_key"), unowned("secret_key")],
      [BOX, { ...BOX, organizationId: "not-an-id", key: "secret_key" }, theirs("secret_key")],
      [5, theirs("secret_key"), theirs("secret_key")],
      ["x", BOX, theirs("secret_key"), theirs("secret_key")],
    ]) {
      const r = validateIdentifierTypes(list);
      expect(r.ok).toBe(false);
      for (const code of codes(r)) {
        expect(["mixed_organizations", "invalid_organization", "not_an_object"]).toContain(code);
      }
      expect(JSON.stringify(r)).not.toContain("secret_key");
    }
    // One organization's own duplicate still names the key.
    const own = validateIdentifierTypes([BOX, { ...BOX, label: "Again" }]);
    expect(codes(own)).toEqual(["duplicate_key"]);
  });

  it("validateIdentifierTypes refuses one list holding two organizations' types", () => {
    expect(codes(validateIdentifierTypes([BOX, { ...OTHER_BOX, key: "other_box" }]))).toEqual([
      "mixed_organizations",
    ]);
    const unowned = { key: BOX.key, label: BOX.label, uniqueness: BOX.uniqueness };
    expect(codes(validateIdentifierType(unowned))).toEqual(["invalid_organization"]);
  });

  it("the same number in two organizations is fine when each is checked on its own", () => {
    expect(uniquenessIssues([ownSet], TYPES)).toEqual([]);
    expect(uniquenessIssues([otherSet], [OTHER_BOX])).toEqual([]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "DPL1" }, newRecordId(), [ownSet], TYPES),
    ).not.toEqual([]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "DPL7" }, newRecordId(), [ownSet], TYPES),
    ).toEqual([]);
  });

  it("retireIdentifier keeps the record's organization", () => {
    const r = retireIdentifier(ownSet, { type: "box_label", value: "DPL1" });
    expect(r.ok && r.value.organizationId).toBe(ORG);
  });
});

describe("entries that don't say their organization can't slip past the check (review of T-019)", () => {
  const theirs = newRecordId();
  // Another organization's set with its organizationId left out, or forged.
  const base = {
    recordId: theirs,
    current: [{ type: "box_label", value: "DPL9", primary: true }],
    former: [{ type: "box_label", value: "DPL1" }],
  };
  const unowned = base as unknown as RecordIdentifiers;
  const forged = { ...base, organizationId: "other" } as unknown as RecordIdentifiers;
  const behindGetter = Object.defineProperty({ ...base }, "organizationId", {
    get: () => ORG,
    enumerable: true,
  }) as unknown as RecordIdentifiers;
  const own: RecordIdentifiers = {
    recordId: newRecordId(),
    organizationId: ORG,
    current: [],
    former: [],
  };
  const auto: IdentifierType = {
    ...BOX,
    autoNumber: { style: "prefix", prefix: "DPL", digits: 1 },
  };

  it.each([
    ["missing", [unowned]],
    ["missing, after an own set", [own, unowned]],
    ["forged", [forged, own]],
    ["behind a getter", [behindGetter]],
  ])("refuses a set whose organizationId is %s", (_, all) => {
    const fresh = newRecordId();
    const results: unknown[] = [
      uniquenessIssues(all, TYPES),
      checkNewIdentifier({ type: "box_label", value: "DPL1" }, fresh, all, TYPES),
      nextIdentifier(auto, all),
      findIdentifierConflicts({ type: "box_label", value: "DPL9" }, fresh, all, TYPES),
      findByIdentifier("DPL9", all),
    ];
    for (const r of results) {
      const issues = Array.isArray(r) ? r : (r as { issues?: unknown }).issues;
      expect((issues as { code: string }[]).map((i) => i.code)).toEqual(["mixed_organizations"]);
      expect(JSON.stringify(r)).not.toContain(theirs);
      expect(JSON.stringify(r)).not.toContain("DPL10");
    }
  });

  it("an identifier type with no organization is refused too", () => {
    const typeless = {
      key: BOX.key,
      label: BOX.label,
      uniqueness: BOX.uniqueness,
    } as unknown as IdentifierType;
    expect(codes(validateRecordIdentifiers(own, [typeless]))).toEqual(["mixed_organizations"]);
    expect(uniquenessIssues([own], [typeless]).map((i) => i.code)).toEqual(["mixed_organizations"]);
  });
});

describe("the searches refuse a mixed set instead of returning another organization's holders", () => {
  const OTHER = newOrganizationId();
  const theirs = newRecordId();
  const mine: RecordIdentifiers = {
    recordId: newRecordId(),
    organizationId: ORG,
    current: [{ type: "box_label", value: "B-1", primary: true }],
    former: [],
  };
  const other: RecordIdentifiers = {
    recordId: theirs,
    organizationId: OTHER,
    current: [{ type: "box_label", value: "B-1", primary: true }],
    former: [{ type: "box_label", value: "B-2" }],
  };

  it("findByIdentifier", () => {
    expect(codes(findByIdentifier("B-1", [mine, other]))).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(findByIdentifier("B-2", [other, mine]))).not.toContain(theirs);
    expect(listed(findByIdentifier("B-1", [mine]))).toHaveLength(1);
  });

  it("findIdentifierConflicts", () => {
    const r = findIdentifierConflicts(
      { type: "box_label", value: "B-1" },
      newRecordId(),
      [mine, other],
      TYPES,
    );
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(r)).not.toContain(theirs);
    expect(
      codes(
        findIdentifierConflicts(
          { type: "box_label", value: "B-1" },
          newRecordId(),
          [mine],
          [{ ...BOX, organizationId: OTHER }],
        ),
      ),
    ).toEqual(["mixed_organizations"]);
  });
});

describe("the set functions read their input once (second review of T-019)", () => {
  const theirs = newRecordId();
  const own: RecordIdentifiers = {
    recordId: newRecordId(),
    organizationId: ORG,
    current: [{ type: "box_label", value: "B-1", primary: true }],
    former: [],
  };
  const otherSet: RecordIdentifiers = {
    recordId: theirs,
    organizationId: newOrganizationId(),
    current: [{ type: "box_label", value: "B-1", primary: true }],
    former: [],
  };

  it("an iterator that yields another organization's set the second time is not walked", () => {
    let walks = 0;
    const tricky = [own];
    Object.defineProperty(tricky, Symbol.iterator, {
      value: function* () {
        walks += 1;
        yield walks === 1 ? own : otherSet;
      },
    });
    const r = findByIdentifier("B-1", tricky);
    expect(JSON.stringify(r)).not.toContain(theirs);
    expect(JSON.stringify(uniquenessIssues(tricky, TYPES))).not.toContain(theirs);
  });

  it("a current list behind a getter is refused, not read", () => {
    let reads = 0;
    const sneaky: RecordIdentifiers = Object.defineProperty({ ...own }, "current", {
      get: () => (reads++ === 0 ? own.current : otherSet.current),
      enumerable: true,
    });
    const r = findByIdentifier("B-1", [sneaky]);
    expect(r.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("a Proxy list is refused", () => {
    const proxy = new Proxy([own], {});
    expect(codes(findByIdentifier("B-1", proxy))).toEqual(["not_a_list"]);
    expect(
      codes(
        findIdentifierConflicts({ type: "box_label", value: "B-1" }, newRecordId(), proxy, TYPES),
      ),
    ).toEqual(["not_a_list"]);
    expect(uniquenessIssues(proxy, TYPES).map((i) => i.code)).toEqual(["not_a_list"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "B-1" }, newRecordId(), proxy, TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["not_a_list"]);
    expect(
      codes(
        nextIdentifier({ ...BOX, autoNumber: { style: "prefix", prefix: "B-", digits: 1 } }, proxy),
      ),
    ).toEqual(["not_a_list"]);
  });
});

describe("validateRecordIdentifiers reads the types once (third review of T-019)", () => {
  const OTHER = newOrganizationId();
  const set: RecordIdentifiers = {
    recordId: newRecordId(),
    organizationId: ORG,
    current: [{ type: "box_label", value: "anything goes", primary: true }],
    former: [],
  };
  // This organization's format, and another organization's looser one.
  const strict: IdentifierType = { ...BOX, pattern: "B-###" };
  const loose: IdentifierType = { ...BOX, organizationId: OTHER };

  it("an iterator that shows the check this organization's type and the format check another's is refused", () => {
    let walks = 0;
    const types = [strict];
    Object.defineProperty(types, Symbol.iterator, {
      value: function* () {
        walks += 1;
        yield walks === 1 ? strict : loose;
      },
    });
    const r = validateRecordIdentifiers(set, types);
    expect(r.ok).toBe(false);
  });

  it("a type behind a getter, or a Proxy list, is refused", () => {
    const getter = Object.defineProperty({ ...strict }, "pattern", {
      get: () => undefined,
      enumerable: true,
    });
    expect(validateRecordIdentifiers(set, [getter]).ok).toBe(false);
    expect(validateRecordIdentifiers(set, new Proxy([strict], {})).ok).toBe(false);
    expect(codes(validateRecordIdentifiers(set, [loose]))).toEqual(["mixed_organizations"]);
  });
});
