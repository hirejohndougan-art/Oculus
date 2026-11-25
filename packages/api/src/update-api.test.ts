// Software updates over HTTP (T-060, D-092), against a fresh migrated
// database and a throwaway updates folder (release scripts stubbed): only
// system managers reach any route; installing and rolling back need a
// fresh password-and-code entry; the session, CSRF and Origin rules hold;
// parts are strict base64 of the fixed size; and a whole update goes
// through: upload in parts, check, install, roll back. When updates aren't
// set up, the status says so and every change answers 503. Every person and
// address is invented (example.org, RFC 2606).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "@oculus/core";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";
import {
  fullSession,
  makeWorld,
  pendingSession,
  staleReauth,
  type World,
} from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";
import { decodePart } from "./update-api.js";
import { UPLOAD_PART_BYTES, UpdateManager, type RunScript } from "./update-manager.js";
import { tempDir, testKey, testPackage, writeTemp, type TestKey } from "./update.fixtures.js";
import { Refusal } from "./errors.js";

let w: World;
let app: FastifyInstance;
let off: FastifyInstance;
let home: string;
let scratch: string;
let key: TestKey;
let manager: UpdateManager;
const logged: ApiLogRecord[] = [];
const tokens: Record<string, string> = {};
const sessionIds: Record<string, string> = {};
const runScript: RunScript = () => Promise.resolve({ code: 0, output: "" });

beforeAll(async () => {
  w = await makeWorld({ onError: serviceErrorLogger((r) => logged.push(r)) });
  home = await tempDir("update-api");
  scratch = await tempDir("update-api-scratch");
  key = testKey();
  // 0.1.0 installed and running from the updates folder.
  const first = new UpdateManager({
    home,
    keys: key.trusted,
    runScript,
    runningRoot: join(home, "current"),
  });
  await first.verifyInto(await writeTemp(scratch, "first.zip", testPackage(key, "0.1.0")));
  await first.install("0.1.0", "release-cli", undefined, {
    requireRunningFromCurrent: false,
    fallbackUrl: "postgresql://owner@db.example.org/invented",
  });
  manager = new UpdateManager({
    home,
    keys: key.trusted,
    runScript,
    runningRoot: join(home, "current"),
  });
  const routes = (updates: { manager: UpdateManager | undefined; runningRoot?: string }) =>
    staffApiRoutes({ db: w.db, service: w.service, log: (r) => logged.push(r), updates });
  app = await buildServer({ env: TEST_ENV, routes: routes({ manager }) });
  off = await buildServer({
    env: TEST_ENV,
    routes: routes({ manager: undefined, runningRoot: scratch }),
  });
  const make = async (name: string, user: (typeof w)["root"]) => {
    const s = await fullSession(w.db, user, w.a);
    tokens[name] = s.token;
    sessionIds[name] = s.sessionId;
  };
  await make("root", w.root);
  await make("stale", w.root);
  await staleReauth(w.db, sessionIds.stale ?? "", 11 * 60);
  await make("manager", w.manager);
  await make("cataloger", w.cataloger);
  tokens.pending = (await pendingSession(w.db, w.root, w.a)).token;
}, 180_000);

