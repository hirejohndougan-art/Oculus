// The files folder's lease lock (S-052, D-086; third review R3-M1): worker
// processes take it over and over, some crashing while they hold it, and an
// O_EXCL "holder" file inside the lock catches any two holders at once:
// there must be none. Also the heartbeat stopping after the longest hold,
// and the host key. Each worker runs lease-lock.ts as it is (Node strips
// its types), in a throwaway folder; the worker script is written to a
// folder of its own.
import { spawn } from "node:child_process";
import {
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
import { LEASE_LOCK, hostKey, leaseLock } from "./lease-lock.js";

const LEASE_LOCK_TS = fileURLToPath(new URL("./lease-lock.ts", import.meta.url));

const WORKER = `
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [, , modulePath, dir, roundsText, crashText] = process.argv;
const { leaseLock } = await import(modulePath);
const lock = leaseLock({ root: dir, beatMs: 50 });
const holder = join(dir, "holder");
const rounds = Number(roundsText);
const crashAt = Number(crashText);
for (let i = 0; i < rounds; i++) {
  await lock.withLock(async () => {
    try {
      writeFileSync(holder, String(process.pid), { flag: "wx" });
    } catch {
      writeFileSync(join(dir, "overlap-" + process.pid + "-" + i), "");
      return;
    }
    appendFileSync(join(dir, "holds.log"), process.pid + "\\n");
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
    unlinkSync(holder);
    // A crash while holding the lock: it is never released.
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

function worker(rounds: number, crashAt: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        join(scripts, "worker.mjs"),
        pathToFileURL(LEASE_LOCK_TS).href,
        dir,
        String(rounds),
        String(crashAt),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== 9) reject(new Error(`worker ${String(code)}: ${errors}`));
      else resolve(code);
    });
  });
}

describe("the lease lock across processes (R3-M1)", () => {
  it("never has two holders, with workers crashing while they hold it", async () => {
    if (hostKey() === undefined) return; // A crashed holder is then only stale after two minutes.
    const rounds = 12;
    let expected = 0;
    for (let wave = 0; wave < 4; wave++) {
      const crashes = [3, -1, 7, -1, 1, -1];
      const codes = await Promise.all(crashes.map((at) => worker(rounds, at)));
      crashes.forEach((at, i) => {
        expected += at === -1 ? rounds : at + 1;
        expect(codes[i]).toBe(at === -1 ? 0 : 9);
      });
    }
    expect(readdirSync(dir).filter((n) => n.startsWith("overlap-"))).toEqual([]);
    const holds = readFileSync(join(dir, "holds.log"), "utf8").trim().split("\n");
    expect(holds).toHaveLength(expected);
  }, 120_000);
});

describe("the lease lock in one process", () => {
  it("stops moving a lock's time on after the longest hold", async () => {
    const own = mkdtempSync(join(tmpdir(), "oculus-lease-hold-"));
    const lock = leaseLock({ root: own, beatMs: 20, maxHoldMs: 100 });
    await lock.withLock(async (held) => {
      expect(await held()).toBe(true);
      await new Promise((r) => setTimeout(r, 250));
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(own, LEASE_LOCK), old, old);
      await new Promise((r) => setTimeout(r, 150));
      // No longer moved on: a holder past its time looks stale to others.
      expect(Date.now() - statSync(join(own, LEASE_LOCK)).mtimeMs).toBeGreaterThan(50_000);
    });
    rmSync(own, { recursive: true, force: true });
  });

  it("names this host by its name, boot and PID namespace", () => {
    const key = hostKey();
    if (key !== undefined) expect(key.split("|")).toHaveLength(3);
  });
});
