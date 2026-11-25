// Round trips (D-107): a model written in either version and read again is
// the same model, and a file read in one version and written in the other
// reads back the same. The full model below holds every mapped element.
import { describe, expect, it } from "vitest";
import {
  EAD2002_DTD_SAMPLE,
  EAD2002_SAMPLE,
  EAD3_SAMPLE,
  FULL_MODEL,
  SAMPLE_MODEL,
} from "./ead.fixtures.js";
import { EAD_VERSIONS, readEad, writeEad, type EadVersion, type FindingAid } from "./index.js";

const AT = "2026-11-25T10:00:00Z";

function write(aid: FindingAid, version: EadVersion): string {
  const result = writeEad(aid, { version, generatedAt: AT });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.value.warnings).toEqual([]);
  return result.value.xml;
}

function read(xml: string): FindingAid {
  const result = readEad(xml);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.findingAid;
}

describe("EAD round trips", () => {
  for (const version of EAD_VERSIONS) {
    it(`model → ${version} → model gives the same model (every mapped element)`, () => {
      expect(read(write(FULL_MODEL, version))).toEqual(FULL_MODEL);
      expect(read(write(SAMPLE_MODEL, version))).toEqual(SAMPLE_MODEL);
    });
  }

  it("EAD 2002 → EAD3 → EAD 2002 gives the same model", () => {
    for (const file of [EAD2002_SAMPLE, EAD2002_DTD_SAMPLE]) {
      const first = read(file);
      const viaEad3 = read(write(first, "ead3"));
      expect(viaEad3).toEqual(first);
      expect(read(write(viaEad3, "ead2002"))).toEqual(first);
    }
  });

  it("EAD3 → EAD 2002 → EAD3 gives the same model", () => {
    const first = read(EAD3_SAMPLE);
    const via2002 = read(write(first, "ead2002"));
    expect(via2002).toEqual(first);
    expect(read(write(via2002, "ead3"))).toEqual(first);
  });

  it("writing what was read gives the same file again", () => {
    for (const version of EAD_VERSIONS) {
      const xml = write(FULL_MODEL, version);
      expect(write(read(xml), version)).toBe(xml);
    }
  });

  it("an imported file's own report is empty of surprises when it came from Oculus", () => {
    for (const version of EAD_VERSIONS) {
      const result = readEad(write(FULL_MODEL, version));
      if (!result.ok) throw new Error("unreadable");
      expect(result.value.report.levelChanges).toEqual([]);
      expect(result.value.report.warnings.filter((w) => w.code !== "date_not_edtf")).toEqual([]);
      // Not even EAD3's maintenance bookkeeping, which every export writes afresh.
      expect(result.value.report.unmapped).toEqual([]);
    }
  });
});
