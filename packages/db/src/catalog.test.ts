// The catalog tables (0002_catalog.sql) and their data-access module, on a
// freshly migrated database: every preset template and invented sample records
// of all six kinds round-trip through core's validators and the database, and
// direct SQL can't break the core rules the tables back up or point anything
// across organizations (D-019, D-060).
import { afterAll, describe, expect, it } from "vitest";
import {
  RIGHTS_FIELD_KEY,
  STANDARD_PRESETS,
  checkRecordAgainstTemplate,
  checkRecordType,
  createRecord,
  indexRecordTypes,
  indexTemplates,
  makeIdentifierChecker,
  newOrganizationId,
  newRecordId,
  templateFromPreset,
  type CatalogRecord,
  type FieldTemplate,
  type NewRecordInput,
  type OrganizationId,
  type RecordId,
  type RecordType,
  type TemplateCheckOptions,
  type Validated,
} from "@oculus/core";
import { openDatabase, type Database, type Queryable, type Row } from "./client.js";
import {
  insertOrganization,
  insertRecord,
  insertRecordTypeVersion,
  insertTemplateVersion,
  readOrganization,
  readRecord,
  readRecordType,
  readTemplate,
} from "./catalog.js";
import { migrate } from "./migrate.js";
import { sql, type Sql } from "./sql.js";
import { freshDatabase, writeRecordDirectly, type TestDatabase } from "./test-database.fixtures.js";

// ---------------------------------------------------------------------------
// One migrated database for the file, set up lazily inside each test (not in
// beforeAll), so with no database every test fails on its own.

const ARCHIVES = newOrganizationId();
const LIBRARY = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const LATER = "2026-11-21T09:30:00.250Z";

let setup: Promise<{ testDb: TestDatabase; db: Database }> | undefined;
let db: Database;

async function ready(): Promise<void> {
  setup ??= (async () => {
    const testDb = await freshDatabase();
    await migrate({ connectionString: testDb.url });
    const opened = openDatabase(testDb.url, { max: 3 });
    for (const [id, name] of [
      [ARCHIVES, "Invented Historical Society"],
      [LIBRARY, "Invented Public Library"],
    ] as const) {
      ok(await insertOrganization(opened, { id, name }));
    }
    // Both organizations get their own copy of every preset, with the same keys.
    for (const org of [ARCHIVES, LIBRARY]) {
      for (const preset of STANDARD_PRESETS) {
        ok(await insertTemplateVersion(opened, ok(templateFromPreset(preset, org))));
      }
      ok(await insertTemplateVersion(opened, authorityTemplate(org)));
    }
    return { testDb, db: opened };
  })();
  db = (await setup).db;
}

afterAll(async () => {
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

/** `insertRecord` in a transaction of its own, by an invented system actor (T-029). */
function insertRecordInTx(database: Database, input: unknown): Promise<Validated<CatalogRecord>> {
  return database.transaction((tx) => insertRecord(tx, input, { actor: "system:test" }));
}

function codes(result: Validated<unknown> | undefined): string[] {
  if (result === undefined) throw new Error("not found");
  return result.ok ? [] : result.issues.map((i) => i.code);
}

/** Runs direct SQL and returns the error PostgreSQL gives (or fails if none). */
async function refusedBy(
  query: ReturnType<typeof sql>,
): Promise<{ code: string; constraint?: string }> {
  try {
    await db.execute(query);
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    return {
      code: e.code ?? "",
      ...(e.constraint === undefined ? {} : { constraint: e.constraint }),
    };
  }
  throw new Error("The statement was not refused.");
}

const FOREIGN_KEY = "23503";
const CHECK = "23514";
const NOT_NULL = "23502";
const UNIQUE = "23505";
const IDENTITY = "23000"; // catalog_keep_identity: integrity_constraint_violation

// ---------------------------------------------------------------------------
// Invented sample data.

/** An invented template for agents, places and events (no preset covers them). */
function authorityTemplate(organizationId: OrganizationId): FieldTemplate {
  return {
    key: "authority",
    organizationId,
    label: "Authority record",
    appliesTo: ["agent", "place", "event"],
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
      {
        key: "staff_note",
        label: "Staff note",
        kind: "text",
        required: false,
        repeatable: true,
        visibility: "staff",
        inherited: false,
      },
    ],
  };
}

function withoutOrganization(template: FieldTemplate): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...template };
  delete copy.organizationId;
  return copy;
}

const RIGHTS = { uri: "http://rightsstatements.org/vocab/NoC-US/1.0/" };

function made(
  input: NewRecordInput & {
    templateKey?: string;
    recordTypeKey?: string;
    fields?: Record<string, unknown>;
  },
): CatalogRecord {
  return ok(createRecord(input as Parameters<typeof createRecord>[0], new Date(T)));
}

