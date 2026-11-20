/**
 * Turning free-text dates into EDTF.
 *
 * Catalogers and old databases write dates as "ca. 1920", "1950s", "late
 * 1920s" or "June 5, 1920". `edtfFromText` turns the common forms into EDTF
 * and reports everything else instead of guessing. When EDTF can't say all of
 * what the text said ("late 1920s" can only be `192X`), the result carries a
 * note to keep beside the date.
 *
 * It flags rather than guesses:
 * - "1900s" and "1800s": a decade or a century?
 * - "1920-25": the years 1920 to 1925, or EDTF's code for spring 1920?
 * - "6/5/1920" when it could be June 5 or 6 May, unless the caller says which
 *   order its data uses.
 * - "'50s" and "the fifties": which century?
 * - "c1920": copyright 1920 in library catalogs, circa elsewhere.
 * - "1901-05": May 1901, or 1901 to 1905? And a leading dash: BCE or "until"?
 * - "before 1920", "undated", and anything else it doesn't recognize.
 *
 * Some forms are read so that the result holds every reading: "19th
 * century" becomes 1800/1900 (strictly 1801–1900, commonly 1800–1899), and
 * "between 1920 and 1925" becomes [1920..1925], one date in that span
 * (DACS 2.4), where "from 1920 to 1925" is the whole span 1920/1925.
 */
import { issue, type Validated } from "./issues.js";
import { parseEdtf, type EdtfDate } from "./edtf.js";
import { shown, textProblem } from "./plain-data.js";

export interface EdtfFromTextOptions {
  /**
   * How the source writes all-number dates such as 6/5/1920. Without it,
   * only unambiguous ones (13/5/1920, or the same number twice) are read.
   */
  readonly numericOrder?: "month-day-year" | "day-month-year";
}

export interface EdtfFromText {
  readonly edtf: string;
  /** What the text said that EDTF can't, to keep as a note; undefined if nothing. */
  readonly note: string | undefined;
  readonly date: EdtfDate;
}

/** The longest text `edtfFromText` reads. Free-text dates are short. */
export const MAX_DATE_TEXT_LENGTH = 200;

// A Map, not an object, so text like "constructor" can't find a built-in.
const MONTHS: ReadonlyMap<string, number> = new Map(
  [
    ["jan", "january"],
    ["feb", "february"],
    ["mar", "march"],
    ["apr", "april"],
    ["may", "may"],
    ["jun", "june"],
    ["jul", "july"],
    ["aug", "august"],
    ["sep", "september"],
    ["oct", "october"],
    ["nov", "november"],
    ["dec", "december"],
  ].flatMap(([short = "", long = ""], i) => [
    [short, i + 1],
    [long, i + 1],
    ...(short === "sep" ? [["sept", 9] as const] : []),
  ]),
);

const SEASONS: ReadonlyMap<string, string> = new Map([
  ["spring", "21"],
  ["summer", "22"],
  ["autumn", "23"],
  ["fall", "23"],
  ["winter", "24"],
]);

const APPROXIMATE = /^(?:about|around|approximately|approx\.?|circa|ca\.?|c\.?|abt\.?)\s*/;
const UNCERTAIN = /^(?:probably|possibly|perhaps|maybe)\s+/;
const UNDATED =
  /^(?:undated|n\.\s*d\.?|nd|no date|date unknown|unknown|unknown date|\[?n\.d\.\]?)$/;

class TextError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new TextError(code, message);
}

interface Piece {
  edtf: string;
  /** EDTF loses something the text said ("late 1920s"), so keep the original. */
  keep: boolean;
}

/**
 * Turn a free-text date into EDTF. Text that is already valid EDTF is kept
 * as it is. Never throws.
 */
