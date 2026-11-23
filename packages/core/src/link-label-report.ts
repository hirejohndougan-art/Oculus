/**
 * Link labels that no longer match the linked record's title, for Data
 * Cleaning (roadmap T-015a, decisions D-039 and D-055).
 *
 * A `record_link` value is `{ recordId, label }`, and a place value may name
 * a place record with `recordId` beside its own `label` (D-039). The label is
 * the linking record's own text, usually copied from the linked record's
 * title when the link was made; when that record is renamed, the label stays
 * as it was. `findStaleLinkLabels` lists the links whose label differs from
 * the linked record's current title, so a person can update the label or
 * decide the difference is meant. It never changes anything.
 *
 * **Staff only.** Each entry quotes the label and the linked record's title,
 * which may be private (a donor's name, an unpublished item's title). The
 * report is for the staff Data Cleaning screen and must never reach public
 * output.
 *
 * **One organization only.** The caller names its organization, and gives
 * that organization's records (a list or an `indexRecords` lookup) and
 * templates (a registry from `indexTemplates`, or a lookup function).
 * Records of another organization, a set mixing organizations, or another
 * organization's template registry refuse the whole report, with messages
 * that name nothing. Titles are looked up only in the records given, so a
 * link to an ID that isn't one of them (another organization's record, a
 * deleted one, one whose ID is used twice or that isn't valid) is never
 * quoted: it is only counted in `unknownTargets`. A template the lookup
 * returns for another organization is refused for that record, which is
 * listed in `skipped`.
 *
 * Only a record's own values are read (inherited values are its ancestors'
 * own values, reported there), in the fields its template makes
 * `record_link` or `place`. Labels and titles are compared after Unicode NFC
 * normalisation, trimming and collapsing runs of white space; case counts.
 * A link to the record itself is ignored. Work is linear in the records and
 * their link values. Never throws.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { types } from "node:util";
import { isOrganizationId, type OrganizationId } from "./organizations.js";
import { isRecordId, type RecordId } from "./record-id.js";
import type { CatalogRecord } from "./records.js";
import { isTemplateSource, recordsById, templateFromSource } from "./effective.js";
import { isTemplateRegistry, templateRegistryOrganization } from "./templates.js";

/** One link whose label differs from the linked record's current title. */
export interface StaleLinkLabel {
  /** The record holding the link. */
  readonly recordId: RecordId;
  /** The field key the link is stored under. */
  readonly key: string;
  /** `record_link` or `place`. */
  readonly fieldKind: "record_link" | "place";
  /** The link's position in a list of values; absent for a single value. */
  readonly index?: number;
  /** The record linked to. */
  readonly linkedRecordId: RecordId;
  /** The label stored with the link. */
  readonly label: string;
  /** The linked record's current title. */
  readonly title: string;
}

/** A record whose links couldn't be read, by ID and issue code only. */
export interface SkippedLinkRecord {
  readonly recordId: RecordId;
  /** `invalid_record`, or the code from finding its template (`no_template`, `wrong_organization`, ...). */
  readonly code: string;
}

export interface StaleLinkLabelsReport {
  /** At most `maxEntries`, in the order of the records, then the template's fields. */
  readonly entries: readonly StaleLinkLabel[];
  /** How many links have a stale label, even past `maxEntries`. */
  readonly count: number;
  /** True when `count` is more than the entries listed. */
  readonly truncated: boolean;
  /** Links to an ID that isn't a usable record in the set; never quoted. */
  readonly unknownTargets: number;
  /** Records whose links weren't read; at most `maxEntries` listed. */
  readonly skipped: readonly SkippedLinkRecord[];
  /** How many records were skipped, even past the ones listed. */
  readonly skippedCount: number;
}

export interface StaleLinkLabelsOptions {
  /** How many entries (and skipped records) to list, 1 to `MAX_STALE_LINK_LABELS`. Default 500. */
  readonly maxEntries?: number;
}

export const DEFAULT_STALE_LINK_LABELS = 500;
export const MAX_STALE_LINK_LABELS = 10_000;

/**
 * List the links in `organizationId`'s `records` whose label no longer
 * matches the linked record's title, finding each record's link fields
 * through `templates`. See the module header. Never throws.
 */
export function findStaleLinkLabels(
  organizationId: unknown,
  records: unknown,
  templates: unknown,
  options: StaleLinkLabelsOptions = {},
): Validated<StaleLinkLabelsReport> {
  try {
    return report(organizationId, records, templates, options);
  } catch {
    return refuse([], "unreadable", "These records or templates could not be read.");
  }
}

