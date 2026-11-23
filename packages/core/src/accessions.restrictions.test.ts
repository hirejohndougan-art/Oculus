// Structured access restrictions on accessions (T-016a, D-053b): closed
// until a day, or staff and researchers only, hold records back from
// publishing exactly as an unsigned deed does. Every name and date here is
// invented.
import { afterEach, describe, expect, it } from "vitest";
import {
  deedHoldsOn,
  effectivePublishIssues,
  effectiveRecord,
  indexAccessions,
  publicOutput,
  publicView,
  recordsHeldBack,
  restrictionHoldsOn,
  validateAccession,
  type CatalogRecord,
  type Issue,
  type PublicRecord,
} from "./index.js";
import {
  CNE,
  ORG,
  OTHER,
  RECORDS,
  SECRET,
  TODAY,
  TYPES,
  accession,
  codes,
  donor,
  effectiveOf,
  fonds,
  item,
  ok,
  registerOf,
  scan,
  series,
  vase,
} from "./accessions.fixtures.js";
import {
  BASE,
  CHECKERS,
  FIELDS,
  MAPPING,
  everything,
  field,
  identifiersFor,
  linkChecker,
  noAccessions,
  record,
  template,
} from "./public-output.fixtures.js";

/** An invented end date that must never reach a message or public output. */
const UNTIL = "2031-07-04";

function closedUntil(until: string, over: Record<string, unknown> = {}) {
  return accession({
    deedStatus: "signed",
    accessRestriction: { kind: "closed_until", until },
    ...over,
  });
}
const staffOnly = (over: Record<string, unknown> = {}) =>
  accession({
    deedStatus: "signed",
    accessRestriction: { kind: "staff_and_researchers" },
    ...over,
  });

function issuesOf(target: CatalogRecord, accessions: unknown, records = RECORDS) {
  return codes(effectivePublishIssues(effectiveOf(target, records), { accessions }));
}

function messages(found: readonly Issue[] | { ok: boolean; issues?: readonly Issue[] }): string {
  const list = Array.isArray(found)
    ? (found as readonly Issue[])
    : ((found as { issues?: readonly Issue[] }).issues ?? []);
  return list.map((i) => `${i.code} ${i.message} ${JSON.stringify(i.path)}`).join("\n");
}

function publish(view: PublicRecord | undefined, accessions: unknown) {
  if (view === undefined) throw new Error("no public view");
  return publicOutput(view, MAPPING, {
    baseUrl: BASE,
    published: [view.id],
    checkers: CHECKERS,
    identifiers: identifiersFor(RECORDS),
    accessions,
  });
}

describe("validateAccession: structured restrictions", () => {
  it("accepts closed until a day and staff and researchers only, beside free-text notes", () => {
    for (const a of [closedUntil(UNTIL), staffOnly()]) {
      const v = ok(validateAccession(a));
      expect(v.accessRestriction).toEqual(a.accessRestriction);
      expect(Object.isFrozen(v.accessRestriction)).toBe(true);
      expect(v.restrictions).toBe(SECRET.restrictions);
    }
    // Left out: no structured restriction.
    expect(ok(validateAccession(accession())).accessRestriction).toBeUndefined();
  });

  it("refuses malformed end dates, never quoting them", () => {
    const bad: unknown[] = [
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "2026-1-05",
      "20261124",
      "2026-11-24T00:00:00Z",
      "2026-11-24T00:00:00-06:00",
      " 2026-11-24",
      "2026-11-24\n",
      "+02026-11-24",
      "0999-12-31",
      "2026-11",
      "2026",
      "２０２６-11-24",
      "",
      20261124,
      null,
      true,
      ["2026-11-24"],
      { day: "2026-11-24" },
    ];
    for (const until of bad) {
      const r = validateAccession(closedUntil(until as string));
      expect(codes(r), JSON.stringify(until)).toEqual(["invalid_date"]);
      if (typeof until === "string" && until.length > 4) {
        expect(messages(r as { ok: boolean; issues: readonly Issue[] })).not.toContain(until);
      }
    }
    // A leap day that exists is fine.
    expect(validateAccession(closedUntil("2028-02-29")).ok).toBe(true);
  });

  it("refuses unknown kinds, missing or extra parts, and text in place of a restriction", () => {
    const cases: [unknown, string[]][] = [
      [{ kind: "other" }, ["invalid_restriction"]],
      [{ kind: "closed", until: UNTIL }, ["unknown_property", "invalid_restriction"]],
      [{}, ["invalid_restriction"]],
      [{ kind: "closed_until" }, ["invalid_date"]],
      [{ kind: "staff_and_researchers", until: UNTIL }, ["unknown_property"]],
      [{ kind: "closed_until", until: UNTIL, from: "2026-01-01" }, ["unknown_property"]],
      ["Closed until 2031", ["invalid_restriction"]],
      [[{ kind: "staff_and_researchers" }], ["invalid_restriction"]],
      [null, ["invalid_restriction"]],
    ];
    for (const [restriction, expected] of cases) {
      const r = validateAccession(accession({ accessRestriction: restriction }));
      expect(codes(r).sort(), JSON.stringify(restriction)).toEqual([...expected].sort());
      expect(messages(r as { ok: boolean; issues: readonly Issue[] })).not.toContain(UNTIL);
    }
  });

  describe("with Object.prototype polluted", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).until;
      delete (Object.prototype as Record<string, unknown>).today;
    });

    it("an end date on the prototype doesn't complete a restriction left without one", () => {
      (Object.prototype as Record<string, unknown>).until = "2000-01-01";
      const r = validateAccession(accession({ accessRestriction: { kind: "closed_until" } }));
      expect(codes(r)).toEqual(["invalid_date"]);
      // So the register refuses it rather than judging it ended long ago.
      const reg = indexAccessions(ORG, {
        accessions: [accession({ accessRestriction: { kind: "closed_until" } })],
        records: RECORDS,
        identifierTypes: TYPES,
        today: TODAY,
      });
      expect(codes(reg)).toEqual(["invalid_date"]);
    });

    it("a day on the prototype isn't taken as today", () => {
      (Object.prototype as Record<string, unknown>).today = "9999-12-31";
      const r = indexAccessions(ORG, {
        accessions: [closedUntil(UNTIL)],
        records: RECORDS,
        identifierTypes: TYPES,
      } as never);
      expect(codes(r)).toEqual(["invalid_today"]);
    });
  });
});

