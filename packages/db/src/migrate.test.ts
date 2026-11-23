// The migration runner: every migration on a fresh database, the refusals
// (edited, missing, out-of-order and badly named files, old servers, files
// that end the transaction or the lock's connection, failures at COMMIT), and
// two runners at once (the advisory lock, held on its own connection).
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
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

/** Every table the real migrations create, in name order. */
const ALL_TABLES = [
  "former_identifiers",
  "identifier_counters",
  "identifier_holdings",
  "identifier_types",
  "oculus_migrations",
  "organizations",
  "record_identifiers",
  "record_term_index",
  "record_terms",
  "record_type_versions",
  "record_types",
  "record_versions",
  "records",
  "template_versions",
  "templates",
  "terms",
];

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

const KEY = String(MIGRATION_LOCK_KEY);

/** The rows of the `probe` table a test file made. */
async function probe(url: string): Promise<{ taken: boolean }[]> {
  const db = openDatabase(url, { max: 1 });
  try {
    return await db.rows(sql`SELECT taken FROM probe`);
  } finally {
    await db.close();
  }
}

/** Waits until another session in this database is running a query containing `fragment`. */
async function waitForActivity(url: string, fragment: string): Promise<void> {
  const db = openDatabase(url, { max: 1 });
  try {
    for (let i = 0; i < 500; i++) {
      const [row] = await db.rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state = 'active' AND strpos(query, ${fragment}) > 0`,
      );
      if ((row?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No session ran ${fragment}`);
  } finally {
    await db.close();
  }
}

/**
 * A proxy in front of the test server that cuts a connection, both ways, when
 * the client sends a simple-protocol `COMMIT`. It listens on a Unix socket of
 * its own, which the returned URL names.
 */
