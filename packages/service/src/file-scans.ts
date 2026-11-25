/**
 * Scanning stored files for viruses in the background (S-040, D-113).
 *
 * An upload never waits for its scan: the attach queues the content
 * (`queueScan`, in the attach's transaction) and kicks this queue, which
 * scans after COMMIT, at most `concurrency` at once. Each worker takes the
 * next due content (`claimDueScan`: a lease, so two workers or two
 * processes never scan one content at once and a crash only delays it),
 * streams the stored copy to the scanner (`FileScanner`: clamd, clamd.ts)
 * and records what it said (`recordScanResult`), which also logs it.
 *
 * - **Failures are retried with backoff** (`scanBackoffMs`: 1, 4, 16, 64
 *   minutes …, at most 6 hours apart); a file larger than the scanner takes
 *   (`too_large`) isn't retried by itself, since nothing will change until
 *   the limits do: a rescan queues it again.
 * - **Contents attached before scanning was set up** have no result:
 *   `runOnce` queues them (`queueUnscanned`, a batch at a time) before it
 *   kicks the workers. The admin server calls it at startup and every
 *   minute.
 * - **Nothing is deleted**, and an infected content isn't moved: it stays
 *   where it is, quarantined by its state (never served, D-113).
 */
import type { Readable } from "node:stream";
import {
  claimDueScan,
  queueUnscanned,
  recordScanResult,
  type ClaimedScan,
  type Database,
  type ScanResult,
} from "@oculus/db";
import { scanWithClamd, type ClamdOptions, type ClamdVerdict } from "./clamd.js";
import type { FileStore } from "./file-store.js";

/** Something that scans one stream (clamd in production; a stub in tests of the service). */
export interface FileScanner {
  /** The largest file it takes (clamd's StreamMaxLength, or less). */
  readonly maxBytes: number;
  /** The whole scan's time limit (milliseconds): the queue's lease is longer. */
  readonly timeoutMs: number;
  scan(source: Readable, size: number): Promise<ClamdVerdict>;
}

/** A `FileScanner` that asks clamd (clamd.ts). */
export function clamdScanner(options: ClamdOptions): FileScanner {
  return Object.freeze({
    maxBytes: options.streamMaxBytes,
    timeoutMs: options.timeoutMs,
    scan: (source: Readable, size: number) => scanWithClamd(options, source, size),
  });
}

/** Scans at once by default (the desktop has few cores to spare). */
export const DEFAULT_SCAN_CONCURRENCY = 2;
/** The longest wait between two tries of a failed scan: 6 hours. */
export const MAX_SCAN_BACKOFF_MS = 6 * 3600 * 1000;
/** Contents without a result queued per pass. */
export const UNSCANNED_BATCH = 500;
/** Who the queue's results are logged as. */
export const SCAN_ACTOR = "system:virus-scan";

/** The wait before the next try after `attempts` failed ones (1 min × 4^(attempts−1), at most 6 h). */
export function scanBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.min(Math.floor(attempts), 12));
  return Math.min(60_000 * 4 ** (n - 1), MAX_SCAN_BACKOFF_MS);
}

export interface FileScanQueueOptions {
  readonly concurrency?: number;
  /** The wait after `attempts` failures (default `scanBackoffMs`); tests shorten it. */
  readonly backoffMs?: (attempts: number) => number;
  /** For the server's log: an error of the queue itself (the database, say). */
  readonly onError?: (error: unknown, operation: string) => void;
}

/** What one `runOnce` did. */
export interface ScanPass {
  /** Contents without a result that were queued. */
  readonly queued: number;
  /** Scans finished, by what they found. */
  readonly clean: number;
  readonly infected: number;
  readonly failed: number;
}

export interface FileScanQueue {
  /** Starts workers for whatever is due (after an attach or a rescan); never waits. */
  kick(): void;
  /** Queues contents without a result, then scans everything due; resolves when idle. */
  runOnce(): Promise<ScanPass>;
  /** Stops taking new work and waits for the scans running now. */
  stop(): Promise<void>;
}

