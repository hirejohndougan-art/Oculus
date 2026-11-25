/**
 * The service layer: the one writer of records and their related rows
 * (T-032, D-067).
 *
 * Every write of a record, of its identifiers, of its term usages, of its
 * versions and of its place in the arrangement goes through here, and the
 * database role the service connects with is the only one allowed to write
 * (`grantWriterRole`, `checkConnection`). Each operation:
 * - takes the organization and the actor from the **context**, which the
 *   caller (the HTTP layer, T-042) builds from the signed-in session, never
 *   from a request (D-019, D-063). A record, identifier set or draft that
 *   names another organization is refused (`wrong_organization`) before
 *   anything is read, and every lookup is by the context's organization, so
 *   another organization's record is `unknown_record`, exactly as one that
 *   doesn't exist;
 * - runs in **one Read Committed transaction**: the record, its version, its
 *   identifiers, its term usages and the checks all commit together or not at
 *   all. A refusal anywhere rolls the whole transaction back;
 * - runs **today's checks inside that transaction**, after locking what they
 *   check against (`recordCheckIssues`): the template and record type as they
 *   are now, the identifier checker from today's identifier types, the
 *   record link checker over the organization's own records, the record
 *   type's kind, the arrangement (parent level, loops, depth, children's
 *   levels) under the organization's arrangement lock, identifier fields
 *   against the numbers the record holds after the save, and identifier
 *   uniqueness by the database's indexes in the same transaction (D-061);
 * - returns **clean issues**, never a database error's text: refusals come
 *   back as `{ ok: false, issues }` (with `conflict` for an edit conflict,
 *   T-031), deadlocks and serialization failures are retried (`attempts`)
 *   and then returned as `retry`, and anything unexpected is
 *   `internal_error` with fixed text, the error itself going only to
 *   `onError` (for the server's log).
 *
 * The service makes every record ID (a random version 4 UUID; a draft can't
 * name one) and every timestamp: `createdAt` and `updatedAt` are now for a
 * new record, and an edit's `updatedAt` is the later of the stored one and
 * now, so a server clock behind the stored time never gets an edit refused
 * (D-063).
 *
 * **Who may do what** (T-041, D-072, `access.ts`): every operation reads
 * the actor's access in its own transaction (their user row locked first,
 * so a revocation is seen or waits) and checks core's permissions before it
 * touches the record: viewing it, then the operation's own permission at
 * the record's place in the arrangement, and, when a record moves (a unit's
 * parent, an asset's represented record), the permission at both the place
 * it leaves and the place it goes. Restore needs `records.history` as well
 * as `records.edit` (D-065). A record the actor may not view is refused
 * exactly as one that doesn't exist. Roles, sites and System settings are
 * managed through `admin.ts`, also checked here.
 *
 * **Workflow and publishing** (T-034b, D-075, D-076): `submitForReview`,
 * `returnToDraft`, `publish` and `withdraw` change a record's stored state
 * as its next version (who, when, why), under the record's row lock.
 * `publish` runs core's publish check in the same transaction, on the
 * record and everything it depends on as they are now (`publishCheckIssues`),
 * and is refused if it fails. A published record stays publishable: an
 * edit, a restore or an identifier change of a published record runs the
 * same check after writing and is refused (nothing saved) if it would fail.
 * A published record must be withdrawn before it is deleted. Publishing,
 * withdrawing, and confirming that values may become public on a published
 * record (`confirmTemplateMove`, `confirmMadePublic`) change what the public
 * sees at once, so each asks `ServiceOptions.mayChangePublicOutput` first:
 * the hook T-041's `records.publish` permission plugs into.
 *
 * **For the HTTP API** (T-042, D-079): `checkRecord` is the admin's dry
 * run (today's checks on a draft, nothing written); `searchRecords` is
 * staff search over the whole sites the person may see, under a
 * `statement_timeout`; templates and identifier types are read and saved
 * through `definitions.ts` (`catalog.definitions`, and D-076's gate for
 * changes that make values public on published records).
 *
 * **History and the approval queue** (T-043, D-082): `listVersions`,
 * `readRecordVersion` and `compareRecordVersions` need `records.history`
 * where the record is now (read-only people see no old versions, D-072),
 * and answer a version the record doesn't have only after that check;
 * `reviewQueue` lists records sent for review on the whole sites where the
 * person may publish.
 *
 * Not here yet: loans and accessions (no tables yet; when they are stored,
 * closing a loan by an accession happens here, from the register and loan
 * book read in the same transaction, never from ones a caller hands in,
 * D-067 for T-018a and S-013).
 */
import {
  MAX_FIELD_DEPTH,
  MAX_FIELD_ENTRIES,
  MAX_KEY_LENGTH,
  MAX_RECORD_CHARS,
  MAX_STRING_LENGTH,
  IssueList,
  changesInheritance,
  compareRecords,
  droppedIdentifiers,
  holdsAnywhere,
  ROLE_PERMISSIONS,
  identifierFieldIssues,
  isFieldKey,
  isOrganizationId,
  isPlainObject,
  isRecordId,
  isSiteId,
  issue,
  newRecordId,
  readPlainData,
  templateMoveChanges,
  validateRecord,
  type CatalogRecord,
  type Issue,
  type JsonValue,
  type OrganizationId,
  type Access,
  type Permission,
  type RecordId,
  type RecordIdentifiers,
  type SiteId,
  type WorkflowAction,
  type WorkflowState,
} from "@oculus/core";
import {
  RecordAccess,
  createPermissions,
  publishPermission,
  editPermissions,
  noSuchRecord,
  notPermitted,
  readAccess,
  type Refusal,
} from "./access.js";
import { adminOperations, type AdminOperations } from "./admin.js";
import { definitionOperations, type DefinitionOperations } from "./definitions.js";
import type { FileStore } from "./file-store.js";
import { fileOperations, type FileOperations } from "./files.js";
import { peopleOperations, type PeopleOperations } from "./people.js";
import {
  changeWorkflowState,
  checkWriterConnection,
  deleteRecord as deleteStoredRecord,
  fixedMessages,
  insertRecord,
  isActorId,
  lockArrangement,
  lockDefinition,
  linkedIds,
  lockRecord,
  organizationSiteIds,
  publicValueSources,
  inheritedValues,
  listRecords as listStoredRecords,
  listRecordTypes as listStoredRecordTypes,
  publishCheckIssues,
  lockRecordsShared,
  recordClosureIds,
  recordDependents,
  searchRecords as searchStoredRecords,
  readOrganization,
  readRecordIdentifiers,
  readRecordPlace,
  readStoredRecord,
  readTemplate,
  readVersion,
  readVersionSummaries,
  compareVersions,
  grantsScopedTo,
  hasRecordsBelow,
  childrenOffSite,
  readWorkflowState,
  recordsInState,
  recordCheckIssues,
  refreshRecordTerms,
  restoreVersion as restoreStoredVersion,
  saveRecordIdentifiers,
  updateRecord as updateStoredRecord,
  versionConflict,
  type Database,
  type Queryable,
  type RecordDeletion,
  type RecordPlace,
  type RecordPosition,
  type RecordVersionSummary,
  type RecordVersion,
  type SearchResults,
  type VersionComparison,
  type VersionConflict,
  type WriterRoleProblem,
  type PublicValueSource,
  type InheritedValue,
  type RecordList,
  type RecordTypeSummary,
  type StateListEntry,
  sql,
} from "@oculus/db";

/**
 * Who is writing, and in which organization: built by the caller from the
 * signed-in session (D-019), never from a request.
 */
export interface ServiceContext {
  /** The one organization the session works in. */
  readonly organizationId: OrganizationId;
  /** The signed-in person, `user:<uuid v4>`, or a job, `system:<name>` (D-063). */
  readonly actor: string;
  /**
   * The site the person is working in (D-074): new records are made there.
   * Optional (`null` or left out: no site), since a session doesn't carry it
   * yet (T-045's site selector will); the service checks that the person has
   * a role on it. Without one, only a system manager can make records (on no
   * site).
   */
  readonly siteId?: SiteId | null;
}

/** The context as read: the organization, the actor and the working site. */
interface Who {
  readonly organizationId: OrganizationId;
  readonly actor: string;
  readonly siteId: SiteId | null;
}

/** A refusal: what is wrong, and for an edit conflict what changed since (names only, T-031). */
export interface ServiceRefusal {
  readonly ok: false;
  readonly issues: readonly Issue[];
  readonly conflict?: VersionConflict;
}

/** What every operation returns. */
export type ServiceResult<T> = { readonly ok: true; readonly value: T } | ServiceRefusal;

/** A record as saved. */
export interface SavedRecord {
  readonly record: CatalogRecord;
  /** The record's version now: pass it as `expectedVersion` with the next edit. */
  readonly version: number;
  /** False when the edit changed nothing, so nothing was written. */
  readonly changed: boolean;
}

/** One number a save would drop from every record: confirmed by type and value. */
export interface DroppedNumber {
  readonly type: string;
  readonly value: string;
}

export interface CreateOptions {
  /**
   * The new record's identifiers (`current`, `former`), saved in the same
   * transaction. They name no organization or record: the service fills
   * both in.
   */
  readonly identifiers?: unknown;
  /** Why, for the change log (optional). */
  readonly reason?: string;
}

export interface UpdateOptions {
  /** The version the edit started from (T-031). */
  readonly expectedVersion: number;
  /** The record's whole identifier set after the edit, if it changes (as `CreateOptions`). */
  readonly identifiers?: unknown;
  /** The numbers the person confirmed may be dropped (`numbers_dropped`). */
  readonly confirmDropped?: readonly DroppedNumber[];
  /**
   * When the record moves to another template (its `templateKey` changes,
   * T-012a): the field keys the person confirmed, exactly those of the
   * `made_public` and `now_inherited` issues `templateMoveChanges` gave.
   */
  readonly confirmTemplateMove?: readonly string[];
  readonly reason?: string;
}

export interface IdentifierOptions {
  /** The numbers the person confirmed may be dropped (`numbers_dropped`). */
  readonly confirmDropped?: readonly DroppedNumber[];
}

export interface RestoreOptions {
  /** The version the person was looking at. */
  readonly expectedVersion: number;
  readonly reason?: string;
  /** As `restoreVersion`'s `confirmMadePublic` (D-065). */
  readonly confirmMadePublic?: readonly string[];
}

