// Accessions and donor contacts through the service (T-018c, D-114), over
// a fresh database as the writer role, with the public reader for public
// output: only Donor relations (and managers) read or change them, another
// organization's answer like missing ones, numbers are unique, edits name
// their version, a record an accession names can't be deleted, and above
// all a deed that isn't signed (or a restriction in force) holds the
// records back from the publish check and the public output at once, while
// nothing of an accession ever reaches public output. Every person, record
// and number here is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type Issue,
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
  lockAccessionHolds,
  migrate,
  openDatabase,
  readAuditTrail,
  publishCheckIssues,
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
import { createService, type RecordService, type ServiceResult } from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

const BASE = "https://archive.example.org/records/";
const SECRET = {
  donor: "Invented Quarrington Family",
  materials: "Invented: three boxes of letters from the Bayou Street house",
  note: "Invented note: the donor's grandson is to be called first",
  restrictions: "Invented: no photographs of the letters to be shown",
  email: "quarrington@example.org",
};
const leaks = (value: unknown) =>
  Object.values(SECRET).filter((x) => JSON.stringify(value).includes(x));

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
    const roles = [`oculus_t018c_writer_${suffix}`, `oculus_t018c_reader_${suffix}`];
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

// Warm the setup before the first test, under the suite's longer hook limit
// (U-008). A failure stays in `setup`, so with no database each test still
// fails on its own when it calls ready().
beforeAll(() => ready().catch(() => undefined));

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

function codes(result: { ok: boolean; issues?: readonly Issue[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((i) => i.code);
}

interface World {
  org: OrganizationId;
  site: SiteId;
  donor: CatalogRecord;
  fonds: CatalogRecord;
  item: CatalogRecord;
  vase: CatalogRecord;
  donorStaff: UserId;
  cataloger: UserId;
  root: UserId;
}

let count = 0;
async function world(): Promise<World> {
  count += 1;
  const tag = String(count);
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: `Invented Society ${tag}` }));
  const field = (key: string, visibility: "public" | "staff", kind = "text") => ({
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility,
    inherited: false,
  });
  for (const [key, appliesTo] of [
    ["t-object", ["object"]],
    ["t-unit", ["archival_unit"]],
    ["t-agent", ["agent"]],
    ["t-asset", ["digital_asset"]],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [...appliesTo],
        fields: [field("description", "public"), field("rights", "public", "rights")],
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
  const person = async (name: string, role: string) => {
    const userId = await folks.member(org, `${name}-${tag}`);
    await grant(service, root, org, { userId, role, siteId: site });
    return userId;
  };
  const donorStaff = await person("donors", "donor_relations");
  const cataloger = await person("cataloger", "cataloger");
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
    title: "Invented letters fonds",
    templateKey: "t-unit",
    fields: { rights },
  });
  const item = await make({
    kind: "archival_unit",
    level: "item",
    parentId: fonds.id,
    title: "Invented letter of 1909",
    templateKey: "t-unit",
    fields: { rights },
  });
  const vase = await make({
    kind: "object",
    title: "Invented blue vase",
    templateKey: "t-object",
    fields: { description: "A vase.", rights },
  });
  for (const r of [fonds, item, vase]) {
    ok(await service.publish(at, r.id, { expectedVersion: 1 }));
  }
  return { org, site, donor, fonds, item, vase, donorStaff, cataloger, root };
}

const ctx = (w: World, who: UserId) => ({ organizationId: w.org, actor: actorOf(who) });

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

async function publicOf(w: World, id: RecordId) {
  return readPublicRecord(s.reader, w.org, w.site, id, { baseUrl: BASE });
}

