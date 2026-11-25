// @vitest-environment jsdom
// The Updates screen (T-060): set-up help when updates aren't configured,
// refusal for people who aren't system managers, the upload in parts of the
// size the server names (base64, in order, then finish), the waiting
// package's details as plain text, an in-page confirmation before
// installing, the re-entry form when the server asks for it, a rollback
// only when allowed, and the sidebar link only when the server answers.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateTiming } from "./Updates";
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

const BASE = {
  configured: true,
  runningVersion: "0.1.0",
  runningFromCurrent: true,
  startCommand: "node /srv/oculus/current/packages/api/dist/admin-cli.js",
  restart: "none",
  backups: true,
  migrationsFromWeb: true,
  partBytes: 4,
  maxPackageBytes: 1000,
  upload: null,
  pending: null,
  job: null,
  restartNeeded: false,
  rollback: null,
  history: [],
};

const PENDING = {
  version: "0.2.0",
  builtAt: "2026-11-24T12:00:00.000Z",
  notes: "<b>Invented</b> fixes.",
  keyId: "0123456789abcdef",
  files: 4003,
  bytes: 6_500_000,
  newMigrations: ["0021_more.sql"],
};

function server(status: unknown, extra: Record<string, Reply | ((s: Sent) => Reply)> = {}): Sent[] {
  return fakeServer({
    "GET /api/me": [200, { ...me([A1]), systemAdmin: true }],
    "GET /api/people": [403, { error: "not_permitted" }],
    "GET /api/audit?limit=1": [403, { error: "not_permitted" }],
    "GET /api/system/update": [200, status],
    ...extra,
  });
}