export interface DeleteOptions {
  /** The version the person was looking at. */
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface WorkflowOptions {
  /** The version the person was looking at (a change of state is the record's next version). */
  readonly expectedVersion: number;
  /** Why, for the change log (optional). */
  readonly reason?: string;
}

/** A change of a record's workflow state, as stored. */
export interface WorkflowChange {
  readonly state: WorkflowState;
  /** The version the change was stored as: pass it as `expectedVersion` next. */
  readonly version: number;
  readonly actor: string;
  /** The database's clock at the change. */
  readonly recordedAt: string;
}

/**
 * What changes the public output at once, and so needs the publish
 * permission (D-036, D-076): publishing, withdrawing, and confirming that
 * values of a published record may become public (a template move's
 * `confirmTemplateMove`, a restore's `confirmMadePublic`).
 */
export type PublicChange = "publish" | "withdraw" | "confirm_made_public";

/** What `mayChangePublicOutput` is asked. */
export interface PublicChangeRequest {
  readonly organizationId: OrganizationId;
  readonly actor: string;
  readonly recordId: RecordId;
  readonly change: PublicChange;
}

/** How the service runs. */
export interface ServiceOptions {
  /** The clock (for tests). Default: now. */
  readonly now?: () => Date;
  /**
   * How many times an operation runs when it meets a deadlock or a
   * serialization failure (`retry`), counting the first. Default 3; 1 to 10.
   */
  readonly attempts?: number;
  /**
   * Called with every unexpected error (and the operation's name) before it
   * is returned as `internal_error`: for the server's log, never for a
   * person. Errors thrown by it are ignored.
   */
  readonly onError?: (error: unknown, operation: string) => void;
  /**
   * Who may change what the public sees (`PublicChange`), asked in the
   * operation's transaction before the record is changed: `undefined` to
   * allow, or the refusal to return (nothing is saved). The default is
   * T-041's `publishPermission`: `records.publish` where the record is (its
   * home site and units, D-072, D-074), a record that doesn't exist or that
   * the actor can't view answered alike as `unknown_record`, otherwise
   * `not_permitted`. A replacement must look the record up itself in
   * `request.organizationId` and write nothing. Errors it throws fail the
   * operation as `internal_error`.
   */
  readonly mayChangePublicOutput?: (
    tx: Queryable,
    request: PublicChangeRequest,
  ) => Promise<ServiceRefusal | undefined>;
  /**
   * The `statement_timeout` (milliseconds) staff search runs under (D-066,
   * D-079): a search that takes longer is stopped and answered
   * `search_timeout`. Default 5,000; 1 to 30,000.
   */
  readonly searchTimeoutMs?: number;
  /**
   * The file store (M-002, D-086, `openFileStore`). Without one, attaching
   * files is refused as `files_unavailable`; listing still works.
   */
  readonly files?: FileStore;
}

/** What `checkRecord` returns: core's issues for the draft as it would be saved now. */
export interface RecordCheck {
  readonly issues: readonly Issue[];
}

/**
 * What the person may do with a record where it is now (T-046, D-083): the
 * admin shows only the actions these allow. Each answer is the same check
 * the operation itself makes, read under the same row lock; the operation
 * still decides when it runs.
 */
export interface RecordAbilities {
  /** `records.edit` (or `media.attach` for a scan): save, send for review, back to draft. */
  readonly edit: boolean;
  /** `records.history`: the history panel, compare and restore (restore also needs `edit`). */
  readonly history: boolean;
  /** `records.publish`: publish and unpublish. */
  readonly publish: boolean;
  /** `records.delete`: site managers (and system managers) only. */
  readonly delete: boolean;
}

/** A record as read (staff view: every field). */
export interface ReadRecord {
  readonly record: CatalogRecord;
  readonly version: number;
  /** Its workflow state (D-075, D-076), read under the same row lock. */
  readonly state: WorkflowState;
  /** What the person may do with it (T-046). */
  readonly can: RecordAbilities;
  /**
   * The values it inherits now from the units above it (D-013), for fields
   * without a value of its own; none when any unit above it is out of the
   * person's sight or can't be read (T-046).
   */
  readonly inherited: readonly InheritedValue[];
}

/** What the person may do in the working site (T-046): which buttons the admin offers. */
export interface SiteAbilities {
  /** The record kinds they may make there (all six, only `digital_asset` for a Scanner, or none). */
  readonly createKinds: readonly string[];
  /** Whether they may publish anywhere, so the approval queue answers them. */
  readonly review: boolean;
}

/** A page of the items list (T-046): records with their state, newest change first or by title. */
export interface ItemList {
  readonly records: readonly ItemListEntry[];
  /** Present when there are more: pass it as `after` for the next page. */
  readonly next?: string;
}

/** One record in the items list. */
export interface ItemListEntry {
  readonly recordId: RecordId;
  readonly title: string;
  readonly kind: string;
  readonly recordTypeKey: string | null;
  readonly siteId: string | null;
  readonly state: string;
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * One version in a record's history, without the record's content (T-043,
 * D-082): who, when, why, what changed (names only) and the action.
 */
export type VersionSummary = RecordVersionSummary;

/** A page of a record's history, oldest first. */
export interface VersionList {
  readonly versions: readonly VersionSummary[];
  /** True when there are more: ask again with `after` the last version listed. */
  readonly truncated: boolean;
}

/** A page of the approval queue: records sent for review (T-043, D-082). */
export interface ReviewQueue {
  readonly records: readonly StateListEntry[];
  /** Present when there are more: pass it as `after` for the next page. */
  readonly next?: RecordId;
}

/** At most this many versions in one page of `listVersions`. */
export const MAX_VERSION_PAGE = 100;

/** The service: every write of a record and its related rows, and who may make them. */
export interface RecordService
  extends AdminOperations, DefinitionOperations, PeopleOperations, FileOperations {
  /** The record as stored, for someone who may view it (`records.view`). */
  readRecord(context: ServiceContext, recordId: RecordId): Promise<ServiceResult<ReadRecord>>;
  /**
   * The record's history, oldest first, without content (T-043, D-082):
   * `records.view` and `records.history` where the record is now (D-072:
   * read-only people don't see old versions). `options`: `after` (a
   * version number) and `limit` (1 to `MAX_VERSION_PAGE`, default 50). A
   * deleted record has no row to check a place at, so it is
   * `unknown_record` here.
   */
  listVersions(
    context: ServiceContext,
    recordId: RecordId,
    options?: unknown,
  ): Promise<ServiceResult<VersionList>>;
  /** One version with its whole content, with the same permissions as `listVersions`. */
  readRecordVersion(
    context: ServiceContext,
    recordId: RecordId,
    version: number,
  ): Promise<ServiceResult<RecordVersion>>;
  /** Two versions compared field by field (D-065), with the same permissions as `listVersions`. */
  compareRecordVersions(
    context: ServiceContext,
    recordId: RecordId,
    from: number,
    to: number,
  ): Promise<ServiceResult<VersionComparison>>;
  /**
   * The approval queue (T-043, D-082): records `ready_for_review` on the
   * whole sites where the person may publish (`records.publish` granted for
   * the whole catalog there; every record for a system manager), ordered by
   * ID. `options`: `limit` (1 to 100, default 50) and `after` (the previous
   * page's `next`). Someone who may publish nowhere is `not_permitted`.
   * Scoped publish grants don't add records here yet (as search, D-079).
   */
  reviewQueue(context: ServiceContext, options?: unknown): Promise<ServiceResult<ReviewQueue>>;
  /** Makes a new record from `draft` (no ID: the service makes it), checked, with its version 1. */
  createRecord(
    context: ServiceContext,
    draft: unknown,
    options?: CreateOptions,
  ): Promise<ServiceResult<SavedRecord>>;
  /**
   * Replaces the record's content with `draft` (its kind can't change; its
   * ID, organization and timestamps are the service's), checked, as its
   * next version. Moving a unit in the arrangement is an update of its
   * `parentId`.
   */
  updateRecord(
    context: ServiceContext,
    recordId: RecordId,
    draft: unknown,
    options: UpdateOptions,
  ): Promise<ServiceResult<SavedRecord>>;
  /** Replaces the record's identifiers (`current`, `former`), checked against its identifier fields. */
  saveIdentifiers(
    context: ServiceContext,
    recordId: RecordId,
    identifiers: unknown,
    options?: IdentifierOptions,
  ): Promise<ServiceResult<RecordIdentifiers>>;
  /** Restores an old version as the record's next one (D-065), with its term usages. */
  restoreVersion(
    context: ServiceContext,
    recordId: RecordId,
    version: number,
    options: RestoreOptions,
  ): Promise<ServiceResult<RecordVersion>>;
  /** Deletes the record, leaving its history and a deletion version (D-067). */
  deleteRecord(
    context: ServiceContext,
    recordId: RecordId,
    options: DeleteOptions,
  ): Promise<ServiceResult<RecordDeletion>>;
  /** Sends a draft (or withdrawn) record for review (D-075). */
  submitForReview(
    context: ServiceContext,
    recordId: RecordId,
    options: WorkflowOptions,
  ): Promise<ServiceResult<WorkflowChange>>;
  /** Returns a record in review (or withdrawn) to draft (D-075). */
  returnToDraft(
    context: ServiceContext,
    recordId: RecordId,
    options: WorkflowOptions,
  ): Promise<ServiceResult<WorkflowChange>>;
  /**
   * Publishes a draft, ready or withdrawn record, after core's publish check
   * on it as it is now; needs `mayChangePublicOutput` (D-076).
   */
  publish(
    context: ServiceContext,
    recordId: RecordId,
    options: WorkflowOptions,
  ): Promise<ServiceResult<WorkflowChange>>;
  /** Takes a published record off the public sites ("Unpublish"); needs `mayChangePublicOutput`. */
  withdraw(
    context: ServiceContext,
    recordId: RecordId,
    options: WorkflowOptions,
  ): Promise<ServiceResult<WorkflowChange>>;
  /**
   * A dry run (D-073, D-079): the issues a create (no `recordId`) or an
   * update of `recordId` with `draft` would meet in today's checks, with
   * nothing written. Refused as the save would be when the person may not
   * make or edit the record (a record they can't view as `unknown_record`).
   * A new parent, represented record or site goes through the save's own
   * visibility and permission step first (out of sight = missing). Not
   * checked here: identifier numbers and the publish check of a published
   * record; the save checks those.
   */
  checkRecord(
    context: ServiceContext,
    draft: unknown,
    options?: unknown,
  ): Promise<ServiceResult<RecordCheck>>;
  /**
   * Staff search (D-066) over the records the person may see on whole
   * sites (D-074, D-079), under `searchTimeoutMs`. `options`: `limit`
   * (1 to 200) and `after` (the previous page's `next`).
   */
  searchRecords(
    context: ServiceContext,
    query: unknown,
    options?: unknown,
  ): Promise<ServiceResult<SearchResults>>;
  /**
   * The items list (T-046, D-083) of the working site: with `query`, staff
   * search narrowed by the filters (best match first); without, every
   * record of the site, last changed first or by title. Only records of
   * whole sites the person may see every record of (as `searchRecords`),
   * and of the working site when one is given. `options`: `query`,
   * `state`, `recordType`, `sort` (`updated` or `title`, without a
   * query), `after` (the previous page's `next`) and `limit` (1 to 100).
   */
  listItems(context: ServiceContext, options?: unknown): Promise<ServiceResult<ItemList>>;
  /** The organization's record types (T-046), for anyone who may read templates. */
  listRecordTypes(context: ServiceContext): Promise<ServiceResult<readonly RecordTypeSummary[]>>;
  /** What the person may do in the working site (T-046): see `SiteAbilities`. */
  siteAbilities(context: ServiceContext): Promise<ServiceResult<SiteAbilities>>;
  /** What is wrong with the connection's database role for writing (empty when fit). */
  checkConnection(): Promise<readonly WriterRoleProblem[]>;
}

// ---------------------------------------------------------------------------

function refusal(
  path: readonly (string | number)[],
  code: string,
  message: string,
): ServiceRefusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** A version number (`min` and up, below 2^31 - 1). */
function isWholeNumber(value: unknown, min: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= min && value < 2 ** 31 - 1
  );
}

/** A version the record doesn't have (asked only once the person may read its history). */
function noSuchVersion(path: readonly (string | number)[]): ServiceRefusal {
  return refusal(path, "unknown_version", "The record has no such version.");
}

/** A stored version that no longer reads as valid: a repair job, never the person's text. */
function unreadableHistory(): ServiceRefusal {
  return refusal(
    ["recordId"],
    "unreadable_record",
    "A stored version no longer reads as a valid record; it needs repair.",
  );
}

/**
 * The whole sites on which the person holds `permission` for every record
 * (D-074, D-079): a system manager every record (`"all"`); anyone else the
 * sites of their whole-catalog grants holding it (every site of the
 * organization for a grant on every site, never records on no site).
 * Scoped grants (a unit's subtree) don't count: filtering by subtree in the
 * query is a later task, and filtering a page afterwards would show, by a
 * short page, that hidden records matched.
 */
async function wholeSites(
  tx: Queryable,
  organizationId: OrganizationId,
  access: Access,
  permission: Permission,
): Promise<"all" | readonly string[]> {
  if (access.systemManager) return "all";
  const holding = access.grants.filter(
    (g) =>
      g.scope === null && (ROLE_PERMISSIONS[g.role] as readonly Permission[]).includes(permission),
  );
  if (holding.some((g) => g.siteId === null)) return organizationSiteIds(tx, organizationId);
  return [...new Set(holding.map((g) => g.siteId as string))];
}

/** Thrown inside a transaction to roll it back and return the refusal. */
class Refused extends Error {
  constructor(readonly result: ServiceRefusal) {
    super("refused");
  }
}

/** The draft keys a person edits. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "siteId",
  "title",
  "templateKey",
  "recordTypeKey",
  "fields",
  "level",
  "parentId",
  "mediaType",
  "represents",
  "agentType",
  "coordinates",
]);

/** The keys the service owns; an update's draft may carry them (as read), a new one may not. */
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "organizationId",
  "createdAt",
  "updatedAt",
]);

const DRAFT_LIMITS = {
  maxDepth: MAX_FIELD_DEPTH + 1,
  maxValues: MAX_FIELD_ENTRIES,
  maxStringLength: MAX_STRING_LENGTH,
  maxKeyLength: MAX_KEY_LENGTH,
  maxTotalChars: MAX_RECORD_CHARS,
} as const;

const IDENTIFIER_LIMITS = {
  maxDepth: 4,
  maxValues: 100_000,
  maxStringLength: 10_000,
  maxKeyLength: 64,
  maxTotalChars: 2_000_000,
} as const;

type Plain = Readonly<Record<string, JsonValue>>;

/** A frozen plain copy of an untrusted object, or the issues. */
function plainCopy(
  input: unknown,
  limits: typeof DRAFT_LIMITS | typeof IDENTIFIER_LIMITS,
  what: string,
): ServiceResult<Plain> {
  const issues = new IssueList();
  let copy: JsonValue | undefined;
  try {
    copy = readPlainData(input, [], limits, issues);
  } catch {
    return refusal([], "unreadable", `The ${what} could not be read as plain data.`);
  }
  if (copy === undefined || !isPlainObject(copy)) {
    return issues.items.length > 0
      ? { ok: false, issues: issues.items }
      : refusal([], "not_an_object", `The ${what} must be a plain object.`);
  }
  return { ok: true, value: copy };
}

function own(copy: Plain, key: string): JsonValue | undefined {
  return Object.hasOwn(copy, key) ? copy[key] : undefined;
}

