// Records whose public reads ran out of time (S-043b): remembered per site
// and record, read with the larger limit, strikes counted only at that
// limit and only in a row, forgotten after a day, and never more than
// SLOW_READ_MAX_RECORDS at once.
import { describe, expect, it } from "vitest";
import { PUBLIC_READ_TIME_LIMIT_MS } from "@oculus/db";
import {
  readLimit,
  SLOW_READ_MAX_RECORDS,
  SLOW_READ_MEMORY_MS,
  SLOW_READ_TIME_LIMIT_MS,
  slowKey,
  SlowReads,
} from "./public-api.js";
import type { PublicSite } from "./public-sites.js";

describe("SlowReads (S-043b)", () => {
  it("remembers a timed-out record and counts strikes only at the larger limit, in a row", () => {
    const slow = new SlowReads();
    expect(slow.limitMs).toBe(SLOW_READ_TIME_LIMIT_MS);
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([false, 0]);
    // At the normal limit: known slow, no strike.
    expect(slow.timedOut("r", false)).toBe(0);
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([true, 0]);
    expect(slow.timedOut("r", true)).toBe(1);
    expect(slow.timedOut("r", true)).toBe(2);
    // Answered in time at the larger limit: still slow, strikes start again.
    slow.answered("r");
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([true, 0]);
    // Answering a record never seen remembers nothing.
    slow.answered("other");
    expect(slow.isSlow("other")).toBe(false);
  });

  it("forgets a record a day after its last timeout", () => {
    let now = 1_000_000;
    const slow = new SlowReads({ clock: () => now });
    slow.timedOut("r", true);
    now += SLOW_READ_MEMORY_MS;
    expect(slow.strikes("r")).toBe(1);
    slow.timedOut("r", true);
    now += SLOW_READ_MEMORY_MS;
    expect(slow.strikes("r")).toBe(2);
    now += 1;
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([false, 0]);
    // A fresh start, not the old strikes.
    expect(slow.timedOut("r", true)).toBe(1);
  });

  it("keeps at most SLOW_READ_MAX_RECORDS, forgetting the longest since a timeout first", () => {
    const slow = new SlowReads();
    for (let i = 0; i <= SLOW_READ_MAX_RECORDS; i++) slow.timedOut(`r${String(i)}`, false);
    expect(slow.isSlow("r0")).toBe(false);
    expect(slow.isSlow("r1")).toBe(true);
    // A new timeout moves a record to the back of the line.
    slow.timedOut("r1", false);
    slow.timedOut("new", false);
    expect(slow.isSlow("r1")).toBe(true);
    expect(slow.isSlow("r2")).toBe(false);
  });

  it("refuses a larger limit a read couldn't use", () => {
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(() => new SlowReads({ limitMs: bad })).toThrow(RangeError);
    }
    expect(new SlowReads({ limitMs: 60_000 }).limitMs).toBe(60_000);
  });

  it("gives a slow record the larger limit, never below the routes' own", () => {
    const slow = new SlowReads({ limitMs: 1_000 });
    expect(readLimit(undefined, undefined)).toEqual({});
    expect(readLimit(200, undefined)).toEqual({ timeLimitMs: 200 });
    expect(readLimit(200, slow)).toEqual({ timeLimitMs: 1_000 });
    expect(readLimit(3_000, slow)).toEqual({ timeLimitMs: 3_000 });
    // Left out, the routes' limit is readPublicRecord's default.
    expect(readLimit(undefined, slow)).toEqual({ timeLimitMs: PUBLIC_READ_TIME_LIMIT_MS });
  });

  it("keys a record by its organization and site, so one site's slow record isn't another's", () => {
    const site = (siteId: string): PublicSite =>
      ({ organizationId: "o", siteId, origin: "http://x" }) as unknown as PublicSite;
    expect(slowKey(site("s1"), "r")).not.toBe(slowKey(site("s2"), "r"));
  });
});
