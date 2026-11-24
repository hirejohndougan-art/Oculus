/**
 * The database role the service layer writes with (T-032, D-063, D-067).
 *
 * Roles are cluster-wide and `CREATE ROLE` needs a privilege a shared host
 * may not give (D-035, D-046), so migrations create none. The deployment
 * (T-051) creates one login role for the service and runs
 * `grantWriterRole` once, as the owner, after migrating; tests do the same
 * in their throwaway databases. **The service's role is the only one that
 * may write**: no table grants anything to PUBLIC, and any other role (a
 * reporting login, a role for public sites later) gets at most SELECT.
 *
 * The writer can't change history (no UPDATE, DELETE or TRUNCATE on any
 * version table), can't delete a record except with its deletion version
 * (0008's triggers), can't disable triggers, drop or alter anything (only
 * the owner can) and can't create tables in `public` (PostgreSQL 15 and
 * later give PUBLIC no CREATE there). It must never connect as the owner,
 * which can disable triggers. `grantWriterRole` only adds privileges: it
 * never revokes what a role already holds, and `checkWriterConnection`
 * refuses a role holding anything more.
 */
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * Exactly what the writer may do to each table, beyond SELECT on every table
 * (D-067): what the data-access functions use, no more. `UPDATE` is there
 * also where only a row lock needs it (`SELECT … FOR SHARE` and the like
 * need UPDATE on the table): `organizations` (locked while an identifier
 * type is added). UPDATE on `identifier_types` is a real write as well as a
 * lock: `updateIdentifierType` changes a type's definition and uniqueness
 * rule, so with direct SQL the writer can also loosen a rule (`all_time` to
 * `none`). Nothing
 * deletes organizations, templates, record types, identifier types or terms,
 * and versions are only ever inserted.
 */
export const WRITER_PRIVILEGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  organizations: ["INSERT", "UPDATE"],
  templates: ["INSERT"],
  template_versions: ["INSERT"],
  record_types: ["INSERT"],
  record_type_versions: ["INSERT"],
  records: ["INSERT", "UPDATE", "DELETE"],
  record_versions: ["INSERT"],
  identifier_types: ["INSERT", "UPDATE"],
  identifier_holdings: ["INSERT", "UPDATE", "DELETE"],
  record_identifiers: ["INSERT", "DELETE"],
  former_identifiers: ["INSERT", "DELETE"],
  identifier_counters: ["INSERT", "UPDATE"],
  terms: ["INSERT", "UPDATE"],
  record_term_index: ["INSERT", "UPDATE", "DELETE"],
  record_terms: ["INSERT", "DELETE"],
});

/**
 * The writer's privileges, as statements with `%I` for the role (quoted by
 * PostgreSQL's `format`): USAGE on the schema, SELECT on every table, then
 * `WRITER_PRIVILEGES`.
 */
export const WRITER_GRANTS: readonly string[] = Object.freeze([
  "GRANT USAGE ON SCHEMA public TO %I",
  "GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I",
  ...Object.entries(WRITER_PRIVILEGES).map(
    ([table, privileges]) => `GRANT ${privileges.join(", ")} ON public.${table} TO %I`,
  ),
]);

/** A role name `grantWriterRole` takes: lower case, digits and `_`, up to 63 characters. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Gives `role` the writer's privileges (`WRITER_GRANTS`) in the connected
 * database. Run as the owner of the tables (the migrating role), in a
 * transaction. The role must exist.
 */
export async function grantWriterRole(db: Queryable, role: string): Promise<void> {
  if (!ROLE_NAME.test(role)) {
    throw new TypeError("A role name is lower case letters, digits and _, at most 63 characters.");
  }
  for (const statement of WRITER_GRANTS) {
    // Names can't be parameters: the name goes in through set_config and is
    // quoted by format('%I').
    await db.rows(sql`SELECT set_config('oculus.grant_role', ${role}, true),
                             set_config('oculus.grant_statement', ${statement}, true)`);
    await db.execute(sql`DO $$ BEGIN
      EXECUTE format(current_setting('oculus.grant_statement'), current_setting('oculus.grant_role'));
    END $$`);
  }
}

/** What `checkWriterConnection` finds wrong with the connection's role. */
export interface WriterRoleProblem {
  readonly code:
    | "superuser"
    | "createrole"
    | "bypasses_row_security"
    | "replication"
    | "role_membership"
    | "owner"
    | "extra_privilege"
    | "column_privilege"
    | "default_privilege"
    | "database_create"
    | "schema_create"
    | "parameter_privilege"
    | "missing_privilege";
  readonly message: string;
}

