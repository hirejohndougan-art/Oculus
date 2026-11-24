/**
 * What backup and restore read from a database's catalogs (D-064): every
 * table with its row count and row hash, the other objects a restore must
 * bring back (sequences, functions, triggers, row security and policies,
 * grants), and whether a database is still exactly as CREATE DATABASE made it.
 *
 * Tables are found in the catalog, never listed, so new tables (T-029's
 * versions) are covered. A table is named by `format('%I.%I')` inside
 * `query_to_xml`, so no identifier is ever built in JavaScript (D-050).
 */
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

export interface TableSummary {
  /** `schema.table`. */
  name: string;
  /** Row count, as text (int8). */
  rows: string;
  /**
   * The sum of the first 64 bits of each row's SHA-256 (of the whole row as
   * text), as text: the same for the same rows in any order. A check against
   * corruption and lost rows, not a signature.
   */
  rowsHash: string;
}

/** Objects other than table rows, each as one line of text, sorted. */
export interface ObjectSummaries {
  sequences: string[];
  functions: string[];
  triggers: string[];
  /** Tables with row security on or forced, and each policy. */
  policies: string[];
  /**
   * Privileges granted to anyone but an object's owner:
   * `<kind> <name> to <grantee, quoted as an identifier>: <privilege>`.
   */
  grants: string[];
  /**
   * Privileges taken away from their defaults, which `--no-privileges` would
   * silently give back: functions without EXECUTE for PUBLIC, types without
   * USAGE for PUBLIC, the public schema without USAGE for PUBLIC, and every
   * default-privileges entry.
   */
  revokes: string[];
}

export const OBJECT_KINDS = [
  "sequences",
  "functions",
  "triggers",
  "policies",
  "grants",
  "revokes",
] as const;

/** JavaScript's order (UTF-16 code units), which the manifest check uses too. */
export function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every table outside the system schemas, with its row count and row hash.
 * The row is `ROW(oculus_backup_row.*)`: a qualified star always means the
 * whole row, even if a column has the alias's name.
 */
export async function tableSummaries(db: Queryable): Promise<TableSummary[]> {
  const rows = await db.rows<TableSummary>(sql`
    SELECT s.name, (pg_catalog.xpath('/row/n/text()', s.x))[1]::pg_catalog.text AS rows,
           (pg_catalog.xpath('/row/h/text()', s.x))[1]::pg_catalog.text AS "rowsHash"
    FROM (
      SELECT n.nspname || '.' || c.relname AS name,
             pg_catalog.query_to_xml(pg_catalog.format(
               'SELECT pg_catalog.count(*) AS n, COALESCE(pg_catalog.sum((''x'' || pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ROW(oculus_backup_row.*)::pg_catalog.text, ''UTF8'')), ''hex''), 1, 16))::pg_catalog.bit(64)::pg_catalog.int8::pg_catalog.numeric), 0) AS h FROM %I.%I AS oculus_backup_row',
               n.nspname, c.relname), false, true, '') AS x
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
    ) AS s`);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return sorted([...byName.keys()]).map((name) => {
    const row = byName.get(name);
    return { name, rows: row?.rows ?? "", rowsHash: row?.rowsHash ?? "" };
  });
}

/**
 * Sequences, functions, triggers, row security and policies, and grants, in
 * the user's schemas, leaving out what belongs to extensions. Function and
 * trigger bodies and policy expressions are given by their SHA-256. Owners
 * are left out (a restore with --no-owner changes them), and so are grants to
 * an object's owner and grantors, for the same reason.
 */
