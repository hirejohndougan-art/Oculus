// The migration runner: every migration on a fresh database, the refusals
// (edited, missing, out-of-order and badly named files, old servers, files
// that end the transaction), and two runners at once (the advisory lock).
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, openSession } from "./client.js";
import { runMigrateCli } from "./migrate-cli.js";
import {
  checkServerVersion,
  defaultMigrationsDir,
  migrate,
  MIGRATION_LOCK_KEY,
  MigrationError,
  pendingMigrations,
  readMigrations,
} from "./migrate.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const FIRST = readFileSync(join(defaultMigrationsDir(), "0001_migrations_table.sql"));

const dirs: string[] = [];
const databases: TestDatabase[] = [];

/** A temporary migrations directory holding the real 0001 plus the given files. */
function migrationsDir(files: Record<string, string | Buffer> = {}): string {
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

async function recorded(url: string): Promise<{ name: string; sha256: string }[]> {
  const db = openDatabase(url, { max: 1 });
  try {
    return await db.rows(sql`SELECT name, sha256 FROM oculus_migrations ORDER BY name`);
  } finally {
    await db.close();
  }
}

async function tables(url: string): Promise<string[]> {
  const db = openDatabase(url, { max: 1 });
  try {
    const rows = await db.rows<{ t: string }>(
      sql`SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return rows.map((row) => row.t);
  } finally {
    await db.close();
  }
}

async function refusal(promise: Promise<unknown>): Promise<MigrationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MigrationError);
  return error as MigrationError;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(databases.splice(0).map((db) => db.drop()));
});

describe("every migration on a fresh database", () => {
  it("applies all of packages/db/migrations, records each hash, and then has nothing to do", async () => {
    const db = await database();
    const files = await readMigrations(defaultMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    const result = await migrate({ connectionString: db.url });
    expect(result.applied).toEqual(files.map((f) => f.name));
    expect(Math.floor(result.serverVersionNum / 10000)).toBeGreaterThanOrEqual(15);
    const rows = await recorded(db.url);
    expect(rows).toEqual(
      files.map((f) => ({
        name: f.name,
        sha256: createHash("sha256")
          .update(readFileSync(join(defaultMigrationsDir(), f.name)))
          .digest("hex"),
      })),
    );
    const again = await migrate({ connectionString: db.url });
    expect(again.applied).toEqual([]);
    expect(await recorded(db.url)).toEqual(rows);
  });

  it("leaves the empty schema: only the bookkeeping table", async () => {
    const db = await database();
    await migrate({ connectionString: db.url });
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
  });

  it("applies new files in order on a later run", async () => {
    const db = await database();
    const dir = migrationsDir();
    await migrate({ connectionString: db.url, dir });
    writeFileSync(join(dir, "0002_a.sql"), "CREATE TABLE a (id int);");
    writeFileSync(join(dir, "0003_b.sql"), "CREATE TABLE b (a_id int);");
    const result = await migrate({ connectionString: db.url, dir });
    expect(result.applied).toEqual(["0002_a.sql", "0003_b.sql"]);
    expect(await tables(db.url)).toEqual(["a", "b", "oculus_migrations"]);
  });
});

describe("refusals", () => {
  it("refuses an applied file that was edited, and applies nothing", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_a.sql": "CREATE TABLE a (id int);" });
    await migrate({ connectionString: db.url, dir });
    writeFileSync(join(dir, "0002_a.sql"), "CREATE TABLE a (id int); -- edited");
    writeFileSync(join(dir, "0003_b.sql"), "CREATE TABLE b (id int);");
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("edited");
    expect(error.message).toContain("0002_a.sql");
    expect(await tables(db.url)).toEqual(["a", "oculus_migrations"]);
  });

  it("refuses a change of a single byte, such as line endings", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_a.sql": "CREATE TABLE a (id int);\n" });
    await migrate({ connectionString: db.url, dir });
    writeFileSync(join(dir, "0002_a.sql"), "CREATE TABLE a (id int);\r\n");
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("edited");
  });

  it("refuses when an applied file is missing", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_a.sql": "CREATE TABLE a (id int);" });
    await migrate({ connectionString: db.url, dir });
    rmSync(join(dir, "0002_a.sql"));
    writeFileSync(join(dir, "0003_b.sql"), "CREATE TABLE b (id int);");
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("missing");
    expect(await tables(db.url)).toEqual(["a", "oculus_migrations"]);
  });

  it("refuses a renamed applied file", async () => {
    const db = await database();
    const dir = migrationsDir({ "0002_a.sql": "CREATE TABLE a (id int);" });
    await migrate({ connectionString: db.url, dir });
    rmSync(join(dir, "0002_a.sql"));
    writeFileSync(join(dir, "0002_renamed.sql"), "CREATE TABLE a (id int);");
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("missing");
  });

  it("refuses a new file that sorts before an applied one", async () => {
    const db = await database();
    const dir = migrationsDir({ "0003_c.sql": "CREATE TABLE c (id int);" });
    await migrate({ connectionString: db.url, dir });
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id int);");
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("out_of_order");
    expect(error.message).toContain("0002_b.sql");
    expect(await tables(db.url)).toEqual(["c", "oculus_migrations"]);
  });

  it("refuses badly named, duplicate-numbered, empty and non-UTF-8 files before touching the database", async () => {
    const cases: [Record<string, string | Buffer>, string][] = [
      [{ "0002-a.sql": "SELECT 1;" }, "bad_file"],
      [{ "0002_A.sql": "SELECT 1;" }, "bad_file"],
      [{ "2_a.sql": "SELECT 1;" }, "bad_file"],
      [{ "0002_a.SQL": "SELECT 1;" }, "bad_file"],
      [{ "0002_a.sql.bak": "SELECT 1;" }, "bad_file"],
      [{ "README.md": "notes" }, "bad_file"],
      [{ "0002_a.sql": "SELECT 1;", "0002_b.sql": "SELECT 1;" }, "duplicate_number"],
      [{ "0002_a.sql": "  \n" }, "bad_file"],
      [{ "0002_a.sql": Buffer.from([0x53, 0xff, 0x3b]) }, "bad_file"],
    ];
    for (const [files, code] of cases) {
      const error = await refusal(readMigrations(migrationsDir(files)));
      expect(error.code).toBe(code);
    }
    const db = await database();
    const error = await refusal(
      migrate({ connectionString: db.url, dir: migrationsDir({ "0002-a.sql": "SELECT 1;" }) }),
    );
    expect(error.code).toBe("bad_file");
    expect(await tables(db.url)).toEqual([]);
  });

  it("rolls back a failing file completely and stops there", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_a.sql": "CREATE TABLE a (id int);",
      "0003_bad.sql": "CREATE TABLE half (id int);\nINSERT INTO nowhere VALUES (1);",
      "0004_c.sql": "CREATE TABLE c (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("0003_bad.sql");
    expect(await tables(db.url)).toEqual(["a", "oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual([
      "0001_migrations_table.sql",
      "0002_a.sql",
    ]);
  });

  it("refuses a file that commits or rolls back the runner's transaction", async () => {
    for (const body of [
      "CREATE TABLE early (id int);\nCOMMIT;\nCREATE TABLE late (id int);",
      "ROLLBACK;\nCREATE TABLE late (id int);",
      "COMMIT;\nBEGIN;\nCREATE TABLE late (id int);",
    ]) {
      const db = await database();
      const dir = migrationsDir({ "0002_escape.sql": body });
      const error = await refusal(migrate({ connectionString: db.url, dir }));
      expect(error.code).toBe("transaction_ended");
      expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
    }
  });

  it.each([
    ["COMMIT", "CREATE TABLE early (id int);\nCOMMIT;\nSELECT * FROM nowhere;"],
    ["COMMIT; BEGIN", "CREATE TABLE early (id int);\nCOMMIT;\nBEGIN;\nSELECT * FROM nowhere;"],
    ["COMMIT AND CHAIN", "CREATE TABLE early (id int);\nCOMMIT AND CHAIN;\nSELECT * FROM nowhere;"],
    [
      "END; START TRANSACTION",
      "CREATE TABLE early (id int);\nEND;\nSTART TRANSACTION;\nSELECT * FROM nowhere;",
    ],
  ])(
    "reports a file that ends the transaction with %s and then fails as transaction_ended, and stops",
    async (_form, body) => {
      const db = await database();
      const dir = migrationsDir({
        "0002_escape.sql": body,
        "0003_after.sql": "CREATE TABLE after (id int);",
      });
      const error = await refusal(migrate({ connectionString: db.url, dir }));
      expect(error.code).toBe("transaction_ended");
      expect(error.message).toMatch(/a person must check/);
      // What the file committed stays; it isn't recorded and nothing after it ran.
      expect(await tables(db.url)).toEqual(["early", "oculus_migrations"]);
      expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
      // A later run doesn't carry on as if nothing happened.
      expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("failed");
      expect(await tables(db.url)).toEqual(["early", "oculus_migrations"]);
    },
  );

  it("reports a file that rolls back and then fails as failed: nothing of it stays", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_rollback.sql": "CREATE TABLE gone (id int);\nROLLBACK;\nBEGIN;\nSELECT * FROM nowhere;",
    });
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("failed");
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
  });

  it("clears a file's prepared statements and temporary tables before the next file", async () => {
    const db = await database();
    const dir = migrationsDir({
      // A temporary table and a role change that would otherwise catch the
      // runner's INSERT; a prepared statement that would otherwise linger.
      "0002_tricks.sql":
        "CREATE TEMP TABLE oculus_migrations (name text, sha256 text);\nPREPARE lingering AS SELECT 1;\nSET search_path = pg_temp, public;",
      "0003_next.sql": "PREPARE lingering AS SELECT 2;\nCREATE TABLE t3 (id int);",
    });
    const result = await migrate({ connectionString: db.url, dir });
    expect(result.applied).toHaveLength(3);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(result.applied);
    expect(await tables(db.url)).toEqual(["oculus_migrations", "t3"]);
  });

  it("doesn't let one file's settings reach the next file or the runner", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_settings.sql":
        "CREATE SCHEMA elsewhere;\nCREATE TABLE elsewhere.oculus_migrations (name text, sha256 text);\nSET search_path = elsewhere;\nSET statement_timeout = 1;",
      "0003_table.sql": "SELECT pg_sleep(0.05);\nCREATE TABLE t3 (id int);",
    });
    const result = await migrate({ connectionString: db.url, dir });
    expect(result.applied).toEqual([
      "0001_migrations_table.sql",
      "0002_settings.sql",
      "0003_table.sql",
    ]);
    expect(await tables(db.url)).toEqual(["oculus_migrations", "t3"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(result.applied);
    expect((await migrate({ connectionString: db.url, dir })).applied).toEqual([]);
  });

  it("refuses a first file that doesn't create the bookkeeping table", async () => {
    const db = await database();
    const dir = mkdtempSync(join(tmpdir(), "oculus-migrations-"));
    dirs.push(dir);
    writeFileSync(join(dir, "0001_other.sql"), "CREATE TABLE other (id int);");
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(await tables(db.url)).toEqual([]);
  });

  it("checks the server version: below 15 refused, above 19 warned", () => {
    expect(() => checkServerVersion(140013)).toThrow(MigrationError);
    expect(() => checkServerVersion(90624)).toThrow(/not supported/);
    expect(() => checkServerVersion(Number.NaN)).toThrow(MigrationError);
    expect(() => checkServerVersion(0)).toThrow(MigrationError);
    expect(checkServerVersion(150000)).toBeUndefined();
    expect(checkServerVersion(160015)).toBeUndefined();
    expect(checkServerVersion(190000)).toBeUndefined();
    expect(checkServerVersion(200001)).toMatch(/newer than any version/);
  });

  it("compares applied rows with files without a database", () => {
    const files = [
      { name: "0001_a.sql", sha256: "1".repeat(64), text: "x" },
      { name: "0002_b.sql", sha256: "2".repeat(64), text: "x" },
    ];
    expect(pendingMigrations(files, []).map((f) => f.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(
      pendingMigrations(files, [{ name: "0001_a.sql", sha256: "1".repeat(64) }]).map((f) => f.name),
    ).toEqual(["0002_b.sql"]);
    expect(() =>
      pendingMigrations(files, [{ name: "0001_a.sql", sha256: "f".repeat(64) }]),
    ).toThrow(/edited/);
    expect(() =>
      pendingMigrations(files, [{ name: "0002_b.sql", sha256: "2".repeat(64) }]),
    ).toThrow(/sorts before/);
  });
});

describe("two runners at once", () => {
  let db: TestDatabase;
  beforeEach(async () => {
    db = await database();
  });

  it("applies each file exactly once", async () => {
    const files: Record<string, string> = {};
    for (let i = 2; i <= 6; i++) {
      const n = String(i).padStart(4, "0");
      // A plain CREATE TABLE fails if it runs twice, so a double apply can't hide.
      files[`${n}_t${String(i)}.sql`] =
        `CREATE TABLE t${String(i)} (id int); SELECT pg_sleep(0.02);`;
    }
    const dir = migrationsDir(files);
    const runs = await Promise.all([
      migrate({ connectionString: db.url, dir }),
      migrate({ connectionString: db.url, dir }),
      migrate({ connectionString: db.url, dir }),
    ]);
    const all = runs.flatMap((r) => r.applied).sort();
    expect(all).toEqual(["0001_migrations_table.sql", ...Object.keys(files)].sort());
    expect(runs.filter((r) => r.applied.length > 0)).toHaveLength(1);
    expect(await recorded(db.url)).toHaveLength(6);
  });

  it("waits for a runner holding the lock, and gives up after the lock timeout", async () => {
    const holder = await openSession(db.url);
    try {
      await holder.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
      const error = await refusal(migrate({ connectionString: db.url, lockTimeoutMs: 200 }));
      expect(error.code).toBe("lock_timeout");
      expect(await tables(db.url)).toEqual([]);

      let finished = false;
      const waiting = migrate({ connectionString: db.url, lockTimeoutMs: 20_000 }).then((r) => {
        finished = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      expect(await tables(db.url)).toEqual([]);
      await holder.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
      expect((await waiting).applied).toEqual(["0001_migrations_table.sql"]);
    } finally {
      await holder.close();
    }
  });

  it("releases the lock after a refusal", async () => {
    const dir = migrationsDir({ "0002_bad.sql": "SELECT * FROM nowhere;" });
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("failed");
    const result = await migrate({ connectionString: db.url, lockTimeoutMs: 1000 });
    expect(result.applied).toEqual([]);
  });
});

describe("npm run db:migrate", () => {
  it("needs OCULUS_DATABASE_URL and never prints it", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runMigrateCli(
        {},
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/OCULUS_DATABASE_URL is not set/);

    const db = await database();
    const url = db.url;
    expect(
      await runMigrateCli(
        { OCULUS_DATABASE_URL: url },
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/Applied 0001_migrations_table.sql/);
    expect(await tables(url)).toEqual(["oculus_migrations"]);

    const bad = url.replace(/\/oculus_test_[0-9a-f]+/, "/oculus_test_missing");
    expect(
      await runMigrateCli(
        { OCULUS_DATABASE_URL: bad },
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(1);
    for (const line of [...out, ...err]) {
      expect(line).not.toContain(url);
      expect(line).not.toContain(bad);
    }
  });
});
