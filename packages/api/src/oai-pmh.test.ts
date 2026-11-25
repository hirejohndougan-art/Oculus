// OAI-PMH (T-050c, D-105): `GET /oai` on a public host answers the six verbs
// with oai_dc for the site's public records only, read through the public
// reader; held-back, draft, other sites' and other organizations' records
// never appear, not even by ID; errors are OAI-PMH's own; the reply is
// `text/xml` only through `oaiPmhReply`, with nosniff and the sandboxing
// CSP. Every person and record is invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRecordId, newSiteId } from "@oculus/core";
import {
  grantPublicReaderRole,
  insertTemplateVersion,
  isDatabaseTimeout,
  listPublishedForOai,
  oaiRepository,
  oaiStoredStamp,
  openDatabase,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { testServerUrl } from "../../db/src/test-database.fixtures.js";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import { loadAdminFiles } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import { OAI_PMH_PROLOGUE, isFileReply, oaiPmhReply } from "./file-replies.js";
import {
  OAI_MAX_SLOTS,
  OAI_PAGE_SIZE,
  OAI_SKIP_AFTER_STRIKES,
  oaiAdminEmail,
  oaiPmhRoutes,
  oaiPoolOptions,
} from "./oai-pmh.js";
import {
  publicApiRoutes,
  ReadSlots,
  SLOW_READ_STRIKE_GAP_MS,
  slowKey,
  SlowReads,
} from "./public-api.js";
import { PublicSubjects } from "./public-subjects.js";
import { checkPublicSites, type PublicSite } from "./public-sites.js";
import { buildServer } from "./server.js";
import { actorOf, makeObject, makeWorld, ok, publishAs, type World } from "./staff-api.fixtures.js";

const ADMIN = "http://localhost";
const PUBLIC = "http://127.0.0.1";
const EMAIL = "archivist@example.org";
const PREFIX = "oai:127.0.0.1:";

let w: World;
let reader: Database;
let readerRole: string;
let app: FastifyInstance;
let dir: string;
let published: string;
let draft: string;
let otherSite: string;
let otherOrg: string;
let unmapped: string;
let stamps: PublicSubjects;
const more: string[] = [];

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

// The admin server needs a files folder (D-086); one of this file's own.
const filesDir = mkdtempSync(join(tmpdir(), "oculus-t050c-files-"));

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "development",
    OCULUS_ORIGINS: `${ADMIN},${PUBLIC}`,
    OCULUS_ADMIN_ORIGIN: ADMIN,
    OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
    OCULUS_PUBLIC_SITES: `${PUBLIC}=${w.a1}`,
    OCULUS_FILES_DIR: filesDir,
    ...extra,
  };
}

