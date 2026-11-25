// D-118 (T-018b with T-018a and S-013): an agreed loan is over only when
// every item is settled, by a linked end move or an explicit, recorded way
// (notSent, notReceived, kept by an accession, renewed by a later loan in);
// and a loan's record found in our care (or at the borrower's) that no open
// loan explains makes the loan unknown, whatever its dates say. Each attack
// from T-018a's three failed reviews and S-013's review has a test here.
// Every record, place and person is invented.
import { afterEach, describe, expect, it } from "vitest";
import {
  indexLocations,
  indexLoans,
  indexMoves,
  loanProblems,
  loanState,
  newLoanId,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  overdueLoans,
  reindexLoans,
  reindexLocations,
  unexplainedArrivals,
  unexplainedLoanMoves,
  validateLoan,
  withLoan,
  type LoanBook,
  type LoanIn,
  type LoanOut,
  type MoveLog,
  type RecordId,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const NOW = new Date("2026-11-25T18:00:00.000Z");
const LEVELS = { organizationId: ORG, levels: ["Room", "Shelf"] };

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function problemCodes(result: Validated<LoanBook>): string[] {
  if (!result.ok) return result.issues.map((i) => `refused:${i.code}`);
  const found = loanProblems(result.value);
  return found.ok ? found.value.flatMap((p) => p.problems.map((i) => i.code)) : ["?"];
}

const LENDER = newRecordId();
const OTHER_LENDER = newRecordId();
const BORROWER = newRecordId();
const room = { id: newLocationId(), organizationId: ORG, kind: "storage", name: "Room", level: 0 };
const shelf = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "storage",
  name: "Shelf B",
  level: 1,
  parentId: room.id,
};
const showcase = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "display",
  name: "Case 1",
  level: 0,
};
const lenderPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Bayou railroad club",
  agentId: LENDER,
};
const otherLenderPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Cotton gin trust",
  agentId: OTHER_LENDER,
};
const borrowerPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Coastal museum",
  agentId: BORROWER,
};
const LOCATIONS = [room, shelf, showcase, lenderPlace, otherLenderPlace, borrowerPlace];
const INDEX = ok(indexLocations(LEVELS, LOCATIONS as StorageLocation[]));

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
    recordedAt: new Date(Date.parse("2026-11-20T16:00:00.000Z") + tick * 1000).toISOString(),
    ...extra,
  } as StorageMove;
}

function log(moves: readonly StorageMove[]): MoveLog {
  return ok(indexMoves(INDEX, moves));
}

function loanIn(items: LoanIn["items"], extra: Partial<LoanIn> = {}): LoanIn {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "in",
    number: `LI-${String((tick += 1))}`,
    agentId: LENDER,
    beginOn: "2026-06-01",
    endOn: "2026-10-31",
    status: "agreed",
    statusOn: "2026-05-20",
    items,
    ...extra,
  };
}

function loanOut(items: LoanOut["items"], extra: Partial<LoanOut> = {}): LoanOut {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "out",
    number: `LO-${String((tick += 1))}`,
    agentId: BORROWER,
    beginOn: "2026-06-01",
    endOn: "2026-10-31",
    status: "agreed",
    statusOn: "2026-05-20",
    items,
    ...extra,
  };
}

function overdueIds(b: LoanBook, today = "2026-11-25"): string[] {
  return ok(overdueLoans(b, today)).map((s) => s.loan.id);
}

