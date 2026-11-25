/**
 * Items shared with a site (T-041e, D-094). Its manager sees offers waiting
 * for an answer (accept or decline), the items accepted (remove, asked
 * first), and the two IDs to give whoever wants to offer this site an item.
 * Anyone else who may see the whole of the site's catalog sees the accepted
 * items. Each item opens read-only, showing only what its home site's public
 * pages show, with its home site and organization named. The server decides
 * who sees what; a 403 is said in words.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, problemText } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import { ConfirmPanel } from "../records/controls";
import { KIND_LABELS, valueText, whenText } from "../records/model";
import styles from "../records/Records.module.css";
import { fieldLabel, homeText, isId, type IncomingShare } from "./model";
import {
  moveShare,
  refreshShares,
  useShareOffers,
  useSharedItem,
  useSharedItems,
  type ShareMove,
} from "./queries";

/** A record kind in words; only the admin's own labels, never a prototype key. */
function kindText(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? (KIND_LABELS[kind] ?? kind) : kind;
}

const ENDED: Readonly<Record<ShareMove, string>> = {
  accept: "That offer isn't open any more: its home site may have withdrawn it.",
  decline: "That offer isn't open any more: its home site may have withdrawn it.",
  remove: "That item isn't shared with this site any more: its home site may have withdrawn it.",
  withdraw: "That share had already ended.",
};

const DONE: Readonly<Record<ShareMove, string>> = {
  accept: "Accepted. The item is now listed under Shared with this site.",
  decline: "Declined. The other site sees that you said no.",
  remove: "Removed. This site no longer shows the item.",
  withdraw: "Withdrawn.",
};

function itemPath(siteId: string, shareId: string): string | undefined {
  return isId(siteId) && isId(shareId) ? `/sites/${siteId}/shared/${shareId}` : undefined;
}

