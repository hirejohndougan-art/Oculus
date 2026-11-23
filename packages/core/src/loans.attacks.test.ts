// Attack tests for loans and condition checks: another organization's data,
// hostile lists and objects, forged snapshots, huge inputs, moves borrowed
// from other records or agents, and staff-only entries trying to reach public
// output.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_CONDITION_CHECKS,
  MAX_LOANS,
  MAX_LOAN_ITEMS,
  conditionHistory,
  fitToMove,
  indexConditionChecks,
  indexLocations,
  indexLoans,
  indexMoves,
  latestCondition,
  loanById,
  loanList,
  loanOutMove,
  loanProblems,
  loanState,
  loansOfRecord,
  needingConservation,
  newConditionCheckId,
  newLoanId,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  overdueLoans,
  publicOutput,
  publicView,
  reindexLoans,
  validateConditionCheck,
  validateLoan,
  validateRecord,
  withConditionCheck,
  withLoan,
  type ConditionCheck,
  type LoanBook,
  type LoanOut,
  type PublicRecord,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";
import { BASE, CHECKERS, MAPPING, nowOf } from "./public-output.fixtures.js";

const ORG = newOrganizationId();
const OTHER = newOrganizationId();
const NOW = new Date("2026-11-23T18:00:00.000Z");

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

function messages(result: Validated<unknown>): string {
  return result.ok ? "" : result.issues.map((i) => i.message).join("\n");
}

const BORROWER = newRecordId();
const shelf = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "storage",
  name: "Shelf",
  level: 0,
};
const borrowerPlace = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "County museum",
  agentId: BORROWER,
};
const INDEX = ok(
  indexLocations({ organizationId: ORG, levels: ["Room"] }, [
    shelf,
    borrowerPlace,
  ] as StorageLocation[]),
);

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
    recordedAt: `${movedOn}T12:00:00.000Z`,
    ...extra,
  } as StorageMove;
}

const print = newRecordId();
const placed = move(print, shelf.id, "2026-01-10", "placement");
const sent = move(print, borrowerPlace.id, "2026-09-01", "loan_out", {
  expectedReturnOn: "2026-11-15",
});
const LOG = ok(indexMoves(INDEX, [placed, sent]));

function loan(extra: Partial<LoanOut> = {}): LoanOut {
  return {
    id: newLoanId(),
    organizationId: ORG,
    direction: "out",
    number: "LO-1",
    agentId: BORROWER,
    beginOn: "2026-09-01",
    endOn: "2026-11-15",
    status: "agreed",
    statusOn: "2026-08-15",
    items: [{ recordId: print, loanOutMoveId: sent.id }],
    ...extra,
  };
}

function check(extra: Partial<ConditionCheck> = {}): ConditionCheck {
  return {
    id: newConditionCheckId(),
    organizationId: ORG,
    recordId: print,
    checkedOn: "2026-08-20",
    checkedBy: "A. Volunteer",
    condition: "good",
    reason: "loan_out",
    recordedAt: "2026-08-20T12:00:00.000Z",
    ...extra,
  };
}

const BOOK = ok(indexLoans(LOG, [loan()]));
const CHECKS = ok(indexConditionChecks(ORG, [check()]));

describe("another organization's data is refused, never filtered", () => {
  it("refuses another organization's loan in a book or added to one, without naming it", () => {
    const theirs = loan({ organizationId: OTHER, number: "THEIR-SECRET-LOAN" });
    const r = indexLoans(LOG, [loan({ number: "LO-2", items: [{ recordId: print }] }), theirs]);
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(messages(r)).not.toContain("SECRET");
    expect(messages(r)).not.toContain(OTHER);
    expect(codes(withLoan(BOOK, theirs))).toEqual(["mixed_organizations"]);
  });

  it("refuses loans checked against another organization's move log", () => {
    const theirIndex = ok(
      indexLocations({ organizationId: OTHER, levels: ["Room"] }, [
        { ...shelf, id: newLocationId(), organizationId: OTHER },
      ]),
    );
    const theirLog = ok(indexMoves(theirIndex, []));
    expect(problemCodes(indexLoans(theirLog, [loan()]))).toEqual(["mixed_organizations"]);
    expect(problemCodes(reindexLoans(BOOK, theirLog))).toEqual(["mixed_organizations"]);
  });

  it("refuses another organization's condition check, and a log with no organization", () => {
    const theirs = check({ organizationId: OTHER, note: "Their fragile vault item" });
    const r = indexConditionChecks(ORG, [check(), theirs]);
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(messages(r)).not.toContain("vault");
    expect(codes(withConditionCheck(CHECKS, theirs, NOW))).toEqual(["mixed_organizations"]);
    expect(codes(indexConditionChecks(undefined, []))).toEqual(["invalid_organization"]);
    const orphan = Object.fromEntries(
      Object.entries(check()).filter(([k]) => k !== "organizationId"),
    );
    expect(codes(indexConditionChecks(ORG, [orphan]))).toEqual(["invalid_organization"]);
  });
});