describe("S-013: a borrowed record here with no linked arrival never hides the loan", () => {
  const lantern = newRecordId();
  const arrival = move(lantern, shelf.id, "2026-06-03", "placement");

  it("an agreed loan in whose item arrived unlinked stays owed, and the arrival is reported", () => {
    const loan = loanIn([{ recordId: lantern }]);
    const b = ok(indexLoans(log([arrival]), [loan]));
    const state = ok(loanState(b, loan.id));
    expect(state.phase).toBe("agreed");
    expect(state.unsettled).toEqual([lantern]);
    expect(overdueIds(b, "2026-10-31")).toEqual([]);
    expect(overdueIds(b)).toEqual([loan.id]);
    expect(ok(unexplainedArrivals(b)).map((m) => m.id)).toEqual([arrival.id]);
    // Linking it clears the report; the loan stays owed until it departs.
    const linked = { ...loan, items: [{ recordId: lantern, arrivalMoveId: arrival.id }] };
    const fixed = ok(withLoan(b, linked));
    expect(ok(loanState(fixed, loan.id)).phase).toBe("on_loan");
    expect(ok(unexplainedArrivals(fixed))).toEqual([]);
    expect(overdueIds(fixed)).toEqual([loan.id]);
  });

  it("one item back and another arrived unlinked: still overdue, never settled", () => {
    const lamp = newRecordId();
    const lampIn = move(lamp, shelf.id, "2026-06-03", "placement");
    const lampBack = move(lamp, lenderPlace.id, "2026-10-01", "departure");
    const loan = loanIn([
      { recordId: lamp, arrivalMoveId: lampIn.id, departureMoveId: lampBack.id },
      { recordId: lantern },
    ]);
    const b = ok(indexLoans(log([lampIn, lampBack, arrival]), [loan]));
    expect(ok(loanState(b, loan.id)).unsettled).toEqual([lantern]);
    expect(overdueIds(b)).toEqual([loan.id]);
  });

  it("moving beginOn later, an early arrival, a display case or an outside place change nothing", () => {
    const early = move(lantern, shelf.id, "2026-01-02", "placement");
    const shown = move(lantern, showcase.id, "2026-06-03", "exhibition");
    const outside = move(lantern, otherLenderPlace.id, "2026-06-03", "conservation");
    for (const moves of [[early], [shown], [outside], []]) {
      for (const beginOn of ["2026-06-01", "2026-09-30"]) {
        const loan = loanIn([{ recordId: lantern }], { beginOn });
        const b = ok(indexLoans(log(moves), [loan]));
        expect(ok(loanState(b, loan.id)).unsettled).toEqual([lantern]);
        expect(overdueIds(b)).toEqual([loan.id]);
      }
    }
  });

  it("changing a location's kind afterwards doesn't settle the loan", () => {
    const loan = loanIn([{ recordId: lantern }]);
    const before = ok(indexLoans(log([arrival]), [loan]));
    const relabelled = LOCATIONS.map((l) =>
      l.id === shelf.id
        ? {
            id: shelf.id,
            organizationId: ORG,
            kind: "external",
            name: "Shelf B",
            agentId: OTHER_LENDER,
          }
        : l,
    );
    const index = reindexLocations(log([arrival]), LEVELS, relabelled);
    if (index.ok) expect(overdueIds(ok(reindexLoans(before, index.value.log)))).toEqual([loan.id]);
    expect(overdueIds(before)).toEqual([loan.id]);
  });

  it("a decoy loan linking the arrival doesn't settle the real loan's item", () => {
    const real = loanIn([{ recordId: lantern }]);
    const decoy = loanIn([{ recordId: lantern, arrivalMoveId: arrival.id }], {
      number: "LI-DECOY",
      endOn: "2099-12-31",
    });
    const b = ok(indexLoans(log([arrival]), [real, decoy]));
    expect(ok(loanState(b, real.id)).unsettled).toEqual([lantern]);
    expect(overdueIds(b)).toEqual([real.id]);
  });

  it("only an explicit, recorded marker settles it: notReceived (kept in the loan's history)", () => {
    const loan = loanIn([{ recordId: lantern, notReceived: true }]);
    expect(overdueIds(ok(indexLoans(log([]), [loan])))).toEqual([]);
    // A marker that turns out wrong is the staff member's recorded word; the
    // arrival still shows on the report for someone to reconcile.
    const b = ok(indexLoans(log([arrival]), [loan]));
    expect(ok(unexplainedArrivals(b)).map((m) => m.id)).toEqual([arrival.id]);
  });

  it("gone back, then here again with no loan: reported", () => {
    const back = move(lantern, lenderPlace.id, "2026-10-01", "departure");
    const again = move(lantern, shelf.id, "2026-11-01", "placement");
    const loan = loanIn([
      { recordId: lantern, arrivalMoveId: arrival.id, departureMoveId: back.id },
    ]);
    const b = ok(indexLoans(log([arrival, back, again]), [loan]));
    expect(ok(unexplainedArrivals(b)).map((m) => m.id)).toEqual([again.id]);
    // Ordinary work is never blocked by it (the second review's false positives).
    expect(ok(loanState(b, loan.id)).problems).toEqual([]);
  });

  it("an inherited notReceived or keptByAccessionId never settles an item", () => {
    const loan = loanIn([{ recordId: lantern, arrivalMoveId: arrival.id }]);
    const proto = Object.prototype as Record<string, unknown>;
    proto.notReceived = true;
    proto.keptByAccessionId = newLoanId();
    try {
      const b = ok(indexLoans(log([arrival]), [loan]));
      expect(ok(loanState(b, loan.id)).items[0]?.settledBy).toBeNull();
      expect(overdueIds(b)).toEqual([loan.id]);
    } finally {
      delete proto.notReceived;
      delete proto.keptByAccessionId;
    }
  });
});
describe("the false positives the S-013 review found stay clear", () => {
  const clock = newRecordId();
  const arrival = move(clock, shelf.id, "2026-06-03", "placement");

  it("a declined request replaced by a new agreement", () => {
    const request = loanIn([{ recordId: clock }], { status: "declined", number: "LI-REQ" });
    const agreed = loanIn([{ recordId: clock, arrivalMoveId: arrival.id }], {
      endOn: "2027-06-30",
    });
    const b = ok(indexLoans(log([arrival]), [request, agreed]));
    expect(problemCodes({ ok: true, value: b })).toEqual([]);
    expect(overdueIds(b)).toEqual([]);
  });

  it("an early return, then borrowed again on a new loan", () => {
    const back = move(clock, lenderPlace.id, "2026-07-01", "departure");
    const again = move(clock, shelf.id, "2026-09-01", "placement");
    const first = loanIn([
      { recordId: clock, arrivalMoveId: arrival.id, departureMoveId: back.id },
    ]);
    const second = loanIn([{ recordId: clock, arrivalMoveId: again.id }], {
      beginOn: "2026-09-01",
      endOn: "2027-06-30",
    });
    const b = ok(indexLoans(log([arrival, back, again]), [first, second]));
    expect(problemCodes({ ok: true, value: b })).toEqual([]);
    expect(overdueIds(b)).toEqual([]);
  });

  it("a renewal of a record already here: the new loan continues the old one", () => {
    const first = loanIn([{ recordId: clock, arrivalMoveId: arrival.id }]);
    const renewal = loanIn([{ recordId: clock, continuesLoanId: first.id }], {
      beginOn: "2026-11-01",
      endOn: "2027-10-31",
    });
    const b = ok(indexLoans(log([arrival]), [first, renewal]));
    expect(problemCodes({ ok: true, value: b })).toEqual([]);
    expect(ok(loanState(b, first.id)).items[0]?.settledBy).toBe("renewed");
    expect(ok(loanState(b, renewal.id)).phase).toBe("on_loan");
    expect(overdueIds(b)).toEqual([]);
    expect(overdueIds(b, "2027-11-01")).toEqual([renewal.id]);
    // The first loan can be closed now.
    const closed = ok(withLoan(b, { ...first, status: "closed", statusOn: "2026-11-01" }));
    expect(ok(loanState(closed, first.id)).phase).toBe("closed");
    // The renewal goes back to the lender in the ordinary way.
    const back = move(clock, lenderPlace.id, "2026-11-20", "departure");
    const later = ok(reindexLoans(closed, log([arrival, back])));
    const returned = ok(
      withLoan(later, {
        ...renewal,
        items: [{ recordId: clock, continuesLoanId: first.id, departureMoveId: back.id }],
      }),
    );
    expect(overdueIds(returned, "2027-11-01")).toEqual([]);
  });
});

