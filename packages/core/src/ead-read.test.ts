import { describe, expect, it } from "vitest";
import { EAD2002_DTD_SAMPLE, EAD2002_SAMPLE, EAD3_SAMPLE, SAMPLE_MODEL } from "./ead.fixtures.js";
import { readEad, type EadRead } from "./index.js";

function read(xml: string | Uint8Array): EadRead {
  const result = readEad(xml);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(xml: string): string[] {
  const result = readEad(xml);
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("readEad: EAD 2002", () => {
  it("reads a namespaced EAD 2002 file into the model", () => {
    const { findingAid, report } = read(EAD2002_SAMPLE);
    expect(report.version).toBe("ead2002");
    expect(report.namespaced).toBe(true);
    expect(findingAid).toEqual(SAMPLE_MODEL);
  });

  it("reports the level changes", () => {
    const { report } = read(EAD2002_SAMPLE);
    expect(report.levelChanges).toEqual([
      { path: "/ead/archdesc[1]/dsc[1]/c01[2]", from: "subseries", to: "series" },
    ]);
  });

  it("lists formatting it flattened only when more than formatting was lost", () => {
    const { report } = read(EAD2002_SAMPLE);
    // emph is formatting: its text is kept and nothing else is lost.
    expect(report.unmapped.filter((n) => n.path.includes("emph"))).toEqual([]);
    // The origination label is a display label, not data.
    expect(report.unmapped.some((n) => n.path.includes("origination"))).toBe(false);
  });

  it("reads DTD-era EAD 2002 with no namespace and an external DTD it never fetches", () => {
    const { findingAid, report } = read(EAD2002_DTD_SAMPLE);
    expect(report.version).toBe("ead2002");
    expect(report.namespaced).toBe(false);
    expect(findingAid.header).toEqual({
      id: "dtd-0002",
      title: "Invented Church Records",
      notes: [],
    });
    const top = findingAid.archdesc;
    expect(top.level).toBe("fonds");
    expect(top.extents).toEqual([{ text: "4 boxes" }]);
    expect(top.dates).toEqual([{ text: "1920-1930", normal: "19200101/19301231" }]);
    expect(top.links).toEqual([{ url: "http://example.org/church", label: "Church scans" }]);
    expect(top.children.map((c) => c.level)).toEqual(["item", "collection"]);
    expect(report.levelChanges).toEqual([
      { path: "/ead/archdesc[1]", from: "recordgrp", to: "fonds" },
      { path: "/ead/archdesc[1]/dsc[1]/c[1]", from: "otherlevel:Item", to: "item" },
      { path: "/ead/archdesc[1]/dsc[1]/c[2]", from: "otherlevel:Binder", to: "collection" },
    ]);
    expect(report.unmapped).toContainEqual(
      expect.objectContaining({
        path: "/ead/archdesc[1]/dsc[1]/@type",
        code: "unmapped_attribute",
      }),
    );
  });

  it("reads numbered and unnumbered components alike", () => {
    const xml = EAD2002_SAMPLE.replace(/<c01 /g, "<c ").replace(/<\/c01>/g, "</c>");
    expect(read(xml).findingAid).toEqual(SAMPLE_MODEL);
  });

  it("reads mixed-content repository and plain-text languages", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      "<physdesc>4 boxes</physdesc>",
      "<repository>Invented Archive</repository><langmaterial>English and Spanish</langmaterial>",
    );
    const top = read(xml).findingAid.archdesc;
    expect(top.repository).toBe("Invented Archive");
    expect(top.languages).toEqual([{ label: "English and Spanish" }]);
  });

  it("keeps an extent with a unit but a non-numeric value as text, and says so", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      "<physdesc>4 boxes</physdesc>",
      '<physdesc><extent unit="boxes">about 4</extent><dimensions>10 x 12 in.</dimensions></physdesc>',
    );
    const { findingAid, report } = read(xml);
    expect(findingAid.archdesc.extents).toEqual([{ text: "about 4 boxes" }]);
    expect(report.warnings.map((w) => w.code)).toContain("extent_as_text");
    expect(report.unmapped).toContainEqual(
      expect.objectContaining({
        code: "unmapped_element",
        path: "/ead/archdesc[1]/did[1]/physdesc[1]/dimensions[1]",
      }),
    );
  });
});

