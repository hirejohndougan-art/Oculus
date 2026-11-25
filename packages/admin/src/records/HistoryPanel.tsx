/**
 * A record's history (T-046, D-082): its versions, newest first, with who
 * (you or someone else), when, what changed and the workflow move; one
 * version's content; two versions compared; and restoring an old version as
 * the record's next one. Restoring asks first, and asks again, naming the
 * fields, when the server says that public values would change
 * (`public_field_restored`): then it sends `confirmMadePublic` with exactly
 * those fields. Only shown to people who may read history (never read-only
 * people or Scanners); the server checks again on every request. Old values
 * are shown as text only.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Note } from "../components/ui";
import { Choice, ConfirmPanel } from "./controls";
import {
  ACTION_LABELS,
  issuesIn,
  valueText,
  whenText,
  type Difference,
  type FieldTemplate,
  type StoredRecord,
} from "./model";
import { recordKey, useVersions, versionsKey } from "./queries";
import styles from "./Records.module.css";

interface Props {
  readonly siteId: string;
  readonly recordId: string;
  readonly currentVersion: number;
  readonly template: FieldTemplate | undefined;
  /** The signed-in person (`user:<id>` in a version's actor is "you"). */
  readonly userId: string;
  /** Restoring needs the edit permission too. */
  readonly canRestore: boolean;
  /** Unsaved edits in the form: restoring would lose them, so it waits. */
  readonly dirty: boolean;
  /** A restore was refused because the record changed meanwhile. */
  readonly onConflict: () => void;
  readonly onRestored: (version: number) => void;
}

/** The record's own properties as people call them. */
const PROPERTY_LABELS: Readonly<Record<string, string>> = {
  title: "Title",
  kind: "Kind",
  siteId: "Site",
  templateKey: "Template",
  recordTypeKey: "Record type",
  workflowState: "Status",
  level: "Level",
  parentId: "Filed under",
  mediaType: "File type",
  represents: "Scan of",
  agentType: "Person, family or organization",
  coordinates: "Map position",
};

type Restore =
  | { readonly step: "ask"; readonly version: number }
  | { readonly step: "public"; readonly version: number; readonly keys: readonly string[] };

