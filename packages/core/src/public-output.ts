/**
 * Public output: Dublin Core and JSON-LD for a published record (T-010,
 * decision D-016).
 *
 * This is the boundary where catalog data leaves for the public, so it trusts
 * nothing it is given and builds output from as little as possible:
 *
 * - **The input is a public view, and only a real one.** `publicOutput` takes
 *   what `publicView(effective)` returned (D-013), recognised by the mark
 *   `effective.ts` keeps beside it (`effective-brand.ts`), never by its shape.
 *   A copy, a Proxy or a hand-made object is refused (`not_public_view`).
 *   From the mark it finds the effective record and runs
 *   `effectivePublishIssues` itself; if that finds anything, nothing is
 *   produced. There is no "publish anyway".
 * - **Only mapped public entries go out.** The caller's Dublin Core mapping is
 *   checked with `validateDublinCoreMapping` against the exact template the
 *   view was built with, every time (a mapping for another template, or one
 *   naming a staff field, is refused). Output holds the record's title, its
 *   URL, and the values of the view's entries that the mapping maps. Nothing
 *   else is read: no notes, no `from`, no ancestors, no labels, no stored
 *   record, no identifier types, no list option codes.
 * - **Publishing is the caller's statement.** Records have no publish state
 *   yet, so the caller passes `published`, the IDs of every record that is
 *   published. The record itself must be in it (`not_published`). A place
 *   value's `recordId` becomes a link only when that record is in it;
 *   otherwise the place goes out as its name (and gazetteer URI) alone, so
 *   output never reveals that an unpublished record exists or what its ID is.
 * - **Every field kind is handled explicitly, and checked again here,**
 *   because own values reach the view without a template check (D-013):
 *   text and long text as the text; a date as its EDTF text (checked with
 *   `parseEdtf`); a list choice as its option's label; a controlled term as
 *   its label, with its URI as `@id` in JSON-LD; an identifier as its value
 *   only; a link as its URL; rights as the statement's URI (`{"@id": uri}` in
 *   JSON-LD; the note is not output); a place as its name, with an `@id` from
 *   its URI or a published place record. A value of the wrong shape, an
 *   unknown property, a list value the template doesn't offer or a URL that
 *   isn't plain http(s) refuses the whole output (`invalid_value`): nothing
 *   is guessed or dropped quietly.
 *
 * Three forms come out of one call, from the same checked values:
 * - `dublinCore`: term → list of text, using the DCMI Metadata Terms names
 *   (`title`, `created`, `spatial` …).
 * - `jsonLd` (and `jsonLdText`): a compacted JSON-LD document with an inline
 *   `@context` for `dcterms:`, `dcmitype:` and `rdfs:`, `@id` from the
 *   caller's base URL plus the record ID, and an `@type` from the record's
 *   kind (see `TYPE_FOR`). Keys are only ever `@context`, `@id`, `@type` and
 *   `dcterms:<term>` from the closed list in `dublin-core.ts`; text values
 *   are JSON strings, never objects, so text such as `"@id"` stays text.
 *   `jsonLdText` also writes `<`, `>`, `&`, U+2028 and U+2029 as `\u` escapes,
 *   so it can sit inside a `<script type="application/ld+json">` element.
 * - `oaiDcXml`: the OAI-PMH `oai_dc` record (the 15 Dublin Core elements).
 *   Refined terms are written as the element they refine (`created` as
 *   `dc:date`, `spatial` as `dc:coverage`); `rightsHolder` and `provenance`
 *   refine no element and are left out of this form only. Text is escaped
 *   (`& < > " '`, and carriage return as `&#13;`), and any character XML 1.0
 *   doesn't allow (most control characters, lone surrogates, U+FFFE, U+FFFF)
 *   refuses the output in every form (`bad_characters`).
 *
 * Output is capped at MAX_OUTPUT_CHARS characters of values. Nothing here
 * throws; every problem comes back as issues.
 */
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { shown, type JsonValue } from "./plain-data.js";
import { publicViewOrigin } from "./effective-brand.js";
import {
  MAX_RECORD_SET,
  effectivePublishIssues,
  type EffectiveRecord,
  type PublicRecord,
} from "./effective.js";
import {
  DCTERMS_NAMESPACE,
  validateDublinCoreMapping,
  type DublinCoreTerm,
} from "./dublin-core.js";
import { parseEdtf } from "./edtf.js";
import { rightsTerm } from "./rights.js";
import { isRecordId, type RecordId } from "./record-id.js";
import type { ArchivalLevel, RecordKind } from "./records.js";
import { MAX_REPEATS, MAX_URL_LENGTH, type FieldDefinition } from "./templates.js";

