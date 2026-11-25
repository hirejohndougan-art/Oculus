/**
 * The safe purge of removed files (S-052, D-086): frees the disk space of
 * files removed from their assets, in two steps, and never a copy that is
 * still in use in this database or any other that shares the folder.
 *
 * **The lease.** A run first takes the folder's lease: under the lease lock
 * (advisory class 70) the marker in the folder must name this install (the
 * ID in `file_store_binding`) and the database's current epoch; a new epoch
 * is committed here, then put in the marker. Every step after that runs in
 * a transaction that takes the lease lock and the organization's file lock
 * (class 69, the one every attach takes) and checks again that the marker
 * and the database both still hold this run's epoch, and that the run's
 * time (`PURGE_LEASE_MS`, by the process's monotonic clock) isn't up. A
 * start, an hourly renewal or another purge of this database moves the
 * epoch and so ends the run; another install's folder, or a restored or
 * cloned database whose epoch no longer matches the marker, can't take the
 * lease at all.
 *
 * **Step 1 (to the trash).** A content is a candidate only when no row
 * names it, this database's newest event for it is a removal at least 7
 * days old by the database's clock (`purgeCandidates`), the copy on disk is
 * at least 7 days old by the file system's own clock (a probe file's time,
 * never the server's), and **its time is still exactly the one logged with
 * that removal**. Every attach in any database sets the copy's time to now
 * (`touch`), so a copy that a restored or cloned database still names, or
 * attached again since, is never taken, whatever this database believes
 * (the fifth review's RV1 and RV2). Inside the transaction the database's
 * side is checked again, then the copy is moved into
 * `<organization>/trash/<sha256>/` by one rename, with its thumbnails.
 *
 * **Step 2 (deleted).** A later run deletes a trashed copy only when it has
 * been in the trash for 24 hours by both clocks (the step's row, and the
 * trash folder's `marked` file), no row names the content, the removal is
 * still this database's newest event for it, and the copy's time hasn't
 * changed. Otherwise the copy is put back. An upload of the content puts it
 * back too (`attachFile`, under the file lock), and so does a lease found
 * moved by another database (`renewFileLease`).
 *
 * A dry run (`apply: false`) checks the lease without taking it and says
 * what a run would do; it changes nothing in the database or the folder.
 * Every run that changed something is written to the change log
 * (`system_events`: one row per kind, with counts and bytes).
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { OrganizationId, UserId } from "@oculus/core";
import {
  REMOVED_FILE_GRACE_SECONDS,
  TRASH_GRACE_SECONDS,
  databaseIdentity,
  existingOrganizations,
  insertFilePurgeStep,
  insertFileStoreEpoch,
  insertSystemEvent,
  lockFileStoreLease,
  lockOrganizationFiles,
  purgeCandidates,
  readFileStoreBinding,
  readFileStoreLease,
  trashedContents,
  type Database,
  type Queryable,
} from "@oculus/db";
import type { FileStore } from "./file-store.js";

/** How long one run may hold the lease (10 minutes); the rest waits for the next run. */
export const PURGE_LEASE_MS = 10 * 60_000;

/** How often the automatic purge runs, when it is turned on (once a day). */
export const AUTOMATIC_PURGE_EVERY_MS = 24 * 3600_000;

/** The actor of a run without a person (the command line, the automatic run). */
export const PURGE_ACTOR = "system:files-purge";

/** Why a purge was refused. */
export type PurgeProblem =
  /** No files folder is configured. */
  | "no_store"
  /** The folder hasn't been bound to this database (the server binds it at start). */
  | "not_bound"
  /** The folder's marker names another install. */
  | "other_install"
  /** The folder's epoch isn't this database's: another database uses it, or this one was restored. */
  | "lease_mismatch";

