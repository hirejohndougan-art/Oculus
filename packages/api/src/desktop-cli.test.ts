// The launcher against real throwaway databases (D-049): it refuses what it
// should, serves the admin on 127.0.0.1, opens and closes its window, and
// never prints the database password or the secret key.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, setUpFirstInstall, sql } from "@oculus/db";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { runDesktop, type DesktopOptions, type WindowProcess } from "./desktop-cli.js";

const PASSWORD = "Invented-db-pw-4417";

let setUp: TestDatabase;
let empty: TestDatabase;
let folder: string;
let adminDir: string;

beforeAll(async () => {
  setUp = await freshDatabase();
  empty = await freshDatabase();
  await migrate({ connectionString: setUp.url });
  const db = openDatabase(setUp.url, { max: 1 });
  try {
    const result = await setUpFirstInstall(db, {
      email: "root@example.org",
      displayName: "Invented Root",
      password: "Invented river bend lantern 2026",
      organizationName: "Invented Historical Society",
      siteName: "Invented Archive",
    });
    expect(result.ok).toBe(true);
  } finally {
    await db.close();
  }
}, 120_000);

afterAll(async () => {
  await setUp.drop();
  await empty.drop();
});

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "oculus-desktop-cli-"));
  adminDir = join(folder, "admin-build");
  mkdirSync(adminDir);
  writeFileSync(join(adminDir, "index.html"), "<!doctype html><title>Invented admin</title>");
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A stand-in for the browser window: records how it was opened. */
class FakeWindow extends EventEmitter implements WindowProcess {
  killed = false;
  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    this.emit("exit");
    return true;
  }
  close(): void {
    this.emit("exit");
  }
}

interface Run {
  done: Promise<number>;
  lines: string[];
  windows: FakeWindow[];
  defaults: string[];
  stop: () => void;
}

function start(overrides: Partial<DesktopOptions> & { env?: DesktopOptions["env"] } = {}): Run {
  const lines: string[] = [];
  const windows: FakeWindow[] = [];
  const defaults: string[] = [];
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const done = runDesktop({
    env: {
      OCULUS_DESKTOP_HOME: folder,
      OCULUS_DATABASE_URL: setUp.url,
      OCULUS_DESKTOP_BROWSER: "/invented/browser",
      ...overrides.env,
    },
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
    openWindow: (command, args) => {
      const window = new FakeWindow(command, args);
      windows.push(window);
      return window;
    },
    openDefault: (url) => defaults.push(url),
    stopRequested: () => stopped,
    adminDir,
    handOffMs: 0,
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "env")),
  });
  return { done, lines, windows, defaults, stop };
}

