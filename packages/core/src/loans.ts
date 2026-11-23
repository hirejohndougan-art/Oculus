/**
 * Loans in and loans out (Spectrum "Loans in (borrowing objects)" and
 * "Loans out (lending objects)"; decision D-044).
 *
 * A loan is one agreement with one lender or borrower (an agent record) for
 * a fixed period: a reference number, begin and end dates, a status, and the
 * records it covers. Spectrum: "All loans are for fixed periods", so the end
 * date is required; an extension is an edit of it.
 *
 * **Where things are stays in the move log** (storage.ts, D-040), never on
 * the loan, so the two can't disagree:
 * - A **loan out** item points at its `loan_out` move, which goes to an
 *   outside location whose `agentId` is the borrower, and, once it is back,
 *   at the `return` move home. Make the `loan_out` move with `loanOutMove`,
 *   so its `expectedReturnOn` is the loan's end date and the record shows in
 *   `overdueReturns` when it is late. An extension is recorded as another
 *   `loan_out` move to the same borrower with the new date.
 * - A **loan in** item points at the `placement` move that housed the
 *   borrowed record on arrival, and, once it has gone back, at its
 *   `departure` move to an outside location whose `agentId` is the lender.
 *
 * The loan's `status` is the agreement's state (Spectrum's loan status):
 * `requested`, `agreed`, `declined`, `cancelled` or `closed`. Whether items
 * are out or back is worked out from the moves (`loanState`'s `phase`). An
 * item can't have moved before the loan was agreed, a linked `loan_out` or
 * arrival must fall within the loan period, and a loan can't be closed while
 * an item is still out. A loan the move log no longer fits (a return
 * back-dated by a later storage edit) is kept with its `problems` rather than
 * making the whole book unreadable; `withLoan` never saves one. Departures
 * no loan in names are listed by `unexplainedDepartures`.
 *
 * **Everything here is staff-only**, like storage: loans name lenders,
 * borrowers, values and dates. Nothing in `effective.ts` or
 * `public-output.ts` reads it, and a test checks no module but `index.ts`
 * imports it. `indexLoans` validates one organization's loans once, against
 * its move log, into a frozen, opaque snapshot (recognised by a WeakMap,
 * never by shape) that the queries read; check an edit with `withLoan`, and
 * re-check the loans with `reindexLoans` after the move log changes. Every
 * loan carries a required `organizationId`, and loans of another
 * organization than the move log are refused (D-030). A loan's `agentId` and
 * items' `recordId`s are only checked for being IDs: the service layer
 * (T-032) checks they are the same organization's records. Nothing here
 * throws on bad input.
 */
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { isOrganizationId, mixedOrganizationsIssue, type OrganizationId } from "./organizations.js";
import { IssueList, shown, type JsonValue } from "./plain-data.js";
import { isRecordId, type RecordId } from "./record-id.js";
import {
  MAX_STORAGE_NOTE_LENGTH,
  dayAfter,
  departures,
  fold,
  guarded,
  isIsoDay,
  isLocationId,
  isMoveId,
  isMoveLog,
  logLocation,
  moveHistory,
  readList,
  readTop,
  refused,
  unknownKeys,
  whereabouts,
  type MoveId,
  type MoveLog,
  type StorageMove,
} from "./storage.js";

declare const loanIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one loan forever. */
export type LoanId = string & { readonly [loanIdBrand]: true };

/** `in`: borrowed from a lender. `out`: lent to a borrower. */
export const LOAN_DIRECTIONS = ["in", "out"] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

/**
 * The agreement's state. Spectrum's loan status starts at `requested`; a
 * request is `agreed` (signed) or `declined`; an agreed loan can be
 * `cancelled` before anything moves; `closed` once everything is back and
 * every condition of the loan is met.
 */
