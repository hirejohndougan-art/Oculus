// Definitions in the change log (S-064, D-117, migration 0051): every
// INSERT or UPDATE of an identifier type, term, site, the storage levels or
// a location, a Dublin Core mapping or the System settings writes a row in
// the same transaction, naming `oculus.actor` (or the row's own editor);
// rows are stamped now and never changed, deleted or emptied; the audit
// trail shows them to whom they concern. Every name is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, newSiteId, type SiteId, type UserId } from "@oculus/core";
import { createFirstSystemAdmin } from "./accounts.js";
import { insertOrganization } from "./catalog.js";
import { openDatabase, type Database, type Queryable } from "./client.js";
import { insertIdentifierType, updateIdentifierType } from "./identifiers.js";
import { migrate } from "./migrate.js";
import { changedProperties, isAuditCursor, readAuditTrail } from "./people.js";
import { insertSite, renameSite, writeSystemSettings } from "./permissions.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";
import { saveTerm } from "./vocabularies.js";

let testDb: TestDatabase;
let db: Database;
let admin: UserId;
const org = newOrganizationId();
const siteA: SiteId = newSiteId();
const siteB: SiteId = newSiteId();

interface EventRow {
  actor: string | null;
  subject: string;
  subject_key: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  organization_id: string | null;
}

async function events(subject: string): Promise<EventRow[]> {
  return db.rows<EventRow>(sql`
    SELECT actor, subject, subject_key, action, before, after, organization_id::text
    FROM public.definition_events WHERE subject = ${subject}
    ORDER BY occurred_at, id`);
}

/** Runs `work` in a transaction whose `oculus.actor` is `actor` (as the service does). */
async function as<T>(actor: string | null, work: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (actor !== null) {
      await tx.rows(sql`SELECT pg_catalog.set_config('oculus.actor', ${actor}, true)`);
    }
    return work(tx);
  });
}

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
  for (const [id, name] of [
    [siteA, "Invented Archives"],
    [siteB, "Invented Library"],
  ] as const) {
    const site = await as(null, (tx) => insertSite(tx, { id, organizationId: org, name }));
    if (!site.ok) throw new Error("no site");
  }
}, 60_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
});

