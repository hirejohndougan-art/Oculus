import { describe, expect, it } from "vitest";
import {
  DACS_ARCHIVAL_UNIT_PRESET,
  DCTERMS_NAMESPACE,
  DIGITAL_ASSET_PRESET,
  RIGHTS_FIELD_KEY,
  SPECTRUM_OBJECT_PRESET,
  STANDARD_PRESETS,
  checkRecordAgainstTemplate,
  isDublinCoreTerm,
  makeIdentifierChecker,
  standardPreset,
  templateFromPreset,
  validateRecord,
  validateTemplate,
  type CatalogRecord,
  type FieldTemplate,
  type TemplatePreset,
  type TemplateCheckOptions,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();
/** A preset as this organization's template. */
function own(preset: TemplatePreset): FieldTemplate {
  return { ...preset, organizationId: ORG };
}

function codesOf(r: { ok: boolean; issues?: readonly { code: string }[] }): string[] {
  return r.ok ? [] : (r.issues ?? []).map((i) => i.code);
}

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const T = "2026-11-20T16:05:00.000Z";

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function fieldOf(preset: TemplatePreset, key: string) {
  const f = preset.fields.find((x) => x.key === key);
  if (f === undefined) throw new Error(`no field ${key}`);
  return f;
}

function record(kind: string, fields: Record<string, unknown>): CatalogRecord {
  const r = validateRecord({
    kind,
    id: ID,
    title: "Dickinson Station and Park",
    organizationId: ORG,
    createdAt: T,
    updatedAt: T,
    fields,
    ...(kind === "archival_unit" ? { level: "item" } : {}),
    ...(kind === "digital_asset" ? { mediaType: "image/tiff" } : {}),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const RIGHTS = { uri: "http://rightsstatements.org/vocab/NoC-US/1.0/" };

describe("standard presets", () => {
  it("lists the three presets", () => {
    expect(STANDARD_PRESETS.map((p) => p.key)).toEqual([
      "dacs-archival-unit",
      "spectrum-object",
      "dublin-core-digital-asset",
    ]);
  });

  it.each(STANDARD_PRESETS.map((p) => [p.key, p] as const))(
    "%s becomes a valid template of an organization unchanged",
    (_key, preset) => {
      const result = templateFromPreset(preset, ORG);
      expect(result.ok ? [] : result.issues).toEqual([]);
      if (result.ok) expect(result.value).toEqual({ ...preset, organizationId: ORG });
    },
  );

  it.each(STANDARD_PRESETS.map((p) => [p.key, p] as const))(
    "%s has no organization, so it can't be used as a template itself",
    (_key, preset) => {
      expect(Object.hasOwn(preset, "organizationId")).toBe(false);
      const result = validateTemplate(preset);
      expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["invalid_organization"]);
    },
  );

  it.each(STANDARD_PRESETS.map((p) => [p.key, p] as const))(
    "%s is deeply frozen",
    (_key, preset) => {
      expect(isDeepFrozen(preset)).toBe(true);
      expect(isDeepFrozen(STANDARD_PRESETS)).toBe(true);
    },
  );

  it("a copied and edited preset is still a valid template", () => {
    const copy = JSON.parse(JSON.stringify(SPECTRUM_OBJECT_PRESET)) as {
      key: string;
      fields: Record<string, unknown>[];
    };
    copy.key = "my-objects";
    copy.fields.push({
      key: "gallery",
      label: "Gallery",
      kind: "text",
      required: false,
      repeatable: false,
      visibility: "public",
      inherited: false,
    });
    expect(templateFromPreset(copy, ORG).ok).toBe(true);
  });

  it("templateFromPreset needs a real organization ID", () => {
    for (const bad of [undefined, "", "org", ORG.toUpperCase(), 1, null]) {
      const r = templateFromPreset(DACS_ARCHIVAL_UNIT_PRESET, bad);
      expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["invalid_organization"]);
    }
  });

  it("templateFromPreset refuses a template that already names an organization", () => {
    const mine = templateFromPreset(DACS_ARCHIVAL_UNIT_PRESET, ORG);
    if (!mine.ok) throw new Error("bad fixture");
    const r = templateFromPreset(mine.value, newOrganizationId());
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["has_organization"]);
  });

  it("templateFromPreset runs no getters and refuses Proxies and non-objects", () => {
    let ran = false;
    const sneaky = { ...DACS_ARCHIVAL_UNIT_PRESET };
    Object.defineProperty(sneaky, "label", {
      get: () => {
        ran = true;
        return "Label";
      },
      enumerable: true,
    });
    const r = templateFromPreset(sneaky, ORG);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["not_plain_data"]);
    expect(ran).toBe(false);
    expect(codesOf(templateFromPreset(new Proxy(DACS_ARCHIVAL_UNIT_PRESET, {}), ORG))).toEqual([
      "not_an_object",
    ]);
    expect(codesOf(templateFromPreset([DACS_ARCHIVAL_UNIT_PRESET], ORG))).toEqual([
      "not_an_object",
    ]);
    expect(codesOf(templateFromPreset("dacs-archival-unit", ORG))).toEqual(["not_an_object"]);
  });

  it("templateFromPreset copies, so later changes to the preset object aren't seen", () => {
    const source = JSON.parse(JSON.stringify(DACS_ARCHIVAL_UNIT_PRESET)) as { label: string };
    const r = templateFromPreset(source, ORG);
    source.label = "Changed";
    expect(r.ok && r.value.label).toBe(DACS_ARCHIVAL_UNIT_PRESET.label);
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });

  it("each describes the right record kind", () => {
    expect(DACS_ARCHIVAL_UNIT_PRESET.appliesTo).toEqual(["archival_unit"]);
    expect(SPECTRUM_OBJECT_PRESET.appliesTo).toEqual(["object"]);
    expect(DIGITAL_ASSET_PRESET.appliesTo).toEqual(["digital_asset"]);
  });

  it("can be used side by side by one organization (distinct keys and kinds)", () => {
    const keys = new Set(STANDARD_PRESETS.map((p) => p.key));
    expect(keys.size).toBe(STANDARD_PRESETS.length);
    const kinds = STANDARD_PRESETS.flatMap((p) => p.appliesTo);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("no preset is for one organization", () => {
    const text = JSON.stringify(STANDARD_PRESETS).toLowerCase();
    expect(text).not.toContain("dickinson");
    expect(text).not.toContain("dhs");
  });

  it("standardPreset finds presets by key and nothing else", () => {
    expect(standardPreset("dacs-archival-unit")).toBe(DACS_ARCHIVAL_UNIT_PRESET);
    expect(standardPreset("spectrum-object")).toBe(SPECTRUM_OBJECT_PRESET);
    expect(standardPreset("dublin-core-digital-asset")).toBe(DIGITAL_ASSET_PRESET);
    for (const key of ["constructor", "__proto__", "toString", "DACS-archival-unit", "", 1, null]) {
      expect(standardPreset(key)).toBeUndefined();
    }
  });
});

describe("standards citations", () => {
  it.each(STANDARD_PRESETS.map((p) => [p.key, p] as const))(
    "every field in %s cites a standard element, except staff fields of the Dublin Core preset",
    (_key, preset) => {
      for (const f of preset.fields) {
        if (preset === DIGITAL_ASSET_PRESET && f.visibility === "staff") {
          expect(f.standards, f.key).toBeUndefined();
        } else {
          expect(f.standards?.length ?? 0, f.key).toBeGreaterThan(0);
        }
      }
    },
  );

  it("no staff field carries a Dublin Core cite", () => {
    for (const preset of STANDARD_PRESETS) {
      for (const f of preset.fields.filter((x) => x.visibility === "staff")) {
        for (const s of f.standards ?? []) expect(s.standard, f.key).not.toBe("dcterms");
      }
    }
  });

  it("DACS fields cite DACS element numbers and names", () => {
    const elements = DACS_ARCHIVAL_UNIT_PRESET.fields
      .flatMap((f) => f.standards ?? [])
      .filter((s) => s.standard === "dacs")
      .map((s) => s.element);
    for (const e of elements) expect(e).toMatch(/^([2-8]\.\d \S.*|Access points)$/);
    expect(fieldOf(DACS_ARCHIVAL_UNIT_PRESET, "reference_code").standards).toEqual([
      { standard: "dacs", element: "2.1 Reference Code" },
    ]);
    expect(fieldOf(DACS_ARCHIVAL_UNIT_PRESET, "date").standards).toEqual([
      { standard: "dacs", element: "2.4 Date" },
    ]);
    expect(fieldOf(DACS_ARCHIVAL_UNIT_PRESET, "extent").standards).toEqual([
      { standard: "dacs", element: "2.5 Extent" },
    ]);
    expect(fieldOf(DACS_ARCHIVAL_UNIT_PRESET, "reproduction_and_use").standards).toEqual([
      { standard: "dacs", element: "4.4 Conditions Governing Reproduction and Use" },
    ]);
  });

  it("DACS required elements are required fields", () => {
    for (const key of [
      "reference_code",
      "repository",
      "date",
      "extent",
      "scope_and_content",
      "access_conditions",
      "languages",
    ]) {
      expect(fieldOf(DACS_ARCHIVAL_UNIT_PRESET, key).required, key).toBe(true);
    }
  });

  it("the title is the record's own title, not a template field", () => {
    for (const preset of STANDARD_PRESETS) {
      expect(preset.fields.some((f) => f.key === "title")).toBe(false);
    }
  });

  it("Spectrum fields cite Spectrum units of information, or a group marked as one", () => {
    expect(fieldOf(SPECTRUM_OBJECT_PRESET, "object_number").standards).toEqual([
      { standard: "spectrum", element: "Object number" },
    ]);
    expect(fieldOf(SPECTRUM_OBJECT_PRESET, "object_name").standards).toEqual([
      { standard: "spectrum", element: "Object name" },
    ]);
    for (const f of SPECTRUM_OBJECT_PRESET.fields) {
      for (const s of f.standards ?? []) expect(s.standard).toBe("spectrum");
    }
    // Only the group names for rights and valuation could be confirmed.
    expect(fieldOf(SPECTRUM_OBJECT_PRESET, RIGHTS_FIELD_KEY).standards).toEqual([
      { standard: "spectrum", element: "Rights information (information group)" },
    ]);
    expect(fieldOf(SPECTRUM_OBJECT_PRESET, "valuation").standards).toEqual([
      { standard: "spectrum", element: "Object valuation information (information group)" },
    ]);
    const elements = SPECTRUM_OBJECT_PRESET.fields.flatMap((f) =>
      (f.standards ?? []).map((s) => s.element),
    );
    for (const e of elements.filter((x) => / information\b/i.test(x))) {
      expect(e).toMatch(/ \(information group\)$/);
    }
  });

  it("Dublin Core citations use real term URIs", () => {
    const all = STANDARD_PRESETS.flatMap((p) => p.fields.flatMap((f) => f.standards ?? []));
    const dc = all.filter((s) => s.standard === "dcterms");
    expect(dc.length).toBeGreaterThan(0);
    for (const s of dc) {
      expect(isDublinCoreTerm(s.element), s.element).toBe(true);
      expect(s.uri).toBe(`${DCTERMS_NAMESPACE}${s.element}`);
    }
    for (const s of all.filter((x) => x.standard !== "dcterms")) expect(s.uri).toBeUndefined();
  });
});

describe("visibility", () => {
  it.each(STANDARD_PRESETS.map((p) => [p.key, p] as const))(
    "%s has the rights field, public",
    (_key, preset) => {
      const f = fieldOf(preset, RIGHTS_FIELD_KEY);
      expect(f.kind).toBe("rights");
      expect(f.visibility).toBe("public");
      expect(f.repeatable).toBe(false);
    },
  );

  it("staff-only fields are exactly the ones chosen", () => {
    const staff = (p: TemplatePreset) =>
      p.fields.filter((f) => f.visibility === "staff").map((f) => f.key);
    expect(staff(DACS_ARCHIVAL_UNIT_PRESET)).toEqual([
      "custodial_history",
      "acquisition_source",
      "appraisal",
      "originals_location",
      "copies_location",
      "notes",
      "description_control",
      "storage_location",
    ]);
    expect(staff(SPECTRUM_OBJECT_PRESET)).toEqual([
      "other_numbers",
      "object_history",
      "acquisition_method",
      "acquisition_source",
      "acquisition_date",
      "acquisition_note",
      "credit_line",
      "current_location",
      "valuation",
      "comments",
    ]);
    expect(staff(DIGITAL_ASSET_PRESET)).toEqual(["source", "rights_holder", "digitization_notes"]);
  });

  it("anything about provenance, custody, owners, sources, donors, location, valuation or notes is staff", () => {
    const sensitive =
      /provenance|custod|owner|holder|(?:^|[\s_])source|donor|acqui|apprais|storage|location|valuation|insurance|internal|comment|credit|processing|digitization|object.history|notes/i;
    // Public on purpose: researchers need the access conditions (the help
    // text forbids personal reasons), the repository is the organization's
    // own name and address, and rights must be published (D-011).
    const allowed = new Set(["access_conditions", "repository", RIGHTS_FIELD_KEY]);
    let checked = 0;
    for (const preset of STANDARD_PRESETS) {
      for (const f of preset.fields) {
        const text = `${f.key} ${f.label} ${f.standards?.map((s) => s.element).join(" ") ?? ""}`;
        if (!sensitive.test(text) || allowed.has(f.key)) continue;
        checked++;
        expect(f.visibility, f.key).toBe("staff");
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("the access conditions help says it is published and forbids confidential reasons", () => {
    const f = fieldOf(DACS_ARCHIVAL_UNIT_PRESET, "access_conditions");
    expect(f.visibility).toBe("public");
    expect(f.help).toMatch(/^Published\./);
    expect(f.help).toMatch(/personal or donor-confidential reasons/);
  });

  it("every visibility is stated, never left to a default", () => {
    for (const preset of STANDARD_PRESETS) {
      for (const f of preset.fields) expect(Object.hasOwn(f, "visibility")).toBe(true);
    }
  });
});

describe("records checked against the presets", () => {
  // Identifier values need the organization's types to be checked (D-015).
  // Invented sample types for the identifier fields the presets use.
  const made = makeIdentifierChecker([
    // Call and accession numbers are usually published with the record, so
    // these are marked public; types are staff only by default (D-022).
    {
      key: "call_number",
      label: "Call number",
      pattern: "MS-####.#",
      organizationId: ORG,
      uniqueness: "current",
      public: true,
    },
    {
      key: "accession_number",
      label: "Accession number",
      organizationId: ORG,
      uniqueness: "all_time",
      public: true,
    },
  ]);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  const withIds: TemplateCheckOptions = { checkers: { identifier: made.value } };

  it("a complete DACS item passes, and missing required elements are reported", () => {
    const fields = {
      reference_code: { type: "call_number", value: "MS-0001.1" },
      repository: "An invented historical society, Example Town",
      date: "1909",
      extent: ["1 photograph"],
      scope_and_content: "A photograph of the station and park.",
      access_conditions: "Open to researchers.",
      languages: [{ label: "English" }],
      [RIGHTS_FIELD_KEY]: RIGHTS,
      acquisition_source: "Invented donor, 2001.",
    };
    expect(
      checkRecordAgainstTemplate(
        record("archival_unit", fields),
        own(DACS_ARCHIVAL_UNIT_PRESET),
        withIds,
      ),
    ).toEqual([]);
    const issues = checkRecordAgainstTemplate(
      record("archival_unit", { date: "1909" }),
      own(DACS_ARCHIVAL_UNIT_PRESET),
    );
    expect(issues.map((i) => i.path.join("."))).toContain("fields.reference_code");
    // Inherited elements may come from a unit higher up.
    const saving = checkRecordAgainstTemplate(
      record("archival_unit", { date: "1909" }),
      own(DACS_ARCHIVAL_UNIT_PRESET),
      { allowMissingInherited: true },
    );
    expect(saving.map((i) => i.path.join("."))).not.toContain("fields.repository");
  });

  it("a Spectrum object passes", () => {
    const fields = {
      object_number: { type: "accession_number", value: "2026.015" },
      object_name: { label: "chair" },
      brief_description: "A wooden kitchen chair.",
      acquisition_method: "gift",
      [RIGHTS_FIELD_KEY]: RIGHTS,
    };
    expect(
      checkRecordAgainstTemplate(record("object", fields), own(SPECTRUM_OBJECT_PRESET), withIds),
    ).toEqual([]);
    expect(
      checkRecordAgainstTemplate(
        record("object", { ...fields, acquisition_method: "stolen" }),
        own(SPECTRUM_OBJECT_PRESET),
        withIds,
      ).map((i) => i.code),
    ).toEqual(["not_an_option"]);
  });

  it("a digital asset passes, and the preset is only for digital assets", () => {
    const fields = {
      resource_type: "StillImage",
      date_created: "1909~",
      [RIGHTS_FIELD_KEY]: RIGHTS,
    };
    expect(
      checkRecordAgainstTemplate(record("digital_asset", fields), own(DIGITAL_ASSET_PRESET)),
    ).toEqual([]);
    expect(
      checkRecordAgainstTemplate(record("object", {}), own(DIGITAL_ASSET_PRESET)).map(
        (i) => i.code,
      ),
    ).toEqual(["wrong_template"]);
  });
});
