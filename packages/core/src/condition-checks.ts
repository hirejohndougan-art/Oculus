/**
 * Condition checks (Spectrum "Condition checking and technical assessment";
 * decision D-044).
 *
 * A condition check is one dated entry on one record (an object, an archival
 * unit …): the day it was checked, who checked it, the condition found, why
 * it was checked and any notes. Spectrum asks for "the date, name of the
 * condition checker and the reason for checking", and for condition
 * information that can be found through the object. Checks are never
 * edited into each other: each is its own entry, so the log is the record's
 * condition history (mockup record "Condition": Good, Fair, Needs
 * conservation).
 *
 * **Everything here is staff-only**, like storage (D-040): condition notes
 * say what is fragile or damaged and name the checker. None of it is a
 * catalog record or a record field, nothing in `effective.ts` or
 * `public-output.ts` reads it, and a test checks no module but `index.ts`
 * imports it.
 *
 * `indexConditionChecks` validates one organization's checks once into a
 * frozen, opaque snapshot (recognised by a WeakMap, never by shape);
 * `withConditionCheck` checks one new entry before it is saved;
 * `conditionHistory`, `latestCondition`, `fitToMove` and
 * `needingConservation` read only the snapshot. Every check carries a
 * required `organizationId` and a log that mixes organizations is refused
 * (D-030). A check's `recordId` and `checkerId` are only checked for being
 * IDs: the service layer (T-032) checks they are the same organization's.
 *
 * **Checks and the loan book** (T-018a2, D-059). A new check that names a
 * `loanId` is saved only against the loan book (`withConditionCheck`'s
 * `loans`): the loan must be in it and list the record. Checks already in a
 * log are checked against a book by `conditionLoanProblems`.
 * `loansOutWithoutFitCheck` lists the items of agreed loans out that went
 * out, or are waiting to go, without a fit-to-move check recent enough: the
 * caller gives the window (`maxAgeDays`) and the day. The loan book is read
 * through `loan-facts.ts`, never `loans.ts`. Nothing here throws on bad input.
 */
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { isOrganizationId, mixedOrganizationsIssue, type OrganizationId } from "./organizations.js";
import { IssueList, readPlainData, type JsonValue } from "./plain-data.js";
import { loanFactsOf, type LoanFacts } from "./loan-facts.js";
import { isRecordId, type RecordId } from "./record-id.js";
import {
  MAX_STORAGE_NOTE_LENGTH,
  checkNote,
  dayAfter,
  guarded,
  isIsoDay,
  parseUtc,
  readList,
  readTop,
  refused,
  unknownKeys,
} from "./storage.js";

declare const checkIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one condition check forever. */
export type ConditionCheckId = string & { readonly [checkIdBrand]: true };

/**
 * The condition found (mockup record "Condition"). `good` and `fair` are fit
 * to move unless the checker says otherwise; `needs_conservation` is not.
 */
export const CONDITIONS = ["good", "fair", "needs_conservation"] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * Why it was checked (Spectrum: "Reason for the condition check/assessment").
 * Spectrum asks for checks at points of risk: on entry, before and after a
 * loan, before and after display, moves and treatment.
 */
export const CONDITION_CHECK_REASONS = [
  "entry",
  "routine",
  "audit",
  "loan_out",
  "loan_in",
  "loan_return",
  "exhibition",
  "move",
  "conservation",
  "damage",
  "other",
] as const;
export type ConditionCheckReason = (typeof CONDITION_CHECK_REASONS)[number];

