// Attack tests for what a handler throws (server.ts, errors.ts, D-058): the
// thrown value never reaches Fastify, its default error handler or the
// logger; only a fresh value built by the HTTP layer does. The error handler
// itself can't throw, and a Refusal only carries a 4xx or 5xx status.
import { tracingChannel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Refusal, errorReply, internalError, rebuildThrown, summarizeThrown } from "./errors.js";
import { SECURITY_HEADERS } from "./headers.js";
import type { OculusRoute } from "./routes.js";
import { rawRequest, testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const thrower = (make: () => unknown): OculusRoute => ({
  method: "GET",
  path: "/t",
  handler: () => {
    throw make();
  },
});

const rejecter = (make: () => unknown): OculusRoute => ({
  method: "GET",
  path: "/t",
  handler: async () => {
    await Promise.resolve();
    throw make();
  },
});

/** Headers a thrown value carries, hoping Fastify's default error handler copies them. */
const EVIL_HEADERS = {
  "access-control-allow-origin": "https://evil.example",
  "access-control-allow-credentials": "true",
  refresh: "0; url=https://evil.example/",
  "strict-transport-security": "max-age=0",
  "x-evil": "1",
};

const boom = (): never => {
  throw new Error("getter ran");
};

const hostile: [string, () => unknown][] = [
  [
    "an object whose statusCode getter throws",
    () => ({
      get statusCode(): number {
        return boom();
      },
      headers: EVIL_HEADERS,
      message: "secret detail",
    }),
  ],
  [
    "an object whose code getter throws",
    () =>
      Object.defineProperty(
        Object.assign(new Error("secret detail"), { headers: EVIL_HEADERS, statusCode: 500 }),
        "code",
        { get: boom, enumerable: true },
      ),
  ],
  [
    "a Proxy whose getPrototypeOf throws",
    () =>
      new Proxy(Object.assign(new Error("secret detail"), { headers: EVIL_HEADERS }), {
        getPrototypeOf: boom,
      }),
  ],
  [
    "a fake Refusal with throwing getters",
    () =>
      Object.create(Refusal.prototype, {
        statusCode: { get: boom, enumerable: true },
        code: { get: boom, enumerable: true },
        message: { value: "secret detail" },
        headers: { value: EVIL_HEADERS, enumerable: true },
      }) as unknown,
  ],
  [
    "a fake Refusal with a status that desyncs the connection",
    () =>
      Object.assign(Object.create(Refusal.prototype) as object, {
        statusCode: 101,
        code: "switching",
        headers: EVIL_HEADERS,
      }),
  ],
  [
    "a fake Refusal with a 3xx status",
    () =>
      Object.assign(Object.create(Refusal.prototype) as object, {
        statusCode: 302,
        code: "found",
        headers: { location: "https://evil.example/" },
      }),
  ],
  [
    "a fake Refusal with a code that isn't a code",
    () =>
      Object.assign(Object.create(Refusal.prototype) as object, {
        statusCode: 400,
        code: "secret detail\r\nX-Evil: 1",
      }),
  ],
  [
    "an Error with framing headers",
    () =>
      Object.assign(new Error("secret detail"), {
        statusCode: 400,
        headers: { "transfer-encoding": "chunked", "content-length": "5", ...EVIL_HEADERS },
      }),
  ],
  [
    "an Error with a CR LF header",
    () =>
      Object.assign(new Error("secret detail"), {
        headers: { "x-a": "a\r\nSet-Cookie: tracker=1" },
      }),
  ],
  [
    "an Error with a throwing enumerable getter (for the logger)",
    () =>
      Object.defineProperty(
        Object.assign(new Error("secret detail"), { headers: EVIL_HEADERS }),
        "leak",
        { get: boom, enumerable: true },
      ),
  ],
  ["a thrown string", () => "secret detail"],
  ["a thrown null", () => null],
];

function expectPlain500(res: { status: number; head: string; body: string }, what: string): void {
  expect(res.status, what).toBe(500);
  expect(res.body, what).toBe('{"error":"internal_error"}');
  const head = res.head.toLowerCase();
  expect(head, what).not.toMatch(/access-control|refresh|x-evil|set-cookie|tracker|evil\.example/);
  expect(head, what).not.toContain("strict-transport-security");
  expect(head, what).not.toContain("transfer-encoding");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(head, `${what}: ${name}`).toContain(`${name}: ${value}`.toLowerCase());
  }
}

