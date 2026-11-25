/**
 * The thumbnail renderer (M-003, T-072, D-097): a decoder process of its
 * own (thumbnail-worker.ts) for every image, one at a time.
 *
 * - **A hard memory cap outside JavaScript (T-072).** Each decode runs in a
 *   child process started for it, not a thread, so the whole of its memory
 *   (heap, pixel buffers, WebAssembly) is one process's. Two guards watch
 *   its resident size plus swap, from its size once it was ready:
 *   - **its own watchdog thread** (the primary guard, review B1), every
 *     5 ms, which kills the process past the trigger whatever the server
 *     or the decode is doing, and as soon as its parent is gone;
 *   - **the parent**, every 10 ms from Linux's /proc, which stops it
 *     (SIGSTOP, so it grows no further while its peak is read) and kills
 *     it (SIGKILL) past the same trigger.
 *   The trigger is `KILL_HEADROOM_BYTES` below `DECODE_MEMORY_CAP_BYTES`,
 *   so the peak stays within the cap. A kill either guard confirmed is
 *   answered `killed`, after one more try in a fresh process; one nothing
 *   confirmed (the system's out-of-memory killer) is `lost`. A process
 *   that can't start is `failed`, and the next job still runs.
 * - **The file, not its bytes.** The process is handed the stored copy's
 *   descriptor and reads the file itself (nothing is copied over IPC); the
 *   server reads only its header (`precheckThumbnail`).
 * - **Heap flags and a time limit.** The process runs with a heap limit, an
 *   empty environment and its output discarded; each job has a time limit
 *   (`timeout`), past which the process is killed. Starting it doesn't
 *   count against the job's time.
 * - **One job at a time, a short queue.** At most `maxQueued` jobs (one by
 *   default) wait; more are refused at once (`busy`, a 503). The service
 *   adds its own limits per organization and server.
 * - `close()` kills the running process.
 */
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { join } from "node:path";
import {
  DECODE_MEMORY_CAP_BYTES,
  DECODER_MARKER_FD,
  KILLED_EXIT_CODE,
  KILL_HEADROOM_BYTES,
  TRANSIENT,
  procMemory,
  spawnDecoder,
  type DecodeCheck,
  type ThumbnailAnswer,
  type ThumbnailJob,
} from "./thumbnail-worker.js";

export interface ThumbnailRendererOptions {
  /** The longest one job may take, in milliseconds (default 20 s). */
  readonly timeoutMs?: number;
  /** Jobs that may wait behind the running one (default 1: at most two decodes' memory at once). */
  readonly maxQueued?: number;
  /** The decoder process's heap limit in MiB (default 384, the memory cap). */
  readonly heapMiB?: number;
  /** The most the decoder process's resident size may grow, in bytes (default `DECODE_MEMORY_CAP_BYTES`). */
  readonly memoryCapBytes?: number;
  /** How often the parent reads the decoder process's size, in ms (default 10). */
  readonly sampleMs?: number;
  /**
   * Whether the parent watches too (default: where /proc can be read).
   * Tests turn it off to show the decoder process's own watchdog holding.
   */
  readonly parentWatch?: boolean;
  /**
   * Tests of the memory cap only: `unplanned` hands the decoder the bytes
   * without planning, to show the cap holding what a plan would miss.
   */
  readonly check?: DecodeCheck;
  /** Tests only: what starts a decoder process (default `spawnDecoder`), to make it fail. */
  readonly spawn?: typeof spawnDecoder;
}

export type RenderResult =
  | {
      readonly ok: true;
      readonly jpeg: Uint8Array;
      /** The decoder process's peak growth for this job (Linux only). */
      readonly peakBytes?: number;
    }
  | {
      readonly ok: false;
      /**
       * `refused`: the decoder refused the image, and `killed`: the decode
       * passed the memory cap twice, as its watchdog or the parent saw it
       * (both the same every time, so they may be remembered); `lost`: the
       * process was killed by something else (the system's out-of-memory
       * killer, say), so remembered only for a while, like `timeout`, too
       * slow; `failed`: the process crashed or couldn't start, or an
       * allocation failed (says nothing about the image: never
       * remembered); `busy`: the queue is full.
       */
      readonly code: "refused" | "killed" | "lost" | "failed" | "busy" | "timeout";
      readonly peakBytes?: number;
    };

