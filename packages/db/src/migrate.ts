/**
 * The migration runner (D-050, D-057).
 *
 * Migrations are plain SQL files in `packages/db/migrations`, named
 * `NNNN_short_name.sql`, applied forwards only, in name order. The runner:
 * - checks the server is PostgreSQL 15 or newer (D-049), warning above the
 *   newest major CI tests;
 * - takes a session-level advisory lock, so two runs never migrate at once
 *   (the second waits, then finds nothing left to do);
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
 * what ends it. A file that releases the runner's advisory lock is refused as
 * `lock_lost` before anything of it commits. Statements that can't run in a transaction
 * (CREATE INDEX CONCURRENTLY) are not supported. Right after each file, inside
 * its transaction, and again after it, the session is reset (RESET ALL, RESET
 * ROLE, RESET SESSION AUTHORIZATION, DISCARD TEMP, DEALLOCATE ALL), and the
 * runner names its table and functions with their schemas, so a file can't
 * change what the next file or the runner's own statements do (D-057).
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
      | "lock_lost"
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

/** What the runner knows about its own transaction: its ID and start time. */
interface Started {
  xid: string;
  at: string;
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

/** Prepared transactions in this database made since the runner's transaction began. */
async function preparedSince(session: Session, started: Started): Promise<string[]> {
  const rows = await session.rows<{ gid: string }>(
    sql`SELECT gid FROM pg_catalog.pg_prepared_xacts
        WHERE database = pg_catalog.current_database()
          AND prepared >= ${started.at}::pg_catalog.timestamptz
        ORDER BY prepared, gid`,
  );
  return rows.map((row) => row.gid);
}

/** Whether this session still holds the runner's advisory lock (a file may release it). */
async function holdsLock(session: Session): Promise<boolean> {
  const [row] = await session.rows<{ held: boolean }>(
    sql`SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND granted
            AND classid = ${String(MIGRATION_LOCK_KEY >> 32n)}::pg_catalog.oid
            AND objid = ${String(MIGRATION_LOCK_KEY & 0xffffffffn)}::pg_catalog.oid
            AND objsubid = 1
        ) AS held`,
  );
  return row?.held === true;
}

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

async function applyOne(session: Session, file: MigrationFile): Promise<void> {
  let started: Started | undefined;
  // An object, so the outer catch sees what the inner one set.
  const script = { failed: false };
  let committed = false;
  await session.control("BEGIN");
  try {
    // Gives the transaction an ID now, so whether the file ended it can be
    // asked of the server afterwards, whether the file then failed or not.
    const [row] = await session.rows<Started>(
      sql`SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS xid,
                 pg_catalog.now()::pg_catalog.text AS at`,
    );
    started = row;
    if (started === undefined) throw new MigrationError("failed", "No transaction ID.");
    // Only the runner's own transaction has this savepoint, so after a failure
    // rolling back to it shows whether the failed block is still the runner's.
    await session.control("SAVEPOINT oculus_migration");
    try {
      await session.runScript(file.text);
    } catch (error) {
      script.failed = true;
      throw new MigrationError("failed", `${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (session.transactionState() !== "in_block") throw transactionEnded(file, []);
    // Inside the transaction, so a file's SET, prepared statements and
    // temporary tables can't reach the runner's own statements below.
    await resetSession(session);
    if (!(await inRunnersTransaction(session, started))) throw transactionEnded(file, []);
    if ((await preparedSince(session, started)).length > 0) throw transactionEnded(file, []);
    if (!(await holdsLock(session))) {
      throw new MigrationError(
        "lock_lost",
        `${file.name} released the runner's advisory lock (pg_advisory_unlock_all() or pg_advisory_unlock() in the file), so another run could migrate at the same time. Nothing of it was applied; remove that call.`,
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
    await session.control("COMMIT");
    committed = true;
  } catch (error) {
    let failure = error;
    if (started !== undefined) {
      // A failed file counts as plain `failed` only if it failed inside the
      // runner's transaction, which it never ended (so it committed nothing).
      if (script.failed && !(await failedInRunnersTransaction(session, started))) {
        failure = transactionEnded(file, []);
      }
      await session.control("ROLLBACK").catch(() => undefined);
      // The runner's own ROLLBACK must be what ended its transaction.
      const status = await transactionStatus(session, started.xid).catch(() => undefined);
      if (status !== "aborted") failure = transactionEnded(file, []);
      if (failure instanceof MigrationError && failure.code === "transaction_ended") {
        const prepared = await preparedSince(session, started).catch(() => []);
        failure = transactionEnded(file, prepared);
      }
    } else {
      await session.control("ROLLBACK").catch(() => undefined);
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
  const files = await readMigrations(options.dir ?? defaultMigrationsDir());
  const session = await openSession(options.connectionString);
  try {
    const [version] = await session.rows<{ v: string }>(
      sql`SELECT pg_catalog.current_setting('server_version_num') AS v`,
    );
    const serverVersionNum = Number(version?.v);
    const warning = checkServerVersion(serverVersionNum);
    if (warning) log(`Warning: ${warning}`);

    await session.execute(
      sql`SELECT pg_catalog.set_config('lock_timeout', ${String(lockTimeoutMs)}, false)`,
    );
    try {
      await session.execute(sql`SELECT pg_catalog.pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") {
        throw new MigrationError(
          "lock_timeout",
          `Another migration run held the lock for more than ${String(lockTimeoutMs)} ms.`,
          { cause: error },
        );
      }
      throw error;
    }
    await session.execute(sql`SELECT pg_catalog.set_config('lock_timeout', '0', false)`);
    try {
      const pending = pendingMigrations(files, await appliedMigrations(session));
      const applied: string[] = [];
      for (const file of pending) {
        await applyOne(session, file);
        applied.push(file.name);
        log(`Applied ${file.name}`);
      }
      if (applied.length === 0) log("Nothing to migrate.");
      return { applied, serverVersionNum };
    } finally {
      await session
        .execute(sql`SELECT pg_catalog.pg_advisory_unlock(${MIGRATION_LOCK_KEY})`)
        .catch(() => undefined);
    }
  } finally {
    await session.close().catch(() => undefined);
  }
}
