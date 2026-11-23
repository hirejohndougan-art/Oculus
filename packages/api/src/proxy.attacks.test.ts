// Attack tests for D-051 rule 6: trustProxy only when OCULUS_TRUSTED_PROXY names the proxy.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { TRUSTED_PROXY_ENV, trustedProxyFromEnv } from "./proxy.js";
import { testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const FORWARDED = {
  "x-forwarded-for": "203.0.113.9",
  "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "https",
};

interface Who {
  ip: string;
  host: string;
  protocol: string;
}

describe("trustProxy", () => {
  it("ignores X-Forwarded-* when no proxy is named", async () => {
    const built = await testServer({ env: {} });
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: FORWARDED,
      remoteAddress: "10.0.0.5",
    });
    const who = res.json<Who>();
    expect(who.ip).toBe("10.0.0.5");
    expect(who.host).toBe("localhost:80");
    expect(who.protocol).toBe("http");
  });

  it("ignores X-Forwarded-* from a sender that isn't the named proxy", async () => {
    const built = await testServer({ env: { [TRUSTED_PROXY_ENV]: "10.0.0.1" } });
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: FORWARDED,
      remoteAddress: "10.0.0.5",
    });
    expect(res.json<Who>().ip).toBe("10.0.0.5");
    expect(res.json<Who>().host).toBe("localhost:80");
  });

  it("uses X-Forwarded-* from the named proxy", async () => {
    const built = await testServer({ env: { [TRUSTED_PROXY_ENV]: "10.0.0.0/24, ::1" } });
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { ...FORWARDED, "x-forwarded-host": "archive.example.org" },
      remoteAddress: "10.0.0.5",
    });
    const who = res.json<Who>();
    expect(who.ip).toBe("203.0.113.9");
    expect(who.host).toBe("archive.example.org");
    expect(who.protocol).toBe("https");
  });

  it("takes the client address nearest the proxy, not one the client wrote first", async () => {
    const built = await testServer({ env: { [TRUSTED_PROXY_ENV]: "10.0.0.1" } });
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.7" },
      remoteAddress: "10.0.0.1",
    });
    expect(res.json<Who>().ip).toBe("198.51.100.7");
  });

  it.each([
    "true",
    "*",
    "1",
    "2",
    "all",
    "proxy.example.org",
    "10.0.0.0/33",
    "10.0.0.1/",
    "10.0.0.1,",
    "::1/129",
    "uniquelocal",
    "0.0.0.0/0",
    "8.0.0.0/8",
    "1.2.0.0/15",
    "::/0",
    "2001:db8::/16",
    "10.0.0.0/7",
    "fc00::/6",
  ])("refuses to start with %j", async (value) => {
    expect(() => trustedProxyFromEnv({ [TRUSTED_PROXY_ENV]: value })).toThrow(TRUSTED_PROXY_ENV);
    await expect(testServer({ env: { [TRUSTED_PROXY_ENV]: value } })).rejects.toThrow(
      TRUSTED_PROXY_ENV,
    );
  });

  it("allows narrow public ranges and private blocks", () => {
    for (const value of [
      "203.0.113.0/24",
      "198.51.0.0/16",
      "2001:db8::/32",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "127.0.0.0/8",
      "fd00::/8",
      "::1/128",
    ]) {
      expect(trustedProxyFromEnv({ [TRUSTED_PROXY_ENV]: value }), value).toEqual([value]);
    }
  });

  it("reads unset and blank as off", () => {
    expect(trustedProxyFromEnv({})).toBe(false);
    expect(trustedProxyFromEnv({ [TRUSTED_PROXY_ENV]: "  " })).toBe(false);
    expect(trustedProxyFromEnv({ [TRUSTED_PROXY_ENV]: "loopback, 192.168.1.10" })).toEqual([
      "loopback",
      "192.168.1.10",
    ]);
  });
});
