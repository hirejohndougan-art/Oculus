/**
 * Rights: rightsstatements.org statements and Creative Commons tools
 * (PLATFORM_PLAN.md §1, decision D-011).
 *
 * A record's rights are stored as one canonical URI, in the `uri` of the
 * template field `rights` (`RIGHTS_FIELD_KEY`), which holds the template's
 * `rights` value shape `{ uri, note? }` (D-010, D-015). The design's rule is that a record with no
 * rights value can't be published; `rightsPublishIssues` is that check, for
 * the publishing step (T-010) to call on the record it is about to publish.
 *
 * Accepted values, taken from the issuers' own sites on 2026-11-20:
 * - The 12 statements of the rightsstatements.org vocabulary, version 1.0
 *   (https://rightsstatements.org/page/1.0/). Canonical URIs are the ones the
 *   vocabulary publishes: `http://`, the `/vocab/` path and a trailing slash,
 *   e.g. `http://rightsstatements.org/vocab/InC/1.0/`. The `/page/` address is
 *   the human-readable page; the technical requirements (v1.2.2, 2020) say it
 *   "MUST NOT be used as a substitute" in metadata.
 * - The six Creative Commons 4.0 International licenses, CC0 1.0 Universal
 *   and the Public Domain Mark 1.0, under the canonical URLs their deeds give,
 *   e.g. `https://creativecommons.org/licenses/by/4.0/`.
 * Older Creative Commons versions (1.0 to 3.0, and the national ports) are
 * recognized and reported as `unsupported_version`, not accepted (see D-011).
 *
 * Stored values must be exactly canonical. Common ways people paste the same
 * thing (https for http, `/page/` for `/vocab/`, a missing trailing slash,
 * `deed.en` or `legalcode` on the end, a `www.`) are turned into the
 * canonical URI only by `normalizeRightsUri`, which lists every change it
 * made, so a person can confirm it. Nothing else here fixes input.
 *
 * Lookups go through Maps, so text such as "constructor" can't find a built-in.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { shown, textProblem } from "./plain-data.js";
import { types } from "node:util";

export type RightsSource = "rightsstatements.org" | "creativecommons.org";

/**
 * The group a value belongs to. The first three are rightsstatements.org's own
 * groups; the last two are Creative Commons licenses and public domain tools.
 */
export type RightsCategory =
  "in_copyright" | "no_copyright" | "other" | "cc_license" | "cc_public_domain";

/** One accepted rights value. */
export interface RightsTerm {
  /** The canonical URI, the only form that is stored. */
  readonly uri: string;
  readonly source: RightsSource;
  /** The issuer's short code: `InC`, `NoC-US`, `by-nc-sa`, `zero`, `mark`. */
  readonly code: string;
  /** The issuer's full English name. */
  readonly label: string;
  /** A short name for lists and badges: `InC`, `CC BY-NC-SA 4.0`, `CC0 1.0`. */
  readonly shortLabel: string;
  readonly category: RightsCategory;
}

/** The template field that holds a record's rights value, `{ uri, note? }`. */
export const RIGHTS_FIELD_KEY = "rights";

/** The longest text `normalizeRightsUri` reads. Real URIs are under 80. */
export const MAX_RIGHTS_TEXT_LENGTH = 500;

const RS_BASE = "http://rightsstatements.org/vocab/";
const RS_VERSION = "1.0";
const CC_BASE = "https://creativecommons.org/";

function statement(code: string, label: string, category: RightsCategory): RightsTerm {
  return Object.freeze({
    uri: `${RS_BASE}${code}/${RS_VERSION}/`,
    source: "rightsstatements.org",
    code,
    label,
    shortLabel: code,
    category,
  });
}

/** The 12 rightsstatements.org statements, version 1.0, in the vocabulary's order. */
export const RIGHTS_STATEMENTS: readonly RightsTerm[] = Object.freeze([
  statement("InC", "In Copyright", "in_copyright"),
  statement("InC-OW-EU", "In Copyright - EU Orphan Work", "in_copyright"),
  statement("InC-EDU", "In Copyright - Educational Use Permitted", "in_copyright"),
  statement("InC-NC", "In Copyright - Non-Commercial Use Permitted", "in_copyright"),
  statement(
    "InC-RUU",
    "In Copyright - Rights-holder(s) Unlocatable or Unidentifiable",
    "in_copyright",
  ),
  statement("NoC-CR", "No Copyright - Contractual Restrictions", "no_copyright"),
  statement("NoC-NC", "No Copyright - Non-Commercial Use Only", "no_copyright"),
  statement("NoC-OKLR", "No Copyright - Other Known Legal Restrictions", "no_copyright"),
  statement("NoC-US", "No Copyright - United States", "no_copyright"),
  statement("CNE", "Copyright Not Evaluated", "other"),
  statement("UND", "Copyright Undetermined", "other"),
  statement("NKC", "No Known Copyright", "other"),
]);

