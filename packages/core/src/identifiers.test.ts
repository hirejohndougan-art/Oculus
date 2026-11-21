import { describe, expect, it } from "vitest";
import {
  MAX_CURRENT_IDENTIFIERS,
  MAX_IDENTIFIER_LENGTH,
  MAX_IDENTIFIER_TYPES,
  checkNewIdentifier,
  droppedIdentifiers,
  findByIdentifier,
  findIdentifierConflicts,
  newRecordId,
  nextIdentifier,
  primaryIdentifier,
  retireIdentifier,
  uniquenessIssues,
  validateIdentifierType,
  validateIdentifierTypes,
  validateRecordIdentifiers,
  type IdentifierType,
  type RecordIdentifiers,
  type RecordId,
  type Validated,
} from "./index.js";

const ACCESSION: IdentifierType = {
  key: "accession_number",
  label: "Accession number",
  pattern: "####.#{3,4}",
  uniqueness: "all_time",
  autoNumber: { style: "year", separator: ".", digits: 3 },
};
const OBJECT_NO: IdentifierType = {
  key: "object_number",
  label: "Object number",
  pattern: "DHS-####",
  uniqueness: "current",
  autoNumber: { style: "prefix", prefix: "DHS-", digits: 4 },
};
const BOX: IdentifierType = { key: "box_label", label: "Box label", uniqueness: "none" };
const TYPES = [ACCESSION, OBJECT_NO, BOX];

const T = "2026-11-20T16:05:00.000Z";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function set(
  recordId: RecordId,
  current: [string, string, boolean?][],
  former: [string, string][] = [],
): RecordIdentifiers {
  return {
    recordId,
    current: current.map(([type, value, primary], i) => ({
      type,
      value,
      primary: primary ?? i === 0,
    })),
    former: former.map(([type, value]) => ({ type, value })),
  };
}

describe("validateIdentifierType", () => {
  it("accepts the two auto-numbering styles and returns a frozen copy", () => {
    for (const type of TYPES) {
      const r = validateIdentifierType(type);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value).toEqual(type);
      expect(r.value).not.toBe(type);
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });

  it.each<[Record<string, unknown>, string]>([
    [{ ...BOX, key: "Box" }, "invalid_key"],
    [{ ...BOX, key: "1box" }, "invalid_key"],
    [{ ...BOX, label: "" }, "required"],
    [{ ...BOX, label: " Box" }, "untrimmed"],
    [{ ...BOX, label: "Box\nlabel" }, "control_characters"],
    [{ ...BOX, uniqueness: "sometimes" }, "invalid_uniqueness"],
    [{ ...BOX, pattern: "#{" }, "invalid_repeat"],
    [{ ...BOX, colour: "red" }, "unknown_property"],
    [{ ...BOX, public: "yes" }, "invalid_public"],
    [{ ...BOX, public: 1 }, "invalid_public"],
    [{ ...BOX, public: null }, "invalid_public"],
    [{ ...BOX, autoNumber: "yes" }, "not_an_object"],
    [{ ...BOX, autoNumber: { style: "roman", digits: 3 } }, "invalid_style"],
    [{ ...BOX, autoNumber: { style: "year", separator: ":", digits: 3 } }, "invalid_separator"],
    [{ ...BOX, autoNumber: { style: "year", separator: ".", digits: 0 } }, "invalid_digits"],
    [{ ...BOX, autoNumber: { style: "year", separator: ".", digits: 2.5 } }, "invalid_digits"],
    [{ ...BOX, autoNumber: { style: "year", separator: ".", digits: 10 } }, "invalid_digits"],
    [
      { ...BOX, autoNumber: { style: "year", separator: ".", digits: 3, prefix: "X" } },
      "unknown_property",
    ],
    [{ ...BOX, autoNumber: { style: "prefix", prefix: "", digits: 3 } }, "required"],
    [{ ...BOX, autoNumber: { style: "prefix", prefix: "A".repeat(21), digits: 3 } }, "too_long"],
    [{ ...BOX, autoNumber: { style: "prefix", prefix: "X1", digits: 3 } }, "prefix_ends_in_digit"],
    [{ ...BOX, autoNumber: { style: "prefix", prefix: "X١", digits: 3 } }, "prefix_ends_in_digit"],
    [
      { ...BOX, autoNumber: { style: "prefix", prefix: "X\u200d-", digits: 3 } },
      "invisible_characters",
    ],
    [{ ...OBJECT_NO, pattern: "DHS####" }, "auto_number_mismatch"],
    [{ ...ACCESSION, pattern: "####-###" }, "auto_number_mismatch"],
    // A literal year would stop working next year (review fix).
    [{ ...ACCESSION, pattern: "2026.###" }, "auto_number_mismatch"],
  ])("reports %j as %s", (input, expected) => {
    expect(codes(validateIdentifierType(input))).toContain(expected);
  });

  it("allows a format that fixes only the century", () => {
    expect(validateIdentifierType({ ...ACCESSION, pattern: "20##.###" }).ok).toBe(true);
  });

  it("refuses something that isn't an object", () => {
    expect(codes(validateIdentifierType("accession"))).toEqual(["not_an_object"]);
    expect(codes(validateIdentifierType(null))).toEqual(["not_an_object"]);
  });
});

