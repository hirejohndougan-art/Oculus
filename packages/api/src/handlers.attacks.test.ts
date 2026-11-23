// Attack tests for what a handler gets and what it can send (routes.ts,
// headers.ts, D-058): plain data only, a frozen request view with no way to
// the socket or server, checked headers, error replies without the
// handler's headers, security headers on every reply, and HEAD.
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { SECURITY_HEADERS } from "./headers.js";
import { plainData, routeConfig, type OculusReply, type OculusRoute } from "./routes.js";
import { buildServer } from "./server.js";
import { SAME_ORIGIN, TEST_ENV, rawRequest, testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (path: string, handler: OculusRoute["handler"]): OculusRoute => ({
  method: "GET",
  path,
  handler,
});

/** Writes `text` on one socket and returns everything the server sent until it closed. */
async function wire(server: FastifyInstance, text: string): Promise<string> {
  if (!server.server.listening) await server.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.server.address() as AddressInfo;
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let out = "";
    socket.on("data", (chunk: Buffer) => (out += chunk.toString("latin1")));
    socket.on("close", () => {
      resolve(out);
    });
    socket.on("error", reject);
    socket.write(text);
  });
}

describe("handler results", () => {
  it("refuses a Web Response, so its framing and cookie headers never reach the wire", async () => {
    const built = await testServer({}, [
      get(
        "/response",
        () =>
          new Response("hello", {
            headers: { "content-length": "1", "set-cookie": "tracker=1", "x-evil": "1" },
          }),
      ),
    ]);
    app = built.app;
    // Two requests on one connection: a desynced reply would leave "ello" in
    // front of the second response.
    const out = await wire(
      app,
      "GET /response HTTP/1.1\r\nHost: localhost\r\n\r\n" +
        "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    const [first = "", second = ""] = out.split(/(?=HTTP\/1\.1 )/);
    expect(first.startsWith("HTTP/1.1 500 ")).toBe(true);
    expect(first.endsWith('\r\n\r\n{"error":"internal_error"}')).toBe(true);
    expect(out.toLowerCase()).not.toMatch(/set-cookie|x-evil|tracker|hello|ello/);
    expect(second.startsWith("HTTP/1.1 200 ")).toBe(true);
    expect(second.endsWith('{"status":"ok"}')).toBe(true);
  });

  class Record_ {
    title = "x";
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const getter = Object.defineProperty({}, "leak", { get: () => "x", enumerable: true });
  let deep: unknown = 1;
  for (let i = 0; i < 300; i++) deep = [deep];

  it.each([
    ["a Response", () => new Response("x")],
    ["a Response inside data", () => ({ ok: new Response("x") })],
    ["a Node stream", () => Readable.from(["x"])],
    ["a web stream", () => new ReadableStream()],
    ["a Buffer", () => Buffer.from("x")],
    ["a Uint8Array", () => new Uint8Array([1])],
    ["a Date", () => new Date(0)],
    ["a Map", () => new Map()],
    ["a class instance", () => new Record_()],
    ["a function", () => () => 1],
    ["a function inside data", () => ({ toJSON: () => ({ hidden: true }) })],
    ["a symbol", () => Symbol("x")],
    ["a bigint", () => 1n],
    ["NaN", () => Number.NaN],
    ["Infinity inside data", () => ({ n: Number.POSITIVE_INFINITY })],
    ["a getter", () => getter],
    ["a cycle", () => cycle],
    ["data nested too deeply", () => deep],
    ["an Error", () => new Error("secret detail")],
  ])("answers %s with a plain 500", async (_name, handler) => {
    const built = await testServer({}, [get("/x", handler)]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
  });

  it.each([
    ["an object", () => ({ a: [1, "b", null, true] }), '{"a":[1,"b",null,true]}'],
    ["an array", () => [1, { b: 2 }], '[1,{"b":2}]'],
    [
      "a null-prototype object",
      (): unknown => Object.assign(Object.create(null) as object, { a: 1 }),
      '{"a":1}',
    ],
    [
      "a __proto__ key as an ordinary key",
      (): unknown => JSON.parse('{"__proto__":{"x":1}}'),
      '{"__proto__":{"x":1}}',
    ],
    ["a string", () => "plain text", "plain text"],
    ["a number", () => 5, "5"],
    ["null", () => null, "null"],
    ["nothing", () => undefined, ""],
  ])("sends %s", async (_name, handler, body) => {
    const built = await testServer({}, [get("/x", handler)]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(body);
  });

  it("copies data as it checks it, so a Proxy can't change it afterwards", () => {
    let reads = 0;
    const tricky = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return reads > 1
            ? { value: new Response("x"), enumerable: true, configurable: true, writable: true }
            : Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const copy = plainData(tricky);
    expect(copy).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(JSON.stringify(copy)).toBe('{"a":1}');
  });
});

describe("the request a handler gets", () => {
  it("is a frozen view with no Fastify request, raw message, socket or server", async () => {
    let seen: Record<string, unknown> = {};
    const built = await testServer({}, [
      {
        method: "POST",
        path: "/look/:id",
        handler: (request) => {
          seen = request as unknown as Record<string, unknown>;
          return {};
        },
      },
    ]);
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/look/7?q=a&q=b&r=c",
      headers: {
        ...SAME_ORIGIN,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "test-agent",
        authorization: "Bearer sekrit",
        cookie: `${OCULUS_COOKIES.session}=tok; other=1`,
        "x-forwarded-for": "203.0.113.9",
      },
      payload: '{"a":{"b":1}}',
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(seen).sort()).toEqual(
      [
        "body",
        "cookies",
        "headers",
        "host",
        "ip",
        "method",
        "params",
        "path",
        "protocol",
        "query",
      ].sort(),
    );
    for (const key of ["server", "raw", "socket", "log", "routeOptions", "context"]) {
      expect(key in seen, key).toBe(false);
    }
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.body)).toBe(true);
    expect(Object.isFrozen((seen.body as { a: object }).a)).toBe(true);
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/look/7");
    expect(seen.params).toEqual({ id: "7" });
    expect(seen.query).toEqual({ q: ["a", "b"], r: "c" });
    expect(seen.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "test-agent",
    });
    expect(seen.cookies).toEqual({ [OCULUS_COOKIES.session]: "tok" });
    expect(JSON.stringify(seen)).not.toMatch(/sekrit|203\.0\.113|other/);
  });

  it("can't reach the raw response through the socket", async () => {
    interface Raw {
      raw: { socket: { _httpMessage: { end(text: string): void } } };
    }
    interface Srv {
      server: { server: { close(): void } };
    }
    const built = await testServer({}, [
      get("/socket", (request) => {
        (request as unknown as Raw).raw.socket._httpMessage.end("pwned");
        return {};
      }),
      get("/close", (request) => {
        (request as unknown as Srv).server.server.close();
        return {};
      }),
    ]);
    app = built.app;
    for (const url of ["/socket", "/close"]) {
      const res = await rawRequest(app, "GET", url);
      expect(res.status, url).toBe(500);
      expect(res.body, url).toBe('{"error":"internal_error"}');
    }
    // Still listening.
    expect((await rawRequest(app, "GET", "/health")).status).toBe(200);
  });

  it("gets a reply that stops working once the handler has returned", async () => {
    let late: OculusReply | undefined;
    const built = await testServer({}, [
      get("/late", (_request, reply) => {
        late = reply;
        return {};
      }),
    ]);
    app = built.app;
    await app.inject({ method: "GET", url: "/late" });
    expect(() => late?.header("x-late", "1")).toThrow(/after the handler/);
    expect(() => late?.setCookie(OCULUS_COOKIES.session, "abc")).toThrow(/after the handler/);
  });
});

