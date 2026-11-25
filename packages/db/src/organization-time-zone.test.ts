// An organization's time zone and local day (T-034e, D-103), on a real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, type OrganizationId, type UserId } from "@oculus/core";
import { createFirstSystemAdmin } from "./accounts.js";
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
let admin: UserId;

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  const made = await createFirstSystemAdmin(db, {
    email: "root@example.org",
    displayName: "Invented Root",
    password: "Invented river bend lantern 2026",
  });
  if (!made.ok) throw new Error("no admin");
  admin = made.value.userId;
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

  it("gives the organization's own calendar day once set, and records who set it", async () => {
    const org = await organization();
    const set = await writeOrganizationTimeZone(db, org, "America/Chicago", admin);
    expect(set.ok).toBe(true);
    const { day, now } = await dayAndNow(org);
    expect(day).toBe(dayIn("America/Chicago", now));
    const [who] = await db.rows<{ by: string; at: string | null }>(sql`
      SELECT time_zone_changed_by AS by, time_zone_changed_at::text AS at
      FROM public.organizations WHERE id = ${org}::uuid`);
    expect(who?.by).toBe(admin);
    expect(who?.at).not.toBeNull();
  });

  it("tells far-apart zones' days apart (they are never the same day)", async () => {
    const east = await organization();
    const west = await organization();
    expect((await writeOrganizationTimeZone(db, east, "Pacific/Kiritimati", admin)).ok).toBe(true); // UTC+14
    expect((await writeOrganizationTimeZone(db, west, "Pacific/Pago_Pago", admin)).ok).toBe(true); // UTC-11
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
      const result = await writeOrganizationTimeZone(db, org, bad, admin);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.issues[0]?.code).toBe("unknown_time_zone");
    }
    expect((await readOrganizationTimeZone(db, org))?.timeZone).toBe("UTC");
    expect(looksLikeTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(looksLikeTimeZone("UTC")).toBe(true);
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

  it("refuses rather than guesses when a stored zone stops being known (time zone data changed)", async () => {
    const org = await organization();
    // As if the operating system's time zone data dropped the zone after it was stored.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE public.organizations DISABLE TRIGGER organizations_check_time_zone`,
      );
      await tx.execute(
        sql`UPDATE public.organizations SET time_zone = 'Africa/Atlantis' WHERE id = ${org}::uuid`,
      );
      await tx.execute(
        sql`ALTER TABLE public.organizations ENABLE ALWAYS TRIGGER organizations_check_time_zone`,
      );
    });
    const [row] = await db.rows<{ day: string | null }>(
      sql`SELECT public.organization_local_day(${org}::uuid) AS day`,
    );
    expect(row?.day).toBeNull();
    expect((await readOrganizationTimeZone(db, org))?.today).toBe("");
  });

  it("the database itself refuses a bad zone on insert, even bypassing the helper", async () => {
    for (const zone of ["Mars/Olympus_Mons", "localtime", "US/Central"]) {
      await expect(
        db.execute(sql`
          INSERT INTO public.organizations (id, name, time_zone)
          VALUES (${newOrganizationId()}::uuid, 'Invented Bad Zone', ${zone})`),
      ).rejects.toThrow();
    }
  });

  it("gives an unknown organization the UTC day", async () => {
    const { day, now } = await dayAndNow(newOrganizationId());
    expect(day).toBe(dayIn("UTC", now));
  });

  it("refuses to set the zone of an organization that doesn't exist", async () => {
    const result = await writeOrganizationTimeZone(
      db,
      newOrganizationId(),
      "America/Chicago",
      admin,
    );
    expect(result.ok).toBe(false);
  });
});
