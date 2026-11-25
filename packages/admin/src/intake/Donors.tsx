/**
 * Donors (T-073; mockup Donors): the people and organizations who gave
 * materials, with their accessions, and one donor's contact details (an
 * email, phone, address and note, kept for staff with the Donor relations
 * role only). The list is the source agents of the accession register.
 */
import { useState, type SubmitEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { ApiError, api, problemText } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { dayText, donorsOf, type DonorContact, type DonorContactView } from "./model";
import { contactKey, useContact, useRegister } from "./queries";
import { DeedPill, Loading, Refused } from "./shared";
import styles from "./Intake.module.css";

export function Donors() {
  const register = useRegister();
  if (register.error !== null) return <Refused title="Donors" error={register.error} />;
  if (register.data === undefined) return <Loading />;
  const donors = donorsOf(register.data.accessions);
  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>Donors</h1>
          <p className={frame.lead}>
            The people and organizations who have given materials, with every accession they made.
          </p>
        </div>
        <TextLink href="/intake/accessions/new">Log an accession</TextLink>
      </div>
      {donors.length === 0 ? (
        <p className={styles.muted}>No donors yet: they appear here with their first accession.</p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.muted}>
            {donors.length === 1 ? "1 donor" : `${String(donors.length)} donors`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Donor</th>
              <th scope="col">Accessions</th>
              <th scope="col">Last gift</th>
            </tr>
          </thead>
          <tbody>
            {donors.map((d) => (
              <tr key={d.agentId}>
                <td>
                  <TextLink href={`/intake/donors/${d.agentId}`}>{d.label}</TextLink>
                </td>
                <td>{d.accessions}</td>
                <td>{dayText(d.lastGift)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Note tone="blue">
        Contact details are seen only by staff with the Donor relations role, and by managers.
      </Note>
    </>
  );
}

const CONTACT_FIELDS = [
  ["email", "Email"],
  ["phone", "Phone"],
  ["address", "Address"],
  ["note", "Note"],
] as const;

type ContactForm = Record<(typeof CONTACT_FIELDS)[number][0], string>;

function formOfContact(c: DonorContact | undefined): ContactForm {
  return {
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    address: c?.address ?? "",
    note: c?.note ?? "",
  };
}

function contactProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return problemText(error);
  switch (error.code) {
    case "version_conflict":
      return "Someone else changed these details since you opened them. Reload the page and try again.";
    case "not_permitted":
      return "You can't change contact details for this donor.";
    case "not_found":
      return "This donor no longer exists, or you can't see them.";
    case "invalid":
      return "Check the details: give at least one of email, phone and address, and a valid email.";
    default:
      return problemText(error);
  }
}

export function Donor() {
  const { agentId = "" } = useParams();
  const register = useRegister();
  const contact = useContact(agentId);
  if (register.error !== null) return <Refused title="Donor" error={register.error} />;
  if (contact.error !== null) return <Refused title="Donor" error={contact.error} />;
  if (register.data === undefined || contact.data === undefined) return <Loading />;
  const gifts = register.data.accessions.filter(
    (v) => v.accession.sourceAgent.recordId === agentId,
  );
  const name = gifts[0]?.accession.sourceAgent.label ?? "Donor";
  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>{name}</h1>
          <p className={frame.lead}>How to reach this donor, and what they have given.</p>
        </div>
        <TextLink href="/intake/donors">Back to donors</TextLink>
      </div>
      <ContactPanel
        key={contact.data === null ? "none" : String(contact.data.version)}
        agentId={agentId}
        saved={contact.data}
      />
      <section className={styles.panel} aria-labelledby="gifts-title">
        <h2 className={styles.panelTitle} id="gifts-title">
          Accessions
        </h2>
        {gifts.length === 0 ? (
          <p className={styles.muted}>No accessions from this donor are listed.</p>
        ) : (
          <ul className={styles.list}>
            {gifts.map(({ accession: a }) => (
              <li key={a.id} className={styles.listItem}>
                <TextLink href={`/intake/accessions/${a.id}`}>{a.number.value}</TextLink>
                <span>{dayText(a.receivedOn)}</span>
                <DeedPill status={a.deedStatus} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ContactPanel(props: {
  readonly agentId: string;
  readonly saved: DonorContactView | null;
}) {
  const queries = useQueryClient();
  const [form, setForm] = useState<ContactForm>(formOfContact(props.saved?.contact));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const url = `/api/donor-contacts/${encodeURIComponent(props.agentId)}`;

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    try {
      const contact: Record<string, string> = {};
      for (const [key] of CONTACT_FIELDS) {
        const value = form[key].trim();
        if (value !== "") contact[key] = value;
      }
      const next = await api<DonorContactView>(url, {
        method: "PUT",
        body: { contact },
        ...(props.saved === null ? { ifNoneMatch: true } : { ifMatch: props.saved.version }),
      });
      queries.setQueryData(contactKey(props.agentId), next);
    } catch (error) {
      setStatus({ tone: "amber", text: contactProblem(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (props.saved === null) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await api(url, { method: "DELETE", ifMatch: props.saved.version });
      queries.setQueryData(contactKey(props.agentId), null);
    } catch (error) {
      setStatus({ tone: "amber", text: contactProblem(error) });
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.panel}
      aria-label="Contact details"
      onSubmit={(event) => void save(event)}
    >
      <h2 className={styles.panelTitle}>Contact details</h2>
      {props.saved === null ? (
        <p className={styles.muted}>No contact details are saved for this donor.</p>
      ) : null}
      <div className={styles.grid}>
        {CONTACT_FIELDS.map(([key, label]) =>
          key === "address" || key === "note" ? (
            <label key={key} className={styles.label}>
              {label}
              <textarea
                className={styles.textarea}
                name={key}
                maxLength={key === "address" ? 1000 : 4000}
                value={form[key]}
                onChange={(event) => {
                  setForm({ ...form, [key]: event.target.value });
                }}
              />
            </label>
          ) : (
            <label key={key} className={styles.label}>
              {label}
              <input
                className={styles.input}
                name={key}
                type={key === "email" ? "email" : "text"}
                autoComplete="off"
                maxLength={320}
                value={form[key]}
                onChange={(event) => {
                  setForm({ ...form, [key]: event.target.value });
                }}
              />
            </label>
          ),
        )}
      </div>
      <div aria-live="polite">
        {status === undefined ? null : (
          <Note tone={status.tone} alert>
            {status.text}
          </Note>
        )}
      </div>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" isDisabled={busy}>
          Save contact details
        </Button>
        {props.saved === null ? null : confirmDelete ? (
          <>
            <span>Forget these contact details?</span>
            <Button variant="secondary" isDisabled={busy} onPress={() => void remove()}>
              Yes, forget them
            </Button>
            <Button
              variant="link"
              onPress={() => {
                setConfirmDelete(false);
              }}
            >
              Keep them
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            onPress={() => {
              setConfirmDelete(true);
            }}
          >
            Forget contact details
          </Button>
        )}
      </div>
    </form>
  );
}
