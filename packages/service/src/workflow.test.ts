// Workflow states and the publish state (T-034b, T-034c, D-076): the state
// changes only through the service's four actions, each one a version of the
// record with who, when and why; publishing runs the publish check in its
// transaction; a published record stays publishable or the write is refused;
// it must be withdrawn before deletion; the database refuses every other
// change of state for every writer, in replica mode too; and the public
// output shows published records only, never an unpublished one through a
// link, a place or an inherited value.
import { afterAll, describe, expect, it } from "vitest";
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_STATES,
  newOrganizationId,
  newRecordId,
  workflowTransition,
  type CatalogRecord,
  type DublinCoreMapping,
  type Issue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import {
  WRITER_PRIVILEGES,
  checkPublicReaderConnection,
  checkWriterConnection,
  grantPublicReaderRole,
  grantWriterRole,
  insertIdentifierType,
  insertOrganization,
  insertTemplateVersion,
  migrate,
  openDatabase,
  readPublicRecord,
  readVersions,
  readWorkflowState,
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
  createService,
  type PublicChangeRequest,
  type RecordService,
  type ServiceResult,
} from "./service.js";
import { actorOf, grant, makeSite, people, type People } from "./people.fixtures.js";

// Alice and Bob are invented people who manage each test organization's
// one site (T-041: every operation checks the actor's roles).
let ALICE = "";
let BOB = "";
let folks: People | undefined;
let alice: UserId | undefined;
let bob: UserId | undefined;
const NOW = new Date("2026-11-24T12:00:00.000Z");
const INC = "http://rightsstatements.org/vocab/InC/1.0/";
const BASE = "https://archive.example.org/records/";
const IDENTITY = "23000";

// ---------------------------------------------------------------------------
// One migrated database for the file; a writer role made for it.

interface Setup {
  testDb: TestDatabase;
  owner: Database;
  writer: Database;
  writer2: Database;
  reader: Database;
  staffReader: Database;
  roles: string[];
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;
let service2: RecordService;

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
  return openDatabase(u.toString(), { max: 3 });
}

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const suffix = newRecordId().slice(0, 8);
    const roles = ["writer", "reader", "staffreader"].map((r) => `oculus_t034_${r}_${suffix}`);
    const [writerRole = "", readerRole = "", staffReaderRole = ""] = roles;
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
      await grantWriterRole(q, writerRole);
      // The public sites' role (S-019): no table privilege at all.
      await grantPublicReaderRole(q, readerRole);
      // What the public output used to need: SELECT on everything.
      await withRole(q, "GRANT USAGE ON SCHEMA public TO %I", staffReaderRole);
      await withRole(q, "GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I", staffReaderRole);
    });
    return {
      testDb,
      owner,
      writer: as(testDb.url, writerRole),
      writer2: as(testDb.url, writerRole),
      reader: as(testDb.url, readerRole),
      staffReader: as(testDb.url, staffReaderRole),
      roles,
    };
  })();
  s = await setup;
  service = createService(s.writer, { now: () => NOW });
  service2 = createService(s.writer2, { now: () => NOW });
  peopleReady ??= (async () => {
    const holding = newOrganizationId();
    ok(await insertOrganization(s.owner, { id: holding, name: "Invented Holding Society" }));
    const made = await people(s.owner, holding);
    return {
      made,
      alice: await made.member(holding, "Alice"),
      bob: await made.member(holding, "Bob"),
    };
  })();
  const p = await peopleReady;
  folks = p.made;
  alice = p.alice;
  bob = p.bob;
  ALICE = actorOf(alice);
  BOB = actorOf(bob);
}

let peopleReady: Promise<{ made: People; alice: UserId; bob: UserId }> | undefined;

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (!done) return;
  for (const pool of [done.writer, done.writer2, done.reader, done.staffReader, done.owner]) {
    await pool.close();
  }
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
// Invented sample data.

function ok<T>(result: Validated<T> | ServiceResult<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: { ok: boolean; issues?: readonly Issue[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((i) => i.code);
}

function field(key: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

const OBJECT_FIELDS = [
  field("rights", "rights"),
  field("note", "text"),
  field("secret", "text", { visibility: "staff" }),
  field("creator", "record_link", { recordKinds: ["agent"] }),
  field("found_at", "place"),
  field("number", "identifier"),
];

async function organization(): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: "Invented Society" }));
  const templates: [string, string, unknown[]][] = [
    ["pub-object", "object", OBJECT_FIELDS],
    [
      "pub-unit",
      "archival_unit",
      [field("rights", "rights"), field("provenance", "text", { inherited: true })],
    ],
    [
      "pub-object-open",
      "object",
      OBJECT_FIELDS.map((f) => (f.key === "secret" ? { ...f, visibility: "public" } : f)),
    ],
    ["pub-agent", "agent", [field("note", "text")]],
    ["pub-place", "place", [field("note", "text")]],
  ];
  for (const [key, kind, fields] of templates) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields,
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
        public: true,
      }),
    ),
  );
  if (folks === undefined || alice === undefined || bob === undefined) throw new Error("not ready");
  const site = await makeSite(service, folks.root, org);
  for (const userId of [alice, bob]) {
    await folks.member(org, userId === alice ? "Alice" : "Bob");
    await grant(service, folks.root, org, { userId, role: "site_manager", siteId: site });
  }
  siteOf.set(org, site);
  return org;
}

/** Each organization's one site, where Alice and Bob work (D-074). */
const siteOf = new Map<OrganizationId, SiteId>();

function siteFor(org: OrganizationId): SiteId {
  const site = siteOf.get(org);
  if (site === undefined) throw new Error("no site");
  return site;
}

const ctx = (organizationId: OrganizationId, actor = ALICE) => {
  const siteId = siteOf.get(organizationId);
  return { organizationId, actor, ...(siteId === undefined ? {} : { siteId }) };
};

function objectDraft(changes: Record<string, unknown> = {}): Record<string, unknown> {
  // A change to undefined leaves the field out.
  const fields = Object.fromEntries(
    Object.entries({
      rights: { uri: INC },
      note: "Tin and glass.",
      secret: "Kept in the back room.",
      ...changes,
    }).filter(([, v]) => (v as unknown) !== undefined),
  );
  return {
    kind: "object",
    title: "An invented lantern",
    templateKey: "pub-object",
    fields,
  };
}

