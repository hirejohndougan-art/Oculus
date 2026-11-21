// Attacks on identifier type changes (T-005a, D-0XX): an identifier type edit
// must not publish staff numbers, strand values or reissue a used number
// without anyone noticing, and hostile types or records must be refused
// without throwing.
import { describe, expect, it } from "vitest";
import {
  identifierTypeChanges,
  identifierTypeDeletion,
  newRecordId,
  validateTemplate,
  type IdentifierType,
  type IdentifierTypeChanges,
  type Validated,
} from "./index.js";
import { MAX_RECORD_SET } from "./effective.js";

// Invented sample data.
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SECRET = "Donor file 555-0100 Jane Example";

const DONOR: IdentifierType = { key: "donor_file", label: "Donor file", uniqueness: "none" };
const OBJECT: IdentifierType = {
  key: "object_number",
  label: "Object number",
  uniqueness: "current",
  public: true,
};

function set(
  recordId: string,
  current: unknown[],
  former: unknown[] = [],
): Record<string, unknown> {
  return { recordId, current, former };
}

function record(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { kind: "object", id, title: "Postcard", createdAt: T, updatedAt: T, fields };
}

const SETS = [
  set(A, [{ type: "donor_file", value: SECRET, primary: true }]),
  set(B, [], [{ type: "donor_file", value: `${SECRET} (old)`, note: SECRET }]),
];

function use(identifiers: unknown = SETS, records: unknown = []): Record<string, unknown> {
  return { identifierTypes: [DONOR, OBJECT], identifiers, records };
}

function ok(result: Validated<IdentifierTypeChanges>): IdentifierTypeChanges {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("staff numbers published by a type change", () => {
  it("reports a staff type made public, with records holding it only as a former number", () => {
    const r = ok(identifierTypeChanges(DONOR, { ...DONOR, public: true }, use()));
    expect(r.changes.map((c) => [c.code, c.needsConfirmation, c.recordIds])).toEqual([
      ["made_public", true, [A, B]],
    ]);
  });

  it("a polluted Object.prototype can't hide a type made public", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.public = true;
    try {
      const r = ok(identifierTypeChanges(DONOR, { ...DONOR, public: true }, use()));
      expect(r.changes.map((c) => c.code)).toEqual(["made_public"]);
      const del = ok(identifierTypeDeletion(DONOR, use()));
      expect(del.changes.map((c) => c.code)).toEqual(["type_deleted"]);
    } finally {
      delete proto.public;
    }
  });

  it("refuses renaming a staff type onto a public type's key", () => {
    expect(codes(identifierTypeChanges(DONOR, { ...DONOR, key: "object_number" }, use()))).toEqual([
      "key_taken",
    ]);
  });

  it("never quotes a stored value, in changes or in refusals", () => {
    const all = ok(
      identifierTypeChanges(
        DONOR,
        {
          key: "donor_ref",
          label: "Donor file",
          pattern: "D-###",
          uniqueness: "all_time",
          autoNumber: { style: "prefix", prefix: "D-", digits: 3 },
          public: true,
        },
        use(SETS, [record(A, { file: { type: "donor_file", value: SECRET } })]),
      ),
    );
    expect(all.changes.length).toBeGreaterThan(3);
    expect(JSON.stringify(all)).not.toContain("555-0100");
    const deleted = ok(identifierTypeDeletion(DONOR, use()));
    expect(JSON.stringify(deleted)).not.toContain("555-0100");
    const bad = identifierTypeChanges(
      DONOR,
      DONOR,
      use([set(A, [{ type: "donor_file", value: `${SECRET}\n`, primary: true }])]),
    );
    expect(codes(bad)).toEqual(["invalid_entry"]);
    expect(JSON.stringify(bad)).not.toContain("555-0100");
  });
});

describe("records that can't be read refuse the whole check", () => {
  it("an invalid identifier set or record among valid ones refuses, rather than skipping it", () => {
    const badSet = use([
      ...SETS,
      set(newRecordId(), [{ type: "nope", value: "1", primary: true }]),
    ]);
    expect(codes(identifierTypeChanges(DONOR, { ...DONOR, public: true }, badSet))).toEqual([
      "invalid_entry",
    ]);
    const badRecord = use(SETS, [record(A, {}), { kind: "object", id: B }]);
    expect(codes(identifierTypeDeletion(DONOR, badRecord))).toEqual(["invalid_entry"]);
  });

  it("refuses an ID used twice, so one record can't shadow another", () => {
    expect(codes(identifierTypeDeletion(DONOR, use([...SETS, set(A, [])])))).toEqual([
      "duplicate_id",
    ]);
    expect(codes(identifierTypeDeletion(DONOR, use(SETS, [record(A, {}), record(A, {})])))).toEqual(
      ["duplicate_id"],
    );
  });

  it("a missing list is refused, never read as 'no records'", () => {
    expect(
      codes(identifierTypeDeletion(DONOR, { identifierTypes: [DONOR], identifiers: [] })),
    ).toEqual(["not_a_list"]);
    expect(codes(identifierTypeDeletion(DONOR, []))).toEqual(["not_an_object"]);
    expect(codes(identifierTypeDeletion(DONOR, null))).toEqual(["not_an_object"]);
    expect(codes(identifierTypeDeletion(DONOR, { ...use(), extra: [] }))).toEqual([
      "unknown_property",
    ]);
  });

  it("an old type that differs from the organization's list is refused", () => {
    // Claiming the type was already public would hide the made_public change.
    const claimed = { ...DONOR, public: true };
    expect(codes(identifierTypeChanges(claimed, claimed, use()))).toEqual(["type_not_listed"]);
  });

  it("refuses too many entries without reading them", () => {
    const huge = new Array<unknown>(MAX_RECORD_SET + 1);
    expect(codes(identifierTypeDeletion(DONOR, use(huge)))).toEqual(["too_many_records"]);
    expect(codes(identifierTypeDeletion(DONOR, use([], huge)))).toEqual(["too_many_records"]);
  });
});

