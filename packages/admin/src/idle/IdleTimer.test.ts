// The idle timer (T-062, D-098) with fake timers against a small model of
// the server's session: it warns a minute before the limit; at the end it
// asks the server (a background read) and signs out only when the server
// says the session has ended, goes on when it is still alive (a stale or
// throttled tab, a laptop waking while another tab kept it going), clears
// only its own screen when the server can't be reached, and reloads when
// another session has replaced its own; activity becomes a use at most once
// a minute (and at the minute's end when the person was active inside it);
// the warning ends only when a use is known; and tabs share uses and
// sign-outs of their own session only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readIdleMessage, type IdleChannel, type IdleMessage } from "./channel";
import { IdleTimer, type IdleTimerOptions, type SessionState } from "./IdleTimer";

const MINUTE = 60_000;
const M1 = "AAAAAAAAAAAAAAAA";
const M2 = "BBBBBBBBBBBBBBBB";

/** The server's view of the browser's session (its clock is the test's clock). */
class Server {
  marker = M1;
  lastUse = Date.now();
  idleMs = 30 * MINUTE;
  reachable = true;
  ended = false;
  get alive(): boolean {
    return !this.ended && Date.now() < this.lastUse + this.idleMs;
  }
  use(): boolean {
    if (!this.alive) return false;
    this.lastUse = Date.now();
    return true;
  }
  state(): Promise<SessionState> {
    if (!this.reachable) return Promise.reject(new Error("offline"));
    if (!this.alive) return Promise.resolve({ alive: false });
    const left = Math.floor((this.lastUse + this.idleMs - Date.now()) / 1000);
    return Promise.resolve({ alive: true, marker: this.marker, secondsLeft: left });
  }
}

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
  confirms: number;
  events: string[];
}

/** A tab whose ping is a use of `server` (the use arrives through `used`). */
function tab(
  server: Server,
  open: ReturnType<typeof tabs>,
  options: Partial<IdleTimerOptions> = {},
): Tab {
  const channel = open();
  const t: Tab = { channel, pings: 0, confirms: 0, events: [] } as unknown as Tab;
  t.timer = new IdleTimer({
    idleSeconds: 30 * 60,
    marker: M1,
    channel,
    ping: () => {
      t.pings += 1;
      const sentAt = Date.now();
      return Promise.resolve().then(() => {
        if (server.use()) t.timer.used(sentAt);
      });
    },
    confirm: () => {
      t.confirms += 1;
      return server.state();
    },
    onWarn: (deadline) => t.events.push(`warn:${String(deadline - Date.now())}`),
    onWarnEnd: () => t.events.push("warn-end"),
    onExpire: (where) =>
      t.events.push(`expire:${typeof where === "string" ? where : `elsewhere-${where.elsewhere}`}`),
    onReplaced: () => t.events.push("replaced"),
    ...options,
  });
  t.timer.start();
  return t;
}

