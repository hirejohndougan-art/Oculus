/**
 * Storage locations and moves (Spectrum "Location and movement control";
 * decision D-040).
 *
 * Where things physically are, and how they got there. **Everything here is
 * staff-only.** None of it is a catalog record or a record field, nothing in
 * `effective.ts` or `public-output.ts` reads it, and no public output can be
 * made from it: shelf and box locations tell a thief where to look, and moves
 * name conservators, borrowers and dates.
 *
 * - **Storage levels** are the names an organization gives the levels of its
 *   storage, top down, e.g. Room › Shelf › Box › Folder (mockup Settings,
 *   "Storage levels"). At most `MAX_STORAGE_LEVELS`.
 * - A **location** is one place at one level: a room, a shelf, a box, a
 *   folder, a display case. Each is filed under a location at a higher level
 *   (levels can be skipped, as in D-007: a flat file can sit straight in a
 *   room). A **container** is a location that can itself be moved (a box, a
 *   folder, a flat-file drawer): moving it is an edit of its `parentId`, and
 *   everything in it moves with it. An **external** location is somewhere
 *   outside the organization (a conservator, a digitization vendor, a
 *   borrowing museum), optionally linked to the agent record of who holds it.
 * - A **move** says one record went to one location on one day, why, and (for
 *   a temporary move) when it is expected back. The log of moves is the only
 *   truth: a record's current location, its normal location and its history
 *   are all worked out from the log and never stored on their own (Spectrum
 *   asks for one location entry per object, so the two can't disagree).
 *   `placement` and `rehousing` moves set the normal location; a `return`
 *   must go back to it.
 *
 * Every location, move and set of levels carries a required `organizationId`
 * and any set mixing organizations is refused (D-030). Like `indexTemplates`
 * and `indexRecords`, `indexLocations` and `indexMoves` validate a whole list
 * once into a frozen, opaque snapshot (recognised by a WeakMap, never by
 * shape) that the query functions read; rebuild it after a change. Nothing
 * here throws on bad input.
 */
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { daysInMonth } from "./edtf.js";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  oneOrganization,
  type OrganizationId,
} from "./organizations.js";
import { IssueList, readPlainData, shown, type JsonValue } from "./plain-data.js";
import { isRecordId, type RecordId } from "./record-id.js";

declare const locationIdBrand: unique symbol;
declare const moveIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one storage location forever. */
export type LocationId = string & { readonly [locationIdBrand]: true };

/** A lowercase version 4 UUID that identifies one move forever. */
export type MoveId = string & { readonly [moveIdBrand]: true };

/**
 * `storage`: shelves, boxes, cabinets. `display`: exhibit cases and walls.
 * `external`: anywhere outside the organization (a conservator, a vendor, a
 * borrower).
 */
