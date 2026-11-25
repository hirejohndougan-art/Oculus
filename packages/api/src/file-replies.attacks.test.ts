// Serving stored files (M-001, D-089): an active stored type (HTML, SVG,
// XHTML, any XML, scripts, PDF, unknown) is never sent as it is and is only
// ever a download; only plain images, audio and video may be shown; every
// file reply has nosniff, a sandboxing CSP and same-origin CORP, and nothing
// a handler set; names can't break the header or make a path; and a reply
// never sends more or fewer bytes than its Content-Length. Real HTTP via
// inject over the configured server.
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DOWNLOAD_TYPE,
  FILE_CSP,
  FILE_SECURITY_HEADERS,
  INLINE_FILE_TYPES,
  MAX_FILE_NAME_LENGTH,
  contentDisposition,
  fileReply,
  isFileReply,
  mayShowInline,
  safeFileName,
  type FileReplyInput,
} from "./file-replies.js";
import { SECURITY_HEADERS } from "./headers.js";
import type { OculusRoute } from "./routes.js";
import { SAME_ORIGIN, testServer } from "./test-server.fixtures.js";

const HTML = Buffer.from("<!doctype html><script>parent.pwned = 1</script>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const ACTIVE = [
  "text/html",
  "TEXT/HTML; charset=utf-8",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "application/rss+xml",
  "text/xsl",
  "text/javascript",
  "application/javascript",
  "application/pdf",
  "text/plain",
  "text/css",
  "multipart/x-mixed-replace; boundary=x",
  "message/rfc822",
  "application/x-shockwave-flash",
  "application/octet-stream",
  "",
  "nonsense",
  "image/png\r\nx-evil: 1",
];

let app: FastifyInstance | undefined;
async function stop(): Promise<void> {
  await app?.close();
  app = undefined;
}
afterEach(stop);

async function serve(make: () => FileReplyInput, before?: OculusRoute["handler"]) {
  const route: OculusRoute = {
    method: "GET",
    path: "/stored-file",
    handler: async (request, reply) => {
      await before?.(request, reply);
      return fileReply(make());
    },
  };
  ({ app } = await testServer({}, [route]));
  return app.inject({ method: "GET", url: "/stored-file", headers: SAME_ORIGIN });
}

