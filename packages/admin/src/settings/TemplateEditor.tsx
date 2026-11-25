/**
 * Settings › Templates (T-048a, D-010, D-072, D-076): the templates of the
 * organization the session works in, and an editor for one template's
 * fields.
 *
 * Saving sends the whole template with the version the edit started from
 * (`If-Match`, or `If-None-Match: *` for a new key). The server checks it
 * and may answer that the change needs confirming (fields records use,
 * values that would show at once on published records): the editor lists
 * what it said and sends the same template again with the confirmations
 * only when the person says so. An edit made on an old copy is refused, and
 * the editor offers the latest version instead of overwriting it.
 *
 * Template text (labels, help, keys) is shown as text by React, never as
 * HTML; a key goes into an address only once it matches core's key rule.
 */
import { useState, type SubmitEvent } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckboxButton, CheckboxField } from "react-aria-components";
import { ApiError, api } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import { Choice, ConfirmPanel, TextInput } from "../records/controls";
import { FIELD_KINDS, KIND_LABELS, RECORD_KINDS } from "../records/model";
import records from "../records/Records.module.css";
import type { SettingsContext } from "./Settings";
import { Problems, RowButton } from "./Settings";
import {
  KIND_NAMES,
  TEMPLATE_KEY,
  confirmationOf,
  issueLine,
  issuesOf,
  moved,
  newFieldDraft,
  newTemplateDraft,
  templateDraft,
  templateFromDraft,
  type Confirmation,
  type FieldDraft,
  type TemplateDraft,
} from "./templateForm";
import styles from "./Settings.module.css";

interface TemplateReply {
  readonly key: string;
  readonly version: number;
  readonly template: unknown;
}

/** The field key rule (core's `isFieldKey`). */
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;

const templatesKey = (organizationId: string) => ["system-templates", organizationId] as const;

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

function kindsText(kinds: unknown): string {
  if (!Array.isArray(kinds)) return "";
  return (kinds as unknown[])
    .map((k) => (typeof k === "string" ? (KIND_LABELS[k] ?? k) : ""))
    .filter((k) => k !== "")
    .join(", ");
}

