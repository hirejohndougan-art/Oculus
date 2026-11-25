/**
 * Sharing items between sites through the service (T-041b, D-074, D-094).
 *
 * - **Offering** (`offerRecord`): a **published** item only; someone who
 *   may edit the record at its home site (`records.edit`, or `media.attach` for a digital asset, as
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
 *   (`sharesOfRecord`). Each is paged (S-036a): at most `MAX_SHARE_PAGE` a
 *   page, newest first, the next page asked for with `{ before }`, the last
 *   share's ID (and, for a site's list, `{ state }`, `offered` or
 *   `accepted`). The manager's list also holds accepted items the public
 *   can't see right now, with `item: null` (`hidden`), so they can be
 *   removed; nobody else is shown those.
 * - **Seeing an accepted item** (`readSharedItem`, `listSharedItems`):
 *   anyone with `records.view` for the whole of the second site's catalog
 *   (or a system manager) sees `SharedItemView`: what the public is shown
 *   of it (`publishedRecordView`: no staff-only fields, links, rights notes
 *   or non-public ID numbers), only while the public could see it at all
 *   (published, on a home site, passing public output's publish check) and
 *   it isn't on the second site itself, with the names of its home site and
 *   organization, built in a REPEATABLE READ snapshot of its own after the
 *   checks. Never history, rights settings or people (D-019). The item is never changed
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
  lockRecord,
  lockShare,
  moveShare,
  readRecordPlace,
  readShare,
  readSite,
  readWorkflowState,
  sharedItemViews,
  SHARE_CHANGED,
  MAX_SHARE_PAGE,
  sharesIntoSite as storedSharesIntoSite,
  sharesOfRecord as storedSharesOfRecord,
  type Database,
  type Queryable,
  type Share,
  type ShareState,
  type SharedItemView,
} from "@oculus/db";
import { randomUUID } from "node:crypto";
import {
  NOT_PERMITTED_MESSAGE,
  RecordAccess,
  editPermissions,
  noSuchRecord,
  readAccess,
} from "./access.js";
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

/** An offer or accepted item, as the second site's people see it. */
export interface IncomingShare extends ShareSummary {
  /**
   * What the public is shown of it, or `null` (only in the site manager's
   * own list, S-036a) while the public can't see it at all: unpublished,
   * refused by the publish check, or without a stored Dublin Core mapping.
   * Nothing else is said about why.
   */
  readonly item: SharedItemView | null;
}

/**
 * One page of a share list (S-036a), and where the next one starts: `next`
 * is the `before` to ask with (the last share the page read, shown or not),
 * or `null` when this page wasn't full. A page can show fewer shares than
 * `MAX_SHARE_PAGE` and still have a `next`: shares the person may not be
 * shown are read and left out.
 */
export interface SharePage<T> {
  readonly shares: readonly T[];
  readonly next: string | null;
}

/** A site manager's page: offers and accepted items, each with its own `next`. */
export interface SiteSharesPage {
  readonly shares: readonly IncomingShare[];
  readonly next: { readonly offered: string | null; readonly accepted: string | null };
}

/** A page of a share list (S-036a): `before`, a page's `next`. */
export interface SharePageRequest {
  readonly before?: unknown;
  /** For a site's list: only this state's page (`offered` or `accepted`); both when left out. */
  readonly state?: unknown;
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
    page?: SharePageRequest,
  ): Promise<ServiceResult<SiteSharesPage>>;
  /** The record's shares (every state), for whoever may edit it. */
  sharesOfRecord(
    context: ServiceContext,
    recordId: unknown,
    page?: SharePageRequest,
  ): Promise<ServiceResult<SharePage<ShareSummary>>>;
  /** An item accepted into the site, as the site's people may see it. */
  readSharedItem(context: ServiceContext, shareId: unknown): Promise<ServiceResult<IncomingShare>>;
  /** The items accepted into the site. */
  listSharedItems(
    context: ServiceContext,
    siteId: unknown,
    page?: SharePageRequest,
  ): Promise<ServiceResult<SharePage<IncomingShare>>>;
}

type Refusal = ServiceRefusal;

function refusal(path: (string | number)[], code: string, message: string): Refusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const UNKNOWN_SHARE = (): Refusal =>
  refusal(["shareId"], "unknown_share", "There is no such share here.");
const UNKNOWN_SITE = (): Refusal =>
  refusal(["targetSiteId"], "unknown_site", "There is no such site to offer it to.");
const NOT_PERMITTED = (): Refusal => refusal([], "not_permitted", NOT_PERMITTED_MESSAGE);

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

