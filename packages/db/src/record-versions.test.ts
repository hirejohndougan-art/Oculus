// Record versions (0005_record_versions.sql, record-versions.ts, T-029,
// D-063): every record write stores its version in the same transaction,
// versions are append-only for the owner (triggers) and for an app role
// (grants), numbers never gap or repeat under concurrency, and organizations
// stay apart.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STANDARD_PRESETS,
  createRecord,
  newOrganizationId,
  newRecordId,
  templateFromPreset,
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
  readRecord,
  readStoredRecord,
  updateRecord,
} from "./catalog.js";
import { defaultMigrationsDir, migrate } from "./migrate.js";
import {
  isActorId,
  readVersion,
  readVersions,
  validateRecordChange,
  type RecordVersion,
} from "./record-versions.js";
import { sql, type Sql } from "./sql.js";
import {
  freshDatabase,
  storeDirectVersion,
  testServerUrl,
  type TestDatabase,
} from "./test-database.fixtures.js";

const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:30:00.250Z";
const ACTOR = "user:3f1c2a9e-8b7d-4c6e-9a5b-1d2e3f4a5b6c";
const SYSTEM = { actor: "system:test" } as const;
const IDENTITY = "23000"; // integrity_constraint_violation, as the triggers raise it
const DENIED = "42501"; // insufficient_privilege

// ---------------------------------------------------------------------------
// One migrated database for the file, set up inside each test.

let setup: Promise<{ testDb: TestDatabase; db: Database }> | undefined;
let db: Database;
const cleanups: (() => Promise<void>)[] = [];

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    return { testDb, db: openDatabase(testDb.url, { max: 4 }) };
  })();
  db = (await setup).db;
}

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  const done = await setup?.catch(() => undefined);
  if (done) {
    await done.db.close();
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

/** The SQLSTATE and constraint of the error `work` fails with (or fails if none). */
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

/** A template for places (no preset covers them), to round-trip coordinates. */
function placeTemplate(organizationId: OrganizationId): FieldTemplate {
  return {
    key: "places",
    organizationId,
    label: "Places",
    appliesTo: ["place"],
    fields: [
      {
        key: "note",
        label: "Note",
        kind: "long_text",
        required: false,
        repeatable: false,
        visibility: "public",
        inherited: false,
      },
    ],
  };
}

/** A new organization with its own templates. */
async function organization(): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(db, { id: org, name: "Invented Society" }));
  const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
  if (preset === undefined) throw new Error("no spectrum-object preset");
  ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org))));
  ok(await insertTemplateVersion(db, placeTemplate(org)));
  return org;
}

function chair(org: OrganizationId, id?: RecordId): CatalogRecord {
  const record = ok(
    createRecord(
      {
        organizationId: org,
        kind: "object",
        title: "An invented chair",
        templateKey: "spectrum-object",
        fields: { brief_description: "Oak, with a cane seat." },
      },
      new Date(T),
    ),
  );
  return id === undefined ? record : { ...record, id };
}

function tx<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

async function stored(org: OrganizationId, record = chair(org)): Promise<CatalogRecord> {
  ok(await tx((q) => insertRecord(q, record, { actor: ACTOR, reason: "Accessioned." })));
  return record;
}

function edited(record: CatalogRecord, title: string): CatalogRecord {
  return { ...record, title, updatedAt: LATER };
}

async function versionCount(org: OrganizationId, id: RecordId): Promise<number> {
  const [row] = await db.rows<{ n: number }>(sql`
    SELECT count(*)::integer AS n FROM public.record_versions
    WHERE organization_id = ${org}::uuid AND record_id = ${id}::uuid`);
  return row?.n ?? 0;
}

async function numbers(org: OrganizationId, id: RecordId): Promise<number[]> {
  return ok(await readVersions(db, org, id, { limit: 1000 })).versions.map((v) => v.version);
}

// ---------------------------------------------------------------------------

