// A fake SMTP server in this process (T-040 tests): enough of RFC 5321 for
// nodemailer to send to it (EHLO, AUTH PLAIN, MAIL, RCPT, DATA, RSET, NOOP,
// QUIT) on 127.0.0.1, with switches to refuse or stall, and a small MIME
// reader for the messages it received. It never offers STARTTLS unless told
// to advertise it (and then refuses the upgrade), so a sender that requires
// TLS must give up before MAIL FROM. Test data only.
import { createServer, type Server, type Socket } from "node:net";

export interface Received {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent, dot-unstuffed, with CRLF line ends. */
  readonly data: string;
}

export interface FakeSmtpOptions {
  /** Require AUTH PLAIN with these. */
  readonly auth?: { readonly user: string; readonly pass: string };
  /** Advertise STARTTLS (the upgrade itself is refused with 454). */
  readonly advertiseStartTls?: boolean;
}

export interface FakeSmtp {
  readonly port: number;
  readonly messages: Received[];
  /** Every line the clients sent, in order. */
  readonly commands: string[];
  readonly connections: () => number;
  /** The next `count` transactions get `reply` after DATA's end (e.g. "451 4.3.0 try later"). */
  refuseNext(count: number, reply: string): void;
  /** The next `count` connections get no greeting at all. */
  stallNext(count: number): void;
  /** Waits this long before every greeting from now on. */
  delayGreeting(ms: number): void;
  /** Forgets the messages, commands, refusals, stalls and greeting delay. */
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: Received[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  let refusals: string[] = [];
  let stalls = 0;
  let greetingDelay = 0;
  let connections = 0;

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("latin1");
    if (stalls > 0) {
      stalls -= 1;
      return;
    }
    let buffer = "";
    let inData = false;
    let data: string[] = [];
    let from = "";
    let to: string[] = [];
    let authed = options.auth === undefined;
    let awaitingAuth = false;
    const say = (line: string): void => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const handle = (line: string): void => {
      if (inData) {
        if (line === ".") {
          inData = false;
          const refusal = refusals.shift();
          if (refusal !== undefined) {
            say(refusal);
          } else {
            messages.push({ from, to, data: `${data.join("\r\n")}\r\n` });
            say("250 2.0.0 queued");
          }
          data = [];
          to = [];
          return;
        }
        data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      commands.push(line);
      if (awaitingAuth) {
        awaitingAuth = false;
        checkPlain(line);
        return;
      }
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";
      if (verb === "EHLO" || verb === "HELO") {
        const lines = ["250-fake.invalid", "250-8BITMIME", "250-SMTPUTF8"];
        if (options.advertiseStartTls === true) lines.push("250-STARTTLS");
        if (options.auth !== undefined) lines.push("250-AUTH PLAIN");
        lines.push("250 PIPELINING");
        for (const l of lines) say(l);
      } else if (verb === "STARTTLS") {
        say("454 4.7.0 TLS not available");
      } else if (verb === "AUTH") {
        const parts = line.split(" ");
        if (parts[1]?.toUpperCase() !== "PLAIN") {
          say("504 5.5.4 unrecognised");
        } else if (parts[2] === undefined) {
          awaitingAuth = true;
          say("334 ");
        } else {
          checkPlain(parts[2]);
        }
      } else if (verb === "MAIL") {
        if (!authed) {
          say("530 5.7.0 authentication required");
          return;
        }
        from = /<([^>]*)>/.exec(line)?.[1] ?? "";
        say("250 2.1.0 ok");
      } else if (verb === "RCPT") {
        to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
        say("250 2.1.5 ok");
      } else if (verb === "DATA") {
        inData = true;
        say("354 go ahead");
      } else if (verb === "RSET") {
        to = [];
        say("250 ok");
      } else if (verb === "NOOP") {
        say("250 ok");
      } else if (verb === "QUIT") {
        say("221 bye");
        socket.end();
      } else {
        say("502 5.5.2 not implemented");
      }
    };
    const checkPlain = (b64: string): void => {
      const [, user, pass] = Buffer.from(b64, "base64").toString("utf8").split("\u0000");
      if (user === options.auth?.user && pass === options.auth?.pass) {
        authed = true;
        say("235 2.7.0 ok");
      } else {
        say("535 5.7.8 bad credentials");
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        handle(line);
      }
    });
    const greet = (): void => {
      say("220 fake.invalid ESMTP");
    };
    if (greetingDelay > 0) setTimeout(greet, greetingDelay);
    else greet();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    messages,
    commands,
    connections: () => connections,
    refuseNext(count, reply) {
      refusals = [...refusals, ...Array.from({ length: count }, () => reply)];
    },
    stallNext(count) {
      stalls += count;
    },
    delayGreeting(ms) {
      greetingDelay = ms;
    },
    reset() {
      messages.length = 0;
      commands.length = 0;
      refusals = [];
      stalls = 0;
      greetingDelay = 0;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** A received message, decoded: its headers (names lower case, unfolded) and its text and HTML parts. */
export interface ParsedMail {
  readonly headers: ReadonlyMap<string, string>;
  /** The raw header block, for checks that nothing leaked into it. */
  readonly headerText: string;
  readonly text: string;
  readonly html: string;
}

function splitHeaders(block: string): { headers: Map<string, string>; body: string; head: string } {
  const at = block.indexOf("\r\n\r\n");
  const head = at < 0 ? block : block.slice(0, at);
  const body = at < 0 ? "" : block.slice(at + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body, head };
}

function decode(body: string, encoding: string | undefined): string {
  const e = (encoding ?? "7bit").toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (e === "quoted-printable") {
    const bytes = body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return Buffer.from(body, "latin1").toString("utf8");
}

/** Reads a multipart/alternative message with a text and an HTML part (or a single text part). */
export function parseMail(raw: string): ParsedMail {
  const top = splitHeaders(raw);
  const type = top.headers.get("content-type") ?? "";
  let text = "";
  let html = "";
  const boundary = /boundary="?([^";]+)"?/.exec(type)?.[1];
  if (boundary === undefined) {
    text = decode(top.body, top.headers.get("content-transfer-encoding"));
  } else {
    for (const chunk of top.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      const part = splitHeaders(chunk.replace(/^\r\n/, ""));
      const partType = part.headers.get("content-type") ?? "";
      const content = decode(
        part.body.replace(/\r\n$/, ""),
        part.headers.get("content-transfer-encoding"),
      );
      if (partType.startsWith("text/plain")) text = content;
      if (partType.startsWith("text/html")) html = content;
    }
  }
  return { headers: top.headers, headerText: top.head, text, html };
}
