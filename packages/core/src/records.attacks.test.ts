// Attacks found by the independent review of T-002. Each test tries one; each
// must be refused or neutralized, and validateRecord must never throw.
import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_ENTRIES,
  MAX_RECORD_CHARS,
  MAX_STRING_LENGTH,
  createRecord,
  isTemplateKey,
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
    ["a direction override", "a\u202eb"],
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
    for (let i = 0; i < 900; i += 1) fields[`Bad${String(i)}`] = 1;
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

describe("second review", () => {
  it("escapes every hidden or direction-changing character in messages and paths", () => {
    const r = validateRecord({ ...valid(), fields: { a: { "x\u0085\u202ey\u007f\u200b": 1 } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = JSON.stringify(r.issues.map((i) => [i.path.map(String), i.message]));
    const raw = r.issues.flatMap((i) => [...i.path.map(String), i.message]).join("");
    // eslint-disable-next-line no-control-regex -- checking control characters are absent
    expect(raw).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/);
    expect(text).toContain("\\\\u202e");
  });

  it("refuses a very wide object quickly", () => {
    const wide = JSON.parse(
      `{${Array.from({ length: 200_000 }, (_, i) => `"\\u0001${String(i)}":1`).join(",")}}`,
    ) as unknown;
    const started = performance.now();
    expect(validateRecord({ ...valid(), fields: { a: wide } }).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a valid-looking but very wide object quickly, by value count", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 200_000; i += 1) wide[`k${String(i)}`] = 1;
    const started = performance.now();
    expect(codes(validateRecord({ ...valid(), fields: { a: wide } }))).toEqual(["too_many_values"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("createRecord never throws on hostile input or a fake date", () => {
    const thrower = {
      kind: "object",
      get title(): string {
        throw new Error("x");
      },
    };
    expect(() => createRecord(thrower as never)).not.toThrow();
    expect(createRecord(thrower as never).ok).toBe(false);
    const fakeDate = Object.create(Date.prototype) as Date;
    expect(() => createRecord({ kind: "object", title: "x" }, fakeDate)).not.toThrow();
    expect(codes(createRecord({ kind: "object", title: "x" }, fakeDate))).toEqual(["invalid_time"]);
  });

  it("createRecord refuses getters instead of running them", () => {
    const sneaky = {
      kind: "object",
      get title(): string {
        return "X";
      },
    };
    expect(codes(createRecord(sneaky as never))).toEqual(["not_plain_data"]);
  });

  it("ignores values inherited from a polluted Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.title = "P";
    try {
      const input = valid();
      delete input.title;
      expect(codes(validateRecord(input))).toEqual(["required"]);
    } finally {
      delete proto.title;
    }
  });

  it.each(["\u200b", "a\u200fb", "a\u061cb", "\ufeffTitle", "a\uffffb"])(
    "refuses invisible or direction-changing characters in a title: %j",
    (title) => {
      expect(codes(validateRecord({ ...valid(), title }))).toContain("bad_characters");
    },
  );

  it("keeps zero-width joiners, which emoji and some scripts need", () => {
    expect(validateRecord({ ...valid(), title: "Family 👨\u200d👩\u200d👧" }).ok).toBe(true);
  });

  it("refuses a Map or Date disguised with a plain prototype", () => {
    const m = new Map([[1, 2]]);
    Object.setPrototypeOf(m, Object.prototype);
    expect(codes(validateRecord({ ...valid(), fields: { a: m } }))).toEqual(["not_json"]);
    const d = new Date();
    Object.setPrototypeOf(d, Object.prototype);
    expect(codes(validateRecord({ ...valid(), fields: { a: d } }))).toEqual(["not_json"]);
  });

  it("refuses hidden list entries", () => {
    const list: unknown[] = [1];
    Object.defineProperty(list, 0, { value: 9, enumerable: false });
    expect(codes(validateRecord({ ...valid(), fields: { list } }))).toEqual(["not_plain_data"]);
  });
});

describe("hostile template keys (D-0XX)", () => {
  it("refuses prototype keys as a template key", () => {
    for (const bad of ["constructor", "prototype", "__proto__"]) {
      expect(codes(validateRecord({ ...valid(), templateKey: bad }))).toEqual([
        "invalid_template_key",
      ]);
    }
  });

  it("doesn't read a templateKey from Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.templateKey = "public-everything";
    try {
      const r = validateRecord(valid());
      expect(r.ok).toBe(true);
      expect(r.ok && Object.hasOwn(r.value, "templateKey")).toBe(false);
    } finally {
      delete proto.templateKey;
    }
  });

  it("refuses a getter for the template key without running it", () => {
    let ran = false;
    const input = valid();
    Object.defineProperty(input, "templateKey", {
      enumerable: true,
      get: () => {
        ran = true;
        return "t";
      },
    });
    expect(validateRecord(input).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("refuses lookalike and invisible characters in the key", () => {
    for (const bad of ["t\u0435mplate", "t\u200bx", "t\u0000", "\uff54"]) {
      const r = validateRecord({ ...valid(), templateKey: bad });
      expect(r.ok).toBe(false);
      expect(isTemplateKey(bad)).toBe(false);
    }
  });
});
