// Sharing items between sites over HTTP (T-041d, D-094), against a fresh
// migrated database: every route with no session, every change without
// CSRF, from a foreign Origin and with a wrong body; offering a published item from site A1 to organization
// B's site B1 and its manager accepting it; what B's people then read (the
// public view only, never the staff-only field); and above all that an
// unknown share, another organization's share and one the person may not
// act on answer the same 404 byte for byte. Every person, site and record
// is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, newRecordId, type OrganizationId, type UserId } from "@oculus/core";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import {
  actorOf,
  fullSession,
  makeObject,
  makeWorld,
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
  // What the public pages publish (D-096); a shared item shows only these (S-036a).
  for (const org of [w.a, w.b]) {
    const saved = await w.service.saveDublinCoreMapping(
      { organizationId: org, actor: actorOf(w.root) },
      "t-object",
      {
        entries: [
          { field: "rights", term: "rights" },
          { field: "note", term: "description" },
        ],
      },
      { expectedVersion: 0 },
    );
    if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
  }
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: (r) => logged.push(r) }),
  });
  const make = async (name: string, user: UserId, org: OrganizationId) => {
    tokens[name] = (await fullSession(w.db, user, org)).token;
  };
  await make("cataloger", w.cataloger, w.a);
  await make("reader", w.reader, w.a);
  await make("other", w.other, w.a);
  await make("stranger", w.stranger, w.b);
  const bManager = await w.member(w.b, "InventedLibraryManager");
  await grant(w.service, w.root, w.b, { userId: bManager, role: "site_manager", siteId: w.b1 });
  await make("bManager", bManager, w.b);
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

interface Call {
  as?: string;
  body?: unknown;
  csrf?: boolean;
  origin?: string;
}

