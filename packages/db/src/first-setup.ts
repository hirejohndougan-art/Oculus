/**
 * First-time setup (T-055): everything a new install needs before
 * anyone can sign in, made in one transaction so Oculus can run on one
 * computer without typing SQL. `setUpFirstInstall` makes:
 *
 * - the install's one bootstrap system admin (the same row
 *   `createFirstSystemAdmin` makes; they set up two-step sign-in at their
 *   first sign-in, as every account does, D-052);
 * - the first organization;
 * - its first site;
 * - a starter template, `item` (STARTER_TEMPLATE), that the system admin
 *   can change or replace later;
 * - the starter template's Dublin Core mapping (T-050e, D-096): each public
 *   field goes out as the DCMI term it names in its `standards`, so records
 *   published with it can be shown on a public site, which needs a stored
 *   mapping (D-096 has no fallback).
 *
 * It refuses with `already_set_up` if the database has any user or any
 * organization, so it can't run twice, and two runs at once can't both
 * succeed: the second waits on `users_one_bootstrap` and rolls back whole.
 * Every input is checked before anything is written, and a failure part way
 * leaves nothing behind.
 */
import {
  PasswordWorkBusyError,
  checkNewPassword,
  hashPassword,
  isPlainObject,
  newOrganizationId,
  newSiteId,
  newUserId,
  normalizeEmail,
  validateDisplayName,
  validateOrganization,
  validateSite,
  isDublinCoreTerm,
  validateDublinCoreMapping,
  validateTemplate,
  type DublinCoreEntry,
  type DublinCoreMapping,
  type FieldDefinition,
  type Issue,
  type OrganizationId,
  type SiteId,
  type UserId,
  type Validated,
} from "@oculus/core";
import { contentsOf } from "./backup-catalog.js";
import type { Database } from "./client.js";
import { insertOrganization, insertTemplateVersion } from "./catalog.js";
import { writeDublinCoreMapping } from "./dublin-core-mappings.js";
import { insertSite } from "./permissions.js";
import { inTransaction } from "./sessions.js";
import { sql } from "./sql.js";

/** What `setUpFirstInstall` takes. */
export interface FirstInstall {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly organizationName: string;
  readonly siteName: string;
}

/** What `setUpFirstInstall` made. */
export interface FirstInstallResult {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly siteId: SiteId;
  readonly templateKey: string;
}

/** The starter template's key. */
export const STARTER_TEMPLATE_KEY = "item";

const dc = (element: string) => [
  { standard: "dcterms", element, uri: `http://purl.org/dc/terms/${element}` },
];

/** Visibility is always given: like core, no field is public by default. */
function field(
  key: string,
  label: string,
  kind: FieldDefinition["kind"],
  visibility: FieldDefinition["visibility"],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    key,
    label,
    kind,
    required: false,
    repeatable: false,
    inherited: false,
    ...extra,
    visibility,
  };
}

/**
 * The starter template's fields: a few Dublin Core elements (DCMI Metadata
 * Terms) that suit most objects, photographs and documents, and two
 * staff-only fields that never leave the staff catalog.
 */
export const STARTER_TEMPLATE_FIELDS: readonly FieldDefinition[] = Object.freeze([
  field("description", "Description", "long_text", "public", { standards: dc("description") }),
  field("date", "Date", "date", "public", {
    help: "An exact or approximate date, such as 1909, 1909~ or 1900/1910.",
    standards: dc("date"),
  }),
  field("creator", "Creator", "text", "public", { repeatable: true, standards: dc("creator") }),
  field("subject", "Subject", "text", "public", { repeatable: true, standards: dc("subject") }),
  field("rights", "Rights statement", "rights", "public", {
    help: "A rightsstatements.org or Creative Commons address.",
    standards: dc("rights"),
  }),
  field("location", "Shelf location", "text", "staff"),
  field("staff_notes", "Staff notes", "long_text", "staff"),
]);

/**
 * The starter template's Dublin Core entries: each public field as the DCMI
 * term its `standards` name (`dcterms`). Staff-only fields never appear.
 */
export const STARTER_DUBLIN_CORE_ENTRIES: readonly DublinCoreEntry[] = Object.freeze(
  STARTER_TEMPLATE_FIELDS.flatMap((f) =>
    f.visibility !== "public"
      ? []
      : (f.standards ?? [])
          .filter((s) => s.standard === "dcterms" && isDublinCoreTerm(s.element))
          .map((s) => Object.freeze({ field: f.key, term: s.element }) as DublinCoreEntry),
  ),
);

