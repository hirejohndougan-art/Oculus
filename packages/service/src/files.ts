/**
 * Files attached to digital assets (M-002, D-086): the service's side.
 *
 * - `mayAttachFile` is asked **before** a byte of the upload is read: the
 *   person may edit the asset (`records.edit`, or `media.attach` for a
 *   Scanner, D-072, the same rule as editing it), it is a digital asset, it
 *   is still at the version they saw (`If-Match`), and the upload's declared
 *   size fits the organization's total. A record that doesn't exist and one
 *   the person can't see are the same `unknown_record`; whether it is an
 *   asset is said only once they can see it.
 * - `attachFile` runs in one transaction after the bytes are received and
 *   checked (`file-store.ts`): the same checks again under the record's
 *   row lock (`FOR SHARE`: the asset can't move, change or be deleted until
 *   COMMIT), then the organization's file lock (`lockOrganizationFiles`),
 *   then the organization's total counting each content once, then the row,
 *   then the copy on disk is placed, last, so a refusal leaves nothing on
 *   disk but what an earlier upload already put there. The media type is
 *   sniffed here from the bytes (core `sniffMediaType`); the client's claim
 *   is kept beside it as a hint. The temporary file is always removed.
 *   The same content attached to the same asset again is the row already
 *   there (`created: false`).
 * - `listFiles` needs `records.view` where the asset is, like reading it.
 * - Reading a file (M-003, D-097): `fileContent` (its bytes, to download,
 *   or to view when the sniffed type is a plain image of a size a browser
 *   can show) and `fileThumbnail` (a JPEG made here, cached on disk) need
 *   the same `records.view`. A file the asset doesn't have (another
 *   asset's, another organization's, a malformed ID) is `unknown_file`,
 *   which the API answers exactly as a missing record. Only the sniffed
 *   type decides anything; the claimed type and the name never do.
 *
 * Attaching a file doesn't change the asset's record or its version: the
 * files are their own rows (0038). `If-Match` only makes sure the person
 * attached to the asset as they last saw it.
 */
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  cleanFileName,
  isClaimedMediaType,
  isRecordId,
  issue,
  sniffMediaType,
  type OrganizationId,
  type Permission,
  type RecordId,
} from "@oculus/core";
import {
  deleteStoredFile,
  existingOrganizations,
  findStoredFile,
  findStoredFileById,
  insertFileStoreBinding,
  insertStoredFileEvent,
  databaseIdentity,
  readFileStoreLease,
  lockFileStoreLease,
  insertFileStoreEpoch,
  type PurgeCandidate,
  readFileStoreBinding,
  insertStoredFile,
  listStoredFiles,
  lockOrganizationFiles,
  organizationFileBytes,
  organizationHasContent,
  storedFileById,
  versionConflict,
  type Database,
  type Queryable,
  type RecordPlace,
  type StoredFile,
} from "@oculus/db";
import { editPermissions, notPermitted, type RecordAccess, type Refusal } from "./access.js";
import type { Runner } from "./admin.js";
import type { FileStore, ReceivedFile, StoreMarker } from "./file-store.js";
import { closeSync } from "node:fs";
import {
  THUMBNAIL_BOXES,
  THUMBNAIL_LIMITS,
  THUMBNAIL_TYPES,
  VIEW_LIMITS,
  VIEW_TYPES,
  THUMBNAIL_HEADER_BYTES,
  THUMBNAIL_SOURCE_MAX_BYTES,
  precheckThumbnail,
  viewDimensions,
  withinLimits,
  type ThumbnailSize,
} from "./thumbnail-worker.js";
import { createThumbnailRenderer, type ThumbnailRenderer } from "./thumbnails.js";
import type { ServiceContext, ServiceRefusal, ServiceResult } from "./service.js";

export interface AttachCheck {
  /** The expected version of the asset (`If-Match`). */
  readonly expectedVersion: number;
  /** The upload's declared size in bytes, when the client said it. */
  readonly declaredBytes?: number;
}

export interface AttachOptions {
  readonly expectedVersion: number;
  /** The file's name as the client gave it (core `cleanFileName` is applied). */
  readonly name: string;
  /** The media type the client claimed, if any: a hint only. */
  readonly claimedType?: string;
}

export interface AttachedFile {
  readonly file: StoredFile;
  /** False when the asset already held this content (nothing new was stored). */
  readonly created: boolean;
}

export interface RemoveFileOptions {
  /** The asset's version (`If-Match`). */
  readonly expectedVersion: number;
}

