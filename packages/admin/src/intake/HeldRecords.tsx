/**
 * After a save that holds published records back (T-073, D-114): the
 * public output already leaves them out, and the next publish check refuses
 * them, but they still read as published to staff. This offers to withdraw
 * each one, for people who may publish it; the record's own withdraw route
 * checks that (and the version) again.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Note } from "../components/ui";
import type { ReadRecordReply } from "../records/model";
import styles from "./Intake.module.css";

function HeldRecord(props: { readonly recordId: string; readonly reason: string }) {
  const queries = useQueryClient();
  const key = ["held-record", props.recordId] as const;
  const read = useQuery({
    queryKey: key,
    queryFn: () => api<ReadRecordReply>(`/api/records/${encodeURIComponent(props.recordId)}`),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();
  if (read.error !== null) {
    return (
      <li className={styles.listItem}>
        <span className={styles.muted}>
          {read.error instanceof ApiError && read.error.status === 404
            ? "A record you can't see. Ask someone who can publish on its site to withdraw it."
            : problemText(read.error)}
        </span>
      </li>
    );
  }
  if (read.data === undefined) {
    return (
      <li className={styles.listItem}>
        <span role="status">Loading…</span>
      </li>
    );
  }
  const record = read.data;
  async function withdraw() {
    setBusy(true);
    setStatus(undefined);
    try {
      await api(`/api/records/${encodeURIComponent(props.recordId)}/withdraw`, {
        body: { reason: props.reason },
        ifMatch: record.version,
      });
      setStatus({ tone: "green", text: "Withdrawn. It is off the public sites." });
      await queries.invalidateQueries({ queryKey: key });
    } catch (error) {
      setStatus({
        tone: "amber",
        text:
          error instanceof ApiError && error.code === "version_conflict"
            ? "The record changed meanwhile. Try again."
            : error instanceof ApiError && error.code === "not_permitted"
              ? "You can't withdraw this record. Ask someone who can publish on its site."
              : problemText(error),
      });
      await queries.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={styles.listItem}>
      <span>{record.record.title}</span>
      {record.state === "published" && record.can.publish ? (
        <Button variant="secondary" isDisabled={busy} onPress={() => void withdraw()}>
          {`Withdraw ${record.record.title}`}
        </Button>
      ) : (
        <span className={styles.muted}>
          {record.state === "published"
            ? "Someone who can publish must withdraw it."
            : "Not published."}
        </span>
      )}
      {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
    </li>
  );
}

export function HeldRecords(props: { readonly recordIds: readonly string[] }) {
  if (props.recordIds.length === 0) return null;
  return (
    <section className={styles.panel} aria-labelledby="held-title">
      <h2 className={styles.panelTitle} id="held-title">
        Published records now held back
      </h2>
      <Note tone="amber">
        {props.recordIds.length === 1
          ? "This accession now holds back 1 published record"
          : `This accession now holds back ${String(props.recordIds.length)} published records`}
        : its deed isn&apos;t signed or a restriction is in force. The public sites already leave
        them out, and they can&apos;t be published again until that changes. Withdraw them so staff
        see them as unpublished too.
      </Note>
      <ul className={styles.list}>
        {props.recordIds.map((id) => (
          <HeldRecord
            key={id}
            recordId={id}
            reason="Held back by an accession (its deed or a restriction)"
          />
        ))}
      </ul>
    </section>
  );
}
