/**
 * The one internal model of an EAD finding aid (D-107, D-110).
 *
 * EAD 2002 and EAD3 are read into this model and written from it, so a file
 * read in one version can be written in the other, and reading what was
 * written gives back the same model. The model holds only what Oculus maps;
 * everything else in a file is listed in the read report (`ead-read.ts`).
 *
 * Text in the model is normalized: one line, single spaces, no leading or
 * trailing space. Long text is a list of paragraphs (`eadParagraphs` splits
 * stored long text into them). `internal` marks what EAD calls
 * `audience="internal"`: staff-only, never public; a unit's `internal`
 * covers everything under it.
 */
import { MAX_ARRANGEMENT_DEPTH } from "./arrangement.js";
import { edtfFromText } from "./edtf-text.js";
import { parseEdtf } from "./edtf.js";
import { issue, type Validated } from "./issues.js";
import { IssueList, readPlainData, shown, textProblem } from "./plain-data.js";
import { ARCHIVAL_LEVELS, type ArchivalLevel } from "./records.js";
import { webUrlProblem } from "./templates.js";

export const EAD_VERSIONS = ["ead2002", "ead3"] as const;
export type EadVersion = (typeof EAD_VERSIONS)[number];

/** EAD 2002's namespace. DTD-era EAD 2002 files have none. */
export const EAD2002_NAMESPACE = "urn:isbn:1-931666-22-9";
/** EAD3's namespace, the same for every 1.x release. */
export const EAD3_NAMESPACE = "http://ead3.archivists.org/schema/";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * Description elements read as notes. Each is the same element, with the
 * same meaning, in EAD 2002 and EAD3.
 */
export const EAD_NOTE_KINDS = [
  "accessrestrict",
  "accruals",
  "acqinfo",
  "altformavail",
  "appraisal",
  "arrangement",
  "bibliography",
  "bioghist",
  "custodhist",
  "fileplan",
  "odd",
  "originalsloc",
  "otherfindaid",
  "phystech",
  "prefercite",
  "processinfo",
  "relatedmaterial",
  "scopecontent",
  "separatedmaterial",
  "userestrict",
] as const;
export type EadNoteKind = (typeof EAD_NOTE_KINDS)[number];

/** Name elements allowed in `origination`. */
export const EAD_NAME_ELEMENTS = ["persname", "corpname", "famname", "name"] as const;
export type EadNameElement = (typeof EAD_NAME_ELEMENTS)[number];

/** Access-point elements allowed in `controlaccess`. */
export const EAD_ACCESS_ELEMENTS = [
  "subject",
  "persname",
  "corpname",
  "famname",
  "name",
  "geogname",
  "genreform",
  "occupation",
  "function",
  "title",
] as const;
export type EadAccessElement = (typeof EAD_ACCESS_ELEMENTS)[number];

export interface EadNote {
  readonly kind: EadNoteKind;
  readonly head?: string;
  readonly paragraphs: readonly string[];
  readonly internal: boolean;
}

export interface EadName {
  readonly element: EadNameElement;
  readonly label: string;
  /** An authority URI or number: EAD 2002 `@authfilenumber`, EAD3 `@identifier`. */
  readonly identifier?: string;
  /** The vocabulary, such as `lcnaf`. */
  readonly source?: string;
  /** EAD 2002 `@role`, EAD3 `@relator`. */
  readonly role?: string;
}

export interface EadAccessPoint {
  readonly element: EadAccessElement;
  readonly label: string;
  readonly identifier?: string;
  readonly source?: string;
}

export interface EadDate {
  /** The date as written, such as "circa 1920-1935". */
  readonly text: string;
  /** EAD's `@normal`, such as "1920/1935". */
  readonly normal?: string;
  readonly type?: "inclusive" | "bulk";
}

/** An extent: free text, or a number and a unit. */
export type EadExtent =
  | { readonly text: string }
  | {
      readonly quantity: string;
      readonly unit: string;
      /** EAD3 `@physdescstructuredtype` when it isn't the default, space occupied. */
      readonly measure?: "carrier" | "materialtype";
    };

export interface EadLanguage {
  readonly label: string;
  /** An ISO 639-2b code, such as `eng`. */
  readonly code?: string;
}

export interface EadContainer {
  /** Box, folder and so on: EAD 2002 `@type`, EAD3 `@localtype`. */
  readonly type?: string;
  readonly value: string;
}

/** A digital object link (`dao`). Checked as a web address; never fetched. */
export interface EadLink {
  readonly url: string;
  readonly label?: string;
}

