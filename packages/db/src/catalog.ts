/**
 * Typed reads and writes for the catalog tables of `0002_catalog.sql`
 * (T-025, D-060): organizations, templates, record types and records.
 *
 * Every value goes in and comes out through `@oculus/core`'s validators:
 * - an insert validates its input first and stores the validated copy, or
 *   returns the issues and touches nothing;
 * - a read rebuilds the core value from the row and validates it again, so a
 *   row changed behind the application's back (by hand, by a bad migration)
 *   comes out as issues, never as a typed value it isn't.
 *
 * Every read names the organization (D-019, D-030): a record, template or
 * record type is looked up by its organization and its own ID or key, so
 * asking for another organization's row finds nothing. The tables' foreign
 * keys all include `organization_id`, so a write can't point across either,
 * and triggers keep every row's organization, ID, key and version fixed.
 *
 * Every record write stores the record's next version with it, in one
 * savepoint (`insertRecord`, `updateRecord`; `record-versions.ts`, D-063):
 * the database refuses a record write without its version at COMMIT.
 *
 * What is left to the service layer (T-032): which organization a session may
 * use, making record IDs, transactions spanning several writes, checking a
 * record's fields against its template (that needs the organization's
 * identifier types and records, `checkRecordAgainstTemplate`), links inside
 * `fields` naming records of the same organization (the organization's
 * `makeRecordLinkChecker`; JSON has no foreign key), refusing to delete a
 * record others link to, a record type of the record's kind
 * (`checkRecordType`), and cycles in the arrangement (`validateArrangement`).
 *
 * Database errors (a foreign key or check refusing a row, a lost connection)
 * are thrown as `pg` reports them. Their text names tables, constraints and
 * values: the service layer turns them into its own messages and never shows
 * a person the raw text.
 */
