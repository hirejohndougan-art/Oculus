// The staff pool's time limits (S-063): the options both the admin's server
// and the desktop launcher open the writer pool with, their effect on a real
// connection, and how a limit that runs out is answered over HTTP: 503
// `timeout` for a lock wait or a long statement, 503 `busy` for no free
// connection, and still a plain 500 for anything that only looks like one.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase, sql, type Database } from "@oculus/db";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { rebuildThrown } from "./errors.js";
import type { OculusRoute } from "./routes.js";
import {
  STAFF_IDLE_IN_TRANSACTION_MS,
  STAFF_LOCK_TIMEOUT_MS,
  STAFF_POOL_WAIT_MS,
  STAFF_QUERY_TIMEOUT_MS,
  STAFF_STATEMENT_TIMEOUT_MS,
  staffPoolOptions,
} from "./staff-pool.js";
import { rawRequest, testServer } from "./test-server.fixtures.js";

let testDb: TestDatabase;
const pools: Database[] = [];
let app: FastifyInstance | undefined;

beforeAll(async () => {
  testDb = await freshDatabase();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
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

/** What a request whose handler runs `work` gets back. */
async function answerFor(work: () => Promise<unknown>): Promise<{ status: number; body: string }> {
  const route: OculusRoute = { method: "GET", path: "/t", handler: () => work() };
  const built = await testServer({}, [route]);
  app = built.app;
  const res = await rawRequest(built.app, "GET", "/t");
  return { status: res.status, body: res.body };
}

describe("staffPoolOptions (S-063)", () => {
  it("bounds the wait for a connection, a lock, a statement and an idle transaction", () => {
    expect(staffPoolOptions("oculus-admin")).toEqual({
      applicationName: "oculus-admin",
      max: 10,
      connectionTimeoutMillis: STAFF_POOL_WAIT_MS,
      lockTimeoutMillis: STAFF_LOCK_TIMEOUT_MS,
      statementTimeoutMillis: STAFF_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMillis: STAFF_IDLE_IN_TRANSACTION_MS,
      queryTimeoutMillis: STAFF_QUERY_TIMEOUT_MS,
    });
    // Each wait ends before the 30 s handler limit answers for it, and the
    // client's own limit only fires past the server's.
    expect(STAFF_POOL_WAIT_MS).toBeLessThan(30_000);
    expect(STAFF_LOCK_TIMEOUT_MS).toBeLessThan(30_000);
    expect(STAFF_QUERY_TIMEOUT_MS).toBeGreaterThan(STAFF_STATEMENT_TIMEOUT_MS);
  });

  it("holds on a real connection, under its application name", async () => {
    const db = pool(staffPoolOptions("oculus-staff-test"));
    const rows = await db.rows<{
      lock: string;
      statement: string;
      idle: string;
      name: string;
    }>(sql`SELECT current_setting('lock_timeout') AS lock,
                  current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle,
                  current_setting('application_name') AS name`);
    expect(rows).toEqual([
      { lock: "10s", statement: "2min", idle: "10min", name: "oculus-staff-test" },
    ]);
  });
});

describe("a time limit that runs out, over HTTP (S-063)", () => {
  it("a lock wait past lock_timeout is 503 timeout", async () => {
    const holder = pool({ max: 1 });
    const staff = pool({ max: 1, lockTimeoutMillis: 200 });
    await holder.execute(sql`CREATE TABLE IF NOT EXISTS held (id int PRIMARY KEY)`);
    await holder.execute(sql`INSERT INTO held VALUES (1) ON CONFLICT DO NOTHING`);
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
    try {
      const res = await answerFor(() => staff.execute(sql`UPDATE held SET id = 1 WHERE id = 1`));
      expect(res).toEqual({ status: 503, body: '{"error":"timeout"}' });
    } finally {
      release?.();
      await holding;
    }
  });

  it("a statement past statement_timeout is 503 timeout", async () => {
    const staff = pool({ max: 1, statementTimeoutMillis: 100 });
    const res = await answerFor(() => staff.execute(sql`SELECT pg_sleep(3)`));
    expect(res).toEqual({ status: 503, body: '{"error":"timeout"}' });
  });

  it("no free connection within the pool's wait is 503 busy", async () => {
    const staff = pool({ max: 1, connectionTimeoutMillis: 100 });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: (() => void) | undefined;
    const isTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const holding = staff.transaction(async () => {
      taken?.();
      await released;
    });
    await isTaken;
    try {
      const res = await answerFor(() => staff.rows(sql`SELECT 1`));
      expect(res).toEqual({ status: 503, body: '{"error":"busy"}' });
    } finally {
      release?.();
      await holding;
    }
  });

  it("anything that only looks like a time limit stays a plain 500", () => {
    const internal = { statusCode: 500, code: "internal_error" };
    const looksLike: [string, unknown][] = [
      [
        "a code behind a getter",
        Object.defineProperty(new Error("x"), "code", { get: () => "57014" }),
      ],
      ["another SQLSTATE", Object.assign(new Error("x"), { code: "40001" })],
      ["a number code", Object.assign(new Error("x"), { code: 57014 })],
      [
        "the pool's message on an error with a code",
        Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ECONNRESET" }),
      ],
      [
        "the pool's message on a class of its own",
        new (class Sneaky extends Error {})("timeout exceeded when trying to connect"),
      ],
      [
        "the pool's message behind a getter",
        Object.defineProperty(new Error(), "message", {
          get: () => "timeout exceeded when trying to connect",
        }),
      ],
      [
        "pg's message for opening a connection too slowly (an outage)",
        new Error("Connection terminated due to connection timeout"),
      ],
      [
        "a Proxy",
        new Proxy(new Error("x"), {
          getOwnPropertyDescriptor: () => {
            throw new Error("trap");
          },
        }),
      ],
    ];
    for (const [what, thrown] of looksLike) {
      const rebuilt = rebuildThrown(thrown);
      expect({ statusCode: rebuilt.statusCode, code: rebuilt.code }, what).toEqual(internal);
    }
    const lock = rebuildThrown(Object.assign(new Error("x"), { code: "55P03" }));
    expect({ statusCode: lock.statusCode, code: lock.code }).toEqual({
      statusCode: 503,
      code: "timeout",
    });
  });
});