/** An own data property of an untrusted object, never through a getter or a proxy's trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** The first own key not in `allowed` (or one that can't be read), if any. */
function keyBeyond(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return "(not an object)";
  try {
    const key = Reflect.ownKeys(value).find((k) => typeof k !== "string" || !allowed.has(k));
    return key === undefined ? undefined : String(key);
  } catch {
    return "(unreadable)";
  }
}

const WRONG_ORGANIZATION = "This names another organization than the one you are working in.";

/** The context, read safely: the organization, actor and working site, or a refusal. */
function readContext(context: unknown): ServiceResult<Who> {
  const extra = keyBeyond(context, new Set(["organizationId", "actor", "siteId"]));
  if (extra !== undefined) {
    return refusal(
      ["context", extra],
      "unknown_property",
      "The context is organizationId, actor and siteId.",
    );
  }
  const organizationId = ownValue(context, "organizationId");
  const actor = ownValue(context, "actor");
  const siteId = ownValue(context, "siteId") ?? null;
  if (!isOrganizationId(organizationId)) {
    return refusal(
      ["context", "organizationId"],
      "invalid_organization",
      "The session's organization must be a lowercase version 4 UUID.",
    );
  }
  if (!isActorId(actor)) {
    return refusal(
      ["context", "actor"],
      "invalid_actor",
      "The actor is user:<uuid v4> or system:<name>.",
    );
  }
  if (siteId !== null && !isSiteId(siteId)) {
    return refusal(
      ["context", "siteId"],
      "invalid_site",
      "The working site must be a lowercase version 4 UUID, or null.",
    );
  }
  return { ok: true, value: { organizationId, actor, siteId } };
}

/** Options read safely: only `allowed` keys, own data properties. */
function readOptions(options: unknown, allowed: readonly string[]): ServiceResult<Plain> {
  if (options === undefined) return { ok: true, value: Object.freeze({}) };
  const extra = keyBeyond(options, new Set(allowed));
  if (extra !== undefined) {
    return refusal(
      ["options", extra],
      "unknown_property",
      `The options are only ${allowed.join(", ")}.`,
    );
  }
  return plainCopy(options, IDENTIFIER_LIMITS, "options");
}

/** At most this many confirmed field keys (no template has more fields). */
const MAX_CONFIRMED_KEYS = 1_000;

function readConfirmTemplateMove(options: Plain): ServiceResult<ReadonlySet<string> | undefined> {
  const confirm = own(options, "confirmTemplateMove");
  if (confirm === undefined) return { ok: true, value: undefined };
  if (
    !Array.isArray(confirm) ||
    confirm.length > MAX_CONFIRMED_KEYS ||
    !confirm.every((key) => isFieldKey(key))
  ) {
    return refusal(
      ["options", "confirmTemplateMove"],
      "invalid_option",
      "This is the list of field keys the person confirmed.",
    );
  }
  return { ok: true, value: new Set(confirm) };
}

/**
 * A record moving to another template (T-012a, D-029): what its stored
 * values become under the new one (`templateMoveChanges`). Values stored as
 * staff that the new template publishes, or makes inherited, are refused
 * until `confirmTemplateMove` lists exactly those field keys. The new
 * template is locked and read by `recordCheckIssues` already; the old one
 * is locked here too, so neither changes before COMMIT.
 */
async function templateMoveIssues(
  tx: Queryable,
  before: CatalogRecord,
  after: CatalogRecord,
  confirmed: ReadonlySet<string> | undefined,
): Promise<Issue[]> {
  const org = after.organizationId;
  const unreadable = [
    issue(["templateKey"], "unknown_template", "The record's templates can't be read."),
  ];
  const toKey = after.templateKey ?? "";
  // A stored record always names its template (0002: NOT NULL).
  const fromKey = before.templateKey ?? "";
  await lockDefinition(tx, org, "template", fromKey);
  const [from, to] = [await readTemplate(tx, org, fromKey), await readTemplate(tx, org, toKey)];
  if (!from?.ok || !to?.ok) return unreadable;
  const changes = templateMoveChanges(before, after, from.value.template, to.value.template);
  if (!changes.ok) return unreadable;
  const needed = changes.value.changes.filter((c) => c.needsConfirmation);
  if (needed.length === 0) return [];
  const keys = new Set(needed.map((c) => c.key));
  if (confirmed?.size === keys.size && [...keys].every((k) => confirmed.has(k))) {
    return [];
  }
  return needed.map((c) => issue(["fields", c.key], c.code, c.message));
}

function readExpectedVersion(options: Plain): ServiceResult<number> {
  const expected = own(options, "expectedVersion");
  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    expected >= 2 ** 31 - 1
  ) {
    return refusal(
      ["options", "expectedVersion"],
      "invalid_version",
      "Name the version the edit started from: a whole number from 1.",
    );
  }
  return { ok: true, value: expected };
}

/** The reason, if given (checked again by the change log's own rules). */
function readReason(options: Plain): ServiceResult<string | undefined> {
  const reason = own(options, "reason");
  if (reason === undefined) return { ok: true, value: undefined };
  if (typeof reason !== "string") {
    return refusal(["options", "reason"], "invalid_reason", "The reason is text.");
  }
  return { ok: true, value: reason };
}

/** `confirmDropped`, as a set of `type\0value`. */
function readConfirmDropped(options: Plain): ServiceResult<ReadonlySet<string>> {
  const list = own(options, "confirmDropped");
  if (list === undefined) return { ok: true, value: new Set() };
  const bad = refusal(
    ["options", "confirmDropped"],
    "invalid_option",
    "confirmDropped lists the dropped numbers as { type, value }.",
  );
  if (!Array.isArray(list) || list.length > 10_000) return bad;
  const keys = new Set<string>();
  for (const item of list as readonly JsonValue[]) {
    if (!isPlainObject(item)) return bad;
    const entry = item as Plain;
    const type = own(entry, "type");
    const value = own(entry, "value");
    if (typeof type !== "string" || typeof value !== "string") return bad;
    keys.add(`${type}\u0000${value}`);
  }
  return { ok: true, value: keys };
}

/** A draft's content, with the organization it names (if any) checked against the session's. */
function readDraft(
  draft: unknown,
  organizationId: OrganizationId,
  mode: "create" | "update",
): ServiceResult<Plain> {
  const copied = plainCopy(draft, DRAFT_LIMITS, "record");
  if (!copied.ok) return copied;
  const copy = copied.value;
  const named = own(copy, "organizationId");
  if (named !== undefined && named !== organizationId) {
    return refusal(["organizationId"], "wrong_organization", WRONG_ORGANIZATION);
  }
  for (const key of Object.keys(copy)) {
    if (CONTENT_KEYS.has(key)) continue;
    if (SERVICE_KEYS.has(key)) {
      if (mode === "create" && key !== "organizationId") {
        return refusal(
          [key],
          "not_allowed",
          key === "id"
            ? "The service makes every record ID; a new record names none."
            : "The service sets a record's timestamps.",
        );
      }
      continue;
    }
    if (key === "version") continue;
    return refusal([key], "unknown_property", "A record has no such property.");
  }
  return { ok: true, value: copy };
}

/** The content keys of a draft, copied. */
function contentOf(draft: Plain): Record<string, JsonValue> {
  const content: Record<string, JsonValue> = {};
  for (const key of CONTENT_KEYS) {
    const value = own(draft, key);
    if (value !== undefined) content[key] = value;
  }
  return content;
}

/** An identifier set's draft, with the organization and record filled in by the service. */
function readIdentifierDraft(
  input: unknown,
  organizationId: OrganizationId,
  recordId: RecordId,
): ServiceResult<Record<string, unknown>> {
  const copied = plainCopy(input, IDENTIFIER_LIMITS, "identifier set");
  if (!copied.ok) return { ok: false, issues: copied.issues.map(underIdentifiers) };
  const copy = copied.value;
  const named = own(copy, "organizationId");
  if (named !== undefined && named !== organizationId) {
    return refusal(["identifiers", "organizationId"], "wrong_organization", WRONG_ORGANIZATION);
  }
  const record = own(copy, "recordId");
  if (record !== undefined && record !== recordId) {
    return refusal(
      ["identifiers", "recordId"],
      "wrong_record",
      "These identifiers name another record.",
    );
  }
  return { ok: true, value: { ...copy, organizationId, recordId } };
}

function underIdentifiers(i: Issue): Issue {
  return issue(["identifiers", ...i.path], i.code, i.message);
}

/** The later of two times in core's form. */
function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

const RETRY = "40P01";
const SERIALIZATION = "40001";
const OUT_OF_LOCKS = "53200";

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A thrown error as a clean refusal: fixed text by SQLSTATE class, never the
 * error's own message (which names tables, constraints and values).
 */
function cleanError(error: unknown): ServiceRefusal {
  const state = sqlState(error);
  switch (state) {
    case RETRY:
    case SERIALIZATION:
    case OUT_OF_LOCKS:
      return refusal([], "retry", "Other changes were being saved at the same moment. Try again.");
    case "23503":
      return refusal(
        [],
        "missing_reference",
        "Something this points at was removed while it was being saved. Read it again.",
      );
    case "23505":
    case "23000":
    case "23514":
    case "23502":
    case "23P01":
      return refusal(
        [],
        "refused_by_database",
        "The database refused this change as it doesn't fit the stored data. Read it again.",
      );
    case "OC061":
      return refusal(
        [],
        "read_committed_required",
        "This change must run in a Read Committed transaction.",
      );
    case "42501":
      return refusal(
        [],
        "writer_role_refused",
        "The service's database role may not make this change. Check its grants.",
      );
    case "57014":
      return refusal([], "timeout", "The change took too long and was stopped. Nothing was saved.");
    default:
      return refusal([], "internal_error", "Something went wrong; nothing was saved.");
  }
}

/** Where a record sits, for permissions: its home site, and its parent (a unit) or what it represents (an asset). */
interface Placed {
  readonly kind: string;
  readonly parentId?: RecordId | null;
  readonly represents?: RecordId | null;
  readonly siteId?: SiteId | null;
}

function positionOf(record: Placed): RecordPosition {
  return {
    kind: record.kind,
    parentId: record.kind === "archival_unit" ? (record.parentId ?? null) : null,
    represents: record.kind === "digital_asset" ? (record.represents ?? null) : null,
    siteId: record.siteId ?? null,
  };
}

/**
 * A record moving from `before`'s place to `after`'s (a unit's parent, an
 * asset's represented record, its home site): the person needs the edit
 * permission at the place it leaves and at the place it goes (T-041,
 * D-074). Leaving a place they can't change is `not_permitted` (they can
 * see the record, and so its parent); going to a place they can't see is
 * refused as a missing parent or represented record would be, and to a
 * site they have no role on as a site that doesn't exist.
 */
async function moveIssues(
  tx: Queryable,
  checker: RecordAccess,
  recordId: RecordId,
  before: Placed,
  after: CatalogRecord,
): Promise<Refusal | undefined> {
  const from = positionOf(before);
  const to = positionOf(after);
  const siteChange = from.siteId !== to.siteId;
  if (from.parentId === to.parentId && from.represents === to.represents && !siteChange) {
    return undefined;
  }
  const permissions = editPermissions(after.kind);
  if (siteChange && to.siteId != null && !(await checker.worksOn(to.siteId))) {
    return unknownSite(["siteId"]);
  }
  if (await checker.intoPlace(from, permissions, true)) return notPermitted();
  const into = await checker.intoPlace(to, permissions, true);
  if (into) return into;
  if (siteChange) {
    const org = after.organizationId;
    // Grants scoped to a unit on the site it leaves would follow it nowhere
    // (D-074 review): refused, for everyone, until they are changed. Grants
    // on every site still hold after the move.
    if (
      after.kind === "archival_unit" &&
      from.siteId != null &&
      (await grantsScopedTo(tx, org, recordId, { onSite: from.siteId })) > 0
    ) {
      return refusal(
        ["siteId"],
        "has_role_grants",
        "Roles on its site are granted for this unit. Change those grants first.",
      );
    }
    // Units filed under it and scans of it stay on its site: only a system
    // manager leaves them behind (items belong to one site).
    if (!checker.access.systemManager && (await hasRecordsBelow(tx, org, recordId))) {
      return refusal(
        ["siteId"],
        "in_use_below",
        "Units or scans below it stay on its site. A system manager can move them.",
      );
    }
  }
  return undefined;
}

/**
 * The refusals of a deletion that count what still needs the record (units
 * filed under it, scans of it, links to it, role grants on it), for anyone
 * but a system manager: those may be on sites the person can't see, so they
 * become one fixed `in_use`, with no count and no kind (D-074).
 */
const HIDDEN_USES: ReadonlySet<string> = new Set([
  "has_children",
  "represented",
  "linked_from",
  "has_role_grants",
]);

function withoutHiddenUses<T extends { readonly ok: false; readonly issues: readonly Issue[] }>(
  refused: T,
): T {
  if (!refused.issues.some((i) => HIDDEN_USES.has(i.code))) return refused;
  return {
    ...refused,
    issues: [
      issue(
        ["recordId"],
        "in_use",
        "Other records or role grants still need this record. Remove those first.",
      ),
      ...refused.issues.filter((i) => !HIDDEN_USES.has(i.code)),
    ],
  };
}