export function HistoryPanel(props: Props) {
  const queries = useQueryClient();
  const versions = useVersions(props.siteId, props.recordId, true);
  const [shown, setShown] = useState<{ version: number; record: StoredRecord }>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [differences, setDifferences] = useState<{
    from: number;
    to: number;
    list: readonly Difference[];
  }>();
  const [problem, setProblem] = useState<string>();
  const [restore, setRestore] = useState<Restore>();
  const [busy, setBusy] = useState(false);

  const label = (name: string) => {
    // A change of numbers (S-061): `identifiers.<type key>`.
    if (name.startsWith("identifiers.")) return `ID numbers (${name.slice(12)})`;
    const key = name.startsWith("fields.") ? name.slice(7) : undefined;
    if (key === undefined) return PROPERTY_LABELS[name] ?? name;
    return props.template?.fields.find((f) => f.key === key)?.label ?? key;
  };
  const who = (actor: string) => (actor === `user:${props.userId}` ? "You" : "Someone else");
  const base = `/api/records/${encodeURIComponent(props.recordId)}`;

  async function view(version: number) {
    setProblem(undefined);
    try {
      const reply = await api<{ version: { version: number; record: StoredRecord } }>(
        `${base}/versions/${String(version)}`,
        { site: props.siteId },
      );
      setShown({ version, record: reply.version.record });
    } catch (error) {
      setProblem(problemText(error));
    }
  }

  async function compare() {
    setProblem(undefined);
    if (from === "" || to === "") return;
    try {
      const reply = await api<{ from: number; to: number; differences: Difference[] }>(
        `${base}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { site: props.siteId },
      );
      setDifferences({ from: reply.from, to: reply.to, list: reply.differences });
    } catch (error) {
      setProblem(problemText(error));
    }
  }

  async function doRestore(version: number, confirm: readonly string[] | undefined) {
    setBusy(true);
    setProblem(undefined);
    try {
      const reply = await api<{ version: number }>(`${base}/versions/${String(version)}/restore`, {
        method: "POST",
        body: confirm === undefined ? {} : { confirmMadePublic: confirm },
        ifMatch: props.currentVersion,
        site: props.siteId,
      });
      setRestore(undefined);
      await queries.invalidateQueries({ queryKey: recordKey(props.recordId) });
      await queries.invalidateQueries({ queryKey: versionsKey(props.recordId) });
      props.onRestored(reply.version);
    } catch (error) {
      const issues = error instanceof ApiError ? issuesIn(error.body) : [];
      const publicKeys = issues
        .filter((i) => i.code === "public_field_restored" && typeof i.path[1] === "string")
        .map((i) => String(i.path[1]));
      if (confirm === undefined && publicKeys.length > 0 && publicKeys.length === issues.length) {
        setRestore({ step: "public", version, keys: publicKeys });
      } else if (error instanceof ApiError && error.status === 412) {
        setRestore(undefined);
        props.onConflict();
      } else {
        setRestore(undefined);
        setProblem(
          issues.length > 0
            ? `Version ${String(version)} can't be restored: ${issues.map((i) => i.message).join(" ")}`
            : problemText(error),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const list = [...(versions.data?.versions ?? [])].reverse();
  const options = list.map((v) => ({
    id: String(v.version),
    label: `Version ${String(v.version)}`,
  }));

  return (
    <section className={styles.panel} aria-labelledby="history-title">
      <h2 id="history-title" className={styles.sectionTitle}>
        History
      </h2>
      <p className={styles.meta}>
        Every save and status change is kept. Restoring an old version saves it as a new one, so
        nothing is lost.
      </p>
      {problem === undefined ? null : (
        <Note tone="amber" alert>
          {problem}
        </Note>
      )}
      <ConfirmPanel
        key={restore?.step ?? "closed"}
        isOpen={restore !== undefined}
        title={
          restore?.step === "public"
            ? "Public values would change"
            : `Restore version ${String(restore?.version ?? "")}?`
        }
        confirmLabel={
          restore?.step === "public" ? "Restore and confirm these values" : "Restore this version"
        }
        busy={busy}
        onCancel={() => {
          setRestore(undefined);
        }}
        onConfirm={() => {
          if (restore === undefined) return;
          void doRestore(restore.version, restore.step === "public" ? restore.keys : undefined);
        }}
      >
        {restore?.step === "public" ? (
          <>
            <p>
              Restoring would change these fields, which are public now. Their old values may have
              been staff-only when they were saved. Confirm that they may be shown on public sites:
            </p>
            <ul>
              {restore.keys.map((k) => (
                <li key={k}>{label(`fields.${k}`)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            The record goes back to how it was in version {String(restore?.version ?? "")}, saved as
            a new version. Its ID numbers and status stay as they are.
          </p>
        )}
      </ConfirmPanel>
      {versions.isPending ? (
        <p role="status">Loading the history…</p>
      ) : versions.isError ? (
        <Note tone="amber" alert>
          The history couldn't be loaded. {problemText(versions.error)}
        </Note>
      ) : (
        <ol className={styles.versions} aria-label="Versions, newest first">
          {list.map((v) => (
            <li key={v.version} className={styles.version}>
              <span className={styles.versionTitle}>
                Version {String(v.version)}
                {v.version === props.currentVersion ? " (current)" : ""}:{" "}
                {ACTION_LABELS[v.action] ?? v.action}
              </span>
              <span>
                {whenText(v.recordedAt)} · {who(v.actor)}
              </span>
              {v.changedFields.length === 0 ? null : (
                <span>Changed: {v.changedFields.map(label).join(", ")}</span>
              )}
              {v.reason === undefined ? null : <span>Reason: {v.reason}</span>}
              <span className={styles.actions}>
                <Button variant="link" onPress={() => void view(v.version)}>
                  View version {String(v.version)}
                </Button>
                {props.canRestore && v.version !== props.currentVersion ? (
                  <Button
                    variant="link"
                    isDisabled={props.dirty}
                    onPress={() => {
                      setRestore({ step: "ask", version: v.version });
                    }}
                  >
                    Restore version {String(v.version)}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      {props.canRestore && props.dirty ? (
        <p className={styles.meta}>Save or discard your changes before restoring a version.</p>
      ) : null}

      {shown === undefined ? null : (
        <section aria-labelledby="shown-title" className={styles.panel}>
          <h3 id="shown-title" className={styles.sectionTitle}>
            Version {String(shown.version)}
          </h3>
          <dl className={styles.details}>
            <dt>Title</dt>
            <dd>{shown.record.title}</dd>
            {Object.entries(shown.record.fields).map(([key, value]) => (
              <div key={key} className={styles.pair}>
                <dt>{label(`fields.${key}`)}</dt>
                <dd>{valueText(value)}</dd>
              </div>
            ))}
          </dl>
          <div>
            <Button
              variant="secondary"
              onPress={() => {
                setShown(undefined);
              }}
            >
              Close version {String(shown.version)}
            </Button>
          </div>
        </section>
      )}

      {list.length < 2 ? null : (
        <div className={styles.panel}>
          <h3 className={styles.sectionTitle}>Compare two versions</h3>
          <Choice
            label="From version"
            placeholder="Choose a version"
            value={from}
            onChange={setFrom}
            options={options}
          />
          <Choice
            label="To version"
            placeholder="Choose a version"
            value={to}
            onChange={setTo}
            options={options}
          />
          <div>
            <Button
              variant="secondary"
              isDisabled={from === "" || to === "" || from === to}
              onPress={() => void compare()}
            >
              Compare
            </Button>
          </div>
          {differences === undefined ? null : differences.list.length === 0 ? (
            <p role="status">
              Versions {String(differences.from)} and {String(differences.to)} are the same.
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  From version {String(differences.from)} to version {String(differences.to)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {differences.list.map((d) => (
                    <tr key={d.name}>
                      <td>{label(d.name)}</td>
                      <td>{d.change === "added" ? "(none)" : valueText(d.before)}</td>
                      <td>{d.change === "removed" ? "(none)" : valueText(d.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
