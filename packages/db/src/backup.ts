/**
 * Backup and restore (D-064): `npm run db:backup -- <file>` and
 * `npm run db:restore -- <file>`, commands any scheduler can run (D-035).
 *
 * A backup file is a pg_dump custom-format archive of the whole database,
 * followed by a manifest (JSON) and a fixed trailer:
 *
 *     [pg_dump archive][manifest][8-byte manifest length][SHA-256 of manifest]["OCULUS-BACKUP-01"]
 *
 * The manifest lists the applied migrations (name and SHA-256, from
 * `public.oculus_migrations`), every table's row count and row hash, the
 * sequences, functions, triggers, policies and grants, the server and pg_dump
 * versions, the time, and the archive's size and SHA-256. All of it is read
 * in the snapshot pg_dump dumps (`pg_export_snapshot()` and
 * `pg_dump --snapshot`), so it describes exactly what is in the archive.
 *
 * The backup is written to a temporary file (0600) next to the destination,
 * synced, then hard-linked into place, so the destination either doesn't
 * exist or is complete; an existing file is never overwritten.
 *
 * Restore checks the file (trailer, manifest hash and shape, archive size and
 * SHA-256) and that its migrations match the code's, then, as close to
 * pg_restore's start as it can, that the target database is exactly as
 * CREATE DATABASE made it and the restoring role is not a superuser; then
 * pg_restore runs with `--no-owner --single-transaction --exit-on-error`, and
 * the restored database is checked against the manifest.
 *
 * The connection comes only from OCULUS_DATABASE_URL, given identically to the
 * driver and (through a private service file) to the tools; it is never
 * printed or put on a command line (backup-connection.ts). The tools run in
 * their own process group under a small shell watchdog that ends them if this
 * process dies, and an AbortSignal (the CLI's SIGINT, SIGTERM and SIGHUP)
 * ends them and removes every temporary file.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { link, lstat, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { openSession, type Queryable, type Session } from "./client.js";
import {
  contentsOf,
  objectSummaries,
  OBJECT_KINDS,
  sorted,
  tableSummaries,
  type ObjectSummaries,
  type TableSummary,
} from "./backup-catalog.js";
import {
  ConnectionError,
  redact,
  resolveConnection,
  SERVICE_NAME,
  workspace,
  type ResolvedConnection,
  type Workspace,
} from "./backup-connection.js";
import {
  checkServerVersion,
  defaultMigrationsDir,
  MIGRATION_LOCK_KEY,
  MigrationError,
  readMigrations,
  type AppliedMigration,
  type MigrationFile,
} from "./migrate.js";
import { sql } from "./sql.js";

export type { TableSummary, ObjectSummaries } from "./backup-catalog.js";

export class BackupError extends Error {
  constructor(
    readonly code:
      | "bad_url"
      | "no_tools"
      | "tools_too_old"
      | "server_too_old"
      | "exists"
      | "not_found"
      | "not_oculus"
      | "dump_failed"
      | "write_failed"
      | "bad_file"
      | "migrations_differ"
      | "superuser"
      | "target_not_empty"
      | "target_busy"
      | "restore_failed"
      | "verify_failed"
      | "interrupted",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupError";
  }
}

function resolveOrRefuse(connectionString: string): ResolvedConnection {
  try {
    return resolveConnection(connectionString);
  } catch (error) {
    if (error instanceof ConnectionError) throw new BackupError("bad_url", error.message);
    throw error;
  }
}

/** Whether the caller asked to stop (a function, so each check reads it afresh). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function interrupted(what: string): BackupError {
  return new BackupError("interrupted", `Stopped by a signal; ${what}`);
}

/** An error's code (like ENOSPC) for a message, never its text. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown error";
}

// ---------------------------------------------------------------------------
// Finding and running pg_dump and pg_restore.

/** The directory holding `tools`, from PG_BIN or `pg_config --bindir`. */
export async function findTools(
  env: Record<string, string | undefined>,
  tools: readonly string[],
): Promise<string> {
  const usable = (dir: string): boolean => tools.every((tool) => existsSync(join(dir, tool)));
  const wanted = tools.join(" and ");
  const fromEnv = env.PG_BIN;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (usable(fromEnv)) return fromEnv;
    throw new BackupError("no_tools", `PG_BIN is set, but ${wanted} are not in ${fromEnv}.`);
  }
  try {
    const dir = (await run("pg_config", ["--bindir"], toolPathEnvironment(env))).trim();
    if (usable(dir)) return dir;
  } catch {
    // Not installed: reported below.
  }
  throw new BackupError(
    "no_tools",
    `Could not find ${wanted}. Install the PostgreSQL client tools (so \`pg_config --bindir\` finds them) or set PG_BIN to their directory.`,
  );
}

function toolPathEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  return { PATH: env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { env, encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
      if (error) reject(new Error(error.message));
      else resolvePromise(stdout);
    });
  });
}

/** The major version in `pg_dump --version` output, e.g. 16 from "pg_dump (PostgreSQL) 16.15". */
export function toolMajor(versionText: string): number | undefined {
  const match = /\(PostgreSQL\) (\d+)/.exec(versionText);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function toolVersion(bin: string, tool: string): Promise<{ text: string; major: number }> {
  const text = (await run(join(bin, tool), ["--version"], toolPathEnvironment(process.env))).trim();
  const major = toolMajor(text);
  if (major === undefined) {
    throw new BackupError("no_tools", `Could not read the version of ${join(bin, tool)}.`);
  }
  return { text, major };
}

/** libpq learned `sslrootcert=system` in 16. */
function checkSystemRoots(connection: ResolvedConnection, tool: string, major: number): void {
  if (connection.needsSystemRoots && major < 16) {
    throw new BackupError(
      "tools_too_old",
      `${tool} ${String(major)} can't check the server's certificate against the system's CAs (that needs 16 or newer): add sslrootcert=<CA file> to OCULUS_DATABASE_URL or set PG_BIN to newer tools.`,
    );
  }
}

/**
 * The shell watchdog every tool runs under (`sh -c WATCHDOG oculus-tool
 * <tool> <args...>`). It starts the tool in the background, and a watcher
 * that reads the watchdog's stdin, a pipe from this process that is never
 * written: when this process dies, however it dies, the pipe closes, the read
 * ends and the watcher ends the tool (a pg_restore then rolls back). The
 * watchdog is its own process group's leader, so a signal to the group
 * reaches the tool too.
 */
export const WATCHDOG = [
  "exec 3<&0",
  '"$@" 3<&- &',
  "pid=$!",
  '( while read -r _ <&3; do :; done; kill -TERM "$pid" 2>/dev/null ) &',
  "watcher=$!",
  "exec 3<&-",
  "status=0",
  'wait "$pid" || status=$?',
  'kill "$watcher" 2>/dev/null',
  'exit "$status"',
].join("\n");

interface ToolResult {
  code: number | null;
  stderr: string;
}

/**
 * Runs a tool under the watchdog. Its stdout goes to `sink` (or nowhere).
 * Aborting `signal` sends SIGTERM to the tool's whole process group, and
 * SIGKILL 5 seconds later if it is still there.
 */
async function runTool(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  sink?: (chunk: Buffer) => Promise<void>,
): Promise<ToolResult> {
  const child = spawn("/bin/sh", ["-c", WATCHDOG, "oculus-tool", cmd, ...args], {
    env,
    detached: true,
    stdio: ["pipe", sink === undefined ? "ignore" : "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolvePromise) => {
    child.on("error", () => {
      resolvePromise(null);
    });
    child.on("close", (code) => {
      resolvePromise(code);
    });
  });
  let done = false;
  const killGroup = (sig: NodeJS.Signals): void => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // Already gone.
    }
  };
  let forceTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    killGroup("SIGTERM");
    forceTimer = setTimeout(() => {
      killGroup("SIGKILL");
    }, 5000);
    forceTimer.unref();
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin?.on("error", () => undefined);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  try {
    if (sink !== undefined && child.stdout !== null) {
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) await sink(chunk);
      } catch (error) {
        killGroup("SIGTERM");
        await closed;
        throw new BackupError("write_failed", `Could not write the backup (${errorCode(error)}).`);
      }
    }
    return { code: await closed, stderr };
  } finally {
    done = true;
    signal?.removeEventListener("abort", onAbort);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    child.stdin?.destroy();
  }
}

