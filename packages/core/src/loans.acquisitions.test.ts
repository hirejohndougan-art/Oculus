// A borrowed record the organization buys or is given closes its loan in
// through a link from an accession (T-018a1, D-059), and an overdue loan can
// still never be taken off the list without that link checked (D-044).
import { afterEach, describe, expect, it } from "vitest";
import {
  accessionsOfLoan,
  indexAccessions,
  indexLocations,
  indexLoans,
  indexMoves,
  loanProblems,
  loanState,
  moveHistory,
  newLoanId,
  newLocationId,
  newMoveId,
  newOrganizationId,
  overdueLoans,
  reindexLoans,
  validateAccession,
  validateLoan,
  withLoan,
  type AccessionRegister,
  type LoanBook,
  type LoanIn,
  type LoanOut,
  type MoveLog,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";
import { record } from "./public-output.fixtures.js";
import {
  ORG,
  RECORDS,
  TODAY,
  TYPES,
  accession,
  codes,
  donor,
  loose,
  ok,
  registerOf,
  vase,
} from "./accessions.fixtures.js";

const NOW = new Date("2026-11-23T18:00:00.000Z");
const LATE = "2027-05-01";
const LENDER = donor.id;
const lantern = vase.id;
const bell = loose.id;

const room = { id: newLocationId(), organizationId: ORG, kind: "storage", name: "Room", level: 0 };
const lenderPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Railroad society",
  agentId: LENDER,
};
const borrowerPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "County museum",
  agentId: LENDER,
};
const INDEX = ok(
  indexLocations({ organizationId: ORG, levels: ["Room"] }, [
    room,
    lenderPlace,
    borrowerPlace,
  ] as StorageLocation[]),
);

let tick = 0;
function move(
  recordId: string,
  locationId: string,
  movedOn: string,
  reason: StorageMove["reason"],
  extra: Partial<StorageMove> = {},
): StorageMove {
  tick += 1;
  return {
    id: newMoveId(),
    organizationId: ORG,
    recordId,
    locationId,
    movedOn,
    reason,
    recordedAt: new Date(Date.parse("2026-11-23T16:00:00.000Z") + tick * 1000).toISOString(),
    ...extra,
  } as StorageMove;
}

const lanternIn = move(lantern, room.id, "2026-10-01", "placement");
const bellIn = move(bell, room.id, "2026-10-01", "placement");
const bellBack = move(bell, lenderPlace.id, "2026-11-01", "departure");
const LOG = ok(indexMoves(INDEX, [lanternIn, bellIn, bellBack]));

function loanIn(extra: Partial<LoanIn> = {}): LoanIn {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "in",
    number: "LI-2026-001",
    agentId: LENDER,
    beginOn: "2026-10-01",
    endOn: "2027-03-31",
    status: "agreed",
    statusOn: "2026-09-20",
    items: [{ recordId: lantern, arrivalMoveId: lanternIn.id }],
    ...extra,
  };
}

/** The lantern bought from the lender, a month after it arrived. */
function bought(loan: { id: string }, over: Record<string, unknown> = {}) {
  return accession({
    method: "purchase",
    deedStatus: "not_needed",
    receivedOn: "2026-11-01",
    records: [{ recordId: lantern, label: "Lantern" }],
    loanInId: loan.id,
    ...over,
  });
}

function book(
  loans: readonly unknown[],
  register?: AccessionRegister,
  log: MoveLog = LOG,
): Validated<LoanBook> {
  return indexLoans(log, loans, NOW, register);
}

function problems(b: Validated<LoanBook>): string[] {
  if (!b.ok) return b.issues.map((i) => i.code);
  return ok(loanProblems(b.value)).flatMap((p) => p.problems.map((i) => i.code));
}

function overdueIds(b: LoanBook, today = LATE): string[] {
  return ok(overdueLoans(b, today)).map((s) => s.loan.id);
}

