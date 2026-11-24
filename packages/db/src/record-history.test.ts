// Comparing and restoring record versions (record-versions.ts compareVersions,
// record-restore.ts, T-030) and edit-conflict protection (updateRecord's
// conflict, T-031), D-065. Conflicts are tested with two connections.
import { afterAll, describe, expect, it } from "vitest";
import {
  createRecord,
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type FieldTemplate,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import { openDatabase, type Database, type Queryable } from "./client.js";
import {
  insertOrganization,
  insertRecord,
  insertRecordTypeVersion,
  insertTemplateVersion,
  readStoredRecord,
  updateRecord,
  type RecordUpdateResult,
} from "./catalog.js";
import {
  insertIdentifierType,
  readRecordIdentifiers,
  saveRecordIdentifiers,
} from "./identifiers.js";
import { migrate } from "./migrate.js";
import { restoreReason, restoreVersion, type RestoreOptions } from "./record-restore.js";
import { compareVersions, readVersion, readVersions } from "./record-versions.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:30:00.250Z";
const LATEST = "2026-11-22T10:00:00.000Z";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const AFTER_NOW = "2026-11-24T08:00:00.000Z";
const ALICE = "user:3f1c2a9e-8b7d-4c6e-9a5b-1d2e3f4a5b6c";
const BOB = "user:9b2e4c1a-7d3f-4e8a-b5c6-1a2b3c4d5e6f";
const IN_COPYRIGHT = "http://rightsstatements.org/vocab/InC/1.0/";
const POLL_LIMIT_MS = 10_000;

// ---------------------------------------------------------------------------
// One migrated database for the file, and a second connection pool to it.

let setup: Promise<{ testDb: TestDatabase; db: Database; other: Database }> | undefined;
let db: Database;
let other: Database;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    return {
      testDb,
      db: openDatabase(testDb.url, { max: 4 }),
      other: openDatabase(testDb.url, { max: 2 }),
    };
  })();
  ({ db, other } = await setup);
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
    await done.other.close();
    await done.testDb.drop();
  }
});

function ok<T>(result: Validated<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown> | undefined): string[] {
  if (result === undefined) throw new Error("not found");
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function field(
  key: string,
  kind: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    label: key,
    kind,
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    ...extra,
  };
}

function objectTemplate(org: OrganizationId, extra: Record<string, unknown>[] = []): FieldTemplate {
  return {
    key: "invented-object",
    organizationId: org,
    label: "Invented objects",
    appliesTo: ["object"],
    fields: [
      field("note", "text"),
      field("number", "identifier"),
      field("creator", "record_link", { recordKinds: ["agent"] }),
      field("rights", "rights", { visibility: "public" }),
      ...extra,
    ],
  } as unknown as FieldTemplate;
}

/** A new organization with its templates and an identifier type. */
async function organization(): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(db, { id: org, name: "Invented Society" }));
  ok(await insertTemplateVersion(db, objectTemplate(org)));
  for (const [key, kind] of [
    ["invented-unit", "archival_unit"],
    ["invented-agent", "agent"],
    ["invented-asset", "digital_asset"],
  ] as const) {
    ok(
      await insertTemplateVersion(db, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields: [field("note", "text")],
      }),
    );
  }
  ok(
    await tx((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "object_number",
        label: "Object number",
        uniqueness: "current",
      }),
    ),
  );
  return org;
}

function tx<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

function object(org: OrganizationId, fields: Record<string, unknown> = {}): CatalogRecord {
  return ok(
    createRecord(
      {
        organizationId: org,
        kind: "object",
        title: "An invented chair",
        templateKey: "invented-object",
        fields: { note: "Oak.", ...fields },
      },
      new Date(T),
    ),
  );
}

function unit(
  org: OrganizationId,
  level: "fonds" | "series" | "collection" | "file" | "item",
  parentId?: RecordId,
): CatalogRecord {
  return ok(
    createRecord(
      {
        organizationId: org,
        kind: "archival_unit",
        level,
        title: `An invented ${level}`,
        templateKey: "invented-unit",
        ...(parentId === undefined ? {} : { parentId }),
      },
      new Date(T),
    ),
  );
}

