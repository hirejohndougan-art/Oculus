/**
 * The admin's tabs tell each other about the session (T-062, D-098): when
 * one tab used the session (so the idle limit restarts in every tab) and
 * when one signed out (so every tab clears its screen). Over a
 * `BroadcastChannel`, or, where there is none, over `storage` events on one
 * localStorage key. Every message names its session by the server's
 * `sessionMarker` (a short hash of the session's ID, not a secret), so a
 * tab can tell news of its own session from another's. Nothing else of the
 * session, the person or the screen is sent. A message that isn't exactly
 * one of the shapes is dropped.
 */

/** Why a tab signed out: no use, the person chose to, or the server had ended it. */
export type SignedOutReason = "idle" | "manual" | "ended";

export type IdleMessage =
  | { readonly type: "use"; readonly session: string; readonly at: number }
  | { readonly type: "signed-out"; readonly session: string; readonly reason: SignedOutReason };

const MARKER = /^[A-Za-z0-9_-]{16}$/;
const REASONS: readonly string[] = ["idle", "manual", "ended"];

/** Whether `value` has the form of a server's session marker. */
export function isSessionMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER.test(value);
}

export interface IdleChannel {
  post(message: IdleMessage): void;
  /** Listens; returns the way to stop. */
  listen(listener: (message: IdleMessage) => void): () => void;
  close(): void;
}

const NAME = "oculus-idle";
/** The localStorage key of the fallback. Holds the last message only. */
export const IDLE_STORAGE_KEY = "oculus.idle";

/** The message, if `data` is exactly one of the shapes. */
export function readIdleMessage(data: unknown): IdleMessage | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (!isSessionMarker(record.session)) return undefined;
  const keys = Object.keys(record).sort().join(",");
  if (
    record.type === "signed-out" &&
    keys === "reason,session,type" &&
    typeof record.reason === "string" &&
    REASONS.includes(record.reason)
  ) {
    return {
      type: "signed-out",
      session: record.session,
      reason: record.reason as SignedOutReason,
    };
  }
  if (
    record.type === "use" &&
    keys === "at,session,type" &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    record.at > 0
  ) {
    return { type: "use", session: record.session, at: record.at };
  }
  return undefined;
}

/**
 * This tab's own name for the envelope around each message: a
 * BroadcastChannel also delivers to the other channels of the same tab (a
 * sign-out announced from the account menu would reach this tab's own idle
 * timer and change its notice), so a tab drops what it sent itself.
 */
const TAB = (() => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
})();

/** The message inside an envelope from another tab, or nothing. */
function fromEnvelope(data: unknown): IdleMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const envelope = data as Record<string, unknown>;
  if (typeof envelope.tab !== "string" || envelope.tab === TAB) return undefined;
  return readIdleMessage(envelope.message);
}

function broadcastChannel(): IdleChannel | undefined {
  if (typeof BroadcastChannel !== "function") return undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(NAME);
  } catch {
    return undefined;
  }
  return {
    post(message) {
      try {
        channel.postMessage({ tab: TAB, message });
      } catch {
        // A closed channel: nothing to tell.
      }
    },
    listen(listener) {
      const handler = (event: MessageEvent) => {
        const message = fromEnvelope(event.data);
        if (message !== undefined) listener(message);
      };
      channel.addEventListener("message", handler);
      return () => {
        channel.removeEventListener("message", handler);
      };
    },
    close() {
      channel.close();
    },
  };
}

function storageChannel(): IdleChannel | undefined {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return undefined;
  }
  let count = 0;
  return {
    post(message) {
      count += 1;
      try {
        // A counter makes each write a change, so a repeated message is
        // still an event in the other tabs.
        storage.setItem(
          IDLE_STORAGE_KEY,
          JSON.stringify({ tab: TAB, message, n: count, r: Math.random() }),
        );
      } catch {
        // Storage full or refused: the other tabs find out from the server.
      }
    },
    listen(listener) {
      const handler = (event: StorageEvent) => {
        if (event.key !== IDLE_STORAGE_KEY || event.newValue === null) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.newValue);
        } catch {
          return;
        }
        const message = fromEnvelope(parsed);
        if (message !== undefined) listener(message);
      };
      window.addEventListener("storage", handler);
      return () => {
        window.removeEventListener("storage", handler);
      };
    },
    close() {
      // Nothing to close.
    },
  };
}

const silent: IdleChannel = {
  post() {
    // No other tab can be told.
  },
  listen() {
    return () => undefined;
  },
  close() {
    // Nothing to close.
  },
};

/** A BroadcastChannel if the browser has one, else localStorage events, else nothing. */
export function openIdleChannel(): IdleChannel {
  return broadcastChannel() ?? storageChannel() ?? silent;
}

/**
 * Tells the other tabs that this session has ended (signing out by hand, or
 * the server answering 401): they clear their screens too. Opens a channel
 * for the one message.
 */
export function announceSignedOut(session: unknown, reason: SignedOutReason): void {
  if (!isSessionMarker(session)) return;
  const channel = openIdleChannel();
  channel.post({ type: "signed-out", session, reason });
  channel.close();
}

/** The localStorage fallback on its own (tests). */
export function openStorageIdleChannel(): IdleChannel {
  return storageChannel() ?? silent;
}
