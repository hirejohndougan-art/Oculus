/**
 * Software updates over HTTP (T-060, D-092), mounted by `staffApiRoutes`
 * behind the same session, CSRF, origin, size, type and per-session rules
 * as every staff route (D-079). Every route asks the service first
 * (`authorizeSystemUpdate`): system managers only, and installing or
 * rolling back also needs the password and second step entered in the last
 * 10 minutes (`403 reauthentication_required`; `POST /api/reauthenticate`).
 *
 * A package arrives in parts of `partBytes` raw bytes, each sent as base64
 * in an ordinary JSON body, so the HTTP layer's limits and parsers stay as
 * they are (no new content type, no larger body limit, no longer timeout).
 *
 * - `GET /api/system/update`: the status (update-manager.ts `UpdateStatus`),
 *   or `{ configured: false, … }` when `OCULUS_UPDATE_DIR` isn't set.
 * - `POST /api/system/update/uploads` `{ size }`: 201 `{ uploadId, partBytes }`.
 * - `PUT /api/system/update/uploads/:id/parts/:index` `{ data }`: `{ received }`.
 * - `POST /api/system/update/uploads/:id/finish`: 202; the package is checked
 *   in the background (poll the status).
 * - `DELETE /api/system/update/uploads/:id`: stops an upload.
 * - `DELETE /api/system/update/pending`: removes the waiting update.
 * - `POST /api/system/update/install` `{ version }`: 202 (fresh entry).
 * - `POST /api/system/update/rollback` `{ version }`: 202 (fresh entry).
 */
import { issue } from "@oculus/core";
import type { PeopleContext, RecordService, ServiceContext, ServiceResult } from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { Refusal } from "./errors.js";
import type { RateBucket } from "./rate-limit.js";
import type { OculusReply, OculusRequest, OculusRoute } from "./routes.js";
import { objectBody, onlyKeys, refused, type ApiLogRecord, type Handler } from "./staff-api.js";
import {
  RUNNING_ROOT,
  UPDATE_BACKUP_ENV,
  UPDATE_DIR_ENV,
  UPDATE_KEYS_ENV,
  UPDATE_RESTART_ENV,
  UPLOAD_PART_BYTES,
  UpdateRefusal,
  releaseVersion,
  type UpdateManager,
} from "./update-manager.js";

export interface UpdateApiOptions {
  /** `undefined` when updates aren't set up: the status says how, every change answers 503. */
  readonly manager: UpdateManager | undefined;
  /** The running code's root, for the version when not set up (default `RUNNING_ROOT`). */
  readonly runningRoot?: string;
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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64: canonical, padded, at most `max` bytes. 400 otherwise. */
export function decodePart(text: unknown, max: number): Buffer {
  if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64.test(text)) {
    throw new Refusal(400, "bad_body");
  }
  if ((text.length / 4) * 3 > max + 2) throw new Refusal(400, "bad_body");
  const data = Buffer.from(text, "base64");
  if (data.length > max || data.toString("base64") !== text) throw new Refusal(400, "bad_body");
  return data;
}

