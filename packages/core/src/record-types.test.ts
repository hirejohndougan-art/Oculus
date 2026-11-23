// T-013: organization-defined record types built on the six kinds (D-037).
import { describe, expect, it } from "vitest";
import {
  MAX_RECORD_TYPES,
  DIGITAL_ASSET_PRESET,
  checkRecordType,
  createRecord,
  indexRecordTypes,
  indexTemplates,
  isRecordTypeKey,
  isRecordTypeRegistry,
  newOrganizationId,
  recordTypeDefaults,
  templateFromPreset,
  validateRecord,
  validateRecordType,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type RecordType,
  type RecordTypeRegistry,
  type TemplateRegistry,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";

function codes(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.code);
  const v = result as Validated<unknown>;
  return v.ok ? [] : v.issues.map((i) => i.code);
}

function template(key = "oral-history", appliesTo: string[] = ["digital_asset"]): FieldTemplate {
  return {
    key,
    label: "Oral histories",
    organizationId: ORG,
    appliesTo,
    fields: [
      {
        key: "interviewer",
        label: "Interviewer",
        kind: "text",
        required: false,
        repeatable: false,
        visibility: "staff",
        inherited: false,
      },
    ],
  } as unknown as FieldTemplate;
}

function templates(...list: FieldTemplate[]): TemplateRegistry {
  const r = indexTemplates(list.length > 0 ? list : [template()]);
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

function oralHistory(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "oral-history",
    organizationId: ORG,
    label: "Oral history",
    kind: "digital_asset",
    defaultTemplateKey: "oral-history",
    ...extra,
  };
}

