// The "someone is guessing your two-step codes" notices (T-040, D-077,
// D-085, migration 0021): who is told, at most once per person per window,
// alerts folded into a notice or seen too late, two runs at once, failed
// sends, and 0021's guards as the writer role. Every person and address is
// invented.
import { afterAll, describe, expect, it } from "vitest";
import { newOrganizationId, type OrganizationId, type UserId, type Validated } from "@oculus/core";
import { acceptInvitation, createFirstSystemAdmin, createInvitation } from "./accounts.js";
import type { InvitationMessage } from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { migrate } from "./migrate.js";
import { memberSecondStep } from "./people.js";
import { WRITER_PRIVILEGES, checkWriterConnection, grantWriterRole } from "./roles.js";
import {
  ALERT_NOTICE_TABLE_PRIVILEGES,
  ALERT_SUMMARY_LINES,
  sendSecondStepAlertNotices,
  type SecondStepAlertMessage,
} from "./alert-notices.js";
import { sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";

const ADMIN_EMAIL = "alerts.admin@example.org";
const PASSWORD = "an invented passphrase for tests";

let testDb: TestDatabase;
let db: Database;
let admin: UserId;
let org: OrganizationId;
const cleanups: (() => Promise<void>)[] = [];
let setup: Promise<void> | undefined;
let counter = 0;

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

async function ready(): Promise<void> {
  setup ??= (async () => {
    testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    db = openDatabase(testDb.url, { max: 4 });
    admin = ok(
      await createFirstSystemAdmin(db, {
        email: ADMIN_EMAIL,
        displayName: "Alerts Admin",
        password: "a first admin passphrase, invented",
      }),
    ).userId;
    org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Invented Alerts Society" }));
  })();
  await setup;
}

afterAll(async () => {
  await setup?.catch(() => undefined);
  await db.close();
  await testDb.drop();
  for (const cleanup of cleanups) await cleanup();
});

async function person(): Promise<{ userId: UserId; email: string }> {
  counter += 1;
  const email = `alerts.person${String(counter)}@example.org`;
  const box: InvitationMessage[] = [];
  ok(
    await createInvitation(db, { organizationId: org, email, invitedBy: admin }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const userId = ok(
    await acceptInvitation(db, {
      token: box[0]?.token ?? "",
      organizationId: org,
      email,
      displayName: `Invented Person ${String(counter)}`,
      password: PASSWORD,
    }),
  ).userId;
  return { userId, email };
}

async function alert(userId: UserId, failures: number, ageSeconds = 0): Promise<string> {
  const rows = await db.rows<{ id: string }>(sql`
    INSERT INTO public.second_step_alerts (id, user_id, failures, created_at)
    VALUES (gen_random_uuid(), ${userId}::uuid, ${failures},
            clock_timestamp() - make_interval(secs => ${ageSeconds}))
    RETURNING id::text AS id`);
  return rows[0]?.id ?? "";
}

async function outcomes(userId: UserId): Promise<string[]> {
  const rows = await db.rows<{ outcome: string }>(sql`
    SELECT n.outcome FROM public.second_step_alert_notices n
    JOIN public.second_step_alerts a ON a.id = n.alert_id
    WHERE n.user_id = ${userId}::uuid ORDER BY a.created_at, a.id`);
  return rows.map((r) => r.outcome);
}

function inbox() {
  const messages: SecondStepAlertMessage[] = [];
  return {
    messages,
    deliver: (m: SecondStepAlertMessage) => {
      messages.push(m);
      return Promise.resolve();
    },
  };
}

/** Clears every undecided alert, so each test starts from its own. */
async function drain(): Promise<void> {
  await sendSecondStepAlertNotices(db, () => Promise.resolve());
}

describe("sendSecondStepAlertNotices", () => {
  it("tells the person and every active system admin, once, naming the person to the admins", async () => {
    await ready();
    await drain();
    const p = await person();
    await alert(p.userId, 5);
    await alert(p.userId, 15);
    const box = inbox();
    const run = await sendSecondStepAlertNotices(db, box.deliver);
    expect(run).toEqual({ alerts: 2, notified: 1, sent: 2, failed: 0 });
    expect(box.messages).toEqual([
      { to: "person", email: p.email, failures: 15, at: expect.any(String) as string },
      {
        to: "system_admin",
        email: ADMIN_EMAIL,
        // By address only: never the self-chosen display name (review L1).
        people: [{ email: p.email, failures: 15, at: expect.any(String) as string }],
        more: 0,
      },
    ]);
    // The person's page shows what became of each alert (review M2).
    const seen = await memberSecondStep(db, p.userId);
    expect(seen.alerts.map((a) => [a.failures, a.notice])).toEqual([
      [15, "emailed"],
      [5, "covered"],
    ]);
    expect(await outcomes(p.userId)).toEqual(["folded", "notified"]);
    // Nothing left: a second run sends nothing.
    const again = inbox();
    expect(await sendSecondStepAlertNotices(db, again.deliver)).toEqual({
      alerts: 0,
      notified: 0,
      sent: 0,
      failed: 0,
    });
    expect(again.messages).toEqual([]);
  });

  it("sends each admin one summary per run however many people were alerted, capped with a count", async () => {
    await ready();
    await drain();
    const folks = [];
    for (let i = 0; i < ALERT_SUMMARY_LINES + 2; i++) folks.push(await person());
    for (const p of folks) await alert(p.userId, 5);
    const box = inbox();
    const run = await sendSecondStepAlertNotices(db, box.deliver);
    expect(run?.notified).toBe(ALERT_SUMMARY_LINES + 2);
    const summaries = box.messages.filter((m) => m.to === "system_admin");
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    if (summary?.to !== "system_admin") throw new Error("no summary");
    expect(summary.people).toHaveLength(ALERT_SUMMARY_LINES);
    expect(summary.more).toBe(2);
    expect(box.messages.filter((m) => m.to === "person")).toHaveLength(ALERT_SUMMARY_LINES + 2);
  }, 120_000);

  it("hands over no more than the mailer has room for, leaving the rest for a later run", async () => {
    await ready();
    await drain();
    const first = await person();
    const second = await person();
    const third = await person();
    const folks = [first, second, third];
    for (const p of folks) await alert(p.userId, 5);
    const box = inbox();
    // Room for one person's email and the one admin's summary.
    expect(await sendSecondStepAlertNotices(db, box.deliver, { maxMessages: 2 })).toMatchObject({
      notified: 1,
      sent: 2,
    });
    expect(await outcomes(second.userId)).toEqual([]);
    expect(await sendSecondStepAlertNotices(db, box.deliver, { maxMessages: 0 })).toMatchObject({
      notified: 0,
    });
    const rest = await sendSecondStepAlertNotices(db, box.deliver);
    expect(rest).toMatchObject({ notified: 2, sent: 3 });
  });

  it("folds later alerts within the window into the notice, and notifies again after it", async () => {
    await ready();
    await drain();
    const p = await person();
    await alert(p.userId, 5);
    await sendSecondStepAlertNotices(db, () => Promise.resolve());
    await alert(p.userId, 15);
    const box = inbox();
    await sendSecondStepAlertNotices(db, box.deliver);
    expect(box.messages).toEqual([]);
    expect(await outcomes(p.userId)).toEqual(["notified", "folded"]);
    // A day later (moved back by the owner, with the guard off just for that).
    await db.transaction(async (q) => {
      await q.execute(sql`ALTER TABLE public.second_step_alert_notices DISABLE TRIGGER USER`);
      await q.execute(sql`DELETE FROM public.second_step_alert_notices
        WHERE user_id = ${p.userId}::uuid AND outcome = 'notified'`);
      await q.execute(sql`ALTER TABLE public.second_step_alert_notices ENABLE TRIGGER USER`);
      await q.execute(sql`ALTER TABLE public.second_step_alert_notices
        ENABLE ALWAYS TRIGGER second_step_alert_notices_check_new`);
      await q.execute(sql`ALTER TABLE public.second_step_alert_notices
        ENABLE ALWAYS TRIGGER second_step_alert_notices_no_change`);
    });
    await alert(p.userId, 25);
    const later = inbox();
    await sendSecondStepAlertNotices(db, later.deliver);
    expect(later.messages.map((m) => m.to)).toEqual(["person", "system_admin"]);
  });

  it("folds alerts seen only after the window has passed, sending nothing", async () => {
    await ready();
    await drain();
    const p = await person();
    await alert(p.userId, 5, 90_000);
    const box = inbox();
    expect(await sendSecondStepAlertNotices(db, box.deliver)).toMatchObject({
      alerts: 1,
      notified: 0,
    });
    expect(box.messages).toEqual([]);
    expect(await outcomes(p.userId)).toEqual(["folded"]);
  });

  it("tells only the admins about a disabled account, and a system admin only once about themselves", async () => {
    await ready();
    await drain();
    await alert(admin, 5);
    const box = inbox();
    await sendSecondStepAlertNotices(db, box.deliver);
    expect(box.messages).toEqual([
      { to: "person", email: ADMIN_EMAIL, failures: 5, at: expect.any(String) as string },
    ]);
    const p = await person();
    await db.execute(sql`UPDATE public.users SET disabled_at = clock_timestamp()
      WHERE id = ${p.userId}::uuid`);
    await alert(p.userId, 5);
    const second = inbox();
    await sendSecondStepAlertNotices(db, second.deliver);
    expect(second.messages.map((m) => m.to)).toEqual(["system_admin"]);
  });

  it("sends each notice once when two runs race", async () => {
    await ready();
    await drain();
    const p = await person();
    await alert(p.userId, 5);
    const box = inbox();
    const runs = await Promise.all([
      sendSecondStepAlertNotices(db, box.deliver),
      sendSecondStepAlertNotices(db, box.deliver),
    ]);
    expect(runs.map((r) => r?.notified).sort()).toEqual([0, 1]);
    expect(box.messages.filter((m) => m.to === "person")).toHaveLength(1);
  });

  it("counts a refused send, drops what it threw, and doesn't send it again", async () => {
    await ready();
    await drain();
    const p = await person();
    await alert(p.userId, 5);
    const run = await sendSecondStepAlertNotices(db, () =>
      Promise.reject(new Error(`could not send to ${p.email}`)),
    );
    expect(run).toMatchObject({ notified: 1, sent: 0, failed: 2 });
    const box = inbox();
    await sendSecondStepAlertNotices(db, box.deliver);
    expect(box.messages).toEqual([]);
  });

  it("checks its options", async () => {
    await ready();
    await expect(
      sendSecondStepAlertNotices(db, () => Promise.resolve(), { windowSeconds: 60 }),
    ).rejects.toThrow(TypeError);
    await expect(sendSecondStepAlertNotices(db, 5 as never)).rejects.toThrow(TypeError);
  });
});

describe("0021's guards, as the writer role", () => {
  it("allow the notices and nothing else", async () => {
    await ready();
    await drain();
    const role = `oculus_test_t040_${String(process.pid)}`;
    const run = async (statement: string, q: Queryable): Promise<void> => {
      await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                              set_config('oculus_test.statement', ${statement}, true)`);
      await q.execute(sql`DO $$ BEGIN
        EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
      END $$`);
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction((q) => run("CREATE ROLE %I LOGIN", q));
    } finally {
      await server.close();
    }
    cleanups.push(async () => {
      const s = openDatabase(testServerUrl(), { max: 1 });
      try {
        await s.transaction((q) => run("DROP ROLE IF EXISTS %I", q));
      } finally {
        await s.close();
      }
    });
    await db.transaction((q) => grantWriterRole(q, role));
    const url = new URL(testDb.url);
    url.username = role;
    const writer = openDatabase(url.toString(), { max: 3 });
    try {
      expect(await checkWriterConnection(writer)).toEqual([]);
      expect(WRITER_PRIVILEGES.second_step_alert_notices).toEqual(
        ALERT_NOTICE_TABLE_PRIVILEGES.second_step_alert_notices,
      );
      const p = await person();
      const other = await person();
      const first = await alert(p.userId, 5);
      const second = await alert(p.userId, 15);
      // Folding with no reason (no notice in the window, a fresh alert) is refused.
      await expect(rawInsert(writer, first, p.userId, "folded")).rejects.toMatchObject({
        constraint: "second_step_alert_notices_fold",
      });
      // Another person's alert.
      await expect(rawInsert(writer, first, other.userId, "notified")).rejects.toMatchObject({
        constraint: "second_step_alert_notices_user",
      });
      // Back-dated.
      await expect(
        rawInsert(writer, first, p.userId, "notified", "clock_timestamp() - interval '2 days'"),
      ).rejects.toMatchObject({ constraint: "second_step_alert_notices_now" });
      await rawInsert(writer, first, p.userId, "notified");
      // A second notice in the window is refused; folding into it is allowed.
      await expect(rawInsert(writer, second, p.userId, "notified")).rejects.toMatchObject({
        constraint: "second_step_alert_notices_window",
      });
      await rawInsert(writer, second, p.userId, "folded");
      // Never changed or deleted, by the writer.
      await expect(
        writer.execute(sql`UPDATE public.second_step_alert_notices SET outcome = 'folded'
          WHERE alert_id = ${first}::uuid`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writer.execute(sql`DELETE FROM public.second_step_alert_notices
          WHERE alert_id = ${first}::uuid`),
      ).rejects.toMatchObject({ code: "42501" });
      // Nor by the owner (the trigger), in replica mode too.
      await expect(
        db.transaction(async (q) => {
          await q.execute(sql`SET LOCAL session_replication_role = replica`);
          await q.execute(sql`UPDATE public.second_step_alert_notices SET outcome = 'folded'
            WHERE alert_id = ${first}::uuid`);
        }),
      ).rejects.toMatchObject({ constraint: "second_step_alert_notices_fixed" });
      // The sender works as the writer.
      await alert(other.userId, 5);
      const box = inbox();
      expect(await sendSecondStepAlertNotices(writer, box.deliver)).toMatchObject({ notified: 1 });
    } finally {
      await writer.close();
    }
  });
});

function rawInsert(
  q: Database,
  alertId: string,
  userId: UserId,
  outcome: string,
  at = "clock_timestamp()",
): Promise<number> {
  const when =
    at === "clock_timestamp()"
      ? sql`clock_timestamp()`
      : sql`clock_timestamp() - interval '2 days'`;
  return q.execute(sql`
    INSERT INTO public.second_step_alert_notices
      (alert_id, user_id, outcome, window_seconds, noticed_at)
    VALUES (${alertId}::uuid, ${userId}::uuid, ${outcome}, 86400, ${when})`);
}
