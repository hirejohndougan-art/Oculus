import { describe, expect, it } from "vitest";
import {
  MAX_LISTED_RECORDS,
  newOrganizationId,
  identifierTypeChanges,
  identifierTypeCreation,
  identifierTypeDeletion,
  newRecordId,
  type IdentifierType,
  type IdentifierTypeChanges,
  type Validated,
} from "./index.js";

// Invented sample data.
const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const C = "5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const ACCESSION: IdentifierType = {
  organizationId: ORG,
  key: "accession",
  label: "Accession number",
  pattern: "DHS-####",
  uniqueness: "current",
  autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 },
};
const BOX: IdentifierType = { organizationId: ORG, key: "box", label: "Box", uniqueness: "none" };

/** `type` with `keys` left out (undefined isn't allowed in place of a missing property). */
function without(type: IdentifierType, ...keys: (keyof IdentifierType)[]): IdentifierType {
  const drop = new Set<string>(keys);
  return Object.fromEntries(
    Object.entries(type).filter(([k]) => !drop.has(k)),
  ) as unknown as IdentifierType;
}

function set(
  recordId: string,
  current: { type: string; value: string }[],
  former: { type: string; value: string }[] = [],
): Record<string, unknown> {
  return {
    recordId,
    organizationId: ORG,
    current: current.map((c, i) => ({ ...c, primary: i === 0 })),
    former,
  };
}

function record(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "object",
    organizationId: ORG,
    id,
    title: "Postcard",
    createdAt: T,
    updatedAt: T,
    fields,
  };
}

function use(
  identifiers: unknown[],
  records: unknown[] = [],
  identifierTypes: IdentifierType[] = [ACCESSION, BOX],
): Record<string, unknown> {
  return { identifierTypes, identifiers, records };
}

