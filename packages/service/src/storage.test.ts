// Storage levels, locations and moves through the service (T-018d, D-115),
// over a fresh database as the writer role: who may read and change them,
// core's whole-storage checks on every save, the move log written down at
// the database's time and never changed, a record that has moved can't be
// deleted, and the public reader can read none of it. Every person, place
// and record here is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  grantPublicReaderRole,
  grantWriterRole,
  insertOrganization,
  insertTemplateVersion,
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
import { createService, type RecordService, type ServiceResult } from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

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
    const roles = [`oculus_t018d_writer_${suffix}`, `oculus_t018d_reader_${suffix}`];
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
  vase: CatalogRecord;
  conservator: CatalogRecord;
  cataloger: UserId;
  reader: UserId;
  root: UserId;
}

let count = 0;
async function world(): Promise<World> {
  count += 1;
  const tag = String(count);
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: `Invented Museum ${tag}` }));
  for (const [key, appliesTo] of [
    ["t-object", ["object"]],
    ["t-agent", ["agent"]],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [...appliesTo],
        fields: [
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
  }
  const root = folks.root;
  const site = await makeSite(service, root, org, `Invented site ${tag}`);
  const person = async (name: string, role: string) => {
    const userId = await folks.member(org, `${name}-${tag}`);
    await grant(service, root, org, { userId, role, siteId: site });
    return userId;
  };
  const cataloger = await person("cataloger", "cataloger");
  const reader = await person("reader", "read_only");
  const at = { organizationId: org, actor: actorOf(root), siteId: site };
  const vase = ok(
    await service.createRecord(at, {
      kind: "object",
      title: "Invented blue vase",
      templateKey: "t-object",
      fields: {},
    }),
  ).record;
  const conservator = ok(
    await service.createRecord(at, {
      kind: "agent",
      agentType: "organization",
      title: "Invented Paper Conservation Studio",
      templateKey: "t-agent",
      fields: {},
    }),
  ).record;
  return { org, site, vase, conservator, cataloger, reader, root };
}

const ctx = (w: World, who: UserId) => ({ organizationId: w.org, actor: actorOf(who) });

async function room(w: World, name = "Invented Room 1") {
  return ok(
    await service.saveStorageLocation(
      ctx(w, w.cataloger),
      null,
      { kind: "storage", name, level: 0 },
      { expectedVersion: 0 },
    ),
  ).location;
}

describe("storage through the service (T-018d)", () => {
  it("lets a cataloger make locations and a reader see them, not change them", async () => {
    await ready();
    const w = await world();
    const r = await room(w);
    expect(
      codes(
        await service.saveStorageLocation(
          ctx(w, w.reader),
          null,
          { kind: "storage", name: "Invented Room 2", level: 0 },
          { expectedVersion: 0 },
        ),
      ),
    ).toEqual(["not_permitted"]);
    const seen = ok(await service.readStorage(ctx(w, w.reader)));
    expect(seen.locations.map((l) => l.location.id)).toEqual([r.id]);
    expect(seen.levelsVersion).toBe(0);
    // A rename names the version it was made from.
    const renamed = ok(
      await service.saveStorageLocation(
        ctx(w, w.cataloger),
        r.id,
        { kind: "storage", name: "Invented Store Room", level: 0 },
        { expectedVersion: 1 },
      ),
    );
    expect(renamed.version).toBe(2);
    expect(
      codes(
        await service.saveStorageLocation(
          ctx(w, w.cataloger),
          r.id,
          { kind: "storage", name: "Invented again", level: 0 },
          { expectedVersion: 1 },
        ),
      ),
    ).toEqual(["version_conflict"]);
  });

  it("keeps the levels system managers'", async () => {
    await ready();
    const w = await world();
    const levels = { levels: ["Building", "Room", "Shelf", "Box"] };
    expect(
      codes(await service.saveStorageLevels(ctx(w, w.cataloger), levels, { expectedVersion: 0 })),
    ).toEqual(["not_permitted"]);
    const saved = ok(
      await service.saveStorageLevels(ctx(w, w.root), levels, { expectedVersion: 0 }),
    );
    expect(saved.version).toBe(1);
    expect(ok(await service.readStorage(ctx(w, w.reader))).levels.levels).toEqual(levels.levels);
  });

  it("records moves, works out where a record is, and lists what is overdue", async () => {
    await ready();
    const w = await world();
    const r = await room(w);
    const studio = ok(
      await service.saveStorageLocation(
        ctx(w, w.cataloger),
        null,
        { kind: "external", name: "Invented studio", agentId: w.conservator.id },
        { expectedVersion: 0 },
      ),
    ).location;
    // A return before the record was ever placed: core refuses it.
    const early = await service.recordMove(ctx(w, w.cataloger), {
      recordId: w.vase.id,
      locationId: r.id,
      movedOn: "2026-01-02",
      reason: "return",
    });
    expect(early.ok).toBe(false);
    ok(
      await service.recordMove(ctx(w, w.cataloger), {
        recordId: w.vase.id,
        locationId: r.id,
        movedOn: "2026-01-02",
        reason: "placement",
      }),
    );
    const out = ok(
      await service.recordMove(ctx(w, w.cataloger), {
        recordId: w.vase.id,
        locationId: studio.id,
        movedOn: "2026-02-01",
        reason: "conservation",
        expectedReturnOn: "2026-03-01",
      }),
    );
    expect(out.recordedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const where = ok(await service.recordStorage(ctx(w, w.reader), w.vase.id));
    expect(where.whereabouts?.current.id).toBe(studio.id);
    expect(where.whereabouts?.away).toBe(true);
    expect(where.history).toHaveLength(2);
    const late = ok(await service.overdueReturns(ctx(w, w.reader)));
    expect(late.map((x) => x.recordId)).toEqual([w.vase.id]);
    // A reader can't move it.
    expect(
      codes(
        await service.recordMove(ctx(w, w.reader), {
          recordId: w.vase.id,
          locationId: r.id,
          movedOn: "2026-03-01",
          reason: "return",
        }),
      ),
    ).toEqual(["not_permitted"]);
  });

  it("answers another organization's record like a missing one", async () => {
    await ready();
    const a = await world();
    const b = await world();
    const r = await room(b);
    const theirs = await service.recordMove(ctx(b, b.cataloger), {
      recordId: a.vase.id,
      locationId: r.id,
      movedOn: "2026-01-02",
      reason: "placement",
    });
    const missing = await service.recordMove(ctx(b, b.cataloger), {
      recordId: newRecordId(),
      locationId: r.id,
      movedOn: "2026-01-02",
      reason: "placement",
    });
    expect(codes(theirs)).toEqual(["unknown_record"]);
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(missing));
    expect(codes(await service.recordStorage(ctx(b, b.reader), a.vase.id))).toEqual([
      "unknown_record",
    ]);
  });

  it("keeps moves as written, and records that moved", async () => {
    await ready();
    const w = await world();
    const r = await room(w);
    ok(
      await service.recordMove(ctx(w, w.cataloger), {
        recordId: w.vase.id,
        locationId: r.id,
        movedOn: "2026-01-02",
        reason: "placement",
      }),
    );
    await expect(
      s.writer.execute(sql`UPDATE public.storage_moves SET definition = definition
        WHERE organization_id = ${w.org}::uuid`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      s.writer.execute(
        sql`DELETE FROM public.storage_moves WHERE organization_id = ${w.org}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    const at = { organizationId: w.org, actor: actorOf(w.root), siteId: w.site };
    expect(codes(await service.deleteRecord(at, w.vase.id, { expectedVersion: 1 }))).toContain(
      "has_moves",
    );
    // The database checks a move's time itself.
    const id = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const move = (recordedAt: string | undefined) => ({
      id,
      organizationId: w.org,
      recordId: w.vase.id,
      locationId: r.id,
      movedOn: "2026-01-03",
      reason: "rehousing",
      ...(recordedAt === undefined ? {} : { recordedAt }),
    });
    for (const [recordedAt, at, code] of [
      ["2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", "OC085"],
      [undefined, "2026-01-01T00:00:00.000Z", "OC084"],
    ] as const) {
      await expect(
        s.writer.execute(sql`INSERT INTO public.storage_moves
          (organization_id, id, definition, recorded_by, recorded_at)
          VALUES (${w.org}::uuid, ${id}::uuid, ${JSON.stringify(move(recordedAt))}::jsonb,
                  ${w.cataloger}::uuid, ${at}::timestamptz)`),
      ).rejects.toMatchObject({ code });
    }
    for (const table of ["levels", "locations", "moves"]) {
      await expect(
        s.reader.rows(
          table === "levels"
            ? sql`SELECT 1 FROM public.storage_levels`
            : table === "locations"
              ? sql`SELECT 1 FROM public.storage_locations`
              : sql`SELECT 1 FROM public.storage_moves`,
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