async function wireGet(
  server: FastifyInstance,
): Promise<{ status: number; head: string; body: string }> {
  const res = await rawRequest(server, "GET", "/t");
  return { status: res.status, head: res.head, body: res.body };
}

describe("a value a handler throws", () => {
  it.each(hostile)("never reaches Fastify: %s", async (name, make) => {
    for (const route of [thrower(make), rejecter(make)]) {
      const lines: string[] = [];
      const built = await testServer({ logger: { stream: { write: (l) => lines.push(l) } } }, [
        route,
      ]);
      app = built.app;
      const res = await wireGet(app);
      expectPlain500(res, name);
      // The log has one fixed-shape record of the failure; never the object's fields.
      const failures = lines.filter((l) => l.includes('"level":50'));
      expect(failures.length, name).toBe(1);
      expect(lines.join("\n"), name).not.toMatch(/evil\.example|getter ran|"headers"/);
      await app.close();
      app = undefined;
    }
  });

  it("keeps a handler's own Refusal, rebuilt", async () => {
    const built = await testServer({}, [thrower(() => new Refusal(409, "edit_conflict"))]);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/t" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "edit_conflict" });
  });

  it("shows diagnostics_channel subscribers only a fresh Error with plain data", async () => {
    const seen: unknown[] = [];
    const channel = tracingChannel("fastify.request.handler");
    const subscriber = {
      start: () => undefined,
      end: () => undefined,
      asyncStart: () => undefined,
      asyncEnd: () => undefined,
      error: (store: unknown) => {
        seen.push((store as { error?: unknown }).error);
      },
    };
    channel.subscribe(subscriber);
    try {
      const [, make] = hostile[0] ?? ["", () => null];
      const built = await testServer({}, [rejecter(make)]);
      app = built.app;
      const res = await app.inject({ method: "GET", url: "/t" });
      expect(res.statusCode).toBe(500);
      expect(seen.length).toBe(1);
      const error = seen[0];
      expect(error).toBeInstanceOf(Refusal);
      expect(Object.isFrozen(error)).toBe(true);
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(error as object),
      )) {
        expect("value" in descriptor, key).toBe(true);
      }
      expect((error as Refusal).statusCode).toBe(500);
      expect((error as Refusal).code).toBe("internal_error");
    } finally {
      channel.unsubscribe(subscriber);
    }
  });
});

describe("the error handler", () => {
  it("can't throw: a logger that fails still gets a plain 500 with the security headers", async () => {
    const built = await testServer(
      {
        logger: {
          stream: {
            write: (line: string) => {
              if (line.includes('"level":50')) throw new Error("log stream broke: secret detail");
            },
          },
        },
      },
      [thrower(() => new Error("x"))],
    );
    app = built.app;
    const res = await wireGet(app);
    expectPlain500(res, "failing logger");
    expect(res.body).not.toContain("secret");
  });
});

describe("Refusal", () => {
  it.each([101, 42, 200, 204, 302, 399, 600, 1000, 450.5, Number.NaN])(
    "refuses status %s",
    (status) => {
      expect(() => new Refusal(status, "x")).toThrow(/status/);
    },
  );

  it.each(["", "Bad", "has space", "a\r\nb", "x".repeat(65), "1abc"])("refuses code %j", (code) => {
    expect(() => new Refusal(400, code)).toThrow(/code/);
  });

  it("is frozen and holds only data properties", () => {
    const refusal = new Refusal(404, "not_found");
    expect(Object.isFrozen(refusal)).toBe(true);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(refusal))) {
      expect("value" in descriptor).toBe(true);
    }
  });
});

