/**
 * Custom roles in the database (T-041a, D-036, D-121; migration 0057).
 *
 * A custom role is one organization's named set of permissions (core's
 * `CustomRole`, checked by `validateCustomRole` before anything is
 * stored). Grants name it by key (`role_assignments.role`); `loadAccess`
 * reads its permissions with the grant, so a change applies to the next
 * write that reads them. The service locks every holder's user row before
 * changing or deleting a role (as a role grant does), so writes in flight
 * that checked the old permissions finish first.
 *
 * Staff only: the public reader has no privilege on these tables.
 */
import {
  CUSTOM_ROLE_PERMISSIONS,
  isCustomRoleKey,
  isCustomRolePermission,
  isOrganizationId,
  isUserId,
  type CustomRole,
  type OrganizationId,
  type UserId,
} from "@oculus/core";
import { randomUUID } from "node:crypto";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/** What the writer may do (roles.ts): roles made, changed and deleted; their log insert only. */
export const CUSTOM_ROLE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    custom_roles: ["INSERT", "UPDATE", "DELETE"],
    custom_role_events: ["INSERT"],
  });

/** A stored custom role with its version and who changed it last. */
export interface StoredCustomRole extends CustomRole {
  readonly version: number;
  readonly updatedBy: UserId;
  readonly updatedAt: string;
}

interface RoleRow {
  organization_id: string;
  key: string;
  label: string;
  description: string | null;
  permissions: string[];
  version: number;
  updated_by: string;
  updated_at: string;
}

