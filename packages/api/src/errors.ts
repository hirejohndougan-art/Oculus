/**
 * Error replies without internals (D-051).
 *
 * Every error the HTTP layer sends is `{ "error": "<code>" }` with a fixed
 * code. Nothing from the error itself reaches the client: no message, no
 * stack trace, no Fastify error code, no part of the request body. Server
 * errors (5xx) are logged on the server; the client sees only
 * `internal_error` or `unavailable`.
 */

/** A deliberate refusal: the status and code are what the client sees. */
export class Refusal extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = "Refusal";
    this.statusCode = statusCode;
    this.code = code;
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

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * The reply for any error. Our own refusals keep their code; other client
 * errors (4xx, for example Fastify's own "body too large") get the generic
 * code for their status; everything else becomes a 500 `internal_error`,
 * except 503 (handler timeout, server closing), which stays `unavailable`.
 */
export function errorReply(error: unknown): ErrorReply {
  if (error instanceof Refusal) {
    return { statusCode: error.statusCode, body: { error: error.code } };
  }
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return { statusCode: status, body: { error: GENERIC_CODES.get(status) ?? "bad_request" } };
  }
  if (status === 503) return { statusCode: 503, body: { error: "unavailable" } };
  return { statusCode: 500, body: { error: "internal_error" } };
}