/** One of every kind, for the archives, filed and linked as a cataloger would. */
function sampleRecords(org: OrganizationId): CatalogRecord[] {
  const fonds = made({
    organizationId: org,
    kind: "archival_unit",
    level: "fonds",
    title: "Invented Family Papers",
    templateKey: "dacs-archival-unit",
    fields: {
      reference_code: { type: "call_number", value: "MS-0001.1" },
      repository: "An invented historical society, Example Town",
      date: "1890/1950",
      extent: ["2 boxes"],
      scope_and_content: "Letters, photographs and ledgers of an invented family.",
      access_conditions: "Open to researchers.",
      languages: [{ label: "English" }],
      [RIGHTS_FIELD_KEY]: RIGHTS,
    },
  });
  const item = made({
    organizationId: org,
    kind: "archival_unit",
    level: "item",
    parentId: fonds.id,
    title: "Photograph of an invented general store",
    templateKey: "dacs-archival-unit",
    fields: {
      reference_code: { type: "call_number", value: "MS-0001.2" },
      date: "1909~",
      extent: ["1 photograph"],
      scope_and_content: "A photograph of the store, with \"quotes\", ünïcödé and 'apostrophes'.",
    },
  });
  const object = made({
    organizationId: org,
    kind: "object",
    title: "Wooden kitchen chair",
    templateKey: "spectrum-object",
    fields: {
      object_number: { type: "accession_number", value: "2026.015" },
      object_name: { label: "chair" },
      brief_description: "A wooden kitchen chair.\nTwo lines, and a tab\there.",
      acquisition_method: "gift",
      [RIGHTS_FIELD_KEY]: RIGHTS,
    },
  });
  const scan = made({
    organizationId: org,
    kind: "digital_asset",
    mediaType: "image/tiff",
    represents: item.id,
    title: "Scan of the store photograph",
    templateKey: "dublin-core-digital-asset",
    recordTypeKey: "scan",
    fields: { resource_type: "StillImage", date_created: "1909~", [RIGHTS_FIELD_KEY]: RIGHTS },
  });
  const agent = made({
    organizationId: org,
    kind: "agent",
    agentType: "family",
    title: "Invented family",
    templateKey: "authority",
    fields: { note: "A family invented for tests.", staff_note: ["Not a real family."] },
  });
  const place = made({
    organizationId: org,
    kind: "place",
    coordinates: { lat: 29.4608, lng: -95.0513 },
    title: "Example Town",
    templateKey: "authority",
  });
  const unplaced = made({
    organizationId: org,
    kind: "place",
    title: "A place with no position",
    templateKey: "authority",
  });
  const event = made({
    organizationId: org,
    kind: "event",
    title: "An invented storm",
    templateKey: "authority",
    fields: { note: "Numbers: 0.1, 1e21, -3." },
  });
  return [fonds, item, object, scan, agent, place, unplaced, event];
}

const identifierChecker = (org: OrganizationId): TemplateCheckOptions => {
  const checker = ok(
    makeIdentifierChecker(
      [
        {
          key: "call_number",
          label: "Call number",
          pattern: "MS-####.#",
          organizationId: org,
          uniqueness: "current",
          public: true,
        },
        {
          key: "accession_number",
          label: "Accession number",
          organizationId: org,
          uniqueness: "all_time",
          public: true,
        },
      ],
      org,
    ),
  );
  return { checkers: { identifier: checker }, allowMissingInherited: true };
};

const scanType = (org: OrganizationId): RecordType => ({
  key: "scan",
  organizationId: org,
  label: "Scan",
  description: "A scanned photograph or document.",
  kind: "digital_asset",
  defaultTemplateKey: "dublin-core-digital-asset",
});

/** A raw insert of a record row with only the given columns set. */
function rawRecord(columns: {
  id?: string;
  org?: string;
  kind?: string;
  template?: string | null;
  recordType?: string | null;
  title?: string;
  level?: string | null;
  parent?: string | null;
  mediaType?: string | null;
  represents?: string | null;
  agentType?: string | null;
  lat?: number | null;
  lng?: number | null;
  created?: string;
  updated?: string;
  fields?: string;
}) {
  const kind = columns.kind ?? "object";
  return sql`
    INSERT INTO public.records (id, organization_id, kind, template_key, record_type_key, title,
      level, parent_id, media_type, represents_id, agent_type, latitude, longitude, fields,
      created_at, updated_at)
    VALUES (${columns.id ?? newRecordId()}::uuid, ${columns.org ?? ARCHIVES}::uuid, ${kind},
      ${columns.template === undefined ? "spectrum-object" : columns.template},
      ${columns.recordType ?? null}, ${columns.title ?? "A raw row"},
      ${columns.level ?? null}, ${columns.parent ?? null}::uuid, ${columns.mediaType ?? null},
      ${columns.represents ?? null}::uuid, ${columns.agentType ?? null},
      ${columns.lat ?? null}::double precision, ${columns.lng ?? null}::double precision,
      ${columns.fields ?? "{}"}::jsonb,
      ${columns.created ?? T}::timestamptz, ${columns.updated ?? T}::timestamptz)`;
}

