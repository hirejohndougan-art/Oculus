/**
 * Extended Date/Time Format (EDTF) dates.
 *
 * Follows the Library of Congress EDTF specification (2019), which is also
 * ISO 8601-2:2019 Annex. Supported:
 * - Level 0: dates (`1985`, `1985-04`, `1985-04-12`), date-times
 *   (`1985-04-12T23:20:30`, with `Z` or a `+hh:mm` offset) and intervals
 *   (`1964/2008`).
 * - Level 1: years after 9999 written `Y170000002`, negative years (`-1985`),
 *   seasons 21–24, `?` (uncertain), `~` (approximate) and `%` (both) at the
 *   end of a date, unspecified digits on the right (`201X`, `20XX`,
 *   `1985-XX-XX`), and open (`..`) or unknown (empty) interval ends.
 * - Level 2, the parts archives use: qualifiers on single parts
 *   (`2004-06~-11`, `?2004-06-~11`), unspecified digits anywhere (`156X-12-25`,
 *   `XXXX-12-XX`), sub-year groupings 25–41 (seasons by hemisphere, quarters,
 *   quadrimesters, semesters) and sets (`[1667,1668,1670..1672]` one of,
 *   `{1960,1961-12}` all of).
 * Not supported, and reported as `unsupported`: exponential years
 * (`Y-17E7`) and significant digits (`1950S2`). They are for geological and
 * astronomical time, not collections.
 *
 * Every valid date gets `earliest` and `latest` calendar days. They are
 * guaranteed to contain every day the expression could mean, and can be a
 * little wider (for example, a 29 February in a year with unspecified digits).
 * `~` and `?` don't widen them: "about 1920" sorts as 1920, flagged as
 * approximate, rather than as an invented range.
 */
import { issue, type Validated } from "./issues.js";
import { shown } from "./plain-data.js";

/** A day in the proleptic Gregorian calendar. Year 0 is 1 BCE; -1 is 2 BCE. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type EdtfLevel = 0 | 1 | 2;
export type EdtfKind = "date" | "datetime" | "interval" | "set";

/** A parsed, valid EDTF expression. */
export interface EdtfDate {
  /** The expression exactly as given (it was valid, so nothing was changed). */
  readonly edtf: string;
  /** The lowest EDTF conformance level that covers every feature used. */
  readonly level: EdtfLevel;
  readonly kind: EdtfKind;
  /** First possible day, or null when the start is open or unknown. */
  readonly earliest: CalendarDay | null;
  /** Last possible day, or null when the end is open or unknown. */
  readonly latest: CalendarDay | null;
  /**
   * A number to sort dates by: the earliest day as `year*10000 + month*100 +
   * day` (so `1920-03-05` is 19200305), or the latest day when the start is
   * open. It orders correctly for negative years too. Null when no year is
   * known at all (`XXXX-12-25`): such dates sort last, not as year 0.
   */
  readonly sortKey: number | null;
  /** The year of the day `sortKey` uses: a clean year for lists and facets. Null with `sortKey`. */
  readonly sortYear: number | null;
  /** Some part is marked `?` or `%`. */
  readonly uncertain: boolean;
  /** Some part is marked `~` or `%`. */
  readonly approximate: boolean;
  /** Some digit is `X`. */
  readonly unspecified: boolean;
}

/** The longest EDTF text accepted. Sets can be long; nothing real is near this. */
export const MAX_EDTF_LENGTH = 1000;
/** The most members a set may list. */
export const MAX_SET_MEMBERS = 100;
/** The largest year accepted (`Y999999999`). Keeps `sortKey` an exact integer. */
export const MAX_EDTF_YEAR = 999_999_999;

/** Sort key for a calendar day; see `EdtfDate.sortKey`. */
export function dayKey(day: CalendarDay): number {
  return day.year * 10000 + day.month * 100 + day.day;
}

