// Backup and restore (D-064): a migrated database with organizations,
// records, identifiers, terms and other objects is backed up and restored by
// a role that is not a superuser into a fresh empty database it owns, and
// every row of every table is found and identical. Refusals (a target that is
// not exactly as CREATE DATABASE made it, a damaged or edited file, a missing
// file, migrations that don't match, a migration running, a superuser) leave
// the target untouched and say why; the backup file is 0600; the driver and
// the tools always reach the same database; a stop mid-backup or mid-restore
// leaves no process, file or commit behind; and the URL and its password are
// never printed, on a command line, or in the tools' environment.
import {
  execFileSync,
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STANDARD_PRESETS,
  createRecord,
  newOrganizationId,
  templateFromPreset,
  type IdentifierType,
  type JsonValue,
  type OrganizationId,
  type RecordId,
  type Validated,
} from "@oculus/core";
import {
  backup,
  BackupError,
  compareMigrations,
  findTools,
  manifestAndTrailer,
  readManifest,
  restore,
  streamArchive,
  toolMajor,
  TRAILER_BYTES,
  WATCHDOG,
  type BackupManifest,
} from "./backup.js";
import { contentsOf, tableSummaries } from "./backup-catalog.js";
import { filePath, hideSecrets, runBackupCli, runRestoreCli, SAME_STOP_MS } from "./backup-cli.js";
import {
  ConnectionError,
  MAX_SERVICE_LINE,
  passwordFileText,
  resolveConnection,
  serviceFileText,
  toolEnvironment,
} from "./backup-connection.js";
import { openDatabase, openSession, type Database } from "./client.js";
import { insertOrganization, insertRecord, insertTemplateVersion, readRecord } from "./catalog.js";
import {
  allocateIdentifier,
  insertIdentifierType,
  readIdentifierTypes,
  readRecordIdentifiers,
  saveRecordIdentifiers,
} from "./identifiers.js";
import {
  defaultMigrationsDir,
  migrate,
  MIGRATION_LOCK_KEY,
  readMigrations,
  type MigrationFile,
} from "./migrate.js";
import { sql } from "./sql.js";
import { freshDatabase, testServerUrl, type TestDatabase } from "./test-database.fixtures.js";
import { readTerms, refreshRecordTerms, saveTerm } from "./vocabularies.js";

const T = "2026-11-20T16:05:00.000Z";
/** An obviously fake password: the test server uses trust authentication and ignores it. */
const FAKE_PASSWORD = "not-a-real-password-T052";
/** Roles this file makes (cluster-wide, so fixed names; dropped afterwards). */
const RESTORER = "oculus_t052_restorer";
const READER = "oculus_t052_reader";

// ---------------------------------------------------------------------------
// Databases, roles and files made by this file, removed afterwards.

const databases: TestDatabase[] = [];
const directories: string[] = [];
const pools: Database[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  for (const db of pools) await db.close().catch(() => undefined);
  for (const db of databases) await db.drop().catch(() => undefined);
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
  await admin((s) =>
    s.rows(sql`DO $$ BEGIN
      DROP ROLE IF EXISTS oculus_t052_restorer;
      DROP ROLE IF EXISTS oculus_t052_reader;
      DROP ROLE IF EXISTS oculus_t052_sneaky;
      DROP ROLE IF EXISTS oculus_t052_files;
      DROP ROLE IF EXISTS oculus_t052_creator;
      DROP ROLE IF EXISTS oculus_t052_signal;
      DROP ROLE IF EXISTS oculus_t052_nested;
      DROP ROLE IF EXISTS oculus_t052_admins;
      DROP ROLE IF EXISTS oculus_t052_createdb;
      DROP ROLE IF EXISTS oculus_t052_replicator;
      DROP ROLE IF EXISTS oculus_t052_bypass;
      DROP ROLE IF EXISTS oculus_t052_subscriber;
      DROP ROLE IF EXISTS oculus_t052_reader2;
      DROP ROLE IF EXISTS oculus_t052_param;
      DROP ROLE IF EXISTS oculus_t052_gone;
    EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END $$`),
  ).catch(() => undefined);
});

async function database(): Promise<TestDatabase> {
  const db = await freshDatabase();
  databases.push(db);
  return db;
}

function pool(url: string): Database {
  const db = openDatabase(url, { max: 2 });
  pools.push(db);
  return db;
}

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oculus-t052-"));
  directories.push(dir);
  return dir;
}

function ok<T>(result: Validated<T> | undefined): T {
  if (result === undefined) throw new Error("not found");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

async function refusal(work: Promise<unknown>): Promise<BackupError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BackupError) return error;
    throw error;
  }
  throw new Error("It was not refused.");
}

/** Runs `work` on one session to the test server's maintenance database. */
async function admin<R>(
  work: (s: Awaited<ReturnType<typeof openSession>>) => Promise<R>,
): Promise<R> {
  const session = await openSession(testServerUrl(), "t052-admin");
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** Runs a statement naming a database (`%I`), which no parameter can do. */
async function onDatabase(template: string, name: string): Promise<void> {
  await admin(async (s) => {
    await s.rows(sql`CREATE FUNCTION pg_temp.t052_exec(t text, d text) RETURNS void
      LANGUAGE plpgsql AS $f$ BEGIN EXECUTE pg_catalog.format(t, d); END $f$`);
    await s.rows(sql`SELECT pg_temp.t052_exec(${template}, ${name})`);
  });
}

let rolesMade: Promise<void> | undefined;
function roles(): Promise<void> {
  rolesMade ??= admin(async (s) => {
    await s.rows(sql`DO $$ BEGIN
      CREATE ROLE oculus_t052_restorer LOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await s.rows(sql`DO $$ BEGIN
      CREATE ROLE oculus_t052_reader NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  });
  return rolesMade;
}

/** The URL as another user (the test server trusts its socket). */
function as(url: string, user: string, password?: string): string {
  const u = new URL(url);
  u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

/** A fresh empty database owned by the restoring role, and its URL as that role. */
async function emptyTarget(): Promise<{ testDb: TestDatabase; url: string }> {
  await roles();
  const testDb = await database();
  await onDatabase(`ALTER DATABASE %I OWNER TO ${RESTORER}`, testDb.name);
  return { testDb, url: as(testDb.url, RESTORER) };
}

/** Waits for `check` to be true, up to `ms`. */
async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting.");
}

/**
 * Live processes (not zombies: an orphan's zombie may never be reaped in a
 * sandbox whose init doesn't reap) as `pid pgid` pairs.
 */
function liveProcesses(): { pid: number; pgid: number }[] {
  return execFileSync("ps", ["-eo", "pid=,pgid=,stat="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length === 3 && !(f[2] ?? "").startsWith("Z"))
    .map((f) => ({ pid: Number(f[0]), pgid: Number(f[1]) }));
}

function alive(pid: number): boolean {
  return liveProcesses().some((p) => p.pid === pid);
}

function groupAlive(pgid: number): boolean {
  return liveProcesses().some((p) => p.pgid === pgid);
}

// ---------------------------------------------------------------------------
// Invented sample data.

interface Sample {
  orgs: OrganizationId[];
  records: { org: OrganizationId; id: RecordId }[];
}

function identifierTypes(org: OrganizationId): IdentifierType[] {
  return [
    {
      organizationId: org,
      key: "object_number",
      label: "Object number",
      uniqueness: "current",
      autoNumber: { style: "prefix", prefix: "INV-", digits: 4 },
      public: true,
    },
    { organizationId: org, key: "box_label", label: "Box label", uniqueness: "none" },
  ];
}

/** A migrated database with two organizations, records, identifiers and terms. */
async function populated(): Promise<{ testDb: TestDatabase; sample: Sample }> {
  const testDb = await database();
  await migrate({ connectionString: testDb.url });
  const db = pool(testDb.url);
  const sample: Sample = { orgs: [], records: [] };
  const preset = STANDARD_PRESETS.find((p) => p.key === "spectrum-object");
  for (const name of ["Invented Historical Society", "Invented County Museum"]) {
    const org = newOrganizationId();
    sample.orgs.push(org);
    ok(await insertOrganization(db, { id: org, name }));
    ok(await insertTemplateVersion(db, ok(templateFromPreset(preset, org))));
    for (const type of identifierTypes(org)) {
      ok(await db.transaction((q) => insertIdentifierType(q, type)));
    }
    ok(
      await db.transaction((q) =>
        saveTerm(q, { organizationId: org, term: { label: "Invented Street depot" } }),
      ),
    );
    const fields: Record<string, JsonValue>[] = [
      {
        subjects: [
          {
            label: "Railroads",
            vocabulary: "lcsh",
            uri: "http://id.loc.gov/authorities/subjects/sh85110870",
          },
          { label: "Invented Street depot" },
        ],
        materials: [{ label: "Wood", vocabulary: "local" }],
      },
      { subjects: [{ label: "Invented Street depot" }] },
      {},
    ];
    for (const [i, f] of fields.entries()) {
      const made = ok(
        createRecord(
          {
            organizationId: org,
            kind: "object",
            title: `An invented chair, number ${String(i + 1)} — “quoted”, ñ`,
            templateKey: "spectrum-object",
            fields: f,
          },
          new Date(T),
        ),
      );
      ok(await insertRecord(db, made));
      sample.records.push({ org, id: made.id });
      const number = ok(await db.transaction((q) => allocateIdentifier(q, org, "object_number")));
      ok(
        await db.transaction((q) =>
          saveRecordIdentifiers(q, {
            recordId: made.id,
            organizationId: org,
            current: [
              { type: "object_number", value: number, primary: true },
              { type: "box_label", value: `Box ${String(i)}`, primary: false },
            ],
            former: [{ type: "object_number", value: `old ${String(i)}`, retiredAt: T }],
          }),
        ),
      );
      ok(await db.transaction((q) => refreshRecordTerms(q, org, made.id)));
    }
  }
  return { testDb, sample };
}

/** XML's escapes, undone (query_to_xml escapes the text it returns). */
function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name] ?? "";
  });
}