describe("the Updates screen", () => {
  it("explains the set-up when updates aren't configured", async () => {
    server({
      configured: false,
      runningVersion: null,
      variables: ["OCULUS_UPDATE_DIR", "OCULUS_UPDATE_KEYS"],
    });
    renderAt("/settings/updates");
    expect(await screen.findByText(/Updates aren't set up on this server yet/)).toBeTruthy();
    expect(screen.getByText(/OCULUS_UPDATE_DIR, OCULUS_UPDATE_KEYS/)).toBeTruthy();
    expect(screen.getByText(/a development build/)).toBeTruthy();
  });

  it("is a tab of System settings, which people who aren't system managers don't see", async () => {
    fakeServer({
      "GET /api/me": [200, me([A1])],
      "GET /api/system/update": [403, { error: "not_permitted" }],
    });
    renderAt("/settings/updates");
    expect(
      await screen.findByText(/Only system managers can see or change System settings/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Update package (.zip)")).toBeNull();
  });

  it("answers a refusal from the server even inside the tab", async () => {
    fakeServer({
      "GET /api/me": [200, { ...me([A1]), systemAdmin: true }],
      "GET /api/system/update": [403, { error: "not_permitted" }],
    });
    renderAt("/settings/updates");
    expect(await screen.findByText("Only system managers can update Oculus.")).toBeTruthy();
  });

  it("is reached from the System settings tabs", async () => {
    server(BASE);
    renderAt("/settings/updates");
    const tabs = await screen.findByRole("navigation", { name: "System settings" });
    expect(within(tabs).getByRole("link", { name: "Updates" }).getAttribute("href")).toBe(
      "/settings/updates",
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Updates" })).toBeTruthy();
  });

  it("warns when Oculus isn't running from the updates folder", async () => {
    server({ ...BASE, runningFromCurrent: false });
    renderAt("/settings/updates");
    expect(await screen.findByText(/isn't running from its updates folder/)).toBeTruthy();
    expect(screen.getByText(BASE.startCommand)).toBeTruthy();
  });

  it("uploads in ordered parts of the server's size, then asks for the check", async () => {
    const user = userEvent.setup();
    const id = "a".repeat(32);
    const sent = server(BASE, {
      "POST /api/system/update/uploads": [201, { uploadId: id, partBytes: 4 }],
      [`PUT /api/system/update/uploads/${id}/parts/0`]: [200, { received: 4 }],
      [`PUT /api/system/update/uploads/${id}/parts/1`]: [200, { received: 6 }],
      [`POST /api/system/update/uploads/${id}/finish`]: [202, BASE],
    });
    renderAt("/settings/updates");
    const input = await screen.findByLabelText("Update package (.zip)");
    await user.upload(
      input,
      new File([new Uint8Array([1, 2, 3, 4, 5, 6])], "oculus-0.2.0.zip", {
        type: "application/zip",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and check" }));
    await waitFor(() => {
      expect(sent.some((s) => s.path.endsWith("/finish"))).toBe(true);
    });
    const posted = sent.filter((s) => s.method !== "GET");
    expect(posted.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/system/update/uploads",
      `PUT /api/system/update/uploads/${id}/parts/0`,
      `PUT /api/system/update/uploads/${id}/parts/1`,
      `POST /api/system/update/uploads/${id}/finish`,
    ]);
    expect(posted[0]?.body).toEqual({ size: 6 });
    expect(posted[1]?.body).toEqual({ data: Buffer.from([1, 2, 3, 4]).toString("base64") });
    expect(posted[2]?.body).toEqual({ data: Buffer.from([5, 6]).toString("base64") });
  });

  it("waits and sends a part again when the server says to slow down", async () => {
    updateTiming.retryMs = 1;
    const user = userEvent.setup();
    const id = "c".repeat(32);
    let tries = 0;
    const sent = server(BASE, {
      "POST /api/system/update/uploads": [201, { uploadId: id, partBytes: 4 }],
      [`PUT /api/system/update/uploads/${id}/parts/0`]: () => {
        tries++;
        return tries < 3 ? [429, { error: "rate_limited" }] : [200, { received: 2 }];
      },
      [`POST /api/system/update/uploads/${id}/finish`]: [202, BASE],
    });
    renderAt("/settings/updates");
    const input = await screen.findByLabelText("Update package (.zip)");
    await user.upload(input, new File([new Uint8Array([1, 2])], "small.zip"));
    await user.click(screen.getByRole("button", { name: "Upload and check" }));
    await waitFor(() => {
      expect(sent.some((s) => s.path.endsWith("/finish"))).toBe(true);
    });
    expect(tries).toBe(3);
  });

  it("warns when a database-changing update can't be installed from here", async () => {
    server({ ...BASE, migrationsFromWeb: false, pending: PENDING });
    renderAt("/settings/updates");
    expect(await screen.findByText(/isn't set up to change its database from here/)).toBeTruthy();
  });

  it("refuses a file larger than the server takes, before sending anything", async () => {
    const user = userEvent.setup();
    const sent = server({ ...BASE, maxPackageBytes: 3 });
    renderAt("/settings/updates");
    const input = await screen.findByLabelText("Update package (.zip)");
    await user.upload(input, new File([new Uint8Array(10)], "big.zip"));
    await user.click(screen.getByRole("button", { name: "Upload and check" }));
    expect(await screen.findByText(/larger than Oculus accepts/)).toBeTruthy();
    expect(sent.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("shows a refused package's reason", async () => {
    server({
      ...BASE,
      job: {
        kind: "verify",
        state: "failed",
        step: "failed",
        error: "unknown_key",
        message: "The package wasn't signed by a key this server trusts.",
      },
    });
    renderAt("/settings/updates");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The package wasn't signed by a key this server trusts.",
    );
  });

  it("shows the waiting package as text, confirms in the page, and asks for the password again", async () => {
    const user = userEvent.setup();
    let installs = 0;
    const sent = server(
      { ...BASE, pending: PENDING },
      {
        "POST /api/system/update/install": () => {
          installs++;
          return installs === 1
            ? [403, { error: "reauthentication_required" }]
            : [202, { ...BASE, job: { kind: "install", state: "running", step: "migrating" } }];
        },
        "POST /api/reauthenticate": [200, { ok: true }],
      },
    );
    renderAt("/settings/updates");
    expect(
      await screen.findByRole("heading", { name: "Ready to install: Oculus 0.2.0" }),
    ).toBeTruthy();
    expect(screen.getByText("<b>Invented</b> fixes.")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText(/The database is backed up first/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Install…" }));
    await user.click(screen.getByRole("button", { name: "Install Oculus 0.2.0" }));
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
    await user.type(screen.getByLabelText("Your password"), "invented password");
    await user.type(screen.getByLabelText("Code from your app, or a recovery code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm and continue" }));
    await waitFor(() => {
      expect(installs).toBe(2);
    });
    const install = sent.filter((s) => s.path === "/api/system/update/install");
    expect(install.map((s) => s.body)).toEqual([{ version: "0.2.0" }, { version: "0.2.0" }]);
  });

  it("can remove the waiting package", async () => {
    const user = userEvent.setup();
    const sent = server(
      { ...BASE, pending: PENDING },
      { "DELETE /api/system/update/pending": [200, BASE] },
    );
    renderAt("/settings/updates");
    await user.click(await screen.findByRole("button", { name: "Remove this package" }));
    await waitFor(() => {
      expect(sent.some((s) => s.method === "DELETE")).toBe(true);
    });
  });

  it("offers going back only when the server allows it", async () => {
    const user = userEvent.setup();
    const sent = server(
      {
        ...BASE,
        rollback: { version: "0.1.0", allowed: true },
        history: [
          { kind: "install", version: "0.2.0", from: "0.1.0", at: "2026-11-24T12:00:00.000Z" },
        ],
      },
      { "POST /api/system/update/rollback": [202, BASE] },
    );
    renderAt("/settings/updates");
    await user.click(await screen.findByRole("button", { name: "Go back…" }));
    await user.click(screen.getByRole("button", { name: "Go back to 0.1.0" }));
    await waitFor(() => {
      expect(sent.find((s) => s.path === "/api/system/update/rollback")?.body).toEqual({
        version: "0.1.0",
      });
    });
    expect(screen.getByText("Installed 0.2.0 (from 0.1.0)")).toBeTruthy();
  });

  it("explains when going back isn't possible", async () => {
    server({ ...BASE, rollback: { version: "0.1.0", allowed: false } });
    renderAt("/settings/updates");
    expect(await screen.findByText(/restore the backup taken before that update/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go back…" })).toBeNull();
  });

  it("says a restart is needed after an install", async () => {
    server({ ...BASE, restartNeeded: true });
    renderAt("/settings/updates");
    expect(
      await screen.findByText(/Restart Oculus from your host's control panel to finish/),
    ).toBeTruthy();
  });
});
