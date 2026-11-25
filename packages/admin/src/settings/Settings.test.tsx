// @vitest-environment jsdom
// System settings (T-048a): only system managers see the link and the
// screens; sites are listed, added and renamed with the CSRF token; a
// change that needs a fresh sign-in says so; the sign-in rules are saved
// with the version they started from; templates are listed and edited with
// everything the screen doesn't show kept as it came, and changes the
// server asks to confirm are confirmed only when the person says so. All
// text from the server is shown as text.
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
  {
    siteId: SITE_2,
    organizationId: ORG_A,
    siteName: "Invented second site",
    organizationName: "Invented Archive",
  },
  {
    siteId: SITE_3,
    organizationId: ORG_B,
    siteName: "Invented library site",
    organizationName: "Invented Library",
  },
];

const admin = { ...me(SITES), systemAdmin: true };

const STANDARDS = [{ standard: "dcterms", element: "title" }];
const TEMPLATE = {
  key: "lantern",
  version: 3,
  template: {
    key: "lantern",
    organizationId: ORG_A,
    label: "Lanterns <b>bold</b>",
    appliesTo: ["object"],
    fields: [
      {
        key: "rights",
        label: "Rights",
        kind: "rights",
        required: false,
        repeatable: false,
        visibility: "public",
        inherited: false,
      },
      {
        key: "maker",
        label: "Maker",
        kind: "text",
        required: false,
        repeatable: false,
        visibility: "public",
        inherited: false,
        standards: STANDARDS,
      },
    ],
  },
};

function server(
  routes: Record<string, Reply | ((s: Sent) => Reply)> = {},
  person: unknown = admin,
) {
  return fakeServer({
    "GET /api/me": [200, person],
    "GET /api/templates": [200, { templates: [TEMPLATE] }],
    "GET /api/templates/lantern": [200, TEMPLATE],
    "GET /api/system-settings": [
      200,
      { settings: { sessionIdleMinutes: 240, sessionAbsoluteMinutes: 720 }, version: 0 },
    ],
    ...routes,
  });
}

describe("who sees System settings", () => {
  it("anyone but a system manager sees no link, and the screen says it is for system managers", async () => {
    const sent = server({}, me(SITES));
    renderAt("/settings/sites");
    expect(await screen.findByText(/Only system managers can see or change/)).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Oculus" });
    expect(within(nav).queryByRole("link", { name: "System settings" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(sent.filter((s) => s.path !== "/api/me")).toEqual([]);
  });

  it("a system manager has the link, and /settings opens Sites", async () => {
    server();
    const { router } = renderAt("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "System settings" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Oculus" });
    expect(within(nav).getByRole("link", { name: "System settings" })).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/sites");
    });
  });
});

