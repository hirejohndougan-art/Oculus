// `npm run admin` refuses to start unless it connects as the plain writer
// role (S-062, D-067): a superuser, a role that owns something, or a writer
// missing a grant (a new migration's table after an update) is named before
// the server listens. Over a fresh database and throwaway login roles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantWriterRole,
  migrate,
  openDatabase,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { runAdminCli, writerConnectionRefusal } from "./admin-cli.js";

let testDb: TestDatabase;
let db: Database;
const suffix = `${String(process.pid)}_${String(Date.now() % 100_000)}`;
const writer = `oculus_test_s062_w_${suffix}`;
const owner = `oculus_test_s062_o_${suffix}`;

/** Runs a statement with a role's name quoted by format('%I'). */
async function withRole(q: Queryable, role: string, statement: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

function urlAs(role: string): string {
  const url = new URL(testDb.url);
  url.username = role;
  return url.toString();
}

async function refusalAs(role: string): Promise<string | undefined> {
  const as = openDatabase(urlAs(role), { max: 1 });
  try {
    return await writerConnectionRefusal(as);
  } finally {
    await as.close();
  }
}

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction(async (q) => {
      await withRole(q, writer, "CREATE ROLE %I LOGIN");
      await withRole(q, owner, "CREATE ROLE %I LOGIN");
    });
  } finally {
    await server.close();
  }
  await db.transaction((q) => grantWriterRole(q, writer));
  await db.transaction((q) => grantWriterRole(q, owner));
}, 60_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction(async (q) => {
      await withRole(q, writer, "DROP ROLE IF EXISTS %I");
      await withRole(q, owner, "DROP ROLE IF EXISTS %I");
    });
  } finally {
    await server.close();
  }
});

describe("the admin server's database role at start (S-062)", () => {
  it("accepts the plain writer", async () => {
    expect(await refusalAs(writer)).toBeUndefined();
  });

  it("refuses a superuser, naming only the problem's code", async () => {
    const refusal = await writerConnectionRefusal(db);
    expect(refusal).toMatch(/must connect as the plain writer role/);
    expect(refusal).toMatch(/superuser/);
  });

  it("refuses a writer missing one grant, and says how to grant it", async () => {
    await db.transaction((q) => withRole(q, writer, "REVOKE INSERT ON public.records FROM %I"));
    try {
      const refusal = await refusalAs(writer);
      expect(refusal).toMatch(/missing_privilege/);
      expect(refusal).toMatch(/grant-cli\.js <writer role>/);
      expect(refusal).not.toContain(writer);
    } finally {
      await db.transaction((q) => grantWriterRole(q, writer));
    }
    expect(await refusalAs(writer)).toBeUndefined();
  });

  it("refuses a role that owns a table", async () => {
    await db.transaction((q) => withRole(q, owner, "ALTER TABLE public.sites OWNER TO %I"));
    try {
      const refusal = await refusalAs(owner);
      expect(refusal).toMatch(/never a superuser or the owner; found: .*own/);
      expect(refusal).not.toContain(owner);
    } finally {
      await db.execute(sql`ALTER TABLE public.sites OWNER TO CURRENT_USER`);
    }
  });

  it("refuses when the account can't be checked", async () => {
    const down = openDatabase("postgresql://nobody@127.0.0.1:1/invented", {
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      expect(await writerConnectionRefusal(down)).toMatch(/can't be checked/);
    } finally {
      await down.close();
    }
  });

  it("makes npm run admin exit 1 before listening, never showing the URL", async () => {
    const lines: string[] = [];
    // The test server's own superuser connection.
    const code = await runAdminCli({ OCULUS_DATABASE_URL: testDb.url, OCULUS_PORT: "1" }, (line) =>
      lines.push(line),
    );
    expect(code).toBe(1);
    const said = lines.join("\n");
    expect(said).toMatch(/Oculus did not start: OCULUS_DATABASE_URL must connect/);
    expect(said).not.toContain(testDb.url);
    expect(said).not.toContain(new URL(testDb.url).pathname.slice(1));
  });
});
