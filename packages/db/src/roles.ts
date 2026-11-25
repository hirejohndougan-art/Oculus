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
import { SHARE_TABLE_PRIVILEGES } from "./shares.js";
import { SYSTEM_EVENT_TABLE_PRIVILEGES } from "./system-events.js";
import { ACCOUNT_TABLE_PRIVILEGES } from "./accounts.js";
import { PEOPLE_TABLE_PRIVILEGES } from "./people.js";
import { PERMISSION_TABLE_PRIVILEGES } from "./permissions.js";
import type { Queryable } from "./client.js";
import { PASSWORD_RESET_TABLE_PRIVILEGES } from "./password-resets.js";
import { SECOND_FACTOR_TABLE_PRIVILEGES } from "./second-factor.js";
import { ALERT_NOTICE_TABLE_PRIVILEGES } from "./alert-notices.js";
import { SESSION_TABLE_PRIVILEGES } from "./sessions.js";
import { STORED_FILE_TABLE_PRIVILEGES } from "./stored-files.js";
import { FILE_SCAN_TABLE_PRIVILEGES } from "./file-scans.js";
import { ACCESSION_TABLE_PRIVILEGES } from "./accessions.js";
import { STORAGE_TABLE_PRIVILEGES } from "./storage.js";
import { CUSTOM_ROLE_TABLE_PRIVILEGES } from "./custom-roles.js";
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
  // T-050b (D-096): one current mapping per template, replaced in place.
  dublin_core_mappings: ["INSERT", "UPDATE"],
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
  // Accounts (D-068): sign-in time and re-hash, accepting and revoking
  // invitations, memberships, and the sign-in counters (UPDATE also for
  // their `SELECT … FOR UPDATE`; DELETE when a sign-in succeeds and for the
  // cleanup). Nothing deletes users, invitations or memberships.
  ...ACCOUNT_TABLE_PRIVILEGES,
  // Sites, role assignments and System settings (D-072): sites are made and
  // renamed, never deleted; a role is granted by INSERT and revoked by
  // DELETE, never changed in place; the one System settings row is made
  // once and then updated.
  ...PERMISSION_TABLE_PRIVILEGES,
  // Sessions (D-069): made at sign-in and on a change of organization,
  // refreshed, promoted and rotated, deleted at sign-out and by the cleanup.
  ...SESSION_TABLE_PRIVILEGES,
  // Password reset links (D-078): made, used and revoked, deleted by the
  // cleanup. Their counters are in sign_in_throttles (above).
  ...PASSWORD_RESET_TABLE_PRIVILEGES,
  // Two-step sign-in (D-077): factors set up, moved and reset; passes and
  // recovery codes written (codes also used and superseded); the wrong-code
  // counters. Nothing deletes a factor, a pass or a recovery code.
  ...SECOND_FACTOR_TABLE_PRIVILEGES,
  // Stored files (M-002, D-086): attached by INSERT; rows never change and
  // nothing deletes them yet.
  ...STORED_FILE_TABLE_PRIVILEGES,
  // Virus scan results (S-040, D-113): queued, then moved along; never
  // deleted, and an infected content never changed back (0048's guard).
  ...FILE_SCAN_TABLE_PRIVILEGES,
  // Accessions and donor contacts (T-018c, D-114): accessions are made and
  // changed, never deleted; a contact may be deleted. Their produced-records
  // list and history are the migration's trigger's.
  ...ACCESSION_TABLE_PRIVILEGES,
  // Storage (T-018d, D-115): levels and locations made and changed, never
  // deleted; moves insert only (a mistake is put right by a later move).
  ...STORAGE_TABLE_PRIVILEGES,
  // The change log of people and roles (T-048, D-084): insert only.
  ...PEOPLE_TABLE_PRIVILEGES,
  // Custom roles (T-041a, D-121): made, changed and deleted (only while
  // nobody holds one, 0057's guard); their change log insert only.
  ...CUSTOM_ROLE_TABLE_PRIVILEGES,
  // Two-step alert notices (D-085): one row per alert, only ever added.
  ...ALERT_NOTICE_TABLE_PRIVILEGES,
  // Shares between sites (T-041b, D-094): offered, then moved along their
  // life; never deleted by the writer (rows go with their record).
  ...SHARE_TABLE_PRIVILEGES,
  // Installs and rollbacks in the change log (T-060a): append-only.
  ...SYSTEM_EVENT_TABLE_PRIVILEGES,
  // Stored OAI-PMH datestamps (S-041, D-108): made and moved by the
  // background pass; a record that stops being shown is marked, never deleted.
  oai_datestamps: ["INSERT", "UPDATE"],
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

