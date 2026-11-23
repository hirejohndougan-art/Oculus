// Attack tests for storage locations and moves: another organization's data,
// hostile lists and objects, forged indexes and logs, huge inputs, and
// staff-only locations trying to reach public output.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORAGE_LEVELS,
  MAX_LOCATIONS,
  MAX_MOVES,
  MAX_STORAGE_NOTE_LENGTH,
  awayFromNormal,
  checkLocationDeletion,
  indexLocations,
  indexMoves,
  locationContents,
  locationLabel,
  moveHistory,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  overdueReturns,
  publicOutput,
  publicView,
  validateRecord,
  validateStorageLocation,
  validateStorageMove,
  whereabouts,
  withMove,
  type LocationIndex,
  type MoveLog,
  type PublicRecord,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";
import { accessionsFor, BASE, CHECKERS, MAPPING, nowOf } from "./public-output.fixtures.js";

const ORG = newOrganizationId();
const OTHER = newOrganizationId();
const LEVELS = { organizationId: ORG, levels: [...DEFAULT_STORAGE_LEVELS] };

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function without(obj: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function messages(result: Validated<unknown>): string {
  return result.ok ? "" : result.issues.map((i) => i.message).join("\n");
}

function room(name = "Archive room", organizationId: string = ORG): StorageLocation {
  return {
    id: newLocationId(),
    organizationId,
    kind: "storage",
    name,
    level: 0,
  } as StorageLocation;
}

function move(
  recordId: string,
  locationId: string,
  reason: StorageMove["reason"] = "placement",
  extra: Partial<StorageMove> = {},
): StorageMove {
  return {
    id: newMoveId(),
    organizationId: ORG,
    recordId,
    locationId,
    movedOn: "2026-11-20",
    reason,
    recordedAt: "2026-11-20T16:05:00.000Z",
    ...extra,
  } as StorageMove;
}

const home = room();
const vault = room("Secret vault");
const idx: LocationIndex = ok(indexLocations(LEVELS, [home, vault]));
const item = newRecordId();
const log: MoveLog = ok(indexMoves(idx, [move(item, vault.id)]));

describe("another organization's data is refused, never filtered", () => {
  it("refuses a location of another organization, without naming it", () => {
    const theirs = room("Their strongroom", OTHER);
    const r = indexLocations(LEVELS, [home, theirs]);
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(messages(r)).not.toContain("strongroom");
    expect(messages(r)).not.toContain(OTHER);
  });

  it("refuses levels of another organization than the locations", () => {
    expect(codes(indexLocations({ ...LEVELS, organizationId: OTHER }, [home]))).toEqual([
      "mixed_organizations",
    ]);
  });

  it("refuses a location or move that doesn't say which organization it belongs to", () => {
    const orphan = without(home, "organizationId");
    expect(codes(indexLocations(LEVELS, [orphan]))).toEqual(["invalid_organization"]);
    const orphanMove = without(move(item, home.id), "organizationId");
    expect(codes(indexMoves(idx, [orphanMove]))).toEqual(["invalid_organization"]);
  });

  it("refuses another organization's move in a log or added to one", () => {
    const theirs = move(item, home.id, "return", { organizationId: OTHER });
    expect(codes(indexMoves(idx, [move(item, vault.id), theirs]))).toEqual(["mixed_organizations"]);
    expect(codes(withMove(log, theirs, new Date("2026-11-21T00:00:00.000Z")))).toEqual([
      "mixed_organizations",
    ]);
    expect(ok(whereabouts(log, item))?.current.id).toBe(vault.id);
  });

  it("refuses a move to another organization's location, even with its own organizationId", () => {
    const theirIdx = ok(
      indexLocations({ organizationId: OTHER, levels: ["Room"] }, [room("X", OTHER)]),
    );
    expect(codes(indexMoves(theirIdx, [move(item, home.id)]))).toEqual(["mixed_organizations"]);
    expect(codes(indexMoves(idx, [move(item, newLocationId())]))).toEqual(["unknown_location"]);
  });
});

describe("hostile lists and objects", () => {
  it("refuses Proxies, non-lists, holes and getters", () => {
    expect(codes(indexLocations(LEVELS, new Proxy([home], {})))).toEqual(["not_a_list"]);
    expect(codes(indexLocations(LEVELS, { 0: home, length: 1 }))).toEqual(["not_a_list"]);
    // eslint-disable-next-line no-sparse-arrays -- a hole is the attack
    expect(codes(indexLocations(LEVELS, [home, , vault]))).toEqual(["unreadable_entry"]);
    const tricky: unknown[] = [];
    let reads = 0;
    Object.defineProperty(tricky, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? home : room("Swapped", OTHER);
      },
    });
    expect(codes(indexLocations(LEVELS, tricky))).toEqual(["unreadable_entry"]);
    expect(reads).toBe(0);
    expect(codes(indexMoves(idx, new Proxy([], {})))).toEqual(["not_a_list"]);
  });

  it("refuses a location or move with a getter, a Proxy or a prototype key", () => {
    const getter = { ...home };
    Object.defineProperty(getter, "organizationId", { enumerable: true, get: () => ORG });
    expect(codes(validateStorageLocation(getter))).toEqual(["not_plain_data"]);
    expect(codes(validateStorageLocation(new Proxy({ ...home }, {})))).toEqual(["not_an_object"]);
    const polluted: unknown = JSON.parse(
      `{"id":"${newLocationId()}","organizationId":"${ORG}","kind":"storage","name":"R","level":0,"__proto__":{"container":true}}`,
    );
    expect(codes(validateStorageLocation(polluted))).toEqual(["forbidden_key"]);
    expect(codes(validateStorageMove({ ...move(item, home.id), note: { text: "x" } }))).toEqual([
      "too_deep",
    ]);
  });

  it("refuses names that hide or reorder text", () => {
    expect(codes(validateStorageLocation({ ...home, name: "Box ‮100" }))).toEqual([
      "bad_characters",
    ]);
    expect(codes(validateStorageLocation({ ...home, name: "Box 100" }))).toEqual([
      "control_characters",
    ]);
  });

  it("keeps work bounded on huge input", () => {
    const huge: unknown[] = [];
    huge.length = MAX_LOCATIONS + 1;
    expect(codes(indexLocations(LEVELS, huge))).toEqual(["too_many"]);
    const moves: unknown[] = [];
    moves.length = MAX_MOVES + 1;
    expect(codes(indexMoves(idx, moves))).toEqual(["too_many"]);
    const note = "x".repeat(MAX_STORAGE_NOTE_LENGTH + 1);
    expect(codes(validateStorageMove({ ...move(item, home.id), note }))).toContain("too_long");
  });

  it("a caller changing its objects afterwards changes nothing", () => {
    const mine = { ...home, name: "Reading room" };
    const list = [mine];
    const i2 = ok(indexLocations(LEVELS, list));
    mine.name = "Changed";
    list.push(room("Added"));
    expect(i2.size).toBe(1);
    expect(locationLabel(i2, home.id)).toBe("Reading room");
    expect(Object.isFrozen(i2)).toBe(true);
    const history = ok(moveHistory(log, item));
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect(Object.isFrozen(ok(whereabouts(log, item)))).toBe(true);
  });
});

