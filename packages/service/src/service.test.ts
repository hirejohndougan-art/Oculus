// The service layer (service.ts, T-032, D-067): the one writer. Saves are
// checked in their transaction, organizations stay apart (D-019), refusals
// are clean issues, deletion leaves a tombstone, races between two
// connections resolve cleanly, and no other database role can write around
// the service.
import { afterAll, describe, expect, it } from "vitest";
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type Issue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import {
  WRITER_PRIVILEGES,
  allocateIdentifier,
  checkWriterConnection,
  deleteRecord,
  grantWriterRole,
  insertIdentifierType,
  insertOrganization,
  insertRecordTypeVersion,
  insertTemplateVersion,
  lockDefinition,
  migrate,
  openDatabase,
  readRecordIdentifiers,
  readStoredRecord,
  readVersion,
  readVersions,
  recordsUsingTerm,
  saveTerm,
  sql,
  updateIdentifierType,
  termKey,
  type Database,
  type Queryable,
  type Sql,
} from "@oculus/db";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { createService, type RecordService, type ServiceResult } from "./service.js";

const ALICE = "user:3f1c2a9e-8b7d-4c6e-9a5b-1d2e3f4a5b6c";
const BOB = "user:9b2e4c1a-7d3f-4e8a-b5c6-1a2b3c4d5e6f";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const DENIED = "42501";
const IDENTITY = "23000";
const RAILROADS = {
  label: "Railroads",
  vocabulary: "lcsh",
  uri: "http://id.loc.gov/authorities/subjects/sh85110870",
};

// ---------------------------------------------------------------------------
// One migrated database for the file; roles made for it and dropped after.

interface Setup {
  testDb: TestDatabase;
  /** The owner (the migrating role): sets up organizations and templates. */
  owner: Database;
  /** Two pools as the writer role: the service's, and a second connection. */
  writer: Database;
  writer2: Database;
  /** A role with SELECT only, and a role with nothing. */
  reader: Database;
  nobody: Database;
  roles: string[];
}

let setup: Promise<Setup> | undefined;
let s: Setup;
let service: RecordService;
let service2: RecordService;

/** Runs a statement with a role name quoted by format('%I'). */
async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

function urlAs(url: string, role: string): string {
  const u = new URL(url);
  u.username = role;
  return u.toString();
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
    const roles = [
      "writer",
      "reader",
      "nobody",
      "member",
      "dbowner",
      "creator",
      "probe",
      "bypasser",
      "helper",
      "hostowner",
      "hostwriter",
    ].map((r) => `oculus_t032_${r}_${suffix}`);
    const [writerRole = "", readerRole = "", nobodyRole = ""] = roles;
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      for (const role of roles)
        await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", role));
    } finally {
      await server.close();
    }
    const owner = openDatabase(testDb.url, { max: 4 });
    await owner.transaction(async (q) => {
      await grantWriterRole(q, writerRole);
      await withRole(q, "GRANT USAGE ON SCHEMA public TO %I", readerRole);
      await withRole(q, "GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I", readerRole);
    });
    return {
      testDb,
      owner,
      writer: as(testDb.url, writerRole),
      writer2: as(testDb.url, writerRole),
      reader: as(testDb.url, readerRole),
      nobody: as(testDb.url, nobodyRole),
      roles,
    };
  })();
  s = await setup;
  service = createService(s.writer, { now: () => NOW });
  service2 = createService(s.writer2, { now: () => NOW });
}