describe("definition_events", () => {
  it("logs a site made and renamed, with who, before and after", async () => {
    const renamed = await as(`user:${admin}`, (tx) =>
      renameSite(tx, org, siteA, "Invented Archives Room"),
    );
    expect(renamed.ok).toBe(true);
    const rows = (await events("site")).filter((r) => r.subject_key === siteA);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor: null, action: "created", before: null });
    expect(rows[1]).toMatchObject({
      actor: `user:${admin}`,
      action: "changed",
      organization_id: org,
      before: { name: "Invented Archives" },
      after: { name: "Invented Archives Room" },
    });
    expect(rows[1]?.after).not.toHaveProperty("organization_id");
    expect(rows[1]?.after).not.toHaveProperty("created_at");
  });

  it("writes nothing when only a timestamp changes", async () => {
    const before = (await events("site")).length;
    await as(`user:${admin}`, (tx) => renameSite(tx, org, siteB, "Invented Library"));
    await db.execute(
      sql`UPDATE public.sites SET created_at = created_at WHERE id = ${siteB}::uuid`,
    );
    expect(await events("site")).toHaveLength(before);
  });

  it("goes with its change: a rolled-back change leaves no row", async () => {
    const before = (await events("site")).length;
    await expect(
      as(`user:${admin}`, async (tx) => {
        await renameSite(tx, org, siteB, "Invented Library Annex");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await events("site")).toHaveLength(before);
  });

  it("logs identifier types and terms made and changed", async () => {
    const made = await as(`user:${admin}`, (tx) =>
      insertIdentifierType(tx, {
        organizationId: org,
        key: "object_number",
        label: "Object number",
        uniqueness: "current",
      }),
    );
    expect(made.ok).toBe(true);
    const changed = await as(`user:${admin}`, (tx) =>
      updateIdentifierType(tx, {
        organizationId: org,
        key: "object_number",
        label: "Object no.",
        uniqueness: "all_time",
      }),
    );
    expect(changed.ok).toBe(true);
    const types = await events("identifier_type");
    expect(types.map((r) => [r.action, r.subject_key, r.actor])).toEqual([
      ["created", "object_number", `user:${admin}`],
      ["changed", "object_number", `user:${admin}`],
    ]);
    expect(changedProperties(types[1]?.before, types[1]?.after)).toEqual(["label", "uniqueness"]);

    const term = await as(`user:${admin}`, (tx) =>
      saveTerm(tx, {
        organizationId: org,
        term: { vocabulary: "local", label: "Invented quilts" },
      }),
    );
    if (!term.ok) throw new Error("no term");
    await as(`user:${admin}`, (tx) =>
      saveTerm(tx, {
        organizationId: org,
        id: term.value.id,
        term: { vocabulary: "local", label: "Invented bed quilts" },
      }),
    );
    const terms = await events("term");
    expect(terms.map((r) => [r.action, r.subject_key, r.after.label])).toEqual([
      ["created", term.value.id, "Invented quilts"],
      ["changed", term.value.id, "Invented bed quilts"],
    ]);
  });

  it("logs the System settings with no organization, naming their editor", async () => {
    const written = await db.transaction((tx) =>
      writeSystemSettings(tx, { sessionIdleMinutes: 45, sessionAbsoluteMinutes: 720 }, 0, admin),
    );
    expect(written.ok).toBe(true);
    const rows = await events("system_settings");
    expect(rows).toEqual([
      expect.objectContaining({
        actor: `user:${admin}`,
        organization_id: null,
        subject_key: null,
        action: "created",
      }),
    ]);
  });

  it("refuses an actor that isn't an account or a system name", async () => {
    await expect(
      as("someone else", (tx) => renameSite(tx, org, siteB, "Invented Library West")),
    ).rejects.toMatchObject({ constraint: "definition_events_actor_format" });
  });

  it("is never changed, deleted or emptied, by the owner or in replica mode", async () => {
    const count = async () =>
      (
        await db.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM public.definition_events`)
      )[0]?.n;
    const before = await count();
    for (const statement of [
      sql`UPDATE public.definition_events SET action = 'created'`,
      sql`DELETE FROM public.definition_events`,
      sql`TRUNCATE public.definition_events`,
    ]) {
      await expect(db.execute(statement)).rejects.toMatchObject({
        constraint: "definition_events_append_only",
      });
      await expect(
        db.transaction(async (q) => {
          await q.execute(sql`SET LOCAL session_replication_role = replica`);
          await q.execute(statement);
        }),
      ).rejects.toMatchObject({ constraint: "definition_events_append_only" });
    }
    await expect(
      db.execute(sql`
        INSERT INTO public.definition_events (organization_id, occurred_at, subject, subject_key, action, after)
        VALUES (${org}::uuid, now() - interval '1 day', 'site', ${siteA}, 'created', '{}')`),
    ).rejects.toMatchObject({ constraint: "definition_events_now" });
    expect(await count()).toBe(before);
  });

  it("still logs in replica mode, and has every 0051 trigger enabled ALWAYS", async () => {
    const before = (await events("site")).length;
    await db.transaction(async (q) => {
      await q.execute(sql`SET LOCAL session_replication_role = replica`);
      await renameSite(q, org, siteB, "Invented Library North");
    });
    expect(await events("site")).toHaveLength(before + 1);
    const rows = await db.rows<{ name: string; enabled: string }>(sql`
      SELECT c.relname || '.' || t.tgname AS name, t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'definition_events%'
      ORDER BY 1`);
    expect(rows.map((r) => r.name)).toEqual([
      "definition_events.definition_events_append_only",
      "definition_events.definition_events_check_new",
      "definition_events.definition_events_no_truncate",
      "dublin_core_mappings.definition_events_log",
      "identifier_types.definition_events_log",
      "sites.definition_events_log",
      "storage_levels.definition_events_log",
      "storage_locations.definition_events_log",
      "system_settings.definition_events_log",
      "terms.definition_events_log",
    ]);
    expect(rows.every((r) => r.enabled === "A")).toBe(true);
  });
});

describe("the audit trail's definitions", () => {
  const scopeAll = { records: "all" as const, people: "all" as const };

  it("shows the organization's definitions to whole-organization viewers, not the System settings", async () => {
    const page = await readAuditTrail(db, org, scopeAll, { limit: 100 });
    const lines = page.entries.filter((e) => e.type === "definition");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((e) => e.subject === "system_settings")).toBe(false);
    const rename = lines.find(
      (e) => e.subject === "site" && e.key === siteA && e.action === "changed",
    );
    expect(rename).toMatchObject({
      actor: `user:${admin}`,
      actorName: "Invented Root",
      name: "Invented Archives Room",
      changes: ["name"],
    });
    const made = lines.find(
      (e) => e.subject === "site" && e.key === siteA && e.action === "created",
    );
    expect(made).toMatchObject({ actor: "command_line", changes: [] });
  });

  it("shows a site-scoped viewer only its own site's lines", async () => {
    const page = await readAuditTrail(
      db,
      org,
      { records: [siteB], people: [siteB] },
      { limit: 100 },
    );
    const lines = page.entries.filter((e) => e.type === "definition");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((e) => e.subject === "site" && e.key === siteB)).toBe(true);
  });

  it("shows the System settings to system managers, and nothing for a record filter", async () => {
    const page = await readAuditTrail(db, org, { ...scopeAll, system: true }, { limit: 100 });
    expect(
      page.entries.some((e) => e.type === "definition" && e.subject === "system_settings"),
    ).toBe(true);
    const one = await readAuditTrail(
      db,
      org,
      { ...scopeAll, system: true },
      { recordId: "00000000-0000-4000-8000-000000000000", limit: 100 },
    );
    expect(one.entries.filter((e) => e.type === "definition")).toEqual([]);
  });

  it("filters by person and pages through definition lines", async () => {
    const mine = await readAuditTrail(db, org, scopeAll, { actorId: admin, limit: 100 });
    expect(mine.entries.every((e) => e.actor === `user:${admin}`)).toBe(true);
    const first = await readAuditTrail(db, org, scopeAll, { limit: 1 });
    expect(first.next).not.toBeNull();
    expect(isAuditCursor(first.next)).toBe(true);
    const second = await readAuditTrail(db, org, scopeAll, { limit: 1, after: first.next ?? "" });
    expect(second.entries[0]).not.toEqual(first.entries[0]);
  });

  it("reads cursors of every new kind", () => {
    const at = "2026-11-25T15:00:00.000000";
    const id = "6f1c2f1e-1d2b-4c3a-8b4e-0a1b2c3d4e5f";
    for (const key of [`d${id}`, `f${id}`, `m${id}`, `a${id}:0000000001`, `h${id}:o`, `h${id}:e`]) {
      expect(isAuditCursor(`${at}_${key}`)).toBe(true);
    }
    expect(isAuditCursor(`${at}_h${id}:x`)).toBe(false);
    expect(isAuditCursor(`${at}_x${id}`)).toBe(false);
  });
});
