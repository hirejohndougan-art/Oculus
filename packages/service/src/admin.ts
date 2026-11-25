/**
 * Roles, sites and System settings through the service (T-041, D-072,
 * D-019, D-025, D-036).
 *
 * - **Granting and revoking roles.** System managers grant any built-in role
 *   in any organization, on one site or on every site of it, for the whole
 *   catalog or for one unit's subtree. Site managers grant and revoke roles
 *   below site manager on the sites they manage (`site.people`), one site at
 *   a time; only system managers appoint site managers or grant a role on
 *   every site (D-025: system managers decide which sites each person can
 *   use). The person must be a member of the organization; another
 *   organization's member and an unknown person get the same
 *   `unknown_person`. `siteId` and `scope` must be given, as `null` for
 *   every site or the whole catalog, so leaving one out never widens a
 *   grant. A role change first checks the actor and the person without
 *   locks, then locks both user rows `FOR NO KEY UPDATE` in ID order
 *   (`lockPeopleForRoleChange`; one row when they are the same person) and
 *   checks again: writes in flight that checked the person's roles finish
 *   before it, every write after it sees it, two changes naming the same
 *   two people wait for each other instead of deadlocking, and nobody's row
 *   is locked for a person who isn't a member.
 * - **Sites and System settings** are system managers' only (D-019):
 *   creating and renaming sites, and reading or changing System settings.
 *   Everyone else is refused before anything is read.
 * - **The sites a person sees** (`listMySites`): every site for a system
 *   manager, else the sites they hold a role on, in any organization they
 *   belong to (the site selector, T-045).
 *
 * Every refusal is one of a few fixed messages naming no person, site or
 * record.
 */
import {
  BUILT_IN_ROLES,
  isBuiltInRole,
  isOrganizationId,
  isRecordId,
  isSiteId,
  isUserId,
  issue,
  newRecordId,
  newSiteId,
  permits,
  type Access,
  type BuiltInRole,
  type OrganizationId,
  type RoleGrant,
  type Site,
  type SiteId,
  type UserId,
} from "@oculus/core";
import {
  DEFAULT_ASSIGNMENT_PAGE,
  MAX_ASSIGNMENT_PAGE,
  deleteRoleAssignment,
  insertRoleAssignment,
  insertSite,
  isAssignmentCursor,
  isMember,
  listRoleAssignments,
  lockPeopleForRoleChange,
  lockRecord,
  readRecordPlace,
  readRoleAssignment,
  readSite,
  readSystemSettings as readStoredSettings,
  renameSite as renameStoredSite,
  sitesForPerson,
  writeSystemSettings,
  type Queryable,
  type RoleAssignment,
  type RoleAssignmentPage,
  type SiteChoice,
  type StoredSystemSettings,
} from "@oculus/db";
import { RecordAccess, actorUser, notPermitted, readAccess } from "./access.js";
import type { ServiceContext, ServiceResult } from "./service.js";

/** Runs one operation in its transaction (service.ts's `run`). */
export type Runner = <T>(
  operation: string,
  context: unknown,
  work: (
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
  ) => Promise<ServiceResult<T>>,
) => Promise<ServiceResult<T>>;

/** A role to grant. */
export interface RoleRequest {
  /** A member of the session's organization. */
  readonly userId: string;
  readonly role: BuiltInRole;
  /** One site of the organization, or `null` for every site (system managers only). */
  readonly siteId: string | null;
  /** An archival unit whose subtree it covers, or `null` for the whole catalog. */
  readonly scope: string | null;
}

/** What `myAccess` returns: the actor's own roles, for the screens. */
export interface MyAccess {
  readonly systemManager: boolean;
  readonly grants: readonly RoleGrant[];
}

