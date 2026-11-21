import { describe, expect, it } from "vitest";
import {
  MAX_LISTED_RECORDS,
  identifierTypeChanges,
  identifierTypeDeletion,
  newRecordId,
  type IdentifierType,
  type IdentifierTypeChanges,
  type Validated,
} from "./index.js";

// Invented sample data.
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const C = "5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const ACCESSION: IdentifierType = {
  key: "accession",
  label: "Accession number",
  pattern: "DHS-####",
  uniqueness: "current",
  autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 },
};
const BOX: IdentifierType = { key: "box", label: "Box", uniqueness: "none" };

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
    current: current.map((c, i) => ({ ...c, primary: i === 0 })),
    former,
  };
}

function record(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { kind: "object", id, title: "Postcard", createdAt: T, updatedAt: T, fields };
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
    expect(summary(back)).toEqual([["made_staff", false, []]]);
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

  it("without records, every change that could affect records needs confirmation", () => {
    const r = ok(
      identifierTypeChanges(BOX, {
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