describe("who and why", () => {
  it("takes user: and system: actors and a plain reason, nothing else", () => {
    expect(isActorId(ACTOR)).toBe(true);
    expect(isActorId("system:import")).toBe(true);
    for (const bad of [
      "",
      "user:3F1C2A9E-8B7D-4C6E-9A5B-1D2E3F4A5B6C",
      "user:not-a-uuid",
      "system:",
      "system:Import",
      "admin",
      " system:import",
      42,
    ]) {
      expect(isActorId(bad)).toBe(false);
    }
    expect(ok(validateRecordChange({ actor: ACTOR, reason: "Line one.\nLine two." }))).toEqual({
      actor: ACTOR,
      reason: "Line one.\nLine two.",
    });
    expect(codes(validateRecordChange({ actor: "nobody" }))).toEqual(["invalid_actor"]);
    expect(codes(validateRecordChange({ actor: ACTOR, reasons: "typo" }))).toEqual([
      "unknown_property",
    ]);
    for (const reason of ["", " padded", "tab\there", "x".repeat(2001), "bell\u0007", 3]) {
      expect(codes(validateRecordChange({ actor: ACTOR, reason }))).toEqual(["invalid_reason"]);
    }
    const sneaky = Object.defineProperty({}, "actor", { get: () => ACTOR, enumerable: true });
    expect(codes(validateRecordChange(sneaky))).toEqual(["unreadable"]);
    expect(codes(validateRecordChange(null))).toEqual(["invalid_change"]);
  });
});

describe("writing records stores versions", () => {
  it("an insert is version 1, with who, when, why and every field", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const [first] = ok(await readVersions(db, org, record.id)).versions;
    expect(first).toMatchObject({
      organizationId: org,
      recordId: record.id,
      version: 1,
      record,
      actor: ACTOR,
      reason: "Accessioned.",
      changedFields: ["fields.brief_description", "kind", "templateKey", "title"],
    });
    expect(first?.recordedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(ok(await readStoredRecord(db, org, record.id))).toEqual({ version: 1, record });
    expect(ok(await readVersion(db, org, record.id))).toEqual(first);
  });

  it("an update is the next version and names only what changed", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const next = { ...edited(record, "An invented rocking chair"), fields: {} };
    const v2 = ok(await tx((q) => updateRecord(q, next, { expectedVersion: 1, ...SYSTEM })));
    expect(v2).toMatchObject({ version: 2, record: next, actor: "system:test" });
    expect(v2.changedFields).toEqual(["fields.brief_description", "title"]);
    expect(v2.reason).toBeUndefined();
    expect(ok(await readRecord(db, org, record.id))).toEqual(next);
    expect(ok(await readVersion(db, org, record.id, 1)).record).toEqual(record);
    expect(ok(await readVersion(db, org, record.id)).version).toBe(2);
    // Writing the same record again is still a version, with nothing changed.
    const v3 = ok(await tx((q) => updateRecord(q, next, { expectedVersion: 2, ...SYSTEM })));
    expect(v3).toMatchObject({ version: 3, changedFields: [] });
  });

  it("coordinates and every kind's columns round-trip into the snapshot", async () => {
    await ready();
    const org = await organization();
    const place = ok(
      createRecord(
        {
          organizationId: org,
          kind: "place",
          title: "An invented landing",
          templateKey: "places",
          coordinates: { lat: 29.460_123_456_789_1, lng: -95.0511 },
        },
        new Date(T),
      ),
    );
    // The session's own float setting doesn't change the snapshot.
    await tx(async (q) => {
      await q.rows(sql`SELECT set_config('extra_float_digits', '-3', true)`);
      ok(await insertRecord(q, place, SYSTEM));
    });
    expect(ok(await readVersion(db, org, place.id)).record).toEqual(place);
    expect(ok(await readVersion(db, org, place.id)).changedFields).toContain("coordinates");
  });

  it("refuses bad changes, stale versions and unknown records, storing nothing", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const next = edited(record, "Renamed");
    const refusedWith = async (update: unknown, input: unknown = next): Promise<string[]> =>
      codes(await tx((q) => updateRecord(q, input, update as Parameters<typeof updateRecord>[2])));
    expect(await refusedWith({ expectedVersion: 0, ...SYSTEM })).toEqual(["invalid_version"]);
    expect(await refusedWith({ expectedVersion: 1.5, ...SYSTEM })).toEqual(["invalid_version"]);
    expect(await refusedWith({ expectedVersion: 1, actor: "root" })).toEqual(["invalid_actor"]);
    expect(await refusedWith({ expectedVersion: 1, ...SYSTEM, why: "x" })).toEqual([
      "unknown_property",
    ]);
    expect(await refusedWith({ expectedVersion: 2, ...SYSTEM })).toEqual(["version_conflict"]);
    expect(
      await refusedWith({ expectedVersion: 1, ...SYSTEM }, { ...next, id: newRecordId() }),
    ).toEqual(["unknown_record"]);
    expect(
      await refusedWith({ expectedVersion: 1, ...SYSTEM }, { ...next, createdAt: LATER }),
    ).toEqual(["created_at_changed"]);
    expect(
      await refusedWith({ expectedVersion: 1, ...SYSTEM }, { ...next, organizationId: "x" }),
    ).not.toEqual([]);
    expect(codes(await tx((q) => insertRecord(q, chair(org), { actor: "" })))).toEqual([
      "invalid_actor",
    ]);
    expect(await numbers(org, record.id)).toEqual([1]);
    expect(ok(await readRecord(db, org, record.id))).toEqual(record);
    // A refusal leaves the caller's transaction usable.
    await tx(async (q) => {
      expect(codes(await updateRecord(q, next, { expectedVersion: 7, ...SYSTEM }))).toEqual([
        "version_conflict",
      ]);
      ok(await updateRecord(q, next, { expectedVersion: 1, ...SYSTEM }));
    });
    expect(await numbers(org, record.id)).toEqual([1, 2]);
  });

  it("writes need a transaction", async () => {
    await ready();
    const org = await organization();
    await expect(insertRecord(db, chair(org), SYSTEM)).rejects.toThrow(/inside a transaction/);
  });

  it("checks its arguments when reading", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    expect(codes(await readVersions(db, "nope" as OrganizationId, record.id))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(await readVersions(db, org, "x' OR 1=1" as RecordId))).toEqual(["invalid_id"]);
    expect(codes(await readVersions(db, org, record.id, { limit: 0 }))).toEqual(["invalid_limit"]);
    expect(codes(await readVersions(db, org, record.id, { after: -1 }))).toEqual([
      "invalid_version",
    ]);
    expect(codes(await readVersion(db, org, record.id, 0))).toEqual(["invalid_version"]);
    expect(await readVersion(db, org, record.id, 2)).toBeUndefined();
    expect(ok(await readVersions(db, org, newRecordId())).versions).toEqual([]);
  });

  it("lists versions in pages", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    for (let v = 1; v <= 4; v++) {
      ok(
        await tx((q) =>
          updateRecord(q, edited(record, `Title ${String(v)}`), { expectedVersion: v, ...SYSTEM }),
        ),
      );
    }
    const page = ok(await readVersions(db, org, record.id, { limit: 2 }));
    expect(page.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(page.truncated).toBe(true);
    const last = ok(await readVersions(db, org, record.id, { after: 4, limit: 2 }));
    expect(last.versions.map((v) => v.version)).toEqual([5]);
    expect(last.truncated).toBe(false);
  });
});