function license(code: string, name: string): RightsTerm {
  return Object.freeze({
    uri: `${CC_BASE}licenses/${code}/4.0/`,
    source: "creativecommons.org",
    code,
    label: `${name} 4.0 International`,
    shortLabel: `CC ${code.toUpperCase()} 4.0`,
    category: "cc_license",
  });
}

/** The Creative Commons 4.0 licenses, then CC0 and the Public Domain Mark. */
export const CREATIVE_COMMONS: readonly RightsTerm[] = Object.freeze([
  license("by", "Attribution"),
  license("by-sa", "Attribution-ShareAlike"),
  license("by-nd", "Attribution-NoDerivatives"),
  license("by-nc", "Attribution-NonCommercial"),
  license("by-nc-sa", "Attribution-NonCommercial-ShareAlike"),
  license("by-nc-nd", "Attribution-NonCommercial-NoDerivatives"),
  Object.freeze({
    uri: `${CC_BASE}publicdomain/zero/1.0/`,
    source: "creativecommons.org",
    code: "zero",
    label: "CC0 1.0 Universal",
    shortLabel: "CC0 1.0",
    category: "cc_public_domain",
  } as const),
  Object.freeze({
    uri: `${CC_BASE}publicdomain/mark/1.0/`,
    source: "creativecommons.org",
    code: "mark",
    label: "Public Domain Mark 1.0 Universal",
    shortLabel: "PDM 1.0",
    category: "cc_public_domain",
  } as const),
]);

/** Every accepted value: the statements first, then Creative Commons. */
export const RIGHTS_TERMS: readonly RightsTerm[] = Object.freeze([
  ...RIGHTS_STATEMENTS,
  ...CREATIVE_COMMONS,
]);

const BY_URI: ReadonlyMap<string, RightsTerm> = new Map(RIGHTS_TERMS.map((t) => [t.uri, t]));
const STATEMENT_BY_CODE: ReadonlyMap<string, RightsTerm> = new Map(
  RIGHTS_STATEMENTS.map((t) => [t.code, t]),
);
const CC_LICENSE_BY_CODE: ReadonlyMap<string, RightsTerm> = new Map(
  CREATIVE_COMMONS.filter((t) => t.category === "cc_license").map((t) => [t.code, t]),
);
const CC_PUBLIC_DOMAIN_BY_CODE: ReadonlyMap<string, RightsTerm> = new Map(
  CREATIVE_COMMONS.filter((t) => t.category === "cc_public_domain").map((t) => [t.code, t]),
);
/**
 * License codes Creative Commons used in versions 1.0 to 3.0, so an older
 * license is reported as an unsupported version rather than as unknown.
 * Version 1.0 also had nd-nc, by-nd-nc, sa, nc, nd and nc-sa.
 */
const OLDER_CC_CODES: ReadonlySet<string> = new Set([
  ...CC_LICENSE_BY_CODE.keys(),
  "by-nd-nc",
  "nd-nc",
  "nc-sa",
  "nc",
  "nd",
  "sa",
]);

// ---------------------------------------------------------------------------

/** The accepted value with exactly this canonical URI, or undefined. */
export function rightsTerm(uri: unknown): RightsTerm | undefined {
  return typeof uri === "string" ? BY_URI.get(uri) : undefined;
}

/** True if `value` is exactly the canonical URI of an accepted value. */
export function isRightsUri(value: unknown): value is string {
  return rightsTerm(value) !== undefined;
}

/**
 * Check a value about to be stored. Only an exact canonical URI is accepted;
 * a recognizable variant is refused with `not_canonical`, and the message
 * names the canonical form. Never throws.
 */
export function validateRightsUri(value: unknown): Validated<RightsTerm> {
  const term = rightsTerm(value);
  if (term !== undefined) return { ok: true, value: term };
  return { ok: false, issues: Object.freeze([explain(value, [])]) };
}