export const DCMITYPE_NAMESPACE = "http://purl.org/dc/dcmitype/";
export const RDFS_NAMESPACE = "http://www.w3.org/2000/01/rdf-schema#";
export const DC_ELEMENTS_NAMESPACE = "http://purl.org/dc/elements/1.1/";
export const OAI_DC_NAMESPACE = "http://www.openarchives.org/OAI/2.0/oai_dc/";
export const OAI_DC_SCHEMA = "http://www.openarchives.org/OAI/2.0/oai_dc.xsd";

/** The longest a base URL may be. */
export const MAX_BASE_URL_LENGTH = MAX_URL_LENGTH;
/** The most characters of values (title, text, URLs) one output may hold. */
export const MAX_OUTPUT_CHARS = 5_000_000;

export interface PublishOptions {
  /**
   * The URL records are published under, ending in `/`; the record's `@id`
   * is this plus its ID. Must be http or https, with no user name, password,
   * query or fragment, written the way a URL parser writes it back.
   */
  readonly baseUrl: string;
  /** The IDs of every published record. The record itself must be one. */
  readonly published: readonly RecordId[];
}

/** Dublin Core as term → values, title first, then in mapping order. */
export type DublinCoreValues = Readonly<Partial<Record<DublinCoreTerm, readonly string[]>>>;

export interface PublicOutput {
  /** The record's public URL: `baseUrl` + ID, the JSON-LD `@id`. */
  readonly id: string;
  readonly dublinCore: DublinCoreValues;
  /** A compacted JSON-LD document with an inline context. */
  readonly jsonLd: Readonly<Record<string, JsonValue>>;
  /** `jsonLd` as JSON text, safe inside an HTML script element. */
  readonly jsonLdText: string;
  /** The record as an OAI-PMH `oai_dc:dc` XML document. */
  readonly oaiDcXml: string;
}

/**
 * The `@type` for each kind (DCMI Type Vocabulary and DCMI Metadata Terms
 * classes). An archival unit above item level is a `Collection`. An archival
 * item and a digital asset could be text, an image, a sound and more, which
 * the kind doesn't say, so they get no `@type`; a mapped `type` field still
 * says what they are.
 */
const TYPE_FOR: ReadonlyMap<RecordKind, string> = new Map<RecordKind, string>([
  ["object", "dcmitype:PhysicalObject"],
  ["archival_unit", "dcmitype:Collection"],
  ["event", "dcmitype:Event"],
  ["agent", "dcterms:Agent"],
  ["place", "dcterms:Location"],
]);

/** The `oai_dc` element each term is written as: itself, or the element it refines. */
const OAI_DC_ELEMENT: ReadonlyMap<DublinCoreTerm, string | undefined> = new Map<
  DublinCoreTerm,
  string | undefined
>([
  ["title", "title"],
  ["alternative", "title"],
  ["creator", "creator"],
  ["contributor", "contributor"],
  ["publisher", "publisher"],
  ["date", "date"],
  ["created", "date"],
  ["description", "description"],
  ["abstract", "description"],
  ["type", "type"],
  ["format", "format"],
  ["extent", "format"],
  ["medium", "format"],
  ["identifier", "identifier"],
  ["bibliographicCitation", "identifier"],
  ["source", "source"],
  ["language", "language"],
  ["relation", "relation"],
  ["isPartOf", "relation"],
  ["hasPart", "relation"],
  ["isFormatOf", "relation"],
  ["hasFormat", "relation"],
  ["coverage", "coverage"],
  ["spatial", "coverage"],
  ["temporal", "coverage"],
  ["subject", "subject"],
  ["rights", "rights"],
  ["accessRights", "rights"],
  ["license", "rights"],
  ["rightsHolder", undefined],
  ["provenance", undefined],
]);

