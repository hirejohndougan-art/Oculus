import { describe, expect, it } from "vitest";
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_SITE_NAME_LENGTH,
  isOrganizationId,
  isSiteId,
  newOrganizationId,
  newRecordId,
  newSiteId,
  parseOrganizationId,
  parseSiteId,
  validateOrganization,
  validateSite,
  type Organization,
  type Validated,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

// Invented organizations, after D-019's example of an archive that hosts a library.
const ARCHIVE: Organization = { id: newOrganizationId(), name: "Invented Historical Society" };
const LIBRARY: Organization = { id: newOrganizationId(), name: "Invented Public Library" };
const ORGS = [ARCHIVE, LIBRARY];

describe("organization and site IDs", () => {
  it("are fresh lowercase version 4 UUIDs", () => {
    const a = newOrganizationId();
    expect(isOrganizationId(a)).toBe(true);
    expect(a).not.toBe(newOrganizationId());
    expect(isSiteId(newSiteId())).toBe(true);
    // A record ID has the same form; the branded types keep them apart in code.
    expect(isOrganizationId(newRecordId())).toBe(true);
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "x",
      5,
      null,
      undefined,
      {},
      `${newOrganizationId()} `,
      "A".repeat(36),
    ]) {
      expect(isOrganizationId(bad)).toBe(false);
      expect(isSiteId(bad)).toBe(false);
    }
    expect(isOrganizationId(newOrganizationId().toUpperCase())).toBe(false);
  });

  it("parse trims and lower-cases what people copy by hand, and nothing more", () => {
    const id = newOrganizationId();
    expect(parseOrganizationId(`  ${id.toUpperCase()} `)).toBe(id);
    expect(parseSiteId(` ${id} `)).toBe(id);
    expect(parseOrganizationId(`${id}x`)).toBeUndefined();
    expect(parseOrganizationId(7)).toBeUndefined();
    expect(parseSiteId(null)).toBeUndefined();
  });
});

describe("validateOrganization", () => {
  it("accepts an ID and a name and returns a frozen copy", () => {
    const input = { ...ARCHIVE };
    const r = validateOrganization(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(ARCHIVE);
    expect(r.value).not.toBe(input);
    expect(Object.isFrozen(r.value)).toBe(true);
    input.name = "Changed";
    expect(r.value.name).toBe(ARCHIVE.name);
  });

  it("checks the ID and the name", () => {
    expect(codes(validateOrganization({ id: "x", name: "A" }))).toEqual(["invalid_id"]);
    expect(codes(validateOrganization({ id: ARCHIVE.id }))).toEqual(["required"]);
    expect(codes(validateOrganization({ id: ARCHIVE.id, name: "   " }))).toEqual(["required"]);
    expect(codes(validateOrganization({ id: ARCHIVE.id, name: " A" }))).toEqual(["untrimmed"]);
    expect(codes(validateOrganization({ id: ARCHIVE.id, name: "A\nB" }))).toEqual([
      "control_characters",
    ]);
    expect(
      codes(
        validateOrganization({
          id: ARCHIVE.id,
          name: "A".repeat(MAX_ORGANIZATION_NAME_LENGTH + 1),
        }),
      ),
    ).toEqual(["too_long"]);
    expect(codes(validateOrganization({ id: ARCHIVE.id, name: "A‮B" }))).toEqual([
      "bad_characters",
    ]);
  });

  it("refuses unknown properties, non-objects and Proxies, and never throws", () => {
    expect(codes(validateOrganization({ ...ARCHIVE, sites: [] }))).toEqual(["unknown_property"]);
    for (const bad of [null, 5, "x", [], new Proxy({ ...ARCHIVE }, {})]) {
      expect(codes(validateOrganization(bad))).toEqual(["not_an_object"]);
    }
    const getter = {
      id: ARCHIVE.id,
      get name(): string {
        throw new Error("boom");
      },
    };
    expect(validateOrganization(getter).ok).toBe(false);
  });
});

describe("validateSite", () => {
  const site = { id: newSiteId(), organizationId: LIBRARY.id, name: "Invented Library" };

  it("accepts a site that belongs to one of the install's organizations", () => {
    const r = validateSite(site, ORGS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(site);
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });

  it("refuses a site with no organization, or one the install doesn't have", () => {
    const orphan = { id: site.id, name: site.name };
    expect(codes(validateSite(orphan, ORGS))).toEqual(["invalid_organization"]);
    expect(codes(validateSite({ ...site, organizationId: "library" }, ORGS))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(validateSite({ ...site, organizationId: newOrganizationId() }, ORGS))).toEqual([
      "unknown_organization",
    ]);
    expect(codes(validateSite(site, []))).toEqual(["unknown_organization"]);
    expect(codes(validateSite(site, [ARCHIVE]))).toEqual(["unknown_organization"]);
  });

  it("doesn't run getters or Proxies in the organizations list", () => {
    let ran = false;
    const sneaky = {
      get id(): string {
        ran = true;
        return LIBRARY.id;
      },
      name: "x",
    };
    expect(codes(validateSite(site, [sneaky as unknown as Organization]))).toEqual([
      "unknown_organization",
    ]);
    expect(codes(validateSite(site, new Proxy([LIBRARY], {})))).toEqual(["unknown_organization"]);
    expect(ran).toBe(false);
  });

  it("checks the ID, the name and unknown properties", () => {
    expect(codes(validateSite({ ...site, id: "x" }, ORGS))).toEqual(["invalid_id"]);
    expect(codes(validateSite({ ...site, name: "" }, ORGS))).toEqual(["required"]);
    expect(
      codes(validateSite({ ...site, name: "A".repeat(MAX_SITE_NAME_LENGTH + 1) }, ORGS)),
    ).toEqual(["too_long"]);
    expect(codes(validateSite({ ...site, password: "x" }, ORGS))).toEqual(["unknown_property"]);
    expect(codes(validateSite(null, ORGS))).toEqual(["not_an_object"]);
  });
});
