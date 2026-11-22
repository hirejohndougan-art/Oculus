// T-019a: templates belong to one organization (D-019, D-030). Every function
// that takes a template refuses one of another organization, or a set that
// mixes organizations, and never quotes the other organization's values.
import { describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
  effectiveRecord,
  indexTemplates,
  legacyTemplateIssues,
  newOrganizationId,
  templateChanges,
  validateLegacyTemplate,
  validateRecord,
  validateTemplate,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const OTHER = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function template(organizationId: unknown, key = "photos", visibility = "public"): FieldTemplate {
  return {
    key,
    label: "Photographs",
    organizationId,
    appliesTo: ["object"],
    fields: [
      {
        key: "note",
        label: "Note",
        kind: "text",
        required: false,
        repeatable: false,
        visibility,
        inherited: false,
      },
    ],
  } as unknown as FieldTemplate;
}

function record(organizationId: string, id = A, templateKey = "photos"): CatalogRecord {
  const r = validateRecord({
    kind: "object",
    id,
    title: "Station postcard",
    organizationId,
    templateKey,
    createdAt: T,
    updatedAt: T,
    fields: { note: "SECRET staff note" },
  });
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

function withoutOrganization(t: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...t };
  delete copy.organizationId;
  return copy;
}

function codes(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.code);
  const r = result as Validated<unknown>;
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe("a template names its organization", () => {
  it("is required and must be an organization ID", () => {
    expect(validateTemplate(template(ORG)).ok).toBe(true);
    for (const bad of ["", "org-1", ORG.toUpperCase(), 7, null, {}]) {
      expect(codes(validateTemplate(template(bad)))).toContain("invalid_organization");
    }
    // Set to undefined: refused when the template is read as plain data.
    expect(codes(validateTemplate(template(undefined)))).toEqual(["undefined_value"]);
    const missing = withoutOrganization(template(ORG));
    expect(codes(validateTemplate(missing))).toEqual(["invalid_organization"]);
    expect(codes(validateLegacyTemplate(missing))).toEqual(["invalid_organization"]);
  });

  it("can't come from a getter or the prototype", () => {
    const base = withoutOrganization(template(ORG));
    const getter = { ...base };
    Object.defineProperty(getter, "organizationId", { get: () => ORG, enumerable: true });
    expect(validateTemplate(getter).ok).toBe(false);
    const inherited = Object.assign(Object.create({ organizationId: ORG }) as object, base);
    expect(validateTemplate(inherited).ok).toBe(false);
  });

  it("is kept in the validated copy", () => {
    const r = validateTemplate(template(ORG));
    expect(r.ok && r.value.organizationId).toBe(ORG);
  });

  it("legacyTemplateIssues refuses two organizations' templates and quotes neither", () => {
    const r = legacyTemplateIssues([template(ORG, "mine"), template(OTHER, "other-secret-key")]);
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(r)).not.toContain("other-secret-key");
  });

  it("legacyTemplateIssues reports a template without one as not fixable", () => {
    const missing = withoutOrganization(template(ORG));
    const r = legacyTemplateIssues([template(ORG), missing]);
    expect(r.ok && r.value.map((p) => [p.index, p.fixable])).toEqual([[1, false]]);
  });
});

describe("a record is never checked against another organization's template", () => {
  it("refuses a template given directly", () => {
    expect(checkRecordAgainstTemplate(record(ORG), template(ORG))).toEqual([]);
    const issues = checkRecordAgainstTemplate(record(ORG), template(OTHER));
    expect(codes(issues)).toEqual(["wrong_organization"]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
    expect(JSON.stringify(issues)).not.toContain(OTHER);
  });

  it("refuses another organization's registry", () => {
    const theirs = indexTemplates([template(OTHER)]);
    if (!theirs.ok) throw new Error("bad fixture");
    expect(codes(checkRecordAgainstTemplate(record(ORG), theirs.value))).toEqual([
      "wrong_organization",
    ]);
    const mine = indexTemplates([template(ORG)]);
    if (!mine.ok) throw new Error("bad fixture");
    expect(checkRecordAgainstTemplate(record(ORG), mine.value)).toEqual([]);
  });

  it("refuses a record whose organizationId was changed after it was validated", () => {
    const forged = { ...record(ORG), organizationId: OTHER } as CatalogRecord;
    expect(codes(checkRecordAgainstTemplate(forged, template(ORG)))).toEqual([
      "wrong_organization",
    ]);
  });
});

describe("indexTemplates holds one organization's templates", () => {
  it("refuses a list mixing two organizations, whatever the order", () => {
    for (const list of [
      [template(ORG, "a"), template(OTHER, "b")],
      [template(OTHER, "b"), template(ORG, "a")],
      [template(ORG, "a"), template(ORG, "b"), template(OTHER, "c")],
    ]) {
      const r = indexTemplates(list);
      expect(codes(r)).toEqual(["mixed_organizations"]);
    }
  });

  it("two organizations can each have a template with the same key", () => {
    expect(indexTemplates([template(ORG)]).ok).toBe(true);
    expect(indexTemplates([template(OTHER)]).ok).toBe(true);
  });
});

describe("effectiveRecord uses only the record's organization's templates", () => {
  it("refuses another organization's template from a lookup or a registry", () => {
    const item = record(ORG);
    const viaLookup = effectiveRecord(item.id, [item], () => template(OTHER));
    expect(codes(viaLookup)).toEqual(["wrong_organization"]);
    expect(JSON.stringify(viaLookup)).not.toContain("SECRET");

    const theirs = indexTemplates([template(OTHER)]);
    if (!theirs.ok) throw new Error("bad fixture");
    expect(codes(effectiveRecord(item.id, [item], theirs.value))).toEqual(["wrong_organization"]);

    const mine = indexTemplates([template(ORG)]);
    if (!mine.ok) throw new Error("bad fixture");
    const r = effectiveRecord(item.id, [item], mine.value);
    expect(r.ok && r.value.fields.note).toBe("SECRET staff note");
  });
});

describe("templateChanges stays inside one organization", () => {
  it("refuses comparing two organizations' templates", () => {
    const r = templateChanges(template(ORG), template(OTHER));
    expect(codes(r)).toEqual(["mixed_organizations"]);
  });

  it("refuses records of another organization, and doesn't list them", () => {
    const old = template(ORG, "photos", "staff");
    const made = template(ORG, "photos", "public");
    expect(templateChanges(old, made, [record(ORG)]).ok).toBe(true);
    const r = templateChanges(old, made, [record(OTHER)]);
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(r)).not.toContain(A);
  });

  it("refuses a set mixing the template's organization with another", () => {
    const old = template(ORG, "photos", "staff");
    const made = template(ORG, "photos", "public");
    const r = templateChanges(old, made, [record(ORG), record(OTHER, B)]);
    expect(codes(r)).not.toEqual([]);
    expect(r.ok).toBe(false);
  });
});