export interface EadUnit {
  readonly level: ArchivalLevel;
  readonly internal: boolean;
  readonly identifiers: readonly string[];
  readonly title?: string;
  readonly dates: readonly EadDate[];
  readonly extents: readonly EadExtent[];
  readonly creators: readonly EadName[];
  readonly languages: readonly EadLanguage[];
  readonly repository?: string;
  readonly containers: readonly EadContainer[];
  readonly physicalLocations: readonly string[];
  readonly abstracts: readonly string[];
  readonly notes: readonly EadNote[];
  readonly accessPoints: readonly EadAccessPoint[];
  readonly links: readonly EadLink[];
  readonly children: readonly EadUnit[];
}

export interface EadHeader {
  /** EAD 2002 `eadid`, EAD3 `recordid`. */
  readonly id?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly publisher?: string;
  /** EAD 2002 `eadid/@mainagencycode`, EAD3 `maintenanceagency/agencycode`. */
  readonly agencyCode?: string;
  readonly countryCode?: string;
  /** Notes about the file itself, such as "Includes staff-only fields." */
  readonly notes: readonly string[];
}

export interface FindingAid {
  readonly header: EadHeader;
  readonly archdesc: EadUnit;
}

/** The most units one finding aid may hold. */
export const MAX_EAD_UNITS = 100_000;
/** The longest single text value: a paragraph, a title, a name. */
export const MAX_EAD_TEXT_LENGTH = 100_000;

/** Collapse runs of white space into one space and trim. */
export function normalizeEadText(text: string): string {
  return text.replace(/[\t\n\r ]+/g, " ").trim();
}

/** Split stored long text into EAD paragraphs at blank lines. */
export function eadParagraphs(text: string): string[] {
  return text
    .split(/\r?\n[\t ]*\r?\n/)
    .map(normalizeEadText)
    .filter((p) => p !== "");
}

// ---------------------------------------------------------------------------
// Levels.

/** EAD's level names that map to another Oculus level (D-107). */
const LEVEL_FROM_EAD: ReadonlyMap<string, ArchivalLevel> = new Map([
  ["fonds", "fonds"],
  ["series", "series"],
  ["collection", "collection"],
  ["file", "file"],
  ["item", "item"],
  ["subfonds", "fonds"],
  ["recordgrp", "fonds"],
  ["subseries", "series"],
  ["subgrp", "series"],
  ["class", "collection"],
]);

export interface LevelFromEad {
  readonly level: ArchivalLevel;
  /** False when the level was taken as it is; true when it changed (report it). */
  readonly changed: boolean;
}

/**
 * The Oculus level for EAD's `@level` (and `@otherlevel`). Unknown and
 * missing levels become `fallback`, reported as a change.
 */
export function levelFromEad(
  level: string | undefined,
  otherlevel: string | undefined,
  fallback: ArchivalLevel,
): LevelFromEad {
  if (level === "otherlevel") {
    const named = (otherlevel ?? "").trim().toLowerCase();
    const own = (ARCHIVAL_LEVELS as readonly string[]).includes(named);
    return { level: own ? (named as ArchivalLevel) : "collection", changed: true };
  }
  const mapped = level === undefined ? undefined : LEVEL_FROM_EAD.get(level);
  if (mapped === undefined) return { level: fallback, changed: true };
  return { level: mapped, changed: mapped !== level };
}

// ---------------------------------------------------------------------------
// The DACS mapping.

export interface EadDacsMapping {
  /** The field key in the DACS archival unit preset (`presets.ts`). */
  readonly field: string;
  /** Where it is in EAD: a note kind, or a `did` element. */
  readonly ead: string;
}

/**
 * Which DACS preset field each mapped EAD part belongs to (D-107). Where two
 * EAD elements fill one field (relatedmaterial and separatedmaterial are
 * both DACS 6.3), importing joins them and exporting writes the first.
 */