export const LOAN_STATUSES = ["requested", "agreed", "declined", "cancelled", "closed"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** Statuses under which nothing may have moved yet. */
const NOT_AGREED: readonly LoanStatus[] = ["requested", "declined", "cancelled"];

/** One record on a loan out. */
export interface LoanOutItem {
  readonly recordId: RecordId;
  /** The `loan_out` move that sent it to the borrower. */
  readonly loanOutMoveId?: MoveId;
  /** The `return` move that brought it home. Only after `loanOutMoveId`. */
  readonly returnMoveId?: MoveId;
}

/** One record on a loan in. */
export interface LoanInItem {
  readonly recordId: RecordId;
  /** The `placement` move that housed it when it arrived. */
  readonly arrivalMoveId?: MoveId;
  /** The `departure` move that sent it back to the lender. Only after `arrivalMoveId`. */
  readonly departureMoveId?: MoveId;
}

interface LoanBase {
  readonly id: LoanId;
  readonly organizationId: OrganizationId;
  /** The loan reference number, e.g. "LO-2026-003". Unique among the organization's loans that way. */
  readonly number: string;
  /** The lender (loan in) or borrower (loan out): an agent record. */
  readonly agentId: RecordId;
  /** The first day of the loan period, `YYYY-MM-DD`. */
  readonly beginOn: string;
  /** The last day of the loan period, `YYYY-MM-DD`: when it is due back. */
  readonly endOn: string;
  readonly status: LoanStatus;
  /** The day the status was set, `YYYY-MM-DD`. */
  readonly statusOn: string;
  /** Why: an exhibition, research. One line. */
  readonly purpose?: string;
  /** Special conditions of the loan: insurance, display, environment. */
  readonly terms?: string;
  readonly note?: string;
}

export interface LoanOut extends LoanBase {
  readonly direction: "out";
  readonly items: readonly LoanOutItem[];
}

export interface LoanIn extends LoanBase {
  readonly direction: "in";
  readonly items: readonly LoanInItem[];
}

export type Loan = LoanIn | LoanOut;

/** A validated, frozen snapshot of one organization's loans. Opaque. */
export interface LoanBook {
  readonly organizationId: OrganizationId;
  readonly size: number;
}

/**
 * Where a loan stands. The agreement's `status` where it says everything
 * (`requested`, `declined`, `cancelled`, `closed`); for an agreed loan,
 * `on_loan` while any item is out (lent and not back, or borrowed and not
 * gone back), `returned` when every item that moved is back, `agreed` before
 * anything moved.
 */
export type LoanPhase =
  "requested" | "agreed" | "on_loan" | "returned" | "declined" | "cancelled" | "closed";

/** One item of a loan, with its moves. */
export interface LoanItemState {
  readonly recordId: RecordId;
  /** Loan out: the `loan_out` move. Loan in: the arrival `placement`. */
  readonly started: StorageMove | null;
  /** Loan out: the `return` move. Loan in: the `departure`. */
  readonly ended: StorageMove | null;
  /** True between the two. */
  readonly out: boolean;
  /**
   * Loan out, while out: the expected return date the move log holds for
   * it (what `overdueReturns` goes by), or null when none was given.
   */
  readonly dueBack: string | null;
  /**
   * Loan out, while out: false when the move log's date differs from the
   * loan's end date (an extension agreed but not recorded as a move, or a
   * `loan_out` move made by hand). Always true otherwise.
   */
  readonly dueMatchesLoan: boolean;
}

export interface LoanState {
  readonly loan: Loan;
  readonly phase: LoanPhase;
  readonly items: readonly LoanItemState[];
  /**
   * What no longer fits the move log since the loan was saved (a move
   * back-dated into the loan, a linked move outside the loan period …), with
   * paths inside the loan. Empty for a sound loan. `withLoan` never saves a
   * loan with problems; `indexLoans` and `reindexLoans` keep it and report
   * them here, so one stale loan doesn't make every other loan unreadable.
   */
  readonly problems: readonly Issue[];
}

/** One loan's problems, as `loanProblems` lists them. */
export interface LoanProblems {
  readonly loanId: LoanId;
  readonly problems: readonly Issue[];
}

export const MAX_LOANS = 50_000;
export const MAX_LOAN_ITEMS = 500;
export const MAX_LOAN_NUMBER_LENGTH = 100;
export const MAX_LOAN_PURPOSE_LENGTH = 200;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

/**
 * Read limits sized from the shape (review fix: 500 full items didn't fit).
 * A full item is one object, three keys and three IDs: at most 7 values and
 * 15 + 13 + 8 key characters plus 3 × 36 ID characters (144). The loan's own
 * keys and values (13 keys, three 2000-character texts) get 40 values and
 * 8000 characters; the items array is one value more.
 */
const ITEM_VALUES = 7;
const ITEM_CHARS = 144;
const LOAN_LIMITS = {
  maxDepth: 3,
  maxValues: 41 + ITEM_VALUES * MAX_LOAN_ITEMS,
  maxStringLength: MAX_STORAGE_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 8000 + ITEM_CHARS * MAX_LOAN_ITEMS,
} as const;

const LOAN_KEYS = [
  "id",
  "organizationId",
  "direction",
  "number",
  "agentId",
  "beginOn",
  "endOn",
  "status",
  "statusOn",
  "purpose",
  "terms",
  "note",
  "items",
] as const;

/** Per direction: the item's start and end move keys. */
const MOVE_KEYS = {
  out: { start: "loanOutMoveId", end: "returnMoveId" },
  in: { start: "arrivalMoveId", end: "departureMoveId" },
} as const;

/** Make a new random loan ID. */
export function newLoanId(): LoanId {
  return randomUUID() as LoanId;
}

/** True if `value` is a well-formed loan ID (lowercase version 4 UUID). */
export function isLoanId(value: unknown): value is LoanId {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Check one loan from untrusted input, on its own (its moves are checked
 * against the move log by `indexLoans`). `statusOn` can't be later than the
 * day after `now` (a day of slack for time zones, as for moves). Returns a
 * fresh, frozen copy, or every problem found. `now` is for tests. Never
 * throws.
 */
export function validateLoan(input: unknown, now: Date = new Date()): Validated<Loan> {
  const time = timeOf(now);
  if (time === undefined) {
    return refused([], "invalid_time", "The current time is not a valid date.");
  }
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A loan must be a plain object.", LOAN_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, LOAN_KEYS, "a loan", issues);
    if (!isLoanId(d.id)) {
      issues.add(["id"], "invalid_id", "The loan ID must be a lowercase version 4 UUID.");
    }
    if (!isOrganizationId(d.organizationId)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "Every loan belongs to one organization: organizationId must be an organization ID.",
      );
    }
    const direction = d.direction;
    const knownDirection = direction === "in" || direction === "out";
    if (!knownDirection) {
      issues.add(["direction"], "invalid_direction", 'direction must be "in" or "out".');
    }
    checkLine(d.number, ["number"], "loan number", MAX_LOAN_NUMBER_LENGTH, true, issues);
    if (!isRecordId(d.agentId)) {
      issues.add(
        ["agentId"],
        "invalid_id",
        "agentId must be the record ID of the lender or borrower.",
      );
    }
    for (const key of ["beginOn", "endOn", "statusOn"] as const) {
      if (!isIsoDay(d[key])) {
        issues.add([key], "invalid_date", `${key} must be a day written YYYY-MM-DD.`);
      }
    }
    if (isIsoDay(d.statusOn) && d.statusOn > dayAfter(time)) {
      issues.add(
        ["statusOn"],
        "future_status",
        "The status can't be dated after today. Set it when it happens.",
      );
    }
    if (isIsoDay(d.beginOn) && isIsoDay(d.endOn) && d.endOn < d.beginOn) {
      issues.add(["endOn"], "end_before_begin", "The loan ends before it begins.");
    }
    const status = d.status;
    const knownStatus = (LOAN_STATUSES as readonly unknown[]).includes(status);
    if (!knownStatus) {
      issues.add(
        ["status"],
        "invalid_status",
        `status must be one of: ${LOAN_STATUSES.join(", ")}.`,
      );
    }
    checkLine(d.purpose, ["purpose"], "purpose", MAX_LOAN_PURPOSE_LENGTH, false, issues);
    checkText(d.terms, ["terms"], "The terms", issues);
    checkText(d.note, ["note"], "A note", issues);
    if (knownDirection) {
      checkItems(d.items, direction, knownStatus ? (status as LoanStatus) : undefined, issues);
    } else if (!Array.isArray(d.items)) {
      issues.add(["items"], "required", "A loan lists at least one item.");
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as Loan };
  }, "This loan could not be read as plain data.");
}

