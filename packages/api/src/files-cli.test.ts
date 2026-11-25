// The operator's file commands (M-002, D-086): `files:purge` lists, asks
// and deletes only what the purge allows, refuses on a lease that isn't
// this database's; `files:adopt` refuses while the folder is busy. Over a
// fresh database and a throwaway files folder; no URL or path is printed.
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Database } from "@oculus/db";
import { STORE_MARKER, createService, openFileStore } from "@oculus/service";
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

function run(args: string[], answer = false, extra: Record<string, string> = {}) {
  const lines: string[] = [];
  let asked = 0;
  const done = runFilesCli(
    args,
    { OCULUS_DATABASE_URL: testDb.url, OCULUS_FILES_DIR: dir, ...extra },
    {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      confirm: () => {
        asked++;
        return Promise.resolve(answer);
      },
    },
  );
  return { done, lines, asked: () => asked };
}

describe("files-cli", () => {
  it("refuses unknown commands and options, and a missing database", async () => {
    expect(await run(["sweep"]).done).toBe(2);
    expect(await run(["purge", "--force"]).done).toBe(2);
    expect(await run(["adopt", "--yes"]).done).toBe(2);
    const missing = runFilesCli(
      ["purge"],
      { OCULUS_FILES_DIR: dir },
      {
        out: () => undefined,
        err: () => undefined,
        confirm: () => Promise.resolve(false),
      },
    );
    expect(await missing).toBe(2);
  });

  it("purges nothing when there is nothing to purge, and never prints a path or URL", async () => {
    const r = run(["purge"]);
    expect(await r.done).toBe(0);
    expect(r.lines).toEqual(["Nothing to purge."]);
    expect(r.asked()).toBe(0);
    expect(r.lines.join("\n")).not.toContain(dir);
  });

  it("refuses to purge on another database's lease, and adopt while the folder is busy", async () => {
    const marker = join(dir, STORE_MARKER);
    const [storeId, database] = readFileSync(marker, "utf8").split("\n");
    writeFileSync(marker, `${storeId ?? ""}\n${database ?? ""}\n${newRecordId()}\n`);
    const purge = run(["purge", "--yes"]);
    expect(await purge.done).toBe(1);
    expect(purge.lines.join("\n")).toMatch(/lease isn't this database's.*files:adopt/);
    const busy = run(["adopt"]);
    expect(await busy.done).toBe(1);
    expect(busy.lines.join("\n")).toMatch(/changed within the last hour/);
    const past = new Date(Date.now() - 2 * 3600_000);
    utimesSync(marker, past, past);
    const adopt = run(["adopt"]);
    expect(await adopt.done).toBe(0);
    expect(adopt.lines.join("\n")).toMatch(/now owns the files folder/);
    expect(await run(["purge"]).done).toBe(0);
  }, 30_000);
});
