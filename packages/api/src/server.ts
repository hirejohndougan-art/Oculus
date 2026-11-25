/**
 * The Oculus HTTP server: Fastify 5 with the rules of D-051 and D-058 on top.
 *
 * `buildServer` returns a ready Fastify instance (call `listen` to serve, or
 * `inject` in tests). Its only route of its own is `GET /health`; the
 * application's routes come in `options.routes` as plain `OculusRoute`s
 * (routes.ts). Application code never gets the Fastify instance, request or
 * reply, only a frozen request view and a narrow reply, so it can't add
 * parsers, hooks or error handlers, raise limits, hijack replies, reach the
 * raw socket or server, or write cookies around the writer; handlers return
 * plain data or text only. Every route Fastify adds is checked again in
 * onRoute, and the instance is ready (closed to changes) on return.
 *
 * The rules, each with an attack test in this package:
 * 1. Bodies (body.ts): only Oculus's parsers: exact `application/json`, and
 *    `application/x-www-form-urlencoded` on form routes; 415 for any other
 *    type, a body without a type, and compressed bodies; prototype keys,
 *    repeated JSON keys and form fields, nesting deeper than 64, non-finite
 *    numbers, a byte order mark, bad UTF-8 and bad percent-encoding refused.
 * 2. Limits (body.ts, routes.ts): counted in bytes, chunked bodies included:
 *    1 MiB by default, 8 KiB on credentials routes (sign-in, two-step, site
 *    password); routes can't choose their own. The one exception is an
 *    upload route (M-002, D-086): `upload: { maxBytes }`, only body.ts
 *    `UPLOAD_TYPES` (which no other route takes), the body never parsed or
 *    buffered but streamed to the handler as `request.upload` and refused
 *    with 413 once it passes `maxBytes`; an upload not read to its end gets
 *    `Connection: close`.
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
 *    (`SERVER_TIMEOUTS`); options can only shorten them. Upload routes get
 *    their own (`UPLOAD_TIMEOUTS`, D-086: 60 s without a byte, 30 minutes
 *    in all); on a server with one, Node's per-server request limit is the
 *    upload's and every other request keeps its own from a timer here.
 *    After the handler timeout the request view's `signal` fires and the
 *    reply stops working.
 * 8. Errors (errors.ts): `{ "error": "<code>" }` only, never a message or a
 *    stack trace, including requests Node itself can't parse; 5xx details go
 *    to the server log as a fixed-shape record of plain strings. Whatever a
 *    handler throws is replaced by a fresh Refusal before Fastify sees it,
 *    and the error handler can't throw (it falls back to a fixed 500), so
 *    Fastify's default error handler never runs. Every header and cookie the
 *    handler set is dropped from an error reply. The request logger records
 *    the method and path only.
 * 9. Headers (headers.ts): handlers write only the allowlisted headers
 *    (Content-Language, ETag, Last-Modified, Vary, a same-origin Location,
 *    Retry-After, and the Content-Type through `type()`), and every reply,
 *    the router's own errors included, carries nosniff, no-referrer, a CSP
 *    that loads nothing and `Cache-Control: no-store`.
 *
 * 10. The built admin (admin-files.ts, T-045, D-081), when `options.admin`
 *    is given: `GET`/`HEAD` on the admin's own origin only, answered from
 *    files read into memory at startup, with the admin's own CSP
 *    (`ADMIN_SECURITY_HEADERS`) in place of the API's; every other reply
 *    keeps `SECURITY_HEADERS`.
 *
 * 11. Files (file-replies.ts, M-001, D-089): a handler sends a stored file's
 *    bytes only by returning `fileReply(...)`, which decides the Content-Type
 *    (never an active stored type), the Content-Disposition and the length;
 *    its reply gets `FILE_SECURITY_HEADERS` (nosniff, a sandboxing CSP,
 *    same-origin CORP) and nothing the handler set, cookies included. A
 *    streamed file is sent on the hijacked response, outside the handler
 *    timeout but within `timeouts.download`, and closing the server stops it.
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
  UPLOAD_TYPES,
  uploadStreams,
} from "./body.js";
import { ADMIN_SECURITY_HEADERS, adminFileFor, type AdminFiles } from "./admin-files.js";
import { cookieHeaderProblem, replyCookieProblem } from "./cookies.js";
import {
  Refusal,
  errorReply,
  rebuildThrown,
  summarizeThrown,
  type ThrownSummary,
} from "./errors.js";
import {
  FILE_SECURITY_HEADERS,
  MAX_DOWNLOAD_MS,
  isFileReply,
  sendFileStream,
  type FileReply,
} from "./file-replies.js";
import { SECURITY_HEADERS } from "./headers.js";
import { failsOriginCheck, originsFromEnv } from "./origin.js";
import { RouteTable, pathOf, pathProblem } from "./paths.js";
import { trustedProxyFromEnv } from "./proxy.js";
import {
  checkRoute,
  oculusReply,
  oculusRequest,
  resultBody,
  routeConfig,
  routeOptionsProblem,
  MAX_UPLOAD_BYTES,
  type OculusRoute,
  type OculusUpload,
} from "./routes.js";

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
  /** A streamed file download (file-replies.ts) is cut off after this. */
  readonly download: number;
}

