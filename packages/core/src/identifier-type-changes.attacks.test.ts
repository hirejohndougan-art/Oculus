// Attacks on identifier type changes (T-005a, D-031): an identifier type edit
// must not publish staff numbers, strand values or reissue a used number
// without anyone noticing, and hostile types or records must be refused
// without throwing.
import { describe, expect, it } from "vitest";
import {
  identifierTypeChanges,
  newOrganizationId,
  identifierTypeCreation,
  identifierTypeDeletion,
  newRecordId,
  validateTemplate,
  type IdentifierType,
  type IdentifierTypeChanges,
  type Validated,
} from "./index.js";
import { MAX_RECORD_SET } from "./effective.js";

// Invented sample data.
const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SECRET = "Donor file 555-0100 Jane Example";

const DONOR: IdentifierType = {
  organizationId: ORG,
  key: "donor_file",
  label: "Donor file",
  uniqueness: "none",
};
const OBJECT: IdentifierType = {
  organizationId: ORG,
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
  return { recordId, organizationId: ORG, current, former };
}

function record(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "object",
    organizationId: ORG,
    id,
    title: "Postcard",
    createdAt: T,
    updatedAt: T,
    fields,
  };
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
          organizationId: ORG,
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

describe("stranded staff values adopted by a public type", () => {
  // donor_file was deleted; its staff value stays in record A.
  const PUBLIC_ACC: IdentifierType = {
    organizationId: ORG,
    key: "accession",
    label: "Accession number",
    uniqueness: "current",
    pattern: "DHS-####",
    public: true,
  };
  const existing = {
    identifierTypes: [PUBLIC_ACC],
    identifiers: [set(A, [{ type: "donor_file", value: "SECRET-1", primary: true }])],
    records: [record(B, { file: { type: "donor_file", value: SECRET } })],
  };

  it("renaming a public type onto the key reports the adopted values as made public", () => {
    const r = ok(identifierTypeChanges(PUBLIC_ACC, { ...PUBLIC_ACC, key: "donor_file" }, existing));
    expect(r.changes.map((c) => [c.code, c.needsConfirmation, c.recordIds])).toEqual([
      ["key_changed", false, []],
      ["key_adopts_values", true, [A, B]],
      ["made_public", true, [A, B]],
    ]);
    expect(r.changes[1]?.misfitRecordIds).toEqual([A, B]);
    expect(JSON.stringify(r)).not.toContain("SECRET-1");
    expect(JSON.stringify(r)).not.toContain("555-0100");
  });

  it("creating a public type with that key reports them too", () => {
    const created = { ...PUBLIC_ACC, key: "donor_file" };
    const r = ok(identifierTypeCreation(created, existing));
    expect(r.changes.map((c) => [c.code, c.recordIds])).toEqual([
      ["key_adopts_values", [A, B]],
      ["made_public", [A, B]],
    ]);
    expect(r.needsConfirmation).toBe(true);
    // Without records, it may adopt values nobody can see.
    expect(ok(identifierTypeCreation(created)).changes.map((c) => c.code)).toEqual([
      "key_adopts_values",
      "made_public",
    ]);
    expect(codes(identifierTypeCreation(PUBLIC_ACC, existing))).toEqual(["key_taken"]);
    expect(codes(identifierTypeCreation({ ...created, key: "constructor" }))).toEqual([
      "reserved_key",
    ]);
  });
});

