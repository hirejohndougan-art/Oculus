// @vitest-environment jsdom
// Password reset (D-078): one message whatever the address; the token read
// from the fragment and taken out of the address bar; a dead link; a
// password the rules refuse.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeServer, renderAt } from "../testing.fixtures";
import { RESET_SENT } from "./ResetRequest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const TOKEN = "t".repeat(43);

describe("asking for a reset link", () => {
  it("says the same thing whatever the address", async () => {
    const sent = fakeServer({ "POST /api/password-reset": [202, { requested: true }] });
    renderAt("/forgot");
    await userEvent.type(await screen.findByLabelText(/^Email/), "someone@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send the link" }));
    expect((await screen.findByRole("alert")).textContent).toBe(RESET_SENT);
    expect(sent[0]?.body).toEqual({ email: "someone@example.org" });
  });
});

describe("choosing a new password", () => {
  it("reads the token from the fragment once, removes it, and sends it with the password", async () => {
    window.history.replaceState(null, "", `/reset#${TOKEN}`);
    const sent = fakeServer({ "POST /api/password-reset/complete": [200, { reset: true }] });
    renderAt("/reset");
    expect(window.location.hash).toBe("");
    await userEvent.type(
      await screen.findByLabelText(/^New password/),
      "A new invented passphrase",
    );
    await userEvent.type(screen.getByLabelText(/^Type it again/), "A new invented passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Save the new password" }));
    expect(await screen.findByRole("heading", { name: "Your password is changed" })).toBeTruthy();
    expect(sent[0]?.body).toEqual({ token: TOKEN, password: "A new invented passphrase" });
  });

  it("refuses two different passwords before sending", async () => {
    window.history.replaceState(null, "", `/reset#${TOKEN}`);
    const sent = fakeServer({});
    renderAt("/reset");
    await userEvent.type(await screen.findByLabelText(/^New password/), "one invented");
    await userEvent.type(screen.getByLabelText(/^Type it again/), "two invented");
    await userEvent.click(screen.getByRole("button", { name: "Save the new password" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/aren't the same/);
    expect(sent).toHaveLength(0);
  });

  it("shows the rules' own message for a weak password", async () => {
    window.history.replaceState(null, "", `/reset#${TOKEN}`);
    fakeServer({
      "POST /api/password-reset/complete": [
        422,
        {
          error: "invalid_password",
          issues: [
            { path: ["password"], code: "too_short", message: "Use at least 8 characters." },
          ],
        },
      ],
    });
    renderAt("/reset");
    await userEvent.type(await screen.findByLabelText(/^New password/), "short");
    await userEvent.type(screen.getByLabelText(/^Type it again/), "short");
    await userEvent.click(screen.getByRole("button", { name: "Save the new password" }));
    expect(await screen.findByText("Use at least 8 characters.")).toBeTruthy();
  });

  it("says a used or expired link can't be used, and one without a token too", async () => {
    window.history.replaceState(null, "", `/reset#${TOKEN}`);
    fakeServer({ "POST /api/password-reset/complete": [400, { error: "invalid_reset" }] });
    renderAt("/reset");
    await userEvent.type(
      await screen.findByLabelText(/^New password/),
      "A new invented passphrase",
    );
    await userEvent.type(screen.getByLabelText(/^Type it again/), "A new invented passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Save the new password" }));
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/reset");
    renderAt("/reset");
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeTruthy();
  });
});
