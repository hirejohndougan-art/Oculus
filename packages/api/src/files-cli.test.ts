// The operator's file commands (M-002, D-086): `files:purge` runs a step of
// the purge (S-052) or, with --dry-run, says what one would do and changes
// nothing; `files:adopt` refuses while the folder is busy and deletes
// nothing. Over a fresh database and a throwaway files folder; no URL or
// path is printed.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Database } from "@oculus/db";
import { ADOPT_QUIET_MS, STORE_MARKER, createService, openFileStore } from "@oculus/service";
import { newRecordId } from "@oculus/core";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { purgeLines, runFilesCli } from "./files-cli.js";

let testDb: TestDatabase;
let db: Database;
let dir: string;

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  dir = mkdtempSync(join(tmpdir(), "oculus-files-cli-"));
  const bound = await createService(db, { files: await openFileStore({ dir }) }).bindFileStore();
  if (!bound.ok) throw new Error(bound.problem);
}, 60_000);

afterAll(async () => {
  await db.close();
  await testDb.drop();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], extra: Record<string, string> = {}) {
  const lines: string[] = [];
  const done = runFilesCli(
    args,
    { OCULUS_DATABASE_URL: testDb.url, OCULUS_FILES_DIR: dir, ...extra },
    {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    },
  );
  return { done, lines };
}

describe("files-cli", () => {
  it("refuses unknown commands and options, and a missing database", async () => {
    expect(await run(["sweep"]).done).toBe(2);
    expect(await run(["adopt", "--yes"]).done).toBe(2);
    const missing = runFilesCli(
      ["adopt"],
      { OCULUS_FILES_DIR: dir },
      { out: () => undefined, err: () => undefined },
    );
    expect(await missing).toBe(2);
  });

  it("purges by the admin's rules: a dry run changes nothing, a step takes the lease", async () => {
    const before = readFileSync(join(dir, STORE_MARKER), "utf8");
    expect(await run(["purge", "--yes"]).done).toBe(2);
    const dry = run(["purge", "--dry-run"]);
    expect(await dry.done).toBe(0);
    expect(dry.lines).toContain("Dry run: nothing was changed.");
    expect(dry.lines.join("\n")).toMatch(/Would move to the trash: 0 files \(0 bytes\)/);
    expect(dry.lines.join("\n")).not.toContain(dir);
    expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(before);
    const step = run(["purge"]);
    expect(await step.done).toBe(0);
    expect(step.lines).toContain("One purge step done.");
    // The lease moved on: the step took it.
    expect(readFileSync(join(dir, STORE_MARKER), "utf8")).not.toBe(before);
    // A folder whose lease isn't this database's: refused, and said why.
    const marker = join(dir, STORE_MARKER);
    const kept = readFileSync(marker, "utf8");
    const [storeId, database] = kept.split("\n");
    writeFileSync(marker, `${storeId ?? ""}\n${database ?? ""}\n${newRecordId()}\n`);
    const refused = run(["purge"]);
    expect(await refused.done).toBe(1);
    expect(refused.lines.join("\n")).toMatch(/lease isn't this database's/);
    writeFileSync(marker, kept);
  });

  it("prints what is stuck in the trash and a step stopped early", () => {
    const none = { files: 0, bytes: 0 };
    const lines = purgeLines({
      dryRun: false,
      trashed: none,
      deleted: none,
      restored: none,
      waiting: none,
      stuck: { files: 2, bytes: 3 * 1024 * 1024 },
      stopped: "lease_lost",
    });
    expect(lines.join("\n")).toMatch(/Stuck in the trash, left alone .*: 2 files \(3\.0 MiB\)/);
    expect(lines.join("\n")).toMatch(/lease moved/);
  });

  it("refuses adopt while the folder is busy, then adopts and deletes nothing", async () => {
    const marker = join(dir, STORE_MARKER);
    const [storeId, database] = readFileSync(marker, "utf8").split("\n");
    writeFileSync(marker, `${storeId ?? ""}\n${database ?? ""}\n${newRecordId()}\n`);
    const kept = join(dir, "kept-by-the-operator");
    writeFileSync(kept, "x");
    const busy = run(["adopt"]);
    expect(await busy.done).toBe(1);
    expect(busy.lines.join("\n")).toMatch(/changed within the last three hours/);
    // Two hours is still too soon (three renewals).
    const soon = new Date(Date.now() - 2 * 3600_000);
    utimesSync(marker, soon, soon);
    expect(await run(["adopt"]).done).toBe(1);
    const past = new Date(Date.now() - ADOPT_QUIET_MS - 60_000);
    utimesSync(marker, past, past);
    const adopt = run(["adopt"]);
    expect(await adopt.done).toBe(0);
    expect(adopt.lines.join("\n")).toMatch(/now owns the files folder\. Nothing was deleted\./);
    expect(existsSync(kept)).toBe(true);
    rmSync(kept);
  }, 30_000);
});