export const LOCATION_KINDS = ["storage", "display", "external"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * Why a record moved. `placement` (first housing) and `rehousing` (a new
 * permanent home) set the record's normal location. `return` goes back to
 * it. `correction` records where a record really is (found elsewhere in a
 * shelf audit) without changing its normal location. The rest are temporary
 * and may give an expected return date.
 */
export const MOVE_REASONS = [
  "placement",
  "rehousing",
  "return",
  "correction",
  "exhibition",
  "loan_out",
  "conservation",
  "digitization",
  "photography",
  "research",
  "other",
] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

/** Reasons that make the move's location the record's normal location. */
export const NORMAL_LOCATION_REASONS: readonly MoveReason[] = Object.freeze([
  "placement",
  "rehousing",
]);

/** Reasons for a temporary move, the only ones that may give `expectedReturnOn`. */
export const TEMPORARY_MOVE_REASONS: readonly MoveReason[] = Object.freeze([
  "exhibition",
  "loan_out",
  "conservation",
  "digitization",
  "photography",
  "research",
  "other",
]);

/** The levels first-run setup offers (mockup Settings). */
export const DEFAULT_STORAGE_LEVELS: readonly string[] = Object.freeze([
  "Room",
  "Shelf",
  "Box",
  "Folder",
]);

/** An organization's storage level names, top down. */
export interface StorageLevels {
  readonly organizationId: OrganizationId;
  /** e.g. `["Room", "Shelf", "Box", "Folder"]`; a location's `level` indexes this. */
  readonly levels: readonly string[];
}

/** One place things can be: a room, a shelf, a box, a display case, a conservator. */
export interface StorageLocation {
  readonly id: LocationId;
  readonly organizationId: OrganizationId;
  readonly kind: LocationKind;
  /** e.g. "Shelf A", "Box 001", "Case 2". One line. Unique among its siblings. */
  readonly name: string;
  /**
   * Index into the organization's storage levels (0 = the top level, e.g.
   * Room). Required for `storage` and `display`, never given for `external`.
   */
  readonly level?: number;
  /** The location this one sits in, at a higher level. Missing for a top-level one. */
  readonly parentId?: LocationId;
  /** True for something that can itself be moved: a box, a folder, a drawer. */
  readonly container?: true;
  /** For an `external` location: the agent record of who holds things there. */
  readonly agentId?: RecordId;
  /** Staff notes: access, security, environment. */
  readonly note?: string;
}

/** One record going to one location. */
export interface StorageMove {
  readonly id: MoveId;
  readonly organizationId: OrganizationId;
  /** The record (an object, an archival unit …) that moved. */
  readonly recordId: RecordId;
  /** Where it went. */
  readonly locationId: LocationId;
  /** The day it moved, `YYYY-MM-DD` (an EDTF day, D-008). */
  readonly movedOn: string;
  readonly reason: MoveReason;
  /** For a temporary move: the day it is due back, `YYYY-MM-DD`. */
  readonly expectedReturnOn?: string;
  readonly note?: string;
  /** When the move was written down, ISO 8601 UTC. Orders moves on the same day. */
  readonly recordedAt: string;
}

/** A validated, frozen snapshot of one organization's locations. Opaque. */
export interface LocationIndex {
  readonly organizationId: OrganizationId;
  readonly levels: readonly string[];
  readonly size: number;
}

/** A validated, frozen snapshot of one organization's moves. Opaque. */
export interface MoveLog {
  readonly organizationId: OrganizationId;
  /** How many moves. */
  readonly size: number;
  /** How many records have moved at least once. */
  readonly records: number;
}

/** Where one record is, worked out from the move log. */
export interface Whereabouts {
  readonly recordId: RecordId;
  /** Where it is now: the location of its latest move. */
  readonly current: StorageLocation;
  /** The current location's path, e.g. "Archive room › Shelf A › Box 001". */
  readonly currentLabel: string;
  /** The day it got there. */
  readonly since: string;
  /** Why it went there. */
  readonly reason: MoveReason;
  /** Its normal location, or null when no placement or rehousing was recorded. */
  readonly normal: StorageLocation | null;
  readonly normalLabel: string | null;
  /** True when it has a normal location and is somewhere else. */
  readonly away: boolean;
  /** When it is due back, from the latest move, if it is away. */
  readonly expectedReturnOn: string | null;
  /** The latest move. */
  readonly lastMove: StorageMove;
}

export const MAX_STORAGE_LEVELS = 8;
export const MAX_LEVEL_NAME_LENGTH = 60;
export const MAX_LOCATION_NAME_LENGTH = 200;
export const MAX_STORAGE_NOTE_LENGTH = 2000;
/** The most locations one index may hold. */
export const MAX_LOCATIONS = 20_000;
/** The most moves one log may hold. */
export const MAX_MOVES = 200_000;
/** Between two path parts in a location label. */
export const LOCATION_SEPARATOR = " › ";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ONE_LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

const FLAT_LIMITS = {
  maxDepth: 1,
  maxValues: 30,
  maxStringLength: MAX_STORAGE_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 4000,
} as const;
const LEVEL_LIMITS = {
  maxDepth: 2,
  maxValues: 10 + MAX_STORAGE_LEVELS,
  maxStringLength: 100,
  maxKeyLength: 64,
  maxTotalChars: 2000,
} as const;

const LOCATION_KEYS = [
  "id",
  "organizationId",
  "kind",
  "name",
  "level",
  "parentId",
  "container",
  "agentId",
  "note",
] as const;
const MOVE_KEYS = [
  "id",
  "organizationId",
  "recordId",
  "locationId",
  "movedOn",
  "reason",
  "expectedReturnOn",
  "note",
  "recordedAt",
] as const;

// ---------------------------------------------------------------------------
// IDs and days

/** Make a new random location ID. */
export function newLocationId(): LocationId {
  return randomUUID() as LocationId;
}

/** True if `value` is a well-formed location ID (lowercase version 4 UUID). */
export function isLocationId(value: unknown): value is LocationId {
  return typeof value === "string" && UUID_V4.test(value);
}

/** Make a new random move ID. */
export function newMoveId(): MoveId {
  return randomUUID() as MoveId;
}

/** True if `value` is a well-formed move ID (lowercase version 4 UUID). */
export function isMoveId(value: unknown): value is MoveId {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * True for a real calendar day written `YYYY-MM-DD`, years 1000 to 9999, so
 * that comparing two as text compares them as days.
 */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DAY.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// ---------------------------------------------------------------------------
// Validators for one value

/**
 * Check an organization's storage levels from untrusted input: 1 to
 * `MAX_STORAGE_LEVELS` one-line names, no two the same (ignoring case).
 * Returns a fresh, frozen copy, or every problem found. Never throws.
 */
export function validateStorageLevels(input: unknown): Validated<StorageLevels> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "Storage levels must be a plain object.", LEVEL_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    unknownKeys(view.data, ["organizationId", "levels"], "storage levels", issues);
    checkOrganization(view.data.organizationId, "Storage levels", issues);
    const levels = view.data.levels;
    if (!Array.isArray(levels) || levels.length === 0) {
      issues.add(["levels"], "required", "Give at least one storage level, such as Room.");
    } else if (levels.length > MAX_STORAGE_LEVELS) {
      issues.add(
        ["levels"],
        "too_many",
        `There can be at most ${String(MAX_STORAGE_LEVELS)} storage levels.`,
      );
    } else {
      const seen = new Set<string>();
      (levels as readonly JsonValue[]).forEach((name, i) => {
        if (!checkOneLine(name, ["levels", i], "storage level", MAX_LEVEL_NAME_LENGTH, issues)) {
          return;
        }
        const folded = fold(name as string);
        if (seen.has(folded)) {
          issues.add(
            ["levels", i],
            "duplicate_level",
            `Two storage levels are called ${shown(name)}.`,
          );
        }
        seen.add(folded);
      });
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as StorageLevels };
  }, "These storage levels could not be read as plain data.");
}

