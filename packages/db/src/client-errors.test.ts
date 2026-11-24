// A transaction whose connection dies while it awaits something other than a
// query (D-068 review): no uncaught 'error' from the checked-out client, a
// clean ConnectionLostError, and the pool throws the client away and keeps
// working.
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ConnectionLostError,
  createDatabase,
  dropDatabase,
  isDatabaseFailure,
  openDatabase,
  type Database,
} from "./client.js";
import { sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

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

describe("database failures and programming errors (S-016)", () => {
  it("tells the database's and the network's failures from programming errors", async () => {
    const coded = (code: string, extra: object = {}): Error =>
      Object.assign(new Error("x"), { code, ...extra });
    // The server's errors (SQLSTATE), a lost connection, socket errors, pg's own.
    for (const failure of [
      coded("57P01"),
      coded("XX000"),
      coded("40001"),
      new ConnectionLostError(new Error("gone")),
      coded("ECONNREFUSED", { syscall: "connect" }),
      coded("ENOENT", { syscall: "connect" }),
      coded("ECONNRESET", { syscall: "read" }),
      new Error("Connection terminated unexpectedly"),
      new Error("timeout exceeded when trying to connect"),
    ]) {
      expect({ failure: String(failure), is: isDatabaseFailure(failure) }).toEqual({
        failure: String(failure),
        is: true,
      });
    }
    // Programming errors: Node's ERR_* codes, a socket-like code with no
    // syscall, TypeErrors, plain errors, non-errors.
    for (const other of [
      coded("ERR_INVALID_ARG_TYPE"),
      coded("ERR_TLS_CERT_ALTNAME_INVALID", { syscall: "connect" }),
      coded("ECONNREFUSED"),
      coded("not_a_code"),
      new TypeError("Queries must be made with the sql tag."),
      new TypeError("Connection terminated unexpectedly"),
      new Error("Something else"),
      "57P01",
      undefined,
      null,
    ]) {
      expect({ other: String(other), is: isDatabaseFailure(other) }).toEqual({
        other: String(other),
        is: false,
      });
    }
    // A real one: a socket directory with no server in it.
    const nowhere = openDatabase("postgresql://nobody@localhost/nothing?host=%2Fnonexistent-s016");
    try {
      const error = await nowhere.rows(sql`SELECT 1`).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isDatabaseFailure(error)).toBe(true);
    } finally {
      await nowhere.close();
    }
  });

  it("createDatabase and dropDatabase listen for their connection's errors", async () => {
    const counts: number[] = [];
    const connect = vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (
      this: pg.Client,
    ) {
      counts.push(this.listenerCount("error"));
      throw Object.assign(new Error("refused"), { code: "57P03" });
    });
    try {
      await expect(createDatabase(testServerUrl(), "s016_never_made")).rejects.toThrow("refused");
      await expect(dropDatabase(testServerUrl(), "s016_never_made")).rejects.toThrow("refused");
    } finally {
      connect.mockRestore();
    }
    expect(counts).toEqual([1, 1]);
  });
});
