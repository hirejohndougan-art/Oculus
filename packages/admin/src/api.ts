/**
 * The admin's one way to the server (D-073): a small fetch wrapper.
 *
 * - Same origin only (`credentials: "same-origin"`); the session cookie is
 *   HttpOnly and never read here.
 * - Every change carries `X-Oculus-CSRF`, the CSRF token of the current
 *   session, which the server serves only in same-origin `no-store` JSON
 *   replies (D-069). It is kept in this module's memory only, never in
 *   storage, and replaced whenever a reply carries a new one (a sign-in, a
 *   code, a switch of organization each make a new session token).
 * - `site` sends the working site in `X-Oculus-Site` (D-079).
 * - `ifMatch` sends `If-Match` for edits (D-079: `"v<version>"`), so an edit
 *   made on an old copy is refused with 412 instead of overwriting;
 *   `ifNoneMatch` sends `If-None-Match: *` for a first version.
 * - A reply `{ "error": code, ... }` becomes an `ApiError` carrying the
 *   status, the code and the rest of the body; nothing is retried here.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, body: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let csrfToken: string | undefined;

/** Sets the CSRF token (from a reply that carries one), or forgets it. */
export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = typeof token === "string" && token !== "" ? token : undefined;
}

/** The current CSRF token (tests). */
export function currentCsrfToken(): string | undefined {
  return csrfToken;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  /** The version an edit started from: sent as `If-Match: "v<n>"`. */
  readonly ifMatch?: number;
  /** A first change of something with no version yet: sent as `If-None-Match: *`. */
  readonly ifNoneMatch?: boolean;
  /** The working site (D-079's `X-Oculus-Site`), for the staff API. */
  readonly site?: string;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Picks up a CSRF token from a reply (`csrfToken`, or `session.csrfToken`). */
function rememberCsrf(body: unknown): void {
  if (!isRecord(body)) return;
  if (typeof body.csrfToken === "string") setCsrfToken(body.csrfToken);
  const session = body.session;
  if (isRecord(session) && typeof session.csrfToken === "string") {
    setCsrfToken(session.csrfToken);
  }
}

/** Sends one request to the API and returns its JSON body, or throws an `ApiError`. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("api() reaches /api/ paths only");
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken !== undefined) headers["x-oculus-csrf"] = csrfToken;
  if (options.ifMatch !== undefined) headers["if-match"] = `"v${String(options.ifMatch)}"`;
  if (options.ifNoneMatch === true) headers["if-none-match"] = "*";
  if (options.site !== undefined) headers["x-oculus-site"] = options.site;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ApiError(0, "network_error", {});
  }
  let body: unknown = null;
  const text = await response.text();
  if (text !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const record = isRecord(body) ? body : {};
    const code = typeof record.error === "string" ? record.error : "unexpected_reply";
    throw new ApiError(response.status, code, record);
  }
  rememberCsrf(body);
  return body as T;
}

/** A plain sentence for an error code the screens don't handle themselves. */
export function problemText(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  switch (error.code) {
    case "network_error":
      return "Oculus couldn't be reached. Check the connection and try again.";
    case "rate_limited":
      return "Too many tries from here in a short time. Wait a minute and try again.";
    case "throttled": {
      const seconds = Number(error.body.retryAfterSeconds);
      return Number.isFinite(seconds) && seconds > 0
        ? `Too many tries. Wait ${waitText(seconds)} and try again.`
        : "Too many tries. Wait a little and try again.";
    }
    case "unavailable":
    case "retry":
    case "timeout":
    case "busy":
      return "Oculus is busy just now. Try again in a moment.";
    case "unauthenticated":
      return "Your sign-in has ended. Sign in again.";
    case "reauthentication_required":
      return "For safety, this needs a fresh sign-in. Sign out, sign in again, then try again straight away.";
    case "csrf_failed":
    case "cross_origin":
      return "This page is out of date. Reload it and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

/** "about 2 minutes", "15 seconds". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${String(Math.ceil(seconds))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about a minute" : `about ${String(minutes)} minutes`;
}

export interface UploadOptions {
  /** The record's version the upload starts from: `If-Match: "v<n>"`. */
  readonly ifMatch: number;
  /** The working site (`X-Oculus-Site`). */
  readonly site: string;
  /** Called as bytes go out. */
  readonly onProgress?: (sent: number, total: number) => void;
  /** Aborting cancels the upload (`ApiError` with code `cancelled`). */
  readonly signal?: AbortSignal;
}

const SIMPLE_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Uploads one file's bytes (M-002, D-086) to an upload route, with
 * progress: `XMLHttpRequest`, since `fetch` reports no upload progress.
 * The body is the file as it is, `application/octet-stream`; its name goes
 * percent-encoded in `X-Oculus-File-Name` and the browser's guess at its
 * type in `X-Oculus-File-Type` (a hint only: the server sniffs the bytes).
 * Same origin, the CSRF header and `If-Match`, as `api()`.
 */
export function uploadFile<T>(path: string, file: File, options: UploadOptions): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("uploadFile() reaches /api/ paths only");
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (csrfToken !== undefined) xhr.setRequestHeader("x-oculus-csrf", csrfToken);
    xhr.setRequestHeader("if-match", `"v${String(options.ifMatch)}"`);
    xhr.setRequestHeader("x-oculus-site", options.site);
    xhr.setRequestHeader("x-oculus-file-name", encodeURIComponent(file.name));
    const type = file.type.toLowerCase();
    if (SIMPLE_TYPE.test(type)) xhr.setRequestHeader("x-oculus-file-type", type);
    xhr.upload.onprogress = (event) => {
      options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    const abort = () => {
      xhr.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const done = () => {
      options.signal?.removeEventListener("abort", abort);
    };
    xhr.onabort = () => {
      done();
      reject(new ApiError(0, "cancelled", {}));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, "network_error", {}));
    };
    xhr.onload = () => {
      done();
      let body: unknown;
      try {
        body = xhr.responseText === "" ? null : (JSON.parse(xhr.responseText) as unknown);
      } catch {
        body = null;
      }
      if (xhr.status < 200 || xhr.status > 299) {
        const record = isRecord(body) ? body : {};
        const code = typeof record.error === "string" ? record.error : "unexpected_reply";
        reject(new ApiError(xhr.status, code, record));
        return;
      }
      resolve(body as T);
    };
    if (options.signal?.aborted === true) {
      reject(new ApiError(0, "cancelled", {}));
      return;
    }
    xhr.send(file);
  });
}
