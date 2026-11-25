// First-time setup (T-055, first-setup.ts and setup-cli.ts) on fresh
// databases: it makes a system admin who can sign in (second step still to
// come), the organization, the site and the starter template; it refuses to
// run twice, on a database with any person or organization, and when two
// runs race; bad answers save nothing; the command never prints the
// password or the URL's password. Every name, address and password is
// invented (example.org is reserved for examples, RFC 2606).
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  validateDublinCoreMapping,
  validateTemplate,
  type Validated,
} from "@oculus/core";
import { createFirstSystemAdmin, signIn } from "./accounts.js";
import { insertOrganization, readTemplate } from "./catalog.js";
import { openDatabase, type Database } from "./client.js";
import { readDublinCoreMapping } from "./dublin-core-mappings.js";
import {
  STARTER_DUBLIN_CORE_ENTRIES,
  STARTER_TEMPLATE_FIELDS,
  STARTER_TEMPLATE_KEY,
  databaseBeforeSetup,
  isEmptyInstall,
  setUpFirstInstall,
  type FirstInstall,
} from "./first-setup.js";
import { migrate } from "./migrate.js";
import { readSite } from "./permissions.js";
import { runSetupCli, type Ask } from "./setup-cli.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const PASSWORD = "Invented harbor lantern bridge 1909";
const INPUT: FirstInstall = {
  email: "First.Admin@Example.org",
  displayName: "Ada Invented",
  password: PASSWORD,
  organizationName: "Invented Historical Society",
  siteName: "Invented Digital Archive",
};

const opened: { testDb: TestDatabase; db: Database }[] = [];

async function migrated(): Promise<{ db: Database; url: string }> {
  const testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  const db = openDatabase(testDb.url, { max: 4 });
  opened.push({ testDb, db });
  return { db, url: testDb.url };
}

afterAll(async () => {
  for (const { testDb, db } of opened.splice(0)) {
    await db.close();
    await testDb.drop();
  }
});

