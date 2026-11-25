// History, restore and the workflow over HTTP (T-043, D-082), against a
// fresh migrated database: each new endpoint with no session, a waiting or
// expired session, CSRF missing or wrong, a foreign Origin, an oversized
// body and a wrong content type; who may read old versions (D-072: not
// read-only people), restore and move records through the workflow; missing,
// other-site and other-organization records (and versions) answered byte
// for byte alike; If-Match conflicts; the S-020 refusal of a publication
// or restore that would put out a value from a record the person can't
// see; edits of published records going live at once; and a publication
// and an edit racing for the same record, pinned with a row lock held on a
// third connection. Every person, site and record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  csrfTokenFor,
  newRecordId,
  type OrganizationId,
  type RecordId,
  type UserId,
} from "@oculus/core";
import {
  insertTemplateVersion,
  openDatabase,
  readPublicRecord,
  sql,
  type Database,
  type Queryable,
} from "@oculus/db";
import { createService } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import {
  CSRF_HEADER,
  SITE_HEADER,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import {
  INC,
  actorOf,
  ageSession,
  field,
  fullSession,
  makeAs,
  makeObject,
  makeWorld,
  objectDraft,
  ok,
  pendingSession,
  publishAs,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld({ onError: serviceErrorLogger((r) => logged.push(r)) });
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: (r) => logged.push(r) }),
  });
  // A unit template whose provenance is public and inherited (S-020's setup).
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-pub-unit",
      organizationId: w.a,
      label: "Published unit",
      appliesTo: ["archival_unit"],
      fields: [field("rights", "rights"), field("provenance", "text", { inherited: true })],
    }),
  );
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("reader", w.reader, w.a);
  await make("other", w.other, w.a);
  await make("stranger", w.stranger, w.b);
  await make("donor", w.donor, w.a);
  for (const [name, role] of [
    ["reviewer", "reviewer"],
    ["scanner", "scanner"],
  ] as const) {
    const person = await w.member(w.a, `Invented${role}`);
    await grant(w.service, w.root, w.a, { userId: person, role, siteId: w.a1 });
    await make(name, person, w.a);
  }
  tokens.pending = (await pendingSession(w.db, w.cataloger, w.a)).token;
  const expired = await fullSession(w.db, w.cataloger, w.a);
  await ageSession(w.db, expired.sessionId, 13 * 3600);
  tokens.expired = expired.token;
  tokens.madeup = "A".repeat(43);
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Call {
  as?: string;
  body?: unknown;
  payload?: string;
  headers?: Record<string, string>;
  csrf?: boolean | string;
  origin?: string | null;
  site?: string;
}