interface ItemData {
  readonly recordId: RecordId;
  readonly started: StorageMove | null;
  readonly ended: StorageMove | null;
}

interface BookData {
  readonly log: MoveLog;
  readonly organizationId: OrganizationId;
  /** Loans in the order given. */
  readonly loans: readonly Loan[];
  readonly byId: ReadonlyMap<LoanId, Entry>;
  readonly byRecord: ReadonlyMap<RecordId, readonly LoanId[]>;
  /** Departure moves in the log that no loan in names. */
  readonly unexplained: readonly StorageMove[];
}

interface Entry {
  readonly loan: Loan;
  readonly items: readonly ItemData[];
  readonly problems: readonly Issue[];
}

const LOAN_BOOKS = new WeakMap<object, BookData>();

/**
 * Validate one organization's loans once, against its move log, and index
 * them. Refuses the whole list when a loan is invalid, two share an ID or a
 * number (loans in and out are numbered apart), or a loan belongs to another
 * organization than the log (`mixed_organizations`).
 *
 * A loan whose links to the move log don't fit is kept, with its problems in
 * `loanState(...).problems` and `loanProblems`, rather than refused with
 * every other loan: one valid storage move (a return back-dated between a
 * linked `loan_out` and its linked return) can make a saved loan stale, and
 * that must not make the whole book unreadable. `withLoan` refuses to save a
 * loan with any of these problems. An item's move:
 * - isn't in the log for that record (`unknown_move`), or is named by two
 *   items (`move_reused`, on the later loan);
 * - starts outside the loan period: a `loan_out` or arrival before `beginOn`
 *   or after `endOn` (`move_outside_loan`);
 * - has the wrong reason (`wrong_move_reason`: `loan_out` and `return` for a
 *   loan out, `placement` and `departure` for a loan in);
 * - goes somewhere other than an outside location of the borrower or lender
 *   (`not_agent_location`);
 * - ends before it started, or isn't the record's first return (or
 *   departure) after it started (`end_out_of_order`);
 * - overlaps another loan of the same record the same way
 *   (`overlapping_loans`, on the later loan): a record is lent to one
 *   borrower at a time.
 * `now` is for tests. Never throws.
 */
