/**
 * Small reads for the sign-in screens and the admin's frame (T-045, D-081).
 * Each names only what the person who holds the session may see about
 * themselves, and never a token, hash, secret or client address.
 *
 * - `pendingSignInState`: for a session waiting for its second step, which
 *   screen comes next: the code (two-step sign-in is set up) or setting it
 *   up, and whether the one-time set-up link from a system admin's reset is
 *   needed (D-077). Only the holder of a waiting session (who typed the
 *   right password) can ask.
 * - `organizationChoices`: the organizations a person may choose to work
 *   in, with their names, for the "choose an organization" step after a
 *   right code (`choose_organization`, or `organization_required` for a
 *   system admin with no memberships, who may work in any). The HTTP layer
 *   calls it only after the second step said one of those.
 * - `readSignedInPerson`: the signed-in person's own name and address, for
 *   the top bar.
 */
import type { OrganizationId, UserId } from "@oculus/core";
import { isUserId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { readPendingSession, type NoSession, type SessionCallOptions } from "./sessions.js";
import type { SessionFailure } from "./sessions.js";
import { sql } from "./sql.js";

/** Which screen a session waiting for its code needs next. */
export interface PendingSignInState {
  readonly ok: true;
  /** When the waiting session ends (10 minutes after the password). */
  readonly expiresAt: string;
  /** `code` when two-step sign-in is set up, else `set_up`. */
  readonly next: "code" | "set_up";
  /** After a system admin's reset: setting up needs the emailed one-time link (D-077). */
  readonly enrolmentTokenRequired: boolean;
}

/**
 * What the waiting session `token` names needs next, or `NO_SESSION` (also
 * for a full, ended or expired session). Database failures are fixed
 * answers, with the raw error only to `onError`.
 */
export async function pendingSignInState(
  db: Queryable,
  token: unknown,
  options: SessionCallOptions = {},
): Promise<PendingSignInState | NoSession | SessionFailure> {
  const pending = await readPendingSession(db, token, options);
  if (!pending.ok) return pending;
  try {
    const rows = await db.rows<{ active: boolean; required: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM public.second_factors f
                     WHERE f.user_id = ${pending.session.userId}::uuid AND f.state = 'active')
               AS active,
             public.second_step_token_required(${pending.session.userId}::uuid) AS required`);
    const row = rows[0];
    return Object.freeze({
      ok: true,
      expiresAt: pending.session.expiresAt,
      next: row?.active === true ? "code" : "set_up",
      enrolmentTokenRequired: row?.active !== true && row?.required === true,
    });
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {
      // A failing logger changes nothing.
    }
    return Object.freeze({
      ok: false,
      code: "database_unavailable",
      message: "The database couldn't be reached just now. Try again in a moment.",
    });
  }
}

/** One organization a person may work in. */
export interface OrganizationChoice {
  readonly organizationId: OrganizationId;
  readonly name: string;
}

/** At most this many organizations are offered at the "choose" step. */
export const MAX_ORGANIZATION_CHOICES = 200;

/**
 * The organizations `userId` may work in, by name: their memberships, or
 * every organization for an active system admin (D-069: a system admin may
 * work in any). None for a disabled or unknown account. Ordered by name,
 * then ID; at most `MAX_ORGANIZATION_CHOICES`.
 */
export async function organizationChoices(
  db: Queryable,
  userId: UserId,
): Promise<readonly OrganizationChoice[]> {
  if (!isUserId(userId)) return [];
  const rows = await db.rows<{ id: string; name: string }>(sql`
    WITH person AS (
      SELECT id, system_admin FROM public.users
      WHERE id = ${userId}::uuid AND disabled_at IS NULL
    )
    SELECT o.id::text AS id, o.name
    FROM public.organizations o, person p
    WHERE p.system_admin
       OR EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = o.id AND m.user_id = p.id)
    ORDER BY o.name, o.id
    LIMIT ${MAX_ORGANIZATION_CHOICES}`);
  return Object.freeze(
    rows.map((r) => Object.freeze({ organizationId: r.id as OrganizationId, name: r.name })),
  );
}

/** The signed-in person's own name and address, for the top bar. */
export interface SignedInPerson {
  readonly displayName: string;
  readonly email: string;
  /**
   * Wrong two-step codes recorded for this account in the last 30 days
   * (D-077's alerts, D-085): the count and the newest one's time, so the
   * person sees it after signing in even if the email was lost.
   */
  readonly secondStepAlerts: { readonly recent: number; readonly lastAt: string | null };
}

/**
 * `userId`'s display name and address, or `undefined` for an unknown or
 * disabled account. The caller passes the user ID of a session it has just
 * resolved, never one from a form.
 */
export async function readSignedInPerson(
  db: Queryable,
  userId: UserId,
): Promise<SignedInPerson | undefined> {
  if (!isUserId(userId)) return undefined;
  const rows = await db.rows<{
    display_name: string;
    email: string;
    alerts: number;
    last_alert: string | null;
  }>(sql`
    SELECT u.display_name, u.email,
           (SELECT count(*)::int FROM public.second_step_alerts a
            WHERE a.user_id = u.id
              AND a.created_at > clock_timestamp() - interval '30 days') AS alerts,
           (SELECT to_char(max(a.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            FROM public.second_step_alerts a
            WHERE a.user_id = u.id
              AND a.created_at > clock_timestamp() - interval '30 days') AS last_alert
    FROM public.users u
    WHERE u.id = ${userId}::uuid AND u.disabled_at IS NULL`);
  const row = rows[0];
  return row === undefined
    ? undefined
    : Object.freeze({
        displayName: row.display_name,
        email: row.email,
        secondStepAlerts: Object.freeze({ recent: row.alerts, lastAt: row.last_alert }),
      });
}
