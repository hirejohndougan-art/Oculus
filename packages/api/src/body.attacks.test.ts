// Attack tests for D-051 rules 1 and 2: content types, compressed bodies,
// prototype keys and byte-counted limits.
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CREDENTIALS_BODY_LIMIT,
  DEFAULT_BODY_LIMIT,
  MAX_JSON_DEPTH,
  isExactMediaType,
  parseFormBody,
} from "./body.js";
import { SAME_ORIGIN, TEST_ENV, testServer } from "./test-server.fixtures.js";
import { buildServer } from "./server.js";
import type { OculusRoute } from "./routes.js";

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

  it("checks media types exactly, with RFC 9110 whitespace", () => {
    expect(isExactMediaType("application/json", "application/json")).toBe(true);
    expect(isExactMediaType(undefined, "application/json")).toBe(false);
    expect(isExactMediaType("application/json ;\tcharset=utf-8", "application/json")).toBe(true);
    expect(isExactMediaType("application/json; charset = utf-8", "application/json")).toBe(false);
    expect(isExactMediaType("application/json; charset =utf-8", "application/json")).toBe(false);
    expect(isExactMediaType("application/json;\u000bcharset=utf-8", "application/json")).toBe(
      false,
    );
    expect(isExactMediaType("application/json; charset=utf-8 ", "application/json")).toBe(false);
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

  it("refuses JSON nested deeper than 64, and survives very deep input", async () => {
    const { calls } = await setup();
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect((await post("/accept", "application/json", nest(MAX_JSON_DEPTH))).statusCode).toBe(200);
    const objects = '{"a":'.repeat(MAX_JSON_DEPTH) + "1" + "}".repeat(MAX_JSON_DEPTH);
    expect((await post("/accept", "application/json", objects)).statusCode).toBe(200);
    for (const payload of [
      nest(MAX_JSON_DEPTH + 1),
      nest(200_000),
      '{"a":' + nest(MAX_JSON_DEPTH) + "}",
    ]) {
      const res = await post("/accept", "application/json", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "too_deep" });
    }
    expect(calls.count).toBe(2);
  });

  it.each([
    ['{"role":"viewer","role":"admin"}', "repeated_key"],
    ['{"role":"viewer","r\\u006fle":"admin"}', "repeated_key"],
    ['[{"a":1,"b":{"a":2},"a":3}]', "repeated_key"],
    ["1e400", "bad_number"],
    ['{"n":-1e400}', "bad_number"],
    ["[1, 2e308]", "bad_number"],
  ])("refuses %s", async (payload, code) => {
    const { calls } = await setup();
    const res = await post("/echo", "application/json", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: code });
    expect(calls.count).toBe(0);
  });

  it("accepts the same key in different objects and keys that only look alike", async () => {
    await setup();
    const res = await post(
      "/echo",
      "application/json",
      '[{"a":1},{"a":2},{"a":{"a":3}},{"A":1,"a":"\\"a\\""}]',
    );
    expect(res.statusCode).toBe(200);
    expect((await post("/echo", "application/json", '{"n":1.5e300,"m":-0.5}')).statusCode).toBe(
      200,
    );
  });

  it("refuses a byte order mark", async () => {
    const { calls } = await setup();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(
      (await post("/echo", "application/json", Buffer.concat([bom, Buffer.from("{}")]))).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          "/form",
          "application/x-www-form-urlencoded",
          Buffer.concat([bom, Buffer.from("a=1")]),
        )
      ).statusCode,
    ).toBe(400);
    expect(calls.count).toBe(0);
  });

  it.each(["a=%FF", "a=%C3", "a=%", "a=%z1", "a=%e9t%e9", "%ED%A0%80=1"])(
    "refuses bad percent-encoding in forms: %s",
    async (payload) => {
      const { calls } = await setup();
      const res = await post("/form", "application/x-www-form-urlencoded", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "bad_body" });
      expect(calls.count).toBe(0);
    },
  );

  it("decodes forms like browsers send them", () => {
    expect(parseFormBody(Buffer.from("a=caf%C3%A9+au+lait&&b&c=&d=1%2B1%3D2"))).toEqual({
      a: "café au lait",
      b: "",
      c: "",
      d: "1+1=2",
    });
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

  it("holds JSON credentials routes to 8 KiB too", async () => {
    const { calls } = await setup();
    const payload = JSON.stringify("x".repeat(CREDENTIALS_BODY_LIMIT));
    const res = await post("/sign-in-json", "application/json", payload);
    expect(res.statusCode).toBe(413);
    expect(calls.count).toBe(0);
  });

  it("doesn't let a route choose its own body limit", async () => {
    const greedy = {
      method: "POST",
      path: "/greedy",
      credentials: true,
      bodyLimit: 10 * 1024 * 1024,
      handler: () => ({}),
    } as unknown as OculusRoute;
    await expect(buildServer({ env: TEST_ENV, routes: [greedy] })).rejects.toThrow(/bodyLimit/);
  });
});
