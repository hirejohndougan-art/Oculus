/**
 * Updates (T-060, D-092; system managers): upload a signed update package,
 * see what it is once the server has checked it, then install it, or go
 * back to the version before the last install. The server decides
 * everything (who may, whether the package is signed by a trusted key,
 * whether a rollback is safe); this screen shows its answers. Installing
 * and going back ask for the password and a code again
 * (`reauthentication_required`), shown in the page, as for people.
 *
 * The package goes up in parts of the size the server names, each as
 * base64 in an ordinary JSON request, with a progress bar.
 */
import { useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Note } from "../components/ui";
import { useReauthenticated } from "../people/Reauth";
import styles from "../people/People.module.css";
import { when } from "../people/types";

export const UPDATE_KEY = ["system", "update"] as const;

interface Job {
  readonly kind: "verify" | "install" | "rollback";
  readonly state: "running" | "failed" | "done";
  readonly step: string;
  readonly version?: string;
  readonly error?: string;
  readonly message?: string;
}

interface History {
  readonly kind: "install" | "rollback";
  readonly version: string;
  readonly from: string | null;
  readonly at: string;
}

export interface UpdateStatus {
  readonly configured: boolean;
  readonly runningVersion: string | null;
  readonly runningFromCurrent?: boolean;
  readonly startCommand?: string;
  readonly restart?: "exit" | "none";
  readonly backups?: boolean;
  readonly migrationsFromWeb?: boolean;
  readonly partBytes?: number;
  readonly maxPackageBytes?: number;
  readonly pending?: {
    readonly version: string;
    readonly builtAt: string;
    readonly notes: string;
    readonly keyId: string;
    readonly files: number;
    readonly bytes: number;
    readonly newMigrations: readonly string[];
  } | null;
  readonly job?: Job | null;
  readonly restartNeeded?: boolean;
  readonly rollback?: { readonly version: string; readonly allowed: boolean } | null;
  readonly history?: readonly History[];
  readonly variables?: readonly string[];
}

/**
 * The update status; polled every second while a step runs. Read as
 * background (T-062, D-098): the polling isn't the person doing anything,
 * so it never holds off the idle sign-out.
 */
export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => api<UpdateStatus>("/api/system/update", { background: true }),
    refetchInterval: (query) => (query.state.data?.job?.state === "running" ? 1000 : false),
  });
}

const STEPS: Readonly<Record<string, string>> = {
  starting: "Starting…",
  checking: "Checking the package's signature and files…",
  placing: "Unpacking the new version beside the running one…",
  backing_up: "Backing up the database…",
  migrating: "Applying the new version's database changes…",
  switching: "Switching to the new version…",
};

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bytes as base64, a chunk at a time (no spread of a large array). */
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** How long to wait before sending a part again after `rate_limited` (tests shorten it). */
export const updateTiming = { retryMs: 5000, maxRetries: 30 };

/**
 * Sends one part; on `rate_limited` (the per-session limit on changes)
 * waits and sends it again, so a large package goes up at the pace the
 * server allows instead of failing part way (review).
 */
async function sendPart(path: string, data: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await api(path, { method: "PUT", body: { data } });
      return;
    } catch (error) {
      if (
        !(error instanceof ApiError && error.code === "rate_limited") ||
        tries >= updateTiming.maxRetries
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, updateTiming.retryMs));
    }
  }
}

