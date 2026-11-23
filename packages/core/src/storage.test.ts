import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORAGE_LEVELS,
  awayFromNormal,
  checkLocationDeletion,
  createStorageMove,
  departures,
  indexLocations,
  indexMoves,
  isIsoDay,
  isLocationId,
  isLocationIndex,
  isMoveLog,
  locationChildren,
  locationContents,
  locationLabel,
  locationPath,
  moveHistory,
  newLocationId,
  newMoveId,
  newOrganizationId,
  newRecordId,
  overdueReturns,
  reindexLocations,
  storageLocation,
  validateStorageLevels,
  validateStorageLocation,
  validateStorageMove,
  whereabouts,
  withMove,
  type LocationIndex,
  type MoveLog,
  type StorageLocation,
  type StorageMove,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const LEVELS = { organizationId: ORG, levels: [...DEFAULT_STORAGE_LEVELS] };

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

/** The clock for adding moves: an hour after the fixture moves were written down. */
const NOW = new Date("2026-11-23T18:00:00.000Z");

function addMove(log: MoveLog, m: unknown): Validated<MoveLog> {
  return withMove(log, m, NOW);
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function loc(
  name: string,
  level: number | undefined,
  extra: Partial<StorageLocation> = {},
): StorageLocation {
  return {
    id: newLocationId(),
    organizationId: ORG,
    kind: "storage",
    name,
    ...(level === undefined ? {} : { level }),
    ...extra,
  };
}

// Archive room › Shelf A › Box 001 › Folder 1; Shelf B; Map room › Flat file 1 (skips Shelf);
// Exhibit hall › Case 2 (display); a conservator (outside).
const room = loc("Archive room", 0);
const shelfA = loc("Shelf A", 1, { parentId: room.id });
const shelfB = loc("Shelf B", 1, { parentId: room.id });
const box1 = loc("Box 001", 2, { parentId: shelfA.id, container: true });
const folder1 = loc("Folder 1", 3, { parentId: box1.id, container: true });
const mapRoom = loc("Map room", 0);
const flatFile = loc("Flat file 1", 2, { parentId: mapRoom.id, container: true });
const hall = loc("Exhibit hall", 0, { kind: "display" });
const case2 = loc("Case 2", 1, { kind: "display", parentId: hall.id });
const conservator = {
  id: newLocationId(),
  organizationId: ORG,
  kind: "external",
  name: "Paper conservator",
  agentId: newRecordId(),
} as StorageLocation;
const ALL = [room, shelfA, shelfB, box1, folder1, mapRoom, flatFile, hall, case2, conservator];

function index(list: readonly unknown[] = ALL): LocationIndex {
  return ok(indexLocations(LEVELS, list));
}

const T0 = "2026-11-23T16:05:00.000Z";
let tick = 0;
function move(
  recordId: string,
  locationId: string,
  movedOn: string,
  reason: StorageMove["reason"],
  extra: Partial<StorageMove> = {},
): StorageMove {
  tick += 1;
  return {
    id: newMoveId(),
    organizationId: ORG,
    recordId,
    locationId,
    movedOn,
    reason,
    recordedAt: new Date(Date.parse(T0) + tick * 1000).toISOString(),
    ...extra,
  } as StorageMove;
}

describe("storage levels", () => {
  it("accepts the default levels and an organization's own", () => {
    expect(ok(validateStorageLevels(LEVELS)).levels).toEqual(["Room", "Shelf", "Box", "Folder"]);
    expect(ok(validateStorageLevels({ organizationId: ORG, levels: ["Building"] })).levels).toEqual(
      ["Building"],
    );
  });

  it("refuses empty, duplicate, untrimmed, multi-line and too many levels", () => {
    expect(codes(validateStorageLevels({ organizationId: ORG, levels: [] }))).toEqual(["required"]);
    expect(codes(validateStorageLevels({ organizationId: ORG, levels: ["Box", "box"] }))).toEqual([
      "duplicate_level",
    ]);
    expect(codes(validateStorageLevels({ organizationId: ORG, levels: [" Box"] }))).toEqual([
      "untrimmed",
    ]);
    expect(codes(validateStorageLevels({ organizationId: ORG, levels: ["A\tB"] }))).toEqual([
      "control_characters",
    ]);
    expect(
      codes(validateStorageLevels({ organizationId: ORG, levels: "123456789".split("") })),
    ).toEqual(["too_many"]);
    expect(codes(validateStorageLevels({ organizationId: ORG, levels: [""] }))).toEqual([
      "required",
    ]);
  });

  it("requires an organization", () => {
    expect(codes(validateStorageLevels({ levels: ["Room"] }))).toEqual(["invalid_organization"]);
  });
});

describe("validateStorageLocation", () => {
  it("accepts storage, display and outside locations", () => {
    for (const l of ALL) expect(ok(validateStorageLocation(l))).toEqual(l);
    expect(isLocationId(room.id)).toBe(true);
  });

  it("returns a frozen copy, not the caller's object", () => {
    const given = { ...room };
    const copy = ok(validateStorageLocation(given));
    expect(copy).not.toBe(given);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it("needs a level inside and refuses one outside", () => {
    expect(codes(validateStorageLocation({ ...room, level: undefined }))).toContain(
      "undefined_value",
    );
    const noLevel = Object.fromEntries(Object.entries(room).filter(([k]) => k !== "level"));
    expect(codes(validateStorageLocation(noLevel))).toEqual(["invalid_level"]);
    expect(codes(validateStorageLocation({ ...room, level: 1.5 }))).toEqual(["invalid_level"]);
    expect(codes(validateStorageLocation({ ...room, level: -1 }))).toEqual(["invalid_level"]);
    expect(codes(validateStorageLocation({ ...conservator, level: 0 }))).toEqual([
      "external_level",
    ]);
    expect(codes(validateStorageLocation({ ...conservator, parentId: room.id }))).toEqual([
      "external_parent",
    ]);
    expect(codes(validateStorageLocation({ ...conservator, container: true }))).toEqual([
      "external_container",
    ]);
    expect(codes(validateStorageLocation({ ...room, agentId: newRecordId() }))).toEqual([
      "agent_not_external",
    ]);
  });

  it("refuses a room and an outside place with the same name, both listed at the top", () => {
    expect(
      codes(
        indexLocations(LEVELS, [
          room,
          { ...conservator, id: newLocationId(), name: "archive ROOM" },
        ]),
      ),
    ).toEqual(["duplicate_name"]);
  });

  it("refuses the path separator in a name (review fix)", () => {
    expect(codes(validateStorageLocation({ ...room, name: "Room 2 › Shelf C" }))).toEqual([
      "separator_in_name",
    ]);
  });

  it("refuses a location sitting in itself, bad IDs, kinds and notes", () => {
    expect(codes(validateStorageLocation({ ...room, parentId: room.id }))).toEqual([
      "self_reference",
    ]);
    expect(codes(validateStorageLocation({ ...room, id: "BOX-1" }))).toEqual(["invalid_id"]);
    expect(codes(validateStorageLocation({ ...room, kind: "attic" }))).toEqual(["invalid_kind"]);
    expect(codes(validateStorageLocation({ ...room, container: false }))).toEqual([
      "invalid_container",
    ]);
    expect(codes(validateStorageLocation({ ...room, note: "  " }))).toEqual(["invalid_note"]);
    expect(
      ok(validateStorageLocation({ ...room, note: "Key at front desk.\nAsk before opening." }))
        .note,
    ).toContain("\n");
    expect(codes(validateStorageLocation({ ...room, shelfMark: "x" }))).toEqual([
      "unknown_property",
    ]);
  });
});

describe("indexLocations", () => {
  it("indexes a tree and labels paths", () => {
    const idx = index();
    expect(isLocationIndex(idx)).toBe(true);
    expect(idx.size).toBe(ALL.length);
    expect(idx.levels).toEqual(["Room", "Shelf", "Box", "Folder"]);
    expect(locationLabel(idx, folder1.id)).toBe("Archive room › Shelf A › Box 001 › Folder 1");
    expect(locationLabel(idx, flatFile.id)).toBe("Map room › Flat file 1");
    expect(locationLabel(idx, conservator.id)).toBe("Paper conservator");
    expect(locationPath(idx, box1.id)?.map((l) => l.name)).toEqual([
      "Archive room",
      "Shelf A",
      "Box 001",
    ]);
    expect(storageLocation(idx, shelfB.id)).toEqual(shelfB);
    expect(locationPath(idx, newLocationId())).toBeUndefined();
    expect(locationLabel(idx, "nope")).toBeUndefined();
  });

  it("lists children by name, numbers in order", () => {
    const box2 = loc("Box 2", 2, { parentId: shelfA.id });
    const box10 = loc("Box 10", 2, { parentId: shelfA.id });
    const idx = index([...ALL, box10, box2]);
    expect(locationChildren(idx, shelfA.id).map((l) => l.name)).toEqual([
      "Box 001",
      "Box 2",
      "Box 10",
    ]);
    expect(locationChildren(idx, undefined).map((l) => l.name)).toEqual([
      "Archive room",
      "Exhibit hall",
      "Map room",
      "Paper conservator",
    ]);
  });

  it("refuses unknown parents, wrong level order, unnamed levels and outside parents", () => {
    expect(codes(indexLocations(LEVELS, [loc("Shelf", 1, { parentId: newLocationId() })]))).toEqual(
      ["unknown_parent"],
    );
    expect(codes(indexLocations(LEVELS, [room, loc("Room 2", 0, { parentId: room.id })]))).toEqual([
      "level_order",
    ]);
    expect(codes(indexLocations(LEVELS, [shelfA, loc("Up", 0, { parentId: shelfA.id })]))).toEqual([
      "unknown_parent",
      "level_order",
    ]);
    expect(
      codes(indexLocations({ organizationId: ORG, levels: ["Room"] }, [room, shelfA])),
    ).toEqual(["unknown_level"]);
    const inside = {
      ...loc("Drawer", 1),
      parentId: conservator.id,
    };
    expect(codes(indexLocations(LEVELS, [conservator, inside]))).toEqual(["external_parent"]);
  });

  it("refuses duplicate IDs and sibling names, but allows the same name elsewhere", () => {
    expect(codes(indexLocations(LEVELS, [room, room]))).toEqual(["duplicate_id"]);
    expect(
      codes(indexLocations(LEVELS, [room, shelfA, loc("shelf a", 1, { parentId: room.id })])),
    ).toEqual(["duplicate_name"]);
    const otherBox = loc("Box 001", 2, { parentId: shelfB.id });
    expect(index([...ALL, otherBox]).size).toBe(ALL.length + 1);
  });

  it("reports the levels' problems under levels", () => {
    const r = indexLocations({ organizationId: ORG, levels: [] }, []);
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual([["levels", "levels"]]);
  });

  it("follows a container when it moves to another shelf", () => {
    const moved = { ...box1, parentId: shelfB.id };
    const idx = index(ALL.map((l) => (l.id === box1.id ? moved : l)));
    expect(locationLabel(idx, folder1.id)).toBe("Archive room › Shelf B › Box 001 › Folder 1");
  });
});

describe("moves", () => {
  it("validates a move and makes one with createStorageMove", () => {
    const m = move(newRecordId(), box1.id, "2026-11-20", "placement");
    expect(ok(validateStorageMove(m))).toEqual(m);
    const made = ok(
      createStorageMove(
        {
          organizationId: ORG,
          recordId: m.recordId,
          locationId: case2.id,
          movedOn: "2026-11-20",
          reason: "exhibition",
          expectedReturnOn: "2027-03-01",
        },
        new Date(T0),
      ),
    );
    expect(made.recordedAt).toBe(T0);
    expect(made.id).not.toBe(m.id);
    expect(codes(createStorageMove({ ...m }, new Date(Number.NaN)))).toEqual(["invalid_time"]);
  });

  it("checks dates, reasons and expected return dates", () => {
    const r = newRecordId();
    expect(codes(validateStorageMove(move(r, box1.id, "2026-02-30", "placement")))).toEqual([
      "invalid_date",
    ]);
    expect(codes(validateStorageMove(move(r, box1.id, "2026-11-20", "lost" as never)))).toEqual([
      "invalid_reason",
    ]);
    expect(
      codes(
        validateStorageMove(
          move(r, box1.id, "2026-11-20", "rehousing", { expectedReturnOn: "2027-01-01" }),
        ),
      ),
    ).toEqual(["unexpected_return_date"]);
    expect(
      codes(
        validateStorageMove(
          move(r, case2.id, "2026-11-20", "exhibition", { expectedReturnOn: "2026-11-19" }),
        ),
      ),
    ).toEqual(["return_before_move"]);
    expect(
      ok(
        validateStorageMove(
          move(r, case2.id, "2026-11-20", "exhibition", { expectedReturnOn: "2026-11-20" }),
        ),
      ).expectedReturnOn,
    ).toBe("2026-11-20");
  });

  it("allows a back-dated move and a day of time-zone slack, but not a later one", () => {
    const r = newRecordId();
    expect(ok(validateStorageMove(move(r, box1.id, "1998-04-02", "placement"))).movedOn).toBe(
      "1998-04-02",
    );
    const at = { recordedAt: "2026-11-20T23:30:00.000Z" };
    expect(ok(validateStorageMove(move(r, box1.id, "2026-11-21", "placement", at))).movedOn).toBe(
      "2026-11-21",
    );
    expect(codes(validateStorageMove(move(r, box1.id, "2026-11-22", "placement", at)))).toEqual([
      "future_move",
    ]);
  });

  it("isIsoDay accepts real days only", () => {
    expect(isIsoDay("2024-02-29")).toBe(true);
    expect(isIsoDay("2023-02-29")).toBe(false);
    expect(isIsoDay("0999-01-01")).toBe(false);
    expect(isIsoDay("2026-1-01")).toBe(false);
    expect(isIsoDay(20261120)).toBe(false);
  });
});

describe("whereabouts", () => {
  const print = newRecordId(); // "Dickinson Depot Move" print
  const deed = newRecordId(); // 1849 land transfer
  const tape = newRecordId(); // never placed, only sent out
  const idx = index();
  const moves = [
    move(print, box1.id, "2026-01-05", "placement"),
    move(print, case2.id, "2026-09-01", "exhibition", { expectedReturnOn: "2027-02-01" }),
    move(deed, folder1.id, "2025-06-10", "placement"),
    move(deed, conservator.id, "2026-08-01", "conservation", { expectedReturnOn: "2026-10-31" }),
    move(tape, conservator.id, "2026-10-01", "digitization", { expectedReturnOn: "2026-11-01" }),
  ];
  const log: MoveLog = ok(indexMoves(idx, moves));

  it("works out current and normal location from the log", () => {
    expect(isMoveLog(log)).toBe(true);
    expect(log.size).toBe(5);
    expect(log.records).toBe(3);
    const w = ok(whereabouts(log, print));
    expect(w?.currentLabel).toBe("Exhibit hall › Case 2");
    expect(w?.normalLabel).toBe("Archive room › Shelf A › Box 001");
    expect(w?.away).toBe(true);
    expect(w?.since).toBe("2026-09-01");
    expect(w?.reason).toBe("exhibition");
    expect(w?.expectedReturnOn).toBe("2027-02-01");
    expect(ok(whereabouts(log, newRecordId()))).toBeNull();
  });

  it("an item never placed is away while its latest move is temporary (review fix)", () => {
    const w = ok(whereabouts(log, tape));
    expect(w?.normal).toBeNull();
    expect(w?.away).toBe(true);
    expect(w?.expectedReturnOn).toBe("2026-11-01");
    // Its first placement gives it a home but doesn't end the digitization's
    // due date: only a return does (review fix).
    const placed = ok(addMove(log, move(tape, box1.id, "2026-11-22", "placement")));
    expect(ok(whereabouts(placed, tape))?.away).toBe(true);
    expect(ok(whereabouts(placed, tape))?.expectedReturnOn).toBe("2026-11-01");
    const home = ok(withMove(placed, move(tape, box1.id, "2026-11-22", "return"), NOW));
    expect(ok(whereabouts(home, tape))?.away).toBe(false);
    const parked = ok(indexMoves(idx, [move(tape, shelfB.id, "2026-11-20", "correction")]));
    expect(ok(whereabouts(parked, tape))?.away).toBe(false);
  });

  it("lists items away, soonest due first, and the overdue ones", () => {
    expect(ok(awayFromNormal(log)).map((w) => w.recordId)).toEqual([deed, tape, print]);
    expect(ok(overdueReturns(log, "2026-11-23")).map((w) => w.recordId)).toEqual([deed, tape]);
    expect(ok(overdueReturns(log, "2026-10-31"))).toEqual([]);
    expect(ok(overdueReturns(log, "2027-02-02")).map((w) => w.recordId)).toEqual([
      deed,
      tape,
      print,
    ]);
    expect(codes(overdueReturns(log, "today"))).toEqual(["invalid_date"]);
  });

  it("a return brings it home and clears the expected date", () => {
    const back = ok(addMove(log, move(deed, folder1.id, "2026-11-22", "return")));
    const w = ok(whereabouts(back, deed));
    expect(w?.away).toBe(false);
    expect(w?.expectedReturnOn).toBeNull();
    expect(ok(overdueReturns(back, "2026-11-23")).map((w2) => w2.recordId)).toEqual([tape]);
    expect(back.size).toBe(6);
    // The old log is unchanged.
    expect(ok(overdueReturns(log, "2026-11-23")).map((w2) => w2.recordId)).toEqual([deed, tape]);
  });

  it("rehousing changes the normal location", () => {
    const back = ok(addMove(log, move(print, box1.id, "2026-11-21", "return")));
    const next = ok(addMove(back, move(print, shelfB.id, "2026-11-22", "rehousing")));
    const w = ok(whereabouts(next, print));
    expect(w?.normalLabel).toBe("Archive room › Shelf B");
    expect(w?.away).toBe(false);
  });

  it("a correction records where it is without changing home", () => {
    const next = ok(addMove(log, move(deed, box1.id, "2026-11-22", "correction")));
    const w = ok(whereabouts(next, deed));
    expect(w?.currentLabel).toBe("Archive room › Shelf A › Box 001");
    expect(w?.normalLabel).toBe("Archive room › Shelf A › Box 001 › Folder 1");
    expect(w?.away).toBe(true);
  });

  it("a later move with no date keeps the due date, so it stays overdue (review fix)", () => {
    const next = ok(addMove(log, move(deed, shelfB.id, "2026-11-22", "correction")));
    expect(ok(whereabouts(next, deed))?.expectedReturnOn).toBe("2026-10-31");
    expect(ok(overdueReturns(next, "2026-11-23")).map((w) => w.recordId)).toContain(deed);
    const other = ok(addMove(log, move(deed, case2.id, "2026-11-22", "other")));
    expect(ok(whereabouts(other, deed))?.expectedReturnOn).toBe("2026-10-31");
    // A later dated move that isn't an extension keeps the earlier date (review fix).
    const later = ok(
      addMove(
        log,
        move(deed, case2.id, "2026-11-22", "exhibition", { expectedReturnOn: "2027-01-05" }),
      ),
    );
    expect(ok(whereabouts(later, deed))?.expectedReturnOn).toBe("2026-10-31");
  });

  it("only an extension moves an outstanding due date; any other dated move keeps the earliest (review fix)", () => {
    const lent = newRecordId();
    const borrower = {
      id: newLocationId(),
      organizationId: ORG,
      kind: "external",
      name: "Borrowing museum",
      agentId: newRecordId(),
    } as StorageLocation;
    const idx2 = index([...ALL, borrower]);
    const out = [
      move(lent, box1.id, "2026-01-05", "placement"),
      move(lent, borrower.id, "2026-09-01", "loan_out", { expectedReturnOn: "2026-11-15" }),
    ];
    const l2 = ok(indexMoves(idx2, out));
    const late = (l: MoveLog): string[] =>
      ok(overdueReturns(l, "2026-11-20")).map((w) => w.recordId);
    expect(late(l2)).toEqual([lent]);
    // A research move to an in-house shelf, conservation at another vendor, or
    // a loan_out to another place, each dated 2099, can't push it off the list.
    for (const hiding of [
      move(lent, shelfB.id, "2026-11-01", "research", { expectedReturnOn: "2099-12-31" }),
      move(lent, conservator.id, "2026-11-01", "conservation", { expectedReturnOn: "2099-12-31" }),
      move(lent, conservator.id, "2026-11-01", "loan_out", { expectedReturnOn: "2099-12-31" }),
      move(lent, borrower.id, "2026-11-01", "exhibition", { expectedReturnOn: "2099-12-31" }),
    ]) {
      const next = ok(addMove(l2, hiding));
      expect(ok(whereabouts(next, lent))?.expectedReturnOn).toBe("2026-11-15");
      expect(late(next)).toEqual([lent]);
      // An earlier date from such a move counts: the earliest stays.
      const sooner = ok(
        addMove(l2, { ...hiding, id: newMoveId(), expectedReturnOn: "2026-11-05" }),
      );
      expect(ok(whereabouts(sooner, lent))?.expectedReturnOn).toBe("2026-11-05");
    }
    // The normal extension: another loan_out to the same borrower with a new date.
    const extended = ok(
      addMove(
        l2,
        move(lent, borrower.id, "2026-11-10", "loan_out", { expectedReturnOn: "2027-01-31" }),
      ),
    );
    expect(ok(whereabouts(extended, lent))?.expectedReturnOn).toBe("2027-01-31");
    expect(late(extended)).toEqual([]);
    // An extension may also shorten it, and a return still ends it.
    const shortened = ok(
      addMove(
        extended,
        move(lent, borrower.id, "2026-11-12", "loan_out", { expectedReturnOn: "2026-11-18" }),
      ),
    );
    expect(late(shortened)).toEqual([lent]);
    const back = ok(addMove(shortened, move(lent, box1.id, "2026-11-19", "return")));
    expect(late(back)).toEqual([]);
    // Once back, a new trip sets its own date.
    const again = ok(
      addMove(
        back,
        move(lent, shelfB.id, "2026-11-19", "research", { expectedReturnOn: "2099-12-31" }),
      ),
    );
    expect(ok(whereabouts(again, lent))?.expectedReturnOn).toBe("2099-12-31");
  });

  it("ordinary history: placed, digitized with a date, returned, rehoused", () => {
    const r = newRecordId();
    const l2 = ok(
      indexMoves(idx, [
        move(r, box1.id, "2026-01-05", "placement"),
        move(r, conservator.id, "2026-03-01", "digitization", { expectedReturnOn: "2026-04-01" }),
        move(r, box1.id, "2026-03-20", "return"),
        move(r, shelfB.id, "2026-05-01", "rehousing"),
      ]),
    );
    const w = ok(whereabouts(l2, r));
    expect(w?.away).toBe(false);
    expect(w?.expectedReturnOn).toBeNull();
    expect(w?.normal?.id).toBe(shelfB.id);
  });

  it("a correction or new home while out doesn't clear the due date; a return does (review fix)", () => {
    // The deed is out at the conservator, due 2026-10-31, overdue on 2026-11-23.
    const hidings = [
      move(deed, folder1.id, "2026-11-22", "correction"),
      move(deed, shelfB.id, "2026-11-22", "placement"),
      move(deed, shelfB.id, "2026-11-22", "rehousing"),
      move(deed, folder1.id, "2026-11-22", "other"),
    ];
    for (const hiding of hidings) {
      const next = ok(addMove(log, hiding));
      const w = ok(whereabouts(next, deed));
      expect(w?.away).toBe(true);
      expect(w?.expectedReturnOn).toBe("2026-10-31");
      expect(ok(overdueReturns(next, "2026-11-23")).map((x) => x.recordId)).toContain(deed);
    }
    // And with it still outstanding, it can't depart either.
    const lender = {
      id: newLocationId(),
      organizationId: ORG,
      kind: "external",
      name: "Lender",
    } as StorageLocation;
    const found = [...moves, move(deed, folder1.id, "2026-11-22", "correction")];
    expect(
      codes(
        indexMoves(index([...ALL, lender]), [
          ...found,
          move(deed, lender.id, "2026-11-23", "departure"),
        ]),
      ),
    ).toEqual(["departure_while_away"]);
    // A return to the normal location in force (the new home, after a placement) ends it.
    const rehoused = ok(addMove(log, move(deed, shelfB.id, "2026-11-22", "placement")));
    const back = ok(addMove(rehoused, move(deed, shelfB.id, "2026-11-23", "return")));
    expect(ok(whereabouts(back, deed))?.away).toBe(false);
    expect(ok(overdueReturns(back, "2026-11-24")).map((x) => x.recordId)).not.toContain(deed);
  });

  it("keeps the history oldest first, ordering same-day moves by when they were written", () => {
    const history = ok(moveHistory(log, print));
    expect(history.map((m) => m.reason)).toEqual(["placement", "exhibition"]);
    const a = move(tape, box1.id, "2026-11-22", "placement", {
      recordedAt: "2026-11-22T10:00:00.000Z",
    });
    const b = move(tape, conservator.id, "2026-11-22", "digitization", {
      recordedAt: "2026-11-22T09:00:00.000Z",
    });
    const l2 = ok(indexMoves(idx, [...moves, a, b]));
    expect(ok(moveHistory(l2, tape)).map((m) => m.id)).toEqual([moves[4]?.id, b.id, a.id]);
    expect(ok(whereabouts(l2, tape))?.current.id).toBe(box1.id);
    expect(ok(moveHistory(log, newRecordId()))).toEqual([]);
  });

  it("checks a back-dated move in its place in the history", () => {
    // Placed in Box 001 on 2026-01-05; a return dated before that has no home to go to.
    expect(codes(addMove(log, move(print, box1.id, "2025-12-01", "return")))).toEqual([
      "not_normal_location",
    ]);
  });

  it("refuses a return that doesn't go home, and a home outside", () => {
    expect(codes(addMove(log, move(print, shelfB.id, "2026-11-22", "return")))).toEqual([
      "not_normal_location",
    ]);
    const unplaced = addMove(log, move(tape, box1.id, "2026-11-22", "return"));
    expect(codes(unplaced)).toEqual(["not_normal_location"]);
    // The message sends staff the way that works: a placement, then a return.
    expect(unplaced.ok ? "" : unplaced.issues[0]?.message).toMatch(/placement.*then a return/);
    expect(codes(addMove(log, move(tape, conservator.id, "2026-11-22", "placement")))).toEqual([
      "external_normal_location",
    ]);
  });

  it("refuses unknown locations and duplicate move IDs", () => {
    expect(codes(addMove(log, move(print, newLocationId(), "2026-11-22", "other")))).toEqual([
      "unknown_location",
    ]);
    expect(codes(addMove(log, moves[0]))).toEqual(["duplicate_id"]);
    expect(codes(indexMoves(idx, [moves[0], moves[0]]))).toEqual(["duplicate_id"]);
    expect(codes(indexMoves(idx, [move(print, newLocationId(), "2026-11-22", "other")]))).toEqual([
      "unknown_location",
    ]);
  });

  it("lists a box's contents, and everything within it", () => {
    const l2 = ok(addMove(log, move(tape, folder1.id, "2026-11-22", "placement")));
    expect(ok(locationContents(l2, folder1.id))).toEqual([tape]);
    expect(ok(locationContents(l2, box1.id))).toEqual([]);
    expect(ok(locationContents(l2, room.id, { within: true }))).toEqual([tape]);
    expect(ok(locationContents(l2, conservator.id))).toEqual([deed]);
    expect(codes(locationContents(l2, newLocationId()))).toEqual(["unknown_location"]);
  });

  it("never deletes a location with children or history", () => {
    expect(codes(checkLocationDeletion(log, shelfA.id))).toEqual(["has_children"]);
    expect(codes(checkLocationDeletion(log, folder1.id))).toEqual(["in_history"]);
    expect(ok(checkLocationDeletion(log, shelfB.id))).toBe(true);
    expect(codes(checkLocationDeletion(log, newLocationId()))).toEqual(["unknown_location"]);
  });

  it("refuses a log whose location was removed from the index", () => {
    const smaller = index(ALL.filter((l) => l.id !== case2.id));
    expect(codes(indexMoves(smaller, moves))).toEqual(["unknown_location"]);
  });

  it("checks location and level edits against the history before saving (review fix)", () => {
    const moved = ALL.map((l) => (l.id === box1.id ? { ...box1, parentId: shelfB.id } : l));
    const next = ok(reindexLocations(log, LEVELS, moved));
    expect(next.index.size).toBe(ALL.length);
    expect(ok(whereabouts(next.log, print))?.normalLabel).toBe("Archive room › Shelf B › Box 001");
    expect(next.log.size).toBe(log.size);
    // A used location deleted, or a level still in use removed.
    const deleted = reindexLocations(
      log,
      LEVELS,
      ALL.filter((l) => l.id !== case2.id),
    );
    expect(codes(deleted)).toEqual(["unknown_location"]);
    expect(deleted.ok ? [] : deleted.issues[0]?.path).toEqual([moves[1]?.id, "locationId"]);
    expect(
      codes(reindexLocations(log, { organizationId: ORG, levels: ["Room", "Shelf", "Box"] }, ALL)),
    ).toEqual(["unknown_level"]);
    expect(codes(reindexLocations({ ...log }, LEVELS, ALL))).toEqual(["not_a_move_log"]);
  });

  it("refuses turning a normal location into an outside one", () => {
    const shelfBMoves = [move(print, shelfB.id, "2026-11-01", "placement")];
    const l2 = ok(indexMoves(idx, shelfBMoves));
    const changed = ALL.map((l) =>
      l.id === shelfB.id
        ? { id: shelfB.id, organizationId: ORG, kind: "external", name: "Shelf B" }
        : l,
    );
    expect(codes(reindexLocations(l2, LEVELS, changed))).toEqual(["external_normal_location"]);
  });
});

describe("departure (D-044)", () => {
  const idx = index();
  const borrowed = newRecordId();
  const lender = {
    id: newLocationId(),
    organizationId: ORG,
    kind: "external",
    name: "Lending museum",
    agentId: newRecordId(),
  } as StorageLocation;
  const withLender = index([...ALL, lender]);

  it("a departed record has no normal location and is not away", () => {
    const log = ok(
      indexMoves(withLender, [
        move(borrowed, box1.id, "2026-10-01", "placement"),
        move(borrowed, lender.id, "2026-11-10", "departure"),
      ]),
    );
    const w = ok(whereabouts(log, borrowed));
    expect(w?.current.id).toBe(lender.id);
    expect(w?.normal).toBeNull();
    expect(w?.away).toBe(false);
    expect(w?.expectedReturnOn).toBeNull();
    expect(ok(awayFromNormal(log))).toEqual([]);
    expect(ok(locationContents(log, box1.id))).toEqual([]);
  });

  it("goes to an outside location only, takes no return date, and ends the normal location", () => {
    expect(
      codes(
        indexMoves(idx, [
          move(borrowed, box1.id, "2026-10-01", "placement"),
          move(borrowed, shelfB.id, "2026-11-10", "departure"),
        ]),
      ),
    ).toEqual(["departure_not_external"]);
    expect(
      codes(
        validateStorageMove(
          move(borrowed, lender.id, "2026-11-10", "departure", { expectedReturnOn: "2026-12-01" }),
        ),
      ),
    ).toEqual(["unexpected_return_date"]);
    expect(
      codes(
        indexMoves(withLender, [
          move(borrowed, box1.id, "2026-10-01", "placement"),
          move(borrowed, lender.id, "2026-11-10", "departure"),
          move(borrowed, box1.id, "2026-11-12", "return"),
        ]),
      ),
    ).toEqual(["not_normal_location"]);
  });

  it("a later placement brings a borrowed-again record back into care", () => {
    const log = ok(
      indexMoves(withLender, [
        move(borrowed, box1.id, "2026-10-01", "placement"),
        move(borrowed, lender.id, "2026-11-10", "departure"),
        move(borrowed, shelfB.id, "2026-11-20", "placement"),
      ]),
    );
    expect(ok(whereabouts(log, borrowed))?.normal?.id).toBe(shelfB.id);
  });

  it("can't hide an overdue loan out by departing (review fix)", () => {
    const lent = newRecordId();
    const moves = [
      move(lent, box1.id, "2026-01-01", "placement"),
      move(lent, conservator.id, "2026-02-01", "loan_out", { expectedReturnOn: "2026-03-01" }),
    ];
    const before = ok(indexMoves(withLender, moves));
    expect(ok(overdueReturns(before, "2026-11-20")).map((w) => w.recordId)).toEqual([lent]);
    const vanish = move(lent, lender.id, "2026-11-20", "departure");
    expect(codes(indexMoves(withLender, [...moves, vanish]))).toEqual(["departure_while_away"]);
    expect(codes(addMove(before, vanish))).toEqual(["departure_while_away"]);
  });

  it("refuses a departure back-dated before an outstanding loan out (review fix)", () => {
    const lent = newRecordId();
    const moves = [
      move(lent, box1.id, "2026-01-01", "placement"),
      move(lent, conservator.id, "2026-02-01", "loan_out", { expectedReturnOn: "2026-03-01" }),
    ];
    const before = ok(indexMoves(withLender, moves));
    // Dated between the placement (home) and the loan out: it would wipe the
    // normal location while the record is out, and refuse the real return.
    const backDated = move(lent, lender.id, "2026-01-15", "departure");
    expect(codes(addMove(before, backDated))).toEqual(["move_after_departure"]);
    expect(codes(indexMoves(withLender, [...moves, backDated]))).toEqual(["move_after_departure"]);
    expect(ok(overdueReturns(before, "2026-11-20")).map((w) => w.recordId)).toEqual([lent]);
    const back = ok(addMove(before, move(lent, box1.id, "2026-11-20", "return")));
    expect(ok(whereabouts(back, lent))?.away).toBe(false);
  });

  it("only a placement may follow a departure (review fix)", () => {
    const r = newRecordId();
    const gone = [
      move(r, box1.id, "2026-10-01", "placement"),
      move(r, lender.id, "2026-11-10", "departure"),
    ];
    const log = ok(indexMoves(withLender, gone));
    for (const reason of ["correction", "rehousing", "exhibition", "loan_out", "other"] as const) {
      expect(codes(addMove(log, move(r, shelfB.id, "2026-11-12", reason)))).toEqual([
        "move_after_departure",
      ]);
    }
    expect(ok(addMove(log, move(r, shelfB.id, "2026-11-12", "placement"))).size).toBe(3);
  });

  it("a correction to another outside location puts right a departure to the wrong place", () => {
    const r = newRecordId();
    const gone = [
      move(r, box1.id, "2026-10-01", "placement"),
      move(r, conservator.id, "2026-11-10", "departure"),
    ];
    const log = ok(indexMoves(withLender, gone));
    const fixed = ok(addMove(log, move(r, lender.id, "2026-11-12", "correction")));
    const w = ok(whereabouts(fixed, r));
    expect(w?.current.id).toBe(lender.id);
    expect(w?.normal).toBeNull();
    expect(w?.away).toBe(false);
    expect(ok(awayFromNormal(fixed))).toEqual([]);
    // Still departed: only a placement (or another such correction) may follow.
    expect(codes(addMove(fixed, move(r, box1.id, "2026-11-13", "return")))).toEqual([
      "not_normal_location",
    ]);
    expect(codes(addMove(fixed, move(r, box1.id, "2026-11-13", "rehousing")))).toEqual([
      "move_after_departure",
    ]);
    expect(codes(addMove(fixed, move(r, lender.id, "2026-11-13", "departure")))).toEqual([
      "departure_while_away",
    ]);
    expect(ok(addMove(fixed, move(r, conservator.id, "2026-11-13", "correction"))).size).toBe(4);
    expect(ok(addMove(fixed, move(r, shelfB.id, "2026-11-20", "placement"))).size).toBe(4);
    // Not to a location inside: that would say a departed record is here.
    expect(codes(addMove(log, move(r, shelfB.id, "2026-11-12", "correction")))).toEqual([
      "move_after_departure",
    ]);
  });

  it("a departure back-dated before a correction outside is refused", () => {
    const r = newRecordId();
    // Found at the conservator in an audit (away from home, no date).
    const found = [
      move(r, box1.id, "2026-10-01", "placement"),
      move(r, conservator.id, "2026-11-12", "correction"),
    ];
    const log = ok(indexMoves(withLender, found));
    expect(ok(awayFromNormal(log)).map((w) => w.recordId)).toEqual([r]);
    // Written down later, dated before the correction.
    const backDated = move(r, lender.id, "2026-11-05", "departure");
    expect(codes(addMove(log, backDated))).toEqual(["move_after_departure"]);
  });

  it("departs only from inside the organization, while home (review fix)", () => {
    const r = newRecordId();
    // Never placed anywhere: never in the organization's care.
    expect(codes(indexMoves(withLender, [move(r, lender.id, "2026-11-10", "departure")]))).toEqual([
      "departure_while_away",
    ]);
    // In a display case away from its normal location.
    expect(
      codes(
        indexMoves(withLender, [
          move(r, box1.id, "2026-10-01", "placement"),
          move(r, case2.id, "2026-10-05", "exhibition"),
          move(r, lender.id, "2026-11-10", "departure"),
        ]),
      ),
    ).toEqual(["departure_while_away"]);
    // Departed twice.
    expect(
      codes(
        indexMoves(withLender, [
          move(r, box1.id, "2026-10-01", "placement"),
          move(r, lender.id, "2026-11-10", "departure"),
          move(r, lender.id, "2026-11-11", "departure"),
        ]),
      ),
    ).toEqual(["departure_while_away"]);
    // Back home after the exhibition, it may go.
    const fine = ok(
      indexMoves(withLender, [
        move(r, box1.id, "2026-10-01", "placement"),
        move(r, case2.id, "2026-10-05", "exhibition", { expectedReturnOn: "2026-10-30" }),
        move(r, box1.id, "2026-10-29", "return"),
        move(r, lender.id, "2026-11-10", "departure"),
      ]),
    );
    expect(ok(departures(fine)).map((m) => m.recordId)).toEqual([r]);
    expect(codes(departures({ ...fine }))).toEqual(["not_a_move_log"]);
  });
});