async function call(method: string, url: string, c: Call = {}, server = app) {
  const token = c.as === undefined ? undefined : tokens[c.as];
  const headers: Record<string, string> = { ...c.headers };
  if (c.origin !== null) headers.origin = c.origin ?? SAME_ORIGIN.origin;
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  const csrf = c.csrf ?? method !== "GET";
  if (csrf === true && token !== undefined) headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  if (typeof csrf === "string") headers[CSRF_HEADER] = csrf;
  if (c.site !== undefined) headers[SITE_HEADER] = c.site;
  let payload = c.payload;
  if (c.body !== undefined) {
    payload = JSON.stringify(c.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await server.inject({
    method: method as "GET",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json: json as Record<string, unknown>, res };
}

const issueCodes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

/** Status, body and headers but the date: what must match for identical replies. */
function shape(r: Awaited<ReturnType<typeof call>>) {
  const headers = { ...r.res.headers };
  delete headers.date;
  return { status: r.status, body: r.res.body, headers };
}

async function stored(id: string): Promise<{ version: number; state: string; title: string }> {
  const rows = await w.db.rows<{ version: number; workflow_state: string; title: string }>(
    sql`SELECT version, workflow_state, title FROM public.records WHERE id = ${id}::uuid`,
  );
  const row = rows[0];
  return { version: row?.version ?? 0, state: row?.workflow_state ?? "", title: row?.title ?? "" };
}

/** Saves a new title as the system manager (the record's next version). */
async function retitle(id: string, version: number, title: string): Promise<void> {
  ok(
    await w.service.updateRecord(
      { organizationId: w.a, actor: actorOf(w.root) },
      id as RecordId,
      objectDraft(title),
      { expectedVersion: version },
    ),
  );
}

interface Endpoint {
  method: string;
  url: string;
  headers?: Record<string, string>;
}

/** Every endpoint T-043 adds, for record `id` at version 1. */
function endpoints(id: string): Endpoint[] {
  const v1 = { "if-match": '"v1"' };
  return [
    { method: "GET", url: `/api/records/${id}/versions` },
    { method: "GET", url: `/api/records/${id}/versions/1` },
    { method: "GET", url: `/api/records/${id}/compare?from=1&to=1` },
    { method: "POST", url: `/api/records/${id}/versions/1/restore`, headers: v1 },
    { method: "POST", url: `/api/records/${id}/submit-for-review`, headers: v1 },
    { method: "POST", url: `/api/records/${id}/return-to-draft`, headers: v1 },
    { method: "POST", url: `/api/records/${id}/publish`, headers: v1 },
    { method: "POST", url: `/api/records/${id}/withdraw`, headers: v1 },
  ];
}

describe("every new endpoint refuses without a usable session, CSRF or same origin", () => {
  it("no session, a waiting session, an expired one, a made-up token: 401, nothing changed", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id)) {
      for (const as of [undefined, "pending", "expired", "madeup"]) {
        const r = await call(e.method, e.url, {
          ...(as === undefined ? {} : { as }),
          headers: e.headers ?? {},
          body: e.method === "GET" ? undefined : { reason: "Invented." },
        });
        expect([e.url, as, r.status, r.json]).toEqual([
          e.url,
          as,
          401,
          { error: "unauthenticated" },
        ]);
      }
    }
    expect(await stored(target.id)).toMatchObject({ version: 1, state: "draft" });
  });

  it("every change needs this session's CSRF token, and the same origin", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id).filter((x) => x.method !== "GET")) {
      for (const csrf of [false, "x".repeat(43), csrfTokenFor(tokens.cataloger ?? "") ?? ""]) {
        const r = await call(e.method, e.url, { as: "manager", csrf, headers: e.headers ?? {} });
        expect([e.url, r.status, r.json]).toEqual([e.url, 403, { error: "csrf_failed" }]);
      }
      for (const origin of ["https://evil.example", null]) {
        const r = await call(e.method, e.url, { as: "manager", origin, headers: e.headers ?? {} });
        expect([e.url, r.status, r.json]).toEqual([e.url, 403, { error: "cross_origin" }]);
      }
    }
    expect(await stored(target.id)).toMatchObject({ version: 1, state: "draft" });
  });

  it("oversized bodies (413), wrong content types (415) and unknown keys (422) are refused", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id).filter((x) => x.method !== "GET")) {
      const big = await call(e.method, e.url, {
        as: "manager",
        payload: JSON.stringify({ reason: "x".repeat(1024 * 1024 + 10) }),
        headers: { ...e.headers, "content-type": "application/json" },
      });
      expect([e.url, big.status, big.json]).toEqual([e.url, 413, { error: "payload_too_large" }]);
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/xml"]) {
        const r = await call(e.method, e.url, {
          as: "manager",
          payload: "reason=1",
          headers: { ...e.headers, "content-type": type },
        });
        expect([e.url, type, r.status]).toEqual([e.url, type, 415]);
      }
      const extra = await call(e.method, e.url, {
        as: "manager",
        headers: e.headers ?? {},
        body: { reason: "Invented.", organizationId: w.b },
      });
      expect([e.url, extra.status, issueCodes(extra)]).toEqual([e.url, 422, ["unknown_property"]]);
      const notObject = await call(e.method, e.url, {
        as: "manager",
        headers: e.headers ?? {},
        body: ["publish"],
      });
      expect([e.url, notObject.status, notObject.json]).toEqual([
        e.url,
        400,
        { error: "bad_body" },
      ]);
    }
    expect(await stored(target.id)).toMatchObject({ version: 1, state: "draft" });
  });

  it("every change needs If-Match: missing is 428, malformed 400, and nothing changes", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id).filter((x) => x.method !== "GET")) {
      const none = await call(e.method, e.url, { as: "manager" });
      expect([e.url, none.status, none.json]).toEqual([
        e.url,
        428,
        { error: "precondition_required" },
      ]);
      for (const bad of ['W/"v1"', "v1", '"v0"', "*"]) {
        const r = await call(e.method, e.url, { as: "manager", headers: { "if-match": bad } });
        expect([e.url, bad, r.status, r.json]).toEqual([
          e.url,
          bad,
          400,
          { error: "bad_if_match" },
        ]);
      }
    }
    expect(await stored(target.id)).toMatchObject({ version: 1, state: "draft" });
  });
});

