/**
 * "Show more" under a paged share list (S-036a). What it did is said in a
 * polite live region beside it, without moving focus; only when the button
 * goes (nothing more to ask for) does focus move to that note, so keyboard
 * and screen-reader users aren't left on nothing.
 */
import { useEffect, useRef, useState } from "react";
import { problemText } from "../api";
import { Button, Note } from "../components/ui";
import styles from "../records/Records.module.css";
import { moreText, type MoreResult } from "./paging";

export function ShowMore(props: {
  readonly pages: {
    readonly next: string | null;
    readonly loading: boolean;
    readonly error: unknown;
    readonly loadMore: () => Promise<MoreResult>;
  };
  /** The list's things, in the plural: "offers", "shared items", "shares". */
  readonly what: string;
}) {
  const [note, setNote] = useState<{ text: string; last: boolean }>();
  const noteRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (note?.last === true) noteRef.current?.focus();
  }, [note]);
  const { next, loading, error, loadMore } = props.pages;
  if (next === null && error === undefined && note === undefined) return null;
  return (
    <div className={styles.actions}>
      {error === undefined ? null : (
        <Note tone="amber" alert>
          More {props.what} couldn't be loaded. {problemText(error)}
        </Note>
      )}
      {next === null ? null : (
        <Button
          variant="secondary"
          isDisabled={loading}
          onPress={() =>
            void loadMore().then((result) => {
              setNote({ text: moreText(result, props.what), last: !result.more });
            })
          }
        >
          Show more {props.what}
        </Button>
      )}
      <p ref={noteRef} tabIndex={-1} className={styles.meta} aria-live="polite">
        {note?.text ?? ""}
      </p>
    </div>
  );
}
