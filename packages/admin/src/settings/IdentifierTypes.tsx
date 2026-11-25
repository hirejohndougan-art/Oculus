/**
 * Settings › ID numbers (T-047a, D-009, D-022, D-031, D-076, D-091): the
 * identifier types of the organization the session works in, and an editor
 * for one of them.
 *
 * Saving sends the whole type with the tag the edit started from
 * (`If-Match: "t-<tag>"`, or `If-None-Match: *` for a new key). The server
 * runs T-005a's change report and may answer that the change needs
 * confirming: changes records already use (a new format, a stricter
 * uniqueness rule, numbers made public), published records whose numbers
 * would show at once (D-076), and published records a new format takes off
 * the public sites until their numbers are fixed (S-033). The editor lists
 * what it said and sends the same type again with exactly those
 * confirmations only when the person says so. An edit made on an old copy is
 * refused, and the editor offers the latest version instead of overwriting.
 *
 * Type text (labels, keys, formats) is shown as text by React, never as
 * HTML; a key goes into an address only once it matches core's key rule.
 */
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useBlocker, useNavigate, useOutletContext, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckboxButton, CheckboxField } from "react-aria-components";
import { isSessionEnding, useUnsavedChanges } from "../idle/unsaved";
import { ApiError, api } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import { Choice, ConfirmPanel, TextInput } from "../records/controls";
import records from "../records/Records.module.css";
import type { SettingsContext } from "./Settings";
import { Problems } from "./Settings";
import {
  NUMBERING_NAMES,
  SEPARATORS,
  TYPE_KEY,
  UNIQUENESS,
  UNIQUENESS_NAMES,
  isNewTypeKey,
  mergedConfirmation,
  newTypeDraft,
  numberingText,
  typeConfirmationOf,
  typeDraft,
  typeFromDraft,
  type Numbering,
  type Separator,
  type TypeConfirmation,
  type TypeDraft,
  type Uniqueness,
} from "./identifierTypeForm";
import { issuesOf } from "./templateForm";
import styles from "./Settings.module.css";

interface TaggedType {
  readonly type: unknown;
  readonly tag: string;
}

interface SavedType extends TaggedType {
  readonly droppedFromPublic?: readonly string[];
}

const typesKey = (organizationId: string) => ["system-identifier-types", organizationId] as const;

function keyOf(tagged: TaggedType): string {
  const t = tagged.type as { key?: unknown } | null;
  return typeof t?.key === "string" ? t.key : "";
}

function labelOf(tagged: TaggedType): string {
  const t = tagged.type as { label?: unknown } | null;
  return typeof t?.label === "string" && t.label !== "" ? t.label : keyOf(tagged);
}

