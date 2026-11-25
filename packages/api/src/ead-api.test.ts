// EAD exports (T-059b, D-120): `GET /records/:id/ead` on a public host gives
// a published unit and the published units below it, through the public
// reader, with public values only; `GET /api/records/:id/ead` gives staff the
// whole tree they may view, staff-only values marked audience="internal".
// Every record is invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRecordId, newSiteId, readEad, type RecordId } from "@oculus/core";
import {
  grantPublicReaderRole,
  insertIdentifierType,
  insertTemplateVersion,
  openDatabase,
  readPublicFindingAid,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { testServerUrl } from "../../db/src/test-database.fixtures.js";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import { loadAdminFiles } from "./admin-files.js";
import { buildAdminServer } from "./admin-server.js";
import { OCULUS_COOKIES } from "./cookies.js";
import {
  actorOf,
  field,
  INC,
  fullSession,
  makeWorld,
  ok,
  publishAs,
  type World,
} from "./staff-api.fixtures.js";

const ADMIN = "http://localhost";
const PUBLIC = "http://127.0.0.1";

let w: World;
let reader: Database;
let readerRole: string;
let app: FastifyInstance;
let dir: string;
let filesDir: string;
const ids: Record<string, RecordId> = {};
const tokens: Record<string, string> = {};

function id(name: string): RecordId {
  const found = ids[name];
  if (found === undefined) throw new Error(`no record ${name}`);
  return found;
}

async function withRole(q: Queryable, statement: string, role: string): Promise<void> {
  await q.rows(sql`SELECT set_config('oculus_test.role', ${role}, true),
                          set_config('oculus_test.statement', ${statement}, true)`);
  await q.execute(sql`DO $$ BEGIN
    EXECUTE format(current_setting('oculus_test.statement'), current_setting('oculus_test.role'));
  END $$`);
}

async function unit(
  name: string,
  level: string,
  parent: string | undefined,
  publish: boolean,
  site = w.a1,
): Promise<void> {
  const made = ok(
    await w.service.createRecord(
      { organizationId: w.a, actor: actorOf(w.root), siteId: site },
      {
        kind: "archival_unit",
        level,
        title: `Invented ${name}`,
        templateKey: "t-dacs",
        ...(parent === undefined ? {} : { parentId: ids[parent] }),
        fields: {
          scope_and_content: `Public scope of ${name}.`,
          appraisal: `STAFF appraisal of ${name}.`,
          date: "1920/1935",
          rights: { uri: INC },
        },
      },
    ),
  );
  ids[name] = made.record.id;
  if (publish) await publishAs(w, w.a, made.record.id);
}

beforeAll(async () => {
  w = await makeWorld();
  readerRole = `oculus_t059b_reader_${newSiteId().slice(0, 8)}`;
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

  ok(
    await insertTemplateVersion(w.db, {
      key: "t-dacs",
      organizationId: w.a,
      label: "Archival unit",
      appliesTo: ["archival_unit"],
      fields: [
        field("scope_and_content", "long_text", { label: "Scope and content" }),
        field("appraisal", "long_text", { label: "Appraisal", visibility: "staff" }),
        field("date", "date", { label: "Date" }),
        field("rights", "rights"),
      ],
    }),
  );
  ok(
    await w.service.saveDublinCoreMapping(
      { organizationId: w.a, actor: actorOf(w.root) },
      "t-dacs",
      {
        entries: [
          { field: "rights", term: "rights" },
          { field: "scope_and_content", term: "description" },
        ],
      },
      { expectedVersion: 0 },
    ),
  );
  // fonds (published) › series (published) › file (published) and
  //                                        › draft file (not) › item (published, under a draft)
  await unit("fonds", "fonds", undefined, true);
  await unit("series", "series", "fonds", true);
  await unit("file", "file", "series", true);
  await unit("draftfile", "file", "series", false);
  await unit("hidden", "item", "draftfile", true);
  await unit("draftfonds", "fonds", undefined, false);

  tokens.cataloger = (await fullSession(w.db, w.cataloger, w.a)).token;
  tokens.other = (await fullSession(w.db, w.other, w.a)).token;
  tokens.stranger = (await fullSession(w.db, w.stranger, w.b)).token;

  dir = mkdtempSync(join(tmpdir(), "oculus-t059b-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  mkdirSync(join(dir, "assets"));
  filesDir = mkdtempSync(join(tmpdir(), "oculus-t059b-files-"));
  app = await buildAdminServer({
    db: w.db,
    publicDb: reader,
    env: {
      NODE_ENV: "development",
      OCULUS_ORIGINS: `${ADMIN},${PUBLIC}`,
      OCULUS_ADMIN_ORIGIN: ADMIN,
      OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
      OCULUS_PUBLIC_SITES: `${PUBLIC}=${w.a1}`,
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

let clients = 0;
const get = (host: string, url: string, token?: string, ip?: string) =>
  app.inject({
    method: "GET",
    url,
    // A fresh client address each time unless given: EAD exports are braked per address.
    remoteAddress: ip ?? `10.0.${String(Math.floor(++clients / 250))}.${String(clients % 250)}`,
    headers: {
      host,
      ...(token === undefined ? {} : { cookie: `${OCULUS_COOKIES.session}=${token}` }),
    },
  });

describe("GET /records/:id/ead on a public host", () => {
  it("gives the published unit and the published units below it, public values only", async () => {
    const reply = await get("127.0.0.1", `/records/${id("fonds")}/ead`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["content-disposition"]).toContain("attachment");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    const xml = reply.body;
    expect(xml).toContain('xmlns="urn:isbn:1-931666-22-9"');
    for (const name of ["fonds", "series", "file"]) {
      expect(xml).toContain(`Invented ${name}`);
      expect(xml).toContain(`Public scope of ${name}.`);
    }
    // The draft, the published item under it, and every staff value stay out.
    expect(xml).not.toContain("draftfile");
    expect(xml).not.toContain("Invented hidden");
    expect(xml).not.toContain("STAFF");
    expect(xml).not.toContain("internal");
    const read = readEad(xml);
    expect(read.ok).toBe(true);
  });

  it("gives EAD3 when asked", async () => {
    const reply = await get("127.0.0.1", `/records/${id("series")}/ead?version=ead3`);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('xmlns="http://ead3.archivists.org/schema/"');
    expect(reply.body).toContain("Invented series");
    expect(reply.body).not.toContain("Invented fonds");
  });

  it("answers everything else as the unknown path's 404, byte for byte", async () => {
    const unknown = await get("127.0.0.1", "/no-such-path");
    for (const url of [
      `/records/${id("draftfonds")}/ead`,
      `/records/${id("draftfile")}/ead`,
      `/records/${newRecordId()}/ead`,
      "/records/not-an-id/ead",
      `/records/${id("fonds")}/ead?version=ead4`,
    ]) {
      const reply = await get("127.0.0.1", url);
      expect([url, reply.statusCode, reply.body]).toEqual([url, 404, unknown.body]);
    }
    // A published unit under a draft answers as its own record page does.
    const page = await get("127.0.0.1", `/records/${id("hidden")}`);
    const own = await get("127.0.0.1", `/records/${id("hidden")}/ead`);
    expect(own.statusCode).toBe(page.statusCode);
    const admin = await get("localhost", `/records/${id("fonds")}/ead`);
    expect(admin.statusCode).toBe(404);
  });

  it("reads through the public reader only", async () => {
    const read = await readPublicFindingAid(reader, w.a, w.a1, id("fonds"), {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(read.ok).toBe(true);
    const other = await readPublicFindingAid(reader, w.a, w.a2, id("fonds"), {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(other.ok).toBe(false);
  });
});

describe("GET /api/records/:id/ead for staff", () => {
  it("gives the whole tree with staff-only values marked staff-only", async () => {
    const reply = await get(
      "localhost",
      `/api/records/${id("fonds")}/ead?version=ead3`,
      tokens.cataloger,
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["content-disposition"]).toContain("attachment");
    const xml = reply.body;
    for (const name of ["fonds", "series", "file", "draftfile", "hidden"]) {
      expect(xml).toContain(`Invented ${name}`);
    }
    expect(xml).toContain("STAFF appraisal of fonds.");
    const read = readEad(xml);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const notes = read.value.findingAid.archdesc.notes;
    expect(notes.find((n) => n.paragraphs.some((p) => p.startsWith("STAFF")))?.internal).toBe(true);
    expect(notes.find((n) => n.kind === "scopecontent")?.internal).toBe(false);
  });

  it("refuses someone who can't view the unit, and a record that isn't an archival unit", async () => {
    const other = await get("localhost", `/api/records/${id("fonds")}/ead`, tokens.other);
    expect(other.statusCode).toBeGreaterThanOrEqual(403);
    expect(other.body).not.toContain("Invented");
    const stranger = await get("localhost", `/api/records/${id("fonds")}/ead`, tokens.stranger);
    expect(stranger.statusCode).toBeGreaterThanOrEqual(403);
    expect(stranger.body).not.toContain("Invented");
    const signedOut = await get("localhost", `/api/records/${id("fonds")}/ead`);
    expect(signedOut.statusCode).toBe(401);
    const bad = await get(
      "localhost",
      `/api/records/${id("fonds")}/ead?version=ead4`,
      tokens.cataloger,
    );
    expect([400, 422]).toContain(bad.statusCode);
  });
});

describe("public EAD exports are braked", () => {
  it("allows a few a minute per client address, then 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      codes.push(
        (await get("127.0.0.1", `/records/${id("file")}/ead`, undefined, "10.9.9.9")).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});

describe("staff files mark inherited and misfit values (T-059b second review)", () => {
  beforeAll(async () => {
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-par",
        organizationId: w.a,
        label: "Parent",
        appliesTo: ["archival_unit"],
        fields: [
          field("provenance", "text", {
            label: "Provenance",
            visibility: "staff",
            inherited: true,
          }),
          field("rights", "rights"),
        ],
      }),
    );
    const kid = (oldLink: "link" | "text") =>
      insertTemplateVersion(w.db, {
        key: "t-kid",
        organizationId: w.a,
        label: "Kid",
        appliesTo: ["archival_unit"],
        fields: [
          field("provenance", "text", { label: "Provenance", inherited: true }),
          field("rights", "rights"),
          field("old_link", oldLink, { label: "Old link" }),
        ],
      });
    ok(await kid("link"));
    const ctx = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    const p = ok(
      await w.service.createRecord(ctx, {
        kind: "archival_unit",
        level: "fonds",
        title: "Invented P",
        templateKey: "t-par",
        fields: { provenance: "STAFFPROV secret donor", rights: { uri: INC } },
      }),
    );
    ids.P = p.record.id;
    const k = ok(
      await w.service.createRecord(ctx, {
        kind: "archival_unit",
        level: "series",
        title: "Invented K",
        templateKey: "t-kid",
        parentId: p.record.id,
        fields: {
          rights: { uri: INC },
          old_link: { url: "https://example.org/x", label: "MISFITLABEL" },
        },
      }),
    );
    ids.K = k.record.id;
    // The template changes: old_link becomes plain text, so the stored link no longer fits.
    ok(await kid("text"));
  });

  it("marks a value inherited from a staff field staff-only, though the child's field is public", async () => {
    const reply = await get("localhost", `/api/records/${id("K")}/ead`, tokens.cataloger);
    expect(reply.statusCode).toBe(200);
    const read = readEad(reply.body);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const notes = read.value.findingAid.archdesc.notes;
    const prov = notes.filter((n) => n.paragraphs.some((p) => p.includes("STAFFPROV")));
    expect(prov.length).toBe(1);
    expect(prov[0]?.internal).toBe(true);
  });

  it("marks a value that no longer fits its field staff-only", async () => {
    const reply = await get("localhost", `/api/records/${id("K")}/ead`, tokens.cataloger);
    const read = readEad(reply.body);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const misfit = read.value.findingAid.archdesc.notes.filter((n) =>
      n.paragraphs.some((p) => p.includes("MISFITLABEL") || p.includes("example.org")),
    );
    expect(misfit.length).toBeGreaterThan(0);
    for (const n of misfit) expect(n.internal).toBe(true);
  });
});

describe("a staff field on a unit in between (T-059b third review)", () => {
  beforeAll(async () => {
    const tpl = (key: string, visibility: "public" | "staff") =>
      insertTemplateVersion(w.db, {
        key,
        organizationId: w.a,
        label: key,
        appliesTo: ["archival_unit"],
        fields: [
          field("provenance2", "text", { label: "Provenance2", visibility, inherited: true }),
          field("rights", "rights"),
        ],
      });
    ok(await tpl("t-g5", "public"));
    ok(await tpl("t-m5", "staff"));
    ok(await tpl("t-k5", "public"));
    const ctx = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    const make = async (title: string, level: string, templateKey: string, parentId?: string) =>
      ok(
        await w.service.createRecord(ctx, {
          kind: "archival_unit",
          level,
          title,
          templateKey,
          ...(parentId === undefined ? {} : { parentId }),
          fields: {
            rights: { uri: INC },
            ...(parentId === undefined ? { provenance2: "MIDSTAFF secret" } : {}),
          },
        }),
      ).record.id;
    const g = await make("Invented G5", "fonds", "t-g5");
    const m = await make("Invented M5", "series", "t-m5", g);
    ids.K5 = await make("Invented K5", "file", "t-k5", m);
  });

  it("marks an inherited value staff-only when a unit on the way makes the field staff", async () => {
    const reply = await get("localhost", `/api/records/${id("K5")}/ead`, tokens.cataloger);
    expect(reply.statusCode).toBe(200);
    const read = readEad(reply.body);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const prov = read.value.findingAid.archdesc.notes.filter((n) =>
      n.paragraphs.some((p) => p.includes("MIDSTAFF")),
    );
    expect(prov.length).toBe(1);
    expect(prov[0]?.internal).toBe(true);
  });
});

describe("a place value the public view leaves out (T-059b fourth review, D-048)", () => {
  it("is marked staff-only in a staff file", async () => {
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-pl",
        organizationId: w.a,
        label: "pl",
        appliesTo: ["archival_unit"],
        fields: [field("donor", "record_link", { label: "Donor" }), field("rights", "rights")],
      }),
    );
    const root = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    const secret = ok(
      await w.service.createRecord(root, {
        kind: "archival_unit",
        level: "fonds",
        title: "PRIVATE DONOR Jane Q",
        templateKey: "t-pl",
        fields: { rights: { uri: INC } },
      }),
    ).record.id;
    const u = ok(
      await w.service.createRecord(root, {
        kind: "archival_unit",
        level: "fonds",
        title: "Invented PL",
        templateKey: "t-pl",
        fields: {
          rights: { uri: INC },
          donor: { recordId: secret, label: "PRIVATE DONOR Jane Q" },
        },
      }),
    ).record.id;
    // A template edit makes the field a public place; the value still has a place's shape.
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-pl",
        organizationId: w.a,
        label: "pl",
        appliesTo: ["archival_unit"],
        fields: [field("donor", "place", { label: "Donor" }), field("rights", "rights")],
      }),
    );
    const got = ok(
      await w.service.exportFindingAid(
        { organizationId: w.a, actor: actorOf(w.cataloger), siteId: w.a1 },
        u,
        {},
      ),
    );
    const read = readEad(got.xml);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const a = read.value.findingAid.archdesc;
    expect(a.accessPoints.some((p) => p.label.includes("PRIVATE"))).toBe(false);
    const notes = a.notes.filter((n) => n.paragraphs.some((p) => p.includes("PRIVATE DONOR")));
    for (const n of notes) expect(n.internal).toBe(true);
  }, 60_000);
});

describe("ordinary public values stay public in a staff file (T-059b fifth review)", () => {
  it("writes a public number as unitid, a linked place as geogname, and only a rights note as staff-only", async () => {
    ok(
      await w.db.transaction((q) =>
        insertIdentifierType(q, {
          organizationId: w.a,
          key: "call_number",
          label: "Call number",
          uniqueness: "all_time",
          public: true,
        }),
      ),
    );
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-pl2",
        organizationId: w.a,
        label: "pl",
        appliesTo: ["place"],
        fields: [field("rights", "rights")],
      }),
    );
    ok(
      await insertTemplateVersion(w.db, {
        key: "t-u",
        organizationId: w.a,
        label: "u",
        appliesTo: ["archival_unit"],
        fields: [
          field("reference_code", "identifier", { label: "Reference code" }),
          field("places", "place", { label: "Places", repeatable: true }),
          field("rights", "rights"),
        ],
      }),
    );
    const root = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    const place = ok(
      await w.service.createRecord(root, {
        kind: "place",
        title: "Invented PLACE",
        templateKey: "t-pl2",
        fields: { rights: { uri: INC } },
      }),
    ).record.id;
    const u = ok(
      await w.service.createRecord(root, {
        kind: "archival_unit",
        level: "fonds",
        title: "Invented U",
        templateKey: "t-u",
        fields: { rights: { uri: INC } },
      }),
    ).record.id;
    ok(
      await w.service.saveIdentifiers(root as never, u as never, {
        current: [{ type: "call_number", value: "MS-0001", primary: true }],
        former: [],
      }),
    );
    const cur = ok(await w.service.readRecord({ organizationId: w.a, actor: actorOf(w.root) }, u));
    ok(
      await w.service.updateRecord(
        root,
        u,
        {
          kind: "archival_unit",
          level: "fonds",
          title: "Invented U",
          templateKey: "t-u",
          fields: {
            reference_code: { type: "call_number", value: "MS-0001" },
            places: [{ label: "Linked PLACE", recordId: place }, { label: "Plain PLACE" }],
            rights: { uri: INC, note: "STAFF rights note" },
          },
        },
        { expectedVersion: cur.version },
      ),
    );
    const got = ok(
      await w.service.exportFindingAid(
        { organizationId: w.a, actor: actorOf(w.cataloger), siteId: w.a1 },
        u,
        {},
      ),
    );
    const read = readEad(got.xml);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const a = read.value.findingAid.archdesc;
    expect(a.identifiers).toEqual(["MS-0001"]);
    expect(read.value.findingAid.header.id).toBe("MS-0001");
    expect(a.accessPoints.map((p) => p.label).sort()).toEqual(["Linked PLACE", "Plain PLACE"]);
    const rights = a.notes.filter((n) => n.kind === "userestrict");
    expect(rights.find((n) => n.paragraphs.includes("STAFF rights note"))?.internal).toBe(true);
    expect(rights.find((n) => n.paragraphs.includes(INC))?.internal).toBe(false);
  }, 60_000);
});
