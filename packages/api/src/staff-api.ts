/**
 * The staff JSON API (T-042, D-079): records, the dry-run check, staff
 * search, templates and identifier types, each a thin wrapper over the
 * service layer (D-067), which is the only writer and decides every
 * permission (D-072, D-074). These are the admin's routes (D-034: served on
 * the admin's own hostname, D-052); none of them may be served to a public
 * site.
 *
 * Every request, before the service is asked anything:
 * 1. the server's own rules (server.ts, D-051, D-058): path, body size and
 *    type, cookies, and for every change an `Origin` listed in
 *    `OCULUS_ORIGINS` naming this host (or `Sec-Fetch-Site: same-origin`);
 * 2. the session cookie (`__Host-oculus_session`) must name a **full**
 *    session: `resolveSession` (D-069) refuses a session waiting for its
 *    second step, an ended or expired one and an unknown token alike, all
 *    `401 unauthenticated`;
 * 3. every method but GET and HEAD carries `X-Oculus-CSRF`, the session's
 *    CSRF token (`csrfTokenFor`), compared in constant time
 *    (`checkCsrfToken`); otherwise `403 csrf_failed`, before the session is
 *    looked up;
 * 4. a per-session limit (rate-limit.ts): `429 rate_limited`;
 * 5. the service context is built from the session only: its organization
 *    and `user:<id>`, plus the working site from `X-Oculus-Site` (checked as
 *    a site ID here; whether the person works there is the service's,
 *    answered as for a site that doesn't exist).
 *
 * Replies: data as JSON. Refusals are fixed codes: `{ "error": code }`,
 * with core's `issues` (fixed codes, the checks' own messages) for a draft
 * that fails a check (`422 invalid`), an edit conflict (`412
 * version_conflict`, with the names-only `conflict`) and a change that needs
 * confirming (`409 confirmation_required`). A record that doesn't exist and
 * one the person may not see are the same `404 not_found`, byte for byte
 * (the service answers both `unknown_record`). Nothing a database or the
 * code throws reaches a reply: the service maps errors to fixed codes and
 * hands the raw error to `onError`, which this module logs redacted
 * (`redactedError`: the error's class name and SQLSTATE or system code
 * only, never its message, `detail`, `where` or bound values, D-068).
 *
 * History, restore and the workflow (T-043, D-082): a record's versions
 * (a page of summaries, one version's content, two compared) for people
 * holding `records.history` where the record is (read-only people see no
 * old versions, D-072); restoring a version (`If-Match` the current
 * version, the service's `restoreVersion` with its S-020/S-028 checks and
 * lock order); and the four workflow moves of D-075/D-076 (`If-Match`,
 * optional `reason`), each checked by the service: sending for review and
 * back to draft need the edit permission, publishing and withdrawing
 * `records.publish`; and the approval queue (records sent for review on
 * the whole sites where the person may publish). Every one of them
 * answers a record that doesn't
 * exist, one on another site and another organization's alike (`404
 * not_found`), and a version the record doesn't have the same way, but
 * only once the person may read its history.
 *
 * The admin's lists (T-046, D-083): `GET /api/records` (the working site's
 * items, filtered by state and record type, sorted, or searched), `GET
 * /api/record-types`, `GET /api/working-site` (what the person may do
 * there), and `GET /api/records/:id` says what the person may do with the
 * record (`can`) and what it inherits (`inherited`).
 *
 * Not here: signing in, the second step, password reset and signing out
 * (T-045 adds those routes beside these, with `credentials: true` for the
 * 8 KiB limit, and writes the cookie through the reply's cookie writer).
 */
import {
  checkCsrfToken,
  csrfTokenFor,
  isSiteId,
  issue,
  type Issue,
  type RecordId,
} from "@oculus/core";
import { resolveSession, type FullSession, type Queryable } from "@oculus/db";
import {
  contextFromSession,
  type RecordService,
  type ServiceContext,
  type ServiceRefusal,
  type WorkflowOptions,
} from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";

