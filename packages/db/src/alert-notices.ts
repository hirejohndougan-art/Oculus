/**
 * The "someone is guessing your two-step codes" notice (T-040, D-077,
 * D-085). D-077 records a row in `second_step_alerts` when a person's
 * wrong-code counter starts a wait and every 10 wrong codes after: someone
 * who has their password is guessing codes. `sendSecondStepAlertNotices`
 * tells the person and every active system admin, **at most once per
 * person per window** (24 hours by default), and records in
 * `second_step_alert_notices` (0021) what became of every alert:
 *
 * - alerts are read and decided under one transaction-level advisory lock
 *   (classid 85, key 0), so two processes never send the same notice;
 *   0021's trigger also takes a per-person lock and refuses a second
 *   `notified` row within the window, and a `folded` row with no reason;
 * - a person with a notice in the window: every new alert of theirs is
 *   `folded` into it; otherwise the newest alert younger than the window is
 *   `notified` and the rest `folded`; alerts all older than the window
 *   (seen late, after an outage) are `folded` without an email;
 * - the rows are committed **before** anything is handed to `deliver`, so a
 *   crash or a failed send never leads to a second notice in the window (at
 *   most once, not at least once: a lost notice is logged by the mailer,
 *   and the next alert after the window sends again);
 * - the person's message goes to their own address (if the account isn't
 *   disabled); the admins' names the person by name and address, and goes
 *   to each active system admin but the person themselves.
 *
 * `deliver`'s failures are counted, never thrown, and what it throws is
 * dropped unread. Database failures reach `onError` (pg's `where` and
 * `detail` may hold values; callers log through a redacting logger, D-079).
 */
import type { UserId } from "@oculus/core";
import { isDatabaseFailure, type Database } from "./client.js";
import { inTransaction } from "./sessions.js";
import { sql } from "./sql.js";

/** The writer's grants on 0021's table (D-067): notices are only ever added. */
export const ALERT_NOTICE_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    second_step_alert_notices: Object.freeze(["INSERT"]),
  });

/** At most one notice per person in this many seconds, by default (24 hours). */
export const ALERT_NOTICE_WINDOW_SECONDS = 86_400;
/** Alerts decided per call at most (the rest wait for the next call). */
export const ALERT_NOTICE_BATCH = 200;

/** One email: to the person, or to a system admin about the person. */
export type SecondStepAlertMessage =
  | {
      readonly to: "person";
      readonly email: string;
      /** The wrong codes counted when the alert was recorded. */
      readonly failures: number;
      /** When it was recorded (core's ISO form). */
      readonly at: string;
    }
  | {
      readonly to: "system_admin";
      readonly email: string;
      readonly person: { readonly displayName: string; readonly email: string };
      readonly failures: number;
      readonly at: string;
    };

/** Sends one notice (the mailer's `deliverAlert`). Rejects if it wasn't queued. */
export type SecondStepAlertDelivery = (message: SecondStepAlertMessage) => Promise<void>;

/** What a call did (counts only, for the log). */
export interface AlertNoticeRun {
  /** Alerts decided (notified or folded). */
  readonly alerts: number;
  /** People notified. */
  readonly notified: number;
  /** Emails handed over, and those refused. */
  readonly sent: number;
  readonly failed: number;
}

export interface AlertNoticeOptions {
  /** Seconds, 3,600 to 604,800 (default 86,400). */
  readonly windowSeconds?: number;
  readonly onError?: (error: unknown) => void;
}

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

interface PendingAlert {
  id: string;
  user_id: UserId;
  failures: number;
  at: string;
  young: boolean;
}

interface Person {
  email: string;
  display_name: string;
  disabled: boolean;
  recent: boolean;
}

/**
 * Decides every alert not yet decided (up to `ALERT_NOTICE_BATCH`), records
 * the decisions, then sends the notices. Database failures are reported to
 * `onError` and give `undefined`; programming errors are thrown.
 */