export const EAD_DACS_FIELDS: readonly EadDacsMapping[] = Object.freeze(
  [
    { field: "reference_code", ead: "did/unitid" },
    { field: "repository", ead: "did/repository" },
    { field: "date", ead: "did/unitdate (inclusive)" },
    { field: "bulk_date", ead: "did/unitdate (bulk)" },
    { field: "extent", ead: "did/physdesc" },
    { field: "creators", ead: "did/origination" },
    { field: "languages", ead: "did/langmaterial" },
    { field: "storage_location", ead: "did/physloc" },
    { field: "admin_bio_history", ead: "bioghist" },
    { field: "scope_and_content", ead: "scopecontent" },
    { field: "arrangement", ead: "arrangement" },
    { field: "access_conditions", ead: "accessrestrict" },
    { field: "physical_access", ead: "phystech" },
    { field: "technical_access", ead: "phystech" },
    { field: "reproduction_and_use", ead: "userestrict" },
    { field: "finding_aids", ead: "otherfindaid" },
    { field: "custodial_history", ead: "custodhist" },
    { field: "acquisition_source", ead: "acqinfo" },
    { field: "appraisal", ead: "appraisal" },
    { field: "accruals", ead: "accruals" },
    { field: "originals_location", ead: "originalsloc" },
    { field: "copies_location", ead: "altformavail" },
    { field: "related_materials", ead: "relatedmaterial" },
    { field: "related_materials", ead: "separatedmaterial" },
    { field: "publication_note", ead: "bibliography" },
    { field: "notes", ead: "odd" },
    { field: "notes", ead: "prefercite" },
    { field: "notes", ead: "fileplan" },
    { field: "description_control", ead: "processinfo" },
    { field: "subjects", ead: "controlaccess" },
    { field: "places", ead: "controlaccess/geogname" },
  ].map((m) => Object.freeze(m)),
);

// ---------------------------------------------------------------------------
// Dates.

export interface EadDateEdtf {
  readonly edtf: string;
  /** The original words, when EDTF can't say all they said. */
  readonly note: string | undefined;
}

/** EAD 2002's basic-format `@normal` (19200105) as EDTF's extended form. */
function normalAsEdtf(normal: string): string {
  return normal
    .split("/")
    .map((part) => {
      const m = /^(-?\d{4})(\d{2})(\d{2})$/.exec(part);
      return m === null ? part : `${m[1] ?? ""}-${m[2] ?? ""}-${m[3] ?? ""}`;
    })
    .join("/");
}

/**
 * The EDTF for an EAD date, only when D-008's safe-conversion rules allow:
 * the text first (it keeps "circa"), then `@normal` with the text kept as a
 * note. Otherwise the issues say why, and the date stays text.
 */
export function eadDateEdtf(date: EadDate): Validated<EadDateEdtf> {
  const fromText = edtfFromText(date.text);
  if (fromText.ok)
    return { ok: true, value: { edtf: fromText.value.edtf, note: fromText.value.note } };
  if (date.normal !== undefined) {
    const edtf = normalAsEdtf(date.normal);
    if (parseEdtf(edtf).ok) {
      return { ok: true, value: { edtf, note: date.text === edtf ? undefined : date.text } };
    }
  }
  return fromText;
}

// ---------------------------------------------------------------------------
// Checking a model before it is written.

/** EAD 2002's pattern for `@normal` dates (ISO 8601, one date or a range). */
const DATE_PART =
  "-?[012][0-9]{3}(?:(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])|-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?)?";
export const EAD2002_NORMAL_DATE = new RegExp(`^${DATE_PART}(?:/${DATE_PART})?$`);

/** XML's NMTOKEN, which codes and sources must be. */
const NMTOKEN = /^[\p{L}\p{N}._:-]+$/u;
const DECIMAL = /^\d+(?:\.\d+)?$/;

const UNIT_KEYS = new Set([
  "level",
  "internal",
  "identifiers",
  "title",
  "dates",
  "extents",
  "creators",
  "languages",
  "repository",
  "containers",
  "physicalLocations",
  "abstracts",
  "notes",
  "accessPoints",
  "links",
  "children",
]);
const HEADER_KEYS = new Set([
  "id",
  "title",
  "subtitle",
  "author",
  "publisher",
  "agencyCode",
  "countryCode",
  "notes",
]);