/** One condition check of one record. */
export interface ConditionCheck {
  readonly id: ConditionCheckId;
  readonly organizationId: OrganizationId;
  /** The record that was checked. */
  readonly recordId: RecordId;
  /** The day it was checked, `YYYY-MM-DD`. */
  readonly checkedOn: string;
  /** Who checked it, as a name (one line). */
  readonly checkedBy: string;
  /** Optionally, the agent record of who checked it (a conservator, say). */
  readonly checkerId?: RecordId;
  readonly condition: Condition;
  readonly reason: ConditionCheckReason;
  /**
   * The checker's word on whether it can be moved (packed, sent on loan,
   * put on display). Left out, it follows the condition: `good` and `fair`
   * can, `needs_conservation` can't. A conservator may say a damaged item can
   * travel to the studio, or that a fair one is too fragile to go anywhere.
   */
  readonly fitToMove?: boolean;
  /** The loan the check was made for (a check before a loan out, say). */
  readonly loanId?: string;
  /** What was found, and any recommendations. */
  readonly note?: string;
  /** When the check was written down, ISO 8601 UTC. Orders checks on the same day. */
  readonly recordedAt: string;
}

/** A validated, frozen snapshot of one organization's condition checks. Opaque. */
export interface ConditionLog {
  readonly organizationId: OrganizationId;
  /** How many checks. */
  readonly size: number;
  /** How many records have been checked at least once. */
  readonly records: number;
}

/** The answer of `fitToMove`. */
export interface FitToMove {
  readonly recordId: RecordId;
  /** True only when the latest usable check says it can be moved. */
  readonly fit: boolean;
  /**
   * `fit`: the latest check, recent enough, says it can move.
   * `unfit`: the latest check says it can't. `stale`: the latest check is
   * older than `maxAgeDays`. `unchecked`: no check on or before the day.
   */
  readonly because: "fit" | "unfit" | "stale" | "unchecked";
  /** The check the answer is based on, or null when there is none. */
  readonly check: ConditionCheck | null;
}

/** A check whose `loanId` doesn't fit the loan book, as `conditionLoanProblems` lists it. */
export interface ConditionLoanProblem {
  readonly checkId: ConditionCheckId;
  readonly recordId: RecordId;
  readonly loanId: string;
  /** `unknown_loan`: no such loan in the book. `not_on_loan`: the loan doesn't list the record. */
  readonly code: "unknown_loan" | "not_on_loan";
}

/** An item of a loan out without a recent fit-to-move check, as `loansOutWithoutFitCheck` lists it. */
export interface LoanFitWarning {
  readonly loanId: string;
  readonly recordId: RecordId;
  /** True when the item has gone out (its `loan_out` is linked); judged on that day. */
  readonly sent: boolean;
  /** The day judged on: the day it went out, or `today` while it hasn't. */
  readonly on: string;
  /** Why: `unfit`, `stale` or `unchecked` (see `FitToMove`). */
  readonly because: "unfit" | "stale" | "unchecked";
  /** The check the answer is based on, or null when there is none. */
  readonly check: ConditionCheck | null;
}

/** The most checks one log may hold. */
export const MAX_CONDITION_CHECKS = 1_000_000;
export const MAX_CHECKER_NAME_LENGTH = 200;
/** How old a check may be, by default, and still say a record is fit to move. */
export const DEFAULT_FIT_TO_MOVE_DAYS = 365;

const RECORDED_AT_SLACK_MS = 5 * 60_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;
const DAY_MS = 86_400_000;

const CHECK_LIMITS = {
  maxDepth: 1,
  maxValues: 30,
  maxStringLength: MAX_STORAGE_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 4000,
} as const;

const CHECK_KEYS = [
  "id",
  "organizationId",
  "recordId",
  "checkedOn",
  "checkedBy",
  "checkerId",
  "condition",
  "reason",
  "fitToMove",
  "loanId",
  "note",
  "recordedAt",
] as const;

/** Make a new random condition check ID. */
export function newConditionCheckId(): ConditionCheckId {
  return randomUUID() as ConditionCheckId;
}

