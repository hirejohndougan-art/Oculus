/**
 * A digital asset's files (M-002, D-086): the files attached to it (name,
 * size, the type Oculus found in the bytes, when) and, for people who may
 * edit the asset, an upload control: several files at once, one after
 * another, each with a progress bar and a Cancel button. A file larger than
 * the server takes is refused here before it is sent. People who may edit
 * can also remove a file (asked first, in the page). Names are shown as
 * text only.
 *
 * Viewing and downloading (M-003, D-097): every file has a Download link
 * (the server always sends it as an attachment); JPEG, PNG, GIF and WebP
 * files show a thumbnail the server made (T-072; a placeholder naming
 * their format when it makes none, as for a file it refused) and open in a
 * simple viewer (FileViewer.tsx), where the browser shows the image itself. Which files are images is decided by the type
 * the server sniffed from the bytes, never by the name.
 *
 * Virus scanning (S-040, D-113): each file shows its scan as a pill
 * (Scanning…, Not yet scanned, Clean, Infected (quarantined), Scan failed,
 * Not scanned). Only files the server will send get a Download link and a
 * preview: with a scanner, clean ones and those stored before scanning was
 * turned on (until their first scan); without one, every file but an
 * infected one, and a notice says they were not scanned for viruses. While
 * a scan is due the list is read again on a timer (`scanPollMs`); only
 * those timed reads are marked `X-Oculus-Background: 1` (they aren't a use
 * of the session).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button as AriaButton, FileTrigger } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText, uploadFile } from "../api";
import { Button, Note } from "../components/ui";
import { ConfirmPanel } from "./controls";
import { FileViewer, fileUrl } from "./FileViewer";
import { whenText } from "./model";
import styles from "./Records.module.css";

/** A file's virus scan, as the server lists it (D-113). */
export type ScanState =
  | "pending"
  | "not_yet_scanned"
  | "too_large_to_scan"
  | "clean"
  | "infected"
  | "failed"
  | "not_scanned";

export interface StoredFileEntry {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly createdAt: string;
  /** Left out by servers before S-040: read as not scanned. */
  readonly scan?: ScanState;
  /** A scan of it is queued to run (again) by itself. */
  readonly scanQueued?: boolean;
}

/** How often the list is read again while a new upload is being scanned. */
export const SCAN_POLL_MS = 4000;
/** How often while only failed or not-yet-scanned files wait for a scan. */
export const SCAN_RETRY_POLL_MS = 30_000;

/** How soon to read the list again for its scans, or `undefined` for not. */
export function scanPollMs(files: readonly StoredFileEntry[]): number | undefined {
  if (files.some((f) => f.scan === "pending")) return SCAN_POLL_MS;
  if (
    files.some(
      (f) => (f.scan === "failed" || f.scan === "not_yet_scanned") && f.scanQueued === true,
    )
  ) {
    return SCAN_RETRY_POLL_MS;
  }
  return undefined;
}

/** Whether the server sends this file (D-113): clean, or not scanned at all. */
export function servable(file: StoredFileEntry): boolean {
  return (
    file.scan === undefined ||
    file.scan === "clean" ||
    file.scan === "not_scanned" ||
    file.scan === "not_yet_scanned" ||
    file.scan === "too_large_to_scan"
  );
}

const SCAN_PILLS: Readonly<Record<ScanState, { readonly label: string; readonly tone: string }>> = {
  pending: { label: "Scanning…", tone: styles.blue },
  clean: { label: "Clean", tone: styles.green },
  infected: { label: "Infected (quarantined)", tone: styles.red },
  failed: { label: "Scan failed", tone: styles.amber },
  not_scanned: { label: "Not scanned", tone: styles.gray },
  not_yet_scanned: { label: "Not yet scanned", tone: styles.gray },
  too_large_to_scan: { label: "Too large to scan", tone: styles.amber },
};

/** The file's scan as DESIGN.md's pill. */
export function ScanPill(props: { readonly scan: ScanState | undefined }) {
  const pill = SCAN_PILLS[props.scan ?? "not_scanned"];
  return <span className={`${styles.pill} ${pill.tone}`}>{pill.label}</span>;
}

/** What stands in for the Download link of a file the server won't send. */
const WITHHELD: Readonly<Record<string, string>> = {
  pending: "Download once the scan is done",
  failed: "Download once a scan succeeds",
  infected: "Quarantined: can't be downloaded",
};

interface FileListReply {
  readonly files: readonly StoredFileEntry[];
  readonly maxFileBytes: number | null;
}

interface Upload {
  readonly key: number;
  readonly name: string;
  readonly size: number;
  sent: number;
  status: "waiting" | "sending" | "done" | "failed" | "cancelled";
  message?: string;
}