async function create(
  org: OrganizationId,
  draft: Record<string, unknown>,
): Promise<{ record: CatalogRecord; version: number }> {
  const saved = ok(await service.createRecord(ctx(org), draft));
  return { record: saved.record, version: saved.version };
}

function mapping(org: OrganizationId): DublinCoreMapping {
  return {
    organizationId: org,
    template: "pub-object",
    entries: [
      { field: "rights", term: "rights" },
      { field: "note", term: "description" },
      { field: "creator", term: "creator" },
      { field: "found_at", term: "spatial" },
    ],
  };
}

function unitMapping(org: OrganizationId): DublinCoreMapping {
  return {
    organizationId: org,
    template: "pub-unit",
    entries: [
      { field: "rights", term: "rights" },
      { field: "provenance", term: "provenance" },
    ],
  };
}

async function publicText(
  org: OrganizationId,
  id: RecordId,
  db: Database = s.reader,
  site: SiteId | undefined = siteOf.get(org),
) {
  const out = await readPublicRecord(db, org, site ?? ("" as SiteId), id, {
    baseUrl: BASE,
    mappings: [mapping(org), unitMapping(org)],
  });
  if (!out.ok) return { ok: false as const, issues: out.issues, text: "" };
  const v = out.value;
  return {
    ok: true as const,
    issues: [] as Issue[],
    text: [v.id, JSON.stringify(v.dublinCore), v.jsonLdText, v.oaiDcXml].join("\n"),
  };
}

async function stateOf(org: OrganizationId, id: RecordId) {
  return (await readWorkflowState(s.owner, org, id))?.state;
}

/** The SQLSTATE and constraint `work` fails with. */
async function refusal(work: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return {
      code: e.code ?? "",
      ...(e.constraint === undefined ? {} : { constraint: e.constraint }),
    };
  }
  throw new Error("The statement was not refused.");
}

// ---------------------------------------------------------------------------

describe("the four actions through the service", () => {
  it("a new record is a draft, and each action is a version with who, when, why and the state", async () => {
    await ready();
    const org = await organization();
    const { record, version } = await create(org, objectDraft());
    expect(await stateOf(org, record.id)).toBe("draft");

    const sent = ok(
      await service.submitForReview(ctx(org), record.id, {
        expectedVersion: version,
        reason: "Ready to check.",
      }),
    );
    expect(sent).toEqual({
      state: "ready_for_review",
      version: 2,
      actor: ALICE,
      recordedAt: expect.any(String) as string,
    });
    const back = ok(await service.returnToDraft(ctx(org, BOB), record.id, { expectedVersion: 2 }));
    expect(back.state).toBe("draft");
    const published = ok(await service.publish(ctx(org), record.id, { expectedVersion: 3 }));
    expect(published.state).toBe("published");
    const withdrawn = ok(
      await service.withdraw(ctx(org, BOB), record.id, {
        expectedVersion: 4,
        reason: "Found a donor restriction.",
      }),
    );
    expect(withdrawn.state).toBe("withdrawn");

    const history = ok(await readVersions(s.owner, org, record.id)).versions;
    expect(
      history.map((v) => [v.version, v.action, v.workflowState, v.actor, v.changedFields]),
    ).toEqual([
      [1, "save", "draft", ALICE, expect.any(Array)],
      [2, "submit_for_review", "ready_for_review", ALICE, ["workflowState"]],
      [3, "return_to_draft", "draft", BOB, ["workflowState"]],
      [4, "publish", "published", ALICE, ["workflowState"]],
      [5, "withdraw", "withdrawn", BOB, ["workflowState"]],
    ]);
    expect(history[1]?.reason).toBe("Ready to check.");
    expect(history[4]?.reason).toBe("Found a donor restriction.");
    // The record itself is unchanged by every change of state.
    for (const v of history) expect(v.record).toEqual(record);
  });

  it("refuses moves D-075 doesn't allow, and saves nothing", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    expect(codes(await service.withdraw(ctx(org), record.id, { expectedVersion: 1 }))).toEqual([
      "action_not_allowed",
    ]);
    expect(codes(await service.returnToDraft(ctx(org), record.id, { expectedVersion: 1 }))).toEqual(
      ["action_not_allowed"],
    );
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect(codes(await service.publish(ctx(org), record.id, { expectedVersion: 2 }))).toEqual([
      "action_not_allowed",
    ]);
    expect(
      codes(await service.submitForReview(ctx(org), record.id, { expectedVersion: 2 })),
    ).toEqual(["action_not_allowed"]);
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(2);
    expect(await stateOf(org, record.id)).toBe("published");
  });

  it("needs the version the person was looking at, and reports what changed since", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.submitForReview(ctx(org), record.id, { expectedVersion: 1 }));
    const stale = await service.publish(ctx(org), record.id, { expectedVersion: 1 });
    expect(codes(stale)).toEqual(["version_conflict"]);
    expect(stale.ok ? undefined : stale.conflict).toMatchObject({
      expectedVersion: 1,
      currentVersion: 2,
    });
    for (const bad of [undefined, {}, { expectedVersion: 0 }, { expectedVersion: 1, extra: 1 }]) {
      expect(await service.publish(ctx(org), record.id, bad as never)).toMatchObject({ ok: false });
    }
    expect(await stateOf(org, record.id)).toBe("ready_for_review");
  });

  it("publishing runs the publish check in its transaction, and refuses (saving nothing) when it fails", async () => {
    await ready();
    const org = await organization();
    // No rights value: an object can't be published without one (D-015).
    const { record } = await create(org, objectDraft({ rights: undefined }));
    const refused = await service.publish(ctx(org), record.id, { expectedVersion: 1 });
    expect(refused.ok).toBe(false);
    expect(codes(refused).length).toBeGreaterThan(0);
    expect(await stateOf(org, record.id)).toBe("draft");
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(1);
  });

  it("another organization's record is refused exactly as one that doesn't exist", async () => {
    await ready();
    const org = await organization();
    const other = await organization();
    const { record } = await create(other, objectDraft());
    for (const action of ["publish", "withdraw", "submitForReview", "returnToDraft"] as const) {
      const theirs = await service[action](ctx(org), record.id, { expectedVersion: 1 });
      const missing = await service[action](ctx(org), newRecordId(), { expectedVersion: 1 });
      expect(theirs).toEqual(missing);
      expect(codes(theirs)).toEqual(["unknown_record"]);
    }
    expect(await stateOf(other, record.id)).toBe("draft");
  });
});