afterAll(async () => {
  const done = await setup?.catch(() => undefined);
  if (!done) return;
  for (const pool of [done.writer, done.writer2, done.reader, done.nobody, done.owner]) {
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

function codes(result: { ok: boolean; issues?: readonly Issue[] } | undefined): string[] {
  if (result === undefined) throw new Error("not found");
  return result.ok ? [] : (result.issues ?? []).map((i) => i.code);
}

function field(key: string, kind: string, extra: Record<string, unknown> = {}) {
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

/** A new organization with templates for objects, units, agents and scans, and a number type. */
async function organization(): Promise<OrganizationId> {
  const org = newOrganizationId();
  ok(await insertOrganization(s.owner, { id: org, name: "Invented Society" }));
  ok(
    await insertTemplateVersion(s.owner, {
      key: "invented-object",
      organizationId: org,
      label: "Invented objects",
      appliesTo: ["object"],
      fields: [
        field("note", "text"),
        field("number", "identifier"),
        field("creator", "record_link", { recordKinds: ["agent"] }),
        field("subjects", "controlled_term", { repeatable: true }),
        field("found_at", "place"),
        field("shown_at", "place", { repeatable: true }),
      ],
    }),
  );
  for (const [key, kind] of [
    ["invented-unit", "archival_unit"],
    ["invented-agent", "agent"],
    ["invented-asset", "digital_asset"],
    ["invented-place", "place"],
  ] as const) {
    ok(
      await insertTemplateVersion(s.owner, {
        key,
        organizationId: org,
        label: key,
        appliesTo: [kind],
        fields: [field("note", "text")],
      }),
    );
  }
  ok(
    await insertRecordTypeVersion(s.owner, {
      key: "chair",
      organizationId: org,
      label: "Chair",
      kind: "object",
      defaultTemplateKey: "invented-object",
    }),
  );
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

const ctx = (organizationId: OrganizationId, actor = ALICE) => ({ organizationId, actor });

function objectDraft(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "object",
    title: "An invented chair",
    templateKey: "invented-object",
    fields: { note: "Oak.", ...fields },
  };
}

function unitDraft(level: string, parentId?: RecordId): Record<string, unknown> {
  return {
    kind: "archival_unit",
    level,
    title: `An invented ${level}`,
    templateKey: "invented-unit",
    ...(parentId === undefined ? {} : { parentId }),
  };
}

const agentDraft = {
  kind: "agent",
  agentType: "person",
  title: "An invented maker",
  templateKey: "invented-agent",
};

function numbers(...values: string[]) {
  return {
    current: values.map((value, i) => ({ type: "object_number", value, primary: i === 0 })),
    former: [],
  };
}

async function create(
  org: OrganizationId,
  draft: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<CatalogRecord> {
  return ok(await service.createRecord(ctx(org), draft, options)).record;
}

/** The draft of a stored record, as an editor would send it back. */
function draftOf(record: CatalogRecord, changes: Record<string, unknown> = {}) {
  return { ...record, ...changes };
}

async function versionCount(org: OrganizationId, id: RecordId): Promise<number> {
  return ok(await readVersions(s.owner, org, id)).versions.length;
}

async function rowExists(org: OrganizationId, id: RecordId): Promise<boolean> {
  const rows = await s.owner.rows(sql`
    SELECT 1 FROM public.records WHERE organization_id = ${org}::uuid AND id = ${id}::uuid`);
  return rows.length > 0;
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

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until some connection to the test database is waiting for a lock. */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [row] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("No connection waited for a lock.");
}

/** Every message of a result, as one text, to look for leaks. */
function messages(result: { ok: boolean; issues?: readonly Issue[] }): string {
  return JSON.stringify(result.ok ? [] : result.issues);
}

// ---------------------------------------------------------------------------

describe("the writer role", () => {
  it("the service connects as a role fit to write; the owner is not", async () => {
    await ready();
    expect(await service.checkConnection()).toEqual([]);
    const asOwner = createService(s.owner);
    expect((await asOwner.checkConnection()).map((p) => p.code)).toContain("owner");
    expect((await createService(s.reader).checkConnection()).map((p) => p.code)).toEqual([
      "missing_privilege",
    ]);
    // D-063's grants alone (no DELETE on records) are not enough now.
    const writerRole = s.roles[0] ?? "";
    await s.owner.transaction((q) =>
      withRole(q, "REVOKE DELETE ON public.records FROM %I", writerRole),
    );
    try {
      expect((await service.checkConnection()).map((p) => p.code)).toEqual(["missing_privilege"]);
    } finally {
      await s.owner.transaction((q) =>
        withRole(q, "GRANT DELETE ON public.records TO %I", writerRole),
      );
    }
    expect(await service.checkConnection()).toEqual([]);
  });

  it("grants only to a plainly named role", async () => {
    await ready();
    for (const name of ["Bad-Name", "x; DROP TABLE records", "", "a".repeat(64)]) {
      await expect(s.owner.transaction((q) => grantWriterRole(q, name))).rejects.toThrow(TypeError);
    }
  });

  it("refuses a role that is (or may become) an owner, can create roles, or lacks any grant", async () => {
    await ready();
    const [, , , ownerMember = "", databaseOwner = "", creator = ""] = s.roles;
    const [ownerRow] = await s.owner.rows<{ name: string }>(sql`SELECT current_user AS name`);
    const ownerRole = ownerRow?.name ?? "";
    const problems = async (role: string): Promise<string[]> => {
      const pool = as(s.testDb.url, role);
      try {
        return (await createService(pool).checkConnection()).map((p) => p.code);
      } finally {
        await pool.close();
      }
    };
    await s.owner.transaction(async (q) => {
      for (const role of [ownerMember, databaseOwner, creator]) await grantWriterRole(q, role);
    });
    // A NOINHERIT member of the owner can still SET ROLE to it.
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction(async (q) => {
        await withRole(q, "ALTER ROLE %I NOINHERIT", ownerMember);
        await q.rows(sql`SELECT set_config('oculus_test.owner', ${ownerRole}, true),
                                set_config('oculus_test.role', ${ownerMember}, true)`);
        await q.execute(sql`DO $$ BEGIN
          EXECUTE format('GRANT %I TO %I', current_setting('oculus_test.owner'),
                         current_setting('oculus_test.role'));
        END $$`);
        await withRole(q, "ALTER ROLE %I CREATEROLE", creator);
      });
    } finally {
      await server.close();
    }
    // A member of the (superuser) owner: any membership is refused, and so
    // is ownership through it.
    expect(await problems(ownerMember)).toEqual(["role_membership", "owner"]);
    expect(await problems(creator)).toEqual(["createrole"]);
    // The database's owner (and so a member of pg_database_owner, which owns
    // schema public).
    const setOwner = async (role: string): Promise<void> => {
      const admin = openDatabase(testServerUrl(), { max: 1 });
      try {
        await admin.transaction(async (q) => {
          await q.rows(sql`SELECT set_config('oculus_test.db', ${s.testDb.name}, true),
                                  set_config('oculus_test.role', ${role}, true)`);
          await q.execute(sql`DO $$ BEGIN
            EXECUTE format('ALTER DATABASE %I OWNER TO %I', current_setting('oculus_test.db'),
                           current_setting('oculus_test.role'));
          END $$`);
        });
      } finally {
        await admin.close();
      }
    };
    await setOwner(databaseOwner);
    try {
      expect(await problems(databaseOwner)).toEqual(expect.arrayContaining(["owner"]));
    } finally {
      await setOwner(ownerRole);
    }
    expect(await problems(databaseOwner)).toEqual([]);
    // Each grant missing in turn.
    const writerRole = s.roles[0] ?? "";
    for (const [table, privileges] of Object.entries(WRITER_PRIVILEGES)) {
      for (const privilege of [...privileges, "SELECT"]) {
        const statement = (verb: string) =>
          `${verb} ${privilege} ON public.${table} ${verb === "GRANT" ? "TO" : "FROM"} %I`;
        await s.owner.transaction((q) => withRole(q, statement("REVOKE"), writerRole));
        try {
          expect({
            table,
            privilege,
            codes: (await service.checkConnection()).map((p) => p.code),
          }).toEqual({
            table,
            privilege,
            codes: ["missing_privilege"],
          });
        } finally {
          await s.owner.transaction((q) => withRole(q, statement("GRANT"), writerRole));
        }
      }
    }
    expect(await service.checkConnection()).toEqual([]);
  });

  it("refuses a login that can defeat the triggers some other way", async () => {
    await ready();
    const [, , , , , creator = "", probe = "", , helper = ""] = s.roles;
    /** Runs a statement with up to two role or object names, quoted by format('%I'). */
    const run = async (on: Database, statement: string, ...names: string[]): Promise<void> => {
      await on.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('oculus_test.statement', ${statement}, true),
                                set_config('oculus_test.a', ${names[0] ?? ""}, true),
                                set_config('oculus_test.b', ${names[1] ?? ""}, true)`);
        await q.execute(sql`DO $$ BEGIN
          EXECUTE format(current_setting('oculus_test.statement'),
                         current_setting('oculus_test.a'), current_setting('oculus_test.b'));
        END $$`);
      });
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    // A new connection each time: role and database settings apply to new
    // sessions only.
    const probeCodes = async (): Promise<string[]> => {
      const fresh = as(s.testDb.url, probe);
      try {
        return (await createService(fresh).checkConnection()).map((p) => p.code);
      } finally {
        await fresh.close();
      }
    };
    try {
      await s.owner.transaction((q) => grantWriterRole(q, probe));
      // The helper holds TRIGGER: a member could SET ROLE to it (B1).
      await run(s.owner, "GRANT TRIGGER ON public.record_versions TO %I", helper);
      expect(await probeCodes()).toEqual([]);
      const [version] = await s.owner.rows<{ n: number }>(
        sql`SELECT current_setting('server_version_num')::integer AS n`,
      );
      const pg16 = (version?.n ?? 0) >= 160000;
      const db = s.testDb.name;
      type Case = [on: Database, grant: string, revoke: string, names: string[], codes: string[]];
      const membership = (role: string, options = ""): Case => [
        server,
        `GRANT %I TO %I${options}`,
        "REVOKE %I FROM %I",
        [role, probe],
        ["role_membership"],
      ];
      const attribute = (on: string, off: string, codes: string[]): Case => [
        server,
        `ALTER ROLE %I ${on}`,
        `ALTER ROLE %I ${off}`,
        [probe],
        codes,
      ];
      const onTable = (what: string, to = "%I"): Case => [
        s.owner,
        `GRANT ${what} TO ${to}`,
        `REVOKE ${what} FROM ${to}`,
        to === "%I" ? [probe] : [],
        [what.includes("(") ? "column_privilege" : "extra_privilege"],
      ];
      const cases: Case[] = [
        // Any membership at all, whatever it carries (B1, B3).
        membership(creator),
        membership(helper),
        ...(pg16
          ? [
              membership(helper, " WITH INHERIT FALSE"),
              membership(helper, " WITH ADMIN TRUE, INHERIT FALSE, SET FALSE"),
              membership("pg_create_subscription"),
            ]
          : []),
        membership("pg_signal_backend"),
        membership("pg_write_server_files"),
        membership("pg_execute_server_program"),
        membership("pg_read_server_files"),
        membership("pg_write_all_data"),
        // Attributes.
        attribute("SUPERUSER", "NOSUPERUSER", ["superuser", "owner"]),
        attribute("CREATEROLE", "NOCREATEROLE", ["createrole"]),
        attribute("BYPASSRLS", "NOBYPASSRLS", ["bypasses_row_security"]),
        attribute("REPLICATION", "NOREPLICATION", ["replication"]),
        // Parameters, to the role or to PUBLIC.
        [
          server,
          "GRANT SET ON PARAMETER session_replication_role TO %I",
          "REVOKE SET ON PARAMETER session_replication_role FROM %I",
          [probe],
          ["object_privilege", "parameter_privilege"],
        ],
        [
          server,
          "GRANT SET ON PARAMETER session_replication_role TO PUBLIC",
          "REVOKE SET ON PARAMETER session_replication_role FROM PUBLIC",
          [],
          ["parameter_privilege"],
        ],
        [
          server,
          "GRANT ALTER SYSTEM ON PARAMETER work_mem TO %I",
          "REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM %I",
          [probe],
          ["object_privilege", "parameter_privilege"],
        ],
        // CREATE on the database (B3) or on schema public, to the role or to PUBLIC.
        [
          server,
          "GRANT CREATE ON DATABASE %I TO %I",
          "REVOKE CREATE ON DATABASE %I FROM %I",
          [db, probe],
          ["database_create"],
        ],
        [
          server,
          "GRANT CREATE ON DATABASE %I TO PUBLIC",
          "REVOKE CREATE ON DATABASE %I FROM PUBLIC",
          [db],
          ["database_create"],
        ],
        [
          s.owner,
          "GRANT CREATE ON SCHEMA public TO %I",
          "REVOKE CREATE ON SCHEMA public FROM %I",
          [probe],
          ["schema_create"],
        ],
        [
          s.owner,
          "GRANT CREATE ON SCHEMA public TO PUBLIC",
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
          [],
          ["schema_create"],
        ],
        // Any table privilege beyond the writer's, to the role or to PUBLIC.
        onTable("TRIGGER ON public.record_versions"),
        onTable("TRUNCATE ON public.records"),
        onTable("REFERENCES ON public.templates"),
        onTable("DELETE ON public.templates"),
        onTable("UPDATE ON public.record_versions"),
        onTable("UPDATE ON public.record_identifiers"),
        onTable("SELECT ON public.records", "PUBLIC"),
        onTable("DELETE ON public.records", "PUBLIC"),
        // Any column privilege (B2), to the role or to PUBLIC.
        onTable("UPDATE (definition) ON public.template_versions"),
        onTable("SELECT (title) ON public.records", "PUBLIC"),
        // Default privileges on future objects.
        [
          s.owner,
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO %I",
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM %I",
          [probe],
          ["object_privilege", "default_privilege"],
        ],
        [
          s.owner,
          "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
          "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC",
          [],
          ["default_privilege"],
        ],
        // Privileges on objects besides public's tables (pg_shdepend).
        [
          s.owner,
          "GRANT EXECUTE ON FUNCTION public.arrangement_lock(uuid) TO %I",
          "REVOKE EXECUTE ON FUNCTION public.arrangement_lock(uuid) FROM %I",
          [probe],
          ["object_privilege"],
        ],
        // Settings for the role's new sessions (B2): replica mode is refused
        // twice over (the setting, and the session it starts in).
        [
          server,
          "ALTER ROLE %I SET session_replication_role = replica",
          "ALTER ROLE %I RESET session_replication_role",
          [probe],
          ["replication_role", "role_setting"],
        ],
        [
          server,
          "ALTER ROLE %I IN DATABASE %I SET session_replication_role = replica",
          "ALTER ROLE %I IN DATABASE %I RESET session_replication_role",
          [probe, db],
          ["replication_role", "role_setting"],
        ],
        [
          server,
          "ALTER ROLE %I IN DATABASE %I SET search_path = 'somewhere_else'",
          "ALTER ROLE %I IN DATABASE %I RESET search_path",
          [probe, db],
          ["role_setting"],
        ],
      ];
      for (const [on, grant, revoke, names, codes] of cases) {
        await run(on, grant, ...names);
        try {
          expect({ grant, found: await probeCodes() }).toEqual({ grant, found: codes });
        } finally {
          await run(on, revoke, ...names);
        }
        expect({ revoke, found: await probeCodes() }).toEqual({ revoke, found: [] });
      }
      // A revoke-only default (EXECUTE on functions kept for PUBLIC) is fine.
      await run(s.owner, "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I", probe);
      expect(await probeCodes()).toEqual([]);
      // GRANT OPTION on its own privileges would let it hand them on: refused.
      await run(s.owner, "GRANT SELECT ON public.records TO %I WITH GRANT OPTION", probe);
      try {
        expect(await probeCodes()).toEqual(["extra_privilege"]);
      } finally {
        await run(s.owner, "REVOKE GRANT OPTION FOR SELECT ON public.records FROM %I", probe);
      }
      // Time limits for the writer's sessions are allowed.
      await run(server, "ALTER ROLE %I IN DATABASE %I SET lock_timeout = '5s'", probe, db);
      try {
        expect(await probeCodes()).toEqual([]);
      } finally {
        await run(server, "ALTER ROLE %I IN DATABASE %I RESET lock_timeout", probe, db);
      }
      // A schema it owns, and one it may use or create in.
      await run(s.owner, "CREATE SCHEMA %I AUTHORIZATION %I", `t032_${probe}`, probe);
      try {
        expect(await probeCodes()).toEqual(["owns_object", "schema_create"]);
      } finally {
        await run(s.owner, "DROP SCHEMA %I", `t032_${probe}`);
      }
      await run(s.owner, "CREATE SCHEMA %I", `t032_${probe}`);
      try {
        await run(s.owner, "GRANT USAGE ON SCHEMA %I TO %I", `t032_${probe}`, probe);
        expect(await probeCodes()).toEqual(["object_privilege"]);
        await run(s.owner, "GRANT CREATE ON SCHEMA %I TO %I", `t032_${probe}`, probe);
        expect(await probeCodes()).toEqual(["object_privilege", "schema_create"]);
        await run(s.owner, "REVOKE ALL ON SCHEMA %I FROM %I", `t032_${probe}`, probe);
        await run(s.owner, "GRANT CREATE ON SCHEMA %I TO PUBLIC", `t032_${probe}`);
        expect(await probeCodes()).toEqual(["schema_create"]);
      } finally {
        await run(s.owner, "DROP SCHEMA %I", `t032_${probe}`);
      }
      expect(await probeCodes()).toEqual([]);
      // B1: a subscription it owns (grants since revoked), even disabled.
      const subscription = `t032_${probe}`;
      await run(
        s.owner,
        "CREATE SUBSCRIPTION %I CONNECTION 'dbname=oculus_t032_nowhere' PUBLICATION nothing WITH (connect = false)",
        subscription,
      );
      try {
        await run(server, "GRANT pg_create_subscription TO %I", probe);
        await run(server, "GRANT CREATE ON DATABASE %I TO %I", db, probe);
        await run(s.owner, "ALTER SUBSCRIPTION %I OWNER TO %I", subscription, probe);
        await run(server, "REVOKE CREATE ON DATABASE %I FROM %I", db, probe);
        await run(server, "REVOKE pg_create_subscription FROM %I", probe);
        // Any subscription in the database is refused too (S-015).
        expect(await probeCodes()).toEqual(["owns_object", "subscription"]);
      } finally {
        await run(s.owner, "ALTER SUBSCRIPTION %I SET (slot_name = NONE)", subscription);
        await run(s.owner, "DROP SUBSCRIPTION %I", subscription);
      }
      expect(await probeCodes()).toEqual([]);
      // A whole database in replica mode, or every role in it (B2). Last,
      // and reset at once: they apply to every new session of the database.
      for (const [set, reset, names] of [
        [
          "ALTER DATABASE %I SET session_replication_role = replica",
          "ALTER DATABASE %I RESET session_replication_role",
          [db],
        ],
        [
          "ALTER ROLE ALL IN DATABASE %I SET session_replication_role = replica",
          "ALTER ROLE ALL IN DATABASE %I RESET session_replication_role",
          [db],
        ],
      ] as const) {
        await run(server, set, ...names);
        try {
          expect({ set, found: await probeCodes() }).toEqual({
            set,
            found: ["replication_role", "role_setting"],
          });
        } finally {
          await run(server, reset, ...names);
        }
      }
      expect(await probeCodes()).toEqual([]);
      // This session in replica mode, set by hand.
      const writerName = s.roles[0] ?? "";
      const inReplica = await s.owner.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('session_replication_role', 'replica', true)`);
        await q.rows(sql`SELECT set_config('role', ${writerName}, true)`);
        return (await checkWriterConnection(q)).map((p) => p.code);
      });
      expect(inReplica).toContain("replication_role");
      // The owner's list is long; the message names five and counts the rest.
      const ownerProblems = await createService(s.owner).checkConnection();
      const extra = ownerProblems.find((p) => p.code === "extra_privilege")?.message ?? "";
      expect(extra).toMatch(/ and \d+ more\.$/);
      expect(extra.length).toBeLessThan(400);
      // 5. A session that logged in as the owner and SET ROLE to the writer.
      const writerRole = s.roles[0] ?? "";
      const switched = await s.owner.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('role', ${writerRole}, true)`);
        const [who] = await q.rows<{ name: string }>(sql`SELECT current_user AS name`);
        expect(who?.name).toBe(writerRole);
        return (await checkWriterConnection(q)).map((p) => p.code);
      });
      expect(switched).toEqual(expect.arrayContaining(["superuser", "owner"]));
    } finally {
      await server.close();
    }
  });

  it("S-015: grant options on the database and schema, triggers not ALWAYS, subscriptions; temporary objects are fine", async () => {
    await ready();
    const probe = s.roles[6] ?? "";
    const db = s.testDb.name;
    const run = async (on: Database, statement: string, ...names: string[]): Promise<void> => {
      await on.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('oculus_test.statement', ${statement}, true),
                                set_config('oculus_test.a', ${names[0] ?? ""}, true),
                                set_config('oculus_test.b', ${names[1] ?? ""}, true)`);
        await q.execute(sql`DO $$ BEGIN
          EXECUTE format(current_setting('oculus_test.statement'),
                         current_setting('oculus_test.a'), current_setting('oculus_test.b'));
        END $$`);
      });
    };
    const probeCodes = async (): Promise<string[]> => {
      const fresh = as(s.testDb.url, probe);
      try {
        return (await createService(fresh).checkConnection()).map((p) => p.code);
      } finally {
        await fresh.close();
      }
    };
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await s.owner.transaction((q) => grantWriterRole(q, probe));
      expect(await probeCodes()).toEqual([]);
      // Grant options on the database and on schema public.
      for (const [on, grant, revoke, names] of [
        [
          server,
          "GRANT CONNECT ON DATABASE %I TO %I WITH GRANT OPTION",
          "REVOKE CONNECT ON DATABASE %I FROM %I",
          [db, probe],
        ],
        [
          server,
          "GRANT TEMPORARY ON DATABASE %I TO %I WITH GRANT OPTION",
          "REVOKE TEMPORARY ON DATABASE %I FROM %I",
          [db, probe],
        ],
        [
          s.owner,
          "GRANT USAGE ON SCHEMA public TO %I WITH GRANT OPTION",
          "REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM %I",
          [probe],
        ],
      ] as const) {
        await run(on, grant, ...names);
        try {
          const problems = await (async () => {
            const fresh = as(s.testDb.url, probe);
            try {
              return await createService(fresh).checkConnection();
            } finally {
              await fresh.close();
            }
          })();
          expect({ grant, found: problems.map((p) => p.code) }).toEqual({
            grant,
            found: ["extra_privilege"],
          });
          expect(problems[0]?.message).toMatch(/\(grant option\)/);
        } finally {
          await run(on, revoke, ...names);
        }
        expect({ revoke, found: await probeCodes() }).toEqual({ revoke, found: [] });
      }
      // Without the grant option, CONNECT and TEMPORARY to the role are fine.
      await run(server, "GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I", db, probe);
      try {
        expect(await probeCodes()).toEqual([]);
      } finally {
        await run(server, "REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM %I", db, probe);
      }
      // Temporary objects of the writer's sessions are not "owned objects",
      // in the session that made them or seen from another one.
      const holder = as(s.testDb.url, probe);
      try {
        await holder.transaction(async (q) => {
          await q.execute(sql`CREATE TEMPORARY TABLE scratch (n integer) ON COMMIT PRESERVE ROWS`);
          await q.execute(sql`CREATE TEMPORARY SEQUENCE scratch_numbers`);
          await q.execute(
            sql`CREATE FUNCTION pg_temp.scratch_one() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
          );
        });
        // The pool keeps that connection open, so its temporary objects stay.
        const [held] = await s.owner.rows<{ n: number }>(sql`
          SELECT count(*)::integer AS n FROM pg_catalog.pg_shdepend d
          WHERE d.refobjid = ${probe}::regrole AND d.deptype = 'o'`);
        expect(held?.n).toBe(3);
        expect(await probeCodes()).toEqual([]);
      } finally {
        await holder.close();
      }
      // Any non-internal trigger on public's tables that isn't ALWAYS.
      const trigger = "zzzz_records_delete_needs_version";
      for (const state of ["ENABLE", "ENABLE REPLICA", "DISABLE"]) {
        await run(s.owner, `ALTER TABLE public.records ${state} TRIGGER %I`, trigger);
        try {
          const problems = await service.checkConnection();
          expect({ state, found: problems.map((p) => p.code) }).toEqual({
            state,
            found: ["trigger_not_always"],
          });
          expect(problems[0]?.message).toContain(`records.${trigger}`);
          expect({ state, found: await probeCodes() }).toEqual({
            state,
            found: ["trigger_not_always"],
          });
        } finally {
          await run(s.owner, "ALTER TABLE public.records ENABLE ALWAYS TRIGGER %I", trigger);
        }
      }
      expect(await service.checkConnection()).toEqual([]);
      // Any subscription in this database, even the owner's and disabled.
      const subscription = `s015_${probe}`;
      await run(
        s.owner,
        "CREATE SUBSCRIPTION %I CONNECTION 'dbname=oculus_s015_nowhere' PUBLICATION nothing WITH (connect = false)",
        subscription,
      );
      try {
        const problems = await service.checkConnection();
        expect(problems.map((p) => p.code)).toEqual(["subscription"]);
        expect(problems[0]?.message).toContain(subscription);
        expect(await probeCodes()).toEqual(["subscription"]);
      } finally {
        await run(s.owner, "ALTER SUBSCRIPTION %I SET (slot_name = NONE)", subscription);
        await run(s.owner, "DROP SUBSCRIPTION %I", subscription);
      }
      expect(await service.checkConnection()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("the writer's grants cover every data-access write, and nothing it doesn't use", async () => {
    await ready();
    const org = await organization();
    const w = s.writer;
    // As the writer: a template and record type version, an identifier type
    // added and edited, a number allocated, a term saved.
    ok(
      await insertTemplateVersion(w, {
        key: "invented-object",
        organizationId: org,
        label: "Invented objects, by the writer",
        appliesTo: ["object"],
        fields: [field("note", "text")],
      }),
    );
    ok(
      await insertRecordTypeVersion(w, {
        key: "chair",
        organizationId: org,
        label: "Chair, by the writer",
        kind: "object",
        defaultTemplateKey: "invented-object",
      }),
    );
    const accession = {
      organizationId: org,
      key: "accession",
      label: "Accession number",
      uniqueness: "all_time",
      autoNumber: { style: "prefix", prefix: "ACC-", digits: 4 },
    };
    ok(await w.transaction((q) => insertIdentifierType(q, accession)));
    ok(await w.transaction((q) => updateIdentifierType(q, { ...accession, label: "Accessions" })));
    expect(ok(await w.transaction((q) => allocateIdentifier(q, org, "accession")))).toBe(
      "ACC-0001",
    );
    ok(await w.transaction((q) => saveTerm(q, { organizationId: org, term: RAILROADS })));
    // What it no longer may do.
    for (const statement of [
      sql`DELETE FROM public.organizations WHERE id = ${org}::uuid`,
      sql`UPDATE public.templates SET key = key WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.templates WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.record_types WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.identifier_types WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.identifier_counters WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.terms WHERE organization_id = ${org}::uuid`,
      sql`UPDATE public.record_identifiers SET position = position WHERE organization_id = ${org}::uuid`,
      sql`UPDATE public.record_terms SET field_key = field_key WHERE organization_id = ${org}::uuid`,
    ]) {
      expect((await refusal(w.execute(statement))).code).toBe(DENIED);
    }
  });

  it("no role but the writer can write any table; nothing is granted to PUBLIC", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const grantsToPublic = await s.owner.rows(sql`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema = 'public'`);
    expect(grantsToPublic).toEqual([]);
    const tables = await s.owner.rows<{ name: string }>(sql`
      SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public'
      ORDER BY tablename`);
    expect(tables.length).toBeGreaterThan(10);
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    const attempts: Sql[] = [
      sql`UPDATE public.records SET title = 'Around the service', version = version + 1 WHERE ${where}`,
      sql`DELETE FROM public.records WHERE ${where}`,
      sql`INSERT INTO public.organizations (id, name) VALUES (${newOrganizationId()}::uuid, 'Sneaky')`,
      sql`DELETE FROM public.identifier_holdings WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.record_terms WHERE organization_id = ${org}::uuid`,
      sql`INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
          VALUES (${org}::uuid, ${record.id}::uuid, 2, '{}'::jsonb, 'system:sneaky')`,
      sql`TRUNCATE public.records CASCADE`,
      sql`UPDATE public.template_versions SET definition = definition`,
      sql`CREATE TABLE public.sneaky (id integer)`,
    ];
    for (const pool of [s.reader, s.nobody]) {
      for (const statement of attempts) {
        expect((await refusal(pool.execute(statement))).code).toBe(DENIED);
      }
      // Every table refuses every kind of write.
      for (const { name } of tables) {
        const [row] = await pool.rows<{ any: boolean }>(sql`
          SELECT has_table_privilege(${`public.${name}`}, 'INSERT')
              OR has_table_privilege(${`public.${name}`}, 'UPDATE')
              OR has_table_privilege(${`public.${name}`}, 'DELETE')
              OR has_table_privilege(${`public.${name}`}, 'TRUNCATE') AS any`);
        expect({ name, any: row?.any }).toEqual({ name, any: false });
      }
    }
    // A service over a role that can't write gets a clean refusal, nothing more.
    const errors: unknown[] = [];
    const readOnly = createService(s.reader, { onError: (e) => errors.push(e) });
    const refused = await readOnly.createRecord(ctx(org), objectDraft());
    expect(codes(refused)).toEqual(["not_permitted"]);
    expect(messages(refused)).not.toMatch(/permission denied|records|public\./);
    expect(errors).toHaveLength(1);
    expect(ok(await readStoredRecord(s.owner, org, record.id)).version).toBe(1);
  });

  it("even the writer can't change history, delete without a tombstone, or leave a tombstone over a live record", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    for (const statement of [
      sql`UPDATE public.record_versions SET reason = 'Rewritten.' WHERE organization_id = ${org}::uuid`,
      sql`DELETE FROM public.record_versions WHERE organization_id = ${org}::uuid`,
      sql`TRUNCATE public.records CASCADE`,
      sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_delete_needs_version`,
      sql`SET session_replication_role = replica`,
    ]) {
      expect((await refusal(s.writer.execute(statement))).code).toBe(DENIED);
    }
    // A DELETE without its deletion version.
    expect(await refusal(s.writer.execute(sql`DELETE FROM public.records WHERE ${where}`))).toEqual(
      {
        code: IDENTITY,
        constraint: "records_delete_needs_version",
      },
    );
    // A deletion version with no DELETE: refused at COMMIT.
    expect(
      await refusal(
        s.writer.execute(sql`
          INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
          SELECT organization_id, id, version + 1, public.record_snapshot(r), 'system:sneaky', 'delete'
          FROM public.records r WHERE ${where}`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_delete_done" });
    // A deletion version that isn't the row (another title).
    expect(
      await refusal(
        s.writer.transaction(async (q) => {
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
            SELECT organization_id, id, version + 1,
                   jsonb_set(public.record_snapshot(r), '{title}', '"Forged"'), 'system:sneaky', 'delete'
            FROM public.records r WHERE ${where}`);
          await q.execute(sql`DELETE FROM public.records WHERE ${where}`);
        }),
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_snapshot_matches" });
    // A tombstone, then a save over it in the same transaction.
    expect(
      await refusal(
        s.writer.transaction(async (q) => {
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
            SELECT organization_id, id, version + 1, public.record_snapshot(r), 'system:sneaky', 'delete'
            FROM public.records r WHERE ${where}`);
          await q.execute(
            sql`UPDATE public.records SET title = 'Revived', version = version + 1 WHERE ${where}`,
          );
          await q.execute(sql`
            INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
            SELECT organization_id, id, version, public.record_snapshot(r), 'system:sneaky'
            FROM public.records r WHERE ${where}`);
        }),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_deleted" });
    expect(await versionCount(org, record.id)).toBe(1);
    expect(await rowExists(org, record.id)).toBe(true);
    // The owner is refused too, unless it turns triggers off.
    expect(await refusal(s.owner.execute(sql`DELETE FROM public.records WHERE ${where}`))).toEqual({
      code: IDENTITY,
      constraint: "records_delete_needs_version",
    });
    expect(await refusal(s.owner.execute(sql`TRUNCATE public.records CASCADE`))).toMatchObject({
      code: IDENTITY,
    });
  });
});

describe("the guards fire in replica mode too", () => {
  it("refuses a record write without a version, a version change and a deletion without a tombstone", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    const inReplica = (statement: Sql) =>
      refusal(
        s.owner.transaction(async (q) => {
          await q.rows(sql`SELECT set_config('session_replication_role', 'replica', true)`);
          await q.execute(statement);
        }),
      );
    expect(
      await inReplica(
        sql`UPDATE public.records SET title = 'Unversioned', version = version + 1 WHERE ${where}`,
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_have_version" });
    expect(
      await inReplica(
        sql`UPDATE public.record_versions SET reason = 'Rewritten.' WHERE organization_id = ${org}::uuid`,
      ),
    ).toEqual({ code: IDENTITY, constraint: "record_versions_append_only" });
    expect(
      await inReplica(
        sql`UPDATE public.template_versions SET definition = definition WHERE organization_id = ${org}::uuid`,
      ),
    ).toEqual({ code: IDENTITY, constraint: "template_versions_append_only" });
    expect(await inReplica(sql`DELETE FROM public.records WHERE ${where}`)).toEqual({
      code: IDENTITY,
      constraint: "records_delete_needs_version",
    });
    expect(ok(await readStoredRecord(s.owner, org, record.id)).version).toBe(1);
    // Every trigger on public's tables is ALWAYS.
    const notAlways = await s.owner.rows(sql`
      SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'A'`);
    expect(notAlways).toEqual([]);
  });
});

describe("a database owned by a plain role, as on shared hosting", () => {
  it("migrates as that role, and a correct writer passes the check", async () => {
    await ready();
    const [hostOwner = "", hostWriter = ""] = s.roles.slice(9);
    const hosted = await freshDatabase();
    const server = openDatabase(testServerUrl(), { max: 1 });
    try {
      await server.transaction(async (q) => {
        await q.rows(sql`SELECT set_config('oculus_test.db', ${hosted.name}, true),
                                set_config('oculus_test.role', ${hostOwner}, true)`);
        await q.execute(sql`DO $$ BEGIN
          EXECUTE format('ALTER DATABASE %I OWNER TO %I', current_setting('oculus_test.db'),
                         current_setting('oculus_test.role'));
        END $$`);
      });
      await migrate({ connectionString: urlAs(hosted.url, hostOwner) });
      const owner = openDatabase(urlAs(hosted.url, hostOwner), { max: 1 });
      const writer = openDatabase(urlAs(hosted.url, hostWriter), { max: 1 });
      try {
        await owner.transaction((q) => grantWriterRole(q, hostWriter));
        expect(await createService(writer).checkConnection()).toEqual([]);
        expect((await createService(owner).checkConnection()).map((p) => p.code)).toContain(
          "owner",
        );
      } finally {
        await writer.close();
        await owner.close();
      }
    } finally {
      await server.close();
      await hosted.drop();
    }
  });
});

describe("template and record type versions are append-only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE by any role, the owner and a column grant included", async () => {
    await ready();
    const org = await organization();
    const where = sql`organization_id = ${org}::uuid`;
    for (const [table, statements] of [
      [
        "template_versions",
        [
          sql`UPDATE public.template_versions SET definition = definition WHERE ${where}`,
          sql`DELETE FROM public.template_versions WHERE ${where} AND key = 'invented-unit'`,
          sql`TRUNCATE public.template_versions CASCADE`,
        ],
      ],
      [
        "record_type_versions",
        [
          sql`UPDATE public.record_type_versions SET definition = definition WHERE ${where}`,
          sql`DELETE FROM public.record_type_versions WHERE ${where}`,
          sql`TRUNCATE public.record_type_versions`,
        ],
      ],
    ] as const) {
      for (const statement of statements) {
        expect(await refusal(s.owner.execute(statement))).toEqual({
          code: IDENTITY,
          constraint: `${table}_append_only`,
        });
      }
    }
    // B2: a role given UPDATE on one column still can't rewrite history.
    const writerRole = s.roles[0] ?? "";
    await s.owner.transaction((q) =>
      withRole(q, "GRANT UPDATE (definition) ON public.template_versions TO %I", writerRole),
    );
    try {
      expect(
        await refusal(
          s.writer.execute(sql`
            UPDATE public.template_versions
            SET definition = jsonb_set(definition, '{label}', '"Rewritten"') WHERE ${where}`),
        ),
      ).toEqual({ code: IDENTITY, constraint: "template_versions_append_only" });
      expect((await service.checkConnection()).map((p) => p.code)).toEqual(["column_privilege"]);
    } finally {
      await s.owner.transaction((q) =>
        withRole(q, "REVOKE UPDATE (definition) ON public.template_versions FROM %I", writerRole),
      );
    }
    expect(await service.checkConnection()).toEqual([]);
  });
});

describe("nothing follows a deletion version", () => {
  const tombstone = (where: Sql, version: Sql) => sql`
    INSERT INTO public.record_versions (organization_id, record_id, version, record, actor, action)
    SELECT organization_id, id, ${version}, public.record_snapshot(r), 'system:sneaky', 'delete'
    FROM public.records r WHERE ${where}`;
  const save = (where: Sql) => sql`
    INSERT INTO public.record_versions (organization_id, record_id, version, record, actor)
    SELECT organization_id, id, version, public.record_snapshot(r), 'system:sneaky'
    FROM public.records r WHERE ${where}`;

  it("refuses the writer's save-after-delete sequences, long and short", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    // Long: delete v2, row to v2 then v3, save v3, delete v4, DELETE.
    const long = await refusal(
      s.writer.transaction(async (q) => {
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(sql`UPDATE public.records SET version = version + 1 WHERE ${where}`);
        await q.execute(
          sql`UPDATE public.records SET title = 'Revived', version = version + 1 WHERE ${where}`,
        );
        await q.execute(save(where));
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(sql`DELETE FROM public.records WHERE ${where}`);
      }),
    );
    expect(long).toEqual({ code: IDENTITY, constraint: "records_deleted" });
    // Short: delete v2, row to v2 with another title, delete v3, DELETE.
    const short = await refusal(
      s.writer.transaction(async (q) => {
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(
          sql`UPDATE public.records SET title = 'Changed', version = version + 1 WHERE ${where}`,
        );
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(sql`DELETE FROM public.records WHERE ${where}`);
      }),
    );
    expect(short).toEqual({ code: IDENTITY, constraint: "records_deleted" });
    expect((await readVersions(s.owner, org, record.id)).ok).toBe(true);
    expect(await versionCount(org, record.id)).toBe(1);
    expect(await rowExists(org, record.id)).toBe(true);
  });

  it("the version check alone refuses them too (the row trigger turned off by the owner)", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const where = sql`organization_id = ${org}::uuid AND id = ${record.id}::uuid`;
    for (const sequence of [
      // Long.
      async (q: Queryable) => {
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(sql`UPDATE public.records SET version = version + 1 WHERE ${where}`);
        await q.execute(
          sql`UPDATE public.records SET title = 'Revived', version = version + 1 WHERE ${where}`,
        );
        await q.execute(save(where));
      },
      // Short.
      async (q: Queryable) => {
        await q.execute(tombstone(where, sql`version + 1`));
        await q.execute(
          sql`UPDATE public.records SET title = 'Changed', version = version + 1 WHERE ${where}`,
        );
        await q.execute(tombstone(where, sql`version + 1`));
      },
    ]) {
      expect(
        await refusal(
          s.owner.transaction(async (q) => {
            await q.execute(
              sql`ALTER TABLE public.records DISABLE TRIGGER zzzz_records_not_deleted`,
            );
            await sequence(q);
          }),
        ),
      ).toEqual({ code: IDENTITY, constraint: "record_versions_after_delete" });
    }
    expect(await versionCount(org, record.id)).toBe(1);
    // The trigger is back (the transactions rolled back).
    const [on] = await s.owner.rows<{ enabled: string }>(sql`
      SELECT tgenabled AS enabled FROM pg_catalog.pg_trigger
      WHERE tgname = 'zzzz_records_not_deleted'`);
    expect(on?.enabled).toBe("A");
  });
});

describe("the context: organization and actor come from the session", () => {
  it("refuses a bad or unknown context before reading anything", async () => {
    await ready();
    const org = await organization();
    const bad: unknown[] = [
      undefined,
      {},
      { organizationId: "not-a-uuid", actor: ALICE },
      { organizationId: org, actor: "admin" },
      { organizationId: org, actor: ALICE, role: "system_manager" },
      new Proxy(
        { organizationId: org, actor: ALICE },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("trap");
          },
        },
      ),
    ];
    for (const context of bad) {
      const result = await service.createRecord(context as never, objectDraft());
      expect(result.ok).toBe(false);
    }
    expect(codes(await service.createRecord(ctx(newOrganizationId()), objectDraft()))).toEqual([
      "unknown_organization",
    ]);
  });

  it("a draft naming another organization is refused, whatever exists there", async () => {
    await ready();
    const mine = await organization();
    const theirs = await organization();
    const result = await service.createRecord(ctx(mine), {
      ...objectDraft(),
      organizationId: theirs,
    });
    expect(codes(result)).toEqual(["wrong_organization"]);
    const unknown = await service.createRecord(ctx(mine), {
      ...objectDraft(),
      organizationId: newOrganizationId(),
    });
    expect(unknown).toEqual(result);
  });

  it("another organization's record can't be read, edited, renumbered, restored or deleted: it is unknown", async () => {
    await ready();
    const mine = await organization();
    const theirs = await organization();
    const their = await create(theirs, objectDraft({ note: "Their secret note." }));
    const nowhere = newRecordId();
    for (const id of [their.id, nowhere]) {
      const update = await service.updateRecord(ctx(mine), id, objectDraft({ note: "Mine now." }), {
        expectedVersion: 1,
      });
      const renumber = await service.saveIdentifiers(ctx(mine), id, numbers("DHS-1"));
      const restore = await service.restoreVersion(ctx(mine), id, 1, { expectedVersion: 1 });
      const remove = await service.deleteRecord(ctx(mine), id, { expectedVersion: 1 });
      for (const result of [update, renumber, restore, remove]) {
        expect(codes(result)).toEqual(["unknown_record"]);
        expect("conflict" in result).toBe(false);
      }
    }
    // The same answers for a record that exists elsewhere and one that doesn't.
    const a = await service.updateRecord(ctx(mine), their.id, objectDraft(), {
      expectedVersion: 9,
    });
    const b = await service.updateRecord(ctx(mine), nowhere, objectDraft(), { expectedVersion: 9 });
    expect(a).toEqual(b);
    expect(ok(await readStoredRecord(s.owner, theirs, their.id)).version).toBe(1);
    expect(await versionCount(theirs, their.id)).toBe(1);
  });

  it("links, parents, scans and record types resolve only in the session's organization", async () => {
    await ready();
    const mine = await organization();
    const theirs = await organization();
    const theirMaker = await create(theirs, agentDraft);
    const theirFonds = await create(theirs, unitDraft("fonds"));
    const theirChair = await create(theirs, objectDraft());
    const ghost = newRecordId();
    const link = (id: RecordId) => ({ creator: { recordId: id, label: "A maker" } });
    const viaTheirs = await service.createRecord(ctx(mine), objectDraft(link(theirMaker.id)));
    const viaGhost = await service.createRecord(ctx(mine), objectDraft(link(ghost)));
    expect(codes(viaTheirs)).toEqual(["unknown_record"]);
    expect(codes(viaTheirs)).toEqual(codes(viaGhost));
    expect(
      codes(await service.createRecord(ctx(mine), unitDraft("series", theirFonds.id))),
    ).toEqual(["missing_parent"]);
    expect(
      codes(
        await service.createRecord(ctx(mine), {
          kind: "digital_asset",
          title: "A scan",
          mediaType: "image/tiff",
          templateKey: "invented-asset",
          represents: theirChair.id,
        }),
      ),
    ).toEqual(["unknown_record"]);
    // Their template key doesn't exist here.
    ok(
      await insertTemplateVersion(s.owner, {
        key: "theirs-only",
        organizationId: theirs,
        label: "Theirs",
        appliesTo: ["object"],
        fields: [field("note", "text")],
      }),
    );
    expect(
      codes(
        await service.createRecord(ctx(mine), {
          ...objectDraft(),
          templateKey: "theirs-only",
          fields: {},
        }),
      ),
    ).toEqual(["unknown_template"]);
    // Nothing was stored in either organization.
    const [count] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.records WHERE organization_id = ${mine}::uuid`);
    expect(count?.n).toBe(0);
  });

  it("an identifier set naming another organization or record is refused", async () => {
    await ready();
    const mine = await organization();
    const theirs = await organization();
    const record = await create(mine, objectDraft());
    expect(
      codes(
        await service.saveIdentifiers(ctx(mine), record.id, {
          ...numbers("DHS-1"),
          organizationId: theirs,
        }),
      ),
    ).toEqual(["wrong_organization"]);
    expect(
      codes(
        await service.saveIdentifiers(ctx(mine), record.id, {
          ...numbers("DHS-1"),
          recordId: newRecordId(),
        }),
      ),
    ).toEqual(["wrong_record"]);
    // Two organizations may hold the same number under all_time.
    const their = await create(theirs, objectDraft());
    ok(await service.saveIdentifiers(ctx(mine), record.id, numbers("DHS-1")));
    ok(await service.saveIdentifiers(ctx(theirs), their.id, numbers("DHS-1")));
  });
});

describe("creating records", () => {
  it("makes the ID and timestamps, stores version 1 with who and why, the numbers and the terms index", async () => {
    await ready();
    const org = await organization();
    const saved = ok(
      await service.createRecord(
        ctx(org),
        {
          ...objectDraft({
            number: { type: "object_number", value: "DHS-7" },
            subjects: [RAILROADS],
          }),
          recordTypeKey: "chair",
        },
        { identifiers: numbers("DHS-7"), reason: "Accessioned." },
      ),
    );
    expect(saved.version).toBe(1);
    expect(saved.changed).toBe(true);
    expect(saved.record.createdAt).toBe(NOW.toISOString());
    expect(saved.record.updatedAt).toBe(NOW.toISOString());
    expect(saved.record.organizationId).toBe(org);
    const v1 = ok(await readVersion(s.owner, org, saved.record.id, 1));
    expect(v1).toMatchObject({ actor: ALICE, reason: "Accessioned.", action: "save" });
    expect(ok(await readRecordIdentifiers(s.owner, org, saved.record.id)).current).toEqual([
      { type: "object_number", value: "DHS-7", primary: true },
    ]);
    const users = ok(await recordsUsingTerm(s.owner, org, ok(termKey(RAILROADS))));
    expect(users.records.map((r) => r.recordId)).toEqual([saved.record.id]);
  });

  it("refuses an ID, timestamps or unknown properties in a new record's draft", async () => {
    await ready();
    const org = await organization();
    expect(
      codes(await service.createRecord(ctx(org), { ...objectDraft(), id: newRecordId() })),
    ).toEqual(["not_allowed"]);
    expect(
      codes(
        await service.createRecord(ctx(org), { ...objectDraft(), createdAt: NOW.toISOString() }),
      ),
    ).toEqual(["not_allowed"]);
    expect(
      codes(await service.createRecord(ctx(org), { ...objectDraft(), published: true })),
    ).toEqual(["unknown_property"]);
    const getter = objectDraft();
    Object.defineProperty(getter, "title", { enumerable: true, get: () => "Changing" });
    expect((await service.createRecord(ctx(org), getter)).ok).toBe(false);
    expect(
      (
        await service.createRecord(ctx(org), objectDraft(), {
          identifiers: numbers("X-1"),
          sneaky: 1,
        } as never)
      ).ok,
    ).toBe(false);
  });

  it("checks against the template, record type and identifiers, and stores nothing when refused", async () => {
    await ready();
    const org = await organization();
    const refusals: [Record<string, unknown>, Record<string, unknown> | undefined, string[]][] = [
      [{ ...objectDraft(), fields: { colour: "Red" } }, undefined, ["unknown_field"]],
      [{ ...objectDraft(), templateKey: "no-such-template" }, undefined, ["unknown_template"]],
      [{ ...objectDraft(), recordTypeKey: "no-such-type" }, undefined, ["unknown_record_type"]],
      [{ ...unitDraft("fonds"), recordTypeKey: "chair" }, undefined, []],
      // An identifier field showing a number the record doesn't hold.
      [
        objectDraft({ number: { type: "object_number", value: "DHS-9" } }),
        undefined,
        ["identifier_not_held"],
      ],
      // A number of a type that doesn't exist.
      [
        objectDraft(),
        { identifiers: { current: [{ type: "nope", value: "1", primary: true }], former: [] } },
        [],
      ],
    ];
    for (const [draft, options, expected] of refusals) {
      const result = await service.createRecord(ctx(org), draft, options);
      expect(result.ok).toBe(false);
      if (expected.length > 0) expect(codes(result)).toEqual(expected);
    }
    const [count] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.records WHERE organization_id = ${org}::uuid`);
    expect(count?.n).toBe(0);
    const [versions] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.record_versions WHERE organization_id = ${org}::uuid`);
    expect(versions?.n).toBe(0);
  });

  it("a number another record holds rolls the whole save back, record and version included", async () => {
    await ready();
    const org = await organization();
    await create(org, objectDraft(), { identifiers: numbers("DHS-1") });
    const result = await service.createRecord(ctx(org), objectDraft(), {
      identifiers: numbers("DHS-1"),
    });
    expect(codes(result)).toEqual(["not_unique"]);
    const [count] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.records WHERE organization_id = ${org}::uuid`);
    expect(count?.n).toBe(1);
  });

  it("files units under units of a higher level only", async () => {
    await ready();
    const org = await organization();
    const fonds = await create(org, unitDraft("fonds"));
    const series = await create(org, unitDraft("series", fonds.id));
    expect(codes(await service.createRecord(ctx(org), unitDraft("fonds", series.id)))).toEqual([
      "wrong_level",
    ]);
    const chair = await create(org, objectDraft());
    expect(codes(await service.createRecord(ctx(org), unitDraft("file", chair.id)))).toEqual([
      "missing_parent",
    ]);
  });
});

