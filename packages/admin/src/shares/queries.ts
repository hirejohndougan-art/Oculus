/**
 * Server data for sharing (T-041e): a record's shares, a site's offers and
 * accepted items, and one shared item. The server decides every permission;
 * these only ask. Everything stays in the Query cache, in memory.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { IncomingShare, ShareSummary } from "./model";

export const recordSharesKey = (recordId: string) => ["record", recordId, "shares"] as const;
export const siteSharesKey = (siteId: string) => ["site-shares", siteId] as const;

export function useRecordShares(siteId: string, recordId: string, enabled: boolean) {
  return useQuery({
    queryKey: recordSharesKey(recordId),
    queryFn: async () =>
      (
        await api<{ shares: ShareSummary[] }>(
          `/api/records/${encodeURIComponent(recordId)}/shares`,
          { site: siteId },
        )
      ).shares,
    enabled,
  });
}

/** Offers and accepted items, for the site's manager (403 for anyone else). */
export function useShareOffers(siteId: string) {
  return useQuery({
    queryKey: [...siteSharesKey(siteId), "offers"],
    queryFn: async () =>
      (
        await api<{ shares: IncomingShare[] }>(
          `/api/sites/${encodeURIComponent(siteId)}/share-offers`,
          { site: siteId },
        )
      ).shares,
  });
}

/** Accepted items, for anyone who may see the whole of the site's catalog. */
export function useSharedItems(siteId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...siteSharesKey(siteId), "items"],
    queryFn: async () =>
      (
        await api<{ shares: IncomingShare[] }>(
          `/api/sites/${encodeURIComponent(siteId)}/shared-items`,
          { site: siteId },
        )
      ).shares,
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

/**
 * The next page of one of a site's lists (S-036a), after `before` (the last
 * share's ID shown): the manager's offers or accepted items, or anyone's
 * accepted items.
 */
export async function nextSharePage(
  siteId: string,
  list: "offered" | "accepted" | "items",
  before: string,
): Promise<IncomingShare[]> {
  const site = encodeURIComponent(siteId);
  const after = encodeURIComponent(before);
  const path =
    list === "items"
      ? `/api/sites/${site}/shared-items?before=${after}`
      : `/api/sites/${site}/share-offers?state=${list}&before=${after}`;
  return (await api<{ shares: IncomingShare[] }>(path, { site: siteId })).shares;
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