describe("identifier type visibility (D-0XX)", () => {
  it("accepts public true or false, and leaving it out", () => {
    for (const value of [true, false]) {
      const r = validateIdentifierType({ ...BOX, public: value });
      expect(r.ok && r.value.public).toBe(value);
    }
    const r = validateIdentifierType(BOX);
    expect(r.ok && Object.hasOwn(r.value, "public")).toBe(false);
  });
});

describe("validateIdentifierTypes", () => {
  it("accepts a list and reports duplicate keys", () => {
    expect(validateIdentifierTypes(TYPES).ok).toBe(true);
    const r = validateIdentifierTypes([BOX, { ...BOX, label: "Other" }]);
    expect(codes(r)).toEqual(["duplicate_key"]);
    expect(r.ok ? [] : r.issues[0]?.path).toEqual([1, "key"]);
  });

  it("reports problems inside each type with its position", () => {
    const r = validateIdentifierTypes([BOX, { ...BOX, key: "x", uniqueness: "maybe" }, 5]);
    expect(r.ok ? [] : r.issues.map((i) => [i.path, i.code])).toEqual([
      [[1, "uniqueness"], "invalid_uniqueness"],
      [[2], "not_an_object"],
    ]);
  });

  it("refuses a non-list and too many types", () => {
    expect(codes(validateIdentifierTypes({}))).toEqual(["not_a_list"]);
    const many = Array.from({ length: MAX_IDENTIFIER_TYPES + 1 }, (_, i) => ({
      ...BOX,
      key: `t${String(i)}`,
    }));
    expect(codes(validateIdentifierTypes(many))).toEqual(["too_many"]);
    expect(validateIdentifierTypes(many.slice(1)).ok).toBe(true);
  });
});

