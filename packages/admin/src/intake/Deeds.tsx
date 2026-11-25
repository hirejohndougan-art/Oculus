/**
 * Deeds of gift (T-073; mockup Deeds): where each accession's deed stands.
 * A deed that is missing or sent for signature holds the accession's
 * records back from the public sites (D-114). Marking one sent or signed
 * saves the accession from the version listed; the service checks it
 * again. Drafting the deed and attaching the signed scan come later (T-066,
 * T-069).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { HeldRecords } from "./HeldRecords";
import {
  deedHolds,
  inputFrom,
  type AccessionView,
  type DeedStatus,
  type SavedAccession,
} from "./model";
import { REGISTER_KEY, accessionKey, useRegister } from "./queries";
import { DeedPill, Loading, Refused, accessionProblem } from "./shared";
import styles from "./Intake.module.css";

function DeedRow(props: {
  readonly view: AccessionView;
  readonly onSaved: (saved: SavedAccession) => void;
}) {
  const queries = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const a = props.view.accession;

  async function mark(status: DeedStatus) {
    setBusy(true);
    setProblem(undefined);
    try {
      const input: Record<string, unknown> = { ...inputFrom(a), deedStatus: status };
      if (status !== "signed") delete input.deedSignedOn;
      const saved = await api<SavedAccession>(`/api/accessions/${encodeURIComponent(a.id)}`, {
        method: "PUT",
        body: { accession: input },
        ifMatch: props.view.version,
      });
      props.onSaved(saved);
      queries.removeQueries({ queryKey: accessionKey(a.id) });
      await queries.invalidateQueries({ queryKey: REGISTER_KEY });
    } catch (error) {
      setProblem(accessionProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <TextLink href={`/intake/accessions/${a.id}`}>{a.number.value}</TextLink>
      </td>
      <td>{a.sourceAgent.label}</td>
      <td>
        <DeedPill status={a.deedStatus} />
      </td>
      <td>
        <div className={styles.actions}>
          {a.deedStatus === "missing" ? (
            <Button variant="secondary" isDisabled={busy} onPress={() => void mark("sent")}>
              {`Mark ${a.number.value} as sent`}
            </Button>
          ) : null}
          {deedHolds(a.deedStatus) ? (
            <Button variant="secondary" isDisabled={busy} onPress={() => void mark("signed")}>
              {`Mark ${a.number.value} as signed`}
            </Button>
          ) : null}
        </div>
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
      </td>
    </tr>
  );
}

export function Deeds() {
  const register = useRegister();
  const [held, setHeld] = useState<{ number: string; ids: readonly string[] }>();
  if (register.error !== null) return <Refused title="Deeds of gift" error={register.error} />;
  if (register.data === undefined) return <Loading />;
  const all = register.data.accessions;
  const waiting = all.filter((v) => deedHolds(v.accession.deedStatus));
  const done = all.filter((v) => !deedHolds(v.accession.deedStatus));
  const onSaved = (saved: SavedAccession) => {
    setHeld(
      saved.nowHeld.length > 0
        ? { number: saved.accession.number.value, ids: saved.nowHeld }
        : undefined,
    );
  };
  const table = (rows: readonly AccessionView[], caption: string) => (
    <table className={styles.table}>
      <caption className={styles.muted}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Accession</th>
          <th scope="col">Donor</th>
          <th scope="col">Deed status</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <DeedRow key={`${v.accession.id}:${String(v.version)}`} view={v} onSaved={onSaved} />
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>Deeds of gift</h1>
          <p className={frame.lead}>
            The legal record that a donor gave materials to the Society. Until a deed is signed (or
            marked not needed), the accession&apos;s records can be cataloged but are held back from
            the public sites.
          </p>
        </div>
        <TextLink href="/intake/accessions/new">Log an accession</TextLink>
      </div>
      {held === undefined ? null : (
        <HeldRecords recordIds={held.ids} accessionNumber={held.number} />
      )}
      {waiting.length === 0 ? (
        <Note tone="green">Every accession has its deed signed or doesn&apos;t need one.</Note>
      ) : (
        <>
          <Note tone="amber">
            {waiting.length === 1
              ? "1 accession is missing a signed deed."
              : `${String(waiting.length)} accessions are missing a signed deed.`}
          </Note>
          {table(waiting, "Waiting for a signed deed")}
        </>
      )}
      {done.length === 0 ? null : table(done, "Signed or not needed")}
    </>
  );
}
