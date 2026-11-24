/**
 * After sign-in (D-019): with exactly one site the person goes straight to
 * it; with several, they choose; with none, they are told whom to ask.
 */
import { useEffect, useRef } from "react";
import { Navigate, useOutletContext } from "react-router";
import { Button as AriaButton } from "react-aria-components";
import { Note } from "../components/ui";
import type { FrameContext } from "./Frame";
import styles from "./Frame.module.css";

export function Home() {
  const { me, chooseSite, switching } = useOutletContext<FrameContext>();
  const only = me.sites.length === 1 ? me.sites[0] : undefined;
  const elsewhere = only !== undefined && only.organizationId !== me.organizationId;

  const tried = useRef(false);
  useEffect(() => {
    // The only site is in another organization (a system manager signed in
    // to an organization with no sites): switch there, once; if that fails
    // the frame says why and the choice below stays.
    if (only !== undefined && elsewhere && !switching && !tried.current) {
      tried.current = true;
      chooseSite(only);
    }
  }, [only, elsewhere, switching, chooseSite]);

  if (only !== undefined && !elsewhere) return <Navigate to={`/sites/${only.siteId}`} replace />;

  return (
    <>
      <div>
        <h1 className={styles.pageTitle}>Choose a site</h1>
        <p className={styles.lead}>
          Each site keeps its own items. Choose the one to work in; you can change it at any time
          from the menu under “Oculus”.
        </p>
      </div>
      {me.sites.length === 0 ? (
        <Note tone="blue">
          You don't have a role on any site yet. Ask a system manager to give you one.
        </Note>
      ) : (
        <ul className={styles.cards} aria-label="Your sites">
          {me.sites.map((site) => (
            <li key={site.siteId}>
              <AriaButton
                className={styles.card}
                isDisabled={switching}
                onPress={() => {
                  chooseSite(site);
                }}
              >
                <span className={styles.cardTitle}>{site.siteName}</span>
                <span className={styles.cardLine}>{site.organizationName}</span>
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
