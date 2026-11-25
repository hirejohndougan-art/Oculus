// Accessions and donor contacts over HTTP (T-073): the routes call the
// service (T-018c, D-114), which decides every permission. Only Donor
// relations (and managers) read or change them; a cataloger is refused; an
// accession or contact of another organization, a missing one and a
// malformed ID are the same 404, byte for byte; edits name their version
// (If-Match), the first contact If-None-Match; a save that holds published
// records back says which (`nowHeld`); nothing of an accession reaches a
// public reply. Every person, record and number here is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import type { FastifyInstance } from "fastify";
import { insertIdentifierType, insertTemplateVersion } from "@oculus/db";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  field,
  fullSession,
  makeAs,
  makeObject,
  makeWorld,
  ok,
  publishAs,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const tokens: Record<string, string> = {};
let donorAgent: string;
let otherSiteAgent: string;
let bAgent: string;
let lantern: string;
let draftBox: string;

const SECRET = {
  materials: "Invented: two boxes of letters from the Bayou Street house",
  note: "Invented note: call the grandson first",
  email: "quarrington@example.org",
};

async function agentTemplate(org: OrganizationId): Promise<void> {
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-agent",
      organizationId: org,
      label: "Agent",
      appliesTo: ["agent"],
      fields: [field("note", "text")],
    }),
  );
  ok(
    await w.db.transaction((q) =>
      insertIdentifierType(q, {
        organizationId: org,
        key: "accession_number",
        label: "Accession number",
        uniqueness: "all_time",
        public: false,
      }),
    ),
  );
}

const agentDraft = (title: string) => ({
  kind: "agent",
  agentType: "family",
  title,
  templateKey: "t-agent",
  fields: {},
});