// ---------------------------------------------------------------------------
// The manifest and the file format.

export const BACKUP_FORMAT = "oculus-backup";
export const BACKUP_FORMAT_VERSION = 1;
/** The last 16 bytes of every backup file. */
export const TRAILER_MAGIC = "OCULUS-BACKUP-01";
/** 8 bytes of manifest length, 32 of its SHA-256, 16 of magic. */
export const TRAILER_BYTES = 8 + 32 + 16;
/** A manifest is small; anything larger is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  serverVersion: string;
  serverVersionNum: number;
  pgDumpVersion: string;
  migrations: AppliedMigration[];
  tables: TableSummary[];
  objects: ObjectSummaries;
  dump: { bytes: number; sha256: string };
}

const HEX64 = /^[0-9a-f]{64}$/;
const INTEGER_TEXT = /^-?[0-9]{1,40}$/;

/** Checks a parsed manifest's shape exactly; returns a description of the first problem. */
export function manifestProblem(value: unknown): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
  if (!isObject(value)) return "it is not a JSON object";
  const keys = [
    "format",
    "formatVersion",
    "createdAt",
    "serverVersion",
    "serverVersionNum",
    "pgDumpVersion",
    "migrations",
    "tables",
    "objects",
    "dump",
  ];
  if (value.format !== BACKUP_FORMAT) return "it is not an Oculus backup manifest";
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) {
    return `its format version is not ${String(BACKUP_FORMAT_VERSION)}`;
  }
  if (!exactKeys(value, keys)) return "it does not have exactly the expected fields";
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    return "createdAt is not a time";
  }
  if (typeof value.serverVersion !== "string") return "serverVersion is not text";
  if (!Number.isSafeInteger(value.serverVersionNum)) return "serverVersionNum is not a number";
  if (typeof value.pgDumpVersion !== "string" || toolMajor(value.pgDumpVersion) === undefined) {
    return "pgDumpVersion is not a pg_dump version";
  }
  const { migrations, tables, objects, dump } = value;
  if (!Array.isArray(migrations)) return "migrations is not a list";
  let previous = "";
  for (const m of migrations as unknown[]) {
    if (
      !isObject(m) ||
      !exactKeys(m, ["name", "sha256"]) ||
      typeof m.name !== "string" ||
      typeof m.sha256 !== "string" ||
      !HEX64.test(m.sha256)
    ) {
      return "a migration is not a name and a SHA-256";
    }
    if (m.name <= previous) return "migrations are not in name order";
    previous = m.name;
  }
  if (!Array.isArray(tables)) return "tables is not a list";
  previous = "";
  for (const t of tables as unknown[]) {
    if (
      !isObject(t) ||
      !exactKeys(t, ["name", "rows", "rowsHash"]) ||
      typeof t.name !== "string" ||
      typeof t.rows !== "string" ||
      typeof t.rowsHash !== "string" ||
      !INTEGER_TEXT.test(t.rows) ||
      !INTEGER_TEXT.test(t.rowsHash)
    ) {
      return "a table is not a name, a row count and a row hash";
    }
    if (t.name <= previous) return "tables are not in name order";
    previous = t.name;
  }
  if (!isObject(objects) || !exactKeys(objects, OBJECT_KINDS)) {
    return "objects does not list exactly the expected kinds";
  }
  for (const kind of OBJECT_KINDS) {
    const list = objects[kind];
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      return `objects.${kind} is not a list of text`;
    }
    previous = "";
    for (const item of list) {
      if (item <= previous) return `objects.${kind} is not in order`;
      previous = item;
    }
  }
  if (
    !isObject(dump) ||
    !exactKeys(dump, ["bytes", "sha256"]) ||
    !Number.isSafeInteger(dump.bytes) ||
    (dump.bytes as number) <= 0 ||
    typeof dump.sha256 !== "string" ||
    !HEX64.test(dump.sha256)
  ) {
    return "dump is not a size and a SHA-256";
  }
  return undefined;
}

