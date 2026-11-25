/**
 * People, roles and the audit trail through the service (T-048, D-084):
 * the admin's Users screens. The service decides every permission; the
 * account functions of `@oculus/db` (D-068, D-069, D-077, D-078) check
 * theirs again in their own transactions.
 *
 * Who may do what (D-019, D-025, D-072):
 * - **Seeing people.** System managers see every member of the session's
 *   organization with all their roles, sessions and two-step status. Site
 *   managers (`site.people`) see the members holding a role on a site they
 *   manage, or no role at all, and only the roles they may manage there
 *   (none on every site, no site manager grants: as `listRoleAssignments`).
 *   Anyone else is refused. A person out of view, another organization's
 *   member and an unknown ID are the same `unknown_person`.
 * - **Granting and revoking roles**: `grantRole`'s and `revokeRole`'s rules
 *   (who may grant what, D-072, backed by 0018's trigger), plus the
 *   password and second step entered in the last 10 minutes (D-072's left
 *   item; `reauthentication_required`), checked after the permission so a
 *   person who may not act learns nothing more.
 * - **Inviting, disabling and re-enabling accounts, resetting two-step
 *   sign-in, sending a password reset link and ending every session** are
 *   system managers' only (D-019: accounts are install-wide), on members
 *   of the session's organization, with a recent re-entry. The last active
 *   system manager can't be disabled (0020's trigger). A reset link to an
 *   account with no second factor in use (never set up, or just reset)
 *   needs `confirmMailboxOnly` (D-078: the mailbox alone then gets the
 *   account).
 * - **The audit trail** (D-082 left it here): record versions of the whole
 *   sites where the viewer holds `records.history` for the whole catalog
 *   (every record, deleted ones' histories included, for a system manager;
 *   a deleted record has no home site to check, so only system managers
 *   see its history), and people events: all of them for a system
 *   manager, role changes on the sites they manage for a site manager.
 *   Filtered in the query, so a page's length says nothing about hidden
 *   rows.
 *
 * Every change to a person is written to the change log (`people_events`):
 * in the same transaction for roles and disabling; right after the
 * database function's own transaction for invitations, resets and ending
 * sessions (those functions commit before they send mail). A failure to
 * write that row afterwards is reported to `onError` and doesn't undo the
 * change.
 */
import {
  BUILT_IN_ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  isRecordId,
  isUserId,
  issue,
  newRecordId,
  permits,
  type Access,
  type BuiltInRole,
  type OrganizationId,
  type Permission,
  type SiteId,
  type UserId,
} from "@oculus/core";
import {
  DEFAULT_AUDIT_PAGE,
  MAX_AUDIT_PAGE,
  actingSession,
  createInvitation,
  endUserSessions,
  insertPeopleEvent,
  isAuditCursor,
  listMembers,
  memberGrants,
  membersGrants,
  memberSecondStep,
  memberSessions,
  organizationSiteIds,
  readAuditTrail,
  readMember,
  resetSecondFactor,
  sendPasswordReset,
  setAccountDisabled,
  databaseNow,
  invitationMadeSince,
  type AuditPage,
  type Database,
  type EnrolmentDelivery,
  type InvitationDelivery,
  type Member,
  type MemberGrant,
  type MemberSecondStep,
  type MemberSession,
  type NewPeopleEvent,
  type PasswordResetDelivery,
  type Queryable,
  type RoleAssignment,
  type SecretKeyring,
  sql,
} from "@oculus/db";
import { actorUser, notPermitted, readAccess } from "./access.js";
import { grantRoleIn, hasOnly, managedSites, own, revokeRoleIn, type Runner } from "./admin.js";
import type { ServiceContext, ServiceResult } from "./service.js";

/** The context of a change to a person: also the acting session's token (never stored or logged). */
export interface PeopleContext extends ServiceContext {
  readonly sessionToken: string;
}

/** A member as the people list shows them; `systemAdmin` only to system managers. */
export interface PersonSummary {
  readonly userId: UserId;
  readonly displayName: string;
  readonly email: string;
  readonly disabled: boolean;
  readonly systemAdmin?: boolean;
  readonly lastSignInAt: string | null;
  readonly roles: readonly MemberGrant[];
}