import {
  MAX_ARRANGEMENT_DEPTH,
  issue,
  isOrganizationId,
  isRecordId,
  isTemplateKey,
  indexTemplates,
  validateOrganization,
  validateRecord,
  validateRecordType,
  validateTemplate,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type Organization,
  type OrganizationId,
  type SiteId,
  type RecordChangeKind,
  type RecordId,
  type RecordType,
  type Validated,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import {
  compareVersions,
  validateRecordChange,
  writeVersion,
  type RecordChange,
  type RecordVersion,
} from "./record-versions.js";
import { sql } from "./sql.js";

/** A template as stored: the validated template and its version number. */
export interface StoredTemplate {
  readonly version: number;
  readonly template: FieldTemplate;
}

/** A record type as stored: the validated type and its version number. */
export interface StoredRecordType {
  readonly version: number;
  readonly recordType: RecordType;
}

function refused<T>(path: readonly string[], code: string, message: string): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

const BAD_ORGANIZATION = "The organization ID must be a lowercase version 4 UUID.";

// ---------------------------------------------------------------------------
// Organizations

/** Stores a new organization. */
export async function insertOrganization(
  db: Queryable,
  input: unknown,
): Promise<Validated<Organization>> {
  const valid = validateOrganization(input);
  if (!valid.ok) return valid;
  const { id, name } = valid.value;
  await db.execute(sql`INSERT INTO public.organizations (id, name) VALUES (${id}::uuid, ${name})`);
  return valid;
}

/** The organization with this ID, or `undefined` if there is none. */
export async function readOrganization(
  db: Queryable,
  id: OrganizationId,
): Promise<Validated<Organization> | undefined> {
  if (!isOrganizationId(id)) return refused(["id"], "invalid_id", BAD_ORGANIZATION);
  const [row] = await db.rows<{ id: string; name: string }>(
    sql`SELECT id::text AS id, name FROM public.organizations WHERE id = ${id}::uuid`,
  );
  return row === undefined ? undefined : validateOrganization({ id: row.id, name: row.name });
}

// ---------------------------------------------------------------------------
// Templates

/**
 * Stores a template as its organization's next version of that key (version
 * 1 for a new key). One statement: the key's row in `templates` is made if
 * missing, and the version is one more than the highest stored. Two saves of
 * one key at the same moment can't both get the same version: the second
 * fails on the primary key.
 */
export async function insertTemplateVersion(
  db: Queryable,
  input: unknown,
): Promise<Validated<StoredTemplate>> {
  const valid = validateTemplate(input);
  if (!valid.ok) return valid;
  const template = valid.value;
  const org = template.organizationId;
  const [row] = await db.rows<{ version: number }>(sql`
    WITH identity AS (
      INSERT INTO public.templates (organization_id, key)
      VALUES (${org}::uuid, ${template.key})
      ON CONFLICT (organization_id, key) DO NOTHING
    )
    INSERT INTO public.template_versions (organization_id, key, version, definition)
    SELECT ${org}::uuid, ${template.key}, coalesce(max(version), 0) + 1, ${JSON.stringify(template)}::jsonb
    FROM public.template_versions
    WHERE organization_id = ${org}::uuid AND key = ${template.key}
    RETURNING version`);
  if (row === undefined) throw new Error("The template version was not stored.");
  return { ok: true, value: Object.freeze({ version: row.version, template }) };
}

/**
 * The organization's template with this key: its current (highest) version,
 * or the given one. `undefined` if there is none.
 */
export async function readTemplate(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
  version?: number,
): Promise<Validated<StoredTemplate> | undefined> {
  const bad = checkKeyAndVersion<StoredTemplate>(organizationId, key, version);
  if (bad) return bad;
  const [row] = await db.rows<{ version: number; definition: unknown }>(sql`
    SELECT version, definition FROM public.template_versions
    WHERE organization_id = ${organizationId}::uuid AND key = ${key}
      AND (${version ?? null}::integer IS NULL OR version = ${version ?? null}::integer)
    ORDER BY version DESC
    LIMIT 1`);
  if (row === undefined) return undefined;
  return storedTemplate(row.version, row.definition, organizationId, key);
}

/** A stored template row, checked (also for the public snapshot, S-019; not exported from `@oculus/db`). */
export function storedTemplate(
  version: number,
  definition: unknown,
  organizationId: OrganizationId,
  key: string,
): Validated<StoredTemplate> {
  const valid = validateTemplate(definition);
  if (!valid.ok) return valid;
  // The table's checks already tie the JSON to its row; this is the second line.
  if (valid.value.organizationId !== organizationId || valid.value.key !== key) {
    return refused([], "row_mismatch", "The stored template doesn't match its row.");
  }
  return { ok: true, value: Object.freeze({ version, template: valid.value }) };
}

// ---------------------------------------------------------------------------
// Record types

/**
 * Stores a record type as its organization's next version of that key, as
 * `insertTemplateVersion` does. The type is checked against the current
 * version of its default template as stored (`validateRecordType`: the
 * template exists in the type's organization and applies to the type's kind),
 * never against a template the caller holds, which may be stale or made up.
 * The insert then happens only if that version is still the current one, in
 * the same statement; if another version was saved in between, nothing is
 * stored and the issue is `template_changed` (read and try again).
 */
export async function insertRecordTypeVersion(
  db: Queryable,
  input: unknown,
): Promise<Validated<StoredRecordType>> {
  const org = ownString(input, "organizationId");
  const templateKey = ownString(input, "defaultTemplateKey");
  if (org === undefined || !isOrganizationId(org) || templateKey === undefined) {
    // validateRecordType says what is wrong with the type itself.
    return withoutTemplate(input);
  }
  const [current] = isTemplateKey(templateKey)
    ? await db.rows<{ version: number; definition: unknown }>(sql`
        SELECT version, definition FROM public.template_versions
        WHERE organization_id = ${org}::uuid AND key = ${templateKey}
        ORDER BY version DESC
        LIMIT 1`)
    : [];
  if (current === undefined) return withoutTemplate(input);
  const template = storedTemplate(current.version, current.definition, org, templateKey);
  if (!template.ok) return template;
  const valid = validateRecordType(input, template.value.template);
  if (!valid.ok) return valid;
  const type = valid.value;
  const [row] = await db.rows<{ version: number }>(sql`
    WITH still_current AS (
      SELECT 1 FROM public.template_versions
      WHERE organization_id = ${org}::uuid AND key = ${templateKey}
      HAVING max(version) = ${current.version}::integer
        AND bool_or(version = ${current.version}::integer
                    AND definition = ${JSON.stringify(current.definition)}::jsonb)
    ), identity AS (
      INSERT INTO public.record_types (organization_id, key)
      SELECT ${org}::uuid, ${type.key} FROM still_current
      ON CONFLICT (organization_id, key) DO NOTHING
    )
    INSERT INTO public.record_type_versions
      (organization_id, key, version, kind, default_template_key, definition)
    SELECT ${org}::uuid, ${type.key}, coalesce(max(version), 0) + 1, ${type.kind},
           ${type.defaultTemplateKey}, ${JSON.stringify(type)}::jsonb
    FROM public.record_type_versions
    WHERE organization_id = ${org}::uuid AND key = ${type.key}
    HAVING EXISTS (SELECT 1 FROM still_current)
    RETURNING version`);
  if (row === undefined) {
    return refused(
      ["defaultTemplateKey"],
      "template_changed",
      "The default template changed while the record type was being saved. Try again.",
    );
  }
  return { ok: true, value: Object.freeze({ version: row.version, recordType: type }) };
}

/**
 * The issues of a record type whose default template can't be read: its own
 * problems, and `unknown_template`.
 */
function withoutTemplate(input: unknown): Validated<StoredRecordType> {
  const result = validateRecordType(input, NO_TEMPLATES);
  return result.ok
    ? refused(["defaultTemplateKey"], "unknown_template", "There is no such template.")
    : result;
}

/** No templates: what `validateRecordType` gets when none can be read. */
const NO_TEMPLATES = (() => {
  const registry = indexTemplates([]);
  if (!registry.ok) throw new Error("An empty template registry was refused.");
  return registry.value;
})();

/** An own data property that is a string, never through a getter. */
function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot && typeof slot.value === "string"
      ? slot.value
      : undefined;
  } catch {
    // A proxy's trap threw; validateRecordType reports the value as unreadable.
    return undefined;
  }
}

