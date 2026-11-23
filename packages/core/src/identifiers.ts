/**
 * Typed identifiers (PLATFORM_PLAN.md §2, decision D-009).
 *
 * Every record has one permanent internal ID (`record-id.ts`). On top of that
 * it can carry any number of the organization's own numbers: accession
 * number, object number, call number, barcode, a former Omeka ID. This module
 * holds:
 *
 * - **Identifier types**, defined by the organization. Each has a key, a
 *   label, an optional format (see `identifier-pattern.ts`), a uniqueness rule
 *   and optional auto-numbering: year-based (`2026.015`) or a prefix plus
 *   digits (`DHS-0001`).
 * - **A record's identifiers**: the current ones, exactly one marked primary
 *   (the number shown), and the former ones, which are kept forever so old
 *   labels, citations and links still find the record.
 * - Pure functions over a set of records' identifiers: check uniqueness, check
 *   a new identifier before it is given out, find records by a current or
 *   former identifier, work out the next auto-number, retire an identifier
 *   without losing it, and list identifiers a change would drop.
 *
 * Identifiers are compared by `identifierKey` (case, spaces and lookalike
 * characters ignored) but always stored exactly as typed. There is no database
 * yet, so nothing here can stop two people taking the same next number at the
 * same moment; the save path must re-check uniqueness when it writes.
 *
 * - **Which types are public** (D-022). A type is staff only unless it says
 *   `public: true`. Only values of public types may sit in a public template
 *   field (`makeIdentifierChecker` reports `private_identifier_type`), and
 *   `publicOutput` publishes only those. Every function in this module still
 *   works on whatever records it is given, former identifiers included, and
 *   former notes can be internal: a public site or public search must pass in
 *   published records only, and show only public types.
 *
 * - **One organization at a time** (D-019, D-030). Identifier types and a
 *   record's identifiers carry their `organizationId`, and a number is unique
 *   only within its organization. `validateIdentifierTypes`,
 *   `validateRecordIdentifiers`, `uniquenessIssues`, `checkNewIdentifier` and
 *   `nextIdentifier` refuse inputs of more than one organization
 *   (`mixed_organizations`), and so do `findByIdentifier` and
 *   `findIdentifierConflicts`, which return a `Validated` list for that
 *   reason. An entry that doesn't say which organization it belongs to
 *   counts as another organization's.
 *
 * Changing an identifier type: tightening a format, removing or renaming a
 * type, making it unique or changing its numbering can make existing records
 * fail `validateRecordIdentifiers` or give a used number out again, and
 * making it public publishes staff values. `identifierTypeChanges` and
 * `identifierTypeDeletion` (identifier-type-changes.ts, D-031) report the
 * records affected; the admin screen must show them and get confirmation
 * before saving.
 */
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import {
  FORBIDDEN_KEYS,
  IssueList,
  readPlainData,
  shown,
  textProblem,
  type JsonValue,
} from "./plain-data.js";
import { types } from "node:util";
import { isRecordId, type RecordId } from "./record-id.js";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  oneOrganization,
  organizationIdOf,
  type OrganizationId,
} from "./organizations.js";
import {
  BLANK_CHARACTERS,
  MAX_MARK_RUN,
  hasTooManyMarks,
  identifierKey,
} from "./identifier-key.js";
import {
  matchesIdentifierPattern,
  parseIdentifierPattern,
  patternMismatchMessage,
  type IdentifierPattern,
} from "./identifier-pattern.js";

/**
 * - `none`: any number of records may share a value (box labels, say).
 * - `current`: no two records may hold the same value as a current identifier.
 * - `all_time`: as `current`, and a value once given to a record (even if since
 *   retired) can't be given to another one. The safe choice for accession numbers.
 */
export const UNIQUENESS_RULES = ["none", "current", "all_time"] as const;
export type UniquenessRule = (typeof UNIQUENESS_RULES)[number];

export const YEAR_SEPARATORS = [".", "-", "/"] as const;
export type YearSeparator = (typeof YEAR_SEPARATORS)[number];

/** How new identifiers of a type are numbered. */
export type AutoNumbering =
  /** Year, separator, then a number that restarts each year: `2026.015`. */
  | { readonly style: "year"; readonly separator: YearSeparator; readonly digits: number }
  /** A fixed prefix, then a running number: `DHS-0001`. */
  | { readonly style: "prefix"; readonly prefix: string; readonly digits: number };

/** An identifier type defined by the organization. */
export interface IdentifierType {
  /** The organization that defined the type (D-019, D-030). Types are never shared. */
  readonly organizationId: OrganizationId;
  /** Stable key, e.g. `accession_number`. See `isIdentifierTypeKey`. */
  readonly key: string;
  /** What people see, e.g. "Accession number". */
  readonly label: string;
  /** Optional format for current identifiers of this type, e.g. `####.###`. */
  readonly pattern?: string;
  readonly uniqueness: UniquenessRule;
  readonly autoNumber?: AutoNumbering;
  /**
   * True if values of this type may be published (an object or accession
   * number, say). Left out or false, the type is staff only: its values are
   * refused in public template fields and never reach public output (D-022).
   */
  readonly public?: boolean;
}

/** A current identifier on a record. */
export interface Identifier {
  /** The identifier type's key. */
  readonly type: string;
  /** Exactly as typed. */
  readonly value: string;
  /** True for the one identifier shown as the record's number. */
  readonly primary: boolean;
}

/** An identifier the record used to have. Kept so old numbers still find it. */
export interface FormerIdentifier {
  readonly type: string;
  readonly value: string;
  /** When it stopped being used (ISO 8601 UTC), if known. */
  readonly retiredAt?: string;
  /** Why, e.g. "Renumbered in the 2026 inventory". */
  readonly note?: string;
}

/** All identifiers of one record. */
export interface RecordIdentifiers {
  readonly recordId: RecordId;
  /** The organization the record belongs to (D-030). */
  readonly organizationId: OrganizationId;
  readonly current: readonly Identifier[];
  readonly former: readonly FormerIdentifier[];
}

/** An identifier a change would lose. */
export interface DroppedIdentifier {
  readonly type: string;
  readonly value: string;
  /**
   * `identifier`: it appears nowhere afterwards. `history`: it is still there,
   * but a former entry's retirement date or note was removed or changed.
   */
  readonly lost: "identifier" | "history";
}

/** One place an identifier was found. */
export interface IdentifierMatch {
  readonly recordId: RecordId;
  readonly type: string;
  /** The identifier exactly as stored. */
  readonly value: string;
  readonly status: "current" | "former";
  /** True if this is the record's primary identifier (never for a former one). */
  readonly primary: boolean;
}

// ---------------------------------------------------------------------------
// Limits

