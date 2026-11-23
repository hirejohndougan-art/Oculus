// Attacks on record type changes (T-013a, D-053a): a record type edit must
// not strand records unseen, another organization's data must never show in
// a message, and hostile input must be refused without throwing.
import { describe, expect, it } from "vitest";
import {
  MAX_LISTED_RECORDS,
  MAX_RECORD_TYPES,
  newOrganizationId,
  newRecordId,
  recordTypeChanges,
  recordTypeDeletion,
  type RecordType,
  type RecordTypeChanges,
  type Validated,
} from "./index.js";
import { MAX_RECORD_SET } from "./effective.js";

// Invented sample data.
const ORG = newOrganizationId();
const OTHER = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SECRET_TITLE = "Interview with Jane Example 555-0100";

const ORAL: RecordType = {
  key: "oral-history",
  organizationId: ORG,
  label: "Oral history",
  kind: "digital_asset",
  defaultTemplateKey: "oral-history",
};
const THEIRS: RecordType = {
  key: "secret-donor-type",
  organizationId: OTHER,
  label: "Their secret type",
  kind: "object",
  defaultTemplateKey: "secret-template",
};

function record(id: string, recordTypeKey?: string, org: string = ORG): Record<string, unknown> {
  return {
    kind: "digital_asset",
    organizationId: org,
    id,
    title: SECRET_TITLE,
    createdAt: T,
    updatedAt: T,
    templateKey: "oral-history",
    mediaType: "audio/wav",
    ...(recordTypeKey === undefined ? {} : { recordTypeKey }),
    fields: {},
  };
}

function use(records: unknown = [record(A, "oral-history")], recordTypes: unknown = [ORAL]) {
  return { recordTypes, records };
}

