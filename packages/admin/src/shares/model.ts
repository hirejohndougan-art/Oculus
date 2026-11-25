/**
 * Sharing items between sites in the admin (T-041e, D-094): the shapes the
 * share routes answer with, and plain words for them. A shared item's view
 * is what its home organization's public site shows, never more: the fields
 * its home Dublin Core mapping publishes, with its home template's labels
 * (S-036a). Lists come a page at a time (`SHARE_PAGE`).
 */

/** The most shares one list page holds (the server's `MAX_SHARE_PAGE`). */
export const SHARE_PAGE = 50;

export type ShareState =
  "offered" | "accepted" | "declined" | "withdrawn" | "removed" | "deleted" | "moved";

export const SHARE_STATE_LABELS: Readonly<Record<ShareState, string>> = {
  offered: "Offered, waiting for an answer",
  accepted: "Shared",
  declined: "Declined",
  withdrawn: "Withdrawn",
  removed: "Removed by the other site",
  deleted: "Ended: the item was deleted",
  moved: "Ended: the item moved to that site",
};

export interface ShareSummary {
  readonly id: string;
  readonly state: ShareState;
  readonly recordId: string;
  readonly targetOrganizationId: string;
  readonly targetSiteId: string;
  readonly offeredAt: string;
  readonly decidedAt: string | null;
  readonly endedAt: string | null;
}

export interface SharedItemView {
  readonly title: string;
  readonly kind: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Each field's label in its home template. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly homeSite: string | null;
  readonly homeOrganization: string;
}

export interface IncomingShare extends ShareSummary {
  /** `null` (in the site manager's list only) while the public can't see the item. */
  readonly item: SharedItemView | null;
}

/** A shared item's title, or words for one the public can't see right now. */
export function itemTitle(share: IncomingShare): string {
  return share.item?.title ?? "An item not shown to the public right now";
}

/** A field's name: its home template's label, else made readable from its key. */
export function viewLabel(item: SharedItemView, key: string): string {
  const label =
    item.labels !== undefined && Object.hasOwn(item.labels, key) ? item.labels[key] : undefined;
  return typeof label === "string" && label !== "" ? label : fieldLabel(key);
}

/** A share that can still be ended: offered or accepted. */
export function isLive(state: ShareState): boolean {
  return state === "offered" || state === "accepted";
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A well-formed ID (a share's, a site's or an organization's), lower case. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** An ID as typed or pasted: trimmed and lower-cased. */
export function cleanId(text: string): string {
  return text.trim().toLowerCase();
}

/** "date_made" or "dateMade" → "Date made". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a shared item comes from, in words. */
export function homeText(item: SharedItemView): string {
  return item.homeSite === null
    ? item.homeOrganization
    : `${item.homeSite}, ${item.homeOrganization}`;
}
