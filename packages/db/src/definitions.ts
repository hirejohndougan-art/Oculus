/**
 * Reads behind the service's template and identifier type saves (T-042,
 * D-076, D-079): the organization's current templates, the records that use
 * one template, and which published records a change that makes values
 * public would show them on at once.
 *
 * Every query names the organization (D-019); another organization's
 * templates and records are never read. Nothing here writes. The caller
 * holds the locks that keep the answers true until COMMIT: the template's
 * `definition_lock` exclusively (record saves and publishing take it
 * shared), or the identifier type's row `FOR UPDATE` (record saves,
 * identifier saves and publishing lock the types `FOR SHARE`).
 */
import {
  MAX_REGISTRY_TEMPLATES,
  isOrganizationId,
  isRecordId,
  isTemplateKey,
  validateLegacyTemplate,
  type FieldTemplate,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import { readRecordsForChecks } from "./catalog.js";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

const BAD_ORGANIZATION = "The organization ID must be a lowercase version 4 UUID.";

/** One current template, as listed. */
export interface TemplateSummary {
  readonly key: string;
  readonly version: number;
  readonly template: FieldTemplate;
}

/**
 * The organization's templates at their current (highest) versions, by key,
 * at most `MAX_REGISTRY_TEMPLATES`. A stored definition that no longer reads
 * as a template (changed by hand) is left out rather than shown as one.
 */
export async function listTemplates(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly TemplateSummary[]> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const rows = await db.rows<{ key: string; version: number; definition: unknown }>(sql`
    SELECT DISTINCT ON (key) key, version, definition
    FROM public.template_versions
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY key, version DESC
    LIMIT ${MAX_REGISTRY_TEMPLATES}::integer`);
  const out: TemplateSummary[] = [];
  for (const row of rows) {
    // Legacy reading, as the template change check reads the old version.
    const valid = validateLegacyTemplate(row.definition);
    if (!valid.ok) continue;
    if (valid.value.organizationId !== organizationId || valid.value.key !== row.key) continue;
    out.push(Object.freeze({ key: row.key, version: row.version, template: valid.value }));
  }
  return Object.freeze(out);
}

/**
 * The organization's records naming the template `key`, as their rows hold
 * them (not validated: core's `templateChanges` validates each), or
 * `undefined` when there are more than `max`.
 */
export async function readRecordsUsingTemplate(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
  max: number,
): Promise<Record<string, unknown>[] | undefined> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  if (!isTemplateKey(key)) return [];
  const ids = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND template_key = ${key}
    ORDER BY id
    LIMIT ${max + 1}::integer`);
  if (ids.length > max) return undefined;
  const list = ids.map((r) => r.id).filter((id): id is RecordId => isRecordId(id));
  const out: Record<string, unknown>[] = [];
  // In slices, so one statement never carries a huge array.
  for (let i = 0; i < list.length; i += 1000) {
    out.push(...(await readRecordsForChecks(db, organizationId, list.slice(i, i + 1000))));
  }
  return out;
}

/** The most published records one change is said to affect; more is `too_many_records`. */
export const MAX_AFFECTED_PUBLISHED = 10_000;

/**
 * Of `ids`, the organization's published records, and with `below` also
 * every published record filed under them or representing them (any depth,
 * through `parent_id` and `represents_id`): those receive inherited values.
 * Ordered by ID. `undefined` when there are more than
 * `MAX_AFFECTED_PUBLISHED`.
 */
export async function publishedAmong(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly RecordId[],
  options: { readonly below?: boolean } = {},
): Promise<readonly RecordId[] | undefined> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const seeds = ids.filter((id) => isRecordId(id));
  if (seeds.length === 0) return [];
  const rows =
    options.below === true
      ? await db.rows<{ id: string }>(sql`
          WITH RECURSIVE down(id) AS (
            SELECT unnest(${seeds}::uuid[])
            UNION
            SELECT r.id FROM down
            JOIN public.records r
              ON r.organization_id = ${organizationId}::uuid
             AND (r.parent_id = down.id OR r.represents_id = down.id)
          )
          SELECT r.id::text AS id FROM public.records r
          WHERE r.organization_id = ${organizationId}::uuid
            AND r.workflow_state = 'published'
            AND r.id IN (SELECT id FROM down)
          ORDER BY r.id
          LIMIT ${MAX_AFFECTED_PUBLISHED + 1}::integer`)
      : await db.rows<{ id: string }>(sql`
          SELECT id::text AS id FROM public.records
          WHERE organization_id = ${organizationId}::uuid
            AND workflow_state = 'published'
            AND id = ANY(${seeds}::uuid[])
          ORDER BY id
          LIMIT ${MAX_AFFECTED_PUBLISHED + 1}::integer`);
  if (rows.length > MAX_AFFECTED_PUBLISHED) return undefined;
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * The organization's published records holding a number of the identifier
 * type `typeKey`: as a current or former identifier (its holdings), or as
 * a `{ type, value }` in a template `identifier` field anywhere in
 * `fields`. Ordered by ID; `undefined` when there are more than
 * `MAX_AFFECTED_PUBLISHED`.
 */
export async function publishedHoldingType(
  db: Queryable,
  organizationId: OrganizationId,
  typeKey: string,
): Promise<readonly RecordId[] | undefined> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const rows = await db.rows<{ id: string }>(sql`
    SELECT r.id::text AS id FROM public.records r
    WHERE r.organization_id = ${organizationId}::uuid
      AND r.workflow_state = 'published'
      AND (EXISTS (SELECT 1 FROM public.identifier_holdings h
                   WHERE h.organization_id = r.organization_id AND h.record_id = r.id
                     AND h.type_key = ${typeKey})
           OR jsonb_path_exists(r.fields, '$.** ? (@.type == $k)',
                                jsonb_build_object('k', ${typeKey}::text)))
    ORDER BY r.id
    LIMIT ${MAX_AFFECTED_PUBLISHED + 1}::integer`);
  if (rows.length > MAX_AFFECTED_PUBLISHED) return undefined;
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * Locks the organization's identifier type row `FOR UPDATE` until the
 * transaction ends, so no record, identifier set or publication that locks
 * the types `FOR SHARE` runs until COMMIT. Returns whether it exists.
 */
export async function lockIdentifierType(
  db: Queryable,
  organizationId: OrganizationId,
  key: string,
): Promise<boolean> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const rows = await db.rows(sql`
    SELECT 1 FROM public.identifier_types
    WHERE organization_id = ${organizationId}::uuid AND key = ${key}
    FOR UPDATE`);
  return rows.length > 0;
}

/**
 * Whether any record of the organization holds or held a number under the
 * identifier type key `typeKey` (left from a deleted type or imported): a
 * new type with that key adopts them (D-031).
 */
export async function identifierKeyInUse(
  db: Queryable,
  organizationId: OrganizationId,
  typeKey: string,
): Promise<boolean> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const rows = await db.rows(sql`
    SELECT 1 FROM public.identifier_holdings
    WHERE organization_id = ${organizationId}::uuid AND type_key = ${typeKey}
    LIMIT 1`);
  return rows.length > 0;
}

/** The IDs of the organization's sites, at most 1,000. */
export async function organizationSiteIds(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<readonly string[]> {
  if (!isOrganizationId(organizationId)) throw new TypeError(BAD_ORGANIZATION);
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.sites
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY id LIMIT 1000`);
  return Object.freeze(rows.map((r) => r.id));
}
