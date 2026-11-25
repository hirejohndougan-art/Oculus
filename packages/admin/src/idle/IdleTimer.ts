/**
 * The admin's idle timer (T-062, D-098), without React: it follows the
 * server's idle limit, warns a minute before it and signs out when the
 * server says the session has ended.
 *
 * - **The server's clock is the one that matters.** The server ends a
 *   session `idleSeconds` after its last use (D-069), and a use is a request
 *   not marked background. So the timer counts from the last use it knows
 *   of (`used`: the send time of a request the server counted, which is
 *   never later than when the server stamped it, or a use another tab of the
 *   same session reported), never from a key press alone.
 * - **Activity becomes a use.** A key press, a pointer press, a scroll or
 *   coming back to the tab (`activity`) asks the server (`ping`, a counted
 *   read) at most once per `pingSeconds`, and once more at the end of that
 *   window if the person was active inside it, so the server hears of
 *   activity within `pingSeconds` of it.
 * - **The warning** comes `warnSeconds` before the end; any activity
 *   during it (or "Stay signed in") asks the server at once, and the warning
 *   ends when that use is known.
 * - **At the end, the server decides** (`confirm`, a background read that
 *   doesn't count as a use). Still alive (another tab used it, or this tab's
 *   timers were held back while it slept): the timer takes the server's time
 *   left and goes on. Ended: `onExpire("here")`, and the other tabs are told.
 *   Replaced by another session (signed in again or switched organization in
 *   another tab): `onReplaced`. The server can't be reached: the screen is
 *   cleared here (`onExpire("unconfirmed")`) but the other tabs are not told,
 *   since the session may still be alive for them.
 * - **Tabs share it** through an `IdleChannel`, every message naming the
 *   session by its marker. A use of this session restarts the limit; a
 *   sign-out of this session clears the screen; a use of another session
 *   makes the timer ask the server what has become of its own; another
 *   session's sign-out is ignored. A use reported for a time still to come is
 *   taken as now.
 */
import type { IdleChannel, IdleMessage, SignedOutReason } from "./channel";

/** What the server says of the session, read as background. */
export type SessionState =
  | { readonly alive: true; readonly marker: string; readonly secondsLeft: number }
  | { readonly alive: false };

export type ExpiredWhere = "here" | "unconfirmed" | { readonly elsewhere: SignedOutReason };

export interface IdleTimerOptions {
  /** The session's idle limit, from the server. */
  readonly idleSeconds: number;
  /** The session's marker, from the server. */
  readonly marker: string;
  /** How long before the end the warning shows (60). */
  readonly warnSeconds?: number;
  /** At most one activity check with the server per this many seconds (60). */
  readonly pingSeconds?: number;
  readonly now?: () => number;
  readonly channel: IdleChannel;
  /** A read that counts as a use (`GET /api/session`); its success arrives through `used`. */
  readonly ping: () => Promise<unknown>;
  /** A background read of the session; rejects when the server can't be reached. */
  readonly confirm: () => Promise<SessionState>;
  /** The warning starts; `deadline` is when the session ends. */
  readonly onWarn: (deadline: number) => void;
  /** The warning ends because the session was used. */
  readonly onWarnEnd: () => void;
  /** The session ended: confirmed here, unconfirmed (offline), or in another tab. */
  readonly onExpire: (where: ExpiredWhere) => void;
  /** The browser's session is another one now: this screen's data isn't its. */
  readonly onReplaced: () => void;
}

/** The shortest wait before asking the server again when it says a moment is left. */
const RECHECK_MS = 1000;

export class IdleTimer {
  private readonly idleMs: number;
  private readonly warnMs: number;
  private readonly pingMs: number;
  private readonly now: () => number;
  private readonly options: IdleTimerOptions;
  private lastUse: number;
  private lastActivity = 0;
  private warnTimer: ReturnType<typeof setTimeout> | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: (() => void) | undefined;
  private pinging = false;
  private confirming = false;
  private warning = false;
  private finished = false;

  constructor(options: IdleTimerOptions) {
    if (!Number.isInteger(options.idleSeconds) || options.idleSeconds < 120) {
      throw new RangeError("idleSeconds is a whole number of at least 120.");
    }
    this.options = options;
    this.idleMs = options.idleSeconds * 1000;
    this.warnMs = Math.min((options.warnSeconds ?? 60) * 1000, this.idleMs / 2);
    this.pingMs = Math.min((options.pingSeconds ?? 60) * 1000, this.idleMs / 4);
    this.now = options.now ?? Date.now;
    this.lastUse = this.now();
  }

  /** When the session ends unless it is used again (as far as this tab knows). */
  get deadline(): number {
    return this.lastUse + this.idleMs;
  }

