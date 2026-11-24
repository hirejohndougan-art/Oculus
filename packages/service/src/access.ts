/**
 * Who may do what, checked in the write's own transaction (T-041, D-072).
 *
 * Every service operation reads the actor's access with `loadAccess` (their
 * user row locked `FOR SHARE`, then their grants: a revocation committed
 * before is seen, one made meanwhile waits for this transaction) and asks
 * core's `permits` before it reads or writes anything else of the record.
 * The actor's system manager flag and grants always come from the database,
 * never from the session or the caller.
 *
 * **Refusals reveal nothing the actor can't see.** A record the actor may
 * not view gets exactly the refusal a record that doesn't exist gets; a
 * parent or represented record they may not view gets exactly the refusal
 * a missing one gets. Only for what they can see does the refusal say
 * `not_permitted`. Messages name no record, person or site.
 */
import {
  hasScopedGrants,
  issue,
  isUserId,
  permits,
  worksOnSite,
  type Access,
  type OrganizationId,
  type Permission,
  type PermissionTarget,
  type RecordId,
  type SiteId,
  type UserId,
} from "@oculus/core";
import {
  loadAccess,
  lockArrangement,
  lockRecord,
  readRecordPlace,
  readSite,
  sitesSharedInto,
  unitsHolding,
  type Queryable,
  type RecordPlace,
  type RecordPosition,
} from "@oculus/db";

export interface Refusal {
  readonly ok: false;
  readonly issues: readonly ReturnType<typeof issue>[];
}

export const NOT_PERMITTED_MESSAGE = "You don't have permission to do this.";

export function notPermitted(): Refusal {
  return { ok: false, issues: [issue([], "not_permitted", NOT_PERMITTED_MESSAGE)] };
}

/** Exactly the refusal a record that doesn't exist gets (service.ts uses the same). */
export function noSuchRecord(): Refusal {
  return {
    ok: false,
    issues: [issue(["recordId"], "unknown_record", "The organization has no such record.")],
  };
}

/** The signed-in person of a `user:` actor; `system:` jobs hold no roles yet. */
export function actorUser(actor: string): UserId | undefined {
  if (!actor.startsWith("user:")) return undefined;
  const id = actor.slice(5);
  return isUserId(id) ? id : undefined;
}

/**
 * A resolved session, as T-037's `resolveSession` gives it (D-069): only
 * the person and the organization are used. Its `systemAdmin` flag is
 * deliberately not read: whether someone is a system manager is read again
 * in each operation's transaction.
 */
export interface SessionLike {
  readonly userId: string;
  readonly organizationId: string;
}

/** The service context for a resolved session: the organization and `user:<id>`. */
export function contextFromSession(session: SessionLike): {
  readonly organizationId: OrganizationId;
  readonly actor: string;
} {
  return Object.freeze({
    organizationId: session.organizationId as OrganizationId,
    actor: `user:${session.userId}`,
  });
}

/**
 * The actor's access in the organization, or `not_permitted` for a job, an
 * unknown or disabled account, or someone with neither a role there nor
 * system manager rights.
 */
export async function readAccess(
  tx: Queryable,
  organizationId: OrganizationId,
  actor: string,
  options: { readonly lock?: boolean } = {},
): Promise<{ readonly ok: true; readonly value: Access; readonly userId: UserId } | Refusal> {
  const userId = actorUser(actor);
  if (userId === undefined) return notPermitted();
  const access = await loadAccess(tx, organizationId, userId, options);
  if (access === undefined || (!access.systemManager && access.grants.length === 0)) {
    return notPermitted();
  }
  return { ok: true, value: access, userId };
}

