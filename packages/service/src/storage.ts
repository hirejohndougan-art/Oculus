/**
 * Storage levels, locations and moves through the service (T-018d, D-115;
 * core: storage.ts, D-040).
 *
 * **Who.** Reading locations takes `records.view` from a whole-catalog grant
 * on any site; a record's whereabouts and history take `records.view` for
 * the whole catalog of its home site. Changing locations takes
 * `records.edit` from a whole-catalog grant on any site (they are the
 * organization's shelves and boxes, used by every site); the levels are
 * system managers' (as definitions are, D-072). A move takes `records.edit`
 * for the whole catalog of the record's home site. System managers may do
 * everything. Another organization's anything answers like a missing one.
 *
 * **Saving.** Every save takes the organization's storage lock first, reads
 * the whole storage, and has core check the result whole (`indexLocations`,
 * `indexMoves`, `withMove`, `reindexLocations`), so no save can leave a
 * record's history unreadable. A move is written down at the database's
 * time; moves are never changed or deleted (a mistake is put right by a
 * `correction`). An outside location's agent must be one of the
 * organization's agent records.
 *
 * STAFF ONLY: nothing here is ever public.
 */
import {
  DEFAULT_STORAGE_LEVELS,
  grantPermissions,
  createStorageMove,
  holdsForWholeCatalog,
  indexLocations,
  indexMoves,
  isLocationId,
  isRecordId,
  issue,
  moveHistory,
  newLocationId,
  overdueReturns,
  reindexLocations,
  validateStorageLevels,
  validateStorageLocation,
  whereabouts,
  withMove,
  type Access,
  type MoveLog,
  type OrganizationId,
  type RecordId,
  type RolePermission,
  type StorageLevels,
  type StorageLocation,
  type StorageMove,
  type Whereabouts,
} from "@oculus/core";
import {
  insertStorageMove,
  lockStorage,
  readRecordPlace,
  readStorage,
  saveStorageLevels,
  saveStorageLocation,
  sql,
  storageNow,
  type Queryable,
  type StoredStorage,
} from "@oculus/db";
import { NOT_PERMITTED_MESSAGE, readAccess } from "./access.js";
import { hasOnly, own, type Runner } from "./admin.js";
import type { ServiceRefusal, ServiceResult } from "./service.js";

/** The organization's storage as staff see it. */
export interface StorageView {
  readonly levels: StorageLevels;
  /** Pass it as `expectedVersion` when saving the levels; 0 while they are core's defaults. */
  readonly levelsVersion: number;
  readonly locations: readonly { readonly location: StorageLocation; readonly version: number }[];
}

/** Where a record is, and how it got there. */
export interface RecordStorage {
  readonly whereabouts: Whereabouts | null;
  readonly history: readonly StorageMove[];
}