/** True if `value` is a well-formed condition check ID (lowercase version 4 UUID). */
export function isConditionCheckId(value: unknown): value is ConditionCheckId {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Check one condition check from untrusted input. Returns a fresh, frozen
 * copy, or every problem found. Never throws.
 */
export function validateConditionCheck(input: unknown): Validated<ConditionCheck> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A condition check must be a plain object.", CHECK_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, CHECK_KEYS, "a condition check", issues);
    if (!isConditionCheckId(d.id)) {
      issues.add(["id"], "invalid_id", "The check ID must be a lowercase version 4 UUID.");
    }
    if (!isOrganizationId(d.organizationId)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "Every condition check belongs to one organization: organizationId must be an organization ID.",
      );
    }
    if (!isRecordId(d.recordId)) {
      issues.add(["recordId"], "invalid_id", "recordId must be a record ID.");
    }
    if (d.checkerId !== undefined && !isRecordId(d.checkerId)) {
      issues.add(["checkerId"], "invalid_id", "checkerId must be a record ID.");
    }
    if (d.loanId !== undefined && !(typeof d.loanId === "string" && UUID_V4.test(d.loanId))) {
      issues.add(["loanId"], "invalid_id", "loanId must be a loan ID.");
    }
    checkName(d.checkedBy, issues);
    if (!(CONDITIONS as readonly unknown[]).includes(d.condition)) {
      issues.add(
        ["condition"],
        "invalid_condition",
        `Condition must be one of: ${CONDITIONS.join(", ")}.`,
      );
    }
    if (!(CONDITION_CHECK_REASONS as readonly unknown[]).includes(d.reason)) {
      issues.add(
        ["reason"],
        "invalid_reason",
        `Reason must be one of: ${CONDITION_CHECK_REASONS.join(", ")}.`,
      );
    }
    if (d.fitToMove !== undefined && typeof d.fitToMove !== "boolean") {
      issues.add(["fitToMove"], "invalid_fit", "fitToMove is true or false, or left out.");
    }
    const checkedOn = d.checkedOn;
    if (!isIsoDay(checkedOn)) {
      issues.add(["checkedOn"], "invalid_date", "checkedOn must be a day written YYYY-MM-DD.");
    }
    const recorded = parseUtc(d.recordedAt);
    if (recorded === undefined) {
      issues.add(
        ["recordedAt"],
        "invalid_timestamp",
        "recordedAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
      );
    } else if (isIsoDay(checkedOn) && checkedOn > dayAfter(recorded)) {
      issues.add(
        ["checkedOn"],
        "future_check",
        "A check can't be dated after the day it was written down. Record it when it is made.",
      );
    }
    checkNote(d.note, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as ConditionCheck };
  }, "This condition check could not be read as plain data.");
}

/**
 * Make a new condition check with a fresh ID, recorded now, then validate
 * it. `now` is for tests; it defaults to the current time.
 */
export function createConditionCheck(
  input: Omit<ConditionCheck, "id" | "recordedAt">,
  now: Date = new Date(),
): Validated<ConditionCheck> {
  const time = timeOf(now);
  if (time === undefined) {
    return refused([], "invalid_time", "The time the check was recorded is not a valid date.");
  }
  try {
    if (types.isProxy(input) || !isPlainObject(input)) {
      return refused([], "not_an_object", "A condition check must be a plain object.");
    }
    const issues = new IssueList();
    const copy = readPlainData(input, [], CHECK_LIMITS, issues);
    if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
    return validateConditionCheck({
      ...copy,
      id: newConditionCheckId(),
      recordedAt: new Date(time).toISOString(),
    });
  } catch {
    return refused([], "unreadable", "This condition check could not be read as plain data.");
  }
}

interface LogData {
  readonly organizationId: OrganizationId;
  readonly ids: ReadonlySet<ConditionCheckId>;
  /** Each record's checks, oldest first. */
  readonly byRecord: ReadonlyMap<RecordId, readonly ConditionCheck[]>;
  readonly size: number;
}

const CONDITION_LOGS = new WeakMap<object, LogData>();

/**
 * Validate one organization's condition checks once and index them by
 * record. `organizationId` names whose log it is (an empty log must still
 * belong to someone); every check must name the same one, or the whole log
 * is refused (`mixed_organizations`). Refuses invalid checks and duplicate
 * IDs. Never throws.
 */
