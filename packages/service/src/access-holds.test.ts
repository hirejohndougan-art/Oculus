// The access-holds pass (T-034f, D-120), over a fresh database as the
// writer role, with the public reader for public output: published records
// an accession holds back are withdrawn as a version by the pass, records
// it withdrew are published again once nothing holds them (on the
// organization's own day), people's own decisions are never undone, a dry
// run changes nothing, and nothing of an accession reaches the change log.
// Every person, record and number here is invented.
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  grantPublicReaderRole,
  grantWriterRole,
  insertIdentifierType,
  insertOrganization,
  insertTemplateVersion,
  migrate,
  openDatabase,
  readPublicRecord,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import {
  ACCESS_HOLDS_ACTOR,
  HOLD_PUBLISH_REASON,
  HOLD_WITHDRAW_REASON,
  applyAccessHolds,
} from "./access-holds.js";
import { createService, type RecordService, type ServiceResult } from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

const BASE = "https://archive.example.org/records/";
const SECRET = {
  donor: "Invented Thibodeaux Family",
  materials: "Invented: two albums of bayou photographs",
  restrictions: "Invented: closed until the family says otherwise",
  note: "Invented note: call the eldest daughter first",
};

interface Setup {
  testDb: TestDatabase;
  owner: Database;
  writer: Database;
  reader: Database;
  roles: string[];
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;
let folks: People;
let peopleReady: Promise<People> | undefined;

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

function as(url: string, role: string): Database {
  const u = new URL(url);
  u.username = role;
  return openDatabase(u.toString(), { max: 4 });
}

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const suffix = newRecordId().slice(0, 8);
    const roles = [`oculus_t034f_writer_${suffix}`, `oculus_t034f_reader_${suffix}`];
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      for (const role of roles) {
        await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", role));
      }
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction(async (q) => {
      await grantWriterRole(q, roles[0] ?? "");
      await grantPublicReaderRole(q, roles[1] ?? "");
    });
    return {
      testDb,
      owner,
      writer: as(testDb.url, roles[0] ?? ""),
      reader: as(testDb.url, roles[1] ?? ""),
      roles,
    };
  })();
  s = await setup;
  service = createService(s.writer);
  peopleReady ??= (async () => {
    const holding = newOrganizationId();
    ok(await insertOrganization(s.owner, { id: holding, name: "Invented Holding Society" }));
    return people(s.owner, holding);
  })();
  folks = await peopleReady;
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (!done) return;
  for (const pool of [done.writer, done.reader, done.owner]) await pool.close();
  await done.testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    for (const role of done.roles) {
      await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I", role));
    }
  } finally {
    await server.close();
  }
});

function ok<T>(result: Validated<T> | ServiceResult<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

interface World {
  org: OrganizationId;
  site: SiteId;
  donor: CatalogRecord;
  fonds: CatalogRecord;
  item: CatalogRecord;
  vase: CatalogRecord;
  donorStaff: UserId;
  root: UserId;
}

let count = 0;
async function world(): Promise<World> {
  count += 1;
  const tag = String(count);
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: `Invented Society ${tag}` }));
  const field = (key: string, kind = "text") => ({
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility: "public" as const,
    inherited: false,
  });
  for (const [key, appliesTo] of [
    ["t-object", ["object"]],
    ["t-unit", ["archival_unit"]],
    ["t-agent", ["agent"]],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [...appliesTo],
        fields: [field("description"), field("rights", "rights")],
      }),
    );
  }
  ok(
    await s.owner.transaction((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "accession_number",
        label: "Accession number",
        uniqueness: "all_time",
        public: false,
      }),
    ),
  );
  const root = folks.root;
  for (const template of ["t-object", "t-unit"]) {
    ok(
      await service.saveDublinCoreMapping(
        { organizationId: org, actor: actorOf(root) },
        template,
        {
          entries: [
            { field: "description", term: "description" },
            { field: "rights", term: "rights" },
          ],
        },
        { expectedVersion: 0 },
      ),
    );
  }
  const site = await makeSite(service, root, org, `Invented site ${tag}`);
  const donorStaff = await folks.member(org, `donors-${tag}`);
  await grant(service, root, org, { userId: donorStaff, role: "donor_relations", siteId: site });
  const at = { organizationId: org, actor: actorOf(root), siteId: site };
  const rights = { uri: "http://rightsstatements.org/vocab/InC/1.0/" };
  const make = async (input: Record<string, unknown>) =>
    ok(await service.createRecord(at, input as never)).record;
  const donor = await make({
    kind: "agent",
    agentType: "family",
    title: SECRET.donor,
    templateKey: "t-agent",
    fields: {},
  });
  const fonds = await make({
    kind: "archival_unit",
    level: "fonds",
    title: "Invented photographs fonds",
    templateKey: "t-unit",
    fields: { rights },
  });
  const item = await make({
    kind: "archival_unit",
    level: "item",
    parentId: fonds.id,
    title: "Invented photograph of 1915",
    templateKey: "t-unit",
    fields: { rights },
  });
  const vase = await make({
    kind: "object",
    title: "Invented green vase",
    templateKey: "t-object",
    fields: { description: "A vase.", rights },
  });
  for (const r of [fonds, item, vase]) {
    ok(await service.publish(at, r.id, { expectedVersion: 1 }));
  }
  return { org, site, donor, fonds, item, vase, donorStaff, root };
}