/** Runs work with transactions of its own under the runner's error handling (service.ts). */
export type Outside = <T>(
  operation: string,
  work: () => Promise<ServiceResult<T>>,
) => Promise<ServiceResult<T>>;

export function shareOperations(db: Database, run: Runner, outside: Outside): ShareOperations {
  /**
   * The home side's check for a record: the person may edit it at its home
   * site (`onRecord`, which answers a record they can't see as
   * `unknown_record`). Takes the arrangement lock (scoped grants only),
   * then the record's row `FOR SHARE`, so it is neither deleted nor moved
   * meanwhile; the edit rights are checked on the place read under it.
   */
  async function mayShareRecord(
    tx: Queryable,
    who: { organizationId: OrganizationId; actor: string },
    access: Access,
    recordId: RecordId,
    mode: "write" | "read",
  ): Promise<Refusal | undefined> {
    // The arrangement lock first (when the person's grants are scoped), then
    // the record's row: D-065's order, as every write takes them.
    const checker = new RecordAccess(tx, who.organizationId, access, mode);
    await checker.settle();
    if ((await lockRecord(tx, who.organizationId, recordId, "share")) === undefined) {
      return noSuchRecord();
    }
    const place = await readRecordPlace(tx, who.organizationId, recordId);
    if (place === undefined) return noSuchRecord();
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

  /**
   * The second side's views of `shares` (after the operation's checks, in a
   * snapshot of their own: `sharedItemViews`), in order; a share whose item
   * the public can't see now is left out.
   */
  /**
   * The shares with their views. Offers and accepted items the public can't
   * see are left out, unless `keepHidden` (the site manager's own list,
   * S-036a), which keeps accepted ones with `item: null`.
   */
  async function incoming(
    shares: readonly Share[],
    keepHidden = false,
  ): Promise<readonly IncomingShare[]> {
    const views = await sharedItemViews(db, shares);
    const out: IncomingShare[] = [];
    for (const share of shares) {
      const item = views.get(share.id);
      // Ended or moved onto the site since it was listed: not shown at all.
      if (item === SHARE_CHANGED) continue;
      if (item !== undefined) out.push(Object.freeze({ ...summary(share), item }));
      else if (keepHidden && share.state === "accepted") {
        out.push(Object.freeze({ ...summary(share), item: null }));
      }
    }
    return Object.freeze(out);
  }

  /** The `before` of the page after `page` (its last share), or null if `page` wasn't full. */
  function nextOf(page: readonly Share[]): string | null {
    return page.length >= MAX_SHARE_PAGE ? (page.at(-1)?.id ?? null) : null;
  }

  /** A page request's parts, or undefined when it isn't one. */
  function pageOf(
    page: unknown,
    allowState: boolean,
  ): { before?: unknown; state?: "offered" | "accepted" } | undefined {
    if (page === undefined) return {};
    if (!hasOnly(page, allowState ? ["before", "state"] : ["before"])) return undefined;
    const before = own(page, "before");
    const state = own(page, "state");
    if (before !== undefined && typeof before !== "string") return undefined;
    if (state !== undefined && state !== "offered" && state !== "accepted") return undefined;
    return {
      ...(before === undefined ? {} : { before }),
      ...(state === undefined ? {} : { state }),
    };
  }

  const BAD_PAGE = () =>
    refusal(
      ["page"],
      "invalid_request",
      "A page is { before } (a share ID) and, for a site's list, { state }.",
    );

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
    const share = await lockShare(tx, shareId, "target", who.organizationId);
    if (share === undefined || !managesSite(access.value, share.targetSiteId)) {
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
        const allowed = await mayShareRecord(tx, who, access.value, recordId, "write");
        if (allowed) return allowed;
        const place = await readRecordPlace(tx, who.organizationId, recordId);
        if (place === undefined) return noSuchRecord();
        // Only what is already public goes to another site (D-094): an
        // offer never shows an unpublished item to anyone new.
        if (
          place.siteId === null ||
          (await readWorkflowState(tx, who.organizationId, recordId))?.state !== "published"
        ) {
          return refusal(
            ["recordId"],
            "not_published",
            "Only a published item can be offered to another site.",
          );
        }
        // The site, of any organization: it must exist, and not be home.
        const site = await readSite(tx, targetOrganizationId, targetSiteId);
        if (
          site === undefined ||
          (targetOrganizationId === who.organizationId && place.siteId === targetSiteId)
        ) {
          return UNKNOWN_SITE();
        }
        const share = await insertShare(tx, {
          id: randomUUID(),
          organizationId: who.organizationId,
          recordId,
          targetOrganizationId,
          targetSiteId,
          offeredBy: access.userId,
        });
        // A live share there already (perhaps made a moment ago by another offer).
        if (share === undefined) {
          return refusal(
            ["targetSiteId"],
            "already_shared",
            "It is already offered to or shown on that site.",
          );
        }
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
        // The record first, then the share (the order a deletion takes them).
        const seen = await readShare(tx, shareId, "home", who.organizationId);
        if (seen === undefined) return UNKNOWN_SHARE();
        // Only someone who may share the record may withdraw it; anyone else
        // learns nothing about the share (or the record).
        if (await mayShareRecord(tx, who, access.value, seen.recordId, "write")) {
          return UNKNOWN_SHARE();
        }
        const share = await lockShare(tx, seen.id, "home", who.organizationId);
        if (share === undefined) return UNKNOWN_SHARE();
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

    async sharesIntoSite(context, siteId, page) {
      const checked = await run("sharesIntoSite", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        if (
          !isSiteId(siteId) ||
          (await readSite(tx, who.organizationId, siteId)) === undefined ||
          !managesSite(access.value, siteId)
        ) {
          return NOT_PERMITTED();
        }
        const wanted = pageOf(page, true);
        // A cursor belongs to one state's list: `before` needs `state`.
        if (wanted === undefined || (wanted.before !== undefined && wanted.state === undefined)) {
          return BAD_PAGE();
        }
        const states =
          wanted.state === undefined ? (["offered", "accepted"] as const) : [wanted.state];
        const read: Partial<Record<"offered" | "accepted", readonly Share[]>> = {};
        for (const state of states) {
          read[state] = await storedSharesIntoSite(tx, who.organizationId, siteId, state, {
            before: wanted.before,
            includeHidden: state === "accepted",
          });
        }
        return { ok: true, value: read };
      });
      if (!checked.ok) return checked;
      const read = checked.value;
      return outside("sharesIntoSite", async () => ({
        ok: true,
        value: Object.freeze({
          shares: await incoming([...(read.offered ?? []), ...(read.accepted ?? [])], true),
          next: Object.freeze({
            offered: nextOf(read.offered ?? []),
            accepted: nextOf(read.accepted ?? []),
          }),
        }),
      }));
    },

    async sharesOfRecord(context, recordId, page) {
      return run("sharesOfRecord", context, async (tx, who) => {
        if (!isRecordId(recordId)) return noSuchRecord();
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        const allowed = await mayShareRecord(tx, who, access.value, recordId, "read");
        if (allowed) return allowed;
        const wanted = pageOf(page, false);
        if (wanted === undefined) return BAD_PAGE();
        const shares = await storedSharesOfRecord(tx, who.organizationId, recordId, {
          before: wanted.before,
        });
        return {
          ok: true,
          value: Object.freeze({
            shares: Object.freeze(shares.map(summary)),
            next: nextOf(shares),
          }),
        };
      });
    },

    async readSharedItem(context, shareId) {
      const checked = await run("readSharedItem", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return UNKNOWN_SHARE();
        const share = await readShare(tx, shareId, "target", who.organizationId);
        if (share?.state !== "accepted" || !seesSite(access.value, share.targetSiteId)) {
          return UNKNOWN_SHARE();
        }
        return { ok: true, value: share };
      });
      if (!checked.ok) return checked;
      const share = checked.value;
      return outside("readSharedItem", async () => {
        const [view] = await incoming([share]);
        return view === undefined ? UNKNOWN_SHARE() : { ok: true, value: view };
      });
    },

    async listSharedItems(context, siteId, page) {
      const checked = await run("listSharedItems", context, async (tx, who) => {
        const access = await readAccess(tx, who.organizationId, who.actor);
        if (!access.ok) return access;
        if (
          !isSiteId(siteId) ||
          (await readSite(tx, who.organizationId, siteId)) === undefined ||
          !seesSite(access.value, siteId)
        ) {
          return NOT_PERMITTED();
        }
        const wanted = pageOf(page, false);
        if (wanted === undefined) return BAD_PAGE();
        return {
          ok: true,
          value: await storedSharesIntoSite(tx, who.organizationId, siteId, "accepted", {
            before: wanted.before,
          }),
        };
      });
      if (!checked.ok) return checked;
      const shares = checked.value;
      return outside("listSharedItems", async () => ({
        ok: true,
        value: Object.freeze({ shares: await incoming(shares), next: nextOf(shares) }),
      }));
    },
  };
}
