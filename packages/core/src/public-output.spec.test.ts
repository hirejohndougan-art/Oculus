// Public output checked against the specifications themselves (T-010a), and
// the JSON-LD run through a real JSON-LD 1.1 processor (`jsonld`, BSD-3-Clause,
// a dev dependency only).
//
// Sources, read 2026-11-23:
// - DCMI Metadata Terms, DCMI Recommendation 2020-01-20:
//   https://www.dublincore.org/specifications/dublin-core/dcmi-terms/
// - OAI-PMH 2.0 (document version 2015-01-08), sections 3.4 and 2.5:
//   https://openarchives-new.library.cornell.edu/OAI/openarchivesprotocol.html
//   and the 2003-02-21 version, section 5:
//   https://openarchives.org/OAI/2.0/openarchivesprotocol.2003-02-21.htm
// - XML 1.0 Fifth Edition (2008-11-26), production [2] Char:
//   https://w3.org/TR/xml/
// - JSON-LD 1.1, W3C Recommendation 2020-07-16, sections 4.1.5 and 7.2:
//   https://www.w3.org/TR/json-ld11/
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DCMITYPE_NAMESPACE,
  DCTERMS_NAMESPACE,
  DC_ELEMENTS_NAMESPACE,
  DUBLIN_CORE_TERMS,
  OAI_DC_NAMESPACE,
  OAI_DC_SCHEMA,
  RDFS_NAMESPACE,
  publicOutput,
  type DublinCoreTerm,
  type PublicOutput,
  type Validated,
} from "./index.js";
import { BASE, CHECKERS, CNE, LCSH, record, viewOf } from "./public-output.fixtures.js";

interface Quad {
  readonly subject: { readonly termType: string; readonly value: string };
  readonly predicate: { readonly termType: string; readonly value: string };
  readonly object: {
    readonly termType: string;
    readonly value: string;
    readonly datatype?: { readonly value: string };
  };
}
interface JsonLdProcessor {
  expand(input: unknown, options?: object): Promise<unknown[]>;
  toRDF(input: unknown, options?: object): Promise<Quad[]>;
}
const jsonld = createRequire(import.meta.url)("jsonld") as JsonLdProcessor;

/** No remote contexts: the output's context is inline, and tests never use the network. */
const OPTIONS = Object.freeze({
  safe: true,
  documentLoader: (url: string): Promise<never> =>
    Promise.reject(new Error(`no remote documents in tests: ${url}`)),
});

/** Every term's range as DCMI Metadata Terms (2020-01-20) states it, copied by hand. */
const SPEC_RANGE: ReadonlyMap<DublinCoreTerm, "literal" | "class" | "none"> = new Map([
  ["title", "literal"],
  ["alternative", "literal"],
  ["date", "literal"],
  ["created", "literal"],
  ["identifier", "literal"],
  ["bibliographicCitation", "literal"],
  ["creator", "class"], // Agent
  ["contributor", "class"], // Agent
  ["publisher", "class"], // Agent
  ["rightsHolder", "class"], // Agent
  ["format", "class"], // MediaType, Extent
  ["extent", "class"], // SizeOrDuration
  ["medium", "class"], // PhysicalMedium
  ["language", "class"], // LinguisticSystem
  ["coverage", "class"], // Location, Period, Jurisdiction
  ["spatial", "class"], // Location
  ["temporal", "class"], // PeriodOfTime
  ["rights", "class"], // RightsStatement
  ["accessRights", "class"], // RightsStatement
  ["license", "class"], // LicenseDocument
  ["provenance", "class"], // ProvenanceStatement
  ["description", "none"],
  ["abstract", "none"],
  ["type", "none"],
  ["subject", "none"],
  ["source", "none"],
  ["relation", "none"],
  ["isPartOf", "none"],
  ["hasPart", "none"],
  ["isFormatOf", "none"],
  ["hasFormat", "none"],
]);

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const NASTY = "Gift of </script><!-- & --> ]]> \u2028 friends";

