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
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { isRecordId, newRecordId, type RecordId } from "./record-id.js";

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
export type FieldValue =
  string | number | boolean | null | readonly FieldValue[] | { readonly [key: string]: FieldValue };

interface RecordBase {
  readonly id: RecordId;
  readonly title: string;
  /** ISO 8601 UTC timestamp, e.g. `2026-11-20T16:05:00.000Z`. */
  readonly createdAt: string;
  /** ISO 8601 UTC timestamp; never earlier than `createdAt`. */
  readonly updatedAt: string;
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
export const MAX_STRING_LENGTH = 100_000;
export const MAX_FIELD_DEPTH = 8;
export const MAX_FIELD_ENTRIES = 2000;

const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** Keys that could reach an object's prototype if copied naively. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** RFC 6838 type/subtype, restricted-name characters only, no parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const COMMON_KEYS = ["id", "kind", "title", "createdAt", "updatedAt", "fields"] as const;
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
 * return it as a typed record, or every problem found. Nothing is trimmed,
 * guessed or dropped: a value that isn't exactly right is reported.
 */
export function validateRecord(input: unknown): Validated<CatalogRecord> {
  if (!isPlainObject(input)) {
    return { ok: false, issues: [issue([], "not_an_object", "A record must be an object.")] };
  }
  const issues: Issue[] = [];
  const kind = input.kind;
  if (!isRecordKind(kind)) {
    issues.push(
      issue(["kind"], "invalid_kind", `Kind must be one of: ${RECORD_KINDS.join(", ")}.`),
    );
    return { ok: false, issues };
  }

  const allowed = new Set<string>([...COMMON_KEYS, ...EXTRA_KEYS[kind]]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push(issue([key], "unknown_property", `"${key}" is not a property of a ${kind}.`));
    }
  }

  if (!isRecordId(input.id)) {
    issues.push(issue(["id"], "invalid_id", "The ID must be a lowercase version 4 UUID."));
  }
  checkTitle(input.title, issues);
  checkTimestamps(input.createdAt, input.updatedAt, issues);
  checkFields(input.fields, issues);

  switch (kind) {
    case "archival_unit":
      if (!isArchivalLevel(input.level)) {
        issues.push(
          issue(["level"], "invalid_level", `Level must be one of: ${ARCHIVAL_LEVELS.join(", ")}.`),
        );
      }
      checkOptionalLink(input, "parentId", "A unit can't be filed under itself.", issues);
      break;
    case "digital_asset":
      if (typeof input.mediaType !== "string" || !MEDIA_TYPE.test(input.mediaType)) {
        issues.push(
          issue(
            ["mediaType"],
            "invalid_media_type",
            "The media type must look like image/tiff or audio/wav, in lower case.",
          ),
        );
      }
      checkOptionalLink(input, "represents", "A file can't represent itself.", issues);
      break;
    case "agent":
      if (!(AGENT_TYPES as readonly unknown[]).includes(input.agentType)) {
        issues.push(
          issue(
            ["agentType"],
            "invalid_agent_type",
            `Agent type must be one of: ${AGENT_TYPES.join(", ")}.`,
          ),
        );
      }
      break;
    case "place":
      if ("coordinates" in input) checkCoordinates(input.coordinates, issues);
      break;
    case "object":
    case "event":
      break;
  }

  if (issues.length > 0) return { ok: false, issues };
  // Every property was checked above, and nothing else is allowed through.
  return { ok: true, value: input as unknown as CatalogRecord };
}

/** The fields a caller supplies when making a new record. */
export type NewRecordInput =
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
    };

/**
 * Make a new record with a fresh ID and timestamps, then validate it.
 * `now` is for tests; it defaults to the current time.
 */
export function createRecord(
  input: NewRecordInput & { readonly fields?: Readonly<Record<string, FieldValue>> },
  now: Date = new Date(),
): Validated<CatalogRecord> {
  const stamp = now.toISOString();
  return validateRecord({
    fields: {},
    ...input,
    id: newRecordId(),
    createdAt: stamp,
    updatedAt: stamp,
  });
}

export function isRecordKind(value: unknown): value is RecordKind {
  return (RECORD_KINDS as readonly unknown[]).includes(value);
}

export function isArchivalLevel(value: unknown): value is ArchivalLevel {
  return (ARCHIVAL_LEVELS as readonly unknown[]).includes(value);
}

// ---------------------------------------------------------------------------

