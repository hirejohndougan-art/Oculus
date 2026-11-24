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
 * Not here yet: who may do what (T-041 checks permissions in front of these
 * calls; restore needs the permission to read history as well as to edit,
 * D-065), workflow and publishing (T-034), and loans and accessions (no
 * tables yet; when they are stored, closing a loan by an accession happens
 * here, from the register and loan book read in the same transaction, never
 * from ones a caller hands in, D-067 for T-018a and S-013).
 */
import {
  MAX_FIELD_DEPTH,
  MAX_FIELD_ENTRIES,
  MAX_KEY_LENGTH,
  MAX_RECORD_CHARS,
  MAX_STRING_LENGTH,
  IssueList,
  compareRecords,
  droppedIdentifiers,
  identifierFieldIssues,
  isOrganizationId,
  isPlainObject,
  isRecordId,
  issue,
  newRecordId,
  readPlainData,
  validateRecord,
  type CatalogRecord,
  type Issue,
  type JsonValue,
  type OrganizationId,
  type RecordId,
  type RecordIdentifiers,
} from "@oculus/core";
import {
  checkWriterConnection,
  deleteRecord as deleteStoredRecord,
  insertRecord,
  isActorId,
  lockArrangement,
  lockDefinition,
  lockRecord,
  readOrganization,
  readRecordIdentifiers,
  readRecordPlace,
  readStoredRecord,
  readTemplate,
  recordCheckIssues,
  refreshRecordTerms,
  restoreVersion as restoreStoredVersion,
  saveRecordIdentifiers,
  updateRecord as updateStoredRecord,
  versionConflict,
  type Database,
  type Queryable,
  type RecordDeletion,
  type RecordVersion,
  type VersionConflict,
  type WriterRoleProblem,
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
}

/** The service: every write of a record and its related rows. */
export interface RecordService {
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

/** Thrown inside a transaction to roll it back and return the refusal. */
class Refused extends Error {
  constructor(readonly result: ServiceRefusal) {
    super("refused");
  }
}

/** The draft keys a person edits. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "kind",
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

/** The context, read safely: the organization and actor, or a refusal. */
function readContext(
  context: unknown,
): ServiceResult<{ organizationId: OrganizationId; actor: string }> {
  const extra = keyBeyond(context, new Set(["organizationId", "actor"]));
  if (extra !== undefined) {
    return refusal(
      ["context", extra],
      "unknown_property",
      "The context is organizationId and actor.",
    );
  }
  const organizationId = ownValue(context, "organizationId");
  const actor = ownValue(context, "actor");
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
  return { ok: true, value: { organizationId, actor } };
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
        "not_permitted",
        "The service's database role may not make this change. Check its grants.",
      );
    case "57014":
      return refusal([], "timeout", "The change took too long and was stopped. Nothing was saved.");
    default:
      return refusal([], "internal_error", "Something went wrong; nothing was saved.");
  }
}

const RETRYABLE_STATES: ReadonlySet<string> = new Set([RETRY, SERIALIZATION]);

