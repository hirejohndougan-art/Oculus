import { describe, expect, it } from "vitest";
import {
  ACQUISITION_METHODS,
  DEED_STATUSES,
  accessionById,
  accessionsAwaitingDeeds,
  accessionsByNumber,
  accessionsOfRecord,
  deedHoldsOn,
  donorContact,
  effectivePublishIssues,
  indexAccessions,
  isAccessionId,
  isAccessionRegister,
  newAccessionId,
  nextAccessionNumber,
  publicOutput,
  publicView,
  recordsHeldBack,
  validateAccession,
  validateDonorContact,
  type PublicRecord,
} from "./index.js";
import {
  CNE,
  ORG,
  RECORDS,
  SECRET,
  TODAY,
  TYPES,
  accession,
  codes,
  contact,
  donor,
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
import {
  BASE,
  CHECKERS,
  MAPPING,
  identifiersFor,
  nowOf,
  record,
} from "./public-output.fixtures.js";

function publish(view: PublicRecord | undefined, accessions: unknown, records = RECORDS) {
  if (view === undefined) throw new Error("no public view");
  return publicOutput(view, MAPPING, {
    ...nowOf(view),
    baseUrl: BASE,
    published: [view.id],
    checkers: CHECKERS,
    identifiers: identifiersFor(records),
    accessions,
  });
}

describe("validateAccession", () => {
  it("accepts an accession and returns a frozen copy", () => {
    const given = accession();
    const a = ok(validateAccession(given));
    expect(a).toEqual(given);
    expect(a).not.toBe(given);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.records)).toBe(true);
    expect(isAccessionId(a.id)).toBe(true);
  });

  it("knows the Spectrum acquisition methods and the four deed statuses", () => {
    expect(ACQUISITION_METHODS).toEqual([
      "gift",
      "purchase",
      "bequest",
      "transfer",
      "field_collection",
      "found_in_collection",
      "other",
    ]);
    expect(DEED_STATUSES).toEqual(["missing", "sent", "signed", "not_needed"]);
    for (const method of ACQUISITION_METHODS) {
      expect(validateAccession(accession({ method, deedStatus: "signed" })).ok).toBe(true);
    }
  });

  it("refuses each field that is wrong", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ id: "not-an-id" }, "invalid_id"],
      [{ organizationId: "x" }, "invalid_organization"],
      [{ number: "2026.014" }, "required"],
      [{ number: { type: "Bad Type", value: "1" } }, "invalid_type"],
      [{ number: { type: "accession_number", value: " 1" } }, "untrimmed"],
      [{ number: { type: "accession_number", value: "1", primary: true } }, "unknown_property"],
      [{ sourceAgent: { recordId: "x", label: "Donor" } }, "invalid_id"],
      [{ sourceAgent: { recordId: donor.id } }, "required"],
      [{ receivedOn: "2026-02-30" }, "invalid_date"],
      [{ receivedOn: "2026-03" }, "invalid_date"],
      [{ method: "loan" }, "invalid_method"],
      [{ materials: "  " }, "required"],
      [{ restrictions: 5 }, "invalid_text"],
      [{ deedStatus: "lost" }, "invalid_deed_status"],
      [{ deedSignedOn: "2026-04-01" }, "not_signed"],
      [{ deedStatus: "signed", deedSignedOn: "April" }, "invalid_date"],
      [{ records: "fonds" }, "not_a_list"],
      [
        {
          records: [
            { recordId: fonds.id, label: "A" },
            { recordId: fonds.id, label: "B" },
          ],
        },
        "duplicate_record",
      ],
      [{ donorEmail: "x@example.invalid" }, "unknown_property"],
    ];
    for (const [over, code] of cases) {
      expect(codes(validateAccession(accession(over))), JSON.stringify(over)).toContain(code);
    }
  });

  it("refuses a gift marked as needing no deed, but not a transfer", () => {
    expect(codes(validateAccession(accession({ deedStatus: "not_needed" })))).toEqual([
      "deed_needed",
    ]);
    const transfer = accession({ method: "transfer", deedStatus: "not_needed" });
    expect(validateAccession(transfer).ok).toBe(true);
  });

  it("makes new accession IDs as version 4 UUIDs", () => {
    const a = newAccessionId();
    expect(isAccessionId(a)).toBe(true);
    expect(a).not.toBe(newAccessionId());
    expect(isAccessionId(a.toUpperCase())).toBe(false);
  });
});

describe("validateDonorContact", () => {
  it("accepts a contact with at least one way to reach the donor", () => {
    expect(ok(validateDonorContact(contact()))).toEqual(contact());
    expect(
      validateDonorContact({ agentId: donor.id, organizationId: ORG, email: SECRET.email }).ok,
    ).toBe(true);
    expect(codes(validateDonorContact({ agentId: donor.id, organizationId: ORG }))).toEqual([
      "no_contact",
    ]);
  });

  it("keeps email and phone to one line", () => {
    expect(codes(validateDonorContact(contact({ email: "a@b\nBcc: c@d" })))).toEqual([
      "control_characters",
    ]);
  });
});

