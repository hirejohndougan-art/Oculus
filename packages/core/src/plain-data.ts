/**
 * Reading untrusted input as plain data.
 *
 * Validators never work on the caller's own object. `readPlainData` walks the
 * input once and builds a fresh, frozen copy made only of plain JSON values:
 * strings, finite numbers, true/false, null, ordinary arrays and plain objects.
 * Anything else is reported, not copied, including:
 * - getters and setters, hidden (non-enumerable) properties and symbol keys
 * - Proxies, arrays with extra properties (a replaced `forEach`, a `toJSON`)
 *   or holes, and objects with an unusual prototype
 * - text with control characters or broken (lone surrogate) characters
 * - prototype keys (`__proto__`, `constructor`, `prototype`)
 * It also enforces size limits on nesting, value count, text length and the
 * total size of the copy. Callers then check the copy, so nothing can change
 * between "checked" and "used".
 */
import { types } from "node:util";
import type { Issue } from "./issues.js";

/** A JSON value. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ReadLimits {
  /** How deep objects and arrays may nest; the value passed in is depth 1. */
  readonly maxDepth: number;
  /** How many values (including every object and array) the whole copy may hold. */
  readonly maxValues: number;
  /** The longest a single text value may be. */
  readonly maxStringLength: number;
  /** The longest an object key may be. */
  readonly maxKeyLength: number;
  /** All text in the copy (keys and values) added together. */
  readonly maxTotalChars: number;
}

/** Collects issues, stopping after a limit so a hostile input can't produce millions. */
export class IssueList {
  readonly items: Issue[] = [];
  private stopped = false;
  constructor(private readonly limit = 200) {}
  add(path: readonly (string | number)[], code: string, message: string): void {
    if (this.stopped) return;
    if (this.items.length >= this.limit) {
      this.stopped = true;
      this.items.push({
        path: [],
        code: "too_many_issues",
        message: `Stopped after ${String(this.limit)} problems.`,
      });
      return;
    }
    this.items.push({ path, code, message });
  }
  get count(): number {
    return this.items.length;
  }
  /** True once the limit was reached; callers can stop looking for more. */
  get full(): boolean {
    return this.stopped;
  }
}

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Characters never allowed in stored text: C0 controls other than tab, line
// feed and carriage return; DEL; C1 controls; direction marks, overrides and
// isolates, which can make text display differently from what it says;
// invisible zero-width space, word joiner and byte-order mark; and the
// non-characters U+FFFE and U+FFFF. Zero-width joiner and non-joiner (U+200C,
// U+200D) are allowed: several scripts and emoji need them.
const BAD_TEXT =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\ufffe\uffff]/;
/** A high surrogate not followed by a low one, or a low one not after a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why a piece of text can't be stored, or undefined if it's fine. */
export function textProblem(text: string): string | undefined {
  if (BAD_TEXT.test(text)) return "contains invisible control or direction-changing characters";
  if (LONE_SURROGATE.test(text)) return "contains a broken character (a lone surrogate)";
  return undefined;
}

/** Characters JSON.stringify leaves as-is that could still hide or reorder text in a message. */
const UNSAFE_IN_MESSAGE =
  /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufffe\uffff]/g;

/**
 * Show a key or value in a message: quoted, shortened, and with every control,
 * invisible or direction-changing character written as an escape like \u202e.
 * Accepts anything, so a bad stored value can't make reporting throw.
 */