/** At most this many items are named in a message; the rest are counted. */
const LISTED = 5;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, LISTED).join(", ");
  return items.length > LISTED ? `${shown} and ${String(items.length - LISTED)} more` : shown;
}

/**
 * What is wrong with writing through this connection (D-067). An
 * **allowlist**: the writer must be a plain role holding exactly what
 * `grantWriterRole` gives, read from the catalogs' ACLs rather than through
 * `has_*_privilege` (which count only inherited privileges and miss column
 * grants). Checked for the role in effect (`current_user`) and the login
 * (`session_user`), since a session can `SET ROLE` back to the role it
 * logged in as. Each must:
 * - have none of SUPERUSER, CREATEROLE, BYPASSRLS, REPLICATION;
 * - be a member of **no role at all** (any `pg_auth_members` row, whatever
 *   its INHERIT, SET or ADMIN options): a role it can `SET ROLE` to, or
 *   re-grant itself, could hold TRIGGER, a parameter, CREATE or a predefined
 *   role such as `pg_create_subscription` or `pg_write_server_files`;
 * - own nothing in `public`, not `public` itself and not the database;
 * - be granted, itself or through PUBLIC, no table privilege in `public`
 *   beyond SELECT and `WRITER_PRIVILEGES` (PUBLIC: none), no column
 *   privilege at all, no default privileges (on future tables or
 *   sequences), no CREATE on the database or on `public`, and no SET or
 *   ALTER SYSTEM on any parameter (`session_replication_role = replica`
 *   turns ordinary triggers off).
 * GRANT OPTION on its own privileges is not refused: it can only hand them
 * on. And the role in effect must hold every privilege `grantWriterRole`
 * gives. Empty when the connection is fit to be the service's. Run it at
 * startup and after every migration (new tables, new default privileges).
 */
