import { describe, expect, it } from "vitest";
import {
  DIGITAL_ASSET_DUBLIN_CORE,
  DIGITAL_ASSET_PRESET,
  DCTERMS_NAMESPACE,
  DCMITYPE_NAMESPACE,
  OAI_DC_NAMESPACE,
  RDFS_NAMESPACE,
  effectivePublishIssues,
  newRecordId,
  publicOutput,
  type PublicOutput,
  type PublicRecord,
  type RecordId,
  type Validated,
} from "./index.js";
import {
  BASE,
  ORG,
  CNE,
  LCSH,
  MAPPING,
  TPL,
  effectiveOf,
  everything,
  field,
  record,
  template,
  viewOf,
  idsOf,
  CHECKERS,
  RIGHTS_ENTRY,
} from "./public-output.fixtures.js";

function ok(result: Validated<PublicOutput>): PublicOutput {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function out(
  view: PublicRecord,
  published: readonly RecordId[] = [view.id],
  mapping: unknown = MAPPING,
) {
  return publicOutput(view, mapping, {
    baseUrl: BASE,
    published,
    checkers: CHECKERS,
    identifiers: idsOf(view),
  });
}

const PLACE_ID = newRecordId();

/** An object with a value in every mapped field. */
function fullObject(id: RecordId = newRecordId()) {
  return record(
    "object",
    "Dickinson Station and Park",
    {
      rights: { uri: CNE, note: "Ask at the front desk." },
      description: "A postcard of the station.",
      date: "1909~",
      access: "open_code",
      subjects: [{ label: "Railroads", uri: LCSH, vocabulary: "lcsh" }, { label: "Parks" }],
      number: { type: "accession_number", value: "2026.015" },
      website: { url: "https://example.org/station", label: "More" },
      places: [{ label: "Dickinson (Tex.)", recordId: PLACE_ID }],
      creator: "Unknown photographer",
      extent: "1 postcard",
      holder: "The Society",
    },
    {},
    id,
  );
}

describe("publicOutput: the three forms", () => {
  const item = fullObject();
  const view = viewOf([item], item.id);
  const url = BASE + item.id;

  it("gives Dublin Core as term to values, title first, in mapping order", () => {
    const o = ok(out(view));
    expect(o.id).toBe(url);
    expect(o.dublinCore).toEqual({
      title: ["Dickinson Station and Park"],
      identifier: [url, "2026.015"],
      type: ["http://purl.org/dc/dcmitype/PhysicalObject"],
      rights: [CNE],
      description: ["A postcard of the station."],
      created: ["1909~"],
      accessRights: ["Open to all"],
      subject: ["Railroads", "Parks"],
      relation: ["https://example.org/station"],
      spatial: ["Dickinson (Tex.)"],
      creator: ["Unknown photographer"],
      rightsHolder: ["The Society"],
    });
    expect(Object.keys(o.dublinCore).slice(0, 3)).toEqual(["title", "identifier", "type"]);
    expect(Object.isFrozen(o.dublinCore)).toBe(true);
    expect(Object.isFrozen(o)).toBe(true);
  });

  it("gives compacted JSON-LD with an inline context, @id and @type", () => {
    const o = ok(out(view));
    expect(o.jsonLd).toEqual({
      "@context": {
        dcterms: DCTERMS_NAMESPACE,
        dcmitype: DCMITYPE_NAMESPACE,
        rdfs: RDFS_NAMESPACE,
      },
      "@id": url,
      "@type": "dcmitype:PhysicalObject",
      "dcterms:title": "Dickinson Station and Park",
      "dcterms:rights": { "@id": CNE },
      "dcterms:description": "A postcard of the station.",
      "dcterms:created": "1909~",
      "dcterms:accessRights": { "rdfs:label": "Open to all" },
      "dcterms:subject": [{ "@id": LCSH, "rdfs:label": "Railroads" }, "Parks"],
      "dcterms:identifier": "2026.015",
      "dcterms:relation": { "@id": "https://example.org/station" },
      "dcterms:spatial": { "rdfs:label": "Dickinson (Tex.)" },
      "dcterms:creator": { "rdfs:label": "Unknown photographer" },
      "dcterms:rightsHolder": { "rdfs:label": "The Society" },
    });
    expect(Object.keys(o.jsonLd).slice(0, 3)).toEqual(["@context", "@id", "@type"]);
    expect(JSON.parse(o.jsonLdText)).toEqual(o.jsonLd);
  });

  it("gives oai_dc XML with refined terms written as the element they refine", () => {
    const o = ok(out(view));
    expect(o.oaiDcXml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<oai_dc:dc xmlns:oai_dc="${OAI_DC_NAMESPACE}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${OAI_DC_NAMESPACE} http://www.openarchives.org/OAI/2.0/oai_dc.xsd">`,
        "  <dc:title>Dickinson Station and Park</dc:title>",
        `  <dc:identifier>${url}</dc:identifier>`,
        "  <dc:identifier>2026.015</dc:identifier>",
        "  <dc:type>http://purl.org/dc/dcmitype/PhysicalObject</dc:type>",
        `  <dc:rights>${CNE}</dc:rights>`,
        "  <dc:description>A postcard of the station.</dc:description>",
        "  <dc:date>1909~</dc:date>",
        "  <dc:rights>Open to all</dc:rights>",
        "  <dc:subject>Railroads</dc:subject>",
        "  <dc:subject>Parks</dc:subject>",
        "  <dc:relation>https://example.org/station</dc:relation>",
        "  <dc:coverage>Dickinson (Tex.)</dc:coverage>",
        "  <dc:creator>Unknown photographer</dc:creator>",
        "</oai_dc:dc>",
        "",
      ].join("\n"),
    );
    // rightsHolder refines no DC element, so it is in the other forms only.
    expect(o.oaiDcXml).not.toContain("The Society");
  });

  it("leaves out public fields the mapping doesn't map", () => {
    expect(everything(ok(out(view)))).not.toContain("1 postcard");
  });

  it("outputs a list choice as its label, never its stored code", () => {
    expect(everything(ok(out(view)))).not.toContain("open_code");
  });

  it("outputs an identifier's value only, never its type", () => {
    expect(everything(ok(out(view)))).not.toContain("accession_number");
  });

  it("outputs the rights URI and not the rights note", () => {
    const all = everything(ok(out(view)));
    expect(all).toContain(CNE);
    expect(all).not.toContain("front desk");
  });

  it("does not output a term's vocabulary code or a link's label", () => {
    const all = everything(ok(out(view)));
    expect(all).not.toContain("lcsh");
    expect(all).not.toContain("More");
  });

  it("gives the same output each time", () => {
    expect(ok(out(view))).toEqual(ok(out(view)));
  });

  it("puts several fields mapped to one term together, in mapping order", () => {
    const mapping = {
      template: "out",
      entries: [
        RIGHTS_ENTRY,
        { field: "creator", term: "description" },
        { field: "description", term: "description" },
        { field: "description", term: "abstract" },
      ],
    };
    const o = ok(out(view, [view.id], mapping));
    expect(o.dublinCore.description).toEqual([
      "Unknown photographer",
      "A postcard of the station.",
    ]);
    expect(o.jsonLd["dcterms:abstract"]).toBe("A postcard of the station.");
    expect(o.oaiDcXml.match(/<dc:description>/g)).toHaveLength(3);
  });

  it("puts a mapped title field after the record's own title", () => {
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, { field: "extent", term: "title" }],
    };
    expect(ok(out(view, [view.id], mapping)).dublinCore.title).toEqual([
      "Dickinson Station and Park",
      "1 postcard",
    ]);
  });

  it("leaves out a mapped field with no value", () => {
    const bare = record("object", "Bare", { rights: { uri: CNE } });
    const o = ok(out(viewOf([bare], bare.id)));
    expect(o.dublinCore).toEqual({
      title: ["Bare"],
      identifier: [BASE + bare.id],
      type: ["http://purl.org/dc/dcmitype/PhysicalObject"],
      rights: [CNE],
    });
  });
});

describe("publicOutput: places and the published list", () => {
  it("links a place record that is published", () => {
    const item = fullObject();
    const o = ok(out(viewOf([item], item.id), [item.id, PLACE_ID]));
    expect(o.jsonLd["dcterms:spatial"]).toEqual({
      "@id": BASE + PLACE_ID,
      "rdfs:label": "Dickinson (Tex.)",
    });
    expect(o.dublinCore.spatial).toEqual(["Dickinson (Tex.)"]);
  });

  it("gives an unpublished place record's name only, never its ID", () => {
    const item = fullObject();
    const o = ok(out(viewOf([item], item.id), [item.id]));
    expect(everything(o)).not.toContain(PLACE_ID);
    expect(o.jsonLd["dcterms:spatial"]).toEqual({ "rdfs:label": "Dickinson (Tex.)" });
  });

  it("prefers a place's gazetteer URI to a record link", () => {
    const gnis = "https://edits.nationalmap.gov/apps/gaz-domestic/public/summary/1356108";
    const item = record("object", "P", {
      rights: { uri: CNE },
      places: [{ label: "Dickinson", uri: gnis, recordId: PLACE_ID }],
    });
    const o = ok(out(viewOf([item], item.id), [item.id, PLACE_ID]));
    expect(o.jsonLd["dcterms:spatial"]).toEqual({ "@id": gnis, "rdfs:label": "Dickinson" });
    expect(everything(o)).not.toContain(PLACE_ID);
  });

  it("refuses a record that is not in the published list", () => {
    const item = fullObject();
    expect(codes(out(viewOf([item], item.id), [PLACE_ID]))).toEqual(["not_published"]);
    expect(codes(out(viewOf([item], item.id), []))).toEqual(["not_published"]);
  });

  it("refuses a published list with something other than record IDs", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    for (const published of [
      [view.id, "nope"],
      [view.id, 1],
      "x",
      null,
      undefined,
      new Set([view.id]),
    ]) {
      expect(codes(publicOutput(view, MAPPING, { baseUrl: BASE, published } as never))).toEqual([
        "invalid_published",
      ]);
    }
  });
});

describe("publicOutput: @type by kind", () => {
  function typeOf(kind: Parameters<typeof record>[0], extra: Record<string, unknown> = {}) {
    const r = record(
      kind,
      "R",
      kind === "agent" || kind === "place" || kind === "event" ? {} : { rights: { uri: CNE } },
      extra,
    );
    return ok(out(viewOf([r], r.id))).jsonLd["@type"];
  }

  it("uses DCMI Type and DCMI Metadata Terms classes", () => {
    expect(typeOf("object")).toBe("dcmitype:PhysicalObject");
    expect(typeOf("event")).toBe("dcmitype:Event");
    expect(typeOf("agent")).toBe("dcterms:Agent");
    expect(typeOf("place")).toBe("dcterms:Location");
  });

  it("makes archival units above item level Collections, and claims nothing for items", () => {
    for (const level of ["fonds", "series", "collection", "file"]) {
      expect(typeOf("archival_unit", { level })).toBe("dcmitype:Collection");
    }
    expect(typeOf("archival_unit", { level: "item" })).toBeUndefined();
  });

  it("claims no type for a digital asset, whose media type is not output", () => {
    const r = record("digital_asset", "Scan", { rights: { uri: CNE } });
    const o = ok(out(viewOf([r], r.id)));
    expect(o.jsonLd["@type"]).toBeUndefined();
    expect(everything(o)).not.toContain("image/tiff");
  });

  it("publishes agents, places and events without rights", () => {
    const agent = record("agent", "Dickinson Historical Society", { creator: "x" });
    expect(ok(out(viewOf([agent], agent.id))).dublinCore.creator).toEqual(["x"]);
  });
});

describe("publicOutput: inheritance", () => {
  it("outputs public inherited values and the record's own", () => {
    const fonds = record(
      "archival_unit",
      "Fonds F1",
      { rights: { uri: CNE }, creator: "The Society" },
      { level: "fonds" },
    );
    const item = record(
      "archival_unit",
      "Item",
      { description: "Own" },
      { level: "item", parentId: fonds.id },
    );
    const o = ok(out(viewOf([item, fonds], item.id)));
    expect(o.dublinCore).toEqual({
      title: ["Item"],
      identifier: [BASE + item.id],
      rights: [CNE],
      description: ["Own"],
      creator: ["The Society"],
    });
    // The parent isn't published (D-016: its public values may still be
    // published on a published child), and nothing names it.
    expect(everything(o)).not.toContain(fonds.id);
    expect(everything(o)).not.toContain("Fonds F1");
  });
});

describe("publicOutput: refusals", () => {
  it("refuses a record whose rights can't be published, with the publish check's issues", () => {
    const item = record("object", "No rights", { description: "x" });
    const effective = effectiveOf([item], item.id);
    const view = viewOf([item], item.id);
    const result = out(view);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toEqual(effectivePublishIssues(effective));
    expect(codes(result)).toEqual(["rights_missing"]);
  });

  it("refuses a record with a left-over rights value it can't publish", () => {
    const noRights = template(TPL.fields.filter((f) => f.key !== "rights"));
    const item = record("object", "Left-over rights", { rights: { uri: CNE } });
    // This template has no rights field, so no valid mapping can map one: the
    // publish check runs first and says why (rights_not_mapped would follow).
    const valid = { template: "out", entries: [{ field: "creator", term: "creator" }] };
    const withRights = { template: "out", entries: [RIGHTS_ENTRY] };
    for (const mapping of [valid, withRights]) {
      expect(codes(out(viewOf([item], item.id, noRights), [item.id], mapping))).toEqual([
        "rights_not_public",
      ]);
    }
  });

  it("refuses an invalid mapping with its issues", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    expect(
      codes(
        out(view, [view.id], {
          template: "out",
          entries: [RIGHTS_ENTRY, { field: "x", term: "title" }],
        }),
      ),
    ).toEqual(["unknown_field"]);
    expect(
      codes(
        out(view, [view.id], {
          template: "out",
          entries: [{ field: "creator", term: "dc:creator" }],
        }),
      ),
    ).toEqual(["unknown_term"]);
    expect(codes(out(view, [view.id], null))).toEqual(["not_an_object"]);
  });

  it("refuses own values of the wrong shape for their kind, naming the field", () => {
    const bad: Record<string, unknown>[] = [
      { description: { text: "x" } },
      { description: ["x"] },
      { date: "sometime in 1909" },
      { access: "not_an_option" },
      { access: "Open to all" },
      { subjects: { label: "not a list" } },
      { subjects: ["just text"] },
      { subjects: [{ label: "x", uri: "ftp://example.org/x" }] },
      { subjects: [{ label: "x", note: "extra" }] },
      { subjects: [{ label: " " }] },
      { number: "2026.015" },
      { number: { value: "2026.015" } },
      { number: { type: "a", value: "1", note: "x" } },
      { website: { label: "no url" } },
      { website: { url: "javascript:alert(1)" } },
      { website: { url: "https://user:pass@example.org/" } },
      { website: { url: "https://example.org/a b" } },
      { places: [{ label: "x", recordId: "not-an-id" }] },
      { places: [{ uri: "https://example.org/" }] },
    ];
    for (const fields of bad) {
      const item = record("object", "Bad", { rights: { uri: CNE }, ...fields });
      const result = out(viewOf([item], item.id));
      expect(result.ok, JSON.stringify(fields)).toBe(false);
      const key = Object.keys(fields)[0];
      expect(result.ok ? undefined : result.issues[0]?.path.slice(0, 2)).toEqual(["fields", key]);
    }
  });

  it("refuses a rights value with extra properties through the publish check", () => {
    const item = record("object", "Bad", { rights: { uri: CNE, extra: 1 } });
    expect(codes(out(viewOf([item], item.id)))).toEqual(["unknown_property"]);
  });

  it("refuses a field over its list and repeat limits", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ label: `t${String(i)}` }));
    const item = record("object", "Many", { rights: { uri: CNE }, subjects: tooMany });
    const result = out(viewOf([item], item.id));
    expect(result.ok ? undefined : result.issues[0]?.path.slice(0, 2)).toEqual([
      "fields",
      "subjects",
    ]);
  });

  it("accepts every kind's value when the template's field is single or repeatable as stored", () => {
    const tpl = template([
      field({ key: "rights", kind: "rights" }),
      field({ key: "dates", kind: "date", repeatable: true }),
    ]);
    const item = record("object", "Dates", { rights: { uri: CNE }, dates: ["1909", "1910/1912"] });
    const mapping = { template: "out", entries: [RIGHTS_ENTRY, { field: "dates", term: "date" }] };
    expect(ok(out(viewOf([item], item.id, tpl), [item.id], mapping)).dublinCore.date).toEqual([
      "1909",
      "1910/1912",
    ]);
  });
});

describe("publicOutput: the base URL", () => {
  const item = fullObject();
  const view = viewOf([item], item.id);

  it("accepts http and https base URLs ending in /", () => {
    for (const baseUrl of ["https://archive.example.org/", "http://localhost:8080/items/", BASE]) {
      expect(
        ok(
          publicOutput(view, MAPPING, {
            baseUrl,
            published: [view.id],
            checkers: CHECKERS,
            identifiers: idsOf(view),
          }),
        ).id,
      ).toBe(baseUrl + view.id);
    }
  });

  it("refuses anything else", () => {
    for (const baseUrl of [
      "https://archive.example.org/items",
      "https://archive.example.org/items/?a=1",
      "https://archive.example.org/items/?",
      "https://archive.example.org/items/#x",
      "https://user:pw@archive.example.org/",
      "https://user@archive.example.org/",
      "ftp://archive.example.org/",
      "javascript://archive.example.org/",
      "data:text/html,<b>/",
      "//archive.example.org/",
      "/items/",
      "HTTPS://ARCHIVE.example.org/",
      "https://archive.example.org/a/../b/",
      "https://archive.example.org:443/",
      "https://archive.example.org/a b/",
      "https://archive.example.org\\items/",
      "https://archive.example.org/" + String.fromCharCode(1) + "/",
      "https://archive.example.org/" + "a".repeat(2000) + "/",
      "",
      42,
      undefined,
    ]) {
      expect(
        codes(publicOutput(view, MAPPING, { baseUrl, published: [view.id] } as never)),
        String(baseUrl).slice(0, 60),
      ).toEqual(["invalid_base_url"]);
    }
  });
});

describe("publicOutput: the template check", () => {
  it("refuses own values the template refuses: too long, a line break in one-line text", () => {
    const long = `${"x".repeat(5000)}\n${"y".repeat(14)}`;
    const item = record("object", "Long", { rights: { uri: CNE }, extent: long });
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, { field: "extent", term: "extent" }],
    };
    const result = out(viewOf([item], item.id), [item.id], mapping);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.path.slice(0, 2))).toContainEqual([
      "fields",
      "extent",
    ]);
  });

  it("refuses an LCSH term whose URI is not an LC authority", () => {
    const item = record("object", "Evil", {
      rights: { uri: CNE },
      subjects: [{ label: "Railroads", uri: "http://evil.example/notlc", vocabulary: "lcsh" }],
    });
    const result = out(viewOf([item], item.id));
    expect(result.ok ? [] : result.issues.map((i) => i.path.slice(0, 2))).toContainEqual([
      "fields",
      "subjects",
    ]);
  });

  it("refuses identifier values when no identifier checker is given", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    const result = publicOutput(view, MAPPING, { baseUrl: BASE, published: [view.id] });
    expect(codes(result)).toContain("unchecked");
  });

  it("uses the caller's checkers, which replace the default for their kind", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    const refuse = () => [{ code: "no_thanks", message: "Refused." }];
    const result = publicOutput(view, MAPPING, {
      baseUrl: BASE,
      published: [view.id],
      checkers: { ...CHECKERS, long_text: refuse },
    });
    expect(codes(result)).toContain("no_thanks");
  });

  it("refuses checkers given as a Proxy or a getter", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    const proxy = { baseUrl: BASE, published: [view.id], checkers: new Proxy(CHECKERS, {}) };
    expect(codes(publicOutput(view, MAPPING, proxy))).toEqual(["invalid_options"]);
    const getter = { baseUrl: BASE, published: [view.id] };
    Object.defineProperty(getter, "checkers", { enumerable: true, get: () => CHECKERS });
    expect(codes(publicOutput(view, MAPPING, getter))).toEqual(["invalid_options"]);
  });
});

describe("publicOutput: rights must be mapped", () => {
  it("refuses an object, archival unit or digital asset whose rights aren't mapped to rights or license", () => {
    for (const kind of ["object", "archival_unit", "digital_asset"] as const) {
      const r = record(kind, "R", { rights: { uri: CNE }, creator: "x" });
      const view = viewOf([r], r.id);
      for (const entries of [
        [{ field: "creator", term: "creator" }],
        [{ field: "rights", term: "accessRights" }],
        [],
      ]) {
        expect(codes(out(view, [view.id], { template: "out", entries }))).toEqual([
          "rights_not_mapped",
        ]);
      }
      const license = { template: "out", entries: [{ field: "rights", term: "license" }] };
      expect(ok(out(view, [view.id], license)).jsonLd["dcterms:license"]).toEqual({ "@id": CNE });
    }
  });

  it("doesn't need rights mapped for agents, places and events", () => {
    for (const kind of ["agent", "place", "event"] as const) {
      const r = record(kind, "R", { creator: "x" });
      const mapping = { template: "out", entries: [{ field: "creator", term: "creator" }] };
      expect(out(viewOf([r], r.id), [r.id], mapping).ok).toBe(true);
    }
  });
});

describe("publicOutput: JSON-LD term ranges", () => {
  const item = fullObject();
  const view = viewOf([item], item.id);
  const lcsh = { "@id": LCSH, "rdfs:label": "Railroads" };

  function under(field: string, term: string) {
    const mapping = { template: "out", entries: [RIGHTS_ENTRY, { field, term }] };
    return ok(out(view, [view.id], mapping)).jsonLd[`dcterms:${term}`];
  }

  it("writes literal-range terms as text only, never an IRI", () => {
    for (const term of [
      "title",
      "alternative",
      "date",
      "created",
      "description",
      "abstract",
      "identifier",
      "bibliographicCitation",
    ]) {
      expect(under("subjects", term), term).toEqual(
        term === "title"
          ? ["Dickinson Station and Park", "Railroads", "Parks"]
          : ["Railroads", "Parks"],
      );
      const link = under("website", term);
      expect(JSON.stringify(link)).not.toContain("@id");
      expect(link).toEqual(
        term === "title"
          ? ["Dickinson Station and Park", "https://example.org/station"]
          : "https://example.org/station",
      );
    }
    expect(under("rights", "description")).toBe(CNE);
  });

  it("writes class-range terms as an IRI node, or a label node without a URI", () => {
    for (const term of [
      "creator",
      "contributor",
      "publisher",
      "rightsHolder",
      "format",
      "extent",
      "medium",
      "language",
      "coverage",
      "spatial",
      "temporal",
      "accessRights",
      "license",
      "provenance",
    ]) {
      expect(under("subjects", term), term).toEqual([lcsh, { "rdfs:label": "Parks" }]);
      expect(under("creator", term), term).toEqual({ "rdfs:label": "Unknown photographer" });
    }
    // Under rights, after the record's own rights.
    expect(under("creator", "rights")).toEqual([
      { "@id": CNE },
      { "rdfs:label": "Unknown photographer" },
    ]);
  });

  it("never writes a term's URI as dcterms:type: LCSH concepts aren't classes", () => {
    expect(under("subjects", "type")).toEqual([
      { "rdfs:label": "Railroads" },
      { "rdfs:label": "Parks" },
    ]);
    expect(under("website", "type")).toEqual({ "rdfs:label": "https://example.org/station" });
  });

  it("writes terms with no range as an IRI node for a URI, otherwise text", () => {
    for (const term of [
      "subject",
      "source",
      "relation",
      "isPartOf",
      "hasPart",
      "isFormatOf",
      "hasFormat",
    ]) {
      expect(under("subjects", term), term).toEqual([lcsh, "Parks"]);
      expect(under("website", term), term).toEqual({ "@id": "https://example.org/station" });
    }
  });

  it("only ever uses its fixed keys in value nodes", () => {
    const mapping = {
      template: "out",
      entries: [
        RIGHTS_ENTRY,
        ...TPL.fields
          .filter((f) => f.visibility === "public")
          .flatMap((f) =>
            ["creator", "subject", "type", "title"].map((term) => ({ field: f.key, term })),
          ),
      ],
    };
    const doc = ok(out(view, [view.id, PLACE_ID], mapping)).jsonLd;
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null) {
        for (const [k, inner] of Object.entries(v)) {
          keys.add(k);
          walk(inner);
        }
      }
    };
    for (const [k, v] of Object.entries(doc)) if (k !== "@context") walk(v);
    expect([...keys].sort()).toEqual(["@id", "rdfs:label"]);
  });
});

describe("publicOutput: URIs must be canonical", () => {
  it("refuses URIs not written as a URL parser writes them back", () => {
    for (const fields of [
      { website: { url: "http:example.org" } },
      { website: { url: "https://example.org" } },
      { website: { url: "HTTPS://example.org/" } },
      { places: [{ label: "x", uri: "https://Example.org/x" }] },
      { places: [{ label: "x", uri: "https://ex\u00e4mple.org/x" }] },
      { places: [{ label: "x", uri: "https://example.org/%7e/../x" }] },
    ]) {
      const item = record("object", "I", { rights: { uri: CNE }, ...fields });
      const result = out(viewOf([item], item.id));
      expect(result.ok, JSON.stringify(fields)).toBe(false);
    }
  });
});

describe("publicOutput: IRIs RFC 3987 allows", () => {
  it("refuses characters a URL parser leaves but IRIs forbid, and bad % escapes", () => {
    for (const url of [
      "https://example.org/a|b",
      "https://example.org/a^b",
      "https://example.org/[x]",
      "https://example.org/a]",
      "https://example.org/?q={x}",
      "https://example.org/#a`b",
      "https://example.org/%zz",
      "https://example.org/%4",
      "https://example.org/a%",
    ]) {
      const item = record("object", "I", { rights: { uri: CNE }, website: { url } });
      expect(out(viewOf([item], item.id)).ok, url).toBe(false);
      const place = record("object", "I", {
        rights: { uri: CNE },
        places: [{ label: "x", uri: url }],
      });
      expect(out(viewOf([place], place.id)).ok, url).toBe(false);
    }
  });

  it("accepts an IPv6 host and good % escapes", () => {
    for (const url of [
      "http://[::1]/x",
      "https://example.org/a%20b",
      "https://example.org/%E2%82%AC",
    ]) {
      const item = record("object", "I", { rights: { uri: CNE }, website: { url } });
      expect(ok(out(viewOf([item], item.id))).dublinCore.relation).toEqual([url]);
    }
  });

  it("applies the same rules to the base URL", () => {
    const item = record("object", "I", { rights: { uri: CNE } });
    const view = viewOf([item], item.id);
    for (const baseUrl of [
      "https://example.org/a|b/",
      "https://example.org/a^b/",
      "https://example.org/[x]/",
      "https://example.org/%zz/",
    ]) {
      expect(
        codes(publicOutput(view, MAPPING, { baseUrl, published: [view.id] })),
        baseUrl,
      ).toEqual(["invalid_base_url"]);
    }
    expect(
      ok(publicOutput(view, MAPPING, { baseUrl: "http://[::1]/items/", published: [view.id] })).id,
    ).toBe(`http://[::1]/items/${view.id}`);
  });
});

