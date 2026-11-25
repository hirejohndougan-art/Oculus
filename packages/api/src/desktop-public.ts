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
 * - **Listening.** Every port is bound on the loopback addresses only:
 *   127.0.0.1, and ::1 too where the computer has IPv6, because `localhost`
 *   may resolve to either; a port another program holds on ::1 counts as
 *   taken, so a browser never reaches someone else's program at a site's
 *   address. The ports are held before the server is built, and only the
 *   sites whose port is held are given to it (and shown). A public port is a
 *   plain TCP listener that hands each connection to the admin's own HTTP
 *   server (`server.emit("connection")`) once it is attached, so the same
 *   timeouts, limits and rules apply, and public sites are told apart by the
 *   origin the browser sends, as on a real server.
 * - **Ports** are kept in `desktop.json` (`publicPorts`, by site ID) so a
 *   site's public address stays the same between starts; a site without one,
 *   or whose port is taken, gets the next free port from 4781 up.
 */
import type { Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { checkCsrfToken } from "@oculus/core";
import { resolveSession, sitesForPerson, sql, type Queryable } from "@oculus/db";
import { OCULUS_COOKIES } from "./cookies.js";
import { anyFreePort } from "./desktop.js";
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
 * `publicPortIsFree` (tests replace it).
 */
export async function assignPublicPorts(
  sites: readonly string[],
  saved: Readonly<Record<string, number>> | undefined,
  adminPort: number,
  isFree: (port: number) => Promise<boolean> = publicPortIsFree,
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
      if (!taken.has(candidate) && (await isFree(candidate))) port = candidate;
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

/** Error codes that mean "no IPv6 loopback here", not "someone holds the port". */
const NO_IPV6 = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EINVAL"]);

type Bound =
  { readonly ok: true; readonly listener: Server } | { readonly ok: false; readonly code: string };

/** Binds one listener (exclusively) at `host:port`; `onSocket` gets its connections. */
function bind(host: string, port: number, onSocket: (socket: Socket) => void): Promise<Bound> {
  return new Promise((resolve) => {
    const listener = createServer(onSocket);
    listener.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: typeof error.code === "string" ? error.code : "error" });
    });
    listener.listen({ host, port, exclusive: true }, () => {
      listener.removeAllListeners("error");
      // A later error on a listening socket must not crash the launcher.
      listener.on("error", () => undefined);
      resolve({ ok: true, listener });
    });
  });
}

function closeListener(listener: Server): Promise<void> {
  return new Promise((resolve) => {
    listener.close(() => {
      resolve();
    });
  });
}

/**
 * Whether a public port is free: on 127.0.0.1, and on ::1 unless the
 * computer has no IPv6 loopback (a program holding it there would answer
 * `localhost:<port>` for some browsers, D-109).
 */
export async function publicPortIsFree(port: number, secondHost = "::1"): Promise<boolean> {
  const ignore = (socket: Socket) => {
    socket.destroy();
  };
  const v4 = await bind("127.0.0.1", port, ignore);
  if (!v4.ok) return false;
  try {
    const v6 = await bind(secondHost, port, ignore);
    if (v6.ok) {
      await closeListener(v6.listener);
      return true;
    }
    return NO_IPV6.has(v6.code);
  } finally {
    await closeListener(v4.listener);
  }
}

/** Listeners that hand their connections to the admin's HTTP server. */
export interface PublicListeners {
  /** Stops taking connections; resolves once they have all ended. */
  close(): Promise<void>;
  /** Ends the connections still open (after the admin's server has closed). */
  destroy(): void;
}

/** Public ports held before the server is built (T-071 review, item 1). */
export interface HeldPublicPorts extends PublicListeners {
  /** The ports held, in the order asked; the others are left alone. */
  readonly held: readonly number[];
  /**
   * Hands every connection from now on to `server` (the admin's, already
   * listening). Until then, and after `close`, connections are refused.
   */
  attach(server: HttpServer): void;
}

/**
 * Holds each port on 127.0.0.1 and, where the computer has IPv6, on ::1. A
 * port that can't be held on either (taken, or held by another program on
 * ::1) is skipped and not in `held`; nothing is thrown for it.
 */
