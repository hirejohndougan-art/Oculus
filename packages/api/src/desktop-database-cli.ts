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
 * 3. Makes the owner, writer and public reader roles (desktop-database.ts)
 *    and the database owned by the owner, applies the migrations as the
 *    owner, and gives the writer `grantWriterRole` and the public reader
 *    `grantPublicReaderRole` (D-080: no table at all; T-071, D-109).
 * 4. Saves the roles' passwords in the pgpass file and writes
 *    `desktop.json` with the three addresses (no passwords).
 * 5. Runs the first-time setup questions (organization, site, your name,
 *    email and password).
 *
 * If anything fails after the roles or database are made, it drops what it
 * made (nothing else) so it can simply be run again.
 *
 * Run again on a database an earlier version made (no public reader in
 * `desktop.json`), it finishes the setup questions if needed and then adds
 * the public reader role only, asking for the `postgres` password again, so
 * the desktop can show the public sites (T-071).
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createDatabase,
  databaseBeforeSetup,
  dropDatabase,
  grantPublicReaderRole,
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
  removePgpassLines,
  DESKTOP_DATABASE,
  DESKTOP_OWNER_ROLE,
  DESKTOP_PUBLIC_ROLE,
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
  names?: { database: string; owner: string; writer: string; reader?: string };
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
  const given = options.names ?? {
    database: DESKTOP_DATABASE,
    owner: DESKTOP_OWNER_ROLE,
    writer: DESKTOP_WRITER_ROLE,
  };
  const names = { ...given, reader: given.reader ?? DESKTOP_PUBLIC_ROLE };
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
    if (settings.ownerDatabaseUrl !== undefined) {
      // Made by an earlier run: finish its setup questions if they weren't.
      const finished = settings.publicDatabaseUrl === undefined ? undefined : options.finished;
      const code = await resume(settings.ownerDatabaseUrl, env, ask, out, err, finished);
      if (code !== 0 || settings.publicDatabaseUrl !== undefined) {
        options.finished?.();
        return code;
      }
      // Made before the public sites came to the desktop (T-071): add their reader.
      const added = await addPublicReader({
        env,
        ask,
        out,
        err,
        secrets,
        folder,
        ownerAddress: settings.ownerDatabaseUrl,
        reader: names.reader,
        pgpassFile: pgpassPath(platform, env, home),
      });
      options.finished?.();
      return added;
    }
    if (settings.databaseUrl !== undefined) {
      err(`${folder} already names a database for Oculus. Nothing was changed.`);
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
  const readerPassword = newRolePassword();
  secrets.push(ownerPassword, writerPassword, readerPassword);
  const ownerAddress = addressFor(adminBase, names.owner, names.database);
  const writerAddress = addressFor(adminBase, names.writer, names.database);
  const readerAddress = addressFor(adminBase, names.reader, names.database);
  let made = false;
  let added: string[] = [];
  const pgpassFile = pgpassPath(platform, env, home);
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
      SELECT 'role ' || rolname FROM pg_roles
      WHERE rolname IN (${names.owner}, ${names.writer}, ${names.reader})`);
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
    await formatted(admin, "CREATE ROLE %I LOGIN PASSWORD %L", [
      names.reader,
      scramVerifier(readerPassword),
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
        // The public sites' reader (D-080): USAGE on the schema and nothing else.
        await grantPublicReaderRole(tx, names.reader);
      });
    } finally {
      await owner.close();
    }

    const target = pgpassTarget(ownerAddress);
    added = addPgpassEntries(pgpassFile, [
      { ...target, database: names.database, user: names.owner, password: ownerPassword },
      { ...target, database: names.database, user: names.writer, password: writerPassword },
      { ...target, database: names.database, user: names.reader, password: readerPassword },
    ]);
    // Last: once desktop.json names the database, a later run resumes instead of starting over.
    writeDesktopSettings(folder, {
      databaseUrl: writerAddress,
      ownerDatabaseUrl: ownerAddress,
      publicDatabaseUrl: readerAddress,
    });
    out(
      `Done. The new accounts' passwords are in ${pgpassFile}; Oculus's settings are in ${folder}.`,
    );
    made = false; // Kept from here on, whatever setup does.
  } catch (error) {
    err(
      `Setting up the database failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    if (made) {
      await undo(admin, adminUrl, names, err);
      try {
        removePgpassLines(pgpassFile, added);
      } catch {
        err(
          `Couldn't take the new lines back out of ${pgpassFile}; they name accounts that no longer exist.`,
        );
      }
    }
    return 1;
  } finally {
    await admin.close();
  }

  return firstSetup(
    withPassword(ownerAddress, ownerPassword),
    env,
    ask,
    out,
    err,
    options.finished,
  );
}

