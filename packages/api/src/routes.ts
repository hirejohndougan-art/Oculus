/**
 * The narrow route API (D-058).
 *
 * Application code never touches the Fastify instance, request or reply.
 * It hands `buildServer` a list of `OculusRoute`s: a method, a path, two
 * flags and a handler. The handler gets:
 * - an `OculusRequest`: a frozen copy of the method, path, parameters, query,
 *   parsed body, client address, host, scheme, the Oculus cookies and a few
 *   ordinary headers. Never the Fastify request, its `raw` message, socket
 *   or `server` (from which the raw response and the listening server are
 *   one step away).
 * - an `OculusReply`, which can set the status, ordinary headers (headers.ts)
 *   and the content type, and write Oculus cookies through the one cookie
 *   writer. It has no `hijack`, no `raw`, no way to write `Set-Cookie`,
 *   framing, CORS or security headers, and stops working once the handler
 *   has returned.
 * The handler returns `undefined`, a string, or plain JSON data (objects,
 * arrays, strings, finite numbers, booleans, null). Anything else (a Web
 * `Response`, a stream, a Buffer, a Date, a class instance, a getter, a
 * cycle) is refused with a 500 before Fastify sees it: Fastify copies a
 * `Response`'s headers after every check has run. The data is copied as it
 * is checked, so what is sent is what was checked.
 * Nothing in the API adds parsers, hooks, error handlers, body limits or
 * timeouts. The instance is ready before anything else can reach it, and
 * Fastify refuses those additions after that.
 *
 * As a second line, `routeOptionsProblem` checks every route Fastify is
 * asked to add (onRoute) and stops the server from starting when one carries
 * an option outside the small set this module itself uses.
 */
import type { FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { CREDENTIALS_BODY_LIMIT, type OculusRouteConfig } from "./body.js";
import {
  OCULUS_COOKIES,
  clearOculusCookie,
  readOculusCookie,
  setOculusCookie,
  type CookieWriteOptions,
  type OculusCookieName,
} from "./cookies.js";
import { replyHeaderProblem } from "./headers.js";
import { pathOf } from "./paths.js";

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

/** The request headers a handler can read; every other header stays with the HTTP layer. */
export const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "user-agent",
] as const;
export type RequestHeaderName = (typeof REQUEST_HEADERS)[number];

/** What a handler sees of the request: plain, frozen data. */
export interface OculusRequest {
  readonly method: string;
  /** The path as sent, without the query (already checked by paths.ts). */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /** The parsed body (body.ts), or `undefined` without one. */
  readonly body: unknown;
  /** The client's address (from the trusted proxy only, proxy.ts). */
  readonly ip: string;
  /** The host the request was sent to (from the trusted proxy only). */
  readonly host: string;
  /** `http` or `https` (from the trusted proxy only). */
  readonly protocol: string;
  readonly headers: Readonly<Partial<Record<RequestHeaderName, string>>>;
  /** The Oculus cookies sent, well-formed values only (cookies.ts). */
  readonly cookies: Readonly<Partial<Record<OculusCookieName, string>>>;
}

export interface OculusRoute {
  readonly method: RouteMethod;
  /** Static segments, whole-segment `:name` parameters and a final `*` (paths.ts). */
  readonly path: string;
  /** Takes HTML form posts (`application/x-www-form-urlencoded`). */
  readonly form?: boolean;
  /** A sign-in, two-step or site password post: the 8 KiB body limit. */
  readonly credentials?: boolean;
  /**
   * Returns the body to send: plain data is sent as JSON, a string as it is,
   * `undefined` sends nothing. Anything else is a 500.
   */
  readonly handler: (request: OculusRequest, reply: OculusReply) => unknown;
}

