// The alert-notice runner's timer (S-065, T-053 data review L6): a tick that
// comes while a run is still going is skipped, never queued, so a run that
// hangs doesn't pile up one waiting run per minute; `stop()` waits only for
// the run in progress.
import type { Database } from "@oculus/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAlertNotices } from "./alert-notices.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A database whose every transaction waits until `release()`; counts them. */
function stalledDatabase(): { db: Database; started: () => number; release: () => void } {
  let started = 0;
  let open: (() => void)[] = [];
  const db = {
    transaction: () => {
      started += 1;
      return new Promise((resolve) => {
        open.push(() => {
          resolve({ alerts: 0, messages: [], notified: 0 });
        });
      });
    },
  } as unknown as Database;
  return {
    db,
    started: () => started,
    release: () => {
      const waiting = open;
      open = [];
      for (const go of waiting) go();
    },
  };
}

describe("startAlertNotices", () => {
  it("skips ticks while a run is going, instead of queuing one per tick", async () => {
    vi.useFakeTimers();
    const stalled = stalledDatabase();
    const runner = startAlertNotices({
      db: stalled.db,
      deliver: () => Promise.resolve(),
      log: () => undefined,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stalled.started()).toBe(1);
    // Ten more minutes' worth of ticks while the first run hangs.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stalled.started()).toBe(1);
    stalled.release();
    await vi.advanceTimersByTimeAsync(0);
    // The next tick after it finished starts one run, not the ten skipped.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stalled.started()).toBe(2);
    stalled.release();
    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(stalled.started()).toBe(2);
  });

  it("still runs when asked with runNow, after a run in progress", async () => {
    const stalled = stalledDatabase();
    const runner = startAlertNotices({
      db: stalled.db,
      deliver: () => Promise.resolve(),
      log: () => undefined,
      intervalMs: 3_600_000,
    });
    const first = runner.runNow();
    const second = runner.runNow();
    await Promise.resolve();
    expect(stalled.started()).toBe(1);
    stalled.release();
    await first;
    await vi.waitFor(() => {
      expect(stalled.started()).toBe(2);
    });
    stalled.release();
    await second;
    await runner.stop();
  });
});