/** The first-time setup questions (T-055), as the owner. */
async function firstSetup(
  ownerUrl: string,
  env: Env,
  ask: Ask,
  out: Line,
  err: Line,
  finished: (() => void) | undefined,
): Promise<number> {
  out("");
  out("Now the first-time setup: your organization, its first site, and your own account.");
  const code = await runSetupCli(
    { ...env, OCULUS_DATABASE_URL: ownerUrl },
    ask,
    out,
    err,
    finished,
  );
  out("");
  out(
    code === 0
      ? "All set. Start Oculus with `npm run desktop` (on Windows, double-click scripts\\start-oculus.cmd)."
      : "The database is kept. Run this again (on Windows, double-click scripts\\start-oculus.cmd) to answer the setup questions.",
  );
  return code;
}

/** An earlier run made the database: finish the setup questions if they weren't answered. */
async function resume(
  ownerAddress: string,
  env: Env,
  ask: Ask,
  out: Line,
  err: Line,
  finished: (() => void) | undefined,
): Promise<number> {
  let owner: Database;
  try {
    owner = openDatabase(ownerAddress, { applicationName: "oculus-desktop-database", max: 1 });
  } catch {
    err('"ownerDatabaseUrl" in desktop.json is not a usable postgresql:// address.');
    return 1;
  }
  let state: "empty" | "set_up" | "other";
  try {
    state = await databaseBeforeSetup(owner);
  } catch {
    err(
      "Can't reach Oculus's database. Check that PostgreSQL is running and that your pgpass file still has the oculus_owner line.",
    );
    return 1;
  } finally {
    await owner.close();
  }
  if (state === "set_up") {
    out("Oculus's database is already set up. Nothing to do.");
    return 0;
  }
  if (state === "other") {
    err("The database desktop.json names isn't an Oculus database. Nothing was changed.");
    return 1;
  }
  out("Oculus's database is made, but the first-time setup wasn't finished.");
  return firstSetup(ownerAddress, env, ask, out, err, finished);
}

/** Drops what this run made, so it can be run again. */
async function undo(
  admin: Database,
  adminUrl: string,
  names: { database: string; owner: string; writer: string; reader: string },
  err: Line,
): Promise<void> {
  try {
    const [exists] = await admin.rows(
      sql`SELECT 1 FROM pg_database WHERE datname = ${names.database}`,
    );
    if (exists !== undefined) await dropDatabase(adminUrl, names.database);
    await formatted(admin, "DROP ROLE IF EXISTS %I", [names.reader]);
    await formatted(admin, "DROP ROLE IF EXISTS %I", [names.writer]);
    await formatted(admin, "DROP ROLE IF EXISTS %I", [names.owner]);
    err("What was made has been removed; you can run this again.");
  } catch {
    err(
      `Couldn't remove what was made. In pgAdmin, remove the database "${names.database}" and the roles "${names.owner}", "${names.writer}" and "${names.reader}" before trying again.`,
    );
  }
}

/**
 * Adds the public reader role to a database an earlier version made (T-071,
 * D-109): asks for the `postgres` password once, makes the role (refusing
 * if it exists), gives it `grantPublicReaderRole` as the owner (through
 * pgpass), saves its password in pgpass and its address in `desktop.json`.
 * If anything fails, the role and its pgpass line are removed again.
 */