function ok(result: Validated<IdentifierTypeChanges>): IdentifierTypeChanges {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function summary(r: IdentifierTypeChanges): [string, boolean, readonly string[]][] {
  return r.changes.map((c) => [c.code, c.needsConfirmation, c.recordIds]);
}

const SETS = [
  set(A, [{ type: "accession", value: "DHS-0001" }]),
  set(B, [{ type: "box", value: "12" }], [{ type: "accession", value: "DHS-0002" }]),
  set(C, [{ type: "box", value: "12" }]),
];

describe("identifierTypeChanges", () => {
  it("reports nothing for an unchanged type, or a new label", () => {
    const r = ok(identifierTypeChanges(ACCESSION, ACCESSION, use(SETS)));
    expect(r).toEqual({ changes: [], needsConfirmation: false, recordsChecked: true });
    expect(Object.isFrozen(r) && Object.isFrozen(r.changes)).toBe(true);
    const relabelled = { ...ACCESSION, label: "Accession no." };
    expect(ok(identifierTypeChanges(ACCESSION, relabelled, use(SETS))).changes).toEqual([]);
  });

  it("reports a renamed key with every record holding a value, current, former or in a field", () => {
    const r = ok(
      identifierTypeChanges(
        ACCESSION,
        { ...ACCESSION, key: "accession_number" },
        use(SETS, [record(C, { number: { type: "accession", value: "DHS-0003" } })]),
      ),
    );
    expect(summary(r)).toEqual([["key_changed", true, [A, B, C]]]);
    expect(r.changes[0]?.recordCount).toBe(3);
    expect(r.changes[0]?.type).toBe("accession");
    expect(r.changes[0]?.message).toContain('"accession_number"');
  });

  it("a renamed key nothing uses is informational", () => {
    const r = ok(identifierTypeChanges(BOX, { ...BOX, key: "carton" }, use([])));
    expect(summary(r)).toEqual([["key_changed", false, []]]);
  });

  it("refuses a new key another type already has", () => {
    expect(codes(identifierTypeChanges(BOX, { ...BOX, key: "accession" }, use([])))).toEqual([
      "key_taken",
    ]);
  });

  it("making a type public always needs confirmation, and lists the records", () => {
    const r = ok(identifierTypeChanges(ACCESSION, { ...ACCESSION, public: true }, use(SETS)));
    expect(summary(r)).toEqual([["made_public", true, [A, B]]]);
    const none = ok(identifierTypeChanges(BOX, { ...BOX, public: true }, use([])));
    expect(summary(none)).toEqual([["made_public", true, []]]);
    const pub = { ...ACCESSION, public: true };
    const back = ok(identifierTypeChanges(pub, ACCESSION, use(SETS, [], [pub, BOX])));
    expect(summary(back)).toEqual([["made_staff", false, []]]); // no records in fields
  });

  it("reports current values, not former ones, that a new format refuses", () => {
    const wide = { ...without(ACCESSION, "autoNumber"), pattern: "DHS-#{4,5}" };
    const r = ok(
      identifierTypeChanges(
        wide,
        { ...wide, pattern: "DHS-#####" },
        use(
          [
            set(A, [{ type: "accession", value: "DHS-0001" }]),
            set(
              B,
              [{ type: "accession", value: "DHS-00002" }],
              [{ type: "accession", value: "DHS-0001" }],
            ),
          ],
          [
            record(C, { n: [{ type: "accession", value: "DHS-0004" }] }),
            record(B, { n: { type: "box", value: "DHS-0004" } }),
          ],
          [wide, BOX],
        ),
      ),
    );
    expect(summary(r)).toEqual([["format_changed", true, [A, C]]]);
    // A format taken away refuses nothing.
    const loose = ok(identifierTypeChanges(ACCESSION, without(ACCESSION, "pattern"), use(SETS)));
    expect(loose.changes).toEqual([]);
    // A new format every value fits is informational.
    const fits = ok(
      identifierTypeChanges(ACCESSION, { ...ACCESSION, pattern: "DHS-#{4,5}" }, use(SETS)),
    );
    expect(summary(fits)).toEqual([["format_changed", false, []]]);
  });

  it("lists the published records a new format takes off public sites (S-026)", () => {
    const pub = { ...without(ACCESSION, "autoNumber"), public: true, pattern: "DHS-#{4,5}" };
    const D = "6c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
    const E = "7d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80";
    const F = "8e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8091";
    const unit = (id: string, fields: Record<string, unknown>, parentId?: string) => ({
      ...record(id, fields),
      kind: "archival_unit",
      level: "item",
      ...(parentId === undefined ? {} : { parentId }),
    });
    const records = [
      // A holds a misfit in a field; B and C below it only inherit it (they
      // stay public without it); D holds one but is unpublished; E holds one
      // only in its identifiers; F fits.
      unit(A, { number: { type: "accession", value: "DHS-0001" } }),
      unit(B, {}, A),
      unit(C, {}, B),
      unit(D, { number: { type: "accession", value: "DHS-0004" } }, A),
      unit(E, {}),
      unit(F, { number: { type: "accession", value: "DHS-00006" } }),
    ];
    const existing = {
      ...use([set(E, [{ type: "accession", value: "DHS-0005" }])], records, [pub, BOX]),
      published: [A, C, E, F],
    };
    const r = ok(identifierTypeChanges(pub, { ...pub, pattern: "DHS-#####" }, existing));
    const change = r.changes[0];
    expect(change?.code).toBe("format_changed");
    expect(change?.recordIds).toEqual([E, A, D]);
    expect(change?.publishedRecordIds).toEqual([A]);
    expect(change?.publishedRecordCount).toBe(1);
    expect(change?.message).toContain("1 published record would show as not available");
    expect(change?.message).not.toContain("DHS-0001");
    expect(Object.isFrozen(change?.publishedRecordIds)).toBe(true);

    // A field that's staff in the record's template shows nothing, so it takes nothing off.
    const templates = [
      {
        key: "unit",
        organizationId: ORG,
        label: "Unit",
        appliesTo: ["archival_unit"],
        fields: [
          {
            key: "number",
            label: "Number",
            kind: "identifier",
            required: false,
            repeatable: false,
            visibility: "staff",
            inherited: false,
          },
        ],
      },
    ];
    const staff = ok(
      identifierTypeChanges(
        pub,
        { ...pub, pattern: "DHS-#####" },
        {
          ...existing,
          records: records.map((x) => ({ ...x, templateKey: "unit" })),
          templates,
        },
      ),
    );
    expect(staff.changes[0]?.publishedRecordIds).toEqual([]);
    expect(staff.changes[0]?.message).not.toContain("published record");

    // Without existing.published, nothing is said about published records.
    const plain = ok(
      identifierTypeChanges(pub, { ...pub, pattern: "DHS-#####" }, use([], records, [pub, BOX])),
    );
    expect(plain.changes[0]).not.toHaveProperty("publishedRecordIds");
  });

  it("refuses a published list that isn't a list of record IDs, each once", () => {
    const wide = { ...without(ACCESSION, "autoNumber"), pattern: "DHS-#{4,5}" };
    const changed = { ...wide, pattern: "DHS-#####" };
    for (const [published, code] of [
      ["nope", "not_a_list"],
      [["not-an-id"], "invalid_id"],
      [[A, A], "duplicate_id"],
    ] as const) {
      expect(
        codes(identifierTypeChanges(wide, changed, { ...use(SETS, [], [wide, BOX]), published })),
      ).toEqual([code]);
    }
  });

  it("reports values that clash under a stricter uniqueness rule", () => {
    const r = ok(identifierTypeChanges(BOX, { ...BOX, uniqueness: "current" }, use(SETS)));
    expect(summary(r)).toEqual([["uniqueness_tightened", true, [B, C]]]);
    // Compared by identifierKey: case and spaces don't hide a clash.
    const sets = [
      set(A, [{ type: "accession", value: "DHS-0001" }]),
      set(
        B,
        [{ type: "accession", value: "DHS-0002" }],
        [{ type: "accession", value: "dhs-0001" }],
      ),
      set(C, [{ type: "accession", value: "DHS-0003" }]),
    ];
    const allTime = ok(
      identifierTypeChanges(ACCESSION, { ...ACCESSION, uniqueness: "all_time" }, use(sets)),
    );
    expect(summary(allTime)).toEqual([["uniqueness_tightened", true, [A, B]]]);
    const loosened = ok(
      identifierTypeChanges(ACCESSION, { ...ACCESSION, uniqueness: "none" }, use(sets)),
    );
    expect(summary(loosened)).toEqual([["uniqueness_loosened", false, []]]);
  });

  it("reports numbers new auto-numbering would give out again, written differently", () => {
    const sets = [
      set(A, [{ type: "accession", value: "DHS-0007" }]),
      set(B, [{ type: "accession", value: "DHS-0009" }]),
    ];
    // Without the dash, DHS0001 … DHS0009 would be given out: DHS0009 looks like DHS-0009.
    const r = ok(
      identifierTypeChanges(
        ACCESSION,
        {
          ...without(ACCESSION, "pattern"),
          autoNumber: { style: "prefix", prefix: "DHS", digits: 4 },
        },
        use(sets),
      ),
    );
    expect(summary(r)).toEqual([["auto_number_changed", true, [A, B]]]);
    // Only numbers above the new form's highest are given out again.
    const free = without(ACCESSION, "pattern");
    const mixed = ok(
      identifierTypeChanges(
        free,
        { ...free, autoNumber: { style: "prefix", prefix: "DHS", digits: 4 } },
        use([...sets, set(C, [{ type: "accession", value: "DHS0008" }])], [], [free, BOX]),
      ),
    );
    expect(summary(mixed)).toEqual([["auto_number_changed", true, [B]]]);
    // More padding: nextIdentifier reads DHS-0009 as 9, nothing is given again.
    const padded = ok(
      identifierTypeChanges(
        ACCESSION,
        {
          ...without(ACCESSION, "pattern"),
          autoNumber: { style: "prefix", prefix: "DHS-", digits: 6 },
        },
        use(sets),
      ),
    );
    expect(summary(padded)).toEqual([["auto_number_changed", false, []]]);
    // A new series (another prefix) is a different number.
    const series = ok(
      identifierTypeChanges(
        ACCESSION,
        {
          ...without(ACCESSION, "pattern"),
          autoNumber: { style: "prefix", prefix: "LIB-", digits: 4 },
        },
        use(sets),
      ),
    );
    expect(summary(series)).toEqual([["auto_number_changed", false, []]]);
  });

  it("checks year numbering per year, and a former number counts", () => {
    const year: IdentifierType = {
      organizationId: ORG,
      key: "accession",
      label: "Accession number",
      uniqueness: "all_time",
      autoNumber: { style: "year", separator: ".", digits: 3 },
    };
    const sets = [
      set(A, [{ type: "accession", value: "2025.040" }]),
      set(
        B,
        [{ type: "accession", value: "2026.002" }],
        [{ type: "accession", value: "2026.015" }],
      ),
      set(C, [{ type: "accession", value: "2026-001" }]),
    ];
    const r = ok(
      identifierTypeChanges(
        year,
        { ...year, autoNumber: { style: "year", separator: "-", digits: 3 } },
        use(sets, [], [year]),
      ),
    );
    // 2026-001 is in the new form; 2026.002 and 2026.015 are above it, as is 2025.040.
    expect(summary(r)).toEqual([["auto_number_changed", true, [A, B]]]);
  });

  it("reports auto-numbering added over hand-typed numbers, and removed", () => {
    const manual = without(ACCESSION, "autoNumber", "pattern");
    const sets = [
      set(A, [{ type: "accession", value: "DHS 0005" }]),
      set(B, [{ type: "accession", value: "DHS-0003" }]),
    ];
    const added = ok(identifierTypeChanges(manual, ACCESSION, use(sets, [], [manual])));
    expect(summary(added).map((s) => s[0])).toEqual(["format_changed", "auto_number_changed"]);
    expect(added.changes[1]?.recordIds).toEqual([A]);
    const removed = ok(
      identifierTypeChanges(ACCESSION, without(ACCESSION, "autoNumber"), use(SETS)),
    );
    expect(summary(removed)).toEqual([["auto_number_changed", false, []]]);
  });

  it("reports numbers held only in template fields, which nextIdentifier doesn't count", () => {
    const manual = without(ACCESSION, "autoNumber", "pattern");
    const r = ok(
      identifierTypeChanges(
        manual,
        without(ACCESSION, "pattern"),
        use([], [record(A, { number: { type: "accession", value: "DHS-0001" } })], [manual]),
      ),
    );
    expect(summary(r)).toEqual([["auto_number_changed", true, [A]]]);
  });

  it("compares by the whole prefix, digits included, and by year then sequence", () => {
    const manual: IdentifierType = {
      organizationId: ORG,
      key: "accession",
      label: "Accession",
      uniqueness: "current",
    };
    const prefixed = {
      ...manual,
      autoNumber: { style: "prefix", prefix: "M1-", digits: 4 },
    } as const;
    const r = ok(
      identifierTypeChanges(
        manual,
        prefixed,
        use([set(A, [{ type: "accession", value: "M1 0009" }])], [], [manual]),
      ),
    );
    expect(summary(r)).toEqual([["auto_number_changed", true, [A]]]);
    const yearly = { ...manual, autoNumber: { style: "year", separator: ".", digits: 3 } } as const;
    const y = ok(
      identifierTypeChanges(
        manual,
        yearly,
        use([set(B, [{ type: "accession", value: "2026015" }])], [], [manual]),
      ),
    );
    expect(summary(y)).toEqual([["auto_number_changed", true, [B]]]);
  });

  it("checks adopted values against the type's uniqueness rule, old values included", () => {
    const r = ok(
      identifierTypeChanges(
        ACCESSION,
        { ...ACCESSION, key: "old_accession" },
        use([
          set(A, [{ type: "accession", value: "DHS-0001" }]),
          set(B, [{ type: "old_accession", value: "dhs-0001" }]),
        ]),
      ),
    );
    const adopt = r.changes.find((c) => c.code === "key_adopts_values");
    expect(adopt?.recordIds).toEqual([B]);
    expect(adopt?.clashRecordIds).toEqual([A, B]);
    // Letters in a format are case-sensitive, so "dhs-0001" doesn't fit "DHS-####".
    expect(adopt?.misfitRecordIds).toEqual([B]);
    expect(adopt?.message).toContain("1 record holds values");
  });

  it("refuses a template of another organization in the list (T-019a)", () => {
    const tpl = (organizationId: string) => ({
      key: "photos",
      label: "T",
      organizationId,
      appliesTo: ["object"],
      fields: [
        {
          key: "number",
          label: "Number",
          kind: "identifier",
          required: false,
          repeatable: false,
          visibility: "staff",
          inherited: false,
          identifierTypes: ["box"],
        },
      ],
    });
    const mine = { ...use([]), templates: [tpl(ORG)] };
    expect(identifierTypeChanges(BOX, { ...BOX, key: "carton" }, mine).ok).toBe(true);
    const mixed = { ...use([]), templates: [tpl(ORG), tpl(newOrganizationId())] };
    const r = identifierTypeChanges(BOX, { ...BOX, key: "carton" }, mixed);
    expect(r.ok ? [] : r.issues.map((i) => [i.code, i.path.join(".")])).toEqual([
      ["mixed_organizations", "existing.templates"],
    ]);
    const theirs = { ...use([]), templates: [tpl(newOrganizationId())] };
    expect(identifierTypeDeletion(BOX, theirs).ok).toBe(false);
  });

  it("reports templates naming a renamed or deleted type", () => {
    const tpl = (key: string, types: string[]) => ({
      key,
      label: "T",
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [
        {
          key: "number",
          label: "Number",
          kind: "identifier",
          required: false,
          repeatable: false,
          visibility: "staff",
          inherited: false,
          identifierTypes: types,
        },
      ],
    });
    const existing = {
      ...use([]),
      templates: [tpl("photos", ["accession", "box"]), tpl("boxes", ["box"])],
    };
    const renamed = ok(identifierTypeChanges(BOX, { ...BOX, key: "carton" }, existing));
    const refs = renamed.changes.find((c) => c.code === "templates_reference_type");
    expect([refs?.needsConfirmation, refs?.templateKeys]).toEqual([true, ["photos", "boxes"]]);
    const deleted = ok(identifierTypeDeletion(ACCESSION, existing));
    expect(deleted.changes.map((c) => [c.code, c.templateKeys])).toEqual([
      ["type_deleted", undefined],
      ["templates_reference_type", ["photos"]],
    ]);
    expect(deleted.changes[1]?.message).toContain("1 template lists");
  });

  it("doesn't count numbers that only look like the new form", () => {
    const manual: IdentifierType = {
      organizationId: ORG,
      key: "accession",
      label: "Accession",
      uniqueness: "none",
    };
    const yearly = { ...manual, autoNumber: { style: "year", separator: ".", digits: 3 } } as const;
    const y = ok(
      identifierTypeChanges(
        manual,
        yearly,
        use([set(A, [{ type: "accession", value: "123456" }])], [], [manual]),
      ),
    );
    expect(summary(y)).toEqual([["auto_number_changed", false, []]]);
    const prefixed = {
      ...manual,
      autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 },
    } as const;
    const p = ok(
      identifierTypeChanges(
        manual,
        prefixed,
        use([set(A, [{ type: "accession", value: "DHS-2026-0015" }])], [], [manual]),
      ),
    );
    expect(summary(p)).toEqual([["auto_number_changed", false, []]]);
  });

  it("without stored data, a public new type always reports made_public", () => {
    const pub = { ...BOX, public: true };
    const r = ok(identifierTypeChanges(pub, { ...pub, label: "Boxes" }));
    expect(summary(r)).toEqual([["made_public", true, []]]);
    expect(r.changes[0]?.message).toContain("wasn't checked against the stored type");
  });

  it("after a rename, checks reissues against the numbers the new key holds", () => {
    const acc = without(ACCESSION, "pattern");
    const renamed = {
      ...acc,
      key: "acc",
      autoNumber: { style: "prefix", prefix: "DHS-", digits: 5 },
    };
    const r = ok(
      identifierTypeChanges(
        acc,
        renamed,
        use(
          [
            set(A, [{ type: "accession", value: "DHS-0007" }]),
            set(B, [{ type: "acc", value: "DHS-0002" }]),
          ],
          [],
          [acc],
        ),
      ),
    );
    // nextIdentifier will count only acc's DHS-0002, then reach 7 again.
    expect(r.changes.find((c) => c.code === "auto_number_changed")?.recordIds).toEqual([A]);
  });

  it("creating a type with numbering checks adopted values for reissue", () => {
    const created: IdentifierType = {
      organizationId: ORG,
      key: "acc",
      label: "Acc",
      uniqueness: "none",
      autoNumber: { style: "prefix", prefix: "DHS", digits: 4 },
    };
    const r = ok(
      identifierTypeCreation(
        created,
        use([set(A, [{ type: "acc", value: "DHS-0009" }])], [], [BOX]),
      ),
    );
    expect(summary(r)).toEqual([
      ["key_adopts_values", true, [A]],
      ["auto_number_changed", true, [A]],
    ]);
  });

  it("making a type staff lists records holding it in public template fields", () => {
    const pub = { ...BOX, public: true };
    const tpl = (visibility: string) => ({
      key: "objects",
      label: "Objects",
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [
        {
          key: "number",
          label: "Number",
          kind: "identifier",
          required: false,
          repeatable: true,
          visibility,
          inherited: false,
        },
      ],
    });
    const records = [
      record(A, { number: [{ type: "box", value: "12" }] }),
      record(B, { other: { type: "box", value: "13" } }),
    ];
    const base = { identifierTypes: [ACCESSION, pub], identifiers: [], records };
    const withTemplates = ok(
      identifierTypeChanges(pub, BOX, { ...base, templates: [tpl("public")] }),
    );
    expect(summary(withTemplates)).toEqual([["made_staff", true, [A]]]);
    const staffOnly = ok(identifierTypeChanges(pub, BOX, { ...base, templates: [tpl("staff")] }));
    expect(summary(staffOnly)).toEqual([["made_staff", false, []]]);
    // Without templates every field counts.
    expect(summary(ok(identifierTypeChanges(pub, BOX, base)))).toEqual([
      ["made_staff", true, [A, B]],
    ]);
    expect(summary(ok(identifierTypeChanges(pub, BOX)))).toEqual([["made_staff", true, []]]);
  });

  it("making a type staff picks each record's template by its templateKey (T-012a)", () => {
    const pub = { ...BOX, public: true };
    const tpl = (key: string, visibility: string) => ({
      key,
      label: key,
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [
        {
          key: "number",
          label: "Number",
          kind: "identifier",
          required: false,
          repeatable: true,
          visibility,
          inherited: false,
        },
      ],
    });
    const value = { number: [{ type: "box", value: "12" }] };
    const records = [
      // Its own template's field is staff, though another template of its
      // kind has it public: not affected.
      { ...record(A, value), templateKey: "staff-objects" },
      // Its own template's field is public: affected.
      { ...record(B, value), templateKey: "public-objects" },
      // Its template isn't among those given: counted, to be safe.
      { ...record(C, value), templateKey: "unlisted" },
    ];
    const r = ok(
      identifierTypeChanges(pub, BOX, {
        identifierTypes: [ACCESSION, pub],
        identifiers: [],
        records,
        templates: [tpl("staff-objects", "staff"), tpl("public-objects", "public")],
      }),
    );
    expect(summary(r)).toEqual([["made_staff", true, [B, C]]]);
    // With only staff templates given, only the unlisted template's record.
    const staffOnly = ok(
      identifierTypeChanges(pub, BOX, {
        identifierTypes: [ACCESSION, pub],
        identifiers: [],
        records,
        templates: [tpl("staff-objects", "staff"), tpl("public-objects", "staff")],
      }),
    );
    expect(summary(staffOnly)).toEqual([["made_staff", true, [C]]]);
  });

  it("without records, every change that could affect records needs confirmation", () => {
    const r = ok(
      identifierTypeChanges(BOX, {
        organizationId: ORG,
        key: "carton",
        label: "Carton",
        pattern: "C-###",
        uniqueness: "all_time",
        autoNumber: { style: "prefix", prefix: "C-", digits: 3 },
        public: true,
      }),
    );
    expect(r.recordsChecked).toBe(false);
    expect(summary(r)).toEqual([
      ["key_changed", true, []],
      ["key_adopts_values", true, []],
      ["made_public", true, []],
      ["format_changed", true, []],
      ["uniqueness_tightened", true, []],
      ["auto_number_changed", true, []],
    ]);
    expect(r.needsConfirmation).toBe(true);
    expect(r.changes.every((c) => c.message.includes("weren't checked"))).toBe(true);
  });

  it("refuses an old type that isn't the one in the organization's list", () => {
    expect(codes(identifierTypeChanges({ ...BOX, label: "Crate" }, BOX, use([])))).toEqual([
      "type_not_listed",
    ]);
    expect(codes(identifierTypeChanges(ACCESSION, ACCESSION, use([], [], [BOX])))).toEqual([
      "type_not_listed",
    ]);
  });

  it("caps the listed record IDs and still counts them all", () => {
    const many = Array.from({ length: MAX_LISTED_RECORDS + 1 }, () =>
      set(newRecordId(), [{ type: "box", value: "1" }]),
    );
    const r = ok(identifierTypeChanges(BOX, { ...BOX, public: true }, use(many)));
    expect(r.changes[0]?.recordIds).toHaveLength(MAX_LISTED_RECORDS);
    expect(r.changes[0]?.recordCount).toBe(MAX_LISTED_RECORDS + 1);
  });
});

describe("identifierTypeDeletion", () => {
  it("lists the records holding values of the type", () => {
    const r = ok(identifierTypeDeletion(ACCESSION, use(SETS)));
    expect(summary(r)).toEqual([["type_deleted", true, [A, B]]]);
  });

  it("is informational when nothing uses the type, and needs confirmation when unchecked", () => {
    expect(summary(ok(identifierTypeDeletion(BOX, use([set(A, [])]))))).toEqual([
      ["type_deleted", false, []],
    ]);
    const unknown = ok(identifierTypeDeletion(BOX));
    expect(unknown.recordsChecked).toBe(false);
    expect(summary(unknown)).toEqual([["type_deleted", true, []]]);
  });
});
