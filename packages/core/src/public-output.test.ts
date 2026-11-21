import { describe, expect, it } from "vitest";
import {
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
  return publicOutput(view, mapping, { baseUrl: BASE, published });
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
      rights: [CNE],
      description: ["A postcard of the station."],
      created: ["1909~"],
      accessRights: ["Open to all"],
      subject: ["Railroads", "Parks"],
      identifier: ["2026.015"],
      relation: ["https://example.org/station"],
      spatial: ["Dickinson (Tex.)"],
      creator: ["Unknown photographer"],
      rightsHolder: ["The Society"],
    });
    expect(Object.keys(o.dublinCore)[0]).toBe("title");
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
      "dcterms:accessRights": "Open to all",
      "dcterms:subject": [{ "@id": LCSH, "rdfs:label": "Railroads" }, "Parks"],
      "dcterms:identifier": "2026.015",
      "dcterms:relation": { "@id": "https://example.org/station" },
      "dcterms:spatial": "Dickinson (Tex.)",
      "dcterms:creator": "Unknown photographer",
      "dcterms:rightsHolder": "The Society",
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
        `  <dc:rights>${CNE}</dc:rights>`,
        "  <dc:description>A postcard of the station.</dc:description>",
        "  <dc:date>1909~</dc:date>",
        "  <dc:rights>Open to all</dc:rights>",
        "  <dc:subject>Railroads</dc:subject>",
        "  <dc:subject>Parks</dc:subject>",
        "  <dc:identifier>2026.015</dc:identifier>",
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
    const mapping = { template: "out", entries: [{ field: "extent", term: "title" }] };
    expect(ok(out(view, [view.id], mapping)).dublinCore.title).toEqual([
      "Dickinson Station and Park",
      "1 postcard",
    ]);
  });

  it("leaves out a mapped field with no value", () => {
    const bare = record("object", "Bare", { rights: { uri: CNE } });
    const o = ok(out(viewOf([bare], bare.id)));
    expect(o.dublinCore).toEqual({ title: ["Bare"], rights: [CNE] });
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
    expect(o.jsonLd["dcterms:spatial"]).toBe("Dickinson (Tex.)");
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
      rights: [CNE],
      description: ["Own"],
      creator: ["The Society"],
    });
    // The parent isn't published, and nothing names it.
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
    const mapping = { template: "out", entries: [{ field: "creator", term: "creator" }] };
    expect(codes(out(viewOf([item], item.id, noRights), [item.id], mapping))).toEqual([
      "rights_not_public",
    ]);
  });

  it("refuses an invalid mapping with its issues", () => {
    const item = fullObject();
    const view = viewOf([item], item.id);
    expect(
      codes(out(view, [view.id], { template: "out", entries: [{ field: "x", term: "title" }] })),
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
      expect(codes(result), JSON.stringify(fields)).toEqual(["invalid_value"]);
      const key = Object.keys(fields)[0];
      expect(result.ok ? undefined : result.issues[0]?.path).toEqual(["fields", key]);
    }
  });

  it("refuses a rights value with extra properties through the publish check", () => {
    const item = record("object", "Bad", { rights: { uri: CNE, extra: 1 } });
    expect(codes(out(viewOf([item], item.id)))).toEqual(["unknown_property"]);
  });

  it("refuses a field over its list and repeat limits", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ label: `t${String(i)}` }));
    const item = record("object", "Many", { rights: { uri: CNE }, subjects: tooMany });
    expect(codes(out(viewOf([item], item.id)))).toEqual(["invalid_value"]);
  });

  it("accepts every kind's value when the template's field is single or repeatable as stored", () => {
    const tpl = template([
      field({ key: "rights", kind: "rights" }),
      field({ key: "dates", kind: "date", repeatable: true }),
    ]);
    const item = record("object", "Dates", { rights: { uri: CNE }, dates: ["1909", "1910/1912"] });
    const mapping = { template: "out", entries: [{ field: "dates", term: "date" }] };
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
      expect(ok(publicOutput(view, MAPPING, { baseUrl, published: [view.id] })).id).toBe(
        baseUrl + view.id,
      );
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