export function indexConditionChecks(
  organizationId: unknown,
  checks: unknown,
): Validated<ConditionLog> {
  try {
    if (!isOrganizationId(organizationId)) {
      return refused(
        ["organizationId"],
        "invalid_organization",
        "A condition log belongs to one organization: give its organization ID.",
      );
    }
    const list = readList(checks, MAX_CONDITION_CHECKS, "condition checks");
    if (!list.ok) return list;
    const issues = new IssueList();
    const valid: { check: ConditionCheck; at: number }[] = [];
    list.value.forEach((given, i) => {
      if (issues.full) return;
      const checked = validateConditionCheck(given);
      if (!checked.ok) {
        for (const found of checked.issues)
          issues.add([i, ...found.path], found.code, found.message);
      } else {
        valid.push({ check: checked.value, at: i });
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    if (valid.some(({ check }) => check.organizationId !== organizationId)) {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These condition checks")] };
    }
    const ids = new Set<ConditionCheckId>();
    const byRecord = new Map<RecordId, ConditionCheck[]>();
    for (const { check, at } of valid) {
      if (ids.has(check.id)) {
        issues.add([at, "id"], "duplicate_id", "Two condition checks have the same ID.");
        continue;
      }
      ids.add(check.id);
      const mine = byRecord.get(check.recordId) ?? [];
      mine.push(check);
      byRecord.set(check.recordId, mine);
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    const sorted = new Map<RecordId, readonly ConditionCheck[]>();
    for (const [recordId, mine] of byRecord) sorted.set(recordId, Object.freeze(mine.sort(byWhen)));
    return { ok: true, value: makeLog({ organizationId, ids, byRecord: sorted, size: ids.size }) };
  } catch {
    return refused([], "unreadable", "The condition checks could not be read as plain data.");
  }
}

/** True if `value` is a log made by `indexConditionChecks` or `withConditionCheck`. */
export function isConditionLog(value: unknown): value is ConditionLog {
  return typeof value === "object" && value !== null && CONDITION_LOGS.has(value);
}

/**
 * Check a new condition check against a log before saving it, and return
 * the log with it added. Its `recordedAt` can't be later than `now` (a few
 * minutes of clock slack), since checks on one day are ordered by it and a
 * check stamped in the future would stay "latest" for ever: make new checks
 * with `createConditionCheck`. A check naming a `loanId` needs `loans`, the
 * organization's loan book (`loans_unknown`; anything else
 * `not_a_loan_book`, another organization's `mixed_organizations`): the
 * loan must be in it (`unknown_loan`) and list the record (`not_on_loan`).
 * The given log is not changed. `now` is for tests. Never throws.
 */
export function withConditionCheck(
  log: ConditionLog,
  check: unknown,
  now: Date = new Date(),
  loans?: object,
): Validated<ConditionLog> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    const checked = validateConditionCheck(check);
    if (!checked.ok) return checked;
    const next = checked.value;
    const time = timeOf(now);
    if (time === undefined)
      return refused([], "invalid_time", "The current time is not a valid date.");
    if (Date.parse(next.recordedAt) > time + RECORDED_AT_SLACK_MS) {
      return refused(
        ["recordedAt"],
        "future_recorded",
        "This check says it was written down later than now. Make new checks with createConditionCheck.",
      );
    }
    if (next.organizationId !== data.organizationId) {
      return {
        ok: false,
        issues: [mixedOrganizationsIssue([], "This condition check and the condition log")],
      };
    }
    if (data.ids.has(next.id)) {
      return refused(["id"], "duplicate_id", "A check with this ID is already in the log.");
    }
    if (next.loanId !== undefined) {
      if (loans === undefined) {
        return refused(
          ["loanId"],
          "loans_unknown",
          "A check made for a loan is checked against the loan book: give it.",
        );
      }
      const facts = factsFor(loans, data.organizationId);
      if (!facts.ok) return facts;
      const code = loanLinkProblem(facts.value, next);
      if (code !== undefined) return refused(["loanId"], code, LOAN_LINK_MESSAGES[code]);
    }
    if (data.size >= MAX_CONDITION_CHECKS) {
      return refused(
        [],
        "too_many",
        `A log can hold at most ${String(MAX_CONDITION_CHECKS)} condition checks.`,
      );
    }
    const byRecord = new Map(data.byRecord);
    byRecord.set(
      next.recordId,
      Object.freeze([...(data.byRecord.get(next.recordId) ?? []), next].sort(byWhen)),
    );
    const ids = new Set(data.ids);
    ids.add(next.id);
    return {
      ok: true,
      value: makeLog({ organizationId: data.organizationId, ids, byRecord, size: data.size + 1 }),
    };
  } catch {
    return refused([], "unreadable", "The condition check could not be read as plain data.");
  }
}

/** One record's condition checks, oldest first (empty when it was never checked). */
export function conditionHistory(
  log: ConditionLog,
  recordId: unknown,
): Validated<readonly ConditionCheck[]> {
  const data = logData(log);
  if (data === undefined) return notALog();
  const found = isRecordId(recordId) ? data.byRecord.get(recordId) : undefined;
  return { ok: true, value: found ?? Object.freeze([]) };
}

/**
 * A record's latest condition check, or null when it was never checked.
 * With `on` (`YYYY-MM-DD`), the latest check made on or before that day.
 */
export function latestCondition(
  log: ConditionLog,
  recordId: unknown,
  options: { readonly on?: unknown } = {},
): Validated<ConditionCheck | null> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    const on = readOption(options, "on");
    if (on !== undefined && !isIsoDay(on)) {
      return refused(["on"], "invalid_date", "on must be a day written YYYY-MM-DD.");
    }
    return { ok: true, value: latestOf(data, recordId, on) };
  } catch {
    return refused([], "unreadable", "The options could not be read.");
  }
}

