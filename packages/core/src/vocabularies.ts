/**
 * Controlled vocabularies and terms (PLATFORM_PLAN.md §1, decision D-014).
 *
 * A controlled term is stored the way a `controlled_term` field holds it
 * (D-010): `{ label, uri?, vocabulary? }`. The label is what people read;
 * the URI, when there is one, is what identifies the term. No vocabulary
 * data is downloaded or bundled: this module knows each vocabulary's code,
 * name and URI form, and checks that a stored term is consistent with them.
 * It does not (and can't, offline) check that a URI exists or that the label
 * is the vocabulary's current one.
 *
 * Vocabularies, and what is checked about their URIs:
 * - `lcsh`, `lcnaf`, `lcgft`: Library of Congress Subject Headings, Name
 *   Authority File and Genre/Form Terms. The canonical URI is the one
 *   id.loc.gov publishes as the authority's `@id`, checked against its JSON
 *   on 2026-11-20: `http://id.loc.gov/authorities/subjects/sh85063195`,
 *   `…/names/no2008041321`, `…/genreForms/gf2011026431` (http, no trailing
 *   slash, no file ending). The last part is a normalized LC control number,
 *   checked with the syntax rules of LC's "The LCCN Namespace" (8 to 12
 *   characters, the last 8 digits, a prefix of lower case letters). The
 *   prefixes `sh` (subjects), `gf` (genre/form) and `n` with at most one more
 *   letter (names: `n`, `nb`, `no` and `nr` were seen) come from a sample of
 *   about 400 id.loc.gov URIs; LC's prefix list itself wasn't checked.
 * - `nomenclature`: Nomenclature 4.0 for Museum Cataloging. nomenclature.info
 *   couldn't be reached from the build sandbox, so its term URI form is not
 *   confirmed. Only the site is checked: a URI must be on nomenclature.info
 *   (the address AASLH gives for the online Nomenclature), with no port of
 *   its own, and not the bare site root.
 * - `gnis`: the USGS Geographic Names Information System. The USGS sites
 *   couldn't be reached either, so a GNIS URI is checked only as a web
 *   address (by the template check), not against a pattern.
 * - `local`: the organization's own terms. They have no URI yet.
 *
 * Rules (D-014): a term with no vocabulary is a local term and can't have a
 * URI. A URI is optional for the other vocabularies, because an LCSH heading
 * built with subdivisions often has no authority record of its own. When a
 * URI is given, it must pass what is checked for its vocabulary (above). For
 * the LC vocabularies that means the exact canonical form: variants (https,
 * `www.`, `.html` or `.json` on the end, a trailing slash, an upper case
 * prefix, a query or fragment) are refused with `not_canonical`, and only
 * `normalizeTermUri` turns them into the canonical URI, listing every change.
 * Nomenclature and GNIS URIs are stored as given, since their canonical form
 * isn't known; `termUriKey` compares them loosely (scheme, host case, a
 * trailing slash or dot) without changing what is stored.
 *
 * `controlledTermChecker` plugs these rules into `checkRecordAgainstTemplate`
 * as `checkers.controlled_term`. Lookups use Maps, so text such as
 * "constructor" can't find a built-in. Nothing here throws.
 */
import { isPlainObject, type Issue, type Validated } from "./issues.js";
import {
  IssueList,
  readPlainData,
  shown,
  textProblem,
  type JsonValue,
  type ReadLimits,
} from "./plain-data.js";
import {
  MAX_SHORT_TEXT_LENGTH,
  MAX_URL_LENGTH,
  webUrlProblem,
  type FieldProblem,
  type FieldValueChecker,
} from "./templates.js";

export const VOCABULARY_CODES = [
  "lcsh",
  "lcnaf",
  "lcgft",
  "nomenclature",
  "gnis",
  "local",
] as const;

export type VocabularyCode = (typeof VOCABULARY_CODES)[number];

/**
 * What can be checked about a vocabulary's URIs:
 * - `lc_authority`: the exact id.loc.gov authority form, including the
 *   control number.
 * - `site`: only that the URI is on the issuer's site.
 * - `web_address`: only that it is a web address (the form isn't confirmed).
 * - `none`: the vocabulary's terms have no URI.
 */
