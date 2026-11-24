// Roles and collection-level permissions through the service (T-041,
// D-072): every built-in role against every operation, grants scoped to a
// unit's subtree, moves needing permission on both sides, other
// organizations and sites, role changes taking effect at once, revocations
// racing writes, the writer role's grants on the new tables, and the
// database's own guards. Every person, site and record here is invented.
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  newSiteId,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  WRITER_PRIVILEGES,
  checkWriterConnection,
  grantWriterRole,
  insertIdentifierType,
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
import { contextFromSession } from "./access.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");

interface Setup {
  testDb: TestDatabase;
  owner: Database;
  writer: Database;
  writer2: Database;
  roles: string[];
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;
let service2: RecordService;
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
    const roles = ["writer", "probe"].map((r) => `oculus_t041_${r}_${suffix}`);
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      for (const role of roles)
        await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", role));
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction((q) => grantWriterRole(q, roles[0] ?? ""));
    return {
      testDb,
      owner,
      writer: as(testDb.url, roles[0] ?? ""),
      writer2: as(testDb.url, roles[0] ?? ""),
      roles,
    };
  })();
  s = await setup;
  service = createService(s.writer, { now: () => NOW });
  service2 = createService(s.writer2, { now: () => NOW });
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
  for (const pool of [done.writer, done.writer2, done.owner]) await pool.close();
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

// ---------------------------------------------------------------------------

function ok<T>(result: Validated<T> | ServiceResult<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: { ok: boolean; issues?: readonly Issue[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((i) => i.code);
}

function text(result: unknown): string {
  return JSON.stringify(result);
}

const field = (key: string, kind: string) => ({
  key,
  label: key,
  kind,
  required: false,
  repeatable: false,
  visibility: "staff",
  inherited: false,
});

/** An organization with templates for objects, units and scans, and a number type. */
async function catalogOrganization(name: string): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name }));
  for (const [key, kind] of [
    ["t-object", "object"],
    ["t-unit", "archival_unit"],
    ["t-asset", "digital_asset"],
    ["t-agent", "agent"],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields: [
          field("note", "text"),
          // A link to an agent (T-041 review: links to records the actor can't view).
          ...(kind === "archival_unit"
            ? [{ ...field("related", "record_link"), recordKinds: ["agent"] }]
            : []),
        ],
      }),
    );
  }
  ok(
    await s.owner.transaction((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "object_number",
        label: "Object number",
        uniqueness: "all_time",
      }),
    ),
  );
  return org;
}

const objectDraft = (title = "An invented lantern") => ({
  kind: "object",
  title,
  templateKey: "t-object",
  fields: { note: "Tin." },
});
const unitDraft = (level: string, title: string, parentId?: RecordId) => ({
  kind: "archival_unit",
  level,
  title,
  templateKey: "t-unit",
  fields: {},
  ...(parentId === undefined ? {} : { parentId }),
});
const assetDraft = (represents: RecordId, title = "An invented scan") => ({
  kind: "digital_asset",
  mediaType: "image/tiff",
  represents,
  title,
  templateKey: "t-asset",
  fields: {},
});

const ctxOf = (organizationId: OrganizationId, userId: UserId) => ({
  organizationId,
  actor: actorOf(userId),
});

/** The world most tests share: organization A with two sites, B with one. */
interface World {
  a: OrganizationId;
  b: OrganizationId;
  a1: SiteId;
  a2: SiteId;
  b1: SiteId;
  /** F1 > S1 > X1 (with scan AX); F2 > S2; an object O. */
  f1: CatalogRecord;
  s1: CatalogRecord;
  x1: CatalogRecord;
  ax: CatalogRecord;
  f2: CatalogRecord;
  s2: CatalogRecord;
  o: CatalogRecord;
  /** One member of A per role on site A1, whole catalog; `none` has no role. */
  byRole: Record<(typeof ROLES)[number], UserId>;
  none: UserId;
  /** A member of B only (a cataloger there). */
  stranger: UserId;
}

const ROLES = [
  "site_manager",
  "cataloger",
  "reviewer",
  "read_only",
  "scanner",
  "donor_relations",
] as const;

let worldCount = 0;
async function world(): Promise<World> {
  worldCount += 1;
  const tag = String(worldCount);
  const a = await catalogOrganization(`Invented Archive ${tag}`);
  const b = await catalogOrganization(`Invented Library ${tag}`);
  const root = folks.root;
  const a1 = await makeSite(service, root, a, `Invented archive site ${tag}`);
  const a2 = await makeSite(service, root, a, `Invented second site ${tag}`);
  const b1 = await makeSite(service, root, b, `Invented library site ${tag}`);
  const rootCtx = ctxOf(a, root);
  const make = async (draft: unknown) => ok(await service.createRecord(rootCtx, draft)).record;
  const f1 = await make(unitDraft("fonds", "Invented Fonds One"));
  const s1 = await make(unitDraft("series", "Invented Series One", f1.id));
  const x1 = await make(unitDraft("file", "Invented File One", s1.id));
  const ax = await make(assetDraft(x1.id));
  const f2 = await make(unitDraft("fonds", "Invented Fonds Two"));
  const s2 = await make(unitDraft("series", "Invented Series Two", f2.id));
  const o = await make(objectDraft("Invented Hidden Lantern"));
  const byRole = {} as Record<(typeof ROLES)[number], UserId>;
  for (const role of ROLES) {
    const userId = await folks.member(a, `role-${role}-${tag}`);
    await grant(service, root, a, { userId, role, siteId: a1 });
    byRole[role] = userId;
  }
  const none = await folks.member(a, `none-${tag}`);
  const stranger = await folks.member(b, `stranger-${tag}`);
  await grant(service, root, b, { userId: stranger, role: "cataloger", siteId: b1 });
  return { a, b, a1, a2, b1, f1, s1, x1, ax, f2, s2, o, byRole, none, stranger };
}

/** A person of A with only these grants (on site A1). */
async function personWith(
  w: World,
  name: string,
  grants: { role: string; scope?: RecordId | null; siteId?: SiteId | null }[],
): Promise<UserId> {
  const userId = await folks.member(w.a, `${name}-${newRecordId().slice(0, 6)}`);
  for (const g of grants) {
    await grant(service, folks.root, w.a, {
      userId,
      role: g.role,
      siteId: g.siteId === undefined ? w.a1 : g.siteId,
      scope: g.scope ?? null,
    });
  }
  return userId;
}