async function commitDroppingProxy(url: string): Promise<{ url: string; close(): Promise<void> }> {
  const target = new URL(url);
  // The gate's server listens on a socket directory (`?host=`), CI's on TCP.
  const socketDir = target.searchParams.get("host");
  const port = target.port === "" ? "5432" : target.port;
  const host = socketDir ?? target.hostname;
  const upstreamOf = (): Socket =>
    host.startsWith("/") ? connect(join(host, `.s.PGSQL.${port}`)) : connect(Number(port), host);
  const dir = mkdtempSync(join(tmpdir(), "oculus-proxy-"));
  dirs.push(dir);
  const commit = Buffer.concat([Buffer.from("COMMIT"), Buffer.from([0])]);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = upstreamOf();
    sockets.add(client).add(upstream);
    client.on("data", (chunk: Buffer) => {
      if (chunk.includes(commit)) {
        client.destroy();
        upstream.destroy();
      } else {
        upstream.write(chunk);
      }
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(dir, `.s.PGSQL.${port}`), () => {
      server.off("error", reject);
      resolve();
    });
  });
  target.searchParams.set("host", dir);
  return {
    url: target.toString(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Runs `ALTER DATABASE <the test database> <change>`; new connections see it. */
async function alterDatabase(db: TestDatabase, change: string): Promise<void> {
  const session = await openSession(db.url);
  try {
    await session.runScript(`ALTER DATABASE ${db.name} ${change}`);
  } finally {
    await session.close();
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

  it("creates the bookkeeping table and the catalog tables, and nothing else", async () => {
    const db = await database();
    await migrate({ connectionString: db.url });
    expect(await tables(db.url)).toEqual(ALL_TABLES);
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

  it.each([
    [
      "ROLLBACK; BEGIN; CREATE; COMMIT",
      "ROLLBACK;\nBEGIN;\nCREATE TABLE early (id int);\nCOMMIT;\nSELECT * FROM nowhere;",
    ],
    [
      "ROLLBACK; CREATE; COMMIT",
      "ROLLBACK;\nCREATE TABLE early (id int);\nCOMMIT;\nSELECT * FROM nowhere;",
    ],
    [
      "ROLLBACK; CREATE; COMMIT; BEGIN",
      "ROLLBACK;\nCREATE TABLE early (id int);\nCOMMIT;\nBEGIN;\nSELECT * FROM nowhere;",
    ],
    [
      "ROLLBACK; CREATE; COMMIT; BEGIN; SAVEPOINT oculus_migration",
      "ROLLBACK;\nCREATE TABLE early (id int);\nCOMMIT;\nBEGIN;\nSAVEPOINT oculus_migration;\nSELECT * FROM nowhere;",
    ],
  ])(
    "reports a file that rolls back, commits something of its own (%s) and then fails as transaction_ended",
    async (_form, body) => {
      const db = await database();
      const dir = migrationsDir({ "0002_escape.sql": body });
      const error = await refusal(migrate({ connectionString: db.url, dir }));
      expect(error.code).toBe("transaction_ended");
      expect(await tables(db.url)).toEqual(["early", "oculus_migrations"]);
      expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
    },
  );

  it("reports a file that rolls back the runner's transaction and then fails as transaction_ended", async () => {
    // Nothing of this file stays, but once the runner's transaction is gone
    // the runner can't tell that from the cases above, so a person checks.
    const db = await database();
    const dir = migrationsDir({
      "0002_rollback.sql": "CREATE TABLE gone (id int);\nROLLBACK;\nBEGIN;\nSELECT * FROM nowhere;",
    });
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe(
      "transaction_ended",
    );
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
  });

  it("reports a file that fails inside its own savepoints as failed, and rolls it all back", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_savepoints.sql":
        "CREATE TABLE a (id int);\nSAVEPOINT s1;\nCREATE TABLE b (id int);\nRELEASE SAVEPOINT s1;\nSAVEPOINT s2;\nSELECT * FROM nowhere;",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("nowhere");
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
  });

  it.each([
    ["and stops", ""],
    ["and then fails", "\nSELECT * FROM nowhere;"],
  ])(
    "refuses a file that prepares the runner's transaction (PREPARE TRANSACTION) %s, naming it",
    async (_form, tail) => {
      const db = await database();
      const session = await openSession(db.url);
      const gid = `oculus_test_${randomBytes(6).toString("hex")}`;
      try {
        // The test server allows prepared transactions (scripts/test-database.mjs;
        // CI sets it too). Without that this test fails; it is never skipped.
        const [setting] = await session.rows<{ n: string }>(
          sql`SELECT current_setting('max_prepared_transactions') AS n`,
        );
        expect(Number(setting?.n), "max_prepared_transactions must be above 0").toBeGreaterThan(0);
        const dir = migrationsDir({
          "0002_prepare.sql": `CREATE TABLE px (id int);\nPREPARE TRANSACTION '${gid}';${tail}`,
          "0003_after.sql": "CREATE TABLE after (id int);",
        });
        const error = await refusal(migrate({ connectionString: db.url, dir }));
        expect(error.code).toBe("transaction_ended");
        expect(error.message).toContain(`"${gid}"`);
        expect(error.message).toMatch(/COMMIT PREPARED or ROLLBACK PREPARED/);
        expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
        const prepared = await session.rows<{ gid: string }>(
          sql`SELECT gid FROM pg_prepared_xacts WHERE gid = ${gid}`,
        );
        expect(prepared).toEqual([{ gid }]);
      } finally {
        await session.runScript(`ROLLBACK PREPARED '${gid}'`).catch(() => undefined);
        await session.close();
      }
      expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    },
  );

  it.each([
    ["pg_advisory_unlock_all()", "SELECT pg_advisory_unlock_all();"],
    ["pg_advisory_unlock(key)", `SELECT pg_advisory_unlock(${String(MIGRATION_LOCK_KEY)});`],
  ])(
    "doesn't let a file release the runner's lock with %s: the lock is on another connection",
    async (_form, unlock) => {
      const db = await database();
      const dir = migrationsDir({
        // After the unlock, a lock another session holds can't be taken.
        "0002_unlock.sql": `${unlock}\nCREATE TABLE probe AS SELECT pg_try_advisory_xact_lock(${KEY}) AS taken;`,
        "0003_after.sql": "CREATE TABLE after (id int);",
      });
      const result = await migrate({ connectionString: db.url, dir });
      expect(result.applied).toHaveLength(3);
      expect(await probe(db.url)).toEqual([{ taken: false }]);
    },
  );

  it.each([
    [
      "pg_advisory_unlock_all() and pg_advisory_xact_lock(key)",
      `SELECT pg_advisory_unlock_all();\nCREATE TABLE probe AS SELECT pg_try_advisory_xact_lock(${KEY}) AS taken;`,
    ],
    [
      "pg_advisory_unlock_all() and pg_advisory_lock_shared(key)",
      `SELECT pg_advisory_unlock_all();\nCREATE TABLE probe AS SELECT pg_try_advisory_lock_shared(${KEY}) AS taken;`,
    ],
  ])("doesn't let a file swap the runner's lock for its own with %s", async (_form, body) => {
    const db = await database();
    const dir = migrationsDir({ "0002_swap.sql": body });
    const result = await migrate({ connectionString: db.url, dir });
    expect(result.applied).toHaveLength(2);
    // The runner's lock was held, by another session, all through the file.
    expect(await probe(db.url)).toEqual([{ taken: false }]);
  });

  it.each([
    ["succeeds", "CREATE TABLE k (id int);"],
    ["then fails", "CREATE TABLE k (id int);\nSELECT * FROM nowhere;"],
  ])(
    "stops with lock_lost when a file ends the runner's lock connection and %s",
    async (_form, tail) => {
      const db = await database();
      const dir = migrationsDir({
        "0002_kill.sql": `SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid();\n${tail}`,
        "0003_after.sql": "CREATE TABLE after (id int);",
      });
      const error = await refusal(migrate({ connectionString: db.url, dir }));
      expect(error.code).toBe("lock_lost");
      expect(error.message).toContain("0002_kill.sql");
      expect(await tables(db.url)).toEqual(["oculus_migrations"]);
      expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
    },
  );

  it("keeps the lock through a file longer than the database's idle_session_timeout", async () => {
    const db = await database();
    await alterDatabase(db, "SET idle_session_timeout = '1s'");
    try {
      const dir = migrationsDir({
        "0002_long.sql": "SELECT pg_sleep(2);\nCREATE TABLE long_one (id int);",
        "0003_after.sql": "CREATE TABLE after (id int);",
      });
      const result = await migrate({ connectionString: db.url, dir });
      expect(result.applied).toEqual([
        "0001_migrations_table.sql",
        "0002_long.sql",
        "0003_after.sql",
      ]);
    } finally {
      await alterDatabase(db, "RESET idle_session_timeout");
    }
    expect((await recorded(db.url)).map((r) => r.name)).toHaveLength(3);
  });

  it("stops with lock_lost when the last file's deferred trigger ends the lock connection", async () => {
    // Without running deferred triggers before the last lock check, this
    // would end the lock at COMMIT and the run would report plain success.
    const db = await database();
    const dir = migrationsDir({
      "0002_late_kill.sql": `CREATE FUNCTION kill_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_terminate_backend(pid, 5000) FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'oculus-migrate-lock';
  RETURN NULL;
END $$;
CREATE TABLE k (id int);
CREATE CONSTRAINT TRIGGER k_kill AFTER INSERT ON k DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kill_lock();
INSERT INTO k VALUES (1);`,
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("lock_lost");
    expect(error.message).toContain("0002_late_kill.sql");
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("refuses a file whose deferred trigger deletes its own bookkeeping row", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_unrecord.sql": `CREATE FUNCTION unrecord() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.oculus_migrations WHERE name = NEW.name;
  RETURN NULL;
END $$;
CREATE TABLE marker (id int);
CREATE CONSTRAINT TRIGGER unrecord AFTER INSERT ON public.oculus_migrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION unrecord();`,
      "0003_after.sql": "CREATE TABLE after (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("transaction_ended");
    expect(error.message).toContain("0002_unrecord.sql");
    // Rolled back, not applied without its row.
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("stops with applied_not_recorded when a re-deferred trigger deletes the file's row at the runner's COMMIT", async () => {
    // r1's deferred trigger runs at SET CONSTRAINTS ALL IMMEDIATE, defers
    // everything again and queues r2's, which then runs at the COMMIT, after
    // the runner's last look at its row before the COMMIT.
    const db = await database();
    const dir = migrationsDir({
      "0002_redefer.sql": `CREATE FUNCTION unrecord_late() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.oculus_migrations WHERE name = '0002_redefer.sql';
  RETURN NULL;
END $$;
CREATE FUNCTION redefer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO r2 VALUES (1);
  RETURN NULL;
END $$;
CREATE TABLE r1 (id int);
CREATE TABLE r2 (id int);
CREATE CONSTRAINT TRIGGER r1_redefer AFTER INSERT ON r1 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION redefer();
CREATE CONSTRAINT TRIGGER r2_unrecord AFTER INSERT ON r2 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION unrecord_late();
INSERT INTO r1 VALUES (1);`,
      "0003_after.sql": "CREATE TABLE after (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("applied_not_recorded");
    expect(error.message).toContain("0002_redefer.sql was applied");
    expect(error.message).toMatch(/record it by hand/);
    expect(error.message).toMatch(/run stopped/);
    // Applied (its tables are there), not recorded, and nothing after it ran.
    expect(await tables(db.url)).toEqual(["oculus_migrations", "r1", "r2"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("reports a re-deferred foreign key that fails at the runner's COMMIT as failed, keeping nothing", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_late_fk.sql": `CREATE TABLE p (id int PRIMARY KEY);
CREATE TABLE c (p_id int REFERENCES p DEFERRABLE INITIALLY DEFERRED);
CREATE FUNCTION redefer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO c VALUES (1);
  RETURN NULL;
END $$;
CREATE TABLE r1 (id int);
CREATE CONSTRAINT TRIGGER r1_redefer AFTER INSERT ON r1 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION redefer();
INSERT INTO r1 VALUES (1);`,
      "0003_after.sql": "CREATE TABLE after (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("0002_late_fk.sql failed at COMMIT");
    expect(error.message).toMatch(/foreign key/);
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("doesn't lose the lock when a file locks pg_database", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_catalog.sql":
        "LOCK TABLE pg_catalog.pg_database IN ACCESS EXCLUSIVE MODE;\nCREATE TABLE c (id int);",
    });
    // A short lock timeout, so a check that waited on pg_database would fail fast.
    const result = await migrate({ connectionString: db.url, dir, lockTimeoutMs: 1000 });
    expect(result.applied).toEqual(["0001_migrations_table.sql", "0002_catalog.sql"]);
  });

  it("names the cause when the migrating role can't open its second connection", async () => {
    const db = await database();
    const role = `oculus_one_${randomBytes(6).toString("hex")}`;
    const admin = await openSession(db.url);
    try {
      // Superusers ignore connection limits, so an ordinary role.
      await admin.runScript(`CREATE ROLE ${role} LOGIN CONNECTION LIMIT 1`);
      const url = new URL(db.url);
      url.username = role;
      const error = await refusal(migrate({ connectionString: url.toString() }));
      expect(error.code).toBe("connection_failed");
      expect(error.message).toMatch(/second one/);
      expect(error.message).toMatch(/CONNECTION LIMIT/);
      expect((error.cause as { code?: string }).code).toBe("53300");
    } finally {
      try {
        await admin.runScript(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await admin.close();
      }
    }
    expect(await tables(db.url)).toEqual([]);
  });

  it("records a file normally while another application holds a prepared transaction", async () => {
    const db = await database();
    const other = await openSession(db.url);
    const gid = `other_app_${randomBytes(6).toString("hex")}`;
    try {
      const dir = migrationsDir({
        "0002_slow.sql": "CREATE TABLE slow (id int);\nSELECT pg_sleep(0.4);",
      });
      const running = migrate({ connectionString: db.url, dir });
      await waitForActivity(db.url, "pg_sleep(0.4)");
      // Another application prepares a transaction while the file runs.
      await other.control("BEGIN");
      await other.rows(sql`SELECT pg_current_xact_id()`);
      await other.runScript(`PREPARE TRANSACTION '${gid}'`);
      const result = await running;
      expect(result.applied).toEqual(["0001_migrations_table.sql", "0002_slow.sql"]);
      expect((await recorded(db.url)).map((r) => r.name)).toEqual(result.applied);
    } finally {
      await other.runScript(`ROLLBACK PREPARED '${gid}'`).catch(() => undefined);
      await other.close();
    }
  });

  it("names only the file's own prepared transaction, never another application's", async () => {
    const db = await database();
    const other = await openSession(db.url);
    const gid = `other_app_${randomBytes(6).toString("hex")}`;
    try {
      const dir = migrationsDir({
        "0002_escape.sql":
          "CREATE TABLE early (id int);\nCOMMIT;\nSELECT pg_sleep(0.4);\nSELECT * FROM nowhere;",
      });
      const running = refusal(migrate({ connectionString: db.url, dir }));
      await waitForActivity(db.url, "pg_sleep(0.4)");
      await other.control("BEGIN");
      await other.rows(sql`SELECT pg_current_xact_id()`);
      await other.runScript(`PREPARE TRANSACTION '${gid}'`);
      const error = await running;
      expect(error.code).toBe("transaction_ended");
      expect(error.message).not.toContain(gid);
      expect(error.message).not.toMatch(/PREPARED/);
    } finally {
      await other.runScript(`ROLLBACK PREPARED '${gid}'`).catch(() => undefined);
      await other.close();
    }
  });

  it("reports a deferred constraint that fails as failed, naming the file, before the runner's COMMIT", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_deferred.sql":
        "CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (p_id int REFERENCES p DEFERRABLE INITIALLY DEFERRED);\nINSERT INTO c VALUES (1);",
      "0003_after.sql": "CREATE TABLE after (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("0002_deferred.sql");
    expect(error.message).toMatch(/deferred constraints and triggers/);
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("refuses a file whose deferred trigger ends its own connection, recording nothing", async () => {
    // The trigger runs before the runner's COMMIT (SET CONSTRAINTS ALL
    // IMMEDIATE), so the connection is gone before anything is committed.
    const db = await database();
    const dir = migrationsDir({
      "0002_die.sql": `CREATE FUNCTION die() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_terminate_backend(pg_backend_pid());
  PERFORM pg_sleep(5);
  RETURN NULL;
END $$;
CREATE TABLE d (id int);
CREATE CONSTRAINT TRIGGER d_die AFTER INSERT ON d DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION die();
INSERT INTO d VALUES (1);`,
      "0003_after.sql": "CREATE TABLE after (id int);",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("transaction_ended");
    expect(error.message).toContain("0002_die.sql");
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("says the outcome is unknown when the connection is lost during the runner's COMMIT", async () => {
    const db = await database();
    const proxy = await commitDroppingProxy(db.url);
    try {
      const dir = migrationsDir({
        "0002_lost.sql": "CREATE TABLE lost (id int);",
        "0003_after.sql": "CREATE TABLE after (id int);",
      });
      const error = await refusal(migrate({ connectionString: proxy.url, dir }));
      expect(error.code).toBe("commit_unknown");
      // The first COMMIT the proxy sees is 0001's.
      expect(error.message).toContain("0001_migrations_table.sql");
      expect(error.message).toMatch(
        /a person must check whether 0001_migrations_table.sql is recorded/,
      );
      expect(await tables(db.url)).not.toContain("after");
    } finally {
      await proxy.close();
    }
  });

  it("reports a file that releases the runner's savepoint and then fails as transaction_ended, keeping nothing", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_release.sql":
        "CREATE TABLE r (id int);\nRELEASE SAVEPOINT oculus_migration;\nSELECT * FROM nowhere;",
    });
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe(
      "transaction_ended",
    );
    expect(await tables(db.url)).toEqual(["oculus_migrations"]);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
  });

  it("records a file that releases the runner's savepoint and succeeds", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_release.sql": "CREATE TABLE r (id int);\nRELEASE SAVEPOINT oculus_migration;",
    });
    expect((await migrate({ connectionString: db.url, dir })).applied).toHaveLength(2);
    expect(await tables(db.url)).toEqual(["oculus_migrations", "r"]);
  });

  it("blames the first migration only when the bookkeeping table is missing", async () => {
    const db = await database();
    const dir = migrationsDir({
      "0002_column.sql":
        "ALTER TABLE oculus_migrations ADD CONSTRAINT no_more CHECK (false) NOT VALID;",
    });
    const error = await refusal(migrate({ connectionString: db.url, dir }));
    expect(error.code).toBe("failed");
    expect(error.message).toMatch(/could not be recorded/);
    expect(error.message).not.toMatch(/first migration/);
    expect((await recorded(db.url)).map((r) => r.name)).toEqual(["0001_migrations_table.sql"]);
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
    expect(error.message).toMatch(/the first migration must create public.oculus_migrations/);
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
      const files = await readMigrations(defaultMigrationsDir());
      expect((await waiting).applied).toEqual(files.map((f) => f.name));
    } finally {
      await holder.close();
    }
  });

  it("reports a statement_timeout that ends the wait for the lock as lock_timeout", async () => {
    const holder = await openSession(db.url);
    await alterDatabase(db, "SET statement_timeout = '200ms'");
    try {
      await holder.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
      const error = await refusal(migrate({ connectionString: db.url, lockTimeoutMs: 20_000 }));
      expect(error.code).toBe("lock_timeout");
      expect(error.message).toMatch(/statement_timeout \(200ms\)/);
    } finally {
      await alterDatabase(db, "RESET statement_timeout");
      await holder.close();
    }
    expect(await tables(db.url)).toEqual([]);
  });

  it("reports a transaction_timeout (PostgreSQL 17+) that ends the wait for the lock as lock_timeout", async () => {
    const holder = await openSession(db.url);
    try {
      const [setting] = await holder.rows<{ t: string | null }>(
        sql`SELECT current_setting('transaction_timeout', true) AS t`,
      );
      const [version] = await holder.rows<{ v: string }>(
        sql`SELECT current_setting('server_version_num') AS v`,
      );
      if (Number(version?.v) < 170000) {
        // Before 17 the setting doesn't exist, and the runner leaves it alone.
        expect(setting?.t).toBeNull();
        return;
      }
      await alterDatabase(db, "SET transaction_timeout = '200ms'");
      try {
        await holder.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
        const error = await refusal(migrate({ connectionString: db.url, lockTimeoutMs: 20_000 }));
        expect(error.code).toBe("lock_timeout");
        expect(error.message).toMatch(/transaction_timeout \(200ms\)/);
      } finally {
        await alterDatabase(db, "RESET transaction_timeout");
      }
    } finally {
      await holder.close();
    }
    expect(await tables(db.url)).toEqual([]);
  });

  it("never runs files of two runners at once, even if a file swaps the lock for its own", async () => {
    const dir = migrationsDir({
      "0002_swap.sql": `SELECT pg_advisory_unlock_all();\nSELECT pg_try_advisory_xact_lock(${KEY});\nSELECT pg_sleep(0.4);`,
      "0003_t.sql": "SELECT pg_sleep(0.3);\nCREATE TABLE t3 (id int);",
    });
    let firstDone = false;
    const first = migrate({ connectionString: db.url, dir }).then((r) => {
      firstDone = true;
      return r;
    });
    await waitForActivity(db.url, "pg_sleep(0.4)");
    const second = migrate({ connectionString: db.url, dir, lockTimeoutMs: 20_000 }).then((r) => {
      // The second runner got the lock only after the first had finished.
      expect(firstDone).toBe(true);
      return r;
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.applied).toEqual(["0001_migrations_table.sql", "0002_swap.sql", "0003_t.sql"]);
    expect(b.applied).toEqual([]);
    expect(await recorded(db.url)).toHaveLength(3);
  });

  it("releases the lock after a refusal", async () => {
    const dir = migrationsDir({ "0002_bad.sql": "SELECT * FROM nowhere;" });
    expect((await refusal(migrate({ connectionString: db.url, dir }))).code).toBe("failed");
    const result = await migrate({
      connectionString: db.url,
      dir: migrationsDir(),
      lockTimeoutMs: 1000,
    });
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
    expect(await tables(url)).toEqual(ALL_TABLES);

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