describe("an accession closes a loan in", () => {
  it("counts the item as acquired, not out, and keeps its history", () => {
    const loan = loanIn();
    const register = registerOf([bought(loan)]);
    expect(accessionsOfLoan(register, loan.id).length).toBe(1);
    const b = ok(book([loan], register));
    const state = ok(loanState(b, loan.id));
    expect(state.items[0]?.out).toBe(false);
    expect(state.items[0]?.acquiredBy).toEqual([accessionsOfLoan(register, loan.id)[0]?.id]);
    expect(state.items[0]?.started?.id).toBe(lanternIn.id);
    expect(overdueIds(b)).toEqual([]);
    // Without the accession the same loan is overdue.
    expect(overdueIds(ok(book([loan])))).toEqual([loan.id]);
    // The move history is untouched.
    expect(ok(moveHistory(LOG, lantern)).map((m) => m.id)).toEqual([lanternIn.id]);
  });

  it("lets the loan be marked acquired, which ends it", () => {
    const loan = loanIn();
    const register = registerOf([bought(loan)]);
    const agreed = ok(book([loan], register));
    const acquired = ok(
      withLoan(agreed, { ...loan, status: "acquired", statusOn: "2026-11-02" }, NOW, register),
    );
    const state = ok(loanState(acquired, loan.id));
    expect(state.phase).toBe("acquired");
    expect(state.problems).toEqual([]);
    expect(overdueIds(acquired)).toEqual([]);
  });

  it("an acquired loan may also have items that went back", () => {
    const loan = loanIn({
      status: "acquired",
      statusOn: "2026-11-02",
      items: [
        { recordId: lantern, arrivalMoveId: lanternIn.id },
        { recordId: bell, arrivalMoveId: bellIn.id, departureMoveId: bellBack.id },
      ],
    });
    const b = book([loan], registerOf([bought(loan)]));
    expect(problems(b)).toEqual([]);
    expect(ok(loanState(ok(b), loan.id)).phase).toBe("acquired");
  });

  it("a loan out can't be acquired", () => {
    const out: LoanOut = {
      id: newLoanId(),
      organizationId: ORG,
      direction: "out",
      number: "LO-1",
      agentId: LENDER,
      beginOn: "2026-10-01",
      endOn: "2026-12-01",
      status: "acquired",
      statusOn: "2026-10-01",
      items: [{ recordId: lantern }],
    };
    expect(codes(validateLoan(out, NOW))).toEqual(["not_a_loan_in"]);
  });

  it("only a gift, purchase, bequest or transfer comes from a loan, and loanInId is a loan ID", () => {
    const loan = loanIn();
    expect(codes(validateAccession(bought(loan, { method: "found_in_collection" })))).toEqual([
      "loan_method",
    ]);
    expect(codes(validateAccession(bought(loan, { loanInId: "LI-2026-001" })))).toEqual([
      "invalid_id",
    ]);
    for (const method of ["gift", "bequest", "transfer"]) {
      expect(codes(validateAccession(bought(loan, { method, deedStatus: "signed" })))).toEqual([]);
    }
  });
});

