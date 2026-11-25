// The server's hosts (T-050a, D-090): with an admin origin, `/api` answers on
// the admin's host only (any other host gets the unknown path's 404, before
// any route, cookie or session is looked at); in production the admin's
// origin is required; `OCULUS_PUBLIC_SITES` is checked against the install's
// origins; and the public sites' connection must be a public reader role
// (D-080), refused at startup otherwise, as is a site that doesn't exist.
// Every organization and site is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId, newSiteId, type SiteId } from "@oculus/core";
import {
  grantPublicReaderRole,
  insertOrganization,
  insertSite,
  migrate,
  openDatabase,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import {
  freshDatabase,
  testServerUrl,
  type TestDatabase,
} from "../../db/src/test-database.fixtures.js";
import { loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import { publicSitesFromEnv } from "./public-sites.js";
import { buildServer, isApiPath } from "./server.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "https://admin.example.org";
const ARCHIVE = "https://archive.example.org";
const WWW = "https://www.archive.example.org";
const ORIGINS = new Set([ADMIN, ARCHIVE, WWW]);

let testDb: TestDatabase;
let owner: Database;
let reader: Database;
let readerRole: string;
let site: SiteId;
let dir: string;
let files: AdminFiles;

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

/** A throwaway files folder (M-002, D-086): the admin refuses to start without one. */
const FILES_DIR = mkdtempSync(join(tmpdir(), "oculus-public-hosts-files-"));

const ENV = {
  NODE_ENV: "production",
  OCULUS_FILES_DIR: FILES_DIR,
  OCULUS_ORIGINS: [...ORIGINS].join(","),
  OCULUS_ADMIN_ORIGIN: ADMIN,
  OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
  OCULUS_CLIENT_ADDRESS: "direct",
};

const start = (env: Record<string, string | undefined>, publicDb?: Database) =>
  buildAdminServer({
    db: owner,
    env,
    adminFiles: files,
    deliverReset: () => Promise.resolve(),
    log: () => undefined,
    ...(publicDb === undefined ? {} : { publicDb }),
  });

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  owner = openDatabase(testDb.url, { max: 3 });
  readerRole = `oculus_t050_reader_${newSiteId().slice(0, 8)}`;
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", readerRole));
  } finally {
    await server.close();
  }
  await owner.transaction((q) => grantPublicReaderRole(q, readerRole));
  const url = new URL(testDb.url);
  url.username = readerRole;
  reader = openDatabase(url.toString(), { max: 2 });
  const org = newOrganizationId();
  await insertOrganization(owner, { id: org, name: "Invented Archive" });
  site = newSiteId();
  await insertSite(owner, { id: site, organizationId: org, name: "Invented archive site" });
  dir = mkdtempSync(join(tmpdir(), "oculus-t050-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  mkdirSync(join(dir, "assets"));
  files = loadAdminFiles(dir);
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(FILES_DIR, { recursive: true, force: true });
  await reader.close();
  await owner.close();
  await testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I", readerRole));
  } finally {
    await server.close();
  }
});

describe("isApiPath", () => {
  it("is /api and what is under it, nothing else", () => {
    expect(["/api", "/api/", "/api/me", "/api/records/x"].every(isApiPath)).toBe(true);
    expect(["/apis", "/apiary", "/", "/health", "/x/api"].some(isApiPath)).toBe(false);
  });
});