function checkTitle(title: unknown, issues: Issue[]): void {
  if (typeof title !== "string" || title.length === 0) {
    issues.push(issue(["title"], "required", "Every record needs a title."));
    return;
  }
  if (title.trim().length === 0) {
    issues.push(issue(["title"], "required", "The title is only spaces."));
  } else if (title !== title.trim()) {
    issues.push(issue(["title"], "untrimmed", "The title starts or ends with spaces."));
  }
  if (title.length > MAX_TITLE_LENGTH) {
    issues.push(
      issue(["title"], "too_long", `Titles can be at most ${String(MAX_TITLE_LENGTH)} characters.`),
    );
  }
  if (CONTROL_CHARS.test(title)) {
    issues.push(
      issue(
        ["title"],
        "control_characters",
        "The title contains line breaks or other invisible control characters.",
      ),
    );
  }
}

function checkTimestamps(createdAt: unknown, updatedAt: unknown, issues: Issue[]): void {
  const created = parseUtc(createdAt);
  const updated = parseUtc(updatedAt);
  if (created === undefined) {
    issues.push(
      issue(["createdAt"], "invalid_timestamp", "createdAt must be an ISO 8601 UTC timestamp."),
    );
  }
  if (updated === undefined) {
    issues.push(
      issue(["updatedAt"], "invalid_timestamp", "updatedAt must be an ISO 8601 UTC timestamp."),
    );
  }
  if (created !== undefined && updated !== undefined && updated < created) {
    issues.push(
      issue(["updatedAt"], "before_created", "updatedAt can't be earlier than createdAt."),
    );
  }
}

/** Milliseconds since 1970, or undefined if not a real ISO 8601 UTC timestamp. */
function parseUtc(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  // Reject dates that roll over, like February 30.
  const normalized = new Date(ms).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? ms : undefined;
}

function checkFields(fields: unknown, issues: Issue[]): void {
  if (!isPlainObject(fields)) {
    issues.push(issue(["fields"], "not_an_object", "fields must be an object."));
    return;
  }
  const budget = { entries: 0 };
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push(issue(["fields", key], "forbidden_key", `"${key}" can't be used as a key.`));
      continue;
    }
    if (!FIELD_KEY.test(key)) {
      issues.push(
        issue(
          ["fields", key],
          "invalid_field_key",
          "Field keys are lower case letters, digits and underscores, starting with a letter.",
        ),
      );
      continue;
    }
    checkJson(value, ["fields", key], 1, budget, issues);
  }
}

function checkJson(
  value: unknown,
  path: (string | number)[],
  depth: number,
  budget: { entries: number },
  issues: Issue[],
): void {
  budget.entries += 1;
  if (budget.entries > MAX_FIELD_ENTRIES) {
    if (budget.entries === MAX_FIELD_ENTRIES + 1) {
      issues.push(
        issue(
          ["fields"],
          "too_many_values",
          `A record can hold at most ${String(MAX_FIELD_ENTRIES)} field values.`,
        ),
      );
    }
    return;
  }
  if (depth > MAX_FIELD_DEPTH) {
    issues.push(
      issue(path, "too_deep", `Field values can nest at most ${String(MAX_FIELD_DEPTH)} levels.`),
    );
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      issues.push(
        issue(
          path,
          "too_long",
          `Text values can be at most ${String(MAX_STRING_LENGTH)} characters.`,
        ),
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push(issue(path, "not_finite", "Numbers must be finite."));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      checkJson(item, [...path, index], depth + 1, budget, issues);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(issue([...path, key], "forbidden_key", `"${key}" can't be used as a key.`));
        continue;
      }
      checkJson(item, [...path, key], depth + 1, budget, issues);
    }
    return;
  }
  issues.push(
    issue(path, "not_json", "Field values must be text, numbers, true/false, lists or groups."),
  );
}

function checkOptionalLink(
  input: Record<string, unknown>,
  key: "parentId" | "represents",
  selfMessage: string,
  issues: Issue[],
): void {
  if (!(key in input)) return;
  const value = input[key];
  if (!isRecordId(value)) {
    issues.push(issue([key], "invalid_id", `${key} must be a record ID.`));
  } else if (value === input.id) {
    issues.push(issue([key], "self_reference", selfMessage));
  }
}

function checkCoordinates(value: unknown, issues: Issue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(["coordinates"], "not_an_object", "coordinates must be { lat, lng }."));
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "lat" && key !== "lng") {
      issues.push(
        issue(["coordinates", key], "unknown_property", `"${key}" is not part of coordinates.`),
      );
    }
  }
  const { lat, lng } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    issues.push(issue(["coordinates", "lat"], "out_of_range", "Latitude must be -90 to 90."));
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    issues.push(issue(["coordinates", "lng"], "out_of_range", "Longitude must be -180 to 180."));
  }
}
