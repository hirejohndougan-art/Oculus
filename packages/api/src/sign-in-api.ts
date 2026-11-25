/**
 * Signing in, the code after the password, setting up two-step sign-in,
 * choosing an organization, signing out and password reset over HTTP
 * (T-045, D-081), beside the staff API (D-079) on the admin's own hostname
 * (D-034). Each route is a thin wrapper over `@oculus/db`'s functions
 * (D-068, D-069, D-077, D-078), which decide every answer; this module adds
 * the HTTP rules and nothing else.
 *
 * Every request, before the database is asked anything:
 * 1. the server's own rules (server.ts, D-051, D-058): path, body size
 *    (8 KiB on every post here: `credentials: true`) and type
 *    (`application/json` only), cookies, and for every post an `Origin`
 *    listed in `OCULUS_ORIGINS` naming this host (or `Sec-Fetch-Site:
 *    same-origin`), which is the sign-in form's protection against login
 *    CSRF;
 * 2. the client address must be readable (`client_address_unknown`, 503,
 *    logged loudly, otherwise): every throttle counts per address (D-068);
 * 3. a cheap per-address limit (`credentials`, 60 a minute) on posts made
 *    without a full session, and the D-079 per-session limit on the others;
 * 4. where a session exists, its cookie (`__Host-oculus_session`) and on
 *    every post `X-Oculus-CSRF`, the CSRF token of that very session
 *    (`csrfTokenFor`, D-069), checked in constant time before the database
 *    is asked (`403 csrf_failed`). The token is served only in same-origin
 *    `no-store` JSON replies (the sign-in reply, `GET /api/sign-in/pending`,
 *    `GET /api/me`), never in a cookie.
 *
 * Replies are JSON with fixed codes. Wherever the database gives one reply
 * for several cases (a wrong password and an unknown address; every reason
 * a reset link can't be used; every reset request let through), so does
 * this: the reply is built from the code alone, never from anything about
 * the account. The session token goes only into the cookie, written by the
 * reply's cookie writer (D-058, D-069): `HttpOnly; Secure; SameSite=Lax;
 * Path=/`, no `Max-Age`. Every sign-in, code, set-up and switch writes the
 * new token; sign-out clears it. Reset and set-up tokens, codes, secrets and
 * addresses never reach a log (D-068's secrecy rule): logs get fixed-shape
 * records through `redactedError` (class name and SQLSTATE only, never
 * `where`, `detail` or a message).
 */
import { isIP } from "node:net";
import {
  checkCsrfToken,
  clientLabel,
  csrfTokenFor,
  isOrganizationId,
  throttleSourceKey,
  type OrganizationId,
} from "@oculus/core";
import {
  beginSession,
  completePasswordReset,
  completeSecondStep,
  confirmEnrolment,
  endOtherSessions,
  endSession,
  organizationChoices,
  pendingSignInState,
  readOrganization,
  reauthenticate,
  readPendingSession,
  readSignedInPerson,
  requestPasswordReset,
  resolveSession,
  startEnrolment,
  switchOrganization,
  type Database,
  type FullSession,
  type PasswordChangedDelivery,
  type PasswordResetDelivery,
  type ResetRequestOptions,
  type SecretKeyring,
} from "@oculus/db";
import type { RecordService } from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import {
  CSRF_HEADER,
  isActivity,
  redactedError,
  sessionMarker,
  type ApiLogRecord,
} from "./staff-api.js";

