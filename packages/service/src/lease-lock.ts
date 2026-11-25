/**
 * The files folder's lease lock (S-052, D-086): a purge step, a lease
 * renewal, a bind and an adopt of every database using the folder take it,
 * so no lease moves between a step's check and its rename or unlink. Node
 * has no `flock`. Only Node's own modules are imported here (the
 * multi-process test runs it in worker processes as it is).
 *
 * **Generations** (fourth review, R4-M1/M2). The lock is a series of files
 * `.oculus-lease.lock.<n>`; the highest `n` is the current one. Each file is
 * written whole under a temporary name and linked to its generation's name,
 * which fails if that name exists, so:
 * - a free folder is taken by making generation 1;
 * - a lock whose holder released it (its file says `released`) or is gone
 *   (below) is taken over by making generation `n + 1`. Of any number of
 *   takers exactly one makes it; the rest see it and wait. Nothing is
 *   deleted or renamed for this to hold;
 * - `held()` is true only while no higher generation exists and the
 *   holder's own file still holds its text. A holder that was paused past
 *   the stale time and resumes finds `held()` false (the caller checks it
 *   right before each rename or unlink) and does nothing;
 * - older generations are deleted lazily, only by a holder, only below its
 *   own. A taker that read the folder before such a clean-up can make a
 *   generation below the current one; it checks it made the highest, and if
 *   not removes its own and tries again (it never held anything).
 *
 * **Gone.** A generation is judged from one open of it (`O_NOFOLLOW`),
 * `fstat` and a read through the same handle. On this host, the same
 * hostname, boot and PID namespace (`hostKey`), its PID is authoritative:
 * while that process lives the lock is never stale, whatever its age; a
 * PID that no longer exists, or this process with a nonce it doesn't hold,
 * is gone. Anything else (another host or container, or no host key) is
 * stale once its time, which the holder moves on every 20 seconds for at
 * most 10 minutes, is more than two minutes from the file system's now,
 * either way.
 */
