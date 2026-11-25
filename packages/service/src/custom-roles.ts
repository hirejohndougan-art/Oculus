/**
 * Custom roles through the service (T-041a, D-036, D-120).
 *
 * - **Who:** system managers only, for the organization the session works
 *   in (D-036: they create, edit and delete roles; site managers grant the
 *   roles that exist). The staff API asks for a recent sign-in as well.
 * - **What a role may hold:** core's `validateCustomRole` (catalog
 *   permissions and `site.settings`; never a system permission, and not
 *   `site.people` yet, S-066). So a custom role never reaches beyond what a
 *   site manager already holds, and granting one changes nothing about who
 *   may grant roles (0018's guard, `mayManage`).
 * - **Sensitive permissions** (`records.publish`, `donors.view`,
 *   `donors.edit`) added to a role, new or changed, are refused
 *   (`needs_confirmation`, one issue per permission at `["confirm",
 *   permission]`) until `confirm` lists exactly them.
 * - **People affected:** changing the permissions of, or deleting, a role
 *   people hold is refused (`affects_people`, one issue per grant at
 *   `["holders", assignmentId]` naming the person) until `confirmHolders`
 *   gives their number as read now. A deletion also names `moveTo`: a
 *   built-in role below site manager, or another of the organization's
 *   custom roles; each grant is moved there (same site, same scope, granted
 *   by the system manager, logged as a revoke and a grant) before the role
 *   is deleted. Moving to the role being deleted, or to a site manager, is
 *   refused.
 * - **Locks:** the holders' user rows first (FOR NO KEY UPDATE, as a role
 *   grant does: writes in flight that checked the old permissions finish
 *   first, later ones read the new ones), then the role's row FOR UPDATE
 *   (a grant being made of it waits), then the holders again; anyone
 *   granted it in between is locked too.
 * - **Change log:** every save and deletion adds a `custom_role_events`
 *   row; moved grants add `people_events` rows.
 */
import {
  BUILT_IN_ROLES,
  addedSensitive,
  isBuiltInRole,
  isCustomRoleKey,
  isPlainObject,
  issue,
  newRecordId,
  validateCustomRole,
  type CustomRole,
  type Issue,
  type OrganizationId,
  type UserId,
} from "@oculus/core";
import {
  deleteCustomRole as deleteStoredRole,
  deleteRoleAssignment,
  holdingsOfRole,
  insertCustomRole,
  insertPeopleEvent,
  insertRoleAssignment,
  listCustomRoleEvents,
  listCustomRoles as listStoredRoles,
  lockPeopleForRoleChange,
  readCustomRole,
  recordCustomRoleEvent,
  updateCustomRole,
  type Queryable,
  type RoleHolding,
  type StoredCustomRole,
  type StoredCustomRoleEvent,
} from "@oculus/db";
import { notPermitted, readAccess } from "./access.js";
import type { Runner } from "./admin.js";
import type { ServiceContext, ServiceResult } from "./service.js";

/** A custom role with how many grants of it there are. */
export interface CustomRoleView {
  readonly role: StoredCustomRole;
  readonly grants: number;
}

/** A saved role, and what the save did. */
export interface SavedCustomRole {
  readonly role: StoredCustomRole;
  readonly grants: number;
}

/** What a deletion did. */
export interface DeletedCustomRole {
  readonly key: string;
  /** Grants moved to `movedTo` (0 when nobody held the role). */
  readonly moved: number;
  readonly movedTo: string | null;
}

export interface CustomRoleOperations {
  /** The organization's custom roles with their grant counts (system managers). */
  listCustomRoles(context: ServiceContext): Promise<ServiceResult<readonly CustomRoleView[]>>;
  /** Who holds a role (system managers): for "who is affected". */
  customRoleHolders(
    context: ServiceContext,
    key: string,
  ): Promise<ServiceResult<readonly RoleHolding[]>>;
  /** The custom roles' change log, newest first (system managers). */
  customRoleHistory(
    context: ServiceContext,
  ): Promise<ServiceResult<readonly StoredCustomRoleEvent[]>>;
  /**
   * Makes a role (`expectedVersion: 0`) or changes one (the version the
   * edit started from). Options: `expectedVersion`, `confirm` (the
   * sensitive permissions added), `confirmHolders` (the number of grants).
   */
  saveCustomRole(
    context: ServiceContext,
    role: unknown,
    options: unknown,
  ): Promise<ServiceResult<SavedCustomRole>>;
  /**
   * Deletes a role. Options: `expectedVersion`, and while people hold it
   * `moveTo` and `confirmHolders`.
   */
  deleteCustomRole(
    context: ServiceContext,
    key: unknown,
    options: unknown,
  ): Promise<ServiceResult<DeletedCustomRole>>;
}