async function insert(record: CatalogRecord): Promise<CatalogRecord> {
  ok(await tx((q) => insertRecord(q, record, { actor: ALICE })));
  return record;
}

/** Saves `next` over the stored record from `expected`, by `actor`. */
function save(
  next: CatalogRecord,
  expected: number,
  actor = ALICE,
  on: Database = db,
): Promise<RecordUpdateResult> {
  return on.transaction((q) => updateRecord(q, next, { expectedVersion: expected, actor }));
}

function restore(
  org: OrganizationId,
  id: RecordId,
  version: number,
  expected: number,
  reason?: string,
  options: { confirmMadePublic?: readonly string[] } = {},
  on: Database = db,
): Promise<RecordUpdateResult> {
  return on.transaction((q) =>
    restoreVersion(
      q,
      org,
      id,
      version,
      { expectedVersion: expected, actor: BOB, ...(reason === undefined ? {} : { reason }) },
      { now: NOW, ...options },
    ),
  );
}

function paths(result: Validated<unknown>): string[][] {
  return result.ok ? [] : result.issues.map((i) => [i.path.join("."), i.code]);
}

async function versionCount(org: OrganizationId, id: RecordId): Promise<number> {
  return ok(await readVersions(db, org, id)).versions.length;
}

/** Waits until a session of the test database is waiting on a lock. */
async function someoneWaits(): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    const [row] = await db.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nobody waited on a lock.");
}

// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("compares two stored versions field by field, either way round, as changedFields names them", async () => {
    await ready();
    const org = await organization();
    const first = await insert(object(org));
    const second = { ...first, title: "An invented oak chair", updatedAt: LATER };
    ok(await save({ ...second, fields: { rights: { uri: IN_COPYRIGHT } } }, 1));
    const v2 = ok(await readVersion(db, org, first.id, 2));

    const forward = ok(await compareVersions(db, org, first.id, 1, 2));
    expect(forward.differences.map((d) => d.name)).toEqual(v2.changedFields);
    expect(forward.differences).toEqual([
      { name: "fields.note", change: "removed", before: "Oak." },
      { name: "fields.rights", change: "added", after: { uri: IN_COPYRIGHT } },
      {
        name: "title",
        change: "changed",
        before: "An invented chair",
        after: "An invented oak chair",
      },
    ]);
    const back = ok(await compareVersions(db, org, first.id, 2, 1));
    expect(back.differences.map((d) => d.change)).toEqual(["added", "removed", "changed"]);
    expect(ok(await compareVersions(db, org, first.id, 2, 2)).differences).toEqual([]);
  });

  it("finds nothing for an unknown version, another organization's record or bad input", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    expect(codes(await compareVersions(db, org, record.id, 1, 2))).toEqual(["unknown_version"]);
    const stranger = await organization();
    expect(codes(await compareVersions(db, stranger, record.id, 1, 1))).toEqual([
      "unknown_version",
    ]);
    expect(codes(await compareVersions(db, org, record.id, 0, 1))).toEqual(["invalid_version"]);
    expect(codes(await compareVersions(db, org, "nope" as RecordId, 1, 1))).toEqual(["invalid_id"]);
    expect(codes(await compareVersions(db, "nope" as OrganizationId, record.id, 1, 1))).toEqual([
      "invalid_organization",
    ]);
  });
});

