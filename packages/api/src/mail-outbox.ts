/**
 * The outbox (T-040, D-085): messages are handed over here and sent later,
 * off the request path, by a small in-process worker.
 *
 * - **`enqueue` only checks and queues**; it never waits for a mail server.
 *   So the time a caller spends handing over a message doesn't depend on the
 *   mail server, and (with D-078's reply sent before anything about the
 *   account is read) nothing a requester can time says whether an account
 *   exists. It throws a `MailRefusedError` at once when the outbox is
 *   closed, full (`maxQueued`, 500) or the recipient has had
 *   `perRecipientPerHour` (10) messages in the last hour: the caller then
 *   treats the message as not sent (D-078 revokes the link).
 * - **In memory, never in the database**: a message holds a bearer token,
 *   which D-068 keeps out of every table and log. A restart drops what is
 *   queued; the person asks again (a reset link lasts 30 minutes anyway).
 * - **At most `concurrency` (2) sends at once**, each with a time limit
 *   (`sendTimeoutMs`, 30 s) and stopped by `close()`.
 * - **Retries with backoff and a cap.** A failure the mail server may get
 *   over (the network, a time-out, a 4xx reply, or anything unrecognised)
 *   is tried again after `baseDelayMs` (15 s), doubling to at most
 *   `maxDelayMs` (5 minutes), each wait between half and all of that, at
 *   most `maxAttempts` (5) sends in all, and never once the message's link
 *   has expired (`notAfter`). A permanent refusal (5xx but 503), failed
 *   authentication, a TLS failure or bad configuration is not retried.
 * - **Logs say what happened, never to whom or with what**: fixed records
 *   (`mail_sent`, `mail_retry`, `mail_failed`, `mail_refused`,
 *   `mail_dropped`) with the message kind and an error class from
 *   `classifyMailError`, which reads only the error's own `code` and
 *   `responseCode` data properties: never its message, `response`,
 *   `recipient` or `rejected` (a mail server's reply often quotes the
 *   address).
 */
import type { ApiLogRecord } from "./staff-api.js";
import type { MailKind, RenderedMail } from "./mail-messages.js";

/** Sends one message. Rejects on failure; `classifyMailError` reads what it rejects with. */
export interface MailTransport {
  send(mail: RenderedMail, signal: AbortSignal): Promise<void>;
}

/** The kind of failure, for the log and the retry decision. */
export type MailErrorClass =
  | "network"
  | "timeout"
  | "tls"
  | "auth"
  | "rejected_temporary"
  | "rejected_permanent"
  | "config"
  | "aborted"
  | "unknown";

const RETRYABLE: ReadonlySet<MailErrorClass> = new Set([
  "network",
  "timeout",
  "rejected_temporary",
  "unknown",
]);

/** Why `enqueue` refused a message. */
export class MailRefusedError extends Error {
  override readonly name = "MailRefusedError";
  constructor(readonly code: "closed" | "queue_full" | "recipient_limit" | "aborted") {
    super(`The message was not queued: ${code}.`);
  }
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The class of a send failure, from the error's own `code` and
 * `responseCode` data properties only (nodemailer's codes, D-085). Never
 * reads the message or any getter.
 */
export function classifyMailError(error: unknown): MailErrorClass {
  const code = ownData(error, "code");
  const responseCode = ownData(error, "responseCode");
  if (code === "EAUTH" || code === "ENOAUTH" || code === "EOAUTH2") return "auth";
  if (code === "ETLS" || code === "EREQUIRETLS") return "tls";
  if (code === "ECONFIG" || code === "EFILEACCESS" || code === "EURLACCESS") return "config";
  if (code === "EABORT") return "aborted";
  if (typeof responseCode === "number" && Number.isInteger(responseCode)) {
    if (responseCode >= 500 && responseCode <= 599 && responseCode !== 503) {
      return "rejected_permanent";
    }
    return "rejected_temporary";
  }
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "EDNS" || code === "EPROXY") {
    return "network";
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") return "rejected_permanent";
  return "unknown";
}

export interface OutboxOptions {
  readonly transport: MailTransport;
  /** Fixed-shape records: the kind and an error class, never an address or token. */
  readonly log: (record: ApiLogRecord) => void;
  /** Sends in all, the first included (default 5, 1 to 10). */
  readonly maxAttempts?: number;
  /** The first wait before a retry (default 15 s). */
  readonly baseDelayMs?: number;
  /** The longest wait (default 5 minutes). */
  readonly maxDelayMs?: number;
  /** Time limit for one send (default 30 s). */
  readonly sendTimeoutMs?: number;
  /** Sends at once (default 2). */
  readonly concurrency?: number;
  /** Messages queued, waiting or being sent at once (default 500). */
  readonly maxQueued?: number;
  /** Messages per recipient in any hour (default 10). */
  readonly perRecipientPerHour?: number;
  /** Retries stop this long before the link expires (default 60 s). */
  readonly expiryMarginMs?: number;
  /** The clock (tests). */
  readonly now?: () => number;
  /** A number in [0, 1) for the jitter (tests). */
  readonly random?: () => number;
}

export interface MailOutbox {
  /** Checks and queues; throws `MailRefusedError` if it won't. Never waits for a send. */
  enqueue(mail: RenderedMail): void;
  /** Messages queued, waiting for a retry or being sent. */
  readonly size: number;
  /** Resolves when nothing is queued, waiting or being sent (tests). */
  idle(): Promise<void>;
  /** Stops: refuses new messages, drops waiting ones, aborts sends in progress. */
  close(): Promise<void>;
}

interface Entry {
  readonly mail: RenderedMail;
  attempts: number;
}

const HOUR_MS = 3_600_000;
/** Recipients remembered for the hourly limit before old ones are swept. */
const SWEEP_AT = 10_000;

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new TypeError(`An outbox setting is outside ${String(min)} to ${String(max)}.`);
  }
  return v;
}