/**
 * Upload routes only (M-002, D-086), milliseconds: `idle`, the longest a
 * request may go without a byte arriving or leaving (the socket's timeout
 * while it runs); `request`, the whole upload, body and handler. Every
 * other request keeps `SERVER_TIMEOUTS`.
 */
export interface UploadTimeouts {
  readonly idle: number;
  readonly request: number;
}

export const UPLOAD_TIMEOUTS: UploadTimeouts = { idle: 60_000, request: 30 * 60_000 };

export const SERVER_TIMEOUTS: ServerTimeouts = {
  connection: 30_000,
  request: 30_000,
  headers: 10_000,
  keepAlive: 5_000,
  handler: 30_000,
  download: MAX_DOWNLOAD_MS,
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
  /** Shorter upload timeouts (`UPLOAD_TIMEOUTS`), for tests; a longer value is refused. */
  readonly uploadTimeouts?: Partial<UploadTimeouts>;
  /** The application's routes (routes.ts); nothing else can add one. */
  readonly routes?: readonly OculusRoute[];
  /**
   * The built admin (admin-files.ts): served on `origin` only, which must be
   * one of `OCULUS_ORIGINS`.
   */
  readonly admin?: { readonly origin: string; readonly files: AdminFiles };
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

function chooseUploadTimeouts(overrides: Partial<UploadTimeouts> = {}): UploadTimeouts {
  const result = { ...UPLOAD_TIMEOUTS };
  for (const key of ["idle", "request"] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0 || value > UPLOAD_TIMEOUTS[key]) {
      throw new Error(
        `uploadTimeouts.${key} must be a whole number from 1 to ${String(UPLOAD_TIMEOUTS[key])}`,
      );
    }
    result[key] = value;
  }
  return result;
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
  if (isUploadRoute(request) && uploadTypeProblem(request)) {
    return new Refusal(415, "unsupported_media_type");
  }
  return undefined;
}

function isUploadRoute(request: FastifyRequest): boolean {
  return request.routeOptions.config.oculus?.upload === true;
}

/**
 * On an upload route: a body whose type isn't one of `UPLOAD_TYPES`, bare
 * (or a body with no type). Refused in onRequest, before a byte of it is
 * read and under the usual time limits (review B2); the parsers check again.
 */
function uploadTypeProblem(request: FastifyRequest): boolean {
  const headers = request.headers;
  const hasBody =
    headers["transfer-encoding"] !== undefined ||
    (headers["content-length"] !== undefined && headers["content-length"] !== "0");
  if (!hasBody) return false;
  const type = headers["content-type"];
  return type === undefined || !UPLOAD_TYPES.includes(type.toLowerCase());
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
      Object.entries(SECURITY_HEADERS)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("") +
      "Connection: close\r\n\r\n" +
      body,
  );
}

/**
 * What the log gets for a 500 a handler caused: a summary of plain strings,
 * never the value. Keyed by the request (not the Refusal), so two requests
 * can never share an entry.
 */
const failures = new WeakMap<FastifyRequest, ThrownSummary>();

/**
 * Logs a failure the client can no longer be told about (the handler timed
 * out and its 503 is sent, or the client has gone): the same fixed-shape
 * record of plain strings, with the method and path only. Never throws.
 */
function logLateFailure(request: FastifyRequest, fresh: Refusal, thrown: unknown): void {
  try {
    request.log.error(
      {
        failure: {
          status: fresh.statusCode,
          code: fresh.code,
          method: request.method,
          path: pathOf(request.raw.url ?? ""),
          ...summarizeThrown(thrown),
        },
      },
      "request failed after the reply was sent",
    );
  } catch {
    // A logger that fails can't change the reply, which is already sent.
  }
}