/** Every row of every table, as text, sorted: table-driven, so new tables are covered. */
async function everyRow(db: Database): Promise<Record<string, string[]>> {
  const tables = await tableSummaries(db);
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    const [schema, name] = table.name.split(".");
    const rows = await db.rows<{ row: string }>(sql`
      SELECT r.row::pg_catalog.text AS row FROM pg_catalog.unnest(pg_catalog.xpath('/table/row/r/text()',
        pg_catalog.query_to_xml(pg_catalog.format(
          'SELECT ROW(oculus_test_row.*)::pg_catalog.text AS r FROM %I.%I AS oculus_test_row', ${schema ?? ""}::text, ${name ?? ""}::text),
          false, false, ''))) AS r(row)`);
    out[table.name] = rows.map((r) => unescapeXml(r.row)).sort();
  }
  return out;
}

/** The backup file with its manifest replaced (and its hash recomputed, as an editor would). */
async function rewriteManifest(
  file: string,
  change: (manifest: BackupManifest) => void,
): Promise<void> {
  const manifest = await readManifest(file);
  const bytes = await readFile(file);
  change(manifest);
  await writeFile(
    file,
    Buffer.concat([bytes.subarray(0, manifest.dump.bytes), manifestAndTrailer(manifest)]),
  );
}

async function copyOf(file: string, dir: string, name: string): Promise<string> {
  const copy = join(dir, name);
  await writeFile(copy, await readFile(file), { mode: 0o600 });
  return copy;
}

/** Objects beyond rows: a sequence, a function, a trigger, row security, a policy, grants. */
async function addObjects(url: string): Promise<void> {
  await roles();
  const db = pool(url);
  for (const statement of [
    sql`CREATE SEQUENCE public.t052_seq`,
    sql`SELECT pg_catalog.nextval('public.t052_seq')`,
    sql`CREATE FUNCTION public.t052_touch() RETURNS trigger LANGUAGE plpgsql
        AS $f$ BEGIN RETURN NEW; END $f$`,
    sql`CREATE TABLE public.t052_extra (id int PRIMARY KEY, oculus_backup_row text, t text)`,
    sql`INSERT INTO public.t052_extra VALUES (1, 'a', 'x'), (2, NULL, 'y')`,
    sql`CREATE TRIGGER t052_extra_touch BEFORE UPDATE ON public.t052_extra
        FOR EACH ROW EXECUTE FUNCTION public.t052_touch()`,
    sql`ALTER TABLE public.t052_extra ENABLE ROW LEVEL SECURITY`,
    sql`CREATE POLICY t052_read ON public.t052_extra FOR SELECT TO oculus_t052_reader USING (id > 0)`,
    sql`GRANT SELECT ON public.t052_extra TO oculus_t052_reader`,
    sql`GRANT SELECT ON public.records TO oculus_t052_reader`,
  ]) {
    await db.execute(statement);
  }
}

// One backup of one populated database, shared by the refusal tests.
interface Shared {
  file: string;
  dir: string;
  sample: Sample;
  source: TestDatabase;
}
let shared: Promise<Shared> | undefined;
function sharedBackup(): Promise<Shared> {
  shared ??= (async () => {
    const { testDb, sample } = await populated();
    await addObjects(testDb.url);
    const dir = await directory();
    const file = join(dir, "shared.oculus-backup");
    await backup({ connectionString: testDb.url, file });
    return { file, dir, sample, source: testDb };
  })();
  return shared;
}

/**
 * A PG_BIN of wrappers around the real tools: `body(tool, real)` is the shell
 * text that runs in place of each tool.
 */
async function wrappedTools(body: (tool: string, real: string) => string): Promise<string> {
  const real = await findTools(process.env, ["pg_dump", "pg_restore"]);
  const bin = await directory();
  for (const tool of ["pg_dump", "pg_restore"]) {
    // `--version` (asked before every run) goes straight to the real tool.
    await writeFile(
      join(bin, tool),
      `#!/bin/sh\nif [ "$1" = --version ]; then exec '${join(real, tool)}' "$@"; fi\n${body(tool, join(real, tool))}\n`,
    );
    await chmod(join(bin, tool), 0o755);
  }
  return bin;
}

// ---------------------------------------------------------------------------

