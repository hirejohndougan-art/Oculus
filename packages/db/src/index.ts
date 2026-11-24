/**
 * @oculus/db: the only package that talks to PostgreSQL (D-050). Every query
 * is written with the `sql` tag; `migrate` applies `packages/db/migrations`;
 * `catalog.ts` reads and writes the catalog tables (every record write with
 * its version, `record-versions.ts`; comparing and restoring versions,
 * `record-restore.ts`; today's checks before a write, `record-checks.ts`;
 * deleting with a tombstone, `record-delete.ts`; workflow states, the
 * publish check and the public output of published records, `workflow.ts`;
 * the writer role's grants, `roles.ts`), `identifiers.ts` the
 * identifier tables and `vocabularies.ts` the stored terms and the index of
 * which records use them, all through core's validators; `search.ts` is
 * staff search (STAFF ONLY: never for a public site, D-066); `accounts.ts`
 * users, invitations and password sign-in (D-068); `sessions.ts` sessions
 * (D-069; promotion past the second step is internal, for T-038 only).
 */
export { sql, joinSql, isSql, Sql, MAX_PARAMETERS } from "./sql.js";
export type { SqlScalar, SqlValue } from "./sql.js";
export { openDatabase, typeParsers, ConnectionLostError } from "./client.js";
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
  readRecordPlace,
  lockArrangement,
  lockRecord,
  lockDefinition,
  versionConflict,
} from "./catalog.js";
export type {
  StoredTemplate,
  StoredRecordType,
  StoredRecord,
  RecordUpdate,
  RecordUpdateResult,
  VersionConflict,
  ChangedName,
  RecordPlace,
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
  RecordAction,
  RecordChange,
  RecordVersion,
  RecordVersions,
  VersionComparison,
} from "./record-versions.js";
export { restoreVersion, restoreReason, MAX_DESCENDANTS_WALKED } from "./record-restore.js";
export { recordCheckIssues, fixedMessages, linkedIds } from "./record-checks.js";
export type { RecordCheckOptions } from "./record-checks.js";
export { deleteRecord } from "./record-delete.js";
export {
  changeWorkflowState,
  publishCheckIssues,
  readPublicRecord,
  readWorkflowState,
} from "./workflow.js";
export type { PublicRecordOptions, WorkflowChangeResult } from "./workflow.js";
export type { RecordDeletion, RecordDeletionResult } from "./record-delete.js";
export {
  grantWriterRole,
  checkWriterConnection,
  WRITER_GRANTS,
  WRITER_PRIVILEGES,
} from "./roles.js";
export type { WriterRoleProblem } from "./roles.js";
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
export {
  createFirstSystemAdmin,
  createInvitation,
  revokeInvitation,
  acceptInvitation,
  acceptInvitationForUser,
  signIn,
  clearSignInThrottle,
  deleteExpiredSignInThrottles,
  INVALID_CREDENTIALS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  ACCOUNT_TABLE_PRIVILEGES,
} from "./accounts.js";
export type {
  FirstSystemAdmin,
  InvitationRequest,
  InvitationMessage,
  InvitationDelivery,
  InvitationOptions,
  CreatedInvitation,
  InvitationAcceptance,
  SignInRequest,
  SignInSuccess,
  SignInFailure,
  SignInResult,
  Membership,
} from "./accounts.js";
export {
  beginSession,
  readPendingSession,
  resolveSession,
  rotateSession,
  switchOrganization,
  listSessions,
  endSession,
  endOwnSession,
  endOtherSessions,
  endUserSessions,
  deleteExpiredSessions,
  runCleanup,
  NO_SESSION,
  MAX_LISTED_SESSIONS,
  SESSION_TABLE_PRIVILEGES,
} from "./sessions.js";
export type {
  NoSession,
  SessionFailure,
  SessionCallOptions,
  FullSession,
  PendingSession,
  IssuedSession,
  SessionSummary,
  SessionStart,
  SessionOptions,
  ResolveOptions,
  PromotionRefusal,
  CleanupResult,
} from "./sessions.js";
export {
  completeSecondStep,
  startEnrolment,
  confirmEnrolment,
  reauthenticate,
  regenerateRecoveryCodes,
  secondFactorStatus,
  resetSecondFactor,
  resealSecondFactorSecrets,
  SecondStepDatabaseError,
  SECOND_FACTOR_TABLE_PRIVILEGES,
  DEFAULT_TOTP_ISSUER,
  MAX_ENROLMENT_STARTS,
  TOTP_CHAIN_LENGTH,
  ENROLMENT_TOKEN_SECONDS,
} from "./second-factor.js";
export type {
  SecondStepRefusal,
  SecondStepInput,
  EnrolmentStart,
  EnrolmentOptions,
  EnrolmentDone,
  ReauthenticationInput,
  SecondFactorStatus,
  ResealResult,
  EnrolmentMessage,
  EnrolmentDelivery,
} from "./second-factor.js";
export {
  loadSecretKeyring,
  isSecretKeyring,
  SecretKeyError,
  SECRET_KEY_VARIABLE,
  PREVIOUS_SECRET_KEYS_VARIABLE,
} from "./secret-key.js";
export type { SecretKeyring } from "./secret-key.js";