const root = (w: World) => ({ organizationId: w.org, actor: actorOf(w.root), siteId: w.site });
const donors = (w: World) => ({ organizationId: w.org, actor: actorOf(w.donorStaff) });

function accessionInput(w: World, over: Record<string, unknown> = {}) {
  return {
    number: { type: "accession_number", value: `2026.${String(count).padStart(3, "0")}` },
    sourceAgent: { recordId: w.donor.id, label: SECRET.donor },
    receivedOn: "2026-03-14",
    method: "gift",
    materials: SECRET.materials,
    restrictions: SECRET.restrictions,
    note: SECRET.note,
    deedStatus: "missing",
    records: [{ recordId: w.fonds.id, label: "Fonds" }],
    ...over,
  };
}

async function stateOf(w: World, id: RecordId): Promise<string> {
  const [row] = await s.owner.rows<{ workflow_state: string }>(sql`
    SELECT workflow_state FROM public.records
    WHERE organization_id = ${w.org}::uuid AND id = ${id}::uuid`);
  return row?.workflow_state ?? "missing";
}

async function moves(w: World, id: RecordId) {
  return s.owner.rows<{ actor: string; action: string; reason: string | null }>(sql`
    SELECT actor, action, reason FROM public.record_versions
    WHERE organization_id = ${w.org}::uuid AND record_id = ${id}::uuid
      AND action IN ('publish', 'withdraw')
    ORDER BY version`);
}

async function isPublic(w: World, id: RecordId): Promise<boolean> {
  return (await readPublicRecord(s.reader, w.org, w.site, id, { baseUrl: BASE })).ok;
}

const pass = (w: World, apply = true) =>
  applyAccessHolds(s.writer, { apply, organizationId: w.org });

