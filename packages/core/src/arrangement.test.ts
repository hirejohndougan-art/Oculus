import { describe, expect, it } from "vitest";
import {
  ARCHIVAL_LEVELS,
  MAX_ARRANGEMENT_DEPTH,
  canFileUnder,
  newRecordId,
  unfiledUnits,
  validateArrangement,
  type ArchivalLevel,
  type ArchivalUnitRecord,
  type RecordId,
} from "./index.js";

const T = "2026-11-20T16:05:00.000Z";

function unit(
  title: string,
  level: ArchivalLevel,
  parent?: ArchivalUnitRecord,
  id: RecordId = newRecordId(),
): ArchivalUnitRecord {
  return {
    kind: "archival_unit",
    id,
    title,
    level,
    createdAt: T,
    updatedAt: T,
    fields: {},
    ...(parent === undefined ? {} : { parentId: parent.id }),
  };
}

function codes(units: ArchivalUnitRecord[]): string[] {
  return validateArrangement(units).map((i) => i.code);
}

describe("canFileUnder", () => {
  it.each<[ArchivalLevel, ArchivalLevel]>([
    ["series", "fonds"],
    ["collection", "fonds"],
    ["collection", "series"],
    ["item", "collection"],
    ["item", "fonds"],
    ["file", "collection"],
    ["item", "file"],
    ["series", "series"],
    ["file", "file"],
  ])("allows a %s under a %s", (child, parent) => {
    expect(canFileUnder(child, parent)).toBe(true);
  });

  it.each<[ArchivalLevel, ArchivalLevel]>([
    ["fonds", "fonds"],
    ["fonds", "series"],
    ["series", "collection"],
    ["collection", "collection"],
    ["collection", "item"],
    ["item", "item"],
    ["file", "item"],
  ])("refuses a %s under a %s", (child, parent) => {
    expect(canFileUnder(child, parent)).toBe(false);
  });

  it("never lets anything sit under an item", () => {
    for (const level of ARCHIVAL_LEVELS) expect(canFileUnder(level, "item")).toBe(false);
  });
});