export async function holdPublicPorts(
  ports: readonly number[],
  /** The second loopback address (tests use another 127.x where there's no IPv6). */
  secondHost = "::1",
): Promise<HeldPublicPorts> {
  const listeners: Server[] = [];
  const sockets = new Set<Socket>();
  let target: HttpServer | undefined;
  let closing = false;
  const onSocket = (socket: Socket) => {
    // Not attached yet, or closing: no connection is taken.
    if (closing || target?.listening !== true) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    target.emit("connection", socket);
  };
  const held: number[] = [];
  for (const port of ports) {
    const v4 = await bind("127.0.0.1", port, onSocket);
    if (!v4.ok) continue;
    const v6 = await bind(secondHost, port, onSocket);
    if (v6.ok) {
      listeners.push(v4.listener, v6.listener);
    } else if (NO_IPV6.has(v6.code)) {
      listeners.push(v4.listener);
    } else {
      // Another program answers localhost:<port> on ::1: not this site's port.
      await closeListener(v4.listener);
      continue;
    }
    held.push(port);
  }
  return {
    held,
    attach(server) {
      target = server;
    },
    close() {
      closing = true;
      return Promise.all(listeners.map(closeListener)).then(() => undefined);
    },
    destroy() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

/**
 * Holds every port and hands its connections to `server` (already
 * listening); refuses (closing what it opened) if any port can't be held.
 */
export async function listenPublicPorts(
  server: HttpServer,
  ports: readonly number[],
): Promise<PublicListeners> {
  const hold = await holdPublicPorts(ports);
  if (hold.held.length !== ports.length) {
    await hold.close();
    throw new Error("a public port is taken");
  }
  hold.attach(server);
  return hold;
}

/** The launcher's route that opens a public site in the default browser. */
export const OPEN_PUBLIC_SITE_PATH = "/api/desktop/public-site";

/**
 * `POST /api/desktop/public-site { siteId }` (T-071, D-109): opens that
 * site's public home (`http://localhost:<port>/`, from the launcher's own
 * list, never an address from the request) in the default browser. Only on
 * the launcher's own `127.0.0.1:<port>` host (and `/api` is the admin's
 * host only anyway, D-090), only for a signed-in session with its CSRF
 * token (`X-Oculus-CSRF`), at most once a second for each site, and only for a site the
 * person may work in (`sitesForPerson`, as `GET /api/me` lists them). Any
 * other site is the unknown path's 404. A session that can't be read is
 * logged (`log`, a fixed code, never the token) and answered 503.
 */
export function openPublicSiteRoute(options: {
  readonly db: Queryable;
  readonly ownHost: string;
  /** Site ID → public origin, as the launcher serves them. */
  readonly origins: ReadonlyMap<string, string>;
  readonly open: (url: string) => void;
  readonly clock?: () => number;
  /** A fixed event code when the session or the person's sites can't be read. */
  readonly log?: (code: string) => void;
}): OculusRoute {
  const clock = options.clock ?? Date.now;
  // Once a second per site, so opening one site then another isn't refused.
  const last = new Map<string, number>();
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
        options.log?.(`open_public_site_session_${resolved.code}`);
        throw new Refusal(503, "unavailable");
      }
      const body = objectBody(request);
      const siteId = body.siteId;
      if (Object.keys(body).length !== 1 || typeof siteId !== "string") {
        throw new Refusal(400, "bad_body");
      }
      const origin = options.origins.get(siteId);
      if (origin === undefined) throw new Refusal(404, "not_found");
      let mine: readonly { readonly siteId: string }[];
      try {
        mine = await sitesForPerson(options.db, resolved.session.userId);
      } catch {
        options.log?.("open_public_site_sites_unreadable");
        throw new Refusal(503, "unavailable");
      }
      if (!mine.some((site) => site.siteId === siteId)) throw new Refusal(404, "not_found");
      const now = clock();
      if (now - (last.get(siteId) ?? -Infinity) < 1000) throw new Refusal(429, "rate_limited");
      last.set(siteId, now);
      options.open(`${new URL(origin).origin}/`);
      return { opened: true };
    },
  };
}