describe("headers a handler writes", () => {
  /** Set when a handler carried on past the header write. */
  let carriedOn = false;
  const writes = (act: (reply: OculusReply) => void): OculusRoute =>
    get("/w", (_request, reply) => {
      carriedOn = false;
      act(reply);
      carriedOn = true;
      return { ok: true };
    });

  it.each([
    ["a name with a space", (r: OculusReply) => r.header("X Bad", "1")],
    ["a name with a colon", (r: OculusReply) => r.header("X:Y", "1")],
    ["an empty name", (r: OculusReply) => r.header("", "1")],
    ["a name with a non-ASCII letter", (r: OculusReply) => r.header("X-é", "1")],
    ["CR LF in a value", (r: OculusReply) => r.header("X-A", "a\r\nSet-Cookie: x=1")],
    ["LF in a value", (r: OculusReply) => r.header("X-A", "a\nb")],
    ["NUL in a value", (r: OculusReply) => r.header("X-A", "a\u0000b")],
    ["a character Node refuses", (r: OculusReply) => r.header("X-A", "aĀb")],
    ["a value that isn't text", (r: OculusReply) => r.header("X-A", 1 as unknown as string)],
    ["CR LF in the content type", (r: OculusReply) => r.type("text/html\r\nX-B: 1")],
    ["Trailer", (r: OculusReply) => r.header("Trailer", "X-A")],
    ["TE", (r: OculusReply) => r.header("TE", "trailers")],
    ["Date", (r: OculusReply) => r.header("Date", "x")],
    ["CORS", (r: OculusReply) => r.header("Access-Control-Allow-Origin", "*")],
    ["CORS credentials", (r: OculusReply) => r.header("access-control-allow-credentials", "true")],
    ["a CSP", (r: OculusReply) => r.header("Content-Security-Policy", "default-src *")],
    ["a report-only CSP", (r: OculusReply) => r.header("content-security-policy-report-only", "x")],
    ["nosniff", (r: OculusReply) => r.header("X-Content-Type-Options", "none")],
    ["Referrer-Policy", (r: OculusReply) => r.header("Referrer-Policy", "unsafe-url")],
    ["Cache-Control", (r: OculusReply) => r.header("Cache-Control", "public, max-age=3600")],
    ["HSTS", (r: OculusReply) => r.header("Strict-Transport-Security", "max-age=0")],
    ["X-Frame-Options", (r: OculusReply) => r.header("X-Frame-Options", "ALLOWALL")],
    ["CORP", (r: OculusReply) => r.header("Cross-Origin-Resource-Policy", "cross-origin")],
    ["Refresh", (r: OculusReply) => r.header("Refresh", "0; url=https://evil.example")],
    ["Location off the site", (r: OculusReply) => r.header("Location", "https://evil.example/")],
    ["Location to another host", (r: OculusReply) => r.header("Location", "//evil.example/")],
    ["Location with a backslash", (r: OculusReply) => r.header("Location", "/\\evil.example")],
    ["Location with a tab", (r: OculusReply) => r.header("Location", "/\t/evil.example")],
    ["Location without a slash", (r: OculusReply) => r.header("Location", "evil.example")],
  ])("refuses %s with a plain 500", async (_name, act) => {
    const built = await testServer({}, [writes(act)]);
    app = built.app;
    // inject must settle: Node's own header errors must never be reached.
    const res = await app.inject({ method: "GET", url: "/w" });
    // Refused in reply.header() itself, not later by Node.
    expect(carriedOn).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.headers["x-a"]).toBeUndefined();
    expect(res.headers["x-b"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
    expect(res.headers.refresh).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps Node's own header errors off the wire", async () => {
    const built = await testServer({}, [writes((r) => r.header("X-A", "aĀb"))]);
    app = built.app;
    const res = await rawRequest(app, "GET", "/w");
    expect(res.status).toBe(500);
    expect(res.body).toBe('{"error":"internal_error"}');
  });

  it("allows ordinary headers and a same-origin Location", async () => {
    const built = await testServer({}, [
      writes((r) => r.status(303).header("Location", "/items/1?x=1").header("ETag", '"v1"')),
    ]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/w" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/items/1?x=1");
    expect(res.headers.etag).toBe('"v1"');
  });
});

describe("error replies", () => {
  it("drop every header and cookie the handler set", async () => {
    const built = await testServer({}, [
      get("/fail", (_request, reply) => {
        reply
          .status(201)
          .header("X-Record", "DS5C740001")
          .header("Location", "/after")
          .header("Content-Language", "en")
          .type("text/html")
          .setCookie(OCULUS_COOKIES.session, "abcDEF123");
        throw new Error("boom");
      }),
    ]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/fail" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    for (const name of ["x-record", "location", "content-language", "set-cookie"]) {
      expect(res.headers[name], name).toBeUndefined();
    }
  });
});

describe("security headers", () => {
  function expectDefaults(headers: Record<string, unknown>, what: string): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[name], `${what}: ${name}`).toBe(value);
    }
  }

  it("are on every reply: success, 404, 405, refusals and errors", async () => {
    const built = await testServer({}, [
      get("/boom", () => {
        throw new Error("x");
      }),
      get("/text", (_request, reply) => {
        reply.type("text/html; charset=utf-8");
        return "<p>x</p>";
      }),
    ]);
    app = built.app;
    for (const [method, url, status] of [
      ["GET", "/health", 200],
      ["HEAD", "/health", 200],
      ["GET", "/text", 200],
      ["GET", "/nope", 404],
      ["GET", "/echo", 405],
      ["POST", "/echo", 403],
      ["GET", "/a//b", 400],
      ["GET", "/boom", 500],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(status);
      expectDefaults(res.headers, `${method} ${url}`);
    }
  });

  it("are on replies to requests Node can't parse", async () => {
    app = await buildServer({ env: TEST_ENV });
    const out = await wire(app, "GET /health HTTP/1.1\r\nHost: localhost\r\nBad Header\r\n\r\n");
    expect(out.startsWith("HTTP/1.1 400 ")).toBe(true);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(out.toLowerCase()).toContain(`${name}: ${value}`.toLowerCase());
    }
  });
});