/**
 * The organization's record type with this key (its current version, or the
 * given one), checked against the current version of its default template.
 * A type whose default template no longer fits (deleted from its kinds, say)
 * comes back as issues; `recordTypeTemplateIssues` explains them.
 * `undefined` if there is no such type.
 */
export async function readRecordType(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
  version?: number,
): Promise<Validated<StoredRecordType> | undefined> {
  const bad = checkKeyAndVersion<StoredRecordType>(organizationId, key, version);
  if (bad) return bad;
  const [row] = await db.rows<{
    version: number;
    definition: unknown;
    default_template_key: string;
    template_version: number | null;
    template: unknown;
  }>(sql`
    SELECT v.version, v.definition, v.default_template_key,
           t.version AS template_version, t.definition AS template
    FROM public.record_type_versions v
    LEFT JOIN LATERAL (
      SELECT tv.version, tv.definition FROM public.template_versions tv
      WHERE tv.organization_id = v.organization_id AND tv.key = v.default_template_key
      ORDER BY tv.version DESC
      LIMIT 1
    ) t ON true
    WHERE v.organization_id = ${organizationId}::uuid AND v.key = ${key}
      AND (${version ?? null}::integer IS NULL OR v.version = ${version ?? null}::integer)
    ORDER BY v.version DESC
    LIMIT 1`);
  if (row === undefined) return undefined;
  if (row.template_version === null) {
    return refused(["defaultTemplateKey"], "unknown_template", "Its default template is gone.");
  }
  // The table ties default_template_key to the JSON's defaultTemplateKey.
  const template = storedTemplate(
    row.template_version,
    row.template,
    organizationId,
    row.default_template_key,
  );
  if (!template.ok) return template;
  const valid = validateRecordType(row.definition, template.value.template);
  if (!valid.ok) return valid;
  if (valid.value.organizationId !== organizationId || valid.value.key !== key) {
    return refused([], "row_mismatch", "The stored record type doesn't match its row.");
  }
  return { ok: true, value: Object.freeze({ version: row.version, recordType: valid.value }) };
}

function checkKeyAndVersion<T>(
  organizationId: OrganizationId,
  key: string,
  version: number | undefined,
): Validated<T> | undefined {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isTemplateKey(key)) {
    return refused(["key"], "invalid_key", "That is not a template or record type key.");
  }
  if (
    version !== undefined &&
    (!Number.isInteger(version) || version < 1 || version > 2 ** 31 - 1)
  ) {
    return refused(["version"], "invalid_version", "A version is a whole number from 1.");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Records

/** A row of `public.records` as `readRecord` selects it. */
export interface RecordRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  kind: string;
  template_key: string;
  record_type_key: string | null;
  title: string;
  level: string | null;
  parent_id: string | null;
  media_type: string | null;
  represents_id: string | null;
  agent_type: string | null;
  latitude: number | null;
  longitude: number | null;
  fields: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * A record as stored now: the validated record and its version number. Its
 * workflow state is read with `readWorkflowState` (`workflow.ts`).
 */
export interface StoredRecord {
  readonly version: number;
  readonly record: CatalogRecord;
}

/** What `updateRecord` needs beyond the record: the version the edit started from, who and why. */
export interface RecordUpdate extends RecordChange {
  /**
   * The version the person's edit started from (`readStoredRecord`, or the
   * last version written). If the record has been written since, nothing is
   * stored and the issue is `version_conflict`, with what changed since in
   * the result's `conflict` (T-031).
   */
  readonly expectedVersion: number;
}

/** One thing someone else changed: its name and how, never its values. */
export interface ChangedName {
  /** `title`, `parentId`, `fields.<key>` …, as `RecordVersion.changedFields` names it. */
  readonly name: string;
  readonly change: RecordChangeKind;
}

/**
 * Why an update was refused as `version_conflict` (T-031, D-065): the record
 * was saved by someone else since the version the edit started from, and
 * this is what they changed, so the editor can show it and the person can
 * redo their edit on the record as it now is.
 *
 * **Names only, never values.** Anyone who can submit an edit gets a
 * conflict, including with a made-up `expectedVersion`, so it must not
 * become a way to read old versions: the values of what changed (staff
 * fields, values since removed) come only from an explicit
 * `compareVersions` call, which the service layer (T-041, T-043) guards
 * with the permission to read the record's history.
 */
export interface VersionConflict {
  /** The version the edit started from. */
  readonly expectedVersion: number;
  /** The record's version now. */
  readonly currentVersion: number;
  /**
   * What changed from `expectedVersion` to `currentVersion`, by name and
   * kind of change, sorted by name. Absent when it can't be worked out:
   * the expected version is later than the current one (never stored), or a
   * stored version no longer validates.
   */
  readonly differences?: readonly ChangedName[];
}

/** What `updateRecord` returns: the new version, or the issues (and, for `version_conflict`, the conflict). */
export type RecordUpdateResult =
  | { readonly ok: true; readonly value: RecordVersion }
  | {
      readonly ok: false;
      readonly issues: readonly Issue[];
      /** Set when the refusal is `version_conflict` and the record still exists. */
      readonly conflict?: VersionConflict;
    };

const DEADLOCK = "40P01";
const SERIALIZATION = "40001";
const NO_TRANSACTION = "25P01";

/** The SQLSTATE of a database error, if it is one. */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** The constraint a database error names, if any. */
function constraintOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { constraint } = error as { constraint?: unknown };
  return typeof constraint === "string" ? constraint : undefined;
}