/** Waits until at least `n` connections to the test database wait for a lock. */
async function waiting(n: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [row] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Fewer than ${String(n)} connections waited for a lock.`);
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

// ---------------------------------------------------------------------------

describe("every role against every operation", () => {
  it("allows exactly what each role's permissions say, and refuses the rest cleanly", async () => {
    await ready();
    const w = await world();
    const root = folks.root;
    // The expected answer for each operation, in this order of people:
    // site_manager, cataloger, reviewer, read_only, scanner, donor_relations,
    // system manager, member with no role. "ok" or the refusal's code.
    const people: [string, UserId][] = [
      ...ROLES.map((r): [string, UserId] => [r, w.byRole[r]]),
      ["system_manager", root],
      ["no_role", w.none],
    ];
    type Op = (
      who: UserId,
      ctx: { organizationId: OrganizationId; actor: string },
    ) => Promise<{ ok: boolean; issues?: readonly Issue[] }>;
    const NP = "not_permitted";
    const UR = "unknown_record";
    const fresh = async () =>
      ok(await service.createRecord(ctxOf(w.a, root), objectDraft("Invented fresh lantern")))
        .record;
    const ops: [string, Op, string[]][] = [
      [
        "readRecord",
        (_, c) => service.readRecord(c, w.o.id),
        ["ok", "ok", "ok", "ok", "ok", UR, "ok", NP],
      ],
      [
        "create object",
        (_, c) => service.createRecord(c, objectDraft()),
        ["ok", "ok", "ok", NP, NP, NP, "ok", NP],
      ],
      [
        "create unit",
        (_, c) => service.createRecord(c, unitDraft("file", "Invented new file", w.s1.id)),
        ["ok", "ok", "ok", NP, NP, "missing_parent", "ok", NP],
      ],
      [
        "create scan",
        (_, c) => service.createRecord(c, assetDraft(w.x1.id)),
        ["ok", "ok", "ok", NP, "ok", UR, "ok", NP],
      ],
      [
        "edit object",
        async (_, c) => {
          const r = await fresh();
          return service.updateRecord(c, r.id, { ...r, title: "Edited" }, { expectedVersion: 1 });
        },
        ["ok", "ok", "ok", NP, NP, UR, "ok", NP],
      ],
      [
        "edit scan",
        async (_, c) => {
          const r = ok(await service.createRecord(ctxOf(w.a, root), assetDraft(w.x1.id))).record;
          return service.updateRecord(
            c,
            r.id,
            { ...r, title: "Edited scan" },
            { expectedVersion: 1 },
          );
        },
        ["ok", "ok", "ok", NP, "ok", UR, "ok", NP],
      ],
      [
        "renumber",
        async (_, c) => {
          const r = await fresh();
          return service.saveIdentifiers(c, r.id, {
            current: [
              { type: "object_number", value: `INV-${newRecordId().slice(0, 6)}`, primary: true },
            ],
            former: [],
          });
        },
        ["ok", "ok", "ok", NP, NP, UR, "ok", NP],
      ],
      [
        "restore",
        async (_, c) => {
          const r = await fresh();
          ok(
            await service.updateRecord(
              ctxOf(w.a, root),
              r.id,
              { ...r, title: "Second" },
              {
                expectedVersion: 1,
              },
            ),
          );
          return service.restoreVersion(c, r.id, 1, { expectedVersion: 2 });
        },
        ["ok", "ok", "ok", NP, NP, UR, "ok", NP],
      ],
      [
        "delete",
        async (_, c) => {
          const r = await fresh();
          return service.deleteRecord(c, r.id, { expectedVersion: 1 });
        },
        ["ok", NP, NP, NP, NP, UR, "ok", NP],
      ],
      [
        "grant a role",
        async (_, c) => {
          const target = await folks.member(w.a, `target-${newRecordId().slice(0, 6)}`);
          return service.grantRole(c, {
            userId: target,
            role: "read_only",
            siteId: w.a1,
            scope: null,
          });
        },
        ["ok", NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "revoke a role",
        async (_, c) => {
          const target = await folks.member(w.a, `revokee-${newRecordId().slice(0, 6)}`);
          const id = await grant(service, root, w.a, {
            userId: target,
            role: "read_only",
            siteId: w.a1,
          });
          return service.revokeRole(c, id);
        },
        [
          "ok",
          "unknown_assignment",
          "unknown_assignment",
          "unknown_assignment",
          "unknown_assignment",
          "unknown_assignment",
          "ok",
          NP,
        ],
      ],
      [
        "list role assignments",
        (_, c) => service.listRoleAssignments(c),
        ["ok", NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "create a site",
        (_, c) => service.createSite(c, { name: "Invented extra site" }),
        [NP, NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "rename a site",
        (_, c) => service.renameSite(c, { siteId: w.a2, name: "Invented renamed site" }),
        [NP, NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "read System settings",
        (_, c) => service.readSystemSettings(c),
        [NP, NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "change System settings",
        async (_, c) => {
          const current = ok(await service.readSystemSettings(ctxOf(w.a, root)));
          return service.changeSystemSettings(
            c,
            { ...current.settings, sessionIdleMinutes: 120 },
            { expectedVersion: current.version },
          );
        },
        [NP, NP, NP, NP, NP, NP, "ok", NP],
      ],
      [
        "list my sites",
        (_, c) => service.listMySites(c),
        ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"],
      ],
      ["my access", (_, c) => service.myAccess(c), ["ok", "ok", "ok", "ok", "ok", "ok", "ok", NP]],
    ];
    const seen: Record<string, Record<string, string>> = {};
    for (const [name, op, expected] of ops) {
      seen[name] = {};
      for (const [i, [label, userId]] of people.entries()) {
        const result = await op(userId, ctxOf(w.a, userId));
        const got = result.ok ? "ok" : (codes(result)[0] ?? "?");
        seen[name][label] = got;
        expect({ name, label, got }).toEqual({ name, label, got: expected[i] });
        // No refusal names a record, a site or a person.
        if (!result.ok) {
          expect(text(result)).not.toMatch(/Invented|example\.org|@/);
        }
      }
    }
    expect(Object.keys(seen)).toHaveLength(ops.length);
  }, 120_000);

  it("a job (system: actor), a disabled account and an unknown person can do nothing", async () => {
    await ready();
    const w = await world();
    const cataloger = w.byRole.cataloger;
    for (const actor of ["system:import", `user:${newRecordId()}`]) {
      const c = { organizationId: w.a, actor };
      expect(codes(await service.readRecord(c, w.o.id))).toEqual(["not_permitted"]);
      expect(codes(await service.createRecord(c, objectDraft()))).toEqual(["not_permitted"]);
      // A job has no sites; an unknown person's list is empty.
      expect(codes(await service.listMySites(c))).toEqual(
        actor.startsWith("system:") ? ["not_permitted"] : [],
      );
    }
    ok(await service.createRecord(ctxOf(w.a, cataloger), objectDraft()));
    await s.owner.execute(
      sql`UPDATE public.users SET disabled_at = now() WHERE id = ${cataloger}::uuid`,
    );
    expect(codes(await service.createRecord(ctxOf(w.a, cataloger), objectDraft()))).toEqual([
      "not_permitted",
    ]);
    expect(ok(await service.listMySites(ctxOf(w.a, cataloger)))).toEqual([]);
  }, 60_000);
});

describe("collection-level permissions", () => {
  it("a grant on a fonds covers everything below it, scans included, and nothing else", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "scoped", [{ role: "cataloger", scope: w.f1.id }]);
    const c = ctxOf(w.a, p);
    for (const r of [w.f1, w.s1, w.x1, w.ax]) {
      expect(ok(await service.readRecord(c, r.id)).record.id).toBe(r.id);
    }
    // Two levels down, a scan of a file, and a new file under the series.
    ok(
      await service.updateRecord(
        c,
        w.x1.id,
        { ...w.x1, title: "Edited file" },
        { expectedVersion: 1 },
      ),
    );
    ok(
      await service.updateRecord(
        c,
        w.ax.id,
        { ...w.ax, title: "Edited scan" },
        { expectedVersion: 1 },
      ),
    );
    const made = ok(
      await service.createRecord(c, unitDraft("file", "Invented new file", w.s1.id)),
    ).record;
    ok(await service.createRecord(c, assetDraft(made.id)));
    // Outside: the other fonds and the object are as if they didn't exist.
    const nowhere = newRecordId();
    const unknown = await service.readRecord(c, nowhere);
    for (const r of [w.f2, w.s2, w.o]) {
      expect(await service.readRecord(c, r.id)).toEqual(unknown);
      const draft: Record<string, unknown> = { ...r };
      delete draft.id;
      expect(
        await service.updateRecord(c, r.id, { ...draft, title: "Mine" }, { expectedVersion: 1 }),
      ).toEqual(
        await service.updateRecord(c, nowhere, { ...draft, title: "Mine" }, { expectedVersion: 1 }),
      );
      expect(await service.deleteRecord(c, r.id, { expectedVersion: 1 })).toEqual(
        await service.deleteRecord(c, nowhere, { expectedVersion: 1 }),
      );
      expect(await service.restoreVersion(c, r.id, 1, { expectedVersion: 1 })).toEqual(
        await service.restoreVersion(c, nowhere, 1, { expectedVersion: 1 }),
      );
      expect(await service.saveIdentifiers(c, r.id, { current: [], former: [] })).toEqual(
        await service.saveIdentifiers(c, nowhere, { current: [], former: [] }),
      );
    }
    // Filing under, or scanning, a record outside: as if it didn't exist.
    const underHidden = await service.createRecord(c, unitDraft("file", "Invented", w.s2.id));
    expect(underHidden).toEqual(
      await service.createRecord(c, unitDraft("file", "Invented", nowhere)),
    );
    expect(codes(underHidden)).toEqual(["missing_parent"]);
    expect(await service.createRecord(c, assetDraft(w.o.id))).toEqual(
      await service.createRecord(c, assetDraft(nowhere)),
    );
    // What only a whole-catalog grant covers: objects and new fonds.
    expect(codes(await service.createRecord(c, objectDraft()))).toEqual(["not_permitted"]);
    expect(codes(await service.createRecord(c, unitDraft("fonds", "Invented")))).toEqual([
      "not_permitted",
    ]);
    expect(text(underHidden)).not.toMatch(/Invented Series Two|Invented Fonds Two/);
  }, 60_000);

  it("a grant follows the arrangement as it is now: units moved in are covered, moved out are not", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "follower", [{ role: "cataloger", scope: w.f1.id }]);
    const c = ctxOf(w.a, p);
    const rootCtx = ctxOf(w.a, folks.root);
    expect(codes(await service.readRecord(c, w.s2.id))).toEqual(["unknown_record"]);
    ok(
      await service.updateRecord(
        rootCtx,
        w.s2.id,
        { ...w.s2, parentId: w.f1.id },
        { expectedVersion: 1 },
      ),
    );
    ok(
      await service.updateRecord(
        c,
        w.s2.id,
        { ...w.s2, parentId: w.f1.id, title: "Mine now" },
        { expectedVersion: 2 },
      ),
    );
    const s1 = ok(await service.readRecord(rootCtx, w.s1.id));
    ok(
      await service.updateRecord(
        rootCtx,
        w.s1.id,
        { ...s1.record, parentId: w.f2.id },
        { expectedVersion: s1.version },
      ),
    );
    expect(codes(await service.readRecord(c, w.s1.id))).toEqual(["unknown_record"]);
    expect(codes(await service.readRecord(c, w.x1.id))).toEqual(["unknown_record"]);
    expect(codes(await service.readRecord(c, w.ax.id))).toEqual(["unknown_record"]);
  }, 60_000);

  it("moving a record between collections needs the permission on both", async () => {
    await ready();
    const w = await world();
    const both = await personWith(w, "both", [
      { role: "cataloger", scope: w.f1.id },
      { role: "cataloger", scope: w.f2.id },
    ]);
    const readsTwo = await personWith(w, "reads-two", [
      { role: "cataloger", scope: w.f1.id },
      { role: "read_only", scope: w.f2.id },
    ]);
    const onlyOne = await personWith(w, "only-one", [{ role: "cataloger", scope: w.f1.id }]);
    const onlyS1 = await personWith(w, "only-s1", [{ role: "cataloger", scope: w.s1.id }]);
    const move = (who: UserId, version: number) =>
      service.updateRecord(
        ctxOf(w.a, who),
        w.s1.id,
        { ...w.s1, parentId: w.f2.id },
        {
          expectedVersion: version,
        },
      );
    // Into a collection seen but not editable: not permitted.
    expect(codes(await move(readsTwo, 1))).toEqual(["not_permitted"]);
    // Into one not seen: as a parent that doesn't exist.
    const hidden = await move(onlyOne, 1);
    expect(codes(hidden)).toEqual(["missing_parent"]);
    expect(hidden).toEqual(
      await service.updateRecord(
        ctxOf(w.a, onlyOne),
        w.s1.id,
        { ...w.s1, parentId: newRecordId() },
        {
          expectedVersion: 1,
        },
      ),
    );
    // Out of a place it can't change (its grant is on the series itself).
    expect(codes(await move(onlyS1, 1))).toEqual(["not_permitted"]);
    // Both: moved.
    ok(await move(both, 1));
    // A scan moved to a record outside the scanner's collection.
    const scanner = await personWith(w, "scanner", [{ role: "scanner", scope: w.f1.id }]);
    const ax = ok(await service.readRecord(ctxOf(w.a, folks.root), w.ax.id));
    expect(
      codes(
        await service.updateRecord(
          ctxOf(w.a, scanner),
          w.ax.id,
          { ...ax.record, represents: w.o.id },
          {
            expectedVersion: ax.version,
          },
        ),
      ),
    ).toEqual(["unknown_record"]);
    // Restoring an old version that filed the series elsewhere is a move too.
    expect(
      codes(await service.restoreVersion(ctxOf(w.a, onlyOne), w.s1.id, 1, { expectedVersion: 2 })),
    ).toEqual(["unknown_record"]);
    ok(await service.restoreVersion(ctxOf(w.a, both), w.s1.id, 1, { expectedVersion: 2 }));
  }, 60_000);

  it("a scoped read-only grant beside a cataloger's: reads there, edits only where cataloging", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "mixed", [
      { role: "cataloger", scope: w.f1.id },
      { role: "read_only", scope: w.f2.id },
    ]);
    const c = ctxOf(w.a, p);
    ok(await service.readRecord(c, w.s2.id));
    expect(
      codes(
        await service.updateRecord(c, w.s2.id, { ...w.s2, title: "No" }, { expectedVersion: 1 }),
      ),
    ).toEqual(["not_permitted"]);
    expect(codes(await service.createRecord(c, unitDraft("file", "Invented", w.s2.id)))).toEqual([
      "not_permitted",
    ]);
    ok(await service.createRecord(c, unitDraft("file", "Invented", w.s1.id)));
  }, 60_000);

  it("a unit roles are granted on can't be deleted until the grants change", async () => {
    await ready();
    const w = await world();
    const unit = ok(
      await service.createRecord(ctxOf(w.a, folks.root), unitDraft("fonds", "Invented Lone Fonds")),
    ).record;
    const p = await folks.member(w.a, `lone-${newRecordId().slice(0, 6)}`);
    const id = await grant(service, folks.root, w.a, {
      userId: p,
      role: "read_only",
      siteId: w.a1,
      scope: unit.id,
    });
    expect(
      codes(await service.deleteRecord(ctxOf(w.a, folks.root), unit.id, { expectedVersion: 1 })),
    ).toEqual(["has_role_grants"]);
    ok(await service.revokeRole(ctxOf(w.a, folks.root), id));
    ok(await service.deleteRecord(ctxOf(w.a, folks.root), unit.id, { expectedVersion: 1 }));
  }, 60_000);

  it("grants are scoped to archival units of the organization, and site managers to whole sites", async () => {
    await ready();
    const w = await world();
    const rootCtx = ctxOf(w.a, folks.root);
    const p = await folks.member(w.a, `scopee-${newRecordId().slice(0, 6)}`);
    const req = (extra: Record<string, unknown>) => ({
      userId: p,
      role: "cataloger",
      siteId: w.a1,
      scope: null,
      ...extra,
    });
    expect(codes(await service.grantRole(rootCtx, req({ scope: w.o.id })))).toEqual(["not_a_unit"]);
    const theirs = ok(
      await service.createRecord(
        ctxOf(w.b, folks.root),
        unitDraft("fonds", "Invented Their Fonds"),
      ),
    ).record;
    expect(codes(await service.grantRole(rootCtx, req({ scope: theirs.id })))).toEqual([
      "unknown_record",
    ]);
    expect(
      codes(await service.grantRole(rootCtx, req({ role: "site_manager", scope: w.f1.id }))),
    ).toEqual(["whole_catalog_only"]);
    expect(codes(await service.grantRole(rootCtx, req({ role: "curator" })))).toEqual([
      "unknown_role",
    ]);
    expect(codes(await service.grantRole(rootCtx, { ...req({}), extra: 1 }))).toEqual([
      "invalid_request",
    ]);
    // Leaving out the site or the scope never widens a grant.
    expect(
      codes(await service.grantRole(rootCtx, { userId: p, role: "cataloger", scope: null })),
    ).toEqual(["invalid_request"]);
    expect(
      codes(await service.grantRole(rootCtx, { userId: p, role: "cataloger", siteId: w.a1 })),
    ).toEqual(["invalid_request"]);
    ok(await service.grantRole(rootCtx, req({ scope: w.f1.id })));
    expect(codes(await service.grantRole(rootCtx, req({ scope: w.f1.id })))).toEqual([
      "already_granted",
    ]);
  }, 60_000);
});

describe("organizations and sites stay apart", () => {
  it("a member of another organization can do nothing here, and nothing there reaches here", async () => {
    await ready();
    const w = await world();
    const inA = ctxOf(w.a, w.stranger);
    expect(codes(await service.readRecord(inA, w.o.id))).toEqual(["not_permitted"]);
    expect(codes(await service.createRecord(inA, objectDraft()))).toEqual(["not_permitted"]);
    // In their own organization, A's records are unknown, as for a system manager there.
    const inB = ctxOf(w.b, w.stranger);
    const nowhere = await service.readRecord(inB, newRecordId());
    expect(await service.readRecord(inB, w.o.id)).toEqual(nowhere);
    expect(await service.readRecord(ctxOf(w.b, folks.root), w.o.id)).toEqual(nowhere);
    expect(codes(await service.createRecord(inB, unitDraft("file", "Invented", w.s1.id)))).toEqual([
      "missing_parent",
    ]);
    // A's site manager can't grant on B's site (as on a made-up one), nor to B's member.
    const manager = ctxOf(w.a, w.byRole.site_manager);
    const onB = await service.grantRole(manager, {
      userId: w.none,
      role: "read_only",
      siteId: w.b1,
      scope: null,
    });
    expect(codes(onB)).toEqual(["not_permitted"]);
    expect(onB).toEqual(
      await service.grantRole(manager, {
        userId: w.none,
        role: "read_only",
        siteId: newSiteId(),
        scope: null,
      }),
    );
    // A system manager working in A: B's site is unknown in A.
    expect(
      codes(
        await service.grantRole(ctxOf(w.a, folks.root), {
          userId: w.none,
          role: "read_only",
          siteId: w.b1,
          scope: null,
        }),
      ),
    ).toEqual(["unknown_site"]);
    const outsider = await service.grantRole(manager, {
      userId: w.stranger,
      role: "read_only",
      siteId: w.a1,
      scope: null,
    });
    expect(codes(outsider)).toEqual(["unknown_person"]);
    expect(outsider).toEqual(
      await service.grantRole(manager, {
        userId: newRecordId(),
        role: "read_only",
        siteId: w.a1,
        scope: null,
      }),
    );
    // Even a system manager can't give a role in A to someone who isn't A's member.
    expect(
      codes(
        await service.grantRole(ctxOf(w.a, folks.root), {
          userId: w.stranger,
          role: "cataloger",
          siteId: w.a1,
          scope: null,
        }),
      ),
    ).toEqual(["unknown_person"]);
    // B's assignments are unknown in A, even to a system manager.
    const theirs = ok(await service.listRoleAssignments(ctxOf(w.b, folks.root))).assignments;
    const first = theirs[0];
    if (first === undefined) throw new Error("no assignment");
    expect(codes(await service.revokeRole(ctxOf(w.a, folks.root), first.id))).toEqual([
      "unknown_assignment",
    ]);
  }, 60_000);

  it("a site manager manages people on their own sites only, and appoints no site managers", async () => {
    await ready();
    const w = await world();
    const manager = ctxOf(w.a, w.byRole.site_manager);
    const p = await folks.member(w.a, `managed-${newRecordId().slice(0, 6)}`);
    const r = (extra: Record<string, unknown>) => ({
      userId: p,
      role: "cataloger",
      siteId: w.a1,
      scope: null,
      ...extra,
    });
    ok(await service.grantRole(manager, r({ scope: w.f1.id })));
    expect(codes(await service.grantRole(manager, r({ siteId: w.a2 })))).toEqual(["not_permitted"]);
    expect(codes(await service.grantRole(manager, r({ siteId: null })))).toEqual(["not_permitted"]);
    expect(codes(await service.grantRole(manager, r({ role: "site_manager" })))).toEqual([
      "not_permitted",
    ]);
    // A grant on A2 made by the system manager: unknown to A1's manager, as a made-up ID.
    const onA2 = await grant(service, folks.root, w.a, {
      userId: p,
      role: "read_only",
      siteId: w.a2,
    });
    const unknown = await service.revokeRole(manager, newRecordId());
    expect(await service.revokeRole(manager, onA2)).toEqual(unknown);
    // Listed: only what they manage, so neither A2's grants nor grants on
    // every site (only system managers change those).
    const everywhere = await grant(service, folks.root, w.a, {
      userId: p,
      role: "read_only",
      siteId: null,
    });
    const listed = ok(await service.listRoleAssignments(manager)).assignments;
    expect(listed.some((a) => a.id === onA2 || a.id === everywhere)).toBe(false);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((a) => a.siteId === w.a1)).toBe(true);
    expect(await service.revokeRole(manager, everywhere)).toEqual(unknown);
    // The other site's manager role, too.
    const managers = ok(
      await service.listRoleAssignments(ctxOf(w.a, folks.root)),
    ).assignments.filter((a) => a.role === "site_manager");
    for (const m of managers) {
      expect(await service.revokeRole(manager, m.id)).toEqual(unknown);
    }
  }, 60_000);

  it("after sign-in a person sees only the sites they have a role on; a system manager sees all", async () => {
    await ready();
    const w = await world();
    const cataloger = w.byRole.cataloger;
    const sites = ok(await service.listMySites(ctxOf(w.a, cataloger)));
    expect(sites.map((x) => x.siteId)).toEqual([w.a1]);
    expect(ok(await service.listMySites(ctxOf(w.a, w.none)))).toEqual([]);
    // A role on every site of A counts for each; a second organization adds its sites.
    const everywhere = await personWith(w, "everywhere", [{ role: "read_only", siteId: null }]);
    expect(
      ok(await service.listMySites(ctxOf(w.a, everywhere)))
        .map((x) => x.siteId)
        .sort(),
    ).toEqual([w.a1, w.a2].sort());
    const all = ok(await service.listMySites(ctxOf(w.a, folks.root))).map((x) => x.siteId);
    for (const site of [w.a1, w.a2, w.b1]) expect(all).toContain(site);
    // Both organizations, for someone with roles in both.
    await folks.member(w.b, `role-cataloger-${String(worldCount)}`);
    await grant(service, folks.root, w.b, { userId: cataloger, role: "read_only", siteId: w.b1 });
    expect(
      ok(await service.listMySites(ctxOf(w.a, cataloger)))
        .map((x) => x.siteId)
        .sort(),
    ).toEqual([w.a1, w.b1].sort());
    // Not through a session's word: contextFromSession ignores systemAdmin.
    const fake = contextFromSession({
      userId: cataloger,
      organizationId: w.a,
      systemAdmin: true,
    } as never);
    expect(codes(await service.readSystemSettings(fake))).toEqual(["not_permitted"]);
  }, 60_000);
});

describe("role changes take effect at once", () => {
  it("revoked, the next write is refused; granted again, it goes through; changed, the new role rules", async () => {
    await ready();
    const w = await world();
    const p = await folks.member(w.a, `changer-${newRecordId().slice(0, 6)}`);
    const c = ctxOf(w.a, p);
    const id = await grant(service, folks.root, w.a, {
      userId: p,
      role: "cataloger",
      siteId: w.a1,
    });
    ok(await service.createRecord(c, objectDraft()));
    ok(await service.revokeRole(ctxOf(w.a, folks.root), id));
    expect(codes(await service.createRecord(c, objectDraft()))).toEqual(["not_permitted"]);
    await grant(service, folks.root, w.a, { userId: p, role: "read_only", siteId: w.a1 });
    expect(codes(await service.createRecord(c, objectDraft()))).toEqual(["not_permitted"]);
    ok(await service.readRecord(c, w.o.id));
    await grant(service, folks.root, w.a, { userId: p, role: "reviewer", siteId: w.a2 });
    ok(await service.createRecord(c, objectDraft()));
  }, 60_000);
});

describe("a revocation racing a write", () => {
  it("a write already checked finishes first; the revocation waits for it", async () => {
    await ready();
    const w = await world();
    const p = await folks.member(w.a, `racer-${newRecordId().slice(0, 6)}`);
    const id = await grant(service, folks.root, w.a, {
      userId: p,
      role: "cataloger",
      siteId: w.a1,
    });
    const r = ok(await service.createRecord(ctxOf(w.a, folks.root), objectDraft())).record;
    const hold = gate();
    const held = s.owner.transaction(async (q) => {
      await q.rows(
        sql`SELECT 1 FROM public.records WHERE organization_id = ${w.a}::uuid AND id = ${r.id}::uuid FOR UPDATE`,
      );
      await hold.promise;
    });
    await new Promise((res) => setTimeout(res, 50));
    // The edit checks the role, then waits for the record's row.
    const edit = service.updateRecord(
      ctxOf(w.a, p),
      r.id,
      { ...r, title: "Edited in flight" },
      { expectedVersion: 1 },
    );
    await waiting(1);
    // The revocation waits for the edit (the person's row is shared-locked by it).
    const revoke = service2.revokeRole(ctxOf(w.a, folks.root), id);
    await waiting(2);
    hold.open();
    await held;
    ok(await edit);
    ok(await revoke);
    expect(
      codes(
        await service.updateRecord(
          ctxOf(w.a, p),
          r.id,
          { ...r, title: "Later" },
          { expectedVersion: 2 },
        ),
      ),
    ).toEqual(["not_permitted"]);
  }, 60_000);

  it("a write that starts while a revocation is in flight waits, then sees it and is refused", async () => {
    await ready();
    const w = await world();
    const p = await folks.member(w.a, `racer2-${newRecordId().slice(0, 6)}`);
    const id = await grant(service, folks.root, w.a, {
      userId: p,
      role: "cataloger",
      siteId: w.a1,
    });
    const r = ok(await service.createRecord(ctxOf(w.a, folks.root), objectDraft())).record;
    // Hold the assignment row so the revocation stops after locking the person.
    const hold = gate();
    const held = s.owner.transaction(async (q) => {
      await q.rows(
        sql`SELECT 1 FROM public.role_assignments WHERE organization_id = ${w.a}::uuid AND id = ${id}::uuid FOR UPDATE`,
      );
      await hold.promise;
    });
    await new Promise((res) => setTimeout(res, 50));
    const revoke = service2.revokeRole(ctxOf(w.a, folks.root), id);
    await waiting(1);
    const edit = service.updateRecord(
      ctxOf(w.a, p),
      r.id,
      { ...r, title: "Sneaked in" },
      { expectedVersion: 1 },
    );
    await waiting(2);
    hold.open();
    await held;
    ok(await revoke);
    expect(codes(await edit)).toEqual(["not_permitted"]);
    expect(ok(await service.readRecord(ctxOf(w.a, folks.root), r.id)).version).toBe(1);
  }, 60_000);

  it("disabling an account in flight: the write waits, then is refused", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "disabled", [{ role: "cataloger" }]);
    const hold = gate();
    const disabling = s.owner.transaction(async (q) => {
      await q.execute(sql`UPDATE public.users SET disabled_at = now() WHERE id = ${p}::uuid`);
      await hold.promise;
    });
    await new Promise((res) => setTimeout(res, 50));
    const write = service.createRecord(ctxOf(w.a, p), objectDraft());
    await waiting(1);
    hold.open();
    await disabling;
    expect(codes(await write)).toEqual(["not_permitted"]);
  }, 60_000);

  it("a scoped write waits for a move in flight, then checks the arrangement as moved", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "scoped-racer", [{ role: "cataloger", scope: w.f1.id }]);
    // The system manager moves S1 (and X1 below it) out of F1; the move is
    // held after it took the arrangement lock, waiting for S1's row.
    const hold = gate();
    const held = s.owner.transaction(async (q) => {
      await q.rows(
        sql`SELECT 1 FROM public.records WHERE organization_id = ${w.a}::uuid AND id = ${w.s1.id}::uuid FOR UPDATE`,
      );
      await hold.promise;
    });
    await new Promise((res) => setTimeout(res, 50));
    const move = service2.updateRecord(
      ctxOf(w.a, folks.root),
      w.s1.id,
      { ...w.s1, parentId: w.f2.id },
      {
        expectedVersion: 1,
      },
    );
    await waiting(1);
    const edit = service.updateRecord(
      ctxOf(w.a, p),
      w.x1.id,
      { ...w.x1, title: "Racing" },
      { expectedVersion: 1 },
    );
    await waiting(2);
    hold.open();
    await held;
    ok(await move);
    expect(codes(await edit)).toEqual(["unknown_record"]);
  }, 60_000);
});

describe("System settings", () => {
  it("defaults until changed, checked values, and an edit conflict", async () => {
    await ready();
    const w = await world();
    const c = ctxOf(w.a, folks.root);
    const before = ok(await service.readSystemSettings(c));
    expect(before.settings.sessionAbsoluteMinutes).toBeGreaterThanOrEqual(
      before.settings.sessionIdleMinutes,
    );
    const changed = ok(
      await service.changeSystemSettings(
        c,
        { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 },
        {
          expectedVersion: before.version,
        },
      ),
    );
    expect(changed).toEqual({
      settings: { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 },
      version: before.version + 1,
    });
    expect(
      codes(
        await service.changeSystemSettings(
          c,
          { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600 },
          {
            expectedVersion: before.version,
          },
        ),
      ),
    ).toEqual(["version_conflict"]);
    expect(
      codes(
        await service.changeSystemSettings(
          c,
          { sessionIdleMinutes: 700, sessionAbsoluteMinutes: 600 },
          {
            expectedVersion: changed.version,
          },
        ),
      ),
    ).toEqual(["idle_longer_than_absolute"]);
    expect(
      codes(
        await service.changeSystemSettings(
          c,
          { sessionIdleMinutes: 30, sessionAbsoluteMinutes: 600, smtp: "x" },
          {
            expectedVersion: changed.version,
          },
        ),
      ),
    ).toEqual(["unknown_setting"]);
    expect(ok(await service.readSystemSettings(c))).toEqual(changed);
  }, 60_000);
});

describe("the database backs the rules up", () => {
  it("the writer holds exactly WRITER_PRIVILEGES on the new tables, and the check accepts nothing more", async () => {
    await ready();
    expect(WRITER_PRIVILEGES.sites).toEqual(["INSERT", "UPDATE"]);
    expect(WRITER_PRIVILEGES.role_assignments).toEqual(["INSERT", "DELETE"]);
    expect(WRITER_PRIVILEGES.system_settings).toEqual(["INSERT", "UPDATE"]);
    expect(await checkWriterConnection(s.writer)).toEqual([]);
    const writerRole = s.roles[0] ?? "";
    for (const extra of [
      "GRANT UPDATE ON public.role_assignments TO %I",
      "GRANT DELETE ON public.sites TO %I",
      "GRANT DELETE ON public.system_settings TO %I",
      "GRANT TRUNCATE ON public.role_assignments TO %I",
    ]) {
      await s.owner.transaction((q) => withRole(q, extra, writerRole));
      const problems = await checkWriterConnection(s.writer);
      expect(problems.map((p) => p.code)).toContain("extra_privilege");
      await s.owner.transaction((q) =>
        withRole(q, extra.replace("GRANT", "REVOKE").replace(" TO ", " FROM "), writerRole),
      );
    }
    expect(await checkWriterConnection(s.writer)).toEqual([]);
    const w = await world();
    const denied = async (statement: Promise<unknown>) => {
      try {
        await statement;
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "not refused";
    };
    expect(
      await denied(
        s.writer.execute(sql`DELETE FROM public.sites WHERE organization_id = ${w.a}::uuid`),
      ),
    ).toBe("42501");
    expect(
      await denied(
        s.writer.execute(
          sql`UPDATE public.role_assignments SET role = 'site_manager' WHERE organization_id = ${w.a}::uuid`,
        ),
      ),
    ).toBe("42501");
    expect(await denied(s.writer.execute(sql`DELETE FROM public.system_settings`))).toBe("42501");
    expect(await denied(s.writer.execute(sql`TRUNCATE public.role_assignments`))).toBe("42501");
  }, 60_000);

  it("refuses, for any writer: roles without a membership, scopes that aren't units, another organization's site, moves", async () => {
    await ready();
    const w = await world();
    const constraint = async (work: (q: Queryable) => Promise<unknown>) => {
      try {
        await s.writer.transaction(work);
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        return `${e.code ?? ""}:${e.constraint ?? ""}`;
      }
      return "not refused";
    };
    const insert = (values: {
      user: string;
      role?: string;
      site?: string | null;
      scope?: string | null;
    }) =>
      constraint((q) =>
        q.execute(sql`
          INSERT INTO public.role_assignments (organization_id, id, user_id, role, site_id, scope_record_id, granted_by)
          VALUES (${w.a}::uuid, ${newRecordId()}::uuid, ${values.user}::uuid, ${values.role ?? "cataloger"},
                  ${values.site ?? null}::uuid, ${values.scope ?? null}::uuid, ${folks.root}::uuid)`),
      );
    expect(await insert({ user: w.stranger })).toMatch(/^23503:/);
    expect(await insert({ user: w.none, site: w.b1 })).toMatch(/^23503:/);
    expect(await insert({ user: w.none, scope: w.o.id })).toBe(
      "23000:role_assignments_scope_is_unit",
    );
    expect(await insert({ user: w.none, role: "site_manager", scope: w.f1.id })).toBe(
      "23514:role_assignments_site_manager_whole",
    );
    expect(await insert({ user: w.none, role: "curator" })).toMatch(/^23514:/);
    expect(
      await constraint((q) =>
        q.execute(
          sql`UPDATE public.sites SET organization_id = ${w.b}::uuid WHERE id = ${w.a2}::uuid`,
        ),
      ),
    ).toBe("23000:sites_organization_id_fixed");
    expect(
      await constraint((q) =>
        q.execute(
          sql`INSERT INTO public.sites (organization_id, id, name) VALUES (${w.a}::uuid, ${newSiteId()}::uuid, ' padded')`,
        ),
      ),
    ).toMatch(/^23514:/);
    expect(
      await constraint((q) =>
        q.execute(
          sql`INSERT INTO public.system_settings (settings, version, changed_by) VALUES ('{}', 5, ${folks.root}::uuid) ON CONFLICT DO NOTHING`,
        ),
      ),
    ).toBe("23000:system_settings_version_step");
    // A site name changes; nothing else does.
    await s.writer.execute(
      sql`UPDATE public.sites SET name = 'Invented renamed' WHERE organization_id = ${w.a}::uuid AND id = ${w.a2}::uuid`,
    );
  }, 60_000);

  it("every trigger on the new tables is ALWAYS, and holds in replica mode", async () => {
    await ready();
    const rows = await s.owner.rows<{ relname: string; tgname: string; tgenabled: string }>(sql`
      SELECT c.relname, t.tgname, t.tgenabled FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('sites', 'role_assignments', 'system_settings')
      ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.relname}.${r.tgname}`)).toEqual([
      "role_assignments.role_assignments_check_new",
      "role_assignments.zzzz_role_assignments_keep_identity",
      "sites.zzzz_sites_keep_identity",
      "system_settings.system_settings_version_step",
    ]);
    expect(rows.every((r) => r.tgenabled === "A")).toBe(true);
    const w = await world();
    // The owner here is the test server's superuser, who may enter replica mode.
    const server = openDatabase(s.testDb.url, { max: 1 });
    try {
      for (const statement of [
        sql`UPDATE public.sites SET id = ${newSiteId()}::uuid WHERE organization_id = ${w.a}::uuid AND id = ${w.a1}::uuid`,
        sql`INSERT INTO public.role_assignments (organization_id, id, user_id, role, scope_record_id, granted_by)
            VALUES (${w.a}::uuid, ${newRecordId()}::uuid, ${w.none}::uuid, 'cataloger', ${w.o.id}::uuid, ${folks.root}::uuid)`,
      ]) {
        let code = "not refused";
        try {
          await server.transaction(async (q) => {
            await q.execute(sql`SET LOCAL session_replication_role = replica`);
            await q.execute(statement);
          });
        } catch (error) {
          code = (error as { code?: string }).code ?? "";
        }
        expect(code).toBe("23000");
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T-041 review fixes.

/** Holds row locks on a third connection until `release` is called. */
function holdRows(statement: ReturnType<typeof sql>): {
  held: Promise<void>;
  release: () => void;
  locked: Promise<void>;
} {
  const hold = gate();
  const lockedGate = gate();
  const held = s.owner.transaction(async (q) => {
    await q.rows(statement);
    lockedGate.open();
    await hold.promise;
  });
  return { held, release: hold.open, locked: lockedGate.promise };
}

/** Fails if `promise` doesn't settle within `ms` (it is waiting on a lock it shouldn't). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`still waiting after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const rowOf = (org: OrganizationId, id: RecordId) =>
  sql`SELECT 1 FROM public.records WHERE organization_id = ${org}::uuid AND id = ${id}::uuid FOR UPDATE`;

