// T-059b: finding aids from catalog records (D-120). Public exports refuse
// staff values; staff exports mark them staff-only; both write files the
// reader gives back as the same model.
import { describe, expect, it } from "vitest";
import {
  findingAidFromUnits,
  MAX_EXPORT_UNITS,
  readEad,
  writeEad,
  type EadExportField,
  type EadExportUnit,
  type FindingAid,
  type RecordId,
} from "./index.js";

const ROOT = "11111111-1111-4111-8111-111111111111" as RecordId;
const SERIES = "22222222-2222-4222-8222-222222222222" as RecordId;
const FILE = "33333333-3333-4333-8333-333333333333" as RecordId;
const STRAY = "44444444-4444-4444-8444-444444444444" as RecordId;
const AT = "2026-11-25T10:00:00Z";

const f = (
  key: string,
  kind: EadExportField["kind"],
  value: EadExportField["value"],
  staffOnly = false,
  label = key,
): EadExportField => ({ key, label, kind, value, staffOnly });

const units = (
  rootFields: EadExportField[] = [],
  fileFields: EadExportField[] = [],
): EadExportUnit[] => [
  {
    id: ROOT,
    level: "fonds",
    title: "Dickinson Bayou Papers",
    fields: [
      f("reference_code", "identifier", { type: "accession", value: "DS5C740001" }),
      f("repository", "text", "Dickinson Historical Society"),
      f("date", "date", "1920/1935"),
      f("extent", "text", ["2.5 linear feet", "34 photographs"]),
      f("creators", "controlled_term", [
        { label: "Smith, Ann", uri: "http://id.loc.gov/authorities/names/n00000001" },
      ]),
      f("scope_and_content", "long_text", "First paragraph.\n\nSecond paragraph."),
      f("subjects", "controlled_term", [{ label: "Floods" }]),
      f("places", "place", [{ label: "Dickinson (Tex.)" }]),
      ...rootFields,
    ],
  },
  { id: SERIES, parentId: ROOT, level: "series", title: "Correspondence", fields: [] },
  { id: FILE, parentId: SERIES, level: "file", title: "Letters, 1921", fields: fileFields },
];

function made(result: ReturnType<typeof findingAidFromUnits>): FindingAid {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.findingAid;
}