describe("indexAccessions and its queries", () => {
  const missing = accession();
  const sent = accession({
    number: { type: "accession_number", value: "2025.040" },
    receivedOn: "2025-10-02",
    deedStatus: "sent",
    records: [{ recordId: vase.id, label: "Vase" }],
  });
  const signed = accession({
    number: { type: "accession_number", value: "2026.013" },
    deedStatus: "signed",
    deedSignedOn: "2026-02-01",
    records: [{ recordId: loose.id, label: "Loose" }],
  });
  const register = registerOf([missing, sent, signed], { contacts: [contact()] });

  it("is an opaque, frozen register of one organization", () => {
    expect(isAccessionRegister(register)).toBe(true);
    expect(isAccessionRegister({ ...register })).toBe(false);
    expect(Object.isFrozen(register)).toBe(true);
    expect(register).toEqual({ organizationId: ORG, size: 3, heldAsOf: TODAY });
    expect(JSON.stringify(register)).not.toContain(SECRET.donor);
  });

  it("finds accessions by ID, by number (ignoring case, spaces and lookalikes) and by record", () => {
    expect(accessionById(register, missing.id)).toEqual(missing);
    expect(accessionById(register, newAccessionId())).toBeUndefined();
    expect(accessionsByNumber(register, " 2026 .014 ")).toEqual([missing]);
    expect(accessionsByNumber(register, "2026–014")).toEqual([]);
    expect(accessionsByNumber(register, "2026.014", "other_type")).toEqual([]);
    expect(accessionsByNumber(register, "")).toEqual([]);
    expect(accessionsOfRecord(register, vase.id)).toEqual([sent]);
    // Only the records an accession lists, not the units below them.
    expect(accessionsOfRecord(register, item.id)).toEqual([]);
  });

  it("lists the accessions still waiting on a deed, oldest first (mockup Deeds)", () => {
    expect(accessionsAwaitingDeeds(register).map((a) => a.id)).toEqual([sent.id, missing.id]);
  });

  it("holds back the records below a produced unit and the assets that represent them", () => {
    for (const r of [fonds, series, item, scan]) {
      expect(deedHoldsOn(register, r.id), r.title).toEqual([missing]);
    }
    expect(deedHoldsOn(register, vase.id)).toEqual([sent]);
    expect(deedHoldsOn(register, loose.id)).toEqual([]);
    expect(deedHoldsOn(register, donor.id)).toEqual([]);
    expect([...recordsHeldBack(register)].sort()).toEqual(
      [fonds.id, series.id, item.id, scan.id, vase.id].sort(),
    );
  });

  it("gives a donor's contact details by agent", () => {
    expect(donorContact(register, donor.id)).toEqual(contact());
    expect(donorContact(register, fonds.id)).toBeUndefined();
  });

  it("gives the next accession number by the type's numbering", () => {
    expect(ok(nextAccessionNumber(register, "accession_number", { year: 2026 }))).toBe("2026.015");
    expect(ok(nextAccessionNumber(register, "accession_number", { year: 2027 }))).toBe("2027.001");
    expect(codes(nextAccessionNumber(register, "accession_number"))).toEqual(["year_required"]);
    expect(codes(nextAccessionNumber(register, "object_number", { year: 2026 }))).toEqual([
      "unknown_type",
    ]);
    const empty = registerOf([]);
    expect(ok(nextAccessionNumber(empty, "accession_number", { year: 2026 }))).toBe("2026.001");
  });

  it("refuses numbers of an unknown type, off the format, or used twice", () => {
    const clash = accession({ number: { type: "accession_number", value: "2026 . 014" } });
    const cases: [readonly unknown[], string][] = [
      [[accession({ number: { type: "object_number", value: "1" } })], "unknown_type"],
      [[accession({ number: { type: "accession_number", value: "14" } })], "format_mismatch"],
      [
        [missing, { ...clash, number: { type: "accession_number", value: "2026.014" } }],
        "duplicate_number",
      ],
      [[missing, missing], "duplicate_id"],
    ];
    for (const [list, code] of cases) {
      expect(
        codes(
          indexAccessions(ORG, {
            accessions: list as never,
            records: RECORDS,
            identifierTypes: TYPES,
            today: TODAY,
          }),
        ),
      ).toContain(code);
    }
  });

  it("checks links with the record link checker: a source is an agent, produced records aren't", () => {
    const run = (a: unknown, contacts: unknown[] = []) =>
      codes(
        indexAccessions(ORG, {
          accessions: [a] as never,
          contacts: contacts as never,
          records: RECORDS,
          identifierTypes: TYPES,
          today: TODAY,
        }),
      );
    expect(run(accession({ sourceAgent: { recordId: fonds.id, label: "Fonds" } }))).toEqual([
      "wrong_record_kind",
    ]);
    expect(run(accession({ records: [{ recordId: donor.id, label: "Donor" }] }))).toEqual([
      "wrong_record_kind",
    ]);
    const stranger = record("object", "Not in the set", {});
    expect(run(accession({ records: [{ recordId: stranger.id, label: "?" }] }))).toEqual([
      "unknown_record",
    ]);
    expect(run(accession(), [contact({ agentId: fonds.id })])).toEqual(["wrong_record_kind"]);
    expect(run(accession(), [contact(), contact()])).toEqual(["duplicate_contact"]);
  });

  it("takes the records as an index from indexRecords too", async () => {
    const { indexRecords } = await import("./index.js");
    const lookup = ok(indexRecords(RECORDS));
    const r = registerOf([missing], { records: lookup });
    expect(deedHoldsOn(r, scan.id)).toEqual([missing]);
  });
});

