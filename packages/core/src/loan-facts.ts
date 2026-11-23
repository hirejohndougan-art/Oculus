/**
 * What a loan book shares with condition checks (T-018a2, decision D-059),
 * in a module of its own so that `condition-checks.ts` can check a check's
 * `loanId` against the loan book, and list loans out whose items went
 * without a recent fit-to-move check, without importing `loans.ts`.
 *
 * A book made by `indexLoans`, `withLoan` or `reindexLoans` shares here only
 * its organization and, per loan, its ID, direction, status and items (each
 * record, and the day and recorded time of its linked start move). Never a number,
 * agent, valuation, insurance, terms or notes. For other modules in this
 * package only: not exported from the package.
 */
import type { OrganizationId } from "./organizations.js";
import type { RecordId } from "./record-id.js";

/** One item of a loan. */
export interface LoanFactItem {
  readonly recordId: RecordId;
  /**
   * The item's linked start move, its `loan_out` (loan out) or arrival
   * (loan in): the day it happened and when it was written down. Null while
   * none is linked, or when the named move isn't in the move log.
   */
  readonly started: { readonly on: string; readonly recordedAt: string } | null;
  /** True when the loan names a start move for the item, found in the log or not. */
  readonly startNamed: boolean;
}

/** One loan, as condition checks see it. */
export interface LoanFact {
  readonly id: string;
  readonly direction: "in" | "out";
  readonly status: string;
  readonly items: readonly LoanFactItem[];
}

/** What a loan book shares with condition checks. Nothing else. */
export interface LoanFacts {
  readonly organizationId: OrganizationId;
  /** One loan, or undefined. */
  loan(id: string): LoanFact | undefined;
  /** Every loan, in the book's order. */
  readonly loans: readonly LoanFact[];
}

const FACTS = new WeakMap<object, LoanFacts>();

/** For `loans.ts` only. */
export function markLoanFacts(book: object, facts: LoanFacts): void {
  FACTS.set(book, Object.freeze(facts));
}

/** The facts of a book made by `loans.ts`, or undefined for anything else. Never throws. */
export function loanFactsOf(value: unknown): LoanFacts | undefined {
  return typeof value === "object" && value !== null ? FACTS.get(value) : undefined;
}
