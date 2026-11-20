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
}

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Characters never allowed in stored text: C0 controls other than tab, line
// feed and carriage return; DEL; C1 controls; and the bidirectional overrides
// and isolates that can make text display differently from what it says.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
/** A high surrogate not followed by a low one, or a low one not after a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why a piece of text can't be stored, or undefined if it's fine. */
export function textProblem(text: string): string | undefined {
  if (BAD_TEXT.test(text)) return "contains invisible control or direction-changing characters";
  if (LONE_SURROGATE.test(text)) return "contains a broken character (a lone surrogate)";
  return undefined;
}

/** Show a key or value in a message: quoted, shortened, control characters escaped. */
export function shown(text: string, max = 60): string {
  const short = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(short);
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
  if (proto !== Object.prototype && proto !== null) {
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
  const ownKeys = Reflect.ownKeys(list);
  // An ordinary, hole-free array has exactly the keys "0" … "length-1" and "length".
  if (ownKeys.length !== length + 1) {
    const extras = ownKeys.filter(
      (key) => key !== "length" && !(typeof key === "string" && isIndex(key, length)),
    );
    if (extras.length > 0) {
      ctx.issues.add(path, "not_plain_data", "Lists can't carry extra properties or methods.");
    } else {
      ctx.issues.add(path, "holes", "Lists can't have empty slots.");
    }
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
    if (!("value" in descriptor)) {
      ctx.issues.add([...path, i], "not_plain_data", "List items can't be getters or setters.");
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
    if (ctx.overBudget) return NOT_READ;
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

function isIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) < length;
}