import { randomBytes } from "node:crypto";
import { constants, readFileSync, readlinkSync } from "node:fs";
import { link, lstat, open, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** The lock files' common name; each generation adds `.<n>`. */
export const LEASE_LOCK = ".oculus-lease.lock";

/** A lock this far from now, either way, by the file system's clock, is stale (2 minutes). */
export const LEASE_LOCK_STALE_MS = 2 * 60_000;
/** How long a taker waits (15 seconds). */
const WAIT_MS = 15_000;
/** How often a held lock's time moves on (20 seconds). */
const BEAT_MS = 20_000;
/** The longest a holder keeps moving its lock's time on (10 minutes). */
const MAX_HOLD_MS = 10 * 60_000;

const GENERATION = /^\.oculus-lease\.lock\.([1-9][0-9]{0,15})$/;
const TEMPORARY = /^\.oculus-lease\.tmp-[0-9a-f]{16}$/;

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
 * This host as a lock holder, so a PID means the same process to both
 * sides: on Linux the hostname, this boot's ID and this process's PID
 * namespace (a container has its own); where there is no `/proc` (macOS,
 * Windows, which have no PID namespaces) the hostname alone. `undefined`
 * on Linux when any of them can't be read: then only the time counts.
 */
export function hostKey(): string | undefined {
  if (cachedHostKey === undefined) {
    const name = hostname();
    if (process.platform !== "linux") {
      cachedHostKey = name === "" ? null : `${name}|-|-`;
    } else {
      try {
        const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const pidNamespace = readlinkSync("/proc/self/ns/pid");
        cachedHostKey =
          boot === "" || pidNamespace === "" || name === ""
            ? null
            : `${name}|${boot}|${pidNamespace}`;
      } catch {
        cachedHostKey = null;
      }
    }
    if (cachedHostKey !== null) {
      cachedHostKey = cachedHostKey.replace(/[^A-Za-z0-9.:|[\]_-]/g, "_").slice(0, 200);
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

export interface LeaseLockOptions {
  /** The files folder. */
  readonly root: string;
  /** How often a held lock's time moves on (tests). */
  readonly beatMs?: number;
  /** The longest a holder keeps it fresh (default 10 minutes). */
  readonly maxHoldMs?: number;
  /** When a lock on another host is stale (tests; default 2 minutes). */
  readonly staleMs?: number;
  /** How long a taker waits (tests; default 15 seconds). */
  readonly waitMs?: number;
  /** This holder's host key (tests: another host or container); default `hostKey()`. */
  readonly hostKey?: string | null;
}

export interface LeaseLock {
  /**
   * Runs `work` holding the lock; `held()` says whether it is still this
   * holder's (no later generation, and its file still its own).
   */
  withLock<T>(work: (held: () => Promise<boolean>) => Promise<T>): Promise<T>;
}

/** The generations in the folder, highest first. */
export async function leaseGenerations(root: string): Promise<number[]> {
  const out: number[] = [];
  for (const name of await readdir(root)) {
    const match = GENERATION.exec(name);
    if (match?.[1] !== undefined) out.push(Number(match[1]));
  }
  return out.sort((a, b) => b - a);
}

export function leaseLock(options: LeaseLockOptions): LeaseLock {
  const { root } = options;
  const staleMs = options.staleMs ?? LEASE_LOCK_STALE_MS;
  const ourKey = options.hostKey === undefined ? hostKey() : (options.hostKey ?? undefined);
  const nameOf = (n: number): string => join(root, `${LEASE_LOCK}.${String(n)}`);

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

  /** One open, fstat and read through the same handle; `undefined` if it is gone. */
  async function inspect(n: number): Promise<{ text: string; mtimeMs: number } | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(nameOf(n), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("The files folder's lease lock isn't a plain file.");
      const text = await handle.readFile("utf8");
      return { text, mtimeMs: info.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  /** Whether generation `n`'s holder released it or is gone (see the module header). */
  async function free(n: number): Promise<boolean> {
    const seen = await inspect(n);
    if (seen === undefined) return true;
    if (seen.text.startsWith("released\n")) return true;
    const [key = "", pidText = "", nonce = ""] = seen.text.split("\n");
    const pid = Number(pidText);
    if (ourKey !== undefined && key === ourKey && Number.isSafeInteger(pid) && pid > 0) {
      // On this host the PID decides, whatever the file's age.
      return pid === process.pid ? !heldNonces.has(nonce) : !alive(pid);
    }
    return Math.abs((await fileSystemNow()) - seen.mtimeMs) > staleMs;
  }

  /** Makes generation `n` holding `text`, whole, or answers `false` if it exists. */
  async function make(n: number, text: string): Promise<boolean> {
    const temporary = join(root, `.oculus-lease.tmp-${randomBytes(8).toString("hex")}`);
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, nameOf(n));
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
        throw error;
      }
      // No hard links here: made O_EXCL directly (a reader may see it empty
      // for a moment, which counts as live until its time says otherwise).
      try {
        await writeFile(nameOf(n), text, { mode: 0o600, flag: "wx" });
        return true;
      } catch (inner) {
        if ((inner as { code?: unknown }).code === "EEXIST") return false;
        throw inner;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    async withLock(work) {
      const nonce = randomBytes(12).toString("hex");
      const mine = `${ourKey ?? "-"}\n${String(process.pid)}\n${nonce}\n`;
      const until = Date.now() + (options.waitMs ?? WAIT_MS);
      // Known as held before it exists, so this process never judges its own
      // fresh lock stale.
      heldNonces.add(nonce);
      let generation = 0;
      try {
        for (;;) {
          const top = (await leaseGenerations(root))[0] ?? 0;
          if ((top === 0 || (await free(top))) && (await make(top + 1, mine))) {
            // Made from a stale reading (a holder had already cleaned the
            // generations below its own): not the current one, so not held.
            // Taken back, and tried again.
            if ((await leaseGenerations(root))[0] === top + 1) {
              generation = top + 1;
              break;
            }
            await rm(nameOf(top + 1), { force: true });
          }
          if (Date.now() > until) throw new LeaseLockBusy();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch (error) {
        heldNonces.delete(nonce);
        throw error;
      }
      const held = async (): Promise<boolean> =>
        (await leaseGenerations(root))[0] === generation &&
        (await inspect(generation))?.text === mine;
      // Older generations, only below this one, and this holder's leftovers.
      try {
        for (const name of await readdir(root)) {
          const match = GENERATION.exec(name);
          if (match?.[1] !== undefined && Number(match[1]) < generation) {
            await rm(join(root, name), { force: true });
          } else if (TEMPORARY.test(name)) {
            const info = await lstat(join(root, name)).catch(() => undefined);
            if (info !== undefined && Date.now() - info.mtimeMs > staleMs) {
              await rm(join(root, name), { force: true });
            }
          }
        }
      } catch {
        // Tidying only.
      }
      const stopBeating = Date.now() + (options.maxHoldMs ?? MAX_HOLD_MS);
      const beat = setInterval(() => {
        if (Date.now() > stopBeating) {
          clearInterval(beat);
          return;
        }
        void held()
          .then(async (still) => {
            if (!still) return;
            const now = (await fileSystemNow()) / 1000;
            await utimes(nameOf(generation), now, now);
          })
          .catch(() => undefined);
      }, options.beatMs ?? BEAT_MS);
      beat.unref();
      try {
        return await work(held);
      } finally {
        clearInterval(beat);
        // Released by saying so in its own file, only while it is still the
        // current generation and its own: a later taker makes the next one.
        try {
          if (await held()) {
            await writeFile(nameOf(generation), "released\n", { mode: 0o600 });
          }
        } catch {
          // A lock left as it is becomes stale in time.
        }
        heldNonces.delete(nonce);
      }
    },
  };
}
