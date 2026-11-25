// @vitest-environment jsdom
// Item records and the approval queue (T-046): loading, rows linking to the
// record, empty and error states, filters, search and paging sent as the
// list's query (never in the page's address), the working site in
// X-Oculus-Site, "+ Catalog an item" and "Waiting for review" only for
// people who may, and record text shown as text.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_1, fakeServer, me, renderAt, type Reply } from "../testing.fixtures";
import { forgetLists } from "./listMemory";
import { A1, RECORD_ID, TYPES_REPLY } from "./records.fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetLists();
});

const ROW = {
  recordId: RECORD_ID,
  title: "An invented lantern <img src=x onerror=alert(1)>",
  kind: "object",
  recordTypeKey: "lantern",
  siteId: SITE_1,
  state: "published",
  version: 3,
  updatedAt: "2026-11-24T11:00:00.000Z",
};

function server(routes: Record<string, Reply | ((s: never) => Reply)> = {}, review = false) {
  return fakeServer({
    "GET /api/me": [200, me([A1])],
    "GET /api/working-site": [200, { createKinds: ["object"], review }],
    "GET /api/record-types": [200, TYPES_REPLY],
    "GET /api/records?limit=25": [200, { records: [ROW], next: null }],
    ...routes,
  });
}

describe("Item records", () => {
  it("lists the site's records with their status, linking each to its editor", async () => {
    const sent = server();
    const { router, container } = renderAt(`/sites/${SITE_1}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    const link = await screen.findByRole("link", { name: ROW.title });
    expect(link.getAttribute("href")).toBe(`/sites/${SITE_1}/records/${RECORD_ID}`);
    const row = link.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Published")).toBeTruthy();
    expect(within(row as HTMLElement).getByText("Object · Lantern")).toBeTruthy();
    // Record text is text: no element was made from it.
    expect(container.querySelector("img")).toBeNull();
    const list = sent.find((s) => s.path.startsWith("/api/records?"));
    expect(list?.headers["x-oculus-site"]).toBe(SITE_1);
    expect(screen.getByRole("link", { name: "+ Catalog an item" }).getAttribute("href")).toBe(
      `/sites/${SITE_1}/records/new`,
    );
    // Only the editor's route in the address.
    expect(router.state.location.pathname).toBe(`/sites/${SITE_1}`);
    expect(router.state.location.search).toBe("");
  });

  it("says when the site has no records, and when nothing matches", async () => {
    server({ "GET /api/records?limit=25": [200, { records: [], next: null }] });
    renderAt(`/sites/${SITE_1}`);
    expect(await screen.findByText("This site has no records yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Catalog the first item" })).toBeTruthy();
  });

  it("says when the list can't be loaded, and tries again", async () => {
    let calls = 0;
    server({
      "GET /api/records?limit=25": () => {
        calls += 1;
        return calls === 1
          ? [429, { error: "rate_limited" }]
          : [200, { records: [ROW], next: null }];
      },
    });
    renderAt(`/sites/${SITE_1}`);
    expect(await screen.findByText(/The records couldn't be loaded/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load the records again" }));
    expect(await screen.findByRole("link", { name: ROW.title })).toBeTruthy();
  });

  it("searches, filters and pages with the list's query, keeping the address clean", async () => {
    const sent = server({
      "GET /api/records?q=lantern&limit=25": [200, { records: [ROW], next: "0.5.abc" }],
      "GET /api/records?q=lantern&after=0.5.abc&limit=25": [200, { records: [], next: null }],
      "GET /api/records?state=published&sort=title&limit=25": [200, { records: [], next: null }],
      "GET /api/records?sort=title&limit=25": [200, { records: [ROW], next: null }],
    });
    const { router } = renderAt(`/sites/${SITE_1}`);
    await screen.findByRole("link", { name: ROW.title });

    // Order by title.
    await userEvent.click(screen.getByRole("button", { name: /Order/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Title, A to Z" }));
    await waitFor(() => {
      expect(sent.some((s) => s.path === "/api/records?sort=title&limit=25")).toBe(true);
    });

    // Search (best match first: the order can't be chosen).
    await userEvent.type(screen.getByLabelText(/Search this site's records/), "lantern{Enter}");
    await waitFor(() => {
      expect(sent.some((s) => s.path === "/api/records?q=lantern&limit=25")).toBe(true);
    });
    expect(await screen.findByText("Search results come best match first.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/No records match/)).toBeTruthy();
    expect(router.state.location.search).toBe("");

    // Clearing the search and filtering by status.
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Published" }));
    await waitFor(() => {
      expect(sent.some((s) => s.path === "/api/records?state=published&sort=title&limit=25")).toBe(
        true,
      );
    });
  });

  it("offers neither cataloging nor the queue to people who may not", async () => {
    server({ "GET /api/working-site": [200, { createKinds: [], review: false }] });
    renderAt(`/sites/${SITE_1}`);
    await screen.findByRole("link", { name: ROW.title });
    const nav = screen.getByRole("navigation", { name: "Oculus" });
    expect(within(nav).getByRole("link", { name: "Item records" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Waiting for review" })).toBeNull();
    expect(screen.queryByRole("link", { name: "+ Catalog an item" })).toBeNull();
  });
});

describe("Waiting for review", () => {
  it("lists the records sent for review, for people who may publish", async () => {
    server(
      {
        "GET /api/review-queue?limit=25": [
          200,
          {
            records: [
              {
                id: RECORD_ID,
                kind: "object",
                title: "A record to check",
                siteId: SITE_1,
                version: 4,
                updatedAt: "2026-11-24T11:00:00.000Z",
              },
            ],
            next: null,
          },
        ],
      },
      true,
    );
    renderAt(`/sites/${SITE_1}/review`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Waiting for review" }),
    ).toBeTruthy();
    const link = await screen.findByRole("link", { name: "A record to check" });
    expect(link.getAttribute("href")).toBe(`/sites/${SITE_1}/records/${RECORD_ID}`);
    const nav = screen.getByRole("navigation", { name: "Oculus" });
    const current = within(nav).getByRole("link", { name: "Waiting for review" });
    expect(current.getAttribute("aria-current")).toBe("page");
  });

  it("tells anyone else the list is for people who may publish", async () => {
    server({ "GET /api/review-queue?limit=25": [403, { error: "not_permitted" }] });
    renderAt(`/sites/${SITE_1}/review`);
    expect(await screen.findByText(/Only people who may publish see this list/)).toBeTruthy();
  });

  it("says when nothing is waiting", async () => {
    server({ "GET /api/review-queue?limit=25": [200, { records: [], next: null }] }, true);
    renderAt(`/sites/${SITE_1}/review`);
    expect(await screen.findByText("Nothing is waiting for review.")).toBeTruthy();
  });
});
