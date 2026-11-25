/**
 * System settings (T-048a, D-019, D-025, D-072): the install-wide settings
 * only system managers change, separate from each site's own settings.
 *
 * - **Sites:** every site of the install by organization; add a site to an
 *   organization; rename one (`POST /api/sites`, `PUT /api/sites/:id`).
 * - **Templates:** the session organization's templates and their fields
 *   (TemplateEditor.tsx).
 * - **Sign-in rules:** how long a session may sit unused and how long it
 *   lasts at most (`/api/system-settings`, with the version it started from).
 *
 * The server decides who may (system managers only) and needs a recent
 * sign-in for every change; these screens only hide themselves from anyone
 * else and say plainly what the server answered. Email, backups, updates
 * and site passwords join as their tasks build them (T-040, T-051, T-019d).
 */
import { useState, type SubmitEvent } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button as AriaButton } from "react-aria-components";
import { Button, Note } from "../components/ui";
import ui from "../components/ui.module.css";
import type { FrameContext } from "../frame/Frame";
import { ME_KEY } from "../frame/useMe";
import { TextInput } from "../records/controls";
import records from "../records/Records.module.css";
import type { Me, SiteChoice } from "../types";
import { issueLine, issuesOf } from "./templateForm";
import styles from "./Settings.module.css";

/** A refusal as plain sentences: the checks' own messages for `422 invalid`. */
export function refusalText(error: unknown): readonly string[] {
  if (error instanceof ApiError) {
    if (error.code === "not_permitted") return ["Only system managers can change this."];
    if (error.code === "invalid") {
      const lines = issuesOf(error.body).map((i) => issueLine(i, []));
      if (lines.length > 0) return lines;
    }
    if (error.code === "not_found") return ["That isn't there any more. Reload the page."];
  }
  return [problemText(error)];
}

