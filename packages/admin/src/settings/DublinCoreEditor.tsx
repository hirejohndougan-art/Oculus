/**
 * Settings › Templates › one template › Dublin Core (T-050e, D-096, D-012):
 * which of the template's public fields go out as which DCMI term on the
 * public sites, in Dublin Core and JSON-LD.
 *
 * A template with no stored mapping isn't shown on any public site, even
 * when its records are published (D-096 has no fallback), so the screen
 * says so and offers a start from the terms the fields name in their
 * standards. Saving sends the entries with the version the edit started
 * from (`If-None-Match: *` for the first, `If-Match` after); the server
 * checks them against the template's current version, refuses staff-only
 * fields and a mapping that leaves out the rights where publishing needs
 * them, and asks for confirmation when the change shows on published
 * records at once (D-076). That confirmation is sent only when the person
 * says so.
 *
 * Template text is shown as text by React, never as HTML; the key goes
 * into an address only once it matches core's key rule.
 */
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useBlocker, useOutletContext, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import { Choice, ConfirmPanel } from "../records/controls";
import records from "../records/Records.module.css";
import type { SettingsContext } from "./Settings";
import { useReauthenticated } from "../people/Reauth";
import { Problems, RowButton } from "./Settings";
import { TEMPLATE_KEY, confirmationOf, issuesOf, type Confirmation } from "./templateForm";
import styles from "./Settings.module.css";

/**
 * The DCMI terms a field can go out as: core's `DUBLIN_CORE_TERMS`, in the
 * same order (a test keeps the two in step), with DCMI's labels.
 */
export const DUBLIN_CORE_TERM_LABELS: readonly (readonly [string, string])[] = [
  ["title", "Title"],
  ["alternative", "Alternative title"],
  ["creator", "Creator"],
  ["contributor", "Contributor"],
  ["publisher", "Publisher"],
  ["date", "Date"],
  ["created", "Date created"],
  ["description", "Description"],
  ["abstract", "Abstract"],
  ["type", "Type"],
  ["format", "Format"],
  ["extent", "Extent"],
  ["medium", "Medium"],
  ["identifier", "Identifier"],
  ["bibliographicCitation", "Bibliographic citation"],
  ["source", "Source"],
  ["language", "Language"],
  ["relation", "Relation"],
  ["isPartOf", "Is part of"],
  ["hasPart", "Has part"],
  ["isFormatOf", "Is format of"],
  ["hasFormat", "Has format"],
  ["coverage", "Coverage"],
  ["spatial", "Spatial coverage (places)"],
  ["temporal", "Temporal coverage (periods)"],
  ["subject", "Subject"],
  ["rights", "Rights"],
  ["accessRights", "Access rights"],
  ["license", "License"],
  ["rightsHolder", "Rights holder"],
  ["provenance", "Provenance"],
];

const TERMS: ReadonlySet<string> = new Set(DUBLIN_CORE_TERM_LABELS.map(([t]) => t));

interface MappingReply {
  readonly key: string;
  readonly version: number;
  readonly mapping: unknown;
  readonly publishedRecords?: readonly string[];
  /** How many published records it showed on (past the list's limit too, S-039). */
  readonly publishedRecordCount?: number;
}

interface TemplateReply {
  readonly key: string;
  readonly version: number;
  readonly template: unknown;
}

/** A template field as this screen needs it. */
export interface MappableField {
  readonly key: string;
  readonly label: string;
  readonly isPublic: boolean;
  /** The DCMI terms its `standards` name (`dcterms`). */
  readonly suggested: readonly string[];
}

export interface EntryDraft {
  readonly uid: number;
  readonly field: string;
  readonly term: string;
}

let nextUid = 1;

const isPlain = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The template's fields, read defensively (anything odd is left out). */
export function mappableFields(template: unknown): readonly MappableField[] {
  if (!isPlain(template) || !Array.isArray(template.fields)) return [];
  const out: MappableField[] = [];
  for (const f of template.fields as unknown[]) {
    if (!isPlain(f) || typeof f.key !== "string") continue;
    const standards = Array.isArray(f.standards) ? (f.standards as unknown[]) : [];
    out.push({
      key: f.key,
      label: typeof f.label === "string" && f.label !== "" ? f.label : f.key,
      isPublic: f.visibility === "public",
      suggested: standards.flatMap((s) =>
        isPlain(s) &&
        s.standard === "dcterms" &&
        typeof s.element === "string" &&
        TERMS.has(s.element)
          ? [s.element]
          : [],
      ),
    });
  }
  return out;
}

