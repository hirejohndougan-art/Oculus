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
  type Access,
  type OrganizationId,
  type Permission,
  type PermissionTarget,
  type RecordId,
  type UserId,
} from "@oculus/core";
import {
  loadAccess,
  lockArrangement,
  unitsHolding,
  type Queryable,
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
): Promise<{ readonly ok: true; readonly value: Access; readonly userId: UserId } | Refusal> {
  const userId = actorUser(actor);
  if (userId === undefined) return notPermitted();
  const access = await loadAccess(tx, organizationId, userId);
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
 */
export class RecordAccess {
  private locked = false;

  constructor(
    private readonly tx: Queryable,
    private readonly organizationId: OrganizationId,
    readonly access: Access,
  ) {}

  /**
   * Takes the arrangement lock now if the person has scoped grants, so
   * every place read after it is as it will stay until COMMIT. Call before
   * reading any record's place.
   */
  async settle(): Promise<void> {
    if (!hasScopedGrants(this.access) || this.locked) return;
    await lockArrangement(this.tx, this.organizationId);
    this.locked = true;
  }

  /** The target for a record at `position` (units only when scoped grants exist). */
  async target(position: RecordPosition): Promise<PermissionTarget> {
    if (!hasScopedGrants(this.access)) return { on: "catalog" };
    await this.settle();
    return { on: "units", units: await unitsHolding(this.tx, this.organizationId, position) };
  }

  /** Whether any of `permissions` is held at `target`. */
  allows(permissions: readonly Permission[], target: PermissionTarget): boolean {
    return permissions.some((p) => permits(this.access, p, target));
  }

  /**
   * For a stored record: `noSuchRecord` unless the actor may view it, then
   * `not_permitted` unless every one of `all` and any one of `any` (if
   * given) is held there.
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

  /**
   * For the place a record is put (a new record's, or where one moves to):
   * the units above its parent, or those of what it represents, never the
   * record itself. When the actor can't view that place, the refusal is the
   * one for a parent or represented record that doesn't exist.
   */
  async intoPlace(
    position: RecordPosition,
    any: readonly Permission[],
    stored: boolean,
  ): Promise<Refusal | undefined> {
    const target = await this.target({
      kind: position.kind,
      parentId: position.parentId ?? null,
      represents: position.represents ?? null,
    });
    if (this.allows(any, target)) return undefined;
    const hasPlace =
      (position.kind === "archival_unit" && position.parentId != null) ||
      (position.kind === "digital_asset" && position.represents != null);
    if (hasPlace && !permits(this.access, "records.view", target)) {
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