describe("version history", () => {
  it("lists versions without content, reads one with it, and compares two", async () => {
    const target = await makeObject(w, w.a, w.a1, "An invented lamp");
    await retitle(target.id, 1, "An invented brass lamp");
    const list = await call("GET", `/api/records/${target.id}/versions`, { as: "cataloger" });
    expect(list.status).toBe(200);
    expect(list.res.headers["cache-control"]).toBe("no-store");
    const versions = list.json.versions as Record<string, unknown>[];
    expect(versions.map((v) => [v.version, v.action, v.workflowState])).toEqual([
      [1, "save", "draft"],
      [2, "save", "draft"],
    ]);
    expect(versions[1]?.changedFields).toEqual(["title"]);
    expect(versions[0]?.actor).toBe(actorOf(w.root));
    expect(list.json.next).toBeNull();
    // Summaries only: no title, no field values (staff fields included).
    expect(list.res.body).not.toContain("invented lamp");
    expect(list.res.body).not.toContain("Back room.");
    expect(Object.keys(versions[0] ?? {}).sort()).toEqual([
      "action",
      "actor",
      "changedFields",
      "recordedAt",
      "version",
      "workflowState",
    ]);

    const one = await call("GET", `/api/records/${target.id}/versions/1`, { as: "cataloger" });
    expect(one.status).toBe(200);
    const version = one.json.version as { version: number; record: { title: string } };
    expect(version.version).toBe(1);
    expect(version.record.title).toBe("An invented lamp");

    const compared = await call("GET", `/api/records/${target.id}/compare?from=1&to=2`, {
      as: "cataloger",
    });
    expect(compared.status).toBe(200);
    expect(compared.json.from).toBe(1);
    expect(compared.json.to).toBe(2);
    expect(JSON.stringify(compared.json.differences)).toContain("An invented brass lamp");
  });

  it("pages with limit and after; bad numbers are 400", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented page 1");
    await retitle(target.id, 1, "Invented page 2");
    await retitle(target.id, 2, "Invented page 3");
    const first = await call("GET", `/api/records/${target.id}/versions?limit=2`, {
      as: "manager",
    });
    expect((first.json.versions as { version: number }[]).map((v) => v.version)).toEqual([1, 2]);
    expect(first.json.next).toBe(2);
    const rest = await call("GET", `/api/records/${target.id}/versions?limit=2&after=2`, {
      as: "manager",
    });
    expect((rest.json.versions as { version: number }[]).map((v) => v.version)).toEqual([3]);
    expect(rest.json.next).toBeNull();
    for (const query of ["limit=0", "limit=101", "after=x", "limit=1&limit=2", "after=-1"]) {
      const r = await call("GET", `/api/records/${target.id}/versions?${query}`, {
        as: "manager",
      });
      expect([query, r.status, r.json]).toEqual([query, 400, { error: "bad_query" }]);
    }
  });

  it("who sees old versions: managers, catalogers and system managers; not read-only (D-072)", async () => {
    const target = await makeObject(w, w.a, w.a1);
    await retitle(target.id, 1, "Invented second title");
    const urls = [
      `/api/records/${target.id}/versions`,
      `/api/records/${target.id}/versions/1`,
      `/api/records/${target.id}/compare?from=1&to=2`,
    ];
    for (const url of urls) {
      for (const as of ["root", "manager", "cataloger"]) {
        expect([url, as, (await call("GET", url, { as })).status]).toEqual([url, as, 200]);
      }
      // The reader sees the record itself but no old version.
      const read = await call("GET", url, { as: "reader" });
      expect([url, read.status, read.json]).toEqual([url, 403, { error: "not_permitted" }]);
      // No view at all (Donor relations), another site's cataloger, another
      // organization's member: as if there were no such record.
      for (const as of ["donor", "other", "stranger"]) {
        const r = await call("GET", url, { as });
        expect([url, as, r.status, r.json]).toEqual([url, as, 404, { error: "not_found" }]);
      }
    }
    expect((await call("GET", `/api/records/${target.id}`, { as: "reader" })).status).toBe(200);
  });

  it("a version the record doesn't have is 404, but only once the person may read its history", async () => {
    const target = await makeObject(w, w.a, w.a1);
    const missing = [];
    for (const url of [
      `/api/records/${target.id}/versions/2`,
      `/api/records/${target.id}/versions/99999`,
      `/api/records/${target.id}/versions/x`,
      `/api/records/${target.id}/versions/0`,
      `/api/records/${target.id}/versions/99999999999`,
      `/api/records/${target.id}/compare?from=1&to=7`,
      `/api/records/${target.id}/compare?from=1`,
      `/api/records/${target.id}/compare?from=x&to=1`,
    ]) {
      missing.push(shape(await call("GET", url, { as: "manager" })));
      // Read-only: refused for the history first, whatever the version.
      const reader = await call("GET", url, { as: "reader" });
      expect([url, reader.status]).toEqual([url, 403]);
    }
    expect(missing[0]?.status).toBe(404);
    expect(missing[0]?.body).toBe('{"error":"not_found"}');
    for (const m of missing.slice(1)) expect(m).toEqual(missing[0]);
  });
});

describe("missing, other-site and other-organization records get identical replies", () => {
  it("on every new endpoint, for a site manager of A1", async () => {
    const onA2 = await makeObject(w, w.a, w.a2, "Invented second-site object");
    const inB = await makeObject(w, w.b, w.b1, "Invented library object");
    const deleted = await makeObject(w, w.a, w.a1, "Invented deleted object");
    ok(
      await w.service.deleteRecord(
        { organizationId: w.a, actor: actorOf(w.root) },
        deleted.id as RecordId,
        { expectedVersion: 1 },
      ),
    );
    const ids = [newRecordId(), onA2.id, inB.id, deleted.id, "not-a-uuid"];
    for (let i = 0; i < endpoints(ids[0] ?? "").length; i++) {
      const replies = [];
      for (const id of ids) {
        const e = endpoints(id)[i];
        if (e === undefined) throw new Error("no endpoint");
        replies.push(
          shape(
            await call(e.method, e.url, {
              as: "manager",
              headers: e.headers ?? {},
              ...(e.method === "GET" ? {} : { body: { reason: "Invented." } }),
            }),
          ),
        );
      }
      expect(replies[0]?.status).toBe(404);
      expect(replies[0]?.body).toBe('{"error":"not_found"}');
      for (const reply of replies.slice(1)) expect(reply).toEqual(replies[0]);
    }
    // Nothing happened to the records out of sight.
    expect(await stored(onA2.id)).toMatchObject({ version: 1, state: "draft" });
    expect(await stored(inB.id)).toMatchObject({ version: 1, state: "draft" });
  });

  it("an unknown version of a record out of sight is the same 404 as a missing record", async () => {
    const onA2 = await makeObject(w, w.a, w.a2);
    const a = await call("GET", `/api/records/${onA2.id}/versions/99`, { as: "cataloger" });
    const b = await call("GET", `/api/records/${newRecordId()}/versions/1`, { as: "cataloger" });
    const c = await call("GET", `/api/records/${onA2.id}/versions/x`, { as: "cataloger" });
    expect(shape(a)).toEqual(shape(b));
    expect(shape(c)).toEqual(shape(b));
  });
});

