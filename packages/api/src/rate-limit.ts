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
 * Memory is bounded: at most `MAX_TRACKED` windows are kept; past that,
 * ended windows are dropped first, then the oldest.
 */

/** The kinds of request counted apart, each with its own limit per minute. */
export type RateBucket = "read" | "write" | "check" | "search";

export type RateLimits = Readonly<Record<RateBucket, number>>;

/** Requests per minute per session: generous for people, tight for loops. */
export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  read: 600,
  write: 120,
  check: 600,
  search: 60,
});

const WINDOW_MS = 60_000;
const MAX_TRACKED = 50_000;

export class SessionRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

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
    const window = this.windows.get(key);
    if (window === undefined || now - window.start >= WINDOW_MS || now < window.start) {
      this.windows.delete(key);
      this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (window.count >= this.limits[bucket]) return false;
    window.count++;
    return true;
  }

  /** How many windows are kept (for tests). */
  get size(): number {
    return this.windows.size;
  }

  private prune(now: number): void {
    if (this.windows.size < MAX_TRACKED) return;
    for (const [key, w] of this.windows) {
      if (now - w.start >= WINDOW_MS || now < w.start) this.windows.delete(key);
    }
    // Insertion order is oldest first.
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_TRACKED) break;
      this.windows.delete(key);
    }
  }
}