describe("edit conflicts (T-031)", () => {
  it("refuses a save from an older version and says what the other person changed", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    // Alice and Bob both open version 1. Bob saves first, on his own connection.
    ok(await save({ ...record, title: "Bob's title", updatedAt: LATER }, 1, BOB, other));
    const alice = await save(
      { ...record, fields: { note: "Alice's note." }, updatedAt: LATER },
      1,
      ALICE,
    );
    expect(codes(alice)).toEqual(["version_conflict"]);
    expect(alice.ok ? undefined : alice.conflict).toEqual({
      expectedVersion: 1,
      currentVersion: 2,
      differences: [{ name: "title", change: "changed" }],
    });
    // Nothing of Alice's was stored.
    expect(await versionCount(org, record.id)).toBe(2);
    expect(ok(await readStoredRecord(db, org, record.id)).record.fields).toEqual({ note: "Oak." });
  });

  it("a save waiting on another's uncommitted save gets the conflict once it commits", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let written: () => void = () => undefined;
    const bobWrote = new Promise<void>((resolve) => (written = resolve));
    const first = other.transaction(async (q) => {
      const saved = await updateRecord(
        q,
        { ...record, fields: { note: "Walnut." }, updatedAt: LATER },
        { expectedVersion: 1, actor: BOB },
      );
      written();
      await held;
      return saved;
    });
    // Bob's update holds the row, uncommitted; Alice saves from version 1.
    await bobWrote;
    const second = save({ ...record, title: "Alice's title", updatedAt: LATER }, 1, ALICE);
    await someoneWaits();
    release();
    ok(await first);
    const alice = await second;
    expect(codes(alice)).toEqual(["version_conflict"]);
    expect(alice.ok ? undefined : alice.conflict).toEqual({
      expectedVersion: 1,
      currentVersion: 2,
      differences: [{ name: "fields.note", change: "changed" }],
    });
    expect(await versionCount(org, record.id)).toBe(2);
  });

  it("lists every change across several versions, and none for a version not yet written", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    ok(await save({ ...record, title: "Two", updatedAt: LATER }, 1, BOB, other));
    ok(await save({ ...record, title: "Three", fields: {}, updatedAt: LATEST }, 2, BOB, other));
    const stale = await save({ ...record, updatedAt: LATEST }, 1);
    expect(stale.ok ? undefined : stale.conflict?.differences?.map((d) => d.name)).toEqual([
      "fields.note",
      "title",
    ]);
    const ahead = await save({ ...record, updatedAt: LATEST }, 7);
    expect(codes(ahead)).toEqual(["version_conflict"]);
    expect(ahead.ok ? undefined : ahead.conflict).toEqual({
      expectedVersion: 7,
      currentVersion: 3,
    });
  });

  it("other refusals carry no conflict", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    const missing = await save({ ...record, id: newRecordId() }, 1);
    expect(codes(missing)).toEqual(["unknown_record"]);
    expect(missing.ok || "conflict" in missing).toBe(false);
    const backwards = await save(
      { ...record, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: LATER },
      1,
    );
    expect(codes(backwards)).toEqual(["created_at_changed"]);
    expect(backwards.ok || "conflict" in backwards).toBe(false);
  });
});

