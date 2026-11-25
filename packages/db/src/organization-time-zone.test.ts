// An organization's time zone and local day (T-034e, D-103), on a real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, type OrganizationId } from "@oculus/core";
import { openDatabase, type Database } from "./client.js";
import { insertOrganization } from "./catalog.js";
import { migrate } from "./migrate.js";
import {
  looksLikeTimeZone,
  readOrganizationTimeZone,
  writeOrganizationTimeZone,
} from "./organization-time-zone.js";
import { sql } from "./sql.js";
import { freshDatabase, type TestDatabase } from "./test-database.fixtures.js";

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
}, 120_000);
afterAll(async () => {
  await db.close();
  await testDb.drop();
});

async function organization(): Promise<OrganizationId> {
  const id = newOrganizationId();
  const made = await insertOrganization(db, { id, name: "Invented Historical Society" });
  expect(made.ok).toBe(true);
  return id;
}

/** The day in `zone` at the database's `now()` for a transaction, worked out by Intl. */
function dayIn(zone: string, instant: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** The organization's day and the transaction's instant, in one transaction. */
async function dayAndNow(org: OrganizationId): Promise<{ day: string; now: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.rows<{ day: string; now: string }>(sql`
      SELECT public.organization_local_day(${org}::uuid) AS day,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`);
    if (row === undefined) throw new Error("no row");
    return row;
  });
}

describe("an organization's time zone", () => {
  it("is UTC until set, and its day is the UTC day", async () => {
    const org = await organization();
    expect((await readOrganizationTimeZone(db, org))?.timeZone).toBe("UTC");
    const { day, now } = await dayAndNow(org);
    expect(day).toBe(dayIn("UTC", now));
  });

  it("gives the organization's own calendar day once set", async () => {
    const org = await organization();
    const set = await writeOrganizationTimeZone(db, org, "America/Chicago");
    expect(set.ok).toBe(true);
    const { day, now } = await dayAndNow(org);
    expect(day).toBe(dayIn("America/Chicago", now));
  });

  it("tells far-apart zones' days apart (they are never the same day)", async () => {
    const east = await organization();
    const west = await organization();
    expect((await writeOrganizationTimeZone(db, east, "Pacific/Kiritimati")).ok).toBe(true); // UTC+14
    expect((await writeOrganizationTimeZone(db, west, "Pacific/Pago_Pago")).ok).toBe(true); // UTC-11
    const [row] = await db.rows<{ east: string; west: string }>(sql`
      SELECT public.organization_local_day(${east}::uuid) AS east,
             public.organization_local_day(${west}::uuid) AS west`);
    expect(row?.east).not.toBe(row?.west);
    expect((row?.east ?? "") > (row?.west ?? "")).toBe(true);
  });

  it("refuses zones PostgreSQL doesn't know, or that aren't zone names, before writing", async () => {
    const org = await organization();
    for (const bad of [
      "Mars/Olympus_Mons",
      "",
      "a b",
      "../../etc/passwd",
      "x".repeat(65),
      7,
      null,
    ]) {
      const result = await writeOrganizationTimeZone(db, org, bad);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.issues[0]?.code).toBe("unknown_time_zone");
    }
    expect((await readOrganizationTimeZone(db, org))?.timeZone).toBe("UTC");
    expect(looksLikeTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(looksLikeTimeZone("Etc/GMT+6")).toBe(true);
  });

  it("can't be set to an unknown zone even with direct SQL (the database checks)", async () => {
    const org = await organization();
    await expect(
      db.execute(sql`UPDATE public.organizations SET time_zone = 'Mars/Olympus_Mons'
                     WHERE id = ${org}::uuid`),
    ).rejects.toThrow(/unknown time zone/);
    await expect(
      db.execute(sql`UPDATE public.organizations SET time_zone = 'a b' WHERE id = ${org}::uuid`),
    ).rejects.toThrow();
  });

  it("gives an unknown organization the UTC day, saying nothing about whether it exists", async () => {
    const { day, now } = await dayAndNow(newOrganizationId());
    expect(day).toBe(dayIn("UTC", now));
  });

  it("refuses to set the zone of an organization that doesn't exist", async () => {
    const result = await writeOrganizationTimeZone(db, newOrganizationId(), "America/Chicago");
    expect(result.ok).toBe(false);
  });
});
