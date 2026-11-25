// Holds-only registers (T-018c, D-114): stored accessions reach core's
// deed check as their holds only (deed status, access restriction, the
// records they produced), and hold back exactly what a full register does.
// Every name here is invented.
import { describe, expect, it } from "vitest";
import {
  accessionById,
  effectivePublishIssues,
  indexAccessionHolds,
  type RecordId,
} from "./index.js";
import {
  ORG,
  OTHER,
  RECORDS,
  TODAY,
  accession,
  codes,
  effectiveOf,
  fonds,
  item,
  loose,
  ok,
  registerOf,
  scan,
  series,
  vase,
} from "./accessions.fixtures.js";

const hold = (records: readonly RecordId[], over: Record<string, unknown> = {}) => ({
  deedStatus: "missing",
  records,
  ...over,
});

function holdsOf(holds: unknown[], today = TODAY) {
  return ok(indexAccessionHolds(ORG, { holds, records: RECORDS, today }));
}

const issuesFor = (target: (typeof RECORDS)[number], accessions: unknown) =>
  codes(effectivePublishIssues(effectiveOf(target, RECORDS), { accessions }));

describe("indexAccessionHolds", () => {
  it("holds what a full register holds: the record, the units below and the scans", () => {
    const register = holdsOf([hold([fonds.id])]);
    for (const r of [fonds, series, item, scan]) {
      expect(issuesFor(r, register)).toContain("deed_not_signed");
    }
    expect(issuesFor(vase, register)).toEqual([]);
    // The same answer as a register of the whole accession.
    const full = registerOf([accession({ records: [{ recordId: fonds.id, label: "Fonds" }] })]);
    for (const r of [fonds, series, item, scan, vase, loose]) {
      expect(issuesFor(r, register)).toEqual(issuesFor(r, full));
    }
  });

  it("holds nothing for a signed or not-needed deed, and reads restrictions on its day", () => {
    expect(issuesFor(vase, holdsOf([hold([vase.id], { deedStatus: "signed" })]))).toEqual([]);
    expect(issuesFor(vase, holdsOf([hold([vase.id], { deedStatus: "not_needed" })]))).toEqual([]);
    const closed = hold([vase.id], {
      deedStatus: "signed",
      accessRestriction: { kind: "closed_until", until: "2030-01-01" },
    });
    expect(issuesFor(vase, holdsOf([closed], "2029-12-31"))).toContain("access_restricted");
    expect(issuesFor(vase, holdsOf([closed], "2030-01-01"))).toEqual([]);
    const staff = hold([vase.id], {
      deedStatus: "signed",
      accessRestriction: { kind: "staff_and_researchers" },
    });
    expect(issuesFor(vase, holdsOf([staff]))).toContain("access_restricted");
    expect(issuesFor(vase, holdsOf([hold([vase.id], { deedStatus: "sent" })]))).toContain(
      "deed_not_signed",
    );
  });

  it("ignores produced records it wasn't given, and knows only the records given", () => {
    const other = "4d6f5b1e-9c3a-4b7e-8f21-0a1b2c3d4e5f" as RecordId;
    expect(issuesFor(vase, holdsOf([hold([other])]))).toEqual([]);
    const few = ok(indexAccessionHolds(ORG, { holds: [], records: [vase], today: TODAY }));
    expect(issuesFor(fonds, few)).toContain("accessions_out_of_date");
  });

  it("is no full register: the queries know nothing of it", () => {
    expect(accessionById(holdsOf([]) as never, fonds.id)).toBeUndefined();
  });

  it("refuses what it can't read, naming nothing of the hold", () => {
    const bad = (input: unknown) => codes(indexAccessionHolds(ORG, input));
    expect(bad({ holds: [], records: RECORDS })).toEqual(["invalid_today"]);
    expect(bad({ holds: [], records: RECORDS, today: TODAY, extra: 1 })).toEqual(["invalid_input"]);
    for (const h of [
      { deedStatus: "lost", records: [] },
      { deedStatus: "missing" },
      { deedStatus: "missing", records: ["not-an-id"] },
      { deedStatus: "missing", records: [], number: "2026.015" },
      { deedStatus: "signed", records: [], accessRestriction: { kind: "closed_until" } },
    ]) {
      const result = indexAccessionHolds(ORG, { holds: [h], records: RECORDS, today: TODAY });
      expect(codes(result)).toEqual(["invalid_hold"]);
      expect(JSON.stringify(result)).not.toContain("2026.015");
    }
    expect(
      codes(indexAccessionHolds(OTHER, { holds: [], records: RECORDS, today: TODAY })),
    ).toEqual(["mixed_organizations"]);
  });
});
