/**
 * The ID number types screen's model (T-047a): a stored identifier type as
 * form values and back, and what the server asks the person to confirm.
 *
 * Only what the screen edits is replaced: the label, the format, the
 * uniqueness rule, how new numbers are made and whether numbers may be
 * published. Everything else the stored type holds (its organization, any
 * setting a later version adds) is sent back as it came, so the
 * organization travels too and a save made after switching organization
 * in another tab is refused (`wrong_organization`).
 *
 * The server checks everything (core's `validateIdentifierType`, the
 * change report of T-005a, D-076 and S-033's confirmations); nothing here
 * decides what is allowed.
 */
import type { Issue } from "./templateForm";

type Plain = Readonly<Record<string, unknown>>;

export const UNIQUENESS = ["none", "current", "all_time"] as const;
export type Uniqueness = (typeof UNIQUENESS)[number];

export const UNIQUENESS_NAMES: Readonly<Record<Uniqueness, string>> = {
  none: "Records may share a number",
  current: "No two records at once",
  all_time: "Never reused, even after a number is retired",
};

export const SEPARATORS = [".", "-", "/"] as const;
export type Separator = (typeof SEPARATORS)[number];

export type Numbering = "none" | "year" | "prefix";

export const NUMBERING_NAMES: Readonly<Record<Numbering, string>> = {
  none: "Typed in by staff",
  year: "Year, then a number that restarts each year (2026.015)",
  prefix: "A fixed start, then a running number (DHS-0001)",
};

/** The type key rule (core's `isIdentifierTypeKey`), checked before it goes into an address. */
export const TYPE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** Keys core refuses for a new type. */
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);

export function isNewTypeKey(key: string): boolean {
  return TYPE_KEY.test(key) && !RESERVED.has(key);
}

export interface TypeDraft {
  /** The type as stored (empty for a new one): kept for what the form doesn't edit. */
  readonly base: Plain;
  readonly label: string;
  /** The format, or "" for none. */
  readonly pattern: string;
  readonly uniqueness: Uniqueness;
  readonly numbering: Numbering;
  readonly separator: Separator;
  readonly prefix: string;
  /** A whole number as typed. */
  readonly digits: string;
  readonly isPublic: boolean;
}

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function typeDraft(stored: unknown): TypeDraft {
  const t = isPlain(stored) ? stored : {};
  const auto = isPlain(t.autoNumber) ? t.autoNumber : undefined;
  const style = auto?.style;
  const separator = auto?.separator;
  return {
    base: t,
    label: text(t.label),
    pattern: text(t.pattern),
    uniqueness: (UNIQUENESS as readonly unknown[]).includes(t.uniqueness)
      ? (t.uniqueness as Uniqueness)
      : "all_time",
    numbering: style === "year" || style === "prefix" ? style : "none",
    separator: (SEPARATORS as readonly unknown[]).includes(separator)
      ? (separator as Separator)
      : ".",
    prefix: text(auto?.prefix),
    digits: typeof auto?.digits === "number" ? String(auto.digits) : "4",
    isPublic: t.public === true,
  };
}

/** A new type: never reused and staff only until someone chooses otherwise. */
export function newTypeDraft(organizationId: string): TypeDraft {
  return { ...typeDraft({}), base: { organizationId }, uniqueness: "all_time" };
}

/**
 * The type to send. Keys the screen edits are rebuilt; an empty format or
 * "typed in" numbering is left out; `public` is sent only when true; the
 * key itself travels in the address, never in the body.
 */
export function typeFromDraft(draft: TypeDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft.base)) {
    if (k === "key" || k === "label" || k === "pattern" || k === "uniqueness") continue;
    if (k === "autoNumber" || k === "public") continue;
    out[k] = v;
  }
  out.label = draft.label.trim();
  if (draft.pattern.trim() !== "") out.pattern = draft.pattern.trim();
  out.uniqueness = draft.uniqueness;
  if (draft.numbering !== "none") {
    const digits = /^\d{1,3}$/.test(draft.digits.trim())
      ? Number(draft.digits.trim())
      : draft.digits.trim();
    out.autoNumber =
      draft.numbering === "year"
        ? { style: "year", separator: draft.separator, digits }
        : { style: "prefix", prefix: draft.prefix, digits };
  }
  if (draft.isPublic) out.public = true;
  return out;
}

/** What a `409 confirmation_required` on an identifier type asks the person to confirm. */
export interface TypeConfirmation {
  /** The changes core says need confirming, as the server wants them back. */
  readonly confirm: readonly { readonly code: string; readonly key: string }[];
  /** Their messages, for the person. */
  readonly messages: readonly string[];
  /** Published records the change shows numbers on at once (D-076), or 0. */
  readonly publishedRecords: number;
  /**
   * Published records a new format takes off the public sites (S-033): the
   * server wants exactly these IDs back (`confirmDropped`).
   */
  readonly dropped: readonly string[];
}

export function typeConfirmationOf(issues: readonly Issue[]): TypeConfirmation {
  const confirm: { code: string; key: string }[] = [];
  const messages: string[] = [];
  const dropped: string[] = [];
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
    } else if (i.code === "published_record_dropped" && i.path[0] === "droppedFromPublic") {
      const id = i.path[1];
      if (typeof id === "string" && !dropped.includes(id)) dropped.push(id);
    }
  }
  return {
    confirm,
    messages,
    publishedRecords: publishes ? Math.max(published, 1) : 0,
    dropped,
  };
}

/**
 * The server asks one thing at a time (published records first, then the
 * changes, then the records a format takes off): what the person already
 * confirmed stays confirmed, and a new list replaces the old one of its kind.
 */
export function mergedConfirmation(
  sent: TypeConfirmation | undefined,
  next: TypeConfirmation,
): TypeConfirmation {
  if (sent === undefined) return next;
  return {
    confirm: next.confirm.length > 0 ? next.confirm : sent.confirm,
    messages: next.confirm.length > 0 ? next.messages : sent.messages,
    publishedRecords: next.publishedRecords > 0 ? next.publishedRecords : sent.publishedRecords,
    dropped: next.dropped.length > 0 ? next.dropped : sent.dropped,
  };
}

/** A short description of a stored type's numbering, for the list. */
export function numberingText(stored: unknown): string {
  const draft = typeDraft(stored);
  if (draft.numbering === "year") {
    return `Year${draft.separator}${"0".repeat(Math.max(1, Math.min(9, Number(draft.digits) || 1)))}`;
  }
  if (draft.numbering === "prefix") {
    return `${draft.prefix}${"0".repeat(Math.max(1, Math.min(9, Number(draft.digits) || 1)))}`;
  }
  return "Typed in";
}
