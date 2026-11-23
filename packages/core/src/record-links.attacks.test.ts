// Attack tests for links between records (T-015, D-039, D-045): trying to
// get an unpublished, held back or another organization's record ID, title,
// values or link label into public output through a record_link or a place's
// recordId.
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
  effectivePublishIssues,
  effectiveRecord,
  indexRecords,
  makeRecordLinkChecker,
  newOrganizationId,
  newRecordId,
  publicOutput,
  publicView,
  type CatalogRecord,
  type FieldDefinition,
  type FieldValueChecker,
  type PublicOutput,
  type PublicRecord,
  type RecordId,
  type Validated,
} from "./index.js";
import {
  accessionsFor,
  BASE,
  CHECKERS,
  CNE,
  FIELDS,
  everything,
  field,
  linkChecker,
  record,
  template,
  ORG,
} from "./public-output.fixtures.js";

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const LINK_TPL = template(
  [
    ...FIELDS.filter((f) => f.key !== "creator"),
    field({ key: "creator", label: "Creator", kind: "record_link", recordKinds: ["agent"] }),
    field({ key: "related", label: "Related", kind: "record_link", repeatable: true }),
    field({ key: "donor", label: "Donor", kind: "record_link", visibility: "staff" }),
    field({ key: "subject_of", label: "Inherited link", kind: "record_link", inherited: true }),
  ] satisfies readonly FieldDefinition[],
  "links",
);
const MAPPING = {
  organizationId: ORG,
  template: "links",
  entries: [
    { field: "rights", term: "rights" },
    { field: "creator", term: "creator" },
    { field: "related", term: "relation" },
    { field: "places", term: "spatial" },
    { field: "subject_of", term: "subject" },
  ],
};

const withKey = (r: CatalogRecord): CatalogRecord => ({ ...r, templateKey: "links" });

/** A record full of text that must never be published when it isn't. */
function secretAgent(id: RecordId = newRecordId()): CatalogRecord {
  return withKey(
    record(
      "agent",
      "SECRET-agent-title",
      { rights: { uri: CNE }, description: "SECRET-agent-description" },
      {},
      id,
    ),
  );
}

function viewOf(
  records: readonly CatalogRecord[],
  id: RecordId,
  checkers: Record<string, unknown>,
): PublicRecord {
  const effective = ok(effectiveRecord(id, records, () => LINK_TPL, { checkers: checkers }));
  const view = publicView(effective);
  if (view === undefined) throw new Error("no view");
  return view;
}

function output(
  view: PublicRecord,
  published: readonly RecordId[],
  checkers: Record<string, unknown>,
): Validated<PublicOutput> {
  return publicOutput(view, MAPPING, {
    baseUrl: BASE,
    accessions: accessionsFor(view),
    published,
    checkers: checkers,
  });
}

const lax: FieldValueChecker = () => [];

function expectNothingOf(text: string, ...records: readonly CatalogRecord[]): void {
  for (const r of records) {
    expect(text).not.toContain(r.id);
    expect(text).not.toContain(r.title);
    expect(text).not.toContain("SECRET");
  }
}