export function Problems(props: { readonly error: unknown }) {
  if (props.error === null || props.error === undefined) return null;
  const lines = refusalText(props.error);
  return (
    <div role="alert">
      <Note tone="amber">
        {lines.length === 1 ? (
          lines[0]
        ) : (
          <>
            {"These need fixing:"}
            <ul className={records.issues}>
              {lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </Note>
    </div>
  );
}

export interface SettingsContext {
  readonly me: Me;
}

/** The frame of System settings: its title, its tabs and the page under them. */
export function SettingsLayout() {
  const { me } = useOutletContext<FrameContext>();
  if (!me.systemAdmin) {
    return (
      <>
        <h1 className={records.pageTitle}>System settings</h1>
        <Note tone="blue">
          Only system managers can see or change System settings. Ask one if something here needs
          changing.
        </Note>
      </>
    );
  }
  const context: SettingsContext = { me };
  return (
    <>
      <div>
        <h1 className={records.pageTitle}>System settings</h1>
        <p className={records.lead}>
          Settings for the whole of Oculus, for every organization and site. Only system managers
          see these. Each change needs a recent sign-in.
        </p>
      </div>
      <nav aria-label="System settings">
        <ul className={styles.tabs}>
          <li>
            <NavLink className={styles.tab} to="/settings/sites">
              Sites
            </NavLink>
          </li>
          <li>
            <NavLink className={styles.tab} to="/settings/templates">
              Templates
            </NavLink>
          </li>
          <li>
            <NavLink className={styles.tab} to="/settings/sign-in">
              Sign-in rules
            </NavLink>
          </li>
        </ul>
      </nav>
      <Outlet context={context} />
    </>
  );
}

/**
 * A secondary button whose accessible name says what it acts on ("Rename
 * Invented archive site") while it shows only the verb.
 */
export function RowButton(props: {
  readonly label: string;
  readonly children: string;
  readonly isDisabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <AriaButton
      className={`${ui.button} ${ui.secondary}`}
      aria-label={props.label}
      isDisabled={props.isDisabled ?? false}
      onPress={props.onPress}
    >
      {props.children}
    </AriaButton>
  );
}

/** The organizations a system manager can add a site to: those with sites, and the current one. */
export function organizationsOf(me: Me): readonly { id: string; name: string }[] {
  const out = new Map<string, string>();
  out.set(me.organizationId, me.organizationName);
  for (const s of me.sites)
    if (!out.has(s.organizationId)) out.set(s.organizationId, s.organizationName);
  return [...out].map(([id, name]) => ({ id, name }));
}

function SiteRow(props: { readonly site: SiteChoice }) {
  const { site } = props;
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.siteName);
  const [done, setDone] = useState(false);
  const rename = useMutation({
    mutationFn: (value: string) =>
      api(`/api/sites/${encodeURIComponent(site.siteId)}`, {
        method: "PUT",
        body: { organizationId: site.organizationId, name: value },
      }),
    onSuccess: async () => {
      setEditing(false);
      setDone(true);
      await queries.invalidateQueries({ queryKey: ME_KEY });
    },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    setDone(false);
    rename.mutate(name.trim());
  }
  return (
    <tr>
      <td>
        {editing ? (
          <form onSubmit={submit} className={styles.row}>
            <TextInput
              className={styles.grow}
              label={`New name for ${site.siteName}`}
              value={name}
              onChange={setName}
              maxLength={200}
              isRequired
            />
            <Button type="submit" variant="primary" isDisabled={rename.isPending}>
              Save name
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                setEditing(false);
                setName(site.siteName);
                rename.reset();
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          site.siteName
        )}
        <Problems error={rename.error} />
        {done ? <span className={styles.muted}> Renamed.</span> : null}
      </td>
      <td>{site.organizationName}</td>
      <td>
        {editing ? null : (
          <RowButton
            label={`Rename ${site.siteName}`}
            onPress={() => {
              setEditing(true);
              setDone(false);
            }}
          >
            Rename
          </RowButton>
        )}
      </td>
    </tr>
  );
}

/** Settings › Sites. */
export function SitesSettings() {
  const { me } = useOutletContext<SettingsContext>();
  const queries = useQueryClient();
  const organizations = organizationsOf(me);
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState(me.organizationId);
  const [made, setMade] = useState<string>();
  const create = useMutation({
    mutationFn: (body: { organizationId: string; name: string }) =>
      api<{ site: { name: string } }>("/api/sites", { body }),
    onSuccess: async (reply) => {
      setMade(reply.site.name);
      setName("");
      await queries.invalidateQueries({ queryKey: ME_KEY });
    },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    setMade(undefined);
    create.mutate({ organizationId, name: name.trim() });
  }
  return (
    <>
      <section className={records.panel} aria-labelledby="sites-list">
        <h2 id="sites-list" className={records.sectionTitle}>
          Sites
        </h2>
        <p className={records.meta}>
          Each site keeps its own items, people and public pages. Every site belongs to one
          organization.
        </p>
        {me.sites.length === 0 ? (
          <p className={records.meta}>There are no sites yet.</p>
        ) : (
          <div className={records.tableWrap}>
            <table className={records.table}>
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">Organization</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {me.sites.map((site) => (
                  <SiteRow key={site.siteId} site={site} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <form className={records.panel} onSubmit={submit} aria-labelledby="sites-add">
        <h2 id="sites-add" className={records.sectionTitle}>
          Add a site
        </h2>
        <div className={records.grid}>
          <TextInput
            label="Site name"
            value={name}
            onChange={setName}
            maxLength={200}
            isRequired
            help="For example: Digital archive. You can change it later."
          />
          {organizations.length > 1 ? (
            <fieldset className={records.fieldset}>
              <legend className={records.legend}>Organization</legend>
              {organizations.map((o) => (
                <label key={o.id} className={styles.check}>
                  <input
                    type="radio"
                    name="organization"
                    value={o.id}
                    checked={organizationId === o.id}
                    onChange={() => {
                      setOrganizationId(o.id);
                    }}
                  />
                  {o.name}
                </label>
              ))}
            </fieldset>
          ) : (
            <p className={records.meta}>It will belong to {me.organizationName}.</p>
          )}
        </div>
        <Problems error={create.error} />
        {made === undefined ? null : (
          <div aria-live="polite">
            <Note tone="green">Added the site “{made}”. Give people a role on it next.</Note>
          </div>
        )}
        <div className={records.actions}>
          <Button type="submit" variant="primary" isDisabled={create.isPending}>
            Add site
          </Button>
        </div>
      </form>
    </>
  );
}

interface StoredSettings {
  readonly settings: { sessionIdleMinutes: number; sessionAbsoluteMinutes: number };
  readonly version: number;
}

const SETTINGS_KEY = ["system-settings"] as const;

/** Settings › Sign-in rules. */
export function SignInSettings() {
  const [savedVersion, setSavedVersion] = useState<number>();
  const read = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<StoredSettings>("/api/system-settings"),
  });
  if (read.data === undefined) {
    return read.error === null ? <p role="status">Loading…</p> : <Problems error={read.error} />;
  }
  return (
    <SignInForm
      key={read.data.version}
      stored={read.data}
      justSaved={savedVersion === read.data.version}
      onSaved={setSavedVersion}
    />
  );
}

function SignInForm(props: {
  readonly stored: StoredSettings;
  /** The version shown is the one this person just saved (the form is new for each version). */
  readonly justSaved: boolean;
  readonly onSaved: (version: number) => void;
}) {
  const { stored } = props;
  const queries = useQueryClient();
  const [idle, setIdleValue] = useState(String(stored.settings.sessionIdleMinutes));
  const [absolute, setAbsoluteValue] = useState(String(stored.settings.sessionAbsoluteMinutes));
  const [edited, setEdited] = useState(false);
  const saved = props.justSaved && !edited;
  const setIdle = (v: string) => {
    setEdited(true);
    setIdleValue(v);
  };
  const setAbsolute = (v: string) => {
    setEdited(true);
    setAbsoluteValue(v);
  };
  const save = useMutation({
    mutationFn: () =>
      // Version 0 has never been changed: the first change says so.
      stored.version === 0
        ? api<StoredSettings>("/api/system-settings", {
            method: "PUT",
            body: { settings: settingsBody(idle, absolute) },
            ifNoneMatch: true,
          })
        : api<StoredSettings>("/api/system-settings", {
            method: "PUT",
            body: { settings: settingsBody(idle, absolute) },
            ifMatch: stored.version,
          }),
    onSuccess: (reply) => {
      props.onSaved(reply.version);
      queries.setQueryData(SETTINGS_KEY, reply);
    },
  });
  const conflict = save.error instanceof ApiError && save.error.status === 412;
  function submit(event: SubmitEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <form className={records.panel} onSubmit={submit} aria-labelledby="sign-in-rules">
      <h2 id="sign-in-rules" className={records.sectionTitle}>
        Sign-in rules
      </h2>
      <p className={records.meta}>
        These apply to sessions started after a change; people already signed in keep theirs.
      </p>
      <div className={records.grid}>
        <TextInput
          label="Sign out after this many minutes unused"
          value={idle}
          onChange={setIdle}
          isRequired
          help="5 to 720 minutes. No longer than the limit beside it."
        />
        <TextInput
          label="Sign out after this many minutes in all"
          value={absolute}
          onChange={setAbsolute}
          isRequired
          help="60 to 1,440 minutes (24 hours)."
        />
      </div>
      {conflict ? (
        <div role="alert">
          <Note tone="amber">
            Someone else changed these rules while you were editing.{" "}
            <Button
              variant="link"
              onPress={() => {
                void queries.invalidateQueries({ queryKey: SETTINGS_KEY });
              }}
            >
              Load their version
            </Button>
          </Note>
        </div>
      ) : (
        <Problems error={save.error} />
      )}
      {saved ? (
        <div aria-live="polite">
          <Note tone="green">Saved.</Note>
        </div>
      ) : null}
      <div className={records.actions}>
        <Button type="submit" variant="primary" isDisabled={save.isPending}>
          Save sign-in rules
        </Button>
      </div>
    </form>
  );
}

/** Whole numbers as numbers; anything else as typed, so the server says what's wrong with it. */
function settingsBody(idle: string, absolute: string) {
  const number = (value: string): number | string =>
    /^[0-9]{1,6}$/.test(value.trim()) ? Number(value.trim()) : value;
  return { sessionIdleMinutes: number(idle), sessionAbsoluteMinutes: number(absolute) };
}