describe("a handler that fails after its time is up", () => {
  it.each([
    ["rejects with an Error", () => new Error("late failure")],
    ["rejects with a Refusal", () => new Refusal(409, "edit_conflict")],
  ])("%s: the log gets the fixed-shape summary and never the query string", async (name, make) => {
    const lines: string[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const built = await testServer(
      { timeouts: { handler: 50 }, logger: { stream: { write: (l) => lines.push(l) } } },
      [
        {
          method: "GET",
          path: "/late",
          handler: async () => {
            try {
              await new Promise((resolve) => setTimeout(resolve, 150));
              throw make();
            } finally {
              setTimeout(finished, 20);
            }
          },
        },
      ],
    );
    app = built.app;
    const res = await rawRequest(app, "GET", "/late?q=PRIVQ");
    expect(res.status, name).toBe(503);
    expect(res.body, name).toBe('{"error":"unavailable"}');
    await done;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = lines.join("\n");
    expect(log, name).not.toContain("PRIVQ");
    expect(log, name).not.toMatch(/FST_ERR|TypeError|already sent/i);
    const late = lines.filter((l) => l.includes('"failure"') && l.includes("after the reply"));
    expect(late.length, name).toBe(1);
    expect(late[0], name).toContain('"path":"/late"');
    expect(late[0], name).toContain('"method":"GET"');
  });
});

describe("the server logger", () => {
  it("never writes a query string or an error object, whatever Fastify passes it", async () => {
    const lines: string[] = [];
    const built = await testServer({ logger: { stream: { write: (l) => lines.push(l) } } });
    app = built.app;
    const frozen = new Refusal(500, "internal_error");
    app.log.warn({ err: new Error('Reply was already sent in "/a?q=PRIVQ" (GET)') });
    app.log.error({ err: frozen }, "Promise errored, but reply.sent = true was set");
    app.log.error(new Error("/a?q=PRIVQ"));
    app.log.info("Route GET:/a?q=PRIVQ not found");
    app.log.info({ extra: "PRIVQ", res: { statusCode: 200 } }, 'in "/a?q=PRIVQ"');
    expect(lines.length).toBe(5);
    const log = lines.join("\n");
    expect(log).not.toContain("PRIVQ");
    expect(log).not.toContain("internal_error");
    expect(log).toContain("Route GET:/a not found");
  });
});

describe("summarizeThrown and the stack", () => {
  let ran = 0;
  const counted = (): never => {
    ran++;
    throw new Error("getter ran");
  };

  it.each([
    [
      "a class with a throwing name getter",
      () => {
        class Sneaky extends Error {
          override get name(): string {
            return counted();
          }
        }
        return new Sneaky("secret detail");
      },
    ],
    [
      "an Error with an own throwing name getter",
      () => Object.defineProperty(new Error("m"), "name", { get: counted }),
    ],
    [
      "an Error with an own throwing message getter",
      () => Object.defineProperty(new Error("m"), "message", { get: counted }),
    ],
    [
      "an Error whose prototype is swapped for one with a name getter",
      () =>
        Object.setPrototypeOf(
          new Error("m"),
          Object.create(Error.prototype, { name: { get: counted } }) as object,
        ) as object,
    ],
  ])("never runs a getter for the stack: %s", (_name, make) => {
    ran = 0;
    const value = make();
    ran = 0;
    const summary = summarizeThrown(value);
    expect(ran).toBe(0);
    expect(summary.stack).toBe("");
    expect(rebuildThrown(value).statusCode).toBe(500);
    expect(ran).toBe(0);
  });

  it("still logs the stack of a plain built-in error", () => {
    for (const error of [new Error("m"), new TypeError("t"), new RangeError("r")]) {
      const summary = summarizeThrown(error);
      expect(summary.stack).toContain(`${error.name}: ${error.message}`);
      expect(summary.stack).toContain("throws.attacks.test");
    }
  });
});

describe("rebuildThrown with a tampered Refusal.prototype", () => {
  const keys = ["name", "statusCode", "code", "stack", "message"] as const;

  it("never throws and still answers a plain 500", async () => {
    const saved = keys.map((key) => Object.getOwnPropertyDescriptor(Refusal.prototype, key));
    let ran = 0;
    for (const key of keys) {
      Object.defineProperty(Refusal.prototype, key, {
        configurable: true,
        get: () => undefined,
        set: () => {
          ran++;
          throw new Error("setter ran");
        },
      });
    }
    try {
      for (const thrown of [new Error("x"), "x", null, { statusCode: 409 }]) {
        const fresh = rebuildThrown(thrown);
        expect(Object.isFrozen(fresh)).toBe(true);
        expect(errorReply(fresh)).toEqual({
          statusCode: 500,
          body: { error: "internal_error" },
        });
      }
      expect(internalError().statusCode).toBe(500);
      expect(ran).toBe(0);
      const built = await testServer({}, [thrower(() => new Error("x"))]);
      app = built.app;
      expectPlain500(await wireGet(app), "tampered prototype");
    } finally {
      keys.forEach((key, i) => {
        const descriptor = saved[i];
        if (descriptor === undefined) Reflect.deleteProperty(Refusal.prototype, key);
        else Object.defineProperty(Refusal.prototype, key, descriptor);
      });
    }
  });
});
