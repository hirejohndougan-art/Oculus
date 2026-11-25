// The audit trail on an organization with a long history (S-066): each of
// the newer kinds (file events, moves, accession saves, share steps) is
// read through its `(organization_id, time DESC)` index, one page at a
// time, so a page reads about a page of rows from each table, never the
// whole table. Checked on the real plan (EXPLAIN ANALYZE), for the first
// page and for a page further on.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, type OrganizationId } from "@oculus/core";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { migrate } from "./migrate.js";
import { readAuditTrail } from "./people.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const ROWS = 4000;
const PAGE = 50;
const TABLES = ["stored_file_events", "storage_moves", "accession_versions", "record_shares"];

let testDb: TestDatabase;
let db: Database;
const org: OrganizationId = newOrganizationId();
const other: OrganizationId = newOrganizationId();

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 1 });
  // Invented rows, put straight in as the owner with every trigger and
  // foreign key off (this database is the test's own, dropped after it):
  // only the size of the history matters here. Half go to another
  // organization, which a page must not read either.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE public.stored_file_events DISABLE TRIGGER ALL`);
    await tx.execute(sql`ALTER TABLE public.storage_moves DISABLE TRIGGER ALL`);
    await tx.execute(sql`ALTER TABLE public.accession_versions DISABLE TRIGGER ALL`);
    await tx.execute(sql`ALTER TABLE public.record_shares DISABLE TRIGGER ALL`);
    const user = randomUUID();
    for (const o of [org, other]) {
      await tx.execute(sql`
        INSERT INTO public.stored_file_events
          (organization_id, id, kind, file_id, record_id, sha256, byte_size, actor)
        SELECT ${o}::uuid, gen_random_uuid(), CASE WHEN g % 2 = 0 THEN 'attached' ELSE 'removed' END,
               gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 'user:' || ${user}::text
        FROM generate_series(1, ${ROWS}) g`);
      await tx.execute(sql`
        INSERT INTO public.storage_moves (organization_id, id, definition, recorded_by, recorded_at)
        SELECT ${o}::uuid, m.id,
               jsonb_build_object('id', m.id, 'organizationId', ${o}::text,
                                  'recordId', gen_random_uuid(), 'locationId', gen_random_uuid()),
               ${user}::uuid, m.at
        FROM (SELECT gen_random_uuid() AS id, clock_timestamp() - make_interval(secs => g) AS at
              FROM generate_series(1, ${ROWS}) g) m`);
      await tx.execute(sql`
        INSERT INTO public.accession_versions
          (organization_id, accession_id, version, definition, saved_by, saved_at)
        SELECT ${o}::uuid, gen_random_uuid(), 1, '{}'::jsonb, ${user}::uuid,
               clock_timestamp() - make_interval(secs => g)
        FROM generate_series(1, ${ROWS}) g`);
      await tx.execute(sql`
        INSERT INTO public.record_shares
          (id, organization_id, record_id, target_organization_id, target_site_id,
           offered_by, offered_at)
        SELECT gen_random_uuid(), ${o}::uuid, gen_random_uuid(), ${o}::uuid, gen_random_uuid(),
               ${user}::uuid, clock_timestamp() - make_interval(secs => 2 * g)
        FROM generate_series(1, ${ROWS}) g`);
      // Half accepted, so the "decided" part has a history too.
      await tx.execute(sql`
        UPDATE public.record_shares SET state = 'accepted', decided_by = ${user}::uuid,
               decided_at = offered_at + interval '1 second'
        WHERE organization_id = ${o}::uuid AND id::text < '8'`);
    }
  });
  await db.execute(sql`ANALYZE public.stored_file_events`);
  await db.execute(sql`ANALYZE public.storage_moves`);
  await db.execute(sql`ANALYZE public.accession_versions`);
  await db.execute(sql`ANALYZE public.record_shares`);
}, 120_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
});

interface PlanNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** Rows each table's scans touched in the plan, all loops counted. */
function rowsRead(plan: PlanNode, into = new Map<string, number>()): Map<string, number> {
  const table = plan["Relation Name"];
  if (table !== undefined) {
    const loops = plan["Actual Loops"] ?? 1;
    const rows =
      (plan["Actual Rows"] ?? 0) +
      (plan["Rows Removed by Filter"] ?? 0) +
      (plan["Rows Removed by Index Recheck"] ?? 0);
    into.set(table, (into.get(table) ?? 0) + rows * loops);
  }
  for (const child of plan.Plans ?? []) rowsRead(child, into);
  return into;
}

/** Runs `readAuditTrail` with its query explained (and still answered). */
async function explained(
  after?: string,
): Promise<{ read: Map<string, number>; next: string | null; count: number }> {
  let plan: PlanNode | undefined;
  const explaining: Queryable = {
    rows: async <T extends object>(query: Sql): Promise<T[]> => {
      const text = query.text;
      if (text.includes("WITH names AS")) {
        const explain = await db.rows<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
          sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
        );
        plan = explain[0]?.["QUERY PLAN"][0].Plan;
      }
      return db.rows<T>(query);
    },
    execute: (query) => db.execute(query),
  };
  const page = await readAuditTrail(
    explaining,
    org,
    { records: "all", people: "all", system: true, accessions: true },
    { limit: PAGE, ...(after === undefined ? {} : { after }) },
  );
  if (plan === undefined) throw new Error("no plan");
  return { read: rowsRead(plan), next: page.next, count: page.entries.length };
}

describe("the audit trail on a long history (S-066)", () => {
  it("reads about a page from each table, on the first page and further on", async () => {
    const first = await explained();
    expect(first.count).toBe(PAGE);
    const second = await explained(first.next ?? undefined);
    expect(second.count).toBe(PAGE);
    for (const { read } of [first, second]) {
      for (const table of TABLES) {
        // Two pages at most per part (record_shares has three parts),
        // against the 8,000 rows of each table.
        expect(read.get(table) ?? 0, table).toBeLessThanOrEqual(6 * (PAGE + 1));
      }
    }
  });
});
