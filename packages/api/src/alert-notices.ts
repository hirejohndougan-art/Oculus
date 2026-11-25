/**
 * Runs `sendSecondStepAlertNotices` (D-077, D-085) every minute in the
 * admin's process: "someone is guessing your two-step codes" goes to the
 * person and the system admins at most once per person per window, the
 * database deciding (0021). Several processes may run it; an advisory lock
 * that is only tried, never waited for, lets one of them do a run while the
 * others skip it (S-065). Runs never overlap in one process: a tick that
 * comes while a run is still going is skipped, not queued, so a run that
 * hangs never piles up one waiting run per minute (S-065). The timer doesn't
 * keep the process alive, and failures are logged by class only
 * (`redactedError`), never with an address.
 */
import {
  sendSecondStepAlertNotices,
  type Database,
  type SecondStepAlertDelivery,
} from "@oculus/db";
import { redactedError, type ApiLogRecord } from "./staff-api.js";

export interface AlertNoticeRunner {
  /** Runs once now (waits for a run in progress first; a tick never queues). */
  runNow(): Promise<void>;
  /** Stops the timer and waits for a run in progress. */
  stop(): Promise<void>;
}

export interface AlertNoticeRunnerOptions {
  readonly db: Database;
  readonly deliver: SecondStepAlertDelivery;
  readonly log: (record: ApiLogRecord) => void;
  /** Default 60 s. */
  readonly intervalMs?: number;
  /** Passed on (default 24 hours). */
  readonly windowSeconds?: number;
  /** How many more emails the mailer takes now (its notice lane's room); a run hands over no more. */
  readonly room?: () => number;
}

export function startAlertNotices(options: AlertNoticeRunnerOptions): AlertNoticeRunner {
  const { db, deliver, log } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  let running: Promise<void> = Promise.resolve();
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
      const run = await sendSecondStepAlertNotices(db, deliver, {
        ...(options.windowSeconds === undefined ? {} : { windowSeconds: options.windowSeconds }),
        ...(options.room === undefined ? {} : { maxMessages: options.room() }),
        onError: (error) => {
          record({ event: "service_error", operation: "alertNotices", ...redactedError(error) });
        },
      });
      if (run !== undefined && run.notified > 0) {
        record({ event: "alert_notices", code: String(run.notified) });
      }
    } catch (error) {
      record({ event: "service_error", operation: "alertNotices", ...redactedError(error) });
    }
  };
  // Runs asked for and not yet finished (timer ticks and `runNow`).
  let inFlight = 0;
  const next = (): Promise<void> => {
    inFlight += 1;
    running = running.then(once).finally(() => {
      inFlight -= 1;
    });
    return running;
  };
  // A tick while a run is going (or waiting to go) is skipped, not queued:
  // the next one comes in a minute anyway (review L6).
  const timer = setInterval(() => {
    if (!stopped && inFlight === 0) void next();
  }, intervalMs);
  timer.unref();
  return {
    runNow: () => next(),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
