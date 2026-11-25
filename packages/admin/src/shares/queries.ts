/**
 * Server data for sharing (T-041e): a record's shares, a site's offers and
 * accepted items, and one shared item. The server decides every permission;
 * these only ask. Everything stays in the Query cache, in memory.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { IncomingShare, ShareSummary } from "./model";
import type { PageOf } from "./paging";

export const recordSharesKey = (recordId: string) => ["record", recordId, "shares"] as const;
export const siteSharesKey = (siteId: string) => ["site-shares", siteId] as const;

export function useRecordShares(siteId: string, recordId: string, enabled: boolean) {
  return useQuery({
    queryKey: recordSharesKey(recordId),
    queryFn: async () =>
      pageOf(
        await api<{ shares: ShareSummary[]; next?: string | null }>(
          `/api/records/${encodeURIComponent(recordId)}/shares`,
          { site: siteId },
        ),
      ),
    enabled,
  });
}

/** Offers and accepted items, for the site's manager (403 for anyone else). */
export function useShareOffers(siteId: string) {
  return useQuery({
    queryKey: [...siteSharesKey(siteId), "offers"],
    queryFn: async () =>
      siteSharesOf(
        await api<{
          shares: IncomingShare[];
          next?: { offered?: string | null; accepted?: string | null };
        }>(`/api/sites/${encodeURIComponent(siteId)}/share-offers`, { site: siteId }),
      ),
  });
}

/** Accepted items, for anyone who may see the whole of the site's catalog. */
export function useSharedItems(siteId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...siteSharesKey(siteId), "items"],
    queryFn: async () =>
      pageOf(
        await api<{ shares: IncomingShare[]; next?: string | null }>(
          `/api/sites/${encodeURIComponent(siteId)}/shared-items`,
          { site: siteId },
        ),
      ),
    enabled,
  });
}

export function useSharedItem(siteId: string, shareId: string) {
  return useQuery({
    queryKey: [...siteSharesKey(siteId), "item", shareId],
    queryFn: async () =>
      (
        await api<{ share: IncomingShare }>(`/api/shares/${encodeURIComponent(shareId)}`, {
          site: siteId,
        })
      ).share,
  });
}

/** A list reply as a page: `next` is null when the server sent none. */
function pageOf<T>(reply: { shares: T[]; next?: string | null }): PageOf<T> {
  return { shares: reply.shares, next: typeof reply.next === "string" ? reply.next : null };
}

/** A site manager's offers and accepted items, each list with its own `next`. */
export interface SiteShares {
  readonly offered: PageOf<IncomingShare>;
  readonly accepted: PageOf<IncomingShare>;
}

function siteSharesOf(reply: {
  shares: IncomingShare[];
  next?: { offered?: string | null; accepted?: string | null };
}): SiteShares {
  const cursor = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    offered: {
      shares: reply.shares.filter((s) => s.state === "offered"),
      next: cursor(reply.next?.offered),
    },
    accepted: {
      shares: reply.shares.filter((s) => s.state === "accepted"),
      next: cursor(reply.next?.accepted),
    },
  };
}

/**
 * The page of one of a site's lists after `before` (S-036a), a page's
 * `next`: the manager's offers or accepted items, or anyone's accepted items.
 */
export async function nextSharePage(
  siteId: string,
  list: "offered" | "accepted" | "items",
  before: string,
): Promise<PageOf<IncomingShare>> {
  const site = encodeURIComponent(siteId);
  const after = encodeURIComponent(before);
  if (list === "items") {
    return pageOf(
      await api<{ shares: IncomingShare[]; next?: string | null }>(
        `/api/sites/${site}/shared-items?before=${after}`,
        { site: siteId },
      ),
    );
  }
  const page = siteSharesOf(
    await api<{
      shares: IncomingShare[];
      next?: { offered?: string | null; accepted?: string | null };
    }>(`/api/sites/${site}/share-offers?state=${list}&before=${after}`, { site: siteId }),
  );
  return page[list];
}

/** A record's shares after `before` (S-036a). */
export async function nextRecordSharesPage(
  siteId: string,
  recordId: string,
  before: string,
): Promise<PageOf<ShareSummary>> {
  return pageOf(
    await api<{ shares: ShareSummary[]; next?: string | null }>(
      `/api/records/${encodeURIComponent(recordId)}/shares?before=${encodeURIComponent(before)}`,
      { site: siteId },
    ),
  );
}

export type ShareMove = "accept" | "decline" | "remove" | "withdraw";

/** Makes one move on a share; the caller refreshes what it shows. */
export async function moveShare(siteId: string, shareId: string, move: ShareMove) {
  return (
    await api<{ share: ShareSummary }>(`/api/shares/${encodeURIComponent(shareId)}/${move}`, {
      method: "POST",
      body: {},
      site: siteId,
    })
  ).share;
}

/** After any move: every list of shares may have changed. */
export async function refreshShares(queries: QueryClient, siteId: string, recordId?: string) {
  await queries.invalidateQueries({ queryKey: siteSharesKey(siteId) });
  if (recordId !== undefined) {
    await queries.invalidateQueries({ queryKey: recordSharesKey(recordId) });
  }
}