/**
 * Answers permission questions about records for one operation. A person
 * with any scoped grant needs the arrangement as it is now: the first such
 * question takes the organization's arrangement lock (before any record
 * row lock, as D-065 orders them), so no unit moves until COMMIT. Anyone
 * else is asked about the whole catalog only and takes no lock.
 *
 * The lock is exclusive for an operation that writes (`mode: "write"`), and
 * shared for one that only reads (`"read"`): scoped reads then run side by
 * side, while every move (which holds the lock exclusively, D-065 and
 * service.ts) still waits for them, and they for it, so a read never sees
 * a move half done. A write keeps it exclusive because it may move what it
 * writes, and a shared lock can't safely be raised to an exclusive one.
 */
export class RecordAccess {
  private locked = false;

  constructor(
    private readonly tx: Queryable,
    private readonly organizationId: OrganizationId,
    readonly access: Access,
    private readonly mode: "write" | "read" = "write",
  ) {}

  /** Whether the person's checks depend on where records sit (any scoped grant). */
  get scoped(): boolean {
    return hasScopedGrants(this.access);
  }

  /**
   * Takes the arrangement lock now if the person has scoped grants, so
   * every place read after it is as it will stay until COMMIT. Call before
   * reading any record's place.
   */
  async settle(): Promise<void> {
    if (!hasScopedGrants(this.access) || this.locked) return;
    await lockArrangement(
      this.tx,
      this.organizationId,
      this.mode === "read" ? "shared" : "exclusive",
    );
    this.locked = true;
  }

  /**
   * The target for a record at `position`: its home site (D-074), the sites
   * it is shared into (stored records only; none until T-041b), and the
   * units holding it when the person has scoped grants.
   */
  async target(position: RecordPosition): Promise<PermissionTarget> {
    const site = position.siteId ?? null;
    const sharedInto =
      position.id === undefined
        ? new Set<SiteId>()
        : await sitesSharedInto(this.organizationId, position.id);
    if (!hasScopedGrants(this.access)) return { on: "catalog", site, sharedInto };
    await this.settle();
    return {
      on: "units",
      units: await unitsHolding(this.tx, this.organizationId, position),
      site,
      sharedInto,
    };
  }

  /**
   * Whether the site is one of the organization's and the person may work
   * in it (a role on it or on every site, or a system manager).
   */
  async worksOn(siteId: SiteId): Promise<boolean> {
    if (!worksOnSite(this.access, siteId)) return false;
    return (await readSite(this.tx, this.organizationId, siteId)) !== undefined;
  }

  /** Whether any of `permissions` is held at `target`. */
  allows(permissions: readonly Permission[], target: PermissionTarget): boolean {
    return permissions.some((p) => permits(this.access, p, target));
  }

  /**
   * For a stored record: `noSuchRecord` unless the actor may view it, then
   * `not_permitted` unless every one of `all` and any one of `any` (if
   * given) is held there. Viewing through a share (T-041b) never lets
   * anyone change the record: changes are asked at its home site only.
   */
  async onRecord(
    position: RecordPosition & { readonly id: RecordId },
    all: readonly Permission[],
    any: readonly Permission[] = [],
  ): Promise<Refusal | undefined> {
    const target = await this.target(position);
    if (!permits(this.access, "records.view", target)) return noSuchRecord();
    if (!all.every((p) => permits(this.access, p, target))) return notPermitted();
    if (any.length > 0 && !this.allows(any, target)) return notPermitted();
    return undefined;
  }

  /** Whether the actor may view the stored record now at `place`. */
  private async views(id: RecordId, place: RecordPlace): Promise<boolean> {
    const target = await this.target({
      kind: place.kind,
      id,
      parentId: place.parentId,
      represents: place.represents,
      siteId: place.siteId,
    });
    return permits(this.access, "records.view", target);
  }

  /**
   * Of `ids`, the records that exist and that the actor may not view (none
   * for a system manager). A link to one of them is answered as a link to a
   * record that doesn't exist.
   */
  async hiddenAmong(ids: readonly RecordId[]): Promise<ReadonlySet<RecordId>> {
    const hidden = new Set<RecordId>();
    if (ids.length === 0 || this.access.systemManager) return hidden;
    for (const id of [...new Set(ids)].sort()) {
      const place = await readRecordPlace(this.tx, this.organizationId, id);
      if (place === undefined) continue;
      if (!(await this.views(id, place))) hidden.add(id);
    }
    return hidden;
  }