export interface PurgeOptions {
  /** `false`: a dry run, which changes nothing. */
  readonly apply: boolean;
  /** The system manager who asked (the change log's actor); left out: the command line or the timer. */
  readonly actorId?: UserId;
  /** How long the run may hold the lease (default `PURGE_LEASE_MS`). */
  readonly leaseMs?: number;
  /** The monotonic clock the lease's time is counted on (tests). Default: `performance.now`. */
  readonly monotonic?: () => number;
  /** Called before each content's step (tests: a concurrent upload, a lease lost). */
  readonly beforeContent?: (
    step: "trash" | "delete",
    organizationId: OrganizationId,
    sha256: string,
  ) => Promise<void>;
}

export interface PurgeTotals {
  readonly files: number;
  readonly bytes: number;
}

export interface PurgeReport {
  readonly dryRun: boolean;
  /** Moved to the trash by this run (a dry run: would be). */
  readonly trashed: PurgeTotals;
  /** Deleted from the trash by this run (a dry run: would be). */
  readonly deleted: PurgeTotals;
  /** Put back from the trash: in use again, changed, or left by an interrupted run. */
  readonly restored: PurgeTotals;
  /** In the trash after this run, waiting for their day before a later run deletes them. */
  readonly waiting: PurgeTotals;
  /** Why the run stopped early, if it did: its time ran out, or the lease moved. */
  readonly stopped?: "lease_expired" | "lease_lost";
}

export type PurgeResult =
  | { readonly ok: true; readonly value: PurgeReport }
  | { readonly ok: false; readonly problem: PurgeProblem };

const DAY_MS = TRASH_GRACE_SECONDS * 1000;
const WEEK_MS = REMOVED_FILE_GRACE_SECONDS * 1000;

class Totals {
  files = 0;
  bytes = 0;
  add(bytes: number): void {
    this.files++;
    this.bytes += bytes;
  }
  frozen(): PurgeTotals {
    return Object.freeze({ files: this.files, bytes: this.bytes });
  }
}

/** Stops a run whose lease is gone. */
class LeaseEnded extends Error {
  constructor(readonly why: "lease_expired" | "lease_lost") {
    super(why);
  }
}

