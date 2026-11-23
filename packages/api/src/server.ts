/**
 * The Oculus HTTP server: Fastify 5 with the rules of D-051 on top.
 *
 * `buildServer` returns a ready Fastify instance (call `listen` to serve, or
 * `inject` in tests). Its only route of its own is `GET /health`; callers pass
 * the rest through `options.routes`, so the 405 table and the route checks
 * see every route.
 *
 * The rules, each with an attack test in this package:
 * 1. Bodies (body.ts): only Oculus's parsers: exact `application/json`, and
 *    `application/x-www-form-urlencoded` on routes marked `oculus.form`;
 *    415 for any other type, a body without a type, and compressed bodies;
 *    prototype keys and repeated form fields refused; bad UTF-8 refused.
 * 2. Limits (body.ts): counted in bytes, chunked bodies included: 1 MiB by
 *    default, 8 KiB on routes marked `oculus.credentials` (sign-in, two-step,
 *    site password).
 * 3. Paths (paths.ts): encoded slashes, backslashes, `.`/`..` segments, NUL
 *    and other control characters, double encoding and `//` refused with 400
 *    in the first onRequest hook, before any handler. Unknown paths get 404
 *    and known paths with the wrong method 405 (with `Allow`), from the
 *    not-found handler; the router is case-sensitive and normalizes nothing
 *    (no trailing-slash, duplicate-slash or semicolon rewriting).
 * 4. Cookies (cookies.ts): `@fastify/cookie` with parsing off; only Oculus's
 *    own names are read, an Oculus name sent twice is refused, and every
 *    `Set-Cookie` must come from the one writer (`__Host-`, Secure, HttpOnly,
 *    SameSite, Path=/, no Domain) or the reply becomes a 500 without it.
 * 5. Changes (origin.ts): every method other than GET and HEAD needs an
 *    `Origin` matching the host or `Sec-Fetch-Site: same-origin`; else 403.
 * 6. Proxies (proxy.ts): `trustProxy` is off unless `OCULUS_TRUSTED_PROXY`
 *    names the proxy's addresses.
 * 7. Timeouts: explicit and shorter than Node's and Fastify's defaults
 *    (`SERVER_TIMEOUTS`); options can only shorten them.
 * 8. Errors (errors.ts): `{ "error": "<code>" }` only, never a message or a
 *    stack trace; 5xx details go to the server log. The request logger
 *    records the method and path only: no query string, headers, cookies or
 *    body.
 *
 * Adding another Fastify plugin, parser or error handler is its own decision
 * (D-051).
 */
import fastifyCookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  DEFAULT_BODY_LIMIT,
  bodyHeaderProblem,
  registerBodyParsers,
  routeBodyLimit,
} from "./body.js";
import { cookieHeaderProblem, setCookieProblem, setCookieValues } from "./cookies.js";
import { Refusal, errorReply } from "./errors.js";
import { failsOriginCheck } from "./origin.js";
import { RouteTable, pathOf, pathProblem } from "./paths.js";
import { trustedProxyFromEnv } from "./proxy.js";

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
  /** Where `OCULUS_TRUSTED_PROXY` is read; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Log requests (method and path only) and server errors, to standard output
   * or to the given stream. Off by default.
   */
  readonly logger?: boolean | { readonly stream: { write(line: string): void } };
  /** Shorter timeouts, for tests; a longer value is refused. */
  readonly timeouts?: Partial<ServerTimeouts>;
  /** Registers the application's routes. */
  readonly routes?: (app: FastifyInstance) => void | Promise<void>;
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
function requestRefusal(request: FastifyRequest): Refusal | undefined {
  if (pathProblem(request.raw.url) !== undefined) return new Refusal(400, "bad_path");
  const refusal = bodyHeaderProblem(request) ?? cookieHeaderProblem(request.headers.cookie);
  if (refusal !== undefined) return refusal;
  if (failsOriginCheck(request)) return new Refusal(403, "cross_origin");
  return undefined;
}

/** Builds the configured Oculus server and waits until it is ready. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const timeouts = chooseTimeouts(options.timeouts);
  const trustProxy = trustedProxyFromEnv(options.env ?? process.env);

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
  });

  const routes = new RouteTable(MAX_PARAM_LENGTH);

  await app.register(fastifyCookie, { hook: false });
  registerBodyParsers(app);

  app.addHook("onRoute", (route) => {
    const limit = routeBodyLimit(route.config?.oculus, route.bodyLimit);
    if (limit !== undefined) route.bodyLimit = limit;
    routes.add(route.method, route.url);
  });

  // Rule 3 first: nothing else looks at a refused path.
  app.addHook("onRequest", (request, _reply, done) => {
    done(requestRefusal(request));
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    const values = setCookieValues(reply.getHeader("set-cookie"));
    if (values.some((value) => setCookieProblem(value) !== undefined)) {
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

  app.get("/health", () => ({ status: "ok" }));

  if (options.routes !== undefined) {
    const register = options.routes;
    await app.register(async (child) => {
      await register(child);
    });
  }

  await app.ready();
  return app;
}