export interface AdminOperations {
  /** The actor's own system manager flag and grants in the session's organization. */
  myAccess(context: ServiceContext): Promise<ServiceResult<MyAccess>>;
  /** The sites the actor may open (D-019): all for a system manager. */
  listMySites(context: ServiceContext): Promise<ServiceResult<readonly SiteChoice[]>>;
  /**
   * Grants a role (module header for who may). **Internal** (T-048, D-084):
   * no fresh re-entry check and no change-log line; routes and screens use
   * `grantPersonRole` (people.ts). Kept for set-up code and tests.
   */
  grantRole(context: ServiceContext, request: unknown): Promise<ServiceResult<RoleAssignment>>;
  /**
   * Revokes a role assignment by its ID. **Internal** (T-048, D-084): routes
   * use `revokePersonRole` (people.ts), which checks a fresh re-entry and logs.
   */
  revokeRole(
    context: ServiceContext,
    assignmentId: string,
  ): Promise<ServiceResult<{ readonly revoked: string }>>;
  /**
   * The organization's role assignments the actor may manage, oldest first,
   * a page at a time: all for a system manager; for a site manager, those on
   * the sites they manage (not those on every site, which only system
   * managers change). `options.after` is the previous page's `next`;
   * `options.limit` 1 to 1000 (default 200).
   */
  listRoleAssignments(
    context: ServiceContext,
    options?: unknown,
  ): Promise<ServiceResult<RoleAssignmentPage>>;
  /** Makes a site (system managers): in `organizationId`, or the session's organization. */
  createSite(context: ServiceContext, request: unknown): Promise<ServiceResult<Site>>;
  /** Renames a site (system managers). */
  renameSite(context: ServiceContext, request: unknown): Promise<ServiceResult<Site>>;
  /** System settings (system managers). */
  readSystemSettings(context: ServiceContext): Promise<ServiceResult<StoredSystemSettings>>;
  /** Replaces System settings (system managers), from `expectedVersion` (0 before the first change). */
  changeSystemSettings(
    context: ServiceContext,
    settings: unknown,
    options: unknown,
  ): Promise<ServiceResult<StoredSystemSettings>>;
}

function refusal<T>(path: (string | number)[], code: string, message: string): ServiceResult<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

const UNKNOWN_PERSON = "There is no such member of this organization.";
const UNKNOWN_SITE = "There is no such site.";
const UNKNOWN_ASSIGNMENT = "There is no such role assignment.";

/** An own data property, never a getter's result or a proxy trap's. */
export function own(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(input, key);
    return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** Only `keys`, as own string keys of a plain object. */
export function hasOnly(input: unknown, keys: readonly string[]): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  try {
    const proto: unknown = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return false;
    return Reflect.ownKeys(input).every((k) => typeof k === "string" && keys.includes(k));
  } catch {
    return false;
  }
}

/** The sites on which `access` may manage people (every site: `"all"`). */
export function managedSites(access: Access): "all" | ReadonlySet<SiteId> {
  if (access.systemManager) return "all";
  const sites = new Set<SiteId>();
  for (const g of access.grants) {
    if (g.role !== "site_manager" || g.scope !== null) continue;
    if (g.siteId === null) return "all";
    sites.add(g.siteId);
  }
  return sites;
}

/** Whether `access` may grant or revoke this kind of assignment. */
export function mayManage(access: Access, role: BuiltInRole, siteId: SiteId | null): boolean {
  if (access.systemManager) return true;
  // Site managers and roles on every site are system managers' (D-025).
  if (role === "site_manager" || siteId === null) return false;
  return permits(access, "site.people", { on: "site", siteId });
}

interface Who {
  readonly organizationId: OrganizationId;
  readonly actor: string;
}