function ok(result: Validated<RecordTypeChanges>): RecordTypeChanges {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function text(result: unknown): string {
  return JSON.stringify(result);
}

describe("other organizations' data", () => {
  it("refuses a new type of another organization without naming its key", () => {
    const r = recordTypeChanges(ORAL, { ...THEIRS }, use());
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(text(r)).not.toContain("secret");
  });

  it("another organization's type list can't reveal which keys it holds", () => {
    // Renaming onto a key the other organization has: no key_taken.
    const r = recordTypeChanges(
      ORAL,
      { ...ORAL, key: "secret-donor-type" },
      use([], [ORAL, THEIRS]),
    );
    expect(codes(r)).toEqual(["mixed_organizations"]);
    const only = recordTypeDeletion(ORAL, use([], [THEIRS]));
    expect(codes(only)).toEqual(["mixed_organizations"]);
    expect(text(only)).not.toContain("secret");
  });

  it("another organization's invalid type list gets no message naming its keys", () => {
    const bad = { ...THEIRS, label: "", extra: "secret-property" };
    const r = recordTypeDeletion(ORAL, use([], [ORAL, bad]));
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(text(r)).not.toContain("secret");
  });

  it("a type list entry or record that doesn't say whose it is is refused", () => {
    const noOrg: Record<string, unknown> = { ...ORAL };
    delete noOrg.organizationId;
    expect(codes(recordTypeDeletion(ORAL, use([], [noOrg])))).toEqual(["mixed_organizations"]);
    const r = record(B, "oral-history");
    delete r.organizationId;
    expect(codes(recordTypeDeletion(ORAL, use([r])))).toEqual(["mixed_organizations"]);
  });

  it("another organization's records are refused, never filtered or counted", () => {
    const r = recordTypeDeletion(
      ORAL,
      use([record(A, "oral-history"), record(B, "oral-history", OTHER)]),
    );
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(text(r)).not.toContain(B);
  });
});

describe("messages", () => {
  it("never quote a record's title, in changes or in refusals", () => {
    const changed = recordTypeChanges(ORAL, { ...ORAL, key: "interview", kind: "object" }, use());
    expect(changed.ok).toBe(true);
    expect(text(changed)).not.toContain("Jane");
    const bad = { ...record(B, "oral-history"), title: "", note: SECRET_TITLE };
    const refused = recordTypeDeletion(ORAL, use([record(A), bad]));
    expect(codes(refused)).toEqual(["invalid_entry"]);
    expect(text(refused)).not.toContain("Jane");
  });
});

describe("records that can't be read refuse the whole check", () => {
  it("an invalid record among valid ones refuses, rather than skipping it", () => {
    const r = recordTypeDeletion(ORAL, use([record(A, "oral-history"), { id: B }]));
    expect(codes(r)).toEqual(["mixed_organizations"]);
    const r2 = recordTypeDeletion(
      ORAL,
      use([record(A, "oral-history"), { ...record(B), kind: "nope" }]),
    );
    expect(codes(r2)).toEqual(["invalid_entry"]);
  });

  it("refuses an ID used twice, so one record can't shadow another", () => {
    const r = recordTypeDeletion(ORAL, use([record(A), record(A, "oral-history")]));
    expect(codes(r)).toEqual(["duplicate_id"]);
  });

  it("refuses a type list naming a key twice", () => {
    expect(codes(recordTypeDeletion(ORAL, use([], [ORAL, { ...ORAL }])))).toEqual([
      "duplicate_key",
    ]);
  });

  it("a missing list is refused, never read as 'no records'", () => {
    expect(codes(recordTypeDeletion(ORAL, { recordTypes: [ORAL] }))).toEqual(["not_a_list"]);
    expect(codes(recordTypeDeletion(ORAL, { records: [] }))).toEqual(["not_a_list"]);
    expect(codes(recordTypeDeletion(ORAL, { ...use(), templates: [] }))).toEqual([
      "unknown_property",
    ]);
  });

  it("refuses holes in a list", () => {
    const holey: unknown[] = [];
    holey[1] = ORAL;
    expect(codes(recordTypeDeletion(ORAL, use([], holey)))).toEqual(["mixed_organizations"]);
  });
});

describe("oversized lists", () => {
  it("refuses too many types or records without reading them", () => {
    let reads = 0;
    const many = new Array(MAX_RECORD_SET + 1);
    Object.defineProperty(many, 0, {
      get() {
        reads += 1;
        return record(A);
      },
    });
    expect(codes(recordTypeDeletion(ORAL, use(many)))).toEqual(["too_many"]);
    const types = new Array(MAX_RECORD_TYPES + 1);
    Object.defineProperty(types, 0, {
      get() {
        reads += 1;
        return ORAL;
      },
    });
    expect(codes(recordTypeDeletion(ORAL, use([], types)))).toEqual(["too_many"]);
    expect(reads).toBe(0);
  });

  it(`lists at most MAX_LISTED_RECORDS IDs but counts every record`, () => {
    const records = Array.from({ length: MAX_LISTED_RECORDS + 5 }, () =>
      record(newRecordId(), "oral-history"),
    );
    const r = ok(recordTypeDeletion(ORAL, use(records)));
    expect(r.changes[0]?.recordIds.length).toBe(MAX_LISTED_RECORDS);
    expect(r.changes[0]?.recordCount).toBe(MAX_LISTED_RECORDS + 5);
    expect(r.changes[0]?.message).toContain(`${String(MAX_LISTED_RECORDS + 5)} records name it`);
  });
});

describe("hostile input", () => {
  it("Proxies are refused without running their traps", () => {
    let trapped = 0;
    const handler: ProxyHandler<object> = {
      get(target, p, receiver) {
        trapped += 1;
        return Reflect.get(target, p, receiver) as unknown;
      },
      getOwnPropertyDescriptor(target, p) {
        trapped += 1;
        return Reflect.getOwnPropertyDescriptor(target, p);
      },
      ownKeys(target) {
        trapped += 1;
        return Reflect.ownKeys(target);
      },
    };
    expect(codes(recordTypeDeletion(new Proxy({ ...ORAL }, handler)))).toEqual(["not_an_object"]);
    expect(codes(recordTypeChanges(ORAL, new Proxy({ ...ORAL }, handler)))).toEqual([
      "not_an_object",
    ]);
    expect(codes(recordTypeDeletion(ORAL, new Proxy(use(), handler)))).toEqual(["not_an_object"]);
    expect(codes(recordTypeDeletion(ORAL, use(new Proxy([], handler))))).toEqual(["not_a_list"]);
    expect(codes(recordTypeDeletion(ORAL, use([], new Proxy([ORAL], handler))))).toEqual([
      "not_a_list",
    ]);
    expect(codes(recordTypeDeletion(ORAL, use([new Proxy(record(A), handler)])))).toEqual([
      "mixed_organizations",
    ]);
    expect(trapped).toBe(0);
  });

  it("getters are never run, and throwing ones don't throw", () => {
    let ran = 0;
    const getter = {
      get(): never {
        ran += 1;
        throw new Error("boom");
      },
    };
    const existing = {};
    Object.defineProperty(existing, "records", { ...getter, enumerable: true });
    Object.defineProperty(existing, "recordTypes", { value: [ORAL], enumerable: true });
    expect(codes(recordTypeDeletion(ORAL, existing))).toEqual(["not_a_list"]);

    const slot: unknown[] = [];
    Object.defineProperty(slot, 0, { ...getter, enumerable: true });
    expect(codes(recordTypeDeletion(ORAL, use(slot)))).toEqual(["mixed_organizations"]);

    const typed = record(A);
    Object.defineProperty(typed, "recordTypeKey", { ...getter, enumerable: true });
    expect(codes(recordTypeDeletion(ORAL, use([typed])))).toEqual(["invalid_entry"]);

    const type = { ...ORAL };
    Object.defineProperty(type, "kind", { ...getter, enumerable: true });
    expect(recordTypeChanges(ORAL, type).ok).toBe(false);
    expect(ran).toBe(0);
  });

  it("a polluted Object.prototype gives no record a type and no type a description", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.recordTypeKey = "oral-history";
    proto.description = "polluted";
    try {
      const r = ok(recordTypeDeletion(ORAL, use([record(A), record(B)])));
      expect(r.changes[0]?.recordCount).toBe(0);
      // The list's type has no description; neither has the one given.
      expect(
        ok(recordTypeChanges(ORAL, { ...ORAL, label: "Oral histories" }, use([], [ORAL]))).changes,
      ).toEqual([]);
    } finally {
      delete proto.recordTypeKey;
      delete proto.description;
    }
  });

  it("a polluted Object.prototype can't make a listed type match a different one", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.description = "Recorded interviews.";
    try {
      const described = { ...ORAL, description: "Recorded interviews." };
      // The stored type has no description; the claimed old type has one.
      expect(codes(recordTypeDeletion(described, use([], [ORAL])))).toEqual(["type_not_listed"]);
    } finally {
      delete proto.description;
    }
  });

  it("refuses an old type that claims another kind than the stored one", () => {
    // A caller can't hide a kind change by lying about the old kind.
    const r = recordTypeChanges({ ...ORAL, kind: "object" }, { ...ORAL, kind: "object" }, use());
    expect(codes(r)).toEqual(["type_not_listed"]);
  });

  it("non-objects of every kind are refused, never thrown on", () => {
    for (const bad of [null, 1, "x", [], Symbol("s"), () => 1, new Date(), Object.create(null)]) {
      expect(recordTypeDeletion(bad).ok).toBe(false);
      expect(recordTypeChanges(ORAL, bad).ok).toBe(false);
      if (bad !== undefined) expect(recordTypeDeletion(ORAL, bad).ok).toBe(false);
    }
  });
});
