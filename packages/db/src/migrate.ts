/**
 * The migration runner (D-050, D-057).
 *
 * Migrations are plain SQL files in `packages/db/migrations`, named
 * `NNNN_short_name.sql`, applied forwards only, in name order. The runner:
 * - checks the server is PostgreSQL 15 or newer (D-049), warning above the
 *   newest major CI tests;
 * - takes a session-level advisory lock on a connection of its own, which
 *   never runs a migration file, so two runs never migrate at once (the
 *   second waits, then finds nothing left to do) and no file can release it;
 *   files run on a second connection;
 * - checks every applied file is still there, unedited (SHA-256 of its bytes),
 *   and that no new file sorts before an applied one, refusing to run at all
 *   otherwise;
 * - runs each pending file in its own transaction and records its name and
 *   hash in `oculus_migrations` in that same transaction. The first file
 *   creates that table, so a fresh database is migrated like any other.
 *
 * A file that ends the runner's transaction itself (COMMIT, END, ROLLBACK,
 * COMMIT AND CHAIN, PREPARE TRANSACTION) is refused as `transaction_ended`,
 * whether it then succeeds or fails: a file is recorded, or reported as plain
 * `failed`, only if the session is still in the runner's own transaction (same
 * transaction ID, in progress, inside a block; after a failure, the runner's
 * savepoint must still be there) and the runner's own COMMIT or ROLLBACK is
 * what ends it. Before recording a file the runner runs its deferred triggers
 * and constraints (SET CONSTRAINTS ALL IMMEDIATE) and checks its row is there;
 * after the COMMIT it checks the row once more, and if a trigger that ran at
 * COMMIT removed it the run stops as `applied_not_recorded`.
 * Before each file, before its COMMIT, after it and after a failure the
 * runner checks that its lock connection is alive and still holds the lock;
 * if not, the run stops as `lock_lost`. The lock connection turns off
 * idle_session_timeout, which would otherwise end it while a long file runs. Statements that can't run in a transaction
 * (CREATE INDEX CONCURRENTLY) are not supported. Right after each file, inside
 * its transaction, and again after it, the session is reset (RESET ALL, RESET
 * ROLE, RESET SESSION AUTHORIZATION, DISCARD TEMP, DEALLOCATE ALL), and the
 * runner names its table and functions with their schemas, so a file can't
 * change what the next file or the runner's own statements do (D-057).
 *
 * Time limits inside a file's transaction (S-065): `statement_timeout` and,
 * from PostgreSQL 17, `transaction_timeout` are turned off for that
 * transaction only (`set_config(…, true)`), so a role's or database's limit
 * can't cancel a long but healthy migration (a table rewrite on a large
 * catalog). `lock_timeout` is set to `fileLockTimeoutMs` (default 10 s)
 * instead, so a file that needs a table lock a long reader holds (during an
 * in-place update the old server keeps serving) gives up quickly rather than
 * making every other query queue behind it. Such a file is rolled back and
 * tried again, up to `fileLockAttempts` times (default 5) with a growing
 * pause; after the last it stops as `file_lock_timeout`, nothing of it
 * applied. Migrations must stay safe for the previous release to keep
 * running on (D-122).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSession, type Session } from "./client.js";
import { sql } from "./sql.js";

/** Oldest and newest PostgreSQL majors Oculus supports and CI tests (D-049). */
export const OLDEST_MAJOR = 15;
export const NEWEST_TESTED_MAJOR = 19;

/** The advisory lock key every runner takes (D-057): "oculus" in ASCII. */
export const MIGRATION_LOCK_KEY = 0x6f63756c7573n;

/** File names the runner accepts. */
export const MIGRATION_FILE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The table the first migration creates, always named with its schema. */
export const BOOKKEEPING_TABLE = "public.oculus_migrations";

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

export interface MigrationFile {
  name: string;
  sha256: string;
  text: string;
}

export interface AppliedMigration {
  name: string;
  sha256: string;
}

