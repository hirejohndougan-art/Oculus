// Attacks on template changes (security S-002): a template edit must not
// publish staff values without anyone noticing, and hostile templates or
// records must be refused without throwing.
import { describe, expect, it } from "vitest";
import {
  DACS_ARCHIVAL_UNIT_PRESET,
  MAX_LISTED_RECORDS,
  templateChanges,
  type FieldTemplate,
  type TemplateChanges,
  type Validated,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();
/** The DACS preset as this organization's template. */
const DACS = { ...DACS_ARCHIVAL_UNIT_PRESET, organizationId: ORG } as FieldTemplate;

const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SECRET = "Donor asked that her phone number 555-0100 stay private";

function unit(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "archival_unit",
    level: "item",
    id,
    title: "Letter",
    organizationId: ORG,
    createdAt: T,
    updatedAt: T,
    fields,
  };
}

/** The DACS preset with its staff `notes` field changed by `edit`, or removed. */
function dacs(
  edit: ((f: Record<string, unknown>) => Record<string, unknown>) | "remove",
): FieldTemplate {
  const fields = DACS.fields.flatMap((f): unknown[] => {
    if (f.key !== "notes") return [f];
    return edit === "remove" ? [] : [edit({ ...f })];
  });
  return { ...DACS, fields } as FieldTemplate;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function ok(result: Validated<TemplateChanges>): TemplateChanges {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

const RECORDS = [unit(A, { notes: SECRET }), unit(B, {})];

describe("staff values made public by a template change", () => {
  it("reports a staff field made public, with the record holding a value", () => {
    const r = ok(
      templateChanges(
        DACS,
        dacs((f) => ({ ...f, visibility: "public" })),
        RECORDS,
      ),
    );
    const change = r.changes.find((c) => c.code === "made_public");
    expect(change?.key).toBe("notes");
    expect(change?.recordIds).toEqual([A]);
    expect(change?.needsConfirmation).toBe(true);
    expect(r.needsConfirmation).toBe(true);
  });

  it("reports a staff field removed and then added back as public", () => {
    const removed = dacs("remove");
    const first = ok(templateChanges(DACS, removed, RECORDS));
    expect(first.changes.map((c) => [c.code, c.key, c.recordIds])).toEqual([
      ["key_removed", "notes", [A]],
    ]);
    // The second save, against the template without `notes`: only the
    // records show that `notes` still holds staff values.
    const readded = dacs((f) => ({ ...f, label: "Public notes", visibility: "public" }));
    const second = ok(templateChanges(removed, readded, RECORDS));
    const change = second.changes.find((c) => c.code === "made_public");
    expect(change?.key).toBe("notes");
    expect(change?.recordIds).toEqual([A]);
    expect(change?.needsConfirmation).toBe(true);
    expect(second.changes.map((c) => c.code)).toEqual(["made_public", "key_reused"]);
  });

  it("never quotes a stored value in a message", () => {
    const removed = dacs("remove");
    const results = [
      templateChanges(
        DACS,
        dacs((f) => ({ ...f, visibility: "public" })),
        RECORDS,
      ),
      templateChanges(DACS, removed, RECORDS),
      templateChanges(
        removed,
        dacs((f) => ({ ...f, visibility: "public" })),
        RECORDS,
      ),
      templateChanges(
        DACS,
        dacs((f) => ({ ...f, kind: "text" })),
        RECORDS,
      ),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain("555-0100");
    expect(text).not.toContain("Donor");
  });

  it("lists at most MAX_LISTED_RECORDS IDs but counts them all", () => {
    const many = Array.from({ length: MAX_LISTED_RECORDS + 5 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return unit(`3f1c2a9e-8b7d-4c6e-9a1b-${hex}`, { notes: "x" });
    });
    const r = ok(
      templateChanges(
        DACS,
        dacs((f) => ({ ...f, visibility: "public" })),
        many,
      ),
    );
    const change = r.changes.find((c) => c.code === "made_public");
    expect(change?.recordCount).toBe(MAX_LISTED_RECORDS + 5);
    expect(change?.recordIds.length).toBe(MAX_LISTED_RECORDS);
  });
});

describe("template changes that could publish without records or other templates", () => {
  it("reports a public field re-added when records weren't given", () => {
    const r = ok(
      templateChanges(
        dacs("remove"),
        dacs((f) => ({ ...f, visibility: "public" })),
      ),
    );
    const change = r.changes.find((c) => c.code === "made_public");
    expect(change?.key).toBe("notes");
    expect(change?.needsConfirmation).toBe(true);
    expect(r.recordsChecked).toBe(false);
  });

  it("reports a record kind added to a template with public fields", () => {
    const wider = { ...DACS, appliesTo: ["archival_unit", "object"] };
    const asset = {
      kind: "object",
      id: B,
      title: "Postcard",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: { scope_and_content: SECRET },
    };
    const r = ok(templateChanges(DACS, wider, [asset]));
    const change = r.changes.find((c) => c.code === "kind_added");
    expect(change?.key).toBe("object");
    expect(change?.recordIds).toEqual([B]);
    expect(change?.needsConfirmation).toBe(true);
    expect(JSON.stringify(r)).not.toContain("555-0100");
  });

  it("needs confirmation when a public field starts being inherited", () => {
    const before = dacs((f) => ({ ...f, visibility: "public" }));
    const after = dacs((f) => ({ ...f, visibility: "public", inherited: true }));
    const r = ok(templateChanges(before, after, []));
    expect(r.changes.map((c) => [c.code, c.needsConfirmation])).toEqual([
      ["inherited_changed", true],
    ]);
  });
});

describe("hostile input", () => {
  const publicNotes = dacs((f) => ({ ...f, visibility: "public" }));

  it("refuses Proxy templates and records lists", () => {
    expect(codes(templateChanges(new Proxy({ ...DACS }, {}), publicNotes))).toEqual([
      "not_an_object",
    ]);
    expect(codes(templateChanges(DACS, publicNotes, new Proxy([...RECORDS], {})))).toEqual([
      "not_a_list",
    ]);
  });

  it("refuses a Proxy record, which could hide a staff value", () => {
    const records = [new Proxy(unit(A, { notes: SECRET }), {})];
    expect(codes(templateChanges(DACS, publicNotes, records))).toEqual(["invalid_record"]);
  });

  it("refuses getters without running them", () => {
    let ran = false;
    const records: unknown[] = [];
    Object.defineProperty(records, 0, {
      enumerable: true,
      get() {
        ran = true;
        return unit(A, {});
      },
    });
    expect(codes(templateChanges(DACS, publicNotes, records))).toEqual(["invalid_record"]);
    const t = { ...publicNotes };
    Object.defineProperty(t, "fields", {
      enumerable: true,
      get() {
        ran = true;
        return publicNotes.fields;
      },
    });
    expect(templateChanges(DACS, t).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("refuses a template whose getter throws", () => {
    const t = {};
    Object.defineProperty(t, "key", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => templateChanges(t, publicNotes)).not.toThrow();
    expect(templateChanges(t, publicNotes).ok).toBe(false);
  });

  it("refuses a huge template quickly", () => {
    const fields = Array.from({ length: 100_000 }, (_, i) => ({
      ...DACS.fields[0],
      key: `f${String(i)}`,
    }));
    const start = Date.now();
    const result = templateChanges(DACS, {
      ...DACS,
      fields,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("refuses duplicate record IDs, which could hide a value", () => {
    const records = [unit(A, {}), unit(A, { notes: SECRET })];
    expect(codes(templateChanges(DACS, publicNotes, records))).toEqual(["duplicate_id"]);
  });

  it("refuses records that aren't a list, and a sparse list", () => {
    expect(codes(templateChanges(DACS, publicNotes, { 0: RECORDS[0] }))).toEqual(["not_a_list"]);
    const sparse: unknown[] = [RECORDS[0]];
    sparse[2] = RECORDS[1];
    expect(codes(templateChanges(DACS, publicNotes, sparse))).toEqual(["invalid_record"]);
  });

  it("ignores a polluted Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.notes = SECRET;
    try {
      const r = ok(templateChanges(dacs("remove"), publicNotes, [unit(B, {})]));
      expect(r.changes).toEqual([]);
    } finally {
      delete proto.notes;
    }
  });
});

// Independent review of T-012: records of another template must not be
// counted (or listed) in this template's confirmation.
describe("records must follow the template being changed", () => {
  const key = DACS.key;
  const makePublic = dacs((f) => ({ ...f, visibility: "public" }));

  it("refuses the whole comparison for a record of another template", () => {
    const other = { ...unit(A, { notes: SECRET }), templateKey: "other-template" };
    const r = templateChanges(DACS, makePublic, [{ ...unit(B, {}), templateKey: key }, other]);
    expect(codes(r)).toEqual(["record_not_for_template"]);
    expect(r.ok ? [] : r.issues[0]?.path).toEqual(["records", 1, "templateKey"]);
    expect(JSON.stringify(r)).not.toContain("555-0100");
  });

  it("counts records of this template, and says how many name no template", () => {
    const r = ok(
      templateChanges(DACS, makePublic, [
        { ...unit(A, { notes: SECRET }), templateKey: key },
        unit(B, {}),
      ]),
    );
    expect(r.legacyRecords).toBe(1);
    expect(r.changes.find((c) => c.code === "made_public")?.recordIds).toEqual([A]);
    expect(ok(templateChanges(DACS, makePublic)).legacyRecords).toBe(0);
  });
});

describe("another organization's records can't be mixed into the check (D-019)", () => {
  it("refuses a list holding another organization's record, wherever it is", () => {
    const other = { ...unit(B, { notes: SECRET }), organizationId: newOrganizationId() };
    const before = dacs((f) => f);
    const after = dacs((f) => ({ ...f, visibility: "public" }));
    for (const records of [
      [unit(A, {}), other],
      [other, unit(A, {})],
    ]) {
      const r = templateChanges(before, after, records);
      expect(codes(r)).toEqual(["mixed_organizations"]);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain(B);
    }
  });
});
