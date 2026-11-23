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
 * `public.oculus_migrations`), every table's row count and a hash of its rows,
 * the server and pg_dump versions, the time, and the archive's size and
 * SHA-256. The counts, hashes and migrations are read in the same snapshot
 * pg_dump dumps (`pg_export_snapshot()` and `pg_dump --snapshot`), so they
 * describe exactly what is in the archive.
 *
 * The backup is written to a temporary file (0600) next to the destination,
 * synced, then linked into place, so the destination either doesn't exist or
 * is complete; an existing file is never overwritten.
 *
 * Restore checks the file (trailer, manifest hash and shape, archive size and
 * SHA-256), that its migrations match the code's migration files, and that
 * the target database is empty, before pg_restore runs with `--no-owner
 * --single-transaction --exit-on-error`. Then it checks the restored
 * database's migrations, tables, row counts and row hashes against the
 * manifest.
 *
 * The database URL comes only from OCULUS_DATABASE_URL. It is never printed
 * and never put on a command line (where `ps` shows it): pg_dump and
 * pg_restore read the connection from a libpq service file (0600, in a
 * private 0700 directory, deleted afterwards).
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { link, lstat, mkdtemp, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { openSession, type Queryable, type Session } from "./client.js";
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
      | "target_not_empty"
      | "target_busy"
      | "restore_failed"
      | "verify_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupError";
  }
}

// ---------------------------------------------------------------------------
// The connection, for pg_dump and pg_restore, without the URL on a command line.

/**
 * libpq's connection keywords that may appear in the URL's query string
 * (https://www.postgresql.org/docs/current/libpq-connect.html). `service`,
 * `replication` and anything else are refused: the service is ours, and the
 * URL is a plain database connection.
 */
const LIBPQ_KEYWORDS = new Set([
  "host",
  "hostaddr",
  "port",
  "dbname",
  "user",
  "password",
  "passfile",
  "require_auth",
  "channel_binding",
  "connect_timeout",
  "client_encoding",
  "options",
  "application_name",
  "fallback_application_name",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "tcp_user_timeout",
  "gssencmode",
  "sslmode",
  "sslnegotiation",
  "sslcompression",
  "sslcert",
  "sslkey",
  "sslcertmode",
  "sslpassword",
  "sslrootcert",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "requirepeer",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "krbsrvname",
  "gsslib",
  "gssdelegation",
  "target_session_attrs",
  "load_balance_hosts",
]);

const URL_PROBLEM =
  "OCULUS_DATABASE_URL must be a postgresql:// URL, e.g. postgresql://user@host:5432/oculus (its value is not shown, since it may hold a password)";

/**
 * The libpq connection parameters in a postgresql:// URL, as libpq reads it:
 * user, password, host, port and database from the URL, then any libpq
 * keywords from the query string (a later one wins, so `?host=/socket/dir`
 * overrides the host). Values are percent-decoded. Errors never include the
 * URL or a value from it.
 */
export function connectionParameters(connectionString: string): Map<string, string> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new BackupError("bad_url", `${URL_PROBLEM}.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new BackupError("bad_url", `${URL_PROBLEM}.`);
  }
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      throw new BackupError("bad_url", `${URL_PROBLEM}: it has a malformed %-escape.`);
    }
  };
  const params = new Map<string, string>();
  const set = (key: string, value: string): void => {
    // A service file holds one `key=value` per line, with trailing space
    // trimmed: a value it can't hold exactly is refused, not changed.
    if (/[\0\r\n]/.test(value) || value !== value.trim()) {
      throw new BackupError(
        "bad_url",
        `${URL_PROBLEM}: its ${key} has a line break or starts or ends with a space, which pg_dump can't be given safely. Put a password like that in ~/.pgpass.`,
      );
    }
    params.set(key, value);
  };
  if (url.hostname !== "") set("host", decode(url.hostname).replace(/^\[(.*)\]$/, "$1"));
  if (url.port !== "") set("port", url.port);
  if (url.username !== "") set("user", decode(url.username));
  if (url.password !== "") set("password", decode(url.password));
  const path = url.pathname.replace(/^\//, "");
  if (path !== "") set("dbname", decode(path));
  // libpq's URI query: `&`-separated `key=value`, %-decoded, `+` is a plus.
  for (const part of url.search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    if (!LIBPQ_KEYWORDS.has(key)) {
      const shown = /^[a-z_]{1,40}$/.test(key) ? `"${key}"` : "a parameter";
      throw new BackupError(
        "bad_url",
        `${URL_PROBLEM}: ${shown} in its query string is not a libpq connection keyword pg_dump understands.`,
      );
    }
    set(key, eq < 0 ? "" : decode(part.slice(eq + 1)));
  }
  return params;
}

