// Attacks on the arrangement checks: one organization's units must never be
// checked or listed together with another's (D-019, D-0XX).
import { describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  unfiledUnits,
  validateArrangement,
  type ArchivalUnitRecord,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";

function unit(title: string, organizationId: unknown = ORG): ArchivalUnitRecord {
  return {
    kind: "archival_unit",
    id: newRecordId(),
    title,
    level: "item",
    organizationId,
    createdAt: T,
    updatedAt: T,
    fields: {},
  } as ArchivalUnitRecord;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("units of two organizations can't be mixed", () => {
  const mine = unit("Own loose item");
  const theirs = unit("SECRET other organization's loose item", newOrganizationId());
  // An undefined argument would take the default, so the property is removed.
  const unowned = Object.fromEntries(
    Object.entries(unit("SECRET unowned loose item")).filter(([k]) => k !== "organizationId"),
  ) as unknown as ArchivalUnitRecord;
  const getter = Object.defineProperty({ ...mine, id: newRecordId() }, "organizationId", {
    get: () => ORG,
    enumerable: true,
  });

  it("unfiledUnits refuses a mixed set instead of listing the other organization's units", () => {
    expect(unfiledUnits([mine]).ok).toBe(true);
    for (const set of [
      [mine, theirs],
      [theirs, mine],
      [unowned, mine],
      [mine, unowned],
      [getter, mine],
    ]) {
      const r = unfiledUnits(set);
      expect(codes(r)).toEqual(["mixed_organizations"]);
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });

  it("validateArrangement refuses a mixed set", () => {
    expect(validateArrangement([mine])).toEqual([]);
    for (const set of [
      [mine, theirs],
      [unowned, mine],
    ]) {
      const issues = validateArrangement(set);
      expect(issues.map((i) => i.code)).toEqual(["mixed_organizations"]);
      expect(JSON.stringify(issues)).not.toContain("SECRET");
    }
  });
});