export function edtfFromText(
  input: unknown,
  options: EdtfFromTextOptions = {},
): Validated<EdtfFromText> {
  if (typeof input !== "string") {
    return { ok: false, issues: [issue([], "not_text", "A date must be text.")] };
  }
  if (input.length > MAX_DATE_TEXT_LENGTH) {
    return {
      ok: false,
      issues: [
        issue(
          [],
          "too_long",
          `A free-text date can be at most ${String(MAX_DATE_TEXT_LENGTH)} characters.`,
        ),
      ],
    };
  }
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, issues: [issue([], "empty", "The date is empty.")] };

  // The original wording can end up in a note, so it must be storable text.
  const problem =
    textProblem(trimmed) ??
    (/[\u2028\u2029\ufeff]/.test(trimmed)
      ? "contains a line or paragraph separator or a byte-order mark"
      : undefined);
  if (problem !== undefined) {
    return { ok: false, issues: [issue([], "invalid_text", `The date text ${problem}.`)] };
  }
  const guard = ambiguousForm(trimmed);
  if (guard !== undefined) return { ok: false, issues: [issue([], "ambiguous", guard)] };

  const exact = parseEdtf(trimmed);
  if (exact.ok) {
    return {
      ok: true,
      value: Object.freeze({ edtf: trimmed, note: undefined, date: exact.value }),
    };
  }

  try {
    const text = trimmed
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.$/, "")
      .trim();
    if (UNDATED.test(text)) fail("undated", "The text says the item is undated.");
    const piece = readRange(text, options);
    const parsed = parseEdtf(piece.edtf);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      fail(first?.code ?? "unreadable", first?.message ?? "This date could not be read.");
    }
    return {
      ok: true,
      value: Object.freeze({
        edtf: piece.edtf,
        // The text exactly as entered (trimmed), not the lowercased working copy.
        note: piece.keep ? `Originally “${trimmed}”.` : undefined,
        date: parsed.value,
      }),
    };
  } catch (error) {
    if (error instanceof TextError) {
      return { ok: false, issues: [issue([], error.code, error.message)] };
    }
    throw error;
  }
}

function readRange(text: string, options: EdtfFromTextOptions): Piece {
  // "ca. 1920-1925": a qualifier in front applies to both ends.
  const { rest, qualifier } = readQualifier(text);
  // "between 1920 and 1925" is one unknown date in that span (DACS 2.4),
  // which EDTF writes as a one-of set; "from 1920 to 1925" is the whole span.
  const between = /^between (.+?) (?:and|-) (.+)$/.exec(rest);
  if (between !== null) {
    const piece = joinRange(between[1] ?? "", between[2] ?? "", qualifier, options, text);
    return { edtf: `[${piece.edtf.replace("/", "..")}]`, keep: piece.keep };
  }
  const from = /^from (.+?) (?:to|until|-) (.+)$/.exec(rest);
  if (from !== null) return joinRange(from[1] ?? "", from[2] ?? "", qualifier, options, text);
  if (/^(?:before|after|by|pre|post|not before|not after|until|till)\b/.test(rest)) {
    fail(
      "unreadable",
      `${shown(text)} gives only one side of a range; enter it as an interval such as ../1920 or 1920/..`,
    );
  }
  // A single date first: "06-05-1920" has dashes but is not a range.
  let lastError: TextError;
  try {
    return readSingle(rest, qualifier, options);
  } catch (error) {
    if (!(error instanceof TextError) || error.code !== "unreadable") throw error;
    lastError = error;
  }
  // Then every place the text could split into two dates. "1920-06 to
  // 1921-05" has a dash before the real split, so try them all; if two
  // splits give different answers, it's ambiguous.
  const found = new Map<string, Piece>();
  let ambiguous: TextError | undefined;
  for (let i = 1; i < rest.length - 1; i++) {
    for (const separator of [" to ", " until ", " - ", "-"]) {
      if (!rest.startsWith(separator, i)) continue;
      try {
        const piece = joinRange(
          rest.slice(0, i),
          rest.slice(i + separator.length),
          qualifier,
          options,
          text,
        );
        found.set(piece.edtf, piece);
      } catch (error) {
        if (!(error instanceof TextError)) throw error;
        if (error.code === "ambiguous") ambiguous ??= error;
      }
    }
  }
  if (found.size > 1) {
    fail("ambiguous", `${shown(text)} can be split into a range in more than one way.`);
  }
  const [only] = found.values();
  if (only !== undefined) return only;
  throw ambiguous ?? lastError;
}

