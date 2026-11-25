/**
 * Later pages of a share list (S-036a). The first page comes from the Query
 * cache; "Show more" asks for the page after the server's `next` (the last
 * share it read, shown or not, so shares it leaves out never stop the
 * paging). Later pages are dropped whenever the first page is fetched again
 * (a move, a refetch on focus), so a list never mixes moments, and a share
 * is never listed twice.
 */
import { useRef, useState } from "react";

export interface PageOf<T> {
  readonly shares: readonly T[];
  readonly next: string | null;
}

/** What one "Show more" did: how many new shares it showed, and whether more may follow. */
export interface MoreResult {
  readonly added: number;
  readonly more: boolean;
}

export function useMorePages<T extends { readonly id: string }>(
  first: PageOf<T> | undefined,
  firstFetchedAt: number,
  fetchPage: (before: string) => Promise<PageOf<T>>,
) {
  const [more, setMore] = useState<{ at: number; rows: T[]; next: string | null }>();
  const [failure, setFailure] = useState<{ at: number; error: unknown }>();
  const [loading, setLoading] = useState(false);
  // A ref, not only state: a second press before the re-render must not send twice.
  const asking = useRef(false);
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
  const error = failure?.at === firstFetchedAt ? failure.error : undefined;

  async function loadMore(): Promise<MoreResult> {
    if (next === null || asking.current) return { added: 0, more: next !== null };
    asking.current = true;
    setLoading(true);
    setFailure(undefined);
    const at = firstFetchedAt;
    try {
      const page = await fetchPage(next);
      const added = page.shares.filter((row) => !seen.has(row.id)).length;
      setMore((now) =>
        // The first page changed meanwhile: this page belongs to the old one.
        now !== undefined && now.at !== at
          ? now
          : { at, rows: [...(now?.at === at ? now.rows : []), ...page.shares], next: page.next },
      );
      return { added, more: page.next !== null };
    } catch (error) {
      setFailure({ at, error });
      return { added: 0, more: true };
    } finally {
      asking.current = false;
      setLoading(false);
    }
  }

  return { rows, next, loadMore, loading, error };
}

/** Words for what a "Show more" did, for a polite live region. */
export function moreText(result: MoreResult, what: string): string {
  if (result.added > 0) {
    return `Showing ${String(result.added)} more ${what}.${result.more ? "" : ` That's all of them.`}`;
  }
  return result.more
    ? `None of the next ${what} can be shown here. Show more looks further.`
    : `No more ${what} to show.`;
}
