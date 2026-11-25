// @vitest-environment jsdom
// Settings › Templates › Dublin Core (T-050e): a template with no mapping
// says its records aren't shown and offers a start from the fields'
// standards (public fields only); a mapping is saved with If-None-Match the
// first time and If-Match after; a change that shows on published records
// is sent with confirmPublished only once the person confirms; the
// server's problems name the row; a stored entry for a staff-only field is
// shown as such. The term list is core's. All text from the server is
// shown as text.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUBLIN_CORE_TERMS } from "@oculus/core";
import {
  ORG_A,
  SITE_1,
  fakeServer,
  me,
  renderAt,
  type Reply,
  type Sent,
} from "../testing.fixtures";
import { DUBLIN_CORE_TERM_LABELS, suggestedEntries, mappableFields } from "./DublinCoreEditor";

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

const field = (key: string, label: string, visibility: string, extra: object = {}) => ({
  key,
  label,
  kind: key === "rights" ? "rights" : "text",
  required: false,
  repeatable: false,
  visibility,
  inherited: false,
  ...extra,
});

const TEMPLATE = {
  key: "lantern",
  version: 3,
  template: {
    key: "lantern",
    organizationId: ORG_A,
    label: "Lanterns <b>bold</b>",
    appliesTo: ["object"],
    fields: [
      field("rights", "Rights", "public"),
      field("maker", "Maker", "public", {
        standards: [{ standard: "dcterms", element: "creator" }],
      }),
      field("shelf", "Shelf", "staff", {
        standards: [{ standard: "dcterms", element: "spatial" }],
      }),
    ],
  },
};

const NO_MAPPING = { key: "lantern", version: 0, mapping: null };
const MAPPING = {
  key: "lantern",
  version: 2,
  mapping: {
    template: "lantern",
    organizationId: ORG_A,
    entries: [
      { field: "rights", term: "rights" },
      { field: "maker", term: "creator" },
    ],
  },
};

function server(routes: Record<string, Reply | ((s: Sent) => Reply)> = {}) {
  return fakeServer({
    "GET /api/me": [200, admin],
    "GET /api/templates": [200, { templates: [TEMPLATE] }],
    "GET /api/templates/lantern": [200, TEMPLATE],
    "GET /api/templates/lantern/dublin-core": [200, MAPPING],
    ...routes,
  });
}

const saved = (s: Sent): Reply => [
  200,
  {
    key: "lantern",
    version: 3,
    mapping: {
      template: "lantern",
      organizationId: ORG_A,
      ...(s.body as { mapping: object }).mapping,
    },
    publishedRecords: [],
  },
];

