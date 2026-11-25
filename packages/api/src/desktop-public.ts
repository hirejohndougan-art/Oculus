/**
 * The public sites on the desktop (T-071, D-109): each site's public side on
 * this computer, beside the admin, from the same server (D-034, D-088).
 *
 * - **Addresses.** The admin is `http://127.0.0.1:<port>`; each site's public
 *   side is `http://localhost:<its port>`. The host name differs on purpose:
 *   cookies are kept apart by host, not by port, so the admin's session
 *   cookie (host-only on 127.0.0.1, D-052) never reaches a public page, and
 *   `OCULUS_PUBLIC_SITES` refuses a public origin on the admin's host
 *   (D-090). Browsers resolve `localhost` to the loopback address
 *   themselves.
 * - **Listening.** Every port is bound on 127.0.0.1 only. A public port is a
 *   plain TCP listener that hands each connection to the admin's own HTTP
 *   server (`server.emit("connection")`), so the same timeouts, limits and
 *   rules apply, and public sites are told apart by the origin the browser
 *   sends, as on a real server.
 * - **Ports** are kept in `desktop.json` (`publicPorts`, by site ID) so a
 *   site's public address stays the same between starts; a site without one,
 *   or whose port is taken, gets the next free port from 4781 up.
 */
import type { Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { checkCsrfToken } from "@oculus/core";
import { resolveSession, sql, type Queryable } from "@oculus/db";
import { OCULUS_COOKIES } from "./cookies.js";
import { anyFreePort, portIsFree } from "./desktop.js";
import { Refusal } from "./errors.js";
import type { OculusRoute } from "./routes.js";
import { CSRF_HEADER, objectBody } from "./staff-api.js";

/** The first port tried for a site's public side. */
export const FIRST_PUBLIC_PORT = 4781;
const LAST_SCANNED_PORT = 4980;

/** The sites the desktop serves publicly: those whose ID only one organization holds (D-060). */
export async function desktopSites(
  db: Queryable,
): Promise<{ readonly id: string; readonly name: string }[]> {
  return db.rows<{ id: string; name: string }>(sql`
    SELECT id::text AS id, min(name) AS name FROM public.sites
    GROUP BY id HAVING count(*) = 1
    ORDER BY min(created_at), id`);
}

/**
 * A port for each site: its saved one if free (and not another's), else the
 * next free one from `FIRST_PUBLIC_PORT`, never `adminPort`. `isFree` is
 * `portIsFree` (tests replace it).
 */
export async function assignPublicPorts(
  sites: readonly string[],
  saved: Readonly<Record<string, number>> | undefined,
  adminPort: number,
  isFree: (port: number) => Promise<boolean> = portIsFree,
  anyFree: () => Promise<number> = anyFreePort,
): Promise<Record<string, number>> {
  const taken = new Set<number>([adminPort]);
  const out: Record<string, number> = {};
  const waiting: string[] = [];
  for (const site of sites) {
    const port = saved?.[site];
    if (port !== undefined && !taken.has(port) && (await isFree(port))) {
      out[site] = port;
      taken.add(port);
    } else {
      waiting.push(site);
    }
  }
  // Saved ports of sites not served now stay reserved, so their links come back.
  for (const [site, port] of Object.entries(saved ?? {})) {
    if (!(site in out)) taken.add(port);
  }
  let next = FIRST_PUBLIC_PORT;
  for (const site of waiting) {
    let port: number | undefined;
    while (port === undefined && next <= LAST_SCANNED_PORT) {
      const candidate = next++;
      if (!taken.has(candidate) && (await isFree(candidate))) port = candidate;
    }
    for (let tries = 0; port === undefined && tries < 20; tries++) {
      const candidate = await anyFree();
      if (!taken.has(candidate)) port = candidate;
    }
    if (port === undefined) throw new Error("no free port for a public site");
    out[site] = port;
    taken.add(port);
  }
  return out;
}

/** The public origin of a port: `http://localhost:<port>`. */
export function publicOriginFor(port: number): string {
  return `http://localhost:${String(port)}`;
}

/** Listeners that hand their connections to the admin's HTTP server. */
export interface PublicListeners {
  /** Stops taking connections; resolves once they have all ended. */
  close(): Promise<void>;
  /** Ends the connections still open (after the admin's server has closed). */
  destroy(): void;
}

/**
 * Listens on 127.0.0.1 at each port and hands every connection to `server`
 * (the admin's, already listening). Closes what it opened if any port
 * fails. A listener's `close` waits for the connections it accepted, so the
 * launcher calls `close`, then closes the admin's server (which ends idle
 * ones), then `destroy` for any left.
 */
export async function listenPublicPorts(
  server: HttpServer,
  ports: readonly number[],
): Promise<PublicListeners> {
  const listeners: Server[] = [];
  const sockets = new Set<Socket>();
  const close = (): Promise<void> =>
    Promise.all(
      listeners.map(
        (listener) =>
          new Promise<void>((resolve) => {
            listener.close(() => {
              resolve();
            });
          }),
      ),
    ).then(() => undefined);
  const destroy = (): void => {
    for (const socket of sockets) socket.destroy();
  };
  try {
    for (const port of ports) {
      const listener = createServer((socket: Socket) => {
        // Closing: no new connection is taken.
        if (!server.listening) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        server.emit("connection", socket);
      });
      listeners.push(listener);
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          listener.off("error", reject);
          resolve();
        });
      });
    }
  } catch (error) {
    const closing = close();
    destroy();
    await closing;
    throw error;
  }
  return { close, destroy };
}

