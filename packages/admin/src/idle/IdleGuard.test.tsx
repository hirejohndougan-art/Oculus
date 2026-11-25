// @vitest-environment jsdom
// Signing out after a period of no use, on screen (T-062, D-098), with fake
// timers against a small model of the server's session: the frame's own
// read of the person is background and the idle timer's check is a use; a
// minute before the limit an alertdialog warns, takes focus and offers
// "Stay signed in"; staying asks the server and gives focus back (or to the
// main region when the element is gone); at the end the server is asked,
// and only when it says the session has ended is the screen cleared first
// and the sign-out sent afterwards, without waiting (a sign-out that never
// settles leaves nothing on screen); the server unreachable clears this
// screen only; unsaved editor changes are named and don't hold the way to
// sign in; sign-outs of this session in other tabs (for no use, by hand,
// ended) clear this one; another session's news is checked with the
// server; and the localStorage fallback carries the same messages.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentCsrfToken } from "../api";
import { SITE_1, fakeServer, me, renderAt, type Reply, type Sent } from "../testing.fixtures";
import {
  A1,
  RECORD_ID,
  TEMPLATES_REPLY,
  TYPES_REPLY,
  VERSIONS_REPLY,
  recordReply,
} from "../records/records.fixtures";
import { forgetLists } from "../records/listMemory";
import { IDLE_STORAGE_KEY, openStorageIdleChannel, type IdleMessage } from "./channel";
import { hasUnsavedChanges, isSessionEnding } from "./unsaved";

const MINUTE = 60_000;
const MARKER = "AAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBB";

/** The server's session: every request not marked background is a use. */
const model = { lastUse: 0, ended: false, marker: MARKER };
function alive(): boolean {
  return !model.ended && Date.now() < model.lastUse + 30 * MINUTE;
}
function sessionReply(): Reply {
  if (!alive()) return [401, { error: "unauthenticated" }];
  return [
    200,
    {
      idleSeconds: 1800,
      idleSecondsLeft: Math.floor((model.lastUse + 30 * MINUTE - Date.now()) / 1000),
      sessionMarker: model.marker,
      csrfToken: "f".repeat(43),
    },
  ];
}

/** Every idle channel the page opens, as a BroadcastChannel stand-in we can post into. */
class FakeBroadcastChannel {
  static all: FakeBroadcastChannel[] = [];
  static posted: unknown[] = [];
  static envelopes: unknown[] = [];
  readonly name: string;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.all.push(this);
  }
  postMessage(data: unknown) {
    // The envelope: this tab's name and the message.
    FakeBroadcastChannel.posted.push((data as { message: unknown }).message);
    FakeBroadcastChannel.envelopes.push(data);
  }
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  close() {
    this.listeners.clear();
  }
  /** Another tab says something (in its envelope). */
  deliver(message: unknown, tab = "another-tab") {
    const data = { tab, message };
    for (const l of this.listeners) l(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-11-24T12:00:00Z") });
  FakeBroadcastChannel.all = [];
  FakeBroadcastChannel.posted = [];
  FakeBroadcastChannel.envelopes = [];
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  forgetLists();
  window.localStorage.clear();
});

function server(
  routes: Record<string, Reply | ((s: Sent) => Reply)> = {},
  person: Record<string, unknown> = { idleSeconds: 1800, sessionMarker: MARKER },
) {
  model.lastUse = Date.now();
  model.ended = false;
  model.marker = MARKER;
  const sent = fakeServer({
    "GET /api/me": [200, { ...me([A1]), ...person }],
    "GET /api/session": () => sessionReply(),
    "GET /api/working-site": [200, { createKinds: ["object"], review: false }],
    "GET /api/record-types": [200, TYPES_REPLY],
    "GET /api/templates": [200, TEMPLATES_REPLY],
    "GET /api/records?limit=25": [200, { records: [], next: null }],
    "POST /api/sign-out": [200, { signedOut: true }],
    ...routes,
  });
  // The server counts every request not marked background while alive.
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers["x-oculus-background"] === undefined && input !== "/api/sign-out" && alive()) {
      model.lastUse = Date.now();
    }
    return answer(input, init);
  });
  return sent;
}

async function frame() {
  await screen.findByRole("heading", { level: 1, name: "Invented archive site" });
}

/** Moves time on until the warning shows (other replies move the last use by a few milliseconds). */
async function untilWarning(): Promise<HTMLElement> {
  await act(() => vi.advanceTimersByTimeAsync(29 * MINUTE - 5_000));
  for (let i = 0; i < 100 && screen.queryByRole("alertdialog") === null; i++) {
    await act(() => vi.advanceTimersByTimeAsync(100));
  }
  return screen.findByRole("alertdialog");
}