describe("validateArrangement", () => {
  it("accepts the Historical Society's arrangement", () => {
    const f1 = unit("Dickinson Historical Society", "fonds");
    const s1 = unit("Photographs", "series", f1);
    const railroad = unit("Historic Railroad Center", "collection", s1);
    const depot = unit("GH&H Depot, 1902–1967", "file", railroad);
    const station = unit("Dickinson Station and Park", "item", depot);
    const cemetery = unit("Dickinson City Cemetery Records", "collection", f1); // no series
    const loose = unit("Gar Rodeo window sign", "item"); // not filed yet
    expect(codes([f1, s1, railroad, depot, station, cemetery, loose])).toEqual([]);
  });

  it("accepts units in any order", () => {
    const f1 = unit("F1", "fonds");
    const s1 = unit("S1", "series", f1);
    const c = unit("C", "collection", s1);
    const i = unit("I", "item", c);
    expect(codes([i, c, s1, f1])).toEqual([]);
  });

  it("accepts sub-series and sub-files", () => {
    const f = unit("F", "fonds");
    const s = unit("S", "series", f);
    const ss = unit("SS", "series", s);
    const file = unit("File", "file", ss);
    const sub = unit("Sub-file", "file", file);
    expect(codes([f, s, ss, file, sub, unit("Item", "item", sub)])).toEqual([]);
  });

  it("reports a parent that doesn't exist", () => {
    const ghost = unit("Ghost", "fonds");
    expect(codes([unit("Orphan", "item", ghost)])).toEqual(["missing_parent"]);
  });

  it("reports a level filed under the wrong level", () => {
    const item = unit("An item", "item");
    const c = unit("Collection", "collection");
    expect(
      codes([item, c, unit("Series", "series", c), unit("Inside an item", "file", item)]),
    ).toEqual(["wrong_level", "wrong_level"]);
  });

  it("reports a unit filed under itself", () => {
    const id = newRecordId();
    const self: ArchivalUnitRecord = { ...unit("Self", "file", undefined, id), parentId: id };
    const issues = validateArrangement([self]);
    expect(issues.map((i) => i.code)).toEqual(["loop"]);
    expect(issues[0]?.message).toContain("inside itself");
  });

  it("reports a loop between units, and units hanging under it", () => {
    const aId = newRecordId();
    const bId = newRecordId();
    const a: ArchivalUnitRecord = { ...unit("A", "file", undefined, aId), parentId: bId };
    const b: ArchivalUnitRecord = { ...unit("B", "file", undefined, bId), parentId: aId };
    const hanger = unit("Hanger", "item", a);
    const issues = validateArrangement([a, b, hanger]);
    expect(issues.map((i) => i.code)).toEqual(["loop", "loop", "loop"]);
    expect(issues[2]?.message).toContain("loop back");
  });

  it("reports duplicate IDs", () => {
    const a = unit("A", "fonds");
    const child = unit("Child", "item", a);
    expect(codes([a, { ...a, title: "A again" }, child])).toEqual([
      "duplicate_id",
      "duplicate_id",
      "ambiguous_parent",
    ]);
  });

  it.each([
    ["deepest first", true],
    ["top first", false],
  ])("reports a chain deeper than the limit (%s)", (_label, reverse) => {
    const chain: ArchivalUnitRecord[] = [unit("Top", "fonds")];
    for (let i = 1; i <= MAX_ARRANGEMENT_DEPTH; i += 1) {
      const parent = chain[chain.length - 1];
      chain.push(unit(`File ${String(i)}`, "file", parent));
    }
    const ordered = reverse ? [...chain].reverse() : chain;
    const issues = validateArrangement(ordered);
    expect(issues.map((i) => i.code)).toEqual(["too_deep"]);
    expect(issues[0]?.path[0]).toBe(chain[chain.length - 1]?.id);
  });

  it("accepts a chain exactly at the limit", () => {
    const chain: ArchivalUnitRecord[] = [unit("Top", "fonds")];
    for (let i = 1; i < MAX_ARRANGEMENT_DEPTH; i += 1) {
      chain.push(unit(`File ${String(i)}`, "file", chain[chain.length - 1]));
    }
    expect(codes(chain)).toEqual([]);
  });

  it("handles a wide tree quickly", () => {
    const f = unit("F", "fonds");
    const units = [
      f,
      ...Array.from({ length: 20_000 }, (_, i) => unit(`Item ${String(i)}`, "item", f)),
    ];
    const started = performance.now();
    expect(codes(units)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("validateArrangement: hostile shapes stay fast", () => {
  function loopOf(n: number): ArchivalUnitRecord[] {
    const ids = Array.from({ length: n }, () => newRecordId());
    return ids.map((id, i) => ({
      ...unit(`S${String(i)}`, "series", undefined, id),
      parentId: ids[(i + 1) % n] ?? id,
    }));
  }

  it("handles a loop of 20,000 units in linear time, with capped issues", () => {
    const started = performance.now();
    const issues = validateArrangement(loopOf(20_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(issues.length).toBeLessThanOrEqual(201);
    expect(issues[0]?.code).toBe("loop");
    expect(issues[issues.length - 1]?.code).toBe("too_many_issues");
  });

  it("handles a long chain hanging under a self-loop quickly", () => {
    const loopId = newRecordId();
    const top: ArchivalUnitRecord = {
      ...unit("Self", "file", undefined, loopId),
      parentId: loopId,
    };
    const chain: ArchivalUnitRecord[] = [top];
    for (let i = 0; i < 20_000; i += 1)
      chain.push(unit(`F${String(i)}`, "file", chain[chain.length - 1]));
    const started = performance.now();
    validateArrangement([...chain].reverse());
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("unfiledUnits", () => {
  it("includes units whose parent isn't in the set, so they aren't lost", () => {
    const lost = unit("Lost", "item", unit("Gone", "fonds"));
    expect(unfiledUnits([lost]).map((u) => u.title)).toEqual(["Lost"]);
  });

  it("lists units with no parent except fonds and collections", () => {
    const f = unit("F", "fonds");
    const c = unit("Standalone collection", "collection");
    const loose = unit("Loose item", "item");
    const looseSeries = unit("Loose series", "series");
    const filed = unit("Filed", "item", f);
    expect(unfiledUnits([f, c, loose, looseSeries, filed]).map((u) => u.title)).toEqual([
      "Loose item",
      "Loose series",
    ]);
  });
});