/** The bytes after the archive: the manifest and the trailer. */
export function manifestAndTrailer(manifest: BackupManifest): Buffer {
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(body.length));
  const digest = createHash("sha256").update(body).digest();
  return Buffer.concat([body, length, digest, Buffer.from(TRAILER_MAGIC, "ascii")]);
}

/** Reads and checks a backup file's manifest (not the archive). */
export async function readManifest(path: string): Promise<BackupManifest> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") throw new BackupError("not_found", `There is no file at ${path}.`);
    throw new BackupError("not_found", `Could not open ${path} (${code}).`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BackupError("bad_file", `${path} is not a file.`);
    const notBackup = `${path} is not an Oculus backup, or it is damaged`;
    if (stat.size < TRAILER_BYTES) throw new BackupError("bad_file", `${notBackup}: too short.`);
    const trailer = Buffer.alloc(TRAILER_BYTES);
    await handle.read(trailer, 0, TRAILER_BYTES, stat.size - TRAILER_BYTES);
    if (trailer.subarray(40).toString("ascii") !== TRAILER_MAGIC) {
      throw new BackupError("bad_file", `${notBackup}: it does not end with the backup trailer.`);
    }
    const length = trailer.readBigUInt64BE(0);
    if (
      length <= 0n ||
      length > BigInt(MAX_MANIFEST_BYTES) ||
      Number(length) > stat.size - TRAILER_BYTES
    ) {
      throw new BackupError("bad_file", `${notBackup}: the manifest length is impossible.`);
    }
    const manifestBytes = Number(length);
    const body = Buffer.alloc(manifestBytes);
    await handle.read(body, 0, manifestBytes, stat.size - TRAILER_BYTES - manifestBytes);
    if (!createHash("sha256").update(body).digest().equals(trailer.subarray(8, 40))) {
      throw new BackupError("bad_file", `${notBackup}: the manifest does not match its SHA-256.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new BackupError("bad_file", `${notBackup}: the manifest is not JSON.`);
    }
    const problem = manifestProblem(parsed);
    if (problem !== undefined) {
      throw new BackupError("bad_file", `${notBackup}: in the manifest, ${problem}.`);
    }
    const manifest = parsed as BackupManifest;
    if (manifest.dump.bytes !== stat.size - TRAILER_BYTES - manifestBytes) {
      throw new BackupError(
        "bad_file",
        `${notBackup}: the archive is not the size the manifest gives.`,
      );
    }
    return manifest;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// What the database holds.

async function appliedMigrations(db: Queryable): Promise<AppliedMigration[] | undefined> {
  const [exists] = await db.rows<{ exists: boolean }>(
    sql`SELECT pg_catalog.to_regclass('public.oculus_migrations') IS NOT NULL AS exists`,
  );
  if (!exists?.exists) return undefined;
  const rows = await db.rows<AppliedMigration>(
    sql`SELECT name, sha256 FROM public.oculus_migrations`,
  );
  const byName = new Map(rows.map((row) => [row.name, row.sha256]));
  return sorted([...byName.keys()]).map((name) => ({ name, sha256: byName.get(name) ?? "" }));
}

async function serverVersion(db: Queryable): Promise<{ text: string; num: number }> {
  const [row] = await db.rows<{ text: string; num: string }>(
    sql`SELECT pg_catalog.current_setting('server_version') AS text,
               pg_catalog.current_setting('server_version_num') AS num`,
  );
  const num = Number(row?.num);
  try {
    checkServerVersion(num);
  } catch (error) {
    if (error instanceof MigrationError) {
      throw new BackupError("server_too_old", error.message);
    }
    throw error;
  }
  return { text: row?.text ?? "", num };
}

async function connect(
  connection: ResolvedConnection,
  applicationName: string,
  failure: "dump_failed" | "restore_failed",
): Promise<Session> {
  try {
    return await openSession(connection.node, applicationName);
  } catch (error) {
    throw new BackupError(
      failure,
      `Could not connect to the database: ${redact((error as Error).message, connection.secrets)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Backup.

export interface BackupOptions {
  connectionString: string;
  /** Where to write the backup. Must not exist. Relative to the current directory. */
  file: string;
  /** The environment for PG_BIN, PATH and PGPASSWORD / PGPASSFILE (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Where the private service-file directory goes (default: the system's temporary directory). */
  tempDir?: string;
  /** Stops the backup: the tool is ended and nothing is left behind. */
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface BackupResult {
  file: string;
  manifest: BackupManifest;
}

/** Fails if anything is at `path` (a file, a link, a directory). */
async function mustNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new BackupError("exists", `${path} already exists; a backup never overwrites a file.`);
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch {
    // Some file systems can't sync a directory; the file itself is synced.
  } finally {
    await handle.close();
  }
}

/**
 * Moves the finished temporary file to `file` without ever overwriting: a hard
 * link fails if `file` exists. A file system without hard links is refused
 * rather than risk a check-then-rename race.
 */
async function publish(temp: string, file: string, log: (message: string) => void): Promise<void> {
  try {
    await link(temp, file);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new BackupError("exists", `${file} appeared while the backup ran; it was left alone.`);
    }
    throw new BackupError(
      "write_failed",
      `Could not put the backup in place at ${file} (${code}). Backups need a file system with hard links (so nothing is ever overwritten); write to a local disk and copy the file from there.`,
    );
  }
  try {
    await unlink(temp);
  } catch (error) {
    log(
      `Warning: the backup is complete at ${file}, but the temporary file ${temp} could not be removed (${errorCode(error)}); delete it.`,
    );
  }
  await syncDirectory(dirname(file));
}

/** Writes a backup of the whole database to `file` (0600). */
export async function backup(options: BackupOptions): Promise<BackupResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const { signal } = options;
  const file = resolve(options.file);
  const connection = resolveOrRefuse(options.connectionString);
  await mustNotExist(file);
  const bin = await findTools(env, ["pg_dump"]);
  const pgDump = await toolVersion(bin, "pg_dump");
  checkSystemRoots(connection, "pg_dump", pgDump.major);
  if (stopped(signal)) throw interrupted("no backup was written.");

  const session = await connect(connection, "oculus-backup", "dump_failed");
  let space: Workspace | undefined;
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.partial`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    const server = await serverVersion(session);
    const serverMajor = Math.floor(server.num / 10000);
    if (pgDump.major < serverMajor) {
      throw new BackupError(
        "tools_too_old",
        `pg_dump ${String(pgDump.major)} can't back up PostgreSQL ${server.text}: set PG_BIN to the bin directory of PostgreSQL ${String(serverMajor)} or newer.`,
      );
    }
    // One snapshot for the manifest and pg_dump. The transaction sits idle
    // while pg_dump runs, so no role or database timeout may end it.
    await session.control("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await session.rows(sql`
      SELECT pg_catalog.set_config('statement_timeout', '0', true),
             pg_catalog.set_config('idle_in_transaction_session_timeout', '0', true),
             CASE WHEN pg_catalog.current_setting('transaction_timeout', true) IS NOT NULL
                  THEN pg_catalog.set_config('transaction_timeout', '0', true) END`);
    const migrations = await appliedMigrations(session);
    if (migrations === undefined) {
      throw new BackupError(
        "not_oculus",
        "This database has no public.oculus_migrations table, so it is not an Oculus database (run npm run db:migrate first).",
      );
    }
    const tables = await tableSummaries(session);
    const objects = await objectSummaries(session);
    const [snapshot] = await session.rows<{ id: string }>(
      sql`SELECT pg_catalog.pg_export_snapshot() AS id`,
    );
    if (snapshot === undefined) throw new Error("No snapshot was exported.");

    space = await workspace(connection, env, "oculus-backup", options.tempDir ?? tmpdir());
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.chmod(0o600);
    } catch (error) {
      throw new BackupError(
        "write_failed",
        `Could not create a file in ${dirname(file)} (${errorCode(error)}).`,
      );
    }
    if (stopped(signal)) throw interrupted("no backup was written.");
    log(`Backing up PostgreSQL ${server.text} with ${pgDump.text}...`);
    const hash = createHash("sha256");
    let bytes = 0;
    const out = handle;
    const result = await runTool(
      join(bin, "pg_dump"),
      [
        "--format=custom",
        "--no-password",
        `--snapshot=${snapshot.id}`,
        `--dbname=service=${SERVICE_NAME}`,
      ],
      space.env,
      signal,
      async (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
        await out.write(chunk);
      },
    );
    if (stopped(signal)) throw interrupted("no backup was written.");
    if (result.code !== 0 || bytes === 0) {
      throw new BackupError(
        "dump_failed",
        `pg_dump failed (exit ${String(result.code)}): ${redact(result.stderr, connection.secrets) || "no message"}`,
      );
    }
    // pg_dump has its own snapshot copy now; if the exporting session was
    // lost meanwhile, the archive is still complete and consistent.
    await session.control("COMMIT").catch(() => undefined);

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      serverVersion: server.text,
      serverVersionNum: server.num,
      pgDumpVersion: pgDump.text,
      migrations,
      tables,
      objects,
      dump: { bytes, sha256: hash.digest("hex") },
    };
    await handle.write(manifestAndTrailer(manifest));
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (stopped(signal)) throw interrupted("no backup was written.");
    await publish(temp, file, log);
    published = true;
    return { file, manifest };
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temp, { force: true }).catch(() => undefined);
    await session.close().catch(() => undefined);
    await space?.remove();
  }
}

// ---------------------------------------------------------------------------
// Restore.

export interface RestoreOptions {
  connectionString: string;
  /** The backup file. Relative to the current directory. */
  file: string;
  /** Default: packages/db/migrations. */
  migrationsDir?: string;
  /** Restore even as a superuser (not recommended: a backup's SQL then runs with every privilege). */
  allowSuperuser?: boolean;
  env?: Record<string, string | undefined>;
  tempDir?: string;
  /** Stops the restore: pg_restore is ended (its transaction rolls back) and nothing is left behind. */
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Migration files in the code that are newer than the backup: run db:migrate next. */
  pending: string[];
}

/**
 * Compares the backup's migrations with the code's files. Every migration in
 * the backup must be a file in the code with the same SHA-256, and no file the
 * backup lacks may sort before the backup's last one. Files after it are
 * pending (the backup is older than the code). Returns the pending names, or
 * throws listing every difference.
 */
export function compareMigrations(
  backedUp: readonly AppliedMigration[],
  files: readonly MigrationFile[],
): string[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  const inBackup = new Set(backedUp.map((m) => m.name));
  const differences: string[] = [];
  for (const m of backedUp) {
    const file = byName.get(m.name);
    if (file === undefined) differences.push(`${m.name} is in the backup but not in the code`);
    else if (file.sha256 !== m.sha256) {
      differences.push(`${m.name} in the backup differs from the code's file`);
    }
  }
  const last = backedUp.at(-1)?.name;
  const missing = files.filter((file) => !inBackup.has(file.name));
  for (const file of missing) {
    if (last !== undefined && file.name < last) {
      differences.push(`${file.name} is in the code but not in the backup, before ${last}`);
    }
  }
  if (differences.length > 0) {
    throw new BackupError(
      "migrations_differ",
      `The backup's migrations don't match this version of Oculus: ${differences.join("; ")}. Restore it with the version of Oculus that made it.`,
    );
  }
  return missing.map((file) => file.name);
}

