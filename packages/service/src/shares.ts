/**
 * Sharing items between sites through the service (T-041b, D-074, D-094).
 *
 * - **Offering** (`offerRecord`): someone who may edit the record at its
 *   home site (`records.edit`, or `media.attach` for a digital asset, as
 *   editing it needs) offers it to another site, of their own organization
 *   or another one, named by its organization and site IDs (a site's manager
 *   passes them on: Oculus lists no other organization's sites). Never to
 *   the record's own home site; one live offer per record and site.
 * - **Deciding** (`acceptShare`, `declineShare`): the second site's manager
 *   (`site.settings` there, or a system manager), in a session of the second
 *   site's organization.
 * - **Ending**: the home side withdraws an offer or an accepted item
 *   (`withdrawShare`, the same people who may offer it); the second site's
 *   manager removes an accepted item (`removeShare`).
 * - **Lists**: a site's offers and accepted items for its manager
 *   (`sharesIntoSite`), a record's shares for whoever may edit it
 *   (`sharesOfRecord`).
 * - **Seeing an accepted item** (`readSharedItem`, `listSharedItems`):
 *   anyone with `records.view` for the whole of the second site's catalog
 *   (or a system manager) sees `SharedItemView`: the title, kind, whether it
 *   is published, the fields its template makes public, and the names of
 *   its home site and organization. Never staff-only fields, ID numbers,
 *   history, rights settings or people (D-019). The item is never changed
 *   from the second site, and a share never widens `onRecord`: the record's
 *   own permission checks don't read shares (`sitesSharedInto` stays empty,
 *   D-094), so the S-028 equivalence of `allowsUnlocked` and `onRecord`
 *   is untouched.
 *
 * Every share another organization's session asks about, and every share
 * the person may not act on or see, answers the same `unknown_share`; a
 * record they can't see is `unknown_record` as everywhere. A target site
 * that doesn't exist, or is the record's home site, is `unknown_site`.
 */
import {
  holdsForWholeCatalog,
  isOrganizationId,
  isRecordId,
  isSiteId,
  issue,
  permits,
  type Access,
  type OrganizationId,
  type RecordId,
  type SiteId,
  type UserId,
} from "@oculus/core";
import {
  insertShare,
  liveShare,
  lockRecord,
  lockShare,
  moveShare,
  readRecordPlace,
  readShare,
  readSite,
  sharedItemView,
  sharesIntoSite as storedSharesIntoSite,
  sharesOfRecord as storedSharesOfRecord,
  type Queryable,
  type Share,
  type ShareState,
  type SharedItemView,
} from "@oculus/db";
import { randomUUID } from "node:crypto";
import { RecordAccess, editPermissions, noSuchRecord, readAccess } from "./access.js";
import { hasOnly, own, type Runner } from "./admin.js";
import type { ServiceContext, ServiceRefusal, ServiceResult } from "./service.js";

/** A share as the service gives it out. */
export interface ShareSummary {
  readonly id: string;
  readonly state: ShareState;
  readonly recordId: RecordId;
  readonly targetOrganizationId: OrganizationId;
  readonly targetSiteId: SiteId;
  readonly offeredAt: string;
  readonly decidedAt: string | null;
  readonly endedAt: string | null;
}

/** An offer or accepted item, as the second site's manager sees it. */
export interface IncomingShare extends ShareSummary {
  readonly item: SharedItemView;
}

export interface ShareOperations {
  offerRecord(context: ServiceContext, request: unknown): Promise<ServiceResult<ShareSummary>>;
  acceptShare(context: ServiceContext, shareId: unknown): Promise<ServiceResult<ShareSummary>>;
  declineShare(context: ServiceContext, shareId: unknown): Promise<ServiceResult<ShareSummary>>;
  withdrawShare(context: ServiceContext, shareId: unknown): Promise<ServiceResult<ShareSummary>>;
  removeShare(context: ServiceContext, shareId: unknown): Promise<ServiceResult<ShareSummary>>;
  /** Offers waiting for and items accepted into the site, for its manager. */
  sharesIntoSite(
    context: ServiceContext,
    siteId: unknown,
  ): Promise<ServiceResult<readonly IncomingShare[]>>;
  /** The record's shares (every state), for whoever may edit it. */
  sharesOfRecord(
    context: ServiceContext,
    recordId: unknown,
  ): Promise<ServiceResult<readonly ShareSummary[]>>;
  /** An item accepted into the site, as the site's people may see it. */
  readSharedItem(context: ServiceContext, shareId: unknown): Promise<ServiceResult<IncomingShare>>;
  /** The items accepted into the site. */
  listSharedItems(
    context: ServiceContext,
    siteId: unknown,
  ): Promise<ServiceResult<readonly IncomingShare[]>>;
}

