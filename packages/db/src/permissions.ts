/**
 * Sites, role assignments, System settings, and what one person may do in
 * one organization, read under locks (T-041, D-072, migration 0013).
 *
 * The rules are core's (`permissions.ts`); this module reads what they need
 * in the caller's transaction, so a check stays true until COMMIT:
 *
 * - **`loadAccess` locks the person's user row `FOR SHARE` first**, then
 *   reads (a new statement, so a new snapshot under Read Committed) whether
 *   they are an active system manager and their grants in the organization.
 *   Every change of a person's roles, and disabling them, takes the same row
 *   `FOR NO KEY UPDATE` (`lockPersonForRoleChange`, or the UPDATE's own
 *   lock) before it changes anything. So a revocation either commits before
 *   a write reads the grants, and the write sees it, or waits until the
 *   write in flight commits: never a write checked against a grant that was
 *   already gone. Writes by the same person don't wait for each other
 *   (`FOR SHARE` locks share).
 * - **`unitsHolding`** gives the units whose subtree holds a record (the
 *   record itself if it is a unit, its parent and every unit above; for a
 *   digital asset, those of the record it represents). It reads the
 *   arrangement as it is now, so the caller takes the organization's
 *   arrangement lock first (D-065): no unit can move between the check and
 *   COMMIT. Intermediate digital assets are locked `FOR SHARE` so what they
 *   represent can't change either. `placesHolding` gives the same for many
 *   records in one read (S-028).
 *
 * Nothing here checks who may call it: the service does (packages/service).
 */
import {
  DEFAULT_SYSTEM_SETTINGS,
  CUSTOM_ROLE_PERMISSIONS,
  isBuiltInRole,
  isCustomRoleKey,
  isOrganizationId,
  isRecordId,
  isSiteId,
  isUserId,
  issue,
  validateSite,
  validateSystemSettings,
  type Access,
  type BuiltInRole,
  type OrganizationId,
  type RecordId,
  type RoleGrant,
  type Site,
  type SiteId,
  type SystemSettings,
  type UserId,
  type Validated,
} from "@oculus/core";
import type { RecordPlace } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * What the writer role needs on this module's tables, beyond SELECT on
 * every table. Part of `WRITER_PRIVILEGES` (roles.ts, D-067). Sites are
 * renamed (UPDATE) but never deleted; role assignments are inserted and
 * deleted, never updated; the System settings row is inserted once and
 * updated.
 */
export const PERMISSION_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    sites: Object.freeze(["INSERT", "UPDATE"]),
    role_assignments: Object.freeze(["INSERT", "DELETE"]),
    system_settings: Object.freeze(["INSERT", "UPDATE"]),
  });

/** How deep `unitsHolding` follows digital assets that represent digital assets. */
const MAX_ASSET_HOPS = 8;

// ---------------------------------------------------------------------------
// Access

/**
 * The person's access in the organization, read under a `FOR SHARE` lock on
 * their user row (module header), or `undefined` when there is no such user
 * or the account is disabled. A system manager who isn't a member has no
 * grants but `systemManager: true`.
 */