/**
 * `public` (every role) and `pg_` names (PostgreSQL's own roles), in any
 * case: never a writer, never given a grant (S-052 third review).
 */
export function reservedRoleName(role: string): boolean {
  const name = role.toLowerCase();
  return name === "public" || name.startsWith("pg_");
}

/** A role name `grantWriterRole` takes: lower case, digits and `_`, up to 63 characters. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Gives `role` the writer's privileges (`WRITER_GRANTS`) in the connected
 * database. Run as the owner of the tables (the migrating role), in a
 * transaction. The role must exist. Also tries `grantIdentityRead`, which
 * only a superuser (or a role holding that grant with its option) can do:
 * `identityReadable` says whether the role can now read the cluster's
 * system identifier, which the purge of removed files needs (S-052).
 */
export async function grantWriterRole(
  db: Queryable,
  role: string,
): Promise<{ readonly identityReadable: boolean }> {
  if (!ROLE_NAME.test(role)) {
    throw new TypeError("A role name is lower case letters, digits and _, at most 63 characters.");
  }
  if (reservedRoleName(role)) {
    throw new TypeError("PUBLIC and pg_ roles are never Oculus's writer.");
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
  return { identityReadable: await grantIdentityRead(db, role) };
}

/**
 * The line to show when `grantIdentityRead` couldn't make its grant
 * (S-052, D-086): nothing fails over it, but the purge refuses until then.
 */
export function identityGrantHint(role: string): string {
  return `Purging removed files will answer identity_unknown until a superuser runs, in this database: GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role};`;
}

/**
 * Lets `role` (default: the connected role) read the cluster's system
 * identifier, `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()`, in
 * the connected database (S-052): without it the database's identity is
 * only `-:<oid>`, which a restore into a fresh cluster shares, and the purge
 * of removed files refuses (`identity_unknown`). Only a superuser can grant
 * it; for anyone else it changes nothing and never fails (safe inside a
 * transaction). Returns whether the role can read it now.
 */
export async function grantIdentityRead(db: Queryable, role?: string): Promise<boolean> {
  const [who] = await db.rows<{ name: string }>(sql`SELECT current_user::text AS name`);
  const target = role ?? who?.name ?? "";
  if (reservedRoleName(target)) throw new TypeError("PUBLIC and pg_ roles are never given this.");
  const [already] = await db.rows<{ ok: boolean }>(sql`
    SELECT pg_catalog.has_function_privilege(${target}, 'pg_catalog.pg_control_system()', 'EXECUTE')
      AS ok`);
  if (already?.ok === true) return true;
  await db.rows(sql`SELECT set_config('oculus.grant_role', ${target}, true)`);
  await db.execute(sql`DO $$ BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO %I',
                   current_setting('oculus.grant_role'));
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END $$`);
  const [now] = await db.rows<{ ok: boolean }>(sql`
    SELECT pg_catalog.has_function_privilege(${target}, 'pg_catalog.pg_control_system()', 'EXECUTE')
      AS ok`);
  return now?.ok === true;
}

/** What `checkWriterConnection` finds wrong with the connection's role. */
export interface WriterRoleProblem {
  readonly code:
    | "superuser"
    | "createrole"
    | "bypasses_row_security"
    | "replication"
    | "replication_role"
    | "role_setting"
    | "role_membership"
    | "owner"
    | "owns_object"
    | "object_privilege"
    | "extra_privilege"
    | "column_privilege"
    | "default_privilege"
    | "database_create"
    | "schema_create"
    | "parameter_privilege"
    | "trigger_not_always"
    | "subscription"
    | "security_definer_function"
    | "missing_privilege";
  readonly message: string;
}

/**
 * Settings a deployment may give the writer with `ALTER ROLE … SET`: time
 * limits and the name it shows. Any other setting on the writer's role (in
 * this database or all) is refused; on all roles, only
 * `session_replication_role` is.
 */
export const ALLOWED_ROLE_SETTINGS: readonly string[] = Object.freeze([
  "lock_timeout",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "idle_session_timeout",
  "transaction_timeout",
  "application_name",
]);

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
 * It must also own nothing anywhere in this database or shared
 * (`pg_shdepend`: subscriptions, large objects, servers, publications …),
 * hold privileges on nothing but public's tables, schema public and
 * databases, have no GRANT OPTION (on tables, any database or schema
 * public: it could hand its privileges on), and have no session settings
 * but `ALLOWED_ROLE_SETTINGS` (nor may every role have
 * `session_replication_role` set). Temporary objects of its sessions are
 * not counted as owned. This session must not be in replica mode, every
 * non-internal trigger on public's tables must be ALWAYS
 * (`trigger_not_always`), and the database must have no subscription
 * (`subscription`). And the role in effect must hold every privilege
 * `grantWriterRole` gives. Empty when the connection is fit to be the service's. Run it at
 * startup and after every migration (new tables, new default privileges).
 */
export async function checkWriterConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  return checkRoleConnection(db, {
    selectAll: true,
    privileges: WRITER_PRIVILEGES,
    functions: [],
    noun: "writer",
    grant: "grantWriterRole",
  });
}

