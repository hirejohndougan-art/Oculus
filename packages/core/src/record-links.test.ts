// Links between records (T-015, D-039): the record_link field kind, the
// record link checker, inheritance and public output.
import { describe, expect, it } from "vitest";
import {
  FIELD_KINDS,
  checkRecordAgainstTemplate,
  effectiveRecord,
  indexRecords,
  makeRecordLinkChecker,
  newOrganizationId,
  newRecordId,
  publicOutput,
  publicView,
  validateTemplate,
  type CatalogRecord,
  type FieldDefinition,
  type FieldValueChecker,
  type PublicOutput,
  type RecordId,
  type Validated,
} from "./index.js";
import {
  accessionsFor,
  BASE,
  CHECKERS,
  CNE,
  FIELDS,
  ORG,
  field,
  linkChecker,
  record,
  template,
  nowOf,
} from "./public-output.fixtures.js";

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

/** The fixtures' fields plus a creator linked to the Authorities list and related records. */
const LINK_FIELDS: readonly FieldDefinition[] = [
  ...FIELDS.filter((f) => f.key !== "creator"),
  field({
    key: "creator",
    label: "Creator",
    kind: "record_link",
    recordKinds: ["agent"],
    inherited: true,
  }),
  field({ key: "related", label: "Related", kind: "record_link", repeatable: true }),
  field({ key: "donor", label: "Donor", kind: "record_link", visibility: "staff" }),
];
const LINK_TPL = template(LINK_FIELDS, "links");
const LINK_MAPPING = {
  organizationId: ORG,
  template: "links",
  entries: [
    { field: "rights", term: "rights" },
    { field: "creator", term: "creator" },
    { field: "related", term: "relation" },
    { field: "places", term: "spatial" },
  ],
};

const withKey = (r: CatalogRecord): CatalogRecord => ({ ...r, templateKey: "links" });

function sample() {
  const agent = withKey(record("agent", "Dickinson, John", {}));
  const event = withKey(record("event", "Storm of 1900", {}));
  const place = withKey(record("place", "Dickinson (Tex.)", {}));
  const item = withKey(
    record("object", "Dickinson Station and Park", {
      rights: { uri: CNE },
      creator: { recordId: agent.id, label: "Dickinson, John" },
      related: [
        { recordId: event.id, label: "Storm of 1900" },
        { recordId: place.id, label: "Dickinson" },
      ],
      places: [{ label: "Dickinson (Tex.)", recordId: place.id }],
    }),
  );
  return { agent, event, place, item, all: [agent, event, place, item] };
}

function checkersFor(records: readonly CatalogRecord[]) {
  const links = linkChecker(records);
  return { ...CHECKERS, record_link: links, place: links };
}

function check(r: CatalogRecord, checkers?: Record<string, FieldValueChecker>): string[] {
  return checkRecordAgainstTemplate(
    r,
    LINK_TPL,
    checkers === undefined ? {} : { checkers: checkers },
  ).map((i) => i.code);
}

function output(
  records: readonly CatalogRecord[],
  id: RecordId,
  published: readonly RecordId[],
  checkers: Record<string, unknown> = checkersFor(records),
): Validated<PublicOutput> {
  const effective = ok(effectiveRecord(id, records, () => LINK_TPL, { checkers: checkers }));
  const view = publicView(effective);
  if (view === undefined) throw new Error("no view");
  return publicOutput(view, LINK_MAPPING, {
    ...nowOf(view),
    baseUrl: BASE,
    accessions: accessionsFor(view),
    published,
    checkers: checkers,
  });
}