/** Requests answered with a file (M-001, D-089): they get `FILE_SECURITY_HEADERS` in onSend. */
const fileReplies = new WeakSet<FastifyRequest>();

/**
 * The upload view of an upload route's body (routes.ts `OculusUpload`): the
 * bytes, counted as they arrive and refused past `maxBytes`, read once. The
 * stream is iterated by hand and never `return`ed: a for-await loop that
 * stopped early would destroy the request and with it the socket, so the
 * 413 could never be sent. Each read races the request's signal (the
 * handler timeout's 503 sent, or the client gone): when it fires the request
 * is destroyed and the read fails at once, so a stalled or trickling client
 * can never leave the reader (and its partial file) waiting forever.
 */
function uploadView(
  request: FastifyRequest,
  maxBytes: number,
  signal: AbortSignal,
): OculusUpload | undefined {
  const stream = uploadStreams.get(request);
  if (stream === undefined) return undefined;
  uploadStreams.delete(request);
  const declared = declaredLength(request.headers["content-length"]);
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  const raw = request.raw;
  const ended = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      raw.destroy();
      reject(new Error("the request has ended"));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  // Nobody may be waiting on it yet; its rejection is handled where raced.
  ended.catch(() => undefined);
  let taken = false;
  return Object.freeze({
    contentType,
    declaredBytes: declared,
    chunks(): AsyncIterable<Uint8Array> {
      if (taken) throw new Error("an upload's bytes can be read once");
      taken = true;
      const iterator = stream[Symbol.asyncIterator]();
      return (async function* bytes() {
        let total = 0;
        for (;;) {
          if (signal.aborted) throw new Error("the request has ended");
          const next = await Promise.race([iterator.next(), ended]);
          if (next.done === true) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) throw new Error("an upload chunk is bytes");
          total += chunk.byteLength;
          if (total > maxBytes) throw new Refusal(413, "payload_too_large");
          yield chunk;
        }
      })();
    },
  });
}

/**
 * A request's declared `Content-Length` as a number, `undefined` without
 * one; throws a 413 for anything over `MAX_UPLOAD_BYTES` or longer than 16
 * digits (Node has already refused a malformed one).
 */
function declaredLength(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  if (!/^[0-9]{1,16}$/.test(header)) throw new Refusal(413, "payload_too_large");
  const value = Number(header);
  if (value > MAX_UPLOAD_BYTES) throw new Refusal(413, "payload_too_large");
  return value;
}

/**
 * Registers one application route (already checked and copied by
 * `checkRoute`). Whatever the handler throws or rejects with is caught here
 * and replaced by a fresh Refusal (errors.ts), so no value of the handler's
 * (its getters, a Proxy, a `headers` object) ever reaches Fastify, its
 * default error handler, a diagnostics_channel subscriber or the logger. The
 * request view carries an AbortSignal that fires on the handler timeout or
 * when the client goes away; from then on the reply view throws, and a late
 * result or failure is never handed to Fastify (which would log the request
 * URL, query string included, and the error object).
 */
