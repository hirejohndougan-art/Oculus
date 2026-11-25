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
  listPublishedForOai,
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
import { OAI_PAGE_SIZE, oaiAdminEmail, oaiPmhRoutes } from "./oai-pmh.js";
import { ReadSlots } from "./public-api.js";
import { PublicSubjects } from "./public-subjects.js";
import { checkPublicSites } from "./public-sites.js";
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

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "development",
    OCULUS_ORIGINS: `${ADMIN},${PUBLIC}`,
    OCULUS_ADMIN_ORIGIN: ADMIN,
    OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
    OCULUS_PUBLIC_SITES: `${PUBLIC}=${w.a1}`,
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
    const mounted = await buildAdminServer({
      db: w.db,
      publicDb: reader,
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
});