/** The name of the service in the temporary service file. */
export const SERVICE_NAME = "oculus_backup";

/** A libpq service file's text for these parameters. */
export function serviceFileText(params: Map<string, string>, applicationName: string): string {
  const lines = [`[${SERVICE_NAME}]`];
  for (const [key, value] of params) lines.push(`${key}=${value}`);
  if (!params.has("application_name")) lines.push(`fallback_application_name=${applicationName}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The environment pg_dump and pg_restore get: the caller's (so PGPASSWORD,
 * ~/.pgpass, PGSSLMODE and the like work as they do for the app), without any
 * OCULUS_ variable (the URL and, later, the secret key), with the service
 * file in place of any service the caller set.
 */
export function toolEnvironment(
  env: Record<string, string | undefined>,
  serviceFile: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("OCULUS_")) continue;
    if (key === "PGSERVICE" || key === "PGSERVICEFILE") continue;
    out[key] = value;
  }
  out.PGSERVICEFILE = serviceFile;
  return out;
}

/** A private 0700 directory holding the 0600 service file, deleted by `remove`. */
interface Workspace {
  dir: string;
  serviceFile: string;
  env: Record<string, string>;
  remove(): Promise<void>;
}

async function workspace(
  connectionString: string,
  env: Record<string, string | undefined>,
  applicationName: string,
): Promise<Workspace> {
  const params = connectionParameters(connectionString);
  const dir = await mkdtemp(join(tmpdir(), "oculus-backup-"));
  const remove = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    const serviceFile = join(dir, "pg_service.conf");
    const handle = await open(serviceFile, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serviceFileText(params, applicationName));
    } finally {
      await handle.close();
    }
    return { dir, serviceFile, env: toolEnvironment(env, serviceFile), remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Removes every secret in `secrets` from text a tool printed. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 1) out = out.split(secret).join("[hidden]");
  }
  return out.trim();
}

/**
 * Wraps two output functions so nothing they print can show the URL or its
 * password, whatever a driver or tool put in a message.
 */
export function hideSecrets(
  connectionString: string,
  out: (line: string) => void,
  err: (line: string) => void,
): { out: (line: string) => void; err: (line: string) => void } {
  const secrets = secretsOf(connectionString);
  return {
    out: (line) => {
      out(redact(line, secrets));
    },
    err: (line) => {
      err(redact(line, secrets));
    },
  };
}

function secretsOf(connectionString: string): string[] {
  const secrets = [connectionString];
  try {
    const params = connectionParameters(connectionString);
    for (const key of ["password", "sslpassword"]) {
      const value = params.get(key);
      if (value !== undefined && value !== "") secrets.push(value);
    }
  } catch {
    // An unreadable URL was refused before any tool ran.
  }
  return secrets.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Finding pg_dump and pg_restore.

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

// ---------------------------------------------------------------------------
// The manifest and the file format.

export const BACKUP_FORMAT = "oculus-backup";
export const BACKUP_FORMAT_VERSION = 1;
/** The last 16 bytes of every backup file. */
export const TRAILER_MAGIC = "OCULUS-BACKUP-01";
/** 8 bytes of manifest length, 32 of its SHA-256, 16 of magic. */
export const TRAILER_BYTES = 8 + 32 + 16;
/** A manifest is small; anything larger is not one. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface TableSummary {
  /** `schema.table`. */
  name: string;
  /** Row count, as text (int8). */
  rows: string;
  /**
   * The sum of the first 64 bits of each row's SHA-256 (of the row as text),
   * as text: the same for the same rows in any order. A check against
   * corruption and lost rows, not a signature.
   */
  rowsHash: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  serverVersion: string;
  serverVersionNum: number;
  pgDumpVersion: string;
  migrations: AppliedMigration[];
  tables: TableSummary[];
  dump: { bytes: number; sha256: string };
}

const HEX64 = /^[0-9a-f]{64}$/;
const INTEGER_TEXT = /^-?[0-9]{1,40}$/;

/** Checks a parsed manifest's shape exactly; returns a description of the first problem. */
export function manifestProblem(value: unknown): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const exactKeys = (v: Record<string, unknown>, keys: string[]): boolean =>
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
  const { migrations, tables, dump } = value;
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
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") throw new BackupError("not_found", `There is no file at ${path}.`);
    throw new BackupError("not_found", `Could not open ${path} (${String(code)}).`);
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
    if (length <= 0n || length > BigInt(MAX_MANIFEST_BYTES)) {
      throw new BackupError("bad_file", `${notBackup}: the manifest length is impossible.`);
    }
    const manifestBytes = Number(length);
    if (manifestBytes > stat.size - TRAILER_BYTES) {
      throw new BackupError("bad_file", `${notBackup}: the manifest length is impossible.`);
    }
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

/**
 * Every table outside the system schemas, with its row count and row hash.
 * The count runs per table through `query_to_xml`, with the table named by
 * `format('%I.%I')` from the catalog, so no identifier is ever built in
 * JavaScript (D-050).
 */
export async function tableSummaries(db: Queryable): Promise<TableSummary[]> {
  return db.rows<TableSummary>(sql`
    SELECT s.name, (pg_catalog.xpath('/row/n/text()', s.x))[1]::pg_catalog.text AS rows,
           (pg_catalog.xpath('/row/h/text()', s.x))[1]::pg_catalog.text AS "rowsHash"
    FROM (
      SELECT n.nspname || '.' || c.relname AS name,
             pg_catalog.query_to_xml(pg_catalog.format(
               'SELECT pg_catalog.count(*) AS n, COALESCE(pg_catalog.sum((''x'' || pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(t::pg_catalog.text, ''UTF8'')), ''hex''), 1, 16))::pg_catalog.bit(64)::pg_catalog.int8::pg_catalog.numeric), 0) AS h FROM %I.%I AS t',
               n.nspname, c.relname), false, true, '') AS x
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
    ) AS s
    ORDER BY s.name COLLATE "C"`);
}

async function appliedMigrations(db: Queryable): Promise<AppliedMigration[] | undefined> {
  const [exists] = await db.rows<{ exists: boolean }>(
    sql`SELECT pg_catalog.to_regclass('public.oculus_migrations') IS NOT NULL AS exists`,
  );
  if (!exists?.exists) return undefined;
  return db.rows<AppliedMigration>(
    sql`SELECT name, sha256 FROM public.oculus_migrations ORDER BY name COLLATE "C"`,
  );
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

/** What a database holds that would make it not empty, as counts by kind. */
export async function contentsOf(db: Queryable): Promise<Record<string, number>> {
  const [row] = await db.rows<Record<string, number>>(sql`
    SELECT
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_namespace n
        WHERE n.nspname NOT IN ('public', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%') AS schemas,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public') AS types,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_extension
        WHERE extname <> 'plpgsql') AS extensions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_largeobject_metadata) AS large_objects,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_event_trigger) AS event_triggers`);
  return Object.fromEntries(Object.entries(row ?? {}).filter(([, count]) => count > 0));
}

// ---------------------------------------------------------------------------
// Backup.

export interface BackupOptions {
  connectionString: string;
  /** Where to write the backup. Must not exist. */
  file: string;
  /** The environment for PG_BIN, PATH and libpq's own variables (default: process.env). */
  env?: Record<string, string | undefined>;
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
    if ((error as { code?: unknown }).code === "ENOENT") return;
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
 * Moves the finished temporary file to `file` without overwriting anything:
 * a hard link fails if `file` exists. Where hard links aren't supported, it
 * checks and renames.
 */
async function publish(temp: string, file: string): Promise<void> {
  try {
    await link(temp, file);
    await unlink(temp);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EEXIST") {
      throw new BackupError("exists", `${file} appeared while the backup ran; it was left alone.`);
    }
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
      throw error;
    }
    await mustNotExist(file);
    await rename(temp, file);
  }
  await syncDirectory(dirname(file));
}

/** Writes a backup of the whole database to `file` (0600). */
export async function backup(options: BackupOptions): Promise<BackupResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const file = resolve(options.file);
  const secrets = secretsOf(options.connectionString);
  connectionParameters(options.connectionString);
  await mustNotExist(file);
  const bin = await findTools(env, ["pg_dump"]);
  const pgDump = await toolVersion(bin, "pg_dump");

  let session: Session;
  try {
    session = await openSession(options.connectionString, "oculus-backup");
  } catch (error) {
    throw new BackupError(
      "dump_failed",
      `Could not connect to the database: ${redact((error as Error).message, secrets)}`,
    );
  }
  const space = await workspace(options.connectionString, env, "oculus-backup").catch(
    async (error: unknown) => {
      await session.close().catch(() => undefined);
      throw error;
    },
  );
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.partial`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    const server = await serverVersion(session);
    if (pgDump.major < Math.floor(server.num / 10000)) {
      throw new BackupError(
        "tools_too_old",
        `pg_dump ${String(pgDump.major)} can't back up PostgreSQL ${server.text}: set PG_BIN to the bin directory of PostgreSQL ${String(Math.floor(server.num / 10000))} or newer.`,
      );
    }
    // One snapshot for the manifest and pg_dump.
    await session.control("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const migrations = await appliedMigrations(session);
    if (migrations === undefined) {
      throw new BackupError(
        "not_oculus",
        "This database has no public.oculus_migrations table, so it is not an Oculus database (run npm run db:migrate first).",
      );
    }
    const tables = await tableSummaries(session);
    const [snapshot] = await session.rows<{ id: string }>(
      sql`SELECT pg_catalog.pg_export_snapshot() AS id`,
    );
    if (snapshot === undefined) throw new Error("No snapshot was exported.");

    try {
      handle = await open(temp, "wx", 0o600);
      await handle.chmod(0o600);
    } catch (error) {
      throw new BackupError(
        "write_failed",
        `Could not create a file in ${dirname(file)} (${errorCode(error)}).`,
      );
    }
    log(`Backing up PostgreSQL ${server.text} with ${pgDump.text}...`);
    const dump = await runDump(
      join(bin, "pg_dump"),
      [
        "--format=custom",
        "--no-password",
        `--snapshot=${snapshot.id}`,
        `--dbname=service=${SERVICE_NAME}`,
      ],
      space.env,
      handle,
      secrets,
    );
    await session.control("COMMIT");

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      serverVersion: server.text,
      serverVersionNum: server.num,
      pgDumpVersion: pgDump.text,
      migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
      tables: tables.map(({ name, rows, rowsHash }) => ({ name, rows, rowsHash })),
      dump,
    };
    await handle.write(manifestAndTrailer(manifest));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await publish(temp, file);
    published = true;
    return { file, manifest };
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temp, { force: true }).catch(() => undefined);
    await session.close().catch(() => undefined);
    await space.remove();
  }
}

