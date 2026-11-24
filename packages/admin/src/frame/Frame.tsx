/**
 * The admin's frame (DESIGN.md §5, T-045): the dark sidebar with the Oculus
 * wordmark, the organization's name and the site selector; the white top bar
 * with the person and signing out; the page in between. Every screen after
 * sign-in sits inside it. A skip link jumps past the sidebar.
 */
import { useState } from "react";
import { Navigate, Outlet, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button as AriaButton,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import { ApiError, api, problemText, setCsrfToken } from "../api";
import { Button, Note } from "../components/ui";
import type { Me, SiteChoice } from "../types";
import styles from "./Frame.module.css";
import { SiteSelector } from "./SiteSelector";
import { ME_KEY, useMe } from "./useMe";

/** Up to two initials for the round account button. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((w) => Array.from(w ?? "")[0] ?? "")
    .join("")
    .toUpperCase();
}

export interface FrameContext {
  readonly me: Me;
  readonly chooseSite: (site: SiteChoice) => void;
  readonly switching: boolean;
}

export function Frame() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { siteId } = useParams();
  const me = useMe();
  const [status, setStatus] = useState<{
    tone: "green" | "amber";
    text: string;
    retry?: () => void;
  }>();
  const [switching, setSwitching] = useState(false);

  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/sign-in" replace />;
  }
  if (me.data === undefined) {
    return (
      <main className={styles.loading}>
        {me.error === null ? (
          <p role="status">Loading…</p>
        ) : (
          <Note tone="amber" alert>
            {problemText(me.error)}
          </Note>
        )}
      </main>
    );
  }
  const person = me.data;

  async function signOut() {
    // Signed out only when the server says so (or says there is no session
    // any more); otherwise the session is still alive, so say so and offer
    // to try again rather than pretend.
    try {
      await api("/api/sign-out", { body: {} });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setStatus({
          tone: "amber",
          text: `You are still signed in: ${problemText(error)}`,
          retry: () => void signOut(),
        });
        return;
      }
    }
    setStatus(undefined);
    setCsrfToken(null);
    queries.clear();
    await navigate("/sign-in", {
      replace: true,
      state: { notice: "You are signed out." },
    });
  }

  async function signOutOthers() {
    try {
      const reply = await api<{ ended: number }>("/api/sign-out/others", { body: {} });
      setStatus({
        tone: "green",
        text:
          reply.ended === 0
            ? "You weren't signed in anywhere else."
            : `Signed out of ${String(reply.ended)} other ${reply.ended === 1 ? "session" : "sessions"}. This one stays signed in.`,
      });
    } catch (error) {
      setStatus({ tone: "amber", text: problemText(error) });
    }
  }

  function chooseSite(site: SiteChoice) {
    if (site.organizationId === person.organizationId) {
      void navigate(`/sites/${site.siteId}`);
      return;
    }
    // Another organization: a new session there first (D-019, D-069).
    setSwitching(true);
    api("/api/organization", { body: { organizationId: site.organizationId } })
      .then(async () => {
        await queries.invalidateQueries({ queryKey: ME_KEY });
        await navigate(`/sites/${site.siteId}`);
      })
      .catch((error: unknown) => {
        setStatus({ tone: "amber", text: problemText(error) });
      })
      .finally(() => {
        setSwitching(false);
      });
  }

  const context: FrameContext = { me: person, chooseSite, switching };
  return (
    <div className={styles.frame}>
      <a className={styles.skip} href="#main">
        Skip to main content
      </a>
      <nav className={styles.sidebar} aria-label="Oculus">
        <div className={styles.brand}>
          <span className={styles.wordmark}>Oculus</span>
          <span className={styles.organization}>{person.organizationName}</span>
        </div>
        {person.sites.length > 0 ? (
          <SiteSelector
            sites={person.sites}
            current={siteId}
            onChoose={chooseSite}
            isDisabled={switching}
          />
        ) : null}
      </nav>
      <div className={styles.body}>
        <header className={styles.topbar}>
          <MenuTrigger>
            <AriaButton className={styles.account} aria-label={`Account: ${person.displayName}`}>
              <span className={styles.initials} aria-hidden="true">
                {initials(person.displayName)}
              </span>
              <span className={styles.accountName}>{person.displayName}</span>
            </AriaButton>
            <Popover className={styles.popover} placement="bottom end">
              <Menu
                className={styles.menu}
                onAction={(key) => {
                  if (key === "sign-out") void signOut();
                  if (key === "sign-out-others") void signOutOthers();
                }}
              >
                <MenuItem id="who" className={styles.menuInfo} isDisabled textValue={person.email}>
                  {person.email}
                </MenuItem>
                <Separator className={styles.separator} />
                <MenuItem id="sign-out" className={styles.menuItem}>
                  Sign out
                </MenuItem>
                <MenuItem id="sign-out-others" className={styles.menuItem}>
                  Sign out everywhere else
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          <div aria-live="polite">
            {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
            {status?.retry === undefined ? null : (
              <Button variant="secondary" onPress={status.retry}>
                Try again
              </Button>
            )}
          </div>
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