/** Compare two dates for sorting: by `sortKey` (no year last), then by latest day (open last). */
export function compareEdtf(a: EdtfDate, b: EdtfDate): number {
  if (a.sortKey !== b.sortKey) {
    if (a.sortKey === null) return 1;
    if (b.sortKey === null) return -1;
    return a.sortKey - b.sortKey;
  }
  const al = a.latest === null ? Infinity : dayKey(a.latest);
  const bl = b.latest === null ? Infinity : dayKey(b.latest);
  if (al === bl) return 0;
  return al < bl ? -1 : 1;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

// ---------------------------------------------------------------------------

/** Thrown inside the parser only; `parseEdtf` turns it into an issue. */
class EdtfError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Span {
  /** The day to sort by, or null if no year is known. */
  anchor: CalendarDay | null;
  earliest: CalendarDay | null;
  latest: CalendarDay | null;
  level: EdtfLevel;
  uncertain: boolean;
  approximate: boolean;
  unspecified: boolean;
}

function fail(code: string, message: string): never {
  throw new EdtfError(code, message);
}

const maxLevel = (a: EdtfLevel, b: EdtfLevel): EdtfLevel => (a > b ? a : b);

/**
 * Parse and validate an EDTF expression. Never throws; returns the parsed
 * date or one issue explaining what is wrong.
 */
export function parseEdtf(input: unknown): Validated<EdtfDate> {
  if (typeof input !== "string") {
    return { ok: false, issues: [issue([], "not_text", "An EDTF date must be text.")] };
  }
  if (input.length === 0) {
    return { ok: false, issues: [issue([], "empty", "The date is empty.")] };
  }
  if (input.length > MAX_EDTF_LENGTH) {
    return {
      ok: false,
      issues: [
        issue([], "too_long", `An EDTF date can be at most ${String(MAX_EDTF_LENGTH)} characters.`),
      ],
    };
  }
  try {
    const { kind, span } = parseExpression(input);
    const anchor = span.anchor;
    return {
      ok: true,
      value: Object.freeze({
        edtf: input,
        level: span.level,
        kind,
        earliest: span.earliest,
        latest: span.latest,
        sortKey: anchor === null ? null : dayKey(anchor),
        sortYear: anchor === null ? null : anchor.year,
        uncertain: span.uncertain,
        approximate: span.approximate,
        unspecified: span.unspecified,
      }),
    };
  } catch (error) {
    if (error instanceof EdtfError) {
      return { ok: false, issues: [issue([], error.code, error.message)] };
    }
    throw error;
  }
}

/** True if `input` is a valid EDTF expression this module supports. */
export function isEdtf(input: unknown): input is string {
  return parseEdtf(input).ok;
}

function parseExpression(text: string): { kind: EdtfKind; span: Span } {
  // Only the characters EDTF uses. Rejecting everything else first means no
  // later step sees spaces, letters or control characters.
  if (!/^[0-9XYTZ:+\-~?%/.,[\]{}]+$/.test(text)) {
    if (/[ES]/.test(text) && /^[0-9XYES-]+$/.test(text)) {
      fail(
        "unsupported",
        "Exponential years and significant digits (EDTF level 2) are not supported.",
      );
    }
    fail("invalid_syntax", "This is not an EDTF date: it has characters EDTF doesn't use.");
  }
  const first = text[0];
  if (first === "[" || first === "{") return { kind: "set", span: parseSet(text) };
  if (text.includes("/")) return { kind: "interval", span: parseInterval(text) };
  if (text.includes("T")) return { kind: "datetime", span: parseDateTime(text) };
  return { kind: "date", span: parseDate(text) };
}

// --- date-time (level 0) ----------------------------------------------------

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}(?::\d{2})?)?$/;