export function Updates() {
  const status = useUpdateStatus();
  const queries = useQueryClient();
  const reauth = useReauthenticated();
  const [file, setFile] = useState<File>();
  const [progress, setProgress] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const [confirming, setConfirming] = useState<"install" | "rollback">();
  const [busy, setBusy] = useState(false);

  const refresh = () => queries.invalidateQueries({ queryKey: UPDATE_KEY });

  if (status.error instanceof ApiError && status.error.code === "not_permitted") {
    return (
      <>
        <h2 className={styles.panelTitle}>Updates</h2>
        <Note tone="amber">Only system managers can update Oculus.</Note>
      </>
    );
  }
  if (status.error !== null) {
    return (
      <>
        <h2 className={styles.panelTitle}>Updates</h2>
        <Note tone="amber" alert>
          {problemText(status.error)}
        </Note>
      </>
    );
  }
  const s = status.data;
  if (s === undefined) {
    return (
      <>
        <h2 className={styles.panelTitle}>Updates</h2>
        <p className={styles.muted}>Loading…</p>
      </>
    );
  }
  const running = s.runningVersion === null ? "a development build" : `Oculus ${s.runningVersion}`;

  if (!s.configured) {
    return (
      <>
        <div>
          <h2 className={styles.panelTitle}>Updates</h2>
          <p>This server is running {running}.</p>
        </div>
        <Note tone="blue">
          Updates aren't set up on this server yet. Set {(s.variables ?? []).join(", ")} in the
          server's settings (the updates folder and your public signing keys at least), then restart
          Oculus. The deployment guide explains each one.
        </Note>
      </>
    );
  }

  const job = s.job ?? undefined;
  const working = job?.state === "running" || busy || progress !== undefined;

  async function upload() {
    if (file === undefined || s === undefined) return;
    setProblem(undefined);
    const partBytes = s.partBytes ?? 512 * 1024;
    if (file.size > (s.maxPackageBytes ?? Infinity)) {
      setProblem("That file is larger than Oculus accepts for an update package.");
      return;
    }
    try {
      setProgress(0);
      const started = await api<{ uploadId: string }>("/api/system/update/uploads", {
        body: { size: file.size },
      });
      for (let at = 0, part = 0; at < file.size; at += partBytes, part++) {
        const bytes = new Uint8Array(await file.slice(at, at + partBytes).arrayBuffer());
        await sendPart(
          `/api/system/update/uploads/${started.uploadId}/parts/${String(part)}`,
          toBase64(bytes),
        );
        setProgress(Math.min(file.size, at + partBytes) / file.size);
      }
      await api(`/api/system/update/uploads/${started.uploadId}/finish`, { method: "POST" });
      setFile(undefined);
    } catch (error) {
      setProblem(updateProblem(error));
    } finally {
      setProgress(undefined);
      await refresh();
    }
  }

  async function act(path: "install" | "rollback", version: string) {
    setBusy(true);
    setProblem(undefined);
    try {
      await reauth.run(async () => {
        try {
          await api(`/api/system/update/${path}`, { body: { version } });
          setConfirming(undefined);
        } catch (error) {
          if (error instanceof ApiError && error.code === "reauthentication_required") throw error;
          setProblem(updateProblem(error));
        } finally {
          await refresh();
        }
      });
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    setProblem(undefined);
    try {
      await api("/api/system/update/pending", { method: "DELETE" });
    } catch (error) {
      setProblem(updateProblem(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const pending = s.pending ?? undefined;
  const rollback = s.rollback ?? undefined;
  const restartText =
    s.restart === "exit"
      ? "Oculus restarts by itself to start the new version."
      : "Then restart Oculus from your host's control panel to start the new version.";

  return (
    <>
      <div>
        <h2 className={styles.panelTitle}>Updates</h2>
        <p>
          This server is running {running}. Install a newer version from a signed update package.
        </p>
      </div>

      {s.runningFromCurrent === true ? null : (
        <Note tone="amber">
          Oculus isn't running from its updates folder, so an update couldn't start after a restart.
          Set the host's start command to: <code>{s.startCommand}</code>
        </Note>
      )}

      <div aria-live="polite">
        {s.restartNeeded === true ? (
          <Note tone="green">
            {s.restart === "exit"
              ? "The change is made. Oculus is restarting; this page will reconnect in a moment."
              : "The change is made. Restart Oculus from your host's control panel to finish."}
          </Note>
        ) : null}
        {job?.state === "running" ? <Note tone="blue">{STEPS[job.step] ?? "Working…"}</Note> : null}
        {job?.state === "failed" ? (
          <Note tone="amber" alert>
            {job.message ?? "That step failed."}
          </Note>
        ) : null}
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
      </div>

      {reauth.form}

      {pending === undefined ? null : (
        <section className={styles.panel} aria-labelledby="pending-title">
          <h2 id="pending-title" className={styles.panelTitle}>
            Ready to install: Oculus {pending.version}
          </h2>
          <p>
            Checked and signed by key <code>{pending.keyId}</code>. Built {when(pending.builtAt)};{" "}
            {String(pending.files)} files, {size(pending.bytes)}.
          </p>
          {pending.notes === "" ? null : <p className={styles.muted}>{pending.notes}</p>}
          <p>
            {pending.newMigrations.length === 0
              ? "It doesn't change the database, so you can go back to this version afterwards."
              : s.backups === true
                ? `It changes the database (${String(pending.newMigrations.length)} change${pending.newMigrations.length === 1 ? "" : "s"}). The database is backed up first; afterwards, going back means restoring that backup.`
                : `It changes the database (${String(pending.newMigrations.length)} change${pending.newMigrations.length === 1 ? "" : "s"}), and backups before updates are turned off on this server.`}
          </p>
          {pending.newMigrations.length > 0 && s.migrationsFromWeb !== true ? (
            <Note tone="amber">
              This server isn't set up to change its database from here, so installing will be
              refused. Install this package on the server with{" "}
              <code>npm run release -- install</code>, or set OCULUS_UPDATE_MIGRATE_DATABASE_URL and
              OCULUS_UPDATE_WRITER_ROLE.
            </Note>
          ) : null}
          {confirming === "install" ? (
            <div className={styles.confirm} role="group" aria-labelledby="install-confirm">
              <p id="install-confirm" className={styles.confirmTitle}>
                Install Oculus {pending.version} now?
              </p>
              <p>Staff may be signed out while it restarts. {restartText}</p>
              <div className={styles.actions}>
                <Button
                  variant="dark"
                  isDisabled={working}
                  onPress={() => void act("install", pending.version)}
                >
                  Install Oculus {pending.version}
                </Button>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setConfirming(undefined);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button
                variant="primary"
                isDisabled={working}
                onPress={() => {
                  setConfirming("install");
                }}
              >
                Install…
              </Button>
              <Button variant="secondary" isDisabled={working} onPress={() => void discard()}>
                Remove this package
              </Button>
            </div>
          )}
        </section>
      )}

      <section className={styles.panel} aria-labelledby="upload-title">
        <h2 id="upload-title" className={styles.panelTitle}>
          Upload an update package
        </h2>
        <p className={styles.muted}>
          A <code>.zip</code> made with <code>npm run release -- pack</code> and signed with your
          signing key. Oculus refuses anything else.
        </p>
        <div className={styles.label}>
          <label htmlFor="update-file">Update package (.zip)</label>
          <input
            id="update-file"
            type="file"
            accept=".zip,application/zip"
            disabled={working}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setFile(event.target.files?.[0]);
            }}
          />
        </div>
        {progress === undefined ? null : (
          <div className={styles.label}>
            <label htmlFor="update-progress">Uploading</label>
            <progress id="update-progress" max={1} value={progress}>
              {`${String(Math.round(progress * 100))}%`}
            </progress>
          </div>
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            isDisabled={file === undefined || working}
            onPress={() => void upload()}
          >
            Upload and check
          </Button>
        </div>
      </section>

      {rollback === undefined ? null : (
        <section className={styles.panel} aria-labelledby="rollback-title">
          <h2 id="rollback-title" className={styles.panelTitle}>
            Go back to Oculus {rollback.version}
          </h2>
          {rollback.allowed ? (
            confirming === "rollback" ? (
              <div className={styles.confirm} role="group" aria-labelledby="rollback-confirm">
                <p id="rollback-confirm" className={styles.confirmTitle}>
                  Go back to Oculus {rollback.version} now?
                </p>
                <p>{restartText}</p>
                <div className={styles.actions}>
                  <Button
                    variant="dark"
                    isDisabled={working}
                    onPress={() => void act("rollback", rollback.version)}
                  >
                    Go back to {rollback.version}
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setConfirming(undefined);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  isDisabled={working}
                  onPress={() => {
                    setConfirming("rollback");
                  }}
                >
                  Go back…
                </Button>
              </div>
            )
          ) : (
            <p>
              The last update changed the database, so the older version can't run on it. To go
              back, restore the backup taken before that update.
            </p>
          )}
        </section>
      )}

      {(s.history ?? []).length === 0 ? null : (
        <section aria-labelledby="history-title">
          <h2 id="history-title" className={styles.panelTitle}>
            History
          </h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {(s.history ?? []).map((h) => (
                <tr key={`${h.at}-${h.version}`}>
                  <td>{when(h.at)}</td>
                  <td>
                    {h.kind === "install" ? "Installed" : "Went back to"} {h.version}
                    {h.from === null ? "" : ` (from ${h.from})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function updateProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return problemText(error);
  const issues = error.body.issues;
  if (Array.isArray(issues)) {
    const first: unknown = issues[0];
    if (typeof first === "object" && first !== null && "message" in first) {
      const message = first.message;
      if (typeof message === "string") return message;
    }
  }
  if (error.code === "not_permitted") return "Only system managers can update Oculus.";
  if (error.code === "updates_not_configured") return "Updates aren't set up on this server.";
  return problemText(error);
}
