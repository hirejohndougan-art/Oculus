/**
 * Clean up removed files (S-052, D-086; system managers): what is waiting
 * to be freed and its size, and a button that runs one step of the purge.
 * The server decides everything (the lease, both clocks, whether a copy is
 * still in use anywhere); this screen shows its answers. The status is the
 * server's dry run (`GET /api/system/files/cleanup`), which changes
 * nothing. Running a step asks for the password and a code again
 * (`reauthentication_required`), shown in the page, as inviting does. Every
 * step is written to the change log.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Note } from "../components/ui";
import { useReauthenticated } from "../people/Reauth";
import styles from "../people/People.module.css";

export const CLEANUP_KEY = ["system", "files", "cleanup"] as const;

interface Totals {
  readonly files: number;
  readonly bytes: number;
}

export interface CleanupStatus {
  readonly available: boolean;
  readonly problem?: string;
  readonly dryRun?: boolean;
  readonly trashed?: Totals;
  readonly deleted?: Totals;
  readonly restored?: Totals;
  readonly waiting?: Totals;
  readonly stuck?: Totals;
  readonly stopped?: "lease_expired" | "lease_lost";
}

const PROBLEMS: Readonly<Record<string, string>> = {
  no_store: "No files folder is set up on this server.",
  not_bound: "The files folder hasn't been set up for this database yet. Restart Oculus.",
  other_install: "The files folder belongs to another Oculus install, so nothing is cleaned up.",
  lease_mismatch:
    "Another database is using the files folder, or this database was restored or copied. Nothing is cleaned up until someone on the server runs npm run files:adopt.",
  identity_changed:
    "The files folder names another database. If this database server was upgraded (pg_upgrade) or moved, someone on the server stops every other Oculus using the folder and runs npm run files:adopt (it waits for three quiet hours); files removed before then are kept. If it is a copy of the database that uses the folder, leave it.",
  identity_unknown:
    "Oculus can't read this database server's identity, so a copy restored elsewhere couldn't be told apart, and nothing is cleaned up. Ask whoever runs the database to let Oculus's role read it (EXECUTE on pg_control_system()).",
  lease_busy: "Something else is working on the files folder right now. Try again in a minute.",
  mtime_unreliable:
    "The disk the files folder is on doesn't keep file times exactly enough to tell whether a file was used again, so nothing is cleaned up on it.",
};

function size(bytes: number): string {
  if (bytes === 0) return "nothing";
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function files(t: Totals | undefined): string {
  const n = t?.files ?? 0;
  return `${String(n)} file${n === 1 ? "" : "s"} (${size(t?.bytes ?? 0)})`;
}

export function FileCleanup() {
  const queries = useQueryClient();
  const reauth = useReauthenticated("To clean up removed files");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<CleanupStatus>();
  const status = useQuery({
    queryKey: CLEANUP_KEY,
    queryFn: () => api<CleanupStatus>("/api/system/files/cleanup"),
  });

  const title = <h2 className={styles.panelTitle}>Clean up removed files</h2>;
  if (status.error instanceof ApiError && status.error.code === "not_permitted") {
    return (
      <>
        {title}
        <Note tone="amber">Only system managers can clean up removed files.</Note>
      </>
    );
  }
  if (status.error !== null) {
    return (
      <>
        {title}
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
        {title}
        <p className={styles.muted}>Loading…</p>
      </>
    );
  }

  async function runStep() {
    setBusy(true);
    setProblem(undefined);
    setDone(undefined);
    try {
      await reauth.run(async () => {
        try {
          setDone(await api<CleanupStatus>("/api/system/files/cleanup", { body: {} }));
        } catch (error) {
          if (error instanceof ApiError && error.code === "reauthentication_required") throw error;
          setProblem(
            error instanceof ApiError && Object.hasOwn(PROBLEMS, error.code)
              ? PROBLEMS[error.code]
              : problemText(error),
          );
        } finally {
          await queries.invalidateQueries({ queryKey: CLEANUP_KEY });
        }
      });
    } finally {
      setBusy(false);
    }
  }

  const nothingToDo =
    (s.trashed?.files ?? 0) === 0 &&
    (s.deleted?.files ?? 0) === 0 &&
    (s.restored?.files ?? 0) === 0;

  return (
    <>
      <div>
        {title}
        <p>
          When a file is removed from a record, its copy stays on the server's disk. Cleaning up
          frees that space in two steps, never for a file used since it was removed: a file removed
          at least 7 days ago goes to the trash, and a later step at least a day after that deletes
          it. An upload of the same file brings it back from the trash.
        </p>
      </div>

      <div aria-live="polite">
        {done === undefined ? null : (
          <Note tone="green">
            Done. Moved to the trash: {files(done.trashed)}. Deleted: {files(done.deleted)}. Put
            back: {files(done.restored)}.
            {done.stopped === undefined ? "" : " It stopped early; run it again to go on."}
          </Note>
        )}
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
      </div>

      {reauth.form}

      {!s.available ? (
        <Note tone="amber">
          {PROBLEMS[s.problem ?? ""] ?? "Removed files can't be cleaned up."}
        </Note>
      ) : (
        <section className={styles.panel} aria-labelledby="cleanup-waiting">
          <h2 id="cleanup-waiting" className={styles.panelTitle}>
            What is waiting
          </h2>
          <dl>
            <dt>Ready to move to the trash</dt>
            <dd>{files(s.trashed)}</dd>
            <dt>Ready to delete from the trash</dt>
            <dd>{files(s.deleted)}</dd>
            <dt>In the trash, waiting for their day</dt>
            <dd>{files(s.waiting)}</dd>
            {(s.stuck?.files ?? 0) === 0 ? null : (
              <>
                <dt>Stuck in the trash (left alone: ask someone to look at the server)</dt>
                <dd>{files(s.stuck)}</dd>
              </>
            )}
            {(s.restored?.files ?? 0) === 0 ? null : (
              <>
                <dt>To put back from the trash (in use again)</dt>
                <dd>{files(s.restored)}</dd>
              </>
            )}
          </dl>
          <div className={styles.actions}>
            <Button variant="dark" isDisabled={busy || nothingToDo} onPress={() => void runStep()}>
              Run a clean-up step
            </Button>
          </div>
          {nothingToDo ? (
            <p className={styles.muted}>Nothing can be cleaned up right now.</p>
          ) : null}
        </section>
      )}
    </>
  );
}
