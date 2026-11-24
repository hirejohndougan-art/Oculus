/**
 * An organization's terms (decisions D-019, D-030, D-062, D-071).
 *
 * A controlled term on its own (`ControlledTerm`: a label, maybe a
 * vocabulary and a URI) is a value, like a date: it says nothing about whose
 * it is. Two things make terms an organization's data:
 *
 * - **Stored terms**: an organization's local term list and the authority
 *   terms it has saved (T-027, `packages/db` `vocabularies.ts`). A
 *   `StoredTerm` carries a required `organizationId`, a permanent ID and the
 *   term, as its database row carries `organization_id` (D-062).
 * - **Terms gathered for Data Cleaning**: the values an organization's
 *   records hold, and its stored terms, put into one list for
 *   `findNearDuplicateTerms` or `findLcTermsWithoutUri`. Each entry is an
 *   `OrganizationTerm`, `{ organizationId, term }`; a `StoredTerm` is one, and
 *   so is a term usage read from the index (`packages/db`'s `TermUsage`).
 *
 * As everywhere else (D-030), a set that mixes organizations is refused,
 * never filtered: an entry whose `organizationId` is missing, not an
 * organization ID, behind a getter or hidden, and any entry that isn't a
 * plain object (a Proxy, an array, a Date, a class instance; its prototype
 * must be `Object.prototype` or null) counts as another organization's, at
 * any position. As `validateIdentifierTypes` does since
 * S-009b, the set functions are also told which organization the caller
 * expects, and refuse any entry not of it **before anything else about the
 * list is read**, with one fixed-text `mixed_organizations` issue. So a
 * report never pairs or names one organization's labels next to another's,
 * and a list that is wholly another organization's gets no message naming
 * any of its terms.
 *
 * Rights: there are no per-organization rights settings stored as data yet.
 * The rights statements are the built-in `RIGHTS_TERMS` (rights.ts), and a
 * record's rights value lives in the record, which carries its organization.
 * When an organization's rights settings are added (which statements it
 * offers, a default), they get a required `organizationId` the same way.
 */
import { types } from "node:util";
import { issue, type Issue, type Validated } from "./issues.js";
import { IssueList } from "./plain-data.js";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  organizationIdOf,
  type OrganizationId,
} from "./organizations.js";
import { termUriKey, validateControlledTerm, type ControlledTerm } from "./vocabularies.js";

/** A term that says which organization it belongs to. */
export interface OrganizationTerm {
  readonly organizationId: OrganizationId;
  readonly term: ControlledTerm;
}

/** One term of an organization's stored list (local or authority, D-062). */
export interface StoredTerm extends OrganizationTerm {
  /** A random version 4 UUID, made when the term is first stored; never changes. */
  readonly id: string;
}

/** The most stored terms `validateStoredTerms` reads at once. */
export const MAX_STORED_TERMS = 50_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORED_KEYS: ReadonlySet<string> = new Set(["organizationId", "id", "term"]);

/** True if `value` is a stored term ID (a lowercase version 4 UUID). */
export function isStoredTermId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * The text that says which term a value is (D-062's term key, before
 * `packages/db` hashes it): a term with a URI is its vocabulary and
 * `termUriKey(uri)`; any other is its vocabulary and its exact label. No
 * vocabulary and `local` are the same. Two terms with one identity are one
 * term: an organization stores it once (`duplicate_term`, and the database's
 * `terms_one_per_key`). Checks the term with `validateControlledTerm` first.
 */
export function termIdentity(input: unknown): Validated<string> {
  const valid = validateControlledTerm(input);
  return valid.ok ? { ok: true, value: identityOf(valid.value) } : valid;
}

function identityOf(term: ControlledTerm): string {
  const vocab = term.vocabulary ?? "local";
  return term.uri === undefined
    ? `${vocab}\u0000label\u0000${term.label}`
    : `${vocab}\u0000uri\u0000${termUriKey(term.uri)}`;
}

/**
 * Check one stored term: a plain object (prototype `Object.prototype` or
 * null, not a Proxy) with exactly `organizationId`, `id` and `term`, as own
 * enumerable data properties (no getters, setters or hidden properties),
 * with the term checked by `validateControlledTerm`. Returns a frozen copy.
 * Never throws.
 */
export function validateStoredTerm(input: unknown): Validated<StoredTerm> {
  try {
    return readStored(input, []);
  } catch {
    return refused([], "unreadable", "This stored term could not be read as plain data.");
  }
}