describe("moving a record to another template (T-012a)", () => {
  it("refuses until the person confirms the stored staff values the new template publishes", async () => {
    await ready();
    const org = await organization();
    ok(
      await insertTemplateVersion(s.owner, {
        key: "invented-public-object",
        organizationId: org,
        label: "Invented objects, published",
        appliesTo: ["object"],
        fields: [field("note", "text", { visibility: "public" }), field("extra", "text")],
      }),
    );
    const record = await create(org, objectDraft({ note: "Staff only: invented." }));
    const moved = draftOf(record, { templateKey: "invented-public-object" });
    const refused = await service.updateRecord(ctx(org), record.id, moved, {
      expectedVersion: 1,
    });
    expect(codes(refused)).toEqual(["made_public"]);
    expect(refused.ok ? [] : refused.issues.map((i) => i.path)).toEqual([["fields", "note"]]);
    expect(messages(refused)).not.toContain("Staff only");
    expect(await versionCount(org, record.id)).toBe(1);
    // A confirmation that isn't exactly the list is refused the same way.
    for (const confirmTemplateMove of [[], ["note", "extra"], ["extra"]]) {
      expect(
        codes(
          await service.updateRecord(ctx(org), record.id, moved, {
            expectedVersion: 1,
            confirmTemplateMove,
          }),
        ),
      ).toEqual(["made_public"]);
    }
    expect(
      codes(
        await service.updateRecord(ctx(org), record.id, moved, {
          expectedVersion: 1,
          confirmTemplateMove: ["Not a key!"],
        }),
      ),
    ).toEqual(["invalid_option"]);
    const done = ok(
      await service.updateRecord(ctx(org), record.id, moved, {
        expectedVersion: 1,
        confirmTemplateMove: ["note"],
      }),
    );
    expect(done.record.templateKey).toBe("invented-public-object");
    expect(done.version).toBe(2);
    // Back to the staff template: nothing becomes public, nothing to confirm.
    const back = ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        draftOf(done.record, { templateKey: "invented-object" }),
        { expectedVersion: 2 },
      ),
    );
    expect(back.version).toBe(3);
    // A value typed in during the move was never stored as staff.
    const fresh = await create(org, { ...objectDraft(), fields: {} });
    expect(
      ok(
        await service.updateRecord(
          ctx(org),
          fresh.id,
          draftOf(fresh, {
            templateKey: "invented-public-object",
            fields: { note: "Typed in now." },
          }),
          { expectedVersion: 1 },
        ),
      ).version,
    ).toBe(2);
  });
});

