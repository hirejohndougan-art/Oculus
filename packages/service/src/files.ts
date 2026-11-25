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
 *
 * Attaching a file doesn't change the asset's record or its version: the
 * files are their own rows (0025). `If-Match` only makes sure the person
 * attached to the asset as they last saw it.
 */
import { randomUUID } from "node:crypto";
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
  sweepableContents,
  databaseIdentity,
  readFileStoreBinding,
  insertStoredFile,
  listStoredFiles,
  lockOrganizationFiles,
  organizationFileBytes,
  organizationHasContent,
  versionConflict,
  type Database,
  type Queryable,
  type RecordPlace,
  type StoredFile,
} from "@oculus/db";
import { editPermissions, notPermitted, type RecordAccess, type Refusal } from "./access.js";
import type { Runner } from "./admin.js";
import type { FileStore, ReceivedFile, StoreMarker } from "./file-store.js";
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
   * permission where the asset is, `If-Match`). The copy on disk goes at
   * the next sweep, once no row names its content.
   */
  removeFile(
    context: ServiceContext,
    recordId: RecordId,
    fileId: string,
    options: RemoveFileOptions,
  ): Promise<ServiceResult<{ readonly removed: true }>>;
  /**
   * A job, not a person's operation (no context): removes temporary files
   * older than `incomingMaxAgeMs` and, for each organization under its file
   * lock, the stored copies no row names. Run at startup and on a timer.
   */
  sweepFiles(incomingMaxAgeMs: number): Promise<FileSweep>;
  /**
   * Ties the files folder to this database (review B1): the first time, an
   * empty folder gets a new install ID, in the database and in the folder's
   * marker file; afterwards the two must agree. Refused for a folder with
   * another install's marker, a folder without the marker this database
   * expects, and a folder with anything in it but no marker. Until it
   * succeeds the sweep deletes nothing.
   */
  bindFileStore(): Promise<
    | { readonly ok: true; readonly warning?: "database_changed" }
    | { readonly ok: false; readonly problem: FileStoreProblem }
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
): FileOperations {
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
              // The copy on disk was placed when that row was made.
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
        // new install ID, marker first (so a crash leaves a marker this
        // database can still adopt, below), then the row.
        if (!(await store.isEmpty())) return { ok: false, problem: "not_empty" };
        const storeId = randomUUID();
        let wrote = false;
        try {
          await store.writeMarker(storeId, identity);
          wrote = true;
        } catch {
          // Another server of this database (or another install) wrote one
          // first: decided below from what it wrote.
        }
        if (wrote) {
          held = await insertFileStoreBinding(db, storeId);
          marker = { storeId, database: identity };
        } else {
          marker = await markerSettled(store);
        }
      }
      if (held === undefined && marker !== undefined) {
        // A marker without this database's row: either another server of
        // this database is between its two steps, or a crash came between
        // them (the marker names this database's identity, nothing else
        // ever does), or it is another install's.
        held = await waitFor(() => readFileStoreBinding(db));
        if (held === undefined && marker.database === identity) {
          held = await insertFileStoreBinding(db, marker.storeId);
        }
      }
      if (held === undefined) return { ok: false, problem: "other_install" };
      if (marker === undefined) return { ok: false, problem: "marker_missing" };
      if (marker.storeId !== held) return { ok: false, problem: "other_install" };
      store.bind(held);
      if (marker.database === undefined) {
        // An operator removed the database line to let this database sweep
        // again (after a restore): it is recorded now.
        await store.recordDatabase(held, identity);
        return { ok: true };
      }
      // A restored or copied database: bound (uploads work), but its sweep
      // stays off until an operator says this is the database now.
      return marker.database === identity
        ? { ok: true }
        : { ok: true, warning: "database_changed" };
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
      // Not yet checked against this database: the folder may be another
      // install's, so nothing outside our own uploads is touched.
      const bound = store.boundTo();
      if (bound === undefined || bound !== (await readFileStoreBinding(db))) {
        return { ...none, unbound: true };
      }
      // The marker again, every time, and the database's identity in it.
      const marker = await store.readMarker().catch(() => undefined);
      if (marker?.storeId !== bound) return { ...none, halted: "marker_changed" };
      if (marker.database !== (await databaseIdentity(db))) {
        return { ...none, halted: "database_changed" };
      }
      // Only organizations of this database: any other folder is left alone.
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
      let skipped = 0;
      let unknown = 0;
      for (const organizationId of ours) {
        try {
          // Decided under the organization's file lock (an attach placing a
          // copy holds it until its row is committed), and moved aside there
          // in one cheap rename each; deleted after the lock is released.
          // Deny by default: only what this database itself gave up.
          const counts = await db.transaction(async (tx) => {
            await lockOrganizationFiles(tx, organizationId);
            const listed = await store.listContents(organizationId);
            let unknownHere = 0;
            for (let i = 0; i < listed.hashes.length; i += 1000) {
              const batch = listed.hashes.slice(i, i + 1000);
              const decided = await sweepableContents(tx, organizationId, batch);
              unknownHere += decided.unknown.size;
              for (const sha256 of decided.deletable) await store.trash(organizationId, sha256);
            }
            return { skipped: listed.skipped, unknown: unknownHere };
          });
          skipped += counts.skipped;
          unknown += counts.unknown;
          contents += await store.emptyTrash(organizationId);
        } catch {
          // One organization's trouble doesn't stop the others.
          failed++;
        }
      }
      return Object.freeze({ incoming, contents, skipped, unknown, failed, unbound: false });
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