describe("validateRecordIdentifiers", () => {
  const id = newRecordId();

  it("accepts any number of identifiers with one primary, and former ones", () => {
    const input = {
      recordId: id,
      current: [
        { type: "accession_number", value: "2026.015", primary: false },
        { type: "object_number", value: "DHS-0001", primary: true },
        { type: "box_label", value: "Box 4, shelf B", primary: false },
      ],
      former: [
        { type: "accession_number", value: "75-12-3", retiredAt: T, note: "Renumbered in 2026" },
        { type: "omeka_id", value: "1234" },
      ],
    };
    const r = validateRecordIdentifiers(input, TYPES);
    expect(codes(r)).toEqual([]);
    if (!r.ok) return;
    expect(r.value).toEqual(input);
    expect(Object.isFrozen(r.value.current[0])).toBe(true);
    expect(primaryIdentifier(r.value)?.value).toBe("DHS-0001");
  });

  it("accepts a record with no identifiers yet", () => {
    const r = validateRecordIdentifiers({ recordId: id, current: [], former: [] }, TYPES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(primaryIdentifier(r.value)).toBeUndefined();
  });

  it("needs exactly one primary", () => {
    expect(codes(validateRecordIdentifiers(set(id, [["box_label", "A", false]]), TYPES))).toEqual([
      "no_primary",
    ]);
    expect(
      codes(
        validateRecordIdentifiers(
          set(id, [
            ["box_label", "A", true],
            ["box_label", "B", true],
          ]),
          TYPES,
        ),
      ),
    ).toEqual(["several_primary"]);
  });

  it("checks current identifiers against their type and format", () => {
    const r = validateRecordIdentifiers(
      set(id, [
        ["object_number", "DHS-1"],
        ["call_number", "X", false],
      ]),
      TYPES,
    );
    expect(r.ok ? [] : r.issues.map((i) => [i.path, i.code])).toEqual([
      [["current", 0, "value"], "format_mismatch"],
      [["current", 1, "type"], "unknown_type"],
    ]);
    expect(r.ok ? "" : r.issues[0]?.message).toContain("# is a digit");
  });

  it("doesn't check former identifiers against today's format", () => {
    const r = validateRecordIdentifiers(set(id, [], [["object_number", "old 17"]]), TYPES);
    expect(r.ok).toBe(true);
  });

  it("reports a current identifier twice (compared loosely) or a former one twice (exactly)", () => {
    const r = validateRecordIdentifiers(
      set(
        id,
        [
          ["box_label", "Box 4"],
          ["box_label", "box4", false],
        ],
        [
          ["omeka_id", "12"],
          ["omeka_id", "１２"],
          ["omeka_id", "12"],
        ],
      ),
      TYPES,
    );
    expect(r.ok ? [] : r.issues.map((i) => [i.path, i.code])).toEqual([
      [["current", 1, "value"], "duplicate"],
      [["former", 2, "value"], "duplicate"],
    ]);
  });

  it("allows the same value under two different types", () => {
    const r = validateRecordIdentifiers(
      set(id, [
        ["box_label", "2026.015"],
        ["accession_number", "2026.015", false],
      ]),
      TYPES,
    );
    expect(r.ok).toBe(true);
  });

  it.each<[unknown, string]>([
    ["", "required"],
    ["   ", "required"],
    [" DHS-0001", "untrimmed"],
    ["a".repeat(MAX_IDENTIFIER_LENGTH + 1), "too_long"],
    ["A\tB", "control_characters"],
    ["A\u2028B", "control_characters"],
    ["DHS-\u00ad0001", "invisible_characters"],
    ["DHS\u200d-0001", "invisible_characters"],
    ["A\u202eB", "bad_characters"],
    [7, "required"],
  ])("refuses the value %j (%s)", (value, expected) => {
    const r = validateRecordIdentifiers(
      { recordId: id, current: [{ type: "box_label", value, primary: true }], former: [] },
      TYPES,
    );
    expect(codes(r)).toContain(expected);
  });

  it("checks the shape", () => {
    expect(
      codes(validateRecordIdentifiers({ recordId: "x", current: [], former: [] }, TYPES)),
    ).toEqual(["invalid_id"]);
    expect(codes(validateRecordIdentifiers({ recordId: id }, TYPES))).toEqual([
      "not_a_list",
      "not_a_list",
    ]);
    expect(
      codes(validateRecordIdentifiers({ recordId: id, current: [], former: [], extra: 1 }, TYPES)),
    ).toEqual(["unknown_property"]);
    expect(
      codes(
        validateRecordIdentifiers(
          {
            recordId: id,
            current: [{ type: "box_label", value: "A", primary: "yes", rank: 1 }, 3],
            former: [
              { type: "Bad Type", value: "A" },
              { type: "box_label", value: "B", retiredAt: "2026-02-30T00:00:00.000Z" },
              { type: "box_label", value: "C", note: " " },
              "x",
            ],
          },
          TYPES,
        ),
      ),
    ).toEqual([
      "unknown_property",
      "invalid_primary",
      "not_an_object",
      "no_primary",
      "invalid_type",
      "invalid_timestamp",
      "required",
      "not_an_object",
    ]);
  });

  it("limits how many identifiers a record has", () => {
    const current = Array.from({ length: MAX_CURRENT_IDENTIFIERS + 1 }, (_, i) => ({
      type: "box_label",
      value: `B${String(i)}`,
      primary: i === 0,
    }));
    expect(codes(validateRecordIdentifiers({ recordId: id, current, former: [] }, TYPES))).toEqual([
      "too_many",
    ]);
  });
});

describe("uniqueness", () => {
  const a = newRecordId();
  const b = newRecordId();
  const c = newRecordId();

  it("finds nothing wrong when every value is used once", () => {
    const all = [set(a, [["object_number", "DHS-0001"]]), set(b, [["object_number", "DHS-0002"]])];
    expect(uniquenessIssues(all, TYPES)).toEqual([]);
  });

  it("'current': two records with the same current value clash, a former one doesn't", () => {
    const all = [
      set(a, [["object_number", "DHS-0001"]]),
      set(b, [["object_number", "dhs-0001"]]),
      set(c, [["box_label", "x"]], [["object_number", "DHS-0001"]]),
    ];
    const found = uniquenessIssues(all, TYPES);
    expect(found.map((i) => [i.path, i.code])).toEqual([
      [[a, "current", 0], "not_unique"],
      [[b, "current", 0], "not_unique"],
    ]);
    expect(found[0]?.message).toBe('Object number "DHS-0001" is used by 2 records.');
  });

  it("'all_time': a former value of one record clashes with another record", () => {
    const all = [
      set(a, [["accession_number", "2026.015"]]),
      set(b, [["box_label", "x"]], [["accession_number", "2026.015"]]),
    ];
    expect(uniquenessIssues(all, TYPES).map((i) => [i.path, i.code])).toEqual([
      [[a, "current", 0], "not_unique"],
      [[b, "former", 0], "not_unique"],
    ]);
  });

  it("'none': any number of records may share a value", () => {
    const all = [set(a, [["box_label", "Box 4"]]), set(b, [["box_label", "Box 4"]])];
    expect(uniquenessIssues(all, TYPES)).toEqual([]);
  });

  it("a record holding its own former value again is not a clash", () => {
    const all = [set(a, [["accession_number", "2026.015"]], [["accession_number", "2026.015"]])];
    expect(uniquenessIssues(all, TYPES)).toEqual([]);
  });

  it("findIdentifierConflicts lists the holders a new value would clash with", () => {
    const all = [
      set(a, [["accession_number", "2026.015"]]),
      set(b, [["box_label", "x"]], [["accession_number", "2026.016"]]),
    ];
    expect(
      findIdentifierConflicts({ type: "accession_number", value: "2026.015" }, c, all, TYPES),
    ).toEqual([
      {
        recordId: a,
        type: "accession_number",
        value: "2026.015",
        status: "current",
        primary: true,
      },
    ]);
    expect(
      findIdentifierConflicts({ type: "accession_number", value: "2026.016" }, c, all, TYPES),
    ).toEqual([
      {
        recordId: b,
        type: "accession_number",
        value: "2026.016",
        status: "former",
        primary: false,
      },
    ]);
    // The record itself, an unused value, a 'none' type and an unknown type: no clash.
    expect(
      findIdentifierConflicts({ type: "accession_number", value: "2026.015" }, a, all, TYPES),
    ).toEqual([]);
    expect(
      findIdentifierConflicts({ type: "accession_number", value: "2026.017" }, c, all, TYPES),
    ).toEqual([]);
    expect(findIdentifierConflicts({ type: "box_label", value: "x" }, c, all, TYPES)).toEqual([]);
    expect(findIdentifierConflicts({ type: "nope", value: "x" }, c, all, TYPES)).toEqual([]);
  });

  it("checkNewIdentifier explains every problem with a new identifier", () => {
    const all = [
      set(a, [["object_number", "DHS-0001"]]),
      set(b, [["box_label", "x"]], [["accession_number", "2026.015"]]),
    ];
    expect(checkNewIdentifier({ type: "object_number", value: "DHS-0002" }, c, all, TYPES)).toEqual(
      [],
    );
    const taken = checkNewIdentifier(
      { type: "object_number", value: "ＤＨＳ-0001" },
      c,
      all,
      TYPES,
    );
    expect(taken.map((i) => i.code)).toEqual(["format_mismatch", "not_unique"]);
    expect(taken[1]?.message).toBe(
      'Object number "ＤＨＳ-0001" is already used by another record.',
    );
    const retired = checkNewIdentifier(
      { type: "accession_number", value: "2026.015" },
      c,
      all,
      TYPES,
    );
    expect(retired[0]?.message).toContain("never reused");
    expect(
      checkNewIdentifier({ type: "nope", value: "1" }, c, all, TYPES).map((i) => i.code),
    ).toEqual(["unknown_type"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: " 1" }, c, all, TYPES).map((i) => i.code),
    ).toEqual(["untrimmed"]);
    expect(
      checkNewIdentifier({ type: "box_label", value: "1", primary: true }, c, all, TYPES).map(
        (i) => i.code,
      ),
    ).toEqual(["unknown_property"]);
    expect(checkNewIdentifier("DHS-0002", c, all, TYPES).map((i) => i.code)).toEqual([
      "not_an_object",
    ]);
  });
});

