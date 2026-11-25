/**
 * Serving stored files safely (M-001, D-089). The only way a handler sends a
 * file's bytes is to return `fileReply(...)`; the server (server.ts) then
 * sends exactly the headers made here, and `FILE_SECURITY_HEADERS` in place
 * of the API's, whatever the handler set with `type()` or `header()`.
 *
 * - **The stored media type is never sent as it is.** A file is shown in
 *   the browser (`inline`) only if its type is one of `INLINE_FILE_TYPES`:
 *   raster images, audio and video a browser plays without running
 *   anything. It is then sent as that bare type, without parameters. Every
 *   other file, HTML, SVG, XML, scripts, PDF, text and unknown types
 *   included, is sent as `application/octet-stream` with
 *   `Content-Disposition: attachment`, so a browser only ever downloads it.
 * - **Every file reply** carries `X-Content-Type-Options: nosniff`, a
 *   Content-Security-Policy that loads nothing and adds `sandbox` (a
 *   document opened from it has an opaque origin, no script, no forms, no
 *   plugins), `Cross-Origin-Resource-Policy: same-origin` (another site
 *   can't embed it), no framing, no Referer and `Cache-Control: private,
 *   no-store`.
 * - **The file name** is never a path: it goes only into
 *   `Content-Disposition` (RFC 6266), as an ASCII fallback and as RFC 8187
 *   `filename*`, with control, format and bidirectional characters, path
 *   separators and quotes taken out.
 * - **The length** is fixed: `size` must match the bytes given, and a
 *   stream that runs long or short is cut off with an error, so a reply can
 *   never send more than its Content-Length says.
 * - **Streams** are opened only when the reply goes out (`sendFileStream`),
 *   so a reply that is never sent (the handler threw later, the request
 *   ended) opens nothing; then sent outside the handler timeout, through
 *   `pipeline`, within a deadline, so a storage error, a wrong length, a
 *   client that goes away or the server closing closes the source. A file
 *   that can't be read before its first byte is the ordinary 500. HEAD
 *   opens nothing.
 *
 * Where files are served from (an origin of their own, apart from the public
 * sites) is T-050's; ranges and caching are M-003's or later.
 */
import type { ServerResponse } from "node:http";
import { Readable, Transform, pipeline, type TransformCallback } from "node:stream";

/**
 * The only types a file may be shown as in the browser (essences, lower
 * case): formats a browser decodes as media, which can't carry script.
 */
export const INLINE_FILE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "video/ogg",
]);

/** What every file reply is sent as when it may not be shown. */
export const DOWNLOAD_TYPE = "application/octet-stream";

/** The policy on every file reply: load nothing, and sandbox the document. */
export const FILE_CSP =
  "default-src 'none'; sandbox; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

/** Set on every file reply in place of the API's `SECURITY_HEADERS`. */
export const FILE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": FILE_CSP,
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, no-store",
});

/** The longest file name kept in `Content-Disposition`, in characters. */
export const MAX_FILE_NAME_LENGTH = 150;

/** The biggest size a file reply may declare (1 TiB; M-002's caps are far lower). */
export const MAX_FILE_REPLY_SIZE = 2 ** 40;

export interface FileReplyInput {
  /**
   * The bytes, or a function that opens a stream of them (M-003 opens the
   * file from storage). It is called only when the reply goes out, so
   * nothing is opened for a reply that is never sent.
   */
  readonly body: Uint8Array | (() => Readable);
  /** The exact number of bytes. */
  readonly size: number;
  /** The stored (sniffed) media type: only decides inline or download. */
  readonly mediaType: string;
  /** The original file name, as stored metadata. */
  readonly fileName: string;
  /** Asked for; `inline` is given only to `INLINE_FILE_TYPES`. Default `attachment`. */
  readonly disposition?: "inline" | "attachment";
}

/** A file reply: made only by `fileReply`, sent only by the server. */
export interface FileReply {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | (() => Readable);
}

const made = new WeakSet<object>();