describe("findingAidFromUnits: public", () => {
  it("maps DACS fields to their EAD places and keeps the tree", () => {
    const aid = made(findingAidFromUnits(ROOT, units(), { audience: "public" }));
    const a = aid.archdesc;
    expect(a.level).toBe("fonds");
    expect(a.title).toBe("Dickinson Bayou Papers");
    expect(a.identifiers).toEqual(["DS5C740001"]);
    expect(a.repository).toBe("Dickinson Historical Society");
    expect(a.dates).toEqual([{ text: "1920/1935", normal: "1920/1935", type: "inclusive" }]);
    expect(a.extents).toEqual([{ text: "2.5 linear feet" }, { text: "34 photographs" }]);
    expect(a.creators[0]?.label).toBe("Smith, Ann");
    expect(a.notes).toEqual([
      {
        kind: "scopecontent",
        paragraphs: ["First paragraph.", "Second paragraph."],
        internal: false,
      },
    ]);
    expect(a.accessPoints.map((p) => p.element)).toEqual(["subject", "geogname"]);
    expect(a.children[0]?.title).toBe("Correspondence");
    expect(a.children[0]?.children[0]?.title).toBe("Letters, 1921");
    expect(aid.header.id).toBe("DS5C740001");
    expect(aid.header.publisher).toBe("Dickinson Historical Society");
    expect(JSON.stringify(aid)).not.toContain("staff-only");
  });

  it("refuses any staff-only value outright", () => {
    const result = findingAidFromUnits(
      ROOT,
      units([], [f("appraisal", "long_text", "SECRET", true)]),
      { audience: "public" },
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.issues[0]?.code).toBe("staff_value_in_public");
  });

  it("never writes record links, and leaves out links that aren't web addresses", () => {
    const { findingAid, notices } = (() => {
      const r = findingAidFromUnits(
        ROOT,
        units([
          f("related", "record_link", { label: "Private title", recordId: STRAY }),
          f("online", "link", [
            { url: "javascript:alert(1)", label: "bad" },
            { url: "https://example.org/scan", label: "Scan" },
          ]),
        ]),
        { audience: "public" },
      );
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return r.value;
    })();
    expect(JSON.stringify(findingAid)).not.toContain("Private title");
    expect(findingAid.archdesc.links).toEqual([{ url: "https://example.org/scan", label: "Scan" }]);
    expect(notices.map((n) => n.code).sort()).toEqual(["link_left_out", "record_link_left_out"]);
  });

  it("puts other fields in a headed odd note, so nothing is lost", () => {
    const aid = made(
      findingAidFromUnits(ROOT, units([f("local_note", "text", "Kept", false, "Local note")]), {
        audience: "public",
      }),
    );
    expect(aid.archdesc.notes).toContainEqual({
      kind: "odd",
      head: "Local note",
      paragraphs: ["Kept"],
      internal: false,
    });
  });

  it("leaves out units not reachable from the top unit", () => {
    const r = findingAidFromUnits(
      ROOT,
      [...units(), { id: STRAY, parentId: STRAY, level: "file", title: "Orphan", fields: [] }],
      { audience: "public" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value.findingAid)).not.toContain("Orphan");
    expect(r.value.notices.map((n) => n.code)).toContain("units_not_placed");
  });

  it("refuses a missing top unit and too many units", () => {
    const missing = findingAidFromUnits(STRAY, units(), { audience: "public" });
    expect(missing.ok ? "" : missing.issues[0]?.code).toBe("not_found");
    const many: EadExportUnit[] = Array.from({ length: MAX_EXPORT_UNITS + 1 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000` as RecordId,
      level: "item",
      title: "x",
      fields: [],
    }));
    const big = findingAidFromUnits(ROOT, many, { audience: "public" });
    expect(big.ok ? "" : big.issues[0]?.code).toBe("too_many_units");
  });
});

describe("findingAidFromUnits: staff", () => {
  it("marks every staff-only value staff-only, and says so in the header", () => {
    const aid = made(
      findingAidFromUnits(
        ROOT,
        units(
          [f("appraisal", "long_text", "SECRET appraisal", true, "Appraisal")],
          [f("storage_location", "text", "SECRET shelf", true, "Shelf")],
        ),
        { audience: "staff", publicIdentifierTypes: new Set(["accession"]) },
      ),
    );
    expect(aid.archdesc.notes).toContainEqual({
      kind: "appraisal",
      head: "Appraisal",
      paragraphs: ["SECRET appraisal"],
      internal: true,
    });
    const file = aid.archdesc.children[0]?.children[0];
    expect(file?.physicalLocations).toEqual([]);
    expect(file?.notes).toEqual([
      { kind: "odd", head: "Shelf", paragraphs: ["SECRET shelf"], internal: true },
    ]);
    expect(aid.header.notes.join(" ")).toContain("staff-only");
  });

  it("writes a number of a type that isn't public as a staff-only note", () => {
    const aid = made(findingAidFromUnits(ROOT, units(), { audience: "staff" }));
    expect(aid.archdesc.identifiers).toEqual([]);
    expect(aid.archdesc.notes).toContainEqual({
      kind: "odd",
      head: "reference_code",
      paragraphs: ["DS5C740001"],
      internal: true,
    });
  });

  it("keeps a rights statement's note staff-only", () => {
    const aid = made(
      findingAidFromUnits(
        ROOT,
        units([
          f("rights", "rights", {
            uri: "http://rightsstatements.org/vocab/InC/1.0/",
            note: "SECRET deal",
          }),
        ]),
        { audience: "staff" },
      ),
    );
    const notes = aid.archdesc.notes.filter((n) => n.paragraphs.includes("SECRET deal"));
    expect(notes.length).toBe(1);
    expect(notes[0]?.internal).toBe(true);
    const pub = made(
      findingAidFromUnits(
        ROOT,
        units([
          f("rights", "rights", {
            uri: "http://rightsstatements.org/vocab/InC/1.0/",
            note: "SECRET deal",
          }),
        ]),
        { audience: "public" },
      ),
    );
    expect(JSON.stringify(pub)).not.toContain("SECRET deal");
  });
});

describe("export files read back", () => {
  for (const version of ["ead2002", "ead3"] as const) {
    it(`a staff export in ${version} keeps its staff-only marks through the reader`, () => {
      const aid = made(
        findingAidFromUnits(
          ROOT,
          units([f("appraisal", "long_text", "SECRET", true, "Appraisal")]),
          {
            audience: "staff",
          },
        ),
      );
      const written = writeEad(aid, { version, generatedAt: AT });
      if (!written.ok) throw new Error(JSON.stringify(written.issues));
      expect(written.value.xml).toMatch(/audience="internal"/);
      const read = readEad(written.value.xml);
      if (!read.ok) throw new Error(JSON.stringify(read.issues));
      expect(read.value.findingAid.archdesc).toEqual(aid.archdesc);
    });
  }
});
