import { describe, expect, it } from "vitest";
import {
  DACS_ARCHIVAL_UNIT_PRESET,
  DACS_DUBLIN_CORE,
  DIGITAL_ASSET_DUBLIN_CORE,
  DIGITAL_ASSET_PRESET,
  DUBLIN_CORE_TERMS,
  MAX_DUBLIN_CORE_ENTRIES,
  RIGHTS_FIELD_KEY,
  SPECTRUM_DUBLIN_CORE,
  SPECTRUM_OBJECT_PRESET,
  STANDARD_PRESETS,
  dublinCoreTermUri,
  isDublinCoreTerm,
  mappingForTemplate,
  presetDublinCoreMapping,
  validateDublinCoreMapping,
  type DublinCoreMapping,
  type TemplatePreset,
  type Validated,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const PAIRS: readonly (readonly [DublinCoreMapping, TemplatePreset])[] = [
  [DACS_DUBLIN_CORE, DACS_ARCHIVAL_UNIT_PRESET],
  [SPECTRUM_DUBLIN_CORE, SPECTRUM_OBJECT_PRESET],
  [DIGITAL_ASSET_DUBLIN_CORE, DIGITAL_ASSET_PRESET],
];

function withEntries(entries: unknown): Record<string, unknown> {
  return { template: "dacs-archival-unit", entries };
}

describe("Dublin Core terms", () => {
  it("are unique and resolve to dcterms URIs", () => {
    expect(new Set(DUBLIN_CORE_TERMS).size).toBe(DUBLIN_CORE_TERMS.length);
    expect(dublinCoreTermUri("created")).toBe("http://purl.org/dc/terms/created");
    expect(dublinCoreTermUri("rightsHolder")).toBe("http://purl.org/dc/terms/rightsHolder");
  });

  it("isDublinCoreTerm accepts listed terms only, case-sensitively", () => {
    expect(isDublinCoreTerm("title")).toBe(true);
    expect(isDublinCoreTerm("accessRights")).toBe(true);
    for (const bad of ["Title", "accessrights", "constructor", "__proto__", "toString", "", 1]) {
      expect(isDublinCoreTerm(bad)).toBe(false);
    }
  });
});

describe("preset mappings", () => {
  it.each(PAIRS.map(([m, t]) => [t.key, m, t] as const))(
    "%s mapping is valid for its preset",
    (_key, mapping, template) => {
      const result = validateDublinCoreMapping(mapping, template);
      expect(codes(result)).toEqual([]);
      if (result.ok) expect(result.value).toEqual(mapping);
    },
  );

  it.each(PAIRS.map(([m, t]) => [t.key, m, t] as const))(
    "%s maps only public fields",
    (_key, mapping, template) => {
      for (const entry of mapping.entries) {
        const field = template.fields.find((f) => f.key === entry.field);
        expect(field?.visibility, entry.field).toBe("public");
      }
    },
  );

  it.each(PAIRS.map(([m, t]) => [t.key, m, t] as const))(
    "%s publishes the rights field as dcterms rights",
    (_key, mapping) => {
      expect(mapping.entries).toContainEqual({ field: RIGHTS_FIELD_KEY, term: "rights" });
    },
  );

  it("each mapping is deeply frozen", () => {
    for (const [m] of PAIRS) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.entries)).toBe(true);
      for (const e of m.entries) expect(Object.isFrozen(e)).toBe(true);
    }
  });

  it("presetDublinCoreMapping looks up by template key and nothing else", () => {
    for (const preset of STANDARD_PRESETS) {
      expect(presetDublinCoreMapping(preset.key)?.template).toBe(preset.key);
    }
    for (const key of ["constructor", "__proto__", "nope", 3, undefined]) {
      expect(presetDublinCoreMapping(key)).toBeUndefined();
    }
  });

  it("a mapping a preset passes fails once the template makes that field staff-only", () => {
    const edited = JSON.parse(JSON.stringify(DACS_ARCHIVAL_UNIT_PRESET)) as {
      fields: { key: string; visibility: string }[];
    };
    for (const f of edited.fields) if (f.key === "scope_and_content") f.visibility = "staff";
    const result = validateDublinCoreMapping(DACS_DUBLIN_CORE, edited);
    expect(codes(result)).toEqual(["staff_field"]);
  });
});