describe("updating records", () => {
  it("writes the next version with updatedAt never going backwards, and refreshes the terms", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    // The server's clock is behind the stored time: the edit still saves.
    const behind = createService(s.writer, { now: () => new Date("2020-01-01T00:00:00.000Z") });
    const saved = ok(
      await behind.updateRecord(
        ctx(org, BOB),
        record.id,
        draftOf(record, { fields: { note: "Oak.", subjects: [RAILROADS] } }),
        { expectedVersion: 1, reason: "Catalogued." },
      ),
    );
    expect(saved).toMatchObject({ version: 2, changed: true });
    expect(saved.record.updatedAt).toBe(record.updatedAt);
    expect(ok(await readVersion(s.owner, org, record.id, 2))).toMatchObject({
      actor: BOB,
      reason: "Catalogued.",
      changedFields: ["fields.subjects"],
    });
    const users = ok(await recordsUsingTerm(s.owner, org, ok(termKey(RAILROADS))));
    expect(users.records.map((r) => r.recordId)).toEqual([record.id]);
  });

  it("an unchanged draft writes nothing", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const same = ok(
      await service.updateRecord(ctx(org), record.id, draftOf(record), { expectedVersion: 1 }),
    );
    expect(same).toMatchObject({ version: 1, changed: false });
    expect(await versionCount(org, record.id)).toBe(1);
  });

  it("refuses an edit from an old version with what changed (names only), a kind change and another record's draft", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft({ note: "Secret staff note." }));
    ok(
      await service.updateRecord(ctx(org), record.id, draftOf(record, { title: "Renamed" }), {
        expectedVersion: 1,
      }),
    );
    const stale = await service.updateRecord(
      ctx(org, BOB),
      record.id,
      draftOf(record, { fields: { note: "Bob's edit." } }),
      { expectedVersion: 1 },
    );
    expect(codes(stale)).toEqual(["version_conflict"]);
    expect(stale.ok ? undefined : stale.conflict).toEqual({
      expectedVersion: 1,
      currentVersion: 2,
      differences: [{ name: "title", change: "changed" }],
    });
    expect(messages(stale)).not.toContain("Renamed");
    expect(
      codes(
        await service.updateRecord(
          ctx(org),
          record.id,
          { ...draftOf(record), kind: "event" },
          {
            expectedVersion: 2,
          },
        ),
      ),
    ).toEqual(["kind_changed"]);
    expect(
      codes(
        await service.updateRecord(
          ctx(org),
          record.id,
          { ...draftOf(record), id: newRecordId() },
          {
            expectedVersion: 2,
          },
        ),
      ),
    ).toEqual(["wrong_record"]);
    expect(
      codes(
        await service.updateRecord(ctx(org), record.id, draftOf(record), { expectedVersion: 0 }),
      ),
    ).toEqual(["invalid_version"]);
  });

  it("checks moves in the arrangement: a loop, a level that doesn't fit, children a new level can't hold", async () => {
    await ready();
    const org = await organization();
    const fonds = await create(org, unitDraft("fonds"));
    const a = await create(org, unitDraft("series", fonds.id));
    const b = await create(org, unitDraft("series", a.id));
    expect(
      codes(
        await service.updateRecord(ctx(org), a.id, draftOf(a, { parentId: b.id }), {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["loop"]);
    expect(
      codes(
        await service.updateRecord(ctx(org), fonds.id, draftOf(fonds, { parentId: a.id }), {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["wrong_level", "loop"]);
    expect(
      codes(
        await service.updateRecord(ctx(org), a.id, draftOf(a, { level: "item" }), {
          expectedVersion: 1,
        }),
      ),
    ).toEqual(["wrong_level"]);
    ok(
      await service.updateRecord(ctx(org), b.id, draftOf(b, { parentId: fonds.id }), {
        expectedVersion: 1,
      }),
    );
  });

  it("identifiers changed with the record: dropping a number needs confirming, and fields must show held numbers", async () => {
    await ready();
    const org = await organization();
    const record = await create(
      org,
      objectDraft({ number: { type: "object_number", value: "DHS-1" } }),
      { identifiers: numbers("DHS-1") },
    );
    // Renumbered, keeping the old number as former: no confirmation needed.
    const renumbered = {
      current: [{ type: "object_number", value: "DHS-2", primary: true }],
      former: [{ type: "object_number", value: "DHS-1", note: "Renumbered." }],
    };
    expect(
      codes(
        await service.updateRecord(ctx(org), record.id, draftOf(record), {
          expectedVersion: 1,
          identifiers: renumbered,
        }),
      ),
    ).toEqual(["identifier_not_held"]);
    const moved = draftOf(record, {
      fields: { note: "Oak.", number: { type: "object_number", value: "DHS-2" } },
    });
    ok(
      await service.updateRecord(ctx(org), record.id, moved, {
        expectedVersion: 1,
        identifiers: renumbered,
      }),
    );
    // Dropping DHS-1 for good needs the person to confirm it.
    const dropped = await service.saveIdentifiers(ctx(org), record.id, numbers("DHS-2"));
    expect(codes(dropped)).toEqual(["numbers_dropped"]);
    ok(
      await service.saveIdentifiers(ctx(org), record.id, numbers("DHS-2"), {
        confirmDropped: [{ type: "object_number", value: "DHS-1" }],
      }),
    );
    // Dropping the number its field shows is refused, even confirmed.
    expect(
      codes(
        await service.saveIdentifiers(
          ctx(org),
          record.id,
          { current: [], former: [] },
          {
            confirmDropped: [{ type: "object_number", value: "DHS-2" }],
          },
        ),
      ),
    ).toEqual(["identifier_not_held"]);
    expect(ok(await readRecordIdentifiers(s.owner, org, record.id)).current).toEqual([
      { type: "object_number", value: "DHS-2", primary: true },
    ]);
  });
});

describe("restoring through the service", () => {
  it("restores an old version as the next one and refreshes the terms", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft({ subjects: [RAILROADS] }));
    ok(
      await service.updateRecord(
        ctx(org),
        record.id,
        draftOf(record, { fields: { note: "Oak." } }),
        { expectedVersion: 1 },
      ),
    );
    expect(ok(await recordsUsingTerm(s.owner, org, ok(termKey(RAILROADS)))).records).toEqual([]);
    const restored = ok(
      await service.restoreVersion(ctx(org, BOB), record.id, 1, {
        expectedVersion: 2,
        reason: "Undo.",
      }),
    );
    expect(restored).toMatchObject({ version: 3, actor: BOB, reason: "restored version 1: Undo." });
    expect(
      ok(await recordsUsingTerm(s.owner, org, ok(termKey(RAILROADS)))).records.map(
        (r) => r.recordId,
      ),
    ).toEqual([record.id]);
    expect(
      codes(await service.restoreVersion(ctx(org), record.id, 1, { expectedVersion: 2 })),
    ).toEqual(["version_conflict"]);
  });
});

describe("deleting records", () => {
  it("leaves a tombstone as the last version, keeps the history, clears the terms and never reuses the ID", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft({ subjects: [RAILROADS] }));
    ok(
      await service.updateRecord(ctx(org), record.id, draftOf(record, { title: "Renamed" }), {
        expectedVersion: 1,
      }),
    );
    const deleted = ok(
      await service.deleteRecord(ctx(org, BOB), record.id, {
        expectedVersion: 2,
        reason: "Duplicate.",
      }),
    );
    expect(deleted).toMatchObject({
      recordId: record.id,
      version: 3,
      actor: BOB,
      reason: "Duplicate.",
    });
    expect(await rowExists(org, record.id)).toBe(false);
    const history = ok(await readVersions(s.owner, org, record.id)).versions;
    expect(history.map((v) => [v.version, v.action])).toEqual([
      [1, "save"],
      [2, "save"],
      [3, "delete"],
    ]);
    expect(history[2]?.record.title).toBe("Renamed");
    expect(history[2]?.changedFields).toEqual([]);
    expect(ok(await recordsUsingTerm(s.owner, org, ok(termKey(RAILROADS)))).records).toEqual([]);
    // Nothing can be written to it again.
    expect(
      codes(
        await service.updateRecord(ctx(org), record.id, draftOf(record), { expectedVersion: 3 }),
      ),
    ).toEqual(["unknown_record"]);
    expect(codes(await service.deleteRecord(ctx(org), record.id, { expectedVersion: 3 }))).toEqual([
      "unknown_record",
    ]);
    expect(
      codes(await service.restoreVersion(ctx(org), record.id, 1, { expectedVersion: 3 })),
    ).toEqual(["unknown_record"]);
    expect(
      await refusal(
        s.writer.execute(sql`
          INSERT INTO public.records (id, organization_id, kind, template_key, title, fields,
                                      created_at, updated_at)
          VALUES (${record.id}::uuid, ${org}::uuid, 'object', 'invented-object', 'Back',
                  '{}'::jsonb, ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`),
      ),
    ).toEqual({ code: IDENTITY, constraint: "records_id_used_before" });
  });

  it("refuses while anything needs the record, naming how many but not which", async () => {
    await ready();
    const org = await organization();
    const fonds = await create(org, unitDraft("fonds"));
    await create(org, unitDraft("series", fonds.id));
    expect(codes(await service.deleteRecord(ctx(org), fonds.id, { expectedVersion: 1 }))).toEqual([
      "has_children",
    ]);
    const maker = await create(org, agentDraft);
    const linking = await create(
      org,
      objectDraft({ creator: { recordId: maker.id, label: "A maker" } }),
    );
    const refused = await service.deleteRecord(ctx(org), maker.id, { expectedVersion: 1 });
    expect(codes(refused)).toEqual(["linked_from"]);
    expect(messages(refused)).not.toContain(linking.id);
    const chair = await create(org, objectDraft(), { identifiers: numbers("DHS-5") });
    await create(org, {
      kind: "digital_asset",
      title: "A scan",
      mediaType: "image/tiff",
      templateKey: "invented-asset",
      represents: chair.id,
    });
    expect(codes(await service.deleteRecord(ctx(org), chair.id, { expectedVersion: 1 }))).toEqual([
      "represented",
      "holds_identifiers",
    ]);
    expect(codes(await service.deleteRecord(ctx(org), linking.id, { expectedVersion: 5 }))).toEqual(
      ["version_conflict"],
    );
    for (const id of [fonds.id, maker.id, chair.id, linking.id]) {
      expect(await rowExists(org, id)).toBe(true);
    }
    // Once the link is gone, the maker can go.
    ok(
      await service.updateRecord(
        ctx(org),
        linking.id,
        draftOf(linking, { fields: { note: "Oak." } }),
        { expectedVersion: 1 },
      ),
    );
    ok(await service.deleteRecord(ctx(org), maker.id, { expectedVersion: 1 }));
  });
});