/**
 * Check one location from untrusted input, on its own (its parent and level
 * are checked against the others by `indexLocations`). Returns a fresh,
 * frozen copy, or every problem found. Never throws.
 */
export function validateStorageLocation(input: unknown): Validated<StorageLocation> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A location must be a plain object.", FLAT_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, LOCATION_KEYS, "a location", issues);
    if (!isLocationId(d.id)) {
      issues.add(["id"], "invalid_id", "The location ID must be a lowercase version 4 UUID.");
    }
    checkOrganization(d.organizationId, "Every location", issues);
    checkOneLine(d.name, ["name"], "location", MAX_LOCATION_NAME_LENGTH, issues);
    checkNote(d.note, issues);
    const kind = d.kind;
    if (!(LOCATION_KINDS as readonly unknown[]).includes(kind)) {
      issues.add(["kind"], "invalid_kind", `Kind must be one of: ${LOCATION_KINDS.join(", ")}.`);
    }
    if (kind === "external") {
      if (d.level !== undefined) {
        issues.add(["level"], "external_level", "An outside location has no storage level.");
      }
      if (d.parentId !== undefined) {
        issues.add(["parentId"], "external_parent", "An outside location can't sit in another.");
      }
      if (d.container !== undefined) {
        issues.add(["container"], "external_container", "An outside location isn't a container.");
      }
      if (d.agentId !== undefined && !isRecordId(d.agentId)) {
        issues.add(["agentId"], "invalid_id", "agentId must be a record ID.");
      }
    } else {
      const level = d.level;
      if (
        typeof level !== "number" ||
        !Number.isInteger(level) ||
        level < 0 ||
        level >= MAX_STORAGE_LEVELS
      ) {
        issues.add(
          ["level"],
          "invalid_level",
          `level must be a whole number from 0 (the top storage level) to ${String(MAX_STORAGE_LEVELS - 1)}.`,
        );
      }
      if (d.parentId !== undefined) {
        if (!isLocationId(d.parentId)) {
          issues.add(["parentId"], "invalid_id", "parentId must be a location ID.");
        } else if (d.parentId === d.id) {
          issues.add(["parentId"], "self_reference", "A location can't sit in itself.");
        }
      }
      if (d.container !== undefined && d.container !== true) {
        issues.add(["container"], "invalid_container", "container is true, or left out.");
      }
      if (d.agentId !== undefined) {
        issues.add(
          ["agentId"],
          "agent_not_external",
          "Only an outside location names who holds things there.",
        );
      }
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as StorageLocation };
  }, "This location could not be read as plain data.");
}

/**
 * Check one move from untrusted input, on its own (its location and its
 * place in the record's history are checked by `indexMoves` and
 * `withMove`). Returns a fresh, frozen copy, or every problem found. Never
 * throws.
 */
export function validateStorageMove(input: unknown): Validated<StorageMove> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A move must be a plain object.", FLAT_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, MOVE_KEYS, "a move", issues);
    if (!isMoveId(d.id)) {
      issues.add(["id"], "invalid_id", "The move ID must be a lowercase version 4 UUID.");
    }
    checkOrganization(d.organizationId, "Every move", issues);
    if (!isRecordId(d.recordId)) {
      issues.add(["recordId"], "invalid_id", "recordId must be a record ID.");
    }
    if (!isLocationId(d.locationId)) {
      issues.add(["locationId"], "invalid_id", "locationId must be a location ID.");
    }
    const reason = d.reason;
    const knownReason = (MOVE_REASONS as readonly unknown[]).includes(reason);
    if (!knownReason) {
      issues.add(
        ["reason"],
        "invalid_reason",
        `Reason must be one of: ${MOVE_REASONS.join(", ")}.`,
      );
    }
    const movedOn = d.movedOn;
    if (!isIsoDay(movedOn)) {
      issues.add(["movedOn"], "invalid_date", "movedOn must be a day written YYYY-MM-DD.");
    }
    const recorded = parseUtc(d.recordedAt);
    if (recorded === undefined) {
      issues.add(
        ["recordedAt"],
        "invalid_timestamp",
        "recordedAt must be an ISO 8601 UTC timestamp like 2026-11-20T16:05:00.000Z.",
      );
    } else if (isIsoDay(movedOn) && movedOn > dayAfter(recorded)) {
      // A day of slack for time zones; a move planned for later isn't a move yet.
      issues.add(
        ["movedOn"],
        "future_move",
        "A move can't be dated after the day it was written down. Record it when it happens.",
      );
    }
    const back = d.expectedReturnOn;
    if (back !== undefined) {
      if (!isIsoDay(back)) {
        issues.add(
          ["expectedReturnOn"],
          "invalid_date",
          "expectedReturnOn must be a day written YYYY-MM-DD.",
        );
      } else if (knownReason && !TEMPORARY_MOVE_REASONS.includes(reason as MoveReason)) {
        issues.add(
          ["expectedReturnOn"],
          "unexpected_return_date",
          `A ${reason as MoveReason} move isn't temporary, so it has no expected return date.`,
        );
      } else if (isIsoDay(movedOn) && back < movedOn) {
        issues.add(
          ["expectedReturnOn"],
          "return_before_move",
          "The expected return date is before the day it moved.",
        );
      }
    }
    checkNote(d.note, issues);
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as StorageMove };
  }, "This move could not be read as plain data.");
}

