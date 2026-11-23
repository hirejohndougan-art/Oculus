// Attack tests for D-051 rule 4: cookies read only for Oculus's names,
// duplicates refused, one __Host- writer.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import {
  MAX_COOKIE_AGE_SECONDS,
  OCULUS_COOKIES,
  cookieHeaderProblem,
  readOculusCookie,
  replyCookieProblem,
  setCookieProblem,
  setOculusCookie,
  type OculusCookieName,
} from "./cookies.js";
import type { OculusReply, OculusRoute } from "./routes.js";
import { SAME_ORIGIN, testServer } from "./test-server.fixtures.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const SESSION = OCULUS_COOKIES.session;

async function whoami(cookie: string | undefined) {
  const built = await testServer();
  app = built.app;
  const res = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: cookie === undefined ? {} : { cookie },
  });
  return { res, calls: built.calls };
}

describe("reading cookies", () => {
  it("reads the Oculus session cookie and nothing else", async () => {
    const { res } = await whoami(`theme=dark; ${SESSION}=tok_EN-123; tracker=abc`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: string | null; cookieNames: string[] }>();
    expect(body.session).toBe("tok_EN-123");
    // No cookie plugin: the handler's request holds the Oculus cookie only.
    expect(body.cookieNames).toEqual([SESSION]);
  });

  it.each([
    `${SESSION}=a; ${SESSION}=b`,
    `${SESSION}=a;${SESSION}=a`,
    `${SESSION}=a; __host-oculus_session=b`,
    `__HOST-OCULUS_SESSION=b; ${SESSION}=a`,
  ])("refuses a request that sends an Oculus cookie twice: %s", async (cookie) => {
    const { res, calls } = await whoami(cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "duplicate_cookie" });
    expect(calls.count).toBe(0);
  });

  it("refuses duplicates split over two Cookie headers", () => {
    // Node joins repeated Cookie headers with "; " before Fastify sees them.
    expect(cookieHeaderProblem(`${SESSION}=a; ${SESSION}=b`)).toBeDefined();
    expect(cookieHeaderProblem("a=1; a=2")).toBeUndefined();
  });

  it.each([
    "oculus_session=tok",
    "__Secure-oculus_session=tok",
    "__host-oculus_session=tok",
    ` ${SESSION}x=tok`,
  ])("ignores lookalike names: %s", async (cookie) => {
    const { res } = await whoami(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ session: unknown }>().session).toBeNull();
  });

  it.each([
    `${SESSION}="tok"`,
    `${SESSION}=a%20b`,
    `${SESSION}=a.b`,
    `${SESSION}=`,
    `${SESSION}=${"a".repeat(513)}`,
  ])("reads a malformed value as absent: %s", async (cookie) => {
    const { res } = await whoami(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ session: unknown }>().session).toBeNull();
  });
});

