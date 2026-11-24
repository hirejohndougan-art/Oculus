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
 * The writer's privileges, as statements with `%I` for the role (quoted by
 * PostgreSQL's `format`). D-063's list, plus DELETE on `records` now that a
 * deletion is versioned (0008).
 */
export const WRITER_GRANTS: readonly string[] = Object.freeze([
  "GRANT USAGE ON SCHEMA public TO %I",
  "GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I",
  "GRANT INSERT, UPDATE, DELETE ON public.records TO %I",
  `GRANT INSERT, UPDATE, DELETE ON public.organizations, public.templates, public.record_types,
     public.identifier_types, public.identifier_holdings, public.record_identifiers,
     public.former_identifiers, public.identifier_counters, public.terms,
     public.record_term_index, public.record_terms TO %I`,
  "GRANT INSERT ON public.template_versions, public.record_type_versions, public.record_versions TO %I",
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
  readonly code: "superuser" | "owner" | "bypasses_row_security" | "missing_privilege";
  readonly message: string;
}

/**
 * What is wrong with writing through this connection's role (D-067): it
 * must not be a superuser, must not own (or be a member of the owner of)
 * the catalog tables, which could disable the triggers that guard versions,
 * deletion and the arrangement, must not bypass row security, and must hold
 * the writer's privileges. Empty when the role is fit to be the service's.
 */
export async function checkWriterConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  const [row] = await db.rows<{
    superuser: boolean;
    owner: boolean;
    bypass: boolean;
    privileges: boolean;
  }>(sql`
    SELECT r.rolsuper AS superuser,
           EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'r'
                     AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) AS owner,
           r.rolbypassrls AS bypass,
           -- One privilege per call: with a list, has_table_privilege is true
           -- if any one of them is held.
           (pg_catalog.has_table_privilege('public.records', 'INSERT')
            AND pg_catalog.has_table_privilege('public.records', 'UPDATE')
            AND pg_catalog.has_table_privilege('public.records', 'DELETE')
            AND pg_catalog.has_table_privilege('public.record_versions', 'INSERT')
            AND pg_catalog.has_table_privilege('public.identifier_holdings', 'INSERT')
            AND pg_catalog.has_table_privilege('public.identifier_holdings', 'DELETE')
            AND pg_catalog.has_table_privilege('public.record_terms', 'INSERT')
            AND pg_catalog.has_table_privilege('public.record_terms', 'DELETE')) AS privileges
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
        "The service's role owns the tables (or is a member of their owner) and could turn off the triggers that guard history; give it its own login role.",
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