/** A fixed-shape log record: never an error object, a token, a body or a query. */
export interface ApiLogRecord {
  readonly event:
    | "service_error"
    | "session_error"
    | "refused_5xx"
    // The sign-in routes (sign-in-api.ts, D-081) and the admin's startup (admin-server.ts).
    | "sign_in_error"
    | "client_address_warning"
    | "reset_settled"
    | "reset_link_produced"
    | "startup_warning";
  readonly operation?: string;
  readonly code?: string;
  readonly name?: string;
}

export interface StaffApiOptions {
  /** The database sessions are resolved in (the service's writer pool). */
  readonly db: Queryable;
  /** The service, made with `onError: serviceErrorLogger(log)` so its errors are logged redacted. */
  readonly service: RecordService;
  /** Where fixed-shape log records go; default: one JSON line on standard error. */
  readonly log?: (record: ApiLogRecord) => void;
  /** Requests per minute per session, per kind (rate-limit.ts). */
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  /** The limiter's clock (tests). */
  readonly clock?: () => number;
}

/** The header carrying the CSRF token on every change. */
export const CSRF_HEADER = "x-oculus-csrf";
/** The header naming the working site. */
export const SITE_HEADER = "x-oculus-site";

const SYSTEM_CODE = /^E[A-Z0-9_]{1,40}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

/**
 * What the log may hold of a thrown error: its class name and its SQLSTATE
 * or Node system code, read from own data properties only. Never its
 * message (a driver's message can quote a value), `detail` (a unique
 * violation's key), `where` (bound parameters, D-068) or stack.
 */
export function redactedError(error: unknown): { readonly name?: string; readonly code?: string } {
  const out: { name?: string; code?: string } = {};
  if (typeof error !== "object" || error === null) return out;
  try {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const value: unknown = code !== undefined && "value" in code ? code.value : undefined;
    if (typeof value === "string" && (SQLSTATE.test(value) || SYSTEM_CODE.test(value))) {
      out.code = value;
    }
    let proto: unknown = Object.getPrototypeOf(error);
    while (typeof proto === "object" && proto !== null) {
      const ctor = Object.getOwnPropertyDescriptor(proto, "constructor");
      const fn: unknown = ctor !== undefined && "value" in ctor ? ctor.value : undefined;
      const name =
        typeof fn === "function" ? Object.getOwnPropertyDescriptor(fn, "name") : undefined;
      const text: unknown = name !== undefined && "value" in name ? name.value : undefined;
      if (typeof text === "string" && CLASS_NAME.test(text)) {
        out.name = text;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    // A Proxy's trap threw: log nothing more.
  }
  return out;
}

function defaultLog(record: ApiLogRecord): void {
  try {
    process.stderr.write(`${JSON.stringify({ oculus: record })}\n`);
  } catch {
    // Logging can't fail a request.
  }
}

/** The service's `onError`, logging the redacted error with the operation. */
export function serviceErrorLogger(
  log: (record: ApiLogRecord) => void = defaultLog,
): (error: unknown, operation: string) => void {
  return (error, operation) => {
    log({
      event: "service_error",
      operation: CLASS_NAME.test(operation) ? operation : "unknown",
      ...redactedError(error),
    });
  };
}

// ---------------------------------------------------------------------------
// Reading the request

/** A JSON object body, or `400 bad_body`. */
function objectBody(request: OculusRequest): Readonly<Record<string, unknown>> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Refusal(400, "bad_body");
  }
  return body as Readonly<Record<string, unknown>>;
}

/** The body's keys must be among `allowed`; else `422 invalid` naming the first other. */
function onlyKeys(
  body: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  reply: OculusReply,
): { readonly error: string; readonly issues: readonly Issue[] } | undefined {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra === undefined) return undefined;
  reply.status(422);
  return {
    error: "invalid",
    issues: [
      issue([extra], "unknown_property", `The request body has only ${allowed.join(", ")}.`),
    ],
  };
}

