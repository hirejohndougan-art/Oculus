// Attacks on identifier types and identifiers. Each must be refused or
// neutralized, and nothing may throw or take more than linear time.
import { describe, expect, it } from "vitest";
import {
  MAX_FORMER_IDENTIFIERS,
  checkNewIdentifier,
  findByIdentifier,
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
