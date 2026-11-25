/**
 * The outbox (T-040, D-085): messages are handed over here and sent later,
 * off the request path, by a small in-process worker.
 *
 * - **Two lanes** (`laneOf`): links (reset links, set-up codes, invitations)
 *   and notices (the two-step alert, the password-changed notice), each with
 *   its own capacity, per-recipient limit and retry policy, so notices can
 *   never keep a link from being queued (review M1).
 * - **`enqueue` only checks and queues**; it never waits for a mail server.
 *   So the time a caller spends handing over a message doesn't depend on the
 *   mail server, and (with D-078's reply sent before anything about the
 *   account is read) nothing a requester can time says whether an account
 *   exists. It throws a `MailRefusedError` at once when the outbox is
 *   closed, its lane is full (`maxQueued`, 500 each) or the recipient has
 *   had the lane's `perRecipientPerHour` (links 10, notices 20) in the last
 *   hour: the caller then
 *   treats the message as not sent (D-078 revokes the link).
 * - **In memory, never in the database**: a message holds a bearer token,
 *   which D-068 keeps out of every table and log. A restart drops what is
 *   queued; the person asks again (a reset link lasts 30 minutes anyway).
 * - **At most `concurrency` (2) sends at once**, each with a time limit
 *   (`sendTimeoutMs`, 30 s) and stopped by `close()`, which waits for them
 *   at most `closeTimeoutMs` (10 s).
 * - **Retries with backoff and a cap.** A failure the mail server may get
 *   over (the network, a time-out, a 4xx reply, or anything unrecognised)
 *   is tried again: links after 15 s doubling to 5 minutes, at most 5
 *   sends (about 4 minutes); notices after 30 s doubling to 1 hour, at most
 *   13 sends (about 3 to 6 hours, review M2); each wait between half and
 *   all of that, and nothing is sent, the first time included, within a
 *   minute of the message's `notAfter`. A permanent refusal (5xx but 503),
 *   failed authentication, a TLS failure (certificates and handshakes
 *   included) or bad configuration is not retried.
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

// Node's and OpenSSL's codes for certificate and handshake failures.
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH$|EPROTO$)/;

function isTlsCode(value: unknown): boolean {
  return typeof value === "string" && TLS_CODE.test(value);
}

/**
 * The class of a send failure, from the error's own `code` and
 * `responseCode` data properties only (nodemailer's codes, D-085). Never
 * reads the message or any getter.
 */
