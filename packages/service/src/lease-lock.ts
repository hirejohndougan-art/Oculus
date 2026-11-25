/**
 * The files folder's lease lock (S-052, D-086): a lock file beside the
 * marker that a purge step, a lease renewal, a bind, an adopt and an accept
 * of every database using the folder take, so no lease moves between a
 * step's check and its rename or unlink. Node has no `flock`, so it is a
 * file made `O_EXCL`. Only Node's own modules are imported here (the
 * multi-process test runs it in worker processes as it is).
 *
 * - **Taking it:** made `O_EXCL` with this holder's host key, PID and a
 *   nonce. If it exists and its holder is gone (`stale`), it is removed
 *   **under the gate** (below) and only if it still holds exactly what was
 *   judged stale; nothing is ever renamed or linked back, so a live lock is
 *   never moved. Otherwise the taker waits up to 15 seconds (`LeaseLockBusy`).
 * - **Stale:** on this host (the same hostname, boot and PID namespace:
 *   `hostKey`), a holder process that no longer exists, or this process
 *   with a nonce it doesn't hold (an earlier instance with the same PID);
 *   anywhere, a lock more than two minutes old, or more than two minutes in
 *   the future, by the file system's clock. Without a readable host key,
 *   only the time counts.
 * - **Holding it:** its time moves on every 20 seconds, for at most
 *   `maxHoldMs` (10 minutes, a purge run's lease); the work gets `held()`,
 *   which reads the lock again (the caller checks it right before each
 *   rename or unlink).
 * - **Releasing it:** under the gate, removed only if it still holds this
 *   holder's text.
 * - **The gate** (`.oculus-lease.gate`): a short-lived `O_EXCL` file that
 *   serialises takeovers and releases. Stale after 10 seconds, or at once
 *   when its holder is gone (as above).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { lstat, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** The lock file beside the marker. */
export const LEASE_LOCK = ".oculus-lease.lock";
/** The gate that serialises takeovers and releases of the lock. */
export const LEASE_GATE = ".oculus-lease.gate";

/** A lock this far from now, either way, by the file system's clock, is stale (2 minutes). */
export const LEASE_LOCK_STALE_MS = 2 * 60_000;
/** A gate this far from now is stale (10 seconds). */
const GATE_STALE_MS = 10_000;
/** How long a taker waits (15 seconds). */
const WAIT_MS = 15_000;
/** How often a held lock's time moves on (20 seconds). */
const BEAT_MS = 20_000;
/** The longest a holder keeps moving its lock's time on (10 minutes). */
const MAX_HOLD_MS = 10 * 60_000;

/** The lock was held by someone else for the whole wait. */
export class LeaseLockBusy extends Error {
  constructor() {
    super("The files folder's lease lock is held.");
    this.name = "LeaseLockBusy";
  }
}

/** The nonces of the locks this process holds now (whatever store took them). */
const heldNonces = new Set<string>();

let cachedHostKey: string | null | undefined;

/**
 * This host as a lock holder: the hostname, this boot's ID and this
 * process's PID namespace, so a PID means the same process to both sides.
 * `undefined` when any of them can't be read (then only the time rule).
 */
export function hostKey(): string | undefined {
  if (cachedHostKey === undefined) {
    try {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const pidNamespace = readlinkSync("/proc/self/ns/pid");
      const name = hostname();
      cachedHostKey =
        boot === "" || pidNamespace === "" || name === ""
          ? null
          : `${name}|${boot}|${pidNamespace}`.replace(/[^A-Za-z0-9.:|[\]_-]/g, "_").slice(0, 200);
    } catch {
      cachedHostKey = null;
    }
  }
  return cachedHostKey ?? undefined;
}

/** Whether a process with this PID exists here (EPERM: it does, as someone else). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

interface Seen {
  readonly text: string;
  readonly mtimeMs: number;
}

async function read(path: string): Promise<Seen | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isFile()) throw new Error("The files folder's lease lock isn't a plain file.");
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? undefined : { text, mtimeMs: info.mtimeMs };
}

/**
 * Whether a lock's (or the gate's) holder is gone: its process on this host
 * no longer exists, or it is this process with a nonce it doesn't hold; or
 * its time is more than `limitMs` from the file system's now either way.
 */