export async function loadAccess(
  db: Queryable,
  organizationId: OrganizationId,
  userId: UserId,
  options: { readonly lock?: boolean } = {},
): Promise<Access | undefined> {
  if (!isOrganizationId(organizationId) || !isUserId(userId)) return undefined;
  // `lock: false` reads without locking, for a first look that is read again
  // under a lock before anything is changed (a role change locks the
  // people's rows FOR NO KEY UPDATE itself, so it must not hold FOR SHARE on
  // them first: two such changes would then deadlock on the upgrade).
  const [user] =
    options.lock === false
      ? await db.rows<{ system_admin: boolean; active: boolean }>(sql`
          SELECT system_admin, disabled_at IS NULL AS active FROM public.users
          WHERE id = ${userId}::uuid`)
      : await db.rows<{ system_admin: boolean; active: boolean }>(sql`
          SELECT system_admin, disabled_at IS NULL AS active FROM public.users
          WHERE id = ${userId}::uuid
          FOR SHARE`);
  if (!user?.active) return undefined;
  // A custom role's permissions are read with its grant (T-041a, D-121): a
  // change to the role locks its holders' rows first, so this read and that
  // change don't overlap.
  const rows = await db.rows<{
    role: string;
    site_id: string | null;
    scope: string | null;
    custom: string[] | null;
  }>(sql`
    SELECT a.role, a.site_id::text AS site_id, a.scope_record_id::text AS scope,
           c.permissions AS custom
    FROM public.role_assignments a
    JOIN public.organization_members m
      ON m.organization_id = a.organization_id AND m.user_id = a.user_id
    LEFT JOIN public.custom_roles c
      ON c.organization_id = a.organization_id AND c.key = a.role
    WHERE a.organization_id = ${organizationId}::uuid AND a.user_id = ${userId}::uuid
    ORDER BY a.id`);
  const grants: RoleGrant[] = [];
  for (const row of rows) {
    if (row.site_id !== null && !isSiteId(row.site_id)) continue;
    if (row.scope !== null && !isRecordId(row.scope)) continue;
    if (isBuiltInRole(row.role)) {
      grants.push(Object.freeze({ role: row.role, siteId: row.site_id, scope: row.scope }));
      continue;
    }
    // A custom role's own permissions, and only those a custom role may
    // hold; a row the rules don't know (a role added by hand) grants nothing.
    if (!isCustomRoleKey(row.role) || row.custom === null) continue;
    const permissions = CUSTOM_ROLE_PERMISSIONS.filter((p) => row.custom?.includes(p));
    grants.push(
      Object.freeze({
        role: row.role,
        siteId: row.site_id,
        scope: row.scope,
        permissions: Object.freeze(permissions),
      }),
    );
  }
  return Object.freeze({
    organizationId,
    systemManager: user.system_admin,
    grants: Object.freeze(grants),
  });
}

/**
 * Locks a person's user row `FOR NO KEY UPDATE` before their roles change,
 * so writes in flight that checked their old roles finish first and later
 * ones read the new roles (module header). `false` if there is no such user.
 */
export async function lockPersonForRoleChange(db: Queryable, userId: UserId): Promise<boolean> {
  return lockPeopleForRoleChange(db, [userId]);
}

/**
 * Locks several people's user rows `FOR NO KEY UPDATE`, one statement per
 * row in ID order, so two role changes naming the same two people (A grants
 * to B while B grants to A) wait for each other instead of deadlocking.
 * Each person is locked once, however often named. `false` if any of them
 * doesn't exist (the others stay locked until the transaction ends).
 */
export async function lockPeopleForRoleChange(
  db: Queryable,
  userIds: readonly UserId[],
): Promise<boolean> {
  if (!userIds.every((id) => isUserId(id))) return false;
  const ordered = [...new Set(userIds)].sort();
  let all = true;
  for (const id of ordered) {
    const rows = await db.rows(sql`
      SELECT 1 FROM public.users WHERE id = ${id}::uuid FOR NO KEY UPDATE`);
    if (rows.length === 0) all = false;
  }
  return all;
}

/** Where a record sits, as far as permissions go. */
export interface RecordPosition {
  readonly kind: string;
  /** The record itself, when it is stored (a unit's own grants cover it). */
  readonly id?: RecordId;
  readonly parentId?: RecordId | null;
  readonly represents?: RecordId | null;
  /** Its home site (D-074): the record's own, or the site a new one is made in. */
  readonly siteId?: SiteId | null;
}

/**
 * The sites that accepted the record from its home site, for the record's
 * own permission checks (D-072's hook). Always empty, by D-094: shares
 * (T-041b, `shares.ts`) are seen through their own read-only view and
 * never widen `records.view` on the record itself, so `onRecord` and
 * `allowsUnlocked` stay as they are. It stays so every check still asks.
 */