describe("restoreVersion (T-030)", () => {
  it("writes a new version equal to the old one, keeping every version", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org, { rights: { uri: IN_COPYRIGHT } }));
    ok(await save({ ...record, title: "Renamed", fields: { note: "Pine." }, updatedAt: LATER }, 1));
    // The rights statement would come back into a public field: confirmed first.
    expect(paths(await restore(org, record.id, 1, 2))).toEqual([
      ["fields.rights", "public_field_restored"],
    ]);
    const restored = ok(
      await restore(org, record.id, 1, 2, undefined, { confirmMadePublic: ["rights"] }),
    );
    expect(restored.version).toBe(3);
    expect(restored.actor).toBe(BOB);
    expect(restored.reason).toBe("restored version 1");
    expect(restored.changedFields).toEqual(["fields.note", "fields.rights", "title"]);
    // The content is version 1's; updatedAt is the later of the stored one and now.
    expect(restored.record).toEqual({ ...record, updatedAt: NOW.toISOString() });
    expect(ok(await compareVersions(db, org, record.id, 1, 3)).differences).toEqual([]);
    expect(ok(await readVersions(db, org, record.id)).versions.map((v) => v.version)).toEqual([
      1, 2, 3,
    ]);
    const current = ok(await readStoredRecord(db, org, record.id));
    expect(current.version).toBe(3);
    expect(current.record.title).toBe("An invented chair");
  });

  it("keeps updatedAt when the stored one is later than now, and appends the person's reason", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    const future = "2099-01-01T00:00:00.000Z";
    ok(await save({ ...record, title: "Renamed", updatedAt: future }, 1));
    const restored = ok(await restore(org, record.id, 1, 2, "The rename was a mistake."));
    expect(restored.record.updatedAt).toBe(future);
    expect(restored.reason).toBe("restored version 1: The rename was a mistake.");
    expect(restoreReason(4)).toBe("restored version 4");
  });

  it("refuses what has nothing to restore, a stale view, and unknown or foreign records", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    expect(codes(await restore(org, record.id, 1, 1))).toEqual(["no_changes"]);
    ok(await save({ ...record, title: "Renamed", updatedAt: LATER }, 1));
    ok(await save({ ...record, updatedAt: LATEST }, 2));
    // Version 3 has version 1's content again.
    expect(codes(await restore(org, record.id, 1, 3))).toEqual(["no_changes"]);
    expect(codes(await restore(org, record.id, 9, 3))).toEqual(["unknown_version"]);
    // A person looking at version 2 restores: someone saved since.
    const stale = await restore(org, record.id, 2, 2);
    expect(codes(stale)).toEqual(["version_conflict"]);
    expect(stale.ok ? undefined : stale.conflict).toEqual({
      expectedVersion: 2,
      currentVersion: 3,
      differences: [{ name: "title", change: "changed" }],
    });
    const stranger = await organization();
    expect(codes(await restore(stranger, record.id, 1, 3))).toEqual(["unknown_record"]);
    expect(codes(await restore(org, newRecordId(), 1, 1))).toEqual(["unknown_record"]);
    expect(codes(await restore(org, record.id, 0, 3))).toEqual(["invalid_version"]);
    expect(codes(await restore(org, record.id, 1, 1.5))).toEqual(["invalid_version"]);
    expect(
      codes(
        await tx((q) =>
          restoreVersion(q, org, record.id, 2, { expectedVersion: 3, actor: "nobody" }),
        ),
      ),
    ).toEqual(["invalid_actor"]);
    expect(codes(await restore(org, record.id, 2, 3, "x".repeat(2000)))).toEqual([
      "invalid_reason",
    ]);
    expect(await versionCount(org, record.id)).toBe(3);
    await expect(
      restoreVersion(db, org, record.id, 2, { expectedVersion: 3, actor: BOB }),
    ).rejects.toThrow(/inside a transaction/);
  });

  it("checks the old content against today's template, reporting instead of saving", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org, { extra: "Kept then." }));
    ok(await save({ ...record, fields: { note: "Now." }, updatedAt: LATER }, 1));
    // The template changes: `extra` was never in it, and `maker` becomes required.
    ok(
      await insertTemplateVersion(
        db,
        objectTemplate(org, [field("maker", "text", { required: true })]),
      ),
    );
    const result = await restore(org, record.id, 1, 2);
    expect(result.ok ? [] : result.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["fields.extra", "unknown_field"],
      ["fields.maker", "required"],
    ]);
    expect(await versionCount(org, record.id)).toBe(2);
  });

  it("runs the rights check: a statement no longer accepted is reported", async () => {
    await ready();
    const org = await organization();
    // Stored before today's check (insertRecord checks the shape only): the
    // https spelling is not the canonical URI.
    const record = await insert(
      object(org, { rights: { uri: "https://rightsstatements.org/vocab/InC/1.0/" } }),
    );
    ok(await save({ ...record, fields: { note: "Oak." }, updatedAt: LATER }, 1));
    const result = await restore(org, record.id, 1, 2);
    expect(result.ok ? [] : result.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["fields.rights.uri", "not_canonical"],
      ["fields.rights", "public_field_restored"],
    ]);
  });

  it("restores identifier fields only while the record still holds the number, and never touches its numbers", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org, { number: { type: "object_number", value: "INV-1" } }));
    const numbers = (current: string, former: string[] = []) => ({
      recordId: record.id,
      organizationId: org,
      current: [{ type: "object_number", value: current, primary: true }],
      former: former.map((value) => ({ type: "object_number", value })),
    });
    ok(await tx((q) => saveRecordIdentifiers(q, numbers("INV-1"))));
    // Renumbered: INV-1 retired, INV-2 shown.
    ok(await tx((q) => saveRecordIdentifiers(q, numbers("INV-2", ["INV-1"]))));
    ok(
      await save(
        {
          ...record,
          fields: { note: "Oak.", number: { type: "object_number", value: "INV-2" } },
          updatedAt: LATER,
        },
        1,
      ),
    );
    const before = ok(await readRecordIdentifiers(db, org, record.id));
    const refused = await restore(org, record.id, 1, 2);
    expect(refused.ok ? [] : refused.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["fields.number", "identifier_not_held"],
    ]);
    expect(ok(await readRecordIdentifiers(db, org, record.id))).toEqual(before);
    // Once INV-1 is current again (through the identifier save), version 1 restores.
    ok(await tx((q) => saveRecordIdentifiers(q, numbers("INV-1", ["INV-2"]))));
    const after = ok(await readRecordIdentifiers(db, org, record.id));
    ok(await restore(org, record.id, 1, 2));
    expect(ok(await readRecordIdentifiers(db, org, record.id))).toEqual(after);
  });

  it("checks record links against the organization's records as they are now", async () => {
    await ready();
    const org = await organization();
    const agent = await insert(
      ok(
        createRecord(
          {
            organizationId: org,
            kind: "agent",
            agentType: "person",
            title: "An invented maker",
            templateKey: "invented-agent",
          },
          new Date(T),
        ),
      ),
    );
    const stranger = await organization();
    const foreign = await insert({ ...object(stranger), id: newRecordId() });
    for (const target of [agent.id, foreign.id, newRecordId()]) {
      const record = await insert(object(org, { creator: { recordId: target, label: "Maker" } }));
      ok(await save({ ...record, fields: {}, updatedAt: LATER }, 1));
      const result = await restore(org, record.id, 1, 2);
      if (target === agent.id) {
        ok(result);
      } else {
        // Another organization's record is "not found", like one that never existed.
        expect(result.ok ? [] : result.issues.map((i) => [i.path.join("."), i.code])).toEqual([
          ["fields.creator.recordId", "unknown_record"],
        ]);
      }
    }
  });

  it("checks the arrangement: a parent that is gone, a loop, and children that no longer fit", async () => {
    await ready();
    const org = await organization();
    // Gone: the series was filed under a fonds since deleted (by the owner).
    const fonds = await insert(unit(org, "fonds"));
    const series = await insert(unit(org, "series", fonds.id));
    ok(await save({ ...withoutParent(series), updatedAt: LATER }, 1));
    await tx((q) =>
      q.execute(sql`DELETE FROM public.records WHERE organization_id = ${org}::uuid
                    AND id = ${fonds.id}::uuid`),
    );
    expect(codes(await restore(org, series.id, 1, 2))).toEqual(["missing_parent"]);

    // A loop: B was under A; then A was filed under B.
    const a = await insert(unit(org, "series"));
    const b = await insert(unit(org, "series", a.id));
    ok(await save({ ...withoutParent(b), updatedAt: LATER }, 1));
    ok(await save({ ...a, parentId: b.id, updatedAt: LATER } as CatalogRecord, 1));
    expect(codes(await restore(org, b.id, 1, 2))).toEqual(["loop"]);

    // A level that can't hold its children now: the file was an item once.
    const item = await insert(unit(org, "item"));
    ok(await save({ ...item, level: "file", updatedAt: LATER } as CatalogRecord, 1));
    await insert(unit(org, "item", item.id));
    const level = await restore(org, item.id, 1, 2);
    expect(level.ok ? [] : level.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["level", "wrong_level"],
    ]);

    // And one that still fits restores.
    const top = await insert(unit(org, "fonds"));
    const filed = await insert(unit(org, "file", top.id));
    ok(await save({ ...withoutParent(filed), updatedAt: LATER }, 1));
    ok(await restore(org, filed.id, 1, 2));
    expect(ok(await readStoredRecord(db, org, filed.id)).record).toMatchObject({
      parentId: top.id,
    });
  });

  it("refuses a parent that would make the tree too deep", async () => {
    await ready();
    const org = await organization();
    // A chain of 62 series, a series at depth 63 with one sub-series below
    // it (64, the limit), moved to the top, where it gains a sub-sub-series.
    let parent: RecordId | undefined;
    for (let i = 0; i < 62; i += 1) parent = (await insert(unit(org, "series", parent))).id;
    const moved = await insert(unit(org, "series", parent));
    const child = await insert(unit(org, "series", moved.id));
    ok(await save({ ...withoutParent(moved), updatedAt: LATER }, 1));
    await insert(unit(org, "series", child.id));
    expect(codes(await restore(org, moved.id, 1, 2))).toEqual(["too_deep"]);
    // The database refuses a 65th level whoever writes it.
    const at63 = await insert(unit(org, "series", parent));
    const at64 = await insert(unit(org, "series", at63.id));
    expect(
      codes(await tx((q) => insertRecord(q, unit(org, "series", at64.id), { actor: ALICE }))),
    ).toEqual(["too_deep"]);
  });
});

