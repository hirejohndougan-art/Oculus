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
 * Memory is bounded and every request costs O(1), amortized (S-060a, from
 * the Phase 2 security review's L2). Windows are kept in a queue in the
 * order they started, with a moving head, so ended ones are dropped from the
 * front without scanning; past `MAX_TRACKED`, the oldest window still
 * counting is dropped too, and that key starts a fresh window at its next
 * request (bounded memory can't remember every key; the database's own
 * throttles stay behind the per-address brakes). A window that has reached
 * its limit moves to a second queue and is kept until it ends, so a flood
 * of other keys can't reset a limited one; that queue keeps the
 * `MAX_LIMITED` most recently limited, a bound only hundreds of thousands
 * of refused-to-be requests a minute could reach.
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

/**
 * Windows by key, with the order they were added kept in an array and a
 * head index: dropping from the front is O(1) and never restarts a scan.
 * An entry whose key now holds another window (or none) is skipped.
 */
class WindowQueue {
  private readonly byKey = new Map<string, RateWindow>();
  private order: { readonly key: string; readonly window: RateWindow }[] = [];
  private head = 0;

  constructor(private readonly max: number) {}

  get size(): number {
    return this.byKey.size;
  }

  get(key: string): RateWindow | undefined {
    return this.byKey.get(key);
  }

  delete(key: string): void {
    this.byKey.delete(key);
  }

  /** Adds `window` for `key` at the back, after dropping ended windows and, if full, the oldest. */
  add(key: string, window: RateWindow, now: number): void {
    this.byKey.delete(key);
    while (this.head < this.order.length) {
      const first = this.order[this.head];
      if (first === undefined) break;
      const current = this.byKey.get(first.key) === first.window;
      if (current && !ended(first.window, now) && this.byKey.size < this.max) break;
      if (current) this.byKey.delete(first.key);
      this.head++;
    }
    this.byKey.set(key, window);
    this.order.push({ key, window });
    // Entries skipped and dropped are let go in batches (amortized O(1));
    // so are stale ones piling up behind a window still counting.
    if (this.head > 1024 && this.head * 2 > this.order.length) {
      this.order = this.order.slice(this.head);
      this.head = 0;
    } else if (this.order.length - this.head > 2 * this.max + 1024) {
      this.order = this.order.slice(this.head).filter((e) => this.byKey.get(e.key) === e.window);
      this.head = 0;
    }
  }
}

export class SessionRateLimiter {
  /** Windows still under their limit, oldest start first. */
  private readonly windows = new WindowQueue(MAX_TRACKED);
  /** Windows at their limit, kept until they end (or past `MAX_LIMITED`, oldest first). */
  private readonly limited = new WindowQueue(MAX_LIMITED);

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
      window = { start: now, count: 0 };
      this.windows.add(key, window, now);
    }
    window.count++;
    if (window.count >= limit) {
      this.windows.delete(key);
      this.limited.add(key, window, now);
    }
    return true;
  }

  /** How many windows are kept (for tests). */
  get size(): number {
    return this.windows.size + this.limited.size;
  }
}
