/**
 * Error replies without internals (D-051).
 *
 * Every error the HTTP layer sends is `{ "error": "<code>" }` with a fixed
 * code. Nothing from the error itself reaches the client: no message, no
 * stack trace, no Fastify error code, no part of the request body. Server
 * errors (5xx) are logged on the server; the client sees only
 * `internal_error` or `unavailable`, or `timeout` (503) when a
 * database time limit ran out (S-063).
 *
 * Whatever a handler throws is replaced by a fresh Refusal before Fastify
 * sees it (`rebuildThrown`, server.ts), and is logged only as a
 * fixed-shape summary of plain strings (`summarizeThrown`): a thrown value
 * can carry getters, a Proxy or a `headers` object that Fastify's default
 * error handler would copy onto the reply. Only own data properties are
 * read, so no getter the value carries is called; a Proxy's traps
 * (`getPrototypeOf`, `getOwnPropertyDescriptor`) do run, always inside a
 * try/catch. V8's own `stack` getter is called only for a value whose whole
 * prototype chain is built-in Error prototypes and whose own `name` and
 * `message` are data, because formatting the stack reads `name` and
 * `message` (and runs any getter there).
 */

/** Codes are short lowercase words joined by underscores (`not_found`). */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

function isErrorStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * A deliberate refusal: the status and code are what the client sees.
 * The status must be 400 to 599 (a 1xx would desync the connection, a 2xx
 * or 3xx isn't an error) and the code a short lowercase word (`CODE`); the
 * constructor throws otherwise. A Refusal is frozen and has only data
 * properties, `stack` included, so whoever reads it (Fastify, the logger,
 * a diagnostics_channel subscriber) runs no code of anyone's. Its fields
 * are defined, never assigned, so a setter added to a prototype can't run.
 */
export class Refusal extends Error {
  declare readonly statusCode: number;
  declare readonly code: string;

  constructor(statusCode: number, code: string) {
    if (!isErrorStatus(statusCode)) throw new Error("Refusal status must be 400 to 599");
    if (typeof code !== "string" || !CODE.test(code)) {
      throw new Error("Refusal code must be a short lowercase word");
    }
    super(code);
    const field = (value: unknown): PropertyDescriptor => ({
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(this, "stack", field(`Refusal: ${code}`));
    Object.defineProperty(this, "name", field("Refusal"));
    Object.defineProperty(this, "statusCode", { ...field(statusCode), enumerable: true });
    Object.defineProperty(this, "code", { ...field(code), enumerable: true });
    Object.freeze(this);
  }
}

/** Built once at start-up: the 500 to fall back on when nothing else can be built. */
const INTERNAL_REFUSAL: Refusal = new Refusal(500, "internal_error");

/** The 500 the client sees for anything that isn't a deliberate refusal. Never throws. */
export function internalError(): Refusal {
  try {
    return new Refusal(500, "internal_error");
  } catch {
    return INTERNAL_REFUSAL;
  }
}

/** An own data property, read without running a getter; `undefined` otherwise. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * A fresh Refusal standing for whatever a handler threw, never the thrown
 * value itself. A Refusal (by prototype) with an own status of 400 to 599
 * and a well-formed code is rebuilt from those two values; anything else,
 * or anything that throws while being looked at (a Proxy's trap), is a
 * plain internal 500. Never throws: if even that can't be built, the
 * frozen 500 made at start-up is returned.
 */
export function rebuildThrown(thrown: unknown): Refusal {
  try {
    if (typeof thrown !== "object" || thrown === null) return internalError();
    if (!(thrown instanceof Refusal)) return timeLimitRefusal(thrown) ?? internalError();
    const status = ownData(thrown, "statusCode");
    const code = ownData(thrown, "code");
    if (!isErrorStatus(status) || typeof code !== "string" || !CODE.test(code)) {
      return internalError();
    }
    return new Refusal(status, code);
  } catch {
    return INTERNAL_REFUSAL;
  }
}

/** pg-pool's error for no free connection within the pool's wait (client.ts, `isDatabaseTimeout`). */
const POOL_WAIT_MESSAGE = "timeout exceeded when trying to connect";

/**
 * A database time limit that ran out (S-063), as `503 timeout`: no pooled
 * connection came free in time, or the server stopped a statement (57014,
 * `statement_timeout`) or a lock wait (55P03, `lock_timeout`), as the
 * service's `timeout` refusal is answered. These are load, not faults: the request can be tried
 * again. `undefined` for anything else. Own data properties only, as
 * everywhere in this file.
 */
function timeLimitRefusal(thrown: object): Refusal | undefined {
  const code = ownData(thrown, "code");
  if (code === "57014" || code === "55P03") return new Refusal(503, "timeout");
  if (
    code === undefined &&
    plainErrorShape(thrown) &&
    ownData(thrown, "message") === POOL_WAIT_MESSAGE
  ) {
    return new Refusal(503, "timeout");
  }
  return undefined;
}

/** How a thrown value is described in the server log: plain strings only. */
export interface ThrownSummary {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

function ownText(value: object, key: string, limit: number): string {
  const text = ownData(value, key);
  return typeof text === "string" ? text.slice(0, limit) : "";
}

/** V8's own `stack` getter, the same function on every Error. */
const NATIVE_STACK_GET: unknown = Reflect.get(
  Object.getOwnPropertyDescriptor(new Error(), "stack") ?? {},
  "get",
);

/** The engine's own Error prototypes: none of them has a getter of its own. */
const BUILT_IN_ERROR_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
  AggregateError.prototype,
]);

/**
 * True when every prototype of the value is a built-in Error prototype
 * (then `Object.prototype`) and its own `name` and `message`, if any, are
 * data: V8's stack getter formats `name: message`, running any getter it
 * finds there, so it is called only on such values.
 */
function plainErrorShape(value: object): boolean {
  let proto: unknown = Object.getPrototypeOf(value);
  if (typeof proto !== "object" || proto === null || !BUILT_IN_ERROR_PROTOTYPES.has(proto)) {
    return false;
  }
  for (let i = 0; i < 5; i++) {
    if (proto === Object.prototype) break;
    if (typeof proto !== "object" || proto === null || !BUILT_IN_ERROR_PROTOTYPES.has(proto)) {
      return false;
    }
    proto = Object.getPrototypeOf(proto);
  }
  if (proto !== Object.prototype) return false;
  for (const key of ["name", "message"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) return false;
  }
  return true;
}

function stackOf(value: object): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
    if (descriptor === undefined) return "";
    let stack: unknown;
    if ("value" in descriptor) stack = descriptor.value;
    // Only the engine's own getter is called, never one the value brought,
    // and only on a value with nothing of its own for it to run.
    else if (
      typeof NATIVE_STACK_GET === "function" &&
      descriptor.get === NATIVE_STACK_GET &&
      plainErrorShape(value)
    ) {
      stack = Reflect.apply(NATIVE_STACK_GET, value, []);
    }
    return typeof stack === "string" ? stack.slice(0, 4000) : "";
  } catch {
    return "";
  }
}

