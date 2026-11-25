// The change log of people and roles and the last system admin (T-048,
// D-084, migration 0020): rows are stamped now and never changed, deleted
// or emptied, even by the owner or in replica mode; the last active system
// admin can't be disabled; every 0020 trigger is ALWAYS. Every name and
// address is invented (example.org).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, newRecordId, type UserId } from "@oculus/core";
import { createFirstSystemAdmin } from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database } from "./client.js";
import { migrate } from "./migrate.js";
import { insertPeopleEvent, setAccountDisabled } from "./people.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

let testDb: TestDatabase;
let db: Database;
let admin: UserId;
const org = newOrganizationId();

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  const made = await createFirstSystemAdmin(db, {
    email: "root@example.org",
    displayName: "Invented Root",
    password: "Invented river bend lantern 2026",
  });
  if (!made.ok) throw new Error("no admin");
  admin = made.value.userId;
  const inserted = await insertOrganization(db, { id: org, name: "Invented Archive" });
  if (!inserted.ok) throw new Error("no organization");
}, 60_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
});

describe("people_events", () => {
  it("takes a row stamped now and refuses one dated otherwise", async () => {
    await db.transaction((tx) =>
      insertPeopleEvent(tx, {
        id: newRecordId(),
        organizationId: org,
        actorId: admin,
        subjectId: admin,
        kind: "sessions_ended",
      }),
    );
    await expect(
      db.execute(sql`
        INSERT INTO public.people_events (organization_id, id, occurred_at, actor_id, subject_id, kind)
        VALUES (${org}::uuid, gen_random_uuid(), now() - interval '1 day', ${admin}::uuid,
                ${admin}::uuid, 'sessions_ended')`),
    ).rejects.toMatchObject({ constraint: "people_events_now" });
  });

  it("refuses a row whose columns don't fit its kind", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO public.people_events (organization_id, id, actor_id, subject_id, kind)
        VALUES (${org}::uuid, gen_random_uuid(), ${admin}::uuid, ${admin}::uuid, 'role_granted')`),
    ).rejects.toMatchObject({ constraint: "people_events_shape" });
  });

  it("is never changed, deleted or emptied, by the owner or in replica mode", async () => {
    for (const statement of [
      sql`UPDATE public.people_events SET kind = 'account_enabled'`,
      sql`DELETE FROM public.people_events`,
      sql`TRUNCATE public.people_events`,
    ]) {
      await expect(db.execute(statement)).rejects.toMatchObject({
        constraint: "people_events_append_only",
      });
      await expect(
        db.transaction(async (q) => {
          await q.execute(sql`SET LOCAL session_replication_role = replica`);
          await q.execute(statement);
        }),
      ).rejects.toMatchObject({ constraint: "people_events_append_only" });
    }
    const [row] = await db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.people_events`,
    );
    expect(row?.n).toBe(1);
  });

  it("has every 0020 trigger enabled ALWAYS", async () => {
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_trigger t
      WHERE NOT t.tgisinternal
        AND t.tgname IN ('people_events_check_new', 'people_events_append_only',
                         'people_events_no_truncate', 'users_last_system_admin')
      ORDER BY 1`);
    expect(rows).toEqual([
      { name: "people_events_append_only", enabled: "A" },
      { name: "people_events_check_new", enabled: "A" },
      { name: "people_events_no_truncate", enabled: "A" },
      { name: "users_last_system_admin", enabled: "A" },
    ]);
  });
});

describe("the last system admin", () => {
  it("can't be disabled, by setAccountDisabled, direct SQL or in replica mode", async () => {
    const refused = await db.transaction((tx) => setAccountDisabled(tx, admin, true));
    expect(refused.ok ? [] : refused.issues.map((i) => i.code)).toEqual(["last_system_manager"]);
    await expect(
      db.transaction(async (q) => {
        await q.execute(sql`SET LOCAL session_replication_role = replica`);
        await q.execute(sql`UPDATE public.users SET disabled_at = now() WHERE id = ${admin}::uuid`);
      }),
    ).rejects.toMatchObject({ constraint: "users_last_system_admin" });
    const [row] = await db.rows<{ disabled: boolean }>(
      sql`SELECT disabled_at IS NOT NULL AS disabled FROM public.users WHERE id = ${admin}::uuid`,
    );
    expect(row?.disabled).toBe(false);
  });
});
