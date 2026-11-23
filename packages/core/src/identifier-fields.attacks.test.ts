// Attack tests for the one-home rule (D-038): a template identifier field
// may only point at one of its record's current identifiers. Each test
// tries to get a number into a field that the record doesn't hold, or to
// make the check look at the wrong set. Nothing may throw.
import { describe, expect, it } from "vitest";
import { identifierFieldIssues, newOrganizationId } from "./index.js";
import { TPL, identifiersOf, object } from "./identifier-fields.fixtures.js";

const DONOR = "DF-SECRET-0042";

function codes(list: readonly { code: string }[]): string[] {
  return list.map((i) => i.code);
}

describe("identifierFieldIssues refuses numbers the record doesn't hold", () => {
  it("refuses a staff-type primary relabelled as the field's public type", () => {
    const r = object({ object_number: { type: "object_number", value: DONOR } });
    const ids = identifiersOf(r, [{ type: "donor_file_number", value: DONOR, primary: true }]);
    const found = identifierFieldIssues(r, TPL, ids);
    expect(codes(found)).toEqual(["identifier_not_held"]);
    expect(JSON.stringify(found)).not.toContain(DONOR);
  });

  it("refuses a lookalike or differently spaced spelling of a held number", () => {
    const ids = (r: ReturnType<typeof object>) =>
      identifiersOf(r, [{ type: "object_number", value: "2026.015", primary: true }]);
    for (const value of ["2026.0l5", "2026.015 ", "2026,015", "2О26.015"]) {
      const r = object({ object_number: { type: "object_number", value } });
      expect(codes(identifierFieldIssues(r, TPL, ids(r)))).toEqual(["identifier_not_held"]);
    }
  });

  it("refuses a former number", () => {
    const r = object({ object_number: { type: "object_number", value: "1999.001" } });
    const ids = identifiersOf(
      r,
      [{ type: "object_number", value: "2026.015", primary: true }],
      [{ type: "object_number", value: "1999.001" }],
    );
    expect(codes(identifierFieldIssues(r, TPL, ids))).toEqual(["identifier_not_held"]);
  });

  it("refuses another record's identifiers, naming no values", () => {
    const r = object({ object_number: { type: "object_number", value: "2026.015" } });
    const other = object({});
    const ids = identifiersOf(other, [{ type: "object_number", value: "2026.015", primary: true }]);
    const found = identifierFieldIssues(r, TPL, ids);
    expect(codes(found)).toEqual(["wrong_record"]);
    expect(JSON.stringify(found)).not.toContain("2026.015");
  });

  it("refuses identifiers of another organization, and another organization's template", () => {
    const r = object({ object_number: { type: "object_number", value: "2026.015" } });
    const ids = {
      ...identifiersOf(r, [{ type: "object_number", value: "2026.015", primary: true }]),
      organizationId: newOrganizationId(),
    };
    expect(codes(identifierFieldIssues(r, TPL, ids))).toEqual(["mixed_organizations"]);
    const own = identifiersOf(r, [{ type: "object_number", value: "2026.015", primary: true }]);
    const foreign = { ...TPL, organizationId: newOrganizationId() };
    expect(codes(identifierFieldIssues(r, foreign, own))).toEqual(["wrong_organization"]);
    const missing: Record<string, unknown> = { ...own };
    delete missing.organizationId;
    expect(codes(identifierFieldIssues(r, TPL, missing))).toEqual(["mixed_organizations"]);
  });

  it("refuses Proxies, getters, hostile values and malformed input without throwing", () => {
    const r = object({ object_number: { type: "object_number", value: "2026.015" } });
    const ids = identifiersOf(r, [{ type: "object_number", value: "2026.015", primary: true }]);
    expect(codes(identifierFieldIssues(r, TPL, new Proxy(ids, {})))).toEqual([
      "mixed_organizations",
    ]);
    const withGetter = { ...ids };
    Object.defineProperty(withGetter, "current", {
      get: () => [{ type: "object_number", value: "2026.015", primary: true }],
      enumerable: true,
    });
    expect(codes(identifierFieldIssues(r, TPL, withGetter))).toEqual(["invalid_identifiers"]);
    expect(codes(identifierFieldIssues(r, TPL, { ...ids, current: "2026.015" }))).toEqual([
      "invalid_identifiers",
    ]);
    expect(codes(identifierFieldIssues(r, TPL, null))).toEqual(["mixed_organizations"]);
    expect(codes(identifierFieldIssues(new Proxy(r, {}), TPL, ids))).toEqual(["invalid_record"]);
    expect(codes(identifierFieldIssues({ ...r, id: "x" }, TPL, ids))).toEqual(["invalid_record"]);
    expect(codes(identifierFieldIssues(r, { ...TPL, fields: "x" }, ids))).not.toEqual([]);
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(() => identifierFieldIssues(throwing, throwing, throwing)).not.toThrow();
  });

  it("isn't fooled by a polluted Object.prototype", () => {
    const r = object({ object_number: { value: "2026.015" } });
    const ids = identifiersOf(r, [{ type: "object_number", value: "2026.015", primary: true }]);
    const proto = Object.prototype as Record<string, unknown>;
    proto.type = "object_number";
    try {
      expect(codes(identifierFieldIssues(r, TPL, ids))).toContain("identifier_not_held");
    } finally {
      delete proto.type;
    }
  });

  it("refuses a field naming a number of the right type the record doesn't hold", () => {
    const r = object({ object_number: { type: "object_number", value: "2026.015" } });
    const ids = identifiersOf(r, [{ type: "object_number", value: "2026.099", primary: true }]);
    expect(codes(identifierFieldIssues(r, TPL, ids))).toEqual(["identifier_not_held"]);
  });
});
