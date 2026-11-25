/**
 * @oculus/service: the one writer of records and their related rows
 * (T-032, D-067), checking who may do what in the same transaction (T-041,
 * D-072). No HTTP here; `packages/api` wraps it (T-042).
 */
export { createService, MAX_VERSION_PAGE } from "./service.js";
export type {
  RecordService,
  ServiceContext,
  ServiceOptions,
  ServiceResult,
  ServiceRefusal,
  SavedRecord,
  DroppedNumber,
  CreateOptions,
  UpdateOptions,
  IdentifierOptions,
  RestoreOptions,
  DeleteOptions,
  ReadRecord,
  VersionSummary,
  VersionList,
  ReviewQueue,
  WorkflowOptions,
  WorkflowChange,
  PublicChange,
  PublicChangeRequest,
  RecordCheck,
} from "./service.js";
export { identifierTypeTag, MAX_TEMPLATE_RECORDS } from "./definitions.js";
export type {
  DefinitionOperations,
  TemplateVersion,
  TaggedIdentifierType,
  SavedTemplate,
  SavedIdentifierType,
} from "./definitions.js";
export { contextFromSession, NOT_PERMITTED_MESSAGE } from "./access.js";
export type { SessionLike } from "./access.js";
export type { AdminOperations, MyAccess, RoleRequest } from "./admin.js";
export { ADOPT_QUIET_MS, FILE_LEASE_RENEW_MS } from "./files.js";
export {
  openFileStore,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_ORGANIZATION_BYTES,
  MAX_CAP_BYTES,
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_MIN_FREE_FRACTION,
  STORE_MARKER,
} from "./file-store.js";
export type {
  CopyStamp,
  TrashEntry,
  FileStore,
  FileStoreOptions,
  ReceivedFile,
  ReceiveOptions,
  ReceiveRefusal,
  ReceiveResult,
  StoreMarker,
} from "./file-store.js";
export { MAX_THUMBNAIL_SOURCE_BYTES, VIEW_HEADER_BYTES } from "./files.js";
export {
  THUMBNAIL_BOXES,
  THUMBNAIL_LIMITS,
  THUMBNAIL_TYPES,
  VIEW_LIMITS,
  VIEW_TYPES,
  imageDimensions,
  type ThumbnailSize,
} from "./thumbnail-worker.js";
export {
  createThumbnailRenderer,
  type RenderResult,
  type ThumbnailRenderer,
  type ThumbnailRendererOptions,
} from "./thumbnails.js";
export type {
  FileContent,
  FileUse,
  AttachCheck,
  AttachOptions,
  AttachedFile,
  FileOperations,
  FileStoreProblem,
  FileSweep,
  RemoveFileOptions,
} from "./files.js";
export {
  AUTOMATIC_PURGE_EVERY_MS,
  PURGE_ACTOR,
  PURGE_LEASE_MS,
  type PurgeOptions,
  type PurgeProblem,
  type PurgeReport,
  type PurgeResult,
  type PurgeTotals,
} from "./file-purge.js";
export type {
  PeopleOperations,
  PeopleContext,
  PeopleList,
  PeopleRights,
  PersonDetail,
  PersonSummary,
  RoleCatalogEntry,
} from "./people.js";
export type { IncomingShare, ShareOperations, ShareSummary } from "./shares.js";