/** What a sweep removed. */
export interface FileSweep {
  /** Temporary files older than an upload may take (a crash, a stuck upload). */
  readonly incoming: number;
  /**
   * Stored copies no row names any more and not removed within the grace
   * period (removed files, a failed COMMIT).
   */
  readonly contents: number;
  /** Entries at content paths that aren't regular files: left alone, to be looked at. */
  readonly skipped: number;
  /**
   * Copies no row names that this database has no record of at all (another
   * install's, or files attached after this database was copied): kept.
   */
  readonly unknown: number;
  /** Organizations (or the temporary files) whose sweep failed; the others went on. */
  readonly failed: number;
  /** True when the folder isn't bound to this database: nothing was swept. */
  readonly unbound: boolean;
  /**
   * Why a bound store wasn't swept: the marker is gone or names another
   * install (`marker_changed`), or names another database, as after a
   * restore or a copy (`database_changed`).
   */
  readonly halted?: "marker_changed" | "database_changed";
}

/** Why a file is read: to download it (any type), or to show it in the browser. */
export type FileUse = "download" | "view";

export interface FileContent {
  readonly file: StoredFile;
  /** Opens a stream of the stored copy (called only when the reply goes out). */
  readonly open: () => Readable;
}

/** The largest file a thumbnail is made from (100 MiB): the decoder process reads it whole. */
export const MAX_THUMBNAIL_SOURCE_BYTES = THUMBNAIL_SOURCE_MAX_BYTES;

/** How much of a file's start is read to find an image's size before showing it (1 MiB). */
export const VIEW_HEADER_BYTES = 1024 * 1024;

/** The largest GIF shown inline (16 MiB): read whole to find every frame's extent. */
export const VIEW_GIF_BYTES = 16 * 1024 * 1024;

/**
 * Server-side thumbnails are on (T-072, D-097): every decode runs in a
 * child process with a hard memory cap (thumbnails.ts). Turned off,
 * `fileThumbnail` answers `no_thumbnail` for every file and no decoder
 * process is ever started.
 */
export const THUMBNAILS_ENABLED = true;

/** How long a thumbnail that took too long is left before it is tried again (24 hours). */
export const THUMBNAIL_RETRY_MS = 24 * 3600 * 1000;

/** Thumbnails made at once (each holds its file and its decode's memory). */
export const THUMBNAILS_AT_ONCE = 2;

/** Thumbnails an organization may have made (not from the cache) per minute. */
export const THUMBNAILS_PER_MINUTE = 6;

/**
 * Thumbnails one organization may have made in a row while another was
 * turned away for want of a slot (review 2 of T-072: round the
 * organizations), and how long such a turning away counts.
 */
export const THUMBNAILS_IN_A_ROW = 3;
const WAITING_MS = 30_000;

export interface ThumbnailOptions {
  /** Only from the cache (HEAD): `not_cached` when nothing is cached. */
  readonly cacheOnly?: boolean;
}

/** One content the purge would delete. */
export interface PurgeEntry extends PurgeCandidate {
  readonly organizationId: string;
}

/**
 * Why the purge was refused. Only `not_available` for now: purging is off
 * until it can be made safe (D-086, fifth review; S-043).
 */
export type PurgeProblem = "not_available";

/** Why the files folder can't be used with this database (`bindFileStore`). */
export type FileStoreProblem = "no_store" | "other_install" | "marker_missing" | "not_empty";