describe("a published record stays publishable", () => {
  it("an edit that keeps it publishable is saved and it stays published", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const saved = ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: { ...record.fields, note: "Tin, glass and a wire handle." } },
        { expectedVersion: 2 },
      ),
    );
    expect(saved.version).toBe(3);
    expect(await stateOf(org, record.id)).toBe("published");
    expect((await publicText(org, record.id)).text).toContain("wire handle");
  });

  it("an edit that would fail the publish check is refused, and nothing is saved", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const without = Object.fromEntries(
      Object.entries(record.fields).filter(([k]) => k !== "rights"),
    );
    const refused = await service.updateRecord(
      ctx(org),
      record.id,
      { ...record, fields: without },
      { expectedVersion: 2 },
    );
    expect(codes(refused)[0]).toBe("published_record_check");
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(2);
    // Withdrawn, the same edit is fine.
    ok(await service.withdraw(ctx(org), record.id, { expectedVersion: 2 }));
    ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: without },
        {
          expectedVersion: 3,
        },
      ),
    );
  });

  it("a restore that would fail the publish check is refused with fixed messages", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft({ rights: undefined }));
    const fixed = ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: { ...record.fields, rights: { uri: INC } } },
        { expectedVersion: 1 },
      ),
    );
    ok(await service.publish(ctx(org), record.id, { expectedVersion: fixed.version }));
    const refused = await service.restoreVersion(ctx(org), record.id, 1, { expectedVersion: 3 });
    expect(codes(refused)[0]).toBe("published_record_check");
    expect(JSON.stringify(refused)).not.toContain("back room");
    expect(await stateOf(org, record.id)).toBe("published");
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(3);
  });

  it("a restore of a published record keeps its state", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: { ...record.fields, note: "Rusted." } },
        { expectedVersion: 1 },
      ),
    );
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 2 }));
    const restored = ok(
      await service.restoreVersion(ctx(org), record.id, 1, {
        expectedVersion: 3,
        confirmMadePublic: ["note"],
      }),
    );
    expect(restored.action).toBe("save");
    expect(restored.workflowState).toBe("published");
    expect((await publicText(org, record.id)).text).toContain("Tin and glass.");
  });

  it("a published record must be withdrawn before it is deleted", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect(codes(await service.deleteRecord(ctx(org), record.id, { expectedVersion: 2 }))).toEqual([
      "published",
    ]);
    ok(await service.withdraw(ctx(org), record.id, { expectedVersion: 2 }));
    ok(await service.deleteRecord(ctx(org), record.id, { expectedVersion: 3 }));
    const history = ok(await readVersions(s.owner, org, record.id)).versions;
    expect(history.map((v) => v.action)).toEqual(["save", "publish", "withdraw", "delete"]);
    expect(history.at(-1)?.workflowState).toBe("withdrawn");
  });
});

describe("the publish permission hook (T-041 plugs records.publish in here)", () => {
  it("is asked for publishing, withdrawing and confirming values public on a published record, and nothing else", async () => {
    await ready();
    const org = await organization();
    const asked: PublicChangeRequest[] = [];
    let allow = true;
    const guarded = createService(s.writer, {
      now: () => NOW,
      mayChangePublicOutput: (_tx, request) => {
        asked.push(request);
        return Promise.resolve(
          allow
            ? undefined
            : {
                ok: false as const,
                issues: [
                  {
                    path: [],
                    code: "not_permitted",
                    message: "You don't have permission to do this.",
                  },
                ],
              },
        );
      },
    });
    const { record } = ok(await guarded.createRecord(ctx(org), objectDraft()));
    ok(await guarded.submitForReview(ctx(org), record.id, { expectedVersion: 1 }));
    ok(await guarded.returnToDraft(ctx(org), record.id, { expectedVersion: 2 }));
    expect(asked).toEqual([]);

    allow = false;
    expect(codes(await guarded.publish(ctx(org, BOB), record.id, { expectedVersion: 3 }))).toEqual([
      "not_permitted",
    ]);
    expect(asked).toEqual([
      { organizationId: org, actor: BOB, recordId: record.id, change: "publish" },
    ]);
    expect(await stateOf(org, record.id)).toBe("draft");

    allow = true;
    ok(await guarded.publish(ctx(org), record.id, { expectedVersion: 3 }));
    ok(
      await guarded.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: { ...record.fields, note: "Edited." } },
        { expectedVersion: 4 },
      ),
    );
    allow = false;
    asked.length = 0;
    // A restore confirming values public on a published record.
    const restore = await guarded.restoreVersion(ctx(org), record.id, 1, {
      expectedVersion: 5,
      confirmMadePublic: ["note"],
    });
    expect(codes(restore)).toEqual(["not_permitted"]);
    expect(asked.map((a) => a.change)).toEqual(["confirm_made_public"]);
    // A plain edit of a published record needs only the edit permission (D-075).
    ok(
      await guarded.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: { ...record.fields, note: "Edited again." } },
        { expectedVersion: 5 },
      ),
    );
    expect(codes(await guarded.withdraw(ctx(org), record.id, { expectedVersion: 6 }))).toEqual([
      "not_permitted",
    ]);
    expect(await stateOf(org, record.id)).toBe("published");
    // On a record that isn't published, confirming needs no publish permission.
    const draft = ok(await guarded.createRecord(ctx(org), objectDraft()));
    ok(
      await guarded.updateRecord(
        ctx(org),
        draft.record.id,
        { ...draft.record, fields: { ...draft.record.fields, note: "Other." } },
        { expectedVersion: 1 },
      ),
    );
    asked.length = 0;
    ok(
      await guarded.restoreVersion(ctx(org), draft.record.id, 1, {
        expectedVersion: 2,
        confirmMadePublic: ["note"],
      }),
    );
    expect(asked).toEqual([]);
  });

  it("is asked when a published record moves to a template that makes its values public", async () => {
    await ready();
    const org = await organization();
    const asked: string[] = [];
    let allow = false;
    const guarded = createService(s.writer, {
      now: () => NOW,
      mayChangePublicOutput: (_tx, request) => {
        asked.push(request.change);
        return Promise.resolve(
          allow
            ? undefined
            : { ok: false as const, issues: [{ path: [], code: "not_permitted", message: "No." }] },
        );
      },
    });
    const { record } = await create(org, objectDraft());
    allow = true;
    ok(await guarded.publish(ctx(org), record.id, { expectedVersion: 1 }));
    allow = false;
    asked.length = 0;
    const moved = { ...record, templateKey: "pub-object-open" };
    // Without confirming, the move is refused as before (made_public).
    expect(
      codes(await guarded.updateRecord(ctx(org), record.id, moved, { expectedVersion: 2 })),
    ).toEqual(["made_public"]);
    expect(asked).toEqual([]);
    // Confirming on a published record needs the publish permission.
    const options = { expectedVersion: 2, confirmTemplateMove: ["secret"] };
    expect(codes(await guarded.updateRecord(ctx(org), record.id, moved, options))).toEqual([
      "not_permitted",
    ]);
    expect(asked).toEqual(["confirm_made_public"]);
    expect(codes(await publicText(org, record.id)).length).toBe(0);
    expect((await publicText(org, record.id)).text).not.toContain("back room");
    allow = true;
    ok(await guarded.updateRecord(ctx(org), record.id, moved, options));
    expect(await stateOf(org, record.id)).toBe("published");
  });

  it("a hook answering anything but undefined or a refusal is a refusal (fail closed)", async () => {
    await ready();
    const org = await organization();
    const odd = createService(s.writer, {
      mayChangePublicOutput: () => Promise.resolve({ ok: true } as never),
    });
    const { record } = await create(org, objectDraft());
    expect(codes(await odd.publish(ctx(org), record.id, { expectedVersion: 1 }))).toEqual([
      "not_permitted",
    ]);
    expect(await stateOf(org, record.id)).toBe("draft");
  });
});