export function shown(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value : String(value);
  const short = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(short).replace(
    UNSAFE_IN_MESSAGE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

interface Context {
  readonly limits: ReadLimits;
  readonly issues: IssueList;
  values: number;
  chars: number;
  overBudget: boolean;
}

const NOT_READ = Symbol("not read");

/**
 * Copy `input` as plain JSON. Returns the frozen copy, or `undefined` when
 * the input (or part of it) couldn't be read; the reasons are in `issues`.
 * Never throws for problems in the data; if the input throws while being
 * read (a hostile getter or Proxy), the caller should treat that as unreadable.
 */
export function readPlainData(
  input: unknown,
  path: readonly (string | number)[],
  limits: ReadLimits,
  issues: IssueList,
): JsonValue | undefined {
  const ctx: Context = { limits, issues, values: 0, chars: 0, overBudget: false };
  const before = issues.count;
  const value = read(input, [...path], 1, ctx);
  return value === NOT_READ || issues.count > before ? undefined : value;
}

function read(
  value: unknown,
  path: (string | number)[],
  depth: number,
  ctx: Context,
): JsonValue | typeof NOT_READ {
  ctx.values += 1;
  if (ctx.values > ctx.limits.maxValues) {
    overBudget(
      ctx,
      "too_many_values",
      `At most ${String(ctx.limits.maxValues)} values are allowed.`,
    );
    return NOT_READ;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    ctx.issues.add(path, "not_finite", "Numbers must be finite.");
    return NOT_READ;
  }
  if (typeof value === "string") return readString(value, path, ctx) ? value : NOT_READ;
  if (typeof value !== "object") {
    ctx.issues.add(path, "not_json", "Values must be text, numbers, true/false, lists or groups.");
    return NOT_READ;
  }
  if (types.isProxy(value)) {
    ctx.issues.add(path, "not_plain_data", "Proxy objects are not accepted.");
    return NOT_READ;
  }
  if (depth > ctx.limits.maxDepth) {
    ctx.issues.add(
      path,
      "too_deep",
      `Values can nest at most ${String(ctx.limits.maxDepth)} levels.`,
    );
    return NOT_READ;
  }
  if (Array.isArray(value)) return readArray(value, path, depth, ctx);
  const proto: unknown = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || isBuiltIn(value)) {
    ctx.issues.add(path, "not_json", "Values must be text, numbers, true/false, lists or groups.");
    return NOT_READ;
  }
  return readObject(value, path, depth, ctx);
}

function readString(text: string, path: (string | number)[], ctx: Context): boolean {
  if (text.length > ctx.limits.maxStringLength) {
    ctx.issues.add(
      path,
      "too_long",
      `Text can be at most ${String(ctx.limits.maxStringLength)} characters.`,
    );
    return false;
  }
  if (!addChars(text.length, ctx)) return false;
  const problem = textProblem(text);
  if (problem !== undefined) {
    ctx.issues.add(path, "bad_characters", `This text ${problem}.`);
    return false;
  }
  return true;
}

function readArray(
  list: unknown[],
  path: (string | number)[],
  depth: number,
  ctx: Context,
): JsonValue | typeof NOT_READ {
  if (Object.getPrototypeOf(list) !== Array.prototype) {
    ctx.issues.add(path, "not_plain_data", "Lists must be ordinary arrays.");
    return NOT_READ;
  }
  // Check the length against the budget before touching the elements, so a
  // huge sparse array can't make us loop.
  const length = list.length;
  if (ctx.values + length > ctx.limits.maxValues) {
    overBudget(
      ctx,
      "too_many_values",
      `At most ${String(ctx.limits.maxValues)} values are allowed.`,
    );
    return NOT_READ;
  }
  // An ordinary, hole-free array has exactly the keys "0" … "length-1" and
  // "length". Anything more is an extra property; anything less is a hole.
  const keyCount = Reflect.ownKeys(list).length;
  if (keyCount > length + 1) {
    ctx.issues.add(path, "not_plain_data", "Lists can't carry extra properties or methods.");
    return NOT_READ;
  }
  if (keyCount < length + 1) {
    ctx.issues.add(path, "holes", "Lists can't have empty slots.");
    return NOT_READ;
  }
  const out: JsonValue[] = [];
  let ok = true;
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, i);
    if (descriptor === undefined) {
      ctx.issues.add([...path, i], "holes", "Lists can't have empty slots.");
      return NOT_READ;
    }
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      ctx.issues.add(
        [...path, i],
        "not_plain_data",
        "List items can't be getters, setters or hidden.",
      );
      ok = false;
      continue;
    }
    const item = read(descriptor.value, [...path, i], depth + 1, ctx);
    if (item === NOT_READ) ok = false;
    else out.push(item);
    if (ctx.overBudget) return NOT_READ;
  }
  return ok ? Object.freeze(out) : NOT_READ;
}

