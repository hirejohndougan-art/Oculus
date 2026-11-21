import { describe, expect, it, vi } from "vitest";
import {
  MAX_REPEATS,
  MAX_TEMPLATE_FIELDS,
  MAX_TEXT_LENGTH,
  checkRecordAgainstTemplate,
  isFieldKey,
  makeIdentifierChecker,
  validateRecord,
  validateTemplate,
  webUrlProblem,
  type CatalogRecord,
  type FieldTemplate,
  type FieldValueChecker,
  type Issue,
  type TemplateCheckOptions,
  type Validated,
} from "./index.js";

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const PLACE_ID = "9b2e4c1a-7d3f-4e8a-b5c6-1a2b3c4d5e6f";
const T = "2026-11-20T16:05:00.000Z";

function codes(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.code);
  const r = result as Validated<unknown>;
  return r.ok ? [] : r.issues.map((i) => i.code);
}

function paths(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.path.join("."));
  const r = result as Validated<unknown>;
  return r.ok ? [] : r.issues.map((i) => i.path.join("."));
}

function field(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "title_note",
    label: "Note",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

/** A template using every field kind. Invented sample data. */
function fullTemplate(): Record<string, unknown> {
  return {
    key: "sample-photo",
    label: "Photograph",
    description: "For single photographs and postcards.",
    appliesTo: ["archival_unit", "object"],
    fields: [
      field({
        key: "caption",
        label: "Caption",
        help: "As written on the item.",
        required: true,
        standards: [
          { standard: "dcterms", element: "title", uri: "http://purl.org/dc/terms/title" },
        ],
      }),
      field({ key: "description", label: "Description", kind: "long_text", maxLength: 5000 }),
      field({ key: "date", label: "Date", kind: "date", required: true, inherited: true }),
      field({
        key: "format",
        label: "Format",
        kind: "list",
        repeatable: true,
        options: [
          { value: "print", label: "Print" },
          { value: "negative", label: "Negative" },
        ],
      }),
      field({
        key: "subjects",
        label: "Subjects",
        kind: "controlled_term",
        repeatable: true,
        vocabularies: ["lcsh", "local"],
      }),
      field({
        key: "numbers",
        label: "ID numbers",
        kind: "identifier",
        repeatable: true,
        identifierTypes: ["accession", "legacy"],
        visibility: "staff",
      }),
      field({ key: "see_also", label: "See also", kind: "link" }),
      field({ key: "rights", label: "Rights", kind: "rights", inherited: true }),
      field({ key: "place", label: "Place", kind: "place", repeatable: true }),
    ],
  };
}

function template(input: unknown = fullTemplate()): FieldTemplate {
  const r = validateTemplate(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function record(fields: Record<string, unknown>, kind = "object"): CatalogRecord {
  const r = validateRecord({
    kind,
    id: ID,
    title: "Dickinson Station and Park",
    createdAt: T,
    updatedAt: T,
    fields,
    ...(kind === "archival_unit" ? { level: "item" } : {}),
    ...(kind === "agent" ? { agentType: "person" } : {}),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function goodFields(): Record<string, unknown> {
  return {
    caption: "Passengers waiting at the depot",
    description: "Several people on the platform.\n\nA train is arriving.",
    date: "1909~",
    format: ["print"],
    subjects: [
      {
        label: "Railroad stations",
        uri: "http://id.loc.gov/authorities/subjects/sh85111042",
        vocabulary: "lcsh",
      },
      { label: "Depot Park", vocabulary: "local" },
    ],
    numbers: [{ type: "accession", value: "2026.012.003" }],
    see_also: { url: "https://example.org/depot", label: "Depot history" },
    rights: { uri: "http://rightsstatements.org/vocab/CNE/1.0/", note: "Not yet evaluated." },
    place: [{ label: "Dickinson, Texas", recordId: PLACE_ID }],
  };
}

/** The sample organization's identifier types. Invented. */
const IDENTIFIER_TYPES = [
  { key: "accession", label: "Accession number", uniqueness: "all_time" },
  { key: "legacy", label: "Legacy number", uniqueness: "none" },
];

function identifierChecker(): FieldValueChecker {
  const made = makeIdentifierChecker(IDENTIFIER_TYPES);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  return made.value;
}

/**
 * Checks against the full template. The identifier kind has no default
 * checker (D-015), so the sample organization's one is passed unless the
 * test passes its own.
 */
function check(fields: Record<string, unknown>, options: TemplateCheckOptions = {}): Issue[] {
  return checkRecordAgainstTemplate(record(fields), template(), {
    ...options,
    checkers: { identifier: identifierChecker(), ...options.checkers },
  });
}

function without(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(goodFields()).filter(([k]) => k !== key));
}

// ---------------------------------------------------------------------------

describe("validateTemplate: good templates", () => {
  it("accepts a template using every field kind", () => {
    expect(validateTemplate(fullTemplate()).ok).toBe(true);
  });

  it("returns a deeply frozen copy, not the caller's object", () => {
    const input = fullTemplate();
    const r = validateTemplate(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toBe(input);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.fields)).toBe(true);
    expect(Object.isFrozen(r.value.fields[0])).toBe(true);
    (input.fields as Record<string, unknown>[]).push(field({ key: "late" }));
    expect(r.value.fields.map((f) => f.key)).not.toContain("late");
  });

  it("keeps every property a later task needs", () => {
    const t = template();
    const caption = t.fields[0];
    expect(caption).toEqual({
      key: "caption",
      label: "Caption",
      help: "As written on the item.",
      kind: "text",
      required: true,
      repeatable: false,
      visibility: "public",
      inherited: false,
      standards: [{ standard: "dcterms", element: "title", uri: "http://purl.org/dc/terms/title" }],
    });
  });
});

describe("validateTemplate: the template itself", () => {
  it("rejects anything but a plain object", () => {
    for (const bad of [null, [], "x", 1, new Map()]) {
      expect(codes(validateTemplate(bad))).toEqual(["not_an_object"]);
    }
  });

  it("rejects unknown properties", () => {
    const r = validateTemplate({ ...fullTemplate(), extra: 1 });
    expect(codes(r)).toEqual(["unknown_property"]);
    expect(paths(r)).toEqual(["extra"]);
  });

  it("rejects a bad key", () => {
    for (const key of ["", "Photo", "1photo", "photo set", "a".repeat(65), 3]) {
      expect(codes(validateTemplate({ ...fullTemplate(), key }))).toEqual(["invalid_key"]);
    }
  });

  it("rejects bad labels", () => {
    for (const label of ["", "  ", " Photo", "Photo\nset", "x".repeat(201), 3, undefined]) {
      const input = fullTemplate();
      if (label === undefined) delete input.label;
      else input.label = label;
      expect(codes(validateTemplate(input))).toEqual(["invalid_label"]);
    }
  });

  it("rejects a blank or over-long description", () => {
    expect(codes(validateTemplate({ ...fullTemplate(), description: " " }))).toEqual([
      "invalid_text",
    ]);
    expect(codes(validateTemplate({ ...fullTemplate(), description: "x".repeat(2001) }))).toEqual([
      "too_long",
    ]);
  });

  it("needs appliesTo to list known record kinds once each", () => {
    expect(codes(validateTemplate({ ...fullTemplate(), appliesTo: [] }))).toEqual(["required"]);
    expect(codes(validateTemplate({ ...fullTemplate(), appliesTo: "object" }))).toEqual([
      "required",
    ]);
    expect(codes(validateTemplate({ ...fullTemplate(), appliesTo: ["photo"] }))).toEqual([
      "invalid_kind",
    ]);
    expect(codes(validateTemplate({ ...fullTemplate(), appliesTo: ["object", "object"] }))).toEqual(
      ["duplicate"],
    );
  });

  it("needs one to MAX_TEMPLATE_FIELDS fields", () => {
    expect(codes(validateTemplate({ ...fullTemplate(), fields: [] }))).toEqual(["required"]);
    const many = Array.from({ length: MAX_TEMPLATE_FIELDS + 1 }, (_, i) =>
      field({ key: `f${String(i)}` }),
    );
    expect(codes(validateTemplate({ ...fullTemplate(), fields: many }))).toEqual(["too_many"]);
    const max = many.slice(0, MAX_TEMPLATE_FIELDS);
    expect(validateTemplate({ ...fullTemplate(), fields: max }).ok).toBe(true);
  });

  it("rejects two fields with the same key", () => {
    const r = validateTemplate({ ...fullTemplate(), fields: [field(), field({ label: "Other" })] });
    expect(codes(r)).toEqual(["duplicate_key"]);
    expect(paths(r)).toEqual(["fields.1.key"]);
  });
});

describe("validateTemplate: field definitions", () => {
  function fieldCodes(f: Record<string, unknown>): string[] {
    return codes(validateTemplate({ ...fullTemplate(), fields: [f] }));
  }

  it("rejects a field that isn't an object", () => {
    expect(codes(validateTemplate({ ...fullTemplate(), fields: ["caption"] }))).toEqual([
      "not_an_object",
    ]);
  });

  it("rejects unknown properties on a field", () => {
    expect(fieldCodes(field({ public: true }))).toEqual(["unknown_property"]);
  });

  it("uses the same key rule as record fields, and refuses prototype keys", () => {
    for (const key of ["", "Caption", "_x", "a-b", "a".repeat(65), "constructor", "prototype"]) {
      expect(fieldCodes(field({ key }))).toEqual(["invalid_field_key"]);
    }
    expect(isFieldKey("constructor")).toBe(false);
    expect(isFieldKey("a".repeat(64))).toBe(true);
  });

  it("accepts every key it allows in a record's fields", () => {
    const key = "a".repeat(64);
    const t = template({ ...fullTemplate(), fields: [field({ key })] });
    expect(checkRecordAgainstTemplate(record({ [key]: "x" }), t)).toEqual([]);
  });

  it("needs required, repeatable and inherited as true or false", () => {
    for (const flag of ["required", "repeatable", "inherited"]) {
      const f = Object.fromEntries(Object.entries(field()).filter(([k]) => k !== flag));
      expect(fieldCodes(f)).toEqual(["required"]);
      expect(fieldCodes(field({ [flag]: "yes" }))).toEqual(["required"]);
    }
  });

  it("has no default visibility: leaving it out is an error, not public", () => {
    const f = field();
    delete f.visibility;
    expect(fieldCodes(f)).toEqual(["invalid_visibility"]);
    expect(fieldCodes(field({ visibility: "private" }))).toEqual(["invalid_visibility"]);
    expect(fieldCodes(field({ visibility: "staff" }))).toEqual([]);
  });

  it("rejects an unknown kind", () => {
    expect(fieldCodes(field({ kind: "number" }))).toEqual(["invalid_kind"]);
  });

  it("allows kind-specific properties only on their kinds", () => {
    expect(fieldCodes(field({ options: [{ value: "a", label: "A" }] }))).toEqual(["not_for_kind"]);
    expect(fieldCodes(field({ vocabularies: ["lcsh"] }))).toEqual(["not_for_kind"]);
    expect(fieldCodes(field({ identifierTypes: ["accession"] }))).toEqual(["not_for_kind"]);
    expect(fieldCodes(field({ kind: "date", maxLength: 10 }))).toEqual(["not_for_kind"]);
  });

  it("checks maxLength", () => {
    expect(fieldCodes(field({ maxLength: 0 }))).toEqual(["invalid_number"]);
    expect(fieldCodes(field({ maxLength: 1.5 }))).toEqual(["invalid_number"]);
    expect(fieldCodes(field({ maxLength: "10" }))).toEqual(["invalid_number"]);
    expect(fieldCodes(field({ maxLength: MAX_TEXT_LENGTH + 1 }))).toEqual(["too_large"]);
    expect(fieldCodes(field({ maxLength: MAX_TEXT_LENGTH }))).toEqual([]);
    expect(fieldCodes(field({ kind: "long_text", maxLength: 100_001 }))).toEqual(["too_large"]);
  });

  it("needs options on a list field, each { value, label }, values unique", () => {
    const list = (options: unknown): string[] => fieldCodes(field({ kind: "list", options }));
    expect(fieldCodes(field({ kind: "list" }))).toEqual(["required"]);
    expect(list([])).toEqual(["required"]);
    expect(list(["print"])).toEqual(["not_an_object"]);
    expect(list([{ value: "print" }])).toEqual(["invalid_label"]);
    expect(list([{ value: " print", label: "Print" }])).toEqual(["invalid_option"]);
    expect(list([{ value: "print", label: "Print", extra: 1 }])).toEqual(["unknown_property"]);
    expect(
      list([
        { value: "print", label: "Print" },
        { value: "print", label: "Print again" },
      ]),
    ).toEqual(["duplicate"]);
    expect(
      list(Array.from({ length: 501 }, (_, i) => ({ value: `v${String(i)}`, label: "L" }))),
    ).toEqual(["too_many"]);
  });

  it("checks vocabulary and identifier type codes", () => {
    const vocab = (vocabularies: unknown): string[] =>
      fieldCodes(field({ kind: "controlled_term", vocabularies }));
    expect(vocab([])).toEqual(["invalid_list"]);
    expect(vocab("lcsh")).toEqual(["invalid_list"]);
    expect(vocab(["LCSH"])).toEqual(["invalid_code"]);
    expect(vocab(["lcsh", "lcsh"])).toEqual(["duplicate"]);
    expect(fieldCodes(field({ kind: "identifier", identifierTypes: ["call number"] }))).toEqual([
      "invalid_code",
    ]);
  });

  it("checks standards mappings", () => {
    const std = (standards: unknown): string[] => fieldCodes(field({ standards }));
    expect(std([])).toEqual(["invalid_list"]);
    expect(std([{ standard: "DACS", element: "2.4" }])).toEqual(["invalid_code"]);
    expect(std([{ standard: "dacs", element: "" }])).toEqual(["invalid_element"]);
    expect(std([{ standard: "dacs", element: "2.4", uri: "javascript:alert(1)" }])).toEqual([
      "invalid_url",
    ]);
    expect(std([{ standard: "dacs", element: "2.4", note: "x" }])).toEqual(["unknown_property"]);
    expect(std(["dacs"])).toEqual(["not_an_object"]);
    expect(
      std([
        { standard: "dacs", element: "2.4" },
        { standard: "dacs", element: "2.4" },
      ]),
    ).toEqual(["duplicate"]);
    expect(
      std([
        { standard: "dacs", element: "2.4" },
        { standard: "dcterms", element: "date" },
      ]),
    ).toEqual([]);
  });

  it("reports every problem at once, with paths", () => {
    const r = validateTemplate({
      key: "Bad Key",
      label: "",
      appliesTo: ["thing"],
      fields: [field({ kind: "number", visibility: "everyone" })],
    });
    expect(paths(r).sort()).toEqual(
      ["appliesTo.0", "fields.0.kind", "fields.0.visibility", "key", "label"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------

describe("checkRecordAgainstTemplate: the record as a whole", () => {
  it("accepts a record that fills every kind correctly", () => {
    expect(check(goodFields())).toEqual([]);
  });

  it("accepts a record with only the required fields", () => {
    expect(check({ caption: "Depot", date: "1909" })).toEqual([]);
  });

  it("rejects a record kind the template is not for", () => {
    const r = checkRecordAgainstTemplate(record(goodFields(), "agent"), template());
    expect(codes(r)).toEqual(["wrong_template"]);
  });

  it("accepts each kind the template lists", () => {
    const checkers = { identifier: identifierChecker() };
    expect(
      checkRecordAgainstTemplate(record(goodFields(), "archival_unit"), template(), { checkers }),
    ).toEqual([]);
  });

  it("reports fields the template doesn't have", () => {
    const r = check({ ...goodFields(), donor_name: "x" });
    expect(codes(r)).toEqual(["unknown_field"]);
    expect(paths(r)).toEqual(["fields.donor_name"]);
  });

  it("reports missing required fields", () => {
    const r = check(without("caption"));
    expect(codes(r)).toEqual(["required"]);
    expect(paths(r)).toEqual(["fields.caption"]);
  });

  it("allowMissingInherited lets only inherited required fields be missing", () => {
    expect(codes(check(without("date")))).toEqual(["required"]);
    expect(check(without("date"), { allowMissingInherited: true })).toEqual([]);
    expect(codes(check(without("caption"), { allowMissingInherited: true }))).toEqual(["required"]);
  });

  it("rejects null instead of leaving the field out", () => {
    expect(codes(check({ ...goodFields(), see_also: null }))).toEqual(["empty_value"]);
  });

  it("reports every problem at once", () => {
    const r = check({ caption: "", date: "sometime", extra: 1 });
    expect(codes(r).sort()).toEqual(["invalid_date", "invalid_text", "unknown_field"]);
  });
});

describe("checkRecordAgainstTemplate: repeatable fields", () => {
  it("needs a list for a repeatable field and one value otherwise", () => {
    expect(codes(check({ ...goodFields(), format: "print" }))).toEqual(["not_a_list"]);
    expect(codes(check({ ...goodFields(), caption: ["Depot"] }))).toEqual(["not_repeatable"]);
  });

  it("rejects an empty list", () => {
    expect(codes(check({ ...goodFields(), format: [] }))).toEqual(["empty_value"]);
  });

  it("checks each value, with its index in the path", () => {
    const r = check({ ...goodFields(), format: ["print", "slide"] });
    expect(codes(r)).toEqual(["not_an_option"]);
    expect(paths(r)).toEqual(["fields.format.1"]);
  });

  it("rejects null and nested lists inside the list", () => {
    expect(codes(check({ ...goodFields(), format: ["print", null] }))).toEqual(["invalid_value"]);
    expect(codes(check({ ...goodFields(), format: [["print"]] }))).toEqual(["invalid_value"]);
  });

  it("rejects exact repeats", () => {
    expect(codes(check({ ...goodFields(), format: ["print", "print"] }))).toEqual(["duplicate"]);
  });

  it(`allows at most MAX_REPEATS values`, () => {
    const t = template({
      ...fullTemplate(),
      fields: [field({ key: "notes", repeatable: true })],
    });
    const many = Array.from({ length: MAX_REPEATS + 1 }, (_, i) => `n${String(i)}`);
    expect(codes(checkRecordAgainstTemplate(record({ notes: many }), t))).toEqual(["too_many"]);
    expect(checkRecordAgainstTemplate(record({ notes: many.slice(1) }), t)).toEqual([]);
  });
});

describe("checkRecordAgainstTemplate: each kind", () => {
  it("text: one trimmed line, within maxLength", () => {
    for (const caption of ["", "  ", " Depot", "Depot\nPark", "Depot\tPark", 5, { a: 1 }]) {
      expect(codes(check({ ...goodFields(), caption }))).toEqual(["invalid_text"]);
    }
    const t = template({ ...fullTemplate(), fields: [field({ key: "code", maxLength: 3 })] });
    expect(codes(checkRecordAgainstTemplate(record({ code: "abcd" }), t))).toEqual([
      "invalid_text",
    ]);
    expect(checkRecordAgainstTemplate(record({ code: "abc" }), t)).toEqual([]);
    expect(codes(check({ ...goodFields(), caption: "x".repeat(MAX_TEXT_LENGTH + 1) }))).toEqual([
      "invalid_text",
    ]);
  });

  it("long_text: several lines allowed, not blank, within maxLength", () => {
    expect(codes(check({ ...goodFields(), description: " \n " }))).toEqual(["empty_value"]);
    expect(codes(check({ ...goodFields(), description: 3 }))).toEqual(["not_text"]);
    expect(codes(check({ ...goodFields(), description: "x".repeat(5001) }))).toEqual(["too_long"]);
  });

  it("date: must parse as EDTF, and the message says why", () => {
    for (const date of ["1909", "1909~", "195X", "1909/1912", "[1667,1668]"]) {
      expect(check({ ...goodFields(), date })).toEqual([]);
    }
    const r = check({ ...goodFields(), date: "about 1909" });
    expect(codes(r)).toEqual(["invalid_date"]);
    expect(r[0]?.message).toMatch(/EDTF/);
    expect(codes(check({ ...goodFields(), date: 1909 }))).toEqual(["invalid_date"]);
    expect(codes(check({ ...goodFields(), date: "1909-02-30" }))).toEqual(["invalid_date"]);
  });

  it("list: must be one of the options' values, not a label", () => {
    expect(codes(check({ ...goodFields(), format: ["Print"] }))).toEqual(["not_an_option"]);
    expect(codes(check({ ...goodFields(), format: [1] }))).toEqual(["not_an_option"]);
  });

  it("controlled_term: { label, uri?, vocabulary? } from an allowed vocabulary", () => {
    const term = (t: unknown): string[] => codes(check({ ...goodFields(), subjects: [t] }));
    expect(term({ label: "Depots", vocabulary: "local" })).toEqual([]);
    expect(term("Depots")).toEqual(["not_an_object"]);
    expect(term({ vocabulary: "local" })).toEqual(["invalid_text"]);
    expect(term({ label: "Depots", vocabulary: "aat" })).toEqual(["not_allowed"]);
    expect(term({ label: "Depots" })).toEqual(["required"]);
    expect(term({ label: "Depots", vocabulary: "local", uri: "id.loc.gov/x" })).toEqual([
      "invalid_url",
    ]);
    expect(term({ label: "Depots", vocabulary: "local", broader: "x" })).toEqual([
      "unknown_property",
    ]);
  });

  it("controlled_term: any vocabulary code when the field doesn't restrict them", () => {
    const t = template({
      ...fullTemplate(),
      fields: [field({ key: "genre", kind: "controlled_term" })],
    });
    expect(checkRecordAgainstTemplate(record({ genre: { label: "Postcards" } }), t)).toEqual([]);
    expect(
      checkRecordAgainstTemplate(record({ genre: { label: "Postcards", vocabulary: "lcgft" } }), t),
    ).toEqual([]);
    expect(
      codes(
        checkRecordAgainstTemplate(
          record({ genre: { label: "Postcards", vocabulary: "LC GFT" } }),
          t,
        ),
      ),
    ).toEqual(["invalid_code"]);
  });

  it("identifier: { type, value } with an allowed type", () => {
    const id = (v: unknown): string[] => codes(check({ ...goodFields(), numbers: [v] }));
    expect(id({ type: "legacy", value: "P-12" })).toEqual([]);
    expect(id({ type: "barcode", value: "P-12" })).toEqual(["not_allowed"]);
    expect(id({ type: "legacy", value: "" })).toEqual(["invalid_text"]);
    expect(id({ type: "legacy", value: " P-12" })).toEqual(["invalid_text"]);
    expect(id({ value: "P-12" })).toEqual(["required"]);
    expect(id("P-12")).toEqual(["not_an_object"]);
  });

  it("link: { url, label? } with an http or https url", () => {
    const link = (v: unknown): string[] => codes(check({ ...goodFields(), see_also: v }));
    expect(link({ url: "http://example.org/" })).toEqual([]);
    expect(link({ label: "Depot" })).toEqual(["required"]);
    expect(link({ url: "javascript:alert(1)" })).toEqual(["invalid_url"]);
    expect(link({ url: "https://user:pw@example.org/" })).toEqual(["invalid_url"]);
    expect(link({ url: "https://example.org", label: "" })).toEqual(["invalid_text"]);
    expect(link("https://example.org")).toEqual(["not_an_object"]);
  });

  it("rights: { uri, note? }", () => {
    const rights = (v: unknown): string[] => codes(check({ ...goodFields(), rights: v }));
    expect(rights({ uri: "https://creativecommons.org/licenses/by/4.0/" })).toEqual([]);
    expect(rights({ note: "Ask first" })).toEqual(["required"]);
    expect(rights({ uri: "InC" })).toEqual(["invalid_url"]);
    expect(rights({ uri: "http://rightsstatements.org/vocab/InC/1.0/", note: " " })).toEqual([
      "invalid_text",
    ]);
  });

  it("place: { label, uri?, recordId? }", () => {
    const place = (v: unknown): string[] => codes(check({ ...goodFields(), place: [v] }));
    expect(place({ label: "Dickinson Bayou" })).toEqual([]);
    expect(
      place({ label: "Dickinson", uri: "https://example.org/gnis/1", recordId: PLACE_ID }),
    ).toEqual([]);
    expect(place({ label: "Dickinson", recordId: "123" })).toEqual(["invalid_id"]);
    expect(place({ recordId: PLACE_ID })).toEqual(["invalid_text"]);
  });
});

describe("validateTemplate: the rights field", () => {
  const fieldCodes = (...fields: Record<string, unknown>[]): string[] =>
    codes(validateTemplate({ ...fullTemplate(), fields }));
  const rights = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    field({ key: "rights", label: "Rights", kind: "rights", ...extra });

  it("accepts one public, single rights field under the key rights", () => {
    expect(fieldCodes(rights())).toEqual([]);
    expect(fieldCodes(rights({ required: true, inherited: true }))).toEqual([]);
  });

  it("refuses the rights kind under any other key", () => {
    const r = validateTemplate({ ...fullTemplate(), fields: [rights({ key: "license" })] });
    expect(codes(r)).toEqual(["rights_kind_key"]);
    expect(paths(r)).toEqual(["fields.0.key"]);
  });

  it("refuses the key rights with any other kind", () => {
    for (const kind of ["text", "controlled_term", "place", "long_text", "link"]) {
      const r = validateTemplate({ ...fullTemplate(), fields: [rights({ kind })] });
      expect(codes(r)).toEqual(["rights_key_kind"]);
      expect(paths(r)).toEqual(["fields.0.kind"]);
    }
  });

  it("refuses two rights fields", () => {
    expect(fieldCodes(rights(), rights({ key: "rights_2" }))).toEqual(["rights_kind_key"]);
    expect(fieldCodes(rights(), rights())).toEqual(["duplicate_key"]);
  });

  it("refuses a repeatable rights field (one value per record)", () => {
    const r = validateTemplate({ ...fullTemplate(), fields: [rights({ repeatable: true })] });
    expect(codes(r)).toEqual(["rights_repeatable"]);
    expect(paths(r)).toEqual(["fields.0.repeatable"]);
  });

  it("refuses a staff-only rights field, because the note is published", () => {
    const r = validateTemplate({ ...fullTemplate(), fields: [rights({ visibility: "staff" })] });
    expect(codes(r)).toEqual(["rights_not_public"]);
    expect(paths(r)).toEqual(["fields.0.visibility"]);
  });

  it("makes a template with a hand-built rights field fail closed in checkRecordAgainstTemplate", () => {
    const bad = { ...fullTemplate(), fields: [rights({ visibility: "staff" })] } as unknown;
    const issues = checkRecordAgainstTemplate(
      record({ rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } }),
      bad as FieldTemplate,
    );
    expect(codes(issues)).toEqual(["invalid_template"]);
  });
});

describe("checkRecordAgainstTemplate: plugged-in checkers", () => {
  it("runs a checker after the structure check and adds its problems with paths", () => {
    const rights = vi.fn(() => [
      { code: "unknown_statement", message: "Not a known statement.", path: ["uri"] },
    ]);
    const r = check(goodFields(), { checkers: { rights } });
    expect(codes(r)).toEqual(["unknown_statement"]);
    expect(paths(r)).toEqual(["fields.rights.uri"]);
    expect(rights).toHaveBeenCalledTimes(1);
    const [value, f, rec] = rights.mock.calls[0] as unknown as [unknown, { key: string }, unknown];
    expect(value).toEqual(goodFields().rights);
    expect(f.key).toBe("rights");
    expect((rec as CatalogRecord).id).toBe(ID);
  });

  it("calls it once per value of a repeatable field", () => {
    const identifier = vi.fn(() => []);
    const fields = {
      ...goodFields(),
      numbers: [
        { type: "accession", value: "1" },
        { type: "legacy", value: "2" },
      ],
    };
    expect(check(fields, { checkers: { identifier } })).toEqual([]);
    expect(identifier).toHaveBeenCalledTimes(2);
  });

  it("doesn't call it when the structure is already wrong", () => {
    const rights = vi.fn(() => []);
    expect(
      codes(check({ ...goodFields(), rights: { uri: "x" } }, { checkers: { rights } })),
    ).toEqual(["invalid_url"]);
    expect(rights).not.toHaveBeenCalled();
  });

  it("fails closed when a checker throws or returns something odd", () => {
    const bad: unknown[] = [
      () => {
        throw new Error("boom");
      },
      () => undefined,
      () => [{ code: 1, message: "x" }],
      () => [null],
      () => [{ code: "x", message: "y", path: "uri" }],
    ];
    for (const checker of bad) {
      const r = check(goodFields(), {
        checkers: { place: checker as () => [] },
      });
      expect(codes(r)).toEqual(["check_failed"]);
    }
  });
});

describe("webUrlProblem", () => {
  it("accepts http and https addresses", () => {
    for (const url of [
      "http://rightsstatements.org/vocab/InC/1.0/",
      "https://creativecommons.org/licenses/by/4.0/",
      "https://example.org/a?b=c#d",
    ]) {
      expect(webUrlProblem(url)).toBeUndefined();
    }
  });

  it("rejects other schemes, spaces, credentials and over-long addresses", () => {
    for (const url of [
      "",
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://example.org/",
      "HTTPS://example.org/",
      "https://",
      "https:///path",
      "//example.org",
      "https://exa mple.org/",
      "https://example.org/ x",
      "https://user@example.org/",
      "https://:pw@example.org/",
      `https://example.org/${"a".repeat(2000)}`,
      "https://[::1",
    ]) {
      expect(webUrlProblem(url), url).toBeDefined();
    }
  });
});