describe("public output reads what is published from the database (T-034c)", () => {
  it("only a published record has output; unpublished, missing and other organizations' look the same", async () => {
    await ready();
    const org = await organization();
    const other = await organization();
    const { record } = await create(org, objectDraft());
    const theirs = await create(other, objectDraft());
    ok(await service.publish(ctx(other), theirs.record.id, { expectedVersion: 1 }));

    const draft = await publicText(org, record.id);
    const missing = await publicText(org, newRecordId());
    const elsewhere = await publicText(org, theirs.record.id);
    expect(draft).toEqual(missing);
    expect(elsewhere).toEqual(missing);
    expect(codes(draft)).toEqual(["not_available"]);

    ok(await service.submitForReview(ctx(org), record.id, { expectedVersion: 1 }));
    expect(codes(await publicText(org, record.id))).toEqual(["not_available"]);
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 2 }));
    const out = await publicText(org, record.id);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Tin and glass.");
    expect(out.text).not.toContain("back room");
    ok(await service.withdraw(ctx(org), record.id, { expectedVersion: 3 }));
    expect(await publicText(org, record.id)).toEqual(missing);
  });

  it("a link to an unpublished record shows nothing until that record is published", async () => {
    await ready();
    const org = await organization();
    const maker = await create(org, {
      kind: "agent",
      agentType: "person",
      title: "Invented Private Maker",
      templateKey: "pub-agent",
    });
    const { record } = await create(
      org,
      objectDraft({ creator: { recordId: maker.record.id, label: "Invented Private Maker" } }),
    );
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const hidden = await publicText(org, record.id);
    expect(hidden.ok).toBe(true);
    expect(hidden.text).not.toContain(maker.record.id);
    expect(hidden.text).not.toContain("Private Maker");

    ok(await service.publish(ctx(org), maker.record.id, { expectedVersion: 1 }));
    const shown = await publicText(org, record.id);
    expect(shown.text).toContain(`${BASE}${maker.record.id}`);

    // Withdrawn again: the link disappears again.
    ok(await service.withdraw(ctx(org), maker.record.id, { expectedVersion: 2 }));
    const again = await publicText(org, record.id);
    expect(again.text).not.toContain(maker.record.id);
    expect(again.text).not.toContain("Private Maker");
  });

  it("a place's record is linked only when published; the place name is the record's own value (D-048)", async () => {
    await ready();
    const org = await organization();
    const town = await create(org, {
      kind: "place",
      title: "Invented Town",
      templateKey: "pub-place",
      coordinates: { lat: 29.46, lng: -95.05 },
    });
    const { record } = await create(
      org,
      objectDraft({ found_at: { label: "Invented Town", recordId: town.record.id } }),
    );
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect((await publicText(org, record.id)).text).not.toContain(town.record.id);
    ok(await service.publish(ctx(org), town.record.id, { expectedVersion: 1 }));
    expect((await publicText(org, record.id)).text).toContain(town.record.id);
  });

  it("a value inherited from an unpublished parent goes out on a published child, never the parent's title or ID", async () => {
    await ready();
    const org = await organization();
    const fonds = await create(org, {
      kind: "archival_unit",
      level: "fonds",
      title: "Invented Confidential Fonds",
      templateKey: "pub-unit",
      fields: { rights: { uri: INC }, provenance: "Gift of an invented family." },
    });
    const series = await create(org, {
      kind: "archival_unit",
      level: "series",
      parentId: fonds.record.id,
      title: "Invented series",
      templateKey: "pub-unit",
      fields: { rights: { uri: INC } },
    });
    ok(await service.publish(ctx(org), series.record.id, { expectedVersion: 1 }));
    const out = await publicText(org, series.record.id);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Gift of an invented family.");
    expect(out.text).not.toContain("Confidential");
    expect(out.text).not.toContain(fonds.record.id);
    // The parent itself stays unavailable.
    expect(codes(await publicText(org, fonds.record.id))).toEqual(["not_available"]);
  });

  it("a template change after publishing is seen at once: a field made staff stops going out", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect((await publicText(org, record.id)).text).toContain("Tin and glass.");
    ok(
      await insertTemplateVersion(s.owner, {
        key: "pub-object",
        organizationId: org,
        label: "pub-object",
        appliesTo: ["object"],
        fields: OBJECT_FIELDS.map((f) => (f.key === "note" ? { ...f, visibility: "staff" } : f)),
      }),
    );
    const out = await readPublicRecord(s.reader, org, siteFor(org), record.id, {
      baseUrl: BASE,
      mappings: [mapping(org)],
    });
    // The mapping still names the staff field, so output is refused; nothing private goes out.
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Tin and glass.");
  });

  it("reads with the public reader role, which can read no table, and writes nothing", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect((await publicText(org, record.id, s.reader)).ok).toBe(true);
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(2);
    expect(await checkPublicReaderConnection(s.reader)).toEqual([]);
  });
});