export type UriCheck = "lc_authority" | "site" | "web_address" | "none";

export interface Vocabulary {
  readonly code: VocabularyCode;
  /** The vocabulary's name. */
  readonly label: string;
  /** A short name for lists and badges. */
  readonly shortLabel: string;
  readonly issuer: string;
  readonly uriCheck: UriCheck;
  /** How a URI is written, for help text; `{LCCN}` stands for the control number. */
  readonly uriForm?: string;
}

/** A term as a `controlled_term` field stores it. */
export interface ControlledTerm {
  readonly label: string;
  readonly uri?: string;
  /** Missing means a local term. */
  readonly vocabulary?: string;
}

const LC_BASE = "http://id.loc.gov/authorities/";

/** The vocabularies Oculus knows, in the order lists show them. */
export const VOCABULARIES: readonly Vocabulary[] = Object.freeze(
  [
    {
      code: "lcsh",
      label: "Library of Congress Subject Headings",
      shortLabel: "LCSH",
      issuer: "Library of Congress",
      uriCheck: "lc_authority",
      uriForm: `${LC_BASE}subjects/{LCCN}`,
    },
    {
      code: "lcnaf",
      label: "Library of Congress Name Authority File",
      shortLabel: "LCNAF",
      issuer: "Library of Congress",
      uriCheck: "lc_authority",
      uriForm: `${LC_BASE}names/{LCCN}`,
    },
    {
      code: "lcgft",
      label: "Library of Congress Genre/Form Terms",
      shortLabel: "LCGFT",
      issuer: "Library of Congress",
      uriCheck: "lc_authority",
      uriForm: `${LC_BASE}genreForms/{LCCN}`,
    },
    {
      code: "nomenclature",
      label: "Nomenclature 4.0 for Museum Cataloging",
      shortLabel: "Nomenclature",
      issuer: "Canadian Heritage Information Network and AASLH",
      uriCheck: "site",
      uriForm: "https://nomenclature.info/…",
    },
    {
      code: "gnis",
      label: "Geographic Names Information System",
      shortLabel: "GNIS",
      issuer: "U.S. Geological Survey",
      uriCheck: "web_address",
    },
    {
      code: "local",
      label: "Local terms",
      shortLabel: "Local",
      issuer: "this organization",
      uriCheck: "none",
    },
  ].map((v) => Object.freeze(v as Vocabulary)),
);

const BY_CODE: ReadonlyMap<string, Vocabulary> = new Map(VOCABULARIES.map((v) => [v.code, v]));

/** The id.loc.gov path segment for each LC vocabulary, and the reverse. */
const LC_SCHEMES: ReadonlyMap<string, VocabularyCode> = new Map<string, VocabularyCode>([
  ["subjects", "lcsh"],
  ["names", "lcnaf"],
  ["genreForms", "lcgft"],
]);
const LC_PATH: ReadonlyMap<VocabularyCode, string> = new Map(
  [...LC_SCHEMES].map(([path, code]) => [code, path]),
);
/** The control number prefixes each LC vocabulary uses (see the header). */
const LC_PREFIX: ReadonlyMap<VocabularyCode, RegExp> = new Map<VocabularyCode, RegExp>([
  ["lcsh", /^sh$/],
  ["lcnaf", /^n[a-z]?$/],
  ["lcgft", /^gf$/],
]);
const NOMENCLATURE_HOSTS: ReadonlySet<string> = new Set([
  "nomenclature.info",
  "www.nomenclature.info",
]);

/** The vocabulary with this code, or undefined. */
export function vocabulary(code: unknown): Vocabulary | undefined {
  return typeof code === "string" ? BY_CODE.get(code) : undefined;
}

/** True for a term with no vocabulary, or the `local` one. */
export function isLocalTerm(term: { readonly vocabulary?: string | undefined }): boolean {
  return term.vocabulary === undefined || term.vocabulary === "local";
}

// ---------------------------------------------------------------------------

const TERM_KEYS: ReadonlySet<string> = new Set(["label", "uri", "vocabulary"]);
const LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