function parseDateTime(text: string): Span {
  const m = DATETIME.exec(text);
  if (m === null) {
    fail(
      "invalid_syntax",
      "A date and time must look like 1985-04-12T23:20:30, optionally ending in Z or +05:00.",
    );
  }
  const [, y, mo, d, h, mi, s, zone] = m as RegExpExecArray & string[];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  checkMonth(month);
  checkDay(year, month, day);
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    fail("invalid_time", "The time must be between 00:00:00 and 23:59:59.");
  }
  if (zone !== undefined && zone !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = zone.length > 3 ? Number(zone.slice(4, 6)) : 0;
    if (zh > 14 || zm > 59 || (zh === 14 && zm > 0)) {
      fail("invalid_time", "The time zone offset must be between -14:00 and +14:00.");
    }
  }
  const at = { year, month, day };
  return {
    anchor: at,
    earliest: at,
    latest: at,
    level: 0,
    uncertain: false,
    approximate: false,
    unspecified: false,
  };
}

// --- single dates (levels 0–2) ----------------------------------------------

// Linear pattern: optional prefix qualifier, value, optional suffix qualifier,
// for year, month and day. No nested quantifiers, so no catastrophic backtracking.
const DATE =
  /^([?~%])?(Y-?\d+|-?[\dX]{4})([?~%])?(?:-([?~%])?([\dX]{2})([?~%])?(?:-([?~%])?([\dX]{2})([?~%])?)?)?$/;

interface Qual {
  uncertain: boolean;
  approximate: boolean;
}

const qualOf = (q: string | undefined): Qual => ({
  uncertain: q === "?" || q === "%",
  approximate: q === "~" || q === "%",
});

/** Sub-year groupings: code → [start month, start day, end month, end day, end in next year]. */
const GROUPINGS: Readonly<Record<number, readonly [number, number, number, number, boolean]>> = {
  // Level 1 seasons (hemisphere not stated) and level 2 northern seasons.
  21: [3, 1, 5, 31, false],
  22: [6, 1, 8, 31, false],
  23: [9, 1, 11, 30, false],
  // Winter can mean January–February or December onward, so cover both.
  24: [1, 1, 2, 0, true],
  25: [3, 1, 5, 31, false],
  26: [6, 1, 8, 31, false],
  27: [9, 1, 11, 30, false],
  28: [1, 1, 2, 0, true],
  // Southern hemisphere seasons.
  29: [9, 1, 11, 30, false],
  30: [1, 1, 2, 0, true],
  31: [3, 1, 5, 31, false],
  32: [6, 1, 8, 31, false],
  // Quarters, quadrimesters, semesters.
  33: [1, 1, 3, 31, false],
  34: [4, 1, 6, 30, false],
  35: [7, 1, 9, 30, false],
  36: [10, 1, 12, 31, false],
  37: [1, 1, 4, 30, false],
  38: [5, 1, 8, 31, false],
  39: [9, 1, 12, 31, false],
  40: [1, 1, 6, 30, false],
  41: [7, 1, 12, 31, false],
};

function parseDate(text: string): Span {
  const span = parseDateBounds(text);
  // A year of only X digits says nothing about when: don't sort it as year 0.
  const noYear = /^[?~%]?-?XXXX(?![\dX])/.test(text);
  return { ...span, anchor: noYear ? null : span.earliest };
}

