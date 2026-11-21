// Hostile input for the effective record. Each test tries one attack; each
// must be refused or neutralized, and nothing may throw. The main worry is a
// staff-only value reaching public output through inheritance.
import { describe, expect, it } from "vitest";
import {
  effectiveRecord,
  indexRecords,
  newRecordId,
  type ArchivalLevel,
  type ArchivalUnitRecord,
  type CatalogRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldValue,
  type RecordId,
  type TemplateLookup,
} from "./index.js";

const T = "2026-11-20T16:05:00.000Z";

function unit(
  title: string,
  level: ArchivalLevel,
  parent?: { readonly id: RecordId },
  fields: Record<string, FieldValue> = {},
): ArchivalUnitRecord {
  return {
    kind: "archival_unit",
    id: newRecordId(),
    title,
    level,
    createdAt: T,
    updatedAt: T,
    fields,
    ...(parent === undefined ? {} : { parentId: parent.id }),
  };
}

function def(key: string, visibility: "public" | "staff", inherited = true): FieldDefinition {
  return {
    key,
    label: key,
    kind: "text",
    required: false,
    repeatable: false,
    visibility,
    inherited,
  };
}

function template(fields: FieldDefinition[], key = "t"): FieldTemplate {
  return { key, label: key, appliesTo: ["archival_unit"], fields };
}

const PUBLIC_NOTE = template([def("note", "public")], "public-note");
const STAFF_NOTE = template([def("note", "staff")], "staff-note");

function codeOf(r: ReturnType<typeof effectiveRecord>): string | undefined {
  return r.ok ? undefined : r.issues[0]?.code;
}

/** A fonds whose template marks `note` staff, with an item below marking it public. */
function staffAbovePublic() {
  const fonds = unit("Fonds", "fonds", undefined, { note: "Donor's home address" });
  const item = unit("Item", "item", fonds);
  const lookup: TemplateLookup = (r) => (r.id === fonds.id ? STAFF_NOTE : PUBLIC_NOTE);
  return { fonds, item, lookup };
}

describe("staff values can't be made public", () => {
  it("by inheriting into a template that marks the key public", () => {
    const { fonds, item, lookup } = staffAbovePublic();
    const r = effectiveRecord(item.id, [item, fonds], lookup);
    expect(r.ok && r.value.entries.map((e) => [e.key, e.visibility])).toEqual([["note", "staff"]]);
  });

  it("by a polluted Object.prototype claiming visibility or inherited", () => {
    const { fonds, item, lookup } = staffAbovePublic();
    const proto = Object.prototype as Record<string, unknown>;
    proto.visibility = "public";
    proto.inherited = true;
    try {
      const r = effectiveRecord(item.id, [item, fonds], lookup);
      expect(r.ok && r.value.entries[0]?.visibility).toBe("staff");
    } finally {
      delete proto.visibility;
      delete proto.inherited;
    }
  });

  it("by mutating the template inside the template lookup", () => {
    // The same template object is returned for both records, made public in between.
    const shared = { ...STAFF_NOTE, fields: [{ ...def("note", "staff") }] };
    const fonds = unit("Fonds", "fonds", undefined, { note: "Private" });
    const item = unit("Item", "item", fonds);
    const lookup: TemplateLookup = (r) => {
      if (r.id === fonds.id) {
        const first = shared.fields[0];
        if (first !== undefined) (first as { visibility: string }).visibility = "public";
      }
      return shared;
    };
    const r = effectiveRecord(item.id, [item, fonds], lookup);
    expect(r.ok && r.value.entries[0]?.visibility).toBe("staff");
  });

  it("by a Proxy template that answers differently each time", () => {
    const { fonds, item } = staffAbovePublic();
    const proxy = new Proxy(STAFF_NOTE, {});
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id ? proxy : PUBLIC_NOTE,
    );
    expect(codeOf(r)).toBe("invalid_template");
  });

  it("by using a different template for the fonds than the one that marked it staff (no template at all)", () => {
    const { fonds, item } = staffAbovePublic();
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id ? undefined : PUBLIC_NOTE,
    );
    expect(codeOf(r)).toBe("no_template");
  });

  it("by a template lookup that throws a non-Error", () => {
    const { fonds, item } = staffAbovePublic();
    const r = effectiveRecord(item.id, [item, fonds], () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the attack
      throw { toString: () => "boom" };
    });
    expect(codeOf(r)).toBe("template_lookup_failed");
  });
});

