// Attack tests for links between records (T-015, D-039): trying to get an
// unpublished or another organization's record ID, title or values into
// public output through a record_link or a place's recordId.
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
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
  BASE,
  CHECKERS,
  CNE,
  FIELDS,
  everything,
  field,
  linkChecker,
  record,
  template,
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
  return publicOutput(view, MAPPING, { baseUrl: BASE, published, checkers: checkers });
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
    expect(o.dublinCore.creator).toEqual(["Unknown photographer"]);
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
    expect(o.dublinCore.subject).toEqual(["The family"]);
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
    expect(codes(result)).toEqual(["unknown_record", "unknown_record"]);
    expectNothingOf(JSON.stringify(result), theirs, theirPlace);
  });

  it("gives the label only when a lax checker lets their ID through", () => {
    const item = ours();
    const checkers = { ...CHECKERS, record_link: lax, place: lax };
    const o = ok(
      output(viewOf([item], item.id, checkers), [item.id, theirs.id, theirPlace.id], checkers),
    );
    expect(o.dublinCore.creator).toEqual(["Their agent"]);
    expectNothingOf(everything(o), theirs, theirPlace);
  });

  it("gives the label only for a place with no place checker, though their ID is published", () => {
    const item = withKey(
      record("object", "Postcard", {
        rights: { uri: CNE },
        places: [{ label: "Their place", recordId: theirPlace.id }],
      }),
    );
    const o = ok(output(viewOf([item], item.id, CHECKERS), [item.id, theirPlace.id], CHECKERS));
    expect(o.jsonLd["dcterms:spatial"]).toEqual({ "rdfs:label": "Their place" });
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

  it("gives the label only when a lax record_link checker is used, even for a published target", () => {
    const { agent, event, item, all } = setup();
    const checkers = { ...CHECKERS, record_link: lax };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, agent.id, event.id], checkers));
    expectNothingOf(everything(o), agent, event);
  });

  it("gives the label only when the made checker is passed for the other kind only", () => {
    const { agent, event, item, all } = setup();
    const links = linkChecker(all);
    // Only checkers.place is the made one; record_link values are checked laxly.
    const checkers = { ...CHECKERS, record_link: lax, place: links };
    const o = ok(output(viewOf(all, item.id, checkers), [item.id, agent.id, event.id], checkers));
    expectNothingOf(everything(o), agent, event);
  });

  it("gives the label only for a target of a kind the field doesn't allow, with a lax checker", () => {
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
  });

  it("never links a record to itself", () => {
    const id = newRecordId();
    const r = withKey(
      record(
        "object",
        "Self",
        { rights: { uri: CNE }, related: [{ recordId: id, label: "Me" }] },
        {},
        id,
      ),
    );
    const checkers = { ...CHECKERS, record_link: lax };
    const o = ok(output(viewOf([r], id, checkers), [id], checkers));
    expect(o.jsonLd["dcterms:relation"]).toBe("Me");
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
    expect(codes(result)).toEqual(["unknown_property"]);
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