function parseDateBounds(text: string): Omit<Span, "anchor"> {
  const m = DATE.exec(text);
  if (m === null) {
    fail(
      "invalid_syntax",
      "This is not an EDTF date. Dates look like 1985, 1985-04, 1985-04-12, 1985~ or 198X.",
    );
  }
  const g = m as RegExpExecArray & (string | undefined)[];
  const [preY, yearText = "", postY, preM, monthText, postM, preD, dayText, postD] = g.slice(1);

  // Qualifiers. A suffix applies to its part and every part to its left; a
  // prefix applies to its part only (EDTF level 2). Only a suffix on the
  // last part is level 1.
  const parts = [yearText, monthText, dayText].filter((p) => p !== undefined);
  const last = parts.length - 1;
  const suffixes = [postY, postM, postD];
  const prefixes = [preY, preM, preD];
  let level: EdtfLevel = 0;
  let uncertain = false;
  let approximate = false;
  if (suffixes.filter((q) => q !== undefined).length > 1) {
    fail("invalid_syntax", "A date can have only one qualifier (?, ~ or %) after its parts.");
  }
  for (let i = 0; i <= last; i++) {
    const pre = prefixes[i];
    const post = suffixes[i];
    if (pre !== undefined && post !== undefined) {
      fail("invalid_syntax", "Each part of a date can have only one qualifier (?, ~ or %).");
    }
    if (pre !== undefined || (post !== undefined && i !== last)) level = 2;
    if (post !== undefined && i === last) level = maxLevel(level, 1);
    for (const q of [pre, post]) {
      if (q === undefined) continue;
      const parsed = qualOf(q);
      uncertain ||= parsed.uncertain;
      approximate ||= parsed.approximate;
    }
  }

  // Unspecified digits: level 1 allows only X on the right (201X, 20XX,
  // 1985-XX, 1985-04-XX, 1985-XX-XX); anywhere else is level 2.
  if ([yearText, monthText, dayText].some((p) => p?.includes("X"))) {
    level = maxLevel(level, unspecifiedLevel(yearText, monthText, dayText));
  }

  // Year.
  let yearMin: number;
  let yearMax: number;
  let unspecified = false;
  if (yearText.startsWith("Y")) {
    const digits = yearText.replace(/^Y-?/, "");
    if (digits.length <= 4) {
      fail("invalid_year", "Use a Y prefix only for years with more than four digits.");
    }
    if (digits.length > 9 || digits.startsWith("0")) {
      fail("invalid_year", `A year can be at most ${String(MAX_EDTF_YEAR)}, with no leading zero.`);
    }
    if (parts.length > 1) fail("invalid_syntax", "A Y year can't have a month or day.");
    const value = Number(digits) * (yearText.startsWith("Y-") ? -1 : 1);
    yearMin = yearMax = value;
    level = maxLevel(level, 1);
  } else {
    const negative = yearText.startsWith("-");
    const digits = negative ? yearText.slice(1) : yearText;
    if (negative) {
      if (digits === "0000") fail("invalid_year", "Year -0000 is not allowed; use 0000.");
      level = maxLevel(level, 1);
    }
    const low = Number(digits.replaceAll("X", "0"));
    const high = Number(digits.replaceAll("X", "9"));
    if (digits.includes("X")) unspecified = true;
    // -0000 is not a year, so a negative year with X digits ends at -1.
    [yearMin, yearMax] = negative ? [-high, -Math.max(low, 1)] : [low, high];
  }

  if (monthText === undefined) {
    return {
      earliest: { year: yearMin, month: 1, day: 1 },
      latest: { year: yearMax, month: 12, day: 31 },
      level,
      uncertain,
      approximate,
      unspecified,
    };
  }

  // Seasons and other sub-year groupings.
  const code = Number(monthText);
  if (!monthText.includes("X") && code >= 21) {
    const grouping = GROUPINGS[code];
    if (grouping === undefined) {
      fail("invalid_month", `${monthText} is not a month (01–12) or an EDTF season (21–41).`);
    }
    if (dayText !== undefined) fail("invalid_day", "A season or quarter can't have a day.");
    const [sm, sd, em, ed, nextYear] = grouping;
    const endYear = yearMax + (nextYear ? 1 : 0);
    return {
      earliest: { year: yearMin, month: sm, day: sd },
      latest: { year: endYear, month: em, day: ed === 0 ? daysInMonth(endYear, em) : ed },
      level: maxLevel(level, code <= 24 ? 1 : 2),
      uncertain,
      approximate,
      unspecified,
    };
  }

  // Months (possibly with X digits).
  const months = matching(monthText, 12);
  if (months.length === 0) {
    fail("invalid_month", `${monthText} is not a month (01–12) or an EDTF season (21–41).`);
  }
  if (monthText.includes("X")) unspecified = true;
  const yearKnown = yearMin === yearMax;
  const longest = (month: number): number =>
    yearKnown ? daysInMonth(yearMin, month) : month === 2 ? 29 : daysInMonth(2000, month);

  if (dayText === undefined) {
    const firstMonth = need(months[0]);
    const lastMonth = need(months.at(-1));
    return {
      earliest: { year: yearMin, month: firstMonth, day: 1 },
      latest: { year: yearMax, month: lastMonth, day: daysInMonth(yearMax, lastMonth) },
      level,
      uncertain,
      approximate,
      unspecified,
    };
  }

  // Days (possibly with X digits).
  const days = matching(dayText, 31);
  if (dayText.includes("X")) unspecified = true;
  // Keep only months that have at least one possible day.
  const usable = months.filter((month) => days.some((d) => d <= longest(month)));
  if (days.length === 0 || usable.length === 0) {
    if (!dayText.includes("X") && !monthText.includes("X") && yearKnown) {
      checkDay(yearMin, Number(monthText), Number(dayText));
    }
    fail("invalid_day", `There is no day ${dayText} in month ${monthText}.`);
  }
  const m0 = need(usable[0]);
  const m1 = need(usable.at(-1));
  const d0 = need(days.find((d) => d <= longest(m0)));
  const d1 = need(days.findLast((d) => d <= longest(m1)));
  return {
    // Clamping keeps the bounds wide enough when a 29 February falls in a
    // non-leap bound year (only possible when the year has X digits).
    earliest: { year: yearMin, month: m0, day: Math.min(d0, daysInMonth(yearMin, m0)) },
    latest: { year: yearMax, month: m1, day: Math.min(d1, daysInMonth(yearMax, m1)) },
    level,
    uncertain,
    approximate,
    unspecified,
  };
}

