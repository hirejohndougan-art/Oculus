/**
 * Waiting for review (T-046, D-082's approval queue): records sent for
 * review on the sites where the person may publish, a page at a time. Only
 * people who may publish get the list; the server decides, and anyone
 * else is told so.
 */
import { useState } from "react";
import { ApiError, problemText } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import type { SiteChoice } from "../types";
import { KIND_LABELS, recordPath, whenText } from "./model";
import { useReviewQueue } from "./queries";
import styles from "./Records.module.css";

export function ReviewQueue(props: {
  readonly siteId: string;
  readonly sites: readonly SiteChoice[];
}) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const queue = useReviewQueue(props.siteId, pages.at(-1));
  const siteName = (id: string | null) =>
    id === null
      ? "No site"
      : (props.sites.find((s) => s.siteId === id)?.siteName ?? "Another site");
  const records = queue.data?.records ?? [];

  return (
    <>
      <div>
        <h1 className={styles.pageTitle}>Waiting for review</h1>
        <p className={styles.lead}>
          Records someone has sent for review. Open one, check it, then publish it or return it to
          draft.
        </p>
      </div>
      <div aria-live="polite" aria-busy={queue.isFetching}>
        {queue.isPending ? (
          <p role="status">Loading the records waiting for review…</p>
        ) : queue.isError ? (
          queue.error instanceof ApiError && queue.error.status === 403 ? (
            <Note tone="blue">
              Only people who may publish see this list. Your records are under Item records.
            </Note>
          ) : (
            <div className={styles.actions}>
              <Note tone="amber" alert>
                The list couldn't be loaded. {problemText(queue.error)}
              </Note>
              <Button
                variant="secondary"
                onPress={() => {
                  void queue.refetch();
                }}
              >
                Load the list again
              </Button>
            </div>
          )
        ) : records.length === 0 ? (
          <div className={styles.empty}>
            <p>Nothing is waiting for review.</p>
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Records waiting for review, page {String(pages.length)}</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Site</th>
                  <th scope="col">Last changed</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const href = recordPath(props.siteId, r.id);
                  return (
                    <tr key={r.id}>
                      <td>
                        {href === undefined ? r.title : <TextLink href={href}>{r.title}</TextLink>}
                      </td>
                      <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
                      <td>{siteName(r.siteId)}</td>
                      <td>{whenText(r.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pages.length > 1 || (queue.data?.next ?? null) !== null ? (
        <nav className={styles.pager} aria-label="Pages">
          <Button
            variant="secondary"
            isDisabled={pages.length <= 1}
            onPress={() => {
              setPages(pages.slice(0, -1));
            }}
          >
            Previous page
          </Button>
          <Button
            variant="secondary"
            isDisabled={(queue.data?.next ?? null) === null}
            onPress={() => {
              const next = queue.data?.next ?? undefined;
              if (next !== undefined) setPages([...pages, next]);
            }}
          >
            Next page
          </Button>
        </nav>
      ) : null}
    </>
  );
}
