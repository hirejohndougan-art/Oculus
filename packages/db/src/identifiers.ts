/**
 * Typed reads and writes for the identifier tables of `0003_identifiers.sql`
 * (T-026, D-061): an organization's identifier types, a record's current and
 * former identifiers, and auto-numbering.
 *
 * As in `catalog.ts`, every value goes in and comes out through
 * `@oculus/core`: writes validate first (`validateNewIdentifierType`,
 * `validateIdentifierType`, `validateRecordIdentifiers` against the
 * organization's stored types) and store the validated copy with each
 * value's `identifierKey` beside it; reads validate again and check every
 * stored key is still `identifierKey(value)`, so a row changed by hand, or a
 * key computed by an older `identifierKey` (D-024: changing the key is a
 * migration), reads as issues. A value stranded by an allowed type change (a
 * new format) is read leniently, as D-031 reads stored sets: returned, with
 * an issue beside it.
 *
 * Uniqueness is the database's: the tables' unique indexes on
 * `(organization_id, type_key, key)` enforce each type's `current` or
 * `all_time` rule, so two saves at the same moment can't take one number.
 * The loser gets a clean `not_unique` refusal naming its own value, never the
 * database's text. Every write runs inside a savepoint in the caller's
 * transaction, so a refusal leaves that transaction usable and unchanged;
 * these functions must be called inside `Database.transaction` (outside one
 * they throw), which is Read Committed; in another isolation level they
 * refuse (`read_committed_required`), as the database's triggers do. Holdings
 * are written in a fixed order and type changes, saves and allocations meet
 * at one lock per type key bucket (D-061: at most 64 per organization), so
 * saves never deadlock each other; a deadlock the database still breaks
 * (allocations of several types one call at a time, in opposite orders) or a
 * full lock table comes back as a clean `retry` refusal.
 *
 * Every read and write names one organization (D-019, D-030); the tables'
 * keys and foreign keys all include it, so another organization's records,
 * types and numbers are never read, counted or reported.
 *
 * Left to the service layer (T-032): checking type changes with
 * `identifierTypeChanges` (D-031) and getting confirmation before
 * `updateIdentifierType`; refusing a save that drops identifiers
 * (`droppedIdentifiers`) unless a person meant it; template `identifier`
 * fields naming current identifiers (`identifierFieldIssues`, D-038).
 */
import {
  MAX_IDENTIFIER_TYPES,
  identifierKey,
  isOrganizationId,
  isRecordId,
  issue,
  newRecordId,
  nextIdentifier,
  validateIdentifierType,
  validateIdentifierTypes,
  validateNewIdentifierType,
  validateRecordIdentifiers,
  type IdentifierType,
  type Issue,
  type OrganizationId,
  type RecordId,
  type RecordIdentifiers,
  type Validated,
} from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";

const BAD_ORGANIZATION = "The organization ID must be a lowercase version 4 UUID.";
const BAD_RECORD = "The record ID must be a lowercase version 4 UUID.";
/** Stored type keys (D-031: older ones may be `constructor` or `prototype`). */
const STORED_TYPE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const CHECK = "23514";
/** The unique indexes that enforce the uniqueness rules. */
const RULE_INDEXES = new Set([
  "identifier_holdings_current_unique",
  "identifier_holdings_all_time_unique",
]);

function refused<T>(
  path: readonly (string | number)[],
  code: string,
  message: string,
): Validated<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** The SQLSTATE and constraint of a database error, if it is one. */
function dbError(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== "string") return undefined;
  return { code, constraint: typeof constraint === "string" ? constraint : "" };
}

/**
 * Runs `work` inside a savepoint of the caller's transaction. If it throws,
 * everything it did is rolled back to the savepoint (the transaction stays
 * usable) and the error is returned for the caller to map; errors it doesn't
 * map are rethrown. Outside a transaction `SAVEPOINT` fails, and so does this.
 * Outside Read Committed nothing is done and the write is refused
 * (`read_committed_required`): the locks of D-061 only keep writes apart when
 * every statement takes a new snapshot. The database refuses such writes too.
 */
