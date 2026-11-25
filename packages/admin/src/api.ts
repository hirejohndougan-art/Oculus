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
 * - `background` marks a read the person didn't ask for (polling, checking
 *   the session is still alive) with `X-Oculus-Background: 1`, so it isn't a
 *   use of the session and never holds off the idle limit (T-062, D-098).
 *   Every other request whose reply shows the server counted it (`countedUse`:
 *   a success, or a refusal made after the session was looked up) is a use:
 *   its send time goes to `onSessionUse` listeners (the idle timer), which
 *   is never later than the moment the server counted it.
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
  /** A read that isn't a use of the session (GET only; T-062, D-098). */
  readonly background?: boolean;
  /**
   * The CSRF token to send instead of the current one: signing out after
   * the screen has already forgotten the session (T-062).
   */
  readonly csrfToken?: string;
}

/**
 * Whether a reply shows that the server looked the session up with a use
 * (T-062, D-098): every success, and every refusal but those made before
 * the session was read or meaning there is none (401; a CSRF or Origin
 * refusal; a malformed request, `400 bad_request`; a rate limit, which the
 * sign-in routes apply before the session; a server failure). Erring
 * towards "not counted" only makes this tab's timer end sooner than the
 * server's, never later.
 */
export function countedUse(status: number, code: string | undefined): boolean {
  if (status >= 200 && status < 300) return true;
  if (status < 400 || status >= 500) return false;
  if (status === 401 || status === 429) return false;
  if (status === 403 && (code === "csrf_failed" || code === "cross_origin")) return false;
  if (status === 400 && code === "bad_request") return false;
  return true;
}

type UseListener = (sentAt: number) => void;
const useListeners = new Set<UseListener>();

/**
 * Calls `listener` with the send time (`Date.now()`) of every request that
 * counted as a use of the session. Returns the way to stop.
 */
export function onSessionUse(listener: UseListener): () => void {
  useListeners.add(listener);
  return () => {
    useListeners.delete(listener);
  };
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
  const csrf = options.csrfToken ?? csrfToken;
  if (method !== "GET" && csrf !== undefined) headers["x-oculus-csrf"] = csrf;
  if (options.ifMatch !== undefined) headers["if-match"] = `"v${String(options.ifMatch)}"`;
  if (options.ifNoneMatch === true) headers["if-none-match"] = "*";
  if (options.site !== undefined) headers["x-oculus-site"] = options.site;
  const background = options.background === true;
  if (background) {
    if (method !== "GET") throw new Error("only a read can be background");
    headers["x-oculus-background"] = "1";
  }
  const sentAt = Date.now();
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
  const record = isRecord(body) ? body : {};
  const code = typeof record.error === "string" ? record.error : undefined;
  if (!background && countedUse(response.status, code)) {
    for (const listener of [...useListeners]) listener(sentAt);
  }
  if (!response.ok) throw new ApiError(response.status, code ?? "unexpected_reply", record);
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