async function call(method: string, url: string, c: Call = {}) {
  const token = c.as === undefined ? undefined : tokens[c.as];
  const headers: Record<string, string> = { origin: c.origin ?? SAME_ORIGIN.origin };
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if ((c.csrf ?? method !== "GET") && token !== undefined) {
    headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  }
  let payload: string | undefined;
  if (c.body !== undefined) {
    payload = JSON.stringify(c.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.inject({
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

/** Status, body and headers but the date: what must match for identical replies. */
function shape(r: Awaited<ReturnType<typeof call>>) {
  const headers = { ...r.res.headers };
  delete headers.date;
  return { status: r.status, body: r.res.body, headers };
}

async function publishedItem(title: string): Promise<string> {
  const made = await makeObject(w, w.a, w.a1, title);
  await publishAs(w, w.a, made.id);
  return made.id;
}

async function offerToB(id: string): Promise<string> {
  const r = await call("POST", `/api/records/${id}/shares`, {
    as: "cataloger",
    body: { targetOrganizationId: w.b, targetSiteId: w.b1 },
  });
  expect(r.status).toBe(201);
  return (r.json.share as { id: string }).id;
}

describe("sharing over HTTP", () => {
  it("offers, accepts and shows the public view to the other organization", async () => {
    const id = await publishedItem("Invented shared lantern");
    const shareId = await offerToB(id);
    const offers = await call("GET", `/api/sites/${w.b1}/share-offers`, { as: "bManager" });
    expect(offers.status).toBe(200);
    expect((offers.json.shares as { id: string }[]).map((s) => s.id)).toContain(shareId);
    const accepted = await call("POST", `/api/shares/${shareId}/accept`, { as: "bManager" });
    expect(accepted.status).toBe(200);
    expect((accepted.json.share as { state: string }).state).toBe("accepted");
    const seen = await call("GET", `/api/shares/${shareId}`, { as: "stranger" });
    expect(seen.status).toBe(200);
    const item = (seen.json.share as { item: Record<string, unknown> }).item;
    expect(item.title).toBe("Invented shared lantern");
    expect(JSON.stringify(seen.json)).not.toContain("Back room.");
    const list = await call("GET", `/api/sites/${w.b1}/shared-items`, { as: "stranger" });
    expect((list.json.shares as { id: string }[]).map((s) => s.id)).toContain(shareId);
    const ofRecord = await call("GET", `/api/records/${id}/shares`, { as: "cataloger" });
    expect((ofRecord.json.shares as { id: string }[]).map((s) => s.id)).toContain(shareId);
    // The home side withdraws it; B reads nothing then.
    expect(
      (await call("POST", `/api/shares/${shareId}/withdraw`, { as: "cataloger" })).status,
    ).toBe(200);
    const after = await call("GET", `/api/shares/${shareId}`, { as: "stranger" });
    expect(after.status).toBe(404);
    expect(shape(after)).toEqual(
      shape(await call("GET", `/api/shares/${newRecordId()}`, { as: "stranger" })),
    );
    // Once ended, a move is share_not_open (422) for someone who may act on it.
    const late = await call("POST", `/api/shares/${shareId}/remove`, { as: "bManager" });
    expect(late.status).toBe(422);
    expect((late.json.issues as { code: string }[]).map((i) => i.code)).toEqual(["share_not_open"]);
  });

  it("answers an unknown share, another organization's and one out of reach with one 404", async () => {
    const id = await publishedItem("Invented guarded lantern");
    const shareId = await offerToB(id);
    const missing = newRecordId();
    const moves = ["accept", "decline", "remove", "withdraw"] as const;
    // Who may not make each move: A's people can't decide, B's can't withdraw,
    // and those without the permissions can do nothing.
    const outOfReach: Record<(typeof moves)[number], readonly string[]> = {
      accept: ["stranger", "cataloger", "other", "reader"],
      decline: ["stranger", "cataloger", "other", "reader"],
      remove: ["stranger", "cataloger", "other", "reader"],
      withdraw: ["other", "reader", "bManager", "stranger"],
    };
    for (const [path, who] of moves.flatMap((m) => outOfReach[m].map((p) => [m, p] as const))) {
      const r = await call("POST", `/api/shares/${shareId}/${path}`, { as: who });
      const none = await call("POST", `/api/shares/${missing}/${path}`, { as: who });
      const bad = await call("POST", `/api/shares/not-an-id/${path}`, { as: who });
      expect(r.status).toBe(404);
      expect(shape(r)).toEqual(shape(none));
      expect(shape(r)).toEqual(shape(bad));
    }
    // Not yet accepted: reading it is the same 404.
    const early = await call("GET", `/api/shares/${shareId}`, { as: "stranger" });
    expect(shape(early)).toEqual(
      shape(await call("GET", `/api/shares/${missing}`, { as: "stranger" })),
    );
    // A record the person can't see: the ordinary 404, offering or listing.
    const hidden = await call("POST", `/api/records/${id}/shares`, {
      as: "other",
      body: { targetOrganizationId: w.b, targetSiteId: w.b1 },
    });
    const gone = await call("POST", `/api/records/${newRecordId()}/shares`, {
      as: "other",
      body: { targetOrganizationId: w.b, targetSiteId: w.b1 },
    });
    expect(hidden.status).toBe(404);
    expect(shape(hidden)).toEqual(shape(gone));
  });

  it("refuses without a session, without CSRF, from another origin, and with extra keys", async () => {
    const id = await publishedItem("Invented careful lantern");
    const body = { targetOrganizationId: w.b, targetSiteId: w.b1 };
    expect((await call("POST", `/api/records/${id}/shares`, { body })).status).toBe(401);
    expect(
      (await call("POST", `/api/records/${id}/shares`, { as: "cataloger", body, csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("POST", `/api/records/${id}/shares`, {
          as: "cataloger",
          body,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", `/api/records/${id}/shares`, {
          as: "cataloger",
          body: { ...body, state: "accepted" },
        })
      ).status,
    ).toBe(422);
    expect((await call("GET", `/api/sites/${w.b1}/share-offers`)).status).toBe(401);
    // Another organization's site list, and a site the person doesn't manage: 403.
    expect((await call("GET", `/api/sites/${w.b1}/share-offers`, { as: "cataloger" })).status).toBe(
      403,
    );
    expect((await call("GET", `/api/sites/${w.b1}/share-offers`, { as: "stranger" })).status).toBe(
      403,
    );
    // The share moves and reads: no session 401, no CSRF or a foreign Origin 403.
    const shareId = await offerToB(await publishedItem("Invented watched lantern"));
    for (const move of ["accept", "decline", "remove", "withdraw"]) {
      const url = `/api/shares/${shareId}/${move}`;
      const who = move === "withdraw" ? "cataloger" : "bManager";
      expect((await call("POST", url)).status).toBe(401);
      expect((await call("POST", url, { as: who, csrf: false })).status).toBe(403);
      expect((await call("POST", url, { as: who, origin: "https://evil.example" })).status).toBe(
        403,
      );
      expect((await call("POST", url, { as: who, body: { note: "x" } })).status).toBe(422);
      expect((await call("POST", url, { as: who, body: [1] })).status).toBe(400);
    }
    expect((await call("GET", `/api/shares/${shareId}`)).status).toBe(401);
    expect((await call("GET", `/api/sites/${w.b1}/shared-items`)).status).toBe(401);
    expect((await call("GET", `/api/records/${id}/shares`)).status).toBe(401);
    // The share is still open after all those refusals.
    expect(
      (await call("GET", `/api/sites/${w.b1}/share-offers`, { as: "bManager" })).json.shares,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: shareId, state: "offered" })]));
    // Site lists can't probe site IDs: another organization's site, a site the
    // person doesn't manage or see, an unknown and a malformed ID all answer alike.
    for (const list of ["share-offers", "shared-items"]) {
      for (const who of ["cataloger", "stranger", "reader"]) {
        const theirs = await call("GET", `/api/sites/${w.b1}/${list}`, { as: who });
        if (who === "stranger" && list === "shared-items") continue; // may see B1's catalog
        expect(theirs.status).toBe(403);
        expect(shape(theirs)).toEqual(
          shape(await call("GET", `/api/sites/${newRecordId()}/${list}`, { as: who })),
        );
        expect(shape(theirs)).toEqual(
          shape(await call("GET", `/api/sites/not-an-id/${list}`, { as: who })),
        );
      }
    }
    // An unpublished item can't be offered: 422 with its reason.
    const draft = await makeObject(w, w.a, w.a1, "Invented draft lantern");
    const r = await call("POST", `/api/records/${draft.id}/shares`, { as: "cataloger", body });
    expect(r.status).toBe(422);
    expect((r.json.issues as { code: string }[]).map((i) => i.code)).toEqual(["not_published"]);
  });

  it("pages the lists by ?before and ?state, and refuses a bad page (S-036a)", async () => {
    const a = await offerToB(await publishedItem("Invented paged lantern A"));
    const b = await offerToB(await publishedItem("Invented paged lantern B"));
    const ids = (r: Awaited<ReturnType<typeof call>>) =>
      (r.json.shares as { id: string }[]).map((x) => x.id);
    const offered = await call("GET", `/api/sites/${w.b1}/share-offers?state=offered`, {
      as: "bManager",
    });
    expect(offered.status).toBe(200);
    const all = ids(offered);
    expect(all.indexOf(b)).toBeLessThan(all.indexOf(a));
    const after = await call("GET", `/api/sites/${w.b1}/share-offers?state=offered&before=${b}`, {
      as: "bManager",
    });
    expect(ids(after)).toContain(a);
    expect(ids(after)).not.toContain(b);
    for (const url of [
      `/api/sites/${w.b1}/share-offers?state=declined`,
      `/api/sites/${w.b1}/shared-items?state=accepted`,
    ]) {
      const r = await call("GET", url, { as: "bManager" });
      // shared-items has no state: the parameter is ignored there, so only the first is refused.
      if (url.includes("share-offers")) {
        expect(r.status).toBe(422);
      } else {
        expect(r.status).toBe(200);
      }
    }
    expect(offered.json.next).toEqual({ offered: null, accepted: null });
    const noState = await call("GET", `/api/sites/${w.b1}/share-offers?before=${a}`, {
      as: "bManager",
    });
    expect(noState.status).toBe(422);
    const twice = await call("GET", `/api/sites/${w.b1}/share-offers?before=${a}&before=${b}`, {
      as: "bManager",
    });
    expect(twice.status).toBe(400);
  });
});