export function fileScanQueue(
  db: Database,
  store: FileStore,
  scanner: FileScanner,
  options: FileScanQueueOptions = {},
): FileScanQueue {
  const concurrency = options.concurrency ?? DEFAULT_SCAN_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("concurrency is a whole number from 1 to 16.");
  }
  const backoff = options.backoffMs ?? scanBackoffMs;
  // Longer than a scan may take, so a running scan keeps its content.
  const leaseSeconds = Math.ceil(scanner.timeoutMs / 1000) + 60;
  let stopped = false;
  let active = 0;
  const running = new Set<Promise<void>>();
  let idleWaiters: (() => void)[] = [];
  /** Kicked while every worker was busy: one more look when one finishes. */
  let again = false;
  let tally = { clean: 0, infected: 0, failed: 0 };

  const report = (error: unknown, operation: string): void => {
    try {
      options.onError?.(error, operation);
    } catch {
      // The log can't stop the queue.
    }
  };

  async function verdictFor(job: ClaimedScan): Promise<ScanResult> {
    const failed = (failure: Extract<ScanResult, { state: "failed" }>["failure"]): ScanResult => ({
      state: "failed",
      failure,
      retryInSeconds:
        failure === "too_large" ? null : Math.max(1, Math.ceil(backoff(job.attempts + 1) / 1000)),
    });
    if (job.size > scanner.maxBytes) return failed("too_large");
    const open = await store.openContent(job.organizationId, job.sha256, job.size);
    if (open === undefined) return failed("unreadable");
    let source: Readable;
    try {
      source = open();
    } catch {
      return failed("unreadable");
    }
    const verdict = await scanner.scan(source, job.size);
    if (!verdict.ok) return failed(verdict.failure);
    return verdict.verdict === "clean"
      ? { state: "clean" }
      : { state: "infected", signature: verdict.signature };
  }

  async function scanOne(job: ClaimedScan): Promise<void> {
    let result: ScanResult;
    try {
      result = await verdictFor(job);
    } catch (error) {
      report(error, "scanFile");
      result = {
        state: "failed",
        failure: "unavailable",
        retryInSeconds: Math.max(1, Math.ceil(backoff(job.attempts + 1) / 1000)),
      };
    }
    await db.transaction((tx) =>
      recordScanResult(tx, job.organizationId, job.sha256, result, SCAN_ACTOR),
    );
    tally = { ...tally, [result.state]: tally[result.state] + 1 };
  }

  async function worker(): Promise<void> {
    try {
      while (!stopped) {
        let job: ClaimedScan | undefined;
        try {
          job = await claimDueScan(db, leaseSeconds);
        } catch (error) {
          report(error, "claimScan");
          return;
        }
        if (job === undefined) return;
        try {
          await scanOne(job);
        } catch (error) {
          // The result couldn't be stored: the lease runs out and it is
          // taken again later.
          report(error, "recordScan");
        }
      }
    } finally {
      active--;
      if (again && !stopped) {
        again = false;
        start();
      } else if (active === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const wake of waiters) wake();
      }
    }
  }

  function start(): void {
    if (stopped) return;
    if (active >= concurrency) {
      again = true;
      return;
    }
    while (active < concurrency) {
      active++;
      const run = worker();
      running.add(run);
      void run.finally(() => running.delete(run));
    }
  }

  function idle(): Promise<void> {
    if (active === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    kick() {
      start();
    },

    async runOnce() {
      let queued = 0;
      try {
        queued = await db.transaction((tx) => queueUnscanned(tx, UNSCANNED_BATCH));
      } catch (error) {
        report(error, "queueUnscanned");
      }
      tally = { clean: 0, infected: 0, failed: 0 };
      start();
      await idle();
      return Object.freeze({ queued, ...tally });
    },

    async stop() {
      stopped = true;
      await Promise.allSettled([...running]);
    },
  };
}