export const MAX_IDENTIFIER_LENGTH = 200;
export const MAX_IDENTIFIER_TYPES = 100;
export const MAX_TYPE_LABEL_LENGTH = 200;
export const MAX_PREFIX_LENGTH = 20;
/** Widest zero-padding for auto-numbers. */
export const MAX_AUTO_DIGITS = 9;
/** Auto-numbers stop here, well inside exact integer range. */
export const MAX_AUTO_NUMBER = 999_999_999_999;
export const MAX_CURRENT_IDENTIFIERS = 50;
export const MAX_FORMER_IDENTIFIERS = 500;
export const MAX_FORMER_NOTE_LENGTH = 1000;
/** The longest text `findByIdentifier` will search for. */
export const MAX_QUERY_LENGTH = 1000;

const TYPE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The rule for new identifier type keys (D-031): 1 to 64 lower case ASCII
 * letters, digits and underscores, starting with a letter, and not a
 * prototype key (`constructor`, `prototype`). Template `identifierTypes`
 * lists and the `type` of identifier values in template fields use it too,
 * so a template can only name a type that could exist.
 *
 * Types stored before this rule may be keyed `constructor` or `prototype`:
 * `validateIdentifierType(s)` still accept them, so existing data keeps
 * working; `validateNewIdentifierType` refuses them, and
 * `identifierTypeChanges` reports them as `reserved_key` until renamed.
 */
export function isIdentifierTypeKey(value: unknown): value is string {
  return isStoredTypeKey(value) && !FORBIDDEN_KEYS.has(value);
}

/** Keys stored types may have: the rule above, plus the legacy reserved keys. */
function isStoredTypeKey(value: unknown): value is string {
  return typeof value === "string" && TYPE_KEY.test(value);
}

/** The rule above in words, for messages. */
export const IDENTIFIER_TYPE_KEY_RULE =
  "1 to 64 lower case letters, digits and underscores, starting with a letter";
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;
/**
 * Invisible characters (default-ignorable, which takes in the Hangul fillers)
 * and the visible ones that draw nothing, such as the Braille blank. The
 * comparison key ignores them all; stored values may not hold them.
 */
const INVISIBLE = new RegExp(`[\\p{Default_Ignorable_Code_Point}]|${BLANK_CHARACTERS}`, "u");
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const TYPE_LIMITS = {
  maxDepth: 3,
  maxValues: 50,
  maxStringLength: 1000,
  maxKeyLength: 64,
  maxTotalChars: 5000,
} as const;

const TYPES_LIMITS = {
  ...TYPE_LIMITS,
  maxDepth: 4,
  maxValues: (MAX_IDENTIFIER_TYPES + 1) * TYPE_LIMITS.maxValues,
  maxTotalChars: MAX_IDENTIFIER_TYPES * TYPE_LIMITS.maxTotalChars,
} as const;

const SET_LIMITS = {
  maxDepth: 4,
  maxValues: 10 + (MAX_CURRENT_IDENTIFIERS + MAX_FORMER_IDENTIFIERS) * 10,
  maxStringLength: MAX_FORMER_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 1_000_000,
} as const;

// ---------------------------------------------------------------------------
// Identifier types

/** Check one identifier type from untrusted input. Never throws. */
export function validateIdentifierType(input: unknown): Validated<IdentifierType> {
  return guarded(() => {
    const issues = new IssueList();
    const copy = readTop(input, TYPE_LIMITS, issues, "An identifier type must be a plain object.");
    if (copy === undefined) return { ok: false, issues: issues.items };
    checkType(copy, [], issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: copy as unknown as IdentifierType };
  }, "This identifier type could not be read as plain data.");
}

/**
 * Check an identifier type being created: as `validateIdentifierType`, and its
 * key must follow `isIdentifierTypeKey` (no `constructor` or `prototype`,
 * which older stored types may still have). Never throws.
 */
export function validateNewIdentifierType(input: unknown): Validated<IdentifierType> {
  const checked = validateIdentifierType(input);
  if (!checked.ok || isIdentifierTypeKey(checked.value.key)) return checked;
  return {
    ok: false,
    issues: [issue(["key"], "reserved_key", `${shown(checked.value.key)} can't be used as a key.`)],
  };
}

/**
 * Check an organization's whole list of identifier types: each type, plus no
 * two with the same key. Never throws.
 */
