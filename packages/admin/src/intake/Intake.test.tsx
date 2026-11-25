// @vitest-environment jsdom
// The intake screens (T-073): the sidebar shows Intake only when the server
// answers the register; the register lists and filters accessions with
// names as text; logging one sends only the accession's own fields (never
// an ID or organization) and offers to withdraw the published records it
// now holds back, from the version read; deeds are marked sent or signed
// from the version listed; a donor's first contact is saved with
// If-None-Match and forgotten only after confirming. Every name is invented.
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
const ACC_1 = "00000000-0000-4000-8000-0000000000c1";
const ACC_2 = "00000000-0000-4000-8000-0000000000c2";
const AGENT = "00000000-0000-4000-8000-0000000000d1";
const LANTERN = "00000000-0000-4000-8000-0000000000e1";

function accession(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: ORG_A,
    number: { type: "accession_number", value: id === ACC_1 ? "2026.014" : "2026.013" },
    sourceAgent: { recordId: AGENT, label: "<b>Invented</b> family" },
    receivedOn: "2026-11-02",
    method: "gift",
    materials: "Invented: interview recordings and release forms",
    deedStatus: "missing",
    records: [],
    ...extra,
  };
}

const view = (a: ReturnType<typeof accession>, version = 1) => ({
  accession: a,
  version,
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
});

const REGISTER = {
  accessions: [
    view(accession(ACC_1)),
    view(
      accession(ACC_2, {
        deedStatus: "signed",
        accessRestriction: { kind: "staff_and_researchers" },
        records: [{ recordId: LANTERN, label: "Lantern" }],
      }),
      3,
    ),
  ],
  next: null,
};

function server(more: Record<string, Reply | ((s: Sent) => Reply)> = {}): Sent[] {
  return fakeServer({
    "GET /api/me": [200, me([A1])],
    "GET /api/accessions": [200, REGISTER],
    "GET /api/identifier-types": [403, { error: "not_permitted" }],
    ...more,
  });
}

describe("the Intake links", () => {
  it("show when the server answers the register, and not when it refuses", async () => {
    server();
    renderAt("/");
    const nav = await screen.findByRole("list", { name: "Intake" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/intake/accessions", "/intake/deeds", "/intake/donors"]);
    cleanup();
    server({ "GET /api/accessions": [403, { error: "not_permitted" }] });
    renderAt("/");
    await screen.findByText("Invented Archive");
    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Intake" })).toBeNull();
    });
  });
});

describe("the accession register", () => {
  it("lists accessions with names as text, and filters them", async () => {
    server();
    renderAt("/intake/accessions");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("<b>Invented</b> family")).toHaveLength(2);
    expect(document.querySelector("td b")).toBeNull();
    expect(within(table).getByRole("link", { name: "2026.014" }).getAttribute("href")).toBe(
      `/intake/accessions/${ACC_1}`,
    );
    await userEvent.click(screen.getByRole("button", { name: "Restricted" }));
    expect(within(screen.getByRole("table")).queryByText("2026.014")).toBeNull();
    expect(within(screen.getByRole("table")).getByText("2026.013")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Deed not signed" }));
    expect(within(screen.getByRole("table")).getByText("2026.014")).toBeTruthy();
  });

  it("tells someone without the Donor relations role why there is nothing", async () => {
    server({ "GET /api/accessions": [403, { error: "not_permitted" }] });
    renderAt("/intake/accessions");
    expect(await screen.findByText(/for people with the Donor relations role/)).toBeTruthy();
  });
});