function SharedTable(props: {
  readonly siteId: string;
  readonly caption: string;
  readonly shares: readonly IncomingShare[];
  readonly actions?: (share: IncomingShare) => ReactNode;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Kind</th>
            <th scope="col">From</th>
            <th scope="col">Offered</th>
            {props.actions === undefined ? null : <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {props.shares.map((share) => {
            const href = share.state === "accepted" ? itemPath(props.siteId, share.id) : undefined;
            return (
              <tr key={share.id}>
                <td>
                  {href === undefined ? (
                    share.item.title
                  ) : (
                    <TextLink href={href}>{share.item.title}</TextLink>
                  )}
                </td>
                <td>{kindText(share.item.kind)}</td>
                <td>{homeText(share.item)}</td>
                <td>{whenText(share.offeredAt)}</td>
                {props.actions === undefined ? null : (
                  <td className={styles.actions}>{props.actions(share)}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** `/sites/:siteId/shared`. */
export function SharedWithSite(props: {
  readonly siteId: string;
  readonly siteName: string;
  readonly organizationId: string;
}) {
  const queries = useQueryClient();
  const offers = useShareOffers(props.siteId);
  const notManager = offers.error instanceof ApiError && offers.error.status === 403;
  const items = useSharedItems(props.siteId, notManager);
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<IncomingShare>();

  // A ref, not only state: a second press before the re-render must not send twice.
  const moving = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The pressed button's row or the confirmation is gone: focus the result.
    if (status !== undefined) statusRef.current?.focus();
  }, [status]);

  async function move(share: IncomingShare, how: ShareMove) {
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    let result: { tone: "green" | "amber"; text: string };
    try {
      await moveShare(props.siteId, share.id, how);
      result = { tone: "green", text: DONE[how] };
    } catch (error) {
      result = {
        tone: "amber",
        text:
          error instanceof ApiError && (error.status === 404 || error.status === 422)
            ? ENDED[how]
            : problemText(error),
      };
    }
    // Buttons stay disabled until the lists show the move.
    await refreshShares(queries, props.siteId);
    setRemoving(undefined);
    setStatus(result);
    setBusy(false);
    moving.current = false;
  }

  const loadFailed = (error: unknown, retry: () => void) => (
    <div className={styles.actions}>
      <Note tone="amber" alert>
        The list couldn't be loaded. {problemText(error)}
      </Note>
      <Button variant="secondary" onPress={retry}>
        Load the list again
      </Button>
    </div>
  );

  let body: ReactNode;
  if (offers.isPending) {
    body = <p role="status">Loading the items shared with this site…</p>;
  } else if (offers.isSuccess) {
    const waiting = offers.data.filter((s) => s.state === "offered");
    const accepted = offers.data.filter((s) => s.state === "accepted");
    body = (
      <>
        <Note tone="blue">
          To be offered items, give the other site this site's ID, {props.siteId}, and this
          organization's ID, {props.organizationId}.
        </Note>
        <section className={styles.panel} aria-labelledby="offers-title">
          <h2 id="offers-title" className={styles.sectionTitle}>
            Waiting for your answer
          </h2>
          {waiting.length === 0 ? (
            <p>No offers are waiting.</p>
          ) : (
            <SharedTable
              siteId={props.siteId}
              caption="Offers waiting for an answer"
              shares={waiting}
              actions={(share) => (
                <>
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() => void move(share, "accept")}
                  >
                    Accept {share.item.title}
                  </Button>
                  <Button
                    variant="link"
                    isDisabled={busy}
                    onPress={() => void move(share, "decline")}
                  >
                    Decline {share.item.title}
                  </Button>
                </>
              )}
            />
          )}
        </section>
        <section className={styles.panel} aria-labelledby="accepted-title">
          <h2 id="accepted-title" className={styles.sectionTitle}>
            Shared with this site
          </h2>
          {accepted.length === 0 ? (
            <p>Nothing is shared with this site yet.</p>
          ) : (
            <SharedTable
              siteId={props.siteId}
              caption="Items shared with this site"
              shares={accepted}
              actions={(share) => (
                <Button
                  variant="link"
                  isDisabled={busy}
                  onPress={() => {
                    setRemoving(share);
                  }}
                >
                  Remove {share.item.title}
                </Button>
              )}
            />
          )}
        </section>
      </>
    );
  } else if (!notManager) {
    body = loadFailed(offers.error, () => void offers.refetch());
  } else if (items.isPending) {
    body = <p role="status">Loading the items shared with this site…</p>;
  } else if (items.isError) {
    body =
      items.error instanceof ApiError && items.error.status === 403 ? (
        <Note tone="blue">
          Only people who can see the whole of this site's catalog see the items shared with it.
        </Note>
      ) : (
        loadFailed(items.error, () => void items.refetch())
      );
  } else {
    body =
      items.data.length === 0 ? (
        <p>Nothing is shared with this site yet.</p>
      ) : (
        <SharedTable
          siteId={props.siteId}
          caption="Items shared with this site"
          shares={items.data}
        />
      );
  }

  return (
    <>
      <div>
        <h1 className={styles.pageTitle}>Shared with this site</h1>
        <p className={styles.lead}>
          Items other sites have shared with {props.siteName}. They stay their home site's: you see
          what its public pages show, read-only.
        </p>
      </div>
      <div ref={statusRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
      </div>
      <ConfirmPanel
        key={removing?.id ?? "closed"}
        isOpen={removing !== undefined}
        title="Remove this item from the site?"
        confirmLabel="Remove"
        danger
        busy={busy}
        onCancel={() => {
          setRemoving(undefined);
        }}
        onConfirm={() => {
          if (removing !== undefined) void move(removing, "remove");
        }}
      >
        <p>
          {removing?.item.title ?? ""} stops showing here. Its home site keeps it; to show it again,
          they would offer it again.
        </p>
      </ConfirmPanel>
      <div aria-busy={offers.isFetching || items.isFetching}>{body}</div>
    </>
  );
}

/** `/sites/:siteId/shared/:shareId`: one shared item, read-only. */
export function SharedItemScreen(props: { readonly siteId: string; readonly shareId: string }) {
  const share = useSharedItem(props.siteId, props.shareId);
  const back = <TextLink href={`/sites/${props.siteId}/shared`}>Back to shared items</TextLink>;
  if (share.isPending) return <p role="status">Loading the shared item…</p>;
  if (share.isError) {
    return (
      <>
        <h1 className={styles.pageTitle}>Shared item not found</h1>
        {share.error instanceof ApiError && share.error.status === 404 ? (
          <Note tone="amber">
            There is no such shared item, or it isn't shared with this site any more.
          </Note>
        ) : (
          <Note tone="amber" alert>
            The item couldn't be loaded. {problemText(share.error)}
          </Note>
        )}
        {back}
      </>
    );
  }
  // A share accepted into another of the person's sites isn't this site's.
  if (share.data.targetSiteId !== props.siteId || share.data.state !== "accepted") {
    return (
      <>
        <h1 className={styles.pageTitle}>Shared item not found</h1>
        <Note tone="amber">
          There is no such shared item, or it isn't shared with this site any more.
        </Note>
        {back}
      </>
    );
  }
  const item = share.data.item;
  const fields = Object.entries(item.fields).filter(([, v]) => valueText(v) !== "");
  return (
    <>
      <div>
        <h1 className={styles.pageTitle}>{item.title}</h1>
        <p className={styles.lead}>
          {kindText(item.kind)} shared by {homeText(item)}.
        </p>
      </div>
      <Note tone="blue">
        Read-only: this is what its home site's public pages show. Only its home site can change it.
      </Note>
      {fields.length === 0 ? (
        <p>Its public pages show no other fields.</p>
      ) : (
        <dl className={styles.grid}>
          {fields.map(([key, value]) => (
            <div key={key} className={styles.pair}>
              <dt>{fieldLabel(key)}</dt>
              <dd>{valueText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {back}
    </>
  );
}
