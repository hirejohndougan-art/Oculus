/**
 * The screens of one site (T-046): its item records (the site's home page),
 * the approval queue, a record and a new record. A site the person can't
 * open, or one of another organization opened by its address, says so
 * instead; a record address that isn't a record ID is answered as a record
 * that doesn't exist, without asking the server. Items shared with the
 * site (T-041e) have a list and a read-only view of their own.
 */
import type { ReactNode } from "react";
import { useOutletContext, useParams } from "react-router";
import { Button, Note, TextLink } from "../components/ui";
import { ItemList } from "../records/ItemList";
import { isRecordId } from "../records/model";
import { NewRecordScreen, RecordScreen } from "../records/RecordEditor";
import { ReviewQueue } from "../records/ReviewQueue";
import { isId } from "../shares/model";
import { SharedItemScreen, SharedWithSite } from "../shares/SharedWithSite";
import type { SiteChoice } from "../types";
import type { FrameContext } from "./Frame";
import styles from "./Frame.module.css";

function SiteGuard(props: {
  readonly render: (site: SiteChoice, context: FrameContext) => ReactNode;
}) {
  const context = useOutletContext<FrameContext>();
  const { me, chooseSite, switching } = context;
  const { siteId } = useParams();
  const site = me.sites.find((s) => s.siteId === siteId);
  if (site === undefined) {
    return (
      <>
        <h1 className={styles.pageTitle}>Site not available</h1>
        <Note tone="amber">
          That site isn't one you can open. Choose one of yours from the menu.
        </Note>
      </>
    );
  }
  if (site.organizationId !== me.organizationId) {
    return (
      <>
        <h1 className={styles.pageTitle}>{site.siteName}</h1>
        <Note tone="blue">
          This site belongs to {site.organizationName}. Oculus keeps each organization's records
          apart, so you work in one at a time.
        </Note>
        <div>
          <Button
            variant="primary"
            isDisabled={switching}
            onPress={() => {
              chooseSite(site);
            }}
          >
            Work in {site.organizationName}
          </Button>
        </div>
      </>
    );
  }
  return <>{props.render(site, context)}</>;
}

/** `/sites/:siteId`: the site's item records. */
export function SiteHome() {
  return (
    <SiteGuard
      render={(site) => (
        <ItemList key={site.siteId} siteId={site.siteId} siteName={site.siteName} />
      )}
    />
  );
}

/** `/sites/:siteId/review`: records waiting for review. */
export function SiteReview() {
  return (
    <SiteGuard
      render={(site, { me }) => (
        <ReviewQueue key={site.siteId} siteId={site.siteId} sites={me.sites} />
      )}
    />
  );
}

/** `/sites/:siteId/records/new`. */
export function SiteNewRecord() {
  return (
    <SiteGuard
      render={(site, { me }) => (
        <NewRecordScreen key={site.siteId} siteId={site.siteId} userId={me.userId} />
      )}
    />
  );
}

/** `/sites/:siteId/records/:recordId`. */
export function SiteRecord() {
  const { recordId } = useParams();
  return (
    <SiteGuard
      render={(site, { me }) =>
        isRecordId(recordId) ? (
          <RecordScreen
            key={recordId}
            siteId={site.siteId}
            recordId={recordId}
            userId={me.userId}
          />
        ) : (
          <>
            <h1 className={styles.pageTitle}>Record not found</h1>
            <Note tone="amber">There is no such record, or it isn't one you can open.</Note>
            <TextLink href={`/sites/${site.siteId}`}>Back to item records</TextLink>
          </>
        )
      }
    />
  );
}

/** `/sites/:siteId/shared`: items other sites share with this one (T-041e). */
export function SiteShared() {
  return (
    <SiteGuard
      render={(site) => (
        <SharedWithSite
          key={site.siteId}
          siteId={site.siteId}
          siteName={site.siteName}
          organizationId={site.organizationId}
        />
      )}
    />
  );
}

/** `/sites/:siteId/shared/:shareId`: one shared item, read-only. */
export function SiteSharedItem() {
  const { shareId } = useParams();
  return (
    <SiteGuard
      render={(site) =>
        isId(shareId) ? (
          <SharedItemScreen key={shareId} siteId={site.siteId} shareId={shareId} />
        ) : (
          <>
            <h1 className={styles.pageTitle}>Shared item not found</h1>
            <Note tone="amber">
              There is no such shared item, or it isn't shared with this site any more.
            </Note>
            <TextLink href={`/sites/${site.siteId}/shared`}>Back to shared items</TextLink>
          </>
        )
      }
    />
  );
}
