/**
 * A simple image viewer (M-003, D-097): one of a record's images at a time,
 * shown with `<img>` from the API's inline view (never `<object>`,
 * `<embed>` or a frame), with Previous, Next and Close. It opens in the
 * page, not as a modal (D-083's rule for confirmations): the focus moves
 * into it, Escape closes it (the panel gives the focus to the preview
 * button of the image shown last), and the left and right arrow keys move between images,
 * going round at the ends. An image the server won't show says why (by the
 * reply's status) and offers its download instead. Names are text only.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import type { StoredFileEntry } from "./FilesPanel";
import styles from "./Records.module.css";

/** The URL of one of the asset's files: its bytes (`content`), inline view or thumbnail. */
export function fileUrl(
  recordId: string,
  fileId: string,
  what: "content" | "view" | "thumbnail",
): string {
  return `/api/records/${encodeURIComponent(recordId)}/files/${encodeURIComponent(fileId)}/${what}`;
}

/** What to say when an image can't be shown, by the reply's status. */
export function viewErrorText(status: number): string {
  switch (status) {
    case 422:
      return "This image can't be shown here: it is too large or not a plain image. Download it to see it.";
    case 404:
      return "This file is no longer on the record. Reload the page.";
    case 409:
      return "This image hasn't passed its virus scan yet, so it can't be shown. Try again in a moment.";
    case 423:
      return "A virus was found in this file. It is quarantined and can't be shown.";
    case 401:
      return "You have been signed out. Sign in again to see this image.";
    case 429:
      return "Too many files are open at once. Close some, then try again.";
    default:
      return "The image couldn't be loaded. Try again in a moment, or download it.";
  }
}

interface Props {
  readonly recordId: string;
  /** The images that may be shown, in the list's order. */
  readonly images: readonly StoredFileEntry[];
  /** Which is shown; `undefined` when the viewer is closed. */
  readonly index: number | undefined;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
}

export function FileViewer(props: Props) {
  const { images, index, recordId } = props;
  const current = index === undefined ? undefined : images[index];
  /** Why an image couldn't be shown, by file. */
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const region = useRef<HTMLElement>(null);
  const count = images.length;
  const at = index ?? 0;
  const open = current !== undefined;
  // Previous and Next go round (from the last image to the first), so the
  // buttons are never disabled and never lose the focus.
  const go = (to: number) => {
    if (count > 0) props.onIndex((to + count) % count);
  };
  // Opened: the focus moves into the viewer.
  useEffect(() => {
    if (open) region.current?.focus();
  }, [open]);
  if (current === undefined) return null;
  return (
    <section
      ref={region}
      className={styles.viewerDialog}
      aria-label={`Preview of ${current.name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") go(at - 1);
        else if (event.key === "ArrowRight") go(at + 1);
        else if (event.key === "Escape") props.onClose();
        else return;
        event.preventDefault();
      }}
    >
      <div className={styles.viewerHeader}>
        <h3 className={styles.sectionTitle}>{current.name}</h3>
        <p className={styles.meta} aria-live="polite">
          Image {String(at + 1)} of {String(count)}
        </p>
      </div>
      <div className={styles.viewerStage}>
        {failed.has(current.id) ? (
          <p className={styles.meta} role="alert">
            {failed.get(current.id)}
          </p>
        ) : (
          <img
            key={current.id}
            className={styles.viewerImage}
            src={fileUrl(recordId, current.id, "view")}
            alt={current.name}
            onError={() => {
              const id = current.id;
              void (async () => {
                // The image's own status says why (HEAD opens nothing).
                let status = 0;
                try {
                  status = (await fetch(fileUrl(recordId, id, "view"), { method: "HEAD" })).status;
                } catch {
                  // Offline.
                }
                setFailed((all) => new Map([...all, [id, viewErrorText(status)]]));
              })();
            }}
          />
        )}
      </div>
      <div className={styles.viewerControls}>
        <Button
          variant="secondary"
          onPress={() => {
            go(at - 1);
          }}
        >
          Previous image
        </Button>
        <Button
          variant="secondary"
          onPress={() => {
            go(at + 1);
          }}
        >
          Next image
        </Button>
        <a className={styles.downloadLink} href={fileUrl(recordId, current.id, "content")} download>
          Download {current.name}
        </a>
        <Button variant="dark" onPress={props.onClose}>
          Close preview
        </Button>
      </div>
    </section>
  );
}
