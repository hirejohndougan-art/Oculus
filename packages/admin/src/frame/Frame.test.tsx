// @vitest-environment jsdom
// The frame (T-045): the sidebar with the Oculus name, the organization and
// the site selector listing only the person's sites; straight to the only
// site; choosing among several; switching organization for another
// organization's site; the top bar with the person and signing out.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORG_A,
  ORG_B,
  SITE_1,
  SITE_2,
  SITE_3,
  fakeServer,
  me,
  renderAt,
} from "../testing.fixtures";
import { initials } from "./Frame";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A1 = {
  siteId: SITE_1,
  organizationId: ORG_A,
  siteName: "Invented archive site",
  organizationName: "Invented Archive",
};
const A2 = {
  siteId: SITE_2,
  organizationId: ORG_A,
  siteName: "Invented second site",
  organizationName: "Invented Archive",
};
const B1 = {
  siteId: SITE_3,
  organizationId: ORG_B,
  siteName: "Invented library site",
  organizationName: "Invented Library",
};

describe("the frame", () => {
  it("goes straight to the only site, with the sidebar and the person", async () => {
    fakeServer({ "GET /api/me": [200, me([A1])] });
    const { router } = renderAt("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/sites/${SITE_1}`);
    const nav = screen.getByRole("navigation", { name: "Oculus" });
    expect(within(nav).getByText("Oculus")).toBeTruthy();
    expect(within(nav).getByText("Invented Archive")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account: Ada Invented" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe(
      "#main",
    );
  });

  it("asks a person with several sites to choose, listing only theirs", async () => {
    fakeServer({ "GET /api/me": [200, me([A1, A2])] });
    const { router } = renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Choose a site" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Your sites" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Invented archive siteInvented Archive", "Invented second siteInvented Archive"]);
    await userEvent.click(within(list).getByRole("button", { name: /Invented second site/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_2}`);
    });
  });

  it("tells a person with no site whom to ask", async () => {
    fakeServer({ "GET /api/me": [200, me([])] });
    renderAt("/");
    expect(await screen.findByText(/Ask a system manager to give you one/)).toBeTruthy();
  });

  it("switches organization (a new session) before opening another organization's site", async () => {
    const sent = fakeServer({
      "GET /api/me": [200, me([A1, B1])],
      "POST /api/organization": [
        200,
        { session: { organizationId: ORG_B, csrfToken: "s".repeat(43) } },
      ],
    });
    const { router } = renderAt(`/sites/${SITE_1}`);
    await screen.findByRole("heading", { level: 1, name: "Invented archive site" });
    await userEvent.click(screen.getByRole("button", { name: /Site/ }));
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Invented archive site", "Invented library site"]);
    await userEvent.click(within(listbox).getByRole("option", { name: "Invented library site" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_3}`);
    });
    const post = sent.find((s) => s.path === "/api/organization");
    expect(post?.body).toEqual({ organizationId: ORG_B });
    // The CSRF token came from GET /api/me.
    expect(post?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
  });

  it("switches once to the only site's organization, and stops if that fails", async () => {
    let calls = 0;
    fakeServer({
      "GET /api/me": [200, me([B1])],
      "POST /api/organization": () => {
        calls += 1;
        return [403, { error: "not_permitted" }];
      },
    });
    renderAt("/");
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect(screen.getByRole("list", { name: "Your sites" })).toBeTruthy();
  });

  it("says a site the person can't open is not available", async () => {
    fakeServer({ "GET /api/me": [200, me([A1])] });
    renderAt(`/sites/${SITE_3}`);
    expect(await screen.findByRole("heading", { name: "Site not available" })).toBeTruthy();
  });

  it("signs out from the account menu and returns to the Login screen", async () => {
    const sent = fakeServer({
      "GET /api/me": [200, me([A1])],
      "POST /api/sign-out": [200, { signedOut: true }],
    });
    renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: "Account: Ada Invented" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("You are signed out.")).toBeTruthy();
    expect(sent.find((s) => s.path === "/api/sign-out")?.headers["x-oculus-csrf"]).toBe(
      "f".repeat(43),
    );
  });

  it("signs out everywhere else and says how many", async () => {
    fakeServer({
      "GET /api/me": [200, me([A1])],
      "POST /api/sign-out/others": [200, { ended: 2 }],
    });
    renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: "Account: Ada Invented" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out everywhere else" }),
    );
    expect(await screen.findByText(/Signed out of 2 other sessions/)).toBeTruthy();
  });

  it("sends a person whose session has ended to sign in", async () => {
    fakeServer({ "GET /api/me": [401, { error: "unauthenticated" }] });
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("makes initials from a name", () => {
    expect(initials("Ada Invented")).toBe("AI");
    expect(initials("ada")).toBe("A");
    expect(initials("Mary Ann Invented")).toBe("MI");
    expect(initials("  ")).toBe("");
  });
});
