// Attack tests for S-010 (D-054): a public view kept from earlier, published
// after the catalog changed, without the records and templates as they are
// now. Before D-054 `records` and `templateFor` were optional, and each of
// these published a value that was no longer public.
import { describe, expect, it } from "vitest";
import {
  effectiveRecord,
  publicOutput,
  publicView,
  type CatalogRecord,
  type FieldTemplate,
  type PublicOutput,
  type PublicRecord,
  type Validated,
} from "./index.js";
import {
  accessionsFor,
  BASE,
  CHECKERS,
  CNE,
  ORG,
  RIGHTS_ENTRY,
  TPL,
  noAccessions,
  record,
  template,
} from "./public-output.fixtures.js";

const CREATOR_MAP = {
  organizationId: ORG,
  template: "out",
  entries: [RIGHTS_ENTRY, { field: "creator", term: "creator" }],
};

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

/** `creator` made staff in a copy of `TPL` with key `key`. */
function staffCreator(key = "out"): FieldTemplate {
  return template(
    TPL.fields.map((f) => (f.key === "creator" ? { ...f, visibility: "staff" as const } : f)),
    key,
  );
}

function keep(
  id: CatalogRecord["id"],
  records: readonly CatalogRecord[],
  lookup: (r: CatalogRecord) => FieldTemplate,
) {
  const built = effectiveRecord(id, records, lookup);
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  const view = publicView(built.value);
  if (view === undefined) throw new Error("no view");
  return view;
}

function publish(view: PublicRecord, extra: object = {}): Validated<PublicOutput> {
  return publicOutput(view, CREATOR_MAP, {
    baseUrl: BASE,
    accessions: accessionsFor(view),
    published: [view.id],
    checkers: CHECKERS,
    ...extra,
  } as never);
}