describe("findByIdentifier", () => {
  const a = newRecordId();
  const b = newRecordId();
  const all = [
    set(a, [
      ["object_number", "DHS-0001"],
      ["box_label", "Box 4", false],
    ]),
    set(
      b,
      [["object_number", "DHS-0002"]],
      [
        ["object_number", "DHS-0001"],
        ["omeka_id", "77"],
      ],
    ),
  ];

  it("finds current and former holders, current first", () => {
    expect(findByIdentifier("DHS-0001", all)).toEqual([
      { recordId: a, type: "object_number", value: "DHS-0001", status: "current", primary: true },
      { recordId: b, type: "object_number", value: "DHS-0001", status: "former", primary: false },
    ]);
    expect(findByIdentifier("77", all).map((m) => m.recordId)).toEqual([b]);
  });

  it("ignores case, spaces and lookalikes in the query", () => {
    expect(findByIdentifier(" dhs \u2013 0002 ", all).map((m) => m.recordId)).toEqual([b]);
    expect(findByIdentifier("ВОХ4", all).map((m) => m.value)).toEqual(["Box 4"]);
  });

  it("can be limited to one type, or to current identifiers", () => {
    expect(
      findByIdentifier("DHS-0001", all, { includeFormer: false }).map((m) => m.recordId),
    ).toEqual([a]);
    expect(findByIdentifier("Box 4", all, { type: "object_number" })).toEqual([]);
    expect(findByIdentifier("Box 4", all, { type: "box_label" })).toHaveLength(1);
  });

  it("finds nothing for bad queries", () => {
    expect(findByIdentifier("", all)).toEqual([]);
    expect(findByIdentifier("   ", all)).toEqual([]);
    expect(findByIdentifier(42, all)).toEqual([]);
    expect(findByIdentifier("x".repeat(1001), all)).toEqual([]);
    expect(findByIdentifier("DHS-9999", all)).toEqual([]);
  });

  it("returns frozen results", () => {
    const found = findByIdentifier("DHS-0001", all);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0])).toBe(true);
  });
});

