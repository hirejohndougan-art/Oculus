/**
 * The safe purge of removed files (S-052, D-086): frees the disk space of
 * files removed from their assets, in two steps.
 *
 * **What it guarantees.** A copy is never taken if any database has
 * attached it since this database's removal (every attach sets the copy's
 * time, and the copy must still have the time logged with the removal), or
 * while another database on the folder is running (the lease, below). What
 * it can't guarantee: a physical clone of this database that keeps its
 * identity (a file-level copy of the cluster), run on the folder while the
 * original stays stopped for more than a day, can delete files the clone
 * removed; and a database restored on its own may name files purged after
 * its backup was taken. Restore the files folder from the same backup as
 * the database (D-086).
 *
 * **The lease.** A run first checks the file system keeps exact times
 * (`mtimeSelfTest`, else `mtime_unreliable`), then takes the folder's
 * lease: holding the folder's lease lock (a lock file beside the marker,
 * `withLeaseLock`) and the database's lease lock (advisory class 70), the
 * marker must name this install (`file_store_binding`), the database's
 * current epoch **and this database's identity**: a pg_dump or logical
 * restore has another, and so does this database after a pg_upgrade or a
 * move, so the run is refused (`identity_changed`, writing nothing) until a
 * system manager accepts the identity (`acceptFileStoreIdentity`) or an
 * adopt. An identity read without the cluster's system identifier
 * (`-:<oid>`) tells nothing (every fresh cluster's first database has the
 * same OID): refused (`identity_unknown`). A new epoch is committed here,
 * then put in the marker. Every step after that takes the same two locks, then the
 * organization's file lock (class 69, the one every attach takes), and
 * checks the lease again, and that the run's time (`PURGE_LEASE_MS`, by the
 * process's monotonic clock) isn't up. A start, an hourly renewal or
 * another purge moves the epoch and so ends the run.
 *
 * **Step 1 (to the trash).** Nothing keeps the content (the database's
 * `stored_content_kept`), this database's newest event for it is a removal
 * at least 7 days old by the database's clock (`purgeCandidates`), the copy
 * is at least 7 days old by the file system's own clock, and its time is
 * still exactly the one logged with that removal. Checked again inside the
 * step; then the copy moves into `<organization>/trash/<sha256>/` by one
 * rename, with its thumbnails.
 *
 * **Step 2 (deleted).** At least 24 hours in the trash by both clocks,
 * nothing keeps the content, the removal is still the newest event, and the
 * copy's time unchanged; otherwise put back. A trashed copy that isn't a
 * plain file of ours is **stuck**: never deleted, restored or recorded, and
 * reported. An upload of the content puts a trashed copy back
 * (`attachFile`), and so does a lease found moved (`renewFileLease`).
 *
 * A dry run (`apply: false`) checks without taking the lease and changes
 * nothing. Each step writes its own change-log row (`system_events`) in its
 * own transaction.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { OrganizationId, UserId } from "@oculus/core";
import {
  REMOVED_FILE_GRACE_SECONDS,
  TRASH_GRACE_SECONDS,
  databaseIdentity,
  existingOrganizations,
  identityKnown,
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
import type { FileStore, StoreMarker } from "./file-store.js";

/** How long one run may hold the lease (10 minutes); the rest waits for the next run. */
export const PURGE_LEASE_MS = 10 * 60_000;

/**
 * How often the automatic purge runs, when it is turned on: once a day and
 * an hour, so a step 2 due a day after step 1 is never missed by moments.
 */
export const AUTOMATIC_PURGE_EVERY_MS = 25 * 3600_000;

/** The actor of a run without a person, from the command line. */
export const PURGE_ACTOR = "system:files-purge";
/** The actor of the daily automatic run (`OCULUS_FILES_AUTO_PURGE=on`). */
export const PURGE_TIMER_ACTOR = "system:files-purge-timer";

/** Why a purge was refused. */
export type PurgeProblem =
  /** No files folder is configured. */
  | "no_store"
  /** The folder hasn't been bound to this database (the server binds it at start). */
  | "not_bound"
  /** The folder's marker names another install. */
  | "other_install"
  /** The folder's epoch isn't this database's: another database uses it, or this one was restored. */
  | "lease_mismatch"
  /**
   * The epoch is this database's but the marker names another database's
   * identity: a dump or logical restore of the one that wrote it, or this
   * database after a pg_upgrade (accept the identity) or a dump-and-restore
   * move (adopt).
   */
  | "identity_changed"
  /**
   * This role can't read the cluster's system identifier, so this database
   * can't be told from a restore of it into a fresh cluster: a superuser
   * grants it `EXECUTE` on `pg_catalog.pg_control_system()`.
   */
  | "identity_unknown"
  /** The file system doesn't keep modification times exactly enough to compare copies by them. */
  | "mtime_unreliable";