describe("restoreVersion: record types and represented records", () => {
  it("checks the record type as it is now, and that a represented record still exists", async () => {
    await ready();
    const org = await organization();
    ok(
      await insertRecordTypeVersion(db, {
        key: "chair",
        organizationId: org,
        label: "Chair",
        kind: "object",
        defaultTemplateKey: "invented-object",
      }),
    );
    const typed = await insert({ ...object(org), recordTypeKey: "chair" });
    ok(await save(withoutKey({ ...typed, updatedAt: LATER }, "recordTypeKey"), 1));
    ok(await restore(org, typed.id, 1, 2));
    ok(await save(withoutKey({ ...typed, updatedAt: AFTER_NOW }, "recordTypeKey"), 3));
    // The type is removed by the owner (nothing points at it now).
    await tx(async (q) => {
      await q.execute(sql`DELETE FROM public.record_type_versions
                          WHERE organization_id = ${org}::uuid AND key = 'chair'`);
      await q.execute(sql`DELETE FROM public.record_types
                          WHERE organization_id = ${org}::uuid AND key = 'chair'`);
    });
    expect(codes(await restore(org, typed.id, 1, 4))).toEqual(["unknown_record_type"]);

    const shown = await insert(object(org));
    const scan = await insert(
      ok(
        createRecord(
          {
            organizationId: org,
            kind: "digital_asset",
            mediaType: "image/tiff",
            represents: shown.id,
            title: "An invented scan",
            templateKey: "invented-asset",
          },
          new Date(T),
        ),
      ),
    );
    ok(await save(withoutKey({ ...scan, updatedAt: LATER }, "represents"), 1));
    await tx((q) =>
      q.execute(sql`DELETE FROM public.records WHERE organization_id = ${org}::uuid
                    AND id = ${shown.id}::uuid`),
    );
    const result = await restore(org, scan.id, 1, 2);
    expect(result.ok ? [] : result.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["represents", "unknown_record"],
    ]);
  });
});