describe("renewals are checked, never taken on trust", () => {
  const vase = newRecordId();
  const arrival = move(vase, shelf.id, "2026-06-03", "placement");
  const first = loanIn([{ recordId: vase, arrivalMoveId: arrival.id }]);

  it("another lender, a request, a missing loan or record: renewal_mismatch, and the first stays owed", () => {
    const cases: LoanIn[] = [
      loanIn([{ recordId: vase, continuesLoanId: first.id }], { agentId: OTHER_LENDER }),
      loanIn([{ recordId: vase, continuesLoanId: newLoanId() }]),
      loanIn([{ recordId: newRecordId(), continuesLoanId: first.id }]),
    ];
    for (const renewal of cases) {
      const b = ok(indexLoans(log([arrival]), [first, renewal]));
      expect(ok(loanState(b, renewal.id)).problems.map((p) => p.code)).toContain(
        "renewal_mismatch",
      );
      expect(overdueIds(b)).toContain(first.id);
    }
    const requested = loanIn([{ recordId: vase, continuesLoanId: first.id }], {
      status: "requested",
    });
    expect(codes(validateLoan(requested, NOW))).toEqual(["moved_before_agreed"]);
  });

  it("two loans can't both continue one item", () => {
    const a = loanIn([{ recordId: vase, continuesLoanId: first.id }], { endOn: "2027-01-31" });
    const b2 = loanIn([{ recordId: vase, continuesLoanId: first.id }], { endOn: "2027-01-31" });
    const b = ok(indexLoans(log([arrival]), [first, a, b2]));
    expect(
      problemCodes({ ok: true, value: b }).filter((c) => c === "continued_twice"),
    ).toHaveLength(2);
    expect(overdueIds(b)).toContain(first.id);
  });

  it("loops and renewals of items already gone back never begin", () => {
    const x = newLoanId();
    const y = newLoanId();
    const lx = loanIn([{ recordId: vase, continuesLoanId: y }], { id: x });
    const ly = loanIn([{ recordId: vase, continuesLoanId: x }], { id: y });
    const b = ok(indexLoans(log([arrival]), [lx, ly]));
    expect(problemCodes({ ok: true, value: b })).toContain("renewal_mismatch");
    const back = move(vase, lenderPlace.id, "2026-09-01", "departure");
    const gone = loanIn([{ recordId: vase, arrivalMoveId: arrival.id, departureMoveId: back.id }]);
    const late = loanIn([{ recordId: vase, continuesLoanId: gone.id }]);
    expect(problemCodes(indexLoans(log([arrival, back]), [gone, late]))).toContain(
      "renewal_mismatch",
    );
  });

  it("a renewal can't drop what it continues while the item is here", () => {
    const renewal = loanIn([{ recordId: vase, continuesLoanId: first.id }], {
      endOn: "2027-06-30",
    });
    const b = ok(indexLoans(log([arrival]), [first, renewal]));
    expect(codes(withLoan(b, { ...renewal, items: [{ recordId: vase }] }))).toEqual([
      "link_removed",
    ]);
  });
});