describe("sites", () => {
  it("lists every site with its organization", async () => {
    server();
    renderAt("/settings/sites");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]?.textContent)).toEqual([
      "Invented Archive",
      "Invented Archive",
      "Invented Library",
    ]);
    expect(within(table).getByRole("cell", { name: "Invented library site" })).toBeTruthy();
  });

  it("adds a site to the chosen organization, with the CSRF token, and lists it", async () => {
    let added = false;
    const sent = server({
      "GET /api/me": () => [
        200,
        added
          ? {
              ...admin,
              sites: [
                ...SITES,
                {
                  siteId: "00000000-0000-4000-8000-000000000004",
                  organizationId: ORG_B,
                  siteName: "Invented reading room",
                  organizationName: "Invented Library",
                },
              ],
            }
          : admin,
      ],
      "POST /api/sites": () => {
        added = true;
        return [201, { site: { id: "x", organizationId: ORG_B, name: "Invented reading room" } }];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/sites");
    await user.type(
      await screen.findByRole("textbox", { name: /Site name/ }),
      "Invented reading room",
    );
    await user.click(screen.getByRole("radio", { name: "Invented Library" }));
    await user.click(screen.getByRole("button", { name: "Add site" }));
    expect(await screen.findByText(/Added the site “Invented reading room”/)).toBeTruthy();
    const post = sent.find((s) => s.method === "POST" && s.path === "/api/sites");
    expect(post?.body).toEqual({ organizationId: ORG_B, name: "Invented reading room" });
    expect(post?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
    expect(await screen.findByRole("cell", { name: "Invented reading room" })).toBeTruthy();
  });

  it("renames a site", async () => {
    const sent = server({
      [`PUT /api/sites/${SITE_2}`]: [
        200,
        { site: { id: SITE_2, organizationId: ORG_A, name: "Invented annex" } },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/sites");
    await screen.findByRole("table");
    console.log(
      screen
        .getAllByRole("button")
        .map((b) => JSON.stringify(b.textContent))
        .join("|"),
    );
    await user.click(await screen.findByRole("button", { name: "Rename Invented second site" }));
    const box = screen.getByRole("textbox", { name: /New name for Invented second site/ });
    await user.clear(box);
    await user.type(box, "Invented annex");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Renamed.")).toBeTruthy();
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.path).toBe(`/api/sites/${SITE_2}`);
    expect(put?.body).toEqual({ organizationId: ORG_A, name: "Invented annex" });
  });

  it("says when a change needs a fresh sign-in, and the server's own problems", async () => {
    let calls = 0;
    server({
      "POST /api/sites": () => {
        calls += 1;
        return calls === 1
          ? [403, { error: "reauthentication_required" }]
          : [
              422,
              {
                error: "invalid",
                issues: [{ path: ["name"], code: "required", message: "Every site needs a name." }],
              },
            ];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/sites");
    await user.type(await screen.findByRole("textbox", { name: /Site name/ }), "Invented");
    await user.click(screen.getByRole("button", { name: "Add site" }));
    expect(await screen.findByText(/this needs a fresh sign-in/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add site" }));
    expect(await screen.findByText("Every site needs a name.")).toBeTruthy();
  });
});

describe("sign-in rules", () => {
  it("saves a first change with If-None-Match, then the next with If-Match", async () => {
    let version = 0;
    const sent = server({
      "GET /api/system-settings": () => [
        200,
        {
          settings: { sessionIdleMinutes: version === 0 ? 240 : 60, sessionAbsoluteMinutes: 720 },
          version,
        },
      ],
      "PUT /api/system-settings": (s) => {
        version += 1;
        return [200, { settings: (s.body as { settings: unknown }).settings, version }];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/sign-in");
    const idle = await screen.findByRole("textbox", { name: /minutes unused/ });
    expect((idle as HTMLInputElement).value).toBe("240");
    await user.clear(idle);
    await user.type(idle, "60");
    await user.click(screen.getByRole("button", { name: "Save sign-in rules" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const first = sent.find((s) => s.method === "PUT");
    expect(first?.headers["if-none-match"]).toBe("*");
    expect(first?.headers["if-match"]).toBeUndefined();
    expect(first?.body).toEqual({
      settings: { sessionIdleMinutes: 60, sessionAbsoluteMinutes: 720 },
    });

    await user.click(screen.getByRole("button", { name: "Save sign-in rules" }));
    await waitFor(() => {
      expect(sent.filter((s) => s.method === "PUT").length).toBe(2);
    });
    expect(sent.filter((s) => s.method === "PUT")[1]?.headers["if-match"]).toBe('"v1"');
  });

  it("an edit made on an old copy says so and offers the latest", async () => {
    server({ "PUT /api/system-settings": [412, { error: "version_conflict", issues: [] }] });
    const user = userEvent.setup();
    renderAt("/settings/sign-in");
    await user.click(await screen.findByRole("button", { name: "Save sign-in rules" }));
    expect(await screen.findByText(/Someone else changed these rules/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load their version" })).toBeTruthy();
  });
});

describe("templates", () => {
  it("lists the organization's templates, labels as text, each linking to its editor", async () => {
    server();
    const { container } = renderAt("/settings/templates");
    const link = await screen.findByRole("link", { name: "Lanterns <b>bold</b>" });
    expect(link.getAttribute("href")).toBe("/settings/templates/lantern");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("heading", { name: "Templates of Invented Archive" })).toBeTruthy();
  });

  it("saves an edit with If-Match, keeping what the screen doesn't show", async () => {
    const sent = server({
      "PUT /api/templates/lantern": (s) => [
        200,
        {
          key: "lantern",
          version: 4,
          template: { key: "lantern", ...(s.body as { template: object }).template },
          publishedRecords: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern");
    const maker = await screen.findByRole("region", { name: "Maker" });
    const label = within(maker).getByRole("textbox", { name: /^Label/ });
    await user.clear(label);
    await user.type(label, "Maker or workshop");
    await user.click(screen.getByRole("button", { name: "+ Add a field" }));
    const added = screen.getByRole("region", { name: "Field 3" });
    await user.type(within(added).getByRole("textbox", { name: /^Key/ }), "colour");
    await user.type(within(added).getByRole("textbox", { name: /^Label/ }), "Colour");
    await user.click(screen.getByRole("button", { name: "Save template" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();

    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"v3"');
    const body = put?.body as { template: Record<string, unknown> };
    expect(body.template.organizationId).toBe(ORG_A);
    expect(body.template.key).toBeUndefined();
    const fields = body.template.fields as Record<string, unknown>[];
    expect(fields[1]).toEqual({
      ...TEMPLATE.template.fields[1],
      label: "Maker or workshop",
    });
    // A new field is staff only unless someone says otherwise.
    expect(fields[2]).toEqual({
      key: "colour",
      label: "Colour",
      kind: "text",
      required: false,
      repeatable: false,
      visibility: "staff",
      inherited: false,
    });
  });

  it("existing field keys can't be changed", async () => {
    server();
    renderAt("/settings/templates/lantern");
    const maker = await screen.findByRole("region", { name: "Maker" });
    expect(within(maker).getByRole("textbox", { name: /^Key/ }).hasAttribute("readonly")).toBe(
      true,
    );
  });

  it("asks before changes the server wants confirmed, then sends exactly those back", async () => {
    let calls = 0;
    const sent = server({
      "PUT /api/templates/lantern": () => {
        calls += 1;
        if (calls === 1) {
          return [
            409,
            {
              error: "confirmation_required",
              issues: [
                {
                  path: ["confirm", "field_removed", "maker"],
                  code: "needs_confirmation",
                  message: "2 records have a value in Maker, which this removes.",
                },
              ],
            },
          ];
        }
        if (calls === 2) {
          return [
            409,
            {
              error: "confirmation_required",
              issues: [
                { path: ["confirmPublished"], code: "publishes_records", message: "x" },
                {
                  path: ["publishedRecords", "r1"],
                  code: "published_record_affected",
                  message: "x",
                },
                {
                  path: ["publishedRecords", "r2"],
                  code: "published_record_affected",
                  message: "x",
                },
              ],
            },
          ];
        }
        return [200, { ...TEMPLATE, version: 4, publishedRecords: [] }];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern");
    const maker = await screen.findByRole("region", { name: "Maker" });
    await user.click(within(maker).getByRole("button", { name: "Remove Maker" }));
    await user.click(screen.getByRole("button", { name: "Save template" }));
    expect(
      await screen.findByText("2 records have a value in Maker, which this removes."),
    ).toBeTruthy();
    expect(sent.filter((s) => s.method === "PUT").length).toBe(1);
    await user.click(screen.getByRole("button", { name: "Save with these changes" }));
    expect(await screen.findByText(/shows values at once on 2 published records/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save with these changes" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const puts = sent
      .filter((s) => s.method === "PUT")
      .map((s) => s.body as Record<string, unknown>);
    expect(puts[0]?.confirm).toBeUndefined();
    expect(puts[1]?.confirm).toEqual([{ code: "field_removed", key: "maker" }]);
    expect(puts[1]?.confirmPublished).toBeUndefined();
    expect(puts[2]?.confirm).toEqual([{ code: "field_removed", key: "maker" }]);
    expect(puts[2]?.confirmPublished).toBe(true);
  });

  it("cancelling a confirmation sends nothing more", async () => {
    const sent = server({
      "PUT /api/templates/lantern": [
        409,
        {
          error: "confirmation_required",
          issues: [
            {
              path: ["confirm", "field_removed", "maker"],
              code: "needs_confirmation",
              message: "Records use Maker.",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern");
    await user.click(await screen.findByRole("button", { name: "Save template" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Records use Maker.")).toBeNull();
    expect(sent.filter((s) => s.method === "PUT").length).toBe(1);
  });

  it("shows the server's problems, naming the field each is about", async () => {
    server({
      "PUT /api/templates/lantern": [
        422,
        {
          error: "invalid",
          issues: [
            {
              path: ["fields", 1, "label"],
              code: "required",
              message: "Every field needs a label.",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern");
    await user.click(await screen.findByRole("button", { name: "Save template" }));
    expect(await screen.findByText("Maker: Every field needs a label.")).toBeTruthy();
  });

  it("an edit made on an old copy says so", async () => {
    server({ "PUT /api/templates/lantern": [412, { error: "version_conflict", issues: [] }] });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern");
    await user.click(await screen.findByRole("button", { name: "Save template" }));
    expect(await screen.findByText(/Someone else saved this template/)).toBeTruthy();
  });

  it("a new template needs a valid key and is created with If-None-Match", async () => {
    const sent = server({
      "PUT /api/templates/kettle": [
        201,
        {
          key: "kettle",
          version: 1,
          template: { ...TEMPLATE.template, key: "kettle" },
          publishedRecords: [],
        },
      ],
      "GET /api/templates/kettle": [200, { ...TEMPLATE, key: "kettle", version: 1 }],
    });
    const user = userEvent.setup();
    const { router } = renderAt("/settings/new-template");
    const key = await screen.findByRole("textbox", { name: /^Key/ });
    await user.type(key, "Bad Key");
    expect(await screen.findByText(/Use 1 to 64 lower case letters/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create template" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.clear(key);
    await user.type(key, "kettle");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Kettles");
    await user.click(screen.getByRole("checkbox", { name: "Object" }));
    await user.click(screen.getByRole("button", { name: "Create template" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/templates/kettle");
    });
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.path).toBe("/api/templates/kettle");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.body).toEqual({
      template: { organizationId: ORG_A, label: "Kettles", appliesTo: ["object"], fields: [] },
    });
  });

  it("an address that isn't a template key is answered without asking the server", async () => {
    const sent = server();
    renderAt("/settings/templates/..%2Fsessions");
    expect(await screen.findByText(/There is no template with that key/)).toBeTruthy();
    expect(sent.some((s) => s.path.startsWith("/api/templates/"))).toBe(false);
  });
});
