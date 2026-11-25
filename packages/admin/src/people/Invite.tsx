/**
 * Inviting someone to the organization (T-048; system managers). The link
 * goes only to the address invited (D-068): this screen never sees it.
 */
import { useState, type SubmitEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Field, Note, TextLink } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { useReauthenticated } from "./Reauth";
import styles from "./People.module.css";
import { PEOPLE_KEY, refused, usePeople } from "./shared";
import { when } from "./types";

export function Invite() {
  const people = usePeople();
  const queries = useQueryClient();
  const reauth = useReauthenticated();
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();

  if (people.data !== undefined && !people.data.rights.manageAccounts) {
    return (
      <>
        <h1 className={frame.pageTitle}>Invite someone</h1>
        <Note tone="amber">Only system managers can invite people.</Note>
      </>
    );
  }
  if (refused(people.error)) {
    return (
      <>
        <h1 className={frame.pageTitle}>Invite someone</h1>
        <Note tone="amber">Only system managers can invite people.</Note>
      </>
    );
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    try {
      await reauth.run(async () => {
        try {
          const sent = await api<{ email: string; expiresAt: string }>("/api/invitations", {
            body: { email: email.trim(), expiresInDays: Number(days) },
          });
          setEmail("");
          setStatus({
            tone: "green",
            text: `An invitation is on its way to ${sent.email}. It works until ${when(sent.expiresAt)}.`,
          });
          await queries.invalidateQueries({ queryKey: PEOPLE_KEY });
        } catch (error) {
          if (error instanceof ApiError && error.code === "reauthentication_required") throw error;
          setStatus({ tone: "amber", text: inviteProblem(error) });
        }
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1 className={frame.pageTitle}>Invite someone</h1>
        <p className={frame.lead}>
          They get an email with a link to join this organization. Give them roles once they have
          joined.
        </p>
      </div>
      {reauth.form}
      <form
        className={styles.panel}
        aria-label="Invitation"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="Their email address"
          name="email"
          type="email"
          autoComplete="off"
          value={email}
          onChange={setEmail}
          isRequired
        />
        <div className={styles.label}>
          <label htmlFor="invite-life">The link works for</label>
          <select
            id="invite-life"
            className={styles.select}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          >
            {[1, 3, 7, 14].map((d) => (
              <option key={d} value={String(d)}>
                {d === 1 ? "1 day" : `${String(d)} days`}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" isDisabled={busy || email.trim() === ""}>
            Send the invitation
          </Button>
        </div>
        <div aria-live="polite">
          {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
        </div>
      </form>
      <TextLink href="/people">Back to people</TextLink>
    </>
  );
}

function inviteProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return problemText(error);
  switch (error.code) {
    case "already_member":
      return "That person is already in this organization.";
    case "invalid":
      return "That isn't an email address Oculus accepts.";
    case "not_permitted":
      return "Only system managers can invite people.";
    case "delivery_failed":
    case "delivery_failed_may_be_pending":
      return "The email couldn't be sent, so the invitation was withdrawn. Try again.";
    case "delivery_unavailable":
      return "Oculus can't send email yet, so nobody can be invited.";
    case "superseded":
      return "A newer invitation to that address was sent meanwhile; that one works.";
    default:
      return problemText(error);
  }
}