describe("file replies over HTTP", () => {
  it("never sends an active stored type as it is: a download, as octet-stream", async () => {
    for (const mediaType of ACTIVE) {
      for (const disposition of ["inline", "attachment", undefined] as const) {
        const r = await serve(() => ({
          body: HTML,
          size: HTML.byteLength,
          mediaType,
          fileName: "page.html",
          ...(disposition === undefined ? {} : { disposition }),
        }));
        expect(r.statusCode).toBe(200);
        expect(r.headers["content-type"]).toBe(DOWNLOAD_TYPE);
        expect(String(r.headers["content-disposition"])).toMatch(/^attachment; /);
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
        expect(r.headers["content-security-policy"]).toBe(FILE_CSP);
        expect(r.body).toBe(HTML.toString());
        await stop();
      }
    }
  });

  it("shows only plain media inline, as its bare type", async () => {
    const r = await serve(() => ({
      body: PNG,
      size: PNG.byteLength,
      mediaType: "IMAGE/PNG; name=x",
      fileName: "photo.png",
      disposition: "inline",
    }));
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-disposition"]).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
    );
    expect(r.rawPayload.equals(PNG)).toBe(true);
  });

  it("sends the file headers in place of the API's, and nothing the handler set", async () => {
    const r = await serve(
      () => ({ body: SVG, size: SVG.byteLength, mediaType: "image/svg+xml", fileName: "a.svg" }),
      (_request, reply) => {
        reply.type("image/png").header("etag", '"x"').status(201);
        reply.setCookie("__Host-oculus_session", "x".repeat(43));
      },
    );
    expect(r.statusCode).toBe(200);
    for (const [name, value] of Object.entries(FILE_SECURITY_HEADERS)) {
      expect(r.headers[name]).toBe(value);
    }
    expect(r.headers["content-type"]).toBe(DOWNLOAD_TYPE);
    expect(r.headers.etag).toBeUndefined();
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["content-length"]).toBe(String(SVG.byteLength));
  });

  it("keeps the API's own headers on every other reply, errors from file routes included", async () => {
    const r = await serve(() => {
      throw new Error("storage is down");
    });
    expect(r.statusCode).toBe(500);
    expect(r.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
    expect(r.headers["content-disposition"]).toBeUndefined();
    const health = await app?.inject({ method: "GET", url: "/health", headers: SAME_ORIGIN });
    expect(health?.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
  });

  it("answers HEAD with the same headers and no body", async () => {
    await serve(() => ({
      body: PNG,
      size: PNG.byteLength,
      mediaType: "image/png",
      fileName: "p.png",
    }));
    const r = await app?.inject({ method: "HEAD", url: "/stored-file", headers: SAME_ORIGIN });
    expect(r?.statusCode).toBe(200);
    expect(r?.headers["content-type"]).toBe(DOWNLOAD_TYPE);
    expect(r?.headers["content-security-policy"]).toBe(FILE_CSP);
    expect(r?.body).toBe("");
  });

  it("streams a file, and cuts off a stream longer or shorter than its size", async () => {
    const ok = await serve(() => ({
      body: Readable.from([PNG.subarray(0, 4), PNG.subarray(4)]),
      size: PNG.byteLength,
      mediaType: "image/png",
      fileName: "p.png",
    }));
    expect(ok.rawPayload.equals(PNG)).toBe(true);
    await stop();
    for (const size of [PNG.byteLength - 1, PNG.byteLength + 5]) {
      let received: number | undefined;
      try {
        const r = await serve(() => ({
          body: Readable.from([PNG]),
          size,
          mediaType: "image/png",
          fileName: "p.png",
        }));
        if (r.statusCode === 500) {
          // Stopped before anything was sent: the ordinary error reply.
          expect(JSON.parse(r.body)).toEqual({ error: "internal_error" });
          expect(r.headers["content-disposition"]).toBeUndefined();
          received = undefined;
        } else {
          expect(r.statusCode).toBe(200);
          received = r.rawPayload.byteLength;
        }
      } catch {
        received = undefined; // the connection was cut
      }
      // Either the connection is cut or no more than the claimed bytes arrive.
      if (received !== undefined) {
        expect(received).toBeLessThanOrEqual(Math.min(size, PNG.byteLength));
      }
      await stop();
    }
  });
});

