import { describe, expect, it } from "vitest";
import {
  MAX_ARRANGEMENT_DEPTH,
  MAX_RECORD_SET,
  canPublishRights,
  effectivePublishIssues,
  effectiveRecord,
  publicView,
  indexRecords,
  newRecordId,
  rightsPublishIssues,
  type ArchivalLevel,
  type ArchivalUnitRecord,
  type CatalogRecord,
  type EffectiveRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldValue,
  type RecordId,
  type TemplateLookup,
} from "./index.js";

const T = "2026-11-20T16:05:00.000Z";
const CNE = { uri: "http://rightsstatements.org/vocab/CNE/1.0/" };
const INC = { uri: "http://rightsstatements.org/vocab/InC/1.0/" };

function unit(
  title: string,
  level: ArchivalLevel,
  parent?: { readonly id: RecordId },
  fields: Readonly<Record<string, FieldValue>> = {},
  id: RecordId = newRecordId(),
): ArchivalUnitRecord {
  return {
    kind: "archival_unit",
    id,
    title,
    level,
    createdAt: T,
    updatedAt: T,
    fields,
    ...(parent === undefined ? {} : { parentId: parent.id }),
  };
}

type Def = Partial<FieldDefinition> & Pick<FieldDefinition, "key">;

function field(def: Def): FieldDefinition {
  return {
    label: def.key.replace(/_/g, " "),
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    ...def,
  };
}

function template(fields: readonly FieldDefinition[], key = "archive"): FieldTemplate {
  return { key, label: key, appliesTo: ["archival_unit", "object"], fields };
}

/** The template most tests use: the mockup's fields. */
const ARCHIVE = template([
  field({ key: "rights", label: "Rights", kind: "rights" }),
  field({ key: "creator", label: "Creator" }),
  field({
    key: "access",
    label: "Access",
    kind: "list",
    options: [
      { value: "public", label: "Public" },
      { value: "by_request", label: "By request" },
    ],
  }),
  field({ key: "type", label: "Type" }),
  field({ key: "date", label: "Date", kind: "date", inherited: false }),
  field({ key: "credit_line", label: "Credit line" }),
  field({
    key: "subjects",
    label: "Subjects",
    kind: "controlled_term",
    repeatable: true,
  }),
  field({ key: "donor_note", label: "Donor note", visibility: "staff" }),
]);

const all =
  (t: FieldTemplate): TemplateLookup =>
  () =>
    t;

