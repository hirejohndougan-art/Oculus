import { describe, expect, it } from "vitest";
import { SAMPLE_MODEL } from "./ead.fixtures.js";
import {
  ARCHIVAL_LEVELS,
  DACS_ARCHIVAL_UNIT_PRESET,
  EAD_DACS_FIELDS,
  EAD_NOTE_KINDS,
  eadDateEdtf,
  eadParagraphs,
  levelFromEad,
  MAX_XML_ATTRIBUTE_LENGTH,
  normalizeEadText,
  validateFindingAid,
} from "./index.js";

describe("levelFromEad (D-107)", () => {
  it("takes Oculus's own levels as they are", () => {
    for (const level of ARCHIVAL_LEVELS) {
      expect(levelFromEad(level, undefined, "file")).toEqual({ level, changed: false });
    }
  });

  it("maps EAD's other levels and reports the change", () => {
    expect(levelFromEad("subfonds", undefined, "file")).toEqual({ level: "fonds", changed: true });
    expect(levelFromEad("recordgrp", undefined, "file")).toEqual({ level: "fonds", changed: true });
    expect(levelFromEad("subseries", undefined, "file")).toEqual({
      level: "series",
      changed: true,
    });
    expect(levelFromEad("subgrp", undefined, "file")).toEqual({ level: "series", changed: true });
    expect(levelFromEad("class", undefined, "file")).toEqual({
      level: "collection",
      changed: true,
    });
  });

  it("reads otherlevel when it names an Oculus level, otherwise collection", () => {
    expect(levelFromEad("otherlevel", " File ", "item")).toEqual({ level: "file", changed: true });
    expect(levelFromEad("otherlevel", "binder", "item")).toEqual({
      level: "collection",
      changed: true,
    });
    expect(levelFromEad("otherlevel", undefined, "item")).toEqual({
      level: "collection",
      changed: true,
    });
  });

  it("reads levels in any case, reporting the change", () => {
    expect(levelFromEad("Series", undefined, "file")).toEqual({ level: "series", changed: true });
    expect(levelFromEad("SubSeries", undefined, "file")).toEqual({
      level: "series",
      changed: true,
    });
  });

  it("uses the fallback for missing and unknown levels", () => {
    expect(levelFromEad(undefined, undefined, "file")).toEqual({ level: "file", changed: true });
    expect(levelFromEad("binder", undefined, "file")).toEqual({ level: "file", changed: true });
    expect(levelFromEad("hasOwnProperty", undefined, "file")).toEqual({
      level: "file",
      changed: true,
    });
  });
});

describe("EAD_DACS_FIELDS", () => {
  it("names only fields of the DACS preset, and covers every note kind", () => {
    const keys = new Set(DACS_ARCHIVAL_UNIT_PRESET.fields.map((f) => f.key));
    for (const m of EAD_DACS_FIELDS) expect(keys.has(m.field), m.field).toBe(true);
    const eads = new Set(EAD_DACS_FIELDS.map((m) => m.ead));
    for (const kind of EAD_NOTE_KINDS) expect(eads.has(kind), kind).toBe(true);
  });
});

describe("eadDateEdtf (D-008's safe conversion)", () => {
  it("converts the text when it is safe, keeping words EDTF can't say", () => {
    expect(eadDateEdtf({ text: "1890-1950" })).toEqual({
      ok: true,
      value: { edtf: "1890/1950", note: undefined },
    });
    const circa = eadDateEdtf({ text: "circa 1920", normal: "1920" });
    expect(circa.ok && circa.value.edtf).toBe("1920~");
  });

  it("falls back to @normal, keeping the text as a note", () => {
    expect(eadDateEdtf({ text: "Spring, the year of the flood", normal: "1900/1901" })).toEqual({
      ok: true,
      value: { edtf: "1900/1901", note: "Spring, the year of the flood" },
    });
    expect(eadDateEdtf({ text: "undated", normal: "19200105/19201231" })).toEqual({
      ok: true,
      value: { edtf: "1920-01-05/1920-12-31", note: "undated" },
    });
  });

  it("flags what it can't convert safely", () => {
    expect(eadDateEdtf({ text: "1900s" }).ok).toBe(false);
    expect(eadDateEdtf({ text: "undated", normal: "not-a-date" }).ok).toBe(false);
  });
});

describe("text helpers", () => {
  it("normalizes white space", () => {
    expect(normalizeEadText("  a\n\t b  c ")).toBe("a b c");
  });

  it("splits long text into paragraphs at blank lines", () => {
    expect(eadParagraphs("One\nline.\n\nTwo.\r\n  \r\nThree.\n\n\n")).toEqual([
      "One line.",
      "Two.",
      "Three.",
    ]);
    expect(eadParagraphs("   ")).toEqual([]);
  });
});

describe("validateFindingAid", () => {
  it("accepts the sample and returns a frozen copy", () => {
    const result = validateFindingAid(SAMPLE_MODEL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(SAMPLE_MODEL);
      expect(result.value).not.toBe(SAMPLE_MODEL);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("reports every problem with its path", () => {
    const bad = {
      header: { notes: [] },
      archdesc: {
        ...SAMPLE_MODEL.archdesc,
        level: "subfonds",
        title: undefined,
        dates: [{ text: "1900", normal: "1900 / 1901", type: "range" }],
        extents: [
          { quantity: "two", unit: "boxes" },
          { quantity: "2", unit: "boxes", measure: "pallets" },
        ],
        languages: [{ label: "English", code: "en g" }],
        notes: [{ kind: "secrets", paragraphs: [], internal: "no" }],
      },
    };
    const result = validateFindingAid(JSON.parse(JSON.stringify(bad)) as unknown);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const found = result.issues.map((i) => `${i.path.join(".")}:${i.code}`);
      expect(found).toEqual(
        expect.arrayContaining([
          "archdesc.level:not_allowed",
          "archdesc.dates.0.normal:not_a_code",
          "archdesc.dates.0.type:not_allowed",
          "archdesc.extents.0.quantity:not_a_number",
          "archdesc.extents.1.measure:not_allowed",
          "archdesc.languages.0.code:not_a_code",
          "archdesc.notes.0.kind:not_allowed",
          "archdesc.notes.0.internal:not_boolean",
          "archdesc.notes.0.paragraphs:empty",
        ]),
      );
    }
  });

  it("caps text that goes into attributes at what the reader can read back", () => {
    const long = "L".repeat(MAX_XML_ATTRIBUTE_LENGTH + 1);
    const aid = {
      ...SAMPLE_MODEL,
      archdesc: {
        ...SAMPLE_MODEL.archdesc,
        links: [{ url: "https://example.org/x", label: long }],
      },
    };
    const result = validateFindingAid(aid);
    expect(result.ok ? [] : result.issues.map((i) => `${i.path.join(".")}:${i.code}`)).toEqual([
      "archdesc.links.0.label:too_long",
    ]);
  });
});