function unspecifiedLevel(year: string, month?: string, day?: string): EdtfLevel {
  if (year.startsWith("-") && year.includes("X")) return 2;
  if (year.includes("X")) return /^\d{2}(\dX|XX)$/.test(year) && month === undefined ? 1 : 2;
  if (month === "XX") return day === undefined || day === "XX" ? 1 : 2;
  if (month?.includes("X")) return 2;
  return day === "XX" ? 1 : 2;
}

/** A value the parser has already shown exists. */
function need<T>(value: T | undefined): T {
  if (value === undefined) fail("internal", "The date could not be read.");
  return value;
}

/** Numbers 1..max whose two-digit form matches a pattern with X wildcards. */
function matching(pattern: string, max: number): number[] {
  // `pattern` is two characters, each a digit or X (checked by the DATE pattern).
  const shape = new RegExp(`^${pattern.replaceAll("X", "\\d")}$`);
  const out: number[] = [];
  for (let n = 1; n <= max; n++) {
    if (shape.test(String(n).padStart(2, "0"))) out.push(n);
  }
  return out;
}

function checkMonth(month: number): void {
  if (month < 1 || month > 12) fail("invalid_month", "The month must be 01 to 12.");
}

function checkDay(year: number, month: number, day: number): void {
  const length = daysInMonth(year, month);
  if (day < 1 || day > length) {
    fail(
      "invalid_day",
      `${String(year)}-${String(month).padStart(2, "0")} has days 01 to ${String(length)}.`,
    );
  }
}

// --- intervals (levels 0–2) -------------------------------------------------

function parseInterval(text: string): Span {
  const pieces = text.split("/");
  if (pieces.length !== 2) fail("invalid_interval", "An interval has exactly one /.");
  const [startText = "", endText = ""] = pieces;
  const start = parseEnd(startText);
  const end = parseEnd(endText);
  if (start === null && end === null) {
    fail("invalid_interval", "An interval needs at least one known end.");
  }
  if (start !== null && end !== null && start.earliest !== null && end.latest !== null) {
    if (dayKey(start.earliest) > dayKey(end.latest)) {
      fail("interval_backwards", "The interval ends before it starts.");
    }
  }
  // Open or unknown ends are level 1.
  const level = maxLevel(start?.level ?? 1, end?.level ?? 1);
  return {
    anchor: start?.anchor ?? (end !== null && end.anchor !== null ? end.latest : null),
    earliest: start?.earliest ?? null,
    latest: end?.latest ?? null,
    level,
    uncertain: (start?.uncertain ?? false) || (end?.uncertain ?? false),
    approximate: (start?.approximate ?? false) || (end?.approximate ?? false),
    unspecified: (start?.unspecified ?? false) || (end?.unspecified ?? false),
  };
}

