/**
 * The one connection backup and restore use, given identically to the driver
 * and to pg_dump / pg_restore (D-064). Since S-017 every other URL-based
 * connection (migrations, cleanup, the app's pool) is resolved here too, so
 * the same TLS rule and the same accepted keywords hold everywhere.
 *
 * OCULUS_DATABASE_URL is parsed once, as libpq reads a URI. The result is
 * written two ways: a libpq service file and, for a password, a libpq
 * password file (both 0600, in a private 0700 directory, deleted afterwards)
 * for the tools, and field-by-field settings for the driver. Only keywords both can be given the same meaning are accepted, so
 * the checks (on the driver's connection) and the restore (pg_restore's) can
 * never reach different databases. Nothing here ever puts the URL or a value
 * from it into an error message, a command line or the tools' environment.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { trackPath } from "./backup-cleanup.js";
import { join } from "node:path";
import type { ConnectionSettings } from "./client.js";

export class ConnectionError extends Error {
  readonly code = "bad_url";
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

const URL_PROBLEM =
  "OCULUS_DATABASE_URL must be a postgresql:// URL naming the user, host and database, e.g. postgresql://user@host:5432/oculus (its value is not shown, since it may hold a password)";

/**
 * The URL keywords accepted. Others (hostaddr, options, target_session_attrs,
 * service, passfile, sslpassword, node-pg's own ssl=true, ...) are refused:
 * the driver can't be given the same meaning, or they could point the two
 * connections at different servers.
 */
const ACCEPTED = new Set([
  "host",
  "port",
  "dbname",
  "user",
  "password",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "connect_timeout",
  // Replaced by oculus-backup / oculus-restore; doesn't affect where to connect.
  "application_name",
]);

const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface ResolvedConnection {
  /** The service file's keywords and values, in order (never the password). */
  libpq: [string, string][];
  /** The password, for the tools' password file. */
  password?: string;
  /** The same connection for the driver. */
  node: ConnectionSettings;
  /**
   * The sslmode both use: `disable` (a socket, or a local host that didn't
   * ask for TLS), `verify-ca` or `verify-full`.
   */
  sslmode: "disable" | "verify-ca" | "verify-full";
  /** libpq needs `sslrootcert=system` (16 and newer) for the system's CAs. */
  needsSystemRoots: boolean;
  /** Text never to print: the URL and a password of 4 or more characters. */
  secrets: string[];
}

/**
 * Parses the URL. TLS (decided here; D-064):
 * - a Unix socket (host starting with `/`): no TLS;
 * - localhost, 127.0.0.1 or ::1 without sslmode, or with disable, allow or
 *   prefer: no TLS; with require or verify-*: as a remote host;
 * - any other host: always verified. No sslmode, `prefer` and `require`
 *   become `verify-full` (libpq's `require` would not check the
 *   certificate; the driver's would); `verify-ca` needs `sslrootcert`;
 *   `disable` and `allow` are refused (the password would cross the network
 *   in the clear). Without `sslrootcert`, both trust the system's CAs
 *   (`sslrootcert=system` for libpq, Node's default CAs for the driver).
 */
