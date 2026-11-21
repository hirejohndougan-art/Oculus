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
} from "./index.js";

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
    createdAt: T,
    updatedAt: T,
    fields,
  };
}

/** The DACS preset with its staff `notes` field changed by `edit`, or removed. */
function dacs(
  edit: ((f: Record<string, unknown>) => Record<string, unknown>) | "remove",
): FieldTemplate {
  const fields = DACS_ARCHIVAL_UNIT_PRESET.fields.flatMap((f): unknown[] => {
    if (f.key !== "notes") return [f];
    return edit === "remove" ? [] : [edit({ ...f })];
  });
  return { ...DACS_ARCHIVAL_UNIT_PRESET, fields } as FieldTemplate;
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
        DACS_ARCHIVAL_UNIT_PRESET,
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
    const first = ok(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, removed, RECORDS));
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
        DACS_ARCHIVAL_UNIT_PRESET,
        dacs((f) => ({ ...f, visibility: "public" })),
        RECORDS,
      ),
      templateChanges(DACS_ARCHIVAL_UNIT_PRESET, removed, RECORDS),
      templateChanges(
        removed,
        dacs((f) => ({ ...f, visibility: "public" })),
        RECORDS,
      ),
      templateChanges(
        DACS_ARCHIVAL_UNIT_PRESET,
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
        DACS_ARCHIVAL_UNIT_PRESET,
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
    const wider = { ...DACS_ARCHIVAL_UNIT_PRESET, appliesTo: ["archival_unit", "object"] };
    const asset = {
      kind: "object",
      id: B,
      title: "Postcard",
      createdAt: T,
      updatedAt: T,
      fields: { scope_and_content: SECRET },
    };
    const r = ok(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, wider, [asset]));
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
    expect(
      codes(templateChanges(new Proxy({ ...DACS_ARCHIVAL_UNIT_PRESET }, {}), publicNotes)),
    ).toEqual(["not_an_object"]);
    expect(
      codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, new Proxy([...RECORDS], {}))),
    ).toEqual(["not_a_list"]);
  });

  it("refuses a Proxy record, which could hide a staff value", () => {
    const records = [new Proxy(unit(A, { notes: SECRET }), {})];
    expect(codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, records))).toEqual([
      "invalid_record",
    ]);
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
    expect(codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, records))).toEqual([
      "invalid_record",
    ]);
    const t = { ...publicNotes };
    Object.defineProperty(t, "fields", {
      enumerable: true,
      get() {
        ran = true;
        return publicNotes.fields;
      },
    });
    expect(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, t).ok).toBe(false);
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
      ...DACS_ARCHIVAL_UNIT_PRESET.fields[0],
      key: `f${String(i)}`,
    }));
    const start = Date.now();
    const result = templateChanges(DACS_ARCHIVAL_UNIT_PRESET, {
      ...DACS_ARCHIVAL_UNIT_PRESET,
      fields,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("refuses duplicate record IDs, which could hide a value", () => {
    const records = [unit(A, {}), unit(A, { notes: SECRET })];
    expect(codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, records))).toEqual([
      "duplicate_id",
    ]);
  });

  it("refuses records that aren't a list, and a sparse list", () => {
    expect(
      codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, { 0: RECORDS[0] })),
    ).toEqual(["not_a_list"]);
    const sparse: unknown[] = [RECORDS[0]];
    sparse[2] = RECORDS[1];
    expect(codes(templateChanges(DACS_ARCHIVAL_UNIT_PRESET, publicNotes, sparse))).toEqual([
      "invalid_record",
    ]);
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