async function inSavepoint<T>(
  db: Queryable,
  work: () => Promise<Validated<T>>,
): Promise<{ done: true; value: Validated<T> } | { done: false; error: unknown }> {
  try {
    await db.execute(sql`SAVEPOINT oculus_identifiers`);
  } catch (error) {
    if (dbError(error)?.code === "25P01") {
      throw new Error("Identifier writes must run inside a transaction (Database.transaction).", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const [level] = await db.rows<{ level: string }>(
      sql`SELECT current_setting('transaction_isolation') AS level`,
    );
    const value = level?.level === "read committed" ? await work() : notReadCommitted<T>();
    await db.execute(sql`RELEASE SAVEPOINT oculus_identifiers`);
    return { done: true, value };
  } catch (error) {
    try {
      await db.execute(sql`ROLLBACK TO SAVEPOINT oculus_identifiers`);
      await db.execute(sql`RELEASE SAVEPOINT oculus_identifiers`);
    } catch {
      // The transaction is unusable now; keep why it failed in the first place.
      throw new Error("Rolling back an identifier write failed.", {
        cause: error,
      });
    }
    return { done: false, error };
  }
}

/**
 * The SQLSTATEs worth trying again: a deadlock, a serialization failure, and
 * the server's shared lock table full (53200, out of shared memory: many
 * transactions holding many locks at once).
 */
const TRANSIENT = new Set(["40P01", "40001", "53200"]);
/** Raised by the database's triggers outside Read Committed (0003, D-061). */
const NOT_READ_COMMITTED = "OC061";

function notReadCommitted<T>(): Validated<T> {
  return refused(
    [],
    "read_committed_required",
    "Identifier writes must run in a Read Committed transaction.",
  );
}

/**
 * A clean refusal for a write the database broke off: to resolve a deadlock or
 * for lack of lock memory (`retry`), or because the transaction isn't Read
 * Committed (`read_committed_required`, a direct statement's trigger).
 */
function cleanRefusal<T>(error: unknown): Validated<T> | undefined {
  const code = dbError(error)?.code ?? "";
  if (code === NOT_READ_COMMITTED) return notReadCommitted();
  return TRANSIENT.has(code)
    ? refused(
        [],
        "retry",
        "Another change to the same identifiers happened at the same moment. Try again.",
      )
    : undefined;
}

/** An own data property, never through a getter or a proxy's trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    return slot !== undefined && "value" in slot ? (slot.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Identifier types

/**
 * The organization's identifier types, read and validated as one list
 * (`validateIdentifierTypes`), ordered by key. `lock` takes a share lock on
 * them for the rest of the transaction, so they can't change while a save
 * relies on them.
 */
async function loadTypes(
  db: Queryable,
  organizationId: OrganizationId,
  lock: boolean,
): Promise<Validated<readonly IdentifierType[]>> {
  const rows = await db.rows<{ key: string; definition: unknown }>(
    lock
      ? sql`SELECT key, definition FROM public.identifier_types
            WHERE organization_id = ${organizationId}::uuid ORDER BY key FOR SHARE`
      : sql`SELECT key, definition FROM public.identifier_types
            WHERE organization_id = ${organizationId}::uuid ORDER BY key`,
  );
  return checkTypes(rows, organizationId);
}

/** Stored type rows, validated as one list and checked against their rows. */
function checkTypes(
  rows: readonly { key: string; definition: unknown }[],
  organizationId: OrganizationId,
): Validated<readonly IdentifierType[]> {
  const valid = validateIdentifierTypes(
    rows.map((row) => row.definition),
    organizationId,
  );
  if (!valid.ok) return valid;
  // The table's checks tie the JSON to its row; this is the second line.
  for (const [index, type] of valid.value.entries()) {
    if (type.organizationId !== organizationId || type.key !== rows[index]?.key) {
      return refused([index], "row_mismatch", "A stored identifier type doesn't match its row.");
    }
  }
  return valid;
}

/** The organization's identifier types, validated, ordered by key. */
export async function readIdentifierTypes(
  db: Queryable,
  organizationId: OrganizationId,
): Promise<Validated<readonly IdentifierType[]>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  return loadTypes(db, organizationId, false);
}

/**
 * Stores a new identifier type (`validateNewIdentifierType`). Refuses a key
 * the organization already uses (`key_taken`), more than
 * `MAX_IDENTIFIER_TYPES` types (`too_many`) and an unknown organization.
 * Former identifiers already stored under the key (left from a deleted type
 * or imported) now count under the new type's rule; if they clash under it,
 * nothing is stored (`adopted_values_clash`). Run inside a transaction.
 */
export async function insertIdentifierType(
  db: Queryable,
  input: unknown,
): Promise<Validated<IdentifierType>> {
  const valid = validateNewIdentifierType(input);
  if (!valid.ok) return valid;
  const type = valid.value;
  const org = type.organizationId;
  const result = await inSavepoint(db, async (): Promise<Validated<IdentifierType>> => {
    // Serializes type creation in one organization, so the count holds. A
    // no-key lock doesn't block other rows' foreign key checks.
    const [owner] = await db.rows(
      sql`SELECT 1 FROM public.organizations WHERE id = ${org}::uuid FOR NO KEY UPDATE`,
    );
    if (owner === undefined) {
      return refused(["organizationId"], "unknown_organization", "There is no such organization.");
    }
    const [count] = await db.rows<{ n: number }>(
      sql`SELECT count(*)::integer AS n FROM public.identifier_types
          WHERE organization_id = ${org}::uuid`,
    );
    if ((count?.n ?? 0) >= MAX_IDENTIFIER_TYPES) {
      return refused(
        [],
        "too_many",
        `An organization can have at most ${String(MAX_IDENTIFIER_TYPES)} identifier types.`,
      );
    }
    // The table's trigger (zzzz_identifier_types_adopt_holdings) gives the
    // holdings already stored under the key the new type's rule.
    await db.execute(sql`
      INSERT INTO public.identifier_types (organization_id, key, uniqueness, definition)
      VALUES (${org}::uuid, ${type.key}, ${type.uniqueness}, ${JSON.stringify(type)}::jsonb)`);
    return valid;
  });
  if (result.done) return result.value;
  const retry = cleanRefusal<IdentifierType>(result.error);
  if (retry !== undefined) return retry;
  const error = dbError(result.error);
  if (error?.code === UNIQUE && error.constraint === "identifier_types_pkey") {
    return refused(["key"], "key_taken", "Another identifier type already uses this key.");
  }
  if (error?.code === UNIQUE && RULE_INDEXES.has(error.constraint)) {
    return refused(
      ["uniqueness"],
      "adopted_values_clash",
      "Records already hold former numbers under this key that clash under this uniqueness rule.",
    );
  }
  throw result.error;
}

/**
 * Replaces an identifier type with a new definition of the same key
 * (`validateIdentifierType`). A changed uniqueness rule is checked against
 * every stored value by the database in the same statement: if records
 * already share numbers the new rule forbids, nothing changes
 * (`uniqueness_clash`). Callers must check the change with core's
 * `identifierTypeChanges` and get confirmation first (D-031). Run inside a
 * transaction.
 */
export async function updateIdentifierType(
  db: Queryable,
  input: unknown,
): Promise<Validated<IdentifierType>> {
  const valid = validateIdentifierType(input);
  if (!valid.ok) return valid;
  const type = valid.value;
  const result = await inSavepoint(db, async (): Promise<Validated<IdentifierType>> => {
    const changed = await db.execute(sql`
      UPDATE public.identifier_types
      SET uniqueness = ${type.uniqueness}, definition = ${JSON.stringify(type)}::jsonb,
          updated_at = now()
      WHERE organization_id = ${type.organizationId}::uuid AND key = ${type.key}`);
    return changed === 1
      ? valid
      : refused(["key"], "unknown_type", "The organization has no identifier type with this key.");
  });
  if (result.done) return result.value;
  const retry = cleanRefusal<IdentifierType>(result.error);
  if (retry !== undefined) return retry;
  const error = dbError(result.error);
  if (error?.code === UNIQUE && RULE_INDEXES.has(error.constraint)) {
    return refused(
      ["uniqueness"],
      "uniqueness_clash",
      "Records already share numbers of this type, which the new uniqueness rule forbids.",
    );
  }
  throw result.error;
}

// ---------------------------------------------------------------------------
// A record's identifiers

interface CurrentRow {
  type_key: string;
  value: string;
  key: string;
  is_primary: boolean;
}

interface FormerRow {
  type_key: string;
  value: string;
  key: string;
  retired_at: string | null;
  note: string | null;
}

/**
 * Stores a record's identifiers, replacing what it held: checked first with
 * `validateRecordIdentifiers` against the organization's stored types (locked
 * until the transaction ends, so they can't change under the save). The
 * record must exist in the organization (`unknown_record`).
 *
 * A number another record of the organization holds under its type's rule is
 * refused (`not_unique`, at the value's path) by the database's unique
 * indexes, also when the other save is happening at the same moment: the
 * second waits for the first and is refused if it committed. Nothing is
 * stored then, and the transaction stays usable. Two records swapping
 * numbers at the same moment are both refused, never deadlocked: holdings
 * are written in a fixed order before any is deleted. Run inside a
 * transaction.
 *
 * Callers must check `droppedIdentifiers` first: a number left out is gone,
 * and under `all_time` free to be given to another record.
 */
export async function saveRecordIdentifiers(
  db: Queryable,
  input: unknown,
): Promise<Validated<RecordIdentifiers>> {
  const org = ownValue(input, "organizationId");
  if (!isOrganizationId(org)) return validateRecordIdentifiers(input, []);
  const result = await inSavepoint(db, async (): Promise<Validated<RecordIdentifiers>> => {
    const types = await loadTypes(db, org, true);
    if (!types.ok) return types;
    const valid = validateRecordIdentifiers(input, types.value);
    if (!valid.ok) return valid;
    const set = valid.value;
    // One save of a record's identifiers at a time; a no-key lock doesn't
    // block foreign key checks against the record.
    const [record] = await db.rows(sql`
      SELECT 1 FROM public.records
      WHERE organization_id = ${org}::uuid AND id = ${set.recordId}::uuid
      FOR NO KEY UPDATE`);
    if (record === undefined) {
      return refused(["recordId"], "unknown_record", "The organization has no such record.");
    }
    const where = sql`organization_id = ${org}::uuid AND record_id = ${set.recordId}::uuid`;
    // The value rows point at holdings; they are this record's alone.
    await db.execute(sql`DELETE FROM public.record_identifiers WHERE ${where}`);
    await db.execute(sql`DELETE FROM public.former_identifiers WHERE ${where}`);

    const holdings = new Map<string, { type: string; key: string; current: boolean }>();
    const hold = (type: string, key: string, current: boolean): void => {
      const id = `${type}\u0000${key}`;
      const held = holdings.get(id);
      if (held === undefined) holdings.set(id, { type, key, current });
      else if (current) held.current = true;
    };
    const currentKeys = set.current.map((item) => identifierKey(item.value));
    const formerKeys = set.former.map((item) => identifierKey(item.value));
    set.current.forEach((item, i) => {
      hold(item.type, currentKeys[i] ?? "", true);
    });
    set.former.forEach((item, i) => {
      hold(item.type, formerKeys[i] ?? "", false);
    });
    const held = [...holdings.values()];
    const heldTypes = held.map((h) => h.type);
    const heldKeys = held.map((h) => h.key);
    // Holdings the record keeps or takes are written first, one statement in
    // a fixed order (type, then key, byte order), and only then are the ones
    // it lets go of deleted. So a save that waits on another's number (an
    // uncommitted holding of it) has written only numbers before it in that
    // order and deleted none: two saves can't each wait for the other (two
    // records swapping numbers each meet the other's number still held, and
    // are refused). The types' key locks are taken first, shared, each bucket
    // once and in one fixed order (the trigger takes them again, already held):
    // at most 64 per organization however many keys the former numbers name.
    if (held.length > 0) {
      await db.rows(
        sql`SELECT public.identifier_type_locks(${org}::uuid, ${heldTypes}::text[], false)`,
      );
      await db.execute(sql`
        INSERT INTO public.identifier_holdings
          (organization_id, record_id, type_key, key, current)
        SELECT ${org}::uuid, ${set.recordId}::uuid, h.type_key, h.key, h.current
        FROM unnest(${heldTypes}::text[], ${heldKeys}::text[],
                    ${held.map((h) => h.current)}::boolean[]) AS h(type_key, key, current)
        ORDER BY h.type_key COLLATE "C", h.key COLLATE "C"
        ON CONFLICT (organization_id, record_id, type_key, key)
          DO UPDATE SET current = EXCLUDED.current
          WHERE identifier_holdings.current IS DISTINCT FROM EXCLUDED.current`);
    }
    await db.execute(sql`
      DELETE FROM public.identifier_holdings h
      WHERE h.organization_id = ${org}::uuid AND h.record_id = ${set.recordId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${heldTypes}::text[], ${heldKeys}::text[]) AS kept(type_key, key)
          WHERE kept.type_key = h.type_key AND kept.key = h.key)`);
    if (set.current.length > 0) {
      await db.execute(sql`
        INSERT INTO public.record_identifiers
          (organization_id, record_id, position, type_key, value, key, is_primary)
        SELECT ${org}::uuid, ${set.recordId}::uuid, c.position - 1, c.type_key, c.value, c.key,
               c.is_primary
        FROM unnest(${set.current.map((c) => c.type)}::text[],
                    ${set.current.map((c) => c.value)}::text[], ${currentKeys}::text[],
                    ${set.current.map((c) => c.primary)}::boolean[])
             WITH ORDINALITY AS c(type_key, value, key, is_primary, position)`);
    }
    if (set.former.length > 0) {
      await db.execute(sql`
        INSERT INTO public.former_identifiers
          (organization_id, record_id, position, type_key, value, key, retired_at, note)
        SELECT ${org}::uuid, ${set.recordId}::uuid, f.position - 1, f.type_key, f.value, f.key,
               f.retired_at, f.note
        FROM unnest(${set.former.map((f) => f.type)}::text[],
                    ${set.former.map((f) => f.value)}::text[], ${formerKeys}::text[],
                    ${set.former.map((f) => f.retiredAt ?? null)}::timestamptz[],
                    ${set.former.map((f) => f.note ?? null)}::text[])
             WITH ORDINALITY AS f(type_key, value, key, retired_at, note, position)`);
    }
    return valid;
  });
  if (result.done) return result.value;
  const retry = cleanRefusal<RecordIdentifiers>(result.error);
  if (retry !== undefined) return retry;
  const error = dbError(result.error);
  if (error?.code === UNIQUE && RULE_INDEXES.has(error.constraint)) {
    return clashes(db, org, input);
  }
  // A type removed or its rule changed between the check and the write (the
  // share lock makes this rare): read and try again.
  if (
    (error?.code === FOREIGN_KEY && error.constraint === "identifier_holdings_type_rule") ||
    (error?.code === CHECK && error.constraint === "identifier_holdings_current_has_type")
  ) {
    return refused(
      [],
      "types_changed",
      "The identifier types changed while these identifiers were being saved. Try again.",
    );
  }
  throw result.error;
}

/**
 * The `not_unique` issues of a save the unique indexes refused: which of the
 * record's own values another record of its organization holds under the
 * type's rule. The messages quote only the caller's own values.
 */
async function clashes(
  db: Queryable,
  org: OrganizationId,
  input: unknown,
): Promise<Validated<RecordIdentifiers>> {
  const generic = refused<RecordIdentifiers>(
    [],
    "not_unique",
    "Another record took one of these numbers at the same moment. Try again.",
  );
  const types = await loadTypes(db, org, false);
  if (!types.ok) return generic;
  const valid = validateRecordIdentifiers(input, types.value);
  if (!valid.ok) return generic;
  const set = valid.value;
  const items = [
    ...set.current.map((c, i) => ({ list: "current", index: i, type: c.type, value: c.value })),
    ...set.former.map((f, i) => ({ list: "former", index: i, type: f.type, value: f.value })),
  ];
  const keys = items.map((item) => identifierKey(item.value));
  const taken = await db.rows<{
    type_key: string;
    key: string;
    uniqueness: string;
    current: boolean;
  }>(sql`
    SELECT h.type_key, h.key, h.uniqueness, h.current
    FROM public.identifier_holdings h
    JOIN unnest(${items.map((i) => i.type)}::text[], ${keys}::text[]) AS mine(type_key, key)
      ON h.type_key = mine.type_key AND h.key = mine.key
    WHERE h.organization_id = ${org}::uuid AND h.record_id <> ${set.recordId}::uuid
      AND (h.uniqueness = 'all_time' OR (h.uniqueness = 'current' AND h.current))`);
  const labels = new Map(types.value.map((t) => [t.key, t.label]));
  const issues: Issue[] = [];
  items.forEach((item, i) => {
    const clash = taken.some(
      (row) =>
        row.type_key === item.type &&
        row.key === keys[i] &&
        (row.uniqueness === "all_time" || item.list === "current"),
    );
    if (clash) {
      issues.push(
        issue(
          [item.list, item.index, "value"],
          "not_unique",
          `${labels.get(item.type) ?? item.type} ${JSON.stringify(item.value)} is already used by another record.`,
        ),
      );
    }
  });
  return issues.length > 0 ? { ok: false, issues } : generic;
}

/**
 * A record's identifiers as stored: the set, and the issues of values that
 * no longer fit their type (a format changed since they were saved, D-031).
 */
export type StoredRecordIdentifiers =
  | { readonly ok: true; readonly value: RecordIdentifiers; readonly issues: readonly Issue[] }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** Codes of values stranded by an allowed type change: reported, not refused. */
const STRANDED = new Set(["format_mismatch"]);

/**
 * The record's identifiers as stored, read leniently as D-031 reads stored
 * sets: every shape and safety rule of `validateRecordIdentifiers` against the
 * organization's types as they are now applies, but a current value that no
 * longer fits its type's format (the format changed after it was saved) is
 * still returned, with a `format_mismatch` issue at its path in `issues`.
 * Every stored comparison key is checked against `identifierKey(value)`; a
 * mismatch refuses the read (`key_outdated`), since uniqueness then can't be
 * trusted. Records, values and types are read in one statement, so from one
 * moment. `undefined` if the organization has no such record (including when
 * another organization has).
 */
export async function readRecordIdentifiers(
  db: Queryable,
  organizationId: OrganizationId,
  recordId: RecordId,
): Promise<StoredRecordIdentifiers | undefined> {
  if (!isOrganizationId(organizationId)) {
    return {
      ok: false,
      issues: [issue(["organizationId"], "invalid_organization", BAD_ORGANIZATION)],
    };
  }
  if (!isRecordId(recordId)) {
    return { ok: false, issues: [issue(["recordId"], "invalid_id", BAD_RECORD)] };
  }
  const where = sql`organization_id = ${organizationId}::uuid AND record_id = ${recordId}::uuid`;
  const [row] = await db.rows<{
    current: CurrentRow[] | null;
    former: FormerRow[] | null;
    types: { key: string; definition: unknown }[] | null;
  }>(sql`
    SELECT
      (SELECT json_agg(json_build_object('type_key', type_key, 'value', value, 'key', key,
                                         'is_primary', is_primary) ORDER BY position)
       FROM public.record_identifiers WHERE ${where}) AS current,
      (SELECT json_agg(json_build_object(
                'type_key', type_key, 'value', value, 'key', key, 'note', note,
                'retired_at',
                to_char(retired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              ORDER BY position)
       FROM public.former_identifiers WHERE ${where}) AS former,
      (SELECT json_agg(json_build_object('key', key, 'definition', definition) ORDER BY key)
       FROM public.identifier_types WHERE organization_id = ${organizationId}::uuid) AS types
    FROM public.records
    WHERE organization_id = ${organizationId}::uuid AND id = ${recordId}::uuid`);
  if (row === undefined) return undefined;
  const current = row.current ?? [];
  const former = row.former ?? [];
  const types = checkTypes(row.types ?? [], organizationId);
  if (!types.ok) return types;
  const stored = {
    recordId,
    organizationId,
    current: current.map((item) => ({
      type: item.type_key,
      value: item.value,
      primary: item.is_primary,
    })),
    former: former.map((item) => {
      const entry: Record<string, string> = { type: item.type_key, value: item.value };
      if (item.retired_at !== null) entry.retiredAt = item.retired_at;
      if (item.note !== null) entry.note = item.note;
      return entry;
    }),
  };
  // Checked against the types without their formats, then the formats alone.
  const unformatted = types.value.map(
    (type) =>
      Object.fromEntries(
        Object.entries(type).filter(([key]) => key !== "pattern"),
      ) as unknown as IdentifierType,
  );
  const valid = validateRecordIdentifiers(stored, unformatted);
  if (!valid.ok) return valid;
  const strict = validateRecordIdentifiers(stored, types.value);
  const stranded = strict.ok ? [] : strict.issues.filter((i) => STRANDED.has(i.code));
  if (!strict.ok && stranded.length !== strict.issues.length) {
    // Anything else the formats add is refused, as before.
    return strict;
  }
  const outdated: Issue[] = [];
  const checkKeys = (rows: readonly { value: string; key: string }[], list: string): void => {
    rows.forEach((item, index) => {
      if (item.key !== identifierKey(item.value)) {
        outdated.push(
          issue(
            [list, index, "value"],
            "key_outdated",
            "This value's stored comparison key is out of date; the keys must be recomputed.",
          ),
        );
      }
    });
  };
  checkKeys(current, "current");
  checkKeys(former, "former");
  if (outdated.length > 0) return { ok: false, issues: outdated };
  return { ok: true, value: valid.value, issues: stranded };
}

// ---------------------------------------------------------------------------
// Auto-numbering

/** One number to give out: the type's key, and the year for year numbering. */
export interface AllocationRequest {
  readonly typeKey: string;
  readonly year?: number;
}

/**
 * Gives out the next auto-number of one of the organization's types, as
 * core's `nextIdentifier` works it out (one more than the highest number of
 * the same form the organization's records hold or held), never lower than
 * the last number this function gave out for the type and series (the year
 * for year-based numbering). Gaps are not filled and may appear; a number is
 * never given out twice.
 *
 * The type's key lock (the one saves of its numbers take, D-061) and its
 * counter row are held until the transaction ends: a second allocation of the
 * type waits and then sees the first's number, a save of the type's numbers
 * that hasn't committed is waited for (so a number typed by hand is never
 * given out again), and saves of the type wait for this transaction. Save the
 * number with `saveRecordIdentifiers` in the same transaction; if the save is
 * refused, roll back, or the number stays used. Run inside a transaction.
 *
 * A transaction that needs numbers of several types must get them in one
 * `allocateIdentifiers` call, which locks them in a fixed order: two
 * transactions allocating two types one by one in opposite orders can each
 * wait for the other, and the database then refuses one (`retry`).
 */
export async function allocateIdentifier(
  db: Queryable,
  organizationId: OrganizationId,
  typeKey: string,
  options: { readonly year?: number } = {},
): Promise<Validated<string>> {
  const request: AllocationRequest =
    options.year === undefined ? { typeKey } : { typeKey, year: options.year };
  const result = await allocateIdentifiers(db, organizationId, [request]);
  if (!result.ok) {
    // One request: its issues at their own paths, without the list index.
    return {
      ok: false,
      issues: result.issues.map((i) =>
        i.path[0] === 0 ? issue(i.path.slice(1), i.code, i.message) : i,
      ),
    };
  }
  const [value] = result.value;
  return value === undefined
    ? refused([], "unreadable", "No number was given out.")
    : { ok: true, value };
}

/**
 * Gives out one number per request, as `allocateIdentifier` does, in the
 * order asked, locking the types' key buckets in bucket order and then the
 * counters (type key, then series, byte order) whatever the order asked, so
 * two calls naming the same types never wait for each other. Issues are at
 * `[index, ...]`. Run inside a transaction.
 */
export async function allocateIdentifiers(
  db: Queryable,
  organizationId: OrganizationId,
  requests: readonly AllocationRequest[],
): Promise<Validated<readonly string[]>> {
  if (!isOrganizationId(organizationId)) {
    return refused(["organizationId"], "invalid_organization", BAD_ORGANIZATION);
  }
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 100) {
    return refused([], "invalid_requests", "Ask for between 1 and 100 numbers.");
  }
  const asked: { typeKey: string; options: { year?: number } }[] = [];
  for (const [index, raw] of requests.entries()) {
    const typeKey = ownValue(raw, "typeKey");
    const year = ownValue(raw, "year");
    if (typeof typeKey !== "string" || !STORED_TYPE_KEY.test(typeKey)) {
      return refused([index, "type"], "invalid_type", "That is not an identifier type key.");
    }
    if (year !== undefined && typeof year !== "number") {
      return refused([index, "year"], "invalid_year", "The year must be a number.");
    }
    asked.push({ typeKey, options: year === undefined ? {} : { year } });
  }
  const result = await inSavepoint(db, async (): Promise<Validated<readonly string[]>> => {
    const types = await loadTypes(db, organizationId, true);
    if (!types.ok) return types;
    const plan: { index: number; type: IdentifierType; series: string }[] = [];
    for (const [index, { typeKey, options }] of asked.entries()) {
      const type = types.value.find((t) => t.key === typeKey);
      if (type === undefined) {
        return refused(
          [index, "type"],
          "unknown_type",
          "The organization has no identifier type with this key.",
        );
      }
      // Core's own refusals (no auto-numbering, no year) before any lock.
      const first = nextIdentifier(type, [], options);
      if (!first.ok) {
        return {
          ok: false,
          issues: first.issues.map((i) => issue([index, ...i.path], i.code, i.message)),
        };
      }
      plan.push({
        index,
        type,
        series: type.autoNumber?.style === "year" ? String(options.year) : "",
      });
    }
    const byteOrder = (a: string, b: string): number =>
      Buffer.compare(Buffer.from(a), Buffer.from(b));
    plan.sort((a, b) => byteOrder(a.type.key, b.type.key) || byteOrder(a.series, b.series));
    // The types' key locks, exclusive, in the database's fixed order (as saves
    // take them, shared): waits for saves of the types' numbers that haven't
    // committed, and makes later ones wait for this transaction. Then the
    // counters, each behind its type's lock.
    await db.rows(
      sql`SELECT public.identifier_type_locks(${organizationId}::uuid,
            ${plan.map((p) => p.type.key)}::text[], true)`,
    );
    const given: string[] = [];
    for (const { index, type, series } of plan) {
      const next = await allocateOne(db, organizationId, type, series, asked[index]?.options ?? {});
      if (!next.ok) {
        return {
          ok: false,
          issues: next.issues.map((i) => issue([index, ...i.path], i.code, i.message)),
        };
      }
      given[index] = next.value;
    }
    return { ok: true, value: given };
  });
  if (result.done) return result.value;
  const retry = cleanRefusal<readonly string[]>(result.error);
  if (retry !== undefined) return retry;
  throw result.error;
}