export function indexLoans(
  log: MoveLog,
  loans: unknown,
  now: Date = new Date(),
): Validated<LoanBook> {
  try {
    if (!isMoveLog(log)) return notALog();
    const list = readList(loans, MAX_LOANS, "loans");
    if (!list.ok) return list;
    const issues = new IssueList();
    const valid: Loan[] = [];
    list.value.forEach((given, i) => {
      if (issues.full) return;
      const checked = validateLoan(given, now);
      if (!checked.ok) {
        for (const found of checked.issues)
          issues.add([i, ...found.path], found.code, found.message);
      } else {
        valid.push(checked.value);
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return buildBook(log, valid);
  } catch {
    return refused([], "unreadable", "The loans could not be read as plain data.");
  }
}

/** True if `value` is a book made by `indexLoans`, `withLoan` or `reindexLoans`. */
export function isLoanBook(value: unknown): value is LoanBook {
  return typeof value === "object" && value !== null && LOAN_BOOKS.has(value);
}

/**
 * Check a new or edited loan (same `id`: a status change, an extension, an
 * item sent or returned) against the book and its move log before saving
 * it, and return the book with it in place. A loan can't change direction,
 * and is refused with any problem `indexLoans` would report for it (other
 * loans' problems don't block it). The given book is not changed. `now` is
 * for tests. Never throws.
 */
export function withLoan(
  book: LoanBook,
  loan: unknown,
  now: Date = new Date(),
): Validated<LoanBook> {
  try {
    const data = bookData(book);
    if (data === undefined) return notABook();
    const checked = validateLoan(loan, now);
    if (!checked.ok) return checked;
    const next = checked.value;
    const before = data.byId.get(next.id);
    if (before !== undefined && before.loan.direction !== next.direction) {
      return refused(
        ["direction"],
        "direction_changed",
        "A loan in can't become a loan out, or the other way round. Record a new loan.",
      );
    }
    if (before === undefined && data.loans.length >= MAX_LOANS) {
      return refused([], "too_many", `A book can hold at most ${String(MAX_LOANS)} loans.`);
    }
    const loans =
      before === undefined
        ? [...data.loans, next]
        : data.loans.map((l) => (l.id === next.id ? next : l));
    const at = before === undefined ? data.loans.length : data.loans.indexOf(before.loan);
    const built = buildBook(data.log, loans);
    if (!built.ok) {
      // Report the edited loan's problems without its position in the book.
      return {
        ok: false,
        issues: built.issues.map((f) =>
          f.path[0] === at ? issue(f.path.slice(1), f.code, f.message) : f,
        ),
      };
    }
    const problems = bookData(built.value)?.byId.get(next.id)?.problems ?? [];
    return problems.length > 0 ? { ok: false, issues: problems } : built;
  } catch {
    return refused([], "unreadable", "The loan could not be read as plain data.");
  }
}

/**
 * Check every loan again against a new move log (after `withMove` or
 * `reindexLocations`), and return the book built on it. A loan the new log
 * no longer fits is kept with its problems (see `indexLoans`). Never throws.
 */
export function reindexLoans(book: LoanBook, log: MoveLog): Validated<LoanBook> {
  try {
    const data = bookData(book);
    if (data === undefined) return notABook();
    if (!isMoveLog(log)) return notALog();
    return buildBook(log, data.loans);
  } catch {
    return refused([], "unreadable", "The loans could not be checked.");
  }
}

/** Every loan in the book, in the order given. */
export function loanList(book: LoanBook): Validated<readonly Loan[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  return { ok: true, value: data.loans };
}

/** One loan, or `undefined`. */
export function loanById(book: LoanBook, id: unknown): Loan | undefined {
  const data = bookData(book);
  return data !== undefined && isLoanId(id) ? data.byId.get(id)?.loan : undefined;
}

/**
 * A record's loans in and out, as dated entries for its record page: by
 * begin date, then number.
 */
export function loansOfRecord(book: LoanBook, recordId: unknown): Validated<readonly Loan[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  const ids = isRecordId(recordId) ? (data.byRecord.get(recordId) ?? []) : [];
  const found = ids.flatMap((id) => data.byId.get(id)?.loan ?? []);
  return { ok: true, value: Object.freeze(found.sort(byBegin)) };
}

/** Where one loan stands, with each item's moves. */
export function loanState(book: LoanBook, id: unknown): Validated<LoanState> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  const entry = isLoanId(id) ? data.byId.get(id) : undefined;
  if (entry === undefined) return refused([], "unknown_loan", "There is no such loan.");
  return { ok: true, value: stateOf(data, entry) };
}

/** Every loan with problems (see `indexLoans`), in the book's order. */
export function loanProblems(book: LoanBook): Validated<readonly LoanProblems[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  const found: LoanProblems[] = [];
  for (const loan of data.loans) {
    const problems = data.byId.get(loan.id)?.problems ?? [];
    if (problems.length > 0) found.push(Object.freeze({ loanId: loan.id, problems }));
  }
  return { ok: true, value: Object.freeze(found) };
}

/**
 * Departure moves in the move log that no loan in names as an item's
 * `departureMoveId`, oldest first. A departure is how a borrowed record goes
 * back, so one no loan explains is a record that left the organization's
 * care without a reason on file. They are reported, not refused: the move
 * and the loan edit naming it are two saves (T-032 should make them one
 * transaction and check this list is empty afterwards).
 */
export function unexplainedDepartures(book: LoanBook): Validated<readonly StorageMove[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  return { ok: true, value: data.unexplained };
}

/**
 * Every loan with an item still out after its end date, `today`
 * (`YYYY-MM-DD`, the organization's own date) being later: lent items not
 * back, and borrowed items not yet gone back to their lender. Longest
 * overdue first.
 */
export function overdueLoans(book: LoanBook, today: unknown): Validated<readonly LoanState[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  if (!isIsoDay(today))
    return refused([], "invalid_date", "Today must be a day written YYYY-MM-DD.");
  const found: LoanState[] = [];
  for (const entry of data.byId.values()) {
    if (entry.loan.endOn >= today) continue;
    const state = stateOf(data, entry);
    if (state.phase === "on_loan") found.push(state);
  }
  return {
    ok: true,
    value: Object.freeze(found.sort((a, b) => byEnd(a.loan, b.loan))),
  };
}

/**
 * The move to record when one item of a loan out leaves for the borrower:
 * a `loan_out` move to `locationId` (an outside location of the borrower)
 * with the loan's end date as its expected return date. Pass it to
 * `createStorageMove`, add it with `withMove`, then save the loan with the
 * new move's ID as the item's `loanOutMoveId`. Also for an extension: the
 * same location, the new end date. Never throws.
 */
export function loanOutMove(
  loan: unknown,
  recordId: unknown,
  locationId: unknown,
  movedOn: unknown,
): Validated<Omit<StorageMove, "id" | "recordedAt">> {
  try {
    const checked = validateLoan(loan);
    if (!checked.ok) return checked;
    const l = checked.value;
    if (l.direction !== "out") {
      return refused(["direction"], "not_a_loan_out", "Only a loan out sends items to a borrower.");
    }
    if (NOT_AGREED.includes(l.status) || l.status === "closed") {
      return refused(["status"], "not_agreed", `A ${l.status} loan sends nothing out.`);
    }
    if (!isRecordId(recordId) || !l.items.some((item) => item.recordId === recordId)) {
      return refused(["recordId"], "not_on_loan", "This record isn't one of the loan's items.");
    }
    if (!isLocationId(locationId)) {
      return refused(["locationId"], "invalid_id", "locationId must be a location ID.");
    }
    if (!isIsoDay(movedOn)) {
      return refused(["movedOn"], "invalid_date", "movedOn must be a day written YYYY-MM-DD.");
    }
    if (movedOn < l.beginOn) {
      return refused(
        ["movedOn"],
        "before_loan_begin",
        "The loan period hasn't begun on that day; change the loan's begin date first.",
      );
    }
    if (l.endOn < movedOn) {
      return refused(
        ["movedOn"],
        "after_loan_end",
        "The loan period has ended; extend the loan's end date first.",
      );
    }
    const due = l.endOn;
    return {
      ok: true,
      value: Object.freeze({
        organizationId: l.organizationId,
        recordId,
        locationId: locationId,
        movedOn,
        reason: "loan_out" as const,
        expectedReturnOn: due,
        note: `Loan ${l.number}`,
      }),
    };
  } catch {
    return refused([], "unreadable", "This loan could not be read as plain data.");
  }
}

// ---------------------------------------------------------------------------
// Helpers

function buildBook(log: MoveLog, loans: readonly Loan[]): Validated<LoanBook> {
  /** Problems that refuse the whole book. */
  const issues = new IssueList();
  /** Per loan: link problems, paths inside the loan. */
  const linkProblems = new Map<LoanId, Issue[]>();
  const flag = (
    loanId: LoanId,
    path: readonly (string | number)[],
    code: string,
    message: string,
  ): void => {
    const mine = linkProblems.get(loanId) ?? [];
    if (mine.length < 50) mine.push(issue(path, code, message));
    linkProblems.set(loanId, mine);
  };
  const organizationId = log.organizationId;
  if (loans.some((l) => l.organizationId !== organizationId)) {
    return { ok: false, issues: [mixedOrganizationsIssue([], "These loans and the move log")] };
  }
  const byId = new Map<LoanId, { loan: Loan; items: readonly ItemData[] }>();
  const named = new Set<MoveId>();
  const numbers = new Set<string>();
  const usedMoves = new Set<MoveId>();
  const byRecord = new Map<RecordId, LoanId[]>();
  /** Per record and direction: [start index, end index or Infinity] in its history. */
  const spans = new Map<
    string,
    { start: number; end: number; loanId: LoanId; at: number; j: number }[]
  >();
  loans.forEach((loan, i) => {
    if (issues.full) return;
    if (byId.has(loan.id)) {
      issues.add([i, "id"], "duplicate_id", "Two loans have the same ID.");
      return;
    }
    const numberKey = `${loan.direction} ${fold(loan.number)}`;
    if (numbers.has(numberKey)) {
      issues.add(
        [i, "number"],
        "duplicate_number",
        `Two loans ${loan.direction} have the same number.`,
      );
    }
    numbers.add(numberKey);
    const keys = MOVE_KEYS[loan.direction];
    const items: ItemData[] = [];
    loan.items.forEach((item, j) => {
      const fields = item as unknown as Readonly<Record<string, MoveId | undefined>>;
      const history = moveHistory(log, item.recordId);
      const moves = history.ok ? history.value : [];
      const find = (key: string): { move: StorageMove; index: number } | null | undefined => {
        const id = fields[key];
        if (id === undefined) return null;
        named.add(id);
        if (usedMoves.has(id)) {
          flag(
            loan.id,
            ["items", j, key],
            "move_reused",
            "Another loan item already names this move.",
          );
          return undefined;
        }
        usedMoves.add(id);
        const index = moves.findIndex((m) => m.id === id);
        const move = moves[index];
        if (move === undefined) {
          flag(
            loan.id,
            ["items", j, key],
            "unknown_move",
            "This move isn't in the move log for this record.",
          );
          return undefined;
        }
        return { move, index };
      };
      const start = find(keys.start);
      const end = find(keys.end);
      const startReason = loan.direction === "out" ? "loan_out" : "placement";
      const endReason = loan.direction === "out" ? "return" : "departure";
      if (start && start.move.reason !== startReason) {
        flag(
          loan.id,
          ["items", j, keys.start],
          "wrong_move_reason",
          `${keys.start} must name a ${startReason} move.`,
        );
      }
      if (end && end.move.reason !== endReason) {
        flag(
          loan.id,
          ["items", j, keys.end],
          "wrong_move_reason",
          `${keys.end} must name a ${endReason} move.`,
        );
      }
      // The move that crosses to the agent: out on a loan out, back on a loan in.
      const crossing = loan.direction === "out" ? start : end;
      const crossingKey = loan.direction === "out" ? keys.start : keys.end;
      if (crossing) {
        const place = logLocation(log, crossing.move.locationId);
        if (place?.kind !== "external" || place.agentId !== loan.agentId) {
          flag(
            loan.id,
            ["items", j, crossingKey],
            "not_agent_location",
            loan.direction === "out"
              ? "A loan out goes to an outside location whose agent is the borrower."
              : "A loan in goes back to an outside location whose agent is the lender.",
          );
        }
      }
      if (start && end) {
        const firstEnd = moves.findIndex((m, k) => k > start.index && m.reason === endReason);
        if (end.index <= start.index || firstEnd !== end.index) {
          flag(
            loan.id,
            ["items", j, keys.end],
            "end_out_of_order",
            loan.direction === "out"
              ? "The return must be the record's first return after it went out on this loan."
              : "The departure must be the record's first departure after it arrived on this loan.",
          );
        }
      }
      // The loan period bounds when an item may go out (or arrive); it may
      // come back late, which is what overdue means (review fix).
      if (start && (start.move.movedOn < loan.beginOn || start.move.movedOn > loan.endOn)) {
        flag(
          loan.id,
          ["items", j, keys.start],
          "move_outside_loan",
          loan.direction === "out"
            ? "This item went out outside the loan period."
            : "This item arrived outside the loan period.",
        );
      }
      if (start) {
        const spanKey = `${loan.direction} ${item.recordId}`;
        const list = spans.get(spanKey) ?? [];
        list.push({
          start: start.index,
          end: end ? end.index : Infinity,
          loanId: loan.id,
          at: i,
          j,
        });
        spans.set(spanKey, list);
      }
      items.push(
        Object.freeze({
          recordId: item.recordId,
          started: start ? start.move : null,
          ended: end ? end.move : null,
        }),
      );
      const mine = byRecord.get(item.recordId) ?? [];
      mine.push(loan.id);
      byRecord.set(item.recordId, mine);
    });
    byId.set(loan.id, { loan, items: Object.freeze(items) });
  });
  for (const list of spans.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let k = 1; k < list.length; k += 1) {
      const prev = list[k - 1];
      const span = list[k];
      if (prev !== undefined && span !== undefined && span.start < prev.end) {
        flag(
          span.loanId,
          ["items", span.j],
          "overlapping_loans",
          "This record is still out on another loan.",
        );
      }
    }
  }
  if (issues.count > 0) return { ok: false, issues: issues.items };
  const entries = new Map<LoanId, Entry>();
  for (const [id, { loan, items }] of byId) {
    entries.set(
      id,
      Object.freeze({ loan, items, problems: Object.freeze(linkProblems.get(id) ?? []) }),
    );
  }
  const gone = departures(log);
  const unexplained = Object.freeze(
    (gone.ok ? gone.value : []).filter((move) => !named.has(move.id)),
  );
  const frozenByRecord = new Map<RecordId, readonly LoanId[]>();
  for (const [recordId, ids] of byRecord) frozenByRecord.set(recordId, Object.freeze(ids));
  const book: LoanBook = Object.freeze({ organizationId, size: byId.size });
  LOAN_BOOKS.set(book, {
    log,
    organizationId,
    loans: Object.freeze([...loans]),
    byId: entries,
    byRecord: frozenByRecord,
    unexplained,
  });
  return { ok: true, value: book };
}

function stateOf(data: BookData, entry: Entry): LoanState {
  const { loan, items } = entry;
  const states = items.map((item): LoanItemState => {
    const out = item.started !== null && item.ended === null;
    let dueBack: string | null = null;
    if (out && loan.direction === "out") {
      const where = whereabouts(data.log, item.recordId);
      dueBack = where.ok ? (where.value?.expectedReturnOn ?? null) : null;
    }
    return Object.freeze({
      recordId: item.recordId,
      started: item.started,
      ended: item.ended,
      out,
      dueBack,
      dueMatchesLoan: !(out && loan.direction === "out") || dueBack === loan.endOn,
    });
  });
  let phase: LoanPhase;
  if (loan.status !== "agreed") phase = loan.status;
  else if (states.some((s) => s.out)) phase = "on_loan";
  else if (states.some((s) => s.started !== null)) phase = "returned";
  else phase = "agreed";
  return Object.freeze({ loan, phase, items: Object.freeze(states), problems: entry.problems });
}

function checkItems(
  value: JsonValue | undefined,
  direction: LoanDirection,
  status: LoanStatus | undefined,
  issues: IssueList,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(["items"], "required", "A loan lists at least one item.");
    return;
  }
  if (value.length > MAX_LOAN_ITEMS) {
    issues.add(
      ["items"],
      "too_many",
      `A loan can list at most ${String(MAX_LOAN_ITEMS)} items; record a larger one as several loans.`,
    );
    return;
  }
  const keys = MOVE_KEYS[direction];
  const allowed = ["recordId", keys.start, keys.end];
  const records = new Set<string>();
  const moves = new Set<string>();
  (value as readonly JsonValue[]).forEach((item, j) => {
    if (!isPlainObject(item)) {
      issues.add(["items", j], "not_an_object", "Each loan item is a plain object.");
      return;
    }
    const fields = Object.create(null) as Record<string, JsonValue | undefined>;
    for (const key of Object.keys(item)) fields[key] = item[key];
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) {
        issues.add(
          ["items", j, key],
          "unknown_property",
          `${shown(key)} is not a property of a loan ${direction} item.`,
        );
      }
    }
    const recordId = fields.recordId;
    if (!isRecordId(recordId)) {
      issues.add(["items", j, "recordId"], "invalid_id", "recordId must be a record ID.");
    } else if (records.has(recordId)) {
      issues.add(["items", j, "recordId"], "duplicate_item", "This record is listed twice.");
    } else {
      records.add(recordId);
    }
    const start = fields[keys.start];
    const end = fields[keys.end];
    for (const [key, id] of [
      [keys.start, start],
      [keys.end, end],
    ] as const) {
      if (id === undefined) continue;
      if (!isMoveId(id)) {
        issues.add(["items", j, key], "invalid_id", `${key} must be a move ID.`);
      } else if (moves.has(id)) {
        issues.add(["items", j, key], "move_reused", "Two items of this loan name the same move.");
      } else {
        moves.add(id);
      }
    }
    if (end !== undefined && start === undefined) {
      issues.add(
        ["items", j, keys.end],
        "end_without_start",
        direction === "out"
          ? "An item can't come back before it went out: give loanOutMoveId too."
          : "An item can't go back before it arrived: give arrivalMoveId too.",
      );
    }
    if (status !== undefined && NOT_AGREED.includes(status) && start !== undefined) {
      issues.add(
        ["items", j, keys.start],
        "moved_before_agreed",
        `Nothing moves on a ${status} loan; agree it first.`,
      );
    }
    if (status === "closed" && start !== undefined && end === undefined) {
      issues.add(
        ["items", j],
        "closed_with_items_out",
        "A loan can't be closed while this item is still out.",
      );
    }
  });
}

