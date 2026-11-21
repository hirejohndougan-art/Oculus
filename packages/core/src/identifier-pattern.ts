/**
 * Identifier formats (decision D-009).
 *
 * An organization describes what its numbers look like with a short format
 * such as `DHS-####` or `####.###`. Formats are typed in by admins, so they are
 * untrusted: they are never turned into a regular expression, because a
 * hostile or careless regex can take exponential time to run (ReDoS). Instead
 * this module has its own tiny format language and its own matcher:
 *
 * - `#` one digit, 0–9
 * - `@` one letter, A–Z or a–z
 * - `*` one letter or digit
 * - `{n}` or `{n,m}` after any single character or class: repeat it exactly n
 *   times, or n to m times (`#{4}`, `#{1,6}`, `-{0,1}` for an optional dash)
 * - `\` makes the next character literal (`\#` is a real #)
 * - anything else is itself, matched exactly (letters are case-sensitive)
 *
 * A format is compiled into a flat list of single-character slots, some of
 * them optional. Matching tracks every slot the text could have reached at
 * once (no backtracking), so it takes at most (text length × slot count)
 * steps, and both are capped. Classes are ASCII only, so a full-width or
 * Cyrillic lookalike is reported as not matching rather than slipping by.
 */
import { issue, type Validated } from "./issues.js";
import { shown, textProblem } from "./plain-data.js";
import { BLANK_CHARACTERS } from "./identifier-key.js";

/** The longest format text accepted. */
export const MAX_PATTERN_LENGTH = 100;
/** The most characters a format can describe (after expanding `{n,m}`). */
export const MAX_PATTERN_SLOTS = 200;
/** The largest count allowed in `{n}` or `{n,m}`. */
export const MAX_PATTERN_REPEAT = 100;

type SlotKind = "digit" | "letter" | "alnum" | "literal";

interface Slot {
  readonly kind: SlotKind;
  /** The character for a literal slot (one code point). */
  readonly char: string;
  readonly optional: boolean;
}

/** A checked, compiled identifier format. */
export interface IdentifierPattern {
  /** The format exactly as written. */
  readonly source: string;
  /** The fewest characters a matching identifier has. */
  readonly minLength: number;
  /** The most characters a matching identifier has. */
  readonly maxLength: number;
  /** @internal The compiled slots; use `matchesIdentifierPattern`. */
  readonly slots: readonly Slot[];
}

/** What the special characters mean, for messages shown to people. */
export const PATTERN_HELP = "In a format, # is a digit, @ is a letter and * is a letter or digit.";

/** Thrown inside the parser only; `parseIdentifierPattern` turns it into an issue. */
class PatternError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new PatternError(code, message);
}

/** Invisible characters and blank-looking ones (see `BLANK_CHARACTERS`). */
const INVISIBLE = new RegExp(`[\\p{Default_Ignorable_Code_Point}]|${BLANK_CHARACTERS}`, "u");

/**
 * Check and compile a format. Never throws; returns the compiled format or one
 * issue explaining what is wrong.
 */
export function parseIdentifierPattern(input: unknown): Validated<IdentifierPattern> {
  try {
    return { ok: true, value: compile(input) };
  } catch (error) {
    if (error instanceof PatternError) {
      return { ok: false, issues: [issue([], error.code, error.message)] };
    }
    return {
      ok: false,
      issues: [issue([], "unreadable", "This format could not be read.")],
    };
  }
}

