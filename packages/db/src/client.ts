/**
 * The only file that calls the `pg` driver's `query` (D-050, enforced by lint).
 *
 * Every query sent from here is an `Sql` value made by the `sql` tag and goes
 * through the extended protocol (text and parameters sent separately, one
 * statement only). The two exceptions are internal and not exported from the
 * package: `runScript`, which runs a whole migration file from
 * `packages/db/migrations` for the runner, and `createDatabase` /
 * `dropDatabase`, which take only names matching `DATABASE_NAME`.
 *
 * Type parsers are set explicitly (D-050): `int8` and `numeric` come back as
 * strings (never lossy numbers), and `date`, `timestamp`, `timestamptz` and
 * `interval` come back as the server's text, never as JavaScript Dates, so a
 * day stays the day D-008 stored. Sessions use UTC, ISO dates and ISO 8601
 * intervals so that text is the same on every server.
 */
import pg from "pg";
import { isSql, type Sql } from "./sql.js";

/** A row as `pg` returns it. */
export type Row = object;

export interface Queryable {
  /** Runs a query and returns its rows. */
  rows<R extends Row = Row>(query: Sql): Promise<R[]>;
  /** Runs a statement and returns the number of rows it touched. */
  execute(query: Sql): Promise<number>;
}

export interface Database extends Queryable {
  /**
   * Runs `work` in one Read Committed transaction (whatever the server's
   * default): committed if it resolves, rolled back if it throws.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Closes every connection. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** Most connections in the pool (default 10). */
  max?: number;
  /** Name shown in pg_stat_activity. */
  applicationName?: string;
}

const OID = {
  int8: 20,
  numeric: 1700,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  textArray: 1009,
  int8Array: 1016,
  numericArray: 1231,
  dateArray: 1182,
  timestampArray: 1115,
  timestamptzArray: 1185,
  intervalArray: 1187,
} as const;

const asText = (value: string): string => value;
/** pg's own parsers, looked up by plain OID number. */
const builtinParser = pg.types.getTypeParser as (
  oid: number,
  format: "text" | "binary",
) => (value: string) => unknown;
const textArrayParser = builtinParser(OID.textArray, "text");

const TEXT_TYPES = new Set<number>([
  OID.int8,
  OID.numeric,
  OID.date,
  OID.timestamp,
  OID.timestamptz,
  OID.interval,
]);
const TEXT_ARRAY_TYPES = new Set<number>([
  OID.int8Array,
  OID.numericArray,
  OID.dateArray,
  OID.timestampArray,
  OID.timestamptzArray,
  OID.intervalArray,
]);

/** The type parsers every Oculus connection uses (not pg's global ones). */
export const typeParsers = {
  getTypeParser(oid: number, format?: "text" | "binary"): (value: string) => unknown {
    if (format !== "binary") {
      if (TEXT_TYPES.has(oid)) return asText;
      if (TEXT_ARRAY_TYPES.has(oid)) return textArrayParser;
    }
    return builtinParser(oid, format ?? "text");
  },
};

/** Server settings for every session (the server's own text formats). */
export const SESSION_OPTIONS = "-c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=iso_8601";

/**
 * A connection given field by field rather than as a URL: what backup and
 * restore use, so the driver connects to exactly what pg_dump and pg_restore
 * are told (D-064). TLS options are Node's (`tls.connect`).
 */
export interface ConnectionSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Absent: PGPASSWORD or the password file, as libpq does. */
  password?: string;
  ssl:
    | false
    | {
        rejectUnauthorized: true;
        ca?: string;
        cert?: string;
        key?: string;
        /** Only for verify-ca: the chain is checked, the host name is not. */
        checkServerIdentity?: () => undefined;
      };
  connectionTimeoutMillis?: number;
}

/** A connection URL (from the environment, never the repo) or settings. */
export type ConnectionTarget = string | ConnectionSettings;

export function clientConfig(target: ConnectionTarget): pg.ClientConfig {
  const common = { types: typeParsers, options: SESSION_OPTIONS };
  return typeof target === "string"
    ? { connectionString: target, ...common }
    : { ...target, ...common };
}

/**
 * Always the extended protocol, even with no values: pg would otherwise send a
 * value-less query with the simple protocol, which runs several statements.
 * (`queryMode` is in pg 8.x but missing from @types/pg.)
 */
function checked(query: Sql): pg.QueryConfig {
  if (!isSql(query)) throw new TypeError("Queries must be made with the sql tag.");
  const config: pg.QueryConfig & { queryMode: "extended" } = {
    text: query.text,
    values: query.values,
    queryMode: "extended",
  };
  return config;
}

function queryable(target: pg.Pool | pg.PoolClient | pg.Client): Queryable {
  return {
    async rows<R extends Row = Row>(query: Sql): Promise<R[]> {
      const result = await target.query(checked(query));
      return result.rows as R[];
    },
    async execute(query: Sql): Promise<number> {
      const result = await target.query(checked(query));
      return result.rowCount ?? 0;
    },
  };
}

/**
 * A transaction's connection was lost while it ran: nothing of it is
 * committed unless the server got the COMMIT (then it may be). The cause is
 * the driver's error, for the server log only. `code` is SQLSTATE 08006
 * (connection_failure), so callers that map database errors by code can.
 */