describe("hostile input", () => {
  it("Proxies are refused without running their traps", () => {
    let trapped = 0;
    const trap = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, p, r) {
          trapped += 1;
          return Reflect.get(t, p, r) as unknown;
        },
        ownKeys(t) {
          trapped += 1;
          return Reflect.ownKeys(t);
        },
      });
    expect(codes(identifierTypeChanges(trap({ ...DONOR }), DONOR))).toEqual(["not_an_object"]);
    expect(codes(identifierTypeChanges(DONOR, trap({ ...DONOR })))).toEqual(["not_an_object"]);
    expect(codes(identifierTypeDeletion(DONOR, trap(use())))).toEqual(["not_an_object"]);
    expect(codes(identifierTypeDeletion(DONOR, use(trap([...SETS]))))).toEqual(["not_a_list"]);
    expect(codes(identifierTypeDeletion(DONOR, use(SETS, trap([]))))).toEqual(["not_a_list"]);
    expect(trapped).toBe(0);
  });

  it("getters are never run, and throwing ones don't throw", () => {
    let ran = 0;
    const existing = use();
    Object.defineProperty(existing, "records", {
      enumerable: true,
      get() {
        ran += 1;
        throw new Error("boom");
      },
    });
    expect(codes(identifierTypeDeletion(DONOR, existing))).toEqual(["not_a_list"]);
    const list: unknown[] = [];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        ran += 1;
        return SETS[0];
      },
    });
    expect(codes(identifierTypeDeletion(DONOR, use(list)))).toEqual(["invalid_entry"]);
    const type = { ...DONOR };
    Object.defineProperty(type, "public", {
      enumerable: true,
      get() {
        ran += 1;
        throw new Error("boom");
      },
    });
    expect(identifierTypeChanges(DONOR, type).ok).toBe(false);
    expect(ran).toBe(0);
  });

  it("refuses types that break the key rule, hyphens and prototype keys included", () => {
    for (const key of ["call-number", "constructor", "__proto__", "Accession", ""]) {
      expect(identifierTypeChanges(DONOR, { ...DONOR, key }).ok).toBe(false);
      expect(identifierTypeDeletion({ ...DONOR, key }).ok).toBe(false);
    }
    // And templates can no longer name a hyphenated type (D-0XX).
    const field = {
      key: "ref",
      label: "Ref",
      kind: "identifier",
      required: false,
      repeatable: false,
      visibility: "staff",
      inherited: false,
      identifierTypes: ["call-number"],
    };
    const t = validateTemplate({ key: "t", label: "T", appliesTo: ["object"], fields: [field] });
    expect(codes(t)).toEqual(["invalid_code"]);
  });

  it("non-objects of every kind are refused, never thrown on", () => {
    for (const bad of [undefined, null, 1, "x", [], () => 1, Symbol("x"), new Date(0)]) {
      expect(identifierTypeChanges(bad, DONOR).ok).toBe(false);
      expect(identifierTypeChanges(DONOR, bad).ok).toBe(false);
      expect(identifierTypeDeletion(bad).ok).toBe(false);
      if (bad !== undefined) expect(identifierTypeDeletion(DONOR, bad).ok).toBe(false);
    }
  });

  it("stays fast on many identifiers and a worst-case format", () => {
    // 200 optional slots and values that run through all of them.
    const wide: IdentifierType = { ...DONOR, pattern: "@*{0,99}*{0,100}" };
    const sets = Array.from({ length: 2_000 }, () =>
      set(newRecordId(), [{ type: "donor_file", value: "A".repeat(200), primary: true }]),
    );
    const start = Date.now();
    const r = identifierTypeChanges(
      wide,
      { ...wide, pattern: "@*{0,99}*{0,98}", uniqueness: "all_time", public: true },
      { identifierTypes: [wide], identifiers: sets, records: [] },
    );
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(ok(r).changes.map((c) => [c.code, c.recordCount])).toEqual([
      ["made_public", 2_000],
      ["format_changed", 2_000],
      ["uniqueness_tightened", 2_000],
    ]);
  });
});