export async function checkWriterConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  const tables = Object.keys(WRITER_PRIVILEGES);
  const pairs = Object.entries(WRITER_PRIVILEGES).flatMap(([table, privileges]) =>
    privileges.map((privilege) => [table, privilege] as const),
  );
  const rows = await db.rows<{
    current: boolean;
    superuser: boolean;
    createrole: boolean;
    bypass: boolean;
    replication: boolean;
    memberships: number;
    owner: boolean;
    extra: string[] | null;
    columns: string[] | null;
    defaults: string[] | null;
    database_create: boolean;
    schema_create: boolean;
    parameters: string[] | null;
    privileges: boolean;
  }>(sql`
    WITH who AS (
      SELECT r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
             w.current
      FROM (VALUES (current_user::text, true), (session_user::text, false)) AS w(name, current)
      JOIN pg_catalog.pg_roles r ON r.rolname = w.name
    ), allowed(table_name, privilege) AS (
      SELECT * FROM unnest(${pairs.map(([t]) => t)}::text[],
                           ${pairs.map(([, privilege]) => privilege)}::text[])
    ), public_tables AS (
      SELECT c.oid, c.relname, c.relkind,
             pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault(
               (CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) AS acl
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    )
    SELECT w.current,
           w.rolsuper AS superuser, w.rolcreaterole AS createrole,
           w.rolbypassrls AS bypass, w.rolreplication AS replication,
           (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
            WHERE m.member = w.oid) AS memberships,
           (EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND pg_catalog.pg_has_role(w.oid, c.relowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND pg_catalog.pg_has_role(w.oid, p.proowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                       WHERE n.nspname = 'public' AND pg_catalog.pg_has_role(w.oid, n.nspowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d
                       WHERE d.datname = pg_catalog.current_database()
                         AND pg_catalog.pg_has_role(w.oid, d.datdba, 'MEMBER'))) AS owner,
           -- Table privileges granted to the role or to PUBLIC beyond the allowlist.
           (SELECT pg_catalog.array_agg(DISTINCT
                     t.relname || ' ' || (t.acl).privilege_type
                     || CASE WHEN (t.acl).grantee = 0 THEN ' (PUBLIC)' ELSE '' END)
            FROM public_tables t
            WHERE (t.acl).grantee IN (w.oid, 0)
              AND NOT ((t.acl).grantee = w.oid AND t.relkind <> 'S'
                       AND ((t.acl).privilege_type = 'SELECT'
                            OR EXISTS (SELECT 1 FROM allowed a
                                       WHERE a.table_name = t.relname
                                         AND a.privilege = (t.acl).privilege_type)))) AS extra,
           -- Any column privilege at all.
           (SELECT pg_catalog.array_agg(DISTINCT c.relname || '.' || a.attname || ' ' || x.privilege_type)
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
                 pg_catalog.aclexplode(a.attacl) AS x
            WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attacl IS NOT NULL AND x.grantee IN (w.oid, 0)) AS columns,
           -- Default privileges for future objects, but PUBLIC's own defaults
           -- (EXECUTE on functions, USAGE on types) that a revoke row repeats.
           (SELECT pg_catalog.array_agg(DISTINCT d.defaclobjtype::text || ' ' || x.privilege_type)
            FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) AS x
            WHERE x.grantee IN (w.oid, 0)
              AND NOT (x.grantee = 0 AND ((d.defaclobjtype = 'f' AND x.privilege_type = 'EXECUTE')
                                          OR (d.defaclobjtype = 'T' AND x.privilege_type = 'USAGE')))) AS defaults,
           EXISTS (SELECT 1 FROM pg_catalog.pg_database d,
                          pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) AS x
                   WHERE d.datname = pg_catalog.current_database()
                     AND x.grantee IN (w.oid, 0) AND x.privilege_type = 'CREATE') AS database_create,
           EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                          pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS x
                   WHERE n.nspname = 'public'
                     AND x.grantee IN (w.oid, 0) AND x.privilege_type = 'CREATE') AS schema_create,
           -- pg_parameter_acl exists from PostgreSQL 15, the oldest supported (D-049).
           (SELECT pg_catalog.array_agg(DISTINCT p.parname || ' ' || x.privilege_type)
            FROM pg_catalog.pg_parameter_acl p, pg_catalog.aclexplode(p.paracl) AS x
            WHERE x.grantee IN (w.oid, 0)) AS parameters,
           (NOT w.current
            OR (pg_catalog.has_schema_privilege(w.oid, 'public', 'USAGE')
                AND (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(w.oid, 'public.' || t, 'SELECT'))
                     FROM unnest(${tables}::text[]) AS t)
                AND (SELECT pg_catalog.bool_and(
                              pg_catalog.has_table_privilege(w.oid, 'public.' || a.table_name, a.privilege))
                     FROM allowed a))) AS privileges
    FROM who w`);
  const problems: WriterRoleProblem[] = [];
  const add = (code: WriterRoleProblem["code"], message: string): void => {
    problems.push({ code, message });
  };
  // A login or role that isn't in pg_roles (dropped mid-session) is refused.
  const unknown = rows.length < 2;
  const any = (pick: (row: (typeof rows)[number]) => boolean): boolean =>
    unknown || rows.some(pick);
  const all = (pick: (row: (typeof rows)[number]) => readonly string[] | null): string[] =>
    [...new Set(rows.flatMap((r) => pick(r) ?? []))].sort();
  if (any((r) => r.superuser)) add("superuser", "The service's login or role is a superuser.");
  if (any((r) => r.createrole)) add("createrole", "The service's login or role can create roles.");
  if (any((r) => r.bypass)) {
    add("bypasses_row_security", "The service's login or role bypasses row security.");
  }
  if (any((r) => r.replication)) {
    add("replication", "The service's login or role has the REPLICATION attribute.");
  }
  if (any((r) => r.memberships > 0)) {
    add(
      "role_membership",
      "The service's login or role is a member of another role; the writer must be a plain role that belongs to none.",
    );
  }
  if (any((r) => r.owner)) {
    add(
      "owner",
      "The service's login or role owns the tables, functions, schema or database, and could turn off the triggers that guard history; give it its own login role.",
    );
  }
  const extra = all((r) => r.extra);
  if (unknown || extra.length > 0) {
    add("extra_privilege", `Table privileges beyond the writer's: ${listed(extra)}.`);
  }
  const columns = all((r) => r.columns);
  if (columns.length > 0) add("column_privilege", `Column privileges: ${listed(columns)}.`);
  const defaults = all((r) => r.defaults);
  if (defaults.length > 0) {
    add("default_privilege", `Default privileges on future objects: ${listed(defaults)}.`);
  }
  if (any((r) => r.database_create)) {
    add("database_create", "The service's login, role or PUBLIC may CREATE in the database.");
  }
  if (any((r) => r.schema_create)) {
    add("schema_create", "The service's login, role or PUBLIC may CREATE in schema public.");
  }
  const parameters = all((r) => r.parameters);
  if (parameters.length > 0) {
    add("parameter_privilege", `Privileges on server parameters: ${listed(parameters)}.`);
  }
  if (unknown || rows.some((r) => !r.privileges)) {
    add("missing_privilege", "The service's role lacks the writer's privileges (grantWriterRole).");
  }
  return problems;
}