export interface PurgeOptions {
  /** `false`: a dry run, which changes nothing. */
  readonly apply: boolean;
  /** The system manager who asked (the change log's actor); left out: the command line or the timer. */
  readonly actorId?: UserId;
  /** `timer` for the daily automatic run (the change log says so). */
  readonly via?: "timer";
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
  /**
   * In the trash but not a plain copy of ours (a second hard link, another
   * owner, a writable mode): never deleted, restored or recorded; for a
   * person to look at.
   */
  readonly stuck: PurgeTotals;
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
  // Copies are compared by their exact times: only where times are kept.
  if (!(await files.mtimeSelfTest())) return { ok: false, problem: "mtime_unreliable" };
  const apply = options.apply;
  const timer = options.via === "timer";
  const actor =
    options.actorId !== undefined
      ? `user:${options.actorId}`
      : timer
        ? PURGE_TIMER_ACTOR
        : PURGE_ACTOR;
  const monotonic = options.monotonic ?? (() => performance.now());
  const leaseMs = options.leaseMs ?? PURGE_LEASE_MS;
  const identity = await databaseIdentity(db);
  // Without the cluster's system identifier this database can't be told
  // from a restore into a fresh cluster (both `-:16385`): never.
  if (!identityKnown(identity)) return { ok: false, problem: "identity_unknown" };

  /**
   * Whether the marker is this run's lease: this install, `epoch`, and this
   * database by its identity (a dump or logical restore has another, so a
   * copy whose epoch still matches is refused: review B1a).
   */
  const holds = (marker: StoreMarker | undefined, epoch: string | undefined): boolean =>
    marker?.storeId === bound && marker.epoch === epoch && marker.database === identity;

  // The lease: checked, and for a real run taken (a new epoch), under the
  // folder's lease lock so no other database's renewal comes in between.
  const epoch = randomUUID();
  const taken = await files.withLeaseLock(async () => {
    const answer = await db.transaction(
      async (tx): Promise<PurgeProblem | { since: string | null }> => {
        await lockFileStoreLease(tx);
        if ((await readFileStoreBinding(tx)) !== bound) return "not_bound";
        const marker = await files.readMarker();
        if (marker?.storeId !== bound) return "other_install";
        const lease = await readFileStoreLease(tx);
        if (lease === undefined || marker.epoch !== lease.epoch) return "lease_mismatch";
        // The epoch is ours but the marker names another database: a dump or
        // logical restore of the one that wrote it, or this one after a
        // pg_upgrade. Refused, and nothing is written (a dry run included),
        // until a system manager accepts the identity or an adopt.
        if (!holds(marker, lease.epoch)) return "identity_changed";
        if (apply) await insertFileStoreEpoch(tx, epoch, "purge", identity);
        return { since: lease.since };
      },
    );
    if (apply && typeof answer !== "string") {
      await files.replaceMarker({ storeId: bound, database: identity, epoch });
    }
    return answer;
  });
  if (typeof taken === "string") return { ok: false, problem: taken };
  const deadline = monotonic() + leaseMs;
  const since = taken.since;

  /**
   * One content's step: the folder's lease lock, then the lease lock and
   * the organization's file lock in the database (always in that order),
   * the lease checked again first; the change log's row in the same
   * transaction.
   */
  async function locked<T>(
    organizationId: OrganizationId,
    work: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    return files.withLeaseLock((held) =>
      db.transaction(async (tx) => {
        stillHeld = held;
        await lockFileStoreLease(tx);
        await lockOrganizationFiles(tx, organizationId);
        if (monotonic() >= deadline) throw new LeaseEnded("lease_expired");
        const marker = await files.readMarker();
        const lease = await readFileStoreLease(tx);
        if (!holds(marker, epoch) || lease?.epoch !== epoch) throw new LeaseEnded("lease_lost");
        return work(tx);
      }),
    );
  }

  /** The current step's lease-lock check, read again right before each rename or unlink. */
  let stillHeld: () => Promise<boolean> = () => Promise.resolve(false);
  const lockStillHeld = async (): Promise<void> => {
    if (!(await stillHeld())) throw new LeaseEnded("lease_lost");
  };

  /** One step's row in the change log, in the step's transaction. */
  async function logged(
    tx: Queryable,
    kind: "files_trashed" | "files_deleted" | "files_restored",
    size: number,
  ): Promise<void> {
    await insertSystemEvent(tx, {
      actorId: options.actorId ?? null,
      kind,
      files: 1,
      bytes: size,
      ...(timer && options.actorId === undefined ? { source: "timer" as const } : {}),
    });
  }

  const trashed = new Totals();
  const deleted = new Totals();
  const restored = new Totals();
  const waiting = new Totals();
  const stuck = new Totals();
  let stopped: "lease_expired" | "lease_lost" | undefined;

  const onDisk = await files.organizations();
  const known = await existingOrganizations(db, onDisk);
  const organizations = onDisk.filter((id) => known.has(id));