describe("the Dublin Core screen", () => {
  it("is linked from the template", async () => {
    server();
    renderAt("/settings/templates/lantern");
    const link = await screen.findByRole("link", { name: "Dublin Core mapping" });
    expect(link.getAttribute("href")).toBe("/settings/templates/lantern/dublin-core");
  });

  it("says a template with no mapping isn't shown, and fills in public fields from their standards", async () => {
    const sent = server({
      "GET /api/templates/lantern/dublin-core": [200, NO_MAPPING],
      "PUT /api/templates/lantern/dublin-core": saved,
    });
    const user = userEvent.setup();
    const { container } = renderAt("/settings/templates/lantern/dublin-core");
    expect(await screen.findByText(/has no Dublin Core mapping yet/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Dublin Core for Lanterns <b>bold</b>" }),
    ).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Fill in from the fields' standards" }));
    const rows = within(screen.getByRole("list", { name: "Mapped fields" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.headers["if-match"]).toBeUndefined();
    // The staff-only Shelf is never suggested, though its standards name a term.
    expect(put?.body).toEqual({
      mapping: {
        entries: [
          { field: "rights", term: "rights" },
          { field: "maker", term: "creator" },
        ],
      },
    });
  });

  it("saves a change with If-Match and no confirmation unless asked", async () => {
    const sent = server({ "PUT /api/templates/lantern/dublin-core": saved });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern/dublin-core");
    expect(await screen.findByText("Version 2")).toBeTruthy();
    expect(screen.queryByText(/has no Dublin Core mapping yet/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove row 2" }));
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"v2"');
    expect(put?.body).toEqual({ mapping: { entries: [{ field: "rights", term: "rights" }] } });
  });

  it("sends confirmPublished only after the person confirms", async () => {
    let calls = 0;
    const sent = server({
      "PUT /api/templates/lantern/dublin-core": (s) => {
        calls += 1;
        if (calls === 1) {
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
        const [status, body] = saved(s);
        return [status, { ...(body as object), publishedRecords: ["r1", "r2"] }];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern/dublin-core");
    await user.click(await screen.findByRole("button", { name: "Remove row 2" }));
    await user.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(await screen.findByText(/shows at once on 2 published records/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save and update the public sites" }));
    expect(await screen.findByText(/show it now on 2 published records/)).toBeTruthy();
    const puts = sent.filter((s) => s.method === "PUT").map((s) => s.body as object);
    expect(puts).toHaveLength(2);
    expect(puts[0]).not.toHaveProperty("confirmPublished");
    expect(puts[1]).toHaveProperty("confirmPublished", true);
  });

  it("cancelling the confirmation sends nothing more", async () => {
    const sent = server({
      "PUT /api/templates/lantern/dublin-core": [
        409,
        {
          error: "confirmation_required",
          issues: [{ path: ["confirmPublished"], code: "publishes_records", message: "x" }],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern/dublin-core");
    await user.click(await screen.findByRole("button", { name: "Save mapping" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(1);
  });

  it("names the row of each problem the server finds", async () => {
    server({
      "PUT /api/templates/lantern/dublin-core": [
        422,
        {
          error: "invalid",
          issues: [
            {
              path: ["entries", 1, "field"],
              code: "staff_field",
              message: "That field is staff only.",
            },
            {
              path: ["entries"],
              code: "rights_not_mapped",
              message: "Map the rights <i>first</i>.",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    const { container } = renderAt("/settings/templates/lantern/dublin-core");
    await user.click(await screen.findByRole("button", { name: "Save mapping" }));
    expect(await screen.findByText("Row 2 (Maker): That field is staff only.")).toBeTruthy();
    expect(screen.getByText("Map the rights <i>first</i>.")).toBeTruthy();
    expect(container.querySelector("i")).toBeNull();
  });

  it("offers to load the latest version when someone else saved meanwhile", async () => {
    server({
      "PUT /api/templates/lantern/dublin-core": [412, { error: "version_conflict", issues: [] }],
    });
    const user = userEvent.setup();
    renderAt("/settings/templates/lantern/dublin-core");
    await user.click(await screen.findByRole("button", { name: "Save mapping" }));
    expect(await screen.findByText(/Someone else saved this mapping/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load the latest version" })).toBeTruthy();
  });

  it("shows a stored entry for a staff-only field as such", async () => {
    server({
      "GET /api/templates/lantern/dublin-core": [
        200,
        {
          ...MAPPING,
          mapping: { ...MAPPING.mapping, entries: [{ field: "shelf", term: "spatial" }] },
        },
      ],
    });
    renderAt("/settings/templates/lantern/dublin-core");
    const rows = await screen.findByRole("list", { name: "Mapped fields" });
    await waitFor(() => {
      expect(within(rows).getAllByText(/Shelf \(shelf\): staff only/).length).toBeGreaterThan(0);
    });
  });

  it("asks nothing for a key that isn't a template key", async () => {
    const sent = server();
    renderAt("/settings/templates/..%2Fsessions/dublin-core");
    expect(await screen.findByText(/There is no template with that key/)).toBeTruthy();
    expect(sent.some((s) => s.path.includes("dublin-core"))).toBe(false);
  });
});

describe("the mapping helpers", () => {
  it("offer exactly core's DCMI terms, in the same order", () => {
    expect(DUBLIN_CORE_TERM_LABELS.map(([t]) => t)).toEqual([...DUBLIN_CORE_TERMS]);
  });

  it("never suggest staff-only fields, and suggest rights for a rights field", () => {
    const fields = mappableFields(TEMPLATE.template);
    expect(suggestedEntries(fields).map((e) => [e.field, e.term])).toEqual([
      ["rights", "rights"],
      ["maker", "creator"],
    ]);
    expect(mappableFields({ fields: [null, 1, { label: "no key" }] })).toEqual([]);
  });
});