function addRoute(
  app: FastifyInstance,
  route: OculusRoute,
  downloadMs: number,
  downloads: Set<{ stop: () => void }>,
  downloadsClosed: { value: boolean },
  uploadHandlerMs: number,
): void {
  const credentials = route.credentials === true;
  const handler = route.handler;
  app.route({
    method: route.method,
    url: route.path,
    ...(credentials ? { bodyLimit: CREDENTIALS_BODY_LIMIT } : {}),
    // An upload's handler runs while its body arrives: its own, longer limit.
    ...(route.upload === undefined ? {} : { handlerTimeout: uploadHandlerMs }),
    config: routeConfig(route),
    handler: async (request, reply) => {
      const controller = new AbortController();
      let running = true;
      const stop = (): void => {
        running = false;
        if (!controller.signal.aborted) controller.abort(new Error("the request has ended"));
      };
      // The response closes during the handler only when the handler
      // timeout has sent its 503 or the connection is gone. (Fastify's
      // `request.signal` can't be used: it also fires when the request
      // body has been read, while the handler is still working.)
      const response = reply.raw;
      if (response.writableEnded || response.destroyed) stop();
      else response.once("close", stop);
      const ended = (): boolean => controller.signal.aborted || reply.sent;
      const upload =
        route.upload === undefined
          ? undefined
          : uploadView(request, route.upload.maxBytes, controller.signal);
      let body: unknown;
      let file: FileReply | undefined;
      try {
        const result: unknown = await handler(
          oculusRequest(request, controller.signal, upload),
          oculusReply(reply, () => running),
        );
        if (isFileReply(result)) file = result;
        // Copied as plain data before Fastify sees it: a Response, stream or
        // Buffer would skip the header checks below (routes.ts).
        else body = resultBody(result);
      } catch (thrown) {
        const fresh = rebuildThrown(thrown);
        if (ended()) {
          // Too late to answer: Fastify would log `{ err }` (pino's error
          // serializer throws on a frozen Refusal) and then "reply already
          // sent" with the full URL. Log the summary here and stop.
          logLateFailure(request, fresh, thrown);
          return undefined;
        }
        if (fresh.statusCode >= 500) failures.set(request, summarizeThrown(thrown));
        throw fresh;
      } finally {
        running = false;
        response.removeListener("close", stop);
      }
      // Timed out (the 503 is already sent) or the client has gone.
      if (ended()) return undefined;
      if (file !== undefined) {
        // A file (file-replies.ts): exactly its own headers, whatever the
        // handler set, always a 200, with the file headers.
        for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
        if (file.body instanceof Uint8Array) {
          fileReplies.add(request);
          return reply.code(200).headers(file.headers).send(file.body);
        }
        // Closing: no new download starts (one already running is stopped).
        if (downloadsClosed.value) {
          return reply.code(503).header("connection", "close").send({ error: "unavailable" });
        }
        // A stream: sent on the raw response, outside the handler timeout,
        // within the download deadline, and stopped if the server closes.
        void reply.hijack();
        const entry: { sending?: { stop: () => void }; over?: true } = {};
        const sending = sendFileStream(
          reply.raw,
          request.method,
          { ...file.headers, ...FILE_SECURITY_HEADERS },
          SECURITY_HEADERS,
          file,
          downloadMs,
          (why) => {
            entry.over = true;
            if (entry.sending !== undefined) downloads.delete(entry.sending);
            // A client going away is ordinary (seeking, leaving the page).
            if (why !== "done" && why !== "client") {
              request.log.warn({ failure: { code: `file_stream_${why}` } }, "file reply cut off");
            }
          },
        );
        if (entry.over === undefined) {
          entry.sending = sending;
          downloads.add(sending);
        }
        return undefined;
      }
      return reply.send(body);
    },
  });
}

const FALLBACK_BODY = '{"error":"internal_error"}';

/**
 * The last resort when the error handler itself fails: a fixed 500 written
 * straight to the socket with the security headers, or a closed connection
 * if the reply has already started. Never throws.
 */
function sendFallback(reply: FastifyReply): void {
  try {
    const raw = reply.raw;
    if (raw.headersSent || raw.writableEnded) {
      raw.destroy();
      return;
    }
    void reply.hijack();
    for (const name of raw.getHeaderNames()) raw.removeHeader(name);
    raw.writeHead(500, {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(FALLBACK_BODY)),
    });
    raw.end(FALLBACK_BODY);
  } catch {
    try {
      reply.raw.destroy();
    } catch {
      // Nothing is left to try.
    }
  }
}

/** `{ "error": code }` with the security headers, for replies that skip onSend. */
function sendDirect(reply: FastifyReply, status: number, code: string): void {
  try {
    // A body not read to its end never becomes the next request (B2).
    if (!reply.request.raw.complete) void reply.header("connection", "close");
    void reply
      .code(status)
      .headers(SECURITY_HEADERS)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ error: code }));
  } catch {
    sendFallback(reply);
  }
}

/** What the log shows for an error object Fastify passes to the logger. */
const OMITTED_ERROR = Object.freeze({ type: "omitted", message: "", stack: "" });

/** Fields a log record may carry; Fastify's own and the `failure` record. */
const LOG_FIELDS: ReadonlySet<string> = new Set([
  "req",
  "res",
  "failure",
  "responseTime",
  "statusCode",
]);

/**
 * A query string (`?` and what follows up to white space) removed from a log
 * message. Fastify writes `request.url` into some messages ("Reply was
 * already sent … in "/x?q=…"", "Route GET:/x?q=… not found").
 */
export function withoutQuery(text: string): string {
  return text.replace(/\?\S+/g, "");
}

/** The merging object of a log call, rebuilt from the allowed fields only. */
function safeLogFields(value: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null) return fields;
  if (value instanceof Error) {
    fields.err = OMITTED_ERROR;
    return fields;
  }
  for (const key of Object.keys(value)) {
    if (key === "err") fields.err = OMITTED_ERROR;
    else if (LOG_FIELDS.has(key)) fields[key] = (value as Record<string, unknown>)[key];
  }
  return fields;
}