const ID_USED_BEFORE =
  "This record ID was used before (by a record since deleted) and can't be used again.";

/**
 * The version triggers' refusals (D-063) that a racing or out-of-step write
 * can meet, as clean issues; anything else is thrown. For an insert, a
 * version number already taken means the ID has history (`id_used_before`);
 * only an update can be out of step with its versions (`version_conflict`).
 */
function versionRefusal<T>(
  error: unknown,
  write: "insert" | "update" | "restore" | "delete" | "workflow",
): Validated<T> | undefined {
  const state = sqlState(error);
  if (state === FOREIGN_KEY && write === "delete") {
    // A row pointing at the record (a unit filed under it, a scan of it, a
    // number it holds) committed between the checks and the DELETE.
    return refused(
      ["recordId"],
      "in_use",
      "Something else points at this record now (a unit filed under it, a scan of it or a number it holds). Read it again.",
    );
  }
  if (state === NOT_READ_COMMITTED) {
    return refused(
      [],
      "read_committed_required",
      "Record writes that change the arrangement must run in a Read Committed transaction.",
    );
  }
  if (state === FOREIGN_KEY && write === "restore") {
    // Something the restored version points at was deleted between the
    // checks and the write.
    return refused(
      [],
      "missing_reference",
      "A record, template or record type this version points at was removed while it was being restored. Read it again.",
    );
  }
  if (state !== INTEGRITY) return undefined;
  const constraint = constraintOf(error);
  switch (constraint) {
    case "records_arrangement_loop":
      return refused(["parentId"], "loop", "An archival unit can't be filed inside itself.");
    case "records_arrangement_too_deep":
      return refused(
        ["parentId"],
        "too_deep",
        `An archival unit can be at most ${String(MAX_ARRANGEMENT_DEPTH)} levels deep.`,
      );
    default:
      break;
  }
  if (write === "insert") {
    return constraint === "records_id_used_before" || constraint === "record_versions_next_number"
      ? refused(["id"], "id_used_before", ID_USED_BEFORE)
      : undefined;
  }
  switch (constraint) {
    case "records_version_step":
    case "record_versions_next_number":
    case "record_versions_with_record_write":
      return refused(
        ["expectedVersion"],
        "version_conflict",
        "The record's stored versions are not where this write expected them. Read it again.",
      );
    case "records_kind_fixed":
      return refused(["kind"], "kind_changed", KIND_FIXED);
    case "records_updated_at_backwards":
      return refused(["updatedAt"], "updated_before", UPDATED_BEFORE);
    case "record_versions_workflow_move":
      return refused(
        ["workflowState"],
        "workflow_move",
        "The record's workflow state can't change this way. Read it again.",
      );
    case "record_versions_delete_published":
      return refused(
        ["recordId"],
        "published",
        "This record is published. Unpublish it before deleting it.",
      );
    default:
      return undefined;
  }
}

const INTEGRITY = "23000";
const FOREIGN_KEY = "23503";
const NOT_READ_COMMITTED = "OC061";
const KIND_FIXED = "A record's kind never changes; make a new record instead.";
const UPDATED_BEFORE = "updatedAt can't be earlier than the stored record's.";

/**
 * Runs `work` inside a savepoint of the caller's transaction, as
 * `identifiers.ts` and `vocabularies.ts` do: if it throws, everything it did
 * (the record row and its version alike) is rolled back to the savepoint and
 * the caller's transaction stays usable. A deadlock or serialization failure
 * is returned as `retry`; any other error is thrown after the rollback.
 * @internal Also used by `restoreVersion` and `deleteRecord` (savepoints nest).
 */
export async function inSavepoint<T>(
  db: Queryable,
  write: "insert" | "update" | "restore" | "delete" | "workflow",
  work: () => Promise<Validated<T>>,
): Promise<Validated<T>> {
  try {
    await db.execute(sql`SAVEPOINT oculus_catalog`);
  } catch (error) {
    if (sqlState(error) === NO_TRANSACTION) {
      throw new Error("Record writes must run inside a transaction (Database.transaction).", {
        cause: error,
      });
    }
    throw error;
  }
  let result: Validated<T>;
  try {
    result = await work();
    if (!result.ok) {
      // A refusal found inside: nothing of it stays.
      await db.execute(sql`ROLLBACK TO SAVEPOINT oculus_catalog`);
    }
    await db.execute(sql`RELEASE SAVEPOINT oculus_catalog`);
    return result;
  } catch (error) {
    try {
      await db.execute(sql`ROLLBACK TO SAVEPOINT oculus_catalog`);
      await db.execute(sql`RELEASE SAVEPOINT oculus_catalog`);
    } catch {
      throw new Error("Rolling back a record write failed.", { cause: error });
    }
    const code = sqlState(error);
    if (code === DEADLOCK || code === SERIALIZATION) {
      return refused(
        [],
        "retry",
        "Another change to this record ran at the same time. Roll back the transaction and try it again.",
      );
    }
    const clean = versionRefusal<T>(error, write);
    if (clean) return clean;
    throw error;
  }
}

