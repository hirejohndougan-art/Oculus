/**
 * Changes to the server itself in the change log (T-060a, D-104): an update
 * installed or rolled back, by whom (an account, or the release command on
 * the server's command line) and from which version to which; and each run
 * of the purge of removed files that changed something (S-052, D-086): how
 * many contents and bytes it moved to the trash, deleted or put back. The table is
 * append-only (migration 0030); only system managers read it, through the
 * audit trail (people.ts `readAuditTrail`).
 */
import { randomUUID } from "node:crypto";
import { isUserId, type UserId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** Exactly what the writer may do: add rows (roles.ts). */
export const SYSTEM_EVENT_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    system_events: Object.freeze(["INSERT"]),
  });

export const SYSTEM_EVENT_KINDS = Object.freeze([
  "update_installed",
  "update_rolled_back",
  "files_trashed",
  "files_deleted",
  "files_restored",
] as const);
export type SystemEventKind = (typeof SYSTEM_EVENT_KINDS)[number];

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export interface NewSystemEvent {
  /** The system manager, or `null` for the release command on the server. */
  readonly actorId: UserId | null;
  readonly kind: "update_installed" | "update_rolled_back";
  /** The version running after the change. */
  readonly version: string;
  /** The version before it; `null` for a development build. */
  readonly fromVersion: string | null;
}

/** A purge run's change (S-052): no version, a count and a size. */
export interface NewFilePurgeEvent {
  /** The system manager, or `null` for the command line or the automatic run. */
  readonly actorId: UserId | null;
  readonly kind: "files_trashed" | "files_deleted" | "files_restored";
  readonly files: number;
  readonly bytes: number;
  /**
   * `timer` for the daily automatic run, `lease` for trash put back when the
   * lease was found moved (then `actorId` is null); left out otherwise.
   * Only on the purge's own kinds.
   */
  readonly source?: "timer" | "lease";
}

/** Appends one row, stamped now by the database. */
export async function insertSystemEvent(
  tx: Queryable,
  event: NewSystemEvent | NewFilePurgeEvent,
): Promise<void> {
  if (event.actorId !== null && !isUserId(event.actorId)) {
    throw new TypeError("insertSystemEvent: a malformed event.");
  }
  if (!("files" in event)) {
    if (
      !VERSION.test(event.version) ||
      (event.fromVersion !== null && !VERSION.test(event.fromVersion))
    ) {
      throw new TypeError("insertSystemEvent: a malformed event.");
    }
    await tx.execute(sql`
      INSERT INTO public.system_events (id, actor_id, kind, version, from_version)
      VALUES (${randomUUID()}::uuid, ${event.actorId}::uuid, ${event.kind}, ${event.version},
              ${event.fromVersion}::text)`);
    return;
  }
  if (
    !SYSTEM_EVENT_KINDS.includes(event.kind) ||
    // Checked as data too: a caller in plain JavaScript could send anything.
    ((event.source as unknown) !== undefined &&
      (!["timer", "lease"].includes(event.source as unknown as string) ||
        event.actorId !== null)) ||
    !Number.isSafeInteger(event.files) ||
    event.files < 0 ||
    !Number.isSafeInteger(event.bytes) ||
    event.bytes < 0
  ) {
    throw new TypeError("insertSystemEvent: a malformed event.");
  }
  await tx.execute(sql`
    INSERT INTO public.system_events (id, actor_id, kind, file_count, byte_count, source)
    VALUES (${randomUUID()}::uuid, ${event.actorId}::uuid, ${event.kind}, ${event.files}::integer,
            ${event.bytes}::bigint, ${event.source ?? null}::text)`);
}
