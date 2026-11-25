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
 * (D-069; promotion past the second step is internal, for T-038 only);
 * `permissions.ts` sites, role assignments, System settings and a person's
 * access, read under locks (D-072).
 */
export { sql, joinSql, isSql, Sql, MAX_PARAMETERS } from "./sql.js";
export type { SqlScalar, SqlValue } from "./sql.js";
export {
  openDatabase,
  typeParsers,
  ConnectionLostError,
  isDatabaseTimeout,
  createDatabase,
  dropDatabase,
} from "./client.js";
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
  readVersionSummaries,
  compareVersions,
  DEFAULT_VERSION_LIST_LIMIT,
  MAX_VERSION_LIST_LIMIT,
  MAX_REASON_LENGTH,
} from "./record-versions.js";
export type {
  RecordAction,
  RecordChange,
  RecordVersion,
  RecordVersionSummary,
  RecordVersions,
  VersionComparison,
} from "./record-versions.js";
export { restoreVersion, restoreReason, MAX_DESCENDANTS_WALKED } from "./record-restore.js";
export { recordCheckIssues, fixedMessages, linkedIds } from "./record-checks.js";
export type { RecordCheckOptions } from "./record-checks.js";
export { deleteRecord } from "./record-delete.js";
export {
  listPublishedForOai,
  oaiRepository,
  oaiStoredStamp,
  writeOaiStamps,
  MAX_OAI_CANDIDATES,
  OAI_READ_TIME_LIMIT_MS,
} from "./oai.js";
export type { OaiCandidate, OaiListOptions, OaiReadOptions } from "./oai.js";
export {
  changeWorkflowState,
  publishCheckIssues,
  readPublicRecord,
  readSharedPublicRecord,
  PUBLIC_READ_TIME_LIMIT_MS,
  MAX_PUBLIC_READ_TIME_LIMIT_MS,
  publicValueSources,
  inheritedValues,
  recordDependents,
  recordClosureIds,
  lockRecordsShared,
  readWorkflowState,
  publishedRecordView,
  recordsInState,
  MAX_STATE_LIST_LIMIT,
} from "./workflow.js";
export type {
  InheritedValue,
  PublicRecordOptions,
  SharedHome,
  SharedPublicRecord,
  SharedPublicRecordOptions,
  PublicValueSource,
  StateListEntry,
  WorkflowChangeResult,
} from "./workflow.js";
export {
  publicTermCounts,
  publicTermCountsForStaff,
  publicOutputMarker,
  MAX_PUBLIC_COUNT_RECORDS,
} from "./public-terms.js";
export type {
  PublicTermCount,
  PublicTermCountOptions,
  PublicTermCounts,
  PublicTermCountsForStaff,
} from "./public-terms.js";
export type { RecordDeletion, RecordDeletionResult } from "./record-delete.js";
export {
  grantWriterRole,
  grantIdentityRead,
  identityGrantHint,
  reservedRoleName,
  checkWriterConnection,
  grantPublicReaderRole,
  checkPublicReaderConnection,
  PUBLIC_READER_FUNCTIONS,
  PUBLIC_READER_DEFINERS,
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
  listTemplates,
  readRecordsUsingTemplate,
  publishedAmong,
  publishedHoldingType,
  lockIdentifierType,
  identifierKeyInUse,
  organizationSiteIds,
  MAX_AFFECTED_PUBLISHED,
} from "./definitions.js";
export type { TemplateSummary } from "./definitions.js";
export { readRecordsForChecks } from "./catalog.js";
export {
  publishedUsingTemplate,
  countPublishedUsingTemplate,
  readDublinCoreMapping,
  writeDublinCoreMapping,
} from "./dublin-core-mappings.js";
export type { StoredDublinCoreMapping } from "./dublin-core-mappings.js";
export {
  searchRecords,
  MAX_SEARCH_QUERY_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "./search.js";
export type { SearchHit, SearchResults, SearchOptions, MatchedBy } from "./search.js";
export { listRecords, listRecordTypes, MAX_LIST_LIMIT, MAX_LIST_OFFSET } from "./record-list.js";
export type {
  ListedRecord,
  RecordList,
  RecordListOptions,
  RecordListSort,
  RecordTypeSummary,
} from "./record-list.js";
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
  PERMISSION_TABLE_PRIVILEGES,
  loadAccess,
  lockPersonForRoleChange,
  lockPeopleForRoleChange,
  unitsHolding,
  placesHolding,
  sitesSharedInto,
  insertSite,
  readSite,
  renameSite,
  sitesForPerson,
  insertRoleAssignment,
  readRoleAssignment,
  deleteRoleAssignment,
  listRoleAssignments,
  isAssignmentCursor,
  MAX_ASSIGNMENT_PAGE,
  DEFAULT_ASSIGNMENT_PAGE,
  isMember,
  grantsScopedTo,
  hasRecordsBelow,
  childrenOffSite,
  readSystemSettings,
  writeSystemSettings,
} from "./permissions.js";
export type {
  RecordPosition,
  SiteChoice,
  RoleAssignment,
  RoleAssignmentPage,
  NewRoleAssignment,
  StoredSystemSettings,
} from "./permissions.js";
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
  deleteOldPasswordResets,
  runCleanup,
  WRONG_CODE_MEMORY_SECONDS,
  UNEXPLAINED_TOLD_AFTER_SECONDS,
  NO_SESSION,
  MAX_LISTED_SESSIONS,
  SESSION_TABLE_PRIVILEGES,
} from "./sessions.js";
export {
  requestPasswordReset,
  sendPasswordReset,
  completePasswordReset,
  RESET_REQUESTED,
  MAX_RESET_WORK,
  PASSWORD_RESET_TABLE_PRIVILEGES,
} from "./password-resets.js";
export type {
  PasswordResetMessage,
  PasswordResetDelivery,
  PasswordChangedDelivery,
  PasswordChangedMessage,
  ResetOutcome,
  ResetRequestOptions,
  ResetRequest,
  ResetRequestReply,
  AdminResetOptions,
  ResetCompletion,
} from "./password-resets.js";
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
export {
  pendingSignInState,
  organizationChoices,
  readSignedInPerson,
  MAX_ORGANIZATION_CHOICES,
} from "./sign-in-screens.js";
export type { PendingSignInState, OrganizationChoice, SignedInPerson } from "./sign-in-screens.js";
export {
  FILE_SCAN_TABLE_PRIVILEGES,
  SCAN_FAILURES,
  SCAN_STATES,
  claimDueScan,
  isScanSignature,
  queueScan,
  queueUnscanned,
  recordScanResult,
  rescanContents,
  scanCounts,
  scanState,
  scanStates,
} from "./file-scans.js";
export type {
  ClaimedScan,
  RecordedScan,
  ScanCounts,
  ScanFailure,
  ScanResult,
  ScanState,
  StoredScan,
} from "./file-scans.js";
export {
  STORED_FILE_TABLE_PRIVILEGES,
  MAX_FILES_PER_LIST,
  findStoredFile,
  insertStoredFile,
  listStoredFiles,
  storedFileById,
  lockOrganizationFiles,
  organizationFileBytes,
  organizationHasContent,
  deleteStoredFile,
  namedContents,
  findStoredFileById,
  insertStoredFileEvent,
  purgeCandidates,
  readFileStoreLease,
  lockFileStoreLease,
  insertFileStoreEpoch,
  databaseIdentity,
  identityKnown,
  currentFingerprint,
  TRASH_GRACE_SECONDS,
  trashedContents,
  insertFilePurgeStep,
  existingOrganizations,
  readFileStoreBinding,
  insertFileStoreBinding,
  REMOVED_FILE_GRACE_SECONDS,
} from "./stored-files.js";
export type {
  NewStoredFile,
  StoredFile,
  StoredFileEventKind,
  PurgeCandidate,
  TrashedContent,
  FileStoreLease,
} from "./stored-files.js";
export {
  sendSecondStepAlertNotices,
  ALERT_NOTICE_TABLE_PRIVILEGES,
  ALERT_NOTICE_WINDOW_SECONDS,
  ALERT_NOTICE_BATCH,
  ALERT_SUMMARY_LINES,
} from "./alert-notices.js";
export type {
  SecondStepAlertMessage,
  SecondStepAlertDelivery,
  AlertedPerson,
  AlertNoticeRun,
  AlertNoticeOptions,
} from "./alert-notices.js";
export {
  actingSession,
  listMembers,
  readMember,
  memberGrants,
  membersGrants,
  memberSessions,
  memberSecondStep,
  setAccountDisabled,
  databaseNow,
  invitationMadeSince,
  insertPeopleEvent,
  readAuditTrail,
  isAuditCursor,
  PEOPLE_EVENT_KINDS,
  PEOPLE_TABLE_PRIVILEGES,
  MAX_MEMBERS,
  MEMBER_ALERTS_LISTED,
  MAX_AUDIT_PAGE,
  DEFAULT_AUDIT_PAGE,
} from "./people.js";
export type {
  Member,
  MemberGrant,
  MemberSession,
  MemberSecondStep,
  NewPeopleEvent,
  PeopleEventKind,
  AuditFilter,
  AuditScope,
  AuditEntry,
  AuditPage,
} from "./people.js";
export {
  STARTER_TEMPLATE_FIELDS,
  STARTER_TEMPLATE_KEY,
  databaseBeforeSetup,
  isEmptyInstall,
  setUpFirstInstall,
} from "./first-setup.js";
export type { FirstInstall, FirstInstallResult } from "./first-setup.js";
export {
  SHARE_STATES,
  SHARE_TABLE_PRIVILEGES,
  MAX_SHARE_PAGE,
  MAX_OPEN_OFFERS,
  DECLINE_COOLDOWN_DAYS,
  SHARE_OFFER_LIMIT_STATE,
  SHARE_COOLDOWN_STATE,
  SHARE_CHANGED,
  insertShare,
  isShareId,
  liveShare,
  lockShare,
  moveShare,
  readShare,
  sharedItemViews,
  sharesIntoSite,
  sharesOfRecord,
} from "./shares.js";
export type { Share, SharePageOptions, ShareState, SharedItemView } from "./shares.js";
export {
  ACCESSION_TABLE_PRIVILEGES,
  MAX_ACCESSION_PAGE,
  accessionUses,
  accessionsProducing,
  deleteDonorContact,
  insertAccession,
  listAccessions,
  lockAccessionHolds,
  sitesBelow,
  numberUsedBefore,
  readAccession,
  readAccessionHolds,
  readAccessionRecords,
  publishedBelow,
  readDonorContact,
  saveDonorContact,
  updateAccession,
} from "./accessions.js";
export type { SaveOutcome, StoredAccession, StoredDonorContact } from "./accessions.js";
export {
  STORAGE_TABLE_PRIVILEGES,
  storageNow,
  insertStorageMove,
  lockStorage,
  readStorage,
  saveStorageLevels,
  saveStorageLocation,
  storageUses,
} from "./storage.js";
export type { StorageSaveOutcome, StoredDefinition, StoredStorage } from "./storage.js";
export {
  SYSTEM_EVENT_KINDS,
  SYSTEM_EVENT_TABLE_PRIVILEGES,
  insertSystemEvent,
} from "./system-events.js";
export type { NewFilePurgeEvent, NewSystemEvent, SystemEventKind } from "./system-events.js";
export { runSetupCli, terminalAsk } from "./setup-cli.js";
export type { Ask } from "./setup-cli.js";
export { backup, BackupError } from "./backup.js";
export type { BackupOptions, BackupResult } from "./backup.js";

export {
  looksLikeTimeZone,
  readOrganizationTimeZone,
  writeOrganizationTimeZone,
} from "./organization-time-zone.js";
// T-034f (D-120): candidates for the access-holds pass.
export {
  MAX_HOLD_CANDIDATES,
  changedAboveSince,
  lockRecordState,
  organizationDay,
  organizationIds,
  publishedPerhapsHeld,
  withdrawnBy,
} from "./access-holds.js";