describe("the deed check (mockup Deeds)", () => {
  const holding = (deedStatus: string, recordId = fonds.id) =>
    registerOf([
      accession({
        deedStatus,
        method: "transfer",
        records: [{ recordId, label: "Produced" }],
      }),
    ]);

  it("holds back a record until its deed is signed or not needed", () => {
    for (const status of ["missing", "sent"]) {
      expect(
        codes(effectivePublishIssues(effectiveOf(fonds), { accessions: holding(status) })),
      ).toEqual(["deed_not_signed"]);
    }
    for (const status of ["signed", "not_needed"]) {
      expect(effectivePublishIssues(effectiveOf(fonds), { accessions: holding(status) })).toEqual(
        [],
      );
    }
  });

  it("holds back what is filed below a produced unit, and a scan of it", () => {
    const accessions = holding("missing");
    for (const r of [series, item, scan]) {
      expect(codes(effectivePublishIssues(effectiveOf(r), { accessions })), r.title).toEqual([
        "deed_not_signed",
      ]);
    }
    expect(effectivePublishIssues(effectiveOf(vase), { accessions })).toEqual([]);
  });

  it("refuses a register that doesn't know the record, its ancestry or what it shows", () => {
    const stale = holding("missing");
    const late = record("archival_unit", "Filed later", {}, { level: "item", parentId: series.id });
    const lateScan = record(
      "digital_asset",
      "Late scan",
      { rights: { uri: CNE } },
      { represents: late.id },
    );
    const now = [...RECORDS, late, lateScan];
    for (const r of [late, lateScan]) {
      expect(
        codes(effectivePublishIssues(effectiveOf(r, now), { accessions: stale })),
        r.title,
      ).toEqual(["accessions_out_of_date"]);
    }
    // A register made from the records as they are now decides.
    const fresh = registerOf([accession({ method: "transfer" })], { records: now });
    for (const r of [late, lateScan]) {
      expect(
        codes(effectivePublishIssues(effectiveOf(r, now), { accessions: fresh })),
        r.title,
      ).toEqual(["deed_not_signed"]);
    }
    // An empty register knows nothing, so it clears nothing.
    expect(
      codes(
        effectivePublishIssues(effectiveOf(vase), { accessions: registerOf([], { records: [] }) }),
      ),
    ).toEqual(["accessions_out_of_date"]);
  });

  it("refuses a scan whose represented record isn't in the records given", () => {
    const orphan = record(
      "digital_asset",
      "Orphan scan",
      { rights: { uri: CNE } },
      {
        represents: item.id,
      },
    );
    const accessions = registerOf([], { records: [...RECORDS, orphan] });
    expect(codes(effectivePublishIssues(effectiveOf(orphan, [orphan]), { accessions }))).toEqual([
      "represented_record_unknown",
    ]);
  });

  it("needs no register for agents, places and events, which aren't accessioned", () => {
    expect(effectivePublishIssues(effectiveOf(donor))).toEqual([]);
    expect(effectivePublishIssues(effectiveOf(donor), { accessions: holding("missing") })).toEqual(
      [],
    );
  });

  it("runs after every other check, which it never hides", () => {
    const bare = record("object", "No rights", {});
    expect(codes(effectivePublishIssues(effectiveOf(bare, [bare])))).toEqual(["rights_missing"]);
  });

  it("is applied by publicOutput, against the register given now", () => {
    const view = publicView(effectiveOf(fonds));
    expect(codes(publish(view, holding("missing")))).toEqual(["deed_not_signed"]);
    expect(codes(publish(view, undefined))).toEqual(["accessions_unknown"]);
    // The same view, once the deed is signed.
    const out = ok(publish(view, holding("signed")));
    expect(out.dublinCore.title).toEqual(["Fonds"]);
  });

  it("is how T-034 will publish: a fresh register, checked at the moment of publishing", () => {
    const view = publicView(effectiveOf(vase));
    // Made with the deed signed, then the deed found to be missing after all.
    expect(ok(publish(view, holding("signed", vase.id))).id).toBe(BASE + vase.id);
    expect(codes(publish(view, holding("missing", vase.id)))).toEqual(["deed_not_signed"]);
  });
});
