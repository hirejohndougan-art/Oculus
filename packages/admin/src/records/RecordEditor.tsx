/**
 * The record editor (DESIGN.md §8 "Record editor", T-046) and the screen for
 * a new record.
 *
 * - The form comes from the record's template (one input per field kind),
 *   with the record's own properties for its kind and the values it
 *   inherits (D-013) under the fields it has none of its own for.
 * - Fields are checked by the server's dry run (`POST /api/records/check`,
 *   D-073: core stays the only judge) when a field loses focus and before
 *   saving; problems show beside their field.
 * - Saving sends `If-Match` (D-079). A 412 says that someone else changed
 *   the record and offers to reload; nothing is ever overwritten silently.
 * - Saving a published record puts the change on the public sites at once
 *   (John, D-076): the editor says so before saving.
 * - The workflow moves (D-075) and Delete show only where the server says
 *   the person may (`can`), and the server decides again on every request.
 *   The history panel shows only for people who may read history.
 * - Leaving with unsaved changes asks first (in the app and on reload).
 *
 * Record text is shown as text only. The page's address holds nothing but
 * the record's ID.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import { Choice, ConfirmPanel, StatePill, TextInput } from "./controls";
import { FieldInput } from "./FieldInput";
import { FilesPanel } from "./FilesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { SharingPanel } from "../shares/SharingPanel";
import {
  AGENT_TYPES,
  KIND_LABELS,
  LEVELS,
  MOVE_LABELS,
  draftOf,
  issuesByTarget,
  issuesIn,
  newDraft,
  offeredMoves,
  recordDraft,
  recordPath,
  sameDraft,
  type Draft,
  type FieldTemplate,
  type Issue,
  type ReadRecordReply,
  type RecordTypeSummary,
  type WorkflowMove,
} from "./model";
import {
  mappingFits,
  recordKey,
  useDublinCoreMapping,
  useRecord,
  useRecordTypes,
  useSiteAbilities,
  useTemplates,
} from "./queries";
import styles from "./Records.module.css";

interface Status {
  readonly tone: "green" | "amber" | "blue";
  readonly text: string;
}

/** After publishing a record whose template has no Dublin Core mapping (D-096). */
const PUBLISHED_UNSHOWN =
  "Published, but no public site shows it yet: its template has no Dublin Core mapping that fits it.";

const MOVE_DONE: Readonly<Record<WorkflowMove, string>> = {
  "submit-for-review": "Sent for review.",
  "return-to-draft": "Returned to draft.",
  publish: "Published. It is on the public site now.",
  withdraw: "Unpublished. It is off the public sites now.",
};

// ---------------------------------------------------------------------------

/** `/sites/:siteId/records/:recordId`. */
export function RecordScreen(props: {
  readonly siteId: string;
  readonly recordId: string;
  readonly userId: string;
}) {
  const location = useLocation();
  const record = useRecord(props.siteId, props.recordId);
  const templates = useTemplates(props.siteId);
  const types = useRecordTypes(props.siteId);
  const notice = (location.state as { notice?: unknown } | null)?.notice;
  const [status, setStatus] = useState<Status | undefined>(
    typeof notice === "string" ? { tone: "green", text: notice } : undefined,
  );

  if (record.isPending || templates.isPending) {
    return <p role="status">Loading the record…</p>;
  }
  if (record.isError) {
    const missing = record.error instanceof ApiError && record.error.status === 404;
    return (
      <>
        <h1 className={styles.pageTitle}>{missing ? "Record not found" : "Record not loaded"}</h1>
        <Note tone="amber" alert>
          {missing
            ? "There is no such record, or it isn't one you can open."
            : `The record couldn't be loaded. ${problemText(record.error)}`}
        </Note>
        <TextLink href={`/sites/${props.siteId}`}>Back to item records</TextLink>
      </>
    );
  }
  const reply = record.data;
  const template = templates.data?.find((t) => t.key === reply.record.templateKey)?.template;
  return (
    <Editor
      // A new version starts a fresh form (only after a save, a move, a
      // restore or an explicit reload: the record never refetches by itself).
      key={`${props.recordId}:${String(reply.version)}`}
      siteId={props.siteId}
      userId={props.userId}
      reply={reply}
      template={template}
      templateMissing={template === undefined}
      recordTypes={types.data ?? []}
      status={status}
      setStatus={setStatus}
    />
  );
}