function ok(result: ReturnType<typeof effectiveRecord>): EffectiveRecord {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function code(result: ReturnType<typeof effectiveRecord>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

function entry(effective: EffectiveRecord, key: string) {
  return effective.entries.find((e) => e.key === key);
}

/** Fonds F1 › Series S1 › Collection › item, as on the Effective Record screen. */
function mockupTree() {
  const fonds = unit("Fonds F1", "fonds", undefined, {
    rights: CNE,
    creator: "Dickinson Historical Society",
    credit_line: "Courtesy of the Dickinson Historical Society",
  });
  const series = unit("Series S1", "series", fonds, { type: "Photographs" });
  const collection = unit("Historic Railroad Center", "collection", series, {
    access: "public",
  });
  const item = unit("Dickinson Station and Park", "item", collection, { date: "1909" });
  return { fonds, series, collection, item, records: [item, collection, fonds, series] };
}

describe("effectiveRecord: the mockup's Effective Record screen", () => {
  const { fonds, series, collection, item, records } = mockupTree();
  const effective = ok(effectiveRecord(item.id, records, all(ARCHIVE)));

  it("inherits each field from the unit that sets it", () => {
    expect(effective.fields).toEqual({
      rights: CNE,
      creator: "Dickinson Historical Society",
      access: "public",
      type: "Photographs",
      date: "1909",
      credit_line: "Courtesy of the Dickinson Historical Society",
    });
    expect(entry(effective, "rights")?.from.id).toBe(fonds.id);
    expect(entry(effective, "creator")?.from.title).toBe("Fonds F1");
    expect(entry(effective, "type")?.from.id).toBe(series.id);
    expect(entry(effective, "access")?.from).toEqual({
      id: collection.id,
      kind: "archival_unit",
      title: "Historic Railroad Center",
      level: "collection",
    });
  });

  it("marks the record's own values as own, coming from the record itself", () => {
    const date = entry(effective, "date");
    expect(date?.own).toBe(true);
    expect(date?.from.id).toBe(item.id);
    expect(entry(effective, "rights")?.own).toBe(false);
  });

  it("lists the entries in template order, with labels and visibility", () => {
    expect(effective.entries.map((e) => [e.key, e.label, e.visibility])).toEqual([
      ["rights", "Rights", "public"],
      ["creator", "Creator", "public"],
      ["access", "Access", "public"],
      ["type", "Type", "public"],
      ["date", "Date", "public"],
      ["credit_line", "Credit line", "public"],
    ]);
  });

  it("gives the chain from the top down, ending with the record", () => {
    expect(effective.chain.map((s) => [s.title, s.level])).toEqual([
      ["Fonds F1", "fonds"],
      ["Series S1", "series"],
      ["Historic Railroad Center", "collection"],
      ["Dickinson Station and Park", "item"],
    ]);
    expect(entry(effective, "rights")?.from).toBe(effective.chain[0]);
  });

  it("keeps the record as stored, and its id, kind and title", () => {
    expect(effective.id).toBe(item.id);
    expect(effective.kind).toBe("archival_unit");
    expect(effective.title).toBe("Dickinson Station and Park");
    expect(effective.record).toEqual(item);
    expect(effective.record).not.toBe(item);
    expect(effective.notes).toEqual([]);
  });

  it("is what the rights publish check runs on, through effectivePublishIssues", () => {
    expect(rightsPublishIssues(item)[0]?.code).toBe("rights_missing");
    expect(effectivePublishIssues(effective)).toEqual([]);
    expect(canPublishRights(publicView(effective))).toBe(true);
    // rightsPublishIssues can't see the visibility rule, so it refuses the effective record.
    expect(rightsPublishIssues(effective)[0]?.code).toBe("use_effective_publish_issues");
    expect(canPublishRights(effective)).toBe(false);
  });

  it("works out the same for a unit higher up", () => {
    const top = ok(effectiveRecord(series.id, records, all(ARCHIVE)));
    expect(top.fields).toEqual({
      rights: CNE,
      creator: "Dickinson Historical Society",
      type: "Photographs",
      credit_line: "Courtesy of the Dickinson Historical Society",
    });
    expect(top.chain.map((s) => s.title)).toEqual(["Fonds F1", "Series S1"]);
  });

  it("is plain data that survives JSON", () => {
    expect(JSON.parse(JSON.stringify(effective))).toEqual(effective);
  });
});

describe("the record's own value wins", () => {
  it("over every unit above it", () => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE, creator: "A" });
    const series = unit("S", "series", fonds, { creator: "B" });
    const item = unit("I", "item", series, { rights: INC });
    const e = ok(effectiveRecord(item.id, [item, series, fonds], all(ARCHIVE)));
    expect(e.fields.rights).toEqual(INC);
    expect(entry(e, "rights")?.own).toBe(true);
    // The nearest unit with a value wins over one further up.
    expect(e.fields.creator).toBe("B");
    expect(entry(e, "creator")?.from.id).toBe(series.id);
  });

  it("replaces an inherited list instead of merging with it", () => {
    const fonds = unit("F", "fonds", undefined, {
      subjects: [{ label: "Railroads" }, { label: "Dickinson (Tex.)" }],
    });
    const item = unit("I", "item", fonds, { subjects: [{ label: "Depots" }] });
    const e = ok(effectiveRecord(item.id, [item, fonds], all(ARCHIVE)));
    expect(e.fields.subjects).toEqual([{ label: "Depots" }]);
    expect(entry(e, "subjects")?.own).toBe(true);
  });

  it("passes an inherited list down whole when the record has none", () => {
    const subjects = [{ label: "Railroads" }, { label: "Dickinson (Tex.)" }];
    const fonds = unit("F", "fonds", undefined, { subjects });
    const item = unit("I", "item", fonds);
    const e = ok(effectiveRecord(item.id, [item, fonds], all(ARCHIVE)));
    expect(e.fields.subjects).toEqual(subjects);
  });

  it.each<[string, FieldValue]>([
    ["null", null],
    ["empty text", ""],
    ["blank text", "   "],
    ["an empty list", []],
  ])("an own value stored as %s means none, and nothing is inherited", (_, empty) => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE, subjects: [{ label: "X" }] });
    const item = unit("I", "item", fonds, { rights: empty, subjects: empty });
    const e = ok(effectiveRecord(item.id, [item, fonds], all(ARCHIVE)));
    expect(Object.hasOwn(e.fields, "rights")).toBe(false);
    expect(Object.hasOwn(e.fields, "subjects")).toBe(false);
    expect(e.notes.map((n) => [n.code, n.path])).toEqual([
      ["empty_value", ["fields", "rights"]],
      ["empty_value", ["fields", "subjects"]],
    ]);
    // So the record can't be published until someone chooses its rights.
    expect(effectivePublishIssues(e)[0]?.code).toBe("rights_missing");
  });

  it("an empty value on a unit in between stops values from further up", () => {
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const series = unit("S", "series", fonds, { creator: "" });
    const item = unit("I", "item", series);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], all(ARCHIVE)));
    expect(Object.hasOwn(e.fields, "creator")).toBe(false);
  });

  it("an empty own value on a field that isn't inherited is just left out", () => {
    const item = unit("I", "item", undefined, { date: "" });
    const e = ok(effectiveRecord(item.id, [item], all(ARCHIVE)));
    expect(e.fields).toEqual({});
    expect(e.notes).toEqual([]);
  });
});

