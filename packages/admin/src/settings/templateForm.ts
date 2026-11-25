/**
 * The template editor's model (T-048a): a stored template as form values
 * and back, and the server's answers read for the screen.
 *
 * Only what the screen edits is replaced: a template's label, description
 * and record kinds, and each field's key (new fields only), label, help,
 * kind, required, repeatable, visibility, inheritance, list options and
 * length limit. Everything else a template or field holds (its
 * organization, standards mappings, vocabularies, identifier types, the
 * record kinds a link may point to) is sent back as it came, so editing a
 * label never drops a setting the screen doesn't show. The organization is
 * sent back too, so a save made after switching organization in another tab
 * is refused (`wrong_organization`) rather than stored in the other one.
 *
 * The server checks everything (core's `validateTemplate`, D-076's
 * confirmations); nothing here decides what is allowed.
 */
import { FIELD_KINDS, RECORD_KINDS, type FieldKind } from "../records/model";

export const KIND_NAMES: Readonly<Record<FieldKind, string>> = {
  text: "Short text",
  long_text: "Long text",
  date: "Date (EDTF)",
  list: "Pick list",
  controlled_term: "Subject or term",
  identifier: "ID number",
  link: "Web link",
  rights: "Rights statement",
  place: "Place",
  record_link: "Link to another record",
};

/** The settings that belong to one field kind only, dropped when the kind changes. */
const KIND_ONLY: Readonly<Record<string, readonly FieldKind[]>> = {
  options: ["list"],
  vocabularies: ["controlled_term"],
  identifierTypes: ["identifier"],
  maxLength: ["text", "long_text"],
  recordKinds: ["record_link"],
};

type Plain = Readonly<Record<string, unknown>>;

export interface OptionDraft {
  readonly value: string;
  readonly label: string;
}

export interface FieldDraft {
  /** The form's own key for the row (React), never sent. */
  readonly uid: string;
  /** Not yet saved: its key may still be chosen. */
  readonly isNew: boolean;
  /** The field as stored (empty for a new one): kept for what the form doesn't edit. */
  readonly base: Plain;
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly visibility: "public" | "staff";
  readonly inherited: boolean;
  readonly options: readonly OptionDraft[];
  /** A whole number as typed, or "" for the default. */
  readonly maxLength: string;
}

export interface TemplateDraft {
  readonly base: Plain;
  readonly label: string;
  readonly description: string;
  readonly appliesTo: readonly string[];
  readonly fields: readonly FieldDraft[];
}

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function isFieldKind(value: unknown): value is FieldKind {
  return typeof value === "string" && (FIELD_KINDS as readonly string[]).includes(value);
}

let uids = 0;
function nextUid(): string {
  uids += 1;
  return `f${String(uids)}`;
}

export function fieldDraft(field: unknown): FieldDraft {
  const f = isPlain(field) ? field : {};
  const options = Array.isArray(f.options)
    ? (f.options as unknown[]).filter(isPlain).map((o) => ({
        value: text(o.value),
        label: text(o.label),
      }))
    : [];
  return {
    uid: nextUid(),
    isNew: false,
    base: f,
    key: text(f.key),
    label: text(f.label),
    help: text(f.help),
    kind: isFieldKind(f.kind) ? f.kind : "text",
    required: f.required === true,
    repeatable: f.repeatable === true,
    visibility: f.visibility === "public" ? "public" : "staff",
    inherited: f.inherited === true,
    options,
    maxLength: typeof f.maxLength === "number" ? String(f.maxLength) : "",
  };
}

/** A new field: staff only until someone chooses otherwise, so nothing is published by default. */
export function newFieldDraft(): FieldDraft {
  return {
    uid: nextUid(),
    isNew: true,
    base: {},
    key: "",
    label: "",
    help: "",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    options: [],
    maxLength: "",
  };
}

export function templateDraft(template: unknown): TemplateDraft {
  const t = isPlain(template) ? template : {};
  return {
    base: t,
    label: text(t.label),
    description: text(t.description),
    appliesTo: Array.isArray(t.appliesTo)
      ? (t.appliesTo as unknown[]).filter((k): k is string => typeof k === "string")
      : [],
    fields: Array.isArray(t.fields) ? (t.fields as unknown[]).map(fieldDraft) : [],
  };
}