/** What the viewer may do, for the screens (the server checks again on every change). */
export interface PeopleRights {
  readonly systemManager: boolean;
  /** Sites on which the viewer may grant and revoke roles below site manager. */
  readonly manageSites: readonly string[];
  /** Grant site manager, roles on every site, and act on accounts. */
  readonly manageAccounts: boolean;
}

export interface PeopleList {
  readonly people: readonly PersonSummary[];
  readonly truncated: boolean;
  readonly rights: PeopleRights;
}

export interface PersonDetail {
  readonly person: PersonSummary & { readonly addedAt: string };
  readonly rights: PeopleRights;
  /** System managers only. */
  readonly sessions?: readonly MemberSession[];
  readonly secondStep?: MemberSecondStep;
}

export interface RoleCatalogEntry {
  readonly role: BuiltInRole;
  readonly label: string;
  readonly permissions: readonly string[];
  /** Whether the viewer may grant it somewhere. */
  readonly grantable: boolean;
}

export interface PeopleOperations {
  /** The organization's people the viewer may see (module header). */
  listPeople(context: ServiceContext): Promise<ServiceResult<PeopleList>>;
  /** One person, with their roles, and for system managers their sessions and two-step status. */
  readPerson(context: ServiceContext, userId: unknown): Promise<ServiceResult<PersonDetail>>;
  /** The built-in roles and what each may do (D-072). Custom roles are T-041a's. */
  roleCatalog(context: ServiceContext): Promise<ServiceResult<readonly RoleCatalogEntry[]>>;
  /** Invites an address to the organization (system managers). The token goes only to `deliver`. */
  invitePerson(
    context: PeopleContext,
    request: unknown,
    deliver: InvitationDelivery,
  ): Promise<
    ServiceResult<{
      readonly invitationId: string;
      readonly email: string;
      readonly expiresAt: string;
    }>
  >;
  /** Disables (`true`) or re-enables an account (system managers, recent re-entry). */
  setPersonDisabled(
    context: PeopleContext,
    userId: unknown,
    disabled: boolean,
  ): Promise<ServiceResult<{ readonly changed: boolean }>>;
  /** `grantRole` with a recent re-entry and a line in the change log. */
  grantPersonRole(context: PeopleContext, request: unknown): Promise<ServiceResult<RoleAssignment>>;
  /** `revokeRole` with a recent re-entry and a line in the change log. */
  revokePersonRole(
    context: PeopleContext,
    assignmentId: unknown,
  ): Promise<ServiceResult<RoleAssignment>>;
  /** Resets two-step sign-in (D-077): needs the admin's own code or recovery code now. */
  resetPersonSecondStep(
    context: PeopleContext,
    userId: unknown,
    input: { readonly code?: string; readonly recoveryCode?: string; readonly source: string },
    keys: SecretKeyring,
    deliver: EnrolmentDelivery,
  ): Promise<
    ServiceResult<{
      readonly hadFactor: boolean;
      readonly ended: number;
      readonly delivered: boolean;
    }>
  >;
  /** Sends a reset link (D-078); `confirmMailboxOnly` when no second factor is in use. */
  sendPersonPasswordReset(
    context: PeopleContext,
    userId: unknown,
    options: unknown,
    deliver: PasswordResetDelivery,
  ): Promise<ServiceResult<{ readonly expiresAt: string }>>;
  /** Ends every session of the person (system managers, recent re-entry). */
  endPersonSessions(
    context: PeopleContext,
    userId: unknown,
  ): Promise<ServiceResult<{ readonly ended: number }>>;
  /** The organization's change log, newest first, as far as the viewer may see (module header). */
  auditTrail(context: ServiceContext, filter: unknown): Promise<ServiceResult<AuditPage>>;
  /**
   * Software updates (T-060, D-092): system managers only, checked as for
   * System settings (`system.settings`). With `{ fresh: true }`, also the
   * password and second step entered in the last 10 minutes, as for
   * changes to people: installing or rolling back runs new code on the
   * server. Returns the acting person's ID for the install history.
   */
  authorizeSystemUpdate(
    context: PeopleContext,
    options: { readonly fresh: boolean },
  ): Promise<ServiceResult<{ readonly userId: UserId }>>;
}

/** A thrown error's SQLSTATE (own data property only), if any. */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(error, "code");
  return d !== undefined && typeof d.value === "string" ? d.value : undefined;
}

