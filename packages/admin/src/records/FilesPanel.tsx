/**
 * A digital asset's files (M-002, D-086): the files attached to it (name,
 * size, the type Oculus found in the bytes, when) and, for people who may
 * edit the asset, an upload control: several files at once, one after
 * another, each with a progress bar and a Cancel button. A file larger than
 * the server takes is refused here before it is sent. Viewing and
 * downloading come later (M-003); nothing here shows a file's content.
 * Names are shown as text only.
 */
import { useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText, uploadFile } from "../api";
import { Button, Note } from "../components/ui";
import { whenText } from "./model";
import styles from "./Records.module.css";

export interface StoredFileEntry {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly createdAt: string;
}

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
      return "It is larger than this server takes.";
    case "quota_exceeded":
      return "Your organization has used all its space for files.";
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
  const list = useQuery({
    queryKey: filesKey(recordId),
    queryFn: () =>
      api<FileListReply>(`/api/records/${encodeURIComponent(recordId)}/files`, { site: siteId }),
    refetchOnWindowFocus: false,
  });
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const [busy, setBusy] = useState(false);
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

  const files = list.data?.files ?? [];
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
      <p role="status" className={styles.meta}>
        {busy ? "Uploading…" : done > 0 ? `${String(done)} added.` : ""}
      </p>
      {list.isPending ? (
        <p role="status">Loading the files…</p>
      ) : list.isError ? (
        <Note tone="amber" alert>
          The files couldn't be loaded. {problemText(list.error)}
        </Note>
      ) : files.length === 0 ? (
        <p className={styles.empty}>No files yet.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Files on this record</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Size</th>
                <th scope="col">Type</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{sizeText(f.size)}</td>
                  <td>{f.mediaType}</td>
                  <td>{whenText(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