/** The kind-specific columns of a validated record. */
function columnsOf(r: CatalogRecord) {
  const coordinates = r.kind === "place" ? r.coordinates : undefined;
  return {
    level: r.kind === "archival_unit" ? r.level : null,
    parentId: r.kind === "archival_unit" ? (r.parentId ?? null) : null,
    mediaType: r.kind === "digital_asset" ? r.mediaType : null,
    represents: r.kind === "digital_asset" ? (r.represents ?? null) : null,
    agentType: r.kind === "agent" ? r.agentType : null,
    lat: coordinates?.lat ?? null,
    lng: coordinates?.lng ?? null,
  };
}

const NO_TEMPLATE_KEY = "Every stored record names its template (templateKey).";

/**
 * Stores a new record and its version 1 (T-029, D-063), together: both or
 * neither. It must name its template (`templateKey`): every stored record
 * does (D-029), so a keyless one is refused here (`no_template_key`) before
 * the database would. `change` says who made it and, optionally, why
 * (`validateRecordChange`).
 *
 * **Callers must check the record first** with `checkRecordAgainstTemplate`,
 * giving it the organization's templates, identifier checker and record link
 * checker (`makeRecordLinkChecker` over the organization's own records). This
 * function checks the record's shape only: the database can't see inside
 * `fields`, so a `record_link` value naming another organization's record,
 * or a record that doesn't exist, would be stored as given. That check is the
 * service layer's (T-032).
 *
 * The ID is unique within the organization only (the table's key is
 * `(organization_id, id)`); one the organization already has is refused by
 * the primary key; a deleted record's ID (one with history) is refused as
 * `id_used_before`, since it is never used again. Runs in a savepoint of the caller's transaction (outside
 * one it throws); a database error is thrown after the savepoint is rolled
 * back, so no row and no version stays.
 */
export async function insertRecord(
  db: Queryable,
  input: unknown,
  change: RecordChange,
): Promise<Validated<CatalogRecord>> {
  const who = validateRecordChange(change);
  if (!who.ok) return { ok: false, issues: who.issues.map(underChange) };
  const valid = validateRecord(input);
  if (!valid.ok) return valid;
  const r = valid.value;
  if (r.templateKey === undefined) {
    return refused(["templateKey"], "no_template_key", NO_TEMPLATE_KEY);
  }
  const c = columnsOf(r);
  return inSavepoint(db, "insert", async (): Promise<Validated<CatalogRecord>> => {
    // A deleted record's ID has history and is never used again (the
    // trigger refuses it too, records_id_used_before).
    const [used] = await db.rows(sql`
      SELECT 1 FROM public.record_versions
      WHERE organization_id = ${r.organizationId}::uuid AND record_id = ${r.id}::uuid
        AND NOT EXISTS (SELECT 1 FROM public.records
                        WHERE organization_id = ${r.organizationId}::uuid AND id = ${r.id}::uuid)
      LIMIT 1`);
    if (used !== undefined) return refused(["id"], "id_used_before", ID_USED_BEFORE);
    await db.execute(sql`
      INSERT INTO public.records (
        id, organization_id, site_id, kind, template_key, record_type_key, title,
        level, parent_id, media_type, represents_id, agent_type, latitude, longitude,
        fields, created_at, updated_at, version
      ) VALUES (
        ${r.id}::uuid, ${r.organizationId}::uuid, ${r.siteId ?? null}::uuid, ${r.kind}, ${r.templateKey},
        ${r.recordTypeKey ?? null}, ${r.title},
        ${c.level}, ${c.parentId}::uuid, ${c.mediaType}, ${c.represents}::uuid, ${c.agentType},
        ${c.lat}::double precision, ${c.lng}::double precision,
        ${JSON.stringify(r.fields)}::jsonb, ${r.createdAt}::timestamptz, ${r.updatedAt}::timestamptz,
        1
      )`);
    await writeVersion(db, r, 1, who.value);
    return valid;
  });
}

