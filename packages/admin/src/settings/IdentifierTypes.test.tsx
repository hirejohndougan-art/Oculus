// @vitest-environment jsdom
// Settings › ID numbers (T-047a): the organization's identifier types are
// listed with labels as text; an edit is sent with the tag it started from
// (If-Match: "t-<tag>"), keeping what the screen doesn't show; a new type
// needs a valid key and goes with If-None-Match; changes the server asks to
// confirm (changes records use, published records, published records a new
// format takes off public sites) are confirmed only when the person says
// so, with exactly what the server listed; an edit on an old copy says so.
import { cleanup, screen, waitFor } from "@testing-library/react";
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
import {
  mergedConfirmation,
  numberingText,
  typeConfirmationOf,
  typeDraft,
  typeFromDraft,
} from "./identifierTypeForm";

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

const TAG = "a".repeat(32);
const ACCESSION = {
  type: {
    organizationId: ORG_A,
    key: "accession_number",
    label: "Accession <b>number</b>",
    pattern: "####.###",
    uniqueness: "all_time",
    autoNumber: { style: "year", separator: ".", digits: 3 },
    public: true,
    futureSetting: { kept: true },
  },
  tag: TAG,
};
const BOX = {
  type: { organizationId: ORG_A, key: "box", label: "Box label", uniqueness: "none" },
  tag: "b".repeat(32),
};

type Handler = (request: Sent) => Reply;

function server(extra: Record<string, Reply | Handler> = {}): Sent[] {
  return fakeServer({
    "GET /api/me": [200, admin],
    "GET /api/identifier-types": [200, { identifierTypes: [ACCESSION, BOX] }],
    ...extra,
  });
}

describe("the form model", () => {
  it("keeps what the screen doesn't edit, and drops numbering and public when switched off", () => {
    const draft = typeDraft(ACCESSION.type);
    expect(typeFromDraft(draft)).toEqual({
      organizationId: ORG_A,
      futureSetting: { kept: true },
      label: "Accession <b>number</b>",
      pattern: "####.###",
      uniqueness: "all_time",
      autoNumber: { style: "year", separator: ".", digits: 3 },
      public: true,
    });
    const off = typeFromDraft({ ...draft, numbering: "none", isPublic: false, pattern: " " });
    expect(off).toEqual({
      organizationId: ORG_A,
      futureSetting: { kept: true },
      label: "Accession <b>number</b>",
      uniqueness: "all_time",
    });
    expect(typeFromDraft({ ...draft, numbering: "prefix", prefix: "DHS-", digits: "4" })).toEqual(
      expect.objectContaining({ autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 } }),
    );
    // Not a whole number: sent as typed, so the server's check names the problem.
    expect(typeFromDraft({ ...draft, digits: "four" }).autoNumber).toEqual({
      style: "year",
      separator: ".",
      digits: "four",
    });
  });

  it("reads confirmations, published records and dropped records, and merges them one at a time", () => {
    const first = typeConfirmationOf([
      { path: ["confirm", "format_changed", "box"], code: "needs_confirmation", message: "m" },
      { path: ["droppedFromPublic", "r1"], code: "published_record_dropped", message: "x" },
      { path: ["droppedFromPublic", "r2"], code: "published_record_dropped", message: "x" },
      { path: ["droppedFromPublic", "r2"], code: "published_record_dropped", message: "x" },
    ]);
    expect(first).toEqual({
      confirm: [{ code: "format_changed", key: "box" }],
      messages: ["m"],
      publishedRecords: 0,
      dropped: ["r1", "r2"],
    });
    const second = typeConfirmationOf([
      { path: ["confirmPublished"], code: "publishes_records", message: "x" },
      { path: ["publishedRecords", "r3"], code: "published_record_affected", message: "x" },
    ]);
    expect(mergedConfirmation(first, second)).toEqual({
      confirm: [{ code: "format_changed", key: "box" }],
      messages: ["m"],
      publishedRecords: 1,
      dropped: ["r1", "r2"],
    });
    expect(numberingText(ACCESSION.type)).toBe("Year.000");
    expect(numberingText(BOX.type)).toBe("Typed in");
  });
});

