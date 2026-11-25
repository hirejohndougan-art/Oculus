// Roles and permissions (permissions.ts, T-041, D-072) and System settings
// (system-settings.ts).
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLES,
  CATALOG_PERMISSIONS,
  ORGANIZATION_PERMISSIONS,
  ROLE_PERMISSIONS,
  SITE_PERMISSIONS,
  SYSTEM_PERMISSIONS,
  hasScopedGrants,
  worksOnSite,
  holdsAnywhere,
  holdsForWholeCatalog,
  isBuiltInRole,
  isPermission,
  permits,
  type Access,
  type BuiltInRole,
  type RoleGrant,
} from "./permissions.js";
import { DEFAULT_SYSTEM_SETTINGS, validateSystemSettings } from "./system-settings.js";
import { newOrganizationId, newSiteId } from "./organizations.js";
import { newRecordId } from "./record-id.js";

const org = newOrganizationId();
const siteA = newSiteId();
const siteB = newSiteId();
const fonds = newRecordId();
const series = newRecordId();

function access(grants: RoleGrant[], systemManager = false): Access {
  return { organizationId: org, systemManager, grants };
}
const g = (
  role: BuiltInRole,
  siteId: RoleGrant["siteId"] = siteA,
  scope: RoleGrant["scope"] = null,
) => ({
  role,
  siteId,
  scope,
});

describe("the built-in roles", () => {
  it("hold exactly the permissions D-072 lists", () => {
    // Written out, not derived, so a change to the table shows up here.
    expect(ROLE_PERMISSIONS).toEqual({
      site_manager: [
        "records.view",
        "records.create",
        "records.edit",
        "records.delete",
        "records.history",
        "records.publish",
        "media.attach",
        "donors.view",
        "donors.edit",
        "site.settings",
        "site.people",
      ],
      cataloger: [
        "records.view",
        "records.create",
        "records.edit",
        "records.history",
        "media.attach",
      ],
      reviewer: [
        "records.view",
        "records.create",
        "records.edit",
        "records.history",
        "records.publish",
        "media.attach",
      ],
      read_only: ["records.view"],
      scanner: ["records.view", "media.attach"],
      donor_relations: ["donors.view", "donors.edit"],
    });
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...BUILT_IN_ROLES].sort());
  });

  it("no role holds a system permission, and the table can't be changed", () => {
    for (const role of BUILT_IN_ROLES) {
      for (const p of SYSTEM_PERMISSIONS) {
        expect((ROLE_PERMISSIONS[role] as readonly string[]).includes(p)).toBe(false);
      }
      expect(Object.isFrozen(ROLE_PERMISSIONS[role])).toBe(true);
    }
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(() => {
      (ROLE_PERMISSIONS.read_only as string[]).push("records.delete");
    }).toThrow();
  });

  it("knows its roles and permissions, and nothing else", () => {
    expect(isBuiltInRole("cataloger")).toBe(true);
    expect(isBuiltInRole("system_manager")).toBe(false);
    expect(isBuiltInRole("toString")).toBe(false);
    for (const p of [
      ...CATALOG_PERMISSIONS,
      ...ORGANIZATION_PERMISSIONS,
      ...SITE_PERMISSIONS,
      ...SYSTEM_PERMISSIONS,
    ]) {
      expect(isPermission(p)).toBe(true);
    }
    expect(isPermission("records.*")).toBe(false);
  });
});