describe("a digital asset can't move between the check and the write", () => {
  it("saveIdentifiers after the owner moved the scan out of the collection: refused, nothing written", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "ids-racer", [{ role: "cataloger", scope: w.f1.id }]);
    // The owner's move of AX (X1 in F1 -> S2 in F2) is held at AX's row,
    // after it took the arrangement lock.
    const h = holdRows(rowOf(w.a, w.ax.id));
    await h.locked;
    const move = service2.updateRecord(
      ctxOf(w.a, folks.root),
      w.ax.id,
      { ...w.ax, represents: w.s2.id },
      { expectedVersion: 1 },
    );
    await waiting(1);
    const save = service.saveIdentifiers(ctxOf(w.a, p), w.ax.id, {
      current: [{ type: "object_number", value: "INV-RACE-1", primary: true }],
      former: [],
    });
    await waiting(2);
    h.release();
    await h.held;
    ok(await move);
    const saved = await save;
    expect(codes(saved)).toEqual(["unknown_record"]);
    expect(saved).toEqual(
      await service.saveIdentifiers(ctxOf(w.a, p), newRecordId(), { current: [], former: [] }),
    );
    const [held] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.record_identifiers
      WHERE organization_id = ${w.a}::uuid AND record_id = ${w.ax.id}::uuid`);
    expect(held?.n).toBe(0);
  }, 60_000);

  it("restoreVersion can't bring a scan back out of a collection the actor can't see", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "restore-racer", [{ role: "cataloger", scope: w.f1.id }]);
    const h = holdRows(rowOf(w.a, w.ax.id));
    await h.locked;
    // The owner moves AX to S2 (its version 2); held at AX's row.
    const move = service2.updateRecord(
      ctxOf(w.a, folks.root),
      w.ax.id,
      { ...w.ax, represents: w.s2.id },
      { expectedVersion: 1 },
    );
    await waiting(1);
    // The cataloger restores version 1 (AX under X1), as if at version 2.
    const restore = service.restoreVersion(ctxOf(w.a, p), w.ax.id, 1, { expectedVersion: 2 });
    await waiting(2);
    h.release();
    await h.held;
    ok(await move);
    expect(codes(await restore)).toEqual(["unknown_record"]);
    const now = ok(await service.readRecord(ctxOf(w.a, folks.root), w.ax.id));
    expect(now.version).toBe(2);
    expect((now.record as { represents?: string }).represents).toBe(w.s2.id);
  }, 60_000);

  it("a scan's move waits for a scoped write in flight, which sees the scan where it was", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "first-racer", [{ role: "cataloger", scope: w.f1.id }]);
    const h = holdRows(rowOf(w.a, w.ax.id));
    await h.locked;
    // The cataloger checks first (holding the arrangement lock), then waits for AX's row.
    const save = service.saveIdentifiers(ctxOf(w.a, p), w.ax.id, {
      current: [{ type: "object_number", value: "INV-RACE-2", primary: true }],
      former: [],
    });
    await waiting(1);
    const move = service2.updateRecord(
      ctxOf(w.a, folks.root),
      w.ax.id,
      { ...w.ax, represents: w.s2.id },
      { expectedVersion: 1 },
    );
    await waiting(2);
    h.release();
    await h.held;
    ok(await save);
    ok(await move);
    expect(codes(await service.readRecord(ctxOf(w.a, p), w.ax.id))).toEqual(["unknown_record"]);
  }, 60_000);
});

describe("role changes don't deadlock", () => {
  it("A grants to B while B grants to A, and one person given two roles at once: no retry", async () => {
    await ready();
    const w = await world();
    const errors: unknown[] = [];
    const once1 = createService(s.writer, { attempts: 1, onError: (e) => errors.push(e) });
    const once2 = createService(s.writer2, { attempts: 1, onError: (e) => errors.push(e) });
    const m1 = await personWith(w, "manager-one", [{ role: "site_manager" }]);
    const m2 = await personWith(w, "manager-two", [{ role: "site_manager" }]);
    const both = sql`SELECT 1 FROM public.users WHERE id = ANY(${[m1, m2]}::uuid[]) FOR SHARE`;
    for (const role of ["read_only", "reviewer"]) {
      // Both grants pass their first look while a third connection holds
      // both rows, so they meet at the locks.
      const h = holdRows(both);
      await h.locked;
      const one = once1.grantRole(ctxOf(w.a, m1), {
        userId: m2,
        role,
        siteId: w.a1,
        scope: null,
      });
      const two = once2.grantRole(ctxOf(w.a, m2), {
        userId: m1,
        role,
        siteId: w.a1,
        scope: null,
      });
      await waiting(2);
      h.release();
      await h.held;
      const results = await Promise.all([one, two]);
      expect(results.map((r) => (r.ok ? "ok" : codes(r)[0]))).toEqual(["ok", "ok"]);
    }
    // A site manager giving themselves two roles at once.
    const self = sql`SELECT 1 FROM public.users WHERE id = ${m1}::uuid FOR SHARE`;
    const h = holdRows(self);
    await h.locked;
    const grants = ["cataloger", "scanner"].map((role, i) =>
      (i === 0 ? once1 : once2).grantRole(ctxOf(w.a, m1), {
        userId: m1,
        role,
        siteId: w.a1,
        scope: null,
      }),
    );
    await waiting(2);
    h.release();
    await h.held;
    const results = await Promise.all(grants);
    expect(results.map((r) => (r.ok ? "ok" : codes(r)[0]))).toEqual(["ok", "ok"]);
    expect(errors).toEqual([]);
  }, 60_000);

  it("a role change locks no row of a person who isn't a member", async () => {
    await ready();
    const w = await world();
    const h = holdRows(sql`SELECT 1 FROM public.users WHERE id = ${w.stranger}::uuid FOR SHARE`);
    await h.locked;
    try {
      const refused = await within(
        service.grantRole(ctxOf(w.a, w.byRole.site_manager), {
          userId: w.stranger,
          role: "read_only",
          siteId: w.a1,
          scope: null,
        }),
        10_000,
      );
      expect(codes(refused)).toEqual(["unknown_person"]);
    } finally {
      h.release();
      await h.held;
    }
  }, 60_000);
});

describe("links to records the actor can't view", () => {
  it("are answered exactly as links to records that don't exist; kept links still save", async () => {
    await ready();
    const w = await world();
    const rootCtx = ctxOf(w.a, folks.root);
    const agent = ok(
      await service.createRecord(rootCtx, {
        kind: "agent",
        agentType: "person",
        title: "Invented Maker",
        templateKey: "t-agent",
        fields: {},
      }),
    ).record;
    const p = await personWith(w, "linker", [{ role: "cataloger", scope: w.f1.id }]);
    const c = ctxOf(w.a, p);
    const linked = (id: RecordId) => ({
      ...unitDraft("file", "Invented linked file", w.s1.id),
      fields: { related: { recordId: id, label: "Someone" } },
    });
    const nowhere = await service.createRecord(c, linked(newRecordId()));
    expect(codes(nowhere)).toEqual(["unknown_record"]);
    // The object (the wrong kind) and the agent (the right kind) alike.
    const strip = (r: unknown) => JSON.stringify(r).replace(/[0-9a-f-]{36}/g, "ID");
    expect(strip(await service.createRecord(c, linked(w.o.id)))).toBe(strip(nowhere));
    expect(strip(await service.createRecord(c, linked(agent.id)))).toBe(strip(nowhere));
    // A link the record already holds, kept through an edit, still saves.
    const x1 = ok(
      await service.updateRecord(
        rootCtx,
        w.x1.id,
        { ...w.x1, fields: { related: { recordId: agent.id, label: "Someone" } } },
        { expectedVersion: 1 },
      ),
    );
    ok(
      await service.updateRecord(
        c,
        w.x1.id,
        { ...x1.record, title: "Edited, link kept" },
        { expectedVersion: x1.version },
      ),
    );
    // Someone who may view the whole catalog gets the real answers.
    const viewer = await personWith(w, "viewer-linker", [
      { role: "read_only" },
      { role: "cataloger", scope: w.f1.id },
    ]);
    expect(codes(await service.createRecord(ctxOf(w.a, viewer), linked(w.o.id)))).toEqual([
      "wrong_record_kind",
    ]);
    ok(await service.createRecord(ctxOf(w.a, viewer), linked(agent.id)));
  }, 60_000);
});

describe("Scanners and identifiers", () => {
  it("set numbers on digital assets only, through saveIdentifiers and saves alike", async () => {
    await ready();
    const w = await world();
    const c = ctxOf(w.a, w.byRole.scanner);
    const numbers = (value: string) => ({
      current: [{ type: "object_number", value, primary: true }],
      former: [],
    });
    ok(await service.saveIdentifiers(c, w.ax.id, numbers("INV-SCAN-1")));
    const made = ok(
      await service.createRecord(c, assetDraft(w.x1.id), { identifiers: numbers("INV-SCAN-2") }),
    );
    ok(
      await service.updateRecord(c, made.record.id, made.record, {
        expectedVersion: 1,
        identifiers: {
          current: [{ type: "object_number", value: "INV-SCAN-3", primary: true }],
          former: [{ type: "object_number", value: "INV-SCAN-2" }],
        },
      }),
    );
    // Not on other kinds, by any route.
    expect(codes(await service.saveIdentifiers(c, w.o.id, numbers("INV-SCAN-4")))).toEqual([
      "not_permitted",
    ]);
    expect(codes(await service.saveIdentifiers(c, w.x1.id, numbers("INV-SCAN-5")))).toEqual([
      "not_permitted",
    ]);
    expect(
      codes(
        await service.updateRecord(c, w.o.id, w.o, {
          expectedVersion: 1,
          identifiers: numbers("INV-SCAN-6"),
        }),
      ),
    ).toEqual(["not_permitted"]);
    expect(
      codes(await service.createRecord(c, objectDraft(), { identifiers: numbers("INV-SCAN-7") })),
    ).toEqual(["not_permitted"]);
  }, 60_000);
});

describe("scoped reads", () => {
  it("run side by side, but never see a move half done", async () => {
    await ready();
    const w = await world();
    const p = await personWith(w, "reader", [{ role: "read_only", scope: w.f1.id }]);
    const q = await personWith(w, "reader-two", [{ role: "cataloger", scope: w.f1.id }]);
    // Reader one reads a scan of the scan AX: finding where it sits locks AX
    // FOR SHARE after the (shared) arrangement lock, and is held there.
    const ay = ok(await service.createRecord(ctxOf(w.a, folks.root), assetDraft(w.ax.id))).record;
    const h = holdRows(rowOf(w.a, w.ax.id));
    await h.locked;
    const first = service.readRecord(ctxOf(w.a, p), ay.id);
    await waiting(1);
    try {
      // Reader two (another scoped person) goes through meanwhile.
      ok(await within(service2.readRecord(ctxOf(w.a, q), w.s1.id), 10_000));
    } finally {
      h.release();
      await h.held;
    }
    ok(await first);
    // A move held after taking the arrangement lock: a read waits for it,
    // then sees the arrangement as moved.
    const h2 = holdRows(rowOf(w.a, w.s1.id));
    await h2.locked;
    const move = service2.updateRecord(
      ctxOf(w.a, folks.root),
      w.s1.id,
      { ...w.s1, parentId: w.f2.id },
      { expectedVersion: 1 },
    );
    await waiting(1);
    const read = service.readRecord(ctxOf(w.a, p), w.x1.id);
    await waiting(2);
    h2.release();
    await h2.held;
    ok(await move);
    expect(codes(await read)).toEqual(["unknown_record"]);
  }, 60_000);
});

describe("listing role assignments", () => {
  it("pages through every assignment instead of stopping at a limit", async () => {
    await ready();
    const w = await world();
    const c = ctxOf(w.a, folks.root);
    const all = ok(await service.listRoleAssignments(c, { limit: 1000 }));
    expect(all.next).toBeNull();
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const page: { assignments: readonly { id: string }[]; next: string | null } = ok(
        await service.listRoleAssignments(c, { limit: 2, ...(after === null ? {} : { after }) }),
      );
      expect(page.assignments.length).toBeLessThanOrEqual(2);
      seen.push(...page.assignments.map((a) => a.id));
      after = page.next;
      if (after === null) break;
    }
    expect(seen).toEqual(all.assignments.map((a) => a.id));
    expect(seen.length).toBeGreaterThan(2);
    expect(codes(await service.listRoleAssignments(c, { after: "nope" }))).toEqual([
      "invalid_cursor",
    ]);
    expect(codes(await service.listRoleAssignments(c, { limit: 1001 }))).toEqual(["invalid_limit"]);
    expect(codes(await service.listRoleAssignments(c, { extra: 1 }))).toEqual(["invalid_request"]);
  }, 60_000);
});