let server: Server;
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-24T12:00:00Z") });
  server = new Server();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("on its own", () => {
  it("warns a minute before the limit, asks the server at it, and signs out when it has ended", async () => {
    const t = tab(server, tabs());
    await vi.advanceTimersByTimeAsync(29 * MINUTE - 1);
    expect(t.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.events).toEqual(["warn:60000"]);
    expect(t.timer.isWarning).toBe(true);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.confirms).toBeGreaterThanOrEqual(1);
    expect(t.events).toEqual(["warn:60000", "expire:here"]);
    expect(t.timer.isFinished).toBe(true);
    // The other tabs are told, for this session only.
    expect(t.channel.posted).toEqual([{ type: "signed-out", session: M1, reason: "idle" }]);
  });

  it("follows the session's own limit and refuses a limit it can't use", async () => {
    server.idleMs = 5 * MINUTE;
    const t = tab(server, tabs(), { idleSeconds: 5 * 60 });
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(t.events).toEqual(["warn:60000"]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.events.at(-1)).toBe("expire:here");
    for (const idleSeconds of [Number.NaN, 30.5, 60, -1]) {
      expect(() => tab(server, tabs(), { idleSeconds })).toThrow(RangeError);
    }
  });

  it("turns activity into a use at most once a minute, and at the minute's end", async () => {
    const t = tab(server, tabs());
    await vi.advanceTimersByTimeAsync(1000);
    t.timer.activity();
    t.timer.activity();
    expect(t.pings).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE - 1000);
    expect(t.pings).toBe(1);
    expect(t.timer.deadline).toBe(Date.now() + 30 * MINUTE);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(t.pings).toBe(1);
    t.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pings).toBe(2);
    expect(t.timer.deadline).toBe(Date.now() + 30 * MINUTE);
  });

  it("keeps a person who types now and then signed in for hours", async () => {
    const t = tab(server, tabs());
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
    const t = tab(server, tabs(), {
      ping: () =>
        new Promise<void>((resolve) => {
          t.pings += 1;
          const sentAt = Date.now();
          answer = () => {
            server.use();
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

  it("clears only its own screen when the server can't be reached at the end", async () => {
    const t = tab(server, tabs());
    server.reachable = false;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(t.events).toEqual(["warn:60000", "expire:unconfirmed"]);
    // The others aren't told: the session may be alive for them.
    expect(t.channel.posted).toEqual([]);
  });

  it("goes on with the server's time when its own has passed but the session is alive (a stale tab)", async () => {
    const stale = tab(server, tabs());
    // Another tab used the session, but its message never reached this one.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    server.use();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(stale.confirms).toBe(1);
    expect(stale.events).toEqual(["warn:60000", "warn-end"]);
    expect(stale.channel.posted).toEqual([]);
    expect(stale.timer.deadline).toBe(Date.now() + 20 * MINUTE);
    // And ends at the server's end.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(stale.events.at(-1)).toBe("expire:here");
  });

  it("asks the server on activity after its end (a laptop waking) and goes by its answer", async () => {
    const t = tab(server, tabs());
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    t.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual(["expire:here"]);
    expect(t.pings).toBe(0);
    // A use reported afterwards changes nothing.
    t.timer.used(Date.now());
    t.timer.activity();
    expect(t.events).toEqual(["expire:here"]);

    // Waking while another tab kept the session going: no sign-out.
    const s2 = new Server();
    const u = tab(s2, tabs());
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    s2.lastUse = Date.now() - 5 * MINUTE;
    u.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.events).toEqual([]);
    expect(u.timer.deadline).toBe(Date.now() + 25 * MINUTE);
  });

  it("stops when stopped", async () => {
    const t = tab(server, tabs());
    t.timer.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(t.events).toEqual([]);
  });
});

describe("across tabs", () => {
  it("restarts the limit in every tab of the session when one is used", async () => {
    const open = tabs();
    const a = tab(server, open);
    const b = tab(server, open);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    a.timer.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.pings).toBe(1);
    expect(b.timer.deadline).toBe(a.timer.deadline);
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(b.pings).toBe(0);
    expect(b.events).toEqual(["warn:60000"]);
    expect(a.events).toEqual(["warn:60000"]);
    b.timer.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.events).toEqual(["warn:60000", "warn-end"]);
    expect(b.events).toEqual(["warn:60000", "warn-end"]);
  });

  it("signs every tab of the session out when one signs out", async () => {
    const open = tabs();
    const a = tab(server, open);
    const b = tab(server, open, { idleSeconds: 31 * 60 }); // a little behind, as tabs are
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(a.events.at(-1)).toBe("expire:here");
    expect(b.events.at(-1)).toBe("expire:elsewhere-idle");
    expect(b.channel.posted).toEqual([]);
  });

  it("ignores another session's sign-out", async () => {
    const open = tabs();
    const a = tab(server, open);
    open().post({ type: "signed-out", session: M2, reason: "manual" });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(a.events).toEqual([]);
    expect(a.confirms).toBe(0);
  });

  it("asks the server on another session's use: reloads when replaced, signs out when ended", async () => {
    const open = tabs();
    const a = tab(server, open);
    // Signed in again (or switched organization) in another tab.
    server.marker = M2;
    open().post({ type: "use", session: M2, at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.events).toEqual(["replaced"]);

    const s2 = new Server();
    const b = tab(s2, open);
    s2.ended = true;
    open().post({ type: "use", session: M2, at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.events).toEqual(["expire:here"]);
  });

  it("takes a use reported for a time still to come as now", async () => {
    const open = tabs();
    const a = tab(server, open);
    open().post({ type: "use", session: M1, at: Date.now() + 365 * 24 * 60 * MINUTE });
    expect(a.timer.deadline).toBe(Date.now() + 30 * MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(a.events.at(-1)).toBe("expire:here");
  });
});

describe("the channel's messages", () => {
  it("are exactly one of the shapes, with a session marker", () => {
    expect(readIdleMessage({ type: "use", session: M1, at: 5 })).toEqual({
      type: "use",
      session: M1,
      at: 5,
    });
    expect(readIdleMessage({ type: "signed-out", session: M1, reason: "manual" })).toEqual({
      type: "signed-out",
      session: M1,
      reason: "manual",
    });
    for (const bad of [
      null,
      "use",
      [],
      { type: "use", at: 5 },
      { type: "use", session: "short", at: 5 },
      { type: "use", session: `${M1}A`, at: 5 },
      { type: "use", session: M1 },
      { type: "use", session: M1, at: "5" },
      { type: "use", session: M1, at: Number.NaN },
      { type: "use", session: M1, at: Infinity },
      { type: "use", session: M1, at: -1 },
      { type: "use", session: M1, at: 5, extra: 1 },
      { type: "signed-out", session: M1 },
      { type: "signed-out", session: M1, reason: "other" },
      { type: "signed-out", session: M1, reason: "idle", at: 5 },
      { type: "sign-in", session: M1 },
    ]) {
      expect(readIdleMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