function joinRange(
  startRaw: string,
  endRaw: string,
  qualifier: string,
  options: EdtfFromTextOptions,
  text: string,
): Piece {
  const startText = startRaw.trim();
  let endText = endRaw.trim();
  // "1920 - 25": a two-digit end takes its century from the start.
  const short = /^\d{4}$/.test(startText) ? /^(\d{2})$/.exec(endText) : null;
  if (short !== null) {
    const end = `${startText.slice(0, 2)}${short[1] ?? ""}`;
    if (Number(end) <= Number(startText)) {
      fail("ambiguous", `In ${shown(text)} the short end year comes before the start.`);
    }
    endText = end;
  }
  const start = readSingle(startText, qualifier, options);
  const end = readSingle(endText, qualifier, options);
  if (start.edtf.includes("/") || end.edtf.includes("/")) {
    fail("unreadable", "A range inside a range can't be read.");
  }
  return { edtf: `${start.edtf}/${end.edtf}`, keep: start.keep || end.keep };
}

/**
 * Forms that read two ways in free text, checked before anything else. Returns
 * the message, or undefined if the text is fine.
 */
function ambiguousForm(text: string): string | undefined {
  // A dash before the first year: "until 1920", or a BCE year?
  if (/^[-\u2013\u2014]\s*\d/.test(text)) {
    return `${shown(text)} starts with a dash: it could mean “until” or a year BCE. Enter ../1920 for “until 1920”.`;
  }
  // "1920-25" is EDTF's spring 1920, and "1901-05" is May 1901, but in free
  // text both are as likely the years 1920–1925 and 1901–1905.
  for (const m of text.matchAll(/(?<![\dX-])(\d{4})-(\d{2})(?![\dX-])/g)) {
    const year = m[1] ?? "";
    const two = Number(m[2]);
    const season = two >= 21 && two <= 41;
    const month = two >= 1 && two <= 12 && two > Number(year.slice(2));
    if (season || month) {
      const what = season ? "an EDTF season code" : "a month";
      const end = `${year.slice(0, 2)}${m[2] ?? ""}`;
      return `${shown(m[0])} could be the years ${year} to ${end} or ${what}. Enter the range as ${year}/${end}.`;
    }
  }
  return undefined;
}

function readQualifier(text: string): { rest: string; qualifier: string } {
  let rest = text;
  let approximate = false;
  let uncertain = false;
  for (let round = 0; round < 2; round++) {
    const a = APPROXIMATE.exec(rest);
    // "c. 1920" is circa, but "c" must not eat the start of a word.
    const after = a === null ? "" : rest.slice(a[0].length);
    if (a !== null && /^c\d/.test(rest)) {
      // Library catalogs (AACR2, MARC) write "c1920" for copyright 1920, an
      // exact date, and circa as "ca."; don't guess which this is.
      fail(
        "ambiguous",
        `${shown(text)} could mean copyright ${after.slice(0, 4)} or circa. Write “ca. ${after.slice(0, 4)}” for circa.`,
      );
    }
    if (
      a !== null &&
      /^(?:\d|early|mid|late|the |spring|summer|autumn|fall|winter|[a-z]{3})/.test(after)
    ) {
      if (/^[a-z]/.test(after) && !/[\s.]$/.test(a[0])) {
        // "cat", "canada": no space or dot after the c/ca, so it's not a qualifier.
      } else {
        approximate = true;
        rest = after;
        continue;
      }
    }
    const u = UNCERTAIN.exec(rest);
    if (u !== null) {
      uncertain = true;
      rest = rest.slice(u[0].length);
      continue;
    }
    break;
  }
  if (rest.endsWith("?")) {
    uncertain = true;
    rest = rest.slice(0, -1).trim();
  }
  const qualifier = approximate && uncertain ? "%" : approximate ? "~" : uncertain ? "?" : "";
  return { rest, qualifier };
}

