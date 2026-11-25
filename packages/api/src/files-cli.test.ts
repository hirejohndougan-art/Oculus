// The operator's file command (M-002, D-086): `files:adopt` refuses while
// the folder is busy and deletes nothing; there is no purge in this version
// (fifth review). Over a fresh database and a throwaway files folder; no
// URL or path is printed.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Database } from "@oculus/db";
import { ADOPT_QUIET_MS, STORE_MARKER, createService, openFileStore } from "@oculus/service";
import { newRecordId } from "@oculus/core";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { runFilesCli } from "./files-cli.js";

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

  it("has no purge: it says so and touches nothing", async () => {
    const before = readFileSync(join(dir, STORE_MARKER), "utf8");
    const r = run(["purge", "--yes"]);
    expect(await r.done).toBe(2);
    expect(r.lines.join("\n")).toMatch(/no purge in this version.*keep using disk space/);
    expect(r.lines.join("\n")).not.toContain(dir);
    expect(readFileSync(join(dir, STORE_MARKER), "utf8")).toBe(before);
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