describe("backup and restore", () => {
  it("restores every row and object identically, as a role that is not a superuser", async () => {
    const { testDb, sample } = await populated();
    await addObjects(testDb.url);
    const dir = await directory();
    const temp = await directory();
    const file = join(dir, "nightly.oculus-backup");
    const logged: string[] = [];
    const made = await backup({
      connectionString: testDb.url,
      file,
      tempDir: temp,
      log: (line) => logged.push(line),
    });
    expect(made.file).toBe(file);
    expect(logged.join("\n")).toContain("Backing up PostgreSQL");

    // The file: 0600, nothing else left behind.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["nightly.oculus-backup"]);
    expect(await readdir(temp)).toEqual([]);

    // The manifest describes the database.
    const manifest = await readManifest(file);
    expect(manifest).toEqual(made.manifest);
    const source = pool(testDb.url);
    expect(manifest.migrations).toEqual(
      await source.rows(sql`SELECT name, sha256 FROM public.oculus_migrations ORDER BY name`),
    );
    expect(manifest.migrations.map((m) => m.name)).toEqual(
      (await readMigrations(defaultMigrationsDir())).map((m) => m.name),
    );
    const counts = Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows]));
    expect(counts).toMatchObject({
      "public.organizations": "2",
      "public.records": "6",
      "public.record_identifiers": "12",
      "public.former_identifiers": "6",
      "public.terms": "2",
      "public.t052_extra": "2",
    });
    expect(Number(counts["public.record_terms"])).toBeGreaterThan(0);
    expect(manifest.objects.sequences).toContain("public.t052_seq");
    expect(manifest.objects.functions.some((f) => f.startsWith("public.t052_touch() f "))).toBe(
      true,
    );
    expect(
      manifest.objects.triggers.some((t) => t.startsWith("public.t052_extra t052_extra_touch ")),
    ).toBe(true);
    expect(manifest.objects.policies).toContain("public.t052_extra row security on");
    expect(
      manifest.objects.policies.some((p) =>
        p.startsWith("public.t052_extra policy t052_read r permissive to oculus_t052_reader "),
      ),
    ).toBe(true);
    expect(manifest.objects.grants).toEqual(
      expect.arrayContaining([
        "relation public.records to oculus_t052_reader: SELECT",
        "relation public.t052_extra to oculus_t052_reader: SELECT",
        "schema public to PUBLIC: USAGE",
      ]),
    );
    expect(manifest.serverVersionNum).toBeGreaterThanOrEqual(150000);
    expect(toolMajor(manifest.pgDumpVersion)).toBeGreaterThanOrEqual(15);

    // Restore into a fresh database, as the role that owns it.
    const target = await emptyTarget();
    expect(await contentsOf(pool(target.url))).toEqual({});
    const result = await restore({ connectionString: target.url, file, tempDir: temp });
    expect(result.pending).toEqual([]);
    expect(await readdir(temp)).toEqual([]);
    const restored = pool(target.url);

    // Every table, every row, identical.
    const before = await everyRow(source);
    const after = await everyRow(restored);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after).toEqual(before);
    expect(after["public.records"]).toHaveLength(6);

    // And through the data-access functions.
    for (const { org, id } of sample.records) {
      expect(ok(await readRecord(restored, org, id))).toEqual(
        ok(await readRecord(source, org, id)),
      );
      expect(ok(await readRecordIdentifiers(restored, org, id))).toEqual(
        ok(await readRecordIdentifiers(source, org, id)),
      );
    }
    for (const org of sample.orgs) {
      expect(ok(await readTerms(restored, org))).toEqual(ok(await readTerms(source, org)));
      expect(ok(await readIdentifierTypes(restored, org))).toEqual(
        ok(await readIdentifierTypes(source, org)),
      );
      // The auto-number counter carries on where it was.
      const next = (db: Database): Promise<Validated<string>> =>
        db.transaction((q) => allocateIdentifier(q, org, "object_number"));
      expect(ok(await next(restored))).toBe(ok(await next(source)));
    }
    // The restored objects are owned by the restoring role.
    const [owner] = await restored.rows<{ owner: string }>(
      sql`SELECT pg_catalog.pg_get_userbyid(relowner)::text AS owner FROM pg_catalog.pg_class
          WHERE oid = 'public.records'::pg_catalog.regclass`,
    );
    expect(owner?.owner).toBe(RESTORER);

    // The restored database migrates (nothing to do).
    expect((await migrate({ connectionString: target.url })).applied).toEqual([]);
  }, 60_000);

  it("never overwrites: an existing backup file, or a database that is not empty", async () => {
    const { file, dir, source } = await sharedBackup();
    const before = await readFile(file);
    const exists = await refusal(backup({ connectionString: source.url, file }));
    expect(exists.code).toBe("exists");
    expect(await readFile(file)).toEqual(before);

    const full = await refusal(
      restore({ connectionString: source.url, file, allowSuperuser: true }),
    );
    expect(full.code).toBe("target_not_empty");
    expect(full.message).toMatch(/relations/);
    expect(await readdir(dir)).toEqual(["shared.oculus-backup"]);
  }, 60_000);

  // Each makes a fresh database differ from what CREATE DATABASE makes in one
  // way pg_dump's archive could collide with or be changed by.
  const notEmpty: [string, string[], string[]?][] = [
    ["a table", ["CREATE TABLE public.something_else (id int)"]],
    ["a schema", ["CREATE SCHEMA elsewhere"]],
    ["default privileges", ["ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC"]],
    ["a publication", ["CREATE PUBLICATION t052_pub"]],
    ["the public schema's owner", [`ALTER SCHEMA public OWNER TO ${RESTORER}`]],
    ["the public schema's privileges", ["GRANT CREATE ON SCHEMA public TO PUBLIC"]],
    ["the public schema's comment", ["COMMENT ON SCHEMA public IS 'changed'"]],
    ["no public schema", ["DROP SCHEMA public"]],
    ["database settings", ["%DB ALTER DATABASE %I SET search_path = elsewhere"]],
    [
      "a role's settings in this database",
      [`%DB ALTER ROLE ${READER} IN DATABASE %I SET work_mem = '1MB'`],
    ],
    [
      "a subscription",
      [
        "CREATE SUBSCRIPTION t052_sub CONNECTION 'dbname=nowhere' PUBLICATION nothing WITH (connect = false)",
      ],
      ["ALTER SUBSCRIPTION t052_sub SET (slot_name = NONE)", "DROP SUBSCRIPTION t052_sub"],
    ],
    ["a foreign-data wrapper", ["CREATE FOREIGN DATA WRAPPER t052_fdw"]],
    [
      "a foreign server",
      [
        "CREATE FOREIGN DATA WRAPPER t052_fdw2",
        "CREATE SERVER t052_srv FOREIGN DATA WRAPPER t052_fdw2",
      ],
    ],
    ["a cast", ["CREATE CAST (uuid AS bytea) WITH INOUT"]],
    ["a collation", ['CREATE COLLATION public.t052_c FROM "C"']],
    [
      "a text search configuration",
      ["CREATE TEXT SEARCH CONFIGURATION public.t052_ts (COPY = pg_catalog.simple)"],
    ],
    [
      "an operator",
      ["CREATE OPERATOR public.=== (LEFTARG = int4, RIGHTARG = int4, FUNCTION = int4eq)"],
    ],
    ["a large object", ["SELECT pg_catalog.lo_create(0)"]],
  ];

  it.each(notEmpty)(
    "refuses a target with %s, and leaves it as it was",
    async (_what, statements, undo = []) => {
      const { file } = await sharedBackup();
      await roles();
      const target = await database();
      const db = pool(target.url);
      // Statements are fixed test text; the database name goes through %I.
      const run = async (text: string): Promise<void> => {
        if (text.startsWith("%DB ")) {
          await onDatabase(text.slice(4), target.name);
          return;
        }
        const session = await openSession(target.url, "t052-setup");
        try {
          await session.runScript(text);
        } finally {
          await session.close();
        }
      };
      for (const statement of statements) await run(statement);
      cleanups.push(async () => {
        for (const statement of undo) await run(statement);
      });
      const before = await everyRow(db);
      const refused = await refusal(
        restore({ connectionString: target.url, file, allowSuperuser: true }),
      );
      expect(refused.code).toBe("target_not_empty");
      expect(await everyRow(db)).toEqual(before);
      for (const statement of undo) await run(statement);
    },
    60_000,
  );

  it("refuses a damaged, edited, truncated or missing file and leaves the target empty", async () => {
    const { file, dir } = await sharedBackup();
    const target = await emptyTarget();
    const manifest = await readManifest(file);
    const attempt = (path: string): Promise<BackupError> =>
      refusal(restore({ connectionString: target.url, file: path }));

    // One byte of the archive changed.
    const damaged = await copyOf(file, dir, "damaged");
    const bytes = await readFile(damaged);
    const at = Math.floor(manifest.dump.bytes / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await writeFile(damaged, bytes);
    const damage = await attempt(damaged);
    expect(damage.code).toBe("bad_file");
    expect(damage.message).toContain("SHA-256");

    // One byte of the manifest changed (its hash no longer matches).
    const edited = await copyOf(file, dir, "edited");
    const editedBytes = await readFile(edited);
    const where = editedBytes.toString("latin1").indexOf('"rows": "6"');
    expect(where).toBeGreaterThan(0);
    editedBytes.write('"rows": "7"', where, "latin1");
    await writeFile(edited, editedBytes);
    expect((await attempt(edited)).code).toBe("bad_file");

    // Cut short, or not a backup at all.
    const truncated = await copyOf(file, dir, "truncated");
    await writeFile(truncated, (await readFile(file)).subarray(0, manifest.dump.bytes + 10));
    expect((await attempt(truncated)).code).toBe("bad_file");
    const notBackup = join(dir, "not-a-backup");
    await writeFile(notBackup, "hello\n");
    expect((await attempt(notBackup)).code).toBe("bad_file");

    // Rewritten consistently but describing another archive, or another shape.
    const otherSha = await copyOf(file, dir, "other-sha");
    await rewriteManifest(otherSha, (m) => {
      m.dump.sha256 = "0".repeat(64);
    });
    expect((await attempt(otherSha)).code).toBe("bad_file");
    const badShape = await copyOf(file, dir, "bad-shape");
    await rewriteManifest(badShape, (m) => {
      (m as unknown as Record<string, unknown>).extra = true;
    });
    expect((await attempt(badShape)).message).toContain("expected fields");

    expect((await attempt(join(dir, "nothing-here"))).code).toBe("not_found");
    expect(await contentsOf(pool(target.url))).toEqual({});
  }, 60_000);

  it("refuses a backup whose migrations don't match the code's, before restoring anything", async () => {
    const { file, dir } = await sharedBackup();
    const target = await emptyTarget();
    const edited = await copyOf(file, dir, "edited-migration");
    await rewriteManifest(edited, (m) => {
      const first = m.migrations[0];
      if (first) first.sha256 = "a".repeat(64);
    });
    const refused = await refusal(restore({ connectionString: target.url, file: edited }));
    expect(refused.code).toBe("migrations_differ");
    expect(refused.message).toContain("0001_migrations_table.sql in the backup differs");
    expect(await contentsOf(pool(target.url))).toEqual({});
  }, 60_000);

  it("checks rows and objects after restoring and says what differs", async () => {
    const { file, dir } = await sharedBackup();
    const cases: [string, (m: BackupManifest) => void, string][] = [
      [
        "count",
        (m) => {
          const t = m.tables.find((x) => x.name === "public.records");
          if (t) t.rows = "7";
        },
        "public.records has 6 rows, not 7",
      ],
      [
        "hash",
        (m) => {
          const t = m.tables.find((x) => x.name === "public.terms");
          if (t) t.rowsHash = "12345";
        },
        "public.terms's rows differ",
      ],
      [
        "grant",
        (m) => {
          m.objects.grants = m.objects.grants.filter(
            (g) => !g.startsWith("relation public.records"),
          );
        },
        "grants not in the backup: relation public.records to oculus_t052_reader: SELECT",
      ],
      [
        "sequence",
        (m) => {
          m.objects.sequences = [...m.objects.sequences, "public.zz_missing"].sort();
        },
        "sequences missing: public.zz_missing",
      ],
    ];
    for (const [name, change, expected] of cases) {
      const edited = await copyOf(file, dir, `edited-${name}`);
      await rewriteManifest(edited, change);
      const target = await emptyTarget();
      const refused = await refusal(restore({ connectionString: target.url, file: edited }));
      expect(refused.code).toBe("verify_failed");
      expect(refused.message).toContain(expected);
      expect(refused.message).toContain("Do not use it");
    }
  }, 60_000);

  it("refuses while a migration holds the runner's lock on the target", async () => {
    const { file } = await sharedBackup();
    const target = await emptyTarget();
    const holder = await openSession(target.testDb.url, "test-lock");
    try {
      await holder.rows(
        sql`SELECT pg_catalog.pg_advisory_lock(${String(MIGRATION_LOCK_KEY)}::pg_catalog.int8)`,
      );
      expect((await refusal(restore({ connectionString: target.url, file }))).code).toBe(
        "target_busy",
      );
    } finally {
      await holder.close();
    }
    expect(await contentsOf(pool(target.url))).toEqual({});
  }, 60_000);

  it("refuses to restore as a superuser unless allowed, and then warns", async () => {
    const { file } = await sharedBackup();
    const target = await database();
    const refused = await refusal(restore({ connectionString: target.url, file }));
    expect(refused.code).toBe("superuser");
    expect(refused.message).toContain("OWNER");
    expect(await contentsOf(pool(target.url))).toEqual({});
    const logged: string[] = [];
    await restore({
      connectionString: target.url,
      file,
      allowSuperuser: true,
      log: (line) => logged.push(line),
    });
    expect(logged.join("\n")).toContain("WARNING: restoring as a role that is not plain");
  }, 60_000);

  it("checks and restores the database libpq would reach, even when the query string names it", async () => {
    const { file, source } = await sharedBackup();
    const empty = await database();
    // The path names an empty database, the query string the full one:
    // libpq (and so pg_restore) uses the query's, and so must the checks.
    const url = new URL(empty.url);
    url.searchParams.set("dbname", source.name);
    const refused = await refusal(
      restore({ connectionString: url.toString(), file, allowSuperuser: true }),
    );
    expect(refused.code).toBe("target_not_empty");
    expect(await contentsOf(pool(empty.url))).toEqual({});
    // Keywords the driver can't be given the same way are refused.
    const hostaddr = new URL(empty.url);
    hostaddr.searchParams.set("hostaddr", "127.0.0.1");
    expect((await refusal(restore({ connectionString: hostaddr.toString(), file }))).code).toBe(
      "bad_url",
    );
  }, 60_000);

  it("refuses to back up a database Oculus never migrated, leaving no file behind", async () => {
    const empty = await database();
    const dir = await directory();
    const refused = await refusal(
      backup({ connectionString: empty.url, file: join(dir, "x.oculus-backup") }),
    );
    expect(refused.code).toBe("not_oculus");
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);

  it("keeps its snapshot through idle and statement timeouts, and a lost session after pg_dump", async () => {
    const { testDb } = await populated();
    // The snapshot transaction sits idle while pg_dump starts (2 s here).
    await onDatabase(
      "ALTER DATABASE %I SET idle_in_transaction_session_timeout = '1s'",
      testDb.name,
    );
    await onDatabase("ALTER DATABASE %I SET statement_timeout = '1s'", testDb.name);
    const slow = await wrappedTools((_tool, real) => `sleep 2\nexec '${real}' "$@"`);
    const dir = await directory();
    const made = await backup({
      connectionString: testDb.url,
      file: join(dir, "slow.oculus-backup"),
      env: { ...process.env, PG_BIN: slow },
    });
    expect(made.manifest.dump.bytes).toBeGreaterThan(0);

    // pg_dump finishes, then the exporting session is ended: the backup stands.
    const real = await findTools(process.env, ["psql"]);
    const lost = await wrappedTools(
      (_tool, tool) => `'${tool}' "$@" || exit $?
'${join(real, "psql")}' "service=oculus_backup" -qAt -c "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = 'oculus-backup' AND pid <> pg_catalog.pg_backend_pid()" >/dev/null 2>&1
exit 0`,
    );
    const again = await backup({
      connectionString: testDb.url,
      file: join(dir, "lost.oculus-backup"),
      env: { ...process.env, PG_BIN: lost },
    });
    expect(again.manifest.tables.length).toBeGreaterThan(0);
    const target = await emptyTarget();
    await restore({ connectionString: target.url, file: join(dir, "lost.oculus-backup") });
  }, 60_000);
});