/** One change `normalizeRightsUri` made. */
export interface RightsChange {
  readonly code:
    | "trimmed_spaces"
    | "lowercased"
    | "changed_scheme"
    | "removed_www"
    | "page_to_vocab"
    | "removed_page_suffix"
    | "removed_query"
    | "removed_fragment"
    | "added_trailing_slash";
  readonly message: string;
}

export interface NormalizedRights {
  /** The canonical URI to store. */
  readonly uri: string;
  readonly term: RightsTerm;
  /** What was changed to get there; empty when the input was already canonical. */
  readonly changes: readonly RightsChange[];
}

/**
 * Turn a pasted rights URI into the canonical one, reporting every change, or
 * explain why it isn't an accepted value. Never throws.
 */
export function normalizeRightsUri(input: unknown): Validated<NormalizedRights> {
  const parsed = parse(input);
  if (!parsed.ok) return { ok: false, issues: Object.freeze([parsed.issue]) };
  return {
    ok: true,
    value: Object.freeze({
      uri: parsed.term.uri,
      term: parsed.term,
      changes: Object.freeze(parsed.changes.map((c) => Object.freeze(c))),
    }),
  };
}

/**
 * The record kinds that hold copyrightable content, and so need a rights value
 * before they can be published (D-011). Agents, places and events don't.
 */
export const RIGHTS_REQUIRED_KINDS = Object.freeze([
  "object",
  "archival_unit",
  "digital_asset",
] as const);
/** Kinds the rule doesn't apply to. Any other kind, or none, is checked (fail closed). */
const RIGHTS_EXEMPT_KINDS: ReadonlySet<string> = new Set(["agent", "place", "event"]);

/**
 * The publishing rule: the problems that keep a record's rights from being
 * published, or an empty list if there are none. An object, archival unit or
 * digital asset needs `fields.rights` to be `{ uri, note? }` with an
 * accepted, canonical `uri`; a plain string there is refused (`not_an_object`),
 * so the old shape can't slip through. Unknown properties and a `note` that
 * isn't text are refused too, as the template does, so this rule stands on
 * its own. The note is published with the URI; agent,
 * place and event records need none. A record with any other kind, or none,
 * is checked as if it needed one.
 *
 * Call it on the exact frozen copy that will be published (the validated
 * record, or once inheritance exists the effective record from T-008), not on
 * an object that will be copied or changed afterwards. Only own, enumerable
 * data properties count; getters, hidden properties and Proxies are reported
 * as unreadable. Never throws.
 */
export function rightsPublishIssues(record: unknown): readonly Issue[] {
  const path = ["fields", RIGHTS_FIELD_KEY] as const;
  const unreadable = Object.freeze([
    issue([...path], "unreadable", "The rights value could not be read as plain data."),
  ]);
  try {
    // A Proxy could answer differently each time it is asked, so it isn't read at all.
    if (types.isProxy(record)) return unreadable;
    const kind = ownValue(record, "kind");
    if (typeof kind === "string" && RIGHTS_EXEMPT_KINDS.has(kind)) return Object.freeze([]);
    const fields = ownValue(record, "fields");
    if (types.isProxy(fields)) return unreadable;
    if (!isPlainObject(fields)) {
      return Object.freeze([issue(["fields"], "not_an_object", "fields must be an object.")]);
    }
    const value = ownValue(fields, RIGHTS_FIELD_KEY);
    if (value === undefined || value === null) return Object.freeze([explain(undefined, path)]);
    if (types.isProxy(value)) return unreadable;
    if (!isPlainObject(value)) {
      return Object.freeze([
        issue(
          [...path],
          "not_an_object",
          typeof value === "string"
            ? `The rights value must be { uri, note? }, not text on its own: store ${shown(value)} as its uri.`
            : "The rights value must be { uri, note? }.",
        ),
      ]);
    }
    // The same shape the template's rights kind requires, checked again here
    // so publishing doesn't depend on the template check having run.
    const found: Issue[] = [];
    for (const key of Object.keys(value)) {
      if (key !== "uri" && key !== "note") {
        found.push(
          issue(
            [...path, key],
            "unknown_property",
            `${shown(key)} is not a property of a rights value, which is { uri, note? }.`,
          ),
        );
      }
    }
    const note = ownValue(value, "note");
    if (note !== undefined) {
      const problem = noteProblem(note);
      if (problem !== undefined)
        found.push(issue([...path, "note"], problem.code, problem.message));
    }
    const uri = ownValue(value, "uri");
    if (rightsTerm(uri) === undefined) found.push(explain(uri, [...path, "uri"]));
    return Object.freeze(found);
  } catch {
    // Only a hostile input gets here.
    return unreadable;
  }
}

