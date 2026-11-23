import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  DEFAULT_FIT_TO_MOVE_DAYS,
  conditionHistory,
  createConditionCheck,
  fitToMove,
  indexConditionChecks,
  isConditionCheckId,
  isConditionLog,
  latestCondition,
  needingConservation,
  newConditionCheckId,
  newLoanId,
  newOrganizationId,
  newRecordId,
  validateConditionCheck,
  withConditionCheck,
  type ConditionCheck,
  type ConditionLog,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const NOW = new Date("2026-11-23T18:00:00.000Z");

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

let tick = 0;
function check(
  recordId: string,
  checkedOn: string,
  condition: ConditionCheck["condition"] = "good",
  extra: Partial<ConditionCheck> = {},
): ConditionCheck {
  tick += 1;
  return {
    id: newConditionCheckId(),
    organizationId: ORG,
    recordId,
    checkedOn,
    checkedBy: "A. Volunteer",
    condition,
    reason: "routine",
    recordedAt: new Date(Date.parse("2026-11-23T16:00:00.000Z") + tick * 1000).toISOString(),
    ...extra,
  } as ConditionCheck;
}

const map = newRecordId();
const ledger = newRecordId();

function log(list: readonly unknown[]): ConditionLog {
  return ok(indexConditionChecks(ORG, list));
}

describe("validateConditionCheck", () => {
  it("accepts a check with the Spectrum minimum: date, checker, condition, reason", () => {
    const c = check(map, "2026-11-01", "fair", {
      checkerId: newRecordId(),
      note: "Small tear at the lower edge.",
      fitToMove: true,
      loanId: newLoanId(),
    });
    const v = ok(validateConditionCheck(c));
    expect(v).toEqual(c);
    expect(v).not.toBe(c);
    expect(Object.isFrozen(v)).toBe(true);
    expect(CONDITIONS).toEqual(["good", "fair", "needs_conservation"]);
  });

  it("refuses missing or bad fields", () => {
    expect(codes(validateConditionCheck({ ...check(map, "2026-11-01"), checkedBy: "" }))).toEqual([
      "required",
    ]);
    expect(
      codes(validateConditionCheck({ ...check(map, "2026-11-01"), checkedBy: "A\nB" })),
    ).toEqual(["control_characters"]);
    expect(
      codes(validateConditionCheck({ ...check(map, "2026-11-01"), condition: "poor" })),
    ).toEqual(["invalid_condition"]);
    expect(codes(validateConditionCheck({ ...check(map, "2026-11-01"), reason: "whim" }))).toEqual([
      "invalid_reason",
    ]);
    expect(codes(validateConditionCheck(check(map, "2026-02-30")))).toEqual(["invalid_date"]);
    expect(
      codes(validateConditionCheck({ ...check(map, "2026-11-01"), fitToMove: "yes" })),
    ).toEqual(["invalid_fit"]);
    expect(codes(validateConditionCheck({ ...check(map, "2026-11-01"), loanId: "L1" }))).toEqual([
      "invalid_id",
    ]);
    expect(codes(validateConditionCheck({ ...check(map, "2026-11-01"), extra: 1 }))).toEqual([
      "unknown_property",
    ]);
    expect(codes(validateConditionCheck({ ...check(map, "2026-11-01"), note: "  " }))).toEqual([
      "invalid_note",
    ]);
  });

  it("refuses a check dated after the day it was written down", () => {
    expect(
      codes(
        validateConditionCheck(
          check(map, "2026-11-26", "good", { recordedAt: "2026-11-23T12:00:00.000Z" }),
        ),
      ),
    ).toEqual(["future_check"]);
  });

  it("createConditionCheck stamps an ID and the time", () => {
    const made = ok(
      createConditionCheck(
        {
          organizationId: ORG,
          recordId: map,
          checkedOn: "2026-11-23",
          checkedBy: "A. Volunteer",
          condition: "good",
          reason: "loan_out",
        },
        NOW,
      ),
    );
    expect(isConditionCheckId(made.id)).toBe(true);
    expect(made.recordedAt).toBe(NOW.toISOString());
    expect(codes(createConditionCheck(made, new Date(Number.NaN)))).toEqual(["invalid_time"]);
  });
});

