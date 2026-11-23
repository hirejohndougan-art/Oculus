/**
 * The Origin check on every change (D-051; ASVS 5.0 3.5.1, 3.5.3).
 *
 * A request with any method other than GET or HEAD must come from the same
 * origin. It passes when:
 * - its `Origin` header is exactly the server's own origin (the scheme Fastify
 *   sees, plus the `Host` header), or
 * - it has no `Origin` but says `Sec-Fetch-Site: same-origin`.
 * Any signal that disagrees refuses it: an `Origin` that differs (including
 * `null` and repeated headers), or a `Sec-Fetch-Site` other than
 * `same-origin`. A request with neither is refused too. T-037 adds the CSRF
 * token on top; this check doesn't replace it.
 *
 * Behind a reverse proxy the scheme and host come from `X-Forwarded-Proto`
 * and `X-Forwarded-Host` only when the proxy is trusted (proxy.ts).
 */
import type { FastifyRequest } from "fastify";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

function serverOrigin(request: FastifyRequest): string | undefined {
  const host: unknown = request.host;
  if (typeof host !== "string" || host === "") return undefined;
  try {
    const url = new URL(`${request.protocol}://${request.host}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** True when a request that changes something fails the same-origin check. */
export function failsOriginCheck(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return true;
  if (origin !== undefined) {
    const own = serverOrigin(request);
    return own === undefined || origin.toLowerCase() !== own;
  }
  return fetchSite !== "same-origin";
}
