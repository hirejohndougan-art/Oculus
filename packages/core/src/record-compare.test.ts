// Comparing two versions of one record (record-compare.ts, T-030, D-065).
import { describe, expect, it } from "vitest";
import {
  INHERITANCE_INERT_PROPERTIES,
  RECORD_KINDS,
  RECORD_PROPERTIES,
  changesInheritance,
  compareRecords,
  newOrganizationId,
  newRecordId,
  newSiteId,
  sameJson,
  validateRecord,
  type RecordKind,
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

describe("changesInheritance (S-028)", () => {
  // Every top-level property a record can have, and whether changing it can
  // change what a record below inherits (or who can see where a value comes
  // from). A property added to records fails the first test until it is
  // classified here and, if inert, in INHERITANCE_INERT_PROPERTIES.
  const CLASSIFIED: Readonly<Record<string, boolean>> = {
    id: true, // another record: not comparable, so a change
    organizationId: true, // likewise
    kind: true,
    siteId: true, // changes who can see the record
    templateKey: true, // decides what is inherited, what stops it, visibility
    fields: true, // every key's presence and value
    parentId: true,
    level: true, // the chain's levels decide whether it can be trusted
    represents: true,
    title: false, // chain steps and staff messages only
    recordTypeKey: false, // the template is found from templateKey only
    mediaType: false,
    agentType: false,
    coordinates: false,
    createdAt: false, // never compared: never changes
    updatedAt: false, // never compared: the writer's clock
  };

  const SITE = newSiteId();
  const OTHER = newRecordId();
  const samples: Record<RecordKind, Record<string, unknown>> = {
    object: {},
    event: {},
    archival_unit: { level: "series", parentId: newRecordId() },
    digital_asset: { mediaType: "image/tiff", represents: newRecordId() },
    agent: { agentType: "person" },
    place: { coordinates: { lat: 29.46, lng: -95.05 } },
  };
  const sample = (kind: RecordKind): Record<string, unknown> => ({
    id: ID,
    organizationId: ORG,
    siteId: SITE,
    kind,
    title: "Invented record",
    templateKey: "invented-template",
    recordTypeKey: "invented-type",
    createdAt: T,
    updatedAt: T,
    fields: { provenance: "Invented provenance.", extent: { value: 2, unit: "boxes" } },
    ...samples[kind],
  });
  /** Another valid value for `property` of a record of `kind`. */
  const changed = (kind: RecordKind, property: string): unknown =>
    ({
      id: OTHER,
      organizationId: newOrganizationId(),
      siteId: newSiteId(),
      kind: kind === "object" ? "event" : "object",
      title: "Invented record, renamed",
      templateKey: "other-template",
      recordTypeKey: "other-type",
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: LATER,
      fields: { provenance: "Another provenance.", extent: { value: 2, unit: "boxes" } },
      level: "fonds",
      parentId: newRecordId(),
      mediaType: "image/jpeg",
      represents: newRecordId(),
      agentType: "family",
      coordinates: { lat: 29.3, lng: -94.8 },
    })[property];

  it("classifies every property a record of any kind can have", () => {
    const all = new Set(Object.values(RECORD_PROPERTIES).flat());
    expect([...all].sort()).toEqual(Object.keys(CLASSIFIED).sort());
    for (const kind of RECORD_KINDS) {
      expect(validateRecord(sample(kind)).ok).toBe(true);
      expect(Object.keys(sample(kind)).sort()).toEqual([...RECORD_PROPERTIES[kind]].sort());
    }
    // The inert list is exactly the properties classified as unable to change inheritance
    // (createdAt and updatedAt are never compared at all).
    expect([...INHERITANCE_INERT_PROPERTIES].sort()).toEqual(
      Object.entries(CLASSIFIED)
        .filter(([p, v]) => !v && p !== "createdAt" && p !== "updatedAt")
        .map(([p]) => p)
        .sort(),
    );
  });

  it("is a change exactly for the properties that can change inheritance, for every kind, set, changed or removed", () => {
    for (const kind of RECORD_KINDS) {
      const before = sample(kind);
      for (const property of RECORD_PROPERTIES[kind]) {
        const expected = CLASSIFIED[property];
        const after = { ...before, [property]: changed(kind, property) };
        expect([kind, property, changesInheritance(before, after)]).toEqual([
          kind,
          property,
          expected,
        ]);
        // Removed (for the optional ones: the record stays valid without it).
        const without = Object.fromEntries(
          Object.entries(before).filter(([key]) => key !== property),
        );
        if (validateRecord(without).ok) {
          expect([kind, property, "removed", changesInheritance(before, without)]).toEqual([
            kind,
            property,
            "removed",
            expected,
          ]);
          expect([kind, property, "added", changesInheritance(without, before)]).toEqual([
            kind,
            property,
            "added",
            expected,
          ]);
        }
      }
    }
  });

  it("counts every field's presence and value, but not key order or an unchanged value", () => {
    const before = sample("archival_unit");
    const fields = before.fields as Record<string, unknown>;
    const withFields = (f: Record<string, unknown>) => ({ ...before, fields: f });
    expect(changesInheritance(before, before)).toBe(false);
    expect(
      changesInheritance(
        before,
        withFields({ extent: { unit: "boxes", value: 2 }, provenance: "Invented provenance." }),
      ),
    ).toBe(false);
    // A title and a type changed together with nothing else: still no change.
    expect(
      changesInheritance(before, { ...before, title: "Renamed", recordTypeKey: "other-type" }),
    ).toBe(false);
    expect(changesInheritance(before, withFields({ ...fields, note: "A new field." }))).toBe(true);
    const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "provenance"));
    expect(changesInheritance(before, withFields(rest))).toBe(true);
    expect(
      changesInheritance(before, withFields({ ...fields, extent: { value: 3, unit: "boxes" } })),
    ).toBe(true);
    // A title change with any other change is a change.
    expect(
      changesInheritance(before, { ...before, title: "Renamed", fields: { ...fields, note: "x" } }),
    ).toBe(true);
  });

  it("counts anything it can't compare as a change", () => {
    const before = sample("object");
    expect(changesInheritance(before, { ...before, title: "" })).toBe(true);
    expect(changesInheritance(undefined, before)).toBe(true);
    expect(changesInheritance(before, { ...before, unknownProperty: 1 })).toBe(true);
  });
});