describe("readEad: EAD3", () => {
  it("reads EAD3 1.x", () => {
    const { findingAid, report } = read(EAD3_SAMPLE);
    expect(report.version).toBe("ead3");
    expect(findingAid.header).toEqual({
      id: "ead3-0003",
      title: "Invented Lumber Company Records",
      publisher: "Example Archive",
      agencyCode: "US-YY",
      countryCode: "US",
      notes: [],
    });
    const top = findingAid.archdesc;
    expect(top.level).toBe("fonds");
    expect(top.identifiers).toEqual(["LC-01"]);
    expect(top.dates).toEqual([{ text: "1905-1931", normal: "1905/1931", type: "inclusive" }]);
    expect(top.extents).toEqual([{ quantity: "12", unit: "linear feet" }]);
    expect(top.creators).toEqual([
      {
        element: "corpname",
        label: "Invented Lumber Company",
        identifier: "http://id.loc.gov/authorities/names/n00000000",
        source: "lcnaf",
        role: "creator",
      },
    ]);
    expect(top.notes).toEqual([
      {
        kind: "scopecontent",
        paragraphs: ["Payroll and mill records.", "Payroll", "Deeds"],
        internal: false,
      },
    ]);
    expect(top.accessPoints).toEqual([
      { element: "persname", label: "Doe, Jane, 1880-1950", source: "local" },
    ]);
    const mill = top.children[0];
    expect(mill?.level).toBe("series");
    expect(mill?.links).toEqual([{ url: "https://example.org/a", label: "A" }]);
    expect(mill?.children[0]?.dates).toEqual([
      { text: "1910-1911", normal: "1910/1911", type: "bulk" },
    ]);
  });

  it("reports what it flattened, joined, refused or didn't keep", () => {
    const { report } = read(EAD3_SAMPLE);
    const found = (code: string): string[] =>
      [...report.unmapped, ...report.warnings].filter((n) => n.code === code).map((n) => n.path);
    expect(found("markup_flattened")).toContain("/ead/archdesc[1]/scopecontent[1]/p[1]/ref[1]");
    expect(found("structure_flattened")).toContain("/ead/archdesc[1]/scopecontent[1]/list[1]");
    expect(found("parts_joined")).toContain("/ead/archdesc[1]/controlaccess[1]/persname[1]");
    expect(found("bad_url")).toContain("/ead/archdesc[1]/dsc[1]/c[1]/did[1]/daoset[1]/dao[2]");
    expect(found("unmapped_element")).toContain("/ead/control[1]/maintenancehistory[1]");
  });

  it("never folds staff-only text into a public note", () => {
    const { findingAid, report } = read(EAD3_SAMPLE);
    const odd = findingAid.archdesc.children[0]?.notes.find((n) => n.kind === "odd");
    expect(odd?.paragraphs).toEqual(["Some notes."]);
    expect(JSON.stringify(findingAid)).not.toContain("Secret Name");
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        code: "internal_left_out",
        path: "/ead/archdesc[1]/dsc[1]/c[1]/odd[1]/p[1]/persname[1]",
      }),
    );
  });

  it("leaves out staff-only did elements it can't mark, and says so", () => {
    const xml = EAD3_SAMPLE.replace(
      "<unitid>LC-01</unitid>",
      '<unitid>LC-01</unitid><physloc audience="internal">Shelf 9</physloc>',
    );
    const { findingAid, report } = read(xml);
    expect(findingAid.archdesc.physicalLocations).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toContain("internal_left_out");
  });

  it("keeps everything inside a staff-only component, marked by the component", () => {
    const xml = EAD3_SAMPLE.replace(
      '<c level="file">',
      '<c level="file" audience="internal">',
    ).replace(
      "<unittitle>Ledger</unittitle>",
      '<unittitle>Ledger</unittitle><physloc audience="internal">Vault</physloc>',
    );
    const ledger = read(xml).findingAid.archdesc.children[0]?.children[0];
    expect(ledger?.internal).toBe(true);
    expect(ledger?.physicalLocations).toEqual(["Vault"]);
  });

  it("reads any 1.x release: unknown elements are listed, not fatal", () => {
    const xml = EAD3_SAMPLE.replace(
      "<unittitle>Mill</unittitle>",
      '<unittitle>Mill</unittitle><futurething kind="x">new in 1.9</futurething>',
    );
    const { report } = read(xml);
    expect(report.unmapped).toContainEqual(
      expect.objectContaining({
        code: "unmapped_element",
        path: "/ead/archdesc[1]/dsc[1]/c[1]/did[1]/futurething[1]",
      }),
    );
  });

  it("lists elements from other namespaces", () => {
    const xml = EAD3_SAMPLE.replace(
      "<unittitle>Mill</unittitle>",
      '<unittitle>Mill</unittitle><x:extra xmlns:x="urn:example:x">data</x:extra>',
    );
    expect(read(xml).report.unmapped.map((n) => n.code)).toContain("foreign_element");
  });

  it("refuses EAD3 written without its namespace, with a fix", () => {
    const xml = EAD3_SAMPLE.replace(' xmlns="http://ead3.archivists.org/schema/"', "");
    expect(codes(xml)).toEqual(["ead3_without_namespace"]);
  });
});

