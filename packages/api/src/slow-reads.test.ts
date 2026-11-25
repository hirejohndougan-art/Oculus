// Records whose public reads ran out of time (S-043b): remembered per site
// and record, read with the larger limit, strikes counted only at that
// limit, at most once per gap, forgotten after a day, and never more than
// SLOW_READ_MAX_RECORDS at once.
import { describe, expect, it } from "vitest";
import { PUBLIC_READ_TIME_LIMIT_MS } from "@oculus/db";
import {
  PUBLIC_READ_BUDGET_MS,
  readLimit,
  SLOW_READ_BUDGET_MS,
  SLOW_READ_MAX_RECORDS,
  SLOW_READ_MEMORY_MS,
  SLOW_READ_STRIKE_GAP_MS,
  SLOW_READ_TIME_LIMIT_MS,
  slowKey,
  SlowReads,
} from "./public-api.js";
import type { PublicSite } from "./public-sites.js";
import { OAI_REQUEST_BUDGET_MS } from "./oai-pmh.js";
import { SERVER_TIMEOUTS } from "./server.js";

describe("SlowReads (S-043b)", () => {
  it("remembers a timed-out record; strikes count once per gap and clear when a read answers", () => {
    let now = 1_000_000;
    const slow = new SlowReads({ clock: () => now });
    expect([slow.limitMs, slow.budgetMs]).toEqual([SLOW_READ_TIME_LIMIT_MS, SLOW_READ_BUDGET_MS]);
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([false, 0]);
    // No strike for a record not known slow.
    expect(slow.strike("r")).toBe(0);
    slow.timedOut("r");
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([true, 0]);
    expect(slow.strike("r")).toBe(1);
    // A second timeout in the same slow spell (another harvester, a retry) is the same strike.
    now += SLOW_READ_STRIKE_GAP_MS - 1;
    expect(slow.strike("r")).toBe(1);
    now += 1;
    expect(slow.strike("r")).toBe(2);
    // Answered in time at the larger limit: still slow, strikes start again.
    slow.answered("r");
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([true, 0]);
    expect(slow.strike("r")).toBe(1);
    // Answered within the normal limit: not known slow any more.
    slow.answered("r", true);
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([false, 0]);
    // Answering a record never seen remembers nothing.
    slow.answered("other");
    slow.answered("other", true);
    expect(slow.isSlow("other")).toBe(false);
  });

  it("forgets a record a day after its last timeout", () => {
    let now = 1_000_000;
    const slow = new SlowReads({ clock: () => now });
    slow.timedOut("r");
    slow.strike("r");
    now += SLOW_READ_MEMORY_MS;
    expect(slow.strikes("r")).toBe(1);
    slow.timedOut("r");
    now += SLOW_READ_MEMORY_MS;
    expect(slow.strikes("r")).toBe(1);
    now += 1;
    expect([slow.isSlow("r"), slow.strikes("r")]).toEqual([false, 0]);
    // A fresh start, not the old strikes.
    slow.timedOut("r");
    expect(slow.strikes("r")).toBe(0);
  });

  it("keeps at most SLOW_READ_MAX_RECORDS, forgetting the longest since a timeout first", () => {
    const slow = new SlowReads();
    for (let i = 0; i <= SLOW_READ_MAX_RECORDS; i++) slow.timedOut(`r${String(i)}`);
    expect(slow.isSlow("r0")).toBe(false);
    expect(slow.isSlow("r1")).toBe(true);
    // A new timeout moves a record to the back of the line.
    slow.timedOut("r1");
    slow.timedOut("new");
    expect(slow.isSlow("r1")).toBe(true);
    expect(slow.isSlow("r2")).toBe(false);
  });

  it("refuses a larger limit a read couldn't use", () => {
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(() => new SlowReads({ limitMs: bad })).toThrow(RangeError);
    }
    expect(new SlowReads({ limitMs: 60_000 }).budgetMs).toBe(60_000);
    for (const bad of [999, 120_001, 1.5]) {
      expect(() => new SlowReads({ limitMs: 1_000, budgetMs: bad })).toThrow(RangeError);
    }
  });

  it("gives a slow record the larger limit and its budget; others a budget of three statements, at most PUBLIC_READ_BUDGET_MS", () => {
    const slow = new SlowReads({ limitMs: 1_000, budgetMs: 2_000 });
    expect(readLimit(undefined, undefined)).toEqual({
      timeLimitMs: PUBLIC_READ_TIME_LIMIT_MS,
      budgetMs: PUBLIC_READ_BUDGET_MS,
    });
    expect(readLimit(200, undefined)).toEqual({ timeLimitMs: 200, budgetMs: 600 });
    expect(readLimit(60_000, undefined)).toEqual({
      timeLimitMs: 60_000,
      budgetMs: PUBLIC_READ_BUDGET_MS,
    });
    expect(readLimit(200, slow)).toEqual({ timeLimitMs: 1_000, budgetMs: 2_000 });
    expect(readLimit(3_000, slow)).toEqual({ timeLimitMs: 3_000, budgetMs: 3_000 });
    // The defaults fit the server's 30 s reply time with the staff reads around them.
    const fallback = readLimit(undefined, new SlowReads());
    expect(fallback).toEqual({
      timeLimitMs: SLOW_READ_TIME_LIMIT_MS,
      budgetMs: SLOW_READ_BUDGET_MS,
    });
    expect(fallback.budgetMs + 2 * PUBLIC_READ_TIME_LIMIT_MS).toBeLessThanOrEqual(
      SERVER_TIMEOUTS.handler,
    );
    // A list request's reads, all told, leave time for the reply (OAI_REQUEST_BUDGET_MS).
    expect(OAI_REQUEST_BUDGET_MS).toBeLessThanOrEqual(SERVER_TIMEOUTS.handler - 5_000);
    expect(SLOW_READ_BUDGET_MS).toBeLessThan(OAI_REQUEST_BUDGET_MS);
  });

  it("keys a record by its organization and site, so one site's slow record isn't another's", () => {
    const site = (siteId: string): PublicSite =>
      ({ organizationId: "o", siteId, origin: "http://x" }) as unknown as PublicSite;
    expect(slowKey(site("s1"), "r")).not.toBe(slowKey(site("s2"), "r"));
  });
});
