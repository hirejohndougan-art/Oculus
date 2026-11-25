/**
 * A simple image viewer (M-003, D-095): one of a record's images at a time,
 * shown with `<img>` from the API's inline view (never `<object>`,
 * `<embed>` or a frame), with Previous, Next and Close. It opens in the
 * page, not as a modal (D-083's rule for confirmations): the focus moves
 * into it, Escape closes it (the panel gives the focus back to the button
 * that opened it), and the left and right arrow keys move between images,
 * going round at the ends. An image the server won't show (too large) offers its download
 * instead. Names are text only.
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
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
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
          <p className={styles.meta}>
            This image can&apos;t be shown here (it may be too large). Download it to see it.
          </p>
        ) : (
          <img
            key={current.id}
            className={styles.viewerImage}
            src={fileUrl(recordId, current.id, "view")}
            alt={current.name}
            onError={() => {
              setFailed((all) => new Set([...all, current.id]));
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