/** The stored mapping's entries as rows, read defensively. */
export function entryDrafts(mapping: unknown): EntryDraft[] {
  if (!isPlain(mapping) || !Array.isArray(mapping.entries)) return [];
  return (mapping.entries as unknown[]).flatMap((e) =>
    isPlain(e) && typeof e.field === "string" && typeof e.term === "string"
      ? [{ uid: nextUid++, field: e.field, term: e.term }]
      : [],
  );
}

/**
 * A start for a template with no mapping: each public field as the terms
 * its standards name, and a rights field as `rights` when its standards
 * name none. Staff-only fields are never suggested.
 */
export function suggestedEntries(fields: readonly MappableField[]): EntryDraft[] {
  return fields
    .filter((f) => f.isPublic)
    .flatMap((f) => {
      const terms = f.suggested.length > 0 ? f.suggested : f.key === "rights" ? ["rights"] : [];
      return [...new Set(terms)].map((term) => ({ uid: nextUid++, field: f.key, term }));
    });
}

/** The entries as the server takes them; blank rows are left out. */
export function entriesToSend(rows: readonly EntryDraft[]): { field: string; term: string }[] {
  return rows
    .filter((r) => r.field !== "" && r.term !== "")
    .map((r) => ({
      field: r.field,
      term: r.term,
    }));
}

/** One line per problem the server found, naming the row when it says which. */
export function mappingIssueLines(
  body: Readonly<Record<string, unknown>>,
  sent: readonly { field: string }[],
  fields: readonly MappableField[],
): string[] {
  return issuesOf(body).map((i) => {
    const [first, index] = i.path;
    if (first === "entries" && typeof index === "number") {
      const field = sent[index]?.field;
      const name = fields.find((f) => f.key === field)?.label ?? field ?? "";
      return `Row ${String(index + 1)}${name === "" ? "" : ` (${name})`}: ${i.message}`;
    }
    return i.message;
  });
}

