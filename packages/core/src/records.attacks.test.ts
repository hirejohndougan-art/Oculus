// Attacks found by the independent review of T-002. Each test tries one; each
// must be refused or neutralized, and validateRecord must never throw.
import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_ENTRIES,
  MAX_RECORD_CHARS,
  MAX_STRING_LENGTH,
  createRecord,
  validateRecord,
  type Issue,
  type Validated,
} from "./index.js";

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const T = "2026-11-20T16:05:00.000Z";

function valid(): Record<string, unknown> {
  return { kind: "object", id: ID, title: "Chair", createdAt: T, updatedAt: T, fields: {} };
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i: Issue) => i.code);
}

describe("the returned record is a frozen copy", () => {
  it("is not the caller's object, and later changes to the input don't reach it", () => {
    const input = valid();
    input.fields = { note: "original" };
    const r = validateRecord(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toBe(input);
    (input as { title: string }).title = "\u0000<script>";
    (input.fields as Record<string, string>).note = "changed";
    input.evil = 1;
    expect(r.value.title).toBe("Chair");
    expect(r.value.fields.note).toBe("original");
    expect("evil" in r.value).toBe(false);
  });

  it("is deeply frozen", () => {
    const r = validateRecord({ ...valid(), fields: { list: [{ a: 1 }] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.fields)).toBe(true);
    const list = r.value.fields.list as readonly unknown[];
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
  });

  it("createRecord doesn't keep the caller's fields object", () => {
    const fields: Record<string, string> = { date: "1909" };
    const r = createRecord({ kind: "object", title: "Chair", fields });
    fields.date = "changed";
    expect(r.ok && r.value.fields.date).toBe("1909");
  });

  it("createRecord reports an invalid time instead of throwing", () => {
    expect(codes(createRecord({ kind: "object", title: "Chair" }, new Date(Number.NaN)))).toEqual([
      "invalid_time",
    ]);
  });
});

describe("never throws, and refuses objects that aren't plain data", () => {
  it("refuses a getter that changes its answer", () => {
    let reads = 0;
    const input = valid();
    Object.defineProperty(input, "title", {
      enumerable: true,
      get: () => (reads++ === 0 ? "Chair" : "\u0000".repeat(5000)),
    });
    expect(codes(validateRecord(input))).toEqual(["not_plain_data"]);
  });

  it("refuses a getter that throws, on the record or deep inside fields", () => {
    const a = valid();
    Object.defineProperty(a, "title", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    expect(() => validateRecord(a)).not.toThrow();
    expect(validateRecord(a).ok).toBe(false);

    const group = {};
    Object.defineProperty(group, "x", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    expect(() => validateRecord({ ...valid(), fields: { g: group } })).not.toThrow();
    expect(codes(validateRecord({ ...valid(), fields: { g: group } }))).toEqual(["not_plain_data"]);
  });

  it("refuses Proxies, including ones that throw and revoked ones", () => {
    expect(codes(validateRecord(new Proxy(valid(), {})))).toEqual(["not_an_object"]);
    const thrower = new Proxy(valid(), {
      get() {
        throw new Error("x");
      },
    });
    expect(() => validateRecord(thrower)).not.toThrow();
    const { proxy, revoke } = Proxy.revocable(valid(), {});
    revoke();
    expect(() => validateRecord(proxy)).not.toThrow();
    expect(validateRecord(proxy).ok).toBe(false);
    expect(codes(validateRecord({ ...valid(), fields: { p: new Proxy({ a: 1 }, {}) } }))).toEqual([
      "not_plain_data",
    ]);
  });

  it("refuses a list whose forEach was replaced, so its contents can't skip checks", () => {
    const list: unknown[] = [() => 1, Number.POSITIVE_INFINITY, "x".repeat(10)];
    (list as unknown as { forEach: () => void }).forEach = () => undefined;
    expect(codes(validateRecord({ ...valid(), fields: { list } }))).toEqual(["not_plain_data"]);
  });

  it("refuses a list carrying toJSON", () => {
    const list = ["x"];
    (list as unknown as { toJSON: () => unknown }).toJSON = () => ({ evil: "\u0000" });
    expect(codes(validateRecord({ ...valid(), fields: { list } }))).toEqual(["not_plain_data"]);
  });

  it("refuses a list with a custom prototype, without throwing", () => {
    const list = Object.setPrototypeOf([1], {}) as unknown[];
    expect(() => validateRecord({ ...valid(), fields: { list } })).not.toThrow();
    expect(codes(validateRecord({ ...valid(), fields: { list } }))).toEqual(["not_plain_data"]);
  });

  it("refuses toJSON on a plain object", () => {
    const fields = { note: { toJSON: () => "x" } };
    expect(codes(validateRecord({ ...valid(), fields }))).toEqual(["not_json"]);
  });

  it("refuses hidden properties and symbol keys", () => {
    const hiddenId = valid();
    Object.defineProperty(hiddenId, "id", { value: ID, enumerable: false });
    expect(codes(validateRecord(hiddenId))).toContain("not_plain_data");

    const secret = valid();
    Object.defineProperty(secret, "secret", { value: "ssn", enumerable: false });
    expect(codes(validateRecord(secret))).toEqual(["not_plain_data"]);

    const sym = { ...valid(), [Symbol("x")]: 1 };
    expect(codes(validateRecord(sym))).toEqual(["not_plain_data"]);
  });

  it("refuses holes in a list instead of turning them into null", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the test
    expect(codes(validateRecord({ ...valid(), fields: { list: [1, , 3] } }))).toEqual(["holes"]);
  });

  it("refuses a huge sparse list quickly", () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;
    const started = performance.now();
    expect(codes(validateRecord({ ...valid(), fields: { list } }))).toEqual(["too_many_values"]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("text and size", () => {
  it.each([
    ["a null byte", "a\u0000b"],
    ["a lone high surrogate", "x\ud800"],
    ["a lone low surrogate", "\udc00x"],
    ["a C1 control", "a\u0085b"],
    ["a direction override", "a‮b"],
  ])("refuses field text with %s", (_label, note) => {
    expect(codes(validateRecord({ ...valid(), fields: { note } }))).toEqual(["bad_characters"]);
  });

  it("keeps line breaks and tabs in field text, and real emoji", () => {
    const note = "Line one\nLine two\r\n\tIndented 🚂";
    const r = validateRecord({ ...valid(), fields: { note } });
    expect(r.ok && r.value.fields.note).toBe(note);
  });

  it("refuses nested keys that are empty, too long or contain control characters", () => {
    expect(codes(validateRecord({ ...valid(), fields: { a: { "": 1 } } }))).toEqual([
      "invalid_key",
    ]);
    expect(codes(validateRecord({ ...valid(), fields: { a: { ["k".repeat(201)]: 1 } } }))).toEqual([
      "invalid_key",
    ]);
    expect(codes(validateRecord({ ...valid(), fields: { a: { "a\u0000b": 1 } } }))).toEqual([
      "invalid_key",
    ]);
  });

  it("refuses a record whose text adds up to more than the limit", () => {
    const perField = MAX_STRING_LENGTH;
    const count = Math.ceil(MAX_RECORD_CHARS / perField) + 1;
    const fields: Record<string, string> = {};
    for (let i = 0; i < count; i += 1) fields[`f${String(i)}`] = "x".repeat(perField);
    expect(count).toBeLessThan(MAX_FIELD_ENTRIES);
    expect(codes(validateRecord({ ...valid(), fields }))).toEqual(["too_large"]);
  });

  it("stops at a few hundred issues, however many problems there are", () => {
    const fields: Record<string, number> = {};
    for (let i = 0; i < 1500; i += 1) fields[`Bad${String(i)}`] = 1;
    const r = validateRecord({ ...valid(), fields });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeLessThanOrEqual(201);
    expect(r.issues[r.issues.length - 1]?.code).toBe("too_many_issues");
  });

  it("doesn't echo control characters or huge keys in messages", () => {
    const r = validateRecord({ ...valid(), ["x\u0000".repeat(50)]: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const i of r.issues) {
      expect(i.message).not.toContain("\u0000");
      expect(i.message.length).toBeLessThan(200);
    }
  });
});