/** Settings › ID numbers: the list. */
export function IdentifierTypeList() {
  const { me } = useOutletContext<SettingsContext>();
  const list = useQuery({
    queryKey: typesKey(me.organizationId),
    queryFn: async () =>
      (await api<{ identifierTypes: TaggedType[] }>("/api/identifier-types")).identifierTypes,
  });
  return (
    <section className={records.panel} aria-labelledby="types-list">
      <div className={records.header}>
        <div>
          <h2 id="types-list" className={records.sectionTitle}>
            ID number types of {me.organizationName}
          </h2>
          <p className={records.meta}>
            The kinds of number records carry (accession numbers, object numbers, box labels), their
            format, and whether they may be shown on public sites. Each organization has its own; to
            change another organization's, work in one of its sites first.
          </p>
        </div>
        <TextLink href="/settings/new-identifier-type">+ New ID number type</TextLink>
      </div>
      {list.data === undefined ? (
        list.error === null ? (
          <p role="status">Loading…</p>
        ) : (
          <Problems error={list.error} />
        )
      ) : list.data.length === 0 ? (
        <p className={records.meta}>This organization has no ID number types yet.</p>
      ) : (
        <div className={records.tableWrap}>
          <table className={records.table}>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Format</th>
                <th scope="col">New numbers</th>
                <th scope="col">Unique</th>
                <th scope="col">Public</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => {
                const key = keyOf(t);
                const draft = typeDraft(t.type);
                return (
                  <tr key={key}>
                    <td>
                      {TYPE_KEY.test(key) ? (
                        <TextLink href={`/settings/identifier-types/${key}`}>{labelOf(t)}</TextLink>
                      ) : (
                        labelOf(t)
                      )}
                      <div className={styles.muted}>{key}</div>
                    </td>
                    <td>{draft.pattern === "" ? "Any" : draft.pattern}</td>
                    <td>{numberingText(t.type)}</td>
                    <td>{UNIQUENESS_NAMES[draft.uniqueness]}</td>
                    <td>{draft.isPublic ? "Yes" : "Staff only"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Settings › ID numbers › one type (or a new one). */
export function IdentifierTypeScreen(props: { readonly isNew?: boolean }) {
  const { me } = useOutletContext<SettingsContext>();
  const { key = "" } = useParams();
  const known = props.isNew !== true && TYPE_KEY.test(key);
  const [savedAs, setSavedAs] = useState<{ tag: string; dropped: readonly string[] }>();
  // Types are read as a list (there is no single-type route); the one asked for is picked out.
  const list = useQuery({
    queryKey: typesKey(me.organizationId),
    queryFn: async () =>
      (await api<{ identifierTypes: TaggedType[] }>("/api/identifier-types")).identifierTypes,
    enabled: known,
    // The form starts fresh for each tag: a background refetch would drop typed edits.
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  if (props.isNew === true) {
    return (
      <TypeForm
        key="new"
        organizationId={me.organizationId}
        onSaved={(tag, dropped) => {
          setSavedAs({ tag, dropped });
        }}
      />
    );
  }
  const stored = list.data?.find((t) => keyOf(t) === key);
  if (!known || (list.data !== undefined && stored === undefined)) {
    return (
      <Note tone="amber">
        There is no ID number type with that key in {me.organizationName}.{" "}
        <TextLink href="/settings/identifier-types">Back to the ID number types</TextLink>
      </Note>
    );
  }
  if (stored === undefined) {
    return list.error === null ? <p role="status">Loading…</p> : <Problems error={list.error} />;
  }
  return (
    <TypeForm
      key={`${key}-${stored.tag}`}
      organizationId={me.organizationId}
      typeKey={key}
      stored={stored}
      justSaved={savedAs?.tag === stored.tag}
      dropped={savedAs?.tag === stored.tag ? savedAs.dropped : []}
      onSaved={(tag, dropped) => {
        setSavedAs({ tag, dropped });
      }}
    />
  );
}

function Check(props: {
  readonly label: string;
  readonly isSelected: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <CheckboxField isSelected={props.isSelected} onChange={props.onChange}>
      <CheckboxButton className={styles.check}>
        <span className={styles.box} aria-hidden="true" />
        {props.label}
      </CheckboxButton>
    </CheckboxField>
  );
}

function TypeForm(props: {
  readonly organizationId: string;
  readonly typeKey?: string;
  readonly stored?: TaggedType;
  /** The tag shown is the one this person just saved (the form is new for each tag). */
  readonly justSaved?: boolean;
  /** Published records the save just took off public sites (S-033). */
  readonly dropped?: readonly string[];
  readonly onSaved?: (tag: string, dropped: readonly string[]) => void;
}) {
  const { stored, organizationId } = props;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [draft, setDraft] = useState<TypeDraft>(() =>
    stored === undefined ? newTypeDraft(organizationId) : typeDraft(stored.type),
  );
  const [asked, setAsked] = useState<TypeConfirmation & { listChanged?: boolean }>();
  const [edited, setEdited] = useState(false);
  const saved = props.justSaved === true && !edited;
  const dropped = props.dropped ?? [];
  const key = props.typeKey ?? newKey.trim();
  const leaving = useRef(false);
  const sentKey = useRef("");

  // Leaving with unsaved changes: ask in the app; the browser asks on reload.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      edited &&
      !leaving.current &&
      !isSessionEnding() &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  // The idle warning says these changes will be lost (T-062, D-098).
  useUnsavedChanges(edited);
  useEffect(() => {
    if (!edited) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [edited]);

  const save = useMutation({
    mutationFn: (confirmation: TypeConfirmation | undefined) =>
      api<SavedType>(`/api/identifier-types/${key}`, {
        method: "PUT",
        body: {
          identifierType: typeFromDraft(draft),
          ...(confirmation === undefined
            ? {}
            : {
                ...(confirmation.confirm.length > 0 ? { confirm: confirmation.confirm } : {}),
                ...(confirmation.publishedRecords > 0 ? { confirmPublished: true } : {}),
                ...(confirmation.dropped.length > 0
                  ? { confirmDropped: confirmation.dropped }
                  : {}),
              }),
        },
        ...(stored === undefined ? { ifNoneMatch: true } : { ifMatchTag: stored.tag }),
      }),
    onSuccess: async (reply) => {
      setAsked(undefined);
      // Saved: nothing left to warn about (a save that changed nothing keeps the tag).
      setEdited(false);
      props.onSaved?.(reply.tag, reply.droppedFromPublic ?? []);
      await queries.invalidateQueries({ queryKey: typesKey(organizationId) });
      if (stored === undefined) {
        leaving.current = true;
        // The key that was sent, never one typed while the request ran.
        await navigate(`/settings/identifier-types/${sentKey.current}`, { replace: true });
      }
    },
    onError: (error, sent) => {
      if (!(error instanceof ApiError && error.code === "confirmation_required")) {
        // Any other answer ends the confirmation: the error note says what happened.
        setAsked(undefined);
        return;
      }
      const next = typeConfirmationOf(issuesOf(error.body));
      const merged = mergedConfirmation(sent, next);
      // Asked again only because the published records changed meanwhile: say so.
      const changed =
        sent !== undefined &&
        next.dropped.length > 0 &&
        (next.dropped.length !== sent.dropped.length ||
          next.dropped.some((id) => !sent.dropped.includes(id)));
      setAsked(changed ? { ...merged, listChanged: true } : merged);
    },
  });

  const error = save.error;
  const conflict = error instanceof ApiError && error.status === 412;
  const confirming = error instanceof ApiError && error.code === "confirmation_required";
  const keyProblem =
    stored === undefined && newKey !== "" && !isNewTypeKey(newKey.trim())
      ? "Use 1 to 64 lower case letters, digits and underscores, starting with a letter."
      : undefined;
  const keyOk = stored !== undefined ? TYPE_KEY.test(key) : isNewTypeKey(key);

  function change(next: Partial<TypeDraft>) {
    setEdited(true);
    setAsked(undefined);
    if (save.error !== null) save.reset();
    setDraft((d) => ({ ...d, ...next }));
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!keyOk) return;
    sentKey.current = key;
    save.mutate(undefined);
  }

  const lines =
    error instanceof ApiError && error.code === "invalid"
      ? issuesOf(error.body).map((i) => i.message)
      : [];

  return (
    <form className={records.layout} onSubmit={submit} aria-label="ID number type">
      <div className={records.panel}>
        <div>
          <h2 className={records.sectionTitle}>
            {stored === undefined ? "New ID number type" : draft.label || key}
          </h2>
          {stored === undefined ? null : <p className={records.meta}>Key {key}</p>}
        </div>
        <div className={records.grid}>
          {stored === undefined ? (
            <TextInput
              label="Key"
              value={newKey}
              isReadOnly={save.isPending}
              onChange={(v) => {
                setNewKey(v);
                change({});
              }}
              isRequired
              maxLength={64}
              help="Records name the type of each number by this. It can't change later."
              errors={keyProblem === undefined ? undefined : [keyProblem]}
            />
          ) : null}
          <TextInput
            label="Name"
            value={draft.label}
            onChange={(v) => {
              change({ label: v });
            }}
            isRequired
            maxLength={200}
            help="What staff see, such as Accession number."
          />
          <TextInput
            label="Format"
            value={draft.pattern}
            onChange={(v) => {
              change({ pattern: v });
            }}
            maxLength={100}
            help="Optional. # is a digit, @ a letter, * either; {4} repeats the one before. For example ####.### or DHS-#{4}."
          />
          <Choice
            label="Unique"
            value={draft.uniqueness}
            options={UNIQUENESS.map((u) => ({ id: u, label: UNIQUENESS_NAMES[u] }))}
            onChange={(v) => {
              change({ uniqueness: v as Uniqueness });
            }}
          />
          <Choice
            label="New numbers"
            value={draft.numbering}
            options={(["none", "year", "prefix"] as const).map((n) => ({
              id: n,
              label: NUMBERING_NAMES[n],
            }))}
            onChange={(v) => {
              change({ numbering: v as Numbering });
            }}
          />
          {draft.numbering === "year" ? (
            <Choice
              label="Between the year and the number"
              value={draft.separator}
              options={SEPARATORS.map((s) => ({ id: s, label: s }))}
              onChange={(v) => {
                change({ separator: v as Separator });
              }}
            />
          ) : null}
          {draft.numbering === "prefix" ? (
            <TextInput
              label="Starts with"
              value={draft.prefix}
              onChange={(v) => {
                change({ prefix: v });
              }}
              isRequired
              maxLength={40}
            />
          ) : null}
          {draft.numbering === "none" ? null : (
            <TextInput
              label="Digits"
              value={draft.digits}
              onChange={(v) => {
                change({ digits: v });
              }}
              isRequired
              maxLength={2}
              help="How many digits the running number has, with leading zeros."
            />
          )}
        </div>
        <fieldset className={records.fieldset}>
          <legend className={records.legend}>Public sites</legend>
          <div className={styles.checks}>
            <Check
              label="Numbers of this type may be shown on public sites"
              isSelected={draft.isPublic}
              onChange={(on) => {
                change({ isPublic: on });
              }}
            />
          </div>
          <p className={records.meta}>
            Left off, numbers of this type are staff only: they never reach a public site.
          </p>
        </fieldset>
      </div>

      <div className={records.panel}>
        <h2 className={records.sectionTitle}>Save</h2>
        <p className={records.meta}>
          The server checks the type before saving. Changes that affect numbers records already
          have, numbers that would show at once on published records, and published records a new
          format would take off the public sites are listed for you to confirm first.
        </p>
        {conflict ? (
          <div role="alert">
            <Note tone="amber">
              Someone else changed this ID number type while you were editing. Your changes
              weren&apos;t saved.{" "}
              <Button
                variant="link"
                onPress={() => {
                  void queries.invalidateQueries({ queryKey: typesKey(organizationId) });
                }}
              >
                Load the latest version
              </Button>
            </Note>
          </div>
        ) : lines.length > 0 ? (
          <div role="alert">
            <Note tone="amber">
              {"The ID number type wasn't saved. These need fixing:"}
              <ul className={records.issues}>
                {lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </Note>
          </div>
        ) : confirming ? null : (
          <Problems error={error} />
        )}
        {saved ? (
          <div aria-live="polite">
            <Note tone="green">
              Saved.
              {dropped.length > 0
                ? ` ${String(dropped.length)} published ${dropped.length === 1 ? "record shows" : "records show"} as not available on public sites until ${dropped.length === 1 ? "its number is" : "their numbers are"} fixed.`
                : ""}
            </Note>
          </div>
        ) : null}
        <ConfirmPanel
          isOpen={blocker.state === "blocked"}
          title="Leave without saving?"
          confirmLabel="Leave and discard my changes"
          cancelLabel="Stay on this ID number type"
          danger
          onCancel={() => {
            blocker.reset?.();
          }}
          onConfirm={() => {
            blocker.proceed?.();
          }}
        >
          <p>You have changes to this ID number type that are not saved.</p>
        </ConfirmPanel>
        <ConfirmPanel
          isOpen={asked !== undefined}
          title="Confirm these changes"
          confirmLabel="Save with these changes"
          busy={save.isPending}
          danger={asked !== undefined && asked.dropped.length > 0}
          onConfirm={() => {
            save.mutate(asked);
          }}
          onCancel={() => {
            setAsked(undefined);
            save.reset();
          }}
        >
          <ul>
            {(asked?.messages ?? []).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
            {asked !== undefined && asked.publishedRecords > 0 ? (
              <li>
                This change shows numbers at once on {asked.publishedRecords} published{" "}
                {asked.publishedRecords === 1 ? "record" : "records"}.
              </li>
            ) : null}
            {asked !== undefined && asked.dropped.length > 0 ? (
              <li>
                {asked.listChanged === true
                  ? "The list of published records this takes off has changed since you last looked (a record was published or changed meanwhile). "
                  : ""}
                {asked.dropped.length === 1
                  ? "Now: 1 published record would show as not available on public sites until its number is fixed."
                  : `Now: ${String(asked.dropped.length)} published records would show as not available on public sites until their numbers are fixed.`}
              </li>
            ) : null}
          </ul>
        </ConfirmPanel>
        <div className={records.actions}>
          <Button type="submit" variant="primary" isDisabled={save.isPending || !keyOk}>
            {stored === undefined ? "Create ID number type" : "Save ID number type"}
          </Button>
          <TextLink href="/settings/identifier-types">Back to the ID number types</TextLink>
        </div>
      </div>
    </form>
  );
}
