/**
 * Marks the effective records `effectiveRecord` makes (D-013), in a module of
 * its own so `rights.ts` can recognise one without importing `effective.ts`
 * (which imports `rights.ts`). `rightsPublishIssues` refuses an effective
 * record, because only `effectivePublishIssues` applies the visibility rule.
 */
const EFFECTIVE = new WeakSet<object>();

/** For `effective.ts` only: not exported from the package. */
export function markEffective(record: object): void {
  EFFECTIVE.add(record);
}

/** True for a result that `effectiveRecord` returned (not a copy of one). Never throws. */
export function isEffectiveRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && EFFECTIVE.has(value);
}
