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
  insertTemplateVersion,
  readStoredRecord,
  updateRecord,
  type RecordUpdateResult,
} from "./catalog.js";
import { insertIdentifierType } from "./identifiers.js";
import { migrate } from "./migrate.js";
import { compareVersions, readVersion, readVersions } from "./record-versions.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:30:00.250Z";
const LATEST = "2026-11-22T10:00:00.000Z";
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
      differences: [
        { name: "title", change: "changed", before: "An invented chair", after: "Bob's title" },
      ],
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
      differences: [{ name: "fields.note", change: "changed", before: "Oak.", after: "Walnut." }],
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
