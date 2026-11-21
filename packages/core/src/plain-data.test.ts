// Direct tests for the plain-data reader and its helpers. Every validator
// relies on these, so they are tested on their own here rather than only
// through the validators that call them.
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_KEYS,
  IssueList,
  isPlainObject,
  readPlainData,
  textProblem,
  type ReadLimits,
} from "./index.js";

const LIMITS: ReadLimits = {
  maxDepth: 4,
  maxValues: 50,
  maxStringLength: 20,
  maxKeyLength: 10,
  maxTotalChars: 200,
};

function read(input: unknown, limits: ReadLimits = LIMITS) {
  const issues = new IssueList();
  const value = readPlainData(input, ["fields"], limits, issues);
  return { value, issues: issues.items, codes: issues.items.map((i) => i.code) };
}

describe("textProblem", () => {
  it("accepts ordinary text, tabs, line breaks, emoji and joiners", () => {
    expect(textProblem("Dickinson Station, 1920")).toBeUndefined();
    expect(textProblem("line one\nline two\r\n\tindented")).toBeUndefined();
    expect(textProblem("Café façade 🚂")).toBeUndefined();
    expect(textProblem("👩‍👧 and ‌")).toBeUndefined();
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["bell", "a\u0007b"],
    ["DEL", "a\u007fb"],
    ["C1 control", "a\u0085b"],
    ["right-to-left override", "file‮gpj.exe"],
    ["isolate", "a⁦b"],
    ["zero-width space", "a​b"],
    ["byte-order mark", "﻿a"],
    ["non-character", "a￿b"],
    ["Arabic letter mark", "a؜b"],
  ])("refuses %s", (_name, text) => {
    expect(textProblem(text)).toMatch(/invisible control or direction-changing/);
  });

  it("refuses lone surrogates but accepts a proper pair", () => {
    expect(textProblem("a\ud800b")).toMatch(/lone surrogate/);
    expect(textProblem("a\udc00")).toMatch(/lone surrogate/);
    expect(textProblem("🚂")).toBeUndefined();
  });
});

describe("isPlainObject", () => {
  it("is true for object literals and null-prototype objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a number", 1],
    ["a function", () => 1],
    ["a date", new Date(0)],
    ["a map", new Map()],
    ["a class instance", new URL("https://example.org/")],
    ["an object with a custom prototype", Object.create({ inherited: true })],
  ])("is false for %s", (_name, value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});

