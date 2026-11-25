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
 * making the whole book unreadable; its phase is `unknown` and it stays on
 * the overdue list, so a missing or stale link never hides an item still
 * out. `withLoan` never saves a loan with problems, nor an edit that gives
 * another loan one (claiming its move, overlapping it), nor an edit that
 * drops a recorded move link (`link_removed`): a link is changed to the
 * right move, never to nothing, and an item that went out comes off the loan
 * only once it is back. A closed loan out can't leave a record's `loan_out`
 * to its borrower in the loan period unlinked, and a closed loan in needs
 * every item's departure (unless the item never arrived). Departures no loan
 * in names are listed by `unexplainedDepartures`, and `loan_out` moves no
 * loan out names or extends by `unexplainedLoanMoves`.
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
  movesWithReason,
  readList,
  readTop,
  refused,
  unknownKeys,
  whereabouts,
  type MoveId,
  type MoveLog,
  type StorageLocation,
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

/**
 * One record on a loan out. An item is **settled** (nothing more is owed on
 * it) once its `returnMoveId` is linked, or it is marked `notSent`: the only
 * two ways (D-118). An agreed loan past its end date with an item not
 * settled is overdue.
 */
export interface LoanOutItem {
  readonly recordId: RecordId;
  /** The `loan_out` move that sent it to the borrower. */
  readonly loanOutMoveId?: MoveId;
  /** The `return` move that brought it home. Only after `loanOutMoveId`. */
  readonly returnMoveId?: MoveId;
  /**
   * Recorded on purpose: it never went to the borrower (and won't). A
   * problem (`sent_after_all`) while the record is at the borrower's and no
   * other loan out explains it.
   */
  readonly notSent?: true;
}

/**
 * One record on a loan in. It is **settled** once its `departureMoveId` is
 * linked, it is marked `notReceived`, it was kept for good
 * (`keptByAccessionId`: an accession of ours names it), or a later loan in
 * from the same lender `continuesLoanId` this loan for it (a renewal): the
 * only ways (D-118).
 */
export interface LoanInItem {
  readonly recordId: RecordId;
  /** The `placement` move that housed it when it arrived. */
  readonly arrivalMoveId?: MoveId;
  /** The `departure` move that sent it back to the lender. Only after it arrived. */
  readonly departureMoveId?: MoveId;
  /**
   * Recorded on purpose: it never came (and won't). A problem
   * (`received_after_all`) while the record is in our care and no other
   * loan in explains it.
   */
  readonly notReceived?: true;
  /** It stayed for good (bought or given): the accession that names it. Only after it arrived. */
  readonly keptByAccessionId?: string;
  /**
   * A renewal: the earlier loan in, from the same lender, this record was
   * already here on. It counts as arrived on this loan, and settles the
   * earlier loan's item, which needs no link of its own.
   */
  readonly continuesLoanId?: LoanId;
}

/** A value the loan's items are insured or valued at, e.g. `{ amount: "1500.00", currency: "USD" }`. */
export interface LoanValuation {
  /** A non-negative decimal amount, at most two decimal places. */
  readonly amount: string;
  /** An ISO 4217 code: three capital letters. */
  readonly currency: string;
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
  /** What the whole loan is valued at for insurance (Spectrum's "loan valuation"). */
  readonly valuation?: LoanValuation;
  /** Who insures it, the policy and any indemnity: free text. */
  readonly insurance?: string;
  /** Who authorised the loan for the organization (a name, one line). */
  readonly authorisedBy?: string;
  /** The day it was authorised, `YYYY-MM-DD`. */
  readonly authorisedOn?: string;
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
 * anything moved. `unknown` for any loan with problems (see
 * `LoanState.problems`), whatever its status: its links don't fit the move
 * log, so it can't be shown as returned or not yet out.
 */
export type LoanPhase =
  "requested" | "agreed" | "on_loan" | "returned" | "declined" | "cancelled" | "closed" | "unknown";

/** One item of a loan, with its moves. */
export interface LoanItemState {
  readonly recordId: RecordId;
  /** Loan out: the `loan_out` move. Loan in: the arrival `placement`. */
  readonly started: StorageMove | null;
  /** Loan out: the `return` move. Loan in: the `departure`. */
  readonly ended: StorageMove | null;
  /**
   * True between the two (a loan in's item continued by a renewal is no
   * longer out on this loan).
   */
  readonly out: boolean;
  /**
   * How the item was settled (D-118), or null while something is still owed
   * on it: `returned` and `departed` (its end move is linked), `not_sent`,
   * `not_received`, `kept` (an accession names it) or `renewed` (a later loan
   * in continues it).
   */
  readonly settledBy:
    "returned" | "departed" | "not_sent" | "not_received" | "kept" | "renewed" | null;
  /** Loan in: the loan this item continues (a renewal), when it does. */
  readonly continues: LoanId | null;
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
   * The items not settled yet (see `LoanItemState.settledBy`), for an
   * agreed or closed loan; empty for the other statuses. An agreed loan
   * past its end date with any is overdue.
   */
  readonly unsettled: readonly RecordId[];
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
export const MAX_AUTHORISER_LENGTH = 200;
/** The largest valuation amount: 15 digits before the point. */
export const MAX_VALUATION_DIGITS = 15;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

/**
 * Read limits sized from the shape (review fix: 500 full items didn't fit).
 * A full item is one object with at most five keys (D-118: a start, an end
 * and one settling key besides the record): at most 11 values and 80 key
 * characters plus 4 × 36 ID characters (224, rounded up to 240). The loan's
 * own keys and values (18 keys, four 2000-character texts, a valuation)
 * get 50 values and 10,000 characters; the items array is one value more.
 */
const ITEM_VALUES = 11;
const ITEM_CHARS = 240;
const LOAN_LIMITS = {
  maxDepth: 3,
  maxValues: 51 + ITEM_VALUES * MAX_LOAN_ITEMS,
  maxStringLength: MAX_STORAGE_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 10_000 + ITEM_CHARS * MAX_LOAN_ITEMS,
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
  "valuation",
  "insurance",
  "authorisedBy",
  "authorisedOn",
  "note",
  "items",
] as const;

/** Per direction: the keys an item may have besides its move links. */
const SETTLE_KEYS = {
  out: ["notSent"],
  in: ["notReceived", "keptByAccessionId", "continuesLoanId"],
} as const;

const AMOUNT = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Per direction: the item's start and end move keys. */
const MOVE_KEYS = {
  out: { start: "loanOutMoveId", end: "returnMoveId" },
  in: { start: "arrivalMoveId", end: "departureMoveId" },
} as const;

/** Make a new random loan ID. */
export function newLoanId(): LoanId {
  return randomUUID() as LoanId;
}

/**
 * The key a loan's number is unique by, among the organization's loans that
 * way (in or out): what `indexLoans` compares, for the database's unique key.
 */
export function loanNumberKey(number: string): string {
  return fold(number);
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
    checkText(d.insurance, ["insurance"], "The insurance", issues);
    checkText(d.note, ["note"], "A note", issues);
    checkLine(
      d.authorisedBy,
      ["authorisedBy"],
      "authoriser's name",
      MAX_AUTHORISER_LENGTH,
      false,
      issues,
    );
    if (d.authorisedOn !== undefined && !isIsoDay(d.authorisedOn)) {
      issues.add(
        ["authorisedOn"],
        "invalid_date",
        "authorisedOn must be a day written YYYY-MM-DD.",
      );
    } else if (isIsoDay(d.authorisedOn) && d.authorisedOn > dayAfter(time)) {
      issues.add(["authorisedOn"], "future_date", "A loan can't be authorised after today.");
    }
    checkValuation(d.valuation, issues);
    if (knownDirection) {
      checkItems(
        d.items,
        direction,
        knownStatus ? (status as LoanStatus) : undefined,
        d.id,
        issues,
      );
    } else if (!Array.isArray(d.items)) {
      issues.add(["items"], "required", "A loan lists at least one item.");
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as Loan };
  }, "This loan could not be read as plain data.");
}

