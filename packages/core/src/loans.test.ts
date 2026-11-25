import { describe, expect, it } from "vitest";
import {
  MAX_LOAN_ITEMS,
  createStorageMove,
  unexplainedDepartures,
  unexplainedLoanMoves,
  indexLocations,
  indexLoans,
  indexMoves,
  isLoanBook,
  isLoanId,
  loanById,
  loanList,
  loanOutMove,
  loanProblems,
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

/** A refusal's codes, or else the codes of every loan's problems in the book. */
function problemCodes(result: Validated<LoanBook>): string[] {
  if (!result.ok) return result.issues.map((i) => i.code);
  const found = loanProblems(result.value);
  return found.ok ? found.value.flatMap((p) => p.problems.map((i) => i.code)) : ["?"];
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
    // D-118: a loan closed with an item still out is a problem of the book.
    const closed = loanOut({ status: "closed" });
    expect(codes(validateLoan(closed))).toEqual([]);
    expect(problemCodes(indexLoans(LOG, [closed]))).toEqual(["closed_unsettled"]);
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
    // A record never sent anywhere (the print and the map have loan_out moves
    // this loan doesn't name: D-118 would flag them unlinked).
    const agreed = loanOut({ items: [{ recordId: newRecordId() }] });
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

  it("a departure to the wrong place, put right by a correction, still goes back to the lender", () => {
    const wrong = move(lantern, conservator.id, "2026-11-20", "departure");
    const log = ok(withMove(LOG, wrong, NOW));
    const loan = loanIn({
      items: [{ recordId: lantern, arrivalMoveId: lanternIn.id, departureMoveId: wrong.id }],
    });
    expect(problemCodes(indexLoans(log, [loan]))).toEqual(["not_agent_location"]);
    const fixed = ok(withMove(log, move(lantern, lenderPlace.id, "2026-11-21", "correction"), NOW));
    const b = book([loan], fixed);
    expect(ok(loanState(b, loan.id)).phase).toBe("returned");
    expect(ok(whereabouts(fixed, lantern))?.current.id).toBe(lenderPlace.id);
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
      problemCodes(
        indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: newMoveId() }] })]),
      ),
    ).toEqual(["unknown_move"]);
    // Another record's move.
    expect(
      problemCodes(
        indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: mapOut.id }] })]),
      ),
    ).toEqual(["unknown_move"]);
  });

  it("a move with the wrong reason", () => {
    expect(
      problemCodes(
        indexLoans(LOG, [loanOut({ items: [{ recordId: print, loanOutMoveId: placePrint.id }] })]),
      ),
    ).toEqual(["wrong_move_reason", "not_agent_location", "move_outside_loan"]);
    expect(
      problemCodes(
        indexLoans(LOG, [loanIn({ items: [{ recordId: map, arrivalMoveId: mapBack.id }] })]),
      ),
    ).toEqual(["wrong_move_reason"]);
  });

  it("a loan out that went to someone other than the borrower", () => {
    const toConservator = move(print, conservator.id, "2026-09-01", "loan_out");
    const log = ok(indexMoves(INDEX, [placePrint, toConservator]));
    expect(
      problemCodes(
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
      problemCodes(
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
      problemCodes(
        indexLoans(log, [
          loanOut({
            items: [{ recordId: print, loanOutMoveId: printOut.id, returnMoveId: early.id }],
          }),
        ]),
      ),
    ).toEqual(["end_out_of_order"]);
    expect(
      problemCodes(
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
      problemCodes(
        indexLoans(log, [
          loanOut(),
          loanOut({ number: "LO-2026-002", items: [{ recordId: print, loanOutMoveId: again.id }] }),
        ]),
      ),
    ).toEqual(["overlapping_loans", "overlapping_loans"]);
    expect(
      problemCodes(
        indexLoans(LOG, [
          loanOut(),
          loanOut({
            number: "LO-2026-002",
            items: [{ recordId: print, loanOutMoveId: printOut.id }],
          }),
        ]),
      ),
    ).toEqual(["move_reused", "move_reused"]);
  });

  it("duplicate IDs and numbers; numbers in and out are kept apart", () => {
    const a = loanOut();
    expect(problemCodes(indexLoans(LOG, [a, { ...a, number: "LO-9" }]))).toEqual(["duplicate_id"]);
    expect(
      problemCodes(
        indexLoans(LOG, [a, loanOut({ number: "lo-2026-001", items: [{ recordId: lantern }] })]),
      ),
    ).toEqual(["duplicate_number"]);
    expect(book([a, loanIn({ number: "LO-2026-001" })]).size).toBe(2);
  });

  it("re-checks every loan when the move log changes", () => {
    const b = book([loanOut()]);
    const other = ok(indexMoves(INDEX, [placePrint, placeMap]));
    expect(problemCodes(reindexLoans(b, other))).toContain("unknown_move");
  });

  it("withLoan refuses changing a loan's direction, and reports without the book position", () => {
    const out = loanOut();
    const b = book([loanIn(), out]);
    expect(codes(withLoan(b, { ...loanIn(), id: out.id }))).toEqual(["direction_changed"]);
    const bad = withLoan(b, {
      ...out,
      items: [{ recordId: print, loanOutMoveId: newMoveId() }, ...out.items.slice(1)],
    });
    expect(bad.ok ? [] : bad.issues[0]?.path).toEqual(["items", 0, "loanOutMoveId"]);
  });
});

describe("review fixes", () => {
  it("a linked loan_out or arrival must fall within the loan period", () => {
    const record = newRecordId();
    const old = move(record, shelf.id, "2020-01-01", "placement");
    const oldOut = move(record, borrowerPlace.id, "2020-03-01", "loan_out");
    const log = ok(indexMoves(INDEX, [old, oldOut]));
    const out = loanOut({ items: [{ recordId: record, loanOutMoveId: oldOut.id }] });
    expect(problemCodes(indexLoans(log, [out]))).toEqual(["move_outside_loan"]);
    expect(codes(withLoan(book([], log), out))).toEqual(["move_outside_loan"]);
    const late = move(record, borrowerPlace.id, "2026-12-02", "loan_out", {
      recordedAt: "2026-12-02T12:00:00.000Z",
    });
    const log2 = ok(
      indexMoves(INDEX, [old, oldOut, move(record, shelf.id, "2020-06-01", "return"), late]),
    );
    expect(
      problemCodes(
        indexLoans(log2, [loanOut({ items: [{ recordId: record, loanOutMoveId: late.id }] })]),
      ),
    ).toEqual(["move_outside_loan"]);
    // A loan in can't claim a 1990 placement as its arrival.
    const borrowed = newRecordId();
    const ancient = move(borrowed, shelf.id, "1990-05-01", "placement");
    const log3 = ok(indexMoves(INDEX, [ancient]));
    expect(
      problemCodes(
        indexLoans(log3, [loanIn({ items: [{ recordId: borrowed, arrivalMoveId: ancient.id }] })]),
      ),
    ).toEqual(["move_outside_loan"]);
  });

  it("loanOutMove refuses a day before the loan begins", () => {
    const pending = loanOut({ items: [{ recordId: print }] });
    expect(codes(loanOutMove(pending, print, borrowerPlace.id, "2026-08-31"))).toEqual([
      "before_loan_begin",
    ]);
    expect(ok(loanOutMove(pending, print, borrowerPlace.id, "2026-09-01")).movedOn).toBe(
      "2026-09-01",
    );
  });

  it("a loan can hold MAX_LOAN_ITEMS items with both moves named, either way", () => {
    const full = (direction: "in" | "out") =>
      Array.from({ length: MAX_LOAN_ITEMS }, () =>
        direction === "out"
          ? { recordId: newRecordId(), loanOutMoveId: newMoveId(), returnMoveId: newMoveId() }
          : { recordId: newRecordId(), arrivalMoveId: newMoveId(), departureMoveId: newMoveId() },
      );
    const out = {
      ...loanOut(),
      items: full("out"),
      terms: "x".repeat(2000),
      note: "y".repeat(2000),
    };
    expect(ok(validateLoan(out)).items).toHaveLength(MAX_LOAN_ITEMS);
    expect(ok(validateLoan({ ...loanIn(), items: full("in") })).items).toHaveLength(MAX_LOAN_ITEMS);
  });

  it("a loan's status can't be dated in the future (a day of slack)", () => {
    expect(ok(validateLoan(loanOut({ statusOn: "2026-11-24" }), NOW)).statusOn).toBe("2026-11-24");
    expect(codes(validateLoan(loanOut({ statusOn: "2026-11-25" }), NOW))).toEqual([
      "future_status",
    ]);
    expect(codes(withLoan(book([]), loanOut({ statusOn: "2026-11-25" }), NOW))).toEqual([
      "future_status",
    ]);
    expect(codes(validateLoan(loanOut(), new Date(Number.NaN)))).toEqual(["invalid_time"]);
  });

  it("a back-dated return makes one loan stale without refusing the book", () => {
    const out = loanOut();
    const inLoan = loanIn();
    const b = book([out, inLoan]);
    // A valid storage move: map came back earlier than the linked return says.
    const earlier = move(map, shelf.id, "2026-10-01", "return");
    const log = ok(withMove(LOG, earlier, NOW));
    const stale = ok(reindexLoans(b, log));
    expect(ok(loanProblems(stale))).toEqual([
      {
        loanId: out.id,
        problems: [
          expect.objectContaining({ code: "end_out_of_order", path: ["items", 1, "returnMoveId"] }),
        ],
      },
    ]);
    expect(ok(loanState(stale, out.id)).problems).toHaveLength(1);
    expect(ok(loanState(stale, inLoan.id)).problems).toEqual([]);
    // The stale loan can't be saved as it is; the other loan still can.
    expect(codes(withLoan(stale, out))).toEqual(["end_out_of_order"]);
    expect(ok(withLoan(stale, { ...inLoan, note: "Lender visited." })).size).toBe(2);
    // Relinking the loan to the earlier return fixes it.
    const fixed = ok(
      withLoan(stale, {
        ...out,
        items: [
          { recordId: print, loanOutMoveId: printOut.id },
          { recordId: map, loanOutMoveId: mapOut.id, returnMoveId: earlier.id },
        ],
      }),
    );
    expect(ok(loanProblems(fixed))).toEqual([]);
  });

  // A decoy loan listed before the genuine one, to the same borrower, running to 2099.
  const decoy = (items: LoanOut["items"]): LoanOut =>
    loanOut({ number: "LO-DECOY", beginOn: "2026-08-01", endOn: "2099-12-31", items });

  it("editing an earlier loan to claim a later loan's move is refused (review fix)", () => {
    const genuine = loanOut();
    const bait = decoy([{ recordId: print }]);
    const b = book([bait, genuine]);
    expect(ok(overdueLoans(b, "2026-11-23")).map((s) => s.loan.number)).toEqual(["LO-2026-001"]);
    const stolen = { ...bait, items: [{ recordId: print, loanOutMoveId: printOut.id }] };
    expect(codes(withLoan(b, stolen))).toEqual(["move_reused"]);
    // Saved anyway (two saves racing, an import): both loans are flagged, and
    // the genuine one stays overdue instead of looking returned.
    const raced = book([stolen, genuine]);
    expect(ok(loanProblems(raced)).map((p) => p.loanId)).toEqual([stolen.id, genuine.id]);
    const late = ok(overdueLoans(raced, "2026-11-23"));
    // D-118: the decoy is listed too (its item is out, due back by the move log).
    expect(late.map((s) => s.phase)).toEqual(["unknown", "unknown"]);
    expect(late.map((s) => s.loan.id)).toContain(genuine.id);
    expect(late.find((s) => s.loan.id === genuine.id)?.problems.map((p) => p.code)).toEqual([
      "move_reused",
    ]);
    expect(ok(loanState(raced, stolen.id)).phase).toBe("unknown");
  });

  it("an earlier loan can't steer an overlap onto a later, genuine loan (review fix)", () => {
    const record = newRecordId();
    const home = move(record, shelf.id, "2026-01-10", "placement");
    const early = move(record, borrowerPlace.id, "2026-08-15", "loan_out");
    const out = move(record, borrowerPlace.id, "2026-09-01", "loan_out", {
      expectedReturnOn: "2026-11-15",
    });
    const log = ok(indexMoves(INDEX, [home, early, out]));
    const genuine = loanOut({ items: [{ recordId: record, loanOutMoveId: out.id }] });
    const bait = decoy([{ recordId: record }]);
    const b = book([bait, genuine], log);
    const steered = { ...bait, items: [{ recordId: record, loanOutMoveId: early.id }] };
    expect(codes(withLoan(b, steered))).toEqual(["overlapping_loans"]);
    const raced = book([steered, genuine], log);
    expect(ok(loanProblems(raced)).map((p) => p.loanId)).toEqual([steered.id, genuine.id]);
    // Three loans: the third overlaps the first, not only its neighbour.
    const third = loanOut({
      number: "LO-2026-003",
      items: [{ recordId: record, loanOutMoveId: out.id }],
    });
    const short = move(record, borrowerPlace.id, "2026-08-20", "loan_out");
    const shortBack = move(record, shelf.id, "2026-08-25", "return");
    const log3 = ok(indexMoves(INDEX, [home, early, short, shortBack, out]));
    const middle = decoy([
      { recordId: record, loanOutMoveId: short.id, returnMoveId: shortBack.id },
    ]);
    const first = loanOut({
      number: "LO-2026-000",
      beginOn: "2026-08-01",
      items: [{ recordId: record, loanOutMoveId: early.id }],
    });
    expect(problemCodes(indexLoans(log3, [first, middle, third]))).toEqual([
      "overlapping_loans",
      "overlapping_loans",
      "overlapping_loans",
    ]);
  });

  it("a loan whose link went missing stays on the overdue list as unknown (review fix)", () => {
    const genuine = loanOut();
    const b = book([genuine]);
    // The loan_out move is no longer in the log (a bad import, an edit).
    const without = ok(
      indexMoves(
        INDEX,
        MOVES.filter((m) => m.id !== printOut.id),
      ),
    );
    const stale = ok(reindexLoans(b, without));
    const state = ok(loanState(stale, genuine.id));
    expect(state.phase).toBe("unknown");
    expect(state.problems.map((p) => p.code)).toEqual(["unknown_move"]);
    expect(ok(overdueLoans(stale, "2026-11-23")).map((s) => s.loan.id)).toEqual([genuine.id]);
    expect(ok(overdueLoans(stale, "2026-11-15"))).toEqual([]);
  });

  it("reports departures no loan in names", () => {
    const departure = move(lantern, lenderPlace.id, "2026-11-20", "departure");
    const log = ok(withMove(LOG, departure, NOW));
    const unnamed = book([loanIn()], log);
    expect(ok(unexplainedDepartures(unnamed)).map((m) => m.id)).toEqual([departure.id]);
    const named = book(
      [
        loanIn({
          items: [
            { recordId: lantern, arrivalMoveId: lanternIn.id, departureMoveId: departure.id },
          ],
        }),
      ],
      log,
    );
    expect(ok(unexplainedDepartures(named))).toEqual([]);
    expect(codes(unexplainedDepartures({ ...named }))).toEqual(["not_a_loan_book"]);
  });
});

describe("an overdue loan can't be hidden by editing it (review fixes)", () => {
  const closing = { status: "closed" as const, statusOn: "2026-11-23" };

  it("a loan out can't drop an item's link, or the item, while it is out", () => {
    const out = loanOut();
    const b = book([out]);
    const mapItem = { recordId: map, loanOutMoveId: mapOut.id, returnMoveId: mapBack.id };
    const unlinked = { ...out, ...closing, items: [{ recordId: print }, mapItem] };
    expect(codes(withLoan(b, unlinked))).toEqual(["link_removed"]);
    expect(codes(withLoan(b, { ...out, ...closing, items: [mapItem] }))).toEqual(["link_removed"]);
    // Not closed, the same: the link stays until the return is recorded.
    expect(codes(withLoan(b, { ...out, items: [{ recordId: print }, mapItem] }))).toEqual([
      "link_removed",
    ]);
    // A recorded return link can't be dropped either.
    const reopened = {
      ...out,
      items: [
        { recordId: print, loanOutMoveId: printOut.id },
        { recordId: map, loanOutMoveId: mapOut.id },
      ],
    };
    expect(codes(withLoan(b, reopened))).toEqual(["link_removed"]);
    // D-118: no item comes off an agreed loan, even one that is back.
    expect(
      codes(withLoan(b, { ...out, items: [{ recordId: print, loanOutMoveId: printOut.id }] })),
    ).toEqual(["item_removed"]);
    expect(ok(overdueLoans(b, "2026-11-23")).map((s) => s.loan.id)).toEqual([out.id]);
  });

  it("a closed loan out with a record's loan_out left unlinked stays overdue", () => {
    // Saved past withLoan (an import, two saves racing).
    const mapItem = { recordId: map, loanOutMoveId: mapOut.id, returnMoveId: mapBack.id };
    const closed = loanOut({ ...closing, items: [{ recordId: print }, mapItem] });
    const b = book([closed]);
    const state = ok(loanState(b, closed.id));
    expect(state.phase).toBe("unknown");
    expect(state.problems.map((p) => [p.code, p.path])).toEqual([
      ["unlinked_loan_out", ["items", 0]],
      ["closed_unsettled", ["items", 0]],
      ["closed_with_unlinked_move", ["items", 0]],
    ]);
    expect(ok(overdueLoans(b, "2026-11-23")).map((s) => s.loan.id)).toEqual([closed.id]);
    expect(ok(unexplainedLoanMoves(b)).map((m) => m.id)).toEqual([printOut.id]);
    // With the item gone from the loan altogether, the move is still listed.
    const gone = book([loanOut({ ...closing, items: [mapItem] })]);
    expect(ok(loanProblems(gone))).toEqual([]);
    expect(ok(unexplainedLoanMoves(gone)).map((m) => m.id)).toEqual([printOut.id]);
    // A loan_out to another borrower, or outside the period, isn't this loan's.
    const elsewhere = ok(
      indexMoves(INDEX, [
        placePrint,
        move(print, conservator.id, "2026-09-01", "loan_out", { expectedReturnOn: "2026-10-01" }),
        move(print, shelf.id, "2026-09-20", "return"),
        placeMap,
        mapOut,
        mapBack,
      ]),
    );
    // D-118: it was never sent on this loan, which must be said to close it.
    expect(problemCodes(indexLoans(elsewhere, [closed]))).toEqual(["closed_unsettled"]);
    const notSent = { ...closed, items: [{ recordId: print, notSent: true as const }, mapItem] };
    expect(problemCodes(indexLoans(elsewhere, [notSent]))).toEqual([]);
  });

  it("lists loan_out moves no loan out names or extends", () => {
    expect(ok(unexplainedLoanMoves(book([loanOut()])))).toEqual([]);
    expect(ok(unexplainedLoanMoves(book([]))).map((m) => m.id)).toEqual([printOut.id, mapOut.id]);
    // An extension (another loan_out to the same place before the return) is explained.
    const extension = move(print, borrowerPlace.id, "2026-11-10", "loan_out", {
      expectedReturnOn: "2027-01-31",
    });
    const extended = ok(withMove(LOG, extension, NOW));
    expect(ok(unexplainedLoanMoves(book([loanOut()], extended)))).toEqual([]);
    // After the return, a new loan_out is not.
    const again = move(map, borrowerPlace.id, "2026-11-20", "loan_out", {
      expectedReturnOn: "2026-12-20",
    });
    const later = ok(withMove(LOG, again, NOW));
    expect(ok(unexplainedLoanMoves(book([loanOut()], later))).map((m) => m.id)).toEqual([again.id]);
    expect(codes(unexplainedLoanMoves({ ...book([]) }))).toEqual(["not_a_loan_book"]);
  });

  it("a loan in can't drop its arrival link, and closes only once every item has departed", () => {
    const lin = loanIn();
    const b = book([lin]);
    const unlinked = { ...lin, ...closing, items: [{ recordId: lantern }] };
    expect(codes(withLoan(b, unlinked))).toEqual(["link_removed"]);
    // Saved past withLoan: the borrowed lantern is still here, so the closed
    // loan has a problem and is listed overdue after its end date.
    const raced = book([unlinked]);
    const state = ok(loanState(raced, lin.id));
    expect(state.phase).toBe("unknown");
    expect(state.problems.map((p) => p.code)).toEqual(["unlinked_arrival", "closed_unsettled"]);
    expect(ok(overdueLoans(raced, "2027-04-01")).map((s) => s.loan.id)).toEqual([lin.id]);
    // An item that never arrived is said so (D-118): it needs no departure.
    const neverCame = loanIn({
      ...closing,
      items: [{ recordId: newRecordId(), notReceived: true }],
    });
    expect(
      problemCodes(indexLoans(LOG, [{ ...neverCame, items: [{ recordId: newRecordId() }] }])),
    ).toEqual(["closed_unsettled"]);
    expect(ok(loanState(book([neverCame]), neverCame.id)).phase).toBe("closed");
    // The ordinary way: it departs to the lender, the loan names it, then closes.
    const departure = move(lantern, lenderPlace.id, "2026-11-20", "departure");
    const log = ok(withMove(LOG, departure, NOW));
    const linked = {
      ...lin,
      items: [{ recordId: lantern, arrivalMoveId: lanternIn.id, departureMoveId: departure.id }],
    };
    let after = ok(withLoan(ok(reindexLoans(b, log)), linked));
    after = ok(withLoan(after, { ...linked, ...closing }));
    expect(ok(loanState(after, lin.id)).phase).toBe("closed");
    expect(ok(overdueLoans(after, "2027-06-01"))).toEqual([]);
    // D-118: it stays on the loan for good.
    expect(codes(withLoan(after, { ...linked, items: [{ recordId: newRecordId() }] }))).toEqual([
      "item_removed",
    ]);
  });

  it("a link may be changed to another move that fits", () => {
    const record = newRecordId();
    const home = move(record, shelf.id, "2026-01-10", "placement");
    const first = move(record, borrowerPlace.id, "2026-09-01", "loan_out", {
      expectedReturnOn: "2026-11-15",
    });
    const second = move(record, borrowerPlace.id, "2026-09-02", "loan_out", {
      expectedReturnOn: "2026-11-15",
    });
    const log = ok(indexMoves(INDEX, [home, first, second]));
    const out = loanOut({ items: [{ recordId: record, loanOutMoveId: second.id }] });
    const b = book([out], log);
    expect(ok(unexplainedLoanMoves(b)).map((m) => m.id)).toEqual([first.id]);
    const relinked = ok(
      withLoan(b, { ...out, items: [{ recordId: record, loanOutMoveId: first.id }] }),
    );
    expect(ok(unexplainedLoanMoves(relinked))).toEqual([]);
    expect(ok(loanState(relinked, out.id)).phase).toBe("on_loan");
  });
});
