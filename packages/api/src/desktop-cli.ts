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
 *    server: one person, one address, and, without the OCULUS_SMTP_…
 *    settings (D-085), password-reset and invitation messages only noted
 *    in the log;
 * 4. opens it in an Edge or Chrome app window with Oculus's own profile, and
 *    stops the server when that window closes (or on Ctrl+C).
 *
 * One launcher runs at a time (desktop.ts's lock, checked against the
 * running server's `/desktop/instance` answer): starting it again opens
 * another window on the running server. Whatever fails after the server
 * listens, the window, the server, the pool and the lock are closed.
 * Nothing printed shows the database URL's password or the secret key.
 *
 * Exit codes: 0 stopped normally, 1 refused or failed, 2 usage, 3 the
 * database `npm run desktop:database` made still needs its setup questions,
 * 4 another start is still starting or busy (nothing done; a message to read).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  backup,
  checkWriterConnection,
  defaultMigrationsDir,
  pendingMigrations,
  readMigrations,
  type AppliedMigration,
  databaseBeforeSetup,
  grantWriterRole,
  identityGrantHint,
  migrate,
  MigrationError,
  openDatabase,
  loadSecretKeyring,
  SECRET_KEY_VARIABLE,
  sql,
  type Database,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { ADMIN_ORIGIN_ENV } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import { staffPoolOptions } from "./staff-pool.js";
import {
  appWindowArgs,
  chooseDatabaseUrl,
  choosePort,
  DEFAULT_DESKTOP_PORT,
  DesktopError,
  databaseLabel,
  ensureSettingsFolder,
  findAppBrowser,
  INSTANCE_PATH,
  instanceProof,
  loadOrCreateSecretKey,
  readDesktopSettings,
  settingsFolder,
  takeLock,
  urlHasPassword,
  windowProfileFolder,
  windowsSettingsWarning,
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
    let asked = 0;
    // SIGHUP: the console window was closed; SIGBREAK: Ctrl+Break on Windows.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      process.on(signal, () => {
        asked++;
        if (asked > 1) process.exit(130); // A second Ctrl+C: stop now.
        // If shutting down hangs (a query held up by another program), give up after 20 s.
        setTimeout(() => process.exit(1), 20_000).unref();
        resolve();
      });
    }
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
  const found: string[] = [];
  try {
    const parsed = new URL(url);
    for (const p of [parsed.password, parsed.searchParams.get("password") ?? ""]) {
      if (p === "") continue;
      found.push(p);
      try {
        found.push(decodeURIComponent(p));
      } catch {
        // A malformed escape: the raw form is enough.
      }
    }
  } catch {
    // Not a URL: openDatabase refuses it before anything prints it.
  }
  return found;
}

/**
 * The fingerprints of the keys the database's live two-step set-ups are
 * sealed with (D-077). Revoked ones never open again and are never resealed,
 * so they don't count.
 */
async function sealingKeyIds(db: Database): Promise<string[]> {
  const [table] = await db.rows<{ present: boolean }>(
    sql`SELECT to_regclass('public.second_factors') IS NOT NULL AS present`,
  );
  if (table?.present !== true) return [];
  const rows = await db.rows<{ id: string }>(sql`
    SELECT DISTINCT encode(substring(secret_box FROM 2 FOR 8), 'hex') AS id
    FROM public.second_factors
    WHERE state <> 'revoked'`);
  return rows.map((r) => r.id);
}

/**
 * If the code has migrations the database hasn't (an update), backs the
 * database up first into the settings folder's `backups` (S-034b, D-102),
 * so an update can be undone with `db:restore`. Returns false, having said
 * why, if the backup couldn't be made: nothing is migrated then.
 */