const VERSION_TAG = /^"v([1-9][0-9]{0,9})"$/;
const TYPE_TAG = /^"t-([A-Za-z0-9_-]{32})"$/;

/** `If-Match: "v<N>"`: the version an edit started from (428 without, 400 malformed). */
function ifMatchVersion(request: OculusRequest): number {
  const value = request.headers["if-match"];
  if (value === undefined) throw new Refusal(428, "precondition_required");
  const match = VERSION_TAG.exec(value);
  const n = Number(match?.[1]);
  if (match === null || !Number.isSafeInteger(n) || n >= 2 ** 31 - 1) {
    throw new Refusal(400, "bad_if_match");
  }
  return n;
}

/**
 * For a definition saved by PUT: `If-None-Match: *` for a new one, or
 * `If-Match` with its tag; exactly one of them (428 without, 400 both or
 * malformed).
 */
function newOrMatch(request: OculusRequest, pattern: RegExp): { readonly tag: string } | "new" {
  const match = request.headers["if-match"];
  const none = request.headers["if-none-match"];
  if (match === undefined && none === undefined) throw new Refusal(428, "precondition_required");
  if (match !== undefined && none !== undefined) throw new Refusal(400, "bad_if_match");
  if (none !== undefined) {
    if (none !== "*") throw new Refusal(400, "bad_if_match");
    return "new";
  }
  const found = pattern.exec(match ?? "");
  if (found?.[1] === undefined) throw new Refusal(400, "bad_if_match");
  return { tag: found[1] };
}

/** One text query parameter (400 when sent twice). */
function queryText(request: OculusRequest, name: string): string | undefined {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Refusal(400, "bad_query");
  return value;
}

/** A whole number query parameter (400 otherwise). */
function queryNumber(request: OculusRequest, name: string, max: number): number | undefined {
  const text = queryText(request, name);
  if (text === undefined) return undefined;
  if (!/^[1-9][0-9]{0,9}$/.test(text)) throw new Refusal(400, "bad_query");
  const n = Number(text);
  if (n > max) throw new Refusal(400, "bad_query");
  return n;
}

/**
 * A version number from the path or the query: a whole number from 1, or
 * 0 for anything else, which the service answers as a version the record
 * doesn't have (only once the person may read its history, so a malformed
 * number says nothing about a record they can't see).
 */
function versionNumber(text: string | undefined): number {
  if (text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) return 0;
  const n = Number(text);
  return n < 2 ** 31 - 1 ? n : 0;
}

/** An optional body of a workflow move or a restore: only `allowed` keys. */
function optionalBody(
  request: OculusRequest,
  allowed: readonly string[],
  reply: OculusReply,
):
  | { readonly body: Readonly<Record<string, unknown>> }
  | { readonly error: string; readonly issues: readonly Issue[] } {
  if (request.body === undefined) return { body: {} };
  const body = objectBody(request);
  const extra = onlyKeys(body, allowed, reply);
  return extra ?? { body };
}

// ---------------------------------------------------------------------------
// Service answers as HTTP replies

const MISSING_CODES: ReadonlySet<string> = new Set(["unknown_record", "invalid_id"]);
/** A version the record doesn't have: the service asks only after the history permission. */
const NO_VERSION_CODES: ReadonlySet<string> = new Set(["unknown_version", "invalid_version"]);
const VERSION_PATHS: ReadonlySet<string> = new Set(["version", "from", "to"]);
const SERVER_FAULTS: ReadonlySet<string> = new Set([
  "internal_error",
  "writer_role_refused",
  "read_committed_required",
  "unreadable_record",
  "unreadable_template",
  "unreadable_types",
  "invalid_time",
]);
const CONTEXT_CODES: ReadonlySet<string> = new Set([
  "invalid_organization",
  "unknown_organization",
  "invalid_actor",
  "invalid_site",
]);

