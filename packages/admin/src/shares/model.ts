/**
 * Sharing items between sites in the admin (T-041e, D-094): the shapes the
 * share routes answer with, and plain words for them. A shared item's view
 * is what its home organization's public site shows, never more; its fields
 * come by key only (the other organization's template isn't ours to read),
 * so their names are made readable here.
 */

export type ShareState = "offered" | "accepted" | "declined" | "withdrawn" | "removed";

export const SHARE_STATE_LABELS: Readonly<Record<ShareState, string>> = {
  offered: "Offered, waiting for an answer",
  accepted: "Shared",
  declined: "Declined",
  withdrawn: "Withdrawn",
  removed: "Removed by the other site",
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
  readonly homeSite: string | null;
  readonly homeOrganization: string;
}

export interface IncomingShare extends ShareSummary {
  readonly item: SharedItemView;
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
