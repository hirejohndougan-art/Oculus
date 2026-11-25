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
  isDatabaseTimeout,
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
      coded("53300"),
      coded("58P01"),
      coded("08001"),
      // A name lookup that failed for now (an underscore in the code).
      coded("EAI_AGAIN", { syscall: "getaddrinfo" }),
      // Node's dual-stack connect: an AggregateError with the code and no
      // syscall, or one whose errors are all socket failures.
      Object.assign(new AggregateError([], "connect failed"), { code: "ECONNREFUSED" }),
      new AggregateError(
        [coded("ECONNREFUSED", { syscall: "connect" }), coded("ETIMEDOUT", { syscall: "connect" })],
        "connect failed",
      ),
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
      coded("ERR_SOCKET_BAD_PORT", { syscall: "connect" }),
      // Programming and data errors the server reports are not outages.
      coded("42601"),
      coded("42P01"),
      coded("42501"),
      coded("23505"),
      coded("22012"),
      coded("P0001"),
      new AggregateError(
        [coded("ECONNREFUSED", { syscall: "connect" }), new TypeError("x")],
        "mixed",
      ),
      new AggregateError([], "empty"),
      Object.assign(new AggregateError([], "bug"), { code: "ERR_INVALID_ARG_TYPE" }),
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

describe("isDatabaseTimeout (S-037)", () => {
  it("is true for a cancelled statement and pg-pool's waits, and for nothing else", () => {
    expect(
      isDatabaseTimeout(Object.assign(new Error("canceling statement"), { code: "57014" })),
    ).toBe(true);
    expect(isDatabaseTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
    // Opening a new connection too slowly is an outage, not load.
    expect(isDatabaseTimeout(new Error("Connection terminated due to connection timeout"))).toBe(
      false,
    );
    // Other failures are failures, not timeouts.
    expect(isDatabaseTimeout(Object.assign(new Error("x"), { code: "57P01" }))).toBe(false);
    expect(isDatabaseTimeout(Object.assign(new Error("x"), { code: "08006" }))).toBe(false);
    expect(isDatabaseTimeout(new Error("Connection terminated"))).toBe(false);
    expect(isDatabaseTimeout(new ConnectionLostError(new Error("gone")))).toBe(false);
    // Our own errors and look-alikes are not pg's.
    expect(isDatabaseTimeout(new TypeError("timeout exceeded when trying to connect"))).toBe(false);
    expect(
      isDatabaseTimeout(
        Object.assign(new Error("timeout exceeded when trying to connect"), { code: "X" }),
      ),
    ).toBe(false);
    expect(isDatabaseTimeout({ message: "timeout exceeded when trying to connect" })).toBe(false);
    expect(isDatabaseTimeout(null)).toBe(false);
    expect(isDatabaseTimeout("57014")).toBe(false);
    // Every timeout is also a database failure (S-016).
    expect(isDatabaseFailure(Object.assign(new Error("c"), { code: "57014" }))).toBe(true);
    expect(isDatabaseFailure(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("a real pool past its connectionTimeoutMillis throws a timeout", async () => {
    testDb ??= await freshDatabase();
    const db = openDatabase(testDb.url, { max: 1, connectionTimeoutMillis: 100 });
    pools.push(db);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Holds the pool's only connection until released.
    const held = db.transaction(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          started();
        }),
    );
    await holding;
    try {
      const error = await db.rows(sql`SELECT 1`).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isDatabaseTimeout(error)).toBe(true);
    } finally {
      release();
      await held;
    }
    expect(await db.rows(sql`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
  });
});
