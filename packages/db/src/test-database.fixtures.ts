/**
 * Test databases (D-049, D-057). `npm run gate` starts a throwaway server and
 * sets OCULUS_TEST_DATABASE_URL; CI points it at a service container. Each
 * test file makes its own fresh databases on that server and drops them
 * afterwards. With no server, database tests fail; they are never skipped.
 */
import { randomBytes } from "node:crypto";
import {
  createDatabase,
  dropDatabase,
  withDatabaseName,
  type Database,
  type Queryable,
} from "./client.js";
import { sql, type Sql } from "./sql.js";

export const TEST_URL_VARIABLE = "OCULUS_TEST_DATABASE_URL";

export function testServerUrl(): string {
  const url = process.env[TEST_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      `${TEST_URL_VARIABLE} is not set, so database tests can't run. Run \`npm run gate\`, which starts a throwaway PostgreSQL, or set ${TEST_URL_VARIABLE} to a server where you may create databases.`,
    );
  }
  return url;
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Creates a new, empty database on the test server. */
export async function freshDatabase(): Promise<TestDatabase> {
  const server = testServerUrl();
  const name = `oculus_test_${randomBytes(8).toString("hex")}`;
  await createDatabase(server, name);
  return {
    name,
    url: withDatabaseName(server, name),
    drop: () => dropDatabase(server, name),
  };
}

/**
 * Stores the version the database requires after a direct INSERT or UPDATE of
 * a record (T-029, D-063): the row as it now is, as its current version, by
 * the invented actor `system:direct_sql`. A direct UPDATE must also add 1 to
 * `version`. Run it in the same transaction as the write.
 */
export async function storeDirectVersion(
  q: Queryable,
  organizationId: string,
  recordId: string,
): Promise<void> {
  await q.execute(sql`
    INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
    SELECT organization_id, id, version, public.record_snapshot(r), 'system:direct_sql'
    FROM public.records r
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
}

/**
 * Runs a direct INSERT or UPDATE of one record and stores its version, in
 * one transaction, as any direct SQL writer must since T-029. Returns the
 * number of rows the statement touched.
 */
export function writeRecordDirectly(
  db: Database,
  statement: Sql,
  organizationId: string,
  recordId: string,
): Promise<number> {
  return db.transaction(async (q) => {
    const touched = await q.execute(statement);
    await storeDirectVersion(q, organizationId, recordId);
    return touched;
  });
}

/**
 * Deletes a record by direct SQL as any writer must since 0008 (T-032,
 * D-067): its deletion version first (the row as it is, one past its
 * version, by `system:direct_sql`), then the DELETE. Run in a transaction.
 */
export async function deleteRecordDirectly(
  q: Queryable,
  organizationId: string,
  recordId: string,
): Promise<number> {
  await q.execute(sql`
    INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
    SELECT organization_id, id, version + 1, public.record_snapshot(r), 'system:direct_sql', 'delete'
    FROM public.records r
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  return q.execute(sql`
    DELETE FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
}