describe("the record_link field kind", () => {
  const def = (extra: Record<string, unknown>) => ({
    key: "creator",
    label: "Creator",
    kind: "record_link",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  });
  const tpl = (extra: Record<string, unknown>) => ({
    key: "t",
    label: "T",
    organizationId: ORG,
    appliesTo: ["object"],
    fields: [def(extra)],
  });

  it("is a field kind, with optional recordKinds", () => {
    expect(FIELD_KINDS).toContain("record_link");
    expect(codes(validateTemplate(tpl({})))).toEqual([]);
    expect(codes(validateTemplate(tpl({ recordKinds: ["agent"] })))).toEqual([]);
    expect(codes(validateTemplate(tpl({ recordKinds: ["agent", "place", "event"] })))).toEqual([]);
  });

  it("refuses bad recordKinds lists", () => {
    expect(codes(validateTemplate(tpl({ recordKinds: [] })))).toEqual(["invalid_list"]);
    expect(codes(validateTemplate(tpl({ recordKinds: "agent" })))).toEqual(["invalid_list"]);
    expect(codes(validateTemplate(tpl({ recordKinds: ["person"] })))).toEqual(["invalid_kind"]);
    expect(codes(validateTemplate(tpl({ recordKinds: ["agent", "agent"] })))).toEqual([
      "duplicate",
    ]);
    expect(
      codes(validateTemplate(tpl({ recordKinds: [...Array<string>(7).fill("agent")] }))),
    ).toEqual(["invalid_list"]);
  });

  it("allows recordKinds on record_link fields only", () => {
    expect(codes(validateTemplate(tpl({ kind: "place", recordKinds: ["place"] })))).toEqual([
      "not_for_kind",
    ]);
    expect(codes(validateTemplate(tpl({ kind: "text", recordKinds: ["agent"] })))).toEqual([
      "not_for_kind",
    ]);
  });

  it("checks the value's shape: { recordId, label }", () => {
    const { agent, all } = sample();
    const checkers = checkersFor(all);
    const value = (creator: unknown): string[] =>
      check(withKey(record("object", "X", { rights: { uri: CNE }, creator } as never)), checkers);
    expect(value({ recordId: agent.id, label: "Dickinson, John" })).toEqual([]);
    expect(value({ label: "Dickinson, John" })).toEqual(["required"]);
    expect(value({ recordId: agent.id })).toEqual(["invalid_text"]);
    expect(value({ recordId: agent.id, label: " Dickinson" })).toEqual(["invalid_text"]);
    expect(value({ recordId: "123", label: "x" })).toEqual(["invalid_id"]);
    expect(value({ recordId: agent.id, label: "x", uri: "https://example.org/" })).toEqual([
      "unknown_property",
    ]);
    expect(value("Dickinson, John")).toEqual(["not_an_object"]);
    expect(value([{ recordId: agent.id, label: "x" }])).toEqual(["not_repeatable"]);
  });

  it("refuses record_link values when no record link checker is given", () => {
    const { item } = sample();
    expect(check(item, { ...CHECKERS })).toEqual(["unchecked", "unchecked", "unchecked"]);
    const problem = checkRecordAgainstTemplate(item, LINK_TPL, { checkers: CHECKERS })[0];
    expect(problem?.message).toContain("makeRecordLinkChecker");
  });

  it("accepts a valid record with the record link checker", () => {
    const { item, all } = sample();
    expect(check(item, checkersFor(all))).toEqual([]);
  });
});