/**
 * Whether a record may be moved on a day (`on`, `YYYY-MM-DD`, the
 * organization's own date), going by its latest condition check made on or
 * before that day: Spectrum asks for a check before an object is lent,
 * displayed or moved at risk. Not fit when there is no check, when the
 * latest is older than `maxAgeDays` (default `DEFAULT_FIT_TO_MOVE_DAYS`), or
 * when it says it can't move (its `fitToMove`, or `needs_conservation`).
 * Call it before recording a `loan_out` or `exhibition` move. Never throws.
 */
export function fitToMove(
  log: ConditionLog,
  recordId: unknown,
  options: { readonly on: unknown; readonly maxAgeDays?: unknown },
): Validated<FitToMove> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    if (!isRecordId(recordId)) return refused([], "invalid_id", "recordId must be a record ID.");
    const on = readOption(options, "on");
    if (!isIsoDay(on))
      return refused(["on"], "invalid_date", "on must be a day written YYYY-MM-DD.");
    const givenAge = readOption(options, "maxAgeDays");
    const maxAge = givenAge ?? DEFAULT_FIT_TO_MOVE_DAYS;
    if (!isAge(maxAge)) return badAge();
    const check = latestOf(data, recordId, on);
    const answer = (because: FitToMove["because"]): Validated<FitToMove> => ({
      ok: true,
      value: Object.freeze({ recordId, fit: because === "fit", because, check }),
    });
    if (check === null) return answer("unchecked");
    if ((Date.parse(on) - Date.parse(check.checkedOn)) / DAY_MS > maxAge) return answer("stale");
    return answer(canMove(check) ? "fit" : "unfit");
  } catch {
    return refused([], "unreadable", "The options could not be read.");
  }
}

/**
 * The checks in the log whose `loanId` doesn't fit `loans`, the
 * organization's loan book: no such loan (`unknown_loan`), or a loan that
 * doesn't list the checked record (`not_on_loan`). Oldest first. Refuses
 * anything but a loan book of the log's organization. Never throws.
 */
