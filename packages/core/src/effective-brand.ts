/**
 * Marks the effective records `effectiveRecord` makes (D-013), in a module of
 * its own so `rights.ts` can recognise one without importing `effective.ts`
 * (which imports `rights.ts`). `rightsPublishIssues` refuses an effective
 * record, because only `effectivePublishIssues` applies the visibility rule.
 */
import type { ArchivalLevel, CatalogRecord } from "./records.js";
import type { FieldTemplate } from "./templates.js";

const EFFECTIVE = new WeakSet<object>();

/** For `effective.ts` only: not exported from the package. */
export function markEffective(record: object): void {
  EFFECTIVE.add(record);
}

/** True for a result that `effectiveRecord` returned (not a copy of one). Never throws. */
export function isEffectiveRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && EFFECTIVE.has(value);
}

/**
 * What a public view from `publicView` was made from, kept beside it so that
 * public output (T-010, `public-output.ts`) can recognise a real public view
 * and find the checks it needs without being handed them by the caller: the
 * effective record (for `effectivePublishIssues`), the validated template the
 * view was built with (for each field's kind and list options), and the
 * record's arrangement level, and every record on the way up with the
 * template it was read with (so a template changed since, the record's own
 * or an ancestor's, can be refused). Nothing here is published as it is.
 */
export interface PublicViewOrigin {
  readonly effective: object;
  readonly template: FieldTemplate;
  /** The record first, then its ancestors, each with the validated template used for it. */
  readonly chain: readonly { readonly record: CatalogRecord; readonly template: FieldTemplate }[];
  /** For archival units only. */
  readonly level?: ArchivalLevel;
}

const PUBLIC_VIEW_ORIGINS = new WeakMap<object, PublicViewOrigin>();

/** For `effective.ts` only: not exported from the package. */
export function markPublicView(view: object, origin: PublicViewOrigin): void {
  PUBLIC_VIEW_ORIGINS.set(view, Object.freeze(origin));
}

/** Where a public view came from, or undefined for anything `publicView` didn't return. Never throws. */
export function publicViewOrigin(value: unknown): PublicViewOrigin | undefined {
  return typeof value === "object" && value !== null ? PUBLIC_VIEW_ORIGINS.get(value) : undefined;
}
