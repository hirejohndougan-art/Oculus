/**
 * @oculus/service: the one writer of records and their related rows
 * (T-032, D-067), checking who may do what in the same transaction (T-041,
 * D-072). No HTTP here; `packages/api` wraps it (T-042).
 */
export { createService } from "./service.js";
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
  WorkflowOptions,
  WorkflowChange,
  PublicChange,
  PublicChangeRequest,
} from "./service.js";
export { contextFromSession, NOT_PERMITTED_MESSAGE } from "./access.js";
export type { SessionLike } from "./access.js";
export type { AdminOperations, MyAccess, RoleRequest } from "./admin.js";
