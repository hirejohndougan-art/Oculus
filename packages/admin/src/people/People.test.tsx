// @vitest-environment jsdom
// The people screens (T-048): the list with names as text, actions shown
// only where the rights allow, in-page confirmations, D-078's warning before
// a reset link to an account with no second factor in use, the re-entry form
// when the server asks for it, the invitation form (no token anywhere) and
// the audit trail's filters and paging.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORG_A, SITE_1, SITE_2, fakeServer, me, renderAt, type Sent } from "../testing.fixtures";

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
const A2 = { ...A1, siteId: SITE_2, siteName: "Invented second site" };
const PERSON = "00000000-0000-4000-8000-0000000000aa";
const GRANT = "00000000-0000-4000-8000-0000000000bb";

const SYSTEM = { systemManager: true, manageSites: [SITE_1, SITE_2], manageAccounts: true };
const SITE_MANAGER = { systemManager: false, manageSites: [SITE_1], manageAccounts: false };

function person(extra: Record<string, unknown> = {}) {
  return {
    userId: PERSON,
    displayName: "<b>Bea</b> Invented",
    email: "bea@example.org",
    disabled: false,
    lastSignInAt: null,
    addedAt: "2026-11-01T10:00:00.000Z",
    roles: [
      {
        id: GRANT,
        role: "cataloger",
        siteId: SITE_1,
        scope: null,
        grantedAt: "2026-11-01T10:00:00.000Z",
      },
    ],
    ...extra,
  };
}

const ROLES = {
  roles: [
    {
      role: "site_manager",
      label: "Site manager",
      permissions: ["records.view"],
      grantable: false,
    },
    { role: "cataloger", label: "Cataloger", permissions: ["records.view"], grantable: true },
  ],
};

function server(rights: typeof SYSTEM, detail: Record<string, unknown>, more = {}): Sent[] {
  return fakeServer({
    "GET /api/me": [200, { ...me([A1, A2]), systemAdmin: rights.systemManager }],
    "GET /api/people": [200, { people: [person()], truncated: false, rights }],
    "GET /api/audit?limit=1": [200, { entries: [], next: null }],
    "GET /api/roles": [200, ROLES],
    [`GET /api/people/${PERSON}`]: [200, { person: person(), rights, ...detail }],
    ...more,
  });
}

describe("the people list", () => {
  it("shows names as text, links to each person, and offers inviting to system managers", async () => {
    server(SYSTEM, {});
    renderAt("/people");
    const link = await screen.findByRole("link", { name: "<b>Bea</b> Invented" });
    expect(link.getAttribute("href")).toBe(`/people/${PERSON}`);
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("Cataloger on Invented archive site")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Invite someone" })).toBeTruthy();
    const nav = screen.getByRole("list", { name: "Administration" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["People", "Roles", "Audit trail"]);
  });

  it("says an email and last sign-in are not shown for someone seen by name only", async () => {
    const nameOnly = { userId: PERSON, displayName: "Lone Invented", roles: [], nameOnly: true };
    server(
      SITE_MANAGER,
      {},
      {
        "GET /api/people": [200, { people: [nameOnly], truncated: false, rights: SITE_MANAGER }],
      },
    );
    renderAt("/people");
    await screen.findByRole("link", { name: "Lone Invented" });
    expect(screen.getAllByText("Not shown")).toHaveLength(2);
    expect(screen.queryByText("never")).toBeNull();
  });

  it("offers no inviting to a site manager", async () => {
    server(SITE_MANAGER, {});
    renderAt("/people");
    await screen.findByRole("link", { name: "<b>Bea</b> Invented" });
    expect(screen.queryByRole("link", { name: "Invite someone" })).toBeNull();
  });

  it("hides the administration links from people the server refuses", async () => {
    fakeServer({
      "GET /api/me": [200, me([A1])],
      "GET /api/people": [403, { error: "not_permitted" }],
      "GET /api/audit?limit=1": [403, { error: "not_permitted" }],
    });
    renderAt(`/sites/${SITE_1}`);
    await screen.findByRole("heading", { level: 1, name: "Invented archive site" });
    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Administration" })).toBeNull();
    });
  });
});

