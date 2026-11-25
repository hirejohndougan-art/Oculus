/**
 * The staff pool's time limits (S-063): the writer pool that the admin's
 * server (`npm run admin`) and the desktop launcher open for staff work,
 * sign-in and the background jobs.
 *
 * Without them, one transaction stuck holding a row or advisory lock (a psql
 * session, an attach whose file call hangs) made every staff request queue
 * behind it, each holding one of the pool's connections, and then every
 * later request wait in the pool's queue with no end: an outage until the
 * holder ended (Phase 2 data review, M3). Now:
 *
 * - a request waits at most `STAFF_POOL_WAIT_MS` for a free connection;
 * - a statement waits at most `STAFF_LOCK_TIMEOUT_MS` for a lock (55P03);
 * - a statement runs at most `STAFF_STATEMENT_TIMEOUT_MS` (57014); work
 *   that sets its own shorter limit (searches, public reads) keeps it;
 * - a transaction left idle by this process is ended by the server after
 *   `STAFF_IDLE_IN_TRANSACTION_MS`, which frees its locks;
 * - the client gives up on a server that stops answering after
 *   `STAFF_QUERY_TIMEOUT_MS`, above the statement limit (client.ts).
 *
 * Each of these is answered `503` (`busy` or `timeout`), never a stack or a
 * hang. The limits are sent when each connection opens, so they hold on any
 * install whatever the role's settings; a role or server setting can't
 * loosen them for these connections.
 */
import type { DatabaseOptions } from "@oculus/db";

/** Connections in the staff pool. */
export const STAFF_POOL_SIZE = 10;
/** Longest wait for a free connection, then `503 busy`. */
export const STAFF_POOL_WAIT_MS = 10_000;
/** Longest wait for a lock, then `503 timeout`. Under the 30 s handler limit (server.ts). */
export const STAFF_LOCK_TIMEOUT_MS = 10_000;
/** Longest single statement. Well above any staff request's own work. */
export const STAFF_STATEMENT_TIMEOUT_MS = 120_000;
/**
 * Longest time this process leaves a transaction open and idle. Far above
 * any transaction's own work: no transaction waits on an upload's body
 * (files.ts places copies outside them).
 */
export const STAFF_IDLE_IN_TRANSACTION_MS = 10 * 60_000;
/** The client's own limit for an answer (pg's `query_timeout`), above the statement limit. */
export const STAFF_QUERY_TIMEOUT_MS = STAFF_STATEMENT_TIMEOUT_MS + 30_000;

/** The staff pool's options, with the program's name for `pg_stat_activity`. */
export function staffPoolOptions(applicationName: string): DatabaseOptions {
  return {
    applicationName,
    max: STAFF_POOL_SIZE,
    connectionTimeoutMillis: STAFF_POOL_WAIT_MS,
    lockTimeoutMillis: STAFF_LOCK_TIMEOUT_MS,
    statementTimeoutMillis: STAFF_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMillis: STAFF_IDLE_IN_TRANSACTION_MS,
    queryTimeoutMillis: STAFF_QUERY_TIMEOUT_MS,
  };
}