describe("public reads by site, with a role that sees only public output (S-019)", () => {
  /** A second site of the organization, with Alice managing it too. */
  async function secondSite(org: OrganizationId): Promise<SiteId> {
    if (folks === undefined || alice === undefined) throw new Error("not ready");
    const site = await makeSite(service, folks.root, org);
    await grant(service, folks.root, org, { userId: alice, role: "site_manager", siteId: site });
    return site;
  }

  it("serves a record only on its home site, answering every other site as a missing record", async () => {
    await ready();
    const org = await organization();
    const other = await secondSite(org);
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    expect((await publicText(org, record.id)).ok).toBe(true);
    const missing = await publicText(org, newRecordId());
    expect(missing.issues.map((i) => i.code)).toEqual(["not_available"]);
    // The attack: the same organization's other public site asks for it.
    expect(await publicText(org, record.id, s.reader, other)).toEqual(missing);
    // Another organization's site, and a site that doesn't exist, the same.
    const elsewhere = await organization();
    expect(await publicText(org, record.id, s.reader, siteOf.get(elsewhere))).toEqual(missing);
    expect(await publicText(elsewhere, record.id, s.reader, siteOf.get(elsewhere))).toEqual(
      missing,
    );
    expect(await publicText(org, record.id, s.reader, newRecordId() as unknown as SiteId)).toEqual(
      missing,
    );
  });

  it("never serves a record that is on no site", async () => {
    await ready();
    const org = await organization();
    if (folks === undefined) throw new Error("not ready");
    const root = { organizationId: org, actor: actorOf(folks.root) };
    const saved = ok(await service.createRecord(root, objectDraft()));
    expect(saved.record.siteId).toBeUndefined();
    ok(await service.publish(root, saved.record.id, { expectedVersion: 1 }));
    expect(await stateOf(org, saved.record.id)).toBe("published");
    expect(codes(await publicText(org, saved.record.id))).toEqual(["not_available"]);
  });

  it("resolves links only to records public on the same site", async () => {
    await ready();
    const org = await organization();
    const other = await secondSite(org);
    const maker = ok(
      await service.createRecord(
        { organizationId: org, actor: ALICE, siteId: other },
        {
          kind: "agent",
          agentType: "person",
          title: "Invented Maker Of The Other Site",
          templateKey: "pub-agent",
        },
      ),
    );
    ok(
      await service.publish({ organizationId: org, actor: ALICE, siteId: other }, maker.record.id, {
        expectedVersion: 1,
      }),
    );
    // Public on the other site (past the site check: only the agent template has no mapping
    // here) and not on this one …
    expect(codes(await publicText(org, maker.record.id, s.reader, other))).toEqual(["no_mapping"]);
    expect(codes(await publicText(org, maker.record.id))).toEqual(["not_available"]);
    // … but a link to it from this site's record shows nothing here.
    if (folks === undefined) throw new Error("not ready");
    const linking = ok(
      await service.createRecord(
        { organizationId: org, actor: actorOf(folks.root), siteId: siteFor(org) },
        objectDraft({
          creator: { recordId: maker.record.id, label: "Invented Maker Of The Other Site" },
        }),
      ),
    );
    ok(await service.publish(ctx(org), linking.record.id, { expectedVersion: 1 }));
    const out = await publicText(org, linking.record.id);
    expect(out.ok).toBe(true);
    expect(out.text).not.toContain(maker.record.id);
    expect(out.text).not.toContain("Other Site");
  });

  it("hands over link targets without their values or titles, and the output is unchanged", async () => {
    await ready();
    const org = await organization();
    const maker = await create(org, {
      kind: "agent",
      agentType: "person",
      title: "Invented Linked Maker",
      templateKey: "pub-agent",
      fields: { note: "AGENT-NOTE-NOT-NEEDED" },
    });
    const { record } = await create(
      org,
      objectDraft({ creator: { recordId: maker.record.id, label: "Invented maker label" } }),
    );
    ok(await service.publish(ctx(org), maker.record.id, { expectedVersion: 1 }));
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const [row] = await s.reader.rows<{ snapshot: unknown }>(sql`
      SELECT public.public_record_snapshot(${org}::uuid, ${siteFor(org)}::uuid,
                                           ${record.id}::uuid) AS snapshot`);
    const raw = JSON.stringify(row?.snapshot);
    expect(raw).toContain(maker.record.id);
    expect(raw).not.toContain("AGENT-NOTE-NOT-NEEDED");
    expect(raw).not.toContain("Invented Linked Maker");
    // The record's own values (staff ones included, for core to sort) are there.
    expect(raw).toContain("Kept in the back room.");
    const out = await publicText(org, record.id);
    expect(out.text).toContain(`${BASE}${maker.record.id}`);
    expect(out.text).toContain("Invented maker label");
    expect(out.text).not.toContain("back room");
  });

  it("gives the public reader no table: it can't read staff data, accounts or sessions", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    for (const query of [
      sql`SELECT fields FROM public.records`,
      sql`SELECT record FROM public.record_versions`,
      sql`SELECT password_hash FROM public.users`,
      sql`SELECT token_hash FROM public.sessions`,
      sql`SELECT 1 FROM public.second_factors`,
      sql`SELECT definition FROM public.template_versions`,
      sql`SELECT 1 FROM public.identifier_holdings`,
    ]) {
      await expect(s.reader.rows(query)).rejects.toMatchObject({ code: "42501" });
    }
    // The staff values of a published record never reach it through the function either.
    expect((await publicText(org, record.id)).text).not.toContain("back room");
    // A role that can SELECT every table is refused as the public reader.
    const problems = await checkPublicReaderConnection(s.staffReader);
    expect(problems.map((p) => p.code)).toContain("extra_privilege");
    // A SECURITY DEFINER function anyone may call is a way around the
    // allowlist (S-019 review): refused until dropped.
    await s.owner.execute(sql`
      CREATE FUNCTION public.t_s019_definer() RETURNS integer
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`);
    try {
      const found = await checkPublicReaderConnection(s.reader);
      expect(found.map((p) => p.code)).toEqual(["security_definer_function"]);
      expect(found[0]?.message).toContain("public.t_s019_definer()");
      expect(found[0]?.message).not.toContain("public_record_snapshot");
    } finally {
      await s.owner.execute(sql`DROP FUNCTION public.t_s019_definer()`);
    }
    expect(await checkPublicReaderConnection(s.reader)).toEqual([]);
    // The writer is refused too: it can read and write tables.
    expect((await checkPublicReaderConnection(s.writer)).map((p) => p.code)).toContain(
      "extra_privilege",
    );
  });
});

