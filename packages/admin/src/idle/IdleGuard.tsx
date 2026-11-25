/**
 * Signing out after a period of no use (T-062, D-098), on screen: inside
 * the frame, so only while signed in. It runs the `IdleTimer` on the
 * session's own limit, counts a key press, a pointer press, a scroll and
 * coming back to the tab as activity, and shows the one-minute warning.
 * When the time is up and the server says the session has ended, it first
 * clears the screen (the sign-in screen with a short reason, then
 * `endSession`: the CSRF token, the query cache, the lists' memory) and
 * only then sends the sign-out, with the token it kept and a 5-second limit,
 * without waiting for it: a request that never settles can't leave the
 * screen up. Unsaved editor changes are not kept anywhere: the warning says
 * they will be lost.
 *
 * The warning is a panel fixed over the page, not a modal (D-083: a modal
 * hides the page from Alfa's checks and dims it below AA contrast). It is an
 * `alertdialog` named by its heading and described by its text; focus moves
 * to "Stay signed in" when it appears and back to where it was when it goes
 * (or to the page's main region if that element is gone); Escape stays
 * signed in too; the countdown is announced once on reaching 30 seconds and
 * once on reaching 10 in an assertive live region (every second would drown
 * out everything else).
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, currentCsrfToken, onSessionUse } from "../api";
import { Button } from "../components/ui";
import { endSession, isSessionEnded } from "../session";
import {
  isSessionMarker,
  openIdleChannel,
  type IdleChannel,
  type SignedOutReason,
} from "./channel";
import { IdleTimer, type ExpiredWhere } from "./IdleTimer";
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

/** How long the sign-out request and the end-of-time check may take. */
const SIGN_OUT_TIMEOUT_MS = 5000;

/** "1 second", "45 seconds". */
function seconds(n: number): string {
  return `${String(n)} ${n === 1 ? "second" : "seconds"}`;
}

function secondsLeft(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** The sign-in screen's reason. */
export function signedOutNotice(
  reason: SignedOutReason | "unconfirmed",
  idleSeconds: number,
  unsaved: boolean,
): string {
  const minutes = Math.max(1, Math.round(idleSeconds / 60));
  const span = minutes === 1 ? "a minute" : `${String(minutes)} minutes`;
  const lost = unsaved ? " Changes that weren't saved were lost." : "";
  switch (reason) {
    case "idle":
      return `You were signed out because Oculus wasn't used for ${span}.${lost}`;
    case "unconfirmed":
      return `Oculus wasn't used for ${span}, so this screen was cleared. Sign in to go on.${lost}`;
    case "manual":
      return `You signed out in another tab.${lost}`;
    case "ended":
      return `Your sign-in has ended. Sign in again.${lost}`;
  }
}

/** Where focus goes when the element that had it before the warning is gone. */
function fallbackFocus(): HTMLElement | null {
  const main = document.getElementById("main");
  if (main !== null) return main;
  return document.querySelector("h1");
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
  // The thresholds already announced: each once, even if a tick is skipped.
  const announced = useRef<{ 30: boolean; 10: boolean }>({ 30: false, 10: false });

  useEffect(() => {
    const tick = setInterval(() => {
      const n = secondsLeft(deadline);
      setLeft(n);
      for (const threshold of [10, 30] as const) {
        if (n <= threshold && !announced.current[threshold]) {
          announced.current[30] = true;
          if (threshold === 10) announced.current[10] = true;
          setSpoken(`You'll be signed out in ${seconds(n)}.`);
          break;
        }
      }
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
      // Back to where the person was, or to the page's main region if that
      // is gone, unless the person has moved focus meanwhile.
      const now = document.activeElement;
      if (now !== null && now !== document.body && now.isConnected) return;
      const target =
        before instanceof HTMLElement && before.isConnected && before !== document.body
          ? before
          : fallbackFocus();
      target?.focus();
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
  /** The session's marker from `GET /api/me`. */
  readonly marker: string;
  /** The cross-tab channel (tests); a BroadcastChannel or its fallback otherwise. */
  readonly channel?: () => IdleChannel;
}) {
  const { idleSeconds, marker } = props;
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
    /** Forget the screen first, then (here) end the session on the server without waiting. */
    async function leave(where: ExpiredWhere) {
      if (!live) return;
      live = false;
      const unsaved = hasUnsavedChanges();
      const reason =
        typeof where === "string" ? (where === "here" ? "idle" : where) : where.elsewhere;
      // The token to sign out with, before endSession forgets it.
      const csrf = currentCsrfToken();
      setWarning(undefined);
      setSessionEnding(true);
      try {
        await go.current("/sign-in", {
          replace: true,
          state: { notice: signedOutNotice(reason, idleSeconds, unsaved) },
        });
      } finally {
        endSession(queries);
        setSessionEnding(false);
      }
      if (where === "here") {
        // Fire and forget, with a time limit: the screen is already clear,
        // and a session the server has ended needs nothing more. A sign-out
        // that never arrives changes nothing either: the session is past its
        // limit on the server.
        void api("/api/sign-out", {
          body: {},
          ...(csrf === undefined ? {} : { csrfToken: csrf }),
          signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
        }).catch(() => undefined);
      }
    }
    /** Another session is this browser's now: drop this one's data and load the frame again. */
    async function replaced() {
      if (!live) return;
      live = false;
      setWarning(undefined);
      setSessionEnding(true);
      try {
        await go.current("/", { replace: true });
      } finally {
        endSession(queries);
        setSessionEnding(false);
      }
    }
    const t = new IdleTimer({
      idleSeconds,
      marker,
      channel,
      ping: () => api("/api/session"),
      confirm: async () => {
        try {
          const reply = await api<{ sessionMarker?: unknown; idleSecondsLeft?: unknown }>(
            "/api/session",
            { background: true, signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS) },
          );
          const left = reply.idleSecondsLeft;
          if (!isSessionMarker(reply.sessionMarker) || typeof left !== "number") {
            throw new Error("unexpected reply");
          }
          return { alive: true, marker: reply.sessionMarker, secondsLeft: left };
        } catch (error) {
          if (isSessionEnded(error)) return { alive: false };
          throw error;
        }
      },
      onWarn: (deadline) => {
        setWarning({ deadline, unsaved: hasUnsavedChanges() });
      },
      onWarnEnd: () => {
        setWarning(undefined);
      },
      onExpire: (where) => {
        void leave(where);
      },
      onReplaced: () => {
        void replaced();
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
  }, [idleSeconds, marker, queries, openChannel]);

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