describe("fileReply", () => {
  it("refuses a size that doesn't match, bad sizes and bad bodies", () => {
    const base = { mediaType: "image/png", fileName: "p.png" };
    expect(() => fileReply({ ...base, body: PNG, size: 1 })).toThrow();
    for (const size of [-1, 1.5, Number.NaN, 2 ** 60]) {
      expect(() => fileReply({ ...base, body: PNG, size })).toThrow();
    }
    expect(() => fileReply({ ...base, body: "text" as never, size: 4 })).toThrow();
    expect(() =>
      fileReply({ ...base, body: PNG, size: PNG.byteLength, disposition: "download" as never }),
    ).toThrow();
  });

  it("can't be forged: only its own replies count", () => {
    const real = fileReply({
      body: PNG,
      size: PNG.byteLength,
      mediaType: "image/png",
      fileName: "x",
    });
    expect(isFileReply(real)).toBe(true);
    expect(isFileReply({ ...real })).toBe(false);
    expect(isFileReply({ headers: { "content-type": "text/html" }, body: HTML })).toBe(false);
    expect(Object.isFrozen(real) && Object.isFrozen(real.headers)).toBe(true);
  });

  it("sends a plain object a handler returns that looks like a file as JSON, not as a file", async () => {
    const route: OculusRoute = {
      method: "GET",
      path: "/fake",
      handler: () => ({ headers: { "content-type": "text/html" }, body: "<script>x</script>" }),
    };
    ({ app } = await testServer({}, [route]));
    const r = await app.inject({ method: "GET", url: "/fake", headers: SAME_ORIGIN });
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("shows inline only the listed media types", () => {
    for (const type of INLINE_FILE_TYPES) expect(mayShowInline(type)).toBe(true);
    for (const type of ACTIVE) expect(mayShowInline(type)).toBe(false);
    for (const type of ["image/tiff", "image/bmp", "image/x-icon", "video/quicktime", 5, null]) {
      expect(mayShowInline(type)).toBe(false);
    }
  });
});

describe("file names in Content-Disposition", () => {
  it("never makes a path, a broken header or a hidden direction change", () => {
    const names = [
      "../../etc/passwd",
      "..\\..\\boot.ini",
      'a"; filename="evil.html',
      "line\r\nx-evil: 1",
      "nul\u0000byte",
      "rtl\u202Egpj.exe",
      "zero\u200Bwidth",
      "...hidden",
      "trailing. . .",
      "   ",
      "",
    ];
    for (const name of names) {
      const safe = safeFileName(name);
      expect(safe).not.toMatch(/[/\\"\r\n]/);
      for (const hidden of ["\u0000", "\u202E", "\u200B"])
        expect(safe.includes(hidden)).toBe(false);
      expect(safe.startsWith(".")).toBe(false);
      expect(safe).not.toMatch(/[ .]$/);
      const header = contentDisposition("attachment", name);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
      expect(header.split(";")).toHaveLength(3);
    }
    expect(safeFileName("")).toBe("file");
    expect(safeFileName(42)).toBe("file");
  });

  it("keeps non-ASCII names in filename* and an ASCII fallback", () => {
    expect(contentDisposition("attachment", "Señora Muñoz 1909 (1).jpg")).toBe(
      `attachment; filename="Se_ora Mu_oz 1909 (1).jpg"; filename*=UTF-8''Se%C3%B1ora%20Mu%C3%B1oz%201909%20%281%29.jpg`,
    );
  });

  it("keeps the extension of a long name, turns tabs into spaces, and guards device names", () => {
    const long = safeFileName(`${"x".repeat(146)}.html`);
    expect(long.endsWith(".html")).toBe(true);
    expect(Array.from(long)).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(safeFileName("a\tb")).toBe("a b");
    expect(safeFileName("CON")).toBe("_CON");
    expect(safeFileName("nul.txt")).toBe("_nul.txt");
    expect(safeFileName("console.txt")).toBe("console.txt");
    expect(contentDisposition("attachment", "📷.jpg")).toBe(
      `attachment; filename="_.jpg"; filename*=UTF-8''%F0%9F%93%B7.jpg`,
    );
  });

  it("caps long names", () => {
    expect(Array.from(safeFileName("é".repeat(1000)))).toHaveLength(MAX_FILE_NAME_LENGTH);
  });
});

/** A source that counts its reads, can be slow, and can fail. */
class Source extends Readable {
  reads = 0;
  sent = 0;
  constructor(
    private readonly total: number,
    private readonly options: { chunk?: number; delayMs?: number; failAt?: number } = {},
  ) {
    super();
  }
  override _read(): void {
    this.reads++;
    const chunk = this.options.chunk ?? 16_384;
    const next = (): void => {
      if (this.options.failAt !== undefined && this.sent >= this.options.failAt) {
        this.destroy(new Error("storage failed"));
        return;
      }
      if (this.sent >= this.total) {
        this.push(null);
        return;
      }
      const n = Math.min(chunk, this.total - this.sent);
      this.sent += n;
      this.push(Buffer.alloc(n, 0x41));
    };
    if (this.options.delayMs === undefined) next();
    else setTimeout(next, this.options.delayMs);
  }
}

interface Fetched {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
  complete: boolean;
}

/** One real HTTP request; `abortAfter` bytes, the client hangs up. */
function fetchOver(
  port: number,
  method: string,
  path: string,
  abortAfter?: number,
): Promise<Fetched> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { origin: "http://localhost" } },
      (res) => {
        let bytes = 0;
        const done = (complete: boolean): void => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, complete });
        };
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (abortAfter !== undefined && bytes >= abortAfter) {
            req.destroy();
            done(false);
          }
        });
        res.on("end", () => {
          done(res.complete);
        });
        res.on("error", () => {
          done(false);
        });
        res.on("aborted", () => {
          done(false);
        });
      },
    );
    req.on("error", () => {
      resolve({ status: 0, headers: {}, bytes: 0, complete: false });
    });
    req.end();
  });
}

