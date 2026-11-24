/**
 * @oculus/service: the one writer of records and their related rows
 * (T-032, D-067). No HTTP here; `packages/api` wraps it (T-042).
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
} from "./service.js";
