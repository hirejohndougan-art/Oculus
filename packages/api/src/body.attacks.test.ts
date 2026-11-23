// Attack tests for D-051 rules 1 and 2: content types, compressed bodies,
// prototype keys and byte-counted limits.
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CREDENTIALS_BODY_LIMIT, DEFAULT_BODY_LIMIT, isExactMediaType } from "./body.js";
import { SAME_ORIGIN, testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const built = await testServer();
  app = built.app;
  return built;
}

function post(
  url: string,
  contentType: string | undefined,
  payload: string | Buffer | Readable,
  extra = {},
) {
  const headers: Record<string, string> = { ...SAME_ORIGIN, ...extra };
  if (contentType !== undefined) headers["content-type"] = contentType;
  if (app === undefined) throw new Error("no app");
  return app.inject({ method: "POST", url, headers, payload });
}

describe("content types (415)", () => {
  it("accepts exact application/json, with or without charset=utf-8", async () => {
    await setup();
    for (const type of [
      "application/json",
      "Application/JSON",
      "application/json; charset=utf-8",
      'application/json;charset="UTF-8"',
    ]) {
      const res = await post("/echo", type, '{"a":1}');
      expect(res.statusCode, type).toBe(200);
      expect(res.json()).toEqual({ body: { a: 1 } });
    }
  });

  it.each([
    "text/plain",
    "application/json-patch+json",
    "application/jsonx",
    "application/vnd.api+json",
    "application/json; charset=latin1",
    "application/json; charset=utf-8; boundary=x",
    "application/json; foo=bar",
    "application/json;",
    "application/json, text/plain",
    "multipart/form-data; boundary=x",
    "application/x-www-form-urlencoded",
    "application/xml",
    " text/plain; application/json",
    "*/*",
  ])("refuses %j on a JSON route without running the handler", async (type) => {
    const { calls } = await setup();
    const res = await post("/echo", type, '{"a":1}');
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "unsupported_media_type" });
    expect(calls.count).toBe(0);
  });

  it("refuses a body with no Content-Type", async () => {
    const { calls } = await setup();
    const res = await post("/echo", undefined, '{"a":1}');
    expect(res.statusCode).toBe(415);
    expect(calls.count).toBe(0);
  });

  it("accepts form posts only on routes marked as form routes", async () => {
    const { calls } = await setup();
    const ok = await post(
      "/form",
      "application/x-www-form-urlencoded",
      "name=Jane+Doe&city=Dickinson",
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ body: { name: "Jane Doe", city: "Dickinson" } });
    const refused = await post("/echo", "application/x-www-form-urlencoded", "a=1");
    expect(refused.statusCode).toBe(415);
    expect(calls.count).toBe(1);
  });

  it("refuses compressed bodies (Content-Encoding) even with a valid type", async () => {
    const { calls } = await setup();
    for (const encoding of ["gzip", "deflate", "br", "x-gzip", "identity, gzip", "GZIP"]) {
      const res = await post("/echo", "application/json", gzipSync('{"a":1}'), {
        "content-encoding": encoding,
      });
      expect(res.statusCode, encoding).toBe(415);
    }
    expect(calls.count).toBe(0);
    const identity = await post("/echo", "application/json", '{"a":1}', {
      "content-encoding": "identity",
    });
    expect(identity.statusCode).toBe(200);
  });

  it("refuses two Content-Type headers", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    // An array becomes two raw Content-Type headers; Node would keep only the first.
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        ...SAME_ORIGIN,
        "content-type": ["application/json", "text/plain"] as unknown as string,
      },
      payload: '{"a":1}',
    });
    expect(res.statusCode).toBe(400);
    expect(calls.count).toBe(0);
  });

  it("checks media types exactly", () => {
    expect(isExactMediaType("application/json", "application/json")).toBe(true);
    expect(isExactMediaType(undefined, "application/json")).toBe(false);
    expect(isExactMediaType("application/json ; charset = utf-8", "application/json")).toBe(true);
    expect(
      isExactMediaType("application/json; charset=utf-8; charset=utf-8", "application/json"),
    ).toBe(false);
  });
});

