// Attack tests: a mapping that tries to publish a staff-only field, or to
// trick the check into reading something other than what it returns.
import { afterEach, describe, expect, it } from "vitest";
import {
  DACS_ARCHIVAL_UNIT_PRESET,
  DACS_DUBLIN_CORE,
  presetDublinCoreMapping,
  standardPreset,
  validateDublinCoreMapping,
  type Validated,
} from "./index.js";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const STAFF_ENTRY = { field: "acquisition_source", term: "description" };

describe("Dublin Core mapping attacks", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).entries;
    delete (Object.prototype as Record<string, unknown>).visibility;
    delete (Object.prototype as Record<string, unknown>).field;
  });

  it("a Proxy mapping is refused without being read", () => {
    let reads = 0;
    const proxy = new Proxy(
      { template: "dacs-archival-unit", entries: [] },
      {
        get(target, key, receiver) {
          reads++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(codes(validateDublinCoreMapping(proxy, DACS_ARCHIVAL_UNIT_PRESET))).toEqual([
      "not_an_object",
    ]);
    expect(reads).toBe(0);
  });

  it("a getter that answers differently the second time is refused", () => {
    let calls = 0;
    const entry = {
      term: "description",
      get field() {
        calls++;
        return calls === 1 ? "date" : "acquisition_source";
      },
    };
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries: [entry] },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(result.ok).toBe(false);
  });

  it("a getter that throws is reported, not thrown", () => {
    const mapping = {
      template: "dacs-archival-unit",
      get entries(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => validateDublinCoreMapping(mapping, DACS_ARCHIVAL_UNIT_PRESET)).not.toThrow();
    expect(validateDublinCoreMapping(mapping, DACS_ARCHIVAL_UNIT_PRESET).ok).toBe(false);
  });

  it("a Proxy template fails closed", () => {
    const proxy = new Proxy(DACS_ARCHIVAL_UNIT_PRESET, {});
    expect(codes(validateDublinCoreMapping(DACS_DUBLIN_CORE, proxy))).toEqual(["invalid_template"]);
  });

  it("entries inherited from a polluted Object.prototype are not read", () => {
    (Object.prototype as Record<string, unknown>).entries = [STAFF_ENTRY];
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit" },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(codes(result)).toEqual(["required"]);
  });

  it("a polluted visibility can't make a staff field public", () => {
    (Object.prototype as Record<string, unknown>).visibility = "public";
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries: [STAFF_ENTRY] },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(codes(result)).toEqual(["staff_field"]);
  });

  it("a field inherited from a polluted prototype is not read", () => {
    (Object.prototype as Record<string, unknown>).field = "date";
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries: [{ term: "date" }] },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(codes(result)).toEqual(["invalid_field_key"]);
  });

  it("prototype keys in entries are refused", () => {
    const entry = JSON.parse('{"__proto__": {"field": "date"}, "term": "date"}') as unknown;
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries: [entry] },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(result.ok).toBe(false);
  });

  it("a hidden (non-enumerable) entry is refused", () => {
    const entries: unknown[] = [];
    Object.defineProperty(entries, "0", { value: STAFF_ENTRY, enumerable: false });
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(result.ok).toBe(false);
  });

  it("text echoed into messages is escaped", () => {
    const sneaky = "date‮evil";
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries: [{ field: "date", term: sneaky }] },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const i of result.issues) expect(i.message).not.toContain("‮");
  });

  it("an oversized mapping is refused without hanging", () => {
    const entries = Array.from({ length: 100_000 }, () => STAFF_ENTRY);
    const start = Date.now();
    const result = validateDublinCoreMapping(
      { template: "dacs-archival-unit", entries },
      DACS_ARCHIVAL_UNIT_PRESET,
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("the built-in presets and mappings can't be changed", () => {
    const preset = standardPreset("dacs-archival-unit");
    const mapping = presetDublinCoreMapping("dacs-archival-unit");
    expect(() => {
      (preset?.fields[0] as { visibility: string }).visibility = "staff";
    }).toThrow(TypeError);
    expect(() => {
      (mapping?.entries as unknown[]).push(STAFF_ENTRY);
    }).toThrow(TypeError);
  });
});
