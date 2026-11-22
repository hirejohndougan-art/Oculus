/**
 * Organizations and sites (decisions D-019, D-025, D-028, D-030).
 *
 * One Oculus install can hold several organizations: the Dickinson Historical
 * Society's archives and the library it hosts, say. Each is treated as a
 * completely separate copy of Oculus (D-019): its records, templates,
 * identifier types, vocabularies, rights settings, people and roles belong to
 * it alone, and nothing reads across. A **site** is a public (or password
 * protected) website, and every site belongs to exactly one organization.
 *
 * **How data says which organization it belongs to** (D-030). Everything an
 * organization owns carries its `organizationId` as part of the stored value,
 * the way a database row will carry an `organization_id` column. Functions
 * that work on a set of things (a set of records, a set of record
 * identifiers, a list of identifier types) refuse a set that names more than
 * one organization, with the issue `mixed_organizations`, rather than leaving
 * the strays out: a silently filtered result looks complete when it isn't,
 * and hides the bug that mixed the set. Which organization a session works
 * in, and so which rows it loads, is the service layer's job (T-032, T-041);
 * the checks here are the second line, so a query that forgets its
 * `organization_id` filter fails loudly instead of reading across.
 *
 * Organization and site IDs are random version 4 UUIDs, like record IDs, and
 * never change; names can. Roles (D-025) and imported events (D-028) are not
 * modelled yet; see D-030 for how they will attach.
 */
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import { IssueList, readPlainData, shown, type JsonValue } from "./plain-data.js";

declare const organizationIdBrand: unique symbol;
declare const siteIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one organization forever. */
export type OrganizationId = string & { readonly [organizationIdBrand]: true };

/** A lowercase version 4 UUID that identifies one site forever. */
export type SiteId = string & { readonly [siteIdBrand]: true };

/** One organization in the install. */
export interface Organization {
  readonly id: OrganizationId;
  /** What people see, e.g. "Dickinson Historical Society". */
  readonly name: string;
}

/** One website. It belongs to exactly one organization, and that never changes. */
export interface Site {
  readonly id: SiteId;
  readonly organizationId: OrganizationId;
  /** What people see in the site selector, e.g. "Dickinson Public Library". */
  readonly name: string;
}

export const MAX_ORGANIZATION_NAME_LENGTH = 200;
export const MAX_SITE_NAME_LENGTH = 200;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

const LIMITS = {
  maxDepth: 2,
  maxValues: 20,
  maxStringLength: 1000,
  maxKeyLength: 64,
  maxTotalChars: 5000,
} as const;

// ---------------------------------------------------------------------------
// IDs

/** Make a new random organization ID. */
export function newOrganizationId(): OrganizationId {
  return randomUUID() as OrganizationId;
}

/** True if `value` is a well-formed organization ID (lowercase version 4 UUID). */
export function isOrganizationId(value: unknown): value is OrganizationId {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Read an organization ID from untrusted input. Surrounding spaces are
 * trimmed and upper case is accepted; anything else returns `undefined`.
 */
export function parseOrganizationId(value: unknown): OrganizationId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isOrganizationId(normalized) ? normalized : undefined;
}

/** Make a new random site ID. */
export function newSiteId(): SiteId {
  return randomUUID() as SiteId;
}

/** True if `value` is a well-formed site ID (lowercase version 4 UUID). */
export function isSiteId(value: unknown): value is SiteId {
  return typeof value === "string" && UUID_V4.test(value);
}

/** Read a site ID from untrusted input, as `parseOrganizationId` does. */
export function parseSiteId(value: unknown): SiteId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isSiteId(normalized) ? normalized : undefined;
}

// ---------------------------------------------------------------------------
// Validators

/**
 * Check one organization from untrusted input. Returns a fresh, frozen copy,
 * or every problem found. Never throws.
 */
export function validateOrganization(input: unknown): Validated<Organization> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "An organization must be a plain object.", issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    unknownKeys(view.data, ["id", "name"], "an organization", issues);
    if (!isOrganizationId(view.data.id)) {
      issues.add(["id"], "invalid_id", "The organization ID must be a lowercase version 4 UUID.");
    }
    checkName(view.data.name, "organization", MAX_ORGANIZATION_NAME_LENGTH, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as Organization };
  }, "This organization could not be read as plain data.");
}

/**
 * Check one site from untrusted input, against the install's (already
 * validated) organizations: it must belong to one of them. Returns a fresh,
 * frozen copy, or every problem found. Never throws.
 */
