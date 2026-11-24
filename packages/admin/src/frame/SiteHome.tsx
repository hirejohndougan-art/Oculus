/**
 * A site's home page: an empty placeholder until the dashboard and the item
 * list arrive (T-046). A site the person can't open, or one of another
 * organization opened by its address, says so instead.
 */
import { useOutletContext, useParams } from "react-router";
import { Button, Note } from "../components/ui";
import type { FrameContext } from "./Frame";
import styles from "./Frame.module.css";

export function SiteHome() {
  const { me, chooseSite, switching } = useOutletContext<FrameContext>();
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
  return (
    <>
      <div>
        <h1 className={styles.pageTitle}>{site.siteName}</h1>
        <p className={styles.lead}>
          This is where {site.siteName}'s work will be listed: items to catalog, scans to attach and
          records waiting for review.
        </p>
      </div>
      <div className={styles.placeholder}>[The site's dashboard comes in a later update]</div>
    </>
  );
}
