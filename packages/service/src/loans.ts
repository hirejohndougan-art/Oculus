/**
 * Loans in and out, and condition checks, through the service (T-018b with
 * T-018a and S-013, D-118; core: loans.ts and condition-checks.ts, D-044).
 *
 * **Loans are settled only inside the service** (D-067's rule for T-018a):
 * every save takes the organization's storage lock, reads the whole move
 * log, every loan and which accessions name which records itself, in its
 * own transaction, and has core check the result (`indexLoans`,
 * `withLoan`). Nothing a caller sends stands in for those reads (T-018a's
 * three failed attempts all came through a register handed in by the
 * caller). The overdue list is worked out on every read from what is
 * stored, so a later move, accession edit or location change can only add
 * problems, never hide a loan (D-118).
 *
 * **A move and its loan link in one save** (`recordLoanMove`): sending an
 * item out, bringing it back, its arrival and its departure are each
 * written with the loan edit naming them, or neither is.
 *
 * **Who.** Reading loans takes `records.view` from a whole-catalog grant on
 * any site, and shows only loans whose every record (items and the lender
 * or borrower) the person may view on its home site; another loan answers
 * like a missing one. Saving a loan takes `records.edit` on the home site of
 * each of its records, before and after the edit; the lender or borrower
 * must be an agent record. A loan move takes the same. A condition check
 * takes `records.edit` on its record's home site; its history,
 * `records.view`. System managers may do everything. Refusals that come
 * from other loans lose their numbers and paths (the person may not see
 * them).
 *
 * STAFF ONLY: nothing here is ever public.
 */
import {
  ROLE_PERMISSIONS,
  createConditionCheck,
  conditionHistory,
  createStorageMove,
  fitToMove,
  holdsForWholeCatalog,
  indexConditionChecks,
  indexLocations,
  indexLoans,
  indexMoves,
  isLoanId,
  isRecordId,
  issue,
  loanById,
  loanList,
  loanNumberKey,
  loanOutMove,
  loanState,
  newLoanId,
  overdueLoans,
  reindexLoans,
  unexplainedDepartures,
  unexplainedLoanMoves,
  validateLoan,
  withConditionCheck,
  withLoan,
  withMove,
  DEFAULT_STORAGE_LEVELS,
  type Access,
  type ConditionCheck,
  type ConditionLog,
  type FitToMove,
  type Issue,
  type Loan,
  type LoanBook,
  type LoanId,
  type LoanState,
  type MoveLog,
  type OrganizationId,
  type RecordId,
  type RolePermission,
  type StorageMove,
} from "@oculus/core";
import {
  insertConditionCheck,
  insertLoan,
  insertStorageMove,
  lockStorage,
  readAccessionRecordsMap,
  readConditionChecks,
  readLoanHistory,
  readLoans,
  readRecordPlace,
  readStorage,
  sql,
  storageNow,
  updateLoan,
  type Queryable,
  type StoredLoan,
  type StoredStorage,
} from "@oculus/db";
import { NOT_PERMITTED_MESSAGE, readAccess } from "./access.js";
import { hasOnly, own, type Runner } from "./admin.js";
import type { ServiceRefusal, ServiceResult } from "./service.js";

/** One loan as staff see it. */
export interface LoanView {
  readonly loan: Loan;
  /** Pass it as `expectedVersion` when saving the loan. */
  readonly version: number;
  readonly state: LoanState;
}

/** A loan with its fit-to-move warnings (T-018a). */
export interface LoanDetail extends LoanView {
  /**
   * Loan out items without a recent check saying they can travel: judged on
   * the day each went out, or today for items not sent yet. A warning, not
   * a refusal.
   */
  readonly fitWarnings: readonly FitToMove[];
}

/** One saved version of a loan, oldest first. */
export interface LoanVersion {
  readonly version: number;
  readonly loan: Loan;
  readonly savedBy: string;
  readonly savedAt: string;
}