describe("an unpublished record linked to never shows", () => {
  it("leaves out its ID, title and values from every form", () => {
    const agent = secretAgent();
    const place = withKey(record("place", "SECRET-place-title", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "Unknown photographer" },
        related: [{ recordId: place.id, label: "A place" }],
        places: [{ label: "Dickinson", recordId: place.id }],
      }),
    );
    const all = [agent, place, item];
    const links = linkChecker(all);
    const checkers = { ...CHECKERS, record_link: links, place: links };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id], checkers));
    expectNothingOf(everything(o), agent, place);
    // Not even the label (D-045); a place keeps its own name.
    expect(o.dublinCore.creator).toBeUndefined();
    expect(o.dublinCore.relation).toBeUndefined();
    expect(everything(o)).not.toContain("Unknown photographer");
    expect(o.dublinCore.spatial).toEqual(["Dickinson"]);
  });

  it("leaves out the ID even when the label is blank-looking or odd text", () => {
    const agent = secretAgent();
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "<script>alert(1)</script>" },
      }),
    );
    const all = [agent, item];
    const links = linkChecker(all);
    const checkers = { ...CHECKERS, record_link: links };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id], checkers));
    expectNothingOf(everything(o), agent);
    expect(o.jsonLdText).not.toContain("<script>");
  });

  it("leaves out an inherited link's target and the unpublished unit it came from", () => {
    const agent = secretAgent();
    const fonds = withKey(
      record(
        "archival_unit",
        "SECRET-fonds-title",
        { rights: { uri: CNE }, subject_of: { recordId: agent.id, label: "The family" } },
        { level: "fonds" },
      ),
    );
    const item = withKey(
      record("archival_unit", "Letter", {}, { level: "item", parentId: fonds.id }),
    );
    const all = [agent, fonds, item];
    const links = linkChecker(all);
    const checkers = { ...CHECKERS, record_link: links };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id], checkers));
    expect(o.dublinCore.subject).toBeUndefined();
    expect(everything(o)).not.toContain("The family");
    expectNothingOf(everything(o), agent, fonds);
  });

  it("never publishes a staff link field, even to a published record", () => {
    const agent = secretAgent();
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        donor: { recordId: agent.id, label: "SECRET-donor-label" },
      }),
    );
    const all = [agent, item];
    const links = linkChecker(all);
    const checkers = { ...CHECKERS, record_link: links };
    const view = viewOf(all, item.id, checkers);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    const staffMapping = {
      ...MAPPING,
      entries: [...MAPPING.entries, { field: "donor", term: "contributor" }],
    };
    expect(
      codes(
        publicOutput(view, staffMapping, {
          baseUrl: BASE,
          accessions: accessionsFor(view),
          published: [item.id, agent.id],
          checkers,
        }),
      ),
    ).toContain("staff_field");
    const o = ok(output(view, [item.id, agent.id], checkers));
    expectNothingOf(everything(o), agent);
  });

  it("never puts a linked ID in the public view, published or not", () => {
    const agent = secretAgent();
    const place = withKey(record("place", "Dickinson", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "Photographer" },
        places: [{ label: "Dickinson", recordId: place.id }],
      }),
    );
    const all = [agent, place, item];
    const links = linkChecker(all);
    const view = viewOf(all, item.id, { ...CHECKERS, record_link: links, place: links });
    const text = JSON.stringify(view);
    expect(text).not.toContain(agent.id);
    expect(text).not.toContain(place.id);
  });
});