export class MigrationError extends Error {
  constructor(
    readonly code:
      | "server_too_old"
      | "bad_file"
      | "duplicate_number"
      | "missing"
      | "edited"
      | "out_of_order"
      | "transaction_ended"
      | "lock_timeout"
      | "file_lock_timeout"
      | "lock_lost"
      | "commit_unknown"
      | "applied_not_recorded"
      | "connection_failed"
      | "failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Refuses servers older than 15; returns a warning above the newest tested major. */
export function checkServerVersion(serverVersionNum: number): string | undefined {
  if (!Number.isInteger(serverVersionNum) || serverVersionNum <= 0) {
    throw new MigrationError("server_too_old", "Could not read the server's version.");
  }
  const major = Math.floor(serverVersionNum / 10000);
  if (major < OLDEST_MAJOR) {
    throw new MigrationError(
      "server_too_old",
      `PostgreSQL ${String(major)} is not supported; Oculus needs ${String(OLDEST_MAJOR)} or newer (D-049).`,
    );
  }
  if (major > NEWEST_TESTED_MAJOR) {
    return `PostgreSQL ${String(major)} is newer than any version Oculus is tested on (${String(OLDEST_MAJOR)}-${String(NEWEST_TESTED_MAJOR)}).`;
  }
  return undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Reads and checks the migration files, in order. */
export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const numbers = new Map<string, string>();
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const match = MIGRATION_FILE.exec(entry.name);
    if (!entry.isFile() || !match) {
      throw new MigrationError(
        "bad_file",
        `${entry.name}: every entry in the migrations directory must be a file named NNNN_short_name.sql.`,
      );
    }
    const number = match[1] ?? "";
    const earlier = numbers.get(number);
    if (earlier !== undefined) {
      throw new MigrationError(
        "duplicate_number",
        `${entry.name} and ${earlier} have the same number.`,
      );
    }
    numbers.set(number, entry.name);
    const bytes = await readFile(join(dir, entry.name));
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new MigrationError("bad_file", `${entry.name} is not valid UTF-8.`);
    }
    if (text.trim() === "") throw new MigrationError("bad_file", `${entry.name} is empty.`);
    files.push({
      name: entry.name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text,
    });
  }
  return files;
}

/**
 * Compares the files with what the database says was applied. Returns the
 * files still to apply, or throws if anything applied is missing or edited, or
 * a new file sorts before an applied one.
 */
export function pendingMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      throw new MigrationError(
        "missing",
        `${row.name} was applied to this database but is not in the migrations directory.`,
      );
    }
    if (file.sha256 !== row.sha256) {
      throw new MigrationError(
        "edited",
        `${row.name} was edited after it was applied. Applied migrations never change; write a new one.`,
      );
    }
  }
  const appliedNames = new Set(applied.map((row) => row.name));
  const pending = files.filter((file) => !appliedNames.has(file.name));
  const lastApplied = [...appliedNames].sort().at(-1);
  const early = lastApplied === undefined ? undefined : pending.find((f) => f.name < lastApplied);
  if (early && lastApplied !== undefined) {
    throw new MigrationError(
      "out_of_order",
      `${early.name} is new but sorts before ${lastApplied}, which is already applied. Renumber it after the last applied migration.`,
    );
  }
  return pending;
}

export interface MigrateOptions {
  connectionString: string;
  /** Default: packages/db/migrations. */
  dir?: string;
  /** How long to wait for another runner's lock, in ms (default 60 000). */
  lockTimeoutMs?: number;
  /** The `lock_timeout` inside each file's transaction, in ms (default 10 000; S-065). */
  fileLockTimeoutMs?: number;
  /** How many times a file that timed out on a lock is tried (default 5). */
  fileLockAttempts?: number;
  /** The pause after a file's first lock timeout, in ms, doubled each time (default 2 000). */
  fileLockPauseMs?: number;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  serverVersionNum: number;
}

async function appliedMigrations(session: Session): Promise<AppliedMigration[]> {
  const [exists] = await session.rows<{ exists: boolean }>(
    sql`SELECT pg_catalog.to_regclass(${BOOKKEEPING_TABLE}) IS NOT NULL AS exists`,
  );
  if (!exists?.exists) return [];
  return session.rows<AppliedMigration>(
    sql`SELECT name, sha256 FROM public.oculus_migrations ORDER BY name`,
  );
}

/** What the runner knows about its own transaction: its ID. */
interface Started {
  xid: string;
}

/**
 * The runner's lock: a session-level advisory lock held by a connection of
 * its own, which never runs a migration file, so no file can release it
 * (advisory locks belong to the session that took them).
 */
interface Lock {
  session: Session;
  /** The backend that took the lock. */
  pid: number;
}

