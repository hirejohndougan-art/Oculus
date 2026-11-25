/**
 * The admin's idle timer (T-062, D-098), without React: it follows the
 * server's idle limit, warns a minute before it and signs out when it runs
 * out.
 *
 * - **The server's clock is the one that matters.** The server ends a
 *   session `idleSeconds` after its last use (D-069), and a use is a request
 *   not marked background. So the timer counts from the last use it knows
 *   of (`used`: the send time of a request the server answered, which is
 *   never later than when the server counted it, or a use another tab
 *   reported), never from a key press alone: the screen is never still
 *   showing when the server has already ended the session.
 * - **Activity becomes a use.** A key press, a pointer press, a scroll or
 *   coming back to the tab (`activity`) asks the server (`ping`, a counted
 *   read) at most once per `pingSeconds`, and once more at the end of that
 *   window if the person was active inside it, so the server hears of
 *   activity within `pingSeconds` of it.
 * - **The warning** comes `warnSeconds` before the end; any activity
 *   during it (or "Stay signed in") asks the server at once, and the warning
 *   ends when that use is known. When the end comes, or activity is noticed
 *   after the end (a laptop waking up, a tab whose timers were held back),
 *   the timer signs out (`onExpire`) and tells the other tabs.
 * - **Tabs share it** through an `IdleChannel`: every use is posted, so
 *   activity in one tab restarts the limit in all; a sign-out is posted, so
 *   every tab clears its screen. A use reported for a time still to come is
 *   taken as now.
 */
import type { IdleChannel, IdleMessage } from "./channel";

export interface IdleTimerOptions {
  /** The session's idle limit, from the server. */
  readonly idleSeconds: number;
  /** How long before the end the warning shows (60). */
  readonly warnSeconds?: number;
  /** At most one activity check with the server per this many seconds (60). */
  readonly pingSeconds?: number;
  readonly now?: () => number;
  readonly channel: IdleChannel;
  /** A read that counts as a use (`GET /api/session`); its success arrives through `used`. */
  readonly ping: () => Promise<unknown>;
  /** The warning starts; `deadline` is when the session ends. */
  readonly onWarn: (deadline: number) => void;
  /** The warning ends because the session was used. */
  readonly onWarnEnd: () => void;
  /** The session ran out: here (sign out on the server) or in another tab (already done). */
  readonly onExpire: (where: "here" | "elsewhere") => void;
}

/** The fewest seconds a limit may be for the timer: the server's own minimum is 300. */
const MIN_IDLE_SECONDS = 120;

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
  private warning = false;
  private finished = false;

  constructor(options: IdleTimerOptions) {
    this.options = options;
    const idle = Number.isInteger(options.idleSeconds) ? options.idleSeconds : 1800;
    this.idleMs = Math.max(MIN_IDLE_SECONDS, idle) * 1000;
    this.warnMs = Math.min((options.warnSeconds ?? 60) * 1000, this.idleMs / 2);
    this.pingMs = Math.min((options.pingSeconds ?? 60) * 1000, this.idleMs / 4);
    this.now = options.now ?? Date.now;
    this.lastUse = this.now();
  }

  /** When the session ends unless it is used again. */
  get deadline(): number {
    return this.lastUse + this.idleMs;
  }

  get isWarning(): boolean {
    return this.warning;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Starts counting from now (the session was just used, or is about to be) and listens to the other tabs. */
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
    if (this.finished) return;
    const t = this.now();
    if (t >= this.deadline) {
      this.expire("here");
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

  /** Asks the server now with a use (the "Stay signed in" button, a new screen). */
  check(): void {
    if (this.finished || this.pinging) return;
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
    if (this.note(at)) this.options.channel.post({ type: "use", at: this.lastUse });
  }

  private fromOtherTab(message: IdleMessage): void {
    if (this.finished) return;
    if (message.type === "use") {
      this.note(message.at);
      return;
    }
    this.finished = true;
    this.stop();
    this.options.onExpire("elsewhere");
  }

  /** Moves the last use forward; whether it moved. */
  private note(at: number): boolean {
    if (this.finished) return false;
    const t = this.now();
    // Not after the end already passed here: that session is over.
    if (t >= this.deadline) {
      this.expire("here");
      return false;
    }
    const when = Math.min(at, t);
    // Equal counts: the first real use may share the start's millisecond.
    if (!(when >= this.lastUse)) return false;
    this.lastUse = when;
    if (this.warning) {
      this.warning = false;
      this.options.onWarnEnd();
    }
    this.schedule();
    return true;
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
      this.expire("here");
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
      if (this.now() >= this.deadline) this.expire("here");
      else this.schedule();
    }, end - t);
  }

  private warn(): void {
    if (this.warning || this.finished) return;
    this.warning = true;
    this.options.onWarn(this.deadline);
  }

  private expire(where: "here" | "elsewhere"): void {
    if (this.finished) return;
    this.finished = true;
    this.warning = false;
    this.stop();
    if (where === "here") this.options.channel.post({ type: "signed-out" });
    this.options.onExpire(where);
  }
}