/** One allocation, its type's key lock already held: its counter, then the number. */
async function allocateOne(
  db: Queryable,
  organizationId: OrganizationId,
  type: IdentifierType,
  series: string,
  options: { readonly year?: number },
): Promise<Validated<string>> {
  const typeKey = type.key;
  await db.execute(sql`
    INSERT INTO public.identifier_counters (organization_id, type_key, series)
    VALUES (${organizationId}::uuid, ${typeKey}, ${series})
    ON CONFLICT DO NOTHING`);
  const [counter] = await db.rows<{ last_value: string | null }>(sql`
    SELECT last_value FROM public.identifier_counters
    WHERE organization_id = ${organizationId}::uuid AND type_key = ${typeKey}
      AND series = ${series}
    FOR UPDATE`);
  // Read after the locks: a statement started now sees every number an
  // earlier holder of them saved and committed.
  const held = await db.rows<{ record_id: string; value: string }>(sql`
    SELECT record_id::text AS record_id, value FROM public.record_identifiers
    WHERE organization_id = ${organizationId}::uuid AND type_key = ${typeKey}
    UNION ALL
    SELECT record_id::text, value FROM public.former_identifiers
    WHERE organization_id = ${organizationId}::uuid AND type_key = ${typeKey}`);
  const byRecord = new Map<string, { type: string; value: string }[]>();
  for (const row of held) {
    const list = byRecord.get(row.record_id) ?? [];
    list.push({ type: typeKey, value: row.value });
    byRecord.set(row.record_id, list);
  }
  // The counter's last number counts as held by a record of its own.
  const last = counter?.last_value;
  if (last !== undefined && last !== null) {
    byRecord.set(newRecordId(), [{ type: typeKey, value: last }]);
  }
  const sets = [...byRecord].map(([recordId, former]) => ({
    recordId,
    organizationId,
    current: [],
    former,
  }));
  const next = nextIdentifier(type, sets as unknown as readonly RecordIdentifiers[], options);
  if (!next.ok) return next;
  await db.execute(sql`
    UPDATE public.identifier_counters SET last_value = ${next.value}
    WHERE organization_id = ${organizationId}::uuid AND type_key = ${typeKey}
      AND series = ${series}`);
  return next;
}