/** What the server says about a transaction ID: in progress, committed or aborted. */
async function transactionStatus(session: Session, xid: string): Promise<string | undefined> {
  const [row] = await session.rows<{ status: string | null }>(
    sql`SELECT pg_catalog.pg_xact_status(${xid}::pg_catalog.xid8) AS status`,
  );
  return row?.status ?? undefined;
}

/**
 * Whether the session is still inside the runner's own transaction, which is
 * still running: the server reports a transaction block, the current
 * transaction ID is the one the runner was given (an ID is never reused, so a
 * file that ended the transaction, even with PREPARE TRANSACTION, can't be in
 * it again), and the server says that ID is in progress. Only then can nothing
 * the file did have been committed on its own.
 */
async function inRunnersTransaction(session: Session, started: Started): Promise<boolean> {
  if (session.transactionState() !== "in_block") return false;
  const [row] = await session.rows<{ xid: string | null; status: string | null }>(
    sql`SELECT pg_catalog.pg_current_xact_id_if_assigned()::pg_catalog.text AS xid,
               pg_catalog.pg_xact_status(${started.xid}::pg_catalog.xid8) AS status`,
  );
  return (
    row?.xid === started.xid &&
    row.status === "in progress" &&
    session.transactionState() === "in_block"
  );
}

/**
 * After a file failed: whether it failed inside the runner's transaction,
 * which it never ended. A failed statement leaves the runner's block failed;
 * a session that is outside a block, or in a block that still works, has left
 * the runner's transaction. In a failed block, rolling back to the savepoint
 * the runner made before the file works only in the runner's own transaction,
 * and then the transaction ID must be the runner's.
 */
async function failedInRunnersTransaction(session: Session, started: Started): Promise<boolean> {
  if (session.transactionState() !== "failed_block") return false;
  try {
    await session.control("ROLLBACK TO SAVEPOINT oculus_migration");
    return await inRunnersTransaction(session, started);
  } catch {
    return false;
  }
}

/**
 * The prepared transaction the file made of the runner's own transaction, if
 * any: only one whose transaction ID is the runner's, never another
 * application's.
 */
async function preparedByFile(session: Session, started: Started): Promise<string[]> {
  const rows = await session.rows<{ gid: string }>(
    sql`SELECT gid FROM pg_catalog.pg_prepared_xacts
        WHERE database = pg_catalog.current_database()
          AND transaction = pg_catalog.xid(${started.xid}::pg_catalog.xid8)
        ORDER BY gid`,
  );
  return rows.map((row) => row.gid);
}

/**
 * Whether the runner still holds its lock: the lock connection answers, is
 * still the backend that took the lock, and that backend holds the lock
 * exclusively in its own database. Any error (the connection is gone) counts
 * as lost.
 *
 * It reads only functions over shared memory (`pg_lock_status()` and
 * `pg_stat_get_activity()`, which the `pg_locks` and `pg_stat_activity` views
 * wrap), and takes no catalog table locks beyond parsing, so a file holding a
 * lock on a catalog (say `LOCK pg_catalog.pg_database`) can't make this check
 * wait and fail.
 */
async function lockHeld(lock: Lock): Promise<boolean> {
  try {
    const [row] = await lock.session.rows<{ held: boolean }>(
      sql`SELECT pg_catalog.pg_backend_pid() = ${lock.pid}::pg_catalog.int4 AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_lock_status() AS l
            WHERE l.locktype = 'advisory' AND l.pid = ${lock.pid}::pg_catalog.int4
              AND l.mode = 'ExclusiveLock' AND l.granted
              AND l.database = (SELECT a.datid
                                FROM pg_catalog.pg_stat_get_activity(${lock.pid}::pg_catalog.int4) AS a)
              AND l.classid = ${String(MIGRATION_LOCK_KEY >> 32n)}::pg_catalog.oid
              AND l.objid = ${String(MIGRATION_LOCK_KEY & 0xffffffffn)}::pg_catalog.oid
              AND l.objsubid = 1
          ) AS held`,
    );
    return row?.held === true;
  } catch {
    return false;
  }
}

const LOCK_LOST =
  "the runner's advisory lock was lost (its connection ended, or no longer holds the lock), so another run could migrate at the same time";