export function validateIdentifierTypes(input: unknown): Validated<readonly IdentifierType[]> {
  return guarded(() => {
    const issues = new IssueList();
    if (types.isProxy(input) || !Array.isArray(input)) {
      return {
        ok: false,
        issues: [issue([], "not_a_list", "Identifier types must be a list.")],
      };
    }
    if (input.length > MAX_IDENTIFIER_TYPES) {
      return {
        ok: false,
        issues: [
          issue(
            [],
            "too_many",
            `An organization can have at most ${String(MAX_IDENTIFIER_TYPES)} identifier types.`,
          ),
        ],
      };
    }
    const copy = readPlainData(input, [], TYPES_LIMITS, issues);
    if (copy === undefined || !Array.isArray(copy)) return { ok: false, issues: issues.items };
    const list = copy as readonly JsonValue[];
    const seen = new Set<string>();
    let organization: string | undefined;
    list.forEach((item, index) => {
      if (!isPlainObject(item)) {
        issues.add([index], "not_an_object", "An identifier type must be a plain object.");
        return;
      }
      checkType(item, [index], issues);
      const owner = item.organizationId;
      if (isOrganizationId(owner)) {
        organization ??= owner;
        if (owner !== organization) {
          const mixed = mixedOrganizationsIssue(
            [index, "organizationId"],
            "These identifier types",
          );
          issues.add(mixed.path, mixed.code, mixed.message);
        }
      }
      const key = item.key;
      if (typeof key === "string") {
        if (seen.has(key)) {
          issues.add(
            [index, "key"],
            "duplicate_key",
            `Two identifier types use the key ${shown(key)}.`,
          );
        }
        seen.add(key);
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: list as unknown as readonly IdentifierType[] };
  }, "These identifier types could not be read as plain data.");
}

function checkType(
  type: Readonly<Record<string, JsonValue>>,
  at: readonly (string | number)[],
  issues: IssueList,
): void {
  const view = ownOnly(type);
  unknownKeys(
    view,
    ["organizationId", "key", "label", "pattern", "uniqueness", "autoNumber", "public"],
    at,
    "an identifier type",
    issues,
  );
  if (!isOrganizationId(view.organizationId)) {
    issues.add(
      [...at, "organizationId"],
      "invalid_organization",
      "Every identifier type belongs to one organization: organizationId must be an organization ID.",
    );
  }
  if (!isStoredTypeKey(view.key)) {
    issues.add([...at, "key"], "invalid_key", `The key is ${IDENTIFIER_TYPE_KEY_RULE}.`);
  }
  checkLine(view.label, [...at, "label"], "label", MAX_TYPE_LABEL_LENGTH, issues);

  let pattern: IdentifierPattern | undefined;
  if (view.pattern !== undefined) {
    const parsed = parseIdentifierPattern(view.pattern);
    if (parsed.ok) pattern = parsed.value;
    else for (const i of parsed.issues) issues.add([...at, "pattern"], i.code, i.message);
  }
  if (!(UNIQUENESS_RULES as readonly unknown[]).includes(view.uniqueness)) {
    issues.add(
      [...at, "uniqueness"],
      "invalid_uniqueness",
      `Uniqueness must be one of: ${UNIQUENESS_RULES.join(", ")}.`,
    );
  }
  if (view.public !== undefined && typeof view.public !== "boolean") {
    issues.add(
      [...at, "public"],
      "invalid_public",
      "public must be true or false. Left out, the type is staff only.",
    );
  }
  if (view.autoNumber !== undefined) {
    const auto = checkAutoNumber(view.autoNumber, [...at, "autoNumber"], issues);
    // A number the type would give out must fit its own format, in every year
    // it is likely to be used: a format with a literal year (`2026.###`) would
    // stop working on 1 January. Years 2000 to 2099 are checked, so `20##.###`
    // is allowed.
    if (auto !== undefined && pattern !== undefined) {
      const sample = sampleMismatch(auto, pattern);
      if (sample !== undefined) {
        issues.add(
          [...at, "autoNumber"],
          "auto_number_mismatch",
          `Auto-numbering would give out ${shown(sample)}, which doesn't match the format ${shown(pattern.source)}.`,
        );
      }
    }
  }
}

function sampleMismatch(auto: AutoNumbering, pattern: IdentifierPattern): string | undefined {
  const years = auto.style === "year" ? SAMPLE_YEARS : [SAMPLE_YEARS[0] ?? 2000];
  for (const year of years) {
    const sample = formatAutoNumber(auto, 1, year);
    if (!matchesIdentifierPattern(pattern, sample)) return sample;
  }
  return undefined;
}

const SAMPLE_YEARS: readonly number[] = Array.from({ length: 100 }, (_, i) => 2000 + i);

function checkAutoNumber(
  value: JsonValue,
  at: readonly (string | number)[],
  issues: IssueList,
): AutoNumbering | undefined {
  if (!isPlainObject(value)) {
    issues.add([...at], "not_an_object", "autoNumber must be an object.");
    return undefined;
  }
  const view = ownOnly(value);
  const before = issues.count;
  const digits = view.digits;
  if (
    typeof digits !== "number" ||
    !Number.isInteger(digits) ||
    digits < 1 ||
    digits > MAX_AUTO_DIGITS
  ) {
    issues.add(
      [...at, "digits"],
      "invalid_digits",
      `digits must be a whole number from 1 to ${String(MAX_AUTO_DIGITS)}.`,
    );
  }
  if (view.style === "year") {
    unknownKeys(view, ["style", "separator", "digits"], at, "year-based numbering", issues);
    if (!(YEAR_SEPARATORS as readonly unknown[]).includes(view.separator)) {
      issues.add(
        [...at, "separator"],
        "invalid_separator",
        `The separator must be one of: ${YEAR_SEPARATORS.join(" ")}`,
      );
    }
  } else if (view.style === "prefix") {
    unknownKeys(view, ["style", "prefix", "digits"], at, "prefix numbering", issues);
    const prefix = view.prefix;
    if (
      checkLine(prefix, [...at, "prefix"], "prefix", MAX_PREFIX_LENGTH, issues) &&
      typeof prefix === "string"
    ) {
      if (INVISIBLE.test(prefix)) {
        issues.add(
          [...at, "prefix"],
          "invisible_characters",
          "The prefix contains invisible or blank characters.",
        );
      } else if (hasTooManyMarks(prefix)) {
        issues.add([...at, "prefix"], "too_many_marks", TOO_MANY_MARKS);
      } else if (/\p{Nd}$/u.test(prefix) || /[0-9]$/.test(identifierKey(prefix))) {
        // `X1` + `0001` would read back as `X10001`: the number can't be found again.
        issues.add([...at, "prefix"], "prefix_ends_in_digit", "The prefix can't end with a digit.");
      }
    }
  } else {
    issues.add([...at, "style"], "invalid_style", "style must be year or prefix.");
  }
  return issues.count === before ? (value as unknown as AutoNumbering) : undefined;
}

// ---------------------------------------------------------------------------
// A record's identifiers

/**
 * Check one record's identifiers from untrusted input, against the
 * organization's (already validated) identifier types. Never throws.
 *
 * Current identifiers must use a defined type and fit its format; when there
 * are any, exactly one is primary. Former identifiers are history: they keep
 * whatever value they had, even if it never fit today's format, and may name a
 * type that has since been removed.
 */
export function validateRecordIdentifiers(
  input: unknown,
  identifierTypes: readonly IdentifierType[],
): Validated<RecordIdentifiers> {
  return guarded(() => {
    const issues = new IssueList();
    const copy = readTop(
      input,
      SET_LIMITS,
      issues,
      "A record's identifiers must be a plain object.",
    );
    if (copy === undefined) return { ok: false, issues: issues.items };
    const view = ownOnly(copy);
    unknownKeys(
      view,
      ["recordId", "organizationId", "current", "former"],
      [],
      "a record's identifiers",
      issues,
    );
    if (!isRecordId(view.recordId)) {
      issues.add(["recordId"], "invalid_id", "recordId must be a record ID.");
    }
    const owner = view.organizationId;
    if (!isOrganizationId(owner)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "A record's identifiers belong to its organization: organizationId must be an organization ID.",
      );
    }
    // The types are read once, validated, and that copy is what both the
    // organization check and the format checks use (D-030).
    const typesRead = readTypes(identifierTypes);
    if (!typesRead.ok) {
      return {
        ok: false,
        issues: typesRead.issues.map((i) =>
          i.code === "mixed_organizations"
            ? mixedOrganizationsIssue(["organizationId"], "These identifiers and identifier types")
            : i,
        ),
      };
    }
    if (
      isOrganizationId(owner) &&
      oneOrganization([{ organizationId: owner }, ...typesRead.value]) === "mixed"
    ) {
      // Another organization's types are refused outright, never used to
      // check this record's numbers (D-019, D-030).
      return {
        ok: false,
        issues: [
          mixedOrganizationsIssue(["organizationId"], "These identifiers and identifier types"),
        ],
      };
    }
    const byKey = typeMap(typesRead.value);
    checkCurrent(view.current, byKey, issues);
    checkFormer(view.former, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: copy as unknown as RecordIdentifiers };
  }, "These identifiers could not be read as plain data.");
}

/**
 * Read one record's stored identifiers for a check over existing data
 * (`identifierTypeChanges`): every safety and shape rule of
 * `validateRecordIdentifiers`, but a current identifier may name a type that
 * no longer exists or not fit its type's format, since stored data can
 * already be stranded. Internal: not exported from the package. Never throws.
 */
export function readStoredIdentifiers(input: unknown): Validated<RecordIdentifiers> {
  return guarded(() => {
    const issues = new IssueList();
    const copy = readTop(
      input,
      SET_LIMITS,
      issues,
      "A record's identifiers must be a plain object.",
    );
    if (copy === undefined) return { ok: false, issues: issues.items };
    const view = ownOnly(copy);
    unknownKeys(
      view,
      ["recordId", "organizationId", "current", "former"],
      [],
      "a record's identifiers",
      issues,
    );
    if (!isRecordId(view.recordId)) {
      issues.add(["recordId"], "invalid_id", "recordId must be a record ID.");
    }
    if (!isOrganizationId(view.organizationId)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "A record's identifiers belong to its organization: organizationId must be an organization ID.",
      );
    }
    checkCurrent(view.current, undefined, issues);
    checkFormer(view.former, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: copy as unknown as RecordIdentifiers };
  }, "These identifiers could not be read as plain data.");
}