type Obj = Readonly<Record<string, unknown>>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Checker {
  readonly issues = new IssueList();
  units = 0;

  text(value: unknown, path: (string | number)[], required: boolean): void {
    if (value === undefined) {
      if (required) this.issues.add(path, "required", "This is required.");
      return;
    }
    if (typeof value !== "string") {
      this.issues.add(path, "not_text", "Must be text.");
      return;
    }
    if (value === "") {
      this.issues.add(path, "empty", "Must not be empty; leave it out instead.");
      return;
    }
    if (value.length > MAX_EAD_TEXT_LENGTH) {
      this.issues.add(
        path,
        "too_long",
        `Is longer than ${String(MAX_EAD_TEXT_LENGTH)} characters.`,
      );
      return;
    }
    const problem = textProblem(value);
    if (problem !== undefined) {
      this.issues.add(path, "bad_text", `${problem[0]?.toUpperCase() ?? ""}${problem.slice(1)}.`);
      return;
    }
    if (normalizeEadText(value) !== value) {
      this.issues.add(
        path,
        "not_normalized",
        "Must be one line with single spaces and no space at either end (use eadParagraphs).",
      );
    }
  }

  token(value: unknown, path: (string | number)[]): void {
    if (value === undefined) return;
    this.text(value, path, false);
    if (typeof value === "string" && value !== "" && !NMTOKEN.test(value)) {
      this.issues.add(path, "not_a_code", `${shown(value)} must be a code with no spaces.`);
    }
  }

  oneOf(
    value: unknown,
    allowed: readonly string[],
    path: (string | number)[],
    required: boolean,
  ): void {
    if (value === undefined && !required) return;
    if (typeof value !== "string" || !allowed.includes(value)) {
      this.issues.add(path, "not_allowed", `Must be one of: ${allowed.join(", ")}.`);
    }
  }

  keys(value: Obj, allowed: ReadonlySet<string>, path: (string | number)[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key))
        this.issues.add(
          [...path, key],
          "unknown_property",
          `${shown(key)} isn't part of the model.`,
        );
    }
  }

  list(
    value: unknown,
    path: (string | number)[],
    each: (item: unknown, at: (string | number)[]) => void,
  ): void {
    if (!Array.isArray(value)) {
      this.issues.add(path, "not_a_list", "Must be a list.");
      return;
    }
    value.forEach((item, i) => {
      if (!this.issues.full) each(item, [...path, i]);
    });
  }

  object(value: unknown, path: (string | number)[], keys: ReadonlySet<string>): Obj | undefined {
    if (!isObj(value)) {
      this.issues.add(path, "not_an_object", "Must be an object.");
      return undefined;
    }
    this.keys(value, keys, path);
    return value;
  }

  unit(value: unknown, path: (string | number)[], depth: number): void {
    this.units += 1;
    if (this.units > MAX_EAD_UNITS) {
      if (this.units === MAX_EAD_UNITS + 1) {
        this.issues.add(
          path,
          "too_many_units",
          `A finding aid can hold at most ${String(MAX_EAD_UNITS)} units.`,
        );
      }
      return;
    }
    if (depth > MAX_ARRANGEMENT_DEPTH) {
      this.issues.add(
        path,
        "too_deep",
        `Units are nested more than ${String(MAX_ARRANGEMENT_DEPTH)} levels deep.`,
      );
      return;
    }
    const u = this.object(value, path, UNIT_KEYS);
    if (u === undefined) return;
    this.oneOf(u.level, ARCHIVAL_LEVELS, [...path, "level"], true);
    if (typeof u.internal !== "boolean")
      this.issues.add([...path, "internal"], "not_boolean", "Must be true or false.");
    this.text(u.title, [...path, "title"], false);
    this.text(u.repository, [...path, "repository"], false);
    this.list(u.identifiers, [...path, "identifiers"], (v, at) => {
      this.text(v, at, true);
    });
    this.list(u.physicalLocations, [...path, "physicalLocations"], (v, at) => {
      this.text(v, at, true);
    });
    this.list(u.abstracts, [...path, "abstracts"], (v, at) => {
      this.text(v, at, true);
    });
    this.list(u.dates, [...path, "dates"], (v, at) => {
      const d = this.object(v, at, new Set(["text", "normal", "type"]));
      if (d === undefined) return;
      this.text(d.text, [...at, "text"], true);
      this.text(d.normal, [...at, "normal"], false);
      if (typeof d.normal === "string" && /\s/.test(d.normal)) {
        this.issues.add([...at, "normal"], "not_a_code", "A normal date form has no spaces.");
      }
      this.oneOf(d.type, ["inclusive", "bulk"], [...at, "type"], false);
    });
    this.list(u.extents, [...path, "extents"], (v, at) => {
      if (isObj(v) && "text" in v) {
        this.keys(v, new Set(["text"]), at);
        this.text(v.text, [...at, "text"], true);
        return;
      }
      const e = this.object(v, at, new Set(["quantity", "unit", "measure"]));
      if (e === undefined) return;
      this.text(e.quantity, [...at, "quantity"], true);
      if (typeof e.quantity === "string" && !DECIMAL.test(e.quantity)) {
        this.issues.add([...at, "quantity"], "not_a_number", "Must be a number such as 2 or 2.5.");
      }
      this.text(e.unit, [...at, "unit"], true);
      this.oneOf(e.measure, ["carrier", "materialtype"], [...at, "measure"], false);
    });
    this.list(u.creators, [...path, "creators"], (v, at) => {
      const n = this.object(v, at, new Set(["element", "label", "identifier", "source", "role"]));
      if (n === undefined) return;
      this.oneOf(n.element, EAD_NAME_ELEMENTS, [...at, "element"], true);
      this.text(n.label, [...at, "label"], true);
      this.text(n.identifier, [...at, "identifier"], false);
      this.token(n.source, [...at, "source"]);
      this.text(n.role, [...at, "role"], false);
    });
    this.list(u.accessPoints, [...path, "accessPoints"], (v, at) => {
      const n = this.object(v, at, new Set(["element", "label", "identifier", "source"]));
      if (n === undefined) return;
      this.oneOf(n.element, EAD_ACCESS_ELEMENTS, [...at, "element"], true);
      this.text(n.label, [...at, "label"], true);
      this.text(n.identifier, [...at, "identifier"], false);
      this.token(n.source, [...at, "source"]);
    });
    this.list(u.languages, [...path, "languages"], (v, at) => {
      const l = this.object(v, at, new Set(["label", "code"]));
      if (l === undefined) return;
      this.text(l.label, [...at, "label"], true);
      this.token(l.code, [...at, "code"]);
    });
    this.list(u.containers, [...path, "containers"], (v, at) => {
      const c = this.object(v, at, new Set(["type", "value"]));
      if (c === undefined) return;
      this.token(c.type, [...at, "type"]);
      this.text(c.value, [...at, "value"], true);
    });
    this.list(u.links, [...path, "links"], (v, at) => {
      const l = this.object(v, at, new Set(["url", "label"]));
      if (l === undefined) return;
      this.text(l.url, [...at, "url"], true);
      if (typeof l.url === "string") {
        const problem = webUrlProblem(l.url);
        if (problem !== undefined)
          this.issues.add([...at, "url"], "bad_url", `The link ${problem}.`);
      }
      this.text(l.label, [...at, "label"], false);
    });
    this.list(u.notes, [...path, "notes"], (v, at) => {
      const n = this.object(v, at, new Set(["kind", "head", "paragraphs", "internal"]));
      if (n === undefined) return;
      this.oneOf(n.kind, EAD_NOTE_KINDS, [...at, "kind"], true);
      this.text(n.head, [...at, "head"], false);
      if (typeof n.internal !== "boolean")
        this.issues.add([...at, "internal"], "not_boolean", "Must be true or false.");
      this.list(n.paragraphs, [...at, "paragraphs"], (p, pat) => {
        this.text(p, pat, true);
      });
      if (Array.isArray(n.paragraphs) && n.paragraphs.length === 0) {
        this.issues.add([...at, "paragraphs"], "empty", "A note needs at least one paragraph.");
      }
    });
    if (u.title === undefined && (!Array.isArray(u.dates) || u.dates.length === 0)) {
      this.issues.add(path, "no_title", "A unit needs a title or a date.");
    }
    this.list(u.children, [...path, "children"], (c, at) => {
      this.unit(c, at, depth + 1);
    });
  }
}

