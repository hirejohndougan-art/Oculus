// @vitest-environment jsdom
// Sharing in the admin (T-041e, D-094): a site manager's offers (accept,
// decline) and accepted items (remove, asked first) with the two IDs to give
// out; the accepted items for everyone else who may see them, and a plain
// note for people who may not; a shared item's read-only view (values as
// text only, never HTML; an unknown or malformed one said in words without
// asking for a malformed one); and on a record's screen, the sites it is
// shared to, withdrawing (asked first), and offering it to a site by its
// IDs, only while published, with each refusal in words.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORG_A,
  ORG_B,
  SITE_1,
  SITE_2,
  fakeServer,
  me,
  renderAt,
  type Reply,
  type Sent,
} from "../testing.fixtures";
import {
  A1,
  ALL,
  READER,
  RECORD_ID,
  TEMPLATES_REPLY,
  TYPES_REPLY,
  VERSIONS_REPLY,
  recordReply,
} from "../records/records.fixtures";
import { forgetLists } from "../records/listMemory";
import { fieldLabel } from "./model";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetLists();
});

type Route = Reply | ((sent: Sent) => Reply);

const SHARE_1 = "33333333-3333-4333-8333-333333333333";
const SHARE_2 = "44444444-4444-4444-8444-444444444444";
const B_SITE = "55555555-5555-4555-8555-555555555555";

function incoming(id: string, state: string, title: string) {
  return {
    id,
    state,
    recordId: RECORD_ID,
    targetOrganizationId: ORG_A,
    targetSiteId: SITE_1,
    offeredAt: "2026-11-24T12:00:00.000Z",
    decidedAt: state === "accepted" ? "2026-11-24T13:00:00.000Z" : null,
    endedAt: null,
    item: {
      title,
      kind: "object",
      fields: { date_made: "1890s", description: "<b>Tin</b> and glass.", empty: "" },
      homeSite: "Invented Museum",
      homeOrganization: "Invented Society",
    },
  };
}

const SHARED = `/sites/${SITE_1}/shared`;
const OFFERS = `GET /api/sites/${SITE_1}/share-offers`;
const ITEMS = `GET /api/sites/${SITE_1}/shared-items`;

function siteServer(routes: Record<string, Route>) {
  return fakeServer({
    "GET /api/me": [200, me([A1])],
    "GET /api/working-site": [200, { createKinds: ["object"], review: false }],
    ...routes,
  });
}

