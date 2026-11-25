/**
 * Finding aids from catalog records (T-059b, D-107, D-120): the archival
 * units under one top unit, as the `FindingAid` model `writeEad` writes.
 *
 * Pure mapping, no reading: the caller decides which records and which of
 * their values are seen, and says for whom the file is.
 *
 * - **public**: the caller gives only what a public site shows (each unit's
 *   public view, from the public reader, with its published descendants
 *   only). Anything marked staff-only is refused outright
 *   (`staff_value_in_public`), so a caller's mistake fails closed instead
 *   of publishing it. Nothing is marked `audience="internal"`.
 * - **staff**: every value of the record's own; each one whose field is
 *   staff-only (or an identifier whose type isn't public) becomes a note
 *   marked staff-only (`internal: true`, written `audience="internal"`),
 *   headed with the field's label, never a public element. The header says
 *   the file holds staff-only values.
 *
 * Only a record's own values are used: EAD's tree carries what a unit
 * inherits from the units above it, so inherited values are not repeated.
 *
 * Fields map by their DACS key (`EAD_DACS_FIELDS`): `reference_code` →
 * `unitid`, `date`/`bulk_date` → `unitdate`, `extent` → `physdesc`,
 * `creators` → `origination`, `languages` → `langmaterial`,
 * `storage_location` → `physloc`, `repository`, the description notes,
 * `subjects` and `places` → `controlaccess`. Any other value goes in an
 * `odd` note headed with its field's label, so nothing a template holds is
 * lost. Links become `dao` only when they pass `webUrlProblem`; record
 * links are never written (their labels may name private records, D-045).
 */
import {
  normalizeEadText,
  eadParagraphs,
  MAX_EAD_TEXT_LENGTH,
  MAX_EAD_UNITS,
} from "./ead-model.js";
import type {
  EadAccessPoint,
  EadDate,
  EadExtent,
  EadHeader,
  EadLanguage,
  EadLink,
  EadName,
  EadNote,
  EadNoteKind,
  EadUnit,
  FindingAid,
} from "./ead-model.js";
import { validateFindingAid } from "./ead-model.js";
import { isPlainObject, type Issue, type Validated } from "./issues.js";
import { textProblem, withoutBadText } from "./plain-data.js";
import type { RecordId } from "./record-id.js";
import { ARCHIVAL_LEVELS, type ArchivalLevel, type FieldValue } from "./records.js";
import { webUrlProblem, type FieldKind } from "./templates.js";

/** For whom a finding aid is made. */
export type EadAudience = "public" | "staff";

/** One of a unit's own values, with what its template says about it. */
export interface EadExportField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly value: FieldValue;
  /** True for a staff-only field. Never true in a public export. */
  readonly staffOnly: boolean;
  /** A list field's options, to write labels rather than codes. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** An archival unit to write. */
export interface EadExportUnit {
  readonly id: RecordId;
  /** The unit above it; left out for the top unit. */
  readonly parentId?: RecordId;
  readonly level: ArchivalLevel;
  readonly title: string;
  readonly fields: readonly EadExportField[];
}

export interface EadExportOptions {
  readonly audience: EadAudience;
  /**
   * Staff exports: the identifier types that are public (D-022). A number of
   * any other type is written as a staff-only note, never as `unitid`.
   * Public exports take only public numbers in the first place.
   */
  readonly publicIdentifierTypes?: ReadonlySet<string>;
  /** The file's identifier when the top unit has no reference code (its record ID otherwise). */
  readonly fileId?: string;
}

/** Notes made on the way: values left out, and why (field keys and labels only). */
export interface EadExport {
  readonly findingAid: FindingAid;
  readonly notices: readonly Issue[];
}

/** The longest export file, in characters (a finding aid stays one download). */
export const MAX_EAD_EXPORT_CHARS = 32 * 2 ** 20;

/** The most units one export holds (a finding aid stays one download). */
export const MAX_EXPORT_UNITS = 5_000;

const NOTE_FOR_KEY: ReadonlyMap<string, EadNoteKind> = new Map<string, EadNoteKind>([
  ["admin_bio_history", "bioghist"],
  ["scope_and_content", "scopecontent"],
  ["arrangement", "arrangement"],
  ["access_conditions", "accessrestrict"],
  ["physical_access", "phystech"],
  ["technical_access", "phystech"],
  ["reproduction_and_use", "userestrict"],
  ["finding_aids", "otherfindaid"],
  ["custodial_history", "custodhist"],
  ["acquisition_source", "acqinfo"],
  ["appraisal", "appraisal"],
  ["accruals", "accruals"],
  ["originals_location", "originalsloc"],
  ["copies_location", "altformavail"],
  ["related_materials", "relatedmaterial"],
  ["publication_note", "bibliography"],
  ["notes", "odd"],
  ["description_control", "processinfo"],
]);