/** A site the person has no role on, answered as one that doesn't exist. */
function unknownSite(path: readonly (string | number)[]): ServiceRefusal {
  return refusal(path, "unknown_site", "There is no such site.");
}

/**
 * Whether writing `after` over a record now at `place` moves it in the
 * arrangement: a unit's parent or level, or what a digital asset
 * represents. Such a write takes the organization's arrangement lock
 * (exclusive) before the record's row lock (D-065), so nobody whose
 * permissions depend on where records sit (scoped grants, which hold the
 * same lock while they check and write) sees it half done.
 */
function movesInArrangement(
  place: RecordPlace,
  draft: CatalogRecord | Readonly<Record<string, unknown>>,
): boolean {
  const after = draft as {
    readonly parentId?: unknown;
    readonly level?: unknown;
    readonly represents?: unknown;
    readonly siteId?: unknown;
  };
  // A draft or version without a home site keeps the record's (D-074); a
  // change of home site is a move too (D-074 review: links checked by
  // `hiddenAmong` must not see it half done).
  const siteAfter = (after.siteId as SiteId | undefined) ?? place.siteId;
  if (siteAfter !== place.siteId) return true;
  if (place.kind === "archival_unit") {
    return (after.parentId ?? null) !== place.parentId || (after.level ?? null) !== place.level;
  }
  if (place.kind === "digital_asset") return (after.represents ?? null) !== place.represents;
  return false;
}

/** The refusal that runs the operation again from the start (`run`). */
function retryRefusal(): ServiceRefusal {
  return refusal([], "retry", "Other changes were being saved at the same moment. Try again.");
}

/**
 * Whether a unit's parent is one the actor may not view (a system manager
 * filed it across sites): its checks then answer as for a missing parent.
 */
async function parentHidden(checker: RecordAccess, record: CatalogRecord): Promise<boolean> {
  if (record.kind !== "archival_unit" || record.parentId === undefined) return false;
  return (await checker.hiddenAmong([record.parentId])).size > 0;
}

/**
 * A unit whose level or parent changes while units filed under it are ones
 * the actor may not view (a system manager filed them on another site):
 * the arrangement checks would read their levels and depth and name them
 * ("This unit holds a file now…"), so for anyone but a system manager the
 * change is refused with one fixed `in_use_below`, no level, count or kind
 * (third T-042 review; one of D-074's accepted one-bit signals, like
 * `in_use_below` for a change of site).
 */
async function hiddenChildrenIssue(
  tx: Queryable,
  checker: RecordAccess,
  before: { readonly kind: string; readonly level?: unknown; readonly parentId?: unknown },
  after: CatalogRecord,
  siteId: SiteId | null,
): Promise<ServiceRefusal | undefined> {
  if (after.kind !== "archival_unit" || checker.access.systemManager) return undefined;
  if (
    before.kind === "archival_unit" &&
    (before.level ?? null) === after.level &&
    (before.parentId ?? null) === (after.parentId ?? null)
  ) {
    return undefined;
  }
  const off = await childrenOffSite(tx, after.organizationId, after.id, siteId);
  if (off.length === 0) return undefined;
  if ((await checker.hiddenAmong(off)).size === 0) return undefined;
  return refusal(
    ["level"],
    "in_use_below",
    "Units below it are on sites you can't see, so only a system manager can change its level or move it.",
  );
}

/** The links `after` adds that `before` (if any) doesn't hold. */
function addedLinks(after: CatalogRecord, before?: CatalogRecord): RecordId[] {
  const kept = new Set(before === undefined ? [] : linkedIds(before));
  return linkedIds(after).filter((id) => !kept.has(id));
}

const RETRYABLE_STATES: ReadonlySet<string> = new Set([RETRY, SERIALIZATION]);

/**
 * A write of a published record that would leave it failing the publish
 * check: refused, with the check's issues after an explanation.
 */
function stillPublishable(found: readonly Issue[]): ServiceRefusal | undefined {
  if (found.length === 0) return undefined;
  return {
    ok: false,
    issues: [
      issue(
        ["workflowState"],
        "published_record_check",
        "This record is published, and after this change it could no longer be published. Fix what is listed, or unpublish it first.",
      ),
      ...found,
    ],
  };
}

/** The records `record` is filed under or represents (S-020). */
function placeIds(record: CatalogRecord): RecordId[] {
  if (record.kind === "archival_unit" && record.parentId !== undefined) return [record.parentId];
  if (record.kind === "digital_asset" && record.represents !== undefined) {
    return [record.represents];
  }
  return [];
}

/**
 * The most published records below an edited record whose public output an
 * edit by anyone but a system manager compares before and after (S-020).
 * Only edits that can change what they inherit are compared, so only those
 * meet the cap (S-028).
 */
const MAX_WATCHED_DEPENDENTS = 500;

/** `watchDependents`'s answer when nothing below needs comparing (S-028). */
const NOTHING_WATCHED = { ok: true, watched: undefined } as const;

/** A (field, source) pair as one comparable string (S-020). */
function pairKey(pair: PublicValueSource): string {
  return `${pair.field}\u0000${pair.source}`;
}

/** The refusal for a write that would put out values from records the actor can't see (S-020). */
function inheritsFromHidden(): ServiceRefusal {
  return refusal(
    ["workflowState"],
    "inherits_from_hidden",
    "Some values a published record would show come from records you can't see, so this change can't be made here. Ask someone who can see the records it is filed under.",
  );
}