describe("the API on the admin's host only", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer({
      env: { OCULUS_ORIGINS: [...ORIGINS].join(",") },
      admin: { origin: ADMIN, files },
      routes: [
        { method: "GET", path: "/api/thing", handler: () => ({ thing: true }) },
        { method: "POST", path: "/api/thing", handler: () => ({ made: true }) },
      ],
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const on = (host: string, method: "GET" | "POST", url: string, origin?: string) =>
    app.inject({
      method,
      url,
      headers: {
        host,
        "x-forwarded-proto": "https",
        ...(origin === undefined ? {} : { origin, "content-type": "application/json" }),
      },
      ...(method === "POST" ? { payload: "{}" } : {}),
    });

  it("answers the admin's host", async () => {
    // inject speaks http; the admin origin is https, so compare as the server sees it.
    const local = await buildServer({
      env: { OCULUS_ORIGINS: "http://localhost,http://127.0.0.1" },
      admin: { origin: "http://localhost", files },
      routes: [{ method: "GET", path: "/api/thing", handler: () => ({ thing: true }) }],
    });
    try {
      const ok = await local.inject({
        method: "GET",
        url: "/api/thing",
        headers: { host: "localhost" },
      });
      expect([ok.statusCode, ok.json()]).toEqual([200, { thing: true }]);
      const other = await local.inject({
        method: "GET",
        url: "/api/thing",
        headers: { host: "127.0.0.1" },
      });
      expect([other.statusCode, other.json()]).toEqual([404, { error: "not_found" }]);
    } finally {
      await local.close();
    }
  });

  it("any other host gets the unknown path's reply, for every method, before the route runs", async () => {
    const unknown = await on("archive.example.org", "GET", "/no-such-path");
    for (const [host, method, url, origin] of [
      ["archive.example.org", "GET", "/api/thing"],
      ["www.archive.example.org", "GET", "/api/thing"],
      ["unlisted.example.net", "GET", "/api/thing"],
      ["archive.example.org", "POST", "/api/thing", ARCHIVE],
      ["archive.example.org", "GET", "/api/no-such-route"],
      ["archive.example.org", "GET", "/api"],
    ] as const) {
      const reply = await on(host, method, url, origin);
      expect([host, url, reply.statusCode, reply.body]).toEqual([host, url, 404, unknown.body]);
      expect(reply.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("answers an https admin host behind a trusted proxy", async () => {
    const proxied = await buildServer({
      env: { OCULUS_ORIGINS: [...ORIGINS].join(","), OCULUS_TRUSTED_PROXY: "loopback" },
      admin: { origin: ADMIN, files },
      routes: [{ method: "GET", path: "/api/thing", handler: () => ({ thing: true }) }],
    });
    try {
      const via = (host: string) =>
        proxied.inject({
          method: "GET",
          url: "/api/thing",
          remoteAddress: "127.0.0.1",
          headers: { host: "127.0.0.1", "x-forwarded-host": host, "x-forwarded-proto": "https" },
        });
      const ok = await via("admin.example.org");
      expect([ok.statusCode, ok.json()]).toEqual([200, { thing: true }]);
      const away = await via("archive.example.org");
      expect([away.statusCode, away.json()]).toEqual([404, { error: "not_found" }]);
    } finally {
      await proxied.close();
    }
  });

  it("/health still answers on every host", async () => {
    const reply = await on("archive.example.org", "GET", "/health");
    expect(reply.statusCode).toBe(200);
  });

  it("without an admin origin nothing changes (tests and development)", async () => {
    const plain = await buildServer({
      env: { OCULUS_ORIGINS: "http://localhost" },
      routes: [{ method: "GET", path: "/api/thing", handler: () => ({ thing: true }) }],
    });
    try {
      const reply = await plain.inject({
        method: "GET",
        url: "/api/thing",
        headers: { host: "anything.localhost" },
      });
      expect(reply.statusCode).toBe(200);
    } finally {
      await plain.close();
    }
  });
});

describe("OCULUS_PUBLIC_SITES", () => {
  const id = "4d6f5b1e-9c3a-4b7e-8f21-0a1b2c3d4e5f";
  it("maps listed origins to sites; none when unset", () => {
    expect(publicSitesFromEnv({}, ORIGINS, ADMIN)).toEqual([]);
    expect(
      publicSitesFromEnv(
        { OCULUS_PUBLIC_SITES: ` ${ARCHIVE}=${id} , ${WWW.toUpperCase()}=${id}` },
        ORIGINS,
        ADMIN,
      ),
    ).toEqual([
      { origin: ARCHIVE, siteId: id },
      { origin: WWW, siteId: id },
    ]);
  });

  it("refuses an unlisted origin, the admin's, one listed twice and a bad site ID", () => {
    const bad = (value: string) => () =>
      publicSitesFromEnv({ OCULUS_PUBLIC_SITES: value }, ORIGINS, ADMIN);
    expect(bad(`https://other.example.org=${id}`)).toThrow(/isn't one of OCULUS_ORIGINS/);
    expect(bad(`${ADMIN}=${id}`)).toThrow(/admin's host/);
    // Another port or scheme on the admin's host: the cookie would still reach it.
    const extra = new Set([...ORIGINS, "https://admin.example.org:8443"]);
    expect(() =>
      publicSitesFromEnv(
        { OCULUS_PUBLIC_SITES: `https://admin.example.org:8443=${id}` },
        extra,
        ADMIN,
      ),
    ).toThrow(/admin's host/);
    expect(bad(`${ARCHIVE}=${id},${ARCHIVE}=${id}`)).toThrow(/listed twice/);
    expect(bad(`${ARCHIVE}=not-a-site`)).toThrow(/site ID/);
    expect(bad(ARCHIVE)).toThrow(/<origin>=<site id>/);
    expect(bad(`${ARCHIVE}=${id.toUpperCase()}`)).toThrow(/site ID/);
  });
});

describe("startup", () => {
  it("in production, refuses to start without the admin's origin", async () => {
    await expect(start({ ...ENV, OCULUS_ADMIN_ORIGIN: undefined })).rejects.toThrow(
      /OCULUS_ADMIN_ORIGIN must name the admin's own origin/,
    );
    await expect(start({ ...ENV, OCULUS_ADMIN_ORIGIN: "" })).rejects.toThrow(/OCULUS_ADMIN_ORIGIN/);
  });

  it("refuses public sites without a public reader connection", async () => {
    await expect(start({ ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${site}` })).rejects.toThrow(
      /no public reader connection/,
    );
  });

  it("refuses a public connection that can read tables, naming problem codes only", async () => {
    const failure = await start({ ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${site}` }, owner).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/must connect as a public reader role/);
    expect(String(failure)).not.toContain(testDb.url);
  });

  it("refuses a reader of another database", async () => {
    const other = await freshDatabase();
    const url = new URL(other.url);
    const elsewhere = openDatabase(url.toString(), { max: 1 });
    try {
      await migrate({ connectionString: other.url });
      // The owner there can read tables, so it fails the role check first;
      // a reader role there is what this case is about.
      await elsewhere.transaction((q) => grantPublicReaderRole(q, readerRole));
      url.username = readerRole;
      const otherReader = openDatabase(url.toString(), { max: 1 });
      try {
        await expect(
          start({ ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${site}` }, otherReader),
        ).rejects.toThrow(/same database/);
      } finally {
        await otherReader.close();
      }
    } finally {
      await elsewhere.close();
      await other.drop();
    }
  });

  it("refuses a site ID that two organizations hold", async () => {
    const org2 = newOrganizationId();
    await insertOrganization(owner, { id: org2, name: "Invented Library" });
    const twin = newSiteId();
    const org1 = newOrganizationId();
    await insertOrganization(owner, { id: org1, name: "Invented Museum" });
    await insertSite(owner, { id: twin, organizationId: org1, name: "Invented one" });
    await insertSite(owner, { id: twin, organizationId: org2, name: "Invented two" });
    await expect(
      start({ ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${twin}` }, reader),
    ).rejects.toThrow(/more than one organization/);
  });

  it("refuses a site that doesn't exist", async () => {
    const missing = newSiteId();
    await expect(
      start({ ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${missing}` }, reader),
    ).rejects.toThrow(new RegExp(`there is no site ${missing}`));
  });

  it("starts with a public reader and existing sites, and the API stays on the admin's host", async () => {
    const app = await start(
      { ...ENV, OCULUS_PUBLIC_SITES: `${ARCHIVE}=${site},${WWW}=${site}` },
      reader,
    );
    try {
      const away = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { host: "archive.example.org", "x-forwarded-proto": "https" },
      });
      expect([away.statusCode, away.json()]).toEqual([404, { error: "not_found" }]);
    } finally {
      await app.close();
    }
  });
});