describe("permits", () => {
  it("a system manager may do everything; nobody else holds a system permission", () => {
    const root = access([], true);
    for (const p of SYSTEM_PERMISSIONS) {
      expect(permits(root, p, { on: "organization" })).toBe(true);
      expect(permits(access([g("site_manager", null)]), p, { on: "organization" })).toBe(false);
    }
    expect(permits(root, "records.delete", { on: "catalog", site: siteA })).toBe(true);
    // Items on no site (D-074): system managers only.
    expect(permits(root, "records.view", { on: "catalog", site: null })).toBe(true);
    expect(
      permits(access([g("site_manager", null)]), "records.view", { on: "catalog", site: null }),
    ).toBe(false);
  });

  it("site permissions count only on that site, or with a grant on every site", () => {
    const one = access([g("site_manager", siteA)]);
    expect(permits(one, "site.people", { on: "site", siteId: siteA })).toBe(true);
    expect(permits(one, "site.people", { on: "site", siteId: siteB })).toBe(false);
    expect(permits(one, "site.people", { on: "catalog", site: siteA })).toBe(false);
    const every = access([g("site_manager", null)]);
    expect(permits(every, "site.settings", { on: "site", siteId: siteB })).toBe(true);
    expect(
      permits(access([g("cataloger", null)]), "site.people", { on: "site", siteId: siteA }),
    ).toBe(false);
  });

  it("catalog permissions reach the items of the grant's site (or every site); scoped ones only their units there", () => {
    const whole = access([g("cataloger", siteB)]);
    expect(permits(whole, "records.edit", { on: "catalog", site: siteB })).toBe(true);
    expect(
      permits(whole, "records.edit", { on: "units", units: new Set([series]), site: siteB }),
    ).toBe(true);
    expect(permits(whole, "records.delete", { on: "catalog", site: siteB })).toBe(false);
    // Another site's items, and items on no site, are out of reach (D-074).
    expect(permits(whole, "records.view", { on: "catalog", site: siteA })).toBe(false);
    expect(permits(whole, "records.view", { on: "catalog", site: null })).toBe(false);
    // Shared into the grant's site (T-041b): viewable there, never changed.
    const shared = { on: "catalog", site: siteA, sharedInto: new Set([siteB]) } as const;
    expect(permits(whole, "records.view", shared)).toBe(true);
    expect(permits(whole, "records.edit", shared)).toBe(false);
    const every = access([g("cataloger", null)]);
    expect(permits(every, "records.edit", { on: "catalog", site: siteA })).toBe(true);
    expect(permits(every, "records.edit", { on: "catalog", site: siteB })).toBe(true);
    expect(permits(every, "records.edit", { on: "catalog", site: null })).toBe(false);
    const scoped = access([g("cataloger", siteA, fonds)]);
    expect(
      permits(scoped, "records.edit", {
        on: "units",
        units: new Set([series, fonds]),
        site: siteA,
      }),
    ).toBe(true);
    expect(
      permits(scoped, "records.edit", {
        on: "units",
        units: new Set([series, fonds]),
        site: siteB,
      }),
    ).toBe(false);
    expect(
      permits(scoped, "records.edit", { on: "units", units: new Set([series]), site: siteA }),
    ).toBe(false);
    expect(permits(scoped, "records.edit", { on: "units", units: new Set(), site: siteA })).toBe(
      false,
    );
    expect(permits(scoped, "records.edit", { on: "catalog", site: siteA })).toBe(false);
    expect(holdsForWholeCatalog(scoped, "records.view", siteA)).toBe(false);
    expect(holdsForWholeCatalog(whole, "records.view", siteB)).toBe(true);
    expect(worksOnSite(whole, siteB)).toBe(true);
    expect(worksOnSite(whole, siteA)).toBe(false);
    expect(worksOnSite(every, siteA)).toBe(true);
    expect(worksOnSite(access([], true), siteA)).toBe(true);
    expect(holdsAnywhere(scoped, "records.edit")).toBe(true);
    expect(holdsAnywhere(scoped, "records.publish")).toBe(false);
    expect(hasScopedGrants(scoped)).toBe(true);
    expect(hasScopedGrants(whole)).toBe(false);
    expect(hasScopedGrants(access([g("cataloger", siteA, fonds)], true))).toBe(false);
  });

  it("definitions are system managers' only (John, 2026-11-24, D-072)", () => {
    expect(
      permits(access([g("site_manager")]), "catalog.definitions", { on: "organization" }),
    ).toBe(false);
    expect(
      permits(access([g("site_manager", null)]), "catalog.definitions", { on: "organization" }),
    ).toBe(false);
    expect(permits(access([], true), "catalog.definitions", { on: "organization" })).toBe(true);
    expect(permits(access([g("cataloger")]), "catalog.definitions", { on: "organization" })).toBe(
      false,
    );
  });

  it("a grant of an unknown role grants nothing", () => {
    const odd = access([{ role: "curator" as BuiltInRole, siteId: null, scope: null }]);
    expect(permits(odd, "records.view", { on: "catalog", site: siteA })).toBe(false);
    expect(holdsAnywhere(odd, "records.view")).toBe(false);
  });
});

describe("System settings", () => {
  it("accepts the defaults and values within bounds", () => {
    expect(validateSystemSettings({ ...DEFAULT_SYSTEM_SETTINGS })).toEqual({
      ok: true,
      value: DEFAULT_SYSTEM_SETTINGS,
    });
    const v = validateSystemSettings({ sessionIdleMinutes: 5, sessionAbsoluteMinutes: 1440 });
    expect(v.ok && Object.isFrozen(v.value)).toBe(true);
  });

  it("default to 30 minutes unused (John, Q-8; T-062, D-098), from 5 to 720", () => {
    expect(DEFAULT_SYSTEM_SETTINGS.sessionIdleMinutes).toBe(30);
    const idle = (minutes: number) =>
      validateSystemSettings({ sessionIdleMinutes: minutes, sessionAbsoluteMinutes: 720 }).ok;
    expect([4, 5, 30, 720, 721].map(idle)).toEqual([false, true, true, true, false]);
  });

  it("refuses missing, unknown, out-of-range, fractional and inconsistent values", () => {
    const code = (input: unknown) => {
      const r = validateSystemSettings(input);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(code({ sessionIdleMinutes: 30 })).toEqual(["invalid_setting"]);
    expect(code({ ...DEFAULT_SYSTEM_SETTINGS, smtpHost: "x" })).toEqual(["unknown_setting"]);
    expect(code({ sessionIdleMinutes: 4, sessionAbsoluteMinutes: 60 })).toEqual([
      "invalid_setting",
    ]);
    expect(code({ sessionIdleMinutes: 30.5, sessionAbsoluteMinutes: 60 })).toEqual([
      "invalid_setting",
    ]);
    expect(code({ sessionIdleMinutes: 30, sessionAbsoluteMinutes: 1441 })).toEqual([
      "invalid_setting",
    ]);
    expect(code({ sessionIdleMinutes: 120, sessionAbsoluteMinutes: 60 })).toEqual([
      "idle_longer_than_absolute",
    ]);
    expect(code([])).toEqual(["not_an_object"]);
    expect(code(new Proxy({ ...DEFAULT_SYSTEM_SETTINGS }, {}))).toEqual(["not_an_object"]);
    let reads = 0;
    const getter = {
      get sessionIdleMinutes() {
        reads += 1;
        return 30;
      },
      sessionAbsoluteMinutes: 60,
    };
    expect(code(getter)).toEqual(["invalid_setting"]);
    expect(reads).toBe(0);
  });
});