/** The refusal as the HTTP reply: thrown `Refusal` for fixed codes, or data with issues. */
function refused(result: ServiceRefusal, reply: OculusReply, log: (r: ApiLogRecord) => void) {
  const issues = result.issues;
  const codes = new Set(issues.map((i) => i.code));
  const onPath = (i: Issue, first: string): boolean => i.path.length === 1 && i.path[0] === first;
  // A record (or template) that doesn't exist and one out of sight: the
  // service answers both alike, and so does this, with nothing else.
  if (
    issues.length > 0 &&
    issues.every(
      (i) =>
        (MISSING_CODES.has(i.code) && onPath(i, "recordId")) ||
        (NO_VERSION_CODES.has(i.code) &&
          i.path.length === 1 &&
          VERSION_PATHS.has(String(i.path[0]))) ||
        (i.code === "unknown_template" && onPath(i, "key")),
    )
  ) {
    throw new Refusal(404, "not_found");
  }
  if (codes.has("not_permitted")) throw new Refusal(403, "not_permitted");
  if (issues.some((i) => CONTEXT_CODES.has(i.code) && i.path[0] === "context")) {
    // The session's organization or person is gone or unusable.
    throw new Refusal(403, "not_permitted");
  }
  for (const code of SERVER_FAULTS) {
    if (codes.has(code)) {
      log({ event: "refused_5xx", code });
      throw new Refusal(500, "internal_error");
    }
  }
  if (codes.has("retry")) throw new Refusal(503, "retry");
  if (codes.has("timeout")) throw new Refusal(503, "timeout");
  if (codes.has("search_timeout")) throw new Refusal(503, "search_timeout");
  if (codes.has("missing_reference") || codes.has("refused_by_database")) {
    throw new Refusal(409, "conflict");
  }
  if (codes.has("version_conflict")) {
    reply.status(412);
    return {
      error: "version_conflict",
      issues,
      ...(result.conflict === undefined ? {} : { conflict: result.conflict }),
    };
  }
  if (codes.has("needs_confirmation") || codes.has("publishes_records")) {
    reply.status(409);
    return { error: "confirmation_required", issues };
  }
  if (codes.has("too_many_records")) {
    reply.status(422);
    return { error: "too_many_records", issues };
  }
  reply.status(422);
  return { error: "invalid", issues };
}

// ---------------------------------------------------------------------------
// The routes

type Handler = (
  request: OculusRequest,
  reply: OculusReply,
  signed: { readonly session: FullSession; readonly context: ServiceContext },
) => Promise<unknown>;