function checkLine(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  max: number,
  required: boolean,
  issues: IssueList,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(
      path,
      required ? "required" : "invalid_text",
      required ? `Give the ${what}.` : `The ${what} is text; leave it out when there is none.`,
    );
    return;
  }
  if (value !== value.trim()) {
    issues.add(path, "untrimmed", `The ${what} starts or ends with spaces.`);
  }
  if (value.length > max) {
    issues.add(path, "too_long", `The ${what} can be at most ${String(max)} characters.`);
  }
  if (ONE_LINE_BREAKS.test(value)) {
    issues.add(
      path,
      "control_characters",
      `The ${what} must be one line, with no tabs or line breaks.`,
    );
  }
}

function checkText(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  issues: IssueList,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(path, "invalid_text", `${what} is text; leave it out when there is nothing to say.`);
  } else if (value.length > MAX_STORAGE_NOTE_LENGTH) {
    issues.add(
      path,
      "too_long",
      `${what} can be at most ${String(MAX_STORAGE_NOTE_LENGTH)} characters.`,
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

function bookData(book: unknown): BookData | undefined {
  return typeof book === "object" && book !== null && !types.isProxy(book)
    ? LOAN_BOOKS.get(book)
    : undefined;
}

function byBegin(a: Loan, b: Loan): number {
  if (a.beginOn !== b.beginOn) return a.beginOn < b.beginOn ? -1 : 1;
  return a.number.localeCompare(b.number, "en", { numeric: true }) || (a.id < b.id ? -1 : 1);
}

function byEnd(a: Loan, b: Loan): number {
  if (a.endOn !== b.endOn) return a.endOn < b.endOn ? -1 : 1;
  return byBegin(a, b);
}

function notALog(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return refused([], "not_a_move_log", "Give the move log made by indexMoves or withMove.");
}

function notABook(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return refused([], "not_a_loan_book", "Give the loan book made by indexLoans or withLoan.");
}