describe("logging an accession", () => {
  it("sends only its own fields and offers to withdraw what it now holds back", async () => {
    const saved = accession(ACC_1, { records: [{ recordId: LANTERN, label: "Lantern" }] });
    const sent = server({
      "POST /api/accessions": [201, { ...view(saved), nowHeld: [LANTERN] }],
      [`GET /api/accessions/${ACC_1}`]: [200, view(saved)],
      [`GET /api/records/${LANTERN}`]: [
        200,
        {
          record: { id: LANTERN, organizationId: ORG_A, kind: "object", title: "Lantern" },
          version: 4,
          state: "published",
          can: { edit: true, history: true, publish: true, delete: false },
          inherited: [],
        },
      ],
      [`POST /api/records/${LANTERN}/withdraw`]: [200, { version: 5 }],
    });
    const user = userEvent.setup();
    renderAt("/intake/accessions/new");
    const donor = await screen.findByRole("group", { name: "Pick the donor" });
    await user.type(within(donor).getByLabelText("Or the record's ID"), AGENT);
    await user.type(within(donor).getByLabelText("And a label for it"), "Invented family");
    await user.click(within(donor).getByRole("button", { name: "Use this ID" }));
    expect(screen.getByText("Invented family")).toBeTruthy();
    await user.type(screen.getByLabelText("Received on"), "2026-11-02");
    await user.type(
      screen.getByLabelText("The materials, described as a whole"),
      "Invented: two boxes",
    );
    await user.click(screen.getByRole("button", { name: "Add a record" }));
    const add = screen.getByRole("group", { name: "Add a record" });
    await user.type(within(add).getByLabelText("Or the record's ID"), LANTERN);
    await user.type(within(add).getByLabelText("And a label for it"), "Lantern");
    await user.click(within(add).getByRole("button", { name: "Use this ID" }));
    await user.click(screen.getByRole("radio", { name: "Closed until a date" }));
    await user.type(screen.getByLabelText("Closed until"), "2030-01-01");
    await user.type(screen.getByLabelText("Number"), "2026.014");
    await user.click(screen.getByRole("button", { name: "Save the accession" }));

    const post = await waitFor(() => {
      const found = sent.find((s) => s.method === "POST" && s.path === "/api/accessions");
      expect(found).toBeDefined();
      return found;
    });
    expect(post?.body).toEqual({
      accession: {
        number: { type: "accession_number", value: "2026.014" },
        sourceAgent: { recordId: AGENT, label: "Invented family" },
        receivedOn: "2026-11-02",
        method: "gift",
        materials: "Invented: two boxes",
        deedStatus: "missing",
        records: [{ recordId: LANTERN, label: "Lantern" }],
        accessRestriction: { kind: "closed_until", until: "2030-01-01" },
      },
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    const held = await screen.findByRole("region", { name: "Published records now held back" });
    await user.click(await within(held).findByRole("button", { name: "Withdraw Lantern" }));
    const withdraw = await waitFor(() => {
      const found = sent.find((s) => s.path === `/api/records/${LANTERN}/withdraw`);
      expect(found).toBeDefined();
      return found;
    });
    expect(withdraw?.headers["if-match"]).toBe('"v4"');
    expect(withdraw?.body).toEqual({
      reason: "Held back by an accession (its deed or a restriction)",
    });
  });

  it("edits from the version read, and says so when someone else saved first", async () => {
    const sent = server({
      [`GET /api/accessions/${ACC_2}`]: [200, REGISTER.accessions[1]],
      [`PUT /api/accessions/${ACC_2}`]: [
        412,
        { error: "version_conflict", issues: [{ path: [], code: "version_conflict" }] },
      ],
    });
    const user = userEvent.setup();
    renderAt(`/intake/accessions/${ACC_2}`);
    const note = await screen.findByLabelText("Staff note");
    await user.type(note, "Invented note");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Someone else saved this accession/)).toBeTruthy();
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"v3"');
    expect(put?.body).toMatchObject({
      accession: { note: "Invented note", accessRestriction: { kind: "staff_and_researchers" } },
    });
    expect(Object.keys((put?.body as { accession: object }).accession)).not.toContain("id");
  });
});