/** An error's code (like ENOSPC) for a message, never its text. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown error";
}

/** Runs pg_dump, streaming its archive into `handle`; returns the archive's size and SHA-256. */
async function runDump(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  handle: FileHandle,
  secrets: readonly string[],
): Promise<{ bytes: number; sha256: string }> {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise(code);
    });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;
      await handle.write(chunk);
    }
  } catch (error) {
    child.kill("SIGTERM");
    await exited.catch(() => undefined);
    throw new BackupError("write_failed", `Could not write the backup (${errorCode(error)}).`);
  }
  let code: number | null;
  try {
    code = await exited;
  } catch (error) {
    throw new BackupError("dump_failed", `pg_dump did not start: ${(error as Error).message}`);
  }
  if (code !== 0 || bytes === 0) {
    throw new BackupError(
      "dump_failed",
      `pg_dump failed (exit ${String(code)}): ${redact(stderr, secrets) || "no message"}`,
    );
  }
  return { bytes, sha256: hash.digest("hex") };
}

// ---------------------------------------------------------------------------
// Restore.

export interface RestoreOptions {
  connectionString: string;
  /** The backup file. */
  file: string;
  /** Default: packages/db/migrations. */
  migrationsDir?: string;
  env?: Record<string, string | undefined>;
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
  const file = resolve(options.file);
  const secrets = secretsOf(options.connectionString);
  connectionParameters(options.connectionString);
  const manifest = await readManifest(file);
  const pending = compareMigrations(
    manifest.migrations,
    await readMigrations(options.migrationsDir ?? defaultMigrationsDir()),
  );
  const bin = await findTools(env, ["pg_restore"]);
  const pgRestore = await toolVersion(bin, "pg_restore");
  const dumpMajor = toolMajor(manifest.pgDumpVersion) ?? Number.MAX_SAFE_INTEGER;
  if (pgRestore.major < dumpMajor) {
    throw new BackupError(
      "tools_too_old",
      `This backup was made by pg_dump ${String(dumpMajor)}; pg_restore ${String(pgRestore.major)} can't read it. Set PG_BIN to the bin directory of PostgreSQL ${String(dumpMajor)} or newer.`,
    );
  }