export interface FileOperations {
  /** Asked before an upload is read; see the module header. */
  mayAttachFile(
    context: ServiceContext,
    recordId: RecordId,
    check: AttachCheck,
  ): Promise<ServiceResult<{ readonly maxFileBytes: number; readonly usedBytes: number }>>;
  /** Attaches received bytes to the asset; always discards the temporary file. */
  attachFile(
    context: ServiceContext,
    recordId: RecordId,
    received: ReceivedFile,
    options: AttachOptions,
  ): Promise<ServiceResult<AttachedFile>>;
  /**
   * Removes one file from an asset: the same rule as attaching (the edit
   * permission where the asset is, `If-Match`). The copy on disk stays:
   * nothing in this version deletes a stored copy (D-086).
   */
  removeFile(
    context: ServiceContext,
    recordId: RecordId,
    fileId: string,
    options: RemoveFileOptions,
  ): Promise<ServiceResult<{ readonly removed: true }>>;
  /**
   * A job, not a person's operation (no context): removes temporary files
   * older than `incomingMaxAgeMs` in this database's organizations, and
   * empties their trash; never a stored copy. Run at startup and on a timer.
   */
  sweepFiles(incomingMaxAgeMs: number): Promise<FileSweep>;
  /**
   * One file's bytes (M-003): to download, for anyone who may view the
   * asset; to view, only a JPEG, PNG, GIF or WebP (sniffed) whose header
   * gives a size within `VIEW_LIMITS` (else `not_viewable`).
   */
  fileContent(
    context: ServiceContext,
    recordId: RecordId,
    fileId: string,
    use: FileUse,
  ): Promise<ServiceResult<FileContent>>;
  /**
   * A thumbnail of one file (M-003): JPEG bytes fitting the size's box,
   * from the cache or made now. `no_thumbnail` for a file it can't or won't
   * be made of (not a JPEG, PNG or GIF, too large, broken, a bomb); `busy`
   * when too many are being made.
   */
  fileThumbnail(
    context: ServiceContext,
    recordId: RecordId,
    fileId: string,
    size: ThumbnailSize,
    options?: ThumbnailOptions,
  ): Promise<ServiceResult<{ readonly jpeg: Uint8Array }>>;
  /**
   * Ties the files folder to this database (review B1): the first time, an
   * empty folder gets a new install ID, in the database and in the folder's
   * marker file; afterwards the two must agree. Refused for a folder with
   * another install's marker, a folder without the marker this database
   * expects, and a folder with anything in it but no marker. Until it
   * succeeds the sweep deletes nothing.
   */
  bindFileStore(): Promise<
    | { readonly ok: true; readonly warning?: "files_shared_or_restored" }
    | { readonly ok: false; readonly problem: FileStoreProblem }
  >;
  /**
   * Moves the folder's lease on (the admin server calls it every hour):
   * `false` when the folder's epoch isn't this database's any more, which
   * also leaves the marker naming an epoch no database holds.
   */
  renewFileLease(): Promise<boolean>;
  /**
   * The operator's purge: not available in this version (D-086, fifth
   * review). A copy of the database whose epoch still matched the marker
   * could purge content production had attached again since, so removed
   * files keep their space until a later version adds a safe purge (S-043).
   * Always refused with `not_available`; nothing is read or changed.
   */
  purgeFiles(options: { readonly apply: boolean; readonly only?: readonly string[] }): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly candidates: readonly PurgeEntry[]; readonly deleted: number };
      }
    | { readonly ok: false; readonly problem: PurgeProblem }
  >;
  /**
   * `npm run files:adopt`: makes this database the folder's own again after
   * a restore or a copy: a new epoch, this database's identity in the
   * marker, and a `since` before which every file event counts as unknown
   * to a later purge. Deletes nothing and enables nothing that deletes.
   * Refused while the marker has changed within `ADOPT_QUIET_MS` (another
   * database still uses the folder).
   */
  adoptFileStore(): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly problem: "no_store" | "marker_missing" | "other_install" | "epoch_moving";
      }
  >;
  /** The asset's files (name, size, sniffed type, who and when). */
  listFiles(
    context: ServiceContext,
    recordId: RecordId,
  ): Promise<ServiceResult<readonly StoredFile[]>>;
}

/** service.ts's `mayChange`: access, the row locked, the place checked. */
export type PlaceCheck = (
  tx: Queryable,
  who: { readonly organizationId: OrganizationId; readonly actor: string },
  recordId: RecordId,
  rowLock: "no_key_update" | "update" | "share",
  all: readonly Permission[],
  any?: (kind: string) => readonly Permission[],
) => Promise<
  { readonly ok: true; readonly place: RecordPlace; readonly checker: RecordAccess } | Refusal
>;

function refusal(path: (string | number)[], code: string, message: string): ServiceRefusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const NO_STORE = refusal(["files"], "files_unavailable", "Files can't be stored on this server.");

/** How often a running server moves the folder's lease on: hourly (D-086). */
export const FILE_LEASE_RENEW_MS = 60 * 60_000;

/**
 * How long the marker must have stood still before `adoptFileStore`: three
 * renewals, so a server still using the folder has surely shown itself.
 */
export const ADOPT_QUIET_MS = 3 * FILE_LEASE_RENEW_MS;