/**
 * Replaces a stored record with `input` and stores it as the record's next
 * version, together: both or neither (T-029, D-063). The record is found by
 * its organization and ID, which never change; its `createdAt` must be the
 * stored one (`created_at_changed`), its kind never changes (`kind_changed`,
 * also refused by the database) and its `updatedAt` can't be earlier than
 * the stored one (`updated_before`; history is ordered by version number and
 * the database's `recordedAt`, never by `updatedAt`). Its template may change
 * here, and only here: callers check the record against the new template
 * first, as for any save. Refused, storing nothing:
 * `unknown_record`; `version_conflict` when the record is no longer at
 * `expectedVersion` (someone saved since: read it again), with `conflict`
 * saying what they changed (T-031, `VersionConflict`); `retry` on a
 * deadlock or serialization failure. Of two updates from the same version at
 * the same moment, the second waits for the first and is then refused with
 * `version_conflict`, so neither overwrites the other unseen.
 *
 * As for `insertRecord`, callers check the record against its template first
 * (T-032). Runs in a savepoint of the caller's transaction.
 *
 * **The organization is the input record's own `organizationId`**, trusted
 * as given: this function can't know who is asking. The service layer
 * (T-032) must set it from the signed-in session (D-019), never from the
 * request, before calling, or a request naming another organization's
 * record ID would edit, or learn the version history size of, that record.
 */
export async function updateRecord(
  db: Queryable,
  input: unknown,
  update: RecordUpdate,
): Promise<RecordUpdateResult> {
  const expected = ownValue(update, "expectedVersion");
  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    expected >= 2 ** 31 - 1
  ) {
    return refused(
      ["expectedVersion"],
      "invalid_version",
      "Name the version the edit started from: a whole number from 1.",
    );
  }
  const extra = ownKeysBeyond(update, UPDATE_KEYS);
  if (extra !== undefined) {
    return refused(
      ["change", extra],
      "unknown_property",
      "An update has only expectedVersion, actor and reason.",
    );
  }
  const changeInput: Record<string, unknown> = { actor: ownValue(update, "actor") };
  const reason = ownValue(update, "reason");
  if (reason !== undefined) changeInput.reason = reason;
  const who = validateRecordChange(changeInput);
  if (!who.ok) return { ok: false, issues: who.issues.map(underChange) };
  const valid = validateRecord(input);
  if (!valid.ok) return valid;
  const r = valid.value;
  if (r.templateKey === undefined) {
    return refused(["templateKey"], "no_template_key", NO_TEMPLATE_KEY);
  }
  const c = columnsOf(r);
  const result = await inSavepoint(db, "update", async (): Promise<Validated<RecordVersion>> => {
    const [row] = await db.rows<{ version: number }>(sql`
      UPDATE public.records SET
        site_id = ${r.siteId ?? null}::uuid,
        kind = ${r.kind}, template_key = ${r.templateKey}, record_type_key = ${r.recordTypeKey ?? null},
        title = ${r.title}, level = ${c.level}, parent_id = ${c.parentId}::uuid,
        media_type = ${c.mediaType}, represents_id = ${c.represents}::uuid,
        agent_type = ${c.agentType}, latitude = ${c.lat}::double precision,
        longitude = ${c.lng}::double precision, fields = ${JSON.stringify(r.fields)}::jsonb,
        updated_at = ${r.updatedAt}::timestamptz, version = version + 1
      WHERE organization_id = ${r.organizationId}::uuid AND id = ${r.id}::uuid
        AND version = ${expected}::integer AND created_at = ${r.createdAt}::timestamptz
        AND kind = ${r.kind} AND updated_at <= ${r.updatedAt}::timestamptz
      RETURNING version`);
    if (row === undefined) {
      const [current] = await db.rows<{
        version: number;
        created: boolean;
        kind: string;
        forward: boolean;
      }>(sql`
        SELECT version, created_at = ${r.createdAt}::timestamptz AS created, kind,
               updated_at <= ${r.updatedAt}::timestamptz AS forward
        FROM public.records
        WHERE organization_id = ${r.organizationId}::uuid AND id = ${r.id}::uuid`);
      if (current === undefined) {
        return refused(["id"], "unknown_record", "The organization has no such record.");
      }
      if (current.version !== expected) {
        return refused(
          ["expectedVersion"],
          "version_conflict",
          `The record was saved by someone else since version ${String(expected)}; it is now at version ${String(current.version)}. Read it again.`,
        );
      }
      if (!current.created) {
        return refused(["createdAt"], "created_at_changed", "A record's createdAt never changes.");
      }
      if (current.kind !== r.kind) return refused(["kind"], "kind_changed", KIND_FIXED);
      if (!current.forward) return refused(["updatedAt"], "updated_before", UPDATED_BEFORE);
      // Every condition holds now: the record changed between the two
      // statements (a write that committed in between).
      return refused(
        ["expectedVersion"],
        "version_conflict",
        "The record changed while it was being saved. Read it again.",
      );
    }
    return { ok: true, value: await writeVersion(db, r, row.version, who.value) };
  });
  if (result.ok || !result.issues.some((i) => i.code === "version_conflict")) return result;
  const conflict = await versionConflict(db, r.organizationId, r.id, expected);
  return conflict === undefined ? result : { ...result, conflict };
}

/**
 * What changed in the organization's record since `expectedVersion`, the
 * version an edit started from (T-031): read after the refusal, in the
 * caller's transaction, so it shows the record as it is now (committed by
 * others, or written earlier in this transaction). `undefined` if the record
 * no longer exists.
 * @internal Also used by `restoreVersion`.
 */