describe("hostile lists and objects", () => {
  it("refuses Proxies, non-lists, holes and getters, reading each entry once", () => {
    for (const result of [
      indexLoans(LOG, new Proxy([loan()], {})),
      indexLoans(LOG, { 0: loan(), length: 1 }),
      indexConditionChecks(ORG, new Proxy([], {})),
    ]) {
      expect(codes(result)).toEqual(["not_a_list"]);
    }
    // eslint-disable-next-line no-sparse-arrays -- a hole is the attack
    expect(problemCodes(indexLoans(LOG, [loan(), , loan()]))).toEqual(["unreadable_entry"]);
    const tricky: unknown[] = [];
    let reads = 0;
    Object.defineProperty(tricky, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? check() : check({ organizationId: OTHER });
      },
    });
    expect(codes(indexConditionChecks(ORG, tricky))).toEqual(["unreadable_entry"]);
    expect(reads).toBe(0);
  });

  it("refuses a loan, item or check with a getter, a Proxy or a prototype key", () => {
    const getter = { ...loan() };
    Object.defineProperty(getter, "agentId", { enumerable: true, get: () => BORROWER });
    expect(codes(validateLoan(getter))).toEqual(["not_plain_data"]);
    expect(codes(validateLoan(new Proxy(loan(), {})))).toEqual(["not_an_object"]);
    const sneaky = { recordId: print };
    Object.defineProperty(sneaky, "loanOutMoveId", { enumerable: true, get: () => sent.id });
    expect(codes(validateLoan(loan({ items: [sneaky] })))).toEqual(["not_plain_data"]);
    expect(codes(validateLoan(loan({ items: [new Proxy({ recordId: print }, {})] })))).toEqual([
      "not_plain_data",
    ]);
    const polluted: unknown = JSON.parse(
      JSON.stringify(loan()).replace('"items":[{', '"items":[{"__proto__":{"returnMoveId":"x"},'),
    );
    expect(codes(validateLoan(polluted))).toEqual(["forbidden_key"]);
    const pollutedCheck: unknown = JSON.parse(
      JSON.stringify(check()).replace("{", '{"__proto__":{"fitToMove":true},'),
    );
    expect(codes(validateConditionCheck(pollutedCheck))).toEqual(["forbidden_key"]);
    expect(codes(validateConditionCheck({ ...check(), note: ["x"] }))).toEqual(["too_deep"]);
  });

  it("refuses text that hides or reorders itself", () => {
    expect(codes(validateLoan(loan({ number: "LO‮1" })))).toEqual(["bad_characters"]);
    expect(codes(validateConditionCheck(check({ checkedBy: "A​B" })))).toEqual(["bad_characters"]);
  });

  it("refuses hostile options to the queries", () => {
    const getter = {};
    Object.defineProperty(getter, "on", { enumerable: true, get: () => "2026-09-01" });
    expect(codes(fitToMove(CHECKS, print, getter as never))).toEqual(["unreadable"]);
    expect(codes(fitToMove(CHECKS, print, new Proxy({ on: "2026-09-01" }, {})))).toEqual([
      "unreadable",
    ]);
    const inherited = Object.create({ on: "2026-09-01" }) as { on: string };
    expect(codes(fitToMove(CHECKS, print, inherited))).toEqual(["invalid_date"]);
    expect(codes(latestCondition(CHECKS, print, null as never))).toEqual(["unreadable"]);
  });

  it("keeps work bounded on huge input", () => {
    const loans: unknown[] = [];
    loans.length = MAX_LOANS + 1;
    expect(problemCodes(indexLoans(LOG, loans))).toEqual(["too_many"]);
    const checks: unknown[] = [];
    checks.length = MAX_CONDITION_CHECKS + 1;
    expect(codes(indexConditionChecks(ORG, checks))).toEqual(["too_many"]);
    const items = Array.from({ length: MAX_LOAN_ITEMS + 1 }, () => ({ recordId: newRecordId() }));
    expect(codes(validateLoan(loan({ items })))).not.toEqual([]);
    const many = Array.from({ length: MAX_LOAN_ITEMS }, () => ({ recordId: newRecordId() }));
    expect(ok(validateLoan(loan({ items: many }))).items).toHaveLength(MAX_LOAN_ITEMS);
  });

  it("a caller changing its objects afterwards changes nothing", () => {
    const mine = loan({ number: "LO-77" });
    const list = [mine];
    const b = ok(indexLoans(LOG, list));
    (mine as { number: string }).number = "Changed";
    (mine.items as unknown as { recordId: string }[]).push({ recordId: newRecordId() });
    list.push(loan({ number: "LO-78" }));
    expect(b.size).toBe(1);
    expect(loanById(b, mine.id)?.number).toBe("LO-77");
    expect(loanById(b, mine.id)?.items).toHaveLength(1);
    expect(Object.isFrozen(ok(loanList(b)))).toBe(true);
    expect(Object.isFrozen(ok(loanState(b, mine.id)))).toBe(true);
    expect(Object.isFrozen(ok(conditionHistory(CHECKS, print)))).toBe(true);
  });
});

