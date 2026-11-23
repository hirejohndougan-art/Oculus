/**
 * Error replies without internals (D-051).
 *
 * Every error the HTTP layer sends is `{ "error": "<code>" }` with a fixed
 * code. Nothing from the error itself reaches the client: no message, no
 * stack trace, no Fastify error code, no part of the request body. Server
 * errors (5xx) are logged on the server; the client sees only
 * `internal_error` or `unavailable`.
 *
 * Whatever a handler throws is replaced by a fresh Refusal before Fastify
 * sees it (`rebuildThrown`, server.ts), and is logged only as a
 * fixed-shape summary of plain strings (`summarizeThrown`): a thrown value
 * can carry getters, a Proxy or a `headers` object that Fastify's default
 * error handler would copy onto the reply.
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
 * a diagnostics_channel subscriber) runs no code of anyone's.
 */
export class Refusal extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    if (!isErrorStatus(statusCode)) throw new Error("Refusal status must be 400 to 599");
    if (typeof code !== "string" || !CODE.test(code)) {
      throw new Error("Refusal code must be a short lowercase word");
    }
    super(code);
    Object.defineProperty(this, "stack", {
      value: `Refusal: ${code}`,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    this.name = "Refusal";
    this.statusCode = statusCode;
    this.code = code;
    Object.freeze(this);
  }
}

/** The 500 the client sees for anything that isn't a deliberate refusal. */
export function internalError(): Refusal {
  return new Refusal(500, "internal_error");
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
 * or anything that throws while being looked at (a Proxy, a getter), is a
 * plain internal 500. Never throws.
 */
export function rebuildThrown(thrown: unknown): Refusal {
  try {
    if (typeof thrown !== "object" || thrown === null) return internalError();
    if (!(thrown instanceof Refusal)) return internalError();
    const status = ownData(thrown, "statusCode");
    const code = ownData(thrown, "code");
    if (!isErrorStatus(status) || typeof code !== "string" || !CODE.test(code)) {
      return internalError();
    }
    return new Refusal(status, code);
  } catch {
    return internalError();
  }
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

function stackOf(value: object): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
    if (descriptor === undefined) return "";
    let stack: unknown;
    if ("value" in descriptor) stack = descriptor.value;
    // Only the engine's own getter is called, never one the value brought.
    else if (typeof NATIVE_STACK_GET === "function" && descriptor.get === NATIVE_STACK_GET) {
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
 * only (no getter it brought is run) and V8's own stack. Never throws, and
 * never returns the value or any object from it.
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
