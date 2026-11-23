/**
 * What an accession register shares with the loan book (T-018a1, decision
 * D-059), in a module of its own so that `loans.ts` can tell a borrowed
 * record the organization has since acquired without importing
 * `accessions.ts` (as `accession-holds.ts` does for the publish check).
 *
 * A register made by `indexAccessions` shares here only its organization
 * and, per loan in an accession names (`loanInId`), each such accession's
 * ID, the records it produced, the day it was received and whether title has
 * passed (its deed is signed or not needed). Never a donor, number,
 * materials, restrictions or notes. For other modules in this package only:
 * not exported from the package.
 */
import type { OrganizationId } from "./organizations.js";
import type { RecordId } from "./record-id.js";

/** One accession that names a loan in: the records it took into the collection. */
export interface LoanAcquisition {
  /** The accession's ID. */
  readonly accessionId: string;
  /** The records it produced. */
  readonly recordIds: readonly RecordId[];
  /** The day it was received, `YYYY-MM-DD`. */
  readonly receivedOn: string;
  /**
   * True when the records are the organization's: the deed of gift is signed
   * or not needed. A gift whose deed is missing or sent hasn't passed title.
   */
  readonly titlePassed: boolean;
}

/** What a register shares with the loan book. Nothing else. */
export interface LoanAcquisitions {
  readonly organizationId: OrganizationId;
  /** The accessions naming `loanId` as the loan in they came from, in register order. */
  acquisitionsOf(loanId: string): readonly LoanAcquisition[];
}

const ACQUISITIONS = new WeakMap<object, LoanAcquisitions>();

/** For `accessions.ts` only. */
export function markLoanAcquisitions(register: object, found: LoanAcquisitions): void {
  ACQUISITIONS.set(register, Object.freeze(found));
}

/** The loan links of a register made by `indexAccessions`, or undefined for anything else. Never throws. */
export function loanAcquisitionsOf(value: unknown): LoanAcquisitions | undefined {
  return typeof value === "object" && value !== null ? ACQUISITIONS.get(value) : undefined;
}