interface CompiledType {
  readonly type: IdentifierType;
  readonly pattern: IdentifierPattern | undefined;
}

function typeMap(identifierTypes: readonly IdentifierType[]): Map<string, CompiledType> {
  const byKey = new Map<string, CompiledType>();
  for (const type of identifierTypes) {
    let pattern: IdentifierPattern | undefined;
    if (type.pattern !== undefined) {
      const parsed = parseIdentifierPattern(type.pattern);
      if (parsed.ok) pattern = parsed.value;
    }
    if (!byKey.has(type.key)) byKey.set(type.key, { type, pattern });
  }
  return byKey;
}

/** `byKey` undefined: stored data, any well-formed type key, no format check. */
function checkCurrent(
  list: JsonValue | undefined,
  byKey: Map<string, CompiledType> | undefined,
  issues: IssueList,
): void {
  if (!Array.isArray(list)) {
    issues.add(["current"], "not_a_list", "current must be a list.");
    return;
  }
  const items = list as readonly JsonValue[];
  if (items.length > MAX_CURRENT_IDENTIFIERS) {
    issues.add(
      ["current"],
      "too_many",
      `A record can have at most ${String(MAX_CURRENT_IDENTIFIERS)} current identifiers.`,
    );
    return;
  }
  let primaries = 0;
  const seen = new Set<string>();
  items.forEach((raw, index) => {
    const at = ["current", index];
    if (!isPlainObject(raw)) {
      issues.add(at, "not_an_object", "An identifier must be an object.");
      return;
    }
    const item = ownOnly(raw);
    unknownKeys(item, ["type", "value", "primary"], at, "an identifier", issues);
    const known =
      byKey === undefined
        ? isStoredTypeKey(item.type)
          ? { type: { key: item.type, label: item.type }, pattern: undefined }
          : undefined
        : typeof item.type === "string"
          ? byKey.get(item.type)
          : undefined;
    if (known === undefined) {
      issues.add(
        [...at, "type"],
        byKey === undefined ? "invalid_type" : "unknown_type",
        byKey === undefined
          ? "The type must be an identifier type key."
          : `${shown(item.type)} is not one of this organization's identifier types.`,
      );
    }
    const valueOk = checkValue(item.value, [...at, "value"], issues);
    if (valueOk && typeof item.value === "string" && known !== undefined) {
      if (known.pattern !== undefined && !matchesIdentifierPattern(known.pattern, item.value)) {
        issues.add(
          [...at, "value"],
          "format_mismatch",
          patternMismatchMessage(known.pattern, item.value),
        );
      }
      const dupKey = `${known.type.key}\u0000${identifierKey(item.value)}`;
      if (seen.has(dupKey)) {
        issues.add(
          [...at, "value"],
          "duplicate",
          `This record already has ${known.type.label} ${shown(item.value)}.`,
        );
      }
      seen.add(dupKey);
    }
    if (typeof item.primary !== "boolean") {
      issues.add([...at, "primary"], "invalid_primary", "primary must be true or false.");
    } else if (item.primary) {
      primaries += 1;
      if (primaries > 1) {
        issues.add(
          [...at, "primary"],
          "several_primary",
          "Only one identifier can be the primary one.",
        );
      }
    }
  });
  if (items.length > 0 && primaries === 0) {
    issues.add(["current"], "no_primary", "Mark one identifier as the primary one.");
  }
}

function checkFormer(list: JsonValue | undefined, issues: IssueList): void {
  if (!Array.isArray(list)) {
    issues.add(["former"], "not_a_list", "former must be a list.");
    return;
  }
  const items = list as readonly JsonValue[];
  if (items.length > MAX_FORMER_IDENTIFIERS) {
    issues.add(
      ["former"],
      "too_many",
      `A record can keep at most ${String(MAX_FORMER_IDENTIFIERS)} former identifiers.`,
    );
    return;
  }
  const seen = new Set<string>();
  items.forEach((raw, index) => {
    const at = ["former", index];
    if (!isPlainObject(raw)) {
      issues.add(at, "not_an_object", "A former identifier must be an object.");
      return;
    }
    const item = ownOnly(raw);
    unknownKeys(item, ["type", "value", "retiredAt", "note"], at, "a former identifier", issues);
    if (!isStoredTypeKey(item.type)) {
      issues.add([...at, "type"], "invalid_type", "The type must be an identifier type key.");
    }
    if (
      checkValue(item.value, [...at, "value"], issues) &&
      typeof item.value === "string" &&
      typeof item.type === "string"
    ) {
      // Exact match: former identifiers are history, and two spellings of one
      // old number (`dhs-1`, `DHS-1`) are both worth keeping.
      const dupKey = `${item.type}\u0000${item.value}`;
      if (seen.has(dupKey)) {
        issues.add(
          [...at, "value"],
          "duplicate",
          `${shown(item.value)} is listed twice as a former identifier.`,
        );
      }
      seen.add(dupKey);
    }
    if (item.retiredAt !== undefined && !isUtcTimestamp(item.retiredAt)) {
      issues.add(
        [...at, "retiredAt"],
        "invalid_timestamp",
        "retiredAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
      );
    }
    if (item.note !== undefined) checkNote(item.note, [...at, "note"], issues);
  });
}

const TOO_MANY_MARKS = `A letter can carry at most ${String(MAX_MARK_RUN)} accents or other marks.`;

/** Rules every stored identifier value follows, whatever its type. */
function checkValue(
  value: JsonValue | undefined,
  at: (string | number)[],
  issues: IssueList,
): boolean {
  if (!checkLine(value, at, "identifier", MAX_IDENTIFIER_LENGTH, issues)) return false;
  if (typeof value === "string" && INVISIBLE.test(value)) {
    issues.add(
      at,
      "invisible_characters",
      "The identifier contains invisible or blank characters, which would make two different numbers look the same.",
    );
    return false;
  }
  if (typeof value === "string" && hasTooManyMarks(value)) {
    issues.add(at, "too_many_marks", TOO_MANY_MARKS);
    return false;
  }
  return true;
}

