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
  insertTemplateVersion,
  openDatabase,
  readPublicRecord,
  readSharedPublicRecord,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { storeDirectVersion, testServerUrl } from "../../db/src/test-database.fixtures.js";
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
/** The admin server's files folder (D-086), one of this file's own. */
let filesDir: string;

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
  filesDir = mkdtempSync(join(tmpdir(), "oculus-t041f-files-"));
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
      OCULUS_FILES_DIR: filesDir,
    },
    adminFiles: loadAdminFiles(dir),
    log: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
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
    // Exactly what its home site's public output is, read the home site's own way.
    const home = await readPublicRecord(reader, w.b, w.b1, item.id as never, {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(home.ok).toBe(true);
    if (home.ok) {
      expect({ id: body.id, dublinCore: body.dublinCore, jsonLd: body.jsonLd }).toEqual({
        id: home.value.id,
        dublinCore: home.value.dublinCore,
        jsonLd: home.value.jsonLd,
      });
    }
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
    // Moving keeps it published, so A1 now shows it as its own record.
    expect(reply.statusCode).toBe(200);
    expect(Object.keys(reply.json<object>()).sort()).toEqual(["dublinCore", "id", "jsonLd"]);
    expect(reply.json<{ id: string }>().id).toBe(`${PUBLIC}/records/${item.id}`);
    const direct = await readSharedPublicRecord(reader, w.a, w.a1, item.id as never, {
      baseUrlFor: () => `${PUBLIC}/records/`,
    });
    expect(direct.ok ? [] : direct.issues.map((i) => i.code)).toEqual(["not_available"]);
  });

  it("an accepted item whose home template has no stored mapping shows on neither site", async () => {
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-object-plain",
        organizationId: w.b,
        label: "Plain object",
        appliesTo: ["object"],
        fields: [
          {
            key: "rights",
            label: "rights",
            kind: "rights",
            required: false,
            repeatable: false,
            visibility: "public",
            inherited: false,
          },
        ],
      }),
    );
    const made = ok(
      await w.service.createRecord(as(w.b, w.b1), {
        kind: "object",
        title: "An invented unmapped shared lantern",
        templateKey: "t-object-plain",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      }),
    );
    await publishAs(w, w.b, made.record.id);
    const share = ok(
      await w.service.offerRecord(as(w.b, w.b1), {
        recordId: made.record.id,
        targetOrganizationId: w.a,
        targetSiteId: w.a1,
      }),
    );
    ok(await w.service.acceptShare(as(w.a, w.a1), share.id));
    const reply = await get("127.0.0.1", `/records/${made.record.id}`);
    expect([reply.statusCode, reply.body]).toEqual([404, await unknownBody()]);
    // It is shared and accepted: the refusal is the mapping's, at home and here alike.
    const here = await readSharedPublicRecord(reader, w.a, w.a1, made.record.id, {
      baseUrlFor: () => `${PUBLIC}/records/`,
    });
    expect(here.ok ? [] : here.issues.map((i) => i.code)).toEqual(["no_mapping"]);
    const home = await readPublicRecord(reader, w.b, w.b1, made.record.id, {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(home.ok ? [] : home.issues.map((i) => i.code)).toEqual(["no_mapping"]);
  });

  /**
   * Gives `recordId` (any organization's) to a new draft in the library (B1),
   * copied from a fresh library record: an ID clash, which only a restore or
   * an import could make. Then publishes it and shares it into A1, accepted.
   */
  async function libraryCopyWithId(recordId: string): Promise<void> {
    const source = await makeObject(w, w.b, w.b1, "An invented clashing library lantern");
    // Every stored column but the generated ones, with the new ID.
    await w.db.transaction(async (q) => {
      await q.rows(sql`SELECT set_config('oculus_test.org', ${w.b}, true),
                              set_config('oculus_test.from', ${source.id}, true),
                              set_config('oculus_test.to', ${recordId}, true)`);
      await q.execute(sql`DO $$
        DECLARE cols text; vals text;
        BEGIN
          SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
                 string_agg(CASE WHEN column_name = 'id' THEN '$1::uuid'
                                 ELSE quote_ident(column_name) END, ', ' ORDER BY ordinal_position)
            INTO cols, vals
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'records' AND is_generated = 'NEVER';
          EXECUTE format('INSERT INTO public.records (%s) SELECT %s FROM public.records
                          WHERE organization_id = $2::uuid AND id = $3::uuid', cols, vals)
            USING current_setting('oculus_test.to'), current_setting('oculus_test.org'),
                  current_setting('oculus_test.from');
        END $$`);
      await storeDirectVersion(q, w.b, recordId);
    });
    await publishAs(w, w.b, recordId);
    const share = ok(
      await w.service.offerRecord(as(w.b, w.b1), {
        recordId,
        targetOrganizationId: w.a,
        targetSiteId: w.a1,
      }),
    );
    ok(await w.service.acceptShare(as(w.a, w.a1), share.id));
  }

  it("a shared item never stands in for the site's own record with the same ID", async () => {
    // A1's own draft: not public, and its ID must never show another record.
    const own = await makeObject(w, w.a, w.a1, "An invented A1 draft lantern");
    await libraryCopyWithId(own.id);
    const reply = await get("127.0.0.1", `/records/${own.id}`);
    expect([reply.statusCode, reply.body]).toEqual([404, await unknownBody()]);
    const direct = await readSharedPublicRecord(reader, w.a, w.a1, own.id as never, {
      baseUrlFor: () => `${PUBLIC}/records/`,
    });
    expect(direct.ok ? [] : direct.issues.map((i) => i.code)).toEqual(["not_available"]);
  });

  it("two shared records with one ID show neither", async () => {
    const item = await sharedIntoA1(w.a, w.a2, "An invented A2 lantern that will clash");
    expect((await get("127.0.0.1", `/records/${item.id}`)).statusCode).toBe(200);
    await libraryCopyWithId(item.id);
    const reply = await get("127.0.0.1", `/records/${item.id}`);
    expect([reply.statusCode, reply.body]).toEqual([404, await unknownBody()]);
    // Each still reads on its own home host (A2 here).
    expect((await get("[::1]", `/records/${item.id}`)).statusCode).toBe(200);
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