/**
 * The longest a rights note may be: the same as the template's limit for
 * help text and notes (`MAX_HELP_LENGTH`).
 */
export const MAX_RIGHTS_NOTE_LENGTH = 2000;

/** Why a rights note can't be published, or undefined. The template's rules, plus `textProblem`. */
function noteProblem(note: unknown): { code: string; message: string } | undefined {
  if (typeof note !== "string" || note.trim().length === 0) {
    return { code: "invalid_text", message: "The rights note must be text, or be left out." };
  }
  if (note.length > MAX_RIGHTS_NOTE_LENGTH) {
    return {
      code: "too_long",
      message: `The rights note can be at most ${String(MAX_RIGHTS_NOTE_LENGTH)} characters.`,
    };
  }
  const problem = textProblem(note);
  if (problem !== undefined)
    return { code: "bad_characters", message: `The rights note ${problem}.` };
  return undefined;
}

/** True when `rightsPublishIssues` finds nothing. */
export function canPublishRights(record: unknown): boolean {
  return rightsPublishIssues(record).length === 0;
}

// ---------------------------------------------------------------------------

/**
 * An own, enumerable data property of `obj`, or undefined when there is none.
 * Never runs a getter or reads inherited values. A getter or a hidden
 * (non-enumerable) property isn't plain data: JSON output would drop a hidden
 * one, so it throws and the caller reports the value as unreadable.
 */
function ownValue(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError("not plain data");
  }
  return descriptor.value;
}

/** The issue for a value that isn't an exact canonical URI. */
function explain(value: unknown, path: readonly (string | number)[]): Issue {
  if (value === undefined || value === null || value === "") {
    return issue(
      path,
      "rights_missing",
      "Choose a rights statement or license before this record can be published.",
    );
  }
  const parsed = parse(value);
  if (parsed.ok) {
    return issue(
      path,
      "not_canonical",
      `${shown(value)} should be stored as ${parsed.term.uri} (${parsed.term.label}).`,
    );
  }
  return { ...parsed.issue, path };
}

type Parsed =
  | { readonly ok: true; readonly term: RightsTerm; readonly changes: RightsChange[] }
  | { readonly ok: false; readonly issue: Issue };

const NOT_RIGHTS =
  "is not a rightsstatements.org statement or a Creative Commons license or public domain tool.";

/**
 * scheme, www., host, path, query, fragment. No nested repetition, so the
 * match takes linear time; the length was checked first anyway.
 */