describe("makeRecordLinkChecker", () => {
  it("is made from a list or an index from indexRecords", () => {
    const { item, all } = sample();
    const fromIndex = ok(makeRecordLinkChecker(ok(indexRecords(all))));
    expect(check(item, { ...CHECKERS, record_link: fromIndex, place: fromIndex })).toEqual([]);
  });

  it("refuses a link to a record that isn't in the organization's records", () => {
    const { item, all } = sample();
    const links = linkChecker(all.filter((r) => r.kind !== "agent"));
    const problems = checkRecordAgainstTemplate(item, LINK_TPL, {
      checkers: { ...CHECKERS, record_link: links, place: links },
    });
    expect(problems.map((p) => [p.code, p.path])).toEqual([
      ["unknown_record", ["fields", "creator", "recordId"]],
    ]);
  });

  it("refuses a target of a kind the field doesn't allow", () => {
    const { event, all } = sample();
    const r = withKey(
      record("object", "X", {
        rights: { uri: CNE },
        creator: { recordId: event.id, label: "Storm" },
      }),
    );
    expect(check(r, checkersFor([...all, r]))).toEqual(["wrong_record_kind"]);
  });

  it("allows any kind when recordKinds is left out", () => {
    const { all } = sample();
    const related = all.map((t) => ({ recordId: t.id, label: t.title }));
    const r = withKey(record("object", "X", { rights: { uri: CNE }, related }));
    expect(check(r, checkersFor([...all, r]))).toEqual([]);
  });

  it("refuses a place value naming a record that isn't a place", () => {
    const { agent, all } = sample();
    const r = withKey(
      record("object", "X", {
        rights: { uri: CNE },
        places: [{ label: "Somewhere", recordId: agent.id }],
      }),
    );
    expect(check(r, checkersFor([...all, r]))).toEqual(["wrong_record_kind"]);
  });

  it("accepts a place with no recordId, and checks nothing else about it", () => {
    const r = withKey(
      record("object", "X", { rights: { uri: CNE }, places: [{ label: "Dickinson Bayou" }] }),
    );
    expect(check(r, checkersFor([r]))).toEqual([]);
  });

  it("refuses a link from a record to itself", () => {
    const id = newRecordId();
    const r = withKey(
      record(
        "object",
        "X",
        { rights: { uri: CNE }, related: [{ recordId: id, label: "Me" }] },
        {},
        id,
      ),
    );
    expect(check(r, checkersFor([r]))).toEqual(["self_link"]);
  });

  it("refuses a link to an ID used twice or a record that isn't valid", () => {
    const { item, agent } = sample();
    const twice = linkChecker([item, agent, { ...agent, title: "Other" }]);
    const bad = linkChecker([item, { ...agent, title: "" }]);
    for (const links of [twice, bad]) {
      const problems = checkRecordAgainstTemplate(
        withKey(
          record("object", "X", {
            rights: { uri: CNE },
            creator: { recordId: agent.id, label: "Dickinson, John" },
          }),
        ),
        LINK_TPL,
        { checkers: { ...CHECKERS, record_link: links } },
      );
      expect(problems.map((p) => p.code)).toEqual(["unusable_record"]);
    }
  });

  it("knows no records when made from an empty set for an organization", () => {
    const { item } = sample();
    const links = ok(makeRecordLinkChecker([], ORG));
    expect(check(item, { ...CHECKERS, record_link: links, place: links })).toEqual([
      "unknown_record",
      "unknown_record",
      "unknown_record",
      "unknown_record",
    ]);
  });

  // Changed in T-015a: an empty set with no organization makes a checker that
  // belongs to nobody, which refuses every link (before: unknown_record).
  it("refuses every link when made from an empty set for no organization", () => {
    const { item } = sample();
    const links = linkChecker([]);
    expect(check(item, { ...CHECKERS, record_link: links, place: links })).toEqual([
      "no_organization_checker",
      "no_organization_checker",
      "no_organization_checker",
      "no_organization_checker",
    ]);
  });

  it("is only for record_link and place values", () => {
    const { all, item } = sample();
    const links = linkChecker(all);
    expect(links("x", field({ key: "title" }), item).map((p) => p.code)).toEqual(["wrong_checker"]);
  });

  it("checks against a snapshot: later changes to the caller's records are not seen", () => {
    const { agent, item } = sample();
    const mutable = { ...agent, kind: "agent" } as Record<string, unknown>;
    const links = linkChecker([item, mutable as never]);
    mutable.kind = "event";
    mutable.id = newRecordId();
    expect(check(item, { ...CHECKERS, record_link: links })).toEqual([
      // related values: the event and place are not in this set.
      "unknown_record",
      "unknown_record",
    ]);
  });

  it("refuses a set that mixes organizations", () => {
    const { all } = sample();
    const other = { ...record("agent", "Other", {}), organizationId: newOrganizationId() };
    expect(codes(makeRecordLinkChecker([...all, other]))).toEqual(["mixed_organizations"]);
    expect(codes(makeRecordLinkChecker("nope"))).toEqual(["not_a_list"]);
  });
});

describe("record links and inheritance", () => {
  it("lets a unit's creator link come down to its items", () => {
    const { agent } = sample();
    const fonds = withKey(
      record(
        "archival_unit",
        "Dickinson family papers",
        { rights: { uri: CNE }, creator: { recordId: agent.id, label: "Dickinson, John" } },
        { level: "fonds" },
      ),
    );
    const item = withKey(
      record("archival_unit", "Letter", {}, { level: "item", parentId: fonds.id }),
    );
    const all = [agent, fonds, item];
    const effective = ok(
      effectiveRecord(item.id, all, () => LINK_TPL, { checkers: checkersFor(all) }),
    );
    expect(effective.fields.creator).toEqual({ recordId: agent.id, label: "Dickinson, John" });
    expect(effective.entries.find((e) => e.key === "creator")?.own).toBe(false);
  });

  it("leaves out an inherited link no record link checker has checked", () => {
    const { agent } = sample();
    const fonds = withKey(
      record(
        "archival_unit",
        "Papers",
        { creator: { recordId: agent.id, label: "Dickinson, John" } },
        { level: "fonds" },
      ),
    );
    const item = withKey(
      record("archival_unit", "Letter", {}, { level: "item", parentId: fonds.id }),
    );
    const effective = ok(
      effectiveRecord(item.id, [agent, fonds, item], () => LINK_TPL, { checkers: CHECKERS }),
    );
    expect(effective.fields.creator).toBeUndefined();
    expect(effective.notes.map((n) => n.code)).toEqual(["not_valid_here"]);
  });
});

