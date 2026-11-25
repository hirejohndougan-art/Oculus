/**
 * Which host serves which public site, and the connection public sites read
 * through (T-050a, D-090, D-034, D-080).
 *
 * `OCULUS_PUBLIC_SITES` maps each public site's origin to its site ID,
 * comma-separated: `https://archive.example.org=<site id>,…`. Each origin
 * must be one of `OCULUS_ORIGINS`, may appear once, and may not be the
 * admin's origin (D-052: the admin has a hostname of its own, so its
 * session cookie never reaches a public page). Two origins may name the
 * same site (a `www.` name and a bare one). "Not the admin's" compares
 * hostnames, since cookies are not kept apart by scheme or port.
 *
 * The public sites read only through the public reader role (D-034, D-080):
 * `OCULUS_PUBLIC_DATABASE_URL` names a connection as a role made by
 * `grantPublicReaderRole`, and `checkPublicSites` refuses to go on unless
 * `checkPublicReaderConnection` reports nothing for it, so a connection
 * that could read a table (the writer's, an owner's, a superuser's) is
 * never used for a public site, and it must reach the writer's database
 * (not a copy). Each site must exist, in exactly one organization; its organization is
 * read once, with the writer's pool, because the public reader can read no
 * table (`readPublicRecord` takes both).
 *
 * Errors name the variable and what is wrong, never a URL or another value
 * (an origin and a site ID are not secret and are named so they can be
 * fixed).
 */
import { checkPublicReaderConnection, sql, type Database, type Queryable } from "@oculus/db";
import { isSiteId, type OrganizationId, type SiteId } from "@oculus/core";

export const PUBLIC_SITES_ENV = "OCULUS_PUBLIC_SITES";
export const PUBLIC_DATABASE_URL_ENV = "OCULUS_PUBLIC_DATABASE_URL";

/** One public host and the site it shows. */
export interface PublicSiteHost {
  readonly origin: string;
  readonly siteId: SiteId;
}

/** A public host with its site's organization, ready for `readPublicRecord`. */
export interface PublicSite extends PublicSiteHost {
  readonly organizationId: OrganizationId;
  /** The site's name at startup (the public home page, D-109). */
  readonly siteName?: string;
}

/**
 * The public hosts from the environment, checked against the install's
 * origins and the admin's; none when the variable is unset or empty.
 * Throws naming what is wrong.
 */
export function publicSitesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  origins: ReadonlySet<string>,
  adminOrigin: string | undefined,
): readonly PublicSiteHost[] {
  const raw = env[PUBLIC_SITES_ENV];
  if (raw === undefined || raw.trim() === "") return [];
  const adminHostname =
    adminOrigin === undefined || adminOrigin === "" ? undefined : new URL(adminOrigin).hostname;
  const seen = new Set<string>();
  const out: PublicSiteHost[] = [];
  for (const entry of raw.split(",").map((e) => e.trim())) {
    const at = entry.lastIndexOf("=");
    const origin = at < 0 ? "" : entry.slice(0, at).trim().toLowerCase();
    const siteId = at < 0 ? "" : entry.slice(at + 1).trim();
    if (origin === "" || !isSiteId(siteId)) {
      throw new Error(
        `${PUBLIC_SITES_ENV} entries are <origin>=<site id>, the site ID a lowercase version 4 UUID; refusing ${JSON.stringify(entry)}`,
      );
    }
    if (!origins.has(origin)) {
      throw new Error(`${PUBLIC_SITES_ENV}: ${origin} isn't one of OCULUS_ORIGINS`);
    }
    // The host, not the origin: cookies aren't kept apart by scheme or port,
    // so the admin's session cookie would reach a public page on its host.
    if (adminHostname !== undefined && new URL(origin).hostname === adminHostname) {
      throw new Error(
        `${PUBLIC_SITES_ENV}: ${origin} is on the admin's host; a public site needs a host of its own (D-052)`,
      );
    }
    if (seen.has(origin)) throw new Error(`${PUBLIC_SITES_ENV}: ${origin} is listed twice`);
    seen.add(origin);
    out.push(Object.freeze({ origin, siteId }));
  }
  return Object.freeze(out);
}

/**
 * Checks the public reader's connection and finds each public site's
 * organization: throws when the connection could read more than the public
 * read path (naming the problems' codes only) or a site doesn't exist.
 */
export async function checkPublicSites(
  writer: Queryable,
  reader: Database,
  hosts: readonly PublicSiteHost[],
): Promise<readonly PublicSite[]> {
  let problems: readonly { readonly code: string }[];
  try {
    problems = await checkPublicReaderConnection(reader);
  } catch {
    throw new Error(`${PUBLIC_DATABASE_URL_ENV}: the public reader's connection can't be checked`);
  }
  if (problems.length > 0) {
    const codes = [...new Set(problems.map((p) => p.code))].sort().join(", ");
    throw new Error(
      `${PUBLIC_DATABASE_URL_ENV} must connect as a public reader role (grantPublicReaderRole, D-080); found: ${codes}`,
    );
  }
  // The same database as the writer's: a reader pointed at another install
  // (a copy, staging) would pass the check and serve the wrong records.
  const same = sql`
    SELECT d.oid::text AS oid, d.datname AS name, pg_postmaster_start_time()::text AS started
    FROM pg_catalog.pg_database d WHERE d.datname = current_database()`;
  const [mine] = await writer.rows<{ oid: string; name: string; started: string }>(same);
  const [theirs] = await reader.rows<{ oid: string; name: string; started: string }>(same);
  if (
    mine === undefined ||
    mine.oid !== theirs?.oid ||
    mine.name !== theirs.name ||
    mine.started !== theirs.started
  ) {
    throw new Error(
      `${PUBLIC_DATABASE_URL_ENV} must connect to the same database as OCULUS_DATABASE_URL`,
    );
  }
  const out: PublicSite[] = [];
  for (const host of hosts) {
    const rows = await writer.rows<{ organization_id: string; name: string }>(sql`
      SELECT organization_id::text AS organization_id, name FROM public.sites
      WHERE id = ${host.siteId}::uuid LIMIT 2`);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`${PUBLIC_SITES_ENV}: there is no site ${host.siteId} (for ${host.origin})`);
    }
    // Site IDs are unique only within an organization (D-060): never guess which one.
    if (rows.length > 1) {
      throw new Error(
        `${PUBLIC_SITES_ENV}: site ${host.siteId} exists in more than one organization; it can't be served until that is resolved`,
      );
    }
    out.push(
      Object.freeze({
        ...host,
        organizationId: row.organization_id as OrganizationId,
        siteName: row.name,
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Each site's public address for the admin's "View public site" button
 * (T-070, D-109), keyed by `publicOriginKey`: the first origin listed for
 * the site. Only origins the server checked at startup are in it.
 */
export function publicOriginsBySite(sites: readonly PublicSite[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const site of sites) {
    const key = publicOriginKey(site.organizationId, site.siteId);
    if (!out.has(key)) out.set(key, site.origin);
  }
  return out;
}

/** The key of `publicOriginsBySite`: a site ID is unique only within its organization (D-060). */
export function publicOriginKey(organizationId: string, siteId: string): string {
  return `${organizationId}/${siteId}`;
}