async function until<T>(read: () => T | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const running = (run: Run) =>
  until(() => run.lines.find((l) => l.startsWith("Oculus is running at "))?.slice(21));

describe("npm run desktop", () => {
  it("serves the admin on 127.0.0.1, opens its window, and stops when the window closes", async () => {
    const run = start();
    const url = await running(run);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const window = await until(() => run.windows[0]);
    expect(window.command).toBe("/invented/browser");
    expect(window.args).toContain(`--app=${url}`);
    expect(window.args).toContain(`--user-data-dir=${join(folder, "window")}`);

    const health = await fetch(new URL("/health", url));
    expect(await health.json()).toEqual({ status: "ok" });
    const page = await fetch(url);
    expect(await page.text()).toContain("Invented admin");
    expect(JSON.parse(readFileSync(join(folder, "desktop.lock"), "utf8"))).toEqual({
      pid: process.pid,
      url,
    });
    expect(existsSync(join(folder, "secret-key"))).toBe(true);

    window.close();
    expect(await run.done).toBe(0);
    await expect(fetch(new URL("/health", url))).rejects.toThrow();
    expect(existsSync(join(folder, "desktop.lock"))).toBe(false);
  });

  it("answers only the origin it serves (a rebinding page's writes are refused)", async () => {
    const run = start();
    const url = await running(run);
    const reply = await fetch(new URL("/api/sign-in", url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
    });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
    run.windows[0]?.close();
    expect(await run.done).toBe(0);
  });

  it("closes its window and stops on Ctrl+C", async () => {
    const run = start();
    await running(run);
    run.stop();
    expect(await run.done).toBe(0);
    expect(run.windows[0]?.killed).toBe(true);
  });

  it("opens another window on the running server instead of starting a second", async () => {
    // Another launcher's process (a stand-in that lives), holding the lock.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const url = "http://127.0.0.1:4999/";
      writeFileSync(join(folder, "desktop.lock"), JSON.stringify({ pid: other.pid, url }));
      const second = start();
      expect(await second.done).toBe(0);
      expect(second.windows[0]?.args).toContain(`--app=${url}`);
      expect(second.lines.some((l) => l.startsWith("Oculus is running at"))).toBe(false);
      expect(existsSync(join(folder, "secret-key"))).toBe(false);
    } finally {
      other.kill();
      await new Promise((resolve) => other.once("exit", resolve));
    }
  });

  it("opens the default browser and waits for Ctrl+C when no app-window browser is found", async () => {
    const run = start({ findBrowser: () => undefined });
    const url = await running(run);
    expect(await until(() => run.defaults[0])).toBe(url);
    expect(run.windows).toHaveLength(0);
    run.stop();
    expect(await run.done).toBe(0);
  });

  it("keeps running when the window is handed to a browser already open", async () => {
    const run = start({ handOffMs: 60_000 });
    await running(run);
    run.windows[0]?.close();
    await until(() => run.lines.find((l) => l.includes("Press Ctrl+C")));
    run.stop();
    expect(await run.done).toBe(0);
  });

  it("moves to a free port when the wanted one is taken", async () => {
    const busy: Server = createServer();
    const taken = await new Promise<number>((resolve) => {
      busy.listen(0, "127.0.0.1", () => {
        const address = busy.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      const run = start({ env: { OCULUS_PORT: String(taken) } });
      const url = await running(run);
      expect(url).not.toContain(`:${String(taken)}/`);
      run.stop();
      expect(await run.done).toBe(0);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it("refuses a database that hasn't been set up, pointing to npm run setup", async () => {
    const run = start({ env: { OCULUS_DATABASE_URL: empty.url } });
    expect(await run.done).toBe(1);
    expect(run.lines.join("\n")).toContain("npm run setup");
    expect(run.windows).toHaveLength(0);
  });

  it("refuses a database that isn't Oculus's", async () => {
    const other = await freshDatabase();
    try {
      const db = openDatabase(other.url, { max: 1 });
      await db.execute(sql`CREATE TABLE someone_elses (id int)`);
      await db.close();
      const run = start({ env: { OCULUS_DATABASE_URL: other.url } });
      expect(await run.done).toBe(1);
      expect(run.lines.join("\n")).toContain("isn't an Oculus database");
      const after = openDatabase(other.url, { max: 1 });
      const tables = await after.rows(sql`SELECT to_regclass('public.oculus_migrations') AS t`);
      await after.close();
      expect(tables).toEqual([{ t: null }]);
    } finally {
      await other.drop();
    }
  });

  it("says how to start when no database is named", async () => {
    const run = start({ env: { OCULUS_DATABASE_URL: undefined } });
    expect(await run.done).toBe(2);
    expect(run.lines.join("\n")).toContain("desktop.json");
  });

  it("never prints the database password or the secret key", async () => {
    const withPassword = new URL(setUp.url);
    withPassword.password = PASSWORD;
    const run = start({ env: { OCULUS_DATABASE_URL: withPassword.href } });
    await running(run);
    run.stop();
    expect(await run.done).toBe(0);
    const key = readFileSync(join(folder, "secret-key"), "utf8").trim();
    const printed = run.lines.join("\n");
    expect(printed).toContain("pgpass");
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(key);
  });

  it("refuses an OCULUS_PORT that isn't a port", async () => {
    const run = start({ env: { OCULUS_PORT: "80" } });
    expect(await run.done).toBe(2);
  });
});
