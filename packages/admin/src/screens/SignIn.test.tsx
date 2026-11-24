// @vitest-environment jsdom
// The Login screen, the code screen and the set-up screens (T-045), against
// a fake server: what each sends (body, CSRF header) and what each shows.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF, ORG_A, ORG_B, PENDING, SITE_1, fakeServer, me, renderAt } from "../testing.fixtures";
import { CODE_AGAIN, WRONG_CODE } from "./Code";
import { groupedKey } from "./SetUp";
import { WRONG_PASSWORD } from "./SignIn";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ONE_SITE = me([
  {
    siteId: SITE_1,
    organizationId: ORG_A,
    siteName: "Invented archive site",
    organizationName: "Invented Archive",
  },
]);

describe("the Login screen", () => {
  it("labels its fields and says what it is for", async () => {
    fakeServer({});
    renderAt("/sign-in");
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText(/^Email/)).toBeTruthy();
    expect(screen.getByLabelText(/^Password/).getAttribute("type")).toBe("password");
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toBeTruthy();
  });

  it("asks for both fields before sending anything", async () => {
    const sent = fakeServer({});
    renderAt("/sign-in");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /email address and your password/,
    );
    expect(sent).toHaveLength(0);
  });

  it("shows one message for a wrong password or unknown address", async () => {
    fakeServer({ "POST /api/sign-in": [401, { error: "invalid_credentials" }] });
    renderAt("/sign-in");
    await userEvent.type(await screen.findByLabelText(/^Email/), "ada@example.org");
    await userEvent.type(screen.getByLabelText(/^Password/), "wrong invented");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(WRONG_PASSWORD);
  });

  it("says how long to wait when throttled", async () => {
    fakeServer({ "POST /api/sign-in": [429, { error: "throttled", retryAfterSeconds: 120 }] });
    renderAt("/sign-in");
    await userEvent.type(await screen.findByLabelText(/^Email/), "ada@example.org");
    await userEvent.type(screen.getByLabelText(/^Password/), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/about 2 minutes/);
  });

  it("sends the password once and goes to the code screen", async () => {
    const sent = fakeServer({
      "POST /api/sign-in": [200, PENDING],
      "GET /api/sign-in/pending": [200, PENDING],
    });
    renderAt("/sign-in");
    await userEvent.type(await screen.findByLabelText(/^Email/), "ada@example.org");
    await userEvent.type(screen.getByLabelText(/^Password/), "Invented river bend");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeTruthy();
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/api/sign-in",
      body: { email: "ada@example.org", password: "Invented river bend" },
    });
    // No session yet, so no CSRF token is sent with the password.
    expect(sent[0]?.headers["x-oculus-csrf"]).toBeUndefined();
  });

  it("goes to setting up when two-step sign-in isn't set up yet", async () => {
    fakeServer({
      "POST /api/sign-in": [200, { ...PENDING, next: "set_up" }],
      "GET /api/sign-in/pending": [200, { ...PENDING, next: "set_up" }],
    });
    renderAt("/sign-in");
    await userEvent.type(await screen.findByLabelText(/^Email/), "ada@example.org");
    await userEvent.type(screen.getByLabelText(/^Password/), "Invented river bend");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Set up two-step sign-in" })).toBeTruthy();
  });
});

