// Hostile input for the effective record. Each test tries one attack; each
// must be refused or neutralized, and nothing may throw. The main worry is a
// staff-only value reaching public output through inheritance.
import { describe, expect, it } from "vitest";
import {
  canPublishRights,
  effectivePublishIssues,
  effectiveRecord,
  indexRecords,
  isEffectiveRecord,
  publicView,
  rightsPublishIssues,
  type EffectiveRecord,
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

  it("by returning one template object for every record and making it staff in between", () => {
    // Public when asked for the item, staff when asked for the fonds: the
    // fonds' value is staff where it is stored, so it must stay staff.
    const shared = { ...PUBLIC_NOTE, fields: [{ ...def("note", "public") }] };
    const fonds = unit("Fonds", "fonds", undefined, { note: "Donor's home address" });
    const item = unit("Item", "item", fonds);
    const lookup: TemplateLookup = (r) => {
      const first = shared.fields[0];
      if (first !== undefined) {
        (first as { visibility: string }).visibility = r.id === fonds.id ? "staff" : "public";
      }
      return shared;
    };
    const r = effectiveRecord(item.id, [item, fonds], lookup);
    expect(r.ok && r.value.entries[0]?.visibility).toBe("staff");
    expect(r.ok && publicView(r.value)?.fields).toEqual({});
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

  it("by a getter id or a Proxy record, which fail the whole set (they could hide a duplicate)", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const withGetter = { ...fonds };
    Object.defineProperty(withGetter, "id", { enumerable: true, get: () => fonds.id });
    expect(codeOf(effectiveRecord(item.id, [item, withGetter], () => PUBLIC_NOTE))).toBe(
      "unreadable_entry",
    );
    expect(codeOf(effectiveRecord(item.id, [item, new Proxy(fonds, {})], () => PUBLIC_NOTE))).toBe(
      "unreadable_entry",
    );
    // A twin hidden behind a getter id can't make the real parent look unique.
    const twin = { ...fonds, title: "Twin" };
    Object.defineProperty(twin, "id", { enumerable: true, get: () => fonds.id });
    expect(codeOf(effectiveRecord(item.id, [item, fonds, twin], () => PUBLIC_NOTE))).toBe(
      "unreadable_entry",
    );
    const holes = [item, fonds] as CatalogRecord[];
    holes.length = 3;
    expect(codeOf(effectiveRecord(item.id, holes, () => PUBLIC_NOTE))).toBe("unreadable_entry");
    expect(
      codeOf(
        effectiveRecord(
          item.id,
          [item, fonds, "x"] as unknown as CatalogRecord[],
          () => PUBLIC_NOTE,
        ),
      ),
    ).toBe("unreadable_entry");
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
    expect(codeOf(effectiveRecord(item.id, list, () => PUBLIC_NOTE))).toBe("unreadable_entry");
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

  it("an index is a snapshot: changes to the input after indexing are not seen", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "First" });
    const item = unit("Item", "item", fonds);
    const index = indexRecords([item, fonds]);
    if (!index.ok) throw new Error("not indexed");
    (fonds.fields as Record<string, FieldValue>).note = "Changed";
    (fonds as { id: RecordId }).id = newRecordId();
    const r = effectiveRecord(item.id, index.value, () => PUBLIC_NOTE);
    expect(r.ok && r.value.fields.note).toBe("First");
    expect(r.ok && r.value.chain[0]?.id).not.toBe(fonds.id);
  });

  it("two lookups from one index see the same snapshot, even if the input changed between them", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "First" });
    const a = unit("A", "item", fonds);
    const b = unit("B", "item", fonds);
    const index = indexRecords([a, b, fonds]);
    if (!index.ok) throw new Error("not indexed");
    (fonds.fields as Record<string, FieldValue>).note = "Second";
    const first = effectiveRecord(a.id, index.value, () => PUBLIC_NOTE);
    (fonds.fields as Record<string, FieldValue>).note = "Third";
    const second = effectiveRecord(b.id, index.value, () => PUBLIC_NOTE);
    expect(first.ok && first.value.fields.note).toBe("First");
    expect(second.ok && second.value.fields.note).toBe("First");
  });

  it("an invalid record is remembered under its ID when indexed", () => {
    const fonds = unit("Fonds", "fonds");
    const item = unit("Item", "item", fonds);
    const index = indexRecords([item, { ...fonds, title: " bad" }]);
    if (!index.ok) throw new Error("not indexed");
    expect(codeOf(effectiveRecord(item.id, index.value, () => PUBLIC_NOTE))).toBe("invalid_parent");
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

describe("public output only comes from publicView", () => {
  function tree() {
    const fonds = unit("Fonds", "fonds", undefined, {
      note: "Donor's home address",
      creator: "Society",
      old_key: "Left over",
    });
    const item = unit("Item", "item", fonds, { secret: "Staff remark", old_item: "Left over too" });
    const fondsT = template([def("note", "staff"), def("creator", "public")], "fonds");
    const itemT = template(
      [def("note", "public"), def("creator", "public"), def("secret", "staff")],
      "item",
    );
    const lookup: TemplateLookup = (r) => (r.id === fonds.id ? fondsT : itemT);
    const r = effectiveRecord(item.id, [item, fonds], lookup);
    if (!r.ok) throw new Error("failed");
    return r.value;
  }

  it("has only public, in-template entries; never a staff value, own or inherited", () => {
    const effective = tree();
    // The full effective record does hold them, for staff screens.
    expect(effective.fields.note).toBe("Donor's home address");
    expect(effective.fields.secret).toBe("Staff remark");
    const view = publicView(effective);
    expect(view?.fields).toEqual({ creator: "Society" });
    expect(view?.entries).toEqual([
      { key: "creator", label: "creator", value: "Society", own: false },
    ]);
    const text = JSON.stringify(view);
    for (const leak of ["Donor", "Staff remark", "Left over", "Fonds"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("carries no notes, stored record or chain, and is frozen", () => {
    const view = publicView(tree());
    expect(Object.keys(view ?? {}).sort()).toEqual(["entries", "fields", "id", "kind", "title"]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.fields)).toBe(true);
    expect(view?.entries.every((e) => Object.isFrozen(e))).toBe(true);
  });

  it("keeps notes, which can quote values, out of the public view", () => {
    const fondsT = template([{ ...def("note", "staff"), kind: "long_text" }], "fonds");
    const fonds = unit("Fonds", "fonds", undefined, { note: "Quoted secret" });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id ? fondsT : PUBLIC_NOTE,
    );
    if (!r.ok) throw new Error("failed");
    expect(r.value.notes).toHaveLength(1);
    expect(JSON.stringify(publicView(r.value))).not.toContain("note");
  });

  it("gives nothing for a hand-made or copied effective record", () => {
    const effective = tree();
    const copy = { ...effective, fields: { note: "x" } } as EffectiveRecord;
    expect(publicView(copy)).toBeUndefined();
    expect(publicView(null as unknown as EffectiveRecord)).toBeUndefined();
    expect(effectivePublishIssues(copy)[0]?.code).toBe("not_effective");
  });
});

describe("the publish check can't be passed with staff-only rights", () => {
  const RIGHTS = "http://rightsstatements.org/vocab/CNE/1.0/";

  function withRights(fondsVisibility: "public" | "staff", ownRights = false) {
    const fonds = unit("Fonds", "fonds", undefined, { rights: RIGHTS });
    const item = unit("Item", "item", fonds, ownRights ? { rights: RIGHTS } : {});
    const fondsT = template([def("rights", fondsVisibility)], "fonds");
    const itemT = template([def("rights", "public")], "item");
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id ? fondsT : itemT,
    );
    if (!r.ok) throw new Error("failed");
    return r.value;
  }

  it("refuses rights inherited from a template that marks them staff", () => {
    const effective = withRights("staff");
    expect(effective.fields.rights).toBe(RIGHTS);
    expect(effectivePublishIssues(effective).map((i) => i.code)).toEqual(["rights_not_public"]);
    expect(canPublishRights(publicView(effective))).toBe(false);
  });

  it("accepts public inherited rights, and the record's own public rights", () => {
    expect(effectivePublishIssues(withRights("public"))).toEqual([]);
    expect(effectivePublishIssues(withRights("staff", true))).toEqual([]);
  });

  it("reports missing rights as missing", () => {
    const item = unit("Item", "item");
    const r = effectiveRecord(item.id, [item], () => template([def("rights", "public")]));
    if (!r.ok) throw new Error("failed");
    expect(effectivePublishIssues(r.value).map((i) => i.code)).toEqual(["rights_missing"]);
  });
});

describe("plug-in checkers run on inherited values", () => {
  const refuseBad = {
    text: (value: unknown) =>
      value === "bad" ? [{ code: "refused", message: "This value is refused." }] : [],
  };

  it("an inherited value a checker refuses is left out, with a note", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "bad" });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE, { checkers: refuseBad });
    expect(r.ok && r.value.fields).toEqual({});
    expect(r.ok && r.value.notes[0]?.code).toBe("not_valid_here");
    // Without the checker, the same value is inherited.
    const plain = effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE);
    expect(plain.ok && plain.value.fields).toEqual({ note: "bad" });
  });

  it("a checker that throws makes the inherited value fail, not pass", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "fine" });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE, {
      checkers: {
        text: () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.ok && r.value.fields).toEqual({});
  });

  it("options that can't be read plainly fail instead of skipping the checks", () => {
    const item = unit("Item", "item");
    const proxy = new Proxy({ checkers: refuseBad }, {});
    expect(codeOf(effectiveRecord(item.id, [item], () => PUBLIC_NOTE, proxy))).toBe(
      "invalid_options",
    );
    const getter = Object.defineProperty({}, "checkers", { get: () => refuseBad });
    expect(codeOf(effectiveRecord(item.id, [item], () => PUBLIC_NOTE, getter))).toBe(
      "invalid_options",
    );
  });
});

