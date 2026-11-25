// The idle timer (T-062, D-098) with fake timers: it warns a minute before
// the session's limit and signs out at it; activity becomes a use of the
// server at most once a minute (and at the end of that minute when the
// person was active inside it); the warning ends only when a use is known;
// activity noticed after the end signs out instead of reviving; and tabs
// share uses and sign-outs through the channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readIdleMessage, type IdleChannel, type IdleMessage } from "./channel";
import { IdleTimer, type IdleTimerOptions } from "./IdleTimer";

const MINUTE = 60_000;

/** Channels joined like tabs of one browser: a post reaches every other one. */
function tabs() {
  const all: { listeners: Set<(m: IdleMessage) => void>; posted: IdleMessage[] }[] = [];
  const open = (): IdleChannel & { posted: IdleMessage[] } => {
    const me = { listeners: new Set<(m: IdleMessage) => void>(), posted: [] as IdleMessage[] };
    all.push(me);
    return {
      posted: me.posted,
      post(message) {
        me.posted.push(message);
        for (const other of all) {
          if (other !== me) for (const l of other.listeners) l(message);
        }
      },
      listen(listener) {
        me.listeners.add(listener);
        return () => me.listeners.delete(listener);
      },
      close() {
        me.listeners.clear();
      },
    };
  };
  return open;
}

interface Tab {
  timer: IdleTimer;
  channel: ReturnType<ReturnType<typeof tabs>>;
  pings: number;
  events: string[];
}

/** A tab whose ping is answered by the server at once (the use arrives through `used`). */
function tab(open: ReturnType<typeof tabs>, options: Partial<IdleTimerOptions> = {}): Tab {
  const channel = open();
  const t: Tab = { channel, pings: 0, events: [] } as unknown as Tab;
  t.timer = new IdleTimer({
    idleSeconds: 30 * 60,
    channel,
    ping: () => {
      t.pings += 1;
      const sentAt = Date.now();
      return Promise.resolve().then(() => {
        t.timer.used(sentAt);
      });
    },
    onWarn: (deadline) => t.events.push(`warn:${String(deadline - Date.now())}`),
    onWarnEnd: () => t.events.push("warn-end"),
    onExpire: (where) => t.events.push(`expire:${where}`),
    ...options,
  });
  t.timer.start();
  return t;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-24T12:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("on its own", () => {
  it("warns a minute before the limit and signs out at it", async () => {
    const t = tab(tabs());
    await vi.advanceTimersByTimeAsync(29 * MINUTE - 1);
    expect(t.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.events).toEqual(["warn:60000"]);
    expect(t.timer.isWarning).toBe(true);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(t.events).toEqual(["warn:60000"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.events).toEqual(["warn:60000", "expire:here"]);
    expect(t.timer.isFinished).toBe(true);
    // The other tabs are told.
    expect(t.channel.posted).toEqual([{ type: "signed-out" }]);
  });

  it("follows the session's own limit", async () => {
    const t = tab(tabs(), { idleSeconds: 5 * 60 });
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(t.events).toEqual(["warn:60000"]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.events.at(-1)).toBe("expire:here");
  });

  it("turns activity into a use at most once a minute, and at the minute's end", async () => {
    const t = tab(tabs());
    // Just started: the first minute's activity waits for its end.
    await vi.advanceTimersByTimeAsync(1000);
    t.timer.activity();
    t.timer.activity();
    expect(t.pings).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE - 1000);
    expect(t.pings).toBe(1);
    const firstDeadline = t.timer.deadline;
    expect(firstDeadline).toBe(Date.now() + 30 * MINUTE);
    // A quiet minute: nothing is sent.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(t.pings).toBe(1);
    // Activity more than a minute after the last use: sent at once.
    t.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pings).toBe(2);
    expect(t.timer.deadline).toBe(Date.now() + 30 * MINUTE);
  });

  it("keeps a person who types now and then signed in for hours", async () => {
    const t = tab(tabs());
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      t.timer.activity();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(t.events).toEqual([]);
    expect(t.timer.isFinished).toBe(false);
  });

  it("asks the server at once during the warning, and the warning ends only when that use is known", async () => {
    let answer: (() => void) | undefined;
    const open = tabs();
    const t = tab(open, {
      ping: () =>
        new Promise<void>((resolve) => {
          t.pings += 1;
          const sentAt = Date.now();
          answer = () => {
            t.timer.used(sentAt);
            resolve();
          };
        }),
    });
    await vi.advanceTimersByTimeAsync(29 * MINUTE + 30_000);
    expect(t.timer.isWarning).toBe(true);
    t.timer.activity();
    t.timer.activity(); // one request at a time
    expect(t.pings).toBe(1);
    expect(t.timer.isWarning).toBe(true);
    answer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual(["warn:60000", "warn-end"]);
    expect(t.timer.deadline).toBe(Date.now() + 30 * MINUTE);
  });

  it("stays in the warning when the server can't be reached, and signs out at the end", async () => {
    const t = tab(tabs(), { ping: () => Promise.reject(new Error("offline")) });
    await vi.advanceTimersByTimeAsync(29 * MINUTE + 10_000);
    t.timer.check();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(t.events).toEqual(["warn:60000", "expire:here"]);
  });

  it("signs out, never revives, on activity noticed after the end (a laptop waking)", () => {
    const t = tab(tabs());
    // Timers held back: the clock jumps past the end without them firing.
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    t.timer.activity();
    expect(t.events).toEqual(["expire:here"]);
    expect(t.pings).toBe(0);
    // A use reported afterwards changes nothing.
    t.timer.used(Date.now());
    t.timer.activity();
    expect(t.events).toEqual(["expire:here"]);
  });

  it("stops when stopped", async () => {
    const t = tab(tabs());
    t.timer.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(t.events).toEqual([]);
  });
});