export function classifyMailError(error: unknown): MailErrorClass {
  const code = ownData(error, "code");
  const responseCode = ownData(error, "responseCode");
  // A certificate or handshake failure reaches us as nodemailer's ESOCKET
  // (or ECONNECTION) with Node's TLS code underneath, in `originalCode` or
  // the `cause`'s own `code` (review L2): a TLS failure, never retried.
  if (
    isTlsCode(code) ||
    isTlsCode(ownData(error, "originalCode")) ||
    isTlsCode(ownData(ownData(error, "cause"), "code"))
  ) {
    return "tls";
  }
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

/**
 * Which lane a message travels in (review M1, M2): **links** (reset links,
 * set-up codes, invitations: short-lived bearer tokens, quick retries) and
 * **notices** (the two-step alert and the password-changed notice: no
 * token, retried for hours). Each lane has its own queue capacity and its
 * own per-recipient hourly limit, so a flood of notices can never keep a
 * person's reset link, or an admin's own, from being queued.
 */
export type MailLane = "link" | "notice";

export function laneOf(kind: MailKind): MailLane {
  return kind === "two_step_alert" || kind === "password_changed" ? "notice" : "link";
}

/** One lane's settings. */
export interface LaneOptions {
  /** Sends in all, the first included (links 5, notices 13; 1 to 20). */
  readonly maxAttempts?: number;
  /** The first wait before a retry (links 15 s, notices 30 s). */
  readonly baseDelayMs?: number;
  /** The longest wait (links 5 minutes, notices 1 hour). */
  readonly maxDelayMs?: number;
  /** Messages queued, waiting or being sent in this lane (default 500 each). */
  readonly maxQueued?: number;
  /** Messages per recipient in any hour in this lane (links 10, notices 20). */
  readonly perRecipientPerHour?: number;
}

export interface OutboxOptions extends LaneOptions {
  readonly transport: MailTransport;
  /** Fixed-shape records: the kind and an error class, never an address or token. */
  readonly log: (record: ApiLogRecord) => void;
  /** The notice lane's settings; the top-level ones are the link lane's. */
  readonly notices?: LaneOptions;
  /** Time limit for one send (default 30 s). */
  readonly sendTimeoutMs?: number;
  /** Sends at once, both lanes together (default 2). */
  readonly concurrency?: number;
  /** Retries (and the first send) stop this long before `notAfter` (default 60 s). */
  readonly expiryMarginMs?: number;
  /** How long `close()` waits for sends in progress before giving up (default 10 s). */
  readonly closeTimeoutMs?: number;
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
  /** How many more messages `lane` takes now. */
  room(lane: MailLane): number;
  /** Resolves when nothing is queued, waiting or being sent (tests). */
  idle(): Promise<void>;
  /**
   * Stops: refuses new messages, drops waiting ones, aborts sends in
   * progress, and waits for them at most `closeTimeoutMs`.
   */
  close(): Promise<void>;
}

interface Entry {
  readonly mail: RenderedMail;
  readonly lane: MailLane;
  attempts: number;
}

interface Lane {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxQueued: number;
  readonly perRecipient: number;
  readonly recent: Map<string, number[]>;
  count: number;
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

function lane(o: LaneOptions, d: Required<LaneOptions>): Lane {
  return {
    maxAttempts: bounded(o.maxAttempts, d.maxAttempts, 1, 20),
    baseDelayMs: bounded(o.baseDelayMs, d.baseDelayMs, 0, 3_600_000),
    maxDelayMs: bounded(o.maxDelayMs, d.maxDelayMs, 0, 3_600_000),
    maxQueued: bounded(o.maxQueued, d.maxQueued, 1, 100_000),
    perRecipient: bounded(o.perRecipientPerHour, d.perRecipientPerHour, 1, 1_000),
    recent: new Map(),
    count: 0,
  };
}

/** Makes an outbox over `transport`. */
export function createOutbox(options: OutboxOptions): MailOutbox {
  const { transport, log } = options;
  const lanes: Record<MailLane, Lane> = {
    link: lane(options, {
      maxAttempts: 5,
      baseDelayMs: 15_000,
      maxDelayMs: 300_000,
      maxQueued: 500,
      perRecipientPerHour: 10,
    }),
    // About 6 hours of retries at most (30 s doubling to 1 hour, 13 sends),
    // still bounded by the notice's own life (review M2).
    notice: lane(options.notices ?? {}, {
      maxAttempts: 13,
      baseDelayMs: 30_000,
      maxDelayMs: 3_600_000,
      maxQueued: 500,
      perRecipientPerHour: 20,
    }),
  };
  const sendTimeoutMs = bounded(options.sendTimeoutMs, 30_000, 1, 300_000);
  const concurrency = bounded(options.concurrency, 2, 1, 16);
  const margin = bounded(options.expiryMarginMs, 60_000, 0, 3_600_000);
  const closeTimeoutMs = bounded(options.closeTimeoutMs, 10_000, 0, 300_000);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  const ready: Entry[] = [];
  const timers = new Map<ReturnType<typeof setTimeout>, Entry>();
  const sending = new Set<Promise<void>>();
  const waiters: (() => void)[] = [];
  const shutdown = new AbortController();
  let closed = false;

  const record = (event: ApiLogRecord["event"], kind: MailKind, code?: string): void => {
    try {
      log(code === undefined ? { event, operation: kind } : { event, operation: kind, code });
    } catch {
      // Logging can't stop the outbox.
    }
  };

  const size = (): number => lanes.link.count + lanes.notice.count;

  const settle = (): void => {
    if (size() !== 0) return;
    for (const wake of waiters.splice(0)) wake();
  };

  const done = (entry: Entry): void => {
    lanes[entry.lane].count -= 1;
  };

  /** True if `to` may have another message in `l` now; counts it if so. */
  const allow = (l: Lane, to: string): boolean => {
    const t = now();
    if (l.recent.size >= SWEEP_AT) {
      for (const [key, times] of l.recent) {
        if (times.every((x) => t - x >= HOUR_MS)) l.recent.delete(key);
      }
    }
    const times = (l.recent.get(to) ?? []).filter((x) => t - x < HOUR_MS);
    if (times.length >= l.perRecipient) {
      l.recent.set(to, times);
      return false;
    }
    times.push(t);
    l.recent.set(to, times);
    return true;
  };

  const delayFor = (l: Lane, attempts: number): number => {
    const full = Math.min(l.maxDelayMs, l.baseDelayMs * 2 ** (attempts - 1));
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
    const l = lanes[entry.lane];
    // Never send what is already useless, the first time included (review L4).
    if (now() >= entry.mail.notAfter - margin) {
      record("mail_failed", entry.mail.kind, "expired");
      done(entry);
      return;
    }
    entry.attempts += 1;
    const limit = AbortSignal.timeout(sendTimeoutMs);
    const signal = AbortSignal.any([shutdown.signal, limit]);
    let failure: MailErrorClass;
    try {
      await transport.send(entry.mail, signal);
      record("mail_sent", entry.mail.kind);
      done(entry);
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
      done(entry);
      return;
    }
    const delay = delayFor(l, entry.attempts);
    const again =
      RETRYABLE.has(failure) &&
      entry.attempts < l.maxAttempts &&
      now() + delay < entry.mail.notAfter - margin;
    if (!again) {
      record("mail_failed", entry.mail.kind, failure);
      done(entry);
      return;
    }
    record("mail_retry", entry.mail.kind, failure);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed) return;
      ready.push(entry);
      pump();
    }, delay);
    timer.unref();
    timers.set(timer, entry);
  };

  return {
    enqueue(mail: RenderedMail): void {
      if (closed) throw new MailRefusedError("closed");
      const name = laneOf(mail.kind);
      const l = lanes[name];
      if (l.count >= l.maxQueued) {
        record("mail_refused", mail.kind, "queue_full");
        throw new MailRefusedError("queue_full");
      }
      if (!allow(l, mail.to)) {
        record("mail_refused", mail.kind, "recipient_limit");
        throw new MailRefusedError("recipient_limit");
      }
      l.count += 1;
      ready.push({ mail, lane: name, attempts: 0 });
      // Started on a later turn of the event loop, so the caller never runs
      // any part of the send.
      setImmediate(pump);
    },
    get size(): number {
      return size();
    },
    room(name: MailLane): number {
      if (closed) return 0;
      const l = lanes[name];
      return Math.max(0, l.maxQueued - l.count);
    },
    idle(): Promise<void> {
      if (size() === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const [timer, entry] of timers) {
        clearTimeout(timer);
        record("mail_dropped", entry.mail.kind, "closed");
        done(entry);
      }
      timers.clear();
      for (const entry of ready.splice(0)) {
        record("mail_dropped", entry.mail.kind, "closed");
        done(entry);
      }
      settle();
      shutdown.abort(new Error("The outbox was closed."));
      // Wait for the sends in progress, but not for ever (review L3).
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...sending]),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, closeTimeoutMs);
          deadline.unref();
        }),
      ]);
      clearTimeout(deadline);
      settle();
    },
  };
}