  get isWarning(): boolean {
    return this.warning;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Starts counting from now and listens to the other tabs. */
  start(): void {
    this.unlisten = this.options.channel.listen((message) => {
      this.fromOtherTab(message);
    });
    this.schedule();
  }

  /** Stops every timer and stops listening; nothing more is called. */
  stop(): void {
    this.clearTimers();
    if (this.trailingTimer !== undefined) clearTimeout(this.trailingTimer);
    this.trailingTimer = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
  }

  /** The person did something on this screen. */
  activity(): void {
    if (this.finished || this.confirming) return;
    const t = this.now();
    if (t >= this.deadline) {
      this.atEnd();
      return;
    }
    this.lastActivity = t;
    if (this.warning || t - this.lastUse >= this.pingMs) {
      this.check();
      return;
    }
    // Inside the window: tell the server at its end, once.
    this.trailingTimer ??= setTimeout(
      () => {
        this.trailingTimer = undefined;
        if (!this.finished && this.lastActivity > this.lastUse) this.check();
      },
      Math.max(0, this.lastUse + this.pingMs - t),
    );
  }

  /** Asks the server now with a use (the "Stay signed in" button, opening the admin). */
  check(): void {
    if (this.finished || this.pinging || this.confirming) return;
    this.pinging = true;
    void this.options
      .ping()
      .catch(() => undefined)
      .finally(() => {
        this.pinging = false;
      });
  }

  /** The server counted a use sent at `at` (this tab's request). */
  used(at: number): void {
    if (this.note(at)) {
      this.options.channel.post({ type: "use", session: this.options.marker, at: this.lastUse });
    }
  }

  private fromOtherTab(message: IdleMessage): void {
    if (this.finished) return;
    if (message.session !== this.options.marker) {
      // Another session is in use in this browser: ours may have ended or
      // been replaced. Its sign-out says nothing of ours.
      if (message.type === "use") this.atEnd();
      return;
    }
    if (message.type === "use") {
      this.note(message.at);
      return;
    }
    this.finish({ elsewhere: message.reason });
  }

  /** Moves the last use forward; whether it moved. */
  private note(at: number): boolean {
    if (this.finished || this.confirming) return false;
    const t = this.now();
    if (t >= this.deadline) {
      this.atEnd();
      return false;
    }
    const when = Math.min(at, t);
    // Equal counts: the first real use may share the start's millisecond.
    if (!(when >= this.lastUse)) return false;
    this.setLastUse(when);
    return true;
  }

  private setLastUse(when: number): void {
    this.lastUse = when;
    if (this.warning && this.now() < this.deadline - this.warnMs) {
      this.warning = false;
      this.options.onWarnEnd();
    }
    this.schedule();
  }

  private clearTimers(): void {
    if (this.warnTimer !== undefined) clearTimeout(this.warnTimer);
    if (this.endTimer !== undefined) clearTimeout(this.endTimer);
    this.warnTimer = undefined;
    this.endTimer = undefined;
  }

  private schedule(): void {
    this.clearTimers();
    if (this.finished) return;
    const t = this.now();
    const end = this.deadline;
    if (t >= end) {
      this.atEnd();
      return;
    }
    const warnAt = end - this.warnMs;
    if (t >= warnAt) {
      this.warn();
    } else {
      this.warnTimer = setTimeout(() => {
        this.warnTimer = undefined;
        if (this.now() >= this.deadline - this.warnMs) this.warn();
        else this.schedule();
      }, warnAt - t);
    }
    this.endTimer = setTimeout(() => {
      this.endTimer = undefined;
      if (this.now() >= this.deadline) this.atEnd();
      else this.schedule();
    }, end - t);
  }

  private warn(): void {
    if (this.warning || this.finished) return;
    this.warning = true;
    this.options.onWarn(this.deadline);
  }

  /** This tab's time is up (or another session's news came): ask the server before acting. */
  private atEnd(): void {
    if (this.finished || this.confirming) return;
    this.confirming = true;
    this.clearTimers();
    this.options.confirm().then(
      (state) => {
        this.confirming = false;
        if (this.finished) return;
        if (!state.alive) {
          this.finish("here");
        } else if (state.marker !== this.options.marker) {
          this.finished = true;
          this.warning = false;
          this.stop();
          this.options.onReplaced();
        } else {
          // Alive: the server's time left, from now (never sooner than a moment).
          const left = Math.max(state.secondsLeft * 1000, RECHECK_MS);
          this.setLastUse(this.now() + left - this.idleMs);
        }
      },
      () => {
        this.confirming = false;
        if (!this.finished) this.finish("unconfirmed");
      },
    );
  }

  private finish(where: ExpiredWhere): void {
    if (this.finished) return;
    this.finished = true;
    this.warning = false;
    this.stop();
    if (where === "here") {
      this.options.channel.post({
        type: "signed-out",
        session: this.options.marker,
        reason: "idle",
      });
    }
    this.options.onExpire(where);
  }
}