function readSingle(raw: string, qualifier: string, options: EdtfFromTextOptions): Piece {
  const text = raw.trim();
  const q = qualifier;

  // Already EDTF on its own ("1920", "1920-06").
  if (/^-?\d{4}(?:-\d{2}){0,2}$/.test(text) && parseEdtf(text).ok) {
    return { edtf: `${text}${q}`, keep: false };
  }

  // Decades: "1950s", "early 1920s", "mid-1950s", "the 1950s".
  const decade = /^(?:the )?(?:(early|mid|late)[- ]?)?(\d{3})0(?:'?s)$/.exec(text);
  if (decade !== null) {
    const part = decade[1];
    const stem = decade[2] ?? "";
    if (stem.endsWith("0")) {
      fail(
        "ambiguous",
        `${shown(raw)} could mean a decade (${stem}0–${stem}9) or a century; enter it as ${stem}X or ${stem.slice(0, 2)}XX.`,
      );
    }
    return { edtf: `${stem}X${q}`, keep: part !== undefined };
  }
  if (
    /^(?:the )?(?:(?:early|mid|late)[- ]?)?(?:'\d0s|\d0s|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)$/.test(
      text,
    )
  ) {
    fail("ambiguous", `${shown(raw)} doesn't say which century.`);
  }

  // Centuries: "19th century", "early 20th century", "20th c.".
  const century =
    /^(?:the )?(?:(early|mid|late)[- ]?)?(\d{1,2})(st|nd|rd|th) (?:century|cent\.?|c\.?)$/.exec(
      text,
    );
  if (century !== null) {
    const n = Number(century[2]);
    const ordinal =
      n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
    if (n < 1 || n > 99 || century[3] !== ordinal) {
      fail("unreadable", `${shown(raw)} is not a century.`);
    }
    // "19th century" means 1801–1900 strictly, but most catalogers mean
    // 1800–1899. The interval 1800/1900 holds both readings; the note keeps
    // the original words.
    const first = String((n - 1) * 100).padStart(4, "0");
    const last = String(n * 100).padStart(4, "0");
    return { edtf: `${first}${q}/${last}${q}`, keep: true };
  }

  // Seasons: "spring 1920", "summer of 1920".
  const season = /^(spring|summer|autumn|fall|winter)(?: of)?,? (\d{4})$/.exec(text);
  if (season !== null) {
    return {
      edtf: `${season[2] ?? ""}-${SEASONS.get(season[1] ?? "") ?? ""}${q}`,
      keep: false,
    };
  }

  // Month names: "June 1920", "June 5, 1920", "5 June 1920", "June 5th 1920".
  const monthYear = /^([a-z]+)\.?,? (\d{4})$/.exec(text);
  if (monthYear !== null) {
    const month = monthNumber(monthYear[1]);
    return { edtf: `${monthYear[2] ?? ""}-${pad(month)}${q}`, keep: false };
  }
  const monthDayYear = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text);
  const dayMonthYear = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)\.?,? (\d{4})$/.exec(text);
  if (monthDayYear !== null || dayMonthYear !== null) {
    const [monthName, dayText, yearText] =
      monthDayYear !== null
        ? [monthDayYear[1], monthDayYear[2], monthDayYear[3]]
        : [dayMonthYear?.[2], dayMonthYear?.[1], dayMonthYear?.[3]];
    return {
      edtf: `${yearText ?? ""}-${pad(monthNumber(monthName))}-${pad(Number(dayText))}${q}`,
      keep: false,
    };
  }

  // All numbers: "6/5/1920", "06-05-1920", "6.5.1920".
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (numeric !== null) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = numeric[3] ?? "";
    let month: number;
    let day: number;
    if (options.numericOrder === "month-day-year") [month, day] = [a, b];
    else if (options.numericOrder === "day-month-year") [month, day] = [b, a];
    else if (a === b || b > 12) [month, day] = [a, b];
    else if (a > 12) [month, day] = [b, a];
    else {
      fail(
        "ambiguous",
        `${shown(raw)} could be month/day or day/month. Say which order the source uses.`,
      );
    }
    return { edtf: `${year}-${pad(month)}-${pad(day)}${q}`, keep: false };
  }

  if (/^(?:before|after|by|pre|post|not before|not after)\b/.test(text)) {
    fail(
      "unreadable",
      `${shown(raw)} gives only one side of a range; enter it as an interval such as ../1920 or 1920/..`,
    );
  }
  fail("unreadable", `${shown(raw)} is not a date form this can read.`);
}

function monthNumber(name: string | undefined): number {
  const month = name === undefined ? undefined : MONTHS.get(name);
  if (month === undefined) fail("unreadable", `${shown(name ?? "")} is not a month.`);
  return month;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
