// Tests from the T-059a independent review: staff-only text in every place
// the reader looks, audience in any case, inline spacing, reader output the
// writer accepts, limits, and EAD 2002 codes.
import { describe, expect, it } from "vitest";
import {
  EAD2002_DTD_SAMPLE,
  EAD2002_SAMPLE,
  EAD3_SAMPLE,
  FULL_MODEL,
  SAMPLE_MODEL,
} from "./ead.fixtures.js";
import {
  MAX_XML_TOTAL_ATTRIBUTES,
  eadUnits,
  parseXml,
  readEad,
  validateFindingAid,
  writeEad,
  type EadRead,
  type FindingAid,
} from "./index.js";

const AT = "2026-11-25T10:00:00Z";
const NS2002 = 'xmlns="urn:isbn:1-931666-22-9"';
const NS3 = 'xmlns="http://ead3.archivists.org/schema/"';

/** Read, and check that what was read is a model the writer accepts. */
function readValid(xml: string): EadRead {
  const result = readEad(xml);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const checked = validateFindingAid(result.value.findingAid);
  if (!checked.ok) throw new Error(`read model invalid: ${JSON.stringify(checked.issues)}`);
  return result.value;
}

function written(aid: FindingAid, version: "ead2002" | "ead3"): string {
  const w = writeEad(aid, { version, generatedAt: AT });
  if (!w.ok) throw new Error(JSON.stringify(w.issues));
  return w.value.xml;
}

/** Everything in the model that isn't staff-only, as text. */
function publicText(aid: FindingAid): string {
  const parts: string[] = [JSON.stringify(aid.header)];
  for (const { unit, internal } of eadUnits(aid)) {
    if (internal) continue;
    parts.push(
      JSON.stringify({
        ...unit,
        notes: unit.notes.filter((n) => !n.internal),
        children: [],
      }),
    );
  }
  return parts.join("\n");
}

const START_TAG = /<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/g;

/** The file with the n-th start tag marked staff-only and holding a marker. */
function markNth(xml: string, n: number): string | undefined {
  let i = -1;
  let changed: string | undefined;
  const out = xml.replace(START_TAG, (whole, name: string, attrs: string) => {
    i += 1;
    if (i !== n || /\baudience\s*=/.test(attrs)) return whole;
    changed = `<${name}${attrs} audience="internal">MARKER${String(n)}x`;
    return changed;
  });
  return changed === undefined ? undefined : out;
}

