// The launcher against real throwaway databases (D-049): it refuses what it
// should, serves the admin on 127.0.0.1, opens and closes its window, and
// never prints the database password or the secret key.
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { UserId } from "@oculus/core";
import { migrate, openDatabase, setUpFirstInstall, sql } from "@oculus/db";
import {
  FAKE_TEST_SECRET_KEY,
  FAKE_TEST_SECRET_KEY_2,
  giveTestFactor,
  testKeyring,
} from "../../db/src/second-factor.fixtures.js";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { runDesktop, type DesktopOptions, type WindowProcess } from "./desktop-cli.js";

const PASSWORD = "Invented-db-pw-4417";

let setUp: TestDatabase;
let empty: TestDatabase;
let folder: string;
let adminDir: string;

/** A database set up as `npm run setup` leaves it (migrations from `dir` if given). */
async function setUpDatabase(dir?: string): Promise<{ database: TestDatabase; userId: UserId }> {
  const database = await freshDatabase();
  await migrate({ connectionString: database.url, ...(dir === undefined ? {} : { dir }) });
  const db = openDatabase(database.url, { max: 1 });
  try {
    const result = await setUpFirstInstall(db, {
      email: "root@example.org",
      displayName: "Invented Root",
      password: "Invented river bend lantern 2026",
      organizationName: "Invented Historical Society",
      siteName: "Invented Archive",
    });
    if (!result.ok) throw new Error("setup failed");
    return { database, userId: result.value.userId };
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  setUp = (await setUpDatabase()).database;
  empty = await freshDatabase();
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
    const lock = JSON.parse(readFileSync(join(folder, "desktop.lock"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(lock.pid).toBe(process.pid);
    expect(lock.url).toBe(url);
    expect(lock.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(existsSync(join(folder, "secret-key"))).toBe(true);

    window.close();
    expect(await run.done).toBe(0);
    await expect(fetch(new URL("/health", url))).rejects.toThrow();
    expect(existsSync(join(folder, "desktop.lock"))).toBe(false);
  });

  it("refuses another site's writes and a rebinding host's (Origin check, D-088)", async () => {
    const run = start();
    const url = await running(run);
    const port = new URL(url).port;
    const post = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/sign-in", method: "POST", headers },
          (reply) => {
            let body = "";
            reply.on("data", (chunk: Buffer) => (body += chunk.toString()));
            reply.on("end", () => {
              resolve({ status: reply.statusCode ?? 0, body });
            });
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    const json = { "content-type": "application/json" };
    const other = await post({ ...json, origin: "http://evil.example" });
    expect(other.status).toBe(403);
    expect(other.body).toContain("cross_origin");
    const rebound = await post({
      ...json,
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`,
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain("cross_origin");
    // The page's own origin gets past the check (to the body check).
    const own = await post({ ...json, origin: `http://127.0.0.1:${port}` });
    expect(own.body).not.toContain("cross_origin");
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
    const first = start();
    const url = await running(first);
    const second = start();
    expect(await second.done).toBe(0);
    expect(second.windows[0]?.args).toContain(`--app=${url}`);
    expect(second.lines.some((l) => l.startsWith("Oculus is running at"))).toBe(false);
    first.stop();
    expect(await first.done).toBe(0);
  });

  it("refuses to open the running server's window for a different database", async () => {
    const first = start();
    await running(first);
    const second = start({ env: { OCULUS_DATABASE_URL: empty.url } });
    expect(await second.done).toBe(1);
    expect(second.lines.join("\n")).toContain("another database");
    first.stop();
    expect(await first.done).toBe(0);
  });

  it("starts normally over a stale lock whose PID lives but whose address is dead", async () => {
    writeFileSync(
      join(folder, "desktop.lock"),
      JSON.stringify({
        pid: 1,
        token: "t".repeat(43),
        database: "oculus on localhost",
        started: Date.now(),
        url: "http://127.0.0.1:1/",
      }),
    );
    const run = start();
    await running(run);
    run.stop();
    expect(await run.done).toBe(0);
    expect(existsSync(join(folder, "desktop.lock"))).toBe(false);
  });

  it("stops the server and leaves nothing running when something fails after it listens", async () => {
    const run = start({
      findBrowser: () => undefined,
      openDefault: () => {
        throw new Error("no default browser");
      },
    });
    const url = await running(run);
    expect(await run.done).toBe(1);
    await expect(fetch(new URL("/health", url))).rejects.toThrow();
    expect(existsSync(join(folder, "desktop.lock"))).toBe(false);
  });

  it("falls back to the default browser when the window can't be started", async () => {
    const run = start({
      openWindow: () => {
        throw new Error("spawn EINVAL");
      },
    });
    const url = await running(run);
    expect(await until(() => run.defaults[0])).toBe(url);
    run.stop();
    expect(await run.done).toBe(0);
  });

  it("refuses to make a new secret key when people have set up two-step sign-in", async () => {
    const { database, userId } = await setUpDatabase();
    try {
      const owner = openDatabase(database.url, { max: 1 });
      try {
        await giveTestFactor(owner, testKeyring(), userId, 1, 10);
      } finally {
        await owner.close();
      }
      const run = start({ env: { OCULUS_DATABASE_URL: database.url } });
      expect(await run.done).toBe(1);
      expect(run.lines.join("\n")).toContain("backup");
      expect(existsSync(join(folder, "secret-key"))).toBe(false);
      expect(run.lines.some((l) => l.startsWith("Oculus is running"))).toBe(false);

      // The wrong key is refused too; the key the set-ups were sealed with starts.
      const wrong = start({
        env: { OCULUS_DATABASE_URL: database.url, OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY_2 },
      });
      expect(await wrong.done).toBe(1);
      expect(wrong.lines.join("\n")).toContain("isn't the one");
      const right = start({
        env: { OCULUS_DATABASE_URL: database.url, OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY },
      });
      await running(right);
      right.stop();
      expect(await right.done).toBe(0);

      // Once that set-up is revoked, nothing usable is sealed: a new key is fine.
      const owner2 = openDatabase(database.url, { max: 1 });
      try {
        // As the owner, past the guard (as giveTestFactor does), within one transaction.
        await owner2.transaction(async (q) => {
          await q.execute(
            sql`ALTER TABLE public.second_factors DISABLE TRIGGER second_factors_check_change`,
          );
          await q.execute(
            sql`UPDATE public.second_factors SET state = 'revoked', revoked_at = now()`,
          );
          await q.execute(
            sql`ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_check_change`,
          );
        });
      } finally {
        await owner2.close();
      }
      const fresh = start({ env: { OCULUS_DATABASE_URL: database.url } });
      await running(fresh);
      fresh.stop();
      expect(await fresh.done).toBe(0);
    } finally {
      await database.drop();
    }
  });

  it("applies migrations the database doesn't have yet", async () => {
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
    const older = join(folder, "older-migrations");
    mkdirSync(older);
    const files = readdirSync(all).sort();
    for (const file of files.slice(0, -1)) cpSync(join(all, file), join(older, file));
    const { database } = await setUpDatabase(older);
    try {
      const run = start({ env: { OCULUS_DATABASE_URL: database.url } });
      await running(run);
      expect(run.lines.join("\n")).toContain("Updated the database (1 change(s)).");
      run.stop();
      expect(await run.done).toBe(0);
      const db = openDatabase(database.url, { max: 1 });
      const rows = await db.rows<{ name: string }>(
        sql`SELECT name FROM public.oculus_migrations ORDER BY name DESC LIMIT 1`,
      );
      await db.close();
      expect(rows[0]?.name).toBe(files.at(-1));
    } finally {
      await database.drop();
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

  it("refuses an owner address that reaches a different database from the app's", async () => {
    const run = start({ env: { OCULUS_DATABASE_OWNER_URL: empty.url } });
    expect(await run.done).toBe(1);
    expect(run.lines.join("\n")).toContain("different databases");
  });

  it("answers 3 (finish the setup questions) only for desktop.json's own owner address", async () => {
    const run = start({
      env: { OCULUS_DATABASE_URL: empty.url, OCULUS_DATABASE_OWNER_URL: empty.url },
    });
    expect(await run.done).toBe(1);
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