const sessionChecks = (sent: Sent[]) =>
  sent.filter((s) => s.method === "GET" && s.path === "/api/session");

describe("the idle warning", () => {
  it("counts the visit, not the frame's own read, as a use", async () => {
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const meRead = sent.find((s) => s.path === "/api/me");
    expect(meRead?.headers["x-oculus-background"]).toBe("1");
    await waitFor(() => {
      expect(sessionChecks(sent)).toHaveLength(1);
    });
    expect(sessionChecks(sent)[0]?.headers["x-oculus-background"]).toBeUndefined();
  });

  it("appears a minute before the end, takes focus, and Stay signed in keeps the session", async () => {
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const search = screen.getByLabelText(/Search/);
    search.focus();
    const dialog = await untilWarning();
    expect(dialog).toBe(screen.getByRole("alertdialog", { name: "Are you still there?" }));
    expect(dialog.textContent).toContain("You'll be signed out in 60 seconds");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).queryByText(/aren't saved/)).toBeNull();
    const stay = within(dialog).getByRole("button", { name: "Stay signed in" });
    expect(document.activeElement).toBe(stay);
    // The countdown, and the announcement at 30 seconds.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(dialog.textContent).toContain("You'll be signed out in 30 seconds");
    expect(dialog.querySelector("[aria-live=assertive]")?.textContent).toBe(
      "You'll be signed out in 30 seconds.",
    );
    const before = sessionChecks(sent).length;
    fireEvent.click(stay);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(sessionChecks(sent).length).toBeGreaterThan(before);
    expect(document.activeElement).toBe(search);
    // A new 30 minutes: no sign-out at the old end.
    await act(() => vi.advanceTimersByTimeAsync(2 * MINUTE));
    expect(sent.some((s) => s.path === "/api/sign-out")).toBe(false);
  });

  it("sends focus to the main region when the element that had it is gone", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const gone = document.createElement("button");
    gone.textContent = "Invented control";
    document.body.append(gone);
    gone.focus();
    const dialog = await untilWarning();
    gone.remove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay signed in" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("announces each threshold once", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const dialog = await untilWarning();
    const live = () => dialog.querySelector("[aria-live=assertive]")?.textContent ?? "";
    expect(live()).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(live()).toMatch(/^You'll be signed out in \d+ seconds\.$/);
    const first = live();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(live()).toBe(first);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    // The 10-second announcement (or the end itself on a very slow machine).
    if (dialog.isConnected) expect(live()).toMatch(/^You.ll be signed out in (10|\d) seconds?\.$/);
  });

  it("is dismissed by a key press or a click anywhere, but not by its own focus", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const dialog = await untilWarning();
    // It focused its button and is still there.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await untilWarning();
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    // Coming back to the window counts too.
    await untilWarning();
    fireEvent.focus(window);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("signs out on the server at the end, forgets the session and says why", async () => {
    const sent = server();
    const { router } = renderAt(`/sites/${SITE_1}`);
    await frame();
    expect(currentCsrfToken()).toBe("f".repeat(43));
    await act(() => vi.advanceTimersByTimeAsync(30 * MINUTE));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const out = sent.find((s) => s.method === "POST" && s.path === "/api/sign-out");
    expect(out?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(
      screen.getByText("You were signed out because Oculus wasn't used for 30 minutes."),
    ).toBeTruthy();
    expect(currentCsrfToken()).toBeUndefined();
    expect(screen.queryByText("Ada Invented")).toBeNull();
    // The server was asked first, as background.
    const confirm = sessionChecks(sent).at(-1);
    expect(confirm?.headers["x-oculus-background"]).toBe("1");
    // The other tabs are told.
    expect(FakeBroadcastChannel.posted).toContainEqual({
      type: "signed-out",
      session: MARKER,
      reason: "idle",
    });
    expect(isSessionEnding()).toBe(false);
  });

  it("clears the screen even when the sign-out never settles", async () => {
    const sent = server();
    const answer = globalThis.fetch;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
      if (input !== "/api/sign-out") return answer(input, init);
      signal = init.signal ?? undefined;
      sent.push({
        method: init.method ?? "GET",
        path: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: undefined,
      });
      return new Promise<Response>(() => undefined); // never settles
    });
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(30 * MINUTE));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(currentCsrfToken()).toBeUndefined();
    expect(screen.queryByText("Ada Invented")).toBeNull();
    // The sign-out still went, with the token kept for it and a time limit.
    await waitFor(() => {
      expect(sent.some((s) => s.path === "/api/sign-out")).toBe(true);
    });
    const out = sent.find((s) => s.path === "/api/sign-out");
    expect(out?.headers["x-oculus-csrf"]).toBe("f".repeat(43));
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("still clears the screen when the server answers the sign-out with a failure", async () => {
    server({ "POST /api/sign-out": [503, { error: "unavailable" }] });
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(30 * MINUTE));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(currentCsrfToken()).toBeUndefined();
  });

  it("clears only this screen when the server can't be reached at the end", async () => {
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(29 * MINUTE));
    // The server goes away.
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) =>
      input === "/api/session" ? Promise.reject(new TypeError("offline")) : answer(input, init),
    );
    await act(() => vi.advanceTimersByTimeAsync(2 * MINUTE));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.getByText(/this screen was cleared/)).toBeTruthy();
    expect(currentCsrfToken()).toBeUndefined();
    // Neither the other tabs nor the server were told: the session may be alive there.
    expect(
      FakeBroadcastChannel.posted.filter((m) => JSON.stringify(m).includes("signed-out")),
    ).toEqual([]);
    expect(sent.some((s) => s.path === "/api/sign-out")).toBe(false);
  });

  it("goes on when its time is up but the server says the session is alive", async () => {
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(20 * MINUTE));
    // Another tab used it; its message never came.
    model.lastUse = Date.now();
    await act(() => vi.advanceTimersByTimeAsync(11 * MINUTE));
    expect(screen.getByRole("heading", { level: 1, name: "Invented archive site" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent.some((s) => s.path === "/api/sign-out")).toBe(false);
    expect(
      FakeBroadcastChannel.posted.filter((m) => JSON.stringify(m).includes("signed-out")),
    ).toEqual([]);
  });

  it("starts no timer without the session's own limit, and leaves it to the server", async () => {
    const sent = server({}, { sessionMarker: MARKER });
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(60 * MINUTE));
    expect(sessionChecks(sent)).toEqual([]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("names unsaved changes, and they don't hold the way to sign in", async () => {
    const API = `/api/records/${RECORD_ID}`;
    const sent = server({
      [`GET ${API}`]: [200, recordReply()],
      [`GET ${API}/versions?limit=100`]: [200, VERSIONS_REPLY],
      "POST /api/records/check": [200, { issues: [] }],
    });
    renderAt(`/sites/${SITE_1}/records/${RECORD_ID}`);
    await screen.findByRole("heading", { level: 1, name: "An invented lantern" });
    const note = screen.getByLabelText(/^Note \(required\)/);
    fireEvent.change(note, { target: { value: "Tin, dented." } });
    await waitFor(() => {
      expect(hasUnsavedChanges()).toBe(true);
    });
    const dialog = await untilWarning();
    expect(within(dialog).getByText(/changes that aren't saved/).textContent).toMatch(
      /will be lost/,
    );
    await act(() => vi.advanceTimersByTimeAsync(MINUTE));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    expect(
      screen.getByText(
        "You were signed out because Oculus wasn't used for 30 minutes. Changes that weren't saved were lost.",
      ),
    ).toBeTruthy();
    expect(sent.some((s) => s.path === "/api/sign-out")).toBe(true);
    // Nothing of the edit was put in storage.
    for (const storage of [window.localStorage, window.sessionStorage]) {
      const values = Object.keys(storage).map((key) => `${key}=${storage.getItem(key) ?? ""}`);
      expect(values.join("\n")).not.toContain("dented");
    }
  });
});

describe("across tabs", () => {
  it("a use in another tab restarts the count here", async () => {
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await act(() => vi.advanceTimersByTimeAsync(20 * MINUTE));
    const channel = FakeBroadcastChannel.all.find((c) => c.name === "oculus-idle");
    act(() => {
      model.lastUse = Date.now();
      channel?.deliver({ type: "use", session: MARKER, at: Date.now() });
    });
    await act(() => vi.advanceTimersByTimeAsync(20 * MINUTE));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent.some((s) => s.path === "/api/sign-out")).toBe(false);
    // Nothing from this tab: only the visit's check.
    expect(sessionChecks(sent)).toHaveLength(1);
  });

  it("a sign-out of this session in another tab clears this one without asking the server", async () => {
    for (const [reason, notice] of [
      ["idle", /You were signed out because Oculus wasn't used for 30 minutes/],
      ["manual", /You signed out in another tab/],
      ["ended", /Your sign-in has ended/],
    ] as const) {
      const sent = server();
      const { unmount } = renderAt(`/sites/${SITE_1}`);
      await frame();
      const channel = FakeBroadcastChannel.all.find((c) => c.name === "oculus-idle");
      act(() => {
        channel?.deliver({ type: "signed-out", session: MARKER, reason });
      });
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(screen.getByText(notice)).toBeTruthy();
      expect(sent.some((s) => s.path === "/api/sign-out")).toBe(false);
      expect(currentCsrfToken()).toBeUndefined();
      unmount();
      FakeBroadcastChannel.all = [];
    }
  });

  it("ignores another session's sign-out and messages of any other shape", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    const channel = FakeBroadcastChannel.all.find((c) => c.name === "oculus-idle");
    act(() => {
      channel?.deliver({ type: "signed-out", session: OTHER, reason: "manual" });
      channel?.deliver({ type: "signed-out", session: MARKER, reason: "manual", by: "x" });
      channel?.deliver({ type: "signed-out" });
      channel?.deliver("signed-out");
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("heading", { level: 1, name: "Invented archive site" })).toBeTruthy();
  });

  it("on another session's use, asks the server, and reloads when that session is now this browser's", async () => {
    const sent = server();
    const { router } = renderAt(`/sites/${SITE_1}`);
    await frame();
    const before = sessionChecks(sent).length;
    model.marker = OTHER;
    const channel = FakeBroadcastChannel.all.find((c) => c.name === "oculus-idle");
    act(() => {
      channel?.deliver({ type: "use", session: OTHER, at: Date.now() });
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    const check = sessionChecks(sent)[before];
    expect(check?.headers["x-oculus-background"]).toBe("1");
  });

  it("drops what this tab sent itself (a BroadcastChannel delivers to the same tab too)", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await waitFor(() => {
      expect(FakeBroadcastChannel.envelopes.length).toBeGreaterThan(0);
    });
    const own = (FakeBroadcastChannel.envelopes[0] as { tab: string }).tab;
    const channel = FakeBroadcastChannel.all.find((c) => c.name === "oculus-idle");
    act(() => {
      channel?.deliver({ type: "signed-out", session: MARKER, reason: "manual" }, own);
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("heading", { level: 1, name: "Invented archive site" })).toBeTruthy();
  });

  it("signing out by hand tells the other tabs", async () => {
    server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    fireEvent.click(screen.getByRole("button", { name: /^Account:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.getByText("You are signed out.")).toBeTruthy();
    expect(FakeBroadcastChannel.posted).toContainEqual({
      type: "signed-out",
      session: MARKER,
      reason: "manual",
    });
  });

  it("a 401 anywhere tells the other tabs the session has ended", async () => {
    server({ "GET /api/record-types": [401, { error: "unauthenticated" }] });
    renderAt(`/sites/${SITE_1}`);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(FakeBroadcastChannel.posted).toContainEqual({
      type: "signed-out",
      session: MARKER,
      reason: "ended",
    });
  });

  it("falls back to localStorage events without a BroadcastChannel", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const sent = server();
    renderAt(`/sites/${SITE_1}`);
    await frame();
    await waitFor(() => {
      expect(sessionChecks(sent)).toHaveLength(1);
    });
    // This tab's use was written for the others.
    const stored = JSON.parse(window.localStorage.getItem(IDLE_STORAGE_KEY) ?? "{}") as {
      message?: IdleMessage;
    };
    expect(stored.message?.type).toBe("use");
    // Another tab signs out: a storage event.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: IDLE_STORAGE_KEY,
          newValue: JSON.stringify({
            tab: "another-tab",
            message: { type: "signed-out", session: MARKER, reason: "manual" },
            n: 1,
            r: 0.5,
          }),
        }),
      );
    });
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
  });

  it("the fallback channel drops anything not of the shapes", () => {
    const channel = openStorageIdleChannel();
    const got: IdleMessage[] = [];
    const stop = channel.listen((m) => got.push(m));
    for (const newValue of ["not json", "null", '{"message":{"type":"use","at":"x"}}']) {
      window.dispatchEvent(new StorageEvent("storage", { key: IDLE_STORAGE_KEY, newValue }));
    }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "something-else",
        newValue: '{"message":{"type":"signed-out"}}',
      }),
    );
    expect(got).toEqual([]);
    stop();
  });
});