describe("staff-only text is never read as public (review B1, S1, S2)", () => {
  const files: Record<string, string> = {
    ead2002: EAD2002_SAMPLE,
    dtd: EAD2002_DTD_SAMPLE,
    ead3: EAD3_SAMPLE,
    full2002: written(FULL_MODEL, "ead2002"),
    full3: written(FULL_MODEL, "ead3"),
  };
  for (const [name, xml] of Object.entries(files)) {
    it(`audience="internal" on any element of ${name} keeps its text out of public parts`, () => {
      const total = [...xml.matchAll(START_TAG)].length;
      expect(total).toBeGreaterThan(10);
      let tried = 0;
      for (let n = 0; n < total; n += 1) {
        const marked = markNth(xml, n);
        if (marked === undefined) continue;
        tried += 1;
        const { findingAid } = readValid(marked);
        expect(publicText(findingAid), `element ${String(n)}`).not.toContain(`MARKER${String(n)}x`);
      }
      expect(tried).toBeGreaterThan(10);
    });
  }

  const head = `<eadheader><eadid>x</eadid><filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc></eadheader>`;
  const wrap = (arch: string, rootAttr = ""): string =>
    `<ead ${NS2002} ${rootAttr}>${head}${arch}</ead>`;

  it("a staff-only ead makes the whole finding aid staff-only", () => {
    const { findingAid } = readValid(
      wrap(
        `<archdesc level="collection"><did><unittitle>SECRET</unittitle></did></archdesc>`,
        'audience="internal"',
      ),
    );
    expect(findingAid.archdesc.internal).toBe(true);
  });

  it("a staff-only dsc makes its components staff-only", () => {
    const { findingAid } = readValid(
      wrap(
        `<archdesc level="collection"><did><unittitle>ok</unittitle></did><dsc audience="internal"><c01 level="file"><did><unittitle>SECRET</unittitle></did></c01></dsc></archdesc>`,
      ),
    );
    expect(findingAid.archdesc.children[0]?.internal).toBe(true);
    expect(publicText(findingAid)).not.toContain("SECRET");
  });

  it("a staff-only header keeps only its identifier, and says so", () => {
    const xml = wrap(
      `<archdesc level="collection"><did><unittitle>ok</unittitle></did></archdesc>`,
    ).replace("<eadheader>", '<eadheader audience="internal">');
    const { findingAid, report } = readValid(
      xml.replace(
        "</titlestmt>",
        "<author>SECRET</author></titlestmt><notestmt><note><p>SECRET</p></note></notestmt>",
      ),
    );
    expect(findingAid.header).toEqual({ id: "x", notes: [] });
    expect(report.warnings.map((w) => w.code)).toContain("internal_left_out");
  });

  it("reads audience in any case, and anything but external as staff-only", () => {
    for (const value of ["Internal", "INTERNAL", " internal ", "staff", ""]) {
      const { findingAid, report } = readValid(
        wrap(
          `<archdesc level="collection"><did><unittitle>t</unittitle></did><scopecontent audience="${value}"><p>SECRET</p></scopecontent></archdesc>`,
        ),
      );
      expect(findingAid.archdesc.notes[0]?.internal, value).toBe(true);
      if (!["internal"].includes(value.trim().toLowerCase())) {
        expect(report.warnings.map((w) => w.code)).toContain("audience_unknown");
      }
    }
    const open = readValid(
      wrap(
        `<archdesc level="collection"><did><unittitle>t</unittitle></did><scopecontent audience="External"><p>open</p></scopecontent></archdesc>`,
      ),
    );
    expect(open.findingAid.archdesc.notes[0]?.internal).toBe(false);
  });

  it("eadUnits counts a unit as staff-only when any unit above it is (review M7)", () => {
    const units = eadUnits(SAMPLE_MODEL);
    expect(units.map((u) => [u.path.join("."), u.internal])).toEqual([
      ["", false],
      ["0", false],
      ["0.0", false],
      ["0.1", true],
      ["1", false],
    ]);
    const top = eadUnits({
      ...SAMPLE_MODEL,
      archdesc: { ...SAMPLE_MODEL.archdesc, internal: true },
    });
    expect(top.every((u) => u.internal)).toBe(true);
  });
});

describe("inline markup (review S3)", () => {
  it("joins formatting to the words around it, with a space only for a line break", () => {
    const xml = `<ead ${NS2002}><eadheader><eadid>x</eadid><filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc></eadheader><archdesc level="collection"><did><unittitle>Smith<emph render="italic">son</emph>'s <title render="italic">Moby Dick</title>, 1851</unittitle></did><scopecontent><p>H<emph render="sub">2</emph>O and e<lb/>mail</p></scopecontent></archdesc></ead>`;
    const { findingAid } = readValid(xml);
    expect(findingAid.archdesc.title).toBe("Smithson's Moby Dick, 1851");
    expect(findingAid.archdesc.notes[0]?.paragraphs).toEqual(["H2O and e mail"]);
  });
});