describe("nextIdentifier", () => {
  const a = newRecordId();
  const b = newRecordId();

  it("year-based: one more than the highest number this year, padded", () => {
    const all = [
      set(a, [["accession_number", "2026.014"]], [["accession_number", "2025.300"]]),
      set(b, [["accession_number", "2026.009"]]),
    ];
    expect(nextIdentifier(ACCESSION, all, { year: 2026 })).toEqual({ ok: true, value: "2026.015" });
  });

  it("year-based: restarts at 1 each year", () => {
    const all = [set(a, [["accession_number", "2026.014"]])];
    expect(nextIdentifier(ACCESSION, all, { year: 2027 })).toEqual({ ok: true, value: "2027.001" });
    expect(nextIdentifier(ACCESSION, [], { year: 2026 })).toEqual({ ok: true, value: "2026.001" });
  });

  it("year-based: needs a four-digit year", () => {
    for (const year of [undefined, 999, 10000, 2026.5, Number.NaN]) {
      expect(codes(nextIdentifier(ACCESSION, [], year === undefined ? {} : { year }))).toEqual([
        "year_required",
      ]);
    }
  });

  it("prefix: counts current and former numbers, so retired ones are never reused", () => {
    const all = [
      set(a, [["object_number", "DHS-0007"]]),
      set(b, [["object_number", "DHS-0002"]], [["object_number", "DHS-0012"]]),
    ];
    expect(nextIdentifier(OBJECT_NO, all)).toEqual({ ok: true, value: "DHS-0013" });
  });

  it("prefix: reads numbers typed loosely or padded differently", () => {
    const all = [
      set(a, [["object_number", "dhs-21"]]),
      set(b, [["object_number", "ＤＨＳ－００３０"]]),
    ];
    expect(nextIdentifier(OBJECT_NO, all)).toEqual({ ok: true, value: "DHS-0031" });
  });

  it("ignores other types and values of another form", () => {
    const all = [
      set(a, [
        ["box_label", "DHS-0900"],
        ["object_number", "DHS-12A", false],
        ["object_number", "DHS-", false],
        ["object_number", "OLD-0500", false],
      ]),
    ];
    expect(nextIdentifier(OBJECT_NO, all)).toEqual({ ok: true, value: "DHS-0001" });
  });

  it("refuses when the next number won't fit the format", () => {
    const all = [set(a, [["object_number", "DHS-9999"]])];
    const r = nextIdentifier(OBJECT_NO, all);
    expect(codes(r)).toEqual(["pattern_full"]);
    // Without a format, numbers simply get wider.
    const open: IdentifierType = { ...OBJECT_NO };
    delete (open as { pattern?: string }).pattern;
    expect(nextIdentifier(open, all)).toEqual({ ok: true, value: "DHS-10000" });
  });

  it("ignores numbers the format could never give out (review fix)", () => {
    const all = [
      set(a, [["object_number", "DHS-0041"]], [["object_number", "DHS-0001000000"]]),
      set(b, [["object_number", "DHS-0005"]], [["object_number", "DHS-00050"]]),
    ];
    // 1000000 can't be written as DHS-####, so it can never clash; 50 can.
    expect(nextIdentifier(OBJECT_NO, all)).toEqual({ ok: true, value: "DHS-0051" });
  });

  it("a number past the limit can't make a type without a format run out (review fix)", () => {
    const rest: IdentifierType = { ...OBJECT_NO };
    delete (rest as { pattern?: string }).pattern;
    const all = [set(a, [["object_number", "DHS-12"]], [["object_number", "DHS-9999999999999"]])];
    expect(nextIdentifier(rest, all)).toEqual({ ok: true, value: "DHS-0013" });
  });

  it("says which number filled the format", () => {
    const r = nextIdentifier(OBJECT_NO, [set(a, [["object_number", "DHS-9999"]])]);
    expect(r.ok ? "" : r.issues[0]?.message).toBe(
      'The next Object number after "DHS-9999" would be "DHS-10000", which doesn\'t fit the format "DHS-####".',
    );
  });

  it("refuses when the numbers run out, and for types without auto-numbering", () => {
    const open: IdentifierType = { ...OBJECT_NO, pattern: "DHS-#{1,15}" };
    const all = [set(a, [["object_number", "DHS-999999999999"]])];
    expect(codes(nextIdentifier(open, all))).toEqual(["numbers_exhausted"]);
    expect(codes(nextIdentifier(BOX, all))).toEqual(["no_auto_number"]);
  });
});