describe("Settings › ID numbers", () => {
  it("has a tab, and lists the types with labels as text, each linking to its editor", async () => {
    server();
    const { container } = renderAt("/settings/identifier-types");
    expect(await screen.findByRole("link", { name: "ID numbers" })).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Accession <b>number</b>" });
    expect(link.getAttribute("href")).toBe("/settings/identifier-types/accession_number");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Staff only")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "ID number types of Invented Archive" }),
    ).toBeTruthy();
  });

  it("saves an edit with the tag it started from, keeping what the screen doesn't show", async () => {
    const sent = server({
      "PUT /api/identifier-types/accession_number": (s) => [
        200,
        {
          type: {
            key: "accession_number",
            ...(s.body as { identifierType: object }).identifierType,
          },
          tag: "c".repeat(32),
          publishedRecords: [],
          droppedFromPublic: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/identifier-types/accession_number");
    const name = await screen.findByRole("textbox", { name: /^Name/ });
    await user.clear(name);
    await user.type(name, "Accession number");
    await user.click(screen.getByRole("button", { name: "Save ID number type" }));
    await waitFor(() => {
      expect(sent.some((s) => s.method === "PUT")).toBe(true);
    });
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe(`"t-${TAG}"`);
    expect(put?.headers["if-none-match"]).toBeUndefined();
    const body = put?.body as { identifierType: Record<string, unknown> };
    expect(body.identifierType).toEqual({
      ...ACCESSION.type,
      key: undefined,
      label: "Accession number",
    });
    expect(body.identifierType.key).toBeUndefined();
    expect(Object.keys(body)).toEqual(["identifierType"]);
  });

  it("asks before changes the server wants confirmed, then sends exactly those back", async () => {
    let calls = 0;
    const sent = server({
      "PUT /api/identifier-types/box": () => {
        calls += 1;
        if (calls === 1) {
          return [
            409,
            {
              error: "confirmation_required",
              issues: [
                {
                  path: ["confirm", "format_changed", "box"],
                  code: "needs_confirmation",
                  message: "2 records hold numbers of Box label that don't fit the new format.",
                },
                {
                  path: ["droppedFromPublic", "r1"],
                  code: "published_record_dropped",
                  message: "x",
                },
              ],
            },
          ];
        }
        return [200, { ...BOX, tag: "d".repeat(32), droppedFromPublic: ["r1"] }];
      },
    });
    const user = userEvent.setup();
    renderAt("/settings/identifier-types/box");
    await user.type(await screen.findByRole("textbox", { name: /^Format/ }), "B-###");
    await user.click(screen.getByRole("button", { name: "Save ID number type" }));
    expect(
      await screen.findByText("2 records hold numbers of Box label that don't fit the new format."),
    ).toBeTruthy();
    expect(screen.getByText(/1 published record's number doesn't fit the new format/)).toBeTruthy();
    expect(sent.filter((s) => s.method === "PUT").length).toBe(1);
    await user.click(screen.getByRole("button", { name: "Save with these changes" }));
    await waitFor(() => {
      expect(sent.filter((s) => s.method === "PUT").length).toBe(2);
    });
    const puts = sent
      .filter((s) => s.method === "PUT")
      .map((s) => s.body as Record<string, unknown>);
    expect(puts[0]?.confirm).toBeUndefined();
    expect(puts[1]?.confirm).toEqual([{ code: "format_changed", key: "box" }]);
    expect(puts[1]?.confirmDropped).toEqual(["r1"]);
    expect(puts[1]?.confirmPublished).toBeUndefined();
  });

  it("cancelling a confirmation sends nothing more", async () => {
    const sent = server({
      "PUT /api/identifier-types/box": [
        409,
        {
          error: "confirmation_required",
          issues: [
            {
              path: ["confirm", "made_public", "box"],
              code: "needs_confirmation",
              message: "Numbers of Box label would be shown on public sites.",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderAt("/settings/identifier-types/box");
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Numbers of this type may be shown on public sites",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save ID number type" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Numbers of Box label would be shown on public sites.")).toBeNull();
    expect(sent.filter((s) => s.method === "PUT").length).toBe(1);
    expect(
      (sent.find((s) => s.method === "PUT")?.body as { identifierType: { public?: boolean } })
        .identifierType.public,
    ).toBe(true);
  });

  it("an edit made on an old copy says so", async () => {
    server({
      "PUT /api/identifier-types/box": [412, { error: "version_conflict" }],
    });
    const user = userEvent.setup();
    renderAt("/settings/identifier-types/box");
    await user.type(await screen.findByRole("textbox", { name: /^Name/ }), "s");
    await user.click(screen.getByRole("button", { name: "Save ID number type" }));
    expect(await screen.findByText(/Someone else changed this ID number type/)).toBeTruthy();
  });

  it("shows the server's problems as text", async () => {
    server({
      "PUT /api/identifier-types/box": [
        422,
        {
          error: "invalid",
          issues: [{ path: ["pattern"], code: "invalid_repeat", message: "A repeat <i>x</i>." }],
        },
      ],
    });
    const user = userEvent.setup();
    const { container } = renderAt("/settings/identifier-types/box");
    await user.type(await screen.findByRole("textbox", { name: /^Format/ }), "#{999}");
    await user.click(screen.getByRole("button", { name: "Save ID number type" }));
    expect(await screen.findByText("A repeat <i>x</i>.")).toBeTruthy();
    expect(container.querySelector("i")).toBeNull();
  });

  it("a new type needs a valid key and is created with If-None-Match", async () => {
    const sent = server({
      "PUT /api/identifier-types/object_number": (s) => [
        201,
        {
          type: { key: "object_number", ...(s.body as { identifierType: object }).identifierType },
          tag: "e".repeat(32),
          publishedRecords: [],
        },
      ],
    });
    const user = userEvent.setup();
    const { router } = renderAt("/settings/new-identifier-type");
    const key = await screen.findByRole("textbox", { name: /^Key/ });
    await user.type(key, "Object number");
    expect(screen.getByText(/Use 1 to 64 lower case letters/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create ID number type" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.clear(key);
    await user.type(key, "object_number");
    await user.type(screen.getByRole("textbox", { name: /^Name/ }), "Object number");
    await user.click(screen.getByRole("button", { name: "Create ID number type" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/identifier-types/object_number");
    });
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.headers["if-match"]).toBeUndefined();
    // Staff only and never reused unless someone chooses otherwise.
    expect((put?.body as { identifierType: unknown }).identifierType).toEqual({
      organizationId: ORG_A,
      label: "Object number",
      uniqueness: "all_time",
    });
  });

  it("an address that isn't a type key, or a key that isn't there, asks nothing more", async () => {
    const sent = server();
    renderAt("/settings/identifier-types/Not%20a%20key");
    expect(await screen.findByText(/There is no ID number type with that key/)).toBeTruthy();
    expect(sent.some((s) => s.path === "/api/identifier-types")).toBe(false);
    cleanup();
    server();
    renderAt("/settings/identifier-types/missing");
    expect(await screen.findByText(/There is no ID number type with that key/)).toBeTruthy();
  });
});
