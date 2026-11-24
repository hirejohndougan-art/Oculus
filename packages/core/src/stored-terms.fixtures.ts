/**
 * TEST HELPERS ONLY (left out of the build like every `.fixtures.ts` file).
 *
 * `findNearDuplicateTerms` and `findLcTermsWithoutUri` take one
 * organization's `OrganizationTerm` entries and the organization expected
 * (D-071). Most of their tests are about the comparison, not organizations,
 * so they call these wrappers with bare terms: each slot of an ordinary list
 * becomes an entry of `TEST_ORGANIZATION`, slot by slot, keeping holes as
 * holes. A getter or hidden slot becomes an entry whose `term` has that
 * slot's descriptor (a getter, or hidden), so the old getter and hidden-slot
 * attacks in the term report tests now exercise a getter or hidden **term**
 * of an entry, which is skipped as `not_plain_data`. A getter or hidden
 * **slot** refuses the whole list; that is tested directly in
 * `stored-terms.attacks.test.ts`, without this wrapper. Anything
 * that isn't an ordinary list is passed through unchanged, so the list checks
 * still see it. The organization rules are tested directly, without these.
 */
import { types } from "node:util";
import type { OrganizationId } from "./organizations.js";
import { findNearDuplicateTerms, type DuplicateOptions } from "./term-duplicates.js";
import { findLcTermsWithoutUri, type TermsWithoutUriOptions } from "./term-uri-report.js";

export const TEST_ORGANIZATION = "6d1f6f0e-3c0b-4a8e-9b51-2f6f2f6a9c11" as OrganizationId;

/** Bare terms as entries of `organizationId` (see the header). */
export function asOrganizationTerms(
  terms: unknown,
  organizationId: OrganizationId = TEST_ORGANIZATION,
): unknown {
  if (
    !Array.isArray(terms) ||
    types.isProxy(terms) ||
    Object.getPrototypeOf(terms) !== Array.prototype
  ) {
    return terms;
  }
  const list = terms as unknown[];
  const out: unknown[] = new Array<unknown>(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(list, i);
    if (slot === undefined) continue;
    if ("value" in slot && slot.enumerable === true) {
      out[i] = { organizationId, term: slot.value as unknown };
    } else {
      const entry: Record<string, unknown> = { organizationId };
      // The slot's own descriptor (a getter, or hidden), moved onto `term`.
      Object.defineProperty(entry, "term", slot);
      out[i] = entry;
    }
  }
  return out;
}

/** `findNearDuplicateTerms` over bare terms of `TEST_ORGANIZATION`. */
export function findNearDuplicatesOf(
  terms: unknown,
  options?: DuplicateOptions,
): ReturnType<typeof findNearDuplicateTerms> {
  return findNearDuplicateTerms(asOrganizationTerms(terms), TEST_ORGANIZATION, options);
}

/** `findLcTermsWithoutUri` over bare terms of `TEST_ORGANIZATION`. */
export function findLcTermsWithoutUriOf(
  terms: unknown,
  options?: TermsWithoutUriOptions,
): ReturnType<typeof findLcTermsWithoutUri> {
  return findLcTermsWithoutUri(asOrganizationTerms(terms), TEST_ORGANIZATION, options);
}