describe("checkers can't change what was checked", () => {
  it("a checker rewriting a later inherited value can't get an unchecked value kept", () => {
    const both = template([def("note", "public"), def("other", "public")], "both");
    const fonds = unit("Fonds", "fonds", undefined, { note: "Fine", other: "Bad" });
    const item = unit("Item", "item", fonds);
    const checkers = {
      text: (value: unknown, _field: unknown, rec: CatalogRecord) => {
        if (value === "Fine") {
          try {
            (rec.fields as Record<string, FieldValue>).other = "Good";
          } catch {
            // Frozen: the rewrite is refused.
          }
        }
        return value === "Bad" ? [{ code: "refused", message: "Refused." }] : [];
      },
    };
    const r = effectiveRecord(item.id, [item, fonds], () => both, { checkers });
    if (!r.ok) throw new Error("failed");
    expect(r.value.fields).toEqual({ note: "Fine" });
    expect(publicView(r.value)?.fields).toEqual({ note: "Fine" });
    expect(r.value.notes.map((n) => [n.code, n.path])).toEqual([
      ["not_valid_here", ["fields", "other"]],
    ]);
  });

  it("checkers are given a frozen record", () => {
    const fonds = unit("Fonds", "fonds", undefined, { note: "Fine" });
    const item = unit("Item", "item", fonds);
    let frozen = false;
    effectiveRecord(item.id, [item, fonds], () => PUBLIC_NOTE, {
      checkers: {
        text: (_v: unknown, _f: unknown, rec: CatalogRecord) => {
          frozen = Object.isFrozen(rec) && Object.isFrozen(rec.fields);
          return [];
        },
      },
    });
    expect(frozen).toBe(true);
  });

  it("a Proxy checkers object is refused", () => {
    const item = unit("Item", "item");
    const r = effectiveRecord(item.id, [item], () => PUBLIC_NOTE, {
      checkers: new Proxy({}, {}),
    });
    expect(codeOf(r)).toBe("invalid_options");
  });
});

describe("rightsPublishIssues refuses an effective record", () => {
  it("so staff-only rights can't pass by the wrong check", () => {
    const RIGHTS = "http://rightsstatements.org/vocab/CNE/1.0/";
    const fonds = unit("Fonds", "fonds", undefined, { rights: RIGHTS });
    const item = unit("Item", "item", fonds);
    const r = effectiveRecord(item.id, [item, fonds], (rec) =>
      rec.id === fonds.id
        ? template([def("rights", "staff")], "fonds")
        : template([def("rights", "public")], "item"),
    );
    if (!r.ok) throw new Error("failed");
    expect(isEffectiveRecord(r.value)).toBe(true);
    expect(rightsPublishIssues(r.value).map((i) => i.code)).toEqual([
      "use_effective_publish_issues",
    ]);
    expect(canPublishRights(r.value)).toBe(false);
    expect(effectivePublishIssues(r.value).map((i) => i.code)).toEqual(["rights_not_public"]);
    expect(isEffectiveRecord({ ...r.value })).toBe(false);
    expect(isEffectiveRecord(publicView(r.value))).toBe(false);
  });
});