// ---------------------------------------------------------------------------

describe("organizations", () => {
  it("round-trip, and an unknown or malformed ID finds nothing", async () => {
    await ready();
    expect(ok(await readOrganization(db, ARCHIVES))).toEqual({
      id: ARCHIVES,
      name: "Invented Historical Society",
    });
    expect(await readOrganization(db, newOrganizationId())).toBeUndefined();
    expect(codes(await readOrganization(db, "not-a-uuid" as OrganizationId))).toEqual([
      "invalid_id",
    ]);
  });

  it("an invalid organization is refused before the database", async () => {
    await ready();
    expect(codes(await insertOrganization(db, { id: newOrganizationId(), name: " x" }))).toEqual([
      "untrimmed",
    ]);
  });

  it("the table refuses what core refuses: bad IDs and names", async () => {
    await ready();
    const v1 = "3f1c2a9e-8b7d-1c6e-9a1b-2d3e4f5a6b7c"; // version 1, not 4
    for (const query of [
      sql`INSERT INTO public.organizations (id, name) VALUES (${v1}::uuid, 'x')`,
      sql`INSERT INTO public.organizations (id, name) VALUES (${newOrganizationId()}::uuid, '')`,
      sql`INSERT INTO public.organizations (id, name) VALUES (${newOrganizationId()}::uuid, ' x')`,
      sql`INSERT INTO public.organizations (id, name) VALUES (${newOrganizationId()}::uuid, ${"a\nb"})`,
      sql`INSERT INTO public.organizations (id, name) VALUES (${newOrganizationId()}::uuid, ${"x".repeat(201)})`,
    ]) {
      expect((await refusedBy(query)).code).toBe(CHECK);
    }
  });
});

describe("templates", () => {
  it("every preset round-trips as each organization's own template", async () => {
    await ready();
    for (const org of [ARCHIVES, LIBRARY]) {
      for (const preset of STANDARD_PRESETS) {
        const stored = ok(await readTemplate(db, org, preset.key));
        expect(stored.version).toBe(1);
        expect(stored.template).toEqual(ok(templateFromPreset(preset, org)));
      }
    }
  });

  it("a new version gets the next number; the current one is the highest, and old ones stay", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Versions" }));
    const first = authorityTemplate(org);
    const second = { ...first, label: "Authority record (edited)" };
    expect(ok(await insertTemplateVersion(db, first)).version).toBe(1);
    expect(ok(await insertTemplateVersion(db, second)).version).toBe(2);
    expect(ok(await readTemplate(db, org, "authority"))).toEqual({ version: 2, template: second });
    expect(ok(await readTemplate(db, org, "authority", 1))).toEqual({
      version: 1,
      template: first,
    });
    expect(await readTemplate(db, org, "authority", 3)).toBeUndefined();
    expect(codes(await readTemplate(db, org, "authority", 0))).toEqual(["invalid_version"]);
    expect(codes(await readTemplate(db, org, "Not A Key"))).toEqual(["invalid_key"]);
  });

  it("an invalid template is refused before the database", async () => {
    await ready();
    const noOrganization = withoutOrganization(authorityTemplate(ARCHIVES));
    expect(codes(await insertTemplateVersion(db, noOrganization))).toContain(
      "invalid_organization",
    );
  });

  it("a row changed behind the application's back reads as issues, not as a template", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Tampered" }));
    ok(await insertTemplateVersion(db, authorityTemplate(org)));
    // A hand edit by the owner, past the append-only trigger (0008).
    await db.transaction(async (q) => {
      await q.execute(
        sql`ALTER TABLE public.template_versions DISABLE TRIGGER zzzz_template_versions_no_update`,
      );
      await q.execute(sql`
        UPDATE public.template_versions
        SET definition = jsonb_set(definition, '{fields,0,visibility}', '"everyone"')
        WHERE organization_id = ${org}::uuid`);
      await q.execute(
        sql`ALTER TABLE public.template_versions ENABLE ALWAYS TRIGGER zzzz_template_versions_no_update`,
      );
    });
    expect((await readTemplate(db, org, "authority"))?.ok).toBe(false);
  });
});