// ---------------------------------------------------------------------------

/**
 * A backup with a table whose check sleeps only in pg_restore's session, so
 * a restore is slow inside its one transaction.
 */
let slow: Promise<string> | undefined;
function slowBackup(): Promise<string> {
  slow ??= (async () => {
    const source = await database();
    await migrate({ connectionString: source.url });
    const db = pool(source.url);
    await db.execute(sql`CREATE FUNCTION public.t052_slow() RETURNS boolean LANGUAGE sql
      AS $f$ SELECT pg_catalog.pg_sleep(CASE WHEN pg_catalog.current_setting('application_name') = 'oculus-restore' THEN 0.5 ELSE 0 END) IS NOT NULL $f$`);
    await db.execute(sql`CREATE TABLE public.t052_slow_rows (id int CHECK (public.t052_slow()))`);
    await db.execute(
      sql`INSERT INTO public.t052_slow_rows SELECT g FROM pg_catalog.generate_series(1, 20) AS g`,
    );
    const dir = await directory();
    const file = join(dir, "slow.oculus-backup");
    await backup({ connectionString: source.url, file });
    return file;
  })();
  return slow;
}

/** Whether pg_restore (application_name oculus-restore) is connected to `database`, optionally waiting on `wait`. */
let serverPool: Database | undefined;
async function restoring(databaseName: string, wait?: string): Promise<boolean> {
  serverPool ??= pool(testServerUrl());
  const rows = await serverPool.rows(sql`
    SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE datname = ${databaseName} AND application_name = 'oculus-restore'
      AND (${wait ?? null}::text IS NULL OR wait_event = ${wait ?? null}::text)`);
  return rows.length > 0;
}

describe("stopping a backup or restore", () => {
  it("mid-backup: ends pg_dump and leaves no file, temporary file or process", async () => {
    const { testDb } = await populated();
    const dir = await directory();
    const temp = await directory();
    const pidFile = join(temp, "..", `t052-dump-pid-${String(process.pid)}`);
    cleanups.push(() => rm(pidFile, { force: true }));
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@" || exit $?\necho $$ > '${pidFile}'\nsleep 30`,
    );
    const controller = new AbortController();
    const running = backup({
      connectionString: testDb.url,
      file: join(dir, "stopped.oculus-backup"),
      env: { ...process.env, PG_BIN: bin },
      tempDir: temp,
      signal: controller.signal,
    });
    await until(() => existsSync(pidFile));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(pid)).toBe(true);
    controller.abort();
    const refused = await refusal(running);
    expect(refused.code).toBe("interrupted");
    await until(() => !alive(pid));
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(temp)).toEqual([]);
  }, 60_000);

  it("mid-restore: ends pg_restore, whose transaction rolls back, and leaves nothing behind", async () => {
    const file = await slowBackup();

    const target = await emptyTarget();
    const temp = await directory();
    const controller = new AbortController();
    const running = restore({
      connectionString: target.url,
      file,
      tempDir: temp,
      signal: controller.signal,
    });
    await until(() => restoring(target.testDb.name, "PgSleep"));
    controller.abort();
    const refused = await refusal(running);
    expect(refused.code).toBe("interrupted");
    expect(refused.message).toContain("rolled back");
    await until(async () => !(await restoring(target.testDb.name)));
    expect(await contentsOf(pool(target.url))).toEqual({});
    expect(await readdir(temp)).toEqual([]);
  }, 60_000);

  it("the watchdog ends the tool when the process that started it dies", async () => {
    const dir = await directory();
    const script = join(dir, "parent.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
const child = spawn("/bin/sh", ["-c", ${JSON.stringify(WATCHDOG)}, "oculus-tool", "/bin/sleep", "60"], {
  detached: true, stdio: ["pipe", "ignore", "ignore", "pipe"],
});
console.log(child.pid);
setInterval(() => {}, 1000);
`,
    );
    const pgid = await startParent(script);
    expect(groupAlive(pgid)).toBe(true);
    killParent();
    await until(() => !groupAlive(pgid));
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("the db:backup and db:restore commands", () => {
  it("print nothing secret and never pass the URL on a command line or in the tools' environment", async () => {
    const { testDb } = await populated();
    const target = await emptyTarget();
    const dir = await directory();
    const temp = await directory();
    const log = join(dir, "calls.log");
    const bin = await wrappedTools(
      (
        tool,
        real,
      ) => `{ echo "== ${tool}"; for a in "$@"; do echo "arg: $a"; done; env | sed 's/^/env: /'
  if [ -n "$PGSERVICEFILE" ] && [ -f "$PGSERVICEFILE" ]; then echo "service-file-mode: $(stat -c %a "$PGSERVICEFILE")"; echo "service-file: $PGSERVICEFILE"; echo "service-dir-mode: $(stat -c %a "$(dirname "$PGSERVICEFILE")")"; fi; } >> '${log}'
exec '${real}' "$@"`,
    );
    const file = join(dir, "cli.oculus-backup");
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    const envFor = (url: string): Record<string, string | undefined> => ({
      ...process.env,
      PG_BIN: bin,
      OCULUS_DATABASE_URL: url,
      OCULUS_SECRET_KEY: "fake-key-for-the-test",
      PGHOST: "/nonexistent",
      PGDATABASE: "nonexistent",
    });
    const options = { tempDir: temp };

    const source = as(testDb.url, "postgres", FAKE_PASSWORD);
    expect(await runBackupCli([file], envFor(source), out, out, options)).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const restoreUrl = as(target.url, RESTORER, FAKE_PASSWORD);
    expect(await runRestoreCli([file], envFor(restoreUrl), out, out, options)).toBe(0);
    expect(lines.join("\n")).toMatch(/Done: restored and checked \d+ tables/);

    // Refusals print cleanly too.
    expect(await runRestoreCli([file], envFor(restoreUrl), out, out, options)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Restore refused \(target_not_empty\)/);
    expect(await runBackupCli([file], envFor(source), out, out, options)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(exists\)/);
    expect(await runRestoreCli([join(dir, "missing")], envFor(restoreUrl), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Restore refused \(not_found\)/);
    const superuserTarget = await database();
    expect(
      await runRestoreCli(
        [file],
        envFor(as(superuserTarget.url, "postgres", FAKE_PASSWORD)),
        out,
        out,
      ),
    ).toBe(1);
    expect(lines.at(-1)).toMatch(/^Restore refused \(superuser\)/);
    expect(
      await runRestoreCli(
        ["--allow-superuser", file],
        envFor(as(superuserTarget.url, "postgres", FAKE_PASSWORD)),
        out,
        out,
      ),
    ).toBe(0);
    // A connection that fails names no password.
    const badHost = new URL(source);
    badHost.searchParams.set("host", join(dir, "no-server-here"));
    expect(await runBackupCli([join(dir, "b")], envFor(badHost.toString()), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(dump_failed\): Could not connect/);

    const printed = lines.join("\n");
    expect(printed).not.toContain(FAKE_PASSWORD);
    expect(printed).not.toContain("postgresql://");

    const calls = await readFile(log, "utf8");
    expect(calls).toContain("== pg_dump");
    expect(calls).toContain("== pg_restore");
    const args = calls.split("\n").filter((l) => l.startsWith("arg: "));
    const env = calls.split("\n").filter((l) => l.startsWith("env: "));
    expect(args.join("\n")).not.toContain(FAKE_PASSWORD);
    expect(args.join("\n")).not.toContain("postgresql://");
    expect(args).toContain("arg: --dbname=service=oculus_backup");
    expect(args).toContain("arg: --no-owner");
    expect(args).toContain("arg: --single-transaction");
    expect(args).toContain("arg: --exit-on-error");
    expect(env.join("\n")).not.toContain(FAKE_PASSWORD);
    expect(env.join("\n")).not.toContain("OCULUS_");
    expect(env.join("\n")).not.toMatch(/env: PG(HOST|DATABASE)=/);
    expect(calls).not.toContain("fake-key-for-the-test");
    // The service file was private and is gone.
    expect(calls).toContain("service-file-mode: 600");
    expect(calls).toContain("service-dir-mode: 700");
    expect(calls).not.toMatch(/service-file-mode: (?!600)/);
    for (const line of calls.split("\n").filter((l) => l.startsWith("service-file: "))) {
      expect(existsSync(line.slice("service-file: ".length))).toBe(false);
    }
    expect(await readdir(temp)).toEqual([]);
  }, 60_000);

  it("take a relative path from where npm was run", async () => {
    const dir = await directory();
    expect(filePath("nightly.oculus-backup", { INIT_CWD: dir })).toBe(
      join(dir, "nightly.oculus-backup"),
    );
    expect(filePath("/abs/x", { INIT_CWD: dir })).toBe("/abs/x");
    expect(filePath("x", {})).toBe(join(process.cwd(), "x"));
    const { testDb } = await populated();
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    const env = { ...process.env, OCULUS_DATABASE_URL: testDb.url, INIT_CWD: dir };
    expect(await runBackupCli(["relative.oculus-backup"], env, out, out)).toBe(0);
    expect(await readdir(dir)).toEqual(["relative.oculus-backup"]);
  }, 60_000);

  it("need a file argument and OCULUS_DATABASE_URL", async () => {
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    expect(await runBackupCli([], {}, out, out)).toBe(2);
    expect(await runBackupCli(["a", "b"], {}, out, out)).toBe(2);
    expect(await runRestoreCli(["--force"], {}, out, out)).toBe(2);
    expect(await runRestoreCli(["--allow-superuser"], {}, out, out)).toBe(2);
    expect(await runBackupCli(["x"], {}, out, out)).toBe(2);
    expect(lines.at(-1)).toContain("OCULUS_DATABASE_URL is not set");
    expect(await runRestoreCli(["x"], { OCULUS_DATABASE_URL: " " }, out, out)).toBe(2);
    const bad = "mysql://someone:" + FAKE_PASSWORD + "@host/db";
    expect(await runBackupCli(["x"], { OCULUS_DATABASE_URL: bad }, out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(bad_url\)/);
    expect(lines.join("\n")).not.toContain(FAKE_PASSWORD);
  });

  it("hide the URL and a password, but don't mangle output over a short one", () => {
    const seen: string[] = [];
    const url = "postgresql://u:ab1@h/db";
    const { out } = hideSecrets(
      url,
      (l) => seen.push(l),
      () => undefined,
    );
    out(`Done: 1 table, 11 rows; ${url}`);
    const long = hideSecrets(
      `postgresql://u:${FAKE_PASSWORD}@h/db`,
      (l) => seen.push(l),
      () => undefined,
    );
    long.out(`password ${FAKE_PASSWORD} here`);
    expect(seen).toEqual(["Done: 1 table, 11 rows; [hidden]", "password [hidden] here"]);
  });
});