describe("writing cookies", () => {
  it("writes __Host- cookies with Secure, HttpOnly, SameSite, Path=/ and no Domain", async () => {
    const built = await testServer();
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/session", headers: SAME_ORIGIN });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers["set-cookie"]);
    expect(header.startsWith(`${SESSION}=abcDEF123_-;`)).toBe(true);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).toMatch(/; Max-Age=3600/);
    expect(header).not.toMatch(/Domain/i);
    expect(setCookieProblem(header)).toBeUndefined();
  });

  it("refuses names, values and headers outside the rules", async () => {
    const route = (path: string, act: (reply: OculusReply) => void): OculusRoute => ({
      method: "GET",
      path,
      handler: (_q, reply) => {
        act(reply);
        return { leaked: "no" };
      },
    });
    const built = await testServer({}, [
      route("/bad-name", (r) => r.setCookie("tracker" as OculusCookieName, "x")),
      route("/bad-value", (r) => r.setCookie(SESSION, "x; Domain=evil.example")),
      // Not a string, though it turns into a good one: refused before any check.
      route("/object-value", (r) =>
        r.setCookie(SESSION, { toString: () => "abcDEF123" } as unknown as string),
      ),
      route("/boxed-value", (r) =>
        r.setCookie(SESSION, new String("abcDEF123") as unknown as string),
      ),
      route("/raw-header", (r) => r.header("Set-Cookie", `${SESSION}=x; Path=/`)),
      route("/raw-header-case", (r) => r.header("sEt-CoOkIe", "tracker=1")),
      route("/hijack", (r) => {
        (r as unknown as { hijack: () => void }).hijack();
      }),
      route("/raw", (r) => {
        (r as unknown as { raw: { setHeader: (n: string, v: string) => void } }).raw.setHeader(
          "set-cookie",
          "tracker=1",
        );
      }),
      route("/plugin-writer", (r) => {
        (r as unknown as { setCookie: (n: string, v: string, o: object) => void }).setCookie(
          "tracker",
          "1",
          {},
        );
      }),
    ]);
    app = built.app;
    for (const url of [
      "/bad-name",
      "/bad-value",
      "/object-value",
      "/boxed-value",
      "/raw-header",
      "/raw-header-case",
      "/hijack",
      "/raw",
      "/plugin-writer",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(500);
      expect(res.json(), url).toEqual({ error: "internal_error" });
      expect(res.headers["set-cookie"], url).toBeUndefined();
    }
  });

  it("reads a Cookie header only when it is a string", () => {
    const header = [`${SESSION}=abc`, `${SESSION}=def`] as unknown as string;
    expect(cookieHeaderProblem(header)).toBeUndefined();
    expect(readOculusCookie(header, SESSION)).toBeUndefined();
    expect(
      readOculusCookie({ toString: () => `${SESSION}=abc` } as unknown as string, SESSION),
    ).toBe(undefined);
  });

  it("can't change the server from a handler after start", async () => {
    // Handlers get no `server` (routes.ts); a handler that goes looking for
    // one fails, and the server's parsers and error handler are unchanged.
    interface Tamper {
      server: { addContentTypeParser: () => void; setErrorHandler: () => void };
    }
    const built = await testServer({}, [
      {
        method: "GET",
        path: "/tamper",
        handler: (request) => {
          (request as unknown as Tamper).server.addContentTypeParser();
          return {};
        },
      },
      {
        method: "GET",
        path: "/tamper-errors",
        handler: (request) => {
          (request as unknown as Tamper).server.setErrorHandler();
          return {};
        },
      },
    ]);
    app = built.app;
    for (const url of ["/tamper", "/tamper-errors"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(500);
      expect(res.json<object>(), url).toEqual({ error: "internal_error" });
    }
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { ...SAME_ORIGIN, "content-type": "text/plain" },
      payload: "x",
    });
    expect(res.statusCode).toBe(415);
    expect("parseCookie" in app).toBe(false);
  });

  it("refuses at start a route that carries options beyond the narrow API", async () => {
    for (const extra of [
      { errorHandler: () => "leak" },
      { handlerTimeout: 600_000 },
      { onSend: () => undefined },
      { schema: {} },
    ]) {
      const route = {
        method: "GET",
        path: "/x",
        handler: () => ({}),
        ...extra,
      } as unknown as OculusRoute;
      await expect(testServer({}, [route])).rejects.toThrow(/route option not allowed/);
    }
  });

  it("uses the same Max-Age limit in the writer and in the check before sending", () => {
    for (const seconds of [
      0,
      3600,
      MAX_COOKIE_AGE_SECONDS,
      MAX_COOKIE_AGE_SECONDS + 1,
      9_999_999_999,
      100_000_000_000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const reply = { header: () => reply } as unknown as FastifyReply;
      const header = `${SESSION}=a; Max-Age=${String(seconds)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
      const checkAccepts = setCookieProblem(header) === undefined;
      let writerAccepts = true;
      try {
        setOculusCookie(reply, SESSION, "a", { maxAgeSeconds: seconds });
      } catch {
        writerAccepts = false;
      }
      expect(writerAccepts, String(seconds)).toBe(checkAccepts);
      expect(checkAccepts, String(seconds)).toBe(seconds <= MAX_COOKIE_AGE_SECONDS);
    }
  });

  it("sends only cookies the writer issued for that reply", () => {
    const reply = { header: () => reply } as unknown as FastifyReply;
    const good = `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax`;
    expect(replyCookieProblem(reply, good)).toBe("not written by the cookie writer");
    setOculusCookie(reply, SESSION, "a");
    expect(replyCookieProblem(reply, good)).toBeUndefined();
    expect(replyCookieProblem(reply, [good, "tracker=1"])).toBe("not written by the cookie writer");
    expect(replyCookieProblem(reply, undefined)).toBeUndefined();
  });

  it("checks each Set-Cookie value the way browsers read it", () => {
    const good = `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Strict`;
    expect(setCookieProblem(good)).toBeUndefined();
    expect(
      setCookieProblem(`${SESSION}=a;path=/;httponly;SECURE;samesite=lax;max-age=10`),
    ).toBeUndefined();
    expect(
      setCookieProblem(`${SESSION}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`),
    ).toBeUndefined();
    const bad = [
      `${SESSION}=a; Path=/; HttpOnly; SameSite=Lax`,
      `${SESSION}=a; Path=/; Secure; SameSite=Lax`,
      `${SESSION}=a; Path=/admin; HttpOnly; Secure; SameSite=Lax`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=None`,
      `${SESSION}=a; Path=/; HttpOnly; Secure`,
      `${SESSION}=a; Path=/; Path=/x; HttpOnly; Secure; SameSite=Lax`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; SameSite=None`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=None; SameSite=Lax`,
      `${SESSION}=a; Path=/; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; Secure; SameSite=Lax`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=10; max-age=99999`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; samesite=none`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=example.org`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax;  DOMAIN = example.org`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; Partitioned`,
      `${SESSION}=a; Path=/; HttpOnly; Secure=no; SameSite=Lax`,
      `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=-1`,
      `${SESSION}=a b; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `oculus_session=a; Path=/; HttpOnly; Secure; SameSite=Lax`,
      SESSION,
    ];
    for (const value of bad) expect(setCookieProblem(value), value).toBeDefined();
  });
});
