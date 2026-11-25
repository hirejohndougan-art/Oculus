// The files folder's lease lock (S-052, D-086; fourth review R4-M1/M2):
// generations, judged stale by time alone for holders in another
// container. Eight worker processes take it over and over, each with a host
// key of its own (as if each were in another container, so no PID is ever
// checked), some crashing while they hold it; an O_EXCL "holder" file,
// made only while `held()` is true, catches any two holders at once: there
// must be none. A holder stopped (SIGSTOP) for longer than the stale time
// resumes to find `held()` false and does nothing. In one process: a live
// PID on this host is never stale, however old its lock; the heartbeat
// stops after the longest hold; the host key. Each worker runs
// lease-lock.ts as it is (Node strips its types), in a throwaway folder; the
// worker script is written to a folder of its own.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEASE_LOCK, LeaseLockBusy, hostKey, leaseGenerations, leaseLock } from "./lease-lock.js";

const LEASE_LOCK_TS = fileURLToPath(new URL("./lease-lock.ts", import.meta.url));
/** A lock in another container is stale after this long here (the default is two minutes). */
const STALE_MS = 1500;

const WORKER = `
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const [, , modulePath, dir, mode, roundsText, crashText, staleText] = process.argv;
const { leaseLock } = await import(modulePath);
const lock = leaseLock({
  root: dir,
  beatMs: 100,
  staleMs: Number(staleText),
  waitMs: 60000,
  // Another host or container: its PID means nothing to the others.
  hostKey: "elsewhere-" + randomBytes(6).toString("hex"),
});
const holder = join(dir, "holder");
const rounds = Number(roundsText);
const crashAt = Number(crashText);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < rounds; i++) {
  await lock.withLock(async (held) => {
    if (mode === "pause") {
      writeFileSync(join(dir, "paused-ready"), "");
      // Stopped from outside meanwhile, for longer than the stale time.
      await sleep(4000);
      const still = await held();
      writeFileSync(join(dir, "paused-held"), String(still));
      if (!still) return;
    } else if (!(await held())) {
      return;
    }
    try {
      writeFileSync(holder, String(process.pid), { flag: "wx" });
    } catch {
      writeFileSync(join(dir, "overlap-" + process.pid + "-" + i), "");
      return;
    }
    appendFileSync(join(dir, "holds.log"), process.pid + "\\n");
    await sleep(Math.floor(Math.random() * 4));
    unlinkSync(holder);
    // A crash while holding the lock: never released.
    if (i === crashAt) process.exit(9);
  });
}
`;

let scripts: string;
let dir: string;

beforeAll(() => {
  scripts = mkdtempSync(join(tmpdir(), "oculus-lease-worker-"));
  writeFileSync(join(scripts, "worker.mjs"), WORKER);
  dir = mkdtempSync(join(tmpdir(), "oculus-lease-lock-"));
});

