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
    await w.service.createRecord({ organizationId: w.a, actor: actorOf(w.root), siteId: site }, {
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
    } as never),
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

const get = (host: string, url: string, token?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: {
      host,
      ...(token === undefined ? {} : { cookie: `${OCULUS_COOKIES.session}=${token}` }),
    },
  });

describe("GET /records/:id/ead on a public host", () => {
  it("gives the published unit and the published units below it, public values only", async () => {
    const reply = await get("127.0.0.1", `/records/${ids.fonds}/ead`);
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
    const reply = await get("127.0.0.1", `/records/${ids.series}/ead?version=ead3`);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('xmlns="http://ead3.archivists.org/schema/"');
    expect(reply.body).toContain("Invented series");
    expect(reply.body).not.toContain("Invented fonds");
  });

  it("answers everything else as the unknown path's 404, byte for byte", async () => {
    const unknown = await get("127.0.0.1", "/no-such-path");
    for (const url of [
      `/records/${ids.draftfonds}/ead`,
      `/records/${ids.draftfile}/ead`,
      `/records/${newRecordId()}/ead`,
      "/records/not-an-id/ead",
      `/records/${ids.fonds}/ead?version=ead4`,
    ]) {
      const reply = await get("127.0.0.1", url);
      expect([url, reply.statusCode, reply.body]).toEqual([url, 404, unknown.body]);
    }
    // A published unit under a draft answers as its own record page does.
    const page = await get("127.0.0.1", `/records/${ids.hidden}`);
    const own = await get("127.0.0.1", `/records/${ids.hidden}/ead`);
    expect(own.statusCode).toBe(page.statusCode);
    const admin = await get("localhost", `/records/${ids.fonds}/ead`);
    expect(admin.statusCode).toBe(404);
  });

  it("reads through the public reader only", async () => {
    const read = await readPublicFindingAid(reader, w.a, w.a1, ids.fonds as never, {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(read.ok).toBe(true);
    const other = await readPublicFindingAid(reader, w.a, w.a2, ids.fonds as never, {
      baseUrl: `${PUBLIC}/records/`,
    });
    expect(other.ok).toBe(false);
  });
});

describe("GET /api/records/:id/ead for staff", () => {
  it("gives the whole tree with staff-only values marked staff-only", async () => {
    const reply = await get(
      "localhost",
      `/api/records/${ids.fonds}/ead?version=ead3`,
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
    const other = await get("localhost", `/api/records/${ids.fonds}/ead`, tokens.other);
    expect(other.statusCode).toBeGreaterThanOrEqual(403);
    expect(other.body).not.toContain("Invented");
    const stranger = await get("localhost", `/api/records/${ids.fonds}/ead`, tokens.stranger);
    expect(stranger.statusCode).toBeGreaterThanOrEqual(403);
    expect(stranger.body).not.toContain("Invented");
    const signedOut = await get("localhost", `/api/records/${ids.fonds}/ead`);
    expect(signedOut.statusCode).toBe(401);
    const bad = await get(
      "localhost",
      `/api/records/${ids.fonds}/ead?version=ead4`,
      tokens.cataloger,
    );
    expect([400, 422]).toContain(bad.statusCode);
  });
});