describe("the public view holds no linked record IDs", () => {
  it("holds no record link at all, and a place's name (and gazetteer URI) only", () => {
    const { item, all } = sample();
    const effective = ok(
      effectiveRecord(item.id, all, () => LINK_TPL, { checkers: checkersFor(all) }),
    );
    const view = publicView(effective);
    // D-045: the view can't tell whether a linked record may be named.
    expect(view?.fields.creator).toBeUndefined();
    expect(view?.fields.related).toBeUndefined();
    expect(view?.entries.map((e) => e.key)).not.toContain("creator");
    expect(JSON.stringify(view)).not.toContain("Storm of 1900");
    expect(view?.fields.places).toEqual([{ label: "Dickinson (Tex.)" }]);
    for (const other of all.filter((r) => r.id !== item.id)) {
      expect(JSON.stringify(view)).not.toContain(other.id);
    }
    // The staff-side effective record still has them.
    expect(effective.fields.creator).toEqual({ recordId: all[0]?.id, label: "Dickinson, John" });
  });
});

describe("publicOutput: record links", () => {
  it("links published records of the organization, with their labels", () => {
    const { agent, event, place, item, all } = sample();
    const o = ok(output(all, item.id, [item.id, agent.id, event.id, place.id]));
    expect(o.jsonLd["dcterms:creator"]).toEqual({
      "@id": BASE + agent.id,
      "rdfs:label": "Dickinson, John",
    });
    expect(o.jsonLd["dcterms:relation"]).toEqual([
      { "@id": BASE + event.id, "rdfs:label": "Storm of 1900" },
      { "@id": BASE + place.id, "rdfs:label": "Dickinson" },
    ]);
    expect(o.jsonLd["dcterms:spatial"]).toEqual({
      "@id": BASE + place.id,
      "rdfs:label": "Dickinson (Tex.)",
    });
    expect(o.dublinCore.creator).toEqual(["Dickinson, John"]);
    expect(o.dublinCore.relation).toEqual(["Storm of 1900", "Dickinson"]);
    expect(o.oaiDcXml).toContain("<dc:creator>Dickinson, John</dc:creator>");
  });

  it("gives nothing for a link to an unpublished record, not even its label (D-045)", () => {
    const { agent, event, place, item, all } = sample();
    const o = ok(output(all, item.id, [item.id, place.id]));
    expect(o.jsonLd["dcterms:creator"]).toBeUndefined();
    expect(o.dublinCore.creator).toBeUndefined();
    // Only the published place is left, as a single value.
    expect(o.jsonLd["dcterms:relation"]).toEqual({
      "@id": BASE + place.id,
      "rdfs:label": "Dickinson",
    });
    expect(o.dublinCore.relation).toEqual(["Dickinson"]);
    const text = JSON.stringify(o);
    expect(text).not.toContain(agent.id);
    expect(text).not.toContain(event.id);
    expect(text).not.toContain("Dickinson, John");
    expect(text).not.toContain("Storm of 1900");
  });

  it("refuses to publish a record whose link the checker refuses", () => {
    const { event, item, all } = sample();
    // A creator that is an event, not an agent: the field doesn't allow it.
    const wrong = {
      ...item,
      fields: { ...item.fields, creator: { recordId: event.id, label: "X" } },
    };
    const records = all.map((r) => (r.id === item.id ? wrong : r));
    expect(codes(output(records, item.id, [item.id, event.id]))).toEqual(["wrong_record_kind"]);
  });

  it("refuses to publish record_link values with no record link checker", () => {
    const { item, all } = sample();
    expect(codes(output(all, item.id, [item.id], { ...CHECKERS }))).toEqual([
      "unchecked",
      "unchecked",
      "unchecked",
    ]);
  });
});

