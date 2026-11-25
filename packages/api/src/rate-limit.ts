/**
 * A per-session request limit (T-042, D-079): cheap, in memory, one fixed
 * one-minute window per session and kind of request. It is a brake on one
 * signed-in browser or script hammering the API (a search loop, a stuck
 * retry), not a defence against an attacker without a session, who is
 * refused before any of this (no session, 401) and whose cost is one
 * indexed lookup. Counts live in this process only: they restart with the
 * server, and several processes would each count on their own (D-035: one
 * process is the expected deployment).
 *
 * Memory is bounded and every request costs O(1) (S-060a, from the Phase 2
 * security review's L2). Windows still counting are kept in the order they
 * started, so ended ones are always at the front and are dropped from
 * there; past `MAX_TRACKED`, the oldest still counting is dropped too, which
 * can only give that key back what it had left. A window that has reached
 * its limit moves to a second list and is never dropped before it ends, so
 * a flood of other keys can't reset a limited one; that list keeps the
 * `MAX_LIMITED` most recently limited, a bound only a flood of millions of
 * requests a minute could reach.
 */

/**
 * The kinds of request counted apart, each with its own limit per minute.
 * `credentials` counts sign-in, code, set-up and password-reset posts per
 * client address (T-045, D-081), before the database's own throttles.
 * `public` counts a public site's record reads per client address (T-050d,
 * D-100).
 */
export type RateBucket = "read" | "write" | "check" | "search" | "credentials" | "public" | "oai";

export type RateLimits = Readonly<Record<RateBucket, number>>;

/** Requests per minute per session: generous for people, tight for loops. */
export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  read: 600,
  write: 120,
  check: 600,
  search: 60,
  credentials: 60,
  public: 300,
  // OAI-PMH requests (T-050c, D-105): each reads up to a page of records.
  oai: 12,
});

const WINDOW_MS = 60_000;
const MAX_TRACKED = 50_000;
const MAX_LIMITED = 50_000;

interface RateWindow {
  readonly start: number;
  count: number;
}

/** A window is over a minute after it started, or at once if the clock went back. */
function ended(window: RateWindow, now: number): boolean {
  return now - window.start >= WINDOW_MS || now < window.start;
}

/** Drops ended windows from the front of `map` (oldest first), then the oldest past `max - 1`. */
function makeRoom(map: Map<string, RateWindow>, now: number, max: number): void {
  for (const [key, window] of map) {
    if (!ended(window, now)) break;
    map.delete(key);
  }
  for (const key of map.keys()) {
    if (map.size < max) break;
    map.delete(key);
  }
}

export class SessionRateLimiter {
  /** Windows still under their limit, oldest start first. */
  private readonly windows = new Map<string, RateWindow>();
  /** Windows at their limit, kept until they end (or past `MAX_LIMITED`, oldest first). */
  private readonly limited = new Map<string, RateWindow>();

  constructor(
    private readonly limits: RateLimits = DEFAULT_RATE_LIMITS,
    private readonly clock: () => number = Date.now,
  ) {
    for (const [bucket, limit] of Object.entries(limits)) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
        throw new RangeError(`rate limit ${bucket} must be a whole number from 1 to 1,000,000`);
      }
    }
  }

  /**
   * Counts one request of `bucket` for the session; false when the
   * session has used up its limit for this minute (not counted then).
   */
  take(sessionId: string, bucket: RateBucket): boolean {
    const now = this.clock();
    const key = `${bucket}:${sessionId}`;
    const limit = this.limits[bucket];
    const held = this.limited.get(key);
    if (held !== undefined) {
      if (!ended(held, now)) return false;
      this.limited.delete(key);
    }
    let window = this.windows.get(key);
    if (window === undefined || ended(window, now)) {
      // Deleted first, so a new window goes to the end of the start order.
      this.windows.delete(key);
      makeRoom(this.windows, now, MAX_TRACKED);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count >= limit) {
      this.windows.delete(key);
      makeRoom(this.limited, now, MAX_LIMITED);
      this.limited.set(key, window);
    }
    return true;
  }

  /** How many windows are kept (for tests). */
  get size(): number {
    return this.windows.size + this.limited.size;
  }
}
