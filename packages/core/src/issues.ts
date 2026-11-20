/**
 * Validation results.
 *
 * Validators never throw on bad input and never "fix" it silently. They
 * return every problem they find, each with the path to the bad value, a
 * stable code that software can check, and a plain-English message for the
 * person who has to fix it.
 */

/** One problem found while validating. */
export interface Issue {
  /** Where the problem is, e.g. `["fields", "date"]`. Empty for the whole value. */
  readonly path: readonly (string | number)[];
  /** A stable, machine-readable code such as `"required"` or `"too_long"`. */
  readonly code: string;
  /** A plain-English explanation. */
  readonly message: string;
}

/** The result of validating untrusted input. */
export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

export function issue(path: readonly (string | number)[], code: string, message: string): Issue {
  return { path, code, message };
}

/** True for a plain object (`{}`), not an array, null, class instance or function. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
