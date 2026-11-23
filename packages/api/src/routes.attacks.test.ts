// Attack tests for the narrow route API (D-058): routes can't carry their own
// error handlers, hooks, limits, timeouts or prefixes.
import { describe, expect, it } from "vitest";
import type { FastifyReply, RouteOptions } from "fastify";
import { CREDENTIALS_BODY_LIMIT, DEFAULT_BODY_LIMIT } from "./body.js";
import { checkRoute, oculusReply, routeOptionsProblem } from "./routes.js";

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
