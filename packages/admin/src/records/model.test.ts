// The record editor's model (T-046): form values to drafts and back, issue
// paths to fields, the workflow moves offered per ability, and the only two
// places a link is built from data (http/https web addresses and record IDs).
import { describe, expect, it } from "vitest";
import {
  draftOf,
  formValueOf,
  issueTarget,
  issuesByTarget,
  issuesIn,
  newDraft,
  offeredMoves,
  recordDraft,
  recordPath,
  safeHref,
  sameDraft,
  storedValueOf,
  valueText,
  type FieldDefinition,
  type FieldTemplate,
  type StoredRecord,
} from "./model";

const field = (
  key: string,
  kind: FieldDefinition["kind"],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  key,
  label: key,
  kind,
  required: false,
  repeatable: false,
  visibility: "public",
  inherited: false,
  ...extra,
});

const TEMPLATE: FieldTemplate = {
  key: "t-object",
  label: "Object",
  appliesTo: ["object"],
  fields: [
    field("note", "text"),
    field("story", "long_text"),
    field("subjects", "controlled_term", { repeatable: true }),
    field("rights", "rights"),
  ],
};

const RECORD: StoredRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "00000000-0000-4000-8000-00000000000a",
  kind: "object",
  title: "An invented lantern",
  templateKey: "t-object",
  createdAt: "2026-11-24T10:00:00.000Z",
  updatedAt: "2026-11-24T10:00:00.000Z",
  fields: {
    note: "Tin.",
    subjects: [{ label: "Lanterns", vocabulary: "lcsh" }],
    leftover: "From an older template.",
  },
};

describe("form values", () => {
  it("reads stored values into the form and writes back only what holds something", () => {
    const draft = draftOf(RECORD, TEMPLATE);
    expect(draft.fields.note).toBe("Tin.");
    expect(draft.fields.subjects).toEqual([{ label: "Lanterns", uri: "", vocabulary: "lcsh" }]);
    expect(draft.fields.rights).toEqual({ uri: "", note: "" });
    expect(recordDraft(draft, TEMPLATE, RECORD)).toEqual({
      kind: "object",
      title: "An invented lantern",
      templateKey: "t-object",
      fields: {
        // Kept unchanged so a save never drops it silently.
        leftover: "From an older template.",
        note: "Tin.",
        subjects: [{ label: "Lanterns", vocabulary: "lcsh" }],
      },
    });
    expect(sameDraft(draft, draftOf(RECORD, TEMPLATE), TEMPLATE)).toBe(true);
    expect(sameDraft({ ...draft, title: "Changed" }, draft, TEMPLATE)).toBe(false);
  });

  it("drops empty entries of a repeatable field and trims one-line text", () => {
    const f = field("subjects", "controlled_term", { repeatable: true });
    expect(
      storedValueOf(f, [
        { label: " Lanterns ", uri: "", vocabulary: "" },
        { label: "", uri: "", vocabulary: "" },
      ]),
    ).toEqual([{ label: "Lanterns" }]);
    expect(storedValueOf(f, [{ label: "", uri: "", vocabulary: "" }])).toBeUndefined();
    expect(storedValueOf(field("note", "text"), "  ")).toBeUndefined();
    expect(storedValueOf(field("story", "long_text"), "Line one\n")).toBe("Line one\n");
    expect(formValueOf(f, undefined)).toEqual([{ label: "", uri: "", vocabulary: "" }]);
  });

  it("makes a new record's form and the kind's own properties", () => {
    const unit = newDraft("archival_unit", { ...TEMPLATE, appliesTo: ["archival_unit"] });
    expect(unit.level).toBe("fonds");
    expect(recordDraft({ ...unit, title: " A fonds ", parentId: "" }, TEMPLATE)).toEqual({
      kind: "archival_unit",
      title: "A fonds",
      templateKey: "t-object",
      level: "fonds",
      fields: {},
    });
    const place = newDraft("place", TEMPLATE);
    expect(recordDraft({ ...place, lat: "29.46", lng: "-95.05" }, TEMPLATE).coordinates).toEqual({
      lat: 29.46,
      lng: -95.05,
    });
  });
});

describe("issues", () => {
  const keys = new Set(["note", "subjects"]);
  it("puts each issue beside its field, or on the form", () => {
    expect(issueTarget({ path: ["fields", "note"], code: "x", message: "m" }, keys)).toBe(
      "fields.note",
    );
    expect(
      issueTarget({ path: ["fields", "subjects", 0, "label"], code: "x", message: "m" }, keys),
    ).toBe("fields.subjects");
    expect(issueTarget({ path: ["title"], code: "x", message: "m" }, keys)).toBe("title");
    expect(issueTarget({ path: ["fields", "gone"], code: "x", message: "m" }, keys)).toBe("form");
    expect(issueTarget({ path: [], code: "x", message: "m" }, keys)).toBe("form");
    const grouped = issuesByTarget(
      [
        { path: ["title"], code: "a", message: "One." },
        { path: ["title"], code: "b", message: "One." },
        { path: ["title"], code: "c", message: "Two." },
      ],
      keys,
    );
    expect(grouped.get("title")).toEqual(["One.", "Two."]);
  });

  it("reads only well-formed issues from a reply", () => {
    expect(
      issuesIn({
        issues: [{ path: ["title"], code: "c", message: "m" }, { path: "x" }, null, "text"],
      }),
    ).toEqual([{ path: ["title"], code: "c", message: "m" }]);
    expect(issuesIn(null)).toEqual([]);
    expect(issuesIn({ issues: "no" })).toEqual([]);
  });
});

describe("workflow moves offered (the server still decides)", () => {
  const none = { edit: false, history: false, publish: false, delete: false };
  it("offers edit moves for editors and publishing only to publishers", () => {
    expect(offeredMoves("draft", { ...none, edit: true })).toEqual(["submit-for-review"]);
    expect(offeredMoves("draft", { ...none, edit: true, publish: true })).toEqual([
      "submit-for-review",
      "publish",
    ]);
    expect(offeredMoves("ready_for_review", { ...none, edit: true })).toEqual(["return-to-draft"]);
    expect(offeredMoves("published", { ...none, edit: true })).toEqual([]);
    expect(offeredMoves("published", { ...none, publish: true })).toEqual(["withdraw"]);
    expect(offeredMoves("withdrawn", none)).toEqual([]);
  });
});

describe("links built from data", () => {
  it("allows only http and https web addresses", () => {
    expect(safeHref("https://example.org/a?b=c")).toBe("https://example.org/a?b=c");
    expect(safeHref("http://example.org")).toBe("http://example.org/");
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "//example.org",
      "/relative",
      "https://user:pass@example.org/",
      "",
    ]) {
      expect([bad, safeHref(bad)]).toEqual([bad, undefined]);
    }
  });

  it("builds a record's route only from well-formed IDs", () => {
    const site = "00000000-0000-4000-8000-000000000001";
    expect(recordPath(site, RECORD.id)).toBe(`/sites/${site}/records/${RECORD.id}`);
    expect(recordPath(site, "../../admin")).toBeUndefined();
    expect(recordPath(site, "javascript:alert(1)")).toBeUndefined();
    expect(recordPath("x", RECORD.id)).toBeUndefined();
  });

  it("shows any stored value as plain text", () => {
    expect(valueText({ label: "Lanterns", uri: "http://id.loc.gov/x" })).toBe(
      "Lanterns · uri: http://id.loc.gov/x",
    );
    expect(valueText(["a", { value: "b" }])).toBe("a; b");
    expect(valueText("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(valueText(undefined)).toBe("");
  });
});
