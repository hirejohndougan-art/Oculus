// Upgrading a database that already holds data (S-065, T-053 data review L3).
// Every other migration test starts from an empty database; here a database
// is migrated to 0039, filled with rows the code of that time could write
// (direct SQL, past every trigger and check of that schema), then migrated to
// the newest file. The rows must survive, unchanged, and still pass every new
// check: 0040 widens second_step_throttles' key check, 0043 rebuilds
// record_shares' states and foreign keys and adds the records triggers, 0049
// adds columns and checks to system_events, and 0052 adds append-only guards.
//
// The last test lists every later file that changes an existing table
// (ALTER TABLE … ADD, DROP, ALTER or RENAME; UPDATE; DELETE FROM): a new one
// fails it until its rows are added to the seed below and it is named in
// COVERED, so no such migration ships without an upgrade of real data.
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { defaultMigrationsDir, migrate, MIGRATION_FILE } from "./migrate.js";
import { sql } from "./sql.js";
import { freshDatabase, storeDirectVersion, type TestDatabase } from "./test-database.fixtures.js";

/** The schema the seed is written for: every file up to this one. */
const SEEDED_AT = "0039_stored_file_events.sql";

/**
 * Files after SEEDED_AT that change an existing table, each checked by the
 * upgrade below. A new such file must add rows for what it changes to `seed`
 * and its name here.
 */
const COVERED = [
  "0040_unexplained_wrong_codes.sql",
  "0043_share_limits_and_endings.sql",
  "0049_file_purge.sql",
];

const PLACEHOLDER_HASH = "$scrypt$ln=14,r=8,p=5$" + "A".repeat(22) + "$" + "A".repeat(43);

const dirs: string[] = [];
const databases: TestDatabase[] = [];
const opened: Database[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(databases.splice(0).map((db) => db.drop()));
});

/** A directory holding the real migrations up to and including `last`. */
function migrationsUpTo(last: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oculus-upgrade-"));
  dirs.push(dir);
  for (const name of readdirSync(defaultMigrationsDir())) {
    if (name <= last) copyFileSync(join(defaultMigrationsDir(), name), join(dir, name));
  }
  return dir;
}

interface Seeded {
  org: string;
  admin: string;
  siteA: string;
  siteB: string;
  shares: Record<"offered" | "accepted" | "declined" | "withdrawn" | "removed", string>;
  records: string[];
  throttleKeys: string[];
  events: string[];
}

async function insertRecord(
  q: Queryable,
  org: string,
  site: string,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await q.execute(sql`
    INSERT INTO public.records
      (id, organization_id, kind, template_key, title, fields, created_at, updated_at,
       version, workflow_state, site_id)
    VALUES (${id}::uuid, ${org}::uuid, 'object', 'item', ${title}, '{}'::jsonb,
            date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()),
            1, 'draft', ${site}::uuid)`);
  await storeDirectVersion(q, org, id);
  return id;
}