describe("deleting a place others point at", () => {
  it("refuses while a place value names it, single or in a list", async () => {
    await ready();
    const org = await organization();
    const place = (title: string) =>
      create(org, { kind: "place", title, templateKey: "invented-place" });
    const town = await place("An invented town");
    const depot = await place("An invented depot");
    const single = await create(
      org,
      objectDraft({ found_at: { label: "Town", recordId: town.id } }),
    );
    const listed = await create(
      org,
      objectDraft({
        shown_at: [{ label: "Nowhere" }, { label: "Depot", recordId: depot.id }],
      }),
    );
    for (const target of [town, depot]) {
      const refused = await service.deleteRecord(ctx(org), target.id, { expectedVersion: 1 });
      expect(codes(refused)).toEqual(["linked_from"]);
      expect(await rowExists(org, target.id)).toBe(true);
    }
    // A place named without a record doesn't hold anything back.
    ok(
      await service.updateRecord(
        ctx(org),
        single.id,
        draftOf(single, { fields: { note: "Oak.", found_at: { label: "Town" } } }),
        { expectedVersion: 1 },
      ),
    );
    ok(await service.deleteRecord(ctx(org), town.id, { expectedVersion: 1 }));
    expect(await rowExists(org, listed.id)).toBe(true);
  });
});