export function resolveConnection(
  connectionString: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ResolvedConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ConnectionError(`${URL_PROBLEM}.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new ConnectionError(`${URL_PROBLEM}.`);
  }
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      throw new ConnectionError(`${URL_PROBLEM}: it has a malformed %-escape.`);
    }
  };
  const given = new Map<string, string>();
  const set = (key: string, value: string): void => {
    // A service file holds one `key=value` per line, with trailing space
    // trimmed: a value it can't hold exactly is refused, not changed.
    if (/[\0\r\n]/.test(value) || value !== value.trim()) {
      throw new ConnectionError(
        `${URL_PROBLEM}: its ${key} has a line break or starts or ends with a space, which pg_dump can't be given safely. Put a password like that in ~/.pgpass.`,
      );
    }
    given.set(key, value);
  };
  if (url.hostname !== "") set("host", decode(url.hostname).replace(/^\[(.*)\]$/, "$1"));
  if (url.port !== "") set("port", url.port);
  if (url.username !== "") set("user", decode(url.username));
  if (url.password !== "") set("password", decode(url.password));
  const path = url.pathname.replace(/^\//, "");
  if (path !== "") set("dbname", decode(path));
  // libpq's URI query: `&`-separated `key=value`, %-decoded, `+` is a plus.
  // A later value wins, as in libpq (so `?host=/socket/dir` overrides).
  for (const part of url.search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    if (!ACCEPTED.has(key)) {
      const shown = /^[a-z_]{1,40}$/.test(key) ? `"${key}"` : "a parameter";
      throw new ConnectionError(
        `${URL_PROBLEM}: ${shown} in its query string is not accepted (accepted: ${[...ACCEPTED].join(", ")}).`,
      );
    }
    set(key, eq < 0 ? "" : decode(part.slice(eq + 1)));
  }

  const host = given.get("host") ?? "";
  const user = given.get("user") ?? "";
  const database = given.get("dbname") ?? "";
  if (host === "" || user === "" || database === "") {
    throw new ConnectionError(`${URL_PROBLEM}: it must name the host, the user and the database.`);
  }
  if (host.includes(",")) {
    throw new ConnectionError(`${URL_PROBLEM}: it names several hosts; name one.`);
  }
  const portText = given.get("port") ?? "5432";
  const port = Number(portText);
  if (!/^[0-9]{1,5}$/.test(portText) || port < 1 || port > 65535) {
    throw new ConnectionError(`${URL_PROBLEM}: its port is not a port number.`);
  }
  const timeoutText = given.get("connect_timeout");
  if (timeoutText !== undefined && !/^[0-9]{1,6}$/.test(timeoutText)) {
    throw new ConnectionError(`${URL_PROBLEM}: its connect_timeout is not a number of seconds.`);
  }

  const asked = given.get("sslmode");
  if (asked !== undefined && !SSL_MODES.has(asked)) {
    throw new ConnectionError(`${URL_PROBLEM}: its sslmode is not one libpq knows.`);
  }
  const socket = host.startsWith("/");
  const local = LOCAL_HOSTS.has(host);
  let sslmode: ResolvedConnection["sslmode"];
  if (socket) sslmode = "disable";
  else if (local && (asked === undefined || ["disable", "allow", "prefer"].includes(asked))) {
    sslmode = "disable";
  } else if (asked === "disable" || asked === "allow") {
    throw new ConnectionError(
      `${URL_PROBLEM}: sslmode=${asked} to a host that is not this machine would send the password unencrypted; Oculus always uses TLS there.`,
    );
  } else if (asked === "verify-ca") {
    const root = given.get("sslrootcert");
    if (root === undefined || root === "system") {
      throw new ConnectionError(
        `${URL_PROBLEM}: sslmode=verify-ca needs sslrootcert naming a CA certificate file (libpq refuses verify-ca with the system's CAs).`,
      );
    }
    sslmode = "verify-ca";
  } else sslmode = "verify-full";

  const password = given.get("password");
  const libpq: [string, string][] = [
    ["host", host],
    ["port", String(port)],
    ["dbname", database],
    ["user", user],
  ];
  if (timeoutText !== undefined) libpq.push(["connect_timeout", timeoutText]);
  libpq.push(["sslmode", sslmode]);

  const node: ConnectionSettings = { host, port, database, user, ssl: false };
  if (password !== undefined) node.password = password;
  if (timeoutText !== undefined) node.connectionTimeoutMillis = Number(timeoutText) * 1000;

  let needsSystemRoots = false;
  if (sslmode !== "disable") {
    const read = (key: string): string | undefined => {
      const file = given.get(key);
      if (file === undefined) return undefined;
      try {
        return readFile(file);
      } catch {
        throw new ConnectionError(`${URL_PROBLEM}: its ${key} file can't be read.`);
      }
    };
    const rootFile = given.get("sslrootcert");
    const ssl: Exclude<ConnectionSettings["ssl"], false> = { rejectUnauthorized: true };
    if (rootFile === undefined || rootFile === "system") {
      // The system's CAs for both.
      libpq.push(["sslrootcert", "system"]);
      needsSystemRoots = true;
    } else {
      ssl.ca = read("sslrootcert") ?? "";
      libpq.push(["sslrootcert", rootFile]);
    }
    if (given.has("sslcert") !== given.has("sslkey")) {
      throw new ConnectionError(`${URL_PROBLEM}: sslcert and sslkey go together.`);
    }
    const cert = read("sslcert");
    const key = read("sslkey");
    if (cert !== undefined && key !== undefined) {
      ssl.cert = cert;
      ssl.key = key;
      libpq.push(["sslcert", given.get("sslcert") ?? ""], ["sslkey", given.get("sslkey") ?? ""]);
    }
    if (sslmode === "verify-ca") ssl.checkServerIdentity = () => undefined;
    node.ssl = ssl;
  }

  for (const [key, value] of libpq) {
    if (Buffer.byteLength(`${key}=${value}`) > MAX_SERVICE_LINE) {
      throw new ConnectionError(
        `${URL_PROBLEM}: its ${key} is too long for a libpq service file (libpq refuses lines over about 1,000 bytes).`,
      );
    }
  }
  const secrets = [connectionString];
  if (password !== undefined && password.length >= 4) secrets.push(password);
  return {
    libpq,
    node,
    sslmode,
    needsSystemRoots,
    secrets,
    ...(password === undefined ? {} : { password }),
  };
}

