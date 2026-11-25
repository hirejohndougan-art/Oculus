/**
 * Accessions and donor contacts over HTTP (T-073), mounted by
 * `staffApiRoutes` behind the same session, CSRF, origin, size, type and
 * per-session rules as every staff route (D-079). Each route calls the
 * service (`packages/service/src/accessions.ts`, T-018c, D-114), which
 * decides every permission (`donors.view` to read, `donors.edit` to change;
 * D-036's Donor relations role and managers) and is the only writer
 * (D-067).
 *
 * - `GET /api/accessions?before=<id>`: a page of the organization's
 *   accessions (`{ accessions, next }`).
 * - `POST /api/accessions` `{ accession }`: 201, `ETag: "v1"`, the saved
 *   accession and `nowHeld`, the published records it now holds back
 *   (D-114), so the admin can offer to withdraw them.
 * - `GET /api/accessions/:id`: one accession, `ETag: "v<N>"`.
 * - `PUT /api/accessions/:id` `{ accession }` with `If-Match: "v<N>"`: the
 *   edit, with `nowHeld` again.
 * - `GET /api/donor-contacts/:agentId`: an agent's contact details.
 * - `PUT /api/donor-contacts/:agentId` `{ contact }`: `If-None-Match: *` for
 *   the first, `If-Match: "v<N>"` after (201 for the first).
 * - `DELETE /api/donor-contacts/:agentId` with `If-Match: "v<N>"`.
 *
 * An accession or contact that doesn't exist, another organization's, and
 * a malformed ID are the same `404 not_found`, byte for byte (the service
 * answers them alike; a malformed ID is answered here as a missing one).
 * A person without the permission is `403 not_permitted`, before anything
 * about the accession is said. Everything here is STAFF ONLY: no route is
 * ever served to a public site (S-049), and no refusal quotes a contact,
 * materials, restrictions or a note (the service's messages are fixed).
 */
import type { RecordService, ServiceRefusal, ServiceResult } from "@oculus/service";
import { Refusal } from "./errors.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import type { RateBucket } from "./rate-limit.js";
import {
  ifMatchVersion,
  newOrMatch,
  objectBody,
  onlyKeys,
  queryText,
  refused,
  VERSION_TAG,
  type ApiLogRecord,
  type Handler,
} from "./staff-api.js";

interface Shared {
  readonly service: RecordService;
  readonly log: (record: ApiLogRecord) => void;
  readonly signedIn: (
    bucket: RateBucket,
    unsafe: boolean,
    handler: Handler,
  ) => (request: OculusRequest, reply: OculusReply) => Promise<unknown>;
}

/** A missing accession or contact (or a malformed ID) on its own path: 404. */
const MISSING: Readonly<Record<string, string>> = {
  unknown_accession: "accessionId",
  unknown_contact: "agentId",
};

function accessionRefused(
  result: ServiceRefusal,
  reply: OculusReply,
  log: (record: ApiLogRecord) => void,
): unknown {
  const issues = result.issues;
  if (
    issues.length > 0 &&
    issues.every(
      (i) =>
        i.path.length === 1 &&
        (MISSING[i.code] === i.path[0] ||
          // saveDonorContact answers a malformed agent ID as invalid_id: on
          // a route's path it is the same as a missing one.
          (i.code === "invalid_id" && i.path[0] === "agentId")),
    )
  ) {
    throw new Refusal(404, "not_found");
  }
  return refused(result, reply, log);
}

/** The version as an ETag. */
const etag = (reply: OculusReply, version: number): void => {
  reply.header("etag", `"v${String(version)}"`);
};

export function accessionsApiRoutes(shared: Shared): OculusRoute[] {
  const { service, log, signedIn } = shared;

  function answer<T>(
    result: ServiceResult<T>,
    reply: OculusReply,
    ok: (value: T) => unknown,
  ): unknown {
    return result.ok ? ok(result.value) : accessionRefused(result, reply, log);
  }

  const idOf = (request: OculusRequest): string => request.params.id ?? "";
  const agentOf = (request: OculusRequest): string => request.params.agentId ?? "";

  return [
    {
      method: "GET",
      path: "/api/accessions",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const before = queryText(request, "before");
        if (before !== undefined && !/^[0-9a-f-]{36}$/.test(before)) {
          throw new Refusal(400, "bad_query");
        }
        const result = await service.listAccessions(
          context,
          before === undefined ? undefined : { before },
        );
        return answer(result, reply, (value) => value);
      }),
    },
    {
      method: "POST",
      path: "/api/accessions",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const body = objectBody(request);
        const extra = onlyKeys(body, ["accession"], reply);
        if (extra) return extra;
        const result = await service.createAccession(context, body.accession);
        return answer(result, reply, (value) => {
          reply.status(201).header("location", `/api/accessions/${value.accession.id}`);
          etag(reply, value.version);
          return value;
        });
      }),
    },
    {
      method: "GET",
      path: "/api/accessions/:id",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readAccession(context, idOf(request));
        return answer(result, reply, (value) => {
          etag(reply, value.version);
          return value;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/accessions/:id",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        const body = objectBody(request);
        const extra = onlyKeys(body, ["accession"], reply);
        if (extra) return extra;
        const result = await service.updateAccession(context, idOf(request), body.accession, {
          expectedVersion,
        });
        return answer(result, reply, (value) => {
          etag(reply, value.version);
          return value;
        });
      }),
    },
    {
      method: "GET",
      path: "/api/donor-contacts/:agentId",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const result = await service.readDonorContact(context, agentOf(request));
        return answer(result, reply, (value) => {
          etag(reply, value.version);
          return value;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/donor-contacts/:agentId",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const precondition = newOrMatch(request, VERSION_TAG);
        const body = objectBody(request);
        const extra = onlyKeys(body, ["contact"], reply);
        if (extra) return extra;
        const result = await service.saveDonorContact(context, agentOf(request), body.contact, {
          expectedVersion: precondition === "new" ? 0 : Number(precondition.tag),
        });
        return answer(result, reply, (value) => {
          if (precondition === "new") reply.status(201);
          etag(reply, value.version);
          return value;
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/donor-contacts/:agentId",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const expectedVersion = ifMatchVersion(request);
        if (request.body !== undefined) throw new Refusal(400, "bad_body");
        const result = await service.deleteDonorContact(context, agentOf(request), {
          expectedVersion,
        });
        return answer(result, reply, (value) => value);
      }),
    },
  ];
}