describe("forged snapshots and borrowed moves", () => {
  it("refuses a book, log or move log that only looks like one", () => {
    const forged = { ...BOOK };
    for (const result of [
      withLoan(forged, loan()),
      reindexLoans(forged, LOG),
      loanList(forged),
      loansOfRecord(forged, print),
      loanState(forged, newLoanId()),
      overdueLoans(forged, "2026-11-20"),
    ]) {
      expect(codes(result)).toEqual(["not_a_loan_book"]);
    }
    expect(loanById(forged, newLoanId())).toBeUndefined();
    expect(codes(withLoan(new Proxy(BOOK, {}), loan()))).toEqual(["not_a_loan_book"]);
    expect(problemCodes(indexLoans({ ...LOG }, []))).toEqual(["not_a_move_log"]);
    expect(problemCodes(reindexLoans(BOOK, { ...LOG }))).toEqual(["not_a_move_log"]);
    const forgedChecks = { ...CHECKS };
    for (const result of [
      withConditionCheck(forgedChecks, check(), NOW),
      conditionHistory(forgedChecks, print),
      latestCondition(forgedChecks, print),
      fitToMove(forgedChecks, print, { on: "2026-09-01" }),
      needingConservation(forgedChecks),
    ]) {
      expect(codes(result)).toEqual(["not_a_condition_log"]);
    }
  });

  it("can't claim a move that went to another agent's location", () => {
    // The same move, claimed by a loan to someone else.
    expect(problemCodes(indexLoans(LOG, [loan({ agentId: newRecordId() })]))).toEqual([
      "not_agent_location",
    ]);
  });

  it("can't pass off an old loan_out or placement as this loan's (review fix)", () => {
    // A 2030 loan claiming the 2026 loan_out; a loan in claiming a placement from before it.
    const later = loan({ beginOn: "2030-01-01", endOn: "2030-06-01", statusOn: "2026-11-01" });
    expect(codes(withLoan(ok(indexLoans(LOG, [])), later, NOW))).toEqual(["move_outside_loan"]);
    const borrowedIn = {
      ...loan(),
      direction: "in",
      beginOn: "2026-06-01",
      endOn: "2027-06-01",
      items: [{ recordId: print, arrivalMoveId: placed.id }],
    };
    expect(codes(withLoan(ok(indexLoans(LOG, [])), borrowedIn, NOW))).toEqual([
      "move_outside_loan",
    ]);
  });

  it("can't back-date the clock or a status into the future", () => {
    expect(codes(validateLoan(loan(), new Proxy(NOW, {})))).toEqual(["invalid_time"]);
    expect(codes(withLoan(BOOK, loan({ statusOn: "2099-01-01" }), NOW))).toEqual(["future_status"]);
  });

  it("can't claim another record's move, or a move missing from the log", () => {
    const other = newRecordId();
    expect(
      problemCodes(
        indexLoans(LOG, [loan({ items: [{ recordId: other, loanOutMoveId: sent.id }] })]),
      ),
    ).toEqual(["unknown_move"]);
  });

  it("can't close a loan with items out, or mark it returned with a move from before", () => {
    expect(codes(withLoan(BOOK, { ...loan(), status: "closed" }))).toEqual([
      "closed_with_items_out",
    ]);
    expect(
      problemCodes(
        indexLoans(LOG, [
          loan({ items: [{ recordId: print, loanOutMoveId: sent.id, returnMoveId: placed.id }] }),
        ]),
      ),
    ).toEqual(["wrong_move_reason", "end_out_of_order"]);
  });

  it("can't pin a record's condition by stamping a check in the future", () => {
    const forged = check({ checkedOn: "2026-11-23", recordedAt: "9999-12-30T00:00:00.000Z" });
    expect(codes(withConditionCheck(CHECKS, forged, NOW))).toEqual(["future_recorded"]);
    expect(codes(withConditionCheck(CHECKS, check(), new Date(Number.NaN)))).toEqual([
      "invalid_time",
    ]);
    const first = ok(conditionHistory(CHECKS, print))[0];
    if (first === undefined) throw new Error("no history");
    expect(codes(withConditionCheck(CHECKS, { ...first, condition: "fair" }, NOW))).toEqual([
      "duplicate_id",
    ]);
  });

  it("loanOutMove takes nothing from the caller but the loan, record, place and day", () => {
    const input = ok(
      loanOutMove(loan({ items: [{ recordId: print }] }), print, shelf.id, "2026-09-01"),
    );
    expect(Object.keys(input).sort()).toEqual([
      "expectedReturnOn",
      "locationId",
      "movedOn",
      "note",
      "organizationId",
      "reason",
      "recordId",
    ]);
    expect(codes(loanOutMove(new Proxy(loan(), {}), print, shelf.id, "2026-09-01"))).toEqual([
      "not_an_object",
    ]);
  });
});

