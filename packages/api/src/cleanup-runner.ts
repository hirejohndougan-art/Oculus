/**
 * Runs `runCleanup` (sessions.ts) in the admin's process (S-063): ended
 * sessions, old sign-in and wrong-code counters and old reset links are
 * deleted, and S-045's alerts for wrong codes an hour old are written. Before
 * this only `npm run db:cleanup` ran it, which nothing scheduled, so on the
 * desktop those tables only grew and the S-045 alerts were never written
 * (Phase 2 data review, M3). `npm run db:cleanup` still works, for a server
 * that wants it on its own schedule; running both is harmless.
 *
 * First run `CLEANUP_FIRST_AFTER_MS` after the start (a start isn't slowed,
 * and a test server that lives a few seconds never runs it), then every
 * `CLEANUP_EVERY_MS`. A tick that finds the last run still going is skipped,
 * never queued, so a slow database never piles runs up. The timer doesn't
 * keep the process alive. Failures are logged by class and SQLSTATE only
 * (`redactedError`); the next tick tries again.
 */
import { runCleanup, type Queryable } from "@oculus/db";
import { redactedError, type ApiLogRecord } from "./staff-api.js";

/** The first run, after the start. */
export const CLEANUP_FIRST_AFTER_MS = 5 * 60_000;
/** Then this often. Lookups refuse ended sessions whether or not it has run. */
export const CLEANUP_EVERY_MS = 60 * 60_000;

export interface CleanupRunner {
  /** Runs once now, or waits for the run in progress. */
  runNow(): Promise<void>;
  /** Stops the timers and waits for a run in progress. */
  stop(): Promise<void>;
}

export interface CleanupRunnerOptions {
  readonly db: Queryable;
  readonly log: (record: ApiLogRecord) => void;
  /** Default `CLEANUP_EVERY_MS`. */
  readonly intervalMs?: number;
  /** Default `CLEANUP_FIRST_AFTER_MS`. */
  readonly firstAfterMs?: number;
  /** The cleanup itself (tests); default `runCleanup`. */
  readonly clean?: typeof runCleanup;
}

export function startCleanup(options: CleanupRunnerOptions): CleanupRunner {
  const { db, log } = options;
  const clean = options.clean ?? runCleanup;
  const intervalMs = options.intervalMs ?? CLEANUP_EVERY_MS;
  const firstAfterMs = options.firstAfterMs ?? CLEANUP_FIRST_AFTER_MS;
  let running: Promise<void> | undefined;
  let stopped = false;
  const record = (r: ApiLogRecord): void => {
    try {
      log(r);
    } catch {
      // Logging can't stop the runner.
    }
  };
  const once = async (): Promise<void> => {
    try {
      const done = await clean(db);
      const total =
        done.sessions +
        done.signInThrottles +
        done.secondStepThrottles +
        done.secondStepAlerts +
        done.passwordResets;
      if (total > 0) record({ event: "cleanup", code: String(total) });
    } catch (error) {
      record({ event: "service_error", operation: "cleanup", ...redactedError(error) });
    }
  };
  /** Starts a run unless one is going; either way, the run going now. */
  const start = (): Promise<void> => {
    running ??= once().finally(() => {
      running = undefined;
    });
    return running;
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    if (stopped) return;
    void start();
    interval = setInterval(() => {
      if (!stopped) void start();
    }, intervalMs);
    interval.unref();
  }, firstAfterMs);
  first.unref();
  return {
    runNow: () => (stopped ? Promise.resolve() : start()),
    async stop() {
      stopped = true;
      clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      await running;
    },
  };
}
