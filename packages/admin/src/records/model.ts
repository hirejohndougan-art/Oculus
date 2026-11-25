/**
 * The record editor's model (T-046): the shapes the staff API answers with,
 * a form's values for each field kind (D-073: one input per kind in core's
 * `FIELD_KINDS`), turning a stored record into form values and back into a
 * draft for the API, mapping core's issue paths to the fields they belong
 * to, and the workflow moves of D-075 (display only: the server decides).
 *
 * Nothing here renders HTML from data or builds a link from it, except
 * `safeHref` (http and https only) and `recordPath` (a record ID of the
 * exact UUID form only).
 */

export const FIELD_KINDS = [
  "text",
  "long_text",
  "date",
  "list",
  "controlled_term",
  "identifier",
  "link",
  "rights",
  "place",
  "record_link",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const RECORD_KINDS = [
  "object",
  "archival_unit",
  "digital_asset",
  "agent",
  "place",
  "event",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const KIND_LABELS: Readonly<Record<string, string>> = {
  object: "Object",
  archival_unit: "Archival unit (fonds, series, file …)",
  digital_asset: "Scan or recording",
  agent: "Person, family or organization",
  place: "Place",
  event: "Event",
};

export const LEVELS = ["fonds", "series", "collection", "file", "item"] as const;
export const AGENT_TYPES = ["person", "organization", "family"] as const;

export type WorkflowState = "draft" | "ready_for_review" | "published" | "withdrawn";

export const STATE_LABELS: Readonly<Record<WorkflowState, string>> = {
  draft: "Draft",
  ready_for_review: "Ready for review",
  published: "Published",
  withdrawn: "Withdrawn",
};

/** DESIGN.md's pill tones for each state. */
export const STATE_TONES: Readonly<Record<WorkflowState, "gray" | "blue" | "green" | "amber">> = {
  draft: "gray",
  ready_for_review: "blue",
  published: "green",
  withdrawn: "amber",
};

export function isWorkflowState(value: unknown): value is WorkflowState {
  return (
    value === "draft" ||
    value === "ready_for_review" ||
    value === "published" ||
    value === "withdrawn"
  );
}

export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly visibility: "public" | "staff";
  readonly inherited: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly vocabularies?: readonly string[];
  readonly identifierTypes?: readonly string[];
  readonly maxLength?: number;
  readonly recordKinds?: readonly string[];
}

export interface FieldTemplate {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly appliesTo: readonly string[];
  readonly fields: readonly FieldDefinition[];
}

export interface TemplateSummary {
  readonly key: string;
  readonly version: number;
  readonly template: FieldTemplate;
}

export interface RecordTypeSummary {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: string;
  readonly defaultTemplateKey: string;
}

/** A record as the API answers it (core's `CatalogRecord`). */
export interface StoredRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId?: string;
  readonly kind: string;
  readonly title: string;
  readonly templateKey?: string;
  readonly recordTypeKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level?: string;
  readonly parentId?: string;
  readonly mediaType?: string;
  readonly represents?: string;
  readonly agentType?: string;
  readonly coordinates?: { readonly lat: number; readonly lng: number };
}

export interface RecordAbilities {
  readonly edit: boolean;
  readonly history: boolean;
  readonly publish: boolean;
  readonly delete: boolean;
}

export interface InheritedValue {
  readonly key: string;
  readonly value: unknown;
  readonly from: string;
}

export interface ReadRecordReply {
  readonly record: StoredRecord;
  readonly version: number;
  readonly state: WorkflowState;
  readonly can: RecordAbilities;
  readonly inherited: readonly InheritedValue[];
}