/** What to render: the bytes (tests), or a descriptor open on the file (the caller closes it). */
export type ThumbnailSource = Uint8Array | { readonly fd: number };

export interface ThumbnailRenderer {
  /** Renders a thumbnail of the file, decoded as `format`, to fit `box`. */
  render(format: string, source: ThumbnailSource, box: number): Promise<RenderResult>;
  /** How many decoder processes it has started (one a job, two for a job killed once). */
  processesStarted(): number;
  /** Kills the decoder process; jobs still waiting are answered `busy`. */
  close(): Promise<void>;
}

/** The longest a decoder process may take to start and load its decoders (30 s). */
const STARTUP_MS = 30_000;

/** Bytes given as such are written to a private temporary file for the decoder process. */
function temporaryFile(bytes: Uint8Array): { fd: number; remove: () => void } {
  const path = join(tmpdir(), `oculus-thumbnail-${randomBytes(12).toString("hex")}`);
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const remove = (): void => {
    closeSync(fd);
    rmSync(path, { force: true });
  };
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at, at);
  } catch (error) {
    remove();
    throw error;
  }
  return { fd, remove };
}

interface Pending {
  readonly job: Omit<ThumbnailJob, "check" | "timeoutMs">;
  readonly source: ThumbnailSource;
  readonly done: (result: RenderResult) => void;
}