async function listening(
  handler: OculusRoute["handler"],
  timeouts?: { handler: number },
): Promise<number> {
  ({ app } = await testServer(timeouts === undefined ? {} : { timeouts }, [
    { method: "GET", path: "/stream", handler },
  ]));
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as AddressInfo).port;
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("streamed file replies over real HTTP", () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  afterEach(() => {
    process.removeListener("uncaughtException", onUncaught);
    expect(uncaught).toEqual([]);
    uncaught.length = 0;
  });
  const watch = (): void => {
    process.on("uncaughtException", onUncaught);
  };

  it("survives a storage error, even with work between fileReply and return", async () => {
    watch();
    const source = new Source(100_000, { failAt: 0 });
    const port = await listening(async () => {
      const reply = fileReply({
        body: source,
        size: 100_000,
        mediaType: "image/png",
        fileName: "p",
      });
      await new Promise((r) => setTimeout(r, 50)); // an audit write, say
      return reply;
    });
    const r = await fetchOver(port, "GET", "/stream");
    expect(r.complete).toBe(false);
    expect(r.bytes).toBe(0);
    await until(() => source.destroyed);
    expect(source.destroyed).toBe(true);
  });

  it("sends a slow file whole, past the handler timeout", async () => {
    watch();
    const total = 20 * 4096;
    const port = await listening(
      () =>
        fileReply({
          body: new Source(total, { chunk: 4096, delayMs: 50 }),
          size: total,
          mediaType: "video/mp4",
          fileName: "v.mp4",
        }),
      { handler: 300 },
    );
    const started = Date.now();
    const r = await fetchOver(port, "GET", "/stream");
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(r).toMatchObject({ status: 200, bytes: total, complete: true });
    expect(r.headers["content-security-policy"]).toBe(FILE_CSP);
    expect(r.headers["content-type"]).toBe(DOWNLOAD_TYPE);
    expect(r.headers["content-length"]).toBe(String(total));
  });

  it("closes the source when the client goes away", async () => {
    watch();
    const source = new Source(50_000_000, { chunk: 65_536 });
    const port = await listening(() =>
      fileReply({ body: source, size: 50_000_000, mediaType: "image/png", fileName: "big.png" }),
    );
    const r = await fetchOver(port, "GET", "/stream", 100_000);
    expect(r.complete).toBe(false);
    await until(() => source.destroyed);
    expect(source.destroyed).toBe(true);
    expect(source.sent).toBeLessThan(50_000_000);
  });

  it("closes the source and sends no more than its size when a stream runs long or short", async () => {
    watch();
    for (const [total, size] of [
      [200_000, 100_000],
      [100_000, 200_000],
    ] as const) {
      const source = new Source(total);
      const port = await listening(() =>
        fileReply({ body: source, size, mediaType: "image/png", fileName: "p.png" }),
      );
      const r = await fetchOver(port, "GET", "/stream");
      expect(r.complete).toBe(false);
      expect(r.bytes).toBeLessThanOrEqual(Math.min(total, size));
      await until(() => source.destroyed);
      expect(source.destroyed).toBe(true);
      await stop();
    }
  });

  it("answers HEAD with the headers and reads nothing", async () => {
    watch();
    const source = new Source(131_000_000);
    const port = await listening(() =>
      fileReply({ body: source, size: 131_000_000, mediaType: "image/png", fileName: "p.png" }),
    );
    const r = await fetchOver(port, "HEAD", "/stream");
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe("131000000");
    expect(r.headers["content-security-policy"]).toBe(FILE_CSP);
    expect(source.sent).toBe(0);
    expect(source.destroyed).toBe(true);
  });

  it("destroys a file reply that comes back after the handler timeout", async () => {
    watch();
    const source = new Source(100_000);
    const port = await listening(
      async () => {
        await new Promise((r) => setTimeout(r, 400));
        return fileReply({ body: source, size: 100_000, mediaType: "image/png", fileName: "p" });
      },
      { handler: 100 },
    );
    const r = await fetchOver(port, "GET", "/stream");
    expect(r.status).toBe(503);
    await until(() => source.destroyed);
    expect(source.destroyed).toBe(true);
    expect(source.sent).toBe(0);
  });
});
