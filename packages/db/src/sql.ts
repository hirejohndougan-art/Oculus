/**
 * The one way to write a query (D-050): the `sql` tagged template.
 *
 * Every `${value}` becomes a numbered parameter (`$1`, `$2`, ...) sent to the
 * server separately from the SQL text, so no value can ever change what the
 * query says. There is no raw-string escape hatch and no identifier helper:
 * table and column names are written in the SQL text itself. A `${fragment}`
 * made by `sql` is spliced in with its own parameters renumbered, so queries
 * can be built from parts without ever building strings.
 *
 * Values are limited to what maps cleanly onto a parameter: strings, finite
 * numbers, bigints, booleans, null, valid Dates, Uint8Arrays (bytea) and arrays
 * of those. Anything else is refused: `undefined` (almost always a bug), plain
 * objects (write `${JSON.stringify(v)}::jsonb`, D-050), objects with a
 * `toPostgres` method (pg would call it), functions and symbols.
 */

/** PostgreSQL's limit on parameters in one statement. */
export const MAX_PARAMETERS = 65535;

export type SqlScalar = string | number | bigint | boolean | null | Date | Uint8Array;
export type SqlValue = SqlScalar | readonly SqlValue[];

const brand = Symbol("oculus.sql");

/**
 * Two placeholders may not touch (`$1$2`), and characters that would join a
 * `$n` placeholder to the text around it are refused: after
 * it, a digit makes another parameter number (`${a}0` would read `$10`) and a
 * letter, `_` or `$` is trailing junk; before it, they make it part of an
 * identifier (`col$1`) or a dollar quote (`$$1`). PostgreSQL identifiers also
 * take any non-ASCII letter.
 */
const JOINS_AFTER = /^[0-9A-Za-z_$\u0080-\uffff]/;
const JOINS_BEFORE = /[0-9A-Za-z_$\u0080-\uffff]$/;

function checkPlaceholders(parts: readonly string[]): void {
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === "") {
      throw new TypeError(
        `sql: parameters ${String(i)} and ${String(i + 1)} are side by side ($${String(i)}$${String(i + 1)}); put a space or operator between them.`,
      );
    }
  }
  for (let i = 1; i < parts.length; i++) {
    if (JOINS_BEFORE.test(parts[i - 1] ?? "") || JOINS_AFTER.test(parts[i] ?? "")) {
      throw new TypeError(
        `sql: parameter ${String(i)} touches the text next to it; put a space or operator between them.`,
      );
    }
  }
}

/** A query or fragment made by `sql`. Only `sql` and `joinSql` can make one. */
export class Sql {
  /** The literal SQL parts; always one more than `values`. */
  readonly #parts: readonly string[];
  readonly #values: readonly SqlValue[];

  constructor(token: symbol, parts: readonly string[], values: readonly SqlValue[]) {
    if (token !== brand) throw new TypeError("Sql values are made only by the sql tag.");
    checkPlaceholders(parts);
    this.#parts = parts;
    this.#values = values;
    Object.freeze(this);
  }