describe("an overdue loan in is never taken off the list by an unchecked acquisition", () => {
  it("not by marking it acquired without the register", () => {
    const loan = loanIn({ status: "acquired", statusOn: "2026-11-02" });
    const b = book([loan]);
    expect(problems(b)).toEqual(["acquisitions_unknown"]);
    expect(ok(loanState(ok(b), loan.id)).phase).toBe("unknown");
    expect(overdueIds(ok(b))).toEqual([loan.id]);
    expect(codes(withLoan(ok(book([])), loan, NOW))).toEqual(["acquisitions_unknown"]);
  });

  it("not by marking it acquired with no accession linked", () => {
    const loan = loanIn({ status: "acquired", statusOn: "2026-11-02" });
    const b = book([loan], registerOf([]));
    expect(problems(b)).toEqual(["nothing_acquired", "acquired_with_items_out"]);
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });

  it("not by a gift whose deed isn't signed: title hasn't passed", () => {
    const loan = loanIn();
    for (const deedStatus of ["missing", "sent"]) {
      const register = registerOf([bought(loan, { method: "gift", deedStatus })]);
      const b = ok(book([loan], register));
      expect(ok(loanState(b, loan.id)).items[0]?.out).toBe(true);
      expect(overdueIds(b)).toEqual([loan.id]);
      const acquired = { ...loan, status: "acquired", statusOn: "2026-11-02" };
      expect(problems(book([acquired], register))).toEqual([
        "nothing_acquired",
        "acquired_with_items_out",
      ]);
    }
  });

  it("not by an accession of another record, or naming another loan", () => {
    const loan = loanIn();
    const other = registerOf([
      bought(loan, { records: [{ recordId: bell, label: "Bell" }] }),
      bought({ id: newLoanId() }, { number: { type: "accession_number", value: "2026.015" } }),
    ]);
    expect(overdueIds(ok(book([loan], other)))).toEqual([loan.id]);
  });

  it("not for a loan out an accession names", () => {
    const sent = move(lantern, borrowerPlace.id, "2026-10-05", "loan_out", {
      expectedReturnOn: "2026-12-01",
    });
    const log = ok(indexMoves(INDEX, [lanternIn, sent]));
    const out: LoanOut = {
      id: newLoanId(),
      organizationId: ORG,
      direction: "out",
      number: "LO-1",
      agentId: LENDER,
      beginOn: "2026-10-01",
      endOn: "2026-12-01",
      status: "agreed",
      statusOn: "2026-09-01",
      items: [{ recordId: lantern, loanOutMoveId: sent.id }],
    };
    const b = ok(book([out], registerOf([bought(out)]), log));
    expect(ok(loanState(b, out.id)).items[0]?.out).toBe(true);
    expect(overdueIds(b)).toEqual([out.id]);
  });

  it("not by an accession received before the item arrived", () => {
    const loan = loanIn();
    const b = book([loan], registerOf([bought(loan, { receivedOn: "2026-09-30" })]));
    expect(problems(b)).toEqual(["acquired_before_arrival"]);
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });

  it("not for an item with no arrival linked, or one that went back", () => {
    const loan = loanIn({ items: [{ recordId: lantern }] });
    expect(problems(book([loan], registerOf([bought(loan)])))).toEqual([
      "acquired_without_arrival",
    ]);
    const back = loanIn({
      items: [{ recordId: bell, arrivalMoveId: bellIn.id, departureMoveId: bellBack.id }],
    });
    const register = registerOf([bought(back, { records: [{ recordId: bell, label: "Bell" }] })]);
    expect(problems(book([back], register))).toEqual(["acquired_and_departed"]);
  });

  it("not by closing it: an acquired item makes the loan acquired, not closed", () => {
    const loan = loanIn({ status: "closed", statusOn: "2026-11-02" });
    expect(problems(book([loan], registerOf([bought(loan)])))).toEqual(["closed_with_items_out"]);
  });

  it("comes back on the list when the accession drops the link", () => {
    const loan = loanIn({ status: "acquired", statusOn: "2026-11-02" });
    const a = bought(loan);
    const b = ok(book([loan], registerOf([a])));
    expect(overdueIds(b)).toEqual([]);
    // Moves changed, accessions didn't: the register is given again.
    expect(overdueIds(ok(reindexLoans(b, LOG, registerOf([a]))))).toEqual([]);
    const unlinked: Record<string, unknown> = { ...a };
    delete unlinked.loanInId;
    const again = ok(reindexLoans(b, LOG, registerOf([unlinked])));
    expect(overdueIds(again)).toEqual([loan.id]);
    expect(ok(loanState(again, loan.id)).phase).toBe("unknown");
  });

  it("an acquired item can't be dropped from the loan", () => {
    const loan = loanIn({
      items: [
        { recordId: lantern, arrivalMoveId: lanternIn.id },
        { recordId: bell, arrivalMoveId: bellIn.id, departureMoveId: bellBack.id },
      ],
    });
    const register = registerOf([bought(loan)]);
    const b = ok(book([loan], register));
    const dropped = { ...loan, items: [loan.items[1]] };
    expect(codes(withLoan(b, dropped, NOW, register))).toEqual(["link_removed"]);
  });
});

