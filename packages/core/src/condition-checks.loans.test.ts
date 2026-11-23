// Condition checks against the loan book (T-018a2, D-059): a check's loanId
// must name a loan in the book that lists the record, and loans out that go
// without a recent fit-to-move check are listed, the window given by the
// caller.
import { afterEach, describe, expect, it } from "vitest";
import {
  conditionLoanProblems,
  indexConditionChecks,
  indexLocations,
  indexLoans,
  indexMoves,
  loansOutWithoutFitCheck,
  newConditionCheckId,
  newLoanId,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  withConditionCheck,
  type ConditionCheck,
  type ConditionLog,
  type LoanBook,
  type LoanIn,
  type LoanOut,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const NOW = new Date("2026-11-23T18:00:00.000Z");
const TODAY = "2026-11-23";

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const BORROWER = newRecordId();
const LENDER = newRecordId();
const room = { id: newLocationId(), organizationId: ORG, kind: "storage", name: "Room", level: 0 };
const borrowerPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "County museum",
  agentId: BORROWER,
};
const INDEX = ok(
  indexLocations({ organizationId: ORG, levels: ["Room"] }, [
    room,
    borrowerPlace,
  ] as StorageLocation[]),
);

let tick = 0;
function stamp(): string {
  tick += 1;
  return new Date(Date.parse("2026-11-23T16:00:00.000Z") + tick * 1000).toISOString();
}

function move(
  recordId: string,
  locationId: string,
  movedOn: string,
  reason: StorageMove["reason"],
  extra: Partial<StorageMove> = {},
): StorageMove {
  return {
    id: newMoveId(),
    organizationId: ORG,
    recordId,
    locationId,
    movedOn,
    reason,
    recordedAt: stamp(),
    ...extra,
  } as StorageMove;
}

const print = newRecordId();
const map = newRecordId();
const lantern = newRecordId();
const printOut = move(print, borrowerPlace.id, "2026-09-01", "loan_out", {
  expectedReturnOn: "2026-12-15",
});
const LOG = ok(
  indexMoves(INDEX, [
    move(print, room.id, "2026-01-10", "placement"),
    move(map, room.id, "2026-01-10", "placement"),
    printOut,
  ]),
);

const out: LoanOut = {
  id: newLoanId(),
  organizationId: ORG,
  direction: "out",
  number: "LO-2026-001",
  agentId: BORROWER,
  beginOn: "2026-09-01",
  endOn: "2026-12-15",
  status: "agreed",
  statusOn: "2026-08-15",
  items: [{ recordId: print, loanOutMoveId: printOut.id }, { recordId: map }],
};
const requested: LoanOut = {
  ...out,
  id: newLoanId(),
  number: "LO-2026-002",
  status: "requested",
  items: [{ recordId: lantern }],
};
const borrowed: LoanIn = {
  id: newLoanId(),
  organizationId: ORG,
  direction: "in",
  number: "LI-2026-001",
  agentId: LENDER,
  beginOn: "2026-10-01",
  endOn: "2027-03-31",
  status: "agreed",
  statusOn: "2026-09-20",
  items: [{ recordId: lantern }],
};
const BOOK: LoanBook = ok(indexLoans(LOG, [out, requested, borrowed], NOW));

function check(
  recordId: string,
  checkedOn: string,
  extra: Partial<ConditionCheck> = {},
): ConditionCheck {
  return {
    id: newConditionCheckId(),
    organizationId: ORG,
    recordId,
    checkedOn,
    checkedBy: "A. Volunteer",
    condition: "good",
    reason: "loan_out",
    recordedAt: stamp(),
    ...extra,
  } as ConditionCheck;
}

function log(list: readonly unknown[]): ConditionLog {
  return ok(indexConditionChecks(ORG, list));
}

describe("a check's loanId and the loan book", () => {
  it("saves a check for a loan that lists the record", () => {
    const next = withConditionCheck(
      log([]),
      check(print, "2026-08-20", { loanId: out.id }),
      NOW,
      BOOK,
    );
    expect(ok(next).size).toBe(1);
    // A check that names no loan needs no book.
    expect(ok(withConditionCheck(log([]), check(print, "2026-08-20"), NOW)).size).toBe(1);
  });

  it("refuses a loan that isn't in the book, one that doesn't list the record, and no book", () => {
    const empty = log([]);
    expect(
      codes(
        withConditionCheck(empty, check(print, "2026-08-20", { loanId: newLoanId() }), NOW, BOOK),
      ),
    ).toEqual(["unknown_loan"]);
    expect(
      codes(withConditionCheck(empty, check(lantern, "2026-08-20", { loanId: out.id }), NOW, BOOK)),
    ).toEqual(["not_on_loan"]);
    expect(
      codes(withConditionCheck(empty, check(print, "2026-08-20", { loanId: out.id }), NOW)),
    ).toEqual(["loans_unknown"]);
  });

  it("refuses anything but the organization's own loan book", () => {
    const c = check(print, "2026-08-20", { loanId: out.id });
    const empty = log([]);
    expect(codes(withConditionCheck(empty, c, NOW, { ...BOOK }))).toEqual(["not_a_loan_book"]);
    expect(codes(withConditionCheck(empty, c, NOW, new Proxy(BOOK, {})))).toEqual([
      "not_a_loan_book",
    ]);
    const other = newOrganizationId();
    const theirLog = ok(
      indexMoves(ok(indexLocations({ organizationId: other, levels: ["Room"] }, [])), []),
    );
    const theirs = ok(indexLoans(theirLog, [], NOW));
    expect(codes(withConditionCheck(empty, c, NOW, theirs))).toEqual(["mixed_organizations"]);
    expect(codes(conditionLoanProblems(empty, theirs))).toEqual(["mixed_organizations"]);
    expect(codes(loansOutWithoutFitCheck(empty, theirs, { today: TODAY, maxAgeDays: 30 }))).toEqual(
      ["mixed_organizations"],
    );
  });

  it("lists checks already in a log whose loanId doesn't fit the book", () => {
    const fine = check(print, "2026-08-20", { loanId: out.id });
    const gone = check(map, "2026-08-21", { loanId: newLoanId() });
    const wrong = check(lantern, "2026-08-22", { loanId: out.id });
    const found = ok(
      conditionLoanProblems(log([wrong, fine, gone, check(map, "2026-08-23")]), BOOK),
    );
    expect(found.map((p) => [p.checkId, p.code])).toEqual([
      [gone.id, "unknown_loan"],
      [wrong.id, "not_on_loan"],
    ]);
    expect(codes(conditionLoanProblems(log([]), {}))).toEqual(["not_a_loan_book"]);
  });
});