describe("record types", () => {
  it("round-trip, checked against their default template", async () => {
    await ready();
    const stored = ok(await insertRecordTypeVersion(db, scanType(ARCHIVES)));
    expect(stored.version).toBe(1);
    expect(ok(await readRecordType(db, ARCHIVES, "scan"))).toEqual({
      version: 1,
      recordType: scanType(ARCHIVES),
    });
    // The library has its own "scan" type key free: nothing is shared.
    expect(await readRecordType(db, LIBRARY, "scan")).toBeUndefined();
  });

  it("refuses a default template that doesn't fit, or that the organization doesn't have", async () => {
    await ready();
    expect(
      codes(
        await insertRecordTypeVersion(db, {
          ...scanType(ARCHIVES),
          key: "photo",
          defaultTemplateKey: "spectrum-object",
        }),
      ),
    ).toContain("template_wrong_kind");
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "No templates" }));
    // The archives and the library have the template; this organization doesn't.
    expect(codes(await insertRecordTypeVersion(db, scanType(org)))).toContain("unknown_template");
    expect(
      codes(await insertRecordTypeVersion(db, { ...scanType(org), kind: "spaceship" })),
    ).toContain("invalid_kind");
  });

  it("checks against the stored template, never one the caller hands in", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Objects only" }));
    const objects = { ...authorityTemplate(org), key: "objects-only", appliesTo: ["object"] };
    ok(await insertTemplateVersion(db, objects));
    // A made-up copy of the template claiming it applies to digital assets.
    const fake = { ...objects, appliesTo: ["object", "digital_asset"] };
    const type = { ...scanType(org), defaultTemplateKey: "objects-only" };
    const insertWith = insertRecordTypeVersion as (
      ...args: unknown[]
    ) => ReturnType<typeof insertRecordTypeVersion>;
    expect(codes(await insertWith(db, type, fake))).toContain("template_wrong_kind");
    expect(await readRecordType(db, org, "scan")).toBeUndefined();
    expect(
      await db.rows(sql`SELECT key FROM public.record_types WHERE organization_id = ${org}::uuid`),
    ).toEqual([]);
  });

  it("refuses the write if the default template changes between the check and the insert", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Racing" }));
    const photos = { ...authorityTemplate(org), key: "photos", appliesTo: ["digital_asset"] };
    ok(await insertTemplateVersion(db, photos));
    // Right after the template is read, someone saves a version that no
    // longer applies to digital assets.
    let raced = false;
    const racing: Queryable = {
      async rows<R extends Row = Row>(query: Sql): Promise<R[]> {
        const rows = await db.rows<R>(query);
        if (!raced) {
          raced = true;
          ok(await insertTemplateVersion(db, { ...photos, appliesTo: ["object"] }));
        }
        return rows;
      },
      execute: (query) => db.execute(query),
    };
    const type = { ...scanType(org), defaultTemplateKey: "photos" };
    expect(codes(await insertRecordTypeVersion(racing, type))).toEqual(["template_changed"]);
    expect(raced).toBe(true);
    expect(
      await db.rows(sql`SELECT key FROM public.record_types WHERE organization_id = ${org}::uuid`),
    ).toEqual([]);
    // Now checked against version 2, it is refused for what it is.
    expect(codes(await insertRecordTypeVersion(db, type))).toContain("template_wrong_kind");
  });
});

