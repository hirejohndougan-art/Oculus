// The staff JSON API over HTTP (T-042, D-079), against a fresh migrated
// database: every endpoint with no session, a session waiting for its second
// step, an expired session, CSRF missing or wrong, a foreign Origin, an
// oversized body and a wrong content type; then roles, sites, other
// organizations, missing against invisible records (identical replies),
// edit conflicts, the dry-run check, staff search with its timeout and cap,
// templates and identifier types with D-076's published-records gate, the
// per-session rate limit and the redacted error log. Every person, site and
// record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  csrfTokenFor,
  newRecordId,
  newSiteId,
  type OrganizationId,
  type UserId,
} from "@oculus/core";
import { openDatabase, sql } from "@oculus/db";
import { createService } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import {
  CSRF_HEADER,
  SITE_HEADER,
  redactedError,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import {
  OBJECT_FIELDS,
  actorOf,
  ageSession,
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
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

const INC = "http://rightsstatements.org/vocab/InC/1.0/";
const rights = { rights: { uri: INC } };
const unit = (
  level: string,
  title: string,
  parentId?: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "archival_unit",
  level,
  title,
  templateKey: "t-unit",
  fields: { ...rights },
  ...(parentId === undefined ? {} : { parentId }),
  ...extra,
});
const asset = (represents: string, title = "An invented scan") => ({
  kind: "digital_asset",
  mediaType: "image/tiff",
  represents,
  title,
  templateKey: "t-asset",
  fields: { ...rights },
});
const textField = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  kind: "text",
  required: false,
  repeatable: false,
  visibility: "public",
  inherited: false,
  ...extra,
});

let w: World;
let app: FastifyInstance;
const logged: ApiLogRecord[] = [];

/** Sessions by name, made once. */
const tokens: Record<string, string> = {};

async function serverFor(world: World, extra: Partial<Parameters<typeof staffApiRoutes>[0]> = {}) {
  return buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({
      db: world.db,
      service: world.service,
      log: (r) => logged.push(r),
      ...extra,
    }),
  });
}

beforeAll(async () => {
  w = await makeWorld({ onError: serviceErrorLogger((r) => logged.push(r)) });
  app = await serverFor(w);
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
  tokens.pending = (await pendingSession(w.db, w.cataloger, w.a)).token;
  const expired = await fullSession(w.db, w.cataloger, w.a);
  await ageSession(w.db, expired.sessionId, 13 * 3600);
  tokens.expired = expired.token;
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
  /** Send the session's CSRF token (default: for every method but GET). */
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

/** One request per endpoint, with a body that would be accepted. */
function endpoints(recordId: string): {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}[] {
  return [
    { method: "GET", url: "/api/session" },
    { method: "GET", url: `/api/records/${recordId}` },
    { method: "POST", url: "/api/records", body: { record: objectDraft() } },
    { method: "POST", url: "/api/records/check", body: { record: objectDraft() } },
    {
      method: "PUT",
      url: `/api/records/${recordId}`,
      body: { record: objectDraft("Changed") },
      headers: { "if-match": '"v1"' },
    },
    { method: "DELETE", url: `/api/records/${recordId}`, headers: { "if-match": '"v1"' } },
    { method: "GET", url: "/api/search?q=lantern" },
    { method: "GET", url: "/api/templates" },
    { method: "GET", url: "/api/templates/t-object" },
    {
      method: "PUT",
      url: "/api/templates/t-new",
      body: {
        template: { label: "New", appliesTo: ["object"], fields: OBJECT_FIELDS },
      },
      headers: { "if-none-match": "*" },
    },
    { method: "GET", url: "/api/identifier-types" },
    {
      method: "PUT",
      url: "/api/identifier-types/accession_number",
      body: { identifierType: { label: "Accession number", uniqueness: "all_time" } },
      headers: { "if-none-match": "*" },
    },
  ];
}

async function versionOf(id: string): Promise<number> {
  const rows = await w.db.rows<{ version: number }>(
    sql`SELECT version FROM public.records WHERE id = ${id}::uuid`,
  );
  return rows[0]?.version ?? 0;
}

describe("every endpoint refuses without a usable session", () => {
  it("no session, a session waiting for its second step, an expired one, a made-up token: 401", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id)) {
      for (const as of [undefined, "pending", "expired", "madeup"]) {
        if (as === "madeup") tokens.madeup = "A".repeat(43);
        const r = await call(e.method, e.url, {
          ...(as === undefined ? {} : { as }),
          ...(e.body === undefined ? {} : { body: e.body }),
          headers: e.headers ?? {},
        });
        expect([e.method, e.url, as, r.status, r.json]).toEqual([
          e.method,
          e.url,
          as,
          401,
          { error: "unauthenticated" },
        ]);
      }
    }
    // Nothing was changed by any of them.
    expect(await versionOf(target.id)).toBe(1);
    const made = await w.db.rows(sql`SELECT 1 FROM public.template_versions WHERE key = 't-new'`);
    expect(made).toEqual([]);
  });

  it("a waiting session can't read even its own session or CSRF token", async () => {
    const r = await call("GET", "/api/session", { as: "pending" });
    expect(r.status).toBe(401);
    expect(r.res.body).not.toContain("csrf");
  });

  it("every change needs the session's CSRF token: missing, wrong, another session's", async () => {
    const target = await makeObject(w, w.a, w.a1);
    const unsafe = endpoints(target.id).filter((e) => e.method !== "GET");
    for (const e of unsafe) {
      for (const csrf of [false, "x".repeat(43), csrfTokenFor(tokens.cataloger) ?? ""]) {
        const r = await call(e.method, e.url, {
          as: "manager",
          csrf,
          ...(e.body === undefined ? {} : { body: e.body }),
          headers: e.headers ?? {},
        });
        expect([e.url, r.status, r.json]).toEqual([e.url, 403, { error: "csrf_failed" }]);
      }
      // The manager's own token passes, so the refusals above were the token's.
    }
    expect(await versionOf(target.id)).toBe(1);
  });

  it("every change from a foreign Origin, or with no Origin, is refused before the handler", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id).filter((x) => x.method !== "GET")) {
      for (const origin of ["https://evil.example", null]) {
        const r = await call(e.method, e.url, {
          as: "manager",
          origin,
          ...(e.body === undefined ? {} : { body: e.body }),
          headers: e.headers ?? {},
        });
        expect([e.url, r.status, r.json]).toEqual([e.url, 403, { error: "cross_origin" }]);
      }
    }
    expect(await versionOf(target.id)).toBe(1);
  });

  it("oversized bodies (413) and wrong content types (415) are refused", async () => {
    const target = await makeObject(w, w.a, w.a1);
    for (const e of endpoints(target.id).filter((x) => x.method !== "GET")) {
      const big = await call(e.method, e.url, {
        as: "manager",
        payload: JSON.stringify({ record: { title: "x".repeat(1024 * 1024 + 10) } }),
        headers: { ...e.headers, "content-type": "application/json" },
      });
      expect([e.url, big.status, big.json]).toEqual([e.url, 413, { error: "payload_too_large" }]);
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/xml"]) {
        const r = await call(e.method, e.url, {
          as: "manager",
          payload: "record=1",
          headers: { ...e.headers, "content-type": type },
        });
        expect([e.url, type, r.status]).toEqual([e.url, type, 415]);
      }
    }
    expect(await versionOf(target.id)).toBe(1);
  });

  it("a body that isn't a JSON object, or has unknown keys, is refused", async () => {
    expect((await call("POST", "/api/records", { as: "cataloger", body: [1] })).json).toEqual({
      error: "bad_body",
    });
    const extra = await call("POST", "/api/records", {
      as: "cataloger",
      body: { record: objectDraft(), organizationId: w.b },
    });
    expect(extra.status).toBe(422);
    expect(issueCodes(extra)).toEqual(["unknown_property"]);
  });
});

