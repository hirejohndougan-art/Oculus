// openDatabase's session time limits (S-063): sent when each connection
// opens, overridden by a transaction's own SET LOCAL, ending a lock wait and
// a long statement with 55P03 and 57014, and refused when not a whole number
// of milliseconds from 1 to a day.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./client.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

let testDb: TestDatabase;
const pools: Database[] = [];

beforeAll(async () => {
  testDb = await freshDatabase();
});

afterAll(async () => {
  await Promise.allSettled(pools.map((p) => p.close()));
  await testDb.drop();
});

function pool(options: Parameters<typeof openDatabase>[1]): Database {
  const db = openDatabase(testDb.url, options);
  pools.push(db);
  return db;
}

async function setting(db: Database, name: string): Promise<string> {
  const rows = await db.rows<{ value: string }>(sql`SELECT current_setting(${name}) AS value`);
  return rows[0]?.value ?? "";
}

describe("openDatabase's time limits (S-063)", () => {
  it("sets them on every connection, and a transaction's SET LOCAL still wins", async () => {
    const db = pool({
      max: 2,
      lockTimeoutMillis: 1500,
      statementTimeoutMillis: 120_000,
      idleInTransactionTimeoutMillis: 600_000,
    });
    expect(await setting(db, "lock_timeout")).toBe("1500ms");
    expect(await setting(db, "statement_timeout")).toBe("2min");
    expect(await setting(db, "idle_in_transaction_session_timeout")).toBe("10min");
    const inside = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout', '250', true)`);
      const rows = await tx.rows<{ value: string }>(
        sql`SELECT current_setting('statement_timeout') AS value`,
      );
      return rows[0]?.value;
    });
    expect(inside).toBe("250ms");
    expect(await setting(db, "statement_timeout")).toBe("2min");
    // Left out: the server's own default.
    const plain = pool({ max: 1 });
    expect(await setting(plain, "lock_timeout")).toBe("0");
  });

  it("ends a lock wait with 55P03 and a long statement with 57014", async () => {
    const holder = pool({ max: 1 });
    const limited = pool({ max: 1, lockTimeoutMillis: 200, statementTimeoutMillis: 300 });
    await holder.execute(sql`CREATE TABLE held (id int PRIMARY KEY)`);
    await holder.execute(sql`INSERT INTO held VALUES (1)`);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: (() => void) | undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = holder.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM held WHERE id = 1 FOR UPDATE`);
      locked?.();
      await released;
    });
    await isLocked;
    const started = Date.now();
    const lockError = await limited.execute(sql`UPDATE held SET id = 1 WHERE id = 1`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(lockError).toMatchObject({ code: "55P03" });
    expect(Date.now() - started).toBeLessThan(5000);
    release?.();
    await holding;
    const longError = await limited.execute(sql`SELECT pg_sleep(5)`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(longError).toMatchObject({ code: "57014" });
    // The pool goes on working.
    expect(await limited.rows(sql`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
  });

  it("refuses a limit that isn't a whole number of milliseconds from 1 to a day", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001]) {
      for (const key of [
        "lockTimeoutMillis",
        "statementTimeoutMillis",
        "idleInTransactionTimeoutMillis",
      ] as const) {
        expect(() => openDatabase(testDb.url, { [key]: bad }), `${key} ${String(bad)}`).toThrow(
          new RangeError(`${key} must be a whole number of milliseconds from 1 to 86400000.`),
        );
      }
    }
  });
});