async function organizationDay(org: OrganizationId): Promise<string> {
  const [row] = await s.owner.rows<{ today: string }>(
    sql`SELECT public.organization_local_day(${org}::uuid) AS today`,
  );
  return row?.today ?? "";
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("the access-holds pass (T-034f)", () => {
  it("withdraws published records an unsigned deed holds back, and publishes them again once it's signed", async () => {
    await ready();
    const w = await world();
    const made = ok(await service.createAccession(donors(w), accessionInput(w)));
    // A dry run says what it would do and changes nothing.
    const dry = await pass(w, false);
    expect(dry).toMatchObject({ dryRun: true, withdrawn: 2, published: 0, failed: 0 });
    expect(await stateOf(w, w.fonds.id)).toBe("published");

    const first = await pass(w);
    expect(first).toMatchObject({ dryRun: false, withdrawn: 2, published: 0, failed: 0 });
    expect(await stateOf(w, w.fonds.id)).toBe("withdrawn");
    expect(await stateOf(w, w.item.id)).toBe("withdrawn");
    expect(await stateOf(w, w.vase.id)).toBe("published");
    expect((await moves(w, w.item.id)).at(-1)).toEqual({
      actor: ACCESS_HOLDS_ACTOR,
      action: "withdraw",
      reason: HOLD_WITHDRAW_REASON,
    });
    // Nothing of the accession is in the change log.
    const log = JSON.stringify(await moves(w, w.item.id));
    for (const secret of Object.values(SECRET)) expect(log).not.toContain(secret);
    expect(log).not.toContain("2026.");

    // Run again: nothing more to do, and it stays withdrawn while held.
    expect(await pass(w)).toMatchObject({ withdrawn: 0, published: 0, stillHeld: 2 });

    ok(
      await service.updateAccession(
        donors(w),
        made.accession.id,
        accessionInput(w, { deedStatus: "signed" }),
        { expectedVersion: 1 },
      ),
    );
    expect(await pass(w, false)).toMatchObject({ dryRun: true, published: 2 });
    expect(await stateOf(w, w.item.id)).toBe("withdrawn");
    expect(await pass(w)).toMatchObject({ withdrawn: 0, published: 2, stillHeld: 0 });
    expect(await stateOf(w, w.fonds.id)).toBe("published");
    expect(await stateOf(w, w.item.id)).toBe("published");
    expect((await moves(w, w.item.id)).at(-1)).toEqual({
      actor: ACCESS_HOLDS_ACTOR,
      action: "publish",
      reason: HOLD_PUBLISH_REASON,
    });
    expect(await isPublic(w, w.item.id)).toBe(true);
    // And nothing left to do.
    expect(await pass(w)).toMatchObject({ withdrawn: 0, published: 0, stillHeld: 0 });
  });

  it("ends an access restriction on the organization's own day, not before", async () => {
    await ready();
    const w = await world();
    // Always ahead of UTC (UTC+14): its day is the UTC day or the next.
    ok(
      await service.changeOrganizationTimeZone(
        { organizationId: w.org, actor: actorOf(w.root) },
        "Pacific/Kiritimati",
      ),
    );
    const today = await organizationDay(w.org);
    const restricted = (until: string) =>
      accessionInput(w, {
        deedStatus: "signed",
        records: [{ recordId: w.vase.id, label: "Vase" }],
        accessRestriction: { kind: "closed_until", until },
      });
    const made = ok(await service.createAccession(donors(w), restricted(nextDay(today))));
    expect(await pass(w)).toMatchObject({ withdrawn: 1 });
    expect(await stateOf(w, w.vase.id)).toBe("withdrawn");
    expect(await isPublic(w, w.vase.id)).toBe(false);

    // Ends today, on the organization's day: published again.
    ok(
      await service.updateAccession(donors(w), made.accession.id, restricted(today), {
        expectedVersion: 1,
      }),
    );
    expect(await pass(w)).toMatchObject({ published: 1, withdrawn: 0 });
    expect(await stateOf(w, w.vase.id)).toBe("published");
    expect(await isPublic(w, w.vase.id)).toBe(true);
  });

  it("never undoes a person's own decision", async () => {
    await ready();
    const w = await world();
    const made = ok(await service.createAccession(donors(w), accessionInput(w)));
    // A person withdrew the item themselves before the pass ran.
    const item = ok(await service.readRecord(root(w), w.item.id));
    ok(await service.withdraw(root(w), w.item.id, { expectedVersion: item.version }));
    expect(await pass(w)).toMatchObject({ withdrawn: 1 });
    // A person sends the pass's withdrawn fonds back for review.
    const fonds = ok(await service.readRecord(root(w), w.fonds.id));
    ok(await service.submitForReview(root(w), w.fonds.id, { expectedVersion: fonds.version }));
    ok(
      await service.updateAccession(
        donors(w),
        made.accession.id,
        accessionInput(w, { deedStatus: "signed" }),
        { expectedVersion: 1 },
      ),
    );
    expect(await pass(w)).toMatchObject({ published: 0, withdrawn: 0 });
    expect(await stateOf(w, w.item.id)).toBe("withdrawn");
    expect(await stateOf(w, w.fonds.id)).toBe("ready_for_review");
  });

  it("leaves a record withdrawn when the publish check refuses it for another reason", async () => {
    await ready();
    const w = await world();
    const made = ok(
      await service.createAccession(
        donors(w),
        accessionInput(w, { records: [{ recordId: w.vase.id, label: "Vase" }] }),
      ),
    );
    expect(await pass(w)).toMatchObject({ withdrawn: 1 });
    // While withdrawn, someone takes its rights statement away.
    const vase = ok(await service.readRecord(root(w), w.vase.id));
    ok(
      await service.updateRecord(
        root(w),
        w.vase.id,
        { ...vase.record, fields: { description: "A vase." } },
        { expectedVersion: vase.version },
      ),
    );
    ok(
      await service.updateAccession(
        donors(w),
        made.accession.id,
        accessionInput(w, {
          deedStatus: "signed",
          records: [{ recordId: w.vase.id, label: "Vase" }],
        }),
        { expectedVersion: 1 },
      ),
    );
    expect(await pass(w)).toMatchObject({ published: 0, blocked: 1, failed: 0 });
    expect(await stateOf(w, w.vase.id)).toBe("withdrawn");
    expect(await isPublic(w, w.vase.id)).toBe(false);
  });

  it("touches only the organization it is given, and every one without", async () => {
    await ready();
    const a = await world();
    const b = await world();
    ok(await service.createAccession(donors(a), accessionInput(a)));
    ok(await service.createAccession(donors(b), accessionInput(b)));
    expect(await pass(a)).toMatchObject({ withdrawn: 2 });
    expect(await stateOf(b, b.fonds.id)).toBe("published");
    const all = await applyAccessHolds(s.writer, { apply: true });
    expect(all.withdrawn).toBeGreaterThanOrEqual(2);
    expect(await stateOf(b, b.fonds.id)).toBe("withdrawn");
  });

  it("says there were more than one pass takes", async () => {
    await ready();
    const w = await world();
    ok(await service.createAccession(donors(w), accessionInput(w)));
    const capped = await applyAccessHolds(s.writer, {
      apply: true,
      organizationId: w.org,
      limit: 1,
    });
    expect(capped).toMatchObject({ withdrawn: 1, more: true });
    expect(await pass(w)).toMatchObject({ withdrawn: 1, more: false });
  });
});