describe("condition logs", () => {
  it("keeps each record's checks as dated entries, oldest first", () => {
    const later = check(map, "2026-11-10", "needs_conservation");
    const earlier = check(map, "2026-03-01", "good");
    const l = log([later, earlier, check(ledger, "2026-05-01")]);
    expect(isConditionLog(l)).toBe(true);
    expect(l.size).toBe(3);
    expect(l.records).toBe(2);
    expect(ok(conditionHistory(l, map)).map((c) => c.id)).toEqual([earlier.id, later.id]);
    expect(ok(conditionHistory(l, newRecordId()))).toEqual([]);
    expect(ok(latestCondition(l, map))?.id).toBe(later.id);
    expect(ok(latestCondition(l, map, { on: "2026-06-01" }))?.id).toBe(earlier.id);
    expect(ok(latestCondition(l, map, { on: "2026-01-01" }))).toBeNull();
    expect(codes(latestCondition(l, map, { on: "June" }))).toEqual(["invalid_date"]);
  });

  it("orders same-day checks by when they were written down", () => {
    const a = check(map, "2026-11-10", "good");
    const b = check(map, "2026-11-10", "needs_conservation");
    expect(ok(latestCondition(log([b, a]), map))?.id).toBe(b.id);
  });

  it("an empty log still belongs to its organization", () => {
    const l = log([]);
    expect(l.organizationId).toBe(ORG);
    expect(l.size).toBe(0);
  });

  it("refuses duplicate IDs and reports each check's problems under its position", () => {
    const c = check(map, "2026-11-01");
    expect(codes(indexConditionChecks(ORG, [c, { ...c }]))).toEqual(["duplicate_id"]);
    const r = indexConditionChecks(ORG, [c, { ...check(map, "2026-11-01"), condition: "x" }]);
    expect(r.ok ? [] : r.issues[0]?.path).toEqual([1, "condition"]);
  });

  it("withConditionCheck adds an entry and leaves the old log as it was", () => {
    const l = log([check(map, "2026-03-01")]);
    const added = check(map, "2026-11-20", "fair");
    const next = ok(withConditionCheck(l, added, NOW));
    expect(next.size).toBe(2);
    expect(l.size).toBe(1);
    expect(ok(latestCondition(next, map))?.id).toBe(added.id);
    expect(codes(withConditionCheck(next, added, NOW))).toEqual(["duplicate_id"]);
  });

  it("lists records whose latest check needs conservation, longest waiting first", () => {
    const old = check(ledger, "2026-01-05", "needs_conservation");
    const recent = check(map, "2026-10-01", "needs_conservation");
    const fixed = newRecordId();
    const l = log([
      recent,
      old,
      check(fixed, "2026-02-01", "needs_conservation"),
      check(fixed, "2026-06-01", "good"),
    ]);
    expect(ok(needingConservation(l)).map((c) => c.recordId)).toEqual([ledger, map]);
  });
});

describe("fitToMove", () => {
  it("goes by the latest check on or before the day", () => {
    const l = log([
      check(map, "2026-03-01", "good"),
      check(map, "2026-11-10", "needs_conservation"),
    ]);
    expect(ok(fitToMove(l, map, { on: "2026-06-01" }))).toMatchObject({
      fit: true,
      because: "fit",
    });
    expect(ok(fitToMove(l, map, { on: "2026-11-20" }))).toMatchObject({
      fit: false,
      because: "unfit",
    });
    expect(ok(fitToMove(l, map, { on: "2026-01-01" }))).toMatchObject({
      fit: false,
      because: "unchecked",
      check: null,
    });
    expect(ok(fitToMove(l, ledger, { on: "2026-11-20" })).because).toBe("unchecked");
  });

  it("is not fit on a check older than maxAgeDays", () => {
    const l = log([check(map, "2025-01-01", "good")]);
    expect(DEFAULT_FIT_TO_MOVE_DAYS).toBe(365);
    expect(ok(fitToMove(l, map, { on: "2026-11-20" })).because).toBe("stale");
    expect(ok(fitToMove(l, map, { on: "2026-11-20", maxAgeDays: 1000 })).because).toBe("fit");
    expect(ok(fitToMove(l, map, { on: "2025-01-01", maxAgeDays: 0 })).because).toBe("fit");
    expect(ok(fitToMove(l, map, { on: "2025-01-02", maxAgeDays: 0 })).because).toBe("stale");
    for (const bad of [-1, 1.5, "30", 40_000]) {
      expect(codes(fitToMove(l, map, { on: "2026-11-20", maxAgeDays: bad }))).toEqual([
        "invalid_age",
      ]);
    }
  });

  it("follows the checker's own word over the condition", () => {
    const l = log([
      check(map, "2026-11-01", "needs_conservation", { fitToMove: true }),
      check(ledger, "2026-11-01", "fair", { fitToMove: false }),
    ]);
    expect(ok(fitToMove(l, map, { on: "2026-11-02" })).fit).toBe(true);
    expect(ok(fitToMove(l, ledger, { on: "2026-11-02" })).fit).toBe(false);
  });

  it("refuses a bad day or record ID", () => {
    const l = log([]);
    expect(codes(fitToMove(l, map, { on: "tomorrow" }))).toEqual(["invalid_date"]);
    expect(codes(fitToMove(l, "M-1", { on: "2026-11-20" }))).toEqual(["invalid_id"]);
  });
});
