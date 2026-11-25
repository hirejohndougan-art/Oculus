/**
 * Logging an accession and editing one (T-073; mockup Log an accession).
 * One page in the wizard's order: who is giving, when and how, what is
 * received, the deed of gift, restrictions, and the accession number. The
 * service checks the whole accession when it is saved (T-018c, D-114);
 * after a save that holds published records back, the screen offers to
 * withdraw them.
 */
import { useState, type SubmitEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { HeldRecords } from "./HeldRecords";
import {
  DEED_LABELS,
  DEED_STATUSES,
  EMPTY_FORM,
  METHODS,
  formOf,
  inputOf,
  type AccessionForm,
  type AccessionLink,
  type DeedStatus,
  type SavedAccession,
} from "./model";
import { INTAKE_ACCESS_KEY } from "./IntakeNav";
import { REGISTER_KEY, accessionKey, useAccession } from "./queries";
import { RecordPicker } from "./RecordPicker";
import { Loading, Refused, accessionProblem } from "./shared";
import styles from "./Intake.module.css";

interface IdentifierTypeReply {
  readonly identifierTypes: readonly { readonly type: { key: string; label: string } }[];
}

/** The organization's identifier types, when the person may read them (else undefined). */
function useIdentifierTypes() {
  return useQuery({
    queryKey: ["identifier-types", "intake"],
    queryFn: async () =>
      (await api<IdentifierTypeReply>("/api/identifier-types")).identifierTypes.map((t) => t.type),
    retry: false,
    staleTime: 60_000,
  });
}

/** What the screen was sent here with after a first save. */
interface Arrived {
  readonly saved?: boolean;
  readonly nowHeld?: readonly string[];
}

export function NewAccession() {
  return <AccessionScreen id={undefined} />;
}

export function EditAccession() {
  const { accessionId } = useParams();
  return <AccessionScreen id={accessionId ?? ""} />;
}

function AccessionScreen(props: { readonly id: string | undefined }) {
  const read = useAccession(props.id);
  const title = props.id === undefined ? "Log an accession" : "Accession";
  if (props.id !== undefined) {
    if (read.error !== null) return <Refused title={title} error={read.error} />;
    if (read.data === undefined) return <Loading />;
  }
  const view = read.data;
  return (
    <AccessionEditor
      // A fresh form for each version read (after the person's own save).
      key={view === undefined ? "new" : `${view.accession.id}:${String(view.version)}`}
      initial={view === undefined ? EMPTY_FORM : formOf(view.accession)}
      id={view?.accession.id}
      version={view?.version}
    />
  );
}

function AccessionEditor(props: {
  readonly initial: AccessionForm;
  readonly id: string | undefined;
  readonly version: number | undefined;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const arrived = (useLocation().state ?? {}) as Arrived;
  const types = useIdentifierTypes();
  const [form, setForm] = useState<AccessionForm>(props.initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saved, setSaved] = useState(arrived.saved === true);
  const held = arrived.nowHeld ?? [];
  const [picking, setPicking] = useState<"donor" | "records" | undefined>(
    props.id === undefined ? "donor" : undefined,
  );
  const isNew = props.id === undefined;
  const set = (change: Partial<AccessionForm>) => {
    setForm((f) => ({ ...f, ...change }));
    setSaved(false);
  };

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    setSaved(false);
    try {
      const body = { accession: inputOf(form) };
      if (isNew) {
        const made = await api<SavedAccession>("/api/accessions", { body });
        await queries.invalidateQueries({ queryKey: REGISTER_KEY });
        await queries.invalidateQueries({ queryKey: INTAKE_ACCESS_KEY });
        await navigate(`/intake/accessions/${made.accession.id}`, {
          replace: true,
          state: { saved: true, nowHeld: made.nowHeld } satisfies Arrived,
        });
        return;
      }
      const id = props.id;
      const next = await api<SavedAccession>(`/api/accessions/${encodeURIComponent(id)}`, {
        method: "PUT",
        body,
        ...(props.version === undefined ? {} : { ifMatch: props.version }),
      });
      await queries.invalidateQueries({ queryKey: REGISTER_KEY });
      // What the fresh form (keyed by version) starts with: first the
      // address's state, then the new version.
      await navigate(".", {
        replace: true,
        state: { saved: true, nowHeld: next.nowHeld } satisfies Arrived,
      });
      queries.setQueryData(accessionKey(id), {
        accession: next.accession,
        version: next.version,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      });
    } catch (error) {
      setProblem(accessionProblem(error));
    } finally {
      setBusy(false);
    }
  }

  const pickDonor = (link: AccessionLink) => {
    set({ source: link });
    setPicking(undefined);
  };
  const addRecord = (link: AccessionLink) => {
    if (!form.records.some((r) => r.recordId === link.recordId)) {
      set({ records: [...form.records, link] });
    }
    setPicking(undefined);
  };
  const typeList = types.data;
  const method = METHODS.find(([key]) => key === form.method);

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>
            {isNew ? "Log an accession" : `Accession ${props.initial.numberValue}`}
          </h1>
          <p className={frame.lead}>
            {isNew
              ? "Record what arrived and from whom, before cataloging the items inside. Everything here is for staff only; none of it is shown on the public sites."
              : "What arrived and from whom. Everything here is for staff only."}
          </p>
        </div>
        <TextLink href="/intake/accessions">Back to accessions</TextLink>
      </div>
      <div aria-live="polite">{saved ? <Note tone="green">Saved.</Note> : null}</div>
      <HeldRecords recordIds={held} accessionNumber={props.initial.numberValue} />
      <form
        className={styles.panel}
        aria-label={isNew ? "New accession" : "Accession"}
        onSubmit={(event) => void save(event)}
      >
        <h2 className={styles.panelTitle}>Who is giving?</h2>
        {form.source === null ? (
          <p className={styles.muted}>Pick the donor: a person, family or organization record.</p>
        ) : (
          <p>
            Donor or source: <strong>{form.source.label}</strong>
          </p>
        )}
        {picking === "donor" ? (
          <RecordPicker id="donor" kinds={["agent"]} label="Pick the donor" onPick={pickDonor} />
        ) : (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setPicking("donor");
              }}
            >
              {form.source === null ? "Pick the donor" : "Change the donor"}
            </Button>
          </div>
        )}

        <h2 className={styles.panelTitle}>When and how?</h2>
        <div className={styles.grid}>
          <label className={styles.label}>
            Received on
            <input
              className={styles.input}
              type="date"
              name="receivedOn"
              required
              value={form.receivedOn}
              onChange={(event) => {
                set({ receivedOn: event.target.value });
              }}
            />
          </label>
          <label className={styles.label}>
            How it came
            <select
              className={styles.select}
              name="method"
              {...(method?.[2] ? { "aria-describedby": "method-help" } : {})}
              value={form.method}
              onChange={(event) => {
                set({ method: event.target.value });
              }}
            >
              {METHODS.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {method?.[2] ? (
            <span className={styles.help} id="method-help">
              {method[2]}
            </span>
          ) : null}
        </div>

        <h2 className={styles.panelTitle}>What is being received?</h2>
        <label className={styles.label}>
          The materials, described as a whole
          <textarea
            className={styles.textarea}
            name="materials"
            required
            maxLength={4000}
            value={form.materials}
            onChange={(event) => {
              set({ materials: event.target.value });
            }}
          />
        </label>
        <div>
          <p className={styles.label}>Records cataloged from it</p>
          {form.records.length === 0 ? (
            <p className={styles.muted}>None yet. Add them as the items are cataloged.</p>
          ) : (
            <ul className={styles.list} aria-label="Records cataloged from it">
              {form.records.map((r) => (
                <li key={r.recordId} className={styles.listItem}>
                  <span>{r.label}</span>
                  <Button
                    variant="link"
                    onPress={() => {
                      set({ records: form.records.filter((x) => x.recordId !== r.recordId) });
                    }}
                  >
                    {`Remove ${r.label}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {picking === "records" ? (
          <RecordPicker
            id="records"
            kinds={["object", "archival_unit", "digital_asset"]}
            label="Add a record"
            onPick={addRecord}
          />
        ) : (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onPress={() => {
                setPicking("records");
              }}
            >
              Add a record
            </Button>
          </div>
        )}

        <h2 className={styles.panelTitle}>Deed of gift</h2>
        <p className={styles.help}>
          The signed record that the donor gave the materials. Until it is signed, the records named
          here are held back from the public sites.
        </p>
        <div className={styles.grid}>
          <label className={styles.label}>
            Deed status
            <select
              className={styles.select}
              name="deedStatus"
              value={form.deedStatus}
              onChange={(event) => {
                set({ deedStatus: event.target.value as DeedStatus });
              }}
            >
              {DEED_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DEED_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {form.deedStatus === "signed" ? (
            <label className={styles.label}>
              Signed on (if known)
              <input
                className={styles.input}
                type="date"
                name="deedSignedOn"
                value={form.deedSignedOn}
                onChange={(event) => {
                  set({ deedSignedOn: event.target.value });
                }}
              />
            </label>
          ) : null}
        </div>

        <h2 className={styles.panelTitle}>Any restrictions?</h2>
        <fieldset className={styles.chips}>
          <legend className={styles.label}>Access</legend>
          {(
            [
              ["none", "No restrictions"],
              ["closed_until", "Closed until a date"],
              ["staff_and_researchers", "Staff and researchers only"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className={styles.label}>
              <span>
                <input
                  type="radio"
                  name="restriction"
                  value={key}
                  checked={form.restriction === key}
                  onChange={() => {
                    set({ restriction: key });
                  }}
                />{" "}
                {label}
              </span>
            </label>
          ))}
        </fieldset>
        {form.restriction === "closed_until" ? (
          <>
            <label className={styles.label}>
              Closed until
              <input
                className={styles.input}
                type="date"
                name="closedUntil"
                aria-describedby="closed-help"
                required
                value={form.closedUntil}
                onChange={(event) => {
                  set({ closedUntil: event.target.value });
                }}
              />
            </label>
            <span className={styles.help} id="closed-help">
              Nothing from this accession is published before this day.
            </span>
          </>
        ) : null}
        <label className={styles.label}>
          What the donor asked for, in their words
          <textarea
            className={styles.textarea}
            name="restrictions"
            aria-describedby="restrictions-help"
            maxLength={4000}
            value={form.restrictions}
            onChange={(event) => {
              set({ restrictions: event.target.value });
            }}
          />
        </label>
        <span className={styles.help} id="restrictions-help">
          A note only: it doesn&apos;t hold anything back.
        </span>

        <h2 className={styles.panelTitle}>Accession number</h2>
        <div className={styles.grid}>
          {typeList === undefined ? (
            <label className={styles.label}>
              Number type
              <input
                className={styles.input}
                name="numberType"
                value={form.numberType}
                spellCheck={false}
                onChange={(event) => {
                  set({ numberType: event.target.value });
                }}
              />
            </label>
          ) : (
            <label className={styles.label}>
              Number type
              <select
                className={styles.select}
                name="numberType"
                value={form.numberType}
                onChange={(event) => {
                  set({ numberType: event.target.value });
                }}
              >
                {typeList.some((t) => t.key === form.numberType) ? null : (
                  <option value={form.numberType}>{form.numberType}</option>
                )}
                {typeList.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={styles.label}>
            Number
            <input
              className={styles.input}
              name="numberValue"
              required
              value={form.numberValue}
              spellCheck={false}
              onChange={(event) => {
                set({ numberValue: event.target.value });
              }}
            />
          </label>
        </div>

        <label className={styles.label}>
          Staff note
          <textarea
            className={styles.textarea}
            name="note"
            maxLength={4000}
            value={form.note}
            onChange={(event) => {
              set({ note: event.target.value });
            }}
          />
        </label>
        <div aria-live="polite">
          {problem === undefined ? null : (
            <Note tone="amber" alert>
              {problem}
            </Note>
          )}
        </div>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" isDisabled={busy || form.source === null}>
            {isNew ? "Save the accession" : "Save changes"}
          </Button>
        </div>
      </form>
    </>
  );
}
