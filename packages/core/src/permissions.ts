/**
 * Roles and permissions (T-041, D-025, D-036, D-072).
 *
 * **The service checks permissions, never role names** (D-036). A role is a
 * named set of permissions from the fixed list below: a built-in role
 * (`ROLE_PERMISSIONS`) or an organization's custom role (T-041a, D-121:
 * `CustomRole`, made by system managers from `CUSTOM_ROLE_PERMISSIONS`
 * only). A grant carries the permissions its role held when it was read
 * (`RoleGrant.permissions`), so built-in and custom roles are checked
 * alike. Two levels sit above the roles (D-025):
 * - **system managers** (`users.system_admin`) can do everything in every
 *   organization, and are the only ones with the system permissions
 *   (`SYSTEM_PERMISSIONS`: System settings, sites, users, plugins). No role
 *   can ever hold a system permission, built-in or custom;
 * - **site managers** have full control of the sites assigned to them: the
 *   organization's catalog, the site's settings and design, and the site's
 *   people (roles below site manager on that site).
 *
 * **Where a role is granted** (a `RoleGrant`): for one site of an
 * organization, or for every site of it (`siteId: null`); and for the whole
 * catalog (`scope: null`) or for one archival unit and everything below it
 * (`scope`: a fonds, series, collection, file or item). Catalog
 * permissions reach the records of the grant's site (below); organization
 * permissions come from a whole-catalog grant on any of its sites; site
 * permissions (`SITE_PERMISSIONS`) count only on that site.
 *
 * **Items belong to a site** (D-074). Every catalog record has a home site
 * (or none yet). A catalog permission granted on a site reaches only the
 * records whose home site that is; one granted on every site reaches the
 * records of every site of the organization. Records on no site are
 * reached by no role: only system managers see them. A scope (below) then
 * narrows within those. Sharing an item into a second site (T-041b) will
 * add read-only reach there (`sharedInto`, empty until then).
 *
 * **What a scoped grant covers.** A record is *in* a unit's subtree when it
 * is that unit or filed below it (`parentId`, all the way up), or when it is
 * a digital asset representing a record that is. Objects, agents, places
 * and events are not in the arrangement, so only a whole-catalog grant
 * covers them. `coveredBy(units)` is the set of units whose subtree holds a
 * record: the record itself if it is a unit, and every ancestor.
 *
 * Pure: the service reads the grants and the arrangement under locks in the
 * same transaction as the write (packages/db `permissions.ts`), then asks
 * here.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { isOrganizationId, type OrganizationId, type SiteId } from "./organizations.js";
import { textProblem } from "./plain-data.js";
import type { RecordId } from "./record-id.js";

/**
 * Permissions within an organization's catalog: granted for the whole
 * catalog or for a unit's subtree.
 */
export const CATALOG_PERMISSIONS = [
  /** See staff records (every field, published or not). */
  "records.view",
  /** Make new records. */
  "records.create",
  /** Change a record's description, place in the arrangement and numbers. */
  "records.edit",
  /** Delete records (a tombstone version, D-067). */
  "records.delete",
  /** Read a record's old versions and compare them (D-065); restoring also needs `records.edit`. */
  "records.history",
  /** Publish and withdraw records (T-034). */
  "records.publish",
  /** Upload scans and other files and attach them to records: make and change digital assets only. */
  "media.attach",
  /** See donors, accessions and deeds of gift (always staff-only, T-016). */
  "donors.view",
  /** Change donors, accessions and deeds of gift. */
  "donors.edit",
] as const;

/**
 * Permissions over the organization as a whole, from a whole-catalog grant.
 * None today: `catalog.definitions` was one until John's decision of
 * 2026-11-24 (D-072) made templates, record types, identifier types and
 * vocabularies system managers' only, so it is a system permission now.
 */
export const ORGANIZATION_PERMISSIONS = [] as const;

/** Permissions over one site: only from a grant on that site (or every site). */
export const SITE_PERMISSIONS = [
  /** The site's settings, design and its choice among installed plugins and themes (D-025). */
  "site.settings",
  /** Grant and revoke roles below site manager on the site. */
  "site.people",
] as const;

/** Only system managers hold these; no role can (D-036). */
export const SYSTEM_PERMISSIONS = [
  /** Read and change System settings (D-019). */
  "system.settings",
  /** Create and rename sites, and choose their organization. */
  "system.sites",
  /** Manage every user, make system managers, appoint site managers. */
  "system.users",
  /** Install plugins and themes (P-001). */
  "system.plugins",
  /**
   * Templates, record types, identifier types and vocabularies (T-047):
   * system managers only (John, 2026-11-24, D-072).
   */
  "catalog.definitions",
] as const;

