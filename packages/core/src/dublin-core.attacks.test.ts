// Attack tests: a mapping that tries to publish a staff-only field, or to
// trick the check into reading something other than what it returns.
import { afterEach, describe, expect, it } from "vitest";
import {
  DACS_ARCHIVAL_UNIT_PRESET,
  DACS_DUBLIN_CORE,
  newOrganizationId,
  mappingForTemplate,
  mappingFromPreset,
  presetDublinCoreMapping,
  standardPreset,
  templateFromPreset,
  validateDublinCoreMapping,
  type FieldTemplate,
  type Validated,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const STAFF_ENTRY = { field: "acquisition_source", term: "description" };

const ORG = newOrganizationId();

function ownTemplate(): FieldTemplate {
  const made = templateFromPreset(DACS_ARCHIVAL_UNIT_PRESET, ORG);
  if (!made.ok) throw new Error("preset template is invalid");
  return made.value;
}

const DACS_T = ownTemplate();
const DACS_M = { ...DACS_DUBLIN_CORE, organizationId: ORG };

describe("Dublin Core mapping attacks", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).entries;
    delete (Object.prototype as Record<string, unknown>).visibility;
    delete (Object.prototype as Record<string, unknown>).field;
  });

  it("a Proxy mapping is refused without being read", () => {
    let reads = 0;
    const proxy = new Proxy(
      { organizationId: ORG, template: "dacs-archival-unit", entries: [] },
      {
        get(target, key, receiver) {
          reads++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(codes(validateDublinCoreMapping(proxy, DACS_T))).toEqual(["not_an_object"]);
    expect(reads).toBe(0);
  });

  it("a getter that answers differently the second time is refused", () => {
    let calls = 0;
    const entry = {
      term: "description",
      get field() {
        calls++;
        return calls === 1 ? "date" : "acquisition_source";
      },
    };
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries: [entry] },
      DACS_T,
    );
    expect(result.ok).toBe(false);
  });

  it("a getter that throws is reported, not thrown", () => {
    const mapping = {
      organizationId: ORG,
      template: "dacs-archival-unit",
      get entries(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => validateDublinCoreMapping(mapping, DACS_T)).not.toThrow();
    expect(validateDublinCoreMapping(mapping, DACS_T).ok).toBe(false);
  });

  it("a Proxy template fails closed", () => {
    const proxy = new Proxy(DACS_T, {});
    expect(codes(validateDublinCoreMapping(DACS_M, proxy))).toEqual(["invalid_template"]);
  });

  it("a polluted toJSON doesn't make distinct entries look like duplicates", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.toJSON = () => "same";
    try {
      expect(validateDublinCoreMapping(DACS_M, DACS_T).ok).toBe(true);
    } finally {
      delete proto.toJSON;
    }
  });

  it("entries inherited from a polluted Object.prototype are not read", () => {
    (Object.prototype as Record<string, unknown>).entries = [STAFF_ENTRY];
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit" },
      DACS_T,
    );
    expect(codes(result)).toEqual(["required"]);
  });

  it("a polluted visibility can't make a staff field public", () => {
    (Object.prototype as Record<string, unknown>).visibility = "public";
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries: [STAFF_ENTRY] },
      DACS_T,
    );
    expect(codes(result)).toEqual(["staff_field"]);
  });

  it("a field inherited from a polluted prototype is not read", () => {
    (Object.prototype as Record<string, unknown>).field = "date";
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries: [{ term: "date" }] },
      DACS_T,
    );
    expect(codes(result)).toEqual(["invalid_field_key"]);
  });

  it("prototype keys in entries are refused", () => {
    const entry = JSON.parse('{"__proto__": {"field": "date"}, "term": "date"}') as unknown;
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries: [entry] },
      DACS_T,
    );
    expect(result.ok).toBe(false);
  });

  it("a hidden (non-enumerable) entry is refused", () => {
    const entries: unknown[] = [];
    Object.defineProperty(entries, "0", { value: STAFF_ENTRY, enumerable: false });
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries },
      DACS_T,
    );
    expect(result.ok).toBe(false);
  });

  it("text echoed into messages is escaped", () => {
    const sneaky = "date‮evil";
    const result = validateDublinCoreMapping(
      {
        organizationId: ORG,
        template: "dacs-archival-unit",
        entries: [{ field: "date", term: sneaky }],
      },
      DACS_T,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const i of result.issues) expect(i.message).not.toContain("‮");
  });

  it("an oversized mapping is refused without hanging", () => {
    const entries = Array.from({ length: 100_000 }, () => STAFF_ENTRY);
    const start = Date.now();
    const result = validateDublinCoreMapping(
      { organizationId: ORG, template: "dacs-archival-unit", entries },
      DACS_T,
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("the built-in presets and mappings can't be changed", () => {
    const preset = standardPreset("dacs-archival-unit");
    const mapping = presetDublinCoreMapping("dacs-archival-unit");
    expect(() => {
      (preset?.fields[0] as { visibility: string }).visibility = "staff";
    }).toThrow(TypeError);
    expect(() => {
      (mapping?.entries as unknown[]).push(STAFF_ENTRY);
    }).toThrow(TypeError);
  });
});

describe("Dublin Core mappings across organizations (D-030, D-047)", () => {
  const OTHER = newOrganizationId();
  const SECRET_FIELD = "other_orgs_secret_field";

  function otherTemplate(): FieldTemplate {
    const made = templateFromPreset(DACS_ARCHIVAL_UNIT_PRESET, OTHER);
    if (!made.ok) throw new Error("preset template is invalid");
    return made.value;
  }

  /** Another organization's mapping, for a template with the same key as ours. */
  const OTHERS_MAPPING = {
    organizationId: OTHER,
    template: "dacs-archival-unit",
    entries: [
      { field: "date", term: "date" },
      { field: SECRET_FIELD, term: "description" },
    ],
  };

  function onlyIssue(result: Validated<unknown>, code: string): void {
    expect(codes(result)).toEqual([code]);
    if (result.ok) return;
    for (const i of result.issues) {
      for (const leaked of [SECRET_FIELD, "dacs-archival-unit", OTHER, ORG]) {
        expect(i.message).not.toContain(leaked);
        expect(i.path.map(String)).not.toContain(leaked);
      }
    }
  }

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).organizationId;
  });

  it("another organization's mapping is refused for a template with the same key, naming none of its keys", () => {
    onlyIssue(validateDublinCoreMapping(OTHERS_MAPPING, DACS_T), "wrong_organization");
    // Even one that would pass every other check.
    onlyIssue(
      validateDublinCoreMapping({ ...DACS_DUBLIN_CORE, organizationId: OTHER }, DACS_T),
      "wrong_organization",
    );
  });

  it("our mapping is refused for another organization's template", () => {
    onlyIssue(validateDublinCoreMapping(DACS_M, otherTemplate()), "wrong_organization");
  });

  it("a mapping that doesn't say which organization it belongs to is refused", () => {
    const { organizationId: _dropped, ...noOrg } = OTHERS_MAPPING;
    for (const owner of [undefined, null, "", "not-an-id", 1, ORG.toUpperCase(), [ORG]]) {
      const mapping = owner === undefined ? noOrg : { ...noOrg, organizationId: owner };
      onlyIssue(validateDublinCoreMapping(mapping, DACS_T), "invalid_organization");
    }
    // The built-in preset mapping has no organization.
    expect(codes(validateDublinCoreMapping(DACS_DUBLIN_CORE, DACS_T))).toEqual([
      "invalid_organization",
    ]);
  });

  it("an organizationId inherited from a polluted Object.prototype is not read", () => {
    (Object.prototype as Record<string, unknown>).organizationId = ORG;
    const { organizationId: _dropped, ...noOrg } = DACS_M;
    expect(codes(validateDublinCoreMapping(noOrg, DACS_T))).toEqual(["invalid_organization"]);
    expect(codes(mappingForTemplate(noOrg, DACS_T))).toEqual(["invalid_organization"]);
  });

  it("an organizationId behind a getter is never run, and refused", () => {
    let reads = 0;
    const mapping = {
      template: "dacs-archival-unit",
      entries: [{ field: SECRET_FIELD, term: "description" }],
      get organizationId(): unknown {
        reads++;
        return reads === 1 ? ORG : OTHER;
      },
    };
    onlyIssue(validateDublinCoreMapping(mapping, DACS_T), "invalid_organization");
    expect(codes(mappingForTemplate(mapping, DACS_T))).toEqual(["unreadable"]);
    expect(codes(mappingFromPreset(mapping, DACS_T))).toEqual(["unreadable"]);
    expect(reads).toBe(0);
  });

  it("an unreadable mapping of another organization reports only the organization", () => {
    const hostile = {
      organizationId: OTHER,
      template: "dacs-archival-unit",
      entries: [{ field: SECRET_FIELD, term: "description" }],
      get [SECRET_FIELD](): unknown {
        return 1;
      },
    };
    onlyIssue(validateDublinCoreMapping(hostile, DACS_T), "wrong_organization");
  });

  it("a preset template (no organization) can't be used to check a mapping", () => {
    expect(codes(validateDublinCoreMapping(DACS_M, DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
      "invalid_template",
    ]);
    expect(codes(validateDublinCoreMapping(DACS_DUBLIN_CORE, DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
      "invalid_template",
    ]);
  });

  it("mappingForTemplate can't move another organization's mapping onto our template", () => {
    onlyIssue(mappingForTemplate(OTHERS_MAPPING, DACS_T), "wrong_organization");
    onlyIssue(mappingForTemplate(DACS_M, otherTemplate()), "wrong_organization");
    // Nor adopt a mapping with no organization: that is mappingFromPreset's job.
    expect(codes(mappingForTemplate(DACS_DUBLIN_CORE, DACS_T))).toEqual(["invalid_organization"]);
  });

  it("mappingFromPreset refuses a mapping that already names an organization", () => {
    for (const mapping of [OTHERS_MAPPING, DACS_M, { ...DACS_DUBLIN_CORE, organizationId: null }]) {
      expect(codes(mappingFromPreset(mapping, DACS_T))).toEqual(["has_organization"]);
    }
    const hidden = { ...DACS_DUBLIN_CORE };
    Object.defineProperty(hidden, "organizationId", { value: OTHER, enumerable: false });
    expect(codes(mappingFromPreset(hidden, DACS_T))).toEqual(["unreadable"]);
  });

  it("mappingFromPreset gives the template's organization, never an inherited one", () => {
    (Object.prototype as Record<string, unknown>).organizationId = OTHER;
    const made = mappingFromPreset(DACS_DUBLIN_CORE, DACS_T);
    expect(codes(made)).toEqual([]);
    if (!made.ok) return;
    expect(Object.hasOwn(made.value, "organizationId")).toBe(true);
    expect(made.value.organizationId).toBe(ORG);
    const theirs = mappingFromPreset(DACS_DUBLIN_CORE, otherTemplate());
    expect(theirs.ok && theirs.value.organizationId).toBe(OTHER);
    // Each organization's copy passes for its own template only.
    expect(validateDublinCoreMapping(made.value, DACS_T).ok).toBe(true);
    onlyIssue(validateDublinCoreMapping(made.value, otherTemplate()), "wrong_organization");
  });

  it("mappingFromPreset refuses a preset template", () => {
    expect(codes(mappingFromPreset(DACS_DUBLIN_CORE, DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
      "invalid_template",
    ]);
  });
});
