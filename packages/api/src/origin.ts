/**
 * The Origin check on every change (D-051, D-058; ASVS 5.0 3.5.1, 3.5.3).
 *
 * `OCULUS_ORIGINS` lists every origin the install serves (the admin and each
 * public site, D-034), comma-separated, for example
 * `https://admin.example.org,https://archive.example.org`. Each must be a
 * bare origin (scheme, host and port only); `http:` is allowed only for
 * `localhost`, `127.0.0.1` and `[::1]`. The server refuses to start without it.
 *
 * A request with any method other than GET or HEAD passes when:
 * - its `Origin` is one of the listed origins and names the host the request
 *   was sent to (its `Host`, or `X-Forwarded-Host` from a trusted proxy), so a
 *   page on one Oculus site can't post to another; or
 * - it has no `Origin` but says `Sec-Fetch-Site: same-origin`.
 * Any signal that disagrees refuses it: an `Origin` that isn't listed or names
 * another host (including `null` and repeated headers), or a `Sec-Fetch-Site`
 * other than `same-origin`. A request with neither is refused too. T-037 adds
 * the CSRF token on top; this check doesn't replace it.
 */
import type { FastifyRequest } from "fastify";

export const ORIGINS_ENV = "OCULUS_ORIGINS";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The checked origin list from the environment; throws when it is missing or wrong. */
export function originsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const raw = env[ORIGINS_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${ORIGINS_ENV} must list the origins this server answers for`);
  }
  const origins = new Set<string>();
  for (const entry of raw.split(",").map((e) => e.trim())) {
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    const ok =
      url?.origin === entry &&
      (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)));
    if (!ok) {
      throw new Error(
        `${ORIGINS_ENV} entries must be bare https origins (http only for localhost); refusing ${JSON.stringify(entry)}`,
      );
    }
    origins.add(entry);
  }
  return origins;
}

/** The request's host in the same form as `URL.host` for the origin's scheme. */
function requestHost(request: FastifyRequest, protocol: string): string | undefined {
  const host: unknown = request.host;
  if (typeof host !== "string" || host === "") return undefined;
  try {
    const url = new URL(`${protocol}//${host}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/") return undefined;
    return url.host;
  } catch {
    return undefined;
  }
}

/** True when a request that changes something fails the same-origin check. */
export function failsOriginCheck(request: FastifyRequest, origins: ReadonlySet<string>): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return true;
  if (origin === undefined) return fetchSite !== "same-origin";
  const lower = origin.toLowerCase();
  if (!origins.has(lower)) return true;
  const url = new URL(lower);
  return requestHost(request, url.protocol) !== url.host;
}