export type CatalogPermission = (typeof CATALOG_PERMISSIONS)[number];
export type OrganizationPermission = (typeof ORGANIZATION_PERMISSIONS)[number];
export type SitePermission = (typeof SITE_PERMISSIONS)[number];
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];
// OrganizationPermission is empty today (never), so it is left out of the
// union; add it back when an organization permission exists again.
export type RolePermission = CatalogPermission | SitePermission;
export type Permission = RolePermission | SystemPermission;

/** The built-in roles (D-025, D-036). Their keys are stored; their labels are for screens. */
export const BUILT_IN_ROLES = [
  "site_manager",
  "cataloger",
  "reviewer",
  "read_only",
  "scanner",
  "donor_relations",
] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export const ROLE_LABELS: Readonly<Record<BuiltInRole, string>> = Object.freeze({
  site_manager: "Site manager",
  cataloger: "Cataloger",
  reviewer: "Reviewer",
  read_only: "Read-only",
  scanner: "Scanner",
  donor_relations: "Donor relations",
});

/** Roles that can only be granted for the whole catalog: a site manager of a collection means nothing. */
export const WHOLE_CATALOG_ROLES: ReadonlySet<BuiltInRole> = new Set(["site_manager"]);

const freeze = <T>(items: readonly T[]): readonly T[] => Object.freeze([...items]);

/**
 * What each built-in role may do (D-072). From D-025 and D-036 and the
 * mockup's Settings ("Catalogers can add and edit records; only Reviewers and
 * Administrators can publish"). Deleting records is left to site managers
 * (a question for John: D-072).
 */
export const ROLE_PERMISSIONS: Readonly<Record<BuiltInRole, readonly RolePermission[]>> =
  Object.freeze({
    site_manager: freeze<RolePermission>([
      ...CATALOG_PERMISSIONS,
      ...ORGANIZATION_PERMISSIONS,
      ...SITE_PERMISSIONS,
    ]),
    cataloger: freeze<RolePermission>([
      "records.view",
      "records.create",
      "records.edit",
      "records.history",
      "media.attach",
    ]),
    reviewer: freeze<RolePermission>([
      "records.view",
      "records.create",
      "records.edit",
      "records.history",
      "records.publish",
      "media.attach",
    ]),
    read_only: freeze<RolePermission>(["records.view"]),
    // D-036: uploads and attaches scans to existing records, and sees the
    // records it attaches to; no descriptions, publishing or donor data.
    scanner: freeze<RolePermission>(["records.view", "media.attach"]),
    // D-036: donors, accessions and deeds; no descriptions or publishing.
    // "Sees the records an accession produced" waits for stored accessions
    // (T-018b), which will add that as its own rule.
    donor_relations: freeze<RolePermission>(["donors.view", "donors.edit"]),
  });

/**
 * What a grant allows: its own `permissions` if read with them (a custom
 * role), else its built-in role's; nothing for a role neither names.
 */
export function grantPermissions(grant: {
  readonly role: string;
  readonly permissions?: readonly RolePermission[];
}): readonly Permission[] {
  if (grant.permissions !== undefined) return grant.permissions;
  return isBuiltInRole(grant.role) ? ROLE_PERMISSIONS[grant.role] : [];
}

export function isBuiltInRole(value: unknown): value is BuiltInRole {
  return typeof value === "string" && (BUILT_IN_ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    (
      [
        ...CATALOG_PERMISSIONS,
        ...ORGANIZATION_PERMISSIONS,
        ...SITE_PERMISSIONS,
        ...SYSTEM_PERMISSIONS,
      ] as readonly string[]
    ).includes(value)
  );
}

function isCatalogPermission(p: Permission): p is CatalogPermission {
  return (CATALOG_PERMISSIONS as readonly string[]).includes(p);
}
function isSitePermission(p: Permission): p is SitePermission {
  return (SITE_PERMISSIONS as readonly string[]).includes(p);
}
function isSystemPermission(p: Permission): p is SystemPermission {
  return (SYSTEM_PERMISSIONS as readonly string[]).includes(p);
}

/** One role held by one person in one organization. */
export interface RoleGrant {
  /** A built-in role, or the key of one of the organization's custom roles (T-041a). */
  readonly role: string;
  /**
   * What the role allowed when the grant was read (the custom role's own
   * list, read in the same transaction). Left out: a built-in role's
   * `ROLE_PERMISSIONS` (an unknown role without it grants nothing).
   */
  readonly permissions?: readonly RolePermission[];
  /** The site, or `null` for every site of the organization. */
  readonly siteId: SiteId | null;
  /** The unit whose subtree it covers, or `null` for the whole catalog. */
  readonly scope: RecordId | null;
}

/**
 * Everything one person may do in one organization, as read in the write's
 * transaction (never from a session or a request).
 */
