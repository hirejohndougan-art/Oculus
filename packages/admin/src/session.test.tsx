// @vitest-environment jsdom
// Forgetting a session's data (T-046 review, D-083): when the server ends
// the session, the next person signing in on the same tab sees none of the
// last person's search words, filters or records; switching organization
// leaves none of the old organization's templates, record types or lists
// in the cache.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORG_A,
  ORG_B,
  PENDING,
  SITE_1,
  SITE_3,
  fakeServer,
  me,
  renderAt,
  type Reply,
} from "./testing.fixtures";
import { forgetLists } from "./records/listMemory";
import { A1, TEMPLATES_REPLY, TYPES_REPLY } from "./records/records.fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetLists();
});

const ENDED: Reply = [401, { error: "unauthenticated" }];
const ROW = {
  recordId: "11111111-1111-4111-8111-111111111111",
  title: "The first person's lantern",
  kind: "object",
  recordTypeKey: null,
  siteId: SITE_1,
  state: "draft",
  version: 1,
  updatedAt: "2026-11-24T11:00:00.000Z",
};

describe("a session ending on the server", () => {
  it("leaves nothing of the last person's search for the next person in the tab", async () => {
    let ended = false;
    let person = "Ada Invented";
    const live = (reply: Reply) => (): Reply => (ended ? ENDED : reply);
    const sent = fakeServer({
      "GET /api/me": () => (ended ? ENDED : [200, { ...me([A1]), displayName: person }]),
      "GET /api/working-site": live([200, { createKinds: ["object"], review: false }]),
      "GET /api/record-types": live([200, TYPES_REPLY]),
      "GET /api/records?limit=25": live([200, { records: [], next: null }]),
      "GET /api/records?q=lantern&limit=25": live([200, { records: [ROW], next: null }]),
      "GET /api/records?q=lantern&state=draft&limit=25": live([200, { records: [], next: null }]),
      "POST /api/sign-in": [200, PENDING],
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": [
        200,
        { session: { organizationId: ORG_A, csrfToken: "n".repeat(43) } },
      ],
    });
    const { router } = renderAt(`/sites/${SITE_1}`);
    const search = await screen.findByLabelText(/Search this site's records/);
    await userEvent.type(search, "lantern{Enter}");
    expect(await screen.findByRole("link", { name: ROW.title })).toBeTruthy();

    // The session ends on the server; the next request learns it.
    ended = true;
    await userEvent.click(screen.getByRole("button", { name: /Status/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Draft" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");

    // Someone else signs in on the same tab.
    ended = false;
    person = "Grace Invented";
    const before = sent.length;
    await userEvent.type(screen.getByLabelText("Email"), "grace@example.org");
    await userEvent.type(screen.getByLabelText("Password"), "An invented password 2026");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const code = await screen.findByLabelText(/^6-digit code/);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.type(code, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account: Grace Invented" })).toBeTruthy();
    const box = await screen.findByLabelText<HTMLInputElement>(/Search this site's records/);
    expect(box.value).toBe("");
    expect(await screen.findByText("This site has no records yet.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: ROW.title })).toBeNull();
    const lists = sent.slice(before).filter((s) => s.path.startsWith("/api/records?"));
    expect(lists.map((s) => s.path)).toEqual(["/api/records?limit=25"]);
  });
});

describe("switching organization", () => {
  it("drops the old organization's templates, record types and lists", async () => {
    let organizationId = ORG_A;
    const B1 = {
      siteId: SITE_3,
      organizationId: ORG_B,
      siteName: "Invented library site",
      organizationName: "Invented Library",
    };
    const sent = fakeServer({
      "GET /api/me": () => [200, { ...me([A1, B1]), organizationId }],
      "GET /api/working-site": [200, { createKinds: ["object"], review: false }],
      "GET /api/record-types": [200, TYPES_REPLY],
      "GET /api/templates": [200, TEMPLATES_REPLY],
      "GET /api/records?limit=25": [200, { records: [ROW], next: null }],
      "POST /api/organization": () => {
        organizationId = ORG_B;
        return [200, { session: { organizationId: ORG_B, csrfToken: "s".repeat(43) } }];
      },
    });
    const { router } = renderAt(`/sites/${SITE_1}/records/new`);
    await screen.findByRole("heading", { level: 1, name: "Catalog an item" });
    await waitFor(() => {
      expect(sent.filter((s) => s.path === "/api/templates")).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole("button", { name: /^Invented archive site/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Invented library site" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_3}`);
    });
    await router.navigate(`/sites/${SITE_3}/records/new`);
    await screen.findByRole("heading", { level: 1, name: "Catalog an item" });
    // Fetched again, for the new organization's site, not served from the cache.
    await waitFor(() => {
      const templates = sent.filter((s) => s.path === "/api/templates");
      expect(templates.map((s) => s.headers["x-oculus-site"])).toEqual([SITE_1, SITE_3]);
    });
    const types = sent.filter((s) => s.path === "/api/record-types");
    expect(types.at(-1)?.headers["x-oculus-site"]).toBe(SITE_3);
  });
});