describe("retireIdentifier", () => {
  const id = newRecordId();
  const start = set(id, [
    ["object_number", "DHS-0001", true],
    ["box_label", "Box 4", false],
    ["accession_number", "2026.015", false],
  ]);

  it("moves an identifier to the former list, with when and why", () => {
    const r = retireIdentifier(
      start,
      { type: "box_label", value: "Box 4" },
      { retiredAt: T, note: "Moved to box 9" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.current.map((i) => i.value)).toEqual(["DHS-0001", "2026.015"]);
    expect(r.value.former).toEqual([
      { type: "box_label", value: "Box 4", retiredAt: T, note: "Moved to box 9" },
    ]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(droppedIdentifiers(start, r.value)).toEqual([]);
    expect(findByIdentifier("Box 4", [r.value])[0]?.status).toBe("former");
  });

  it("won't pick a new primary silently", () => {
    expect(codes(retireIdentifier(start, { type: "object_number", value: "DHS-0001" }))).toEqual([
      "primary_needed",
    ]);
    const r = retireIdentifier(
      start,
      { type: "object_number", value: "DHS-0001" },
      { newPrimary: { type: "accession_number", value: "2026.015" } },
    );
    expect(r.ok && primaryIdentifier(r.value)?.value).toBe("2026.015");
    expect(r.ok && r.value.current.filter((i) => i.primary)).toHaveLength(1);
  });

  it("can move the primary mark while retiring another identifier", () => {
    const r = retireIdentifier(
      start,
      { type: "box_label", value: "Box 4" },
      { newPrimary: { type: "accession_number", value: "2026.015" } },
    );
    expect(r.ok && r.value.current.map((i) => i.primary)).toEqual([false, true]);
  });

  it("retiring the last identifier leaves none current", () => {
    const one = set(id, [["object_number", "DHS-0001"]]);
    const r = retireIdentifier(one, { type: "object_number", value: "DHS-0001" });
    expect(r.ok && r.value.current).toEqual([]);
    expect(r.ok && r.value.former).toEqual([{ type: "object_number", value: "DHS-0001" }]);
  });

  it("keeps a differently spelled former entry and adds this exact one (review fix)", () => {
    // Found by the independent review: a loose match used to swallow the
    // retired value and its note.
    const again = set(
      id,
      [
        ["object_number", "dhs-0001", true],
        ["object_number", "DHS-0002", false],
      ],
      [["object_number", "DHS-0001"]],
    );
    const r = retireIdentifier(
      again,
      { type: "object_number", value: "dhs-0001" },
      { note: "Typed in lower case", newPrimary: { type: "object_number", value: "DHS-0002" } },
    );
    expect(r.ok && r.value.former).toEqual([
      { type: "object_number", value: "DHS-0001" },
      { type: "object_number", value: "dhs-0001", note: "Typed in lower case" },
    ]);
    expect(r.ok && droppedIdentifiers(again, r.value)).toEqual([]);
    expect(r.ok && validateRecordIdentifiers(r.value, TYPES).ok).toBe(true);
  });

  it("merges into an exact former entry: newest date, both notes", () => {
    const again: RecordIdentifiers = {
      recordId: id,
      current: [{ type: "object_number", value: "DHS-0001", primary: true }],
      former: [{ type: "object_number", value: "DHS-0001", retiredAt: T, note: "First time" }],
    };
    const later = "2027-01-05T10:00:00.000Z";
    const r = retireIdentifier(
      again,
      { type: "object_number", value: "DHS-0001" },
      { retiredAt: later, note: "Second time" },
    );
    expect(r.ok && r.value.former).toEqual([
      {
        type: "object_number",
        value: "DHS-0001",
        retiredAt: later,
        note: "First time\nSecond time",
      },
    ]);
    expect(r.ok && droppedIdentifiers(again, r.value)).toEqual([]);
    const plain = retireIdentifier(again, { type: "object_number", value: "DHS-0001" });
    expect(plain.ok && plain.value.former).toEqual(again.former);
    const long = retireIdentifier(
      again,
      { type: "object_number", value: "DHS-0001" },
      { note: "x".repeat(995) },
    );
    expect(codes(long)).toEqual(["too_long"]);
  });

  it("refuses a note with hidden or broken characters (review fix)", () => {
    for (const note of ["x\u202e", "x\u0000", "x\ud800"]) {
      expect(
        codes(retireIdentifier(start, { type: "box_label", value: "Box 4" }, { note })),
      ).toEqual(["bad_characters"]);
    }
  });

  it("reports what it can't do", () => {
    expect(codes(retireIdentifier(start, { type: "box_label", value: "box 4" }))).toEqual([
      "not_found",
    ]);
    expect(
      codes(
        retireIdentifier(
          start,
          { type: "box_label", value: "Box 4" },
          { newPrimary: { type: "box_label", value: "Box 4" } },
        ),
      ),
    ).toEqual(["not_found"]);
    expect(
      codes(retireIdentifier(start, { type: "box_label", value: "Box 4" }, { retiredAt: "today" })),
    ).toEqual(["invalid_timestamp"]);
    expect(
      codes(retireIdentifier(start, { type: "box_label", value: "Box 4" }, { note: "" })),
    ).toEqual(["required"]);
  });

  it("doesn't change the object it was given", () => {
    retireIdentifier(start, { type: "box_label", value: "Box 4" });
    expect(start.current).toHaveLength(3);
    expect(start.former).toHaveLength(0);
  });
});

describe("droppedIdentifiers", () => {
  const id = newRecordId();

  it("lists every identifier that a change would lose", () => {
    const before = set(id, [["object_number", "DHS-0001"]], [["omeka_id", "77"]]);
    const after = set(id, [["object_number", "DHS-0002"]]);
    expect(droppedIdentifiers(before, after)).toEqual([
      { type: "object_number", value: "DHS-0001", lost: "identifier" },
      { type: "omeka_id", value: "77", lost: "identifier" },
    ]);
  });

  it("counts an exact copy kept as current or former as kept, but not a respelled one", () => {
    const before = set(id, [["object_number", "DHS-0001"]]);
    expect(droppedIdentifiers(before, set(id, [], [["object_number", "DHS-0001"]]))).toEqual([]);
    expect(droppedIdentifiers(before, set(id, [["object_number", "dhs-0001"]]))).toEqual([
      { type: "object_number", value: "DHS-0001", lost: "identifier" },
    ]);
  });

  it("reports a former entry whose date or note was lost (review fix)", () => {
    const later = "2027-01-05T10:00:00.000Z";
    const before: RecordIdentifiers = {
      recordId: id,
      current: [],
      former: [{ type: "omeka_id", value: "77", retiredAt: T, note: "Old site" }],
    };
    const after = (f: { retiredAt?: string; note?: string }): RecordIdentifiers => ({
      recordId: id,
      current: [],
      former: [{ type: "omeka_id", value: "77", ...f }],
    });
    expect(droppedIdentifiers(before, after({}))).toEqual([
      { type: "omeka_id", value: "77", lost: "history" },
    ]);
    expect(droppedIdentifiers(before, after({ retiredAt: T }))).toHaveLength(1);
    expect(droppedIdentifiers(before, after({ note: "Old site" }))).toHaveLength(1);
    expect(droppedIdentifiers(before, after({ retiredAt: T, note: "Other" }))).toHaveLength(1);
    expect(
      droppedIdentifiers(
        before,
        after({ retiredAt: "2020-01-01T00:00:00.000Z", note: "Old site" }),
      ),
    ).toHaveLength(1);
    // What retireIdentifier does on a second retirement is not a loss.
    expect(
      droppedIdentifiers(before, after({ retiredAt: later, note: "Old site\nAgain" })),
    ).toEqual([]);
  });
});