export interface Access {
  readonly organizationId: OrganizationId;
  /** An active system manager: everything, everywhere (D-025). */
  readonly systemManager: boolean;
  /** The person's grants in this organization (none for a system manager who isn't a member). */
  readonly grants: readonly RoleGrant[];
}

/** Where a catalog record is, for its permissions: its home site, and sites it is shared into. */
interface RecordSite {
  /** The record's home site (D-074), or `null` for none (system managers only). */
  readonly site: SiteId | null;
  /**
   * Sites that accepted the record from its home site (T-041b): there it is
   * viewable (`records.view` only), never changed. Empty until T-041b.
   */
  readonly sharedInto?: ReadonlySet<SiteId>;
}

/** What a permission is asked about. */
export type PermissionTarget =
  /** A record outside the arrangement, or a new fonds, at its home site. */
  | ({ readonly on: "catalog" } & RecordSite)
  /**
   * A record in the arrangement, at its home site: `units` is every unit
   * whose subtree holds it (`coveredBy`). An empty set is the same as
   * `catalog`.
   */
  | ({ readonly on: "units"; readonly units: ReadonlySet<RecordId> } & RecordSite)
  /** One site. */
  | { readonly on: "site"; readonly siteId: SiteId }
  /** The organization as a whole (organization permissions), or the install (system ones). */
  | { readonly on: "organization" };

/**
 * Whether `access` holds `permission` for `target`. System permissions:
 * system managers only. Site permissions: a grant on that site or on every
 * site. Organization permissions: a whole-catalog grant on any site.
 * Catalog permissions: a grant on the record's home site or on every site
 * (never for a record on no site), for the whole catalog or scoped to one
 * of `units`; `records.view` also from such a grant on a site the record is
 * shared into.
 */
export function permits(access: Access, permission: Permission, target: PermissionTarget): boolean {
  if (access.systemManager) return true;
  if (isSystemPermission(permission)) return false;
  return access.grants.some((grant) => {
    if (!grantPermissions(grant).includes(permission)) return false;
    if (isSitePermission(permission)) {
      return (
        target.on === "site" &&
        grant.scope === null &&
        (grant.siteId === null || grant.siteId === target.siteId)
      );
    }
    if (!isCatalogPermission(permission)) {
      // Organization permissions.
      return target.on === "organization" && grant.scope === null;
    }
    if (target.on !== "catalog" && target.on !== "units") return false;
    const onSite = (site: SiteId | null): boolean =>
      site !== null && (grant.siteId === null || grant.siteId === site);
    const reaches =
      onSite(target.site) ||
      (permission === "records.view" &&
        [...(target.sharedInto ?? [])].some((shared) => onSite(shared)));
    if (!reaches) return false;
    if (grant.scope === null) return true;
    return target.on === "units" && target.units.has(grant.scope);
  });
}

/**
 * Whether `access` holds `permission` anywhere in the catalog (whole or any
 * subtree): for showing a menu, never for deciding a write.
 */
export function holdsAnywhere(access: Access, permission: Permission): boolean {
  if (access.systemManager) return true;
  return access.grants.some((grant) => grantPermissions(grant).includes(permission));
}

/**
 * Whether `access` holds `permission` for the whole catalog of `site` (the
 * records whose home site it is), not only part of it.
 */
export function holdsForWholeCatalog(
  access: Access,
  permission: CatalogPermission,
  site: SiteId,
): boolean {
  return permits(access, permission, { on: "catalog", site });
}

/**
 * Whether the person may work in `site` at all: a system manager, or anyone
 * holding a role on that site or on every site of its organization (the
 * caller checks that the site is the organization's).
 */
export function worksOnSite(access: Access, site: SiteId): boolean {
  if (access.systemManager) return true;
  return access.grants.some((g) => g.siteId === null || g.siteId === site);
}

/**
 * Whether any catalog grant is scoped (so a check needs the arrangement as
 * it is now, under the arrangement lock).
 */
export function hasScopedGrants(access: Access): boolean {
  return !access.systemManager && access.grants.some((g) => g.scope !== null);
}

// ---------------------------------------------------------------------------
// Custom roles (T-041a, D-036, D-121)

/**
 * The permissions a custom role may hold: every catalog permission and the
 * site's settings. Never a system permission (D-036), and not `site.people`
 * yet: granting roles is checked by the database for site managers only
 * (0018's guard), so a custom role that manages people waits for S-067.
 */
export const CUSTOM_ROLE_PERMISSIONS = Object.freeze([
  ...CATALOG_PERMISSIONS,
  "site.settings",
] as const);
export type CustomRolePermission = (typeof CUSTOM_ROLE_PERMISSIONS)[number];