export class ConnectionLostError extends Error {
  readonly code = "08006";
  constructor(cause: unknown) {
    super("The database connection was lost during a transaction.", { cause });
    this.name = "ConnectionLostError";
  }
}

/** Opens a connection pool. The connection string comes from the environment, never the repo. */
export function openDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    ...clientConfig(connectionString),
    max: options.max ?? 10,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
  // An idle connection that fails (a server restart) is dropped by the pool;
  // without a listener the error would crash the process.
  pool.on("error", () => undefined);
  const base = queryable(pool);
  return {
    ...base,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      // Changed by the listener, so kept in an object the compiler doesn't narrow.
      const state: { broken: boolean; lost: unknown } = { broken: false, lost: undefined };
      // A checked-out client has no listener of the pool's: without this, a
      // connection that dies while `work` awaits something else (the server
      // ended it, the network dropped) emits an 'error' nobody handles,
      // which crashes the process. The transaction then fails cleanly and
      // the client is thrown away.
      const onError = (error: unknown): void => {
        state.broken = true;
        state.lost ??= error;
      };
      client.on("error", onError);
      try {
        // Explicitly, whatever the server's default_transaction_isolation:
        // the identifier writes' locking needs a new snapshot per statement
        // (D-061), and every caller expects Read Committed's behaviour.
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await work(queryable(client));
        await client.query("COMMIT");
        if (state.lost !== undefined) throw new ConnectionLostError(state.lost);
        return result;
      } catch (error) {
        if (!state.broken) {
          try {
            await client.query("ROLLBACK");
          } catch {
            state.broken = true;
          }
        }
        if (state.lost !== undefined && !(error instanceof ConnectionLostError)) {
          throw new ConnectionLostError(state.lost);
        }
        throw error;
      } finally {
        client.removeListener("error", onError);
        client.release(state.broken);
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/** A single dedicated connection, for the migration runner (it holds a session lock). */
export interface Session extends Queryable {
  close(): Promise<void>;
  /**
   * Runs `BEGIN` (or the backup's read-only snapshot `BEGIN`), `COMMIT`,
   * `ROLLBACK` or one of the runner's savepoint statements.
   */
  control(statement: ControlStatement): Promise<void>;
  /** @internal Runs a whole migration file (several statements) with the simple protocol. */
  runScript(text: string): Promise<void>;
  /**
   * The transaction state the server reported after the last statement
   * (ReadyForQuery): outside a transaction block, inside one, inside a failed
   * one, or not known (no answer yet, or the connection is gone).
   */
  transactionState(): "idle" | "in_block" | "failed_block" | "unknown";
}

/** The fixed transaction-control statements a session may send. */
export type ControlStatement =
  | "BEGIN"
  | "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"
  | "COMMIT"
  | "ROLLBACK"
  | "SAVEPOINT oculus_migration"
  | "ROLLBACK TO SAVEPOINT oculus_migration";

export async function openSession(
  connectionString: ConnectionTarget,
  applicationName = "oculus",
): Promise<Session> {
  const client = new pg.Client({
    ...clientConfig(connectionString),
    application_name: applicationName,
  });
  // Errors after connecting (the server going away) surface on the next query.
  client.on("error", () => undefined);
  await client.connect();
  return {
    ...queryable(client),
    async close() {
      await client.end();
    },
    async control(statement) {
      await client.query(statement);
    },
    async runScript(text: string) {
      try {
        await client.query(text);
      } catch (error) {
        // pg rejects on the error before the server's ReadyForQuery arrives,
        // so the transaction state would still be the one from before the
        // file. An empty query (allowed even in a failed block) waits for it.
        await client.query("").catch(() => undefined);
        throw error;
      }
    },
    transactionState() {
      const status = client.getTransactionStatus();
      return status === "I"
        ? "idle"
        : status === "T"
          ? "in_block"
          : status === "E"
            ? "failed_block"
            : "unknown";
    },
  };
}

/** Database names `createDatabase` and `dropDatabase` accept: plain lower-case names. */
export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function databaseIdentifier(name: string): string {
  if (typeof name !== "string" || !DATABASE_NAME.test(name)) {
    throw new TypeError("Database names must match /^[a-z][a-z0-9_]{0,62}$/.");
  }
  return `"${name}"`;
}

/**
 * Creates an empty database (CREATE DATABASE can't take a parameter or run in
 * a transaction, so the name is checked against `DATABASE_NAME` and quoted).
 */
export async function createDatabase(adminConnectionString: string, name: string): Promise<void> {
  const statement = `CREATE DATABASE ${databaseIdentifier(name)} TEMPLATE template0 ENCODING 'UTF8'`;
  const client = new pg.Client(clientConfig(adminConnectionString));
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** Drops a database, closing any connections still open to it. */
export async function dropDatabase(adminConnectionString: string, name: string): Promise<void> {
  const statement = `DROP DATABASE IF EXISTS ${databaseIdentifier(name)} WITH (FORCE)`;
  const client = new pg.Client(clientConfig(adminConnectionString));
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** The same server URL with another database name. */
export function withDatabaseName(connectionString: string, name: string): string {
  databaseIdentifier(name);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}
