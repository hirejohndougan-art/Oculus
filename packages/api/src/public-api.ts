/**
 * Public record reads (T-050d, D-100, D-034, D-080, D-096): a public host's
 * published records, as their public output only.
 *
 * `GET /records/:id` on a host `OCULUS_PUBLIC_SITES` maps to a site
 * (public-sites.ts) answers with the record's `id` (its public URL),
 * `dublinCore` and `jsonLd`, and nothing else of `publicOutput`'s result:
 * never `staffWarnings` (S-011c). It reads through the public reader pool
 * only (`readPublicRecord`, D-080), with the template's stored Dublin Core
 * mapping (D-096), so it can reach no table and no unpublished record.
 *
 * Every refusal a public visitor could tell apart is one reply: a host that
 * isn't a public site (the admin's included), a malformed ID, a record that
 * doesn't exist, isn't published, is another site's or organization's, has
 * no mapping, or whose output core refuses all answer `404 not_found`,
 * exactly as an unknown path does. A database fault is `503 unavailable`.
 * Nothing about the record or the request is logged but a fixed code.
 *
 * Each client address may read `DEFAULT_RATE_LIMITS.public` records a
 * minute (rate-limit.ts), the T-042 note's brake on a public read that can
 * touch up to 10,000 records.
 */
import { isRecordId } from "@oculus/core";
import { readPublicRecord, type Database } from "@oculus/db";
import { Refusal } from "./errors.js";
import type { PublicSite } from "./public-sites.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";
import type { OculusRequest, OculusRoute } from "./routes.js";
import type { ApiLogRecord } from "./staff-api.js";

export interface PublicApiOptions {
  /** The public reader's pool (D-080), checked at startup (public-sites.ts). */
  readonly db: Database;
  /** The public hosts and their sites, resolved at startup (`checkPublicSites`). */
  readonly sites: readonly PublicSite[];
  readonly log?: (record: ApiLogRecord) => void;
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  readonly clock?: () => number;
}

/** The request's origin as `URL.origin` writes it, or undefined. */
function originOf(request: OculusRequest): string | undefined {
  try {
    const url = new URL(`${request.protocol}://${request.host}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

const NOT_FOUND = (): Refusal => new Refusal(404, "not_found");

/** The public read routes, for `buildServer({ routes })` beside the admin's. */
export function publicApiRoutes(options: PublicApiOptions): OculusRoute[] {
  const byOrigin = new Map(options.sites.map((site) => [site.origin, site]));
  const limiter = new SessionRateLimiter(
    { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    options.clock,
  );
  const log = options.log ?? (() => undefined);

  return [
    {
      method: "GET",
      path: "/records/:id",
      handler: async (request) => {
        const origin = originOf(request);
        const site = origin === undefined ? undefined : byOrigin.get(origin);
        // Not a public host (the admin's or an unlisted one): an unknown path.
        if (site === undefined) throw NOT_FOUND();
        if (!limiter.take(request.ip, "public")) throw new Refusal(429, "rate_limited");
        const id = request.params.id ?? "";
        if (!isRecordId(id)) throw NOT_FOUND();
        let result: Awaited<ReturnType<typeof readPublicRecord>>;
        try {
          result = await readPublicRecord(options.db, site.organizationId, site.siteId, id, {
            baseUrl: `${site.origin}/records/`,
          });
        } catch {
          log({ event: "service_error", operation: "readPublicRecord" });
          throw new Refusal(503, "unavailable");
        }
        if (!result.ok) {
          // Staff-only reasons (D-016, S-007) never leave; the public sees "not found".
          throw NOT_FOUND();
        }
        const out = result.value;
        return { id: out.id, dublinCore: out.dublinCore, jsonLd: out.jsonLd };
      },
    },
  ];
}