/** Types the viewer shows and the server makes thumbnails of (D-086, D-097). */
const VIEWABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const previewId = (fileId: string) => `preview-${fileId}`;

/** The placeholder's label: the image's format (server-side thumbnails are off until T-072). */
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WebP",
};

/**
 * A thumbnail, loaded lazily (only when it scrolls into view). When it
 * fails, a HEAD request asks why: 422 means the server makes none (it
 * refused the image, or its decode passed the memory cap: a placeholder
 * naming the format from then on); anything else (busy, a fault) is tried
 * again a little later, twice at most.
 */
function Thumbnail(props: { readonly url: string; readonly label: string }) {
  const [attempt, setAttempt] = useState(0);
  const [none, setNone] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  if (none) return <span className={styles.thumbPlaceholder}>{props.label}</span>;
  return (
    <img
      className={styles.thumb}
      loading="lazy"
      src={attempt === 0 ? props.url : `${props.url}&attempt=${String(attempt)}`}
      alt=""
      onError={() => {
        void (async () => {
          let status = 0;
          try {
            status = (await fetch(props.url, { method: "HEAD" })).status;
          } catch {
            // Offline: tried again below.
          }
          if (!live.current) return;
          if (status === 422 || status === 404 || attempt >= 2) {
            setNone(true);
            return;
          }
          setTimeout(
            () => {
              if (live.current) setAttempt((a) => a + 1);
            },
            4000 * (attempt + 1),
          );
        })();
      }}
    />
  );
}

export const filesKey = (recordId: string) => ["record", recordId, "files"] as const;