/**
 * Check an organization's stored term list (its local terms and saved
 * authority terms) once. `organizationId` is the organization the caller
 * expects: an entry not of it, or not saying which organization it belongs
 * to, refuses the whole list with `mixed_organizations` before any term is
 * read. Then every entry must pass `validateStoredTerm`, and no two may
 * share an ID (`duplicate_id`) or be one term (`duplicate_term`, by
 * `termIdentity`). Returns a frozen list of frozen copies. Never throws.
 */
export function validateStoredTerms(
  input: unknown,
  organizationId: OrganizationId,
): Validated<readonly StoredTerm[]> {
  try {
    if (!isOrganizationId(organizationId)) return badOrganization("these stored terms");
    const list = readList(input, MAX_STORED_TERMS, "stored terms");
    if (!list.ok) return list;
    const stray = strayEntry(list.value, organizationId);
    if (stray !== undefined) return { ok: false, issues: [stray] };
    const issues = new IssueList();
    const out: StoredTerm[] = [];
    const ids = new Set<string>();
    const identities = new Set<string>();
    for (let i = 0; i < list.value.length; i += 1) {
      const read = readStored(slotValue(list.value, i), [i]);
      if (!read.ok) {
        for (const found of read.issues) issues.add(found.path, found.code, found.message);
        continue;
      }
      const stored = read.value;
      // Checked again on the copy, which is what is returned.
      if (stored.organizationId !== organizationId) {
        return {
          ok: false,
          issues: [mixedOrganizationsIssue([i, "organizationId"], "These stored terms")],
        };
      }
      if (ids.has(stored.id)) {
        issues.add([i, "id"], "duplicate_id", "Two stored terms have the same ID.");
      }
      ids.add(stored.id);
      const identity = identityOf(stored.term);
      if (identities.has(identity)) {
        issues.add(
          [i, "term"],
          "duplicate_term",
          "Two stored terms are the same term: an organization stores each term once.",
        );
      }
      identities.add(identity);
      out.push(stored);
    }
    if (issues.count > 0) return { ok: false, issues: Object.freeze([...issues.items]) };
    return { ok: true, value: Object.freeze(out) };
  } catch {
    return refused([], "unreadable", "These stored terms could not be read as plain data.");
  }
}

/**
 * For `findNearDuplicateTerms` and `findLcTermsWithoutUri` (not part of the
 * public API): read a list of `OrganizationTerm` entries, all of
 * `organizationId`, into one result per entry. The organization check comes
 * first and reads nothing but each slot and its `organizationId`; any stray
 * refuses the whole list; an entry must be a plain object (`strayEntry`).
 * Then each entry's `term` (an own enumerable data property;
 * other properties, such as a stored term's `id`, are ignored) is checked
 * with `validateControlledTerm`, its issues' paths starting `[i, "term"]`. A
 * term that fails is that entry's problem only. Issues for a bad
 * `organizationId` or list are added to `issues`, and `undefined` returned.
 */
