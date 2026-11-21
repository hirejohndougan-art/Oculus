// Attacks on the ready-made field checkers and on how checkRecordAgainstTemplate
// picks them. Each test tries one way to get a value accepted unchecked or to
// make a checker throw; each must fail closed.
import { describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
  checkRightsValue,
  makeIdentifierChecker,
  validateRecord,
  validateTemplate,
  type CatalogRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldValueChecker,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const T = "2026-11-20T16:05:00.000Z";
const INC = "http://rightsstatements.org/vocab/InC/1.0/";
// Public, so values may sit in the public fields used here (D-022).
const TYPES = [
  { key: "legacy", label: "Legacy number", organizationId: ORG, uniqueness: "none", public: true },
];

function field(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "F",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

function template(fields: unknown[]): FieldTemplate {
  const r = validateTemplate({ key: "t", label: "T", appliesTo: ["object"], fields });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function record(fields: Record<string, unknown>): CatalogRecord {
  const r = validateRecord({
    kind: "object",
    id: ID,
    title: "Depot",
    organizationId: ORG,
    createdAt: T,
    updatedAt: T,
    fields,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function identifierChecker(): FieldValueChecker {
  const made = makeIdentifierChecker(TYPES);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  return made.value;
}

const RIGHTS = template([field({ key: "rights", kind: "rights" })]);
const NUMBER = template([field({ key: "number", kind: "identifier" })]);
const anyField = {} as FieldDefinition;
const rec = record({});
const codes = (list: readonly { code: string }[]): string[] => list.map((i) => i.code);

describe("switching a check off by accident", () => {
  it("a checker on Object.prototype doesn't replace the rights default", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.rights = () => [];
    try {
      const r = checkRecordAgainstTemplate(
        record({ rights: { uri: "https://example.org/" } }),
        RIGHTS,
        {
          checkers: {},
        },
      );
      expect(codes(r)).toEqual(["unknown_rights"]);
    } finally {
      delete proto.rights;
    }
  });

  it("a checker on Object.prototype doesn't count as an identifier checker", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.identifier = () => [];
    try {
      const r = checkRecordAgainstTemplate(
        record({ number: { type: "legacy", value: "P-12" } }),
        NUMBER,
        {
          checkers: {},
        },
      );
      expect(codes(r)).toEqual(["unchecked"]);
    } finally {
      delete proto.identifier;
    }
  });

  it("checkers inherited from a prototype object are ignored", () => {
    const checkers = Object.create({ rights: () => [], identifier: () => [] }) as object;
    const r = checkRecordAgainstTemplate(
      record({ rights: { uri: "https://example.org/" } }),
      RIGHTS,
      {
        checkers,
      },
    );
    expect(codes(r)).toEqual(["unknown_rights"]);
  });
});

describe("hostile values given straight to a checker", () => {
  it("ignores a uri or type inherited from a prototype", () => {
    const value = Object.create({ uri: INC }) as never;
    expect(codes(checkRightsValue(value, anyField, rec))).toEqual(["not_an_object"]);
    const proto = Object.prototype as Record<string, unknown>;
    proto.uri = INC;
    proto.type = "legacy";
    try {
      expect(codes(checkRightsValue({}, anyField, rec))).toEqual(["rights_missing"]);
      expect(codes(identifierChecker()({ value: "P-12" }, anyField, rec))).toEqual([
        "unknown_type",
      ]);
    } finally {
      delete proto.uri;
      delete proto.type;
    }
  });

  it("can't reach built-ins through the type key", () => {
    const check = identifierChecker();
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(codes(check({ type, value: "P-12" }, anyField, rec))).toEqual(["unknown_type"]);
    }
  });

  it("doesn't throw on a throwing getter or a Proxy", () => {
    const getter = {};
    Object.defineProperty(getter, "uri", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom");
        },
      },
    );
    for (const value of [getter, trap]) {
      expect(() => checkRightsValue(value as never, anyField, rec)).not.toThrow();
      expect(() => identifierChecker()(value as never, anyField, rec)).not.toThrow();
    }
    expect(codes(checkRightsValue(getter as never, anyField, rec))).toEqual(["unreadable"]);
  });

  it("doesn't throw when the record isn't one", () => {
    const check = identifierChecker();
    expect(() => check({ type: "legacy", value: "P-12" }, anyField, null as never)).not.toThrow();
    expect(codes(check({ type: "legacy", value: "P-12" }, anyField, null as never))).toEqual([
      "unreadable",
    ]);
  });

  it("refuses hostile identifier types without throwing", () => {
    for (const types of [new Proxy(TYPES, {}), [new Proxy(TYPES[0] ?? {}, {})], null, "legacy"]) {
      expect(makeIdentifierChecker(types).ok).toBe(false);
    }
  });
});

describe("staff identifier types can't be made public by accident (D-022)", () => {
  const STAFF = [
    { key: "donor_file", label: "Donor file number", organizationId: ORG, uniqueness: "none" },
  ];

  it("a public flag on Object.prototype doesn't make a type public", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.public = true;
    try {
      const made = makeIdentifierChecker(STAFF);
      if (!made.ok) throw new Error("types");
      const r = checkRecordAgainstTemplate(
        record({ number: { type: "donor_file", value: "DF-12" } }),
        NUMBER,
        { checkers: { identifier: made.value } },
      );
      expect(codes(r)).toEqual(["private_identifier_type"]);
    } finally {
      delete proto.public;
    }
  });

  it("a field object with a hostile visibility counts as public", () => {
    const made = makeIdentifierChecker(STAFF);
    if (!made.ok) throw new Error("types");
    for (const f of [
      { visibility: "Staff" },
      { visibility: ["staff"] },
      Object.create({ visibility: "staff" }) as object,
    ]) {
      const found = made.value({ type: "donor_file", value: "DF-12" }, f as FieldDefinition, rec);
      expect(codes(found)).toEqual(["private_identifier_type"]);
    }
  });
});