describe("restoring a version", () => {
  it("restores as the next version, with ETag; a stale If-Match is 412 with names only", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented first title");
    await retitle(target.id, 1, "Invented second title");
    const restored = await call("POST", `/api/records/${target.id}/versions/1/restore`, {
      as: "cataloger",
      headers: { "if-match": '"v2"' },
      body: { reason: "Back to the first title." },
    });
    expect(restored.status).toBe(200);
    expect(restored.json.version).toBe(3);
    expect(restored.res.headers.etag).toBe('"v3"');
    expect((restored.json.record as { title: string }).title).toBe("Invented first title");
    const list = await call("GET", `/api/records/${target.id}/versions`, { as: "cataloger" });
    const last = (list.json.versions as { reason?: string; actor: string }[]).at(-1);
    expect(last?.actor).toBe(actorOf(w.cataloger));
    expect(last?.reason).toContain("Back to the first title.");

    // Someone else saved meanwhile: the restore from v2 conflicts.
    const stale = await call("POST", `/api/records/${target.id}/versions/2/restore`, {
      as: "cataloger",
      headers: { "if-match": '"v2"' },
    });
    expect(stale.status).toBe(412);
    expect(stale.json.error).toBe("version_conflict");
    expect(stale.json.conflict).toBeDefined();
    expect(JSON.stringify(stale.json)).not.toContain("Invented first title");
    expect(JSON.stringify(stale.json)).not.toContain("Invented second title");

    // A version equal to the record now: nothing to restore.
    const same = await call("POST", `/api/records/${target.id}/versions/1/restore`, {
      as: "cataloger",
      headers: { "if-match": '"v3"' },
    });
    expect([same.status, issueCodes(same)]).toEqual([422, ["no_changes"]]);
    // A version it doesn't have.
    const none = await call("POST", `/api/records/${target.id}/versions/42/restore`, {
      as: "cataloger",
      headers: { "if-match": '"v3"' },
    });
    expect([none.status, none.json]).toEqual([404, { error: "not_found" }]);
    // confirmMadePublic reaches the service, which checks it.
    const badConfirm = await call("POST", `/api/records/${target.id}/versions/2/restore`, {
      as: "cataloger",
      headers: { "if-match": '"v3"' },
      body: { confirmMadePublic: "note" },
    });
    expect(badConfirm.status).toBe(422);
    expect(await stored(target.id)).toMatchObject({ version: 3 });
  });

  it("needs history and edit: read-only and Donor relations are refused, other sites see nothing", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented kept title");
    await retitle(target.id, 1, "Invented later title");
    const url = `/api/records/${target.id}/versions/1/restore`;
    const headers = { "if-match": '"v2"' };
    const reader = await call("POST", url, { as: "reader", headers });
    expect([reader.status, reader.json]).toEqual([403, { error: "not_permitted" }]);
    for (const as of ["donor", "other", "stranger"]) {
      const r = await call("POST", url, { as, headers });
      expect([as, r.status, r.json]).toEqual([as, 404, { error: "not_found" }]);
    }
    expect(await stored(target.id)).toMatchObject({ version: 2, title: "Invented later title" });
    const manager = await call("POST", url, { as: "manager", headers });
    expect(manager.status).toBe(200);
  });
});

describe("the workflow moves", () => {
  it("catalogers send for review and back; only those with records.publish publish and withdraw", async () => {
    const target = await makeObject(w, w.a, w.a1);
    const url = (move: string) => `/api/records/${target.id}/${move}`;
    const at = (v: number) => ({ "if-match": `"v${String(v)}"` });

    const readerMove = await call("POST", url("submit-for-review"), {
      as: "reader",
      headers: at(1),
    });
    expect([readerMove.status, readerMove.json]).toEqual([403, { error: "not_permitted" }]);
    const submitted = await call("POST", url("submit-for-review"), {
      as: "cataloger",
      headers: at(1),
      body: { reason: "Ready for a look." },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.json.state).toBe("ready_for_review");
    expect(submitted.json.version).toBe(2);
    expect(submitted.json.actor).toBe(actorOf(w.cataloger));
    expect(submitted.res.headers.etag).toBe('"v2"');

    for (const as of ["cataloger", "reader"]) {
      const r = await call("POST", url("publish"), { as, headers: at(2) });
      expect([as, r.status, r.json]).toEqual([as, 403, { error: "not_permitted" }]);
    }
    for (const as of ["donor", "other", "stranger"]) {
      const r = await call("POST", url("publish"), { as, headers: at(2) });
      expect([as, r.status, r.json]).toEqual([as, 404, { error: "not_found" }]);
    }
    expect(await stored(target.id)).toMatchObject({ version: 2, state: "ready_for_review" });

    const published = await call("POST", url("publish"), { as: "manager", headers: at(2) });
    expect([published.status, published.json.state]).toEqual([200, "published"]);
    const read = await call("GET", `/api/records/${target.id}`, { as: "reader" });
    expect(read.json.state).toBe("published");
    expect(read.res.headers.etag).toBe('"v3"');

    const catalogerWithdraw = await call("POST", url("withdraw"), {
      as: "cataloger",
      headers: at(3),
    });
    expect(catalogerWithdraw.status).toBe(403);
    // A published record leaves the public only by withdrawing (D-075).
    const straightBack = await call("POST", url("return-to-draft"), {
      as: "manager",
      headers: at(3),
    });
    expect(straightBack.status).toBe(422);
    expect(straightBack.json.error).toBe("invalid");
    const withdrawn = await call("POST", url("withdraw"), { as: "manager", headers: at(3) });
    expect([withdrawn.status, withdrawn.json.state]).toEqual([200, "withdrawn"]);
    const back = await call("POST", url("return-to-draft"), { as: "cataloger", headers: at(4) });
    expect([back.status, back.json.state]).toEqual([200, "draft"]);

    const history = await call("GET", `/api/records/${target.id}/versions`, { as: "manager" });
    expect((history.json.versions as { action: string }[]).map((v) => v.action)).toEqual([
      "save",
      "submit_for_review",
      "publish",
      "withdraw",
      "return_to_draft",
    ]);
  });

  it("a move from a version the person no longer has is 412 with names only", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented stale view");
    await retitle(target.id, 1, "Invented newer title");
    for (const move of ["submit-for-review", "publish"]) {
      const r = await call("POST", `/api/records/${target.id}/${move}`, {
        as: "manager",
        headers: { "if-match": '"v1"' },
      });
      expect([move, r.status, r.json.error]).toEqual([move, 412, "version_conflict"]);
      expect(r.res.body).not.toContain("Invented newer title");
    }
    expect(await stored(target.id)).toMatchObject({ version: 2, state: "draft" });
  });

  it("a record failing the publish check isn't published (422, state unchanged)", async () => {
    const id = await makeAs(w, w.a, w.a1, objectDraft("Invented rightless object", {}));
    const r = await call("POST", `/api/records/${id}/publish`, {
      as: "manager",
      headers: { "if-match": '"v1"' },
    });
    expect(r.status).toBe(422);
    expect(await stored(id)).toMatchObject({ version: 1, state: "draft" });
  });

  it("an edit of a published record goes live at once, and the record stays published (John)", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented live object");
    await publishAs(w, w.a, target.id);
    const edited = await call("PUT", `/api/records/${target.id}`, {
      as: "cataloger",
      headers: { "if-match": '"v2"' },
      body: {
        record: objectDraft("Invented live object", {
          rights: { uri: INC },
          note: "Invented corrected note.",
          secret: "Back room.",
        }),
      },
    });
    expect(edited.status).toBe(200);
    expect(await stored(target.id)).toMatchObject({ version: 3, state: "published" });
    const out = await readPublicRecord(w.db, w.a, w.a1, target.id as RecordId, {
      baseUrl: "https://archive.example.org/records/",
      mappings: [
        {
          organizationId: w.a,
          template: "t-object",
          entries: [
            { field: "rights", term: "rights" },
            { field: "note", term: "description" },
          ],
        },
      ],
    });
    expect(out.ok).toBe(true);
    const text = JSON.stringify(out);
    expect(text).toContain("Invented corrected note.");
    expect(text).not.toContain("Back room.");
  });
});

