/**
 * People, roles and the audit trail over HTTP (T-048, D-084), mounted by
 * `staffApiRoutes` when it is given `people`, behind the same session,
 * CSRF, origin, size, type and per-session rules (D-079). Each route calls
 * the service (`packages/service/src/people.ts`), which decides every
 * permission and is the only writer (D-067); the account functions it calls
 * check theirs again (D-068, D-069, D-077, D-078).
 *
 * - `GET /api/people`: the members the person may see, with the roles they
 *   may see, and what they may do (`rights`).
 * - `GET /api/people/:id`: one member; for system managers also their live
 *   sessions (never a token or an address) and two-step status.
 * - `GET /api/roles`: the built-in roles and their permissions.
 * - `POST /api/invitations` `{ email, expiresInDays? }`: 201
 *   `{ invitationId, email, expiresAt }`. The token goes only to the
 *   invitee's mailbox (D-068's rule): never in a reply or a log.
 * - `POST /api/people/:id/disable`, `/enable`.
 * - `POST /api/people/:id/roles` `{ role, siteId, scope }` (201) and
 *   `DELETE /api/role-assignments/:id`.
 * - `POST /api/people/:id/reset-second-step` `{ code | recoveryCode }`: the
 *   system manager's own code now (D-077).
 * - `POST /api/people/:id/password-reset` `{ confirmMailboxOnly? }`: 409
 *   `confirmation_required` with `confirm_mailbox_only` when the person
 *   has no second factor in use (D-078).
 * - `POST /api/people/:id/end-sessions`.
 * - `GET /api/audit?person=&record=&from=&to=&after=&limit=`: the change
 *   log, newest first.
 *
 * Changes to a person need the password and second step entered in the
 * last 10 minutes (`403 reauthentication_required`; `POST
 * /api/reauthenticate` in sign-in-api.ts). A member out of view, another
 * organization's and an unknown or malformed ID are the same `404
 * not_found`, byte for byte; so are an assignment the person can't manage
 * and one that doesn't exist. People have no versions, so no `If-Match`.
 */
import { isIP } from "node:net";
import type {
  EnrolmentDelivery,
  InvitationDelivery,
  PasswordResetDelivery,
  SecretKeyring,
} from "@oculus/db";
import type {
  PeopleContext,
  RecordService,
  ServiceContext,
  ServiceRefusal,
  ServiceResult,
} from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import type { RateBucket } from "./rate-limit.js";
import {
  objectBody,
  onlyKeys,
  queryNumber,
  queryText,
  refused,
  type ApiLogRecord,
  type Handler,
} from "./staff-api.js";

export interface PeopleApiOptions {
  /** From `loadSecretKeyring` at startup (D-077): resetting two-step sign-in needs it. */
  readonly keys: SecretKeyring;
  /** Sends an invitation (T-040 makes the email). Without it, inviting answers 503. */
  readonly deliverInvitation?: InvitationDelivery;
  /** Sends the set-up token after a reset of two-step sign-in (T-040). Without it, 503. */
  readonly deliverEnrolment?: EnrolmentDelivery;
  /** Sends a password reset link (D-078). Without it, 503. */
  readonly deliverReset?: PasswordResetDelivery;
}

interface Shared {
  readonly service: RecordService;
  readonly log: (record: ApiLogRecord) => void;
  readonly signedIn: (
    bucket: RateBucket,
    unsafe: boolean,
    handler: Handler,
  ) => (request: OculusRequest, reply: OculusReply) => Promise<unknown>;
}

/** Fixed answers for the people codes; the rest go to the staff API's mapping. */
const FIXED: Readonly<Record<string, readonly [number, string]>> = {
  unknown_person: [404, "not_found"],
  unknown_assignment: [404, "not_found"],
  no_session: [401, "unauthenticated"],
  reauthentication_required: [403, "reauthentication_required"],
  too_many_attempts: [401, "too_many_attempts"],
  invalid_code: [422, "invalid_code"],
  second_step_unavailable: [409, "use_recovery_code"],
  database_unavailable: [503, "unavailable"],
  busy: [503, "busy"],
};

/** Refusals that say what happened, with their issues (fixed messages, no token or address). */
const WITH_ISSUES: Readonly<Record<string, number>> = {
  confirm_mailbox_only: 409,
  last_system_manager: 409,
  already_member: 409,
  already_granted: 409,
  whole_catalog_only: 422,
  account_disabled: 409,
  cannot_sign_in: 409,
  account_changed: 409,
  superseded: 409,
  revoked: 409,
  delivery_failed: 502,
  delivery_failed_may_be_pending: 502,
};

function peopleRefused(
  result: ServiceRefusal,
  reply: OculusReply,
  log: (record: ApiLogRecord) => void,
): unknown {
  for (const i of result.issues) {
    const fixed = FIXED[i.code];
    if (fixed !== undefined) throw new Refusal(...fixed);
    if (i.code === "throttled") {
      reply.status(429).header("retry-after", "60");
      return { error: "throttled" };
    }
  }
  for (const i of result.issues) {
    const status = WITH_ISSUES[i.code];
    if (status !== undefined) {
      reply.status(status);
      return {
        error: i.code === "confirm_mailbox_only" ? "confirmation_required" : i.code,
        issues: result.issues,
      };
    }
  }
  return refused(result, reply, log);
}

/** The client address for the second step's throttles (D-068); unreadable refuses. */
function sourceOf(request: OculusRequest, log: (record: ApiLogRecord) => void): string {
  const ip = request.ip;
  if (typeof ip !== "string" || isIP(ip) === 0) {
    log({ event: "client_address_warning", code: "unreadable" });
    throw new Refusal(503, "client_address_unknown");
  }
  return ip;
}

