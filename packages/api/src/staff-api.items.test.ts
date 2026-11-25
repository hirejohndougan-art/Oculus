// The admin's lists and abilities over HTTP (T-046, D-083), against a fresh
// migrated database: the items list of the working site (filters, sorting,
// paging, search), never showing another site's or organization's records,
// not even by a page's length; the record types; what each role may do in
// the working site and with a record (`can`); and the values a unit
// inherits, which are left out when a unit above it is out of the person's
// sight. Every person, site and record is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type OrganizationId, type UserId } from "@oculus/core";
import {
  insertRecordTypeVersion,
  insertTemplateVersion,
  type Database,
  type Queryable,
} from "@oculus/db";
import { createService } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, SITE_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  INC,
  actorOf,
  field,
  fullSession,
  makeAs,
  makeObject,
  makeWorld,
  ok,
  pendingSession,
  type World,
} from "./staff-api.fixtures.js";
import { grant } from "../../service/src/people.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld();
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
  });
  ok(
    await insertTemplateVersion(w.db, {
      key: "t-inherit",
      organizationId: w.a,
      label: "Inheriting unit",
      appliesTo: ["archival_unit"],
      fields: [
        field("rights", "rights"),
        field("provenance", "text", { inherited: true }),
        field("shelf", "text", { inherited: true, visibility: "staff" }),
      ],
    }),
  );
  ok(
    await insertRecordTypeVersion(w.db, {
      key: "lantern",
      organizationId: w.a,
      label: "Lantern",
      kind: "object",
      defaultTemplateKey: "t-object",
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

  // A1: three objects (one of the lantern type, one published), A2 and B1 one each.
  ids.zebra = (await makeObject(w, w.a, w.a1, "Zebra lantern of tin")).id;
  ids.apple = (await makeObject(w, w.a, w.a1, "apple crate")).id;
  ids.typed = await makeAs(w, w.a, w.a1, {
    kind: "object",
    title: "Mantel lantern",
    templateKey: "t-object",
    recordTypeKey: "lantern",
    fields: { rights: { uri: INC } },
  });
  ok(
    await w.service.publish({ organizationId: w.a, actor: actorOf(w.root) }, ids.apple as never, {
      expectedVersion: 1,
    }),
  );
  ids.otherSite = (await makeObject(w, w.a, w.a2, "Hidden lantern on the second site")).id;
  ids.otherOrg = (await makeObject(w, w.b, w.b1, "Library lantern")).id;
  // A unit tree on A1 with inherited values, and one under a fonds on A2
  // (filed across sites by the system manager).
  const unit = (site: typeof w.a1, title: string, parentId?: string, extra = {}) =>
    makeAs(w, w.a, site, {
      kind: "archival_unit",
      level: parentId === undefined ? "fonds" : "series",
      ...(parentId === undefined ? {} : { parentId }),
      title,
      templateKey: "t-inherit",
      fields: { rights: { uri: INC }, ...extra },
    });
  ids.fonds = await unit(w.a1, "Invented fonds", undefined, {
    provenance: "Given by an invented family.",
    shelf: "Invented shelf 4",
  });
  ids.series = await unit(w.a1, "Invented series", ids.fonds);
  ids.hiddenFonds = await unit(w.a2, "Hidden fonds", undefined, { provenance: "Hidden words." });
  ids.crossSeries = await unit(w.a1, "Series under a hidden fonds", ids.hiddenFonds);
  ids.asset = await makeAs(w, w.a, w.a1, {
    kind: "digital_asset",
    title: "Invented scan",
    templateKey: "t-asset",
    mediaType: "image/jpeg",
    fields: { rights: { uri: INC } },
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

async function get(url: string, as: string | undefined, site?: string) {
  const headers: Record<string, string> = { origin: SAME_ORIGIN.origin };
  const token = as === undefined ? undefined : tokens[as];
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if (site !== undefined) headers[SITE_HEADER] = site;
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

const titles = (r: { json: Record<string, unknown> }) =>
  ((r.json.records ?? []) as { title: string }[]).map((x) => x.title);
const codes = (r: { json: Record<string, unknown> }) =>
  ((r.json.issues ?? []) as { code: string }[]).map((i) => i.code);

describe("GET /api/records (the items list)", () => {
  it("needs a full session", async () => {
    expect((await get("/api/records", undefined, w.a1)).status).toBe(401);
    expect((await get("/api/records", "pending", w.a1)).status).toBe(401);
  });

  it("lists the working site's records only, newest change first", async () => {
    const r = await get("/api/records", "cataloger", w.a1);
    expect(r.status).toBe(200);
    const listed = titles(r);
    expect(listed).toContain("Zebra lantern of tin");
    expect(listed).toContain("Invented fonds");
    expect(listed).not.toContain("Hidden lantern on the second site");
    expect(listed).not.toContain("Hidden fonds");
    expect(listed).not.toContain("Library lantern");
    // The publication is apple's latest change.
    expect(listed[0]).toBe("Invented scan");
    const first = (r.json.records as Record<string, unknown>[])[0];
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        "kind",
        "recordId",
        "recordTypeKey",
        "siteId",
        "state",
        "title",
        "updatedAt",
        "version",
      ].sort(),
    );
  });

  it("filters by state and record type, and sorts by title", async () => {
    expect(titles(await get("/api/records?state=published", "cataloger", w.a1))).toEqual([
      "apple crate",
    ]);
    expect(titles(await get("/api/records?type=lantern", "cataloger", w.a1))).toEqual([
      "Mantel lantern",
    ]);
    const sorted = titles(await get("/api/records?sort=title", "reader", w.a1));
    expect(sorted[0]).toBe("apple crate");
    expect(sorted.at(-1)).toBe("Zebra lantern of tin");
  });

  it("pages with an opaque next and no record text", async () => {
    const one = await get("/api/records?sort=title&limit=2", "cataloger", w.a1);
    expect(titles(one)).toHaveLength(2);
    expect(one.json.next).toBe("2");
    const two = await get(`/api/records?sort=title&limit=2&after=2`, "cataloger", w.a1);
    expect(titles(two)).not.toContain(titles(one)[0]);
    const all = await get("/api/records?limit=100", "cataloger", w.a1);
    expect(all.json.next).toBeNull();
  });

  it("searches within the working site and the filters, best match first", async () => {
    const r = await get("/api/records?q=lantern", "cataloger", w.a1);
    expect(titles(r).sort()).toEqual(["Mantel lantern", "Zebra lantern of tin"]);
    const typed = await get("/api/records?q=lantern&type=lantern", "cataloger", w.a1);
    expect(titles(typed)).toEqual(["Mantel lantern"]);
    const sorted = await get("/api/records?q=lantern&sort=title", "cataloger", w.a1);
    expect([sorted.status, codes(sorted)]).toEqual([422, ["invalid_sort"]]);
  });

  it("never shows another site's or organization's records, even by count", async () => {
    // A cataloger on A2 sees A2's record and nothing of A1, with or without words.
    expect(titles(await get("/api/records", "other", w.a2))).toEqual([
      "Hidden fonds",
      "Hidden lantern on the second site",
    ]);
    expect(titles(await get("/api/records?q=lantern", "other", w.a2))).toEqual([
      "Hidden lantern on the second site",
    ]);
    // Asking for a site they have no role on is refused like a made-up site.
    const elsewhere = await get("/api/records", "other", w.a1);
    const madeUp = await get("/api/records", "other", "00000000-0000-4000-8000-000000000123");
    expect([elsewhere.status, codes(elsewhere)]).toEqual([422, ["unknown_site"]]);
    expect(madeUp).toEqual(elsewhere);
    // Another organization's member, working in their own site.
    expect(titles(await get("/api/records?q=lantern", "stranger", w.b1))).toEqual([
      "Library lantern",
    ]);
    expect((await get("/api/records", "stranger", w.a1)).status).toBe(422);
  });

  it("refuses people who see no records, and malformed parameters", async () => {
    expect((await get("/api/records", "donor", w.a1)).status).toBe(403);
    for (const query of [
      "sort=newest",
      "type=Not%20a%20key",
      "q=%20%20",
      "after=%3Cscript%3E",
      "limit=0",
      "limit=101",
      "state=a&state=b",
    ]) {
      const r = await get(`/api/records?${query}`, "cataloger", w.a1);
      expect([query, r.status]).toEqual([query, 400]);
    }
    const state = await get("/api/records?state=lost", "cataloger", w.a1);
    expect([state.status, codes(state)]).toEqual([422, ["invalid_state"]]);
    const after = await get("/api/records?after=99999", "cataloger", w.a1);
    expect([after.status, codes(after)]).toEqual([422, ["invalid_offset"]]);
  });
});

describe("GET /api/record-types and /api/working-site", () => {
  it("lists the organization's record types for people who see records", async () => {
    const r = await get("/api/record-types", "reader");
    expect(r.status).toBe(200);
    expect(r.json.recordTypes).toEqual([
      { key: "lantern", label: "Lantern", kind: "object", defaultTemplateKey: "t-object" },
    ]);
    expect((await get("/api/record-types", "stranger")).json.recordTypes).toEqual([]);
    expect((await get("/api/record-types", "donor")).status).toBe(403);
  });

  it("says what each role may do in the working site", async () => {
    const all = ["object", "archival_unit", "digital_asset", "agent", "place", "event"];
    const expected: Record<string, { createKinds: string[]; review: boolean }> = {
      root: { createKinds: all, review: true },
      manager: { createKinds: all, review: true },
      reviewer: { createKinds: all, review: true },
      cataloger: { createKinds: all, review: false },
      scanner: { createKinds: ["digital_asset"], review: false },
      reader: { createKinds: [], review: false },
    };
    for (const [who, abilities] of Object.entries(expected)) {
      const r = await get("/api/working-site", who, w.a1);
      expect([who, r.status, r.json]).toEqual([who, 200, abilities]);
    }
    const elsewhere = await get("/api/working-site", "cataloger", w.a2);
    expect([elsewhere.status, codes(elsewhere)]).toEqual([422, ["unknown_site"]]);
    expect((await get("/api/working-site", "donor", w.a1)).status).toBe(200);
  });
});

describe("GET /api/records/:id: what the person may do, and what it inherits", () => {
  it("says what each role may do with a record (the operations' own checks)", async () => {
    const expected: Record<string, Record<string, boolean>> = {
      root: { edit: true, history: true, publish: true, delete: true },
      manager: { edit: true, history: true, publish: true, delete: true },
      reviewer: { edit: true, history: true, publish: true, delete: false },
      cataloger: { edit: true, history: true, publish: false, delete: false },
      scanner: { edit: false, history: false, publish: false, delete: false },
      reader: { edit: false, history: false, publish: false, delete: false },
    };
    for (const [who, can] of Object.entries(expected)) {
      const r = await get(`/api/records/${ids.zebra ?? ""}`, who);
      expect([who, r.status, r.json.can]).toEqual([who, 200, can]);
    }
    // A Scanner edits scans (media.attach) but sees no history.
    const scan = await get(`/api/records/${ids.asset ?? ""}`, "scanner");
    expect(scan.json.can).toEqual({ edit: true, history: false, publish: false, delete: false });
    // Another site's record is still not found.
    expect((await get(`/api/records/${ids.otherSite ?? ""}`, "cataloger")).status).toBe(404);
  });

  it("shows the values a unit inherits, staff values included, with their source", async () => {
    const r = await get(`/api/records/${ids.series ?? ""}`, "reader");
    expect(r.status).toBe(200);
    expect(r.json.inherited).toEqual([
      { key: "provenance", value: "Given by an invented family.", from: ids.fonds },
      { key: "shelf", value: "Invented shelf 4", from: ids.fonds },
    ]);
    expect((await get(`/api/records/${ids.fonds ?? ""}`, "reader")).json.inherited).toEqual([]);
    expect((await get(`/api/records/${ids.zebra ?? ""}`, "reader")).json.inherited).toEqual([]);
  });

  it("shows nothing inherited when a unit above is out of sight", async () => {
    const hidden = await get(`/api/records/${ids.crossSeries ?? ""}`, "cataloger");
    expect(hidden.status).toBe(200);
    expect(hidden.json.inherited).toEqual([]);
    expect(JSON.stringify(hidden.json)).not.toContain("Hidden words.");
    // The system manager sees it.
    const root = await get(`/api/records/${ids.crossSeries ?? ""}`, "root");
    expect(root.json.inherited).toEqual([
      { key: "provenance", value: "Hidden words.", from: ids.hiddenFonds },
    ]);
  });
});

describe("inherited values while the units above change (review: fail closed)", () => {
  it("never shows a hidden unit's values, even if it is moved away and deleted mid-read", async () => {
    const draftUnder = (title: string, parentId: string, level = "series") => ({
      kind: "archival_unit",
      level,
      parentId,
      title,
      templateKey: "t-inherit",
      fields: { rights: { uri: INC } },
    });
    const root = { organizationId: w.a, actor: actorOf(w.root) };
    const hidden = await makeAs(w, w.a, w.a2, {
      kind: "archival_unit",
      level: "fonds",
      title: "Racing hidden fonds",
      templateKey: "t-inherit",
      fields: { rights: { uri: INC }, provenance: "Racing hidden words." },
    });
    const visible = await makeAs(w, w.a, w.a1, {
      kind: "archival_unit",
      level: "fonds",
      title: "Racing visible fonds",
      templateKey: "t-inherit",
      fields: { rights: { uri: INC } },
    });
    const series = await makeAs(w, w.a, w.a1, draftUnder("Racing series", hidden));
    const file = await makeAs(w, w.a, w.a1, draftUnder("Racing file", series, "file"));

    // Between reading the values and checking who may see where they came
    // from, a system manager moves the series out and deletes the hidden fonds.
    let moved: Promise<unknown> | undefined;
    let sawClosure = false;
    const hook = async () => {
      moved = (async () => {
        ok(
          await w.service.updateRecord(
            root,
            series as never,
            draftUnder("Racing series", visible),
            {
              expectedVersion: 1,
            },
          ),
        );
        ok(await w.service.deleteRecord(root, hidden as never, { expectedVersion: 1 }));
      })();
      // Long enough for both to finish when nothing holds them back.
      await Promise.race([moved, new Promise((resolve) => setTimeout(resolve, 1500))]);
    };
    const hooked: Database = {
      rows: (q) => w.db.rows(q),
      execute: (q) => w.db.execute(q),
      close: () => Promise.resolve(),
      transaction: (work) =>
        w.db.transaction((tx) => {
          const seen: Queryable = {
            rows: async (q) => {
              if (q.text.includes("WITH RECURSIVE up(id) AS")) sawClosure = true;
              if (
                sawClosure &&
                moved === undefined &&
                q.text.includes(
                  "r.represents_id::text AS represents_id, r.site_id::text AS site_id",
                )
              ) {
                await hook();
              }
              return tx.rows(q);
            },
            execute: (q) => tx.execute(q),
          };
          return work(seen);
        }),
    };
    const service = createService(hooked);
    const server = await buildServer({
      env: TEST_ENV,
      routes: staffApiRoutes({ db: w.db, service, log: () => undefined }),
    });
    try {
      const token = tokens.cataloger ?? "";
      const res = await server.inject({
        method: "GET",
        url: `/api/records/${file}`,
        headers: { origin: SAME_ORIGIN.origin, cookie: `${OCULUS_COOKIES.session}=${token}` },
      });
      expect(moved).toBeDefined();
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Racing hidden words.");
      expect((JSON.parse(res.body) as { inherited: unknown }).inherited).toEqual([]);
      // The move and deletion went through once the read was done.
      await moved;
      const after = await get(`/api/records/${series}`, "cataloger");
      expect((after.json.record as { parentId?: string }).parentId).toBe(visible);
    } finally {
      await moved?.catch(() => undefined);
      await server.close();
    }
  }, 30_000);
});

describe("the lists change nothing", () => {
  it("are GET only (POST to the list is not a route)", async () => {
    const token = tokens.cataloger ?? "";
    const res = await app.inject({
      method: "POST",
      url: "/api/working-site",
      headers: {
        origin: SAME_ORIGIN.origin,
        cookie: `${OCULUS_COOKIES.session}=${token}`,
        [CSRF_HEADER]: csrfTokenFor(token) ?? "",
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect([404, 405]).toContain(res.statusCode);
  });
});