  /**
   * For the place a record is put (a new record's, or where one moves to):
   * its home site (`siteId`) and the units above its parent, or those of
   * what it represents, never the record itself. The parent or represented
   * record is locked `FOR SHARE` and must be one the actor may view;
   * otherwise the refusal is the one for a parent or represented record that
   * doesn't exist. Take the arrangement lock (if needed) before calling.
   */
  async intoPlace(
    position: RecordPosition,
    any: readonly Permission[],
    stored: boolean,
  ): Promise<Refusal | undefined> {
    const placeId =
      position.kind === "archival_unit"
        ? (position.parentId ?? null)
        : position.kind === "digital_asset"
          ? (position.represents ?? null)
          : null;
    if (placeId !== null) {
      const locked = await lockRecord(this.tx, this.organizationId, placeId, "share");
      const place =
        locked === undefined
          ? undefined
          : await readRecordPlace(this.tx, this.organizationId, placeId);
      if (place === undefined || !(await this.views(placeId, place))) {
        return position.kind === "archival_unit"
          ? {
              ok: false,
              issues: [
                issue(
                  ["parentId"],
                  "missing_parent",
                  stored
                    ? "The unit it would be filed under doesn't exist, or is not an archival unit."
                    : "There is no archival unit with this ID in the organization.",
                ),
              ],
            }
          : {
              ok: false,
              issues: [
                issue(
                  ["represents"],
                  "unknown_record",
                  "The organization has no record with this ID.",
                ),
              ],
            };
      }
    }
    const target = await this.target({
      kind: position.kind,
      parentId: position.parentId ?? null,
      represents: position.represents ?? null,
      siteId: position.siteId ?? null,
    });
    if (this.allows(any, target)) return undefined;
    return notPermitted();
  }
}

/** The permissions that let a person change a record of this kind. */
export function editPermissions(kind: string): readonly Permission[] {
  return kind === "digital_asset" ? ["records.edit", "media.attach"] : ["records.edit"];
}

/** The permissions that let a person make a record of this kind. */
export function createPermissions(kind: string): readonly Permission[] {
  return kind === "digital_asset" ? ["records.create", "media.attach"] : ["records.create"];
}

/**
 * The default `ServiceOptions.mayChangePublicOutput` (T-034, D-076): who may
 * change what the public sees, by `records.publish` at the record's place
 * (its home site and, for scoped grants, the units holding it). Asked
 * before the operation has looked the record up, so it looks it up itself,
 * in the session's organization only: a record that doesn't exist and one
 * the actor may not view get exactly `unknown_record`; one they can see
 * but not publish, `not_permitted`. It writes nothing. It takes the locks
 * the operation takes next anyway, in the same order (the arrangement lock
 * for scoped grants, then the record's row `FOR NO KEY UPDATE`), so the
 * place it checked is the place until COMMIT.
 */
export async function publishPermission(
  tx: Queryable,
  request: {
    readonly organizationId: OrganizationId;
    readonly actor: string;
    readonly recordId: RecordId;
  },
): Promise<Refusal | undefined> {
  const access = await readAccess(tx, request.organizationId, request.actor);
  if (!access.ok) return access;
  const checker = new RecordAccess(tx, request.organizationId, access.value);
  await checker.settle();
  if ((await lockRecord(tx, request.organizationId, request.recordId)) === undefined) {
    return noSuchRecord();
  }
  const place = await readRecordPlace(tx, request.organizationId, request.recordId);
  if (place === undefined) return noSuchRecord();
  return checker.onRecord(
    {
      kind: place.kind,
      id: request.recordId,
      parentId: place.parentId,
      represents: place.represents,
      siteId: place.siteId,
    },
    ["records.publish"],
  );
}
