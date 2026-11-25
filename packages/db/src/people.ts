/**
 * People in an organization, the change log of what administrators do to
 * them, and the organization-wide audit trail (T-048, D-084). Reads and
 * writes for the service's people operations (`packages/service/src/
 * people.ts`), which decide every permission; nothing here checks who is
 * asking, except `actingSession`, which reads the asker's own session.
 *
 * Nothing here returns a password hash, a token or its hash, a client
 * address or a second factor's secret. Session rows are listed by ID,
 * organization, stage, times and label only (as `listSessions`, D-069).
 */
import {
  isBuiltInRole,
  isOrganizationId,
  isRecordId,
  isSiteId,
  isUserId,
  issue,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { readActingSession, tokenHash } from "./sessions.js";
import { sql, type Sql } from "./sql.js";
import type { SystemEventKind } from "./system-events.js";

/** The writer's grants for this module's table (D-067): the change log is insert-only. */
export const PEOPLE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  people_events: Object.freeze(["INSERT"]),
});

// ---------------------------------------------------------------------------
// The asker's own session

/**
 * The live full session `token` names, as the person acting: their user ID
 * and whether they entered their password and second step in the last 10
 * minutes (D-069, D-077). Read in the caller's transaction, without locking
 * or refreshing it. `undefined` for anything else.
 */
export async function actingSession(
  tx: Queryable,
  token: unknown,
): Promise<{ readonly userId: UserId; readonly recent: boolean } | undefined> {
  const hash = tokenHash(token);
  if (hash === undefined) return undefined;
  const acting = await readActingSession(tx, hash);
  return acting === undefined ? undefined : { userId: acting.userId, recent: acting.recent };
}

// ---------------------------------------------------------------------------
// Members

/** One member of an organization, as the people screens show them. */
export interface Member {
  readonly userId: UserId;
  readonly displayName: string;
  readonly email: string;
  readonly systemAdmin: boolean;
  readonly disabled: boolean;
  readonly addedAt: string;
  readonly lastSignInAt: string | null;
  /** No role assignment at all, read in the same statement as the rest (T-064). */
  readonly roleless: boolean;
}

interface MemberRow {
  user_id: UserId;
  display_name: string;
  email: string;
  system_admin: boolean;
  disabled: boolean;
  added_at: string;
  last_sign_in_at: string | null;
  roleless: boolean;
}

const MEMBER_COLUMNS = sql`
  u.id::text AS user_id, u.display_name, u.email, u.system_admin,
  u.disabled_at IS NOT NULL AS disabled, to_char(m.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS added_at,
  to_char(u.last_sign_in_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_sign_in_at,
  NOT EXISTS (SELECT 1 FROM public.role_assignments g
              WHERE g.organization_id = m.organization_id AND g.user_id = m.user_id) AS roleless`;

function memberFromRow(r: MemberRow): Member {
  return Object.freeze({
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    systemAdmin: r.system_admin,
    disabled: r.disabled,
    addedAt: r.added_at,
    lastSignInAt: r.last_sign_in_at,
    roleless: r.roleless,
  });
}

/** The most members `listMembers` returns at once. */
export const MAX_MEMBERS = 2000;

/**
 * The organization's members, by name, at most `MAX_MEMBERS` (`truncated`
 * when there are more). With `visibleTo`, only those holding a role on one
 * of these sites or on every site for the whole catalog (S-042), or no role at all in the
 * organization (a site manager's view, D-074: people who work only on other
 * sites are not shown).
 */
export async function listMembers(
  db: Queryable,
  organizationId: OrganizationId,
  options: { readonly visibleTo?: readonly SiteId[] } = {},
): Promise<{ readonly members: readonly Member[]; readonly truncated: boolean }> {
  if (!isOrganizationId(organizationId)) return { members: [], truncated: false };
  const sites = options.visibleTo?.filter((s) => isSiteId(s)) ?? null;
  const rows = await db.rows<MemberRow>(sql`
    SELECT ${MEMBER_COLUMNS}
    FROM public.organization_members m JOIN public.users u ON u.id = m.user_id
    WHERE m.organization_id = ${organizationId}::uuid
      AND (${sites === null}::boolean
           OR EXISTS (SELECT 1 FROM public.role_assignments g
                      WHERE g.organization_id = m.organization_id AND g.user_id = m.user_id
                        AND (g.site_id = ANY (${sites ?? []}::uuid[])
                             -- A role on every site includes the viewer's (S-042).
                             OR (g.site_id IS NULL AND g.scope_record_id IS NULL
                                 AND cardinality(${sites ?? []}::uuid[]) > 0)))
           OR NOT EXISTS (SELECT 1 FROM public.role_assignments g
                          WHERE g.organization_id = m.organization_id AND g.user_id = m.user_id))
    ORDER BY lower(u.display_name), u.id
    LIMIT ${MAX_MEMBERS + 1}`);
  return Object.freeze({
    members: Object.freeze(rows.slice(0, MAX_MEMBERS).map(memberFromRow)),
    truncated: rows.length > MAX_MEMBERS,
  });
}

/** One member of the organization, or `undefined` (not a member, or no such account). */
export async function readMember(
  db: Queryable,
  organizationId: OrganizationId,
  userId: string,
): Promise<Member | undefined> {
  if (!isOrganizationId(organizationId) || !isUserId(userId)) return undefined;
  const [row] = await db.rows<MemberRow>(sql`
    SELECT ${MEMBER_COLUMNS}
    FROM public.organization_members m JOIN public.users u ON u.id = m.user_id
    WHERE m.organization_id = ${organizationId}::uuid AND m.user_id = ${userId}::uuid`);
  return row === undefined ? undefined : memberFromRow(row);
}

