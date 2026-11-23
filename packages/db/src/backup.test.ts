// Backup and restore (D-064): a migrated database with organizations,
// records, identifiers and terms is backed up and restored into a fresh empty
// database, and every row of every table is found and identical. Refusals
// (a target that is not empty, a damaged or edited file, a missing file,
// migrations that don't match, a migration running) leave the target empty
// and say why; the backup file is 0600; and the URL and its password are
// never printed, on a command line, or in the tools' environment.
import { chmod, mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  connectionParameters,
  contentsOf,
  findTools,
  manifestAndTrailer,
  readManifest,
  restore,
  serviceFileText,
  tableSummaries,
  toolEnvironment,
  toolMajor,
  TRAILER_BYTES,
  type BackupManifest,
} from "./backup.js";
import { runBackupCli, runRestoreCli } from "./backup-cli.js";
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
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";
import { readTerms, refreshRecordTerms, saveTerm } from "./vocabularies.js";

const T = "2026-11-20T16:05:00.000Z";
/** An obviously fake password: the test server uses trust authentication and ignores it. */
const FAKE_PASSWORD = "not-a-real-password-T052";

// ---------------------------------------------------------------------------
// Databases and files made by this file, removed afterwards.

const databases: TestDatabase[] = [];
const directories: string[] = [];
const pools: Database[] = [];

