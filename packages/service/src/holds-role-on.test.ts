import { describe, expect, it } from "vitest";
import type { SiteId } from "@oculus/core";
import { holdsRoleOn } from "./admin.js";

// T-064 and S-042: whether a site manager sees a member in full.
const A1 = "00000000-0000-4000-8000-0000000000a1" as SiteId;
const A2 = "00000000-0000-4000-8000-0000000000a2" as SiteId;
const UNIT = "00000000-0000-4000-8000-00000000000f";

describe("holdsRoleOn", () => {
  it("counts a role on a managed site, and only those, for a manager of some sites", () => {
    expect(holdsRoleOn([{ siteId: A1, scope: null }], new Set([A1]))).toBe(true);
    expect(holdsRoleOn([{ siteId: A1, scope: UNIT }], new Set([A1]))).toBe(true);
    expect(holdsRoleOn([{ siteId: A2, scope: null }], new Set([A1]))).toBe(false);
    expect(holdsRoleOn([], new Set([A1]))).toBe(false);
  });

  it("counts a whole-catalog role on every site, which includes the manager's site (S-042)", () => {
    expect(holdsRoleOn([{ siteId: null, scope: null }], new Set([A1]))).toBe(true);
    expect(holdsRoleOn([{ siteId: null, scope: null }], "all")).toBe(true);
  });

  it("doesn't count a role on every site scoped to one unit (that unit's site only)", () => {
    expect(holdsRoleOn([{ siteId: null, scope: UNIT }], new Set([A1]))).toBe(false);
    expect(holdsRoleOn([{ siteId: null, scope: UNIT }], "all")).toBe(false);
  });

  it("a manager of every site counts any site's role", () => {
    expect(holdsRoleOn([{ siteId: A2, scope: null }], "all")).toBe(true);
  });

  it("no managed site sees no one, whatever the roles", () => {
    expect(holdsRoleOn([{ siteId: null, scope: null }], new Set())).toBe(false);
    expect(holdsRoleOn([{ siteId: A1, scope: null }], new Set())).toBe(false);
  });
});