describe("records", () => {
  it("invented records of every kind round-trip through core's checks and the database", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Round trip" }));
    const templates: FieldTemplate[] = [];
    for (const preset of STANDARD_PRESETS) {
      templates.push(
        ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org)))).template,
      );
    }
    templates.push(ok(await insertTemplateVersion(db, authorityTemplate(org))).template);
    const registry = ok(indexTemplates(templates));
    const type = ok(await insertRecordTypeVersion(db, scanType(org))).recordType;
    const types = ok(indexRecordTypes([type], registry));
    const options = identifierChecker(org);

    const records = sampleRecords(org);
    expect(new Set(records.map((r) => r.kind)).size).toBe(6);
    for (const record of records) {
      // Parents and represented records are inserted first, as a service would.
      expect(checkRecordAgainstTemplate(record, registry, options)).toEqual([]);
      expect(ok(await insertRecordInTx(db, record))).toEqual(record);
    }
    for (const record of records) {
      const back = ok(await readRecord(db, org, record.id));
      expect(back).toEqual(record);
      expect(Object.isFrozen(back)).toBe(true);
      expect(checkRecordAgainstTemplate(back, registry, options)).toEqual([]);
      if (back.recordTypeKey !== undefined) expect(checkRecordType(back, types)).toEqual([]);
    }
  });

  it("keeps whole-millisecond timestamps exactly, and an edit time after the creation time", async () => {
    await ready();
    const record = ok(
      createRecord(
        {
          organizationId: ARCHIVES,
          kind: "object",
          title: "Timed",
          templateKey: "spectrum-object",
        },
        new Date(T),
      ),
    );
    const edited = { ...record, updatedAt: LATER };
    ok(await insertRecordInTx(db, edited));
    expect(ok(await readRecord(db, ARCHIVES, record.id))).toMatchObject({
      createdAt: T,
      updatedAt: LATER,
    });
  });

  it("a record without a template key, or an invalid one, is refused before the database", async () => {
    await ready();
    const keyless = ok(
      createRecord({ organizationId: ARCHIVES, kind: "object", title: "No template" }),
    );
    expect(codes(await insertRecordInTx(db, keyless))).toEqual(["no_template_key"]);
    expect(codes(await insertRecordInTx(db, { ...keyless, kind: "spaceship" }))).toEqual([
      "invalid_kind",
    ]);
  });

  it("reading needs the record's own organization, and a malformed ID finds nothing", async () => {
    await ready();
    const record = made({
      organizationId: ARCHIVES,
      kind: "object",
      title: "The archives' own",
      templateKey: "spectrum-object",
    });
    ok(await insertRecordInTx(db, record));
    expect(ok(await readRecord(db, ARCHIVES, record.id))).toEqual(record);
    expect(await readRecord(db, LIBRARY, record.id)).toBeUndefined();
    expect(await readRecord(db, ARCHIVES, newRecordId())).toBeUndefined();
    expect(codes(await readRecord(db, ARCHIVES, "x' OR '1'='1" as RecordId))).toEqual([
      "invalid_id",
    ]);
  });

  it("a row changed behind the application's back reads as issues", async () => {
    await ready();
    const record = made({
      organizationId: ARCHIVES,
      kind: "object",
      title: "Tampered",
      templateKey: "spectrum-object",
    });
    ok(await insertRecordInTx(db, record));
    await writeRecordDirectly(
      db,
      sql`UPDATE public.records SET fields = '{"Bad Key": 1}', version = version + 1
          WHERE id = ${record.id}::uuid`,
      ARCHIVES,
      record.id,
    );
    expect(codes(await readRecord(db, ARCHIVES, record.id))).toEqual(["invalid_field_key"]);
  });
});