/** A required one-line, trimmed text of at most `max` characters. */
function checkLine(
  value: JsonValue | undefined,
  at: (string | number)[],
  what: string,
  max: number,
  issues: IssueList,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(at, "required", `The ${what} is missing or empty.`);
    return false;
  }
  let ok = true;
  if (value !== value.trim()) {
    issues.add(at, "untrimmed", `The ${what} starts or ends with spaces.`);
    ok = false;
  }
  if (value.length > max) {
    issues.add(at, "too_long", `The ${what} can be at most ${String(max)} characters.`);
    ok = false;
  }
  if (ONE_LINE_BREAKS.test(value)) {
    issues.add(
      at,
      "control_characters",
      `The ${what} must be one line, with no tabs or line breaks.`,
    );
    ok = false;
  }
  return ok;
}

function checkNote(value: JsonValue, at: (string | number)[], issues: IssueList): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(at, "required", "A note must be text; leave it out if there is none.");
    return;
  }
  // Already checked when read with readPlainData; repeated for notes passed
  // straight to retireIdentifier.
  const problem = textProblem(value);
  if (problem !== undefined) issues.add(at, "bad_characters", `This note ${problem}.`);
  if (value.length > MAX_FORMER_NOTE_LENGTH) {
    issues.add(
      at,
      "too_long",
      `A note can be at most ${String(MAX_FORMER_NOTE_LENGTH)} characters.`,
    );
  }
}

function isUtcTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

/** The record's primary identifier, if it has any current ones. */
export function primaryIdentifier(identifiers: RecordIdentifiers): Identifier | undefined {
  return identifiers.current.find((i) => i.primary);
}

// ---------------------------------------------------------------------------
// One home for numbers (D-038)

/**
 * Many records' identifiers, read once into plain, frozen copies (Proxies,
 * getters and malformed sets refused), all of one organization
 * (`mixed_organizations` otherwise, also for a set that names none), keyed
 * by record ID. A record ID listed twice is refused
 * (`duplicate_identifiers`): which of the two sets is the record's would be
 * a guess. Internal: not exported from the package. Never throws.
 */
export function readIdentifierSets(
  all: unknown,
): Validated<ReadonlyMap<RecordId, RecordIdentifiers>> {
  const snap = snapshot(all, []);
  if (!snap.ok) return snap;
  const byRecord = new Map<RecordId, RecordIdentifiers>();
  for (const [index, set] of snap.value.sets.entries()) {
    if (byRecord.has(set.recordId)) {
      return {
        ok: false,
        issues: [
          issue(
            [index, "recordId"],
            "duplicate_identifiers",
            "Two sets of identifiers name the same record.",
          ),
        ],
      };
    }
    byRecord.set(set.recordId, set);
  }
  return { ok: true, value: byRecord };
}

/**
 * True when `item` is `{ type, value }` (own data properties, both text)
 * naming exactly one of the current identifiers in `set`: the same type key
 * and the same value, character for character. A template `identifier`
 * field only points at one of its record's current identifiers (D-038);
 * anything else, a former number, a lookalike spelling or another type's
 * number, is not held. Internal. Never throws.
 */
export function holdsCurrentIdentifier(
  set: RecordIdentifiers | undefined,
  item: unknown,
): boolean {
  try {
    if (set === undefined || types.isProxy(item) || !isPlainObject(item)) return false;
    const type = Object.getOwnPropertyDescriptor(item, "type");
    const value = Object.getOwnPropertyDescriptor(item, "value");
    if (type === undefined || value === undefined || !("value" in type) || !("value" in value)) {
      return false;
    }
    const t: unknown = type.value;
    const v: unknown = value.value;
    if (typeof t !== "string" || typeof v !== "string") return false;
    return set.current.some((c) => c.type === t && c.value === v);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Uniqueness

interface Holder {
  readonly match: IdentifierMatch;
  /** Where it sits in its record's `current` or `former` list. */
  readonly index: number;
}

/** Every place each (type, key) pair is held, grouped. */
function holdersByKey(
  all: readonly RecordIdentifiers[],
  includeFormer: (type: string) => boolean,
): Map<string, Holder[]> {
  const groups = new Map<string, Holder[]>();
  const add = (value: string, holder: Holder): void => {
    const key = `${holder.match.type}\u0000${identifierKey(value)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [holder]);
    else group.push(holder);
  };
  for (const set of all) {
    set.current.forEach((item, index) => {
      add(item.value, { match: currentMatch(set.recordId, item), index });
    });
    set.former.forEach((item, index) => {
      if (includeFormer(item.type))
        add(item.value, { match: formerMatch(set.recordId, item), index });
    });
  }
  return groups;
}

function currentMatch(recordId: RecordId, item: Identifier): IdentifierMatch {
  return Object.freeze({
    recordId,
    type: item.type,
    value: item.value,
    status: "current",
    primary: item.primary,
  });
}

function formerMatch(recordId: RecordId, item: FormerIdentifier): IdentifierMatch {
  return Object.freeze({
    recordId,
    type: item.type,
    value: item.value,
    status: "former",
    primary: false,
  });
}

/**
 * Check every record's identifiers against each type's uniqueness rule.
 * Reports every holder of a value that more than one record uses (with the
 * path `[recordId, "current" | "former", index]`). Linear in the number of
 * identifiers; stops after a few hundred problems. Refuses, with the one
 * issue `mixed_organizations`, records or types of more than one organization.
 */
export function uniquenessIssues(
  allInput: readonly RecordIdentifiers[],
  typesInput: readonly IdentifierType[],
): Issue[] {
  const snap = snapshot(allInput, typesInput);
  if (!snap.ok) return [...snap.issues];
  const { sets: all, types: identifierTypes } = snap.value;
  const byKey = typeMap(identifierTypes);
  const ruleOf = (type: string): UniquenessRule => byKey.get(type)?.type.uniqueness ?? "none";
  const groups = holdersByKey(all, (type) => ruleOf(type) === "all_time");
  const issues = new IssueList();
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined || ruleOf(first.match.type) === "none") continue;
    const records = new Set(group.map((h) => h.match.recordId));
    if (records.size < 2) continue;
    const label = byKey.get(first.match.type)?.type.label ?? first.match.type;
    for (const { match, index } of group) {
      issues.add(
        [match.recordId, match.status, index],
        "not_unique",
        `${label} ${shown(match.value)} is used by ${String(records.size)} records${
          match.status === "former" ? " (here as a former identifier)" : ""
        }.`,
      );
    }
    if (issues.full) break;
  }
  return issues.items;
}

/**
 * The identifiers held by other records that a new identifier would clash
 * with under its type's uniqueness rule. Empty when it is free to use, when
 * the rule is `none`, or when the type is unknown (`checkNewIdentifier`
 * reports that). Fails with `mixed_organizations` when the records and types
 * belong to more than one organization, or any doesn't say which (D-030):
 * another organization's holders are never listed. Never throws.
 */
export function findIdentifierConflicts(
  candidate: { readonly type: string; readonly value: string },
  recordId: RecordId,
  all: readonly RecordIdentifiers[],
  identifierTypes: readonly IdentifierType[],
): Validated<readonly IdentifierMatch[]> {
  return guarded(() => {
    const snap = snapshot(all, identifierTypes);
    if (!snap.ok) return snap;
    const { sets, types } = snap.value;
    return { ok: true, value: Object.freeze(conflicts(candidate, recordId, sets, types)) };
  }, "These identifiers could not be read as plain data.");
}

function conflicts(
  candidate: { readonly type: string; readonly value: string },
  recordId: RecordId,
  all: readonly RecordIdentifiers[],
  identifierTypes: readonly IdentifierType[],
): IdentifierMatch[] {
  const type = typeMap(identifierTypes).get(candidate.type)?.type;
  if (type === undefined || type.uniqueness === "none") return [];
  const key = identifierKey(candidate.value);
  const conflicts: IdentifierMatch[] = [];
  for (const set of all) {
    if (set.recordId === recordId) continue;
    for (const item of set.current) {
      if (item.type === type.key && identifierKey(item.value) === key) {
        conflicts.push(currentMatch(set.recordId, item));
      }
    }
    if (type.uniqueness !== "all_time") continue;
    for (const item of set.former) {
      if (item.type === type.key && identifierKey(item.value) === key) {
        conflicts.push(formerMatch(set.recordId, item));
      }
    }
  }
  return conflicts;
}

/**
 * Check an identifier before giving it to a record: its type exists, the value
 * is well-formed and fits the type's format, and no other record holds it
 * under the type's uniqueness rule. Returns every problem; empty means go
 * ahead. Records or types of more than one organization are refused with the
 * one issue `mixed_organizations`: a number is unique within its own
 * organization only, and another organization's numbers are never looked at.
 * Never throws.
 */
export function checkNewIdentifier(
  candidate: unknown,
  recordId: RecordId,
  allInput: readonly RecordIdentifiers[],
  typesInput: readonly IdentifierType[],
): Issue[] {
  return guardedIssues(() => {
    const snap = snapshot(allInput, typesInput);
    if (!snap.ok) return [...snap.issues];
    const { sets: all, types: identifierTypes } = snap.value;
    const issues = new IssueList();
    const copy = readTop(candidate, TYPE_LIMITS, issues, "An identifier must be a plain object.");
    if (copy === undefined) return issues.items;
    const item = ownOnly(copy);
    unknownKeys(item, ["type", "value"], [], "a new identifier", issues);
    const known =
      typeof item.type === "string" ? typeMap(identifierTypes).get(item.type) : undefined;
    if (known === undefined) {
      issues.add(
        ["type"],
        "unknown_type",
        `${shown(item.type)} is not one of this organization's identifier types.`,
      );
    }
    if (
      !checkValue(item.value, ["value"], issues) ||
      typeof item.value !== "string" ||
      known === undefined
    ) {
      return issues.items;
    }
    if (known.pattern !== undefined && !matchesIdentifierPattern(known.pattern, item.value)) {
      issues.add(["value"], "format_mismatch", patternMismatchMessage(known.pattern, item.value));
    }
    // The organization check ran above, so the sets are this organization's.
    const first = conflicts(
      { type: known.type.key, value: item.value },
      recordId,
      all,
      identifierTypes,
    )[0];
    if (first !== undefined) {
      issues.add(
        ["value"],
        "not_unique",
        first.status === "current"
          ? `${known.type.label} ${shown(item.value)} is already used by another record.`
          : `${known.type.label} ${shown(item.value)} used to belong to another record, and this type's numbers are never reused.`,
      );
    }
    return issues.items;
  });
}