export function peopleApiRoutes(options: PeopleApiOptions, shared: Shared): OculusRoute[] {
  const { service, log, signedIn } = shared;

  function answer<T>(
    result: ServiceResult<T>,
    reply: OculusReply,
    ok: (value: T) => unknown,
  ): unknown {
    return result.ok ? ok(result.value) : peopleRefused(result, reply, log);
  }

  /** The context of a change: the session's token too, for the re-entry checks. */
  function changeContext(request: OculusRequest, context: ServiceContext): PeopleContext {
    const token = request.cookies[OCULUS_COOKIES.session];
    if (token === undefined) throw new Refusal(401, "unauthenticated");
    return { ...context, sessionToken: token };
  }

  /** An optional JSON body with only `allowed` keys (else 422 as the staff API). */
  function bodyOf(
    request: OculusRequest,
    reply: OculusReply,
    allowed: readonly string[],
  ): { readonly body: Readonly<Record<string, unknown>> } | { readonly refusal: unknown } {
    if (request.body === undefined) return { body: {} };
    const body = objectBody(request);
    const extra = onlyKeys(body, allowed, reply);
    return extra === undefined ? { body } : { refusal: extra };
  }

  const userId = (request: OculusRequest): string => request.params.id ?? "";

  function accountRoute(
    path: string,
    act: (request: OculusRequest, context: PeopleContext) => Promise<ServiceResult<unknown>>,
  ): OculusRoute {
    return {
      method: "POST",
      path,
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const read = bodyOf(request, reply, []);
        if ("refusal" in read) return read.refusal;
        const result = await act(request, changeContext(request, context));
        return answer(result, reply, (value) => value);
      }),
    };
  }

  return [
    {
      method: "GET",
      path: "/api/people",
      handler: signedIn("read", false, async (_request, reply, { context }) =>
        answer(await service.listPeople(context), reply, (value) => value),
      ),
    },
    {
      method: "GET",
      path: "/api/people/:id",
      handler: signedIn("read", false, async (request, reply, { context }) =>
        answer(await service.readPerson(context, userId(request)), reply, (value) => value),
      ),
    },
    {
      method: "GET",
      path: "/api/roles",
      handler: signedIn("read", false, async (_request, reply, { context }) =>
        answer(await service.roleCatalog(context), reply, (roles) => ({ roles })),
      ),
    },
    {
      method: "POST",
      path: "/api/invitations",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["email", "expiresInDays"], reply);
        if (extra) return extra;
        if (typeof body.email !== "string") throw new Refusal(400, "bad_body");
        const deliver = options.deliverInvitation;
        if (deliver === undefined) throw new Refusal(503, "delivery_unavailable");
        const result = await service.invitePerson(changeContext(request, context), body, deliver);
        return answer(result, reply, (value) => {
          reply.status(201);
          return value;
        });
      }),
    },
    accountRoute("/api/people/:id/disable", (request, context) =>
      service.setPersonDisabled(context, userId(request), true),
    ),
    accountRoute("/api/people/:id/enable", (request, context) =>
      service.setPersonDisabled(context, userId(request), false),
    ),
    accountRoute("/api/people/:id/end-sessions", (request, context) =>
      service.endPersonSessions(context, userId(request)),
    ),
    {
      method: "POST",
      path: "/api/people/:id/roles",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["role", "siteId", "scope"], reply);
        if (extra) return extra;
        const result = await service.grantPersonRole(changeContext(request, context), {
          ...body,
          userId: userId(request),
        });
        return answer(result, reply, (value) => {
          reply.status(201);
          return value;
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/role-assignments/:id",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const read = bodyOf(request, reply, []);
        if ("refusal" in read) return read.refusal;
        const result = await service.revokePersonRole(
          changeContext(request, context),
          request.params.id ?? "",
        );
        return answer(result, reply, (value) => ({ revoked: value.id }));
      }),
    },
    {
      method: "POST",
      path: "/api/people/:id/reset-second-step",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["code", "recoveryCode"], reply);
        if (extra) return extra;
        const code = body.code;
        const recoveryCode = body.recoveryCode;
        if (
          (code === undefined) === (recoveryCode === undefined) ||
          (code !== undefined && (typeof code !== "string" || code.length > 64)) ||
          (recoveryCode !== undefined &&
            (typeof recoveryCode !== "string" || recoveryCode.length > 64))
        ) {
          throw new Refusal(400, "bad_body");
        }
        const deliver = options.deliverEnrolment;
        if (deliver === undefined) throw new Refusal(503, "delivery_unavailable");
        const source = sourceOf(request, log);
        const result = await service.resetPersonSecondStep(
          changeContext(request, context),
          userId(request),
          {
            ...(code === undefined ? {} : { code: code }),
            ...(recoveryCode === undefined ? {} : { recoveryCode: recoveryCode }),
            source,
          },
          options.keys,
          deliver,
        );
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "POST",
      path: "/api/people/:id/password-reset",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const read = bodyOf(request, reply, ["confirmMailboxOnly"]);
        if ("refusal" in read) return read.refusal;
        const deliver = options.deliverReset;
        if (deliver === undefined) throw new Refusal(503, "delivery_unavailable");
        const result = await service.sendPersonPasswordReset(
          changeContext(request, context),
          userId(request),
          read.body,
          deliver,
        );
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "GET",
      path: "/api/audit",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const filter: Record<string, unknown> = {};
        for (const key of ["person", "record", "from", "to", "after"]) {
          const value = queryText(request, key);
          if (value !== undefined && value !== "") filter[key] = value;
        }
        const limit = queryNumber(request, "limit", 100);
        if (limit !== undefined) filter.limit = limit;
        const result = await service.auditTrail(context, filter);
        return answer(result, reply, (value) => value);
      }),
    },
  ];
}
