// @vitest-environment jsdom
// Clean up removed files (S-052): a tab of System settings; what is waiting
// and its size, from the server's dry run; the button running one step,
// asking for the password and a code again when the server says so; the
// server's refusals in plain words; and nothing for people who aren't
// system managers.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORG_A,
  SITE_1,
  fakeServer,
  me,
  renderAt,
  type Reply,
  type Sent,
} from "../testing.fixtures";

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

const none = { files: 0, bytes: 0 };
const STATUS = {
  available: true,
  dryRun: true,
  trashed: { files: 2, bytes: 3 * 1024 * 1024 },
  deleted: { files: 1, bytes: 2048 },
  restored: none,
  waiting: { files: 3, bytes: 4 * 1024 * 1024 },
};

function server(status: unknown, extra: Record<string, Reply | ((s: Sent) => Reply)> = {}): Sent[] {
  return fakeServer({
    "GET /api/me": [200, { ...me([A1]), systemAdmin: true }],
    "GET /api/people": [403, { error: "not_permitted" }],
    "GET /api/audit?limit=1": [403, { error: "not_permitted" }],
    "GET /api/system/files/cleanup": [200, status],
    ...extra,
  });
}

describe("Clean up removed files", () => {
  it("is a System settings tab showing what is waiting and its size", async () => {
    server(STATUS);
    renderAt("/settings/files");
    const tabs = await screen.findByRole("navigation", { name: "System settings" });
    expect(within(tabs).getByRole("link", { name: "Removed files" }).getAttribute("href")).toBe(
      "/settings/files",
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Clean up removed files" }),
    ).toBeTruthy();
    expect(screen.getByText("2 files (3.0 MB)")).toBeTruthy();
    expect(screen.getByText("1 file (2 KB)")).toBeTruthy();
    expect(screen.getByText("3 files (4.0 MB)")).toBeTruthy();
  });

  it("runs a step, asking for the password and a code again first", async () => {
    const user = userEvent.setup();
    let runs = 0;
    const sent = server(STATUS, {
      "POST /api/system/files/cleanup": () => {
        runs++;
        return runs === 1
          ? [403, { error: "reauthentication_required" }]
          : [200, { ...STATUS, dryRun: false, deleted: none }];
      },
      "POST /api/reauthenticate": [200, { ok: true }],
    });
    renderAt("/settings/files");
    await user.click(await screen.findByRole("button", { name: "Run a clean-up step" }));
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
    expect(screen.getByText(/To clean up removed files, enter your password/)).toBeTruthy();
    await user.type(screen.getByLabelText("Your password"), "invented password");
    await user.type(screen.getByLabelText("Code from your app, or a recovery code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm and continue" }));
    await waitFor(() => {
      expect(runs).toBe(2);
    });
    expect(await screen.findByText(/Done\. Moved to the trash: 2 files/)).toBeTruthy();
    const posts = sent.filter((s) => s.method === "POST" && s.path === "/api/system/files/cleanup");
    expect(posts.map((p) => p.body)).toEqual([{}, {}]);
  });

  it("says why nothing can be cleaned up when the folder isn't this database's", async () => {
    server({ available: false, problem: "lease_mismatch" });
    renderAt("/settings/files");
    expect(await screen.findByText(/Another database is using the files folder/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run a clean-up step" })).toBeNull();
  });

  it("shows what is stuck in the trash, and says when the disk can't be cleaned up", async () => {
    server({ ...STATUS, stuck: { files: 1, bytes: 5 * 1024 * 1024 } });
    renderAt("/settings/files");
    expect(await screen.findByText(/Stuck in the trash/)).toBeTruthy();
    expect(screen.getByText("1 file (5.0 MB)")).toBeTruthy();
    cleanup();
    server({ available: false, problem: "mtime_unreliable" });
    renderAt("/settings/files");
    expect(await screen.findByText(/doesn't keep file times exactly enough/)).toBeTruthy();
  });

  it("offers to accept this database after an upgrade, asking for the password and a code again", async () => {
    const user = userEvent.setup();
    let accepts = 0;
    const sent = server(
      { available: false, problem: "identity_changed" },
      {
        "POST /api/system/files/cleanup/accept-identity": () => {
          accepts++;
          return accepts === 1
            ? [403, { error: "reauthentication_required" }]
            : [200, { accepted: true, changed: true }];
        },
        "POST /api/reauthenticate": [200, { ok: true }],
      },
    );
    renderAt("/settings/files");
    expect(await screen.findByText(/The files folder names another database/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Accept this database as the owner" }));
    await user.type(await screen.findByLabelText("Your password"), "invented password");
    await user.type(screen.getByLabelText("Code from your app, or a recovery code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm and continue" }));
    expect(await screen.findByText("This database is now the files folder's owner.")).toBeTruthy();
    expect(sent.filter((s) => s.path === "/api/system/files/cleanup/accept-identity")).toHaveLength(
      2,
    );
  });

  it("has nothing to run when nothing is waiting", async () => {
    server({ ...STATUS, trashed: none, deleted: none });
    renderAt("/settings/files");
    expect(await screen.findByText("Nothing can be cleaned up right now.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run a clean-up step" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("answers a refusal for someone who isn't a system manager", async () => {
    fakeServer({
      "GET /api/me": [200, { ...me([A1]), systemAdmin: true }],
      "GET /api/system/files/cleanup": [403, { error: "not_permitted" }],
    });
    renderAt("/settings/files");
    expect(
      await screen.findByText("Only system managers can clean up removed files."),
    ).toBeTruthy();
  });
});