describe("kept for good: only an accession of ours naming the record settles it", () => {
  const chest = newRecordId();
  const arrival = move(chest, shelf.id, "2026-06-03", "placement");
  const accessionId = newLoanId();
  const loan = loanIn([
    { recordId: chest, arrivalMoveId: arrival.id, keptByAccessionId: accessionId },
  ]);

  it("settles with the accession, and is not_kept without it", () => {
    const accessions = new Map<string, readonly RecordId[]>([[accessionId, [chest]]]);
    const b = ok(indexLoans(log([arrival]), [loan], NOW, { accessions }));
    expect(ok(loanState(b, loan.id)).items[0]?.settledBy).toBe("kept");
    expect(overdueIds(b)).toEqual([]);
    // The book keeps its accessions across edits and new move logs.
    const closed = ok(withLoan(b, { ...loan, status: "closed", statusOn: "2026-11-01" }, NOW));
    expect(ok(loanState(ok(reindexLoans(closed, log([arrival]))), loan.id)).phase).toBe("closed");
    for (const options of [
      {},
      { accessions: new Map<string, readonly RecordId[]>([[accessionId, [newRecordId()]]]) },
      { accessions: new Map<string, readonly RecordId[]>([[newLoanId(), [chest]]]) },
    ]) {
      const without = ok(indexLoans(log([arrival]), [loan], NOW, options));
      expect(ok(loanState(without, loan.id)).problems.map((p) => p.code)).toEqual(["not_kept"]);
      expect(overdueIds(without)).toEqual([loan.id]);
    }
  });

  it("refuses accessions that aren't a map of IDs", () => {
    for (const accessions of [
      {},
      new Map([[accessionId, ["not-an-id"]]]),
      new Map([[1, [chest]]]),
      new Proxy(new Map(), {}),
    ]) {
      expect(codes(indexLoans(log([arrival]), [loan], NOW, { accessions } as never))).toEqual([
        "invalid_accessions",
      ]);
    }
  });

  it("kept needs an arrival, and isn't both kept and gone back", () => {
    expect(
      codes(validateLoan(loanIn([{ recordId: chest, keptByAccessionId: accessionId }]), NOW)),
    ).toEqual(["end_without_start"]);
    const both = loanIn([
      {
        recordId: chest,
        arrivalMoveId: arrival.id,
        departureMoveId: newMoveId(),
        keptByAccessionId: accessionId,
      },
    ]);
    expect(codes(validateLoan(both, NOW))).toEqual(["two_ends"]);
  });
});