const TERM_READ_LIMITS: ReadLimits = {
  maxDepth: 2,
  maxValues: 10,
  maxStringLength: MAX_URL_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 5000,
};

/**
 * Check one controlled term: its shape (as the template check does), then
 * the vocabulary rules in the header. Returns a frozen copy. Never throws.
 */
export function validateControlledTerm(input: unknown): Validated<ControlledTerm> {
  const issues = new IssueList();
  let term: ControlledTerm | undefined;
  try {
    const data = readPlainData(input, [], TERM_READ_LIMITS, issues);
    if (data !== undefined) term = checkTermValue(data, [], issues);
  } catch {
    issues.add([], "unreadable", "This term could not be read as plain data.");
  }
  if (term === undefined || issues.count > 0) {
    return { ok: false, issues: Object.freeze([...issues.items]) };
  }
  return { ok: true, value: term };
}

/**
 * `checkers.controlled_term` for `checkRecordAgainstTemplate`: the vocabulary
 * rules for one value, as problems relative to the value. Which vocabularies
 * a field allows is the template's own check (`vocabularies`).
 */
export const controlledTermChecker: FieldValueChecker = (value) => {
  const result = validateControlledTerm(value);
  if (result.ok) return Object.freeze([]);
  return Object.freeze(
    result.issues.map((i): FieldProblem =>
      Object.freeze({ code: i.code, message: i.message, path: i.path }),
    ),
  );
};

/** Check an already-copied plain value as a term; adds problems to `issues`. */
function checkTermValue(
  value: JsonValue,
  path: readonly (string | number)[],
  issues: IssueList,
): ControlledTerm | undefined {
  if (!isPlainObject(value)) {
    issues.add(path, "not_an_object", "A term must be { label, uri, vocabulary }.");
    return undefined;
  }
  const before = issues.count;
  for (const key of Object.keys(value)) {
    if (!TERM_KEYS.has(key)) {
      issues.add([...path, key], "unknown_property", `${shown(key)} is not a property of a term.`);
    }
  }
  const label = own(value, "label");
  const uri = own(value, "uri");
  const code = own(value, "vocabulary");

  const labelProblem = lineProblem(label);
  if (labelProblem !== undefined) {
    issues.add([...path, "label"], "invalid_text", `The term ${labelProblem}.`);
  }
  let uriText: string | undefined;
  if (uri !== undefined) {
    const problem = typeof uri === "string" ? urlProblem(uri) : "must be text";
    if (problem === undefined) uriText = uri as string;
    else issues.add([...path, "uri"], "invalid_url", `The web address ${problem}.`);
  }
  let vocab: Vocabulary | undefined;
  if (code !== undefined) {
    vocab = vocabulary(code);
    if (vocab === undefined) {
      issues.add(
        [...path, "vocabulary"],
        "unknown_vocabulary",
        `${shown(code)} is not a vocabulary Oculus knows (${VOCABULARY_CODES.join(", ")}).`,
      );
    }
  }
  if (issues.count > before) return undefined;
  if (uriText !== undefined) checkUri(uriText, vocab, [...path, "uri"], issues);
  if (issues.count > before) return undefined;

  const out: { label: string; uri?: string; vocabulary?: string } = { label: label as string };
  if (uriText !== undefined) out.uri = uriText;
  if (vocab !== undefined) out.vocabulary = vocab.code;
  return Object.freeze(out);
}