/**
 * Check a finding aid before it is written: the shape, the text (one line,
 * no control or direction characters), codes, links (D-010's web address
 * rule) and the limits. Returns a frozen plain copy, or every problem.
 */
export function validateFindingAid(input: unknown): Validated<FindingAid> {
  const c = new Checker();
  let copied: unknown;
  try {
    copied = readPlainData(
      input,
      [],
      {
        maxDepth: MAX_ARRANGEMENT_DEPTH * 2 + 10,
        maxValues: 5_000_000,
        maxStringLength: MAX_EAD_TEXT_LENGTH,
        maxKeyLength: 100,
        maxTotalChars: 200_000_000,
      },
      c.issues,
    );
  } catch {
    return { ok: false, issues: [issue([], "unreadable", "The finding aid couldn't be read.")] };
  }
  if (copied === undefined) return { ok: false, issues: c.issues.items };
  const top = c.object(copied, [], new Set(["header", "archdesc"]));
  if (top !== undefined) {
    const h = c.object(top.header, ["header"], HEADER_KEYS);
    if (h !== undefined) {
      c.text(h.id, ["header", "id"], true);
      c.text(h.title, ["header", "title"], true);
      c.text(h.subtitle, ["header", "subtitle"], false);
      c.text(h.author, ["header", "author"], false);
      c.text(h.publisher, ["header", "publisher"], false);
      c.token(h.agencyCode, ["header", "agencyCode"]);
      c.token(h.countryCode, ["header", "countryCode"]);
      c.list(h.notes, ["header", "notes"], (v, at) => {
        c.text(v, at, true);
      });
    }
    c.unit(top.archdesc, ["archdesc"], 1);
  }
  if (c.issues.count > 0) return { ok: false, issues: c.issues.items };
  return { ok: true, value: copied as FindingAid };
}