/** Adding one of these to a role needs a confirmation (D-036: publish, donor data). */
export const SENSITIVE_PERMISSIONS: ReadonlySet<CustomRolePermission> = new Set([
  "records.publish",
  "donors.view",
  "donors.edit",
]);

/** A custom role's key: lower case letters and underscores, as stored grants and the change log hold role names. */
const CUSTOM_ROLE_KEY = /^[a-z][a-z_]{0,39}$/;
export const CUSTOM_ROLE_KEY_RULE =
  "1 to 40 lower case letters and underscores, starting with a letter, and not a built-in role's name";
export const MAX_ROLE_LABEL = 100;
export const MAX_ROLE_DESCRIPTION = 500;

export function isCustomRoleKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CUSTOM_ROLE_KEY.test(value) &&
    !isBuiltInRole(value) &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

export function isCustomRolePermission(value: unknown): value is CustomRolePermission {
  return (
    typeof value === "string" && (CUSTOM_ROLE_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** A role a system manager made for one organization (D-036). */
export interface CustomRole {
  readonly organizationId: OrganizationId;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** At least one, each once, in `CUSTOM_ROLE_PERMISSIONS`' order. */
  readonly permissions: readonly CustomRolePermission[];
}

/**
 * Checks a custom role as sent: exactly these keys, a valid key, a label
 * of one line, permissions from `CUSTOM_ROLE_PERMISSIONS` only (a system
 * permission or `site.people` is refused by name), each once. Returns the
 * role with its permissions in the list's order.
 */
export function validateCustomRole(input: unknown): Validated<CustomRole> {
  if (!isPlainObject(input)) {
    return { ok: false, issues: [issue([], "invalid_role", "A role is an object.")] };
  }
  const issues: Issue[] = [];
  const allowed = new Set(["organizationId", "key", "label", "description", "permissions"]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) {
      issues.push(
        issue([k], "unknown_setting", "A role has a key, label, description and permissions."),
      );
    }
  }
  const { organizationId, key, label, description, permissions } = input;
  if (!isOrganizationId(organizationId)) {
    issues.push(issue(["organizationId"], "invalid_id", "A role belongs to one organization."));
  }
  if (!isCustomRoleKey(key)) {
    issues.push(issue(["key"], "invalid_key", `A role's key is ${CUSTOM_ROLE_KEY_RULE}.`));
  }
  const line = (
    value: unknown,
    path: string,
    max: number,
    required: boolean,
  ): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
      issues.push(
        issue([path], "invalid_text", `The ${path} is text with no spaces at either end.`),
      );
      return undefined;
    }
    if (Array.from(value).length > max) {
      issues.push(issue([path], "too_long", `The ${path} is at most ${String(max)} characters.`));
      return undefined;
    }
    const problem = textProblem(value);
    if (problem !== undefined || /[\n\r\t]/.test(value)) {
      issues.push(issue([path], "invalid_text", `The ${path} ${problem ?? "is one line"}.`));
      return undefined;
    }
    return value;
  };
  const shownLabel = line(label, "label", MAX_ROLE_LABEL, true);
  const shownDescription = line(description, "description", MAX_ROLE_DESCRIPTION, false);
  const chosen: CustomRolePermission[] = [];
  if (!Array.isArray(permissions) || permissions.length === 0) {
    issues.push(issue(["permissions"], "no_permissions", "A role holds at least one permission."));
  } else {
    const seen = new Set<unknown>();
    permissions.forEach((p: unknown, i) => {
      if (seen.has(p)) {
        issues.push(
          issue(["permissions", i], "repeated_permission", "A permission is listed once."),
        );
      } else if (isCustomRolePermission(p)) {
        chosen.push(p);
      } else if (isPermission(p)) {
        issues.push(
          issue(
            ["permissions", i],
            "permission_not_allowed",
            "A custom role can't hold this permission: system managers' powers and managing people stay with built-in roles.",
          ),
        );
      } else {
        issues.push(issue(["permissions", i], "unknown_permission", "This isn't a permission."));
      }
      seen.add(p);
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  const ordered = CUSTOM_ROLE_PERMISSIONS.filter((p) => chosen.includes(p));
  return {
    ok: true,
    value: Object.freeze({
      organizationId: organizationId as OrganizationId,
      key: key as string,
      label: shownLabel ?? "",
      ...(shownDescription === undefined ? {} : { description: shownDescription }),
      permissions: Object.freeze(ordered),
    }),
  };
}

/** The sensitive permissions `after` holds that `before` didn't (all of them for a new role). */
export function addedSensitive(
  before: readonly string[] | undefined,
  after: readonly CustomRolePermission[],
): readonly CustomRolePermission[] {
  return after.filter((p) => SENSITIVE_PERMISSIONS.has(p) && !(before ?? []).includes(p));
}