describe("two connections at once", () => {
  it("a save linking to a record being deleted waits, then finds it gone", async () => {
    await ready();
    const org = await organization();
    const maker = await create(org, agentDraft);
    const chair = await create(org, objectDraft());
    const go = signal();
    const done = signal();
    const deleting = s.writer2.transaction(async (q) => {
      const result = await deleteRecord(q, org, maker.id, { expectedVersion: 1, actor: BOB });
      done.resolve();
      await go.promise;
      return result;
    });
    await done.promise;
    const saving = service.updateRecord(
      ctx(org),
      chair.id,
      draftOf(chair, {
        fields: { note: "Oak.", creator: { recordId: maker.id, label: "A maker" } },
      }),
      { expectedVersion: 1 },
    );
    await someoneWaits();
    go.resolve();
    expect(ok(await deleting).version).toBe(2);
    expect(codes(await saving)).toEqual(["unknown_record"]);
    expect(ok(await readStoredRecord(s.owner, org, chair.id)).version).toBe(1);
  });

  it("a deletion waits for a save linking to the record, then refuses", async () => {
    await ready();
    const org = await organization();
    const maker = await create(org, agentDraft);
    const chair = await create(org, objectDraft());
    const go = signal();
    const saved = signal();
    // The service's save, held open after its work and before COMMIT.
    const held: Database = {
      ...s.writer2,
      rows: (q) => s.writer2.rows(q),
      execute: (q) => s.writer2.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) =>
        s.writer2.transaction(async (q) => {
          const result = await work(q);
          saved.resolve();
          await go.promise;
          return result;
        }),
    };
    const saving = createService(held, { now: () => NOW }).updateRecord(
      ctx(org),
      chair.id,
      draftOf(chair, {
        fields: { note: "Oak.", creator: { recordId: maker.id, label: "A maker" } },
      }),
      { expectedVersion: 1 },
    );
    await saved.promise;
    const deleting = service.deleteRecord(ctx(org), maker.id, { expectedVersion: 1 });
    await someoneWaits();
    go.resolve();
    expect(ok(await saving).version).toBe(2);
    expect(codes(await deleting)).toEqual(["linked_from"]);
    expect(await rowExists(org, maker.id)).toBe(true);
  });

  it("two creates taking the same number at once: one wins, the other stores nothing", async () => {
    await ready();
    const org = await organization();
    const results = await Promise.all([
      service.createRecord(ctx(org), objectDraft(), { identifiers: numbers("DHS-42") }),
      service2.createRecord(ctx(org, BOB), objectDraft(), { identifiers: numbers("DHS-42") }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => codes(r))).toEqual(["not_unique"]);
    const [count] = await s.owner.rows<{ n: number }>(sql`
      SELECT count(*)::integer AS n FROM public.records WHERE organization_id = ${org}::uuid`);
    expect(count?.n).toBe(1);
  });

  it("two moves filing units under each other at once: one is refused as a loop", async () => {
    await ready();
    const org = await organization();
    const fonds = await create(org, unitDraft("fonds"));
    const a = await create(org, unitDraft("series", fonds.id));
    const b = await create(org, unitDraft("series", fonds.id));
    const results = await Promise.all([
      service.updateRecord(ctx(org), a.id, draftOf(a, { parentId: b.id }), { expectedVersion: 1 }),
      service2.updateRecord(ctx(org), b.id, draftOf(b, { parentId: a.id }), { expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => codes(r))).toEqual(["loop"]);
  });

  it("a new template version waits for a save checking against the current one", async () => {
    await ready();
    const org = await organization();
    const go = signal();
    const held = signal();
    // A transaction holding the save's shared lock on the template.
    const saving = s.writer2.transaction(async (q) => {
      await lockDefinition(q, org, "template", "invented-object");
      held.resolve();
      await go.promise;
    });
    await held.promise;
    let written = false;
    const changing = insertTemplateVersion(s.owner, {
      key: "invented-object",
      organizationId: org,
      label: "Invented objects, version 2",
      appliesTo: ["object"],
      fields: [field("note", "text")],
    }).then((r) => {
      written = true;
      return r;
    });
    await someoneWaits();
    expect(written).toBe(false);
    go.resolve();
    await saving;
    expect(ok(await changing).version).toBe(2);

    // The same for a record type's versions.
    const go2 = signal();
    const held2 = signal();
    const saving2 = s.writer2.transaction(async (q) => {
      await lockDefinition(q, org, "record_type", "chair");
      held2.resolve();
      await go2.promise;
    });
    await held2.promise;
    let typed = false;
    const retyping = insertRecordTypeVersion(s.owner, {
      key: "chair",
      organizationId: org,
      label: "Chair, version 2",
      kind: "object",
      defaultTemplateKey: "invented-object",
    }).then((r) => {
      typed = true;
      return r;
    });
    await someoneWaits();
    expect(typed).toBe(false);
    go2.resolve();
    await saving2;
    expect(ok(await retyping).version).toBe(2);
  });

  it("two edits from one version: one saves, the other gets the conflict", async () => {
    await ready();
    const org = await organization();
    const record = await create(org, objectDraft());
    const results = await Promise.all([
      service.updateRecord(ctx(org), record.id, draftOf(record, { title: "Alice's" }), {
        expectedVersion: 1,
      }),
      service2.updateRecord(ctx(org, BOB), record.id, draftOf(record, { title: "Bob's" }), {
        expectedVersion: 1,
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => codes(r))).toEqual(["version_conflict"]);
    expect(await versionCount(org, record.id)).toBe(2);
  });
});

describe("clean errors", () => {
  it("retries a deadlock, then returns retry without the database's text", async () => {
    await ready();
    const org = await organization();
    const deadlock = Object.assign(new Error('deadlock detected on relation "public.records"'), {
      code: "40P01",
    });
    let calls = 0;
    const flaky: Database = {
      rows: (q) => s.writer.rows(q),
      execute: (q) => s.writer.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) => {
        calls += 1;
        return calls === 1 ? Promise.reject(deadlock) : s.writer.transaction(work);
      },
    };
    ok(await createService(flaky, { now: () => NOW }).createRecord(ctx(org), objectDraft()));
    expect(calls).toBe(2);
    const always: Database = { ...flaky, transaction: () => Promise.reject(deadlock) };
    const errors: unknown[] = [];
    const result = await createService(always, {
      attempts: 2,
      onError: (e) => errors.push(e),
    }).createRecord(ctx(org), objectDraft());
    expect(codes(result)).toEqual(["retry"]);
    expect(messages(result)).not.toContain("relation");
    expect(errors).toEqual([deadlock]);
  });

  it("anything unexpected is internal_error, with the error only for the log", async () => {
    await ready();
    const org = await organization();
    const secret = new Error("connection to 10.0.0.5 failed: password authentication failed");
    const broken: Database = {
      rows: () => Promise.reject(secret),
      execute: () => Promise.reject(secret),
      close: () => Promise.resolve(),
      transaction: () => Promise.reject(secret),
    };
    const logged: [unknown, string][] = [];
    const result = await createService(broken, {
      onError: (e, op) => {
        logged.push([e, op]);
        throw new Error("the log is down");
      },
    }).deleteRecord(ctx(org), newRecordId(), { expectedVersion: 1 });
    expect(codes(result)).toEqual(["internal_error"]);
    expect(messages(result)).not.toContain("password");
    expect(logged).toEqual([[secret, "deleteRecord"]]);
    expect(() => createService(broken, { attempts: 0 })).toThrow(RangeError);
  });
});