function ok<T>(r: Validated<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

async function counts(db: Database): Promise<Record<string, number>> {
  const [row] = await db.rows<Record<string, number>>(sql`
    SELECT (SELECT count(*)::int FROM public.users) AS users,
           (SELECT count(*)::int FROM public.organizations) AS organizations,
           (SELECT count(*)::int FROM public.sites) AS sites,
           (SELECT count(*)::int FROM public.template_versions) AS templates,
           (SELECT count(*)::int FROM public.dublin_core_mappings) AS mappings`);
  if (row === undefined) throw new Error("no row");
  return row;
}

describe("setUpFirstInstall", () => {
  it("makes a system admin who can sign in, the organization, the site and the starter template", async () => {
    const { db } = await migrated();
    expect(await isEmptyInstall(db)).toBe(true);
    const made = ok(await setUpFirstInstall(db, INPUT));
    expect(made.templateKey).toBe(STARTER_TEMPLATE_KEY);
    expect(await counts(db)).toEqual({
      users: 1,
      organizations: 1,
      sites: 1,
      templates: 1,
      mappings: 1,
    });
    const [user] = await db.rows<{
      email: string;
      display_name: string;
      system_admin: boolean;
      bootstrap: boolean;
      password_hash: string;
    }>(sql`SELECT email, display_name, system_admin, bootstrap, password_hash FROM public.users`);
    expect(user).toMatchObject({
      email: "first.admin@example.org",
      display_name: "Ada Invented",
      system_admin: true,
      bootstrap: true,
    });
    expect(user?.password_hash).not.toContain(PASSWORD);
    // The second step (two-step set-up at first sign-in) is still to come.
    const signedIn = await signIn(db, {
      email: "first.admin@example.org",
      password: PASSWORD,
      source: "10.55.0.1",
      organizationId: made.organizationId,
    });
    expect(signedIn).toMatchObject({
      ok: true,
      userId: made.userId,
      systemAdmin: true,
      secondStep: "required",
    });
    const [factors] = await db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.second_factors`,
    );
    expect(factors?.n).toBe(0);
    expect(await readSite(db, made.organizationId, made.siteId)).toMatchObject({
      name: "Invented Digital Archive",
    });
    const { template } = ok((await readTemplate(db, made.organizationId, "item")) ?? fail());
    expect(template.label).toBe("Item");
    expect(template.fields.map((f) => f.key)).toEqual(STARTER_TEMPLATE_FIELDS.map((f) => f.key));
    // Staff-only fields stay staff-only.
    expect(template.fields.filter((f) => f.visibility === "staff").map((f) => f.key)).toEqual([
      "location",
      "staff_notes",
    ]);
    // The starter mapping (T-050e): every public field as the DCMI term it
    // names, rights included, made by the new system admin; no staff field.
    const stored = await readDublinCoreMapping(db, made.organizationId, "item");
    expect(stored?.version).toBe(1);
    expect(stored?.mapping).toEqual({
      template: "item",
      organizationId: made.organizationId,
      entries: [
        { field: "description", term: "description" },
        { field: "date", term: "date" },
        { field: "creator", term: "creator" },
        { field: "subject", term: "subject" },
        { field: "rights", term: "rights" },
      ],
    });
    expect(ok(validateDublinCoreMapping(stored?.mapping, template)).entries).toHaveLength(5);
    const [row] = await db.rows<{ changed_by: string }>(
      sql`SELECT changed_by::text AS changed_by FROM public.dublin_core_mappings`,
    );
    expect(row?.changed_by).toBe(made.userId);
  });

  it("refuses to run twice and leaves the first setup alone", async () => {
    const { db } = await migrated();
    ok(await setUpFirstInstall(db, INPUT));
    const again = await setUpFirstInstall(db, {
      ...INPUT,
      email: "second@example.org",
      organizationName: "Another Invented Society",
    });
    expect(again).toMatchObject({ ok: false, issues: [{ code: "already_set_up" }] });
    expect(await counts(db)).toEqual({
      users: 1,
      organizations: 1,
      sites: 1,
      templates: 1,
      mappings: 1,
    });
  });

  it("refuses a database that already has a user, or only an organization", async () => {
    const withUser = await migrated();
    ok(
      await createFirstSystemAdmin(withUser.db, {
        email: "earlier@example.org",
        displayName: "Earlier Admin",
        password: PASSWORD,
      }),
    );
    expect(await setUpFirstInstall(withUser.db, INPUT)).toMatchObject({
      ok: false,
      issues: [{ code: "already_set_up" }],
    });
    expect(await counts(withUser.db)).toMatchObject({ users: 1, organizations: 0, sites: 0 });

    const withOrganization = await migrated();
    ok(
      await insertOrganization(withOrganization.db, {
        id: newOrganizationId(),
        name: "Earlier Invented Society",
      }),
    );
    expect(await setUpFirstInstall(withOrganization.db, INPUT)).toMatchObject({
      ok: false,
      issues: [{ code: "already_set_up" }],
    });
    expect(await counts(withOrganization.db)).toMatchObject({ users: 0, organizations: 1 });
  });

  it("lets only one of two runs at once succeed, and the other leaves nothing", async () => {
    const { db } = await migrated();
    const results = await Promise.all([
      setUpFirstInstall(db, INPUT),
      setUpFirstInstall(db, { ...INPUT, email: "rival@example.org", organizationName: "Rival" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ issues: [{ code: "already_set_up" }] });
    expect(await counts(db)).toEqual({
      users: 1,
      organizations: 1,
      sites: 1,
      templates: 1,
      mappings: 1,
    });
  });

  it("checks every answer before anything is saved", async () => {
    const { db } = await migrated();
    const r = await setUpFirstInstall(db, {
      email: "not an address",
      displayName: " padded ",
      password: "short",
      organizationName: "",
      siteName: "x".repeat(5000),
    });
    expect(r.ok).toBe(false);
    const fields = new Set(r.ok ? [] : r.issues.map((i) => i.path[0]));
    expect(fields).toEqual(new Set(["email", "displayName", "password", "organizationName"]));
    expect(await counts(db)).toEqual({
      users: 0,
      organizations: 0,
      sites: 0,
      templates: 0,
      mappings: 0,
    });
    // A bad site name alone is reported too.
    const site = await setUpFirstInstall(db, { ...INPUT, siteName: "" });
    expect(site.ok ? [] : site.issues.map((i) => i.path[0])).toEqual(["siteName"]);
    expect(await counts(db)).toEqual({
      users: 0,
      organizations: 0,
      sites: 0,
      templates: 0,
      mappings: 0,
    });
  });

  it("refuses unknown keys, getters and non-objects", async () => {
    const { db } = await migrated();
    const throwingRead = new Proxy(
      { ...INPUT },
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    const throwing = new Proxy(
      { ...INPUT },
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    for (const bad of [
      null,
      "text",
      [],
      new Date(),
      new Map(),
      Object.assign(Object.create({ inherited: 1 }) as object, INPUT),
      throwing,
      throwingRead,
      { ...INPUT, systemAdmin: false },
    ]) {
      expect(await setUpFirstInstall(db, bad)).toMatchObject({
        ok: false,
        issues: [{ code: "invalid_request" }],
      });
    }
    const getter = { ...INPUT };
    Object.defineProperty(getter, "email", { get: () => INPUT.email, enumerable: true });
    const r = await setUpFirstInstall(db, getter);
    expect(r.ok ? [] : r.issues.map((i) => i.path[0])).toEqual(["email"]);
    expect(await counts(db)).toEqual({
      users: 0,
      organizations: 0,
      sites: 0,
      templates: 0,
      mappings: 0,
    });
  });

  it("has a starter template that core accepts", () => {
    const valid = validateTemplate({
      key: STARTER_TEMPLATE_KEY,
      organizationId: newOrganizationId(),
      label: "Item",
      appliesTo: ["object", "archival_unit", "digital_asset"],
      fields: STARTER_TEMPLATE_FIELDS,
    });
    expect(valid.ok).toBe(true);
    // Its mapping names only public fields, and maps the rights (D-096).
    const publicKeys = new Set(
      STARTER_TEMPLATE_FIELDS.filter((f) => f.visibility === "public").map((f) => f.key),
    );
    expect(STARTER_DUBLIN_CORE_ENTRIES.every((e) => publicKeys.has(e.field))).toBe(true);
    expect(STARTER_DUBLIN_CORE_ENTRIES).toContainEqual({ field: "rights", term: "rights" });
  });
});

/** A scripted `Ask` that records the questions and whether each was secret. */
function scripted(answers: readonly string[]): {
  ask: Ask;
  asked: { question: string; secret: boolean }[];
} {
  const queue = [...answers];
  const asked: { question: string; secret: boolean }[] = [];
  return {
    asked,
    ask: (question, { secret }) => {
      asked.push({ question, secret });
      return Promise.resolve(queue.shift());
    },
  };
}

async function runCli(
  env: Record<string, string | undefined>,
  answers: readonly string[],
): Promise<{ code: number; out: string; asked: { question: string; secret: boolean }[] }> {
  const lines: string[] = [];
  const s = scripted(answers);
  const code = await runSetupCli(
    env,
    s.ask,
    (l) => lines.push(l),
    (l) => lines.push(l),
  );
  return { code, out: lines.join("\n"), asked: s.asked };
}

describe("npm run setup", () => {
  const typed = [
    INPUT.organizationName,
    INPUT.siteName,
    INPUT.displayName,
    INPUT.email,
    PASSWORD,
    PASSWORD,
  ];

  it("migrates an empty database, asks the questions and sets it up", async () => {
    const testDb = await freshDatabase();
    try {
      const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(run.code).toBe(0);
      expect(run.out).toContain("Done.");
      expect(run.out).not.toContain(PASSWORD);
      expect(run.asked.map((a) => a.secret)).toEqual([false, false, false, false, true, true]);
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        expect(await counts(db)).toEqual({
          users: 1,
          organizations: 1,
          sites: 1,
          templates: 1,
          mappings: 1,
        });
      } finally {
        await db.close();
      }
      // A second run refuses before asking anything.
      const again = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(again.code).toBe(1);
      expect(again.out).toContain("already set up");
      expect(again.asked).toEqual([]);
    } finally {
      await testDb.drop();
    }
  });

  it("takes answers from the environment but never the password", async () => {
    const { db, url } = await migrated();
    const run = await runCli(
      {
        OCULUS_DATABASE_URL: url,
        OCULUS_SETUP_ORGANIZATION: INPUT.organizationName,
        OCULUS_SETUP_SITE: INPUT.siteName,
        OCULUS_SETUP_NAME: INPUT.displayName,
        OCULUS_SETUP_EMAIL: INPUT.email,
        OCULUS_SETUP_PASSWORD: PASSWORD,
      },
      ["Another invented passphrase 2026", "Another invented passphrase 2026"],
    );
    expect(run.code).toBe(0);
    expect(run.asked.map((a) => a.secret)).toEqual([true, true]);
    const r = await signIn(db, { email: INPUT.email, password: PASSWORD, source: "10.55.0.2" });
    expect(r.ok).toBe(false);
  });

  it("saves nothing when the passwords differ, an answer is bad, or input ends", async () => {
    const { db, url } = await migrated();
    const differ = await runCli({ OCULUS_DATABASE_URL: url }, [
      ...typed.slice(0, 5),
      `${PASSWORD} typo`,
    ]);
    expect(differ.code).toBe(1);
    expect(differ.out).toContain("different");
    const bad = await runCli({ OCULUS_DATABASE_URL: url }, [
      ...typed.slice(0, 3),
      "not an address",
      PASSWORD,
      PASSWORD,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Email address:");
    expect(bad.out).not.toContain(PASSWORD);
    const ended = await runCli({ OCULUS_DATABASE_URL: url }, typed.slice(0, 2));
    expect(ended.code).toBe(2);
    expect(await counts(db)).toEqual({
      users: 0,
      organizations: 0,
      sites: 0,
      templates: 0,
      mappings: 0,
    });
  });

  it("refuses a database with someone else's tables, without adding Oculus's", async () => {
    const testDb = await freshDatabase();
    try {
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        await db.execute(sql`CREATE TABLE public.not_oculus (id int)`);
        const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
        expect(run.code).toBe(1);
        expect(run.out).toContain("isn't an Oculus database");
        expect(run.asked).toEqual([]);
        const [row] = await db.rows<{ there: boolean }>(
          sql`SELECT to_regclass('public.oculus_migrations') IS NOT NULL AS there`,
        );
        expect(row?.there).toBe(false);
      } finally {
        await db.close();
      }
    } finally {
      await testDb.drop();
    }
  });

  it("refuses a set-up database with a pending migration without applying it", async () => {
    const { db, url } = await migrated();
    ok(await setUpFirstInstall(db, INPUT));
    // Pretend the newest migration is still to come.
    const [last] = await db.rows<{ name: string }>(
      sql`SELECT name FROM public.oculus_migrations ORDER BY name DESC LIMIT 1`,
    );
    await db.execute(sql`DELETE FROM public.oculus_migrations WHERE name = ${last?.name ?? ""}`);
    const run = await runCli({ OCULUS_DATABASE_URL: url }, typed);
    expect(run.code).toBe(1);
    expect(run.out).toContain("already set up");
    const [still] = await db.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM public.oculus_migrations WHERE name = ${last?.name ?? ""}`,
    );
    expect(still?.n).toBe(0);
  });

  it("sets up a partly migrated Oculus database", async () => {
    const testDb = await freshDatabase();
    // Only the first three migrations, as if a run had stopped there.
    const partial = mkdtempSync(join(tmpdir(), "oculus-setup-"));
    try {
      const all = join(import.meta.dirname, "..", "migrations");
      for (const name of readdirSync(all).sort().slice(0, 3)) {
        copyFileSync(join(all, name), join(partial, name));
      }
      await migrate({ connectionString: testDb.url, dir: partial });
      const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(run.code).toBe(0);
    } finally {
      rmSync(partial, { recursive: true, force: true });
      await testDb.drop();
    }
  });

  it("trusts Oculus's migration table only when its names and hashes match the files (S-031)", async () => {
    const cases = [
      // A row whose hash isn't the file's.
      [
        sql`CREATE TABLE public.oculus_migrations (name text PRIMARY KEY, sha256 text NOT NULL)`,
        sql`INSERT INTO public.oculus_migrations VALUES ('0001_migrations_table.sql', 'not-the-hash')`,
      ],
      // A name no file has.
      [
        sql`CREATE TABLE public.oculus_migrations (name text PRIMARY KEY, sha256 text NOT NULL)`,
        sql`INSERT INTO public.oculus_migrations VALUES ('9999_someone_elses.sql', 'x')`,
      ],
      // No hashes at all.
      [sql`CREATE TABLE public.oculus_migrations (name text PRIMARY KEY)`],
    ];
    for (const statements of cases) {
      const testDb = await freshDatabase();
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        for (const statement of statements) await db.execute(statement);
        expect(await databaseBeforeSetup(db)).toBe("other");
        const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
        expect(run.code).toBe(1);
        expect(run.asked).toEqual([]);
      } finally {
        await db.close();
        await testDb.drop();
      }
    }
  });

  it("doesn't finish a migrated database that has things the migrations never make (S-031)", async () => {
    const testDb = await freshDatabase();
    const db = openDatabase(testDb.url, { max: 1 });
    try {
      await migrate({ connectionString: testDb.url });
      expect(await databaseBeforeSetup(db)).toBe("empty");
      await db.execute(sql`CREATE SCHEMA side_door`);
      expect(await databaseBeforeSetup(db)).toBe("other");
      const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(run.code).toBe(1);
      expect(run.asked).toEqual([]);
    } finally {
      await db.close();
      await testDb.drop();
    }
  });

  it("says an extension from template1 is why a new database isn't empty (S-031)", async () => {
    const testDb = await freshDatabase();
    const db = openDatabase(testDb.url, { max: 1 });
    try {
      await db.execute(sql`CREATE EXTENSION citext`);
      expect(await databaseBeforeSetup(db)).toBe("other");
      const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(run.code).toBe(1);
      expect(run.out).toContain("template1");
      expect(run.out).toContain("createdb -T template0 oculus");
      // With something of someone else's too, the ordinary refusal.
      await db.execute(sql`CREATE TABLE public.theirs (a int)`);
      const other = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(other.out).not.toContain("template1");
    } finally {
      await db.close();
      await testDb.drop();
    }
  });

  it("runs the migration with the keyboard quiet (S-031)", async () => {
    const testDb = await freshDatabase();
    try {
      const order: string[] = [];
      const s = scripted(typed);
      const code = await runSetupCli(
        { OCULUS_DATABASE_URL: testDb.url },
        async (question, options) => {
          order.push("ask");
          return s.ask(question, options);
        },
        (l) => {
          if (l.includes("0001_")) order.push("migrating");
        },
        () => undefined,
        undefined,
        async (work) => {
          order.push("quiet");
          const done = await work();
          order.push("loud");
          return done;
        },
      );
      expect(code).toBe(0);
      expect(order.slice(0, 2)).toEqual(["quiet", "migrating"]);
      expect(order.indexOf("loud")).toBeLessThan(order.indexOf("ask"));
    } finally {
      await testDb.drop();
    }
  });

  it("classifies databases that aren't Oculus's, and changes none of them", async () => {
    const cases = [
      [sql`CREATE SCHEMA app`, sql`CREATE TABLE app.things (id int)`],
      [sql`CREATE VIEW public.v AS SELECT 1 AS one`],
      [sql`CREATE SEQUENCE public.s`],
      [sql`CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`],
      [sql`CREATE TYPE public.records AS ENUM ('a')`],
      [sql`CREATE TYPE public.c AS (a int)`],
      [sql`CREATE SCHEMA pgxtempx`, sql`CREATE TABLE pgxtempx.secret (a int)`],
      [
        sql`CREATE SCHEMA only_functions`,
        sql`CREATE FUNCTION only_functions.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      ],
      [sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC`],
      [sql`CREATE PUBLICATION everything FOR ALL TABLES`],
      // An Oculus database with a publication added: still refused.
      [
        sql`CREATE TABLE public.oculus_migrations (name text PRIMARY KEY)`,
        sql`CREATE PUBLICATION everything FOR ALL TABLES`,
      ],
      // Oculus's bookkeeping, with someone else's users table that predates 0009.
      [
        sql`CREATE TABLE public.oculus_migrations (name text PRIMARY KEY)`,
        sql`CREATE TABLE public.users (id int)`,
      ],
    ];
    for (const statements of cases) {
      const testDb = await freshDatabase();
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        for (const statement of statements) await db.execute(statement);
        expect(await databaseBeforeSetup(db)).toBe("other");
        const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
        expect(run.code).toBe(1);
        expect(run.asked).toEqual([]);
        const [row] = await db.rows<{ organizations: boolean }>(
          sql`SELECT to_regclass('public.organizations') IS NOT NULL AS organizations`,
        );
        expect(row?.organizations).toBe(false);
      } finally {
        await db.close();
        await testDb.drop();
      }
    }
  });

  it("needs the database URL and never prints its password", async () => {
    expect((await runCli({}, typed)).code).toBe(2);
    const run = await runCli(
      { OCULUS_DATABASE_URL: "postgresql://someone:Invented-Secret-77@127.0.0.1:1/none" },
      typed,
    );
    expect(run.code).toBe(1);
    expect(run.out).not.toContain("Invented-Secret-77");
    expect(run.asked).toEqual([]);
  });
});

function fail(): never {
  throw new Error("missing");
}