// ---------------------------------------------------------------------------

describe("the connection pg_dump, pg_restore and the driver share", () => {
  const files: Record<string, string> = { "/ca.pem": "CA", "/c.pem": "CERT", "/k.pem": "KEY" };
  const resolveWith = (url: string): ReturnType<typeof resolveConnection> =>
    resolveConnection(url, (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("no such file");
      return text;
    });

  it("read the URL as libpq does, query keywords last, and give both the same", () => {
    const c = resolveWith(
      "postgresql://some%40one:p%40ss%2Fword@db.example.invalid:5433/oculus%5Fmain?dbname=other&application_name=a+b",
    );
    expect(c.libpq).toEqual([
      ["host", "db.example.invalid"],
      ["port", "5433"],
      ["dbname", "other"],
      ["user", "some@one"],
      ["sslmode", "verify-full"],
      ["sslrootcert", "system"],
    ]);
    expect(c.node).toEqual({
      host: "db.example.invalid",
      port: 5433,
      database: "other",
      user: "some@one",
      password: "p@ss/word",
      ssl: { rejectUnauthorized: true },
    });
    expect(c.needsSystemRoots).toBe(true);
    expect(c.password).toBe("p@ss/word");
    const socket = resolveWith("postgresql://u@localhost/db?host=%2Fvar%2Frun%2Fpostgresql");
    expect(socket.libpq).toEqual([
      ["host", "/var/run/postgresql"],
      ["port", "5432"],
      ["dbname", "db"],
      ["user", "u"],
      ["sslmode", "disable"],
    ]);
    expect(socket.node).toMatchObject({ host: "/var/run/postgresql", ssl: false });
    expect(serviceFileText([["host", "h"]], "oculus-backup")).toBe(
      "[oculus_backup]\nhost=h\napplication_name=oculus-backup\n",
    );
  });

  it("map sslmode so both check the server the same way", () => {
    const mode = (url: string): string => resolveWith(url).sslmode;
    for (const local of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const m of ["", "?sslmode=disable", "?sslmode=allow", "?sslmode=prefer"]) {
        expect(mode(`postgresql://u@${local}/db${m}`)).toBe("disable");
      }
      expect(mode(`postgresql://u@${local}/db?sslmode=require`)).toBe("verify-full");
    }
    for (const m of ["", "?sslmode=prefer", "?sslmode=require", "?sslmode=verify-full"]) {
      expect(mode(`postgresql://u@db.example.invalid/db${m}`)).toBe("verify-full");
    }
    const ca = resolveWith(
      "postgresql://u@db.example.invalid/db?sslmode=verify-ca&sslrootcert=/ca.pem",
    );
    expect(ca.sslmode).toBe("verify-ca");
    expect(ca.libpq).toContainEqual(["sslrootcert", "/ca.pem"]);
    expect(ca.node.ssl).toMatchObject({ rejectUnauthorized: true, ca: "CA" });
    expect(ca.node.ssl && typeof ca.node.ssl.checkServerIdentity).toBe("function");
    expect(ca.needsSystemRoots).toBe(false);
    const full = resolveWith(
      "postgresql://u@db.example.invalid/db?sslrootcert=/ca.pem&sslcert=/c.pem&sslkey=/k.pem",
    );
    expect(full.node.ssl).toEqual({ rejectUnauthorized: true, ca: "CA", cert: "CERT", key: "KEY" });
    expect(full.libpq).toContainEqual(["sslcert", "/c.pem"]);
    for (const refused of [
      "postgresql://u@db.example.invalid/db?sslmode=disable",
      "postgresql://u@db.example.invalid/db?sslmode=allow",
      "postgresql://u@db.example.invalid/db?sslmode=verify-ca",
      "postgresql://u@db.example.invalid/db?sslmode=bogus",
      "postgresql://u@db.example.invalid/db?sslcert=/c.pem",
      "postgresql://u@db.example.invalid/db?sslrootcert=/missing.pem",
    ]) {
      expect(() => resolveWith(refused)).toThrow(ConnectionError);
    }
  });

  it("refuse what both can't be given the same way, without showing any value", () => {
    const cases = [
      "not a url",
      "mysql://u@h/db",
      `postgresql://u:${FAKE_PASSWORD}@h/db?ssl=true`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?service=other`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?hostaddr=10.0.0.1`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?options=-c%20search_path%3Dx`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?target_session_attrs=any`,
      `postgresql://u:${FAKE_PASSWORD}@h1,h2/db`,
      `postgresql://u:${FAKE_PASSWORD}@/db`,
      `postgresql://u:${FAKE_PASSWORD}@h/`,
      `postgresql://u:${FAKE_PASSWORD}@h:0/db`,
      `postgresql://u:${FAKE_PASSWORD}%0A@h/db`,
      `postgresql://u:%20${FAKE_PASSWORD}@h/db`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?sslmode=%E0%A4%A`,
    ];
    for (const url of cases) {
      let error: unknown;
      try {
        resolveWith(url);
      } catch (e) {
        error = e;
      }
      expect(error, url).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).not.toContain(FAKE_PASSWORD);
      expect((error as Error).message).not.toContain(url);
    }
  });

  it("give the tools the caller's environment without OCULUS_ or connection variables", () => {
    expect(
      toolEnvironment(
        {
          PATH: "/usr/bin",
          PGPASSFILE: "/home/x/.pgpass",
          PGPASSWORD: "fake",
          PGHOST: "elsewhere",
          PGSSLMODE: "disable",
          PGSERVICE: "other",
          PGSERVICEFILE: "/etc/other",
          OCULUS_DATABASE_URL: "postgresql://u@h/db",
          OCULUS_SECRET_KEY: "fake",
          UNSET: undefined,
        },
        "/tmp/s/pg_service.conf",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      PGPASSFILE: "/home/x/.pgpass",
      PGPASSWORD: "fake",
      PGSERVICEFILE: "/tmp/s/pg_service.conf",
    });
  });
});

describe("pieces", () => {
  it("read tool versions", () => {
    expect(toolMajor("pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)")).toBe(16);
    expect(toolMajor("pg_restore (PostgreSQL) 19.0")).toBe(19);
    expect(toolMajor("something else")).toBeUndefined();
    expect(TRAILER_BYTES).toBe(56);
  });

  it("find the tools in PG_BIN or refuse clearly", async () => {
    const empty = await directory();
    const error = await refusal(findTools({ PG_BIN: empty }, ["pg_dump"]));
    expect(error.code).toBe("no_tools");
    expect(error.message).toContain(empty);
  });

  it("hash whole rows, whatever the columns are called", async () => {
    const testDb = await database();
    const db = pool(testDb.url);
    await db.execute(sql`CREATE TABLE public.a (t text, x int)`);
    await db.execute(sql`CREATE TABLE public.b (oculus_backup_row text, x int)`);
    await db.execute(sql`INSERT INTO public.a VALUES ('same', 1)`);
    await db.execute(sql`INSERT INTO public.b VALUES ('same', 1)`);
    const first = await tableSummaries(db);
    await db.execute(sql`UPDATE public.a SET x = 2`);
    await db.execute(sql`UPDATE public.b SET x = 2`);
    const second = await tableSummaries(db);
    for (const name of ["public.a", "public.b"]) {
      const before = first.find((t) => t.name === name);
      const after = second.find((t) => t.name === name);
      expect(after?.rowsHash, name).not.toBe(before?.rowsHash);
    }
  });
});

describe("comparing a backup's migrations with the code's", () => {
  const file = (name: string, sha256 = "a".repeat(64)): MigrationFile => ({
    name,
    sha256,
    text: "",
  });
  const files = [file("0001_a.sql"), file("0002_b.sql"), file("0003_c.sql")];
  const applied = (names: string[]): { name: string; sha256: string }[] =>
    names.map((name) => ({ name, sha256: "a".repeat(64) }));

  it("accepts the same list, and an older backup with newer files pending", () => {
    expect(compareMigrations(applied(["0001_a.sql", "0002_b.sql", "0003_c.sql"]), files)).toEqual(
      [],
    );
    expect(compareMigrations(applied(["0001_a.sql"]), files)).toEqual(["0002_b.sql", "0003_c.sql"]);
  });

  it("lists every difference", () => {
    const backedUp = [
      { name: "0001_a.sql", sha256: "b".repeat(64) },
      { name: "0003_c.sql", sha256: "a".repeat(64) },
      { name: "0004_d.sql", sha256: "a".repeat(64) },
    ];
    let error: unknown;
    try {
      compareMigrations(backedUp, files);
    } catch (e) {
      error = e;
    }
    expect((error as BackupError).code).toBe("migrations_differ");
    const message = (error as Error).message;
    expect(message).toContain("0001_a.sql in the backup differs from the code's file");
    expect(message).toContain("0004_d.sql is in the backup but not in the code");
    expect(message).toContain("0002_b.sql is in the code but not in the backup, before 0004_d.sql");
  });
});

// ---------------------------------------------------------------------------
// Second review (D-064): effective superuser powers, grants to the restoring
// role, --no-privileges, long passwords, a stop after COMMIT, streaming, and
// the command itself stopped twice or forced to exit.

/** Makes a fixed-name role (cluster-wide) with `then` run once it exists. */
async function role(name: string, then: string[] = [], options = "LOGIN"): Promise<void> {
  await admin(async (s) => {
    await s.runScript(`DO $$ BEGIN CREATE ROLE ${name} ${options};
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    for (const statement of then) await s.runScript(statement);
  });
}

/** A fresh empty database owned by `owner`, and its URL as that role. */
async function targetOwnedBy(owner: string): Promise<{ testDb: TestDatabase; url: string }> {
  const testDb = await database();
  await onDatabase(`ALTER DATABASE %I OWNER TO ${owner}`, testDb.name);
  return { testDb, url: as(testDb.url, owner) };
}

describe("who may restore", () => {
  it("refuses every role but a plain one: attributes or any membership at all", async () => {
    const { file } = await sharedBackup();
    await role("oculus_t052_admins", [], "NOLOGIN CREATEROLE");
    const [subscription] = await pool(testServerUrl()).rows(
      sql`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pg_create_subscription'`,
    );
    const cases: [string, string, string[], string][] = [
      [
        "oculus_t052_sneaky",
        "LOGIN",
        ["GRANT postgres TO oculus_t052_sneaky"],
        "is a member of postgres",
      ],
      [
        "oculus_t052_files",
        "LOGIN",
        ["GRANT pg_execute_server_program TO oculus_t052_files"],
        "is a member of pg_execute_server_program",
      ],
      [
        "oculus_t052_signal",
        "LOGIN",
        ["GRANT pg_signal_backend TO oculus_t052_signal"],
        "is a member of pg_signal_backend",
      ],
      [
        "oculus_t052_nested",
        "LOGIN",
        ["GRANT oculus_t052_admins TO oculus_t052_nested"],
        "is a member of oculus_t052_admins",
      ],
      ["oculus_t052_creator", "LOGIN CREATEROLE", [], "has CREATEROLE"],
      ["oculus_t052_createdb", "LOGIN CREATEDB", [], "has CREATEDB"],
      ["oculus_t052_replicator", "LOGIN REPLICATION", [], "has REPLICATION"],
      ["oculus_t052_bypass", "LOGIN BYPASSRLS", [], "has BYPASSRLS"],
    ];
    // PostgreSQL 16 and newer.
    if (subscription !== undefined) {
      cases.push([
        "oculus_t052_subscriber",
        "LOGIN",
        ["GRANT pg_create_subscription TO oculus_t052_subscriber"],
        "is a member of pg_create_subscription",
      ]);
    }
    for (const [name, attributes, grants, reason] of cases) {
      await role(name, grants, attributes);
      const target = await targetOwnedBy(name);
      const refused = await refusal(restore({ connectionString: target.url, file }));
      expect(refused.code, name).toBe("superuser");
      expect(refused.message).toContain(reason);
      expect(refused.message).toContain("CREATE ROLE oculus_restore LOGIN");
      expect(await contentsOf(pool(target.testDb.url))).toEqual({});
    }
    // A plain role that owns the database restores.
    const plain = await emptyTarget();
    await restore({ connectionString: plain.url, file });
  }, 90_000);

  it("verifies grants made to the restoring role, which becomes the owner", async () => {
    await roles();
    const source = await database();
    await migrate({ connectionString: source.url });
    await pool(source.url).execute(
      sql`GRANT SELECT ON public.oculus_migrations TO oculus_t052_restorer`,
    );
    const dir = await directory();
    const file = join(dir, "granted.oculus-backup");
    const made = await backup({ connectionString: source.url, file });
    expect(made.manifest.objects.grants).toContain(
      "relation public.oculus_migrations to oculus_t052_restorer: SELECT",
    );
    const target = await emptyTarget();
    await restore({ connectionString: target.url, file });
  }, 60_000);

  it("restores without the backup's privileges when its roles are gone (--no-privileges)", async () => {
    await roles();
    await role("oculus_t052_gone", [], "NOLOGIN");
    const source = await database();
    await migrate({ connectionString: source.url });
    const db = pool(source.url);
    await db.execute(sql`GRANT SELECT ON public.oculus_migrations TO oculus_t052_gone`);
    const dir = await directory();
    const file = join(dir, "gone.oculus-backup");
    await backup({ connectionString: source.url, file });
    await db.execute(sql`REVOKE SELECT ON public.oculus_migrations FROM oculus_t052_gone`);
    await admin((s) => s.runScript("DROP ROLE oculus_t052_gone"));

    const plain = await emptyTarget();
    const refused = await refusal(restore({ connectionString: plain.url, file }));
    expect(refused.code).toBe("restore_failed");
    expect(refused.message).toContain("oculus_t052_gone");
    expect(await contentsOf(pool(plain.url))).toEqual({});

    const target = await emptyTarget();
    await restore({ connectionString: target.url, file, noPrivileges: true });
    const lines: string[] = [];
    const other = await emptyTarget();
    const code = await runRestoreCli(
      ["--no-privileges", file],
      { ...process.env, OCULUS_DATABASE_URL: other.url },
      (l) => lines.push(l),
      (l) => lines.push(l),
    );
    expect(code, lines.join("\n")).toBe(0);
  }, 60_000);
});

describe("passwords and TLS for the tools", () => {
  it("authenticate with a 2,000-character password from a private password file (scram-sha-256)", async () => {
    // A throwaway server of this test's own, with password authentication.
    const helper = (await import(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "scripts",
        "test-database.mjs",
      )
    )) as {
      findPostgresBin: () => string | undefined;
      startTestDatabase: (o: { bin: string; log: () => void; password: string }) => {
        url: string;
        stop: () => void;
      };
    };
    const serverBin = helper.findPostgresBin();
    if (serverBin === undefined) throw new Error("No initdb and pg_ctl for a password server.");
    const long = "p".repeat(1000) + ":\\" + "q".repeat(998);
    const restorerPassword = "r".repeat(1500) + ":" + "s".repeat(499);
    const server = helper.startTestDatabase({
      bin: serverBin,
      log: () => undefined,
      password: long,
    });
    try {
      const admin = as(server.url, "postgres", long);
      const wrong = as(server.url, "postgres", "not-the-password");
      await expect(openSession(wrong, "t052-wrong")).rejects.toThrow(
        /password authentication failed/,
      );
      const setup = await openSession(admin, "t052-setup");
      try {
        await setup.runScript(`CREATE ROLE t052_restorer LOGIN PASSWORD '${restorerPassword}'`);
        await setup.runScript("CREATE DATABASE t052_src TEMPLATE template0");
        await setup.runScript("CREATE DATABASE t052_dst OWNER t052_restorer TEMPLATE template0");
      } finally {
        await setup.close();
      }
      const sourceUrl = new URL(admin);
      sourceUrl.pathname = "/t052_src";
      await migrate({ connectionString: sourceUrl.toString() });
      const targetUrl = new URL(as(server.url, "t052_restorer", restorerPassword));
      targetUrl.pathname = "/t052_dst";

      const dir = await directory();
      const temp = await directory();
      const log = join(dir, "calls.log");
      const bin = await wrappedTools(
        (
          tool,
          real,
        ) => `{ echo "== ${tool}"; echo "pgpassfile: $PGPASSFILE"; echo "pgpassword: \${PGPASSWORD:-none}"
  echo "pgpass-mode: $(stat -c %a "$PGPASSFILE")"; grep -c '^password=' "$PGSERVICEFILE" | sed 's/^/service-password-lines: /'; } >> '${log}'
exec '${real}' "$@"`,
      );
      const env = (url: string): Record<string, string | undefined> => ({
        ...process.env,
        PG_BIN: bin,
        PGPASSWORD: "fake-other-password",
        OCULUS_DATABASE_URL: url,
      });
      const lines: string[] = [];
      const out = (l: string): void => {
        lines.push(l);
      };
      const file = join(dir, "long.oculus-backup");
      expect(
        await runBackupCli([file], env(sourceUrl.toString()), out, out, { tempDir: temp }),
        lines.join("\n"),
      ).toBe(0);
      expect(
        await runRestoreCli([file], env(targetUrl.toString()), out, out, { tempDir: temp }),
        lines.join("\n"),
      ).toBe(0);
      const calls = await readFile(log, "utf8");
      expect(calls).toContain("== pg_dump");
      expect(calls).toContain("== pg_restore");
      expect(calls).toContain("pgpass-mode: 600");
      expect(calls).toContain("service-password-lines: 0");
      expect(calls).toContain("pgpassword: none");
      for (const line of calls.split("\n").filter((l) => l.startsWith("pgpassfile: "))) {
        expect(existsSync(line.slice("pgpassfile: ".length))).toBe(false);
      }
      expect(lines.join("\n")).not.toContain(long.slice(0, 50));
      expect(await readdir(temp)).toEqual([]);
    } finally {
      server.stop();
    }
  }, 90_000);

  it("escape the password file and refuse service-file lines libpq can't read", () => {
    expect(passwordFileText("a:b\\c")).toBe("*:*:*:*:a\\:b\\\\c\n");
    const longPath = `/${"d".repeat(MAX_SERVICE_LINE)}/ca.pem`;
    expect(() =>
      resolveConnection(
        `postgresql://u@db.example.invalid/db?sslrootcert=${encodeURIComponent(longPath)}`,
        () => "CA",
      ),
    ).toThrow(/too long for a libpq service file/);
    expect(() =>
      resolveConnection(
        "postgresql://u@db.example.invalid/db?sslmode=verify-ca&sslrootcert=system",
        () => "CA",
      ),
    ).toThrow(/verify-ca needs sslrootcert naming a CA certificate file/);
  });
});