export interface SignInApiOptions {
  /** The writer's pool (D-067): sessions, factors and resets live there. */
  readonly db: Database;
  /** From `loadSecretKeyring` at startup (D-077). */
  readonly keys: SecretKeyring;
  /** For `listMySites` (the site selector, D-072). */
  readonly service: RecordService;
  /**
   * Sends a password reset link (T-040 makes the email; D-078's rules:
   * honour the signal, never log or keep the token). Required: the startup
   * (admin-server.ts) refuses to start in production without one.
   */
  readonly deliverReset: PasswordResetDelivery;
  /**
   * Tells the account its password was changed after a reset link is used
   * (the mailer's `deliverPasswordChanged`, D-085). Not awaited; optional.
   */
  readonly deliverPasswordChanged?: PasswordChangedDelivery;
  /** Where fixed-shape log records go; default: one JSON line on standard error. */
  readonly log?: (record: ApiLogRecord) => void;
  /**
   * Logs a loud warning (at most once in 10 minutes) when a request comes
   * from a loopback address: behind a proxy that isn't configured as
   * trusted (`OCULUS_TRUSTED_PROXY`), every client then shares one address
   * and one throttle counter (D-068). On in production.
   */
  readonly warnSharedAddress?: boolean;
  /** Shown as the issuer in the authenticator app ("Oculus" by default). */
  readonly issuer?: string;
  /** Requests per minute per client address or session (rate-limit.ts). */
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  /** The limiter's and the warning's clock (tests). */
  readonly clock?: () => number;
  /** Passed to `requestPasswordReset` (tests shorten the background wait). */
  readonly resetOptions?: Pick<
    ResetRequestOptions,
    "backgroundDelayMs" | "lifeSeconds" | "deliveryTimeoutMs"
  >;
}

const WARNING_INTERVAL_MS = 10 * 60_000;

/** The limiter's windows are a minute long, so a minute is always long enough to wait. */
const RATE_LIMIT_RETRY_SECONDS = 60;

/**
 * Thrown inside a handler when a brake is used up; `guarded` turns it into
 * `429 rate_limited` with `Retry-After`. (A thrown Refusal can't carry a
 * header: an error reply drops everything the handler set, D-058.)
 */
class RateLimited extends Error {
  readonly retryAfterSeconds = RATE_LIMIT_RETRY_SECONDS;
  constructor() {
    super("rate_limited");
    this.name = "RateLimited";
  }
}

/** Wraps a handler so a used-up brake answers 429 with `Retry-After`. */
function guarded(
  handler: (request: OculusRequest, reply: OculusReply) => Promise<unknown>,
): (request: OculusRequest, reply: OculusReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (thrown) {
      if (!(thrown instanceof RateLimited)) throw thrown;
      reply.status(429).header("retry-after", String(thrown.retryAfterSeconds));
      return { error: "rate_limited" };
    }
  };
}

function defaultLog(record: ApiLogRecord): void {
  try {
    process.stderr.write(`${JSON.stringify({ oculus: record })}\n`);
  } catch {
    // Logging can't fail a request.
  }
}

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopback(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) return v4.startsWith("127.");
  return address === "::1" || address === "0:0:0:0:0:0:0:1";
}

// ---------------------------------------------------------------------------
// Reading the request

/** A JSON object body with only `allowed` keys, each text (at most 1,024 characters) or absent. */
function textBody<K extends string>(
  request: OculusRequest,
  allowed: readonly K[],
): Readonly<Partial<Record<K, string>>> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Refusal(400, "bad_body");
  }
  const out: Partial<Record<K, string>> = {};
  for (const key of Object.keys(body)) {
    if (!(allowed as readonly string[]).includes(key)) throw new Refusal(400, "bad_body");
    const value: unknown = (body as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length > 1024) throw new Refusal(400, "bad_body");
    out[key as K] = value;
  }
  return out;
}

/** An organization ID from the body, if given (400 if malformed). */
function organizationOf(value: string | undefined): OrganizationId | undefined {
  if (value === undefined) return undefined;
  if (!isOrganizationId(value)) throw new Refusal(400, "bad_body");
  return value;
}

// ---------------------------------------------------------------------------
// Answers

/** The fixed codes of a refusal from the second step and its relatives. */
const SECOND_STEP_ANSWERS: Readonly<Record<string, readonly [number, string]>> = {
  no_session: [401, "unauthenticated"],
  invalid_code: [422, "invalid_code"],
  too_many_attempts: [401, "too_many_attempts"],
  enrolment_required: [409, "set_up_required"],
  enrolment_token_required: [403, "set_up_link_required"],
  already_enrolled: [409, "already_set_up"],
  second_step_unavailable: [409, "use_recovery_code"],
  invalid_request: [400, "bad_body"],
  not_permitted: [403, "not_permitted"],
  same_organization: [409, "same_organization"],
  reauthentication_required: [403, "reauthentication_required"],
  retry: [503, "retry"],
  timeout: [503, "timeout"],
  database_unavailable: [503, "unavailable"],
  busy: [503, "busy"],
  internal_error: [500, "internal_error"],
};