describe("hostile registers", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).loanInId;
  });

  it("refuses anything but a register of the same organization", () => {
    const loan = loanIn();
    const register = registerOf([bought(loan)]);
    expect(codes(book([loan], { ...register }))).toEqual(["invalid_accessions"]);
    expect(codes(book([loan], new Proxy(register, {})))).toEqual(["invalid_accessions"]);
    expect(codes(reindexLoans(ok(book([loan])), LOG, {}))).toEqual(["invalid_accessions"]);
    const other = newOrganizationId();
    const theirs = ok(
      indexAccessions(other, { accessions: [], records: [], identifierTypes: [], today: TODAY }),
    );
    expect(codes(book([loan], theirs))).toEqual(["mixed_organizations"]);
  });

  it("a loanInId on Object.prototype links no accession to a loan", () => {
    const loan = loanIn();
    (Object.prototype as Record<string, unknown>).loanInId = loan.id;
    const register = ok(
      indexAccessions(ORG, {
        accessions: [bought(loan, { loanInId: undefined })].map((a) => {
          const copy: Record<string, unknown> = { ...a };
          delete copy.loanInId;
          return copy;
        }) as never,
        records: RECORDS,
        identifierTypes: TYPES,
        today: TODAY,
      }),
    );
    expect(accessionsOfLoan(register, loan.id)).toEqual([]);
    expect(overdueIds(ok(book([loan], register)))).toEqual([loan.id]);
  });
});

describe("review fixes: an overdue loan in stays listed", () => {
  it("not by an accession received, or signed, after the register's day", () => {
    const loan = loanIn();
    const late = book([loan], registerOf([bought(loan, { receivedOn: "2026-12-01" })]));
    expect(problems(late)).toEqual(["acquisition_in_future"]);
    expect(overdueIds(ok(late))).toEqual([loan.id]);
    const signedLater = book(
      [loan],
      registerOf([
        bought(loan, { method: "gift", deedStatus: "signed", deedSignedOn: "2026-12-01" }),
      ]),
    );
    expect(problems(signedLater)).toEqual(["acquisition_in_future"]);
    expect(overdueIds(ok(signedLater))).toEqual([loan.id]);
  });

  it("not by a signed deed with no signing day", () => {
    const loan = loanIn();
    const register = registerOf([bought(loan, { method: "gift", deedStatus: "signed" })]);
    const b = ok(book([loan], register));
    expect(ok(loanState(b, loan.id)).items[0]?.out).toBe(true);
    expect(overdueIds(b)).toEqual([loan.id]);
    const signedOn = registerOf([
      bought(loan, { method: "gift", deedStatus: "signed", deedSignedOn: "2026-11-05" }),
    ]);
    expect(overdueIds(ok(book([loan], signedOn)))).toEqual([]);
  });

  it("not by an accession whose source isn't the lender", () => {
    const stranger = record("agent", "Someone else", {});
    const loan = loanIn();
    const register = registerOf(
      [bought(loan, { sourceAgent: { recordId: stranger.id, label: "Someone else" } })],
      { records: [...RECORDS, stranger] },
    );
    const b = book([loan], register);
    expect(problems(b)).toEqual(["acquired_from_another_source"]);
    expect(ok(loanState(ok(b), loan.id)).phase).toBe("unknown");
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });

  it("not by keeping a stale register: edits and re-checks need it given again", () => {
    const loan = loanIn();
    const register = registerOf([bought(loan)]);
    const b = ok(book([loan], register));
    expect(b.accessionsAsOf).toBe(TODAY);
    expect(ok(book([loan])).accessionsAsOf).toBeNull();
    expect(codes(withLoan(b, { ...loan, note: "Edited." }, NOW))).toEqual(["accessions_not_given"]);
    expect(codes(reindexLoans(b, LOG))).toEqual(["accessions_not_given"]);
    expect(ok(withLoan(b, { ...loan, note: "Edited." }, NOW, register)).size).toBe(1);
  });

  it("an agreed loan whose items were acquired is in phase acquired, not returned", () => {
    const loan = loanIn();
    const b = ok(book([loan], registerOf([bought(loan)])));
    expect(ok(loanState(b, loan.id)).phase).toBe("acquired");
  });

  it("not by an acquired record that later left, linked or not", () => {
    const gone = move(lantern, lenderPlace.id, "2026-11-10", "departure");
    const log = ok(indexMoves(INDEX, [lanternIn, bellIn, bellBack, gone]));
    const loan = loanIn();
    const b = book([loan], registerOf([bought(loan)]), log);
    expect(problems(b)).toEqual(["acquired_and_departed"]);
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });

  it("not by marking it acquired before the accession", () => {
    const loan = loanIn({ status: "acquired", statusOn: "2026-10-15" });
    const b = book([loan], registerOf([bought(loan)]));
    expect(problems(b)).toEqual(["acquired_before_acquisition"]);
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });
});