describe("D-045: a link the public may not follow leaves no trace", () => {
  /** An agent whose title is a private name, copied into the link label. */
  const privateName = "SECRET-donor-name";

  function linking(
    links: { creator?: unknown; related?: unknown },
    ...others: readonly CatalogRecord[]
  ): { item: CatalogRecord; all: CatalogRecord[]; checkers: Record<string, unknown> } {
    const item = withKey(record("object", "Postcard", { rights: { uri: CNE }, ...links } as never));
    const all = [...others, item];
    const made = linkChecker(all);
    return { item, all, checkers: { ...CHECKERS, record_link: made, place: made } };
  }

  it("puts out no ID, label or placeholder for a label copied from an unpublished record", () => {
    const agent = withKey(record("agent", privateName, {}));
    const { item, all, checkers } = linking(
      { creator: { recordId: agent.id, label: privateName } },
      agent,
    );
    const effective = ok(effectiveRecord(item.id, all, () => LINK_TPL, { checkers }));
    const view = publicView(effective);
    if (view === undefined) throw new Error("no view");
    expect(JSON.stringify(view)).not.toContain("SECRET");
    const o = ok(output(view, [item.id], checkers));
    expectNothingOf(everything(o), agent);
    expect(Object.keys(o.dublinCore)).not.toContain("creator");
    expect(Object.keys(o.jsonLd)).not.toContain("dcterms:creator");
    expect(o.oaiDcXml).not.toContain("dc:creator");
    // Staff still see the link.
    expect(effective.fields.creator).toEqual({ recordId: agent.id, label: privateName });
  });

  it("keeps only the links that may be named in a list, with no gap or empty value", () => {
    const hidden = withKey(record("agent", privateName, {}));
    const shown = withKey(record("event", "Storm of 1900", {}));
    const { item, all, checkers } = linking(
      {
        related: [
          { recordId: hidden.id, label: privateName },
          { recordId: shown.id, label: "Storm of 1900" },
          { recordId: hidden.id, label: `${privateName}-again` },
        ],
      },
      hidden,
      shown,
    );
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, shown.id], checkers));
    expectNothingOf(everything(o), hidden);
    expect(o.dublinCore.relation).toEqual(["Storm of 1900"]);
    expect(o.jsonLd["dcterms:relation"]).toEqual({
      "@id": BASE + shown.id,
      "rdfs:label": "Storm of 1900",
    });
    expect(o.oaiDcXml.match(/<dc:relation>/g)).toHaveLength(1);
    expect(o.oaiDcXml).not.toMatch(/<dc:relation\s*\/>|<dc:relation><\/dc:relation>/);
  });

  it("leaves the term out of every form when no link in a list may be named", () => {
    const a = withKey(record("agent", privateName, {}));
    const b = withKey(record("event", "SECRET-event", {}));
    const { item, all, checkers } = linking(
      {
        related: [
          { recordId: a.id, label: privateName },
          { recordId: b.id, label: "SECRET-event-label" },
        ],
      },
      a,
      b,
    );
    const o = ok(output(viewOf(all, item.id, checkers), [item.id], checkers));
    expectNothingOf(everything(o), a, b);
    expect(o.dublinCore.relation).toBeUndefined();
    expect(o.jsonLd["dcterms:relation"]).toBeUndefined();
    expect(o.oaiDcXml).not.toContain("dc:relation");
  });

  it("puts out nothing for a held-back-kind target published without the records", () => {
    // An object can't be shown to be clear of deed holds without `records`
    // (D-043), so its link is treated as unpublished: nothing goes out.
    const other = withKey(record("object", "SECRET-held-object", { rights: { uri: CNE } }));
    const { item, all, checkers } = linking(
      { related: [{ recordId: other.id, label: "SECRET-held-label" }] },
      other,
    );
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, other.id], checkers));
    expectNothingOf(everything(o), other);
  });

  it("never holds a link label in the public view, even to a published record", () => {
    const agent = withKey(record("agent", "Photographer", {}));
    const { item, all, checkers } = linking(
      { creator: { recordId: agent.id, label: "SECRET-view-label" } },
      agent,
    );
    const view = viewOf(all, item.id, checkers);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view.fields.creator).toBeUndefined();
    // Output adds it, because the record may be named.
    const o = ok(output(view, [item.id, agent.id], checkers));
    expect(o.jsonLd["dcterms:creator"]).toEqual({
      "@id": BASE + agent.id,
      "rdfs:label": "SECRET-view-label",
    });
  });
});

describe("D-048: a place value shows its name only when its place record is vouched for", () => {
  // A template edit made a record_link field a place. The stored value
  // { recordId, label } still fits a place, but its label is a record link's
  // label, here copied from an unpublished donor agent.
  const PLACE_TPL = template(
    [
      ...FIELDS.filter((f) => f.key !== "creator"),
      field({ key: "creator", label: "Creator", kind: "place" }),
    ] satisfies readonly FieldDefinition[],
    "links",
  );
  const PLACE_MAPPING = {
    organizationId: ORG,
    template: "links",
    entries: [
      { field: "rights", term: "rights" },
      { field: "creator", term: "spatial" },
      { field: "places", term: "coverage" },
    ],
  };

  function publish(records: CatalogRecord[], id: RecordId, checkers: Record<string, unknown>) {
    const effective = ok(effectiveRecord(id, records, () => PLACE_TPL, { checkers: checkers }));
    const view = publicView(effective);
    if (view === undefined) throw new Error("no view");
    const result = publicOutput(view, PLACE_MAPPING, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: records.map((r) => r.id),
      checkers: checkers,
    });
    return { effective, view, result };
  }

  it("withholds a record link's label left in a field made a place, with no place checker", () => {
    const donor = withKey(record("agent", "SECRET-donor-name", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: donor.id, label: "SECRET-donor-name" },
      }),
    );
    const { effective, view, result } = publish([donor, item], item.id, { ...CHECKERS });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view.fields.creator).toBeUndefined();
    const o = ok(result);
    expectNothingOf(everything(o), donor);
    expect(o.dublinCore.spatial).toBeUndefined();
    // Staff still see it.
    expect(effective.fields.creator).toEqual({ recordId: donor.id, label: "SECRET-donor-name" });
  });

  it("withholds it when a lax place checker lets a non-place record through", () => {
    const donor = withKey(record("agent", "SECRET-donor-name", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: donor.id, label: "SECRET-donor-name" },
      }),
    );
    const { view, result } = publish([donor, item], item.id, { ...CHECKERS, place: lax });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expectNothingOf(everything(ok(result)), donor);
  });

  it("withholds it with the organization's place checker, which knows the record isn't a place", () => {
    const donor = withKey(record("agent", "SECRET-donor-name", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: donor.id, label: "SECRET-donor-name" },
      }),
    );
    const all = [donor, item];
    const { view, result } = publish(all, item.id, { ...CHECKERS, place: linkChecker(all) });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    // Left out of the view, so output never sees it (the checker refuses it when saving).
    expectNothingOf(everything(ok(result)), donor);
  });

  it("keeps only the vouched places of a list, with the name of an unpublished place record", () => {
    const place = withKey(record("place", "Dickinson", {}));
    const donor = withKey(record("agent", "SECRET-donor-name", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        places: [
          { label: "Dickinson (Tex.)", recordId: place.id },
          { label: "SECRET-donor-name", recordId: donor.id },
          { label: "Galveston Bay" },
        ],
      }),
    );
    const all = [place, donor, item];
    // Own values reach the view unchecked (D-013); the view still keeps
    // only the places the organization's place checker vouches for.
    const made = linkChecker(all);
    const effective = ok(
      effectiveRecord(item.id, all, () => PLACE_TPL, { checkers: { ...CHECKERS, place: made } }),
    );
    expect(effective.notes.map((n) => n.code)).toEqual([]);
    const view = publicView(effective);
    expect(view?.fields.places).toEqual([
      { label: "Dickinson (Tex.)" },
      { label: "Galveston Bay" },
    ]);
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });
});