describe("which fields inherit", () => {
  it("not a field the record's template doesn't mark inherited", () => {
    const fonds = unit("F", "fonds", undefined, { date: "1900" });
    const item = unit("I", "item", fonds);
    const e = ok(effectiveRecord(item.id, [item, fonds], all(ARCHIVE)));
    expect(e.fields).toEqual({});
  });

  it("not when the receiving template says inherited: false, whatever the parent's says", () => {
    const parentT = template([field({ key: "creator" })], "parent");
    const childT = template([field({ key: "creator", inherited: false })], "child");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const item = unit("I", "item", fonds);
    const lookup: TemplateLookup = (r) => (r.id === item.id ? childT : parentT);
    const e = ok(effectiveRecord(item.id, [item, fonds], lookup));
    expect(e.fields).toEqual({});
  });

  it("not from a unit whose template says inherited: false", () => {
    const parentT = template([field({ key: "creator", inherited: false })], "parent");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const item = unit("I", "item", fonds);
    const lookup: TemplateLookup = (r) => (r.id === item.id ? ARCHIVE : parentT);
    const e = ok(effectiveRecord(item.id, [item, fonds], lookup));
    expect(e.fields).toEqual({});
  });

  it("past a unit in between whose template doesn't have the key", () => {
    const bare = template([field({ key: "type" })], "bare");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const series = unit("S", "series", fonds, { creator: "left over" });
    const item = unit("I", "item", series);
    const lookup: TemplateLookup = (r) => (r.id === series.id ? bare : ARCHIVE);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], lookup));
    // The series' left-over value doesn't count; the fonds' value comes through.
    expect(e.fields.creator).toBe("A");
    expect(entry(e, "creator")?.from.id).toBe(fonds.id);
  });

  it("not past a unit in between whose template has the key but doesn't pass it down", () => {
    const stop = template([field({ key: "creator", inherited: false })], "stop");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const series = unit("S", "series", fonds);
    const item = unit("I", "item", series);
    const lookup: TemplateLookup = (r) => (r.id === series.id ? stop : ARCHIVE);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], lookup));
    expect(e.fields).toEqual({});
  });

  it("not a value stored under a key the parent's template doesn't have", () => {
    const bare = template([field({ key: "type" })], "bare");
    const fonds = unit("F", "fonds", undefined, { creator: "left over" });
    const item = unit("I", "item", fonds);
    const lookup: TemplateLookup = (r) => (r.id === fonds.id ? bare : ARCHIVE);
    expect(ok(effectiveRecord(item.id, [item, fonds], lookup)).fields).toEqual({});
  });

  it("not between fields of a different kind, with a note", () => {
    const parentT = template([field({ key: "creator", kind: "long_text" })], "parent");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const item = unit("I", "item", fonds);
    const lookup: TemplateLookup = (r) => (r.id === item.id ? ARCHIVE : parentT);
    const e = ok(effectiveRecord(item.id, [item, fonds], lookup));
    expect(e.fields).toEqual({});
    expect(e.notes[0]?.code).toBe("incompatible_field");
    expect(e.notes[0]?.message).toBe(
      '"Creator" isn\'t inherited through "F": the field there is a single long text, here it is a single text.',
    );
  });

  it("not through a unit in between whose field has a different kind, even with no value there", () => {
    const middleT = template([field({ key: "creator", kind: "long_text" })], "middle");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const series = unit("S", "series", fonds);
    const item = unit("I", "item", series);
    const lookup: TemplateLookup = (r) => (r.id === series.id ? middleT : ARCHIVE);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], lookup));
    expect(e.fields).toEqual({});
    expect(e.notes.map((n) => [n.code, n.path])).toEqual([
      ["incompatible_field", ["fields", "creator"]],
    ]);
    expect(e.notes[0]?.message).toMatch(/through "S"/);
  });

  it("not through a unit in between whose field is repeatable where the others aren't", () => {
    const middleT = template([field({ key: "creator", repeatable: true })], "middle");
    const fonds = unit("F", "fonds", undefined, { creator: "A" });
    const series = unit("S", "series", fonds);
    const item = unit("I", "item", series);
    const lookup: TemplateLookup = (r) => (r.id === series.id ? middleT : ARCHIVE);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], lookup));
    expect(e.fields).toEqual({});
    expect(e.notes[0]?.code).toBe("incompatible_field");
  });

  it("not between a repeatable and a single field, with a note", () => {
    const parentT = template(
      [field({ key: "subjects", kind: "controlled_term", repeatable: false })],
      "parent",
    );
    const fonds = unit("F", "fonds", undefined, { subjects: { label: "Railroads" } });
    const item = unit("I", "item", fonds);
    const lookup: TemplateLookup = (r) => (r.id === item.id ? ARCHIVE : parentT);
    const e = ok(effectiveRecord(item.id, [item, fonds], lookup));
    expect(e.fields).toEqual({});
    expect(e.notes[0]?.code).toBe("incompatible_field");
  });

  it("not a value the record's own template wouldn't accept, with a note", () => {
    const parentT = template(
      [
        field({
          key: "access",
          kind: "list",
          options: [{ value: "closed", label: "Closed" }],
        }),
        field({ key: "creator" }),
      ],
      "parent",
    );
    const childT = template(
      [
        field({ key: "access", kind: "list", options: [{ value: "public", label: "Public" }] }),
        field({ key: "creator", maxLength: 3 }),
        field({ key: "type" }),
      ],
      "child",
    );
    const fonds = unit("F", "fonds", undefined, { access: "closed", creator: "Too long" });
    const series = unit("S", "series", fonds, { type: "Photographs" });
    const item = unit("I", "item", series);
    const lookup: TemplateLookup = (r) => (r.id === fonds.id ? parentT : childT);
    const e = ok(effectiveRecord(item.id, [item, series, fonds], lookup));
    expect(e.fields).toEqual({ type: "Photographs" });
    expect(e.notes.map((n) => [n.code, n.path])).toEqual([
      ["not_valid_here", ["fields", "access"]],
      ["not_valid_here", ["fields", "creator"]],
    ]);
    expect(e.notes[0]?.message).toMatch(/^"access" isn't inherited from "F": /);
  });

  it("gives a record that isn't an archival unit only its own values", () => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE });
    const object: CatalogRecord = {
      kind: "object",
      id: newRecordId(),
      title: "Lantern",
      createdAt: T,
      updatedAt: T,
      fields: { creator: "Unknown" },
    };
    const e = ok(effectiveRecord(object.id, [object, fonds], all(ARCHIVE)));
    expect(e.fields).toEqual({ creator: "Unknown" });
    expect(e.chain).toEqual([{ id: object.id, kind: "object", title: "Lantern" }]);
  });

  it("works for a unit with no parent", () => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE });
    const e = ok(effectiveRecord(fonds.id, [fonds], all(ARCHIVE)));
    expect(e.fields).toEqual({ rights: CNE });
    expect(e.chain).toHaveLength(1);
  });
});

