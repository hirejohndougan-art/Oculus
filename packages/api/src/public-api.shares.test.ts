// Shared items on the public sites (T-041f, D-111): an item accepted into a
// site from another site, of the same organization or another, answers on
// that site's public host as its home site shows it, with `sharedFrom`
// naming its home; its URL is its home site's when that site has a public
// host. Offers not accepted, declined, withdrawn and removed shares, and
// items taken out of publication or moved onto the site answer exactly as
// an unknown record. Every person and record is invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newSiteId, type OrganizationId, type SiteId } from "@oculus/core";
import {
  checkPublicReaderConnection,
  grantPublicReaderRole,
  openDatabase,
  readSharedPublicRecord,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { testServerUrl } from "../../db/src/test-database.fixtures.js";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import { loadAdminFiles } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import { actorOf, makeObject, makeWorld, ok, publishAs, type World } from "./staff-api.fixtures.js";

const ADMIN = "http://localhost";
const PUBLIC = "http://127.0.0.1";
const PUBLIC2 = "http://[::1]";

let w: World;
let reader: Database;
let readerRole: string;
let app: FastifyInstance;
let dir: string;

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

const as = (organizationId: OrganizationId, siteId?: SiteId) => ({
  organizationId,
  actor: actorOf(w.root),
  ...(siteId === undefined ? {} : { siteId }),
});

/** A published object on `site`, offered to A1 (and accepted, unless `accept` is false). */
async function sharedIntoA1(
  org: OrganizationId,
  site: SiteId,
  title: string,
  accept = true,
): Promise<{ id: string; shareId: string }> {
  const made = await makeObject(w, org, site, title);
  await publishAs(w, org, made.id);
  const share = ok(
    await w.service.offerRecord(as(org, site), {
      recordId: made.id,
      targetOrganizationId: w.a,
      targetSiteId: w.a1,
    }),
  );
  if (accept) ok(await w.service.acceptShare(as(w.a, w.a1), share.id));
  return { id: made.id, shareId: share.id };
}

beforeAll(async () => {
  w = await makeWorld();
  readerRole = `oculus_t041f_reader_${newSiteId().slice(0, 8)}`;
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "CREATE ROLE %I LOGIN", readerRole));
  } finally {
    await server.close();
  }
  await w.db.transaction((q) => grantPublicReaderRole(q, readerRole));
  const url = new URL(w.testDb.url);
  url.username = readerRole;
  reader = openDatabase(url.toString(), { max: 2 });
  for (const org of [w.a, w.b]) {
    ok(
      await w.service.saveDublinCoreMapping(
        { organizationId: org, actor: actorOf(w.root) },
        "t-object",
        {
          entries: [
            { field: "rights", term: "rights" },
            { field: "note", term: "description" },
          ],
        },
        { expectedVersion: 0 },
      ),
    );
  }
  dir = mkdtempSync(join(tmpdir(), "oculus-t041f-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  mkdirSync(join(dir, "assets"));
  app = await buildAdminServer({
    db: w.db,
    publicDb: reader,
    env: {
      NODE_ENV: "development",
      OCULUS_ORIGINS: `${ADMIN},${PUBLIC},${PUBLIC2}`,
      OCULUS_ADMIN_ORIGIN: ADMIN,
      OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
      // A1 and A2 have public hosts; B1 (the library) has none on this server.
      OCULUS_PUBLIC_SITES: `${PUBLIC}=${w.a1},${PUBLIC2}=${w.a2}`,
    },
    adminFiles: loadAdminFiles(dir),
    log: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await reader.close();
  await w.db.close();
  await w.testDb.drop();
  const server = openDatabase(testServerUrl(), { max: 1 });
  try {
    await server.transaction((q) => withRole(q, "DROP ROLE IF EXISTS %I", readerRole));
  } finally {
    await server.close();
  }
});

const get = (host: string, url: string) => app.inject({ method: "GET", url, headers: { host } });

const unknownBody = async () => (await get("127.0.0.1", "/no-such-path")).body;

describe("items shared into a public site", () => {
  it("the public reader may call only its read path, the shared lookup included", async () => {
    expect(await checkPublicReaderConnection(reader)).toEqual([]);
  });

  it("shows another organization's accepted item as its home shows it, naming its home", async () => {
    const item = await sharedIntoA1(w.b, w.b1, "An invented shared library lantern");
    const reply = await get("127.0.0.1", `/records/${item.id}`);
    expect(reply.statusCode).toBe(200);
    const body = reply.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["dublinCore", "id", "jsonLd", "sharedFrom"]);
    expect(body.sharedFrom).toEqual({
      site: "Invented library site",
      organization: "Invented Library",
    });
    // The library site has no public host here, so the item's URL is this host's.
    expect(body.id).toBe(`${PUBLIC}/records/${item.id}`);
    expect(reply.body).toContain("An invented shared library lantern");
    expect(JSON.stringify(body.dublinCore)).toContain("Tin.");
    // Staff values and warnings never leave, and no ID of the home site or organization.
    expect(reply.body).not.toContain("Back room.");
    expect(reply.body).not.toContain("staffWarnings");
    expect(reply.body).not.toContain(w.b);
    expect(reply.body).not.toContain(w.b1);
    expect(reply.headers["cache-control"]).toBe("no-store");
    // The other public host (A2) wasn't offered it.
    const elsewhere = await get("[::1]", `/records/${item.id}`);
    expect([elsewhere.statusCode, elsewhere.body]).toEqual([404, await unknownBody()]);
  });

  it("uses the home site's public URL when it has one, and the home host shows it as its own", async () => {
    const item = await sharedIntoA1(w.a, w.a2, "An invented lantern shared from A2");
    const shared = await get("127.0.0.1", `/records/${item.id}`);
    expect(shared.statusCode).toBe(200);
    const body = shared.json<Record<string, unknown>>();
    expect(body.id).toBe(`${PUBLIC2}/records/${item.id}`);
    expect(body.sharedFrom).toEqual({
      site: "Invented second site",
      organization: "Invented Archive",
    });
    const home = await get("[::1]", `/records/${item.id}`);
    expect(home.statusCode).toBe(200);
    const own = home.json<Record<string, unknown>>();
    expect(Object.keys(own).sort()).toEqual(["dublinCore", "id", "jsonLd"]);
    // The same output, apart from where it says it comes from.
    expect({ ...body, sharedFrom: undefined }).toEqual({ ...own, sharedFrom: undefined });
  });

  it("offers not yet accepted, and declined ones, show nothing", async () => {
    const waiting = await sharedIntoA1(w.b, w.b1, "An invented lantern on offer", false);
    const declined = await sharedIntoA1(w.b, w.b1, "An invented declined lantern", false);
    ok(await w.service.declineShare(as(w.a, w.a1), declined.shareId));
    const unknown = await unknownBody();
    for (const id of [waiting.id, declined.id]) {
      const reply = await get("127.0.0.1", `/records/${id}`);
      expect([id, reply.statusCode, reply.body]).toEqual([id, 404, unknown]);
    }
  });

  it("ends when the home side withdraws the share or the second site removes it", async () => {
    const withdrawn = await sharedIntoA1(w.b, w.b1, "An invented withdrawn lantern");
    const removed = await sharedIntoA1(w.b, w.b1, "An invented removed lantern");
    for (const id of [withdrawn.id, removed.id]) {
      expect((await get("127.0.0.1", `/records/${id}`)).statusCode).toBe(200);
    }
    ok(await w.service.withdrawShare(as(w.b, w.b1), withdrawn.shareId));
    ok(await w.service.removeShare(as(w.a, w.a1), removed.shareId));
    const unknown = await unknownBody();
    for (const id of [withdrawn.id, removed.id]) {
      const reply = await get("127.0.0.1", `/records/${id}`);
      expect([id, reply.statusCode, reply.body]).toEqual([id, 404, unknown]);
    }
  });

  it("ends when the item is taken out of publication at home, and shows again when republished", async () => {
    const item = await sharedIntoA1(w.b, w.b1, "An invented lantern taken back");
    expect((await get("127.0.0.1", `/records/${item.id}`)).statusCode).toBe(200);
    const now = ok(await w.service.readRecord(as(w.b, w.b1), item.id as never));
    ok(await w.service.withdraw(as(w.b), item.id as never, { expectedVersion: now.version }));
    const reply = await get("127.0.0.1", `/records/${item.id}`);
    expect([reply.statusCode, reply.body]).toEqual([404, await unknownBody()]);
  });

  it("an item moved onto the site it was shared into is the site's own, never shown as shared", async () => {
    const item = await sharedIntoA1(w.a, w.a2, "An invented lantern moved onto A1");
    const now = ok(await w.service.readRecord(as(w.a, w.a2), item.id as never));
    ok(
      await w.service.updateRecord(
        as(w.a, w.a2),
        item.id as never,
        { ...now.record, siteId: w.a1 },
        { expectedVersion: now.version },
      ),
    );
    const reply = await get("127.0.0.1", `/records/${item.id}`);
    expect(reply.body).not.toContain("sharedFrom");
    const direct = await readSharedPublicRecord(reader, w.a, w.a1, item.id as never, {
      baseUrlFor: () => `${PUBLIC}/records/`,
    });
    expect(direct.ok ? [] : direct.issues.map((i) => i.code)).toEqual(["not_available"]);
  });

  it("answers not_available, the same for every case, from the database read itself", async () => {
    const item = await sharedIntoA1(w.b, w.b1, "An invented lantern for the direct read");
    const read = (org: OrganizationId, site: SiteId, id: string) =>
      readSharedPublicRecord(reader, org, site, id as never, {
        baseUrlFor: () => `${PUBLIC}/records/`,
      });
    const good = await read(w.a, w.a1, item.id);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.home).toEqual({
        organizationId: w.b,
        siteId: w.b1,
        organizationName: "Invented Library",
        siteName: "Invented library site",
      });
    }
    const refusals = await Promise.all([
      read(w.a, w.a2, item.id), // not shared into A2
      read(w.b, w.a1, item.id), // A1 under the wrong organization
      read(w.b, w.b1, item.id), // its own home: read as its own, not as shared
      read(w.a, w.a1, newSiteId()), // no such record
      read(w.a, w.a1, "not-an-id"),
    ]);
    for (const r of refusals) {
      expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["not_available"]);
    }
  });
});