/** What a connection's role may hold, for `checkRoleConnection`. */
interface RoleProfile {
  /** SELECT on every table in `public` (the writer) or on none (the public reader). */
  readonly selectAll: boolean;
  /** Table privileges beyond SELECT, which the role must hold exactly. */
  readonly privileges: Readonly<Record<string, readonly string[]>>;
  /** Functions (with their argument types) the role must be able to EXECUTE. */
  readonly functions: readonly string[];
  readonly noun: string;
  readonly grant: string;
  /**
   * When set, every SECURITY DEFINER function the role can execute (through
   * PUBLIC or a grant, in any schema) must be in this list
   * (`schema.name(argument types)`); others are `security_definer_function`.
   */
  readonly definers?: readonly string[];
}

async function checkRoleConnection(
  db: Queryable,
  profile: RoleProfile,
): Promise<WriterRoleProblem[]> {
  const { noun } = profile;
  const tables = profile.selectAll ? Object.keys(profile.privileges) : [];
  const pairs = Object.entries(profile.privileges).flatMap(([table, privileges]) =>
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
    replica: boolean;
    settings: string[] | null;
    owns: string[] | null;
    objects: string[] | null;
    triggers: string[] | null;
    subscriptions: string[] | null;
    definers: string[] | null;
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
                     || CASE WHEN (t.acl).grantee = 0 THEN ' (PUBLIC)' ELSE '' END
                     || CASE WHEN (t.acl).is_grantable THEN ' (grant option)' ELSE '' END)
            FROM public_tables t
            WHERE (t.acl).grantee IN (w.oid, 0)
              AND NOT ((t.acl).grantee = w.oid AND t.relkind <> 'S' AND NOT (t.acl).is_grantable
                       AND ((${profile.selectAll}::boolean AND (t.acl).privilege_type = 'SELECT')
                            OR EXISTS (SELECT 1 FROM allowed a
                                       WHERE a.table_name = t.relname
                                         AND a.privilege = (t.acl).privilege_type))))
           -- A grant option on any database or on schema public (S-015): it
           -- could hand CONNECT, TEMPORARY or USAGE on to other roles. PUBLIC
           -- can't hold grant options.
           || ARRAY(SELECT 'database ' || d.datname || ' ' || x.privilege_type || ' (grant option)'
                    FROM pg_catalog.pg_database d,
                         pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) AS x
                    WHERE x.grantee = w.oid AND x.is_grantable)
           || ARRAY(SELECT 'schema public ' || x.privilege_type || ' (grant option)'
                    FROM pg_catalog.pg_namespace n,
                         pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS x
                    WHERE n.nspname = 'public' AND x.grantee = w.oid AND x.is_grantable) AS extra,
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
           -- CREATE on any schema: triggers pin search_path, but owner
           -- sessions (migrations, backups) use the default one.
           EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                          pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS x
                   WHERE x.grantee IN (w.oid, 0) AND x.privilege_type = 'CREATE') AS schema_create,
           -- pg_parameter_acl exists from PostgreSQL 15, the oldest supported (D-049).
           (SELECT pg_catalog.array_agg(DISTINCT p.parname || ' ' || x.privilege_type)
            FROM pg_catalog.pg_parameter_acl p, pg_catalog.aclexplode(p.paracl) AS x
            WHERE x.grantee IN (w.oid, 0)) AS parameters,
           -- This session must not be in replica mode, where ordinary
           -- triggers and foreign keys don't fire.
           pg_catalog.current_setting('session_replication_role') <> 'origin' AS replica,
           -- Settings applied to new sessions of the role (or of every role)
           -- in this database or in all.
           (SELECT pg_catalog.array_agg(DISTINCT c.setting)
            FROM pg_catalog.pg_db_role_setting d
            CROSS JOIN LATERAL unnest(d.setconfig) AS c(setting)
            WHERE d.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database
                                        WHERE datname = pg_catalog.current_database()))
              AND ((d.setrole = w.oid
                    AND pg_catalog.split_part(c.setting, '=', 1) <> ALL(${ALLOWED_ROLE_SETTINGS}::text[]))
                   OR (d.setrole = 0
                       AND pg_catalog.split_part(c.setting, '=', 1) = 'session_replication_role'))) AS settings,
           -- Anything it owns, in this database or shared (subscriptions,
           -- schemas, large objects, servers, publications, databases …).
           -- Temporary objects (pg_temp_N, pg_toast_temp_N, and the schemas
           -- a crashed session left behind) are left out (S-015): a writer
           -- session using a temporary table must not make startup fail, and
           -- they are visible to their own session only and dropped with it.
           (SELECT pg_catalog.array_agg(DISTINCT d.classid::pg_catalog.regclass::text || ' ' || d.objid::text)
            FROM pg_catalog.pg_shdepend d
            WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
              AND d.refobjid = w.oid AND d.deptype = 'o'
              AND d.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database
                                 WHERE datname = pg_catalog.current_database()))
              AND NOT (d.dbid <> 0
                       AND COALESCE((pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema, '')
                           OPERATOR(pg_catalog.~) '^pg_(toast_)?temp_[0-9]+$')) AS owns,
           -- Privileges on anything but public's tables (their columns are the
           -- column check's), schema public and databases (pg_shdepend lists
           -- non-default ACL entries only; parameters are listed here too).
           (SELECT pg_catalog.array_agg(DISTINCT d.classid::pg_catalog.regclass::text || ' ' || d.objid::text)
            FROM pg_catalog.pg_shdepend d
            WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
              AND d.refobjid = w.oid AND d.deptype = 'a'
              AND d.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database
                                 WHERE datname = pg_catalog.current_database()))
              AND NOT (d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass)
              AND NOT (d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                       AND d.objid = 'public'::pg_catalog.regnamespace::oid)
              AND NOT (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                       AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                                   WHERE c.oid = d.objid
                                     AND c.relnamespace = 'public'::pg_catalog.regnamespace))) AS objects,
           -- Every non-internal trigger on public's tables must fire ALWAYS
           -- (D-067, S-015): ORIGIN, REPLICA or disabled ones don't guard
           -- every session. Not per role, so the same on both rows.
           (SELECT pg_catalog.array_agg(c.relname || '.' || t.tgname ORDER BY c.relname, t.tgname)
            FROM pg_catalog.pg_trigger t
            JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = 'public'::pg_catalog.regnamespace
              AND NOT t.tgisinternal AND t.tgenabled <> 'A') AS triggers,
           -- Any subscription in this database, whoever owns it (S-015): its
           -- apply worker runs in replica mode. Only the names are read
           -- (subconninfo is not readable by PUBLIC).
           (SELECT pg_catalog.array_agg(s.subname::text ORDER BY s.subname)
            FROM pg_catalog.pg_subscription s
            WHERE s.subdbid = (SELECT oid FROM pg_catalog.pg_database
                               WHERE datname = pg_catalog.current_database())) AS subscriptions,
           -- SECURITY DEFINER functions the role can run, beyond the allowed
           -- ones (S-019 review): each runs with its owner's privileges.
           (SELECT pg_catalog.array_agg(f.name ORDER BY f.name)
            FROM (SELECT n.nspname || '.' || p.proname || '('
                         || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS name
                  FROM pg_catalog.pg_proc p
                  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  -- A trigger function can't be called by itself (T-018c).
                  WHERE p.prosecdef AND ${profile.definers !== undefined}::boolean
                    AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
                    AND pg_catalog.has_function_privilege(w.oid, p.oid, 'EXECUTE')) AS f
            WHERE f.name <> ALL(${[...(profile.definers ?? [])]}::text[])) AS definers,
           (NOT w.current
            OR (pg_catalog.has_schema_privilege(w.oid, 'public', 'USAGE')
                AND COALESCE((SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(w.oid, 'public.' || t, 'SELECT'))
                              FROM unnest(${tables}::text[]) AS t), true)
                AND COALESCE((SELECT pg_catalog.bool_and(
                                       pg_catalog.has_table_privilege(w.oid, 'public.' || a.table_name, a.privilege))
                              FROM allowed a), true)
                AND COALESCE((SELECT pg_catalog.bool_and(
                                       pg_catalog.has_function_privilege(w.oid, f, 'EXECUTE'))
                              FROM unnest(${[...profile.functions]}::text[]) AS f), true))) AS privileges
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
  if (rows.some((r) => r.replica)) {
    add(
      "replication_role",
      "This session runs with session_replication_role other than origin, where the guarding triggers and foreign keys don't fire.",
    );
  }
  const settings = all((r) => r.settings);
  if (settings.length > 0) {
    add("role_setting", `Settings applied to the service's sessions: ${listed(settings)}.`);
  }
  if (any((r) => r.memberships > 0)) {
    add(
      "role_membership",
      `The service's login or role is a member of another role; the ${noun} must be a plain role that belongs to none.`,
    );
  }
  if (any((r) => r.owner)) {
    add(
      "owner",
      "The service's login or role owns the tables, functions, schema or database, and could turn off the triggers that guard history; give it its own login role.",
    );
  }
  const owns = all((r) => r.owns);
  if (owns.length > 0)
    add("owns_object", `Objects the service's login or role owns: ${listed(owns)}.`);
  const objects = all((r) => r.objects);
  if (objects.length > 0) {
    add("object_privilege", `Privileges on objects besides public's tables: ${listed(objects)}.`);
  }
  const extra = all((r) => r.extra);
  if (unknown || extra.length > 0) {
    add("extra_privilege", `Privileges beyond the ${noun}'s: ${listed(extra)}.`);
  }
  const triggers = all((r) => r.triggers);
  if (triggers.length > 0) {
    add(
      "trigger_not_always",
      `Triggers that don't fire in every session (ENABLE ALWAYS TRIGGER them): ${listed(triggers)}.`,
    );
  }
  const subscriptions = all((r) => r.subscriptions);
  if (subscriptions.length > 0) {
    add(
      "subscription",
      `Subscriptions in this database, whose apply workers skip ordinary triggers: ${listed(subscriptions)}.`,
    );
  }
  const definers = all((r) => r.definers);
  if (definers.length > 0) {
    add(
      "security_definer_function",
      `Functions that run with their owner's privileges, which the ${noun} may call: ${listed(definers)}.`,
    );
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
    add(
      "missing_privilege",
      `The service's role lacks the ${noun}'s privileges (${profile.grant}).`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The public reader (S-019, D-080)

/**
 * The functions the public sites read through, with their argument types:
 * `public_record_snapshot` (0017) and `public_dublin_core_mapping` (0022,
 * D-096), the only ways `readPublicRecord` reads.
 */
export const PUBLIC_READER_FUNCTIONS: readonly string[] = Object.freeze([
  "public.public_record_snapshot(uuid, uuid, uuid)",
  // T-050b (D-096): a public record's stored Dublin Core mapping.
  "public.public_dublin_core_mapping(uuid, uuid, uuid)",
  // T-034e (D-103): an organization's local day, for the accession register.
  "public.organization_local_day(uuid)",
  // T-041f (D-111): where an item shared into a public site lives.
  "public.shared_record_home(uuid, uuid, uuid)",
]);

/**
 * The only SECURITY DEFINER functions the public reader may be able to run
 * (`checkPublicReaderConnection`): its own read path, and 0014's
 * `second_step_next_order` (PUBLIC may call it; doing so only skips
 * numbers of an ordering sequence, D-077).
 */
export const PUBLIC_READER_DEFINERS: readonly string[] = Object.freeze([
  ...PUBLIC_READER_FUNCTIONS,
  "public.second_step_next_order()",
]);

/**
 * Gives `role` what the public sites need to read (S-019, D-080): USAGE on
 * schema `public`, and **no table privilege at all**. EXECUTE on
 * `PUBLIC_READER_FUNCTIONS` is PUBLIC's, as for every function (an explicit
 * grant would be an object privilege the allowlist refuses, and a revoke
 * from PUBLIC one a backup won't restore, D-064). So a public site's
 * connection can read nothing but the output of records public on a site:
 * no staff tables, accounts, sessions or second factors. Run as the owner,
 * in a transaction. The role must exist and should hold nothing else:
 * check it with `checkPublicReaderConnection`.
 */
export async function grantPublicReaderRole(db: Queryable, role: string): Promise<void> {
  if (!ROLE_NAME.test(role)) {
    throw new TypeError("A role name is lower case letters, digits and _, at most 63 characters.");
  }
  await db.rows(sql`SELECT set_config('oculus.grant_role', ${role}, true)`);
  await db.execute(sql`DO $$ BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', current_setting('oculus.grant_role'));
  END $$`);
}

/**
 * What is wrong with reading the public sites through this connection
 * (S-019, D-080): `checkWriterConnection`'s allowlist with nothing allowed
 * on any table, not even SELECT, so any table privilege (to the role or to
 * PUBLIC) is `extra_privilege`; every other rule is the writer's (no
 * attributes, no memberships, owns nothing, no column or default
 * privileges, no CREATE, no parameters, no settings beyond
 * `ALLOWED_ROLE_SETTINGS`, not in replica mode). The role in effect must be
 * able to call `PUBLIC_READER_FUNCTIONS`, and must be able to call no
 * SECURITY DEFINER function but `PUBLIC_READER_DEFINERS`, in any schema
 * (`security_definer_function`): any other would let it read or write with
 * its owner's privileges. Empty when the connection is fit
 * for the public sites; T-050/T-051 run it at startup and after every
 * migration, and refuse to serve when it reports anything.
 */
export async function checkPublicReaderConnection(db: Queryable): Promise<WriterRoleProblem[]> {
  return checkRoleConnection(db, {
    selectAll: false,
    privileges: {},
    functions: PUBLIC_READER_FUNCTIONS,
    noun: "public reader",
    grant: "grantPublicReaderRole",
    definers: PUBLIC_READER_DEFINERS,
  });
}