/** The launcher's route that opens a public site in the default browser. */
export const OPEN_PUBLIC_SITE_PATH = "/api/desktop/public-site";

/**
 * `POST /api/desktop/public-site { siteId }` (T-071, D-109): opens that
 * site's public home (`http://localhost:<port>/`, from the launcher's own
 * list, never an address from the request) in the default browser. Only on
 * the launcher's own `127.0.0.1:<port>` host (and `/api` is the admin's
 * host only anyway, D-090), only for a signed-in session with its CSRF
 * token (`X-Oculus-CSRF`), at most once a second. Any other site is the
 * unknown path's 404.
 */
export function openPublicSiteRoute(options: {
  readonly db: Queryable;
  readonly ownHost: string;
  /** Site ID → public origin, as the launcher serves them. */
  readonly origins: ReadonlyMap<string, string>;
  readonly open: (url: string) => void;
  readonly clock?: () => number;
}): OculusRoute {
  const clock = options.clock ?? Date.now;
  let last = -Infinity;
  return {
    method: "POST",
    path: OPEN_PUBLIC_SITE_PATH,
    handler: async (request) => {
      if (request.host !== options.ownHost) throw new Refusal(404, "not_found");
      const token = request.cookies[OCULUS_COOKIES.session];
      if (token === undefined) throw new Refusal(401, "unauthenticated");
      if (!checkCsrfToken(token, request.headers[CSRF_HEADER])) {
        throw new Refusal(403, "csrf_failed");
      }
      const resolved = await resolveSession(options.db, token);
      if (!resolved.ok) {
        if (resolved.code === "no_session") throw new Refusal(401, "unauthenticated");
        throw new Refusal(503, "unavailable");
      }
      const body = objectBody(request);
      const siteId = body.siteId;
      if (Object.keys(body).length !== 1 || typeof siteId !== "string") {
        throw new Refusal(400, "bad_body");
      }
      const origin = options.origins.get(siteId);
      if (origin === undefined) throw new Refusal(404, "not_found");
      const now = clock();
      if (now - last < 1000) throw new Refusal(429, "rate_limited");
      last = now;
      options.open(`${new URL(origin).origin}/`);
      return { opened: true };
    },
  };
}
