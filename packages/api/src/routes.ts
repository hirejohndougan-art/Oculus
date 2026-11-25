/**
 * The narrow route API (D-058).
 *
 * Application code never touches the Fastify instance, request or reply.
 * It hands `buildServer` a list of `OculusRoute`s: a method, a path, two
 * flags and a handler. The handler gets:
 * - an `OculusRequest`: a frozen copy of the method, path, parameters, query,
 *   parsed body, client address, host, scheme, the Oculus cookies and a few
 *   ordinary headers, plus an AbortSignal that fires on the handler timeout
 *   or when the client goes away. Never the Fastify request, its `raw` message, socket
 *   or `server` (from which the raw response and the listening server are
 *   one step away).
 * - an `OculusReply`, which can set the status, the allowlisted headers (headers.ts)
 *   and the content type, and write Oculus cookies through the one cookie
 *   writer. It has no `hijack`, no `raw`, no way to write `Set-Cookie`,
 *   framing, CORS or security headers, and stops working once the handler
 *   has returned or the request has ended.
 * The handler returns `undefined`, a string, or plain JSON data (objects,
 * arrays, strings, finite numbers, booleans, null). Anything else (a Web
 * `Response`, a stream, a Buffer, a Date, a class instance, a getter, a
 * cycle, or a result over the size caps) is refused with a 500 before Fastify sees it: Fastify copies a
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
import { contentTypeProblem, replyHeaderProblem } from "./headers.js";
import { pathOf } from "./paths.js";

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface OculusReply {
  /** The status code, 200 to 599. */
  status(code: number): OculusReply;
  /**
   * One of the headers handlers may write (headers.ts `HANDLER_HEADER_NAMES`:
   * Content-Language, ETag, Last-Modified, Vary, a same-origin Location,
   * Retry-After), with a well-formed value; anything else throws.
   */
  header(name: string, value: string): OculusReply;
  /** The Content-Type: a media type with simple parameters. */
  type(contentType: string): OculusReply;
  setCookie(name: OculusCookieName, value: string, options?: CookieWriteOptions): OculusReply;
  clearCookie(name: OculusCookieName): OculusReply;
}

/**
 * The request headers a handler can read; every other header stays with the
 * HTTP layer. `x-oculus-csrf` carries the session's CSRF token on every
 * change and `x-oculus-site` the working site (T-042, D-079);
 * `x-oculus-background: 1` marks a read that isn't a use of the session
 * (T-062, D-098). All are checked by the API's handlers, never trusted as
 * they are.
 */
export const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "user-agent",
  "x-oculus-csrf",
  "x-oculus-site",
  "x-oculus-background",
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
  /**
   * Aborted when the handler has run out of time (its 503 is already sent)
   * or the client has gone away. From then on the reply throws; a handler
   * with side effects (writes, outbound requests) should stop.
   */
  readonly signal: AbortSignal;
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

/**
 * Checks a route given by application code and returns a frozen copy of its
 * fields, each read exactly once; throws when it isn't a plain `OculusRoute`.
 * The server registers only the copy, so a getter can't pass the check with
 * one value and register another (a `method` that says GET here and TRACE
 * later).
 */
export function checkRoute(route: unknown): OculusRoute {
  if (typeof route !== "object" || route === null) throw new Error("a route must be an object");
  for (const key of Object.keys(route)) {
    if (!ROUTE_KEYS.has(key)) throw new Error(`route option not allowed: ${key}`);
  }
  const r = route as Partial<Record<keyof OculusRoute, unknown>>;
  const method = r.method;
  const path = r.path;
  const form = r.form;
  const credentials = r.credentials;
  const handler = r.handler;
  if (typeof method !== "string" || !ROUTE_METHODS.includes(method as RouteMethod)) {
    throw new Error(`route method not allowed: ${String(method)}`);
  }
  if (typeof path !== "string") throw new Error("route path must be text");
  for (const [flag, value] of [
    ["form", form],
    ["credentials", credentials],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`route ${flag} must be true or false`);
    }
  }
  if (typeof handler !== "function") throw new Error("route handler must be a function");
  return Object.freeze({
    method: method as RouteMethod,
    path,
    form: form === true,
    credentials: credentials === true,
    handler: handler as OculusRoute["handler"],
  });
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
export function oculusRequest(request: FastifyRequest, signal: AbortSignal): OculusRequest {
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
    signal,
  });
}

