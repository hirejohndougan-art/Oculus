/**
 * @oculus/db: the only package that talks to PostgreSQL (D-050). Every query
 * is written with the `sql` tag; `migrate` applies `packages/db/migrations`;
 * `catalog.ts` reads and writes the catalog tables (every record write with
 * its version, `record-versions.ts`; comparing and restoring versions,
 * `record-restore.ts`), `identifiers.ts` the
 * identifier tables and `vocabularies.ts` the stored terms and the index of
 * which records use them, all through core's validators; `search.ts` is
 * staff search (STAFF ONLY: never for a public site, D-066).
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
export {
  insertOrganization,
  readOrganization,
  insertTemplateVersion,
  readTemplate,
  insertRecordTypeVersion,
  readRecordType,
  insertRecord,
  updateRecord,
  readRecord,
  readStoredRecord,
} from "./catalog.js";
export type {
  StoredTemplate,
  StoredRecordType,
  StoredRecord,
  RecordUpdate,
  RecordUpdateResult,
  VersionConflict,
  ChangedName,
} from "./catalog.js";
export {
  isActorId,
  validateRecordChange,
  readVersion,
  readVersions,
  compareVersions,
  DEFAULT_VERSION_LIST_LIMIT,
  MAX_VERSION_LIST_LIMIT,
  MAX_REASON_LENGTH,
} from "./record-versions.js";
export type {
  RecordChange,
  RecordVersion,
  RecordVersions,
  VersionComparison,
} from "./record-versions.js";
export { restoreVersion, restoreReason } from "./record-restore.js";
export type { RestoreOptions } from "./record-restore.js";
export {
  readIdentifierTypes,
  insertIdentifierType,
  updateIdentifierType,
  saveRecordIdentifiers,
  readRecordIdentifiers,
  allocateIdentifier,
  allocateIdentifiers,
} from "./identifiers.js";
export type { AllocationRequest, StoredRecordIdentifiers } from "./identifiers.js";
export {
  termKey,
  canonicalTermUri,
  saveTerm,
  readTerm,
  readTerms,
  refreshRecordTerms,
  clearRecordTerms,
  termUsageCounts,
  recordsUsingTerm,
  recordsWithStaleTerms,
  DEFAULT_TERM_LIST_LIMIT,
  MAX_TERM_LIST_LIMIT,
} from "./vocabularies.js";
export type {
  StoredTerm,
  StoredTerms,
  TermUsage,
  RecordTerms,
  TermCount,
  TermCounts,
  TermUsers,
  StaleRecords,
} from "./vocabularies.js";
export {
  searchRecords,
  MAX_SEARCH_QUERY_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "./search.js";
export type { SearchHit, SearchResults, SearchOptions, MatchedBy } from "./search.js";