/** A new template's form: no fields yet. */
export function newTemplateDraft(organizationId: string): TemplateDraft {
  return { base: { organizationId }, label: "", description: "", appliesTo: [], fields: [] };
}

function without(source: Plain, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** The field as the API takes it. */
export function fieldFromDraft(d: FieldDraft): Record<string, unknown> {
  // Settings of another kind go when the kind changes; the edited ones are set below.
  const dropped = Object.entries(KIND_ONLY)
    .filter(([, kinds]) => !kinds.includes(d.kind))
    .map(([k]) => k);
  const out = without(d.base, [...dropped, "help", "options", "maxLength"]);
  out.key = d.key.trim();
  out.label = d.label.trim();
  if (d.help.trim() !== "") out.help = d.help.trim();
  out.kind = d.kind;
  out.required = d.required;
  out.repeatable = d.repeatable;
  out.visibility = d.visibility;
  out.inherited = d.inherited;
  if (d.kind === "list") {
    out.options = d.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() }));
  }
  const length = d.maxLength.trim();
  if ((d.kind === "text" || d.kind === "long_text") && length !== "") {
    // Not a whole number: sent as typed, so the server says what's wrong.
    out.maxLength = /^[0-9]{1,9}$/.test(length) ? Number(length) : length;
  }
  return out;
}

/** The template as the API takes it (its key is the address's). */
export function templateFromDraft(d: TemplateDraft): Record<string, unknown> {
  const out = without(d.base, ["key", "description", "label", "appliesTo", "fields"]);
  out.label = d.label.trim();
  if (d.description.trim() !== "") out.description = d.description.trim();
  out.appliesTo = RECORD_KINDS.filter((k) => d.appliesTo.includes(k));
  out.fields = d.fields.map(fieldFromDraft);
  return out;
}

/** Moves the item at `from` by `step` places (-1 up, +1 down), if it can. */
export function moved<T>(items: readonly T[], from: number, step: -1 | 1): readonly T[] {
  const to = from + step;
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const out = [...items];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}

/** The rule core's `isTemplateKey` applies, checked before sending so the address is safe. */
export const TEMPLATE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;

export interface Issue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export function issuesOf(body: Readonly<Record<string, unknown>>): readonly Issue[] {
  const list = body.issues;
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter(isPlain).map((i) => ({
    path: Array.isArray(i.path)
      ? (i.path as unknown[]).filter(
          (p): p is string | number => typeof p === "string" || typeof p === "number",
        )
      : [],
    code: text(i.code),
    message: text(i.message),
  }));
}

/** A problem as one line, naming the field it is about when it is about one. */
export function issueLine(issue: Issue, fields: readonly FieldDraft[]): string {
  const [first, index] = issue.path;
  if (first === "fields" && typeof index === "number") {
    const field = fields[index];
    const name = field === undefined ? `Field ${String(index + 1)}` : field.label || field.key;
    return `${name || `Field ${String(index + 1)}`}: ${issue.message}`;
  }
  return issue.message;
}

/** What a `409 confirmation_required` asks the person to confirm. */
export interface Confirmation {
  /** The changes core says need confirming, as the server wants them back. */
  readonly confirm: readonly { readonly code: string; readonly key: string }[];
  /** Their messages, for the person. */
  readonly messages: readonly string[];
  /** Published records the change shows values on at once (D-076), or 0. */
  readonly publishedRecords: number;
}

export function confirmationOf(issues: readonly Issue[]): Confirmation {
  const confirm: { code: string; key: string }[] = [];
  const messages: string[] = [];
  let published = 0;
  let publishes = false;
  for (const i of issues) {
    if (i.code === "needs_confirmation" && i.path[0] === "confirm") {
      const [, code, key] = i.path;
      if (typeof code === "string" && typeof key === "string") {
        confirm.push({ code, key });
        messages.push(i.message);
      }
    } else if (i.code === "publishes_records") {
      publishes = true;
    } else if (i.code === "published_record_affected") {
      published += 1;
    }
  }
  return {
    confirm,
    messages,
    publishedRecords: publishes ? Math.max(published, 1) : 0,
  };
}