const URI_SHAPE = /^(https?):\/\/(www\.)?([a-z.]+)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i;
/** `deed`, `legalcode`, an optional language (`.en`, `.zh-hans`) and an optional `.txt`. */
const CC_SUFFIX = /^(?:deed|legalcode)(?:\.[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)?(?:\.txt)?$/;
/** The license versions Creative Commons published before 4.0. */
const OLD_CC_VERSION = /^(?:1\.0|2\.0|2\.1|2\.5|3\.0)$/;

function parse(input: unknown): Parsed {
  const fail = (code: string, message: string): Parsed => ({
    ok: false,
    issue: issue([], code, message),
  });
  if (typeof input !== "string") return fail("not_text", "A rights value must be text (a URI).");
  if (input.length > MAX_RIGHTS_TEXT_LENGTH) {
    return fail(
      "too_long",
      `A rights URI can be at most ${String(MAX_RIGHTS_TEXT_LENGTH)} characters.`,
    );
  }
  const problem = textProblem(input);
  if (problem !== undefined) return fail("bad_characters", `This text ${problem}.`);

  const changes: RightsChange[] = [];
  const text = input.trim();
  if (text.length === 0) {
    return fail("rights_missing", "Choose a rights statement or license.");
  }
  if (text !== input) {
    changes.push({ code: "trimmed_spaces", message: "Removed spaces around the URI." });
  }
  const match = URI_SHAPE.exec(text);
  if (match === null) return fail("unknown_rights", `${shown(text)} ${NOT_RIGHTS}`);
  const [, schemeText = "", www, hostText = "", path = "", query, fragment] = match;
  const scheme = schemeText.toLowerCase();
  const host = hostText.toLowerCase();
  if (scheme !== schemeText || host !== hostText || (www !== undefined && www !== "www.")) {
    changes.push({ code: "lowercased", message: "Wrote the scheme and site name in lower case." });
  }
  if (www !== undefined) {
    changes.push({ code: "removed_www", message: "Removed www. from the site name." });
  }

  const segments = path.split("/").slice(1);
  const slash = segments.length > 0 && segments[segments.length - 1] === "";
  if (slash) segments.pop();

  let found: { term: RightsTerm; pageToVocab: boolean; suffix: boolean } | Parsed;
  if (host === "rightsstatements.org") found = statementFrom(segments, text);
  else if (host === "creativecommons.org") found = creativeCommonsFrom(segments, text);
  else return fail("unknown_rights", `${shown(text)} ${NOT_RIGHTS}`);
  if ("ok" in found) return found;
  const { term } = found;

  const wantScheme = term.uri.slice(0, term.uri.indexOf(":"));
  if (scheme !== wantScheme) {
    changes.push({
      code: "changed_scheme",
      message: `Changed ${scheme}:// to ${wantScheme}://, the form ${term.source} publishes.`,
    });
  }
  if (found.pageToVocab) {
    changes.push({
      code: "page_to_vocab",
      message: "Changed /page/ (the web page) to /vocab/ (the statement's URI).",
    });
  }
  if (found.suffix) {
    changes.push({
      code: "removed_page_suffix",
      message: `Removed ${shown(segments[segments.length - 1])} (the license's deed or legal text) from the end.`,
    });
  }
  if (query !== undefined) {
    changes.push({ code: "removed_query", message: `Removed ${shown(query)} from the end.` });
  }
  if (fragment !== undefined) {
    changes.push({ code: "removed_fragment", message: `Removed ${shown(fragment)} from the end.` });
  }
  if (!slash && !found.suffix) {
    changes.push({ code: "added_trailing_slash", message: "Added the trailing slash." });
  }
  return { ok: true, term, changes };
}

function statementFrom(
  segments: readonly string[],
  text: string,
): { term: RightsTerm; pageToVocab: boolean; suffix: boolean } | Parsed {
  const [kind, code, version, ...rest] = segments;
  const term = code === undefined ? undefined : STATEMENT_BY_CODE.get(code);
  if ((kind !== "vocab" && kind !== "page") || term === undefined || rest.length > 0) {
    return unknown(text);
  }
  if (version !== RS_VERSION) {
    return {
      ok: false,
      issue: issue(
        [],
        "unsupported_version",
        `Only version ${RS_VERSION} of the rightsstatements.org statements is accepted: use ${term.uri}.`,
      ),
    };
  }
  return { term, pageToVocab: kind === "page", suffix: false };
}

function creativeCommonsFrom(
  segments: readonly string[],
  text: string,
): { term: RightsTerm; pageToVocab: boolean; suffix: boolean } | Parsed {
  const [kind, code = "", version = "", ...rest] = segments;
  const last = rest[rest.length - 1];
  const suffix = last !== undefined && CC_SUFFIX.test(last);
  const extra = suffix ? rest.length - 1 : rest.length;

  if (kind === "licenses") {
    const term = CC_LICENSE_BY_CODE.get(code);
    if (term !== undefined && version === "4.0" && extra === 0) {
      return { term, pageToVocab: false, suffix };
    }
    const ported =
      term !== undefined && version === "4.0" && extra === 1 && /^[a-z]{2,3}$/.test(rest[0] ?? "");
    if (ported || (OLDER_CC_CODES.has(code) && OLD_CC_VERSION.test(version))) {
      return {
        ok: false,
        issue: issue(
          [],
          "unsupported_version",
          version === "4.0"
            ? "Creative Commons 4.0 licenses have no national versions: use the International one."
            : `Creative Commons ${version} licenses aren't accepted yet; only the 4.0 International licenses, CC0 and the Public Domain Mark are.`,
        ),
      };
    }
    return unknown(text);
  }
  if (kind === "publicdomain") {
    const term = CC_PUBLIC_DOMAIN_BY_CODE.get(code);
    if (term !== undefined && version === "1.0" && extra === 0) {
      return { term, pageToVocab: false, suffix };
    }
  }
  return unknown(text);
}

function unknown(text: string): Parsed {
  return { ok: false, issue: issue([], "unknown_rights", `${shown(text)} ${NOT_RIGHTS}`) };
}
