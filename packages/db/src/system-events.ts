/**
 * Changes to the server itself in the change log (T-060a, D-104): an update
 * installed or rolled back, by whom (an account, or the release command on
 * the server's command line) and from which version to which. The table is
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
] as const);
export type SystemEventKind = (typeof SYSTEM_EVENT_KINDS)[number];

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export interface NewSystemEvent {
  /** The system manager, or `null` for the release command on the server. */
  readonly actorId: UserId | null;
  readonly kind: SystemEventKind;
  /** The version running after the change. */
  readonly version: string;
  /** The version before it; `null` for a development build. */
  readonly fromVersion: string | null;
}

/** Appends one row, stamped now by the database. */
export async function insertSystemEvent(tx: Queryable, event: NewSystemEvent): Promise<void> {
  if (
    (event.actorId !== null && !isUserId(event.actorId)) ||
    !SYSTEM_EVENT_KINDS.includes(event.kind) ||
    !VERSION.test(event.version) ||
    (event.fromVersion !== null && !VERSION.test(event.fromVersion))
  ) {
    throw new TypeError("insertSystemEvent: a malformed event.");
  }
  await tx.execute(sql`
    INSERT INTO public.system_events (id, actor_id, kind, version, from_version)
    VALUES (${randomUUID()}::uuid, ${event.actorId}::uuid, ${event.kind}, ${event.version},
            ${event.fromVersion}::text)`);
}