function refusal<T>(path: (string | number)[], code: string, message: string): ServiceResult<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

const UNKNOWN_PERSON = "There is no such member of this organization.";

/** Refusals after which a message may have gone, or a link or invitation may still be live: logged too. */
const SENT_OR_TRIED: ReadonlySet<string> = new Set([
  "superseded",
  "revoked",
  "delivery_failed",
  "delivery_failed_may_be_pending",
]);

function unknownPerson<T>(): ServiceResult<T> {
  return refusal(["userId"], "unknown_person", UNKNOWN_PERSON);
}

/** The viewer's people rights, with "every site" resolved to the organization's sites. */
interface Viewer {
  readonly access: Access;
  readonly userId: UserId;
  readonly system: boolean;
  /** Sites on which they manage people (site managers); every site for a system manager. */
  readonly sites: readonly SiteId[];
}

async function viewerOf(
  tx: Queryable,
  who: { organizationId: OrganizationId; actor: string },
): Promise<
  { ok: true; value: Viewer } | { ok: false; issues: ReturnType<typeof notPermitted>["issues"] }
> {
  const access = await readAccess(tx, who.organizationId, who.actor);
  if (!access.ok) return access;
  const managed = managedSites(access.value);
  const all = (await organizationSiteIds(tx, who.organizationId)) as readonly SiteId[];
  const sites = managed === "all" ? all : all.filter((s) => managed.has(s));
  return {
    ok: true,
    value: {
      access: access.value,
      userId: access.userId,
      system: access.value.systemManager,
      sites,
    },
  };
}

function rightsOf(viewer: Viewer): PeopleRights {
  return Object.freeze({
    systemManager: viewer.system,
    manageSites: Object.freeze([...viewer.sites]),
    manageAccounts: viewer.system,
  });
}

/** The person's roles as the viewer may see them (D-072's listing rule). */
function grantsFor(
  tx: Queryable,
  organizationId: OrganizationId,
  viewer: Viewer,
  userId: UserId,
): Promise<readonly MemberGrant[]> {
  return viewer.system
    ? memberGrants(tx, organizationId, userId)
    : memberGrants(tx, organizationId, userId, {
        siteIds: viewer.sites,
        exceptRole: "site_manager",
      });
}

function summary(member: Member, roles: readonly MemberGrant[], viewer: Viewer): PersonSummary {
  return Object.freeze({
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    disabled: member.disabled,
    ...(viewer.system ? { systemAdmin: member.systemAdmin } : {}),
    lastSignInAt: member.lastSignInAt,
    roles,
  });
}

/**
 * The member if the viewer may see them (a system manager: any member; a
 * site manager: one with a role on a site they manage, or with no role).
 */
async function visibleMember(
  tx: Queryable,
  organizationId: OrganizationId,
  viewer: Viewer,
  userId: unknown,
): Promise<Member | undefined> {
  if (!isUserId(userId)) return undefined;
  const member = await readMember(tx, organizationId, userId);
  if (member === undefined || viewer.system) return member;
  const all = await memberGrants(tx, organizationId, userId);
  if (all.length === 0) return member;
  return all.some((g) => g.siteId !== null && viewer.sites.includes(g.siteId)) ? member : undefined;
}

/** `undefined` if the acting session entered password and second step in the last 10 minutes. */
async function notRecent<T>(
  tx: Queryable,
  context: PeopleContext,
  who: { actor: string },
): Promise<ServiceResult<T> | undefined> {
  const acting = await actingSession(tx, own(context, "sessionToken"));
  const userId = actorUser(who.actor);
  if (acting === undefined || userId === undefined || acting.userId !== userId) {
    return refusal([], "no_session", "Sign in again.");
  }
  if (!acting.recent) {
    return refusal(
      [],
      "reauthentication_required",
      "Enter your password and a code again to make this change.",
    );
  }
  return undefined;
}

