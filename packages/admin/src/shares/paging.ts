/**
 * Later pages of a share list (S-036a). The first page comes from the Query
 * cache; "Show more" asks for the page after the server's `next` (the last
 * share it read, shown or not, so shares it leaves out never stop the
 * paging). Later pages are dropped whenever the first page is fetched again
 * (a move, a refetch on focus), so a list never mixes moments, and a share
 * is never listed twice.
 */
import { useState } from "react";

export interface PageOf<T> {
  readonly shares: readonly T[];
  readonly next: string | null;
}

export function useMorePages<T extends { readonly id: string }>(
  first: PageOf<T> | undefined,
  firstFetchedAt: number,
  fetchPage: (before: string) => Promise<PageOf<T>>,
) {
  const [more, setMore] = useState<{ at: number; rows: T[]; next: string | null }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  // Pages loaded after an older first page are stale: show only the first page.
  const extra = more?.at === firstFetchedAt ? more : undefined;
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const row of [...(first?.shares ?? []), ...(extra?.rows ?? [])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const next = extra === undefined ? (first?.next ?? null) : extra.next;

  async function loadMore(): Promise<number> {
    if (next === null || loading) return 0;
    setLoading(true);
    setError(undefined);
    try {
      const page = await fetchPage(next);
      setMore({
        at: firstFetchedAt,
        rows: [...(extra?.rows ?? []), ...page.shares],
        next: page.next,
      });
      return page.shares.length;
    } catch (failure) {
      setError(failure);
      return 0;
    } finally {
      setLoading(false);
    }
  }

  return { rows, next, loadMore, loading, error };
}