describe("visibility: the strictest along the chain", () => {
  const staff = (key: string) => field({ key, visibility: "staff" });
  const pub = (key: string) => field({ key, visibility: "public" });

  function run(levels: readonly (FieldDefinition | undefined)[], ownValue = false) {
    // levels[0] is the fonds' definition, the last is the item's.
    const records: ArchivalUnitRecord[] = [];
    const templates = new Map<RecordId, FieldTemplate>();
    const names: ArchivalLevel[] = ["fonds", "series", "collection", "file", "item"];
    levels.forEach((def, i) => {
      const isFirst = i === 0;
      const isLast = i === levels.length - 1;
      const fields = isFirst || (isLast && ownValue) ? { note: "Value" } : {};
      const r = unit(`U${String(i)}`, names[i] ?? "file", records[i - 1], fields);
      records.push(r);
      templates.set(r.id, template(def === undefined ? [pub("other")] : [def], `t${String(i)}`));
    });
    const target = records[records.length - 1];
    if (target === undefined) throw new Error("no records");
    const e = ok(effectiveRecord(target.id, records, (r) => templates.get(r.id) ?? ARCHIVE));
    return entry(e, "note");
  }

  it("a staff value stays staff when inherited into a template that marks the key public", () => {
    const got = run([staff("note"), pub("note")]);
    expect(got?.value).toBe("Value");
    expect(got?.visibility).toBe("staff");
  });

  it("a unit in between that marks the key staff makes it staff", () => {
    expect(run([pub("note"), staff("note"), pub("note")])?.visibility).toBe("staff");
  });

  it("a unit in between without the key doesn't change it", () => {
    expect(run([staff("note"), undefined, pub("note")])?.visibility).toBe("staff");
    expect(run([pub("note"), undefined, pub("note")])?.visibility).toBe("public");
  });

  it("the receiving template marking it staff makes it staff", () => {
    expect(run([pub("note"), pub("note"), staff("note")])?.visibility).toBe("staff");
  });

  it("public all the way down stays public", () => {
    expect(run([pub("note"), pub("note"), pub("note")])?.visibility).toBe("public");
  });

  it("a staff definition below the source doesn't matter once the record has its own value", () => {
    // Own values follow the record's own template.
    const got = run([staff("note"), pub("note")], true);
    expect(got?.own).toBe(true);
    expect(got?.visibility).toBe("public");
  });

  it("keeps a value the template doesn't have as the record's own, staff only, never inherited", () => {
    const bare = template([field({ key: "type" })], "bare");
    const fonds = unit("F", "fonds", undefined, { old_field: "kept" });
    const item = unit("I", "item", fonds, { old_note: "Left over" });
    const e = ok(effectiveRecord(item.id, [item, fonds], all(bare)));
    expect(e.entries).toEqual([
      {
        key: "old_note",
        label: "old_note",
        value: "Left over",
        own: true,
        from: e.chain[1],
        visibility: "staff",
        inTemplate: false,
      },
    ]);
  });
});