/** The whole sites where `access` holds `permission` for the whole catalog (service.ts's wholeSites). */
function wholeSitesHolding(
  access: Access,
  permission: Permission,
  all: readonly SiteId[],
): readonly SiteId[] {
  const holding = access.grants.filter(
    (g) =>
      g.scope === null && (ROLE_PERMISSIONS[g.role] as readonly Permission[]).includes(permission),
  );
  if (holding.some((g) => g.siteId === null)) return all;
  const named = new Set<SiteId | null>(holding.map((g) => g.siteId));
  return all.filter((s) => named.has(s));
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;

function timeBound(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (!ISO_DAY.test(value) && !ISO_TIME.test(value))) return false;
  const text = ISO_DAY.test(value) ? `${value}T00:00:00Z` : value;
  const time = Date.parse(text);
  if (Number.isNaN(time) || time < Date.UTC(1970, 0, 1) || time > Date.UTC(9999, 0, 1)) {
    return false;
  }
  // A real date and time only: 2026-02-30 or 25:00 parse in some engines
  // (rolled over), so the text must read back the same (review).
  const iso = new Date(time).toISOString();
  const given = text.replace(/Z$/, "");
  const [date = "", clock = ""] = given.split("T");
  if (iso.slice(0, 10) !== date || iso.slice(11, 11 + clock.length) !== clock) {
    return false;
  }
  return iso;
}

/** Database refusals of the account functions, as the service's issues (path `[]` → `userId` where it is about the person). */
function fromDatabase<T>(result: {
  readonly ok: false;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}): ServiceResult<T> {
  return {
    ok: false,
    issues: result.issues.map((i) =>
      issue(
        i.code === "unknown_user" ? ["userId"] : [],
        i.code === "unknown_user" ? "unknown_person" : i.code,
        i.code === "unknown_user" ? UNKNOWN_PERSON : i.message,
      ),
    ),
  };
}

/** The service context without the session token (which `run` doesn't take, and never stores). */
function withoutToken(context: unknown): unknown {
  if (typeof context !== "object" || context === null || !Object.hasOwn(context, "sessionToken")) {
    return context;
  }
  const copy: Record<string, unknown> = {};
  for (const key of ["organizationId", "actor", "siteId"]) {
    if (Object.hasOwn(context, key)) copy[key] = own(context, key);
  }
  return copy;
}

