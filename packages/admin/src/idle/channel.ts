/**
 * The admin's tabs tell each other about the session (T-062, D-098): when
 * one tab used the session (so the idle limit restarts in every tab) and
 * when one signed out for no use (so every tab clears its screen). Over a
 * `BroadcastChannel`, or, where there is none, over `storage` events on one
 * localStorage key. Only a time and a kind are sent: nothing of the
 * session, the person or the screen. A message that isn't exactly one of
 * the two shapes is dropped.
 */

export type IdleMessage =
  { readonly type: "use"; readonly at: number } | { readonly type: "signed-out" };

export interface IdleChannel {
  post(message: IdleMessage): void;
  /** Listens; returns the way to stop. */
  listen(listener: (message: IdleMessage) => void): () => void;
  close(): void;
}

const NAME = "oculus-idle";
/** The localStorage key of the fallback. Holds the last message only. */
export const IDLE_STORAGE_KEY = "oculus.idle";

/** The message, if `data` is exactly one of the two shapes. */
export function readIdleMessage(data: unknown): IdleMessage | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record.type === "signed-out" && keys === "type") return { type: "signed-out" };
  if (
    record.type === "use" &&
    keys === "at,type" &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    record.at > 0
  ) {
    return { type: "use", at: record.at };
  }
  return undefined;
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
        channel.postMessage(message);
      } catch {
        // A closed channel: nothing to tell.
      }
    },
    listen(listener) {
      const handler = (event: MessageEvent) => {
        const message = readIdleMessage(event.data);
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
        storage.setItem(IDLE_STORAGE_KEY, JSON.stringify({ message, n: count, r: Math.random() }));
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
        if (typeof parsed !== "object" || parsed === null) return;
        const message = readIdleMessage((parsed as Record<string, unknown>).message);
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

/** The localStorage fallback on its own (tests). */
export function openStorageIdleChannel(): IdleChannel {
  return storageChannel() ?? silent;
}
