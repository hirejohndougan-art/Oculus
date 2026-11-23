import { describe, expect, it } from "vitest";
import {
  createStorageMove,
  indexLocations,
  indexLoans,
  indexMoves,
  isLoanBook,
  isLoanId,
  loanById,
  loanList,
  loanOutMove,
  loanState,
  loansOfRecord,
  newLoanId,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  overdueLoans,
  overdueReturns,
  reindexLoans,
  validateLoan,
  whereabouts,
  withLoan,
  withMove,
  type Loan,
  type LoanBook,
  type LoanIn,
  type LoanOut,
  type MoveLog,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const NOW = new Date("2026-11-23T18:00:00.000Z");
const LEVELS = { organizationId: ORG, levels: ["Room", "Shelf"] };

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const BORROWER = newRecordId();
const LENDER = newRecordId();
const room = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "storage",
  name: "Archive room",
  level: 0,
};
const shelf = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "storage",
  name: "Shelf A",
  level: 1,
  parentId: room.id,
};
const borrowerPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "County museum",
  agentId: BORROWER,
};
const lenderPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Railroad society",
  agentId: LENDER,
};
const conservator = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Paper conservator",
  agentId: newRecordId(),
};
const INDEX = ok(
  indexLocations(LEVELS, [
    room,
    shelf,
    borrowerPlace,
    lenderPlace,
    conservator,
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

// Two prints lent to the county museum; a lantern borrowed from the railroad society.
const print = newRecordId();
const map = newRecordId();
const lantern = newRecordId();
const placePrint = move(print, shelf.id, "2026-01-10", "placement");
const placeMap = move(map, shelf.id, "2026-01-10", "placement");
const printOut = move(print, borrowerPlace.id, "2026-09-01", "loan_out", {
  expectedReturnOn: "2026-11-15",
});
const mapOut = move(map, borrowerPlace.id, "2026-09-01", "loan_out", {
  expectedReturnOn: "2026-11-15",
});
const mapBack = move(map, shelf.id, "2026-11-10", "return");
const lanternIn = move(lantern, shelf.id, "2026-10-01", "placement");
const MOVES = [placePrint, placeMap, printOut, mapOut, mapBack, lanternIn];
const LOG = ok(indexMoves(INDEX, MOVES));

function loanOut(extra: Partial<LoanOut> = {}): LoanOut {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "out",
    number: "LO-2026-001",
    agentId: BORROWER,
    beginOn: "2026-09-01",
    endOn: "2026-11-15",
    status: "agreed",
    statusOn: "2026-08-15",
    purpose: "Exhibition: Saving the Depot",
    items: [
      { recordId: print, loanOutMoveId: printOut.id },
      { recordId: map, loanOutMoveId: mapOut.id, returnMoveId: mapBack.id },
    ],
    ...extra,
  };
}

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

function book(loans: readonly unknown[], log: MoveLog = LOG): LoanBook {
  return ok(indexLoans(log, loans));
}

describe("validateLoan", () => {
  it("accepts a loan out and a loan in, returning frozen copies", () => {
    const out = loanOut({ terms: "Insured nail to nail.", note: "Courier needed." });
    const v = ok(validateLoan(out));
    expect(v).toEqual(out);
    expect(v).not.toBe(out);
    expect(Object.isFrozen(v.items[0])).toBe(true);
    expect(ok(validateLoan(loanIn())).direction).toBe("in");
    expect(isLoanId(v.id)).toBe(true);
  });

  it("requires a fixed period, an agent, a number, a status and at least one item", () => {
    expect(codes(validateLoan(loanOut({ endOn: "2026-08-01" })))).toEqual(["end_before_begin"]);
    const open = Object.fromEntries(Object.entries(loanOut()).filter(([k]) => k !== "endOn"));
    expect(codes(validateLoan(open))).toEqual(["invalid_date"]);
    expect(codes(validateLoan({ ...loanOut(), endOn: undefined }))).toEqual(["undefined_value"]);
    expect(codes(validateLoan(loanOut({ agentId: "museum" as never })))).toEqual(["invalid_id"]);
    expect(codes(validateLoan(loanOut({ number: " " })))).toEqual(["required"]);
    expect(codes(validateLoan(loanOut({ number: "LO 1\n2" })))).toEqual(["control_characters"]);
    expect(codes(validateLoan(loanOut({ status: "active" as never })))).toEqual(["invalid_status"]);
    expect(codes(validateLoan(loanOut({ items: [] })))).toEqual(["required"]);
    expect(codes(validateLoan({ ...loanOut(), direction: "sideways" }))).toEqual([
      "invalid_direction",
    ]);
    expect(codes(validateLoan({ ...loanOut(), purpose: "" }))).toEqual(["invalid_text"]);
  });

  it("checks items against the loan's direction", () => {
    expect(
      codes(
        validateLoan(
          loanOut({ items: [{ recordId: print, arrivalMoveId: newMoveId() }] as never }),
        ),
      ),
    ).toEqual(["unknown_property"]);
    expect(
      codes(validateLoan(loanOut({ items: [{ recordId: print }, { recordId: print }] }))),
    ).toEqual(["duplicate_item"]);
    expect(
      codes(validateLoan(loanOut({ items: [{ recordId: print, returnMoveId: mapBack.id }] }))),
    ).toEqual(["end_without_start"]);
    expect(
      codes(
        validateLoan(
          loanOut({
            items: [
              { recordId: print, loanOutMoveId: printOut.id },
              { recordId: map, loanOutMoveId: printOut.id },
            ],
          }),
        ),
      ),
    ).toEqual(["move_reused"]);
  });

  it("nothing moves before a loan is agreed, and a loan isn't closed while an item is out", () => {
    for (const status of ["requested", "declined", "cancelled"] as const) {
      expect(codes(validateLoan(loanOut({ status })))).toEqual([
        "moved_before_agreed",
        "moved_before_agreed",
      ]);
      expect(ok(validateLoan(loanOut({ status, items: [{ recordId: print }] }))).status).toBe(
        status,
      );
    }
    expect(codes(validateLoan(loanOut({ status: "closed" })))).toEqual(["closed_with_items_out"]);
  });
});

describe("loan states and the move log", () => {
  it("works out where a loan out stands from its moves", () => {
    const out = loanOut();
    const b = book([out]);
    expect(isLoanBook(b)).toBe(true);
    const state = ok(loanState(b, out.id));
    expect(state.phase).toBe("on_loan");
    expect(state.items.map((i) => [i.out, i.dueBack, i.dueMatchesLoan])).toEqual([
      [true, "2026-11-15", true],
      [false, null, true],
    ]);
    expect(state.items[1]?.ended?.id).toBe(mapBack.id);
  });

  it("phases: agreed before anything moves, returned when everything is back", () => {
    const agreed = loanOut({ items: [{ recordId: print }] });
    expect(ok(loanState(book([agreed]), agreed.id)).phase).toBe("agreed");
    const back = loanOut({
      items: [{ recordId: map, loanOutMoveId: mapOut.id, returnMoveId: mapBack.id }],
    });
    expect(ok(loanState(book([back]), back.id)).phase).toBe("returned");
    const closed = { ...back, status: "closed" as const };
    expect(ok(loanState(book([closed]), closed.id)).phase).toBe("closed");
    expect(codes(loanState(book([back]), newLoanId()))).toEqual(["unknown_loan"]);
  });

  it("the loan's due date feeds overdueReturns, and overdueLoans lists late loans", () => {
    const out = loanOut();
    const b = book([out, loanIn()]);
    expect(ok(overdueReturns(LOG, "2026-11-20")).map((w) => w.recordId)).toEqual([print]);
    expect(ok(overdueLoans(b, "2026-11-20")).map((s) => s.loan.id)).toEqual([out.id]);
    expect(ok(overdueLoans(b, "2026-11-15"))).toEqual([]);
    expect(codes(overdueLoans(b, "soon"))).toEqual(["invalid_date"]);
    // The loan in is overdue to go back to its lender after its end date.
    expect(ok(overdueLoans(b, "2027-04-01")).map((s) => s.loan.direction)).toEqual(["out", "in"]);
  });

  it("loanOutMove makes the loan_out move with the loan's end date", () => {
    const pending = loanOut({ items: [{ recordId: print }] });
    const input = ok(loanOutMove(pending, print, borrowerPlace.id, "2026-09-01"));
    expect(input).toEqual({
      organizationId: ORG,
      recordId: print,
      locationId: borrowerPlace.id,
      movedOn: "2026-09-01",
      reason: "loan_out",
      expectedReturnOn: "2026-11-15",
      note: "Loan LO-2026-001",
    });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("loanOutMove refuses records not on the loan, unagreed loans, loans in and ended periods", () => {
    const pending = loanOut({ items: [{ recordId: print }], endOn: "2026-12-31" });
    expect(codes(loanOutMove(pending, map, borrowerPlace.id, "2026-11-20"))).toEqual([
      "not_on_loan",
    ]);
    expect(
      codes(
        loanOutMove({ ...pending, status: "requested" }, print, borrowerPlace.id, "2026-11-20"),
      ),
    ).toEqual(["not_agreed"]);
    expect(codes(loanOutMove(loanIn(), lantern, borrowerPlace.id, "2026-11-20"))).toEqual([
      "not_a_loan_out",
    ]);
    expect(codes(loanOutMove(pending, print, borrowerPlace.id, "2027-01-02"))).toEqual([
      "after_loan_end",
    ]);
    expect(codes(loanOutMove(pending, print, "shelf", "2026-11-20"))).toEqual(["invalid_id"]);
  });

  it("follows a whole loan out: send, extend, return, close", () => {
    const record = newRecordId();
    let log = ok(withMove(LOG, move(record, shelf.id, "2026-02-01", "placement"), NOW));
    let loan: Loan = loanOut({
      number: "LO-2026-007",
      endOn: "2026-12-01",
      items: [{ recordId: record }],
    });
    let b = book([loan], log);
    const sent = ok(
      createStorageMove(ok(loanOutMove(loan, record, borrowerPlace.id, "2026-11-01")), NOW),
    );
    log = ok(withMove(log, sent, NOW));
    loan = { ...loan, items: [{ recordId: record, loanOutMoveId: sent.id }] };
    b = ok(withLoan(ok(reindexLoans(b, log)), loan));
    expect(ok(loanState(b, loan.id)).phase).toBe("on_loan");
    expect(ok(whereabouts(log, record))?.expectedReturnOn).toBe("2026-12-01");
    // An extension: a new end date, out of step with the move log until recorded as a move.
    loan = { ...loan, endOn: "2027-01-31" };
    b = ok(withLoan(b, loan));
    expect(ok(loanState(b, loan.id)).items[0]?.dueMatchesLoan).toBe(false);
    const extended = ok(
      createStorageMove(ok(loanOutMove(loan, record, borrowerPlace.id, "2026-11-20")), NOW),
    );
    log = ok(withMove(log, extended, NOW));
    b = ok(reindexLoans(b, log));
    expect(ok(loanState(b, loan.id)).items[0]?.dueMatchesLoan).toBe(true);
    // Back home, then closed.
    const back = ok(
      createStorageMove(
        {
          organizationId: ORG,
          recordId: record,
          locationId: shelf.id,
          movedOn: "2026-11-23",
          reason: "return",
        },
        NOW,
      ),
    );
    log = ok(withMove(log, back, NOW));
    b = ok(reindexLoans(b, log));
    loan = {
      ...loan,
      items: [{ recordId: record, loanOutMoveId: sent.id, returnMoveId: back.id }],
    };
    b = ok(withLoan(b, loan));
    expect(ok(loanState(b, loan.id)).phase).toBe("returned");
    b = ok(withLoan(b, { ...loan, status: "closed", statusOn: "2026-11-23" }));
    expect(ok(loanState(b, loan.id)).phase).toBe("closed");
    expect(loanById(b, loan.id)?.status).toBe("closed");
    expect(ok(loanList(b))).toHaveLength(1);
  });

  it("follows a whole loan in: arrival placement, departure to the lender", () => {
    const departure = move(lantern, lenderPlace.id, "2026-11-20", "departure");
    const log = ok(withMove(LOG, departure, NOW));
    const loan = loanIn({
      items: [{ recordId: lantern, arrivalMoveId: lanternIn.id, departureMoveId: departure.id }],
    });
    const b = book([loan], log);
    expect(ok(loanState(b, loan.id)).phase).toBe("returned");
    expect(ok(whereabouts(log, lantern))?.away).toBe(false);
    expect(ok(overdueLoans(b, "2027-06-01"))).toEqual([]);
  });

  it("lists a record's loans as dated entries", () => {
    const first = loanOut({
      number: "LO-2025-004",
      beginOn: "2025-03-01",
      endOn: "2025-06-01",
      items: [{ recordId: print }],
      status: "declined",
    });
    const second = loanOut();
    const b = book([second, first, loanIn()]);
    expect(ok(loansOfRecord(b, print)).map((l) => l.number)).toEqual([
      "LO-2025-004",
      "LO-2026-001",
    ]);
    expect(ok(loansOfRecord(b, lantern)).map((l) => l.direction)).toEqual(["in"]);
    expect(ok(loansOfRecord(b, newRecordId()))).toEqual([]);
  });
});

describe("indexLoans refuses loans that disagree with the move log", () => {
  it("a move not in the log for that record", () => {
    expect(
      codes(
        indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: newMoveId() }] })]),
      ),
    ).toEqual(["unknown_move"]);
    // Another record's move.
    expect(
      codes(indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: mapOut.id }] })])),
    ).toEqual(["unknown_move"]);
  });

  it("a move with the wrong reason", () => {
    expect(
      codes(
        indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: placePrint.id }] })]),
      ),
    ).toEqual(["wrong_move_reason", "not_agent_location"]);
    expect(
      codes(indexLoans(LOG, [loanIn({ items: [{ recordId: map, arrivalMoveId: mapBack.id }] })])),
    ).toEqual(["wrong_move_reason"]);
  });

  it("a loan out that went to someone other than the borrower", () => {
    const toConservator = move(print, conservator.id, "2026-09-01", "loan_out");
    const log = ok(indexMoves(INDEX, [placePrint, toConservator]));
    expect(
      codes(
        indexLoans(log, [
          loanOut({ items: [{ recordId: print, loanOutMoveId: toConservator.id }] }),
        ]),
      ),
    ).toEqual(["not_agent_location"]);
  });

  it("a loan in that went back to someone other than the lender", () => {
    const away = move(lantern, borrowerPlace.id, "2026-11-01", "departure");
    const log = ok(indexMoves(INDEX, [lanternIn, away]));
    expect(
      codes(
        indexLoans(log, [
          loanIn({
            items: [{ recordId: lantern, arrivalMoveId: lanternIn.id, departureMoveId: away.id }],
          }),
        ]),
      ),
    ).toEqual(["not_agent_location"]);
  });

  it("a return before the loan out, or not the first one after it", () => {
    const early = move(print, shelf.id, "2026-08-01", "return");
    const second = move(print, borrowerPlace.id, "2026-11-20", "loan_out");
    const firstBack = move(print, shelf.id, "2026-11-01", "return");
    const lateBack = move(print, shelf.id, "2026-11-22", "return");
    const log = ok(indexMoves(INDEX, [placePrint, early, printOut, firstBack, second, lateBack]));
    expect(
      codes(
        indexLoans(log, [
          loanOut({
            items: [{ recordId: print, loanOutMoveId: printOut.id, returnMoveId: early.id }],
          }),
        ]),
      ),
    ).toEqual(["end_out_of_order"]);
    expect(
      codes(
        indexLoans(log, [
          loanOut({
            items: [{ recordId: print, loanOutMoveId: printOut.id, returnMoveId: lateBack.id }],
          }),
        ]),
      ),
    ).toEqual(["end_out_of_order"]);
  });

  it("one record on two loans out at once, or one move named by two loans", () => {
    const again = move(print, borrowerPlace.id, "2026-10-01", "loan_out");
    const log = ok(indexMoves(INDEX, [...MOVES, again]));
    expect(
      codes(
        indexLoans(log, [
          loanOut(),
          loanOut({ number: "LO-2026-002", items: [{ recordId: print, loanOutMoveId: again.id }] }),
        ]),
      ),
    ).toEqual(["overlapping_loans"]);
    expect(
      codes(
        indexLoans(LOG, [
          loanOut(),
          loanOut({
            number: "LO-2026-002",
            items: [{ recordId: print, loanOutMoveId: printOut.id }],
          }),
        ]),
      ),
    ).toEqual(["move_reused"]);
  });

  it("duplicate IDs and numbers; numbers in and out are kept apart", () => {
    const a = loanOut();
    expect(codes(indexLoans(LOG, [a, { ...a, number: "LO-9" }]))).toEqual(["duplicate_id"]);
    expect(
      codes(
        indexLoans(LOG, [a, loanOut({ number: "lo-2026-001", items: [{ recordId: lantern }] })]),
      ),
    ).toEqual(["duplicate_number"]);
    expect(book([a, loanIn({ number: "LO-2026-001" })]).size).toBe(2);
  });

  it("re-checks every loan when the move log changes", () => {
    const b = book([loanOut()]);
    const other = ok(indexMoves(INDEX, [placePrint, placeMap]));
    expect(codes(reindexLoans(b, other))).toContain("unknown_move");
  });

  it("withLoan refuses changing a loan's direction, and reports without the book position", () => {
    const out = loanOut();
    const b = book([loanIn(), out]);
    expect(codes(withLoan(b, { ...loanIn(), id: out.id }))).toEqual(["direction_changed"]);
    const bad = withLoan(b, { ...out, items: [{ recordId: print, loanOutMoveId: newMoveId() }] });
    expect(bad.ok ? [] : bad.issues[0]?.path).toEqual(["items", 0, "loanOutMoveId"]);
  });
});