/** `/sites/:siteId/records/new`: choose what to catalog, then the same form. */
export function NewRecordScreen(props: { readonly siteId: string; readonly userId: string }) {
  const abilities = useSiteAbilities(props.siteId);
  const templates = useTemplates(props.siteId);
  const types = useRecordTypes(props.siteId);
  const [kind, setKind] = useState("");
  const [typeKey, setTypeKey] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [started, setStarted] = useState<{ draft: Draft; template: FieldTemplate }>();
  const [status, setStatus] = useState<Status>();

  if (abilities.isPending || templates.isPending) return <p role="status">Loading…</p>;
  if (abilities.isError || templates.isError) {
    return (
      <Note tone="amber" alert>
        This screen couldn't be loaded. {problemText(abilities.error ?? templates.error)}
      </Note>
    );
  }
  const kinds = abilities.data.createKinds;
  if (kinds.length === 0) {
    return (
      <>
        <h1 className={styles.pageTitle}>Catalog an item</h1>
        <Note tone="blue">Your role on this site doesn't include making records.</Note>
      </>
    );
  }
  if (started !== undefined) {
    return (
      <Editor
        siteId={props.siteId}
        userId={props.userId}
        template={started.template}
        templateMissing={false}
        initial={started.draft}
        recordTypes={types.data ?? []}
        status={status}
        setStatus={setStatus}
      />
    );
  }
  const kindTypes = (types.data ?? []).filter((t) => t.kind === kind);
  const kindTemplates = templates.data.filter((t) => t.template.appliesTo.includes(kind));
  const chosenTemplate =
    kindTemplates.find((t) => t.key === templateKey) ??
    kindTemplates.find(
      (t) => t.key === kindTypes.find((x) => x.key === typeKey)?.defaultTemplateKey,
    ) ??
    kindTemplates[0];

  return (
    <>
      <div>
        <TextLink href={`/sites/${props.siteId}`}>← Item records</TextLink>
        <h1 className={styles.pageTitle}>Catalog an item</h1>
        <p className={styles.lead}>
          Choose what you are cataloging. The form then asks for what that kind of record needs.
        </p>
      </div>
      <form
        className={styles.panel}
        onSubmit={(event) => {
          event.preventDefault();
          if (chosenTemplate === undefined) return;
          setStarted({
            draft: newDraft(kind, chosenTemplate.template, typeKey),
            template: chosenTemplate.template,
          });
        }}
      >
        <Choice
          label="Kind of record"
          value={kind}
          isRequired
          onChange={(k) => {
            setKind(k);
            setTypeKey("");
            setTemplateKey("");
          }}
          options={kinds.map((k) => ({ id: k, label: KIND_LABELS[k] ?? k }))}
        />
        {kindTypes.length === 0 ? null : (
          <Choice
            label="Record type"
            value={typeKey}
            help="Optional: your organization's own types, such as Photograph or Oral history."
            onChange={(t) => {
              setTypeKey(t);
              setTemplateKey("");
            }}
            options={[
              { id: "", label: "No type" },
              ...kindTypes.map((t) => ({ id: t.key, label: t.label })),
            ]}
          />
        )}
        {kind === "" ? null : kindTemplates.length === 0 ? (
          <Note tone="amber">
            There is no template for this kind of record yet. A system manager adds templates.
          </Note>
        ) : (
          <Choice
            label="Template"
            value={chosenTemplate?.key ?? ""}
            help="The fields the record has."
            onChange={setTemplateKey}
            options={kindTemplates.map((t) => ({ id: t.key, label: t.template.label }))}
          />
        )}
        <div>
          <Button variant="primary" type="submit" isDisabled={chosenTemplate === undefined}>
            Start cataloging
          </Button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Only for a misuse: an editor given neither a record nor a starting form. */
const EMPTY_RECORD = {
  id: "",
  organizationId: "",
  kind: "object",
  title: "",
  createdAt: "",
  updatedAt: "",
  fields: {},
} as const;

interface EditorProps {
  readonly siteId: string;
  readonly userId: string;
  /** The stored record (edit), or none (create, with `initial`). */
  readonly reply?: ReadRecordReply;
  readonly initial?: Draft;
  readonly template: FieldTemplate | undefined;
  readonly templateMissing: boolean;
  readonly recordTypes: readonly RecordTypeSummary[];
  readonly status: Status | undefined;
  readonly setStatus: (status: Status | undefined) => void;
}

function Editor(props: EditorProps) {
  const { reply, template, siteId, setStatus } = props;
  const creating = reply === undefined;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const initial = props.initial;
  const start = useMemo(
    () =>
      reply === undefined || initial !== undefined
        ? (initial ?? draftOf({ ...EMPTY_RECORD }, template))
        : draftOf(reply.record, template),
    [reply, template, initial],
  );
  const [draft, setDraft] = useState<Draft>(start);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [conflict, setConflict] = useState<{ changed: readonly string[] }>();
  const [moveIssues, setMoveIssues] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const lastChecked = useRef("");
  const leaving = useRef(false);

  const can = reply?.can ?? { edit: true, history: false, publish: false, delete: false };
  const state = reply?.state ?? "draft";
  // A published record whose template has no mapping, or one that no
  // longer fits it, isn't on any public site (T-050e, D-096).
  const mappingReply = useDublinCoreMapping(siteId, reply?.record.templateKey);
  const unmapped =
    mappingReply.data !== undefined &&
    template !== undefined &&
    !mappingFits(mappingReply.data, template);
  const dirty = !sameDraft(draft, start, template);
  const readOnly = !can.edit;
  const fieldKeys = useMemo(() => new Set((template?.fields ?? []).map((f) => f.key)), [template]);
  const byTarget = issuesByTarget(issues, fieldKeys);
  const shownErrors = (target: string) =>
    showAll || touched.has(target) ? byTarget.get(target) : undefined;
  const formProblems = showAll ? (byTarget.get("form") ?? []) : [];

  // Leaving with unsaved changes: ask in the app; the browser asks on reload.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  const base = reply === undefined ? "" : `/api/records/${encodeURIComponent(reply.record.id)}`;

  async function check(force = false): Promise<readonly Issue[] | undefined> {
    if (readOnly) return [];
    const body = {
      record: recordDraft(draft, template, reply?.record),
      ...(reply === undefined ? {} : { recordId: reply.record.id }),
    };
    const text = JSON.stringify(body);
    if (!force && text === lastChecked.current) return issues;
    try {
      const answer = await api<{ issues: Issue[] }>("/api/records/check", {
        method: "POST",
        body,
        site: siteId,
      });
      lastChecked.current = text;
      setIssues(answer.issues);
      return answer.issues;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        const found = issuesIn(error.body);
        setIssues(found);
        return found;
      }
      // The check couldn't run: say so, but let the save decide.
      setStatus({ tone: "amber", text: `The fields couldn't be checked. ${problemText(error)}` });
      return undefined;
    }
  }

  function touch(target: string) {
    setTouched((t) => (t.has(target) ? t : new Set([...t, target])));
    void check();
  }

  function update(change: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...change }));
  }

  async function save(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    setStatus(undefined);
    setConflict(undefined);
    setShowAll(true);
    try {
      const found = await check(true);
      if (found !== undefined && found.length > 0) {
        setStatus({
          tone: "amber",
          text: "Not saved yet: fix the problems marked beside the fields.",
        });
        return;
      }
      const record = recordDraft(draft, template, reply?.record);
      if (reply === undefined) {
        const saved = await api<{ record: { id: string }; version: number }>("/api/records", {
          method: "POST",
          body: { record },
          site: siteId,
        });
        const path = recordPath(siteId, saved.record.id);
        leaving.current = true;
        await queries.invalidateQueries({ queryKey: ["items", siteId] });
        if (path !== undefined) {
          await navigate(path, { replace: true, state: { notice: "Saved as a draft." } });
        }
        return;
      }
      await api(base, { method: "PUT", body: { record }, ifMatch: reply.version, site: siteId });
      setStatus({
        tone: "green",
        text: state === "published" ? "Saved. The public site shows the change now." : "Saved.",
      });
      await queries.invalidateQueries({ queryKey: ["items", siteId] });
      await queries.invalidateQueries({ queryKey: recordKey(reply.record.id) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        const differences = (error.body.conflict as { differences?: unknown } | undefined)
          ?.differences;
        const changed = Array.isArray(differences)
          ? differences
              .map((d: unknown) =>
                typeof d === "object" && d !== null ? (d as { name?: unknown }).name : undefined,
              )
              .filter((n): n is string => typeof n === "string")
              .map((n) =>
                n.startsWith("fields.")
                  ? (template?.fields.find((f) => `fields.${f.key}` === n)?.label ?? n.slice(7))
                  : n === "workflowState"
                    ? "status"
                    : n,
              )
          : [];
        setConflict({ changed });
        return;
      }
      const found = error instanceof ApiError ? issuesIn(error.body) : [];
      if (found.length > 0) {
        setIssues(found);
        setStatus({ tone: "amber", text: "Not saved: fix the problems marked beside the fields." });
      } else {
        setStatus({ tone: "amber", text: `Not saved. ${problemText(error)}` });
      }
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (reply === undefined) return;
    setConflict(undefined);
    setStatus({
      tone: "blue",
      text: "Showing the latest saved version. Your changes were discarded.",
    });
    await queries.invalidateQueries({ queryKey: recordKey(reply.record.id) });
  }

  async function move(which: WorkflowMove) {
    if (reply === undefined || busy) return;
    setBusy(true);
    setStatus(undefined);
    setMoveIssues([]);
    try {
      await api(`${base}/${which}`, {
        method: "POST",
        body: {},
        ifMatch: reply.version,
        site: siteId,
      });
      setStatus(
        which === "publish" && unmapped
          ? { tone: "amber", text: PUBLISHED_UNSHOWN }
          : { tone: "green", text: MOVE_DONE[which] },
      );
      await queries.invalidateQueries({ queryKey: ["items", siteId] });
      await queries.invalidateQueries({ queryKey: ["review-queue"] });
      await queries.invalidateQueries({ queryKey: recordKey(reply.record.id) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        setConflict({ changed: [] });
      } else {
        const found = error instanceof ApiError ? issuesIn(error.body) : [];
        if (found.length > 0) {
          setMoveIssues(found.map((i) => i.message));
          setStatus({
            tone: "amber",
            text: which === "publish" ? "Can't publish yet:" : `${MOVE_LABELS[which]} didn't work:`,
          });
        } else {
          setStatus({ tone: "amber", text: problemText(error) });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (reply === undefined) return;
    setBusy(true);
    try {
      await api(base, { method: "DELETE", ifMatch: reply.version, site: siteId });
      leaving.current = true;
      setAskDelete(false);
      queries.removeQueries({ queryKey: recordKey(reply.record.id) });
      await queries.invalidateQueries({ queryKey: ["items", siteId] });
      await navigate(`/sites/${siteId}`, { state: { notice: "The record was deleted." } });
    } catch (error) {
      setAskDelete(false);
      if (error instanceof ApiError && error.status === 412) {
        setConflict({ changed: [] });
      } else {
        const found = error instanceof ApiError ? issuesIn(error.body) : [];
        setStatus({
          tone: "amber",
          text:
            found.length > 0
              ? `Not deleted: ${found.map((i) => i.message).join(" ")}`
              : `Not deleted. ${problemText(error)}`,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const inheritedFor = (key: string) => reply?.inherited.find((v) => v.key === key);
  const typeOptions = props.recordTypes.filter((t) => t.kind === draft.kind);
  const moves = reply === undefined ? [] : offeredMoves(state, can);
  const title = reply?.record.title ?? "New record";

  return (
    <>
      <div className={styles.header}>
        <div>
          <TextLink href={`/sites/${siteId}`}>← Item records</TextLink>
          <h1 className={styles.pageTitle}>{title}</h1>
          <p className={styles.meta}>
            {KIND_LABELS[draft.kind] ?? draft.kind}
            {template === undefined ? "" : ` · ${template.label}`}
            {reply === undefined ? null : <> · Version {String(reply.version)} </>}{" "}
            {reply === undefined ? null : <StatePill state={state} />}
          </p>
        </div>
        {moves.length === 0 ? null : (
          <div className={styles.actions} role="group" aria-label="Status">
            {moves.map((m) => (
              <Button
                key={m}
                variant={m === "publish" ? "primary" : "secondary"}
                isDisabled={busy || dirty}
                onPress={() => void move(m)}
              >
                {MOVE_LABELS[m]}
              </Button>
            ))}
          </div>
        )}
      </div>
      {moves.length > 0 && dirty ? (
        <p className={styles.meta}>Save or discard your changes before changing the status.</p>
      ) : null}
      {unmapped && (state === "published" || can.publish) ? (
        <Note tone="amber">
          {state === "published"
            ? "This record is published, but no public site shows it yet: its template has no Dublin Core mapping that fits it."
            : "If you publish this record, no public site will show it yet: its template has no Dublin Core mapping that fits it."}{" "}
          Someone who may change templates can fix this under Settings, Templates.
        </Note>
      ) : null}

      <div aria-live="polite">
        {props.status === undefined ? null : (
          <Note tone={props.status.tone} alert={props.status.tone === "amber"}>
            {props.status.text}
          </Note>
        )}
        {moveIssues.length === 0 ? null : (
          <ul className={styles.issues}>
            {moveIssues.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmPanel
        isOpen={blocker.state === "blocked"}
        title="Leave without saving?"
        confirmLabel="Leave and discard my changes"
        cancelLabel="Stay on this record"
        danger
        onCancel={() => {
          blocker.reset?.();
        }}
        onConfirm={() => {
          blocker.proceed?.();
        }}
      >
        <p>You have changes to this record that are not saved.</p>
      </ConfirmPanel>
      {conflict === undefined ? null : (
        <div className={styles.panel} role="alert">
          <Note tone="amber">
            Someone else changed this record since you opened it
            {conflict.changed.length === 0 ? "" : ` (${conflict.changed.join(", ")})`}. Nothing was
            overwritten, and your changes here are not saved.
          </Note>
          <div className={styles.actions}>
            <Button variant="dark" onPress={() => void reload()}>
              Reload the latest version
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                setConflict(undefined);
              }}
            >
              Keep my changes on screen
            </Button>
          </div>
          <p className={styles.meta}>
            Reloading discards your changes. To keep them, copy them first, reload, then make them
            again.
          </p>
        </div>
      )}

      {props.templateMissing ? (
        <Note tone="amber">
          This record's template can't be read, so its fields can't be edited here.
        </Note>
      ) : null}

      <div className={reply !== undefined && can.history ? styles.layout : undefined}>
        <form className={styles.panel} onSubmit={(e) => void save(e)} aria-label="Record">
          {readOnly ? (
            <Note tone="blue">You can read this record. Your role doesn't include editing it.</Note>
          ) : null}
          {formProblems.length === 0 ? null : (
            <ul className={styles.issues} role="alert">
              {formProblems.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className={styles.grid}>
            <TextInput
              className={styles.wide}
              label="Title (required)"
              value={draft.title}
              isRequired
              isReadOnly={readOnly}
              onChange={(v) => {
                update({ title: v });
              }}
              onBlur={() => {
                touch("title");
              }}
              errors={shownErrors("title")}
              maxLength={1000}
            />
            {typeOptions.length === 0 && draft.recordTypeKey === "" ? null : (
              <Choice
                label="Record type"
                value={draft.recordTypeKey}
                isDisabled={readOnly}
                errors={shownErrors("recordTypeKey")}
                onChange={(v) => {
                  update({ recordTypeKey: v });
                  touch("recordTypeKey");
                }}
                options={[
                  { id: "", label: "No type" },
                  ...typeOptions.map((t) => ({ id: t.key, label: t.label })),
                  ...(draft.recordTypeKey !== "" &&
                  !typeOptions.some((t) => t.key === draft.recordTypeKey)
                    ? [{ id: draft.recordTypeKey, label: draft.recordTypeKey }]
                    : []),
                ]}
              />
            )}
            {draft.kind === "archival_unit" ? (
              <>
                <Choice
                  label="Level (required)"
                  value={draft.level}
                  isDisabled={readOnly}
                  help="Fonds holds everything from one source; series, collection, file and item sit below."
                  errors={shownErrors("level")}
                  onChange={(v) => {
                    update({ level: v });
                    touch("level");
                  }}
                  options={LEVELS.map((l) => ({
                    id: l,
                    label: l.charAt(0).toUpperCase() + l.slice(1),
                  }))}
                />
                <TextInput
                  label="Filed under (record ID)"
                  help="The ID of the unit this one sits in. Leave empty for a fonds."
                  value={draft.parentId}
                  isReadOnly={readOnly}
                  onChange={(v) => {
                    update({ parentId: v });
                  }}
                  onBlur={() => {
                    touch("parentId");
                  }}
                  errors={shownErrors("parentId")}
                />
              </>
            ) : null}
            {draft.kind === "digital_asset" ? (
              <>
                <TextInput
                  label="File type (required)"
                  help="The media type, such as image/tiff or audio/wav."
                  value={draft.mediaType}
                  isReadOnly={readOnly}
                  onChange={(v) => {
                    update({ mediaType: v });
                  }}
                  onBlur={() => {
                    touch("mediaType");
                  }}
                  errors={shownErrors("mediaType")}
                />
                <TextInput
                  label="Scan of (record ID)"
                  help="The ID of the record this file is a scan or recording of, if any."
                  value={draft.represents}
                  isReadOnly={readOnly}
                  onChange={(v) => {
                    update({ represents: v });
                  }}
                  onBlur={() => {
                    touch("represents");
                  }}
                  errors={shownErrors("represents")}
                />
              </>
            ) : null}
            {draft.kind === "agent" ? (
              <Choice
                label="Person, family or organization"
                value={draft.agentType}
                isDisabled={readOnly}
                errors={shownErrors("agentType")}
                onChange={(v) => {
                  update({ agentType: v });
                  touch("agentType");
                }}
                options={AGENT_TYPES.map((a) => ({
                  id: a,
                  label: a.charAt(0).toUpperCase() + a.slice(1),
                }))}
              />
            ) : null}
            {draft.kind === "place" ? (
              <>
                <TextInput
                  label="Latitude"
                  help="Decimal degrees, such as 29.46."
                  value={draft.lat}
                  isReadOnly={readOnly}
                  onChange={(v) => {
                    update({ lat: v });
                  }}
                  onBlur={() => {
                    touch("coordinates");
                  }}
                  errors={shownErrors("coordinates")}
                />
                <TextInput
                  label="Longitude"
                  help="Decimal degrees, such as -95.05."
                  value={draft.lng}
                  isReadOnly={readOnly}
                  onChange={(v) => {
                    update({ lng: v });
                  }}
                  onBlur={() => {
                    touch("coordinates");
                  }}
                />
              </>
            ) : null}
            {(template?.fields ?? []).map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                siteId={siteId}
                value={draft.fields[field.key] ?? ""}
                isReadOnly={readOnly}
                errors={shownErrors(`fields.${field.key}`)}
                inherited={inheritedFor(field.key)}
                onChange={(value) => {
                  setDraft((d) => ({ ...d, fields: { ...d.fields, [field.key]: value } }));
                }}
                onBlur={() => {
                  touch(`fields.${field.key}`);
                }}
              />
            ))}
          </div>

          {readOnly || props.templateMissing ? null : (
            <>
              {state === "published" ? (
                <Note tone="amber">
                  This record is published. When you save, your changes appear on the public site
                  straight away.
                </Note>
              ) : null}
              <div className={styles.actions}>
                <Button variant="primary" type="submit" isDisabled={busy || (!dirty && !creating)}>
                  {creating
                    ? "Save as a draft"
                    : state === "published"
                      ? "Save and update the public site"
                      : "Save changes"}
                </Button>
                {dirty ? (
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() => {
                      setDraft(start);
                      setIssues([]);
                      setTouched(new Set());
                      setShowAll(false);
                    }}
                  >
                    Discard changes
                  </Button>
                ) : null}
                {busy ? <span role="status">Working…</span> : null}
              </div>
            </>
          )}

          {reply !== undefined && can.delete ? (
            <div className={styles.actions}>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  setAskDelete(true);
                }}
              >
                Delete this record
              </Button>
              {state === "published" ? (
                <span className={styles.meta}>A published record must be unpublished first.</span>
              ) : null}
            </div>
          ) : null}
          <ConfirmPanel
            isOpen={askDelete}
            title="Delete this record?"
            confirmLabel="Delete the record"
            danger
            busy={busy}
            onCancel={() => {
              setAskDelete(false);
            }}
            onConfirm={() => void remove()}
          >
            <p>
              It disappears from the catalog. Its history is kept, but only a system manager can see
              it.
            </p>
          </ConfirmPanel>
        </form>

        {reply !== undefined && can.edit ? (
          <SharingPanel
            key={reply.record.id}
            siteId={siteId}
            recordId={reply.record.id}
            published={state === "published"}
          />
        ) : null}

        {reply?.record.kind === "digital_asset" ? (
          <FilesPanel
            siteId={siteId}
            recordId={reply.record.id}
            version={reply.version}
            canUpload={can.edit}
          />
        ) : null}

        {reply !== undefined && can.history ? (
          <HistoryPanel
            siteId={siteId}
            recordId={reply.record.id}
            currentVersion={reply.version}
            template={template}
            userId={props.userId}
            canRestore={can.edit}
            dirty={dirty}
            onConflict={() => {
              setConflict({ changed: [] });
            }}
            onRestored={(version) => {
              setStatus({
                tone: "green",
                text: `Restored. The record is now at version ${String(version)}.`,
              });
            }}
          />
        ) : null}
      </div>
    </>
  );
}
