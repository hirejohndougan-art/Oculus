export { newRecordId, isRecordId, parseRecordId } from "./record-id.js";
export type { RecordId } from "./record-id.js";

export { issue, isPlainObject } from "./issues.js";
export type { Issue, Validated } from "./issues.js";

export { readPlainData, textProblem, IssueList, FORBIDDEN_KEYS } from "./plain-data.js";
export type { JsonValue, ReadLimits } from "./plain-data.js";

export {
  RECORD_KINDS,
  ARCHIVAL_LEVELS,
  AGENT_TYPES,
  MAX_TITLE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_FIELD_DEPTH,
  MAX_FIELD_ENTRIES,
  MAX_RECORD_CHARS,
  MAX_KEY_LENGTH,
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

export {
  MAX_EDTF_LENGTH,
  MAX_SET_MEMBERS,
  MAX_EDTF_YEAR,
  parseEdtf,
  isEdtf,
  compareEdtf,
  dayKey,
  daysInMonth,
  isLeapYear,
} from "./edtf.js";
export type { CalendarDay, EdtfDate, EdtfKind, EdtfLevel } from "./edtf.js";

export { MAX_DATE_TEXT_LENGTH, edtfFromText } from "./edtf-text.js";
export type { EdtfFromText, EdtfFromTextOptions } from "./edtf-text.js";

export {
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_SLOTS,
  MAX_PATTERN_REPEAT,
  PATTERN_HELP,
  parseIdentifierPattern,
  matchesIdentifierPattern,
} from "./identifier-pattern.js";
export type { IdentifierPattern } from "./identifier-pattern.js";
export { identifierKey } from "./identifier-key.js";
export {
  UNIQUENESS_RULES,
  YEAR_SEPARATORS,
  MAX_IDENTIFIER_LENGTH,
  MAX_IDENTIFIER_TYPES,
  MAX_TYPE_LABEL_LENGTH,
  MAX_PREFIX_LENGTH,
  MAX_AUTO_DIGITS,
  MAX_AUTO_NUMBER,
  MAX_CURRENT_IDENTIFIERS,
  MAX_FORMER_IDENTIFIERS,
  MAX_FORMER_NOTE_LENGTH,
  MAX_QUERY_LENGTH,
  validateIdentifierType,
  validateIdentifierTypes,
  validateRecordIdentifiers,
  primaryIdentifier,
  uniquenessIssues,
  findIdentifierConflicts,
  checkNewIdentifier,
  findByIdentifier,
  nextIdentifier,
  retireIdentifier,
  droppedIdentifiers,
} from "./identifiers.js";
export type {
  UniquenessRule,
  YearSeparator,
  AutoNumbering,
  IdentifierType,
  Identifier,
  FormerIdentifier,
  RecordIdentifiers,
  IdentifierMatch,
  DroppedIdentifier,
} from "./identifiers.js";

export {
  FIELD_KINDS,
  FIELD_VISIBILITIES,
  MAX_TEMPLATE_FIELDS,
  MAX_LABEL_LENGTH,
  MAX_HELP_LENGTH,
  MAX_LIST_OPTIONS,
  MAX_ALLOWED_CODES,
  MAX_STANDARD_MAPPINGS,
  MAX_TEXT_LENGTH,
  MAX_LONG_TEXT_LENGTH,
  MAX_REPEATS,
  MAX_URL_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  isFieldKind,
  isFieldKey,
  webUrlProblem,
  validateTemplate,
  checkRecordAgainstTemplate,
} from "./templates.js";
export type {
  FieldKind,
  FieldVisibility,
  StandardMapping,
  ListOption,
  FieldDefinition,
  FieldTemplate,
  FieldProblem,
  FieldValueChecker,
  TemplateCheckOptions,
} from "./templates.js";

export {
  RIGHTS_FIELD_KEY,
  MAX_RIGHTS_TEXT_LENGTH,
  RIGHTS_STATEMENTS,
  CREATIVE_COMMONS,
  RIGHTS_TERMS,
  rightsTerm,
  isRightsUri,
  validateRightsUri,
  normalizeRightsUri,
  rightsPublishIssues,
  canPublishRights,
} from "./rights.js";
export type {
  RightsSource,
  RightsCategory,
  RightsTerm,
  RightsChange,
  NormalizedRights,
} from "./rights.js";
