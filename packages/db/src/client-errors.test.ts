// A transaction whose connection dies while it awaits something other than a
// query (D-068 review): no uncaught 'error' from the checked-out client, a
// clean ConnectionLostError, and the pool throws the client away and keeps
// working.
import { afterAll, describe, expect, it } from "vitest";
import { ConnectionLostError, openDatabase, type Database } from "./client.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

let testDb: TestDatabase | undefined;
const pools: Database[] = [];

afterAll(async () => {
  for (const p of pools) await p.close();
  await testDb?.drop();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a transaction's connection lost mid-way", () => {
  it("fails cleanly, with no uncaught exception, and the pool recovers", async () => {
    testDb = await freshDatabase();
    const db = openDatabase(testDb.url, { max: 1 });
    const killer = openDatabase(testDb.url, { max: 1 });
    pools.push(db, killer);
    const uncaught: unknown[] = [];
    const record = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on("uncaughtException", record);
    try {
      const run = db.transaction(async (q) => {
        const rows = await q.rows<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        const pid = rows[0]?.pid;
        await killer.rows(sql`SELECT pg_terminate_backend(${pid ?? 0})`);
        // Awaiting a timer, not a query, while the server ends the session.
        await sleep(300);
        await q.rows(sql`SELECT 1`);
        return "finished";
      });
      const error = await run.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectionLostError);
      expect(error).toMatchObject({ code: "08006" });
      expect((error as Error).message).toBe(
        "The database connection was lost during a transaction.",
      );
      await sleep(50);
      expect(uncaught).toEqual([]);
      // The broken client was discarded: the pool of one still works.
      expect(await db.rows(sql`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
      expect(await db.transaction((q) => q.rows(sql`SELECT 2 AS two`))).toEqual([{ two: 2 }]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
