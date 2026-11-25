/**
 * The admin's frame (DESIGN.md §5, T-045): the dark sidebar with the Oculus
 * wordmark, the organization's name and the site selector; the white top bar
 * with the person and signing out; the page in between. Every screen after
 * sign-in sits inside it. A skip link jumps past the sidebar.
 */
import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button as AriaButton,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import { ApiError, api, problemText } from "../api";
import { forgetLists } from "../records/listMemory";
import { endSession, isSessionEnded } from "../session";
import { Button, Note } from "../components/ui";
import { AdminNav } from "../people/AdminNav";
import type { Me, SiteChoice } from "../types";
import styles from "./Frame.module.css";
import { SiteSelector } from "./SiteSelector";
import { useSiteAbilities } from "../records/queries";
import { ME_KEY, useMe } from "./useMe";
import { IdleGuard } from "../idle/IdleGuard";

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
  const signedIn = me.data;
  const here = signedIn?.sites.find(
    (s) => s.siteId === siteId && s.organizationId === signedIn.organizationId,
  );
  const abilities = useSiteAbilities(here?.siteId);
  const [status, setStatus] = useState<{
    tone: "green" | "amber";
    text: string;
    retry?: () => void;
  }>();
  const [switching, setSwitching] = useState(false);
  const ended = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    // The session ended on the server: forget everything of it before the
    // next person signs in here.
    if (ended || isSessionEnded(me.error)) endSession(queries);
  }, [ended, me.error, queries]);

  if (ended) {
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
    endSession(queries);
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
        // Another organization: none of the old one's templates, record
        // types, lists or records may stay in the cache. The person's own
        // query is refetched in place (its reply carries the new session's
        // CSRF token too).
        forgetLists();
        queries.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
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
        {here === undefined ? null : (
          <ul className={styles.navList}>
            <li>
              <NavLink className={styles.navLink} to={`/sites/${here.siteId}`} end>
                Item records
              </NavLink>
            </li>
            {abilities.data?.review === true ? (
              <li>
                <NavLink className={styles.navLink} to={`/sites/${here.siteId}/review`}>
                  Waiting for review
                </NavLink>
              </li>
            ) : null}
          </ul>
        )}
        <AdminNav />
        {person.systemAdmin ? (
          <div className={styles.navGroup}>
            <span className={styles.selectorLabel}>System</span>
            <ul className={styles.navList}>
              <li>
                <NavLink className={styles.navLink} to="/settings">
                  System settings
                </NavLink>
              </li>
            </ul>
          </div>
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
          {person.secondStepAlerts !== undefined && person.secondStepAlerts.recent > 0 ? (
            <Note tone="amber">
              Someone typed wrong two-step codes for your account{" "}
              {person.secondStepAlerts.recent === 1
                ? "once"
                : `${String(person.secondStepAlerts.recent)} times`}{" "}
              in the last 30 days
              {person.secondStepAlerts.lastAt === null
                ? ""
                : ` (last ${new Date(person.secondStepAlerts.lastAt).toLocaleString()})`}
              . If it wasn&apos;t you, your password may be known to someone else: sign out, choose
              a new password with &quot;Forgot your password?&quot; and tell your system manager.
            </Note>
          ) : null}
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
      {/* Signing out after a period of no use (T-062, D-098). */}
      <IdleGuard idleSeconds={person.idleSeconds ?? 1800} />
    </div>
  );
}