describe("the Shared with this site screen", () => {
  it("is in the site's menu", async () => {
    siteServer({ [OFFERS]: [200, { shares: [] }] });
    renderAt(`/sites/${SITE_1}`);
    const link = await screen.findByRole("link", { name: "Shared with this site" });
    expect(link.getAttribute("href")).toBe(SHARED);
  });

  it("gives a manager the offers, the accepted items and the two IDs, and accepts one", async () => {
    let accepted = false;
    const sent = siteServer({
      [OFFERS]: () => [
        200,
        {
          shares: accepted
            ? [incoming(SHARE_1, "accepted", "Invented lantern")]
            : [
                incoming(SHARE_1, "offered", "Invented lantern"),
                incoming(SHARE_2, "accepted", "Invented kettle"),
              ],
        },
      ],
      [`POST /api/shares/${SHARE_1}/accept`]: () => {
        accepted = true;
        return [200, { share: { id: SHARE_1, state: "accepted" } }];
      },
    });
    renderAt(SHARED);
    const waiting = await screen.findByRole("table", { name: "Offers waiting for an answer" });
    expect(within(waiting).getByText("Invented lantern")).toBeTruthy();
    expect(within(waiting).getByText("Invented Museum, Invented Society")).toBeTruthy();
    // An offer isn't a link: it is read only once accepted.
    expect(within(waiting).queryByRole("link")).toBeNull();
    const shared = screen.getByRole("table", { name: "Items shared with this site" });
    expect(within(shared).getByRole("link", { name: "Invented kettle" }).getAttribute("href")).toBe(
      `${SHARED}/${SHARE_2}`,
    );
    expect(screen.getByText(new RegExp(`${SITE_1}.*${ORG_A}`))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Accept Invented lantern" }));
    expect(await screen.findByText(/^Accepted\./)).toBeTruthy();
    const post = sent.find((s) => s.path === `/api/shares/${SHARE_1}/accept`);
    expect(post?.method).toBe("POST");
    expect(post?.headers["x-oculus-site"]).toBe(SITE_1);
    expect(post?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
    expect(post?.body).toEqual({});
    expect(await screen.findByText("No offers are waiting.")).toBeTruthy();
  });

  it("asks before removing an accepted item, and says when an offer has ended", async () => {
    const sent = siteServer({
      [OFFERS]: [
        200,
        {
          shares: [
            incoming(SHARE_1, "offered", "Invented lantern"),
            incoming(SHARE_2, "accepted", "Invented kettle"),
          ],
        },
      ],
      [`POST /api/shares/${SHARE_2}/remove`]: [200, { share: { id: SHARE_2, state: "removed" } }],
      [`POST /api/shares/${SHARE_1}/decline`]: [404, { error: "not_found" }],
    });
    renderAt(SHARED);
    await userEvent.click(await screen.findByRole("button", { name: "Remove Invented kettle" }));
    const dialog = await screen.findByRole("region", { name: "Remove this item from the site?" });
    expect(sent.some((s) => s.path.endsWith("/remove"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/^Removed\./)).toBeTruthy();
    expect(sent.some((s) => s.path === `/api/shares/${SHARE_2}/remove`)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Decline Invented lantern" }));
    expect(await screen.findByText(/isn't open any more/)).toBeTruthy();
  });

  it("shows other people the accepted items, and says when they may not see them", async () => {
    siteServer({
      [OFFERS]: [403, { error: "not_permitted" }],
      [ITEMS]: [200, { shares: [incoming(SHARE_2, "accepted", "Invented kettle")] }],
    });
    renderAt(SHARED);
    expect(await screen.findByRole("link", { name: "Invented kettle" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByText(new RegExp(ORG_A))).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    siteServer({
      [OFFERS]: [403, { error: "not_permitted" }],
      [ITEMS]: [403, { error: "not_permitted" }],
    });
    renderAt(SHARED);
    expect(await screen.findByText(/Only people who can see the whole/)).toBeTruthy();
  });
});

describe("a shared item", () => {
  it("is shown read-only, its values as text, with its home named", async () => {
    siteServer({
      [`GET /api/shares/${SHARE_2}`]: [
        200,
        { share: incoming(SHARE_2, "accepted", "Invented kettle") },
      ],
    });
    const { container } = renderAt(`${SHARED}/${SHARE_2}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Invented kettle" })).toBeTruthy();
    expect(screen.getByText(/shared by Invented Museum, Invented Society/)).toBeTruthy();
    expect(screen.getByText("Date made")).toBeTruthy();
    expect(screen.getByText("<b>Tin</b> and glass.")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    // Empty values aren't listed.
    expect(screen.queryByText("Empty")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save|Edit/ })).toBeNull();
  });

  it("says when it isn't shared, and never asks for a malformed one", async () => {
    const sent = siteServer({ [`GET /api/shares/${SHARE_1}`]: [404, { error: "not_found" }] });
    renderAt(`${SHARED}/${SHARE_1}`);
    expect(await screen.findByText(/isn't shared with this site any more/)).toBeTruthy();
    cleanup();
    renderAt(`${SHARED}/not-an-id`);
    expect(await screen.findByText(/isn't shared with this site any more/)).toBeTruthy();
    expect(sent.some((s) => s.path.includes("not-an-id"))).toBe(false);
  });

  it("names fields readably", () => {
    expect(fieldLabel("date_made")).toBe("Date made");
    expect(fieldLabel("dateMade")).toBe("Date made");
    expect(fieldLabel("x")).toBe("X");
  });
});

describe("sharing on a record's screen", () => {
  const PATH = `/sites/${SITE_1}/records/${RECORD_ID}`;
  const API = `/api/records/${RECORD_ID}`;
  const mine = {
    id: SHARE_1,
    state: "accepted",
    recordId: RECORD_ID,
    targetOrganizationId: ORG_B,
    targetSiteId: B_SITE,
    offeredAt: "2026-11-24T12:00:00.000Z",
    decidedAt: "2026-11-24T13:00:00.000Z",
    endedAt: null,
  };

  function recordServer(state: string, routes: Record<string, Route> = {}, can = ALL) {
    return fakeServer({
      "GET /api/me": [200, me([A1])],
      "GET /api/working-site": [200, { createKinds: ["object"], review: true }],
      "GET /api/record-types": [200, TYPES_REPLY],
      "GET /api/templates": [200, TEMPLATES_REPLY],
      [`GET ${API}`]: [200, { ...recordReply({ can }), state }],
      [`GET ${API}/versions?limit=100`]: [200, VERSIONS_REPLY],
      "POST /api/records/check": [200, { issues: [] }],
      ...routes,
    });
  }

  async function panel() {
    return within(
      (await screen.findByRole("heading", { name: "Sharing with other sites" })).closest(
        "section",
      ) as HTMLElement,
    );
  }

  it("lists where it is shared, by ID for another organization, and withdraws after asking", async () => {
    const sent = recordServer("published", {
      [`GET ${API}/shares`]: [
        200,
        {
          shares: [
            mine,
            {
              ...mine,
              id: SHARE_2,
              targetOrganizationId: ORG_A,
              targetSiteId: SITE_2,
              state: "declined",
            },
          ],
        },
      ],
      [`POST /api/shares/${SHARE_1}/withdraw`]: [200, { share: { ...mine, state: "withdrawn" } }],
    });
    renderAt(PATH);
    const p = await panel();
    expect(
      await p.findByText(new RegExp(`another organization \\(site ID ${B_SITE}`)),
    ).toBeTruthy();
    expect(p.getByText(/Earlier shares \(1\)/)).toBeTruthy();
    await userEvent.click(p.getByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("region", { name: "Stop sharing with that site?" });
    expect(sent.some((s) => s.path.endsWith("/withdraw"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    expect(await p.findByText(/^Withdrawn\./)).toBeTruthy();
    expect(sent.find((s) => s.path === `/api/shares/${SHARE_1}/withdraw`)?.method).toBe("POST");
  });

  it("offers a published record by the other site's IDs, checking them first", async () => {
    let offered = 0;
    const sent = recordServer("published", {
      [`GET ${API}/shares`]: [200, { shares: [] }],
      [`POST ${API}/shares`]: () => {
        offered += 1;
        return offered === 1
          ? [201, { share: { ...mine, state: "offered" } }]
          : [
              422,
              {
                error: "invalid",
                issues: [{ path: [], code: "already_shared", message: "x" }],
              },
            ];
      },
    });
    renderAt(PATH);
    const p = await panel();
    expect(await p.findByText("It isn't offered or shared to any other site.")).toBeTruthy();
    await userEvent.type(p.getByLabelText("Organization ID"), "nonsense");
    await userEvent.click(p.getByRole("button", { name: "Offer this record" }));
    expect(await p.findByText(/Paste the organization ID/)).toBeTruthy();
    expect(p.getByText(/Paste the site ID/)).toBeTruthy();
    expect(sent.some((s) => s.method === "POST" && s.path === `${API}/shares`)).toBe(false);
    await userEvent.clear(p.getByLabelText("Organization ID"));
    await userEvent.type(p.getByLabelText("Organization ID"), ` ${ORG_B.toUpperCase()} `);
    await userEvent.type(p.getByLabelText("Site ID"), B_SITE);
    await userEvent.click(p.getByRole("button", { name: "Offer this record" }));
    expect(await p.findByText(/^Offered\./)).toBeTruthy();
    const post = sent.find((s) => s.method === "POST" && s.path === `${API}/shares`);
    expect(post?.body).toEqual({ targetOrganizationId: ORG_B, targetSiteId: B_SITE });
    await userEvent.type(p.getByLabelText("Organization ID"), ORG_B);
    await userEvent.type(p.getByLabelText("Site ID"), B_SITE);
    await userEvent.click(p.getByRole("button", { name: "Offer this record" }));
    expect(await p.findByText(/already offered or shared to that site/)).toBeTruthy();
  });

  it("offers nothing while unpublished, and isn't shown to people who can't edit", async () => {
    recordServer("draft", { [`GET ${API}/shares`]: [200, { shares: [] }] });
    renderAt(PATH);
    const p = await panel();
    expect(p.getByText(/Only a published record can be offered/)).toBeTruthy();
    expect(p.queryByRole("button", { name: "Offer this record" })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    const sent = recordServer("published", {}, READER);
    renderAt(PATH);
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => {
      expect(sent.some((s) => s.path === API)).toBe(true);
    });
    expect(screen.queryByRole("heading", { name: "Sharing with other sites" })).toBeNull();
    expect(sent.some((s) => s.path === `${API}/shares`)).toBe(false);
  });
});
