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
    | "owner"
    | "createrole"
    | "bypasses_row_security"
    | "replication_role"
    | "server_access"
    | "schema_create"
    | "extra_privilege"
    | "missing_privilege";
  readonly message: string;
}

/**
 * Predefined roles that reach outside the database's own rules (files,
 * programs, every table's data, maintenance of every table). `pg_maintain`
 * exists from PostgreSQL 17; a name that doesn't exist matches nothing.
 */
const SERVER_ROLES = [
  "pg_execute_server_program",
  "pg_write_server_files",
  "pg_read_server_files",
  "pg_write_all_data",
  "pg_maintain",
];

/** Every table privilege PostgreSQL has (MAINTAIN from 17, checked only there). */
const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

/**
 * What is wrong with writing through this connection (D-067). Checked for
 * both the role in effect (`current_user`) and the role that logged in
 * (`session_user`), since a session that logged in as one role can `SET
 * ROLE` back to it. Each must not:
 * - be, or be a member (MEMBER, so NOINHERIT members who can `SET ROLE`
 *   count) of, any role that is a superuser, can create roles or bypasses
 *   row security;
 * - be a member of a role owning a table or function in `public`, the
 *   `public` schema or the database (an owner can disable the triggers that
 *   guard versions, deletion and the arrangement, or drop them with CASCADE);
 * - be able to `SET session_replication_role` (granted with `GRANT SET ON
 *   PARAMETER` from PostgreSQL 15), which turns ordinary triggers off;
 * - be a member of a predefined role reaching the server's files or
 *   programs or every table (`SERVER_ROLES`);
 * - be able to create objects in `public` (a database upgraded from
 *   PostgreSQL 14 or earlier may still give PUBLIC CREATE there);
 * - hold any table privilege in `public` beyond SELECT and
 *   `WRITER_PRIVILEGES` (TRIGGER would let it add a trigger that runs after
 *   the guards and rewrites what they checked; TRUNCATE, REFERENCES,
 *   MAINTAIN or an extra write likewise), through any role it belongs to.
 * And the role in effect must hold every privilege `grantWriterRole` gives.
 * Empty when the connection is fit to be the service's.
 */
export async function checkWriterConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  const tables = Object.keys(WRITER_PRIVILEGES);
  const pairs = Object.entries(WRITER_PRIVILEGES).flatMap(([table, privileges]) =>
    privileges.map((privilege) => [table, privilege] as const),
  );
  const rows = await db.rows<{
    who: string;
    superuser: boolean;
    owner: boolean;
    createrole: boolean;
    bypass: boolean;
    replication: boolean;
    server: boolean;
    create: boolean;
    extra: string[] | null;
    privileges: boolean;
  }>(sql`
    WITH who(name, current) AS (
      VALUES (current_user::text, true), (session_user::text, false)
    ), allowed(table_name, privilege) AS (
      SELECT * FROM unnest(${pairs.map(([t]) => t)}::text[],
                           ${pairs.map(([, privilege]) => privilege)}::text[])
    ), privileges(privilege) AS (
      SELECT unnest(${TABLE_PRIVILEGES}::text[])
      UNION ALL
      SELECT 'MAINTAIN' WHERE pg_catalog.current_setting('server_version_num')::integer >= 170000
    )
    SELECT w.name AS who,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                   WHERE r.rolsuper AND pg_catalog.pg_has_role(w.name, r.oid, 'MEMBER')) AS superuser,
           (EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND pg_catalog.pg_has_role(w.name, c.relowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public'
                         AND pg_catalog.pg_has_role(w.name, p.proowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                       WHERE n.nspname = 'public'
                         AND pg_catalog.pg_has_role(w.name, n.nspowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d
                       WHERE d.datname = pg_catalog.current_database()
                         AND pg_catalog.pg_has_role(w.name, d.datdba, 'MEMBER'))) AS owner,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                   WHERE r.rolcreaterole AND pg_catalog.pg_has_role(w.name, r.oid, 'MEMBER')) AS createrole,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                   WHERE r.rolbypassrls AND pg_catalog.pg_has_role(w.name, r.oid, 'MEMBER')) AS bypass,
           pg_catalog.has_parameter_privilege(w.name, 'session_replication_role', 'SET') AS replication,
           EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                   WHERE r.rolname = ANY(${SERVER_ROLES}::text[])
                     AND pg_catalog.pg_has_role(w.name, r.oid, 'MEMBER')) AS server,
           pg_catalog.has_schema_privilege(w.name, 'public', 'CREATE') AS "create",
           (SELECT pg_catalog.array_agg(c.relname || ' ' || p.privilege ORDER BY c.relname, p.privilege)
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN privileges p
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND p.privilege <> 'SELECT'
              AND NOT EXISTS (SELECT 1 FROM allowed a
                              WHERE a.table_name = c.relname AND a.privilege = p.privilege)
              AND pg_catalog.has_table_privilege(w.name, c.oid, p.privilege)) AS extra,
           (NOT w.current
            OR (pg_catalog.has_schema_privilege(w.name, 'public', 'USAGE')
                AND (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(w.name, 'public.' || t, 'SELECT'))
                     FROM unnest(${tables}::text[]) AS t)
                AND (SELECT pg_catalog.bool_and(
                              pg_catalog.has_table_privilege(w.name, 'public.' || a.table_name, a.privilege))
                     FROM allowed a))) AS privileges
    FROM who w`);
  const any = (pick: (row: (typeof rows)[number]) => boolean): boolean =>
    rows.length < 2 || rows.some(pick);
  const problems: WriterRoleProblem[] = [];
  const add = (code: WriterRoleProblem["code"], message: string): void => {
    problems.push({ code, message });
  };
  if (any((r) => r.superuser)) {
    add("superuser", "The service's login or role is, or belongs to, a superuser.");
  }
  if (any((r) => r.owner)) {
    add(
      "owner",
      "The service's login or role owns (or belongs to the owner of) the tables, functions, schema or database, and could turn off the triggers that guard history; give it its own login role.",
    );
  }
  if (any((r) => r.createrole)) {
    add("createrole", "The service's login or role can create roles, or belongs to one that can.");
  }
  if (any((r) => r.bypass)) {
    add("bypasses_row_security", "The service's login or role bypasses row security.");
  }
  if (any((r) => r.replication)) {
    add(
      "replication_role",
      "The service's login or role may SET session_replication_role, which turns the guarding triggers off.",
    );
  }
  if (any((r) => r.server)) {
    add(
      "server_access",
      "The service's login or role belongs to a predefined role that reaches the server's files, programs or every table.",
    );
  }
  if (any((r) => r.create)) {
    add("schema_create", "The service's login or role may create objects in schema public.");
  }
  const extra = [...new Set(rows.flatMap((r) => r.extra ?? []))];
  if (rows.length < 2 || extra.length > 0) {
    add(
      "extra_privilege",
      `The service's login or role holds table privileges beyond the writer's: ${extra.join(", ") || "unknown"}.`,
    );
  }
  if (!rows.some((r) => r.privileges) || rows.some((r) => !r.privileges)) {
    add("missing_privilege", "The service's role lacks the writer's privileges (grantWriterRole).");
  }
  return problems;
}
