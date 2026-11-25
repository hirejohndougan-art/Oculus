/**
 * Stored Dublin Core mappings (T-050b, D-094, D-012): one current mapping
 * per template, beside it (migration 0024), with a version counting its
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
import type { Queryable } from "./client.js";
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