export function readOrganizationTerms(
  input: unknown,
  organizationId: unknown,
  max: number,
  issues: IssueList,
): readonly Validated<ControlledTerm>[] | undefined {
  if (!isOrganizationId(organizationId)) {
    const bad = badOrganization("these terms");
    if (!bad.ok) for (const found of bad.issues) issues.add(found.path, found.code, found.message);
  }
  const list = readList(input, max, "terms");
  if (!list.ok) {
    for (const found of list.issues) issues.add(found.path, found.code, found.message);
  }
  if (issues.count > 0 || !list.ok || !isOrganizationId(organizationId)) return undefined;
  const stray = strayEntry(list.value, organizationId);
  if (stray !== undefined) {
    issues.add(stray.path, stray.code, stray.message);
    return undefined;
  }
  const out: Validated<ControlledTerm>[] = [];
  for (let i = 0; i < list.value.length; i += 1) {
    out.push(termOf(slotValue(list.value, i), i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers

function refused<T>(path: readonly (string | number)[], code: string, message: string) {
  return { ok: false, issues: Object.freeze([issue(path, code, message)]) } as Validated<T>;
}

function badOrganization<T>(what: string): Validated<T> {
  return refused(
    ["organizationId"],
    "invalid_organization",
    `Say which organization ${what} must belong to: organizationId must be an organization ID.`,
  );
}

/** The caller's list, checked to be an ordinary array of at most `max` entries. */
function readList(input: unknown, max: number, what: string): Validated<readonly unknown[]> {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    return refused([], "not_a_list", `The ${what} must be an ordinary list.`);
  }
  if (input.length > max) {
    return refused([], "too_many", `At most ${String(max)} ${what} can be read at once.`);
  }
  return { ok: true, value: input as readonly unknown[] };
}

/**
 * A slot as a plain, enumerable data property, or undefined (a hole, a
 * getter or setter, a hidden slot).
 */
function slotValue(list: readonly unknown[], i: number): unknown {
  const slot = Object.getOwnPropertyDescriptor(list, i);
  return slot !== undefined && "value" in slot && slot.enumerable === true ? slot.value : undefined;
}

/**
 * True for a plain object: not a Proxy, and its prototype is
 * `Object.prototype` or null (so no array, Date, Map or class instance).
 * The Proxy test comes first, so no trap runs.
 */
function isPlainEntry(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The `mixed_organizations` issue for the first entry that isn't
 * `organizationId`'s, or undefined. A hole, a getter or hidden slot,
 * anything but a plain object (a Proxy, an array, a Date, a class
 * instance), and a missing, invalid, getter or hidden `organizationId` all
 * count. Reads nothing but the slots and their `organizationId`.
 */
function strayEntry(list: readonly unknown[], organizationId: OrganizationId): Issue | undefined {
  for (let i = 0; i < list.length; i += 1) {
    const entry = slotValue(list, i);
    const owner = isPlainEntry(entry) ? ownSlot(entry, "organizationId") : "missing";
    if (
      typeof owner !== "object" ||
      owner.value !== organizationId ||
      organizationIdOf(entry) !== organizationId
    ) {
      return mixedOrganizationsIssue([i, "organizationId"], "These terms");
    }
  }
  return undefined;
}

/**
 * An own, enumerable data property, or a marker when it is missing, or
 * behind a getter or setter or hidden (`not_plain`).
 */
function ownSlot(value: object, key: string): { value: unknown } | "missing" | "not_plain" {
  const slot = Object.getOwnPropertyDescriptor(value, key);
  if (slot === undefined) return "missing";
  if (!("value" in slot) || slot.enumerable !== true) return "not_plain";
  return { value: slot.value as unknown };
}

/** Entry `i`'s term, checked; its problems' paths start `[i, "term"]`. */
function termOf(entry: unknown, i: number): Validated<ControlledTerm> {
  // strayEntry already refused every entry that isn't a plain object (not a
  // Proxy; prototype Object.prototype or null) with an enumerable data
  // `organizationId` of the expected organization.
  const slot = ownSlot(entry as object, "term");
  if (slot === "missing") return refused([i, "term"], "missing", "This entry has no term.");
  if (slot === "not_plain") {
    return refused(
      [i, "term"],
      "not_plain_data",
      "A term can't be behind a getter or setter, or hidden.",
    );
  }
  const valid = validateControlledTerm(slot.value);
  if (valid.ok) return valid;
  return {
    ok: false,
    issues: Object.freeze(
      valid.issues.map((x) => issue([i, "term", ...x.path], x.code, x.message)),
    ),
  };
}

function readStored(input: unknown, at: readonly (string | number)[]): Validated<StoredTerm> {
  if (!isPlainEntry(input)) {
    return refused(at, "not_an_object", "A stored term must be a plain object.");
  }
  const issues = new IssueList();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !STORED_KEYS.has(key)) {
      issues.add(
        [...at, String(key)],
        "unknown_property",
        "A stored term has only organizationId, id and term.",
      );
    }
  }
  const read = (key: string): unknown => {
    const slot = ownSlot(input, key);
    if (slot === "not_plain") {
      issues.add(
        [...at, key],
        "not_plain_data",
        "A stored term can't have getters, setters or hidden properties.",
      );
      return undefined;
    }
    return slot === "missing" ? undefined : slot.value;
  };
  const organizationId = read("organizationId");
  const id = read("id");
  const term = read("term");
  if (!isOrganizationId(organizationId)) {
    issues.add(
      [...at, "organizationId"],
      "invalid_organization",
      "Every stored term belongs to one organization: organizationId must be an organization ID.",
    );
  }
  if (!isStoredTermId(id)) {
    issues.add([...at, "id"], "invalid_id", "A stored term ID is a lowercase version 4 UUID.");
  }
  const valid = validateControlledTerm(term);
  if (!valid.ok) {
    for (const found of valid.issues) {
      issues.add([...at, "term", ...found.path], found.code, found.message);
    }
  }
  if (issues.count > 0 || !valid.ok || !isOrganizationId(organizationId) || !isStoredTermId(id)) {
    return { ok: false, issues: Object.freeze([...issues.items]) };
  }
  return { ok: true, value: Object.freeze({ organizationId, id, term: valid.value }) };
}