describe("publicView: rights notes", () => {
  it("leaves the rights note out of the public view, and so out of every public page", () => {
    const item = record("object", "I", { rights: { uri: CNE, note: "Call the donor at home" } });
    const effective = effectiveOf([item], item.id);
    expect(effective.fields.rights).toEqual({ uri: CNE, note: "Call the donor at home" });
    const view = viewOf([item], item.id);
    expect(view.fields.rights).toEqual({ uri: CNE });
    expect(view.entries.find((e) => e.key === "rights")?.value).toEqual({ uri: CNE });
    expect(Object.isFrozen(view.fields.rights)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("donor");
  });
});

describe("publicOutput: currentTemplate", () => {
  const item = record("object", "I", { rights: { uri: CNE }, donor_note: "SECRET" });
  const view = viewOf([item], item.id);
  const run = (currentTemplate: unknown) =>
    publicOutput(view, MAPPING, { baseUrl: BASE, published: [view.id], currentTemplate });

  it("publishes when the template is unchanged, even as a fresh copy in another key order", () => {
    const copy = JSON.parse(JSON.stringify(TPL)) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(copy).reverse());
    expect(run(copy).ok).toBe(true);
    expect(run(reordered).ok).toBe(true);
  });

  it("refuses when the template changed since the view was made", () => {
    const changed = template(
      TPL.fields.map((f) => (f.key === "donor_note" ? { ...f, visibility: "public" as const } : f)),
    );
    expect(codes(run(changed))).toEqual(["template_changed"]);
    expect(codes(run(template(TPL.fields.slice(1))))).toEqual(["template_changed"]);
  });

  it("refuses an invalid current template", () => {
    expect(codes(run({ key: "out" }))).toEqual(["invalid_template"]);
    expect(codes(run(new Proxy(TPL, {})))).toEqual(["invalid_options"]);
  });
});

