/**
 * The narrow route API (D-058).
 *
 * Application code never touches the Fastify instance or its reply object.
 * It hands `buildServer` a list of `OculusRoute`s: a method, a path, two
 * flags and a handler. The handler gets the request and an `OculusReply`,
 * which can set the status, ordinary headers and the content type, and write
 * Oculus cookies through the one cookie writer. It has no `hijack`, no `raw`,
 * no way to write `Set-Cookie` or framing headers, and no way to add parsers,
 * hooks, error handlers, body limits or timeouts. The instance is ready
 * before anything else can reach it, and Fastify refuses those additions
 * after that.
 *
 * As a second line, `routeOptionsProblem` checks every route Fastify is
 * asked to add (onRoute) and stops the server from starting when one carries
 * an option outside the small set this module itself uses.
 */
import type { FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { CREDENTIALS_BODY_LIMIT } from "./body.js";
import {
  clearOculusCookie,
  setOculusCookie,
  type CookieWriteOptions,
  type OculusCookieName,
} from "./cookies.js";

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface OculusReply {
  /** The status code, 200 to 599. */
  status(code: number): OculusReply;
  /** An ordinary header; Set-Cookie and framing headers are refused. */
  header(name: string, value: string): OculusReply;
  /** The Content-Type. */
  type(contentType: string): OculusReply;
  setCookie(name: OculusCookieName, value: string, options?: CookieWriteOptions): OculusReply;
  clearCookie(name: OculusCookieName): OculusReply;
}

export interface OculusRoute {
  readonly method: RouteMethod;
  /** Static segments, whole-segment `:name` parameters and a final `*` (paths.ts). */
  readonly path: string;
  /** Takes HTML form posts (`application/x-www-form-urlencoded`). */
  readonly form?: boolean;
  /** A sign-in, two-step or site password post: the 8 KiB body limit. */
  readonly credentials?: boolean;
  /** Returns the body to send (an object is sent as JSON); `undefined` sends nothing. */
  readonly handler: (request: FastifyRequest, reply: OculusReply) => unknown;
}

const ROUTE_KEYS: ReadonlySet<string> = new Set([
  "method",
  "path",
  "form",
  "credentials",
  "handler",
]);
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "content-encoding",
  "keep-alive",
  "upgrade",
]);

/** Checks a route given by application code; throws when it isn't a plain `OculusRoute`. */
export function checkRoute(route: unknown): OculusRoute {
  if (typeof route !== "object" || route === null) throw new Error("a route must be an object");
  for (const key of Object.keys(route)) {
    if (!ROUTE_KEYS.has(key)) throw new Error(`route option not allowed: ${key}`);
  }
  const r = route as Partial<Record<keyof OculusRoute, unknown>>;
  if (!ROUTE_METHODS.includes(r.method as RouteMethod)) {
    throw new Error(`route method not allowed: ${String(r.method)}`);
  }
  if (typeof r.path !== "string") throw new Error("route path must be text");
  for (const flag of ["form", "credentials"] as const) {
    if (r[flag] !== undefined && typeof r[flag] !== "boolean") {
      throw new Error(`route ${flag} must be true or false`);
    }
  }
  if (typeof r.handler !== "function") throw new Error("route handler must be a function");
  return route as OculusRoute;
}

/** The narrow reply handed to handlers. */
export function oculusReply(reply: FastifyReply): OculusReply {
  const wrapped: OculusReply = Object.freeze({
    status(code: number) {
      if (!Number.isInteger(code) || code < 200 || code > 599) {
        throw new Error("status must be a whole number from 200 to 599");
      }
      void reply.code(code);
      return wrapped;
    },
    header(name: string, value: string) {
      if (REFUSED_HEADERS.has(name.toLowerCase())) throw new Error(`header not allowed: ${name}`);
      void reply.header(name, value);
      return wrapped;
    },
    type(contentType: string) {
      void reply.type(contentType);
      return wrapped;
    },
    setCookie(name: OculusCookieName, value: string, options?: CookieWriteOptions) {
      setOculusCookie(reply, name, value, options);
      return wrapped;
    },
    clearCookie(name: OculusCookieName) {
      clearOculusCookie(reply, name);
      return wrapped;
    },
  });
  return wrapped;
}

/** Fastify's own keys on a route as onRoute sees it. */
const FASTIFY_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "method",
  "url",
  "path",
  "routePath",
  "prefix",
  "handler",
  "config",
  "logLevel",
  "attachValidation",
  "bodyLimit",
  "onSend",
]);

/**
 * Why a route Fastify is about to add breaks the rules, or `undefined`.
 * Refused: any option outside the set above (an error handler, hooks other
 * than Fastify's own HEAD `onSend`, a handler timeout, schemas, compilers,
 * constraints), a prefix, and a body limit other than the credentials limit
 * on a credentials route and none elsewhere.
 */
export function routeOptionsProblem(route: RouteOptions): string | undefined {
  for (const [key, value] of Object.entries(route)) {
    if (value === undefined) continue;
    if (!FASTIFY_ROUTE_KEYS.has(key)) return `route option not allowed: ${key}`;
  }
  const prefix = (route as { prefix?: unknown }).prefix;
  if (prefix !== undefined && prefix !== "") return "route prefixes are not allowed";
  if (route.onSend !== undefined && route.method !== "HEAD") return "route hooks are not allowed";
  if (route.attachValidation === true) return "attachValidation is not allowed";
  const credentials = route.config?.oculus?.credentials === true;
  if (credentials ? route.bodyLimit !== CREDENTIALS_BODY_LIMIT : route.bodyLimit !== undefined) {
    return "routes can't choose their body limit";
  }
  return undefined;
}
