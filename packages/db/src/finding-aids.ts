/**
 * Reading finding aids for EAD exports (T-059b, D-120).
 *
 * - `readPublicFindingAid`: a public host's "Download EAD". Through the
 *   public reader only: `public_finding_aid_units` (0067) names the units
 *   below the top unit that are public on the site (reached only through
 *   such units), then each unit is read exactly as `readPublicRecord` reads
 *   one record (`publicRecordIn`, in the same Repeatable Read snapshot), and
 *   only its public view's own values are used. A unit that read refuses
 *   (held back by a deed or an access restriction, no Dublin Core mapping,
 *   anything else) is left out with everything below it. The top unit
 *   refused, or the tree too big, answers like an unknown record.
 * - `findingAidUnitIds`: the staff side's list of archival units below a
 *   unit on the same site (the service reads and checks each one).
 */
import {
  findingAidFromUnits,
  isOrganizationId,
  isRecordId,
  isSiteId,
  type EadExport,
  type EadExportField,
  type EadExportUnit,
  type Issue,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type Validated,
  ARCHIVAL_LEVELS,
  type ArchivalLevel,
} from "@oculus/core";
import type { Database, Queryable } from "./client.js";
import { sql } from "./sql.js";
import {
  MAX_PUBLIC_READ_TIME_LIMIT_MS,
  PUBLIC_READ_TIME_LIMIT_MS,
  publicRecordIn,
} from "./workflow.js";

/** The most units a public finding aid holds (0067 stops counting past it). */
export const MAX_PUBLIC_FINDING_AID_UNITS = 1_000;

/** The most units a staff finding aid holds. */
export const MAX_STAFF_FINDING_AID_UNITS = 2_000;

const NOT_AVAILABLE: readonly Issue[] = Object.freeze([
  Object.freeze({ path: [], code: "not_available", message: "No such public finding aid." }),
]);

export interface PublicFindingAidOptions {
  /** The public URL records are published under, as `readPublicRecord` takes it. */
  readonly baseUrl: string;
  /** Each statement's time limit (S-037); `PUBLIC_READ_TIME_LIMIT_MS` by default. */
  readonly timeLimitMs?: number;
  /** The whole read's time limit, in milliseconds (`PUBLIC_FINDING_AID_DEADLINE_MS` by default). */
  readonly deadlineMs?: number;
  /** The clock (tests). */
  readonly clock?: () => number;
}

/** How long one public finding aid may take to read, in all (T-059b review). */
export const PUBLIC_FINDING_AID_DEADLINE_MS = 20_000;

interface UnitRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly level: string;
}

function isLevel(level: unknown): level is ArchivalLevel {
  return (ARCHIVAL_LEVELS as readonly unknown[]).includes(level);
}

/**
 * The public finding aid of `rootId` on a site, as `findingAidFromUnits`
 * makes it for the public: only what that site shows. Refused
 * (`not_available`) for anything a public visitor shouldn't tell apart from
 * an unknown record, and `too_many_units` past
 * `MAX_PUBLIC_FINDING_AID_UNITS`.
 */