function checkUri(
  uri: string,
  vocab: Vocabulary | undefined,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  const lc = parseLcUri(uri);
  const lcVocab = lc.ok ? vocabulary(lc.vocabulary) : undefined;
  if (vocab === undefined) {
    issues.add(
      path,
      "vocabulary_missing",
      lcVocab === undefined
        ? "A term with a URI needs its vocabulary. A term with no vocabulary is a local term, and local terms have no URI."
        : `This looks like a ${lcVocab.shortLabel} URI: set the vocabulary to ${shown(lcVocab.code)}.`,
    );
    return;
  }
  if (lcVocab !== undefined && lcVocab.code !== vocab.code) {
    issues.add(
      path,
      "wrong_vocabulary",
      `This is a ${lcVocab.shortLabel} URI, but the term says it is from ${vocab.shortLabel}.`,
    );
    return;
  }
  switch (vocab.uriCheck) {
    case "none":
      issues.add(path, "local_uri", "Local terms have no URI. Leave it out.");
      return;
    case "lc_authority":
      if (!lc.ok) {
        issues.add(
          path,
          lc.code,
          `This is not a ${vocab.shortLabel} URI (${vocab.uriForm ?? ""}). ${lc.message}`,
        );
      } else if (lc.uri !== uri) {
        issues.add(path, "not_canonical", `${shown(uri)} should be stored as ${lc.uri}.`);
      }
      return;
    case "site":
      if (!NOMENCLATURE_HOSTS.has(hostOf(uri)) || portOf(uri) !== "") {
        issues.add(
          path,
          "wrong_site",
          `${shown(uri)} is not on nomenclature.info, where ${vocab.shortLabel} terms are published.`,
        );
      } else if (pathOf(uri) === "/" || pathOf(uri) === "") {
        issues.add(
          path,
          "not_a_term",
          `${shown(uri)} is the Nomenclature site itself, not one of its terms.`,
        );
      }
      return;
    case "web_address":
      // Compared by host name (any port, case or trailing dot), so an LC or
      // Nomenclature address written another way can't pass as GNIS.
      if (OTHER_VOCABULARY_HOSTS.has(looseHost(uri)) || lc.idLocGov) {
        issues.add(
          path,
          "wrong_vocabulary",
          `${shown(uri)} is from another vocabulary, not ${vocab.shortLabel}.`,
        );
      }
      return;
  }
}

function own(obj: Readonly<Record<string, JsonValue>>, key: string): JsonValue | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** The same rule the template check applies to a term's label. */
function lineProblem(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "must be text, and not empty";
  if (value.trim().length === 0) return "is only spaces";
  if (value !== value.trim()) return "starts or ends with spaces";
  if (LINE_BREAKS.test(value)) return "must be one line, with no tabs or line breaks";
  if (value.length > MAX_SHORT_TEXT_LENGTH) {
    return `can be at most ${String(MAX_SHORT_TEXT_LENGTH)} characters`;
  }
  return undefined;
}

function urlProblem(text: string): string | undefined {
  if (text.length > MAX_URL_LENGTH) {
    return `can be at most ${String(MAX_URL_LENGTH)} characters`;
  }
  return webUrlProblem(text);
}

/** Hosts whose addresses belong to a vocabulary other than GNIS. */
const OTHER_VOCABULARY_HOSTS: ReadonlySet<string> = new Set([
  "id.loc.gov",
  "www.id.loc.gov",
  ...NOMENCLATURE_HOSTS,
]);

/** The host name in lower case, without trailing dots ("ID.loc.gov." → "id.loc.gov"). */
function looseHost(uri: string): string {
  return trimEnd(hostOf(uri), ".");
}

/**
 * A key for comparing term URIs: two URIs with the same key name the same
 * term. It ignores the scheme (http or https), the case of the host name,
 * trailing dots on the host, each scheme's default port, and trailing slashes on
 * the path. It is only for comparing; stored URIs are never changed. Text
 * that isn't a web address is its own key.
 */
export function termUriKey(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return uri;
    // URL drops a scheme's own default port (80 for http, 443 for https), so
    // http://host:443 keeps its port and doesn't meet https://host.
    const port = url.port === "" ? "" : `:${url.port}`;
    const path = trimEnd(url.pathname, "/");
    return `//${trimEnd(url.hostname, ".")}${port}${path}${url.search}${url.hash}`;
  } catch {
    return uri;
  }
}

/** The port written in a web address, or "" for none or the scheme's default. */
function portOf(uri: string): string {
  try {
    return new URL(uri).port;
  } catch {
    return "";
  }
}

function pathOf(uri: string): string {
  try {
    return new URL(uri).pathname;
  } catch {
    return "";
  }
}

/** `text` without any trailing `ch` (a loop, not a regex, so it is linear). */
function trimEnd(text: string, ch: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end -= 1;
  return text.slice(0, end);
}