function refuse(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return Object.freeze({
    ok: false,
    issues: Object.freeze([Object.freeze(issue(path, code, message))]),
  });
}

const WRONG_ORGANIZATION = (path: string) =>
  refuse(
    [path],
    "wrong_organization",
    "These belong to another organization, so they can't be used for this report.",
  );

function report(
  organizationId: unknown,
  recordsInput: unknown,
  templates: unknown,
  options: unknown,
): Validated<StaleLinkLabelsReport> {
  if (!isOrganizationId(organizationId)) {
    return refuse(["organizationId"], "invalid_organization", "Give a valid organization ID.");
  }
  const max = readMax(options);
  if (max === undefined) {
    return refuse(
      ["options", "maxEntries"],
      "invalid_option",
      `The options must be a plain object, and maxEntries a whole number from 1 to ${String(MAX_STALE_LINK_LABELS)}.`,
    );
  }
  if (!isTemplateSource(templates)) {
    return refuse(
      ["templates"],
      "invalid_templates",
      "The templates must be a registry from indexTemplates or a lookup function.",
    );
  }
  // Another organization's registry is refused before any record is read.
  if (isTemplateRegistry(templates)) {
    const owner = templateRegistryOrganization(templates);
    if (owner !== undefined && owner !== organizationId) return WRONG_ORGANIZATION("templates");
  }
  const found = recordsById(recordsInput);
  if (!found.ok) return refuse(["records"], found.issues[0]?.code ?? "unreadable", READ_FAILED);
  const byId = found.value;
  if (!oneOrganization(byId, organizationId)) return WRONG_ORGANIZATION("records");

  const entries: StaleLinkLabel[] = [];
  const skipped: SkippedLinkRecord[] = [];
  let count = 0;
  let skippedCount = 0;
  let unknownTargets = 0;
  const skip = (recordId: RecordId, code: string) => {
    skippedCount += 1;
    if (skipped.length < max) skipped.push(Object.freeze({ recordId, code }));
  };

  for (const [id, record] of byId) {
    if (record === undefined) {
      skip(id, "invalid_record");
      continue;
    }
    const template = templateFromSource(record, templates);
    if (!template.ok) {
      skip(id, template.issues[0]?.code ?? "unreadable");
      continue;
    }
    for (const field of template.value.fields) {
      if (field.kind !== "record_link" && field.kind !== "place") continue;
      if (!Object.hasOwn(record.fields, field.key)) continue;
      const value = record.fields[field.key];
      const list = Array.isArray(value) ? value : [value];
      for (const [i, item] of list.entries()) {
        if (!isPlainObject(item)) continue;
        const target = item.recordId;
        const label = item.label;
        if (!isRecordId(target) || typeof label !== "string" || target === id) continue;
        const linked = byId.get(target);
        if (linked === undefined) {
          unknownTargets += 1;
          continue;
        }
        if (normal(label) === normal(linked.title)) continue;
        count += 1;
        if (entries.length >= max) continue;
        entries.push(
          Object.freeze({
            recordId: id,
            key: field.key,
            fieldKind: field.kind,
            ...(Array.isArray(value) ? { index: i } : {}),
            linkedRecordId: target,
            label,
            title: linked.title,
          }),
        );
      }
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      entries: Object.freeze(entries),
      count,
      truncated: count > entries.length,
      unknownTargets,
      skipped: Object.freeze(skipped),
      skippedCount,
    }),
  };
}

const READ_FAILED =
  "The records could not be read as one organization's set. Check them with indexRecords.";

/** True when every valid record in the set is `organizationId`'s (an empty set is). */
function oneOrganization(
  byId: ReadonlyMap<RecordId, CatalogRecord | undefined>,
  organizationId: OrganizationId,
): boolean {
  // indexRecords refuses a set mixing organizations, so the first readable
  // record decides; every one is checked anyway, at no real cost.
  for (const record of byId.values()) {
    if (record !== undefined && record.organizationId !== organizationId) return false;
  }
  return true;
}

function normal(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** `maxEntries` from `options`, read as an own data property; undefined when bad. */
function readMax(options: unknown): number | undefined {
  if (types.isProxy(options) || !isPlainObject(options)) return undefined;
  const d = Object.getOwnPropertyDescriptor(options, "maxEntries");
  if (d === undefined) return DEFAULT_STALE_LINK_LABELS;
  if (!("value" in d)) return undefined;
  const value: unknown = d.value;
  if (value === undefined) return DEFAULT_STALE_LINK_LABELS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_STALE_LINK_LABELS
  ) {
    return undefined;
  }
  return value;
}