export async function readPublicFindingAid(
  db: Database,
  organizationId: OrganizationId,
  siteId: SiteId,
  rootId: RecordId,
  options: PublicFindingAidOptions,
): Promise<Validated<EadExport>> {
  if (!isOrganizationId(organizationId) || !isSiteId(siteId) || !isRecordId(rootId)) {
    return { ok: false, issues: NOT_AVAILABLE };
  }
  const timeLimitMs = options.timeLimitMs ?? PUBLIC_READ_TIME_LIMIT_MS;
  if (
    typeof options.baseUrl !== "string" ||
    !Number.isInteger(timeLimitMs) ||
    timeLimitMs < 1 ||
    timeLimitMs > MAX_PUBLIC_READ_TIME_LIMIT_MS
  ) {
    return {
      ok: false,
      issues: [{ path: [], code: "invalid_options", message: "Give { baseUrl, timeLimitMs? }." }],
    };
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(
      sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeLimitMs)}, true)`,
    );
    const [found] = await tx.rows<{ units: { tooMany?: boolean; units?: UnitRow[] } | null }>(sql`
      SELECT public.public_finding_aid_units(${organizationId}::uuid, ${siteId}::uuid,
                                             ${rootId}::uuid) AS units`);
    const listed = found?.units ?? null;
    if (listed === null) return { ok: false, issues: NOT_AVAILABLE };
    if (listed.tooMany === true) {
      return {
        ok: false,
        issues: [
          {
            path: [],
            code: "too_many_units",
            message: `A public finding aid holds at most ${String(MAX_PUBLIC_FINDING_AID_UNITS)} units.`,
          },
        ],
      };
    }
    const rows = Array.isArray(listed.units) ? listed.units : [];
    const units: EadExportUnit[] = [];
    const clock = options.clock ?? Date.now;
    const until = clock() + (options.deadlineMs ?? PUBLIC_FINDING_AID_DEADLINE_MS);
    // Units read and kept: nothing below a unit left out is read at all.
    const kept = new Set<string>();
    for (const row of rows) {
      const left = until - clock();
      if (left <= 0) {
        return {
          ok: false,
          issues: [
            { path: [], code: "timeout", message: "The finding aid took too long to read." },
          ],
        };
      }
      if (!isRecordId(row.id) || !isLevel(row.level)) continue;
      const parentId = row.id === rootId ? undefined : row.parentId;
      if (parentId !== undefined && (parentId === null || !kept.has(parentId))) continue;
      // Every statement from here on stops by the deadline, too.
      const limit = Math.max(1, Math.min(timeLimitMs, Math.ceil(left)));
      await tx.execute(
        sql`SELECT pg_catalog.set_config('statement_timeout', ${String(limit)}, true)`,
      );
      // Exactly the read a public record page makes, in this snapshot.
      const read = await publicRecordIn(
        tx,
        organizationId,
        siteId,
        row.id,
        options.baseUrl,
        undefined,
      );
      if (!read.ok) {
        if (row.id === rootId) return { ok: false, issues: NOT_AVAILABLE };
        continue;
      }
      const { view, template } = read.value;
      const defs = new Map(template.fields.map((d) => [d.key, d]));
      const fields: EadExportField[] = [];
      for (const entry of view.entries) {
        // Own values only, but the top unit's inherited ones too: the tree
        // carries what the units below inherit, and nothing carries the top's.
        if (!entry.own && row.id !== rootId) continue;
        const def = defs.get(entry.key);
        if (def?.visibility !== "public") continue;
        fields.push({
          key: entry.key,
          label: def.label,
          kind: def.kind,
          value: entry.value,
          staffOnly: false,
          ...(def.options === undefined ? {} : { options: def.options }),
        });
      }
      kept.add(row.id);
      units.push({
        id: row.id,
        ...(parentId === undefined ? {} : { parentId: parentId as RecordId }),
        level: row.level,
        title: view.title,
        fields,
      });
    }
    const made = findingAidFromUnits(rootId, units, { audience: "public", fileId: rootId });
    return made.ok ? made : { ok: false, issues: NOT_AVAILABLE };
  });
}

/** An archival unit below a finding aid's top unit, for the staff export. */
export interface FindingAidUnitRow {
  readonly id: RecordId;
  readonly parentId?: RecordId;
  readonly depth: number;
}

/**
 * The archival units below `rootId` (the top unit first) on the top unit's
 * own site, through units of that site only, at most `limit` + 1 rows so the
 * caller can tell "too many". Nothing is checked for the person here: the
 * service checks each unit. Run inside the caller's transaction.
 */
export async function findingAidUnitIds(
  tx: Queryable,
  organizationId: OrganizationId,
  rootId: RecordId,
  limit: number = MAX_STAFF_FINDING_AID_UNITS,
): Promise<readonly FindingAidUnitRow[]> {
  if (!isOrganizationId(organizationId) || !isRecordId(rootId)) return [];
  const max = Math.max(1, Math.min(MAX_STAFF_FINDING_AID_UNITS, Math.floor(limit))) + 1;
  const rows = await tx.rows<{ id: string; parent_id: string | null; depth: number }>(sql`
    WITH RECURSIVE tree(id, parent_id, site_id, depth) AS (
      SELECT r.id, NULL::uuid, r.site_id, 0 FROM public.records r
      WHERE r.organization_id = ${organizationId}::uuid AND r.id = ${rootId}::uuid
        AND r.kind = 'archival_unit'
      UNION ALL
      SELECT c.id, c.parent_id, c.site_id, tree.depth + 1
      FROM tree JOIN public.records c
        ON c.organization_id = ${organizationId}::uuid AND c.parent_id = tree.id
      WHERE c.kind = 'archival_unit' AND c.site_id IS NOT DISTINCT FROM tree.site_id
        AND tree.depth < 64
    )
    SELECT id::text, parent_id::text, depth FROM tree ORDER BY depth, id LIMIT ${max}`);
  return rows
    .filter((r) => isRecordId(r.id) && (r.parent_id === null || isRecordId(r.parent_id)))
    .map((r) => ({
      id: r.id as RecordId,
      ...(r.parent_id === null ? {} : { parentId: r.parent_id as RecordId }),
      depth: r.depth,
    }));
}
