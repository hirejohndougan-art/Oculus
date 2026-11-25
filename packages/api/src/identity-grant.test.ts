// The writer reads the cluster's system identifier (S-052, D-086): where an
// administrator has revoked `pg_control_system()` from PUBLIC (PostgreSQL
// grants it to everyone by default; some hardened or hosted servers don't),
// the writer's identity is only `-:<oid>` and the purge refuses
// (`identity_unknown`). `grantWriterRole` (and so `npm run db:grant`, the
// desktop launcher and `npm run desktop:database`) grants it when the
// connecting role may, and a role that may not changes nothing and fails
// nothing. Over a fresh database whose own pg_catalog is changed (function
// privileges are per database), a throwaway role and a throwaway folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  databaseIdentity,
  grantIdentityRead,
  grantWriterRole,
  identityGrantHint,
  migrate,
  openDatabase,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import { createService, openFileStore } from "@oculus/service";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { runGrantCli } from "../../db/src/grant-cli.js";

let testDb: TestDatabase;
let db: Database;
let dir: string;
const role = `oculus_test_s052_${String(process.pid)}_${String(Date.now() % 100_000)}`;

/** Runs a statement with the role's name quoted by format('%I'). */
async function withRole(q: Queryable, statement: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN"));
  } finally {
    await server.close();
  }
  // As a hardened server would have it, in this database only.
  await db.execute(sql`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC`);
  dir = mkdtempSync(join(tmpdir(), "oculus-identity-grant-"));
}, 60_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I"));
  } finally {
    await server.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

function asWriter(): Database {
  const url = new URL(testDb.url);
  url.username = role;
  return openDatabase(url.toString(), { max: 2 });
}

describe("the writer can read the cluster's identity after its grant (S-052)", () => {
  it("is refused as identity_unknown without it, and purges once grantWriterRole has run as a superuser", async () => {
    // The writer's table privileges alone, without the identity grant.
    await db.transaction(async (q) => {
      await grantWriterRole(q, role);
      await withRole(q, "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM %I");
    });
    const store = await openFileStore({ dir });
    const writer = asWriter();
    try {
      expect((await databaseIdentity(writer)).startsWith("-:")).toBe(true);
      const blind = createService(writer, { files: store });
      expect(await blind.bindFileStore()).toEqual({ ok: true, warning: "files_identity_unknown" });
      expect(await blind.purgeFiles({ apply: false })).toEqual({
        ok: false,
        problem: "identity_unknown",
      });
      // A role that may not grant changes nothing and fails nothing, even
      // inside a transaction that goes on afterwards.
      const tried = await writer.transaction(async (q) => {
        const readable = await grantIdentityRead(q);
        await q.rows(sql`SELECT 1 AS one`);
        return readable;
      });
      expect(tried).toBe(false);
      expect(identityGrantHint(role)).toContain(
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role}`,
      );
      // The grant, as setup and the grant command run it (as the superuser here).
      const lines: string[] = [];
      expect(
        await runGrantCli(
          [role],
          { OCULUS_DATABASE_URL: testDb.url },
          (l) => lines.push(l),
          (l) => lines.push(`ERR ${l}`),
        ),
      ).toBe(0);
      expect(lines.join("\n")).not.toContain("identity_unknown");
      expect(await db.transaction((q) => grantWriterRole(q, role))).toEqual({
        identityReadable: true,
      });
      // Now the writer reads the identifier, and the purge runs.
      const identity = await databaseIdentity(writer);
      expect(identity.startsWith("-:")).toBe(false);
      expect(identity).toBe(await databaseIdentity(db));
      // The marker still names `-:` from the blind bind: accepted, then it purges.
      const sighted = createService(writer, { files: store });
      expect((await sighted.bindFileStore()).ok).toBe(true);
      const accepted = await sighted.acceptFileStoreIdentity();
      expect(accepted.ok).toBe(true);
      const purged = await sighted.purgeFiles({ apply: false });
      expect(purged.ok).toBe(true);
      expect((await sighted.purgeFiles({ apply: true })).ok).toBe(true);
    } finally {
      await writer.close();
    }
  }, 60_000);
});
