// templates.ts and vocabularies.ts import each other. This file loads
// vocabularies.ts first (vitest gives each test file its own modules), to
// show the default checker works whichever module loads first.
import { describe, expect, it } from "vitest";
import { controlledTermChecker } from "./vocabularies.js";
import { checkRecordAgainstTemplate, validateTemplate } from "./templates.js";
import { validateRecord } from "./records.js";

const ORG = "0b5e3c1a-7d2f-4a6b-8c9d-1e2f3a4b5c6d";

describe("module load order", () => {
  it("runs the default controlled term checker when vocabularies.ts loads first", () => {
    expect(typeof controlledTermChecker).toBe("function");
    const t = validateTemplate({
      key: "t",
      label: "T",
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [
        {
          key: "genre",
          label: "Genre",
          kind: "controlled_term",
          required: false,
          repeatable: false,
          visibility: "public",
          inherited: false,
        },
      ],
    });
    const r = validateRecord({
      kind: "object",
      id: "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c",
      title: "Postcard",
      organizationId: ORG,
      createdAt: "2026-11-20T16:05:00.000Z",
      updatedAt: "2026-11-20T16:05:00.000Z",
      fields: { genre: { label: "Postcards", vocabulary: "local", uri: "https://example.org/x" } },
    });
    if (!t.ok || !r.ok) throw new Error("bad fixture");
    expect(checkRecordAgainstTemplate(r.value, t.value).map((i) => i.code)).toEqual(["local_uri"]);
  });
});
