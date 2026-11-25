// Tests from T-059a's second independent review (Chat AA, 2026-11-25):
// staff-only parts inside a staff-only note are kept, attribute limits hold
// while a start tag is read (namespace declarations counted), a link address
// that needed cleaning is refused, Oculus's own EAD3 history is recognised
// only when it holds nothing else, list parts' attributes are reported, and
// a prefixed audience counts as staff-only.
import { describe, expect, it } from "vitest";
import { SAMPLE_MODEL } from "./ead.fixtures.js";
import {
  MAX_XML_ATTRIBUTES,
  MAX_XML_TOTAL_ATTRIBUTES,
  parseXml,
  readEad,
  writeEad,
  type EadRead,
} from "./index.js";

const NS2002 = 'xmlns="urn:isbn:1-931666-22-9"';
const HEAD = `<eadheader><eadid>x</eadid><filedesc><titlestmt><titleproper>T</titleproper></titlestmt></filedesc></eadheader>`;
const wrap = (arch: string): string => `<ead ${NS2002}>${HEAD}${arch}</ead>`;
const arch = (inner: string): string =>
  wrap(`<archdesc level="collection"><did><unittitle>Public</unittitle></did>${inner}</archdesc>`);

function read(xml: string): EadRead {
  const result = readEad(xml);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(xml: string): string[] {
  const result = parseXml(xml);
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("staff-only parts of a staff-only note (review 2, item 1)", () => {
  it("keeps marked paragraphs, inline text and list items under the note's mark", () => {
    const { findingAid } = read(
      arch(
        `<scopecontent audience="internal"><p audience="internal">SECRET1</p><p>S2 <emph audience="internal">X</emph></p><list><item audience="internal">Y</item></list></scopecontent>`,
      ),
    );
    const note = findingAid.archdesc.notes.find((n) => n.kind === "scopecontent");
    expect(note?.internal).toBe(true);
    const text = note?.paragraphs.join(" ") ?? "";
    expect(text).toContain("SECRET1");
    expect(text).toContain("X");
    expect(text).toContain("Y");
  });

  it("still leaves marked parts out of a public note, and keeps them out of public text", () => {
    const { findingAid, report } = read(
      arch(
        `<scopecontent><p audience="internal">SECRET1</p><p>S2 <emph audience="Internal">X</emph></p></scopecontent>`,
      ),
    );
    const note = findingAid.archdesc.notes.find((n) => n.kind === "scopecontent");
    expect(note?.internal).toBe(false);
    expect(JSON.stringify(note)).not.toContain("SECRET1");
    expect(JSON.stringify(note)).not.toMatch(/\bX\b/);
    expect(report.warnings.some((w) => w.code === "internal_left_out")).toBe(true);
  });

  it("a public note after a staff-only one is checked again", () => {
    const { findingAid } = read(
      arch(
        `<scopecontent audience="internal"><p>A</p></scopecontent><bioghist><p>B <emph audience="internal">HIDDEN</emph></p></bioghist>`,
      ),
    );
    const bio = findingAid.archdesc.notes.find((n) => n.kind === "bioghist");
    expect(bio?.internal).toBe(false);
    expect(JSON.stringify(bio)).not.toContain("HIDDEN");
  });
});

describe("attribute limits while reading (review 2, item 2)", () => {
  it("refuses one start tag with too many attributes before it is built", () => {
    const attrs = Array.from({ length: 200_000 }, (_, i) => `a${String(i)}=""`).join(" ");
    const started = Date.now();
    expect(codes(`<r ${attrs}/>`)).toEqual(["too_many_attributes"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("counts namespace declarations on one element", () => {
    const decls = Array.from(
      { length: MAX_XML_ATTRIBUTES + 1 },
      (_, i) => `xmlns:p${String(i)}="u"`,
    ).join(" ");
    expect(codes(`<r ${decls}/>`)).toEqual(["too_many_attributes"]);
  });

  it("counts namespace declarations in the whole file", () => {
    const decls = Array.from({ length: 60 }, (_, i) => `xmlns:p${String(i)}="u"`).join(" ");
    const count = Math.ceil(MAX_XML_TOTAL_ATTRIBUTES / 60) + 1;
    const xml = `<r>${`<e ${decls}/>`.repeat(count)}</r>`;
    expect(codes(xml)).toEqual(["too_many_attributes"]);
  });

  it("refuses an overlong attribute value or name", () => {
    expect(codes(`<r a="${"x".repeat(10_001)}"/>`)).toEqual(["attribute_too_long"]);
    expect(codes(`<r ${"a".repeat(10_001)}="x"/>`)).toEqual(["attribute_too_long"]);
  });

  it("still reads an ordinary file with namespace declarations", () => {
    const result = parseXml(`<r xmlns="u" xmlns:x="v" a="1"><x:e b="2"/></r>`);
    expect(result.ok).toBe(true);
  });
});

describe("link addresses (review 2, item 3)", () => {
  it("refuses an address with a hidden direction-changing character instead of cleaning it", () => {
    const { findingAid, report } = read(
      arch(
        `<dao xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://x.example/&#x202E;gpj.exe"/>`,
      ),
    );
    expect(JSON.stringify(findingAid)).not.toContain("gpj.exe");
    expect(report.warnings.some((w) => w.code === "bad_url")).toBe(true);
  });
});

describe("Oculus's own EAD3 history (review 2, item 4)", () => {
  const own = (): string => {
    const w = writeEad(SAMPLE_MODEL, { version: "ead3", generatedAt: "2026-11-25T10:00:00Z" });
    if (!w.ok) throw new Error(JSON.stringify(w.issues));
    return w.value.xml;
  };
  const historyNotices = (xml: string): number =>
    read(xml).report.unmapped.filter((n) => n.path.includes("maintenancehistory")).length;

  it("is recognised quietly as written", () => {
    expect(historyNotices(own())).toBe(0);
  });

  it("is reported when the date holds anything else", () => {
    const xml = own().replace(
      /(<eventdatetime[^>]*>)[^<]*(<\/eventdatetime>)/,
      "$1SECRET <x>hidden</x> STUFF$2",
    );
    expect(xml).toContain("SECRET");
    expect(historyNotices(xml)).toBeGreaterThan(0);
  });

  it("is reported when an event type has children", () => {
    const xml = own().replace(
      /<eventtype value="created"\s*\/>/,
      '<eventtype value="created"><x>hidden</x></eventtype>',
    );
    expect(xml).toContain("hidden");
    expect(historyNotices(xml)).toBeGreaterThan(0);
  });
});

describe("list and chronology parts (review 2, item 5)", () => {
  it("reports their attributes", () => {
    const { report } = read(
      arch(
        `<scopecontent><list><item id="i1">A</item><defitem altrender="z"><label>L</label><item>I</item></defitem></list><chronlist><chronitem id="c1"><date>1900</date><event altrender="e">E</event></chronitem></chronlist></scopecontent>`,
      ),
    );
    const attrs = report.unmapped.filter((n) => n.code === "unmapped_attribute").map((n) => n.path);
    expect(attrs.some((p) => p.endsWith("item[1]/@id"))).toBe(true);
    expect(attrs.some((p) => p.endsWith("defitem[1]/@altrender"))).toBe(true);
    expect(attrs.some((p) => p.endsWith("chronitem[1]/@id"))).toBe(true);
    expect(attrs.some((p) => p.endsWith("event[1]/@altrender"))).toBe(true);
  });
});

describe("a prefixed audience (review 2, item 6)", () => {
  it("counts as staff-only", () => {
    const { findingAid } = read(
      wrap(
        `<archdesc level="collection"><did><unittitle>Public</unittitle></did><dsc><c xmlns:e="urn:isbn:1-931666-22-9" e:audience="internal" level="file"><did><unittitle>SECRET</unittitle></did></c></dsc></archdesc>`,
      ),
    );
    const c = findingAid.archdesc.children[0];
    expect(c?.title).toBe("SECRET");
    expect(c?.internal).toBe(true);
  });
});