describe("another organization's record is never linked or named", () => {
  const otherOrg = newOrganizationId();
  const theirs = {
    ...record("agent", "SECRET-other-org-agent", { description: "SECRET-other-org-value" }),
    organizationId: otherOrg,
  } as CatalogRecord;
  const theirPlace = {
    ...record("place", "SECRET-other-org-place", {}),
    organizationId: otherOrg,
  } as CatalogRecord;

  function ours(): CatalogRecord {
    return withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: theirs.id, label: "Their agent" },
        places: [{ label: "Their place", recordId: theirPlace.id }],
      }),
    );
  }

  it("refuses the link when saving, without saying whose ID it is", () => {
    const item = ours();
    const links = linkChecker([item]);
    const problems = checkRecordAgainstTemplate(item, LINK_TPL, {
      checkers: { ...CHECKERS, record_link: links, place: links },
    });
    expect(problems.map((p) => p.code)).toEqual(["unknown_record", "unknown_record"]);
    expectNothingOf(JSON.stringify(problems), theirs, theirPlace);
  });

  it("refuses to publish it, though their ID is in the published list", () => {
    const item = ours();
    const links = linkChecker([item]);
    const checkers = { ...CHECKERS, record_link: links, place: links };
    const result = output(
      viewOf([item], item.id, checkers),
      [item.id, theirs.id, theirPlace.id],
      checkers,
    );
    // The place value isn't vouched for, so the view never held it (D-048);
    // the record link is still refused.
    expect(codes(result)).toEqual(["unknown_record"]);
    expectNothingOf(JSON.stringify(result), theirs, theirPlace);
  });

  it("gives nothing, not even the label, when a lax checker lets their ID through", () => {
    const item = ours();
    const checkers = { ...CHECKERS, record_link: lax, place: lax };
    const o = ok(
      output(viewOf([item], item.id, checkers), [item.id, theirs.id, theirPlace.id], checkers),
    );
    expect(o.dublinCore.creator).toBeUndefined();
    expect(everything(o)).not.toContain("Their agent");
    expectNothingOf(everything(o), theirs, theirPlace);
  });

  it("gives nothing for a place with no place checker, though their ID is published (D-048)", () => {
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        places: [{ label: "Their place", recordId: theirPlace.id }],
      }),
    );
    const o = ok(output(viewOf([item], item.id, CHECKERS), [item.id, theirPlace.id], CHECKERS));
    expect(o.jsonLd["dcterms:spatial"]).toBeUndefined();
    expect(everything(o)).not.toContain("Their place");
    expectNothingOf(everything(o), theirPlace);
  });

  it("refuses a checker made from their records, at save and at publish", () => {
    const item = ours();
    const theirLinks = linkChecker([theirs, theirPlace]);
    const problems = checkRecordAgainstTemplate(item, LINK_TPL, {
      checkers: { ...CHECKERS, record_link: theirLinks, place: theirLinks },
    });
    expect(problems.map((p) => p.code)).toEqual([
      "wrong_organization_checker",
      "wrong_organization_checker",
    ]);
    const plain = withKey(record("object", "Plain", { rights: { uri: CNE } }));
    for (const kind of ["record_link", "place"]) {
      const checkers = { ...CHECKERS, [kind]: theirLinks };
      expect(
        codes(output(viewOf([plain], plain.id, CHECKERS), [plain.id, theirs.id], checkers)),
      ).toEqual(["wrong_organization_checker"]);
    }
  });

  it("refuses to make a checker from a set holding both organizations' records", () => {
    const item = ours();
    expect(codes(makeRecordLinkChecker([item, theirs]))).toEqual(["mixed_organizations"]);
    expect(codes(makeRecordLinkChecker([theirPlace, item]))).toEqual(["mixed_organizations"]);
    expect(codes(indexRecords([item, theirs]))).toEqual(["mixed_organizations"]);
  });
});