/** The most grants one change or deletion of a role handles. */
export const MAX_ROLE_HOLDINGS = 5_000;

function refusal<T>(path: (string | number)[], code: string, message: string): ServiceResult<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

const UNKNOWN_ROLE = "The organization has no such role.";

function own(input: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

/** The options as an own-keys object of exactly `keys` (any subset). */
function readOptions(
  options: unknown,
  keys: readonly string[],
): ServiceResult<Record<string, unknown>> {
  if (options === undefined) return { ok: true, value: {} };
  if (!isPlainObject(options) || !Object.keys(options).every((k) => keys.includes(k))) {
    return refusal(["options"], "invalid_options", `The options are ${keys.join(", ")}.`);
  }
  return { ok: true, value: options };
}

function holdersIssues(holdings: readonly RoleHolding[], verb: string): Issue[] {
  const n = holdings.length;
  return [
    issue(
      ["confirmHolders"],
      "affects_people",
      `${n === 1 ? "1 grant" : `${String(n)} grants`} of this role would ${verb}. Check who, then confirm the number (confirmHolders).`,
    ),
    ...holdings.map((h) =>
      issue(["holders", h.assignmentId], "holder", `${h.displayName} holds this role.`),
    ),
  ];
}

export function customRoleOperations(run: Runner): CustomRoleOperations {
  /** System managers only; anyone else is refused before anything is read. */
  async function manager(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
    lock = true,
  ): Promise<ServiceResult<UserId>> {
    const access = await readAccess(tx, who.organizationId, who.actor, { lock });
    if (!access.ok) return access;
    if (!access.value.systemManager) return notPermitted();
    return { ok: true, value: access.userId };
  }

  /**
   * The role's holders, every one's user row locked, then the role's row
   * FOR UPDATE, then the holders again (see the module header).
   */
  async function lockRole(
    tx: Queryable,
    org: OrganizationId,
    key: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly role: StoredCustomRole;
        readonly holdings: readonly RoleHolding[];
      }
    | { readonly ok: false; readonly result: ServiceResult<never> }
  > {
    const first = await holdingsOfRole(tx, org, key, MAX_ROLE_HOLDINGS + 1);
    if (first.length > MAX_ROLE_HOLDINGS) {
      return {
        ok: false,
        result: refusal(
          [],
          "too_many_grants",
          `This role has more than ${String(MAX_ROLE_HOLDINGS)} grants: change it in smaller steps.`,
        ),
      };
    }
    const locked = new Set<string>(first.map((h) => h.userId));
    await lockPeopleForRoleChange(tx, [...locked] as UserId[]);
    const role = await readCustomRole(tx, org, key, { lock: "update" });
    if (role === undefined) {
      return { ok: false, result: refusal(["key"], "unknown_role", UNKNOWN_ROLE) };
    }
    const holdings = await holdingsOfRole(tx, org, key, MAX_ROLE_HOLDINGS + 1);
    if (holdings.length > MAX_ROLE_HOLDINGS) {
      return {
        ok: false,
        result: refusal([], "too_many_grants", "This role has too many grants to change at once."),
      };
    }
    // Granted in between (committed before the role's lock): lock them too.
    const extra = holdings.map((h) => h.userId).filter((u) => !locked.has(u));
    if (extra.length > 0) await lockPeopleForRoleChange(tx, extra);
    return { ok: true, role, holdings };
  }

  return {
    async listCustomRoles(context) {
      return run("listCustomRoles", context, async (tx, who) => {
        const me = await manager(tx, who, false);
        if (!me.ok) return me;
        const roles = await listStoredRoles(tx, who.organizationId);
        const views: CustomRoleView[] = [];
        for (const role of roles) {
          const holdings = await holdingsOfRole(
            tx,
            who.organizationId,
            role.key,
            MAX_ROLE_HOLDINGS,
          );
          views.push(Object.freeze({ role, grants: holdings.length }));
        }
        return { ok: true, value: Object.freeze(views) };
      });
    },

    async customRoleHolders(context, key) {
      return run("customRoleHolders", context, async (tx, who) => {
        const me = await manager(tx, who, false);
        if (!me.ok) return me;
        if (
          !isCustomRoleKey(key) ||
          (await readCustomRole(tx, who.organizationId, key)) === undefined
        ) {
          return refusal(["key"], "unknown_role", UNKNOWN_ROLE);
        }
        return {
          ok: true,
          value: await holdingsOfRole(tx, who.organizationId, key, MAX_ROLE_HOLDINGS),
        };
      });
    },

    async customRoleHistory(context) {
      return run("customRoleHistory", context, async (tx, who) => {
        const me = await manager(tx, who, false);
        if (!me.ok) return me;
        return { ok: true, value: await listCustomRoleEvents(tx, who.organizationId) };
      });
    },

    async saveCustomRole(context, input, options) {
      return run("saveCustomRole", context, async (tx, who) => {
        const org = who.organizationId;
        const me = await manager(tx, who);
        if (!me.ok) return me;
        const opts = readOptions(options, ["expectedVersion", "confirm", "confirmHolders"]);
        if (!opts.ok) return opts;
        const expectedVersion = own(opts.value, "expectedVersion");
        if (
          typeof expectedVersion !== "number" ||
          !Number.isInteger(expectedVersion) ||
          expectedVersion < 0 ||
          expectedVersion > 2 ** 31 - 2
        ) {
          return refusal(
            ["options", "expectedVersion"],
            "invalid_version",
            "Name the version the edit started from, or 0 for a new role.",
          );
        }
        const confirm = own(opts.value, "confirm") ?? [];
        if (!Array.isArray(confirm) || !confirm.every((c) => typeof c === "string")) {
          return refusal(["options", "confirm"], "invalid_option", "confirm lists permissions.");
        }
        const confirmHolders = own(opts.value, "confirmHolders");
        if (
          confirmHolders !== undefined &&
          (typeof confirmHolders !== "number" || !Number.isInteger(confirmHolders))
        ) {
          return refusal(
            ["options", "confirmHolders"],
            "invalid_option",
            "confirmHolders is the number of grants.",
          );
        }
        if (!isPlainObject(input)) {
          return refusal(["role"], "invalid_role", "A role is an object.");
        }
        const named = own(input, "organizationId");
        if (named !== undefined && named !== org) {
          return refusal(
            ["organizationId"],
            "wrong_organization",
            "This role is another organization's. Work in one of its sites to change it.",
          );
        }
        const valid = validateCustomRole({ ...input, organizationId: org });
        if (!valid.ok) return valid;
        const role: CustomRole = valid.value;

        let before: StoredCustomRole | undefined;
        let holdings: readonly RoleHolding[] = [];
        if (expectedVersion === 0) {
          if ((await readCustomRole(tx, org, role.key)) !== undefined) {
            return refusal(
              ["key"],
              "key_taken",
              "The organization already has a role with this key.",
            );
          }
        } else {
          const locked = await lockRole(tx, org, role.key);
          if (!locked.ok) return locked.result;
          before = locked.role;
          holdings = locked.holdings;
          if (before.version !== expectedVersion) {
            return refusal(
              ["options", "expectedVersion"],
              "version_conflict",
              "The role was changed by someone else. Read it again.",
            );
          }
        }

        // Sensitive permissions added: confirmed one by one (D-036).
        const added = addedSensitive(before?.permissions, role.permissions);
        const asked = new Set(confirm as string[]);
        if (
          added.length > 0 &&
          (added.length !== asked.size || !added.every((p) => asked.has(p)))
        ) {
          {
            return {
              ok: false,
              issues: added.map((p) =>
                issue(
                  ["confirm", p],
                  "needs_confirmation",
                  p === "records.publish"
                    ? "This role would let people publish and withdraw records."
                    : p === "donors.view"
                      ? "This role would let people see donors, accessions and deeds of gift."
                      : "This role would let people change donors, accessions and deeds of gift.",
                ),
              ),
            };
          }
          // Nothing sensitive is added: a confirmation left over from an
          // earlier ask changes nothing.
        }

        // People affected: a change of what the role allows, while people hold it.
        const changesAccess =
          before !== undefined &&
          (before.permissions.length !== role.permissions.length ||
            before.permissions.some((p, i) => p !== role.permissions[i]));
        if (changesAccess && holdings.length > 0 && confirmHolders !== holdings.length) {
          return { ok: false, issues: holdersIssues(holdings, "change what its holders may do") };
        }

        const saved =
          before === undefined
            ? await insertCustomRole(tx, role, me.value)
            : await updateCustomRole(tx, role, expectedVersion, me.value);
        if (saved === undefined) {
          return before === undefined
            ? refusal(["key"], "key_taken", "The organization already has a role with this key.")
            : refusal(
                ["options", "expectedVersion"],
                "version_conflict",
                "The role was changed by someone else. Read it again.",
              );
        }
        await recordCustomRoleEvent(tx, {
          organizationId: org,
          actorId: me.value,
          kind: before === undefined ? "role_created" : "role_changed",
          roleKey: saved.key,
          label: saved.label,
          permissions: saved.permissions,
          grants: holdings.length,
        });
        return { ok: true, value: Object.freeze({ role: saved, grants: holdings.length }) };
      });
    },

    async deleteCustomRole(context, key, options) {
      return run("deleteCustomRole", context, async (tx, who) => {
        const org = who.organizationId;
        const me = await manager(tx, who);
        if (!me.ok) return me;
        if (!isCustomRoleKey(key)) return refusal(["key"], "unknown_role", UNKNOWN_ROLE);
        const opts = readOptions(options, ["expectedVersion", "moveTo", "confirmHolders"]);
        if (!opts.ok) return opts;
        const expectedVersion = own(opts.value, "expectedVersion");
        if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
          return refusal(
            ["options", "expectedVersion"],
            "invalid_version",
            "Name the version of the role being deleted.",
          );
        }
        const moveTo = own(opts.value, "moveTo") ?? null;
        const confirmHolders = own(opts.value, "confirmHolders");
        if (moveTo !== null) {
          if (moveTo === key) {
            return refusal(["options", "moveTo"], "same_role", "Move its holders to another role.");
          }
          if (moveTo === "site_manager") {
            return refusal(
              ["options", "moveTo"],
              "not_allowed",
              "Holders can't be moved to site manager: make site managers one by one.",
            );
          }
          if (!isBuiltInRole(moveTo)) {
            if (!isCustomRoleKey(moveTo)) {
              return refusal(
                ["options", "moveTo"],
                "unknown_role",
                `Move them to one of ${BUILT_IN_ROLES.filter((r) => r !== "site_manager").join(", ")}, or another of the organization's roles.`,
              );
            }
          }
        }
        const locked = await lockRole(tx, org, key);
        if (!locked.ok) return locked.result;
        const { role, holdings } = locked;
        if (role.version !== expectedVersion) {
          return refusal(
            ["options", "expectedVersion"],
            "version_conflict",
            "The role was changed by someone else. Read it again.",
          );
        }
        if (holdings.length > 0) {
          if (moveTo === null) {
            return {
              ok: false,
              issues: [
                issue(
                  ["options", "moveTo"],
                  "role_in_use",
                  "People hold this role: name the role to move them to (moveTo).",
                ),
                ...holdersIssues(holdings, "move").slice(1),
              ],
            };
          }
          // The target, read (and locked against deletion) now.
          if (
            !isBuiltInRole(moveTo) &&
            (await readCustomRole(tx, org, moveTo as string)) === undefined
          ) {
            return refusal(["options", "moveTo"], "unknown_role", UNKNOWN_ROLE);
          }
          if (confirmHolders !== holdings.length) {
            return { ok: false, issues: holdersIssues(holdings, "move") };
          }
          for (const h of holdings) {
            await deleteRoleAssignment(tx, org, h.assignmentId);
            await insertPeopleEvent(tx, {
              id: newRecordId(),
              organizationId: org,
              actorId: me.value,
              kind: "role_revoked",
              subjectId: h.userId,
              role: key,
              siteId: h.siteId as never,
              scope: h.scope,
            });
            const moved = await insertRoleAssignment(tx, {
              id: newRecordId(),
              organizationId: org,
              userId: h.userId,
              role: moveTo as string,
              siteId: h.siteId as never,
              scope: h.scope as never,
              grantedBy: me.value,
            });
            // Already held there: the person keeps that grant; nothing to add.
            if (moved.ok) {
              await insertPeopleEvent(tx, {
                id: newRecordId(),
                organizationId: org,
                actorId: me.value,
                kind: "role_granted",
                subjectId: h.userId,
                role: moveTo as string,
                siteId: h.siteId as never,
                scope: h.scope,
              });
            }
          }
        } else if (moveTo !== null && confirmHolders !== undefined && confirmHolders !== 0) {
          return refusal(
            ["options", "confirmHolders"],
            "version_conflict",
            "Nobody holds this role any more. Read it again.",
          );
        }
        if (!(await deleteStoredRole(tx, org, key))) {
          return refusal(["key"], "unknown_role", UNKNOWN_ROLE);
        }
        await recordCustomRoleEvent(tx, {
          organizationId: org,
          actorId: me.value,
          kind: "role_deleted",
          roleKey: key,
          label: role.label,
          permissions: role.permissions,
          grants: holdings.length,
          ...(holdings.length > 0 && moveTo !== null ? { movedTo: moveTo as string } : {}),
        });
        return {
          ok: true,
          value: Object.freeze({
            key,
            moved: holdings.length,
            movedTo: holdings.length > 0 ? (moveTo as string) : null,
          }),
        };
      });
    },
  };
}
