/**
 * `npm run desktop:database` (T-057, D-093; on Windows
 * `node packages\api\dist\desktop-database-cli.js`, which
 * `scripts/start-oculus.cmd` runs by itself the first time): sets up
 * Oculus's database on a PostgreSQL the person installed, then runs the
 * first-time setup (T-055), so that afterwards `npm run desktop` just works.
 *
 * 1. Asks for the `postgres` account's password (never shown, kept only in
 *    memory) and connects to `OCULUS_DESKTOP_ADMIN_URL` (default
 *    `postgresql://postgres@localhost:5432/postgres`).
 * 2. Refuses if `desktop.json` already names a database, if the server is
 *    older than PostgreSQL 15, or if the database or either role exists.
 * 3. Makes the owner and writer roles (desktop-database.ts) and the database
 *    owned by the owner, applies the migrations as the owner, and gives the
 *    writer `grantWriterRole`.
 * 4. Saves both roles' passwords in the pgpass file and writes
 *    `desktop.json` with both addresses (no passwords).
 * 5. Runs the first-time setup questions (organization, site, your name,
 *    email and password).
 *
 * If anything fails after the roles or database are made, it drops what it
 * made (nothing else) so it can simply be run again.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createDatabase,
  dropDatabase,
  grantWriterRole,
  migrate,
  openDatabase,
  runSetupCli,
  sql,
  terminalAsk,
  type Ask,
  type Database,
} from "@oculus/db";
import {
  ensureSettingsFolder,
  readDesktopSettings,
  settingsFolder,
  writeDesktopSettings,
  DesktopError,
  type Env,
} from "./desktop.js";
import {
  addPgpassEntries,
  addressFor,
  DESKTOP_DATABASE,
  DESKTOP_OWNER_ROLE,
  DESKTOP_WRITER_ROLE,
  newRolePassword,
  pgpassPath,
  pgpassTarget,
  scramVerifier,
  withPassword,
} from "./desktop-database.js";

type Line = (line: string) => void;

export const ADMIN_URL_VARIABLE = "OCULUS_DESKTOP_ADMIN_URL";
const DEFAULT_ADMIN_URL = "postgresql://postgres@localhost:5432/postgres";

export interface DesktopDatabaseOptions {
  env: Env;
  ask: Ask;
  out: Line;
  err: Line;
  platform?: NodeJS.Platform;
  home?: string;
  /** Names (tests run several on one server). */
  names?: { database: string; owner: string; writer: string };
  /** Called once the last question is answered. */
  finished?: () => void;
}

function scrub(line: string, secrets: readonly string[]): string {
  let result = line;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      result = result.split(secret).join("[hidden]");
      result = result.split(encodeURIComponent(secret)).join("[hidden]");
    }
  }
  return result;
}

/**
 * Runs one of this file's own statements with up to two `%I`/`%L` values,
 * quoted by the server's format(): names can't be query parameters, so the
 * values travel as transaction settings.
 */
async function formatted(
  db: Database,
  statement: string,
  values: readonly string[],
): Promise<void> {
  if (values.length < 1 || values.length > 2) throw new TypeError("one or two values");
  await db.transaction(async (tx) => {
    await tx.rows(sql`SELECT set_config('oculus.desktop_statement', ${statement}, true),
                             set_config('oculus.desktop_v0', ${values[0] ?? ""}, true),
                             set_config('oculus.desktop_v1', ${values[1] ?? ""}, true)`);
    await tx.execute(
      values.length === 1
        ? sql`DO $$ BEGIN
            EXECUTE format(current_setting('oculus.desktop_statement'),
                           current_setting('oculus.desktop_v0'));
          END $$`
        : sql`DO $$ BEGIN
            EXECUTE format(current_setting('oculus.desktop_statement'),
                           current_setting('oculus.desktop_v0'),
                           current_setting('oculus.desktop_v1'));
          END $$`,
    );
  });
}