function readObject(
  source: object,
  path: (string | number)[],
  depth: number,
  ctx: Context,
): JsonValue | typeof NOT_READ {
  const out: Record<string, JsonValue> = {};
  let ok = true;
  for (const key of Reflect.ownKeys(source)) {
    // Stop as soon as the input is known to be too big or too broken, so the
    // work done stays bounded by the limits, not by the number of keys.
    if (ctx.overBudget || ctx.issues.full) return NOT_READ;
    ctx.values += 1;
    if (ctx.values > ctx.limits.maxValues) {
      overBudget(
        ctx,
        "too_many_values",
        `At most ${String(ctx.limits.maxValues)} values are allowed.`,
      );
      return NOT_READ;
    }
    if (typeof key === "symbol") {
      ctx.issues.add(path, "not_plain_data", "Symbol keys are not accepted.");
      ok = false;
      continue;
    }
    if (!readKey(key, [...path, key], ctx)) {
      ok = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      ctx.issues.add([...path, key], "not_plain_data", "Getters and setters are not accepted.");
      ok = false;
      continue;
    }
    if (descriptor.enumerable !== true) {
      ctx.issues.add([...path, key], "not_plain_data", "Hidden properties are not accepted.");
      ok = false;
      continue;
    }
    if (descriptor.value === undefined) {
      ctx.issues.add(
        [...path, key],
        "undefined_value",
        "This is set to undefined. Leave it out, or give it a value.",
      );
      ok = false;
      continue;
    }
    const item = read(descriptor.value, [...path, key], depth + 1, ctx);
    if (item === NOT_READ) ok = false;
    else out[key] = item; // safe: prototype keys were refused by readKey
  }
  return ok ? Object.freeze(out) : NOT_READ;
}

function readKey(key: string, path: (string | number)[], ctx: Context): boolean {
  if (FORBIDDEN_KEYS.has(key)) {
    ctx.issues.add(path, "forbidden_key", `${shown(key)} can't be used as a key.`);
    return false;
  }
  if (key.length === 0 || key.length > ctx.limits.maxKeyLength) {
    ctx.issues.add(
      path.slice(0, -1).concat(shown(key, 20)),
      "invalid_key",
      `Keys must be 1 to ${String(ctx.limits.maxKeyLength)} characters.`,
    );
    return false;
  }
  if (!addChars(key.length, ctx)) return false;
  const problem =
    textProblem(key) ?? (/[\t\n\r]/.test(key) ? "contains a line break or tab" : undefined);
  if (problem !== undefined) {
    ctx.issues.add(path.slice(0, -1).concat(shown(key, 20)), "invalid_key", `This key ${problem}.`);
    return false;
  }
  return true;
}

function addChars(count: number, ctx: Context): boolean {
  ctx.chars += count;
  if (ctx.chars <= ctx.limits.maxTotalChars) return true;
  overBudget(
    ctx,
    "too_large",
    `All text together can be at most ${String(ctx.limits.maxTotalChars)} characters.`,
  );
  return false;
}

function overBudget(ctx: Context, code: string, message: string): void {
  if (!ctx.overBudget) ctx.issues.add([], code, message);
  ctx.overBudget = true;
}

/** Maps, sets, dates and other built-ins, even with their prototype swapped out. */
function isBuiltIn(value: object): boolean {
  return (
    types.isMap(value) ||
    types.isSet(value) ||
    types.isWeakMap(value) ||
    types.isWeakSet(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isPromise(value) ||
    types.isBoxedPrimitive(value) ||
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isGeneratorObject(value) ||
    Object.prototype.toString.call(value) === "[object Error]"
  );
}
