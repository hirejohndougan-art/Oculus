/**
 * `npm run desktop` (T-056, D-088): Oculus on one computer, in its own
 * window. After `npm run build` and `npm run setup`, it
 *
 * 1. finds the settings folder and the database (desktop.ts), and refuses a
 *    database that isn't set up yet (pointing to `npm run setup`) or isn't
 *    Oculus's;
 * 2. applies any new migrations, so updating Oculus is `git pull`,
 *    `npm run build`, then start it again;
 * 3. starts the admin's server on 127.0.0.1 only, at port 4780 (or the
 *    settings' `port`, or a free one if that's taken), as a development
 *    server: one person, one address, and password-reset and invitation
 *    messages only noted in the log until email is set up (T-040);
 * 4. opens it in an Edge or Chrome app window with Oculus's own profile, and
 *    stops the server when that window closes (or on Ctrl+C).
 *
 * Starting it again while it runs opens another window on the running
 * server instead of a second server. Nothing printed shows the database
 * URL's password or the secret key.
 *
 * Exit codes: 0 stopped normally, 1 refused or failed, 2 usage.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  databaseBeforeSetup,
  migrate,
  MigrationError,
  openDatabase,
  SECRET_KEY_VARIABLE,
  type Database,
} from "@oculus/db";
import { ADMIN_ORIGIN_ENV } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import {
  appWindowArgs,
  chooseDatabaseUrl,
  choosePort,
  DEFAULT_DESKTOP_PORT,
  DesktopError,
  ensureSettingsFolder,
  findAppBrowser,
  loadOrCreateSecretKey,
  readDesktopSettings,
  runningLauncher,
  settingsFolder,
  takeLock,
  urlHasPassword,
  type Env,
} from "./desktop.js";
import { ORIGINS_ENV } from "./origin.js";

type Line = (line: string) => void;

/** The window's process, as much of it as the launcher uses. */
export interface WindowProcess {
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export interface DesktopOptions {
  env: Env;
  platform?: NodeJS.Platform;
  home?: string;
  out: Line;
  err: Line;
  /** Starts the app window (default: the browser, detached from the console's input). */
  openWindow?: (command: string, args: readonly string[]) => WindowProcess;
  /** Opens a URL in the default browser when no app-window browser is found. */
  openDefault?: (url: string) => void;
  /** Resolves when the person asks to stop (default: SIGINT or SIGTERM). */
  stopRequested?: () => Promise<void>;
  /** Finds the app-window browser (default: `findAppBrowser`). */
  findBrowser?: () => string | undefined;
  /** The built admin's folder (tests). */
  adminDir?: string;
  /** A window that exits sooner than this (ms) was handed to another browser (default 3000). */
  handOffMs?: number;
}

function defaultOpenWindow(command: string, args: readonly string[]): WindowProcess {
  return nodeSpawn(command, args, { stdio: "ignore", windowsHide: false });
}

/** Opens `url` (always our own `http://127.0.0.1:<port>/`) in the default browser. */
function defaultOpenDefault(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["explorer.exe", [url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = nodeSpawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

function defaultStopRequested(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => {
      resolve();
    });
    process.once("SIGTERM", () => {
      resolve();
    });
  });
}

/** Removes every secret from a line before it is shown. */
function scrub(line: string, secrets: readonly string[]): string {
  let result = line;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[hidden]");
  }
  return result;
}

function passwordOf(url: string): string[] {
  try {
    const parsed = new URL(url);
    const found = [parsed.password, parsed.searchParams.get("password") ?? ""];
    return found.flatMap((p) => (p === "" ? [] : [p, decodeURIComponent(p)]));
  } catch {
    return [];
  }
}