/**
 * pino's `logMethod` hook: every log call (Fastify's and ours) goes out as
 * at most a rebuilt merging object and one message with any query string
 * removed. Error objects are never serialized, their messages never become
 * the log message, and printf-style arguments are dropped.
 */
function safeLogCall(this: unknown, args: unknown[], method: (...args: unknown[]) => void): void {
  const [first, second] = args;
  if (typeof first === "string") {
    method.call(this, withoutQuery(first));
    return;
  }
  const fields = safeLogFields(first);
  // Without a message pino would take `err.message`; give it a fixed one.
  const message = typeof second === "string" ? withoutQuery(second) : "log record";
  method.call(this, fields, message);
}

/** A request's host as `URL.host` writes it for `protocol` (default port dropped), or undefined. */
function normalHost(protocol: string, host: unknown): string | undefined {
  if (typeof host !== "string" || host === "") return undefined;
  try {
    const url = new URL(`${protocol}//${host}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/") return undefined;
    return url.host;
  } catch {
    return undefined;
  }
}

/** Builds the configured Oculus server and waits until it is ready. */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const timeouts = chooseTimeouts(options.timeouts);
  const uploadTimeouts = chooseUploadTimeouts(options.uploadTimeouts);
  const env = options.env ?? process.env;
  const trustProxy = trustedProxyFromEnv(env);
  const origins = originsFromEnv(env);
  const appRoutes = (options.routes ?? []).map(checkRoute);
  // With an upload route, Node's whole-request limit (one per server) is the
  // upload's, and every other request gets its usual limit from a timer of
  // our own (the onRequest hook below).
  const hasUploads = appRoutes.some((r) => r.upload !== undefined);
  const admin = options.admin;
  if (admin !== undefined && !origins.has(admin.origin)) {
    throw new Error("the admin's origin must be one of OCULUS_ORIGINS");
  }
  const adminHost = admin === undefined ? undefined : new URL(admin.origin).host;
  const adminProtocol = admin === undefined ? undefined : new URL(admin.origin).protocol;
  /** Replies that are admin files: they get the admin's headers in onSend. */
  const adminReplies = new WeakSet<FastifyRequest>();

  const logger: FastifyServerOptions["logger"] =
    options.logger === undefined || options.logger === false
      ? false
      : {
          level: "info",
          ...(options.logger === true ? {} : { stream: options.logger.stream }),
          serializers: {
            // Method and path only: no query string, headers, cookies or address.
            req: (req) => ({ method: req.method, url: pathOf(req.url) }),
            // Never looks at the error: pino's own serializer writes to it (and
            // throws on a frozen Refusal) and copies its message, which for
            // Fastify's own errors can hold the URL with its query string.
            err: () => OMITTED_ERROR,
          },
          hooks: { logMethod: safeLogCall },
        };

  const app: FastifyInstance = Fastify({
    logger,
    trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    connectionTimeout: timeouts.connection,
    requestTimeout: hasUploads ? uploadTimeouts.request : timeouts.request,
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
      // A URL the router can't decode (`/items/%C0%AF`) or a parameter
      // longer than maxParamLength. These replies skip the onSend hook, so
      // the security headers are set here. The reply type here is generic.
      sendDirect(reply, 400, "bad_request");
    },
    clientErrorHandler: clientError,
  });

  const routes = new RouteTable(MAX_PARAM_LENGTH);

  registerBodyParsers(app);

  app.addHook("onRoute", (route) => {
    const problem = routeOptionsProblem(route);
    if (problem !== undefined) throw new Error(`${route.url}: ${problem}`);
    routes.add(route.method, route.url);
  });

  // Rule 3 first: nothing else looks at a refused path.
  app.addHook("onRequest", (request, reply, done) => {
    const refusal = requestRefusal(request, origins);
    if (hasUploads) {
      if (refusal === undefined && isUploadRoute(request)) uploadLimits(request);
      else usualLimit(request, reply);
    }
    done(refusal);
  });

  /**
   * An accepted upload (D-086): no byte for `uploadTimeouts.idle` ends it
   * (the socket's own timeout while it runs; Node puts the keep-alive
   * timeout back after the reply). The whole upload is the route's handler
   * timeout and Node's requestTimeout.
   */
  function uploadLimits(request: FastifyRequest): void {
    const socket = request.raw.socket;
    // (`inject`'s stand-in socket has no timeout to set.)
    if (typeof socket.setTimeout === "function") socket.setTimeout(uploadTimeouts.idle);
  }

  /**
   * Every other request on a server with upload routes (whose Node
   * requestTimeout is the upload's): the usual limit from a timer of our
   * own. If the body still hasn't arrived by then, the 408 Node would send,
   * or, when a reply has already gone out (a request refused before its
   * body was read), the connection is closed (review B2).
   */
  function usualLimit(request: FastifyRequest, reply: FastifyReply): void {
    const raw = request.raw;
    const socket = raw.socket;
    if (raw.complete) return;
    const timer = setTimeout(() => {
      if (raw.complete) return;
      if (!reply.raw.headersSent) clientError({ code: "ERR_HTTP_REQUEST_TIMEOUT" }, socket);
      else socket.destroy();
    }, timeouts.request);
    timer.unref();
    const clear = (): void => {
      clearTimeout(timer);
      raw.removeListener("end", clear);
      socket.removeListener("close", clear);
    };
    raw.once("end", clear);
    socket.once("close", clear);
  }

  app.addHook("onSend", async (request, reply, payload) => {
    if (replyCookieProblem(reply, reply.getHeader("set-cookie")) !== undefined) {
      reply.removeHeader("set-cookie");
      throw new Error("a Set-Cookie header broke the cookie rules");
    }
    const headers = adminReplies.has(request)
      ? ADMIN_SECURITY_HEADERS
      : fileReplies.has(request)
        ? FILE_SECURITY_HEADERS
        : SECURITY_HEADERS;
    for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
    // Any body not read to its end (refused before or while it arrived, on
    // any route): the connection closes after the reply, so the rest never
    // becomes the next request and the client can't hold it open (B2).
    if (!request.raw.complete) void reply.header("connection", "close");
    return payload;
  });

  // The error handler can't throw: if anything in it fails (a logger whose
  // stream throws, say), the fixed fallback is written instead, so Fastify's
  // own default error handler (which sends the message and copies
  // `error.headers`) is never reached. It reads the error only through
  // errorReply and summarizeThrown, which never throw.
  app.setErrorHandler((error, request, reply) => {
    try {
      const { statusCode, body } = errorReply(error);
      if (statusCode >= 500) {
        const thrown = failures.get(request) ?? summarizeThrown(error);
        failures.delete(request);
        // A fixed-shape record of plain strings; never the error object itself.
        request.log.error(
          { failure: { status: statusCode, code: body.error, ...thrown } },
          "request failed",
        );
      }
      // Nothing the handler set (headers, cookies, Location) goes out with an error.
      for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
      fileReplies.delete(request);
      return reply.code(statusCode).type("application/json; charset=utf-8").send(body);
    } catch {
      sendFallback(reply);
      return undefined;
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const path = pathOf(request.raw.url ?? "");
    const allowed = routes.allowedMethods(path);
    // The built admin: only on the admin's own origin, only GET and HEAD,
    // only paths no route claims (rule 10).
    if (
      admin !== undefined &&
      allowed.length === 0 &&
      (request.method === "GET" || request.method === "HEAD") &&
      `${request.protocol}:` === adminProtocol &&
      normalHost(adminProtocol, request.host) === adminHost
    ) {
      const file = adminFileFor(admin.files, path);
      if (file !== undefined) {
        adminReplies.add(request);
        return reply.code(200).type(file.type).send(file.body);
      }
    }
    const wrongMethod = allowed.length > 0 && !allowed.includes(request.method);
    if (wrongMethod) reply.header("allow", allowed.join(", "));
    return reply
      .code(wrongMethod ? 405 : 404)
      .send({ error: wrongMethod ? "method_not_allowed" : "not_found" });
  });

  // Streamed downloads in flight (file-replies.ts): stopped when the server
  // closes, so a slow reader can't hold shutdown open.
  const downloads = new Set<{ stop: () => void }>();
  const downloadsClosed = { value: false };
  app.addHook("preClose", (done) => {
    downloadsClosed.value = true;
    for (const download of [...downloads]) download.stop();
    done();
  });
  const health = checkRoute({ method: "GET", path: "/health", handler: () => ({ status: "ok" }) });
  addRoute(app, health, timeouts.download, downloads, downloadsClosed, uploadTimeouts.request);
  for (const route of appRoutes) {
    addRoute(app, route, timeouts.download, downloads, downloadsClosed, uploadTimeouts.request);
  }

  await app.ready();
  return app;
}