describe("a link is named only when everything vouches for it", () => {
  function setup() {
    const agent = secretAgent();
    const event = withKey(record("event", "SECRET-event", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "Photographer" },
        related: [{ recordId: event.id, label: "An event" }],
      }),
    );
    return { agent, event, item, all: [agent, event, item] };
  }

  it("gives nothing when a lax record_link checker is used, even for a published target", () => {
    const { agent, event, item, all } = setup();
    const checkers = { ...CHECKERS, record_link: lax };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, agent.id, event.id], checkers));
    expectNothingOf(everything(o), agent, event);
    expect(everything(o)).not.toContain("Photographer");
    expect(everything(o)).not.toContain("An event");
  });

  it("gives nothing when the made checker is passed for the other kind only", () => {
    const { agent, event, item, all } = setup();
    const links = linkChecker(all);
    // Only checkers.place is the made one; record_link values are checked laxly.
    const checkers = { ...CHECKERS, record_link: lax, place: links };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, agent.id, event.id], checkers));
    expectNothingOf(everything(o), agent, event);
    expect(everything(o)).not.toContain("Photographer");
  });

  it("gives nothing for a target of a kind the field doesn't allow, with a lax checker", () => {
    const { event, item } = setup();
    const r = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: event.id, label: "An event as creator" },
      }),
    );
    const links = linkChecker([event, item, r]);
    // The made checker refuses it outright.
    const strict = { ...CHECKERS, record_link: links };
    expect(codes(output(viewOf([event, r], r.id, CHECKERS), [r.id, event.id], strict))).toEqual([
      "wrong_record_kind",
    ]);
    // A lax checker lets the value through, but output still won't name it.
    const laxCheckers = { ...CHECKERS, record_link: lax };
    const o = ok(output(viewOf([event, r], r.id, laxCheckers), [r.id, event.id], laxCheckers));
    expectNothingOf(everything(o), event);
    expect(everything(o)).not.toContain("An event as creator");
  });

  it("never links a record to itself", () => {
    const id = newRecordId();
    const r = withKey(
      record(
        "object",
        "Self",
        { rights: { uri: CNE }, related: [{ recordId: id, label: "Self link label" }] },
        {},
        id,
      ),
    );
    const checkers = { ...CHECKERS, record_link: lax };
    const o = ok(output(viewOf([r], id, checkers), [id], checkers));
    expect(o.jsonLd["dcterms:relation"]).toBeUndefined();
    expect(everything(o)).not.toContain("Self link label");
  });

  it("uses the checker's snapshot: a record added to the caller's list later isn't vouched for", () => {
    const { agent, item, event } = setup();
    const list: CatalogRecord[] = [item, event];
    const links = linkChecker(list);
    list.push(agent);
    const checkers = { ...CHECKERS, record_link: links };
    expect(
      codes(output(viewOf([agent, event, item], item.id, checkers), [item.id, agent.id], checkers)),
    ).toEqual(["unknown_record"]);
  });
});