/** "512 bytes", "14.2 KB", "3.1 MB", "1.2 GB" (1 KB = 1,024 bytes). */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "TB"}`;
}

function failureText(error: unknown): string {
  if (!(error instanceof ApiError)) return "It couldn't be uploaded. Try again.";
  switch (error.code) {
    case "payload_too_large":
    case "file_too_large":
      return "It is larger than this server takes.";
    case "too_large_to_scan":
      return "It is larger than the virus scanner accepts.";
    case "quota_exceeded":
      return "Your organization has used all its space for files.";
    case "disk_full":
      return "The server is running out of disk space. Ask whoever runs Oculus.";
    case "empty_file":
      return "The file is empty.";
    case "bad_file_name":
      return "Its name can't be kept: rename it and try again.";
    case "version_conflict":
      return "Someone else changed this record. Reload it, then upload again.";
    case "not_permitted":
      return "You may not add files to this record.";
    case "files_unavailable":
      return "This server isn't set up to keep files.";
    default:
      return problemText(error);
  }
}

interface Props {
  readonly siteId: string;
  readonly recordId: string;
  /** The record's version the uploads start from (`If-Match`). */
  readonly version: number;
  /** May the person add files (the edit permission, or Scanner's). */
  readonly canUpload: boolean;
}

export function FilesPanel(props: Props) {
  const { siteId, recordId } = props;
  const queries = useQueryClient();
  const listUrl = `/api/records/${encodeURIComponent(recordId)}/files`;
  const list = useQuery({
    queryKey: filesKey(recordId),
    queryFn: () => api<FileListReply>(listUrl, { site: siteId }),
    refetchOnWindowFocus: false,
  });
  // While scans are due, the list is read again on a timer: only those
  // reads are marked X-Oculus-Background (not a use of the session).
  const pollMs = scanPollMs(list.data?.files ?? []);
  /** Moves on after each timed read (answered or not), so the next is set. */
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (pollMs === undefined) return;
    const timer = setTimeout(() => {
      api<FileListReply>(listUrl, { site: siteId, background: true })
        .then((reply) => {
          queries.setQueryData(filesKey(recordId), reply);
        })
        .catch(() => undefined)
        .finally(() => {
          setPolls((n) => n + 1);
        });
    }, pollMs);
    return () => {
      clearTimeout(timer);
    };
  }, [pollMs, polls, list.dataUpdatedAt, queries, recordId, listUrl, siteId]);
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<StoredFileEntry>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "amber" | "green"; text: string }>();
  const [viewing, setViewing] = useState<number>();
  const cancel = useRef<AbortController | undefined>(undefined);
  const nextKey = useRef(1);
  const cancelAll = useRef(false);
  /** Read through a call, so the loop sees a Cancel pressed while it waits. */
  const stopped = () => cancelAll.current;

  const update = (key: number, change: Partial<Upload>) => {
    setUploads((all) => all.map((u) => (u.key === key ? { ...u, ...change } : u)));
  };

  async function send(files: readonly File[]) {
    const max = list.data?.maxFileBytes ?? null;
    const batch: Upload[] = files.map((f) => ({
      key: nextKey.current++,
      name: f.name,
      size: f.size,
      sent: 0,
      status: "waiting",
    }));
    setUploads((all) => [
      ...all.filter((u) => u.status === "sending" || u.status === "waiting"),
      ...batch,
    ]);
    setBusy(true);
    cancelAll.current = false;
    for (const [i, file] of files.entries()) {
      const entry = batch[i];
      if (entry === undefined) continue;
      if (stopped()) {
        update(entry.key, { status: "cancelled", message: "Not sent." });
        continue;
      }
      if (max !== null && file.size > max) {
        update(entry.key, {
          status: "failed",
          message: `It is larger than this server takes (${sizeText(max)}).`,
        });
        continue;
      }
      if (file.size === 0) {
        update(entry.key, { status: "failed", message: "The file is empty." });
        continue;
      }
      const controller = new AbortController();
      cancel.current = controller;
      update(entry.key, { status: "sending" });
      try {
        await uploadFile(`/api/records/${encodeURIComponent(recordId)}/files`, file, {
          ifMatch: props.version,
          site: siteId,
          signal: controller.signal,
          onProgress: (sent) => {
            update(entry.key, { sent });
          },
        });
        update(entry.key, { status: "done", sent: file.size, message: "Added." });
        await queries.invalidateQueries({ queryKey: filesKey(recordId) });
      } catch (error) {
        if (error instanceof ApiError && error.code === "cancelled") {
          update(entry.key, { status: "cancelled", message: "Cancelled." });
        } else {
          update(entry.key, { status: "failed", message: failureText(error) });
        }
      } finally {
        cancel.current = undefined;
      }
    }
    setBusy(false);
  }

  async function remove(file: StoredFileEntry) {
    setRemoveBusy(true);
    try {
      await api(
        `/api/records/${encodeURIComponent(recordId)}/files/${encodeURIComponent(file.id)}`,
        {
          method: "DELETE",
          ifMatch: props.version,
          site: siteId,
        },
      );
      setNotice({ tone: "green", text: `Removed ${file.name}.` });
      await queries.invalidateQueries({ queryKey: filesKey(recordId) });
    } catch (error) {
      const why =
        error instanceof ApiError && error.code === "not_permitted"
          ? "You may remove only the files you added yourself."
          : failureText(error);
      setNotice({ tone: "amber", text: `${file.name} wasn't removed. ${why}` });
    } finally {
      setRemoveBusy(false);
      setRemoving(undefined);
    }
  }

  const files = list.data?.files ?? [];
  const images = files.filter((f) => VIEWABLE.has(f.mediaType) && servable(f));
  const unscanned = files.some((f) => f.scan === "not_scanned");
  const notYet = files.some((f) => f.scan === "not_yet_scanned");
  const tooLarge = files.some((f) => f.scan === "too_large_to_scan");
  const infected = files.filter((f) => f.scan === "infected").length;
  const scanNotes: ReactNode[] = [];
  if (unscanned) {
    scanNotes.push(
      <Note key="unscanned" tone="amber">
        These files have not been scanned for viruses: this server has no virus scanner set up. Open
        them only if you trust where they came from.
      </Note>,
    );
  }
  if (notYet) {
    scanNotes.push(
      <Note key="not-yet" tone="blue">
        Files marked Not yet scanned were added before virus scanning was turned on. They can still
        be opened while they wait for their first scan. If the same file is uploaded again, every
        copy of it waits for that scan before it can be opened.
      </Note>,
    );
  }
  if (tooLarge) {
    scanNotes.push(
      <Note key="too-large" tone="amber">
        Files marked Too large to scan are larger than the virus scanner accepts, so they have not
        been scanned for viruses. They were added before scanning was turned on or before its limit
        was lowered, and can still be opened: open them only if you trust where they came from.
      </Note>,
    );
  }
  if (infected > 0) {
    scanNotes.push(
      <Note key="infected" tone="amber">
        {infected === 1
          ? "A virus was found in one file. It is quarantined: no one can download or open it."
          : `Viruses were found in ${String(infected)} files. They are quarantined: no one can download or open them.`}
      </Note>,
    );
  }
  const done = uploads.filter((u) => u.status === "done").length;

  return (
    <section className={styles.panel} aria-labelledby="files-title">
      <h2 id="files-title" className={styles.sectionTitle}>
        Files
      </h2>
      <p className={styles.meta}>
        Photos, scans and other files kept with this record. Oculus reads each file to find what it
        really is, whatever its name says.
      </p>
      {props.canUpload ? (
        <div className={styles.actions}>
          <FileTrigger
            allowsMultiple
            onSelect={(selected) => {
              if (selected === null || busy) return;
              void send([...selected]);
            }}
          >
            <Button variant="secondary" isDisabled={busy}>
              Add files
            </Button>
          </FileTrigger>
          {busy ? (
            <Button
              variant="secondary"
              onPress={() => {
                cancelAll.current = true;
                cancel.current?.abort();
              }}
            >
              Cancel uploads
            </Button>
          ) : null}
        </div>
      ) : null}
      {uploads.length === 0 ? null : (
        <ul className={styles.uploads} aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.key} className={styles.upload}>
              <span className={styles.uploadName}>{u.name}</span>
              <progress
                className={styles.progress}
                max={Math.max(u.size, 1)}
                value={u.status === "done" ? Math.max(u.size, 1) : u.sent}
                aria-label={`Upload of ${u.name}`}
              />
              <span className={styles.meta}>
                {u.status === "waiting"
                  ? "Waiting"
                  : u.status === "sending"
                    ? `${sizeText(u.sent)} of ${sizeText(u.size)}`
                    : u.message}
              </span>
              {u.status === "sending" ? (
                <Button
                  variant="link"
                  onPress={() => {
                    cancel.current?.abort();
                  }}
                >
                  Cancel {u.name}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notice === undefined ? null : (
        <Note tone={notice.tone} alert={notice.tone === "amber"}>
          {notice.text}
        </Note>
      )}
      <ConfirmPanel
        isOpen={removing !== undefined}
        title={`Remove ${removing?.name ?? "this file"}?`}
        confirmLabel="Remove the file"
        danger
        busy={removeBusy}
        onCancel={() => {
          setRemoving(undefined);
        }}
        onConfirm={() => {
          if (removing !== undefined) void remove(removing);
        }}
      >
        <p>
          It is taken off this record. Its copy on the server is deleted once no record uses it.
        </p>
      </ConfirmPanel>
      <p role="status" className={styles.meta}>
        {busy ? "Uploading…" : done > 0 ? `${String(done)} added.` : ""}
      </p>
      <FileViewer
        recordId={recordId}
        images={images}
        index={viewing}
        onIndex={setViewing}
        onClose={() => {
          const shown = viewing === undefined ? undefined : images[viewing];
          setViewing(undefined);
          // The focus goes to the preview button of the image shown last.
          if (shown !== undefined) {
            requestAnimationFrame(() => {
              document.getElementById(previewId(shown.id))?.focus();
            });
          }
        }}
      />
      {list.isPending ? (
        <p role="status">Loading the files…</p>
      ) : list.isError ? (
        <Note tone="amber" alert>
          The files couldn't be loaded. {problemText(list.error)}
        </Note>
      ) : files.length === 0 ? (
        <p className={styles.empty}>No files yet.</p>
      ) : (
        <>
          {scanNotes}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Files on this record</caption>
              <thead>
                <tr>
                  <th scope="col">Preview</th>
                  <th scope="col">Name</th>
                  <th scope="col">Size</th>
                  <th scope="col">Type</th>
                  <th scope="col">Added</th>
                  <th scope="col">Virus scan</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {VIEWABLE.has(f.mediaType) && servable(f) ? (
                        <AriaButton
                          className={styles.thumbButton}
                          id={previewId(f.id)}
                          aria-label={`Preview ${f.name}`}
                          onPress={() => {
                            setViewing(images.indexOf(f));
                          }}
                        >
                          <Thumbnail
                            url={`${fileUrl(recordId, f.id, "thumbnail")}?size=small`}
                            label={FORMAT_LABELS[f.mediaType] ?? "View"}
                          />
                        </AriaButton>
                      ) : (
                        <span className={styles.meta}>None</span>
                      )}
                    </td>
                    <td>{f.name}</td>
                    <td>{sizeText(f.size)}</td>
                    <td>{f.mediaType}</td>
                    <td>{whenText(f.createdAt)}</td>
                    <td>
                      <ScanPill scan={f.scan} />
                    </td>
                    <td>
                      <div className={styles.fileActions}>
                        {servable(f) ? (
                          <a
                            className={styles.downloadLink}
                            href={fileUrl(recordId, f.id, "content")}
                            download
                          >
                            Download {f.name}
                          </a>
                        ) : (
                          <span className={styles.meta}>{WITHHELD[f.scan ?? ""] ?? ""}</span>
                        )}
                        {props.canUpload ? (
                          <Button
                            variant="link"
                            isDisabled={busy || removeBusy}
                            onPress={() => {
                              setNotice(undefined);
                              setRemoving(f);
                            }}
                          >
                            Remove {f.name}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