describe("what is read can be written (review S4)", () => {
  const wrap = (
    arch: string,
    hdr = `<eadid>x</eadid><filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc>`,
  ): string => `<ead ${NS2002}><eadheader>${hdr}</eadheader>${arch}</ead>`;
  const cases: Record<string, string> = {
    containerSpace: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle><container type="Oversize Box">1</container></did></archdesc>`,
    ),
    rloInAttributes: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle><origination><persname authfilenumber="&#x202E;http://x" role="&#x202E;creator">A</persname></origination></did></archdesc>`,
    ),
    normalSpace: wrap(
      `<archdesc level="collection"><did><unitdate normal="1900 / 1910">1900-1910</unitdate></did></archdesc>`,
    ),
    noEadid: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle></did></archdesc>`,
      `<filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc>`,
    ),
    noTitleComponent: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle></did><dsc><c01><did><container type="box">1</container></did></c01><c01><scopecontent><p>Only a note.</p></scopecontent></c01></dsc></archdesc>`,
    ),
    levelCase: wrap(`<archdesc level="Collection"><did><unittitle>t</unittitle></did></archdesc>`),
    langcodeBad: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle><langmaterial><language langcode="en g">English</language></langmaterial></did></archdesc>`,
    ),
    sourceBad: wrap(
      `<archdesc level="collection"><did><unittitle>t</unittitle></did><controlaccess><subject source="Library of Congress">x</subject></controlaccess></archdesc>`,
    ),
  };
  for (const [name, xml] of Object.entries(cases)) {
    it(`${name}: valid, writable in both versions, and the same when read again`, () => {
      const { findingAid } = readValid(xml);
      for (const version of ["ead2002", "ead3"] as const) {
        const again = readValid(written(findingAid, version)).findingAid;
        if (version === "ead3") expect(again).toEqual(findingAid);
      }
    });
  }

  it("cleans attributes and leaves out codes that aren't codes, with warnings", () => {
    const { findingAid, report } = readValid(cases.rloInAttributes ?? "");
    expect(findingAid.archdesc.creators).toEqual([
      { element: "persname", label: "A", identifier: "http://x", role: "creator" },
    ]);
    expect(report.warnings.map((w) => w.code)).toContain("text_cleaned");
    const lang = readValid(cases.langcodeBad ?? "");
    expect(lang.findingAid.archdesc.languages).toEqual([{ label: "English" }]);
    expect(lang.report.warnings.map((w) => w.code)).toContain("code_left_out");
    const normal = readValid(cases.normalSpace ?? "");
    expect(normal.findingAid.archdesc.dates).toEqual([{ text: "1900-1910" }]);
  });

  it("writes a unit with nothing in its did as an empty title, read back as no title", () => {
    const { findingAid } = readValid(cases.noTitleComponent ?? "");
    const noteOnly = findingAid.archdesc.children[1];
    expect(noteOnly?.title).toBeUndefined();
    const xml = written(findingAid, "ead2002");
    expect(xml).toContain("<unittitle></unittitle>");
    expect(readValid(xml).findingAid).toEqual(findingAid);
  });
});

describe("limits (review S6, M1)", () => {
  it("refuses more attributes in the whole file than the cap", () => {
    const attrs = Array.from({ length: 60 }, (_, i) => `a${String(i)}=""`).join(" ");
    const count = Math.ceil(MAX_XML_TOTAL_ATTRIBUTES / 60) + 1;
    const xml = `<ead>${`<x ${attrs}/>`.repeat(count)}</ead>`;
    const result = parseXml(xml);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["too_many_attributes"]);
  });

  it("allows a [ inside a DOCTYPE's quoted identifiers", () => {
    const xml = EAD2002_DTD_SAMPLE.replace('"ead.dtd">', '"ead[2002].dtd">');
    expect(readEad(xml).ok).toBe(true);
    expect(readEad(xml.replace('"ead[2002].dtd">', '"ead.dtd" [ ]>')).ok).toBe(false);
  });
});

describe("EAD 2002 codes (review S7)", () => {
  it("leaves out codes EAD 2002's schema can't hold, with warnings, and keeps them in EAD3", () => {
    const aid: FindingAid = {
      ...SAMPLE_MODEL,
      header: { ...SAMPLE_MODEL.header, countryCode: "usa", agencyCode: "US:dhs.tx" },
      archdesc: {
        ...SAMPLE_MODEL.archdesc,
        languages: [{ label: "English", code: "english" }],
        containers: [{ type: "Oversize Box", value: "1" }],
      },
    };
    const v2002 = writeEad(aid, { version: "ead2002", generatedAt: AT });
    expect(v2002.ok).toBe(true);
    if (v2002.ok) {
      expect(v2002.value.warnings.map((w) => `${w.path.join(".")}:${w.code}`)).toEqual([
        "header.countryCode:code_left_out",
        "header.agencyCode:code_left_out",
        "archdesc.languages.0.code:code_left_out",
        "archdesc.containers.0.type:code_left_out",
      ]);
      expect(v2002.value.xml).toContain("<eadid>example-0001</eadid>");
    }
    const v3 = writeEad(aid, { version: "ead3", generatedAt: AT });
    expect(v3.ok && v3.value.warnings).toEqual([]);
  });
});

describe("nothing silently overwritten (review M2)", () => {
  const w3 = (arch: string): string =>
    `<ead ${NS3}><control><recordid>r</recordid><filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc><maintenancestatus value="new"/><maintenanceagency><agencyname>A</agencyname></maintenanceagency><maintenancehistory/></control>${arch}</ead>`;
  const w2 = (arch: string, hdr = "<eadid>x</eadid>"): string =>
    `<ead ${NS2002}><eadheader>${hdr}<filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc></eadheader>${arch}</ead>`;
  const paths = (r: EadRead): string[] =>
    [...r.report.unmapped, ...r.report.warnings].map((n) => n.path);

  it("reports a second quantity, fromdate and eadid", () => {
    const q = readValid(
      w3(
        `<archdesc level="collection"><did><unittitle>t</unittitle><physdescstructured coverage="whole" physdescstructuredtype="spaceoccupied"><quantity>3</quantity><quantity>7</quantity><unittype>boxes</unittype></physdescstructured></did></archdesc>`,
      ),
    );
    expect(paths(q)).toContain("/ead/archdesc[1]/did[1]/physdescstructured[1]/quantity[2]");
    const d = readValid(
      w3(
        `<archdesc level="collection"><did><unittitle>t</unittitle><unitdatestructured><daterange><fromdate>1900</fromdate><fromdate>1850</fromdate><todate>1910</todate></daterange></unitdatestructured></did></archdesc>`,
      ),
    );
    expect(paths(d)).toContain(
      "/ead/archdesc[1]/did[1]/unitdatestructured[1]/daterange[1]/fromdate[2]",
    );
    const e = readValid(
      w2(
        `<archdesc level="collection"><did><unittitle>t</unittitle></did></archdesc>`,
        "<eadid>first</eadid><eadid>second</eadid>",
      ),
    );
    expect(e.findingAid.header.id).toBe("first");
    expect(paths(e)).toContain("/ead/eadheader[1]/eadid[2]");
  });

  it("reports an otherlevel that isn't used and a plain href beside xlink:href", () => {
    const o = readValid(
      w2(
        `<archdesc level="series" otherlevel="accession"><did><unittitle>t</unittitle></did></archdesc>`,
      ),
    );
    expect(paths(o)).toContain("/ead/archdesc[1]/@otherlevel");
    const h = readValid(
      w2(
        `<archdesc level="collection"><did><unittitle>t</unittitle><dao xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://a.org/1" href="https://b.org/2"/></did></archdesc>`,
      ),
    );
    expect(h.findingAid.archdesc.links).toEqual([{ url: "https://a.org/1" }]);
    expect(paths(h)).toContain("/ead/archdesc[1]/did[1]/dao[1]/@href");
  });

  it("still reports someone else's maintenance history", () => {
    const r = readValid(
      w3(`<archdesc level="collection"><did><unittitle>t</unittitle></did></archdesc>`),
    );
    expect(paths(r)).toContain("/ead/control[1]/maintenancehistory[1]");
  });
});
