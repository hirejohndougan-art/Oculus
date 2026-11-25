/**
 * A fake ClamAV daemon for tests (S-040): speaks clamd's `zPING` and
 * `zINSTREAM` on a Unix socket or on 127.0.0.1, checks the chunk framing
 * as clamd does, and answers as told. No real virus sample is used
 * anywhere: in `detect` mode a stream holding `FAKE_VIRUS_MARKER` (an
 * invented string) is "found".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClamdAddress } from "./clamd.js";

/** Bytes the fake reports as a virus in `detect` mode: invented, harmless. */
export const FAKE_VIRUS_MARKER = "INVENTED-OCULUS-TEST-VIRUS-MARKER";
/** The signature name the fake reports, in the style of ClamAV's test signature. */
export const FAKE_SIGNATURE = "Oculus.Test.Invented-1";

export type FakeClamdMode =
  /** "stream: OK" for everything. */
  | "ok"
  /** "stream: <name> FOUND" for everything. */
  | "found"
  /** FOUND when the bytes hold `FAKE_VIRUS_MARKER`, else OK. */
  | "detect"
  /** clamd's size-limit error as soon as the stream passes `limit`, then closes. */
  | "size_limit"
  /** Reads everything and never answers (a stuck clamd). */
  | "silent"
  /** Answers bytes that aren't clamd's, without a NUL, then closes. */
  | "garbage"
  /** Answers a NUL-ended line that isn't one of clamd's. */
  | "nonsense"
  /** An ERROR reply. */
  | "error"
  /** Closes the connection after the first chunk (clamd going down mid-stream). */
  | "drop"
  /** Sends far more than a reply ever is. */
  | "flood"
  /** Answers "stream: OK" after the first chunk, before the stream ends. */
  | "early_ok";

export interface FakeClamd {
  readonly address: ClamdAddress;
  mode: FakeClamdMode;
  /** The size limit of `size_limit` mode (bytes). */
  limit: number;
  /** Connections made. */
  readonly connections: () => number;
  /** Each finished stream's bytes, in order. */
  readonly streams: Buffer[];
  /** The largest chunk length seen. */
  readonly largestChunk: () => number;
  /** A framing problem seen (a chunk longer than the bytes that followed, say). */
  readonly problems: string[];
  close(): Promise<void>;
}

export async function startFakeClamd(
  options: { readonly mode?: FakeClamdMode; readonly tcp?: boolean; readonly limit?: number } = {},
): Promise<FakeClamd> {
  let connections = 0;
  let largest = 0;
  const streams: Buffer[] = [];
  const problems: string[] = [];
  const sockets = new Set<Socket>();
  const dir = options.tcp === true ? undefined : mkdtempSync(join(tmpdir(), "oculus-clamd-"));
  const fake: {
    mode: FakeClamdMode;
    limit: number;
  } = { mode: options.mode ?? "ok", limit: options.limit ?? 1024 * 1024 };

  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let command: string | undefined;
    const body: Buffer[] = [];
    let bodyBytes = 0;
    let chunks = 0;
    let done = false;
    const answer = (text: string): void => {
      done = true;
      socket.end(Buffer.from(text, "latin1"));
    };
    const finish = (): void => {
      const all = Buffer.concat(body);
      streams.push(all);
      switch (fake.mode) {
        case "ok":
          answer("stream: OK\0");
          break;
        case "found":
          answer(`stream: ${FAKE_SIGNATURE} FOUND\0`);
          break;
        case "detect":
          answer(
            all.includes(FAKE_VIRUS_MARKER) ? `stream: ${FAKE_SIGNATURE} FOUND\0` : "stream: OK\0",
          );
          break;
        case "size_limit":
        case "early_ok":
          answer("stream: OK\0");
          break;
        case "silent":
          done = true;
          break;
        case "garbage":
          answer("\x01\x02 not a clamd reply");
          break;
        case "nonsense":
          answer("stream: MAYBE\0");
          break;
        case "error":
          answer("Can't allocate memory ERROR\0");
          break;
        case "drop":
          done = true;
          socket.destroy();
          break;
        case "flood":
          done = true;
          socket.end(Buffer.alloc(64 * 1024, 0x41));
          break;
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (command === undefined) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 1);
        if (command === "zPING") {
          answer("PONG\0");
          return;
        }
        if (command !== "zINSTREAM") {
          answer("UNKNOWN COMMAND\0");
          return;
        }
      }
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          finish();
          return;
        }
        if (buffer.length < 4 + length) return;
        largest = Math.max(largest, length);
        body.push(buffer.subarray(4, 4 + length));
        bodyBytes += length;
        buffer = buffer.subarray(4 + length);
        chunks++;
        if (fake.mode === "early_ok" && chunks === 1) {
          answer("stream: OK\0");
          return;
        }
        if (fake.mode === "drop" && chunks === 1) {
          done = true;
          socket.destroy();
          return;
        }
        if (fake.mode === "size_limit" && bodyBytes > fake.limit) {
          answer("INSTREAM size limit exceeded. ERROR\0");
          return;
        }
      }
    });
    socket.on("end", () => {
      if (!done && command === "zINSTREAM") problems.push("ended before the zero length");
    });
  });

  const address: ClamdAddress = await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (dir === undefined) {
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const bound = server.address();
        if (bound === null || typeof bound === "string") {
          reject(new Error("no address"));
          return;
        }
        resolve({ host: "127.0.0.1", port: bound.port });
      });
    } else {
      const path = join(dir, "clamd.sock");
      server.listen({ path }, () => {
        resolve({ socket: path });
      });
    }
  });

  return {
    address,
    get mode() {
      return fake.mode;
    },
    set mode(mode: FakeClamdMode) {
      fake.mode = mode;
    },
    get limit() {
      return fake.limit;
    },
    set limit(limit: number) {
      fake.limit = limit;
    },
    connections: () => connections,
    streams,
    largestChunk: () => largest,
    problems,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}