/** A marker, waiting briefly while another server is writing one (its temporary file exists). */
async function markerSettled(store: FileStore): Promise<StoreMarker | undefined> {
  for (let i = 0; i < 30; i++) {
    const marker = await store.readMarker();
    if (marker !== undefined || !(await store.markerInProgress())) return marker;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return store.readMarker();
}

/** `read`'s first defined answer within about three seconds, or `undefined`. */
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < 30; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export function fileOperations(
  db: Database,
  run: Runner,
  mayChange: PlaceCheck,
  store: FileStore | undefined,
  clock: () => Date,
  thumbnails?: ThumbnailRenderer,
  thumbnailLimits: {
    readonly atOnce?: number;
    readonly perMinute?: number;
    readonly inARow?: number;
  } = {},
  thumbnailsEnabled: boolean = THUMBNAILS_ENABLED,
): FileOperations {
  const atOnce = thumbnailLimits.atOnce ?? THUMBNAILS_AT_ONCE;
  const perMinute = thumbnailLimits.perMinute ?? THUMBNAILS_PER_MINUTE;
  let renderer = thumbnails;
  /** Thumbnails being made now, by organization, content and size: asked twice, made once. */
  const making = new Map<string, Promise<ServiceResult<{ readonly jpeg: Uint8Array }>>>();
  /** Thumbnails being made now (all organizations), and the organizations making one. */
  let makingNow = 0;
  const makingFor = new Set<string>();
  /** Organizations turned away for want of a slot, and when; the one served last, and how often. */
  const waiting = new Map<string, number>();
  let streakFor: string | undefined;
  let streak = 0;
  const inARow = thumbnailLimits.inARow ?? THUMBNAILS_IN_A_ROW;
  /** Each organization's thumbnails made in the current minute (a fixed window). */
  const budgets = new Map<string, { minute: number; used: number }>();
  const takeBudget = (organizationId: string): boolean => {
    const minute = Math.floor(clock().getTime() / 60_000);
    const entry = budgets.get(organizationId);
    if (entry?.minute !== minute) {
      if (budgets.size > 10_000) budgets.clear();
      budgets.set(organizationId, { minute, used: 1 });
      return true;
    }
    if (entry.used >= perMinute) return false;
    entry.used++;
    return true;
  };
  const busy = (): ServiceRefusal =>
    refusal(["files"], "busy", "Too many thumbnails are being made. Try again.");

  /** The file as the person may read it: the asset visible to them, the file its own. */
  async function readable(
    context: ServiceContext,
    operation: string,
    recordId: RecordId,
    fileId: string,
  ): Promise<
    ServiceResult<{ readonly file: StoredFile; readonly organizationId: OrganizationId }>
  > {
    return run(operation, context, async (tx, who) => {
      if (!isRecordId(recordId)) {
        return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
      }
      const allowed = await mayChange(tx, who, recordId, "share", []);
      if (!allowed.ok) return allowed;
      const file = await storedFileById(tx, who.organizationId, recordId, fileId);
      if (file === undefined) {
        return refusal(["fileId"], "unknown_file", "The record has no such file.");
      }
      return { ok: true, value: { file, organizationId: who.organizationId } };
    });
  }

  const missingCopy = (): ServiceRefusal =>
    refusal(["files"], "internal_error", "The file's stored copy can't be read.");
  const noThumbnail = (): ServiceRefusal =>
    refusal(["fileId"], "no_thumbnail", "No thumbnail can be made of this file.");
  /**
   * The asset as the person may attach to it, under its row lock: visible,
   * editable by them, a digital asset, at the version they saw.
   */
  async function attachable(
    tx: Queryable,
    who: Parameters<PlaceCheck>[1],
    recordId: RecordId,
    expectedVersion: number,
  ): Promise<ServiceRefusal | undefined> {
    const checked = await placeFor(tx, who, recordId, expectedVersion);
    return checked.ok ? undefined : checked;
  }

  /** `attachable`, answering the place and checker when allowed. */
  async function placeFor(
    tx: Queryable,
    who: Parameters<PlaceCheck>[1],
    recordId: RecordId,
    expectedVersion: number,
  ): Promise<
    | { readonly ok: true; readonly place: RecordPlace; readonly checker: RecordAccess }
    | ServiceRefusal
  > {
    if (!isRecordId(recordId)) {
      return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
    }
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion >= 2 ** 31 - 1
    ) {
      return refusal(["options", "expectedVersion"], "invalid_version", "Not a version number.");
    }
    // The edit rule (records.edit, or media.attach for an asset), checked
    // where the record is, under a FOR SHARE row lock until COMMIT.
    const allowed = await mayChange(tx, who, recordId, "share", [], editPermissions);
    if (!allowed.ok) return allowed;
    if (allowed.place.kind !== "digital_asset") {
      return refusal(["recordId"], "not_an_asset", "Files are attached to digital assets only.");
    }
    if (allowed.place.version !== expectedVersion) {
      const conflict = await versionConflict(tx, who.organizationId, recordId, expectedVersion);
      return {
        ok: false,
        issues: [
          issue(
            ["options", "expectedVersion"],
            "version_conflict",
            `The record was saved by someone else since version ${String(expectedVersion)}; it is now at version ${String(allowed.place.version)}. Read it again.`,
          ),
        ],
        ...(conflict === undefined ? {} : { conflict }),
      };
    }
    return allowed;
  }

  /** The binding row and the first epoch, together. */
  async function firstBinding(storeId: string, epoch: string, identity: string): Promise<string> {
    return db.transaction(async (tx) => {
      await lockFileStoreLease(tx);
      const held = await insertFileStoreBinding(tx, storeId);
      if (held === storeId && (await readFileStoreLease(tx)) === undefined) {
        await insertFileStoreEpoch(tx, epoch, "bind", identity);
      }
      return held;
    });
  }

  /**
   * The lease (D-086, fourth review): if the marker's epoch is this
   * database's current one, a new epoch is committed here and then put in
   * the marker; `true`. Otherwise (another database uses the folder, or
   * this one was restored or copied) nothing here changes, the marker gets
   * an epoch no database holds, so neither side's lease matches until an
   * operator runs `files:adopt`, and `false`. A mismatch is looked at again
   * twice a second apart first: another server of this database may be
   * between its commit and its rename.
   */
  async function renewLease(): Promise<boolean> {
    if (store === undefined) return false;
    const bound = store.boundTo();
    if (bound === undefined) return false;
    const identity = await databaseIdentity(db);
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = randomUUID();
      const renewed = await db.transaction(async (tx) => {
        await lockFileStoreLease(tx);
        const marker = await store.readMarker().catch(() => undefined);
        const lease = await readFileStoreLease(tx);
        if (marker?.storeId !== bound || lease === undefined || marker.epoch !== lease.epoch) {
          return false;
        }
        await insertFileStoreEpoch(tx, epoch, "renew", identity);
        return true;
      });
      if (renewed) {
        await store.replaceMarker({ storeId: bound, database: identity, epoch });
        return true;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const marker = await store.readMarker().catch(() => undefined);
    if (marker?.storeId === bound) {
      await store.replaceMarker({
        storeId: bound,
        database: marker.database ?? identity,
        epoch: randomUUID(),
      });
    }
    return false;
  }

  function diskFull(): ServiceRefusal {
    return refusal(["files"], "disk_full", "The server is running out of disk space for files.");
  }

  function overQuota(): ServiceRefusal {
    return refusal(
      ["files"],
      "quota_exceeded",
      "This organization has used all the space it may use for files.",
    );
  }

  return {
    async mayAttachFile(context, recordId, check) {
      return run("mayAttachFile", context, async (tx, who) => {
        if (store === undefined) return NO_STORE;
        const refused = await attachable(tx, who, recordId, check.expectedVersion);
        if (refused) return refused;
        const declared = check.declaredBytes;
        // A first look without the lock; the upload counts as it streams,
        // and attachFile counts again under the lock.
        const used = await organizationFileBytes(tx, who.organizationId);
        if (declared !== undefined) {
          if (declared > store.maxFileBytes) {
            return refusal(
              ["files"],
              "file_too_large",
              "The file is larger than the server takes.",
            );
          }
          if (used + declared > store.maxOrganizationBytes) return overQuota();
        }
        if (await store.lowOnSpace(declared ?? 0)) return diskFull();
        return {
          ok: true,
          value: Object.freeze({ maxFileBytes: store.maxFileBytes, usedBytes: used }),
        };
      });
    },

    async attachFile(context, recordId, received, options) {
      try {
        // The attach intent, committed on its own before any copy is
        // placed (deny-by-default sweep, third review): if the attach then
        // fails after placing its copy, this database knows it put it there
        // and the sweep may take it after a day; without the intent the
        // copy would be "unknown" and kept for ever.
        const fileId = randomUUID();
        const intent = await run(
          "attachIntent",
          context,
          async (tx, who): Promise<ServiceResult<true>> => {
            if (store === undefined) return NO_STORE;
            if (received.organizationId !== who.organizationId) {
              return refusal(
                ["files"],
                "wrong_organization",
                "The file was received for another organization.",
              );
            }
            const refused = await attachable(tx, who, recordId, options.expectedVersion);
            if (refused) return refused;
            await insertStoredFileEvent(
              tx,
              who.organizationId,
              "placing",
              { id: fileId, recordId, sha256: received.sha256, size: received.size },
              who.actor,
            );
            // A copy already there shows its last use in its own times (by
            // the file system's clock): a later purge relies on it (S-043).
            await store.touch(who.organizationId, received.sha256);
            return { ok: true, value: true };
          },
        );
        if (!intent.ok) return intent;
        return await run(
          "attachFile",
          context,
          async (tx, who): Promise<ServiceResult<AttachedFile>> => {
            if (store === undefined) return NO_STORE;
            if (received.organizationId !== who.organizationId) {
              return refusal(
                ["files"],
                "wrong_organization",
                "The file was received for another organization.",
              );
            }
            const name = cleanFileName(options.name);
            if (name === undefined) {
              return refusal(
                ["name"],
                "invalid_file_name",
                "The file name can't be kept as it is.",
              );
            }
            const claimed =
              options.claimedType === undefined ? null : options.claimedType.toLowerCase();
            if (claimed !== null && !isClaimedMediaType(claimed)) {
              return refusal(["claimedType"], "invalid_media_type", "Not a media type.");
            }
            const refused = await attachable(tx, who, recordId, options.expectedVersion);
            if (refused) return refused;
            await lockOrganizationFiles(tx, who.organizationId);
            const existing = await findStoredFile(
              tx,
              who.organizationId,
              recordId,
              received.sha256,
            );
            if (existing !== undefined) {
              // The copy on disk was placed when that row was made; touched,
              // as every attach touches it.
              await store.touch(who.organizationId, received.sha256);
              return { ok: true, value: Object.freeze({ file: existing, created: false }) };
            }
            if (!(await organizationHasContent(tx, who.organizationId, received.sha256))) {
              const used = await organizationFileBytes(tx, who.organizationId);
              if (used + received.size > store.maxOrganizationBytes) return overQuota();
            }
            const now = clock();
            const file = await insertStoredFile(tx, {
              organizationId: who.organizationId,
              id: fileId,
              recordId,
              sha256: received.sha256,
              size: received.size,
              mediaType: sniffMediaType(received.head),
              claimedType: claimed,
              name,
              createdBy: who.actor,
              createdAt: new Date(Math.floor(now.getTime())),
            });
            await insertStoredFileEvent(tx, who.organizationId, "attached", file, who.actor);
            // Last, still under the file lock: the bytes at their content path.
            await store.place(received);
            await store.touch(who.organizationId, received.sha256);
            return { ok: true, value: Object.freeze({ file, created: true }) };
          },
        );
      } finally {
        await store?.discard(received).catch(() => undefined);
      }
    },

    async removeFile(context, recordId, fileId, options) {
      return run(
        "removeFile",
        context,
        async (tx, who): Promise<ServiceResult<{ readonly removed: true }>> => {
          const allowed = await placeFor(tx, who, recordId, options.expectedVersion);
          if (!allowed.ok) return allowed;
          await lockOrganizationFiles(tx, who.organizationId);
          const file = await findStoredFileById(tx, who.organizationId, recordId, fileId);
          if (file === undefined) {
            return refusal(["fileId"], "unknown_file", "The record has no such file.");
          }
          // records.edit removes any file; a Scanner (media.attach alone)
          // only the files they attached themselves.
          const place = allowed.place;
          const target = await allowed.checker.target({
            kind: place.kind,
            id: recordId,
            parentId: place.parentId,
            represents: place.represents,
            siteId: place.siteId,
          });
          if (!allowed.checker.allows(["records.edit"], target) && file.createdBy !== who.actor) {
            return notPermitted();
          }
          if (!(await deleteStoredFile(tx, who.organizationId, recordId, fileId))) {
            return refusal(["fileId"], "unknown_file", "The record has no such file.");
          }
          // Logged; the log also keeps the bytes for REMOVED_FILE_GRACE_SECONDS.
          await insertStoredFileEvent(tx, who.organizationId, "removed", file, who.actor);
          return { ok: true, value: Object.freeze({ removed: true as const }) };
        },
      );
    },

    async bindFileStore() {
      if (store === undefined) return { ok: false, problem: "no_store" };
      const identity = await databaseIdentity(db);
      let held = await readFileStoreBinding(db);
      let marker = await markerSettled(store);
      if (held === undefined && marker === undefined) {
        // This database has never used a files folder: an empty one gets a
        // new install ID and a first epoch, marker first (so a crash leaves
        // a marker this database can still adopt, below), then the rows.
        if (!(await store.isEmpty())) return { ok: false, problem: "not_empty" };
        const fresh = { storeId: randomUUID(), database: identity, epoch: randomUUID() };
        let wrote = false;
        try {
          await store.writeMarker(fresh);
          wrote = true;
        } catch {
          // Another server of this database (or another install) wrote one
          // first: decided below from what it wrote.
        }
        if (wrote) {
          held = await firstBinding(fresh.storeId, fresh.epoch, identity);
          marker = fresh;
        } else {
          marker = await markerSettled(store);
        }
      }
      if (held === undefined && marker !== undefined) {
        // A marker without this database's row: another server of this
        // database between its two steps, a crash between them (the marker
        // names this database), or another install's folder.
        held = await waitFor(() => readFileStoreBinding(db));
        // Only with a readable system identifier: `-:<oid>` alone could be
        // another cluster's database with the same OID (fifth review).
        if (
          held === undefined &&
          !identity.startsWith("-:") &&
          marker.database === identity &&
          marker.epoch !== undefined
        ) {
          held = await firstBinding(marker.storeId, marker.epoch, identity);
        }
      }
      if (held === undefined) return { ok: false, problem: "other_install" };
      if (marker === undefined) return { ok: false, problem: "marker_missing" };
      if (marker.storeId !== held) return { ok: false, problem: "other_install" };
      store.bind(held);
      // The lease: a new epoch now, if the folder's still matches ours.
      const renewed = await renewLease();
      return renewed ? { ok: true } : { ok: true, warning: "files_shared_or_restored" };
    },

    async renewFileLease() {
      if (store?.boundTo() === undefined) return false;
      return renewLease();
    },

    async sweepFiles(incomingMaxAgeMs) {
      const none: FileSweep = {
        incoming: 0,
        contents: 0,
        skipped: 0,
        unknown: 0,
        failed: 0,
        unbound: false,
      };
      if (store === undefined) return none;
      const bound = store.boundTo();
      if (bound === undefined || bound !== (await readFileStoreBinding(db))) {
        return { ...none, unbound: true };
      }
      // Never a stored copy: only temporary uploads, and the trash a purge
      // left (a purge stopped between moving copies aside and deleting them),
      // in this database's organizations' folders only.
      const onDisk = await store.organizations();
      const known = await existingOrganizations(db, onDisk);
      const ours = onDisk.filter((id) => known.has(id));
      let failed = 0;
      let incoming = 0;
      try {
        incoming = await store.staleIncoming(incomingMaxAgeMs, ours);
      } catch {
        failed++;
      }
      let contents = 0;
      for (const organizationId of ours) {
        try {
          contents += await store.emptyTrash(organizationId);
        } catch {
          failed++;
        }
      }
      return Object.freeze({ incoming, contents, skipped: 0, unknown: 0, failed, unbound: false });
    },

    purgeFiles() {
      // Off until S-043 (see the interface): refused before anything is read.
      return Promise.resolve({ ok: false, problem: "not_available" });
    },

    async adoptFileStore() {
      if (store === undefined) return { ok: false, problem: "no_store" };
      const held = await readFileStoreBinding(db);
      const marker = await store.readMarker().catch(() => undefined);
      if (marker === undefined) return { ok: false, problem: "marker_missing" };
      if (held === undefined || marker.storeId !== held)
        return { ok: false, problem: "other_install" };
      // Another database still moving the epoch: not now.
      const age = await store.markerAge();
      if (age === undefined || age < ADOPT_QUIET_MS) return { ok: false, problem: "epoch_moving" };
      const identity = await databaseIdentity(db);
      const epoch = randomUUID();
      await db.transaction(async (tx) => {
        await lockFileStoreLease(tx);
        await insertFileStoreEpoch(tx, epoch, "adopt", identity);
      });
      await store.replaceMarker({ storeId: held, database: identity, epoch });
      store.bind(held);
      return { ok: true };
    },

    async fileContent(context, recordId, fileId, use) {
      if (store === undefined) return NO_STORE;
      // Checked as data too: a caller in plain JavaScript could send anything.
      if (!(["download", "view"] as unknown[]).includes(use)) {
        return refusal(["use"], "invalid_use", "A file is read to download or to view.");
      }
      const found = await readable(context, "fileContent", recordId, fileId);
      if (!found.ok) return found;
      const { file, organizationId } = found.value;
      if (use === "view") {
        // Only the sniffed type decides (D-086), and the header's size must
        // be one a browser can show without a decompression bomb.
        if (!VIEW_TYPES.has(file.mediaType)) {
          return refusal(["fileId"], "not_viewable", "This file can only be downloaded.");
        }
        // A GIF draws every frame: its whole block structure is walked, so
        // only GIFs up to VIEW_GIF_BYTES are shown.
        const gif = file.mediaType === "image/gif";
        if (gif && file.size > VIEW_GIF_BYTES) {
          return refusal(["fileId"], "not_viewable", "This file can only be downloaded.");
        }
        const head = await store.readContent(
          organizationId,
          file.sha256,
          file.size,
          gif ? VIEW_GIF_BYTES : VIEW_HEADER_BYTES,
        );
        if (head === undefined) return missingCopy();
        if (!withinLimits(viewDimensions(file.mediaType, head), VIEW_LIMITS)) {
          return refusal(["fileId"], "not_viewable", "This file can only be downloaded.");
        }
      }
      const open = await store.openContent(organizationId, file.sha256, file.size);
      if (open === undefined) return missingCopy();
      return { ok: true, value: Object.freeze({ file, open }) };
    },

    async fileThumbnail(context, recordId, fileId, size, options = {}) {
      if (store === undefined) return NO_STORE;
      const box = Object.hasOwn(THUMBNAIL_BOXES, size) ? THUMBNAIL_BOXES[size] : undefined;
      if (box === undefined) {
        return refusal(["size"], "invalid_size", "A thumbnail is small or medium.");
      }
      const found = await readable(context, "fileThumbnail", recordId, fileId);
      if (!found.ok) return found;
      const { file, organizationId } = found.value;
      // Turned off (D-097): every file, after the same checks as any read
      // (so a hidden file is still the same 404), has no thumbnail, and
      // nothing is read, cached or decoded.
      if (!thumbnailsEnabled) return noThumbnail();
      if (!THUMBNAIL_TYPES.has(file.mediaType) || file.size > MAX_THUMBNAIL_SOURCE_BYTES) {
        return noThumbnail();
      }
      // Cached per organization and content: never another organization's.
      // The cache is a help, never a need: trouble with it is a miss.
      const cached = await store
        .readThumbnail(organizationId, file.sha256, size)
        .catch(() => undefined);
      if (cached instanceof Uint8Array) return { ok: true, value: { jpeg: cached } };
      if (cached === "none") return noThumbnail();
      if (cached !== undefined && clock().getTime() - cached.timedOutAt < THUMBNAIL_RETRY_MS) {
        return noThumbnail();
      }
      if (options.cacheOnly === true) {
        return refusal(["fileId"], "not_cached", "No thumbnail is cached for this file.");
      }
      const key = `${organizationId}/${file.sha256}/${size}`;
      const already = making.get(key);
      if (already !== undefined) return already;
      // A slot and the organization's budget before a byte is read (review
      // B3 and item 1): a few at once, a few a minute, then 503 busy.
      // One at a time per organization, so one can't fill every slot (review).
      // And round the organizations (review 2): one that has had
      // THUMBNAILS_IN_A_ROW in a row waits while another was turned away
      // for want of a slot in the last WAITING_MS.
      const now = clock().getTime();
      for (const [org, at] of waiting) if (now - at > WAITING_MS) waiting.delete(org);
      const othersWaiting = [...waiting.keys()].some((org) => org !== organizationId);
      const ownTurnUsed = streakFor === organizationId && streak >= inARow && othersWaiting;
      if (makingFor.has(organizationId)) return busy();
      if (makingNow >= atOnce || ownTurnUsed) {
        if (waiting.size > 10_000) waiting.clear();
        waiting.set(organizationId, now);
        return busy();
      }
      if (!takeBudget(organizationId)) return busy();
      waiting.delete(organizationId);
      if (streakFor === organizationId) {
        streak++;
      } else {
        streakFor = organizationId;
        streak = 1;
      }
      makingNow++;
      makingFor.add(organizationId);
      // Only while the copy is still there: the sweep removes a content's
      // thumbnails when it removes its copy, and never otherwise.
      const remember = async (what: Uint8Array | "none" | "timeout"): Promise<void> => {
        const still = await store.readContent(organizationId, file.sha256, file.size, 0);
        if (still === undefined) return;
        await store.writeThumbnail(organizationId, file.sha256, size, what).catch(() => undefined);
      };
      const made = (async (): Promise<ServiceResult<{ readonly jpeg: Uint8Array }>> => {
        // Only the header is read here (review of T-072, B2: walking a whole
        // file on the server's event loop is a bomb of its own); the
        // decoder process walks, plans and decodes the file itself.
        const head = await store.readContent(
          organizationId,
          file.sha256,
          file.size,
          THUMBNAIL_HEADER_BYTES,
        );
        if (head === undefined) return missingCopy();
        try {
          precheckThumbnail(file.mediaType, head, THUMBNAIL_LIMITS);
        } catch {
          await remember("none");
          return noThumbnail();
        }
        const fd = await store.openContentDescriptor(organizationId, file.sha256, file.size);
        if (fd === undefined) return missingCopy();
        renderer ??= createThumbnailRenderer();
        let result: Awaited<ReturnType<ThumbnailRenderer["render"]>>;
        try {
          result = await renderer.render(file.mediaType, { fd }, box);
        } catch {
          result = { ok: false, code: "failed" };
        } finally {
          // Closed whatever happened (review 2, B1).
          closeSync(fd);
        }
        if (result.ok) {
          await remember(result.jpeg);
          return { ok: true, value: { jpeg: result.jpeg } };
        }
        switch (result.code) {
          case "busy":
            return busy();
          case "refused":
          case "killed":
            // The decoder's own refusal, or a decode killed past the memory
            // cap (T-072): the same every time, so remembered and never
            // tried again.
            await remember("none");
            return noThumbnail();
          case "timeout":
          case "lost":
            // Remembered for a while (THUMBNAIL_RETRY_MS), so it can't keep
            // the decoder busy by being asked for again and again; a kill
            // nothing confirmed as the memory cap is treated so too (review 2).
            await remember("timeout");
            return noThumbnail();
          default:
            // Out of memory or a crash: says nothing about the file.
            return refusal(["files"], "internal_error", "The thumbnail couldn't be made.");
        }
      })().catch(
        // Anything thrown on the way (the cache, the copy): a plain 500, never a stuck slot.
        (): ServiceResult<{ readonly jpeg: Uint8Array }> =>
          refusal(["files"], "internal_error", "The thumbnail couldn't be made."),
      );
      making.set(key, made);
      try {
        return await made;
      } finally {
        // Released whatever happened (review 2, B1).
        making.delete(key);
        makingNow--;
        makingFor.delete(organizationId);
      }
    },

    async listFiles(context, recordId) {
      return run("listFiles", context, async (tx, who) => {
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        const allowed = await mayChange(tx, who, recordId, "share", []);
        if (!allowed.ok) return allowed;
        const files = await listStoredFiles(tx, who.organizationId, recordId);
        return { ok: true, value: files };
      });
    },
  };
}
