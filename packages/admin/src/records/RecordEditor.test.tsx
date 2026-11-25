// @vitest-environment jsdom
// The record editor (T-046): the form from the template with inherited
// values, the server's dry-run check beside each field, saving with
// If-Match and the 412 conflict with a reload (never overwriting), the
// warning before saving a published record, workflow buttons and Delete only
// where the server says the person may, the history panel only for people
// who may read history (view, compare, restore with confirmMadePublic when
// the server asks), unsaved-changes protection, creating a record, and
// record text shown as text, never as HTML or a link.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_1, fakeServer, me, renderAt, type Reply, type Sent } from "../testing.fixtures";
import {
  A1,
  ALL,
  CATALOGER,
  PARENT_ID,
  READER,
  RECORD_ID,
  TEMPLATES_REPLY,
  TYPES_REPLY,
  VERSIONS_REPLY,
  recordReply,
} from "./records.fixtures";
import { forgetLists } from "./listMemory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetLists();
});

const PATH = `/sites/${SITE_1}/records/${RECORD_ID}`;
const API = `/api/records/${RECORD_ID}`;

type Route = Reply | ((sent: Sent) => Reply);

function server(record: Route, routes: Record<string, Route> = {}) {
  return fakeServer({
    "GET /api/me": [200, me([A1])],
    "GET /api/working-site": [200, { createKinds: ["object"], review: true }],
    "GET /api/record-types": [200, TYPES_REPLY],
    "GET /api/templates": [200, TEMPLATES_REPLY],
    "GET /api/records?limit=25": [200, { records: [], next: null }],
    [`GET ${API}`]: record,
    [`GET ${API}/versions?limit=100`]: [200, VERSIONS_REPLY],
    "POST /api/records/check": [200, { issues: [] }],
    ...routes,
  });
}

async function opened() {
  return screen.findByRole("heading", { level: 1, name: "An invented lantern" });
}

