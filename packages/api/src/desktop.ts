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
import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
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
      | "secret_key_missing"
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

/**
 * A warning for Windows, where the secret key's permission check is
 * skipped (S-050): a settings folder given by OCULUS_DESKTOP_HOME outside
 * this person's %APPDATA% may be open to other people on the computer.
 * `undefined` when there is nothing to warn about.
 */
export function windowsSettingsWarning(platform: NodeJS.Platform, env: Env): string | undefined {
  if (platform !== "win32") return undefined;
  const given = env[DESKTOP_HOME_VARIABLE];
  if (given === undefined || given.trim() === "") return undefined;
  const appData = env.APPDATA;
  if (appData !== undefined && appData.trim() !== "") {
    const inside = win32.relative(win32.resolve(appData), win32.resolve(given));
    if (!inside.startsWith("..") && !win32.isAbsolute(inside)) return undefined;
  }
  return `${DESKTOP_HOME_VARIABLE} puts Oculus's settings and secret key in ${given}, outside your own AppData folder. On Windows Oculus can't check who else can open it: make sure only you can, or leave ${DESKTOP_HOME_VARIABLE} unset.`;
}

/** Makes the settings folder if it's missing, readable only by its owner. */
export function ensureSettingsFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
}

export interface DesktopSettings {
  /** The writer's address: the server connects with it (D-067). */
  databaseUrl?: string;
  /** The owner's address: migrations and the start-up checks use it (T-057). */
  ownerDatabaseUrl?: string;
  /** Back up before applying new migrations (default true; S-034b). */
  backupBeforeUpdate?: boolean;
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
    // Notepad may start the file with a byte-order mark.
    value = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
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
    if (key === "databaseUrl" || key === "ownerDatabaseUrl") {
      if (typeof entry !== "string" || !/^postgres(ql)?:\/\//.test(entry)) {
        throw new DesktopError(
          "settings_invalid",
          `"${key}" in ${file} must be a postgresql:// address.`,
        );
      }
      if (urlHasPassword(entry)) {
        throw new DesktopError(
          "password_in_settings",
          `"${key}" in ${file} holds a password. Take it out and put it in your pgpass file instead (on Windows %APPDATA%\\postgresql\\pgpass.conf, elsewhere ~/.pgpass).`,
        );
      }
      settings[key] = entry;
    } else if (key === "backupBeforeUpdate") {
      if (typeof entry !== "boolean") {
        throw new DesktopError(
          "settings_invalid",
          `"backupBeforeUpdate" in ${file} must be true or false.`,
        );
      }
      settings.backupBeforeUpdate = entry;
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

/**
 * Adds settings to `desktop.json` (made 0600 if missing), keeping the ones
 * already there, through a temporary file renamed into place.
 */
export function writeDesktopSettings(folder: string, settings: DesktopSettings): void {
  const file = join(folder, SETTINGS_FILE);
  const merged = { ...readDesktopSettings(folder), ...settings };
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(merged, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
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
      "1. Install PostgreSQL 15 or newer (https://www.postgresql.org/download/).",
      "2. Run `npm run desktop:database` (on Windows, double-click scripts\\start-oculus.cmd, which runs it the first time). It makes Oculus's database and asks the first-time setup questions.",
      `   (Or name an existing database in ${join(folder, SETTINGS_FILE)} as "databaseUrl", with its password in your pgpass file.)`,
      "3. Then `npm run desktop` again.",
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
  /** False when the database already holds two-step set-ups sealed with a key (D-077). */
  mayCreate = true,
): { key: string; created: boolean } {
  const fromEnv = env[SECRET_KEY_VARIABLE];
  if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, created: false };
  const file = join(folder, KEY_FILE);
  let created = false;
  // A crash between making the key file and writing it leaves it empty;
  // with nothing sealed yet, it is simply made again.
  if (mayCreate && existsSync(file) && readFileSync(file, "utf8").trim() === "") {
    rmSync(file, { force: true });
  }
  if (!existsSync(file) && !mayCreate) {
    throw new DesktopError(
      "secret_key_missing",
      `${file} is missing, but people have already set up two-step sign-in with this database's key. Put the key back from your backup (or set OCULUS_SECRET_KEY). A new key would lock everyone out of two-step sign-in.`,
    );
  }
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

/**
 * The app window's profile folder: on Windows under %LOCALAPPDATA% (browser
 * profiles and caches don't belong in the roaming folder), elsewhere in the
 * settings folder.
 */
export function windowProfileFolder(platform: NodeJS.Platform, env: Env, folder: string): string {
  const local = env.LOCALAPPDATA;
  if (
    platform === "win32" &&
    env[DESKTOP_HOME_VARIABLE] === undefined &&
    local !== undefined &&
    local !== ""
  ) {
    return join(local, "Oculus", "window");
  }
  return join(folder, "window");
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
    // Nothing should keep the window's browser running once it's closed,
    // and nothing in it (passwords included) syncs to a browser account.
    "--disable-background-mode",
    "--disable-sync",
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

/**
 * The launcher lock (`desktop.lock`): taken with `O_EXCL` before anything
 * else, so two starts can't both run. It holds the launcher's PID, a random
 * token, the database it serves and, once the server listens, its address.
 * A second start trusts it only if the address answers `/desktop/instance`
 * with the token's hash (so a reused PID or another program on that port
 * isn't mistaken for Oculus), or, before an address is written, if the PID
 * lives and the lock is under ten minutes old (a start still building or
 * migrating). Anything else is a stale lock, removed and taken again.
 */
export interface LockContents {
  pid: number;
  token: string;
  database: string;
  started: number;
  url?: string;
}

const LOCK_FILE = "desktop.lock";
export const STARTING_LOCK_MS = 10 * 60_000;
export const INSTANCE_PATH = "/desktop/instance";

/**
 * The launcher's answer to `/desktop/instance?challenge=<hex>`: an HMAC of a
 * fresh challenge under the lock's token, so the answer proves the token
 * without revealing anything a program could replay later.
 */
export function instanceProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(`oculus-desktop-instance:${challenge}`).digest("hex");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads a lock, or `undefined` if it's missing or not a lock. */
export function readLock(folder: string): LockContents | undefined {
  return readLockFile(join(folder, LOCK_FILE));
}

function readLockFile(path: string): LockContents | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      !/^[A-Za-z0-9_-]{32,}$/.test(value.token) ||
      typeof value.database !== "string" ||
      typeof value.started !== "number" ||
      (value.url !== undefined &&
        (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(value.url)))
    ) {
      return undefined;
    }
    return {
      pid: value.pid,
      token: value.token,
      database: value.database,
      started: value.started,
      ...(value.url === undefined ? {} : { url: value.url }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether the server at the lock's address is the launcher that wrote the
 * lock: `yes`, `no` (nothing listens there, or something that doesn't know
 * the token), or `busy` (no answer in time: a live launcher under load,
 * never taken for a stale one).
 */
export async function instanceAnswers(
  lock: LockContents,
  timeoutMs = 5000,
): Promise<"yes" | "no" | "busy"> {
  if (lock.url === undefined) return "no";
  const challenge = randomBytes(16).toString("hex");
  const target = new URL(INSTANCE_PATH, lock.url);
  target.searchParams.set("challenge", challenge);
  try {
    const reply = await fetch(target, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!reply.ok) return "no";
    const body = (await reply.json()) as { proof?: unknown };
    return body.proof === instanceProof(lock.token, challenge) ? "yes" : "no";
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "TimeoutError" || name === "AbortError" ? "busy" : "no";
  }
}

export type LockOutcome =
  | {
      kind: "taken";
      lock: LockContents;
      setUrl: (url: string) => boolean;
      owned: () => boolean;
      release: () => void;
    }
  | { kind: "running"; lock: LockContents & { url: string } }
  | { kind: "starting" }
  | { kind: "busy" };

/**
 * Creates the lock with its whole contents at once: written to a private
 * temporary file, then hard-linked into place (`link` fails if the lock
 * exists), so no other start ever reads a half-written lock.
 */
function createWhole(file: string, contents: LockContents): boolean {
  const temporary = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(contents));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // No hard links here (FAT, exFAT, some network shares): create it
    // exclusively and write it, accepting a moment when it's half written.
    const fdLock = openExclusive(file);
    if (fdLock === undefined) return false;
    try {
      writeSync(fdLock, JSON.stringify(contents));
    } finally {
      closeSync(fdLock);
    }
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function openExclusive(file: string): number | undefined {
  try {
    return openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

/** Windows may hold a just-written file briefly (antivirus, indexer): retry a rename a few times. */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

/** Replaces our own lock's contents atomically (write, then rename over it). */
function replaceWhole(file: string, contents: LockContents): void {
  const temporary = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(contents));
  } finally {
    closeSync(fd);
  }
  try {
    renameRetrying(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Takes a stale lock out of the way: renames it aside (atomic, so only one
 * start can move it), then checks it is the lock judged stale. If another
 * start's fresh lock was moved instead, it is linked back (or, if yet
 * another start already holds the place, left to that one).
 */
function moveAside(file: string, stale: LockContents | undefined): void {
  const aside = `${file}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const moved = readLockFile(aside);
    // A valid lock that isn't the one judged stale (or any valid lock, when
    // the stale one couldn't be read) goes back.
    if (moved !== undefined && moved.token !== stale?.token) {
      try {
        linkSync(aside, file);
      } catch {
        // Another start holds the place now; the moved lock's owner finds it lost.
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Takes the lock, or says which launcher already has it. */
export async function takeLock(
  folder: string,
  database: string,
  now: () => number = Date.now,
  timeoutMs = 5000,
): Promise<LockOutcome> {
  const file = join(folder, LOCK_FILE);
  const mine: LockContents = {
    pid: process.pid,
    token: randomBytes(32).toString("base64url"),
    database,
    started: now(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createWhole(file, mine)) {
      const owned = (): boolean => readLock(folder)?.token === mine.token;
      return {
        kind: "taken",
        lock: mine,
        owned,
        setUrl: (url) => {
          if (!owned()) return false;
          mine.url = url;
          replaceWhole(file, mine);
          return owned();
        },
        release: () => {
          try {
            if (owned()) rmSync(file, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    }
    const held = readLock(folder);
    if (held?.url !== undefined) {
      const answer = await instanceAnswers(held, timeoutMs);
      if (answer === "yes") return { kind: "running", lock: { ...held, url: held.url } };
      if (answer === "busy" && held.pid !== process.pid && pidAlive(held.pid)) {
        return { kind: "busy" };
      }
    }
    if (
      held !== undefined &&
      held.url === undefined &&
      pidAlive(held.pid) &&
      now() - held.started < STARTING_LOCK_MS
    ) {
      return { kind: "starting" };
    }
    // Stale: its launcher is gone, or something else answers on its port.
    moveAside(file, held);
  }
  return { kind: "starting" };
}

/**
 * A password-free name for a database address, for messages and the lock:
 * the user, the host (or socket folder), the port and the database, so two
 * different databases never get the same name.
 */
export function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(default)";
    const user = decodeURIComponent(parsed.username) || "(default user)";
    const socket = parsed.searchParams.get("host");
    const host = socket ?? (parsed.hostname === "" ? "localhost" : parsed.hostname);
    const port = parsed.searchParams.get("port") ?? parsed.port;
    return `${name} as ${user} on ${host}${port === "" ? "" : `:${port}`}`;
  } catch {
    return "(unreadable address)";
  }
}
