// Attack tests for D-051 rule 4: cookies read only for Oculus's names,
// duplicates refused, one __Host- writer.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  OCULUS_COOKIES,
  cookieHeaderProblem,
  setCookieProblem,
  setOculusCookie,
  type OculusCookieName,
} from "./cookies.js";
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
    const body = res.json<{ session: string | null; cookies: unknown }>();
    expect(body.session).toBe("tok_EN-123");
    // @fastify/cookie's parsing hook is off: request.cookies is never filled.
    expect(body.cookies).toBeNull();
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

  it("refuses names and values outside the rules", async () => {
    const built = await testServer({}, (r) => {
      r.post("/bad-name", (_q, reply) => {
        setOculusCookie(reply, "tracker" as OculusCookieName, "x");
        return {};
      });
      r.post("/bad-value", (_q, reply) => {
        setOculusCookie(reply, SESSION, "x; Domain=evil.example");
        return {};
      });
    });
    app = built.app;
    for (const url of ["/bad-name", "/bad-value"]) {
      const res = await app.inject({ method: "POST", url, headers: SAME_ORIGIN });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal_error" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("strips any cookie written around the helper and fails the reply", async () => {
    const built = await testServer({}, (r) => {
      r.get("/raw-header", (_q, reply) => {
        void reply.header("set-cookie", `${SESSION}=x; Path=/`);
        return { leaked: "no" };
      });
      r.get("/plugin-writer", (_q, reply) => {
        void reply.setCookie("tracker", "1", { path: "/" });
        return { leaked: "no" };
      });
      r.get("/domain", (_q, reply) => {
        void reply.setCookie(SESSION, "x", {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          domain: "example.org",
        });
        return { leaked: "no" };
      });
      r.get("/mixed", (_q, reply) => {
        setOculusCookie(reply, SESSION, "good");
        void reply.setCookie("tracker", "1");
        return { leaked: "no" };
      });
    });
    app = built.app;
    for (const url of ["/raw-header", "/plugin-writer", "/domain", "/mixed"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(500);
      expect(res.headers["set-cookie"], url).toBeUndefined();
      expect(res.body).not.toContain("leaked");
    }
  });

  it("checks each Set-Cookie value", () => {
    const good = `${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=Strict`;
    expect(setCookieProblem(good)).toBeUndefined();
    expect(setCookieProblem(`${SESSION}=a; Path=/; HttpOnly; SameSite=Lax`)).toBe("missing Secure");
    expect(setCookieProblem(`${SESSION}=a; Path=/; Secure; SameSite=Lax`)).toBe("missing HttpOnly");
    expect(setCookieProblem(`${SESSION}=a; Path=/admin; HttpOnly; Secure; SameSite=Lax`)).toBe(
      "missing Path=/",
    );
    expect(setCookieProblem(`${SESSION}=a; Path=/; HttpOnly; Secure; SameSite=None`)).toBe(
      "missing SameSite",
    );
    expect(setCookieProblem(`${SESSION}=a; Path=/; Path=/x; HttpOnly; Secure; SameSite=Lax`)).toBe(
      "second Path",
    );
    expect(setCookieProblem(`oculus_session=a; Path=/; HttpOnly; Secure; SameSite=Lax`)).toBe(
      "not an Oculus cookie",
    );
  });
});