export function conditionLoanProblems(
  log: ConditionLog,
  loans: unknown,
): Validated<readonly ConditionLoanProblem[]> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    const facts = factsFor(loans, data.organizationId);
    if (!facts.ok) return facts;
    const found: { check: ConditionCheck; problem: ConditionLoanProblem }[] = [];
    for (const history of data.byRecord.values()) {
      for (const check of history) {
        const code = loanLinkProblem(facts.value, check);
        if (check.loanId === undefined || code === undefined) continue;
        found.push({
          check,
          problem: Object.freeze({
            checkId: check.id,
            recordId: check.recordId,
            loanId: check.loanId,
            code,
          }),
        });
      }
    }
    found.sort((a, b) => byWhen(a.check, b.check));
    return { ok: true, value: Object.freeze(found.map((f) => f.problem)) };
  } catch {
    return refused([], "unreadable", "The condition checks could not be checked.");
  }
}

/**
 * The items of loans out that went, or are to go, without a recent
 * fit-to-move check (Spectrum: check condition before an object is lent).
 * Every `agreed` loan out in `loans` is looked at: an item that went out is
 * judged by `fitToMove` on the day of its linked `loan_out`; one not yet
 * sent, on `today` (`YYYY-MM-DD`, the organization's own date). Listed when
 * the answer isn't `fit`. `maxAgeDays` is required: how recent a check must
 * be is the organization's rule, not this module's. By loan, in the book's
 * order, then by item. Never throws.
 */
export function loansOutWithoutFitCheck(
  log: ConditionLog,
  loans: unknown,
  options: { readonly today: unknown; readonly maxAgeDays: unknown },
): Validated<readonly LoanFitWarning[]> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    const facts = factsFor(loans, data.organizationId);
    if (!facts.ok) return facts;
    const today = readOption(options, "today");
    if (!isIsoDay(today)) {
      return refused(["today"], "invalid_date", "today must be a day written YYYY-MM-DD.");
    }
    const maxAge = readOption(options, "maxAgeDays");
    if (maxAge === undefined) {
      return refused(
        ["maxAgeDays"],
        "required",
        "Say how many days old a fit-to-move check may be: maxAgeDays.",
      );
    }
    if (!isAge(maxAge)) return badAge();
    const found: LoanFitWarning[] = [];
    for (const loan of facts.value.loans) {
      if (loan.direction !== "out" || loan.status !== "agreed") continue;
      for (const item of loan.items) {
        const on = item.startedOn ?? today;
        const answer = fitToMove(log, item.recordId, { on, maxAgeDays: maxAge });
        if (!answer.ok) return answer;
        const { because, check } = answer.value;
        if (because === "fit") continue;
        found.push(
          Object.freeze({
            loanId: loan.id,
            recordId: item.recordId,
            sent: item.startedOn !== null,
            on,
            because,
            check,
          }),
        );
      }
    }
    return { ok: true, value: Object.freeze(found) };
  } catch {
    return refused([], "unreadable", "The options could not be read.");
  }
}

/**
 * Every record whose latest check found it `needs_conservation` (mockup
 * Preservation), oldest check first, so the longest waiting come first.
 */
export function needingConservation(log: ConditionLog): Validated<readonly ConditionCheck[]> {
  const data = logData(log);
  if (data === undefined) return notALog();
  const found: ConditionCheck[] = [];
  for (const history of data.byRecord.values()) {
    const last = history[history.length - 1];
    if (last?.condition === "needs_conservation") found.push(last);
  }
  return { ok: true, value: Object.freeze(found.sort(byWhen)) };
}

// ---------------------------------------------------------------------------
// Helpers

function isAge(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 36_500;
}

function badAge(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return refused(
    ["maxAgeDays"],
    "invalid_age",
    "maxAgeDays must be a whole number of days from 0 to 36500.",
  );
}

