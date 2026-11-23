import { describe, expect, it, vi } from "vitest";
import {
  checkRecordAgainstTemplate,
  checkRightsValue,
  createRecord,
  makeIdentifierChecker,
  rightsPublishIssues,
  validateRecord,
  validateTemplate,
  type CatalogRecord,
  type FieldDefinition,
  type FieldProblem,
  type FieldTemplate,
  type FieldValueChecker,
  type Issue,
  type TemplateCheckOptions,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const T = "2026-11-20T16:05:00.000Z";
const INC = "http://rightsstatements.org/vocab/InC/1.0/";
const CC_BY = "https://creativecommons.org/licenses/by/4.0/";

/**
 * The sample organization's identifier types. Invented. Both are public, so
 * their values may sit in the public fields used below; types are staff only
 * by default (D-022), tested under "identifier type visibility".
 */
const TYPES = [
  {
    key: "accession",
    label: "Accession number",
    pattern: "####.###",
    organizationId: ORG,
    uniqueness: "all_time",
    autoNumber: { style: "year", separator: ".", digits: 3 },
    public: true,
  },
  { key: "legacy", label: "Legacy number", organizationId: ORG, uniqueness: "none", public: true },
];

function field(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "note",
    label: "Note",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

function template(fields: unknown[]): FieldTemplate {
  const r = validateTemplate({
    key: "sample",
    label: "Sample",
    organizationId: ORG,
    appliesTo: ["object"],
    fields,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const RIGHTS = template([field({ key: "rights", label: "Rights", kind: "rights" })]);
const NUMBERS = template([
  field({ key: "numbers", label: "ID numbers", kind: "identifier", repeatable: true }),
]);

function record(fields: Record<string, unknown>): CatalogRecord {
  const r = validateRecord({
    kind: "object",
    id: ID,
    title: "Dickinson Station and Park",
    organizationId: ORG,
    createdAt: T,
    updatedAt: T,
    fields,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function identifierChecker(types: unknown = TYPES): FieldValueChecker {
  const made = makeIdentifierChecker(types);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  return made.value;
}

const anyField = {} as FieldDefinition;
const rec = record({});

const codes = (list: readonly (Issue | FieldProblem)[]): string[] => list.map((p) => p.code);
const paths = (list: readonly Issue[]): string[] => list.map((p) => p.path.join("."));

function checkRights(value: unknown, options?: TemplateCheckOptions): Issue[] {
  return checkRecordAgainstTemplate(record({ rights: value }), RIGHTS, options);
}

function checkNumbers(values: unknown[], options?: TemplateCheckOptions): Issue[] {
  return checkRecordAgainstTemplate(record({ numbers: values }), NUMBERS, options);
}

// ---------------------------------------------------------------------------

describe("checkRightsValue", () => {
  it("accepts the canonical URI of a statement or license, with or without a note", () => {
    expect(checkRightsValue({ uri: INC }, anyField, rec)).toEqual([]);
    expect(checkRightsValue({ uri: CC_BY, note: "Credit the Society." }, anyField, rec)).toEqual(
      [],
    );
  });

  it("refuses variants, naming the canonical form, at the path uri", () => {
    const found = checkRightsValue(
      { uri: "https://rightsstatements.org/page/InC/1.0/" },
      anyField,
      rec,
    );
    expect(codes(found)).toEqual(["not_canonical"]);
    expect(found[0]?.path).toEqual(["uri"]);
    expect(found[0]?.message).toContain(INC);
  });

  it("refuses unknown values, older versions and a missing uri", () => {
    const code = (value: unknown): string[] =>
      codes(checkRightsValue(value as never, anyField, rec));
    expect(code({ uri: "https://example.org/rights" })).toEqual(["unknown_rights"]);
    expect(code({ uri: "https://creativecommons.org/licenses/by/3.0/" })).toEqual([
      "unsupported_version",
    ]);
    expect(code({ note: "Ask first" })).toEqual(["rights_missing"]);
    expect(code(INC)).toEqual(["not_an_object"]);
    expect(code(null)).toEqual(["not_an_object"]);
  });

  it("returns frozen problems", () => {
    const found = checkRightsValue({ uri: "https://example.org/" }, anyField, rec);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0])).toBe(true);
    expect(Object.isFrozen(found[0]?.path)).toBe(true);
  });
});

describe("makeIdentifierChecker", () => {
  it("refuses identifier types that aren't valid, and makes no checker", () => {
    const r = makeIdentifierChecker([
      { key: "Accession", label: "A", organizationId: ORG, uniqueness: "none" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.issues)).toEqual(["invalid_key"]);
    const notList = makeIdentifierChecker({ accession: {} });
    expect(notList.ok).toBe(false);
    if (!notList.ok) expect(codes(notList.issues)).toEqual(["not_a_list"]);
  });

  it("accepts an empty list of types, and then knows no type", () => {
    const check = identifierChecker([]);
    expect(codes(check({ type: "accession", value: "2026.001" }, anyField, rec))).toEqual([
      "unknown_type",
    ]);
  });

  it("accepts a value of a known type that fits its format", () => {
    const check = identifierChecker();
    expect(check({ type: "accession", value: "2026.001" }, anyField, rec)).toEqual([]);
    expect(check({ type: "legacy", value: "Box 4, no. 12" }, anyField, rec)).toEqual([]);
  });

  it("reports a type the organization doesn't have, at the path type", () => {
    const found = identifierChecker()({ type: "barcode", value: "123" }, anyField, rec);
    expect(codes(found)).toEqual(["unknown_type"]);
    expect(found[0]?.path).toEqual(["type"]);
    expect(found[0]?.message).toContain('"barcode"');
  });

  it("reports a value that doesn't fit the type's format, at the path value", () => {
    const found = identifierChecker()({ type: "accession", value: "26.1" }, anyField, rec);
    expect(codes(found)).toEqual(["format_mismatch"]);
    expect(found[0]?.path).toEqual(["value"]);
  });

  it("applies the rules every identifier follows", () => {
    const check = identifierChecker();
    const code = (value: unknown): string[] =>
      codes(check({ type: "legacy", value } as never, anyField, rec));
    expect(code("P\u00AD12")).toEqual(["invisible_characters"]);
    expect(code(" P-12")).toEqual(["untrimmed"]);
    expect(code("x".repeat(201))).toEqual(["too_long"]);
    expect(code(undefined)).toEqual(["required"]);
    expect(codes(check("P-12", anyField, rec))).toEqual(["not_an_object"]);
  });

  it("doesn't check uniqueness, which needs every record", () => {
    const check = identifierChecker();
    expect(check({ type: "accession", value: "2026.001" }, anyField, rec)).toEqual([]);
    expect(check({ type: "accession", value: "2026.001" }, anyField, record({}))).toEqual([]);
  });

  it("uses a copy of the types, so changing the list afterwards changes nothing", () => {
    const types = structuredClone(TYPES);
    const check = identifierChecker(types);
    types.length = 0;
    expect(check({ type: "accession", value: "2026.001" }, anyField, rec)).toEqual([]);
  });

  it("returns frozen problems", () => {
    const found = identifierChecker()({ type: "accession", value: "x" }, anyField, rec);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0])).toBe(true);
  });
});

describe("checkRecordAgainstTemplate: the rights checker runs by default", () => {
  it("accepts a canonical URI with no options", () => {
    expect(checkRights({ uri: INC })).toEqual([]);
  });

  it("refuses a variant or an unknown URI with no options", () => {
    const r = checkRights({ uri: "http://rightsstatements.org/vocab/InC/1.0" });
    expect(codes(r)).toEqual(["not_canonical"]);
    expect(paths(r)).toEqual(["fields.rights.uri"]);
    expect(codes(checkRights({ uri: "https://example.org/rights" }))).toEqual(["unknown_rights"]);
  });

  it("still runs with an empty checkers object, or rights: undefined", () => {
    const bad = { uri: "https://example.org/rights" };
    expect(codes(checkRights(bad, { checkers: {} }))).toEqual(["unknown_rights"]);
    expect(codes(checkRights(bad, { checkers: { rights: undefined } }))).toEqual([
      "unknown_rights",
    ]);
  });

  it("is replaced by a checker the caller gives", () => {
    const own = vi.fn(() => [{ code: "house_rule", message: "Ask the registrar." }]);
    const r = checkRights({ uri: "https://example.org/rights" }, { checkers: { rights: own } });
    expect(codes(r)).toEqual(["house_rule"]);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("can be skipped on purpose with a checker that finds nothing", () => {
    const r = checkRights(
      { uri: "https://example.org/rights" },
      { checkers: { rights: () => [] } },
    );
    expect(r).toEqual([]);
  });

  it("fails closed when the caller gives something that isn't a function", () => {
    const r = checkRights(
      { uri: INC },
      { checkers: { rights: null as unknown as FieldValueChecker } },
    );
    expect(codes(r)).toEqual(["check_failed"]);
  });
});

describe("checkRecordAgainstTemplate: identifier values need a checker", () => {
  it("refuses each identifier value when no checker is given", () => {
    const values = [
      { type: "accession", value: "2026.001" },
      { type: "legacy", value: "P-12" },
    ];
    for (const options of [
      undefined,
      {},
      { checkers: {} },
      { checkers: { identifier: undefined } },
    ]) {
      const r = checkNumbers(values, options);
      expect(codes(r)).toEqual(["unchecked", "unchecked"]);
      expect(paths(r)).toEqual(["fields.numbers.0", "fields.numbers.1"]);
    }
  });

  it("reports the structure problem, not unchecked, when the shape is already wrong", () => {
    expect(codes(checkNumbers([{ type: "accession" }]))).toEqual(["invalid_text"]);
  });

  it("doesn't need one when the record has no identifier values", () => {
    expect(checkRecordAgainstTemplate(record({}), NUMBERS)).toEqual([]);
  });

  it("uses the organization's types through makeIdentifierChecker", () => {
    const checkers = { identifier: identifierChecker() };
    expect(
      checkNumbers(
        [
          { type: "accession", value: "2026.001" },
          { type: "legacy", value: "P-12" },
        ],
        { checkers },
      ),
    ).toEqual([]);
    const r = checkNumbers(
      [
        { type: "barcode", value: "0001" },
        { type: "accession", value: "26-1" },
        { type: "legacy", value: "P\u00AD12" },
      ],
      { checkers },
    );
    expect(codes(r)).toEqual(["unknown_type", "format_mismatch", "invisible_characters"]);
    expect(paths(r)).toEqual([
      "fields.numbers.0.type",
      "fields.numbers.1.value",
      "fields.numbers.2.value",
    ]);
  });

  it("checks the field's own allowed types first", () => {
    const t = template([
      field({
        key: "numbers",
        label: "ID numbers",
        kind: "identifier",
        identifierTypes: ["accession"],
      }),
    ]);
    const r = checkRecordAgainstTemplate(
      record({ numbers: { type: "legacy", value: "P-12" } }),
      t,
      {
        checkers: { identifier: identifierChecker() },
      },
    );
    expect(codes(r)).toEqual(["not_allowed"]);
  });
});

describe("a record that passes its template can be published (rights)", () => {
  it("checkRecordAgainstTemplate and rightsPublishIssues agree on { uri, note? }", () => {
    const t = template([field({ key: "rights", label: "Rights", kind: "rights", required: true })]);
    const made = createRecord({
      organizationId: ORG,
      kind: "object",
      title: "Invented lantern",
      fields: { rights: { uri: INC, note: "Rights holder unknown." } },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(checkRecordAgainstTemplate(made.value, t)).toEqual([]);
    expect(rightsPublishIssues(made.value)).toEqual([]);
  });

  it("and both refuse the same non-canonical uri, at the same path", () => {
    const r = record({ rights: { uri: "https://rightsstatements.org/page/InC/1.0/" } });
    const fromTemplate = checkRecordAgainstTemplate(r, RIGHTS);
    const fromPublish = rightsPublishIssues(r);
    expect(codes(fromTemplate)).toEqual(["not_canonical"]);
    expect(codes(fromPublish)).toEqual(["not_canonical"]);
    expect(paths(fromTemplate)).toEqual(paths(fromPublish));
  });
});

describe("identifier type visibility (D-022)", () => {
  const MIXED = [
    {
      key: "object_number",
      label: "Object number",
      organizationId: ORG,
      uniqueness: "current",
      public: true,
    },
    { key: "donor_file", label: "Donor file number", organizationId: ORG, uniqueness: "none" },
    {
      key: "box_label",
      label: "Box label",
      organizationId: ORG,
      uniqueness: "none",
      public: false,
    },
  ];
  const STAFF_NUMBERS = template([
    field({
      key: "numbers",
      label: "Staff numbers",
      kind: "identifier",
      repeatable: true,
      visibility: "staff",
    }),
  ]);

  it("refuses a staff type's value in a public field, at the type", () => {
    const checkers = { identifier: identifierChecker(MIXED) };
    const r = checkNumbers(
      [
        { type: "object_number", value: "2026.015" },
        { type: "donor_file", value: "DF-12" },
        { type: "box_label", value: "Box 4" },
      ],
      { checkers },
    );
    expect(codes(r)).toEqual(["private_identifier_type", "private_identifier_type"]);
    expect(paths(r)).toEqual(["fields.numbers.1.type", "fields.numbers.2.type"]);
    // Neither the staff type's label nor its key: the path says where the
    // key is (S-006a).
    expect(r[0]?.message).not.toContain("Donor file number");
    expect(r[0]?.message).not.toContain("donor_file");
    expect(r[0]?.message).toContain("ID numbers");
  });

  it("accepts any type in a staff field", () => {
    const checkers = { identifier: identifierChecker(MIXED) };
    const r = checkRecordAgainstTemplate(
      record({
        numbers: [
          { type: "object_number", value: "2026.015" },
          { type: "donor_file", value: "DF-12" },
        ],
      }),
      STAFF_NUMBERS,
      { checkers },
    );
    expect(r).toEqual([]);
  });

  it("treats a field that doesn't say staff as public", () => {
    const check = identifierChecker(MIXED);
    expect(codes(check({ type: "donor_file", value: "DF-12" }, anyField, rec))).toEqual([
      "private_identifier_type",
    ]);
    expect(check({ type: "object_number", value: "1" }, anyField, rec)).toEqual([]);
  });

  it("refuses a type marked public other than with true", () => {
    expect(makeIdentifierChecker([{ ...MIXED[1], public: "true" }]).ok).toBe(false);
  });
});