function fixedAnswer(code: string): Refusal {
  const known = SECOND_STEP_ANSWERS[code];
  return known === undefined ? new Refusal(500, "internal_error") : new Refusal(...known);
}

/** A 429 with `Retry-After` and the seconds to wait; nothing about the account. */
function throttled(reply: OculusReply, seconds: number): unknown {
  const wait = Math.min(86_400, Math.max(1, Math.ceil(seconds)));
  reply.status(429).header("retry-after", String(wait));
  return { error: "throttled", retryAfterSeconds: wait };
}

/** What every screen gets about a full session: never the token. */
function sessionView(session: FullSession, token: string) {
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    systemAdmin: session.systemAdmin,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
    idleSeconds: session.idleSeconds,
    sessionMarker: sessionMarker(session.sessionId),
    csrfToken: csrfTokenFor(token) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The routes

/** The sign-in, sign-out and password-reset routes, for `buildServer({ routes })`. */
export function signInRoutes(options: SignInApiOptions): OculusRoute[] {
  const { db, keys, service } = options;
  if (typeof options.deliverReset !== "function") {
    throw new TypeError("signInRoutes needs deliverReset (the password reset link's sender).");
  }
  if (
    options.deliverPasswordChanged !== undefined &&
    typeof options.deliverPasswordChanged !== "function"
  ) {
    throw new TypeError("deliverPasswordChanged is a function.");
  }
  const log = options.log ?? defaultLog;
  const clock = options.clock ?? Date.now;
  const limiter = new SessionRateLimiter({ ...DEFAULT_RATE_LIMITS, ...options.rateLimits }, clock);
  const onError = (operation: string) => (error: unknown) => {
    log({ event: "sign_in_error", operation, ...redactedError(error) });
  };
  let lastWarning = -Infinity;

  /**
   * The client address for the throttles. Unreadable (a Unix socket, a
   * proxy header without a trusted proxy giving nothing) refuses the
   * request: every such client would share one counter (D-068).
   */
  function sourceOf(request: OculusRequest): string {
    const ip = request.ip;
    if (typeof ip !== "string" || isIP(ip) === 0) {
      log({ event: "client_address_warning", code: "unreadable" });
      throw new Refusal(503, "client_address_unknown");
    }
    if (options.warnSharedAddress === true && isLoopback(ip)) {
      const now = clock();
      if (now - lastWarning >= WARNING_INTERVAL_MS) {
        lastWarning = now;
        log({ event: "client_address_warning", code: "loopback" });
      }
    }
    return ip;
  }

  /**
   * The per-address limit: on every request made without a full session,
   * and before the session lookup on the others.
   */
  function limitAddress(source: string): void {
    if (!limiter.take(`address:${throttleSourceKey(source)}`, "credentials")) {
      throw new RateLimited();
    }
  }

  /** The cookie's token; on a post, its CSRF token must come with it (before the database). */
  function cookieToken(request: OculusRequest, post: boolean): string {
    const token = request.cookies[OCULUS_COOKIES.session];
    if (token === undefined) throw new Refusal(401, "unauthenticated");
    if (post && !checkCsrfToken(token, request.headers[CSRF_HEADER])) {
      throw new Refusal(403, "csrf_failed");
    }
    return token;
  }

  /**
   * The full session the cookie names: the per-address limit first (before
   * the database is asked), then the session, then the per-session limit.
   */
  async function fullSessionOf(
    request: OculusRequest,
    post: boolean,
  ): Promise<{ token: string; session: FullSession }> {
    limitAddress(sourceOf(request));
    const token = cookieToken(request, post);
    const resolved = await resolveSession(db, token, {
      activity: isActivity(request),
      onError: onError("resolveSession"),
    });
    if (!resolved.ok) throw fixedAnswer(resolved.code);
    if (!limiter.take(resolved.session.sessionId, post ? "write" : "read")) {
      throw new RateLimited();
    }
    return { token, session: resolved.session };
  }

  /**
   * After a right code that still needs an organization: 409 with the
   * person's choices by name (they passed the second step; nothing was
   * used up, so the same code is sent again with one of them).
   */
  async function chooseOrganization(reply: OculusReply, token: string): Promise<unknown> {
    const pending = await readPendingSession(db, token, { onError: onError("readPending") });
    if (!pending.ok) throw fixedAnswer(pending.code);
    const choices = await organizationChoices(db, pending.session.userId);
    reply.status(409);
    return { error: "choose_organization", organizations: choices };
  }

  /** The cookie and the reply for a session that has just become full. */
  function signedIn(reply: OculusReply, token: string, session: FullSession) {
    reply.setCookie(OCULUS_COOKIES.session, token);
    return { session: sessionView(session, token) };
  }

  /**
   * Maps a refusal of the code or set-up steps to its reply. A session that
   * has ended (`too_many_attempts`) keeps its cookie: an error reply drops
   * every cookie the handler set (D-058), and the dead token is refused
   * everywhere anyway.
   */
  async function secondStepRefusal(
    reply: OculusReply,
    token: string,
    refusal: { readonly code: string; readonly retryAfterSeconds?: number },
  ): Promise<unknown> {
    if (refusal.code === "choose_organization" || refusal.code === "organization_required") {
      return chooseOrganization(reply, token);
    }
    if (refusal.code === "throttled") return throttled(reply, refusal.retryAfterSeconds ?? 1);
    throw fixedAnswer(refusal.code);
  }

  const routes: OculusRoute[] = [
    {
      method: "POST",
      path: "/api/sign-in",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const body = textBody(request, ["email", "password"]);
        limitAddress(source);
        if (body.email === undefined || body.password === undefined) {
          throw new Refusal(400, "bad_body");
        }
        const label = clientLabel(request.headers["user-agent"]);
        const started = await beginSession(
          db,
          {
            email: body.email,
            password: body.password,
            source,
            ...(label === undefined ? {} : { clientLabel: label }),
          },
          { onError: onError("beginSession") },
        );
        if (!started.ok) {
          // One reply for a wrong password, an unknown address, a disabled
          // account and one without an organization (D-068).
          if (started.code === "invalid_credentials") {
            throw new Refusal(401, "invalid_credentials");
          }
          if (started.code === "throttled") return throttled(reply, started.retryAfterSeconds);
          throw fixedAnswer(started.code);
        }
        // A session this browser held before is ended: one sign-in, one session.
        const previous = request.cookies[OCULUS_COOKIES.session];
        if (previous !== undefined && previous !== started.token) {
          await endSession(db, previous, { onError: onError("endSession") });
        }
        reply.setCookie(OCULUS_COOKIES.session, started.token);
        const state = await pendingSignInState(db, started.token, {
          onError: onError("pendingState"),
        });
        if (!state.ok) throw fixedAnswer(state.code);
        return {
          expiresAt: state.expiresAt,
          next: state.next,
          setUpLinkRequired: state.enrolmentTokenRequired,
          csrfToken: csrfTokenFor(started.token) ?? null,
        };
      },
    },
    {
      method: "GET",
      path: "/api/sign-in/pending",
      handler: async (request) => {
        limitAddress(sourceOf(request));
        const token = cookieToken(request, false);
        const state = await pendingSignInState(db, token, { onError: onError("pendingState") });
        if (!state.ok) throw fixedAnswer(state.code);
        return {
          expiresAt: state.expiresAt,
          next: state.next,
          setUpLinkRequired: state.enrolmentTokenRequired,
          csrfToken: csrfTokenFor(token) ?? null,
        };
      },
    },
    {
      method: "POST",
      path: "/api/sign-in/code",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const token = cookieToken(request, true);
        const body = textBody(request, ["code", "recoveryCode", "organizationId"]);
        limitAddress(source);
        if ((body.code === undefined) === (body.recoveryCode === undefined)) {
          throw new Refusal(400, "bad_body");
        }
        const organizationId = organizationOf(body.organizationId);
        const done = await completeSecondStep(
          db,
          keys,
          token,
          {
            source,
            ...(body.code === undefined ? {} : { code: body.code }),
            ...(body.recoveryCode === undefined ? {} : { recoveryCode: body.recoveryCode }),
            ...(organizationId === undefined ? {} : { organizationId }),
          },
          { onError: onError("completeSecondStep") },
        );
        if (done.ok) return signedIn(reply, done.token, done.session);
        return secondStepRefusal(reply, token, done);
      },
    },
    {
      method: "POST",
      path: "/api/sign-in/set-up",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const token = cookieToken(request, true);
        const body = textBody(request, ["setUpLink"]);
        limitAddress(source);
        const started = await startEnrolment(db, keys, token, {
          onError: onError("startEnrolment"),
          ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
          ...(body.setUpLink === undefined ? {} : { enrolmentToken: body.setUpLink }),
        });
        if (!started.ok) return secondStepRefusal(reply, token, started);
        // Shown once, to the person who typed the password, never stored or logged.
        return { secret: started.secret, otpauthUri: started.otpauthUri };
      },
    },
    {
      method: "POST",
      path: "/api/sign-in/set-up/confirm",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const token = cookieToken(request, true);
        const body = textBody(request, ["code", "organizationId"]);
        limitAddress(source);
        if (body.code === undefined) throw new Refusal(400, "bad_body");
        const organizationId = organizationOf(body.organizationId);
        const done = await confirmEnrolment(
          db,
          keys,
          token,
          {
            code: body.code,
            source,
            ...(organizationId === undefined ? {} : { organizationId }),
          },
          { onError: onError("confirmEnrolment") },
        );
        if (!done.ok) return secondStepRefusal(reply, token, done);
        // The recovery codes are shown once, here, and stored only hashed.
        return { ...signedIn(reply, done.token, done.session), recoveryCodes: done.recoveryCodes };
      },
    },
    {
      method: "POST",
      path: "/api/sign-out",
      handler: async (request, reply) => {
        limitAddress(sourceOf(request));
        const token = request.cookies[OCULUS_COOKIES.session];
        // Without a session there is nothing to protect: just clear the cookie.
        if (token === undefined) {
          reply.clearCookie(OCULUS_COOKIES.session);
          return { signedOut: true };
        }
        cookieToken(request, true);
        const ended = await endSession(db, token, { onError: onError("endSession") });
        if (!ended.ok) throw fixedAnswer(ended.code);
        reply.clearCookie(OCULUS_COOKIES.session);
        return { signedOut: true };
      },
    },
    {
      method: "POST",
      path: "/api/sign-out/others",
      handler: async (request) => {
        const { token } = await fullSessionOf(request, true);
        const ended = await endOtherSessions(db, token, { onError: onError("endOtherSessions") });
        if (!ended.ok) throw fixedAnswer(ended.code);
        return { ended: ended.ended };
      },
    },
    {
      // Entering the password and a code again before a sensitive change
      // (D-069, D-077; T-048's people changes): a new token in the cookie,
      // its CSRF token in the reply. A wrong password is 403, not 401: the
      // session is still alive.
      method: "POST",
      path: "/api/reauthenticate",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const { token } = await fullSessionOf(request, true);
        const body = textBody(request, ["password", "code", "recoveryCode"]);
        if (
          body.password === undefined ||
          (body.code === undefined) === (body.recoveryCode === undefined)
        ) {
          throw new Refusal(400, "bad_body");
        }
        const done = await reauthenticate(
          db,
          keys,
          token,
          {
            password: body.password,
            source,
            ...(body.code === undefined ? {} : { code: body.code }),
            ...(body.recoveryCode === undefined ? {} : { recoveryCode: body.recoveryCode }),
          },
          { onError: onError("reauthenticate") },
        );
        if (!done.ok) {
          if (done.code === "invalid_credentials") throw new Refusal(403, "invalid_credentials");
          if (done.code === "throttled") {
            return throttled(reply, "retryAfterSeconds" in done ? done.retryAfterSeconds : 1);
          }
          throw fixedAnswer(done.code);
        }
        return signedIn(reply, done.token, done.session);
      },
    },
    {
      method: "POST",
      path: "/api/organization",
      handler: async (request, reply) => {
        const { token } = await fullSessionOf(request, true);
        const body = textBody(request, ["organizationId"]);
        if (body.organizationId === undefined) throw new Refusal(400, "bad_body");
        // Another organization is a new session with a new token (D-019, D-069).
        const switched = await switchOrganization(db, token, body.organizationId, {
          onError: onError("switchOrganization"),
        });
        if (!switched.ok) throw fixedAnswer(switched.code);
        return signedIn(reply, switched.token, switched.session);
      },
    },
    {
      method: "GET",
      path: "/api/me",
      handler: async (request) => {
        const { token, session } = await fullSessionOf(request, false);
        const person = await readSignedInPerson(db, session.userId);
        if (person === undefined) throw new Refusal(401, "unauthenticated");
        const sites = await service.listMySites({
          organizationId: session.organizationId,
          actor: `user:${session.userId}`,
        });
        if (!sites.ok) throw new Refusal(503, "unavailable");
        const named = sites.value.find((s) => s.organizationId === session.organizationId);
        const organization =
          named === undefined ? await readOrganization(db, session.organizationId) : undefined;
        return {
          ...sessionView(session, token),
          displayName: person.displayName,
          email: person.email,
          // D-077's wrong-code alerts of the last 30 days (D-085): a trace on
          // screen even when the email was lost.
          secondStepAlerts: {
            recent: person.secondStepAlerts.recent,
            lastAt: person.secondStepAlerts.lastAt,
          },
          organizationName:
            named?.organizationName ?? (organization?.ok === true ? organization.value.name : ""),
          sites: sites.value,
        };
      },
    },
    {
      method: "POST",
      path: "/api/password-reset",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const body = textBody(request, ["email"]);
        limitAddress(source);
        if (body.email === undefined) throw new Refusal(400, "bad_body");
        const answer = await requestPasswordReset(
          db,
          { email: body.email, source },
          options.deliverReset,
          {
            ...options.resetOptions,
            onError: onError("passwordReset"),
            // What became of it, for the log: never the address or the token.
            onSettled: (outcome) => {
              log({ event: "reset_settled", code: outcome });
            },
          },
        );
        if (answer.ok) {
          reply.status(202);
          return { requested: true };
        }
        if (answer.code === "throttled") return throttled(reply, answer.retryAfterSeconds);
        throw fixedAnswer(answer.code);
      },
    },
    {
      method: "POST",
      path: "/api/password-reset/complete",
      credentials: true,
      handler: async (request, reply) => {
        const source = sourceOf(request);
        const body = textBody(request, ["token", "password"]);
        limitAddress(source);
        if (body.token === undefined || body.password === undefined) {
          throw new Refusal(400, "bad_body");
        }
        const done = await completePasswordReset(
          db,
          { token: body.token, password: body.password },
          {
            onError: onError("completePasswordReset"),
            ...(options.deliverPasswordChanged === undefined
              ? {}
              : { notifyChanged: options.deliverPasswordChanged }),
          },
        );
        if (done.ok) return { reset: true };
        const codes = done.issues.map((i) => i.code);
        if (codes.includes("invalid_reset")) throw new Refusal(400, "invalid_reset");
        if (done.issues.every((i) => i.path[0] === "password")) {
          // The person's own new password failed D-068's rules: say which.
          reply.status(422);
          return { error: "invalid_password", issues: done.issues };
        }
        throw fixedAnswer(codes[0] ?? "internal_error");
      },
    },
  ];
  return routes.map((route) => {
    const handler = route.handler;
    return {
      ...route,
      handler: guarded(async (request, reply) => {
        // X-Oculus-Background (T-062, D-098): refused on every change and
        // in any spelling but `1`, before anything else; on a read that
        // doesn't resolve a full session (`GET /api/sign-in/pending`) it is
        // accepted and changes nothing, since a waiting session's end is
        // fixed at its password.
        isActivity(request);
        return await handler(request, reply);
      }),
    };
  });
}