const ROUTE_KEYS: ReadonlySet<string> = new Set([
  "method",
  "path",
  "form",
  "credentials",
  "handler",
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

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function textEntries(source: unknown): [string, string | readonly string[]][] {
  if (typeof source !== "object" || source === null) return [];
  const entries: [string, string | readonly string[]][] = [];
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") entries.push([key, value]);
    else if (Array.isArray(value)) {
      entries.push([key, Object.freeze(value.filter((v): v is string => typeof v === "string"))]);
    }
  }
  return entries;
}

/** The frozen request view handed to handlers; holds no reference to Fastify or Node objects. */
export function oculusRequest(request: FastifyRequest): OculusRequest {
  const headers: Partial<Record<RequestHeaderName, string>> = {};
  for (const name of REQUEST_HEADERS) {
    const value: unknown = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const cookies: Partial<Record<OculusCookieName, string>> = {};
  for (const name of Object.values(OCULUS_COOKIES)) {
    const value = readOculusCookie(request.headers.cookie, name);
    if (value !== undefined) cookies[name] = value;
  }
  const params = Object.fromEntries(
    textEntries(request.params).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  return Object.freeze({
    method: request.method,
    path: pathOf(request.raw.url ?? ""),
    params: Object.freeze(params),
    query: Object.freeze(Object.fromEntries(textEntries(request.query))),
    body: deepFreeze(request.body),
    ip: request.ip,
    host: request.host,
    protocol: request.protocol,
    headers: Object.freeze(headers),
    cookies: Object.freeze(cookies),
  });
}

/** How deeply a handler's result may nest. */
const MAX_RESULT_DEPTH = 256;

/**
 * A copy of a handler's result made only of plain JSON data, read once.
 * Throws on anything else: class instances (Response, streams, Buffers,
 * Dates, Maps), functions, symbols, bigints, non-finite numbers, getters,
 * cycles and nesting deeper than `MAX_RESULT_DEPTH`.
 */
export function plainData(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("handler result: non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new Error(`handler result: ${typeof value} is not data`);
  if (depth >= MAX_RESULT_DEPTH) throw new Error("handler result: nested too deeply");
  if (seen.has(value)) throw new Error("handler result: cycle");
  const proto: unknown = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    throw new Error("handler result: only plain objects and arrays are data");
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor)) throw new Error("handler result: getters are not data");
    return descriptor.value;
  };
  let copy: unknown;
  if (isArray) {
    const length = read("length");
    if (typeof length !== "number") throw new Error("handler result: bad array");
    const list: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = read(String(i));
      list.push(item === undefined ? null : plainData(item, depth + 1, seen));
    }
    copy = list;
  } else {
    const object: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors)) {
      if (!descriptors[key]?.enumerable) continue;
      const item = read(key);
      if (item === undefined) continue;
      // defineProperty, so a "__proto__" key stays an ordinary key.
      Object.defineProperty(object, key, {
        value: plainData(item, depth + 1, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    copy = object;
  }
  seen.delete(value);
  return copy;
}

/**
 * The narrow reply handed to handlers. `open` says whether the handler is
 * still running; once it has returned, every method throws.
 */
export function oculusReply(reply: FastifyReply, open: () => boolean = () => true): OculusReply {
  const check = (): void => {
    if (!open()) throw new Error("the reply can't be changed after the handler has returned");
  };
  const wrapped: OculusReply = Object.freeze({
    status(code: number) {
      check();
      if (!Number.isInteger(code) || code < 200 || code > 599) {
        throw new Error("status must be a whole number from 200 to 599");
      }
      void reply.code(code);
      return wrapped;
    },
    header(name: string, value: string) {
      check();
      const problem = replyHeaderProblem(name, value);
      if (problem !== undefined) throw new Error(problem);
      void reply.header(name, value);
      return wrapped;
    },
    type(contentType: string) {
      check();
      const problem = replyHeaderProblem("content-type", contentType);
      if (problem !== undefined) throw new Error(problem);
      void reply.type(contentType);
      return wrapped;
    },
    setCookie(name: OculusCookieName, value: string, options?: CookieWriteOptions) {
      check();
      setOculusCookie(reply, name, value, options);
      return wrapped;
    },
    clearCookie(name: OculusCookieName) {
      check();
      clearOculusCookie(reply, name);
      return wrapped;
    },
  });
  return wrapped;
}

/** The frozen `config` a route is registered with; body.ts reads `oculus` from it. */
export function routeConfig(route: OculusRoute): { readonly oculus: OculusRouteConfig } {
  return Object.freeze({
    oculus: Object.freeze({ form: route.form === true, credentials: route.credentials === true }),
  });
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
