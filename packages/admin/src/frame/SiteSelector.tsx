/**
 * The site selector under the Oculus name (D-019, D-072): only the sites the
 * person holds a role on (every site for a system manager), grouped by
 * organization. Choosing a site of another organization switches the
 * session to that organization first (a new session, D-069).
 */
import {
  Button as AriaButton,
  Header,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import type { SiteChoice } from "../types";
import styles from "./Frame.module.css";

export function SiteSelector(props: {
  readonly sites: readonly SiteChoice[];
  readonly current: string | undefined;
  readonly onChoose: (site: SiteChoice) => void;
  readonly isDisabled?: boolean;
}) {
  const groups = new Map<string, SiteChoice[]>();
  for (const site of props.sites) {
    const list = groups.get(site.organizationId) ?? [];
    list.push(site);
    groups.set(site.organizationId, list);
  }
  return (
    <Select
      className={styles.selector}
      value={props.current ?? null}
      placeholder="Choose a site"
      isDisabled={props.isDisabled ?? false}
      onChange={(key) => {
        const site = props.sites.find((s) => s.siteId === key);
        if (site !== undefined) props.onChoose(site);
      }}
    >
      <Label className={styles.selectorLabel}>Site</Label>
      <AriaButton className={styles.selectorButton}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </AriaButton>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox}>
          {[...groups.values()].map((list) => (
            <ListBoxSection key={list[0]?.organizationId} className={styles.section}>
              <Header className={styles.sectionHeader}>{list[0]?.organizationName}</Header>
              {list.map((site) => (
                <ListBoxItem
                  key={site.siteId}
                  id={site.siteId}
                  textValue={site.siteName}
                  className={styles.option}
                >
                  {site.siteName}
                </ListBoxItem>
              ))}
            </ListBoxSection>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