describe("each role over HTTP (D-072)", () => {
  const ROLES = [
    "root",
    "manager",
    "reviewer",
    "cataloger",
    "reader",
    "scanner",
    "donor",
    "other",
    "stranger",
  ] as const;
  type Role = (typeof ROLES)[number];
  // 200, 403 (sees the record, may not do this) or 404 (doesn't see it).
  const expected: Record<string, Record<Role, number>> = {
    history: {
      root: 200,
      manager: 200,
      reviewer: 200,
      cataloger: 200,
      reader: 403,
      scanner: 403,
      donor: 404,
      other: 404,
      stranger: 404,
    },
    restore: {
      root: 200,
      manager: 200,
      reviewer: 200,
      cataloger: 200,
      reader: 403,
      scanner: 403,
      donor: 404,
      other: 404,
      stranger: 404,
    },
    submit: {
      root: 200,
      manager: 200,
      reviewer: 200,
      cataloger: 200,
      reader: 403,
      scanner: 403,
      donor: 404,
      other: 404,
      stranger: 404,
    },
    publish: {
      root: 200,
      manager: 200,
      reviewer: 200,
      cataloger: 403,
      reader: 403,
      scanner: 403,
      donor: 404,
      other: 404,
      stranger: 404,
    },
    withdraw: {
      root: 200,
      manager: 200,
      reviewer: 200,
      cataloger: 403,
      reader: 403,
      scanner: 403,
      donor: 404,
      other: 404,
      stranger: 404,
    },
  };

  /** Each role on a fresh object of A1 prepared for the action. */
  async function attempt(action: string, as: Role): Promise<number> {
    const target = await makeObject(w, w.a, w.a1, "Invented role object");
    const h = (v: number) => ({ "if-match": `"v${String(v)}"` });
    switch (action) {
      case "history":
        return (await call("GET", `/api/records/${target.id}/versions/1`, { as })).status;
      case "restore":
        await retitle(target.id, 1, "Invented role object, renamed");
        return (
          await call("POST", `/api/records/${target.id}/versions/1/restore`, { as, headers: h(2) })
        ).status;
      case "submit":
        return (
          await call("POST", `/api/records/${target.id}/submit-for-review`, { as, headers: h(1) })
        ).status;
      case "publish":
        return (await call("POST", `/api/records/${target.id}/publish`, { as, headers: h(1) }))
          .status;
      default:
        await publishAs(w, w.a, target.id);
        return (await call("POST", `/api/records/${target.id}/withdraw`, { as, headers: h(2) }))
          .status;
    }
  }

  it("history, restore, submit, publish and withdraw, for every role", async () => {
    const got: Record<string, Record<string, number>> = {};
    for (const action of Object.keys(expected)) {
      got[action] = {};
      for (const as of ROLES) got[action][as] = await attempt(action, as);
    }
    expect(got).toEqual(expected);
  });

  it("a Scanner sends a scan for review (media.attach) but can't publish it or see its history", async () => {
    const object = await makeObject(w, w.a, w.a1, "Invented scanned object");
    const scan = await makeAs(w, w.a, w.a1, {
      kind: "digital_asset",
      mediaType: "image/tiff",
      represents: object.id,
      title: "Invented scan",
      templateKey: "t-asset",
      fields: { rights: { uri: INC } },
    });
    const v1 = { "if-match": '"v1"' };
    const history = await call("GET", `/api/records/${scan}/versions`, { as: "scanner" });
    expect(history.status).toBe(403);
    const submitted = await call("POST", `/api/records/${scan}/submit-for-review`, {
      as: "scanner",
      headers: v1,
    });
    expect([submitted.status, submitted.json.state]).toEqual([200, "ready_for_review"]);
    const published = await call("POST", `/api/records/${scan}/publish`, {
      as: "scanner",
      headers: { "if-match": '"v2"' },
    });
    expect(published.status).toBe(403);
  });
});