describe("the record editor's form", () => {
  it("is built from the template, with help, staff marks and inherited values", async () => {
    server([
      200,
      recordReply({
        inherited: [{ key: "provenance", value: "Given by an invented family.", from: PARENT_ID }],
      }),
    ]);
    const { container } = renderAt(PATH);
    await opened();
    const note = screen.getByLabelText(/^Note \(required\)/);
    expect((note as HTMLInputElement).value).toBe("Tin.");
    expect(screen.getByText("What it is.")).toBeTruthy();
    expect(screen.getByText("Staff only")).toBeTruthy();
    expect(screen.getByText(/Given by an invented family\./).textContent).toMatch(
      /^Inherited from the unit above/,
    );
    expect(screen.getByRole("link", { name: "the unit above" }).getAttribute("href")).toBe(
      `/sites/${SITE_1}/records/${PARENT_ID}`,
    );
    // A stored javascript: address stays text in its field: no link is made from it.
    expect(
      [...container.querySelectorAll("a")].some((a) =>
        (a.getAttribute("href") ?? "").toLowerCase().includes("javascript"),
      ),
    ).toBe(false);
    expect(screen.getByDisplayValue("javascript:alert(1)")).toBeTruthy();
    // No status move but the editor's own: a cataloger sends for review.
    expect(screen.getByRole("button", { name: "Send for review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete this record" })).toBeNull();
  });

  it("shows a title with markup as text", async () => {
    server([200, recordReply({ record: { title: "<img src=x onerror=alert(1)>" } })]);
    const { container } = renderAt(PATH);
    expect(
      await screen.findByRole("heading", { level: 1, name: "<img src=x onerror=alert(1)>" }),
    ).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("checks a field with the server when it loses focus and shows the problem beside it", async () => {
    const sent = server([200, recordReply()], {
      "POST /api/records/check": [
        200,
        {
          issues: [
            { path: ["fields", "note"], code: "required", message: "Note is required." },
            { path: ["fields", "shelf"], code: "too_long", message: "Shelf is too long." },
          ],
        },
      ],
    });
    renderAt(PATH);
    await opened();
    const note = screen.getByLabelText(/^Note \(required\)/);
    await userEvent.clear(note);
    await userEvent.tab();
    expect(await screen.findByText("Note is required.")).toBeTruthy();
    expect(note.getAttribute("aria-invalid")).toBe("true");
    // Only touched fields show their problems until a save is tried.
    expect(screen.queryByText("Shelf is too long.")).toBeNull();
    const check = sent.find((s) => s.path === "/api/records/check");
    expect(check?.body).toMatchObject({ recordId: RECORD_ID, record: { kind: "object" } });
    expect(check?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
    // Not saved while the check finds problems.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Not saved yet/)).toBeTruthy();
    expect(screen.getByText("Shelf is too long.")).toBeTruthy();
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("saves with If-Match and the whole draft", async () => {
    let version = 3;
    const sent = server(() => [200, recordReply({ version })], {
      [`PUT ${API}`]: () => {
        version = 4;
        return [200, { record: {}, version: 4, changed: true }];
      },
    });
    renderAt(PATH);
    await opened();
    await userEvent.type(screen.getByLabelText(/^Shelf/), "Invented shelf 4");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"v3"');
    expect(put?.headers["x-oculus-site"]).toBe(SITE_1);
    expect(put?.body).toEqual({
      record: {
        kind: "object",
        title: "An invented lantern",
        templateKey: "t-object",
        fields: {
          note: "Tin.",
          shelf: "Invented shelf 4",
          links: [{ url: "javascript:alert(1)", label: "Bad link" }],
        },
      },
    });
    await screen.findByText(/Version 4/);
  });

  it("on a 412 says someone else changed it, overwrites nothing, and reloads on request", async () => {
    let version = 3;
    const sent = server(
      () => [
        200,
        recordReply({
          version,
          record: { title: version === 3 ? "An invented lantern" : "Changed elsewhere" },
        }),
      ],
      {
        [`PUT ${API}`]: [
          412,
          {
            error: "version_conflict",
            issues: [{ path: [], code: "version_conflict", message: "Changed." }],
            conflict: {
              expectedVersion: 3,
              currentVersion: 4,
              differences: [{ name: "fields.note", change: "changed" }],
            },
          },
        ],
      },
    );
    renderAt(PATH);
    await opened();
    await userEvent.type(screen.getByLabelText(/^Shelf/), "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByText(/Someone else changed this record since you opened it/);
    expect(alert.textContent).toContain("(Note)");
    expect(alert.textContent).toContain("Nothing was overwritten");
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(1);
    // My text is still on screen.
    expect(screen.getByLabelText<HTMLInputElement>(/^Shelf/).value).toBe("Mine");
    version = 4;
    await userEvent.click(screen.getByRole("button", { name: "Reload the latest version" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Changed elsewhere" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/^Shelf/).value).toBe("");
  });

  it("keeps typed edits when the connection comes back (no refetch under the form)", async () => {
    let version = 3;
    const sent = server(() => [200, recordReply({ version })]);
    renderAt(PATH);
    await opened();
    await userEvent.type(screen.getByLabelText(/^Shelf/), "Typed offline");
    version = 4;
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((s) => s.path === API)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>(/^Shelf/).value).toBe("Typed offline");
  });

  it("says before saving that a published record's changes go live at once", async () => {
    server([200, recordReply({ state: "published", can: CATALOGER })]);
    renderAt(PATH);
    await opened();
    expect(
      screen.getByText(
        /This record is published\. When you save, your changes appear on the public site straight away\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save and update the public site" })).toBeTruthy();
    // A cataloger can't unpublish.
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("is read-only for people who may not edit, with no history panel", async () => {
    server([200, recordReply({ can: READER })]);
    renderAt(PATH);
    await opened();
    expect(screen.getByText(/Your role doesn't include editing it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send for review" })).toBeNull();
    expect(screen.getByLabelText(/^Note/).hasAttribute("readonly")).toBe(true);
  });
});

describe("workflow and delete", () => {
  it("publishes with If-Match and shows why it can't when the server refuses", async () => {
    const sent = server([200, recordReply({ can: ALL })], {
      [`POST ${API}/publish`]: [
        422,
        {
          error: "invalid",
          issues: [
            { path: ["rights"], code: "rights_missing", message: "Choose a rights statement." },
          ],
        },
      ],
    });
    renderAt(PATH);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Can't publish yet:")).toBeTruthy();
    expect(screen.getByText("Choose a rights statement.")).toBeTruthy();
    const post = sent.find((s) => s.path === `${API}/publish`);
    expect(post?.headers["if-match"]).toBe('"v3"');
  });

  it("says when the template has no Dublin Core mapping, so no public site shows the record (T-050e)", async () => {
    const sent = server([200, recordReply({ can: ALL })], {
      "GET /api/templates/t-object/dublin-core": [
        200,
        { key: "t-object", version: 0, mapping: null },
      ],
      [`POST ${API}/publish`]: [200, {}],
    });
    renderAt(PATH);
    await opened();
    expect(
      await screen.findByText(/If you publish this record, no public site will show it yet/),
    ).toBeTruthy();
    const read = sent.find((s) => s.path === "/api/templates/t-object/dublin-core");
    expect(read?.headers["x-oculus-site"]).toBe(SITE_1);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(
      await screen.findByText(
        "Published, but no public site shows it yet: its template has no Dublin Core mapping.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about the mapping when the template has one, or for people who can't publish", async () => {
    server([200, recordReply({ can: ALL })], {
      "GET /api/templates/t-object/dublin-core": [
        200,
        { key: "t-object", version: 1, mapping: {} },
      ],
    });
    renderAt(PATH);
    await opened();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    });
    expect(screen.queryByText(/no Dublin Core mapping/)).toBeNull();
    cleanup();
    server([200, recordReply({ can: CATALOGER })], {
      "GET /api/templates/t-object/dublin-core": [
        200,
        { key: "t-object", version: 0, mapping: null },
      ],
    });
    renderAt(PATH);
    await opened();
    expect(screen.queryByText(/no Dublin Core mapping/)).toBeNull();
  });

  it("tells the people who can see it that a published record isn't shown without a mapping", async () => {
    server([200, recordReply({ state: "published", can: CATALOGER })], {
      "GET /api/templates/t-object/dublin-core": [
        200,
        { key: "t-object", version: 0, mapping: null },
      ],
    });
    renderAt(PATH);
    await opened();
    expect(
      await screen.findByText(/This record is published, but no public site shows it yet/),
    ).toBeTruthy();
  });

  it("waits for unsaved changes before a status change", async () => {
    server([200, recordReply({ can: ALL })]);
    renderAt(PATH);
    await opened();
    await userEvent.type(screen.getByLabelText(/^Shelf/), "x");
    expect(screen.getByRole("button", { name: "Publish" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(/Save or discard your changes before changing the status/),
    ).toBeTruthy();
  });

  it("deletes only for people who may, after asking, with If-Match", async () => {
    const sent = server([200, recordReply({ can: ALL })], {
      [`DELETE ${API}`]: [200, { version: 4 }],
    });
    const { router } = renderAt(PATH);
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Delete this record" }));
    const dialog = await screen.findByRole("region", { name: "Delete this record?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete the record" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_1}`);
    });
    expect(await screen.findByText("The record was deleted.")).toBeTruthy();
    expect(sent.find((s) => s.method === "DELETE")?.headers["if-match"]).toBe('"v3"');
  });
});

describe("the history panel", () => {
  it("lists versions newest first, shows one and compares two", async () => {
    server([200, recordReply({ can: CATALOGER })], {
      [`GET ${API}/versions/1`]: [
        200,
        {
          version: {
            version: 1,
            record: { title: "First title", fields: { note: "<b>Old</b>" } },
          },
        },
      ],
      [`GET ${API}/compare?from=1&to=3`]: [
        200,
        {
          from: 1,
          to: 3,
          differences: [{ name: "fields.note", change: "changed", before: "Old", after: "Tin." }],
        },
      ],
    });
    const { container } = renderAt(PATH);
    await opened();
    const list = await screen.findByRole("list", { name: "Versions, newest first" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Version 3 (current): Sent for review");
    expect(items[2]?.textContent).toContain("You");
    expect(items[0]?.textContent).toContain("Someone else");
    await userEvent.click(screen.getByRole("button", { name: "View version 1" }));
    expect(await screen.findByText("<b>Old</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /From version/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Version 1" }));
    await userEvent.click(screen.getByRole("button", { name: /To version/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Version 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    const table = await screen.findByRole("table", { name: "From version 1 to version 3" });
    expect(within(table).getByText("Note")).toBeTruthy();
    expect(within(table).getByText("Old")).toBeTruthy();
  });

  it("restores after asking, and again with confirmMadePublic when the server asks", async () => {
    let restored = false;
    const sent = server(() => [200, recordReply({ can: CATALOGER, version: restored ? 4 : 3 })], {
      [`POST ${API}/versions/1/restore`]: (s) => {
        const body = s.body as { confirmMadePublic?: string[] };
        if (body.confirmMadePublic === undefined) {
          return [
            422,
            {
              error: "invalid",
              issues: [
                {
                  path: ["fields", "note"],
                  code: "public_field_restored",
                  message: "Note is public now.",
                },
              ],
            },
          ];
        }
        restored = true;
        return [200, { record: {}, version: 4 }];
      },
    });
    renderAt(PATH);
    await opened();
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    const ask = await screen.findByRole("region", { name: "Restore version 1?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Restore this version" }));
    const again = await screen.findByRole("region", { name: "Public values would change" });
    expect(within(again).getByRole("listitem").textContent).toBe("Note");
    await userEvent.click(
      within(again).getByRole("button", { name: "Restore and confirm these values" }),
    );
    expect(await screen.findByText("Restored. The record is now at version 4.")).toBeTruthy();
    const restores = sent.filter((s) => s.path === `${API}/versions/1/restore`);
    expect(restores.map((s) => s.body)).toEqual([{}, { confirmMadePublic: ["note"] }]);
    expect(restores.every((s) => s.headers["if-match"] === '"v3"')).toBe(true);
  });
});

/** The editor's own link back to the list. */
function backLink(): HTMLElement {
  const [link] = screen.getAllByRole("link", { name: "← Item records" });
  if (link === undefined) throw new Error("no link back to the list");
  return link;
}

describe("leaving and creating", () => {
  it("asks before leaving with unsaved changes", async () => {
    server([200, recordReply()]);
    const { router } = renderAt(PATH);
    await opened();
    await userEvent.type(screen.getByLabelText(/^Shelf/), "Unsaved");
    await userEvent.click(backLink());
    const dialog = await screen.findByRole("region", { name: "Leave without saving?" });
    // Focus moves to the question, so it is announced.
    expect(document.activeElement).toBe(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay on this record" }));
    expect(router.state.location.pathname).toBe(PATH);
    expect(screen.getByLabelText<HTMLInputElement>(/^Shelf/).value).toBe("Unsaved");
    await userEvent.click(backLink());
    await userEvent.click(
      within(await screen.findByRole("region", { name: "Leave without saving?" })).getByRole(
        "button",
        {
          name: "Leave and discard my changes",
        },
      ),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_1}`);
    });
  });

  it("says when a record is missing or out of sight", async () => {
    server([404, { error: "not_found" }]);
    renderAt(PATH);
    expect(await screen.findByRole("heading", { level: 1, name: "Record not found" })).toBeTruthy();
  });

  it("answers an address that isn't a record ID without asking the server", async () => {
    const sent = server([200, recordReply()]);
    renderAt(`/sites/${SITE_1}/records/not-an-id`);
    expect(await screen.findByRole("heading", { level: 1, name: "Record not found" })).toBeTruthy();
    expect(sent.some((s) => s.path.includes("not-an-id"))).toBe(false);
  });

  it("starts a record of a kind with no record type on the kind's template", async () => {
    server([200, recordReply()], { "GET /api/record-types": [200, { recordTypes: [] }] });
    renderAt(`/sites/${SITE_1}/records/new`);
    await userEvent.click(await screen.findByRole("button", { name: /Kind of record/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Object" }));
    await userEvent.click(screen.getByRole("button", { name: "Start cataloging" }));
    expect(await screen.findByRole("heading", { level: 1, name: "New record" })).toBeTruthy();
    expect(screen.getByLabelText(/^Note \(required\)/)).toBeTruthy();
  });

  it("makes a new record in the working site and opens it", async () => {
    const NEW_ID = "33333333-3333-4333-8333-333333333333";
    const sent = server([200, recordReply()], {
      "POST /api/records": [201, { record: { id: NEW_ID }, version: 1 }],
      [`GET /api/records/${NEW_ID}`]: [
        200,
        recordReply({ record: { id: NEW_ID, title: "A new lantern" }, version: 1 }),
      ],
      [`GET /api/records/${NEW_ID}/versions?limit=100`]: [200, VERSIONS_REPLY],
    });
    const { router } = renderAt(`/sites/${SITE_1}/records/new`);
    expect(await screen.findByRole("heading", { level: 1, name: "Catalog an item" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Kind of record/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Object" }));
    await userEvent.click(screen.getByRole("button", { name: /Record type/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Lantern" }));
    await userEvent.click(screen.getByRole("button", { name: "Start cataloging" }));
    await userEvent.type(await screen.findByLabelText(/^Title/), "A new lantern");
    await userEvent.type(screen.getByLabelText(/^Note/), "Brass.");
    await userEvent.click(screen.getByRole("button", { name: "Save as a draft" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sites/${SITE_1}/records/${NEW_ID}`);
    });
    expect(await screen.findByText("Saved as a draft.")).toBeTruthy();
    const post = sent.find((s) => s.method === "POST" && s.path === "/api/records");
    expect(post?.headers["x-oculus-site"]).toBe(SITE_1);
    expect(post?.body).toEqual({
      record: {
        kind: "object",
        title: "A new lantern",
        templateKey: "t-object",
        recordTypeKey: "lantern",
        fields: { note: "Brass." },
      },
    });
  });
});