type SettledBy = LoanItemState["settledBy"];

interface ItemData {
  readonly recordId: RecordId;
  readonly started: StorageMove | null;
  readonly ended: StorageMove | null;
  /** True when the item went out or arrived: a start move, or a renewal it validly continues. */
  readonly begun: boolean;
  readonly settledBy: SettledBy;
  readonly continues: LoanId | null;
}

/**
 * Which accessions name which records (`indexLoans`'s `accessions`): what a
 * loan in item's `keptByAccessionId` is checked against. The service builds
 * it from the stored accessions in the same transaction (D-118); never from
 * a request.
 */
export type AccessionRecords = ReadonlyMap<string, readonly RecordId[]>;

/** `indexLoans`'s options. */
export interface LoanBookOptions {
  /** The organization's accessions and the records each names. Without it, no item counts as kept. */
  readonly accessions?: AccessionRecords;
}

interface BookData {
  readonly log: MoveLog;
  /** A private copy of `LoanBookOptions.accessions`. */
  readonly kept: ReadonlyMap<string, ReadonlySet<string>>;
  readonly organizationId: OrganizationId;
  /** Loans in the order given. */
  readonly loans: readonly Loan[];
  readonly byId: ReadonlyMap<LoanId, Entry>;
  readonly byRecord: ReadonlyMap<RecordId, readonly LoanId[]>;
  /** Departure moves in the log that no loan in names. */
  readonly unexplained: readonly StorageMove[];
  /** `loan_out` moves in the log that no loan out names or extends. */
  readonly unexplainedOut: readonly StorageMove[];
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
 *   items (`move_reused`, on every loan naming it);
 * - starts outside the loan period: a `loan_out` or arrival before `beginOn`
 *   or after `endOn` (`move_outside_loan`);
 * - has the wrong reason (`wrong_move_reason`: `loan_out` and `return` for a
 *   loan out, `placement` and `departure` for a loan in);
 * - goes somewhere other than an outside location of the borrower or lender
 *   (`not_agent_location`);
 * - ends before it started, or isn't the record's first return (or
 *   departure) after it started (`end_out_of_order`);
 * - overlaps another loan of the same record the same way
 *   (`overlapping_loans`, on every loan involved): a record is lent to one
 *   borrower at a time.
 * And a `closed` loan out whose record has a `loan_out` move to the borrower,
 * in the loan period, that no loan explains (`closed_with_unlinked_move`),
 * or a `closed` loan in with an item that has no departure linked although
 * its record has a move dated on or after `beginOn`
 * (`closed_without_departure`).
 * A loan with any of these is in phase `unknown` and listed by
 * `overdueLoans` once past its end date. `now` is for tests. Never throws.
 */
export function indexLoans(
  log: MoveLog,
  loans: unknown,
  now: Date = new Date(),
  options: LoanBookOptions = {},
): Validated<LoanBook> {
  try {
    if (!isMoveLog(log)) return notALog();
    const kept = keptCopy(options);
    if (kept === undefined) {
      return refused(
        ["accessions"],
        "invalid_accessions",
        "accessions is a map of accession IDs to record IDs.",
      );
    }
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
    return buildBook(log, valid, kept);
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
 * and is refused with any problem `indexLoans` would report for it, or if it
 * would give any other loan in the book a problem that loan didn't have
 * (reported under `["otherLoans", <loan id>, ...]`). Problems other loans
 * already had don't block it. An edit may not drop a move link the saved
 * loan records, nor an item whose start move is recorded, unless the saved
 * end link names a move in the log (`link_removed`). The given book is not changed. `now` is for
 * tests. Never throws.
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
    if (before !== undefined) {
      // An edit can't drop a recorded link (review fix): with the link gone,
      // `closed_with_items_out` no longer applies, so an item still out
      // could be closed off the overdue lists.
      const removed = removedLinks(before, next);
      if (removed.length > 0) return { ok: false, issues: removed };
    }
    if (before === undefined && data.loans.length >= MAX_LOANS) {
      return refused([], "too_many", `A book can hold at most ${String(MAX_LOANS)} loans.`);
    }
    const loans =
      before === undefined
        ? [...data.loans, next]
        : data.loans.map((l) => (l.id === next.id ? next : l));
    if (before !== undefined) {
      const turned = statusTurns(before, next);
      if (turned.length > 0) return { ok: false, issues: turned };
    }
    const at = before === undefined ? data.loans.length : data.loans.indexOf(before.loan);
    const built = buildBook(data.log, loans, data.kept);
    if (!built.ok) {
      // Report the edited loan's problems without its position in the book.
      return {
        ok: false,
        issues: built.issues.map((f) =>
          f.path[0] === at ? issue(f.path.slice(1), f.code, f.message) : f,
        ),
      };
    }
    const after = bookData(built.value);
    if (after === undefined) return notABook();
    const problems = after.byId.get(next.id)?.problems ?? [];
    if (problems.length > 0) return { ok: false, issues: problems };
    // Nor may the edit give any other loan a problem it didn't have (review
    // fix): claiming another loan's move, or overlapping it, would otherwise
    // be saved and hide that loan's overdue item.
    const caused: Issue[] = [];
    for (const [id, entry] of after.byId) {
      if (id === next.id) continue;
      const had = new Set((data.byId.get(id)?.problems ?? []).map(problemKey));
      for (const found of entry.problems) {
        if (!had.has(problemKey(found))) {
          caused.push(
            issue(
              ["otherLoans", id, ...found.path],
              found.code,
              `This edit would give loan ${shown(entry.loan.number)} a problem: ${found.message}`,
            ),
          );
        }
      }
    }
    return caused.length > 0 ? { ok: false, issues: caused } : built;
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
    return buildBook(log, data.loans, data.kept);
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
 * `loan_out` moves in the move log that no loan out explains, oldest first:
 * none of its items names the move as its `loanOutMoveId`, and it isn't an
 * extension of one that is (a later `loan_out` of the same record to the same
 * location, before that item's return). Each is a record sent to a borrower
 * with no loan on file for it, or a loan whose link was never recorded.
 * Reported, not refused, like `unexplainedDepartures`; the record itself is
 * still on `overdueReturns` by the move's own date.
 */
export function unexplainedLoanMoves(book: LoanBook): Validated<readonly StorageMove[]> {
  const data = bookData(book);
  if (data === undefined) return notABook();
  return { ok: true, value: data.unexplainedOut };
}

/**
 * Every loan with an item still out after its end date, `today`
 * (`YYYY-MM-DD`, the organization's own date) being later: lent items not
 * back, and borrowed items not yet gone back to their lender. A loan past
 * its end date with problems (phase `unknown`) is listed too, with its
 * problems, since a missing or stale link may hide an item still out.
 * Longest overdue first.
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
    // D-118: an agreed loan is over only when every item is settled, by a
    // linked end move or an explicit, recorded way; dates alone never do it.
    if (
      state.phase === "unknown" ||
      (entry.loan.status === "agreed" && state.unsettled.length > 0)
    ) {
      found.push(state);
    }
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

function buildBook(
  log: MoveLog,
  loans: readonly Loan[],
  kept: ReadonlyMap<string, ReadonlySet<string>>,
): Validated<LoanBook> {
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
  const byLoan = new Map<LoanId, Loan>();
  const named = new Set<MoveId>();
  const numbers = new Set<string>();
  /** Each named move's first claimant, and whether it was flagged as shared yet. */
  const usedMoves = new Map<
    MoveId,
    { loanId: LoanId; path: readonly (string | number)[]; flagged: boolean }
  >();
  const byRecord = new Map<RecordId, LoanId[]>();
  /** Loan out items that went out: the history indexes between their start and end. */
  const lent: { recordId: RecordId; from: number; to: number; locationId: string }[] = [];
  /** Every item, as read against the log, before renewals are resolved. */
  const raw: Raw[] = [];
  const rawByKey = new Map<string, Raw>();
  /** Items whose end link names a move that doesn't end them (wrong reason, place or order). */
  const badEnds = new Set<string>();
  loans.forEach((loan, i) => {
    if (issues.full) return;
    if (byLoan.has(loan.id)) {
      issues.add([i, "id"], "duplicate_id", "Two loans have the same ID.");
      return;
    }
    byLoan.set(loan.id, loan);
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
    loan.items.forEach((item, j) => {
      const history = moveHistory(log, item.recordId);
      const moves = history.ok ? history.value : [];
      const find = (key: string): { move: StorageMove; index: number } | null | undefined => {
        const id = ownLink(item, key);
        if (id === undefined) return null;
        named.add(id);
        const first = usedMoves.get(id);
        if (first !== undefined) {
          // Flag every loan that names it, never only the later one: which
          // loan comes first in the list says nothing about which is right,
          // and an edit to an earlier loan must not make a later, genuine
          // loan look returned (review fix).
          if (!first.flagged) {
            first.flagged = true;
            flag(first.loanId, first.path, "move_reused", "Another loan item names this move too.");
          }
          flag(loan.id, ["items", j, key], "move_reused", "Another loan item names this move too.");
          return undefined;
        }
        usedMoves.set(id, { loanId: loan.id, path: ["items", j, key], flagged: false });
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
        badEnds.add(`${loan.id} ${item.recordId}`);
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
        // A departure to the wrong outside location may be put right by the
        // corrections that follow it (storage.ts); the last one says where it went.
        let placeId = crossing.move.locationId;
        if (loan.direction === "in") {
          for (let k = crossing.index + 1; k < moves.length; k += 1) {
            const next = moves[k];
            if (next?.reason !== "correction") break;
            placeId = next.locationId;
          }
        }
        const place = logLocation(log, placeId);
        if (place?.kind !== "external" || place.agentId !== loan.agentId) {
          if (loan.direction === "in") badEnds.add(`${loan.id} ${item.recordId}`);
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
      if (start && loan.direction === "out") {
        lent.push({
          recordId: item.recordId,
          from: start.index,
          to: end ? end.index : moves.length,
          locationId: start.move.locationId,
        });
      }
      const continuesId = loan.direction === "in" ? ownString(item, "continuesLoanId") : undefined;
      const entry: Raw = {
        loan,
        at: i,
        j,
        recordId: item.recordId,
        moves,
        start: start ?? null,
        end: end ?? null,
        startNamed: ownLink(item, keys.start) !== undefined,
        endNamed: ownLink(item, keys.end) !== undefined,
        continues: continuesId !== undefined && isLoanId(continuesId) ? continuesId : null,
        flagged: ownFlag(item, loan.direction === "out" ? "notSent" : "notReceived"),
        keptBy: loan.direction === "in" ? (ownString(item, "keptByAccessionId") ?? null) : null,
        effectiveStart: start ? start.index : undefined,
        renewedBy: null,
        continuedValidly: false,
      };
      raw.push(entry);
      rawByKey.set(`${loan.id} ${item.recordId}`, entry);
      const mine = byRecord.get(item.recordId) ?? [];
      mine.push(loan.id);
      byRecord.set(item.recordId, mine);
    });
  });
  if (issues.count > 0) return { ok: false, issues: issues.items };

  // Renewals (D-118): a loan in item that continues an earlier loan's item
  // for the same record, from the same lender, takes over from it. It counts
  // as arrived from that item's arrival, and settles that item. One
  // continuer per item; a chain must reach a real arrival.
  const continuers = new Map<Raw, Raw[]>();
  for (const r of raw) {
    if (r.continues === null) continue;
    const target = rawByKey.get(`${r.continues} ${r.recordId}`);
    const fits =
      target?.loan.direction === "in" &&
      target.loan.agentId === r.loan.agentId &&
      (target.loan.status === "agreed" || target.loan.status === "closed") &&
      (r.loan.status === "agreed" || r.loan.status === "closed") &&
      !target.endNamed &&
      !target.flagged &&
      target.keptBy === null;
    if (!fits) {
      flag(
        r.loan.id,
        ["items", r.j, "continuesLoanId"],
        "renewal_mismatch",
        "This item continues no open item of that loan: it must be an agreed loan in from the same lender, listing this record, not yet gone back, kept or marked notReceived.",
      );
      continue;
    }
    const list = continuers.get(target) ?? [];
    list.push(r);
    continuers.set(target, list);
  }
  for (const [target, list] of continuers) {
    if (list.length > 1) {
      for (const r of list) {
        flag(
          r.loan.id,
          ["items", r.j, "continuesLoanId"],
          "continued_twice",
          "Another loan continues the same item: a record is renewed onto one loan at a time.",
        );
      }
      continue;
    }
    const [only] = list;
    if (only !== undefined) {
      target.renewedBy = only;
      only.continuedValidly = true;
    }
  }
  // A continued item's start is its chain's first arrival; a chain with no
  // arrival (or a loop) never began.
  for (const r of raw) {
    if (!r.continuedValidly) continue;
    const seen = new Set<Raw>([r]);
    let at: Raw | undefined = rawByKey.get(`${r.continues ?? ""} ${r.recordId}`);
    while (at !== undefined && !seen.has(at) && at.effectiveStart === undefined) {
      seen.add(at);
      at = at.continuedValidly ? rawByKey.get(`${at.continues ?? ""} ${at.recordId}`) : undefined;
    }
    if (at !== undefined && !seen.has(at) && at.effectiveStart !== undefined) {
      r.effectiveStart = at.effectiveStart;
    } else {
      flag(
        r.loan.id,
        ["items", r.j, "continuesLoanId"],
        "renewal_mismatch",
        "The loans this item continues never record its arrival.",
      );
    }
  }
  for (const r of raw) {
    // A loop's members were each reached from another; mark any left unresolved.
    if (r.continuedValidly && r.effectiveStart === undefined) {
      const mine = linkProblems.get(r.loan.id) ?? [];
      if (!mine.some((p) => p.code === "renewal_mismatch")) {
        flag(
          r.loan.id,
          ["items", r.j, "continuesLoanId"],
          "renewal_mismatch",
          "This renewal never began.",
        );
      }
    }
  }

  // The end must be the record's first return (or departure) after the item began.
  for (const r of raw) {
    if (r.end === null || r.effectiveStart === undefined) continue;
    const endReason = r.loan.direction === "out" ? "return" : "departure";
    const from = r.effectiveStart;
    const firstEnd = r.moves.findIndex((m, k) => k > from && m.reason === endReason);
    if (r.end.index <= from || firstEnd !== r.end.index) {
      badEnds.add(`${r.loan.id} ${r.recordId}`);
      flag(
        r.loan.id,
        ["items", r.j, MOVE_KEYS[r.loan.direction].end],
        "end_out_of_order",
        r.loan.direction === "out"
          ? "The return must be the record's first return after it went out on this loan."
          : "The departure must be the record's first departure after it arrived on this loan.",
      );
    }
  }

  // Overlaps: a record is out (or here) on one loan each way at a time. A
  // renewed item's span is carried on by its continuer.
  const spans = new Map<string, { start: number; end: number; loanId: LoanId; j: number }[]>();
  for (const r of raw) {
    if (r.effectiveStart === undefined || r.renewedBy !== null) continue;
    const spanKey = `${r.loan.direction} ${r.recordId}`;
    const list = spans.get(spanKey) ?? [];
    list.push({
      start: r.effectiveStart,
      end: r.end ? r.end.index : Infinity,
      loanId: r.loan.id,
      j: r.j,
    });
    spans.set(spanKey, list);
  }
  for (const list of spans.values()) {
    list.sort((a, b) => a.start - b.start);
    // Both loans of an overlap are flagged (review fix), and each span is
    // compared with the one reaching furthest so far, not only its neighbour.
    const flagged = new Set<(typeof list)[number]>();
    const overlap = (span: (typeof list)[number]): void => {
      if (flagged.has(span)) return;
      flagged.add(span);
      flag(
        span.loanId,
        ["items", span.j],
        "overlapping_loans",
        "This record is out on another loan at the same time.",
      );
    };
    let reach: (typeof list)[number] | undefined;
    for (const span of list) {
      if (reach !== undefined && span.start < reach.end) {
        overlap(reach);
        overlap(span);
      }
      if (reach === undefined || span.end > reach.end) reach = span;
    }
  }

  // How each item is settled (D-118). Only the explicit ways count.
  // An end link counts only when it truly ends the item: in the log, the
  // right reason and place, the first after it began.
  const endsIt = (r: Raw): boolean =>
    r.end !== null && r.effectiveStart !== undefined && !badEnds.has(`${r.loan.id} ${r.recordId}`);
  const settledOf = (r: Raw): SettledBy => {
    if (r.loan.direction === "out") {
      if (endsIt(r)) return "returned";
      return r.flagged ? "not_sent" : null;
    }
    if (endsIt(r)) return "departed";
    if (r.flagged) return "not_received";
    if (r.keptBy !== null) return "kept";
    if (r.renewedBy !== null) return "renewed";
    return null;
  };
  for (const r of raw) {
    if (r.keptBy === null) continue;
    const names = kept.get(r.keptBy);
    if (!names?.has(r.recordId)) {
      flag(
        r.loan.id,
        ["items", r.j, "keptByAccessionId"],
        "not_kept",
        "No accession of ours with this ID names this record. Record the accession, listing the record, to keep it.",
      );
    }
  }

  // Where the record is now (D-118, S-013): a loan's record found back in our
  // care (or at the borrower's) that no open loan explains makes the loan
  // unknown, whatever the dates say.
  const agreedOrClosed = (l: Loan): boolean => l.status === "agreed" || l.status === "closed";
  const coveredIn = new Set<RecordId>();
  const coveredOut = new Set<string>();
  for (const r of raw) {
    if (!agreedOrClosed(r.loan) || r.effectiveStart === undefined) continue;
    const by = settledOf(r);
    if (r.loan.direction === "in") {
      if (by === null || by === "kept" || by === "renewed") coveredIn.add(r.recordId);
    } else if (by === null) {
      coveredOut.add(`${r.recordId} ${r.loan.agentId}`);
    }
  }
  const nowAt = new Map<RecordId, StorageLocation | null>();
  const currentPlace = (recordId: RecordId): StorageLocation | null => {
    if (nowAt.has(recordId)) return nowAt.get(recordId) ?? null;
    const where = whereabouts(log, recordId);
    const place = where.ok && where.value !== null ? where.value.current : null;
    nowAt.set(recordId, place);
    return place;
  };
  for (const r of raw) {
    if (!agreedOrClosed(r.loan)) continue;
    const by = settledOf(r);
    const place = currentPlace(r.recordId);
    if (r.loan.direction === "in") {
      if (place === null || place.kind === "external" || coveredIn.has(r.recordId)) continue;
      if (by === null && !r.startNamed && r.continues === null) {
        flag(
          r.loan.id,
          ["items", r.j],
          "unlinked_arrival",
          "This record is in our care, but its arrival isn't linked to this loan (or any open loan in). Link the placement that housed it.",
        );
      } else if (by === "not_received") {
        flag(
          r.loan.id,
          ["items", r.j, "notReceived"],
          "received_after_all",
          "This record is marked as never received, but it is in our care and no open loan in explains it.",
        );
      } else if (by === "departed") {
        flag(
          r.loan.id,
          ["items", r.j, "departureMoveId"],
          "back_again_unlinked",
          "This record went back to the lender but is in our care again, and no open loan in explains it. Record the new loan in, linking its arrival.",
        );
      }
    } else {
      const atAgent =
        place !== null && place.kind === "external" && place.agentId === r.loan.agentId;
      if (!atAgent || coveredOut.has(`${r.recordId} ${r.loan.agentId}`)) continue;
      if (by === null && !r.startNamed) {
        flag(
          r.loan.id,
          ["items", r.j],
          "unlinked_loan_out",
          "This record is at the borrower's, but no loan_out move is linked to this loan (or any open loan out). Link the move that sent it.",
        );
      } else if (by === "not_sent") {
        flag(
          r.loan.id,
          ["items", r.j, "notSent"],
          "sent_after_all",
          "This record is marked as never sent, but it is at the borrower's and no open loan out explains it.",
        );
      } else if (by === "returned") {
        flag(
          r.loan.id,
          ["items", r.j, "returnMoveId"],
          "out_again_unlinked",
          "This record came back but is at the borrower's again, and no open loan out explains it.",
        );
      }
    }
  }

  // A `loan_out` move is explained when a loan item names it, or when it
  // extends one: the same record to the same place, after the named
  // `loan_out` and before that item's return.
  const explained = new Set<string>(named);
  for (const span of lent) {
    const history = moveHistory(log, span.recordId);
    const moves = history.ok ? history.value : [];
    for (let k = span.from + 1; k < span.to && k < moves.length; k += 1) {
      const m = moves[k];
      if (m?.reason === "loan_out" && m.locationId === span.locationId) explained.add(m.id);
    }
  }
  const outs = movesWithReason(log, "loan_out");
  const unexplainedOut = Object.freeze(
    (outs.ok ? outs.value : []).filter((m) => !explained.has(m.id)),
  );
  const strayByRecord = new Map<RecordId, StorageMove[]>();
  for (const m of unexplainedOut) {
    const list = strayByRecord.get(m.recordId) ?? [];
    list.push(m);
    strayByRecord.set(m.recordId, list);
  }
  for (const r of raw) {
    if (r.loan.status !== "closed") continue;
    // A closed loan has every item settled (D-118): nothing is owed on it.
    if (settledOf(r) === null) {
      flag(
        r.loan.id,
        ["items", r.j],
        "closed_unsettled",
        r.loan.direction === "out"
          ? "A loan out can't be closed until this item's return is linked, or it is marked notSent."
          : "A loan in can't be closed until this item's departure is linked, or it is marked notReceived, kept by an accession or renewed.",
      );
    }
    if (r.loan.direction === "out") {
      // A closed loan out can't leave a record's loan_out to this borrower,
      // in the loan period, unlinked (review fix): the item may be out.
      const loan = r.loan;
      const stray = (strayByRecord.get(r.recordId) ?? []).some((m) => {
        const place = logLocation(log, m.locationId);
        return (
          place?.kind === "external" &&
          place.agentId === loan.agentId &&
          m.movedOn >= loan.beginOn &&
          m.movedOn <= loan.endOn
        );
      });
      if (stray) {
        flag(
          loan.id,
          ["items", r.j],
          "closed_with_unlinked_move",
          "This record went out to the borrower during the loan in a move no loan names. Link it to this item, and its return, before closing.",
        );
      }
    }
  }

  const entries = new Map<LoanId, Entry>();
  const itemsOf = new Map<LoanId, ItemData[]>();
  for (const r of raw) {
    const list = itemsOf.get(r.loan.id) ?? [];
    list.push(
      Object.freeze({
        recordId: r.recordId,
        started: r.start ? r.start.move : null,
        ended: r.end ? r.end.move : null,
        begun: r.effectiveStart !== undefined,
        settledBy: settledOf(r),
        continues: r.continues,
      }),
    );
    itemsOf.set(r.loan.id, list);
  }
  for (const [id, loan] of byLoan) {
    entries.set(
      id,
      Object.freeze({
        loan,
        items: Object.freeze(itemsOf.get(id) ?? []),
        problems: Object.freeze(linkProblems.get(id) ?? []),
      }),
    );
  }
  const gone = departures(log);
  const unexplained = Object.freeze(
    (gone.ok ? gone.value : []).filter((move) => !named.has(move.id)),
  );
  const frozenByRecord = new Map<RecordId, readonly LoanId[]>();
  for (const [recordId, ids] of byRecord) frozenByRecord.set(recordId, Object.freeze(ids));
  const book: LoanBook = Object.freeze({ organizationId, size: byLoan.size });
  LOAN_BOOKS.set(book, {
    log,
    kept,
    organizationId,
    loans: Object.freeze([...loans]),
    byId: entries,
    byRecord: frozenByRecord,
    unexplained,
    unexplainedOut,
  });
  return { ok: true, value: book };
}

/** One item while the book is built. */
interface Raw {
  readonly loan: Loan;
  readonly at: number;
  readonly j: number;
  readonly recordId: RecordId;
  readonly moves: readonly StorageMove[];
  readonly start: { readonly move: StorageMove; readonly index: number } | null;
  readonly end: { readonly move: StorageMove; readonly index: number } | null;
  /** The item names a start or end move (whether or not the log has it). */
  readonly startNamed: boolean;
  readonly endNamed: boolean;
  readonly continues: LoanId | null;
  /** `notSent` (out) or `notReceived` (in). */
  readonly flagged: boolean;
  readonly keptBy: string | null;
  /** The history index it began at: its start move, or its renewal chain's first arrival. */
  effectiveStart: number | undefined;
  /** The later item that validly continues this one. */
  renewedBy: Raw | null;
  /** This item validly continues an earlier one (it may still not reach an arrival). */
  continuedValidly: boolean;
}

/** The accessions map, copied into fresh sets; undefined when it isn't one. */
function keptCopy(options: unknown): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  const empty = new Map<string, ReadonlySet<string>>();
  if (options === undefined) return empty;
  if (typeof options !== "object" || options === null || types.isProxy(options)) return undefined;
  const slot = Object.getOwnPropertyDescriptor(options, "accessions");
  if (slot === undefined) return empty;
  if (!("value" in slot)) return undefined;
  const given: unknown = slot.value;
  if (given === undefined) return empty;
  if (!(given instanceof Map) || types.isProxy(given)) return undefined;
  const copy = new Map<string, ReadonlySet<string>>();
  for (const [key, value] of Map.prototype.entries.call(given) as IterableIterator<
    [unknown, unknown]
  >) {
    if (typeof key !== "string" || !Array.isArray(value) || types.isProxy(value)) return undefined;
    const ids = new Set<string>();
    for (const id of value as unknown[]) {
      if (!isRecordId(id)) return undefined;
      ids.add(id);
    }
    copy.set(key, ids);
  }
  return copy;
}

/**
 * D-118: what an agreed (or closed) loan's status may become. Never back to
 * `requested` or `declined`; `cancelled` only when every item is marked
 * `notSent` or `notReceived` (nothing moved, and saying so is on record).
 */
function statusTurns(before: Entry, next: Loan): Issue[] {
  const was = before.loan.status;
  if (was !== "agreed" && was !== "closed") return [];
  const found: Issue[] = [];
  const nextItems: readonly (LoanInItem | LoanOutItem)[] = next.items;
  for (const item of before.loan.items) {
    if (!nextItems.some((i) => i.recordId === item.recordId)) {
      found.push(
        issue(
          ["items"],
          "item_removed",
          `Record ${item.recordId} is on this ${was} loan; it stays on it. Mark it ${next.direction === "out" ? "notSent" : "notReceived"} if it never ${next.direction === "out" ? "went" : "came"}.`,
        ),
      );
    }
  }
  if (next.status === "requested" || next.status === "declined") {
    found.push(
      issue(
        ["status"],
        "status_change_refused",
        `An ${was} loan can't go back to ${next.status}. Cancel it (marking every item as never ${next.direction === "out" ? "sent" : "received"}) or close it.`,
      ),
    );
  } else if (next.status === "cancelled") {
    const flagKey = next.direction === "out" ? "notSent" : "notReceived";
    nextItems.forEach((item, j) => {
      if (!ownFlag(item, flagKey)) {
        found.push(
          issue(
            ["items", j, flagKey],
            "status_change_refused",
            `An ${was} loan is cancelled only when every item is marked ${flagKey}.`,
          ),
        );
      }
    });
  }
  return found;
}

/** An item's own string property (never an inherited one, S-012). */
function ownString(item: object, key: string): string | undefined {
  const slot = Object.getOwnPropertyDescriptor(item, key);
  if (slot === undefined || !("value" in slot)) return undefined;
  const value: unknown = slot.value;
  return typeof value === "string" ? value : undefined;
}

/** An item's own `true` flag (never an inherited one, S-012). */
function ownFlag(item: object, key: string): boolean {
  const slot = Object.getOwnPropertyDescriptor(item, key);
  return slot !== undefined && "value" in slot && slot.value === true;
}

/** Identifies one problem of one loan, to compare a loan's problems before and after an edit. */
function problemKey(found: Issue): string {
  return `${found.code} ${JSON.stringify(found.path)}`;
}

/**
 * The move links an edit removes from the saved loan (`link_removed`). A
 * link may be changed to another move (which must then fit the log), never
 * dropped: not an item's start or end link, and not an item whose start is
 * recorded, unless the saved loan's end link names a move the log holds (the
 * item is back, so dropping it hides nothing). A wrong link is put right by
 * linking the right move, or by recording a correcting move.
 */
function removedLinks(before: Entry, next: Loan): Issue[] {
  const keys = MOVE_KEYS[next.direction];
  const ending = next.direction === "out" ? "return" : "departure";
  const found: Issue[] = [];
  const nextItems: readonly (LoanInItem | LoanOutItem)[] = next.items;
  const startOf = (i: LoanInItem | LoanOutItem): string | undefined =>
    ownLink(i, keys.start) ?? ownString(i, "continuesLoanId");
  before.loan.items.forEach((item, j) => {
    if (startOf(item) === undefined) return;
    const back = ownLink(item, keys.end) !== undefined && (before.items[j]?.ended ?? null) !== null;
    const k = nextItems.findIndex((i) => i.recordId === item.recordId);
    const now = nextItems[k];
    if (now === undefined || startOf(now) === undefined) {
      if (!back) {
        found.push(
          issue(
            now === undefined ? ["items"] : ["items", k, keys.start],
            "link_removed",
            `Record ${item.recordId} has its ${keys.start} recorded on this loan, so it can't be taken off the loan or unlinked until its ${ending} is recorded. Link the right move instead.`,
          ),
        );
      }
      return;
    }
    if (ownLink(item, keys.end) !== undefined && ownLink(now, keys.end) === undefined) {
      found.push(
        issue(
          ["items", k, keys.end],
          "link_removed",
          `This item's ${keys.end} is recorded on this loan; link the right move instead of removing it.`,
        ),
      );
    }
  });
  return found;
}

/**
 * An item's move link, read only as its own data property (S-012): an
 * inherited `departureMoveId` on a polluted `Object.prototype` must never
 * link a real move and take a loan off the overdue list. Validated copies
 * have no prototype already; this keeps every read safe on its own.
 */
function ownLink(item: LoanInItem | LoanOutItem, key: string): MoveId | undefined {
  const slot = Object.getOwnPropertyDescriptor(item, key);
  if (slot === undefined || !("value" in slot)) return undefined;
  const value: unknown = slot.value;
  return isMoveId(value) ? value : undefined;
}

function stateOf(data: BookData, entry: Entry): LoanState {
  const { loan, items } = entry;
  const states = items.map((item): LoanItemState => {
    const out = item.begun && item.settledBy === null;
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
      settledBy: item.settledBy,
      continues: item.continues,
      dueBack,
      dueMatchesLoan: !(out && loan.direction === "out") || dueBack === loan.endOn,
    });
  });
  let phase: LoanPhase;
  // A loan whose links don't fit the move log may have an item out that a
  // missing or stale link hides, so it never looks returned or not started
  // (review fix).
  if (entry.problems.length > 0) phase = "unknown";
  else if (loan.status !== "agreed") phase = loan.status;
  else if (states.some((s) => s.out)) phase = "on_loan";
  else if (items.some((i) => i.begun)) phase = "returned";
  else phase = "agreed";
  const owing = loan.status === "agreed" || loan.status === "closed";
  const unsettled = owing ? states.filter((s) => s.settledBy === null).map((s) => s.recordId) : [];
  return Object.freeze({
    loan,
    phase,
    items: Object.freeze(states),
    unsettled: Object.freeze(unsettled),
    problems: entry.problems,
  });
}

function checkItems(
  value: JsonValue | undefined,
  direction: LoanDirection,
  status: LoanStatus | undefined,
  loanId: JsonValue | undefined,
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
  const allowed: readonly string[] = ["recordId", keys.start, keys.end, ...SETTLE_KEYS[direction]];
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
    // D-118: the explicit ways an item is settled without an end move.
    const flagKey = direction === "out" ? "notSent" : "notReceived";
    const flagged = fields[flagKey];
    if (flagged !== undefined && flagged !== true) {
      issues.add(["items", j, flagKey], "invalid_flag", `${flagKey} is true, or left out.`);
    }
    const kept = fields.keptByAccessionId;
    if (kept !== undefined && !(typeof kept === "string" && UUID_V4.test(kept))) {
      issues.add(
        ["items", j, "keptByAccessionId"],
        "invalid_id",
        "keptByAccessionId must be an accession ID.",
      );
    }
    const continues = fields.continuesLoanId;
    if (continues !== undefined) {
      if (!isLoanId(continues)) {
        issues.add(
          ["items", j, "continuesLoanId"],
          "invalid_id",
          "continuesLoanId must be a loan ID.",
        );
      } else if (continues === loanId) {
        issues.add(
          ["items", j, "continuesLoanId"],
          "continues_itself",
          "A loan can't continue itself.",
        );
      }
    }
    const started = start !== undefined || continues !== undefined;
    if (start !== undefined && continues !== undefined) {
      issues.add(
        ["items", j, "continuesLoanId"],
        "two_starts",
        "A renewed item was already here: it has no arrival move of its own on this loan.",
      );
    }
    if (flagged !== undefined && (started || end !== undefined || kept !== undefined)) {
      issues.add(
        ["items", j, flagKey],
        direction === "out" ? "not_sent_but_moved" : "not_received_but_arrived",
        direction === "out"
          ? "An item that went out can't be marked notSent."
          : "An item that arrived can't be marked notReceived.",
      );
    }
    if (kept !== undefined && end !== undefined) {
      issues.add(
        ["items", j, "keptByAccessionId"],
        "two_ends",
        "An item that went back to the lender wasn't kept: give one or the other.",
      );
    }
    if ((end !== undefined || kept !== undefined) && !started) {
      issues.add(
        ["items", j, end !== undefined ? keys.end : "keptByAccessionId"],
        "end_without_start",
        direction === "out"
          ? "An item can't come back before it went out: give loanOutMoveId too."
          : "An item can't go back, or be kept, before it arrived: give arrivalMoveId (or continuesLoanId) too.",
      );
    }
    if (status !== undefined && NOT_AGREED.includes(status) && (started || kept !== undefined)) {
      issues.add(
        [
          "items",
          j,
          start !== undefined
            ? keys.start
            : continues !== undefined
              ? "continuesLoanId"
              : "keptByAccessionId",
        ],
        "moved_before_agreed",
        `Nothing moves on a ${status} loan; agree it first.`,
      );
    }
  });
}

function checkValuation(value: JsonValue | undefined, issues: IssueList): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    issues.add(["valuation"], "not_an_object", "The valuation is { amount, currency }.");
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "amount" && key !== "currency") {
      issues.add(
        ["valuation", key],
        "unknown_property",
        `${shown(key)} is not part of a valuation.`,
      );
    }
  }
  const amount = Object.getOwnPropertyDescriptor(value, "amount")?.value as unknown;
  const currency = Object.getOwnPropertyDescriptor(value, "currency")?.value as unknown;
  if (typeof amount !== "string" || !AMOUNT.test(amount)) {
    issues.add(
      ["valuation", "amount"],
      "invalid_amount",
      `The amount is a number written like 1500 or 1500.00: no sign, at most ${String(MAX_VALUATION_DIGITS)} digits and two decimal places.`,
    );
  }
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    issues.add(["valuation", "currency"], "invalid_currency", "The currency is a code like USD.");
  }
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