/** Settings › Templates: the list. */
export function TemplateList() {
  const { me } = useOutletContext<SettingsContext>();
  const list = useQuery({
    queryKey: templatesKey(me.organizationId),
    queryFn: async () => (await api<{ templates: TemplateReply[] }>("/api/templates")).templates,
  });
  return (
    <section className={records.panel} aria-labelledby="templates-list">
      <div className={records.header}>
        <div>
          <h2 id="templates-list" className={records.sectionTitle}>
            Templates of {me.organizationName}
          </h2>
          <p className={records.meta}>
            A template says which fields a kind of record has. Each organization has its own; to
            change another organization's, work in one of its sites first.
          </p>
        </div>
        <TextLink href="/settings/new-template">+ New template</TextLink>
      </div>
      {list.data === undefined ? (
        list.error === null ? (
          <p role="status">Loading…</p>
        ) : (
          <Problems error={list.error} />
        )
      ) : list.data.length === 0 ? (
        <p className={records.meta}>This organization has no templates yet.</p>
      ) : (
        <div className={records.tableWrap}>
          <table className={records.table}>
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">For</th>
                <th scope="col">Fields</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => {
                const template = (t.template ?? {}) as {
                  label?: unknown;
                  appliesTo?: unknown;
                  fields?: unknown;
                };
                const label = typeof template.label === "string" ? template.label : t.key;
                return (
                  <tr key={t.key}>
                    <td>
                      {TEMPLATE_KEY.test(t.key) ? (
                        <TextLink href={`/settings/templates/${t.key}`}>{label}</TextLink>
                      ) : (
                        label
                      )}
                      <div className={styles.muted}>{t.key}</div>
                    </td>
                    <td>{kindsText(template.appliesTo)}</td>
                    <td>{Array.isArray(template.fields) ? template.fields.length : 0}</td>
                    <td>{t.version}</td>
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

/** Settings › Templates › one template (or a new one). */
export function TemplateScreen(props: { readonly isNew?: boolean }) {
  const { me } = useOutletContext<SettingsContext>();
  const { key = "" } = useParams();
  const known = props.isNew !== true && TEMPLATE_KEY.test(key);
  const [savedVersion, setSavedVersion] = useState<number>();
  const read = useQuery({
    queryKey: ["system-template", me.organizationId, key],
    queryFn: () => api<TemplateReply>(`/api/templates/${key}`),
    enabled: known,
  });
  if (props.isNew === true) {
    return <TemplateForm key="new" organizationId={me.organizationId} />;
  }
  const missing = !known || (read.error instanceof ApiError && read.error.status === 404);
  if (missing) {
    return (
      <Note tone="amber">
        There is no template with that key in {me.organizationName}.{" "}
        <TextLink href="/settings/templates">Back to the templates</TextLink>
      </Note>
    );
  }
  if (read.data === undefined) {
    return read.error === null ? <p role="status">Loading…</p> : <Problems error={read.error} />;
  }
  return (
    <TemplateForm
      key={`${read.data.key}-${String(read.data.version)}`}
      organizationId={me.organizationId}
      stored={read.data}
      justSaved={savedVersion === read.data.version}
      onSaved={setSavedVersion}
    />
  );
}

function TemplateForm(props: {
  readonly organizationId: string;
  readonly stored?: TemplateReply;
  /** The version shown is the one this person just saved (the form is new for each version). */
  readonly justSaved?: boolean;
  readonly onSaved?: (version: number) => void;
}) {
  const { stored, organizationId } = props;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    stored === undefined ? newTemplateDraft(organizationId) : templateDraft(stored.template),
  );
  const [asked, setAsked] = useState<Confirmation>();
  const [edited, setEdited] = useState(false);
  const saved = props.justSaved === true && !edited;
  const key = stored?.key ?? newKey.trim();

  const save = useMutation({
    mutationFn: (confirmation: Confirmation | undefined) =>
      api<TemplateReply>(`/api/templates/${key}`, {
        method: "PUT",
        body: {
          template: templateFromDraft(draft),
          ...(confirmation === undefined
            ? {}
            : {
                confirm: confirmation.confirm,
                ...(confirmation.publishedRecords > 0 ? { confirmPublished: true } : {}),
              }),
        },
        ...(stored === undefined ? { ifNoneMatch: true } : { ifMatch: stored.version }),
      }),
    onSuccess: async (reply) => {
      setAsked(undefined);
      // The record editor's copy of the templates is out of date too.
      await queries.invalidateQueries({ queryKey: templatesKey(organizationId) });
      await queries.invalidateQueries({ queryKey: ["templates", organizationId] });
      props.onSaved?.(reply.version);
      queries.setQueryData(["system-template", organizationId, reply.key], reply);
      if (stored === undefined) {
        await navigate(`/settings/templates/${reply.key}`, { replace: true });
      }
    },
    onError: (error, sent) => {
      if (!(error instanceof ApiError && error.code === "confirmation_required")) return;
      const next = confirmationOf(issuesOf(error.body));
      // Confirmed changes and then asked about published records: the
      // changes stay confirmed (the server wants exactly that set again).
      setAsked(
        next.confirm.length === 0 && sent !== undefined
          ? { ...next, confirm: sent.confirm, messages: sent.messages }
          : next,
      );
    },
  });

  const error = save.error;
  const conflict = error instanceof ApiError && error.status === 412;
  const confirming = error instanceof ApiError && error.code === "confirmation_required";
  const keyProblem =
    stored === undefined && newKey !== "" && !TEMPLATE_KEY.test(newKey.trim())
      ? "Use 1 to 64 lower case letters, digits, hyphens and underscores, starting with a letter."
      : undefined;

  function change(next: Partial<TemplateDraft>) {
    setEdited(true);
    setAsked(undefined);
    if (save.error !== null) save.reset();
    setDraft((d) => ({ ...d, ...next }));
  }
  function changeField(index: number, next: Partial<FieldDraft>) {
    change({ fields: draft.fields.map((f, i) => (i === index ? { ...f, ...next } : f)) });
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!TEMPLATE_KEY.test(key)) return;
    save.mutate(undefined);
  }

  const lines =
    error instanceof ApiError && error.code === "invalid"
      ? issuesOf(error.body).map((i) => issueLine(i, draft.fields))
      : [];

  return (
    <form className={records.layout} onSubmit={submit} aria-label="Template">
      <div className={records.panel}>
        <div>
          <h2 className={records.sectionTitle}>
            {stored === undefined ? "New template" : draft.label || stored.key}
          </h2>
          {stored === undefined ? null : (
            <p className={records.meta}>
              Key {stored.key} · version {stored.version}
            </p>
          )}
        </div>
        <div className={records.grid}>
          {stored === undefined ? (
            <TextInput
              label="Key"
              value={newKey}
              onChange={(v) => {
                setNewKey(v);
                change({});
              }}
              isRequired
              maxLength={64}
              help="Records name their template by this. It can't change later."
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
          />
          <TextInput
            className={records.wide}
            label="Description"
            value={draft.description}
            onChange={(v) => {
              change({ description: v });
            }}
            multiline
            help="Optional. Shown to staff choosing a template."
          />
        </div>
        <fieldset className={records.fieldset}>
          <legend className={records.legend}>Used for</legend>
          <div className={styles.checks}>
            {RECORD_KINDS.map((kind) => (
              <Check
                key={kind}
                label={KIND_LABELS[kind] ?? kind}
                isSelected={draft.appliesTo.includes(kind)}
                onChange={(on) => {
                  change({
                    appliesTo: on
                      ? [...draft.appliesTo, kind]
                      : draft.appliesTo.filter((k) => k !== kind),
                  });
                }}
              />
            ))}
          </div>
        </fieldset>

        <h3 className={records.sectionTitle}>Fields</h3>
        {draft.fields.length === 0 ? (
          <p className={records.meta}>No fields yet.</p>
        ) : (
          <ol className={styles.fieldList} aria-label="Fields">
            {draft.fields.map((field, index) => (
              <li key={field.uid}>
                <FieldCard
                  field={field}
                  index={index}
                  count={draft.fields.length}
                  onChange={(next) => {
                    changeField(index, next);
                  }}
                  onMove={(step) => {
                    change({ fields: moved(draft.fields, index, step) });
                  }}
                  onRemove={() => {
                    change({ fields: draft.fields.filter((_, i) => i !== index) });
                  }}
                />
              </li>
            ))}
          </ol>
        )}
        <div>
          <Button
            variant="secondary"
            onPress={() => {
              change({ fields: [...draft.fields, newFieldDraft()] });
            }}
          >
            + Add a field
          </Button>
        </div>
      </div>

      <div className={records.panel}>
        <h2 className={records.sectionTitle}>Save</h2>
        <p className={records.meta}>
          The server checks the template before saving. Changes to fields records already use, and
          changes that show values on published records, are listed for you to confirm first.
        </p>
        {conflict ? (
          <div role="alert">
            <Note tone="amber">
              Someone else saved this template while you were editing. Your changes weren't saved.{" "}
              <Button
                variant="link"
                onPress={() => {
                  void queries.invalidateQueries({
                    queryKey: ["system-template", organizationId, key],
                  });
                }}
              >
                Load the latest version
              </Button>
            </Note>
          </div>
        ) : lines.length > 0 ? (
          <div role="alert">
            <Note tone="amber">
              {"The template wasn't saved. These need fixing:"}
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
            <Note tone="green">Saved.</Note>
          </div>
        ) : null}
        <ConfirmPanel
          isOpen={asked !== undefined}
          title="Confirm these changes"
          confirmLabel="Save with these changes"
          busy={save.isPending}
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
                This change shows values at once on {asked.publishedRecords} published{" "}
                {asked.publishedRecords === 1 ? "record" : "records"}.
              </li>
            ) : null}
          </ul>
        </ConfirmPanel>
        <div className={records.actions}>
          <Button
            type="submit"
            variant="primary"
            isDisabled={save.isPending || !TEMPLATE_KEY.test(key)}
          >
            {stored === undefined ? "Create template" : "Save template"}
          </Button>
          <TextLink href="/settings/templates">Back to the templates</TextLink>
        </div>
      </div>
    </form>
  );
}

function FieldCard(props: {
  readonly field: FieldDraft;
  readonly index: number;
  readonly count: number;
  readonly onChange: (next: Partial<FieldDraft>) => void;
  readonly onMove: (step: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { field, index, count, onChange } = props;
  const name = field.label.trim() || field.key || `Field ${String(index + 1)}`;
  const keyProblem =
    field.isNew && field.key !== "" && !FIELD_KEY.test(field.key.trim())
      ? "Use 1 to 64 lower case letters, digits and underscores, starting with a letter."
      : undefined;
  return (
    <section className={styles.fieldCard} aria-label={name}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldName}>{name}</span>
        <div className={records.actions}>
          <RowButton
            label={`Move up ${name}`}
            isDisabled={index === 0}
            onPress={() => {
              props.onMove(-1);
            }}
          >
            Move up
          </RowButton>
          <RowButton
            label={`Move down ${name}`}
            isDisabled={index === count - 1}
            onPress={() => {
              props.onMove(1);
            }}
          >
            Move down
          </RowButton>
          <RowButton label={`Remove ${name}`} onPress={props.onRemove}>
            Remove
          </RowButton>
        </div>
      </div>
      <div className={records.grid}>
        <TextInput
          label="Key"
          value={field.key}
          onChange={(v) => {
            onChange({ key: v });
          }}
          isReadOnly={!field.isNew}
          isRequired
          maxLength={64}
          help={
            field.isNew
              ? "Records store the value under this. It can't change once saved."
              : "Records store the value under this, so it can't change."
          }
          errors={keyProblem === undefined ? undefined : [keyProblem]}
        />
        <TextInput
          label="Label"
          value={field.label}
          onChange={(v) => {
            onChange({ label: v });
          }}
          isRequired
          maxLength={200}
        />
        <Choice
          label="Kind"
          value={field.kind}
          options={FIELD_KINDS.map((k) => ({ id: k, label: KIND_NAMES[k] }))}
          onChange={(v) => {
            const kind = FIELD_KINDS.find((k) => k === v);
            if (kind !== undefined) onChange({ kind });
          }}
        />
        <Choice
          label="Who sees it"
          value={field.visibility}
          options={[
            { id: "staff", label: "Staff only" },
            { id: "public", label: "Public, once published" },
          ]}
          onChange={(v) => {
            onChange({ visibility: v === "public" ? "public" : "staff" });
          }}
        />
        <TextInput
          className={records.wide}
          label="Help"
          value={field.help}
          onChange={(v) => {
            onChange({ help: v });
          }}
          multiline
          help="Optional. Shown beside the field in the record editor."
        />
      </div>
      <div className={styles.checks}>
        <Check
          label="Required"
          isSelected={field.required}
          onChange={(v) => {
            onChange({ required: v });
          }}
        />
        <Check
          label="Can repeat"
          isSelected={field.repeatable}
          onChange={(v) => {
            onChange({ repeatable: v });
          }}
        />
        <Check
          label="Passed down to lower levels"
          isSelected={field.inherited}
          onChange={(v) => {
            onChange({ inherited: v });
          }}
        />
      </div>
      {field.kind === "text" || field.kind === "long_text" ? (
        <TextInput
          label="Longest value allowed (characters)"
          value={field.maxLength}
          onChange={(v) => {
            onChange({ maxLength: v });
          }}
          help="Optional. Leave empty for the usual limit."
        />
      ) : null}
      {field.kind === "list" ? <OptionsEditor field={field} onChange={onChange} /> : null}
    </section>
  );
}

function OptionsEditor(props: {
  readonly field: FieldDraft;
  readonly onChange: (next: Partial<FieldDraft>) => void;
}) {
  const { field, onChange } = props;
  const set = (index: number, next: Partial<{ value: string; label: string }>) => {
    onChange({ options: field.options.map((o, i) => (i === index ? { ...o, ...next } : o)) });
  };
  return (
    <fieldset className={records.fieldset}>
      <legend className={records.legend}>Choices</legend>
      {field.options.length === 0 ? <p className={records.meta}>No choices yet.</p> : null}
      {field.options.map((option, index) => (
        <div key={index} className={styles.row}>
          <TextInput
            className={styles.grow}
            label={`Choice ${String(index + 1)}: stored as`}
            value={option.value}
            onChange={(v) => {
              set(index, { value: v });
            }}
            isRequired
          />
          <TextInput
            className={styles.grow}
            label={`Choice ${String(index + 1)}: shown as`}
            value={option.label}
            onChange={(v) => {
              set(index, { label: v });
            }}
            isRequired
          />
          <RowButton
            label={`Remove choice ${String(index + 1)}`}
            onPress={() => {
              onChange({ options: field.options.filter((_, i) => i !== index) });
            }}
          >
            Remove
          </RowButton>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          onPress={() => {
            onChange({ options: [...field.options, { value: "", label: "" }] });
          }}
        >
          + Add a choice
        </Button>
      </div>
    </fieldset>
  );
}