describe("a hierarchy that can't be trusted fails the whole result", () => {
  it("reports a record that isn't in the set", () => {
    const r = effectiveRecord(newRecordId(), [], all(ARCHIVE));
    expect(r.ok).toBe(false);
    expect(code(r)).toBe("not_found");
  });

  it("reports a parent that isn't in the set", () => {
    const fonds = unit("F", "fonds");
    const item = unit("Lost item", "item", fonds);
    const r = effectiveRecord(item.id, [item], all(ARCHIVE));
    expect(r.ok ? [] : r.issues).toEqual([
      {
        path: [item.id, "parentId"],
        code: "missing_parent",
        message: '"Lost item" is filed under a unit that isn\'t in the set.',
      },
    ]);
  });

  it("reports a loop of parents, including one above the record", () => {
    const aId = newRecordId();
    const bId = newRecordId();
    const a = unit("A", "series", { id: bId }, {}, aId);
    const b = unit("B", "series", { id: aId }, {}, bId);
    expect(code(effectiveRecord(aId, [a, b], all(ARCHIVE)))).toBe("loop");
    const item = unit("I", "item", a);
    expect(code(effectiveRecord(item.id, [item, a, b], all(ARCHIVE)))).toBe("loop");
  });

  it(`allows ${String(MAX_ARRANGEMENT_DEPTH)} levels and refuses one more`, () => {
    const chain: ArchivalUnitRecord[] = [unit("S0", "series", undefined, { creator: "Top" })];
    for (let i = 1; i < MAX_ARRANGEMENT_DEPTH; i += 1) {
      chain.push(unit(`S${String(i)}`, "series", chain[i - 1]));
    }
    const deepest = chain[chain.length - 1];
    if (deepest === undefined) throw new Error("no chain");
    const e = ok(effectiveRecord(deepest.id, chain, all(ARCHIVE)));
    expect(e.chain).toHaveLength(MAX_ARRANGEMENT_DEPTH);
    expect(e.fields.creator).toBe("Top");
    const tooDeep = unit("Too deep", "item", deepest);
    expect(code(effectiveRecord(tooDeep.id, [...chain, tooDeep], all(ARCHIVE)))).toBe("too_deep");
  });

  it("reports an ID used twice, for the record or a parent", () => {
    const fonds = unit("F", "fonds");
    const item = unit("I", "item", fonds);
    expect(code(effectiveRecord(item.id, [item, { ...item }, fonds], all(ARCHIVE)))).toBe(
      "duplicate_id",
    );
    const twin = unit("Twin", "fonds", undefined, {}, fonds.id);
    expect(code(effectiveRecord(item.id, [item, fonds, twin], all(ARCHIVE)))).toBe(
      "ambiguous_parent",
    );
  });

  it("reports a record or parent that isn't valid", () => {
    const fonds = unit("F", "fonds");
    const bad = { ...fonds, title: " untrimmed" };
    const item = unit("I", "item", fonds);
    expect(code(effectiveRecord(fonds.id, [bad], all(ARCHIVE)))).toBe("invalid_record");
    expect(code(effectiveRecord(item.id, [item, bad], all(ARCHIVE)))).toBe("invalid_parent");
  });

  it("reports a unit filed under the wrong level, or under something that isn't a unit", () => {
    const item = unit("Item", "item");
    const fonds = unit("Fonds", "fonds", item);
    const r = effectiveRecord(fonds.id, [fonds, item], all(ARCHIVE));
    expect(code(r)).toBe("wrong_level");
    expect(r.ok ? "" : r.issues[0]?.message).toBe(
      'A fonds can\'t be filed under an item ("Fonds" under "Item").',
    );
    const object: CatalogRecord = {
      kind: "object",
      id: newRecordId(),
      title: "Lantern",
      createdAt: T,
      updatedAt: T,
      fields: {},
    };
    const under = unit("Under", "item", object);
    expect(code(effectiveRecord(under.id, [under, object], all(ARCHIVE)))).toBe("not_a_unit");
  });

  it("reports a missing, invalid, unsuitable or failing template", () => {
    const fonds = unit("F", "fonds");
    const item = unit("I", "item", fonds);
    const set = [item, fonds];
    const only = (t: unknown): TemplateLookup =>
      ((r: CatalogRecord) => (r.id === fonds.id ? t : ARCHIVE)) as TemplateLookup;
    expect(code(effectiveRecord(item.id, set, only(undefined)))).toBe("no_template");
    expect(code(effectiveRecord(item.id, set, only({ key: "x" })))).toBe("invalid_template");
    const forAgents: FieldTemplate = { ...ARCHIVE, appliesTo: ["agent"] };
    expect(code(effectiveRecord(item.id, set, only(forAgents)))).toBe("wrong_template");
    const throws: TemplateLookup = () => {
      throw new Error("boom");
    };
    expect(code(effectiveRecord(item.id, set, throws))).toBe("template_lookup_failed");
    expect(code(effectiveRecord(item.id, set, "nope" as unknown as TemplateLookup))).toBe(
      "no_template_lookup",
    );
  });

  it("reports a bad ID or a set that isn't a list", () => {
    expect(code(effectiveRecord("nope" as RecordId, [], all(ARCHIVE)))).toBe("invalid_id");
    expect(
      code(effectiveRecord(newRecordId(), "x" as unknown as CatalogRecord[], all(ARCHIVE))),
    ).toBe("not_a_list");
    expect(indexRecords({ length: 1 }).ok).toBe(false);
  });

  it(`refuses a set of more than ${String(MAX_RECORD_SET)} records without reading it`, () => {
    const huge = new Array<CatalogRecord>(MAX_RECORD_SET + 1);
    const r = indexRecords(huge);
    expect(r.ok ? undefined : r.issues[0]?.code).toBe("too_many_records");
  });
});