/** The staff API's routes, for `buildServer({ routes })`. */
export function staffApiRoutes(options: StaffApiOptions): OculusRoute[] {
  const { db, service } = options;
  const log = options.log ?? defaultLog;
  const limiter = new SessionRateLimiter(
    { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    options.clock,
  );

  /**
   * Wraps a handler with the session, CSRF, rate and context steps of the
   * module header. `unsafe` for every method but GET.
   */
  function signedIn(bucket: RateBucket, unsafe: boolean, handler: Handler) {
    return async (request: OculusRequest, reply: OculusReply): Promise<unknown> => {
      const token = request.cookies[OCULUS_COOKIES.session];
      if (token === undefined) throw new Refusal(401, "unauthenticated");
      // Before the database is asked: a change without the token (or with
      // another session's) is refused at once, in constant time.
      if (unsafe && !checkCsrfToken(token, request.headers[CSRF_HEADER])) {
        throw new Refusal(403, "csrf_failed");
      }
      const resolved = await resolveSession(db, token, {
        onError: (error) => {
          log({ event: "session_error", ...redactedError(error) });
        },
      });
      if (!resolved.ok) {
        if (resolved.code === "no_session") throw new Refusal(401, "unauthenticated");
        throw new Refusal(503, "unavailable");
      }
      const session = resolved.session;
      if (!limiter.take(session.sessionId, bucket)) throw new Refusal(429, "rate_limited");
      const siteHeader = request.headers[SITE_HEADER];
      if (siteHeader !== undefined && !isSiteId(siteHeader)) {
        reply.status(422);
        return {
          error: "invalid",
          issues: [issue(["context", "siteId"], "invalid_site", "The working site is a site ID.")],
        };
      }
      const context: ServiceContext = {
        ...contextFromSession(session),
        ...(siteHeader === undefined ? {} : { siteId: siteHeader }),
      };
      return handler(request, reply, { session, context });
    };
  }

  function answer<T>(
    result: { readonly ok: true; readonly value: T } | ServiceRefusal,
    reply: OculusReply,
    ok: (value: T) => unknown,
  ): unknown {
    return result.ok ? ok(result.value) : refused(result, reply, log);
  }

  const recordId = (request: OculusRequest): RecordId => request.params.id as RecordId;

  /** One of D-075's moves: `If-Match` the version seen, an optional `{ reason }`. */
  function workflowRoute(
    path: string,
    move: "submitForReview" | "returnToDraft" | "publish" | "withdraw",
  ): OculusRoute {
    return {
      method: "POST",
      path,
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        const read = optionalBody(request, ["reason"], reply);
        if ("error" in read) return read;
        const options: WorkflowOptions = {
          expectedVersion,
          ...(read.body.reason === undefined ? {} : { reason: read.body.reason as string }),
        };
        const result = await service[move](context, recordId(request), options);
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    };
  }

  return [
    {
      method: "GET",
      path: "/api/session",
      handler: signedIn("read", false, (request, _reply, { session }) =>
        Promise.resolve({
          userId: session.userId,
          organizationId: session.organizationId,
          systemAdmin: session.systemAdmin,
          expiresAt: session.expiresAt,
          idleExpiresAt: session.idleExpiresAt,
          recentlyAuthenticated: session.recentlyAuthenticated,
          // Derived from the cookie's token (D-069): the admin sends it back
          // in X-Oculus-CSRF on every change. Readable by this origin only.
          csrfToken: csrfTokenFor(request.cookies[OCULUS_COOKIES.session]) ?? null,
        }),
      ),
    },
    {
      method: "GET",
      path: "/api/records/:id",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readRecord(context, recordId(request));
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return {
            record: value.record,
            version: value.version,
            state: value.state,
            can: value.can,
            inherited: value.inherited,
          };
        });
      }),
    },
    {
      method: "POST",
      path: "/api/records",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["record", "identifiers", "reason"], reply);
        if (extra) return extra;
        // The service reads and checks its options itself (D-067).
        const createOptions = {
          ...(body.identifiers === undefined ? {} : { identifiers: body.identifiers }),
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        };
        const result = await service.createRecord(context, body.record, createOptions as never);
        return answer(result, reply, (value) => {
          reply
            .status(201)
            .header("etag", `"v${String(value.version)}"`)
            .header("location", `/api/records/${value.record.id}`);
          return { record: value.record, version: value.version };
        });
      }),
    },
    {
      method: "POST",
      path: "/api/records/check",
      handler: signedIn("check", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["record", "recordId"], reply);
        if (extra) return extra;
        const result = await service.checkRecord(
          context,
          body.record,
          body.recordId === undefined ? {} : { recordId: body.recordId },
        );
        return answer(result, reply, (value) => ({ issues: value.issues }));
      }),
    },
    {
      method: "PUT",
      path: "/api/records/:id",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        const body = objectBody(request);
        const extra = onlyKeys(
          body,
          ["record", "identifiers", "confirmDropped", "confirmTemplateMove", "reason"],
          reply,
        );
        if (extra) return extra;
        const options: Record<string, unknown> = { expectedVersion };
        for (const key of ["identifiers", "confirmDropped", "confirmTemplateMove", "reason"]) {
          if (body[key] !== undefined) options[key] = body[key];
        }
        const result = await service.updateRecord(
          context,
          recordId(request),
          body.record,
          options as never,
        );
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return { record: value.record, version: value.version, changed: value.changed };
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/records/:id",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        let reason: unknown;
        if (request.body !== undefined) {
          const body = objectBody(request);
          const extra = onlyKeys(body, ["reason"], reply);
          if (extra) return extra;
          reason = body.reason;
        }
        const deleteOptions = { expectedVersion, ...(reason === undefined ? {} : { reason }) };
        const result = await service.deleteRecord(
          context,
          recordId(request),
          deleteOptions as never,
        );
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "GET",
      path: "/api/search",
      handler: signedIn("search", false, async (request, reply, { context }) => {
        const query = queryText(request, "q");
        if (query === undefined) throw new Refusal(400, "bad_query");
        const limit = queryNumber(request, "limit", 100);
        const after = queryText(request, "after");
        const result = await service.searchRecords(context, query, {
          ...(limit === undefined ? {} : { limit }),
          ...(after === undefined ? {} : { after }),
        });
        return answer(result, reply, (value) => value);
      }),
    },
    {
      // The items list (T-046, D-083): the working site's records, filtered,
      // sorted or searched, a page at a time. Every filter is applied in
      // the database query, so a page's length says nothing about records
      // the person can't see.
      method: "GET",
      path: "/api/records",
      handler: signedIn("search", false, async (request, reply, { context }) => {
        const query = queryText(request, "q");
        const state = queryText(request, "state");
        const recordType = queryText(request, "type");
        const sort = queryText(request, "sort");
        const after = queryText(request, "after");
        const limit = queryNumber(request, "limit", 100);
        if (
          (state !== undefined && !/^[a-z_]{1,40}$/.test(state)) ||
          (recordType !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(recordType)) ||
          (sort !== undefined && sort !== "updated" && sort !== "title") ||
          (after !== undefined && !/^[0-9a-f.-]{1,80}$/.test(after)) ||
          query?.trim() === ""
        ) {
          throw new Refusal(400, "bad_query");
        }
        const result = await service.listItems(context, {
          ...(query === undefined ? {} : { query }),
          ...(state === undefined ? {} : { state }),
          ...(recordType === undefined ? {} : { recordType }),
          ...(sort === undefined ? {} : { sort }),
          ...(after === undefined ? {} : { after }),
          ...(limit === undefined ? {} : { limit }),
        });
        return answer(result, reply, (value) => ({
          records: value.records,
          next: value.next ?? null,
        }));
      }),
    },
    {
      method: "GET",
      path: "/api/record-types",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.listRecordTypes(context);
        return answer(result, reply, (value) => ({ recordTypes: value }));
      }),
    },
    {
      // What the person may do in the working site (T-046): which buttons
      // the admin shows. Every operation still checks for itself.
      method: "GET",
      path: "/api/working-site",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.siteAbilities(context);
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "GET",
      path: "/api/records/:id/versions",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const limit = queryNumber(request, "limit", 100);
        const after = queryNumber(request, "after", 2 ** 31 - 2);
        const result = await service.listVersions(context, recordId(request), {
          ...(limit === undefined ? {} : { limit }),
          ...(after === undefined ? {} : { after }),
        });
        return answer(result, reply, (value) => ({
          versions: value.versions,
          next: value.truncated ? (value.versions.at(-1)?.version ?? null) : null,
        }));
      }),
    },
    {
      method: "GET",
      path: "/api/records/:id/versions/:version",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readRecordVersion(
          context,
          recordId(request),
          versionNumber(request.params.version),
        );
        return answer(result, reply, (value) => ({ version: value }));
      }),
    },
    {
      method: "GET",
      path: "/api/records/:id/compare",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.compareRecordVersions(
          context,
          recordId(request),
          versionNumber(queryText(request, "from")),
          versionNumber(queryText(request, "to")),
        );
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "POST",
      path: "/api/records/:id/versions/:version/restore",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        const read = optionalBody(request, ["reason", "confirmMadePublic"], reply);
        if ("error" in read) return read;
        const options: Record<string, unknown> = { expectedVersion };
        for (const key of ["reason", "confirmMadePublic"]) {
          if (read.body[key] !== undefined) options[key] = read.body[key];
        }
        const result = await service.restoreVersion(
          context,
          recordId(request),
          versionNumber(request.params.version),
          options as never,
        );
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return { record: value.record, version: value.version };
        });
      }),
    },
    {
      method: "GET",
      path: "/api/review-queue",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const limit = queryNumber(request, "limit", 100);
        const after = queryText(request, "after");
        const result = await service.reviewQueue(context, {
          ...(limit === undefined ? {} : { limit }),
          ...(after === undefined ? {} : { after }),
        });
        return answer(result, reply, (value) => ({
          records: value.records,
          next: value.next ?? null,
        }));
      }),
    },
    workflowRoute("/api/records/:id/submit-for-review", "submitForReview"),
    workflowRoute("/api/records/:id/return-to-draft", "returnToDraft"),
    workflowRoute("/api/records/:id/publish", "publish"),
    workflowRoute("/api/records/:id/withdraw", "withdraw"),
    {
      method: "GET",
      path: "/api/templates",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.listTemplates(context);
        return answer(result, reply, (value) => ({ templates: value }));
      }),
    },
    {
      method: "GET",
      path: "/api/templates/:key",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const version = queryNumber(request, "version", 2 ** 31 - 2);
        const result = await service.readTemplate(context, request.params.key ?? "", version);
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/templates/:key",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const precondition = newOrMatch(request, VERSION_TAG);
        const body = objectBody(request);
        const extra = onlyKeys(body, ["template", "confirm", "confirmPublished"], reply);
        if (extra) return extra;
        const template = body.template;
        const key = request.params.key;
        if (typeof template !== "object" || template === null || Array.isArray(template)) {
          throw new Refusal(400, "bad_body");
        }
        const named = (template as Record<string, unknown>).key;
        if (named !== undefined && named !== key) {
          reply.status(422);
          return {
            error: "invalid",
            issues: [issue(["template", "key"], "wrong_key", "The template's key is the path's.")],
          };
        }
        const result = await service.saveTemplate(
          context,
          { ...(template as Record<string, unknown>), key },
          {
            expectedVersion: precondition === "new" ? 0 : Number(precondition.tag),
            ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
            ...(body.confirmPublished === undefined
              ? {}
              : { confirmPublished: body.confirmPublished }),
          },
        );
        return answer(result, reply, (value) => {
          if (precondition === "new") reply.status(201);
          reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    },
    {
      method: "GET",
      path: "/api/identifier-types",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.listIdentifierTypes(context);
        return answer(result, reply, (value) => ({ identifierTypes: value }));
      }),
    },
    {
      method: "PUT",
      path: "/api/identifier-types/:key",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const precondition = newOrMatch(request, TYPE_TAG);
        const body = objectBody(request);
        const extra = onlyKeys(body, ["identifierType", "confirm", "confirmPublished"], reply);
        if (extra) return extra;
        const type = body.identifierType;
        const key = request.params.key;
        if (typeof type !== "object" || type === null || Array.isArray(type)) {
          throw new Refusal(400, "bad_body");
        }
        const named = (type as Record<string, unknown>).key;
        if (named !== undefined && named !== key) {
          reply.status(422);
          return {
            error: "invalid",
            issues: [
              issue(
                ["identifierType", "key"],
                "wrong_key",
                "The identifier type's key is the path's.",
              ),
            ],
          };
        }
        const result = await service.saveIdentifierType(
          context,
          { ...(type as Record<string, unknown>), key },
          {
            expectedTag: precondition === "new" ? null : precondition.tag,
            ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
            ...(body.confirmPublished === undefined
              ? {}
              : { confirmPublished: body.confirmPublished }),
          },
        );
        return answer(result, reply, (value) => {
          if (precondition === "new") reply.status(201);
          reply.header("etag", `"t-${value.tag}"`);
          return value;
        });
      }),
    },
  ];
}