describe("editing an accession", () => {
  it("says Saved after a successful edit and offers what it now holds back", async () => {
    let version = 3;
    const current = () =>
      view(
        accession(ACC_2, {
          deedStatus: version === 3 ? "signed" : "sent",
          records: [{ recordId: LANTERN, label: "Lantern" }],
        }),
        version,
      );
    server({
      [`GET /api/accessions/${ACC_2}`]: () => [200, current()],
      [`PUT /api/accessions/${ACC_2}`]: () => {
        version = 4;
        return [200, { ...current(), nowHeld: [LANTERN] }];
      },
      [`GET /api/records/${LANTERN}`]: [404, { error: "not_found" }],
    });
    const user = userEvent.setup();
    renderAt(`/intake/accessions/${ACC_2}`);
    await user.selectOptions(await screen.findByLabelText("Deed status"), "sent");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(
      await screen.findByRole("region", { name: "Published records now held back" }),
    ).toBeTruthy();
    expect(await screen.findByText(/A record you can't see/)).toBeTruthy();
  });

  it("Enter in the record ID field adds it and doesn't save the accession", async () => {
    const sent = server({ [`GET /api/accessions/${ACC_2}`]: [200, REGISTER.accessions[1]] });
    const user = userEvent.setup();
    renderAt(`/intake/accessions/${ACC_2}`);
    await user.click(await screen.findByRole("button", { name: "Add a record" }));
    const add = screen.getByRole("group", { name: "Add a record" });
    await user.type(within(add).getByLabelText("And a label for it"), "Box");
    await user.type(
      within(add).getByLabelText("Or the record's ID"),
      `${AGENT.toUpperCase()}{Enter}`,
    );
    expect(await screen.findByRole("button", { name: "Remove Box" })).toBeTruthy();
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });
});

describe("deeds of gift", () => {
  it("marks a deed signed from the version listed", async () => {
    const sent = server({
      [`PUT /api/accessions/${ACC_1}`]: [
        200,
        { ...view(accession(ACC_1, { deedStatus: "signed" }), 2), nowHeld: [] },
      ],
    });
    renderAt("/intake/deeds");
    await userEvent.click(await screen.findByRole("button", { name: "Mark 2026.014 as signed" }));
    const put = await waitFor(() => {
      const found = sent.find((s) => s.method === "PUT");
      expect(found).toBeDefined();
      return found;
    });
    expect(put?.headers["if-match"]).toBe('"v1"');
    const body = (put?.body as { accession: Record<string, unknown> }).accession;
    expect(body.deedStatus).toBe("signed");
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("organizationId");
  });
});

describe("a donor's contact details", () => {
  it("saves the first with If-None-Match, then forgets them after confirming", async () => {
    let saved = false;
    const contact = {
      contact: { agentId: AGENT, email: "family@example.org" },
      version: 1,
      updatedAt: "2026-11-02T10:00:00.000Z",
    };
    const sent = server({
      [`GET /api/donor-contacts/${AGENT}`]: () =>
        saved ? [200, contact] : [404, { error: "not_found" }],
      [`PUT /api/donor-contacts/${AGENT}`]: () => {
        saved = true;
        return [201, contact];
      },
      [`DELETE /api/donor-contacts/${AGENT}`]: [200, { deleted: true }],
    });
    const user = userEvent.setup();
    renderAt(`/intake/donors/${AGENT}`);
    expect(await screen.findByRole("heading", { name: "<b>Invented</b> family" })).toBeTruthy();
    expect(screen.getByText("No contact details are saved for this donor.")).toBeTruthy();
    await user.type(screen.getByLabelText("Email"), "family@example.org");
    await user.click(screen.getByRole("button", { name: "Save contact details" }));
    const put = await waitFor(() => {
      const found = sent.find((s) => s.method === "PUT");
      expect(found).toBeDefined();
      return found;
    });
    expect(put?.headers["if-none-match"]).toBe("*");
    expect(put?.body).toEqual({ contact: { email: "family@example.org" } });
    await user.click(await screen.findByRole("button", { name: "Forget contact details" }));
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Yes, forget them" }));
    const del = await waitFor(() => {
      const found = sent.find((s) => s.method === "DELETE");
      expect(found).toBeDefined();
      return found;
    });
    expect(del?.headers["if-match"]).toBe('"v1"');
  });
});