// ---------------------------------------------------------------------------

/** Thrown inside this module only; `publicOutput` turns it into issues. */
class OutputError extends Error {
  constructor(readonly issues: readonly Issue[]) {
    super("public output refused");
  }
}

function fail(path: readonly (string | number)[], code: string, message: string): never {
  throw new OutputError([issue(path, code, message)]);
}

/** One checked value: its text, and for JSON-LD an IRI (with the text as its label, or not). */
interface OutValue {
  readonly text: string;
  readonly iri?: string;
  readonly labelled: boolean;
}

interface Budget {
  chars: number;
}

/**
 * Dublin Core, JSON-LD and `oai_dc` XML for one published record (see the
 * module header). `view` must be what `publicView` returned, `mapping` a
 * Dublin Core mapping for the template that record uses, and `options` the
 * base URL and the published record IDs. Fails, with every reason found
 * where there are several, when anything is off. Never throws.
 */
export function publicOutput(
  view: PublicRecord,
  mapping: unknown,
  options: PublishOptions,
): Validated<PublicOutput> {
  try {
    return { ok: true, value: build(view, mapping, options) };
  } catch (error) {
    const issues =
      error instanceof OutputError
        ? error.issues
        : [issue([], "unreadable", "The public output could not be made from this data.")];
    return Object.freeze({
      ok: false,
      issues: Object.freeze(issues.map((i) => Object.freeze(i))),
    });
  }
}

function build(view: PublicRecord, mapping: unknown, options: PublishOptions): PublicOutput {
  const origin = publicViewOrigin(view);
  if (origin === undefined) {
    fail(
      [],
      "not_public_view",
      "This is not a public view from publicView, so it can't be published.",
    );
  }
  const { baseUrl, published } = readOptions(options);
  if (!published.has(view.id)) {
    fail([], "not_published", "This record is not in the published list, so it can't be output.");
  }
  // The effective record the view was made from, from the mark beside it.
  const blocked = effectivePublishIssues(origin.effective as EffectiveRecord);
  if (blocked.length > 0) throw new OutputError(blocked);
  const checked = validateDublinCoreMapping(mapping, origin.template);
  if (!checked.ok) throw new OutputError(checked.issues);

  const byKey = new Map<string, FieldDefinition>();
  for (const field of origin.template.fields) byKey.set(field.key, field);
  const entries = new Map<string, JsonValue>();
  for (const entry of view.entries) entries.set(entry.key, entry.value);

  const budget: Budget = { chars: 0 };
  const recordUrl = baseUrl + view.id;
  const terms = new Map<DublinCoreTerm, OutValue[]>();
  terms.set("title", [{ text: safeText(view.title, ["title"], budget), labelled: false }]);
  for (const { field, term } of checked.value.entries) {
    const value = entries.get(field);
    // Not in the view: empty, staff only along the way, or not inherited.
    if (value === undefined) continue;
    const def = byKey.get(field);
    // The mapping check refuses staff fields; checked again here, at the boundary.
    if (def?.visibility !== "public") {
      fail(["fields", field], "staff_field", "Only public template fields can be published.");
    }
    const values = valuesOf(value, def, { baseUrl, published, budget });
    const list = terms.get(term);
    if (list === undefined) terms.set(term, values);
    else list.push(...values);
  }

  safeText(recordUrl, ["id"], budget);
  const dublinCore = Object.freeze(
    Object.fromEntries(
      [...terms].map(([term, values]) => [term, Object.freeze(values.map((v) => v.text))]),
    ),
  ) as DublinCoreValues;
  const jsonLd = jsonLdDocument(recordUrl, typeFor(view.kind, origin.level), terms);
  return Object.freeze({
    id: recordUrl,
    dublinCore,
    jsonLd,
    jsonLdText: scriptSafeJson(jsonLd),
    oaiDcXml: oaiDc(terms),
  });
}