beforeAll(async () => {
  w = await makeWorld();
  readerRole = `oculus_t050c_reader_${newSiteId().slice(0, 8)}`;
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
  published = (await makeObject(w, w.a, w.a1, "An invented harvested lantern")).id;
  await publishAs(w, w.a, published);
  draft = (await makeObject(w, w.a, w.a1, "An invented draft lantern")).id;
  otherSite = (await makeObject(w, w.a, w.a2, "An invented lantern on A2")).id;
  await publishAs(w, w.a, otherSite);
  otherOrg = (await makeObject(w, w.b, w.b1, "An invented library lantern")).id;
  await publishAs(w, w.b, otherOrg);
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-object-plain",
      organizationId: w.a,
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
  // Published, but held back: its template has no stored mapping.
  const plain = ok(
    await w.service.createRecord(
      { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 },
      {
        kind: "object",
        title: "An invented unmapped lantern",
        templateKey: "t-object-plain",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      },
    ),
  );
  unmapped = plain.record.id;
  await publishAs(w, w.a, unmapped);
  // Enough for two pages.
  for (let i = 0; i < OAI_PAGE_SIZE + 3; i++) {
    const id = (await makeObject(w, w.a, w.a1, `An invented harvested lamp ${String(i)}`)).id;
    await publishAs(w, w.a, id);
    more.push(id);
  }

  dir = mkdtempSync(join(tmpdir(), "oculus-t050c-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  mkdirSync(join(dir, "assets"));
  // The route as buildAdminServer mounts it, with a brake loose enough for these tests.
  const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
  app = await buildServer({
    env: { OCULUS_ORIGINS: `${ADMIN},${PUBLIC}` },
    routes: oaiPmhRoutes({
      db: w.db,
      publicDb: reader,
      sites,
      adminEmail: EMAIL,
      rateLimits: { oai: 10_000 },
    }),
  });
  // The background pass that stores the datestamps (S-041), as admin-server runs it.
  stamps = new PublicSubjects({ db: w.db, sites, oaiStamps: true, minGapMs: 0 });
  await stamps.check();
}, 240_000);

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

const oai = (query: string, host = "127.0.0.1", server = app) =>
  server.inject({
    method: "GET",
    url: `/oai${query === "" ? "" : `?${query}`}`,
    headers: { host },
  });

const errorCode = (body: string): string | undefined =>
  /<error code="([A-Za-z]+)">/.exec(body)?.[1];
const identifiers = (body: string): string[] =>
  [...body.matchAll(/<identifier>([^<]*)<\/identifier>/g)].map((m) => m[1] ?? "");
const tokenIn = (body: string): string | undefined =>
  /<resumptionToken>([^<]+)<\/resumptionToken>/.exec(body)?.[1];

describe("GET /oai on a public host", () => {
  it("Identify: the site, the admin email and OAI-PMH's choices, as text/xml with the file headers", async () => {
    const reply = await oai("verb=Identify");
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/xml; charset=utf-8");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-security-policy"]).toContain("sandbox");
    expect(reply.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(reply.headers["content-disposition"]).toBeUndefined();
    expect(reply.body.startsWith(OAI_PMH_PROLOGUE)).toBe(true);
    expect(reply.body).toContain('<request verb="Identify">http://127.0.0.1/oai</request>');
    expect(reply.body).toContain("<repositoryName>Invented archive site</repositoryName>");
    expect(reply.body).toContain(`<adminEmail>${EMAIL}</adminEmail>`);
    expect(reply.body).toContain("<deletedRecord>transient</deletedRecord>");
    expect(reply.body).toContain("<granularity>YYYY-MM-DDThh:mm:ssZ</granularity>");
    expect(reply.body).toMatch(
      /<earliestDatestamp>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/earliestDatestamp>/,
    );
    expect(reply.body).toMatch(/<responseDate>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/responseDate>/);
    expect(reply.body.trimEnd().endsWith("</OAI-PMH>")).toBe(true);
  });

  it("ListMetadataFormats: oai_dc only; for a record that isn't public, idDoesNotExist", async () => {
    const all = await oai("verb=ListMetadataFormats");
    expect(all.body).toContain("<metadataPrefix>oai_dc</metadataPrefix>");
    expect(errorCode(all.body)).toBeUndefined();
    const one = await oai(`verb=ListMetadataFormats&identifier=${PREFIX}${published}`);
    expect(one.body).toContain("<metadataPrefix>oai_dc</metadataPrefix>");
    for (const id of [draft, unmapped, otherSite, otherOrg, newRecordId()]) {
      const reply = await oai(`verb=ListMetadataFormats&identifier=${PREFIX}${id}`);
      expect([id, errorCode(reply.body)]).toEqual([id, "idDoesNotExist"]);
    }
  });

  it("GetRecord: a public record's oai_dc; everything else idDoesNotExist", async () => {
    const reply = await oai(
      `verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${published}`,
    );
    expect(errorCode(reply.body)).toBeUndefined();
    expect(reply.body).toContain(`<identifier>${PREFIX}${published}</identifier>`);
    expect(reply.body).toMatch(/<datestamp>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/datestamp>/);
    expect(reply.body).toContain("<metadata>\n<oai_dc:dc ");
    expect(reply.body).toContain("<dc:title>An invented harvested lantern</dc:title>");
    expect(reply.body).not.toContain("Back room.");
    expect(reply.body).not.toContain("staffWarnings");
    // One XML declaration only: core's is dropped.
    expect(reply.body.split("<?xml").length).toBe(2);
    for (const id of [draft, unmapped, otherSite, otherOrg, newRecordId()]) {
      const r = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${id}`);
      expect([id, errorCode(r.body)]).toEqual([id, "idDoesNotExist"]);
      expect(r.body).not.toContain("invented");
    }
    for (const identifier of [
      `oai:localhost:${published}`,
      `oai:127.0.0.1:${published.toUpperCase()}`,
      published,
      `${PREFIX}${published}x`,
    ]) {
      const r = await oai(
        `verb=GetRecord&metadataPrefix=oai_dc&identifier=${encodeURIComponent(identifier)}`,
      );
      expect([identifier, errorCode(r.body)]).toEqual([identifier, "idDoesNotExist"]);
    }
    const format = await oai(`verb=GetRecord&metadataPrefix=marc&identifier=${PREFIX}${published}`);
    expect(errorCode(format.body)).toBe("cannotDisseminateFormat");
  });

  it("ListIdentifiers pages through the public records only, each once, then ends with an empty token", async () => {
    const seen: string[] = [];
    let reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc");
    let pages = 1;
    expect(identifiers(reply.body)).toHaveLength(OAI_PAGE_SIZE);
    expect(reply.body).not.toContain("<metadata>");
    seen.push(...identifiers(reply.body));
    let token = tokenIn(reply.body);
    while (token !== undefined) {
      reply = await oai(`verb=ListIdentifiers&resumptionToken=${token}`);
      expect(errorCode(reply.body)).toBeUndefined();
      seen.push(...identifiers(reply.body));
      token = tokenIn(reply.body);
      pages += 1;
      expect(pages).toBeLessThan(5);
    }
    expect(reply.body).toContain("<resumptionToken/>");
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([published, ...more].map((id) => `${PREFIX}${id}`).sort());
    // Datestamps come in order.
    const stamps = await listPublishedForOai(w.db, w.a, w.a1, { limit: 100 });
    expect(stamps.map((s) => s.stamp)).toEqual(stamps.map((s) => s.stamp).sort());
  });

  it("ListRecords: the same records with their oai_dc, and nothing held back", async () => {
    const reply = await oai("verb=ListRecords&metadataPrefix=oai_dc");
    expect(errorCode(reply.body)).toBeUndefined();
    expect(reply.body.split("<record>").length - 1).toBe(OAI_PAGE_SIZE);
    expect(reply.body).toContain(`<request verb="ListRecords" metadataPrefix="oai_dc">`);
    const rest = await oai(`verb=ListRecords&resumptionToken=${tokenIn(reply.body) ?? ""}`);
    const all = `${reply.body}${rest.body}`;
    for (const id of [draft, unmapped, otherSite, otherOrg]) expect(all).not.toContain(id);
    expect(all).not.toContain("unmapped");
    expect(all).not.toContain("draft lantern");
    expect(all).not.toContain("Back room.");
    expect(all).toContain("An invented harvested lantern");
  });

  it("from and until choose by datestamp, in either granularity", async () => {
    const future = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc&from=2999-01-01");
    expect(errorCode(future.body)).toBe("noRecordsMatch");
    const past = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc&until=1990-01-01T00:00:00Z");
    expect(errorCode(past.body)).toBe("noRecordsMatch");
    const today = new Date().toISOString().slice(0, 10);
    const window = await oai(
      `verb=ListIdentifiers&metadataPrefix=oai_dc&from=2000-01-01&until=${today}`,
    );
    expect(identifiers(window.body)).toHaveLength(OAI_PAGE_SIZE);
    // A token keeps its window.
    const token = tokenIn(window.body) ?? "";
    const next = await oai(`verb=ListIdentifiers&resumptionToken=${token}`);
    expect(identifiers(next.body).length).toBeGreaterThan(0);
  });

  it("seals its resumption tokens: no record ID or datestamp in them, and a changed one is refused", async () => {
    const reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc");
    const token = tokenIn(reply.body) ?? "";
    const raw = Buffer.from(token, "base64url").toString("latin1");
    for (const id of [published, draft, unmapped, ...more]) expect(raw).not.toContain(id);
    expect(raw).not.toMatch(/\d{4}-\d\d-\d\dT/);
    const flipped = `${token.slice(0, 20)}${token[20] === "A" ? "B" : "A"}${token.slice(21)}`;
    const refused = await oai(`verb=ListIdentifiers&resumptionToken=${flipped}`);
    expect(errorCode(refused.body)).toBe("badResumptionToken");
  });

  it("dates before year 1 are no bound for from, and leave nothing for until", async () => {
    for (const from of ["0000-01-01", "0000-01-01T00:00:00Z"]) {
      const reply = await oai(`verb=ListIdentifiers&metadataPrefix=oai_dc&from=${from}`);
      expect([from, reply.statusCode, identifiers(reply.body).length]).toEqual([
        from,
        200,
        OAI_PAGE_SIZE,
      ]);
    }
    const until = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc&until=0000-01-01");
    expect([until.statusCode, errorCode(until.body)]).toEqual([200, "noRecordsMatch"]);
  });

  it("a far-future until is no bound at all", async () => {
    for (const until of ["9999-12-31", "9999-12-31T23:59:59Z"]) {
      const reply = await oai(`verb=ListIdentifiers&metadataPrefix=oai_dc&until=${until}`);
      expect([until, reply.statusCode, identifiers(reply.body).length]).toEqual([
        until,
        200,
        OAI_PAGE_SIZE,
      ]);
    }
  });

  it("answers bad requests with OAI-PMH's errors, echoing arguments only when allowed", async () => {
    const cases: [string, string, boolean][] = [
      ["", "badVerb", false],
      ["verb=Explode", "badVerb", false],
      ["verb=Identify&verb=Identify", "badVerb", false],
      ["verb=Identify&extra=1", "badArgument", false],
      ["verb=ListRecords", "badArgument", false],
      ["verb=GetRecord&metadataPrefix=oai_dc", "badArgument", false],
      ["verb=ListRecords&metadataPrefix=oai_dc&metadataPrefix=oai_dc", "badArgument", false],
      ["verb=ListRecords&metadataPrefix=oai_dc&from=2026-02-30", "badArgument", true],
      ["verb=ListRecords&metadataPrefix=oai_dc&from=2026-01-01T00:00:00", "badArgument", true],
      [
        "verb=ListRecords&metadataPrefix=oai_dc&from=2026-01-02&until=2026-01-01",
        "badArgument",
        true,
      ],
      [
        "verb=ListRecords&metadataPrefix=oai_dc&from=2026-01-01&until=2026-01-02T00:00:00Z",
        "badArgument",
        true,
      ],
      ["verb=ListRecords&metadataPrefix=oai_dc&resumptionToken=abc", "badArgument", false],
      ["verb=ListRecords&metadataPrefix=oai_dc&set=photos", "noSetHierarchy", true],
      ["verb=ListRecords&metadataPrefix=marc", "cannotDisseminateFormat", true],
      ["verb=ListSets", "noSetHierarchy", true],
      ["verb=ListSets&resumptionToken=abc", "badResumptionToken", true],
      ["verb=ListRecords&resumptionToken=abc", "badResumptionToken", true],
      ["verb=ListRecords&resumptionToken=W10", "badResumptionToken", true],
      [
        `verb=ListRecords&resumptionToken=${Buffer.from('["","","2026-01-01T00:00:00.000Z","x"]').toString("base64url")}`,
        "badResumptionToken",
        true,
      ],
    ];
    for (const [query, code, echo] of cases) {
      const reply = await oai(query);
      expect([query, reply.statusCode, errorCode(reply.body)]).toEqual([query, 200, code]);
      expect([query, reply.body.includes("<request>http://127.0.0.1/oai</request>")]).toEqual([
        query,
        !echo,
      ]);
    }
  });

  it("escapes what it echoes, and refuses what XML can't hold", async () => {
    const hostile = 'x"><evil a="&';
    const reply = await oai(
      `verb=GetRecord&metadataPrefix=oai_dc&identifier=${encodeURIComponent(hostile)}`,
    );
    expect(errorCode(reply.body)).toBe("idDoesNotExist");
    expect(reply.body).toContain('identifier="x&quot;&gt;&lt;evil a=&quot;&amp;"');
    expect(reply.body).not.toContain("<evil");
    const control = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=a%01b`);
    expect(errorCode(control.body)).toBe("badArgument");
  });

  it("is the unknown path's 404 on the admin's and unlisted hosts, and only GET", async () => {
    for (const host of ["localhost", "unlisted.example.org"]) {
      const reply = await oai("verb=Identify", host);
      expect([host, reply.statusCode, reply.json()]).toEqual([host, 404, { error: "not_found" }]);
    }
    const post = await app.inject({
      method: "POST",
      url: "/oai",
      headers: {
        host: "127.0.0.1",
        origin: PUBLIC,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "verb=Identify",
    });
    expect([405, 415]).toContain(post.statusCode);
    expect(post.body).not.toContain("OAI-PMH");
  });

  it("buildAdminServer mounts it with OCULUS_OAI_ADMIN_EMAIL only, and refuses a malformed one", async () => {
    // Without the background counts' pool the lists would stay empty: refused.
    await expect(
      buildAdminServer({
        db: w.db,
        publicDb: reader,
        env: envFor({ OCULUS_OAI_ADMIN_EMAIL: EMAIL }),
        adminFiles: loadAdminFiles(dir),
        log: () => undefined,
      }),
    ).rejects.toThrow(/countsDb/);
    const counts = openDatabase(w.testDb.url, { max: 1 });
    const mounted = await buildAdminServer({
      db: w.db,
      publicDb: reader,
      countsDb: counts,
      env: envFor({ OCULUS_OAI_ADMIN_EMAIL: EMAIL }),
      adminFiles: loadAdminFiles(dir),
      log: () => undefined,
    });
    try {
      const reply = await oai("verb=Identify", "127.0.0.1", mounted);
      expect([reply.statusCode, reply.headers["content-type"]]).toEqual([
        200,
        "text/xml; charset=utf-8",
      ]);
      expect((await oai("verb=Identify", "localhost", mounted)).statusCode).toBe(404);
    } finally {
      await mounted.close();
      await counts.close();
    }
    const plain = await buildAdminServer({
      db: w.db,
      publicDb: reader,
      env: envFor(),
      adminFiles: loadAdminFiles(dir),
      log: () => undefined,
    });
    try {
      expect((await oai("verb=Identify", "127.0.0.1", plain)).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
    await expect(
      buildAdminServer({
        db: w.db,
        publicDb: reader,
        env: envFor({ OCULUS_OAI_ADMIN_EMAIL: "<a@b.org>" }),
        adminFiles: loadAdminFiles(dir),
        log: () => undefined,
      }),
    ).rejects.toThrow(/OCULUS_OAI_ADMIN_EMAIL/);
    expect(oaiAdminEmail(undefined)).toBeUndefined();
    expect(oaiAdminEmail(EMAIL)).toBe(EMAIL);
    expect(() => oaiAdminEmail("two@example.org,three@example.org")).toThrow();
  });

  it("pages each record once after a mapping saved later gives them all one datestamp", async () => {
    ok(
      await w.service.saveDublinCoreMapping(
        { organizationId: w.a, actor: actorOf(w.root) },
        "t-object",
        {
          entries: [
            { field: "rights", term: "rights" },
            { field: "note", term: "description" },
          ],
        },
        { expectedVersion: 1 },
      ),
    );
    const seen: string[] = [];
    let reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc");
    seen.push(...identifiers(reply.body));
    let token = tokenIn(reply.body);
    for (let pages = 1; token !== undefined; pages++) {
      expect(pages).toBeLessThan(5);
      reply = await oai(`verb=ListIdentifiers&resumptionToken=${token}`);
      seen.push(...identifiers(reply.body));
      token = tokenIn(reply.body);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([published, ...more].map((id) => `${PREFIX}${id}`).sort());
  });

  it("brakes a client per minute and refuses at once when the public pool is busy", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    let now = 1_000_000;
    const slots = new ReadSlots(1);
    const braked = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: reader,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 2 },
        clock: () => now,
        slots,
      }),
    });
    try {
      expect((await oai("verb=Identify", "127.0.0.1", braked)).statusCode).toBe(200);
      // Every slot in use (say, by GET /records/:id): refused at once.
      expect(slots.take()).toBe(true);
      const busy = await oai("verb=Identify", "127.0.0.1", braked);
      expect([busy.statusCode, busy.headers["retry-after"], busy.json()]).toEqual([
        503,
        "5",
        { error: "busy" },
      ]);
      slots.give();
      const limited = await oai("verb=Identify", "127.0.0.1", braked);
      expect([limited.statusCode, limited.headers["retry-after"]]).toEqual([429, "60"]);
      now += 61_000;
      expect((await oai("verb=Identify", "127.0.0.1", braked)).statusCode).toBe(200);
    } finally {
      await braked.close();
    }
  });
});