async function backupBeforeUpdate(
  db: Database,
  connectionString: string,
  folder: string,
  env: Env,
  out: Line,
  err: Line,
): Promise<boolean> {
  let applied: AppliedMigration[];
  try {
    applied = await db.rows<AppliedMigration>(
      sql`SELECT name, sha256 FROM public.oculus_migrations ORDER BY name`,
    );
  } catch {
    // Fail closed: without the list, an update might run with no backup.
    err("Couldn't read the database's list of changes, so nothing was changed. Try again.");
    return false;
  }
  let pending: number;
  try {
    pending = pendingMigrations(await readMigrations(defaultMigrationsDir()), applied).length;
  } catch {
    // migrate() refuses the same way, before changing anything, and says why.
    return true;
  }
  if (pending === 0) return true;
  const dir = join(folder, "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `before-update-${stamp}.oculus-backup`);
  out(`This update changes Oculus's database (${String(pending)} change(s)). Backing it up first…`);
  // Ctrl+C or closing the console stops the backup cleanly (no partial file,
  // no private folder left behind); nothing is migrated then.
  const stop = new AbortController();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
  const onSignal = (): void => {
    stop.abort();
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await backup({
      connectionString,
      file,
      env: { ...env },
      signal: stop.signal,
      log: (line) => {
        if (/warn|could not|couldn't/i.test(line)) out(line);
      },
    });
  } catch (error) {
    const reason = error instanceof Error && error.message !== "" ? `: ${error.message}` : ".";
    err(
      `Couldn't back up the database before updating it${reason} Nothing was changed. To update without a backup, add "backupBeforeUpdate": false to desktop.json (or, if the PostgreSQL tools are somewhere unusual, set PG_BIN to their folder).`,
    );
    return false;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
  out(`Backup saved: ${file}`);
  return true;
}

/** Whether two connections reach the same database on the same running server. */
async function sameDatabase(a: Database, b: Database): Promise<boolean> {
  const where = sql`SELECT current_database() AS d, pg_postmaster_start_time()::text AS t,
                           current_setting('port') AS p`;
  const [x] = await a.rows<{ d: string; t: string; p: string }>(where);
  const [y] = await b.rows<{ d: string; t: string; p: string }>(where);
  return x !== undefined && x.d === y?.d && x.t === y.t && x.p === y.p;
}

/** The writer connection's role name. */
async function writerRoleName(db: Database): Promise<string> {
  const [row] = await db.rows<{ name: string }>(sql`SELECT current_user AS name`);
  if (row === undefined) throw new Error("no role");
  return row.name;
}

/** The fingerprints of the key in use and any previous keys still accepted. */
function knownKeyIds(key: string, env: Env): Set<string> {
  const ids = new Set([loadSecretKeyring({ [SECRET_KEY_VARIABLE]: key }).currentKeyId]);
  for (const previous of (env.OCULUS_SECRET_KEY_PREVIOUS ?? "").split(",")) {
    const text = previous.trim();
    if (text === "") continue;
    try {
      ids.add(loadSecretKeyring({ [SECRET_KEY_VARIABLE]: text }).currentKeyId);
    } catch {
      // The server itself refuses a bad previous key at start.
    }
  }
  return ids;
}

/** Runs the launcher; resolves with the exit code once Oculus has stopped. */
export async function runDesktop(options: DesktopOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  const env = options.env;
  const openWindow = options.openWindow ?? defaultOpenWindow;
  const openDefault = options.openDefault ?? defaultOpenDefault;
  const findBrowser = options.findBrowser ?? (() => findAppBrowser(platform, env));
  const secrets: string[] = [];
  const out: Line = (line) => {
    options.out(scrub(line, secrets));
  };
  const err: Line = (line) => {
    options.err(scrub(line, secrets));
  };

  let folder: string;
  let url: string;
  let ownerUrl: string | undefined;
  let ownerFromSettings: boolean;
  let backupFirst: boolean;
  let wantedPort: number;
  try {
    folder = settingsFolder(platform, env, options.home ?? homedir());
    const warning = windowsSettingsWarning(platform, env);
    if (warning !== undefined) err(warning);
    ensureSettingsFolder(folder);
    const settings = readDesktopSettings(folder);
    url = chooseDatabaseUrl(env, settings, folder);
    // The owner's address goes with the settings' writer address only: an
    // OCULUS_DATABASE_URL given by hand is used for everything, as before.
    const fromEnvUrl = env.OCULUS_DATABASE_URL;
    ownerUrl =
      env.OCULUS_DATABASE_OWNER_URL !== undefined && env.OCULUS_DATABASE_OWNER_URL !== ""
        ? env.OCULUS_DATABASE_OWNER_URL
        : fromEnvUrl !== undefined && fromEnvUrl.trim() !== ""
          ? undefined
          : settings.ownerDatabaseUrl;
    ownerFromSettings = ownerUrl !== undefined && ownerUrl === settings.ownerDatabaseUrl;
    secrets.push(...passwordOf(url), ...(ownerUrl === undefined ? [] : passwordOf(ownerUrl)));
    wantedPort = settings.port ?? DEFAULT_DESKTOP_PORT;
    backupFirst = settings.backupBeforeUpdate !== false;
    const fromEnv = env.OCULUS_PORT;
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
  const profile = windowProfileFolder(platform, env, folder);
  const database = databaseLabel(url);

  // One launcher at a time, before anything slow.
  let lock: Awaited<ReturnType<typeof takeLock>>;
  try {
    lock = await takeLock(folder, database);
  } catch {
    err(`Can't write the lock file in ${folder}. Check that you can change that folder.`);
    return 1;
  }
  if (lock.kind === "starting") {
    out("Oculus is already starting. Its window opens when it's ready.");
    return 4;
  }
  if (lock.kind === "busy") {
    out(
      "Oculus is already running but busy right now. Try again in a minute, or use its open window.",
    );
    return 4;
  }
  if (lock.kind === "running") {
    if (lock.lock.database !== database) {
      err(
        `Oculus is already running with another database (${lock.lock.database}). Close its window first.`,
      );
      return 1;
    }
    out(`Oculus is already running at ${lock.lock.url}. Opening another window on it.`);
    const browser = findBrowser();
    const address = lock.lock.url;
    if (browser === undefined) openDefault(address);
    else {
      try {
        openWindow(browser, appWindowArgs(address, profile)).once("error", () => {
          openDefault(address);
        });
      } catch {
        openDefault(address);
      }
    }
    return 0;
  }
  const { setUrl, release } = lock;
  const token = lock.lock.token;

  let db: Database | undefined;
  let ownerDb: Database | undefined;
  let app: FastifyInstance | undefined;
  let window: WindowProcess | undefined;
  try {
    out(`Using the database ${database}.`);
    if (urlHasPassword(url)) {
      out("Note: the database address holds a password. Your pgpass file is a safer place for it.");
    }
    try {
      db = openDatabase(url, staffPoolOptions("oculus-desktop"));
      if (ownerUrl !== undefined) {
        ownerDb = openDatabase(ownerUrl, { applicationName: "oculus-desktop-owner", max: 1 });
      }
    } catch {
      err("The database address is not a usable postgresql:// URL (its value is not shown).");
      return 2;
    }
    // The owner (when there is one) checks and migrates; the server connects as the writer.
    const checker = ownerDb ?? db;
    let state: "empty" | "set_up" | "other";
    let sealedWith: string[] = [];
    try {
      if (ownerDb !== undefined && !(await sameDatabase(ownerDb, db))) {
        err(
          "The owner's and the app's database addresses in desktop.json point at different databases. Fix desktop.json.",
        );
        return 1;
      }
      state = await databaseBeforeSetup(checker);
      if (state === "set_up") sealedWith = await sealingKeyIds(checker);
    } catch {
      err(
        "Can't reach the database. Check that PostgreSQL is running and that the address and pgpass password are right.",
      );
      return 1;
    }
    if (state === "empty") {
      if (ownerFromSettings) {
        // Made by `npm run desktop:database`, but its setup questions weren't finished.
        err(
          "Oculus's database is made, but the first-time setup wasn't finished. Run `npm run desktop:database` again to finish it (on Windows, start-oculus.cmd does this by itself).",
        );
        return 3;
      }
      err(
        "This database hasn't been set up yet. Run `npm run setup` once (on Windows, `node packages\\db\\dist\\setup-cli.js`), with OCULUS_DATABASE_URL set to the same database, then start Oculus again.",
      );
      return 1;
    }
    if (state === "other") {
      err("This database isn't an Oculus database. Point Oculus at its own database.");
      return 1;
    }
    let key: string;
    try {
      const secretKey = loadOrCreateSecretKey(folder, env, platform, sealedWith.length === 0);
      key = secretKey.key;
      secrets.push(key);
      const known = knownKeyIds(key, env);
      if (sealedWith.some((id) => !known.has(id))) {
        err(
          `The secret key in use (${env[SECRET_KEY_VARIABLE] ? "OCULUS_SECRET_KEY" : join(folder, "secret-key")}) isn't the one people's two-step sign-in was set up with. Put the right key back from your backup; starting with this one would lock them out.`,
        );
        return 1;
      }
      if (secretKey.created) {
        out(
          `Made Oculus's secret key in ${join(folder, "secret-key")}. Back it up along with your database backups: without it, everyone has to set up two-step sign-in again.`,
        );
      }
    } catch (error) {
      if (error instanceof DesktopError) {
        err(error.message);
        return 1;
      }
      throw error;
    }
    if (backupFirst) {
      const made = await backupBeforeUpdate(checker, ownerUrl ?? url, folder, env, out, err);
      if (!made) return 1;
    }
    try {
      const result = await migrate({ connectionString: ownerUrl ?? url, log: out });
      if (result.applied.length > 0) {
        out(`Updated the database (${String(result.applied.length)} change(s)).`);
      }
      if (ownerDb !== undefined) {
        const owner = ownerDb;
        const server = db;
        // Checked before granting, so a role that isn't a plain writer (a
        // hand-edited desktop.json naming another account) is never given
        // the writer's grants; then granted (new tables from new migrations
        // need them, D-067) and checked again.
        const refuse = (problems: readonly { code: string }[]): number => {
          err(
            `The app's database account isn't the plain writer Oculus needs (${problems.map((p) => p.code).join(", ")}). It must be the role made for Oculus (D-067).`,
          );
          return 1;
        };
        // Before granting, only extra power counts: a privilege a new
        // migration's table still lacks is exactly what the grant adds.
        const before = (await checkWriterConnection(server)).filter(
          (p) => p.code !== "missing_privilege",
        );
        if (before.length > 0) return refuse(before);
        const writer = await writerRoleName(server);
        const granted = await owner.transaction((tx) => grantWriterRole(tx, writer));
        // Not a failure (S-052): the purge of removed files waits for it.
        if (!granted.identityReadable) out(identityGrantHint(writer));
        const after = await checkWriterConnection(server);
        if (after.length > 0) return refuse(after);
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
    // Uploaded files (M-002, D-086): OCULUS_FILES_DIR if set, else a folder
    // of their own in the settings folder, readable by the person only.
    const filesDir = env.OCULUS_FILES_DIR ?? join(folder, "files");
    if (env.OCULUS_FILES_DIR === undefined) mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    const serverEnv: Record<string, string | undefined> = {
      ...env,
      OCULUS_FILES_DIR: filesDir,
      NODE_ENV: "development",
      [ORIGINS_ENV]: origin,
      [ADMIN_ORIGIN_ENV]: origin,
      [SECRET_KEY_VARIABLE]: key,
      OCULUS_TRUSTED_PROXY: undefined,
      OCULUS_CLIENT_ADDRESS: undefined,
    };
    const ownHost = `127.0.0.1:${String(port)}`;
    app = await buildAdminServer({
      db,
      env: serverEnv,
      extraRoutes: [
        {
          method: "GET",
          path: INSTANCE_PATH,
          handler: (request, reply) => {
            const challenge = request.query.challenge;
            if (
              request.host !== ownHost ||
              typeof challenge !== "string" ||
              !/^[0-9a-f]{32}$/.test(challenge)
            ) {
              reply.status(404);
              return { error: "not_found" };
            }
            return { proof: instanceProof(token, challenge) };
          },
        },
      ],
      ...(options.adminDir === undefined ? {} : { adminDir: options.adminDir }),
    });
    await app.listen({ host: "127.0.0.1", port });
    const address = `${origin}/`;
    if (!setUrl(address)) {
      err("Another start of Oculus took over while this one was starting. Use its window.");
      return 1;
    }
    out(`Oculus is running at ${address}`);

    const stop = options.stopRequested?.() ?? defaultStopRequested();
    const browser = findBrowser();
    let windowClosed: Promise<"closed" | "handed_off" | "failed"> | undefined;
    if (browser !== undefined) {
      const started = Date.now();
      const handOffMs = options.handOffMs ?? 3000;
      try {
        const opened = openWindow(browser, appWindowArgs(address, profile));
        window = opened;
        windowClosed = new Promise((resolve) => {
          opened.once("exit", () => {
            resolve(Date.now() - started < handOffMs ? "handed_off" : "closed");
          });
          opened.once("error", () => {
            resolve("failed");
          });
        });
      } catch {
        windowClosed = Promise.resolve("failed");
      }
      out(
        platform === "darwin"
          ? "Quit the Oculus window (Cmd+Q) to stop it."
          : "Close the Oculus window to stop it.",
      );
    }
    let outcome: "closed" | "handed_off" | "failed" | "stop" | "no_window" = "no_window";
    if (windowClosed === undefined) openDefault(address);
    else outcome = await Promise.race([windowClosed, stop.then(() => "stop" as const)]);
    if (outcome === "failed") {
      out("Couldn't open the app window; opening your browser instead.");
      window = undefined;
      openDefault(address);
    } else if (outcome === "handed_off") {
      out("The window opened in a browser that was already running.");
    }
    if (outcome !== "closed" && outcome !== "stop") {
      out(`Open ${address} in your browser. Press Ctrl+C here to stop Oculus.`);
      await stop;
      outcome = "stop";
    }
    if (outcome === "closed") window = undefined;
    out("Stopping Oculus…");
    return 0;
  } catch (error) {
    err(`Oculus did not start: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  } finally {
    // Whatever happened, nothing is left running: the window, the server,
    // the pool and the lock.
    try {
      window?.kill();
    } catch {
      // Already gone.
    }
    try {
      await app?.close();
    } catch {
      // Closing is best effort; the process ends next.
    }
    try {
      await db?.close();
      await ownerDb?.close();
    } catch {
      // As above.
    }
    release();
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
