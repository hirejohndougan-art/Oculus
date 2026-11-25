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
 * files are their own rows (0022). `If-Match` only makes sure the person
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
  findStoredFile,
  insertStoredFile,
  listStoredFiles,
  lockOrganizationFiles,
  organizationFileBytes,
  organizationHasContent,
  versionConflict,
  type Queryable,
  type RecordPlace,
  type StoredFile,
} from "@oculus/db";
import { editPermissions, type RecordAccess, type Refusal } from "./access.js";
import type { Runner } from "./admin.js";
import type { FileStore, ReceivedFile } from "./file-store.js";
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

export interface FileOperations {
  /** Asked before an upload is read; see the module header. */
  mayAttachFile(
    context: ServiceContext,
    recordId: RecordId,
    check: AttachCheck,
  ): Promise<ServiceResult<{ readonly maxFileBytes: number }>>;
  /** Attaches received bytes to the asset; always discards the temporary file. */
  attachFile(
    context: ServiceContext,
    recordId: RecordId,
    received: ReceivedFile,
    options: AttachOptions,
  ): Promise<ServiceResult<AttachedFile>>;
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

export function fileOperations(
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
    return undefined;
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
        if (declared !== undefined) {
          if (declared > store.maxFileBytes) {
            return refusal(
              ["files"],
              "file_too_large",
              "The file is larger than the server takes.",
            );
          }
          // A first look without the lock; attachFile counts again under it.
          const used = await organizationFileBytes(tx, who.organizationId);
          if (used + declared > store.maxOrganizationBytes) return overQuota();
        }
        return { ok: true, value: Object.freeze({ maxFileBytes: store.maxFileBytes }) };
      });
    },

    async attachFile(context, recordId, received, options) {
      try {
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
              id: randomUUID(),
              recordId,
              sha256: received.sha256,
              size: received.size,
              mediaType: sniffMediaType(received.head),
              claimedType: claimed,
              name,
              createdBy: who.actor,
              createdAt: new Date(Math.floor(now.getTime())),
            });
            // Last, still under the file lock: the bytes at their content path.
            await store.place(received);
            return { ok: true, value: Object.freeze({ file, created: true }) };
          },
        );
      } finally {
        await store?.discard(received).catch(() => undefined);
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