/** Grants a role in the caller's transaction (`grantRole`'s rules; the people service adds its log). */
export async function grantRoleIn(
  tx: Queryable,
  who: Who,
  request: unknown,
): Promise<ServiceResult<RoleAssignment>> {
  const org = who.organizationId;
  if (!hasOnly(request, ["userId", "role", "siteId", "scope"])) {
    return refusal(
      ["request"],
      "invalid_request",
      "A role grant is userId, role, siteId (or null) and scope (or null).",
    );
  }
  if (!Object.hasOwn(request as object, "siteId") || !Object.hasOwn(request as object, "scope")) {
    return refusal(
      ["request"],
      "invalid_request",
      "Name the site and the scope, each null for every site or the whole catalog.",
    );
  }
  const userId = own(request, "userId");
  const role = own(request, "role");
  const siteId = own(request, "siteId");
  const scope = own(request, "scope");
  if (!isUserId(userId)) {
    return refusal(["userId"], "invalid_id", "A person's ID is a lowercase version 4 UUID.");
  }
  if (!isBuiltInRole(role)) {
    return refusal(["role"], "unknown_role", `A role is one of ${BUILT_IN_ROLES.join(", ")}.`);
  }
  if (siteId !== null && !isSiteId(siteId)) {
    return refusal(["siteId"], "invalid_id", "A site ID is a lowercase version 4 UUID.");
  }
  if (scope !== null && !isRecordId(scope)) {
    return refusal(["scope"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
  }
  // A first look without locks: who the actor is and whether the
  // person is a member, before any row is locked.
  const first = await readAccess(tx, org, who.actor, { lock: false });
  if (!first.ok) return first;
  if (!mayManage(first.value, role, siteId)) return notPermitted();
  if (role === "site_manager" && scope !== null) {
    return refusal(
      ["scope"],
      "whole_catalog_only",
      "A site manager manages a whole site, never one collection.",
    );
  }
  if (!(await isMember(tx, org, userId))) {
    return refusal(["userId"], "unknown_person", UNKNOWN_PERSON);
  }
  // Then both people's rows, in ID order, and the same checks again
  // under the locks: the person's roles change one at a time (after
  // any write in flight that checked them), and the actor's can't
  // change before COMMIT.
  await lockPeopleForRoleChange(tx, [first.userId, userId]);
  const access = await readAccess(tx, org, who.actor);
  if (!access.ok) return access;
  if (!mayManage(access.value, role, siteId)) return notPermitted();
  if (!(await isMember(tx, org, userId))) {
    return refusal(["userId"], "unknown_person", UNKNOWN_PERSON);
  }
  if (siteId !== null && (await readSite(tx, org, siteId)) === undefined) {
    return refusal(["siteId"], "unknown_site", UNKNOWN_SITE);
  }
  if (scope !== null) {
    // The unit must be on the grant's site (any site of the
    // organization for a grant on every site), for everyone, and one
    // the actor may view. Anything else is answered exactly as a unit
    // that doesn't exist, before its kind is looked at, so the answer
    // says nothing about records the actor can't see (D-074 review).
    // The arrangement lock (for scoped grants) and then the unit's
    // row FOR SHARE hold its site and place until COMMIT.
    const unknownScope = refusal<RoleAssignment>(
      ["scope"],
      "unknown_record",
      "The organization has no such record.",
    );
    const checker = new RecordAccess(tx, org, access.value);
    await checker.settle();
    const locked = await lockRecord(tx, org, scope, "share");
    const place = locked === undefined ? undefined : await readRecordPlace(tx, org, scope);
    if (place === undefined) return unknownScope;
    const onSite = siteId === null ? place.siteId !== null : place.siteId === siteId;
    if (!onSite) return unknownScope;
    if (!access.value.systemManager) {
      const hidden = await checker.onRecord(
        {
          kind: place.kind,
          id: scope,
          parentId: place.parentId,
          represents: place.represents,
          siteId: place.siteId,
        },
        [],
      );
      if (hidden) return unknownScope;
    }
    if (place.kind !== "archival_unit") {
      return refusal(
        ["scope"],
        "not_a_unit",
        "A role is granted for a fonds, series, collection, file or item.",
      );
    }
  }
  return insertRoleAssignment(tx, {
    id: newRecordId(),
    organizationId: org,
    userId,
    role,
    siteId: siteId,
    scope: scope,
    grantedBy: access.userId,
  });
}

/** Revokes a role assignment in the caller's transaction (`revokeRole`'s rules); returns the assignment revoked. */
export async function revokeRoleIn(
  tx: Queryable,
  who: Who,
  assignmentId: string,
): Promise<ServiceResult<RoleAssignment>> {
  const org = who.organizationId;
  if (!isRecordId(assignmentId)) {
    return refusal(
      ["assignmentId"],
      "invalid_id",
      "An assignment ID is a lowercase version 4 UUID.",
    );
  }
  const first = await readAccess(tx, org, who.actor, { lock: false });
  if (!first.ok) return first;
  const unknown = refusal<RoleAssignment>(
    ["assignmentId"],
    "unknown_assignment",
    UNKNOWN_ASSIGNMENT,
  );
  const seen = await readRoleAssignment(tx, org, assignmentId);
  // One the actor can't manage is answered as one that doesn't exist.
  if (seen === undefined || !mayManage(first.value, seen.role, seen.siteId)) {
    return unknown;
  }
  // Both people's rows in ID order (grantRole), then the checks again.
  await lockPeopleForRoleChange(tx, [first.userId, seen.userId]);
  const access = await readAccess(tx, org, who.actor);
  if (!access.ok) return access;
  const found = await readRoleAssignment(tx, org, assignmentId);
  if (found?.userId !== seen.userId || !mayManage(access.value, found.role, found.siteId)) {
    return unknown;
  }
  if (!(await deleteRoleAssignment(tx, org, assignmentId))) return unknown;
  return { ok: true, value: found };
}

export function adminOperations(run: Runner): AdminOperations {
  /** Refused unless the actor is an active system manager. */
  async function systemManager(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
  ): Promise<ServiceResult<UserId>> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    if (!permits(access.value, "system.settings", { on: "organization" })) return notPermitted();
    return { ok: true, value: access.userId };
  }

  return {
    async myAccess(context) {
      return run("myAccess", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        return {
          ok: true,
          value: Object.freeze({
            systemManager: access.value.systemManager,
            grants: access.value.grants,
          }),
        };
      });
    },

    async listMySites(context) {
      return run("listMySites", context, async (tx, who) => {
        const userId = actorUser(who.actor);
        if (userId === undefined) return notPermitted();
        return { ok: true, value: await sitesForPerson(tx, userId) };
      });
    },

    async grantRole(context, request) {
      return run("grantRole", context, (tx, who) => grantRoleIn(tx, who, request));
    },

    async revokeRole(context, assignmentId) {
      return run("revokeRole", context, async (tx, who) => {
        const revoked = await revokeRoleIn(tx, who, assignmentId);
        return revoked.ok
          ? { ok: true, value: Object.freeze({ revoked: revoked.value.id }) }
          : revoked;
      });
    },

    async listRoleAssignments(context, options) {
      return run("listRoleAssignments", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        const sites = managedSites(access.value);
        if (sites !== "all" && sites.size === 0) return notPermitted();
        if (options !== undefined && !hasOnly(options, ["after", "limit"])) {
          return refusal(["options"], "invalid_request", "The options are after and limit.");
        }
        const after = own(options, "after") ?? null;
        if (after !== null && !isAssignmentCursor(after)) {
          return refusal(
            ["options", "after"],
            "invalid_cursor",
            "This is not where a page of role assignments ends.",
          );
        }
        const limit = own(options, "limit") ?? DEFAULT_ASSIGNMENT_PAGE;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > MAX_ASSIGNMENT_PAGE
        ) {
          return refusal(
            ["options", "limit"],
            "invalid_limit",
            `A page holds 1 to ${String(MAX_ASSIGNMENT_PAGE)} role assignments.`,
          );
        }
        // A site manager sees the assignments on the sites they manage, and
        // not those on every site: only system managers change those.
        return {
          ok: true,
          value: await listRoleAssignments(tx, who.organizationId, {
            ...(sites === "all" ? {} : { siteIds: [...sites] }),
            // Only what they may revoke (mayManage): a site manager, even on
            // every site, manages neither site managers nor grants on every
            // site.
            ...(access.value.systemManager
              ? {}
              : { siteSpecificOnly: true, exceptRole: "site_manager" as const }),
            after,
            limit,
          }),
        };
      });
    },

    async createSite(context, request) {
      return run("createSite", context, async (tx, who) => {
        const allowed = await systemManager(tx, who);
        if (!allowed.ok) return allowed;
        if (!hasOnly(request, ["organizationId", "name"])) {
          return refusal(
            ["request"],
            "invalid_request",
            "A new site is a name and an organizationId.",
          );
        }
        const organizationId = own(request, "organizationId") ?? who.organizationId;
        if (!isOrganizationId(organizationId)) {
          return refusal(
            ["organizationId"],
            "invalid_organization",
            "An organization ID is a lowercase version 4 UUID.",
          );
        }
        return insertSite(tx, { id: newSiteId(), organizationId, name: own(request, "name") });
      });
    },

    async renameSite(context, request) {
      return run("renameSite", context, async (tx, who) => {
        const allowed = await systemManager(tx, who);
        if (!allowed.ok) return allowed;
        if (!hasOnly(request, ["organizationId", "siteId", "name"])) {
          return refusal(
            ["request"],
            "invalid_request",
            "A rename is siteId, name and (if not the session's) organizationId.",
          );
        }
        const organizationId = own(request, "organizationId") ?? who.organizationId;
        const siteId = own(request, "siteId");
        if (!isOrganizationId(organizationId) || !isSiteId(siteId)) {
          return refusal(["siteId"], "unknown_site", UNKNOWN_SITE);
        }
        return renameStoredSite(tx, organizationId, siteId, own(request, "name"));
      });
    },

    async readSystemSettings(context) {
      return run("readSystemSettings", context, async (tx, who) => {
        const allowed = await systemManager(tx, who);
        if (!allowed.ok) return allowed;
        return readStoredSettings(tx);
      });
    },

    async changeSystemSettings(context, settings, options) {
      return run("changeSystemSettings", context, async (tx, who) => {
        const allowed = await systemManager(tx, who);
        if (!allowed.ok) return allowed;
        if (!hasOnly(options, ["expectedVersion"])) {
          return refusal(["options"], "invalid_request", "The options are expectedVersion only.");
        }
        const expected = own(options, "expectedVersion");
        if (
          typeof expected !== "number" ||
          !Number.isInteger(expected) ||
          expected < 0 ||
          expected >= 2 ** 31 - 1
        ) {
          return refusal(
            ["options", "expectedVersion"],
            "invalid_version",
            "Name the version the change started from: 0 before the first change.",
          );
        }
        return writeSystemSettings(tx, settings, expected, allowed.value);
      });
    },
  };
}