describe("HEAD on a GET route", () => {
  it("answers the GET reply's headers and no body", async () => {
    const built = await testServer({}, [
      get("/json", () => ({ a: 1 })),
      get("/text", () => "some text"),
      get("/empty", () => undefined),
      get("/boom", () => {
        throw new Error("x");
      }),
      // Fastify's HEAD hook can't measure a Response, so GET and HEAD used to
      // disagree (200 with a body, then 500); now both are refused.
      get("/response", () => new Response("hello")),
      get("/stream", () => Readable.from(["x"])),
    ]);
    app = built.app;
    for (const url of [
      "/health",
      "/json",
      "/text",
      "/empty",
      "/boom",
      "/items/1",
      "/response",
      "/stream",
    ]) {
      const getRes = await app.inject({ method: "GET", url });
      const head = await app.inject({ method: "HEAD", url });
      expect(head.statusCode, url).toBe(getRes.statusCode);
      expect(head.headers["content-type"], url).toBe(getRes.headers["content-type"]);
      expect(head.headers["content-length"], url).toBe(getRes.headers["content-length"]);
      expect(head.body, url).toBe("");
    }
    // On the wire, the next response on the connection starts right after
    // the HEAD reply's headers.
    const out = await wire(
      app,
      "HEAD /json HTTP/1.1\r\nHost: localhost\r\n\r\n" +
        "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    const [first = "", second = ""] = out.split(/(?=HTTP\/1\.1 )/);
    expect(first.endsWith("\r\n\r\n")).toBe(true);
    expect(second.endsWith('{"status":"ok"}')).toBe(true);
  });
});

describe("route config", () => {
  it("is frozen, so nothing can switch a route's body rules after start", () => {
    const config = routeConfig({ method: "POST", path: "/x", credentials: true, handler: () => 1 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.oculus)).toBe(true);
    expect(config.oculus).toEqual({ form: false, credentials: true });
  });
});