/** Moves no loan explains: borrowed records gone and records sent out with no loan on file. */
export interface UnexplainedLoanMoves {
  readonly departures: readonly StorageMove[];
  readonly loanOutMoves: readonly StorageMove[];
}

export interface LoanOperations {
  listLoans(context: unknown): Promise<ServiceResult<readonly LoanView[]>>;
  readLoan(context: unknown, loanId: unknown): Promise<ServiceResult<LoanDetail>>;
  loanHistory(context: unknown, loanId: unknown): Promise<ServiceResult<readonly LoanVersion[]>>;
  /** A new loan when `loanId` is null (expected version 0). */
  saveLoan(
    context: unknown,
    loanId: unknown,
    loan: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<LoanView>>;
  /**
   * The next move of one item of an agreed loan, and the loan's link to it,
   * in one save: a loan out item goes to the borrower (`loan_out`, due back
   * on the loan's end date) or comes home (`return`); a loan in item arrives
   * (`placement`) or goes back to the lender (`departure`).
   */
  recordLoanMove(
    context: unknown,
    loanId: unknown,
    move: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<{ readonly move: StorageMove; readonly loan: LoanView }>>;
  overdueLoans(context: unknown): Promise<ServiceResult<readonly LoanState[]>>;
  unexplainedLoanMoves(context: unknown): Promise<ServiceResult<UnexplainedLoanMoves>>;
  recordConditionCheck(context: unknown, check: unknown): Promise<ServiceResult<ConditionCheck>>;
  conditionHistory(
    context: unknown,
    recordId: unknown,
  ): Promise<
    ServiceResult<{ readonly checks: readonly ConditionCheck[]; readonly fitToday: FitToMove }>
  >;
}

type Refusal = ServiceRefusal;

function refusal(path: (string | number)[], code: string, message: string): Refusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const NOT_PERMITTED = (): Refusal => refusal([], "not_permitted", NOT_PERMITTED_MESSAGE);
const UNKNOWN_LOAN = (): Refusal => refusal(["loanId"], "unknown_loan", "There is no such loan.");
const UNKNOWN_RECORD = (path: (string | number)[] = ["recordId"]): Refusal =>
  refusal(path, "unknown_record", "There is no such record here.");
const BAD_VERSION = (): Refusal =>
  refusal(
    ["options", "expectedVersion"],
    "invalid_version",
    "Give the version you edited (a whole number; 0 for a new one) as expectedVersion.",
  );
const CONFLICT = (): Refusal =>
  refusal(
    ["options", "expectedVersion"],
    "version_conflict",
    "It was saved by someone else since you opened it. Read it again.",
  );
const UNREADABLE = (): Refusal =>
  refusal(["loans"], "unreadable_loans", "The stored loans can't be read now.");

const LOAN_INPUT_KEYS = [
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
];
const LOAN_MOVE_KEYS = ["recordId", "locationId", "movedOn", "note"];
const CHECK_KEYS = [
  "recordId",
  "checkedOn",
  "checkedBy",
  "checkerId",
  "condition",
  "reason",
  "fitToMove",
  "loanId",
  "note",
];

function expectedOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A whole-catalog grant, on any site, of a role holding `permission` (or a system manager). */
function holdsSomewhere(access: Access, permission: RolePermission): boolean {
  if (access.systemManager) return true;
  return access.grants.some(
    (g) =>
      g.scope === null &&
      ((ROLE_PERMISSIONS[g.role] as readonly RolePermission[] | undefined)?.includes(permission) ??
        false),
  );
}

/**
 * Issues about other loans lose their numbers and paths: the person may
 * not see those loans. A core refusal of the edited loan keeps its own.
 */
function ownIssues(issues: readonly Issue[]): Refusal {
  return {
    ok: false,
    issues: issues.map((i) =>
      i.path[0] === "otherLoans"
        ? issue(["otherLoans"], i.code, "This edit would give another loan a problem.")
        : i,
    ),
  };
}

/** The records a loan names: its items and its lender or borrower. */
function recordsOf(loan: Loan): RecordId[] {
  return [loan.agentId, ...loan.items.map((i) => i.recordId)];
}

export function loanOperations(run: Runner): LoanOperations {
  async function accessOf(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
  ): Promise<{ ok: true; access: Access; userId: string } | Refusal> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    return { ok: true, access: access.value, userId: access.userId };
  }

  /** Whether the person may `permission` every record of `ids` on its home site. */
  async function mayAll(
    tx: Queryable,
    org: OrganizationId,
    access: Access,
    ids: readonly RecordId[],
    permission: "records.view" | "records.edit",
  ): Promise<boolean> {
    if (access.systemManager) return true;
    for (const id of new Set(ids)) {
      const place = await readRecordPlace(tx, org, id);
      if (place?.siteId == null || !holdsForWholeCatalog(access, permission, place.siteId)) {
        return false;
      }
    }
    return true;
  }

  function logOf(org: OrganizationId, stored: StoredStorage): MoveLog | undefined {
    const levels = stored.levels?.definition ?? {
      organizationId: org,
      levels: [...DEFAULT_STORAGE_LEVELS],
    };
    const index = indexLocations(
      levels,
      stored.locations.map((l) => l.definition),
    );
    if (!index.ok) return undefined;
    const log = indexMoves(index.value, stored.moves);
    return log.ok ? log.value : undefined;
  }

  interface Book {
    readonly log: MoveLog;
    readonly book: LoanBook;
    readonly stored: readonly StoredLoan[];
    readonly now: Date;
  }

  /**
   * The organization's whole loan book, from what is stored: the move log,
   * every loan and which accessions name which records, all read here.
   * With `exclusive`, under the storage lock held exclusive (a save).
   */
  async function bookOf(
    tx: Queryable,
    org: OrganizationId,
    exclusive: boolean,
  ): Promise<Book | undefined> {
    await lockStorage(tx, org, exclusive ? "exclusive" : "shared");
    const now = new Date(await storageNow(tx));
    const log = logOf(org, await readStorage(tx, org));
    if (log === undefined) return undefined;
    const stored = await readLoans(tx, org);
    const accessions = await readAccessionRecordsMap(tx, org);
    const book = indexLoans(
      log,
      stored.map((l) => l.definition),
      now,
      { accessions },
    );
    return book.ok ? { log, book: book.value, stored, now } : undefined;
  }

  function versionOf(b: Book, id: LoanId): number | undefined {
    return b.stored.find((l) => (l.definition as { id?: unknown }).id === id)?.version;
  }

  async function today(tx: Queryable, org: OrganizationId): Promise<string> {
    const [row] = await tx.rows<{ today: string | null }>(
      sql`SELECT public.organization_local_day(${org}::uuid) AS today`,
    );
    return row?.today ?? "";
  }

  async function conditionLogOf(
    tx: Queryable,
    org: OrganizationId,
  ): Promise<ConditionLog | undefined> {
    const checks = indexConditionChecks(org, await readConditionChecks(tx, org));
    return checks.ok ? checks.value : undefined;
  }

  /** Checks a candidate loan's records exist here, and the person may edit them all. */
  async function checkRecords(
    tx: Queryable,
    org: OrganizationId,
    access: Access,
    loan: Loan,
  ): Promise<Refusal | undefined> {
    const agent = await readRecordPlace(tx, org, loan.agentId);
    const mayAgent =
      agent !== undefined &&
      (access.systemManager ||
        (agent.siteId !== null && holdsForWholeCatalog(access, "records.edit", agent.siteId)));
    if (agent?.kind !== "agent" || !mayAgent) {
      return refusal(
        ["agentId"],
        "unknown_agent",
        "The lender or borrower is an agent record you may edit.",
      );
    }
    for (const [j, item] of loan.items.entries()) {
      const place = await readRecordPlace(tx, org, item.recordId);
      if (place === undefined) return UNKNOWN_RECORD(["items", j, "recordId"]);
      if (
        !access.systemManager &&
        (place.siteId === null || !holdsForWholeCatalog(access, "records.edit", place.siteId))
      ) {
        return place.siteId !== null && holdsForWholeCatalog(access, "records.view", place.siteId)
          ? NOT_PERMITTED()
          : UNKNOWN_RECORD(["items", j, "recordId"]);
      }
    }
    return undefined;
  }

  /** A loan the person may see, from the book, or a refusal like a missing one. */
  async function visibleLoan(
    tx: Queryable,
    org: OrganizationId,
    access: Access,
    b: Book,
    loanId: unknown,
    permission: "records.view" | "records.edit",
  ): Promise<{ ok: true; loan: Loan } | Refusal> {
    if (!isLoanId(loanId)) return UNKNOWN_LOAN();
    const loan = loanById(b.book, loanId);
    if (loan === undefined) return UNKNOWN_LOAN();
    if (!(await mayAll(tx, org, access, recordsOf(loan), "records.view"))) return UNKNOWN_LOAN();
    if (
      permission === "records.edit" &&
      !(await mayAll(tx, org, access, recordsOf(loan), "records.edit"))
    ) {
      return NOT_PERMITTED();
    }
    return { ok: true, loan };
  }

  function viewOf(book: LoanBook, loan: Loan, version: number): LoanView | undefined {
    const state = loanState(book, loan.id);
    return state.ok ? Object.freeze({ loan, version, state: state.value }) : undefined;
  }

  /** Saves `next` (checked by `withLoan` against `b`) as `expected` → the new view. */
  async function save(
    tx: Queryable,
    book: LoanBook,
    next: Loan,
    userId: string,
    expected: number,
  ): Promise<ServiceResult<LoanView>> {
    const key = loanNumberKey(next.number);
    const saved =
      expected === 0
        ? await insertLoan(tx, next, key, userId)
        : await updateLoan(tx, next, key, userId, expected);
    if (!saved.ok) {
      if (saved.code === "duplicate_number") {
        return refusal(
          ["loan", "number"],
          "duplicate_number",
          `Another loan ${next.direction} has this number.`,
        );
      }
      return saved.code === "missing_record" ? UNKNOWN_RECORD(["loan"]) : CONFLICT();
    }
    const view = viewOf(book, next, saved.value.version);
    return view === undefined ? UNREADABLE() : { ok: true, value: view };
  }

  return {
    listLoans(context) {
      return run("listLoans", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const b = await bookOf(tx, who.organizationId, false);
        if (b === undefined) return UNREADABLE();
        const loans = loanList(b.book);
        if (!loans.ok) return UNREADABLE();
        const out: LoanView[] = [];
        for (const loan of loans.value) {
          if (
            !(await mayAll(tx, who.organizationId, may.access, recordsOf(loan), "records.view"))
          ) {
            continue;
          }
          const view = viewOf(b.book, loan, versionOf(b, loan.id) ?? 0);
          if (view === undefined) return UNREADABLE();
          out.push(view);
        }
        return { ok: true, value: Object.freeze(out) };
      });
    },

    readLoan(context, loanId) {
      return run("readLoan", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const b = await bookOf(tx, who.organizationId, false);
        if (b === undefined) return UNREADABLE();
        const found = await visibleLoan(
          tx,
          who.organizationId,
          may.access,
          b,
          loanId,
          "records.view",
        );
        if (!found.ok) return found;
        const view = viewOf(b.book, found.loan, versionOf(b, found.loan.id) ?? 0);
        if (view === undefined) return UNREADABLE();
        const warnings: FitToMove[] = [];
        if (found.loan.direction === "out") {
          const checks = await conditionLogOf(tx, who.organizationId);
          if (checks === undefined) {
            return refusal(["checks"], "unreadable_checks", "The stored checks can't be read now.");
          }
          const day = await today(tx, who.organizationId);
          for (const item of view.state.items) {
            if (item.settledBy !== null && item.started === null) continue;
            const on = item.started?.movedOn ?? day;
            const fit = fitToMove(checks, item.recordId, { on });
            if (fit.ok && !fit.value.fit) warnings.push(fit.value);
          }
        }
        return {
          ok: true,
          value: Object.freeze({ ...view, fitWarnings: Object.freeze(warnings) }),
        };
      });
    },

