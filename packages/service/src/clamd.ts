/**
 * A small client for the ClamAV daemon (clamd), written here (S-040,
 * D-113): Oculus never links to ClamAV (GPL-2.0) and adds no dependency;
 * it talks to a separately installed clamd over its socket, as any client
 * may.
 *
 * The protocol is clamd's `INSTREAM` (clamd(8), "INSTREAM"): the command
 * `zINSTREAM\0` (the `z` form: every reply ends with a NUL), then the bytes
 * in chunks, each a 4-byte unsigned big-endian length and that many bytes,
 * then a zero length. clamd answers once with one line:
 *
 *     stream: OK\0
 *     stream: <signature name> FOUND\0
 *     INSTREAM size limit exceeded. ERROR\0     (past its StreamMaxLength)
 *     <anything else> ERROR\0
 *
 * and closes the connection. Anything else (no reply, a reply without its
 * NUL, more than `MAX_REPLY_BYTES`, words that aren't one of those) is a
 * `protocol` failure: never read as clean.
 *
 * - **Whole streams only:** a stream that reads as more or fewer bytes than
 *   its `size` is `unreadable` and its end is never sent; a clean reply
 *   that comes before the end was written is a `protocol` failure.
 * - **Where:** a Unix socket (`{ socket }`, clamd's `LocalSocket`; the one
 *   to prefer: the folder's permissions decide who may connect), or TCP
 *   to the loopback address only (`{ host, port }`, clamd's `TCPSocket` with
 *   `TCPAddr 127.0.0.1`): the bytes go unencrypted, so never to another
 *   machine (`clamdAddressProblem`).
 * - **How much:** clamd refuses a stream longer than its `StreamMaxLength`
 *   (100M by default in current releases, 25M in old ones), so `streamMaxBytes` must not be more than it:
 *   a file larger than it is `too_large` before anything is sent, and the
 *   count is checked again as the bytes go.
 * - **How long:** the whole scan, connecting included, has `timeoutMs`;
 *   past it the connection is destroyed and the scan is a `timeout`.
 * - **Backpressure:** each chunk waits for the socket to drain, so a slow
 *   clamd never makes Oculus hold a file in memory; at most one chunk
 *   (`chunkBytes`, 64 KiB by default) is in hand at a time.
 */
import { connect, isIP, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

/** Where clamd listens. */
export type ClamdAddress =
  { readonly socket: string } | { readonly host: string; readonly port: number };

export interface ClamdOptions {
  readonly address: ClamdAddress;
  /** The whole scan's time limit, connecting included (milliseconds). */
  readonly timeoutMs: number;
  /** clamd's `StreamMaxLength` (bytes), or less: never more. */
  readonly streamMaxBytes: number;
  /** Bytes per INSTREAM chunk (default 64 KiB). */
  readonly chunkBytes?: number;
}

/** Why a scan didn't give an answer. */
export type ClamdFailure =
  /** The time limit passed. */
  | "timeout"
  /** clamd couldn't be reached, or went away before answering. */
  | "unavailable"
  /** Larger than `streamMaxBytes`, or clamd's own size limit. */
  | "too_large"
  /** clamd answered with an ERROR. */
  | "refused"
  /** An answer that isn't clamd's, or a clean one before the stream ended. */
  | "protocol"
  /** The stream to scan didn't read as `size` bytes (a stored copy that broke or changed). */
  | "unreadable";

export type ClamdVerdict =
  | { readonly ok: true; readonly verdict: "clean" }
  | { readonly ok: true; readonly verdict: "infected"; readonly signature: string }
  | { readonly ok: false; readonly failure: ClamdFailure };

/** The default chunk: 64 KiB. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** The longest reply read; clamd's are far shorter. */
export const MAX_REPLY_BYTES = 4096;
/** clamd's default StreamMaxLength in current releases (clamd.conf(5)): 100 MiB. */
export const CLAMD_DEFAULT_STREAM_MAX_BYTES = 100 * 1024 * 1024;
/** INSTREAM's lengths are 32-bit; clamd itself caps StreamMaxLength at 4 GiB. */
const MAX_STREAM_BYTES = 0xffff_ffff;

/** A signature name as stored: printable ASCII without spaces, 1 to 200 characters. */
const SIGNATURE = /^[!-~]{1,200}$/;

/** What `clamdAddressProblem` refuses. */
export function clamdAddressProblem(address: ClamdAddress): string | undefined {
  if ("socket" in address) {
    return typeof address.socket === "string" && isAbsolute(address.socket)
      ? undefined
      : "the socket must be an absolute path";
  }
  if (!isLoopback(address.host)) return "the host must be a loopback address (127.0.0.1 or ::1)";
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
    return "the port must be a whole number from 1 to 65535";
  }
  return undefined;
}

/** 127.0.0.0/8 or ::1, written as an address (never a name to look up). */
export function isLoopback(host: string): boolean {
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  if (isIP(host) === 6) return host === "::1" || /^(0{0,4}:){7}0{0,3}1$/.test(host);
  return false;
}

/** Reads clamd's one reply (its NUL already removed). */
export function parseClamdReply(text: string): ClamdVerdict {
  const line = text.replace(/\n$/, "");
  if (line === "stream: OK") return { ok: true, verdict: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found !== null) {
    const name = found[1] ?? "";
    // The name is shown to staff as text: anything odd is kept as "unknown".
    return { ok: true, verdict: "infected", signature: SIGNATURE.test(name) ? name : "unknown" };
  }
  if (/^INSTREAM size limit exceeded\.? ERROR$/.test(line))
    return { ok: false, failure: "too_large" };
  if (line.endsWith(" ERROR")) return { ok: false, failure: "refused" };
  return { ok: false, failure: "protocol" };
}