function typeFor(kind: RecordKind, level: ArchivalLevel | undefined): string | undefined {
  if (kind === "archival_unit" && (level === undefined || level === "item")) return undefined;
  return TYPE_FOR.get(kind);
}

// ---------------------------------------------------------------------------
// Options.

const OPTION_KEYS: ReadonlySet<string> = new Set(["baseUrl", "published"]);

interface ReadOptions {
  readonly baseUrl: string;
  readonly published: ReadonlySet<RecordId>;
}

function readOptions(options: unknown): ReadOptions {
  if (types.isProxy(options) || !isPlainObject(options)) {
    fail([], "invalid_options", "The options must be a plain object { baseUrl, published }.");
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !OPTION_KEYS.has(key)) {
      fail([], "invalid_options", `${shown(String(key))} is not an option here.`);
    }
  }
  const baseUrl = checkBaseUrl(dataProp(options, "baseUrl"));
  const published = readPublished(dataProp(options, "published"));
  return { baseUrl, published };
}

/** An own data property, or undefined. A getter, hidden property or Proxy value fails. */
function dataProp(obj: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return undefined;
  if (!("value" in d) || d.enumerable !== true) {
    fail([key], "invalid_options", `The ${key} option must be plain data, not a getter.`);
  }
  const value: unknown = d.value;
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    fail([key], "invalid_options", `The ${key} option can't be a Proxy.`);
  }
  return value;
}

