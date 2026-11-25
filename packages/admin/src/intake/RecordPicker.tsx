/**
 * Picking a record for an accession (T-073): the donor (an agent record) or
 * the records cataloged from it (objects, archival units, digital assets).
 * Searching the catalog needs a role that may see records on the site
 * searched; anyone may instead give the record's ID and a label. The
 * service checks every record named when the accession is saved.
 */
import { useState } from "react";
import { useOutletContext } from "react-router";
import { ApiError, api, problemText } from "../api";
import { Button, Note } from "../components/ui";
import type { FrameContext } from "../frame/Frame";
import type { ListedRecord } from "../records/model";
import type { AccessionLink } from "./model";
import styles from "./Intake.module.css";

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function RecordPicker(props: {
  /** Names the picker: "donor" or "records". */
  readonly id: string;
  readonly kinds: readonly string[];
  readonly label: string;
  readonly onPick: (link: AccessionLink) => void;
}) {
  const { me } = useOutletContext<FrameContext>();
  const sites = me.sites.filter((s) => s.organizationId === me.organizationId);
  const [site, setSite] = useState(sites[0]?.siteId ?? "");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ListedRecord[]>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [byId, setById] = useState("");
  const [byIdLabel, setByIdLabel] = useState("");

  // No form of its own: the picker sits inside the accession's form.
  async function search() {
    if (query.trim() === "" || site === "") return;
    setBusy(true);
    setProblem(undefined);
    try {
      const reply = await api<{ records: ListedRecord[] }>(
        `/api/records?q=${encodeURIComponent(query.trim())}&limit=25`,
        { site },
      );
      setFound(reply.records.filter((r) => props.kinds.includes(r.kind)));
    } catch (error) {
      setFound(undefined);
      setProblem(
        error instanceof ApiError && (error.status === 403 || error.status === 404)
          ? "You can't search the records of this site. Give the record's ID below instead."
          : problemText(error),
      );
    } finally {
      setBusy(false);
    }
  }

  const idOk = RECORD_ID.test(byId.trim()) && byIdLabel.trim() !== "";
  return (
    <div className={styles.panel} role="group" aria-label={props.label}>
      <div className={styles.grid}>
        {sites.length > 1 ? (
          <label className={styles.label}>
            Site to search
            <select
              className={styles.select}
              value={site}
              onChange={(event) => {
                setSite(event.target.value);
              }}
            >
              {sites.map((s) => (
                <option key={s.siteId} value={s.siteId}>
                  {s.siteName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={styles.label}>
          Search by title
          <input
            className={styles.input}
            name={`${props.id}-search`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            isDisabled={busy || query.trim() === ""}
            onPress={() => void search()}
          >
            Search
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {problem === undefined ? null : <Note tone="amber">{problem}</Note>}
        {found === undefined ? null : found.length === 0 ? (
          <p className={styles.muted}>Nothing found that can be picked here.</p>
        ) : (
          <ul className={styles.list} aria-label="Search results">
            {found.map((r) => (
              <li key={r.recordId} className={styles.listItem}>
                <span>{r.title}</span>
                <Button
                  variant="secondary"
                  onPress={() => {
                    props.onPick({ recordId: r.recordId, label: r.title });
                    setFound(undefined);
                    setQuery("");
                  }}
                >
                  {`Pick ${r.title}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.grid}>
        <label className={styles.label}>
          Or the record&apos;s ID
          <input
            className={styles.input}
            name={`${props.id}-id`}
            value={byId}
            spellCheck={false}
            onChange={(event) => {
              setById(event.target.value);
            }}
          />
        </label>
        <label className={styles.label}>
          And a label for it
          <input
            className={styles.input}
            name={`${props.id}-label`}
            value={byIdLabel}
            onChange={(event) => {
              setByIdLabel(event.target.value);
            }}
          />
        </label>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            isDisabled={!idOk}
            onPress={() => {
              props.onPick({ recordId: byId.trim().toLowerCase(), label: byIdLabel.trim() });
              setById("");
              setByIdLabel("");
            }}
          >
            Use this ID
          </Button>
        </div>
      </div>
    </div>
  );
}