/** `name` as an own data property of the value or of one of its first few prototypes. */
function nameOf(value: object): string {
  try {
    let current: object | null = value;
    for (let i = 0; i < 5 && current !== null; i++) {
      const name = ownText(current, "name", 100);
      if (name !== "") return name;
      current = Object.getPrototypeOf(current) as object | null;
    }
    return "object";
  } catch {
    return "unreadable";
  }
}

/**
 * A fixed-shape summary of a thrown value for the log: own data properties
 * only (no getter is called) and V8's own stack for plain built-in errors
 * (`plainErrorShape`). Never throws, and never returns the value or any
 * object from it.
 */
export function summarizeThrown(thrown: unknown): ThrownSummary {
  try {
    if (typeof thrown === "string") {
      return { name: "string", message: thrown.slice(0, 500), stack: "" };
    }
    if (typeof thrown !== "object" || thrown === null) {
      return { name: thrown === null ? "null" : typeof thrown, message: "", stack: "" };
    }
    return {
      name: nameOf(thrown),
      message: ownText(thrown, "message", 500),
      stack: stackOf(thrown),
    };
  } catch {
    return { name: "unreadable", message: "", stack: "" };
  }
}

/** The fixed code for a status when the error isn't one of our refusals. */
const GENERIC_CODES = new Map<number, string>([
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [405, "method_not_allowed"],
  [406, "not_acceptable"],
  [408, "request_timeout"],
  [409, "conflict"],
  [411, "length_required"],
  [413, "payload_too_large"],
  [414, "uri_too_long"],
  [415, "unsupported_media_type"],
  [422, "unprocessable"],
  [429, "too_many_requests"],
  [431, "headers_too_large"],
  [503, "unavailable"],
]);

export interface ErrorReply {
  readonly statusCode: number;
  readonly body: { readonly error: string };
}

const INTERNAL: ErrorReply = Object.freeze({
  statusCode: 500,
  body: Object.freeze({ error: "internal_error" }),
});

function statusOf(error: object): number | undefined {
  const status = ownData(error, "statusCode");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * The reply for any error that reaches the error handler. Our own refusals
 * keep their code; other client errors (4xx, for example Fastify's own
 * "body too large") get the generic code for their status; everything else
 * becomes a 500 `internal_error`, except 503 (handler timeout), which stays
 * `unavailable`. Only own data properties are read, and anything that
 * throws while being looked at is a 500: this never throws.
 */
export function errorReply(error: unknown): ErrorReply {
  try {
    if (typeof error !== "object" || error === null) return INTERNAL;
    if (error instanceof Refusal) {
      const rebuilt = rebuildThrown(error);
      return { statusCode: rebuilt.statusCode, body: { error: rebuilt.code } };
    }
    const status = statusOf(error);
    if (status !== undefined && status >= 400 && status < 500) {
      return { statusCode: status, body: { error: GENERIC_CODES.get(status) ?? "bad_request" } };
    }
    if (status === 503) return { statusCode: 503, body: { error: "unavailable" } };
    return INTERNAL;
  } catch {
    return INTERNAL;
  }
}