const LOAN_LINK_MESSAGES = {
  unknown_loan: "There is no such loan in the loan book.",
  not_on_loan: "This loan doesn't list the checked record.",
} as const;

/** The loan book's facts, checked: a book of `organizationId`. */
function factsFor(loans: unknown, organizationId: OrganizationId): Validated<LoanFacts> {
  const facts = types.isProxy(loans) ? undefined : loanFactsOf(loans);
  if (facts === undefined) {
    return refused(
      ["loans"],
      "not_a_loan_book",
      "Give the loan book made by indexLoans or withLoan.",
    );
  }
  if (facts.organizationId !== organizationId) {
    return {
      ok: false,
      issues: [mixedOrganizationsIssue([], "This loan book and the condition log")],
    };
  }
  return { ok: true, value: facts };
}

/** What is wrong with a check's `loanId` against the book, or undefined. */
function loanLinkProblem(
  facts: LoanFacts,
  check: ConditionCheck,
): ConditionLoanProblem["code"] | undefined {
  if (check.loanId === undefined) return undefined;
  const loan = facts.loan(check.loanId);
  if (loan === undefined) return "unknown_loan";
  return loan.items.some((item) => item.recordId === check.recordId) ? undefined : "not_on_loan";
}

/** True when a check says the record can be moved. */
function canMove(check: ConditionCheck): boolean {
  return check.fitToMove ?? check.condition !== "needs_conservation";
}

function latestOf(data: LogData, recordId: unknown, on: string | undefined): ConditionCheck | null {
  if (!isRecordId(recordId)) return null;
  const history = data.byRecord.get(recordId) ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const check = history[i];
    if (check !== undefined && (on === undefined || check.checkedOn <= on)) return check;
  }
  return null;
}

/** Read one option as an own data property: no getters, no Proxies, nothing inherited. */
function readOption(options: unknown, key: string): unknown {
  if (typeof options !== "object" || options === null || types.isProxy(options)) {
    throw new TypeError("unreadable options");
  }
  const slot = Object.getOwnPropertyDescriptor(options, key);
  if (slot === undefined) return undefined;
  if (!("value" in slot)) throw new TypeError("unreadable options");
  return slot.value as unknown;
}

function checkName(value: JsonValue | undefined, issues: IssueList): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(["checkedBy"], "required", "Say who checked it.");
    return;
  }
  if (value !== value.trim()) {
    issues.add(["checkedBy"], "untrimmed", "The checker's name starts or ends with spaces.");
  }
  if (value.length > MAX_CHECKER_NAME_LENGTH) {
    issues.add(
      ["checkedBy"],
      "too_long",
      `The checker's name can be at most ${String(MAX_CHECKER_NAME_LENGTH)} characters.`,
    );
  }
  if (ONE_LINE_BREAKS.test(value)) {
    issues.add(
      ["checkedBy"],
      "control_characters",
      "The checker's name must be one line, with no tabs or line breaks.",
    );
  }
}

function timeOf(now: unknown): number | undefined {
  try {
    const time = Date.prototype.getTime.call(now);
    return Number.isNaN(time) ? undefined : time;
  } catch {
    return undefined;
  }
}

function makeLog(data: LogData): ConditionLog {
  const log: ConditionLog = Object.freeze({
    organizationId: data.organizationId,
    size: data.size,
    records: data.byRecord.size,
  });
  CONDITION_LOGS.set(log, data);
  return log;
}

function logData(log: unknown): LogData | undefined {
  return typeof log === "object" && log !== null ? CONDITION_LOGS.get(log) : undefined;
}

/** Oldest first: by day checked, then by when it was written down, then by ID. */
function byWhen(a: ConditionCheck, b: ConditionCheck): number {
  if (a.checkedOn !== b.checkedOn) return a.checkedOn < b.checkedOn ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function notALog(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return {
    ok: false,
    issues: [
      issue(
        [],
        "not_a_condition_log",
        "Give the condition log made by indexConditionChecks or withConditionCheck.",
      ),
    ],
  };
}
