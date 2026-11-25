/**
 * Stored Dublin Core mappings (T-050b, D-096, D-012): one current mapping
 * per template, beside it (migration 0022), with a version counting its
 * changes.
 *
 * Nothing here decides who may change a mapping or checks it against its
 * template: the service does both (core's `validateDublinCoreMapping`),
 * under the template's exclusive definition lock, so the template can't
 * change between the check and the write. Reads return the stored JSON as
 * it is; every reader checks it again against the template it uses (public
 * output does at every read, D-016).
 *
 * The public sites read a record's mapping only through
 * `public.public_dublin_core_mapping` (`readPublicRecord`, workflow.ts),
 * never this table.
 */
import {
  isOrganizationId,
  isTemplateKey,
  issue,
  type DublinCoreMapping,
  type OrganizationId,
  type UserId,
  type Validated,
} from "@oculus/core";
import type { RecordId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { MAX_AFFECTED_PUBLISHED } from "./definitions.js";
import { sql } from "./sql.js";

/** A template's stored mapping: its JSON as stored, and the version an edit starts from. */
export interface StoredDublinCoreMapping {
  readonly mapping: unknown;
  readonly version: number;
}

/**
 * The template's stored mapping, or `undefined` when it has none (or the
 * organization or key isn't well formed). `lock` locks the row `FOR UPDATE`.
 */
export async function readDublinCoreMapping(
  db: Queryable,
  organizationId: OrganizationId,
  templateKey: string,
  options: { readonly lock?: boolean } = {},
): Promise<StoredDublinCoreMapping | undefined> {
  if (!isOrganizationId(organizationId) || !isTemplateKey(templateKey)) return undefined;
  const rows =
    options.lock === true
      ? await db.rows<{ mapping: unknown; version: number }>(sql`
          SELECT mapping, version FROM public.dublin_core_mappings
          WHERE organization_id = ${organizationId}::uuid AND template_key = ${templateKey}
          FOR UPDATE`)
      : await db.rows<{ mapping: unknown; version: number }>(sql`
          SELECT mapping, version FROM public.dublin_core_mappings
          WHERE organization_id = ${organizationId}::uuid AND template_key = ${templateKey}`);
  const row = rows[0];
  return row === undefined
    ? undefined
    : Object.freeze({ mapping: row.mapping, version: row.version });
}

function conflict(message: string): Validated<never> {
  return { ok: false, issues: [issue(["expectedVersion"], "version_conflict", message)] };
}

/**
 * Stores `mapping` (already checked by the caller against its template) as
 * its template's mapping, if the stored one is still at `expectedVersion`
 * (0: there is none yet); `version_conflict` otherwise. Returns the new
 * version.
 */
export async function writeDublinCoreMapping(
  db: Queryable,
  mapping: DublinCoreMapping,
  expectedVersion: number,
  changedBy: UserId,
): Promise<Validated<{ readonly version: number }>> {
  const json = JSON.stringify(mapping);
  const [row] =
    expectedVersion === 0
      ? await db.rows<{ version: number }>(sql`
          INSERT INTO public.dublin_core_mappings
            (organization_id, template_key, version, mapping, changed_by)
          VALUES (${mapping.organizationId}::uuid, ${mapping.template}, 1, ${json}::jsonb,
                  ${changedBy}::uuid)
          ON CONFLICT (organization_id, template_key) DO NOTHING
          RETURNING version`)
      : await db.rows<{ version: number }>(sql`
          UPDATE public.dublin_core_mappings
          SET mapping = ${json}::jsonb, version = version + 1, changed_by = ${changedBy}::uuid,
              changed_at = now()
          WHERE organization_id = ${mapping.organizationId}::uuid
            AND template_key = ${mapping.template} AND version = ${expectedVersion}
          RETURNING version`);
  if (row === undefined) {
    return conflict(
      expectedVersion === 0
        ? "This template has a mapping already; read it and change that one."
        : "The mapping was changed by someone else meanwhile. Read it again.",
    );
  }
  return { ok: true, value: Object.freeze({ version: row.version }) };
}

/**
 * The organization's published records using the template, by ID, as a
 * mapping change shows values on them at once (D-076); `undefined` past
 * `limit` (`MAX_AFFECTED_PUBLISHED`, or lower for tests). Reads IDs only.
 */
export async function publishedUsingTemplate(
  db: Queryable,
  organizationId: OrganizationId,
  templateKey: string,
  limit: number = MAX_AFFECTED_PUBLISHED,
): Promise<readonly RecordId[] | undefined> {
  if (!isOrganizationId(organizationId) || !isTemplateKey(templateKey)) return [];
  const most =
    Number.isInteger(limit) && limit >= 0 && limit <= MAX_AFFECTED_PUBLISHED
      ? limit
      : MAX_AFFECTED_PUBLISHED;
  const rows = await db.rows<{ id: string }>(sql`
    SELECT id::text AS id FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND template_key = ${templateKey}
      AND workflow_state = 'published'
    ORDER BY id
    LIMIT ${most + 1}::integer`);
  if (rows.length > most) return undefined;
  return Object.freeze(rows.map((r) => r.id as RecordId));
}

/**
 * How many of the organization's published records use the template
 * (S-039): for a mapping change past `MAX_AFFECTED_PUBLISHED`, confirmed
 * by this count instead of a list. Read under the template's lock, as
 * `publishedUsingTemplate`.
 */
export async function countPublishedUsingTemplate(
  db: Queryable,
  organizationId: OrganizationId,
  templateKey: string,
): Promise<number> {
  if (!isOrganizationId(organizationId) || !isTemplateKey(templateKey)) return 0;
  const [row] = await db.rows<{ n: number }>(sql`
    SELECT count(*)::integer AS n FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND template_key = ${templateKey}
      AND workflow_state = 'published'`);
  return row?.n ?? 0;
}
