/**
 * One person (T-048): their roles (grant, revoke), and for system managers
 * their sessions, two-step sign-in, password reset link and account. Each
 * action shows only where the person's rights allow it; the server decides
 * again. Dangerous actions open an in-page confirmation; changes the
 * server wants a fresh password entry for open the re-entry form in place.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext, useParams } from "react-router";
import { ApiError, api, problemText } from "../api";
import { Button, Field, Note, TextLink } from "../components/ui";
import type { FrameContext } from "../frame/Frame";
import frame from "../frame/Frame.module.css";
import styles from "./People.module.css";
import { useReauthenticated } from "./Reauth";
import { Confirm, PEOPLE_KEY, grantText, siteNames, useRoles } from "./shared";
import { when, type Grant, type PersonDetail } from "./types";

type Open = "disable" | "enable" | "sessions" | "two-step" | "password" | `revoke:${string}`;

export function Person() {
  const { me } = useOutletContext<FrameContext>();
  const { userId = "" } = useParams();
  const queries = useQueryClient();
  const key = ["person", userId] as const;
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<PersonDetail>(`/api/people/${encodeURIComponent(userId)}`),
  });
  const roles = useRoles();
  const reauth = useReauthenticated();
  const [open, setOpen] = useState<Open>();
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [adminCode, setAdminCode] = useState("");
  const [confirmedIdentity, setConfirmedIdentity] = useState(false);
  const [newRole, setNewRole] = useState("");
  const [newSite, setNewSite] = useState("");
  const sites = siteNames(me);

  if (detail.error !== null) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <>
        <h1 className={frame.pageTitle}>{missing ? "No such person" : "Person"}</h1>
        <Note tone="amber">
          {missing ? "There is no such person you can see here." : problemText(detail.error)}
        </Note>
        <TextLink href="/people">Back to people</TextLink>
      </>
    );
  }
  if (detail.data === undefined) return <p role="status">Loading…</p>;
  const { person, rights, sessions, secondStep } = detail.data;

  /** Runs a change, says what happened, reloads the person; asks for re-entry when needed. */
  async function act(change: () => Promise<string>) {
    setBusy(true);
    setStatus(undefined);
    try {
      await reauth.run(async () => {
        try {
          const text = await change();
          setOpen(undefined);
          setStatus({ tone: "green", text });
          await queries.invalidateQueries({ queryKey: key });
          await queries.invalidateQueries({ queryKey: PEOPLE_KEY });
        } catch (error) {
          if (error instanceof ApiError && error.code === "reauthentication_required") throw error;
          setStatus({ tone: "amber", text: describe(error) });
        }
      });
    } finally {
      setBusy(false);
    }
  }

  const mayRevoke = (g: Grant) =>
    rights.manageAccounts ||
    (g.siteId !== null && g.role !== "site_manager" && rights.manageSites.includes(g.siteId));
  const grantSites: [string, string][] = rights.manageAccounts
    ? [...sites.entries()]
    : rights.manageSites.map((s) => [s, sites.get(s) ?? "A site you manage"]);
  const grantable = (roles.data ?? []).filter((r) => r.grantable);
  const path = `/api/people/${encodeURIComponent(person.userId)}`;

  return (
    <>
      <div>
        <h1 className={frame.pageTitle}>{person.displayName}</h1>
        <p className={frame.lead}>
          {person.email}
          {person.disabled ? (
            <span className={`${styles.pill} ${styles.pillRed}`}> Disabled</span>
          ) : null}
          {person.systemAdmin === true ? (
            <span className={styles.pill}> System manager</span>
          ) : null}
        </p>
        <p className={styles.muted}>
          Member since {when(person.addedAt)}. Last signed in {when(person.lastSignInAt)}.
        </p>
      </div>
      <div aria-live="polite">
        {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
      </div>
      {reauth.form}

      <section className={styles.panel} aria-labelledby="roles-title">
        <h2 id="roles-title" className={styles.panelTitle}>
          Roles
        </h2>
        {person.roles.length === 0 ? (
          <p className={styles.muted}>No roles you can see.</p>
        ) : (
          <ul className={styles.list}>
            {person.roles.map((g) => (
              <li key={g.id} className={styles.listItem}>
                <span>{grantText(g, sites)}</span>
                {mayRevoke(g) ? (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setOpen(`revoke:${g.id}`);
                    }}
                  >
                    Remove…
                  </Button>
                ) : null}
                {open === `revoke:${g.id}` ? (
                  <Confirm
                    id={`revoke-${g.id}`}
                    title={`Remove ${grantText(g, sites)}?`}
                    confirmLabel="Remove the role"
                    isDisabled={busy}
                    onCancel={() => {
                      setOpen(undefined);
                    }}
                    onConfirm={() =>
                      void act(async () => {
                        await api(`/api/role-assignments/${encodeURIComponent(g.id)}`, {
                          method: "DELETE",
                        });
                        return "The role was removed.";
                      })
                    }
                  >
                    <p>They lose what this role lets them do at once.</p>
                  </Confirm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {grantable.length > 0 && grantSites.length + (rights.manageAccounts ? 1 : 0) > 0 ? (
          <form
            className={styles.form}
            aria-label="Give a role"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await api(`${path}/roles`, {
                  body: { role: newRole, siteId: newSite === "*" ? null : newSite, scope: null },
                });
                setNewRole("");
                return "The role was given.";
              });
            }}
          >
            <div className={styles.label}>
              <label htmlFor="grant-role">Role</label>
              <select
                id="grant-role"
                className={styles.select}
                value={newRole}
                onChange={(event) => {
                  setNewRole(event.target.value);
                }}
              >
                <option value="">Choose a role</option>
                {grantable.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.label}>
              <label htmlFor="grant-site">Site</label>
              <select
                id="grant-site"
                className={styles.select}
                value={newSite}
                onChange={(event) => {
                  setNewSite(event.target.value);
                }}
              >
                <option value="">Choose a site</option>
                {grantSites.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
                {rights.manageAccounts ? <option value="*">Every site</option> : null}
              </select>
            </div>
            <div>
              <Button
                type="submit"
                variant="primary"
                isDisabled={busy || newRole === "" || newSite === ""}
              >
                Give the role
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      {rights.manageAccounts && secondStep !== undefined ? (
        <section className={styles.panel} aria-labelledby="two-step-title">
          <h2 id="two-step-title" className={styles.panelTitle}>
            Two-step sign-in
          </h2>
          <p>
            {secondStep.inUse
              ? `Set up ${when(secondStep.enrolledAt)}.`
              : "Not in use: never set up, or reset and not set up again yet."}
          </p>
          {secondStep.recentAlerts > 0 ? (
            <Note tone="amber">
              Someone typed wrong codes for this account {String(secondStep.recentAlerts)}{" "}
              {secondStep.recentAlerts === 1 ? "time" : "times"} in the last 30 days (last{" "}
              {when(secondStep.lastAlertAt)}). If it wasn't them, their password may be known to
              someone else.
            </Note>
          ) : null}
          {secondStep.alerts !== undefined && secondStep.alerts.length > 0 ? (
            <ul aria-label="Recent wrong-code alerts">
              {secondStep.alerts.map((a) => (
                <li key={`${a.at}-${String(a.failures)}`}>
                  {when(a.at)}: {String(a.failures)} wrong {a.failures === 1 ? "code" : "codes"}
                  {", "}
                  {a.notice === "emailed"
                    ? "emailed to them and the system managers"
                    : a.notice === "covered"
                      ? "covered by an earlier email"
                      : "email not sent yet"}
                </li>
              ))}
            </ul>
          ) : null}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setAdminCode("");
                setOpen("two-step");
              }}
            >
              Reset two-step sign-in…
            </Button>
          </div>
          {open === "two-step" ? (
            <Confirm
              id="two-step"
              title="Reset their two-step sign-in?"
              confirmLabel="Reset two-step sign-in"
              isDisabled={busy || adminCode.trim() === ""}
              onCancel={() => {
                setOpen(undefined);
              }}
              onConfirm={() =>
                void act(async () => {
                  const typed = adminCode.trim();
                  const reply = await api<{ delivered: boolean; ended: number }>(
                    `${path}/reset-two-step`,
                    { body: /^\d{6}$/.test(typed) ? { code: typed } : { recoveryCode: typed } },
                  );
                  setAdminCode("");
                  return reply.delivered
                    ? "Two-step sign-in was reset. They are signed out everywhere, and a set-up code is on its way to their email."
                    : "Two-step sign-in was reset and they are signed out, but the email didn't go. Reset again to send a new one.";
                })
              }
            >
              <p>
                Their authenticator and recovery codes stop working and they are signed out
                everywhere. They set it up again with a one-time code sent to their email.
              </p>
              <Field
                label="Your own code (from your app), or one of your recovery codes"
                name="admin-code"
                autoComplete="one-time-code"
                value={adminCode}
                onChange={setAdminCode}
              />
            </Confirm>
          ) : null}
        </section>
      ) : null}

      {rights.manageAccounts && secondStep !== undefined ? (
        <section className={styles.panel} aria-labelledby="password-title">
          <h2 id="password-title" className={styles.panelTitle}>
            Password
          </h2>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setConfirmedIdentity(false);
                setOpen("password");
              }}
            >
              Send a password reset link…
            </Button>
          </div>
          {open === "password" ? (
            <Confirm
              id="password"
              title="Send them a password reset link?"
              confirmLabel="Send the link"
              isDisabled={busy || (!secondStep.inUse && !confirmedIdentity)}
              onCancel={() => {
                setOpen(undefined);
              }}
              onConfirm={() =>
                void act(async () => {
                  await api(`${path}/password-reset`, {
                    body: secondStep.inUse ? {} : { confirmMailboxOnly: true },
                  });
                  return "A reset link is on its way to their email. It works for 30 minutes.";
                })
              }
            >
              <p>The link goes to their own email address; you never see it.</p>
              {secondStep.inUse ? null : (
                <>
                  <Note tone="amber">
                    This person has no two-step sign-in in use. Whoever reads their mailbox could
                    choose a new password and set up two-step sign-in themselves, and so take over
                    the account. Confirm who they are another way first, for example by phone or in
                    person.
                  </Note>
                  <label className={styles.checkLabel}>
                    <input
                      className={styles.check}
                      type="checkbox"
                      checked={confirmedIdentity}
                      onChange={(event) => {
                        setConfirmedIdentity(event.target.checked);
                      }}
                    />
                    I have confirmed who they are another way
                  </label>
                </>
              )}
            </Confirm>
          ) : null}
        </section>
      ) : null}

      {rights.manageAccounts && sessions !== undefined ? (
        <section className={styles.panel} aria-labelledby="sessions-title">
          <h2 id="sessions-title" className={styles.panelTitle}>
            Sessions
          </h2>
          {sessions.length === 0 ? (
            <p className={styles.muted}>Not signed in anywhere.</p>
          ) : (
            <ul className={styles.list}>
              {sessions.map((s) => (
                <li key={s.sessionId} className={styles.listItem}>
                  <span>
                    {s.label ?? "A browser"}
                    {s.stage === "second_step" ? " (waiting for a code)" : ""}
                  </span>
                  <span className={styles.muted}>
                    Signed in {when(s.signedInAt)}, last used {when(s.lastSeenAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setOpen("sessions");
              }}
            >
              Sign them out everywhere…
            </Button>
          </div>
          {open === "sessions" ? (
            <Confirm
              id="sessions"
              title="Sign them out everywhere?"
              confirmLabel="Sign them out"
              isDisabled={busy}
              onCancel={() => {
                setOpen(undefined);
              }}
              onConfirm={() =>
                void act(async () => {
                  const reply = await api<{ ended: number }>(`${path}/end-sessions`, { body: {} });
                  return `Signed out of ${String(reply.ended)} ${reply.ended === 1 ? "session" : "sessions"}.`;
                })
              }
            >
              <p>Every session they have ends now, in every organization.</p>
            </Confirm>
          ) : null}
        </section>
      ) : null}

      {rights.manageAccounts ? (
        <section className={styles.panel} aria-labelledby="account-title">
          <h2 id="account-title" className={styles.panelTitle}>
            Account
          </h2>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setOpen(person.disabled ? "enable" : "disable");
              }}
            >
              {person.disabled ? "Enable the account…" : "Disable the account…"}
            </Button>
          </div>
          {open === "disable" || open === "enable" ? (
            <Confirm
              id="account"
              title={open === "disable" ? "Disable this account?" : "Enable this account?"}
              confirmLabel={open === "disable" ? "Disable the account" : "Enable the account"}
              isDisabled={busy}
              onCancel={() => {
                setOpen(undefined);
              }}
              onConfirm={() =>
                void act(async () => {
                  const disabling = open === "disable";
                  await api(`${path}/${disabling ? "disable" : "enable"}`, { body: {} });
                  return disabling
                    ? "The account is disabled and signed out everywhere."
                    : "The account is enabled. They sign in again.";
                })
              }
            >
              <p>
                {open === "disable"
                  ? "They can't sign in to any organization, and every session ends now. Their roles stay."
                  : "They can sign in again with their password and two-step sign-in."}
              </p>
            </Confirm>
          ) : null}
        </section>
      ) : null}
      <TextLink href="/people">Back to people</TextLink>
    </>
  );
}

/** The sentence for a refused change. */
function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return problemText(error);
  switch (error.code) {
    case "not_permitted":
      return "You can't make that change.";
    case "not_found":
      return "That person or role isn't there any more. Reload the page.";
    case "last_system_manager":
      return "This is the last active system manager, so the account stays enabled.";
    case "already_granted":
      return "They already have that role there.";
    case "invalid_code":
      return "That code isn't right. Use a new code from your app, or a recovery code.";
    case "delivery_failed":
    case "delivery_failed_may_be_pending":
      return "The email couldn't be sent. Try again.";
    case "delivery_unavailable":
      return "Oculus can't send email yet, so this can't be done.";
    case "account_disabled":
      return "The account is disabled. Enable it first.";
    case "invalid": {
      const issues = error.body.issues;
      const first = Array.isArray(issues)
        ? (issues[0] as { message?: unknown } | undefined)
        : undefined;
      return typeof first?.message === "string" ? first.message : "Check the form and try again.";
    }
    default:
      return problemText(error);
  }
}