/** A person's role assignment, as the people screens list it. */
export interface MemberGrant {
  readonly id: string;
  readonly role: string;
  readonly siteId: SiteId | null;
  readonly scope: string | null;
  readonly grantedAt: string;
}

/**
 * The person's role assignments in the organization, oldest first. With
 * `siteIds`, only those on these sites (never on every site), and with
 * `exceptRole`, not that role: what a site manager may manage (D-072).
 */
export async function memberGrants(
  db: Queryable,
  organizationId: OrganizationId,
  userId: UserId,
  options: { readonly siteIds?: readonly SiteId[]; readonly exceptRole?: string } = {},
): Promise<readonly MemberGrant[]> {
  if (!isOrganizationId(organizationId) || !isUserId(userId)) return [];
  const sites = options.siteIds?.filter((s) => isSiteId(s)) ?? null;
  const rows = await db.rows<{
    id: string;
    role: string;
    site_id: SiteId | null;
    scope: string | null;
    granted_at: string;
  }>(sql`
    SELECT id::text AS id, role, site_id::text AS site_id, scope_record_id::text AS scope,
           to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at
    FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid
      AND (${sites === null}::boolean OR site_id = ANY (${sites ?? []}::uuid[]))
      AND (${options.exceptRole ?? null}::text IS NULL OR role <> ${options.exceptRole ?? null}::text)
    ORDER BY granted_at, id
    LIMIT 1000`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        role: r.role,
        siteId: r.site_id,
        scope: r.scope,
        grantedAt: r.granted_at,
      }),
    ),
  );
}

/**
 * The role assignments of several people at once (one query), with
 * `memberGrants`'s options; every ID asked for is in the map.
 */
export async function membersGrants(
  db: Queryable,
  organizationId: OrganizationId,
  userIds: readonly UserId[],
  options: { readonly siteIds?: readonly SiteId[]; readonly exceptRole?: string } = {},
): Promise<ReadonlyMap<UserId, readonly MemberGrant[]>> {
  const ids = userIds.filter((id) => isUserId(id));
  const out = new Map<UserId, MemberGrant[]>(ids.map((id) => [id, []]));
  if (!isOrganizationId(organizationId) || ids.length === 0) return out;
  const sites = options.siteIds?.filter((s) => isSiteId(s)) ?? null;
  const rows = await db.rows<{
    user_id: UserId;
    id: string;
    role: string;
    site_id: SiteId | null;
    scope: string | null;
    granted_at: string;
  }>(sql`
    SELECT user_id::text AS user_id, id::text AS id, role, site_id::text AS site_id,
           scope_record_id::text AS scope,
           to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at
    FROM public.role_assignments
    WHERE organization_id = ${organizationId}::uuid AND user_id = ANY (${ids}::uuid[])
      AND (${sites === null}::boolean OR site_id = ANY (${sites ?? []}::uuid[]))
      AND (${options.exceptRole ?? null}::text IS NULL OR role <> ${options.exceptRole ?? null}::text)
    ORDER BY user_id, granted_at, id`);
  for (const r of rows) {
    out.get(r.user_id)?.push(
      Object.freeze({
        id: r.id,
        role: r.role,
        siteId: r.site_id,
        scope: r.scope,
        grantedAt: r.granted_at,
      }),
    );
  }
  return out;
}

/** A person's live session, as an administrator sees it: never a token, hash or address. */
export interface MemberSession {
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly stage: "second_step" | "full";
  readonly signedInAt: string;
  readonly lastSeenAt: string;
  readonly label: string | null;
}

/** The person's live sessions in every organization, newest use first, at most 200. */
export async function memberSessions(
  db: Queryable,
  userId: UserId,
): Promise<readonly MemberSession[]> {
  if (!isUserId(userId)) return [];
  const rows = await db.rows<{
    id: string;
    organization_id: string | null;
    stage: "second_step" | "full";
    signed_in_at: string;
    last_seen_at: string;
    label: string | null;
  }>(sql`
    SELECT s.id::text AS id, s.organization_id::text AS organization_id, s.stage,
           to_char(s.signed_in_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_in_at, to_char(s.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at,
           s.client_label AS label
    FROM public.sessions s
    WHERE s.user_id = ${userId}::uuid AND public.session_live(s)
      AND public.session_access_ok(s.user_id, s.organization_id, s.signed_in_at)
    ORDER BY s.last_seen_at DESC, s.id
    LIMIT 200`);
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        sessionId: r.id,
        organizationId: r.organization_id,
        stage: r.stage,
        signedInAt: r.signed_in_at,
        lastSeenAt: r.last_seen_at,
        label: r.label,
      }),
    ),
  );
}

/** Two-step sign-in as an administrator sees it, and the wrong-code alerts (D-077). */
export interface MemberSecondStep {
  /** A factor in use (confirmed and not revoked). */
  readonly inUse: boolean;
  readonly enrolledAt: string | null;
  /** Rows of `second_step_alerts` in the last 30 days: someone typed wrong codes. */
  readonly recentAlerts: number;
  readonly lastAlertAt: string | null;
  /**
   * The newest of those (at most `MEMBER_ALERTS_LISTED`), each with what the
   * notice sender made of it (D-085): `emailed` (the person and the system
   * admins were sent the notice), `covered` (an earlier notice in the window
   * covered it, or it was seen too late), `pending` (not yet handled). An
   * email lost in a crash or a long outage still leaves this trace.
   */
  readonly alerts: readonly {
    readonly at: string;
    readonly failures: number;
    readonly notice: "emailed" | "covered" | "pending";
  }[];
}

