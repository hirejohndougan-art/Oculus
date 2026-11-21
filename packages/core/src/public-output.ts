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
 *   naming a staff field, is refused). An object, archival unit or digital
 *   asset must have its `rights` field mapped to `rights` or `license`
 *   (`rights_not_mapped`). Output holds the record's title, its URL, its
 *   DCMI type, and the values of the view's entries that the mapping maps.
 *   Nothing else is read: no notes, no `from`, no ancestors, no labels, no
 *   identifier types, no list option codes, no rights notes.
 * - **Every published value passes the template check.** Own values reach
 *   the view unchecked (D-013), so the view's values are checked with
 *   `checkRecordAgainstTemplate` against the view's template (required
 *   fields aside), with the default checkers and any the caller gives in
 *   `checkers`. Identifier values need `makeIdentifierChecker` (D-015). Any
 *   problem refuses the output, with the check's issues.
 * - **A kept view is checked against the catalog as it is now, if asked.**
 *   A view holds the records and templates it was built from (D-020). With
 *   `records` (the current set), the record's ancestry is found again and
 *   must be the same records with the same stored content
 *   (`record_changed`); with `templateFor`, every template on the way must
 *   be unchanged (`template_changed`). Only both together catch every
 *   change; building the view at publish time is still the rule.
 * - **Only public identifier types go out** (D-022). The checker from
 *   `makeIdentifierChecker` refuses a staff type's value in a public field
 *   (`private_identifier_type`), and the identifier value is checked again
 *   here against the public types that checker was made with, reading the
 *   type from the effective record (the public view holds `{ value }` only). A
 *   hand-written identifier checker says nothing about which types are
 *   public, so with one, identifier values are refused, never published.
 * - **Publishing is the caller's statement.** Records have no publish state
 *   yet, so the caller passes `published`, the IDs of every record that is
 *   published. The record itself must be in it (`not_published`). A place
 *   value's `recordId` becomes a link only when that record is in it;
 *   otherwise the place goes out as its name (and gazetteer URI) alone, so
 *   output never reveals that an unpublished record exists or what its ID is.
 *   Public values inherited from an unpublished ancestor are published on
 *   the child; the ancestor's title and ID never appear.
 * - **Every field kind is handled explicitly, and its shape checked again
 *   here:** text and long text as the text; a date as its EDTF text; a list
 *   choice as its option's label; a controlled term as its label, with its
 *   URI; an identifier as its value only; a link as its URL; rights as the
 *   statement's URI (never the note); a place as its name, with a URI from
 *   its gazetteer URI or a published place record. URIs must be http(s) and
 *   written exactly as a URL parser writes them back (so only printable
 *   ASCII). Anything off refuses the whole output (`invalid_value`).
 *
 * Three forms come out of one call, from the same checked values:
 * - `dublinCore`: term → list of text, using the DCMI Metadata Terms names
 *   (`title`, `created`, `spatial` …). It starts with the title, the record's
 *   public URL as an `identifier` and its DCMI type as a `type` (when the
 *   kind has one), then the mapped values. It is text only: terms and places
 *   by label, links and rights by URL.
 * - `jsonLd` (and `jsonLdText`): a compacted JSON-LD document with an inline
 *   `@context` for `dcterms:`, `dcmitype:` and `rdfs:`, `@id` from the
 *   caller's base URL plus the record ID, and an `@type` from the record's
 *   kind (see `TYPE_FOR`). Keys are only ever `@context`, `@id`, `@type`,
 *   `rdfs:label` and `dcterms:<term>` from the closed list in
 *   `dublin-core.ts`. Each term is written according to its range in DCMI
 *   Metadata Terms (`RANGE`): literal-range terms get text only (a URL is
 *   a plain string); class-range terms get `{"@id"}` for a URI, otherwise a
 *   node `{"rdfs:label"}` (and `type` always a label node, since a
 *   vocabulary concept is not a class); terms with no range get `{"@id"}`
 *   for a URI and text otherwise. `jsonLdText` also writes `<`, `>`, `&`,
 *   U+2028 and U+2029 as escapes, so it can sit inside a
 *   `<script type="application/ld+json">` element.
 * - `oaiDcXml`: the OAI-PMH `oai_dc` record (the 15 Dublin Core elements),
 *   with the same text as `dublinCore`. Refined terms are written as the
 *   element they refine (`created` as `dc:date`, `spatial` as
 *   `dc:coverage`); `rightsHolder` and `provenance` refine no element and are
 *   left out of this form only. Text is escaped (`& < > " '`, and carriage
 *   return as `&#13;`), and any character XML 1.0 doesn't allow refuses the
 *   output in every form (`bad_characters`). The declaration says UTF-8, so
 *   the caller must encode the string as UTF-8.
 *
 * Each form is capped at MAX_OUTPUT_CHARS characters as produced (escapes
 * included; `dublinCore` counts its values), and values are counted against
 * the same cap while they are read. Nothing here throws; every problem comes
 * back as issues.
 */
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { shown, type JsonValue } from "./plain-data.js";
import { publicViewOrigin } from "./effective-brand.js";
import {
  MAX_RECORD_SET,
  currentAncestry,
  effectivePublishIssues,
  isTemplateSource,
  templateFromSource,
  type EffectiveRecord,
  type PublicRecord,
  type RecordLookup,
  type TemplateSource,
} from "./effective.js";
import {
  DCTERMS_NAMESPACE,
  validateDublinCoreMapping,
  type DublinCoreTerm,
} from "./dublin-core.js";
import { parseEdtf } from "./edtf.js";
import { isOtherOrganizationsChecker, publicIdentifierTypesOf } from "./field-checkers.js";
import { RIGHTS_FIELD_KEY, RIGHTS_REQUIRED_KINDS, rightsTerm } from "./rights.js";
import { isRecordId, type RecordId } from "./record-id.js";
import type { CatalogRecord, FieldValue, RecordKind } from "./records.js";
import {
  MAX_REPEATS,
  MAX_URL_LENGTH,
  checkRecordAgainstTemplate,
  storedTemplateKey,
  validateTemplate,
  type FieldDefinition,
  type FieldTemplate,
  type TemplateCheckOptions,
} from "./templates.js";

