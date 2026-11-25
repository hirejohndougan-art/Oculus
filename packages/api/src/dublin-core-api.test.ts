// A template's stored Dublin Core mapping over HTTP (T-050b, D-096):
// `GET`/`PUT /api/templates/:key/dublin-core`. Anyone who may read
// templates reads it (version 0 and null before the first save); only a
// system manager saves it (D-072), from the version it started from, and a
// change shown at once on published records is a 409 until confirmed
// (D-076). Every person and record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
import type { FastifyInstance } from "fastify";
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