describe("stored datestamps (S-041, D-108)", () => {
  const storedStamps = async () =>
    new Map(
      (
        await w.db.rows<{ id: string; stamp: string; deleted: boolean }>(sql`
          SELECT record_id::text AS id, stamp::text AS stamp, deleted FROM public.oai_datestamps
          WHERE organization_id = ${w.a}::uuid AND site_id = ${w.a1}::uuid`)
      ).map((r) => [r.id, r]),
    );

  it("stores a row only for records the site showed", async () => {
    const rows = await storedStamps();
    expect(rows.has(published)).toBe(true);
    for (const id of [draft, unmapped, otherSite, otherOrg]) expect(rows.has(id)).toBe(false);
  });

  it("a pass after a change that doesn't alter a record's oai_dc keeps its datestamp", async () => {
    const before = await storedStamps();
    await makeObject(w, w.a, w.a1, "An invented draft that changes nothing public");
    await stamps.check();
    const after = await storedStamps();
    expect(after.get(published)?.stamp).toBe(before.get(published)?.stamp);
  });

  it("a change to what the public sees moves every affected record's datestamp", async () => {
    const before = await storedStamps();
    // The template's mapping no longer shows the note: every object's oai_dc changes.
    ok(
      await w.service.saveDublinCoreMapping(
        { organizationId: w.a, actor: actorOf(w.root) },
        "t-object",
        { entries: [{ field: "rights", term: "rights" }] },
        { expectedVersion: 2, confirmPublished: true },
      ),
    );
    await stamps.check();
    const after = await storedStamps();
    expect(after.get(published)?.stamp).not.toBe(before.get(published)?.stamp);
  });

  it("a record that stops being shown gets a deleted header, in lists and GetRecord", async () => {
    const gone = more[0] ?? "";
    ok(
      await w.service.withdraw({ organizationId: w.a, actor: actorOf(w.root) }, gone as never, {
        expectedVersion: 2,
      }),
    );
    await stamps.check();
    const get = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${gone}`);
    expect(get.body).toContain(
      `<header status="deleted"><identifier>${PREFIX}${gone}</identifier>`,
    );
    expect(get.body).not.toContain("<metadata>");
    let all = "";
    let reply = await oai("verb=ListRecords&metadataPrefix=oai_dc");
    all += reply.body;
    let token = tokenIn(reply.body);
    while (token !== undefined) {
      reply = await oai(`verb=ListRecords&resumptionToken=${token}`);
      all += reply.body;
      token = tokenIn(reply.body);
    }
    expect(all).toContain(`<header status="deleted"><identifier>${PREFIX}${gone}</identifier>`);
    // A record never shown is still unknown, never "deleted".
    const never = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${draft}`);
    expect(errorCode(never.body)).toBe("idDoesNotExist");
    // Marked records are still known to ListMetadataFormats, and a `from`
    // after the mark leaves it out.
    const formats = await oai(`verb=ListMetadataFormats&identifier=${PREFIX}${gone}`);
    expect(errorCode(formats.body)).toBeUndefined();
    const later = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc&from=2999-01-01");
    expect(errorCode(later.body)).toBe("noRecordsMatch");
  });

  it("a record shown again loses its mark and gets a later datestamp", async () => {
    const back = more[0] ?? "";
    const before = (await storedStamps()).get(back);
    expect(before?.deleted).toBe(true);
    await publishAs(w, w.a, back, 3);
    await stamps.check();
    const after = (await storedStamps()).get(back);
    expect(after?.deleted).toBe(false);
    expect(Date.parse(after?.stamp ?? "")).toBeGreaterThan(Date.parse(before?.stamp ?? ""));
    const get = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${back}`);
    expect(get.body).toContain("<metadata>");
    expect(get.body).not.toContain('status="deleted"');
  });

  it("a record no longer shown is skipped until the pass marks it, and one restored first keeps its datestamp (S-047)", async () => {
    const quiet = more[1] ?? "";
    const before = (await storedStamps()).get(quiet);
    ok(
      await w.service.withdraw({ organizationId: w.a, actor: actorOf(w.root) }, quiet as never, {
        expectedVersion: 2,
      }),
    );
    // No pass yet: skipped, never a deleted header at its old datestamp.
    const listAll = async () => {
      let all = "";
      let reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc");
      all += reply.body;
      let token = tokenIn(reply.body);
      while (token !== undefined) {
        reply = await oai(`verb=ListIdentifiers&resumptionToken=${token}`);
        all += reply.body;
        token = tokenIn(reply.body);
      }
      return all;
    };
    expect(await listAll()).not.toContain(quiet);
    const get = await oai(`verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${quiet}`);
    expect(errorCode(get.body)).toBe("idDoesNotExist");
    // Restored before the next pass: shown again, same oai_dc, same datestamp,
    // and no harvester was ever told it was deleted.
    await publishAs(w, w.a, quiet, 3);
    await stamps.check();
    const after = (await storedStamps()).get(quiet);
    expect(after).toEqual(before);
    expect(await listAll()).toContain(`<identifier>${PREFIX}${quiet}</identifier>`);
  });

  it("before a site's first pass, GetRecord gives the site's lower bound, never a staff save time (S-046)", async () => {
    const second = "http://127.0.0.1:8081";
    const sites = await checkPublicSites(w.db, reader, [{ origin: second, siteId: w.a2 }]);
    const fresh = await buildServer({
      env: { OCULUS_ORIGINS: second },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: reader,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
      }),
    });
    try {
      const identify = await oai("verb=Identify", "127.0.0.1:8081", fresh);
      const earliest = /<earliestDatestamp>([^<]+)</.exec(identify.body)?.[1];
      const get = await oai(
        `verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:127.0.0.1:${otherSite}`,
        "127.0.0.1:8081",
        fresh,
      );
      expect(get.body).toContain("<metadata>");
      expect(earliest).toBeDefined();
      expect(get.body).toContain(`<datestamp>${earliest ?? ""}</datestamp>`);
      // Its lists are empty until the pass.
      const list = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1:8081", fresh);
      expect(errorCode(list.body)).toBe("noRecordsMatch");
    } finally {
      await fresh.close();
    }
  });

  it("list reads take a bounded time limit, and OAI-PMH's own pool waits a bounded time (S-051)", async () => {
    await expect(
      listPublishedForOai(w.db, w.a, w.a1, { limit: 5, timeLimitMs: 0 }),
    ).rejects.toThrow(TypeError);
    await expect(
      listPublishedForOai(w.db, w.a, w.a1, { limit: 5, timeLimitMs: 600_000 }),
    ).rejects.toThrow(TypeError);
    expect(
      (await listPublishedForOai(w.db, w.a, w.a1, { limit: 5, timeLimitMs: 2000 })).length,
    ).toBe(5);
    const pool = oaiPoolOptions();
    expect(pool.max).toBe(OAI_MAX_SLOTS);
    expect(pool.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(pool.queryTimeoutMillis).toBeGreaterThan(60_000);
  });
});

describe("oaiPmhReply", () => {
  const good = `${OAI_PMH_PROLOGUE}>\n<responseDate>2026-11-25T00:00:00Z</responseDate>\n</OAI-PMH>\n`;

  it("sends an OAI-PMH document as text/xml, and refuses anything else", () => {
    const reply = oaiPmhReply(good);
    expect(isFileReply(reply)).toBe(true);
    expect(reply.headers["content-type"]).toBe("text/xml; charset=utf-8");
    for (const bad of [
      "<html><script>alert(1)</script></html>",
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      good.replace("<responseDate>", '<?xml-stylesheet href="x.xsl"?><responseDate>'),
      good.replace("<responseDate>", "<!DOCTYPE x><responseDate>"),
      good.replace("<responseDate>", "<![CDATA[x]]><responseDate>"),
      good.replace("<responseDate>", "<!-- x --><responseDate>"),
      `${good}<html></html>`,
      good.replace(/<\/OAI-PMH>\n$/, ""),
    ]) {
      expect(() => oaiPmhReply(bad)).toThrow();
    }
  });

  it("a GetRecord stalled past its time limit is 503 busy with Retry-After (S-037)", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const logged: unknown[] = [];
    const limited = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: reader,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        timeLimitMs: 200,
        log: (r) => logged.push(r),
      }),
    });
    // Something holds the records table, so a public snapshot would wait as long as it is held.
    const owner = openDatabase(w.testDb.url, { max: 1 });
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = owner.transaction(async (q) => {
      await q.execute(sql`LOCK TABLE public.records IN ACCESS EXCLUSIVE MODE`);
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const query = `verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${published}`;
    try {
      await holding;
      const reply = await oai(query, "127.0.0.1", limited);
      expect(reply.statusCode).toBe(503);
      expect(reply.headers["retry-after"]).toBe("5");
      expect(reply.json()).toEqual({ error: "busy" });
      expect(logged).toEqual([{ event: "service_error", operation: "oaiPmh", name: "timeout" }]);
    } finally {
      release();
      await held;
      await owner.close();
    }
    try {
      // The slots were given back and the lock is gone: the same request works.
      const again = await oai(query, "127.0.0.1", limited);
      expect(again.statusCode).toBe(200);
      expect(errorCode(again.body)).toBeUndefined();
    } finally {
      await limited.close();
    }
  });

  it("a list page out of reading time ends early with a token, and the list is still whole (S-037)", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const hurried = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: reader,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        pageTimeLimitMs: 1,
      }),
    });
    try {
      const seen: string[] = [];
      let reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1", hurried);
      // A short page (at least one record is read per page, so the list moves on).
      expect(identifiers(reply.body).length).toBeLessThan(2);
      expect(tokenIn(reply.body)).toBeDefined();
      seen.push(...identifiers(reply.body));
      let token = tokenIn(reply.body);
      let pages = 1;
      while (token !== undefined) {
        reply = await oai(`verb=ListIdentifiers&resumptionToken=${token}`, "127.0.0.1", hurried);
        expect(errorCode(reply.body)).toBeUndefined();
        seen.push(...identifiers(reply.body));
        token = tokenIn(reply.body);
        pages += 1;
        expect(pages).toBeLessThan(100);
      }
      expect(pages).toBeGreaterThan(2);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([published, ...more].map((id) => `${PREFIX}${id}`).sort());
    } finally {
      await hurried.close();
    }
  });

  it("refuses time limits it couldn't use when the routes are built (S-037)", () => {
    const base = { db: w.db, publicDb: reader, sites: [], adminEmail: EMAIL };
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(() => oaiPmhRoutes({ ...base, timeLimitMs: bad })).toThrow(RangeError);
    }
    for (const bad of [0, 1.5, 120_001]) {
      expect(() => oaiPmhRoutes({ ...base, pageTimeLimitMs: bad })).toThrow(RangeError);
    }
    expect(() => oaiPmhRoutes({ ...base, timeLimitMs: 200, pageTimeLimitMs: 1 })).not.toThrow();
  });

  it("a read that runs out of time mid-page ends the page before it; the list stays whole (S-037)", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    // The public reader, but its 3rd and 30th reads are cancelled by the time limit.
    let reads = 0;
    const flaky: Database = {
      ...reader,
      transaction: (work) => {
        reads += 1;
        if (reads === 3 || reads === 30) {
          return Promise.reject(
            Object.assign(new Error("canceling statement due to statement timeout"), {
              code: "57014",
            }),
          );
        }
        return reader.transaction(work);
      },
    };
    const logged: unknown[] = [];
    const routes = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: flaky,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        log: (r) => logged.push(r),
      }),
    });
    try {
      const seen: string[] = [];
      let reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1", routes);
      // Two reads, then the third timed out: the page ends with a token.
      expect(reply.statusCode).toBe(200);
      expect(identifiers(reply.body).length).toBeLessThanOrEqual(2);
      expect(tokenIn(reply.body)).toBeDefined();
      seen.push(...identifiers(reply.body));
      let token = tokenIn(reply.body);
      let pages = 1;
      while (token !== undefined) {
        reply = await oai(`verb=ListIdentifiers&resumptionToken=${token}`, "127.0.0.1", routes);
        expect(reply.statusCode).toBe(200);
        expect(errorCode(reply.body)).toBeUndefined();
        seen.push(...identifiers(reply.body));
        token = tokenIn(reply.body);
        pages += 1;
        expect(pages).toBeLessThan(10);
      }
      expect(pages).toBeGreaterThan(2);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual([published, ...more].map((id) => `${PREFIX}${id}`).sort());
      // Handled inside the page: nothing was a failure.
      expect(logged).toEqual([]);
      // A page whose first read runs out of time is the request's 503 busy.
      reads = 29;
      const first = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1", routes);
      expect(first.statusCode).toBe(503);
      expect(first.json()).toEqual({ error: "busy" });
    } finally {
      await routes.close();
    }
  });
});

describe("the staff connection's time limits and the page clock (S-043a)", () => {
  /**
   * Holds `table` in ACCESS EXCLUSIVE mode from another connection, letting
   * go by itself after `giveUpMs` so a missing time limit fails the test
   * (an unbounded read just waits that long and succeeds) instead of hanging it.
   */
  async function hold(table: "sites" | "oai_datestamps", giveUpMs = 4_000) {
    const owner = openDatabase(w.testDb.url, { max: 1 });
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = owner.transaction(async (q) => {
      await q.execute(
        table === "sites"
          ? sql`LOCK TABLE public.sites IN ACCESS EXCLUSIVE MODE`
          : sql`LOCK TABLE public.oai_datestamps IN ACCESS EXCLUSIVE MODE`,
      );
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, giveUpMs);
      });
    });
    await holding;
    return {
      async end() {
        release();
        await held;
        await owner.close();
      },
    };
  }

  async function limitedServer(
    logged: unknown[],
    extra: { clock?: () => number; pageTimeLimitMs?: number } = {},
  ) {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    return buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: reader,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        timeLimitMs: 200,
        log: (r) => logged.push(r),
        ...extra,
      }),
    });
  }

  it("Identify with the staff database stalled is 503 busy within the time limit", async () => {
    const logged: unknown[] = [];
    const server = await limitedServer(logged);
    const lock = await hold("sites");
    try {
      const started = Date.now();
      const reply = await oai("verb=Identify", "127.0.0.1", server);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect([reply.statusCode, reply.headers["retry-after"], reply.json()]).toEqual([
        503,
        "5",
        { error: "busy" },
      ]);
      expect(logged).toEqual([{ event: "service_error", operation: "oaiPmh", name: "timeout" }]);
    } finally {
      await lock.end();
    }
    try {
      // The slots were given back: the same request works once the lock is gone.
      const again = await oai("verb=Identify", "127.0.0.1", server);
      expect(again.statusCode).toBe(200);
      expect(again.body).toContain("<Identify>");
    } finally {
      await server.close();
    }
  });

  it("GetRecord with the stored datestamps stalled is 503 busy within the time limit", async () => {
    const logged: unknown[] = [];
    const server = await limitedServer(logged);
    const query = `verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${published}`;
    const lock = await hold("oai_datestamps");
    try {
      const started = Date.now();
      const reply = await oai(query, "127.0.0.1", server);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect([reply.statusCode, reply.json()]).toEqual([503, { error: "busy" }]);
      expect(logged).toEqual([{ event: "service_error", operation: "oaiPmh", name: "timeout" }]);
    } finally {
      await lock.end();
    }
    try {
      const again = await oai(query, "127.0.0.1", server);
      expect(again.statusCode).toBe(200);
      expect(again.body).toContain("<metadata>");
    } finally {
      await server.close();
    }
  });

  it("the staff reads take only time limits they can use, and time out as timeouts", async () => {
    for (const bad of [0, -1, 1.5, 60_001, Number.NaN]) {
      await expect(oaiRepository(w.db, w.a, w.a1, { timeLimitMs: bad })).rejects.toThrow(
        RangeError,
      );
    }
    const lock = await hold("oai_datestamps");
    try {
      const thrown = await oaiStoredStamp(w.db, w.a, w.a1, published, { timeLimitMs: 100 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isDatabaseTimeout(thrown)).toBe(true);
    } finally {
      await lock.end();
    }
    expect((await oaiStoredStamp(w.db, w.a, w.a1, published))?.deleted).toBe(false);
  });

  it("a list page's reading time runs on the routes' clock", async () => {
    // A stopped clock: however long the reads take, the page is never out of time.
    const stopped = await limitedServer([], { clock: () => 5_000_000, pageTimeLimitMs: 1 });
    try {
      const reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1", stopped);
      expect(identifiers(reply.body)).toHaveLength(OAI_PAGE_SIZE);
    } finally {
      await stopped.close();
    }
    // A clock that jumps a minute at every look: out of time after the first read.
    let now = 5_000_000;
    const racing = await limitedServer([], {
      clock: () => (now += 60_000),
      pageTimeLimitMs: 120_000,
    });
    try {
      const reply = await oai("verb=ListIdentifiers&metadataPrefix=oai_dc", "127.0.0.1", racing);
      expect(identifiers(reply.body).length).toBeLessThanOrEqual(2);
      expect(tokenIn(reply.body)).toBeDefined();
    } finally {
      await racing.close();
    }
  });
});

describe("a record always slower than the public read limit (S-043b)", () => {
  function firstOf(sites: readonly PublicSite[]): PublicSite {
    const site = sites[0];
    if (site === undefined) throw new Error("no public site");
    return site;
  }

  /**
   * The public reader, but every read of `target` notes the time limits it
   * runs under and then fails as a statement past `statement_timeout`
   * would, while `failing` says so; every other read is the reader's own.
   */
  function slowFor(target: () => string, failing: () => boolean) {
    const limits: { statement: string; idle: string }[] = [];
    const db: Database = {
      ...reader,
      transaction: (work) =>
        reader.transaction((tx) =>
          work({
            rows: async (query) => {
              // Each read's first statement: the record's snapshot.
              if (
                query.text.includes("public_record_snapshot") &&
                query.values.includes(target())
              ) {
                const [now] = await tx.rows<{ statement: string; idle: string }>(sql`
                  SELECT pg_catalog.current_setting('statement_timeout') AS statement,
                         pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle`);
                if (now !== undefined) limits.push(now);
                if (failing()) {
                  throw Object.assign(new Error("canceling statement due to statement timeout"), {
                    code: "57014",
                  });
                }
              }
              return tx.rows(query);
            },
            execute: (query) => tx.execute(query),
          }),
        ),
    };
    return { db, limits };
  }

  it("is left out of the lists after its reads at the larger limit time out twice in a row, logged for staff", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const target = more[3] ?? "";
    const { db, limits } = slowFor(
      () => target,
      () => true,
    );
    const logged: { event: string; code?: string }[] = [];
    // Each request comes a strike's gap after the one before, so every
    // timeout at the larger limit can count.
    let now = 0;
    const slowReads = new SlowReads({ limitMs: 1_000, clock: () => now });
    const server = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: db,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        timeLimitMs: 200,
        slowReads,
        log: (r) => logged.push(r),
      }),
    });
    try {
      const seen: string[] = [];
      let query = "verb=ListIdentifiers&metadataPrefix=oai_dc";
      let busy = 0;
      for (let requests = 0; requests < 40; requests++) {
        const reply = await oai(query, "127.0.0.1", server);
        now += SLOW_READ_STRIKE_GAP_MS;
        if (reply.statusCode === 503) {
          // A harvester retries the same request after Retry-After.
          expect([reply.headers["retry-after"], reply.json()]).toEqual(["5", { error: "busy" }]);
          busy += 1;
          continue;
        }
        expect(reply.statusCode).toBe(200);
        expect(errorCode(reply.body)).toBeUndefined();
        seen.push(...identifiers(reply.body));
        const token = tokenIn(reply.body);
        if (token === undefined) break;
        query = `verb=ListIdentifiers&resumptionToken=${token}`;
      }
      // Busy once or twice (first at the normal limit if it began a page,
      // then at the larger: one strike), then stepped past at the second; every other record is there once.
      expect(busy).toBeGreaterThanOrEqual(1);
      expect(busy).toBeLessThanOrEqual(2);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(
        [published, ...more]
          .filter((id) => id !== target)
          .map((id) => `${PREFIX}${id}`)
          .sort(),
      );
      // Read first at the routes' limit, then twice at the larger one, each
      // gap between statements bounded too (the limit plus IDLE_MARGIN_MS).
      expect(limits).toEqual([
        { statement: "200ms", idle: "1200ms" },
        { statement: "1s", idle: "2s" },
        { statement: "1s", idle: "2s" },
      ]);
      expect(slowReads.strikes(slowKey(firstOf(sites), target))).toBe(OAI_SKIP_AFTER_STRIKES);
      // Logged for staff with its ID, once; nothing of it went to the harvester.
      expect(logged.filter((r) => r.event === "oai_record_skipped")).toEqual([
        { event: "oai_record_skipped", operation: "oaiPmh", name: "slow_record", code: target },
      ]);
      expect(seen.join(" ")).not.toContain(target);
      // GetRecord never skips: still busy, at the larger limit.
      const one = await oai(
        `verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${target}`,
        "127.0.0.1",
        server,
      );
      expect([one.statusCode, one.json()]).toEqual([503, { error: "busy" }]);
      expect(limits.at(-1)).toEqual({ statement: "1s", idle: "2s" });
    } finally {
      await server.close();
    }
  });

  it("one slow spell is one strike: a record isn't left out while its timeouts come close together", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const target = more[0] ?? "";
    const { db } = slowFor(
      () => target,
      () => true,
    );
    const logged: { event: string }[] = [];
    const slowReads = new SlowReads({ limitMs: 1_000, clock: () => 0 });
    const server = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: db,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        timeLimitMs: 200,
        slowReads,
        log: (r) => logged.push(r),
      }),
    });
    try {
      let query = "verb=ListIdentifiers&metadataPrefix=oai_dc";
      let busy = 0;
      for (let requests = 0; requests < 12; requests++) {
        const reply = await oai(query, "127.0.0.1", server);
        if (reply.statusCode === 503) {
          busy += 1;
          continue;
        }
        expect(identifiers(reply.body)).not.toContain(`${PREFIX}${target}`);
        const token = tokenIn(reply.body);
        if (token === undefined) break;
        query = `verb=ListIdentifiers&resumptionToken=${token}`;
      }
      // Stuck at the record, busy, but never stepped past within one spell.
      expect(busy).toBeGreaterThan(5);
      expect(slowReads.strikes(slowKey(firstOf(sites), target))).toBe(1);
      expect(logged.filter((r) => r.event === "oai_record_skipped")).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a record that is only slow is read with the larger limit next time, and answers", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    let failing = true;
    const { db, limits } = slowFor(
      () => published,
      () => failing,
    );
    const slowReads = new SlowReads({ limitMs: 1_000 });
    const server = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: [
        ...publicApiRoutes({ db, sites, timeLimitMs: 200, slowReads }),
        ...oaiPmhRoutes({
          db: w.db,
          publicDb: db,
          sites,
          adminEmail: EMAIL,
          rateLimits: { oai: 10_000 },
          timeLimitMs: 200,
          slowReads,
        }),
      ],
    });
    try {
      const get = () =>
        server.inject({
          method: "GET",
          url: `/records/${published}`,
          headers: { host: "127.0.0.1" },
        });
      const first = await get();
      expect([first.statusCode, first.json()]).toEqual([503, { error: "busy" }]);
      // The database is fine again: the next read has the larger limit and answers.
      failing = false;
      const second = await get();
      expect(second.statusCode).toBe(200);
      expect(second.json<{ id: string }>().id).toBe(`${PUBLIC}/records/${published}`);
      // Known slow, shared with OAI-PMH: GetRecord reads it at the larger limit too.
      const one = await oai(
        `verb=GetRecord&metadataPrefix=oai_dc&identifier=${PREFIX}${published}`,
        "127.0.0.1",
        server,
      );
      expect(one.statusCode).toBe(200);
      expect(errorCode(one.body)).toBeUndefined();
      expect(limits.map((l) => l.statement)).toEqual(["200ms", "1s", "1s"]);
      // Answered in time: no strikes held against it.
      expect(slowReads.strikes(slowKey(firstOf(sites), published))).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("a known-slow record mid-page waits for a page with its whole larger limit left", async () => {
    const sites = await checkPublicSites(w.db, reader, [{ origin: PUBLIC, siteId: w.a1 }]);
    const target = more[2] ?? "";
    const { db, limits } = slowFor(
      () => target,
      () => false,
    );
    // Known slow already; its larger limit (1 s) is more than a page (500 ms) has.
    const slowReads = new SlowReads({ limitMs: 1_000 });
    slowReads.timedOut(slowKey(firstOf(sites), target));
    const server = await buildServer({
      env: { OCULUS_ORIGINS: PUBLIC },
      routes: oaiPmhRoutes({
        db: w.db,
        publicDb: db,
        sites,
        adminEmail: EMAIL,
        rateLimits: { oai: 10_000 },
        timeLimitMs: 200,
        pageTimeLimitMs: 500,
        slowReads,
      }),
    });
    try {
      const seen: string[] = [];
      let query = "verb=ListIdentifiers&metadataPrefix=oai_dc";
      for (let pages = 0; pages < 40; pages++) {
        const reply = await oai(query, "127.0.0.1", server);
        expect(reply.statusCode).toBe(200);
        const ids = identifiers(reply.body);
        // Only ever read as a page's first.
        if (ids.includes(`${PREFIX}${target}`)) expect(ids[0]).toBe(`${PREFIX}${target}`);
        seen.push(...ids);
        const token = tokenIn(reply.body);
        if (token === undefined) break;
        query = `verb=ListIdentifiers&resumptionToken=${token}`;
      }
      expect(seen.sort()).toEqual([published, ...more].map((id) => `${PREFIX}${id}`).sort());
      expect(limits.map((l) => l.statement)).toEqual(["1s"]);
    } finally {
      await server.close();
    }
  });
});