/** The lower-case host name of a web address that already passed `webUrlProblem`. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).hostname;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Library of Congress URIs.

/** One change `normalizeTermUri` made. */
export interface TermUriChange {
  readonly code:
    | "trimmed_spaces"
    | "lowercased"
    | "changed_scheme"
    | "removed_www"
    | "removed_file_ending"
    | "removed_trailing_slash"
    | "removed_query"
    | "removed_fragment"
    | "rwo_to_authority";
  readonly message: string;
}

export interface NormalizedTermUri {
  /** The canonical URI to store. */
  readonly uri: string;
  readonly vocabulary: VocabularyCode;
  /** What was changed to get there; empty when the input was already canonical. */
  readonly changes: readonly TermUriChange[];
}

/** The longest text `normalizeTermUri` reads. Real id.loc.gov URIs are under 70. */
export const MAX_TERM_URI_TEXT_LENGTH = 500;

/**
 * Turn a pasted id.loc.gov address for an LCSH, LCNAF or LCGFT authority into
 * its canonical URI, listing every change, or explain why it isn't one. Only
 * Library of Congress URIs are recognized: the other vocabularies' canonical
 * forms aren't confirmed (see the header). Never throws.
 */
export function normalizeTermUri(input: unknown): Validated<NormalizedTermUri> {
  const parsed = parseLcUri(input);
  if (!parsed.ok) {
    const message = parsed.idLocGov
      ? `This is not an LCSH, LCNAF or LCGFT authority URI: ${parsed.message}`
      : parsed.message;
    return { ok: false, issues: Object.freeze([lcIssue(parsed.code, message)]) };
  }
  return {
    ok: true,
    value: Object.freeze({
      uri: parsed.uri,
      vocabulary: parsed.vocabulary,
      changes: Object.freeze(parsed.changes.map((c) => Object.freeze(c))),
    }),
  };
}

function lcIssue(code: string, message: string): Issue {
  return Object.freeze({ path: Object.freeze([]), code, message });
}

type LcParsed =
  | {
      readonly ok: true;
      readonly uri: string;
      readonly vocabulary: VocabularyCode;
      readonly changes: TermUriChange[];
      readonly idLocGov: true;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly idLocGov: boolean;
    };

/** scheme, www., host, path, query, fragment. No nested repetition: linear time. */
const URI_SHAPE = /^(https?):\/\/(www\.)?([a-z0-9.-]+)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i;
/** A control number with an optional file ending such as `.html` or `.madsrdf.json`. */
const ID_WITH_ENDING = /^([A-Za-z]{0,3}[0-9]+)((?:\.[a-z]{2,10}){1,2})?$/;