/** Alerts listed on a person's page at most. */
export const MEMBER_ALERTS_LISTED = 10;

export async function memberSecondStep(db: Queryable, userId: UserId): Promise<MemberSecondStep> {
  const [row] = await db.rows<{
    enrolled_at: string | null;
    alerts: number;
    last_alert: string | null;
  }>(sql`
    SELECT (SELECT to_char(f.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM public.second_factors f
            WHERE f.user_id = ${userId}::uuid AND f.state = 'active') AS enrolled_at,
           (SELECT count(*)::int FROM public.second_step_alerts a
            WHERE a.user_id = ${userId}::uuid
              AND a.created_at > clock_timestamp() - interval '30 days') AS alerts,
           (SELECT to_char(max(a.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM public.second_step_alerts a
            WHERE a.user_id = ${userId}::uuid) AS last_alert`);
  const listed = await db.rows<{ at: string; failures: number; outcome: string | null }>(sql`
    SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
           a.failures, n.outcome
    FROM public.second_step_alerts a
    LEFT JOIN public.second_step_alert_notices n ON n.alert_id = a.id
    WHERE a.user_id = ${userId}::uuid
      AND a.created_at > clock_timestamp() - interval '30 days'
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${MEMBER_ALERTS_LISTED}`);
  return Object.freeze({
    inUse: row?.enrolled_at != null,
    enrolledAt: row?.enrolled_at ?? null,
    recentAlerts: row?.alerts ?? 0,
    lastAlertAt: row?.last_alert ?? null,
    alerts: Object.freeze(
      listed.map((a) =>
        Object.freeze({
          at: a.at,
          failures: a.failures,
          notice:
            a.outcome === "notified"
              ? ("emailed" as const)
              : a.outcome === "folded"
                ? ("covered" as const)
                : ("pending" as const),
        }),
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Invitations whose sending failed (T-048 review: logged too)

/** The database's clock now, in the form `invitationMadeSince` takes. */
export async function databaseNow(db: Queryable): Promise<string> {
  const [row] = await db.rows<{ now: string }>(
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS now`,
  );
  return row?.now ?? "1970-01-01T00:00:00.000000";
}

/**
 * The newest invitation `inviter` made for `email` in the organization since
 * `since` (`databaseNow`), whatever became of it: for the change log when
 * `createInvitation` answers without an ID (its message failed or was
 * superseded).
 */
export async function invitationMadeSince(
  db: Queryable,
  organizationId: OrganizationId,
  inviter: UserId,
  email: string,
  since: string,
): Promise<string | undefined> {
  const [row] = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.invitations
    WHERE organization_id = ${organizationId}::uuid AND invited_by = ${inviter}::uuid
      AND email = lower(${email}) AND created_at >= (${since}::timestamp AT TIME ZONE 'UTC')
    ORDER BY created_at DESC, id DESC LIMIT 1`);
  return row?.id;
}

// ---------------------------------------------------------------------------
// Disabling

/**
 * Disables or re-enables an account (install-wide, D-068), with its user
 * row locked. Disabling ends every session (0010's trigger moves
 * `sessions_valid_after`); re-enabling revives none. `unchanged` when it
 * was already so; `last_system_admin` when it is the last active system
 * admin (0020's trigger, for every writer).
 */
export async function setAccountDisabled(
  tx: Queryable,
  userId: UserId,
  disabled: boolean,
): Promise<Validated<{ readonly changed: boolean }>> {
  if (!isUserId(userId)) {
    return { ok: false, issues: [issue(["userId"], "unknown_person", "No such person.")] };
  }
  try {
    const rows = await tx.rows(sql`
      UPDATE public.users
      SET disabled_at = CASE WHEN ${disabled}::boolean THEN clock_timestamp() ELSE NULL END
      WHERE id = ${userId}::uuid AND (disabled_at IS NOT NULL) <> ${disabled}::boolean
      RETURNING 1`);
    return { ok: true, value: Object.freeze({ changed: rows.length > 0 }) };
  } catch (error) {
    if (constraintOf(error) === "users_last_system_admin") {
      return {
        ok: false,
        issues: [
          issue(
            ["userId"],
            "last_system_manager",
            "This is the last active system manager, so the account stays enabled.",
          ),
        ],
      };
    }
    throw error;
  }
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(error, "constraint");
  return d !== undefined && typeof d.value === "string" ? d.value : undefined;
}

// ---------------------------------------------------------------------------
// The change log

export const PEOPLE_EVENT_KINDS = Object.freeze([
  "invited",
  "account_disabled",
  "account_enabled",
  "role_granted",
  "role_revoked",
  "second_factor_reset",
  "password_reset_sent",
  "sessions_ended",
] as const);

export type PeopleEventKind = (typeof PEOPLE_EVENT_KINDS)[number];

export interface NewPeopleEvent {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly actorId: UserId;
  readonly kind: PeopleEventKind;
  readonly subjectId?: UserId | null;
  readonly role?: string | null;
  readonly siteId?: SiteId | null;
  readonly scope?: string | null;
  readonly invitationId?: string | null;
}

/** Appends one row to the change log, stamped now by the database. */
export async function insertPeopleEvent(tx: Queryable, event: NewPeopleEvent): Promise<void> {
  if (
    !isRecordId(event.id) ||
    !isOrganizationId(event.organizationId) ||
    !isUserId(event.actorId) ||
    !PEOPLE_EVENT_KINDS.includes(event.kind) ||
    (event.role != null && !isBuiltInRole(event.role))
  ) {
    throw new TypeError("insertPeopleEvent: a malformed event.");
  }
  await tx.execute(sql`
    INSERT INTO public.people_events
      (organization_id, id, actor_id, subject_id, kind, role, site_id, scope_record_id,
       invitation_id)
    VALUES (${event.organizationId}::uuid, ${event.id}::uuid, ${event.actorId}::uuid,
            ${event.subjectId ?? null}::uuid, ${event.kind}, ${event.role ?? null}::text,
            ${event.siteId ?? null}::uuid, ${event.scope ?? null}::uuid,
            ${event.invitationId ?? null}::uuid)`);
}

// ---------------------------------------------------------------------------
// The audit trail

/** What the trail is filtered by; every field optional. */
export interface AuditFilter {
  /** Only changes made by this person (user ID). */
  readonly actorId?: UserId;
  /** Only this record's versions (people events have no record). */
  readonly recordId?: string;
  /** Inclusive lower and exclusive upper bounds, ISO times. */
  readonly from?: string;
  readonly to?: string;
  /** The previous page's `next`. */
  readonly after?: string;
  /** 1 to `MAX_AUDIT_PAGE`. */
  readonly limit?: number;
}

/** Which rows the viewer may see (the service decides; D-084). */
export interface AuditScope {
  /** Record versions: every record, records whose current home site is one of these, or none. */
  readonly records: "all" | readonly SiteId[];
  /** People events: all of the organization's, role changes on these sites (no site manager grants), or none. */
  readonly people: "all" | readonly SiteId[];
  /** Changes to the server itself (installs, rollbacks: T-060a): system managers only. */
  readonly system?: boolean;
  /**
   * Accession saves (S-064, D-117): only for those who may read donor
   * matters on every site (`donors.view`, D-036); the service decides.
   */
  readonly accessions?: boolean;
}

export const MAX_AUDIT_PAGE = 100;
export const DEFAULT_AUDIT_PAGE = 50;

/** One line of the audit trail. */
export type AuditEntry =
  | {
      readonly type: "record";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly recordId: string;
      readonly version: number;
      readonly action: string;
      readonly title: string | null;
      readonly kind: string | null;
      readonly changedFields: readonly string[];
      readonly reason: string | null;
      /** The record has been deleted (its history stays, D-067). */
      readonly deleted: boolean;
    }
  | {
      readonly type: "people";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: PeopleEventKind;
      readonly subjectId: string | null;
      readonly subjectName: string | null;
      readonly role: string | null;
      readonly siteId: string | null;
      readonly scope: string | null;
      /** For invitations, the address invited. */
      readonly invitedEmail: string | null;
    }
  | {
      readonly type: "system";
      readonly at: string;
      /**
       * `user:<id>`, `command_line` for a command on the server, or `timer`
       * for the daily purge (S-052).
       */
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: SystemEventKind;
      /** The version after an update; "" for a purge (S-052). */
      readonly version: string;
      readonly fromVersion: string | null;
      /** A purge's contents and bytes (S-052); null for an update. */
      readonly files: number | null;
      readonly bytes: number | null;
    }
  | {
      /**
       * A definition the records lean on was made or changed (S-064, D-117):
       * an identifier type, a term, a site, the storage levels or a
       * location, a Dublin Core mapping or (system managers only) the
       * System settings.
       */
      readonly type: "definition";
      readonly at: string;
      /** `user:<id>`, or `command_line` for set-up or a command on the server. */
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly subject: DefinitionSubject;
      /** The type's key, the term's, site's or location's ID, the mapping's template; null for the levels and settings. */
      readonly key: string | null;
      readonly action: "created" | "changed";
      /** Its name or label after the change, where it has one. */
      readonly name: string | null;
      /** The stored properties that changed (empty when created). */
      readonly changes: readonly string[];
    }
  | {
      /** A file attached to a record or removed from it (M-002). */
      readonly type: "file";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: "attached" | "removed";
      readonly recordId: string;
      /** The record's title now; null once it has been deleted. */
      readonly title: string | null;
      readonly fileId: string;
      readonly bytes: number;
    }
  | {
      /** A record moved to a storage location (T-018d). */
      readonly type: "move";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly recordId: string;
      readonly title: string | null;
      readonly locationId: string;
      readonly locationName: string | null;
    }
  | {
      /** An accession saved (T-018c); only with `donors.view` on every site (scope.accessions). */
      readonly type: "accession";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly accessionId: string;
      readonly version: number;
      readonly number: string | null;
    }
  | {
      /**
       * A step in a share's life (T-041c): offered, accepted or declined,
       * then withdrawn or removed (by a person) or ended because the
       * record was deleted or moved (`automatic`). In the home
       * organization's trail only, for those who see the record.
       */
      readonly type: "share";
      readonly at: string;
      /**
       * `user:<id>`; `automatic` for an ending the database made;
       * `other_organization` for someone of the receiving organization.
       */
      readonly actor: string;
      readonly actorName: string | null;
      readonly shareId: string;
      readonly kind: ShareStep;
      readonly recordId: string;
      /** The record's title; null once deleted. */
      readonly title: string | null;
      readonly deleted: boolean;
      readonly targetSiteId: string | null;
    };

export const DEFINITION_SUBJECTS = Object.freeze([
  "identifier_type",
  "term",
  "site",
  "storage_levels",
  "storage_location",
  "dublin_core_mapping",
  "system_settings",
] as const);
export type DefinitionSubject = (typeof DEFINITION_SUBJECTS)[number];

export type ShareStep =
  "offered" | "accepted" | "declined" | "withdrawn" | "removed" | "deleted" | "moved";

/**
 * The top-level properties (and one level into a stored `definition`,
 * `mapping` or `settings` document) whose values differ, sorted.
 */
export function changedProperties(before: unknown, after: unknown): readonly string[] {
  const plain = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const a = plain(before);
  const b = plain(after);
  const out = new Set<string>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "version") continue;
    const x = a[key];
    const y = b[key];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const nested = key === "definition" || key === "mapping" || key === "settings";
    const xs = plain(x);
    const ys = plain(y);
    if (nested && (Object.keys(xs).length > 0 || Object.keys(ys).length > 0)) {
      for (const inner of new Set([...Object.keys(xs), ...Object.keys(ys)])) {
        if (JSON.stringify(xs[inner]) !== JSON.stringify(ys[inner])) out.add(inner);
      }
    } else {
      out.add(key);
    }
  }
  return Object.freeze([...out].sort());
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly next: string | null;
}

/** `<time to the microsecond>_<r|e|s|d|f|m|a|h><key>`, as `next` gives it. */
const AUDIT_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_((?:[ra][0-9a-f-]{36}:\d{10})|(?:[esdfm][0-9a-f-]{36})|(?:h[0-9a-f-]{36}:[ode]))$/;

export function isAuditCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  const match = AUDIT_CURSOR.exec(value);
  return match?.[1] !== undefined && isRealTime(match[1]);
}

/**
 * Whether `YYYY-MM-DDTHH:MM:SS.ffffff` names a real moment from year 1 to
 * 9999 (no 13th month, 30 February or hour 99): it reads back the same
 * after a round trip through `Date` (to the millisecond; the microseconds
 * are digits by the pattern).
 */
function isRealTime(text: string): boolean {
  const year = Number(text.slice(0, 4));
  if (!Number.isInteger(year) || year < 1) return false;
  const time = new Date(`${text.slice(0, 23)}Z`);
  return !Number.isNaN(time.getTime()) && time.toISOString().slice(0, 23) === text.slice(0, 23);
}

interface AuditRow {
  type: "record" | "people" | "system" | "definition" | "file" | "move" | "accession" | "share";
  at: string;
  position: string;
  actor: string;
  actor_name: string | null;
  record_id: string | null;
  version: number | null;
  action: string | null;
  title: string | null;
  record_kind: string | null;
  changed_fields: string[] | null;
  reason: string | null;
  deleted: boolean | null;
  event_id: string | null;
  kind: string | null;
  subject_id: string | null;
  subject_name: string | null;
  role: string | null;
  site_id: string | null;
  scope: string | null;
  invited_email: string | null;
  version_to: string | null;
  version_from: string | null;
  file_count: number | null;
  byte_count: number | null;
  detail: Record<string, unknown> | null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The S-064 kinds of line (D-117); `undefined` for the older three. */
function auditEntryOf(r: AuditRow): AuditEntry | undefined {
  const detail = r.detail ?? {};
  const base = { at: r.at, actor: r.actor, actorName: r.actor_name };
  switch (r.type) {
    case "definition":
      return Object.freeze({
        type: "definition" as const,
        ...base,
        eventId: r.event_id ?? "",
        subject: (r.kind ?? "term") as DefinitionSubject,
        key: text(detail.key),
        action: r.action === "created" ? ("created" as const) : ("changed" as const),
        name: r.title,
        changes:
          r.action === "created"
            ? Object.freeze([] as string[])
            : changedProperties(detail.before, detail.after),
      });
    case "file":
      return Object.freeze({
        type: "file" as const,
        ...base,
        eventId: r.event_id ?? "",
        kind: r.kind === "removed" ? ("removed" as const) : ("attached" as const),
        recordId: r.record_id ?? "",
        title: r.title,
        fileId: text(detail.fileId) ?? "",
        bytes: r.byte_count ?? 0,
      });
    case "move":
      return Object.freeze({
        type: "move" as const,
        ...base,
        eventId: r.event_id ?? "",
        recordId: r.record_id ?? "",
        title: r.title,
        locationId: text(detail.locationId) ?? "",
        locationName: text(detail.locationName),
      });
    case "accession":
      return Object.freeze({
        type: "accession" as const,
        ...base,
        accessionId: r.event_id ?? "",
        version: r.version ?? 0,
        number: text(detail.number),
      });
    case "share":
      return Object.freeze({
        type: "share" as const,
        ...base,
        shareId: r.event_id ?? "",
        kind: (r.kind ?? "offered") as ShareStep,
        recordId: r.record_id ?? "",
        title: r.title,
        deleted: r.deleted === true,
        targetSiteId: r.site_id,
      });
    default:
      return undefined;
  }
}

/**
 * The organization's change log, newest first, a page at a time: record
 * versions (every save, deletion and workflow move, deleted records'
 * included), people events and, for system managers, changes to the server
 * itself (installs and rollbacks, T-060a), filtered in the query by `scope` (so a
 * page's length never shows that hidden rows matched) and by `filter`.
 * Since S-064 (D-117) it also shows definitions made or changed, files
 * attached and removed, moves, accession saves and share steps, each
 * scoped as its own comment in the query says.
 * Names are given for actors and subjects who are members of the
 * organization or system admins; anyone else is an ID only.
 */
export async function readAuditTrail(
  db: Queryable,
  organizationId: OrganizationId,
  scope: AuditScope,
  filter: AuditFilter,
): Promise<AuditPage> {
  const limit = filter.limit ?? DEFAULT_AUDIT_PAGE;
  const cursor = filter.after === undefined ? null : AUDIT_CURSOR.exec(filter.after);
  const recordSites = scope.records === "all" ? null : scope.records.filter((s) => isSiteId(s));
  const peopleSites = scope.people === "all" ? null : scope.people.filter((s) => isSiteId(s));
  const wantRecords = recordSites === null || recordSites.length > 0;
  const wantPeople = (peopleSites === null || peopleSites.length > 0) && !filter.recordId;
  const wantSystem = scope.system === true && !filter.recordId;
  const actor = filter.actorId ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const cursorAt = cursor?.[1] ?? null;
  const cursorKey = cursor?.[2] ?? null;
  // Each kind of entry is read newest first and only one page of it (S-066):
  // with its `(organization_id, time DESC)` index, a long history costs a
  // page per kind, not the whole table. The outer query then merges them.
  // Each part's columns are typed here: a part on its own would read its
  // blank (NULL) columns as text.
  const paged = (branch: Sql): Sql => sql`(
      SELECT b.type::text, b.at::timestamptz, b.key::text, b.actor::text, b.record_id::text,
             b.version::integer, b.action::text, b.title::text, b.record_kind::text,
             b.changed_fields::text[], b.reason::text, b.deleted::boolean, b.event_id::text,
             b.kind::text, b.subject_id::uuid, b.role::text, b.site_id::text, b.scope::text,
             b.invitation_id::uuid, b.version_to::text, b.version_from::text,
             b.file_count::integer, b.byte_count::bigint, b.detail::jsonb
      FROM (${branch}) AS b (type, at, key, actor, record_id, version, action, title,
                             record_kind, changed_fields, reason, deleted, event_id, kind,
                             subject_id, role, site_id, scope, invitation_id, version_to,
                             version_from, file_count, byte_count, detail)
      WHERE ${cursorAt}::text IS NULL
         OR (b.at <= (${cursorAt}::timestamp AT TIME ZONE 'UTC')
             AND (b.at, b.key) < ((${cursorAt}::timestamp AT TIME ZONE 'UTC'), ${cursorKey}::text))
      ORDER BY b.at DESC, b.key DESC
      LIMIT ${limit + 1})`;
  const rows = await db.rows<AuditRow>(sql`
    WITH names AS (
      SELECT u.id, u.display_name FROM public.users u
      WHERE u.system_admin
         OR EXISTS (SELECT 1 FROM public.organization_members m
                    WHERE m.organization_id = ${organizationId}::uuid AND m.user_id = u.id)
    ),
    entries AS (
      ${paged(sql`
      SELECT 'record' AS type, v.recorded_at AS at,
             'r' || v.record_id::text || ':' || lpad(v.version::text, 10, '0') AS key,
             v.actor, v.record_id::text AS record_id, v.version, v.action,
             v.record ->> 'title' AS title, v.record ->> 'kind' AS record_kind,
             v.changed_fields, v.reason,
             NOT EXISTS (SELECT 1 FROM public.records r
                         WHERE r.organization_id = v.organization_id AND r.id = v.record_id)
               AS deleted,
             NULL::text AS event_id, NULL::text AS kind, NULL::uuid AS subject_id,
             NULL::text AS role, NULL::text AS site_id, NULL::text AS scope,
             NULL::uuid AS invitation_id, NULL::text AS version_to, NULL::text AS version_from,
             NULL::integer AS file_count, NULL::bigint AS byte_count, NULL::jsonb AS detail
      FROM public.record_versions v
      WHERE ${wantRecords}::boolean
        AND v.organization_id = ${organizationId}::uuid
        AND (${recordSites === null}::boolean
             OR EXISTS (SELECT 1 FROM public.records r
                        WHERE r.organization_id = v.organization_id AND r.id = v.record_id
                          AND r.site_id = ANY (${recordSites ?? []}::uuid[])))
        AND (${actor}::text IS NULL OR v.actor = 'user:' || ${actor}::text)
        AND (${filter.recordId ?? null}::uuid IS NULL OR v.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR v.recorded_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR v.recorded_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      SELECT 'people', e.occurred_at, 'e' || e.id::text,
             'user:' || e.actor_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             e.id::text, e.kind, e.subject_id, e.role, e.site_id::text,
             e.scope_record_id::text, e.invitation_id, NULL, NULL, NULL, NULL, NULL
      FROM public.people_events e
      WHERE ${wantPeople}::boolean
        AND e.organization_id = ${organizationId}::uuid
        AND (${peopleSites === null}::boolean
             OR (e.kind IN ('role_granted', 'role_revoked') AND e.role <> 'site_manager'
                 AND e.site_id = ANY (${peopleSites ?? []}::uuid[])))
        AND (${actor}::uuid IS NULL OR e.actor_id = ${actor}::uuid)
        AND (${from}::timestamptz IS NULL OR e.occurred_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR e.occurred_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- Changes to the server itself (T-060a): no organization's, so only
      -- for system managers (scope.system).
      SELECT 'system', s.occurred_at, 's' || s.id::text,
             CASE WHEN s.actor_id IS NOT NULL THEN 'user:' || s.actor_id::text
                  WHEN s.source IN ('timer', 'lease') THEN s.source ELSE 'command_line' END,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             s.id::text, s.kind, NULL, NULL, NULL, NULL, NULL, s.version, s.from_version,
             s.file_count, s.byte_count, NULL
      FROM public.system_events s
      WHERE ${wantSystem}::boolean
        AND (${actor}::uuid IS NULL OR s.actor_id = ${actor}::uuid)
        AND (${from}::timestamptz IS NULL OR s.occurred_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR s.occurred_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- Definitions made or changed (S-064, D-117): the organization's for
      -- whole-organization viewers, a site's for those who see its records,
      -- the System settings for system managers.
      SELECT 'definition', d.occurred_at, 'd' || d.id::text,
             coalesce(d.actor, 'command_line'), NULL, NULL, d.action,
             coalesce(d.after ->> 'name', d.after ->> 'label',
                      d.after #>> '{definition,name}', d.after #>> '{definition,label}'),
             NULL, NULL, NULL, NULL, d.id::text, d.subject, NULL, NULL,
             CASE WHEN d.subject = 'site' THEN d.subject_key END, NULL, NULL, NULL, NULL, NULL,
             NULL, jsonb_build_object('key', d.subject_key, 'before', d.before, 'after', d.after)
      FROM public.definition_events d
      WHERE ${filter.recordId === undefined}::boolean
        AND ((${wantRecords}::boolean AND d.organization_id = ${organizationId}::uuid
              AND (${recordSites === null}::boolean
                   OR (d.subject = 'site' AND d.subject_key = ANY (${recordSites ?? []}::text[]))))
             OR (${wantSystem}::boolean AND d.organization_id IS NULL))
        AND (${actor}::text IS NULL OR d.actor = 'user:' || ${actor}::text)
        AND (${from}::timestamptz IS NULL OR d.occurred_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR d.occurred_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- Files attached and removed (M-002), scoped like record versions.
      SELECT 'file', f.occurred_at, 'f' || f.id::text, f.actor, f.record_id::text, NULL,
             f.kind, r.title, r.kind, NULL, NULL, r.id IS NULL, f.id::text, f.kind, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, f.byte_size,
             jsonb_build_object('fileId', f.file_id)
      FROM public.stored_file_events f
      LEFT JOIN public.records r ON r.organization_id = f.organization_id AND r.id = f.record_id
      WHERE ${wantRecords}::boolean
        AND f.organization_id = ${organizationId}::uuid
        AND f.kind IN ('attached', 'removed')
        AND (${recordSites === null}::boolean OR r.site_id = ANY (${recordSites ?? []}::uuid[]))
        AND (${actor}::text IS NULL OR f.actor = 'user:' || ${actor}::text)
        AND (${filter.recordId ?? null}::uuid IS NULL OR f.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR f.occurred_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR f.occurred_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- Moves to a storage location (T-018d), scoped like record versions.
      SELECT 'move', m.recorded_at, 'm' || m.id::text, 'user:' || m.recorded_by::text,
             m.record_id::text, NULL, NULL, r.title, r.kind, NULL, NULL, r.id IS NULL,
             m.id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             jsonb_build_object('locationId', m.location_id, 'locationName',
                                l.definition ->> 'name')
      FROM public.storage_moves m
      LEFT JOIN public.records r ON r.organization_id = m.organization_id AND r.id = m.record_id
      LEFT JOIN public.storage_locations l
        ON l.organization_id = m.organization_id AND l.id = m.location_id
      WHERE ${wantRecords}::boolean
        AND m.organization_id = ${organizationId}::uuid
        AND (${recordSites === null}::boolean OR r.site_id = ANY (${recordSites ?? []}::uuid[]))
        AND (${actor}::uuid IS NULL OR m.recorded_by = ${actor}::uuid)
        AND (${filter.recordId ?? null}::uuid IS NULL OR m.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR m.recorded_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR m.recorded_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- Accession saves (T-018c): only with scope.accessions (donors.view on
      -- every site), and only the number (the donor stays on its own page).
      SELECT 'accession', a.saved_at,
             'a' || a.accession_id::text || ':' || lpad(a.version::text, 10, '0'),
             'user:' || a.saved_by::text, NULL, a.version, NULL, NULL, NULL, NULL, NULL, NULL,
             a.accession_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             jsonb_build_object('number', a.definition #>> '{number,value}')
      FROM public.accession_versions a
      WHERE ${scope.accessions === true && filter.recordId === undefined}::boolean
        AND a.organization_id = ${organizationId}::uuid
        AND (${actor}::uuid IS NULL OR a.saved_by = ${actor}::uuid)
        AND (${from}::timestamptz IS NULL OR a.saved_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR a.saved_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      -- A share's steps (T-041c, S-036b), for those who see the record
      -- itself (its home organization, and its home site in their scope;
      -- shares between two sites of one organization included). The
      -- receiving side is never shown here: D-094 shows it its offers and
      -- items by other rules, and 0043 hides a deleted record's shares there
      -- (review). Someone of another organization is never named or given
      -- by ID: other_organization (D-019).
      -- One part per step (S-066), so each reads its own index.
      SELECT 'share', sh.offered_at, 'h' || sh.id::text || ':o', who.actor,
             sh.record_id::text, NULL, NULL, r.title, r.kind, NULL, NULL, r.id IS NULL,
             sh.id::text, 'offered', NULL, NULL, sh.target_site_id::text, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL
      FROM public.record_shares sh
      LEFT JOIN public.records r ON r.organization_id = sh.organization_id AND r.id = sh.record_id
      CROSS JOIN LATERAL (SELECT CASE
        WHEN sh.offered_by IS NULL THEN 'automatic'
        WHEN EXISTS (SELECT 1 FROM names n WHERE n.id = sh.offered_by) THEN 'user:' || sh.offered_by::text
        ELSE 'other_organization' END AS actor) AS who
      WHERE ${wantRecords}::boolean
        AND sh.offered_at IS NOT NULL
        AND sh.organization_id = ${organizationId}::uuid
        AND (${recordSites === null}::boolean OR r.site_id = ANY (${recordSites ?? []}::uuid[]))
        AND (${actor}::text IS NULL OR who.actor = 'user:' || ${actor}::text)
        AND (${filter.recordId ?? null}::uuid IS NULL OR sh.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR sh.offered_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR sh.offered_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      SELECT 'share', sh.decided_at, 'h' || sh.id::text || ':d', who.actor,
             sh.record_id::text, NULL, NULL, r.title, r.kind, NULL, NULL, r.id IS NULL,
             sh.id::text, CASE WHEN sh.state = 'declined' THEN 'declined' ELSE 'accepted' END, NULL, NULL, sh.target_site_id::text, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL
      FROM public.record_shares sh
      LEFT JOIN public.records r ON r.organization_id = sh.organization_id AND r.id = sh.record_id
      CROSS JOIN LATERAL (SELECT CASE
        WHEN sh.decided_by IS NULL THEN 'automatic'
        WHEN EXISTS (SELECT 1 FROM names n WHERE n.id = sh.decided_by) THEN 'user:' || sh.decided_by::text
        ELSE 'other_organization' END AS actor) AS who
      WHERE ${wantRecords}::boolean
        AND sh.decided_at IS NOT NULL
        AND sh.organization_id = ${organizationId}::uuid
        AND (${recordSites === null}::boolean OR r.site_id = ANY (${recordSites ?? []}::uuid[]))
        AND (${actor}::text IS NULL OR who.actor = 'user:' || ${actor}::text)
        AND (${filter.recordId ?? null}::uuid IS NULL OR sh.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR sh.decided_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR sh.decided_at < ${to}::timestamptz)
      `)}
      UNION ALL
      ${paged(sql`
      SELECT 'share', sh.ended_at, 'h' || sh.id::text || ':e', who.actor,
             sh.record_id::text, NULL, NULL, r.title, r.kind, NULL, NULL, r.id IS NULL,
             sh.id::text, sh.state, NULL, NULL, sh.target_site_id::text, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL
      FROM public.record_shares sh
      LEFT JOIN public.records r ON r.organization_id = sh.organization_id AND r.id = sh.record_id
      CROSS JOIN LATERAL (SELECT CASE
        WHEN sh.ended_by IS NULL THEN 'automatic'
        WHEN EXISTS (SELECT 1 FROM names n WHERE n.id = sh.ended_by) THEN 'user:' || sh.ended_by::text
        ELSE 'other_organization' END AS actor) AS who
      WHERE ${wantRecords}::boolean
        AND sh.ended_at IS NOT NULL
        AND sh.organization_id = ${organizationId}::uuid
        AND (${recordSites === null}::boolean OR r.site_id = ANY (${recordSites ?? []}::uuid[]))
        AND (${actor}::text IS NULL OR who.actor = 'user:' || ${actor}::text)
        AND (${filter.recordId ?? null}::uuid IS NULL OR sh.record_id = ${filter.recordId ?? null}::uuid)
        AND (${from}::timestamptz IS NULL OR sh.ended_at >= ${from}::timestamptz)
        AND (${to}::timestamptz IS NULL OR sh.ended_at < ${to}::timestamptz)
      `)}
    )
    SELECT x.type, to_char(x.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
           to_char(x.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '_' || x.key
             AS position,
           x.actor, an.display_name AS actor_name, x.record_id, x.version, x.action, x.title,
           x.record_kind, x.changed_fields, x.reason, x.deleted, x.event_id, x.kind,
           x.subject_id::text AS subject_id, sn.display_name AS subject_name, x.role,
           x.site_id, x.scope, i.email AS invited_email, x.version_to, x.version_from,
           x.file_count, x.byte_count::float8 AS byte_count, x.detail
    FROM entries x
    LEFT JOIN names an ON 'user:' || an.id::text = x.actor
    LEFT JOIN names sn ON sn.id = x.subject_id
    LEFT JOIN public.invitations i
      ON i.organization_id = ${organizationId}::uuid AND i.id = x.invitation_id
    WHERE (${cursorAt}::text IS NULL
           OR (x.at, x.key) < ((${cursorAt}::timestamp AT TIME ZONE 'UTC'), ${cursorKey}::text))
    ORDER BY x.at DESC, x.key DESC
    LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const entries: AuditEntry[] = page.map((r) => {
    const special = auditEntryOf(r);
    if (special !== undefined) return special;
    return r.type === "system"
      ? Object.freeze({
          type: "system" as const,
          at: r.at,
          actor: r.actor,
          actorName: r.actor_name,
          eventId: r.event_id ?? "",
          kind: (r.kind ?? "update_installed") as SystemEventKind,
          version: r.version_to ?? "",
          fromVersion: r.version_from,
          files: r.file_count,
          bytes: r.byte_count,
        })
      : r.type === "record"
        ? Object.freeze({
            type: "record" as const,
            at: r.at,
            actor: r.actor,
            actorName: r.actor_name,
            recordId: r.record_id ?? "",
            version: r.version ?? 0,
            action: r.action ?? "",
            title: r.title,
            kind: r.record_kind,
            changedFields: Object.freeze([...(r.changed_fields ?? [])]),
            reason: r.reason,
            deleted: r.deleted === true,
          })
        : Object.freeze({
            type: "people" as const,
            at: r.at,
            actor: r.actor,
            actorName: r.actor_name,
            eventId: r.event_id ?? "",
            kind: (r.kind ?? "invited") as PeopleEventKind,
            subjectId: r.subject_id,
            subjectName: r.subject_name,
            role: r.role,
            siteId: r.site_id,
            scope: r.scope,
            invitedEmail: r.invited_email,
          });
  });
  const last = page.at(-1);
  return Object.freeze({
    entries: Object.freeze(entries),
    next: rows.length > limit && last !== undefined ? last.position : null,
  });
}