describe("statuses and items once agreed (D-118)", () => {
  const box = newRecordId();
  const arrival = move(box, shelf.id, "2026-06-03", "placement");

  it("an agreed loan never goes back to requested or declined", () => {
    // Nothing linked yet (so validation alone wouldn't catch it).
    const loan = loanIn([{ recordId: box }]);
    const b = ok(indexLoans(log([]), [loan]));
    for (const status of ["requested", "declined"] as const) {
      expect(codes(withLoan(b, { ...loan, status }))).toEqual(["status_change_refused"]);
    }
    // With the arrival linked, validation refuses first.
    const linked = loanIn([{ recordId: box, arrivalMoveId: arrival.id }]);
    const lb = ok(indexLoans(log([arrival]), [linked]));
    expect(codes(withLoan(lb, { ...linked, status: "declined" }))).toEqual(["moved_before_agreed"]);
  });

  it("cancelled only when every item is marked as never received (or sent)", () => {
    const loan = loanIn([{ recordId: box }], { endOn: "2027-06-30" });
    const b = ok(indexLoans(log([]), [loan]));
    expect(codes(withLoan(b, { ...loan, status: "cancelled" }))).toEqual(["status_change_refused"]);
    const cancelled = ok(
      withLoan(b, { ...loan, status: "cancelled", items: [{ recordId: box, notReceived: true }] }),
    );
    expect(ok(loanState(cancelled, loan.id)).phase).toBe("cancelled");
    expect(overdueIds(cancelled, "2027-07-01")).toEqual([]);
    // A request (never agreed) may be declined or cancelled freely.
    const request = loanIn([{ recordId: box }], { status: "requested" });
    const rb = ok(indexLoans(log([]), [request]));
    expect(ok(withLoan(rb, { ...request, status: "declined" })).size).toBe(1);
  });

  it("items stay on an agreed loan: mark one that never came instead", () => {
    const other = newRecordId();
    const loan = loanIn([{ recordId: box }, { recordId: other }], { endOn: "2027-06-30" });
    const b = ok(indexLoans(log([]), [loan]));
    expect(codes(withLoan(b, { ...loan, items: [{ recordId: box }] }))).toEqual(["item_removed"]);
    const marked = ok(
      withLoan(b, { ...loan, items: [{ recordId: box }, { recordId: other, notReceived: true }] }),
    );
    expect(ok(loanState(marked, loan.id)).unsettled).toEqual([box]);
    // A request's items may still change.
    const request = loanIn([{ recordId: box }, { recordId: other }], { status: "requested" });
    const rb = ok(indexLoans(log([]), [request]));
    expect(ok(withLoan(rb, { ...request, items: [{ recordId: box }] })).size).toBe(1);
  });

  it("an agreed loan out past its end with items never sent is owed until marked notSent", () => {
    const loan = loanOut([{ recordId: box }]);
    const b = ok(indexLoans(log([]), [loan]));
    expect(overdueIds(b)).toEqual([loan.id]);
    const marked = ok(withLoan(b, { ...loan, items: [{ recordId: box, notSent: true }] }));
    expect(overdueIds(marked)).toEqual([]);
  });
});