/** Rows the code at SEEDED_AT could write, in each table a later file changes. */
async function seed(db: Database): Promise<Seeded> {
  const org = randomUUID();
  const admin = randomUUID();
  const siteA = randomUUID();
  const siteB = randomUUID();
  const records: string[] = [];
  await db.transaction(async (q) => {
    await q.execute(
      sql`INSERT INTO public.organizations (id, name) VALUES (${org}::uuid, 'Upgrade test')`,
    );
    await q.execute(sql`
      INSERT INTO public.users (id, email, display_name, password_hash, system_admin, bootstrap)
      VALUES (${admin}::uuid, 'admin@example.test', 'Admin', ${PLACEHOLDER_HASH}, true, true)`);
    await q.execute(sql`
      INSERT INTO public.sites (organization_id, id, name)
      VALUES (${org}::uuid, ${siteA}::uuid, 'Archives'), (${org}::uuid, ${siteB}::uuid, 'Library')`);
    await q.execute(
      sql`INSERT INTO public.templates (organization_id, key) VALUES (${org}::uuid, 'item')`,
    );
    for (const title of ["One", "Two", "Three", "Four", "Five", "Six"]) {
      records.push(await insertRecord(q, org, siteA, title));
    }
  });
  // record_shares (0043): one share in each state the old schema knew.
  const offer = async (record: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO public.record_shares
        (id, organization_id, record_id, target_organization_id, target_site_id, offered_by)
      VALUES (${id}::uuid, ${org}::uuid, ${record}::uuid, ${org}::uuid, ${siteB}::uuid, ${admin}::uuid)`);
    return id;
  };
  const decide = (id: string, state: "accepted" | "declined"): Promise<number> =>
    db.execute(sql`UPDATE public.record_shares
      SET state = ${state}, decided_by = ${admin}::uuid, decided_at = clock_timestamp()
      WHERE id = ${id}::uuid`);
  const end = (id: string, state: "withdrawn" | "removed"): Promise<number> =>
    db.execute(sql`UPDATE public.record_shares
      SET state = ${state}, ended_by = ${admin}::uuid, ended_at = clock_timestamp()
      WHERE id = ${id}::uuid`);
  const [r1, r2, r3, r4, r5] = records as [string, string, string, string, string];
  const shares = {
    offered: await offer(r1),
    accepted: await offer(r2),
    declined: await offer(r3),
    withdrawn: await offer(r4),
    removed: await offer(r5),
  };
  await decide(shares.accepted, "accepted");
  await decide(shares.declined, "declined");
  await end(shares.withdrawn, "withdrawn");
  await decide(shares.removed, "accepted");
  await end(shares.removed, "removed");
  // second_step_throttles (0040): every key shape the old check allowed.
  const throttleKeys = [
    `user:${admin}`,
    `session:${randomUUID()}`,
    "source:v4:192.0.2.10",
    "source:v6:2001:db8:0:1::/64",
    "source:other",
  ];
  for (const key of throttleKeys) {
    await db.execute(sql`INSERT INTO public.second_step_throttles (key, failures, last_failure_at)
      VALUES (${key}, 3, clock_timestamp())`);
  }
  // system_events (0049): both kinds 0030 knew, with and without an actor.
  const events = [randomUUID(), randomUUID()];
  await db.execute(sql`INSERT INTO public.system_events (id, actor_id, kind, version, from_version)
    VALUES (${events[0]}::uuid, ${admin}::uuid, 'update_installed', '1.2.0', '1.1.3')`);
  await db.execute(sql`INSERT INTO public.system_events (id, actor_id, kind, version, from_version)
    VALUES (${events[1]}::uuid, NULL, 'update_rolled_back', '1.1.3', '1.2.0')`);
  return { org, admin, siteA, siteB, shares, records, throttleKeys, events };
}

async function migratedTo(last: string | undefined): Promise<{ db: Database; url: string }> {
  const test = await freshDatabase();
  databases.push(test);
  const dir = last === undefined ? defaultMigrationsDir() : migrationsUpTo(last);
  await migrate({ connectionString: test.url, dir });
  const db = openDatabase(test.url, { max: 2 });
  opened.push(db);
  return { db, url: test.url };
}

describe("upgrading a database that holds data", () => {
  it(`keeps rows written at ${SEEDED_AT} through every later migration`, async () => {
    const { db, url } = await migratedTo(SEEDED_AT);
    const seeded = await seed(db);
    const before = await db.rows<{ id: string; state: string }>(
      sql`SELECT id::text AS id, state FROM public.record_shares ORDER BY id`,
    );

    const result = await migrate({ connectionString: url });
    expect(result.applied.length).toBeGreaterThan(0);
    expect((result.applied[0] ?? "") > SEEDED_AT).toBe(true);

    // Shares: same rows, same states (no record moved onto its share's site).
    expect(
      await db.rows<{ id: string; state: string }>(
        sql`SELECT id::text AS id, state FROM public.record_shares ORDER BY id`,
      ),
    ).toEqual(before);
    const states = Object.fromEntries(
      (
        await db.rows<{ id: string; state: string }>(
          sql`SELECT id::text AS id, state FROM public.record_shares`,
        )
      ).map((r) => [r.id, r.state]),
    );
    for (const [state, id] of Object.entries(seeded.shares)) expect(states[id]).toBe(state);

    // 0043's new life: deleting a record now ends its live shares as
    // `deleted` instead of taking them away with it.
    const offeredRecord = seeded.records[0] ?? "";
    await db.transaction(async (q) => {
      await q.execute(sql`
        INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
        SELECT organization_id, id, version + 1, public.record_snapshot(r), 'system:direct_sql', 'delete'
        FROM public.records r WHERE organization_id = ${seeded.org}::uuid AND id = ${offeredRecord}::uuid`);
      await q.execute(sql`DELETE FROM public.records
        WHERE organization_id = ${seeded.org}::uuid AND id = ${offeredRecord}::uuid`);
    });
    expect(
      await db.rows<{ state: string }>(
        sql`SELECT state FROM public.record_shares WHERE id = ${seeded.shares.offered}::uuid`,
      ),
    ).toEqual([{ state: "deleted" }]);

    // Throttles: every old key still there, still counting.
    expect(
      await db.rows<{ key: string; failures: number }>(
        sql`SELECT key, failures FROM public.second_step_throttles ORDER BY key`,
      ),
    ).toEqual([...seeded.throttleKeys].sort().map((key) => ({ key, failures: 3 })));
    // …and 0040's new key shape is now accepted beside them.
    await db.execute(sql`INSERT INTO public.second_step_throttles (key, failures)
      VALUES (${`wrong:${seeded.admin}`}, 1)`);

    // The change log: both old rows, unchanged, the new columns empty.
    expect(
      await db.rows<{
        id: string;
        kind: string;
        version: string | null;
        from_version: string | null;
        file_count: number | null;
        source: string | null;
      }>(sql`SELECT id::text AS id, kind, version, from_version, file_count, source
             FROM public.system_events ORDER BY occurred_at, id`),
    ).toEqual(
      expect.arrayContaining([
        {
          id: seeded.events[0],
          kind: "update_installed",
          version: "1.2.0",
          from_version: "1.1.3",
          file_count: null,
          source: null,
        },
        {
          id: seeded.events[1],
          kind: "update_rolled_back",
          version: "1.1.3",
          from_version: "1.2.0",
          file_count: null,
          source: null,
        },
      ]),
    );

    // Every constraint the new files added holds for the old rows too.
    expect(
      await db.rows<{ name: string }>(sql`
        SELECT conname AS name FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND NOT c.convalidated`),
    ).toEqual([]);
  });

  it("names every later migration that changes an existing table", () => {
    const changes =
      /^(ALTER TABLE (ONLY )?public\.\w+\s+(ADD|DROP|ALTER|RENAME)\b|UPDATE public\.|DELETE FROM public\.)/im;
    const later = readdirSync(defaultMigrationsDir())
      .filter((name) => MIGRATION_FILE.test(name) && name > SEEDED_AT)
      .filter((name) => changes.test(readFileSync(join(defaultMigrationsDir(), name), "utf8")));
    // A new file here needs rows for what it changes in `seed`, and its name
    // in COVERED (S-065).
    expect(later).toEqual(COVERED);
  });
});
