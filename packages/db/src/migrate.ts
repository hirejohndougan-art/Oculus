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
 * COMMIT AND CHAIN) is refused as `transaction_ended`, also when it opens a
 * new transaction and then fails: the server is asked whether the runner's
 * transaction ID committed. Statements that can't run in a transaction
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

/** What the server says about a transaction ID: in progress, committed or aborted. */
async function transactionStatus(session: Session, xid: string): Promise<string | undefined> {
  const [row] = await session.rows<{ status: string | null }>(
    sql`SELECT pg_catalog.pg_xact_status(${xid}::pg_catalog.xid8) AS status`,
  );
  return row?.status ?? undefined;
}

async function applyOne(session: Session, file: MigrationFile): Promise<void> {
  const ended = (): MigrationError =>
    new MigrationError(
      "transaction_ended",
      `${file.name} ended the runner's transaction (COMMIT, ROLLBACK, END or COMMIT AND CHAIN in the file). Part of it may have been applied and it is not recorded; a person must check the database before migrating again.`,
    );
  let started: string | undefined;
  let committed = false;
  await session.control("BEGIN");
  try {
    // Gives the transaction an ID now, so whether the file ended it can be
    // asked of the server afterwards, whether the file then failed or not.
    const [row] = await session.rows<{ xid: string }>(
      sql`SELECT pg_catalog.pg_current_xact_id()::text AS xid`,
    );
    started = row?.xid;
    if (started === undefined) throw new MigrationError("failed", "No transaction ID.");
    try {
      await session.runScript(file.text);
    } catch (error) {
      throw new MigrationError("failed", `${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    // Inside the transaction, so a file's SET, prepared statements and
    // temporary tables can't reach the runner's own statements below.
    await resetSession(session);
    if ((await transactionStatus(session, started)) !== "in progress") throw ended();
    try {
      await session.execute(
        sql`INSERT INTO public.oculus_migrations (name, sha256) VALUES (${file.name}, ${file.sha256})`,
      );
    } catch (error) {
      throw new MigrationError(
        "failed",
        `${file.name} ran but could not be recorded (the first migration must create public.oculus_migrations): ${(error as Error).message}`,
        { cause: error },
      );
    }
    await session.control("COMMIT");
    committed = true;
  } catch (error) {
    await session.control("ROLLBACK").catch(() => undefined);
    // The runner's transaction is aborted now, unless the file committed it
    // (COMMIT, END, COMMIT AND CHAIN), in which case part of the file stays.
    if (
      started !== undefined &&
      !(error instanceof MigrationError && error.code === "transaction_ended")
    ) {
      const status = await transactionStatus(session, started).catch(() => undefined);
      if (status === "committed") throw ended();
    }
    throw error;
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
