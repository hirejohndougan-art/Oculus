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
 * Files (M-002, D-086): `POST /api/records/:id/files` streams one file's
 * bytes to the file store (an upload route: its own type list, the cap
 * counted as it streams), after the session, CSRF, `If-Match` and the
 * asset's edit permission are checked and before a byte is read; `GET
 * /api/records/:id/files` lists an asset's files.
 * Reading files (M-003, D-097), for anyone who may view the asset, only
 * through `fileReply` (D-089): `GET /api/records/:id/files/:fileId/content`
 * downloads any file, always as `application/octet-stream` and an
 * attachment; `.../view` shows a JPEG, PNG, GIF or WebP inline (by its
 * sniffed type, never its name or claimed type; `422 not_viewable`
 * otherwise); `.../thumbnail?size=small|medium` a JPEG thumbnail made by
 * the service (`422 no_thumbnail` when none can be made). A file the asset
 * doesn't have is the same `404 not_found` as a missing record. No byte
 * ranges (fileReply sends whole files).
 * Virus scanning (S-040, D-113): each listed file carries its content's
 * `scan` (`pending`, `clean`, `infected`, `failed`, `not_scanned`). With a
 * scanner set up only clean files are read: `409 scan_pending` and `409
 * scan_failed` otherwise, files stored before scanning was turned on are
 * read until their first scan (`not_yet_scanned`); an infected file is `423
 * quarantined`, scanner or not. While scanning is on an upload larger than
 * the scanner takes is `413 too_large_to_scan`. System managers read `GET /api/system/file-scans` (on or off, and
 * the organization's counts) and queue every clean and failed file again
 * with `POST /api/system/file-scans/rescan` (recent sign-in; `409
 * scanning_off` without a scanner).
 * System settings (T-048a, D-087): `POST /api/sites` and `PUT
 * /api/sites/:id` make and rename a site (in the session's organization, or
 * the `organizationId` given), and `GET`/`PUT /api/system-settings` read and
 * change the sign-in rules (`If-None-Match: *` for the first change, else
 * `If-Match: "v<N>"`). The service lets only system managers do any of it;
 * the changes also need a recent sign-in (`403 reauthentication_required`).
 * `GET`/`PUT /api/organization/time-zone` read the organization's time
 * zone and local day, and set it (system managers, recent sign-in; T-034e).
 * An unknown site is `404 not_found`.
 *
 * Dublin Core mappings (T-050b, D-096): `GET`/`PUT
 * /api/templates/:key/dublin-core`, a template's stored mapping
 * (`If-None-Match: *` for the first, `If-Match: "v<N>"` after; a change
 * shown at once on published records answers `409 confirmation_required`
 * until `confirmPublished`).
 *
 * Accessions and donor contacts (T-073): `accessions-api.ts`.
 *
 * Not here: signing in, the second step, password reset and signing out
 * (T-045 adds those routes beside these, with `credentials: true` for the
 * 8 KiB limit, and writes the cookie through the reply's cookie writer).
 */
import { createHash } from "node:crypto";
import {
  checkCsrfToken,
  cleanFileName,
  csrfTokenFor,
  isClaimedMediaType,
  isSiteId,
  issue,
  type Issue,
  type RecordId,
} from "@oculus/core";
import { resolveSession, type FullSession, type Queryable } from "@oculus/db";
import {
  contextFromSession,
  type FileStore,
  type RecordService,
  type ServiceContext,
  type ServiceRefusal,
  type WorkflowOptions,
} from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import { Transform, pipeline, type Readable } from "node:stream";
import { fileReply } from "./file-replies.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import { peopleApiRoutes, type PeopleApiOptions } from "./people-api.js";
import { updateApiRoutes, type UpdateApiOptions } from "./update-api.js";
import { filesPurgeApiRoutes } from "./files-purge-api.js";
import { accessionsApiRoutes } from "./accessions-api.js";
import type { PublicSubjects } from "./public-subjects.js";
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
    | "startup_warning"
    // The mail outbox and senders (mail-outbox.ts, mail.ts, D-085): the
    // message kind as `operation`, an error class or reason as `code`.
    | "mail_sent"
    | "mail_retry"
    | "mail_failed"
    | "mail_refused"
    | "mail_dropped"
    | "mail_dev"
    // The two-step alert notices (alert-notices.ts): people notified, as `code`.
    | "alert_notices"
    // Software updates (T-060): the step in `operation`, a version in `code`.
    | "update_event";
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
  /**
   * The file store (M-002, D-086), the same one the service was made with
   * (`createService(db, { files })`). Without one, uploads answer `503
   * files_unavailable`.
   */
  readonly files?: FileStore;
  /** Limits on streamed files (defaults: 4 a session, 8 a person, 64 KiB every 10 s); tests change them. */
  readonly downloads?: {
    readonly perSession?: number;
    readonly perUser?: number;
    readonly minBytes?: number;
    readonly windowMs?: number;
  };
  /** People, roles and the audit trail (T-048, people-api.ts); left out, those routes aren't served. */
  readonly people?: PeopleApiOptions;
  /** Software updates (T-060, update-api.ts); left out, those routes aren't served. */
  readonly updates?: UpdateApiOptions;
  /** The cached public Subjects counts (S-038, public-subjects.ts), for their staff view. */
  readonly publicSubjects?: Pick<PublicSubjects, "statusFor">;
}

/** Files streamed at once per session (M-003). */
export const MAX_DOWNLOADS_PER_SESSION = 4;
/** Files streamed at once per person, across all their sessions (M-003). */
export const MAX_DOWNLOADS_PER_USER = 8;
/** A streamed file must send at least this many bytes in every window… */
export const MIN_DOWNLOAD_BYTES = 64 * 1024;
/** …of this many milliseconds, or it is cut off. */
export const MIN_DOWNLOAD_WINDOW_MS = 10_000;

/** The headers carrying an upload's original name (percent-encoded UTF-8) and claimed type. */
export const FILE_NAME_HEADER = "x-oculus-file-name";
export const FILE_TYPE_HEADER = "x-oculus-file-type";

/** An upload's name when the client gives none. */
const UNNAMED_FILE = "untitled";

/** The header carrying the CSRF token on every change. */
export const CSRF_HEADER = "x-oculus-csrf";
/** The header naming the working site. */
export const SITE_HEADER = "x-oculus-site";
/**
 * The header that marks a read as background (T-062, D-098): `1` on a GET
 * the admin sends without the person doing anything (polling, a check of
 * whether the session is still alive). Such a read is served as usual but
 * isn't a use of the session, so it never holds off the idle limit. Only
 * `1` is accepted; on a change it is refused, because a change is always a
 * use. Sending it can only make a session end sooner, so it needs no proof.
 */
export const BACKGROUND_HEADER = "x-oculus-background";

/**
 * Whether the request counts as a use of the session (T-062, D-098):
 * `false` for a GET marked with `X-Oculus-Background: 1`, and `false` for
 * one the browser says came from another site (`Sec-Fetch-Site` other than
 * `same-origin` or `none`), so a cross-site top-level navigation that
 * carries the `SameSite=Lax` cookie can't keep a session going. Without
 * `Sec-Fetch-Site` (older browsers, other clients) a request counts. The
 * header with any value but `1`, or on a change, is `400 bad_request`.
 */
export function isActivity(request: OculusRequest): boolean {
  const value = request.headers[BACKGROUND_HEADER];
  const read = request.method === "GET" || request.method === "HEAD";
  if (value !== undefined && (value !== "1" || !read)) {
    throw new Refusal(400, "bad_request");
  }
  if (value !== undefined) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * A short, non-secret name for a session that the admin's tabs put on their
 * messages to each other (T-062, D-098), so a tab ignores another session's
 * news: the first 16 base64url characters of a SHA-256 of the session's ID
 * with a fixed label. The ID is random (UUIDv4) and is not the token, so
 * this gives nothing that signs in; it changes with every new session
 * (sign-in, switching organization).
 */
export function sessionMarker(sessionId: string): string {
  return createHash("sha256")
    .update(`oculus-idle-marker:${sessionId}`)
    .digest("base64url")
    .slice(0, 16);
}

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
export function objectBody(request: OculusRequest): Readonly<Record<string, unknown>> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Refusal(400, "bad_body");
  }
  return body as Readonly<Record<string, unknown>>;
}

/** The body's keys must be among `allowed`; else `422 invalid` naming the first other. */
export function onlyKeys(
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

export const VERSION_TAG = /^"v([1-9][0-9]{0,9})"$/;
const TYPE_TAG = /^"t-([A-Za-z0-9_-]{32})"$/;

/** The service takes versions below 2^31 - 1; a bigger tag is malformed here, not refused there (S-032). */
const inVersionRange = (text: string): boolean => {
  const n = Number(text);
  return Number.isSafeInteger(n) && n < 2 ** 31 - 1;
};

/** `If-Match: "v<N>"`: the version an edit started from (428 without, 400 malformed). */
export function ifMatchVersion(request: OculusRequest): number {
  const value = request.headers["if-match"];
  if (value === undefined) throw new Refusal(428, "precondition_required");
  const match = VERSION_TAG.exec(value);
  if (match?.[1] === undefined || !inVersionRange(match[1])) {
    throw new Refusal(400, "bad_if_match");
  }
  return Number(match[1]);
}

/**
 * For a definition saved by PUT: `If-None-Match: *` for a new one, or
 * `If-Match` with its tag; exactly one of them (428 without, 400 both or
 * malformed).
 */
export function newOrMatch(request: OculusRequest, pattern: RegExp): { readonly tag: string } | "new" {
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
  if (pattern === VERSION_TAG && !inVersionRange(found[1])) {
    throw new Refusal(400, "bad_if_match");
  }
  return { tag: found[1] };
}

/** One text query parameter (400 when sent twice). */
export function queryText(request: OculusRequest, name: string): string | undefined {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Refusal(400, "bad_query");
  return value;
}

/**
 * A share list's page (S-036a): `?before=<share ID>` and, for a site's
 * list, `?state=offered|accepted`. Left for the service to check; only a
 * repeated parameter is refused here (400).
 */
export function sharePage(
  request: OculusRequest,
  withState = false,
): { before?: string; state?: string } {
  const before = queryText(request, "before");
  const state = withState ? queryText(request, "state") : undefined;
  return {
    ...(before === undefined ? {} : { before }),
    ...(state === undefined ? {} : { state }),
  };
}

/** A whole number query parameter (400 otherwise). */
export function queryNumber(request: OculusRequest, name: string, max: number): number | undefined {
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

/**
 * An upload's original name from `X-Oculus-File-Name` (percent-encoded
 * UTF-8, as `encodeURIComponent` writes it), cleaned by core's
 * `cleanFileName`: metadata only, never part of a path. `400 bad_file_name`
 * when it can't be decoded or kept.
 */
function uploadName(request: OculusRequest): string {
  const raw = request.headers[FILE_NAME_HEADER];
  if (raw === undefined) return UNNAMED_FILE;
  let decoded: string;
  try {
    if (raw.length > 2048) throw new Error("too long");
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Refusal(400, "bad_file_name");
  }
  const name = cleanFileName(decoded);
  if (name === undefined) throw new Refusal(400, "bad_file_name");
  return name;
}

/**
 * The type the client claims for an upload: `X-Oculus-File-Type`, else the
 * request's own type unless it is `application/octet-stream`. A hint, kept
 * beside the type sniffed from the bytes; `400 bad_file_type` when malformed.
 */
function claimedType(request: OculusRequest, contentType: string): string | undefined {
  const raw = request.headers[FILE_TYPE_HEADER];
  if (raw === undefined) {
    return contentType === "application/octet-stream" ? undefined : contentType;
  }
  const type = raw.trim().toLowerCase();
  if (type === "") return undefined;
  if (!isClaimedMediaType(type)) throw new Refusal(400, "bad_file_type");
  return type;
}

/** The file codes of the service, as HTTP refusals; `undefined` for anything else. */
function fileRefusal(result: ServiceRefusal): Refusal | undefined {
  const codes = new Set(result.issues.map((i) => i.code));
  // A file the asset doesn't have: the same reply as a missing record.
  if (codes.has("unknown_file")) return new Refusal(404, "not_found");
  if (codes.has("not_viewable")) return new Refusal(422, "not_viewable");
  // Virus scanning (S-040, D-113): only clean files are read while a
  // scanner is set up; an infected one is never read.
  if (codes.has("quarantined")) return new Refusal(423, "quarantined");
  if (codes.has("scan_pending")) return new Refusal(409, "scan_pending");
  if (codes.has("scan_failed")) return new Refusal(409, "scan_failed");
  if (codes.has("scanning_off")) return new Refusal(409, "scanning_off");
  // Larger than the scanner takes: it could never be scanned, so never kept.
  if (codes.has("too_large_to_scan")) return new Refusal(413, "too_large_to_scan");
  if (codes.has("no_thumbnail")) return new Refusal(422, "no_thumbnail");
  if (codes.has("busy")) return new Refusal(503, "busy");
  if (codes.has("not_cached")) return new Refusal(405, "method_not_allowed");
  if (codes.has("files_unavailable")) return new Refusal(503, "files_unavailable");
  if (codes.has("file_too_large")) return new Refusal(413, "payload_too_large");
  if (codes.has("quota_exceeded")) return new Refusal(413, "quota_exceeded");
  if (codes.has("disk_full")) return new Refusal(507, "disk_full");
  return undefined;
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
export function refused(
  result: ServiceRefusal,
  reply: OculusReply,
  log: (r: ApiLogRecord) => void,
) {
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
        (i.code === "unknown_template" && onPath(i, "key")) ||
        (i.code === "unknown_share" && onPath(i, "shareId")) ||
        (i.code === "unknown_site" && onPath(i, "siteId")) ||
        // A share offered to a site that doesn't exist (or to its own home
        // site): the same 404 as any other unknown site (S-050).
        (i.code === "unknown_site" && onPath(i, "targetSiteId")),
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
  if (
    codes.has("needs_confirmation") ||
    codes.has("publishes_records") ||
    codes.has("drops_published_records")
  ) {
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

export type Handler = (
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
      const activity = isActivity(request);
      const resolved = await resolveSession(db, token, {
        activity,
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

  /** Download or view one file (M-003): the service checks, fileReply sends. */
  // Streamed files per session (M-003, review item 5; S-035's core): at
  // most `perSession` at once, and each must keep sending at least
  // `minBytes` every `windowMs` or it is cut off, so a slow reader can't
  // hold files open (and the server's sockets) for the 2-hour deadline.
  const downloadLimits = {
    perSession: options.downloads?.perSession ?? MAX_DOWNLOADS_PER_SESSION,
    perUser: options.downloads?.perUser ?? MAX_DOWNLOADS_PER_USER,
    minBytes: options.downloads?.minBytes ?? MIN_DOWNLOAD_BYTES,
    windowMs: options.downloads?.windowMs ?? MIN_DOWNLOAD_WINDOW_MS,
  };
  const streaming = new Map<string, number>();

  /**
   * The opener, counted against the session and the person while its
   * stream is open, and kept to the minimum rate.
   */
  function counted(keys: readonly string[], open: () => Readable): () => Readable {
    return () => {
      const source = open();
      for (const key of keys) streaming.set(key, (streaming.get(key) ?? 0) + 1);
      let sent = 0;
      let checked = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          sent += chunk.byteLength;
          done(null, chunk);
        },
      });
      const timer = setInterval(() => {
        if (sent - checked < downloadLimits.minBytes) {
          counter.destroy(new Error("the download is too slow"));
        }
        checked = sent;
      }, downloadLimits.windowMs);
      timer.unref();
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearInterval(timer);
        for (const key of keys) {
          const left = (streaming.get(key) ?? 1) - 1;
          if (left <= 0) streaming.delete(key);
          else streaming.set(key, left);
        }
      };
      // A storage error reaches the counter (the reply's 500 or cut-off);
      // the counter destroyed (client gone, too slow) closes the source.
      pipeline(source, counter, () => undefined);
      counter.once("close", release);
      return counter;
    };
  }

  /** Download or view one file (M-003): the service checks, fileReply sends. */
  async function readFileRoute(
    request: OculusRequest,
    reply: OculusReply,
    session: FullSession,
    context: ServiceContext,
    use: "download" | "view",
  ): Promise<unknown> {
    const keys = [`session:${session.sessionId}`, `user:${session.userId}`];
    if (
      (streaming.get(keys[0] ?? "") ?? 0) >= downloadLimits.perSession ||
      (streaming.get(keys[1] ?? "") ?? 0) >= downloadLimits.perUser
    ) {
      throw new Refusal(429, "too_many_downloads");
    }
    const result = await service.fileContent(
      context,
      recordId(request),
      request.params.fileId ?? "",
      use,
    );
    if (!result.ok) {
      const fixed = fileRefusal(result);
      if (fixed !== undefined) throw fixed;
      return refused(result, reply, log);
    }
    const { file, open } = result.value;
    return fileReply({
      body: counted(keys, open),
      size: file.size,
      // The sniffed type (D-086); fileReply sends a download as
      // application/octet-stream whatever it is.
      mediaType: file.mediaType,
      fileName: file.name,
      disposition: use === "view" ? "inline" : "attachment",
    });
  }

  const files = options.files;
  // The route's own streaming cap is the store's per-file cap (D-086).
  const uploadLimit = files?.maxFileBytes ?? 1;

  return [
    {
      // Attach a file to a digital asset (M-002, D-086): the body is the
      // file's bytes, streamed to disk, never buffered. Everything about the
      // person and the asset is checked before a byte is read.
      method: "POST",
      path: "/api/records/:id/files",
      upload: { maxBytes: uploadLimit },
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        const upload = request.upload;
        if (upload === undefined) throw new Refusal(400, "bad_body");
        const name = uploadName(request);
        const claimed = claimedType(request, upload.contentType);
        if (files === undefined) throw new Refusal(503, "files_unavailable");
        const id = recordId(request);
        const declared = upload.declaredBytes;
        if (declared === 0) throw new Refusal(400, "empty_file");
        const check = await service.mayAttachFile(context, id, {
          expectedVersion,
          ...(declared === undefined ? {} : { declaredBytes: declared }),
        });
        if (!check.ok) {
          const fixed = fileRefusal(check);
          if (fixed !== undefined) throw fixed;
          return refused(check, reply, log);
        }
        // The smaller cap while scanning is on: the scanner's (S-040).
        const cap = check.value.maxFileBytes;
        const received = await files.receive(context.organizationId, upload.chunks(), {
          signal: request.signal,
          usedBytes: check.value.usedBytes,
          maxBytes: cap,
        });
        if (!received.ok) {
          switch (received.code) {
            case "empty_file":
              throw new Refusal(400, "empty_file");
            case "quota_exceeded":
              throw new Refusal(413, "quota_exceeded");
            case "disk_full":
              throw new Refusal(507, "disk_full");
            default:
              // Past the scanner's limit (below the store's own): said so.
              throw cap < files.maxFileBytes
                ? new Refusal(413, "too_large_to_scan")
                : new Refusal(413, "payload_too_large");
          }
        }
        const result = await service.attachFile(context, id, received.file, {
          expectedVersion,
          name,
          ...(claimed === undefined ? {} : { claimedType: claimed }),
        });
        if (!result.ok) {
          const fixed = fileRefusal(result);
          if (fixed !== undefined) throw fixed;
          return refused(result, reply, log);
        }
        reply.status(result.value.created ? 201 : 200);
        return { file: result.value.file, created: result.value.created };
      }),
    },
    {
      // Remove one file from an asset (M-002, D-086): the attach rule,
      // If-Match on the asset. Its copy goes at the next sweep once no row
      // names its content.
      method: "DELETE",
      path: "/api/records/:id/files/:fileId",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        if (request.body !== undefined) throw new Refusal(400, "bad_body");
        const result = await service.removeFile(
          context,
          recordId(request),
          request.params.fileId ?? "",
          { expectedVersion },
        );
        if (!result.ok && result.issues.some((i) => i.code === "unknown_file")) {
          // A file the asset doesn't have: the same reply as a missing record.
          throw new Refusal(404, "not_found");
        }
        return answer(result, reply, (value) => value);
      }),
    },
    {
      // Download one file (M-003, D-097): whatever it is, an attachment
      // sent as application/octet-stream (fileReply), named by RFC 6266.
      method: "GET",
      path: "/api/records/:id/files/:fileId/content",
      handler: signedIn("read", false, (request, reply, { session, context }) =>
        readFileRoute(request, reply, session, context, "download"),
      ),
    },
    {
      // Show one file inline (M-003): a JPEG, PNG, GIF or WebP by its
      // sniffed type only, with fileReply's sandboxing CSP and nosniff.
      method: "GET",
      path: "/api/records/:id/files/:fileId/view",
      handler: signedIn("read", false, (request, reply, { session, context }) =>
        readFileRoute(request, reply, session, context, "view"),
      ),
    },
    {
      // A thumbnail of one image (M-003): a JPEG made by the service.
      method: "GET",
      path: "/api/records/:id/files/:fileId/thumbnail",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const size = queryText(request, "size") ?? "small";
        if (size !== "small" && size !== "medium") throw new Refusal(400, "bad_query");
        // HEAD never makes a thumbnail: the cache's, or 405.
        const result = await service.fileThumbnail(
          context,
          recordId(request),
          request.params.fileId ?? "",
          size,
          { cacheOnly: request.method === "HEAD" },
        );
        if (!result.ok) {
          const fixed = fileRefusal(result);
          if (fixed !== undefined) throw fixed;
          return refused(result, reply, log);
        }
        const jpeg = result.value.jpeg;
        return fileReply({
          body: jpeg,
          size: jpeg.byteLength,
          mediaType: "image/jpeg",
          fileName: "thumbnail.jpg",
          disposition: "inline",
        });
      }),
    },
    {
      // The asset's files: name, size, sniffed type, who and when. Never
      // the bytes (the routes above send those).
      method: "GET",
      path: "/api/records/:id/files",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.listFiles(context, recordId(request));
        return answer(result, reply, (value) => ({
          files: value,
          // So the admin can refuse a file that's too large before sending it.
          // While scanning is on, no more than the scanner takes (S-040).
          maxFileBytes: service.fileUploadLimit() ?? null,
        }));
      }),
    },
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
          // The limit the admin's idle timer follows (T-062, D-098). The
          // timer asks here with a use when the person is active, and with
          // X-Oculus-Background: 1 to see whether the session still lives.
          idleSeconds: session.idleSeconds,
          idleSecondsLeft: session.idleSecondsLeft,
          sessionMarker: sessionMarker(session.sessionId),
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
    ...(options.people === undefined
      ? []
      : peopleApiRoutes(options.people, { service, log, signedIn })),
    ...(options.updates === undefined
      ? []
      : updateApiRoutes(options.updates, { service, log, signedIn })),
    // Clean up removed files (S-052): only where files are stored.
    ...(files === undefined ? [] : filesPurgeApiRoutes({ service, log, signedIn })),
    // Accessions and donor contacts (T-073).
    ...accessionsApiRoutes({ service, log, signedIn }),
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
    // A template's Dublin Core mapping (T-050b, D-096, D-012): read by anyone
    // who may read templates; saved by those who may change definitions,
    // with D-076's published-records confirmation.
    {
      method: "GET",
      path: "/api/templates/:key/dublin-core",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readDublinCoreMapping(context, request.params.key ?? "");
        return answer(result, reply, (value) => {
          if (value.version > 0) reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/templates/:key/dublin-core",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const precondition = newOrMatch(request, VERSION_TAG);
        const body = objectBody(request);
        const extra = onlyKeys(
          body,
          ["mapping", "confirmPublished", "confirmPublishedCount"],
          reply,
        );
        if (extra) return extra;
        const result = await service.saveDublinCoreMapping(
          context,
          request.params.key ?? "",
          body.mapping,
          {
            expectedVersion: precondition === "new" ? 0 : Number(precondition.tag),
            ...(body.confirmPublished === undefined
              ? {}
              : { confirmPublished: body.confirmPublished }),
            // Past the list's limit, the count confirms instead (S-039).
            ...(body.confirmPublishedCount === undefined
              ? {}
              : { confirmPublishedCount: body.confirmPublishedCount }),
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
        const extra = onlyKeys(
          body,
          ["identifierType", "confirm", "confirmPublished", "confirmDropped"],
          reply,
        );
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
            ...(body.confirmDropped === undefined ? {} : { confirmDropped: body.confirmDropped }),
          },
        );
        return answer(result, reply, (value) => {
          if (precondition === "new") reply.status(201);
          reply.header("etag", `"t-${value.tag}"`);
          return value;
        });
      }),
    },
    // System settings (T-048a, D-087): sites and the sign-in rules, for
    // system managers only (the service refuses everyone else). Making or
    // renaming a site and changing the rules also need a recent sign-in
    // (the T-041 review, D-072), checked here from the session.
    {
      method: "POST",
      path: "/api/sites",
      handler: signedIn("write", true, async (request, reply, { session, context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["organizationId", "name"], reply);
        if (extra) return extra;
        recentSignIn(session);
        const result = await service.createSite(context, body);
        return answer(result, reply, (site) => {
          reply.status(201);
          return { site };
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/sites/:id",
      handler: signedIn("write", true, async (request, reply, { session, context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["organizationId", "name"], reply);
        if (extra) return extra;
        recentSignIn(session);
        const result = await service.renameSite(context, {
          ...body,
          siteId: request.params.id ?? "",
        });
        return answer(result, reply, (site) => ({ site }));
      }),
    },
    // The public Subjects counts' staff view (S-038, D-106): when they were
    // made and how many public records were left out and why. For system
    // managers and the site's managers; any other site is not found.
    {
      method: "GET",
      path: "/api/sites/:id/public-subjects",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const siteId = request.params.id ?? "";
        const access = await service.myAccess(context);
        if (!access.ok) return answer(access, reply, () => ({}));
        const manages =
          access.value.systemManager ||
          access.value.grants.some(
            (g) =>
              g.role === "site_manager" &&
              g.scope === null &&
              (g.siteId === null || g.siteId === siteId),
          );
        if (!manages) throw new Refusal(403, "not_permitted");
        const status = options.publicSubjects?.statusFor(context.organizationId, siteId);
        if (status === undefined) throw new Refusal(404, "not_found");
        return status;
      }),
    },
    // Virus scanning (S-040, D-113): whether a scanner is set up and the
    // organization's files by scan state; and scanning them all again (after
    // the scanner's signatures were updated), which needs a recent sign-in.
    // System managers only (the service refuses everyone else).
    {
      method: "GET",
      path: "/api/system/file-scans",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.fileScanStatus(context);
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "POST",
      path: "/api/system/file-scans/rescan",
      handler: signedIn("write", true, async (request, reply, { session, context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, [], reply);
        if (extra) return extra;
        recentSignIn(session);
        const result = await service.rescanFiles(context);
        if (!result.ok) {
          const fixed = fileRefusal(result);
          if (fixed !== undefined) throw fixed;
        }
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "GET",
      path: "/api/system-settings",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.readSystemSettings(context);
        return answer(result, reply, (value) => {
          if (value.version > 0) reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/system-settings",
      handler: signedIn("write", true, async (request, reply, { session, context }) => {
        const precondition = newOrMatch(request, VERSION_TAG);
        const body = objectBody(request);
        const extra = onlyKeys(body, ["settings"], reply);
        if (extra) return extra;
        recentSignIn(session);
        const result = await service.changeSystemSettings(context, body.settings, {
          expectedVersion: precondition === "new" ? 0 : Number(precondition.tag),
        });
        return answer(result, reply, (value) => {
          reply.header("etag", `"v${String(value.version)}"`);
          return value;
        });
      }),
    },

    // Sharing items between sites (T-041d, D-094): the service decides every
    // permission and answers another organization's share, one out of
    // reach, and a missing one alike (`unknown_share`: 404 here).
    {
      method: "GET",
      path: "/api/records/:id/shares",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.sharesOfRecord(context, recordId(request), sharePage(request));
        return answer(result, reply, (page) => ({ shares: page.shares, next: page.next }));
      }),
    },
    {
      method: "POST",
      path: "/api/records/:id/shares",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["targetOrganizationId", "targetSiteId"], reply);
        if (extra) return extra;
        const result = await service.offerRecord(context, {
          recordId: recordId(request),
          targetOrganizationId: body.targetOrganizationId,
          targetSiteId: body.targetSiteId,
        });
        return answer(result, reply, (share) => {
          reply.status(201);
          return { share };
        });
      }),
    },
    {
      method: "GET",
      path: "/api/shares/:id",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readSharedItem(context, request.params.id ?? "");
        return answer(result, reply, (share) => ({ share }));
      }),
    },
    shareMove("/api/shares/:id/accept", "acceptShare"),
    shareMove("/api/shares/:id/decline", "declineShare"),
    shareMove("/api/shares/:id/remove", "removeShare"),
    shareMove("/api/shares/:id/withdraw", "withdrawShare"),
    {
      method: "GET",
      path: "/api/sites/:id/share-offers",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.sharesIntoSite(
          context,
          request.params.id ?? "",
          sharePage(request, true),
        );
        return answer(result, reply, (page) => ({ shares: page.shares, next: page.next }));
      }),
    },
    {
      method: "GET",
      path: "/api/sites/:id/shared-items",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.listSharedItems(
          context,
          request.params.id ?? "",
          sharePage(request),
        );
        return answer(result, reply, (page) => ({ shares: page.shares, next: page.next }));
      }),
    },
    {
      // T-034e (D-103): the organization's time zone and its local day.
      method: "GET",
      path: "/api/organization/time-zone",
      handler: signedIn("read", false, async (_request, reply, { context }) => {
        const result = await service.readOrganizationTimeZone(context);
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "PUT",
      path: "/api/organization/time-zone",
      handler: signedIn("write", true, async (request, reply, { session, context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["timeZone"], reply);
        if (extra) return extra;
        recentSignIn(session);
        const result = await service.changeOrganizationTimeZone(context, body.timeZone);
        return answer(result, reply, (value) => value);
      }),
    },
  ];

  /** One of a share's moves (D-094): no body. */
  function shareMove(
    path: string,
    move: "acceptShare" | "declineShare" | "removeShare" | "withdrawShare",
  ): OculusRoute {
    return {
      method: "POST",
      path,
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const read = optionalBody(request, [], reply);
        if ("error" in read) return read;
        const result = await service[move](context, request.params.id ?? "");
        return answer(result, reply, (share) => ({ share }));
      }),
    };
  }
}

/**
 * A change only a recently signed-in session may make (D-072, D-087): `403
 * reauthentication_required` otherwise, as T-037's `endUserSessions` answers.
 */
function recentSignIn(session: FullSession): void {
  // Anyone else is the service's to refuse (`not_permitted`), so a person
  // who may not make the change is never told to sign in again for it.
  if (session.systemAdmin && !session.recentlyAuthenticated) {
    throw new Refusal(403, "reauthentication_required");
  }
}