/** Settings › Templates › one template › Dublin Core. */
export function DublinCoreScreen() {
  const { me } = useOutletContext<SettingsContext>();
  const { key = "" } = useParams();
  const known = TEMPLATE_KEY.test(key);
  // Kept here: the form is made again for each version, so its own state goes.
  const [saved, setSaved] = useState<{ key: string; version: number; shownOn: number }>();
  const template = useQuery({
    queryKey: ["system-template", me.organizationId, key],
    queryFn: () => api<TemplateReply>(`/api/templates/${key}`),
    enabled: known,
    refetchOnReconnect: false,
  });
  const mapping = useQuery({
    queryKey: ["dublin-core", me.organizationId, key],
    queryFn: () => api<MappingReply>(`/api/templates/${key}/dublin-core`),
    enabled: known,
    // The form starts fresh for each version: a background refetch would drop edits.
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const missing =
    !known ||
    (template.error instanceof ApiError && template.error.status === 404) ||
    (mapping.error instanceof ApiError && mapping.error.status === 404);
  if (missing) {
    return (
      <Note tone="amber">
        There is no template with that key in {me.organizationName}.{" "}
        <TextLink href="/settings/templates">Back to the templates</TextLink>
      </Note>
    );
  }
  if (template.data === undefined || mapping.data === undefined) {
    const error = template.error ?? mapping.error;
    return error === null ? <p role="status">Loading…</p> : <Problems error={error} />;
  }
  return (
    <MappingForm
      key={`${key}-${String(template.data.version)}-${String(mapping.data.version)}`}
      organizationId={me.organizationId}
      templateKey={key}
      template={template.data}
      stored={mapping.data}
      justSaved={saved?.key === key && saved.version === mapping.data.version ? saved : undefined}
      onSaved={(done) => {
        setSaved({ key, ...done });
      }}
    />
  );
}

function MappingForm(props: {
  readonly organizationId: string;
  readonly templateKey: string;
  readonly template: TemplateReply;
  readonly stored: MappingReply;
  /** This person just saved the version shown, which showed on `shownOn` published records. */
  readonly justSaved?: { readonly shownOn: number } | undefined;
  readonly onSaved: (saved: { version: number; shownOn: number }) => void;
}) {
  const { organizationId, templateKey, template, stored } = props;
  const queries = useQueryClient();
  const fields = mappableFields(template.template);
  const templateName =
    isPlain(template.template) && typeof template.template.label === "string"
      ? template.template.label
      : templateKey;
  const hasMapping = stored.version > 0;
  const [rows, setRows] = useState<EntryDraft[]>(() => entryDrafts(stored.mapping));
  const [edited, setEdited] = useState(false);
  const [asked, setAsked] = useState<Confirmation>();
  const [sent, setSent] = useState<readonly { field: string }[]>([]);
  const saved = edited ? undefined : props.justSaved;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      edited && currentLocation.pathname !== nextLocation.pathname,
  );
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
    mutationFn: (confirmation: Confirmation | undefined) => {
      const entries = entriesToSend(rows);
      setSent(entries);
      return api<MappingReply>(`/api/templates/${templateKey}/dublin-core`, {
        method: "PUT",
        body: {
          mapping: { entries },
          ...(confirmation === undefined || confirmation.publishedRecords === 0
            ? {}
            : confirmation.counted === true
              ? { confirmPublishedCount: confirmation.publishedRecords }
              : { confirmPublished: true }),
        },
        ...(hasMapping ? { ifMatch: stored.version } : { ifNoneMatch: true }),
      });
    },
    onSuccess: async (reply) => {
      setAsked(undefined);
      props.onSaved({
        version: reply.version,
        shownOn: reply.publishedRecordCount ?? reply.publishedRecords?.length ?? 0,
      });
      // The form is made again for the new version, from this reply.
      queries.setQueryData(["dublin-core", organizationId, templateKey], {
        key: reply.key,
        version: reply.version,
        mapping: reply.mapping,
      });
      // The record editor's "no mapping yet" note reads this too.
      await queries.invalidateQueries({ queryKey: ["dublin-core-status", organizationId] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.code === "confirmation_required")) return;
      setAsked(confirmationOf(issuesOf(error.body)));
    },
  });

  // Saving needs a recent sign-in (S-060a): the server asks for the password
  // and a code again, and the save runs again once they're entered.
  const reauth = useReauthenticated("For changes to what the public sites show");
  // Each change to the draft starts a new generation: a save asked for an
  // earlier one (waiting for the password form, or answered by it after the
  // change) is dropped, never sent with the new draft (S-060a review).
  const generation = useRef(0);
  function send(confirmation: Confirmation | undefined) {
    const asked = generation.current;
    void reauth
      .run(async () => {
        if (generation.current !== asked) return;
        await save.mutateAsync(confirmation);
      })
      .catch(() => undefined);
  }

  const error = save.error;
  const conflict = error instanceof ApiError && error.status === 412;
  const confirming = error instanceof ApiError && error.code === "confirmation_required";
  const lines =
    error instanceof ApiError && error.code === "invalid"
      ? mappingIssueLines(error.body, sent, fields)
      : [];

  function change(next: EntryDraft[]) {
    setEdited(true);
    setAsked(undefined);
    // A save waiting for the password form was for the draft as it was.
    generation.current += 1;
    reauth.cancel();
    if (save.error !== null) save.reset();
    setRows(next);
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    send(undefined);
  }

  const fieldOptions = [
    ...fields.filter((f) => f.isPublic).map((f) => ({ id: f.key, label: `${f.label} (${f.key})` })),
    // A stored entry for a field that isn't public (or no longer exists)
    // stays visible, so the person can see it and remove it.
    ...[...new Set(rows.map((r) => r.field))]
      .filter((k) => k !== "" && !fields.some((f) => f.isPublic && f.key === k))
      .map((k) => {
        const f = fields.find((x) => x.key === k);
        return {
          id: k,
          label: `${f?.label ?? k} (${k}): ${f === undefined ? "not in this template" : "staff only, can't be published"}`,
        };
      }),
  ];
  const termOptions = DUBLIN_CORE_TERM_LABELS.map(([id, label]) => ({ id, label }));
  const suggestions = suggestedEntries(fields);
  const noPublicFields = !fields.some((f) => f.isPublic);

  return (
    <>
      <form className={records.layout} onSubmit={submit} aria-label="Dublin Core mapping">
        <div className={records.panel}>
          <div>
            <TextLink href={`/settings/templates/${templateKey}`}>← {templateName}</TextLink>
            <h2 className={records.sectionTitle}>Dublin Core for {templateName}</h2>
            <p className={records.meta}>
              Public sites share each published record&apos;s public fields as Dublin Core, so other
              catalogs and search engines can read them. Choose which field goes out as which term.
              The record&apos;s title always goes out as Title. Staff-only fields are never shared.
            </p>
            {hasMapping ? <p className={records.meta}>Version {stored.version}</p> : null}
          </div>
          {hasMapping ? null : (
            <Note tone="amber">
              This template has no Dublin Core mapping yet, so no public site shows its records,
              even published ones. Save a mapping to show them.
            </Note>
          )}
          {noPublicFields ? (
            <p className={records.meta}>
              {hasMapping
                ? "This template has no public fields left. Remove the mapped fields and save, or make a field public in the template again. If its records need their rights to be published, make the rights field public again: a mapping without it can't be saved."
                : "This template has no public fields yet. Make a field public in the template first."}
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className={records.meta}>No fields are mapped yet.</p>
          ) : (
            <ol className={styles.fieldList} aria-label="Mapped fields">
              {rows.map((row, index) => (
                <li key={row.uid} className={styles.row}>
                  <Choice
                    className={styles.grow}
                    label={`Row ${String(index + 1)}: field`}
                    value={row.field}
                    options={fieldOptions}
                    onChange={(v) => {
                      change(rows.map((r) => (r.uid === row.uid ? { ...r, field: v } : r)));
                    }}
                  />
                  <Choice
                    className={styles.grow}
                    label={`Row ${String(index + 1)}: goes out as`}
                    value={row.term}
                    options={termOptions}
                    onChange={(v) => {
                      change(rows.map((r) => (r.uid === row.uid ? { ...r, term: v } : r)));
                    }}
                  />
                  <RowButton
                    label={`Remove row ${String(index + 1)}`}
                    onPress={() => {
                      change(rows.filter((r) => r.uid !== row.uid));
                    }}
                  >
                    Remove
                  </RowButton>
                </li>
              ))}
            </ol>
          )}
          <div className={records.actions}>
            <Button
              variant="secondary"
              isDisabled={noPublicFields}
              onPress={() => {
                change([...rows, { uid: nextUid++, field: "", term: "" }]);
              }}
            >
              + Map a field
            </Button>
            {rows.length === 0 && suggestions.length > 0 ? (
              <Button
                variant="secondary"
                onPress={() => {
                  change(suggestions);
                }}
              >
                Fill in from the fields&apos; standards
              </Button>
            ) : null}
          </div>
        </div>

        <div className={records.panel}>
          <h2 className={records.sectionTitle}>Save</h2>
          <p className={records.meta}>
            The server checks the mapping against the template before saving. If records using this
            template are published, the change shows on the public sites at once, and you&apos;re
            asked to confirm first.
          </p>
          {conflict ? (
            <div role="alert">
              <Note tone="amber">
                Someone else saved this mapping while you were editing. Your changes weren&apos;t
                saved.{" "}
                <Button
                  variant="link"
                  onPress={() => {
                    void queries.invalidateQueries({
                      queryKey: ["dublin-core", organizationId, templateKey],
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
                {"The mapping wasn't saved. These need fixing:"}
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
          {saved === undefined ? null : (
            <div aria-live="polite">
              <Note tone="green">
                Saved.
                {saved.shownOn > 0
                  ? ` The public sites show it now on ${String(saved.shownOn)} published ${saved.shownOn === 1 ? "record" : "records"}.`
                  : ""}
              </Note>
            </div>
          )}
          <ConfirmPanel
            isOpen={blocker.state === "blocked"}
            title="Leave without saving?"
            confirmLabel="Leave and discard my changes"
            cancelLabel="Stay on this mapping"
            danger
            onCancel={() => {
              blocker.reset?.();
            }}
            onConfirm={() => {
              blocker.proceed?.();
            }}
          >
            <p>You have changes to this mapping that are not saved.</p>
          </ConfirmPanel>
          <ConfirmPanel
            isOpen={asked !== undefined}
            title="Confirm this change"
            confirmLabel="Save and update the public sites"
            busy={save.isPending}
            onConfirm={() => {
              send(asked);
            }}
            onCancel={() => {
              setAsked(undefined);
              save.reset();
            }}
          >
            {/* A status, so a new number on a second ask is announced too (S-039 review). */}
            <p role="status">
              This change shows at once on {(asked?.publishedRecords ?? 0).toLocaleString()}{" "}
              published {asked?.publishedRecords === 1 ? "record" : "records"} using this template.
            </p>
            {asked?.counted === true ? (
              <p>
                That is too many to list one by one, so check the mapping itself before you save. If
                records are published or unpublished meanwhile, you will be asked again with the new
                number.
              </p>
            ) : null}
          </ConfirmPanel>
          <div className={records.actions}>
            <Button
              type="submit"
              variant="primary"
              isDisabled={save.isPending || (noPublicFields && !hasMapping)}
            >
              Save mapping
            </Button>
            <TextLink href={`/settings/templates/${templateKey}`}>Back to the template</TextLink>
          </div>
        </div>
      </form>
      {/* Outside the editor's form: a form can't hold another (S-060a). */}
      {reauth.form}
    </>
  );
}