describe("a stop that comes late, and the archive", () => {
  it("after pg_restore committed: checks the result and reports it done", async () => {
    const { file } = await sharedBackup();
    const dir = await directory();
    const pidFile = join(dir, "restore.pid");
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@"\nstatus=$?\necho $$ > '${pidFile}'\nsleep 30\nexit $status`,
    );
    const target = await emptyTarget();
    const controller = new AbortController();
    const lines: string[] = [];
    const running = runRestoreCli(
      [file],
      { ...process.env, PG_BIN: bin, OCULUS_DATABASE_URL: target.url },
      (l) => lines.push(l),
      (l) => lines.push(l),
      { signal: controller.signal },
    );
    await until(() => existsSync(pidFile));
    controller.abort();
    expect(await running, lines.join("\n")).toBe(0);
    expect(lines.join("\n")).toContain("after pg_restore had committed");
    expect(lines.join("\n")).toMatch(/Done: restored and checked/);
  }, 60_000);

  it("holds back the archive's end if it changed after it was checked", async () => {
    const { file } = await bigBackup();
    const manifest = await readManifest(file);
    expect(manifest.dump.bytes).toBeGreaterThan(2 * 1024 * 1024);
    const input = new PassThrough();
    let written = 0;
    input.on("data", (chunk: Buffer) => {
      written += chunk.length;
    });
    const tampered = { ...manifest, dump: { ...manifest.dump, sha256: "0".repeat(64) } };
    const refused = await refusal(streamArchive(file, tampered, input, undefined));
    expect(refused.code).toBe("bad_file");
    // Everything before the last chunk may have gone; the last never does.
    expect(written).toBe(Math.floor((manifest.dump.bytes - 1) / (1024 * 1024)) * 1024 * 1024);
  });
});

