// First-time setup (T-055, first-setup.ts and setup-cli.ts) on fresh
// databases: it makes a system admin who can sign in (second step still to
// come), the organization, the site and the starter template; it refuses to
// run twice, on a database with any person or organization, and when two
// runs race; bad answers save nothing; the command never prints the
// password or the URL's password. Every name, address and password is
// invented (example.org is reserved for examples, RFC 2606).
import { afterAll, describe, expect, it } from "vitest";
import { newOrganizationId, validateTemplate, type Validated } from "@oculus/core";
import { createFirstSystemAdmin, signIn } from "./accounts.js";
import { insertOrganization, readTemplate } from "./catalog.js";
import { openDatabase, type Database } from "./client.js";
import {
  STARTER_TEMPLATE_FIELDS,
  STARTER_TEMPLATE_KEY,
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
           (SELECT count(*)::int FROM public.template_versions) AS templates`);
  if (row === undefined) throw new Error("no row");
  return row;
}

describe("setUpFirstInstall", () => {
  it("makes a system admin who can sign in, the organization, the site and the starter template", async () => {
    const { db } = await migrated();
    expect(await isEmptyInstall(db)).toBe(true);
    const made = ok(await setUpFirstInstall(db, INPUT));
    expect(made.templateKey).toBe(STARTER_TEMPLATE_KEY);
    expect(await counts(db)).toEqual({ users: 1, organizations: 1, sites: 1, templates: 1 });
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
    expect(await counts(db)).toEqual({ users: 1, organizations: 1, sites: 1, templates: 1 });
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
    expect(await counts(db)).toEqual({ users: 1, organizations: 1, sites: 1, templates: 1 });
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
    expect(await counts(db)).toEqual({ users: 0, organizations: 0, sites: 0, templates: 0 });
    // A bad site name alone is reported too.
    const site = await setUpFirstInstall(db, { ...INPUT, siteName: "" });
    expect(site.ok ? [] : site.issues.map((i) => i.path[0])).toEqual(["siteName"]);
    expect(await counts(db)).toEqual({ users: 0, organizations: 0, sites: 0, templates: 0 });
  });

  it("refuses unknown keys, getters and non-objects", async () => {
    const { db } = await migrated();
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
    expect(await counts(db)).toEqual({ users: 0, organizations: 0, sites: 0, templates: 0 });
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
        expect(await counts(db)).toEqual({ users: 1, organizations: 1, sites: 1, templates: 1 });
      } finally {
        await db.close();
      }
      // A second run refuses before asking anything.
      const again = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
      expect(again.code).toBe(1);
      expect(again.out).toContain("already set up");
      expect(again.asked).toEqual([]);
      // It refused before migrating: nothing was even checked for migration.
      expect(again.out).not.toMatch(/migrat/i);
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
    expect(await counts(db)).toEqual({ users: 0, organizations: 0, sites: 0, templates: 0 });
  });

  it("refuses a database with someone else's tables, without adding Oculus's", async () => {
    const testDb = await freshDatabase();
    try {
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        await db.execute(sql`CREATE TABLE public.not_oculus (id int)`);
        const run = await runCli({ OCULUS_DATABASE_URL: testDb.url }, typed);
        expect(run.code).toBe(1);
        expect(run.out).toContain("aren't Oculus's");
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