beforeAll(async () => {
  w = await makeWorld();
  await agentTemplate(w.a);
  await agentTemplate(w.b);
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
  });
  const bDonor = await w.member(w.b, "BDonor");
  await grant(w.service, w.root, w.b, { userId: bDonor, role: "donor_relations", siteId: w.b1 });
  const a2Donor = await w.member(w.a, "A2Donor");
  await grant(w.service, w.root, w.a, { userId: a2Donor, role: "donor_relations", siteId: w.a2 });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("root", w.root, w.a);
  await make("donor", w.donor, w.a);
  await make("a2donor", a2Donor, w.a);
  await make("manager", w.manager, w.a);
  await make("cataloger", w.cataloger, w.a);
  await make("bdonor", bDonor, w.b);
  donorAgent = await makeAs(w, w.a, w.a1, agentDraft("Invented Quarrington family"));
  otherSiteAgent = await makeAs(w, w.a, w.a2, agentDraft("Invented Second-site family"));
  bAgent = await makeAs(w, w.b, w.b1, agentDraft("Invented Library family"));
  const made = await makeObject(w, w.a, w.a1, "An invented lantern");
  lantern = made.id;
  await publishAs(w, w.a, lantern);
  draftBox = (await makeObject(w, w.a, w.a1, "An invented box")).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function call(
  method: Method,
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

const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

let numbers = 0;
function accession(extra: Record<string, unknown> = {}, agent = donorAgent) {
  numbers += 1;
  return {
    number: { type: "accession_number", value: `2026.${String(numbers).padStart(3, "0")}` },
    sourceAgent: { recordId: agent, label: "Invented Quarrington family" },
    receivedOn: "2026-11-02",
    method: "gift",
    materials: SECRET.materials,
    note: SECRET.note,
    deedStatus: "signed",
    records: [],
    ...extra,
  };
}

describe("accessions over HTTP", () => {
  it("Donor relations logs one: 201, ETag v1, Location, and reads it back", async () => {
    const made = await call("POST", "/api/accessions", "donor", { accession: accession() });
    expect(made.status).toBe(201);
    expect(made.res.headers.etag).toBe('"v1"');
    const saved = made.json as { accession: { id: string }; version: number; nowHeld: unknown[] };
    expect(made.res.headers.location).toBe(`/api/accessions/${saved.accession.id}`);
    expect([saved.version, saved.nowHeld]).toEqual([1, []]);
    const read = await call("GET", `/api/accessions/${saved.accession.id}`, "donor");
    expect(read.status).toBe(200);
    expect(read.res.headers.etag).toBe('"v1"');
    expect((read.json.accession as { materials: string }).materials).toBe(SECRET.materials);
    const list = await call("GET", "/api/accessions", "donor");
    expect(list.status).toBe(200);
    const ids = (list.json.accessions as { accession: { id: string } }[]).map(
      (a) => a.accession.id,
    );
    expect(ids).toContain(saved.accession.id);
    expect(list.json.next).toBeNull();
  });

  it("a deed not yet signed says which published records it now holds back", async () => {
    const made = await call("POST", "/api/accessions", "donor", {
      accession: accession({
        deedStatus: "missing",
        records: [
          { recordId: lantern, label: "Lantern" },
          { recordId: draftBox, label: "Box" },
        ],
      }),
    });
    expect(made.status).toBe(201);
    expect(made.json.nowHeld).toEqual([lantern]);
  });

  it("an edit names its version: none 428, malformed 400, stale 412, current 200 with v2", async () => {
    const made = await call("POST", "/api/accessions", "donor", { accession: accession() });
    const id = (made.json.accession as { id: string }).id;
    const input = {
      accession: { ...accession(), method: "transfer", deedStatus: "not_needed" },
    };
    expect((await call("PUT", `/api/accessions/${id}`, "donor", input)).status).toBe(428);
    const bad = await call("PUT", `/api/accessions/${id}`, "donor", input, { "if-match": "v1" });
    expect([bad.status, bad.json]).toEqual([400, { error: "bad_if_match" }]);
    const stale = await call("PUT", `/api/accessions/${id}`, "donor", input, {
      "if-match": '"v7"',
    });
    expect([stale.status, stale.json.error]).toEqual([412, "version_conflict"]);
    const next = await call("PUT", `/api/accessions/${id}`, "donor", input, { "if-match": '"v1"' });
    expect([next.status, next.res.headers.etag, next.json.version]).toEqual([200, '"v2"', 2]);
    expect((next.json.accession as { deedStatus: string }).deedStatus).toBe("not_needed");
  });

  it("a number used once is refused again (422), and unknown keys are 422", async () => {
    const first = accession();
    expect((await call("POST", "/api/accessions", "donor", { accession: first })).status).toBe(201);
    const again = await call("POST", "/api/accessions", "donor", { accession: first });
    expect([again.status, codes(again)]).toEqual([422, ["duplicate_number"]]);
    const extra = await call("POST", "/api/accessions", "donor", { accession: first, x: 1 });
    expect([extra.status, codes(extra)]).toEqual([422, ["unknown_property"]]);
    const inner = await call("POST", "/api/accessions", "donor", {
      accession: { ...accession(), id: newRecordId() },
    });
    expect([inner.status, codes(inner)]).toEqual([422, ["invalid_request"]]);
  });

  it("a cataloger, a reader and a signed-out caller are refused before anything is said", async () => {
    const made = await call("POST", "/api/accessions", "donor", { accession: accession() });
    const id = (made.json.accession as { id: string }).id;
    for (const [url, method] of [
      ["/api/accessions", "GET"],
      [`/api/accessions/${id}`, "GET"],
      [`/api/accessions/${newRecordId()}`, "GET"],
      ["/api/accessions", "POST"],
    ] as const) {
      const r = await call(
        method,
        url,
        "cataloger",
        method === "POST" ? { accession: accession() } : undefined,
      );
      expect([url, r.status, r.json]).toEqual([url, 403, { error: "not_permitted" }]);
    }
    const anon = await app.inject({ method: "GET", url: "/api/accessions" });
    expect(anon.statusCode).toBe(401);
  });

  it("another organization's accession, a missing one and a malformed ID are the same 404", async () => {
    const made = await call("POST", "/api/accessions", "donor", { accession: accession() });
    const id = (made.json.accession as { id: string }).id;
    const theirs = await call("GET", `/api/accessions/${id}`, "bdonor");
    const missing = await call("GET", `/api/accessions/${newRecordId()}`, "bdonor");
    const malformed = await call("GET", "/api/accessions/not-an-id", "bdonor");
    for (const r of [theirs, missing, malformed]) {
      expect([r.status, r.res.body]).toEqual([404, JSON.stringify({ error: "not_found" })]);
    }
    const edit = await call(
      "PUT",
      `/api/accessions/${id}`,
      "bdonor",
      { accession: accession({}, bAgent) },
      { "if-match": '"v1"' },
    );
    expect([edit.status, edit.res.body]).toEqual([404, JSON.stringify({ error: "not_found" })]);
    const list = await call("GET", "/api/accessions", "bdonor");
    const ids = (list.json.accessions as { accession: { id: string } }[]).map(
      (a) => a.accession.id,
    );
    expect(ids).not.toContain(id);
  });

  it("naming a record of a site where the person doesn't work with donors is refused", async () => {
    const r = await call("POST", "/api/accessions", "a2donor", {
      accession: accession({ records: [{ recordId: lantern, label: "Lantern" }] }, otherSiteAgent),
    });
    expect([r.status, r.json]).toEqual([403, { error: "not_permitted" }]);
  });

  it("a bad page cursor is 400; a malformed before never reaches the database", async () => {
    const r = await call("GET", "/api/accessions?before=x'%3B", "donor");
    expect([r.status, r.json]).toEqual([400, { error: "bad_query" }]);
    const twice = await call(
      "GET",
      `/api/accessions?before=${newRecordId()}&before=${newRecordId()}`,
      "donor",
    );
    expect(twice.status).toBe(400);
  });
});

describe("donor contacts over HTTP", () => {
  const url = () => `/api/donor-contacts/${donorAgent}`;

  it("the first is saved with If-None-Match (201, v1), the next with If-Match; then deleted", async () => {
    const none = await call("GET", url(), "donor");
    expect([none.status, none.res.body]).toEqual([404, JSON.stringify({ error: "not_found" })]);
    const missing = await call("PUT", url(), "donor", { contact: { email: SECRET.email } });
    expect(missing.status).toBe(428);
    const first = await call(
      "PUT",
      url(),
      "donor",
      { contact: { email: SECRET.email } },
      { "if-none-match": "*" },
    );
    expect([first.status, first.res.headers.etag]).toEqual([201, '"v1"']);
    const twice = await call(
      "PUT",
      url(),
      "donor",
      { contact: { email: SECRET.email } },
      { "if-none-match": "*" },
    );
    expect(twice.status).toBe(412);
    const next = await call(
      "PUT",
      url(),
      "donor",
      { contact: { email: SECRET.email, phone: "555-0100" } },
      { "if-match": '"v1"' },
    );
    expect([next.status, next.res.headers.etag]).toEqual([200, '"v2"']);
    const read = await call("GET", url(), "donor");
    expect([read.status, (read.json.contact as { phone: string }).phone]).toEqual([
      200,
      "555-0100",
    ]);
    const stale = await call("DELETE", url(), "donor", undefined, { "if-match": '"v1"' });
    expect(stale.status).toBe(412);
    const gone = await call("DELETE", url(), "donor", undefined, { "if-match": '"v2"' });
    expect([gone.status, gone.json]).toEqual([200, { deleted: true }]);
    expect((await call("GET", url(), "donor")).status).toBe(404);
  });

  it("a cataloger can't read or save one; another organization's agent is a 404", async () => {
    expect((await call("GET", url(), "cataloger")).status).toBe(403);
    const save = await call(
      "PUT",
      url(),
      "cataloger",
      { contact: { email: SECRET.email } },
      { "if-none-match": "*" },
    );
    expect(save.status).toBe(403);
    const theirs = await call("GET", `/api/donor-contacts/${bAgent}`, "donor");
    const malformed = await call("GET", "/api/donor-contacts/nope", "donor");
    const malformedSave = await call(
      "PUT",
      "/api/donor-contacts/nope",
      "donor",
      { contact: { email: SECRET.email } },
      { "if-none-match": "*" },
    );
    for (const r of [theirs, malformed, malformedSave]) {
      expect([r.status, r.res.body]).toEqual([404, JSON.stringify({ error: "not_found" })]);
    }
  });

  it("a contact for a record that isn't an agent is refused, and messages never quote it", async () => {
    const r = await call(
      "PUT",
      `/api/donor-contacts/${lantern}`,
      "donor",
      { contact: { email: SECRET.email } },
      { "if-none-match": "*" },
    );
    expect(r.status).toBe(422);
    expect(r.res.body).not.toContain(SECRET.email);
  });

  it("a DELETE with a body is refused", async () => {
    const r = await call("DELETE", url(), "donor", { x: 1 }, { "if-match": '"v1"' });
    expect(r.status).toBe(400);
  });
});

describe("the site's working context is not needed", () => {
  it("a manager of the site reads the register without a working site", async () => {
    const r = await call("GET", "/api/accessions", "manager");
    expect(r.status).toBe(200);
  });
});