function compile(input: unknown): IdentifierPattern {
  if (typeof input !== "string") fail("not_text", "A format must be text.");
  if (input.length === 0) fail("empty", "The format is empty.");
  if (input.length > MAX_PATTERN_LENGTH) {
    fail("too_long", `A format can be at most ${String(MAX_PATTERN_LENGTH)} characters.`);
  }
  const problem =
    textProblem(input) ??
    (/[\t\n\r\u2028\u2029]/.test(input) ? "contains a line break or tab" : undefined) ??
    (INVISIBLE.test(input) ? "contains invisible or blank characters" : undefined);
  if (problem !== undefined) fail("bad_characters", `This format ${problem}.`);
  if (input.trim() !== input) fail("untrimmed", "The format starts or ends with spaces.");

  // Compared in composed form (NFC), so an accented letter typed as a letter
  // plus a combining accent still matches.
  const chars = Array.from(input.normalize("NFC"));
  const slots: Slot[] = [];
  /** Where the last single token's slot starts, so `{n,m}` can repeat it. */
  let last: Slot | undefined;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] ?? "";
    i += 1;
    if (ch === "{") {
      if (last === undefined) {
        fail("invalid_repeat", "A {n} or {n,m} repeat must follow a character or #, @ or *.");
      }
      const close = chars.indexOf("}", i);
      if (close === -1) fail("invalid_repeat", "A { has no closing }.");
      const [min, max] = readRepeat(chars.slice(i, close).join(""));
      i = close + 1;
      // The token was pushed once already as a required slot; replace it.
      slots.pop();
      for (let n = 0; n < max; n += 1) {
        slots.push({ ...last, optional: n >= min });
        if (slots.length > MAX_PATTERN_SLOTS) tooManySlots();
      }
      last = undefined;
      continue;
    }
    if (ch === "}") fail("invalid_repeat", "A } has no opening {. Write \\} for a real }.");
    let slot: Slot;
    if (ch === "\\") {
      const next = chars[i];
      if (next === undefined) fail("invalid_escape", "A \\ at the end has nothing to escape.");
      i += 1;
      slot = { kind: "literal", char: next, optional: false };
    } else if (ch === "#") {
      slot = { kind: "digit", char: "", optional: false };
    } else if (ch === "@") {
      slot = { kind: "letter", char: "", optional: false };
    } else if (ch === "*") {
      slot = { kind: "alnum", char: "", optional: false };
    } else {
      slot = { kind: "literal", char: ch, optional: false };
    }
    slots.push(slot);
    if (slots.length > MAX_PATTERN_SLOTS) tooManySlots();
    last = slot;
  }

  const minLength = slots.filter((s) => !s.optional).length;
  if (minLength === 0) fail("matches_nothing", "A format must require at least one character.");
  return Object.freeze({
    source: input,
    minLength,
    maxLength: slots.length,
    slots: Object.freeze(slots.map((s) => Object.freeze(s))),
  });
}

function tooManySlots(): never {
  fail(
    "too_complex",
    `A format can describe at most ${String(MAX_PATTERN_SLOTS)} characters, counting repeats.`,
  );
}

function readRepeat(text: string): [number, number] {
  const match = /^(\d{1,3})(?:,(\d{1,3}))?$/.exec(text);
  if (match === null) {
    fail("invalid_repeat", "A repeat is written {n} or {n,m}, with whole numbers and no spaces.");
  }
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max > MAX_PATTERN_REPEAT) {
    fail("invalid_repeat", `A repeat can be at most ${String(MAX_PATTERN_REPEAT)}.`);
  }
  if (max < min)
    fail("invalid_repeat", `In {${String(min)},${String(max)}} the second number is smaller.`);
  if (max === 0) fail("invalid_repeat", "A repeat of {0} matches nothing; leave it out.");
  return [min, max];
}

function slotMatches(slot: Slot, ch: string): boolean {
  switch (slot.kind) {
    case "digit":
      return ch >= "0" && ch <= "9" && ch.length === 1;
    case "letter":
      return ch.length === 1 && ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"));
    case "alnum":
      return (
        ch.length === 1 &&
        ((ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"))
      );
    case "literal":
      return ch === slot.char;
  }
}

/**
 * True if `value` matches the format exactly (the whole value, not a part).
 * Runs in time proportional to (value length × format size), never more.
 */
export function matchesIdentifierPattern(pattern: IdentifierPattern, value: string): boolean {
  if (typeof value !== "string" || value.length > pattern.maxLength * 2) return false;
  const chars = Array.from(value.normalize("NFC"));
  if (chars.length < pattern.minLength || chars.length > pattern.maxLength) return false;
  const slots = pattern.slots;
  const n = slots.length;
  // active[i]: the text so far can end just before slot i.
  let active = new Uint8Array(n + 1);
  active[0] = 1;
  skipOptional(slots, active);
  for (const ch of chars) {
    const next = new Uint8Array(n + 1);
    let any = false;
    for (let i = 0; i < n; i += 1) {
      const slot = slots[i];
      if (active[i] === 1 && slot !== undefined && slotMatches(slot, ch)) {
        next[i + 1] = 1;
        any = true;
      }
    }
    if (!any) return false;
    skipOptional(slots, next);
    active = next;
  }
  return active[n] === 1;
}

/** Optional slots can be skipped: anything that reaches one also reaches the next. */
function skipOptional(slots: readonly Slot[], active: Uint8Array): void {
  for (let i = 0; i < slots.length; i += 1) {
    if (active[i] === 1 && slots[i]?.optional === true) active[i + 1] = 1;
  }
}

/** A plain-English sentence saying a value doesn't fit a format. */
export function patternMismatchMessage(pattern: IdentifierPattern, value: string): string {
  return `${shown(value)} doesn't match the format ${shown(pattern.source)}. ${PATTERN_HELP}`;
}