/** How deeply a handler's result may nest. */
const MAX_RESULT_DEPTH = 256;
/** The longest array in a handler's result. */
export const MAX_RESULT_ARRAY_LENGTH = 100_000;
/** Values (objects, arrays, strings, numbers…) in a result, counted at every visit. */
export const MAX_RESULT_NODES = 1_000_000;
/** UTF-8 bytes of all strings (keys included) in a result, or of a text result. */
export const MAX_RESULT_TEXT_BYTES = 16 * 1024 * 1024;

interface Budget {
  nodes: number;
  bytes: number;
}

function spendText(text: string, budget: Budget): void {
  budget.bytes += Buffer.byteLength(text, "utf8");
  if (budget.bytes > MAX_RESULT_TEXT_BYTES) throw new Error("handler result: too much text");
}

/**
 * A copy of a handler's result made only of plain JSON data, read once.
 * Throws on anything else: class instances (Response, streams, Buffers,
 * Dates, Maps), functions, symbols, bigints, non-finite numbers, getters,
 * cycles and nesting deeper than `MAX_RESULT_DEPTH`; and on results larger
 * than the caps above. Every visit counts, so an object referenced from
 * many places (which would otherwise be copied again and again, doubling at
 * each level) is counted each time.
 */
export function plainData(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: Budget = { nodes: 0, bytes: 0 },
): unknown {
  if (++budget.nodes > MAX_RESULT_NODES) throw new Error("handler result: too many values");
  if (typeof value === "string") {
    spendText(value, budget);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
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
  // One descriptor at a time, never all at once: the size is checked before
  // anything is read, so a 3,000,000-item array or a million-key object is
  // refused without building a descriptor for every entry.
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor)) throw new Error("handler result: getters are not data");
    return descriptor.value;
  };
  const remaining = MAX_RESULT_NODES - budget.nodes;
  let copy: unknown;
  if (isArray) {
    const length = read("length");
    if (typeof length !== "number") throw new Error("handler result: bad array");
    if (length > MAX_RESULT_ARRAY_LENGTH) throw new Error("handler result: array too long");
    if (length > remaining) throw new Error("handler result: too many values");
    const list: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = read(String(i));
      list.push(item === undefined ? null : plainData(item, depth + 1, seen, budget));
    }
    copy = list;
  } else {
    const keys = Reflect.ownKeys(value);
    if (keys.length > remaining) throw new Error("handler result: too many values");
    const object: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) throw new Error("handler result: getters are not data");
      const item: unknown = descriptor.value;
      if (item === undefined) continue;
      spendText(key, budget);
      // defineProperty, so a "__proto__" key stays an ordinary key.
      Object.defineProperty(object, key, {
        value: plainData(item, depth + 1, seen, budget),
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
 * What a handler returned, as the body to send: `undefined`, a string (at
 * most `MAX_RESULT_TEXT_BYTES`), or a `plainData` copy. Throws otherwise.
 */
export function resultBody(result: unknown): unknown {
  if (result === undefined) return undefined;
  if (typeof result === "string") {
    spendText(result, { nodes: 0, bytes: 0 });
    return result;
  }
  return plainData(result);
}

/**
 * The narrow reply handed to handlers. `open` says whether the handler is
 * still running; once it has returned (or timed out, or the client has gone), every method throws.
 */
export function oculusReply(reply: FastifyReply, open: () => boolean = () => true): OculusReply {
  const check = (): void => {
    if (!open())
      throw new Error(
        "the reply can't be changed after the handler has returned or the request has ended",
      );
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
      const problem = contentTypeProblem(contentType);
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

const ROUTE_METHODS_WITH_HEAD: ReadonlySet<string> = new Set([...ROUTE_METHODS, "HEAD"]);

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
 * Refused: a method other than ours (and HEAD), any option outside the set above (an error handler, hooks other
 * than Fastify's own HEAD `onSend`, a handler timeout, schemas, compilers,
 * constraints), a prefix, and a body limit other than the credentials limit
 * on a credentials route and none elsewhere.
 */
export function routeOptionsProblem(route: RouteOptions): string | undefined {
  // One method per route, one of ours, or the HEAD route Fastify adds for a GET.
  const method: unknown = route.method;
  if (typeof method !== "string" || !ROUTE_METHODS_WITH_HEAD.has(method)) {
    return "route method not allowed";
  }
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