export interface ListedRecord {
  readonly recordId: string;
  readonly title: string;
  readonly kind: string;
  readonly recordTypeKey: string | null;
  readonly siteId: string | null;
  readonly state: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface QueueEntry {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly siteId: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface SiteAbilities {
  readonly createKinds: readonly string[];
  readonly review: boolean;
}

export interface Issue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export interface VersionSummary {
  readonly version: number;
  readonly actor: string;
  readonly recordedAt: string;
  readonly changedFields: readonly string[];
  readonly reason?: string;
  readonly action: string;
  readonly workflowState: string;
}

export interface Difference {
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: unknown;
  readonly after?: unknown;
}

// ---------------------------------------------------------------------------
// Form values

/** One value of a field as the form holds it: text, or the parts of a structured value. */
export type PartValue = string | Readonly<Record<string, string>>;
/** A field's form value: one value, or a list for a repeatable field. */
export type FormValue = PartValue | readonly PartValue[];

/** The parts each structured kind has, in the order the form shows them. */
export const PARTS: Readonly<Partial<Record<FieldKind, readonly string[]>>> = {
  controlled_term: ["label", "uri", "vocabulary"],
  identifier: ["type", "value"],
  link: ["url", "label"],
  rights: ["uri", "note"],
  place: ["label", "uri", "recordId"],
  record_link: ["recordId", "label"],
};

export const PART_LABELS: Readonly<Record<string, string>> = {
  label: "Name",
  uri: "Link (URI)",
  vocabulary: "Vocabulary",
  type: "Number type",
  value: "Number",
  url: "Web address",
  note: "Note",
  recordId: "Record ID",
};

/** An empty single value for a field of this kind. */
export function emptyPart(kind: FieldKind): PartValue {
  const parts = PARTS[kind];
  if (parts === undefined) return "";
  return Object.fromEntries(parts.map((p) => [p, ""]));
}

/** A stored value as the form holds it (anything unexpected becomes text the person can see). */
function partFrom(kind: FieldKind, value: unknown): PartValue {
  const parts = PARTS[kind];
  if (parts === undefined) {
    return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  }
  const out: Record<string, string> = {};
  for (const p of parts) {
    const v =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[p]
        : undefined;
    out[p] = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  }
  return out;
}

/** A field's stored value as its form value. */
export function formValueOf(field: FieldDefinition, stored: unknown): FormValue {
  if (field.repeatable) {
    const list = Array.isArray(stored) ? stored : stored === undefined ? [] : [stored];
    return list.length === 0 ? [emptyPart(field.kind)] : list.map((v) => partFrom(field.kind, v));
  }
  return partFrom(field.kind, stored);
}

function isBlank(part: PartValue): boolean {
  return typeof part === "string"
    ? part.trim() === ""
    : Object.values(part).every((v) => v.trim() === "");
}

/** One form value as stored: empty text and empty parts are left out (core stores no empties). */
function storedPart(kind: FieldKind, part: PartValue): unknown {
  if (typeof part === "string") return kind === "long_text" ? part : part.trim();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(part)) {
    const t = v.trim();
    if (t !== "") out[k] = t;
  }
  return out;
}

/** A field's form value as stored, or `undefined` when it holds nothing. */
export function storedValueOf(field: FieldDefinition, value: FormValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const kept = (value as readonly PartValue[])
      .filter((p) => !isBlank(p))
      .map((p) => storedPart(field.kind, p));
    if (kept.length === 0) return undefined;
    return field.repeatable ? kept : kept[0];
  }
  const part = value as PartValue;
  if (isBlank(part)) return undefined;
  const stored = storedPart(field.kind, part);
  return field.repeatable ? [stored] : stored;
}

/** The editor's whole form: the record's own properties and its template fields. */
export interface Draft {
  readonly kind: string;
  readonly title: string;
  readonly templateKey: string;
  readonly recordTypeKey: string;
  readonly level: string;
  readonly parentId: string;
  readonly mediaType: string;
  readonly represents: string;
  readonly agentType: string;
  readonly lat: string;
  readonly lng: string;
  readonly fields: Readonly<Record<string, FormValue>>;
}

/** A new record's empty form. */
export function newDraft(kind: string, template: FieldTemplate, recordTypeKey = ""): Draft {
  return {
    kind,
    title: "",
    templateKey: template.key,
    recordTypeKey,
    level: kind === "archival_unit" ? "fonds" : "",
    parentId: "",
    mediaType: "",
    represents: "",
    agentType: kind === "agent" ? "person" : "",
    lat: "",
    lng: "",
    fields: Object.fromEntries(template.fields.map((f) => [f.key, formValueOf(f, undefined)])),
  };
}

/** A stored record's form. */
export function draftOf(record: StoredRecord, template: FieldTemplate | undefined): Draft {
  const fields: Record<string, FormValue> = {};
  for (const f of template?.fields ?? []) fields[f.key] = formValueOf(f, record.fields[f.key]);
  return {
    kind: record.kind,
    title: record.title,
    templateKey: record.templateKey ?? "",
    recordTypeKey: record.recordTypeKey ?? "",
    level: record.level ?? "",
    parentId: record.parentId ?? "",
    mediaType: record.mediaType ?? "",
    represents: record.represents ?? "",
    agentType: record.agentType ?? "",
    lat: record.coordinates === undefined ? "" : String(record.coordinates.lat),
    lng: record.coordinates === undefined ? "" : String(record.coordinates.lng),
    fields,
  };
}

/**
 * The draft the API is sent: the record's own properties for its kind, the
 * template's fields that hold something, and (for an edit) the values the
 * record holds for keys its template no longer has, unchanged, so a save
 * never drops them silently.
 */