describe("inherited values can't be faked", () => {
  it("from Object.prototype", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const proto = Object.prototype as Record<string, unknown>;
    proto.note = "Planted";
    try {
      const r = effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE);
      expect(r.ok && r.value.fields).toEqual({});
    } finally {
      delete proto.note;
    }
  });

  it("by fields inherited from a prototype on the caller's record", () => {
    const fonds: unknown = Object.assign(Object.create({ fields: { note: "Planted" } }), {
      ...unit("Fonds", "fonds"),
      fields: undefined,
    });
    const item = unit("Item", "item", fonds as ArchivalUnitRecord);
    const r = effectiveRecord(item.id, [item, fonds as CatalogRecord], () => PUBLIC_NOTE);
    expect(codeOf(r)).toBe("invalid_parent");
  });

  it("by a getter on a record, which isn't read", () => {
    const fonds = unit("Fonds", "fonds");
    let reads = 0;
    Object.defineProperty(fonds, "fields", {
      enumerable: true,
      get() {
        reads += 1;
        return { note: "Planted" };
      },
    });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE);
    expect(codeOf(r)).toBe("invalid_parent");
    expect(reads).toBe(0);
  });

  it("by a getter id or a Proxy record, which are skipped as unreadable", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const withGetter = { ...fonds };
    Object.defineProperty(withGetter, "id", { enumerable: true, get: () => fonds.id });
    expect(codeOf(effectiveRecord(item.id, [item, withGetter], () => PUBLIC_NOTE))).toBe(
      "missing_parent",
    );
    expect(codeOf(effectiveRecord(item.id, [item, new Proxy(fonds, {})], () => PUBLIC_NOTE))).toBe(
      "missing_parent",
    );
  });

  it("by a getter in a list slot or a Proxy list", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const list: CatalogRecord[] = [item];
    let reads = 0;
    Object.defineProperty(list, 1, {
      enumerable: true,
      get() {
        reads += 1;
        return fonds;
      },
    });
    expect(codeOf(effectiveRecord(item.id, list, () => PUBLIC_NOTE))).toBe("missing_parent");
    expect(reads).toBe(0);
    expect(codeOf(effectiveRecord(item.id, new Proxy([item, fonds], {}), () => PUBLIC_NOTE))).toBe(
      "not_a_list",
    );
  });

  it("by a forged lookup object", () => {
    const item = unit("Item", "item");
    const forged = { size: 1 } as unknown as readonly CatalogRecord[];
    expect(codeOf(effectiveRecord(item.id, forged, () => PUBLIC_NOTE))).toBe("not_a_list");
  });
});

describe("the caller's objects can't change the result once read", () => {
  it("a record changed inside the template lookup doesn't change what was read", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "Original" });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], () => {
      (fonds.fields as Record<string, FieldValue>).note = "Changed";
      return PUBLIC_NOTE;
    });
    expect(r.ok && r.value.fields.note).toBe("Original");
  });

  it("a record whose id changed after indexing is refused", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const index = indexRecords([item, fonds]);
    if (!index.ok) throw new Error("not indexed");
    (fonds as { id: RecordId }).id = newRecordId();
    expect(codeOf(effectiveRecord(item.id, index.value, () => PUBLIC_NOTE))).toBe("invalid_parent");
  });

  it("a lookup keeps the copy it validated first", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "First" });
    const item = unit("Item", "item", fonds);
    const index = indexRecords([item, fonds]);
    if (!index.ok) throw new Error("not indexed");
    const before = effectiveRecord(item.id, index.value, () => PUBLIC_NOTE);
    (fonds.fields as Record<string, FieldValue>).note = "Second";
    const after = effectiveRecord(item.id, index.value, () => PUBLIC_NOTE);
    expect(before.ok && before.value.fields.note).toBe("First");
    expect(after.ok && after.value.fields.note).toBe("First");
  });
});

describe("hostile shapes stay bounded", () => {
  it("a long loop is found without walking forever", () => {
    const ids = Array.from({ length: 1000 }, () => newRecordId());
    const units: ArchivalUnitRecord[] = ids.map((id, i) => ({
      ...unit(`S${String(i)}`, "series"),
      id,
      parentId: ids[(i + 1) % ids.length] ?? id,
    }));
    const first = ids[0];
    if (first === undefined) throw new Error("no ids");
    // Deeper than the limit before the loop closes, so the depth check stops it.
    expect(codeOf(effectiveRecord(first, units, () => PUBLIC_NOTE))).toBe("too_deep");
  });

  it("a repeatable inherited list that breaks the receiving template hundreds of times is dropped, not half-kept", () => {
    const parentT = template(
      [
        { ...def("tags", "public"), kind: "list", repeatable: true, options: optionList(500) },
        def("note", "public"),
      ],
      "parent",
    );
    const childT = template(
      [
        {
          ...def("tags", "public"),
          kind: "list",
          repeatable: true,
          options: [{ value: "none", label: "None" }],
        },
        def("note", "public"),
      ],
      "child",
    );
    const values = optionList(500).map((o) => o.value);
    const fonds = unit("Fonds", "fonds", undefined, { tags: values, note: "Fine" });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id ? parentT : childT,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    // The check stopped early (too many problems), so no inherited value is trusted.
    expect(r.value.fields).toEqual({});
    expect(r.value.notes.map((n) => n.code)).toEqual(["not_valid_here", "not_valid_here"]);
    expect(r.value.notes[1]?.message).toBe(
      '"note" isn\'t inherited from "Fonds": it could not be checked against this record\'s template.',
    );
  });
});

function optionList(count: number): { value: string; label: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    value: `o${String(i)}`,
    label: `O${String(i)}`,
  }));
}
