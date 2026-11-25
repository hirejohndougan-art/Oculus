// The admin's server (T-045, D-081): its startup refusals (no secret key, a
// client address that can't be told apart in production, no mail sender in
// production or the development one there (D-085), an admin origin outside
// OCULUS_ORIGINS), and the built admin served on the
// admin's origin only, with its own CSP while the API keeps its own.
import { startFakeClamd } from "../../service/src/clamd.fixtures.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, sql, type Database } from "@oculus/db";
import type { FastifyInstance } from "fastify";
import { FAKE_TEST_SECRET_KEY } from "../../db/src/second-factor.fixtures.js";
import { freshDatabase, type TestDatabase } from "../../db/src/test-database.fixtures.js";
import { migrate } from "@oculus/db";
import { STORE_MARKER } from "@oculus/service";
import { ADMIN_CSP, adminFileFor, loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { runAdminCli } from "./admin-cli.js";
import { buildAdminServer, clientAddressProblem, isProduction } from "./admin-server.js";
import { SECURITY_HEADERS } from "./headers.js";
import type { ApiLogRecord } from "./staff-api.js";

let testDb: TestDatabase;
let db: Database;
let dir: string;
let files: AdminFiles;

/** The files folder every server here uses (M-002, D-086). */
const filesDir = mkdtempSync(join(tmpdir(), "oculus-admin-files-"));

const DEV = {
  NODE_ENV: "development",
  OCULUS_ORIGINS: "http://localhost,http://127.0.0.1:3001",
  OCULUS_ADMIN_ORIGIN: "http://localhost",
  OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY,
  OCULUS_FILES_DIR: filesDir,
};

beforeAll(async () => {
  testDb = await freshDatabase();
  await migrate({ connectionString: testDb.url });
  db = openDatabase(testDb.url, { max: 2 });
  dir = mkdtempSync(join(tmpdir(), "oculus-admin-build-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Oculus</title>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "index-abc.css"), "body{}");
  writeFileSync(join(dir, "fonts", "a.woff2"), "font");
  files = loadAdminFiles(dir);
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
  await db.close();
  await testDb.drop();
});

describe("loadAdminFiles and adminFileFor", () => {
  it("reads the build into memory and answers screens with index.html", () => {
    expect([...files.keys()].sort()).toEqual([
      "/assets/index-abc.css",
      "/assets/index-abc.js",
      "/fonts/a.woff2",
      "/index.html",
    ]);
    expect(adminFileFor(files, "/assets/index-abc.js")?.type).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(adminFileFor(files, "/")?.type).toBe("text/html; charset=utf-8");
    expect(adminFileFor(files, "/sites/abc")?.type).toBe("text/html; charset=utf-8");
    expect(adminFileFor(files, "/reset")).toBe(files.get("/index.html"));
    expect(adminFileFor(files, "/assets/missing.js")).toBeUndefined();
    expect(adminFileFor(files, "/api/me")).toBeUndefined();
    expect(adminFileFor(files, "/api")).toBeUndefined();
    expect(adminFileFor(files, "/health")).toBeUndefined();
  });

  it("refuses a build without index.html, with an unknown type, a dot file or a link", () => {
    const dirs: string[] = [];
    const bad = (setup: (d: string) => void) => {
      const d = mkdtempSync(join(tmpdir(), "oculus-admin-bad-"));
      dirs.push(d);
      writeFileSync(join(d, "index.html"), "x");
      setup(d);
      return () => loadAdminFiles(d);
    };
    const empty = mkdtempSync(join(tmpdir(), "oculus-admin-empty-"));
    dirs.push(empty);
    expect(() => loadAdminFiles(empty)).toThrow(/index.html/);
    const svg = bad((d) => {
      writeFileSync(join(d, "x.svg"), "<svg/>");
    });
    expect(svg).toThrow(/no served type/);
    const dot = bad((d) => {
      writeFileSync(join(d, ".env"), "SECRET=1");
    });
    expect(dot).toThrow(/unsafe file name/);
    const link = bad((d) => {
      symlinkSync("/etc/hostname", join(d, "linked.txt"));
    });
    expect(link).toThrow(/symbolic links/);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});

describe("the startup checks", () => {
  it("treats anything but development and test as production", () => {
    expect(isProduction({})).toBe(true);
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "staging" })).toBe(true);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
    expect(isProduction({ NODE_ENV: "test" })).toBe(false);
  });

  it("needs a trusted proxy or a declared direct connection in production", () => {
    expect(clientAddressProblem({})).toMatch(/OCULUS_TRUSTED_PROXY/);
    expect(clientAddressProblem({ OCULUS_TRUSTED_PROXY: "loopback" })).toBeUndefined();
    expect(clientAddressProblem({ OCULUS_CLIENT_ADDRESS: "direct" })).toBeUndefined();
    expect(clientAddressProblem({ OCULUS_CLIENT_ADDRESS: "yes" })).toMatch(/only be "direct"/);
    expect(clientAddressProblem({ NODE_ENV: "development" })).toBeUndefined();
  });

  it("refuses to start when another server on this computer uses the files folder with another database", async () => {
    // A first start binds the folder (and notes this server).
    const first = await buildAdminServer({ db, env: DEV, adminFiles: files });
    await first.close();
    // A live server of another database: a stand-in entry for the parent
    // process, which is alive.
    const servers = join(filesDir, ".oculus-servers");
    const host = hostname()
      .replace(/[^A-Za-z0-9.-]/g, "_")
      .slice(0, 100);
    const theirs = join(servers, `${host}-${String(process.ppid)}-0123456789abcdef`);
    writeFileSync(theirs, "another%7Cdatabase\n");
    const marker = join(filesDir, STORE_MARKER);
    const before = readFileSync(marker, "utf8");
    const beforeTime = statSync(marker).mtimeMs;
    try {
      await expect(buildAdminServer({ db, env: DEV, adminFiles: files })).rejects.toThrow(
        /another Oculus server on this computer uses this folder with another database/,
      );
      // Refused before it changed anything: not the marker, not the lease.
      expect(readFileSync(marker, "utf8")).toBe(before);
      expect(statSync(marker).mtimeMs).toBe(beforeTime);
      // Nor does it bind an empty folder it is refused.
      const empty = mkdtempSync(join(tmpdir(), "oculus-admin-claim-"));
      mkdirSync(join(empty, ".oculus-servers"), { mode: 0o700 });
      writeFileSync(
        join(empty, ".oculus-servers", `${host}-${String(process.ppid)}-0123456789abcdef`),
        "another%7Cdatabase\n",
      );
      await expect(
        buildAdminServer({ db, env: { ...DEV, OCULUS_FILES_DIR: empty }, adminFiles: files }),
      ).rejects.toThrow(/another Oculus server/);
      expect(existsSync(join(empty, STORE_MARKER))).toBe(false);
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(theirs, { force: true });
    }
    // Two servers of this one database: fine.
    const one = await buildAdminServer({ db, env: DEV, adminFiles: files });
    const two = await buildAdminServer({ db, env: DEV, adminFiles: files });
    await one.close();
    await two.close();
  }, 30_000);

  it("warns when the file cap is above the virus scanner's limit, and stops its scans on close", async () => {
    const clamd = await startFakeClamd({ mode: "ok", tcp: true });
    try {
      const address = clamd.address as { host: string; port: number };
      const scanning = {
        ...DEV,
        OCULUS_CLAMD_HOST: address.host,
        OCULUS_CLAMD_PORT: String(address.port),
        OCULUS_CLAMD_STREAM_MAX_MIB: "1",
      };
      for (const [cap, warned] of [
        ["2", true],
        ["1", false],
      ] as const) {
        const logged: { event: string; code?: string }[] = [];
        const app = await buildAdminServer({
          db,
          env: { ...scanning, OCULUS_FILE_MAX_MIB: cap },
          adminFiles: files,
          log: (r) => logged.push(r),
        });
        // Closing waits for the scan queue (Fastify's onClose).
        await app.close();
        expect(
          logged.some(
            (r) => r.event === "startup_warning" && r.code === "file_cap_over_scan_limit",
          ),
          cap,
        ).toBe(warned);
      }
    } finally {
      await clamd.close();
    }
  }, 30_000);

  it("refuses to start without a usable files folder or with bad caps, never showing them", async () => {
    for (const value of [undefined, "", "relative/files", join(filesDir, "missing")]) {
      const failure = await buildAdminServer({
        db,
        env: { ...DEV, OCULUS_FILES_DIR: value },
        adminFiles: files,
      }).catch((error: unknown) => error);
      expect(String(failure)).toMatch(/OCULUS_FILES_DIR/);
      if (value !== undefined && value !== "") expect(String(failure)).not.toContain(value);
    }
    const plainFile = join(mkdtempSync(join(tmpdir(), "oculus-admin-plain-")), "not-a-folder");
    writeFileSync(plainFile, "x");
    await expect(
      buildAdminServer({ db, env: { ...DEV, OCULUS_FILES_DIR: plainFile }, adminFiles: files }),
    ).rejects.toThrow(/OCULUS_FILES_DIR/);
    for (const [name, value] of [
      ["OCULUS_FILE_MAX_MIB", "0"],
      ["OCULUS_FILE_MAX_MIB", "1.5"],
      ["OCULUS_FILES_TOTAL_MAX_MIB", "99999999"],
      ["OCULUS_FILES_TOTAL_MAX_MIB", "-3"],
    ] as const) {
      await expect(
        buildAdminServer({ db, env: { ...DEV, [name]: value }, adminFiles: files }),
      ).rejects.toThrow(new RegExp(name));
    }
  });

  it("refuses to start without a usable secret key, never showing it", async () => {
    await expect(
      buildAdminServer({ db, env: { ...DEV, OCULUS_SECRET_KEY: undefined }, adminFiles: files }),
    ).rejects.toThrow(/OCULUS_SECRET_KEY/);
    const weak = "short-and-weak-key";
    const failure = await buildAdminServer({
      db,
      env: { ...DEV, OCULUS_SECRET_KEY: weak },
      adminFiles: files,
    }).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(weak);
  });

  it("refuses to start in production behind an unnamed proxy, or without a reset sender", async () => {
    const production = { ...DEV, NODE_ENV: "production" };
    await expect(buildAdminServer({ db, env: production, adminFiles: files })).rejects.toThrow(
      /client address/,
    );
    await expect(
      buildAdminServer({
        db,
        env: { ...production, OCULUS_TRUSTED_PROXY: "loopback" },
        adminFiles: files,
      }),
    ).rejects.toThrow(/reset sender/);
    const started = await buildAdminServer({
      db,
      env: { ...production, OCULUS_CLIENT_ADDRESS: "direct" },
      adminFiles: files,
      deliverReset: () => Promise.resolve(),
      log: () => undefined,
    });
    await started.close();
  });

  it("makes the SMTP sender from the environment in production, and refuses the development one", async () => {
    const production = { ...DEV, NODE_ENV: "production", OCULUS_CLIENT_ADDRESS: "direct" };
    const smtp = {
      ...production,
      OCULUS_ORIGINS: "https://admin.invented.example",
      OCULUS_ADMIN_ORIGIN: "https://admin.invented.example",
      OCULUS_SMTP_HOST: "smtp.invented.example",
      OCULUS_MAIL_FROM: "oculus@invented.example",
    };
    const started = await buildAdminServer({
      db,
      env: smtp,
      adminFiles: files,
      log: () => undefined,
    });
    await started.close();
    await expect(
      buildAdminServer({ db, env: { ...smtp, OCULUS_DEV_MAIL_DIR: "/tmp" }, adminFiles: files }),
    ).rejects.toThrow(/development only/);
    await expect(
      buildAdminServer({ db, env: { ...smtp, OCULUS_SMTP_TLS: "none" }, adminFiles: files }),
    ).rejects.toThrow(/OCULUS_SMTP_TLS/);
  });

  it("exits cleanly on a badly formed database URL, never showing it", async () => {
    for (const url of [
      "postgresql://someone:invented-pw@[bad",
      "not a url invented-pw",
      "mysql://x:invented-pw@h/d",
    ]) {
      const lines: string[] = [];
      const code = await runAdminCli({ OCULUS_DATABASE_URL: url }, (line) => lines.push(line));
      expect(code, url).toBe(2);
      expect(lines.join("\n")).toMatch(/OCULUS_DATABASE_URL is not a usable/);
      expect(lines.join("\n")).not.toContain("invented-pw");
    }
  });

  it("refuses an admin origin outside OCULUS_ORIGINS", async () => {
    await expect(
      buildAdminServer({
        db,
        env: { ...DEV, OCULUS_ADMIN_ORIGIN: "https://admin.example.org" },
        adminFiles: files,
      }),
    ).rejects.toThrow(/OCULUS_ORIGINS/);
  });
});

describe("the built admin on the admin's origin", () => {
  let app: FastifyInstance;
  const logged: ApiLogRecord[] = [];

  beforeAll(async () => {
    app = await buildAdminServer({
      db,
      env: DEV,
      adminFiles: files,
      log: (record) => logged.push(record),
      signIn: { resetOptions: { backgroundDelayMs: { min: 0, max: 0 } } },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves files and screens with the admin's CSP", async () => {
    for (const url of ["/", "/sign-in", "/assets/index-abc.js", "/fonts/a.woff2"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(ADMIN_CSP);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(ADMIN_CSP).toContain("script-src 'self'");
    expect(ADMIN_CSP).not.toContain("unsafe");
    const page = await app.inject({ method: "GET", url: "/sites/x?y=1" });
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toContain("<title>Oculus</title>");
    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
  });

  it("keeps the API's own policy on API replies, and never answers /api with a page", async () => {
    const api = await app.inject({ method: "GET", url: "/api/me" });
    expect(api.statusCode).toBe(401);
    expect(api.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
    const unknown = await app.inject({ method: "GET", url: "/api/nothing-here" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["content-type"]).toMatch(/^application\/json/);
    expect(unknown.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
    const missing = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
  });

  it("answers another origin's host (a public site) with the JSON 404", async () => {
    const other = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1:3001" },
    });
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe('{"error":"not_found"}');
    expect(other.headers["content-security-policy"]).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
  });

  it("serves nothing but GET and HEAD, and refuses traversal before routing", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/index.html",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      payload: "{}",
    });
    expect(posted.statusCode).toBe(404);
    // (light-my-request resolves a literal or encoded ".." itself; paths.attacks.test.ts
    // sends those over a raw socket.)
    for (const url of ["/assets/..%2f..%2fpackage.json", "/assets%5cindex.html", "//x"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });

  it("logs that a reset link was made in development, never the token or address", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/password-reset",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      payload: JSON.stringify({ email: "someone@example.org" }),
    });
    expect(response.statusCode).toBe(202);
    for (let i = 0; i < 100 && !logged.some((r) => r.event === "reset_settled"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(JSON.stringify(logged)).not.toContain("example.org");
  });
});

describe("the background jobs (S-063)", () => {
  const KEY = "source:other";
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** A sign-in counter with no failures: the cleanup deletes it. */
  const seed = (): Promise<unknown> =>
    db.execute(
      sql`INSERT INTO public.sign_in_throttles (key, failures) VALUES (${KEY}, 0)
          ON CONFLICT (key) DO UPDATE SET failures = 0, last_failure_at = NULL`,
    );
  const seeded = async (): Promise<boolean> =>
    (await db.rows(sql`SELECT 1 FROM public.sign_in_throttles WHERE key = ${KEY}`)).length === 1;

  it("runs the cleanup and the alert notices in the server, and stops both when it closes", async () => {
    await seed();
    const logged: ApiLogRecord[] = [];
    const app = await buildAdminServer({
      db,
      env: DEV,
      adminFiles: files,
      log: (r) => logged.push(r),
      housekeeping: { cleanupFirstAfterMs: 20, cleanupEveryMs: 30, noticesEveryMs: 20 },
    });
    try {
      const deadline = Date.now() + 15_000;
      while ((await seeded()) && Date.now() < deadline) await sleep(25);
      expect(await seeded()).toBe(false);
      expect(logged).toContainEqual({ event: "cleanup", code: expect.any(String) as string });
    } finally {
      await app.close();
    }
    // Closed: neither job runs again (the cleanup would have run every 30 ms).
    await seed();
    await sleep(300);
    expect(await seeded()).toBe(true);
    expect(logged.filter((r) => r.event === "service_error")).toEqual([]);
    await db.execute(sql`DELETE FROM public.sign_in_throttles WHERE key = ${KEY}`);
  }, 30_000);

  it("runs neither with housekeeping: false", async () => {
    await seed();
    const app = await buildAdminServer({
      db,
      env: DEV,
      adminFiles: files,
      housekeeping: false,
    });
    try {
      await sleep(300);
      expect(await seeded()).toBe(true);
    } finally {
      await app.close();
      await db.execute(sql`DELETE FROM public.sign_in_throttles WHERE key = ${KEY}`);
    }
  }, 30_000);
});
