import { describe, expect, it } from "vitest";
import { FULL_MODEL, SAMPLE_MODEL } from "./ead.fixtures.js";
import {
  EAD2002_NAMESPACE,
  EAD3_NAMESPACE,
  EAD_ACCESS_ELEMENTS,
  EAD_NAME_ELEMENTS,
  EAD_NOTE_KINDS,
  EAD_VERSIONS,
  parseXml,
  readEad,
  writeEad,
  type EadVersion,
  type FindingAid,
  type XmlElement,
} from "./index.js";

const AT = "2026-11-25T10:00:00Z";

function write(aid: FindingAid, version: EadVersion): string {
  const result = writeEad(aid, { version, generatedAt: AT });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.xml;
}

// Which children each element the writer emits may have, from the EAD 2002
// schema (ead.xsd, 2021 release) and the EAD3 1.1.1 schema (ead3.xsd). The
// writer's output was also validated against both schemas with xmllint while
// this was built (D-110); this table keeps that checked in every test run.
const NOTES = [...EAD_NOTE_KINDS];
const TERMS = [...EAD_ACCESS_ELEMENTS];
const NAMES = [...EAD_NAME_ELEMENTS];
const COMMON: Record<string, readonly string[]> = {
  filedesc: ["titlestmt", "publicationstmt", "notestmt"],
  titlestmt: ["titleproper", "subtitle", "author"],
  publicationstmt: ["publisher"],
  archdesc: ["did", ...NOTES, "controlaccess", "dsc"],
  dsc: ["c"],
  c: ["did", ...NOTES, "controlaccess", "c"],
  origination: NAMES,
  langmaterial: ["language"],
  repository: ["corpname"],
  controlaccess: TERMS,
  ...Object.fromEntries(NOTES.map((n) => [n, ["head", "p"]])),
};
const SHAPE: Record<EadVersion, Record<string, readonly string[]>> = {
  ead2002: {
    ...COMMON,
    ead: ["eadheader", "archdesc"],
    eadheader: ["eadid", "filedesc"],
    notestmt: ["note"],
    note: ["p"],
    did: [
      "unitid",
      "unittitle",
      "unitdate",
      "physdesc",
      "origination",
      "langmaterial",
      "repository",
      "container",
      "physloc",
      "abstract",
      "dao",
    ],
    physdesc: ["extent"],
  },
  ead3: {
    ...COMMON,
    ead: ["control", "archdesc"],
    control: [
      "recordid",
      "filedesc",
      "maintenancestatus",
      "maintenanceagency",
      "maintenancehistory",
    ],
    notestmt: ["controlnote"],
    controlnote: ["p"],
    maintenanceagency: ["agencycode", "agencyname"],
    maintenancehistory: ["maintenanceevent"],
    maintenanceevent: ["eventtype", "eventdatetime", "agenttype", "agent"],
    did: [
      "unitid",
      "unittitle",
      "unitdate",
      "physdesc",
      "physdescstructured",
      "origination",
      "langmaterial",
      "repository",
      "container",
      "physloc",
      "abstract",
      "dao",
    ],
    physdescstructured: ["quantity", "unittype"],
    ...Object.fromEntries([...TERMS, ...NAMES].map((t) => [t, ["part"]])),
  },
};
const REQUIRED: Record<EadVersion, Record<string, readonly string[]>> = {
  ead2002: { archdesc: ["level"] },
  ead3: {
    archdesc: ["level"],
    dao: ["daotype"],
    physdescstructured: ["coverage", "physdescstructuredtype"],
    maintenancestatus: ["value"],
    eventtype: ["value"],
    agenttype: ["value"],
  },
};
// Required order where the schema has a sequence.
const ORDER: Record<EadVersion, Record<string, readonly string[]>> = {
  ead2002: { ead: ["eadheader", "archdesc"], eadheader: ["eadid", "filedesc"] },
  ead3: {
    ead: ["control", "archdesc"],
    control: [
      "recordid",
      "filedesc",
      "maintenancestatus",
      "maintenanceagency",
      "maintenancehistory",
    ],
    maintenanceagency: ["agencycode", "agencyname"],
    maintenanceevent: ["eventtype", "eventdatetime", "agenttype", "agent"],
    physdescstructured: ["quantity", "unittype"],
  },
};