function checkBaseUrl(value: unknown): string {
  const bad = (why: string): never =>
    fail(["baseUrl"], "invalid_base_url", `The base URL ${shown(value)} ${why}.`);
  if (typeof value !== "string") return bad("must be text");
  if (value.length > MAX_BASE_URL_LENGTH) {
    return bad(`can be at most ${String(MAX_BASE_URL_LENGTH)} characters`);
  }
  if (/[\s\\]/.test(value) || NOT_XML_CHAR.test(value)) {
    return bad("can't hold spaces, backslashes or control characters");
  }
  if (value.includes("?") || value.includes("#")) return bad("can't have a query or fragment");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad("is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return bad("must be http or https");
  if (url.username !== "" || url.password !== "") return bad("can't hold a user name or password");
  if (url.href !== value) return bad(`must be written as ${shown(url.href)}`);
  if (!url.pathname.endsWith("/")) return bad("must end with /");
  return value;
}

function readPublished(value: unknown): ReadonlySet<RecordId> {
  if (!Array.isArray(value)) {
    fail(["published"], "invalid_published", "published must be a list of record IDs.");
  }
  const list: readonly unknown[] = value;
  const length = list.length;
  if (length > MAX_RECORD_SET) {
    fail(
      ["published"],
      "invalid_published",
      `published can list at most ${String(MAX_RECORD_SET)} records.`,
    );
  }
  const ids = new Set<RecordId>();
  for (let i = 0; i < length; i += 1) {
    // Read each slot as a plain data property, so a getter can't run.
    const d = Object.getOwnPropertyDescriptor(list, i);
    const id: unknown = d !== undefined && "value" in d ? d.value : undefined;
    if (!isRecordId(id)) {
      fail(["published", i], "invalid_published", `Entry ${String(i)} is not a record ID.`);
    }
    ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Values, one kind at a time.

interface Context {
  readonly baseUrl: string;
  readonly published: ReadonlySet<RecordId>;
  readonly budget: Budget;
}

function valuesOf(value: JsonValue, def: FieldDefinition, ctx: Context): OutValue[] {
  const path = ["fields", def.key];
  const invalid = (): never =>
    fail(
      path,
      "invalid_value",
      `${shown(def.label)} doesn't hold a valid ${def.kind.replace("_", " ")} value, so the record can't be published. Check it with checkRecordAgainstTemplate.`,
    );
  let list: readonly JsonValue[];
  if (def.repeatable) {
    if (!Array.isArray(value)) return invalid();
    list = value as readonly JsonValue[];
    if (list.length === 0 || list.length > MAX_REPEATS) return invalid();
  } else {
    if (Array.isArray(value)) return invalid();
    list = [value];
  }
  return list.map((one, i) => {
    const out = valueOf(one, def, ctx, invalid);
    const where = def.repeatable ? [...path, i] : path;
    safeText(out.text, where, ctx.budget);
    if (out.iri !== undefined && out.iri !== out.text) safeText(out.iri, where, ctx.budget);
    return out;
  });
}

function valueOf(
  value: JsonValue,
  def: FieldDefinition,
  ctx: Context,
  invalid: () => never,
): OutValue {
  switch (def.kind) {
    case "text":
    case "long_text":
      return { text: nonBlank(value, invalid), labelled: false };
    case "date": {
      const text = nonBlank(value, invalid);
      if (!parseEdtf(text).ok) return invalid();
      return { text, labelled: false };
    }
    case "list": {
      const code = nonBlank(value, invalid);
      const option = (def.options ?? []).find((o) => o.value === code);
      if (option === undefined) return invalid();
      return { text: option.label, labelled: false };
    }
    case "controlled_term": {
      const term = props(value, TERM_KEYS, invalid);
      const label = nonBlank(term.get("label"), invalid);
      const uri = optionalIri(term.get("uri"), invalid);
      const vocabulary = term.get("vocabulary");
      if (vocabulary !== undefined && typeof vocabulary !== "string") return invalid();
      return uri === undefined
        ? { text: label, labelled: false }
        : { text: label, iri: uri, labelled: true };
    }
    case "identifier": {
      // Only the value: identifier types are staff only (T-004 review).
      const id = props(value, IDENTIFIER_KEYS, invalid);
      if (typeof id.get("type") !== "string") return invalid();
      return { text: nonBlank(id.get("value"), invalid), labelled: false };
    }
    case "link": {
      const link = props(value, LINK_KEYS, invalid);
      const label = link.get("label");
      if (label !== undefined && typeof label !== "string") return invalid();
      const url = optionalIri(link.get("url"), invalid);
      if (url === undefined) return invalid();
      return { text: url, iri: url, labelled: false };
    }
    case "rights": {
      const rights = props(value, RIGHTS_KEYS, invalid);
      const uri = rights.get("uri");
      // The note is not output (D-016).
      if (typeof uri !== "string" || rightsTerm(uri) === undefined) return invalid();
      return { text: uri, iri: uri, labelled: false };
    }
    case "place": {
      const place = props(value, PLACE_KEYS, invalid);
      const label = nonBlank(place.get("label"), invalid);
      const uri = optionalIri(place.get("uri"), invalid);
      const recordId = place.get("recordId");
      if (recordId !== undefined && !isRecordId(recordId)) return invalid();
      if (uri !== undefined) return { text: label, iri: uri, labelled: true };
      // A place record is linked only when it is published; otherwise its
      // existence and ID stay unsaid.
      if (recordId !== undefined && ctx.published.has(recordId)) {
        return { text: label, iri: ctx.baseUrl + recordId, labelled: true };
      }
      return { text: label, labelled: false };
    }
  }
}

const TERM_KEYS: ReadonlySet<string> = new Set(["label", "uri", "vocabulary"]);
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(["type", "value"]);
const LINK_KEYS: ReadonlySet<string> = new Set(["url", "label"]);
const RIGHTS_KEYS: ReadonlySet<string> = new Set(["uri", "note"]);
const PLACE_KEYS: ReadonlySet<string> = new Set(["label", "uri", "recordId"]);

/** The own data properties of a plain object, all of them in `allowed`, or invalid. */
function props(
  value: JsonValue,
  allowed: ReadonlySet<string>,
  invalid: () => never,
): ReadonlyMap<string, unknown> {
  if (types.isProxy(value) || !isPlainObject(value)) return invalid();
  const found = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return invalid();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return invalid();
    found.set(key, d.value);
  }
  return found;
}

function nonBlank(value: unknown, invalid: () => never): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid();
  return value;
}

/** Characters an IRI can't hold as they are (RFC 3987), plus backslash. */
const NOT_IN_IRI = /[\s<>"{}|\\^`]/;

/** An absolute http(s) URL with no user name or password, as stored; or undefined when absent. */
function optionalIri(value: unknown, invalid: () => never): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || NOT_IN_IRI.test(value)) {
    return invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid();
  if (url.username !== "" || url.password !== "") return invalid();
  return value;
}

/**
 * Anything outside XML 1.0's `Char` production: C0 controls other than tab,
 * line feed and carriage return, lone surrogates, U+FFFE and U+FFFF.
 */
const NOT_XML_CHAR = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;

/** Text that may go out in every form, counted against the output budget. */
function safeText(text: string, path: readonly (string | number)[], budget: Budget): string {
  if (NOT_XML_CHAR.test(text)) {
    fail(
      path,
      "bad_characters",
      "This value holds a character XML 1.0 doesn't allow (a control character or a broken one), so the record can't be published.",
    );
  }
  budget.chars += text.length;
  if (budget.chars > MAX_OUTPUT_CHARS) {
    fail(
      [],
      "too_large",
      `The output would be more than ${String(MAX_OUTPUT_CHARS)} characters, so it isn't made.`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// The three forms.

const CONTEXT: Readonly<Record<string, JsonValue>> = Object.freeze({
  dcterms: DCTERMS_NAMESPACE,
  dcmitype: DCMITYPE_NAMESPACE,
  rdfs: RDFS_NAMESPACE,
});

function jsonLdDocument(
  id: string,
  type: string | undefined,
  terms: ReadonlyMap<DublinCoreTerm, readonly OutValue[]>,
): Readonly<Record<string, JsonValue>> {
  const pairs: [string, JsonValue][] = [
    ["@context", CONTEXT],
    ["@id", id],
  ];
  if (type !== undefined) pairs.push(["@type", type]);
  for (const [term, values] of terms) {
    const items = values.map(jsonLdValue);
    const [only] = items;
    pairs.push([
      `dcterms:${term}`,
      items.length === 1 && only !== undefined ? only : Object.freeze(items),
    ]);
  }
  // Object.fromEntries defines own properties; every key is fixed above.
  return Object.freeze(Object.fromEntries(pairs));
}

function jsonLdValue(value: OutValue): JsonValue {
  if (value.iri === undefined) return value.text;
  return Object.freeze(
    value.labelled ? { "@id": value.iri, "rdfs:label": value.text } : { "@id": value.iri },
  );
}

/** JSON text with `<`, `>`, `&`, U+2028 and U+2029 escaped: the same value, safe in a script element. */
function scriptSafeJson(value: JsonValue): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function oaiDc(terms: ReadonlyMap<DublinCoreTerm, readonly OutValue[]>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<oai_dc:dc xmlns:oai_dc="${OAI_DC_NAMESPACE}" xmlns:dc="${DC_ELEMENTS_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${OAI_DC_NAMESPACE} ${OAI_DC_SCHEMA}">`,
  ];
  for (const [term, values] of terms) {
    const element = OAI_DC_ELEMENT.get(term);
    if (element === undefined) continue;
    for (const value of values)
      lines.push(`  <dc:${element}>${xmlText(value.text)}</dc:${element}>`);
  }
  lines.push("</oai_dc:dc>", "");
  return lines.join("\n");
}

const XML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
  ["\r", "&#13;"],
]);

/** Text escaped for XML content. Callers have refused characters XML can't hold. */
function xmlText(text: string): string {
  return text.replace(/[&<>"'\r]/g, (ch) => XML_ESCAPES.get(ch) ?? "");
}