/** One end of an interval: a date, `..` (open) or empty (unknown); null for the last two. */
function parseEnd(text: string): Span | null {
  if (text === "" || text === "..") return null;
  if (text.includes("T")) fail("invalid_interval", "Interval ends must be dates, not times.");
  return parseDate(text);
}

// --- sets (level 2) ---------------------------------------------------------

function parseSet(text: string): Span {
  const close = text.startsWith("[") ? "]" : "}";
  if (text.length < 3 || !text.endsWith(close)) {
    fail("invalid_set", `A set starts with ${text[0] ?? ""} and ends with ${close}.`);
  }
  const members = text.slice(1, -1).split(",");
  if (members.length > MAX_SET_MEMBERS) {
    fail("set_too_large", `A set can list at most ${String(MAX_SET_MEMBERS)} members.`);
  }
  let earliest: CalendarDay | null | undefined;
  let latest: CalendarDay | null | undefined;
  let uncertain = false;
  let approximate = false;
  let unspecified = false;
  // The earliest day among members that have a known year.
  const known: { day: CalendarDay | undefined } = { day: undefined };
  const take = (span: Span): void => {
    const anchor = span.anchor;
    if (anchor !== null && (known.day === undefined || dayKey(anchor) < dayKey(known.day))) {
      known.day = anchor;
    }
    uncertain ||= span.uncertain;
    approximate ||= span.approximate;
    unspecified ||= span.unspecified;
  };
  const lower = (day: CalendarDay | null): void => {
    if (earliest === null) return;
    if (day === null || earliest === undefined || dayKey(day) < dayKey(earliest)) earliest = day;
  };
  const upper = (day: CalendarDay | null): void => {
    if (latest === null) return;
    if (day === null || latest === undefined || dayKey(day) > dayKey(latest)) latest = day;
  };
  members.forEach((member, index) => {
    if (member === "") fail("invalid_set", "A set has an empty member.");
    if (member.includes("/")) fail("invalid_set", "A set lists dates and ranges, not intervals.");
    if (member.includes("T")) fail("invalid_set", "A set lists dates, not times.");
    const dots = member.indexOf("..");
    if (dots === -1) {
      if (member.includes(".")) fail("invalid_set", `${shown(member)} is not a date.`);
      const span = parseDate(member);
      take(span);
      lower(span.earliest);
      upper(span.latest);
      return;
    }
    const from = member.slice(0, dots);
    const to = member.slice(dots + 2);
    if (from.includes(".") || to.includes("."))
      fail("invalid_set", `${shown(member)} is not a range.`);
    if (from === "" && to === "") fail("invalid_set", "A set member can't be just “..”.");
    if (from === "" && index !== 0) {
      fail("invalid_set", "Only the first member of a set can be open at the start (..1984).");
    }
    if (to === "" && index !== members.length - 1) {
      fail("invalid_set", "Only the last member of a set can be open at the end (1984..).");
    }
    const a = from === "" ? null : parseDate(from);
    const b = to === "" ? null : parseDate(to);
    if (a !== null) take(a);
    if (b !== null) take(b);
    if (a?.earliest && b?.latest && dayKey(a.earliest) > dayKey(b.latest)) {
      fail("range_backwards", `The range ${shown(member)} ends before it starts.`);
    }
    lower(a === null ? null : a.earliest);
    upper(b === null ? null : b.latest);
  });
  const low = earliest ?? null;
  const high = latest ?? null;
  return {
    anchor: known.day === undefined ? null : low === null ? high : known.day,
    earliest: low,
    latest: high,
    level: 2,
    uncertain,
    approximate,
    unspecified,
  };
}