  /** The SQL text with `$n` placeholders, for `pg`. */
  get text(): string {
    let text = this.#parts[0] ?? "";
    for (let i = 1; i < this.#parts.length; i++) text += `$${String(i)}${this.#parts[i] ?? ""}`;
    return text;
  }

  /** The parameter values, in placeholder order (a fresh copy each time). */
  get values(): SqlValue[] {
    return [...this.#values];
  }

  /** True only for objects really made by this class (a private-field check, not instanceof). */
  static is(value: unknown): value is Sql {
    return typeof value === "object" && value !== null && #parts in value;
  }

  /** @internal Used when splicing this fragment into another. */
  static parts(fragment: Sql): readonly string[] {
    return fragment.#parts;
  }

  /** @internal */
  static valuesOf(fragment: Sql): readonly SqlValue[] {
    return fragment.#values;
  }
}

export function isSql(value: unknown): value is Sql {
  return Sql.is(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

/** Checks one value and returns a frozen copy safe to hand to pg. */
function checkValue(value: unknown, path: string, depth: number): SqlValue {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "bigint":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`sql: ${path} is not a finite number.`);
      return value;
    case "object": {
      if (value === null) return null;
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new TypeError(`sql: ${path} is an invalid Date.`);
        return new Date(value.getTime());
      }
      if (value instanceof Uint8Array) return Uint8Array.prototype.slice.call(value);
      if (Array.isArray(value)) {
        if (depth >= 6) throw new TypeError(`sql: ${path} is nested too deeply.`);
        const copy: SqlValue[] = [];
        const length = value.length;
        for (let i = 0; i < length; i++) {
          if (!Object.hasOwn(value, i))
            throw new TypeError(`sql: ${path}[${String(i)}] is a hole.`);
          const item: unknown = value[i];
          if (item instanceof Sql || Sql.is(item)) {
            throw new TypeError(`sql: ${path}[${String(i)}] is an sql fragment inside an array.`);
          }
          copy.push(checkValue(item, `${path}[${String(i)}]`, depth + 1));
        }
        return Object.freeze(copy);
      }
      throw new TypeError(
        `sql: ${path} is an object; pass JSON as \${JSON.stringify(value)}::jsonb.`,
      );
    }
    default:
      throw new TypeError(`sql: ${path} is ${describe(value)}, which can't be a parameter.`);
  }
}

/** Adds text to the last literal part. */
function appendText(parts: string[], text: string): void {
  parts[parts.length - 1] = (parts[parts.length - 1] ?? "") + text;
}

function isTemplateStrings(strings: unknown): strings is TemplateStringsArray {
  return (
    Array.isArray(strings) &&
    Object.isFrozen(strings) &&
    Array.isArray((strings as unknown as { raw?: unknown }).raw) &&
    Object.isFrozen((strings as unknown as { raw: unknown }).raw) &&
    strings.every((part) => typeof part === "string")
  );
}

/**
 * The query tag. `sql\`select * from t where id = ${id}\`` gives
 * `{ text: "select * from t where id = $1", values: [id] }`.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  if (!isTemplateStrings(strings) || strings.length !== values.length + 1) {
    throw new TypeError("sql must be used as a tagged template: sql`...`.");
  }
  const parts: string[] = [strings[0] ?? ""];
  const out: SqlValue[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const next = strings[i + 1] ?? "";
    if (Sql.is(value)) {
      const inner = Sql.parts(value);
      const innerValues = Sql.valuesOf(value);
      appendText(parts, inner[0] ?? "");
      for (let j = 1; j < inner.length; j++) parts.push(inner[j] ?? "");
      appendText(parts, next);
      out.push(...innerValues);
    } else {
      out.push(checkValue(value, `value ${String(i + 1)}`, 0));
      parts.push(next);
    }
    if (out.length > MAX_PARAMETERS) {
      throw new RangeError(`sql: more than ${String(MAX_PARAMETERS)} parameters.`);
    }
  }
  return new Sql(brand, Object.freeze(parts), Object.freeze(out));
}

/**
 * Joins fragments with a separator fragment, e.g.
 * `joinSql(ids.map((id) => sql\`${id}\`), sql\`, \`)`.
 */
export function joinSql(fragments: readonly Sql[], separator: Sql): Sql {
  if (!Sql.is(separator)) throw new TypeError("joinSql: the separator must be sql.");
  const parts: string[] = [""];
  const out: SqlValue[] = [];
  const append = (fragment: Sql) => {
    const inner = Sql.parts(fragment);
    appendText(parts, inner[0] ?? "");
    for (let j = 1; j < inner.length; j++) parts.push(inner[j] ?? "");
    out.push(...Sql.valuesOf(fragment));
    if (out.length > MAX_PARAMETERS) {
      throw new RangeError(`sql: more than ${String(MAX_PARAMETERS)} parameters.`);
    }
  };
  const list = [...fragments];
  list.forEach((fragment, i) => {
    if (!Sql.is(fragment)) {
      throw new TypeError(`joinSql: item ${String(i + 1)} is not sql.`);
    }
    if (i > 0) append(separator);
    append(fragment);
  });
  return new Sql(brand, Object.freeze(parts), Object.freeze(out));
}
