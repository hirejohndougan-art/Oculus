/**
 * The desktop database helper's parts (T-057, D-093): on a PostgreSQL the
 * person installed themselves, make Oculus's two roles and its database
 * with the `postgres` account's password typed once, keep the new roles'
 * passwords in the person's pgpass file, and say where they are in
 * `desktop.json`.
 *
 * - **Two roles** (D-067): an owner (`oculus_owner`) that owns the database
 *   and runs migrations, and the writer (`oculus_app`) the server connects
 *   as, given `grantWriterRole` and nothing else. Both are plain LOGIN
 *   roles with no memberships and no attributes, as `checkWriterConnection`
 *   requires of the writer.
 * - **Passwords** are 32 random bytes each, sent to the server only as
 *   SCRAM-SHA-256 verifiers (RFC 5802, RFC 7677, as PostgreSQL stores
 *   them), so the plain password never reaches the server or its log. They
 *   go in the pgpass file (libpq's format, mode 0600) and nowhere else.
 * - **Refuses** to change anything if the database or either role already
 *   exists, or if the server is older than PostgreSQL 15.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "./desktop.js";

export const DESKTOP_DATABASE = "oculus";
export const DESKTOP_OWNER_ROLE = "oculus_owner";
export const DESKTOP_WRITER_ROLE = "oculus_app";
const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier in PostgreSQL's stored form:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${String(SCRAM_ITERATIONS)}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** A new random password: URL- and pgpass-safe characters only. */
export function newRolePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** Where libpq looks for the password file. */
export function pgpassPath(platform: NodeJS.Platform, env: Env, home: string): string {
  const given = env.PGPASSFILE;
  if (given !== undefined && given !== "") return given;
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || appData === "") throw new Error("APPDATA is not set.");
    return join(appData, "postgresql", "pgpass.conf");
  }
  return join(home, ".pgpass");
}

/** One pgpass field, with `:` and `\` escaped as libpq reads them. */
export function pgpassField(value: string): string {
  if (/[\r\n]/.test(value)) throw new TypeError("A pgpass field can't hold a line break.");
  return value.replace(/[\\:]/g, (c) => `\\${c}`);
}

export interface PgpassEntry {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

/** The pgpass lines for `entries`, fields escaped. */
export function pgpassLines(entries: readonly PgpassEntry[]): string[] {
  return entries.map((e) =>
    [e.host, e.port, e.database, e.user, e.password].map(pgpassField).join(":"),
  );
}

/**
 * Replaces the pgpass file's bytes safely: the existing file is made 0600
 * first (POSIX), the new bytes go to a private temporary file that is then
 * renamed over it, so a crash never leaves it half written, and existing
 * lines are kept byte for byte (whatever their encoding).
 */
function rewritePgpass(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
  }
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Adds lines to the pgpass file (made 0600 if missing). libpq uses the
 * first match, so new lines go first. Returns the lines added.
 */
export function addPgpassEntries(file: string, entries: readonly PgpassEntry[]): string[] {
  const lines = pgpassLines(entries);
  const before = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  rewritePgpass(file, Buffer.concat([Buffer.from(`${lines.join("\n")}\n`, "utf8"), before]));
  return lines;
}

/** Removes exactly these lines (the ones a failed run added), keeping every other byte. */
export function removePgpassLines(file: string, lines: readonly string[]): void {
  if (!existsSync(file) || lines.length === 0) return;
  let bytes = readFileSync(file);
  for (const line of lines) {
    const needle = Buffer.from(`${line}\n`, "utf8");
    const at = bytes.indexOf(needle);
    if (at >= 0) bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + needle.length)]);
  }
  rewritePgpass(file, bytes);
}

/** The host, port and query of an address, with another user and database. */
export function addressFor(adminUrl: string, user: string, database: string): string {
  const url = new URL(adminUrl);
  url.username = encodeURIComponent(user);
  url.password = "";
  url.pathname = `/${encodeURIComponent(database)}`;
  // Query keys that would override the path's user or database (as libpq reads them).
  for (const key of ["password", "user", "dbname"]) url.searchParams.delete(key);
  return url.href;
}

/** The same address with a password, for this process only (never printed or saved). */
export function withPassword(address: string, password: string): string {
  const url = new URL(address);
  url.password = encodeURIComponent(password);
  return url.href;
}

/** The host and port a pgpass line must name to match `address`. */
export function pgpassTarget(address: string): { host: string; port: string } {
  const url = new URL(address);
  const socket = url.searchParams.get("host");
  const host = socket ?? (url.hostname === "" ? "localhost" : url.hostname);
  const port = url.searchParams.get("port") ?? (url.port === "" ? "5432" : url.port);
  return { host: host.replace(/^\[|\]$/g, ""), port };
}