describe("publicOutput: links to deleted records (S-011c, D-045)", () => {
  /** The sample with `gone` deleted: the records and checkers as they are now. */
  function without(gone: (r: CatalogRecord) => boolean) {
    const { agent, event, place, item, all } = sample();
    const now = all.filter((r) => !gone(r));
    return { agent, event, place, item, now };
  }

  it("publishes the record without a link to a deleted record, and warns staff", () => {
    const { agent, event, place, item, now } = without((r) => r.kind === "agent");
    const o = ok(output(now, item.id, [item.id, event.id, place.id]));
    expect(o.jsonLd["dcterms:creator"]).toBeUndefined();
    expect(o.dublinCore.creator).toBeUndefined();
    expect(o.oaiDcXml).not.toContain("dc:creator");
    // The other links still go out.
    expect(o.dublinCore.relation).toEqual(["Storm of 1900", "Dickinson"]);
    for (const form of [JSON.stringify(o.dublinCore), o.jsonLdText, o.oaiDcXml, o.id]) {
      expect(form).not.toContain(agent.id);
      expect(form).not.toContain("Dickinson, John");
      expect(form).not.toContain("link_target_missing");
    }
    expect(o.staffWarnings.map((w) => [w.code, w.path])).toEqual([
      ["link_target_missing", ["fields", "creator", "recordId"]],
    ]);
    // The warning names neither the record nor the label.
    expect(JSON.stringify(o.staffWarnings)).not.toContain(agent.id);
    expect(JSON.stringify(o.staffWarnings)).not.toContain("Dickinson, John");
  });

  it("drops only the deleted record from a repeatable link field", () => {
    const { event, place, item, now } = without((r) => r.kind === "event");
    const published = [
      item.id,
      place.id,
      ...now.filter((r) => r.kind === "agent").map((r) => r.id),
    ];
    const o = ok(output(now, item.id, published));
    expect(o.jsonLd["dcterms:relation"]).toEqual({
      "@id": BASE + place.id,
      "rdfs:label": "Dickinson",
    });
    expect(o.dublinCore.relation).toEqual(["Dickinson"]);
    for (const form of [JSON.stringify(o.dublinCore), o.jsonLdText, o.oaiDcXml]) {
      expect(form).not.toContain(event.id);
      expect(form).not.toContain("Storm of 1900");
    }
    expect(o.staffWarnings.map((w) => [w.code, w.path])).toEqual([
      ["link_target_missing", ["fields", "related", 0, "recordId"]],
    ]);
  });

  it("leaves a term out when every link in it is to a deleted record", () => {
    const { item, now } = without((r) => r.kind === "event" || r.kind === "agent");
    const place = now.find((r) => r.kind === "place");
    if (place === undefined) throw new Error("fixture");
    // The place record is still there, unpublished: relation shows nothing.
    const o = ok(output(now, item.id, [item.id]));
    expect(o.dublinCore.relation).toBeUndefined();
    expect(o.dublinCore.creator).toBeUndefined();
    expect(o.oaiDcXml).not.toContain("dc:relation");
    expect(o.staffWarnings.map((w) => w.code)).toEqual([
      "link_target_missing",
      "link_target_missing",
    ]);
  });

  it("gives no warning when every linked record exists", () => {
    const { agent, event, place, item, all } = sample();
    expect(ok(output(all, item.id, [item.id, agent.id, event.id, place.id])).staffWarnings).toEqual(
      [],
    );
    // Unpublished but present: dropped as before, with no warning (D-045).
    expect(ok(output(all, item.id, [item.id])).staffWarnings).toEqual([]);
  });

  it("still refuses a link to a deleted record when the record is saved", () => {
    const { item, now } = without((r) => r.kind === "agent");
    expect(check(item, checkersFor(now))).toEqual(["unknown_record"]);
  });

  it("leaves out a place naming a deleted place record, as D-048 already did", () => {
    const { place, item, now } = without((r) => r.kind === "place");
    const o = ok(output(now, item.id, [item.id, ...now.map((r) => r.id)]));
    expect(o.dublinCore.spatial).toBeUndefined();
    expect(o.jsonLdText).not.toContain(place.id);
    expect(o.oaiDcXml).not.toContain("Dickinson (Tex.)");
    // The related link to the place record is a record_link: warned about.
    expect(o.staffWarnings.map((w) => w.path)).toEqual([["fields", "related", 1, "recordId"]]);
  });
});
