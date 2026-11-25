/**
 * The accession register (T-073; mockup Accessions): every accession of the
 * organization, newest first, with a filter by deed and restriction. An
 * accession is one arrival (a box of donated materials) logged before its
 * items are cataloged; it keeps the chain of custody from donor to shelf.
 */
import { useState } from "react";
import { Note, TextLink } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { dayText, deedHolds, methodLabel, restrictionText, type AccessionView } from "./model";
import { useRegister } from "./queries";
import { DeedPill, Loading, Refused } from "./shared";
import styles from "./Intake.module.css";

const FILTERS: readonly (readonly [string, string, (v: AccessionView) => boolean])[] = [
  ["all", "All", () => true],
  ["deed", "Deed not signed", (v) => deedHolds(v.accession.deedStatus)],
  ["restricted", "Restricted", (v) => v.accession.accessRestriction !== undefined],
  ["unlinked", "No records yet", (v) => v.accession.records.length === 0],
];

/** The first line of a long text, cut to `max` characters. */
export function shortText(text: string, max = 90): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function Accessions() {
  const register = useRegister();
  const [filter, setFilter] = useState("all");
  if (register.error !== null) return <Refused title="Accessions" error={register.error} />;
  if (register.data === undefined) return <Loading />;
  const test = FILTERS.find(([key]) => key === filter)?.[2] ?? (() => true);
  const shown = register.data.accessions.filter(test);
  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>Accessions</h1>
          <p className={frame.lead}>
            Log new arrivals here first: a box of donated materials is one accession, before you
            catalog the items inside. It keeps the chain of custody from donor to shelf.
          </p>
        </div>
        <TextLink href="/intake/accessions/new">Log an accession</TextLink>
      </div>
      {register.data.truncated ? (
        <Note tone="blue">Only the newest 5,000 accessions are listed.</Note>
      ) : null}
      <div className={styles.chips} role="group" aria-label="Filter this list">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={styles.chip}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className={styles.muted}>
          {register.data.accessions.length === 0
            ? "No accessions yet. Log the first one when materials arrive."
            : "No accessions match this filter."}
        </p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.muted}>
            {shown.length === 1 ? "1 accession" : `${String(shown.length)} accessions`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Accession</th>
              <th scope="col">Donor or source</th>
              <th scope="col">Received</th>
              <th scope="col">Materials</th>
              <th scope="col">Deed of gift</th>
              <th scope="col">Restriction</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ accession: a }) => (
              <tr key={a.id}>
                <td>
                  <TextLink href={`/intake/accessions/${a.id}`}>{a.number.value}</TextLink>
                </td>
                <td>{a.sourceAgent.label}</td>
                <td>
                  {dayText(a.receivedOn)}
                  <br />
                  <span className={styles.muted}>{methodLabel(a.method)}</span>
                </td>
                <td>{shortText(a.materials)}</td>
                <td>
                  <DeedPill status={a.deedStatus} />
                </td>
                <td>{restrictionText(a.accessRestriction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
