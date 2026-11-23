// Attack tests for D-051 rule 3: path refusals and 404/405 before any handler.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { RouteTable, pathProblem } from "./paths.js";
import { SAME_ORIGIN, rawRequest, testServer } from "./test-server.fixtures.js";

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

describe("path refusals (400 before any handler)", () => {
  it.each([
    "/items/a%2Fb",
    "/items/a%2fb",
    "/files/a%2F..%2Fsecret",
    "/items/a%5Cb",
    "/items/a\\b",
    "/files/..",
    "/files/a/../b",
    "/files/./a",
    "/items/%2e%2e",
    "/items/%2E%2e",
    "/items/.%2e",
    "/items/a%00",
    "/items/a%252Fb",
    "/items/a%252e%252e",
    "/items//1",
    "//items/1",
    "/items/%ff",
    "/items/%zz",
    "/items/%",
    "/item%73/1",
    "/items/%31",
    "/%68ealth",
    "/items/a%7Eb",
  ])("refuses %s, sent raw over a socket", async (url) => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const res = await rawRequest(app, "GET", url);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringMatching(/^bad_/) as unknown,
    });
    expect(calls.count).toBe(0);
  });

  it("refuses the same tricks on unknown routes and on POSTs", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    for (const url of [
      "/nowhere/..",
      "/no%2Fwhere",
      "/echo/..",
      "/echo/.%2E",
      "/echo%00",
      "/x/..\\echo",
    ]) {
      const res = await rawRequest(
        app,
        "POST",
        url,
        { ...SAME_ORIGIN, "content-type": "application/json" },
        "{}",
      );
      expect(res.status, url).toBe(400);
    }
    expect(calls.count).toBe(0);
  });

  it("refuses targets that aren't a plain path", () => {
    expect(pathProblem(undefined)).toBeDefined();
    expect(pathProblem("*")).toBeDefined();
    expect(pathProblem("http://evil.example/items/1")).toBeDefined();
    expect(pathProblem("items/1")).toBeDefined();
    expect(pathProblem("/items/a\u0001b")).toBeDefined();
    expect(pathProblem("/items/a\u007fb")).toBeDefined();
  });

  it("accepts ordinary paths, encoded spaces and query strings with dots", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const one = await app.inject({ method: "GET", url: "/items/DS5C740001?x=../..%2F" });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({ params: { id: "DS5C740001" } });
    const spaced = await app.inject({ method: "GET", url: "/files/Box%201/letter.v2.pdf" });
    expect(spaced.statusCode).toBe(200);
    expect(spaced.json()).toEqual({ params: { "*": "Box 1/letter.v2.pdf" } });
    expect(calls.count).toBe(2);
    expect(pathProblem("/files/a..b")).toBeUndefined();
    expect(pathProblem("/items/")).toBeUndefined();
    expect(pathProblem("/files/caf%C3%A9%20%21")).toBeUndefined();
  });

  it("doesn't treat ; as a delimiter, ignore case or trailing slashes", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const semi = await app.inject({ method: "GET", url: "/items/1;admin=true" });
    expect(semi.json()).toEqual({ params: { id: "1;admin=true" } });
    expect((await app.inject({ method: "GET", url: "/ITEMS/1" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health/" })).statusCode).toBe(404);
    expect(calls.count).toBe(1);
  });
});

describe("404 and 405", () => {
  it("answers unknown paths with 404 and no handler", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const res = await app.inject({ method: "GET", url: "/admin/secret" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    const raw = await rawRequest(app, "GET", "/items");
    expect(raw.status).toBe(404);
    expect(calls.count).toBe(0);
  });

  it("answers a known path with the wrong method with 405 and Allow", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const del = await app.inject({ method: "DELETE", url: "/items/7", headers: SAME_ORIGIN });
    const rawPatch = await rawRequest(app, "PATCH", "/items/7", SAME_ORIGIN);
    expect(rawPatch.status).toBe(405);
    expect(del.statusCode).toBe(405);
    expect(del.headers.allow).toBe("GET, HEAD");
    expect(del.json()).toEqual({ error: "method_not_allowed" });
    const get = await app.inject({ method: "GET", url: "/echo" });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
    const wild = await app.inject({ method: "PUT", url: "/files/a/b", headers: SAME_ORIGIN });
    expect(wild.statusCode).toBe(405);
    expect(calls.count).toBe(0);
  });

  it("serves HEAD for GET routes", async () => {
    await setup();
    if (app === undefined) throw new Error("no app");
    expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
  });

  it("refuses router syntax the 405 table can't match exactly", () => {
    const table = new RouteTable(100);
    expect(() => {
      table.add("GET", "/a/:id(^\\d+$)");
    }).toThrow();
    expect(() => {
      table.add("GET", "/a/:from-:to");
    }).toThrow();
    expect(() => {
      table.add("GET", "/a/*/b");
    }).toThrow();
    expect(() => {
      table.add("GET", "/a::b");
    }).toThrow();
    expect(() => {
      table.add("GET", "a");
    }).toThrow();
  });

  it("matches parameters and wildcards like the router", () => {
    const table = new RouteTable(5);
    table.add("GET", "/a/:id");
    table.add(["POST", "PUT"], "/a/new");
    table.add("DELETE", "/f/*");
    expect(table.allowedMethods("/a/new")).toEqual(["GET", "HEAD", "POST", "PUT"]);
    expect(table.allowedMethods("/a/xyz")).toEqual(["GET", "HEAD"]);
    expect(table.allowedMethods("/a/toolong")).toEqual([]);
    expect(table.allowedMethods("/a/")).toEqual([]);
    expect(table.allowedMethods("/a")).toEqual([]);
    expect(table.allowedMethods("/f")).toEqual([]);
    expect(table.allowedMethods("/f/")).toEqual(["DELETE"]);
    expect(table.allowedMethods("/f/x/y")).toEqual(["DELETE"]);
  });

  it("refuses an application route with unsupported syntax at start-up", async () => {
    await expect(
      testServer({}, [{ method: "GET", path: "/bad/:id(^\\d+$)", handler: () => ({}) }]),
    ).rejects.toThrow(/router syntax/);
  });

  it("treats an empty parameter as an unknown path, never reaching the handler", async () => {
    const { calls } = await setup();
    if (app === undefined) throw new Error("no app");
    const res = await app.inject({ method: "GET", url: "/items/" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(calls.count).toBe(0);
  });
});