describe("hostile values and options", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).recordId;
    delete (Object.prototype as Record<string, unknown>).record_link;
    delete (Object.prototype as Record<string, unknown>).place;
  });

  it("does not read a recordId or a checker from Object.prototype", () => {
    const agent = secretAgent();
    const place = withKey(record("place", "SECRET-place", {}));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        places: [{ label: "Dickinson" }],
      }),
    );
    const all = [agent, place, item];
    const links = linkChecker(all);
    const view = viewOf(all, item.id, CHECKERS);
    (Object.prototype as Record<string, unknown>).recordId = place.id;
    (Object.prototype as Record<string, unknown>).record_link = links;
    (Object.prototype as Record<string, unknown>).place = links;
    const o = ok(output(view, [item.id, place.id, agent.id], { ...CHECKERS }));
    expect(o.jsonLd["dcterms:spatial"]).toEqual({ "rdfs:label": "Dickinson" });
    expectNothingOf(everything(o), agent, place);
  });

  it("refuses extra properties smuggled into a link value", () => {
    const agent = secretAgent();
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "Photographer", title: "SECRET-smuggled" },
      }),
    );
    const all = [agent, item];
    const links = linkChecker(all);
    const checkers = { ...CHECKERS, record_link: links };
    const result = output(viewOf(all, item.id, checkers), [item.id, agent.id], checkers);
    expect(codes(result)).toEqual(["does_not_fit_field"]);
  });

  it("refuses a checker given behind a getter", () => {
    const item = withKey(record("object", "Postcard", { rights: { uri: CNE } }));
    const links = linkChecker([item]);
    const checkers = { ...CHECKERS };
    Object.defineProperty(checkers, "record_link", { get: () => links, enumerable: true });
    expect(codes(output(viewOf([item], item.id, CHECKERS), [item.id], checkers))).toEqual([
      "invalid_options",
    ]);
  });

  it("never throws for hostile input to the checker", () => {
    const item = withKey(record("object", "Postcard", { rights: { uri: CNE } }));
    const links = linkChecker([item]);
    const def = field({ key: "creator", kind: "record_link" });
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(links(hostile as never, def, item).map((p) => p.code)).toEqual(["unreadable"]);
    expect(links({ recordId: item.id, label: "x" }, def, null as never).map((p) => p.code)).toEqual(
      ["unreadable"],
    );
    expect(
      links({ recordId: item.id, label: "x" }, hostile as never, item).map((p) => p.code),
    ).toEqual(["unreadable"]);
  });
});

describe("a value kept from before a template change never reaches the public view", () => {
  // Each field was once another kind; the template now makes it public text
  // (templateChanges reports only kind_changed). The stored value still has
  // the old shape, with a linked ID, an identifier type or a rights note.
  const secretId = newRecordId();
  const RIGHTS_DEF = field({ key: "rights", label: "Rights", kind: "rights" });
  const probes: readonly [string, boolean, unknown][] = [
    ["record link", false, { recordId: secretId, label: "Linked" }],
    ["list of record links", true, [{ recordId: secretId, label: "Linked" }]],
    ["place", true, [{ label: "Somewhere", recordId: secretId }]],
    ["identifier", false, { type: "SECRET_donor_file", value: "SECRET-42" }],
    ["rights", false, { uri: CNE, note: "SECRET-rights-note" }],
  ];

  for (const [name, repeatable, stored] of probes) {
    it(`holds back a ${name} value left in a field now made text`, () => {
      const rights = RIGHTS_DEF;
      const now = template([rights, field({ key: "kept", repeatable })], "changed");
      const item = {
        ...record("object", "Postcard", { rights: { uri: CNE }, kept: stored as never }),
        templateKey: "changed",
      } as CatalogRecord;
      const effective = ok(effectiveRecord(item.id, [item], () => now, { checkers: CHECKERS }));
      const view = publicView(effective);
      if (view === undefined) throw new Error("no view");
      const text = JSON.stringify(view);
      expect(view.fields.kept).toBeUndefined();
      expect(text).not.toContain(secretId);
      expect(text).not.toContain("SECRET");
      expect(effective.notes.map((n) => [n.code, n.path])).toEqual([
        ["does_not_fit_field", ["fields", "kept"]],
      ]);
      expect(JSON.stringify(effective.notes)).not.toContain("SECRET");
      expect(effectivePublishIssues(effective).map((i) => i.code)).toEqual(["does_not_fit_field"]);
      const mapping = {
        organizationId: ORG,
        template: "changed",
        entries: [
          { field: "rights", term: "rights" },
          { field: "kept", term: "description" },
        ],
      };
      const result = publicOutput(view, mapping, {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [item.id, secretId],
        checkers: CHECKERS,
      });
      expect(codes(result)).toEqual(["does_not_fit_field"]);
      expect(JSON.stringify(result)).not.toContain(secretId);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });
  }

  it("holds back a rights value with a smuggled property, keeping its note out", () => {
    const item = {
      ...record("object", "Postcard", {
        rights: { uri: CNE, note: "SECRET-note", recordId: secretId },
      }),
      templateKey: "changed",
    } as CatalogRecord;
    const now = template([RIGHTS_DEF], "changed");
    const effective = ok(effectiveRecord(item.id, [item], () => now, { checkers: CHECKERS }));
    const text = JSON.stringify(publicView(effective));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(secretId);
    expect(effectivePublishIssues(effective).length).toBeGreaterThan(0);
  });

  it("still publishes a value that fits the field as it is now", () => {
    const now = template([RIGHTS_DEF, field({ key: "kept" })], "changed");
    const item = {
      ...record("object", "Postcard", { rights: { uri: CNE }, kept: "Plain text" }),
      templateKey: "changed",
    } as CatalogRecord;
    const effective = ok(effectiveRecord(item.id, [item], () => now, { checkers: CHECKERS }));
    expect(publicView(effective)?.fields.kept).toBe("Plain text");
    expect(effectivePublishIssues(effective, { accessions: accessionsFor(effective) })).toEqual([]);
  });
});

