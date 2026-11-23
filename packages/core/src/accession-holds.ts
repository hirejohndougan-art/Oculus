/**
 * The deed holds of an accession register (T-016, decision D-043), in a
 * module of its own so that `effective.ts` and `public-output.ts` can run
 * the deed check without importing `accessions.ts`, and so without ever
 * holding an accession, a donor's name or contact details, materials,
 * restrictions or an accession number. What a register made by
 * `indexAccessions` shares here is only its organization and the IDs of the
 * records it holds back from publishing. For other modules in this package
 * only: not exported from the package.
 */
import type { OrganizationId } from "./organizations.js";
import type { RecordId } from "./record-id.js";

/** What a register shares with the publish check. Nothing else. */
export interface DeedHolds {
  readonly organizationId: OrganizationId;
  /**
   * Records held back: produced by an accession whose deed of gift is needed
   * but not signed (`missing` or `sent`), filed below one, or a digital
   * asset representing one, as the records were when the register was made.
   */
  readonly held: ReadonlySet<RecordId>;
  /** Every record the register was made with, held back or not. */
  readonly known: ReadonlySet<RecordId>;
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
