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
 * which can disable triggers.
 */
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

/**
 * Exactly what the writer may do to each table, beyond SELECT on every table
 * (D-067): what the data-access functions use, no more. `UPDATE` is there
 * also where only a row lock needs it (`SELECT … FOR SHARE` and the like
 * need UPDATE on the table): `organizations` (locked while an identifier
 * type is added) and `identifier_types` (locked by every save). Nothing
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
    "superuser" | "owner" | "createrole" | "bypasses_row_security" | "missing_privilege";
  readonly message: string;
}

/**
 * What is wrong with writing through this connection's role (D-067). It
 * must not be a superuser; must not be a member (even NOINHERIT, which can
 * still SET ROLE) of a role owning a table in `public`, the `public` schema
 * or the database (an owner can disable the triggers that guard versions,
 * deletion and the arrangement, or drop them with CASCADE); must not be
 * able to create roles; must not bypass row security; and must hold every
 * privilege `grantWriterRole` gives. Empty when the role is fit to be the
 * service's.
 */
export async function checkWriterConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  const tables = Object.keys(WRITER_PRIVILEGES);
  const pairs = Object.entries(WRITER_PRIVILEGES).flatMap(([table, privileges]) =>
    privileges.map((privilege) => [`public.${table}`, privilege] as const),
  );
  const [row] = await db.rows<{
    superuser: boolean;
    owner: boolean;
    createrole: boolean;
    bypass: boolean;
    privileges: boolean;
  }>(sql`
    SELECT r.rolsuper AS superuser,
           (EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public'
                         AND pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                       WHERE n.nspname = 'public'
                         AND pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER'))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d
                       WHERE d.datname = pg_catalog.current_database()
                         AND pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER'))) AS owner,
           r.rolcreaterole AS createrole,
           r.rolbypassrls AS bypass,
           -- One privilege per call: with a list, has_table_privilege is true
           -- if any one of them is held.
           (pg_catalog.has_schema_privilege('public', 'USAGE')
            AND (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(t, 'SELECT'))
                 FROM pg_catalog.unnest(${tables.map((t) => `public.${t}`)}::text[]) AS t)
            AND (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(p.t, p.privilege))
                 -- Multi-array unnest is FROM-clause syntax and can't be schema-qualified.
                 FROM unnest(${pairs.map(([t]) => t)}::text[],
                                        ${pairs.map(([, privilege]) => privilege)}::text[])
                      AS p(t, privilege))) AS privileges
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  const problems: WriterRoleProblem[] = [];
  if (row?.superuser !== false) {
    problems.push({
      code: "superuser",
      message: "The service connects as a superuser; give it its own login role.",
    });
  }
  if (row?.owner !== false) {
    problems.push({
      code: "owner",
      message:
        "The service's role owns (or is a member of the owner of) the tables, functions, schema or database, and could turn off the triggers that guard history; give it its own login role.",
    });
  }
  if (row?.createrole !== false) {
    problems.push({
      code: "createrole",
      message: "The service's role can create roles; it shouldn't.",
    });
  }
  if (row?.bypass !== false) {
    problems.push({
      code: "bypasses_row_security",
      message: "The service's role bypasses row security; it shouldn't.",
    });
  }
  if (row?.privileges !== true) {
    problems.push({
      code: "missing_privilege",
      message: "The service's role lacks the writer's privileges (grantWriterRole).",
    });
  }
  return problems;
}