const ROLE_COLUMNS = sql`
  organization_id::text AS organization_id, key, label, description, permissions, version,
  updated_by::text AS updated_by,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

/** A row as a role; `undefined` for one the rules don't know (a role added by hand). */
function roleFromRow(r: RoleRow): StoredCustomRole | undefined {
  if (!isCustomRoleKey(r.key)) return undefined;
  if (!Array.isArray(r.permissions) || !r.permissions.every(isCustomRolePermission)) {
    return undefined;
  }
  const held = r.permissions;
  return Object.freeze({
    organizationId: r.organization_id as OrganizationId,
    key: r.key,
    label: r.label,
    ...(r.description === null ? {} : { description: r.description }),
    permissions: Object.freeze(CUSTOM_ROLE_PERMISSIONS.filter((p) => held.includes(p))),
    version: r.version,
    updatedBy: r.updated_by as UserId,
    updatedAt: r.updated_at,
  });
}

/** The organization's custom roles, by label. */
export async function listCustomRoles(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly StoredCustomRole[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<RoleRow>(sql`
    SELECT ${ROLE_COLUMNS} FROM public.custom_roles
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY label, key
    LIMIT 1000`);
  return Object.freeze(rows.map(roleFromRow).filter((r): r is StoredCustomRole => r !== undefined));
}

/**
 * One custom role, or `undefined`. `lock: "update"` locks its row FOR
 * UPDATE (a change or deletion), so grants being made of it wait.
 */
export async function readCustomRole(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
  options: { readonly lock?: "update" } = {},
): Promise<StoredCustomRole | undefined> {
  if (!isOrganizationId(organizationId) || !isCustomRoleKey(key)) return undefined;
  const rows =
    options.lock === "update"
      ? await db.rows<RoleRow>(sql`
          SELECT ${ROLE_COLUMNS} FROM public.custom_roles
          WHERE organization_id = ${organizationId}::uuid AND key = ${key}
          FOR UPDATE`)
      : await db.rows<RoleRow>(sql`
          SELECT ${ROLE_COLUMNS} FROM public.custom_roles
          WHERE organization_id = ${organizationId}::uuid AND key = ${key}`);
  const row = rows[0];
  return row === undefined ? undefined : roleFromRow(row);
}

/** Stores a new role (version 1); `undefined` if the key is taken. */
export async function insertCustomRole(
  db: Queryable,
  role: CustomRole,
  by: UserId,
): Promise<StoredCustomRole | undefined> {
  const rows = await db.rows<RoleRow>(sql`
    INSERT INTO public.custom_roles
      (organization_id, key, label, description, permissions, updated_by)
    VALUES (${role.organizationId}::uuid, ${role.key}, ${role.label},
            ${role.description ?? null}, ${[...role.permissions]}::text[], ${by}::uuid)
    ON CONFLICT (organization_id, key) DO NOTHING
    RETURNING ${ROLE_COLUMNS}`);
  const row = rows[0];
  return row === undefined ? undefined : roleFromRow(row);
}

/** Replaces a role's label, description and permissions if it is at `expectedVersion`. */
export async function updateCustomRole(
  db: Queryable,
  role: CustomRole,
  expectedVersion: number,
  by: UserId,
): Promise<StoredCustomRole | undefined> {
  const rows = await db.rows<RoleRow>(sql`
    UPDATE public.custom_roles
    SET label = ${role.label}, description = ${role.description ?? null},
        permissions = ${[...role.permissions]}::text[], version = version + 1,
        updated_by = ${by}::uuid, updated_at = clock_timestamp()
    WHERE organization_id = ${role.organizationId}::uuid AND key = ${role.key}
      AND version = ${expectedVersion}
    RETURNING ${ROLE_COLUMNS}`);
  const row = rows[0];
  return row === undefined ? undefined : roleFromRow(row);
}

/** Deletes a role nobody holds any more (the database refuses one still held). */
export async function deleteCustomRole(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
): Promise<boolean> {
  const rows = await db.rows(sql`
    DELETE FROM public.custom_roles
    WHERE organization_id = ${organizationId}::uuid AND key = ${key}
    RETURNING 1`);
  return rows.length > 0;
}

/** How many grants of each of the organization's custom roles there are. */
export async function countHoldings(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<ReadonlyMap<string, number>> {
  if (!isOrganizationId(organizationId)) return new Map();
  const rows = await db.rows<{ role: string; n: string }>(sql`
    SELECT a.role, count(*)::text AS n
    FROM public.role_assignments a
    JOIN public.custom_roles c ON c.organization_id = a.organization_id AND c.key = a.role
    WHERE a.organization_id = ${organizationId}::uuid
    GROUP BY a.role`);
  return new Map(rows.map((r) => [r.role, Number(r.n)]));
}

/** Locks a role's row FOR KEY SHARE (it can't be deleted until COMMIT); `false` if there is none. */
export async function shareCustomRole(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
): Promise<boolean> {
  if (!isOrganizationId(organizationId) || !isCustomRoleKey(key)) return false;
  const rows = await db.rows(sql`
    SELECT 1 FROM public.custom_roles
    WHERE organization_id = ${organizationId}::uuid AND key = ${key}
    FOR KEY SHARE`);
  return rows.length > 0;
}

/** One grant of a role, for "who is affected". */
export interface RoleHolding {
  readonly assignmentId: string;
  readonly userId: UserId;
  readonly displayName: string;
  readonly siteId: string | null;
  readonly scope: string | null;
}

/** Every grant of `role` in the organization (at most `limit`, oldest first). */
export async function holdingsOfRole(
  db: Queryable,
  organizationId: OrganizationId,
  role: string,
  limit = 10_000,
): Promise<readonly RoleHolding[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{
    id: string;
    user_id: string;
    display_name: string;
    site_id: string | null;
    scope: string | null;
  }>(sql`
    SELECT a.id::text AS id, a.user_id::text AS user_id, u.display_name,
           a.site_id::text AS site_id, a.scope_record_id::text AS scope
    FROM public.role_assignments a
    JOIN public.users u ON u.id = a.user_id
    WHERE a.organization_id = ${organizationId}::uuid AND a.role = ${role}
    ORDER BY a.granted_at, a.id
    LIMIT ${limit}`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        assignmentId: r.id,
        userId: r.user_id as UserId,
        displayName: r.display_name,
        siteId: r.site_id,
        scope: r.scope,
      }),
    ),
  );
}

/** One entry of the custom roles' change log. */
export interface CustomRoleEvent {
  readonly organizationId: OrganizationId;
  readonly actorId: UserId;
  readonly kind: "role_created" | "role_changed" | "role_deleted";
  readonly roleKey: string;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly grants: number;
  readonly movedTo?: string;
}

/** Adds an entry to the change log (insert only). */
export async function recordCustomRoleEvent(db: Queryable, event: CustomRoleEvent): Promise<void> {
  if (!isOrganizationId(event.organizationId) || !isUserId(event.actorId)) {
    throw new TypeError("Not an organization or person ID.");
  }
  await db.execute(sql`
    INSERT INTO public.custom_role_events
      (organization_id, id, actor_id, kind, role_key, label, permissions, grants, moved_to)
    VALUES (${event.organizationId}::uuid, ${randomUUID()}::uuid, ${event.actorId}::uuid,
            ${event.kind}, ${event.roleKey}, ${event.label}, ${[...event.permissions]}::text[],
            ${event.grants}, ${event.movedTo ?? null})`);
}

/** A change log entry as read. */
export interface StoredCustomRoleEvent extends CustomRoleEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorName: string;
}

/** The organization's custom role changes, newest first. */
export async function listCustomRoleEvents(
  db: Queryable,
  organizationId: OrganizationId,
  limit = 100,
): Promise<readonly StoredCustomRoleEvent[]> {
  if (!isOrganizationId(organizationId)) return [];
  const rows = await db.rows<{
    id: string;
    occurred_at: string;
    actor_id: string;
    actor_name: string;
    kind: CustomRoleEvent["kind"];
    role_key: string;
    label: string;
    permissions: string[];
    grants: number;
    moved_to: string | null;
  }>(sql`
    SELECT e.id::text AS id,
           to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           e.actor_id::text AS actor_id, u.display_name AS actor_name, e.kind, e.role_key,
           e.label, e.permissions, e.grants, e.moved_to
    FROM public.custom_role_events e
    JOIN public.users u ON u.id = e.actor_id
    WHERE e.organization_id = ${organizationId}::uuid
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        occurredAt: r.occurred_at,
        organizationId,
        actorId: r.actor_id as UserId,
        actorName: r.actor_name,
        kind: r.kind,
        roleKey: r.role_key,
        label: r.label,
        permissions: Object.freeze([...r.permissions]),
        grants: r.grants,
        ...(r.moved_to === null ? {} : { movedTo: r.moved_to }),
      }),
    ),
  );
}
