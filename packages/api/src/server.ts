/**
 * The Oculus HTTP server: Fastify 5 with the rules of D-051 and D-058 on top.
 *
 * `buildServer` returns a ready Fastify instance (call `listen` to serve, or
 * `inject` in tests). Its only route of its own is `GET /health`; the
 * application's routes come in `options.routes` as plain `OculusRoute`s
 * (routes.ts). Application code never gets the Fastify instance or reply, so
 * it can't add parsers, hooks or error handlers, raise limits, hijack replies
 * or write cookies around the writer; every route Fastify adds is checked
 * again in onRoute, and the instance is ready (closed to changes) on return.
 *
 * The rules, each with an attack test in this package:
 * 1. Bodies (body.ts): only Oculus's parsers: exact `application/json`, and
 *    `application/x-www-form-urlencoded` on form routes; 415 for any other
 *    type, a body without a type, and compressed bodies; prototype keys,
 *    repeated JSON keys and form fields, nesting deeper than 64, non-finite
 *    numbers, a byte order mark, bad UTF-8 and bad percent-encoding refused.
 * 2. Limits (body.ts, routes.ts): counted in bytes, chunked bodies included:
 *    1 MiB by default, 8 KiB on credentials routes (sign-in, two-step, site
 *    password); routes can't choose their own.
 * 3. Paths (paths.ts): encoded slashes, backslashes, dots and unreserved
 *    characters, `.`/`..` segments, NUL and other control characters, double
 *    encoding and `//` refused with 400 in the first onRequest hook, before
 *    any handler. Unknown paths get 404 (an empty `:param` counts as
 *    unknown) and known paths with the wrong method 405 (with `Allow`); the
 *    router is case-sensitive and normalizes nothing.
 * 4. Cookies (cookies.ts): no cookie plugin; only Oculus's own names are
 *    read, an Oculus name sent twice is refused, and every `Set-Cookie` must
 *    be one the writer issued (`__Host-`, Secure, HttpOnly, SameSite Lax or
 *    Strict, Path=/, nothing else) or it is removed and the reply is a 500.
 * 5. Changes (origin.ts): every method other than GET and HEAD needs an
 *    `Origin` listed in `OCULUS_ORIGINS` and naming the request's host, or
 *    `Sec-Fetch-Site: same-origin`; else 403.
 * 6. Proxies (proxy.ts): `trustProxy` is off unless `OCULUS_TRUSTED_PROXY`
 *    names the proxy's addresses, in ranges no wider than D-058 allows.
 * 7. Timeouts: explicit and shorter than Node's and Fastify's defaults
 *    (`SERVER_TIMEOUTS`); options can only shorten them.
 * 8. Errors (errors.ts): `{ "error": "<code>" }` only, never a message or a
 *    stack trace, including requests Node itself can't parse; 5xx details go
 *    to the server log. The request logger records the method and path only.
 *
 * Adding another Fastify plugin, parser or error handler is its own decision
 * (D-051).
 */
import type { Socket } from "node:net";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  CREDENTIALS_BODY_LIMIT,
  DEFAULT_BODY_LIMIT,
  bodyHeaderProblem,
  registerBodyParsers,
} from "./body.js";
import { cookieHeaderProblem, replyCookieProblem } from "./cookies.js";
import { Refusal, errorReply } from "./errors.js";
import { failsOriginCheck, originsFromEnv } from "./origin.js";
import { RouteTable, pathOf, pathProblem } from "./paths.js";
import { trustedProxyFromEnv } from "./proxy.js";
import { checkRoute, oculusReply, routeOptionsProblem, type OculusRoute } from "./routes.js";

/** Milliseconds. Node's defaults: no socket timeout, 300 s request, 60 s headers. */
export interface ServerTimeouts {
  /** Idle socket. */
  readonly connection: number;
  /** The whole request, headers and body, must arrive within this. */
  readonly request: number;
  /** The headers must arrive within this (slow-header attacks). */
  readonly headers: number;
  /** Idle keep-alive connection between requests (Fastify's default is 72 s). */
  readonly keepAlive: number;
  /** A handler that runs longer is answered with 503. */
  readonly handler: number;
}

export const SERVER_TIMEOUTS: ServerTimeouts = {
  connection: 30_000,
  request: 30_000,
  headers: 10_000,
  keepAlive: 5_000,
  handler: 30_000,
};

/** How often Node checks the request and headers timeouts (its default is 30 s). */
const TIMEOUT_CHECK_INTERVAL = 1_000;
const MAX_PARAM_LENGTH = 100;

export interface ServerOptions {
  /** Where `OCULUS_ORIGINS` and `OCULUS_TRUSTED_PROXY` are read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Log requests (method and path only) and server errors, to standard output
   * or to the given stream. Off by default.
   */
  readonly logger?: boolean | { readonly stream: { write(line: string): void } };
  /** Shorter timeouts, for tests; a longer value is refused. */
  readonly timeouts?: Partial<ServerTimeouts>;
  /** The application's routes (routes.ts); nothing else can add one. */
  readonly routes?: readonly OculusRoute[];
}

function chooseTimeouts(overrides: Partial<ServerTimeouts> = {}): ServerTimeouts {
  const result = { ...SERVER_TIMEOUTS };
  for (const key of Object.keys(SERVER_TIMEOUTS) as (keyof ServerTimeouts)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0 || value > SERVER_TIMEOUTS[key]) {
      throw new Error(
        `timeouts.${key} must be a whole number from 1 to ${String(SERVER_TIMEOUTS[key])}`,
      );
    }
    result[key] = value;
  }
  // Node requires the headers timeout to be no longer than the request timeout.
  return { ...result, headers: Math.min(result.headers, result.request) };
}