export const DCMITYPE_NAMESPACE = "http://purl.org/dc/dcmitype/";
export const RDFS_NAMESPACE = "http://www.w3.org/2000/01/rdf-schema#";
export const DC_ELEMENTS_NAMESPACE = "http://purl.org/dc/elements/1.1/";
export const OAI_DC_NAMESPACE = "http://www.openarchives.org/OAI/2.0/oai_dc/";
export const OAI_DC_SCHEMA = "http://www.openarchives.org/OAI/2.0/oai_dc.xsd";

/** The longest a base URL may be. */
export const MAX_BASE_URL_LENGTH = MAX_URL_LENGTH;
/**
 * The most characters each form may hold as produced: `jsonLdText`,
 * `oaiDcXml`, and the values of `dublinCore` added together.
 */
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
  /**
   * Checkers for the template check, as `checkRecordAgainstTemplate` takes
   * them. Identifier values are refused unless the one for `identifier` was
   * made by `makeIdentifierChecker`, and are published only when their type
   * is public.
   */
  readonly checkers?: TemplateCheckOptions["checkers"];
  /**
   * The record's template as it is now. When given, output is refused if it
   * differs from the template the view was built with (`template_changed`).
   * It checks only the record's own template, so for a record with parents
   * it must come with `templateFor` (`ancestor_templates_unchecked`).
   */
  readonly currentTemplate?: unknown;
  /**
   * The templates as they are now: a registry from `indexTemplates` or a
   * lookup function, the same kinds `effectiveRecord` takes. When given, the
   * template of the record and of every ancestor the view was built from is
   * found again, and output is refused if any differs from the one the view
   * used (`template_changed`): a parent's field made staff since would
   * otherwise still publish the value its child inherited. A template whose
   * key isn't the record's `templateKey` is refused (`template_mismatch`).
   * With `records`, the templates are found for the records as they are now.
   */
  readonly templateFor?: TemplateSource;
  /**
   * The records as they are now, a list or a lookup from `indexRecords`, the
   * same kind `effectiveRecord` takes. When given, the record and its parents
   * are found again in it, and output is refused unless they are the same
   * records, in the same order, with the same stored content as when the view
   * was made (`record_changed`, naming the record that differs, never its
   * values): an ancestor's value changed or emptied since, or a record moved
   * to another parent or level, would otherwise still publish the old
   * inherited values. Only `records` and `templateFor` together catch every
   * change to a kept view (D-021).
   */
  readonly records?: RecordLookup | readonly CatalogRecord[];
}

/** Dublin Core as term → values, in order (see the module header). */
export type DublinCoreValues = Readonly<Partial<Record<DublinCoreTerm, readonly string[]>>>;

