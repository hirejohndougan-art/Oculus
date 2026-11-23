/**
 * The holds of an accession register (T-016 and T-016a, decisions D-043
 * and D-056), in a
 * module of its own so that `effective.ts` and `public-output.ts` can run
 * the deed check without importing `accessions.ts`, and so without ever
 * holding an accession, a donor's name or contact details, materials,
 * restrictions, a restriction's end date or an accession number. What a
 * register made by `indexAccessions` shares here is only its organization,
 * the IDs of the records it holds back from publishing and why (a deed or a
 * restriction, never which one or until when). For other modules in this
 * package only: not exported from the package.
 */
import type { OrganizationId } from "./organizations.js";
import type { RecordId } from "./record-id.js";

/**
 * Why a record is held back: `deed`, an accession whose deed of gift is
 * needed but not signed; `restriction`, an accession whose structured access
 * restriction is in force on the register's day.
 */
export type HoldReason = "deed" | "restriction";

/** What a register shares with the publish check. Nothing else. */
export interface DeedHolds {
  readonly organizationId: OrganizationId;
  /**
   * Records held back, for any reason: produced by an accession that holds
   * (its deed of gift is needed but not signed, or a restriction is in force
   * on the register's day), filed below one, or a digital asset representing
   * one, as the records were when the register was made.
   */
  isHeld(id: RecordId): boolean;
  /** Why `id` is held back; empty when it isn't. */
  holdReasons(id: RecordId): readonly HoldReason[];
  /** True for a record the register was made with, held back or not. */
  isKnown(id: RecordId): boolean;
}

const HOLDS = new WeakMap<object, DeedHolds>();

/** For `accessions.ts` only. */
export function markDeedHolds(register: object, holds: DeedHolds): void {
  HOLDS.set(register, Object.freeze(holds));
}

/** The holds of a register made by `indexAccessions`, or undefined for anything else. Never throws. */
export function deedHoldsOf(value: unknown): DeedHolds | undefined {
  return typeof value === "object" && value !== null ? HOLDS.get(value) : undefined;
}
