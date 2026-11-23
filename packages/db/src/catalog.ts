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
 * keys all include `organization_id`, so a write can't point across either.
 *
 * What is left to the service layer (T-032): which organization a session may
 * use, transactions spanning several writes, checking a record's fields
 * against its template (that needs the organization's identifier types and
 * records, `checkRecordAgainstTemplate`), a record type of the record's kind
 * (`checkRecordType`), and cycles in the arrangement (`validateArrangement`).
 *
 * Database errors (a foreign key or check refusing a row, a lost connection)
 * are thrown as `pg` reports them.
 */
import {
  issue,
  isOrganizationId,
  isRecordId,
  isTemplateKey,
  validateOrganization,
  validateRecord,
  validateRecordType,
  validateTemplate,
  type CatalogRecord,
  type FieldTemplate,
  type Organization,
  type OrganizationId,
  type RecordId,
  type RecordType,
  type Validated,
} from "@oculus/core";
import type { Queryable } from "./client.js";
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

function storedTemplate(
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
 * `insertTemplateVersion` does. `template` is the type's default template
 * (say from `readTemplate`): `validateRecordType` checks it belongs to the
 * type's organization, has the type's `defaultTemplateKey` and applies to the
 * type's kind, and the table's foreign key checks that the organization has
 * stored a template with that key.
 */
export async function insertRecordTypeVersion(
  db: Queryable,
  input: unknown,
  template: FieldTemplate,
): Promise<Validated<StoredRecordType>> {
  const valid = validateRecordType(input, template);
  if (!valid.ok) return valid;
  const type = valid.value;
  const org = type.organizationId;
  const [row] = await db.rows<{ version: number }>(sql`
    WITH identity AS (
      INSERT INTO public.record_types (organization_id, key)
      VALUES (${org}::uuid, ${type.key})
      ON CONFLICT (organization_id, key) DO NOTHING
    )
    INSERT INTO public.record_type_versions
      (organization_id, key, version, kind, default_template_key, definition)
    SELECT ${org}::uuid, ${type.key}, coalesce(max(version), 0) + 1, ${type.kind},
           ${type.defaultTemplateKey}, ${JSON.stringify(type)}::jsonb
    FROM public.record_type_versions
    WHERE organization_id = ${org}::uuid AND key = ${type.key}
    RETURNING version`);
  if (row === undefined) throw new Error("The record type version was not stored.");
  return { ok: true, value: Object.freeze({ version: row.version, recordType: type }) };
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
interface RecordRow {
  id: string;
  organization_id: string;
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
 * Stores a new record. It must name its template (`templateKey`): every
 * stored record does (D-029), so a keyless one is refused here
 * (`no_template_key`) before the database would.
 */
export async function insertRecord(
  db: Queryable,
  input: unknown,
): Promise<Validated<CatalogRecord>> {
  const valid = validateRecord(input);
  if (!valid.ok) return valid;
  const r = valid.value;
  if (r.templateKey === undefined) {
    return refused(
      ["templateKey"],
      "no_template_key",
      "Every stored record names its template (templateKey).",
    );
  }
  const level = r.kind === "archival_unit" ? r.level : null;
  const parentId = r.kind === "archival_unit" ? (r.parentId ?? null) : null;
  const mediaType = r.kind === "digital_asset" ? r.mediaType : null;
  const represents = r.kind === "digital_asset" ? (r.represents ?? null) : null;
  const agentType = r.kind === "agent" ? r.agentType : null;
  const coordinates = r.kind === "place" ? r.coordinates : undefined;
  await db.execute(sql`
    INSERT INTO public.records (
      id, organization_id, kind, template_key, record_type_key, title,
      level, parent_id, media_type, represents_id, agent_type, latitude, longitude,
      fields, created_at, updated_at
    ) VALUES (
      ${r.id}::uuid, ${r.organizationId}::uuid, ${r.kind}, ${r.templateKey},
      ${r.recordTypeKey ?? null}, ${r.title},
      ${level}, ${parentId}::uuid, ${mediaType}, ${represents}::uuid, ${agentType},
      ${coordinates?.lat ?? null}::double precision, ${coordinates?.lng ?? null}::double precision,
      ${JSON.stringify(r.fields)}::jsonb, ${r.createdAt}::timestamptz, ${r.updatedAt}::timestamptz
    )`);
  return valid;
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
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!isRecordId(id)) {
    return refused(["id"], "invalid_id", "The record ID must be a lowercase version 4 UUID.");
  }
  const [row] = await db.rows<RecordRow>(sql`
    SELECT id::text AS id, organization_id::text AS organization_id, kind, template_key,
           record_type_key, title, level, parent_id::text AS parent_id, media_type,
           represents_id::text AS represents_id, agent_type, latitude, longitude, fields,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid`);
  if (row === undefined) return undefined;
  const valid = validateRecord(recordFromRow(row));
  if (!valid.ok) return valid;
  if (valid.value.organizationId !== organizationId || valid.value.id !== id) {
    return refused([], "row_mismatch", "The stored record doesn't match its row.");
  }
  return valid;
}

/**
 * The core record a row holds. Optional columns become properties only when
 * set, so `validateRecord` refuses a row whose columns don't fit its kind.
 */
function recordFromRow(row: RecordRow): Record<string, unknown> {
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
