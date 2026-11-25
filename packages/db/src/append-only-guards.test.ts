// 0052's append-only guards (S-065, T-053 data review L4): storage moves,
// accession versions, two-step alert notices and two-step passes refuse
// UPDATE, DELETE and TRUNCATE even for the owner, who has every privilege.
// The writer is refused by privilege before any trigger runs (roles.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./client.js";
import { migrate } from "./migrate.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

let test: TestDatabase;
let db: Database;

beforeAll(async () => {
  test = await freshDatabase();
  await migrate({ connectionString: test.url });
  db = openDatabase(test.url, { max: 2 });
});

afterAll(async () => {
  await db.close();
  await test.drop();
});

/** The constraint named by the error the statement raises, run as the owner. */
async function refusedBy(statement: Sql): Promise<string | undefined> {
  const error = await db
    .transaction((q) => q.execute(statement))
    .then(
      () => undefined,
      (e: unknown) => e as { code?: string; constraint?: string },
    );
  expect(error?.code).toBe("23000");
  return error?.constraint;
}

describe("append-only guards (0052)", () => {
  it.each([
    ["storage_moves", ["UPDATE", "DELETE", "TRUNCATE"]],
    ["accession_versions", ["UPDATE", "DELETE", "TRUNCATE"]],
    ["second_step_alert_notices", ["DELETE", "TRUNCATE"]],
    ["second_step_passes", ["DELETE"]],
  ] as const)("%s refuses %j for the owner", async (table, verbList) => {
    const verbs: readonly string[] = verbList;
    // The guards fire per row (UPDATE, DELETE) or per statement (TRUNCATE):
    // a statement over no rows is refused only by TRUNCATE, so the row guards
    // are checked in the catalog, the TRUNCATE guard by running it.
    const triggers = await db.rows<{ name: string; events: string; always: boolean }>(sql`
      SELECT t.tgname AS name,
             concat_ws(',',
               CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END,
               CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END,
               CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END) AS events,
             t.tgenabled = 'A' AS always
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = ${`public.${table}`}::regclass AND p.proname = 'append_only_guard'`);
    const covered = new Set(triggers.flatMap((t) => t.events.split(",")));
    for (const verb of verbs) expect(covered.has(verb)).toBe(true);
    for (const trigger of triggers) expect(trigger.always).toBe(true);
    if (verbs.includes("TRUNCATE")) {
      const statement =
        table === "storage_moves"
          ? sql`TRUNCATE public.storage_moves`
          : table === "accession_versions"
            ? sql`TRUNCATE public.accession_versions`
            : sql`TRUNCATE public.second_step_alert_notices`;
      expect(await refusedBy(statement)).toBe(`${table}_append_only`);
    }
  });

  it("refuses a row-level change too, naming the table's guard", async () => {
    // A row the guard sees: the trigger refuses before the change is made.
    // (This also shows the function raises with the right constraint.)
    await db.transaction(async (q) => {
      await q.execute(sql`CREATE TEMP TABLE guarded (id int) ON COMMIT DROP`);
      await q.execute(sql`INSERT INTO guarded VALUES (1)`);
      await q.execute(sql`CREATE TRIGGER guarded_append_only BEFORE DELETE ON guarded
        FOR EACH ROW EXECUTE FUNCTION public.append_only_guard()`);
      const error = await q.execute(sql`DELETE FROM guarded`).then(
        () => undefined,
        (e: unknown) => e as { code?: string; constraint?: string },
      );
      expect(error).toMatchObject({ code: "23000", constraint: "guarded_append_only" });
    });
  });
});
