// A template's stored Dublin Core mapping over HTTP (T-050b, D-096):
// `GET`/`PUT /api/templates/:key/dublin-core`. Anyone who may read
// templates reads it (version 0 and null before the first save); only a
// system manager saves it (D-072), from the version it started from, and a
// change shown at once on published records is a 409 until confirmed
// (D-076). Every person and record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
import type { FastifyInstance } from "fastify";
import { sql } from "@oculus/db";
import { createService } from "@oculus/service";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import { fullSession, makeObject, makeWorld, publishAs, type World } from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld();
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
  });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("stranger", w.stranger, w.b);
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

async function call(
  method: "GET" | "PUT",
  url: string,
  as: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const token = tokens[as] ?? "";
  const res = await app.inject({
    method,
    url,
    headers: {
      origin: SAME_ORIGIN.origin,
      cookie: `${OCULUS_COOKIES.session}=${token}`,
      ...(method === "GET" ? {} : { [CSRF_HEADER]: csrfTokenFor(token) ?? "" }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.json<Record<string, unknown>>(), res };
}

const URL_OBJECT = "/api/templates/t-object/dublin-core";
const MAPPING = {
  entries: [
    { field: "rights", term: "rights" },
    { field: "note", term: "description" },
  ],
};
const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

describe("a template's Dublin Core mapping", () => {
  it("reads as version 0 and null before the first save, for anyone who may read templates", async () => {
    const read = await call("GET", URL_OBJECT, "cataloger");
    expect([read.status, read.json]).toEqual([200, { key: "t-object", version: 0, mapping: null }]);
    expect(read.res.headers.etag).toBeUndefined();
  });

  it("only a system manager saves it; a site manager and a cataloger are refused", async () => {
    for (const who of ["manager", "cataloger"]) {
      const r = await call("PUT", URL_OBJECT, who, { mapping: MAPPING }, { "if-none-match": "*" });
      expect([who, r.status, r.json]).toEqual([who, 403, { error: "not_permitted" }]);
    }
  });

  it("saves the first version, then the next from If-Match; a stale edit is 412, none 428", async () => {
    const none = await call("PUT", URL_OBJECT, "root", { mapping: MAPPING });
    expect(none.status).toBe(428);
    const first = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: MAPPING },
      { "if-none-match": "*" },
    );
    expect(first.status).toBe(201);
    expect(first.res.headers.etag).toBe('"v1"');
    expect(first.json.mapping).toMatchObject({ template: "t-object", organizationId: w.a });
    const again = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: MAPPING },
      { "if-none-match": "*" },
    );
    expect(again.status).toBe(412);
    const next = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: MAPPING },
      { "if-match": '"v1"' },
    );
    expect([next.status, next.json.version]).toEqual([200, 2]);
    const read = await call("GET", URL_OBJECT, "cataloger");
    expect(read.res.headers.etag).toBe('"v2"');
    expect(read.json.version).toBe(2);
  });

  it("a version too big for the service is a malformed If-Match, 400 (S-032)", async () => {
    for (const tag of ['"v2147483647"', '"v9999999999"']) {
      const r = await call("PUT", URL_OBJECT, "root", { mapping: MAPPING }, { "if-match": tag });
      expect([tag, r.status, r.json]).toEqual([tag, 400, { error: "bad_if_match" }]);
    }
  });

  it("refuses a staff field, unknown keys, an unknown template and another organization's member", async () => {
    const staff = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: { entries: [...MAPPING.entries, { field: "secret", term: "abstract" }] } },
      { "if-match": '"v2"' },
    );
    expect(staff.status).toBe(422);
    const extra = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: MAPPING, publish: true },
      { "if-match": '"v2"' },
    );
    expect(extra.status).toBe(422);
    const unknown = await call("GET", "/api/templates/no-such/dublin-core", "cataloger");
    expect([unknown.status, unknown.json]).toEqual([404, { error: "not_found" }]);
    // B's member reads B's own template of that key, never A's mapping.
    const stranger = await call("GET", URL_OBJECT, "stranger");
    expect(stranger.json.version).toBe(0);
  });

  it("a change shown at once on published records is 409 until confirmed", async () => {
    const record = await makeObject(w, w.a, w.a1, "An invented published lantern");
    await publishAs(w, w.a, record.id);
    const changed = { entries: [MAPPING.entries[0]] };
    const asked = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: changed },
      { "if-match": '"v2"' },
    );
    expect(asked.status).toBe(409);
    expect(asked.json.error).toBe("confirmation_required");
    expect(codes(asked)).toContain("publishes_records");
    const confirmed = await call(
      "PUT",
      URL_OBJECT,
      "root",
      { mapping: changed, confirmPublished: true },
      { "if-match": '"v2"' },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.publishedRecords).toContain(record.id);
  });
});

describe("a change on more published records than can be listed (S-039)", () => {
  it("is confirmed by its exact count, asked again when the count is out of date", async () => {
    // The same database, a service that lists at most one record.
    const small = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({
        db: w.db,
        service: createService(w.db, { maxListedPublished: 1 }),
        log: () => undefined,
      }),
    });
    try {
      for (const title of ["An invented published kettle", "An invented published jug"]) {
        const made = await makeObject(w, w.a, w.a1, title);
        await publishAs(w, w.a, made.id);
      }
      const read = await call("GET", URL_OBJECT, "root");
      const tag = `"v${String(read.json.version)}"`;
      const put = async (body: Record<string, unknown>) => {
        const token = tokens.root ?? "";
        const res = await small.inject({
          method: "PUT",
          url: URL_OBJECT,
          headers: {
            origin: SAME_ORIGIN.origin,
            cookie: `${OCULUS_COOKIES.session}=${token}`,
            [CSRF_HEADER]: csrfTokenFor(token) ?? "",
            "content-type": "application/json",
            "if-match": tag,
          },
          payload: JSON.stringify(body),
        });
        return { status: res.statusCode, json: res.json<Record<string, unknown>>() };
      };
      const mapping = { entries: [...MAPPING.entries, { field: "note", term: "abstract" }] };
      const [row] = await w.db.rows<{ n: number }>(sql`
        SELECT count(*)::integer AS n FROM public.records
        WHERE organization_id = ${w.a}::uuid AND template_key = 't-object'
          AND workflow_state = 'published'`);
      const count = row?.n ?? 0;
      expect(count).toBeGreaterThan(1);
      const asked = await put({ mapping });
      expect(asked.status).toBe(409);
      expect(asked.json.error).toBe("confirmation_required");
      const issues = asked.json.issues as { code: string; path: unknown[] }[];
      expect(issues.map((i) => i.code)).toEqual(["publishes_records", "published_records_counted"]);
      expect(issues[1]?.path).toEqual(["publishedRecordCount", count]);
      // No list: the records aren't named one by one.
      expect(JSON.stringify(asked.json)).not.toContain("published_record_affected");
      // confirmPublished alone, or a wrong count, asks again.
      for (const body of [
        { mapping, confirmPublished: true },
        { mapping, confirmPublishedCount: count - 1 },
        { mapping, confirmPublishedCount: count + 1 },
      ]) {
        const r = await put(body);
        expect(r.status).toBe(409);
      }
      for (const bad of ["3", -1, 1.5, null]) {
        expect((await put({ mapping, confirmPublishedCount: bad })).status).toBe(422);
      }
      const saved = await put({ mapping, confirmPublishedCount: count });
      expect(saved.status).toBe(200);
      expect(saved.json.publishedRecordCount).toBe(count);
      expect(saved.json.publishedRecords).toEqual([]);
    } finally {
      await small.close();
    }
  });
});