function refused<T>(code: string, message: string, path: (string | number)[] = []): Validated<T> {
  return { ok: false, issues: [{ path, code, message }] };
}

const ALREADY_SET_UP =
  "This database is already set up: it has people or organizations. Setup only runs on an empty database.";

/** Reads an own data property, never a getter or an inherited one. */
function own(input: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(input, key);
  return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
}

const KEYS = ["email", "displayName", "password", "organizationName", "siteName"] as const;

/**
 * Database-wide settings Oculus's migrations never make, which would copy or
 * open up everything setup then stores (password hashes, sessions,
 * staff-only fields) or run code during the migrations.
 */
const NEVER_OCULUS = ["default_privileges", "publications", "subscriptions", "event_triggers"];

/**
 * What a database is before setup migrates it: `"empty"`, `"set_up"` (Oculus's,
 * with people or organizations) or `"other"` (anything else). Setup migrates
 * only an `"empty"` one, so it never changes a database it then refuses.
 *
 * Without Oculus's migration table, a database is empty only if it is
 * exactly as CREATE DATABASE made it (`contentsOf`, the check restore uses:
 * any schema, relation, function, type, operator, extension, default
 * privilege, publication, event trigger, large object, setting … counts).
 * With it, a database is not Oculus's if it has default privileges,
 * publications, subscriptions or event triggers, or if `users` or
 * `organizations` exist before the migration that makes them was applied.
 */
export async function databaseBeforeSetup(db: Database): Promise<"empty" | "set_up" | "other"> {
  const contents = await contentsOf(db);
  const [row] = await db.rows<{ oculus: boolean; users: boolean; orgs: boolean }>(sql`
    SELECT to_regclass('public.oculus_migrations') IS NOT NULL AS oculus,
           to_regclass('public.users') IS NOT NULL AS users,
           to_regclass('public.organizations') IS NOT NULL AS orgs`);
  if (row === undefined) return "other";
  if (!row.oculus) return Object.keys(contents).length === 0 ? "empty" : "other";
  if (NEVER_OCULUS.some((kind) => (contents[kind] ?? 0) > 0)) return "other";
  const applied = new Set(
    (await db.rows<{ name: string }>(sql`SELECT name FROM public.oculus_migrations`)).map(
      (r) => r.name,
    ),
  );
  if (row.orgs && !applied.has("0002_catalog.sql")) return "other";
  if (row.users && !applied.has("0009_users.sql")) return "other";
  if (row.users && (await db.rows(sql`SELECT 1 FROM public.users LIMIT 1`)).length > 0) {
    return "set_up";
  }
  if (row.orgs && (await db.rows(sql`SELECT 1 FROM public.organizations LIMIT 1`)).length > 0) {
    return "set_up";
  }
  return "empty";
}

/** Whether the database has no users and no organizations. */
export async function isEmptyInstall(db: Database): Promise<boolean> {
  const rows = await db.rows(sql`
    SELECT 1 FROM public.users
    UNION ALL SELECT 1 FROM public.organizations
    LIMIT 1`);
  return rows.length === 0;
}