type Refusal = ServiceRefusal;

function refusal(path: (string | number)[], code: string, message: string): Refusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const UNKNOWN_SHARE = (): Refusal =>
  refusal(["shareId"], "unknown_share", "There is no such share here.");
const UNKNOWN_SITE = (): Refusal =>
  refusal(["targetSiteId"], "unknown_site", "There is no such site to offer it to.");
const NOT_PERMITTED = (): Refusal =>
  refusal([], "not_permitted", "You don't have permission to do that.");

function summary(share: Share): ShareSummary {
  return Object.freeze({
    id: share.id,
    state: share.state,
    recordId: share.recordId,
    targetOrganizationId: share.targetOrganizationId,
    targetSiteId: share.targetSiteId,
    offeredAt: share.offeredAt,
    decidedAt: share.decidedAt,
    endedAt: share.endedAt,
  });
}

/** Whether `access` manages `site` (its settings), or is a system manager. */
function managesSite(access: Access, site: SiteId): boolean {
  return permits(access, "site.settings", { on: "site", siteId: site });
}

/** Whether `access` may see what is accepted into `site`. */
function seesSite(access: Access, site: SiteId): boolean {
  return holdsForWholeCatalog(access, "records.view", site);
}

export function shareOperations(run: Runner): ShareOperations {
  /**
   * The home side's check for a record: the person may edit it at its home
   * site (`onRecord`, which answers a record they can't see as
   * `unknown_record`). Takes the record's row lock (`FOR KEY SHARE` is
   * enough to keep it from being deleted or moved away underneath; the
   * edit rights are checked on the place read under it).
   */
  async function mayShareRecord(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
    access: Access,
    recordId: RecordId,
  ): Promise<Refusal | undefined> {
    if ((await lockRecord(tx, who.organizationId, recordId, "share")) === undefined) {
      return noSuchRecord();
    }
    const place = await readRecordPlace(tx, who.organizationId, recordId);
    if (place === undefined) return noSuchRecord();
    const checker = new RecordAccess(tx, who.organizationId, access, "write");
    return checker.onRecord(
      {
        kind: place.kind,
        id: recordId,
        parentId: place.parentId,
        represents: place.represents,
        siteId: place.siteId,
      },
      [],
      editPermissions(place.kind),
    );
  }

  /** The second side's view of an incoming share, or `undefined` if its record is gone. */
  async function incoming(tx: Queryable, share: Share): Promise<IncomingShare | undefined> {
    const item = await sharedItemView(tx, share.organizationId, share.recordId);
    return item === undefined ? undefined : Object.freeze({ ...summary(share), item });
  }

  /**
   * A share the second site acts on: locked, of the session's organization's
   * site, and managed by the person; anything else is `unknown_share`.
   */
  async function managedShare(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
    shareId: unknown,
  ): Promise<{ ok: true; share: Share; userId: UserId } | Refusal> {
    const access = await readAccess(tx, who.organizationId, who.actor, { lock: true });
    if (!access.ok) return UNKNOWN_SHARE();
    const share = await lockShare(tx, shareId);
    if (
      share?.targetOrganizationId !== who.organizationId ||
      !managesSite(access.value, share.targetSiteId)
    ) {
      return UNKNOWN_SHARE();
    }
    return { ok: true, share, userId: access.userId };
  }

  const decide =
    (to: "accepted" | "declined" | "removed", from: ShareState) =>
    (context: ServiceContext, shareId: unknown): Promise<ServiceResult<ShareSummary>> =>
      run(`share_${to}`, context, async (tx, who) => {
        const found = await managedShare(tx, who, shareId);
        if (!found.ok) return found;
        if (found.share.state !== from) {
          return refusal(
            ["shareId"],
            "share_not_open",
            "That share can't be changed that way now.",
          );
        }
        return { ok: true, value: summary(await moveShare(tx, found.share.id, to, found.userId)) };
      });

  return {
    async offerRecord(context, request) {
      return run("offerRecord", context, async (tx, who) => {
        if (!hasOnly(request, ["recordId", "targetOrganizationId", "targetSiteId"])) {
          return refusal(
            ["request"],
            "invalid_request",
            "An offer is recordId, targetOrganizationId and targetSiteId.",
          );
        }
        const recordId = own(request, "recordId");
        const targetOrganizationId = own(request, "targetOrganizationId");
        const targetSiteId = own(request, "targetSiteId");
        if (!isRecordId(recordId)) {
          return refusal(["recordId"], "invalid_id", "A record ID is a lowercase version 4 UUID.");
        }
        if (!isOrganizationId(targetOrganizationId) || !isSiteId(targetSiteId)) {
          return refusal(
            ["targetSiteId"],
            "invalid_id",
            "The site and its organization are lowercase version 4 UUIDs.",
          );
        }
        const access = await readAccess(tx, who.organizationId, who.actor, { lock: true });
        if (!access.ok) return access;
        const allowed = await mayShareRecord(tx, who, access.value, recordId);
        if (allowed) return allowed;
        const place = await readRecordPlace(tx, who.organizationId, recordId);
        if (place === undefined) return noSuchRecord();
        // The site, of any organization: it must exist, and not be home.
        const site = await readSite(tx, targetOrganizationId, targetSiteId);
        if (
          site === undefined ||
          (targetOrganizationId === who.organizationId && place.siteId === targetSiteId)
        ) {
          return UNKNOWN_SITE();
        }
        if (
          (await liveShare(
            tx,
            who.organizationId,
            recordId,
            targetOrganizationId,
            targetSiteId,
          )) !== undefined
        ) {
          return refusal(
            ["targetSiteId"],
            "already_shared",
            "It is already offered to or shown on that site.",
          );
        }
        const share = await insertShare(tx, {
          id: randomUUID(),
          organizationId: who.organizationId,
          recordId,
          targetOrganizationId,
          targetSiteId,
          offeredBy: access.userId,
        });
        return { ok: true, value: summary(share) };
      });
    },

    acceptShare: decide("accepted", "offered"),
    declineShare: decide("declined", "offered"),
    removeShare: decide("removed", "accepted"),

    async withdrawShare(context, shareId) {
      return run("withdrawShare", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor, { lock: true });
        if (!access.ok) return UNKNOWN_SHARE();
        const share = await lockShare(tx, shareId);
        if (share?.organizationId !== who.organizationId) {
          return UNKNOWN_SHARE();
        }
        // Only someone who may share the record may withdraw it; anyone else
        // learns nothing about the share (or the record).
        if (await mayShareRecord(tx, who, access.value, share.recordId)) return UNKNOWN_SHARE();
        if (share.state !== "offered" && share.state !== "accepted") {
          return refusal(
            ["shareId"],
            "share_not_open",
            "That share can't be changed that way now.",
          );
        }
        return {
          ok: true,
          value: summary(await moveShare(tx, share.id, "withdrawn", access.userId)),
        };
      });
    },

    async sharesIntoSite(context, siteId) {
      return run("sharesIntoSite", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        if (
          !isSiteId(siteId) ||
          (await readSite(tx, who.organizationId, siteId)) === undefined ||
          !managesSite(access.value, siteId)
        ) {
          return NOT_PERMITTED();
        }
        const shares = await storedSharesIntoSite(tx, who.organizationId, siteId, [
          "offered",
          "accepted",
        ]);
        const out: IncomingShare[] = [];
        for (const share of shares) {
          const view = await incoming(tx, share);
          if (view !== undefined) out.push(view);
        }
        return { ok: true, value: Object.freeze(out) };
      });
    },

    async sharesOfRecord(context, recordId) {
      return run("sharesOfRecord", context, async (tx, who) => {
        if (!isRecordId(recordId)) return noSuchRecord();
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        const allowed = await mayShareRecord(tx, who, access.value, recordId);
        if (allowed) return allowed;
        const shares = await storedSharesOfRecord(tx, who.organizationId, recordId);
        return { ok: true, value: Object.freeze(shares.map(summary)) };
      });
    },

    async readSharedItem(context, shareId) {
      return run("readSharedItem", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return UNKNOWN_SHARE();
        const share = await readShare(tx, shareId);
        if (
          share?.state !== "accepted" ||
          share.targetOrganizationId !== who.organizationId ||
          !seesSite(access.value, share.targetSiteId)
        ) {
          return UNKNOWN_SHARE();
        }
        const view = await incoming(tx, share);
        return view === undefined ? UNKNOWN_SHARE() : { ok: true, value: view };
      });
    },

    async listSharedItems(context, siteId) {
      return run("listSharedItems", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        if (
          !isSiteId(siteId) ||
          (await readSite(tx, who.organizationId, siteId)) === undefined ||
          !seesSite(access.value, siteId)
        ) {
          return NOT_PERMITTED();
        }
        const shares = await storedSharesIntoSite(tx, who.organizationId, siteId, ["accepted"]);
        const out: IncomingShare[] = [];
        for (const share of shares) {
          const view = await incoming(tx, share);
          if (view !== undefined) out.push(view);
        }
        return { ok: true, value: Object.freeze(out) };
      });
    },
  };
}