/** Runs the launcher; resolves with the exit code once Oculus has stopped. */
export async function runDesktop(options: DesktopOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  const env = options.env;
  const openWindow = options.openWindow ?? defaultOpenWindow;
  const openDefault = options.openDefault ?? defaultOpenDefault;
  let secrets: string[] = [];
  const out: Line = (line) => {
    options.out(scrub(line, secrets));
  };
  const err: Line = (line) => {
    options.err(scrub(line, secrets));
  };

  let folder: string;
  let url: string;
  let key: string;
  let wantedPort: number;
  try {
    folder = settingsFolder(platform, env, options.home ?? homedir());
    ensureSettingsFolder(folder);
    const already = runningLauncher(folder);
    if (already !== undefined) {
      out(`Oculus is already running at ${already.url}. Opening another window on it.`);
      const browser = (options.findBrowser ?? (() => findAppBrowser(platform, env)))();
      if (browser === undefined) openDefault(already.url);
      else {
        const window = openWindow(browser, appWindowArgs(already.url, join(folder, "window")));
        window.once("error", () => {
          openDefault(already.url);
        });
      }
      return 0;
    }
    const settings = readDesktopSettings(folder);
    url = chooseDatabaseUrl(env, settings, folder);
    secrets = passwordOf(url);
    const secretKey = loadOrCreateSecretKey(folder, env, platform);
    key = secretKey.key;
    secrets.push(key);
    if (secretKey.created) {
      out(
        `Made Oculus's secret key in ${join(folder, "secret-key")}. Back it up along with your database backups: without it, everyone has to set up two-step sign-in again.`,
      );
    }
    const fromEnv = env.OCULUS_PORT;
    wantedPort = settings.port ?? DEFAULT_DESKTOP_PORT;
    if (fromEnv !== undefined && fromEnv !== "") {
      const port = Number(fromEnv);
      if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        err("OCULUS_PORT must be a whole number from 1024 to 65535.");
        return 2;
      }
      wantedPort = port;
    }
  } catch (error) {
    if (error instanceof DesktopError) {
      err(error.message);
      return error.code === "no_database" ? 2 : 1;
    }
    throw error;
  }
  if (urlHasPassword(url)) {
    out("Note: the database address holds a password. Your pgpass file is a safer place for it.");
  }

  let db: Database;
  try {
    db = openDatabase(url, { applicationName: "oculus-desktop", max: 10 });
  } catch {
    err("The database address is not a usable postgresql:// URL (its value is not shown).");
    return 2;
  }
  let stopping = false;
  try {
    let state: "empty" | "set_up" | "other";
    try {
      state = await databaseBeforeSetup(db);
    } catch {
      err(
        "Can't reach the database. Check that PostgreSQL is running and that the address and pgpass password are right.",
      );
      return 1;
    }
    if (state === "empty") {
      err(
        "This database hasn't been set up yet. Run `npm run setup` once (with OCULUS_DATABASE_URL set to the same database), then start Oculus again.",
      );
      return 1;
    }
    if (state === "other") {
      err("This database isn't an Oculus database. Point Oculus at its own database.");
      return 1;
    }
    try {
      const result = await migrate({ connectionString: url, log: out });
      if (result.applied.length > 0) {
        out(`Updated the database (${String(result.applied.length)} change(s)).`);
      }
    } catch (error) {
      err(
        error instanceof MigrationError
          ? `Couldn't update the database (${error.code}): ${error.message}`
          : "Couldn't update the database.",
      );
      return 1;
    }

    const port = await choosePort(wantedPort);
    const origin = `http://127.0.0.1:${String(port)}`;
    const serverEnv: Record<string, string | undefined> = {
      ...env,
      NODE_ENV: "development",
      [ORIGINS_ENV]: origin,
      [ADMIN_ORIGIN_ENV]: origin,
      [SECRET_KEY_VARIABLE]: key,
      OCULUS_TRUSTED_PROXY: undefined,
      OCULUS_CLIENT_ADDRESS: undefined,
    };
    const app = await buildAdminServer({
      db,
      env: serverEnv,
      ...(options.adminDir === undefined ? {} : { adminDir: options.adminDir }),
    });
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (error) {
      await app.close();
      throw error;
    }
    const address = `${origin}/`;
    const releaseLock = takeLock(folder, address);
    try {
      out(`Oculus is running at ${address}`);
      const stop = options.stopRequested?.() ?? defaultStopRequested();
      const browser = (options.findBrowser ?? (() => findAppBrowser(platform, env)))();
      let windowClosed: Promise<"closed" | "handed_off" | "failed"> | undefined;
      let window: WindowProcess | undefined;
      if (browser !== undefined) {
        const started = Date.now();
        const handOffMs = options.handOffMs ?? 3000;
        window = openWindow(browser, appWindowArgs(address, join(folder, "window")));
        const opened = window;
        windowClosed = new Promise((resolve) => {
          opened.once("exit", () => {
            resolve(Date.now() - started < handOffMs ? "handed_off" : "closed");
          });
          opened.once("error", () => {
            resolve("failed");
          });
        });
        out("Close the Oculus window to stop it.");
      }
      let outcome: "closed" | "handed_off" | "failed" | "stop" | "no_window" = "no_window";
      if (windowClosed === undefined) openDefault(address);
      else outcome = await Promise.race([windowClosed, stop.then(() => "stop" as const)]);
      if (outcome === "failed") {
        out("Couldn't open the app window; opening your browser instead.");
        openDefault(address);
      } else if (outcome === "handed_off") {
        out("The window opened in a browser that was already running.");
      }
      if (outcome !== "closed" && outcome !== "stop") {
        out(`Open ${address} in your browser. Press Ctrl+C here to stop Oculus.`);
        await stop;
        outcome = "stop";
      }
      stopping = true;
      if (outcome === "stop") window?.kill();
      out("Stopping Oculus…");
      await app.close();
      return 0;
    } finally {
      releaseLock();
    }
  } catch (error) {
    if (stopping) throw error;
    err(`Oculus did not start: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runDesktop({
    env: process.env,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
  process.exitCode = code;
}
