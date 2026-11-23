/**
 * @oculus/db: the only package that talks to PostgreSQL (D-050). Every query
 * is written with the `sql` tag; `migrate` applies `packages/db/migrations`.
 */
export { sql, joinSql, isSql, Sql, MAX_PARAMETERS } from "./sql.js";
export type { SqlScalar, SqlValue } from "./sql.js";
export { openDatabase, typeParsers } from "./client.js";
export type { Database, DatabaseOptions, Queryable, Row } from "./client.js";
export {
  migrate,
  checkServerVersion,
  readMigrations,
  pendingMigrations,
  defaultMigrationsDir,
  MigrationError,
  OLDEST_MAJOR,
  NEWEST_TESTED_MAJOR,
  MIGRATION_LOCK_KEY,
} from "./migrate.js";
export type { MigrateOptions, MigrateResult, MigrationFile, AppliedMigration } from "./migrate.js";