describe("records that can't be read refuse the whole check", () => {
  it("an invalid identifier set or record among valid ones refuses, rather than skipping it", () => {
    const badSet = use([
      ...SETS,
      set(newRecordId(), [{ type: "Not A Key", value: "1", primary: true }]),
    ]);
    expect(codes(identifierTypeChanges(DONOR, { ...DONOR, public: true }, badSet))).toEqual([
      "invalid_entry",
    ]);
    const badRecord = use(SETS, [record(A, {}), { kind: "object", id: B }]);
    expect(codes(identifierTypeDeletion(DONOR, badRecord))).toEqual(["invalid_entry"]);
  });

  it("stranded stored values (a removed type, a value off its format) are counted, not refused", () => {
    const strict: IdentifierType = { ...OBJECT, pattern: "DHS-####" };
    const sets = [
      set(A, [{ type: "removed_type", value: "1", primary: true }]),
      set(B, [{ type: "object_number", value: "OLD 5", primary: true }]),
    ];
    const existing = { identifierTypes: [DONOR, strict], identifiers: sets, records: [] };
    const r = ok(identifierTypeChanges(strict, { ...strict, key: "object_no" }, existing));
    expect(r.changes.map((c) => [c.code, c.recordIds])).toEqual([["key_changed", [B]]]);
    const del = ok(identifierTypeDeletion(strict, existing));
    expect(del.changes.map((c) => [c.code, c.recordIds])).toEqual([["type_deleted", [B]]]);
  });

  it("refuses data of another organization, or data that doesn't say whose it is (D-030)", () => {
    const OTHER = newOrganizationId();
    const theirs = { ...set(newRecordId(), []), organizationId: OTHER };
    const unowned = Object.fromEntries(
      Object.entries(set(newRecordId(), [])).filter(([k]) => k !== "organizationId"),
    );
    for (const [identifiers, code] of [
      [[...SETS, theirs], "mixed_organizations"],
      [[...SETS, unowned], "invalid_entry"],
    ] as const) {
      expect(codes(identifierTypeDeletion(DONOR, use(identifiers)))).toEqual([code]);
      expect(
        codes(identifierTypeCreation({ ...DONOR, key: "new_type" }, use(identifiers))),
      ).toEqual([code]);
    }
    const otherRecord = { ...record(A, {}), organizationId: OTHER };
    expect(codes(identifierTypeDeletion(DONOR, use(SETS, [otherRecord])))).toEqual([
      "mixed_organizations",
    ]);
    // The type itself must be the organization's, and stay in it.
    expect(codes(identifierTypeChanges(DONOR, { ...DONOR, organizationId: OTHER }, use()))).toEqual(
      ["mixed_organizations"],
    );
    const foreign = { ...DONOR, key: "new_type", organizationId: OTHER };
    expect(codes(identifierTypeCreation(foreign, use()))).toEqual(["mixed_organizations"]);
    expect(identifierTypeDeletion({ ...DONOR, organizationId: undefined }).ok).toBe(false);
  });

  it("another organization's type list can't reveal which keys it holds (S-009)", () => {
    const OTHER = newOrganizationId();
    const theirs = (key: string): IdentifierType => ({ ...DONOR, organizationId: OTHER, key });
    const probe = (key: string) => ({ ...DONOR, organizationId: OTHER, key });
    const listOf = (...keys: string[]) => ({
      identifierTypes: keys.map(theirs),
      identifiers: [],
      records: [],
    });
    // Creating: a key the other list holds and one it doesn't give the same answer.
    const held = identifierTypeCreation({ ...DONOR, key: "secret_key" }, listOf("secret_key"));
    const free = identifierTypeCreation({ ...DONOR, key: "secret_key" }, listOf("other_key"));
    expect(codes(held)).toEqual(["mixed_organizations"]);
    expect(held).toEqual(free);
    expect(JSON.stringify(held)).not.toContain("secret_key");
    // Editing and deleting: a type matching the other list's entry exactly, or not.
    for (const fn of [
      (t: IdentifierType, e: unknown) => identifierTypeDeletion(t, e),
      (t: IdentifierType, e: unknown) => identifierTypeChanges(t, t, e),
    ]) {
      const match = fn(DONOR, listOf("donor_file"));
      const miss = fn(DONOR, listOf("unrelated"));
      expect(codes(match)).toEqual(["mixed_organizations"]);
      expect(match).toEqual(miss);
    }
    // A list mixing ours and theirs is refused whatever key is looked up.
    const mixed = { identifierTypes: [DONOR, theirs("secret_key")], identifiers: [], records: [] };
    expect(codes(identifierTypeCreation({ ...DONOR, key: "secret_key" }, mixed))).toEqual([
      "mixed_organizations",
    ]);
    // Their own list still works for them.
    expect(codes(identifierTypeCreation(probe("secret_key"), listOf("secret_key")))).toEqual([
      "key_taken",
    ]);
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
    }
    for (const key of ["call-number", "__proto__", "Accession", ""]) {
      expect(identifierTypeDeletion({ ...DONOR, key }).ok).toBe(false);
    }
    // And templates can no longer name a hyphenated type (D-031).
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
    const t = validateTemplate({
      key: "t",
      label: "T",
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [field],
    });
    expect(codes(t)).toEqual(["invalid_code"]);
  });

  it("a stored type keyed 'constructor' must be renamed when edited, and can be deleted", () => {
    const legacy: IdentifierType = {
      organizationId: ORG,
      key: "constructor",
      label: "Old",
      uniqueness: "none",
    };
    const existing = {
      identifierTypes: [legacy],
      identifiers: [set(A, [{ type: "constructor", value: "7", primary: true }])],
      records: [],
    };
    const r = ok(identifierTypeChanges(legacy, { ...legacy, label: "Older" }, existing));
    expect(r.changes.map((c) => [c.code, c.needsConfirmation, c.recordIds])).toEqual([
      ["reserved_key", true, [A]],
    ]);
    const renamed = ok(identifierTypeChanges(legacy, { ...legacy, key: "old_number" }, existing));
    expect(renamed.changes.map((c) => c.code)).toEqual(["key_changed"]);
    expect(codes(identifierTypeChanges(DONOR, { ...DONOR, key: "prototype" }))).toEqual([
      "reserved_key",
    ]);
    expect(ok(identifierTypeDeletion(legacy, existing)).changes[0]?.recordIds).toEqual([A]);
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
      {
        ...wide,
        pattern: "@*{0,99}*{0,98}",
        uniqueness: "all_time",
        public: true,
      },
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
