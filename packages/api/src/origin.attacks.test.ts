// Attack tests for D-051 rule 5: Origin / Sec-Fetch-Site on every change.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ORIGINS_ENV, originsFromEnv } from "./origin.js";
import { buildServer } from "./server.js";
import { testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function send(
  method: string,
  headers: Record<string, string>,
  url = "/accept",
  env: Record<string, string> = {},
) {
  const built = await testServer(
    { env },
    (["PUT", "PATCH", "DELETE"] as const).map((m) => ({
      method: m,
      path: "/accept",
      handler: () => ({ ok: true }),
    })),
  );
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

  it("checks OPTIONS too", async () => {
    const { res } = await send("OPTIONS", { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("checks %s too", async (method) => {
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

  it("accepts only origins in OCULUS_ORIGINS, and only for their own host", async () => {
    const env = { [ORIGINS_ENV]: "https://admin.example.org,https://archive.example.org" };
    const at = (host: string, origin: string) =>
      send("POST", { host, origin }, "/accept", env).then(async ({ res }) => {
        await app?.close();
        return res.statusCode;
      });
    expect(await at("admin.example.org", "https://admin.example.org")).toBe(200);
    expect(await at("archive.example.org", "https://archive.example.org")).toBe(200);
    // A listed origin posting to another listed site is cross-site.
    expect(await at("admin.example.org", "https://archive.example.org")).toBe(403);
    // A Host the client chose doesn't make an unlisted origin acceptable.
    expect(await at("evil.example", "https://evil.example")).toBe(403);
    expect(await at("admin.example.org:8443", "https://admin.example.org")).toBe(403);
  });
});

describe("OCULUS_ORIGINS", () => {
  it("is required", async () => {
    expect(() => originsFromEnv({})).toThrow(ORIGINS_ENV);
    await expect(buildServer({ env: {} })).rejects.toThrow(ORIGINS_ENV);
  });

  it.each([
    "http://archive.example.org",
    "https://archive.example.org/",
    "https://archive.example.org/admin",
    "https://ARCHIVE.example.org",
    "https://user@archive.example.org",
    "archive.example.org",
    "*",
    "null",
    "https://a.example.org,",
  ])("refuses %j", (value) => {
    expect(() => originsFromEnv({ [ORIGINS_ENV]: value })).toThrow(ORIGINS_ENV);
  });

  it("reads a list", () => {
    expect([
      ...originsFromEnv({ [ORIGINS_ENV]: "https://a.example.org, http://localhost:3000" }),
    ]).toEqual(["https://a.example.org", "http://localhost:3000"]);
  });
});