export interface PublicOutput {
  /** The record's public URL: `baseUrl` + ID, the JSON-LD `@id`. */
  readonly id: string;
  readonly dublinCore: DublinCoreValues;
  /** A compacted JSON-LD document with an inline context. */
  readonly jsonLd: Readonly<Record<string, JsonValue>>;
  /** `jsonLd` as JSON text, safe inside an HTML script element. */
  readonly jsonLdText: string;
  /** The record as an OAI-PMH `oai_dc:dc` XML document; encode it as UTF-8. */
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

/**
 * How each term's value is written in JSON-LD, from its range in DCMI
 * Metadata Terms: `literal` (rdfs:Literal; description and abstract, which
 * declare no range, are treated as literal), `class` (a non-literal class
 * such as Agent, Location or RightsStatement) or `any` (no range declared;
 * values are often other resources).
 */
type Range = "literal" | "class" | "any";

const RANGE: ReadonlyMap<DublinCoreTerm, Range> = new Map<DublinCoreTerm, Range>([
  ["title", "literal"],
  ["alternative", "literal"],
  ["date", "literal"],
  ["created", "literal"],
  ["description", "literal"],
  ["abstract", "literal"],
  ["identifier", "literal"],
  ["bibliographicCitation", "literal"],
  ["creator", "class"],
  ["contributor", "class"],
  ["publisher", "class"],
  ["rightsHolder", "class"],
  ["type", "class"],
  ["format", "class"],
  ["extent", "class"],
  ["medium", "class"],
  ["language", "class"],
  ["coverage", "class"],
  ["spatial", "class"],
  ["temporal", "class"],
  ["rights", "class"],
  ["accessRights", "class"],
  ["license", "class"],
  ["provenance", "class"],
  ["subject", "any"],
  ["source", "any"],
  ["relation", "any"],
  ["isPartOf", "any"],
  ["hasPart", "any"],
  ["isFormatOf", "any"],
  ["hasFormat", "any"],
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

/** The terms a rights field must be mapped to, for kinds that need rights. */
const RIGHTS_TERMS: ReadonlySet<string> = new Set(["rights", "license"]);
const NEEDS_RIGHTS: ReadonlySet<string> = new Set(RIGHTS_REQUIRED_KINDS);

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

/**
 * One checked value: its text, and an IRI (with the text as its label, or
 * not). Made with a null prototype and every property its own, so nothing on
 * Object.prototype can add an IRI.
 */
interface OutValue {
  readonly text: string;
  readonly iri: string | undefined;
  readonly labelled: boolean;
  /** A DCMI Type Vocabulary name (`StillImage`), for a list choice whose code is one. */
  readonly dcmiType: string | undefined;
}

function outValue(text: string, iri?: string, labelled = false, dcmiType?: string): OutValue {
  const value = Object.create(null) as {
    text: string;
    iri: string | undefined;
    labelled: boolean;
    dcmiType: string | undefined;
  };
  value.text = text;
  value.iri = iri;
  value.labelled = labelled;
  value.dcmiType = dcmiType;
  return Object.freeze(value);
}

/** The DCMI Type Vocabulary's classes, as the digital asset preset's type codes use them. */
const DCMI_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Collection",
  "Dataset",
  "Event",
  "Image",
  "InteractiveResource",
  "MovingImage",
  "PhysicalObject",
  "Service",
  "Software",
  "Sound",
  "StillImage",
  "Text",
]);

interface Budget {
  chars: number;
}

/**
 * Dublin Core, JSON-LD and `oai_dc` XML for one published record (see the
 * module header). `view` must be what `publicView` returned, `mapping` a
 * Dublin Core mapping for the template that record uses, and `options` the
 * base URL, the published record IDs and any checkers. Fails, with the
 * issues found, when anything is off. Never throws.
 *
 * **Build the view fresh at publish time.** A view records the template it
 * was made with; a view kept from earlier publishes under that template's
 * visibility and fields, even if the template has changed since. Pass the
 * template lookup as it is now in `templateFor` to have a view refused when
 * the template of the record or of any ancestor has changed
 * (`template_changed`), and the records as they are now in `records` to have
 * it refused when the record or any ancestor has been edited, moved or
 * removed since (`record_changed`). Only the two together catch every change;
 * either alone leaves the other kind of change unseen.
 *
 * **"Passes the template check" means the configured check.** Checkers given
 * in `checkers` replace the defaults for their kinds (as
 * `checkRecordAgainstTemplate` does), so a caller that passes a lax checker
 * for, say, `controlled_term` publishes what that checker accepts.
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
      issues: Object.freeze(issues.map((i) => Object.freeze({ ...i }))),
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
  const { baseUrl, published, checkers, currentTemplate, templateFor, records } =
    readOptions(options);
  if (!published.has(view.id)) {
    fail([], "not_published", "This record is not in the published list, so it can't be output.");
  }
  // The effective record the view was made from, from the mark beside it.
  const effective = origin.effective as EffectiveRecord;
  const blocked = effectivePublishIssues(effective);
  if (blocked.length > 0) throw new OutputError(blocked);
  const template = origin.template;
  // Checked again at the boundary: every template the view was built with is
  // the one its record names (D-029).
  for (const step of origin.chain) {
    const named = storedTemplateKey(step.record);
    if (!named.ok || (named.value !== undefined && named.value !== step.template.key)) {
      fail(
        ["templateKey"],
        "template_mismatch",
        "This public view was made with a template its record doesn't follow, so it can't be published.",
      );
    }
  }
  if (currentTemplate !== undefined) {
    sameTemplate(currentTemplate, template);
    if (origin.chain.length > 1 && templateFor === undefined) {
      fail(
        ["currentTemplate"],
        "ancestor_templates_unchecked",
        "This record inherits from parent records, and currentTemplate checks only its own template. Pass templateFor too, so a parent's template changed since the view was made is caught.",
      );
    }
  }
  // With `records`, the templates are looked up for the records as they are now.
  const chain = records === undefined ? origin.chain : sameAncestry(records, origin.chain);
  if (templateFor !== undefined) sameChainTemplates(templateFor, chain);
  const checked = validateDublinCoreMapping(mapping, template);
  if (!checked.ok) throw new OutputError(checked.issues);
  if (
    NEEDS_RIGHTS.has(view.kind) &&
    !checked.value.entries.some((e) => e.field === RIGHTS_FIELD_KEY && RIGHTS_TERMS.has(e.term))
  ) {
    fail(
      ["entries"],
      "rights_not_mapped",
      `The mapping must map the ${RIGHTS_FIELD_KEY} field to rights or license, because this kind of record can't be published without its rights.`,
    );
  }
  // The view holds identifiers as `{ value }` only (D-022); the template
  // check and the type check below read the full values the view's entries
  // came from, in the effective record.
  const full = fullValues(view, effective, template);
  const identifierChecker = isPlainObject(checkers) ? dataProp(checkers, "identifier") : undefined;
  // One organization's checker never vouches for another's numbers (D-0XX).
  if (isOtherOrganizationsChecker(identifierChecker, effective.record.organizationId)) {
    fail(
      ["checkers", "identifier"],
      "wrong_organization_checker",
      "checkers.identifier was made from another organization's identifier types. Make it from this record's organization's types.",
    );
  }
  templateCheck(effective.record, full, template, checkers);

  const publicIdentifierTypes = publicIdentifierTypesOf(
    identifierChecker,
    effective.record.organizationId,
  );

  const byKey = new Map<string, FieldDefinition>();
  for (const field of template.fields) byKey.set(field.key, field);
  const entries = new Map<string, JsonValue>();
  for (const entry of view.entries) entries.set(entry.key, entry.value);

  const budget: Budget = { chars: 0 };
  const recordUrl = safeText(baseUrl + view.id, ["id"], budget);
  const terms = new Map<DublinCoreTerm, OutValue[]>();
  terms.set("title", [outValue(safeText(view.title, ["title"], budget))]);
  for (const { field, term } of checked.value.entries) {
    const value = entries.get(field);
    // Not in the view: empty, staff only along the way, or not inherited.
    if (value === undefined) continue;
    const def = byKey.get(field);
    // The mapping check refuses staff fields; checked again here, at the boundary.
    if (def?.visibility !== "public") {
      fail(["fields", field], "staff_field", "Only public template fields can be published.");
    }
    if (def.kind === "identifier") {
      publicTypesOnly(full[field], def, publicIdentifierTypes);
    }
    const values = valuesOf(value, def, { baseUrl, published, budget });
    const list = terms.get(term);
    if (list === undefined) terms.set(term, values);
    else list.push(...values);
  }

  const types = typesFor(view.kind, origin, terms.get("type") ?? []);
  const dublinCore = dublinCoreValues(terms, recordUrl, types);
  const jsonLd = jsonLdDocument(recordUrl, types, terms);
  const jsonLdText = writeJson(jsonLd);
  return Object.freeze({
    id: recordUrl,
    dublinCore,
    jsonLd,
    jsonLdText,
    oaiDcXml: oaiDc(dublinCore),
  });
}

/**
 * Refuse when the record's template today is not the one the view was built
 * with: a view kept from earlier would publish under the old visibility and
 * fields. Compared as validated data, with object keys in sorted order.
 */
function sameTemplate(current: unknown, captured: FieldTemplate): void {
  const checked = validateTemplate(current);
  if (!checked.ok) {
    fail(
      ["currentTemplate"],
      "invalid_template",
      "currentTemplate is not a valid template. Check it with validateTemplate.",
    );
  }
  if (canonicalJson(checked.value) !== canonicalJson(captured)) {
    fail(
      ["currentTemplate"],
      "template_changed",
      "The record's template has changed since this public view was made. Make the view again with effectiveRecord and publicView, and publish that.",
    );
  }
}

/**
 * Refuse when the template the lookup gives now, for the record or any of its
 * ancestors, is not the one the view was built with. Every step is checked,
 * not only those a value came from: a parent whose field became `inherited`
 * or changed visibility changes what the child may publish.
 */
function sameChainTemplates(
  templateFor: TemplateSource,
  chain: readonly { readonly record: CatalogRecord; readonly template: FieldTemplate }[],
): void {
  for (const [index, step] of chain.entries()) {
    const path = index === 0 ? ["templateFor"] : ["templateFor", step.record.id];
    const checked = templateFromSource(step.record, templateFor);
    // Messages here never quote the record's title (the lookup's own do).
    const code = checked.ok ? undefined : checked.issues[0]?.code;
    if (code === "template_lookup_failed") {
      fail(path, code, "Finding a template with templateFor failed.");
    }
    if (code === "template_mismatch") {
      fail(
        path,
        code,
        "The template found for this record is not the one the record names, so it can't be published.",
      );
    }
    if (code === "no_template_key") {
      fail(
        path,
        code,
        "This record doesn't say which template it follows, so its template can't be found in the registry.",
      );
    }
    if (!checked.ok || canonicalJson(checked.value) !== canonicalJson(step.template)) {
      fail(
        path,
        "template_changed",
        index === 0
          ? "The record's template has changed since this public view was made. Make the view again with effectiveRecord and publicView, and publish that."
          : "The template of a parent record has changed since this public view was made. Make the view again with effectiveRecord and publicView, and publish that.",
      );
    }
  }
}

/**
 * The record's ancestry as it is in `records` now, each step with the template
 * the view used for it. Refused unless it is the same records, in the same
 * order, with the same stored content (compared as validated data, with
 * object keys in sorted order) as the view was built from. Issues name the
 * record by ID only; the messages never quote titles or values.
 */
function sameAncestry(
  records: unknown,
  chain: readonly { readonly record: CatalogRecord; readonly template: FieldTemplate }[],
): readonly { readonly record: CatalogRecord; readonly template: FieldTemplate }[] {
  const first = chain[0];
  if (first === undefined) fail([], "unreadable", "The public view could not be read.");
  const found = currentAncestry(first.record.id, records);
  if (!found.ok) {
    const problem = found.issues[0];
    if (problem?.code === "mixed_organizations") {
      // Each organization is kept separate (D-019, D-0XX): never filtered.
      fail(["records"], problem.code, problem.message);
    }
    if (problem === undefined || SET_PROBLEMS.has(problem.code)) {
      fail(
        ["records"],
        "invalid_options",
        "The records option must be a list of records or a lookup from indexRecords.",
      );
    }
    const where = problem.path[0];
    fail(
      ["records", isRecordId(where) ? where : first.record.id],
      "record_changed",
      "The record or one of its parents can no longer be found as it was when this public view was made: it has been removed, or its parent is missing or not valid. Make the view again with effectiveRecord and publicView, and publish that.",
    );
  }
  const current = found.value;
  const length = Math.max(current.length, chain.length);
  for (let i = 0; i < length; i += 1) {
    const now = current[i];
    const then = chain[i];
    if (
      now === undefined ||
      then === undefined ||
      canonicalJson(now) !== canonicalJson(then.record)
    ) {
      const id = (now ?? then?.record ?? first.record).id;
      fail(
        ["records", id],
        "record_changed",
        i === 0
          ? "The record has been edited or moved since this public view was made. Make the view again with effectiveRecord and publicView, and publish that."
          : "A parent record has been edited, moved or replaced since this public view was made. Make the view again with effectiveRecord and publicView, and publish that.",
      );
    }
  }
  return Object.freeze(
    chain.map((step, i) =>
      Object.freeze({ record: current[i] ?? step.record, template: step.template }),
    ),
  );
}

/** Problems with the set itself, not with the record or its ancestry. */
const SET_PROBLEMS: ReadonlySet<string> = new Set([
  "not_a_list",
  "too_many_records",
  "unreadable_entry",
  "unreadable",
]);

/** Plain data as JSON text with object keys sorted, for comparing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  // Validated templates and records hold only text, numbers, true/false and null here.
  return JSON.stringify(value);
}

/**
 * The view's values for checking, with each identifier field's value taken
 * from the effective record instead (the view leaves out its type). Only
 * keys in the view are read, and the effective entry for each is public.
 */
function fullValues(
  view: PublicRecord,
  effective: EffectiveRecord,
  template: FieldTemplate,
): Readonly<Record<string, FieldValue>> {
  const kinds = new Map(template.fields.map((f) => [f.key, f.kind]));
  const out: [string, FieldValue][] = [];
  for (const entry of view.entries) {
    if (kinds.get(entry.key) !== "identifier") {
      out.push([entry.key, entry.value]);
      continue;
    }
    const source = effective.entries.find((e) => e.key === entry.key);
    if (source?.visibility !== "public" || !source.inTemplate) {
      fail(["fields", entry.key], "staff_field", "Only public template fields can be published.");
    }
    out.push([entry.key, source.value]);
  }
  // Object.fromEntries defines own properties, so no key can reach a prototype.
  return Object.freeze(Object.fromEntries(out));
}

/**
 * Refuse unless every identifier in `value` is of a type the identifier
 * checker knows to be public. A checker not made by `makeIdentifierChecker`
 * can't say, so any identifier value is refused with it (D-022).
 */
function publicTypesOnly(
  value: FieldValue | undefined,
  def: FieldDefinition,
  publicTypes: ReadonlySet<string> | undefined,
): void {
  if (publicTypes === undefined) {
    fail(
      ["fields", def.key],
      "unchecked",
      `${shown(def.label)} can't be published without knowing which identifier types are public. Pass checkers.identifier from makeIdentifierChecker.`,
    );
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    const type = isPlainObject(item) && Object.hasOwn(item, "type") ? item.type : undefined;
    if (typeof type !== "string" || !publicTypes.has(type)) {
      fail(
        ["fields", def.key],
        "private_identifier_type",
        `${shown(def.label)} holds a number of a staff only identifier type, so the record can't be published. Mark the type public, or move the number to a staff field.`,
      );
    }
  }
}

/**
 * Check the view's values with `checkRecordAgainstTemplate`, as the record
 * they belong to, against the view's own template. Required fields are not
 * checked: a value can be left out of the view because it is staff only.
 */
function templateCheck(
  record: CatalogRecord,
  fields: Readonly<Record<string, FieldValue>>,
  template: FieldTemplate,
  checkers: unknown,
): void {
  const loose: FieldTemplate = {
    ...template,
    fields: template.fields.map((f) => ({ ...f, required: false })),
  };
  const probe = Object.freeze({ ...record, fields }) as CatalogRecord;
  const problems = checkRecordAgainstTemplate(
    probe,
    loose,
    (checkers === undefined ? {} : { checkers }) as TemplateCheckOptions,
  );
  if (problems.length > 0) throw new OutputError(problems);
}

/**
 * The record's classes, as compact IRIs: the kind's class, or, for a kind
 * that has none (digital assets, archival items), the DCMI types named by
 * list choices mapped to `type` (the digital asset preset's `resource_type`).
 */
function typesFor(
  kind: RecordKind,
  origin: object,
  typeValues: readonly OutValue[],
): readonly string[] {
  const own = typeFor(kind, origin);
  if (own !== undefined) return [own];
  const found = new Set<string>();
  for (const v of typeValues) if (v.dcmiType !== undefined) found.add(`dcmitype:${v.dcmiType}`);
  return [...found];
}

/** The kind's class, as a compact IRI (`dcmitype:Collection`), or undefined. */
function typeFor(kind: RecordKind, origin: object): string | undefined {
  if (kind === "archival_unit") {
    const level: unknown = Object.hasOwn(origin, "level")
      ? (origin as { level: unknown }).level
      : undefined;
    if (level === undefined || level === "item") return undefined;
  }
  return TYPE_FOR.get(kind);
}

function capped(length: number, form: string): void {
  if (length > MAX_OUTPUT_CHARS) {
    fail(
      [form],
      "too_large",
      `The ${form} output would be more than ${String(MAX_OUTPUT_CHARS)} characters, so it isn't made.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Options.

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "baseUrl",
  "published",
  "checkers",
  "currentTemplate",
  "templateFor",
  "records",
]);

interface ReadOptions {
  readonly baseUrl: string;
  readonly published: ReadonlySet<RecordId>;
  readonly checkers: unknown;
  readonly currentTemplate: unknown;
  readonly templateFor: TemplateSource | undefined;
  readonly records: unknown;
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
  const checkers = dataProp(options, "checkers");
  const currentTemplate = dataProp(options, "currentTemplate");
  const lookup = dataProp(options, "templateFor");
  if (lookup !== undefined && !isTemplateSource(lookup)) {
    fail(
      ["templateFor"],
      "invalid_options",
      "The templateFor option must be a registry from indexTemplates or a function.",
    );
  }
  const templateFor = lookup;
  // Checked when it is used: it may be a list or a lookup from indexRecords.
  const records = dataProp(options, "records");
  return { baseUrl, published, checkers, currentTemplate, templateFor, records };
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
  if (!PRINTABLE_ASCII.test(value) || NOT_IN_IRI.test(value) || BAD_PERCENT.test(value)) {
    return bad("can't hold spaces, <>\"{}|\\^`, a bad % escape, control or non-ASCII characters");
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
  if (!bracketsOnlyInHost(value, url)) return bad("can only use [ and ] around an IPv6 host");
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
      return outValue(nonBlank(value, invalid));
    case "date": {
      const text = nonBlank(value, invalid);
      if (!parseEdtf(text).ok) return invalid();
      return outValue(text);
    }
    case "list": {
      const code = nonBlank(value, invalid);
      const option = (def.options ?? []).find((o) => o.value === code);
      if (option === undefined) return invalid();
      return outValue(option.label, undefined, false, DCMI_TYPE_NAMES.has(code) ? code : undefined);
    }
    case "controlled_term": {
      const term = props(value, TERM_KEYS, invalid);
      const label = nonBlank(term.get("label"), invalid);
      const uri = optionalIri(term.get("uri"), invalid);
      const vocabulary = term.get("vocabulary");
      if (vocabulary !== undefined && typeof vocabulary !== "string") return invalid();
      return uri === undefined ? outValue(label) : outValue(label, uri, true);
    }
    case "identifier": {
      // Only the value: the view holds no type, and the type was checked
      // public by publicTypesOnly (D-022).
      const id = props(value, IDENTIFIER_KEYS, invalid);
      return outValue(nonBlank(id.get("value"), invalid));
    }
    case "link": {
      const link = props(value, LINK_KEYS, invalid);
      const label = link.get("label");
      if (label !== undefined && typeof label !== "string") return invalid();
      const url = optionalIri(link.get("url"), invalid);
      if (url === undefined) return invalid();
      return outValue(url, url);
    }
    case "rights": {
      const rights = props(value, RIGHTS_KEYS, invalid);
      const uri = rights.get("uri");
      // The note is not published (D-016).
      if (typeof uri !== "string" || rightsTerm(uri) === undefined) return invalid();
      return outValue(uri, uri);
    }
    case "place": {
      const place = props(value, PLACE_KEYS, invalid);
      const label = nonBlank(place.get("label"), invalid);
      const uri = optionalIri(place.get("uri"), invalid);
      const recordId = place.get("recordId");
      if (recordId !== undefined && !isRecordId(recordId)) return invalid();
      if (uri !== undefined) return outValue(label, uri, true);
      // A place record is linked only when it is published; otherwise its
      // existence and ID stay unsaid.
      if (recordId !== undefined && ctx.published.has(recordId)) {
        return outValue(label, ctx.baseUrl + recordId, true);
      }
      return outValue(label);
    }
  }
}

const TERM_KEYS: ReadonlySet<string> = new Set(["label", "uri", "vocabulary"]);
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(["value"]);
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

/** Printable ASCII only: no spaces, controls, invisible, direction or other non-ASCII characters. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * An absolute http(s) URL with no user name or password, written exactly as
 * a URL parser writes it back; or undefined when absent.
 */
function optionalIri(value: unknown, invalid: () => never): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > MAX_URL_LENGTH ||
    !PRINTABLE_ASCII.test(value) ||
    NOT_IN_IRI.test(value) ||
    BAD_PERCENT.test(value)
  ) {
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
  if (url.href !== value || !bracketsOnlyInHost(value, url)) return invalid();
  return value;
}

/**
 * Characters RFC 3987 IRIs (and N-Triples) don't allow that a URL parser
 * leaves as they are. `[` and `]` are checked by `bracketsOnlyInHost`.
 */
const NOT_IN_IRI = /[<>"{}|\\^`\s]/;
/** A `%` not followed by two hex digits. */
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;

/** True when `[` and `]` appear only around an IPv6 host, right after `scheme://`. */
function bracketsOnlyInHost(value: string, url: URL): boolean {
  if (!/[[\]]/.test(value)) return true;
  const start = url.protocol.length + 2;
  if (!url.hostname.startsWith("[") || value[start] !== "[") return false;
  const end = value.indexOf("]", start);
  return end > start && !/[[\]]/.test(value.slice(start + 1, end) + value.slice(end + 1));
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
  capped(budget.chars, "values");
  return text;
}

// ---------------------------------------------------------------------------
// The three forms.

function dublinCoreValues(
  terms: ReadonlyMap<DublinCoreTerm, readonly OutValue[]>,
  recordUrl: string,
  types: readonly string[],
): DublinCoreValues {
  const lists = new Map<DublinCoreTerm, string[]>();
  const add = (term: DublinCoreTerm, text: string): void => {
    const list = lists.get(term);
    if (list === undefined) lists.set(term, [text]);
    else list.push(text);
  };
  for (const v of terms.get("title") ?? []) add("title", v.text);
  add("identifier", recordUrl);
  // The DCMI Type Vocabulary types only; Agent and Location are classes, not types.
  for (const type of types) {
    if (type.startsWith("dcmitype:")) {
      add("type", DCMITYPE_NAMESPACE + type.slice("dcmitype:".length));
    }
  }
  let chars = 0;
  for (const [term, values] of terms) {
    if (term === "title") continue;
    for (const v of values) add(term, v.text);
  }
  for (const list of lists.values()) for (const text of list) chars += text.length;
  capped(chars, "dublinCore");
  return nullObject([...lists].map(([term, list]) => [term, Object.freeze(list)]));
}

/**
 * A frozen object with a null prototype holding exactly these own
 * properties, so nothing on Object.prototype (a `toJSON`, an extra key) can
 * change what it says or how it is written.
 */
function nullObject<T>(pairs: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const obj = Object.create(null) as Record<string, T>;
  for (const [key, value] of pairs) obj[key] = value;
  return Object.freeze(obj);
}

const CONTEXT: Readonly<Record<string, JsonValue>> = nullObject<JsonValue>([
  ["dcterms", DCTERMS_NAMESPACE],
  ["dcmitype", DCMITYPE_NAMESPACE],
  ["rdfs", RDFS_NAMESPACE],
]);

function jsonLdDocument(
  id: string,
  types: readonly string[],
  terms: ReadonlyMap<DublinCoreTerm, readonly OutValue[]>,
): Readonly<Record<string, JsonValue>> {
  const pairs: [string, JsonValue][] = [
    ["@context", CONTEXT],
    ["@id", id],
  ];
  const [onlyType] = types;
  if (types.length === 1 && onlyType !== undefined) pairs.push(["@type", onlyType]);
  else if (types.length > 1) pairs.push(["@type", Object.freeze([...types])]);
  for (const [term, values] of terms) {
    const range = RANGE.get(term) ?? "literal";
    const items = values.map((v) => jsonLdValue(term, range, v));
    const [only] = items;
    pairs.push([
      `dcterms:${term}`,
      items.length === 1 && only !== undefined ? only : Object.freeze(items),
    ]);
  }
  // Every key is fixed above.
  return nullObject(pairs);
}

function jsonLdValue(term: DublinCoreTerm, range: Range, value: OutValue): JsonValue {
  if (range === "literal") return value.text;
  // A vocabulary concept or a web page is not a class, so `type` never takes an IRI here.
  const iri = term === "type" ? undefined : value.iri;
  if (iri === undefined) {
    return range === "class" ? nullObject([["rdfs:label", value.text]]) : value.text;
  }
  return nullObject(
    value.labelled
      ? [
          ["@id", iri],
          ["rdfs:label", value.text],
        ]
      : [["@id", iri]],
  );
}

/**
 * `jsonLd` as JSON text, written here rather than by JSON.stringify so that
 * nothing on Object.prototype (a `toJSON`) can change it, and counted as it
 * is written so text over MAX_OUTPUT_CHARS is never built. `<`, `>`, `&`,
 * U+2028 and U+2029 are escaped: the same value, safe in a script element.
 */
function writeJson(value: JsonValue): string {
  const parts: string[] = [];
  let length = 0;
  const push = (text: string): void => {
    length += text.length;
    capped(length, "jsonLdText");
    parts.push(text);
  };
  const walk = (v: JsonValue): void => {
    if (typeof v === "string") {
      push(scriptSafe(JSON.stringify(v)));
    } else if (Array.isArray(v)) {
      push("[");
      (v as readonly JsonValue[]).forEach((item, i) => {
        if (i > 0) push(",");
        walk(item);
      });
      push("]");
    } else if (typeof v === "object" && v !== null) {
      const obj = v as Readonly<Record<string, JsonValue>>;
      push("{");
      Object.keys(obj).forEach((key, i) => {
        const inner = obj[key];
        if (inner === undefined) return;
        if (i > 0) push(",");
        push(scriptSafe(JSON.stringify(key)));
        push(":");
        walk(inner);
      });
      push("}");
    } else {
      // Only text, lists and objects are ever built here.
      fail([], "unreadable", "The JSON-LD could not be written.");
    }
  };
  walk(value);
  return parts.join("");
}

function scriptSafe(json: string): string {
  return json.replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function oaiDc(dublinCore: DublinCoreValues): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<oai_dc:dc xmlns:oai_dc="${OAI_DC_NAMESPACE}" xmlns:dc="${DC_ELEMENTS_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${OAI_DC_NAMESPACE} ${OAI_DC_SCHEMA}">`,
  ];
  let length = lines[0]?.length ?? 0;
  length += lines[1]?.length ?? 0;
  for (const [term, values] of Object.entries(dublinCore) as [
    DublinCoreTerm,
    readonly string[],
  ][]) {
    const element = OAI_DC_ELEMENT.get(term);
    if (element === undefined) continue;
    for (const value of values) {
      const line = `  <dc:${element}>${xmlText(value)}</dc:${element}>`;
      length += line.length + 1;
      capped(length, "oaiDcXml");
      lines.push(line);
    }
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