function transactionEnded(file: MigrationFile, prepared: readonly string[]): MigrationError {
  const resolve =
    prepared.length === 0
      ? ""
      : ` It left prepared transaction${prepared.length === 1 ? "" : "s"} ${prepared.map((gid) => JSON.stringify(gid)).join(", ")}, still holding its changes and locks: resolve ${prepared.length === 1 ? "it" : "each"} with COMMIT PREPARED or ROLLBACK PREPARED (see pg_prepared_xacts) first.`;
  return new MigrationError(
    "transaction_ended",
    `${file.name} ended the runner's transaction (COMMIT, ROLLBACK, END, COMMIT AND CHAIN or PREPARE TRANSACTION in the file), or the runner could not confirm that it didn't. Part of it may have been applied and it is not recorded; a person must check the database before migrating again.${resolve}`,
  );
}

/**
 * The time limits of a file's transaction (S-065), for this transaction only:
 * no statement or transaction time limit, and `lockTimeoutMs` for any lock
 * wait. `transaction_timeout` exists from PostgreSQL 17 (left alone before).
 */
async function fileTimeLimits(session: Session, lockTimeoutMs: number): Promise<void> {
  await session.execute(
    sql`SELECT pg_catalog.set_config('statement_timeout', '0', true),
               pg_catalog.set_config('lock_timeout', ${String(lockTimeoutMs)}, true),
               CASE WHEN pg_catalog.current_setting('transaction_timeout', true) IS NULL THEN NULL
                    ELSE pg_catalog.set_config('transaction_timeout', '0', true) END`,
  );
}