describe("validateDublinCoreMapping", () => {
  it("the preset mappings leave out the fields that start as staff-only", () => {
    const mapped = [DACS_DUBLIN_CORE, SPECTRUM_DUBLIN_CORE, DIGITAL_ASSET_DUBLIN_CORE].flatMap(
      (m) => m.entries.map((e) => e.field),
    );
    for (const field of [
      "custodial_history",
      "originals_location",
      "copies_location",
      "notes",
      "object_history",
      "source",
      "rights_holder",
    ]) {
      expect(mapped).not.toContain(field);
    }
  });

  it("refuses staff-only fields", () => {
    for (const field of [
      "acquisition_source",
      "appraisal",
      "storage_location",
      "custodial_history",
      "notes",
    ]) {
      const result = validateDublinCoreMapping(
        withEntries([{ field, term: "description" }]),
        DACS_ARCHIVAL_UNIT_PRESET,
      );
      expect(codes(result)).toEqual(["staff_field"]);
    }
    const spectrum = validateDublinCoreMapping(
      {
        template: "spectrum-object",
        entries: [
          { field: "valuation", term: "description" },
          { field: "credit_line", term: "contributor" },
        ],
      },
      SPECTRUM_OBJECT_PRESET,
    );
    expect(codes(spectrum)).toEqual(["staff_field", "staff_field"]);
  });

  it("refuses fields the template doesn't have, and bad keys", () => {
    expect(
      codes(
        validateDublinCoreMapping(
          withEntries([{ field: "nope", term: "title" }]),
          DACS_ARCHIVAL_UNIT_PRESET,
        ),
      ),
    ).toEqual(["unknown_field"]);
    expect(
      codes(
        validateDublinCoreMapping(
          withEntries([{ field: "Bad Key", term: "title" }]),
          DACS_ARCHIVAL_UNIT_PRESET,
        ),
      ),
    ).toEqual(["invalid_field_key"]);
    expect(
      codes(
        validateDublinCoreMapping(
          withEntries([{ field: "constructor", term: "title" }]),
          DACS_ARCHIVAL_UNIT_PRESET,
        ),
      ),
    ).toEqual(["invalid_field_key"]);
  });

  it("refuses terms that aren't listed", () => {
    for (const term of ["Title", "dc:title", "http://purl.org/dc/terms/title", "toString", 5]) {
      expect(
        codes(
          validateDublinCoreMapping(
            withEntries([{ field: "date", term }]),
            DACS_ARCHIVAL_UNIT_PRESET,
          ),
        ),
      ).toEqual(["unknown_term"]);
    }
  });

  it("refuses a mapping for another template", () => {
    expect(
      codes(validateDublinCoreMapping(SPECTRUM_DUBLIN_CORE, DACS_ARCHIVAL_UNIT_PRESET)),
    ).toContain("wrong_template");
  });

  it("refuses duplicate entries but allows two fields on one term", () => {
    const dup = withEntries([
      { field: "date", term: "date" },
      { field: "date", term: "date" },
    ]);
    expect(codes(validateDublinCoreMapping(dup, DACS_ARCHIVAL_UNIT_PRESET))).toEqual(["duplicate"]);
    const two = withEntries([
      { field: "date", term: "date" },
      { field: "bulk_date", term: "date" },
    ]);
    expect(validateDublinCoreMapping(two, DACS_ARCHIVAL_UNIT_PRESET).ok).toBe(true);
  });

  it("refuses unknown properties and wrong shapes", () => {
    expect(
      codes(
        validateDublinCoreMapping({ ...DACS_DUBLIN_CORE, extra: 1 }, DACS_ARCHIVAL_UNIT_PRESET),
      ),
    ).toEqual(["unknown_property"]);
    expect(
      codes(
        validateDublinCoreMapping(
          withEntries([{ field: "date", term: "date", uri: "x" }]),
          DACS_ARCHIVAL_UNIT_PRESET,
        ),
      ),
    ).toEqual(["unknown_property"]);
    expect(
      codes(validateDublinCoreMapping(withEntries("date"), DACS_ARCHIVAL_UNIT_PRESET)),
    ).toEqual(["required"]);
    expect(
      codes(validateDublinCoreMapping(withEntries(["date"]), DACS_ARCHIVAL_UNIT_PRESET)),
    ).toEqual(["not_an_object"]);
    for (const bad of [null, "x", [], 1]) {
      expect(codes(validateDublinCoreMapping(bad, DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
        "not_an_object",
      ]);
    }
  });

  it("allows an empty mapping (nothing published as Dublin Core)", () => {
    expect(validateDublinCoreMapping(withEntries([]), DACS_ARCHIVAL_UNIT_PRESET).ok).toBe(true);
  });

  it("limits the number of entries", () => {
    const many = Array.from({ length: MAX_DUBLIN_CORE_ENTRIES + 1 }, () => ({
      field: "date",
      term: "date",
    }));
    expect(codes(validateDublinCoreMapping(withEntries(many), DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
      "too_many",
    ]);
  });

  it("fails closed on an invalid template", () => {
    for (const template of [null, {}, { ...DACS_ARCHIVAL_UNIT_PRESET, fields: [] }]) {
      expect(codes(validateDublinCoreMapping(DACS_DUBLIN_CORE, template))).toEqual([
        "invalid_template",
      ]);
    }
    const noVisibility = JSON.parse(JSON.stringify(DACS_ARCHIVAL_UNIT_PRESET)) as {
      fields: Record<string, unknown>[];
    };
    for (const f of noVisibility.fields) delete f.visibility;
    expect(codes(validateDublinCoreMapping(DACS_DUBLIN_CORE, noVisibility))).toEqual([
      "invalid_template",
    ]);
  });

  it("returns a frozen copy, not the caller's object", () => {
    const input = withEntries([{ field: "date", term: "date" }]);
    const result = validateDublinCoreMapping(input, DACS_ARCHIVAL_UNIT_PRESET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(input);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.entries[0])).toBe(true);
  });
});

describe("mappingForTemplate", () => {
  function copyOf(preset: TemplatePreset, key: string) {
    const copy = JSON.parse(JSON.stringify(preset)) as {
      key: string;
      fields: { key: string; visibility: string }[];
    };
    copy.key = key;
    return copy;
  }

  it("a preset mapping fails for a copy with a new key, and works once re-targeted", () => {
    const copy = copyOf(SPECTRUM_OBJECT_PRESET, "my-objects");
    expect(codes(validateDublinCoreMapping(SPECTRUM_DUBLIN_CORE, copy))).toEqual([
      "wrong_template",
    ]);
    const result = mappingForTemplate(SPECTRUM_DUBLIN_CORE, copy);
    expect(codes(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.value.template).toBe("my-objects");
    expect(result.value.entries).toEqual(SPECTRUM_DUBLIN_CORE.entries);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("still refuses fields the copy made staff-only or removed", () => {
    const copy = copyOf(SPECTRUM_OBJECT_PRESET, "my-objects");
    for (const f of copy.fields) if (f.key === "materials") f.visibility = "staff";
    copy.fields = copy.fields.filter((f) => f.key !== "makers");
    expect(codes(mappingForTemplate(SPECTRUM_DUBLIN_CORE, copy)).sort()).toEqual([
      "staff_field",
      "unknown_field",
    ]);
  });

  it("still reports unknown properties, and fails closed on bad input", () => {
    const copy = copyOf(DACS_ARCHIVAL_UNIT_PRESET, "my-units");
    expect(codes(mappingForTemplate({ ...DACS_DUBLIN_CORE, extra: 1 }, copy))).toEqual([
      "unknown_property",
    ]);
    expect(codes(mappingForTemplate(DACS_DUBLIN_CORE, { ...copy, fields: [] }))).toEqual([
      "invalid_template",
    ]);
    for (const bad of [null, [], "x", new Proxy({ entries: [] }, {})]) {
      expect(codes(mappingForTemplate(bad, copy))).toEqual(["not_an_object"]);
    }
    const getter = {
      template: "x",
      get entries(): unknown {
        throw new Error("boom");
      },
    };
    expect(codes(mappingForTemplate(getter, copy))).toEqual(["unreadable"]);
    const hidden = { template: "x" };
    Object.defineProperty(hidden, "entries", { value: [], enumerable: false });
    expect(codes(mappingForTemplate(hidden, copy))).toEqual(["unreadable"]);
    expect(codes(mappingForTemplate({ entries: [], [Symbol("s")]: 1 }, copy))).toEqual([
      "unreadable",
    ]);
  });

  it("ignores entries on a polluted Object.prototype", () => {
    const copy = copyOf(DACS_ARCHIVAL_UNIT_PRESET, "my-units");
    (Object.prototype as Record<string, unknown>).entries = [
      { field: "acquisition_source", term: "description" },
    ];
    try {
      expect(codes(mappingForTemplate({ template: "x" }, copy))).toEqual(["required"]);
    } finally {
      delete (Object.prototype as Record<string, unknown>).entries;
    }
  });
});