export interface StorageOperations {
  readStorage(context: unknown): Promise<ServiceResult<StorageView>>;
  saveStorageLevels(
    context: unknown,
    levels: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<{ readonly levels: StorageLevels; readonly version: number }>>;
  /** A new location when `locationId` is null (expected version 0). */
  saveStorageLocation(
    context: unknown,
    locationId: unknown,
    location: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<{ readonly location: StorageLocation; readonly version: number }>>;
  recordMove(context: unknown, move: unknown): Promise<ServiceResult<StorageMove>>;
  recordStorage(context: unknown, recordId: unknown): Promise<ServiceResult<RecordStorage>>;
  overdueReturns(context: unknown): Promise<ServiceResult<readonly Whereabouts[]>>;
}

type Refusal = ServiceRefusal;

function refusal(path: (string | number)[], code: string, message: string): Refusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const NOT_PERMITTED = (): Refusal => refusal([], "not_permitted", NOT_PERMITTED_MESSAGE);
const UNKNOWN_RECORD = (): Refusal =>
  refusal(["recordId"], "unknown_record", "There is no such record here.");
const BAD_VERSION = (): Refusal =>
  refusal(
    ["options", "expectedVersion"],
    "invalid_version",
    "Give the version you edited (a whole number; 0 for a new one) as expectedVersion.",
  );
const CONFLICT = (): Refusal =>
  refusal(
    ["options", "expectedVersion"],
    "version_conflict",
    "It was saved by someone else since you opened it. Read it again.",
  );

/**
 * Core's refusal of the storage as a whole, without paths: they can name
 * moves of records the person may not see. Codes and fixed messages stay.
 */
function wholeRefusal(issues: readonly { code: string; message: string }[]): Refusal {
  return {
    ok: false,
    issues: issues.map((i) => issue(["storage"], i.code, i.message)),
  };
}

/** A whole-catalog grant, on any site, of a role holding `permission` (or a system manager). */
function holdsSomewhere(access: Access, permission: RolePermission): boolean {
  if (access.systemManager) return true;
  return access.grants.some((g) => g.scope === null && grantPermissions(g).includes(permission));
}

function expectedOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const MOVE_KEYS = ["recordId", "locationId", "movedOn", "reason", "expectedReturnOn", "note"];
const LOCATION_KEYS = ["kind", "name", "level", "parentId", "container", "agentId", "note"];

export function storageOperations(run: Runner): StorageOperations {
  async function accessOf(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
  ): Promise<{ ok: true; access: Access; userId: string } | Refusal> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    return { ok: true, access: access.value, userId: access.userId };
  }

  /** The levels as stored, or core's defaults for the organization. */
  function levelsOf(org: OrganizationId, stored: StoredStorage): unknown {
    return (
      stored.levels?.definition ?? { organizationId: org, levels: [...DEFAULT_STORAGE_LEVELS] }
    );
  }

  /** The organization's move log as stored, through core. */
  function logOf(org: OrganizationId, stored: StoredStorage): { ok: true; log: MoveLog } | Refusal {
    const index = indexLocations(
      levelsOf(org, stored),
      stored.locations.map((l) => l.definition),
    );
    if (!index.ok) {
      return refusal(["storage"], "unreadable_storage", "The stored locations can't be read now.");
    }
    const log = indexMoves(index.value, stored.moves);
    if (!log.ok) {
      return refusal(["storage"], "unreadable_storage", "The stored moves can't be read now.");
    }
    return { ok: true, log: log.value };
  }

  /** Whether the person may see or change `recordId`'s storage (its home site's whole catalog). */
  async function onRecord(
    tx: Queryable,
    org: OrganizationId,
    access: Access,
    recordId: unknown,
    permission: "records.view" | "records.edit",
  ): Promise<{ ok: true; recordId: RecordId } | Refusal> {
    if (!isRecordId(recordId)) return UNKNOWN_RECORD();
    const place = await readRecordPlace(tx, org, recordId);
    if (place === undefined) return UNKNOWN_RECORD();
    if (access.systemManager) return { ok: true, recordId };
    if (place.siteId === null || !holdsForWholeCatalog(access, permission, place.siteId)) {
      // One the person can't see answers like a missing one.
      return place.siteId !== null && holdsForWholeCatalog(access, "records.view", place.siteId)
        ? NOT_PERMITTED()
        : UNKNOWN_RECORD();
    }
    return { ok: true, recordId };
  }

  async function today(tx: Queryable, org: OrganizationId): Promise<string> {
    const [row] = await tx.rows<{ today: string | null }>(
      sql`SELECT public.organization_local_day(${org}::uuid) AS today`,
    );
    return row?.today ?? "";
  }

  return {
    readStorage(context) {
      return run("readStorage", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const stored = await readStorage(tx, who.organizationId);
        const levels = validateStorageLevels(levelsOf(who.organizationId, stored));
        if (!levels.ok) {
          return refusal(["levels"], "unreadable_storage", "The stored levels can't be read now.");
        }
        return {
          ok: true,
          value: Object.freeze({
            levels: levels.value,
            levelsVersion: stored.levels?.version ?? 0,
            locations: Object.freeze(
              stored.locations.map((l) =>
                Object.freeze({ location: l.definition as StorageLocation, version: l.version }),
              ),
            ),
          }),
        };
      });
    },

    saveStorageLevels(context, input, options) {
      return run("saveStorageLevels", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!may.access.systemManager) return NOT_PERMITTED();
        const expected = expectedOf(own(options, "expectedVersion"));
        if (expected === undefined) return BAD_VERSION();
        if (!hasOnly(input, ["levels"])) {
          return refusal(["levels"], "invalid_request", "Storage levels are { levels }.");
        }
        const candidate = { organizationId: who.organizationId, levels: own(input, "levels") };
        const checked = validateStorageLevels(candidate);
        if (!checked.ok) return { ok: false, issues: checked.issues };
        await lockStorage(tx, who.organizationId);
        const stored = await readStorage(tx, who.organizationId);
        if ((stored.levels?.version ?? 0) !== expected) return CONFLICT();
        const log = logOf(who.organizationId, stored);
        if (!log.ok) return log;
        // A level still in use can't go: core checks the whole storage again.
        const again = reindexLocations(
          log.log,
          checked.value,
          stored.locations.map((l) => l.definition),
        );
        if (!again.ok) return wholeRefusal(again.issues);
        const saved = await saveStorageLevels(
          tx,
          who.organizationId,
          checked.value,
          may.userId,
          expected,
        );
        if (!saved.ok) return CONFLICT();
        return {
          ok: true,
          value: Object.freeze({ levels: checked.value, version: saved.value.version }),
        };
      });
    },

    saveStorageLocation(context, locationId, input, options) {
      return run("saveStorageLocation", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.edit")) return NOT_PERMITTED();
        const expected = expectedOf(own(options, "expectedVersion"));
        if (expected === undefined) return BAD_VERSION();
        if (locationId !== null && !isLocationId(locationId)) {
          return refusal(["locationId"], "unknown_location", "There is no such location.");
        }
        if ((locationId === null) !== (expected === 0)) return BAD_VERSION();
        if (!hasOnly(input, LOCATION_KEYS)) {
          return refusal(
            ["location"],
            "invalid_request",
            `A location is given as ${LOCATION_KEYS.join(", ")}.`,
          );
        }
        const id = locationId ?? newLocationId();
        const candidate: Record<string, unknown> = { id, organizationId: who.organizationId };
        for (const key of LOCATION_KEYS) {
          const value = own(input, key);
          if (value !== undefined) candidate[key] = value;
        }
        const checked = validateStorageLocation(candidate);
        if (!checked.ok) return { ok: false, issues: checked.issues };
        // An outside location's agent: one of the organization's agents.
        const agentId = checked.value.agentId;
        if (agentId !== undefined) {
          const place = await readRecordPlace(tx, who.organizationId, agentId);
          // One the person can't edit on its home site answers like a missing one.
          const mayUse =
            may.access.systemManager ||
            (place?.siteId != null &&
              holdsForWholeCatalog(may.access, "records.edit", place.siteId));
          if (place?.kind !== "agent" || !mayUse) {
            return refusal(
              ["agentId"],
              "unknown_agent",
              "An outside location's agent is an agent record.",
            );
          }
        }
        await lockStorage(tx, who.organizationId);
        const stored = await readStorage(tx, who.organizationId);
        const current = stored.locations.find((l) => (l.definition as { id?: unknown }).id === id);
        if ((current?.version ?? 0) !== expected) {
          return expected === 0 || current !== undefined
            ? CONFLICT()
            : refusal(["locationId"], "unknown_location", "There is no such location.");
        }
        const log = logOf(who.organizationId, stored);
        if (!log.ok) return log;
        const locations = [
          ...stored.locations
            .filter((l) => (l.definition as { id?: unknown }).id !== id)
            .map((l) => l.definition),
          checked.value,
        ];
        const again = reindexLocations(log.log, levelsOf(who.organizationId, stored), locations);
        if (!again.ok) return wholeRefusal(again.issues);
        const saved = await saveStorageLocation(
          tx,
          who.organizationId,
          id,
          checked.value,
          may.userId,
          expected,
        );
        if (!saved.ok) {
          return saved.code === "missing_record"
            ? refusal(
                ["agentId"],
                "unknown_agent",
                "An outside location's agent is an agent record.",
              )
            : CONFLICT();
        }
        return {
          ok: true,
          value: Object.freeze({ location: checked.value, version: saved.value.version }),
        };
      });
    },

    recordMove(context, input) {
      return run("recordMove", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!hasOnly(input, MOVE_KEYS)) {
          return refusal(
            ["move"],
            "invalid_request",
            `A move is given as ${MOVE_KEYS.join(", ")}.`,
          );
        }
        const target = await onRecord(
          tx,
          who.organizationId,
          may.access,
          own(input, "recordId"),
          "records.edit",
        );
        if (!target.ok) return target;
        await lockStorage(tx, who.organizationId);
        const now = await storageNow(tx);
        const fields: Record<string, unknown> = { organizationId: who.organizationId };
        for (const key of MOVE_KEYS) {
          const value = own(input, key);
          if (value !== undefined) fields[key] = value;
        }
        const made = createStorageMove(fields as never, new Date(now));
        if (!made.ok) return { ok: false, issues: made.issues };
        const stored = await readStorage(tx, who.organizationId);
        const log = logOf(who.organizationId, stored);
        if (!log.ok) return log;
        const next = withMove(log.log, made.value, new Date(now));
        if (!next.ok) return wholeRefusal(next.issues);
        const saved = await insertStorageMove(
          tx,
          who.organizationId,
          made.value.id,
          made.value,
          may.userId,
          made.value.recordedAt,
        );
        if (!saved.ok) return UNKNOWN_RECORD();
        return { ok: true, value: made.value };
      });
    },

    recordStorage(context, recordId) {
      return run("recordStorage", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        const target = await onRecord(tx, who.organizationId, may.access, recordId, "records.view");
        if (!target.ok) return target;
        const log = logOf(who.organizationId, await readStorage(tx, who.organizationId));
        if (!log.ok) return log;
        const where = whereabouts(log.log, target.recordId);
        const history = moveHistory(log.log, target.recordId);
        if (!where.ok || !history.ok) {
          return refusal(["storage"], "unreadable_storage", "The stored moves can't be read now.");
        }
        return {
          ok: true,
          value: Object.freeze({ whereabouts: where.value, history: history.value }),
        };
      });
    },

    overdueReturns(context) {
      return run("overdueReturns", context, async (tx, who) => {
        const may = await accessOf(tx, who);
        if (!may.ok) return may;
        if (!holdsSomewhere(may.access, "records.view")) return NOT_PERMITTED();
        const log = logOf(who.organizationId, await readStorage(tx, who.organizationId));
        if (!log.ok) return log;
        const day = await today(tx, who.organizationId);
        const late = overdueReturns(log.log, day);
        if (!late.ok) {
          return refusal(["today"], "unreadable_storage", "Today's date can't be worked out now.");
        }
        const out: Whereabouts[] = [];
        for (const w of late.value) {
          if (may.access.systemManager) {
            out.push(w);
            continue;
          }
          const place = await readRecordPlace(tx, who.organizationId, w.recordId);
          if (
            place?.siteId != null &&
            holdsForWholeCatalog(may.access, "records.view", place.siteId)
          ) {
            out.push(w);
          }
        }
        return { ok: true, value: Object.freeze(out) };
      });
    },
  };
}
