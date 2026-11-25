// Saving a template, a template's Dublin Core mapping or an identifier type
// needs a recent sign-in (S-060a, from the Phase 2 security review's L1):
// each can make staff-only values public on every published record of the
// organization, like the site and System settings changes that already ask
// for one. A system manager whose sign-in is older than ten minutes is
// answered `403 reauthentication_required` and nothing is saved. Every
// person is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "@oculus/core";
import { sql } from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  OBJECT_FIELDS,
  ageSession,
  fullSession,
  makeWorld,
  type World,
} from "./staff-api.fixtures.js";
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
  tokens.root = (await fullSession(w.db, w.root, w.a)).token;
  const stale = await fullSession(w.db, w.root, w.a);
  await ageSession(w.db, stale.sessionId, 11 * 60);
  tokens.stale = stale.token;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

async function put(url: string, as: string, body: unknown, headers: Record<string, string>) {
  const token = tokens[as] ?? "";
  const res = await app.inject({
    method: "PUT",
    url,
    headers: {
      origin: SAME_ORIGIN.origin,
      cookie: `${OCULUS_COOKIES.session}=${token}`,
      [CSRF_HEADER]: csrfTokenFor(token) ?? "",
      "content-type": "application/json",
      ...headers,
    },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.json<Record<string, unknown>>() };
}

const count = async (query: ReturnType<typeof sql>) =>
  Number((await w.db.rows<{ n: string }>(query))[0]?.n ?? 0);

describe("saving definitions needs a recent sign-in (S-060a)", () => {
  it("a new template: refused for a stale sign-in, saved for a recent one", async () => {
    const body = { template: { label: "Recent", appliesTo: ["object"], fields: OBJECT_FIELDS } };
    const stale = await put("/api/templates/t-recent", "stale", body, { "if-none-match": "*" });
    expect([stale.status, stale.json]).toEqual([403, { error: "reauthentication_required" }]);
    const kept = sql`SELECT count(*) AS n FROM public.templates WHERE organization_id = ${w.a}::uuid AND key = 't-recent'`;
    expect(await count(kept)).toBe(0);
    const fresh = await put("/api/templates/t-recent", "root", body, { "if-none-match": "*" });
    expect(fresh.status).toBe(201);
    expect(await count(kept)).toBeGreaterThan(0);
  });

  it("a Dublin Core mapping: refused for a stale sign-in, saved for a recent one", async () => {
    const body = {
      mapping: {
        entries: [
          { field: "rights", term: "rights" },
          { field: "note", term: "description" },
        ],
      },
    };
    const url = "/api/templates/t-object/dublin-core";
    const stale = await put(url, "stale", body, { "if-none-match": "*" });
    expect([stale.status, stale.json]).toEqual([403, { error: "reauthentication_required" }]);
    const fresh = await put(url, "root", body, { "if-none-match": "*" });
    expect(fresh.status).toBe(201);
  });

  it("an identifier type: refused for a stale sign-in, saved for a recent one", async () => {
    const body = { identifierType: { label: "Recent number", uniqueness: "none" } };
    const url = "/api/identifier-types/recent_number";
    const stale = await put(url, "stale", body, { "if-none-match": "*" });
    expect([stale.status, stale.json]).toEqual([403, { error: "reauthentication_required" }]);
    const kept = sql`SELECT count(*) AS n FROM public.identifier_types WHERE organization_id = ${w.a}::uuid AND key = 'recent_number'`;
    expect(await count(kept)).toBe(0);
    const fresh = await put(url, "root", body, { "if-none-match": "*" });
    expect(fresh.status).toBe(201);
    expect(await count(kept)).toBe(1);
  });
});
