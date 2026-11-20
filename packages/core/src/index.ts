export { newRecordId, isRecordId, parseRecordId } from "./record-id.js";
export type { RecordId } from "./record-id.js";

export { issue, isPlainObject } from "./issues.js";
export type { Issue, Validated } from "./issues.js";

export {
  RECORD_KINDS,
  ARCHIVAL_LEVELS,
  AGENT_TYPES,
  MAX_TITLE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_FIELD_DEPTH,
  MAX_FIELD_ENTRIES,
  validateRecord,
  createRecord,
  isRecordKind,
  isArchivalLevel,
} from "./records.js";
export type {
  RecordKind,
  ArchivalLevel,
  AgentType,
  FieldValue,
  CatalogRecord,
  ObjectRecord,
  ArchivalUnitRecord,
  DigitalAssetRecord,
  AgentRecord,
  PlaceRecord,
  EventRecord,
  NewRecordInput,
} from "./records.js";

export {
  LEVEL_RANK,
  MAX_ARRANGEMENT_DEPTH,
  canFileUnder,
  validateArrangement,
  unfiledUnits,
} from "./arrangement.js";
