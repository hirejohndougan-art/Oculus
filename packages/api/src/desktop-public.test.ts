// The public sites on the desktop (T-071, D-109): each site keeps its port
// between starts; the public ports listen on 127.0.0.1 only and hand their
// connections to the admin's server; and the launcher's "open in the default
// browser" route opens only its own address for a site, for a signed-in
// session with its CSRF token, on its own host, at most once a second.
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "@oculus/core";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import {
  FIRST_PUBLIC_PORT,
  assignPublicPorts,
  desktopSites,
  listenPublicPorts,
  openPublicSiteRoute,
  publicOriginFor,
} from "./desktop-public.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER } from "./staff-api.js";
import { fullSession, makeWorld, type World } from "./staff-api.fixtures.js";

const A = "4d6f5b1e-9c3a-4b7e-8f21-0a1b2c3d4e5f";
const B = "5e7a6c2f-0d4b-4c8f-9a32-1b2c3d4e5f60";
const C = "6f8b7d30-1e5c-4d90-8b43-2c3d4e5f6071";

describe("assignPublicPorts", () => {
  const free = (busy: number[]) => (port: number) => Promise.resolve(!busy.includes(port));

  it("keeps each site's saved port, and gives new sites the next free one, never the admin's", async () => {
    const ports = await assignPublicPorts(
      [A, B, C],
      { [A]: 5000 },
      FIRST_PUBLIC_PORT,
      free([FIRST_PUBLIC_PORT + 1]),
    );
    expect(ports).toEqual({ [A]: 5000, [B]: FIRST_PUBLIC_PORT + 2, [C]: FIRST_PUBLIC_PORT + 3 });
  });

  it("moves a site whose saved port is taken, and keeps another site's saved port for it", async () => {
    const ports = await assignPublicPorts(
      [A],
      { [A]: 5000, [B]: FIRST_PUBLIC_PORT },
      4780,
      free([5000]),
    );
    expect(ports).toEqual({ [A]: FIRST_PUBLIC_PORT + 1 });
  });

  it("names public origins as localhost, never the admin's 127.0.0.1", () => {
    expect(publicOriginFor(4781)).toBe("http://localhost:4781");
  });
});

/** A GET to 127.0.0.1:<port> with the given Host. */
function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host }, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("listenPublicPorts", () => {
  it("listens on 127.0.0.1 only and hands connections to the admin's server", async () => {
    const seen: string[] = [];
    const admin: Server = createHttpServer((request, response) => {
      seen.push(String(request.headers.host));
      response.end("ok");
    });
    await new Promise<void>((resolve) => admin.listen(0, "127.0.0.1", resolve));
    const free = await new Promise<number>((resolve) => {
      const probe = createHttpServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => {
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });
    });
    const listeners = await listenPublicPorts(admin, [free]);
    try {
      const reply = await get(free, "/", `localhost:${String(free)}`);
      expect(reply).toEqual({ status: 200, body: "ok" });
      expect(seen).toEqual([`localhost:${String(free)}`]);
      // Not on any other address of this computer.
      await expect(
        new Promise((resolve, reject) => {
          const r = httpRequest({ host: "::1", port: free, path: "/", agent: false }, resolve);
          r.on("error", reject);
          r.end();
        }),
      ).rejects.toThrow();
    } finally {
      const closed = listeners.close();
      await new Promise<void>((resolve) => admin.close(() => resolve()));
      listeners.destroy();
      await closed;
    }
  });

  it("refuses a port that is taken, leaving nothing open", async () => {
    const busy = createHttpServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const address = busy.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      await expect(listenPublicPorts(busy, [port])).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });
});

describe("the open-in-the-default-browser route", () => {
  let w: World;
  let app: FastifyInstance;
  const opened: string[] = [];
  let now = 0;

  beforeAll(async () => {
    w = await makeWorld();
    app = await buildServer({
      env: { OCULUS_ORIGINS: "http://127.0.0.1:4780,http://localhost:4781" },
      routes: [
        openPublicSiteRoute({
          db: w.db,
          ownHost: "127.0.0.1:4780",
          origins: new Map([[w.a1, "http://localhost:4781"]]),
          open: (url) => opened.push(url),
          clock: () => now,
        }),
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await w.db.close();
    await w.testDb.drop();
  });

  const post = (body: unknown, headers: Record<string, string>, host = "127.0.0.1:4780") =>
    app.inject({
      method: "POST",
      url: "/api/desktop/public-site",
      headers: {
        host,
        origin: `http://${host}`,
        "content-type": "application/json",
        ...headers,
      },
      payload: JSON.stringify(body),
    });

  it("opens only the launcher's own address for the site, for a signed-in session with its CSRF token", async () => {
    const { token } = await fullSession(w.db, w.cataloger, w.a);
    const cookie = `${OCULUS_COOKIES.session}=${token}`;
    const csrf = csrfTokenFor(token) ?? "";
    expect((await post({ siteId: w.a1 }, {})).statusCode).toBe(401);
    expect((await post({ siteId: w.a1 }, { cookie })).statusCode).toBe(403);
    expect(
      (await post({ siteId: w.a1 }, { cookie, [CSRF_HEADER]: "x".repeat(43) })).statusCode,
    ).toBe(403);
    expect(
      (await post({ siteId: w.a1 }, { cookie, [CSRF_HEADER]: csrf }, "localhost:4781")).statusCode,
    ).toBe(404);
    expect((await post({ siteId: w.a2 }, { cookie, [CSRF_HEADER]: csrf })).statusCode).toBe(404);
    expect(
      (
        await post(
          { siteId: w.a1, url: "https://evil.example.com" },
          { cookie, [CSRF_HEADER]: csrf },
        )
      ).statusCode,
    ).toBe(400);
    expect(opened).toEqual([]);
    const ok = await post({ siteId: w.a1 }, { cookie, [CSRF_HEADER]: csrf });
    expect([ok.statusCode, ok.json()]).toEqual([200, { opened: true }]);
    expect(opened).toEqual(["http://localhost:4781/"]);
    // At most once a second.
    expect((await post({ siteId: w.a1 }, { cookie, [CSRF_HEADER]: csrf })).statusCode).toBe(429);
    now += 1000;
    expect((await post({ siteId: w.a1 }, { cookie, [CSRF_HEADER]: csrf })).statusCode).toBe(200);
    // Another origin can't post here at all (D-058).
    const foreign = await app.inject({
      method: "POST",
      url: "/api/desktop/public-site",
      headers: {
        host: "127.0.0.1:4780",
        origin: "http://localhost:4781",
        "content-type": "application/json",
        cookie,
        [CSRF_HEADER]: csrf,
      },
      payload: JSON.stringify({ siteId: w.a1 }),
    });
    expect(foreign.statusCode).toBe(403);
    expect(opened).toHaveLength(2);
  });

  it("lists the sites one organization holds, oldest first", async () => {
    const sites = await desktopSites(w.db);
    expect(sites.map((s) => s.id)).toEqual([w.a1, w.a2, w.b1]);
    expect(sites[0]?.name).toBe("Invented archive site");
  });
});