afterAll(async () => {
  await app.close();
  await off.close();
  await w.db.close();
  await w.testDb.drop();
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

interface Call {
  as?: string;
  body?: unknown;
  csrf?: boolean;
  origin?: string | null;
  server?: FastifyInstance;
}

async function call(method: string, url: string, c: Call = {}) {
  const token = c.as === undefined ? undefined : tokens[c.as];
  const headers: Record<string, string> = {};
  if (c.origin !== null) headers.origin = c.origin ?? SAME_ORIGIN.origin;
  if (token !== undefined) headers.cookie = `${OCULUS_COOKIES.session}=${token}`;
  if ((c.csrf ?? method !== "GET") && token !== undefined)
    headers[CSRF_HEADER] = csrfTokenFor(token) ?? "";
  let payload: string | undefined;
  if (c.body !== undefined) {
    payload = JSON.stringify(c.body);
    headers["content-type"] = "application/json";
  }
  const res = await (c.server ?? app).inject({
    method: method as "GET",
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  return { status: res.statusCode, json };
}

/** Sends a whole package over HTTP and waits for the check. */
async function send(bytes: Buffer, as = "root") {
  const started = await call("POST", "/api/system/update/uploads", {
    as,
    body: { size: bytes.length },
  });
  expect(started.status).toBe(201);
  const id = started.json.uploadId as string;
  for (let i = 0, part = 0; i < bytes.length; i += UPLOAD_PART_BYTES, part++) {
    const r = await call("PUT", `/api/system/update/uploads/${id}/parts/${String(part)}`, {
      as,
      body: { data: bytes.subarray(i, i + UPLOAD_PART_BYTES).toString("base64") },
    });
    expect(r.status).toBe(200);
  }
  const done = await call("POST", `/api/system/update/uploads/${id}/finish`, { as });
  expect(done.status).toBe(202);
  await manager.idle();
  return (await call("GET", "/api/system/update", { as })).json;
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/system/update"],
  ["POST", "/api/system/update/uploads", { size: 100 }],
  ["PUT", `/api/system/update/uploads/${"a".repeat(32)}/parts/0`, { data: "AAAA" }],
  ["POST", `/api/system/update/uploads/${"a".repeat(32)}/finish`],
  ["DELETE", `/api/system/update/uploads/${"a".repeat(32)}`],
  ["DELETE", "/api/system/update/pending"],
  ["POST", "/api/system/update/install", { version: "9.9.9" }],
  ["POST", "/api/system/update/rollback", { version: "0.0.1" }],
];

describe("who may", () => {
  it.each(ROUTES)(
    "%s %s: 401 without a session or with a waiting one",
    async (method, url, body) => {
      expect((await call(method, url, { body })).status).toBe(401);
      expect((await call(method, url, { as: "pending", body })).status).toBe(401);
    },
  );

  it.each(ROUTES)("%s %s: 403 for a site manager and a cataloger", async (method, url, body) => {
    for (const as of ["manager", "cataloger"]) {
      const r = await call(method, url, { as, body });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("not_permitted");
    }
  });

  it.each(ROUTES.filter(([m]) => m !== "GET"))(
    "%s %s: 403 without CSRF or Origin",
    async (method, url, body) => {
      expect((await call(method, url, { as: "root", body, csrf: false })).json.error).toBe(
        "csrf_failed",
      );
      expect(
        (await call(method, url, { as: "root", body, origin: "https://evil.example.org" })).status,
      ).toBe(403);
    },
  );

  it("installing and rolling back need a fresh entry", async () => {
    for (const path of ["install", "rollback"]) {
      const r = await call("POST", `/api/system/update/${path}`, {
        as: "stale",
        body: { version: "0.2.0" },
      });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("reauthentication_required");
    }
    // Uploading doesn't: the package still has to be checked and installed.
    expect((await call("GET", "/api/system/update", { as: "stale" })).status).toBe(200);
  });
});

describe("the status", () => {
  it("shows the running version and the setup to system managers", async () => {
    const r = await call("GET", "/api/system/update", { as: "root" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      configured: true,
      runningVersion: "0.1.0",
      runningFromCurrent: true,
      restart: "none",
      partBytes: UPLOAD_PART_BYTES,
    });
  });

  it("says when updates aren't set up, and refuses every change", async () => {
    const r = await call("GET", "/api/system/update", { as: "root", server: off });
    expect(r.json).toMatchObject({ configured: false, runningVersion: null });
    expect(r.json.variables).toContain("OCULUS_UPDATE_DIR");
    const change = await call("POST", "/api/system/update/uploads", {
      as: "root",
      body: { size: 100 },
      server: off,
    });
    expect(change.status).toBe(503);
    expect(change.json.error).toBe("updates_not_configured");
  });
});

describe("bodies and parts", () => {
  it("refuses extra keys", async () => {
    const r = await call("POST", "/api/system/update/uploads", {
      as: "root",
      body: { size: 100, path: "/etc" },
    });
    expect(r.status).toBe(422);
  });

  it("refuses a bad part number as not found", async () => {
    const { json } = await call("POST", "/api/system/update/uploads", {
      as: "root",
      body: { size: 100 },
    });
    const id = json.uploadId as string;
    for (const n of ["-1", "01", "x", "1e3"]) {
      expect(
        (
          await call("PUT", `/api/system/update/uploads/${id}/parts/${n}`, {
            as: "root",
            body: { data: "AAAA" },
          })
        ).status,
      ).toBe(404);
    }
    expect((await call("DELETE", `/api/system/update/uploads/${id}`, { as: "root" })).status).toBe(
      200,
    );
  });

  it("decodes only strict, canonical base64 within the part size", () => {
    expect(decodePart("aGk=", 10).toString()).toBe("hi");
    for (const bad of ["aGk", "aG k=", "aGl=", "a===", 12, "####"]) {
      expect(() => decodePart(bad, 10)).toThrow(Refusal);
    }
    expect(() => decodePart(Buffer.alloc(11).toString("base64"), 10)).toThrow(Refusal);
  });
});

describe("a whole update", () => {
  it("uploads, checks, installs and rolls back", async () => {
    const status = await send(testPackage(key, "0.2.0", ["0001_start.sql"], "Invented fixes."));
    expect(status.job).toMatchObject({ kind: "verify", state: "done" });
    expect(status.pending).toMatchObject({
      version: "0.2.0",
      notes: "Invented fixes.",
      keyId: key.keyId,
    });

    const installed = await call("POST", "/api/system/update/install", {
      as: "root",
      body: { version: "0.2.0" },
    });
    expect(installed.status).toBe(202);
    await manager.idle();
    const after = (await call("GET", "/api/system/update", { as: "root" })).json;
    expect(after).toMatchObject({
      restartNeeded: true,
      pending: null,
      rollback: { version: "0.1.0", allowed: true },
    });
    expect((after.history as { by: string }[])[0]?.by).toBe(w.root);

    const back = await call("POST", "/api/system/update/rollback", {
      as: "root",
      body: { version: "0.1.0" },
    });
    expect(back.status).toBe(202);
    await manager.idle();
    expect((await call("GET", "/api/system/update", { as: "root" })).json.job).toMatchObject({
      kind: "rollback",
      state: "done",
    });
  });

  it("reports a refused package with its code", async () => {
    const status = await send(testPackage(testKey(), "0.3.0"));
    expect(status.job).toMatchObject({ state: "failed", error: "unknown_key" });
  });

  it("answers fixed codes for the manager's refusals", async () => {
    const r = await call("POST", "/api/system/update/install", {
      as: "root",
      body: { version: "not a version" },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("invalid_version");
    const unknown = await call("POST", `/api/system/update/uploads/${"b".repeat(32)}/finish`, {
      as: "root",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("unknown_upload");
  });
});