/** Makes the service over `db`, a pool connected as the writer role. */
export function createService(db: Database, options: ServiceOptions = {}): RecordService {
  const clock = options.now ?? (() => new Date());
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new RangeError("attempts is a whole number from 1 to 10.");
  }
  const onError = options.onError;

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
    work: (
      tx: Queryable,
      who: { organizationId: OrganizationId; actor: string },
    ) => Promise<ServiceResult<T>>,
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

  return Object.freeze({
    async createRecord(context, draftInput, createOptions) {
      return run("createRecord", context, async (tx, who) => {
        const opts = readOptions(createOptions, ["identifiers", "reason"]);
        if (!opts.ok) return opts;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        const draft = readDraft(draftInput, who.organizationId, "create");
        if (!draft.ok) return draft;
        const stamp = now();
        if (!stamp.ok) return stamp;
        const valid = validateRecord({
          fields: {},
          ...contentOf(draft.value),
          id: newRecordId(),
          organizationId: who.organizationId,
          createdAt: stamp.value,
          updatedAt: stamp.value,
        });
        if (!valid.ok) return valid;
        const record = valid.value;
        if (record.templateKey === undefined) {
          return refusal(["templateKey"], "no_template_key", "Every record names its template.");
        }
        // The arrangement lock before any check of the parent (D-065).
        if (record.kind === "archival_unit" && record.parentId !== undefined) {
          await lockArrangement(tx, who.organizationId);
        }
        const problems = await recordCheckIssues(tx, record, undefined, {
          messages: "own",
          identifierFields: false,
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
          "reason",
        ]);
        if (!opts.ok) return opts;
        const expected = readExpectedVersion(opts.value);
        if (!expected.ok) return expected;
        const reason = readReason(opts.value);
        if (!reason.ok) return reason;
        const confirmed = readConfirmDropped(opts.value);
        if (!confirmed.ok) return confirmed;
        const draft = readDraft(draftInput, org, "update");
        if (!draft.ok) return draft;
        const namedId = own(draft.value, "id");
        if (namedId !== undefined && namedId !== recordId) {
          return refusal(["id"], "wrong_record", "The draft is of another record.");
        }
        const content = contentOf(draft.value);

        // Decide from the row as committed whether the arrangement lock is
        // needed, and take it before the row's lock (D-065).
        const place = await readRecordPlace(tx, org, recordId);
        if (place === undefined) {
          return refusal(["recordId"], "unknown_record", "The organization has no such record.");
        }
        if (content.kind !== undefined && content.kind !== place.kind) {
          return refusal(
            ["kind"],
            "kind_changed",
            "A record's kind never changes; make a new record instead.",
          );
        }
        if (
          place.kind === "archival_unit" &&
          ((content.parentId ?? null) !== place.parentId || content.level !== place.level)
        ) {
          await lockArrangement(tx, org);
        }
        const locked = await lockRecord(tx, org, recordId);
        if (locked === undefined) {
          return refusal(["recordId"], "unknown_record", "The organization has no such record.");
        }
        if (locked !== expected.value || place.version !== expected.value) {
          const conflict = await versionConflict(tx, org, recordId, expected.value);
          return {
            ok: false,
            issues: [
              issue(
                ["options", "expectedVersion"],
                "version_conflict",
                `The record was saved by someone else since version ${String(expected.value)}; it is now at version ${String(locked)}. Read it again.`,
              ),
            ],
            ...(conflict === undefined ? {} : { conflict }),
          };
        }
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
        const stamp = now();
        if (!stamp.ok) return stamp;
        const valid = validateRecord({
          fields: {},
          ...content,
          kind: before.kind,
          id: before.id,
          organizationId: org,
          createdAt: before.createdAt,
          updatedAt: later(before.updatedAt, stamp.value),
        });
        if (!valid.ok) return valid;
        const record = valid.value;
        if (record.templateKey === undefined) {
          return refusal(["templateKey"], "no_template_key", "Every record names its template.");
        }
        const identifiers = own(opts.value, "identifiers");
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
          const problems = await recordCheckIssues(tx, record, before, {
            messages: "own",
            identifierFields: false,
          });
          if (problems.length > 0) return { ok: false, issues: problems };
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
        // The record first, as an update does: its identifier fields are
        // checked against the new set below, and can't change meanwhile.
        if ((await lockRecord(tx, org, recordId)) === undefined) {
          return refusal(["recordId"], "unknown_record", "The organization has no such record.");
        }
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
            ...(confirm === undefined ? {} : { confirmMadePublic: confirm as readonly string[] }),
          },
        );
        if (!restored.ok) return restored;
        const terms = await refreshTerms(tx, org, recordId);
        if (terms) return terms;
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
        return deleteStoredRecord(tx, who.organizationId, recordId, {
          expectedVersion: expected.value,
          actor: who.actor,
          ...(reason.value === undefined ? {} : { reason: reason.value }),
        });
      });
    },

    async checkConnection() {
      return Object.freeze(await checkWriterConnection(db));
    },
  } satisfies RecordService);
}