describe("body contents", () => {
  it.each([
    '{"__proto__":{"admin":true}}',
    '{"a":{"b":[{"__proto__":{"x":1}}]}}',
    '{"constructor":{"prototype":{"admin":true}}}',
    '[{"prototype":1}]',
  ])("refuses prototype keys anywhere in JSON: %s", async (payload) => {
    const { calls } = await setup();
    const res = await post("/echo", "application/json", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "forbidden_key" });
    expect(calls.count).toBe(0);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it.each(["__proto__[admin]=1", "__proto__=x", "constructor=x", "prototype=1"])(
    "refuses prototype keys in forms: %s",
    async (payload) => {
      const { calls } = await setup();
      const res = await post("/form", "application/x-www-form-urlencoded", payload);
      // "__proto__[admin]" is a different key; only exact prototype names are refused.
      if (payload.startsWith("__proto__[")) {
        expect(res.statusCode).toBe(200);
        expect(({} as Record<string, unknown>).admin).toBeUndefined();
      } else {
        expect(res.statusCode).toBe(400);
        expect(calls.count).toBe(0);
      }
    },
  );

  it("refuses a form field given twice (parameter pollution)", async () => {
    const { calls } = await setup();
    const res = await post("/form", "application/x-www-form-urlencoded", "user=a&user=b");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "repeated_field" });
    expect(calls.count).toBe(0);
  });

  it("refuses bad JSON, empty bodies and invalid UTF-8 without echoing them", async () => {
    const { calls } = await setup();
    for (const payload of ["{bad", "", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
      const res = await post("/echo", "application/json", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "bad_body" });
      expect(res.body).not.toMatch(/Unexpected|position|SyntaxError/);
    }
    const form = await post(
      "/form",
      "application/x-www-form-urlencoded",
      Buffer.from([0x61, 0x3d, 0xc3]),
    );
    expect(form.statusCode).toBe(400);
    expect(calls.count).toBe(0);
  });

  it("survives deeply nested JSON", async () => {
    await setup();
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    const res = await post("/accept", "application/json", deep);
    expect(res.statusCode).toBe(200);
  });
});

describe("byte-counted limits (413)", () => {
  it("allows 1 MiB and refuses one byte more on ordinary routes", async () => {
    const { calls } = await setup();
    const fits = JSON.stringify("x".repeat(DEFAULT_BODY_LIMIT - 2));
    expect(Buffer.byteLength(fits)).toBe(DEFAULT_BODY_LIMIT);
    expect((await post("/echo", "application/json", fits)).statusCode).toBe(200);
    const over = JSON.stringify("x".repeat(DEFAULT_BODY_LIMIT - 1));
    const res = await post("/echo", "application/json", over);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "payload_too_large" });
    expect(calls.count).toBe(1);
  });

  it("holds sign-in routes to 8 KiB, counted in bytes not characters", async () => {
    const { calls } = await setup();
    const fits = "p=" + "a".repeat(CREDENTIALS_BODY_LIMIT - 2);
    expect((await post("/sign-in", "application/x-www-form-urlencoded", fits)).statusCode).toBe(
      200,
    );
    // 5,000 characters of "é" are 10,000 bytes: over the limit though under it in characters.
    const multibyte = "p=" + "é".repeat(5000);
    expect(multibyte.length).toBeLessThan(CREDENTIALS_BODY_LIMIT);
    const res = await post("/sign-in", "application/x-www-form-urlencoded", multibyte);
    expect(res.statusCode).toBe(413);
    expect(calls.count).toBe(1);
  });

  it("counts chunked bodies with no Content-Length as they arrive", async () => {
    const { calls } = await setup();
    const chunks = Array.from({ length: 20 }, () => "a".repeat(1024));
    const stream = Readable.from(["p=", ...chunks]);
    const res = await post("/sign-in", "application/x-www-form-urlencoded", stream);
    expect(res.statusCode).toBe(413);
    const big = Readable.from(Array.from({ length: 1100 }, () => "x".repeat(1024)));
    const res2 = await post("/echo", "application/json", big);
    expect(res2.statusCode).toBe(413);
    expect(calls.count).toBe(0);
  });

  it("refuses a body longer than its Content-Length", async () => {
    const { calls } = await setup();
    const res = await post(
      "/sign-in",
      "application/x-www-form-urlencoded",
      "p=" + "a".repeat(100),
      {
        "content-length": "10",
      },
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls.count).toBe(0);
  });

  it("refuses a declared Content-Length over the limit before reading", async () => {
    const { calls } = await setup();
    const res = await post("/sign-in", "application/x-www-form-urlencoded", "p=1", {
      "content-length": String(CREDENTIALS_BODY_LIMIT + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(calls.count).toBe(0);
  });

  it("doesn't let a credentials route raise its own limit", async () => {
    const { calls } = await setup();
    const res = await post(
      "/sign-in-greedy",
      "application/json",
      JSON.stringify("x".repeat(CREDENTIALS_BODY_LIMIT)),
    );
    expect(res.statusCode).toBe(413);
    expect(calls.count).toBe(0);
  });
});