/** The first rule an incoming request breaks, checked before routing's handler. */
function requestRefusal(
  request: FastifyRequest,
  origins: ReadonlySet<string>,
): Refusal | undefined {
  if (pathProblem(request.raw.url) !== undefined) return new Refusal(400, "bad_path");
  // The router lets `/items/` reach `/items/:id` with an empty id; treat it as unknown.
  const params = (request.params ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(params)) {
    if (name !== "*" && value === "") return new Refusal(404, "not_found");
  }
  const refusal = bodyHeaderProblem(request) ?? cookieHeaderProblem(request.headers.cookie);
  if (refusal !== undefined) return refusal;
  if (failsOriginCheck(request, origins)) return new Refusal(403, "cross_origin");
  return undefined;
}

const CLIENT_ERRORS: Readonly<Record<string, readonly [number, string, string]>> = {
  HPE_HEADER_OVERFLOW: [431, "headers_too_large", "Request Header Fields Too Large"],
  ERR_HTTP_REQUEST_TIMEOUT: [408, "request_timeout", "Request Timeout"],
};

/** Requests Node can't parse: the same `{ "error": code }` shape, then close. */
function clientError(error: { code?: string }, socket: Socket): void {
  if (error.code === "ECONNRESET" || !socket.writable) {
    socket.destroy();
    return;
  }
  const [status, code, reason] = CLIENT_ERRORS[error.code ?? ""] ?? [
    400,
    "bad_request",
    "Bad Request",
  ];
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      "Cache-Control: no-store\r\nConnection: close\r\n\r\n" +
      body,
  );
}

function addRoute(app: FastifyInstance, route: OculusRoute): void {
  const credentials = route.credentials === true;
  app.route({
    method: route.method,
    url: route.path,
    ...(credentials ? { bodyLimit: CREDENTIALS_BODY_LIMIT } : {}),
    config: { oculus: { form: route.form === true, credentials } },
    handler: async (request, reply) => {
      const result = await route.handler(request, oculusReply(reply));
      return result === undefined ? reply.send() : result;
    },
  });
}

/** Builds the configured Oculus server and waits until it is ready. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const timeouts = chooseTimeouts(options.timeouts);
  const env = options.env ?? process.env;
  const trustProxy = trustedProxyFromEnv(env);
  const origins = originsFromEnv(env);
  const appRoutes = (options.routes ?? []).map(checkRoute);

  const logger: FastifyServerOptions["logger"] =
    options.logger === undefined || options.logger === false
      ? false
      : {
          level: "info",
          ...(options.logger === true ? {} : { stream: options.logger.stream }),
          serializers: {
            // Method and path only: no query string, headers, cookies or address.
            req: (req) => ({ method: req.method, url: pathOf(req.url) }),
          },
        };

  const app: FastifyInstance = Fastify({
    logger,
    trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    connectionTimeout: timeouts.connection,
    requestTimeout: timeouts.request,
    keepAliveTimeout: timeouts.keepAlive,
    handlerTimeout: timeouts.handler,
    http: {
      headersTimeout: timeouts.headers,
      connectionsCheckingInterval: TIMEOUT_CHECK_INTERVAL,
    },
    requestIdHeader: false,
    exposeHeadRoutes: true,
    return503OnClosing: true,
    allowErrorHandlerOverride: false,
    routerOptions: {
      caseSensitive: true,
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      allowUnsafeRegex: false,
      // useSemicolonDelimiter stays at its default, false (Fastify's types
      // don't list it here); paths.attacks.test.ts checks it.
      maxParamLength: MAX_PARAM_LENGTH,
    },
    frameworkErrors: (_error, _request, reply) => {
      // A URL the router can't decode; the reply type here is generic.
      const plain = reply as FastifyReply;
      void plain.code(400).header("cache-control", "no-store").send({ error: "bad_request" });
    },
    clientErrorHandler: clientError,
  });

  const routes = new RouteTable(MAX_PARAM_LENGTH);

  registerBodyParsers(app);

  app.addHook("onRoute", (route) => {
    const problem = routeOptionsProblem(route);
    if (problem !== undefined)
      throw new Error(`${route.method.toString()} ${route.url}: ${problem}`);
    routes.add(route.method, route.url);
  });

  // Rule 3 first: nothing else looks at a refused path.
  app.addHook("onRequest", (request, _reply, done) => {
    done(requestRefusal(request, origins));
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    if (replyCookieProblem(reply, reply.getHeader("set-cookie")) !== undefined) {
      reply.removeHeader("set-cookie");
      throw new Error("a Set-Cookie header broke the cookie rules");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = errorReply(error);
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    return reply
      .code(statusCode)
      .type("application/json; charset=utf-8")
      .header("cache-control", "no-store")
      .send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const allowed = routes.allowedMethods(pathOf(request.raw.url ?? ""));
    const wrongMethod = allowed.length > 0 && !allowed.includes(request.method);
    if (wrongMethod) reply.header("allow", allowed.join(", "));
    return reply
      .code(wrongMethod ? 405 : 404)
      .header("cache-control", "no-store")
      .send({ error: wrongMethod ? "method_not_allowed" : "not_found" });
  });

  addRoute(app, { method: "GET", path: "/health", handler: () => ({ status: "ok" }) });
  for (const route of appRoutes) addRoute(app, route);

  await app.ready();
  return app;
}