/** Makes an outbox over `transport`. */
export function createOutbox(options: OutboxOptions): MailOutbox {
  const { transport, log } = options;
  const maxAttempts = bounded(options.maxAttempts, 5, 1, 10);
  const baseDelayMs = bounded(options.baseDelayMs, 15_000, 0, 3_600_000);
  const maxDelayMs = bounded(options.maxDelayMs, 300_000, 0, 3_600_000);
  const sendTimeoutMs = bounded(options.sendTimeoutMs, 30_000, 1, 300_000);
  const concurrency = bounded(options.concurrency, 2, 1, 16);
  const maxQueued = bounded(options.maxQueued, 500, 1, 100_000);
  const perRecipient = bounded(options.perRecipientPerHour, 10, 1, 1_000);
  const margin = bounded(options.expiryMarginMs, 60_000, 0, 3_600_000);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  const ready: Entry[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sending = new Set<Promise<void>>();
  const recent = new Map<string, number[]>();
  const waiters: (() => void)[] = [];
  const shutdown = new AbortController();
  let waiting = 0;
  let closed = false;

  const record = (event: ApiLogRecord["event"], kind: MailKind, code?: string): void => {
    try {
      log(code === undefined ? { event, operation: kind } : { event, operation: kind, code });
    } catch {
      // Logging can't stop the outbox.
    }
  };

  const size = (): number => ready.length + waiting + sending.size;

  const settle = (): void => {
    if (size() !== 0) return;
    for (const wake of waiters.splice(0)) wake();
  };

  /** True if `to` may have another message now; counts it if so. */
  const allow = (to: string): boolean => {
    const t = now();
    if (recent.size >= SWEEP_AT) {
      for (const [key, times] of recent) {
        if (times.every((x) => t - x >= HOUR_MS)) recent.delete(key);
      }
    }
    const times = (recent.get(to) ?? []).filter((x) => t - x < HOUR_MS);
    if (times.length >= perRecipient) {
      recent.set(to, times);
      return false;
    }
    times.push(t);
    recent.set(to, times);
    return true;
  };

  const delayFor = (attempts: number): number => {
    const full = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
    return Math.round(full / 2 + (full / 2) * random());
  };

  const pump = (): void => {
    while (!closed && sending.size < concurrency && ready.length > 0) {
      const entry = ready.shift();
      if (entry === undefined) break;
      const run = attempt(entry).finally(() => {
        sending.delete(run);
        pump();
        settle();
      });
      sending.add(run);
    }
    settle();
  };

  const attempt = async (entry: Entry): Promise<void> => {
    entry.attempts += 1;
    const limit = AbortSignal.timeout(sendTimeoutMs);
    const signal = AbortSignal.any([shutdown.signal, limit]);
    let failure: MailErrorClass;
    try {
      await transport.send(entry.mail, signal);
      record("mail_sent", entry.mail.kind);
      return;
    } catch (error) {
      failure = shutdown.signal.aborted
        ? "aborted"
        : limit.aborted
          ? "timeout"
          : classifyMailError(error);
    }
    if (closed) {
      record("mail_dropped", entry.mail.kind, failure);
      return;
    }
    const delay = delayFor(entry.attempts);
    const again =
      RETRYABLE.has(failure) &&
      entry.attempts < maxAttempts &&
      now() + delay < entry.mail.notAfter - margin;
    if (!again) {
      record("mail_failed", entry.mail.kind, failure);
      return;
    }
    record("mail_retry", entry.mail.kind, failure);
    waiting += 1;
    const timer = setTimeout(() => {
      timers.delete(timer);
      waiting -= 1;
      if (closed) return;
      ready.push(entry);
      pump();
    }, delay);
    timer.unref();
    timers.add(timer);
  };

  return {
    enqueue(mail: RenderedMail): void {
      if (closed) throw new MailRefusedError("closed");
      if (size() >= maxQueued) {
        record("mail_refused", mail.kind, "queue_full");
        throw new MailRefusedError("queue_full");
      }
      if (!allow(mail.to)) {
        record("mail_refused", mail.kind, "recipient_limit");
        throw new MailRefusedError("recipient_limit");
      }
      ready.push({ mail, attempts: 0 });
      // Started on a later turn of the event loop, so the caller never runs
      // any part of the send.
      setImmediate(pump);
    },
    get size(): number {
      return size();
    },
    idle(): Promise<void> {
      if (size() === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const dropped = ready.length + waiting;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of ready.splice(0)) record("mail_dropped", entry.mail.kind, "closed");
      waiting = 0;
      if (dropped > 0) settle();
      shutdown.abort(new Error("The outbox was closed."));
      await Promise.allSettled([...sending]);
      settle();
    },
  };
}