describe("publicOutput: digital assets and DCMI types", () => {
  it("types a digital asset from the preset's resource type, as @type and dc:type", () => {
    const asset = record("digital_asset", "Station postcard scan", {
      rights: { uri: CNE },
      resource_type: "StillImage",
    });
    const view = viewOf([asset], asset.id, { ...DIGITAL_ASSET_PRESET, organizationId: ORG });
    const o = ok(
      publicOutput(view, DIGITAL_ASSET_DUBLIN_CORE, {
        baseUrl: BASE,
        published: [view.id],
        checkers: CHECKERS,
      }),
    );
    expect(o.jsonLd["@type"]).toBe("dcmitype:StillImage");
    expect(o.jsonLd["dcterms:type"]).toEqual({ "rdfs:label": "Still image" });
    expect(o.dublinCore.type).toEqual(["http://purl.org/dc/dcmitype/StillImage", "Still image"]);
    expect(o.oaiDcXml).toContain("<dc:type>http://purl.org/dc/dcmitype/StillImage</dc:type>");
    expect(o.oaiDcXml).toContain("<dc:type>Still image</dc:type>");
  });

  it("doesn't add a type from a field to a kind that has its own", () => {
    const tpl = template([
      ...TPL.fields,
      field({ key: "kind_code", kind: "list", options: [{ value: "Sound", label: "Sound" }] }),
    ]);
    const item = record("object", "I", { rights: { uri: CNE }, kind_code: "Sound" });
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, { field: "kind_code", term: "type" }],
    };
    const o = ok(out(viewOf([item], item.id, tpl), [item.id], mapping));
    expect(o.jsonLd["@type"]).toBe("dcmitype:PhysicalObject");
    expect(o.dublinCore.type).toEqual(["http://purl.org/dc/dcmitype/PhysicalObject", "Sound"]);
  });

  it("gives an archival item several DCMI types as a list", () => {
    const tpl = template([
      ...TPL.fields,
      field({
        key: "kinds",
        kind: "list",
        repeatable: true,
        options: [
          { value: "Text", label: "Text" },
          { value: "StillImage", label: "Still image" },
          { value: "other", label: "Other" },
        ],
      }),
    ]);
    const item = record("archival_unit", "Scrapbook", {
      rights: { uri: CNE },
      kinds: ["Text", "StillImage", "other"],
    });
    const mapping = { template: "out", entries: [RIGHTS_ENTRY, { field: "kinds", term: "type" }] };
    const o = ok(out(viewOf([item], item.id, tpl), [item.id], mapping));
    expect(o.jsonLd["@type"]).toEqual(["dcmitype:Text", "dcmitype:StillImage"]);
  });
});
