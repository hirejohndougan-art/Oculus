/**
 * The thumbnail renderer (M-003, T-072, D-097): a decoder process of its
 * own (thumbnail-worker.ts) that decodes and scales one image at a time.
 *
 * - **A hard memory cap outside JavaScript (T-072).** Decodes run in a
 *   child process, not a thread, so the whole of its memory (heap, pixel
 *   buffers, WebAssembly) can be watched and taken back. While a job runs
 *   its resident size is read from Linux's /proc every 10 ms; once it has
 *   grown, from its size when it was ready, to within `KILL_HEADROOM_BYTES`
 *   of `DECODE_MEMORY_CAP_BYTES`, the process is stopped (SIGSTOP, so it
 *   grows no further while its peak is read), then killed (SIGKILL), and
 *   the job is answered `killed`: its peak stays within the cap.
 *   Where /proc can't be read, a thread inside the decoder process samples
 *   its size every 5 ms and kills the process itself. The plan
 *   (`planDecode`) is the first guard; this is the one that holds.
 * - **A fresh process after anything but a clean answer.** A refusal, a
 *   failure, a kill, a timeout, every WebP (WebAssembly memory never
 *   shrinks) and a decode that left the process holding more than
 *   `REUSE_SLACK_BYTES` all start the next job in a new process.
 * - **Heap flags and a time limit.** The process runs with a heap limit
 *   (`--max-old-space-size`) and a clean environment, its output is
 *   discarded, and each job has a time limit (`timeout`), past which the
 *   process is killed. Starting it doesn't count against the job's time.
 * - **One job at a time, a short queue.** At most `maxQueued` jobs (one by
 *   default) wait; more are refused at once (`busy`, a 503), so a burst of
 *   requests for large images can't pile up memory or CPU on a small
 *   server. The service adds its own limits per organization and server.
 * - The process is unreferenced while idle, so it never keeps the server
 *   alive, and `close()` kills it. If the server goes, it goes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DECODE_MEMORY_CAP_BYTES,
  KILL_HEADROOM_BYTES,
  TRANSIENT,
  WORKER_MARK,
  procMemory,
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
   * Who watches the decoder process's memory: `parent` (from /proc, the
   * default where it can be read) or `self` (a thread in the process, the
   * fallback elsewhere; tests choose it to try it on Linux).
   */
  readonly watch?: "parent" | "self";
  /**
   * Tests of the memory cap only: `unplanned` hands the decoder the bytes
   * without planning, to show the cap holding what a plan would miss.
   */
  readonly check?: DecodeCheck;
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
       * passed the memory cap (both the same every time, so they may be
       * remembered); `failed`: the process crashed or couldn't start, or
       * the decoder ran out of memory on its own (says nothing about the
       * image: never remembered); `timeout`: too slow; `busy`: the queue is
       * full.
       */
      readonly code: "refused" | "killed" | "failed" | "busy" | "timeout";
      readonly peakBytes?: number;
    };

export interface ThumbnailRenderer {
  /** Renders a thumbnail of `bytes`, decoded as `format`, to fit `box`. */
  render(format: string, bytes: Uint8Array, box: number): Promise<RenderResult>;
  /** How many decoder processes it has started (each refusal, kill or WebP starts another). */
  processesStarted(): number;
  /** Kills the decoder process; jobs still waiting are answered `busy`. */
  close(): Promise<void>;
}

/** The decoder's file: the build's JavaScript, or (tests, from the source) the TypeScript. */
function workerPath(): string {
  const built = fileURLToPath(new URL("./thumbnail-worker.js", import.meta.url));
  return existsSync(built)
    ? built
    : fileURLToPath(new URL("./thumbnail-worker.ts", import.meta.url));
}

/** The longest a decoder process may take to start and load its decoders (30 s). */
const STARTUP_MS = 30_000;

/** A process left holding more than this after a clean answer is replaced (32 MiB). */
export const REUSE_SLACK_BYTES = 32 * 1024 * 1024;

