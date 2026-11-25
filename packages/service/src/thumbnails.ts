/**
 * The thumbnail renderer (M-003, D-097): one worker thread
 * (thumbnail-worker.ts) that decodes and scales one image at a time.
 *
 * - **One job at a time, a short queue.** At most `maxQueued` jobs wait;
 *   more are refused at once (`busy`, a 503), so a burst of requests for
 *   large images can't pile up memory or CPU on a small server.
 * - **Limits on the worker itself.** It runs with a heap limit
 *   (`resourceLimits`) and each job with a time limit: a job that runs out
 *   of either has its worker stopped (the next job starts a fresh one) and
 *   is answered `refused` (out of memory, like an image the decoder
 *   refused) or `timeout`.
 * - The worker is unreferenced while idle, so it never keeps a process
 *   alive, and `close()` stops it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WORKER_MARK, type ThumbnailAnswer, type ThumbnailJob } from "./thumbnail-worker.js";

export interface ThumbnailRendererOptions {
  /** The longest one job may take, in milliseconds (default 20 s). */
  readonly timeoutMs?: number;
  /** Jobs that may wait behind the running one (default 8). */
  readonly maxQueued?: number;
  /** The worker's heap limit in MiB (default 256). */
  readonly heapMiB?: number;
}

export type RenderResult =
  | { readonly ok: true; readonly jpeg: Uint8Array }
  | { readonly ok: false; readonly code: "refused" | "busy" | "timeout" };

export interface ThumbnailRenderer {
  /** Renders a thumbnail of `bytes`, decoded as `format`, to fit `box`. */
  render(format: string, bytes: Uint8Array, box: number): Promise<RenderResult>;
  /** Stops the worker; jobs still waiting are answered `busy`. */
  close(): Promise<void>;
}

/** The worker's file: the build's JavaScript, or (tests, from the source) the TypeScript. */
function workerUrl(): URL {
  const built = new URL("./thumbnail-worker.js", import.meta.url);
  return existsSync(fileURLToPath(built))
    ? built
    : new URL("./thumbnail-worker.ts", import.meta.url);
}

interface Pending {
  readonly job: ThumbnailJob;
  readonly done: (result: RenderResult) => void;
}

export function createThumbnailRenderer(options: ThumbnailRendererOptions = {}): ThumbnailRenderer {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxQueued = options.maxQueued ?? 8;
  const heapMiB = options.heapMiB ?? 256;
  const queue: Pending[] = [];
  let worker: Worker | undefined;
  let running: { readonly pending: Pending; readonly timer: NodeJS.Timeout } | undefined;
  let nextId = 1;
  let closed = false;

  function stopWorker(): void {
    const w = worker;
    worker = undefined;
    if (w !== undefined) {
      w.removeAllListeners();
      void w.terminate().catch(() => undefined);
    }
  }

  function finish(result: RenderResult): void {
    const current = running;
    if (current === undefined) return;
    running = undefined;
    clearTimeout(current.timer);
    current.pending.done(result);
    next();
  }

  function startWorker(): Worker {
    const w = new Worker(workerUrl(), {
      workerData: { mark: WORKER_MARK },
      resourceLimits: { maxOldGenerationSizeMb: heapMiB, maxYoungGenerationSizeMb: 32 },
      // The worker's own output never reaches the server's log.
      stdout: true,
      stderr: true,
    });
    w.stdout.resume();
    w.stderr.resume();
    w.on("message", (answer: ThumbnailAnswer) => {
      if (running?.pending.job.id !== answer.id) return;
      // A large WebP grew the worker's WebAssembly memory for good: replace it.
      if (answer.recycle) stopWorker();
      finish(answer.ok ? { ok: true, jpeg: answer.jpeg } : { ok: false, code: "refused" });
    });
    // Out of memory, a crash or an exit: this job is refused, the next gets a new worker.
    const lost = (): void => {
      if (worker === w) worker = undefined;
      w.removeAllListeners();
      finish({ ok: false, code: "refused" });
    };
    w.on("error", lost);
    w.on("exit", lost);
    return w;
  }

  function next(): void {
    if (running !== undefined || closed) return;
    const pending = queue.shift();
    if (pending === undefined) {
      worker?.unref();
      return;
    }
    worker ??= startWorker();
    worker.ref();
    const timer = setTimeout(() => {
      // Too slow: stop the worker (its job can't be interrupted otherwise).
      stopWorker();
      finish({ ok: false, code: "timeout" });
    }, timeoutMs);
    running = { pending, timer };
    // The job's bytes are copied into the worker (a transfer could detach the caller's buffer).
    worker.postMessage(pending.job);
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
    close(): Promise<void> {
      closed = true;
      for (const pending of queue.splice(0)) pending.done({ ok: false, code: "busy" });
      if (running !== undefined) {
        clearTimeout(running.timer);
        const current = running;
        running = undefined;
        current.pending.done({ ok: false, code: "busy" });
      }
      stopWorker();
      return Promise.resolve();
    },
  });
}
