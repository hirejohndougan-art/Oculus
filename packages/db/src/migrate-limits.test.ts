// The migration runner's time limits inside a file's transaction (S-065,
// T-053 data review L2): a role's or database's statement_timeout no longer
// cancels a long file, and a file that waits for a table lock someone else
// holds gives up after fileLockTimeoutMs, is rolled back and tried again, and
// after the last attempt stops as file_lock_timeout with nothing applied.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openSession, type Session } from "./client.js";
import { defaultMigrationsDir, migrate, MigrationError } from "./migrate.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const FIRST = readFileSync(join(defaultMigrationsDir(), "0001_migrations_table.sql"));

const dirs: string[] = [];
const databases: TestDatabase[] = [];
const sessions: Session[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => undefined)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(databases.splice(0).map((db) => db.drop()));
});

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oculus-migrations-"));
  dirs.push(dir);
  writeFileSync(join(dir, "0001_migrations_table.sql"), FIRST);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

async function database(): Promise<TestDatabase> {
  const db = await freshDatabase();
  databases.push(db);
  return db;
}

async function session(url: string): Promise<Session> {
  const s = await openSession(url);
  sessions.push(s);
  return s;
}

async function recorded(url: string): Promise<string[]> {
  const s = await session(url);
  const rows = await s.rows<{ name: string }>(
    sql`SELECT name FROM public.oculus_migrations ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

async function refusal(promise: Promise<unknown>): Promise<MigrationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MigrationError);
  return error as MigrationError;
}

describe("time limits inside a migration file", () => {
  it("runs a file longer than the database's statement_timeout", async () => {
    const db = await database();
    const admin = await session(db.url);
    await admin.runScript(`ALTER DATABASE ${db.name} SET statement_timeout = '300ms'`);
    const dir = migrationsDir({
      "0002_slow_one.sql": "SELECT pg_sleep(0.6);\nCREATE TABLE slow_one (id int);",
    });
    const result = await migrate({ connectionString: db.url, dir });
    expect(result.applied).toEqual(["0001_migrations_table.sql", "0002_slow_one.sql"]);
    // Only inside the file's transaction: a fresh session still has the limit.
    const after = await session(db.url);
    const [row] = await after.rows<{ t: string }>(
      sql`SELECT pg_catalog.current_setting('statement_timeout') AS t`,
    );
    expect(row?.t).toBe("300ms");
  });

  it("tries a file again when a table lock it needs is held, then applies it", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_table.sql": "CREATE TABLE busy (id int);" });
    await migrate({ connectionString: db.url, dir });
    const next = migrationsDir({
      "0002_table.sql": "CREATE TABLE busy (id int);",
      "0003_alter.sql": "ALTER TABLE busy ADD COLUMN note text;",
    });
    // A long reader, as the old server's would be during an in-place update.
    const reader = await session(db.url);
    await reader.control("BEGIN");
    await reader.rows(sql`SELECT count(*) FROM public.busy`);
    const log: string[] = [];
    setTimeout(() => void reader.control("COMMIT"), 500);
    const result = await migrate({
      connectionString: db.url,
      dir: next,
      fileLockTimeoutMs: 150,
      fileLockAttempts: 10,
      fileLockPauseMs: 50,
      log: (m) => log.push(m),
    });
    expect(result.applied).toEqual(["0003_alter.sql"]);
    expect(log.some((m) => m.includes("0003_alter.sql waited too long for a lock"))).toBe(true);
    expect(await recorded(db.url)).toEqual([
      "0001_migrations_table.sql",
      "0002_table.sql",
      "0003_alter.sql",
    ]);
  });

  it("stops as file_lock_timeout after the last attempt, applying and recording nothing of it", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_table.sql": "CREATE TABLE busy (id int);" });
    await migrate({ connectionString: db.url, dir });
    const next = migrationsDir({
      "0002_table.sql": "CREATE TABLE busy (id int);",
      "0003_alter.sql":
        "CREATE TABLE before_lock (id int);\nALTER TABLE busy ADD COLUMN note text;",
    });
    const reader = await session(db.url);
    await reader.control("BEGIN");
    await reader.rows(sql`SELECT count(*) FROM public.busy`);
    const error = await refusal(
      migrate({
        connectionString: db.url,
        dir: next,
        fileLockTimeoutMs: 100,
        fileLockAttempts: 3,
        fileLockPauseMs: 10,
      }),
    );
    expect(error.code).toBe("file_lock_timeout");
    expect(error.message).toContain("0003_alter.sql");
    expect(error.message).toContain("3 times");
    await reader.control("ROLLBACK");
    expect(await recorded(db.url)).toEqual(["0001_migrations_table.sql", "0002_table.sql"]);
    const check = await session(db.url);
    const [table] = await check.rows<{ present: boolean }>(
      sql`SELECT pg_catalog.to_regclass('public.before_lock') IS NOT NULL AS present`,
    );
    expect(table?.present).toBe(false);
    // Once the reader is gone, the same run applies it.
    expect((await migrate({ connectionString: db.url, dir: next })).applied).toEqual([
      "0003_alter.sql",
    ]);
  });

  it("never tries again a file that ended the runner's transaction, even on a lock timeout", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_table.sql": "CREATE TABLE busy (id int);\nCREATE TABLE once (id int);",
    });
    await migrate({ connectionString: db.url, dir });
    const next = migrationsDir({
      "0002_table.sql": "CREATE TABLE busy (id int);\nCREATE TABLE once (id int);",
      "0003_commits.sql":
        "INSERT INTO once VALUES (1);\nCOMMIT;\nSET lock_timeout = '100ms';\nALTER TABLE busy ADD COLUMN note text;",
    });
    const reader = await session(db.url);
    await reader.control("BEGIN");
    await reader.rows(sql`SELECT count(*) FROM public.busy`);
    const log: string[] = [];
    const error = await refusal(
      migrate({
        connectionString: db.url,
        dir: next,
        fileLockTimeoutMs: 100,
        fileLockAttempts: 5,
        fileLockPauseMs: 0,
        log: (m) => log.push(m),
      }),
    );
    await reader.control("ROLLBACK");
    expect(error.code).toBe("transaction_ended");
    expect(log.some((m) => m.includes("trying again"))).toBe(false);
    const check = await session(db.url);
    expect(
      await check.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.once`),
    ).toEqual([{ n: 1 }]);
  });

  it("doesn't try again a file that fails for any other reason", async () => {
    const db = await database();
    const log: string[] = [];
    const dir = migrationsDir({ "0002_broken.sql": "SELECT * FROM nowhere;" });
    const error = await refusal(
      migrate({ connectionString: db.url, dir, fileLockPauseMs: 0, log: (m) => log.push(m) }),
    );
    expect(error.code).toBe("failed");
    expect(log.some((m) => m.includes("trying again"))).toBe(false);
  });

  it("checks its options", async () => {
    const db = await database();
    const dir = migrationsDir({});
    for (const options of [
      { fileLockTimeoutMs: 0 },
      { fileLockTimeoutMs: 1.5 },
      { fileLockAttempts: 0 },
      { fileLockAttempts: 21 },
      { fileLockPauseMs: -1 },
      { fileLockPauseMs: 60_001 },
    ]) {
      await expect(migrate({ connectionString: db.url, dir, ...options })).rejects.toThrow(
        TypeError,
      );
    }
  });
});