describe("accessions through the service (T-018c)", () => {
  it("are read and changed by Donor relations only, never by a cataloger", async () => {
    await ready();
    const w = await world();
    const refused = await service.createAccession(ctx(w, w.cataloger), accessionInput(w));
    expect(codes(refused)).toEqual(["not_permitted"]);
    const made = ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    expect(made.version).toBe(1);
    expect(made.accession.organizationId).toBe(w.org);
    expect(codes(await service.readAccession(ctx(w, w.cataloger), made.accession.id))).toEqual([
      "not_permitted",
    ]);
    expect(codes(await service.listAccessions(ctx(w, w.cataloger)))).toEqual(["not_permitted"]);
    const read = ok(await service.readAccession(ctx(w, w.donorStaff), made.accession.id));
    expect(read.accession.materials).toBe(SECRET.materials);
    const list = ok(await service.listAccessions(ctx(w, w.donorStaff)));
    expect(list.accessions.map((a) => a.accession.id)).toEqual([made.accession.id]);
  });

  it("answers another organization's accession like a missing one", async () => {
    await ready();
    const a = await world();
    const b = await world();
    const made = ok(await service.createAccession(ctx(a, a.donorStaff), accessionInput(a)));
    const theirs = await service.readAccession(ctx(b, b.donorStaff), made.accession.id);
    const missing = await service.readAccession(ctx(b, b.donorStaff), newRecordId());
    expect(codes(theirs)).toEqual(["unknown_accession"]);
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(missing));
    // Nor can it name another organization's records.
    const across = await service.createAccession(
      ctx(b, b.donorStaff),
      accessionInput(b, { records: [{ recordId: a.vase.id, label: "Vase" }] }),
    );
    expect(across.ok).toBe(false);
    expect(leaks(across)).toEqual([]);
  });

  it("keeps numbers unique and edits to the version they were made from", async () => {
    await ready();
    const w = await world();
    const first = ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    const again = await service.createAccession(
      ctx(w, w.donorStaff),
      accessionInput(w, { records: [{ recordId: w.vase.id, label: "Vase" }] }),
    );
    expect(codes(again)).toEqual(["duplicate_number"]);
    const edit = { ...accessionInput(w), deedStatus: "signed", deedSignedOn: "2026-04-01" };
    const saved = ok(
      await service.updateAccession(ctx(w, w.donorStaff), first.accession.id, edit, {
        expectedVersion: 1,
      }),
    );
    expect(saved.version).toBe(2);
    const stale = await service.updateAccession(ctx(w, w.donorStaff), first.accession.id, edit, {
      expectedVersion: 1,
    });
    expect(codes(stale)).toEqual(["version_conflict"]);
    // The history keeps both versions, with who saved them.
    const [history] = await s.owner.rows<{ n: number; who: string }>(sql`
      SELECT count(*)::int AS n, min(saved_by::text) AS who FROM public.accession_versions
      WHERE organization_id = ${w.org}::uuid AND accession_id = ${first.accession.id}::uuid`);
    expect(history).toEqual({ n: 2, who: w.donorStaff });
  });

  it("shows accession saves, by number only, to whole-organization viewers (S-064)", async () => {
    await ready();
    const w = await world();
    const input = accessionInput(w);
    const first = ok(await service.createAccession(ctx(w, w.donorStaff), input));
    ok(
      await service.updateAccession(
        ctx(w, w.donorStaff),
        first.accession.id,
        { ...input, deedStatus: "signed", deedSignedOn: "2026-04-01" },
        { expectedVersion: 1 },
      ),
    );
    const lines = async (records: "all" | SiteId[], accessions = true) =>
      (
        await readAuditTrail(s.owner, w.org, { records, people: "all", accessions }, { limit: 100 })
      ).entries.filter((e) => e.type === "accession");
    expect(await lines("all")).toEqual([
      expect.objectContaining({
        actor: actorOf(w.donorStaff),
        accessionId: first.accession.id,
        version: 2,
        number: input.number.value,
      }),
      expect.objectContaining({ version: 1, number: input.number.value }),
    ]);
    expect(JSON.stringify(await lines("all"))).not.toContain(w.donor.title);
    // Only with donors.view on every site (D-036): the service gives a
    // cataloger none, a system manager both.
    expect(await lines("all", false)).toEqual([]);
    const cataloger = await service.auditTrail(ctx(w, w.cataloger), {});
    if (!cataloger.ok) throw new Error("no trail");
    expect(cataloger.value.entries.some((e) => e.type === "accession")).toBe(false);
    const root = await service.auditTrail(ctx(w, w.root), {});
    if (!root.ok) throw new Error("no trail");
    expect(root.value.entries.some((e) => e.type === "accession")).toBe(true);
  });

  it("never gives an all-time number to a second accession, even after the first gave it up", async () => {
    await ready();
    const w = await world();
    const first = ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    ok(
      await service.updateAccession(
        ctx(w, w.donorStaff),
        first.accession.id,
        accessionInput(w, { number: { type: "accession_number", value: "2026.900" } }),
        { expectedVersion: 1 },
      ),
    );
    const reuse = await service.createAccession(
      ctx(w, w.donorStaff),
      accessionInput(w, { records: [{ recordId: w.vase.id, label: "Vase" }] }),
    );
    expect(codes(reuse)).toEqual(["duplicate_number"]);
    // The accession that had it may take it back.
    ok(
      await service.updateAccession(ctx(w, w.donorStaff), first.accession.id, accessionInput(w), {
        expectedVersion: 2,
      }),
    );
  });

  it("names only records of sites where the person works with donors", async () => {
    await ready();
    const w = await world();
    const other = await makeSite(service, w.root, w.org, `Invented other site ${String(count)}`);
    const elsewhere = ok(
      await service.createRecord(
        { organizationId: w.org, actor: actorOf(w.root), siteId: other },
        { kind: "object", title: "Invented elsewhere jar", templateKey: "t-object", fields: {} },
      ),
    ).record;
    const refused = await service.createAccession(
      ctx(w, w.donorStaff),
      accessionInput(w, { records: [{ recordId: elsewhere.id, label: "Jar" }] }),
    );
    expect(codes(refused)).toEqual(["not_permitted"]);
    // A system manager may.
    ok(
      await service.createAccession(
        ctx(w, w.root),
        accessionInput(w, { records: [{ recordId: elsewhere.id, label: "Jar" }] }),
      ),
    );
  });

  it("names nothing whose hold would reach another site's records", async () => {
    await ready();
    const w = await world();
    const other = await makeSite(service, w.root, w.org, `Invented far site ${String(count)}`);
    // A scan on the other site of the vase (this site): holding the vase holds it too.
    const scan = ok(
      await service.createRecord(
        { organizationId: w.org, actor: actorOf(w.root), siteId: other },
        {
          kind: "digital_asset",
          title: "Invented scan of the vase",
          mediaType: "image/jpeg",
          represents: w.vase.id,
          templateKey: "t-asset",
          fields: {},
        },
      ),
    );
    expect(scan.record.id).toBeDefined();
    const refused = await service.createAccession(
      ctx(w, w.donorStaff),
      accessionInput(w, { records: [{ recordId: w.vase.id, label: "Vase" }] }),
    );
    expect(codes(refused)).toEqual(["not_permitted"]);
  });

  it("waits for a publish check in flight, so the two never pass each other", async () => {
    await ready();
    const w = await world();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A publish check holding the holds lock shared until it commits; the
    // save starts only once it holds it (under load, the save could
    // otherwise take the lock first).
    const publishing = s.owner.transaction(async (q) => {
      await lockAccessionHolds(q, w.org, "shared");
      locked();
      await held;
    });
    await holding;
    let saved = false;
    const saving = service.createAccession(ctx(w, w.donorStaff), accessionInput(w)).then((r) => {
      saved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(saved).toBe(false);
    release();
    await publishing;
    expect((await saving).ok).toBe(true);
  });

  it("refuses an input with an ID, an organization or a key it doesn't take", async () => {
    await ready();
    const w = await world();
    for (const extra of [{ id: newRecordId() }, { organizationId: w.org }, { secret: 1 }]) {
      const r = await service.createAccession(ctx(w, w.donorStaff), {
        ...accessionInput(w),
        ...extra,
      });
      expect(codes(r)).toEqual(["invalid_request"]);
    }
    // A gift can't do without a deed.
    const gift = await service.createAccession(
      ctx(w, w.donorStaff),
      accessionInput(w, { deedStatus: "not_needed" }),
    );
    expect(gift.ok).toBe(false);
    expect(leaks(gift)).toEqual([]);
  });

  it("holds records back while the deed isn't signed, in the publish check and the public output", async () => {
    await ready();
    const w = await world();
    expect((await publicOf(w, w.item.id)).ok).toBe(true);
    const made = ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    // What it now holds back among the published: the fonds and the item below it.
    expect([...made.nowHeld].sort()).toEqual([w.fonds.id, w.item.id].sort());
    const check = await s.owner.transaction((q) => publishCheckIssues(q, w.org, w.item.id));
    expect(check.map((i) => i.code)).toContain("deed_not_signed");
    expect(leaks(check)).toEqual([]);
    const out = await publicOf(w, w.item.id);
    expect(out.ok).toBe(false);
    expect(leaks(out)).toEqual([]);
    // The vase, which the accession didn't bring in, is still public.
    expect((await publicOf(w, w.vase.id)).ok).toBe(true);
    // Signed: public again, and nothing held.
    const signed = ok(
      await service.updateAccession(
        ctx(w, w.donorStaff),
        made.accession.id,
        { ...accessionInput(w), deedStatus: "signed" },
        { expectedVersion: 1 },
      ),
    );
    expect(signed.nowHeld).toEqual([]);
    const back = await publicOf(w, w.item.id);
    expect(back.ok).toBe(true);
    expect(leaks(back)).toEqual([]);
  });

  it("holds records back while an access restriction is in force", async () => {
    await ready();
    const w = await world();
    const made = ok(
      await service.createAccession(
        ctx(w, w.donorStaff),
        accessionInput(w, {
          deedStatus: "signed",
          records: [{ recordId: w.vase.id, label: "Vase" }],
          accessRestriction: { kind: "closed_until", until: "2099-01-01" },
        }),
      ),
    );
    expect(made.nowHeld).toEqual([w.vase.id]);
    const out = await publicOf(w, w.vase.id);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("2099");
    ok(
      await service.updateAccession(
        ctx(w, w.donorStaff),
        made.accession.id,
        accessionInput(w, {
          deedStatus: "signed",
          records: [{ recordId: w.vase.id, label: "Vase" }],
          accessRestriction: { kind: "closed_until", until: "2001-01-01" },
        }),
        { expectedVersion: 1 },
      ),
    );
    expect((await publicOf(w, w.vase.id)).ok).toBe(true);
  });

  it("won't delete a record an accession names, nor its source", async () => {
    await ready();
    const w = await world();
    ok(
      await service.createAccession(
        ctx(w, w.donorStaff),
        accessionInput(w, {
          deedStatus: "signed",
          records: [{ recordId: w.vase.id, label: "Vase" }],
        }),
      ),
    );
    const at = { organizationId: w.org, actor: actorOf(w.root), siteId: w.site };
    ok(await service.withdraw(at, w.vase.id, { expectedVersion: 2 }));
    const gone = await service.deleteRecord(at, w.vase.id, { expectedVersion: 3 });
    expect(codes(gone)).toContain("in_accession");
    const source = await service.deleteRecord(at, w.donor.id, { expectedVersion: 1 });
    expect(codes(source)).toContain("accession_source");
    expect(leaks([gone, source])).toEqual([]);
  });

  it("keeps the public reader away from accessions and contacts", async () => {
    await ready();
    const w = await world();
    ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    for (const table of [
      "accessions",
      "accession_records",
      "accession_versions",
      "donor_contacts",
    ]) {
      await expect(
        s.reader.rows(sql`SELECT count(*) FROM public.${sqlIdent(table)}`),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      s.reader.rows(
        sql`SELECT public.accession_holds_of(${w.org}::uuid, ARRAY[${w.fonds.id}]::uuid[])`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("the database's own guards (T-018c, migration 0046)", () => {
  it("keeps identity and versions, and the produced-records list, out of the writer's hands", async () => {
    await ready();
    const w = await world();
    const made = ok(await service.createAccession(ctx(w, w.donorStaff), accessionInput(w)));
    const id = made.accession.id;
    // A version that skips, or an identity change: refused.
    await expect(
      s.writer.execute(sql`UPDATE public.accessions SET version = version + 2
        WHERE organization_id = ${w.org}::uuid AND id = ${id}::uuid`),
    ).rejects.toMatchObject({ code: "OC083" });
    await expect(
      s.writer.execute(sql`UPDATE public.accessions SET version = version + 1,
          created_by = ${w.cataloger}::uuid
        WHERE organization_id = ${w.org}::uuid AND id = ${id}::uuid`),
    ).rejects.toMatchObject({ code: "OC082" });
    // The produced records follow the definition only; the writer can't write them.
    await expect(
      s.writer.execute(sql`INSERT INTO public.accession_records VALUES
        (${w.org}::uuid, ${id}::uuid, ${w.vase.id}::uuid)`),
    ).rejects.toThrow(/permission denied/);
    await expect(s.writer.execute(sql`DELETE FROM public.accession_versions`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      s.writer.execute(sql`DELETE FROM public.accessions WHERE organization_id = ${w.org}::uuid`),
    ).rejects.toThrow(/permission denied/);
    const rows = await s.owner.rows<{ record_id: string }>(sql`
      SELECT record_id::text FROM public.accession_records WHERE accession_id = ${id}::uuid`);
    expect(rows.map((r) => r.record_id)).toEqual([w.fonds.id]);
  });
});

describe("donor contacts through the service (T-018c)", () => {
  it("are saved, read, changed and deleted by Donor relations only", async () => {
    await ready();
    const w = await world();
    const input = { email: SECRET.email, phone: "409-555-0100" };
    expect(
      codes(
        await service.saveDonorContact(ctx(w, w.cataloger), w.donor.id, input, {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["not_permitted"]);
    const saved = ok(
      await service.saveDonorContact(ctx(w, w.donorStaff), w.donor.id, input, {
        expectedVersion: 0,
      }),
    );
    expect(saved.version).toBe(1);
    expect(
      codes(
        await service.saveDonorContact(ctx(w, w.donorStaff), w.donor.id, input, {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["version_conflict"]);
    expect(codes(await service.readDonorContact(ctx(w, w.cataloger), w.donor.id))).toEqual([
      "not_permitted",
    ]);
    expect(ok(await service.readDonorContact(ctx(w, w.donorStaff), w.donor.id)).contact.email).toBe(
      SECRET.email,
    );
    // Only an agent has contact details.
    expect(
      codes(
        await service.saveDonorContact(ctx(w, w.donorStaff), w.vase.id, input, {
          expectedVersion: 0,
        }),
      ),
    ).toEqual(["unknown_agent"]);
    ok(await service.deleteDonorContact(ctx(w, w.donorStaff), w.donor.id, { expectedVersion: 1 }));
    expect(codes(await service.readDonorContact(ctx(w, w.donorStaff), w.donor.id))).toEqual([
      "unknown_contact",
    ]);
  });

  it("are deleted only by someone who works with donors on the agent's own site (S-058)", async () => {
    await ready();
    const w = await world();
    const other = await makeSite(service, w.root, w.org, `Invented contact site ${String(count)}`);
    const agent = ok(
      await service.createRecord(
        { organizationId: w.org, actor: actorOf(w.root), siteId: other },
        {
          kind: "agent",
          agentType: "person",
          title: "Invented Other-Site Donor",
          templateKey: "t-agent",
          fields: {},
        },
      ),
    ).record;
    const input = { email: "other-site-donor@example.invalid" };
    ok(await service.saveDonorContact(ctx(w, w.root), agent.id, input, { expectedVersion: 0 }));
    // Donor relations on the first site only: saving is refused there, and so is deleting.
    expect(
      codes(
        await service.saveDonorContact(ctx(w, w.donorStaff), agent.id, input, {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["not_permitted"]);
    expect(
      codes(
        await service.deleteDonorContact(ctx(w, w.donorStaff), agent.id, { expectedVersion: 1 }),
      ),
    ).toEqual(["not_permitted"]);
    // A wrong version doesn't get past the check either.
    expect(
      codes(
        await service.deleteDonorContact(ctx(w, w.donorStaff), agent.id, { expectedVersion: 9 }),
      ),
    ).toEqual(["not_permitted"]);
    // The contact is still there.
    expect(ok(await service.readDonorContact(ctx(w, w.root), agent.id)).contact.email).toBe(
      input.email,
    );
    // Someone who works with donors on that site may delete it.
    await grant(service, w.root, w.org, {
      userId: w.donorStaff,
      role: "donor_relations",
      siteId: other,
    });
    ok(await service.deleteDonorContact(ctx(w, w.donorStaff), agent.id, { expectedVersion: 1 }));
    expect(codes(await service.readDonorContact(ctx(w, w.root), agent.id))).toEqual([
      "unknown_contact",
    ]);
    // An ID that isn't one, or names no contact, is answered as a missing contact.
    expect(
      codes(
        await service.deleteDonorContact(ctx(w, w.donorStaff), "not-an-id", {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["unknown_contact"]);
  });
});

/** A fixed table name for the reader test (from this file's own list only). */
function sqlIdent(table: string) {
  switch (table) {
    case "accessions":
      return sql`accessions`;
    case "accession_records":
      return sql`accession_records`;
    case "accession_versions":
      return sql`accession_versions`;
    default:
      return sql`donor_contacts`;
  }
}