describe("indexAccessions needs today from the caller", () => {
  const base = { accessions: [closedUntil(UNTIL)], records: RECORDS, identifierTypes: TYPES };

  it("refuses a register without a day, or with anything but a calendar day", () => {
    const bad: unknown[] = [
      undefined,
      new Date("2026-11-23T12:00:00Z"),
      Date.UTC(2026, 10, 23),
      "2026-11-23T23:30:00-06:00",
      "2026-11-24T05:30:00Z",
      "2026-11-31",
      "11/23/2026",
      "today",
      "",
    ];
    for (const today of bad) {
      const r = indexAccessions(ORG, { ...base, today } as never);
      expect(codes(r), String(today)).toEqual(["invalid_today"]);
    }
    const getter = { ...base };
    Object.defineProperty(getter, "today", { get: () => TODAY, enumerable: true });
    expect(codes(indexAccessions(ORG, getter as never))).toEqual(["invalid_input"]);
  });

  it("says which day it judged restrictions on", () => {
    expect(registerOf([], { today: "2027-01-01" }).heldAsOf).toBe("2027-01-01");
  });
});

describe("a restriction holds records back like an unsigned deed", () => {
  it("closed until tomorrow holds today, and holds nothing from tomorrow on", () => {
    const tomorrow = "2026-11-24";
    for (const today of ["2026-11-22", "2026-11-23"]) {
      expect(issuesOf(fonds, registerOf([closedUntil(tomorrow)], { today })), today).toEqual([
        "access_restricted",
      ]);
    }
    for (const today of ["2026-11-24", "2026-11-25", "2099-01-01"]) {
      expect(issuesOf(fonds, registerOf([closedUntil(tomorrow)], { today })), today).toEqual([]);
    }
  });

  it("is judged on the organization's own day, which the caller works out (time zone edge)", () => {
    // 11:30 pm on 23 November in Texas is already 24 November in UTC.
    const instant = new Date("2026-11-24T05:30:00Z");
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(instant);
    const utc = instant.toISOString().slice(0, 10);
    expect([local, utc]).toEqual(["2026-11-23", "2026-11-24"]);
    const restriction = closedUntil("2026-11-24");
    // Given the Texas day, still closed; core never turns an instant into a day itself.
    expect(issuesOf(fonds, registerOf([restriction], { today: local }))).toEqual([
      "access_restricted",
    ]);
    expect(issuesOf(fonds, registerOf([restriction], { today: utc }))).toEqual([]);
    expect(
      codes(
        indexAccessions(ORG, {
          accessions: [restriction],
          records: RECORDS,
          identifierTypes: TYPES,
          today: instant.toISOString(),
        }),
      ),
    ).toEqual(["invalid_today"]);
    // Across a year end, compared as days.
    expect(
      issuesOf(fonds, registerOf([closedUntil("2027-01-01")], { today: "2026-12-31" })),
    ).toEqual(["access_restricted"]);
  });

  it("staff and researchers only holds on any day", () => {
    for (const today of ["1000-01-01", TODAY, "9999-12-31"]) {
      expect(issuesOf(fonds, registerOf([staffOnly()], { today })), today).toEqual([
        "access_restricted",
      ]);
    }
  });

  it("free-text restrictions stay notes and hold nothing", () => {
    const notes = accession({
      deedStatus: "signed",
      restrictions: "Closed until 2090. Staff and researchers only.",
    });
    expect(issuesOf(fonds, registerOf([notes]))).toEqual([]);
    expect(recordsHeldBack(registerOf([notes]))).toEqual([]);
  });

  it("holds the units below, the scans that represent them, and nothing else", () => {
    for (const make of [() => closedUntil(UNTIL), () => staffOnly()]) {
      const accessions = registerOf([make()]);
      for (const r of [fonds, series, item, scan]) {
        expect(issuesOf(r, accessions), r.title).toEqual(["access_restricted"]);
      }
      expect(issuesOf(vase, accessions)).toEqual([]);
      expect(issuesOf(donor, accessions)).toEqual([]);
      expect(new Set(recordsHeldBack(accessions))).toEqual(
        new Set([fonds.id, series.id, item.id, scan.id]),
      );
    }
  });

  it("holds a record a restricted accession produced deep down, and its scan, from the top unchanged", () => {
    const accessions = registerOf([staffOnly({ records: [{ recordId: item.id, label: "I" }] })]);
    expect(issuesOf(fonds, accessions)).toEqual([]);
    expect(issuesOf(series, accessions)).toEqual([]);
    expect(issuesOf(item, accessions)).toEqual(["access_restricted"]);
    expect(issuesOf(scan, accessions)).toEqual(["access_restricted"]);
  });

  it("a record moved under a restricted unit is held by a register made now", () => {
    const moved = record("object", "Moved object", { rights: { uri: CNE } });
    const unit = record(
      "archival_unit",
      "Moved in",
      { rights: { uri: CNE } },
      { level: "item", parentId: series.id },
    );
    const shot = record(
      "digital_asset",
      "Shot of the moved unit",
      { rights: { uri: CNE } },
      { represents: unit.id },
    );
    const now = [...RECORDS, moved, unit, shot];
    const register = registerOf([staffOnly()], { records: now });
    expect(issuesOf(unit, register, now)).toEqual(["access_restricted"]);
    expect(issuesOf(shot, register, now)).toEqual(["access_restricted"]);
    expect(issuesOf(moved, register, now)).toEqual([]);
    // A register made before the move doesn't know them, so clears nothing.
    expect(issuesOf(unit, registerOf([staffOnly()]), now)).toEqual(["accessions_out_of_date"]);
  });

  it("reports both reasons when a deed and a restriction both hold", () => {
    const both = closedUntil(UNTIL, { deedStatus: "missing" });
    expect(issuesOf(item, registerOf([both]))).toEqual(["deed_not_signed", "access_restricted"]);
    // Two accessions listing one record: the stricter wins.
    const free = accession({ deedStatus: "signed", records: [{ recordId: fonds.id, label: "F" }] });
    const shut = staffOnly({
      number: { type: "accession_number", value: "2026.015" },
      records: [{ recordId: series.id, label: "S" }],
    });
    expect(issuesOf(item, registerOf([free, shut]))).toEqual(["access_restricted"]);
    expect(issuesOf(fonds, registerOf([free, shut]))).toEqual([]);
  });

  it("is found by restrictionHoldsOn, apart from deed holds", () => {
    const shut = closedUntil(UNTIL, { deedStatus: "missing" });
    const register = registerOf([shut]);
    expect(restrictionHoldsOn(register, item.id).map((a) => a.id)).toEqual([shut.id]);
    expect(deedHoldsOn(register, item.id).map((a) => a.id)).toEqual([shut.id]);
    const ended = registerOf([closedUntil("2026-11-23")]);
    expect(restrictionHoldsOn(ended, item.id)).toEqual([]);
    expect(deedHoldsOn(ended, item.id)).toEqual([]);
    expect(restrictionHoldsOn(ended, "nope")).toEqual([]);
    expect(restrictionHoldsOn({ organizationId: ORG } as never, item.id)).toEqual([]);
  });

  it("is applied by publicOutput, against the register given now", () => {
    const view = publicView(effectiveOf(item));
    expect(codes(publish(view, registerOf([closedUntil(UNTIL)])))).toEqual(["access_restricted"]);
    // A register kept from before the end date still holds (it errs on holding)…
    const kept = registerOf([closedUntil("2026-11-24")], { today: "2026-11-23" });
    expect(codes(publish(view, kept))).toEqual(["access_restricted"]);
    // …and one made on the end date lets the record out.
    const fresh = registerOf([closedUntil("2026-11-24")], { today: "2026-11-24" });
    expect(ok(publish(view, fresh)).id).toBe(BASE + item.id);
  });
});