/**
 * Make a new move with a fresh ID, recorded now, then validate it. `now` is
 * for tests; it defaults to the current time.
 */
export function createStorageMove(
  input: Omit<StorageMove, "id" | "recordedAt">,
  now: Date = new Date(),
): Validated<StorageMove> {
  try {
    const time = Date.prototype.getTime.call(now);
    if (Number.isNaN(time)) throw new RangeError("invalid time");
    if (types.isProxy(input) || !isPlainObject(input)) {
      return refused([], "not_an_object", "A move must be a plain object.");
    }
    const issues = new IssueList();
    const copy = readPlainData(input, [], FLAT_LIMITS, issues);
    if (copy === undefined || !isPlainObject(copy)) return { ok: false, issues: issues.items };
    return validateStorageMove({
      ...copy,
      id: newMoveId(),
      recordedAt: new Date(time).toISOString(),
    });
  } catch {
    return refused([], "invalid_time", "The time the move was recorded is not a valid date.");
  }
}

// ---------------------------------------------------------------------------
// Locations

interface IndexData {
  readonly organizationId: OrganizationId;
  readonly levels: readonly string[];
  readonly byId: ReadonlyMap<LocationId, StorageLocation>;
  readonly children: ReadonlyMap<LocationId, readonly LocationId[]>;
  readonly labels: ReadonlyMap<LocationId, string>;
}

const LOCATION_INDEXES = new WeakMap<object, IndexData>();

/**
 * Validate an organization's storage levels and all its locations once, and
 * index them. Refuses the whole list when any location is invalid, two share
 * an ID, a parent is missing, outside or not at a higher level, a level has
 * no name, two siblings share a name (ignoring case), or anything belongs to
 * another organization (`mixed_organizations`). Never throws.
 */