describe("the session endpoint", () => {
  it("gives the CSRF token derived from the cookie and the session's organization", async () => {
    const r = await call("GET", "/api/session", { as: "cataloger" });
    expect(r.status).toBe(200);
    expect(r.json.csrfToken).toBe(csrfTokenFor(tokens.cataloger));
    expect(r.json.organizationId).toBe(w.a);
    expect(r.json.userId).toBe(w.cataloger);
    expect(r.res.headers["cache-control"]).toBe("no-store");
    expect(r.res.body).not.toContain(tokens.cataloger ?? "never");
  });
});

describe("records", () => {
  it("happy path: create, read with ETag, update with If-Match, delete", async () => {
    const created = await call("POST", "/api/records", {
      as: "manager",
      site: w.a1,
      body: { record: objectDraft("An invented kettle"), reason: "New find." },
    });
    expect(created.status).toBe(201);
    const record = created.json.record as { id: string; siteId: string; organizationId: string };
    expect(record.siteId).toBe(w.a1);
    expect(record.organizationId).toBe(w.a);
    expect(created.res.headers.etag).toBe('"v1"');
    expect(created.res.headers.location).toBe(`/api/records/${record.id}`);

    const read = await call("GET", `/api/records/${record.id}`, { as: "cataloger" });
    expect(read.status).toBe(200);
    expect(read.res.headers.etag).toBe('"v1"');
    expect((read.json.record as { title: string }).title).toBe("An invented kettle");

    const updated = await call("PUT", `/api/records/${record.id}`, {
      as: "cataloger",
      headers: { "if-match": '"v1"' },
      body: { record: objectDraft("An invented copper kettle") },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.version).toBe(2);
    expect(updated.json.changed).toBe(true);
    expect(updated.res.headers.etag).toBe('"v2"');

    const deleted = await call("DELETE", `/api/records/${record.id}`, {
      as: "manager",
      headers: { "if-match": '"v2"' },
      body: { reason: "Entered twice." },
    });
    expect(deleted.status).toBe(200);
    const gone = await call("GET", `/api/records/${record.id}`, { as: "manager" });
    expect([gone.status, gone.json]).toEqual([404, { error: "not_found" }]);
  });

  it("an edit conflict is 412 with the names-only conflict; If-Match is required and checked", async () => {
    const target = await makeObject(w, w.a, w.a1);
    ok(
      await w.service.updateRecord(
        { organizationId: w.a, actor: actorOf(w.root) },
        target.id as never,
        objectDraft("Saved by someone else"),
        { expectedVersion: 1 },
      ),
    );
    const stale = await call("PUT", `/api/records/${target.id}`, {
      as: "cataloger",
      headers: { "if-match": '"v1"' },
      body: { record: objectDraft("Mine") },
    });
    expect(stale.status).toBe(412);
    expect(stale.json.error).toBe("version_conflict");
    expect(issueCodes(stale)).toEqual(["version_conflict"]);
    expect(stale.json.conflict).toBeDefined();
    expect(JSON.stringify(stale.json.conflict)).not.toContain("Saved by someone else");

    const none = await call("PUT", `/api/records/${target.id}`, {
      as: "cataloger",
      body: { record: objectDraft("Mine") },
    });
    expect([none.status, none.json]).toEqual([428, { error: "precondition_required" }]);
    for (const bad of ['W/"v2"', "v2", '"v0"', '"v2", "v3"', '"x"', "*"]) {
      const r = await call("PUT", `/api/records/${target.id}`, {
        as: "cataloger",
        headers: { "if-match": bad },
        body: { record: objectDraft("Mine") },
      });
      expect([bad, r.status, r.json]).toEqual([bad, 400, { error: "bad_if_match" }]);
    }
    const del = await call("DELETE", `/api/records/${target.id}`, { as: "manager" });
    expect(del.status).toBe(428);
    const delStale = await call("DELETE", `/api/records/${target.id}`, {
      as: "manager",
      headers: { "if-match": '"v1"' },
    });
    expect(delStale.status).toBe(412);
    expect(await versionOf(target.id)).toBe(2);
  });

  it("a missing record and one the person can't see get the identical reply", async () => {
    const onA2 = await makeObject(w, w.a, w.a2, "On the second site");
    const inB = await makeObject(w, w.b, w.b1, "In the library");
    const shapes = [
      (id: string) => ["GET", `/api/records/${id}`, {}] as const,
      (id: string) =>
        [
          "PUT",
          `/api/records/${id}`,
          { headers: { "if-match": '"v1"' }, body: { record: objectDraft("x") } },
        ] as const,
      (id: string) =>
        ["DELETE", `/api/records/${id}`, { headers: { "if-match": '"v1"' } }] as const,
      (id: string) =>
        [
          "POST",
          "/api/records/check",
          { body: { record: objectDraft("x"), recordId: id } },
        ] as const,
    ];
    for (const shape of shapes) {
      const replies = [];
      for (const id of [newRecordId(), onA2.id, inB.id, "not-a-uuid"]) {
        // The cataloger of A1 (A2's record is another site's; B's another organization's).
        const [method, url, extra] = shape(id);
        const r = await call(method, url, { as: "manager", ...extra });
        const headers = { ...r.res.headers };
        delete headers.date;
        replies.push({ status: r.status, body: r.res.body, headers });
      }
      expect(replies[0]?.status).toBe(404);
      expect(replies[0]?.body).toBe('{"error":"not_found"}');
      for (const reply of replies.slice(1)) expect(reply).toEqual(replies[0]);
    }
    expect(await versionOf(onA2.id)).toBe(1);
    expect(await versionOf(inB.id)).toBe(1);
  });

  it("the wrong role: read-only can read but not create, edit or delete", async () => {
    const target = await makeObject(w, w.a, w.a1);
    expect((await call("GET", `/api/records/${target.id}`, { as: "reader" })).status).toBe(200);
    const create = await call("POST", "/api/records", {
      as: "reader",
      site: w.a1,
      body: { record: objectDraft() },
    });
    expect([create.status, create.json]).toEqual([403, { error: "not_permitted" }]);
    const edit = await call("PUT", `/api/records/${target.id}`, {
      as: "reader",
      headers: { "if-match": '"v1"' },
      body: { record: objectDraft("No") },
    });
    expect([edit.status, edit.json]).toEqual([403, { error: "not_permitted" }]);
    const del = await call("DELETE", `/api/records/${target.id}`, {
      as: "cataloger",
      headers: { "if-match": '"v1"' },
    });
    expect([del.status, del.json]).toEqual([403, { error: "not_permitted" }]);
    expect(await versionOf(target.id)).toBe(1);
  });

  it("the wrong site: a working site they have no role on, another organization's, a made-up one", async () => {
    for (const site of [w.a2, w.b1, newSiteId()]) {
      const r = await call("POST", "/api/records", {
        as: "cataloger",
        site,
        body: { record: objectDraft("Elsewhere") },
      });
      expect(r.status).toBe(422);
      expect(issueCodes(r)).toEqual(["unknown_site"]);
    }
    const malformed = await call("POST", "/api/records", {
      as: "cataloger",
      site: "A1",
      body: { record: objectDraft() },
    });
    expect([malformed.status, issueCodes(malformed)]).toEqual([422, ["invalid_site"]]);
    // A draft naming another organization is refused; the session's organization decides.
    const named = await call("POST", "/api/records", {
      as: "cataloger",
      site: w.a1,
      body: { record: { ...objectDraft(), organizationId: w.b } },
    });
    expect([named.status, issueCodes(named)]).toEqual([422, ["wrong_organization"]]);
  });

  it("another organization's member never reaches this organization's records", async () => {
    const target = await makeObject(w, w.a, w.a1);
    const r = await call("GET", `/api/records/${target.id}`, { as: "stranger" });
    expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
    // Their records go to their own organization, whatever the site header says.
    const made = await call("POST", "/api/records", {
      as: "stranger",
      site: w.a1,
      body: { record: objectDraft() },
    });
    expect([made.status, issueCodes(made)]).toEqual([422, ["unknown_site"]]);
  });

  it("a draft that fails core's checks is 422 with core's issues", async () => {
    const r = await call("POST", "/api/records", {
      as: "cataloger",
      site: w.a1,
      body: { record: { ...objectDraft(), fields: { note: 7 } } },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("invalid");
    expect(issueCodes(r).length).toBeGreaterThan(0);
    expect(r.res.body).not.toMatch(/stack|at .*\.ts|SELECT|public\./);
  });
});

describe("the dry-run check", () => {
  it("returns core's issues for a draft and writes nothing", async () => {
    const before = await w.db.rows(sql`SELECT count(*)::int AS n FROM public.records`);
    const good = await call("POST", "/api/records/check", {
      as: "cataloger",
      site: w.a1,
      body: { record: objectDraft() },
    });
    expect([good.status, good.json]).toEqual([200, { issues: [] }]);
    const bad = await call("POST", "/api/records/check", {
      as: "cataloger",
      site: w.a1,
      body: { record: { ...objectDraft(), fields: { note: 7, unknown_field: "x" } } },
    });
    expect(bad.status).toBe(200);
    expect((bad.json.issues as unknown[]).length).toBeGreaterThan(0);
    const target = await makeObject(w, w.a, w.a1);
    const existing = await call("POST", "/api/records/check", {
      as: "cataloger",
      body: { record: { ...objectDraft(), title: "" }, recordId: target.id },
    });
    expect(existing.status).toBe(200);
    expect((existing.json.issues as unknown[]).length).toBeGreaterThan(0);
    const after = await w.db.rows(sql`SELECT count(*)::int AS n FROM public.records`);
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n + 1);
    expect(await versionOf(target.id)).toBe(1);
  });

  it("B1: a new parent or represented record out of sight is answered as a missing one, byte for byte", async () => {
    // The cataloger of A1 edits A1 records; A2's are out of sight.
    const fondsA1 = await makeAs(w, w.a, w.a1, unit("fonds", "Fonds on A1"));
    const seriesA1 = await makeAs(w, w.a, w.a1, unit("series", "Series on A1", fondsA1));
    const fondsA2 = await makeAs(w, w.a, w.a2, unit("fonds", "Fonds on A2"));
    const seriesA2 = await makeAs(w, w.a, w.a2, unit("series", "Series on A2", fondsA2));
    const objA1 = await makeObject(w, w.a, w.a1, "Object on A1");
    const objA2 = await makeObject(w, w.a, w.a2, "Object on A2");
    const scan = await makeAs(w, w.a, w.a1, asset(objA1.id));
    const replies = async (draft: (target: string) => unknown, recordId: string) => {
      const out = [];
      // Missing, another site's unit at the same level, at another level, another site's object.
      for (const target of [newRecordId(), fondsA2, seriesA2, objA2.id]) {
        const r = await call("POST", "/api/records/check", {
          as: "cataloger",
          body: { record: draft(target), recordId },
        });
        out.push({ status: r.status, body: r.res.body });
      }
      return out;
    };
    const parents = await replies((t) => unit("series", "Series on A1", t), seriesA1);
    expect(parents[0]?.status).toBe(200);
    expect(parents[0]?.body).toContain("missing_parent");
    for (const r of parents.slice(1)) expect(r).toEqual(parents[0]);
    const scans = await replies((t) => asset(t), scan);
    expect(scans[0]?.status).toBe(200);
    expect(scans[0]?.body).toContain("unknown_record");
    for (const r of scans.slice(1)) expect(r).toEqual(scans[0]);
    // A visible parent still checks normally.
    const ok1 = await call("POST", "/api/records/check", {
      as: "cataloger",
      body: { record: unit("series", "Series on A1", fondsA1), recordId: seriesA1 },
    });
    expect(ok1.json).toEqual({ issues: [] });
  });

  it("is refused as the save would be: read-only may not check a new record", async () => {
    const r = await call("POST", "/api/records/check", {
      as: "reader",
      site: w.a1,
      body: { record: objectDraft() },
    });
    expect([r.status, r.json]).toEqual([403, { error: "not_permitted" }]);
  });
});

describe("staff search", () => {
  it("finds only records on the person's sites, never another site's or organization's", async () => {
    const word = `zephyrine${String(Date.now())}`;
    const mine = await makeObject(w, w.a, w.a1, `A ${word} lamp`);
    const theirs = await makeObject(w, w.a, w.a2, `A ${word} lamp`);
    const outside = await makeObject(w, w.b, w.b1, `A ${word} lamp`);
    const ids = async (as: string) => {
      const r = await call("GET", `/api/search?q=${word}`, { as });
      expect(r.status).toBe(200);
      return ((r.json.hits ?? []) as { recordId: string }[]).map((h) => h.recordId).sort();
    };
    expect(await ids("cataloger")).toEqual([mine.id]);
    expect(await ids("other")).toEqual([theirs.id]);
    expect(await ids("root")).toEqual([mine.id, theirs.id].sort());
    expect(await ids("stranger")).toEqual([outside.id]);
    // A page of one with hidden matches beside it gives no cursor that hints at them.
    const one = await call("GET", `/api/search?q=${word}&limit=1`, { as: "cataloger" });
    expect(one.json.next).toBeUndefined();
  });

  it("checks the query: missing, repeated, a limit over the cap", async () => {
    expect((await call("GET", "/api/search", { as: "cataloger" })).json).toEqual({
      error: "bad_query",
    });
    expect((await call("GET", "/api/search?q=a&q=b", { as: "cataloger" })).status).toBe(400);
    for (const limit of ["0", "101", "-1", "1.5", "abc"]) {
      const r = await call("GET", `/api/search?q=lamp&limit=${limit}`, { as: "cataloger" });
      expect([limit, r.status]).toEqual([limit, 400]);
    }
    expect((await call("GET", "/api/search?q=lamp&limit=100", { as: "cataloger" })).status).toBe(
      200,
    );
    const long = await call("GET", `/api/search?q=${"a".repeat(501)}`, { as: "cataloger" });
    expect([long.status, issueCodes(long)]).toEqual([422, ["query_too_long"]]);
  });

  it("a search that runs too long is stopped by its statement_timeout (503 search_timeout)", async () => {
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
      const started = Date.now();
      const r = await call("GET", "/api/search?q=lamp", { as: "cataloger" }, server);
      release();
      await holding;
      expect([r.status, r.json]).toEqual([503, { error: "search_timeout" }]);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      release();
      await blocker.close();
      await server.close();
    }
  });

  it("read-only may search; a role without records.view may not", async () => {
    expect((await call("GET", "/api/search?q=lamp", { as: "reader" })).status).toBe(200);
    const donor = await call("GET", "/api/search?q=lamp", { as: "donor" });
    expect([donor.status, donor.json]).toEqual([403, { error: "not_permitted" }]);
  });
});

describe("templates", () => {
  it("lists and reads for anyone who sees records; ETag is the version", async () => {
    const list = await call("GET", "/api/templates", { as: "reader" });
    expect(list.status).toBe(200);
    expect((list.json.templates as { key: string }[]).map((t) => t.key)).toContain("t-object");
    const one = await call("GET", "/api/templates/t-object", { as: "cataloger" });
    expect([one.status, one.res.headers.etag]).toEqual([200, '"v1"']);
    const missing = await call("GET", "/api/templates/t-nothing", { as: "cataloger" });
    expect([missing.status, missing.json]).toEqual([404, { error: "not_found" }]);
    // Another organization's template with the same key is its own.
    const theirs = await call("GET", "/api/templates/t-object", { as: "stranger" });
    expect((theirs.json.template as { organizationId: string }).organizationId).toBe(w.b);
  });

  it("a role that sees no records reads no definitions", async () => {
    for (const url of ["/api/templates", "/api/templates/t-object", "/api/identifier-types"]) {
      const r = await call("GET", url, { as: "donor" });
      expect([url, r.status, r.json]).toEqual([url, 403, { error: "not_permitted" }]);
    }
    const target = await makeObject(w, w.a, w.a1);
    const read = await call("GET", `/api/records/${target.id}`, { as: "donor" });
    expect([read.status, read.json]).toEqual([404, { error: "not_found" }]);
  });

  it("only system managers save definitions (John, 2026-11-24): a site manager and a cataloger are refused", async () => {
    for (const as of ["manager", "cataloger"]) {
      const types = await call("PUT", "/api/identifier-types/site_number", {
        as,
        headers: { "if-none-match": "*" },
        body: { identifierType: { label: "Site number", uniqueness: "none" } },
      });
      expect([as, types.status, types.json]).toEqual([as, 403, { error: "not_permitted" }]);
      const one = await call("PUT", "/api/templates/t-object", {
        as,
        headers: { "if-match": '"v1"' },
        body: { template: { label: "Object", appliesTo: ["object"], fields: OBJECT_FIELDS } },
      });
      expect([as, one.status, one.json]).toEqual([as, 403, { error: "not_permitted" }]);
    }
    const r = await call("PUT", "/api/templates/t-cat", {
      as: "cataloger",
      headers: { "if-none-match": "*" },
      body: { template: { label: "Cat", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect([r.status, r.json]).toEqual([403, { error: "not_permitted" }]);
  });

  it("new (If-None-Match: *), then a new version (If-Match), with conflicts", async () => {
    const made = await call("PUT", "/api/templates/t-made", {
      as: "root",
      headers: { "if-none-match": "*" },
      body: { template: { label: "Made", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect([made.status, made.res.headers.etag]).toEqual([201, '"v1"']);
    const again = await call("PUT", "/api/templates/t-made", {
      as: "root",
      headers: { "if-none-match": "*" },
      body: { template: { label: "Made", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect([again.status, again.json.error]).toEqual([412, "version_conflict"]);
    const next = await call("PUT", "/api/templates/t-made", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { template: { label: "Made again", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect([next.status, next.res.headers.etag]).toEqual([200, '"v2"']);
    const stale = await call("PUT", "/api/templates/t-made", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { template: { label: "Stale", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect(stale.status).toBe(412);
    const wrongKey = await call("PUT", "/api/templates/t-made", {
      as: "root",
      headers: { "if-match": '"v2"' },
      body: { template: { key: "t-other", label: "X", appliesTo: ["object"], fields: [] } },
    });
    expect([wrongKey.status, issueCodes(wrongKey)]).toEqual([422, ["wrong_key"]]);
    const neither = await call("PUT", "/api/templates/t-made", {
      as: "root",
      body: { template: { label: "X", appliesTo: ["object"], fields: OBJECT_FIELDS } },
    });
    expect(neither.status).toBe(428);
  });

  it("D-076: making a field public lists the published records affected and needs records.publish and confirmation", async () => {
    // A template of its own, with a published record holding a staff value.
    const tKey = "t-gate";
    ok(
      await w.service.saveTemplate(
        { organizationId: w.a, actor: actorOf(w.root) },
        { key: tKey, label: "Gate", appliesTo: ["object"], fields: OBJECT_FIELDS },
        { expectedVersion: 0 },
      ),
    );
    const rootCtx = (siteId: string) => ({ organizationId: w.a, actor: actorOf(w.root), siteId });
    const published = ok(
      await w.service.createRecord(rootCtx(w.a1) as never, {
        ...objectDraft("A published lantern"),
        templateKey: tKey,
      }),
    );
    ok(
      await w.service.publish(rootCtx(w.a1) as never, published.record.id, { expectedVersion: 1 }),
    );
    const opened = OBJECT_FIELDS.map((f) =>
      f.key === "secret" ? { ...f, visibility: "public" } : f,
    );
    const body = { template: { label: "Gate", appliesTo: ["object"], fields: opened } };

    // A cataloger: no definitions permission.
    const cat = await call("PUT", `/api/templates/${tKey}`, {
      as: "cataloger",
      headers: { "if-match": '"v1"' },
      body,
    });
    expect(cat.status).toBe(403);

    // The manager of A1 may publish there: told what would change, then confirms.
    const first = await call("PUT", `/api/templates/${tKey}`, {
      as: "root",
      headers: { "if-match": '"v1"' },
      body,
    });
    expect(first.status).toBe(409);
    expect(first.json.error).toBe("confirmation_required");
    expect(issueCodes(first)).toEqual(["publishes_records", "published_record_affected"]);
    expect(JSON.stringify(first.json.issues)).toContain(published.record.id);
    const confirmedPublished = await call("PUT", `/api/templates/${tKey}`, {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { ...body, confirmPublished: true },
    });
    expect(confirmedPublished.status).toBe(409);
    expect(issueCodes(confirmedPublished)).toContain("needs_confirmation");
    const confirm = (
      (confirmedPublished.json.issues ?? []) as { path: string[]; code: string }[]
    ).map((i) => ({ code: i.path[1], key: i.path[2] }));
    const saved = await call("PUT", `/api/templates/${tKey}`, {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { ...body, confirm, confirmPublished: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.publishedRecords).toEqual([published.record.id]);
    expect(saved.json.version).toBe(2);
  });

  it("B2: a new public inherited key on a published child's template counts the child", async () => {
    const root = { organizationId: w.a, actor: actorOf(w.root) };
    ok(
      await w.service.saveTemplate(
        root,
        {
          key: "t-b2-fonds",
          label: "Fonds",
          appliesTo: ["archival_unit"],
          fields: [
            textField("rights", { kind: "rights" }),
            textField("provenance", { inherited: true }),
          ],
        },
        { expectedVersion: 0 },
      ),
    );
    const childFields = [textField("rights", { kind: "rights" })];
    ok(
      await w.service.saveTemplate(
        root,
        { key: "t-b2-series", label: "Series", appliesTo: ["archival_unit"], fields: childFields },
        { expectedVersion: 0 },
      ),
    );
    // The parent (unpublished) holds a provenance; the child is published.
    const parent = await makeAs(w, w.a, w.a1, {
      ...unit("fonds", "Unpublished fonds"),
      templateKey: "t-b2-fonds",
      fields: { ...rights, provenance: "Given by an invented donor." },
    });
    const child = await makeAs(w, w.a, w.a1, {
      ...unit("series", "Published series", parent),
      templateKey: "t-b2-series",
    });
    await publishAs(w, w.a, child);
    const opened = [...childFields, textField("provenance", { inherited: true })];
    const r = await call("PUT", "/api/templates/t-b2-series", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: { template: { label: "Series", appliesTo: ["archival_unit"], fields: opened } },
    });
    expect(r.status).toBe(409);
    expect(issueCodes(r).slice(0, 2)).toEqual(["publishes_records", "published_record_affected"]);
    expect(JSON.stringify(r.json.issues)).toContain(child);
  });

  it("B3: removing a stopper key from an intermediate template counts the published leaf below", async () => {
    const root = { organizationId: w.a, actor: actorOf(w.root) };
    const rightsField = textField("rights", { kind: "rights" });
    const make = async (key: string, fields: unknown[]) =>
      ok(
        await w.service.saveTemplate(
          root,
          { key, label: key, appliesTo: ["archival_unit"], fields },
          { expectedVersion: 0 },
        ),
      );
    await make("t-b3-top", [rightsField, textField("provenance", { inherited: true })]);
    await make("t-b3-mid", [rightsField, textField("provenance", { visibility: "staff" })]);
    await make("t-b3-leaf", [rightsField]);
    const top = await makeAs(w, w.a, w.a1, {
      ...unit("fonds", "Top"),
      templateKey: "t-b3-top",
      fields: { ...rights, provenance: "An invented provenance." },
    });
    const mid = await makeAs(w, w.a, w.a1, {
      ...unit("series", "Middle", top),
      templateKey: "t-b3-mid",
    });
    const leaf = await makeAs(w, w.a, w.a1, {
      ...unit("file", "Leaf", mid),
      templateKey: "t-b3-leaf",
    });
    await publishAs(w, w.a, leaf);
    const r = await call("PUT", "/api/templates/t-b3-mid", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: {
        template: { label: "t-b3-mid", appliesTo: ["archival_unit"], fields: [rightsField] },
      },
    });
    expect(r.status).toBe(409);
    expect(issueCodes(r).slice(0, 2)).toEqual(["publishes_records", "published_record_affected"]);
    expect(JSON.stringify(r.json.issues)).toContain(leaf);
    // A change that leaves the public shape alone (a label) asks nothing of published records.
    const label = await call("PUT", "/api/templates/t-b3-leaf", {
      as: "root",
      headers: { "if-match": '"v1"' },
      body: {
        template: { label: "Leaf, renamed", appliesTo: ["archival_unit"], fields: [rightsField] },
      },
    });
    expect(label.status).toBe(200);
    expect(label.json.publishedRecords).toEqual([]);
  });
});

describe("identifier types", () => {
  it("lists with tags; creates with If-None-Match; updates with the tag; stale tags are 412", async () => {
    const list = await call("GET", "/api/identifier-types", { as: "reader" });
    expect(list.status).toBe(200);
    const listed = list.json.identifierTypes as { type: { key: string }; tag: string }[];
    expect(listed.map((t) => t.type.key)).toEqual(["object_number"]);

    const made = await call("PUT", "/api/identifier-types/loan_number", {
      as: "root",
      headers: { "if-none-match": "*" },
      body: { identifierType: { label: "Loan number", uniqueness: "current" } },
    });
    expect(made.status).toBe(201);
    const tag = made.json.tag as string;
    expect(made.res.headers.etag).toBe(`"t-${tag}"`);

    const changed = await call("PUT", "/api/identifier-types/loan_number", {
      as: "root",
      headers: { "if-match": `"t-${tag}"` },
      body: { identifierType: { label: "Loan no.", uniqueness: "current" } },
    });
    expect(changed.status).toBe(200);
    const stale = await call("PUT", "/api/identifier-types/loan_number", {
      as: "root",
      headers: { "if-match": `"t-${tag}"` },
      body: { identifierType: { label: "Stale", uniqueness: "current" } },
    });
    expect([stale.status, stale.json.error]).toEqual([412, "version_conflict"]);
    const byCataloger = await call("PUT", "/api/identifier-types/other_number", {
      as: "cataloger",
      headers: { "if-none-match": "*" },
      body: { identifierType: { label: "Other", uniqueness: "none" } },
    });
    expect([byCataloger.status, byCataloger.json]).toEqual([403, { error: "not_permitted" }]);
    // Another organization's list doesn't show this one's new type.
    const theirs = await call("GET", "/api/identifier-types", { as: "stranger" });
    const theirKeys = (theirs.json.identifierTypes as { type: { key: string } }[]).map(
      (t) => t.type.key,
    );
    expect(theirKeys).toEqual(["object_number"]);
  });

  it("D-076: making a number type public lists the published records holding one", async () => {
    const ctx = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    const made = ok(await w.service.createRecord(ctx as never, objectDraft("Numbered")));
    ok(
      await w.service.saveIdentifiers(ctx as never, made.record.id, {
        current: [{ type: "object_number", value: "INV-0001", primary: true }],
        former: [],
      }),
    );
    ok(await w.service.publish(ctx as never, made.record.id, { expectedVersion: 1 }));
    const list = await call("GET", "/api/identifier-types", { as: "root" });
    const entry = (list.json.identifierTypes as { type: { key: string }; tag: string }[]).find(
      (t) => t.type.key === "object_number",
    );
    const body = {
      identifierType: { label: "Object number", uniqueness: "all_time", public: true },
    };
    const first = await call("PUT", "/api/identifier-types/object_number", {
      as: "root",
      headers: { "if-match": `"t-${entry?.tag ?? ""}"` },
      body,
    });
    expect(first.status).toBe(409);
    expect(issueCodes(first)).toEqual(["publishes_records", "published_record_affected"]);
    const second = await call("PUT", "/api/identifier-types/object_number", {
      as: "root",
      headers: { "if-match": `"t-${entry?.tag ?? ""}"` },
      body: { ...body, confirmPublished: true },
    });
    expect(second.status).toBe(409);
    const confirm = ((second.json.issues ?? []) as { path: string[] }[]).map((i) => ({
      code: i.path[1],
      key: i.path[2],
    }));
    const saved = await call("PUT", "/api/identifier-types/object_number", {
      as: "root",
      headers: { "if-match": `"t-${entry?.tag ?? ""}"` },
      body: { ...body, confirm, confirmPublished: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.publishedRecords).toEqual([made.record.id]);
  });
  it("B4: published records below a holder count when a number type goes public", async () => {
    const ctx = { organizationId: w.a, actor: actorOf(w.root), siteId: w.a1 };
    ok(
      await w.service.saveIdentifierType(
        { organizationId: w.a, actor: actorOf(w.root) },
        { key: "box_number", label: "Box number", uniqueness: "current" },
        { expectedTag: null },
      ),
    );
    const holder = await makeAs(w, w.a, w.a1, unit("fonds", "Holder fonds"));
    ok(
      await w.service.saveIdentifiers(ctx as never, holder as never, {
        current: [{ type: "box_number", value: "BOX-1", primary: true }],
        former: [],
      }),
    );
    const child = await makeAs(w, w.a, w.a1, unit("series", "Published child", holder));
    await publishAs(w, w.a, child);
    const list = await call("GET", "/api/identifier-types", { as: "root" });
    const entry = (list.json.identifierTypes as { type: { key: string }; tag: string }[]).find(
      (t) => t.type.key === "box_number",
    );
    const r = await call("PUT", "/api/identifier-types/box_number", {
      as: "root",
      headers: { "if-match": `"t-${entry?.tag ?? ""}"` },
      body: { identifierType: { label: "Box number", uniqueness: "current", public: true } },
    });
    expect(r.status).toBe(409);
    expect(issueCodes(r).slice(0, 2)).toEqual(["publishes_records", "published_record_affected"]);
    expect(JSON.stringify(r.json.issues)).toContain(child);
    expect(JSON.stringify(r.json.issues)).not.toContain(holder);
  });
});

describe("rate limit and the error log", () => {
  it("a session over its limit gets 429; another session is unaffected", async () => {
    let now = 1_000_000;
    const server = await serverFor(w, { rateLimits: { read: 3 }, clock: () => now });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await call("GET", "/api/templates", { as: "reader" }, server)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect((await call("GET", "/api/templates", { as: "cataloger" }, server)).status).toBe(200);
      now += 60_000;
      expect((await call("GET", "/api/templates", { as: "reader" }, server)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("redacts errors to the class name and code: never a message, detail, where or value", () => {
    const error = Object.assign(new Error('duplicate key value violates "secret@example.org"'), {
      code: "23505",
      detail: "Key (email)=(secret@example.org) already exists.",
      where: "unnamed portal with parameters: $1 = 'secret@example.org'",
    });
    const logged: ApiLogRecord[] = [];
    serviceErrorLogger((r) => logged.push(r))(error, "createRecord");
    expect(logged).toEqual([
      { event: "service_error", operation: "createRecord", name: "Error", code: "23505" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("secret");
    expect(redactedError({ code: "not a code", message: "x" })).toEqual({ name: "Object" });
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );
    expect(() => redactedError(trap)).not.toThrow();
  });

  it("a database failure inside the service is a fixed 500, logged redacted", async () => {
    const before = logged.length;
    const target = await makeObject(w, w.a, w.a1);
    // Break the service's database role for one call: a revoked SELECT is 42501.
    const broken = createService(
      {
        ...w.db,
        transaction: () =>
          Promise.reject(Object.assign(new Error("boom with secret-value"), { code: "XX000" })),
      },
      { onError: serviceErrorLogger((r) => logged.push(r)) },
    );
    const server = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({ db: w.db, service: broken, log: (r) => logged.push(r) }),
    });
    try {
      const r = await call("GET", `/api/records/${target.id}`, { as: "cataloger" }, server);
      expect([r.status, r.json]).toEqual([500, { error: "internal_error" }]);
      expect(r.res.body).not.toContain("boom");
      const fresh = logged.slice(before);
      expect(fresh).toContainEqual({
        event: "service_error",
        operation: "readRecord",
        name: "Error",
        code: "XX000",
      });
      expect(JSON.stringify(fresh)).not.toContain("secret-value");
    } finally {
      await server.close();
    }
  });
});