describe("readEad: versions it refuses", () => {
  it("refuses a future major version instead of guessing", () => {
    for (const ns of [
      "http://ead4.archivists.org/schema/",
      "http://archivists.org/schema/ead4",
      "urn:ead4",
    ]) {
      const xml = EAD3_SAMPLE.replace("http://ead3.archivists.org/schema/", ns);
      const result = readEad(xml);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.code).toBe("unsupported_version");
        expect(result.issues[0]?.message).toMatch(/can't read yet/);
      }
    }
  });

  it("refuses files that aren't EAD", () => {
    expect(codes("<mods/>")).toEqual(["not_ead"]);
    expect(codes('<ead xmlns="urn:example"/>')).toEqual(["not_ead"]);
    expect(codes("<ead><eadheader/></ead>")).toEqual(["no_archdesc"]);
    expect(codes("not xml at all")).toEqual(["not_well_formed"]);
  });
});

describe("readEad: dates", () => {
  it("warns about dates that can't safely become EDTF, and keeps their text", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      '<unitdate normal="19200101/19301231">1920-1930</unitdate>',
      "<unitdate>1900s</unitdate>",
    );
    const { findingAid, report } = read(xml);
    expect(findingAid.archdesc.dates).toEqual([{ text: "1900s" }]);
    expect(report.warnings.map((w) => w.code)).toContain("date_not_edtf");
  });

  it("reports an era or calendar it doesn't keep", () => {
    const xml = EAD2002_DTD_SAMPLE.replace(
      '<unitdate normal="19200101/19301231">',
      '<unitdate era="ce" calendar="julian" normal="19200101/19301231">',
    );
    const { report } = read(xml);
    const paths = report.unmapped.map((n) => n.path);
    expect(paths).toContain("/ead/archdesc[1]/did[1]/unitdate[1]/@calendar");
    expect(paths).not.toContain("/ead/archdesc[1]/did[1]/unitdate[1]/@era");
  });
});

describe("readEad: bytes", () => {
  it("reads UTF-8 bytes, with or without a BOM", () => {
    const bytes = new TextEncoder().encode(EAD2002_SAMPLE);
    expect(read(bytes).findingAid).toEqual(SAMPLE_MODEL);
    expect(read(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])).findingAid).toEqual(SAMPLE_MODEL);
  });

  it("reads Latin-1 when the declaration says so", () => {
    const xml = EAD2002_DTD_SAMPLE.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace(
      "Invented Church Records</unittitle>",
      "Iglesia de San José</unittitle>",
    );
    const bytes = Uint8Array.from(xml, (ch) => ch.charCodeAt(0));
    expect(read(bytes).findingAid.archdesc.title).toBe("Iglesia de San José");
  });

  it("refuses bytes that aren't the encoding they claim", () => {
    const bytes = new TextEncoder().encode(EAD2002_DTD_SAMPLE.replace("Minutes", "Miné"));
    const broken = Uint8Array.from(bytes, (b) => (b === 0xa9 ? 0xff : b));
    const result = readEad(broken);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["bad_encoding"]);
  });

  it("refuses encodings it can't read", () => {
    const xml = EAD2002_DTD_SAMPLE.replace('encoding="UTF-8"', 'encoding="EBCDIC-CP-US"');
    const result = readEad(new TextEncoder().encode(xml));
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["unsupported_encoding"]);
  });
});
