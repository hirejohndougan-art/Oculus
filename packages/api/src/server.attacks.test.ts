// Attack tests for D-051 rules 7 and 8: timeouts and error replies without
// internals; plus the health check and start-up options.
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Refusal, errorReply } from "./errors.js";
import { SERVER_TIMEOUTS, buildServer } from "./server.js";
import { SAME_ORIGIN, TEST_ENV, testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health check", () => {
  it("answers GET /health and nothing more", async () => {
    app = await buildServer({ env: TEST_ENV });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("timeouts", () => {
  it("are explicit and shorter than Node's and Fastify's defaults", async () => {
    app = await buildServer({ env: TEST_ENV });
    const server = app.server;
    expect(server.requestTimeout).toBe(SERVER_TIMEOUTS.request);
    expect(server.headersTimeout).toBe(SERVER_TIMEOUTS.headers);
    expect(server.keepAliveTimeout).toBe(SERVER_TIMEOUTS.keepAlive);
    expect(server.timeout).toBe(SERVER_TIMEOUTS.connection);
    expect(server.requestTimeout).toBeLessThan(300_000);
    expect(server.headersTimeout).toBeLessThan(60_000);
    expect(server.keepAliveTimeout).toBeLessThanOrEqual(5_000);
    expect(server.timeout).toBeGreaterThan(0);
    // Fastify's types don't list handlerTimeout on initialConfig yet.
    expect((app.initialConfig as { handlerTimeout?: number }).handlerTimeout).toBe(
      SERVER_TIMEOUTS.handler,
    );
  });

  it("refuses longer or nonsense timeouts", async () => {
    await expect(buildServer({ env: TEST_ENV, timeouts: { request: 600_000 } })).rejects.toThrow(
      /timeouts.request/,
    );
    await expect(buildServer({ env: TEST_ENV, timeouts: { headers: 0 } })).rejects.toThrow(
      /timeouts.headers/,
    );
    await expect(buildServer({ env: TEST_ENV, timeouts: { handler: 1.5 } })).rejects.toThrow(
      /timeouts.handler/,
    );
  });

  it("answers a handler that runs too long with 503 and nothing from it", async () => {
    const built = await testServer({ timeouts: { handler: 50 } }, [
      {
        method: "GET",
        path: "/slow",
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { secret: "late" };
        },
      },
    ]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/slow" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
  });

  it("drops a client that sends headers too slowly (slowloris)", async () => {
    app = await buildServer({ env: TEST_ENV, timeouts: { headers: 300, request: 300 } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const started = Date.now();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
      socket.on("close", () => {
        resolve(text);
      });
      socket.on("error", reject);
      socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
      // ...and never finishes the headers.
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reply).not.toContain("200 OK");
  }, 10_000);
});

describe("error replies", () => {
  it.each([
    [
      "a request line Node can't parse",
      "GET /health HTTP/1.1\r\nHost: localhost\r\nBad Header\r\n\r\n",
      400,
      "bad_request",
    ],
    [
      "oversized headers",
      `GET /health HTTP/1.1\r\nHost: localhost\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`,
      431,
      "headers_too_large",
    ],
    [
      "Content-Length with Transfer-Encoding",
      "POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      400,
      "bad_request",
    ],
  ])("answers %s with the same error shape", async (_name, text, status, code) => {
    app = await buildServer({ env: TEST_ENV });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let out = "";
      socket.on("data", (chunk: Buffer) => (out += chunk.toString("latin1")));
      socket.on("close", () => {
        resolve(out);
      });
      socket.on("error", reject);
      socket.write(text);
    });
    expect(response.startsWith(`HTTP/1.1 ${String(status)} `)).toBe(true);
    expect(response.slice(response.indexOf("\r\n\r\n") + 4)).toBe(JSON.stringify({ error: code }));
    expect(response).not.toMatch(/Client Error|message|statusCode/);
  });

  it("never include a message or stack trace from a thrown error", async () => {
    const thrower = (error: unknown) => (): never => {
      throw error;
    };
    const built = await testServer({}, [
      {
        method: "GET",
        path: "/boom",
        handler: thrower(new Error("db password is hunter2 at /srv/oculus/secret.ts:12")),
      },
      {
        method: "GET",
        path: "/boom-async",
        handler: async () => {
          await Promise.resolve();
          throw Object.assign(new Error("internal detail"), { statusCode: 500, code: "E_SECRET" });
        },
      },
      {
        method: "GET",
        path: "/client-error",
        handler: thrower(
          Object.assign(new Error("user 42 has no access to record DS5C740001"), {
            statusCode: 403,
          }),
        ),
      },
      { method: "GET", path: "/refused", handler: thrower(new Refusal(403, "no_access")) },
      {
        method: "GET",
        path: "/weird-status",
        handler: thrower(Object.assign(new Error("odd"), { statusCode: 999 })),
      },
      {
        method: "GET",
        path: "/not-error",
        handler: thrower({ stack: "at secret()", message: "leak" }),
      },
    ]);
    app = built.app;
    for (const [url, status, code] of [
      ["/boom", 500, "internal_error"],
      ["/boom-async", 500, "internal_error"],
      // Only a Refusal chooses its status; any other thrown value is a 500 (D-058).
      ["/client-error", 500, "internal_error"],
      ["/refused", 403, "no_access"],
      ["/weird-status", 500, "internal_error"],
      ["/not-error", 500, "internal_error"],
    ] as const) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(status);
      expect(res.json(), url).toEqual({ error: code });
      expect(res.body).not.toMatch(/hunter2|secret|stack|at |detail|user 42|E_SECRET|leak/);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("keeps refusals' codes and maps other client errors to a generic code", () => {
    expect(errorReply(new Refusal(400, "bad_path"))).toEqual({
      statusCode: 400,
      body: { error: "bad_path" },
    });
    expect(errorReply(Object.assign(new Error("x"), { statusCode: 413 }))).toEqual({
      statusCode: 413,
      body: { error: "payload_too_large" },
    });
    expect(errorReply(Object.assign(new Error("x"), { statusCode: 418 })).body).toEqual({
      error: "bad_request",
    });
    expect(errorReply(null)).toEqual({ statusCode: 500, body: { error: "internal_error" } });
    expect(errorReply("text")).toEqual({ statusCode: 500, body: { error: "internal_error" } });
  });

  it("logs method and path only, never the query, cookies or body", async () => {
    const lines: string[] = [];
    app = await buildServer({
      env: TEST_ENV,
      logger: { stream: { write: (line: string) => void lines.push(line) } },
      routes: [
        {
          method: "POST",
          path: "/boom",
          handler: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    await app.inject({
      method: "POST",
      url: "/boom?token=sekrit-query",
      headers: {
        ...SAME_ORIGIN,
        "content-type": "application/json",
        cookie: "__Host-oculus_session=sekrit-cookie",
      },
      payload: '{"password":"sekrit-body"}',
    });
    const all = lines.join("\n");
    expect(all).toContain('"url":"/boom"');
    expect(all).toContain("kaboom");
    // A fixed-shape record with the thrown error's own stack, read without its getters.
    expect(all).toContain(
      '"failure":{"status":500,"code":"internal_error","name":"Error","message":"kaboom","stack":"Error: kaboom',
    );
    expect(all).not.toContain("sekrit");
  });
});