export async function versionConflict(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  expectedVersion: number,
): Promise<VersionConflict | undefined> {
  const [current] = await db.rows<{ version: number }>(sql`
    SELECT version FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  if (current === undefined) return undefined;
  const base = { expectedVersion, currentVersion: current.version };
  if (current.version <= expectedVersion) return Object.freeze(base);
  const compared = await compareVersions(
    db,
    organizationId,
    recordId,
    expectedVersion,
    current.version,
  );
  if (!compared.ok) return Object.freeze(base);
  // Names and kinds only, never values (VersionConflict).
  const differences = compared.value.differences.map(({ name, change }) =>
    Object.freeze({ name, change }),
  );
  return Object.freeze({ ...base, differences: Object.freeze(differences) });
}

/** An issue of the change (who and why), under `change` in the path. */
function underChange(i: Issue): Issue {
  return issue(["change", ...i.path], i.code, i.message);
}

const UPDATE_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "actor", "reason"]);

/** The first own key not in `allowed` (or one that can't be read), if any. */
function ownKeysBeyond(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const key = Reflect.ownKeys(value).find((k) => typeof k !== "string" || !allowed.has(k));
    return key === undefined ? undefined : String(key);
  } catch {
    return "(unreadable)";
  }
}

/** An own data property, never through a getter or a proxy's trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The organization's record with this ID, validated, or `undefined` if the
 * organization has no such record (including when another organization has).
 */
export async function readRecord(
  db: Queryable,
  organizationId: OrganizationId,
  id: RecordId,
): Promise<Validated<CatalogRecord> | undefined> {
  const stored = await readStoredRecord(db, organizationId, id);
  if (!stored?.ok) return stored;
  return { ok: true, value: stored.value.record };
}

/**
 * As `readRecord`, with the record's current version number: what an edit
 * starts from and passes to `updateRecord` as `expectedVersion`.
 */
export async function readStoredRecord(
  db: Queryable,
  organizationId: OrganizationId,
  id: RecordId,
): Promise<Validated<StoredRecord> | undefined> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isRecordId(id)) {
    return refused(["id"], "invalid_id", "The record ID must be a lowercase version 4 UUID.");
  }
  const [row] = await db.rows<RecordRow & { version: number }>(sql`
    SELECT id::text AS id, organization_id::text AS organization_id, site_id::text AS site_id,
           kind, template_key,
           record_type_key, title, level, parent_id::text AS parent_id, media_type,
           represents_id::text AS represents_id, agent_type, latitude, longitude, fields,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
           version
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid`);
  if (row === undefined) return undefined;
  const valid = validateRecord(recordFromRow(row));
  if (!valid.ok) return valid;
  if (valid.value.organizationId !== organizationId || valid.value.id !== id) {
    return refused([], "row_mismatch", "The stored record doesn't match its row.");
  }
  return { ok: true, value: Object.freeze({ version: row.version, record: valid.value }) };
}

/**
 * @internal The organization's records with these IDs, as the core values
 * their rows hold, **not validated** (`makeRecordLinkChecker` marks an
 * invalid one unusable). IDs it doesn't have (or another organization has)
 * are left out. For `restoreVersion`'s checks.
 */
export async function readRecordsForChecks(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const rows = await db.rows<RecordRow>(sql`
    SELECT id::text AS id, organization_id::text AS organization_id, site_id::text AS site_id,
           kind, template_key,
           record_type_key, title, level, parent_id::text AS parent_id, media_type,
           represents_id::text AS represents_id, agent_type, latitude, longitude, fields,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ANY(${[...ids]}::uuid[])`);
  return rows.map(recordFromRow);
}

/** At most this many records are read for one record's publish check or public output. */
export const MAX_CLOSURE_RECORDS = 10_000;

/**
 * @internal The organization's records with these IDs and everything above
 * them: each one's parent (an archival unit's) and represented record (a
 * digital asset's), and theirs, and so on, as the core values their rows
 * hold, **not validated**. One statement, so from one moment. IDs it doesn't
 * have (or another organization has) are left out. `undefined` when there
 * are more than `MAX_CLOSURE_RECORDS`. For the publish check and the public
 * output (D-076), which need a record's ancestry, what it represents and
 * the records it links to with theirs, never the whole catalog.
 */
export async function readRecordClosure(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
): Promise<Record<string, unknown>[] | undefined> {
  if (ids.length === 0) return [];
  const rows = await db.rows<RecordRow>(sql`
    WITH RECURSIVE up(id) AS (
      SELECT unnest(${[...ids]}::uuid[])
      UNION
      SELECT next.id
      FROM up
      JOIN public.records r ON r.organization_id = ${organizationId}::uuid AND r.id = up.id
      CROSS JOIN LATERAL unnest(ARRAY[r.parent_id, r.represents_id]) AS next(id)
      WHERE next.id IS NOT NULL
    )
    SELECT r.id::text AS id, r.organization_id::text AS organization_id,
           r.site_id::text AS site_id, r.kind, r.template_key,
           r.record_type_key, r.title, r.level, r.parent_id::text AS parent_id, r.media_type,
           r.represents_id::text AS represents_id, r.agent_type, r.latitude, r.longitude, r.fields,
           to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid AND r.id IN (SELECT id FROM up)
    ORDER BY r.id
    LIMIT ${MAX_CLOSURE_RECORDS + 1}`);
  if (rows.length > MAX_CLOSURE_RECORDS) return undefined;
  return rows.map(recordFromRow);
}

/**
 * The core record a row holds. Optional columns become properties only when
 * set, so `validateRecord` refuses a row whose columns don't fit its kind.
 * Also for the public snapshot's rows (workflow.ts, S-019); not exported
 * from `@oculus/db`.
 */
export function recordFromRow(row: RecordRow): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    title: row.title,
    templateKey: row.template_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fields: row.fields,
  };
  if (row.site_id !== null) record.siteId = row.site_id;
  if (row.record_type_key !== null) record.recordTypeKey = row.record_type_key;
  if (row.level !== null) record.level = row.level;
  if (row.parent_id !== null) record.parentId = row.parent_id;
  if (row.media_type !== null) record.mediaType = row.media_type;
  if (row.represents_id !== null) record.represents = row.represents_id;
  if (row.agent_type !== null) record.agentType = row.agent_type;
  if (row.latitude !== null || row.longitude !== null) {
    record.coordinates = { lat: row.latitude, lng: row.longitude };
  }
  return record;
}

// ---------------------------------------------------------------------------
// Locks for the service layer's writes (T-032, D-065, D-067)

/** Where a record sits now, read without a lock: what decides whether a write needs the arrangement lock. */
export interface RecordPlace {
  readonly version: number;
  readonly kind: string;
  readonly parentId: RecordId | null;
  readonly level: string | null;
  /** What a digital asset represents (T-041: where its permissions come from). */
  readonly represents: RecordId | null;
  /** The record's home site (D-074), or `null` for none. */
  readonly siteId: SiteId | null;
}

/**
 * The organization's record's version, kind, parent and level as now
 * committed (no lock), or `undefined` if it has no such record. A writer
 * reads this first to decide whether it must take `lockArrangement` before
 * locking the row (D-065); `lockRecord` then confirms the version, so the
 * decision still holds.
 */
export async function readRecordPlace(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<RecordPlace | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const [row] = await db.rows<{
    version: number;
    kind: string;
    parent_id: string | null;
    level: string | null;
    represents_id: string | null;
    site_id: string | null;
  }>(sql`
    SELECT version, kind, parent_id::text AS parent_id, level,
           represents_id::text AS represents_id, site_id::text AS site_id
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  if (row === undefined) return undefined;
  return Object.freeze({
    version: row.version,
    kind: row.kind,
    parentId: row.parent_id as RecordId | null,
    level: row.level,
    represents: row.represents_id as RecordId | null,
    siteId: row.site_id as SiteId | null,
  });
}

/**
 * Takes the organization's arrangement lock (0006) until the transaction
 * ends: before any check of a unit's parent or level, and before the row
 * lock (D-065). Refused under any isolation level but Read Committed (the
 * database raises OC061, thrown).
 */
export async function lockArrangement(
  db: Queryable,
  organizationId: OrganizationId,
  mode: "exclusive" | "shared" = "exclusive",
): Promise<void> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  // `shared` (0013): for checks that only read where records sit; they run
  // side by side and wait for (and hold off) every exclusive holder, which
  // is every move.
  await db.execute(
    mode === "shared"
      ? sql`SELECT public.arrangement_lock_shared(${organizationId}::uuid)`
      : sql`SELECT public.arrangement_lock(${organizationId}::uuid)`,
  );
}