// ---------------------------------------------------------------------------
// Search

/**
 * Find records by a current or former identifier. Matching ignores case,
 * spaces and lookalike characters (see `identifier-key.ts`) but is otherwise
 * exact. Current matches come before former ones. Options: `type` limits the
 * search to one identifier type; `includeFormer: false` leaves former
 * identifiers out. Bad queries (not text, empty, too long) find nothing.
 * Fails with `mixed_organizations` when the sets belong to more than one
 * organization, or any doesn't say which (D-030): a search never returns
 * another organization's records. Never throws.
 */
export function findByIdentifier(
  query: unknown,
  all: readonly RecordIdentifiers[],
  options: { readonly type?: string; readonly includeFormer?: boolean } = {},
): Validated<readonly IdentifierMatch[]> {
  return guarded(() => {
    const snap = snapshot(all, []);
    if (!snap.ok) return snap;
    return { ok: true, value: search(query, snap.value.sets, options) };
  }, "These identifiers could not be read as plain data.");
}

function search(
  query: unknown,
  all: readonly RecordIdentifiers[],
  options: { readonly type?: string; readonly includeFormer?: boolean },
): readonly IdentifierMatch[] {
  if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH) return Object.freeze([]);
  const key = identifierKey(query);
  if (key.length === 0) return Object.freeze([]);
  const wanted = (type: string): boolean => options.type === undefined || options.type === type;
  const current: IdentifierMatch[] = [];
  const former: IdentifierMatch[] = [];
  for (const set of all) {
    for (const item of set.current) {
      if (wanted(item.type) && identifierKey(item.value) === key) {
        current.push(currentMatch(set.recordId, item));
      }
    }
    if (options.includeFormer === false) continue;
    for (const item of set.former) {
      if (wanted(item.type) && identifierKey(item.value) === key) {
        former.push(formerMatch(set.recordId, item));
      }
    }
  }
  return Object.freeze([...current, ...former]);
}

// ---------------------------------------------------------------------------
// Auto-numbering

function formatAutoNumber(auto: AutoNumbering, n: number, year: number): string {
  const digits = String(n).padStart(auto.digits, "0");
  return auto.style === "year"
    ? `${String(year)}${auto.separator}${digits}`
    : `${auto.prefix}${digits}`;
}

/**
 * The next auto-number for a type: one more than the highest number of the
 * same form already used by any record, current or former, so a retired
 * number is never given out again. Gaps are not filled. Numbers padded
 * differently (`DHS-7`, `DHS-0007`) count as the same number. Year-based
 * numbering needs the `year` (the organization's own calendar year, which the
 * caller knows and this module doesn't) and restarts at 1 each year.
 *
 * Fails, rather than guessing, when the type has no auto-numbering, the year
 * is missing, the numbers have run out, or the next number won't fit the
 * type's format (`DHS-####` after `DHS-9999`), or the records and the type
 * belong to more than one organization (`mixed_organizations`).
 */
