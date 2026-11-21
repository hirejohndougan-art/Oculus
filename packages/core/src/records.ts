/**
 * Record types (PLATFORM_PLAN.md §1, decision D-007).
 *
 * Every catalog record has a kind, a permanent ID, a title, timestamps and a
 * bag of template-defined fields. Six kinds are built in:
 *
 * - `object`: a museum object (a chair, a plow, a uniform).
 * - `archival_unit`: one level of an archival arrangement, from fonds down to
 *   a single item (see `arrangement.ts`).
 * - `digital_asset`: a file: a scan, a recording, a born-digital document.
 * - `agent`: a person, organization or family.
 * - `place`: a named place, optionally with a map position.
 * - `event`: something that happened (a storm, a festival, an election).
 *
 * The template-defined fields are checked here only for being safe, plain
 * JSON. Which fields a record must have is the job of field templates (T-005).
 */
import { issue, isPlainObject, type Validated } from "./issues.js";
import { FORBIDDEN_KEYS, IssueList, readPlainData, shown, type JsonValue } from "./plain-data.js";
import { types } from "node:util";
import { isRecordId, newRecordId, type RecordId } from "./record-id.js";
import { isOrganizationId, type OrganizationId } from "./organizations.js";

export const RECORD_KINDS = [
  "object",
  "archival_unit",
  "digital_asset",
  "agent",
  "place",
  "event",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Levels of archival arrangement, from the top down (see D-007). */
export const ARCHIVAL_LEVELS = ["fonds", "series", "collection", "file", "item"] as const;
export type ArchivalLevel = (typeof ARCHIVAL_LEVELS)[number];

export const AGENT_TYPES = ["person", "organization", "family"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** A JSON value, as stored in a record's template-defined fields. */
export type FieldValue = JsonValue;

interface RecordBase {
  readonly id: RecordId;
  /**
   * The organization the record belongs to (D-019, D-0XX). It never changes,
   * and the units a record is filed under or represents belong to the same one.
   */
  readonly organizationId: OrganizationId;
  readonly title: string;
  /** ISO 8601 UTC timestamp, e.g. `2026-11-20T16:05:00.000Z`. */
  readonly createdAt: string;
  /** ISO 8601 UTC timestamp; never earlier than `createdAt`. */
  readonly updatedAt: string;
  /**
   * The key of the field template this record follows (D-029). The checks,
   * `effectiveRecord` and `publicOutput` find the template from it, and
   * refuse a template with any other key. Left out only by records stored
   * before records named their template; those can be checked only through a
   * template lookup function, never through a registry from `indexTemplates`.
   */
  readonly templateKey?: string;
  /** Template-defined fields, keyed by field key (`date`, `subjects` …). */
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface ObjectRecord extends RecordBase {
  readonly kind: "object";
}

export interface ArchivalUnitRecord extends RecordBase {
  readonly kind: "archival_unit";
  readonly level: ArchivalLevel;
  /** The unit this one is filed under. Missing means not filed yet, or top level. */
  readonly parentId?: RecordId;
}

export interface DigitalAssetRecord extends RecordBase {
  readonly kind: "digital_asset";
  /** The file's media type, e.g. `image/tiff`, `audio/wav`. */
  readonly mediaType: string;
  /** The record this file is a scan or recording of, if any. */
  readonly represents?: RecordId;
}

export interface AgentRecord extends RecordBase {
  readonly kind: "agent";
  readonly agentType: AgentType;
}

export interface PlaceRecord extends RecordBase {
  readonly kind: "place";
  /** WGS 84 map position, in decimal degrees. */
  readonly coordinates?: { readonly lat: number; readonly lng: number };
}

export interface EventRecord extends RecordBase {
  readonly kind: "event";
}

export type CatalogRecord =
  ObjectRecord | ArchivalUnitRecord | DigitalAssetRecord | AgentRecord | PlaceRecord | EventRecord;

// ---------------------------------------------------------------------------
// Limits. Generous for real catalog work, small enough to refuse abuse.

export const MAX_TITLE_LENGTH = 1000;
/** The longest a single text value in a record may be. */
export const MAX_STRING_LENGTH = 100_000;
/** How deep a field value may nest (a plain value is 1). */
export const MAX_FIELD_DEPTH = 8;
/** How many values (including every list and group) a whole record may hold. */
export const MAX_FIELD_ENTRIES = 2000;
/** All the text in a record (keys and values) added together. */
export const MAX_RECORD_CHARS = 1_000_000;
/** The longest a key inside a field value may be. */
export const MAX_KEY_LENGTH = 200;

const READ_LIMITS = {
  // The record is depth 1, `fields` depth 2, so a field value starts at depth 3.
  maxDepth: MAX_FIELD_DEPTH + 1,
  maxValues: MAX_FIELD_ENTRIES,
  maxStringLength: MAX_STRING_LENGTH,
  maxKeyLength: MAX_KEY_LENGTH,
  maxTotalChars: MAX_RECORD_CHARS,
} as const;

const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** Template keys: the same rule `validateTemplate` applies to a template's `key`. */
const TEMPLATE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
/** Characters allowed in stored text but not in a one-line title. */
const TITLE_BREAKS = /[\t\n\r\u2028\u2029]/;
/** Exactly the form Date.prototype.toISOString() writes, so stored timestamps sort as text. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** RFC 6838 type/subtype, restricted-name characters only, no parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const COMMON_KEYS = [
  "id",
  "organizationId",
  "kind",
  "title",
  "templateKey",
  "createdAt",
  "updatedAt",
  "fields",
] as const;
const EXTRA_KEYS: Readonly<Record<RecordKind, readonly string[]>> = {
  object: [],
  archival_unit: ["level", "parentId"],
  digital_asset: ["mediaType", "represents"],
  agent: ["agentType"],
  place: ["coordinates"],
  event: [],
};

// ---------------------------------------------------------------------------

/**
 * Check untrusted input (from an API request, an import, a stored row) and
 * return it as a typed record, or every problem found.
 *
 * The record returned is a fresh, frozen copy built from plain data only (see
 * `plain-data.ts`), never the caller's object, so nothing can change after it
 * was checked. Nothing is trimmed, guessed or dropped: a value that isn't
 * exactly right is reported. This function never throws.
 */
export function validateRecord(input: unknown): Validated<CatalogRecord> {
  try {
    return check(input);
  } catch {
    // Only a hostile input (a getter or Proxy that throws) gets here.
    return {
      ok: false,
      issues: [issue([], "unreadable", "This record could not be read as plain data.")],
    };
  }
}

function check(input: unknown): Validated<CatalogRecord> {
  if (types.isProxy(input) || !isPlainObject(input)) {
    return { ok: false, issues: [issue([], "not_an_object", "A record must be a plain object.")] };
  }
  const issues = new IssueList();
  const copy = readPlainData(input, [], READ_LIMITS, issues);
  if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
  // Read only the copy's own properties, never anything inherited.
  const record: Readonly<Record<string, JsonValue | undefined>> = ownOnly(copy);

  const kind = record.kind;
  if (!isRecordKind(kind)) {
    issues.add(["kind"], "invalid_kind", `Kind must be one of: ${RECORD_KINDS.join(", ")}.`);
    return { ok: false, issues: issues.items };
  }

  const allowed = new Set<string>([...COMMON_KEYS, ...EXTRA_KEYS[kind]]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.add([key], "unknown_property", `${shown(key)} is not a property of a ${kind}.`);
    }
  }

  if (!isRecordId(record.id)) {
    issues.add(["id"], "invalid_id", "The ID must be a lowercase version 4 UUID.");
  }
  if (!isOrganizationId(record.organizationId)) {
    issues.add(
      ["organizationId"],
      "invalid_organization",
      "Every record belongs to one organization: organizationId must be an organization ID.",
    );
  }
  checkTitle(record.title, issues);
  if (record.templateKey !== undefined && !isTemplateKey(record.templateKey)) {
    issues.add(
      ["templateKey"],
      "invalid_template_key",
      "The template key is 1 to 64 lower case letters, digits, hyphens and underscores, starting with a letter.",
    );
  }
  checkTimestamps(record.createdAt, record.updatedAt, issues);
  checkFields(record.fields, issues);

  switch (kind) {
    case "archival_unit":
      if (!isArchivalLevel(record.level)) {
        issues.add(
          ["level"],
          "invalid_level",
          `Level must be one of: ${ARCHIVAL_LEVELS.join(", ")}.`,
        );
      }
      checkOptionalLink(record, "parentId", "A unit can't be filed under itself.", issues);
      break;
    case "digital_asset":
      if (typeof record.mediaType !== "string" || !MEDIA_TYPE.test(record.mediaType)) {
        issues.add(
          ["mediaType"],
          "invalid_media_type",
          "The media type must look like image/tiff or audio/wav, in lower case.",
        );
      }
      checkOptionalLink(record, "represents", "A file can't represent itself.", issues);
      break;
    case "agent":
      if (!(AGENT_TYPES as readonly unknown[]).includes(record.agentType)) {
        issues.add(
          ["agentType"],
          "invalid_agent_type",
          `Agent type must be one of: ${AGENT_TYPES.join(", ")}.`,
        );
      }
      break;
    case "place":
      if (record.coordinates !== undefined) checkCoordinates(record.coordinates, issues);
      break;
    case "object":
    case "event":
      break;
  }

  if (issues.count > 0) return { ok: false, issues: issues.items };
  // The copy is plain, frozen data, and every property was checked above.
  return { ok: true, value: copy as unknown as CatalogRecord };
}

/** A view of `obj` where anything not an own property reads as undefined. */
function ownOnly(
  obj: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue | undefined>> {
  const view: Record<string, JsonValue | undefined> = Object.create(null) as Record<
    string,
    JsonValue | undefined
  >;
  for (const key of Object.keys(obj)) view[key] = obj[key];
  return view;
}

/**
 * True if `key` can be a template key: 1 to 64 lower case letters, digits,
 * hyphens and underscores, starting with a letter, and not a prototype key
 * (`constructor`, `prototype`). `validateTemplate` checks a template's `key`
 * and `validateRecord` a record's `templateKey` with this one rule.
 */
export function isTemplateKey(key: unknown): key is string {
  return typeof key === "string" && TEMPLATE_KEY.test(key) && !FORBIDDEN_KEYS.has(key);
}

/**
 * The fields a caller supplies when making a new record. `templateKey` is
 * optional in the type only so older callers keep working; give it for
 * every new record (D-029).
 */
export type NewRecordInput = { readonly organizationId: OrganizationId } & (
  | { readonly kind: "object"; readonly title: string }
  | { readonly kind: "event"; readonly title: string }
  | {
      readonly kind: "archival_unit";
      readonly title: string;
      readonly level: ArchivalLevel;
      readonly parentId?: RecordId;
    }
  | {
      readonly kind: "digital_asset";
      readonly title: string;
      readonly mediaType: string;
      readonly represents?: RecordId;
    }
  | { readonly kind: "agent"; readonly title: string; readonly agentType: AgentType }
  | {
      readonly kind: "place";
      readonly title: string;
      readonly coordinates?: { readonly lat: number; readonly lng: number };
    }
);

/**
 * Make a new record with a fresh ID and timestamps, then validate it.
 * `now` is for tests; it defaults to the current time.
 */
export function createRecord(
  input: NewRecordInput & {
    readonly templateKey?: string;
    readonly fields?: Readonly<Record<string, FieldValue>>;
  },
  now: Date = new Date(),
): Validated<CatalogRecord> {
  try {
    const time = Date.prototype.getTime.call(now);
    if (Number.isNaN(time)) throw new RangeError("invalid time");
    const stamp = new Date(time).toISOString();
    // Copy the caller's input as plain data first, so getters can't run twice
    // and nothing the caller keeps can change the new record.
    if (types.isProxy(input) || !isPlainObject(input)) {
      return {
        ok: false,
        issues: [issue([], "not_an_object", "A record must be a plain object.")],
      };
    }
    const issues = new IssueList();
    const copy = readPlainData(input, [], READ_LIMITS, issues);
    if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
    return validateRecord({
      fields: {},
      ...copy,
      id: newRecordId(),
      createdAt: stamp,
      updatedAt: stamp,
    });
  } catch {
    return {
      ok: false,
      issues: [issue([], "invalid_time", "The creation time is not a valid date.")],
    };
  }
}

export function isRecordKind(value: unknown): value is RecordKind {
  return (RECORD_KINDS as readonly unknown[]).includes(value);
}

export function isArchivalLevel(value: unknown): value is ArchivalLevel {
  return (ARCHIVAL_LEVELS as readonly unknown[]).includes(value);
}

// ---------------------------------------------------------------------------

function checkTitle(title: unknown, issues: IssueList): void {
  if (typeof title !== "string" || title.length === 0) {
    issues.add(["title"], "required", "Every record needs a title.");
    return;
  }
  if (title.trim().length === 0) {
    issues.add(["title"], "required", "The title is only spaces.");
  } else if (title !== title.trim()) {
    issues.add(["title"], "untrimmed", "The title starts or ends with spaces.");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    issues.add(
      ["title"],
      "too_long",
      `Titles can be at most ${String(MAX_TITLE_LENGTH)} characters.`,
    );
  }
  if (TITLE_BREAKS.test(title)) {
    issues.add(
      ["title"],
      "control_characters",
      "A title must be one line, with no tabs or line breaks.",
    );
  }
}

function checkTimestamps(createdAt: unknown, updatedAt: unknown, issues: IssueList): void {
  const created = parseUtc(createdAt);
  const updated = parseUtc(updatedAt);
  if (created === undefined) {
    issues.add(
      ["createdAt"],
      "invalid_timestamp",
      "createdAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
    );
  }
  if (updated === undefined) {
    issues.add(
      ["updatedAt"],
      "invalid_timestamp",
      "updatedAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
    );
  }
  if (created !== undefined && updated !== undefined && updated < created) {
    issues.add(["updatedAt"], "before_created", "updatedAt can't be earlier than createdAt.");
  }
}

/** Milliseconds since 1970, or undefined if not a real ISO 8601 UTC timestamp. */
function parseUtc(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  // Reject dates that roll over, like February 30.
  return new Date(ms).toISOString() === value ? ms : undefined;
}

/** Field values were already read safely; here only the top-level keys are checked. */
function checkFields(fields: unknown, issues: IssueList): void {
  if (!isPlainObject(fields)) {
    issues.add(["fields"], "not_an_object", "fields must be an object.");
    return;
  }
  for (const key of Object.keys(fields)) {
    if (!FIELD_KEY.test(key)) {
      issues.add(
        ["fields", key],
        "invalid_field_key",
        "Field keys are lower case letters, digits and underscores, starting with a letter.",
      );
    }
  }
}

function checkOptionalLink(
  record: Readonly<Record<string, JsonValue | undefined>>,
  key: "parentId" | "represents",
  selfMessage: string,
  issues: IssueList,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (!isRecordId(value)) {
    issues.add([key], "invalid_id", `${key} must be a record ID.`);
  } else if (value === record.id) {
    issues.add([key], "self_reference", selfMessage);
  }
}

function checkCoordinates(value: unknown, issues: IssueList): void {
  if (!isPlainObject(value)) {
    issues.add(["coordinates"], "not_an_object", "coordinates must be { lat, lng }.");
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "lat" && key !== "lng") {
      issues.add(
        ["coordinates", key],
        "unknown_property",
        `${shown(key)} is not part of coordinates.`,
      );
    }
  }
  const { lat, lng } = value;
  if (typeof lat !== "number" || lat < -90 || lat > 90) {
    issues.add(["coordinates", "lat"], "out_of_range", "Latitude must be -90 to 90.");
  }
  if (typeof lng !== "number" || lng < -180 || lng > 180) {
    issues.add(["coordinates", "lng"], "out_of_range", "Longitude must be -180 to 180.");
  }
}