/** The purge over every organization of this database that has a folder in the store. */
export async function runFilePurge(
  db: Database,
  store: FileStore | undefined,
  options: PurgeOptions,
): Promise<PurgeResult> {
  if (store === undefined) return { ok: false, problem: "no_store" };
  const files: FileStore = store;
  const binding = await readFileStoreBinding(db);
  // The install ID this database holds; a store the server bound must agree.
  const bound = binding;
  if (bound === undefined) return { ok: false, problem: "not_bound" };
  const storeBound = files.boundTo();
  if (storeBound !== undefined && storeBound !== bound) return { ok: false, problem: "not_bound" };
  const apply = options.apply;
  const actor = options.actorId === undefined ? PURGE_ACTOR : `user:${options.actorId}`;
  const monotonic = options.monotonic ?? (() => performance.now());
  const leaseMs = options.leaseMs ?? PURGE_LEASE_MS;
  const identity = await databaseIdentity(db);

  // The lease: checked, and for a real run taken (a new epoch).
  const epoch = randomUUID();
  const taken = await db.transaction(
    async (tx): Promise<PurgeProblem | { since: string | null }> => {
      await lockFileStoreLease(tx);
      if ((await readFileStoreBinding(tx)) !== bound) return "not_bound";
      const marker = await files.readMarker().catch(() => undefined);
      if (marker?.storeId !== bound) return "other_install";
      const lease = await readFileStoreLease(tx);
      if (lease === undefined || marker.epoch !== lease.epoch) return "lease_mismatch";
      if (apply) await insertFileStoreEpoch(tx, epoch, "purge", identity);
      return { since: lease.since };
    },
  );
  if (typeof taken === "string") return { ok: false, problem: taken };
  const deadline = monotonic() + leaseMs;
  if (apply) await files.replaceMarker({ storeId: bound, database: identity, epoch });
  const since = taken.since;

  /**
   * One content's step under the lease lock and the organization's file
   * lock, with the lease checked again first.
   */
  async function locked<T>(
    organizationId: OrganizationId,
    work: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await lockFileStoreLease(tx);
      await lockOrganizationFiles(tx, organizationId);
      if (monotonic() >= deadline) throw new LeaseEnded("lease_expired");
      const marker = await files.readMarker().catch(() => undefined);
      const lease = await readFileStoreLease(tx);
      if (marker === undefined || marker.storeId !== bound || marker.epoch !== epoch) {
        throw new LeaseEnded("lease_lost");
      }
      if (lease?.epoch !== epoch) throw new LeaseEnded("lease_lost");
      return work(tx);
    });
  }

  const trashed = new Totals();
  const deleted = new Totals();
  const restored = new Totals();
  const waiting = new Totals();
  let stopped: "lease_expired" | "lease_lost" | undefined;

  const onDisk = await store.organizations();
  const known = await existingOrganizations(db, onDisk);
  const organizations = onDisk.filter((id) => known.has(id));

  try {
    for (const organizationId of organizations) {
      const fsNow = await store.fileSystemNow(organizationId);
      const inTrash = new Map((await store.trashEntries(organizationId)).map((e) => [e.sha256, e]));
      const listed = await trashedContents(db, organizationId);
      const recorded = new Set(listed.map((t) => t.sha256));

      // Trash this database has no step for (a run stopped between its
      // rename and its commit, or another database's): put back.
      for (const entry of inTrash.values()) {
        if (recorded.has(entry.sha256)) continue;
        if (!apply) {
          restored.add(entry.size);
          continue;
        }
        const back = await locked(organizationId, async (tx) => {
          const now = await trashedContents(tx, organizationId, [entry.sha256]);
          if (now.length > 0) return "none";
          return store.restoreFromTrash(organizationId, entry.sha256);
        });
        if (back !== "none") restored.add(entry.size);
      }

      // Step 2: what this database put in the trash.
      for (const item of listed) {
        const disk = inTrash.get(item.sha256);
        const ready =
          disk !== undefined &&
          item.stillRemoved &&
          disk.mtimeNs === item.copyMtimeNs &&
          item.dayOld &&
          Number.isFinite(disk.markedMs) &&
          fsNow - disk.markedMs >= DAY_MS;
        const putBack =
          disk === undefined || !item.stillRemoved || disk.mtimeNs !== item.copyMtimeNs;
        if (!apply) {
          if (ready) deleted.add(item.size);
          else if (putBack) restored.add(item.size);
          else waiting.add(item.size);
          continue;
        }
        await options.beforeContent?.("delete", organizationId, item.sha256);
        const outcome = await locked(organizationId, async (tx) => {
          // Everything again, inside the lock.
          const [again] = await trashedContents(tx, organizationId, [item.sha256]);
          if (again === undefined) return "skip" as const;
          const entry = (await store.trashEntries(organizationId)).find(
            (e) => e.sha256 === item.sha256,
          );
          const step = {
            sha256: item.sha256,
            size: item.size,
            removalId: again.removalId,
            copyMtimeNs: again.copyMtimeNs,
            epoch,
            actor,
          };
          if (entry === undefined) {
            // Gone from the trash: an upload put it back, or it was deleted.
            const back = await store.copyStamp(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, {
              ...step,
              kind: back === undefined ? "deleted" : "restored",
            });
            return back === undefined ? ("gone" as const) : ("restored" as const);
          }
          if (!again.stillRemoved || entry.mtimeNs !== again.copyMtimeNs) {
            await store.restoreFromTrash(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, { ...step, kind: "restored" });
            return "restored" as const;
          }
          const fsNowAgain = await store.fileSystemNow(organizationId);
          if (
            !again.dayOld ||
            !Number.isFinite(entry.markedMs) ||
            fsNowAgain - entry.markedMs < DAY_MS
          ) {
            return "waiting" as const;
          }
          const done = await store.deleteTrashed(organizationId, item.sha256, again.copyMtimeNs);
          if (done !== "deleted") {
            await store.restoreFromTrash(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, { ...step, kind: "restored" });
            return "restored" as const;
          }
          await insertFilePurgeStep(tx, organizationId, { ...step, kind: "deleted" });
          return "deleted" as const;
        });
        if (outcome === "deleted") deleted.add(item.size);
        else if (outcome === "restored") restored.add(item.size);
        else if (outcome === "waiting") waiting.add(item.size);
      }

      // Step 1: removed at least 7 days ago, by both clocks, and unused since.
      for (const candidate of await purgeCandidates(db, organizationId, since)) {
        if (inTrash.has(candidate.sha256)) continue;
        const stamp = await store.copyStamp(organizationId, candidate.sha256);
        // Kept: no plain copy, a copy used since the removal, or one used
        // within the week by the file system's own clock.
        if (stamp?.mtimeNs !== candidate.copyMtimeNs || fsNow - stamp.mtimeMs < WEEK_MS) {
          continue;
        }
        if (!apply) {
          trashed.add(candidate.size);
          continue;
        }
        await options.beforeContent?.("trash", organizationId, candidate.sha256);
        const moved = await locked(organizationId, async (tx) => {
          const [again] = await purgeCandidates(tx, organizationId, since, [candidate.sha256]);
          if (again?.removalId !== candidate.removalId) return false;
          const now = await store.copyStamp(organizationId, candidate.sha256);
          const fsNowAgain = await store.fileSystemNow(organizationId);
          if (now?.mtimeNs !== again.copyMtimeNs || fsNowAgain - now.mtimeMs < WEEK_MS) {
            return false;
          }
          const done = await store.trashContent(
            organizationId,
            candidate.sha256,
            again.copyMtimeNs,
          );
          if (done !== "trashed") return false;
          await insertFilePurgeStep(tx, organizationId, {
            kind: "trashed",
            sha256: candidate.sha256,
            size: candidate.size,
            removalId: again.removalId,
            copyMtimeNs: again.copyMtimeNs,
            epoch,
            actor,
          });
          return true;
        });
        if (moved) {
          trashed.add(candidate.size);
          waiting.add(candidate.size);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof LeaseEnded)) throw error;
    stopped = error.why;
  }

  if (apply) {
    const changes = [
      ["files_trashed", trashed],
      ["files_deleted", deleted],
      ["files_restored", restored],
    ] as const;
    if (changes.some(([, t]) => t.files > 0)) {
      await db.transaction(async (tx) => {
        for (const [kind, totals] of changes) {
          if (totals.files === 0) continue;
          await insertSystemEvent(tx, {
            actorId: options.actorId ?? null,
            kind,
            files: totals.files,
            bytes: totals.bytes,
          });
        }
      });
    }
  } else {
    // A dry run: what would be in the trash afterwards.
    waiting.files += trashed.files;
    waiting.bytes += trashed.bytes;
  }
  return {
    ok: true,
    value: Object.freeze({
      dryRun: !apply,
      trashed: trashed.frozen(),
      deleted: deleted.frozen(),
      restored: restored.frozen(),
      waiting: waiting.frozen(),
      ...(stopped === undefined ? {} : { stopped }),
    }),
  };
}

/**
 * Puts back everything in the trash of this database's organizations (the
 * lease found moved by another database: neither side may purge, so
 * nothing stays out of place). Each under the organization's file lock.
 */
export async function restoreAllTrash(db: Database, store: FileStore): Promise<number> {
  const onDisk = await store.organizations();
  const known = await existingOrganizations(db, onDisk);
  let restored = 0;
  for (const organizationId of onDisk.filter((id) => known.has(id))) {
    for (const entry of await store.trashEntries(organizationId)) {
      const back = await db.transaction(async (tx) => {
        await lockOrganizationFiles(tx, organizationId);
        return store.restoreFromTrash(organizationId, entry.sha256);
      });
      if (back !== "none") restored++;
    }
  }
  return restored;
}