describe("the tables back up core's rules against direct SQL", () => {
  it("kinds, levels, agent types and media types are core's lists", async () => {
    await ready();
    for (const query of [
      rawRecord({ kind: "spaceship" }),
      rawRecord({ kind: "archival_unit", level: "drawer", template: "dacs-archival-unit" }),
      rawRecord({ kind: "agent", agentType: "robot", template: "authority" }),
      rawRecord({
        kind: "digital_asset",
        mediaType: "Image/TIFF",
        template: "dublin-core-digital-asset",
      }),
    ]) {
      expect((await refusedBy(query)).code).toBe(CHECK);
    }
  });

  it("each kind has exactly its own columns", async () => {
    await ready();
    const unit = newRecordId();
    await writeRecordDirectly(
      db,
      rawRecord({
        id: unit,
        kind: "archival_unit",
        level: "fonds",
        template: "dacs-archival-unit",
      }),
      ARCHIVES,
      unit,
    );
    for (const query of [
      rawRecord({ kind: "archival_unit", template: "dacs-archival-unit" }), // no level
      rawRecord({ kind: "object", level: "item" }),
      rawRecord({ kind: "object", parent: unit }),
      rawRecord({ kind: "digital_asset", template: "dublin-core-digital-asset" }), // no media type
      rawRecord({ kind: "object", mediaType: "image/tiff" }),
      rawRecord({ kind: "object", represents: unit }),
      rawRecord({ kind: "agent", template: "authority" }), // no agent type
      rawRecord({ kind: "event", agentType: "person", template: "authority" }),
      rawRecord({ kind: "object", lat: 1, lng: 1 }),
      rawRecord({ kind: "place", lat: 1, template: "authority" }), // half a position
      rawRecord({ kind: "place", lat: 91, lng: 0, template: "authority" }),
    ]) {
      expect((await refusedBy(query)).code).toBe(CHECK);
    }
  });

  it("no record is its own parent or represents itself", async () => {
    await ready();
    const id = newRecordId();
    expect(
      await refusedBy(
        rawRecord({
          id,
          kind: "archival_unit",
          level: "item",
          parent: id,
          template: "dacs-archival-unit",
        }),
      ),
    ).toEqual({ code: CHECK, constraint: "records_not_own_parent" });
    expect(
      (
        await refusedBy(
          rawRecord({
            id,
            kind: "digital_asset",
            mediaType: "image/tiff",
            represents: id,
            template: "dublin-core-digital-asset",
          }),
        )
      ).constraint,
    ).toBe("records_not_own_representation");
  });

  it("a parent or represented record must exist", async () => {
    await ready();
    expect(
      (
        await refusedBy(
          rawRecord({
            kind: "archival_unit",
            level: "item",
            parent: newRecordId(),
            template: "dacs-archival-unit",
          }),
        )
      ).code,
    ).toBe(FOREIGN_KEY);
    expect(
      await refusedBy(
        rawRecord({
          kind: "digital_asset",
          mediaType: "image/tiff",
          represents: newRecordId(),
          template: "dublin-core-digital-asset",
        }),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: "records_organization_id_represents_id_fkey" });
  });

  it("titles, keys, fields and timestamps follow core's rules", async () => {
    await ready();
    for (const query of [
      rawRecord({ title: "" }),
      rawRecord({ title: " padded " }),
      rawRecord({ title: "two\nlines" }),
      rawRecord({ title: "x".repeat(1001) }),
      rawRecord({ fields: "[]" }),
      rawRecord({ updated: "2026-11-19T00:00:00.000Z" }), // before created
      rawRecord({ created: "2026-11-20T16:05:00.000001Z", updated: LATER }), // finer than core keeps
    ]) {
      expect((await refusedBy(query)).code).toBe(CHECK);
    }
    expect((await refusedBy(rawRecord({ template: null }))).code).toBe(NOT_NULL);
    expect(
      (
        await refusedBy(
          sql`INSERT INTO public.templates (organization_id, key) VALUES (${ARCHIVES}::uuid, 'constructor')`,
        )
      ).code,
    ).toBe(CHECK);
    expect(
      (
        await refusedBy(
          sql`INSERT INTO public.templates (organization_id, key) VALUES (${ARCHIVES}::uuid, 'Upper')`,
        )
      ).code,
    ).toBe(CHECK);
  });

  it("a stored template's JSON must name its own row's key and organization", async () => {
    await ready();
    const mine = authorityTemplate(ARCHIVES);
    const json = (value: unknown) => JSON.stringify(value);
    for (const definition of [
      { ...mine, key: "other" },
      { ...mine, organizationId: LIBRARY },
      withoutOrganization(mine),
    ]) {
      expect(
        (
          await refusedBy(sql`
            INSERT INTO public.template_versions (organization_id, key, version, definition)
            VALUES (${ARCHIVES}::uuid, 'authority', 99, ${json(definition)}::jsonb)`)
        ).code,
      ).toBe(CHECK);
    }
  });

  it("an organization, template or record others point at can't be deleted", async () => {
    await ready();
    expect(
      (await refusedBy(sql`DELETE FROM public.organizations WHERE id = ${ARCHIVES}::uuid`)).code,
    ).toBe(FOREIGN_KEY);
    expect(
      (
        await refusedBy(
          sql`DELETE FROM public.templates WHERE organization_id = ${ARCHIVES}::uuid AND key = 'authority'`,
        )
      ).code,
    ).toBe(FOREIGN_KEY);
  });
});