describe("the code screen", () => {
  it("sends the code with the waiting session's CSRF token, then opens the only site", async () => {
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": [
        200,
        { session: { organizationId: ORG_A, csrfToken: "n".repeat(43) } },
      ],
      "GET /api/me": [200, ONE_SITE],
    });
    renderAt("/sign-in/code");
    const field = await screen.findByLabelText(/^6-digit code/);
    expect(field.getAttribute("autocomplete")).toBe("one-time-code");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.type(field, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Straight to the only site (D-019).
    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    const post = sent.find((s) => s.path === "/api/sign-in/code");
    expect(post?.body).toEqual({ code: "123456" });
    expect(post?.headers["x-oculus-csrf"]).toBe(CSRF);
  });

  it("says a wrong code is wrong, and offers a recovery code instead", async () => {
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": [422, { error: "invalid_code" }],
    });
    renderAt("/sign-in/code");
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), "000000");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe(WRONG_CODE);
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    await userEvent.type(screen.getByLabelText(/^Recovery code/), "AAAA-BBBB");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(sent.filter((s) => s.path === "/api/sign-in/code").at(-1)?.body).toEqual({
        recoveryCode: "AAAA-BBBB",
      });
    });
  });

  it("asks which organization, by name, and sends the same code with it", async () => {
    let calls = 0;
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": () => {
        calls += 1;
        return calls === 1
          ? [
              409,
              {
                error: "choose_organization",
                organizations: [
                  { organizationId: ORG_A, name: "Invented Archive" },
                  { organizationId: ORG_B, name: "Invented Library" },
                ],
              },
            ]
          : [200, { session: { organizationId: ORG_B, csrfToken: "n".repeat(43) } }];
      },
      "GET /api/me": [200, ONE_SITE],
    });
    renderAt("/sign-in/code");
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), "123456");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const group = await screen.findByRole("radiogroup", {
      name: "Which organization do you want to work in?",
    });
    await userEvent.click(within(group).getByRole("radio", { name: "Invented Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(sent.filter((s) => s.path === "/api/sign-in/code").at(-1)?.body).toEqual({
        code: "123456",
        organizationId: ORG_B,
      });
    });
  });

  it("asks for a fresh code when the first ran out while choosing, keeping the organization", async () => {
    let calls = 0;
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": () => {
        calls += 1;
        if (calls === 1) {
          return [
            409,
            {
              error: "choose_organization",
              organizations: [
                { organizationId: ORG_A, name: "Invented Archive" },
                { organizationId: ORG_B, name: "Invented Library" },
              ],
            },
          ];
        }
        return calls === 2
          ? [422, { error: "invalid_code" }]
          : [200, { session: { organizationId: ORG_B, csrfToken: "n".repeat(43) } }];
      },
      "GET /api/me": [200, ONE_SITE],
    });
    renderAt("/sign-in/code");
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), "123456");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Invented Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe(CODE_AGAIN);
    const field = screen.getByLabelText(/^6-digit code/);
    await userEvent.type(field, "654321");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    expect(sent.filter((s) => s.path === "/api/sign-in/code").at(-1)?.body).toEqual({
      code: "654321",
      organizationId: ORG_B,
    });
  });

  it("stays when cancelling fails, and offers to try again", async () => {
    let calls = 0;
    fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-out": () => {
        calls += 1;
        return calls === 1 ? [503, { error: "unavailable" }] : [200, { signedOut: true }];
      },
    });
    renderAt("/sign-in/code");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel and sign in again" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wasn't cancelled/);
    expect(screen.getByRole("heading", { name: "Enter your code" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("goes back to sign in after too many wrong codes", async () => {
    fakeServer({
      "GET /api/sign-in/pending": [200, PENDING],
      "POST /api/sign-in/code": [401, { error: "too_many_attempts" }],
    });
    renderAt("/sign-in/code");
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), "000000");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("Too many wrong codes. Sign in again.")).toBeTruthy();
  });

  it("sends a person with no waiting session back to sign in", async () => {
    fakeServer({ "GET /api/sign-in/pending": [401, { error: "unauthenticated" }] });
    renderAt("/sign-in/code");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

describe("setting up two-step sign-in", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const URI = `otpauth://totp/Oculus:ada%40example.org?secret=${SECRET}&issuer=Oculus&algorithm=SHA1&digits=6&period=30`;
  const CODES = Array.from(
    { length: 10 },
    (_, i) => `ABCD-EFGH-JKMN-PQRS-TVWX-YZ${String(i).padStart(2, "0")}`,
  );

  it("shows the QR code and key, confirms, then shows the recovery codes once", async () => {
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, { ...PENDING, next: "set_up" }],
      "POST /api/sign-in/set-up": [200, { secret: SECRET, otpauthUri: URI }],
      "POST /api/sign-in/set-up/confirm": [
        200,
        { session: { organizationId: ORG_A, csrfToken: "n".repeat(43) }, recoveryCodes: CODES },
      ],
      "GET /api/me": [200, ONE_SITE],
    });
    renderAt("/sign-in/set-up");
    const start = await screen.findByRole("button", { name: "Start setting up" });
    await waitFor(() => {
      expect(start.hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(start);
    const qr = await screen.findByRole("img", {
      name: "QR code to add Oculus to your authenticator app",
    });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText(groupedKey(SECRET))).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/^6-digit code from the app/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    // The secret is gone from the screen once set up.
    expect(screen.queryByText(groupedKey(SECRET))).toBeNull();
    const go = screen.getByRole("button", { name: "Continue to Oculus" });
    expect(go.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /I have saved these codes/ }));
    expect(go.hasAttribute("disabled")).toBe(false);
    await userEvent.click(go);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Invented archive site" }),
    ).toBeTruthy();
    expect(screen.queryByText(CODES[0] ?? "")).toBeNull();
    expect(sent.find((s) => s.path === "/api/sign-in/set-up")?.headers["x-oculus-csrf"]).toBe(CSRF);
  });

  it("asks for a fresh code at set-up when the first ran out while choosing", async () => {
    let calls = 0;
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, { ...PENDING, next: "set_up" }],
      "POST /api/sign-in/set-up": [200, { secret: SECRET, otpauthUri: URI }],
      "POST /api/sign-in/set-up/confirm": () => {
        calls += 1;
        if (calls === 1) {
          return [
            409,
            {
              error: "choose_organization",
              organizations: [
                { organizationId: ORG_A, name: "Invented Archive" },
                { organizationId: ORG_B, name: "Invented Library" },
              ],
            },
          ];
        }
        return calls === 2
          ? [422, { error: "invalid_code" }]
          : [
              200,
              {
                session: { organizationId: ORG_B, csrfToken: "n".repeat(43) },
                recoveryCodes: CODES,
              },
            ];
      },
    });
    renderAt("/sign-in/set-up");
    const start = await screen.findByRole("button", { name: "Start setting up" });
    await waitFor(() => {
      expect(start.hasAttribute("disabled")).toBe(false);
    });
    await userEvent.click(start);
    await userEvent.type(await screen.findByLabelText(/^6-digit code from the app/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Invented Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toBe(CODE_AGAIN);
    await userEvent.type(screen.getByLabelText(/^6-digit code from the app/), "654321");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toBeTruthy();
    expect(sent.filter((s) => s.path === "/api/sign-in/set-up/confirm").at(-1)?.body).toEqual({
      code: "654321",
      organizationId: ORG_B,
    });
  });

  it("asks for the set-up code from the email after an administrator's reset", async () => {
    const sent = fakeServer({
      "GET /api/sign-in/pending": [200, { ...PENDING, next: "set_up", setUpLinkRequired: true }],
      "POST /api/sign-in/set-up": [403, { error: "set_up_link_required" }],
    });
    renderAt("/sign-in/set-up");
    const field = await screen.findByLabelText(/^Set-up code from the email/);
    await userEvent.type(field, "emailed-invented-code");
    await userEvent.click(screen.getByRole("button", { name: "Start setting up" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't right or has expired/);
    expect(sent.find((s) => s.path === "/api/sign-in/set-up")?.body).toEqual({
      setUpLink: "emailed-invented-code",
    });
  });

  it("groups the key in fours", () => {
    expect(groupedKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});
