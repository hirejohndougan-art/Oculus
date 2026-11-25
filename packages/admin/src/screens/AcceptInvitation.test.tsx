// @vitest-environment jsdom
// Joining from an invitation (T-075): the token read from the fragment once
// and taken out of the address bar; a new account goes straight on to
// setting up two-step sign-in; a dead link; the rules' own message for a
// weak password or a bad name; an existing account joins while signed in.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, renderAt } from "../testing.fixtures";
import { DEAD_INVITATION, SIGN_IN_FIRST } from "./AcceptInvitation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const TOKEN = "i".repeat(43);
const PASSWORD = "An invented passphrase for joining";

async function fillIn(password = PASSWORD, again = password) {
  await userEvent.type(await screen.findByLabelText(/^Email/), "new.volunteer@example.org");
  await userEvent.type(screen.getByLabelText(/^Your name/), "Invented Volunteer");
  await userEvent.type(screen.getByLabelText(/^Password/), password);
  await userEvent.type(screen.getByLabelText(/^Type it again/), again);
  await userEvent.click(screen.getByRole("button", { name: "Make my account" }));
}

describe("joining as a new person", () => {
  it("reads the token from the fragment once, removes it, and goes on to set-up", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    const sent = fakeServer({
      "POST /api/invitation/accept": [
        201,
        {
          joined: true,
          signedIn: true,
          next: "set_up",
          expiresAt: "2026-11-25T21:00:00.000Z",
          setUpLinkRequired: false,
          csrfToken: "c".repeat(43),
        },
      ],
      "GET /api/sign-in/pending": [
        200,
        {
          next: "set_up",
          expiresAt: "2026-11-25T21:00:00.000Z",
          setUpLinkRequired: false,
          csrfToken: "c".repeat(43),
        },
      ],
    });
    const { router } = renderAt("/invitation");
    expect(window.location.hash).toBe("");
    await fillIn();
    expect(sent[0]?.body).toEqual({
      token: TOKEN,
      email: "new.volunteer@example.org",
      displayName: "Invented Volunteer",
      password: PASSWORD,
    });
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/sign-in/set-up");
    });
  });

  it("refuses two different passwords before sending", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    const sent = fakeServer({});
    renderAt("/invitation");
    await fillIn("one invented passphrase", "two invented passphrase");
    expect((await screen.findByRole("alert")).textContent).toMatch(/aren't the same/);
    expect(sent).toHaveLength(0);
  });

  it("shows the rules' own messages for a weak password and a bad name", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    fakeServer({
      "POST /api/invitation/accept": [
        422,
        {
          error: "invalid_form",
          issues: [
            { path: ["password"], code: "too_short", message: "Use at least 8 characters." },
            { path: ["displayName"], code: "invalid_display_name", message: "A name is 1–200." },
          ],
        },
      ],
    });
    renderAt("/invitation");
    await fillIn("short");
    expect(await screen.findByText("Use at least 8 characters.")).toBeTruthy();
    expect(screen.getByText("A name is 1–200.")).toBeTruthy();
  });

  it("says a used, expired or wrong link can't be used, and one without a token too", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    fakeServer({ "POST /api/invitation/accept": [400, { error: "invalid_invitation" }] });
    renderAt("/invitation");
    await fillIn();
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeTruthy();
    expect(screen.getByText(DEAD_INVITATION)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/invitation");
    renderAt("/invitation");
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeTruthy();
  });

  it("says when the account is made but couldn't be signed in", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    fakeServer({ "POST /api/invitation/accept": [201, { joined: true, signedIn: false }] });
    renderAt("/invitation");
    await fillIn();
    expect(await screen.findByRole("heading", { name: "Your account is ready" })).toBeTruthy();
  });
});

describe("joining with an account one already has", () => {
  it("offers to join while signed in after account_exists, and does it with the token alone", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    const sent = fakeServer({
      "POST /api/invitation/accept": [409, { error: "account_exists" }],
      "GET /api/me": [200, { csrfToken: "m".repeat(43) }],
      "POST /api/invitation/accept-signed-in": [
        201,
        { joined: true, organizationId: "x", organizationName: "Invented Library" },
      ],
    });
    renderAt("/invitation");
    await fillIn();
    expect(
      await screen.findByRole("heading", { name: "You already have an account" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Join with my account" }));
    expect(await screen.findByText(/You've joined Invented Library/)).toBeTruthy();
    const accepted = sent.find((s) => s.path === "/api/invitation/accept-signed-in");
    expect(accepted?.body).toEqual({ token: TOKEN });
  });

  it("asks to sign in first when nobody is signed in", async () => {
    window.history.replaceState(null, "", `/invitation#${TOKEN}`);
    const sent = fakeServer({ "GET /api/me": [401, { error: "unauthenticated" }] });
    renderAt("/invitation");
    await userEvent.click(
      await screen.findByRole("button", { name: "I already have an Oculus account" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Join with my account" }));
    expect((await screen.findByRole("alert")).textContent).toBe(SIGN_IN_FIRST);
    expect(sent.some((s) => s.path === "/api/invitation/accept-signed-in")).toBe(false);
  });
});
