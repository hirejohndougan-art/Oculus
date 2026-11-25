/**
 * Settings › Virus scanning (S-040, D-113): whether this server scans
 * uploaded files for viruses, how many of the organization's files are in
 * each state, and "Scan every file again", which a system manager uses
 * after the scanner's virus signatures were updated: confirmed in the page
 * first, saying what will happen, then a recent sign-in is asked for. Scanning is set up where Oculus runs (`OCULUS_CLAMD_*`), not
 * here: without it the screen says plainly that files are not scanned.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { Button, Note } from "../components/ui";
import { ConfirmPanel } from "../records/controls";
import records from "../records/Records.module.css";
import { useReauthenticated } from "../people/Reauth";
import { Problems } from "./Settings";

interface ScanStatus {
  readonly scanning: boolean;
  readonly counts: {
    readonly pending: number;
    readonly clean: number;
    readonly infected: number;
    readonly failed: number;
    readonly failedTooLarge: number;
    readonly tooLargeToScan: number;
    readonly unscanned: number;
    readonly rescanning: number;
  };
}

export const FILE_SCANS_KEY = ["file-scans"] as const;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function FileScanSettings() {
  const queries = useQueryClient();
  const [queued, setQueued] = useState<number>();
  const [confirming, setConfirming] = useState(false);
  const read = useQuery({
    queryKey: FILE_SCANS_KEY,
    queryFn: () => api<ScanStatus>("/api/system/file-scans"),
  });
  const rescan = useMutation({
    mutationFn: () =>
      api<{ queued: number }>("/api/system/file-scans/rescan", { method: "POST", body: {} }),
    onSuccess: async (reply) => {
      setQueued(reply.queued);
      await queries.invalidateQueries({ queryKey: FILE_SCANS_KEY });
    },
  });
  const reauth = useReauthenticated("To scan every file again");
  if (read.data === undefined) {
    return read.error === null ? <p role="status">Loading…</p> : <Problems error={read.error} />;
  }
  const { scanning, counts } = read.data;
  return (
    <>
      <section className={records.panel} aria-labelledby="virus-scanning">
        <h2 id="virus-scanning" className={records.sectionTitle}>
          Virus scanning
        </h2>
        {scanning ? (
          <>
            <Note tone="green">
              Scanning is on. Every uploaded file is scanned for viruses before anyone can download
              or open it.
            </Note>
            <ul className={records.meta}>
              <li>{plural(counts.clean, "file is clean", "files are clean")}</li>
              {counts.rescanning > 0 ? (
                <li>
                  {plural(
                    counts.rescanning,
                    "clean file is waiting to be scanned again (it can still be opened)",
                    "clean files are waiting to be scanned again (they can still be opened)",
                  )}
                </li>
              ) : null}
              <li>
                {plural(
                  counts.pending,
                  "new file is waiting for its scan",
                  "new files are waiting for their scan",
                )}
              </li>
              {counts.unscanned > 0 ? (
                <li>
                  {plural(
                    counts.unscanned,
                    "file from before scanning was turned on isn't scanned yet (it can still be opened)",
                    "files from before scanning was turned on aren't scanned yet (they can still be opened)",
                  )}
                </li>
              ) : null}
              <li>
                {plural(
                  counts.failed,
                  "file couldn't be scanned yet (tried again later)",
                  "files couldn't be scanned yet (tried again later)",
                )}
              </li>
              {counts.tooLargeToScan > 0 ? (
                <li>
                  {plural(
                    counts.tooLargeToScan,
                    "file is too large to scan: it can still be opened, but it hasn't been scanned for viruses (added before scanning was turned on or before the scanner's limit was lowered)",
                    "files are too large to scan: they can still be opened, but they haven't been scanned for viruses (added before scanning was turned on or before the scanner's limit was lowered)",
                  )}
                </li>
              ) : null}
              {counts.failedTooLarge > 0 ? (
                <li>
                  {plural(
                    counts.failedTooLarge,
                    "new file was too large for the scanner and can't be opened (not tried again until the scanner's limit is raised and every file is scanned again)",
                    "new files were too large for the scanner and can't be opened (not tried again until the scanner's limit is raised and every file is scanned again)",
                  )}
                </li>
              ) : null}
              <li>
                {plural(
                  counts.infected,
                  "file holds a virus and is quarantined",
                  "files hold a virus and are quarantined",
                )}
              </li>
            </ul>
            <p className={records.meta}>
              After the scanner&rsquo;s virus signatures are updated, scan every file again.
              Quarantined files stay quarantined.
            </p>
            {queued === undefined ? null : (
              <div aria-live="polite">
                <Note tone="green">{plural(queued, "file", "files")} will be scanned again.</Note>
              </div>
            )}
            {rescan.error instanceof ApiError && rescan.error.code === "scanning_off" ? (
              <Note tone="amber" alert>
                Scanning was turned off on the server. Reload this page.
              </Note>
            ) : (
              <Problems error={rescan.error} />
            )}
            <div className={records.actions}>
              <Button
                variant="secondary"
                isDisabled={rescan.isPending || confirming}
                onPress={() => {
                  setQueued(undefined);
                  setConfirming(true);
                }}
              >
                Scan every file again
              </Button>
            </div>
            <ConfirmPanel
              isOpen={confirming}
              title="Scan every file again?"
              confirmLabel="Scan them again"
              busy={rescan.isPending}
              onCancel={() => {
                setConfirming(false);
              }}
              onConfirm={() => {
                setConfirming(false);
                void reauth
                  .run(async () => {
                    await rescan.mutateAsync();
                  })
                  .catch(() => undefined);
              }}
            >
              <p>
                Every file of this organization is scanned again, a few at a time. Clean files can
                still be downloaded and opened while they wait. A file now found to hold a virus is
                quarantined, and no one can open it after that. Files that couldn&rsquo;t be scanned
                are tried again now.
              </p>
            </ConfirmPanel>
          </>
        ) : (
          <Note tone="amber">
            Scanning is off: uploaded files are not scanned for viruses. Whoever runs Oculus can
            turn it on by installing ClamAV and setting OCULUS_CLAMD_SOCKET (or OCULUS_CLAMD_HOST).
            {counts.infected > 0
              ? ` ${plural(counts.infected, "file found infected earlier stays", "files found infected earlier stay")} quarantined.`
              : ""}
          </Note>
        )}
      </section>
      {reauth.form}
    </>
  );
}