  let session: Session;
  try {
    session = await openSession(options.connectionString, "oculus-restore");
  } catch (error) {
    throw new BackupError(
      "restore_failed",
      `Could not connect to the database: ${redact((error as Error).message, secrets)}`,
    );
  }
  let space: Workspace | undefined;
  try {
    const server = await serverVersion(session);
    if (pgRestore.major < Math.floor(server.num / 10000)) {
      throw new BackupError(
        "tools_too_old",
        `pg_restore ${String(pgRestore.major)} is older than PostgreSQL ${server.text}: set PG_BIN to the bin directory of PostgreSQL ${String(Math.floor(server.num / 10000))} or newer.`,
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
        .map(([kind, count]) => `${String(count)} ${kind.replace("_", " ")}`)
        .join(", ");
      throw new BackupError(
        "target_not_empty",
        `The target database is not empty (${found}); a restore never overwrites a database. Create a new empty one (CREATE DATABASE ... TEMPLATE template0) and restore into that.`,
      );
    }

    space = await workspace(options.connectionString, env, "oculus-restore");
    const archive = join(space.dir, "archive.dump");
    await extractArchive(file, archive, manifest);

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
    );
    if (restored.code !== 0) {
      throw new BackupError(
        "restore_failed",
        `pg_restore failed (exit ${String(restored.code)}); nothing was restored (it runs in one transaction): ${redact(restored.stderr, secrets) || "no message"}`,
      );
    }
    await verify(session, manifest);
    return { manifest, pending };
  } finally {
    await space?.remove();
    await session.close().catch(() => undefined);
  }
}

/** Copies the archive out of the backup file, checking its size and SHA-256 against the manifest. */
async function extractArchive(
  file: string,
  archive: string,
  manifest: BackupManifest,
): Promise<void> {
  const source = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
    await source.close();
  }
}

function runTool(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: null, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stderr });
    });
  });
}

/** Checks the restored database against the manifest: migrations, tables, rows. */
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
  if (problems.length > 0) {
    throw new BackupError(
      "verify_failed",
      `The restored database does not match the backup's manifest: ${problems.join("; ")}. Do not use it: drop it, create a new empty database and restore again from a good backup.`,
    );
  }
}