export function updateApiRoutes(options: UpdateApiOptions, shared: Shared): OculusRoute[] {
  const { service, log, signedIn } = shared;
  const manager = options.manager;

  function updateContext(request: OculusRequest, context: ServiceContext): PeopleContext {
    const token = request.cookies[OCULUS_COOKIES.session];
    if (token === undefined) throw new Refusal(401, "unauthenticated");
    return { ...context, sessionToken: token };
  }

  /** The service's answer: the person's ID, or the reply to send. */
  async function allowed(
    request: OculusRequest,
    reply: OculusReply,
    context: ServiceContext,
    fresh: boolean,
  ): Promise<{ readonly userId: string } | { readonly refusal: unknown }> {
    const result: ServiceResult<{ readonly userId: string }> = await service.authorizeSystemUpdate(
      updateContext(request, context),
      { fresh },
    );
    if (result.ok) return { userId: result.value.userId };
    const codes = new Set(result.issues.map((i) => i.code));
    if (codes.has("reauthentication_required")) throw new Refusal(403, "reauthentication_required");
    if (codes.has("no_session")) throw new Refusal(401, "unauthenticated");
    return { refusal: refused(result, reply, log) };
  }

  function configured(): UpdateManager {
    if (manager === undefined) throw new Refusal(503, "updates_not_configured");
    return manager;
  }

  /** An `UpdateRefusal` becomes its status and code, with its fixed message as an issue. */
  async function answer(reply: OculusReply, work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UpdateRefusal) {
        reply.status(error.status);
        return { error: error.code, issues: [issue([], error.code, error.message)] };
      }
      log({ event: "service_error", operation: "update", name: "update_failed" });
      throw new Refusal(500, "internal_error");
    }
  }

  /** A JSON body with only `keys`; the 422 reply when it has others. */
  function body(
    request: OculusRequest,
    reply: OculusReply,
    keys: readonly string[],
  ): { readonly value: Readonly<Record<string, unknown>> } | { readonly refusal: unknown } {
    if (request.body === undefined && keys.length === 0) return { value: {} };
    const value = objectBody(request);
    const extra = onlyKeys(value, keys, reply);
    return extra === undefined ? { value } : { refusal: extra };
  }

  const uploadId = (request: OculusRequest): string => request.params.id ?? "";

  return [
    {
      method: "GET",
      path: "/api/system/update",
      handler: signedIn("read", false, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        if (manager === undefined) {
          return {
            configured: false,
            runningVersion: await releaseVersion(options.runningRoot ?? RUNNING_ROOT),
            variables: [UPDATE_DIR_ENV, UPDATE_KEYS_ENV, UPDATE_RESTART_ENV, UPDATE_BACKUP_ENV],
          };
        }
        return answer(reply, () => manager.status());
      }),
    },
    {
      method: "POST",
      path: "/api/system/update/uploads",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const read = body(request, reply, ["size"]);
        if ("refusal" in read) return read.refusal;
        const m = configured();
        return answer(reply, async () => {
          const started = await m.startUpload(read.value.size);
          reply.status(201);
          return started;
        });
      }),
    },
    {
      method: "PUT",
      path: "/api/system/update/uploads/:id/parts/:index",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const read = body(request, reply, ["data"]);
        if ("refusal" in read) return read.refusal;
        const m = configured();
        const indexText = request.params.index ?? "";
        if (!/^(0|[1-9][0-9]{0,5})$/.test(indexText)) throw new Refusal(404, "not_found");
        const data = decodePart(read.value.data, UPLOAD_PART_BYTES);
        return answer(reply, () => m.addPart(uploadId(request), Number(indexText), data));
      }),
    },
    {
      method: "POST",
      path: "/api/system/update/uploads/:id/finish",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const read = body(request, reply, []);
        if ("refusal" in read) return read.refusal;
        const m = configured();
        return answer(reply, async () => {
          m.finishUpload(uploadId(request));
          reply.status(202);
          return m.status();
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/system/update/uploads/:id",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const m = configured();
        return answer(reply, async () => {
          await m.cancelUpload(uploadId(request));
          return { cancelled: true };
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/system/update/pending",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, false);
        if ("refusal" in who) return who.refusal;
        const m = configured();
        return answer(reply, async () => {
          await m.discardPending();
          return m.status();
        });
      }),
    },
    {
      method: "POST",
      path: "/api/system/update/install",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, true);
        if ("refusal" in who) return who.refusal;
        const read = body(request, reply, ["version"]);
        if ("refusal" in read) return read.refusal;
        const m = configured();
        return answer(reply, async () => {
          m.startInstall(read.value.version, who.userId);
          reply.status(202);
          return m.status();
        });
      }),
    },
    {
      method: "POST",
      path: "/api/system/update/rollback",
      handler: signedIn("write", true, async (request, reply, { context }) => {
        const who = await allowed(request, reply, context, true);
        if ("refusal" in who) return who.refusal;
        const read = body(request, reply, ["version"]);
        if ("refusal" in read) return read.refusal;
        const m = configured();
        return answer(reply, async () => {
          m.startRollback(read.value.version, who.userId);
          reply.status(202);
          return m.status();
        });
      }),
    },
  ];
}