export async function sendSecondStepAlertNotices(
  db: Database,
  deliver: SecondStepAlertDelivery,
  options: AlertNoticeOptions = {},
): Promise<AlertNoticeRun | undefined> {
  if (typeof deliver !== "function") throw new TypeError("deliver is a function.");
  const window = options.windowSeconds ?? ALERT_NOTICE_WINDOW_SECONDS;
  if (!Number.isInteger(window) || window < 3_600 || window > 604_800) {
    throw new TypeError("windowSeconds is a whole number from 3,600 to 604,800.");
  }
  let decided: { alerts: number; messages: SecondStepAlertMessage[]; notified: number };
  try {
    decided = await inTransaction(db, async (tx) => {
      await tx.rows(sql`SELECT pg_advisory_xact_lock(85, 0)`);
      const pending = await tx.rows<PendingAlert>(sql`
        SELECT a.id::text AS id, a.user_id::text AS user_id, a.failures,
               to_char(a.created_at AT TIME ZONE 'UTC', ${ISO}) AS at,
               a.created_at > clock_timestamp() - make_interval(secs => ${window}) AS young
        FROM public.second_step_alerts a
        WHERE NOT EXISTS (SELECT 1 FROM public.second_step_alert_notices n WHERE n.alert_id = a.id)
        ORDER BY a.created_at, a.id
        LIMIT ${ALERT_NOTICE_BATCH}`);
      if (pending.length === 0) return { alerts: 0, messages: [], notified: 0 };
      const byUser = new Map<UserId, PendingAlert[]>();
      for (const alert of pending) {
        const list = byUser.get(alert.user_id) ?? [];
        list.push(alert);
        byUser.set(alert.user_id, list);
      }
      const admins = await tx.rows<{ id: UserId; email: string }>(sql`
        SELECT id::text AS id, email FROM public.users
        WHERE system_admin AND disabled_at IS NULL ORDER BY id`);
      const messages: SecondStepAlertMessage[] = [];
      let notified = 0;
      for (const [userId, alerts] of byUser) {
        const people = await tx.rows<Person>(sql`
          SELECT u.email, u.display_name, u.disabled_at IS NOT NULL AS disabled,
                 EXISTS (SELECT 1 FROM public.second_step_alert_notices n
                         WHERE n.user_id = u.id AND n.outcome = 'notified'
                           AND n.noticed_at > clock_timestamp() - make_interval(secs => ${window}))
                   AS recent
          FROM public.users u WHERE u.id = ${userId}::uuid`);
        const person = people[0];
        if (person === undefined) continue;
        const newest = person.recent ? undefined : alerts.filter((a) => a.young).at(-1);
        // The notified one first, so the trigger finds it when it checks the folded ones.
        const order =
          newest === undefined ? alerts : [newest, ...alerts.filter((a) => a !== newest)];
        for (const alert of order) {
          await tx.execute(sql`
            INSERT INTO public.second_step_alert_notices
              (alert_id, user_id, outcome, window_seconds, noticed_at)
            VALUES (${alert.id}::uuid, ${userId}::uuid,
                    ${alert === newest ? "notified" : "folded"}, ${window}, clock_timestamp())`);
        }
        if (newest === undefined) continue;
        notified += 1;
        const base = { failures: newest.failures, at: newest.at };
        if (!person.disabled) messages.push({ to: "person", email: person.email, ...base });
        for (const admin of admins) {
          if (admin.id === userId) continue;
          messages.push({
            to: "system_admin",
            email: admin.email,
            person: { displayName: person.display_name, email: person.email },
            ...base,
          });
        }
      }
      return { alerts: pending.length, messages, notified };
    });
  } catch (error) {
    if (!isDatabaseFailure(error)) throw error;
    try {
      options.onError?.(error);
    } catch {
      // The log's own failure changes nothing.
    }
    return undefined;
  }
  let sent = 0;
  let failed = 0;
  for (const message of decided.messages) {
    try {
      await deliver(Object.freeze(message));
      sent += 1;
    } catch {
      // Dropped unread: it might quote the message.
      failed += 1;
    }
  }
  return Object.freeze({ alerts: decided.alerts, notified: decided.notified, sent, failed });
}