describe("a link to a restricted record is treated as a link to an unpublished one", () => {
  const tpl = template([
    ...FIELDS,
    field({ key: "related", kind: "record_link", repeatable: true }),
  ]);
  const map = {
    organizationId: ORG,
    template: "out",
    entries: [
      { field: "rights", term: "rights" },
      { field: "related", term: "relation" },
    ],
  };
  const page = record("object", "Page", {
    rights: { uri: CNE },
    related: [
      { recordId: item.id, label: "Linked item" },
      { recordId: scan.id, label: "Linked scan" },
      { recordId: vase.id, label: "Free vase" },
    ],
  });
  const records = [...RECORDS, page];
  const checkers = { ...CHECKERS, record_link: linkChecker(records) };
  const run = (accessions: unknown) => {
    const e = ok(
      effectiveRecord(page.id, records, () => tpl, {
        checkers,
        identifiers: identifiersFor(records),
      }),
    );
    const view = publicView(e);
    if (view === undefined) throw new Error("no public view");
    return everything(
      ok(
        publicOutput(view, map, {
          baseUrl: BASE,
          published: [page.id, item.id, scan.id, vase.id],
          checkers,
          identifiers: identifiersFor(records),
          accessions,
          records,
        }),
      ),
    );
  };

  it("through the unit above it and what a scan shows, exactly as a deed hold does", () => {
    const restricted = run(registerOf([closedUntil(UNTIL)], { records }));
    const deedHeld = run(registerOf([accession()], { records }));
    expect(restricted).not.toContain(BASE + item.id);
    expect(restricted).not.toContain(BASE + scan.id);
    expect(restricted).toContain(BASE + vase.id);
    expect(restricted).toBe(deedHeld);
    expect(run(registerOf([staffOnly()], { records }))).toBe(deedHeld);
  });

  it("becomes a live link once the restriction has ended", () => {
    const ended = run(registerOf([closedUntil(UNTIL)], { records, today: UNTIL }));
    expect(ended).toContain(BASE + item.id);
    expect(ended).toContain(BASE + scan.id);
  });
});

