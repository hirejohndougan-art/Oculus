// The desktop's local password reset (S-034a): the ordinary reset with this
// console as the mailbox, against a real throwaway database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, setUpFirstInstall, signIn, type Database } from "@oculus/db";
import type { UserId } from "@oculus/core";
import { giveTestFactor, testKeyring } from "../../db/src/second-factor.fixtures.js";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { runDesktopPassword } from "./desktop-password-cli.js";

const OLD = "Invented river bend lantern 2026";
const NEW = "Invented harbour light ferry 2027";

let database: TestDatabase;
let db: Database;
let folder: string;
let rootId: UserId;

beforeAll(async () => {
  database = await freshDatabase();
  await migrate({ connectionString: database.url });
  db = openDatabase(database.url, { max: 2 });
  const result = await setUpFirstInstall(db, {
    email: "root@example.org",
    displayName: "Invented Root",
    password: OLD,
    organizationName: "Invented Historical Society",
    siteName: "Invented Archive",
  });
  if (!result.ok) throw new Error("setup failed");
  rootId = result.value.userId;
}, 120_000);
afterAll(async () => {
  await db.close();
  await database.drop();
});
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "oculus-desktop-pw-"));
  writeFileSync(join(folder, "desktop.json"), JSON.stringify({ databaseUrl: database.url }));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function run(answers: (string | undefined)[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const done = runDesktopPassword({
    env: { OCULUS_DESKTOP_HOME: folder, ...env },
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answers.shift());
    },
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
  });
  return { done, lines, asked };
}

const works = async (password: string) =>
  (await signIn(db, { email: "root@example.org", password, source: "127.0.0.1" })).ok;

describe("npm run desktop:password", () => {
  it("refuses an account with no two-step sign-in in use, as the reset rules do (D-078)", async () => {
    const r = run(["root@example.org"]);
    expect(await r.done).toBe(1);
    expect(r.lines.join("\n")).toContain("system admin");
    expect(await works(OLD)).toBe(true);
    // From here on the account has two-step sign-in, as after a first sign-in.
    await giveTestFactor(db, testKeyring(), rootId, 1, 10);
  });

  it("says so and changes nothing for an address with no account", async () => {
    const r = run(["nobody@example.org"]);
    expect(await r.done).toBe(1);
    expect(r.lines.join("\n")).toContain("No account");
    expect(r.asked).toHaveLength(1);
  });

  it("asks again when the two passwords differ or the rules refuse one, then sets it", async () => {
    const r = run(["Root@Example.org", NEW, "something else", "short", "short", NEW, NEW]);
    expect(await r.done, r.lines.join("\n")).toBe(0);
    const printed = r.lines.join("\n");
    expect(printed).toContain("aren't the same");
    expect(printed).toContain("Done.");
    expect(printed).not.toContain(NEW);
    expect(await works(NEW)).toBe(true);
    expect(await works(OLD)).toBe(false);
  });

  it("uses only desktop.json's database, never one from the environment", async () => {
    writeFileSync(join(folder, "desktop.json"), JSON.stringify({ port: 4999 }));
    const r = run([], { OCULUS_DATABASE_URL: database.url });
    expect(await r.done).toBe(2);
    expect(r.asked).toEqual([]);
  });

  it("changes nothing when no password is given", async () => {
    const r = run(["root@example.org", undefined]);
    expect(await r.done).toBe(1);
    expect(await works(NEW)).toBe(true);
  });
});