describe("organizations stay separate, even through direct SQL", () => {
  async function archivesUnit(): Promise<RecordId> {
    const unit = made({
      organizationId: ARCHIVES,
      kind: "archival_unit",
      level: "fonds",
      title: "The archives' fonds",
      templateKey: "dacs-archival-unit",
    });
    ok(await insertRecordInTx(db, unit));
    return unit.id;
  }

  it("a record can't be filed under another organization's unit", async () => {
    await ready();
    const parent = await archivesUnit();
    expect(
      await refusedBy(
        rawRecord({
          org: LIBRARY,
          kind: "archival_unit",
          level: "item",
          parent,
          template: "dacs-archival-unit",
        }),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: "records_organization_id_parent_id_fkey" });
    // Nor through the data-access module.
    const child = made({
      organizationId: LIBRARY,
      kind: "archival_unit",
      level: "item",
      parentId: parent,
      title: "The library's item",
      templateKey: "dacs-archival-unit",
    });
    await expect(insertRecordInTx(db, child)).rejects.toMatchObject({ code: FOREIGN_KEY });
  });

  it("a file can't represent another organization's record", async () => {
    await ready();
    const represents = await archivesUnit();
    expect(
      await refusedBy(
        rawRecord({
          org: LIBRARY,
          kind: "digital_asset",
          mediaType: "image/tiff",
          represents,
          template: "dublin-core-digital-asset",
        }),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: "records_organization_id_represents_id_fkey" });
  });

  it("a record can't follow another organization's template or record type", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "No templates of its own" }));
    expect(await refusedBy(rawRecord({ org, template: "spectrum-object" }))).toEqual({
      code: FOREIGN_KEY,
      constraint: "records_organization_id_template_key_fkey",
    });
    ok(await insertRecordTypeVersion(db, { ...scanType(ARCHIVES), key: "archives-only" }));
    expect(
      await refusedBy(
        rawRecord({
          org: LIBRARY,
          kind: "digital_asset",
          mediaType: "image/tiff",
          recordType: "archives-only",
          template: "dublin-core-digital-asset",
        }),
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: "records_organization_id_record_type_key_fkey" });
  });

  it("a record type can't default to another organization's template", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Borrower" }));
    await db.execute(
      sql`INSERT INTO public.record_types (organization_id, key) VALUES (${org}::uuid, 'scan')`,
    );
    const definition = JSON.stringify(scanType(org));
    expect(
      await refusedBy(sql`
        INSERT INTO public.record_type_versions
          (organization_id, key, version, kind, default_template_key, definition)
        VALUES (${org}::uuid, 'scan', 1, 'digital_asset', 'dublin-core-digital-asset', ${definition}::jsonb)`),
    ).toEqual({
      code: FOREIGN_KEY,
      constraint: "record_type_versions_organization_id_default_template_key_fkey",
    });
  });

  it("a template version can't be filed under another organization's template", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Squatter" }));
    // The JSON names the new organization, matching the row, so the checks
    // pass; but that organization has no "authority" template of its own
    // (only the archives and the library do), so the foreign key refuses it.
    const theirs = JSON.stringify(authorityTemplate(org));
    expect(
      await refusedBy(sql`
        INSERT INTO public.template_versions (organization_id, key, version, definition)
        VALUES (${org}::uuid, 'authority', 1, ${theirs}::jsonb)`),
    ).toEqual({ code: FOREIGN_KEY, constraint: "template_versions_organization_id_key_fkey" });
  });

  it("an exact-type to_jsonb overload can't switch the identity check off", async () => {
    await ready();
    const lone = made({
      organizationId: ARCHIVES,
      kind: "object",
      title: "A shadowed chair",
      templateKey: "spectrum-object",
    });
    ok(await insertRecordInTx(db, lone));
    // An overload for the exact row type beats pg_catalog.to_jsonb(anyelement)
    // unless the trigger function's search path is fixed.
    await db.execute(sql`CREATE FUNCTION public.to_jsonb(public.records) RETURNS jsonb
      LANGUAGE sql AS 'SELECT ''{}''::jsonb'`);
    try {
      expect(
        await refusedBy(
          sql`UPDATE public.records SET organization_id = ${LIBRARY}::uuid
              WHERE organization_id = ${ARCHIVES}::uuid AND id = ${lone.id}::uuid`,
        ),
      ).toEqual({ code: IDENTITY, constraint: "records_organization_id_fixed" });
    } finally {
      await db.execute(sql`DROP FUNCTION public.to_jsonb(public.records)`);
    }
  });

  it("moving a record, a unit with children or a lone record to another organization is refused", async () => {
    await ready();
    const parent = await archivesUnit();
    const child = made({
      organizationId: ARCHIVES,
      kind: "archival_unit",
      level: "series",
      parentId: parent,
      title: "A series",
      templateKey: "dacs-archival-unit",
    });
    ok(await insertRecordInTx(db, child));
    // A lone record: nothing points at it and it points at nothing but its
    // template, which the library has under the same key.
    const lone = made({
      organizationId: ARCHIVES,
      kind: "object",
      title: "A lone chair",
      templateKey: "spectrum-object",
    });
    ok(await insertRecordInTx(db, lone));
    for (const id of [lone.id, child.id, parent]) {
      expect(
        await refusedBy(
          sql`UPDATE public.records SET organization_id = ${LIBRARY}::uuid
              WHERE organization_id = ${ARCHIVES}::uuid AND id = ${id}::uuid`,
        ),
      ).toEqual({ code: IDENTITY, constraint: "records_organization_id_fixed" });
    }
    // Nor can it take another ID.
    expect(
      await refusedBy(
        sql`UPDATE public.records SET id = ${newRecordId()}::uuid
            WHERE organization_id = ${ARCHIVES}::uuid AND id = ${lone.id}::uuid`,
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_id_fixed" });
    expect(ok(await readRecord(db, ARCHIVES, lone.id))).toEqual(lone);
    expect(await readRecord(db, LIBRARY, lone.id)).toBeUndefined();
    // Other columns can still be edited.
    expect(
      await writeRecordDirectly(
        db,
        sql`UPDATE public.records SET title = 'A lone chair, edited', version = version + 1
            WHERE organization_id = ${ARCHIVES}::uuid AND id = ${lone.id}::uuid`,
        ARCHIVES,
        lone.id,
      ),
    ).toBe(1);
  });

  it("templates, record types and their versions can't move to another organization or be renumbered", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Movers" }));
    ok(await insertTemplateVersion(db, authorityTemplate(org)));
    ok(await insertTemplateVersion(db, { ...authorityTemplate(org), label: "Second" }));
    const dublinCore = STANDARD_PRESETS.find((p) => p.key === "dublin-core-digital-asset");
    ok(await insertTemplateVersion(db, ok(templateFromPreset(dublinCore, org))));
    ok(await insertRecordTypeVersion(db, scanType(org)));
    // A template identity with no versions, which nothing points at.
    await db.execute(
      sql`INSERT INTO public.templates (organization_id, key) VALUES (${org}::uuid, 'unused')`,
    );
    const where = sql`organization_id = ${org}::uuid`;
    const attempts: [Sql, string][] = [
      [
        sql`UPDATE public.templates SET organization_id = ${LIBRARY}::uuid WHERE ${where} AND key = 'unused'`,
        "templates_organization_id_fixed",
      ],
      [
        sql`UPDATE public.templates SET key = 'renamed' WHERE ${where} AND key = 'unused'`,
        "templates_key_fixed",
      ],
      // The library has an "authority" template too, so only the trigger stops these.
      [
        sql`UPDATE public.template_versions
            SET organization_id = ${LIBRARY}::uuid,
                definition = jsonb_set(definition, '{organizationId}', to_jsonb(${LIBRARY}::text))
            WHERE ${where} AND key = 'authority' AND version = 2`,
        "template_versions_organization_id_fixed",
      ],
      [
        sql`UPDATE public.template_versions SET version = 7 WHERE ${where} AND key = 'authority' AND version = 2`,
        "template_versions_version_fixed",
      ],
      [
        sql`UPDATE public.record_type_versions
            SET organization_id = ${LIBRARY}::uuid,
                definition = jsonb_set(definition, '{organizationId}', to_jsonb(${LIBRARY}::text))
            WHERE ${where} AND key = 'scan'`,
        "record_type_versions_organization_id_fixed",
      ],
      [
        sql`UPDATE public.record_types SET organization_id = ${LIBRARY}::uuid WHERE ${where} AND key = 'scan'`,
        "record_types_organization_id_fixed",
      ],
    ];
    for (const [query, constraint] of attempts) {
      expect(await refusedBy(query)).toEqual({ code: IDENTITY, constraint });
    }
    expect(ok(await readTemplate(db, org, "authority"))).toMatchObject({ version: 2 });
    expect(ok(await readRecordType(db, org, "scan")).recordType.organizationId).toBe(org);
  });

  it("an organization's ID never changes", async () => {
    await ready();
    const org = newOrganizationId();
    ok(await insertOrganization(db, { id: org, name: "Lone organization" }));
    expect(
      await refusedBy(
        sql`UPDATE public.organizations SET id = ${newOrganizationId()}::uuid WHERE id = ${org}::uuid`,
      ),
    ).toEqual({ code: IDENTITY, constraint: "organizations_id_fixed" });
  });

  it("two organizations can hold the same record ID; one organization can't hold it twice", async () => {
    await ready();
    const mine = made({
      organizationId: ARCHIVES,
      kind: "object",
      title: "The archives' chair",
      templateKey: "spectrum-object",
    });
    ok(await insertRecordInTx(db, mine));
    // The library gets the same ID (by chance, or because it guessed it): it
    // is stored, and nothing tells the library the archives has it.
    const theirs = { ...mine, organizationId: LIBRARY, title: "The library's chair" };
    ok(await insertRecordInTx(db, theirs));
    expect(ok(await readRecord(db, ARCHIVES, mine.id))).toEqual(mine);
    expect(ok(await readRecord(db, LIBRARY, mine.id))).toEqual(theirs);
    await expect(insertRecordInTx(db, { ...mine, title: "Again" })).rejects.toMatchObject({
      code: UNIQUE,
      constraint: "records_pkey",
    });
  });

  it("two organizations can use the same template and record type keys", async () => {
    await ready();
    const archives = ok(await readTemplate(db, ARCHIVES, "spectrum-object")).template;
    const library = ok(await readTemplate(db, LIBRARY, "spectrum-object")).template;
    expect(archives.organizationId).toBe(ARCHIVES);
    expect(library.organizationId).toBe(LIBRARY);
    ok(await insertRecordTypeVersion(db, scanType(LIBRARY)));
    expect(ok(await readRecordType(db, LIBRARY, "scan")).recordType.organizationId).toBe(LIBRARY);
  });
});