function ok(result: Validated<PublicOutput>): PublicOutput {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

/** An object whose subjects, link, creator and description go out under every term. */
function everyTermOutput(): PublicOutput {
  const item = record("object", "Dickinson Station and Park", {
    rights: { uri: CNE },
    description: NASTY,
    subjects: [{ label: "Railroads", uri: LCSH, vocabulary: "lcsh" }, { label: "Parks" }],
    website: { url: "https://example.org/station" },
    creator: "Unknown photographer",
  });
  const view = viewOf([item], item.id);
  const fields = ["subjects", "website", "creator", "description"];
  const mapping = {
    template: "out",
    entries: [
      { field: "rights", term: "rights" },
      ...fields.flatMap((field) => DUBLIN_CORE_TERMS.map((term) => ({ field, term }))),
    ],
  };
  return ok(
    publicOutput(view, mapping, { baseUrl: BASE, published: [view.id], checkers: CHECKERS }),
  );
}

describe("public output against DCMI Metadata Terms", () => {
  it("covers every term this mapping can use with a range from the spec", () => {
    expect([...SPEC_RANGE.keys()].sort()).toEqual([...DUBLIN_CORE_TERMS].sort());
  });

  it("uses the namespaces the specs give", () => {
    expect(DCTERMS_NAMESPACE).toBe("http://purl.org/dc/terms/");
    expect(DCMITYPE_NAMESPACE).toBe("http://purl.org/dc/dcmitype/");
    expect(DC_ELEMENTS_NAMESPACE).toBe("http://purl.org/dc/elements/1.1/");
    expect(RDFS_NAMESPACE).toBe("http://www.w3.org/2000/01/rdf-schema#");
  });
});

describe("oai_dc against OAI-PMH 2.0", () => {
  it("uses the oai_dc namespace and schema location from sections 3.4 and 2.5", () => {
    expect(OAI_DC_NAMESPACE).toBe("http://www.openarchives.org/OAI/2.0/oai_dc/");
    expect(OAI_DC_SCHEMA).toBe("http://www.openarchives.org/OAI/2.0/oai_dc.xsd");
    const xml = everyTermOutput().oaiDcXml;
    const [declaration, root] = xml.split("\n");
    expect(declaration).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(root).toBe(
      '<oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">',
    );
  });

  it("writes only the 15 Dublin Core elements the oai_dc schema allows", () => {
    const allowed = new Set([
      "title",
      "creator",
      "subject",
      "description",
      "publisher",
      "contributor",
      "date",
      "type",
      "format",
      "identifier",
      "source",
      "language",
      "relation",
      "coverage",
      "rights",
    ]);
    const xml = everyTermOutput().oaiDcXml;
    const elements = [...xml.matchAll(/<dc:([A-Za-z]+)>/g)].map((m) => m[1] ?? "");
    expect(elements.length).toBeGreaterThan(50);
    for (const e of elements) expect(allowed.has(e), e).toBe(true);
    // Character data never holds a raw < or &, nor "]]>" (XML 1.0 [14] CharData).
    for (const line of xml.split("\n").slice(2, -2)) {
      const text = line.replace(/^ {2}<dc:[A-Za-z]+>/, "").replace(/<\/dc:[A-Za-z]+>$/, "");
      expect(text, line).not.toMatch(/[<]|&(?!(amp|lt|gt|quot|apos|#13);)|]]>/);
    }
  });
});

describe("JSON-LD through a JSON-LD 1.1 processor", () => {
  const o = everyTermOutput();

  it("expands without dropping anything, in safe mode, the same from the object and the text", async () => {
    const fromText = await jsonld.expand(JSON.parse(o.jsonLdText), OPTIONS);
    const fromObject = await jsonld.expand(JSON.parse(JSON.stringify(o.jsonLd)), OPTIONS);
    expect(fromText).toEqual(fromObject);
    expect(fromText).toHaveLength(1);
  });

  it("gives triples whose objects fit each term's range in DCMI Metadata Terms", async () => {
    const quads = await jsonld.toRDF(JSON.parse(o.jsonLdText), OPTIONS);
    const seen = new Set<string>();
    for (const q of quads) {
      // Only absolute IRIs: nothing relative or made up.
      expect(q.predicate.value, JSON.stringify(q)).toMatch(/^http:\/\//);
      if (q.object.termType === "NamedNode") expect(q.object.value).toMatch(/^https?:\/\//);
      if (q.subject.value !== o.id) {
        // Value nodes (a blank node, or a term's URI) only carry a label.
        expect(q.predicate.value).toBe(`${RDFS_NAMESPACE}label`);
        expect(q.object.termType).toBe("Literal");
        continue;
      }
      if (q.predicate.value === RDF_TYPE) {
        expect(q.object.value).toBe(`${DCMITYPE_NAMESPACE}PhysicalObject`);
        continue;
      }
      expect(q.predicate.value.startsWith(DCTERMS_NAMESPACE), q.predicate.value).toBe(true);
      const term = q.predicate.value.slice(DCTERMS_NAMESPACE.length) as DublinCoreTerm;
      const range = SPEC_RANGE.get(term);
      expect(range, term).toBeDefined();
      seen.add(term);
      if (range === "literal") expect(q.object.termType, term).toBe("Literal");
      if (range === "class") expect(q.object.termType, term).not.toBe("Literal");
    }
    expect([...seen].sort()).toEqual([...DUBLIN_CORE_TERMS].sort());
  });

  it("labels value nodes with rdfs:label, and keeps text exactly as given", async () => {
    const quads = await jsonld.toRDF(JSON.parse(o.jsonLdText), OPTIONS);
    const labels = quads.filter((q) => q.predicate.value === `${RDFS_NAMESPACE}label`);
    expect(labels.map((q) => q.object.value)).toContain("Unknown photographer");
    const description = quads.find(
      (q) => q.subject.value === o.id && q.predicate.value === `${DCTERMS_NAMESPACE}description`,
    );
    // The script-safe escapes in jsonLdText are JSON escapes: the value is unchanged.
    expect(quads.some((q) => q.object.value === NASTY)).toBe(true);
    expect(description?.object.termType).toBe("Literal");
    expect(o.jsonLdText).not.toMatch(/[<>&\u2028\u2029]/);
  });

  it("links an LCSH subject and a no-range type by IRI, as the spec allows", async () => {
    const quads = await jsonld.toRDF(JSON.parse(o.jsonLdText), OPTIONS);
    const objects = (term: string): string[] =>
      quads
        .filter((q) => q.subject.value === o.id && q.predicate.value === DCTERMS_NAMESPACE + term)
        .map((q) => `${q.object.termType}:${q.object.value}`);
    expect(objects("subject")).toContain(`NamedNode:${LCSH}`);
    expect(objects("type")).toContain(`NamedNode:${LCSH}`);
    expect(objects("type")).toContain("Literal:Parks");
    expect(objects("identifier")).toContain("Literal:https://example.org/station");
  });

  it("types an event as dcmitype:Event", async () => {
    const other = record("event", "Storm of 1900", { creator: "Unknown" });
    const view = viewOf([other], other.id);
    const mapping = { template: "out", entries: [{ field: "creator", term: "creator" }] };
    const e = ok(publicOutput(view, mapping, { baseUrl: BASE, published: [view.id] }));
    const quads = await jsonld.toRDF(JSON.parse(e.jsonLdText), OPTIONS);
    expect(quads.find((q) => q.predicate.value === RDF_TYPE)?.object.value).toBe(
      `${DCMITYPE_NAMESPACE}Event`,
    );
  });
});