describe("the approval queue", () => {
  it("lists records sent for review on the sites where the person may publish, paged", async () => {
    const mine: string[] = [];
    for (const title of ["Invented queued one", "Invented queued two", "Invented queued three"]) {
      const made = await makeObject(w, w.a, w.a1, title);
      const r = await call("POST", `/api/records/${made.id}/submit-for-review`, {
        as: "cataloger",
        headers: { "if-match": '"v1"' },
      });
      expect(r.status).toBe(200);
      mine.push(made.id);
    }
    const elsewhere = await makeObject(w, w.a, w.a2, "Invented queued elsewhere");
    ok(
      await w.service.submitForReview(
        { organizationId: w.a, actor: actorOf(w.root) },
        elsewhere.id as RecordId,
        { expectedVersion: 1 },
      ),
    );
    const inB = await makeObject(w, w.b, w.b1, "Invented queued in the library");
    ok(
      await w.service.submitForReview(
        { organizationId: w.b, actor: actorOf(w.root) },
        inB.id as RecordId,
        { expectedVersion: 1 },
      ),
    );
    const draft = await makeObject(w, w.a, w.a1, "Invented not queued");

    const ids = async (as: string) => {
      const r = await call("GET", "/api/review-queue?limit=100", { as });
      expect(r.status).toBe(200);
      return (r.json.records as { id: string }[]).map((x) => x.id);
    };
    for (const as of ["manager", "reviewer"]) {
      const seen = await ids(as);
      for (const id of mine) expect(seen).toContain(id);
      expect(seen).not.toContain(elsewhere.id);
      expect(seen).not.toContain(inB.id);
      expect(seen).not.toContain(draft.id);
    }
    const root = await ids("root");
    expect(root).toContain(elsewhere.id);
    expect(root).not.toContain(inB.id);
    // Not for people who may publish nowhere.
    for (const as of ["cataloger", "reader", "scanner", "donor", "other", "stranger"]) {
      const r = await call("GET", "/api/review-queue", { as });
      expect([as, r.status, r.json]).toEqual([as, 403, { error: "not_permitted" }]);
    }
    // Pages follow `next`, in ID order, with the version a move needs.
    const all = await ids("manager");
    const first = await call("GET", "/api/review-queue?limit=1", { as: "manager" });
    const entry = (first.json.records as { id: string; version: number; title: string }[])[0];
    expect(entry?.id).toBe(all[0]);
    expect(entry?.version).toBe(2);
    expect(first.json.next).toBe(all[0]);
    const second = await call("GET", `/api/review-queue?limit=1&after=${String(first.json.next)}`, {
      as: "manager",
    });
    expect((second.json.records as { id: string }[])[0]?.id).toBe(all[1]);
    for (const query of ["limit=0", "limit=101", "after=x&after=y"]) {
      const r = await call("GET", `/api/review-queue?${query}`, { as: "manager" });
      expect([query, r.status]).toEqual([query, 400]);
    }
    const badAfter = await call("GET", "/api/review-queue?after=x", { as: "manager" });
    expect([badAfter.status, issueCodes(badAfter)]).toEqual([422, ["invalid_after"]]);
  });
});

describe("never putting out what the person can't see (S-020) over HTTP", () => {
  async function unit(title: string, parentId?: string, provenance?: string, level?: string) {
    return makeAs(w, w.a, w.a1, {
      kind: "archival_unit",
      level: level ?? (parentId === undefined ? "fonds" : "series"),
      ...(parentId === undefined ? {} : { parentId }),
      title,
      templateKey: "t-pub-unit",
      fields: { rights: { uri: INC }, ...(provenance === undefined ? {} : { provenance }) },
    });
  }

  /** A reviewer (who may publish and read history) only below the given units. */
  async function reviewerBelow(name: string, ...units: string[]): Promise<void> {
    const person = await w.member(w.a, name);
    for (const scope of units) {
      await grant(w.service, w.root, w.a, {
        userId: person,
        role: "reviewer",
        siteId: w.a1,
        scope,
      });
    }
    tokens[name] = (await fullSession(w.db, person, w.a)).token;
  }

  it("refuses publishing a series that would show a hidden fonds's provenance", async () => {
    const fonds = await unit("Invented Hidden Fonds", undefined, "Invented hidden provenance.");
    const series = await unit("Invented series", fonds);
    await reviewerBelow("Carol", series);
    const r = await call("POST", `/api/records/${series}/publish`, {
      as: "Carol",
      headers: { "if-match": '"v1"' },
    });
    expect([r.status, issueCodes(r)]).toEqual([422, ["inherits_from_hidden"]]);
    expect(r.res.body).not.toContain(fonds);
    expect(r.res.body).not.toContain("Hidden");
    expect(r.res.body).not.toContain("hidden provenance");
    expect(await stored(series)).toMatchObject({ version: 1, state: "draft" });
    // The fonds itself is out of her sight: answered as missing.
    const fondsHistory = await call("GET", `/api/records/${fonds}/versions`, { as: "Carol" });
    expect([fondsHistory.status, fondsHistory.json]).toEqual([404, { error: "not_found" }]);
    // Someone who sees the fonds may publish it.
    const manager = await call("POST", `/api/records/${series}/publish`, {
      as: "manager",
      headers: { "if-match": '"v1"' },
    });
    expect(manager.status).toBe(200);
  });

  it("refuses restoring a published file to a version under a hidden fonds", async () => {
    const first = await unit("Invented First Fonds", undefined, "Invented first provenance.");
    const second = await unit("Invented Second Fonds", undefined, "Invented second provenance.");
    const seriesA = await unit("Invented series A", first);
    const seriesB = await unit("Invented series B", second);
    // v1 under series B, v2 moved under series A, v3 published (all by the system manager).
    const file = await unit("Invented file", seriesB, undefined, "file");
    const v1 = ok(
      await w.service.readRecord({ organizationId: w.a, actor: actorOf(w.root) }, file as RecordId),
    );
    ok(
      await w.service.updateRecord(
        { organizationId: w.a, actor: actorOf(w.root) },
        file as RecordId,
        { ...v1.record, parentId: seriesA },
        { expectedVersion: 1 },
      ),
    );
    await publishAs(w, w.a, file, 2);
    await reviewerBelow("Dana", seriesA, seriesB);
    // She may read the history and restore within what she sees…
    const list = await call("GET", `/api/records/${file}/versions`, { as: "Dana" });
    expect(list.status).toBe(200);
    // …but restoring v1 would show the second fonds's value, which she can't see.
    const r = await call("POST", `/api/records/${file}/versions/1/restore`, {
      as: "Dana",
      headers: { "if-match": '"v3"' },
    });
    expect([r.status, issueCodes(r)]).toEqual([422, ["inherits_from_hidden"]]);
    expect(r.res.body).not.toContain(second);
    expect(r.res.body).not.toContain("second provenance");
    const now = await stored(file);
    expect(now).toMatchObject({ version: 3, state: "published" });
    const parent = await w.db.rows<{ parent_id: string }>(
      sql`SELECT parent_id::text AS parent_id FROM public.records WHERE id = ${file}::uuid`,
    );
    expect(parent[0]?.parent_id).toBe(seriesA);
    // The site manager, who sees both fonds, may.
    const manager = await call("POST", `/api/records/${file}/versions/1/restore`, {
      as: "manager",
      headers: { "if-match": '"v3"' },
    });
    expect(manager.status).toBe(200);
    expect(await stored(file)).toMatchObject({ version: 4, state: "published" });
  });
});

