/**
 * The desktop launcher's parts (T-056, D-088): where its settings live, the
 * database it uses, the secret key it keeps, the browser it opens the admin
 * in, and the lock that stops two launchers sharing one window profile.
 * `desktop-cli.ts` puts them together as `npm run desktop`.
 *
 * Everything here stays inside D-002: no Electron and no bundled PostgreSQL
 * (both ship LGPL parts). The window is an installed Edge or Chrome in app
 * mode (`--app=`, no tabs or address bar) with its own profile folder, and
 * the database is a PostgreSQL the person installed themselves.
 *
 * - **Settings folder:** `OCULUS_DESKTOP_HOME`, else `%APPDATA%\Oculus` on
 *   Windows, `~/Library/Application Support/Oculus` on macOS, and
 *   `$XDG_CONFIG_HOME/oculus` (or `~/.config/oculus`) elsewhere.
 * - **`desktop.json`** in it: `{ "databaseUrl": "postgresql://…", "port":
 *   4780 }`, both optional. A password in the URL is refused: it goes in the
 *   pgpass file, as everywhere else in Oculus.
 * - **`secret-key`** in it: made once from 32 random bytes, readable only by
 *   the person (mode 0600; on Windows the per-user AppData folder's own
 *   permissions). On POSIX a key file others can read is refused, as ssh
 *   does. Losing it loses every two-step sign-in set-up (D-077), so it must
 *   be backed up with the database backups.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadSecretKeyring, SECRET_KEY_VARIABLE } from "@oculus/db";

export type Env = Readonly<Record<string, string | undefined>>;

/** Why the launcher can't go on; the message is shown as is and never holds a secret. */
export class DesktopError extends Error {
  constructor(
    readonly code:
      | "no_settings_folder"
      | "settings_unreadable"
      | "settings_invalid"
      | "password_in_settings"
      | "no_database"
      | "secret_key_exposed"
      | "secret_key_invalid",
    message: string,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

export const DESKTOP_HOME_VARIABLE = "OCULUS_DESKTOP_HOME";
export const DESKTOP_BROWSER_VARIABLE = "OCULUS_DESKTOP_BROWSER";
export const DEFAULT_DESKTOP_PORT = 4780;
const SETTINGS_FILE = "desktop.json";
const KEY_FILE = "secret-key";

/** The settings folder for this person on this platform. */
export function settingsFolder(platform: NodeJS.Platform, env: Env, home: string): string {
  const given = env[DESKTOP_HOME_VARIABLE];
  if (given !== undefined && given.trim() !== "") return given;
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new DesktopError(
        "no_settings_folder",
        `APPDATA is not set, so there is nowhere to keep Oculus's settings. Set ${DESKTOP_HOME_VARIABLE} to a folder only you can open.`,
      );
    }
    return join(appData, "Oculus");
  }
  if (home === "") {
    throw new DesktopError(
      "no_settings_folder",
      `No home folder, so there is nowhere to keep Oculus's settings. Set ${DESKTOP_HOME_VARIABLE}.`,
    );
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Oculus");
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg?.startsWith("/") === true ? xdg : join(home, ".config"), "oculus");
}

/** Makes the settings folder if it's missing, readable only by its owner. */
export function ensureSettingsFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
}

export interface DesktopSettings {
  databaseUrl?: string;
  port?: number;
}

/** True when a postgresql:// URL carries a password (in the userinfo or `?password=`). */
export function urlHasPassword(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.password !== "" || parsed.searchParams.has("password");
}

/** Reads `desktop.json`; a missing file is no settings. */
export function readDesktopSettings(folder: string): DesktopSettings {
  const file = join(folder, SETTINGS_FILE);
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new DesktopError(
      "settings_unreadable",
      `${file} can't be read as JSON. Fix it or delete it.`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesktopError("settings_invalid", `${file} must hold one JSON object.`);
  }
  const settings: DesktopSettings = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "databaseUrl") {
      if (typeof entry !== "string" || !/^postgres(ql)?:\/\//.test(entry)) {
        throw new DesktopError(
          "settings_invalid",
          `"databaseUrl" in ${file} must be a postgresql:// address.`,
        );
      }
      if (urlHasPassword(entry)) {
        throw new DesktopError(
          "password_in_settings",
          `"databaseUrl" in ${file} holds a password. Take it out and put it in your pgpass file instead (on Windows %APPDATA%\\postgresql\\pgpass.conf, elsewhere ~/.pgpass).`,
        );
      }
      settings.databaseUrl = entry;
    } else if (key === "port") {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1024 || entry > 65_535) {
        throw new DesktopError(
          "settings_invalid",
          `"port" in ${file} must be a whole number from 1024 to 65535.`,
        );
      }
      settings.port = entry;
    } else {
      throw new DesktopError(
        "settings_invalid",
        `${file} has a setting Oculus doesn't know: "${key.slice(0, 40)}".`,
      );
    }
  }
  return settings;
}

