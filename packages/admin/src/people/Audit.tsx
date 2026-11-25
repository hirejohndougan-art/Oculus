/**
 * The audit trail (T-048): the organization's change log, newest first,
 * as far as the person may see it (the server filters, D-084), filtered by
 * person, record and dates, a page at a time. System managers also see
 * installs and rollbacks of Oculus itself (T-060a).
 */
import { useState, type SubmitEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router";
import { api, problemText } from "../api";
import { Button, Field, Note } from "../components/ui";
import type { FrameContext } from "../frame/Frame";
import frame from "../frame/Frame.module.css";
import styles from "./People.module.css";
import { grantText, refused, siteNames, usePeople } from "./shared";
import { when, type AuditEntry, type AuditPage } from "./types";

interface Filter {
  readonly person: string;
  readonly record: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY: Filter = { person: "", record: "", from: "", to: "" };

/** The day after `day` (YYYY-MM-DD): "to" is inclusive on the screen, exclusive on the server. */
function dayAfter(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) ? day : new Date(time + 86_400_000).toISOString().slice(0, 10);
}

function query(filter: Filter, after: string | null): string {
  const params = new URLSearchParams();
  if (filter.person !== "") params.set("person", filter.person);
  if (filter.record.trim() !== "") params.set("record", filter.record.trim().toLowerCase());
  if (filter.from !== "") params.set("from", filter.from);
  if (filter.to !== "") params.set("to", dayAfter(filter.to));
  if (after !== null) params.set("after", after);
  params.set("limit", "50");
  return `/api/audit?${params.toString()}`;
}

const ACTIONS: Readonly<Record<string, string>> = {
  save: "Saved",
  delete: "Deleted",
  submit_for_review: "Sent for review",
  return_to_draft: "Returned to draft",
  publish: "Published",
  withdraw: "Unpublished",
};

const EVENTS: Readonly<Record<string, string>> = {
  invited: "Invited",
  account_disabled: "Disabled the account of",
  account_enabled: "Enabled the account of",
  role_granted: "Gave a role to",
  role_revoked: "Removed a role from",
  second_factor_reset: "Reset two-step sign-in of",
  password_reset_sent: "Sent a password reset link to",
  sessions_ended: "Signed out everywhere:",
};

const SYSTEM_EVENTS: Readonly<Record<string, string>> = {
  update_installed: "Installed Oculus",
  update_rolled_back: "Went back to Oculus",
};

/** A purge step's change (S-052). */
const FILE_EVENTS: Readonly<Record<string, string>> = {
  files_trashed: "Moved removed files to the trash:",
  files_deleted: "Deleted removed files from the trash:",
  files_restored: "Put files back from the trash:",
};

/** What a definition line is about (S-064). */
const SUBJECTS: Readonly<Record<string, string>> = {
  identifier_type: "the identifier type",
  term: "the term",
  site: "the site",
  storage_levels: "the storage levels",
  storage_location: "the storage location",
  dublin_core_mapping: "the Dublin Core mapping of template",
  system_settings: "the System settings",
};

const SHARE_STEPS: Readonly<Record<string, string>> = {
  offered: "Offered to share",
  accepted: "Accepted the share of",
  declined: "Declined the share of",
  withdrawn: "Withdrew the share of",
  removed: "Removed the share of",
  deleted: "Ended the share (record deleted) of",
  moved: "Ended the share (record moved) of",
};

function recordName(title: string | null): string {
  return title === null ? "a deleted record" : `“${title}”`;
}

function definitionText(
  entry: Extract<AuditEntry, { type: "definition" }>,
  sites: ReadonlyMap<string, string>,
): string {
  const verb = entry.action === "created" ? "Added" : "Changed";
  const subject = SUBJECTS[entry.subject] ?? entry.subject;
  const name =
    entry.name ??
    (entry.subject === "site" && entry.key !== null ? sites.get(entry.key) : undefined) ??
    entry.key;
  return name === null ? `${verb} ${subject}` : `${verb} ${subject} “${name}”`;
}

function what(entry: AuditEntry, sites: ReadonlyMap<string, string>): string {
  if (entry.type === "definition") return definitionText(entry, sites);
  if (entry.type === "file") {
    const kb = Math.max(1, Math.round(entry.bytes / 1024));
    return `${entry.kind === "removed" ? "Removed a file from" : "Attached a file to"} ${recordName(entry.title)} (${String(kb)} KB)`;
  }
  if (entry.type === "move") {
    return `Moved ${recordName(entry.title)} to ${entry.locationName === null ? "a location" : `“${entry.locationName}”`}`;
  }
  if (entry.type === "accession") {
    const number = entry.number === null ? "an accession" : `accession ${entry.number}`;
    return `${entry.version === 1 ? "Added" : "Saved"} ${number} (version ${String(entry.version)})`;
  }
  if (entry.type === "share") {
    const site =
      entry.targetSiteId === null ? "" : ` with ${sites.get(entry.targetSiteId) ?? "another site"}`;
    const item = entry.title === null ? "a shared item" : `“${entry.title}”`;
    return `${SHARE_STEPS[entry.kind] ?? entry.kind} ${item}${site}`;
  }
  if (entry.type === "system" && Object.hasOwn(FILE_EVENTS, entry.kind)) {
    const n = entry.files ?? 0;
    const mb = ((entry.bytes ?? 0) / (1024 * 1024)).toFixed(1);
    return `${FILE_EVENTS[entry.kind] ?? entry.kind} ${String(n)} file${n === 1 ? "" : "s"} (${mb} MB)`;
  }
  if (entry.type === "system") {
    const label = Object.hasOwn(SYSTEM_EVENTS, entry.kind) ? SYSTEM_EVENTS[entry.kind] : undefined;
    const before = entry.fromVersion ?? "a development build";
    return `${label ?? entry.kind} ${entry.version} (from ${before})`;
  }
  if (entry.type === "record") {
    const title = entry.title ?? "a record";
    const version = `version ${String(entry.version)}`;
    return `${ACTIONS[entry.action] ?? entry.action} “${title}” (${version}${entry.deleted ? ", since deleted" : ""})`;
  }
  const subject = entry.subjectName ?? entry.invitedEmail ?? "someone";
  const role =
    entry.role === null
      ? ""
      : `: ${grantText({ role: entry.role, siteId: entry.siteId, scope: entry.scope }, sites)}`;
  return `${EVENTS[entry.kind] ?? entry.kind} ${subject}${role}`;
}

/** A line's own key: each kind's ID, with the step for shares and the version for records and accessions. */
function rowKey(e: AuditEntry): string {
  switch (e.type) {
    case "record":
      return `r${e.recordId}:${String(e.version)}`;
    case "accession":
      return `a${e.accessionId}:${String(e.version)}`;
    case "share":
      return `h${e.shareId}:${e.kind}`;
    default:
      return `${e.type}:${e.eventId}`;
  }
}

export function Audit() {
  const { me } = useOutletContext<FrameContext>();
  const sites = siteNames(me);
  const people = usePeople();
  const [draft, setDraft] = useState<Filter>(EMPTY);
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const trail = useInfiniteQuery({
    queryKey: ["audit", filter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<AuditPage>(query(filter, pageParam)),
    getNextPageParam: (last) => last.next,
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setFilter(draft);
  }

  const heading = (
    <div>
      <h1 className={frame.pageTitle}>Audit trail</h1>
      <p className={frame.lead}>
        Every change to records, their files, places and shares, people and settings you may see,
        newest first. Deleted records keep their history here.
      </p>
    </div>
  );
  if (trail.error !== null && trail.data === undefined) {
    return (
      <>
        {heading}
        <Note tone="amber">
          {refused(trail.error)
            ? "You don't have a role that shows the audit trail."
            : problemText(trail.error)}
        </Note>
      </>
    );
  }
  const entries = trail.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      {heading}
      <form
        className={`${styles.panel} ${styles.form}`}
        aria-label="Filter the audit trail"
        onSubmit={submit}
      >
        {people.data === undefined ? null : (
          <div className={styles.label}>
            <label htmlFor="audit-person">Person</label>
            <select
              id="audit-person"
              className={styles.select}
              value={draft.person}
              onChange={(event) => {
                setDraft({ ...draft, person: event.target.value });
              }}
            >
              <option value="">Anyone</option>
              {people.data.people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        <Field
          label="Record ID"
          name="record"
          value={draft.record}
          onChange={(record) => {
            setDraft({ ...draft, record });
          }}
        />
        <div className={styles.label}>
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            className={styles.select}
            type="date"
            value={draft.from}
            onChange={(event) => {
              setDraft({ ...draft, from: event.target.value });
            }}
          />
        </div>
        <div className={styles.label}>
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            className={styles.select}
            type="date"
            value={draft.to}
            onChange={(event) => {
              setDraft({ ...draft, to: event.target.value });
            }}
          />
        </div>
        <div>
          <Button type="submit" variant="primary">
            Show
          </Button>
        </div>
      </form>
      {trail.error === null ? null : <Note tone="amber">{problemText(trail.error)}</Note>}
      {trail.data === undefined ? (
        <p role="status">Loading…</p>
      ) : entries.length === 0 ? (
        <p>No changes match.</p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.muted}>Changes, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={rowKey(e)}>
                <td>{when(e.at)}</td>
                <td>
                  {e.actorName ??
                    (e.actor === "command_line"
                      ? "The server's command line"
                      : e.actor === "timer"
                        ? "Oculus's daily clean-up"
                        : e.actor === "lease"
                          ? "Oculus (another database used the files folder)"
                          : e.actor === "automatic"
                            ? "Oculus (automatically)"
                            : e.type === "system"
                              ? "A former system manager"
                              : e.actor.startsWith("system:")
                                ? "Oculus"
                                : "Someone outside this organization")}
                </td>
                <td>{what(e, sites)}</td>
                <td className={styles.muted}>
                  {e.type === "record"
                    ? [
                        e.changedFields.length > 0 ? `Changed: ${e.changedFields.join(", ")}` : "",
                        e.reason === null ? "" : `Reason: ${e.reason}`,
                      ]
                        .filter(Boolean)
                        .join(". ")
                    : e.type === "definition" && e.changes.length > 0
                      ? `Changed: ${e.changes.join(", ")}`
                      : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {trail.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            isDisabled={trail.isFetchingNextPage}
            onPress={() => void trail.fetchNextPage()}
          >
            Show older changes
          </Button>
        </div>
      ) : null}
    </>
  );
}