function parseLcUri(input: unknown): LcParsed {
  const fail = (code: string, message: string, idLocGov = true): LcParsed => ({
    ok: false,
    code,
    message,
    idLocGov,
  });
  if (typeof input !== "string") return fail("not_text", "A URI must be text.", false);
  if (input.length > MAX_TERM_URI_TEXT_LENGTH) {
    return fail(
      "too_long",
      `A URI can be at most ${String(MAX_TERM_URI_TEXT_LENGTH)} characters.`,
      false,
    );
  }
  const problem = textProblem(input);
  if (problem !== undefined) return fail("bad_characters", `This text ${problem}.`, false);
  const changes: TermUriChange[] = [];
  const text = input.trim();
  if (text !== input) {
    changes.push({ code: "trimmed_spaces", message: "Removed spaces around the URI." });
  }
  const match = URI_SHAPE.exec(text);
  const host = (match?.[3] ?? "").toLowerCase();
  if (match === null || host !== "id.loc.gov") {
    return fail("not_lc_uri", `${shown(text)} is not an id.loc.gov address.`, false);
  }
  const [, schemeText = "", www, hostText = "", path = "", query, fragment] = match;
  const scheme = schemeText.toLowerCase();
  if (scheme !== schemeText || host !== hostText || (www !== undefined && www !== "www.")) {
    changes.push({ code: "lowercased", message: "Wrote the scheme and site name in lower case." });
  }
  if (scheme !== "http") {
    changes.push({
      code: "changed_scheme",
      message: `Changed ${scheme}:// to http://, the form id.loc.gov publishes.`,
    });
  }
  if (www !== undefined) {
    changes.push({ code: "removed_www", message: "Removed www. from the site name." });
  }

  const segments = path.split("/").slice(1);
  if (segments.length === 4 && segments[3] === "") {
    segments.pop();
    changes.push({ code: "removed_trailing_slash", message: "Removed the trailing slash." });
  }
  const [area, schemeName = "", last = "", ...rest] = segments;
  let vocab: VocabularyCode | undefined;
  if (area === "authorities") {
    vocab = LC_SCHEMES.get(schemeName);
  } else if (area === "rwo" && schemeName === "agents") {
    vocab = "lcnaf";
    changes.push({
      code: "rwo_to_authority",
      message:
        "Changed the id.loc.gov address for the person or organization itself (/rwo/agents/) to its name authority (/authorities/names/).",
    });
  }
  if (vocab === undefined || rest.length > 0 || last === "") {
    return fail(
      "unknown_lc_path",
      "id.loc.gov authority URIs look like http://id.loc.gov/authorities/subjects/sh85063195.",
    );
  }
  const idMatch = ID_WITH_ENDING.exec(last);
  if (idMatch === null) {
    return fail("invalid_lccn", `${shown(last)} is not a Library of Congress control number.`);
  }
  const [, idText = "", ending] = idMatch;
  const id = idText.toLowerCase();
  if (id !== idText) {
    changes.push({
      code: "lowercased",
      message: "Wrote the control number's letters in lower case.",
    });
  }
  const lccn = lccnProblem(id);
  if (lccn !== undefined) {
    return fail("invalid_lccn", `${shown(idText)} is not a valid control number: it ${lccn}.`);
  }
  const prefix = /^[a-z]*/.exec(id)?.[0] ?? "";
  const want = LC_PREFIX.get(vocab);
  const name = vocabulary(vocab)?.shortLabel ?? vocab;
  if (!(want?.test(prefix) ?? false)) {
    return fail(
      "wrong_prefix",
      prefix === ""
        ? `${name} control numbers start with letters.`
        : `${name} control numbers don't start with ${shown(prefix)}.`,
    );
  }
  if (ending !== undefined) {
    changes.push({
      code: "removed_file_ending",
      message: `Removed ${shown(ending)} (a file format of the page) from the end.`,
    });
  }
  if (query !== undefined) {
    changes.push({ code: "removed_query", message: `Removed ${shown(query)} from the end.` });
  }
  if (fragment !== undefined) {
    changes.push({ code: "removed_fragment", message: `Removed ${shown(fragment)} from the end.` });
  }
  const uri = `${LC_BASE}${LC_PATH.get(vocab) ?? ""}/${id}`;
  return { ok: true, uri, vocabulary: vocab, changes, idLocGov: true };
}

/**
 * Why `id` isn't a normalized LC control number, or undefined if it is. The
 * syntax from LC's "The LCCN Namespace": 8 to 12 characters, the last 8 are
 * digits; 9 characters start with a letter; 10 start with two letters or two
 * digits; 11 start with a letter then two letters or two digits; 12 start
 * with two letters then only digits. Prefix letters are lower case.
 */
function lccnProblem(id: string): string | undefined {
  if (id.length < 8 || id.length > 12) return "must be 8 to 12 characters";
  if (!/^[a-z]*[0-9]+$/.test(id) || !/[0-9]{8}$/.test(id)) {
    return "must end in 8 digits, after at most 3 lower case letters";
  }
  const letters = /^[a-z]*/.exec(id)?.[0].length ?? 0;
  const ok =
    (id.length === 8 && letters === 0) ||
    (id.length === 9 && letters === 1) ||
    (id.length === 10 && (letters === 0 || letters === 2)) ||
    (id.length === 11 && (letters === 1 || letters === 3)) ||
    (id.length === 12 && letters === 2);
  return ok ? undefined : "has the wrong number of letters for its length";
}