export function validateSite(
  input: unknown,
  organizations: readonly Organization[],
): Validated<Site> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A site must be a plain object.", issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    unknownKeys(view.data, ["id", "organizationId", "name"], "a site", issues);
    if (!isSiteId(view.data.id)) {
      issues.add(["id"], "invalid_id", "The site ID must be a lowercase version 4 UUID.");
    }
    const owner = view.data.organizationId;
    if (!isOrganizationId(owner)) {
      issues.add(
        ["organizationId"],
        "invalid_organization",
        "Every site belongs to one organization: organizationId must be an organization ID.",
      );
    } else if (!knownOrganization(owner, organizations)) {
      issues.add(
        ["organizationId"],
        "unknown_organization",
        `The site belongs to ${shown(owner)}, which is not an organization in this install.`,
      );
    }
    checkName(view.data.name, "site", MAX_SITE_NAME_LENGTH, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as Site };
  }, "This site could not be read as plain data.");
}

function knownOrganization(id: OrganizationId, organizations: unknown): boolean {
  if (types.isProxy(organizations) || !Array.isArray(organizations)) return false;
  const length = organizations.length;
  for (let i = 0; i < length; i += 1) {
    // Read each slot and its `id` as plain data properties, so no getter runs.
    const slot = Object.getOwnPropertyDescriptor(organizations, i);
    const org: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
    if (typeof org !== "object" || org === null || types.isProxy(org)) continue;
    const idSlot = Object.getOwnPropertyDescriptor(org, "id");
    if (idSlot !== undefined && "value" in idSlot && idSlot.value === id) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// For other modules in this package (not exported from the package)

/**
 * The one organization every item names, `undefined` for no items, or
 * `"mixed"` when two items name different organizations **or any item
 * doesn't name a valid one** (missing, not an organization ID, behind a
 * getter or a Proxy), at any position: an item that doesn't say which
 * organization it belongs to could be another organization's. Each
 * `organizationId` is read as a plain own data property, so no getter runs.
 * Never throws: a list that can't be walked counts as `"mixed"`.
 */
export function oneOrganization(items: Iterable<unknown>): OrganizationId | "mixed" | undefined {
  try {
    let found: OrganizationId | undefined;
    for (const item of items) {
      const owner = organizationIdOf(item);
      if (owner === undefined) return "mixed";
      if (found === undefined) found = owner;
      else if (owner !== found) return "mixed";
    }
    return found;
  } catch {
    return "mixed";
  }
}

/**
 * An item's own `organizationId`, read as a plain data property, or
 * undefined when it is missing, not an organization ID, a getter, or the
 * item isn't a readable object. Never throws.
 */
export function organizationIdOf(item: unknown): OrganizationId | undefined {
  try {
    if (typeof item !== "object" || item === null || types.isProxy(item)) return undefined;
    const slot = Object.getOwnPropertyDescriptor(item, "organizationId");
    if (slot === undefined || !("value" in slot)) return undefined;
    const owner: unknown = slot.value;
    return isOrganizationId(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The issue a function gives when it is handed data from more than one
 * organization, or data that doesn't say which organization it belongs to.
 */
export function mixedOrganizationsIssue(path: readonly (string | number)[], what: string): Issue {
  return issue(
    path,
    "mixed_organizations",
    `${what} belong to more than one organization, or don't all say which one they belong to. Each organization is kept completely separate, so they can't be used together.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers

interface TopView {
  readonly copy: Readonly<Record<string, JsonValue>>;
  readonly data: Readonly<Record<string, JsonValue | undefined>>;
}

function readTop(input: unknown, notObject: string, issues: IssueList): TopView | undefined {
  if (types.isProxy(input) || !isPlainObject(input)) {
    issues.add([], "not_an_object", notObject);
    return undefined;
  }
  const copy = readPlainData(input, [], LIMITS, issues);
  if (copy === undefined || !isPlainObject(copy)) return undefined;
  // Read only the copy's own properties, never anything inherited.
  const data = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(copy)) data[key] = copy[key];
  return { copy, data };
}

function checkName(
  value: JsonValue | undefined,
  what: string,
  max: number,
  issues: IssueList,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(["name"], "required", `Every ${what} needs a name.`);
    return;
  }
  if (value !== value.trim()) {
    issues.add(["name"], "untrimmed", `The ${what} name starts or ends with spaces.`);
  }
  if (value.length > max) {
    issues.add(["name"], "too_long", `The ${what} name can be at most ${String(max)} characters.`);
  }
  if (ONE_LINE_BREAKS.test(value)) {
    issues.add(
      ["name"],
      "control_characters",
      `The ${what} name must be one line, with no tabs or line breaks.`,
    );
  }
}

function unknownKeys(
  view: Readonly<Record<string, JsonValue | undefined>>,
  allowed: readonly string[],
  what: string,
  issues: IssueList,
): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(view)) {
    if (!ok.has(key)) {
      issues.add([key], "unknown_property", `${shown(key)} is not a property of ${what}.`);
    }
  }
}

function guarded<T>(run: () => Validated<T>, message: string): Validated<T> {
  try {
    return run();
  } catch {
    return { ok: false, issues: [issue([], "unreadable", message)] };
  }
}
