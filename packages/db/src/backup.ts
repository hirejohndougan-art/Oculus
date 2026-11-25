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
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { link, lstat, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Writable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { openSession, type Queryable, type Session } from "./client.js";
import {
  contentsOf,
  grantee,
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
import { trackGroup, trackPath, trackProcess } from "./backup-cleanup.js";

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
      | "privileges_needed"
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

/** A tool's file name: `pg_dump.exe` on Windows (S-034b, D-100). */
export function executable(tool: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${tool}.exe` : tool;
}

/**
 * The bin folders of PostgreSQL installed by the EDB installer on Windows
 * (`%ProgramFiles%\\PostgreSQL\\<major>\\bin`), newest major first: it puts
 * none of them on PATH, so `pg_config` isn't found there.
 */
export function windowsInstallBins(env: Record<string, string | undefined>): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(
    (r): r is string => r !== undefined && r !== "",
  );
  const found: { dir: string; major: number }[] = [];
  for (const root of new Set(roots)) {
    const base = join(root, "PostgreSQL");
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^\d+(\.\d+)?$/.test(name))
        found.push({ dir: join(base, name, "bin"), major: Number(name) });
    }
  }
  return found.sort((a, b) => b.major - a.major).map((f) => f.dir);
}

/** The directory holding `tools`, from PG_BIN or `pg_config --bindir` (or, on Windows, the usual install folders). */
export async function findTools(
  env: Record<string, string | undefined>,
  tools: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const usable = (dir: string): boolean =>
    tools.every((tool) => existsSync(join(dir, executable(tool, platform))));
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
    // Not on PATH: the Windows install folders, then the error below.
  }
  if (platform === "win32") {
    const dir = windowsInstallBins(env).find(usable);
    if (dir !== undefined) return dir;
  }
  throw new BackupError(
    "no_tools",
    `Could not find ${wanted}. Install the PostgreSQL client tools (so \`pg_config --bindir\` finds them) or set PG_BIN to their directory.`,
  );
}

function toolPathEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {
    PATH: env.PATH ?? env.Path ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  // Windows programs need SystemRoot to start (its DLLs are found through it).
  for (const key of ["SystemRoot", "SYSTEMROOT", "windir"]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
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
  const text = (
    await run(join(bin, executable(tool)), ["--version"], toolPathEnvironment(process.env))
  ).trim();
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
 * <tool> <args...>`), in its own process group. Its file descriptors from
 * this process: 0 is the lifeline, a pipe that is never written; 3 is the
 * tool's input (the archive, for pg_restore; empty for pg_dump). It starts the
 * tool in the background with fd 3 as its stdin, and a watcher that reads the
 * lifeline: when this process dies, however it dies, the pipe closes, the read
 * ends and the watcher sends the whole group SIGTERM, then SIGKILL 5 seconds
 * later (so a tool that ignores SIGTERM, and anything it started, still ends;
 * an unfinished pg_restore rolls back either way). The watchdog itself
 * survives SIGTERM, SIGINT and SIGHUP (passing them to the tool) and waits for
 * the tool, so this process sees the tool's real end; this process sends
 * SIGKILL to the group if the tool outlives its grace period, and at once if
 * the watchdog is killed. The arguments are never interpreted by the shell.
 */
export const WATCHDOG = [
  "exec 4<&0",
  '"$@" <&3 3<&- 4<&- &',
  "pid=$!",
  "exec 3<&-",
  "( trap '' TERM INT HUP; while read -r _ <&4; do :; done; kill -TERM -$$ 2>/dev/null; sleep 5; kill -KILL -$$ 2>/dev/null ) &",
  "watcher=$!",
  "exec 4<&-",
  `trap 'kill -TERM "$pid" 2>/dev/null' TERM INT HUP`,
  "status=0",
  "while :; do",
  '  wait "$pid"; status=$?',
  '  kill -0 "$pid" 2>/dev/null || break',
  "done",
  'kill -KILL "$watcher" 2>/dev/null',
  'exit "$status"',
].join("\n");

/** How long a tool has to end after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;

interface ToolResult {
  code: number | null;
  stderr: string;
}

interface ToolIo {
  /** Receives the tool's stdout (default: discarded). */
  sink?: (chunk: Buffer) => Promise<void>;
  /** Writes the tool's stdin; the stream is ended afterwards. */
  feed?: (input: Writable) => Promise<void>;
}

/** Writes a chunk, waiting while the pipe is full. */
export async function writeAll(stream: Writable, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

/**
 * Runs a tool under the watchdog. Aborting `signal` sends SIGTERM to the
 * tool's whole process group, and SIGKILL after a grace period. If the
 * watchdog itself dies by a signal, the group is killed at once, so the
 * tool can't keep the pipes open. While it runs, the group is registered for
 * the synchronous clean-up on exit (backup-cleanup.ts).
 */
/**
 * How tools are run: under the POSIX watchdog (above), or directly, where
 * there is no `sh` or process group (Windows; S-034b, D-100). Run directly,
 * a tool's input is its stdin, stopping it terminates it (Windows has no
 * SIGTERM; an unfinished pg_restore rolls back, its one transaction never
 * committed), and if this process is killed outright the tool may run on
 * until it ends by itself: its server session then finishes or rolls back,
 * as for a lost connection.
 */
export type ToolRunner = "watchdog" | "direct";

export function defaultToolRunner(platform: NodeJS.Platform = process.platform): ToolRunner {
  return platform === "win32" ? "direct" : "watchdog";
}

async function runTool(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  io: ToolIo = {},
  runner: ToolRunner = defaultToolRunner(),
): Promise<ToolResult> {
  if (runner === "direct") return runToolDirect(cmd, args, env, signal, io);
  const child = spawn("/bin/sh", ["-c", WATCHDOG, "oculus-tool", cmd, ...args], {
    env,
    detached: true,
    stdio: ["pipe", io.sink === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const untrack = child.pid === undefined ? () => undefined : trackGroup(child.pid);
  let done = false;
  const killGroup = (sig: NodeJS.Signals): void => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // Already gone.
    }
  };
  const closed = new Promise<number | null>((resolvePromise) => {
    child.on("error", () => {
      resolvePromise(null);
    });
    child.on("exit", (_code, sig) => {
      // The watchdog was killed: end the tool now, so its pipes close.
      if (sig !== null) killGroup("SIGKILL");
    });
    child.on("close", (code) => {
      resolvePromise(code);
    });
  });
  let forceTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    killGroup("SIGTERM");
    forceTimer = setTimeout(() => {
      killGroup("SIGKILL");
    }, KILL_GRACE_MS);
    forceTimer.unref();
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin?.on("error", () => undefined);
  const input = child.stdio[3] as Writable | null;
  input?.on("error", () => undefined);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  try {
    const feeding = (async () => {
      if (input === null) return;
      try {
        if (io.feed !== undefined) await io.feed(input);
      } catch (error) {
        if (error instanceof BackupError) {
          killGroup("SIGKILL");
          throw error;
        }
        // The tool stopped reading (it failed): its exit code says why.
      } finally {
        input.end();
      }
    })();
    const reading = (async () => {
      const { sink } = io;
      if (sink === undefined || child.stdout === null) return;
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) await sink(chunk);
      } catch (error) {
        killGroup("SIGKILL");
        throw new BackupError("write_failed", `Could not write the backup (${errorCode(error)}).`);
      }
    })();
    const outcomes = await Promise.allSettled([feeding, reading]);
    const code = await closed;
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    return { code, stderr };
  } finally {
    done = true;
    untrack();
    signal?.removeEventListener("abort", onAbort);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    child.stdin?.destroy();
  }
}

/** Runs a tool directly (no shell, no process group): see `ToolRunner`. */
async function runToolDirect(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  io: ToolIo,
): Promise<ToolResult> {
  const child = spawn(cmd, args, {
    env,
    windowsHide: true,
    stdio: [
      io.feed === undefined ? "ignore" : "pipe",
      io.sink === undefined ? "ignore" : "pipe",
      "pipe",
    ],
  });
  const untrack = child.pid === undefined ? () => undefined : trackProcess(child.pid);
  let done = false;
  const kill = (sig: NodeJS.Signals): void => {
    if (done) return;
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  const closed = new Promise<number | null>((resolvePromise) => {
    child.on("error", () => {
      resolvePromise(null);
    });
    child.on("close", (code) => {
      resolvePromise(code);
    });
  });
  let forceTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    kill("SIGTERM");
    forceTimer = setTimeout(() => {
      kill("SIGKILL");
    }, KILL_GRACE_MS);
    forceTimer.unref();
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const input = child.stdin;
  input?.on("error", () => undefined);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  try {
    const feeding = (async () => {
      if (input === null || io.feed === undefined) return;
      try {
        await io.feed(input);
      } catch (error) {
        if (error instanceof BackupError) {
          kill("SIGKILL");
          throw error;
        }
        // The tool stopped reading (it failed): its exit code says why.
      } finally {
        input.end();
      }
    })();
    const reading = (async () => {
      const { sink } = io;
      if (sink === undefined || child.stdout === null) return;
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) await sink(chunk);
      } catch (error) {
        kill("SIGKILL");
        throw new BackupError("write_failed", `Could not write the backup (${errorCode(error)}).`);
      }
    })();
    const outcomes = await Promise.allSettled([feeding, reading]);
    const code = await closed;
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    return { code, stderr };
  } finally {
    done = true;
    untrack();
    signal?.removeEventListener("abort", onAbort);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }
}

// ---------------------------------------------------------------------------
// The manifest and the file format.

export const BACKUP_FORMAT = "oculus-backup";
export const BACKUP_FORMAT_VERSION = 2;
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
    return typeof value.formatVersion === "number" && value.formatVersion < BACKUP_FORMAT_VERSION
      ? `its format version is ${String(value.formatVersion)}, from an earlier version of Oculus; restore it with the version of Oculus that made it`
      : `its format version is not ${String(BACKUP_FORMAT_VERSION)}`;
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
  /** How pg_dump runs (default: `direct` on Windows, `watchdog` elsewhere; tests choose). */
  toolRunner?: ToolRunner;
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

/** Syncs a directory; returns false if it couldn't (some file systems can't). */
async function syncDirectory(dir: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, fsConstants.O_RDONLY);
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
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
  if (!(await syncDirectory(dirname(file)))) {
    log(
      `Warning: the backup is complete at ${file}, but its directory could not be synced to disk; a power cut in the next moments could lose the new name.`,
    );
  }
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
  // Hidden, and matched by .gitignore's `*.partial`.
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.partial`);
  let untrackTemp: (() => void) | undefined;
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
      untrackTemp = trackPath(temp);
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
      join(bin, executable("pg_dump")),
      [
        "--format=custom",
        "--no-password",
        `--snapshot=${snapshot.id}`,
        `--dbname=service=${SERVICE_NAME}`,
      ],
      space.env,
      signal,
      {
        sink: async (chunk) => {
          hash.update(chunk);
          bytes += chunk.length;
          await out.write(chunk);
        },
      },
      options.toolRunner,
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
    untrackTemp?.();
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
  /**
   * Restore even as a role with superuser powers (not recommended: a backup's
   * SQL then runs with every privilege).
   */
  allowSuperuser?: boolean;
  /**
   * Leave out the backup's GRANTs and REVOKEs (`pg_restore --no-privileges`),
   * for a server where the roles they name don't exist, as after a disaster on
   * another cluster. Grants are then not checked afterwards; set them up again.
   */
  noPrivileges?: boolean;
  /** How pg_restore runs (default: `direct` on Windows, `watchdog` elsewhere; tests choose). */
  toolRunner?: ToolRunner;
  env?: Record<string, string | undefined>;
  tempDir?: string;
  /**
   * Stops the restore: pg_restore is ended and its transaction rolls back. If
   * it had already committed, the restore is checked and reported as done.
   */
  signal?: AbortSignal;
  /**
   * Called once pg_restore has committed, before the check: from then on a
   * stop can't undo the restore, and the check should be let finish.
   */
  onCommitted?: () => void;
  log?: (message: string) => void;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Migration files in the code that are newer than the backup: run db:migrate next. */
  pending: string[];
  /** A stop was asked for after pg_restore had committed; the restore is complete and checked. */
  stoppedAfterCommit: boolean;
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

/**
 * Why the connected role may not restore without --allow-superuser, or an
 * empty list. An allowlist: the session role and the current role must be
 * the same role, with no attribute beyond LOGIN and INHERIT / NOINHERIT (no
 * SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS), and a member of
 * no other role at all, so nothing it could inherit or SET ROLE to (a
 * superuser, pg_execute_server_program, pg_signal_backend, a managed
 * service's administrator role, a NOLOGIN role with CREATEROLE...) can lend
 * the backup's SQL more power. Membership counts in `pg_auth_members`
 * directly: a role that is a member of nothing is a member of nothing
 * indirectly either. (Owning the database, through pg_database_owner, is not
 * a membership row.)
 */
export async function restoreRoleProblems(db: Queryable): Promise<string[]> {
  const [row] = await db.rows<{
    session: string;
    current: string;
    superuser: boolean;
    createrole: boolean;
    createdb: boolean;
    replication: boolean;
    bypassrls: boolean;
    memberOf: string[];
  }>(sql`
    SELECT s.rolname::pg_catalog.text AS session, c.rolname::pg_catalog.text AS current,
           s.rolsuper OR c.rolsuper AS superuser,
           s.rolcreaterole OR c.rolcreaterole AS createrole,
           s.rolcreatedb OR c.rolcreatedb AS createdb,
           s.rolreplication OR c.rolreplication AS replication,
           s.rolbypassrls OR c.rolbypassrls AS bypassrls,
           ARRAY(SELECT DISTINCT r.rolname::pg_catalog.text
                 FROM pg_catalog.pg_auth_members m
                 JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
                 WHERE m.member IN (s.oid, c.oid)
                 ORDER BY 1)::pg_catalog.text[] AS "memberOf"
    FROM pg_catalog.pg_roles s, pg_catalog.pg_roles c
    WHERE s.rolname = SESSION_USER AND c.rolname = CURRENT_USER`);
  if (row === undefined) return ["the connected role could not be read"];
  const reasons: string[] = [];
  const who = row.session;
  if (row.session !== row.current) {
    reasons.push(`the session role ${row.session} acts as ${row.current}`);
  }
  if (row.superuser) reasons.push(`${who} is a superuser`);
  if (row.createrole) reasons.push(`${who} has CREATEROLE`);
  if (row.createdb) reasons.push(`${who} has CREATEDB`);
  if (row.replication) reasons.push(`${who} has REPLICATION`);
  if (row.bypassrls) reasons.push(`${who} has BYPASSRLS`);
  for (const role of row.memberOf) reasons.push(`${who} is a member of ${role}`);
  const granted = await db.rows<{ kind: string; n: number }>(sql`
    WITH me AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = SESSION_USER),
    sys AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')),
    entries AS (
      SELECT 'server parameters' AS kind, x.grantee
      FROM pg_catalog.pg_parameter_acl p, pg_catalog.aclexplode(p.paracl) AS x
      UNION ALL
      SELECT 'tablespaces', x.grantee FROM pg_catalog.pg_tablespace t, pg_catalog.aclexplode(t.spcacl) AS x
      WHERE x.grantee <> t.spcowner
      UNION ALL
      SELECT 'other databases', x.grantee FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) AS x
      WHERE d.datname <> pg_catalog.current_database() AND x.grantee <> d.datdba
      UNION ALL
      SELECT 'system functions', x.grantee FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) AS x
      WHERE p.pronamespace IN (SELECT oid FROM sys) AND x.grantee <> p.proowner
      UNION ALL
      SELECT 'system tables and views', x.grantee FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) AS x
      WHERE c.relnamespace IN (SELECT oid FROM sys) AND x.grantee <> c.relowner
      UNION ALL
      SELECT 'system types', x.grantee FROM pg_catalog.pg_type t, pg_catalog.aclexplode(t.typacl) AS x
      WHERE t.typnamespace IN (SELECT oid FROM sys) AND x.grantee <> t.typowner
      UNION ALL
      SELECT 'system schemas', x.grantee FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) AS x
      WHERE n.oid IN (SELECT oid FROM sys) AND x.grantee <> n.nspowner
      UNION ALL
      SELECT 'languages', x.grantee FROM pg_catalog.pg_language l, pg_catalog.aclexplode(l.lanacl) AS x
      WHERE x.grantee <> l.lanowner
      UNION ALL
      SELECT 'large objects', x.grantee FROM pg_catalog.pg_largeobject_metadata m, pg_catalog.aclexplode(m.lomacl) AS x
      WHERE x.grantee <> m.lomowner
      UNION ALL
      SELECT 'foreign-data wrappers', x.grantee FROM pg_catalog.pg_foreign_data_wrapper w, pg_catalog.aclexplode(w.fdwacl) AS x
      WHERE x.grantee <> w.fdwowner
      UNION ALL
      SELECT 'foreign servers', x.grantee FROM pg_catalog.pg_foreign_server f, pg_catalog.aclexplode(f.srvacl) AS x
      WHERE x.grantee <> f.srvowner
    )
    SELECT kind, pg_catalog.count(*)::pg_catalog.int4 AS n FROM entries
    WHERE grantee = (SELECT oid FROM me)
    GROUP BY kind ORDER BY kind`);
  for (const entry of granted) {
    reasons.push(`${who} has privileges granted on ${entry.kind} (${String(entry.n)})`);
  }
  return reasons;
}

/**
 * The restoring role's own settings (ALTER ROLE ... SET, for every database
 * and for each), as lines: a restore must not change them.
 */
async function roleSettings(db: Queryable): Promise<string[]> {
  const rows = await db.rows<{ line: string }>(sql`
    SELECT s.setdatabase::pg_catalog.text || ' ' || pg_catalog.array_to_string(s.setconfig, ',') AS line
    FROM pg_catalog.pg_db_role_setting s
    WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = SESSION_USER)`);
  return sorted(rows.map((r) => r.line));
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
  if (options.noPrivileges === true && manifest.objects.revokes.length > 0) {
    throw new BackupError(
      "privileges_needed",
      `--no-privileges drops the backup's REVOKEs and default privileges as well as its GRANTs, which would leave these open: ${manifest.objects.revokes.join("; ")}. Create the roles the backup names and restore without --no-privileges.`,
    );
  }
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
  // The whole archive is read and checked first, so a damaged file is refused
  // before the target is touched. It is then streamed to pg_restore's stdin:
  // no copy of the data is ever written.
  await checkArchive(file, manifest, signal);

  const space = await workspace(connection, env, "oculus-restore", options.tempDir ?? tmpdir());
  let session: Session | undefined;
  try {
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
    const problems = await restoreRoleProblems(session);
    if (problems.length > 0) {
      if (options.allowSuperuser !== true) {
        throw new BackupError(
          "superuser",
          `The role in OCULUS_DATABASE_URL is not a plain role (${problems.join("; ")}), so the backup's SQL could run with more than a database owner's powers. Restore as a dedicated role that has nothing else, made by an administrator: CREATE ROLE oculus_restore LOGIN PASSWORD '...'; GRANT oculus_restore TO <your admin role>; CREATE DATABASE oculus OWNER oculus_restore TEMPLATE template0; then put oculus_restore in OCULUS_DATABASE_URL. (On PostgreSQL 16 and newer, and on managed hosts where the admin isn't a superuser, the admin must be a member of oculus_restore to make it a database's owner; that grant gives the admin oculus_restore's rights, not the other way round, so oculus_restore stays plain.) --allow-superuser overrides this check, if you must.`,
        );
      }
      log(
        `WARNING: restoring as a role that is not plain (${problems.join("; ")}) because of --allow-superuser: everything in the backup runs with its powers. Only do this with a backup you made yourself.`,
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
    const roleBefore = { problems, settings: await roleSettings(session) };

    log(`Restoring a backup of PostgreSQL ${manifest.serverVersion} made ${manifest.createdAt}...`);
    const restored = await runTool(
      join(bin, executable("pg_restore")),
      [
        "--no-owner",
        ...(options.noPrivileges === true ? ["--no-privileges"] : []),
        "--single-transaction",
        "--exit-on-error",
        "--no-password",
        `--dbname=service=${SERVICE_NAME}`,
      ],
      space.env,
      signal,
      { feed: (input) => streamArchive(file, manifest, input, signal) },
      options.toolRunner,
    );
    let stoppedAfterCommit = false;
    if (restored.code !== 0) {
      // pg_restore ended badly or was stopped. Its one transaction either
      // committed or not: wait for its server session to end, then look,
      // before saying which.
      await sessionEnded(session, "oculus-restore");
      const after = await contentsOf(session);
      if (Object.keys(after).length === 0) {
        if (stopped(signal)) {
          throw interrupted(
            "pg_restore was stopped and its transaction rolled back; nothing was restored.",
          );
        }
        throw new BackupError(
          "restore_failed",
          `pg_restore failed (exit ${String(restored.code)}); nothing was restored (it runs in one transaction): ${redact(restored.stderr, connection.secrets) || "no message"}`,
        );
      }
      stoppedAfterCommit = stopped(signal);
      log(
        stoppedAfterCommit
          ? "A stop was asked for after pg_restore had committed; checking the restored database."
          : `pg_restore ended with exit ${String(restored.code)} after committing; checking the restored database.`,
      );
    }
    // pg_restore committed: the check runs to the end even if a stop is
    // asked for meanwhile, since it is what says whether the restore is good.
    options.onCommitted?.();
    log("Checking the restored database against the manifest...");
    await verify(session, manifest, options.noPrivileges === true, roleBefore);
    return { manifest, pending, stoppedAfterCommit };
  } finally {
    await session?.close().catch(() => undefined);
    await space.remove();
  }
}

const CHUNK_BYTES = 1024 * 1024;

/** Reads the archive's bytes in order, calling `each` per chunk; checks `signal` between chunks. */
async function readArchive(
  file: string,
  manifest: BackupManifest,
  signal: AbortSignal | undefined,
  each: (chunk: Buffer, last: boolean) => Promise<void>,
): Promise<void> {
  const source = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    let position = 0;
    while (position < manifest.dump.bytes) {
      if (stopped(signal)) throw interrupted("nothing was restored.");
      const want = Math.min(CHUNK_BYTES, manifest.dump.bytes - position);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await source.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      await each(buffer.subarray(0, bytesRead), position >= manifest.dump.bytes);
    }
    if (position !== manifest.dump.bytes) throw damaged(file);
  } finally {
    await source.close();
  }
}

function damaged(file: string): BackupError {
  return new BackupError(
    "bad_file",
    `${file} is damaged or changed: its archive does not match the SHA-256 in its manifest. Nothing was restored.`,
  );
}

/** Checks the archive's size and SHA-256 against the manifest, writing nothing. */
async function checkArchive(
  file: string,
  manifest: BackupManifest,
  signal: AbortSignal | undefined,
): Promise<void> {
  const hash = createHash("sha256");
  await readArchive(file, manifest, signal, (chunk) => {
    hash.update(chunk);
    return Promise.resolve();
  });
  if (hash.digest("hex") !== manifest.dump.sha256) throw damaged(file);
}

/**
 * Streams the archive to pg_restore, hashing it again as it goes. The last
 * chunk is held back until the whole archive's SHA-256 is known to match: if
 * the file changed since it was checked, pg_restore never gets its end, so it
 * can't reach COMMIT, and is killed.
 */
export async function streamArchive(
  file: string,
  manifest: BackupManifest,
  input: Writable,
  signal: AbortSignal | undefined,
): Promise<void> {
  const hash = createHash("sha256");
  await readArchive(file, manifest, signal, async (chunk, last) => {
    hash.update(chunk);
    if (last && hash.digest("hex") !== manifest.dump.sha256) throw damaged(file);
    await writeAll(input, chunk);
  });
}

/**
 * Waits (up to SESSION_WAIT_MS) until no session of this database with the given
 * application_name is left, so a stopped pg_restore's transaction has ended
 * on the server, one way or the other, before its outcome is read.
 */
/**
 * How long to wait for a stopped pg_restore's server session: less than the
 * command's 30-second grace period, so the answer comes before a forced exit.
 */
export const SESSION_WAIT_MS = 20_000;

async function sessionEnded(db: Queryable, applicationName: string): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_MS;
  for (;;) {
    const rows = await db.rows(sql`
      SELECT 1 FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database() AND application_name = ${applicationName}
        AND pid <> pg_catalog.pg_backend_pid()`);
    if (rows.length === 0) return;
    if (Date.now() > deadline) {
      throw new BackupError(
        "restore_failed",
        `pg_restore ended, but its session on the server is still open after ${String(SESSION_WAIT_MS / 1000)} seconds, so whether it committed is not yet known. A session whose client was killed during a long statement ends, and rolls back, only when that statement finishes; nothing is committed unless pg_restore had reached its COMMIT. Watch pg_stat_activity for application_name 'oculus-restore' and check the target database before using it.`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
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

/**
 * Checks the restored database against the manifest. Grants to the restoring
 * role are left out on both sides: with --no-owner it owns everything, and an
 * owner's rights are not grants. With --no-privileges grants aren't compared.
 */
async function verify(
  db: Queryable,
  manifest: BackupManifest,
  noPrivileges: boolean,
  roleBefore: { problems: string[]; settings: string[] },
): Promise<void> {
  const problems: string[] = [];
  // The archive's SQL runs as the restoring role: it must not have changed
  // that role's settings or given it anything (its password can't be seen;
  // use a dedicated role).
  const settingsAfter = await roleSettings(db);
  if (settingsAfter.join("\n") !== roleBefore.settings.join("\n")) {
    problems.push("the restoring role's own settings changed during the restore");
  }
  for (const reason of await restoreRoleProblems(db)) {
    if (!roleBefore.problems.includes(reason)) {
      problems.push(`the restoring role changed during the restore: ${reason}`);
    }
  }
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
  const [me] = await db.rows<{ grantee: string }>(
    sql`SELECT pg_catalog.quote_ident(CURRENT_USER::pg_catalog.text) AS grantee`,
  );
  const notMine = (line: string): boolean => grantee(line) !== (me?.grantee ?? "");
  const [settings] = await db.rows<{ n: number }>(sql`
    SELECT pg_catalog.count(*)::pg_catalog.int4 AS n FROM pg_catalog.pg_db_role_setting
    WHERE setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`);
  if ((settings?.n ?? 0) > 0) {
    problems.push(
      `the database has ${String(settings?.n)} database or role-in-database settings, which a restore never makes`,
    );
  }
  for (const kind of OBJECT_KINDS) {
    if ((kind === "grants" || kind === "revokes") && noPrivileges) continue;
    const expected =
      kind === "grants" ? manifest.objects.grants.filter(notMine) : manifest.objects[kind];
    const found = kind === "grants" ? objects.grants.filter(notMine) : objects[kind];
    problems.push(...listDifference(kind, expected, found));
  }
  if (problems.length > 0) {
    throw new BackupError(
      "verify_failed",
      `The restored database does not match the backup's manifest: ${problems.join("; ")}. Do not use it: drop it, create a new empty database and restore again from a good backup.`,
    );
  }
}