/** Runs the helper; returns the exit code. */
export async function runDesktopDatabase(options: DesktopDatabaseOptions): Promise<number> {
  const { env, ask } = options;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const names = options.names ?? {
    database: DESKTOP_DATABASE,
    owner: DESKTOP_OWNER_ROLE,
    writer: DESKTOP_WRITER_ROLE,
  };
  const secrets: string[] = [];
  const out: Line = (line) => {
    options.out(scrub(line, secrets));
  };
  const err: Line = (line) => {
    options.err(scrub(line, secrets));
  };

  let folder: string;
  try {
    folder = settingsFolder(platform, env, home);
    ensureSettingsFolder(folder);
    const settings = readDesktopSettings(folder);
    if (settings.databaseUrl !== undefined || settings.ownerDatabaseUrl !== undefined) {
      err(`Oculus's database is already set up (${folder}). Nothing was changed.`);
      return 1;
    }
  } catch (error) {
    if (error instanceof DesktopError) {
      err(error.message);
      return 1;
    }
    throw error;
  }

  const adminBase = env[ADMIN_URL_VARIABLE] ?? DEFAULT_ADMIN_URL;
  let adminUser: string;
  try {
    const parsed = new URL(adminBase);
    if (!/^postgres(ql)?:$/.test(parsed.protocol) || parsed.password !== "") throw new Error();
    adminUser = decodeURIComponent(parsed.username) || "postgres";
  } catch {
    err(`${ADMIN_URL_VARIABLE} must be a postgresql:// address with no password in it.`);
    return 2;
  }
  out("This sets up Oculus's database on your PostgreSQL. It asks for the password you chose");
  out(
    `for the "${adminUser}" account when you installed PostgreSQL. It's used once and not saved.`,
  );
  const adminPassword = await ask(`Password for "${adminUser}": `, { secret: true });
  if (adminPassword === undefined) {
    err("No password was given. Nothing was changed.");
    return 1;
  }
  if (adminPassword !== "") secrets.push(adminPassword);
  const adminUrl = adminPassword === "" ? adminBase : withPassword(adminBase, adminPassword);

  let admin: Database;
  try {
    admin = openDatabase(adminUrl, { applicationName: "oculus-desktop-database", max: 1 });
  } catch {
    err(`${ADMIN_URL_VARIABLE} is not a usable postgresql:// address.`);
    return 2;
  }
  const ownerPassword = newRolePassword();
  const writerPassword = newRolePassword();
  secrets.push(ownerPassword, writerPassword);
  const ownerAddress = addressFor(adminBase, names.owner, names.database);
  const writerAddress = addressFor(adminBase, names.writer, names.database);
  let made = false;
  try {
    let version: number;
    try {
      const [row] = await admin.rows<{ v: string }>(
        sql`SELECT current_setting('server_version_num') AS v`,
      );
      version = Number(row?.v ?? 0);
    } catch {
      err(
        `Couldn't sign in to PostgreSQL as "${adminUser}". Check the password, and that PostgreSQL is running. Nothing was changed.`,
      );
      return 1;
    }
    if (version < 150_000) {
      err("Oculus needs PostgreSQL 15 or newer. Nothing was changed.");
      return 1;
    }
    const existing = await admin.rows<{ what: string }>(sql`
      SELECT 'database ' || datname AS what FROM pg_database WHERE datname = ${names.database}
      UNION ALL
      SELECT 'role ' || rolname FROM pg_roles WHERE rolname IN (${names.owner}, ${names.writer})`);
    if (existing.length > 0) {
      err(
        `PostgreSQL already has ${existing.map((r) => r.what).join(" and ")}. Nothing was changed. If it's from an earlier try, remove it in pgAdmin (or ask for help) and run this again.`,
      );
      return 1;
    }

    made = true;
    out("Making Oculus's database…");
    await formatted(admin, "CREATE ROLE %I LOGIN PASSWORD %L", [
      names.owner,
      scramVerifier(ownerPassword),
    ]);
    await formatted(admin, "CREATE ROLE %I LOGIN PASSWORD %L", [
      names.writer,
      scramVerifier(writerPassword),
    ]);
    // CREATE DATABASE can't run in a transaction block: createDatabase
    // checks the name; then it's handed to the owner.
    await createDatabase(adminUrl, names.database);
    await formatted(admin, "ALTER DATABASE %I OWNER TO %I", [names.database, names.owner]);

    const ownerUrl = withPassword(ownerAddress, ownerPassword);
    await migrate({ connectionString: ownerUrl, log: () => undefined });
    const owner = openDatabase(ownerUrl, { applicationName: "oculus-desktop-database", max: 1 });
    try {
      await owner.transaction(async (tx) => {
        await grantWriterRole(tx, names.writer);
      });
    } finally {
      await owner.close();
    }

    const file = pgpassPath(platform, env, home);
    const target = pgpassTarget(ownerAddress);
    addPgpassEntries(file, [
      { ...target, database: names.database, user: names.owner, password: ownerPassword },
      { ...target, database: names.database, user: names.writer, password: writerPassword },
    ]);
    writeDesktopSettings(folder, { databaseUrl: writerAddress, ownerDatabaseUrl: ownerAddress });
    out(`Done. The new accounts' passwords are in ${file}; Oculus's settings are in ${folder}.`);
    made = false; // Kept from here on, whatever setup does.
  } catch (error) {
    err(
      `Setting up the database failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    if (made) await undo(admin, adminUrl, names, err);
    return 1;
  } finally {
    await admin.close();
  }

  out("");
  out("Now the first-time setup: your organization, its first site, and your own account.");
  return runSetupCli(
    { ...env, OCULUS_DATABASE_URL: withPassword(ownerAddress, ownerPassword) },
    ask,
    out,
    err,
    options.finished,
  );
}

/** Drops what this run made, so it can be run again. */
async function undo(
  admin: Database,
  adminUrl: string,
  names: { database: string; owner: string; writer: string },
  err: Line,
): Promise<void> {
  try {
    const [exists] = await admin.rows(
      sql`SELECT 1 FROM pg_database WHERE datname = ${names.database}`,
    );
    if (exists !== undefined) await dropDatabase(adminUrl, names.database);
    await formatted(admin, "DROP ROLE IF EXISTS %I", [names.writer]);
    await formatted(admin, "DROP ROLE IF EXISTS %I", [names.owner]);
    err("What was made has been removed; you can run this again.");
  } catch {
    err(
      `Couldn't remove what was made. In pgAdmin, remove the database "${names.database}" and the roles "${names.owner}" and "${names.writer}" before trying again.`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = terminalAsk();
  try {
    process.exitCode = await runDesktopDatabase({
      env: process.env,
      ask: terminal.ask,
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
      finished: terminal.close,
    });
  } finally {
    terminal.close();
  }
}