export function sitesSharedInto(
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<ReadonlySet<SiteId>> {
  const none: ReadonlySet<SiteId> = new Set<SiteId>();
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return Promise.resolve(none);
  return Promise.resolve(none);
}

/**
 * The units whose subtree holds a record at `position` (module header):
 * for a unit, itself (if `id` is given) and its parent and every unit
 * above; for a digital asset, those of what it represents; for any other
 * kind, none. A parent or represented record that doesn't exist in the
 * organization (or isn't a unit, for a parent) adds nothing. Take the
 * organization's arrangement lock first.
 */
export async function unitsHolding(
  db: Queryable,
  organizationId: OrganizationId,
  position: RecordPosition,
): Promise<ReadonlySet<RecordId>> {
  const units = new Set<RecordId>();
  if (!isOrganizationId(organizationId)) return units;
  let start: RecordId | null | undefined;
  if (position.kind === "archival_unit") {
    if (position.id !== undefined) units.add(position.id);
    start = position.parentId;
  } else if (position.kind === "digital_asset") {
    let target = position.represents;
    for (let hop = 0; hop < MAX_ASSET_HOPS && target != null && isRecordId(target); hop += 1) {
      const [row] = await db.rows<{ kind: string; represents: string | null }>(sql`
        SELECT kind, represents_id::text AS represents FROM public.records
        WHERE organization_id = ${organizationId}::uuid AND id = ${target}::uuid
        FOR SHARE`);
      if (row === undefined) return units;
      if (row.kind === "archival_unit") break;
      if (row.kind !== "digital_asset") return units;
      target = row.represents as RecordId | null;
    }
    start = target;
    // A chain of assets longer than MAX_ASSET_HOPS, or one ending nowhere.
    if (start == null) return units;
    const [kind] = await db.rows<{ kind: string }>(sql`
      SELECT kind FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ${start}::uuid`);
    if (kind?.kind !== "archival_unit") return units;
  } else {
    return units;
  }
  if (start == null || !isRecordId(start)) return units;
  // The unit and its ancestors, within the organization (at most 64 deep,
  // as the arrangement guard allows; the bound also stops a loop written by
  // hand).
  const rows = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE up (id, parent_id, depth) AS (
      SELECT r.id, r.parent_id, 1 FROM public.records r
      WHERE r.organization_id = ${organizationId}::uuid AND r.id = ${start}::uuid
        AND r.kind = 'archival_unit'
      UNION ALL
      SELECT r.id, r.parent_id, up.depth + 1 FROM public.records r
      JOIN up ON r.id = up.parent_id
      WHERE r.organization_id = ${organizationId}::uuid AND r.kind = 'archival_unit'
        AND up.depth < 70
    )
    SELECT id::text AS id FROM up`);
  for (const row of rows) units.add(row.id as RecordId);
  return units;
}

/** Where a record sits, and with `units`, the units holding it, from `placesHolding`. */
export interface PlaceHolding {
  readonly place: RecordPlace;
  /** As `unitsHolding` gives them for the record's position; absent without `units`. */
  readonly units?: ReadonlySet<RecordId>;
}

interface UpRow {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly parent_id: string | null;
  readonly level: string | null;
  readonly represents_id: string | null;
  readonly site_id: string | null;
}

/**
 * For many records at once (S-028): each one's place, as `readRecordPlace`
 * reads it, and with `units: true` the units holding it, exactly as
 * `unitsHolding` gives them for that place (the record itself for a unit),
 * taking the same `FOR SHARE` locks on the records a digital asset's chain
 * passes through (in ID order, in one statement), unless `lock: false`
 * (for a first look before any row lock, checked again under it). Records that don't
 * exist in the organization (or IDs that aren't record IDs) are left out.
 * One statement reads every record above them all (parents of units,
 * represented records of digital assets); the rest is worked out in
 * memory. With `units`, take the arrangement lock first, as for
 * `unitsHolding`.
 */
export async function placesHolding(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
  options: { readonly units: boolean; readonly lock?: boolean },
): Promise<ReadonlyMap<RecordId, PlaceHolding>> {
  const found = new Map<RecordId, PlaceHolding>();
  if (!isOrganizationId(organizationId)) return found;
  const wanted = [...new Set(ids.filter((id) => isRecordId(id)))].sort();
  if (wanted.length === 0) return found;
  const rows = options.units
    ? await db.rows<UpRow>(sql`
        WITH RECURSIVE up(id, kind, parent_id, represents_id) AS (
          SELECT r.id, r.kind, r.parent_id, r.represents_id FROM public.records r
          WHERE r.organization_id = ${organizationId}::uuid AND r.id = ANY(${wanted}::uuid[])
          UNION
          SELECT r.id, r.kind, r.parent_id, r.represents_id FROM up
          JOIN public.records r ON r.organization_id = ${organizationId}::uuid
            AND r.id = CASE up.kind
                         WHEN 'archival_unit' THEN up.parent_id
                         WHEN 'digital_asset' THEN up.represents_id
                       END
        )
        SELECT r.id::text AS id, r.version, r.kind, r.parent_id::text AS parent_id, r.level,
               r.represents_id::text AS represents_id, r.site_id::text AS site_id
        FROM public.records r
        WHERE r.organization_id = ${organizationId}::uuid AND r.id IN (SELECT id FROM up)`)
    : await db.rows<UpRow>(sql`
        SELECT r.id::text AS id, r.version, r.kind, r.parent_id::text AS parent_id, r.level,
               r.represents_id::text AS represents_id, r.site_id::text AS site_id
        FROM public.records r
        WHERE r.organization_id = ${organizationId}::uuid AND r.id = ANY(${wanted}::uuid[])`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const locks = new Set<RecordId>();
  for (const id of wanted) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const place: RecordPlace = Object.freeze({
      version: row.version,
      kind: row.kind,
      parentId: row.parent_id as RecordId | null,
      level: row.level,
      represents: row.represents_id as RecordId | null,
      siteId: row.site_id as SiteId | null,
    });
    if (!options.units) {
      found.set(id, Object.freeze({ place }));
      continue;
    }
    const units = unitsFrom(byId, id, place, locks);
    found.set(id, Object.freeze({ place, units }));
  }
  if (locks.size > 0 && options.lock !== false) {
    await db.rows(sql`
      SELECT id FROM public.records
      WHERE organization_id = ${organizationId}::uuid AND id = ANY(${[...locks].sort()}::uuid[])
      ORDER BY id
      FOR SHARE`);
  }
  return found;
}

/**
 * `unitsHolding` for a stored record at `place`, over rows already read
 * (`placesHolding`), step for step; the records its digital asset loop
 * would lock are added to `locks`.
 */
function unitsFrom(
  byId: ReadonlyMap<string, UpRow>,
  id: RecordId,
  place: RecordPlace,
  locks: Set<RecordId>,
): ReadonlySet<RecordId> {
  const units = new Set<RecordId>();
  let start: RecordId | null | undefined;
  if (place.kind === "archival_unit") {
    units.add(id);
    start = place.parentId;
  } else if (place.kind === "digital_asset") {
    let target = place.represents;
    for (let hop = 0; hop < MAX_ASSET_HOPS && target != null && isRecordId(target); hop += 1) {
      locks.add(target);
      const row = byId.get(target);
      if (row === undefined) return units;
      if (row.kind === "archival_unit") break;
      if (row.kind !== "digital_asset") return units;
      target = row.represents_id as RecordId | null;
    }
    start = target;
    if (start == null) return units;
    if (byId.get(start)?.kind !== "archival_unit") return units;
  } else {
    return units;
  }
  if (start == null || !isRecordId(start)) return units;
  // As unitsHolding's walk: units only, at most 70 rows.
  let at: RecordId | null = start;
  for (let depth = 1; at !== null && depth <= 70; depth += 1) {
    const row = byId.get(at);
    if (row?.kind !== "archival_unit") break;
    units.add(at);
    at = row.parent_id as RecordId | null;
  }
  return units;
}

// ---------------------------------------------------------------------------
// Sites

function refused<T>(path: (string | number)[], code: string, message: string): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** Stores a new site (checked by core's `validateSite`). The organization must exist. */
export async function insertSite(db: Queryable, input: unknown): Promise<Validated<Site>> {
  const organizationId: unknown =
    typeof input === "object" && input !== null
      ? (Object.getOwnPropertyDescriptor(input, "organizationId")?.value as unknown)
      : undefined;
  const known = isOrganizationId(organizationId)
    ? await db.rows<{ name: string }>(sql`
        SELECT name FROM public.organizations WHERE id = ${organizationId}::uuid FOR KEY SHARE`)
    : [];
  const owner = known[0];
  const valid = validateSite(
    input,
    owner === undefined || !isOrganizationId(organizationId)
      ? []
      : [{ id: organizationId, name: owner.name }],
  );
  if (!valid.ok) return valid;
  const { id, name } = valid.value;
  await db.execute(sql`
    INSERT INTO public.sites (organization_id, id, name)
    VALUES (${valid.value.organizationId}::uuid, ${id}::uuid, ${name})`);
  return valid;
}

/** The organization's site, or `undefined`. */
export async function readSite(
  db: Queryable,
  organizationId: OrganizationId,
  siteId: SiteId,
): Promise<Site | undefined> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId)) return undefined;
  const [row] = await db.rows<{ name: string }>(sql`
    SELECT name FROM public.sites
    WHERE organization_id = ${organizationId}::uuid AND id = ${siteId}::uuid`);
  return row === undefined
    ? undefined
    : Object.freeze({ id: siteId, organizationId, name: row.name });
}

/** Renames the organization's site (core's name rule); `unknown_site` if there is none. */
export async function renameSite(
  db: Queryable,
  organizationId: OrganizationId,
  siteId: SiteId,
  name: unknown,
): Promise<Validated<Site>> {
  const valid = validateSite({ id: siteId, organizationId, name }, [
    { id: organizationId, name: "x" },
  ]);
  if (!valid.ok) return valid;
  const rows = await db.rows(sql`
    UPDATE public.sites SET name = ${valid.value.name}
    WHERE organization_id = ${organizationId}::uuid AND id = ${siteId}::uuid
    RETURNING 1`);
  if (rows.length === 0) return refused(["siteId"], "unknown_site", "There is no such site.");
  return valid;
}

/** A site as the site selector lists it (D-019, T-045). */
export interface SiteChoice {
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly siteId: SiteId;
  readonly siteName: string;
}

/**
 * The sites a person may open after signing in (D-019): every site of the
 * install for an active system manager; otherwise the sites of their
 * organizations they hold a role on (a role on every site of an
 * organization counts for each). None for an unknown or disabled account.
 * Ordered by organization name, site name, then ID.
 */
export async function sitesForPerson(
  db: Queryable,
  userId: UserId,
): Promise<readonly SiteChoice[]> {
  if (!isUserId(userId)) return [];
  const rows = await db.rows<{
    organization_id: string;
    organization_name: string;
    site_id: string;
    site_name: string;
  }>(sql`
    WITH person AS (
      SELECT system_admin FROM public.users
      WHERE id = ${userId}::uuid AND disabled_at IS NULL
    )
    SELECT s.organization_id::text AS organization_id, o.name AS organization_name,
           s.id::text AS site_id, s.name AS site_name
    FROM public.sites s
    JOIN public.organizations o ON o.id = s.organization_id
    WHERE EXISTS (SELECT 1 FROM person WHERE system_admin)
       OR (EXISTS (SELECT 1 FROM person) AND EXISTS (
            SELECT 1 FROM public.role_assignments a
            JOIN public.organization_members m
              ON m.organization_id = a.organization_id AND m.user_id = a.user_id
            WHERE a.organization_id = s.organization_id AND a.user_id = ${userId}::uuid
              AND (a.site_id IS NULL OR a.site_id = s.id)))
    ORDER BY o.name, s.name, s.id`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        organizationId: r.organization_id as OrganizationId,
        organizationName: r.organization_name,
        siteId: r.site_id as SiteId,
        siteName: r.site_name,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Role assignments

/** One stored role assignment. */
export interface RoleAssignment extends RoleGrant {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly grantedBy: UserId;
  readonly grantedAt: string;
}

export interface NewRoleAssignment {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  /** A built-in role or one of the organization's custom roles (T-041a). */
  readonly role: string;
  readonly siteId: SiteId | null;
  readonly scope: RecordId | null;
  readonly grantedBy: UserId;
}

/**
 * Stores a role assignment. The caller has checked who may grant it and
 * that the member, site and unit exist (the database refuses otherwise).
 * The same role, site and scope held already: `already_granted`.
 */
export async function insertRoleAssignment(
  db: Queryable,
  a: NewRoleAssignment,
): Promise<Validated<RoleAssignment>> {
  const rows = await db.rows<{ granted_at: string }>(sql`
    INSERT INTO public.role_assignments
      (organization_id, id, user_id, role, site_id, scope_record_id, granted_by)
    VALUES (${a.organizationId}::uuid, ${a.id}::uuid, ${a.userId}::uuid, ${a.role},
            ${a.siteId}::uuid, ${a.scope}::uuid, ${a.grantedBy}::uuid)
    ON CONFLICT ON CONSTRAINT role_assignments_once DO NOTHING
    RETURNING to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at`);
  const row = rows[0];
  if (row === undefined) {
    return refused([], "already_granted", "This person already holds this role there.");
  }
  return { ok: true, value: Object.freeze({ ...a, grantedAt: row.granted_at }) };
}

const ASSIGNMENT_COLUMNS = sql`
  id::text AS id, organization_id::text AS organization_id, user_id::text AS user_id, role,
  site_id::text AS site_id, scope_record_id::text AS scope, granted_by::text AS granted_by,
  to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at`;

interface AssignmentRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  site_id: string | null;
  scope: string | null;
  granted_by: string;
  granted_at: string;
}

function assignmentFromRow(r: AssignmentRow): RoleAssignment | undefined {
  if (!isBuiltInRole(r.role) && !isCustomRoleKey(r.role)) return undefined;
  return Object.freeze({
    id: r.id,
    organizationId: r.organization_id as OrganizationId,
    userId: r.user_id as UserId,
    role: r.role,
    siteId: r.site_id as SiteId | null,
    scope: r.scope as RecordId | null,
    grantedBy: r.granted_by as UserId,
    grantedAt: r.granted_at,
  });
}

/** The organization's role assignment with this ID, or `undefined`. */
export async function readRoleAssignment(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
): Promise<RoleAssignment | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(id)) return undefined;
  const [row] = await db.rows<AssignmentRow>(sql`
    SELECT ${ASSIGNMENT_COLUMNS} FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid`);
  return row === undefined ? undefined : assignmentFromRow(row);
}

/** Deletes the organization's role assignment; `false` if there was none. */
export async function deleteRoleAssignment(
  db: Queryable,
  organizationId: OrganizationId,
  id: string,
): Promise<boolean> {
  if (!isOrganizationId(organizationId) || !isRecordId(id)) return false;
  const rows = await db.rows(sql`
    DELETE FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid
    RETURNING 1`);
  return rows.length > 0;
}

/** The most role assignments one page holds, and the default. */
export const MAX_ASSIGNMENT_PAGE = 1000;
export const DEFAULT_ASSIGNMENT_PAGE = 200;

/** A page of role assignments, and where the next one starts (`null`: none). */
export interface RoleAssignmentPage {
  readonly assignments: readonly RoleAssignment[];
  readonly next: string | null;
}

/** The position after a row, as `next` gives it: granted_at to the microsecond, then the ID. */
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** Whether `value` is a cursor `listRoleAssignments` could have given. */
export function isAssignmentCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR.test(value);
}

/**
 * The organization's role assignments, oldest first, one page at a time:
 * all of them, or (with `siteIds`) only those on these sites, never those
 * on every site. `after` is the previous page's `next`; `limit` is 1 to
 * `MAX_ASSIGNMENT_PAGE` (`DEFAULT_ASSIGNMENT_PAGE`). An invalid cursor or
 * limit reads as an empty last page.
 */
export async function listRoleAssignments(
  db: Queryable,
  organizationId: OrganizationId,
  options: {
    readonly siteIds?: readonly SiteId[];
    /** Leave out grants on every site (`site_id` NULL). */
    readonly siteSpecificOnly?: boolean;
    /** Leave out grants of this role. */
    readonly exceptRole?: BuiltInRole;
    readonly after?: string | null;
    readonly limit?: number;
  } = {},
): Promise<RoleAssignmentPage> {
  const empty: RoleAssignmentPage = Object.freeze({ assignments: Object.freeze([]), next: null });
  if (!isOrganizationId(organizationId)) return empty;
  const limit = options.limit ?? DEFAULT_ASSIGNMENT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ASSIGNMENT_PAGE) return empty;
  const after = options.after ?? null;
  const cursor = after === null ? null : CURSOR.exec(after);
  if (after !== null && cursor === null) return empty;
  const sites = options.siteIds?.filter((s) => isSiteId(s)) ?? null;
  const rows = await db.rows<AssignmentRow & { position: string }>(sql`
    SELECT ${ASSIGNMENT_COLUMNS},
      to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '_' || id::text
        AS position
    FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid
      AND (${sites === null}::boolean OR site_id = ANY (${sites ?? []}::uuid[]))
      AND (${options.siteSpecificOnly !== true}::boolean OR site_id IS NOT NULL)
      AND (${options.exceptRole ?? null}::text IS NULL OR role <> ${options.exceptRole ?? null}::text)
      AND (${cursor === null}::boolean
           OR (granted_at, id) > ((${cursor?.[1] ?? null}::timestamp AT TIME ZONE 'UTC'),
                                  ${cursor?.[2] ?? null}::uuid))
    ORDER BY granted_at, id
    LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return Object.freeze({
    assignments: Object.freeze(
      page.map(assignmentFromRow).filter((a): a is RoleAssignment => a !== undefined),
    ),
    next: rows.length > limit && last !== undefined ? last.position : null,
  });
}

/** Whether the person is a member of the organization. */
export async function isMember(
  db: Queryable,
  organizationId: OrganizationId,
  userId: UserId,
): Promise<boolean> {
  if (!isOrganizationId(organizationId) || !isUserId(userId)) return false;
  const rows = await db.rows(sql`
    SELECT 1 FROM public.organization_members
    WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid`);
  return rows.length > 0;
}

/** How many role assignments are scoped to the unit. */
export async function grantsScopedTo(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  options: { readonly onSite?: SiteId } = {},
): Promise<number> {
  const site = options.onSite ?? null;
  const [row] = await db.rows<{ n: number }>(sql`
    SELECT count(*)::integer AS n FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid AND scope_record_id = ${recordId}::uuid
      AND (${site === null}::boolean OR site_id = ${site}::uuid)`);
  return row?.n ?? 0;
}

/** Whether any unit is filed under the record, or any digital asset represents it. */
export async function hasRecordsBelow(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<boolean> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return false;
  const rows = await db.rows(sql`
    SELECT 1 FROM public.records
    WHERE organization_id = ${organizationId}::uuid
      AND (parent_id = ${recordId}::uuid OR represents_id = ${recordId}::uuid)
    LIMIT 1`);
  return rows.length > 0;
}

/**
 * Up to 1,000 units filed directly under `unitId` whose home site isn't
 * `siteId` (`null`: any child on a site at all): the only children a person
 * who may edit the unit may not see (a system manager filed them there;
 * a scoped grant covering the unit covers its subtree), for T-042's
 * hidden-children check.
 */
export async function childrenOffSite(
  db: Queryable,
  organizationId: OrganizationId,
  unitId: RecordId,
  siteId: SiteId | null,
): Promise<RecordId[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(unitId)) return [];
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND parent_id = ${unitId}::uuid
      AND site_id IS DISTINCT FROM ${siteId}::uuid
    ORDER BY id LIMIT 1000`);
  return rows.map((r) => r.id as RecordId);
}

// ---------------------------------------------------------------------------
// System settings

/** The System settings as stored, or the defaults at version 0 before any change. */
export interface StoredSystemSettings {
  readonly settings: SystemSettings;
  /** 0 until first changed. Pass it as `expectedVersion` with the next change. */
  readonly version: number;
}

/**
 * The System settings, locked `FOR UPDATE` with `lock` (for a change).
 * A stored document core no longer accepts reads as `unreadable_settings`.
 */
export async function readSystemSettings(
  db: Queryable,
  options: { readonly lock?: boolean } = {},
): Promise<Validated<StoredSystemSettings>> {
  const rows =
    options.lock === true
      ? await db.rows<{ settings: unknown; version: number }>(sql`
          SELECT settings, version FROM public.system_settings FOR UPDATE`)
      : await db.rows<{ settings: unknown; version: number }>(sql`
          SELECT settings, version FROM public.system_settings`);
  const row = rows[0];
  if (row === undefined) {
    return { ok: true, value: Object.freeze({ settings: DEFAULT_SYSTEM_SETTINGS, version: 0 }) };
  }
  const valid = validateSystemSettings(row.settings);
  if (!valid.ok) {
    return refused(
      [],
      "unreadable_settings",
      "The stored System settings are not valid; they need repair.",
    );
  }
  return { ok: true, value: Object.freeze({ settings: valid.value, version: row.version }) };
}

/**
 * Replaces the System settings (checked by core) if they are still at
 * `expectedVersion` (`version_conflict` otherwise); the caller checked that
 * `changedBy` is a system manager.
 */
export async function writeSystemSettings(
  db: Queryable,
  input: unknown,
  expectedVersion: number,
  changedBy: UserId,
): Promise<Validated<StoredSystemSettings>> {
  const valid = validateSystemSettings(input);
  if (!valid.ok) return valid;
  const current = await readSystemSettings(db, { lock: true });
  if (current.ok && current.value.version !== expectedVersion) {
    return refused(
      ["expectedVersion"],
      "version_conflict",
      `The System settings were changed by someone else since version ${String(expectedVersion)}; they are now at version ${String(current.value.version)}. Read them again.`,
    );
  }
  const json = JSON.stringify(valid.value);
  const [row] =
    expectedVersion === 0
      ? await db.rows<{ version: number }>(sql`
          INSERT INTO public.system_settings (settings, version, changed_by)
          VALUES (${json}::jsonb, 1, ${changedBy}::uuid)
          ON CONFLICT (singleton) DO NOTHING
          RETURNING version`)
      : await db.rows<{ version: number }>(sql`
          UPDATE public.system_settings
          SET settings = ${json}::jsonb, version = version + 1, changed_by = ${changedBy}::uuid,
              changed_at = now()
          WHERE version = ${expectedVersion}
          RETURNING version`);
  if (row === undefined) {
    return refused(
      ["expectedVersion"],
      "version_conflict",
      "The System settings were changed by someone else meanwhile. Read them again.",
    );
  }
  return { ok: true, value: Object.freeze({ settings: valid.value, version: row.version }) };
}