function withoutKey(record: CatalogRecord, key: string): CatalogRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key),
  ) as unknown as CatalogRecord;
}

function withoutParent(record: CatalogRecord): CatalogRecord {
  return withoutKey(record, "parentId");
}

describe("review fixes (D-065)", () => {
  it("two restores at the same moment can't file two units under each other", async () => {
    await ready();
    const org = await organization();
    const b = await insert(unit(org, "series"));
    const a = await insert(unit(org, "series", b.id)); // a v1: under b
    ok(await save({ ...withoutParent(a), updatedAt: LATER }, 1)); // a v2: top
    ok(await save({ ...b, parentId: a.id, updatedAt: LATER } as CatalogRecord, 1)); // b v2: under a
    ok(await save({ ...withoutParent(b), updatedAt: LATEST }, 2)); // b v3: top
    // Alice restores a's version 1 (a under b) and holds her transaction open;
    // Bob restores b's version 2 (b under a) on another connection.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let restored: () => void = () => undefined;
    const aliceRestored = new Promise<void>((resolve) => (restored = resolve));
    const alice = db.transaction(async (q) => {
      const result = await restoreVersion(
        q,
        org,
        a.id,
        1,
        { expectedVersion: 2, actor: ALICE },
        { now: NOW },
      );
      restored();
      await held;
      return result;
    });
    await aliceRestored;
    const bob = restore(org, b.id, 2, 3, undefined, {}, other);
    // Bob waits for Alice's arrangement lock (or, without it, finishes).
    await Promise.race([someoneWaits(), bob]);
    release();
    ok(await alice);
    expect(codes(await bob)).toEqual(["loop"]);
    expect(ok(await readStoredRecord(db, org, b.id)).record).not.toHaveProperty("parentId");
  });

  it("the database refuses a loop from updateRecord or direct SQL", async () => {
    await ready();
    const org = await organization();
    const a = await insert(unit(org, "series"));
    const b = await insert(unit(org, "series", a.id));
    const c = await insert(unit(org, "series", b.id));
    const looped = await save({ ...a, parentId: c.id, updatedAt: LATER } as CatalogRecord, 1);
    expect(paths(looped)).toEqual([["parentId", "loop"]]);
    await expect(
      tx((q) =>
        q.execute(sql`UPDATE public.records SET parent_id = ${c.id}::uuid, version = version + 1
                      WHERE organization_id = ${org}::uuid AND id = ${a.id}::uuid`),
      ),
    ).rejects.toMatchObject({ code: "23000", constraint: "records_arrangement_loop" });
  });

  it("asks before restoring a value into a field made public since it was removed", async () => {
    await ready();
    const org = await organization();
    // `provenance` is staff-only; a donor's name is stored, then removed.
    const staffOnly = objectTemplate(org, [field("provenance", "text")]);
    ok(await insertTemplateVersion(db, staffOnly));
    const record = await insert(object(org, { provenance: "From an invented donor." }));
    ok(await save({ ...record, fields: { note: "Oak." }, updatedAt: LATER }, 1));
    // The field is made public: no record holds a value, so nothing to confirm then.
    ok(
      await insertTemplateVersion(
        db,
        objectTemplate(org, [field("provenance", "text", { visibility: "public" })]),
      ),
    );
    expect(paths(await restore(org, record.id, 1, 2))).toEqual([
      ["fields.provenance", "public_field_restored"],
    ]);
    expect(await versionCount(org, record.id)).toBe(2);
    // A confirmation of another list is not this one's.
    expect(
      paths(await restore(org, record.id, 1, 2, undefined, { confirmMadePublic: ["note"] })),
    ).toEqual([["fields.provenance", "public_field_restored"]]);
    expect(
      paths(
        await restore(org, record.id, 1, 2, undefined, {
          confirmMadePublic: ["provenance", "note"],
        }),
      ),
    ).toEqual([["fields.provenance", "public_field_restored"]]);
    ok(await restore(org, record.id, 1, 2, undefined, { confirmMadePublic: ["provenance"] }));
  });

  it("a conflict names what changed, never the values", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org, { note: "A secret staff note." }));
    ok(
      await save(
        { ...record, title: "Another title", fields: { note: "Second secret." }, updatedAt: LATER },
        1,
        BOB,
        other,
      ),
    );
    const stale = await save({ ...record, updatedAt: LATER }, 1);
    const conflict = stale.ok ? undefined : stale.conflict;
    expect(conflict).toEqual({
      expectedVersion: 1,
      currentVersion: 2,
      differences: [
        { name: "fields.note", change: "changed" },
        { name: "title", change: "changed" },
      ],
    });
    const text = JSON.stringify(conflict);
    for (const value of ["secret", "Another title", "invented chair"]) {
      expect(text).not.toContain(value);
    }
  });

  it("refuses unknown options and change keys, and any isolation but Read Committed", async () => {
    await ready();
    const org = await organization();
    const record = await insert(object(org));
    ok(await save({ ...record, title: "Renamed", updatedAt: LATER }, 1));
    const run = (change: object, options: object) =>
      tx((q) => restoreVersion(q, org, record.id, 1, change as never, options as RestoreOptions));
    expect(codes(await run({ expectedVersion: 2, actor: BOB }, { confirm: true }))).toEqual([
      "unknown_property",
    ]);
    expect(codes(await run({ expectedVersion: 2, actor: BOB, organizationId: org }, {}))).toEqual([
      "unknown_property",
    ]);
    expect(
      codes(await run({ expectedVersion: 2, actor: BOB }, { confirmMadePublic: true })),
    ).toEqual(["invalid_option"]);
    const repeatable = await tx(async (q) => {
      await q.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      return restoreVersion(q, org, record.id, 1, { expectedVersion: 2, actor: BOB });
    });
    expect(codes(repeatable)).toEqual(["read_committed_required"]);
    expect(await versionCount(org, record.id)).toBe(2);
  });
});