/**
 * The decoder process's environment: nothing of the server's (no secrets,
 * no NODE_OPTIONS loading hooks or changing its limits), but what Windows
 * needs to start a process.
 */
function decoderEnv(): NodeJS.ProcessEnv {
  const root = process.env.SystemRoot;
  return root === undefined ? {} : { SystemRoot: root };
}

interface Decoder {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Whether the parent reads its size (else its own watchdog holds the cap). */
  readonly parentWatches: boolean;
  ready: boolean;
  /** Its resident size when it said it was ready (parent-watched only). */
  baseline: number | undefined;
}

interface Pending {
  readonly job: ThumbnailJob;
  readonly done: (result: RenderResult) => void;
}

export function createThumbnailRenderer(options: ThumbnailRendererOptions = {}): ThumbnailRenderer {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxQueued = options.maxQueued ?? 1;
  const cap = options.memoryCapBytes ?? DECODE_MEMORY_CAP_BYTES;
  const heapMiB = options.heapMiB ?? Math.ceil(cap / (1024 * 1024));
  /** Killed this far up, so its peak (a sample later) stays within the cap. */
  const killAt = cap - Math.min(KILL_HEADROOM_BYTES, cap / 4);
  const sampleMs = options.sampleMs ?? 10;
  const queue: Pending[] = [];
  let decoder: Decoder | undefined;
  let running:
    | {
        readonly pending: Pending;
        timer: NodeJS.Timeout | undefined;
        sampler?: NodeJS.Timeout;
        sent?: boolean;
      }
    | undefined;
  let nextId = 1;
  let closed = false;
  let started = 0;

  /** Kills the decoder process (it is never asked again). */
  function stopDecoder(): void {
    const d = decoder;
    decoder = undefined;
    if (d === undefined) return;
    d.child.removeAllListeners();
    d.child.kill("SIGKILL");
  }

  function finish(result: RenderResult): void {
    const current = running;
    if (current === undefined) return;
    running = undefined;
    clearTimeout(current.timer);
    clearInterval(current.sampler);
    current.pending.done(result);
    next();
  }

  /** The decoder's growth since it was ready, now and at its peak (since the job began). */
  function growth(d: Decoder): { now: number; peak: number } | undefined {
    if (!d.parentWatches || d.baseline === undefined) return undefined;
    const memory = procMemory(d.pid);
    if (memory === undefined) return undefined;
    return { now: memory.rss - d.baseline, peak: memory.peak - d.baseline };
  }

  /** Past the cap: stopped at once (so it grows no further), its peak read, killed. */
  function killForMemory(d: Decoder): void {
    try {
      process.kill(d.pid, "SIGSTOP");
    } catch {
      // Already gone: its exit says so.
    }
    const seen = growth(d);
    stopDecoder();
    finish({ ok: false, code: "killed", ...(seen === undefined ? {} : { peakBytes: seen.peak }) });
  }

  function startDecoder(): Decoder {
    // The parent watches where it can read /proc; elsewhere the process watches itself.
    const parentWatches = options.watch !== "self" && procMemory("self") !== undefined;
    started++;
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${String(heapMiB)}`,
        "--max-semi-space-size=16",
        workerPath(),
        WORKER_MARK,
        String(parentWatches ? 0 : killAt),
      ],
      {
        // Its own output never reaches the server's log.
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        env: decoderEnv(),
        windowsHide: true,
      },
    );
    const d: Decoder = {
      child,
      pid: child.pid ?? -1,
      parentWatches,
      ready: false,
      baseline: undefined,
    };
    child.on("message", (answer: ThumbnailAnswer | { readonly ready: true }) => {
      if ("ready" in answer) {
        // Started, its decoders loaded and warmed up: its size now is the baseline.
        d.ready = true;
        d.baseline = parentWatches ? procMemory(d.pid)?.rss : undefined;
        if (parentWatches && d.baseline === undefined) {
          // Its size can't be read after all: never decode without the cap.
          if (decoder === d) {
            stopDecoder();
            finish({ ok: false, code: "failed" });
          }
          return;
        }
        if (decoder === d) dispatch();
        return;
      }
      const current = running;
      if (current?.pending.job.id !== answer.id) return;
      const seen = growth(d);
      const peak = seen === undefined ? {} : { peakBytes: seen.peak };
      // Kept only after a clean answer that left little behind (and never after a WebP).
      if (
        !answer.ok ||
        current.pending.job.format === "image/webp" ||
        (seen?.now ?? 0) > REUSE_SLACK_BYTES
      ) {
        stopDecoder();
      }
      finish(
        answer.ok
          ? { ok: true, jpeg: new Uint8Array(answer.jpeg), ...peak }
          : { ok: false, code: answer.code === TRANSIENT ? "failed" : "refused", ...peak },
      );
    });
    // An exit we didn't cause: SIGKILL is memory (its own watchdog, or the
    // system's out-of-memory killer); anything else a crash or a failed start.
    const lost = (_code: number | null, signal: NodeJS.Signals | null): void => {
      if (decoder === d) decoder = undefined;
      child.removeAllListeners();
      finish({ ok: false, code: signal === "SIGKILL" ? "killed" : "failed" });
    };
    child.on("exit", lost);
    child.on("error", () => {
      lost(null, null);
      child.kill("SIGKILL");
    });
    return d;
  }

  function next(): void {
    if (running !== undefined || closed) return;
    const pending = queue.shift();
    if (pending === undefined) {
      decoder?.child.unref();
      decoder?.child.channel?.unref();
      return;
    }
    decoder ??= startDecoder();
    decoder.child.ref();
    decoder.child.channel?.ref();
    running = { pending, timer: undefined };
    if (decoder.ready) {
      dispatch();
      return;
    }
    // Starting doesn't count against the job's time limit (review), but has a limit of its own.
    running.timer = setTimeout(() => {
      stopDecoder();
      finish({ ok: false, code: "failed" });
    }, STARTUP_MS);
  }

  /** Sends the running job to a ready decoder, starts its time limit and its memory watch. */
  function dispatch(): void {
    const current = running;
    const d = decoder;
    if (current === undefined || d === undefined || current.sent === true || !d.ready) return;
    clearTimeout(current.timer);
    current.sent = true;
    current.timer = setTimeout(() => {
      // Too slow: kill the process (its job can't be interrupted otherwise).
      stopDecoder();
      finish({ ok: false, code: "timeout" });
    }, timeoutMs);
    if (d.parentWatches && d.baseline !== undefined) {
      current.sampler = setInterval(() => {
        const seen = growth(d);
        if (seen !== undefined && seen.now > killAt && decoder === d) killForMemory(d);
      }, sampleMs);
    }
    const job =
      options.check === undefined
        ? current.pending.job
        : { ...current.pending.job, check: options.check };
    d.child.send(job, (error) => {
      if (error !== null && running === current) {
        stopDecoder();
        finish({ ok: false, code: "failed" });
      }
    });
  }

  return Object.freeze({
    render(format: string, bytes: Uint8Array, box: number): Promise<RenderResult> {
      if (closed || queue.length >= maxQueued) {
        return Promise.resolve({ ok: false, code: "busy" } as const);
      }
      return new Promise<RenderResult>((resolve) => {
        queue.push({ job: { id: nextId++, format, bytes, box }, done: resolve });
        next();
      });
    },
    processesStarted: () => started,
    close(): Promise<void> {
      closed = true;
      for (const pending of queue.splice(0)) pending.done({ ok: false, code: "busy" });
      if (running !== undefined) {
        clearTimeout(running.timer);
        clearInterval(running.sampler);
        const current = running;
        running = undefined;
        current.pending.done({ ok: false, code: "busy" });
      }
      stopDecoder();
      return Promise.resolve();
    },
  });
}