async function addPublicReader(input: {
  env: Env;
  ask: Ask;
  out: Line;
  err: Line;
  secrets: string[];
  folder: string;
  ownerAddress: string;
  reader: string;
  pgpassFile: string;
}): Promise<number> {
  const { env, ask, out, err } = input;
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
  out("");
  out("Oculus can now show your public sites on this computer too. That needs one more");
  out(
    `PostgreSQL account, which can only read what the public may see. It asks once more for the "${adminUser}" password (used once, not saved).`,
  );
  const adminPassword = await ask(`Password for "${adminUser}": `, { secret: true });
  if (adminPassword === undefined) {
    err(
      "No password was given. Nothing was changed; Oculus works as before, without public sites.",
    );
    return 1;
  }
  if (adminPassword !== "") input.secrets.push(adminPassword);
  const adminUrl = adminPassword === "" ? adminBase : withPassword(adminBase, adminPassword);
  let admin: Database;
  try {
    admin = openDatabase(adminUrl, { applicationName: "oculus-desktop-database", max: 1 });
  } catch {
    err(`${ADMIN_URL_VARIABLE} is not a usable postgresql:// address.`);
    return 2;
  }
  const password = newRolePassword();
  input.secrets.push(password);
  let ownerDatabase: string;
  try {
    ownerDatabase = decodeURIComponent(new URL(input.ownerAddress).pathname.slice(1));
  } catch {
    err('"ownerDatabaseUrl" in desktop.json is not a usable postgresql:// address.');
    await admin.close();
    return 1;
  }
  const readerAddress = addressFor(input.ownerAddress, input.reader, ownerDatabase);
  let made = false;
  let granted = false;
  let owner: Database | undefined;
  let added: string[] = [];
  try {
    try {
      await admin.rows(sql`SELECT 1`);
    } catch {
      err(
        `Couldn't sign in to PostgreSQL as "${adminUser}". Check the password, and that PostgreSQL is running. Nothing was changed.`,
      );
      return 1;
    }
    const existing = await admin.rows(sql`SELECT 1 FROM pg_roles WHERE rolname = ${input.reader}`);
    if (existing.length > 0) {
      err(
        `PostgreSQL already has the role ${input.reader}. Nothing was changed. If it's from an earlier try, remove it in pgAdmin (or ask for help) and run this again.`,
      );
      return 1;
    }
    made = true;
    await formatted(admin, "CREATE ROLE %I LOGIN PASSWORD %L", [
      input.reader,
      scramVerifier(password),
    ]);
    owner = openDatabase(input.ownerAddress, {
      applicationName: "oculus-desktop-database",
      max: 1,
    });
    await owner.transaction(async (tx) => {
      await grantPublicReaderRole(tx, input.reader);
    });
    granted = true;
    added = addPgpassEntries(input.pgpassFile, [
      { ...pgpassTarget(readerAddress), database: ownerDatabase, user: input.reader, password },
    ]);
    writeDesktopSettings(input.folder, { publicDatabaseUrl: readerAddress });
    made = false;
    out("Done. Start Oculus as usual; it shows each site's public side too.");
    return 0;
  } catch (error) {
    err(
      `Adding the public sites' account failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    if (made) {
      try {
        // The schema grant first: a role that holds a privilege can't be dropped.
        if (granted && owner !== undefined) {
          await formatted(owner, "REVOKE USAGE ON SCHEMA public FROM %I", [input.reader]);
        }
        await formatted(admin, "DROP ROLE IF EXISTS %I", [input.reader]);
        removePgpassLines(input.pgpassFile, added);
        err("What was made has been removed; Oculus works as before, and you can run this again.");
      } catch {
        err(`Couldn't remove what was made. In pgAdmin, remove the role "${input.reader}".`);
      }
    }
    return 1;
  } finally {
    await owner?.close();
    await admin.close();
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