describe("the result is frozen", () => {
  it("all the way down", () => {
    const { item, records } = mockupTree();
    const e = ok(effectiveRecord(item.id, records, all(ARCHIVE)));
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.fields)).toBe(true);
    expect(Object.isFrozen(e.entries)).toBe(true);
    expect(Object.isFrozen(e.chain)).toBe(true);
    expect(Object.isFrozen(e.notes)).toBe(true);
    expect(Object.isFrozen(e.record)).toBe(true);
    for (const x of e.entries) {
      expect(Object.isFrozen(x)).toBe(true);
      expect(Object.isFrozen(x.from)).toBe(true);
    }
    const failed = effectiveRecord(newRecordId(), [], all(ARCHIVE));
    expect(Object.isFrozen(failed)).toBe(true);
    expect(failed.ok ? null : Object.isFrozen(failed.issues[0])).toBe(true);
  });

  it("including notes", () => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE });
    const item = unit("I", "item", fonds, { rights: null });
    const e = ok(effectiveRecord(item.id, [item, fonds], all(ARCHIVE)));
    expect(Object.isFrozen(e.notes[0])).toBe(true);
  });
});

describe("indexRecords: one set, many records", () => {
  it("gives the same results as passing the list", () => {
    const { item, collection, records } = mockupTree();
    const index = indexRecords(records);
    if (!index.ok) throw new Error("not indexed");
    expect(index.value.size).toBe(4);
    for (const id of [item.id, collection.id]) {
      expect(ok(effectiveRecord(id, index.value, all(ARCHIVE)))).toEqual(
        ok(effectiveRecord(id, records, all(ARCHIVE))),
      );
    }
  });

  it("asks for each record's template once per call, with a frozen copy", () => {
    const { item, records } = mockupTree();
    const asked: CatalogRecord[] = [];
    ok(
      effectiveRecord(item.id, records, (r) => {
        asked.push(r);
        return ARCHIVE;
      }),
    );
    expect(asked).toHaveLength(4);
    expect(new Set(asked.map((r) => r.id)).size).toBe(4);
    expect(asked.every((r) => Object.isFrozen(r) && Object.isFrozen(r.fields))).toBe(true);
    expect(asked.some((r) => records.includes(r as ArchivalUnitRecord))).toBe(false);
  });

  it("stays linear: 20,000 items under one collection, 100,000 records in all", () => {
    const fonds = unit("F", "fonds", undefined, { rights: CNE, creator: "A" });
    const collection = unit("C", "collection", fonds, { type: "Photographs" });
    const items: ArchivalUnitRecord[] = [];
    for (let i = 0; i < 20_000; i += 1) items.push(unit(`I${String(i)}`, "item", collection));
    const others: ArchivalUnitRecord[] = [];
    for (let i = 0; i < 80_000; i += 1) others.push(unit(`O${String(i)}`, "fonds"));
    const index = indexRecords([...others, fonds, collection, ...items]);
    if (!index.ok) throw new Error("not indexed");
    // Count the work instead of timing it: each item asks for exactly one
    // template per record on its chain (3), whatever the size of the set.
    let asked = 0;
    const counting: TemplateLookup = () => {
      asked += 1;
      return ARCHIVE;
    };
    let rights = 0;
    for (const item of items) {
      const e = ok(effectiveRecord(item.id, index.value, counting));
      if (JSON.stringify(e.fields.rights) === JSON.stringify(CNE)) rights += 1;
    }
    expect(rights).toBe(20_000);
    expect(asked).toBe(60_000);
  }, 30_000);
});
