// The hourly cleanup in the admin's process (S-063): first run after a
// delay, then on an interval; a tick that finds a run in progress is
// skipped, never queued; failures are logged by class and SQLSTATE only;
// stop waits for the run in progress and nothing runs after it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CleanupResult, Queryable } from "@oculus/db";
import { startCleanup } from "./cleanup-runner.js";
import type { ApiLogRecord } from "./staff-api.js";

const db = {} as Queryable;

const EMPTY: CleanupResult = Object.freeze({
  sessions: 0,
  signInThrottles: 0,
  secondStepThrottles: 0,
  secondStepAlerts: 0,
  passwordResets: 0,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startCleanup (S-063)", () => {
  it("waits before its first run, then runs on its interval", async () => {
    vi.useFakeTimers();
    const clean = vi.fn(() => Promise.resolve(EMPTY));
    const runner = startCleanup({
      db,
      log: () => undefined,
      clean,
      firstAfterMs: 1000,
      intervalMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(clean).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clean).toHaveBeenCalledTimes(1);
    expect(clean).toHaveBeenCalledWith(db);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clean).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clean).toHaveBeenCalledTimes(4);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clean).toHaveBeenCalledTimes(4);
  });

  it("skips ticks while a run is still going, instead of queueing them", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const clean = vi.fn(
      () =>
        new Promise<CleanupResult>((resolve) => {
          finish = () => {
            resolve(EMPTY);
          };
        }),
    );
    const runner = startCleanup({
      db,
      log: () => undefined,
      clean,
      firstAfterMs: 10,
      intervalMs: 10,
    });
    // A hundred ticks pass while the first run hangs.
    await vi.advanceTimersByTimeAsync(1000);
    expect(clean).toHaveBeenCalledTimes(1);
    // runNow joins the run in progress.
    const joined = runner.runNow();
    expect(clean).toHaveBeenCalledTimes(1);
    finish?.();
    await joined;
    // Only the next tick starts a new one: nothing piled up.
    await vi.advanceTimersByTimeAsync(10);
    expect(clean).toHaveBeenCalledTimes(2);
    finish?.();
    await runner.stop();
  });

  it("stop waits for the run in progress, and none starts after it", async () => {
    let finish: (() => void) | undefined;
    const clean = vi.fn(
      () =>
        new Promise<CleanupResult>((resolve) => {
          finish = () => {
            resolve(EMPTY);
          };
        }),
    );
    const runner = startCleanup({ db, log: () => undefined, clean, firstAfterMs: 60_000 });
    const run = runner.runNow();
    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finish?.();
    await run;
    await stopping;
    expect(stopped).toBe(true);
    await runner.runNow();
    expect(clean).toHaveBeenCalledTimes(1);
  });

  it("logs what it did as a count, and a failure by class and SQLSTATE only", async () => {
    const log: ApiLogRecord[] = [];
    const results: (CleanupResult | Error)[] = [
      { ...EMPTY, sessions: 2, passwordResets: 1, secondStepAlerts: 1 },
      EMPTY,
      Object.assign(new Error("secret host db.example.org, role oculus_writer"), {
        code: "57014",
        where: "a bound value",
      }),
    ];
    const clean = vi.fn(() => {
      const next = results.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? EMPTY);
    });
    const runner = startCleanup({
      db,
      log: (r) => {
        log.push(r);
      },
      clean,
      firstAfterMs: 60_000,
    });
    await runner.runNow();
    await runner.runNow();
    await runner.runNow();
    await runner.stop();
    expect(log).toEqual([
      { event: "cleanup", code: "4" },
      { event: "service_error", operation: "cleanup", name: "Error", code: "57014" },
    ]);
    expect(JSON.stringify(log)).not.toMatch(/example|oculus_writer|bound/);
  });

  it("a log that throws doesn't stop it", async () => {
    const clean = vi.fn(() => Promise.reject(new Error("x")));
    const runner = startCleanup({
      db,
      log: () => {
        throw new Error("log down");
      },
      clean,
      firstAfterMs: 60_000,
    });
    await expect(runner.runNow()).resolves.toBeUndefined();
    await expect(runner.runNow()).resolves.toBeUndefined();
    expect(clean).toHaveBeenCalledTimes(2);
    await runner.stop();
  });
});

describe("startCleanup's timings (S-063)", () => {
  it("refuses an interval that would run it back to back", () => {
    for (const bad of [0, -1, 1.5, 9, Number.NaN, 2_147_483_648]) {
      expect(() =>
        startCleanup({
          db,
          log: () => undefined,
          clean: () => Promise.resolve(EMPTY),
          intervalMs: bad,
        }),
      ).toThrow(RangeError);
      expect(() =>
        startCleanup({
          db,
          log: () => undefined,
          clean: () => Promise.resolve(EMPTY),
          firstAfterMs: bad,
        }),
      ).toThrow(RangeError);
    }
  });
});