/** Whether `value` is a reply `fileReply` made (a copy or a look-alike isn't). */
export function isFileReply(value: unknown): value is FileReply {
  return typeof value === "object" && value !== null && made.has(value);
}

/** The bare essence of a media type, lower case, or `undefined` if malformed. */
function essenceOf(mediaType: unknown): string | undefined {
  if (typeof mediaType !== "string" || mediaType.length > 255) return undefined;
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence)
    ? essence
    : undefined;
}

/** Whether a file of this stored type may be shown in the browser. */
export function mayShowInline(mediaType: unknown): boolean {
  const essence = essenceOf(mediaType);
  return essence !== undefined && INLINE_FILE_TYPES.has(essence);
}

/**
 * A file name fit for `Content-Disposition`: no control, format (bidi,
 * zero-width) or private-use characters, no path separators or quotes, no
 * leading dots or spaces; at most `MAX_FILE_NAME_LENGTH` characters; `file`
 * if nothing is left.
 */
export function safeFileName(name: unknown): string {
  const text = typeof name === "string" ? name.normalize("NFC") : "";
  let cleaned = text
    .replace(/[\p{Cf}]/gu, "") // format characters (bidi, zero-width, U+FEFF) go first
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[/\\"*:<>?|]/g, "_")
    .replace(/^[\s.]+/u, "")
    .replace(/[\s.]+$/u, "");
  // Windows device names (CON, nul.txt, COM1, CONIN$ …) can't be saved as they are.
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  const chars = Array.from(cleaned);
  if (chars.length > MAX_FILE_NAME_LENGTH) {
    // Keep a short extension (`.tiff`, `.html`) and cut the stem instead.
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 ? Array.from(cleaned.slice(dot)) : [];
    const keep = extension.length > 1 && extension.length <= 16 ? extension : [];
    cleaned =
      chars
        .slice(0, MAX_FILE_NAME_LENGTH - keep.length)
        .join("")
        .replace(/[\s.]+$/u, "") + keep.join("");
  }
  return cleaned === "" ? "file" : cleaned;
}

/** RFC 8187 `value-chars`: attr-char as it is, everything else percent-encoded. */
function extValue(text: string): string {
  return encodeURIComponent(text).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `attachment` or `inline`, with the name as an ASCII fallback and as `filename*` (RFC 6266 §4.3). */
export function contentDisposition(disposition: "inline" | "attachment", name: unknown): string {
  const safe = safeFileName(name);
  const ascii = safe.replace(/[^A-Za-z0-9 ._()+,=@[\]{}~!#$&^-]/gu, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${extValue(safe)}`;
}

/** Cuts a stream off with an error if it gives more or fewer than `size` bytes. */
export class ExactLength extends Transform {
  private seen = 0;
  constructor(private readonly size: number) {
    super();
  }
  override _transform(chunk: unknown, _encoding: BufferEncoding, done: TransformCallback): void {
    const bytes = chunk instanceof Uint8Array ? chunk : undefined;
    if (bytes === undefined) {
      done(new Error("a file stream must give bytes"));
      return;
    }
    this.seen += bytes.byteLength;
    if (this.seen > this.size) {
      done(new Error("the file stream is longer than its size"));
      return;
    }
    done(null, bytes);
  }
  override _flush(done: TransformCallback): void {
    done(this.seen === this.size ? null : new Error("the file stream is shorter than its size"));
  }
}

/**
 * Checks a file to send and returns the reply for a handler to return.
 * Throws (a 500) when the input is malformed: a handler bug, never a
 * client's doing.
 */
export function fileReply(input: FileReplyInput): FileReply {
  const { body, size, mediaType, fileName } = input;
  const asked: unknown = input.disposition ?? "attachment";
  if (asked !== "inline" && asked !== "attachment") {
    throw new Error("a file's disposition is inline or attachment");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_REPLY_SIZE) {
    throw new Error("a file's size must be a whole number of bytes");
  }
  let sent: Uint8Array | (() => Readable);
  if (body instanceof Uint8Array) {
    if (body.byteLength !== size) throw new Error("the file's bytes don't match its size");
    sent = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } else if (typeof body === "function") {
    sent = body;
  } else {
    throw new Error("a file's body must be bytes or a function that opens a stream");
  }
  const inline = asked === "inline" && mayShowInline(mediaType);
  const headers = Object.freeze({
    "content-type": inline ? (essenceOf(mediaType) ?? DOWNLOAD_TYPE) : DOWNLOAD_TYPE,
    "content-disposition": contentDisposition(inline ? "inline" : "attachment", fileName),
    "content-length": String(size),
  });
  const reply: FileReply = Object.freeze({ headers, body: sent });
  made.add(reply);
  return reply;
}

/** Why a streamed file reply stopped: `client` (the client went away) isn't a fault. */
export type FileStreamEnd = "done" | "client" | "storage" | "length" | "deadline" | "closing";

/** The longest a streamed download may run (2 hours); `SERVER_TIMEOUTS.download`. */
export const MAX_DOWNLOAD_MS = 7_200_000;

const ERROR_BODY = '{"error":"internal_error"}';

/**
 * Sends a streamed file reply on the raw response (server.ts, after
 * `reply.hijack()`), outside the handler timeout:
 *
 * - HEAD: the headers only; nothing is opened.
 * - GET: opens the stream, and waits for its first bytes (or its end) before
 *   writing the headers, so a file that can't be read is the ordinary
 *   `500 {"error":"internal_error"}` with `errorHeaders`, not a dropped
 *   connection. Then `pipeline(source, ExactLength, response)`: a storage
 *   error, a stream of the wrong length or the client going away destroys
 *   the source and the response together (never more than Content-Length).
 * - The whole download must end within `deadlineMs`, and `stop()` (the
 *   server closing) ends it at once.
 *
 * `ended` is called once with why it stopped.
 */
export function sendFileStream(
  response: ServerResponse,
  method: string,
  headers: Readonly<Record<string, string>>,
  errorHeaders: Readonly<Record<string, string>>,
  file: FileReply,
  deadlineMs: number,
  ended: (why: FileStreamEnd) => void,
): { stop: () => void } {
  const open = file.body;
  if (typeof open !== "function") throw new Error("sendFileStream sends streams only");
  if (method === "HEAD") {
    response.writeHead(200, headers);
    response.end();
    ended("done");
    return { stop: () => undefined };
  }
  let source: Readable | undefined;
  let finished = false;
  const finish = (why: FileStreamEnd): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    source?.destroy();
    if (why !== "done") response.destroy();
    ended(why);
  };
  const failBeforeStart = (): void => {
    if (finished) return;
    if (response.headersSent || response.destroyed) {
      finish("storage");
      return;
    }
    response.writeHead(500, {
      ...errorHeaders,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(ERROR_BODY)),
    });
    response.end(ERROR_BODY);
    finished = true;
    clearTimeout(timer);
    source?.destroy();
    ended("storage");
  };
  const timer = setTimeout(() => {
    finish("deadline");
  }, deadlineMs);
  response.once("close", () => {
    if (!response.writableFinished) finish("client");
  });
  try {
    source = open();
    if (!(source instanceof Readable)) throw new Error("the opener must return a readable stream");
  } catch {
    failBeforeStart();
    return { stop: () => undefined };
  }
  const opened = source;
  const onEarlyError = (): void => {
    failBeforeStart();
  };
  opened.once("error", onEarlyError);
  opened.once("readable", () => {
    if (finished) return;
    opened.removeListener("error", onEarlyError);
    response.writeHead(200, headers);
    const size = Number(file.headers["content-length"]);
    const exact = new ExactLength(size);
    let lengthWrong = false;
    exact.once("error", () => {
      lengthWrong = true;
    });
    pipeline(opened, exact, response, (error) => {
      if (!error) {
        finish("done");
        return;
      }
      finish(lengthWrong ? "length" : response.destroyed && !opened.errored ? "client" : "storage");
    });
  });
  return {
    stop: () => {
      finish("closing");
    },
  };
}