/** Restores a backup into an empty database and checks the result against its manifest. */
export async function restore(options: RestoreOptions): Promise<RestoreResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const { signal } = options;
  const file = resolve(options.file);
  const connection = resolveOrRefuse(options.connectionString);
  const manifest = await readManifest(file);
  const pending = compareMigrations(
    manifest.migrations,
    await readMigrations(options.migrationsDir ?? defaultMigrationsDir()),
  );
  const bin = await findTools(env, ["pg_restore"]);
  const pgRestore = await toolVersion(bin, "pg_restore");
  checkSystemRoots(connection, "pg_restore", pgRestore.major);
  const dumpMajor = toolMajor(manifest.pgDumpVersion) ?? Number.MAX_SAFE_INTEGER;
  if (pgRestore.major < dumpMajor) {
    throw new BackupError(
      "tools_too_old",
      `This backup was made by pg_dump ${String(dumpMajor)}; pg_restore ${String(pgRestore.major)} can't read it. Set PG_BIN to the bin directory of PostgreSQL ${String(dumpMajor)} or newer.`,
    );
  }

  const space = await workspace(connection, env, "oculus-restore", options.tempDir ?? tmpdir());
  let session: Session | undefined;
  try {
    // The archive is copied out and checked before the target is looked at,
    // so the emptiness check comes right before pg_restore starts.
    const archive = join(space.dir, "archive.dump");
    await extractArchive(file, archive, manifest);
    if (stopped(signal)) throw interrupted("nothing was restored.");

    session = await connect(connection, "oculus-restore-check", "restore_failed");
    // This session holds the migration lock while pg_restore runs; no role or
    // database timeout may end it.
    await session.rows(sql`
      SELECT pg_catalog.set_config('statement_timeout', '0', false),
             pg_catalog.set_config('idle_session_timeout', '0', false),
             pg_catalog.set_config('idle_in_transaction_session_timeout', '0', false)`);
    const server = await serverVersion(session);
    const serverMajor = Math.floor(server.num / 10000);
    if (pgRestore.major < serverMajor) {
      throw new BackupError(
        "tools_too_old",
        `pg_restore ${String(pgRestore.major)} is older than PostgreSQL ${server.text}: set PG_BIN to the bin directory of PostgreSQL ${String(serverMajor)} or newer.`,
      );
    }
    const [role] = await session.rows<{ superuser: boolean }>(
      sql`SELECT pg_catalog.current_setting('is_superuser') = 'on' AS superuser`,
    );
    if (role?.superuser === true) {
      if (options.allowSuperuser !== true) {
        throw new BackupError(
          "superuser",
          "The role in OCULUS_DATABASE_URL is a superuser, so everything in the backup would run with every privilege. Restore as the role that owns the new empty database (CREATE DATABASE ... OWNER that_role TEMPLATE template0), or pass --allow-superuser if you must.",
        );
      }
      log(
        "WARNING: restoring as a superuser (--allow-superuser): everything in the backup runs with every privilege. Only do this with a backup you made yourself.",
      );
    }
    // Hold the migration runner's lock, so db:migrate can't fill the target
    // while it is checked and restored.
    const [locked] = await session.rows<{ ok: boolean }>(
      sql`SELECT pg_catalog.pg_try_advisory_lock(${String(MIGRATION_LOCK_KEY)}::pg_catalog.int8) AS ok`,
    );
    if (locked?.ok !== true) {
      throw new BackupError(
        "target_busy",
        "A migration is running on the target database; nothing was restored.",
      );
    }
    const contents = await contentsOf(session);
    if (Object.keys(contents).length > 0) {
      const found = Object.entries(contents)
        .map(([kind, count]) => `${String(count)} ${kind.replaceAll("_", " ")}`)
        .join(", ");
      throw new BackupError(
        "target_not_empty",
        `The target database is not as CREATE DATABASE made it (${found}); a restore never overwrites a database. Create a new empty one (CREATE DATABASE ... TEMPLATE template0) and restore into that.`,
      );
    }
    if (stopped(signal)) throw interrupted("nothing was restored.");

    log(`Restoring a backup of PostgreSQL ${manifest.serverVersion} made ${manifest.createdAt}...`);
    const restored = await runTool(
      join(bin, "pg_restore"),
      [
        "--no-owner",
        "--single-transaction",
        "--exit-on-error",
        "--no-password",
        `--dbname=service=${SERVICE_NAME}`,
        archive,
      ],
      space.env,
      signal,
    );
    if (restored.code !== 0) {
      if (stopped(signal)) {
        throw interrupted("pg_restore was stopped and its transaction rolled back.");
      }
      throw new BackupError(
        "restore_failed",
        `pg_restore failed (exit ${String(restored.code)}); nothing was restored (it runs in one transaction): ${redact(restored.stderr, connection.secrets) || "no message"}`,
      );
    }
    // pg_restore committed: check the result even if a signal came meanwhile.
    await verify(session, manifest);
    return { manifest, pending };
  } finally {
    await session?.close().catch(() => undefined);
    await space.remove();
  }
}

