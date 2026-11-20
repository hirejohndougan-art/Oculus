/**
 * Archival arrangement rules (decision D-007).
 *
 * Levels from the top down: fonds › series › collection › file › item.
 *
 * - A unit is filed under a unit at a higher level. Levels can be skipped:
 *   a collection can sit directly in a fonds with no series, and an item can
 *   sit directly in a collection. So series and collections stay independent.
 * - A series can hold sub-series and a file can hold sub-files, so the tree
 *   can be as deep as an archive needs.
 * - A unit with no parent is either a top-level fonds or collection, or a unit
 *   that hasn't been filed yet (the "Needs Sorting" list). Neither is an error.
 * - Items hold nothing.
 */
import type { ArchivalLevel, ArchivalUnitRecord } from "./records.js";
import { issue, type Issue } from "./issues.js";
import type { RecordId } from "./record-id.js";

/** How far down the tree each level sits. Lower numbers are higher up. */
export const LEVEL_RANK: Readonly<Record<ArchivalLevel, number>> = {
  fonds: 0,
  series: 1,
  collection: 2,
  file: 3,
  item: 4,
};

/** Levels that may contain more of their own level (sub-series, sub-files). */
const SELF_NESTING: ReadonlySet<ArchivalLevel> = new Set<ArchivalLevel>(["series", "file"]);

/** The deepest a tree may go, to stop runaway nesting. */
export const MAX_ARRANGEMENT_DEPTH = 64;

/** True if a unit at `child` level may be filed directly under one at `parent` level. */
export function canFileUnder(child: ArchivalLevel, parent: ArchivalLevel): boolean {
  if (child === parent) return SELF_NESTING.has(child);
  return LEVEL_RANK[child] > LEVEL_RANK[parent];
}

/**
 * Check a whole set of archival units. Reports parents that don't exist,
 * levels filed under the wrong level, loops, and trees deeper than
 * MAX_ARRANGEMENT_DEPTH. Units with no parent are fine.
 */
export function validateArrangement(units: readonly ArchivalUnitRecord[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<RecordId, ArchivalUnitRecord>();
  for (const unit of units) {
    if (byId.has(unit.id)) {
      issues.push(issue([unit.id], "duplicate_id", `Two units share the ID ${unit.id}.`));
    }
    byId.set(unit.id, unit);
  }

  for (const unit of units) {
    if (unit.parentId === undefined) continue;
    const parent = byId.get(unit.parentId);
    if (parent === undefined) {
      issues.push(
        issue(
          [unit.id, "parentId"],
          "missing_parent",
          `"${unit.title}" is filed under a unit that doesn't exist.`,
        ),
      );
    } else if (!canFileUnder(unit.level, parent.level)) {
      issues.push(
        issue(
          [unit.id, "parentId"],
          "wrong_level",
          `A ${unit.level} can't be filed under a ${parent.level} ("${unit.title}" under "${parent.title}").`,
        ),
      );
    }
  }

  // Walk up from each unit to the top, remembering each unit's depth so every
  // chain is walked once. A unit whose walk comes back around is in a loop
  // (or hangs under one) and gets no depth.
  const depthOf = new Map<RecordId, number>();
  for (const unit of units) {
    const path: ArchivalUnitRecord[] = [];
    const seen = new Set<RecordId>();
    let current: ArchivalUnitRecord | undefined = unit;
    let loopAt: RecordId | undefined;
    while (current !== undefined && !depthOf.has(current.id)) {
      if (seen.has(current.id)) {
        loopAt = current.id;
        break;
      }
      seen.add(current.id);
      path.push(current);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    if (loopAt !== undefined) {
      issues.push(
        issue(
          [unit.id, "parentId"],
          "loop",
          loopAt === unit.id
            ? `"${unit.title}" is filed inside itself.`
            : `"${unit.title}" is filed under units that loop back on each other.`,
        ),
      );
      continue;
    }
    let depth = current === undefined ? 0 : (depthOf.get(current.id) ?? 0);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      depth += 1;
      const step = path[i];
      if (step !== undefined) depthOf.set(step.id, depth);
    }
    if (depth > MAX_ARRANGEMENT_DEPTH) {
      issues.push(
        issue(
          [unit.id, "parentId"],
          "too_deep",
          `"${unit.title}" is ${String(depth)} levels deep; the limit is ${String(MAX_ARRANGEMENT_DEPTH)}.`,
        ),
      );
    }
  }
  return issues;
}

/** Units that haven't been filed yet: no parent, and not a top-level fonds or collection. */
export function unfiledUnits(units: readonly ArchivalUnitRecord[]): ArchivalUnitRecord[] {
  return units.filter(
    (unit) => unit.parentId === undefined && unit.level !== "fonds" && unit.level !== "collection",
  );
}