afterAll(() => {
  rmSync(scripts, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function start(mode: "normal" | "pause", rounds: number, crashAt: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(scripts, "worker.mjs"),
      pathToFileURL(LEASE_LOCK_TS).href,
      dir,
      mode,
      String(rounds),
      String(crashAt),
      String(STALE_MS),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== 9) reject(new Error(`worker ${String(code)}: ${errors}`));
      else resolve(code);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the lease lock across processes in other containers (R4-M1/M2)", () => {
  it("never has two holders among eight contenders, with holders crashing, judged by time alone", async () => {
    const rounds = 10;
    let expected = 0;
    for (let wave = 0; wave < 3; wave++) {
      const crashes = [2, -1, -1, 6, -1, -1, -1, -1];
      const codes = await Promise.all(crashes.map((at) => exited(start("normal", rounds, at))));
      crashes.forEach((at, i) => {
        expected += at === -1 ? rounds : at + 1;
        expect(codes[i]).toBe(at === -1 ? 0 : 9);
      });
    }
    expect(readdirSync(dir).filter((n) => n.startsWith("overlap-"))).toEqual([]);
    const holds = readFileSync(join(dir, "holds.log"), "utf8").trim().split("\n");
    expect(holds).toHaveLength(expected);
  }, 240_000);

  it("a holder stopped past the stale time resumes to find held() false, and does nothing", async () => {
    const paused = start("pause", 1, -1);
    const done = exited(paused);
    for (let i = 0; i < 1000 && !existsSync(join(dir, "paused-ready")); i++) await sleep(10);
    paused.kill("SIGSTOP");
    // The others take it over once its lock is stale (by time: another container).
    const others = await Promise.all(
      Array.from({ length: 7 }, () => exited(start("normal", 3, -1))),
    );
    expect(others.every((code) => code === 0)).toBe(true);
    paused.kill("SIGCONT");
    expect(await done).toBe(0);
    expect(readFileSync(join(dir, "paused-held"), "utf8")).toBe("false");
    expect(readdirSync(dir).filter((n) => n.startsWith("overlap-"))).toEqual([]);
  }, 120_000);
});

describe("the lease lock in one process", () => {
  it("never judges a live PID on this host stale, however old its lock", async () => {
    const key = hostKey();
    if (key === undefined) return;
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-live-"));
    const path = join(own, `${LEASE_LOCK}.1`);
    writeFileSync(path, `${key}\n${String(process.ppid)}\nlive\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(path, old, old);
    const lock = leaseLock({ root: own, waitMs: 300 });
    await expect(lock.withLock(() => Promise.resolve(1))).rejects.toBeInstanceOf(LeaseLockBusy);
    expect(await leaseGenerations(own)).toEqual([1]);
    rmSync(own, { recursive: true, force: true });
  });

  it("M1: held() turns false once its own file is half the stale time old (a holder that wasn't moving it on)", async () => {
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-fresh-"));
    const lock = leaseLock({ root: own, staleMs: 400, beatMs: 100_000 });
    await lock.withLock(async (held) => {
      expect(await held()).toBe(true);
      await sleep(300);
      expect(await held()).toBe(false);
    });
    rmSync(own, { recursive: true, force: true });
  });

  it("writes the start time and thread with the PID, and keeps its nonces on globalThis (L-b, L-c)", async () => {
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-text-"));
    const nonces = (globalThis as Record<symbol, unknown>)[
      Symbol.for("oculus.leaseLock.heldNonces")
    ] as Set<string>;
    await leaseLock({ root: own }).withLock(async () => {
      const [, pid, nonce, started, thread] = readFileSync(
        join(own, `${LEASE_LOCK}.1`),
        "utf8",
      ).split("\n");
      expect(pid).toBe(String(process.pid));
      expect(nonces.has(nonce ?? "")).toBe(true);
      expect(thread).toBe("0");
      if (process.platform === "linux") expect(started).toMatch(/^[0-9]+$/);
      await Promise.resolve();
    });
    rmSync(own, { recursive: true, force: true });
  });

  it("L-b: a live PID on this host whose start time isn't the lock's is a reused PID: stale", async () => {
    const key = hostKey();
    if (key === undefined || process.platform !== "linux") return;
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-reused-"));
    writeFileSync(join(own, `${LEASE_LOCK}.1`), `${key}\n${String(process.ppid)}\nold\n1\n0\n`);
    expect(
      await leaseLock({ root: own, waitMs: 300 }).withLock(() => Promise.resolve("taken")),
    ).toBe("taken");
    rmSync(own, { recursive: true, force: true });
  });

  it("L-a, L-d: a holder tidies old temporary files and clock probes by the file system's clock", async () => {
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-tidy-"));
    const old = new Date(Date.now() - 10 * 60_000);
    const leftovers = [
      ".oculus-lease.tmp-0123456789abcdef",
      ".now-0123456789abcdef",
      ".mtime-0123456789abcdef",
    ];
    for (const name of leftovers) {
      writeFileSync(join(own, name), "");
      utimesSync(join(own, name), old, old);
    }
    writeFileSync(join(own, ".now-fedcba9876543210"), "");
    await leaseLock({ root: own }).withLock(() => Promise.resolve());
    for (const name of leftovers) expect(existsSync(join(own, name))).toBe(false);
    // A fresh probe (another process's, in use) stays.
    expect(existsSync(join(own, ".now-fedcba9876543210"))).toBe(true);
    rmSync(own, { recursive: true, force: true });
  });

  it("stops moving a lock's time on after the longest hold", async () => {
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-hold-"));
    const lock = leaseLock({ root: own, beatMs: 20, maxHoldMs: 100 });
    await lock.withLock(async (held) => {
      expect(await held()).toBe(true);
      await sleep(250);
      const path = join(own, `${LEASE_LOCK}.1`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(path, old, old);
      await sleep(150);
      // No longer moved on: a holder past its time looks stale to others.
      expect(Date.now() - statSync(path).mtimeMs).toBeGreaterThan(50_000);
    });
    rmSync(own, { recursive: true, force: true });
  });

  it("names this host by its name, boot and PID namespace on Linux, by its name elsewhere", () => {
    const key = hostKey();
    if (key !== undefined) expect(key.split("|")).toHaveLength(3);
    if (process.platform !== "linux") expect(key?.endsWith("|-|-")).toBe(true);
  });
});