describe("readPlainData", () => {
  it("returns an equal, deeply frozen copy of plain JSON", () => {
    const input = { title: "Depot", tags: ["rail", "1920s"], n: 3, ok: true, none: null };
    const { value, issues } = read(input);
    expect(issues).toEqual([]);
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen((value as { tags: unknown }).tags)).toBe(true);
  });

  it("does not share structure with the input, so later changes don't reach the copy", () => {
    const input = { tags: ["rail"] };
    const { value } = read(input);
    input.tags.push("changed");
    expect(value).toEqual({ tags: ["rail"] });
  });

  it("reads plain scalars at the top level", () => {
    expect(read("text").value).toBe("text");
    expect(read(0).value).toBe(0);
    expect(read(false).value).toBe(false);
    expect(read(null).value).toBeNull();
  });

  it("refuses non-finite numbers and non-JSON types with the path", () => {
    expect(read({ n: Number.NaN }).issues).toEqual([
      expect.objectContaining({ path: ["fields", "n"], code: "not_finite" }),
    ]);
    expect(read(Infinity).codes).toEqual(["not_finite"]);
    expect(read(undefined).codes).toEqual(["not_json"]);
    expect(read(10n).codes).toEqual(["not_json"]);
    expect(read(() => 1).codes).toEqual(["not_json"]);
    expect(read({ d: new Date(0) }).codes).toEqual(["not_json"]);
    expect(read(new Map()).codes).toEqual(["not_json"]);
  });

  it("refuses built-ins whose prototype was swapped to look plain", () => {
    const date = new Date(0);
    Object.setPrototypeOf(date, Object.prototype);
    expect(read(date).codes).toEqual(["not_json"]);
  });

  it("returns undefined whenever anything is reported, even if the rest was fine", () => {
    const { value, codes } = read({ good: "yes", bad: Number.NaN });
    expect(value).toBeUndefined();
    expect(codes).toEqual(["not_finite"]);
  });

  it("refuses Proxies, getters, hidden properties and symbol keys", () => {
    expect(read(new Proxy({}, {})).codes).toEqual(["not_plain_data"]);

    const getter = {};
    Object.defineProperty(getter, "x", { get: () => "sneaky", enumerable: true });
    expect(read(getter).codes).toEqual(["not_plain_data"]);

    const hidden = {};
    Object.defineProperty(hidden, "x", { value: "hidden", enumerable: false });
    expect(read(hidden).codes).toEqual(["not_plain_data"]);

    expect(read({ [Symbol("s")]: 1 }).codes).toEqual(["not_plain_data"]);
  });

  it("refuses undefined property values", () => {
    expect(read({ a: undefined }).issues).toEqual([
      expect.objectContaining({ path: ["fields", "a"], code: "undefined_value" }),
    ]);
  });

  it("refuses arrays with extra properties, holes, getters or another prototype", () => {
    const extra = Object.assign(["a"], { toJSON: () => "x" });
    expect(read(extra).codes).toEqual(["not_plain_data"]);

    // eslint-disable-next-line no-sparse-arrays -- a hole is what is being tested
    expect(read(["a", , "c"]).codes).toEqual(["holes"]);

    const withGetter = ["a"];
    Object.defineProperty(withGetter, 0, { get: () => "b", enumerable: true });
    expect(read(withGetter).codes).toEqual(["not_plain_data"]);

    class MyArray extends Array<string> {}
    expect(read(MyArray.from(["a"])).codes).toEqual(["not_plain_data"]);
  });

  it("refuses a huge sparse array by its length, without walking it", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    expect(read(sparse).codes).toEqual(["too_many_values"]);
  });

  it.each([...FORBIDDEN_KEYS])("refuses the prototype key %s", (key) => {
    const input = JSON.parse(`{"${key}": 1}`) as unknown;
    expect(read(input).codes).toEqual(["forbidden_key"]);
  });

  it("refuses empty, over-long and invisible-character keys", () => {
    expect(read({ "": 1 }).codes).toEqual(["invalid_key"]);
    expect(read({ abcdefghijk: 1 }).codes).toEqual(["invalid_key"]);
    expect(read({ "a‮b": 1 }).codes).toEqual(["invalid_key"]);
    expect(read({ "a\nb": 1 }).codes).toEqual(["invalid_key"]);
    expect(read({ abcdefghij: 1 }).codes).toEqual([]);
  });

  it("refuses bad characters in text values with the path", () => {
    expect(read({ t: "a​b" }).issues).toEqual([
      expect.objectContaining({ path: ["fields", "t"], code: "bad_characters" }),
    ]);
  });

  it("enforces the depth limit on objects and lists (scalars don't add a level)", () => {
    expect(read({ a: { b: { c: { d: 1 } } } }).codes).toEqual([]);
    expect(read({ a: { b: { c: { d: {} } } } }).codes).toEqual(["too_deep"]);
    expect(read([[[["deep"]]]]).codes).toEqual([]);
    expect(read([[[[["deep"]]]]]).codes).toEqual(["too_deep"]);
  });

  it("enforces the text length, value count and total size limits", () => {
    expect(read("x".repeat(20)).codes).toEqual([]);
    expect(read("x".repeat(21)).codes).toEqual(["too_long"]);

    expect(read(Array.from({ length: 49 }, () => 1)).codes).toEqual([]);
    expect(read(Array.from({ length: 50 }, () => 1)).codes).toEqual(["too_many_values"]);

    const manyKeys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i)}`, 1]));
    expect(read(manyKeys).codes).toEqual(["too_many_values"]);

    const bulky = Array.from({ length: 11 }, () => "x".repeat(20));
    expect(read(bulky).codes).toEqual(["too_large"]);
  });

  it("reports a size limit once, not once per value", () => {
    const bulky = Array.from({ length: 40 }, () => "x".repeat(20));
    expect(read(bulky).codes).toEqual(["too_large"]);
  });

  it("keeps the caller's path prefix and does not change it", () => {
    const path = ["record", 2] as const;
    const issues = new IssueList();
    readPlainData({ n: Number.NaN }, path, LIMITS, issues);
    expect(issues.items[0]?.path).toEqual(["record", 2, "n"]);
    expect(path).toEqual(["record", 2]);
  });

  it("counts only its own issues when the list already holds some", () => {
    const issues = new IssueList();
    issues.add([], "earlier", "From another check.");
    expect(readPlainData({ ok: "yes" }, [], LIMITS, issues)).toEqual({ ok: "yes" });
  });
});

describe("IssueList", () => {
  it("stops after its limit with one closing issue", () => {
    const list = new IssueList(3);
    for (let i = 0; i < 10; i += 1) list.add([i], "bad", "Bad.");
    expect(list.count).toBe(4);
    expect(list.full).toBe(true);
    expect(list.items.map((i) => i.code)).toEqual(["bad", "bad", "bad", "too_many_issues"]);
  });

  it("is not full below its limit", () => {
    const list = new IssueList(3);
    list.add([], "bad", "Bad.");
    expect(list.full).toBe(false);
    expect(list.count).toBe(1);
  });

  it("bounds the work readPlainData does on an object with many bad keys", () => {
    const issues = new IssueList(5);
    const input = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${String(i)}`, NaN]));
    expect(readPlainData(input, [], { ...LIMITS, maxValues: 1000 }, issues)).toBeUndefined();
    expect(issues.count).toBe(6);
  });
});
