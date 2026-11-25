// The per-session request limit (T-042, D-079): one window a minute per
// session and kind, independent sessions and kinds, a clock that goes back,
// bounded memory, keys at their limit that a flood of other keys can't
// reset (S-060a), and refused limits.
import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter } from "./rate-limit.js";

describe("SessionRateLimiter", () => {
  it("allows the limit in a minute, then refuses until the next window", () => {
    let now = 0;
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, search: 2 }, () => now);
    expect([1, 2, 3].map(() => limiter.take("s1", "search"))).toEqual([true, true, false]);
    now = 59_999;
    expect(limiter.take("s1", "search")).toBe(false);
    now = 60_000;
    expect(limiter.take("s1", "search")).toBe(true);
  });

  it("counts sessions and kinds apart", () => {
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, write: 1 }, () => 5);
    expect(limiter.take("a", "write")).toBe(true);
    expect(limiter.take("a", "write")).toBe(false);
    expect(limiter.take("b", "write")).toBe(true);
    expect(limiter.take("a", "read")).toBe(true);
  });

  it("starts a new window when the clock goes back", () => {
    let now = 100_000;
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, read: 1 }, () => now);
    expect(limiter.take("a", "read")).toBe(true);
    expect(limiter.take("a", "read")).toBe(false);
    now = 1_000;
    expect(limiter.take("a", "read")).toBe(true);
  });

  it("keeps memory bounded", () => {
    let now = 0;
    const limiter = new SessionRateLimiter(DEFAULT_RATE_LIMITS, () => now);
    for (let i = 0; i < 50_010; i++) limiter.take(`s${String(i)}`, "read");
    expect(limiter.size).toBeLessThanOrEqual(50_000);
    now = 120_000;
    limiter.take("late", "read");
    expect(limiter.size).toBeLessThanOrEqual(50_000);
  });

  it("a key at its limit stays limited through a flood of other keys (S-060a)", () => {
    let now = 0;
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, public: 300 }, () => now);
    for (let i = 0; i < 300; i++) expect(limiter.take("victim", "public")).toBe(true);
    expect(limiter.take("victim", "public")).toBe(false);
    now = 1_000;
    // The review's repro: 50,000 other keys used to evict and reset it.
    for (let i = 0; i < 100_000; i++) limiter.take(`flood${String(i)}`, "public");
    expect(limiter.size).toBeLessThanOrEqual(100_000);
    expect(limiter.take("victim", "public")).toBe(false);
    now = 60_000;
    expect(limiter.take("victim", "public")).toBe(true);
  });

  it("a key part way to its limit keeps its count while it is among the newest (S-060a)", () => {
    let now = 0;
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, credentials: 3 }, () => now);
    for (let i = 0; i < 40_000; i++) limiter.take(`old${String(i)}`, "credentials");
    now = 10;
    expect(limiter.take("a", "credentials")).toBe(true);
    expect(limiter.take("a", "credentials")).toBe(true);
    for (let i = 0; i < 20_000; i++) limiter.take(`new${String(i)}`, "credentials");
    expect(limiter.take("a", "credentials")).toBe(true);
    expect(limiter.take("a", "credentials")).toBe(false);
  });

  it("drops ended windows as new ones start, without waiting to be full (S-060a)", () => {
    let now = 0;
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, oai: 2 }, () => now);
    for (let i = 0; i < 1_000; i++) limiter.take(`s${String(i)}`, "read");
    for (let i = 0; i < 1_000; i++) {
      limiter.take(`l${String(i)}`, "oai");
      limiter.take(`l${String(i)}`, "oai");
    }
    expect(limiter.size).toBe(2_000);
    now = 60_000;
    limiter.take("late", "read");
    limiter.take("late", "oai");
    limiter.take("late", "oai");
    expect(limiter.size).toBe(2);
  });

  it("a limit of 1 refuses the second request", () => {
    const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, write: 1 }, () => 0);
    expect([limiter.take("a", "write"), limiter.take("a", "write")]).toEqual([true, false]);
  });

  it("refuses limits that aren't whole numbers from 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2_000_000]) {
      expect(() => new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, read: bad })).toThrow(
        RangeError,
      );
    }
  });
});
