/**
 * System settings: the install-wide settings only system managers read or
 * change (D-019, D-025, D-072).
 *
 * Today they hold the sign-in rules that exist: how long a session lasts
 * (30 minutes idle, John's answer to Q-8 in T-062 and D-098, and D-052's 12
 * hours absolute by default, within the bounds
 * D-069 lets a session be made with: idle 5 minutes to 12 hours, absolute 1
 * to 24 hours, idle no longer than absolute). Sites are System settings too,
 * kept in their own table. Email, backups, updates and site passwords join
 * as their tasks build them (T-040, T-051, T-019d, T-048a), each with its
 * own checked key; an unknown key is refused, never kept. **No secret
 * (an email password, a backup key, a site password or its hash) goes in
 * this document:** every change of it is copied for good into the
 * append-only change log (migration 0058, D-117). Secrets get a table of
 * their own.
 */
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";

export interface SystemSettings {
  /** Minutes a session may sit unused before it ends. */
  readonly sessionIdleMinutes: number;
  /** Minutes from sign-in after which a session ends whatever happens. */
  readonly sessionAbsoluteMinutes: number;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = Object.freeze({
  sessionIdleMinutes: 30,
  sessionAbsoluteMinutes: 720,
});

/** The bounds of each number, inclusive. */
export const SYSTEM_SETTING_BOUNDS: Readonly<
  Record<keyof SystemSettings, { readonly min: number; readonly max: number }>
> = Object.freeze({
  sessionIdleMinutes: Object.freeze({ min: 5, max: 720 }),
  sessionAbsoluteMinutes: Object.freeze({ min: 60, max: 1440 }),
});

const KEYS = Object.keys(DEFAULT_SYSTEM_SETTINGS) as (keyof SystemSettings)[];

/**
 * Checks a whole settings document from untrusted input: every key present,
 * no others, each a whole number within its bounds, and idle no longer than
 * absolute. Own data properties only (no getters run). A fresh frozen copy,
 * or every problem.
 */
export function validateSystemSettings(input: unknown): Validated<SystemSettings> {
  if (types.isProxy(input) || !isPlainObject(input)) {
    return {
      ok: false,
      issues: [issue([], "not_an_object", "System settings are a plain object.")],
    };
  }
  const issues: Issue[] = [];
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(input);
  } catch {
    return { ok: false, issues: [issue([], "unreadable", "The settings could not be read.")] };
  }
  for (const key of keys) {
    if (typeof key !== "string" || !(KEYS as string[]).includes(key)) {
      issues.push(issue([String(key)], "unknown_setting", "There is no such system setting."));
    }
  }
  const copy: Record<string, number> = {};
  for (const key of KEYS) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    const value: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
    const { min, max } = SYSTEM_SETTING_BOUNDS[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      issues.push(
        issue(
          [key],
          "invalid_setting",
          `This is a whole number of minutes from ${String(min)} to ${String(max)}.`,
        ),
      );
    } else {
      copy[key] = value;
    }
  }
  if (issues.length === 0 && (copy.sessionIdleMinutes ?? 0) > (copy.sessionAbsoluteMinutes ?? 0)) {
    issues.push(
      issue(
        ["sessionIdleMinutes"],
        "idle_longer_than_absolute",
        "A session can't stay unused for longer than it may last at all.",
      ),
    );
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: Object.freeze(copy) as unknown as SystemSettings };
}
