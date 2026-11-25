/**
 * "View public site" (T-070, D-109): opens the site's public home page in a
 * new tab, exactly as a visitor reaches it. The address is the one the
 * server checked at startup (`GET /api/me`'s `publicOrigin`), reduced here
 * to its bare origin, so nothing of the session, the admin or the page
 * goes with it: no query, no fragment, `rel="noopener noreferrer"` (no
 * `window.opener`, no Referer). A site with no public address shows the
 * button disabled with the reason, rather than hiding it.
 */
import styles from "./Frame.module.css";

/** The site's public home address (`<origin>/`), or undefined when the value isn't a bare http(s) origin. */
export function publicHomeAddress(origin: string | null | undefined): string | undefined {
  if (typeof origin !== "string" || origin === "") return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.origin !== origin) return undefined;
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

export const NO_PUBLIC_ADDRESS = "This site has no public address yet";

export function ViewPublicSite(props: {
  readonly siteId: string;
  readonly siteName: string;
  readonly publicOrigin: string | null | undefined;
  /** Sidebar (dark) or a settings row (light). */
  readonly place: "sidebar" | "settings";
}) {
  const address = publicHomeAddress(props.publicOrigin);
  const className = props.place === "sidebar" ? styles.publicLink : styles.publicLinkLight;
  const noneClass = props.place === "sidebar" ? styles.publicNone : styles.publicNoneLight;
  const label =
    props.place === "settings" ? `View the public site of ${props.siteName}` : undefined;
  if (address === undefined) {
    return (
      <span className={noneClass}>
        <button
          type="button"
          className={`${className} ${styles.publicDisabled}`}
          disabled
          aria-describedby={`no-public-${props.place}-${props.siteId}`}
          {...(label === undefined ? {} : { "aria-label": label })}
        >
          View public site
        </button>
        <span id={`no-public-${props.place}-${props.siteId}`} className={styles.publicReason}>
          {NO_PUBLIC_ADDRESS}
        </span>
      </span>
    );
  }
  return (
    <a
      className={className}
      href={address}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      {...(label === undefined ? {} : { "aria-label": `${label} (opens in a new tab)` })}
    >
      View public site
      {label === undefined ? <span className="visually-hidden"> (opens in a new tab)</span> : null}
    </a>
  );
}