afterAll(async () => {
  for (const pool of pools) await pool.close().catch(() => undefined);
  for (const db of databases) await db.drop().catch(() => undefined);
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
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
  const dir = await mkdtemp(join(tmpdir(), "oculus-backup-test-"));
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
          'SELECT t::pg_catalog.text AS r FROM %I.%I AS t', ${schema ?? ""}::text, ${name ?? ""}::text),
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

// One backup of one populated database, shared by the refusal tests.
let shared: Promise<{ file: string; dir: string; sample: Sample; source: string }> | undefined;
function sharedBackup(): Promise<{ file: string; dir: string; sample: Sample; source: string }> {
  shared ??= (async () => {
    const { testDb, sample } = await populated();
    const dir = await directory();
    const file = join(dir, "shared.oculus-backup");
    await backup({ connectionString: testDb.url, file });
    return { file, dir, sample, source: testDb.url };
  })();
  return shared;
}

// ---------------------------------------------------------------------------

describe("backup and restore", () => {
  it("restores every row of every table identically into a fresh empty database", async () => {
    const { testDb, sample } = await populated();
    const dir = await directory();
    const file = join(dir, "nightly.oculus-backup");
    const logged: string[] = [];
    const made = await backup({
      connectionString: testDb.url,
      file,
      log: (line) => logged.push(line),
    });
    expect(made.file).toBe(file);
    expect(logged.join("\n")).toContain("Backing up PostgreSQL");

    // The file: 0600, nothing else left in the directory.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["nightly.oculus-backup"]);

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
    });
    expect(Number(counts["public.record_terms"])).toBeGreaterThan(0);
    expect(manifest.serverVersionNum).toBeGreaterThanOrEqual(150000);
    expect(toolMajor(manifest.pgDumpVersion)).toBeGreaterThanOrEqual(15);
    expect(Date.parse(manifest.createdAt)).not.toBeNaN();

    // Restore into a fresh, empty database.
    const targetDb = await database();
    const result = await restore({ connectionString: targetDb.url, file });
    expect(result.pending).toEqual([]);
    const target = pool(targetDb.url);

    // Every table, every row, identical.
    const before = await everyRow(source);
    const after = await everyRow(target);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after).toEqual(before);
    expect(after["public.records"]).toHaveLength(6);

    // And through the data-access functions.
    for (const { org, id } of sample.records) {
      expect(ok(await readRecord(target, org, id))).toEqual(ok(await readRecord(source, org, id)));
      expect(ok(await readRecordIdentifiers(target, org, id))).toEqual(
        ok(await readRecordIdentifiers(source, org, id)),
      );
    }
    for (const org of sample.orgs) {
      expect(ok(await readTerms(target, org))).toEqual(ok(await readTerms(source, org)));
      expect(ok(await readIdentifierTypes(target, org))).toEqual(
        ok(await readIdentifierTypes(source, org)),
      );
      // The auto-number counter carries on where it was.
      const next = (db: Database): Promise<Validated<string>> =>
        db.transaction((q) => allocateIdentifier(q, org, "object_number"));
      expect(ok(await next(target))).toBe(ok(await next(source)));
    }

    // The restored database can be migrated (nothing to do) and backed up again.
    expect((await migrate({ connectionString: targetDb.url })).applied).toEqual([]);
  }, 60_000);

  it("never overwrites: an existing backup file, or a database that is not empty", async () => {
    const { file, dir, source } = await sharedBackup();
    const before = await readFile(file);
    const exists = await refusal(backup({ connectionString: source, file }));
    expect(exists.code).toBe("exists");
    expect(await readFile(file)).toEqual(before);

    // The source itself is not empty.
    const full = await refusal(restore({ connectionString: source, file }));
    expect(full.code).toBe("target_not_empty");
    expect(full.message).toMatch(/relations/);

    // Nor is a database holding just one table, or one schema.
    const oneTable = await database();
    const db = pool(oneTable.url);
    await db.execute(sql`CREATE TABLE public.something_else (id int)`);
    expect((await refusal(restore({ connectionString: oneTable.url, file }))).code).toBe(
      "target_not_empty",
    );
    expect(await everyRow(db)).toEqual({ "public.something_else": [] });
    const oneSchema = await database();
    await pool(oneSchema.url).execute(sql`CREATE SCHEMA elsewhere`);
    const schema = await refusal(restore({ connectionString: oneSchema.url, file }));
    expect(schema.code).toBe("target_not_empty");
    expect(schema.message).toContain("1 schemas");
    expect(await readdir(dir)).toEqual(["shared.oculus-backup"]);
  }, 60_000);

  it("refuses a damaged, edited, truncated or missing file and leaves the target empty", async () => {
    const { file, dir } = await sharedBackup();
    const target = await database();
    const db = pool(target.url);
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
    const text = editedBytes.toString("latin1");
    const where = text.indexOf('"rows": "6"');
    expect(where).toBeGreaterThan(0);
    editedBytes.write('"rows": "7"', where, "latin1");
    await writeFile(edited, editedBytes);
    expect((await attempt(edited)).code).toBe("bad_file");

    // Cut short, the trailer gone, or not a backup at all.
    const truncated = await copyOf(file, dir, "truncated");
    await writeFile(truncated, (await readFile(file)).subarray(0, manifest.dump.bytes + 10));
    expect((await attempt(truncated)).code).toBe("bad_file");
    const notBackup = join(dir, "not-a-backup");
    await writeFile(notBackup, "hello\n");
    expect((await attempt(notBackup)).code).toBe("bad_file");

    // A manifest rewritten consistently but describing other contents: the
    // archive's SHA-256 no longer matches it.
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

    // A missing file.
    const missing = await attempt(join(dir, "nothing-here"));
    expect(missing.code).toBe("not_found");

    // Nothing of any of these reached the target.
    expect(await contentsOf(db)).toEqual({});
  }, 60_000);

  it("refuses a backup whose migrations don't match the code's, before restoring anything", async () => {
    const { file, dir } = await sharedBackup();
    const target = await database();
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

  it("checks the restored database against the manifest and says when it differs", async () => {
    const { file, dir } = await sharedBackup();
    const target = await database();
    // A manifest edited consistently (hash recomputed) to claim another row:
    // the archive restores, and the check afterwards finds the difference.
    const edited = await copyOf(file, dir, "edited-count");
    await rewriteManifest(edited, (m) => {
      const records = m.tables.find((t) => t.name === "public.records");
      if (records) records.rows = "7";
    });
    const refused = await refusal(restore({ connectionString: target.url, file: edited }));
    expect(refused.code).toBe("verify_failed");
    expect(refused.message).toContain("public.records has 6 rows, not 7");
    expect(refused.message).toContain("Do not use it");

    const hashed = await copyOf(file, dir, "edited-hash");
    await rewriteManifest(hashed, (m) => {
      const terms = m.tables.find((t) => t.name === "public.terms");
      if (terms) terms.rowsHash = "12345";
    });
    const other = await database();
    const differs = await refusal(restore({ connectionString: other.url, file: hashed }));
    expect(differs.code).toBe("verify_failed");
    expect(differs.message).toContain("public.terms's rows differ");
  }, 60_000);

  it("refuses while a migration holds the runner's lock on the target", async () => {
    const { file } = await sharedBackup();
    const target = await database();
    const holder = await openSession(target.url, "test-lock");
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

  it("refuses to back up a database Oculus never migrated, leaving no file behind", async () => {
    const empty = await database();
    const dir = await directory();
    const refused = await refusal(
      backup({ connectionString: empty.url, file: join(dir, "x.oculus-backup") }),
    );
    expect(refused.code).toBe("not_oculus");
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------

/**
 * A PG_BIN of wrappers that record each call's arguments, environment and
 * the service file's permissions, then run the real tool.
 */
async function recordingTools(): Promise<{ bin: string; log: string }> {
  const real = await findTools(process.env, ["pg_dump", "pg_restore"]);
  const bin = await directory();
  const log = join(bin, "calls.log");
  for (const tool of ["pg_dump", "pg_restore"]) {
    const script = [
      "#!/bin/sh",
      `{ echo "== ${tool}"; for a in "$@"; do echo "arg: $a"; done; env | sed 's/^/env: /';`,
      `  if [ -n "$PGSERVICEFILE" ] && [ -f "$PGSERVICEFILE" ]; then echo "service-file-mode: $(stat -c %a "$PGSERVICEFILE")"; echo "service-file: $PGSERVICEFILE"; echo "service-dir-mode: $(stat -c %a "$(dirname "$PGSERVICEFILE")")"; fi; } >> '${log}'`,
      `exec '${join(real, tool)}' "$@"`,
      "",
    ].join("\n");
    await writeFile(join(bin, tool), script);
    await chmod(join(bin, tool), 0o755);
  }
  return { bin, log };
}

describe("the db:backup and db:restore commands", () => {
  it("print nothing secret and never pass the URL on a command line or in the tools' environment", async () => {
    const { testDb } = await populated();
    const targetDb = await database();
    const withPassword = (url: string): string => {
      const u = new URL(url);
      u.password = FAKE_PASSWORD;
      return u.toString();
    };
    const { bin, log } = await recordingTools();
    const dir = await directory();
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
    });

    const source = withPassword(testDb.url);
    expect(await runBackupCli([file], envFor(source), out, out)).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const target = withPassword(targetDb.url);
    expect(await runRestoreCli([file], envFor(target), out, out)).toBe(0);
    expect(lines.join("\n")).toMatch(/Done: restored and checked \d+ tables/);

    // Refusals print cleanly too.
    expect(await runRestoreCli([file], envFor(target), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Restore refused \(target_not_empty\)/);
    expect(await runBackupCli([file], envFor(source), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(exists\)/);
    expect(await runRestoreCli([join(dir, "missing")], envFor(target), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Restore refused \(not_found\)/);
    // A connection that fails names no password.
    const badHost = new URL(source);
    badHost.searchParams.set("host", join(dir, "no-server-here"));
    expect(await runBackupCli([join(dir, "b")], envFor(badHost.toString()), out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(dump_failed\): Could not connect/);

    const printed = lines.join("\n");
    expect(printed).not.toContain(FAKE_PASSWORD);
    expect(printed).not.toContain(source);
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
    expect(calls).not.toContain("fake-key-for-the-test");
    // The service file was private and is gone.
    expect(calls).toContain("service-file-mode: 600");
    expect(calls).toContain("service-dir-mode: 700");
    expect(calls).not.toMatch(/service-file-mode: (?!600)/);
    for (const line of calls.split("\n").filter((l) => l.startsWith("service-file: "))) {
      expect(existsSync(line.slice("service-file: ".length))).toBe(false);
    }
  }, 60_000);

  it("need a file argument and OCULUS_DATABASE_URL", async () => {
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    expect(await runBackupCli([], {}, out, out)).toBe(2);
    expect(await runBackupCli(["a", "b"], {}, out, out)).toBe(2);
    expect(await runRestoreCli(["--force"], {}, out, out)).toBe(2);
    expect(await runBackupCli(["x"], {}, out, out)).toBe(2);
    expect(lines.at(-1)).toContain("OCULUS_DATABASE_URL is not set");
    expect(await runRestoreCli(["x"], { OCULUS_DATABASE_URL: " " }, out, out)).toBe(2);
    const bad = "mysql://someone:" + FAKE_PASSWORD + "@host/db";
    expect(await runBackupCli(["x"], { OCULUS_DATABASE_URL: bad }, out, out)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Backup refused \(bad_url\)/);
    expect(lines.join("\n")).not.toContain(FAKE_PASSWORD);
  });
});

// ---------------------------------------------------------------------------

describe("connection parameters for pg_dump and pg_restore", () => {
  it("read the URL as libpq does, query keywords last", () => {
    const params = connectionParameters(
      "postgresql://some%40one:p%40ss%2Fword@db.example.invalid:5433/oculus%5Fmain?sslmode=require&host=%2Fvar%2Frun%2Fpostgresql&application_name=a+b",
    );
    expect(Object.fromEntries(params)).toEqual({
      host: "/var/run/postgresql",
      port: "5433",
      user: "some@one",
      password: "p@ss/word",
      dbname: "oculus_main",
      sslmode: "require",
      application_name: "a+b",
    });
    expect(Object.fromEntries(connectionParameters("postgres://[::1]/x"))).toEqual({
      host: "::1",
      dbname: "x",
    });
    expect(serviceFileText(new Map([["host", "h"]]), "oculus-backup")).toBe(
      "[oculus_backup]\nhost=h\nfallback_application_name=oculus-backup\n",
    );
  });

  it("refuse what a service file can't hold, without showing any value", () => {
    const cases = [
      "not a url",
      "mysql://u@h/db",
      `postgresql://u:${FAKE_PASSWORD}@h/db?ssl=true`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?service=other`,
      `postgresql://u:${FAKE_PASSWORD}%0A@h/db`,
      `postgresql://u:%20${FAKE_PASSWORD}@h/db`,
      `postgresql://u:${FAKE_PASSWORD}@h/db?options=%E0%A4%A`,
    ];
    for (const url of cases) {
      let error: unknown;
      try {
        connectionParameters(url);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).code).toBe("bad_url");
      expect((error as Error).message).not.toContain(FAKE_PASSWORD);
      expect((error as Error).message).not.toContain(url);
    }
  });

  it("give the tools the caller's environment without OCULUS_ variables or another service", () => {
    expect(
      toolEnvironment(
        {
          PATH: "/usr/bin",
          PGPASSFILE: "/home/x/.pgpass",
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
      PGSERVICEFILE: "/tmp/s/pg_service.conf",
    });
  });

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