describe("loans and condition checks stay staff-only", () => {
  it("a loan or check is never a record, and never a public view", () => {
    expect(validateRecord(loan()).ok).toBe(false);
    expect(validateRecord({ ...check(), kind: "object", title: "x" }).ok).toBe(false);
    for (const thing of [
      loan(),
      check(),
      BOOK,
      CHECKS,
      ok(loanState(BOOK, ok(loanList(BOOK))[0]?.id)),
    ]) {
      expect(publicView(thing as never)).toBeUndefined();
      const out = publicOutput(thing as unknown as PublicRecord, MAPPING, {
        ...nowOf(thing),
        baseUrl: BASE,
        published: [print],
        checkers: CHECKERS,
      });
      expect(codes(out)).toEqual(["not_public_view"]);
    }
  });

  it("no module but the package index imports loans or condition checks", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["loans", "condition-checks"]) {
      const mentions = new RegExp(`["'\`](?:\\.{1,2}/)+(?:[^"'\`]*/)?${name}(?:\\.[jt]s)?["'\`]`);
      const importers = (readdirSync(here, { recursive: true }) as string[])
        .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.test\.ts$|\.fixtures\.ts$/.test(f))
        .filter((f) => f !== `${name}.ts`)
        .filter((f) => mentions.test(readFileSync(join(here, f), "utf8")));
      expect(importers).toEqual(["index.ts"]);
      expect(mentions.test(`await import("./${name}")`)).toBe(true);
    }
  });
});
