/**
 * "Clean up removed files" over HTTP (S-052, D-086), mounted by
 * `staffApiRoutes` when a file store is configured, behind the same
 * session, CSRF, origin, size, type and per-session rules as every staff
 * route (D-079). System managers only (`system.settings`, as for updates);
 * running a step also needs the password and second step entered in the
 * last 10 minutes (`403 reauthentication_required`), as inviting does.
 *
 * - `GET /api/system/files/cleanup`: a dry run (`purgeFiles({ apply: false })`):
 *   what a step would move to the trash, delete and put back, and what is
 *   waiting; nothing is changed. A folder this database can't purge is
 *   `{ available: false, problem }`.
 * - `POST /api/system/files/cleanup` `{}`: runs one step under the folder's
 *   lease, with the system manager as the change log's actor.
 * - `POST /api/system/files/cleanup/accept-identity` `{}`: after a
 *   pg_upgrade or a move (`identity_changed`), makes the marker name this
 *   database, while the folder's epoch is still its own; a recent sign-in,
 *   and the change log.
 */
import type { UserId } from "@oculus/core";
import type { PeopleContext, RecordService, ServiceContext } from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import type { RateBucket } from "./rate-limit.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import { objectBody, onlyKeys, refused, type ApiLogRecord, type Handler } from "./staff-api.js";

interface Shared {
  readonly service: RecordService;
  readonly log: (record: ApiLogRecord) => void;
  readonly signedIn: (
    bucket: RateBucket,
    unsafe: boolean,
    handler: Handler,
  ) => (request: OculusRequest, reply: OculusReply) => Promise<unknown>;
}

export function filesPurgeApiRoutes(shared: Shared): OculusRoute[] {
  const { service, log, signedIn } = shared;

  async function allowed(
    request: OculusRequest,
    reply: OculusReply,
    context: ServiceContext,
    fresh: boolean,
  ): Promise<{ readonly userId: UserId } | { readonly refusal: unknown }> {
    const token = request.cookies[OCULUS_COOKIES.session];
    if (token === undefined) throw new Refusal(401, "unauthenticated");
    const people: PeopleContext = { ...context, sessionToken: token };
    const result = await service.authorizeSystemUpdate(people, { fresh });
    if (result.ok) return { userId: result.value.userId };
    const codes = new Set(result.issues.map((i) => i.code));
    if (codes.has("reauthentication_required")) throw new Refusal(403, "reauthentication_required");
    if (codes.has("no_session")) throw new Refusal(401, "unauthenticated");
    return { refusal: refused(result, reply, log) };
  }

  return [
    {
      method: "GET",
      path: "/api/system/files/cleanup",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const result = await service.purgeFiles({ apply: false });
        if (!result.ok) return { available: false, problem: result.problem };
        return { available: true, ...result.value };
      }),
    },
    {
      method: "POST",
      path: "/api/system/files/cleanup",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, true);
        if ("refusal" in who) return who.refusal;
        if (request.body !== undefined) {
          const extra = onlyKeys(objectBody(request), [], reply);
          if (extra !== undefined) return extra;
        }
        const result = await service.purgeFiles({ apply: true, actorId: who.userId });
        // The folder can't be purged by this database: a fixed code, no detail.
        if (!result.ok) throw new Refusal(409, result.problem);
        return { available: true, ...result.value };
      }),
    },
    {
      method: "POST",
      path: "/api/system/files/cleanup/accept-identity",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, true);
        if ("refusal" in who) return who.refusal;
        if (request.body !== undefined) {
          const extra = onlyKeys(objectBody(request), [], reply);
          if (extra !== undefined) return extra;
        }
        const result = await service.acceptFileStoreIdentity(who.userId);
        if (!result.ok) throw new Refusal(409, result.problem);
        return { accepted: true, changed: result.changed };
      }),
    },
  ];
}