describe("another organization's register", () => {
  it("can't clear or hold our records, restricted or not", () => {
    const theirs = indexAccessions(OTHER, {
      accessions: [],
      records: [],
      identifierTypes: [],
      today: "9999-12-31",
    });
    for (const r of [fonds, item, scan, vase]) {
      expect(issuesOf(r, ok(theirs)), r.title).toEqual(["mixed_organizations"]);
    }
    expect(codes(publish(publicView(effectiveOf(item)), noAccessions(OTHER)))).toEqual([
      "mixed_organizations",
    ]);
  });

  it("can't bring its restricted accession into ours, and its restriction isn't named", () => {
    const r = indexAccessions(ORG, {
      accessions: [closedUntil(UNTIL, { organizationId: OTHER })],
      records: RECORDS,
      identifierTypes: TYPES,
      today: TODAY,
    });
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(r)).not.toContain(UNTIL);
    expect(JSON.stringify(r)).not.toContain(OTHER);
  });
});

describe("restrictions are staff-only", () => {
  const secrets = [UNTIL, "closed_until", "staff_and_researchers", SECRET.restrictions];

  it("never appear in the messages of the check or of publishing", () => {
    for (const register of [
      registerOf([closedUntil(UNTIL)]),
      registerOf([staffOnly()]),
      registerOf([closedUntil(UNTIL, { deedStatus: "sent" })]),
    ]) {
      for (const r of [fonds, item, scan]) {
        const e = effectiveOf(r);
        const text = [
          messages(effectivePublishIssues(e, { accessions: register })),
          messages(publish(publicView(e), register)),
        ].join("\n");
        for (const s of [...secrets, SECRET.number, SECRET.donor]) {
          expect(text, r.title).not.toContain(s);
        }
      }
    }
  });

  it("never appear in public output once the restriction has ended", () => {
    const ended = registerOf([closedUntil(UNTIL)], { today: "2032-01-01" });
    for (const r of [fonds, item, scan]) {
      const view = publicView(effectiveOf(r));
      expect(JSON.stringify(view)).not.toContain(UNTIL);
      const out = everything(ok(publish(view, ended)));
      for (const s of secrets) expect(out, r.title).not.toContain(s);
    }
  });

  it("aren't shared with the publish check beyond why a record is held", () => {
    const register = registerOf([closedUntil(UNTIL)]);
    expect(JSON.stringify(register)).not.toContain(UNTIL);
    expect(Object.keys(register).sort()).toEqual(["heldAsOf", "organizationId", "size"]);
  });
});
