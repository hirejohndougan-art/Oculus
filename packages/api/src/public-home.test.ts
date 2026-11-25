// The public home page until Phase 4 (T-070, D-109): `GET /` on a public
// host answers one fixed page with the site's name and "This public site is
// being built", nothing else; never on the admin's host or an unlisted one,
// never for another method or path; the name is escaped, and the page's CSP
// allows its one inline style by hash and nothing else. Every name is invented.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { SECURITY_HEADERS } from "./headers.js";
import {
  PUBLIC_HOME_SECURITY_HEADERS,
  escapeHtml,
  publicHomePage,
  publicHomePages,
} from "./public-home.js";
import { buildServer } from "./server.js";

const ADMIN = "http://127.0.0.1:4780";
const ARCHIVE = "http://localhost:4781";
const LIBRARY = "http://localhost:4782";
const ORIGINS = [ADMIN, ARCHIVE, LIBRARY].join(",");

let dir: string;
let files: AdminFiles;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oculus-t070-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus admin</title>");
  mkdirSync(join(dir, "assets"));
  files = loadAdminFiles(dir);
  app = await buildServer({
    env: { OCULUS_ORIGINS: ORIGINS },
    admin: { origin: ADMIN, files },
    publicHomes: [
      { origin: ARCHIVE, siteName: 'Invented <Archive> & "Friends"' },
      { origin: LIBRARY, siteName: "Invented Library" },
    ],
    routes: [{ method: "GET", path: "/records/:id", handler: () => ({ record: true }) }],
  });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const at = (host: string, url = "/", method: "GET" | "HEAD" | "POST" = "GET") =>
  app.inject({
    method,
    url,
    headers: {
      host,
      ...(method === "POST"
        ? { origin: `http://${host}`, "content-type": "application/json" }
        : {}),
    },
    ...(method === "POST" ? { payload: "{}" } : {}),
  });

describe("the page", () => {
  it("says the site's name and that the site is being built, escaped, and nothing else", () => {
    const page = publicHomePage("Invented <script>alert(1)</script> & 'Co'");
    expect(page).toContain(
      "<h1>Invented &lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;Co&#39;</h1>",
    );
    expect(page).toContain("<p>This public site is being built.</p>");
    expect(page).not.toContain("<script");
    expect(page).not.toMatch(/<a |<form|<img|<link|src=|href=/);
    expect(publicHomePage("  ")).toContain("<h1>This site</h1>");
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("allows its one inline style by hash, and keeps the API's other headers", () => {
    const page = publicHomePage("Invented Archive");
    const style = /<style>(.*)<\/style>/.exec(page)?.[1] ?? "";
    const hash = createHash("sha256").update(style, "utf8").digest("base64");
    expect(PUBLIC_HOME_SECURITY_HEADERS["content-security-policy"]).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    );
    for (const name of ["x-content-type-options", "referrer-policy", "cache-control"]) {
      expect(PUBLIC_HOME_SECURITY_HEADERS[name]).toBe(SECURITY_HEADERS[name]);
    }
  });

  it("keeps the first page of an origin listed twice", () => {
    const pages = publicHomePages([
      { origin: ARCHIVE, siteName: "First" },
      { origin: ARCHIVE, siteName: "Second" },
    ]);
    expect(pages.get(ARCHIVE)).toContain("<h1>First</h1>");
  });
});

describe("GET / on a public host", () => {
  it("answers the site's page with the page's headers", async () => {
    const reply = await at("localhost:4781");
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.body).toContain("<h1>Invented &lt;Archive&gt; &amp; &quot;Friends&quot;</h1>");
    expect(reply.headers["content-security-policy"]).toBe(
      PUBLIC_HOME_SECURITY_HEADERS["content-security-policy"],
    );
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["set-cookie"]).toBeUndefined();
    const other = await at("localhost:4782", "/?from=admin");
    expect(other.body).toContain("<h1>Invented Library</h1>");
    const head = await at("localhost:4781", "/", "HEAD");
    expect([head.statusCode, head.body]).toEqual([200, ""]);
  });

  it("is never the page anywhere else", async () => {
    const unknown = await at("localhost:4781", "/no-such-path");
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: "not_found" }]);
    expect(unknown.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
    for (const [host, url] of [
      ["localhost:4781", "/index.html"],
      ["localhost:4781", "/assets/x.js"],
      ["localhost:9999", "/"],
      ["evil.example.com", "/"],
      ["localhost", "/"],
    ] as const) {
      const reply = await at(host, url);
      expect([host, url, reply.statusCode, reply.body]).toEqual([host, url, 404, unknown.body]);
    }
    // Other methods: the router's own answer, never the page.
    const posted = await at("localhost:4781", "/", "POST");
    expect(posted.statusCode).toBe(404);
    expect(posted.body).not.toContain("being built");
    // The admin's host keeps the admin.
    const admin = await at("127.0.0.1:4780");
    expect(admin.body).toContain("Oculus admin");
    // Routes still answer on the public host.
    expect((await at("localhost:4781", "/records/x")).json()).toEqual({ record: true });
  });

  it("refuses a page for an unlisted origin or on the admin's host", async () => {
    await expect(
      buildServer({
        env: { OCULUS_ORIGINS: ORIGINS },
        publicHomes: [{ origin: "http://localhost:5555", siteName: "Invented" }],
      }),
    ).rejects.toThrow(/one of OCULUS_ORIGINS/);
    await expect(
      buildServer({
        env: { OCULUS_ORIGINS: `${ORIGINS},http://127.0.0.1:4790` },
        admin: { origin: ADMIN, files },
        publicHomes: [{ origin: "http://127.0.0.1:4790", siteName: "Invented" }],
      }),
    ).rejects.toThrow(/admin's host/);
  });
});