export async function objectSummaries(db: Queryable): Promise<ObjectSummaries> {
  const rows = await db.rows<{ kind: string; line: string }>(sql`
    WITH ns AS (
      SELECT oid, nspname FROM pg_catalog.pg_namespace
      WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'
    ), ext AS (
      SELECT classid, objid FROM pg_catalog.pg_depend WHERE deptype = 'e'
    )
    SELECT 'sequences' AS kind, ns.nspname || '.' || c.relname AS line
    FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ext.objid = c.oid)
    UNION ALL
    SELECT 'functions', ns.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ') '
           || p.prokind::pg_catalog.text || ' ' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                COALESCE(p.prosrc, '') || ' ' || COALESCE(pg_catalog.pg_get_function_result(p.oid), '') || ' ' || l.lanname
                || ' ' || p.provolatile::pg_catalog.text || ' ' || p.prosecdef::pg_catalog.text
                || ' ' || COALESCE(p.proconfig::pg_catalog.text, ''), 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND ext.objid = p.oid)
    UNION ALL
    SELECT 'triggers', ns.nspname || '.' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::pg_catalog.text || ' '
           || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_triggerdef(t.oid), 'UTF8')), 'hex')
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN ns ON ns.oid = c.relnamespace
    WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'policies', ns.nspname || '.' || c.relname || ' row security'
           || CASE WHEN c.relrowsecurity THEN ' on' ELSE ' off' END
           || CASE WHEN c.relforcerowsecurity THEN ', forced' ELSE '' END
    FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace
    WHERE c.relrowsecurity OR c.relforcerowsecurity
    UNION ALL
    SELECT 'policies', ns.nspname || '.' || c.relname || ' policy ' || p.polname || ' ' || p.polcmd::pg_catalog.text
           || CASE WHEN p.polpermissive THEN ' permissive' ELSE ' restrictive' END || ' to '
           || (SELECT pg_catalog.string_agg(r.name, ',' ORDER BY r.name COLLATE "C")
               FROM (SELECT CASE WHEN u = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(u)::pg_catalog.text) END AS name
                     FROM pg_catalog.unnest(p.polroles) AS u) AS r) || ' '
           || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' / '
                || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''), 'UTF8')), 'hex')
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN ns ON ns.oid = c.relnamespace
    UNION ALL
    SELECT 'revokes', 'function ' || ns.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '): EXECUTE not granted to PUBLIC'
    FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace
    WHERE p.proacl IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND ext.objid = p.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) AS x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
    UNION ALL
    SELECT 'revokes', 'type ' || ns.nspname || '.' || t.typname || ': USAGE not granted to PUBLIC'
    FROM pg_catalog.pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typacl IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(t.typacl) AS x WHERE x.grantee = 0 AND x.privilege_type = 'USAGE')
    UNION ALL
    SELECT 'revokes', 'schema public: USAGE not granted to PUBLIC'
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname = 'public' AND n.nspacl IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(n.nspacl) AS x WHERE x.grantee = 0 AND x.privilege_type = 'USAGE')
    UNION ALL
    SELECT 'revokes', 'default privileges for ' || pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(d.defaclrole)::pg_catalog.text)
           || COALESCE(' in ' || (SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.oid = d.defaclnamespace), '')
           || ' on ' || d.defaclobjtype::pg_catalog.text || ': ' || COALESCE(d.defaclacl::pg_catalog.text, '')
    FROM pg_catalog.pg_default_acl d
    UNION ALL
    SELECT 'grants', a.kind || ' ' || a.name || ' to '
           || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)::pg_catalog.text) END
           || ': ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' with grant option' ELSE '' END
    FROM (
      SELECT 'relation' AS kind, ns.nspname || '.' || c.relname AS name, c.relowner AS owner, x.grantee, x.privilege_type, x.is_grantable
      FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace, pg_catalog.aclexplode(c.relacl) AS x
      UNION ALL
      SELECT 'schema', ns.nspname, n.nspowner, x.grantee, x.privilege_type, x.is_grantable
      FROM pg_catalog.pg_namespace n JOIN ns ON ns.oid = n.oid, pg_catalog.aclexplode(n.nspacl) AS x
      UNION ALL
      SELECT 'function', ns.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             p.proowner, x.grantee, x.privilege_type, x.is_grantable
      FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace, pg_catalog.aclexplode(p.proacl) AS x
    ) AS a
    WHERE a.grantee <> a.owner
      AND NOT (a.kind = 'schema' AND a.grantee = 'pg_database_owner'::pg_catalog.regrole)`);
  const out: ObjectSummaries = {
    sequences: [],
    functions: [],
    triggers: [],
    policies: [],
    grants: [],
    revokes: [],
  };
  for (const row of rows) {
    if ((OBJECT_KINDS as readonly string[]).includes(row.kind)) {
      out[row.kind as keyof ObjectSummaries].push(row.line);
    }
  }
  for (const kind of OBJECT_KINDS) out[kind] = sorted([...new Set(out[kind])]);
  return out;
}