export function createThumbnailRenderer(options: ThumbnailRendererOptions = {}): ThumbnailRenderer {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxQueued = options.maxQueued ?? 1;
  const cap = options.memoryCapBytes ?? DECODE_MEMORY_CAP_BYTES;
  const heapMiB = options.heapMiB ?? Math.ceil(cap / (1024 * 1024));
  const sampleMs = options.sampleMs ?? 10;
  /** Killed this far up, so its peak (a sample later) stays within the cap. */
  const killAt = cap - Math.min(KILL_HEADROOM_BYTES, cap / 4);
  const queue: Pending[] = [];
  let running: { readonly stop: () => void } | undefined;
  let nextId = 1;
  let closed = false;
  let started = 0;

  /** One attempt: a fresh decoder process for the job, answered once. */
  function attempt(
    job: Pending["job"],
    fd: number,
  ): { readonly result: Promise<RenderResult>; readonly stop: () => void } {
    started++;
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawnDecoder)({ fd, killAt, heapMiB });
    } catch {
      // No process at all (ENOMEM under strict overcommit, say): says nothing about the image.
      return { result: Promise.resolve({ ok: false, code: "failed" }), stop: () => undefined };
    }
    const pid = child.pid ?? -1;
    const parentWatches = options.parentWatch ?? procMemory("self") !== undefined;
    let baseline: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    let sampler: NodeJS.Timeout | undefined;
    let marker = "";
    let answer: (result: RenderResult) => void = () => undefined;
    const result = new Promise<RenderResult>((resolve) => {
      answer = resolve;
    });
    let answered = false;
    // Descriptor 5 (the typed tuple stops at 4); none at all when the spawn
    // failed (EMFILE, ENFILE), which its 'error' event then reports.
    const stdio = child.stdio as readonly unknown[] | undefined | null;
    const pipe = stdio?.[DECODER_MARKER_FD] as Readable | null | undefined;
    const end = (value: RenderResult): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      clearInterval(sampler);
      child.removeAllListeners();
      // Anything it reports from now on is ignored, never an unhandled error.
      child.on("error", () => undefined);
      pipe?.removeAllListeners();
      pipe?.on("error", () => undefined);
      try {
        child.kill("SIGKILL");
      } catch {
        // Never started, or already gone.
      }
      answer(value);
    };
    // Listened for first: a spawn that failed reports it here, never as an unhandled error.
    child.on("error", () => {
      end({ ok: false, code: "failed" });
    });
    const growth = (): { now: number; peak: number } | undefined => {
      if (baseline === undefined) return undefined;
      const memory = procMemory(pid);
      return memory === undefined
        ? undefined
        : { now: memory.rss - baseline, peak: memory.peak - baseline };
    };
    // The watchdog's report, if it killed the process: "killed <peak growth>" or "orphan".
    pipe?.on("data", (chunk: Buffer) => {
      if (marker.length < 256) marker += chunk.toString("latin1");
    });
    pipe?.on("error", () => undefined);
    child.on("message", (message: ThumbnailAnswer | { readonly ready: true }) => {
      if ("ready" in message) {
        // Started, its decoders loaded and warmed up: its size now is the baseline.
        baseline = procMemory(pid)?.rss;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // Too slow: kill the process (its job can't be interrupted otherwise).
          end({ ok: false, code: "timeout" });
        }, timeoutMs);
        if (parentWatches && baseline !== undefined) {
          sampler = setInterval(() => {
            const seen = growth();
            if (seen === undefined || seen.now <= killAt) return;
            // Past the trigger: stopped at once (so it grows no further), its peak read, killed.
            try {
              process.kill(pid, "SIGSTOP");
            } catch {
              // Already gone: its exit says so.
            }
            const last = growth() ?? seen;
            end({ ok: false, code: "killed", peakBytes: last.peak });
          }, sampleMs);
        }
        const full: ThumbnailJob = { ...job, timeoutMs };
        const sent: ThumbnailJob =
          options.check === undefined ? full : { ...full, check: options.check };
        child.send(sent, (error) => {
          if (error !== null) end({ ok: false, code: "failed" });
        });
        return;
      }
      if (message.id !== job.id) return;
      const seen = growth();
      const peak = seen === undefined ? {} : { peakBytes: seen.peak };
      end(
        message.ok
          ? { ok: true, jpeg: new Uint8Array(message.jpeg), ...peak }
          : { ok: false, code: message.code === TRANSIENT ? "failed" : "refused", ...peak },
      );
    });
    // Its end, once its pipes are closed (so the watchdog's report has been read).
    child.on("close", (code, signal) => {
      const report = /^killed (\d+)/.exec(marker);
      if (report !== null) {
        // The cap, confirmed by the watchdog's own report.
        end({ ok: false, code: "killed", peakBytes: Number(report[1]) });
      } else if (marker.startsWith("timeout")) {
        end({ ok: false, code: "timeout" });
      } else if (signal === "SIGKILL" || code === KILLED_EXIT_CODE) {
        // Killed with no report (the system's out-of-memory killer, say):
        // not a confirmed cap, so remembered only for a while (review 2).
        end({ ok: false, code: "lost" });
      } else {
        end({ ok: false, code: "failed" });
      }
    });
    // Starting doesn't count against the job's time limit (review), but has a limit of its own.
    timer = setTimeout(() => {
      end({ ok: false, code: "failed" });
    }, STARTUP_MS);
    return {
      result,
      stop: () => {
        end({ ok: false, code: "busy" });
      },
    };
  }

  async function run(pending: Pending): Promise<RenderResult> {
    const { source } = pending;
    let temporary: { fd: number; remove: () => void } | undefined;
    try {
      temporary = source instanceof Uint8Array ? temporaryFile(source) : undefined;
      const fd = temporary?.fd ?? (source instanceof Uint8Array ? -1 : source.fd);
      let result: RenderResult = { ok: false, code: "busy" };
      // A confirmed kill is tried once more in a fresh process before it counts (review).
      for (let tries = 0; tries < 2 && !closed; tries++) {
        const current = attempt(pending.job, fd);
        running = current;
        result = await current.result;
        running = undefined;
        if (result.ok || result.code !== "killed") break;
      }
      return closed ? { ok: false, code: "busy" } : result;
    } finally {
      running = undefined;
      temporary?.remove();
    }
  }

  let working = false;
  function next(): void {
    if (working || closed) return;
    const pending = queue.shift();
    if (pending === undefined) return;
    working = true;
    // Whatever happens (a temporary file that can't be written, say), the
    // job is answered and the next one runs (review 2, B1).
    void run(pending)
      .catch((): RenderResult => ({ ok: false, code: "failed" }))
      .then((result) => {
        working = false;
        pending.done(result);
        next();
      });
  }

  return Object.freeze({
    render(format: string, source: ThumbnailSource, box: number): Promise<RenderResult> {
      if (closed || queue.length >= maxQueued) {
        return Promise.resolve({ ok: false, code: "busy" } as const);
      }
      return new Promise<RenderResult>((resolve) => {
        queue.push({ job: { id: nextId++, format, box }, source, done: resolve });
        next();
      });
    },
    processesStarted: () => started,
    close(): Promise<void> {
      closed = true;
      for (const pending of queue.splice(0)) pending.done({ ok: false, code: "busy" });
      running?.stop();
      return Promise.resolve();
    },
  });
}