/**
 * Locks the organization's record row until the transaction ends, and
 * returns its version, or `undefined` if there is no such record. `FOR NO
 * KEY UPDATE` by default, as `updateRecord` and the identifier save do;
 * `update` (`FOR UPDATE`) for a deletion, as `deleteRecord` takes; `share`
 * (`FOR SHARE`) for a read that must see the row as it stays until COMMIT.
 */
export async function lockRecord(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
  mode: "no_key_update" | "update" | "share" = "no_key_update",
): Promise<number | undefined> {
  if (!isOrganizationId(organizationId) || !isRecordId(recordId)) return undefined;
  const where = sql`
    SELECT version FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`;
  const [row] = await db.rows<{ version: number }>(
    mode === "update"
      ? sql`${where} FOR UPDATE`
      : mode === "share"
        ? sql`${where} FOR SHARE`
        : sql`${where} FOR NO KEY UPDATE`,
  );
  return row?.version;
}

/**
 * Takes the lock on one template's or record type's versions (0008's
 * `definition_lock`) until the transaction ends: shared for a save that
 * checks against the current version (a new version waits for it), exclusive
 * for writing a new version (the version tables' triggers take it too).
 */
export async function lockDefinition(
  db: Queryable,
  organizationId: OrganizationId,
  kind: "template" | "record_type",
  key: string,
  exclusive = false,
): Promise<void> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  await db.execute(
    sql`SELECT public.definition_lock(${organizationId}::uuid, ${kind}, ${key}, ${exclusive})`,
  );
}