/** Makes the service over `db`, a pool connected as the writer role. */
export function createService(db: Database, options: ServiceOptions = {}): RecordService {
  const clock = options.now ?? (() => new Date());
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new RangeError("attempts is a whole number from 1 to 10.");
  }
  const onError = options.onError;
  const searchTimeoutMs = options.searchTimeoutMs ?? 5_000;
  if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > 30_000) {
    throw new RangeError("searchTimeoutMs is a whole number from 1 to 30,000.");
  }
  const mayChangePublicOutput = options.mayChangePublicOutput ?? publishPermission;
  if (typeof mayChangePublicOutput !== "function") {
    throw new TypeError("mayChangePublicOutput is a function.");
  }

  /** The hook's answer for one change; `undefined` allows it. */
  async function publicChangeRefused(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
    recordId: RecordId,
    change: PublicChange,
  ): Promise<ServiceRefusal | undefined> {
    const answer = await mayChangePublicOutput(tx, {
      organizationId: who.organizationId,
      actor: who.actor,
      recordId,
      change,
    });
    if (answer === undefined) return undefined;
    // Read as untrusted: a hook is the deployment's code.
    const given: unknown = answer;
    const issues = ownValue(given, "issues");
    if (ownValue(given, "ok") === false && Array.isArray(issues) && issues.length > 0) {
      return answer;
    }
    // Anything else from the hook is a refusal too (fail closed).
    return refusal([], "not_permitted", "You don't have permission to do this.");
  }

  /**
   * After a write of a record in this transaction: if it is published, it
   * must still pass the publish check (D-076), with the templates and types
   * it read locked until COMMIT.
   */
  async function publishedStillPasses(
    tx: Queryable,
    organizationId: OrganizationId,
    recordId: RecordId,
    messages: "own" | "fixed",
  ): Promise<ServiceRefusal | undefined> {
    const state = await readWorkflowState(tx, organizationId, recordId);
    if (state?.state !== "published") return undefined;
    const found = await publishCheckIssues(tx, organizationId, recordId, { lock: true });
    return stillPublishable(messages === "own" ? found : fixedMessages(found, []));
  }

  /**
   * The values a unit inherits, for its reader (T-046 review), failing
   * closed. Every record above it is locked `FOR SHARE` first (after the
   * record's own row lock and any arrangement lock, as `lockAbove`), and the
   * set read again, so nothing above can move, change or be deleted between
   * reading the values and checking who may see their sources; then nothing
   * is shown when the set changed meanwhile, when the effective record names
   * a record above that isn't among those locked (gone, or moved in), or
   * when any of them is out of the person's sight (a system manager filed it
   * across sites): its values, and even that it lets a value through, are
   * not theirs to see.
   */
  async function visibleInherited(
    tx: Queryable,
    organizationId: OrganizationId,
    recordId: RecordId,
    checker: RecordAccess,
  ): Promise<readonly InheritedValue[]> {
    const above = await recordClosureIds(tx, organizationId, [recordId]);
    if (above === undefined) return [];
    const locked = new Set(await lockRecordsShared(tx, organizationId, above));
    const again = await recordClosureIds(tx, organizationId, [recordId]);
    if (again?.length !== above.length || !again.every((id) => locked.has(id))) return [];
    const found = await inheritedValues(tx, organizationId, recordId);
    if (found === undefined) return [];
    if (!found.chain.every((id) => locked.has(id))) return [];
    if (!found.values.every((v) => locked.has(v.from))) return [];
    if ((await checker.hiddenAmong(found.chain)).size > 0) return [];
    return found.values;
  }

  /**
   * S-020: locks every record above `ids` (their parents, represented
   * records and so on up, `ids` included) `FOR SHARE`, in ID order, and reads
   * the set again: if it changed meanwhile, the operation starts again
   * (`retry`). Afterwards no record whose values can flow into theirs can
   * change, move or be published or withdrawn before COMMIT, and an edit of
   * one of them waits for this transaction (it takes `FOR NO KEY UPDATE`).
   * Always taken upward: after the record's own row lock and the
   * arrangement lock, never before them.
   */
  async function lockAbove(
    tx: Queryable,
    organizationId: OrganizationId,
    ids: readonly RecordId[],
  ): Promise<ServiceRefusal | undefined> {
    const first = await recordClosureIds(tx, organizationId, ids);
    // Too many to read: the publish check refuses such a record anyway.
    if (first === undefined) return undefined;
    await lockRecordsShared(tx, organizationId, first);
    const again = await recordClosureIds(tx, organizationId, ids);
    return again?.join() === first.join() ? undefined : retryRefusal();
  }

  /**
   * S-020: refused unless the actor may view the source of every (field,
   * source) pair the record's public output takes from other records
   * (`publicValueSources`: public values inherited from ancestors and
   * represented records, and the record a digital asset represents), or with
   * `before`, of every pair not already among `before`. Publishing, or a
   * write that changes a published record's output, must not put out what
   * the actor can't see. The record's whole chain is locked first
   * (`lockAbove`), so the pairs read stay true until COMMIT. A system manager
   * sees every record and is never refused.
   */
  async function hiddenSourcesRefusal(
    tx: Queryable,
    checker: RecordAccess,
    organizationId: OrganizationId,
    recordId: RecordId,
    before: readonly PublicValueSource[] = [],
  ): Promise<ServiceRefusal | undefined> {
    if (checker.access.systemManager) return undefined;
    const locked = await lockAbove(tx, organizationId, [recordId]);
    if (locked) return locked;
    const known = new Set(before.map(pairKey));
    const pairs = await publicValueSources(tx, organizationId, recordId, { lock: true });
    // Unreadable: the publish check, run with it, refuses the record anyway.
    if (pairs === undefined) return undefined;
    const sources = [
      ...new Set(pairs.filter((p) => !known.has(pairKey(p))).map((p) => p.source)),
    ].sort();
    if (sources.length === 0) return undefined;
    if ((await checker.hiddenAmong(sources)).size === 0) return undefined;
    return inheritsFromHidden();
  }

  /**
   * S-028: whether an edit or restore of `recordId` must lock the records
   * below it (`lockBelow`) and compare the published ones
   * (`watchDependents`), decided before the record's row lock from a look
   * that locks no row (so it can't take a lock out of the below, record,
   * above order). False for a system manager; false when the look says the
   * write will be refused anyway (no such record, not at the version the
   * person saw, or the actor may not make it there: `all` and `any` as for
   * `onRecord`, `allowsUnlocked`), since then nothing is written; otherwise
   * whether going from the stored record to `after(stored)` changes
   * inheritance (`changesInheritance`), or always with `always` (numbers
   * saved with the edit). What it can't read (the stored record, or one
   * saved since the look) counts as a change, so the locks are taken as
   * before. Every answer holds only at that version: under the row lock the
   * operation refuses another version (or starts again), works out whether
   * it changes inheritance again, and starts again (`retry`) if it needs the
   * locks and didn't take them.
   */
  async function belowAtStake(
    tx: Queryable,
    checker: RecordAccess,
    organizationId: OrganizationId,
    recordId: RecordId,
    expectedVersion: number,
    permissions: { readonly all: readonly Permission[]; readonly any: readonly Permission[] },
    after: ((stored: CatalogRecord) => unknown) | undefined,
    always = false,
  ): Promise<boolean> {
    if (checker.access.systemManager) return false;
    const look = await checker.allowsUnlocked(recordId, permissions.all, permissions.any);
    // Refused below either way: no such record, a version conflict (or a
    // retry), or not permitted.
    if (look?.version !== expectedVersion || !look.allowed) return false;
    // Nothing to write (an unknown or unreadable version to restore).
    if (after === undefined) return false;
    if (always) return true;
    const stored = await readStoredRecord(tx, organizationId, recordId);
    if (stored === undefined || !stored.ok || stored.value.version !== look.version) return true;
    return changesInheritance(stored.value.record, after(stored.value.record));
  }

  /**
   * Before an edit or restore of `recordId` locks the record's row (S-020):
   * locks every record below it and every scan of them `FOR SHARE`, so none
   * can be published, withdrawn or changed until COMMIT (publishing one
   * takes `FOR NO KEY UPDATE` on it, then locks its chain, this record
   * included). Lower records first, then the record, then the records
   * above it (`lockAbove`): the order every edit and publication follows.
   * Not for a system manager, who sees every record, and (S-028) only when
   * `belowAtStake` says the edit can go ahead and change what they inherit.
   * Returns what it locked.
   */
  async function lockBelow(
    tx: Queryable,
    checker: RecordAccess,
    organizationId: OrganizationId,
    recordId: RecordId,
  ): Promise<ReadonlySet<RecordId> | undefined> {
    if (checker.access.systemManager) return undefined;
    const below = await recordDependents(tx, organizationId, recordId);
    return new Set(
      await lockRecordsShared(
        tx,
        organizationId,
        below.map((d) => d.id),
      ),
    );
  }

  /**
   * After the record's row lock, before the write (S-020): the published
   * records below it and scans of them, with their (field, source) pairs
   * now, to compare after the write with `dependentsRefusal`. The set is
   * read again: a record moved below it since `lockBelow` (so not locked)
   * starts the operation again (`retry`). Nothing to compare (`watched`
   * undefined) for a system manager, with no published dependents, or with
   * no record the actor can't see among those any new source could be (the
   * record, every record above it now and after the write, and every record
   * below it). More than `MAX_WATCHED_DEPENDENTS` published ones with a
   * hidden record involved is refused (`too_many_published_below`): a
   * system manager makes that change. `after` is the IDs the record will be
   * filed under or represent.
   */
  async function watchDependents(
    tx: Queryable,
    checker: RecordAccess,
    organizationId: OrganizationId,
    recordId: RecordId,
    after: readonly RecordId[],
    lockedBelow: ReadonlySet<RecordId> | undefined,
  ): Promise<
    | {
        readonly ok: true;
        readonly watched: ReadonlyMap<RecordId, readonly PublicValueSource[]> | undefined;
      }
    | ServiceRefusal
  > {
    const none = { ok: true, watched: undefined } as const;
    if (checker.access.systemManager) return none;
    const dependents = await recordDependents(tx, organizationId, recordId);
    if (dependents.some((d) => !(lockedBelow?.has(d.id) ?? false))) return retryRefusal();
    const published = dependents.filter((d) => d.published).map((d) => d.id);
    if (published.length === 0) return none;
    const above = await recordClosureIds(tx, organizationId, [recordId, ...after]);
    // Too many to list: compare every published dependent.
    if (above !== undefined) {
      const hidden = await checker.hiddenAmong([...above, ...dependents.map((d) => d.id)]);
      if (hidden.size === 0) return none;
    }
    if (published.length > MAX_WATCHED_DEPENDENTS) {
      return refusal(
        [],
        "too_many_published_below",
        "Too many published records are below this record, and some of what they show comes from records you can't see; ask a system manager to make this change.",
      );
    }
    const before = new Map<RecordId, readonly PublicValueSource[]>();
    for (const id of published) {
      before.set(id, (await publicValueSources(tx, organizationId, id)) ?? []);
    }
    return { ok: true, watched: before };
  }

  /** After the write: `hiddenSourcesRefusal` for every dependent `watchDependents` listed. */
  async function dependentsRefusal(
    tx: Queryable,
    checker: RecordAccess,
    organizationId: OrganizationId,
    watched: ReadonlyMap<RecordId, readonly PublicValueSource[]> | undefined,
  ): Promise<ServiceRefusal | undefined> {
    if (watched === undefined) return undefined;
    for (const [id, before] of watched) {
      const refused = await hiddenSourcesRefusal(tx, checker, organizationId, id, before);
      if (refused) return refused;
    }
    return undefined;
  }

  /** One of the four workflow actions (D-075), as the record's next version. */
  function workflowAction(action: WorkflowAction) {
    return (context: unknown, recordId: RecordId, workflowOptions: unknown) =>
      run(action, context, async (tx, who): Promise<ServiceResult<WorkflowChange>> => {
        const org = who.organizationId;
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(workflowOptions, ["expectedVersion", "reason"]);
        if (!opts.ok) return opts;
        const expected = readExpectedVersion(opts.value);
        if (!expected.ok) return expected;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        // Publishing and withdrawing change what the public sees (D-075):
        // `records.publish` (mayChangePublicOutput). Sending for review and
        // back to draft change the record: whoever may edit it (T-041).
        let publisher: RecordAccess | undefined;
        if (action === "publish" || action === "withdraw") {
          if (action === "publish") {
            // The actor's access for the S-020 check below, read (and its
            // arrangement lock taken) before the hook locks the row.
            const allowed = await accessFor(tx, who);
            if (!allowed.ok) return allowed;
            publisher = allowed.value;
          }
          const denied = await publicChangeRefused(tx, who, recordId, action);
          if (denied) return denied;
        } else {
          const allowed = await mayChange(tx, who, recordId, "no_key_update", [], editPermissions);
          if (!allowed.ok) return allowed;
        }
        const changed = await changeWorkflowState(tx, org, recordId, action, {
          expectedVersion: expected.value,
          actor: who.actor,
          ...(reason.value === undefined ? {} : { reason: reason.value }),
        });
        if (!changed.ok) return changed;
        if (action === "publish") {
          // On the record as it is now, under its row lock (taken above);
          // a refusal rolls the change of state back.
          const found = await publishCheckIssues(tx, org, recordId, { lock: true });
          if (found.length > 0) return { ok: false, issues: found };
          if (publisher !== undefined) {
            const hidden = await hiddenSourcesRefusal(tx, publisher, org, recordId);
            if (hidden) return hidden;
          }
        }
        const version = changed.value;
        return {
          ok: true,
          value: Object.freeze({
            state: version.workflowState,
            version: version.version,
            actor: version.actor,
            recordedAt: version.recordedAt,
          }),
        };
      });
  }

  /** The current time in core's form, whole milliseconds. */
  function now(): ServiceResult<string> {
    const time = clock();
    if (!(time instanceof Date) || Number.isNaN(time.getTime())) {
      return refusal([], "invalid_time", "The server's clock gave an invalid time.");
    }
    return { ok: true, value: time.toISOString() };
  }

  /**
   * Runs `work` in one transaction: committed if it succeeds, rolled back on
   * any refusal or error. Deadlocks and serialization failures run it again.
   */
  async function run<T>(
    operation: string,
    context: unknown,
    work: (tx: Queryable, who: Who) => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    const who = readContext(context);
    if (!who.ok) return who;
    let last: ServiceRefusal = refusal([], "retry", "Try again.");
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const organization = await readOrganization(tx, who.value.organizationId);
          if (!organization?.ok) {
            throw new Refused(
              refusal(
                ["context", "organizationId"],
                "unknown_organization",
                "There is no such organization.",
              ),
            );
          }
          const result = await work(tx, who.value);
          if (!result.ok) throw new Refused(result);
          return result;
        });
      } catch (error) {
        if (error instanceof Refused) {
          last = error.result;
          if (error.result.issues.some((i) => i.code === "retry") && attempt < attempts) continue;
          return error.result;
        }
        const state = sqlState(error);
        if (state !== undefined && RETRYABLE_STATES.has(state) && attempt < attempts) {
          last = cleanError(error);
          continue;
        }
        try {
          onError?.(error, operation);
        } catch {
          // The log's own failure changes nothing.
        }
        return cleanError(error);
      }
    }
    return last;
  }

  /**
   * After a record and its identifiers are written: every identifier field
   * shows a number the record now holds (D-038).
   */
  async function identifierFieldProblems(
    tx: Queryable,
    record: CatalogRecord,
  ): Promise<readonly Issue[]> {
    const template = await readTemplate(tx, record.organizationId, record.templateKey ?? "");
    if (!template?.ok) {
      return [issue(["templateKey"], "unknown_template", "The record's template can't be read.")];
    }
    const held = await readRecordIdentifiers(tx, record.organizationId, record.id);
    if (held === undefined) {
      return [issue(["recordId"], "unknown_record", "The organization has no such record.")];
    }
    if (!held.ok) return held.issues.map(underIdentifiers);
    return identifierFieldIssues(record, template.value.template, held.value);
  }

  /**
   * Saves a record's identifier set in the transaction, refusing numbers
   * dropped from every record unless confirmed (D-061).
   */
  async function saveIdentifierSet(
    tx: Queryable,
    organizationId: OrganizationId,
    recordId: RecordId,
    input: unknown,
    confirmed: ReadonlySet<string>,
  ): Promise<ServiceResult<RecordIdentifiers>> {
    const draft = readIdentifierDraft(input, organizationId, recordId);
    if (!draft.ok) return draft;
    const before = await readRecordIdentifiers(tx, organizationId, recordId);
    if (before === undefined) {
      return refusal(["recordId"], "unknown_record", "The organization has no such record.");
    }
    if (!before.ok) return { ok: false, issues: before.issues.map(underIdentifiers) };
    const saved = await saveRecordIdentifiers(tx, draft.value);
    if (!saved.ok) return { ok: false, issues: saved.issues.map(underIdentifiers) };
    const dropped = droppedIdentifiers(before.value, saved.value).filter(
      (d) => d.lost === "identifier",
    );
    const keys = new Set(dropped.map((d) => `${d.type}\u0000${d.value}`));
    const same = keys.size === confirmed.size && [...keys].every((key) => confirmed.has(key));
    if (!same) {
      return {
        ok: false,
        issues: dropped.map((d) =>
          issue(
            ["identifiers", d.type],
            "numbers_dropped",
            `${d.value} would no longer be held by this record, as a current or former number. Confirm it (confirmDropped), or keep it as a former number.`,
          ),
        ),
      };
    }
    return saved;
  }

  /** The terms index for the record, in the same transaction (D-062). */
  async function refreshTerms(
    tx: Queryable,
    organizationId: OrganizationId,
    recordId: RecordId,
  ): Promise<ServiceRefusal | undefined> {
    const refreshed = await refreshRecordTerms(tx, organizationId, recordId);
    return refreshed.ok ? undefined : { ok: false, issues: refreshed.issues };
  }

  /** The actor's access, as a `RecordAccess` for this transaction. */
  async function accessFor(
    tx: Queryable,
    who: Who,
    mode: "write" | "read" = "write",
  ): Promise<ServiceResult<RecordAccess>> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    const checker = new RecordAccess(tx, who.organizationId, access.value, mode);
    // Before any record's place is read (D-065's lock order).
    await checker.settle();
    return { ok: true, value: checker };
  }

  /**
   * Locks the record's row first, then reads its place: what is checked is
   * where the record is and stays until COMMIT (nothing can move it while
   * the row is locked). `undefined` if there is no such record.
   */
  async function lockedPlace(
    tx: Queryable,
    organizationId: OrganizationId,
    recordId: RecordId,
    mode: "no_key_update" | "update" | "share",
  ): Promise<RecordPlace | undefined> {
    if ((await lockRecord(tx, organizationId, recordId, mode)) === undefined) return undefined;
    return readRecordPlace(tx, organizationId, recordId);
  }

  /**
   * The actor's access, and the record's place read under its row lock
   * (`lockedPlace`), refused unless the actor may view it and holds every
   * one of `all` and any one of `any` there.
   */
  async function mayChange(
    tx: Queryable,
    who: Who,
    recordId: RecordId,
    rowLock: "no_key_update" | "update" | "share",
    all: readonly Permission[],
    any: (kind: string) => readonly Permission[] = () => [],
  ): Promise<
    { readonly ok: true; readonly place: RecordPlace; readonly checker: RecordAccess } | Refusal
  > {
    const allowed = await accessFor(tx, who, rowLock === "share" ? "read" : "write");
    if (!allowed.ok) return allowed;
    const place = await lockedPlace(tx, who.organizationId, recordId, rowLock);
    if (place === undefined) return noSuchRecord();
    const denied = await allowed.value.onRecord(
      {
        kind: place.kind,
        id: recordId,
        parentId: place.parentId,
        represents: place.represents,
        siteId: place.siteId,
      },
      all,
      any(place.kind),
    );
    return denied ?? { ok: true, place, checker: allowed.value };
  }

  return Object.freeze({
    async createRecord(context, draftInput, createOptions) {
      return run("createRecord", context, async (tx, who) => {
        const opts = readOptions(createOptions, ["identifiers", "reason"]);
        if (!opts.ok) return opts;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        const draft = readDraft(draftInput, who.organizationId, "create");
        if (!draft.ok) return draft;
        // A new record joins the site the person is working in (D-074); a
        // draft may name that site, never another.
        const namedSite = own(draft.value, "siteId");
        if (namedSite !== undefined && namedSite !== who.siteId) {
          return refusal(
            ["siteId"],
            "wrong_site",
            "A new record joins the site you are working in.",
          );
        }
        const stamp = now();
        if (!stamp.ok) return stamp;
        const valid = validateRecord({
          fields: {},
          ...contentOf(draft.value),
          ...(who.siteId === null ? {} : { siteId: who.siteId }),
          id: newRecordId(),
          organizationId: who.organizationId,
          createdAt: stamp.value,
          updatedAt: stamp.value,
        });
        if (!valid.ok) return valid;
        const record = valid.value;
        // Who may make it, where it goes (T-041), before any record is locked.
        const allowed = await accessFor(tx, who);
        if (!allowed.ok) return allowed;
        // The working site must be one they have a role on (D-074): any
        // other is answered as a site that doesn't exist.
        if (who.siteId !== null && !(await allowed.value.worksOn(who.siteId))) {
          return unknownSite(["context", "siteId"]);
        }
        // The arrangement lock before the parent is locked and checked (D-065).
        if (record.kind === "archival_unit" && record.parentId !== undefined) {
          await lockArrangement(tx, who.organizationId);
        }
        const denied = await allowed.value.intoPlace(
          positionOf(record),
          createPermissions(record.kind),
          false,
        );
        if (denied) return denied;
        if (record.templateKey === undefined) {
          return refusal(["templateKey"], "no_template_key", "Every record names its template.");
        }
        // Links to records the actor can't view: as links to none (D-072).
        const hiddenLinks = await allowed.value.hiddenAmong(addedLinks(record));
        const problems = await recordCheckIssues(tx, record, undefined, {
          messages: "own",
          identifierFields: false,
          hiddenLinks,
        });
        if (problems.length > 0) return { ok: false, issues: problems };
        const inserted = await insertRecord(tx, record, {
          actor: who.actor,
          ...(reason.value === undefined ? {} : { reason: reason.value }),
        });
        if (!inserted.ok) return inserted;
        const identifiers = own(opts.value, "identifiers");
        if (identifiers !== undefined) {
          const saved = await saveIdentifierSet(
            tx,
            who.organizationId,
            record.id,
            identifiers,
            new Set(),
          );
          if (!saved.ok) return saved;
        }
        const fieldProblems = await identifierFieldProblems(tx, record);
        if (fieldProblems.length > 0) return { ok: false, issues: fieldProblems };
        const terms = await refreshTerms(tx, who.organizationId, record.id);
        if (terms) return terms;
        return { ok: true, value: Object.freeze({ record, version: 1, changed: true }) };
      });
    },

    async updateRecord(context, recordId, draftInput, updateOptions) {
      return run("updateRecord", context, async (tx, who) => {
        const org = who.organizationId;
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(updateOptions, [
          "expectedVersion",
          "identifiers",
          "confirmDropped",
          "confirmTemplateMove",
          "reason",
        ]);
        if (!opts.ok) return opts;
        const expected = readExpectedVersion(opts.value);
        if (!expected.ok) return expected;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        const confirmed = readConfirmDropped(opts.value);
        if (!confirmed.ok) return confirmed;
        const confirmedMove = readConfirmTemplateMove(opts.value);
        if (!confirmedMove.ok) return confirmedMove;
        const draft = readDraft(draftInput, org, "update");
        if (!draft.ok) return draft;
        const namedId = own(draft.value, "id");
        if (namedId !== undefined && namedId !== recordId) {
          return refusal(["id"], "wrong_record", "The draft is of another record.");
        }
        const content = contentOf(draft.value);

        const allowed = await accessFor(tx, who);
        if (!allowed.ok) return allowed;
        const checker = allowed.value;
        // Decide from the row as committed whether the edit moves the record
        // (a unit's parent or level, an asset's represented record), and if
        // so take the arrangement lock before the row's lock (D-065). A
        // person with scoped grants holds it already (RecordAccess).
        const seen = await readRecordPlace(tx, org, recordId);
        if (seen === undefined) return noSuchRecord();
        if (movesInArrangement(seen, content)) await lockArrangement(tx, org);
        const identifiers = own(opts.value, "identifiers");
        // The records below it first, so none is published meanwhile
        // (S-020), when the edit may go ahead and can change what they
        // inherit (S-028).
        const atStake = await belowAtStake(
          tx,
          checker,
          org,
          recordId,
          expected.value,
          { all: [], any: editPermissions(seen.kind) },
          (stored) => ({
            fields: {},
            ...(stored.siteId === undefined ? {} : { siteId: stored.siteId }),
            ...content,
            kind: stored.kind,
            id: stored.id,
            organizationId: org,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
          }),
          identifiers !== undefined,
        );
        const lockedBelow = atStake ? await lockBelow(tx, checker, org, recordId) : undefined;
        // Then the row, and its place as it stays until COMMIT: that is what
        // the permissions are checked against.
        const place = await lockedPlace(tx, org, recordId, "no_key_update");
        if (place === undefined) return noSuchRecord();
        const mayEdit = await checker.onRecord(
          {
            kind: place.kind,
            id: recordId,
            parentId: place.parentId,
            represents: place.represents,
            siteId: place.siteId,
          },
          [],
          editPermissions(place.kind),
        );
        if (mayEdit) return mayEdit;
        // Then the records above it (S-020), so what it inherits holds still.
        if (!checker.access.systemManager) {
          const above = await lockAbove(tx, org, [recordId]);
          if (above) return above;
        }
        if (content.kind !== undefined && content.kind !== place.kind) {
          return refusal(
            ["kind"],
            "kind_changed",
            "A record's kind never changes; make a new record instead.",
          );
        }
        if (place.version !== expected.value) {
          const conflict = await versionConflict(tx, org, recordId, expected.value);
          return {
            ok: false,
            issues: [
              issue(
                ["options", "expectedVersion"],
                "version_conflict",
                `The record was saved by someone else since version ${String(expected.value)}; it is now at version ${String(place.version)}. Read it again.`,
              ),
            ],
            ...(conflict === undefined ? {} : { conflict }),
          };
        }
        // Saved between the first look and the lock: the lock decision may
        // be stale, so start again.
        if (seen.version !== place.version) return retryRefusal();
        const stored = await readStoredRecord(tx, org, recordId);
        if (stored === undefined) {
          return refusal(["recordId"], "unknown_record", "The organization has no such record.");
        }
        if (!stored.ok) {
          return refusal(
            ["recordId"],
            "unreadable_record",
            "The stored record no longer reads as a valid record; it needs repair.",
          );
        }
        const before = stored.value.record;
        // Confirming that a published record's values may become public
        // changes the public output at once (D-076).
        // (The row is locked, so its state holds.)
        const state = await readWorkflowState(tx, org, recordId);
        if (state?.state === "published" && (confirmedMove.value?.size ?? 0) > 0) {
          const denied = await publicChangeRefused(tx, who, recordId, "confirm_made_public");
          if (denied) return denied;
        }
        // What its public output shows from other records now (S-020): an
        // edit may add sources only the editor can see.
        const sourcesBefore =
          state?.state === "published"
            ? ((await publicValueSources(tx, org, recordId)) ?? [])
            : undefined;
        const stamp = now();
        if (!stamp.ok) return stamp;
        const valid = validateRecord({
          fields: {},
          // A draft that leaves out the home site keeps it (D-074): a record
          // leaves its site only by naming another.
          ...(before.siteId === undefined ? {} : { siteId: before.siteId }),
          ...content,
          kind: before.kind,
          id: before.id,
          organizationId: org,
          createdAt: before.createdAt,
          updatedAt: later(before.updatedAt, stamp.value),
        });
        if (!valid.ok) return valid;
        const record = valid.value;
        // Moving it (another parent, another represented record) needs the
        // permission where it leaves and where it goes.
        const moved = await moveIssues(tx, checker, recordId, before, record);
        if (moved) return moved;
        // What the published records below it (and scans of them) show from
        // other records now (S-020), if the edit can change what they
        // inherit (S-028): the same answer `belowAtStake` gave, now under
        // the row lock (the record is still at the version it read).
        const watching =
          !checker.access.systemManager &&
          (identifiers !== undefined || changesInheritance(before, record));
        if (watching && lockedBelow === undefined) return retryRefusal();
        const watch = watching
          ? await watchDependents(tx, checker, org, recordId, placeIds(record), lockedBelow)
          : NOTHING_WATCHED;
        if (!watch.ok) return watch;
        const dependentsBefore = watch.watched;
        if (record.templateKey === undefined) {
          return refusal(["templateKey"], "no_template_key", "Every record names its template.");
        }
        const compared = compareRecords(before, record);
        if (!compared.ok) return compared;
        if (compared.value.differences.length === 0 && identifiers === undefined) {
          return {
            ok: true,
            value: Object.freeze({ record: before, version: stored.value.version, changed: false }),
          };
        }
        let version = stored.value.version;
        let saved = before;
        if (compared.value.differences.length > 0) {
          const below = await hiddenChildrenIssue(
            tx,
            checker,
            before,
            record,
            before.siteId ?? null,
          );
          if (below) return below;
          const hiddenLinks = await checker.hiddenAmong(addedLinks(record, before));
          const problems = await recordCheckIssues(tx, record, before, {
            messages: "own",
            identifierFields: false,
            hiddenLinks,
            hiddenParent: await parentHidden(checker, record),
          });
          if (problems.length > 0) return { ok: false, issues: problems };
          if (before.templateKey !== record.templateKey) {
            const moved = await templateMoveIssues(tx, before, record, confirmedMove.value);
            if (moved.length > 0) return { ok: false, issues: moved };
          }
          const updated = await updateStoredRecord(tx, record, {
            expectedVersion: expected.value,
            actor: who.actor,
            ...(reason.value === undefined ? {} : { reason: reason.value }),
          });
          if (!updated.ok) return updated;
          version = updated.value.version;
          saved = record;
        }
        if (identifiers !== undefined) {
          // The template's versions can't change before COMMIT (the checks
          // above took this lock when the record itself changed).
          await lockDefinition(tx, org, "template", saved.templateKey ?? "");
          const set = await saveIdentifierSet(tx, org, recordId, identifiers, confirmed.value);
          if (!set.ok) return set;
        }
        const fieldProblems = await identifierFieldProblems(tx, saved);
        if (fieldProblems.length > 0) return { ok: false, issues: fieldProblems };
        const terms = await refreshTerms(tx, org, recordId);
        if (terms) return terms;
        const unpublishable = await publishedStillPasses(tx, org, recordId, "own");
        if (unpublishable) return unpublishable;
        if (sourcesBefore !== undefined) {
          const hidden = await hiddenSourcesRefusal(tx, checker, org, recordId, sourcesBefore);
          if (hidden) return hidden;
        }
        const below = await dependentsRefusal(tx, checker, org, dependentsBefore);
        if (below) return below;
        return {
          ok: true,
          value: Object.freeze({
            record: saved,
            version,
            changed: compared.value.differences.length > 0,
          }),
        };
      });
    },

    async saveIdentifiers(context, recordId, identifiers, identifierOptions) {
      return run("saveIdentifiers", context, async (tx, who) => {
        const org = who.organizationId;
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(identifierOptions, ["confirmDropped"]);
        if (!opts.ok) return opts;
        const confirmed = readConfirmDropped(opts.value);
        if (!confirmed.ok) return confirmed;
        // The record's row first, as an update does: its place is checked
        // as it stays until COMMIT, and its identifier fields are checked
        // against the new set below and can't change meanwhile. Whoever may
        // change the record may change its numbers: for a digital asset,
        // that includes Scanners (media.attach), as when they make or edit
        // one with its identifiers.
        const allowed = await mayChange(tx, who, recordId, "no_key_update", [], editPermissions);
        if (!allowed.ok) return allowed;
        const stored = await readStoredRecord(tx, org, recordId);
        if (!stored?.ok) {
          return refusal(
            ["recordId"],
            "unreadable_record",
            "The stored record no longer reads as a valid record; it needs repair.",
          );
        }
        // Its template's versions can't change before COMMIT (0008).
        await lockDefinition(tx, org, "template", stored.value.record.templateKey ?? "");
        const saved = await saveIdentifierSet(tx, org, recordId, identifiers, confirmed.value);
        if (!saved.ok) return saved;
        const fieldProblems = await identifierFieldProblems(tx, stored.value.record);
        if (fieldProblems.length > 0) return { ok: false, issues: fieldProblems };
        const unpublishable = await publishedStillPasses(tx, org, recordId, "own");
        if (unpublishable) return unpublishable;
        return saved;
      });
    },

    async restoreVersion(context, recordId, version, restoreOptions) {
      return run("restoreVersion", context, async (tx, who) => {
        const org = who.organizationId;
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(restoreOptions, [
          "expectedVersion",
          "reason",
          "confirmMadePublic",
        ]);
        if (!opts.ok) return opts;
        const expected = readExpectedVersion(opts.value);
        if (!expected.ok) return expected;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        // Restoring reveals the old version and writes it: history and edit
        // (D-065), where the record is and wherever the old version puts it.
        const allowed = await accessFor(tx, who);
        if (!allowed.ok) return allowed;
        const checker = allowed.value;
        // A first look, to decide whether the restore moves the record and
        // so needs the arrangement lock before the row's (D-065).
        const seen = await readRecordPlace(tx, org, recordId);
        if (seen === undefined) return noSuchRecord();
        // Before the old version is read (T-043 review B1): a record the
        // person can't view is answered at once, as a missing one, without
        // reading its version (whose size would show in the time taken) or
        // taking any lock; one they may not restore reads no version either
        // and is refused by the full check under the row lock below. This
        // look locks no row; the full check under the lock stays as it is.
        let mayLook = true;
        if (!checker.access.systemManager) {
          const look = await checker.allowsUnlocked(
            recordId,
            ["records.history"],
            editPermissions(seen.kind),
          );
          if (look === undefined) return noSuchRecord();
          if (!look.allowed) {
            const viewing = await checker.allowsUnlocked(recordId, []);
            if (!viewing?.allowed) return noSuchRecord();
            mayLook = false;
          }
        }
        const wanted =
          mayLook && Number.isInteger(version) && version >= 1 && version < 2 ** 31 - 1
            ? await readVersion(tx, org, recordId, version)
            : undefined;
        // A version without a home site keeps the record's (D-074).
        const stored = wanted?.ok ? wanted.value.record : undefined;
        const old =
          stored !== undefined && stored.siteId === undefined && seen.siteId !== null
            ? ({ ...stored, siteId: seen.siteId } as CatalogRecord)
            : stored;
        if (old !== undefined && movesInArrangement(seen, old)) await lockArrangement(tx, org);
        // The records below it first, so none is published meanwhile
        // (S-020), when the restore may go ahead and can change what they
        // inherit (S-028). As the database's restore builds it: the old
        // version, keeping the home site when it names none.
        const restoredFrom = (current: CatalogRecord): unknown => ({
          ...stored,
          ...(stored?.siteId === undefined && current.siteId !== undefined
            ? { siteId: current.siteId }
            : {}),
          updatedAt: current.updatedAt,
        });
        const atStake = await belowAtStake(
          tx,
          checker,
          org,
          recordId,
          expected.value,
          { all: ["records.history"], any: editPermissions(seen.kind) },
          stored === undefined ? undefined : restoredFrom,
        );
        const lockedBelow = atStake ? await lockBelow(tx, checker, org, recordId) : undefined;
        // Then the row, and the place it is checked at, as it stays until COMMIT.
        const place = await lockedPlace(tx, org, recordId, "no_key_update");
        if (place === undefined) return noSuchRecord();
        const mayRestore = await checker.onRecord(
          {
            kind: place.kind,
            id: recordId,
            parentId: place.parentId,
            represents: place.represents,
            siteId: place.siteId,
          },
          ["records.history"],
          editPermissions(place.kind),
        );
        if (mayRestore) return mayRestore;
        // Allowed now though the first look said not (a grant meanwhile):
        // nothing was decided from the old version, so start again.
        if (!mayLook) return retryRefusal();
        // Then the records above it (S-020), so what it inherits holds still.
        if (!checker.access.systemManager) {
          const above = await lockAbove(tx, org, [recordId]);
          if (above) return above;
        }
        // What a published record's public output shows from other records
        // now (S-020): a restore may add sources only the person can see.
        const sourcesBefore =
          (await readWorkflowState(tx, org, recordId))?.state === "published"
            ? ((await publicValueSources(tx, org, recordId)) ?? [])
            : undefined;
        // Saved between the first look and the lock (and still at the
        // version the person saw): the lock decision may be stale.
        if (place.version === expected.value && seen.version !== place.version) {
          return retryRefusal();
        }
        let hiddenLinks: ReadonlySet<RecordId> = new Set();
        let hiddenParent = false;
        // The record as it stays until COMMIT (its row is locked).
        const current =
          old === undefined || checker.access.systemManager
            ? undefined
            : await readStoredRecord(tx, org, recordId);
        // What the published records below it show from other records now
        // (S-020), if the restore can change what they inherit (S-028): the
        // same answer `belowAtStake` gave, now under the row lock. Not when
        // the restore is refused anyway (another version than the person
        // saw: the database's restore refuses it).
        const watching =
          old !== undefined &&
          !checker.access.systemManager &&
          place.version === expected.value &&
          (current === undefined ||
            !current.ok ||
            changesInheritance(current.value.record, restoredFrom(current.value.record)));
        if (watching && lockedBelow === undefined) return retryRefusal();
        const watch = watching
          ? await watchDependents(tx, checker, org, recordId, placeIds(old), lockedBelow)
          : NOTHING_WATCHED;
        if (!watch.ok) return watch;
        const dependentsBefore = watch.watched;
        if (old !== undefined) {
          const moved = await moveIssues(tx, checker, recordId, place, old);
          if (moved) return moved;
          hiddenParent = await parentHidden(checker, old);
          const below = await hiddenChildrenIssue(tx, checker, place, old, place.siteId);
          if (below) return below;
          if (!checker.access.systemManager) {
            hiddenLinks = await checker.hiddenAmong(
              addedLinks(old, current?.ok ? current.value.record : undefined),
            );
          }
        }
        const stamp = clock();
        const confirm = own(opts.value, "confirmMadePublic");
        const restored = await restoreStoredVersion(
          tx,
          org,
          recordId,
          version,
          {
            expectedVersion: expected.value,
            actor: who.actor,
            ...(reason.value === undefined ? {} : { reason: reason.value }),
          },
          {
            now: stamp,
            hiddenLinks,
            ...(hiddenParent ? { hiddenParent: true } : {}),
            ...(confirm === undefined ? {} : { confirmMadePublic: confirm as readonly string[] }),
          },
        );
        if (!restored.ok) return restored;
        // The row is locked now (the restore wrote it), so its state holds.
        const state = await readWorkflowState(tx, org, recordId);
        if (
          state?.state === "published" &&
          Array.isArray(confirm) &&
          (confirm as readonly unknown[]).length > 0
        ) {
          const denied = await publicChangeRefused(tx, who, recordId, "confirm_made_public");
          if (denied) return denied;
        }
        const terms = await refreshTerms(tx, org, recordId);
        if (terms) return terms;
        // Fixed messages: a restore's refusal must not quote old values (D-065).
        const unpublishable = await publishedStillPasses(tx, org, recordId, "fixed");
        if (unpublishable) return unpublishable;
        if (sourcesBefore !== undefined) {
          const hidden = await hiddenSourcesRefusal(tx, checker, org, recordId, sourcesBefore);
          if (hidden) return hidden;
        }
        const below = await dependentsRefusal(tx, checker, org, dependentsBefore);
        if (below) return below;
        return restored;
      });
    },

    async deleteRecord(context, recordId, deleteOptions) {
      return run("deleteRecord", context, async (tx, who) => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(deleteOptions, ["expectedVersion", "reason"]);
        if (!opts.ok) return opts;
        const expected = readExpectedVersion(opts.value);
        if (!expected.ok) return expected;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        // The row first (FOR UPDATE, as the deletion itself takes it), then
        // the check at its place as it stays until COMMIT.
        const allowed = await mayChange(tx, who, recordId, "update", ["records.delete"]);
        if (!allowed.ok) return allowed;
        const deleted = await deleteStoredRecord(tx, who.organizationId, recordId, {
          expectedVersion: expected.value,
          actor: who.actor,
          ...(reason.value === undefined ? {} : { reason: reason.value }),
        });
        if (deleted.ok || allowed.checker.access.systemManager) return deleted;
        return withoutHiddenUses(deleted);
      });
    },

    async readRecord(context, recordId) {
      return run("readRecord", context, async (tx, who) => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        // A read: the arrangement lock (for scoped grants) is shared, so
        // reads run side by side but never see a move half done, and the
        // row is locked FOR SHARE, so it stays where it was checked.
        const allowed = await mayChange(tx, who, recordId, "share", []);
        if (!allowed.ok) return allowed;
        const stored = await readStoredRecord(tx, who.organizationId, recordId);
        if (stored === undefined) return noSuchRecord();
        if (!stored.ok) {
          return refusal(
            ["recordId"],
            "unreadable_record",
            "The stored record no longer reads as a valid record; it needs repair.",
          );
        }
        // The row is locked FOR SHARE, so the state is the record's as read.
        const state = await readWorkflowState(tx, who.organizationId, recordId);
        if (state === undefined) return noSuchRecord();
        // What the person may do here: the operations' own checks, at the
        // place just checked (T-046). Changes count at the home site only.
        const place = allowed.place;
        const target = await allowed.checker.target({
          kind: place.kind,
          id: recordId,
          parentId: place.parentId,
          represents: place.represents,
          siteId: place.siteId,
        });
        const can: RecordAbilities = Object.freeze({
          edit: allowed.checker.allows(editPermissions(place.kind), target),
          history: allowed.checker.allows(["records.history"], target),
          publish: allowed.checker.allows(["records.publish"], target),
          delete: allowed.checker.allows(["records.delete"], target),
        });
        const record = stored.value.record;
        let inherited: readonly InheritedValue[] = [];
        if (record.kind === "archival_unit" && record.parentId !== undefined) {
          inherited = await visibleInherited(tx, who.organizationId, recordId, allowed.checker);
        }
        return {
          ok: true,
          value: Object.freeze({
            record,
            version: stored.value.version,
            state: state.state,
            can,
            inherited,
          }),
        };
      });
    },

    async listVersions(context, recordId, listOptions) {
      return run("listVersions", context, async (tx, who): Promise<ServiceResult<VersionList>> => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const opts = readOptions(listOptions, ["after", "limit"]);
        if (!opts.ok) return opts;
        const after = own(opts.value, "after") ?? 0;
        const limit = own(opts.value, "limit") ?? 50;
        if (!isWholeNumber(after, 0)) {
          return refusal(["after"], "invalid_version", "A version is a whole number from 1.");
        }
        if (!isWholeNumber(limit, 1) || limit > MAX_VERSION_PAGE) {
          return refusal(
            ["limit"],
            "invalid_limit",
            `The limit is a whole number from 1 to ${String(MAX_VERSION_PAGE)}.`,
          );
        }
        const allowed = await mayChange(tx, who, recordId, "share", ["records.history"]);
        if (!allowed.ok) return allowed;
        // Summaries only (T-043 review B2): no snapshot is read or validated.
        const read = await readVersionSummaries(tx, who.organizationId, recordId, {
          after,
          limit,
        });
        if (!read.ok) return unreadableHistory();
        return read;
      });
    },

    async readRecordVersion(context, recordId, version) {
      return run("readRecordVersion", context, async (tx, who) => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const allowed = await mayChange(tx, who, recordId, "share", ["records.history"]);
        if (!allowed.ok) return allowed;
        if (!isWholeNumber(version, 1)) return noSuchVersion(["version"]);
        const read = await readVersion(tx, who.organizationId, recordId, version);
        if (read === undefined) return noSuchVersion(["version"]);
        if (!read.ok) return unreadableHistory();
        return read;
      });
    },

    async compareRecordVersions(context, recordId, from, to) {
      return run("compareRecordVersions", context, async (tx, who) => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const allowed = await mayChange(tx, who, recordId, "share", ["records.history"]);
        if (!allowed.ok) return allowed;
        if (!isWholeNumber(from, 1)) return noSuchVersion(["from"]);
        if (!isWholeNumber(to, 1)) return noSuchVersion(["to"]);
        const compared = await compareVersions(tx, who.organizationId, recordId, from, to);
        if (compared.ok) return compared;
        const missing = compared.issues.find((i) => i.code === "unknown_version");
        if (missing !== undefined) return noSuchVersion(missing.path);
        return unreadableHistory();
      });
    },

    async reviewQueue(context, queueOptions) {
      return run("reviewQueue", context, async (tx, who): Promise<ServiceResult<ReviewQueue>> => {
        const org = who.organizationId;
        const opts = readOptions(queueOptions, ["limit", "after"]);
        if (!opts.ok) return opts;
        const limit = own(opts.value, "limit") ?? 50;
        if (!isWholeNumber(limit, 1) || limit > 100) {
          return refusal(["limit"], "invalid_limit", "The limit is a whole number from 1 to 100.");
        }
        const after = own(opts.value, "after");
        if (after !== undefined && !isRecordId(after)) {
          return refusal(["after"], "invalid_after", "after is the previous page's next.");
        }
        const access = await readAccess(tx, org, who.actor);
        if (!access.ok) return access;
        if (!holdsAnywhere(access.value, "records.publish")) return notPermitted();
        const sites = await wholeSites(tx, org, access.value, "records.publish");
        // As search (D-066, D-079): a statement_timeout for the list's own
        // statement, so a slow one stops instead of holding a connection.
        await tx.rows(
          sql`SELECT set_config('statement_timeout', ${String(searchTimeoutMs)}, true)`,
        );
        let listed: Awaited<ReturnType<typeof recordsInState>>;
        try {
          listed = await recordsInState(tx, org, "ready_for_review", {
            sites: sites as "all" | readonly SiteId[],
            limit,
            ...(after === undefined ? {} : { after }),
          });
        } catch (error) {
          if (sqlState(error) === "57014") {
            return refusal([], "timeout", "Listing the records took too long and was stopped.");
          }
          throw error;
        }
        if (!listed.ok) return listed;
        const last = listed.value.records.at(-1);
        return {
          ok: true,
          value: Object.freeze({
            records: listed.value.records,
            ...(listed.value.truncated && last !== undefined ? { next: last.id } : {}),
          }),
        };
      });
    },

    async checkRecord(context, draftInput, checkOptions) {
      return run("checkRecord", context, async (tx, who): Promise<ServiceResult<RecordCheck>> => {
        const org = who.organizationId;
        const found = (issues: readonly Issue[]): ServiceResult<RecordCheck> => ({
          ok: true,
          value: Object.freeze({ issues: Object.freeze([...issues]) }),
        });
        const opts = readOptions(checkOptions, ["recordId"]);
        if (!opts.ok) return opts;
        const recordId = own(opts.value, "recordId");
        if (recordId !== undefined && !isRecordId(recordId)) return noSuchRecord();
        if (recordId === undefined) {
          // As createRecord: who may make it where, then today's checks.
          const allowed = await accessFor(tx, who, "read");
          if (!allowed.ok) return allowed;
          if (who.siteId !== null && !(await allowed.value.worksOn(who.siteId))) {
            return unknownSite(["context", "siteId"]);
          }
          const draft = readDraft(draftInput, org, "create");
          if (!draft.ok) return found(draft.issues);
          const namedSite = own(draft.value, "siteId");
          if (namedSite !== undefined && namedSite !== who.siteId) {
            return found([
              issue(["siteId"], "wrong_site", "A new record joins the site you are working in."),
            ]);
          }
          const stamp = now();
          if (!stamp.ok) return stamp;
          const valid = validateRecord({
            fields: {},
            ...contentOf(draft.value),
            ...(who.siteId === null ? {} : { siteId: who.siteId }),
            id: newRecordId(),
            organizationId: org,
            createdAt: stamp.value,
            updatedAt: stamp.value,
          });
          if (!valid.ok) return found(valid.issues);
          const record = valid.value;
          const denied = await allowed.value.intoPlace(
            positionOf(record),
            createPermissions(record.kind),
            false,
          );
          if (denied) {
            // Not allowed at all: refused as the save is. A parent or scan
            // target that is missing (or out of sight) is an issue of the draft.
            if (denied.issues.every((i) => i.code === "not_permitted")) return denied;
            return found(denied.issues);
          }
          if (record.templateKey === undefined) {
            return found([
              issue(["templateKey"], "no_template_key", "Every record names its template."),
            ]);
          }
          const hiddenLinks = await allowed.value.hiddenAmong(addedLinks(record));
          return found(
            await recordCheckIssues(tx, record, undefined, {
              messages: "own",
              identifierFields: false,
              hiddenLinks,
            }),
          );
        }
        // As updateRecord: the record must be one the person may edit.
        const allowed = await mayChange(tx, who, recordId, "share", [], editPermissions);
        if (!allowed.ok) return allowed;
        const stored = await readStoredRecord(tx, org, recordId);
        if (stored === undefined) return noSuchRecord();
        if (!stored.ok) {
          return refusal(
            ["recordId"],
            "unreadable_record",
            "The stored record no longer reads as a valid record; it needs repair.",
          );
        }
        const before = stored.value.record;
        const draft = readDraft(draftInput, org, "update");
        if (!draft.ok) return found(draft.issues);
        const namedId = own(draft.value, "id");
        if (namedId !== undefined && namedId !== recordId) {
          return found([issue(["id"], "wrong_record", "The draft is of another record.")]);
        }
        const content = contentOf(draft.value);
        if (content.kind !== undefined && content.kind !== before.kind) {
          return found([
            issue(
              ["kind"],
              "kind_changed",
              "A record's kind never changes; make a new record instead.",
            ),
          ]);
        }
        const valid = validateRecord({
          fields: {},
          ...(before.siteId === undefined ? {} : { siteId: before.siteId }),
          ...content,
          kind: before.kind,
          id: before.id,
          organizationId: org,
          createdAt: before.createdAt,
          updatedAt: before.updatedAt,
        });
        if (!valid.ok) return found(valid.issues);
        const record = valid.value;
        // A new parent, represented record or home site: the same visibility
        // and permission step the save takes (moveIssues), before any check
        // reads the place, so a parent or record out of sight is answered
        // exactly as a missing one (D-072, D-074), never checked for its level.
        const moved = await moveIssues(tx, allowed.checker, recordId, before, record);
        if (moved) {
          if (moved.issues.every((i) => i.code === "not_permitted")) return moved;
          return found(moved.issues);
        }
        if (record.templateKey === undefined) {
          return found([
            issue(["templateKey"], "no_template_key", "Every record names its template."),
          ]);
        }
        const below = await hiddenChildrenIssue(
          tx,
          allowed.checker,
          before,
          record,
          before.siteId ?? null,
        );
        if (below) return found(below.issues);
        const hiddenLinks = await allowed.checker.hiddenAmong(addedLinks(record, before));
        return found(
          await recordCheckIssues(tx, record, before, {
            messages: "own",
            identifierFields: false,
            hiddenLinks,
            hiddenParent: await parentHidden(allowed.checker, record),
          }),
        );
      });
    },

    async searchRecords(context, query, searchOptions) {
      return run("searchRecords", context, async (tx, who) => {
        const org = who.organizationId;
        const opts = readOptions(searchOptions, ["limit", "after"]);
        if (!opts.ok) return opts;
        const access = await readAccess(tx, org, who.actor);
        if (!access.ok) return access;
        if (!holdsAnywhere(access.value, "records.view")) return notPermitted();
        // Only whole sites the person sees every record of (D-074, D-079).
        const sites = await wholeSites(tx, org, access.value, "records.view");
        // D-066: a statement_timeout for the search's own statement, so a
        // costly query stops instead of holding a connection. SET LOCAL
        // ends with this transaction.
        await tx.rows(
          sql`SELECT set_config('statement_timeout', ${String(searchTimeoutMs)}, true)`,
        );
        try {
          const limit = own(opts.value, "limit");
          const after = own(opts.value, "after");
          const found = await searchStoredRecords(tx, org, query as string, {
            ...(limit === undefined ? {} : { limit: limit as number }),
            ...(after === undefined ? {} : { after: after as string }),
            sites,
          });
          return found;
        } catch (error) {
          if (sqlState(error) === "57014") {
            return refusal(
              ["query"],
              "search_timeout",
              "The search took too long and was stopped. Try more specific words.",
            );
          }
          throw error;
        }
      });
    },

    async listItems(context, listOptions) {
      return run("listItems", context, async (tx, who): Promise<ServiceResult<ItemList>> => {
        const org = who.organizationId;
        const opts = readOptions(listOptions, [
          "query",
          "state",
          "recordType",
          "sort",
          "after",
          "limit",
        ]);
        if (!opts.ok) return opts;
        const query = own(opts.value, "query");
        const state = own(opts.value, "state");
        const recordType = own(opts.value, "recordType");
        const sort = own(opts.value, "sort");
        const after = own(opts.value, "after");
        const limit = own(opts.value, "limit") ?? 50;
        if (!isWholeNumber(limit, 1) || limit > 100) {
          return refusal(["limit"], "invalid_limit", "The limit is a whole number from 1 to 100.");
        }
        if (after !== undefined && typeof after !== "string") {
          return refusal(["after"], "invalid_after", "after is the previous page's next.");
        }
        if (query !== undefined && sort !== undefined) {
          return refusal(["sort"], "invalid_sort", "Search results come best match first.");
        }
        const access = await readAccess(tx, org, who.actor);
        if (!access.ok) return access;
        if (!holdsAnywhere(access.value, "records.view")) return notPermitted();
        // Only whole sites the person sees every record of (D-074, D-079),
        // and of those only the working site when one is given.
        const whole = await wholeSites(tx, org, access.value, "records.view");
        let sites: "all" | readonly SiteId[];
        if (who.siteId === null) {
          sites = whole as "all" | readonly SiteId[];
        } else {
          const checker = new RecordAccess(tx, org, access.value, "read");
          if (!(await checker.worksOn(who.siteId))) return unknownSite(["context", "siteId"]);
          sites = whole === "all" || whole.includes(who.siteId) ? [who.siteId] : [];
        }
        const filters = {
          ...(state === undefined ? {} : { state: state as WorkflowState }),
          ...(recordType === undefined ? {} : { recordType: recordType as string }),
        };
        await tx.rows(
          sql`SELECT set_config('statement_timeout', ${String(searchTimeoutMs)}, true)`,
        );
        try {
          if (query !== undefined) {
            const found = await searchStoredRecords(tx, org, query as string, {
              limit,
              ...(after === undefined ? {} : { after }),
              sites,
              ...filters,
            });
            if (!found.ok) return found;
            return {
              ok: true,
              value: Object.freeze({
                records: Object.freeze(
                  found.value.hits.map((h) =>
                    Object.freeze({
                      recordId: h.recordId,
                      title: h.title,
                      kind: h.kind,
                      recordTypeKey: h.recordTypeKey,
                      siteId: h.siteId,
                      state: h.state,
                      version: h.version,
                      updatedAt: h.updatedAt,
                    }),
                  ),
                ),
                ...(found.value.next === undefined ? {} : { next: found.value.next }),
              }),
            };
          }
          let offset = 0;
          if (after !== undefined) {
            if (!/^(0|[1-9][0-9]{0,4})$/.test(after)) {
              return refusal(["after"], "invalid_after", "after is the previous page's next.");
            }
            offset = Number(after);
          }
          const listed: { ok: true; value: RecordList } | { ok: false; issues: readonly Issue[] } =
            await listStoredRecords(tx, org, {
              sites,
              offset,
              limit,
              ...(sort === undefined ? {} : { sort: sort as "updated" | "title" }),
              ...filters,
            });
          if (!listed.ok) return { ok: false, issues: listed.issues };
          return {
            ok: true,
            value: Object.freeze({
              records: listed.value.records,
              ...(listed.value.next === undefined ? {} : { next: String(listed.value.next) }),
            }),
          };
        } catch (error) {
          if (sqlState(error) === "57014") {
            return refusal(
              ["query"],
              "search_timeout",
              "The list took too long and was stopped. Try more specific words or a filter.",
            );
          }
          throw error;
        }
      });
    },

    async listRecordTypes(context) {
      return run("listRecordTypes", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        // As templates (D-079): anyone who may view records anywhere.
        if (
          !holdsAnywhere(access.value, "records.view") &&
          !holdsAnywhere(access.value, "catalog.definitions")
        ) {
          return notPermitted();
        }
        return { ok: true, value: await listStoredRecordTypes(tx, who.organizationId) };
      });
    },

    async siteAbilities(context) {
      return run(
        "siteAbilities",
        context,
        async (tx, who): Promise<ServiceResult<SiteAbilities>> => {
          const access = await readAccess(tx, who.organizationId, who.actor);
          if (!access.ok) return access;
          const checker = new RecordAccess(tx, who.organizationId, access.value, "read");
          if (who.siteId !== null && !(await checker.worksOn(who.siteId))) {
            return unknownSite(["context", "siteId"]);
          }
          const site = who.siteId;
          // Making a record needs the create permission somewhere on the
          // working site (a scoped grant counts: its holder files under its
          // unit); the save checks the place itself.
          const onSite = (permission: Permission): boolean =>
            access.value.systemManager ||
            access.value.grants.some(
              (g) =>
                (g.siteId === null || g.siteId === site) &&
                (ROLE_PERMISSIONS[g.role] as readonly Permission[]).includes(permission),
            );
          const kinds =
            site === null && !access.value.systemManager
              ? []
              : onSite("records.create")
                ? ["object", "archival_unit", "digital_asset", "agent", "place", "event"]
                : onSite("media.attach")
                  ? ["digital_asset"]
                  : [];
          return {
            ok: true,
            value: Object.freeze({
              createKinds: Object.freeze(kinds),
              review: holdsAnywhere(access.value, "records.publish"),
            }),
          };
        },
      );
    },

    ...adminOperations(run),
    ...definitionOperations(run),
    ...peopleOperations(db, run, onError, searchTimeoutMs),
    ...fileOperations(
      db,
      run,
      (tx, who, recordId, rowLock, all, any) =>
        mayChange(tx, { ...who, siteId: null }, recordId, rowLock, all, any),
      options.files,
      clock,
    ),
    submitForReview: workflowAction("submit_for_review"),
    returnToDraft: workflowAction("return_to_draft"),
    publish: workflowAction("publish"),
    withdraw: workflowAction("withdraw"),

    async checkConnection() {
      return Object.freeze(await checkWriterConnection(db));
    },
  } satisfies RecordService);
}