describe("a publication and an edit racing over HTTP (pinned with a row lock)", () => {
  /** Waits until `n` backends of this database wait on a lock. */
  async function waiters(n: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [row] = await w.db.rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if ((row?.n ?? 0) >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`fewer than ${String(n)} waiting`);
  }

  /** Holds the record's row FOR UPDATE until `release` is called. */
  async function hold(id: string): Promise<{ release: () => Promise<void> }> {
    let done!: () => void;
    const released = new Promise<void>((r) => (done = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = w.db.transaction(async (q) => {
      await q.execute(sql`SELECT 1 FROM public.records WHERE id = ${id}::uuid FOR UPDATE`);
      locked();
      await released;
    });
    await isLocked;
    return {
      release: async () => {
        done();
        await holder;
      },
    };
  }

  const edit = (id: string, title: string) =>
    call("PUT", `/api/records/${id}`, {
      as: "cataloger",
      headers: { "if-match": '"v1"' },
      body: { record: objectDraft(title) },
    });
  const publish = (id: string) =>
    call("POST", `/api/records/${id}/publish`, { as: "manager", headers: { "if-match": '"v1"' } });

  it("the edit first: it is saved, and the publication from the same version is a 412", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented raced object");
    const lock = await hold(target.id);
    const editing = edit(target.id, "Invented edited first");
    await waiters(1);
    const publishing = publish(target.id);
    await waiters(2);
    await lock.release();
    const [edited, published] = await Promise.all([editing, publishing]);
    expect(edited.status).toBe(200);
    expect([published.status, published.json.error]).toEqual([412, "version_conflict"]);
    expect(published.res.body).not.toContain("Invented edited first");
    expect(await stored(target.id)).toEqual({
      version: 2,
      state: "draft",
      title: "Invented edited first",
    });
  });

  it("the publication first: it is published, and the edit from the same version is a 412", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented raced object");
    const lock = await hold(target.id);
    const publishing = publish(target.id);
    await waiters(1);
    const editing = edit(target.id, "Invented edited second");
    await waiters(2);
    await lock.release();
    const [published, edited] = await Promise.all([publishing, editing]);
    expect([published.status, published.json.state]).toEqual([200, "published"]);
    expect([edited.status, edited.json.error]).toEqual([412, "version_conflict"]);
    expect(await stored(target.id)).toEqual({
      version: 2,
      state: "published",
      title: "Invented raced object",
    });
  });
});

