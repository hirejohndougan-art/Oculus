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
 * - One organization at a time (D-019, D-0XX): `validateArrangement` and
 *   `unfiledUnits` refuse a set holding units of more than one organization,
 *   or a unit that doesn't say which (`mixed_organizations`).
 */
import type { ArchivalLevel, ArchivalUnitRecord } from "./records.js";
import type { Issue, Validated } from "./issues.js";
import { mixedOrganizationsIssue, oneOrganization } from "./organizations.js";
import { IssueList, shown } from "./plain-data.js";
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
 * Check a whole set of archival units. Reports duplicate IDs, parents that
 * don't exist, levels filed under the wrong level, loops, and trees deeper
 * than MAX_ARRANGEMENT_DEPTH. Units with no parent are fine. Runs in time
 * proportional to the number of units, whatever their shape, and stops after
 * a few hundred problems. Units of more than one organization are refused
 * with the one issue `mixed_organizations`.
 */
export function validateArrangement(units: readonly ArchivalUnitRecord[]): Issue[] {
  if (oneOrganization(units) === "mixed") {
    return [mixedOrganizationsIssue([], "These units")];
  }
  const issues = new IssueList();

  // Units whose ID appears more than once can't be placed reliably: report
  // them, and leave them (and anything filed under them) out of the checks.
  const seenIds = new Set<RecordId>();
  const duplicated = new Set<RecordId>();
  for (const unit of units) {
    if (seenIds.has(unit.id)) duplicated.add(unit.id);
    seenIds.add(unit.id);
  }
  const byId = new Map<RecordId, ArchivalUnitRecord>();
  for (const unit of units) {
    if (duplicated.has(unit.id)) {
      issues.add(
        [unit.id],
        "duplicate_id",
        `${shown(unit.title)} shares its ID with another unit.`,
      );
    } else {
      byId.set(unit.id, unit);
    }
  }

  for (const unit of byId.values()) {
    if (unit.parentId === undefined) continue;
    if (duplicated.has(unit.parentId)) {
      issues.add(
        [unit.id, "parentId"],
        "ambiguous_parent",
        `${shown(unit.title)} is filed under an ID that more than one unit uses.`,
      );
      continue;
    }
    const parent = byId.get(unit.parentId);
    if (parent === undefined) {
      issues.add(
        [unit.id, "parentId"],
        "missing_parent",
        `${shown(unit.title)} is filed under a unit that doesn't exist.`,
      );
    } else if (!canFileUnder(unit.level, parent.level)) {
      issues.add(
        [unit.id, "parentId"],
        "wrong_level",
        `${article(unit.level)} can't be filed under ${article(parent.level)} (${shown(unit.title)} under ${shown(parent.title)}).`,
      );
    }
  }

  // Walk up from each unit to the top. Every unit is settled exactly once:
  // either with its depth, or as "in or under a loop", so the walk is linear.
  const depthOf = new Map<RecordId, number>();
  const looped = new Set<RecordId>();
  for (const unit of byId.values()) {
    const path: ArchivalUnitRecord[] = [];
    const onPath = new Set<RecordId>();
    let current: ArchivalUnitRecord | undefined = unit;
    let loopStart: RecordId | undefined;
    let underLoop = false;
    while (current !== undefined && !depthOf.has(current.id)) {
      if (looped.has(current.id)) {
        underLoop = true;
        break;
      }
      if (onPath.has(current.id)) {
        loopStart = current.id;
        break;
      }
      onPath.add(current.id);
      path.push(current);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }

    if (loopStart !== undefined || underLoop) {
      // The units from loopStart onward form the loop; earlier ones hang under it.
      let inLoop = false;
      for (const step of path) {
        if (step.id === loopStart) inLoop = true;
        looped.add(step.id);
        issues.add(
          [step.id, "parentId"],
          "loop",
          inLoop
            ? `${shown(step.title)} is filed inside itself, through a loop of units.`
            : `${shown(step.title)} is filed under units that loop back on each other.`,
        );
      }
      continue;
    }

    let depth = current === undefined ? 0 : (depthOf.get(current.id) ?? 0);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      depth += 1;
      const step = path[i];
      if (step === undefined) continue;
      depthOf.set(step.id, depth);
      if (depth > MAX_ARRANGEMENT_DEPTH) {
        issues.add(
          [step.id, "parentId"],
          "too_deep",
          `${shown(step.title)} is ${String(depth)} levels deep; the limit is ${String(MAX_ARRANGEMENT_DEPTH)}.`,
        );
      }
    }
  }
  return issues.items;
}

/**
 * Units that need filing, so nothing is lost from view. Lists the top of every
 * branch that isn't attached to a top-level fonds or collection:
 * - units with no parent, other than a top-level fonds or collection
 * - units whose parent isn't in the set
 * - units that share an ID with another unit, or are filed under such an ID
 * - units in a loop (the units hanging under a loop are reached through it)
 *
 * Fails with `mixed_organizations` when the units belong to more than one
 * organization, or any doesn't say which (D-0XX), so another organization's
 * units are never listed. That is why it returns a `Validated` list.
 */
export function unfiledUnits(
  units: readonly ArchivalUnitRecord[],
): Validated<readonly ArchivalUnitRecord[]> {
  if (oneOrganization(units) === "mixed") {
    return { ok: false, issues: [mixedOrganizationsIssue([], "These units")] };
  }
  return { ok: true, value: Object.freeze(unfiled(units)) };
}

function unfiled(units: readonly ArchivalUnitRecord[]): ArchivalUnitRecord[] {
  const count = new Map<RecordId, number>();
  for (const unit of units) count.set(unit.id, (count.get(unit.id) ?? 0) + 1);
  const byId = new Map<RecordId, ArchivalUnitRecord>();
  for (const unit of units) if (count.get(unit.id) === 1) byId.set(unit.id, unit);
  const inLoop = loopMembers(byId);
  return units.filter((unit) => {
    if (count.get(unit.id) !== 1) return true;
    if (inLoop.has(unit.id)) return true;
    if (unit.parentId === undefined) return unit.level !== "fonds" && unit.level !== "collection";
    return !byId.has(unit.parentId);
  });
}

/** The units that are part of a loop of parents (not the ones hanging under it). */
function loopMembers(byId: ReadonlyMap<RecordId, ArchivalUnitRecord>): Set<RecordId> {
  const members = new Set<RecordId>();
  const done = new Set<RecordId>();
  for (const start of byId.values()) {
    const path: RecordId[] = [];
    const index = new Map<RecordId, number>();
    let current: ArchivalUnitRecord | undefined = start;
    while (current !== undefined && !done.has(current.id)) {
      const seenAt = index.get(current.id);
      if (seenAt !== undefined) {
        for (const id of path.slice(seenAt)) members.add(id);
        break;
      }
      index.set(current.id, path.length);
      path.push(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    for (const id of path) done.add(id);
  }
  return members;
}

function article(level: ArchivalLevel): string {
  return `${level === "item" ? "An" : "A"} ${level}`;
}