export function nextIdentifier(
  typeInput: IdentifierType,
  allInput: readonly RecordIdentifiers[],
  options: { readonly year?: number } = {},
): Validated<string> {
  const snap = snapshot(allInput, [typeInput]);
  if (!snap.ok) return snap;
  const { sets: all } = snap.value;
  const type = snap.value.types[0];
  if (type === undefined) return fail("unreadable", "The identifier type could not be read.");
  const auto = type.autoNumber;
  if (auto === undefined) {
    return fail("no_auto_number", `${type.label} numbers are not given out automatically.`);
  }
  let start: string;
  const year = options.year;
  if (auto.style === "year") {
    if (year === undefined || !Number.isInteger(year) || year < 1000 || year > 9999) {
      return fail("year_required", "Year-based numbering needs a four-digit year.");
    }
    start = identifierKey(`${String(year)}${auto.separator}`);
  } else {
    start = identifierKey(auto.prefix);
  }
  let pattern: IdentifierPattern | undefined;
  if (type.pattern !== undefined) {
    const parsed = parseIdentifierPattern(type.pattern);
    if (parsed.ok) pattern = parsed.value;
  }
  let highest = 0;
  let highestValue = "";
  const consider = (itemType: string, value: string): void => {
    if (itemType !== type.key) return;
    const key = identifierKey(value);
    if (!key.startsWith(start)) return;
    const rest = key.slice(start.length);
    if (!/^[0-9]{1,15}$/.test(rest)) return;
    const n = Number(rest);
    // Numbers past the limit can never be given out, so they can't clash; one
    // stray value must not make the type run out of numbers.
    if (n <= highest || n > MAX_AUTO_NUMBER) return;
    // A number this type's format could never give out (an old or mistyped
    // `DHS-0001000000` under `DHS-####`) can't clash with a new one, so it
    // must not push the count past what the format allows.
    if (
      pattern !== undefined &&
      !matchesIdentifierPattern(pattern, formatAutoNumber(auto, n, year ?? 0))
    ) {
      return;
    }
    highest = n;
    highestValue = value;
  };
  for (const set of all) {
    for (const item of set.current) consider(item.type, item.value);
    for (const item of set.former) consider(item.type, item.value);
  }
  const next = highest + 1;
  if (next > MAX_AUTO_NUMBER) {
    return fail("numbers_exhausted", `${type.label} numbers have run out.`);
  }
  const value = formatAutoNumber(auto, next, year ?? 0);
  if (pattern !== undefined && !matchesIdentifierPattern(pattern, value)) {
    return fail(
      "pattern_full",
      `The next ${type.label} after ${shown(highestValue)} would be ${shown(value)}, which doesn't fit the format ${shown(pattern.source)}.`,
    );
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Changing a record's identifiers without losing any

/**
 * Move one current identifier (matched by type and exact value) to the former
 * list, so it stays findable. If it was the primary one and others remain,
 * `newPrimary` must say which becomes primary; nothing is picked silently.
 * `newPrimary` can also be given to move the primary mark when retiring a
 * non-primary identifier. If exactly this value is already listed as former
 * (it was retired before and reinstated), that one entry is kept, with the new
 * date if one is given (otherwise the old one) and both notes. Returns a new frozen object. Never throws.
 */
export function retireIdentifier(
  identifiers: RecordIdentifiers,
  target: { readonly type: string; readonly value: string },
  options: {
    readonly retiredAt?: string;
    readonly note?: string;
    readonly newPrimary?: { readonly type: string; readonly value: string };
  } = {},
): Validated<RecordIdentifiers> {
  const index = identifiers.current.findIndex(
    (i) => i.type === target.type && i.value === target.value,
  );
  const retired = identifiers.current[index];
  if (retired === undefined) {
    return fail("not_found", `This record has no current identifier ${shown(target.value)}.`);
  }
  if (options.retiredAt !== undefined && !isUtcTimestamp(options.retiredAt)) {
    return fail(
      "invalid_timestamp",
      "retiredAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
    );
  }
  if (options.note !== undefined) {
    const issues = new IssueList();
    checkNote(options.note, ["note"], issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
  }
  const remaining = identifiers.current.filter((_, i) => i !== index);
  let newPrimaryIndex = remaining.findIndex((i) => i.primary);
  if (options.newPrimary !== undefined) {
    const wanted = options.newPrimary;
    newPrimaryIndex = remaining.findIndex(
      (i) => i.type === wanted.type && i.value === wanted.value,
    );
    if (newPrimaryIndex === -1) {
      return fail(
        "not_found",
        `The new primary identifier ${shown(wanted.value)} is not one of the record's remaining identifiers.`,
      );
    }
  } else if (newPrimaryIndex === -1 && remaining.length > 0) {
    return fail(
      "primary_needed",
      "The primary identifier is being retired: say which identifier becomes primary.",
    );
  }
  const current = remaining.map((i, n) =>
    Object.freeze({ type: i.type, value: i.value, primary: n === newPrimaryIndex }),
  );
  // Matched exactly, so a differently spelled former entry never hides this one.
  const existingIndex = identifiers.former.findIndex(
    (f) => f.type === retired.type && f.value === retired.value,
  );
  const existing = identifiers.former[existingIndex];
  // Retired before and reinstated: keep the one entry, with the latest date and
  // every note.
  const note =
    existing?.note !== undefined && options.note !== undefined && existing.note !== options.note
      ? `${existing.note}\n${options.note}`
      : (options.note ?? existing?.note);
  if (note !== undefined && note.length > MAX_FORMER_NOTE_LENGTH) {
    return fail("too_long", `A note can be at most ${String(MAX_FORMER_NOTE_LENGTH)} characters.`);
  }
  const retiredAt = options.retiredAt ?? existing?.retiredAt;
  const entry: FormerIdentifier = Object.freeze({
    type: retired.type,
    value: retired.value,
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(note === undefined ? {} : { note }),
  });
  const former =
    existing === undefined
      ? [...identifiers.former, entry]
      : identifiers.former.map((f, i) => (i === existingIndex ? entry : f));
  if (former.length > MAX_FORMER_IDENTIFIERS) {
    return fail(
      "too_many",
      `A record can keep at most ${String(MAX_FORMER_IDENTIFIERS)} former identifiers.`,
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      recordId: identifiers.recordId,
      organizationId: identifiers.organizationId,
      current: Object.freeze(current),
      former: Object.freeze(former),
    }),
  };
}

/**
 * Identifiers (current or former) in `before` that appear nowhere in `after`,
 * matched by type and exact value. A save path uses this to refuse, or ask
 * about, a change that would silently lose an old number.
 */
export function droppedIdentifiers(
  before: RecordIdentifiers,
  after: RecordIdentifiers,
): readonly DroppedIdentifier[] {
  const kept = new Set<string>();
  for (const item of [...after.current, ...after.former]) kept.add(pairKey(item));
  const afterFormer = new Map<string, FormerIdentifier>();
  for (const item of after.former) afterFormer.set(pairKey(item), item);
  const dropped: DroppedIdentifier[] = [];
  const reported = new Set<string>();
  const report = (item: { type: string; value: string }, lost: DroppedIdentifier["lost"]): void => {
    const key = pairKey(item);
    if (reported.has(key)) return;
    reported.add(key);
    dropped.push(Object.freeze({ type: item.type, value: item.value, lost }));
  };
  for (const item of [...before.current, ...before.former]) {
    if (!kept.has(pairKey(item))) report(item, "identifier");
  }
  // A former entry's date and note are its history: losing them, or changing
  // them other than as retireIdentifier does (a newer date, a note added
  // after the old one), is reported too.
  for (const item of before.former) {
    if (!kept.has(pairKey(item))) continue;
    const later = afterFormer.get(pairKey(item));
    const dateLost =
      item.retiredAt !== undefined &&
      (later?.retiredAt === undefined || later.retiredAt < item.retiredAt);
    const noteLost = item.note !== undefined && later?.note?.startsWith(item.note) !== true;
    if (dateLost || noteLost) report(item, "history");
  }
  return Object.freeze(dropped);
}

function pairKey(item: { readonly type: string; readonly value: string }): string {
  return `${item.type}\u0000${item.value}`;
}

// ---------------------------------------------------------------------------
// Helpers

/** The most record identifier sets the set functions take at once. */
const MAX_IDENTIFIER_SETS = 1_000_000;

/**
 * Stored values are copied whatever their length (the work on them is linear,
 * and a set read back from storage must still be checkable); the other
 * limits are a record's own.
 */
const SNAPSHOT_LIMITS = { ...SET_LIMITS, maxStringLength: SET_LIMITS.maxTotalChars } as const;

interface Snapshot {
  readonly sets: readonly RecordIdentifiers[];
  readonly types: readonly IdentifierType[];
}

const MIXED = (): Issue => mixedOrganizationsIssue([], "These identifiers and identifier types");

/**
 * One plain, frozen copy of the record identifier sets and the types, made
 * before anything else looks at them, so the check and the work see exactly
 * the same data: a list walked twice (a Proxy, a getter, an iterator that
 * yields something else the second time) can't show the organization check
 * one set and the search another (D-030). Proxies and getters are refused;
 * each set must have a record ID and lists of `{ type, value }`; the types
 * must pass `validateIdentifierTypes`. Then everything must name one
 * organization (`mixed_organizations`, also for a set or type that names
 * none). Never throws.
 */
/**
 * The caller's identifier types, read once into a validated, frozen copy, so
 * what decides a check is exactly what was validated. A type of another
 * organization, or one that names none, gives `mixed_organizations`; any
 * other problem `invalid_identifier_types`. Never throws.
 */
function readTypes(identifierTypes: unknown): Validated<readonly IdentifierType[]> {
  const read = validateIdentifierTypes(identifierTypes);
  if (read.ok) return read;
  const mixed = read.issues.some(
    (i) => i.code === "mixed_organizations" || i.code === "invalid_organization",
  );
  return {
    ok: false,
    issues: [
      mixed
        ? MIXED()
        : issue(
            [],
            "invalid_identifier_types",
            "The identifier types aren't valid. Check them with validateIdentifierTypes.",
          ),
    ],
  };
}

function snapshot(all: unknown, identifierTypes: unknown): Validated<Snapshot> {
  try {
    const typesRead = readTypes(identifierTypes);
    if (!typesRead.ok) return typesRead;
    if (types.isProxy(all) || !Array.isArray(all)) {
      return fail("not_a_list", "The records' identifiers must be given as a list.");
    }
    const length = all.length;
    if (length > MAX_IDENTIFIER_SETS) {
      return fail(
        "too_many_records",
        `At most ${String(MAX_IDENTIFIER_SETS)} records' identifiers can be looked through at once.`,
      );
    }
    const sets: RecordIdentifiers[] = [];
    for (let i = 0; i < length; i += 1) {
      // Each slot, and the entry's organization, read as plain data properties.
      const slot = Object.getOwnPropertyDescriptor(all, i);
      const entry: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
      if (organizationIdOf(entry) === undefined) return { ok: false, issues: [MIXED()] };
      const issues = new IssueList();
      const copy = readTop(entry, SNAPSHOT_LIMITS, issues, "");
      if (copy === undefined || !isSetShape(copy)) {
        return {
          ok: false,
          issues: [
            issue(
              [i],
              "invalid_identifiers",
              `Entry ${String(i)} is not a record's identifiers. Check it with validateRecordIdentifiers.`,
            ),
          ],
        };
      }
      sets.push(copy);
    }
    const value: Snapshot = Object.freeze({
      sets: Object.freeze(sets),
      types: typesRead.value,
    });
    if (oneOrganization([...value.sets, ...value.types]) === "mixed") {
      return { ok: false, issues: [MIXED()] };
    }
    return { ok: true, value };
  } catch {
    return fail("unreadable", "These identifiers could not be read as plain data.");
  }
}

/** The shape the set functions rely on, in a plain copy. */
function isSetShape(
  copy: Readonly<Record<string, JsonValue>>,
): copy is Readonly<Record<string, JsonValue>> & RecordIdentifiers {
  const view = ownOnly(copy);
  if (!isRecordId(view.recordId) || !isOrganizationId(view.organizationId)) return false;
  const items = (list: JsonValue | undefined, current: boolean): boolean =>
    Array.isArray(list) &&
    list.every((item) => {
      if (!isPlainObject(item)) return false;
      const own = ownOnly(item as Readonly<Record<string, JsonValue>>);
      return (
        typeof own.type === "string" &&
        typeof own.value === "string" &&
        (!current || typeof own.primary === "boolean")
      );
    });
  return items(view.current, true) && items(view.former, false);
}

function fail<T>(code: string, message: string): Validated<T> {
  return { ok: false, issues: [issue([], code, message)] };
}

/** Run a check; a hostile input that throws while being read becomes one issue. */
function guarded<T>(run: () => Validated<T>, message: string): Validated<T> {
  try {
    return run();
  } catch {
    return { ok: false, issues: [issue([], "unreadable", message)] };
  }
}

function guardedIssues(run: () => Issue[]): Issue[] {
  try {
    return run();
  } catch {
    return [issue([], "unreadable", "This identifier could not be read as plain data.")];
  }
}

/** Copy a top-level plain object safely, or report why not. */
function readTop(
  input: unknown,
  limits: typeof TYPE_LIMITS | typeof SET_LIMITS | typeof SNAPSHOT_LIMITS,
  issues: IssueList,
  notObject: string,
): Readonly<Record<string, JsonValue>> | undefined {
  if (types.isProxy(input) || !isPlainObject(input)) {
    issues.add([], "not_an_object", notObject);
    return undefined;
  }
  const copy = readPlainData(input, [], limits, issues);
  if (copy === undefined || !isPlainObject(copy)) return undefined;
  return copy;
}

/** A view of `obj` where anything not an own property reads as undefined. */
function ownOnly(
  obj: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue | undefined>> {
  const view = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(obj)) view[key] = obj[key];
  return view;
}

function unknownKeys(
  view: Readonly<Record<string, JsonValue | undefined>>,
  allowed: readonly string[],
  at: readonly (string | number)[],
  what: string,
  issues: IssueList,
): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(view)) {
    if (!ok.has(key))
      issues.add([...at, key], "unknown_property", `${shown(key)} is not a property of ${what}.`);
  }
}
