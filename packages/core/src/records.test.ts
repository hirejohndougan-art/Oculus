import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_DEPTH,
  MAX_FIELD_ENTRIES,
  MAX_STRING_LENGTH,
  MAX_TITLE_LENGTH,
  RECORD_KINDS,
  createRecord,
  isTemplateKey,
  newRecordId,
  validateRecord,
  type Issue,
  type Validated,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const OTHER = "9b2e4c1a-7d3f-4e8a-b5c6-1a2b3c4d5e6f";
const T = "2026-11-20T16:05:00.000Z";

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: "Dickinson Station and Park",
    organizationId: ORG,
    createdAt: T,
    updatedAt: T,
    fields: {},
    ...extra,
  };
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i: Issue) => i.code);
}

function paths(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i: Issue) => i.path.join("."));
}

describe("validateRecord: each kind", () => {
  it.each([
    ["object", {}],
    ["event", {}],
    ["archival_unit", { level: "item" }],
    ["archival_unit", { level: "series", parentId: OTHER }],
    ["digital_asset", { mediaType: "image/tiff" }],
    ["digital_asset", { mediaType: "audio/wav", represents: OTHER }],
    ["agent", { agentType: "organization" }],
    ["place", {}],
    ["place", { coordinates: { lat: 29.46, lng: -95.05 } }],
  ])("accepts a valid %s", (kind, extra) => {
    const result = validateRecord(base({ kind, ...extra }));
    expect(codes(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("covers every kind in RECORD_KINDS", () => {
    expect([...RECORD_KINDS].sort()).toEqual(
      ["agent", "archival_unit", "digital_asset", "event", "object", "place"].sort(),
    );
  });

  it("returns the record unchanged", () => {
    const input = base({ kind: "object", fields: { date: "1909" } });
    const result = validateRecord(input);
    expect(result.ok && result.value).toEqual(input);
  });

  it.each([
    ["missing kind", base()],
    ["unknown kind", base({ kind: "collection" })],
  ])("rejects %s", (_label, input) => {
    expect(codes(validateRecord(input))).toEqual(["invalid_kind"]);
  });

  it.each([null, undefined, "record", 7, [], new Date()])("rejects non-object %j", (input) => {
    expect(codes(validateRecord(input))).toEqual(["not_an_object"]);
  });

  it("rejects a missing level on an archival unit", () => {
    expect(codes(validateRecord(base({ kind: "archival_unit" })))).toEqual(["invalid_level"]);
  });

  it("rejects an unknown level", () => {
    expect(codes(validateRecord(base({ kind: "archival_unit", level: "subfonds" })))).toEqual([
      "invalid_level",
    ]);
  });

  it("rejects a unit filed under itself", () => {
    const r = validateRecord(base({ kind: "archival_unit", level: "file", parentId: ID }));
    expect(codes(r)).toEqual(["self_reference"]);
  });

  it("rejects a malformed parentId", () => {
    const r = validateRecord(base({ kind: "archival_unit", level: "file", parentId: "12" }));
    expect(codes(r)).toEqual(["invalid_id"]);
  });

  it.each(["Image/TIFF", "image", "image/tiff; charset=x", "", "image/ tiff", 42])(
    "rejects media type %j",
    (mediaType) => {
      expect(codes(validateRecord(base({ kind: "digital_asset", mediaType })))).toEqual([
        "invalid_media_type",
      ]);
    },
  );

  it("rejects a file that represents itself", () => {
    const r = validateRecord(
      base({ kind: "digital_asset", mediaType: "image/jpeg", represents: ID }),
    );
    expect(codes(r)).toEqual(["self_reference"]);
  });

  it("reports a property set to undefined", () => {
    expect(codes(validateRecord(base({ kind: "agent", agentType: undefined })))).toEqual([
      "undefined_value",
    ]);
  });

  it.each(["corporation", "Person", 3])("rejects agent type %j", (agentType) => {
    expect(codes(validateRecord(base({ kind: "agent", agentType })))).toEqual([
      "invalid_agent_type",
    ]);
  });

  it.each([
    [{ lat: 91, lng: 0 }, ["coordinates.lat"]],
    [{ lat: 0, lng: -181 }, ["coordinates.lng"]],
    [{ lat: Number.NaN, lng: 0 }, ["coordinates.lat"]],
    [{ lat: "29.4", lng: 0 }, ["coordinates.lat"]],
    [{ lat: 0 }, ["coordinates.lng"]],
    [{ lat: 0, lng: 0, alt: 3 }, ["coordinates.alt"]],
    ["29.4,-95.0", ["coordinates"]],
  ])("rejects coordinates %j", (coordinates, expected) => {
    expect(paths(validateRecord(base({ kind: "place", coordinates })))).toEqual(expected);
  });

  it("accepts coordinates on the edges", () => {
    const r = validateRecord(base({ kind: "place", coordinates: { lat: -90, lng: 180 } }));
    expect(r.ok).toBe(true);
  });
});

describe("validateRecord: common properties", () => {
  it("rejects properties that don't belong to the kind", () => {
    const r = validateRecord(base({ kind: "object", level: "item", notes: "x" }));
    expect(codes(r)).toEqual(["unknown_property", "unknown_property"]);
    expect(paths(r)).toEqual(["level", "notes"]);
  });

  it("rejects a bad or missing ID", () => {
    expect(codes(validateRecord(base({ kind: "object", id: "DHS-0001" })))).toEqual(["invalid_id"]);
    const noId = base({ kind: "object" });
    delete noId.id;
    expect(codes(validateRecord(noId))).toEqual(["invalid_id"]);
  });

  it.each([
    ["undefined", undefined, "undefined_value"],
    ["a number", 42, "required"],
    ["empty", "", "required"],
    ["only spaces", "   ", "required"],
    ["leading space", " Depot", "untrimmed"],
    ["a line break", "Depot\nMove", "control_characters"],
    ["a null byte", "Depot\u0000", "bad_characters"],
    ["a tab", "Depot\tMove", "control_characters"],
    ["a line separator", "Depot\u2028Move", "control_characters"],
    ["a C1 control", "Depot\u0085", "bad_characters"],
    ["a direction override", "Depot\u202eevoM", "bad_characters"],
    ["a lone surrogate", "Depot\ud800", "bad_characters"],
    ["too long", "x".repeat(MAX_TITLE_LENGTH + 1), "too_long"],
  ])("rejects a title that is %s", (_label, title, code) => {
    expect(codes(validateRecord(base({ kind: "object", title })))).toContain(code);
  });

  it("accepts a title at the length limit, with accents and dashes", () => {
    expect(
      validateRecord(base({ kind: "object", title: "é–".repeat(MAX_TITLE_LENGTH / 2) })).ok,
    ).toBe(true);
  });

  it.each([
    "2026-11-20",
    "2026-11-20T16:05:00",
    "2026-11-20T16:05:00+00:00",
    "2026-11-20T24:00:00.000Z",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "Nov 20 2026",
    1763654700000,
  ])("rejects timestamp %j", (createdAt) => {
    expect(
      codes(validateRecord(base({ kind: "object", createdAt, updatedAt: createdAt }))),
    ).toEqual(["invalid_timestamp", "invalid_timestamp"]);
  });

  it.each(["2026-11-20T16:05:00Z", "2026-11-20T16:05:00.5Z", "2026-11-20T16:05:00.50Z"])(
    "accepts only the one canonical spelling, not %j",
    (stamp) => {
      expect(
        codes(validateRecord(base({ kind: "object", createdAt: stamp, updatedAt: stamp }))),
      ).toEqual(["invalid_timestamp", "invalid_timestamp"]);
    },
  );

  it("rejects updatedAt before createdAt", () => {
    const r = validateRecord(base({ kind: "object", updatedAt: "2026-11-20T16:04:59.999Z" }));
    expect(codes(r)).toEqual(["before_created"]);
  });

  it("reports every problem at once", () => {
    const r = validateRecord({ kind: "agent", id: "x", title: "", fields: [], extra: 1 });
    expect(codes(r).sort()).toEqual(
      [
        "invalid_agent_type",
        "invalid_id",
        "invalid_organization",
        "invalid_timestamp",
        "invalid_timestamp",
        "not_an_object",
        "required",
        "unknown_property",
      ].sort(),
    );
  });
});

describe("validateRecord: template-defined fields", () => {
  it("accepts nested JSON values", () => {
    const fields = {
      date: "1909",
      subjects: ["Railroad stations", "Parks"],
      dimensions: { width_in: 10, height_in: 8, framed: false, note: null },
    };
    expect(validateRecord(base({ kind: "object", fields })).ok).toBe(true);
  });

  it("rejects an empty field key", () => {
    expect(codes(validateRecord(base({ kind: "object", fields: { "": "x" } })))).toEqual([
      "invalid_key",
    ]);
  });

  it.each(["Date", "1date", "date-made", "_private", "x".repeat(65)])(
    "rejects field key %j",
    (key) => {
      expect(codes(validateRecord(base({ kind: "object", fields: { [key]: "x" } })))).toEqual([
        "invalid_field_key",
      ]);
    },
  );

  it.each([
    ["a function", () => 1],
    ["a nested undefined", [undefined]],
    ["a date object", new Date(0)],
    ["a class instance", new Map()],
    ["a symbol", Symbol("x")],
    ["a bigint", 10n],
  ])("rejects a field value that is %s", (_label, value) => {
    expect(codes(validateRecord(base({ kind: "object", fields: { note: value } })))).toEqual([
      "not_json",
    ]);
  });

  it("reports a field set to undefined", () => {
    expect(codes(validateRecord(base({ kind: "object", fields: { note: undefined } })))).toEqual([
      "undefined_value",
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects number %s", (value) => {
    expect(codes(validateRecord(base({ kind: "object", fields: { count: value } })))).toEqual([
      "not_finite",
    ]);
  });

  it("rejects text longer than the limit", () => {
    const r = validateRecord(
      base({ kind: "object", fields: { note: "x".repeat(MAX_STRING_LENGTH + 1) } }),
    );
    expect(codes(r)).toEqual(["too_long"]);
  });

  it("rejects nesting deeper than the limit, and accepts it at the limit", () => {
    const nest = (levels: number): unknown => (levels === 1 ? "leaf" : { inner: nest(levels - 1) });
    expect(validateRecord(base({ kind: "object", fields: { a: nest(MAX_FIELD_DEPTH) } })).ok).toBe(
      true,
    );
    expect(
      codes(validateRecord(base({ kind: "object", fields: { a: nest(MAX_FIELD_DEPTH + 1) } }))),
    ).toEqual(["too_deep"]);
  });

  it("stops counting after too many values, with one issue", () => {
    const r = validateRecord(
      base({
        kind: "object",
        fields: { list: Array.from({ length: MAX_FIELD_ENTRIES + 50 }, () => 1) },
      }),
    );
    expect(codes(r)).toEqual(["too_many_values"]);
  });

  // Attacks: prototype pollution through keys that JSON.parse creates as own properties.
  it.each(['{"__proto__": {"isAdmin": true}}', '{"constructor": {"prototype": {"x": 1}}}'])(
    "refuses prototype keys inside a field value: %s",
    (json) => {
      const fields = { note: JSON.parse(json) as unknown };
      const r = validateRecord(base({ kind: "object", fields }));
      expect(codes(r)).toEqual(["forbidden_key"]);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    },
  );

  it.each(["__proto__", "constructor", "prototype"])(
    "refuses %s as a top-level field key",
    (key) => {
      const fields = JSON.parse(`{"${key}": {"polluted": true}}`) as unknown;
      expect(codes(validateRecord(base({ kind: "object", fields })))).toEqual(["forbidden_key"]);
    },
  );

  it("refuses __proto__ as a record property", () => {
    const input = JSON.parse(
      `{"kind":"object","id":"${ID}","title":"x","createdAt":"${T}","updatedAt":"${T}","fields":{},"__proto__":{"admin":true}}`,
    ) as unknown;
    expect(codes(validateRecord(input))).toEqual(["forbidden_key"]);
  });

  it("accepts an object with no prototype", () => {
    const fields = Object.assign(Object.create(null) as Record<string, unknown>, { date: "1909" });
    expect(validateRecord(base({ kind: "object", fields })).ok).toBe(true);
  });
});

describe("createRecord", () => {
  const now = new Date("2026-11-20T16:05:00.000Z");

  it("adds a fresh ID, matching timestamps and empty fields", () => {
    const r = createRecord(
      {
        organizationId: ORG,
        kind: "agent",
        title: "Galveston, Houston and Henderson Railroad",
        agentType: "organization",
      },
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.createdAt).toBe("2026-11-20T16:05:00.000Z");
    expect(r.value.updatedAt).toBe(r.value.createdAt);
    expect(r.value.fields).toEqual({});
    expect(r.value.kind).toBe("agent");
  });

  it("makes a different ID each time", () => {
    const a = createRecord({ organizationId: ORG, kind: "object", title: "Plow" }, now);
    const b = createRecord({ organizationId: ORG, kind: "object", title: "Plow" }, now);
    expect(a.ok && b.ok && a.value.id !== b.value.id).toBe(true);
  });

  it("keeps the fields it was given", () => {
    const r = createRecord(
      {
        organizationId: ORG,
        kind: "archival_unit",
        title: "Loading Strawberries",
        level: "item",
        fields: { date: "1909-04-25" },
      },
      now,
    );
    expect(r.ok && r.value.fields).toEqual({ date: "1909-04-25" });
  });

  it("still validates, and doesn't let input replace the ID or timestamps", () => {
    const sneaky = {
      kind: "object",
      title: "Plow",
      id: ID,
      organizationId: ORG,
      createdAt: "2000-01-01T00:00:00Z",
    } as never;
    const r = createRecord(sneaky, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).not.toBe(ID);
    expect(r.value.createdAt).toBe("2026-11-20T16:05:00.000Z");
  });

  it("reports problems instead of making a bad record", () => {
    const r = createRecord({ organizationId: ORG, kind: "object", title: "  " }, now);
    expect(codes(r)).toEqual(["required"]);
  });

  it("uses the current time by default", () => {
    const before = Date.now();
    const r = createRecord({ organizationId: ORG, kind: "event", title: "The Galveston Storm" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Date.parse(r.value.createdAt)).toBeGreaterThanOrEqual(before - 1);
    expect(newRecordId()).not.toBe(r.ok ? r.value.id : "");
  });
});

describe("templateKey (D-029)", () => {
  it("keeps the key of the template a record follows", () => {
    const r = validateRecord(base({ kind: "object", templateKey: "spectrum-object" }));
    expect(r.ok && r.value.templateKey).toBe("spectrum-object");
  });

  it("is optional, for records stored before records named their template", () => {
    const r = validateRecord(base({ kind: "object" }));
    expect(r.ok).toBe(true);
    expect(r.ok && "templateKey" in r.value).toBe(false);
  });

  it("takes the same keys validateTemplate takes for a template", () => {
    expect(isTemplateKey("a")).toBe(true);
    expect(isTemplateKey("dacs_file-2")).toBe(true);
    expect(isTemplateKey(`a${"b".repeat(63)}`)).toBe(true);
    for (const bad of ["", "A", "1a", "-a", "a b", "a.b", `a${"b".repeat(64)}`, " a", "a\n"]) {
      expect(isTemplateKey(bad)).toBe(false);
      expect(codes(validateRecord(base({ kind: "object", templateKey: bad })))).toEqual([
        "invalid_template_key",
      ]);
    }
  });

  it("refuses a template key that isn't text", () => {
    for (const bad of [1, true, null, ["a"], { key: "a" }]) {
      expect(codes(validateRecord(base({ kind: "event", templateKey: bad })))).toEqual([
        "invalid_template_key",
      ]);
    }
  });

  it("is set by createRecord", () => {
    const r = createRecord({
      organizationId: ORG,
      kind: "object",
      title: "Chair",
      templateKey: "objects",
    });
    expect(r.ok && r.value.templateKey).toBe("objects");
    expect(
      codes(
        createRecord({
          organizationId: ORG,
          kind: "object",
          title: "Chair",
          templateKey: "Objects",
        }),
      ),
    ).toEqual(["invalid_template_key"]);
  });
});