describe("a person's page", () => {
  it("shows a site manager only the role actions they may take", async () => {
    server(SITE_MANAGER, {});
    renderAt(`/people/${PERSON}`);
    await screen.findByRole("heading", { level: 1, name: "<b>Bea</b> Invented" });
    expect(screen.getByRole("button", { name: "Remove…" })).toBeTruthy();
    for (const name of [
      /Disable the account/,
      /Reset two-step/,
      /password reset link/,
      /Sign them out/,
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("shows someone with no role by name only, with no way to give them a role (John, Q-10)", async () => {
    const nameOnly = { userId: PERSON, displayName: "Lone Invented", roles: [], nameOnly: true };
    server(
      SITE_MANAGER,
      {},
      {
        "GET /api/people": [200, { people: [nameOnly], truncated: false, rights: SITE_MANAGER }],
        [`GET /api/people/${PERSON}`]: [200, { person: nameOnly, rights: SITE_MANAGER }],
      },
    );
    renderAt(`/people/${PERSON}`);
    await screen.findByRole("heading", { level: 1, name: "Lone Invented" });
    expect(screen.getByText(/A system manager gives a person their first role/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Give a role" })).toBeNull();
    expect(screen.queryByText(/Member since/)).toBeNull();
    expect(screen.queryByText(/never/)).toBeNull();
  });

  it("confirms in the page before removing a role, and sends the DELETE only then", async () => {
    const sent = server(
      SITE_MANAGER,
      {},
      {
        [`DELETE /api/role-assignments/${GRANT}`]: [200, { revoked: GRANT }],
      },
    );
    renderAt(`/people/${PERSON}`);
    await userEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const confirm = screen.getByRole("region", { name: /Remove Cataloger/ });
    expect(document.activeElement).toBe(confirm);
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove the role" }));
    expect(await screen.findByText("The role was removed.")).toBeTruthy();
    expect(sent.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });

  it("warns before a reset link when no second factor is in use (D-078)", async () => {
    const sent = server(
      SYSTEM,
      {
        sessions: [],
        secondStep: { inUse: false, enrolledAt: null, recentAlerts: 0, lastAlertAt: null },
      },
      { [`POST /api/people/${PERSON}/password-reset`]: [200, { expiresAt: "x" }] },
    );
    renderAt(`/people/${PERSON}`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Send a password reset link…" }),
    );
    const confirm = screen.getByRole("region", { name: "Send them a password reset link?" });
    expect(within(confirm).getByText(/take over the account/)).toBeTruthy();
    const send = within(confirm).getByRole("button", { name: "Send the link" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await userEvent.click(
      within(confirm).getByLabelText("I have confirmed who they are another way"),
    );
    await userEvent.click(send);
    await screen.findByText(/reset link is on its way/);
    const post = sent.find((s) => s.path.endsWith("/password-reset"));
    expect(post?.body).toEqual({ confirmMailboxOnly: true });
  });

  it("sends no warning or confirmation flag when a second factor is in use", async () => {
    const sent = server(
      SYSTEM,
      {
        sessions: [],
        secondStep: {
          inUse: true,
          enrolledAt: "2026-11-01T10:00:00.000Z",
          recentAlerts: 2,
          lastAlertAt: "2026-11-20T10:00:00.000Z",
          alerts: [
            { at: "2026-11-20T10:00:00.000Z", failures: 15, notice: "covered" },
            { at: "2026-11-20T09:00:00.000Z", failures: 5, notice: "emailed" },
          ],
        },
      },
      { [`POST /api/people/${PERSON}/password-reset`]: [200, { expiresAt: "x" }] },
    );
    renderAt(`/people/${PERSON}`);
    expect(await screen.findByText(/typed wrong codes for this account 2 times/)).toBeTruthy();
    const listed = screen.getByRole("list", { name: "Recent wrong-code alerts" });
    expect(listed.textContent).toContain("15 wrong codes, covered by an earlier email");
    expect(listed.textContent).toContain("5 wrong codes, emailed to them and the system managers");
    await userEvent.click(screen.getByRole("button", { name: "Send a password reset link…" }));
    expect(screen.queryByText(/take over the account/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Send the link" }));
    await screen.findByText(/reset link is on its way/);
    expect(sent.find((s) => s.path.endsWith("/password-reset"))?.body).toEqual({});
  });

  it("asks for the password and a code again when the server wants it, then retries", async () => {
    let calls = 0;
    const sent = server(
      SYSTEM,
      {
        sessions: [],
        secondStep: { inUse: true, enrolledAt: null, recentAlerts: 0, lastAlertAt: null },
      },
      {
        [`POST /api/people/${PERSON}/disable`]: () => {
          calls += 1;
          return calls === 1
            ? [403, { error: "reauthentication_required" }]
            : [200, { changed: true }];
        },
        "POST /api/reauthenticate": [200, { session: { csrfToken: "n".repeat(43) } }],
      },
    );
    renderAt(`/people/${PERSON}`);
    await userEvent.click(await screen.findByRole("button", { name: "Disable the account…" }));
    await userEvent.click(screen.getByRole("button", { name: "Disable the account" }));
    const form = await screen.findByRole("form", { name: "Confirm it's you" });
    await userEvent.type(within(form).getByLabelText("Your password"), "Invented password 1");
    await userEvent.type(
      within(form).getByLabelText("Code from your app, or a recovery code"),
      "123456",
    );
    await userEvent.click(within(form).getByRole("button", { name: "Confirm and continue" }));
    expect(await screen.findByText(/account is disabled and signed out/)).toBeTruthy();
    expect(sent.find((s) => s.path === "/api/reauthenticate")?.body).toEqual({
      password: "Invented password 1",
      code: "123456",
    });
    expect(calls).toBe(2);
  });

  it("resets two-step sign-in with the admin's own code, typed in the confirmation", async () => {
    const sent = server(
      SYSTEM,
      {
        sessions: [],
        secondStep: { inUse: true, enrolledAt: null, recentAlerts: 0, lastAlertAt: null },
      },
      {
        [`POST /api/people/${PERSON}/reset-two-step`]: [
          200,
          { hadFactor: true, ended: 1, delivered: true },
        ],
      },
    );
    renderAt(`/people/${PERSON}`);
    await userEvent.click(await screen.findByRole("button", { name: "Reset two-step sign-in…" }));
    const confirm = screen.getByRole("region", { name: "Reset their two-step sign-in?" });
    await userEvent.type(
      within(confirm).getByLabelText(/Your own code/),
      "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01",
    );
    await userEvent.click(within(confirm).getByRole("button", { name: "Reset two-step sign-in" }));
    await screen.findByText(/set-up code is on its way/);
    expect(sent.find((s) => s.path.endsWith("/reset-two-step"))?.body).toEqual({
      recoveryCode: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01",
    });
  });
});

describe("inviting", () => {
  it("sends the address and the life, and shows no link", async () => {
    const sent = server(
      SYSTEM,
      {},
      {
        "POST /api/invitations": [
          201,
          { invitationId: GRANT, email: "new@example.org", expiresAt: "2026-12-01T10:00:00.000Z" },
        ],
      },
    );
    renderAt("/people/invite");
    await userEvent.type(await screen.findByLabelText(/Their email address/), "new@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send the invitation" }));
    expect(await screen.findByText(/invitation is on its way to new@example.org/)).toBeTruthy();
    expect(sent.find((s) => s.path === "/api/invitations")?.body).toEqual({
      email: "new@example.org",
      expiresInDays: 7,
    });
  });
});

describe("the audit trail", () => {
  it("lists changes, filters by person and dates, and pages", async () => {
    const page1 = {
      entries: [
        {
          type: "people",
          at: "2026-11-20T10:00:00.000Z",
          actor: "user:x",
          actorName: "<i>Root</i>",
          eventId: GRANT,
          kind: "role_granted",
          subjectId: PERSON,
          subjectName: "Bea Invented",
          role: "cataloger",
          siteId: SITE_1,
          scope: null,
          invitedEmail: null,
        },
      ],
      next: "2026-11-20T10:00:00.000000_e" + GRANT,
    };
    const page2 = {
      entries: [
        {
          type: "record",
          at: "2026-11-19T10:00:00.000Z",
          actor: "system:import",
          actorName: null,
          recordId: PERSON,
          version: 2,
          action: "delete",
          title: "An invented cup",
          kind: "object",
          changedFields: [],
          reason: null,
          deleted: true,
        },
      ],
      next: null,
    };
    const sent = fakeServer({
      "GET /api/me": [200, me([A1])],
      "GET /api/people": [200, { people: [person()], truncated: false, rights: SYSTEM }],
      "GET /api/audit?limit=1": [200, { entries: [], next: null }],
      "GET /api/audit?limit=50": [200, page1],
      [`GET /api/audit?after=${encodeURIComponent(page1.next)}&limit=50`]: [200, page2],
      [`GET /api/audit?person=${PERSON}&from=2026-11-01&to=2026-11-21&limit=50`]: [200, page2],
    });
    renderAt("/audit");
    expect(
      await screen.findByText("Gave a role to Bea Invented: Cataloger on Invented archive site"),
    ).toBeTruthy();
    expect(screen.getByText("<i>Root</i>")).toBeTruthy();
    expect(document.querySelector("i")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show older changes" }));
    expect(
      await screen.findByText(/Deleted “An invented cup” \(version 2, since deleted\)/),
    ).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Person"), PERSON);
    await userEvent.type(screen.getByLabelText("From"), "2026-11-01");
    await userEvent.type(screen.getByLabelText("To"), "2026-11-20");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => {
      expect(sent.some((s) => s.path.startsWith(`/api/audit?person=${PERSON}`))).toBe(true);
    });
  });

  it("shows installs and rollbacks of Oculus, from the admin and the command line", async () => {
    fakeServer({
      "GET /api/me": [200, { ...me([A1]), systemAdmin: true }],
      "GET /api/people": [200, { people: [person()], truncated: false, rights: SYSTEM }],
      "GET /api/audit?limit=1": [200, { entries: [], next: null }],
      "GET /api/audit?limit=50": [
        200,
        {
          entries: [
            {
              type: "system",
              at: "2026-11-25T10:00:00.000Z",
              actor: "command_line",
              actorName: null,
              eventId: GRANT,
              kind: "update_installed",
              version: "1.3.0",
              fromVersion: null,
            },
            {
              type: "system",
              at: "2026-11-24T10:00:00.000Z",
              actor: "user:x",
              actorName: "Root Invented",
              eventId: PERSON,
              kind: "update_rolled_back",
              version: "1.1.0",
              fromVersion: "1.2.0",
            },
          ],
          next: null,
        },
      ],
    });
    renderAt("/audit");
    expect(
      await screen.findByText("Installed Oculus 1.3.0 (from a development build)"),
    ).toBeTruthy();
    expect(screen.getByText("The server's command line")).toBeTruthy();
    expect(screen.getByText("Went back to Oculus 1.1.0 (from 1.2.0)")).toBeTruthy();
    expect(screen.getByText("Root Invented")).toBeTruthy();
  });
});