function types(list: unknown[] = [oralHistory()], tr = templates()): RecordTypeRegistry {
  const r = indexRecordTypes(list, tr);
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

function record(extra: Record<string, unknown> = {}): CatalogRecord {
  const r = validateRecord({
    kind: "digital_asset",
    id: A,
    title: "Interview with a ferry pilot",
    organizationId: ORG,
    templateKey: "oral-history",
    recordTypeKey: "oral-history",
    mediaType: "audio/wav",
    createdAt: T,
    updatedAt: T,
    fields: {},
    ...extra,
  });
  if (!r.ok) throw new Error(`bad fixture: ${JSON.stringify(r.issues)}`);
  return r.value;
}

describe("validateRecordType", () => {
  it("accepts a type built on a kind, with its default template, as a frozen copy", () => {
    const input = oralHistory({ description: "Recorded interviews." });
    const r = validateRecordType(input, templates());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(input);
    expect(r.value).not.toBe(input);
    expect(Object.isFrozen(r.value)).toBe(true);
    input.label = "Changed";
    expect(r.value.label).toBe("Oral history");
  });

  it("checks the default template given directly, too", () => {
    expect(validateRecordType(oralHistory(), template()).ok).toBe(true);
    expect(codes(validateRecordType(oralHistory(), template("photos")))).toEqual([
      "template_mismatch",
    ]);
    expect(codes(validateRecordType(oralHistory(), { key: "x" } as never))).toEqual([
      "invalid_template",
    ]);
  });

  it("refuses a default template that doesn't apply to the type's kind", () => {
    const tr = templates(template("oral-history", ["object"]));
    expect(codes(validateRecordType(oralHistory(), tr))).toEqual(["template_wrong_kind"]);
  });

  it("refuses a default template the registry doesn't have", () => {
    const r = validateRecordType(oralHistory({ defaultTemplateKey: "letters" }), templates());
    expect(codes(r)).toEqual(["unknown_template"]);
  });

  it("works with a template made from a preset", () => {
    const made = templateFromPreset(DIGITAL_ASSET_PRESET, ORG);
    if (!made.ok) throw new Error("bad fixture");
    const tr = templates(made.value);
    const r = validateRecordType(oralHistory({ defaultTemplateKey: DIGITAL_ASSET_PRESET.key }), tr);
    expect(r.ok).toBe(true);
  });

  it("reports every shape problem", () => {
    const r = validateRecordType(
      {
        key: "Oral History",
        organizationId: "not-an-org",
        label: " Oral history",
        description: "  ",
        kind: "recording",
        defaultTemplateKey: "-x",
        extra: 1,
      },
      templates(),
    );
    expect(codes(r).sort()).toEqual(
      [
        "unknown_property",
        "invalid_key",
        "invalid_organization",
        "invalid_label",
        "invalid_text",
        "invalid_kind",
        "invalid_template_key",
      ].sort(),
    );
  });

  it("requires the organization, label, kind and default template", () => {
    const r = validateRecordType({ key: "oral-history" }, templates());
    expect(codes(r).sort()).toEqual(
      ["invalid_organization", "invalid_label", "invalid_kind", "invalid_template_key"].sort(),
    );
  });

  it("refuses labels on several lines and over-long text", () => {
    expect(codes(validateRecordType(oralHistory({ label: "Oral\nhistory" }), templates()))).toEqual(
      ["invalid_label"],
    );
    expect(codes(validateRecordType(oralHistory({ label: "x".repeat(201) }), templates()))).toEqual(
      ["invalid_label"],
    );
    expect(
      codes(validateRecordType(oralHistory({ description: "x".repeat(2001) }), templates())),
    ).toContain("too_long");
  });

  it("uses the template key rule for its key", () => {
    expect(isRecordTypeKey("oral-history")).toBe(true);
    expect(isRecordTypeKey("oral_history2")).toBe(true);
    for (const bad of ["", "Oral", "1a", "a b", "constructor", "prototype", "__proto__", 3]) {
      expect(isRecordTypeKey(bad)).toBe(false);
    }
    expect(isRecordTypeKey("a".repeat(64))).toBe(true);
    expect(isRecordTypeKey("a".repeat(65))).toBe(false);
  });
});

describe("records name their type", () => {
  it("validates a record with a recordTypeKey and templateKey", () => {
    expect(record().recordTypeKey).toBe("oral-history");
  });

  it("refuses a record type key without a template key", () => {
    const r = validateRecord({
      kind: "digital_asset",
      id: A,
      title: "Interview",
      organizationId: ORG,
      recordTypeKey: "oral-history",
      mediaType: "audio/wav",
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    expect(codes(r)).toEqual(["template_key_required"]);
  });

  it("refuses an invalid record type key", () => {
    for (const bad of ["Oral", "constructor", "", 5, null]) {
      const r = validateRecord({
        kind: "object",
        id: A,
        title: "Chair",
        organizationId: ORG,
        templateKey: "t",
        recordTypeKey: bad,
        createdAt: T,
        updatedAt: T,
        fields: {},
      });
      expect(codes(r)).toContain("invalid_record_type_key");
    }
  });

  it("records without a type still validate", () => {
    const r = validateRecord({
      kind: "object",
      id: A,
      title: "Chair",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    expect(r.ok).toBe(true);
  });
});

describe("indexRecordTypes and recordTypeDefaults", () => {
  it("indexes an organization's types by key", () => {
    const tr = templates(template(), template("photos", ["object"]));
    const reg = indexRecordTypes(
      [
        oralHistory(),
        {
          key: "photograph",
          organizationId: ORG,
          label: "Photograph",
          kind: "object",
          defaultTemplateKey: "photos",
        },
      ],
      tr,
    );
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    expect(reg.value.size).toBe(2);
    expect(isRecordTypeRegistry(reg.value)).toBe(true);
    expect(isRecordTypeRegistry({ size: 2 })).toBe(false);
    expect(Object.isFrozen(reg.value)).toBe(true);
  });

  it("accepts an empty list", () => {
    const reg = indexRecordTypes([], templates());
    expect(reg.ok && reg.value.size).toBe(0);
  });

  it("refuses two types with one key, and any invalid type", () => {
    expect(codes(indexRecordTypes([oralHistory(), oralHistory()], templates()))).toEqual([
      "duplicate_key",
    ]);
    const bad = indexRecordTypes(
      [oralHistory(), oralHistory({ key: "x", kind: "place" })],
      templates(),
    );
    expect(codes(bad)).toEqual(["template_wrong_kind"]);
    if (!bad.ok) expect(bad.issues[0]?.path).toEqual([1, "defaultTemplateKey"]);
  });

  it("needs a template registry, not a bare list or template", () => {
    expect(codes(indexRecordTypes([oralHistory()], [template()] as never))).toEqual([
      "no_template_registry",
    ]);
    expect(codes(indexRecordTypes([oralHistory()], template() as never))).toEqual([
      "no_template_registry",
    ]);
  });

  it("refuses too many types and non-lists", () => {
    const many = Array.from({ length: MAX_RECORD_TYPES + 1 }, () => oralHistory());
    expect(codes(indexRecordTypes(many, templates()))).toEqual(["too_many"]);
    expect(codes(indexRecordTypes({ 0: oralHistory(), length: 1 }, templates()))).toEqual([
      "not_a_list",
    ]);
  });

  it("gives what a new record of a type starts with", () => {
    const d = recordTypeDefaults(types(), "oral-history");
    expect(d).toEqual({
      ok: true,
      value: {
        organizationId: ORG,
        kind: "digital_asset",
        recordTypeKey: "oral-history",
        templateKey: "oral-history",
      },
    });
    if (!d.ok) return;
    expect(Object.isFrozen(d.value)).toBe(true);
    const made = createRecord(
      { ...d.value, kind: "digital_asset", title: "Interview", mediaType: "audio/wav" },
      new Date(T),
    );
    expect(made.ok).toBe(true);
    if (made.ok) expect(checkRecordType(made.value, types())).toEqual([]);
  });

  it("refuses an unknown key, a bad key and a registry it didn't make", () => {
    expect(codes(recordTypeDefaults(types(), "letters"))).toEqual(["unknown_record_type"]);
    expect(codes(recordTypeDefaults(types(), "constructor"))).toEqual(["invalid_record_type_key"]);
    expect(codes(recordTypeDefaults({ size: 1 } as never, "oral-history"))).toEqual([
      "no_record_type_registry",
    ]);
  });
});

describe("checkRecordType", () => {
  it("passes a record of its type, through a registry or the type itself", () => {
    expect(checkRecordType(record(), types())).toEqual([]);
    expect(checkRecordType(record(), oralHistory() as unknown as RecordType)).toEqual([]);
  });

  it("does not tie the record's template to the type's default", () => {
    // A record can move to another template of its kind and keep its type.
    expect(checkRecordType(record({ templateKey: "dublin-core-digital-asset" }), types())).toEqual(
      [],
    );
  });

  it("refuses a record of another kind than its type", () => {
    const photo = validateRecord({
      kind: "object",
      id: A,
      title: "Photo",
      organizationId: ORG,
      templateKey: "photos",
      recordTypeKey: "oral-history",
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    if (!photo.ok) throw new Error("bad fixture");
    const found = checkRecordType(photo.value, types());
    expect(codes(found)).toEqual(["wrong_kind"]);
    expect(found[0]?.message).not.toContain('Photo"');
  });

  it("refuses a record with no type, an unknown type, or another type given", () => {
    const plain = validateRecord({
      kind: "digital_asset",
      id: A,
      title: "Scan",
      organizationId: ORG,
      templateKey: "oral-history",
      mediaType: "image/tiff",
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    if (!plain.ok) throw new Error("bad fixture");
    expect(codes(checkRecordType(plain.value, types()))).toEqual(["no_record_type"]);
    expect(codes(checkRecordType(record({ recordTypeKey: "letters" }), types()))).toEqual([
      "unknown_record_type",
    ]);
    expect(
      codes(checkRecordType(record(), oralHistory({ key: "letters" }) as unknown as RecordType)),
    ).toEqual(["record_type_mismatch"]);
  });

  it("refuses an invalid record or type", () => {
    const fake = { ...record(), title: " untrimmed" } as CatalogRecord;
    expect(codes(checkRecordType(fake, types()))).toEqual(["invalid_record"]);
    expect(
      codes(checkRecordType(record(), { key: "oral-history" } as unknown as RecordType)),
    ).toEqual(["invalid_record_type"]);
    expect(codes(checkRecordType(record(), { size: 1 } as never))).toEqual(["invalid_record_type"]);
  });

  it("returns frozen results", () => {
    const found = checkRecordType(record({ recordTypeKey: "letters" }), types());
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(checkRecordType(record(), types()))).toBe(true);
  });
});