function checkShape(el: XmlElement, version: EadVersion, problems: string[], path = "ead"): void {
  const ns = version === "ead3" ? EAD3_NAMESPACE : EAD2002_NAMESPACE;
  if (el.ns !== ns) problems.push(`${path}: namespace ${el.ns}`);
  const kids = el.children.filter((c): c is XmlElement => typeof c !== "string");
  const allowed = SHAPE[version][el.name];
  for (const k of kids) {
    if (allowed?.includes(k.name) !== true) problems.push(`${path}: ${k.name} not allowed`);
  }
  for (const attr of REQUIRED[version][el.name] ?? []) {
    if (!el.attributes.some((a) => a.name === attr)) problems.push(`${path}: needs @${attr}`);
  }
  const order = ORDER[version][el.name];
  if (order !== undefined) {
    const seen = kids.map((k) => order.indexOf(k.name)).filter((i) => i >= 0);
    if (seen.some((v, i) => i > 0 && v < (seen[i - 1] ?? 0)))
      problems.push(`${path}: out of order`);
  }
  if (["note", "controlnote", ...NOTES].includes(el.name) && !kids.some((k) => k.name === "p")) {
    problems.push(`${path}: needs a p`);
  }
  for (const k of kids) checkShape(k, version, problems, `${path}/${k.name}`);
}

describe("writeEad", () => {
  for (const version of EAD_VERSIONS) {
    it(`writes ${version} in the shape its schema requires`, () => {
      for (const aid of [FULL_MODEL, SAMPLE_MODEL]) {
        const parsed = parseXml(write(aid, version));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        const problems: string[] = [];
        checkShape(parsed.value, version, problems);
        expect(problems).toEqual([]);
      }
    });
  }

  it("writes EAD 2002 links as XLink and EAD3 links as plain href", () => {
    expect(write(SAMPLE_MODEL, "ead2002")).toContain(
      '<dao xlink:type="simple" xlink:href="https://example.org/objects/1" xlink:title="Scans"/>',
    );
    expect(write(SAMPLE_MODEL, "ead3")).toContain(
      '<dao daotype="unknown" href="https://example.org/objects/1" linktitle="Scans"/>',
    );
  });

  it("marks staff-only units and notes audience=internal", () => {
    for (const version of EAD_VERSIONS) {
      const xml = write(SAMPLE_MODEL, version);
      expect(xml).toContain('<c level="item" audience="internal">');
      expect(xml).toContain('<acqinfo audience="internal">');
      expect(xml).not.toContain('<bioghist audience="internal">');
    }
  });

  it("writes the generation time only where EAD3 needs it", () => {
    expect(write(SAMPLE_MODEL, "ead3")).toContain(
      `<eventdatetime standarddatetime="${AT}">${AT}</eventdatetime>`,
    );
    expect(write(SAMPLE_MODEL, "ead2002")).not.toContain(AT);
  });

  it("leaves out a normal form EAD 2002 can't hold, with a warning", () => {
    const aid: FindingAid = {
      ...SAMPLE_MODEL,
      archdesc: { ...SAMPLE_MODEL.archdesc, dates: [{ text: "about 1920", normal: "1920~" }] },
    };
    const v2002 = writeEad(aid, { version: "ead2002", generatedAt: AT });
    expect(v2002.ok).toBe(true);
    if (v2002.ok) {
      expect(v2002.value.xml).toContain("<unitdate>about 1920</unitdate>");
      expect(v2002.value.warnings.map((w) => [w.path.join("."), w.code])).toEqual([
        ["archdesc.dates.0.normal", "normal_left_out"],
      ]);
    }
    const v3 = writeEad(aid, { version: "ead3", generatedAt: AT });
    expect(v3.ok && v3.value.warnings).toEqual([]);
    expect(v3.ok && v3.value.xml).toContain('<unitdate normal="1920~">about 1920</unitdate>');
  });

  it("writes components as unnumbered c at every depth", () => {
    const xml = write(FULL_MODEL, "ead2002");
    expect(xml).not.toMatch(/<c\d\d/);
    const back = readEad(xml);
    expect(back.ok).toBe(true);
  });
});