describe("across tabs", () => {
  it("restarts the limit in every tab when one is used", async () => {
    const open = tabs();
    const a = tab(open);
    const b = tab(open);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    a.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.pings).toBe(1);
    expect(b.timer.deadline).toBe(a.timer.deadline);
    // Tab B saw no activity of its own and doesn't ask the server.
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(b.pings).toBe(0);
    expect(b.events).toEqual(["warn:60000"]);
    expect(a.events).toEqual(["warn:60000"]);
    // "Stay signed in" in B ends the warning in A too.
    b.timer.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.events).toEqual(["warn:60000", "warn-end"]);
    expect(b.events).toEqual(["warn:60000", "warn-end"]);
  });

  it("signs every tab out when one signs out for no use", async () => {
    const open = tabs();
    const a = tab(open);
    const b = tab(open, { idleSeconds: 31 * 60 }); // a little behind, as tabs are
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(a.events.at(-1)).toBe("expire:here");
    expect(b.events.at(-1)).toBe("expire:elsewhere");
    expect(b.channel.posted).toEqual([]);
  });

  it("takes a use reported for a time still to come as now", async () => {
    const open = tabs();
    const a = tab(open);
    const forger = open();
    forger.post({ type: "use", at: Date.now() + 365 * 24 * 60 * MINUTE });
    expect(a.timer.deadline).toBe(Date.now() + 30 * MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(a.events.at(-1)).toBe("expire:here");
  });
});

describe("the channel's messages", () => {
  it("are exactly one of two shapes", () => {
    expect(readIdleMessage({ type: "use", at: 5 })).toEqual({ type: "use", at: 5 });
    expect(readIdleMessage({ type: "signed-out" })).toEqual({ type: "signed-out" });
    for (const bad of [
      null,
      "use",
      [],
      { type: "use" },
      { type: "use", at: "5" },
      { type: "use", at: Number.NaN },
      { type: "use", at: Infinity },
      { type: "use", at: -1 },
      { type: "use", at: 5, extra: 1 },
      { type: "signed-out", at: 5 },
      { type: "sign-in" },
    ]) {
      expect(readIdleMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