export function recordDraft(
  draft: Draft,
  template: FieldTemplate | undefined,
  stored?: StoredRecord,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const known = new Set((template?.fields ?? []).map((f) => f.key));
  if (stored !== undefined) {
    for (const [k, v] of Object.entries(stored.fields)) if (!known.has(k)) fields[k] = v;
  }
  for (const f of template?.fields ?? []) {
    const v = storedValueOf(f, draft.fields[f.key]);
    if (v !== undefined) fields[f.key] = v;
  }
  const out: Record<string, unknown> = {
    kind: draft.kind,
    title: draft.title.trim(),
    templateKey: draft.templateKey,
    fields,
  };
  if (draft.recordTypeKey !== "") out.recordTypeKey = draft.recordTypeKey;
  const text = (v: string) => v.trim();
  if (draft.kind === "archival_unit") {
    if (text(draft.level) !== "") out.level = text(draft.level);
    if (text(draft.parentId) !== "") out.parentId = text(draft.parentId);
  }
  if (draft.kind === "digital_asset") {
    if (text(draft.mediaType) !== "") out.mediaType = text(draft.mediaType);
    if (text(draft.represents) !== "") out.represents = text(draft.represents);
  }
  if (draft.kind === "agent" && text(draft.agentType) !== "") out.agentType = text(draft.agentType);
  if (draft.kind === "place" && (text(draft.lat) !== "" || text(draft.lng) !== "")) {
    out.coordinates = { lat: Number(text(draft.lat)), lng: Number(text(draft.lng)) };
  }
  return out;
}

/** Whether two drafts would save the same record. */
export function sameDraft(a: Draft, b: Draft, template: FieldTemplate | undefined): boolean {
  return JSON.stringify(recordDraft(a, template)) === JSON.stringify(recordDraft(b, template));
}

// ---------------------------------------------------------------------------
// Issues

/** The record properties the form shows outside the template fields. */
export const RECORD_PROPS = [
  "title",
  "recordTypeKey",
  "level",
  "parentId",
  "mediaType",
  "represents",
  "agentType",
  "coordinates",
] as const;

/**
 * Where a core issue belongs in the form: `fields.<key>` for a template
 * field, a record property's name, or `form` for anything else.
 */
export function issueTarget(issue: Issue, fieldKeys: ReadonlySet<string>): string {
  const [first, second] = issue.path;
  if (first === "fields" && typeof second === "string" && fieldKeys.has(second)) {
    return `fields.${second}`;
  }
  if (typeof first === "string" && (RECORD_PROPS as readonly string[]).includes(first)) {
    return first;
  }
  return "form";
}

/** Issues grouped by where they show. */
export function issuesByTarget(
  issues: readonly Issue[],
  fieldKeys: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const i of issues) {
    const target = issueTarget(i, fieldKeys);
    const list = out.get(target) ?? [];
    if (!list.includes(i.message)) list.push(i.message);
    out.set(target, list);
  }
  return out;
}

/** Reads `issues` from an API reply body, keeping only well-formed ones. */
export function issuesIn(body: unknown): readonly Issue[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (i): i is Issue =>
      typeof i === "object" &&
      i !== null &&
      Array.isArray((i as Issue).path) &&
      typeof (i as Issue).code === "string" &&
      typeof (i as Issue).message === "string",
  );
}

// ---------------------------------------------------------------------------
// Workflow (D-075): which moves to offer. The server decides.

export type WorkflowMove = "submit-for-review" | "return-to-draft" | "publish" | "withdraw";

export const MOVE_LABELS: Readonly<Record<WorkflowMove, string>> = {
  "submit-for-review": "Send for review",
  "return-to-draft": "Return to draft",
  publish: "Publish",
  withdraw: "Unpublish",
};

const MOVES: Readonly<Record<WorkflowState, readonly WorkflowMove[]>> = {
  draft: ["submit-for-review", "publish"],
  ready_for_review: ["return-to-draft", "publish"],
  published: ["withdraw"],
  withdrawn: ["submit-for-review", "return-to-draft", "publish"],
};

/** The moves the person may be offered from `state`: edit moves need edit, the others publish. */
export function offeredMoves(state: WorkflowState, can: RecordAbilities): readonly WorkflowMove[] {
  return MOVES[state].filter((m) => (m === "publish" || m === "withdraw" ? can.publish : can.edit));
}

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  save: "Saved",
  delete: "Deleted",
  submit_for_review: "Sent for review",
  return_to_draft: "Returned to draft",
  publish: "Published",
  withdraw: "Unpublished",
};

// ---------------------------------------------------------------------------
// Safe output

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

/** The admin's route of a record, or `undefined` for anything but a well-formed ID. */
export function recordPath(siteId: string, recordId: string): string | undefined {
  if (!SITE_ID.test(siteId) || !isRecordId(recordId)) return undefined;
  return `/sites/${siteId}/records/${recordId}`;
}

/**
 * An `href` for a web address from a record, or `undefined`: only
 * `http:` and `https:` URLs (never `javascript:`, `data:` or the like),
 * as the URL parser reads them.
 */
export function safeHref(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.href;
}

/** Any stored value as plain text for showing (never as HTML). */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join("; ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const main = o.label ?? o.value ?? o.url ?? o.uri ?? o.recordId;
    const rest = Object.entries(o)
      .filter(([, v]) => v !== main)
      .map(([k, v]) => `${k}: ${valueText(v)}`);
    return [main === undefined ? undefined : valueText(main), ...rest]
      .filter((x) => x !== undefined && x !== "")
      .join(" · ");
  }
  return "";
}

/** A date and time for people, in their own locale. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