describe("publishing never puts out what the publisher can't see (S-020)", () => {
  /** A unit of the organization's site, made by Alice (who manages the whole site). */
  async function unit(
    org: OrganizationId,
    title: string,
    parentId?: RecordId,
    provenance?: string,
  ): Promise<CatalogRecord> {
    return (
      await create(org, {
        kind: "archival_unit",
        level: parentId === undefined ? "fonds" : "series",
        ...(parentId === undefined ? {} : { parentId }),
        title,
        templateKey: "pub-unit",
        fields: {
          rights: { uri: INC },
          ...(provenance === undefined ? {} : { provenance }),
        },
      })
    ).record;
  }

  /** Someone holding `role` only below the given units. */
  async function scopedBelow(
    org: OrganizationId,
    role: string,
    name: string,
    ...units: RecordId[]
  ): Promise<string> {
    if (folks === undefined) throw new Error("not ready");
    const person = await folks.member(org, name);
    for (const scope of units) {
      await grant(service, folks.root, org, { userId: person, role, siteId: siteFor(org), scope });
    }
    return actorOf(person);
  }

  /** Carol: a reviewer (who may publish) only below the given units. */
  const reviewerBelow = (org: OrganizationId, ...units: RecordId[]) =>
    scopedBelow(org, "reviewer", "Carol", ...units);

  async function file(org: OrganizationId, parentId: RecordId): Promise<CatalogRecord> {
    return (
      await create(org, {
        kind: "archival_unit",
        level: "file",
        parentId,
        title: "Invented file",
        templateKey: "pub-unit",
        fields: { rights: { uri: INC } },
      })
    ).record;
  }

  /** The series's own provenance dropped by `actor`: the review's repro (S-020, second review). */
  async function dropProvenance(org: OrganizationId, actor: string, series: CatalogRecord) {
    const rest = Object.fromEntries(
      Object.entries(series.fields).filter(([key]) => key !== "provenance"),
    );
    return service.updateRecord(
      ctx(org, actor),
      series.id,
      { ...series, fields: rest },
      { expectedVersion: 1 },
    );
  }

  it("refuses a scoped reviewer dropping a draft series's value so a published file inherits a hidden fonds's (the review's repro)", async () => {
    await ready();
    const org = await organization();
    const fonds = await unit(org, "Invented Fonds", undefined, "FONDS-SECRET");
    const series = await unit(org, "Invented series", fonds.id, "Invented series provenance.");
    const x = await file(org, series.id);
    const dave = await scopedBelow(org, "reviewer", "Dave", series.id);
    // Dave may publish the file: its only source is the series he sees.
    ok(await service.publish(ctx(org, dave), x.id, { expectedVersion: 1 }));
    expect((await publicText(org, x.id)).text).toContain("Invented series provenance.");
    const dropped = await dropProvenance(org, dave, series);
    expect(codes(dropped)).toEqual(["inherits_from_hidden"]);
    expect(JSON.stringify(dropped)).not.toContain(fonds.id);
    const out = await publicText(org, x.id);
    expect(out.text).toContain("Invented series provenance.");
    expect(out.text).not.toContain("FONDS-SECRET");
    // Unrelated edits of the series still pass: a new title, a new value of its own.
    ok(
      await service.updateRecord(
        ctx(org, dave),
        series.id,
        {
          ...series,
          title: "Invented series, renamed",
          fields: { ...series.fields, provenance: "A new series provenance." },
        },
        { expectedVersion: 1 },
      ),
    );
    expect((await publicText(org, x.id)).text).toContain("A new series provenance.");
  });

  it("refuses a scoped cataloger the same edit", async () => {
    await ready();
    const org = await organization();
    const fonds = await unit(org, "Invented Fonds", undefined, "FONDS-SECRET");
    const series = await unit(org, "Invented series", fonds.id, "Invented series provenance.");
    const x = await file(org, series.id);
    ok(await service.publish(ctx(org), x.id, { expectedVersion: 1 }));
    const carl = await scopedBelow(org, "cataloger", "Carl", series.id);
    expect(codes(await dropProvenance(org, carl, series))).toEqual(["inherits_from_hidden"]);
    expect((await publicText(org, x.id)).text).not.toContain("FONDS-SECRET");
    // Alice, who sees the fonds, may.
    ok(await dropProvenance(org, ALICE, series));
    expect((await publicText(org, x.id)).text).toContain("FONDS-SECRET");
  });

  it("compares (field, source) pairs: a hidden fonds already giving one field can't start giving another", async () => {
    await ready();
    const org = await organization();
    ok(
      await insertTemplateVersion(s.owner, {
        key: "pub-unit-two",
        organizationId: org,
        label: "pub-unit-two",
        appliesTo: ["archival_unit"],
        fields: [
          field("rights", "rights"),
          field("provenance", "text", { inherited: true }),
          field("history", "text", { inherited: true }),
        ],
      }),
    );
    const make = async (draft: Record<string, unknown>) => (await create(org, draft)).record;
    const fonds = await make({
      kind: "archival_unit",
      level: "fonds",
      title: "Invented Fonds",
      templateKey: "pub-unit-two",
      fields: { rights: { uri: INC }, provenance: "FONDS-SECRET", history: "Invented history." },
    });
    const series = await make({
      kind: "archival_unit",
      level: "series",
      parentId: fonds.id,
      title: "Invented series",
      templateKey: "pub-unit-two",
      fields: { rights: { uri: INC }, provenance: "Invented series provenance." },
    });
    const x = await make({
      kind: "archival_unit",
      level: "file",
      parentId: series.id,
      title: "Invented file",
      templateKey: "pub-unit-two",
      fields: { rights: { uri: INC } },
    });
    // Published by Alice: history from the fonds, provenance from the series.
    ok(await service.publish(ctx(org), x.id, { expectedVersion: 1 }));
    const dave = await scopedBelow(org, "reviewer", "Dave", series.id);
    expect(codes(await dropProvenance(org, dave, series))).toEqual(["inherits_from_hidden"]);
    // A change that keeps every pair passes.
    ok(
      await service.updateRecord(
        ctx(org, dave),
        series.id,
        { ...series, title: "Invented series, renamed" },
        { expectedVersion: 1 },
      ),
    );
  });

  it("refuses a scoped reviewer publishing a unit that inherits public values from a unit above their scope", async () => {
    await ready();
    const org = await organization();
    const fonds = await unit(
      org,
      "Invented Hidden Fonds",
      undefined,
      "Invented hidden provenance.",
    );
    const series = await unit(org, "Invented series", fonds.id);
    const carol = await reviewerBelow(org, series.id);
    const refused = await service.publish(ctx(org, carol), series.id, { expectedVersion: 1 });
    expect(codes(refused)).toEqual(["inherits_from_hidden"]);
    expect(JSON.stringify(refused)).not.toContain(fonds.id);
    expect(JSON.stringify(refused)).not.toContain("Hidden");
    expect(await stateOf(org, series.id)).toBe("draft");
    expect(codes(await publicText(org, series.id))).toEqual(["not_available"]);
    // Someone who can see the fonds may publish it, with the inherited value.
    ok(await service.publish(ctx(org), series.id, { expectedVersion: 1 }));
    expect((await publicText(org, series.id)).text).toContain("Invented hidden provenance.");
  });

  it("lets the scoped reviewer publish when nothing public comes from above their scope", async () => {
    await ready();
    const org = await organization();
    const fonds = await unit(org, "Invented Plain Fonds");
    const series = await unit(org, "Invented series", fonds.id);
    const carol = await reviewerBelow(org, series.id);
    ok(await service.publish(ctx(org, carol), series.id, { expectedVersion: 1 }));
    expect(await stateOf(org, series.id)).toBe("published");
  });

  it("refuses an edit of a published record that makes it inherit from a record the editor can't see", async () => {
    await ready();
    const org = await organization();
    const first = await unit(org, "Invented First Fonds", undefined, "Invented first provenance.");
    const second = await unit(
      org,
      "Invented Second Fonds",
      undefined,
      "Invented second provenance.",
    );
    const seriesA = await unit(org, "Invented series A", first.id);
    const seriesB = await unit(org, "Invented series B", second.id);
    const file = (
      await create(org, {
        kind: "archival_unit",
        level: "file",
        parentId: seriesA.id,
        title: "Invented file",
        templateKey: "pub-unit",
        fields: { rights: { uri: INC } },
      })
    ).record;
    // Published by Alice, who sees everything: it shows the first fonds' provenance.
    ok(await service.publish(ctx(org), file.id, { expectedVersion: 1 }));
    const carol = await reviewerBelow(org, seriesA.id, seriesB.id);
    // An edit that keeps the same sources is fine for Carol.
    ok(
      await service.updateRecord(
        ctx(org, carol),
        file.id,
        { ...file, title: "Invented file, renamed" },
        { expectedVersion: 2 },
      ),
    );
    // Moving it under series B would put out the second fonds' value, which she can't see.
    const moved = await service.updateRecord(
      ctx(org, carol),
      file.id,
      { ...file, title: "Invented file, renamed", parentId: seriesB.id },
      { expectedVersion: 3 },
    );
    expect(codes(moved)).toEqual(["inherits_from_hidden"]);
    const out = await publicText(org, file.id);
    expect(out.text).toContain("Invented first provenance.");
    expect(out.text).not.toContain("second provenance");
    // Alice may move it.
    ok(
      await service.updateRecord(
        ctx(org),
        file.id,
        { ...file, title: "Invented file, renamed", parentId: seriesB.id },
        { expectedVersion: 3 },
      ),
    );
    expect((await publicText(org, file.id)).text).toContain("Invented second provenance.");
  });
});