/** The command, compiled (types stripped) into a temporary directory, to run as a real process. */
let cli: Promise<string> | undefined;
function compiledCli(): Promise<string> {
  cli ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = await directory();
    await mkdir(join(root, "src"));
    for (const name of [
      "backup-cli",
      "backup",
      "backup-catalog",
      "backup-connection",
      "backup-cleanup",
      "client",
      "sql",
      "migrate",
      "migrate-cli",
    ]) {
      const text = await readFile(join(here, `${name}.ts`), "utf8");
      const js = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      await writeFile(join(root, "src", `${name}.js`), js);
    }
    await writeFile(join(root, "package.json"), '{ "type": "module" }\n');
    await symlink(join(here, "..", "..", "..", "node_modules"), join(root, "node_modules"));
    await symlink(join(here, "..", "migrations"), join(root, "migrations"));
    return join(root, "src", "backup-cli.js");
  })();
  return cli;
}

/** Starts a parent process that prints its watchdog's PID; returns that PID (the group). */
let parents: ReturnType<typeof spawn>[] = [];
async function startParent(script: string): Promise<number> {
  const parent = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  parents.push(parent);
  let errors = "";
  parent.stderr.on("data", (d: Buffer) => {
    errors += d.toString();
  });
  return new Promise<number>((resolvePid, reject) => {
    parent.stdout.once("data", (chunk: Buffer) => {
      resolvePid(Number(chunk.toString().trim()));
    });
    parent.on("close", (code) => {
      reject(
        new Error(`The parent exited (${String(code)}) before starting the watchdog: ${errors}`),
      );
    });
  });
}

/** SIGKILLs the most recent parent process. */
function killParent(): void {
  parents.at(-1)?.kill("SIGKILL");
  parents = [];
}

/** Runs the compiled command; resolves with its exit code and output. */
function command(
  args: string[],
  env: Record<string, string | undefined>,
): {
  child: ChildProcessWithoutNullStreams | ChildProcessByStdio<null, Readable, Readable>;
  output: () => string;
  exited: Promise<number | null>;
} {
  let output = "";
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (d: Buffer): void => {
    output += d.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise<number | null>((r) => {
    child.on("close", (code) => {
      r(code);
    });
  });
  return { child, output: () => output, exited };
}

describe("the command stopped twice, or forced to exit", () => {
  it("leaves no tool, partial file or private file after a second Ctrl-C mid-backup", async () => {
    const script = await compiledCli();
    const { testDb } = await populated();
    const dir = await directory();
    const temp = await directory();
    const pidFile = join(await directory(), "dump.pid");
    // A pg_dump that ignores SIGTERM and SIGINT after writing its archive.
    const bin = await wrappedTools(
      (_tool, real) =>
        `trap '' TERM INT\n'${real}' "$@" || exit $?\necho $$ > '${pidFile}'\nsleep 60`,
    );
    const run = command([script, "backup", join(dir, "x.oculus-backup")], {
      ...process.env,
      OCULUS_DATABASE_URL: testDb.url,
      PG_BIN: bin,
      TMPDIR: temp,
    });
    await until(() => existsSync(pidFile));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    run.child.kill("SIGINT");
    await until(() => run.output().includes("Stopping (SIGINT)"));
    expect(alive(pid)).toBe(true);
    // A second Ctrl-C (more than SAME_STOP_MS after the first).
    await new Promise((r) => setTimeout(r, SAME_STOP_MS + 200));
    run.child.kill("SIGINT");
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("Stopping at once");
    await until(() => !alive(pid));
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(temp)).toEqual([]);
  }, 60_000);

  it("leaves no tool, partial file or private file when the grace period forces an exit", async () => {
    const script = await compiledCli();
    const { testDb } = await populated();
    const dir = await directory();
    const temp = await directory();
    const pidFile = join(await directory(), "dump.pid");
    const bin = await wrappedTools(
      (_tool, real) =>
        `trap '' TERM INT\n'${real}' "$@" || exit $?\necho $$ > '${pidFile}'\nsleep 60`,
    );
    const run = command([script, "backup", join(dir, "x.oculus-backup")], {
      ...process.env,
      OCULUS_DATABASE_URL: testDb.url,
      PG_BIN: bin,
      TMPDIR: temp,
      OCULUS_STOP_GRACE_MS: "300",
    });
    await until(() => existsSync(pidFile));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("Stopping took too long");
    await until(() => !alive(pid));
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(temp)).toEqual([]);
  }, 60_000);

  it("the watchdog kills a tool that ignores SIGTERM when its parent dies", async () => {
    const dir = await directory();
    const script = join(dir, "parent.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
const child = spawn("/bin/sh", ["-c", ${JSON.stringify(WATCHDOG)}, "oculus-tool", "/bin/sh", "-c", "trap '' TERM; sleep 60"], {
  detached: true, stdio: ["pipe", "ignore", "ignore", "pipe"],
});
console.log(child.pid);
setInterval(() => {}, 1000);
`,
    );
    const pgid = await startParent(script);
    await new Promise((r) => setTimeout(r, 200));
    killParent();
    await until(() => !groupAlive(pgid), 15_000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Third review (D-064): a stop during the check after COMMIT, the npm script
// passing signals to node, settings after a restore, --no-privileges and
// revocations.

/** A backup of a database large enough that its archive spans several chunks and its check takes a while. */
let big: Promise<{ file: string }> | undefined;
function bigBackup(): Promise<{ file: string }> {
  big ??= (async () => {
    const source = await database();
    await migrate({ connectionString: source.url });
    const db = pool(source.url);
    await db.execute(sql`CREATE TABLE public.t052_big (id int, v text)`);
    await db.execute(sql`INSERT INTO public.t052_big
      SELECT g, pg_catalog.md5(g::text) || pg_catalog.md5((g * 7)::text)
      FROM pg_catalog.generate_series(1, 600000) AS g`);
    const dir = await directory();
    const file = join(dir, "big.oculus-backup");
    await backup({ connectionString: source.url, file });
    return { file };
  })();
  return big;
}

/**
 * A PG_BIN whose pg_restore, once the real one has committed, leaves a
 * session holding an exclusive lock on public.oculus_migrations for 4 s, so
 * the check that follows waits: a stop can be sent during the check for sure.
 */
async function slowCheckTools(): Promise<string> {
  const psql = join(await findTools(process.env, ["psql"]), "psql");
  return wrappedTools(
    (_tool, real) => `'${real}' "$@" || exit $?
'${psql}' "service=oculus_backup" -qAt -c "BEGIN" -c "LOCK TABLE public.oculus_migrations IN ACCESS EXCLUSIVE MODE" -c "SELECT pg_catalog.pg_sleep(4)" -c "COMMIT" >/dev/null 2>&1 &
until [ "$('${psql}' "service=oculus_backup" -qAtc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks WHERE relation = 'public.oculus_migrations'::pg_catalog.regclass AND mode = 'AccessExclusiveLock' AND granted")" = 1 ]; do sleep 0.05; done`,
  );
}

describe("a stop while the restored database is being checked", () => {
  const start = async (): Promise<ReturnType<typeof command>> => {
    const script = await compiledCli();
    const { file } = await sharedBackup();
    const target = await emptyTarget();
    const run = command([script, "restore", file], {
      ...process.env,
      OCULUS_DATABASE_URL: target.url,
      OCULUS_STOP_GRACE_MS: "50",
      PG_BIN: await slowCheckTools(),
    });
    await until(() => run.output().includes("Checking the restored database"), 30_000);
    return run;
  };
  const twice = async (run: ReturnType<typeof command>, gapMs: number): Promise<void> => {
    run.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, gapMs));
    run.child.kill("SIGINT");
  };

  it("lets the check finish, ignoring the grace period, and exits 0 when it passes", async () => {
    const run = await start();
    run.child.kill("SIGTERM");
    expect(await run.exited, run.output()).toBe(0);
    expect(run.output()).toContain("finishing the check of the restored database");
    expect(run.output()).toContain("Done: restored and checked");
  }, 90_000);

  it("takes two signals 2 ms apart (one Ctrl-C under npm) as one stop", async () => {
    const run = await start();
    await twice(run, 2);
    expect(await run.exited, run.output()).toBe(0);
    expect(run.output().split("finishing the check").length - 1).toBe(1);
    expect(run.output()).not.toContain("NOT checked");
    expect(run.output()).toContain("Done: restored and checked");
  }, 90_000);

  it("exits 3, saying the database is restored but NOT checked, on a signal 1.5 s after the first", async () => {
    const run = await start();
    await twice(run, 1500);
    expect(await run.exited, run.output()).toBe(3);
    expect(run.output()).toContain("restored but NOT checked");
  }, 90_000);
});