export function peopleOperations(
  db: Database,
  baseRun: Runner,
  onError?: (error: unknown, operation: string) => void,
  searchTimeoutMs = 5_000,
): PeopleOperations {
  const run: Runner = (operation, context, work) => baseRun(operation, withoutToken(context), work);
  const report = (operation: string) => (error: unknown) => {
    try {
      onError?.(error, operation);
    } catch {
      // The log's own failure changes nothing.
    }
  };

  /** A system manager acting on a member of the session's organization: their user ID. */
  async function accountAction(
    context: PeopleContext,
    operation: string,
    userId: unknown,
  ): Promise<
    ServiceResult<{ readonly actorId: UserId; readonly userId: UserId; readonly member: Member }>
  > {
    return run(operation, context, async (tx, who) => {
      const viewer = await viewerOf(tx, who);
      if (!viewer.ok) return viewer;
      if (!viewer.value.system) return notPermitted();
      const member = await visibleMember(tx, who.organizationId, viewer.value, userId);
      if (member === undefined) return unknownPerson();
      return { ok: true, value: { actorId: viewer.value.userId, userId: member.userId, member } };
    });
  }

  /** Writes a change-log row after a database function's own transaction. */
  async function logAfter(
    context: ServiceContext,
    operation: string,
    event: Omit<NewPeopleEvent, "id" | "organizationId">,
  ): Promise<void> {
    const written = await run(`${operation}Log`, context, async (tx, who) => {
      await insertPeopleEvent(tx, {
        ...event,
        id: newRecordId(),
        organizationId: who.organizationId,
      });
      return { ok: true, value: true };
    });
    if (!written.ok) report(`${operation}Log`)(new Error("people_event_not_written"));
  }

  return {
    async listPeople(context) {
      return run("listPeople", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        const v = viewer.value;
        if (!v.system && v.sites.length === 0) return notPermitted();
        const listed = await listMembers(
          tx,
          who.organizationId,
          v.system ? {} : { visibleTo: v.sites },
        );
        const people: PersonSummary[] = [];
        // One query for everyone's roles (review: not one per member).
        const grants = await membersGrants(
          tx,
          who.organizationId,
          listed.members.map((m) => m.userId),
          v.system ? {} : { siteIds: v.sites, exceptRole: "site_manager" },
        );
        for (const member of listed.members) {
          people.push(summary(member, grants.get(member.userId) ?? [], v));
        }
        return {
          ok: true,
          value: Object.freeze({
            people: Object.freeze(people),
            truncated: listed.truncated,
            rights: rightsOf(v),
          }),
        };
      });
    },

    async readPerson(context, userId) {
      return run("readPerson", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        const v = viewer.value;
        if (!v.system && v.sites.length === 0) return notPermitted();
        const member = await visibleMember(tx, who.organizationId, v, userId);
        if (member === undefined) return unknownPerson();
        const roles = await grantsFor(tx, who.organizationId, v, member.userId);
        return {
          ok: true,
          value: Object.freeze({
            person: Object.freeze({ ...summary(member, roles, v), addedAt: member.addedAt }),
            rights: rightsOf(v),
            ...(v.system
              ? {
                  sessions: await memberSessions(tx, member.userId),
                  secondStep: await memberSecondStep(tx, member.userId),
                }
              : {}),
          }),
        };
      });
    },

    async roleCatalog(context) {
      return run("roleCatalog", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        const v = viewer.value;
        if (!v.system && v.sites.length === 0) return notPermitted();
        return {
          ok: true,
          value: Object.freeze(
            BUILT_IN_ROLES.map((role) =>
              Object.freeze({
                role,
                label: ROLE_LABELS[role],
                permissions: Object.freeze([...ROLE_PERMISSIONS[role]]),
                grantable: v.system || role !== "site_manager",
              }),
            ),
          ),
        };
      });
    },

    async invitePerson(context, request, deliver) {
      if (!hasOnly(request, ["email", "expiresInDays"])) {
        return refusal(
          ["request"],
          "invalid_request",
          "An invitation is an email and expiresInDays.",
        );
      }
      const days = own(request, "expiresInDays") ?? 7;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 14) {
        return refusal(["expiresInDays"], "invalid_life", "An invitation lasts from 1 to 14 days.");
      }
      const allowed = await run("invitePerson", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        if (!viewer.value.system) return notPermitted();
        return { ok: true, value: viewer.value.userId };
      });
      if (!allowed.ok) return allowed;
      const since = await databaseNow(db);
      const made = await createInvitation(
        db,
        {
          organizationId: context.organizationId,
          email: own(request, "email") as string,
          invitedBy: allowed.value,
          expiresInSeconds: days * 86_400,
        },
        deliver,
      );
      if (!made.ok) {
        // A message that may have gone (or failed to) is logged too
        // (review): the invitation exists, pending or withdrawn.
        if (made.issues.some((i) => SENT_OR_TRIED.has(i.code))) {
          const invitationId = await invitationMadeSince(
            db,
            context.organizationId,
            allowed.value,
            own(request, "email") as string,
            since,
          );
          if (invitationId !== undefined) {
            await logAfter(context, "invitePerson", {
              actorId: allowed.value,
              kind: "invited",
              invitationId,
            });
          }
        }
        // The token was never shown; the reply never says whether the
        // address has an account in another organization (D-068).
        return {
          ok: false,
          issues: made.issues.map((i) =>
            issue(i.path.length === 0 ? [] : ["email"], i.code, i.message),
          ),
        };
      }
      await logAfter(context, "invitePerson", {
        actorId: allowed.value,
        kind: "invited",
        invitationId: made.value.invitationId,
      });
      return {
        ok: true,
        value: Object.freeze({
          invitationId: made.value.invitationId,
          email: made.value.email,
          expiresAt: made.value.expiresAt,
        }),
      };
    },

    async setPersonDisabled(context, userId, disabled) {
      if (typeof disabled !== "boolean") {
        return refusal(["disabled"], "invalid_request", "Disabled is true or false.");
      }
      return run(disabled ? "disablePerson" : "enablePerson", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        if (!viewer.value.system) return notPermitted();
        const member = await visibleMember(tx, who.organizationId, viewer.value, userId);
        if (member === undefined) return unknownPerson();
        const stale = await notRecent<{ readonly changed: boolean }>(tx, context, who);
        if (stale) return stale;
        const changed = await setAccountDisabled(tx, member.userId, disabled);
        if (!changed.ok) return changed;
        if (changed.value.changed) {
          await insertPeopleEvent(tx, {
            id: newRecordId(),
            organizationId: who.organizationId,
            actorId: viewer.value.userId,
            subjectId: member.userId,
            kind: disabled ? "account_disabled" : "account_enabled",
          });
        }
        return changed;
      });
    },

    async grantPersonRole(context, request) {
      return run("grantPersonRole", context, async (tx, who) => {
        const granted = await grantRoleIn(tx, who, request);
        if (!granted.ok) return granted;
        const stale = await notRecent<RoleAssignment>(tx, context, who);
        if (stale) return stale;
        const a = granted.value;
        await insertPeopleEvent(tx, {
          id: newRecordId(),
          organizationId: who.organizationId,
          actorId: a.grantedBy,
          subjectId: a.userId,
          kind: "role_granted",
          role: a.role,
          siteId: a.siteId,
          scope: a.scope,
        });
        return granted;
      });
    },

    async revokePersonRole(context, assignmentId) {
      return run("revokePersonRole", context, async (tx, who) => {
        if (typeof assignmentId !== "string" || !isRecordId(assignmentId)) {
          return refusal(
            ["assignmentId"],
            "unknown_assignment",
            "There is no such role assignment.",
          );
        }
        const revoked = await revokeRoleIn(tx, who, assignmentId);
        if (!revoked.ok) return revoked;
        const stale = await notRecent<RoleAssignment>(tx, context, who);
        if (stale) return stale;
        const actorId = actorUser(who.actor);
        const a = revoked.value;
        if (actorId === undefined) return notPermitted();
        await insertPeopleEvent(tx, {
          id: newRecordId(),
          organizationId: who.organizationId,
          actorId,
          subjectId: a.userId,
          kind: "role_revoked",
          role: a.role,
          siteId: a.siteId,
          scope: a.scope,
        });
        return revoked;
      });
    },

    async resetPersonSecondStep(context, userId, input, keys, deliver) {
      const target = await accountAction(context, "resetPersonSecondStep", userId);
      if (!target.ok) return target;
      const reset = await resetSecondFactor(
        db,
        keys,
        context.sessionToken,
        target.value.userId,
        input,
        deliver,
        { onError: report("resetSecondFactor"), memberOf: context.organizationId },
      );
      if (!reset.ok) return fromDatabase(reset);
      await logAfter(context, "resetPersonSecondStep", {
        actorId: target.value.actorId,
        subjectId: target.value.userId,
        kind: "second_factor_reset",
      });
      return {
        ok: true,
        value: Object.freeze({
          hadFactor: reset.value.reset,
          ended: reset.value.ended,
          delivered: reset.value.delivered,
        }),
      };
    },

    async sendPersonPasswordReset(context, userId, options, deliver) {
      if (options !== undefined && !hasOnly(options, ["confirmMailboxOnly"])) {
        return refusal(["options"], "invalid_request", "The option is confirmMailboxOnly.");
      }
      const confirmed = own(options, "confirmMailboxOnly") === true;
      const target = await run<{ readonly actorId: UserId; readonly userId: UserId }>(
        "sendPersonPasswordReset",
        context,
        async (tx, who) => {
          const viewer = await viewerOf(tx, who);
          if (!viewer.ok) return viewer;
          if (!viewer.value.system) return notPermitted();
          const member = await visibleMember(tx, who.organizationId, viewer.value, userId);
          if (member === undefined) return unknownPerson();
          const second = await memberSecondStep(tx, member.userId);
          // D-078: with no second factor in use (never set up, or just
          // reset), whoever reads the mailbox gets the account: a new password
          // and, with the emailed set-up token, a new authenticator.
          if (!second.inUse && !confirmed) {
            return refusal(
              ["confirmMailboxOnly"],
              "confirm_mailbox_only",
              "This person has no two-step sign-in in use, so whoever reads their mailbox could take over the account. Confirm who they are another way first, then confirm sending.",
            );
          }
          return { ok: true, value: { actorId: viewer.value.userId, userId: member.userId } };
        },
      );
      if (!target.ok) return target;
      const sent = await sendPasswordReset(db, context.sessionToken, target.value.userId, deliver, {
        onError: report("sendPasswordReset"),
        memberOf: context.organizationId,
      });
      if (!sent.ok) {
        // A link that may still be live (its withdrawal failed) or was
        // replaced by the person's own request while sent: logged too.
        if (
          sent.issues.some(
            (i) => i.code === "delivery_failed_may_be_pending" || i.code === "superseded",
          )
        ) {
          await logAfter(context, "sendPersonPasswordReset", {
            actorId: target.value.actorId,
            subjectId: target.value.userId,
            kind: "password_reset_sent",
          });
        }
        return fromDatabase(sent);
      }
      await logAfter(context, "sendPersonPasswordReset", {
        actorId: target.value.actorId,
        subjectId: target.value.userId,
        kind: "password_reset_sent",
      });
      return { ok: true, value: Object.freeze({ expiresAt: sent.value.expiresAt }) };
    },

    async endPersonSessions(context, userId) {
      const target = await accountAction(context, "endPersonSessions", userId);
      if (!target.ok) return target;
      const ended = await endUserSessions(db, context.sessionToken, target.value.userId, {
        onError: report("endUserSessions"),
        memberOf: context.organizationId,
      });
      if (!ended.ok) return fromDatabase(ended);
      await logAfter(context, "endPersonSessions", {
        actorId: target.value.actorId,
        subjectId: target.value.userId,
        kind: "sessions_ended",
      });
      return { ok: true, value: Object.freeze({ ended: ended.value.ended }) };
    },

    async authorizeSystemUpdate(context, options) {
      return run("authorizeSystemUpdate", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        if (!permits(access.value, "system.settings", { on: "organization" })) {
          return notPermitted();
        }
        if (options.fresh) {
          const stale = await notRecent<{ readonly userId: UserId }>(tx, context, who);
          if (stale) return stale;
        }
        return { ok: true, value: Object.freeze({ userId: access.userId }) };
      });
    },

    async auditTrail(context, filter) {
      const keys = ["person", "record", "from", "to", "after", "limit"];
      if (filter !== undefined && !hasOnly(filter, keys)) {
        return refusal(["filter"], "invalid_request", `The filters are ${keys.join(", ")}.`);
      }
      const person = own(filter, "person");
      const record = own(filter, "record");
      const after = own(filter, "after");
      const limit = own(filter, "limit") ?? DEFAULT_AUDIT_PAGE;
      const from = timeBound(own(filter, "from"));
      const to = timeBound(own(filter, "to"));
      if (person !== undefined && !isUserId(person)) {
        return refusal(["person"], "invalid_id", "A person's ID is a lowercase version 4 UUID.");
      }
      if (record !== undefined && !isRecordId(record)) {
        return refusal(["record"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
      }
      if (from === false || to === false) {
        return refusal(
          [from === false ? "from" : "to"],
          "invalid_date",
          "A date is YYYY-MM-DD or a UTC time.",
        );
      }
      if (after !== undefined && !isAuditCursor(after)) {
        return refusal(["after"], "invalid_cursor", "This is not where a page of the log ends.");
      }
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_AUDIT_PAGE
      ) {
        return refusal(
          ["limit"],
          "invalid_limit",
          `A page holds 1 to ${String(MAX_AUDIT_PAGE)} entries.`,
        );
      }
      return run("auditTrail", context, async (tx, who) => {
        const viewer = await viewerOf(tx, who);
        if (!viewer.ok) return viewer;
        const v = viewer.value;
        const all = (await organizationSiteIds(tx, who.organizationId)) as readonly SiteId[];
        const records = v.system ? "all" : wholeSitesHolding(v.access, "records.history", all);
        const people = v.system ? "all" : v.sites;
        if (records !== "all" && records.length === 0 && people !== "all" && people.length === 0) {
          return notPermitted();
        }
        // As search and the queue (D-066, D-079, D-082): a statement_timeout
        // for the trail's own statement, so a slow one stops (review).
        await tx.rows(
          sql`SELECT set_config('statement_timeout', ${String(searchTimeoutMs)}, true)`,
        );
        try {
          return {
            ok: true,
            value: await readAuditTrail(
              tx,
              who.organizationId,
              { records, people },
              {
                ...(person === undefined ? {} : { actorId: person }),
                ...(record === undefined ? {} : { recordId: record }),
                ...(from === undefined ? {} : { from }),
                ...(to === undefined ? {} : { to }),
                ...(after === undefined ? {} : { after }),
                limit,
              },
            ),
          };
        } catch (error) {
          if (sqlStateOf(error) === "57014") {
            return refusal([], "timeout", "Reading the audit trail took too long and was stopped.");
          }
          throw error;
        }
      });
    },
  };
}
