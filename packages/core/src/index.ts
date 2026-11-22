export { newRecordId, isRecordId, parseRecordId } from "./record-id.js";
export type { RecordId } from "./record-id.js";

export {
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_SITE_NAME_LENGTH,
  newOrganizationId,
  isOrganizationId,
  parseOrganizationId,
  newSiteId,
  isSiteId,
  parseSiteId,
  validateOrganization,
  validateSite,
} from "./organizations.js";
export type { OrganizationId, SiteId, Organization, Site } from "./organizations.js";

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
  isTemplateKey,
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
  IDENTIFIER_TYPE_KEY_RULE,
  isIdentifierTypeKey,
  validateIdentifierType,
  validateNewIdentifierType,
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
  validateLegacyTemplate,
  legacyTemplateIssues,
  MAX_TEMPLATE_SET,
  checkRecordAgainstTemplate,
  MAX_REGISTRY_TEMPLATES,
  indexTemplates,
  isTemplateRegistry,
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
  TemplateRegistry,
  LegacyTemplateProblem,
} from "./templates.js";

export { TEMPLATE_CHANGE_CODES, MAX_LISTED_RECORDS, templateChanges } from "./template-changes.js";
export type { TemplateChangeCode, TemplateChange, TemplateChanges } from "./template-changes.js";

export {
  IDENTIFIER_TYPE_CHANGE_CODES,
  identifierTypeChanges,
  identifierTypeDeletion,
  identifierTypeCreation,
} from "./identifier-type-changes.js";
export type {
  IdentifierTypeChangeCode,
  IdentifierTypeChange,
  IdentifierTypeChanges,
  IdentifierTypeUse,
} from "./identifier-type-changes.js";

export {
  RIGHTS_FIELD_KEY,
  RIGHTS_REQUIRED_KINDS,
  MAX_RIGHTS_TEXT_LENGTH,
  MAX_RIGHTS_NOTE_LENGTH,
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

export {
  DACS_ARCHIVAL_UNIT_PRESET,
  SPECTRUM_OBJECT_PRESET,
  DIGITAL_ASSET_PRESET,
  STANDARD_PRESETS,
  standardPreset,
  templateFromPreset,
} from "./presets.js";
export type { TemplatePreset } from "./presets.js";

export {
  DCTERMS_NAMESPACE,
  DUBLIN_CORE_TERMS,
  MAX_DUBLIN_CORE_ENTRIES,
  DACS_DUBLIN_CORE,
  SPECTRUM_DUBLIN_CORE,
  DIGITAL_ASSET_DUBLIN_CORE,
  isDublinCoreTerm,
  dublinCoreTermUri,
  validateDublinCoreMapping,
  presetDublinCoreMapping,
  mappingForTemplate,
} from "./dublin-core.js";
export type { DublinCoreTerm, DublinCoreEntry, DublinCoreMapping } from "./dublin-core.js";

export { checkRightsValue, makeIdentifierChecker } from "./field-checkers.js";

export {
  MAX_RECORD_SET,
  indexRecords,
  effectiveRecord,
  publicView,
  effectivePublishIssues,
} from "./effective.js";
export { isEffectiveRecord } from "./effective-brand.js";
export type {
  ChainStep,
  EffectiveField,
  EffectiveRecord,
  EffectiveOptions,
  PublicField,
  PublicRecord,
  TemplateLookup,
  TemplateSource,
  RecordLookup,
} from "./effective.js";

export {
  VOCABULARY_CODES,
  VOCABULARIES,
  MAX_TERM_URI_TEXT_LENGTH,
  vocabulary,
  isLocalTerm,
  validateControlledTerm,
  controlledTermChecker,
  normalizeTermUri,
  termUriKey,
} from "./vocabularies.js";
export type {
  VocabularyCode,
  UriCheck,
  Vocabulary,
  ControlledTerm,
  TermUriChange,
  NormalizedTermUri,
} from "./vocabularies.js";
export {
  DUPLICATE_REASONS,
  MAX_DUPLICATE_TERMS,
  DEFAULT_DUPLICATE_CANDIDATES,
  MAX_DUPLICATE_CANDIDATES,
  MAX_SPELLING_CELLS,
  MAX_ABBREVIATION_WORK,
  MAX_COMPARED_KEY_LENGTH,
  termWords,
  termMatchKey,
  boundedDistance,
  findNearDuplicateTerms,
} from "./term-duplicates.js";
export type {
  DuplicateReason,
  DuplicateCandidate,
  DuplicateReport,
  DuplicateOptions,
  DuplicateLimit,
  SkippedTerm,
} from "./term-duplicates.js";
export {
  DCMITYPE_NAMESPACE,
  RDFS_NAMESPACE,
  DC_ELEMENTS_NAMESPACE,
  OAI_DC_NAMESPACE,
  OAI_DC_SCHEMA,
  MAX_BASE_URL_LENGTH,
  MAX_OUTPUT_CHARS,
  publicOutput,
} from "./public-output.js";
export type { PublishOptions, PublicOutput, DublinCoreValues } from "./public-output.js";