/** Copies the archive out of the backup file, checking its size and SHA-256 against the manifest. */
async function extractArchive(
  file: string,
  archive: string,
  manifest: BackupManifest,
): Promise<void> {
  const source = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const target = await open(archive, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < manifest.dump.bytes) {
        const want = Math.min(buffer.length, manifest.dump.bytes - position);
        const { bytesRead } = await source.read(buffer, 0, want, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await target.write(chunk);
        position += bytesRead;
      }
      if (position !== manifest.dump.bytes || hash.digest("hex") !== manifest.dump.sha256) {
        throw new BackupError(
          "bad_file",
          `${file} is damaged: its archive does not match the SHA-256 in its manifest. Nothing was restored.`,
        );
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** Lines in one list and not the other, for a message. */
function listDifference(kind: string, expected: string[], found: string[]): string[] {
  const have = new Set(found);
  const want = new Set(expected);
  const out: string[] = [];
  for (const item of expected) if (!have.has(item)) out.push(`${kind} missing: ${item}`);
  for (const item of found) if (!want.has(item)) out.push(`${kind} not in the backup: ${item}`);
  return out;
}

/** Checks the restored database against the manifest. */
async function verify(db: Queryable, manifest: BackupManifest): Promise<void> {
  const problems: string[] = [];
  const migrations = (await appliedMigrations(db)) ?? [];
  const wanted = manifest.migrations.map((m) => `${m.name} ${m.sha256}`).join("\n");
  if (migrations.map((m) => `${m.name} ${m.sha256}`).join("\n") !== wanted) {
    problems.push("public.oculus_migrations differs from the manifest");
  }
  const tables = new Map((await tableSummaries(db)).map((t) => [t.name, t]));
  for (const expected of manifest.tables) {
    const found = tables.get(expected.name);
    if (found === undefined) problems.push(`${expected.name} is missing`);
    else if (found.rows !== expected.rows) {
      problems.push(`${expected.name} has ${found.rows} rows, not ${expected.rows}`);
    } else if (found.rowsHash !== expected.rowsHash) {
      problems.push(`${expected.name}'s rows differ from the backup's`);
    }
    tables.delete(expected.name);
  }
  for (const name of tables.keys()) problems.push(`${name} is not in the backup`);
  const objects = await objectSummaries(db);
  for (const kind of OBJECT_KINDS) {
    problems.push(...listDifference(kind, manifest.objects[kind], objects[kind]));
  }
  if (problems.length > 0) {
    throw new BackupError(
      "verify_failed",
      `The restored database does not match the backup's manifest: ${problems.join("; ")}. Do not use it: drop it, create a new empty database and restore again from a good backup.`,
    );
  }
}
