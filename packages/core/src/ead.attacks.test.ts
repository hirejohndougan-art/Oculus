// Attack tests for the EAD reader and writer and the XML parser under them
// (D-107, D-110): entity tricks, oversized and over-deep files, hostile
// text and links, and hostile models handed to the writer.
import { afterEach, describe, expect, it } from "vitest";
import { EAD2002_DTD_SAMPLE, EAD3_SAMPLE, SAMPLE_MODEL } from "./ead.fixtures.js";
import {
  MAX_ARRANGEMENT_DEPTH,
  MAX_EAD_NOTICES,
  MAX_EAD_TEXT_LENGTH,
  MAX_XML_ATTRIBUTES,
  MAX_XML_ATTRIBUTE_LENGTH,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  parseXml,
  readEad,
  writeEad,
  type EadUnit,
  type FindingAid,
  type Validated,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const AT = "2026-11-25T10:00:00Z";

function withTitle(title: string): string {
  return EAD2002_DTD_SAMPLE.replace(
    "<unittitle>Invented Church Records</unittitle>",
    `<unittitle>${title}</unittitle>`,
  );
}

describe("XML attacks", () => {
  it("refuses billion laughs: any DOCTYPE with an internal subset", () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE ead [
  <!ENTITY a "lol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
]>
<ead><archdesc level="fonds"><did><unittitle>&c;</unittitle></did></archdesc></ead>`;
    expect(codes(readEad(lol))).toEqual(["doctype_subset"]);
  });

  it("refuses XXE: external entities are never declared, fetched or expanded", () => {
    for (const decl of [
      '<!ENTITY x SYSTEM "file:///etc/passwd">',
      '<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/">',
      '<!ENTITY % p SYSTEM "http://example.invalid/evil.dtd"> %p;',
    ]) {
      const xml = `<!DOCTYPE ead [ ${decl} ]><ead><archdesc level="fonds"><did><unittitle>&x;</unittitle></did></archdesc></ead>`;
      expect(codes(readEad(xml))).toEqual(["doctype_subset"]);
    }
  });

  it("refuses entities a DTD would have defined, instead of guessing", () => {
    for (const name of [
      "nbsp",
      "mdash",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(codes(readEad(withTitle(`a&${name};b`)))).toEqual(["not_well_formed"]);
    }
  });

  it("reads XML's own entities and character references", () => {
    const result = readEad(
      withTitle("Fish &amp; chips &lt;&#233;&#x41;&gt; &quot;q&quot; &apos;a&apos;"),
    );
    expect(result.ok && result.value.findingAid.archdesc.title).toBe(`Fish & chips <éA> "q" 'a'`);
  });

  it("refuses character references to characters XML forbids", () => {
    expect(codes(readEad(withTitle("a&#0;b")))).toEqual(["not_well_formed"]);
    expect(codes(readEad(withTitle("a&#x1;b")))).toEqual(["not_well_formed"]);
  });

  it("refuses files over 50 MB without parsing them", () => {
    const big = "<ead>" + " ".repeat(MAX_XML_BYTES) + "</ead>";
    expect(codes(parseXml(big))).toEqual(["too_large"]);
    expect(codes(parseXml(new Uint8Array(MAX_XML_BYTES + 1)))).toEqual(["too_large"]);
    // Counted in bytes: 27 million two-byte characters are 54 MB, over 50 MiB.
    expect(codes(parseXml("<ead>" + "é".repeat(27_000_000) + "</ead>"))).toEqual(["too_large"]);
  });

  it("refuses elements nested too deep", () => {
    const deep = "<a>".repeat(MAX_XML_DEPTH + 1) + "</a>".repeat(MAX_XML_DEPTH + 1);
    expect(codes(parseXml(deep))).toEqual(["too_deep"]);
    const ok = "<a>".repeat(MAX_XML_DEPTH) + "</a>".repeat(MAX_XML_DEPTH);
    expect(parseXml(ok).ok).toBe(true);
  });

  it("refuses components nested deeper than an arrangement may be", () => {
    const n = MAX_ARRANGEMENT_DEPTH; // with archdesc, one too many
    const cs = '<c level="file"><did><unittitle>x</unittitle></did>'.repeat(n) + "</c>".repeat(n);
    const xml = `<ead><archdesc level="fonds"><did><unittitle>t</unittitle></did><dsc>${cs}</dsc></archdesc></ead>`;
    expect(codes(readEad(xml))).toEqual(["too_deep"]);
    const fits =
      '<c level="file"><did><unittitle>x</unittitle></did>'.repeat(n - 1) + "</c>".repeat(n - 1);
    expect(readEad(xml.replace(cs, fits)).ok).toBe(true);
  });

  it("refuses too many elements", () => {
    const xml = `<ead>${"<x/>".repeat(MAX_XML_ELEMENTS)}</ead>`;
    expect(codes(parseXml(xml))).toEqual(["too_many_elements"]);
  });

  it("refuses too many or too long attributes", () => {
    const many = Array.from({ length: MAX_XML_ATTRIBUTES + 1 }, (_, i) => `a${String(i)}="1"`).join(
      " ",
    );
    expect(codes(parseXml(`<ead ${many}/>`))).toEqual(["too_many_attributes"]);
    expect(codes(parseXml(`<ead a="${"x".repeat(MAX_XML_ATTRIBUTE_LENGTH + 1)}"/>`))).toEqual([
      "attribute_too_long",
    ]);
  });

  it("refuses unbound namespace prefixes and broken XML", () => {
    expect(codes(parseXml("<x:ead/>"))).toEqual(["not_well_formed"]);
    expect(codes(parseXml("<ead><a></ead>"))).toEqual(["not_well_formed"]);
    expect(codes(parseXml("<ead/><ead/>"))).toEqual(["not_well_formed"]);
    expect(codes(parseXml(""))).toEqual(["not_well_formed"]);
  });

  it("doesn't treat input of the wrong type as XML", () => {
    expect(codes(parseXml(42 as unknown as string))).toEqual(["not_xml"]);
    expect(codes(readEad({ toString: () => "<ead/>" } as unknown as string))).toEqual(["not_xml"]);
  });
});

describe("EAD reader attacks", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it("doesn't let element or attribute names reach object prototypes", () => {
    const xml = EAD3_SAMPLE.replace(
      "<unittitle>Mill</unittitle>",
      '<unittitle>Mill</unittitle><__proto__ polluted="yes"/><constructor prototype="x"/>',
    ).replace('<c level="subgrp">', '<c level="subgrp" __proto__="x" constructor="y">');
    const result = readEad(xml);
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (result.ok) {
      const paths = result.value.report.unmapped.map((n) => n.path);
      expect(paths).toContain("/ead/archdesc[1]/dsc[1]/c[1]/did[1]/__proto__[1]");
      expect(paths).toContain("/ead/archdesc[1]/dsc[1]/c[1]/@__proto__");
    }
  });

  it("doesn't let a level named after a prototype key choose a level", () => {
    for (const level of ["__proto__", "constructor", "toString"]) {
      const xml = EAD2002_DTD_SAMPLE.replace(
        'level="recordgrp"',
        `level="otherlevel" otherlevel="${level}"`,
      );
      const result = readEad(xml);
      expect(result.ok && result.value.findingAid.archdesc.level).toBe("collection");
    }
    const plain = readEad(EAD2002_DTD_SAMPLE.replace('level="recordgrp"', 'level="constructor"'));
    expect(plain.ok && plain.value.findingAid.archdesc.level).toBe("collection");
  });

  it("removes control and direction-changing characters and says so", () => {
    const result = readEad(withTitle("Pay&#x202E;txt.exe &#x200B;records&#x85;"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findingAid.archdesc.title).toBe("Paytxt.exe records");
      expect(result.value.report.warnings.map((w) => w.code)).toContain("text_cleaned");
    }
  });

  it("cuts text over the limit and says so", () => {
    const result = readEad(withTitle("x".repeat(MAX_EAD_TEXT_LENGTH + 10)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findingAid.archdesc.title).toHaveLength(MAX_EAD_TEXT_LENGTH);
      expect(result.value.report.warnings.map((w) => w.code)).toContain("text_cut");
    }
  });

  it("leaves out links that aren't plain web addresses", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "https://user:pass@example.org/",
      "https://example.org\\@evil.example/",
      "//example.org/x",
      "vbscript:msgbox",
    ]) {
      const xml = EAD2002_DTD_SAMPLE.replace(
        'href="http://example.org/church"',
        `href="${url.replace(/&/g, "&amp;").replace(/</g, "&lt;")}"`,
      );
      const result = readEad(xml);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.findingAid.archdesc.links).toEqual([]);
        expect(result.value.report.warnings.map((w) => w.code)).toContain("bad_url");
      }
    }
  });

  it("caps the report, counting what it didn't list", () => {
    const junk = "<junk/>".repeat(MAX_EAD_NOTICES + 500);
    const xml = EAD2002_DTD_SAMPLE.replace(
      "<unittitle>Minutes</unittitle>",
      `<unittitle>Minutes</unittitle>${junk}`,
    );
    const result = readEad(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.report.unmapped).toHaveLength(MAX_EAD_NOTICES);
      expect(result.value.report.omitted).toBeGreaterThanOrEqual(500);
    }
  });

  it("reads many siblings in linear time", () => {
    const files = '<c level="file"><did><unittitle>f</unittitle></did></c>'.repeat(20_000);
    const xml = `<ead><archdesc level="fonds"><did><unittitle>t</unittitle></did><dsc>${files}</dsc></archdesc></ead>`;
    const start = performance.now();
    const result = readEad(xml);
    expect(result.ok && result.value.findingAid.archdesc.children).toHaveLength(20_000);
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it("keeps a staff-only header note out of the public notes", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      "</titlestmt>",
      '</titlestmt><notestmt><note audience="internal"><p>Donor wants anonymity.</p></note><note><p>Public note.</p></note></notestmt>',
    );
    const result = readEad(xml);
    expect(result.ok && result.value.findingAid.header.notes).toEqual(["Public note."]);
    expect(JSON.stringify(result.ok ? result.value.findingAid : {})).not.toContain("Donor");
  });

  it("keeps staff-only parts of a public note out of it", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      "<dsc",
      '<scopecontent><p>Open part.</p><p audience="internal">Private part.</p><list audience="internal"><item>Hidden</item></list></scopecontent><dsc',
    );
    const result = readEad(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findingAid.archdesc.notes).toEqual([
        { kind: "scopecontent", paragraphs: ["Open part."], internal: false },
      ]);
    }
  });

  it("keeps staff-only access points and names out", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      "<dsc",
      '<controlaccess><persname audience="internal">Hidden Person</persname><subject>Open</subject></controlaccess><controlaccess audience="internal"><subject>Hidden too</subject></controlaccess><dsc',
    ).replace(
      "<physdesc>4 boxes</physdesc>",
      '<origination><persname audience="internal">Secret Donor</persname></origination><unitid audience="internal">SECRET-1</unitid>',
    );
    const result = readEad(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const json = JSON.stringify(result.value.findingAid);
      for (const hidden of ["Hidden", "Secret", "SECRET"]) expect(json).not.toContain(hidden);
      expect(result.value.findingAid.archdesc.accessPoints).toEqual([
        { element: "subject", label: "Open" },
      ]);
    }
  });
});

describe("EAD writer attacks", () => {
  it("escapes text and attributes so nothing can break out of an element", () => {
    const evil = '</unittitle><dao href="javascript:x"/><unittitle>&amp; ]]> "\' <!-- -->';
    const aid: FindingAid = {
      ...SAMPLE_MODEL,
      header: { ...SAMPLE_MODEL.header, title: evil },
      archdesc: {
        ...SAMPLE_MODEL.archdesc,
        title: evil,
        containers: [{ type: "Box", value: evil }],
        links: [{ url: 'https://example.org/"><x%20a="', label: evil }],
      },
    };
    for (const version of ["ead2002", "ead3"] as const) {
      const written = writeEad(aid, { version, generatedAt: AT });
      expect(codes(written)).toEqual([]);
      if (!written.ok) continue;
      expect(written.value.xml).not.toContain('<dao href="javascript');
      const back = readEad(written.value.xml);
      expect(back.ok).toBe(true);
      if (back.ok) {
        expect(back.value.findingAid.archdesc.title).toBe(evil);
        expect(back.value.findingAid.header.title).toBe(evil);
        expect(back.value.findingAid.archdesc.links).toEqual(aid.archdesc.links);
      }
    }
  });

  it("refuses text that would be unsafe or change on reading", () => {
    const bad = (title: string): string[] =>
      codes(
        writeEad(
          { ...SAMPLE_MODEL, archdesc: { ...SAMPLE_MODEL.archdesc, title } },
          { version: "ead3", generatedAt: AT },
        ),
      );
    // readPlainData refuses these first, as it does for every record.
    expect(bad("a\u0000b")).toEqual(["bad_characters"]);
    expect(bad("a\u202eb")).toEqual(["bad_characters"]);
    expect(bad("a\ud800b")).toEqual(["bad_characters"]);
    expect(bad("two\nlines")).toContain("not_normalized");
    expect(bad(" padded")).toContain("not_normalized");
    expect(bad("")).toContain("empty");
  });

  it("refuses links that aren't plain web addresses", () => {
    for (const url of ["javascript:alert(1)", "https://u:p@example.org/", "ftp://example.org/"]) {
      const aid = { ...SAMPLE_MODEL, archdesc: { ...SAMPLE_MODEL.archdesc, links: [{ url }] } };
      expect(codes(writeEad(aid, { version: "ead2002", generatedAt: AT }))).toContain("bad_url");
    }
  });

  it("refuses hostile objects: getters, Proxies, extra properties, prototype keys", () => {
    const getter = { ...SAMPLE_MODEL };
    Object.defineProperty(getter, "archdesc", {
      get: () => SAMPLE_MODEL.archdesc,
      enumerable: true,
    });
    expect(writeEad(getter, { version: "ead3", generatedAt: AT }).ok).toBe(false);
    expect(writeEad(new Proxy(SAMPLE_MODEL, {}), { version: "ead3", generatedAt: AT }).ok).toBe(
      false,
    );
    const extra = { ...SAMPLE_MODEL, archdesc: { ...SAMPLE_MODEL.archdesc, publishedSecret: "x" } };
    expect(codes(writeEad(extra, { version: "ead3", generatedAt: AT }))).toContain(
      "unknown_property",
    );
    const proto = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    expect(writeEad(proto, { version: "ead3", generatedAt: AT }).ok).toBe(false);
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("boom");
        },
      },
    );
    expect(() => writeEad(throwing, { version: "ead3", generatedAt: AT })).not.toThrow();
  });

  it("refuses models nested deeper than an arrangement may be", () => {
    let unit: EadUnit = { ...SAMPLE_MODEL.archdesc, children: [] };
    for (let i = 0; i < MAX_ARRANGEMENT_DEPTH; i += 1)
      unit = { ...SAMPLE_MODEL.archdesc, children: [unit] };
    expect(
      codes(writeEad({ ...SAMPLE_MODEL, archdesc: unit }, { version: "ead3", generatedAt: AT })),
    ).toContain("too_deep");
  });

  it("refuses bad options", () => {
    expect(codes(writeEad(SAMPLE_MODEL, { version: "ead4" as "ead3", generatedAt: AT }))).toEqual([
      "not_allowed",
    ]);
    expect(codes(writeEad(SAMPLE_MODEL, { version: "ead3", generatedAt: "yesterday" }))).toEqual([
      "not_a_date",
    ]);
    expect(
      codes(writeEad(SAMPLE_MODEL, { version: "ead3", generatedAt: AT, agent: "<x>" })),
    ).toEqual(["not_allowed"]);
  });
});