describe("forged indexes and logs", () => {
  it("refuses an index or log that only looks like one", () => {
    const forgedIdx = { ...idx };
    expect(codes(indexMoves(forgedIdx, []))).toEqual(["not_a_location_index"]);
    expect(locationLabel(forgedIdx, home.id)).toBeUndefined();
    const forgedLog = { ...log };
    for (const result of [
      whereabouts(forgedLog, item),
      moveHistory(forgedLog, item),
      awayFromNormal(forgedLog),
      overdueReturns(forgedLog, "2026-11-23"),
      locationContents(forgedLog, home.id),
      checkLocationDeletion(forgedLog, home.id),
      withMove(forgedLog, move(item, home.id, "other")),
    ]) {
      expect(codes(result)).toEqual(["not_a_move_log"]);
    }
    expect(codes(indexMoves(null as never, []))).toEqual(["not_a_location_index"]);
    expect(codes(whereabouts(new Proxy(log, {}), item))).toEqual(["not_a_move_log"]);
  });

  it("can't rewrite history by reusing a move's ID", () => {
    const first = ok(moveHistory(log, item))[0];
    if (first === undefined) throw new Error("no history");
    expect(codes(withMove(log, { ...first, locationId: home.id }))).toEqual(["duplicate_id"]);
  });

  it("can't pin a record's location by stamping a move in the future (second review)", () => {
    const now = new Date("2026-11-21T12:00:00.000Z");
    const forged = move(item, home.id, "other", {
      movedOn: "2026-11-21",
      recordedAt: "9999-12-30T00:00:00.000Z",
    });
    expect(codes(withMove(log, forged, now))).toEqual(["future_recorded"]);
    const fine = move(item, home.id, "other", {
      movedOn: "2026-11-21",
      recordedAt: "2026-11-21T12:04:00.000Z",
    });
    expect(ok(withMove(log, fine, now)).size).toBe(2);
    expect(codes(withMove(log, fine, new Date(Number.NaN)))).toEqual(["invalid_time"]);
  });

  it("can't delete a location that is in a record's history", () => {
    expect(codes(checkLocationDeletion(log, vault.id))).toEqual(["in_history"]);
  });
});

describe("storage stays staff-only", () => {
  it("a location or move is never a record, and never a public view", () => {
    expect(validateRecord(home).ok).toBe(false);
    expect(validateRecord({ ...move(item, home.id), kind: "object", title: "x" }).ok).toBe(false);
    const w = ok(whereabouts(log, item));
    for (const thing of [home, move(item, home.id), w, idx, log]) {
      expect(publicView(thing as never)).toBeUndefined();
      const out = publicOutput(thing as unknown as PublicRecord, MAPPING, {
        ...nowOf(thing),
        baseUrl: BASE,
        accessions: accessionsFor(thing),
        published: [item],
        checkers: CHECKERS,
      });
      expect(codes(out)).toEqual(["not_public_view"]);
    }
  });

  // Changed in T-018: the loans and condition-check modules are staff-only too
  // (D-044) and build on storage; storage.ts is still out of reach of every
  // module that makes public output.
  it("no module but the package index and the other staff-only modules imports storage", () => {
    // Any static or dynamic import, with or without an extension, in any folder.
    const here = dirname(fileURLToPath(import.meta.url));
    const mentions = /["'`](?:\.{1,2}\/)+(?:[^"'`]*\/)?storage(?:\.[jt]s)?["'`]/;
    const importers = (readdirSync(here, { recursive: true }) as string[])
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.test\.ts$|\.fixtures\.ts$/.test(f))
      .filter((f) => f !== "storage.ts")
      .filter((f) => mentions.test(readFileSync(join(here, f), "utf8")));
    expect(importers.sort()).toEqual(["condition-checks.ts", "index.ts", "loans.ts"]);
    expect(mentions.test('await import("./storage")')).toBe(true);
    expect(mentions.test('from "../core/storage.js"')).toBe(true);
  });
});