describe("a record and its version are written together", () => {
  it("a failed record write leaves no version", async () => {
    await ready();
    const org = await organization();
    const unknownTemplate = { ...chair(org), templateKey: "no-such-template" };
    await tx(async (q) => {
      expect(await refusal(insertRecord(q, unknownTemplate, SYSTEM))).toMatchObject({
        code: "23503",
      });
      // The savepoint was rolled back; the transaction goes on.
      ok(await insertRecord(q, chair(org), SYSTEM));
    });
    expect(await versionCount(org, unknownTemplate.id)).toBe(0);
  });

  it("a failed version write leaves the record as it was", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    // An extra trigger (the owner's) that refuses versions with one title.
    await db.execute(sql`
      CREATE FUNCTION test_refuse_versions() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.record ->> 'title' = 'Refuse me' THEN
          RAISE EXCEPTION 'refused for the test' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    await db.execute(sql`
      CREATE TRIGGER aaaa_refuse BEFORE INSERT ON public.record_versions
      FOR EACH ROW EXECUTE FUNCTION test_refuse_versions()`);
    try {
      await tx(async (q) => {
        expect(
          await refusal(
            updateRecord(q, edited(record, "Refuse me"), { expectedVersion: 1, ...SYSTEM }),
          ),
        ).toMatchObject({ code: "P0001" });
        const fresh = { ...chair(org), title: "Refuse me" };
        expect(await refusal(insertRecord(q, fresh, SYSTEM))).toMatchObject({ code: "P0001" });
        expect(await readRecord(q, org, fresh.id)).toBeUndefined();
        expect(ok(await readStoredRecord(q, org, record.id))).toEqual({ version: 1, record });
      });
    } finally {
      await db.execute(sql`DROP TRIGGER aaaa_refuse ON public.record_versions`);
      await db.execute(sql`DROP FUNCTION test_refuse_versions()`);
    }
    expect(await numbers(org, record.id)).toEqual([1]);
  });

  it("direct SQL can't write a record without its version", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    // An update must be the next version …
    expect(
      await refusal(db.execute(sql`UPDATE public.records SET title = 'Quiet edit' WHERE ${where}`)),
    ).toEqual({ code: IDENTITY, constraint: "records_version_step" });
    expect(
      await refusal(
        db.execute(sql`UPDATE public.records SET title = 'Skip', version = 5 WHERE ${where}`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_version_step" });
    // … and can't commit without it.
    expect(
      await refusal(
        db.execute(
          sql`UPDATE public.records SET title = 'Quiet edit', version = version + 1 WHERE ${where}`,
        ),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
    // Nor can a new record.
    const fresh = chair(org);
    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO public.records (id, organization_id, kind, template_key, title, fields,
                                      created_at, updated_at)
          VALUES (${fresh.id}::uuid, ${org}::uuid, 'object', 'spectrum-object', 'Raw', '{}',
                  ${T}::timestamptz, ${T}::timestamptz)`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
    // A version whose snapshot isn't the row is refused, even inside the write.
    expect(
      await refusal(
        tx(async (q) => {
          await q.execute(
            sql`UPDATE public.records SET title = 'Edit', version = version + 1 WHERE ${where}`,
          );
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
            VALUES (${org}::uuid, ${record.id}::uuid, 2,
                    ${JSON.stringify({ ...record, title: "Something else" })}::jsonb, 'system:x')`);
        }),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_snapshot_matches" });
    expect(ok(await readStoredRecord(db, org, record.id))).toEqual({ version: 1, record });
    expect(await numbers(org, record.id)).toEqual([1]);
  });

  it("direct SQL can't add a version without a record write, or skip a number", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const insertVersion = (version: number, q: Queryable = db): Promise<number> =>
      q.execute(sql`
        INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
        VALUES (${org}::uuid, ${record.id}::uuid, ${version}::integer,
                ${JSON.stringify(record)}::jsonb, 'system:x')`);
    expect(await refusal(insertVersion(1))).toEqual({
      code: IDENTITY,
      constraint: "record_versions_next_number",
    });
    expect(await refusal(insertVersion(2))).toEqual({
      code: IDENTITY,
      constraint: "record_versions_with_record_write",
    });
    // When and what changed are the database's, never the writer's.
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    await tx(async (q) => {
      await q.execute(
        sql`UPDATE public.records SET title = 'Edited', version = version + 1 WHERE ${where}`,
      );
      await q.execute(sql`
        INSERT INTO public.record_versions
          (organization_id, record_id, version, record, actor, recorded_at, changed_fields,
           written_in)
        SELECT organization_id, id, version, public.record_snapshot(r), 'system:x',
               '2000-01-01T00:00:00Z', '{forged}', '1'::xid8
        FROM public.records r WHERE ${where}`);
      const [mine] = await q.rows<{ ours: boolean }>(sql`
        SELECT written_in = pg_current_xact_id() AS ours FROM public.record_versions
        WHERE organization_id = ${org}::uuid AND record_id = ${record.id}::uuid AND version = 2`);
      expect(mine?.ours).toBe(true);
    });
    const v2 = ok(await readVersion(db, org, record.id, 2));
    expect(v2.changedFields).toEqual(["title"]);
    expect(v2.recordedAt.startsWith("2000")).toBe(false);
  });

  it("a deleted record keeps its history, and its ID can't start again at 1", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    await db.execute(
      sql`DELETE FROM public.records WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`,
    );
    expect(await numbers(org, record.id)).toEqual([1]);
    expect(codes(await tx((q) => insertRecord(q, record, SYSTEM)))).toEqual(["id_used_before"]);
    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO public.records (id, organization_id, kind, template_key, title, fields,
                                      created_at, updated_at)
          VALUES (${record.id}::uuid, ${org}::uuid, 'object', 'spectrum-object', ${record.title},
                  ${JSON.stringify(record.fields)}::jsonb, ${T}::timestamptz, ${T}::timestamptz)`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_id_used_before" });
    expect(await numbers(org, record.id)).toEqual([1]);
    // A record that still exists is refused by the primary key, as before.
    const live = await stored(org);
    expect(await refusal(tx((q) => insertRecord(q, live, SYSTEM)))).toMatchObject({
      code: "23505",
    });
  });

  it("a record wound back to an older stored version can't commit without its own new version", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const next = edited(record, "Second title");
    ok(await tx((q) => updateRecord(q, next, { expectedVersion: 1, ...SYSTEM })));
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    // Even with the step trigger off (only the owner can), version 1's content
    // under number 1, or version 2's again under number 2, is not this
    // transaction's version.
    for (const statement of [
      sql`UPDATE public.records SET title = ${record.title}, updated_at = ${T}::timestamptz,
                                    version = 1 WHERE ${where}`,
      sql`UPDATE public.records SET title = ${next.title} WHERE ${where}`,
    ]) {
      expect(
        await refusal(
          tx(async (q) => {
            await q.execute(
              sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_version_step`,
            );
            await q.execute(statement);
            // Run the COMMIT check now (a trigger can't be re-enabled while
            // its events are pending); the transaction rolls back either way.
            await q.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
            await q.execute(
              sql`ALTER TABLE public.records ENABLE TRIGGER zzzz_records_version_step`,
            );
          }),
        ),
      ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
    }
    expect(ok(await readStoredRecord(db, org, record.id))).toEqual({ version: 2, record: next });
  });

  it("an update meeting history out of step with the record is a clean version_conflict", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    ok(await tx((q) => updateRecord(q, edited(record, "Two"), { expectedVersion: 1, ...SYSTEM })));
    // The owner winds the row back to version 1 with every check off.
    await tx(async (q) => {
      await q.execute(sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_version_step`);
      await q.execute(sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_have_version`);
      await q.execute(sql`
        UPDATE public.records SET title = ${record.title}, updated_at = ${T}::timestamptz,
                                  version = 1
        WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`);
      await q.execute(sql`ALTER TABLE public.records ENABLE TRIGGER zzzz_records_version_step`);
      await q.execute(sql`ALTER TABLE public.records ENABLE TRIGGER zzzz_records_have_version`);
    });
    expect(
      codes(
        await tx((q) =>
          updateRecord(q, edited(record, "Three"), { expectedVersion: 1, ...SYSTEM }),
        ),
      ),
    ).toEqual(["version_conflict"]);
    expect(await numbers(org, record.id)).toEqual([1, 2]);
  });

  it("a record's kind never changes; its template may, through updateRecord", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const asEvent = { ...edited(record, "Now an event"), kind: "event" };
    expect(
      codes(await tx((q) => updateRecord(q, asEvent, { expectedVersion: 1, ...SYSTEM }))),
    ).toEqual(["kind_changed"]);
    expect(
      await refusal(
        db.execute(sql`UPDATE public.records SET kind = 'event', version = version + 1
                       WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_kind_fixed" });
    const retemplated = { ...edited(record, "Filed as a place note"), templateKey: "places" };
    const v2 = ok(await tx((q) => updateRecord(q, retemplated, { expectedVersion: 1, ...SYSTEM })));
    expect(v2.changedFields).toEqual(["templateKey", "title"]);
    expect(await numbers(org, record.id)).toEqual([1, 2]);
  });

  it("updatedAt never goes backwards", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    ok(
      await tx((q) => updateRecord(q, edited(record, "Later"), { expectedVersion: 1, ...SYSTEM })),
    );
    const earlier = { ...record, title: "Earlier", updatedAt: T };
    expect(
      codes(await tx((q) => updateRecord(q, earlier, { expectedVersion: 2, ...SYSTEM }))),
    ).toEqual(["updated_before"]);
    expect(
      await refusal(
        db.execute(sql`UPDATE public.records SET updated_at = ${T}::timestamptz,
                                                 version = version + 1
                       WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_updated_at_backwards" });
    // The same instant is allowed (a second save within the millisecond).
    ok(
      await tx((q) =>
        updateRecord(q, edited(record, "Same instant"), { expectedVersion: 2, ...SYSTEM }),
      ),
    );
    expect(await numbers(org, record.id)).toEqual([1, 2, 3]);
  });
});

describe("versions are append-only", () => {
  it("even the owner can't update, delete or truncate them through the triggers", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const other = await organization();
    const where = sql`organization_id = ${org}::uuid AND record_id = ${record.id}::uuid`;
    const appendOnly = { code: IDENTITY, constraint: "record_versions_append_only" };
    for (const statement of [
      sql`UPDATE public.record_versions SET reason = 'Rewritten.' WHERE ${where}`,
      sql`UPDATE public.record_versions SET organization_id = ${other}::uuid WHERE ${where}`,
      sql`UPDATE public.record_versions SET version = 9 WHERE ${where}`,
      sql`DELETE FROM public.record_versions WHERE ${where}`,
      sql`TRUNCATE public.record_versions`,
    ]) {
      expect(await refusal(db.execute(statement))).toEqual(appendOnly);
    }
    expect(ok(await readVersion(db, org, record.id))).toMatchObject({
      version: 1,
      reason: "Accessioned.",
    });
  });

  it("a version changed by the owner with triggers off reads as issues", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    await tx(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.record_versions DISABLE TRIGGER zzzz_record_versions_append_only`,
      );
      await q.execute(sql`
        UPDATE public.record_versions SET record = jsonb_set(record, '{fields}', '{"Bad Key": 1}')
        WHERE organization_id = ${org}::uuid AND record_id = ${record.id}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.record_versions ENABLE TRIGGER zzzz_record_versions_append_only`,
      );
    });
    const read = await readVersions(db, org, record.id);
    expect(codes(read)).toEqual(["invalid_field_key"]);
    expect(read.ok ? [] : read.issues[0]?.path[0]).toBe(1);
    expect(codes(await readVersion(db, org, record.id))).toEqual(["invalid_field_key"]);
  });

  it("an app role with D-063's grants can write records but never change history", async () => {
    await ready();
    const role = `oculus_test_app_${newRecordId().slice(0, 8)}`;
    // Role names can't be parameters; the name is made here, then quoted by format().
    const asRole = (statement: string): Sql =>
      sql`SELECT set_config('oculus_test.role', ${role}, true), set_config('oculus_test.statement', ${statement}, true)`;
    const run = async (statement: string, q: Queryable): Promise<void> => {
      await q.rows(asRole(statement));
      await q.execute(sql`DO $$ BEGIN
        EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
      END $$`);
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction((q) => run("CREATE ROLE %I LOGIN", q));
    } finally {
      await server.close();
    }
    cleanups.push(async () => {
      const admin = openDatabase(testServerUrl(), { max: 1 });
      try {
        // After the test database (where its grants are) is dropped.
        await setup?.then(({ db: d, testDb }) => d.close().then(() => testDb.drop()));
        setup = undefined;
        await admin.transaction((q) => run("DROP ROLE IF EXISTS %I", q));
      } finally {
        await admin.close();
      }
    });
    // D-063's grants for the app role.
    await db.transaction(async (q) => {
      for (const statement of [
        "GRANT USAGE ON SCHEMA public TO %I",
        "GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I",
        "GRANT INSERT, UPDATE ON public.records TO %I",
        `GRANT INSERT, UPDATE, DELETE ON public.organizations, public.templates,
           public.record_types, public.identifier_types,
           public.identifier_holdings, public.record_identifiers, public.former_identifiers,
           public.identifier_counters, public.terms, public.record_term_index,
           public.record_terms TO %I`,
        "GRANT INSERT ON public.template_versions, public.record_type_versions, public.record_versions TO %I",
      ]) {
        await run(statement, q);
      }
    });
    const url = new URL((await setup)?.testDb.url ?? "");
    url.username = role;
    const app = openDatabase(url.toString(), { max: 2 });
    try {
      const [who] = await app.rows<{ user: string }>(sql`SELECT current_user AS user`);
      expect(who?.user).toBe(role);
      // Writing records and their versions works.
      const org = await organization();
      const record = chair(org);
      ok(await app.transaction((q) => insertRecord(q, record, SYSTEM)));
      ok(
        await app.transaction((q) =>
          updateRecord(q, edited(record, "By the app"), { expectedVersion: 1, ...SYSTEM }),
        ),
      );
      expect(ok(await readVersions(app, org, record.id)).versions).toHaveLength(2);
      // Changing history is refused by the privileges, before any trigger.
      const where = sql`organization_id = ${org}::uuid AND record_id = ${record.id}::uuid`;
      for (const statement of [
        sql`UPDATE public.record_versions SET reason = 'Rewritten.' WHERE ${where}`,
        sql`DELETE FROM public.record_versions WHERE ${where}`,
        sql`TRUNCATE public.record_versions`,
        sql`ALTER TABLE public.record_versions DISABLE TRIGGER zzzz_record_versions_append_only`,
        sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_have_version`,
        sql`DROP TRIGGER zzzz_record_versions_append_only ON public.record_versions`,
        sql`UPDATE public.template_versions SET definition = definition WHERE organization_id = ${org}::uuid`,
        sql`DELETE FROM public.template_versions WHERE organization_id = ${org}::uuid`,
        sql`SET session_replication_role = replica`,
      ]) {
        expect((await refusal(app.execute(statement))).code).toBe(DENIED);
      }
      // Deleting a record isn't versioned yet (T-032 adds tombstones), so the
      // app role can't delete records at all.
      expect(
        (
          await refusal(
            app.execute(sql`DELETE FROM public.records
                            WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`),
          )
        ).code,
      ).toBe(DENIED);
      // History ahead of the row (the owner wound it back to version 1 with
      // every check off): the app role reproducing stored version 2 exactly,
      // number and content, still needs a version of its own transaction
      // (written_in); without that check this would commit.
      await tx(async (q) => {
        await q.execute(sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_version_step`);
        await q.execute(sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_have_version`);
        await q.execute(sql`
          UPDATE public.records SET title = ${record.title}, updated_at = ${T}::timestamptz,
                                    version = 1
          WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`);
        await q.execute(sql`ALTER TABLE public.records ENABLE TRIGGER zzzz_records_version_step`);
        await q.execute(sql`ALTER TABLE public.records ENABLE TRIGGER zzzz_records_have_version`);
      });
      expect(
        await refusal(
          app.execute(sql`
            UPDATE public.records SET title = 'By the app', updated_at = ${LATER}::timestamptz,
                                      version = version + 1
            WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`),
        ),
      ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
      expect(ok(await readStoredRecord(app, org, record.id)).version).toBe(1);
      // And it can't write a record without its version either.
      expect(
        await refusal(
          app.execute(sql`UPDATE public.records SET title = 'Quiet', version = version + 1
                          WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`),
        ),
      ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
      expect(await numbers(org, record.id)).toEqual([1, 2]);
    } finally {
      await app.close();
    }
  });
});

describe("concurrent writes", () => {
  it("two edits from the same version: the second waits, then is refused", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    let bothRead!: () => void;
    const reads = { n: 0 };
    const barrier = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    const edit = (title: string): Promise<Validated<RecordVersion>> =>
      tx(async (q) => {
        const current = ok(await readStoredRecord(q, org, record.id));
        if (++reads.n === 2) bothRead();
        await barrier;
        return updateRecord(q, edited(current.record, title), {
          expectedVersion: current.version,
          ...SYSTEM,
        });
      });
    const results = await Promise.all([edit("First"), edit("Second")]);
    expect(results.map((r) => (r.ok ? "ok" : codes(r).join()))).toEqual(
      expect.arrayContaining(["ok", "version_conflict"]),
    );
    expect(await numbers(org, record.id)).toEqual([1, 2]);
    const winner = results.find((r) => r.ok);
    expect(ok(await readRecord(db, org, record.id))).toEqual(winner?.ok ? winner.value.record : 0);
  });

  it("two connections writing over and over leave versions 1, 2, 3 … with no gaps", async () => {
    await ready();
    const org = await organization();
    const record = await stored(org);
    const second = openDatabase((await setup)?.testDb.url ?? "", { max: 1 });
    try {
      const writer = async (database: Database, name: string): Promise<number> => {
        let written = 0;
        while (written < 10) {
          const result = await database.transaction(async (q) => {
            const current = ok(await readStoredRecord(q, org, record.id));
            return updateRecord(q, edited(current.record, `${name} ${String(written)}`), {
              expectedVersion: current.version,
              actor: "system:racer",
            });
          });
          if (result.ok) written++;
          else expect([["version_conflict"], ["retry"]]).toContainEqual(codes(result));
        }
        return written;
      };
      await Promise.all([writer(db, "A"), writer(second, "B")]);
    } finally {
      await second.close();
    }
    expect(await numbers(org, record.id)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    const latest = ok(await readVersion(db, org, record.id));
    expect(latest.record).toEqual(ok(await readRecord(db, org, record.id)));
  });
});

describe("organizations stay apart", () => {
  it("the same record ID in two organizations has two histories", async () => {
    await ready();
    const archives = await organization();
    const library = await organization();
    const mine = await stored(archives);
    const theirs = await stored(library, chair(library, mine.id));
    ok(
      await tx((q) =>
        updateRecord(q, edited(theirs, "The library's chair"), { expectedVersion: 1, ...SYSTEM }),
      ),
    );
    expect(await numbers(archives, mine.id)).toEqual([1]);
    expect(await numbers(library, mine.id)).toEqual([1, 2]);
    expect(ok(await readVersion(db, archives, mine.id)).record).toEqual(mine);
    // Nothing reads or files a version across.
    const lone = await stored(archives);
    expect(ok(await readVersions(db, library, lone.id)).versions).toEqual([]);
    expect(await readVersion(db, library, lone.id)).toBeUndefined();
    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
          VALUES (${library}::uuid, ${lone.id}::uuid, 1, ${JSON.stringify(lone)}::jsonb,
                  'system:x')`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_with_record_write" });
    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
          VALUES (${library}::uuid, ${lone.id}::uuid, 1,
                  ${JSON.stringify({ ...lone, organizationId: library })}::jsonb, 'system:x')`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_with_record_write" });
  });
});

describe("migration 0005", () => {
  it("gives records stored before it their version 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oculus-t029-migrations-"));
    const before = await freshDatabase();
    try {
      for (const name of [
        "0001_migrations_table.sql",
        "0002_catalog.sql",
        "0003_identifiers.sql",
        "0004_vocabularies.sql",
      ]) {
        cpSync(join(defaultMigrationsDir(), name), join(dir, name));
      }
      await migrate({ connectionString: before.url, dir });
      const old = openDatabase(before.url, { max: 1 });
      try {
        const org = newOrganizationId();
        ok(await insertOrganization(old, { id: org, name: "Older" }));
        const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
        if (preset === undefined) throw new Error("no preset");
        ok(await insertTemplateVersion(old, ok(templateFromPreset(preset, org))));
        const record = chair(org);
        await old.execute(sql`
          INSERT INTO public.records (id, organization_id, kind, template_key, title, fields,
                                      created_at, updated_at)
          VALUES (${record.id}::uuid, ${org}::uuid, 'object', 'spectrum-object', ${record.title},
                  ${JSON.stringify(record.fields)}::jsonb, ${T}::timestamptz, ${T}::timestamptz)`);
        await migrate({ connectionString: before.url });
        const first = ok(await readVersion(old, org, record.id));
        expect(first).toMatchObject({ version: 1, record, actor: "system:migration_0005" });
        await old.transaction(async (q) => {
          ok(await updateRecord(q, edited(record, "Later"), { expectedVersion: 1, ...SYSTEM }));
        });
        expect((await readVersions(old, org, record.id)).ok).toBe(true);
        // The fixture's helper writes what a direct writer must.
        await old.transaction(async (q) => {
          await q.execute(sql`UPDATE public.records SET title = 'Direct', version = version + 1
                              WHERE organization_id = ${org}::uuid AND id = ${record.id}::uuid`);
          await storeDirectVersion(q, org, record.id);
        });
        expect(ok(await readVersion(old, org, record.id)).version).toBe(3);
      } finally {
        await old.close();
      }
    } finally {
      await before.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