describe("loans out without a recent fit-to-move check", () => {
  const warn = (l: ConditionLog, maxAgeDays: unknown, today: unknown = TODAY) =>
    loansOutWithoutFitCheck(l, BOOK, { today, maxAgeDays });

  it("judges a sent item on the day it went out, an unsent one on today", () => {
    const l = log([check(print, "2026-08-20"), check(map, "2026-11-01")]);
    expect(ok(warn(l, 30))).toEqual([]);
    const stale = ok(warn(l, 10));
    expect(stale.map((w) => [w.recordId, w.sent, w.on, w.because])).toEqual([
      [print, true, "2026-09-01", "stale"],
      [map, false, TODAY, "stale"],
    ]);
  });

  it("a check after the item went out doesn't count for it", () => {
    const l = log([check(print, "2026-09-02"), check(map, "2026-11-01")]);
    expect(ok(warn(l, 365)).map((w) => [w.recordId, w.because])).toEqual([[print, "unchecked"]]);
  });

  it("a check on the day it went out counts only if written down before the move", () => {
    const after = check(print, "2026-09-01");
    expect(after.recordedAt > printOut.recordedAt).toBe(true);
    const mapOk = check(map, "2026-11-01");
    expect(ok(warn(log([after, mapOk]), 30)).map((w) => [w.recordId, w.because])).toEqual([
      [print, "unchecked"],
    ]);
    const before = check(print, "2026-09-01", { recordedAt: "2026-11-23T15:00:00.000Z" });
    expect(before.recordedAt < printOut.recordedAt).toBe(true);
    expect(ok(warn(log([before, mapOk]), 30))).toEqual([]);
  });

  it("an item whose named loan_out isn't in the log is reported, never taken as not sent", () => {
    const broken: LoanOut = {
      ...out,
      id: newLoanId(),
      number: "LO-2026-009",
      items: [{ recordId: map, loanOutMoveId: newMoveId() }],
    };
    const b = ok(indexLoans(LOG, [broken], NOW));
    const found = ok(
      loansOutWithoutFitCheck(log([check(map, "2026-11-20")]), b, {
        today: TODAY,
        maxAgeDays: 30,
      }),
    );
    expect(found.map((w) => [w.recordId, w.sent, w.because])).toEqual([
      [map, true, "move_unknown"],
    ]);
  });

  it("lists an unfit item, and ignores loans not agreed and loans in", () => {
    const l = log([
      check(print, "2026-08-20", { condition: "needs_conservation" }),
      check(map, "2026-11-01", { fitToMove: false }),
    ]);
    expect(ok(warn(l, 365)).map((w) => [w.loanId, w.recordId, w.because])).toEqual([
      [out.id, print, "unfit"],
      [out.id, map, "unfit"],
    ]);
    // The lantern (on a requested loan out and a loan in) is never checked, and never listed.
    expect(ok(warn(log([]), 365)).map((w) => w.recordId)).toEqual([print, map]);
  });

  it("needs the window and the day from the caller", () => {
    const l = log([]);
    expect(codes(loansOutWithoutFitCheck(l, BOOK, { today: TODAY } as never))).toEqual([
      "required",
    ]);
    for (const bad of [-1, 1.5, "30", 40_000, Number.NaN]) {
      expect(codes(warn(l, bad))).toEqual(["invalid_age"]);
    }
    expect(codes(warn(l, 30, "23/11/2026"))).toEqual(["invalid_date"]);
    expect(codes(warn({} as ConditionLog, 30))).toEqual(["not_a_condition_log"]);
  });

  describe("with Object.prototype polluted", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).maxAgeDays;
      delete (Object.prototype as Record<string, unknown>).today;
    });

    it("a window or a day on the prototype isn't taken", () => {
      (Object.prototype as Record<string, unknown>).maxAgeDays = 36_500;
      (Object.prototype as Record<string, unknown>).today = TODAY;
      expect(codes(loansOutWithoutFitCheck(log([]), BOOK, { today: TODAY } as never))).toEqual([
        "required",
      ]);
      expect(codes(loansOutWithoutFitCheck(log([]), BOOK, { maxAgeDays: 30 } as never))).toEqual([
        "invalid_date",
      ]);
    });
  });
});