function stale(seen: Seen, now: number, limitMs: number): boolean {
  const [key = "", pidText = "", nonce = ""] = seen.text.split("\n");
  const here = hostKey();
  const pid = Number(pidText);
  if (here !== undefined && key === here && Number.isSafeInteger(pid) && pid > 0) {
    if (pid === process.pid ? !heldNonces.has(nonce) : !alive(pid)) return true;
  }
  return Math.abs(now - seen.mtimeMs) > limitMs;
}

export interface LeaseLockOptions {
  /** The files folder. */
  readonly root: string;
  /** How often a held lock's time moves on (tests). */
  readonly beatMs?: number;
  /** The longest a holder keeps it fresh (default 10 minutes). */
  readonly maxHoldMs?: number;
}

export interface LeaseLock {
  /**
   * Runs `work` holding the lock; `held()` reads the lock again and says
   * whether it is still this holder's.
   */
  withLock<T>(work: (held: () => Promise<boolean>) => Promise<T>): Promise<T>;
}

export function leaseLock(options: LeaseLockOptions): LeaseLock {
  const { root } = options;
  const lockPath = join(root, LEASE_LOCK);
  const gatePath = join(root, LEASE_GATE);

  /** "Now" by the file system's clock: a probe file's time. */
  async function fileSystemNow(): Promise<number> {
    const probe = join(root, `.now-${randomBytes(8).toString("hex")}`);
    await writeFile(probe, "", { mode: 0o600, flag: "wx" });
    try {
      return (await lstat(probe)).mtimeMs;
    } finally {
      await rm(probe, { force: true });
    }
  }

  function text(nonce: string): string {
    return `${hostKey() ?? "-"}\n${String(process.pid)}\n${nonce}\n`;
  }

  /** Runs `work` holding the gate; waits up to `WAIT_MS` for it. */
  async function gated<T>(work: () => Promise<T>): Promise<T> {
    const nonce = randomBytes(12).toString("hex");
    const mine = text(nonce);
    const until = Date.now() + WAIT_MS;
    for (;;) {
      try {
        await writeFile(gatePath, mine, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      }
      const seen = await read(gatePath);
      if (seen !== undefined && stale(seen, await fileSystemNow(), GATE_STALE_MS)) {
        // Removed only if it still holds what was judged stale.
        const again = await read(gatePath);
        if (again?.text === seen.text) await rm(gatePath, { force: true });
        continue;
      }
      if (Date.now() > until) throw new LeaseLockBusy();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    heldNonces.add(nonce);
    try {
      return await work();
    } finally {
      heldNonces.delete(nonce);
      if ((await read(gatePath).catch(() => undefined))?.text === mine) {
        await rm(gatePath, { force: true });
      }
    }
  }

  return {
    async withLock(work) {
      const nonce = randomBytes(12).toString("hex");
      const mine = text(nonce);
      const until = Date.now() + WAIT_MS;
      // Known as held before it exists, so this process never judges its own
      // fresh lock stale.
      heldNonces.add(nonce);
      try {
        for (;;) {
          try {
            await writeFile(lockPath, mine, { mode: 0o600, flag: "wx" });
            break;
          } catch (error) {
            if ((error as { code?: unknown }).code !== "EEXIST") throw error;
          }
          const seen = await read(lockPath);
          if (seen !== undefined && stale(seen, await fileSystemNow(), LEASE_LOCK_STALE_MS)) {
            await gated(async () => {
              const again = await read(lockPath);
              if (again?.text === seen.text) await rm(lockPath, { force: true });
            });
            continue;
          }
          if (Date.now() > until) throw new LeaseLockBusy();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch (error) {
        heldNonces.delete(nonce);
        throw error;
      }
      const stopBeating = Date.now() + (options.maxHoldMs ?? MAX_HOLD_MS);
      const beat = setInterval(() => {
        if (Date.now() > stopBeating) {
          clearInterval(beat);
          return;
        }
        void read(lockPath)
          .then(async (seen) => {
            if (seen?.text === mine) {
              const now = (await fileSystemNow()) / 1000;
              await utimes(lockPath, now, now);
            }
          })
          .catch(() => undefined);
      }, options.beatMs ?? BEAT_MS);
      beat.unref();
      const held = async (): Promise<boolean> => (await read(lockPath))?.text === mine;
      try {
        return await work(held);
      } finally {
        clearInterval(beat);
        await gated(async () => {
          if ((await read(lockPath))?.text === mine) await rm(lockPath, { force: true });
        }).catch(() => undefined);
        heldNonces.delete(nonce);
      }
    },
  };
}