describe("the npm scripts", () => {
  it("from the repository root, exec node, so SIGTERM to npm reaches it and leaves nothing", async () => {
    const { testDb } = await populated();
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..", "..", "..");
    const dir = await directory();
    const pidFile = join(await directory(), "dump.pid");
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@" || exit $?\necho $$ > '${pidFile}'\nsleep 60`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
    );
    const npm = spawn("npm", ["run", "--silent", "db:backup", "--", join(dir, "x.oculus-backup")], {
      cwd: root,
      env: { ...env, OCULUS_DATABASE_URL: testDb.url, PG_BIN: bin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (d: Buffer): void => {
      output += d.toString();
    };
    npm.stdout.on("data", collect);
    npm.stderr.on("data", collect);
    const exited = new Promise<number | null>((r) => {
      npm.on("close", (code) => {
        r(code);
      });
    });
    await until(() => existsSync(pidFile), 110_000);
    const tool = Number((await readFile(pidFile, "utf8")).trim());
    // npm's only child is node itself: one npm, its shell exec'd away.
    const children = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(npm.pid)], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => l.trim());
    expect(children, output).toHaveLength(1);
    const [pid, ...args] = (children[0] ?? "").split(/\s+/);
    expect(args.join(" ")).toMatch(/^node packages\/db\/dist\/backup-cli\.js backup /);
    npm.kill("SIGTERM");
    expect(await exited, output).not.toBe(0);
    await until(() => !alive(tool) && !alive(Number(pid)));
    expect(output).toContain("Backup stopped (interrupted)");
    expect(await readdir(dir)).toEqual([]);
  }, 180_000);

  it("exec node, so a signal to what npm started reaches the command and leaves nothing", async () => {
    const { testDb } = await populated();
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = await directory();
    const pidFile = join(await directory(), "dump.pid");
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@" || exit $?\necho $$ > '${pidFile}'\nsleep 60`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
    );
    const npm = spawn("npm", ["run", "--silent", "db:backup", "--", join(dir, "x.oculus-backup")], {
      cwd: join(here, ".."),
      env: { ...env, OCULUS_DATABASE_URL: testDb.url, PG_BIN: bin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    npm.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    npm.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    const exited = new Promise<number | null>((r) => {
      npm.on("close", (code) => {
        r(code);
      });
    });
    await until(() => existsSync(pidFile), 110_000);
    const tool = Number((await readFile(pidFile, "utf8")).trim());
    // What npm started is node itself (exec), not a shell around it.
    const children = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(npm.pid)], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((l) => l.trim());
    expect(children, output).toHaveLength(1);
    const [pid, ...args] = (children[0] ?? "").split(/\s+/);
    expect(args.join(" ")).toMatch(/^node dist\/backup-cli\.js backup /);
    process.kill(Number(pid), "SIGTERM");
    expect(await exited, output).not.toBe(0);
    expect(output).toContain("Backup stopped (interrupted)");
    await until(() => !alive(tool) && !alive(Number(pid)));
    expect(await readdir(dir)).toEqual([]);
  }, 180_000);
});

describe("privileges and settings after a restore", () => {
  it("flags database settings that appear in the target", async () => {
    const { file } = await sharedBackup();
    const psql = join(await findTools(process.env, ["psql"]), "psql");
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@" || exit $?
db=$('${psql}' "service=oculus_backup" -qAtc "SELECT pg_catalog.current_database()")
'${psql}' "service=oculus_backup" -qc "ALTER DATABASE \\"$db\\" SET work_mem = '2MB'" >/dev/null`,
    );
    const target = await emptyTarget();
    const refused = await refusal(
      restore({ connectionString: target.url, file, env: { ...process.env, PG_BIN: bin } }),
    );
    expect(refused.code).toBe("verify_failed");
    expect(refused.message).toContain("database or role-in-database settings");
  }, 60_000);

  it("keeps and checks revocations, and refuses --no-privileges when there are any", async () => {
    const source = await database();
    await migrate({ connectionString: source.url });
    const db = pool(source.url);
    await db.execute(sql`CREATE FUNCTION public.t052_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    await db.execute(sql`REVOKE EXECUTE ON FUNCTION public.t052_f() FROM PUBLIC`);
    const dir = await directory();
    const file = join(dir, "revoked.oculus-backup");
    const made = await backup({ connectionString: source.url, file });
    expect(made.manifest.objects.revokes).toEqual([
      "function public.t052_f(): EXECUTE not granted to PUBLIC",
    ]);
    const target = await emptyTarget();
    const refused = await refusal(
      restore({ connectionString: target.url, file, noPrivileges: true }),
    );
    expect(refused.code).toBe("privileges_needed");
    expect(refused.message).toContain("public.t052_f()");
    expect(await contentsOf(pool(target.url))).toEqual({});
    await restore({ connectionString: target.url, file });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Fourth review (D-064): privileges granted to the role itself, the role's
// own settings, and the manifest's format version.

describe("the restoring role's own privileges and settings", () => {
  it("refuses a role with privileges on server parameters or system functions", async () => {
    const { file } = await sharedBackup();
    await role("oculus_t052_param", [
      "GRANT ALTER SYSTEM ON PARAMETER archive_command TO oculus_t052_param",
    ]);
    cleanups.push(() =>
      admin((s) =>
        s.runScript("REVOKE ALTER SYSTEM ON PARAMETER archive_command FROM oculus_t052_param"),
      ),
    );
    const param = await targetOwnedBy("oculus_t052_param");
    const refused = await refusal(restore({ connectionString: param.url, file }));
    expect(refused.code).toBe("superuser");
    expect(refused.message).toContain("has privileges granted on server parameters");
    expect(refused.message).toContain("GRANT oculus_restore TO <your admin role>");

    await role("oculus_t052_reader2");
    const reader = await targetOwnedBy("oculus_t052_reader2");
    const setup = await openSession(reader.testDb.url, "t052-setup");
    try {
      await setup.runScript(
        "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO oculus_t052_reader2",
      );
    } finally {
      await setup.close();
    }
    const functions = await refusal(restore({ connectionString: reader.url, file }));
    expect(functions.code).toBe("superuser");
    expect(functions.message).toContain("has privileges granted on system functions");
  }, 60_000);

  it("reports a restore that changed the restoring role's own settings", async () => {
    const { file } = await sharedBackup();
    const psql = join(await findTools(process.env, ["psql"]), "psql");
    const bin = await wrappedTools(
      (_tool, real) => `'${real}' "$@" || exit $?
'${psql}' "service=oculus_backup" -qc "ALTER ROLE CURRENT_USER SET work_mem = '3MB'" >/dev/null`,
    );
    const target = await emptyTarget();
    cleanups.push(() => admin((s) => s.runScript(`ALTER ROLE ${RESTORER} RESET ALL`)));
    try {
      const refused = await refusal(
        restore({ connectionString: target.url, file, env: { ...process.env, PG_BIN: bin } }),
      );
      expect(refused.code).toBe("verify_failed");
      expect(refused.message).toContain("the restoring role's own settings changed");
    } finally {
      await admin((s) => s.runScript(`ALTER ROLE ${RESTORER} RESET ALL`));
    }
  }, 60_000);

  it("refuses a manifest of an earlier format, saying so", async () => {
    const { file, dir } = await sharedBackup();
    const old = await copyOf(file, dir, "format-1");
    await rewriteManifest(old, (m) => {
      (m as unknown as { formatVersion: number }).formatVersion = 1;
    });
    const target = await emptyTarget();
    const refused = await refusal(restore({ connectionString: target.url, file: old }));
    expect(refused.code).toBe("bad_file");
    expect(refused.message).toContain("format version is 1, from an earlier version of Oculus");
  }, 60_000);
});
