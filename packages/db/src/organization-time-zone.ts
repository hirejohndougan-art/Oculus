/**
 * An organization's time zone (T-034e, D-103): an IANA name PostgreSQL
 * knows (migration 0029 refuses any other), from which
 * `organization_local_day` works out the organization's calendar day for
 * the accession register (D-056). Setting it is a System settings change:
 * the service lets only system managers make it (D-072).
 */
import type { OrganizationId, UserId, Validated } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

const UNKNOWN_ZONE =
  "Choose a time zone such as America/Chicago or Europe/London (an IANA Area/Location name), or UTC.";

/** `UTC` or a canonical IANA Area/Location name, as migration 0029's CHECK allows. */
const ZONE_NAME =
  /^(UTC|(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?)$/;

/** Whether `value` has the shape of an allowed zone name; the database decides whether it exists. */
export function looksLikeTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ZONE_NAME.test(value);
}

/**
 * The organization's time zone and its local day now; `undefined` for an
 * unknown organization. `today` is empty if the stored zone is no longer
 * known to PostgreSQL (the publish check then refuses).
 */
export async function readOrganizationTimeZone(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<{ timeZone: string; today: string } | undefined> {
  const [row] = await db.rows<{ time_zone: string; today: string | null }>(sql`
    SELECT time_zone, public.organization_local_day(id) AS today
    FROM public.organizations WHERE id = ${organizationId}::uuid`);
  return row === undefined ? undefined : { timeZone: row.time_zone, today: row.today ?? "" };
}

/**
 * Sets the organization's time zone, in the caller's transaction. Refuses
 * (`unknown_time_zone`) a name PostgreSQL doesn't know, before writing.
 */
export async function writeOrganizationTimeZone(
  db: Queryable,
  organizationId: OrganizationId,
  timeZone: unknown,
  changedBy: UserId,
): Promise<Validated<{ timeZone: string; today: string }>> {
  const refuse = (): Validated<{ timeZone: string; today: string }> => ({
    ok: false,
    issues: [{ path: ["timeZone"], code: "unknown_time_zone", message: UNKNOWN_ZONE }],
  });
  if (!looksLikeTimeZone(timeZone)) return refuse();
  const known = await db.rows(
    sql`SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = ${timeZone}`,
  );
  if (known.length === 0) return refuse();
  const changed = await db.execute(sql`
    UPDATE public.organizations
    SET time_zone = ${timeZone}, time_zone_changed_by = ${changedBy}::uuid,
        time_zone_changed_at = now()
    WHERE id = ${organizationId}::uuid`);
  if (changed !== 1) {
    return {
      ok: false,
      issues: [
        {
          path: ["organizationId"],
          code: "unknown_organization",
          message: "No such organization.",
        },
      ],
    };
  }
  const now = await readOrganizationTimeZone(db, organizationId);
  return now === undefined ? refuse() : { ok: true, value: now };
}