describe("loans out: only a linked return or notSent settles an item", () => {
  const print = newRecordId();
  const home = move(print, shelf.id, "2026-01-10", "placement");
  const out = move(print, borrowerPlace.id, "2026-06-05", "loan_out", {
    expectedReturnOn: "2026-10-31",
  });

  it("an unlinked loan_out stays owed and is reported; a linked return settles it", () => {
    const b = ok(indexLoans(log([home, out]), [loanOut([{ recordId: print }])]));
    expect(overdueIds(b)).toHaveLength(1);
    expect(ok(unexplainedLoanMoves(b)).map((m) => m.id)).toEqual([out.id]);
    const back = move(print, shelf.id, "2026-10-20", "return");
    const returned = loanOut([{ recordId: print, loanOutMoveId: out.id, returnMoveId: back.id }]);
    expect(problemCodes(indexLoans(log([home, out, back]), [returned]))).toEqual([]);
  });

  it("a return link to the wrong move never counts as returned", () => {
    const loan = loanOut([{ recordId: print, loanOutMoveId: out.id, returnMoveId: home.id }]);
    const b = ok(indexLoans(log([home, out]), [loan]));
    expect(ok(loanState(b, loan.id)).items[0]?.settledBy).toBeNull();
    expect(overdueIds(b)).toEqual([loan.id]);
  });
});
describe("valuation, insurance and authoriser (T-018a)", () => {
  const item = { recordId: newRecordId() };

  it("accepts them, and checks their form", () => {
    const loan = loanOut([item], {
      valuation: { amount: "1500.00", currency: "USD" },
      insurance: "Borrower's fine-art policy, wall to wall.",
      authorisedBy: "A. Director",
      authorisedOn: "2026-05-19",
    });
    expect(ok(validateLoan(loan, NOW)).valuation).toEqual({ amount: "1500.00", currency: "USD" });
    const bad = (extra: Record<string, unknown>): string[] =>
      codes(validateLoan({ ...loanOut([item]), ...extra }, NOW));
    expect(bad({ valuation: { amount: "-1", currency: "USD" } })).toEqual(["invalid_amount"]);
    expect(bad({ valuation: { amount: "1.234", currency: "USD" } })).toEqual(["invalid_amount"]);
    expect(bad({ valuation: { amount: "1e9", currency: "usd" } })).toEqual([
      "invalid_amount",
      "invalid_currency",
    ]);
    expect(bad({ valuation: { amount: "10", currency: "USD", rate: 1 } })).toEqual([
      "unknown_property",
    ]);
    expect(bad({ valuation: "1500" })).toEqual(["not_an_object"]);
    expect(bad({ authorisedOn: "2099-01-01" })).toEqual(["future_date"]);
    expect(bad({ authorisedBy: "two\nlines" })).toEqual(["control_characters"]);
  });
});

afterEach(() => {
  // Nothing global is left behind by the prototype test.
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, "notReceived")).toBe(false);
});

describe("review fixes (D-118's reviews)", () => {
  const urn = newRecordId();
  const arrival = move(urn, shelf.id, "2026-06-03", "placement");

  it("a cancelled loan stays cancelled, with its items and markers", () => {
    const loan = loanIn([{ recordId: urn }]);
    const b = ok(indexLoans(log([]), [loan]));
    const cancel = {
      ...loan,
      status: "cancelled" as const,
      items: [{ recordId: urn, notReceived: true as const }],
    };
    expect(codes(withLoan(b, { ...cancel, items: [{ recordId: urn }] }))).toEqual([
      "status_change_refused",
    ]);
    const cancelled = ok(withLoan(b, cancel));
    for (const status of ["requested", "agreed", "declined"] as const) {
      expect(codes(withLoan(cancelled, { ...cancel, status }))).toContain("status_change_refused");
    }
    expect(codes(withLoan(cancelled, { ...cancel, items: [{ recordId: urn }] }))).toEqual([
      "item_removed",
    ]);
  });

  it("ordinary work is never blocked: exhibition first, a correction, a placement back", () => {
    const shown = move(urn, showcase.id, "2026-06-02", "exhibition");
    const placed = move(urn, shelf.id, "2026-06-03", "placement");
    const back = move(urn, lenderPlace.id, "2026-10-01", "departure");
    const loan = loanIn([{ recordId: urn, arrivalMoveId: placed.id, departureMoveId: back.id }]);
    const b = ok(indexLoans(log([shown, placed, back]), [loan]));
    expect(ok(loanState(b, loan.id)).problems).toEqual([]);
    expect(overdueIds(b)).toEqual([]);
    expect(ok(unexplainedArrivals(b)).map((m) => m.id)).toEqual([shown.id]);
  });

  it("the lender stays once anything moved", () => {
    const loan = loanIn([{ recordId: urn, arrivalMoveId: arrival.id }]);
    const b = ok(indexLoans(log([arrival]), [loan]));
    expect(codes(withLoan(b, { ...loan, agentId: OTHER_LENDER }))).toEqual(["agent_changed"]);
  });

  it("a loan out's end date moved later without the move log stays overdue", () => {
    const print = newRecordId();
    const home = move(print, shelf.id, "2026-01-10", "placement");
    const out = move(print, borrowerPlace.id, "2026-06-05", "loan_out", {
      expectedReturnOn: "2026-10-31",
    });
    const loan = loanOut([{ recordId: print, loanOutMoveId: out.id }], { endOn: "2099-12-31" });
    const b = ok(indexLoans(log([home, out]), [loan]));
    expect(overdueIds(b)).toEqual([loan.id]);
    expect(ok(loanState(b, loan.id)).items[0]?.dueMatchesLoan).toBe(false);
  });
});