describe("second review: an overdue loan in stays listed", () => {
  it("refuses a register dated after today, on index, edit and re-check", () => {
    const loan = loanIn();
    const ahead = registerOf([bought(loan, { receivedOn: "2026-11-25" })], {
      today: "2026-11-26",
    });
    expect(codes(book([loan], ahead))).toEqual(["register_in_future"]);
    const b = ok(book([loan], registerOf([])));
    expect(codes(withLoan(b, { ...loan, note: "Edited." }, NOW, ahead))).toEqual([
      "register_in_future",
    ]);
    expect(codes(reindexLoans(b, LOG, ahead, NOW))).toEqual(["register_in_future"]);
    // The day after now is slack for time zones, as for moves.
    expect(codes(book([loan], registerOf([], { today: "2026-11-24" })))).toEqual([]);
  });

  it("overdueLoans ignores acquisitions dated after its own today", () => {
    const loan = loanIn({ endOn: "2026-10-20" });
    const b = ok(book([loan], registerOf([bought(loan)])));
    expect(ok(loanState(b, loan.id)).phase).toBe("acquired");
    expect(overdueIds(b, "2026-10-25")).toEqual([loan.id]);
    expect(overdueIds(b, "2026-11-05")).toEqual([]);
    const marked = { ...loan, status: "acquired", statusOn: "2026-11-02" };
    const acquired = ok(book([marked], registerOf([bought(loan)])));
    expect(overdueIds(acquired, "2026-10-25")).toEqual([loan.id]);
    expect(overdueIds(acquired, "2026-11-05")).toEqual([]);
  });

  it("refuses a register older than the one the book was checked against", () => {
    const loan = loanIn();
    const a = bought(loan);
    const b = ok(book([loan], registerOf([a])));
    const old = registerOf([a], { today: "2026-11-20" });
    expect(codes(reindexLoans(b, LOG, old, NOW))).toEqual(["stale_accessions"]);
    expect(codes(withLoan(b, { ...loan, note: "Edited." }, NOW, old))).toEqual([
      "stale_accessions",
    ]);
    // A book made from an older register takes a newer one.
    const older = ok(book([loan], registerOf([], { today: "2026-11-20" })));
    expect(ok(reindexLoans(older, LOG, registerOf([a]), NOW)).accessionsAsOf).toBe(TODAY);
  });

  it("refuses changing the lender once an item moved or an accession names the loan", () => {
    const stranger = record("agent", "Someone else", {});
    const loan = loanIn();
    const register = registerOf(
      [bought(loan, { sourceAgent: { recordId: stranger.id, label: "Someone else" } })],
      { records: [...RECORDS, stranger] },
    );
    const b = ok(book([loan], register));
    expect(overdueIds(b)).toEqual([loan.id]);
    expect(codes(withLoan(b, { ...loan, agentId: stranger.id }, NOW, register))).toEqual([
      "agent_changed",
    ]);
    // An accession alone fixes the lender too.
    const unmoved = loanIn({ items: [{ recordId: lantern }] });
    const named = registerOf(
      [bought(unmoved, { sourceAgent: { recordId: stranger.id, label: "Someone else" } })],
      { records: [...RECORDS, stranger] },
    );
    const nb = ok(book([unmoved], named));
    expect(codes(withLoan(nb, { ...unmoved, agentId: stranger.id }, NOW, named))).toEqual([
      "agent_changed",
    ]);
    // Before anything moved or was accessioned, the lender can still be corrected.
    const fresh = loanIn({ items: [{ recordId: lantern }] });
    const empty = registerOf([]);
    const fb = ok(book([fresh], empty));
    expect(ok(withLoan(fb, { ...fresh, agentId: stranger.id }, NOW, empty)).size).toBe(1);
  });

  it("an agreed loan with an item acquired and another arrived but unlinked is not acquired", () => {
    const log = ok(indexMoves(INDEX, [lanternIn, bellIn]));
    const loan = loanIn({
      items: [{ recordId: lantern, arrivalMoveId: lanternIn.id }, { recordId: bell }],
    });
    const b = book([loan], registerOf([bought(loan)]), log);
    expect(problems(b)).toEqual(["acquired_with_items_out"]);
    expect(ok(loanState(ok(b), loan.id)).phase).toBe("unknown");
    expect(overdueIds(ok(b))).toEqual([loan.id]);
  });
});