  try {
    for (const organizationId of organizations) {
      const fsNow = await files.fileSystemNow(organizationId);
      const inTrash = new Map((await files.trashEntries(organizationId)).map((e) => [e.sha256, e]));
      const listed = await trashedContents(db, organizationId);
      const recorded = new Set(listed.map((t) => t.sha256));

      // Stuck in the trash (not a plain copy of ours): never deleted,
      // restored or recorded; reported for a person to look at.
      for (const entry of inTrash.values()) if (entry.stuck) stuck.add(entry.size);

      // Trash this database has no step for (a run stopped between its
      // rename and its commit, or another database's): put back.
      for (const entry of inTrash.values()) {
        if (recorded.has(entry.sha256) || entry.stuck) continue;
        if (!apply) {
          restored.add(entry.size);
          continue;
        }
        const back = await locked(organizationId, async (tx) => {
          const now = await trashedContents(tx, organizationId, [entry.sha256]);
          if (now.length > 0) return "none";
          const answer = await files.restoreFromTrash(organizationId, entry.sha256);
          if (answer !== "none") await logged(tx, "files_restored", entry.size);
          return answer;
        });
        if (back !== "none") restored.add(entry.size);
      }

      // Step 2: what this database put in the trash.
      for (const item of listed) {
        const disk = inTrash.get(item.sha256);
        if (disk?.stuck === true) continue;
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
          // Everything again, inside the locks.
          const [again] = await trashedContents(tx, organizationId, [item.sha256]);
          if (again === undefined) return "skip" as const;
          const entry = (await files.trashEntries(organizationId)).find(
            (e) => e.sha256 === item.sha256,
          );
          if (entry?.stuck === true) return "stuck" as const;
          const step = {
            sha256: item.sha256,
            size: item.size,
            removalId: again.removalId,
            copyMtimeNs: again.copyMtimeNs,
            epoch,
            actor,
          };
          if (entry === undefined) {
            // Gone from the trash: an upload or a moved lease put it back
            // (a copy at its content path), or it was deleted outside Oculus.
            const back = await files.copyStamp(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, {
              ...step,
              kind: back === undefined ? "deleted" : "restored",
            });
            return back === undefined ? ("gone" as const) : ("restored" as const);
          }
          if (!again.stillRemoved || entry.mtimeNs !== again.copyMtimeNs) {
            await files.restoreFromTrash(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, { ...step, kind: "restored" });
            await logged(tx, "files_restored", item.size);
            return "restored" as const;
          }
          const fsNowAgain = await files.fileSystemNow(organizationId);
          if (
            !again.dayOld ||
            !Number.isFinite(entry.markedMs) ||
            fsNowAgain - entry.markedMs < DAY_MS
          ) {
            return "waiting" as const;
          }
          await lockStillHeld();
          const done = await files.deleteTrashed(organizationId, item.sha256, again.copyMtimeNs);
          if (done !== "deleted") {
            await files.restoreFromTrash(organizationId, item.sha256);
            await insertFilePurgeStep(tx, organizationId, { ...step, kind: "restored" });
            await logged(tx, "files_restored", item.size);
            return "restored" as const;
          }
          await insertFilePurgeStep(tx, organizationId, { ...step, kind: "deleted" });
          await logged(tx, "files_deleted", item.size);
          return "deleted" as const;
        });
        if (outcome === "deleted") deleted.add(item.size);
        else if (outcome === "restored") restored.add(item.size);
        else if (outcome === "waiting") waiting.add(item.size);
        else if (outcome === "stuck") stuck.add(item.size);
      }

      // Step 1: removed at least 7 days ago, by both clocks, and unused since.
      for (const candidate of await purgeCandidates(db, organizationId, since)) {
        if (inTrash.has(candidate.sha256)) continue;
        const stamp = await files.copyStamp(organizationId, candidate.sha256);
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
          const now = await files.copyStamp(organizationId, candidate.sha256);
          const fsNowAgain = await files.fileSystemNow(organizationId);
          if (now?.mtimeNs !== again.copyMtimeNs || fsNowAgain - now.mtimeMs < WEEK_MS) {
            return false;
          }
          await lockStillHeld();
          const done = await files.trashContent(
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
          await logged(tx, "files_trashed", candidate.size);
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

  if (!apply) {
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
      stuck: stuck.frozen(),
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
      // Under the folder's lease lock too, so it never runs inside another
      // database's purge step (S-052 third review). Putting back is safe in
      // any case: it never deletes a copy that isn't also at its path.
      const back = await store.withLeaseLock(() =>
        db.transaction(async (tx) => {
          await lockOrganizationFiles(tx, organizationId);
          const answer = await store.restoreFromTrash(organizationId, entry.sha256);
          if (answer !== "none") {
            await insertSystemEvent(tx, {
              actorId: null,
              kind: "files_restored",
              files: 1,
              bytes: entry.size,
              source: "lease",
            });
          }
          return answer;
        }),
      );
      if (back !== "none") restored++;
    }
  }
  return restored;
}