describe("the checker's organization (T-015a review)", () => {
  function linked() {
    const agent = withKey(record("agent", "Dickinson, John", { rights: { uri: CNE } }));
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        creator: { recordId: agent.id, label: "SECRET-label" },
        places: [{ label: "SECRET-place-name", recordId: newRecordId() }],
      }),
    );
    return { agent, item, all: [agent, item] };
  }

  it("takes another organization from its invalid records, and is refused", () => {
    const { item, all } = linked();
    const other = newOrganizationId();
    const invalid = {
      ...record("agent", "SECRET-foreign", {}, { organizationId: other }),
      title: "",
    };
    const foreign = ok(makeRecordLinkChecker([invalid]));
    const checkers = { ...CHECKERS, record_link: foreign, place: foreign };
    const checked = checkRecordAgainstTemplate(item, LINK_TPL, { checkers });
    expect(checked.map((i) => i.code)).toContain("wrong_organization_checker");
    const view = viewOf(all, item.id, { ...CHECKERS, record_link: linkChecker(all) });
    const result = output(view, [item.id], checkers);
    expect(codes(result)).toEqual(["wrong_organization_checker"]);
    expect(JSON.stringify(result)).not.toContain(other);
  });

  it("refuses records of another organization than the one given", () => {
    const { all } = linked();
    const other = newOrganizationId();
    const result = makeRecordLinkChecker(all, other);
    expect(codes(result)).toEqual(["wrong_organization"]);
    expect(JSON.stringify(result)).not.toContain(ORG);
    expect(JSON.stringify(result)).not.toContain(other);
    const invalid = {
      ...record("agent", "x", {}, { organizationId: other }),
      title: "",
    };
    expect(codes(makeRecordLinkChecker([invalid], ORG))).toEqual(["wrong_organization"]);
    expect(codes(makeRecordLinkChecker(all, "not-an-org"))).toEqual(["invalid_organization"]);
    expect(makeRecordLinkChecker(all, ORG).ok).toBe(true);
  });

  it("a checker of no organization vouches for nothing anywhere", () => {
    const { item, all } = linked();
    const none = ok(makeRecordLinkChecker([]));
    const checkers = { ...CHECKERS, record_link: none, place: none };
    expect(checkRecordAgainstTemplate(item, LINK_TPL, { checkers }).map((i) => i.code)).toContain(
      "no_organization_checker",
    );
    // effectiveRecord: the place name it can't vouch for is left out of the view.
    const effective = ok(effectiveRecord(item.id, all, () => LINK_TPL, { checkers }));
    const view = publicView(effective);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    // publicOutput: refused or empty of the link, never the label or the ID.
    const good = viewOf(all, item.id, { ...CHECKERS, record_link: linkChecker(all) });
    const result = output(good, [item.id, all[0]?.id ?? item.id], checkers);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(all[0]?.id ?? "?");
  });
});