describe("races", () => {
  it("a publish and an edit from the same version: one wins, the other is a version conflict", async () => {
    await ready();
    const org = await organization();
    for (let round = 0; round < 4; round++) {
      const { record } = await create(org, objectDraft());
      const [published, edited] = await Promise.all([
        service.publish(ctx(org), record.id, { expectedVersion: 1 }),
        service2.updateRecord(
          ctx(org, BOB),
          record.id,
          { ...record, fields: { note: "No rights now." } },
          { expectedVersion: 1 },
        ),
      ]);
      expect([published.ok, edited.ok].filter(Boolean)).toHaveLength(1);
      const loser = published.ok ? edited : published;
      expect(codes(loser)).toEqual(["version_conflict"]);
      const state = await stateOf(org, record.id);
      expect(state).toBe(published.ok ? "published" : "draft");
      // Whichever won, a published record passes the check.
      if (published.ok) expect((await publicText(org, record.id)).ok).toBe(true);
    }
  });

  it("an edit that waits for a publish is re-checked against the published state", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const without = Object.fromEntries(
      Object.entries(record.fields).filter(([k]) => k !== "rights"),
    );
    const [a, b] = await Promise.all([
      service.updateRecord(
        ctx(org),
        record.id,
        { ...record, fields: without },
        { expectedVersion: 2 },
      ),
      service2.withdraw(ctx(org, BOB), record.id, { expectedVersion: 2 }),
    ]);
    // The edit never lands while the record is published: either the
    // withdrawal ran first (the edit conflicts), or the edit ran first while
    // published and the publish check refused it. The withdrawal always lands.
    expect(b.ok).toBe(true);
    expect(["version_conflict", "published_record_check"]).toContain(codes(a)[0]);
    expect(ok(await readVersions(s.owner, org, record.id)).versions.map((v) => v.action)).toEqual([
      "save",
      "publish",
      "withdraw",
    ]);
  });

  it("a template change making a field staff, racing a publish, is waited for and seen", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    // The template change holds the template's exclusive lock until it commits.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const changing = s.owner.transaction(async (q) => {
      ok(
        await insertTemplateVersion(q, {
          key: "pub-object",
          organizationId: org,
          label: "pub-object",
          appliesTo: ["object"],
          fields: OBJECT_FIELDS.filter((f) => f.key !== "rights"),
        }),
      );
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    const publishing = service.publish(ctx(org), record.id, { expectedVersion: 1 });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await changing;
    const result = await publishing;
    // The publish waited for the new template, under which rights are staff.
    expect(result.ok).toBe(false);
    expect(await stateOf(org, record.id)).toBe("draft");
  });
});