    loanHistory(context, loanId) {
      return run("loanHistory", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const b = await bookOf(tx, who.organizationId, false);
        if (b === undefined) return UNREADABLE();
        const found = await visibleLoan(
          tx,
          who.organizationId,
          may.access,
          b,
          loanId,
          "records.view",
        );
        if (!found.ok) return found;
        const versions = await readLoanHistory(tx, who.organizationId, found.loan.id);
        return {
          ok: true,
          value: Object.freeze(
            versions.map((v) =>
              Object.freeze({
                version: v.version,
                loan: v.definition as Loan,
                savedBy: v.savedBy,
                savedAt: v.savedAt,
              }),
            ),
          ),
        };
      });
    },

    saveLoan(context, loanId, input, options) {
      return run("saveLoan", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.edit")) return NOT_PERMITTED();
        const expected = expectedOf(own(options, "expectedVersion"));
        if (expected === undefined) return BAD_VERSION();
        if (loanId !== null && !isLoanId(loanId)) return UNKNOWN_LOAN();
        if ((loanId === null) !== (expected === 0)) return BAD_VERSION();
        if (!hasOnly(input, LOAN_INPUT_KEYS)) {
          return refusal(
            ["loan"],
            "invalid_request",
            `A loan is given as ${LOAN_INPUT_KEYS.join(", ")}.`,
          );
        }
        const id = loanId ?? newLoanId();
        const candidate: Record<string, unknown> = { id, organizationId: who.organizationId };
        for (const key of LOAN_INPUT_KEYS) {
          const value = own(input, key);
          if (value !== undefined) candidate[key] = value;
        }
        const now = new Date(await storageNow(tx));
        const checked = validateLoan(candidate, now);
        if (!checked.ok) return { ok: false, issues: checked.issues };
        const next = checked.value;
        const records = await checkRecords(tx, who.organizationId, may.access, next);
        if (records !== undefined) return records;
        const b = await bookOf(tx, who.organizationId, true);
        if (b === undefined) return UNREADABLE();
        if (loanId !== null) {
          // The saved loan: one the person can see, editing every record it names now.
          const found = await visibleLoan(
            tx,
            who.organizationId,
            may.access,
            b,
            loanId,
            "records.edit",
          );
          if (!found.ok) return found;
          if (versionOf(b, found.loan.id) !== expected) return CONFLICT();
        } else if (loanById(b.book, id) !== undefined) {
          return CONFLICT();
        }
        const book = withLoan(b.book, next, b.now);
        if (!book.ok) return ownIssues(book.issues);
        return save(tx, book.value, next, may.userId, expected);
      });
    },

    recordLoanMove(context, loanId, input, options) {
      return run("recordLoanMove", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.edit")) return NOT_PERMITTED();
        const expected = expectedOf(own(options, "expectedVersion"));
        if (expected === undefined || expected === 0) return BAD_VERSION();
        if (!hasOnly(input, LOAN_MOVE_KEYS)) {
          return refusal(
            ["move"],
            "invalid_request",
            `A loan move is given as ${LOAN_MOVE_KEYS.join(", ")}.`,
          );
        }
        const b = await bookOf(tx, who.organizationId, true);
        if (b === undefined) return UNREADABLE();
        const found = await visibleLoan(
          tx,
          who.organizationId,
          may.access,
          b,
          loanId,
          "records.edit",
        );
        if (!found.ok) return found;
        if (versionOf(b, found.loan.id) !== expected) return CONFLICT();
        const loan = found.loan;
        const recordId = own(input, "recordId");
        const j = loan.items.findIndex((i) => i.recordId === recordId);
        const state = loanState(b.book, loan.id);
        const item = loan.items[j];
        const itemState = state.ok ? state.value.items[j] : undefined;
        if (!isRecordId(recordId) || item === undefined || itemState === undefined) {
          return refusal(
            ["move", "recordId"],
            "not_on_loan",
            "This record isn't one of the loan's items.",
          );
        }
        if (loan.status !== "agreed") {
          return refusal(["loanId"], "not_agreed", `A ${loan.status} loan moves nothing.`);
        }
        if (itemState.settledBy !== null) {
          return refusal(
            ["move", "recordId"],
            "item_settled",
            "This item is settled on this loan; record a new loan for it.",
          );
        }
        const begun = itemState.started !== null || itemState.continues !== null;
        const out = loan.direction === "out";
        const reason = out ? (begun ? "return" : "loan_out") : begun ? "departure" : "placement";
        let fields: Record<string, unknown>;
        if (reason === "loan_out") {
          const planned = loanOutMove(
            loan,
            recordId,
            own(input, "locationId"),
            own(input, "movedOn"),
          );
          if (!planned.ok) return { ok: false, issues: planned.issues };
          fields = { ...planned.value };
        } else {
          fields = {
            organizationId: who.organizationId,
            recordId,
            locationId: own(input, "locationId"),
            movedOn: own(input, "movedOn"),
            reason,
          };
        }
        const note = own(input, "note");
        if (note !== undefined) fields.note = note;
        const now = await storageNow(tx);
        const made = createStorageMove(fields as never, new Date(now));
        if (!made.ok) return { ok: false, issues: made.issues };
        const log = withMove(b.log, made.value, new Date(now));
        if (!log.ok) {
          return {
            ok: false,
            issues: log.issues.map((i) => issue(["move"], i.code, i.message)),
          };
        }
        const key = out
          ? begun
            ? "returnMoveId"
            : "loanOutMoveId"
          : begun
            ? "departureMoveId"
            : "arrivalMoveId";
        const items = loan.items.map((i, k) => (k === j ? { ...i, [key]: made.value.id } : i));
        const next = { ...loan, items } as Loan;
        const moved = reindexLoans(b.book, log.value);
        if (!moved.ok) return UNREADABLE();
        const book = withLoan(moved.value, next, new Date(now));
        if (!book.ok) return ownIssues(book.issues);
        const written = await insertStorageMove(
          tx,
          who.organizationId,
          made.value.id,
          made.value,
          may.userId,
          made.value.recordedAt,
        );
        if (!written.ok) return UNKNOWN_RECORD(["move", "recordId"]);
        const saved = await save(tx, book.value, next, may.userId, expected);
        if (!saved.ok) return saved;
        return { ok: true, value: Object.freeze({ move: made.value, loan: saved.value }) };
      });
    },

    overdueLoans(context) {
      return run("overdueLoans", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const b = await bookOf(tx, who.organizationId, false);
        if (b === undefined) return UNREADABLE();
        const late = overdueLoans(b.book, await today(tx, who.organizationId));
        if (!late.ok) {
          return refusal(["today"], "unreadable_loans", "Today's date can't be worked out now.");
        }
        const out: LoanState[] = [];
        for (const state of late.value) {
          if (
            await mayAll(tx, who.organizationId, may.access, recordsOf(state.loan), "records.view")
          ) {
            out.push(state);
          }
        }
        return { ok: true, value: Object.freeze(out) };
      });
    },

    unexplainedLoanMoves(context) {
      return run("unexplainedLoanMoves", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const b = await bookOf(tx, who.organizationId, false);
        if (b === undefined) return UNREADABLE();
        const gone = unexplainedDepartures(b.book);
        const sent = unexplainedLoanMoves(b.book);
        if (!gone.ok || !sent.ok) return UNREADABLE();
        const visible = async (moves: readonly StorageMove[]): Promise<StorageMove[]> => {
          const kept: StorageMove[] = [];
          for (const m of moves) {
            if (await mayAll(tx, who.organizationId, may.access, [m.recordId], "records.view")) {
              kept.push(m);
            }
          }
          return kept;
        };
        return {
          ok: true,
          value: Object.freeze({
            departures: Object.freeze(await visible(gone.value)),
            loanOutMoves: Object.freeze(await visible(sent.value)),
          }),
        };
      });
    },

    recordConditionCheck(context, input) {
      return run("recordConditionCheck", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!hasOnly(input, CHECK_KEYS)) {
          return refusal(
            ["check"],
            "invalid_request",
            `A condition check is given as ${CHECK_KEYS.join(", ")}.`,
          );
        }
        const recordId = own(input, "recordId");
        if (!isRecordId(recordId)) return UNKNOWN_RECORD();
        const place = await readRecordPlace(tx, who.organizationId, recordId);
        if (place === undefined) return UNKNOWN_RECORD();
        if (!(await mayAll(tx, who.organizationId, may.access, [recordId], "records.edit"))) {
          return (await mayAll(tx, who.organizationId, may.access, [recordId], "records.view"))
            ? NOT_PERMITTED()
            : UNKNOWN_RECORD();
        }
        const checkerId = own(input, "checkerId");
        if (checkerId !== undefined) {
          const checker = isRecordId(checkerId)
            ? await readRecordPlace(tx, who.organizationId, checkerId)
            : undefined;
          if (
            checker?.kind !== "agent" ||
            !(await mayAll(
              tx,
              who.organizationId,
              may.access,
              [checkerId as RecordId],
              "records.view",
            ))
          ) {
            return refusal(["checkerId"], "unknown_agent", "The checker is an agent record.");
          }
        }
        // Under the storage lock: a check naming a loan is checked against the stored loans.
        const b = await bookOf(tx, who.organizationId, true);
        if (b === undefined) return UNREADABLE();
        const loanId = own(input, "loanId");
        if (loanId !== undefined) {
          const loan = isLoanId(loanId) ? loanById(b.book, loanId) : undefined;
          if (!loan?.items.some((i) => i.recordId === recordId)) {
            return refusal(
              ["loanId"],
              "unknown_loan",
              "The loan a check is made for is one of ours listing this record.",
            );
          }
        }
        const fields: Record<string, unknown> = { organizationId: who.organizationId };
        for (const key of CHECK_KEYS) {
          const value = own(input, key);
          if (value !== undefined) fields[key] = value;
        }
        const now = new Date(await storageNow(tx));
        const made = createConditionCheck(fields as never, now);
        if (!made.ok) return { ok: false, issues: made.issues };
        const checks = await conditionLogOf(tx, who.organizationId);
        if (checks === undefined) {
          return refusal(["checks"], "unreadable_checks", "The stored checks can't be read now.");
        }
        const next = withConditionCheck(checks, made.value, now);
        if (!next.ok) return { ok: false, issues: next.issues };
        const saved = await insertConditionCheck(
          tx,
          who.organizationId,
          made.value.id,
          made.value,
          may.userId,
          made.value.recordedAt,
        );
        if (!saved.ok) return UNKNOWN_RECORD();
        return { ok: true, value: made.value };
      });
    },

    conditionHistory(context, recordId) {
      return run("conditionHistory", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!isRecordId(recordId)) return UNKNOWN_RECORD();
        const place = await readRecordPlace(tx, who.organizationId, recordId);
        if (place === undefined) return UNKNOWN_RECORD();
        if (!(await mayAll(tx, who.organizationId, may.access, [recordId], "records.view"))) {
          return UNKNOWN_RECORD();
        }
        const checks = await conditionLogOf(tx, who.organizationId);
        if (checks === undefined) {
          return refusal(["checks"], "unreadable_checks", "The stored checks can't be read now.");
        }
        const history = conditionHistory(checks, recordId);
        const fit = fitToMove(checks, recordId, { on: await today(tx, who.organizationId) });
        if (!history.ok || !fit.ok) {
          return refusal(["checks"], "unreadable_checks", "The stored checks can't be read now.");
        }
        return {
          ok: true,
          value: Object.freeze({ checks: history.value, fitToday: fit.value }),
        };
      });
    },
  };
}