/** Nothing is published, nothing private is quoted, and both missing options are named. */
function refusedWithoutNow(view: PublicRecord, secret: string): void {
  for (const extra of [{}, { records: undefined, templateFor: undefined }]) {
    const result = publish(view, extra);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["records_unknown", "templates_unknown"]);
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([
      ["records"],
      ["templateFor"],
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  }
}

describe("a kept view published without the catalog as it is now (S-010, D-054)", () => {
  it("refuses a value whose field was made staff after the view was kept", () => {
    let tpl = TPL;
    const item = record("archival_unit", "Item", {
      rights: { uri: CNE },
      creator: "SECRET-own-creator",
    });
    const view = keep(item.id, [item], () => tpl);
    expect(view.fields.creator).toBe("SECRET-own-creator");
    tpl = staffCreator();
    refusedWithoutNow(view, "SECRET");
    // Either one alone still refuses, naming the one that is missing.
    const recordsOnly = publish(view, { records: [item] });
    expect(codes(recordsOnly)).toEqual(["templates_unknown"]);
    expect(JSON.stringify(recordsOnly)).not.toContain("SECRET");
    const templatesOnly = publish(view, { templateFor: () => tpl });
    expect(codes(templatesOnly)).toEqual(["records_unknown"]);
    expect(JSON.stringify(templatesOnly)).not.toContain("SECRET");
    // With both, the change itself is caught.
    const now = publish(view, { records: [item], templateFor: () => tpl });
    expect(codes(now)).toEqual(["template_changed"]);
    expect(JSON.stringify(now)).not.toContain("SECRET");
  });

  it("refuses a value inherited from a parent whose template changed after the view was kept", () => {
    let fondsTemplate = template(TPL.fields, "fonds");
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "SECRET-parent-creator" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const lookup = (r: CatalogRecord) => (r.id === fonds.id ? fondsTemplate : TPL);
    const view = keep(item.id, [item, fonds], lookup);
    expect(view.fields.creator).toBe("SECRET-parent-creator");
    fondsTemplate = staffCreator("fonds");
    refusedWithoutNow(view, "SECRET");
    const now = publish(view, { records: [item, fonds], templateFor: lookup });
    expect(codes(now)).toEqual(["template_changed"]);
    expect(now.ok ? [] : now.issues[0]?.path).toEqual(["templateFor", fonds.id]);
  });

  it("refuses a value inherited from a parent the record was moved away from", () => {
    const fonds = record(
      "archival_unit",
      "Donor family papers",
      { rights: { uri: CNE }, creator: "SECRET-old-parent" },
      { level: "fonds" },
    );
    const other = record(
      "archival_unit",
      "Other fonds",
      { rights: { uri: CNE }, creator: "Other creator" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const view = keep(item.id, [item, fonds, other], () => TPL);
    expect(view.fields.creator).toBe("SECRET-old-parent");
    const moved = { ...item, parentId: other.id } as CatalogRecord;
    refusedWithoutNow(view, "SECRET");
    const now = publish(view, { records: [moved, fonds, other], templateFor: () => TPL });
    expect(codes(now)).toEqual(["record_changed"]);
    expect(now.ok ? [] : now.issues[0]?.path).toEqual(["records", item.id]);
    expect(JSON.stringify(now)).not.toContain("SECRET");
  });

  it("refuses a record deleted after the view was kept, and one whose parent was deleted", () => {
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "SECRET-deleted" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const view = keep(item.id, [item, fonds], () => TPL);
    refusedWithoutNow(view, "SECRET");
    for (const left of [[fonds], [item], []]) {
      const now = publish(view, { records: left, templateFor: () => TPL });
      expect(codes(now)).toEqual(["record_changed"]);
      expect(JSON.stringify(now)).not.toContain("SECRET");
    }
  });

  it("refuses records or templateFor given as null or the wrong kind of thing", () => {
    const item = record("archival_unit", "Item", { rights: { uri: CNE }, creator: "Public" });
    const view = keep(item.id, [item], () => TPL);
    expect(codes(publish(view, { records: null, templateFor: () => TPL }))).toEqual([
      "invalid_options",
    ]);
    expect(codes(publish(view, { records: [item], templateFor: null }))).toEqual([
      "invalid_options",
    ]);
  });

  it("publishes a view when the records and templates now are the ones it was made from", () => {
    const item = record("archival_unit", "Item", {
      rights: { uri: CNE },
      creator: "Public creator",
    });
    const view = keep(item.id, [item], () => TPL);
    const result = publish(view, { records: [item], templateFor: () => structuredClone(TPL) });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.dublinCore.creator).toEqual(["Public creator"]);
  });

  it("refuses a templateFor that now returns a Proxy or an invalid template", () => {
    const item = record("archival_unit", "Item", { rights: { uri: CNE }, creator: "SECRET-c" });
    const view = keep(item.id, [item], () => TPL);
    for (const given of [new Proxy(TPL, {}), { key: "out" }, { ...TPL, fields: "SECRET" }]) {
      const result = publish(view, { records: [item], templateFor: () => given });
      expect(codes(result)).toEqual(["template_changed"]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });

  it("refuses records that list the record twice", () => {
    const item = record("archival_unit", "Item", { rights: { uri: CNE }, creator: "SECRET-c" });
    const view = keep(item.id, [item], () => TPL);
    for (const twice of [
      [item, item],
      [item, { ...item, title: "SECRET-copy" }],
    ]) {
      const result = publish(view, { records: twice, templateFor: () => TPL });
      expect(codes(result)).toEqual(["record_changed"]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });

  it("reports records it can't use as invalid_options, before any deed check", () => {
    const object = record("object", "Vase", { rights: { uri: CNE } });
    const asset = record(
      "digital_asset",
      "Scan",
      { rights: { uri: CNE } },
      { represents: object.id },
    );
    const view = keep(asset.id, [asset, object], () => TPL);
    for (const records of [null, {}, "records", new Proxy([asset, object], {})]) {
      const result = publish(view, { records, templateFor: () => TPL });
      expect(codes(result)).toEqual(["invalid_options"]);
      expect(result.ok ? [] : result.issues[0]?.path).toEqual(["records"]);
    }
  });

  it("reads one snapshot of a records list: a templateFor that edits the list changes nothing", () => {
    const object = record("object", "Vase", { rights: { uri: CNE } });
    const asset = record(
      "digital_asset",
      "Scan",
      { rights: { uri: CNE } },
      { represents: object.id },
    );
    const view = keep(asset.id, [asset, object], () => TPL);
    const list: CatalogRecord[] = [asset, object];
    const editing = () => {
      // Drops what the asset represents once the ancestry has been checked.
      list.length = 1;
      return TPL;
    };
    const result = publicOutput(view, CREATOR_MAP, {
      baseUrl: BASE,
      accessions: noAccessions(ORG, [asset, object]),
      published: [view.id],
      checkers: CHECKERS,
      records: list,
      templateFor: editing,
    });
    expect(codes(result)).toEqual([]);
    expect(list).toHaveLength(1);
  });
});