/** The database: `OCULUS_DATABASE_URL` first, then `desktop.json`. */
export function chooseDatabaseUrl(env: Env, settings: DesktopSettings, folder: string): string {
  const fromEnv = env.OCULUS_DATABASE_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  if (settings.databaseUrl !== undefined) return settings.databaseUrl;
  throw new DesktopError(
    "no_database",
    [
      "Oculus doesn't know which database to use yet.",
      "1. Install PostgreSQL 15 or newer (https://www.postgresql.org/download/) and make an empty database for Oculus.",
      `2. Put its address in ${join(folder, SETTINGS_FILE)}, for example`,
      '   { "databaseUrl": "postgresql://oculus@localhost:5432/oculus" }',
      "   with the password in your pgpass file, not in that file.",
      "3. Run `npm run setup` once, then `npm run desktop` again.",
    ].join("\n"),
  );
}

/**
 * The secret key: `OCULUS_SECRET_KEY` if set, else the key file, made the
 * first time. Returns the key text; the caller passes it to the server's
 * environment only, never to a log or the window.
 */
export function loadOrCreateSecretKey(
  folder: string,
  env: Env,
  platform: NodeJS.Platform,
): { key: string; created: boolean } {
  const fromEnv = env[SECRET_KEY_VARIABLE];
  if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, created: false };
  const file = join(folder, KEY_FILE);
  let created = false;
  if (!existsSync(file)) {
    const key = randomBytes(32).toString("base64url");
    // "wx": never overwrite a key another launcher has just written.
    let fd: number | undefined;
    try {
      fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${key}\n`);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new DesktopError(
      "secret_key_exposed",
      `${file} can be read by other people on this computer. Run \`chmod 600 "${file}"\` and start Oculus again.`,
    );
  }
  const key = readFileSync(file, "utf8").trim();
  try {
    loadSecretKeyring({ [SECRET_KEY_VARIABLE]: key });
  } catch {
    throw new DesktopError(
      "secret_key_invalid",
      `${file} doesn't hold a usable key. Restore it from your backup; making a new one means everyone sets up two-step sign-in again.`,
    );
  }
  return { key, created };
}

/** Where installed Chromium-family browsers usually are, best first. */
export function browserCandidates(platform: NodeJS.Platform, env: Env): string[] {
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(
      (r): r is string => r !== undefined && r !== "",
    );
    return [
      ...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/** The browser to open the app window with, or `undefined` for none found. */
export function findAppBrowser(
  platform: NodeJS.Platform,
  env: Env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const given = env[DESKTOP_BROWSER_VARIABLE];
  if (given !== undefined && given !== "") return given;
  return browserCandidates(platform, env).find((path) => exists(path));
}

/**
 * The app window's command-line arguments. The profile folder is Oculus's
 * own, so the window is its own browser process (the launcher stops the
 * server when it exits) and shares no cookies or extensions with the
 * person's everyday browsing.
 */
export function appWindowArgs(url: string, profileFolder: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileFolder}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // Nothing should keep the window's browser running once it's closed.
    "--disable-background-mode",
    "--window-size=1280,860",
  ];
}

/** Whether a TCP port on 127.0.0.1 can be listened on now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/** A port the system says is free on 127.0.0.1. */
export function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

/** The wanted port if free, else any free one. */
export async function choosePort(wanted: number): Promise<number> {
  return (await portIsFree(wanted)) ? wanted : anyFreePort();
}

export interface RunningLauncher {
  pid: number;
  url: string;
}

const LOCK_FILE = "desktop.lock";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Another launcher still running for this settings folder, if any. A lock
 * left by a launcher that has stopped (its process is gone) is ignored. The
 * URL is only ever an `http://127.0.0.1:<port>/` address.
 */
export function runningLauncher(folder: string): RunningLauncher | undefined {
  const file = join(folder, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<RunningLauncher>;
    if (
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      value.pid !== process.pid &&
      typeof value.url === "string" &&
      /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(value.url) &&
      alive(value.pid)
    ) {
      return { pid: value.pid, url: value.url };
    }
  } catch {
    // An unreadable lock is a stale one.
  }
  return undefined;
}

/** Writes this launcher's lock (readable only by its owner); returns the function that removes it. */
export function takeLock(folder: string, url: string): () => void {
  const file = join(folder, LOCK_FILE);
  rmSync(file, { force: true });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, url }));
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<RunningLauncher>;
      if (value.pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}