describe("review fixes: what is read before and for a refusal (T-043 review B1, B2)", () => {
  /** A server whose service records the text of every statement its transactions send. */
  async function recording(options: Parameters<typeof createService>[1] = {}) {
    const texts: string[] = [];
    const db: Database = {
      rows: (q) => w.db.rows(q),
      execute: (q) => w.db.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) =>
        w.db.transaction((tx) => {
          const seen: Queryable = {
            rows: (q) => {
              texts.push(q.text);
              return tx.rows(q);
            },
            execute: (q) => {
              texts.push(q.text);
              return tx.execute(q);
            },
          };
          return work(seen);
        }),
    };
    const service = createService(db, options);
    const server = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({ db: w.db, service, log: (r) => logged.push(r) }),
    });
    return { texts, server };
  }
  const readsVersions = (texts: readonly string[]) =>
    texts.some((t) => t.includes("public.record_versions"));

  it("a restore of a record the person can't see, or may not restore, never reads its versions", async () => {
    const { texts, server } = await recording();
    try {
      const onA2 = await makeObject(w, w.a, w.a2, "Invented hidden restore");
      await retitle(onA2.id, 1, "Invented hidden restore, renamed");
      const inB = await makeObject(w, w.b, w.b1, "Invented other organization's restore");
      const mine = await makeObject(w, w.a, w.a1, "Invented visible restore");
      await retitle(mine.id, 1, "Invented visible restore, renamed");
      const headers = { "if-match": '"v2"' };
      for (const [as, id, status] of [
        ["manager", onA2.id, 404],
        ["cataloger", onA2.id, 404],
        ["manager", inB.id, 404],
        ["donor", mine.id, 404],
        ["reader", mine.id, 403],
        ["scanner", mine.id, 403],
      ] as const) {
        texts.length = 0;
        const r = await call(
          "POST",
          `/api/records/${id}/versions/1/restore`,
          { as, headers },
          server,
        );
        expect([as, r.status]).toEqual([as, status]);
        expect([as, readsVersions(texts)]).toEqual([as, false]);
      }
      // The control: an allowed restore does read the version.
      texts.length = 0;
      const allowed = await call(
        "POST",
        `/api/records/${mine.id}/versions/1/restore`,
        { as: "cataloger", headers },
        server,
      );
      expect(allowed.status).toBe(200);
      expect(readsVersions(texts)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the version list reads no snapshot: it still answers when a stored snapshot is broken", async () => {
    const { texts, server } = await recording();
    try {
      const target = await makeObject(w, w.a, w.a1, "Invented broken snapshot");
      await retitle(target.id, 1, "Invented broken snapshot, renamed");
      texts.length = 0;
      const list = await call(
        "GET",
        `/api/records/${target.id}/versions`,
        { as: "manager" },
        server,
      );
      expect(list.status).toBe(200);
      const versionReads = texts.filter((t) => t.includes("public.record_versions"));
      expect(versionReads.length).toBeGreaterThan(0);
      for (const t of versionReads) expect(t).not.toMatch(/\brecord\s*,/);
      // Break version 1's snapshot as the owner (the append-only trigger
      // off inside this transaction only, back on ALWAYS before COMMIT).
      await w.db.transaction(async (q) => {
        await q.execute(
          sql`ALTER TABLE public.record_versions DISABLE TRIGGER zzzz_record_versions_append_only`,
        );
        await q.execute(sql`
          UPDATE public.record_versions SET record = jsonb_set(record, '{title}', '7'::jsonb)
          WHERE record_id = ${target.id}::uuid AND version = 1`);
        await q.execute(
          sql`ALTER TABLE public.record_versions ENABLE ALWAYS TRIGGER zzzz_record_versions_append_only`,
        );
      });
      const after = await call("GET", `/api/records/${target.id}/versions`, { as: "manager" });
      expect(after.status).toBe(200);
      expect((after.json.versions as unknown[]).length).toBe(2);
      // Reading the broken version itself is a server fault, as before.
      const one = await call("GET", `/api/records/${target.id}/versions/1`, { as: "manager" });
      expect([one.status, one.json]).toEqual([500, { error: "internal_error" }]);
    } finally {
      await server.close();
    }
  });

  it("a restore whose record moves between its first look and its lock is 503 retry, writing nothing (S-030)", async () => {
    const target = await makeObject(w, w.a, w.a1, "Invented first title");
    // Just before the restore locks the row, another save lands: version 2.
    let moves = 1;
    const wrap = (tx: Queryable): Queryable => ({
      rows: async (q) => {
        if (
          moves > 0 &&
          q.text.includes("FOR NO KEY UPDATE") &&
          q.text.includes("public.records")
        ) {
          moves -= 1;
          await retitle(target.id, 1, "Invented second title");
        }
        return tx.rows(q);
      },
      execute: (q) => tx.execute(q),
    });
    const moving: Database = {
      rows: (q) => w.db.rows(q),
      execute: (q) => w.db.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) => w.db.transaction((tx) => work(wrap(tx))),
    };
    const once = createService(moving, { attempts: 1 });
    const server = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({ db: w.db, service: once, log: (r) => logged.push(r) }),
    });
    try {
      const r = await call(
        "POST",
        `/api/records/${target.id}/versions/1/restore`,
        { as: "cataloger", headers: { "if-match": '"v2"' }, body: {} },
        server,
      );
      expect([r.status, r.json]).toEqual([503, { error: "retry" }]);
      expect(await stored(target.id)).toMatchObject({ version: 2, title: "Invented second title" });
      // Asked again, it holds still and goes through.
      const again = await call(
        "POST",
        `/api/records/${target.id}/versions/1/restore`,
        { as: "cataloger", headers: { "if-match": '"v2"' }, body: {} },
        server,
      );
      expect(again.status).toBe(200);
      expect(await stored(target.id)).toMatchObject({ version: 3, title: "Invented first title" });
    } finally {
      await server.close();
    }
  });

  it("the approval queue's list is stopped by its statement_timeout (503)", async () => {
    const slow = createService(w.db, { searchTimeoutMs: 300 });
    const server = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({ db: w.db, service: slow, log: (r) => logged.push(r) }),
    });
    const blocker = openDatabase(w.testDb.url, { max: 1 });
    let release: () => void = () => undefined;
    try {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = blocker.transaction(async (q) => {
        await q.execute(sql`LOCK TABLE public.records IN ACCESS EXCLUSIVE MODE`);
        locked();
        await held;
      });
      await isLocked;
      const r = await call("GET", "/api/review-queue", { as: "manager" }, server);
      release();
      await holding;
      expect([r.status, r.json]).toEqual([503, { error: "timeout" }]);
    } finally {
      release();
      await blocker.close();
      await server.close();
    }
  });
});

describe("logs", () => {
  it("nothing logged by these routes holds a record's text or an ID", () => {
    const text = JSON.stringify(logged);
    expect(text).not.toContain("Invented");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
});