function checkOptions(options: ClamdOptions): void {
  const problem = clamdAddressProblem(options.address);
  if (problem !== undefined) throw new TypeError(`clamd: ${problem}.`);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("clamd: timeoutMs is a whole number of milliseconds.");
  }
  if (
    !Number.isSafeInteger(options.streamMaxBytes) ||
    options.streamMaxBytes < 1 ||
    options.streamMaxBytes > MAX_STREAM_BYTES
  ) {
    throw new TypeError("clamd: streamMaxBytes is a whole number of bytes up to 4 GiB.");
  }
  const chunk = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > 16 * 1024 * 1024) {
    throw new TypeError("clamd: chunkBytes is a whole number of bytes up to 16 MiB.");
  }
}

function open(address: ClamdAddress): Socket {
  return "socket" in address
    ? connect({ path: address.socket })
    : connect({ host: address.host, port: address.port });
}

/**
 * One exchange with clamd: sends `command` (and, with `body`, streams it as
 * INSTREAM chunks), then reads one NUL-ended reply. Never throws.
 */
function exchange(
  options: ClamdOptions,
  command: string,
  body: { readonly source: Readable; readonly size: number } | undefined,
): Promise<
  | {
      readonly reply: string;
      /** Whether the stream's end (the zero length) had been written when the reply came. */
      readonly terminated: boolean;
    }
  | { readonly failure: ClamdFailure }
> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  return new Promise((resolve) => {
    let settled = false;
    const received: Buffer[] = [];
    let receivedBytes = 0;
    let terminated = false;
    const socket = open(options.address);
    const finish = (
      answer: { reply: string; terminated: boolean } | { failure: ClamdFailure },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      body?.source.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      finish({ failure: "timeout" });
    }, options.timeoutMs);
    timer.unref();
    /** What came back so far, as a reply if it ended with its NUL. */
    const replyIfComplete = (): string | undefined => {
      const all = Buffer.concat(received);
      const end = all.indexOf(0);
      return end === -1 ? undefined : all.subarray(0, end).toString("latin1");
    };
    socket.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_REPLY_BYTES) {
        finish({ failure: "protocol" });
        return;
      }
      received.push(chunk);
      const reply = replyIfComplete();
      if (reply !== undefined) finish({ reply, terminated });
    });
    // A connection that ends or breaks without a whole reply: clamd went
    // away (or never was there), or sent something that isn't one.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      finish(receivedBytes > 0 ? { failure: "protocol" } : { failure: "unavailable" });
    });

    /** Writes one buffer, waiting for the socket to drain; false when it closed. */
    const write = (buffer: Uint8Array): Promise<boolean> => {
      if (settled || socket.destroyed) return Promise.resolve(false);
      if (socket.write(buffer)) return Promise.resolve(true);
      return new Promise((done) => {
        const drained = (): void => {
          socket.off("close", closed);
          done(true);
        };
        const closed = (): void => {
          socket.off("drain", drained);
          done(false);
        };
        socket.once("drain", drained);
        socket.once("close", closed);
      });
    };

    socket.once("connect", () => {
      void (async () => {
        if (!(await write(Buffer.from(`${command}\0`, "latin1")))) return;
        if (body === undefined) return;
        let sent = 0;
        try {
          for await (const piece of body.source as AsyncIterable<Uint8Array>) {
            for (let at = 0; at < piece.byteLength; at += chunkBytes) {
              const part = piece.subarray(at, Math.min(at + chunkBytes, piece.byteLength));
              sent += part.byteLength;
              // Longer than its size says: not the bytes the row names.
              if (sent > body.size) {
                finish({ failure: "unreadable" });
                return;
              }
              if (sent > options.streamMaxBytes) {
                finish({ failure: "too_large" });
                return;
              }
              const length = Buffer.alloc(4);
              length.writeUInt32BE(part.byteLength);
              if (!(await write(length)) || !(await write(part))) return;
            }
            if (settled) return;
          }
        } catch {
          // The stored copy couldn't be read to the end: no verdict from a
          // part of it.
          finish({ failure: "unreadable" });
          return;
        }
        if (settled) return;
        // Shorter than its size says: clamd never sees the end of a part.
        if (sent !== body.size) {
          finish({ failure: "unreadable" });
          return;
        }
        // The end of the stream: a zero length. Only a reply after it can
        // be clean (scanWithClamd). Then the reply (above).
        terminated = true;
        await write(Buffer.alloc(4));
      })();
    });
  });
}

/**
 * Scans one stream of `size` bytes with clamd's INSTREAM. Never throws:
 * every problem is a failure, and only clamd's own `stream: OK` is clean.
 */
export async function scanWithClamd(
  options: ClamdOptions,
  source: Readable,
  size: number,
): Promise<ClamdVerdict> {
  checkOptions(options);
  if (!Number.isSafeInteger(size) || size < 0 || size > options.streamMaxBytes) {
    source.destroy();
    return { ok: false, failure: "too_large" };
  }
  const answer = await exchange(options, "zINSTREAM", { source, size });
  if (!("reply" in answer)) return { ok: false, failure: answer.failure };
  const verdict = parseClamdReply(answer.reply);
  // "OK" before clamd had the whole stream says nothing about the file.
  if (verdict.ok && verdict.verdict === "clean" && !answer.terminated) {
    return { ok: false, failure: "protocol" };
  }
  return verdict;
}

/** Whether clamd answers `PONG` to `zPING` within the time limit. */
export async function pingClamd(options: ClamdOptions): Promise<boolean> {
  checkOptions(options);
  const answer = await exchange(options, "zPING", undefined);
  return "reply" in answer && answer.reply === "PONG";
}