async function applyOne(
  session: Session,
  lock: Lock,
  file: MigrationFile,
  lockTimeoutMs: number,
): Promise<void> {
  if (!(await lockHeld(lock))) {
    throw new MigrationError(
      "lock_lost",
      `Before ${file.name} ran, ${LOCK_LOST}. Nothing of it was applied; check that no other run is migrating, then run again.`,
    );
  }
  let started: Started | undefined;
  // An object, so the outer catch sees what the inner one set.
  const stage = { scriptFailed: false, commitFailed: false };
  let committed = false;
  await session.control("BEGIN");
  try {
    await fileTimeLimits(session, lockTimeoutMs);
    // Gives the transaction an ID now, so whether the file ended it can be
    // asked of the server afterwards, whether the file then failed or not.
    const [row] = await session.rows<Started>(
      sql`SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid`,
    );
    started = row;
    if (started === undefined) throw new MigrationError("failed", "No transaction ID.");
    // Only the runner's own transaction has this savepoint, so after a failure
    // rolling back to it shows whether the failed block is still the runner's.
    await session.control("SAVEPOINT oculus_migration");
    try {
      await session.runScript(file.text);
    } catch (error) {
      stage.scriptFailed = true;
      throw new MigrationError("failed", `${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (session.transactionState() !== "in_block") throw transactionEnded(file, []);
    // Inside the transaction, so a file's SET, prepared statements and
    // temporary tables can't reach the runner's own statements below.
    await resetSession(session);
    // RESET ALL brought back the role's and database's limits; the deferred
    // triggers and the COMMIT below are still the file's work.
    await fileTimeLimits(session, lockTimeoutMs);
    // A PREPARE TRANSACTION in the file changes the transaction ID, so this
    // catches it too.
    if (!(await inRunnersTransaction(session, started))) throw transactionEnded(file, []);
    if (!(await lockHeld(lock))) {
      throw new MigrationError(
        "lock_lost",
        `While ${file.name} ran, ${LOCK_LOST}. Nothing of it was applied or recorded; check that no other run is migrating, then run again.`,
      );
    }
    try {
      await session.execute(
        sql`INSERT INTO public.oculus_migrations (name, sha256) VALUES (${file.name}, ${file.sha256})`,
      );
    } catch (error) {
      const missing = (error as { code?: string }).code === "42P01";
      throw new MigrationError(
        "failed",
        `${file.name} ran but could not be recorded${missing ? " (the first migration must create public.oculus_migrations)" : ""}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    // Runs the file's deferred triggers and constraints now rather than at
    // COMMIT, so what they do (fail, delete the runner's row, end the lock's
    // connection) is caught by the checks below instead of after the COMMIT.
    try {
      await session.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    } catch (error) {
      throw new MigrationError(
        "failed",
        `${file.name} failed when its deferred constraints and triggers ran: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const [mine] = await session.rows<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM public.oculus_migrations
                         WHERE name = ${file.name} AND sha256 = ${file.sha256}) AS present`,
    );
    if (mine?.present !== true) {
      throw new MigrationError(
        "transaction_ended",
        `${file.name} removed or changed its own row in public.oculus_migrations (a trigger in the file, for example), so it can't be recorded. It was rolled back and is not recorded; a person must check the file and the database before migrating again.`,
      );
    }
    if (!(await lockHeld(lock))) {
      throw new MigrationError(
        "lock_lost",
        `While ${file.name} was being recorded, ${LOCK_LOST}. Nothing of it was applied or recorded; check that no other run is migrating, then run again.`,
      );
    }
    try {
      await session.control("COMMIT");
    } catch (error) {
      stage.commitFailed = true;
      throw error;
    }
    committed = true;
  } catch (error) {
    let failure = error;
    if (started === undefined) {
      await session.control("ROLLBACK").catch(() => undefined);
    } else if (stage.commitFailed) {
      // A COMMIT that fails on the server (a deferred constraint) ends the
      // transaction aborted. If the server can't be asked (the connection is
      // gone), nobody here knows whether the COMMIT happened.
      const status = await transactionStatus(session, started.xid).catch(() => undefined);
      failure =
        status === "aborted"
          ? new MigrationError(
              "failed",
              `${file.name} failed at COMMIT, so nothing of it was applied or recorded: ${(error as Error).message}`,
              { cause: error },
            )
          : new MigrationError(
              "commit_unknown",
              `The connection was lost during the COMMIT of ${file.name}, so whether it was applied and recorded is unknown: a person must check whether ${file.name} is recorded in public.oculus_migrations (and whether its changes are in the database) before migrating again. (${(error as Error).message})`,
              { cause: error },
            );
    } else {
      // A failed file counts as plain `failed` only if it failed inside the
      // runner's transaction, which it never ended (so it committed nothing).
      if (stage.scriptFailed && !(await failedInRunnersTransaction(session, started))) {
        failure = transactionEnded(file, []);
      }
      await session.control("ROLLBACK").catch(() => undefined);
      // The runner's own ROLLBACK must be what ended its transaction.
      const status = await transactionStatus(session, started.xid).catch(() => undefined);
      if (status !== "aborted") failure = transactionEnded(file, []);
      if (failure instanceof MigrationError && failure.code === "transaction_ended") {
        const prepared = await preparedByFile(session, started).catch(() => []);
        if (prepared.length > 0) failure = transactionEnded(file, prepared);
      }
    }
    // A failing file may also have ended the lock's connection.
    if (!(failure instanceof MigrationError && failure.code === "lock_lost")) {
      if (!(await lockHeld(lock))) {
        failure =
          failure instanceof MigrationError && failure.code === "failed"
            ? new MigrationError(
                "lock_lost",
                `${file.name} failed and was rolled back, and ${LOCK_LOST}. Check that no other run is migrating, then fix the file and run again. (${failure.message})`,
                { cause: failure },
              )
            : new MigrationError(
                failure instanceof MigrationError ? failure.code : "lock_lost",
                `${(failure as Error).message} Also, ${LOCK_LOST}.`,
                { cause: failure },
              );
      }
    }
    throw failure;
  } finally {
    // Again after the transaction, for anything a failed or ended file left.
    // A reset that fails after a file committed stops the run, saying so.
    try {
      await resetSession(session);
    } catch (error) {
      if (committed) {
        // eslint-disable-next-line no-unsafe-finally
        throw new MigrationError(
          "failed",
          `${file.name} was applied and recorded, but the session could not be reset afterwards, so the run stopped there: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
  }
  // A deferred trigger can still run at the runner's COMMIT, after the row was
  // read above: one fired by SET CONSTRAINTS ALL IMMEDIATE can defer
  // constraints again and queue another, which then deletes or changes the
  // file's row. The file is in by then; check its row is too.
  const recordedRow = await session
    .rows<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM public.oculus_migrations
                         WHERE name = ${file.name} AND sha256 = ${file.sha256}) AS present`,
    )
    .then(
      ([row]) => row?.present === true,
      () => false,
    );
  if (!recordedRow) {
    throw new MigrationError(
      "applied_not_recorded",
      `${file.name} was applied, but its record in public.oculus_migrations is missing or changed (or could not be read) after the COMMIT (a deferred trigger in the file, for example). A person must check the database and record it by hand (its name and SHA-256 ${file.sha256}). The run stopped there.`,
    );
  }
  // The lock can still be lost between the last check and the COMMIT (the
  // network, an administrator). The file is in by then; say so, and stop.
  if (!(await lockHeld(lock))) {
    throw new MigrationError(
      "lock_lost",
      `${file.name} was applied and recorded, but afterwards ${LOCK_LOST}. The run stopped there; check that no other run is migrating, then run again.`,
    );
  }
}

/**
 * Whether a file failed only because a lock wait passed `lock_timeout`
 * (55P03), cleanly rolled back: a plain `failed`, never a file that ended
 * the runner's transaction or lost the lock.
 */
function timedOutOnLock(error: unknown): boolean {
  if (!(error instanceof MigrationError) || error.code !== "failed") return false;
  return (error.cause as { code?: unknown } | undefined)?.code === "55P03";
}

/** Whether the file's row is in the bookkeeping table (unknown counts as yes). */
async function isRecorded(session: Session, file: MigrationFile): Promise<boolean> {
  try {
    const [row] = await session.rows<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM public.oculus_migrations WHERE name = ${file.name}) AS present`,
    );
    return row?.present !== false;
  } catch {
    return true;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetSession(session: Session): Promise<void> {
  await session.execute(sql`RESET ALL`);
  await session.execute(sql`RESET ROLE`);
  await session.execute(sql`RESET SESSION AUTHORIZATION`);
  await session.execute(sql`DISCARD TEMP`);
  await session.execute(sql`DEALLOCATE ALL`);
}

/** Applies every pending migration. Safe to run at the same time as another runner. */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new TypeError("lockTimeoutMs must be a positive whole number.");
  }
  const fileLockTimeoutMs = options.fileLockTimeoutMs ?? 10_000;
  const fileLockAttempts = options.fileLockAttempts ?? 5;
  const fileLockPauseMs = options.fileLockPauseMs ?? 2_000;
  if (!Number.isInteger(fileLockTimeoutMs) || fileLockTimeoutMs < 1) {
    throw new TypeError("fileLockTimeoutMs must be a positive whole number.");
  }
  if (!Number.isInteger(fileLockAttempts) || fileLockAttempts < 1 || fileLockAttempts > 20) {
    throw new TypeError("fileLockAttempts must be a whole number from 1 to 20.");
  }
  if (!Number.isInteger(fileLockPauseMs) || fileLockPauseMs < 0 || fileLockPauseMs > 60_000) {
    throw new TypeError("fileLockPauseMs must be a whole number from 0 to 60,000.");
  }
  const files = await readMigrations(options.dir ?? defaultMigrationsDir());
  // The lock's own connection: it takes the lock and never runs a file.
  const lockSession = await openSession(options.connectionString, "oculus-migrate-lock");
  try {
    const [version] = await lockSession.rows<{ v: string }>(
      sql`SELECT pg_catalog.current_setting('server_version_num') AS v`,
    );
    const serverVersionNum = Number(version?.v);
    const warning = checkServerVersion(serverVersionNum);
    if (warning) log(`Warning: ${warning}`);

    // The lock connection sits idle while a file runs, for as long as the file
    // takes: a role, database or server idle_session_timeout would end it and
    // lose the lock. It never stays in a transaction, but the same goes for
    // idle_in_transaction_session_timeout.
    // transaction_timeout exists from PostgreSQL 17 (null before); like
    // statement_timeout it bounds the wait below and is turned off after it.
    const [settings] = await lockSession.rows<{
      statementTimeout: string;
      transactionTimeout: string | null;
    }>(
      sql`SELECT pg_catalog.set_config('idle_session_timeout', '0', false),
                 pg_catalog.set_config('idle_in_transaction_session_timeout', '0', false),
                 pg_catalog.set_config('lock_timeout', ${String(lockTimeoutMs)}, false),
                 pg_catalog.current_setting('statement_timeout') AS "statementTimeout",
                 pg_catalog.current_setting('transaction_timeout', true) AS "transactionTimeout"`,
    );
    try {
      await lockSession.execute(sql`SELECT pg_catalog.pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "55P03") {
        throw new MigrationError(
          "lock_timeout",
          `Another migration run held the lock for more than ${String(lockTimeoutMs)} ms.`,
          { cause: error },
        );
      }
      if (code === "57014") {
        throw new MigrationError(
          "lock_timeout",
          `The wait for the migration lock was cancelled before lockTimeoutMs (${String(lockTimeoutMs)} ms): the role, database or server sets statement_timeout (${settings?.statementTimeout ?? "unknown"}), or someone cancelled it. Another migration run is probably holding the lock.`,
          { cause: error },
        );
      }
      if (code === "25P04") {
        // PostgreSQL 17+: transaction_timeout ends the session, not just the wait.
        throw new MigrationError(
          "lock_timeout",
          `The wait for the migration lock was ended before lockTimeoutMs (${String(lockTimeoutMs)} ms): the role, database or server sets transaction_timeout (${settings?.transactionTimeout ?? "unknown"}). Another migration run is probably holding the lock.`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      // Only now: until the lock is taken the role's statement_timeout (and,
      // from PostgreSQL 17, transaction_timeout) bounds the wait (above). The
      // checks below must not be cut short by them, and lock_timeout still
      // bounds any lock wait they could meet.
      await lockSession.execute(sql`SELECT pg_catalog.set_config('statement_timeout', '0', false)`);
      if (typeof settings?.transactionTimeout === "string") {
        await lockSession.execute(
          sql`SELECT pg_catalog.set_config('transaction_timeout', '0', false)`,
        );
      }
      const [backend] = await lockSession.rows<{ pid: number }>(
        sql`SELECT pg_catalog.pg_backend_pid() AS pid`,
      );
      if (backend === undefined) throw new MigrationError("lock_lost", "No backend ID.");
      const lock: Lock = { session: lockSession, pid: backend.pid };
      // The files' connection: the migrating role needs two at once (D-057).
      // It is closed before the lock is released. Closing it doesn't wait for
      // its server process (after a network drop the server may still be
      // running a file's statement for a while), so a second run could start
      // while that statement finishes; the primary key on
      // oculus_migrations.name stops the same file being recorded twice.
      let session: Session;
      try {
        session = await openSession(options.connectionString, "oculus-migrate");
      } catch (error) {
        const tooMany = (error as { code?: string }).code === "53300";
        throw new MigrationError(
          "connection_failed",
          `The runner holds the lock on one connection and needs a second one for the files, but could not open it${tooMany ? " (too many connections: the role's or database's CONNECTION LIMIT, or the server's max_connections, must allow two connections for the migrating role)" : ""}: ${(error as Error).message}`,
          { cause: error },
        );
      }
      try {
        const pending = pendingMigrations(files, await appliedMigrations(session));
        const applied: string[] = [];
        for (const file of pending) {
          for (let attempt = 1; ; attempt += 1) {
            try {
              await applyOne(session, lock, file, fileLockTimeoutMs);
              break;
            } catch (error) {
              // Never again a file that is in (a reset failing after its
              // COMMIT, say), whatever the error's cause (S-065 review).
              if (!timedOutOnLock(error) || (await isRecorded(session, file))) throw error;
              if (attempt >= fileLockAttempts) {
                throw new MigrationError(
                  "file_lock_timeout",
                  `${file.name} waited more than ${String(fileLockTimeoutMs)} ms for a lock ${String(attempt)} times (something else, such as a long query, held a table it changes), so it was rolled back each time and nothing of it was applied. Run the migrations again when the database is less busy.`,
                  { cause: error },
                );
              }
              log(
                `${file.name} waited too long for a lock and was rolled back; trying again (${String(attempt + 1)} of ${String(fileLockAttempts)}).`,
              );
              await pause(fileLockPauseMs * 2 ** (attempt - 1));
            }
          }
          applied.push(file.name);
          log(`Applied ${file.name}`);
        }
        if (applied.length === 0) log("Nothing to migrate.");
        return { applied, serverVersionNum };
      } finally {
        await session.close().catch(() => undefined);
      }
    } finally {
      await lockSession
        .execute(sql`SELECT pg_catalog.pg_advisory_unlock(${MIGRATION_LOCK_KEY})`)
        .catch(() => undefined);
    }
  } finally {
    await lockSession.close().catch(() => undefined);
  }
}