export function indexLocations(levels: unknown, locations: unknown): Validated<LocationIndex> {
  try {
    const checkedLevels = validateStorageLevels(levels);
    if (!checkedLevels.ok) return prefixed(["levels"], checkedLevels.issues);
    const list = readList(locations, MAX_LOCATIONS, "locations");
    if (!list.ok) return list;
    const issues = new IssueList();
    const valid: StorageLocation[] = [];
    list.value.forEach((given, i) => {
      if (issues.full) return;
      const checked = validateStorageLocation(given);
      if (!checked.ok) {
        for (const found of checked.issues)
          issues.add([i, ...found.path], found.code, found.message);
      } else {
        valid.push(checked.value);
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    const organizationId = checkedLevels.value.organizationId;
    if (oneOrganization([checkedLevels.value, ...valid]) === "mixed") {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These locations and levels")] };
    }
    const levelNames = checkedLevels.value.levels;
    const byId = new Map<LocationId, StorageLocation>();
    valid.forEach((loc, i) => {
      if (byId.has(loc.id)) {
        issues.add([i, "id"], "duplicate_id", "Two locations have the same ID.");
      } else {
        byId.set(loc.id, loc);
      }
    });
    const children = new Map<LocationId, LocationId[]>();
    const siblingNames = new Map<string, Set<string>>();
    valid.forEach((loc, i) => {
      if (loc.level !== undefined && loc.level >= levelNames.length) {
        issues.add(
          [i, "level"],
          "unknown_level",
          `${shown(loc.name)} is at level ${String(loc.level)}, but only ${String(levelNames.length)} storage levels are named.`,
        );
      }
      if (loc.parentId !== undefined) {
        const parent = byId.get(loc.parentId);
        if (parent === undefined) {
          issues.add(
            [i, "parentId"],
            "unknown_parent",
            `${shown(loc.name)} sits in a location that doesn't exist.`,
          );
        } else if (parent.kind === "external") {
          issues.add(
            [i, "parentId"],
            "external_parent",
            `${shown(loc.name)} can't sit in an outside location.`,
          );
        } else if (
          parent.level === undefined ||
          loc.level === undefined ||
          parent.level >= loc.level
        ) {
          // Strictly deeper levels also make a loop impossible.
          issues.add(
            [i, "parentId"],
            "level_order",
            `${shown(loc.name)} must be at a lower storage level than ${shown(parent.name)}, the location it sits in.`,
          );
        } else {
          const kids = children.get(parent.id) ?? [];
          kids.push(loc.id);
          children.set(parent.id, kids);
        }
      }
      const group = loc.parentId ?? `top:${loc.kind === "external" ? "external" : "inside"}`;
      const names = siblingNames.get(group) ?? new Set<string>();
      const folded = fold(loc.name);
      if (names.has(folded)) {
        issues.add(
          [i, "name"],
          "duplicate_name",
          `Two locations in the same place are called ${shown(loc.name)}.`,
        );
      }
      names.add(folded);
      siblingNames.set(group, names);
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    const labels = new Map<LocationId, string>();
    for (const loc of valid) labels.set(loc.id, makeLabel(loc, byId));
    const frozenChildren = new Map<LocationId, readonly LocationId[]>();
    for (const [id, kids] of children) frozenChildren.set(id, Object.freeze(kids));
    const index: LocationIndex = Object.freeze({
      organizationId,
      levels: levelNames,
      size: byId.size,
    });
    LOCATION_INDEXES.set(index, {
      organizationId,
      levels: levelNames,
      byId,
      children: frozenChildren,
      labels,
    });
    return { ok: true, value: index };
  } catch {
    return refused([], "unreadable", "The locations could not be read as plain data.");
  }
}

/** True if `value` is an index made by `indexLocations`. */
export function isLocationIndex(value: unknown): value is LocationIndex {
  return typeof value === "object" && value !== null && LOCATION_INDEXES.has(value);
}

/** One location from an index, or `undefined`. */
export function storageLocation(index: LocationIndex, id: unknown): StorageLocation | undefined {
  const data = indexData(index);
  return data !== undefined && isLocationId(id) ? data.byId.get(id) : undefined;
}

/**
 * A location and the ones it sits in, top first: Archive room, Shelf A,
 * Box 001. `undefined` for an unknown location or something not an index.
 */
export function locationPath(
  index: LocationIndex,
  id: unknown,
): readonly StorageLocation[] | undefined {
  const data = indexData(index);
  if (data === undefined || !isLocationId(id)) return undefined;
  const path: StorageLocation[] = [];
  let at = data.byId.get(id);
  // The levels strictly rise toward the top, so this ends within MAX_STORAGE_LEVELS steps.
  while (at !== undefined && path.length <= MAX_STORAGE_LEVELS) {
    path.unshift(at);
    at = at.parentId === undefined ? undefined : data.byId.get(at.parentId);
  }
  return path.length === 0 ? undefined : Object.freeze(path);
}

/** A location's path as one line, e.g. "Archive room › Shelf A › Box 001". */
export function locationLabel(index: LocationIndex, id: unknown): string | undefined {
  const data = indexData(index);
  return data !== undefined && isLocationId(id) ? data.labels.get(id) : undefined;
}

/** The locations directly inside one location (or the top-level ones, for `undefined`), by name. */
export function locationChildren(
  index: LocationIndex,
  id: LocationId | undefined,
): readonly StorageLocation[] {
  const data = indexData(index);
  if (data === undefined) return Object.freeze([]);
  const found =
    id === undefined
      ? [...data.byId.values()].filter((loc) => loc.parentId === undefined)
      : (data.children.get(id) ?? []).flatMap((kid) => data.byId.get(kid) ?? []);
  return Object.freeze(found.sort(byName));
}

// ---------------------------------------------------------------------------
// Moves

interface LogData {
  readonly index: IndexData;
  readonly ids: ReadonlySet<MoveId>;
  /** Each record's moves, oldest first. */
  readonly byRecord: ReadonlyMap<RecordId, readonly StorageMove[]>;
  readonly size: number;
}

const MOVE_LOGS = new WeakMap<object, LogData>();

/**
 * Validate an organization's moves once, against its location index, and
 * index them by record. Refuses the whole log when a move is invalid, two
 * share an ID, a move goes to a location not in the index, a placement or
 * rehousing goes to an outside location (`external_normal_location`), a
 * return doesn't go to the record's normal location at the time
 * (`not_normal_location`), or any move belongs to another organization than
 * the index (`mixed_organizations`). Never throws.
 */
export function indexMoves(index: LocationIndex, moves: unknown): Validated<MoveLog> {
  try {
    const data = indexData(index);
    if (data === undefined) return notAnIndex();
    const list = readList(moves, MAX_MOVES, "moves");
    if (!list.ok) return list;
    const issues = new IssueList();
    const valid: { move: StorageMove; at: number }[] = [];
    list.value.forEach((given, i) => {
      if (issues.full) return;
      const checked = validateStorageMove(given);
      if (!checked.ok) {
        for (const found of checked.issues)
          issues.add([i, ...found.path], found.code, found.message);
      } else {
        valid.push({ move: checked.value, at: i });
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    if (valid.some(({ move }) => move.organizationId !== data.organizationId)) {
      return { ok: false, issues: [mixedOrganizationsIssue([], "These moves and locations")] };
    }
    const ids = new Set<MoveId>();
    const byRecord = new Map<RecordId, StorageMove[]>();
    for (const { move, at } of valid) {
      if (issues.full) break;
      if (ids.has(move.id)) {
        issues.add([at, "id"], "duplicate_id", "Two moves have the same ID.");
        continue;
      }
      ids.add(move.id);
      if (!data.byId.has(move.locationId)) {
        issues.add(
          [at, "locationId"],
          "unknown_location",
          "This move goes to a location that doesn't exist.",
        );
        continue;
      }
      const list = byRecord.get(move.recordId) ?? [];
      list.push(move);
      byRecord.set(move.recordId, list);
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    const sorted = new Map<RecordId, readonly StorageMove[]>();
    for (const [recordId, list] of byRecord) {
      const history = Object.freeze(list.sort(byWhen));
      for (const found of historyIssues(data, history))
        issues.add(found.path, found.code, found.message);
      sorted.set(recordId, history);
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: makeLog({ index: data, ids, byRecord: sorted, size: ids.size }) };
  } catch {
    return refused([], "unreadable", "The moves could not be read as plain data.");
  }
}

/** True if `value` is a log made by `indexMoves` or `withMove`. */
export function isMoveLog(value: unknown): value is MoveLog {
  return typeof value === "object" && value !== null && MOVE_LOGS.has(value);
}

/**
 * Check a new move against a log before saving it, and return the log with
 * it added. The new move is checked as `indexMoves` would check it, in its
 * place in its record's history (so a back-dated move must fit too). The
 * given log is not changed. Never throws.
 */
export function withMove(log: MoveLog, move: unknown): Validated<MoveLog> {
  try {
    const data = logData(log);
    if (data === undefined) return notALog();
    const checked = validateStorageMove(move);
    if (!checked.ok) return checked;
    const next = checked.value;
    if (next.organizationId !== data.index.organizationId) {
      return { ok: false, issues: [mixedOrganizationsIssue([], "This move and the move log")] };
    }
    if (data.ids.has(next.id))
      return refused(["id"], "duplicate_id", "A move with this ID is already in the log.");
    if (data.size >= MAX_MOVES)
      return refused([], "too_many", `A log can hold at most ${String(MAX_MOVES)} moves.`);
    if (!data.index.byId.has(next.locationId)) {
      return refused(
        ["locationId"],
        "unknown_location",
        "This move goes to a location that doesn't exist.",
      );
    }
    const history = Object.freeze([...(data.byRecord.get(next.recordId) ?? []), next].sort(byWhen));
    const problems = historyIssues(data.index, history);
    if (problems.length > 0) return { ok: false, issues: problems };
    const byRecord = new Map(data.byRecord);
    byRecord.set(next.recordId, history);
    const ids = new Set(data.ids);
    ids.add(next.id);
    return { ok: true, value: makeLog({ index: data.index, ids, byRecord, size: data.size + 1 }) };
  } catch {
    return refused([], "unreadable", "The move could not be read as plain data.");
  }
}

/** One record's moves, oldest first (an empty list when it never moved). */
export function moveHistory(log: MoveLog, recordId: RecordId): Validated<readonly StorageMove[]> {
  const data = logData(log);
  if (data === undefined) return notALog();
  return { ok: true, value: data.byRecord.get(recordId) ?? Object.freeze([]) };
}

/**
 * Where one record is now, where it normally lives, and whether it is
 * away. `null` when it has never moved (its location was never recorded).
 */
export function whereabouts(log: MoveLog, recordId: RecordId): Validated<Whereabouts | null> {
  const data = logData(log);
  if (data === undefined) return notALog();
  const history = data.byRecord.get(recordId);
  return {
    ok: true,
    value: history === undefined ? null : (summarize(data.index, recordId, history) ?? null),
  };
}

/**
 * Every record that has a normal location and is somewhere else (mockup
 * Whereabouts), soonest due back first; those with no expected date last.
 */
export function awayFromNormal(log: MoveLog): Validated<readonly Whereabouts[]> {
  const data = logData(log);
  if (data === undefined) return notALog();
  const away: Whereabouts[] = [];
  for (const [recordId, history] of data.byRecord) {
    const where = summarize(data.index, recordId, history);
    if (where?.away === true) away.push(where);
  }
  return { ok: true, value: Object.freeze(away.sort(byDue)) };
}

/**
 * Every record that is away and was expected back before `today`
 * (`YYYY-MM-DD`, the organization's own date: the caller decides the time
 * zone). Most overdue first.
 */
export function overdueReturns(log: MoveLog, today: unknown): Validated<readonly Whereabouts[]> {
  if (!isIsoDay(today))
    return refused([], "invalid_date", "Today must be a day written YYYY-MM-DD.");
  const away = awayFromNormal(log);
  if (!away.ok) return away;
  return {
    ok: true,
    value: Object.freeze(
      away.value.filter((w) => w.expectedReturnOn !== null && w.expectedReturnOn < today),
    ),
  };
}

/**
 * The records now in one location (a box's contents list), and with
 * `within: true` also in every location inside it. Sorted by record ID.
 */
export function locationContents(
  log: MoveLog,
  locationId: unknown,
  options: { readonly within?: boolean } = {},
): Validated<readonly RecordId[]> {
  const data = logData(log);
  if (data === undefined) return notALog();
  if (!isLocationId(locationId) || !data.index.byId.has(locationId)) {
    return refused([], "unknown_location", "There is no such location.");
  }
  const places = new Set<LocationId>([locationId]);
  if (options.within === true) {
    const queue: LocationId[] = [locationId];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const kid of data.index.children.get(next) ?? []) {
        if (!places.has(kid)) {
          places.add(kid);
          queue.push(kid);
        }
      }
    }
  }
  const found: RecordId[] = [];
  for (const [recordId, history] of data.byRecord) {
    const last = history[history.length - 1];
    if (last !== undefined && places.has(last.locationId)) found.push(recordId);
  }
  return { ok: true, value: Object.freeze(found.sort()) };
}

/**
 * Whether a location can be deleted. It can't while other locations sit in
 * it (`has_children`), or while any move ever went to it (`in_history`):
 * a record's history must stay complete, so a closed room or a used box is
 * renamed or left empty, never deleted. Never throws.
 */
export function checkLocationDeletion(log: MoveLog, locationId: unknown): Validated<true> {
  const data = logData(log);
  if (data === undefined) return notALog();
  if (!isLocationId(locationId) || !data.index.byId.has(locationId)) {
    return refused([], "unknown_location", "There is no such location.");
  }
  const issues: Issue[] = [];
  const kids = data.index.children.get(locationId)?.length ?? 0;
  if (kids > 0) {
    issues.push(
      issue(
        [],
        "has_children",
        `${String(kids)} other location(s) sit in this one. Move or delete them first.`,
      ),
    );
  }
  let used = 0;
  for (const history of data.byRecord.values()) {
    for (const move of history) if (move.locationId === locationId) used += 1;
  }
  if (used > 0) {
    issues.push(
      issue(
        [],
        "in_history",
        `${String(used)} move(s) went to this location. It stays so every record's history stays complete.`,
      ),
    );
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Helpers

/** Problems with one record's history, oldest move first. */
function historyIssues(index: IndexData, history: readonly StorageMove[]): Issue[] {
  const problems: Issue[] = [];
  let normal: LocationId | undefined;
  for (const move of history) {
    const place = index.byId.get(move.locationId);
    if (NORMAL_LOCATION_REASONS.includes(move.reason)) {
      if (place?.kind === "external") {
        problems.push(
          issue(
            ["moves", move.id],
            "external_normal_location",
            "A record's normal location must be inside the organization; use a temporary reason such as loan_out or conservation.",
          ),
        );
      }
      normal = move.locationId;
    } else if (move.reason === "return" && move.locationId !== normal) {
      problems.push(
        issue(
          ["moves", move.id],
          "not_normal_location",
          normal === undefined
            ? "This record has no normal location yet, so it can't be returned. Record a placement instead."
            : "A return must go back to the record's normal location at the time.",
        ),
      );
    }
  }
  return problems;
}

function summarize(
  index: IndexData,
  recordId: RecordId,
  history: readonly StorageMove[],
): Whereabouts | undefined {
  // A log only holds non-empty histories of locations in its index, so the
  // `undefined` answers below can't happen; they keep the types honest.
  const last = history[history.length - 1];
  if (last === undefined) return undefined;
  let normalId: LocationId | undefined;
  for (const move of history) {
    if (NORMAL_LOCATION_REASONS.includes(move.reason)) normalId = move.locationId;
  }
  const current = index.byId.get(last.locationId);
  const currentLabel = index.labels.get(last.locationId);
  if (current === undefined || currentLabel === undefined) return undefined;
  const normal = normalId === undefined ? undefined : index.byId.get(normalId);
  const normalLabel = normalId === undefined ? undefined : index.labels.get(normalId);
  if (normalId !== undefined && (normal === undefined || normalLabel === undefined)) {
    return undefined;
  }
  const away = normal !== undefined && normal.id !== current.id;
  return Object.freeze({
    recordId,
    current,
    currentLabel,
    since: last.movedOn,
    reason: last.reason,
    normal: normal ?? null,
    normalLabel: normalLabel ?? null,
    away,
    expectedReturnOn: away ? (last.expectedReturnOn ?? null) : null,
    lastMove: last,
  });
}

function makeLabel(loc: StorageLocation, byId: ReadonlyMap<LocationId, StorageLocation>): string {
  const names: string[] = [];
  let at: StorageLocation | undefined = loc;
  while (at !== undefined && names.length <= MAX_STORAGE_LEVELS) {
    names.unshift(at.name);
    at = at.parentId === undefined ? undefined : byId.get(at.parentId);
  }
  return names.join(LOCATION_SEPARATOR);
}

function makeLog(data: LogData): MoveLog {
  const log: MoveLog = Object.freeze({
    organizationId: data.index.organizationId,
    size: data.size,
    records: data.byRecord.size,
  });
  MOVE_LOGS.set(log, data);
  return log;
}

function indexData(index: unknown): IndexData | undefined {
  return typeof index === "object" && index !== null ? LOCATION_INDEXES.get(index) : undefined;
}

function logData(log: unknown): LogData | undefined {
  return typeof log === "object" && log !== null ? MOVE_LOGS.get(log) : undefined;
}

/** Oldest first: by day moved, then by when it was written down, then by ID. */
function byWhen(a: StorageMove, b: StorageMove): number {
  if (a.movedOn !== b.movedOn) return a.movedOn < b.movedOn ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Soonest due first, no date last, then by record ID. */
function byDue(a: Whereabouts, b: Whereabouts): number {
  const ad = a.expectedReturnOn;
  const bd = b.expectedReturnOn;
  if (ad !== bd) {
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad < bd ? -1 : 1;
  }
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

function byName(a: StorageLocation, b: StorageLocation): number {
  return a.name.localeCompare(b.name, "en", { numeric: true }) || (a.id < b.id ? -1 : 1);
}

/** Case- and form-insensitive comparison key for names. */
function fold(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/**
 * Read a caller's list once into a frozen shallow copy: Proxies, non-arrays,
 * holes and getters are refused, so nothing reads differently twice.
 */
function readList(input: unknown, max: number, what: string): Validated<readonly unknown[]> {
  if (types.isProxy(input) || !Array.isArray(input)) {
    return refused([], "not_a_list", `The ${what} must be given as a list.`);
  }
  const length = input.length;
  if (length > max) return refused([], "too_many", `At most ${String(max)} ${what} are allowed.`);
  const copy: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(input, i);
    if (slot === undefined || !("value" in slot)) {
      return refused(
        [i],
        "unreadable_entry",
        `Entry ${String(i)} of the ${what} can't be read as plain data.`,
      );
    }
    copy.push(slot.value);
  }
  return { ok: true, value: Object.freeze(copy) };
}

interface TopView {
  readonly copy: Readonly<Record<string, JsonValue>>;
  readonly data: Readonly<Record<string, JsonValue | undefined>>;
}

function readTop(
  input: unknown,
  notObject: string,
  limits: typeof FLAT_LIMITS | typeof LEVEL_LIMITS,
  issues: IssueList,
): TopView | undefined {
  if (types.isProxy(input) || !isPlainObject(input)) {
    issues.add([], "not_an_object", notObject);
    return undefined;
  }
  const copy = readPlainData(input, [], limits, issues);
  if (copy === undefined || !isPlainObject(copy)) return undefined;
  // Read only the copy's own properties, never anything inherited.
  const data = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(copy)) data[key] = copy[key];
  return { copy, data };
}

function checkOrganization(value: JsonValue | undefined, what: string, issues: IssueList): void {
  if (!isOrganizationId(value)) {
    issues.add(
      ["organizationId"],
      "invalid_organization",
      `${what} belongs to one organization: organizationId must be an organization ID.`,
    );
  }
}

/** True when `value` is a usable one-line name; otherwise adds the issues. */
function checkOneLine(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  max: number,
  issues: IssueList,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(path, "required", `Every ${what} needs a name.`);
    return false;
  }
  const before = issues.count;
  if (value !== value.trim()) {
    issues.add(path, "untrimmed", `The ${what} name starts or ends with spaces.`);
  }
  if (value.length > max) {
    issues.add(path, "too_long", `A ${what} name can be at most ${String(max)} characters.`);
  }
  if (ONE_LINE_BREAKS.test(value)) {
    issues.add(
      path,
      "control_characters",
      `A ${what} name must be one line, with no tabs or line breaks.`,
    );
  }
  return issues.count === before;
}

function checkNote(value: JsonValue | undefined, issues: IssueList): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(
      ["note"],
      "invalid_note",
      "A note is text; leave it out when there is nothing to say.",
    );
  } else if (value.length > MAX_STORAGE_NOTE_LENGTH) {
    issues.add(
      ["note"],
      "too_long",
      `A note can be at most ${String(MAX_STORAGE_NOTE_LENGTH)} characters.`,
    );
  }
}

function unknownKeys(
  view: Readonly<Record<string, JsonValue | undefined>>,
  allowed: readonly string[],
  what: string,
  issues: IssueList,
): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(view)) {
    if (!ok.has(key)) {
      issues.add([key], "unknown_property", `${shown(key)} is not a property of ${what}.`);
    }
  }
}

/** Milliseconds since 1970, or undefined if not a real ISO 8601 UTC timestamp. */
function parseUtc(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString() === value ? ms : undefined;
}

/** The UTC day after the one `ms` falls on, as `YYYY-MM-DD`. */
function dayAfter(ms: number): string {
  const day = new Date(ms + 86_400_000).toISOString().slice(0, 10);
  // Past year 9999 the ISO form grows a sign; every allowed day is earlier.
  return ISO_DAY.test(day) ? day : "9999-12-31";
}

function prefixed(
  path: readonly (string | number)[],
  found: readonly Issue[],
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: found.map((f) => issue([...path, ...f.path], f.code, f.message)) };
}

function notAnIndex(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return refused([], "not_a_location_index", "Give the location index made by indexLocations.");
}

function notALog(): { readonly ok: false; readonly issues: readonly Issue[] } {
  return refused([], "not_a_move_log", "Give the move log made by indexMoves or withMove.");
}

function refused(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: [issue(path, code, message)] };
}

function guarded<T>(run: () => Validated<T>, message: string): Validated<T> {
  try {
    return run();
  } catch {
    return refused([], "unreadable", message);
  }
}
