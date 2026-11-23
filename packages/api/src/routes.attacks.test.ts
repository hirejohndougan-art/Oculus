// Attack tests for the narrow route API (D-058): routes can't carry their own
// error handlers, hooks, limits, timeouts or prefixes.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyReply, RouteOptions } from "fastify";
import { CREDENTIALS_BODY_LIMIT, DEFAULT_BODY_LIMIT } from "./body.js";
import { checkRoute, oculusReply, routeOptionsProblem, type OculusRoute } from "./routes.js";
import { buildServer } from "./server.js";
import { TEST_ENV } from "./test-server.fixtures.js";

const handler = () => ({});

function fastifyRoute(extra: Record<string, unknown>): RouteOptions {
  return {
    method: "GET",
    url: "/x",
    path: "/x",
    routePath: "/x",
    prefix: "",
    handler,
    ...extra,
  } as RouteOptions;
}

describe("routeOptionsProblem (onRoute)", () => {
  it("accepts what the narrow API registers", () => {
    expect(
      routeOptionsProblem(
        fastifyRoute({ config: { oculus: {} }, logLevel: "", attachValidation: false }),
      ),
    ).toBeUndefined();
    expect(
      routeOptionsProblem(
        fastifyRoute({
          bodyLimit: CREDENTIALS_BODY_LIMIT,
          config: { oculus: { credentials: true } },
        }),
      ),
    ).toBeUndefined();
    expect(
      routeOptionsProblem(fastifyRoute({ method: "HEAD", onSend: [() => undefined] })),
    ).toBeUndefined();
  });

  it.each([
    [{ errorHandler: () => "leak" }],
    [{ handlerTimeout: 600_000 }],
    [{ handlerTimeout: 1 }],
    [{ schema: { body: {} } }],
    [{ validatorCompiler: () => () => true }],
    [{ serializerCompiler: () => () => "" }],
    [{ schemaErrorFormatter: () => new Error("x") }],
    [{ childLoggerFactory: () => undefined }],
    [{ preParsing: [() => undefined] }],
    [{ onRequest: [() => undefined] }],
    [{ preHandler: [() => undefined] }],
    [{ onSend: [() => undefined] }],
    [{ onError: [() => undefined] }],
    [{ constraints: { host: "evil.example" } }],
    [{ exposeHeadRoute: false }],
    [{ prefix: "/admin" }],
    [{ attachValidation: true }],
    [{ bodyLimit: DEFAULT_BODY_LIMIT * 10 }],
    [{ bodyLimit: 1 }],
    [{ bodyLimit: DEFAULT_BODY_LIMIT, config: { oculus: { credentials: true } } }],
    [{ config: { oculus: { credentials: true } } }],
    [{ method: "TRACE" }],
    [{ method: "CONNECT" }],
    [{ method: "PROPFIND" }],
    [{ method: ["GET", "TRACE"] }],
  ])("refuses %j", (extra) => {
    expect(routeOptionsProblem(fastifyRoute(extra))).toBeDefined();
  });
});

describe("checkRoute", () => {
  it.each([
    [null],
    [{ method: "GET", path: "/x" }],
    [{ method: "TRACE", path: "/x", handler }],
    [{ method: "get", path: "/x", handler }],
    [{ method: "GET", path: 1, handler }],
    [{ method: "GET", path: "/x", handler, form: "yes" }],
    [{ method: "GET", path: "/x", handler, credentials: 1 }],
    [{ method: "GET", path: "/x", handler, prefix: "/a" }],
  ])("refuses %j", (route) => {
    expect(() => checkRoute(route)).toThrow();
  });
});

describe("checkRoute's copy", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A route whose `method` says GET when checked and something else afterwards. */
  function shiftingRoute(later: string): { route: OculusRoute; reads: () => number } {
    let reads = 0;
    const route = {
      get method() {
        reads++;
        return reads === 1 ? "GET" : later;
      },
      path: "/shift",
      handler: () => ({ ok: true }),
    } as unknown as OculusRoute;
    return { route, reads: () => reads };
  }

  it("reads each field once and returns a frozen copy", () => {
    const { route, reads } = shiftingRoute("TRACE");
    const copy = checkRoute(route);
    expect(reads()).toBe(1);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(copy === route).toBe(false);
    expect(copy.method).toBe("GET");
    expect(copy.method).toBe("GET");
    expect(reads()).toBe(1);
  });

  it.each(["TRACE", "PROPFIND", "POST"])(
    "registers the method that was checked, not a getter's later %s",
    async (later) => {
      const { route } = shiftingRoute(later);
      app = await buildServer({ env: TEST_ENV, routes: [route] });
      const ok = await app.inject({ method: "GET", url: "/shift" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      const other = await app.inject({ method: later as "POST", url: "/shift" });
      expect(other.statusCode).not.toBe(200);
    },
  );
});

describe("oculusReply", () => {
  it.each([
    "Set-Cookie",
    "set-cookie",
    "SET-COOKIE",
    "Content-Length",
    "Transfer-Encoding",
    "Connection",
  ])("refuses to write %s", (name) => {
    const fake = { header: () => fake } as unknown as FastifyReply;
    expect(() => oculusReply(fake).header(name, "x")).toThrow(/not allowed/);
  });

  it("has no hijack, raw or plugin cookie writer", () => {
    const fake = { header: () => fake } as unknown as FastifyReply;
    const reply = oculusReply(fake) as unknown as Record<string, unknown>;
    expect(reply.hijack).toBeUndefined();
    expect(reply.raw).toBeUndefined();
    expect(Object.isFrozen(reply)).toBe(true);
    expect(() => oculusReply(fake).status(101)).toThrow();
  });
});