/**
 * How a database differs from one CREATE DATABASE has just made (from
 * template0, or an untouched template1), as counts by kind; empty if it
 * doesn't. An allowlist: any object created after initdb (OID 16384 and up)
 * in any catalog that holds objects counts, outside other sessions'
 * temporary schemas, and so do default privileges, settings for this
 * database, its subscriptions, and any change to the public schema's owner,
 * privileges or comment.
 */
export async function contentsOf(db: Queryable): Promise<Record<string, number>> {
  const [row] = await db.rows<Record<string, number>>(sql`
    WITH temp AS (
      SELECT oid FROM pg_catalog.pg_namespace
      WHERE nspname LIKE 'pg\\_temp\\_%' OR nspname LIKE 'pg\\_toast\\_temp\\_%'
    )
    SELECT
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_namespace
        WHERE oid >= 16384 AND oid NOT IN (SELECT oid FROM temp)) AS schemas,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_class
        WHERE oid >= 16384 AND relnamespace NOT IN (SELECT oid FROM temp)) AS relations,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_proc
        WHERE oid >= 16384 AND pronamespace NOT IN (SELECT oid FROM temp)) AS functions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_type
        WHERE oid >= 16384 AND typnamespace NOT IN (SELECT oid FROM temp)) AS types,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_constraint
        WHERE oid >= 16384 AND connamespace NOT IN (SELECT oid FROM temp)) AS constraints,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_collation WHERE oid >= 16384) AS collations,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_conversion WHERE oid >= 16384) AS conversions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_operator WHERE oid >= 16384) AS operators,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_opclass WHERE oid >= 16384) AS operator_classes,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_opfamily WHERE oid >= 16384) AS operator_families,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_am WHERE oid >= 16384) AS access_methods,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_cast WHERE oid >= 16384) AS casts,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_transform WHERE oid >= 16384) AS transforms,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_ts_config WHERE oid >= 16384) AS text_search_configurations,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_ts_dict WHERE oid >= 16384) AS text_search_dictionaries,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_ts_parser WHERE oid >= 16384) AS text_search_parsers,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_ts_template WHERE oid >= 16384) AS text_search_templates,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_statistic_ext WHERE oid >= 16384) AS statistics_objects,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_language WHERE oid >= 16384) AS languages,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_extension WHERE oid >= 16384) AS extensions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_foreign_data_wrapper WHERE oid >= 16384) AS foreign_data_wrappers,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_foreign_server WHERE oid >= 16384) AS foreign_servers,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_publication) AS publications,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())) AS subscriptions,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_event_trigger) AS event_triggers,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_default_acl) AS default_privileges,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_largeobject_metadata) AS large_objects,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_db_role_setting
        WHERE setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())) AS database_settings,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_namespace n
        WHERE n.nspname = 'public' AND NOT (
          n.oid = 2200
          AND n.nspowner = 'pg_database_owner'::pg_catalog.regrole
          AND n.nspacl::pg_catalog.text = '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}'
          AND pg_catalog.obj_description(n.oid, 'pg_namespace') IS NOT DISTINCT FROM 'standard public schema'
        )) + (SELECT CASE WHEN pg_catalog.to_regnamespace('public') IS NULL THEN 1 ELSE 0 END)::pg_catalog.int4 AS public_schema_changes`);
  return Object.fromEntries(Object.entries(row ?? {}).filter(([, count]) => count > 0));
}

/** The grantee of a grant line (as `quote_ident` gives it). */
export function grantee(line: string): string {
  const at = line.lastIndexOf(" to ");
  const end = line.indexOf(": ", at);
  return at < 0 || end < 0 ? "" : line.slice(at + 4, end);
}