/** Notes headed with their field's label: more than one field writes this kind. */
const SHARED_NOTE_KINDS: ReadonlySet<EadNoteKind> = new Set(["phystech", "odd"]);

/** Error thrown inside the mapping: a value a public export must never hold. */
class StaffInPublic extends Error {}

interface Built {
  identifiers: string[];
  dates: EadDate[];
  extents: EadExtent[];
  creators: EadName[];
  languages: EadLanguage[];
  repository?: string;
  physicalLocations: string[];
  notes: EadNote[];
  accessPoints: EadAccessPoint[];
  links: EadLink[];
}

/** One-line text fit for the model: cleaned, cut, or undefined when empty. */
function line(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  let value = normalizeEadText(text);
  if (textProblem(value) !== undefined) value = normalizeEadText(withoutBadText(value));
  if (value.length > MAX_EAD_TEXT_LENGTH)
    value = normalizeEadText(value.slice(0, MAX_EAD_TEXT_LENGTH));
  return value === "" ? undefined : value;
}

function paragraphs(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const cleaned = textProblem(text) === undefined ? text : withoutBadText(text);
  return eadParagraphs(cleaned)
    .map((p) => line(p))
    .filter((p): p is string => p !== undefined);
}

function prop(value: FieldValue, key: string): unknown {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A code with no spaces (a URI or authority number), or undefined. */
function token(value: unknown): string | undefined {
  const text = line(value);
  return text === undefined || /\s/.test(text) ? undefined : text;
}

/** A vocabulary code EAD's `@source` can hold (an NMTOKEN), or undefined. */
function sourceCode(value: unknown): string | undefined {
  const text = token(value);
  return text !== undefined && /^[\p{L}\p{N}._:-]+$/u.test(text) ? text : undefined;
}

/** Each value of a field (one, or each of a repeatable list). */
function each(value: FieldValue): FieldValue[] {
  if (Array.isArray(value)) return value as FieldValue[];
  return value === null ? [] : [value];
}

/** A value as plain text, for a note: what a person reads in the catalog. */
function textOf(field: EadExportField, value: FieldValue): string | undefined {
  switch (field.kind) {
    case "text":
    case "long_text":
    case "date":
      return line(value);
    case "list": {
      const code = typeof value === "string" ? value : undefined;
      const option = field.options?.find((o) => o.value === code);
      return line(option?.label ?? code);
    }
    case "controlled_term":
    case "place":
      return line(prop(value, "label"));
    case "identifier":
      return line(prop(value, "value"));
    case "link": {
      const url = line(prop(value, "url"));
      const label = line(prop(value, "label"));
      return label !== undefined && url !== undefined ? `${label} (${url})` : (url ?? label);
    }
    case "rights":
      return line(prop(value, "uri"));
    case "record_link":
      return undefined;
  }
}

/**
 * A value's text, even when it doesn't fit its field's kind (a value left
 * from an older template): the first of its label, value, URL or URI.
 */
function anyText(field: EadExportField, value: FieldValue): string | undefined {
  const text = textOf(field, value);
  if (text !== undefined || field.kind === "record_link") return text;
  if (typeof value === "string") return line(value);
  for (const key of ["label", "value", "url", "uri"]) {
    const found = line(prop(value, key));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The finding aid for the unit `rootId` and the units below it in `units`
 * (every unit must be reachable from the root through units given; others
 * are ignored and noted). Refused when the root is missing, the export is
 * too big, or a public export is given a staff-only value.
 */
export function findingAidFromUnits(
  rootId: RecordId,
  units: readonly EadExportUnit[],
  options: EadExportOptions,
): Validated<EadExport> {
  const fail = (code: string, message: string): Validated<EadExport> => ({
    ok: false,
    issues: [{ path: [], code, message }],
  });
  const audience: unknown = options.audience;
  if (audience !== "public" && audience !== "staff") {
    return fail("invalid_options", 'The audience is "public" or "staff".');
  }
  if (units.length > MAX_EXPORT_UNITS || units.length > MAX_EAD_UNITS) {
    return fail(
      "too_many_units",
      `A finding aid can hold at most ${String(MAX_EXPORT_UNITS)} units; export a lower unit instead.`,
    );
  }
  const staff = options.audience === "staff";
  const notices: Issue[] = [];
  const byId = new Map<string, EadExportUnit>();
  const children = new Map<string, EadExportUnit[]>();
  for (const unit of units) {
    if (byId.has(unit.id)) continue;
    byId.set(unit.id, unit);
    if (unit.parentId !== undefined && unit.id !== rootId) {
      const list = children.get(unit.parentId) ?? [];
      list.push(unit);
      children.set(unit.parentId, list);
    }
  }
  const root = byId.get(rootId);
  if (root === undefined) return fail("not_found", "The top unit isn't among the units given.");

  const order = (a: EadExportUnit, b: EadExportUnit): number =>
    a.title.localeCompare(b.title, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const placed = new Set<string>();
  const build = (unit: EadExportUnit, depth: number): EadUnit => {
    placed.add(unit.id);
    const b: Built = {
      identifiers: [],
      dates: [],
      extents: [],
      creators: [],
      languages: [],
      physicalLocations: [],
      notes: [],
      accessPoints: [],
      links: [],
    };
    for (const field of unit.fields) mapField(field, b, staff, options, notices, unit.id);
    const below =
      depth >= 63
        ? []
        : (children.get(unit.id) ?? [])
            .filter((c) => !placed.has(c.id))
            .sort(order)
            .map((c) => build(c, depth + 1));
    if (depth >= 63 && (children.get(unit.id) ?? []).length > 0) {
      notices.push({
        path: [unit.id],
        code: "too_deep",
        message: "Units nested more than 64 levels deep were left out.",
      });
    }
    const level: ArchivalLevel = (ARCHIVAL_LEVELS as readonly string[]).includes(unit.level)
      ? unit.level
      : "collection";
    const title = line(unit.title);
    return {
      level,
      internal: false,
      identifiers: b.identifiers,
      ...(title === undefined ? {} : { title }),
      dates: b.dates,
      extents: b.extents,
      creators: b.creators,
      languages: b.languages,
      ...(b.repository === undefined ? {} : { repository: b.repository }),
      containers: [],
      physicalLocations: b.physicalLocations,
      abstracts: [],
      notes: b.notes,
      accessPoints: b.accessPoints,
      links: b.links,
      children: below,
    };
  };

  let archdesc: EadUnit;
  try {
    archdesc = build(root, 0);
  } catch (error) {
    if (error instanceof StaffInPublic) {
      return fail(
        "staff_value_in_public",
        "A staff-only value was given for a public finding aid, so nothing was written.",
      );
    }
    throw error;
  }
  const unplaced = units.filter((u) => !placed.has(u.id)).length;
  if (unplaced > 0) {
    notices.push({
      path: [],
      code: "units_not_placed",
      message: `${String(unplaced)} unit(s) aren't below the top unit through the units given, so they were left out.`,
    });
  }
  const headerNotes = staff
    ? [
        'Includes staff-only values, each marked audience="internal". Not for publication.',
        "Exported from Oculus.",
      ]
    : ["Exported from Oculus."];
  const id = archdesc.identifiers[0] ?? token(options.fileId) ?? root.id;
  const header: EadHeader = {
    id,
    ...(archdesc.title === undefined ? {} : { title: archdesc.title }),
    ...(archdesc.repository === undefined ? {} : { publisher: archdesc.repository }),
    notes: headerNotes,
  };
  const aid: FindingAid = { header, archdesc };
  const checked = validateFindingAid(aid);
  if (!checked.ok) return { ok: false, issues: checked.issues };
  return { ok: true, value: { findingAid: checked.value, notices } };
}

function mapField(
  field: EadExportField,
  b: Built,
  staff: boolean,
  options: EadExportOptions,
  notices: Issue[],
  unitId: RecordId,
): void {
  if (field.staffOnly && !staff) throw new StaffInPublic();
  let values = each(field.value);
  if (values.length === 0) return;
  const head = line(field.label) ?? field.key;

  /** The values as staff-only text in a note of their own. */
  const internalNote = (kind: EadNoteKind): void => {
    const texts =
      field.kind === "long_text"
        ? values.flatMap((v) => paragraphs(v))
        : values.map((v) => anyText(field, v)).filter((t): t is string => t !== undefined);
    if (field.kind === "rights") {
      for (const v of values) {
        const note = line(prop(v, "note"));
        if (note !== undefined) texts.push(note);
      }
    }
    if (texts.length > 0) b.notes.push({ kind, head, paragraphs: texts, internal: true });
  };

  // A number whose identifier type isn't public is staff-only, whatever field
  // shows it (D-022): in a staff file it goes in a note of its own, marked.
  if (field.kind === "identifier" && staff) {
    const hidden = values.filter((v) => {
      const type = prop(v, "type");
      return !(typeof type === "string" && options.publicIdentifierTypes?.has(type) === true);
    });
    const texts = hidden
      .map((v) => line(prop(v, "value")))
      .filter((t): t is string => t !== undefined);
    if (texts.length > 0) b.notes.push({ kind: "odd", head, paragraphs: texts, internal: true });
    values = values.filter((v) => !hidden.includes(v));
    if (values.length === 0) return;
  }

  if (field.kind === "record_link") {
    // Never written: a record link's label may be copied from a private record (D-045).
    notices.push({
      path: [unitId, field.key],
      code: "record_link_left_out",
      message: `${head}: links to other records aren't written to EAD.`,
    });
    return;
  }
  const noteKind = NOTE_FOR_KEY.get(field.key);
  if (field.staffOnly) {
    internalNote(noteKind ?? "odd");
    return;
  }
  // A rights statement's note is staff-only (D-016), even in a public field.
  if (field.kind === "rights" && staff) {
    const notes = values
      .map((v) => line(prop(v, "note")))
      .filter((t): t is string => t !== undefined);
    if (notes.length > 0)
      b.notes.push({ kind: "userestrict", head, paragraphs: notes, internal: true });
  }

  switch (field.key) {
    case "reference_code":
      if (field.kind === "identifier") {
        for (const v of values) {
          const value = line(prop(v, "value"));
          if (value !== undefined) b.identifiers.push(value);
        }
        return;
      }
      break;
    case "repository":
      if (b.repository === undefined) {
        const text = textOf(field, values[0] ?? null);
        if (text !== undefined) {
          b.repository = text;
          return;
        }
      }
      break;
    case "date":
    case "bulk_date":
      if (field.kind === "date") {
        for (const v of values) {
          const text = line(v);
          if (text === undefined) continue;
          b.dates.push({
            text,
            ...(/\s/.test(text) ? {} : { normal: text }),
            type: field.key === "bulk_date" ? "bulk" : "inclusive",
          });
        }
        return;
      }
      break;
    case "extent":
      for (const v of values) {
        const text = textOf(field, v);
        if (text !== undefined) b.extents.push({ text });
      }
      return;
    case "creators":
      for (const v of values) {
        const label = textOf(field, v);
        if (label === undefined) continue;
        const identifier = token(prop(v, "uri"));
        const source = sourceCode(prop(v, "vocabulary"));
        b.creators.push({
          element: "name",
          label,
          ...(identifier === undefined ? {} : { identifier }),
          ...(source === undefined ? {} : { source }),
        });
      }
      return;
    case "languages":
      for (const v of values) {
        const label = textOf(field, v);
        if (label !== undefined) b.languages.push({ label });
      }
      return;
    case "storage_location":
      for (const v of values) {
        const text = textOf(field, v);
        if (text !== undefined) b.physicalLocations.push(text);
      }
      return;
    case "subjects":
    case "places":
      if (field.kind === "controlled_term" || field.kind === "place") {
        for (const v of values) {
          const label = textOf(field, v);
          if (label === undefined) continue;
          const identifier = token(prop(v, "uri"));
          const source = sourceCode(prop(v, "vocabulary"));
          b.accessPoints.push({
            element: field.key === "places" || field.kind === "place" ? "geogname" : "subject",
            label,
            ...(identifier === undefined ? {} : { identifier }),
            ...(source === undefined ? {} : { source }),
          });
        }
        return;
      }
      break;
  }
  if (field.kind === "link") {
    for (const v of values) {
      const url = line(prop(v, "url"));
      if (url === undefined || webUrlProblem(url) !== undefined) {
        notices.push({
          path: [unitId, field.key],
          code: "link_left_out",
          message: `${head}: a link that isn't a plain web address was left out.`,
        });
        continue;
      }
      const label = line(prop(v, "label"));
      b.links.push({ url, ...(label === undefined ? {} : { label }) });
    }
    return;
  }
  // Everything else: a note of its kind (or odd), headed when kinds are shared.
  const kind = noteKind ?? (field.kind === "rights" ? "userestrict" : "odd");
  const texts =
    field.kind === "long_text"
      ? values.flatMap((v) => paragraphs(v))
      : values.map((v) => anyText(field, v)).filter((t): t is string => t !== undefined);
  if (texts.length === 0) return;
  const headed = noteKind === undefined || SHARED_NOTE_KINDS.has(kind);
  b.notes.push(
    headed
      ? { kind, head, paragraphs: texts, internal: false }
      : { kind, paragraphs: texts, internal: false },
  );
}
