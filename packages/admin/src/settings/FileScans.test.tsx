// @vitest-environment jsdom
// Settings › Virus scanning (S-040): scanning on, with the counts and the
// rescan (sent with the CSRF token, a fresh sign-in asked for when the
// server wants one); scanning off, said plainly; nobody but a system
// manager sees the screen.
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

const SITES = [
  {
    siteId: SITE_1,
    organizationId: ORG_A,
    siteName: "Invented archive site",
    organizationName: "Invented Archive",
  },
];
const admin = { ...me(SITES), systemAdmin: true };
const COUNTS = { pending: 2, clean: 1204, infected: 1, failed: 3, unscanned: 1 };

function server(routes: Record<string, Reply | ((s: Sent) => Reply)>, person: unknown = admin) {
  return fakeServer({ "GET /api/me": [200, person], ...routes });
}

describe("virus scanning settings", () => {
  it("shows scanning on with the counts, and scans every file again", async () => {
    const sent = server({
      "GET /api/system/file-scans": [200, { scanning: true, counts: COUNTS }],
      "POST /api/system/file-scans/rescan": [200, { queued: 1207 }],
    });
    const user = userEvent.setup();
    renderAt("/settings/files");
    expect(await screen.findByText(/Scanning is on/)).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "System settings" });
    expect(within(nav).getByRole("link", { name: "Virus scanning" })).toBeTruthy();
    expect(screen.getByText("1,204 files are clean")).toBeTruthy();
    expect(screen.getByText("3 files are waiting to be scanned")).toBeTruthy();
    expect(screen.getByText("1 file holds a virus and is quarantined")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Scan every file again" }));
    expect(await screen.findByText("1,207 files will be scanned again.")).toBeTruthy();
    const post = sent.find((s) => s.method === "POST");
    expect(post?.path).toBe("/api/system/file-scans/rescan");
    expect(post?.body).toEqual({});
  });

  it("asks for a fresh sign-in when the server wants one", async () => {
    server({
      "GET /api/system/file-scans": [200, { scanning: true, counts: COUNTS }],
      "POST /api/system/file-scans/rescan": [403, { error: "reauthentication_required" }],
    });
    const user = userEvent.setup();
    renderAt("/settings/files");
    await user.click(await screen.findByRole("button", { name: "Scan every file again" }));
    expect(await screen.findByText(/To scan every file again, enter your password/)).toBeTruthy();
  });

  it("says plainly when scanning is off, with no rescan", async () => {
    server({
      "GET /api/system/file-scans": [200, { scanning: false, counts: { ...COUNTS, infected: 0 } }],
    });
    renderAt("/settings/files");
    expect(
      await screen.findByText(/Scanning is off: uploaded files are not scanned for viruses/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scan every file again" })).toBeNull();
  });

  it("isn't shown to anyone but a system manager", async () => {
    const sent = server({}, me(SITES));
    renderAt("/settings/files");
    expect(await screen.findByText(/Only system managers can see or change/)).toBeTruthy();
    await waitFor(() => {
      expect(sent.some((s) => s.path.startsWith("/api/system/file-scans"))).toBe(false);
    });
  });
});