describe("second review (D-065)", () => {
  it("a restore's refusal never quotes the old version's values", async () => {
    await ready();
    const org = await organization();
    const record = await insert(
      object(org, { number: { type: "secret_old_type", value: "SECRET-0042" } }),
    );
    ok(await save({ ...record, fields: { note: "Oak." }, updatedAt: LATER }, 1));
    const result = await restore(org, record.id, 1, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("identifier_not_held");
    const text = JSON.stringify(result.issues.map((i) => i.message));
    expect(text).not.toContain("secret_old_type");
    expect(text).not.toContain("SECRET-0042");
  });

  it("the database refuses moving a subtree where its units would sit deeper than 64", async () => {
    await ready();
    const org = await organization();
    // A chain of 61 series, and a separate subtree of 10 levels.
    let chain: RecordId | undefined;
    for (let i = 0; i < 61; i += 1) chain = (await insert(unit(org, "series", chain))).id;
    const top = await insert(unit(org, "series"));
    let below: RecordId = top.id;
    for (let i = 0; i < 9; i += 1) below = (await insert(unit(org, "series", below))).id;
    if (chain === undefined) throw new Error("no chain");
    await expect(
      tx((q) =>
        q.execute(sql`UPDATE public.records SET parent_id = ${chain}::uuid, version = version + 1
                      WHERE organization_id = ${org}::uuid AND id = ${top.id}::uuid`),
      ),
    ).rejects.toMatchObject({ code: "23000", constraint: "records_arrangement_too_deep" });
    // Through updateRecord, the same refusal comes back as an issue.
    const moved = await save({ ...top, parentId: chain, updatedAt: LATER } as CatalogRecord, 1);
    expect(paths(moved)).toEqual([["parentId", "too_deep"]]);
  });

  it("two updateRecord moves at the same moment can't form a loop", async () => {
    await ready();
    const org = await organization();
    const a = await insert(unit(org, "series"));
    const b = await insert(unit(org, "series"));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let moved: () => void = () => undefined;
    const aliceMoved = new Promise<void>((resolve) => (moved = resolve));
    const alice = db.transaction(async (q) => {
      const result = await updateRecord(
        q,
        { ...a, parentId: b.id, updatedAt: LATER },
        { expectedVersion: 1, actor: ALICE },
      );
      moved();
      await held;
      return result;
    });
    await aliceMoved;
    const bob = save({ ...b, parentId: a.id, updatedAt: LATER } as CatalogRecord, 1, BOB, other);
    await Promise.race([someoneWaits(), bob]);
    release();
    ok(await alice);
    expect(paths(await bob)).toEqual([["parentId", "loop"]]);
  });
});