/**
 * The longest `key=value` line written to the service file: libpq refuses
 * longer ones ("line too long in service file"; about 1,020 bytes in 16).
 * The password, which may be longer, goes in the password file instead.
 */
export const MAX_SERVICE_LINE = 1000;

/** A libpq password file matching any connection: `*:*:*:*:` and the escaped password. */
export function passwordFileText(password: string): string {
  return `*:*:*:*:${password.replaceAll("\\", "\\\\").replaceAll(":", "\\:")}\n`;
}

/** The name of the service in the temporary service file. */
export const SERVICE_NAME = "oculus_backup";

/** A libpq service file's text. */
export function serviceFileText(libpq: [string, string][], applicationName: string): string {
  const lines = [`[${SERVICE_NAME}]`, ...libpq.map(([k, v]) => `${k}=${v}`)];
  lines.push(`application_name=${applicationName}`);
  return `${lines.join("\n")}\n`;
}

/** libpq variables the tools keep: where the password comes from, as for the driver. */
const KEPT_PG_VARIABLES = new Set(["PGPASSWORD", "PGPASSFILE"]);

/**
 * The environment pg_dump and pg_restore get: the caller's, without any
 * OCULUS_ variable (the URL and, later, the secret key) and without libpq
 * variables that could change where or how they connect (PGHOST, PGSSLMODE,
 * PGSERVICE, PGOPTIONS, ...). When the URL has a password it is in our own
 * password file and every other PG variable goes; otherwise PGPASSWORD and
 * PGPASSFILE stay, as the driver reads them too.
 */
export function toolEnvironment(
  env: Record<string, string | undefined>,
  serviceFile: string,
  passwordFile?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("OCULUS_")) continue;
    if (key.startsWith("PG") && (passwordFile !== undefined || !KEPT_PG_VARIABLES.has(key))) {
      continue;
    }
    out[key] = value;
  }
  out.PGSERVICEFILE = serviceFile;
  // The URL's password, never PGPASSWORD (libpq would prefer it to the file).
  if (passwordFile !== undefined) out.PGPASSFILE = passwordFile;
  return out;
}

/**
 * A private 0700 directory holding the 0600 service file (and password file),
 * deleted by `remove`, or on exit if `remove` never runs (backup-cleanup.ts).
 */
export interface Workspace {
  dir: string;
  serviceFile: string;
  env: Record<string, string>;
  remove(): Promise<void>;
}

export async function workspace(
  connection: ResolvedConnection,
  env: Record<string, string | undefined>,
  applicationName: string,
  tempDir: string,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tempDir, "oculus-backup-"));
  const untrack = trackPath(dir);
  const remove = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
    untrack();
  };
  const write = async (path: string, text: string): Promise<void> => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  };
  try {
    const serviceFile = join(dir, "pg_service.conf");
    await write(serviceFile, serviceFileText(connection.libpq, applicationName));
    let passwordFile: string | undefined;
    if (connection.password !== undefined) {
      passwordFile = join(dir, "pgpass");
      await write(passwordFile, passwordFileText(connection.password));
    }
    return { dir, serviceFile, env: toolEnvironment(env, serviceFile, passwordFile), remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Hides the URL and its password (4 or more characters) in text a tool or driver printed. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[hidden]");
  }
  return out.trim();
}

/** The secrets of a URL that may not even parse (for the CLI's output filter). */
export function secretsOf(connectionString: string): string[] {
  try {
    return resolveConnection(connectionString, () => "").secrets;
  } catch {
    const secrets = [connectionString];
    try {
      const password = decodeURIComponent(new URL(connectionString).password);
      if (password.length >= 4) secrets.push(password);
    } catch {
      // Not a URL: only the whole string is known.
    }
    return secrets;
  }
}