describe("the database refuses every other change of state, for every writer", () => {
  it("core's moves and the database's are the same table", async () => {
    await ready();
    for (const action of WORKFLOW_ACTIONS) {
      for (const from of WORKFLOW_STATES) {
        for (const to of WORKFLOW_STATES) {
          const core = workflowTransition(from, to);
          const coreAllows = core.ok && core.value.action === action;
          const [row] = await s.owner.rows<{ allowed: boolean }>(
            sql`SELECT public.workflow_move_allowed(${action}, ${from}, ${to}) AS allowed`,
          );
          expect([action, from, to, row?.allowed]).toEqual([action, from, to, coreAllows]);
        }
      }
    }
  });

  async function directly(
    org: OrganizationId,
    id: RecordId,
    statements: (q: Queryable) => Promise<void>,
  ) {
    return refusal(s.writer.transaction(statements));
  }

  it("the writer can't change a state without its version, by a save, or along a move that doesn't exist", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    const bump = (state: string) => sql`
      UPDATE public.records SET workflow_state = ${state}, version = version + 1 WHERE ${where}`;
    const version = (action: string) => sql`
      INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
      SELECT organization_id, id, version, public.record_snapshot(r), 'system:direct_sql', ${action}
      FROM public.records r WHERE ${where}`;

    // No version at all: refused at COMMIT.
    expect(
      await directly(org, record.id, async (q) => {
        await q.execute(bump("published"));
      }),
    ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
    // A save can't change the state.
    expect(
      await directly(org, record.id, async (q) => {
        await q.execute(bump("published"));
        await q.execute(version("save"));
      }),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_workflow_move" });
    // A workflow action along a move that doesn't exist.
    expect(
      await directly(org, record.id, async (q) => {
        await q.execute(bump("withdrawn"));
        await q.execute(version("publish"));
      }),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_workflow_move" });
    // A publish that also changes the record.
    expect(
      await directly(org, record.id, async (q) => {
        await q.execute(sql`
          UPDATE public.records SET workflow_state = 'published', title = 'Changed',
            version = version + 1 WHERE ${where}`);
        await q.execute(version("publish"));
      }),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_workflow_move" });
    // A new record can't start published.
    const id = newRecordId();
    expect(
      await refusal(
        s.writer.transaction(async (q) => {
          await q.execute(sql`
            INSERT INTO public.records (id, organization_id, kind, template_key, title, fields,
              created_at, updated_at, version, workflow_state)
            VALUES (${id}::uuid, ${org}::uuid, 'object', 'pub-object', 'Invented', '{}',
              date_trunc('milliseconds', now()), date_trunc('milliseconds', now()), 1, 'published')`);
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
            SELECT organization_id, id, 1, public.record_snapshot(r), 'system:direct_sql'
            FROM public.records r WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`);
        }),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_workflow_move" });
    // An unknown state is refused by its CHECK.
    expect((await refusal(s.writer.transaction((q) => q.execute(bump("live"))))).code).toBe(
      "23514",
    );
    // A version can't name a state of its own: the database fills it in.
    expect(
      await directly(org, record.id, async (q) => {
        await q.execute(bump("draft"));
        await q.execute(sql`
          INSERT INTO public.record_versions (organization_id, record_id, version, record, actor,
                                              workflow_state)
          SELECT organization_id, id, version, public.record_snapshot(r), 'system:direct_sql',
                 'published'
          FROM public.records r WHERE ${where}`);
        const [row] = await q.rows<{ s: string }>(sql`
          SELECT workflow_state AS s FROM public.record_versions WHERE organization_id = ${org}::uuid
            AND record_id = ${record.id}::uuid ORDER BY version DESC LIMIT 1`);
        if (row?.s === "draft") throw Object.assign(new Error("filled"), { code: "filled" });
      }),
    ).toEqual({ code: "filled" });
    expect(await stateOf(org, record.id)).toBe("draft");
    expect(ok(await readVersions(s.owner, org, record.id)).versions).toHaveLength(1);
  });

  it("the writer can't delete a published record, even with a tombstone", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    ok(await service.publish(ctx(org), record.id, { expectedVersion: 1 }));
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    expect(
      await refusal(
        s.writer.transaction(async (q) => {
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor,
                                                action)
            SELECT organization_id, id, version + 1, public.record_snapshot(r),
                   'system:direct_sql', 'delete'
            FROM public.records r WHERE ${where}`);
          await q.execute(sql`DELETE FROM public.records WHERE ${where}`);
        }),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_delete_published" });
    expect(await stateOf(org, record.id)).toBe("published");
  });

  it("the rules hold in replica mode too (every trigger ALWAYS)", async () => {
    await ready();
    const org = await organization();
    const { record } = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    const superuser = openDatabase(s.testDb.url, { max: 1 });
    try {
      const found = await refusal(
        superuser.transaction(async (q) => {
          await q.rows(sql`SELECT set_config('session_replication_role', 'replica', true)`);
          await q.execute(sql`
            UPDATE public.records SET workflow_state = 'published', version = version + 1
            WHERE ${where}`);
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
            SELECT organization_id, id, version, public.record_snapshot(r), 'system:direct_sql'
            FROM public.records r WHERE ${where}`);
        }),
      );
      expect(found).toEqual({ code: IDENTITY, constraint: "record_versions_workflow_move" });
      const notAlways = await superuser.rows(sql`
        SELECT tg.tgname FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND tg.tgenabled <> 'A'`);
      expect(notAlways).toEqual([]);
    } finally {
      await superuser.close();
    }
    expect(await stateOf(org, record.id)).toBe("draft");
  });

  it("the writer role still holds exactly WRITER_PRIVILEGES: its check finds nothing", async () => {
    await ready();
    expect(await checkWriterConnection(s.writer)).toEqual([]);
    expect(await service.checkConnection()).toEqual([]);
    // Nothing new was granted for workflow states: records and record_versions as before.
    expect(WRITER_PRIVILEGES.records).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(WRITER_PRIVILEGES.record_versions).toEqual(["INSERT"]);
  });
});
