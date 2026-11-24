// Comparing two versions of one record (record-compare.ts, T-030, D-065).
import { describe, expect, it } from "vitest";
import {
  compareRecords,
  newOrganizationId,
  newRecordId,
  sameJson,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const ID = newRecordId();
const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:30:00.250Z";

function unit(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    organizationId: ORG,
    kind: "archival_unit",
    level: "file",
    title: "Invented correspondence",
    templateKey: "dacs-archival-unit",
    createdAt: T,
    updatedAt: T,
    fields: { scope: "Letters.", dates: ["1900", "1901"], extent: { value: 2, unit: "boxes" } },
    ...extra,
  };
}

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("compareRecords", () => {
  it("finds nothing between a record and itself, or a copy with keys in another order or a new updatedAt", () => {
    expect(ok(compareRecords(unit(), unit())).differences).toEqual([]);
    const reordered = unit({
      fields: { extent: { unit: "boxes", value: 2 }, dates: ["1900", "1901"], scope: "Letters." },
      updatedAt: LATER,
    });
    expect(ok(compareRecords(unit(), reordered)).differences).toEqual([]);
  });

  it("lists added, removed and changed fields and properties, sorted as the database names them", () => {
    const parent = newRecordId();
    const after = unit({
      title: "Invented letters",
      templateKey: "other-template",
      parentId: parent,
      fields: { scope: "Letters.", dates: ["1901", "1900"], note: "New." },
    });
    expect(ok(compareRecords(unit(), after)).differences).toEqual([
      {
        name: "fields.dates",
        change: "changed",
        before: ["1900", "1901"],
        after: ["1901", "1900"],
      },
      { name: "fields.extent", change: "removed", before: { value: 2, unit: "boxes" } },
      { name: "fields.note", change: "added", after: "New." },
      { name: "parentId", change: "added", after: parent },
      {
        name: "templateKey",
        change: "changed",
        before: "dacs-archival-unit",
        after: "other-template",
      },
      {
        name: "title",
        change: "changed",
        before: "Invented correspondence",
        after: "Invented letters",
      },
    ]);
    // And back again: every change reversed.
    const back = ok(compareRecords(after, unit())).differences;
    expect(back.map((d) => [d.name, d.change])).toEqual([
      ["fields.dates", "changed"],
      ["fields.extent", "added"],
      ["fields.note", "removed"],
      ["parentId", "removed"],
      ["templateKey", "changed"],
      ["title", "changed"],
    ]);
  });

  it("reports a change of kind or level like any other property", () => {
    const object = {
      id: ID,
      organizationId: ORG,
      kind: "object",
      title: "Invented correspondence",
      templateKey: "dacs-archival-unit",
      createdAt: T,
      updatedAt: T,
      fields: unit().fields,
    };
    expect(ok(compareRecords(unit(), object)).differences.map((d) => d.name)).toEqual([
      "kind",
      "level",
    ]);
  });

  it("never compares two records, or two organizations' copies", () => {
    expect(codes(compareRecords(unit(), unit({ id: newRecordId() })))).toEqual([
      "different_records",
    ]);
    expect(codes(compareRecords(unit(), unit({ organizationId: newOrganizationId() })))).toEqual([
      "mixed_organizations",
    ]);
  });

  it("refuses an invalid record with its issues under before or after", () => {
    const result = compareRecords(unit({ title: "" }), { nonsense: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(1);
    expect(result.issues[0]?.path[0]).toBe("before");
    expect(result.issues.some((i) => i.path[0] === "after")).toBe(true);
  });

  it("returns frozen results", () => {
    const result = ok(compareRecords(unit(), unit({ title: "Other" })));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.differences)).toBe(true);
    expect(Object.isFrozen(result.differences[0])).toBe(true);
  });
});

describe("sameJson", () => {
  it("compares JSON data, not key order", () => {
    expect(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([1], { 0: 1 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson("1", 1)).toBe(false);
    expect(sameJson({}, {})).toBe(true);
  });
});