/** Makes the first system admin, organization, site and starter template. */
export async function setUpFirstInstall(
  db: Database,
  input: unknown,
): Promise<Validated<FirstInstallResult>> {
  // Each answer is read once, into a plain copy; any trap or getter that
  // throws on the way is a malformed request, not an exception.
  let answers: Record<(typeof KEYS)[number], unknown>;
  try {
    if (
      !isPlainObject(input) ||
      !Reflect.ownKeys(input).every((k) => (KEYS as readonly PropertyKey[]).includes(k))
    ) {
      return refused("invalid_request", `Give ${KEYS.join(", ")} only.`);
    }
    answers = {
      email: own(input, "email"),
      displayName: own(input, "displayName"),
      password: own(input, "password"),
      organizationName: own(input, "organizationName"),
      siteName: own(input, "siteName"),
    };
  } catch {
    return refused("invalid_request", `Give ${KEYS.join(", ")} only.`);
  }
  const issues: Issue[] = [];
  const email = normalizeEmail(answers.email);
  if (email === undefined) {
    issues.push({
      path: ["email"],
      code: "invalid_email",
      message: "That isn't an email address Oculus accepts.",
    });
  }
  const displayName = validateDisplayName(answers.displayName);
  if (displayName === undefined) {
    issues.push({
      path: ["displayName"],
      code: "invalid_display_name",
      message: "A name is 1–200 characters, with no line breaks or spaces at either end.",
    });
  }
  const password = checkNewPassword(answers.password, {
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
  });
  if (!password.ok) {
    issues.push(...password.issues.map((i) => ({ ...i, path: ["password", ...i.path] })));
  }
  const organization = validateOrganization({
    id: newOrganizationId(),
    name: answers.organizationName,
  });
  if (!organization.ok) {
    issues.push(
      ...organization.issues.map((i) => ({ ...i, path: ["organizationName", ...i.path.slice(1)] })),
    );
  }
  const site = organization.ok
    ? validateSite(
        { id: newSiteId(), organizationId: organization.value.id, name: answers.siteName },
        [organization.value],
      )
    : undefined;
  if (site !== undefined && !site.ok) {
    issues.push(...site.issues.map((i) => ({ ...i, path: ["siteName", ...i.path.slice(1)] })));
  }
  const template = organization.ok
    ? validateTemplate({
        key: STARTER_TEMPLATE_KEY,
        organizationId: organization.value.id,
        label: "Item",
        description: "A starter template for objects, photographs and documents.",
        appliesTo: ["object", "archival_unit", "digital_asset"],
        fields: STARTER_TEMPLATE_FIELDS,
      })
    : undefined;
  if (template !== undefined && !template.ok) {
    // The starter template is fixed; a refusal here is a bug, not bad input.
    throw new Error("The starter template does not pass validateTemplate.");
  }
  let mapping: DublinCoreMapping | undefined;
  if (template !== undefined) {
    const checked = validateDublinCoreMapping(
      {
        template: STARTER_TEMPLATE_KEY,
        organizationId: template.value.organizationId,
        entries: STARTER_DUBLIN_CORE_ENTRIES,
      },
      template.value,
    );
    // Fixed too: a refusal is a bug.
    if (!checked.ok)
      throw new Error("The starter mapping does not pass validateDublinCoreMapping.");
    mapping = checked.value;
  }
  if (
    issues.length > 0 ||
    email === undefined ||
    displayName === undefined ||
    !password.ok ||
    !organization.ok ||
    site === undefined ||
    !site.ok ||
    template === undefined ||
    mapping === undefined
  ) {
    return { ok: false, issues };
  }
  // Checked before the password work too, so a second run answers at once.
  if (!(await isEmptyInstall(db))) return refused("already_set_up", ALREADY_SET_UP);
  let hash: string;
  try {
    hash = await hashPassword(password.value);
  } catch (error) {
    if (error instanceof PasswordWorkBusyError) {
      return refused("busy", "Oculus is busy checking passwords. Try again in a moment.");
    }
    throw error;
  }
  const userId = newUserId();
  const organizationId = organization.value.id;
  try {
    await inTransaction(db, async (tx) => {
      const any = await tx.rows(sql`
        SELECT 1 FROM public.users
        UNION ALL SELECT 1 FROM public.organizations
        LIMIT 1`);
      if (any.length > 0) throw new AlreadySetUp();
      await tx.execute(sql`
        INSERT INTO public.users (id, email, display_name, password_hash, system_admin, bootstrap)
        VALUES (${userId}::uuid, ${email}, ${displayName}, ${hash}, true, true)`);
      must(await insertOrganization(tx, organization.value));
      must(await insertSite(tx, site.value));
      must(await insertTemplateVersion(tx, template.value));
      // Setup runs after every migration (setup-cli, the desktop helper), so
      // the table is there. A database at a schema from before migration
      // 0022 (as the launcher's own update test makes) gets no mapping, as
      // the setup of that time made none.
      const [table] = await tx.rows<{ present: boolean }>(sql`
        SELECT to_regclass('public.dublin_core_mappings') IS NOT NULL AS present`);
      if (table?.present === true) must(await writeDublinCoreMapping(tx, mapping, 0, userId));
    });
  } catch (error) {
    if (error instanceof AlreadySetUp || sqlState(error) === "23505") {
      return refused("already_set_up", ALREADY_SET_UP);
    }
    throw error;
  }
  return {
    ok: true,
    value: { userId, organizationId, siteId: site.value.id, templateKey: STARTER_TEMPLATE_KEY },
  };
}

class AlreadySetUp extends Error {}

/** Every value here was checked above; a refusal now is a bug, so roll back. */
function must(result: Validated<unknown>): void {
  if (!result.ok) throw new Error("First-time setup: a checked value was refused.");
}

function sqlState(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? own(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}
