/**
 * Signing out after a period of no use (T-062, D-098), on screen: inside
 * the frame, so only while signed in. It runs the `IdleTimer` on the
 * session's own limit, counts a key press, a pointer press, a scroll and
 * coming back to the tab as activity, shows the one-minute warning, and
 * when the time is up signs out on the server, forgets the session's data
 * (`endSession`: the CSRF token, the query cache, the lists' memory) and
 * goes to the sign-in screen with a short reason. Unsaved editor changes
 * are not kept anywhere: the warning says they will be lost.
 *
 * The warning is a panel fixed over the page, not a modal (D-083: a modal
 * hides the page from Alfa's checks and dims it below AA contrast). It is an
 * `alertdialog` named by its heading and described by its text; focus moves
 * to "Stay signed in" when it appears and back to where it was when it goes;
 * Escape stays signed in too; the countdown is announced at 30 and 10
 * seconds in an assertive live region (every second would drown out
 * everything else).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, onSessionUse } from "../api";
import { Button } from "../components/ui";
import { endSession } from "../session";
import { openIdleChannel, type IdleChannel } from "./channel";
import { IdleTimer } from "./IdleTimer";
import { hasUnsavedChanges, setSessionEnding } from "./unsaved";
import styles from "./Idle.module.css";

/**
 * The events that count as the person doing something (passive, on the
 * window). `focus` only when the window itself gains it (coming back to the
 * tab): focus moving inside the page is caused by a key or pointer already
 * counted, or by the page itself (the warning focusing its button), which
 * mustn't count.
 */
export const ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel", "touchstart", "focus"] as const;

/** "1 second", "45 seconds". */
function seconds(n: number): string {
  return `${String(n)} ${n === 1 ? "second" : "seconds"}`;
}

function secondsLeft(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** The sign-in screen's reason. */
export function signedOutNotice(idleSeconds: number, unsaved: boolean): string {
  const minutes = Math.max(1, Math.round(idleSeconds / 60));
  const span = minutes === 1 ? "a minute" : `${String(minutes)} minutes`;
  return (
    `You were signed out because Oculus wasn't used for ${span}.` +
    (unsaved ? " Changes that weren't saved were lost." : "")
  );
}

export function IdleWarning(props: {
  readonly deadline: number;
  readonly unsaved: boolean;
  readonly onStay: () => void;
}) {
  const { deadline } = props;
  const titleId = useId();
  const textId = useId();
  const unsavedId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(() => secondsLeft(deadline));
  const [spoken, setSpoken] = useState("");

  useEffect(() => {
    const tick = setInterval(() => {
      const n = secondsLeft(deadline);
      setLeft(n);
      if (n === 30 || n === 10) setSpoken(`You'll be signed out in ${seconds(n)}.`);
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [deadline]);

  useEffect(() => {
    const before = document.activeElement;
    const stay = ref.current?.querySelector("button");
    (stay ?? ref.current)?.focus();
    return () => {
      // Back to where the person was, if it is still there and focus is
      // still with the warning (not moved by the person meanwhile).
      const now = document.activeElement;
      if (
        before instanceof HTMLElement &&
        before.isConnected &&
        (now === null || now === document.body || !now.isConnected)
      ) {
        before.focus();
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      className={styles.warning}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={props.unsaved ? `${textId} ${unsavedId}` : textId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onStay();
      }}
    >
      <h2 id={titleId} className={styles.title}>
        Are you still there?
      </h2>
      <p id={textId} className={styles.text}>
        You&apos;ll be signed out in {seconds(left)}, because Oculus hasn&apos;t been used for a
        while.
      </p>
      {props.unsaved ? (
        <p id={unsavedId} className={styles.unsaved}>
          You have changes that aren&apos;t saved. They will be lost when you are signed out.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button variant="primary" onPress={props.onStay}>
          Stay signed in
        </Button>
      </div>
      <span className="visually-hidden" aria-live="assertive">
        {spoken}
      </span>
    </div>
  );
}

export function IdleGuard(props: {
  /** The session's idle limit from `GET /api/me`. */
  readonly idleSeconds: number;
  /** The cross-tab channel (tests); a BroadcastChannel or its fallback otherwise. */
  readonly channel?: () => IdleChannel;
}) {
  const { idleSeconds } = props;
  const openChannel = props.channel ?? openIdleChannel;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [warning, setWarning] = useState<{ deadline: number; unsaved: boolean }>();
  const timer = useRef<IdleTimer>(undefined);
  // Through a ref, so a new `navigate` never restarts the timer.
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  }, [navigate]);

  useEffect(() => {
    const channel = openChannel();
    let live = true;
    async function signOut(where: "here" | "elsewhere") {
      const unsaved = hasUnsavedChanges();
      setWarning(undefined);
      if (where === "here") {
        // Ended on the server first; a failure (offline, already ended)
        // still clears this screen, and the server ends it at its next use.
        try {
          await api("/api/sign-out", { body: {} });
        } catch {
          // As above.
        }
      }
      if (!live) return;
      setSessionEnding(true);
      try {
        await go.current("/sign-in", {
          replace: true,
          state: { notice: signedOutNotice(idleSeconds, unsaved) },
        });
      } finally {
        endSession(queries);
        setSessionEnding(false);
      }
    }
    const t = new IdleTimer({
      idleSeconds,
      channel,
      ping: () => api("/api/session"),
      onWarn: (deadline) => {
        setWarning({ deadline, unsaved: hasUnsavedChanges() });
      },
      onWarnEnd: () => {
        setWarning(undefined);
      },
      onExpire: (where) => {
        void signOut(where);
      },
    });
    timer.current = t;
    const stopUses = onSessionUse((at) => {
      t.used(at);
    });
    const onActivity = (event: Event) => {
      if (event.type === "focus" && event.target instanceof Node) return;
      t.activity();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") t.activity();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", onVisible);
    t.start();
    // Opening the admin is a use: it starts the count on the server too.
    t.check();
    return () => {
      live = false;
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, onActivity, { capture: true });
      }
      document.removeEventListener("visibilitychange", onVisible);
      stopUses();
      t.stop();
      channel.close();
      timer.current = undefined;
    };
  }, [idleSeconds, queries, openChannel]);

  if (warning === undefined) return null;
  return (
    <IdleWarning
      deadline={warning.deadline}
      unsaved={warning.unsaved}
      onStay={() => {
        timer.current?.check();
      }}
    />
  );
}
