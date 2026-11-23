// Attack tests for D-051 rule 5: Origin / Sec-Fetch-Site on every change.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function send(method: string, headers: Record<string, string>, url = "/accept") {
  const built = await testServer({}, (r) => {
    r.route({
      method: ["PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/accept",
      handler: () => ({ ok: true }),
    });
  });
  app = built.app;
  const res = await app.inject({
    method: method as "POST",
    url,
    headers: { "content-type": "application/json", ...headers },
    payload: "{}",
  });
  return { res, calls: built.calls };
}

describe("same-origin check on changes", () => {
  it.each([
    [{ origin: "http://localhost" }],
    [{ origin: "HTTP://LOCALHOST" }],
    [{ "sec-fetch-site": "same-origin" }],
    [{ origin: "http://localhost", "sec-fetch-site": "same-origin" }],
  ])("accepts a same-origin POST: %j", async (headers) => {
    const { res } = await send("POST", headers);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [{}],
    [{ origin: "https://evil.example" }],
    [{ origin: "http://localhost.evil.example" }],
    [{ origin: "http://evil.example@localhost" }],
    [{ origin: "http://localhost:8080" }],
    [{ origin: "https://localhost" }],
    [{ origin: "null" }],
    [{ origin: "http://localhost/" }],
    [{ origin: "http://localhost, http://localhost" }],
    [{ "sec-fetch-site": "cross-site" }],
    [{ "sec-fetch-site": "same-site" }],
    [{ "sec-fetch-site": "none" }],
    [{ origin: "http://localhost", "sec-fetch-site": "cross-site" }],
    [{ origin: "https://evil.example", "sec-fetch-site": "same-origin" }],
    [{ referer: "http://localhost/form" }],
  ])("refuses a POST with %j before the handler", async (headers) => {
    const { res, calls } = await send("POST", headers);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "cross_origin" });
    expect(calls.count).toBe(0);
  });

  it.each(["PUT", "PATCH", "DELETE", "OPTIONS"])("checks %s too", async (method) => {
    const refused = await send(method, { origin: "https://evil.example" });
    expect(refused.res.statusCode).toBe(403);
    await app?.close();
    const allowed = await send(method, { origin: "http://localhost" });
    expect(allowed.res.statusCode).toBe(200);
  });

  it("doesn't check GET or HEAD", async () => {
    const built = await testServer();
    app = built.app;
    for (const method of ["GET", "HEAD"] as const) {
      const res = await app.inject({
        method,
        url: "/health",
        headers: { origin: "https://evil.example" },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses when the Host header is spoofed to match a hostile Origin", async () => {
    // A browser always sends the real Host, so the attacker can't pick it; but
    // a forwarded host from an untrusted sender must not count.
    const { res } = await send("POST", {
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    expect(res.statusCode).toBe(403);
  });
});
