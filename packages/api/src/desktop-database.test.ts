// The desktop database helper (T-057, D-093): its pieces, and the whole run
// against a throwaway PostgreSQL that uses scram-sha-256 passwords, as an
// installed one does, followed by the launcher connecting as the writer.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPublicReaderConnection, checkWriterConnection, openDatabase, sql } from "@oculus/db";
import { runDesktop } from "./desktop-cli.js";
import { READER_ONLY_FAILED, runDesktopDatabase } from "./desktop-database-cli.js";
import {
  addPgpassEntries,
  addressFor,
  pgpassField,
  pgpassPath,
  pgpassTarget,
  removePgpassLines,
  scramVerifier,
} from "./desktop-database.js";

const ADMIN_PASSWORD = "Invented postgres pw: 2026\\";
const ACCOUNT_PASSWORD = "Invented river bend lantern 2026";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "oculus-desktop-db-"));
});
const ORIGINAL_PGPASSFILE = process.env.PGPASSFILE;
afterEach(() => {
  if (ORIGINAL_PGPASSFILE === undefined) delete process.env.PGPASSFILE;
  else process.env.PGPASSFILE = ORIGINAL_PGPASSFILE;
  rmSync(folder, { recursive: true, force: true });
});

describe("the pieces", () => {
  it("makes SCRAM-SHA-256 verifiers in PostgreSQL's form, salted afresh each time", () => {
    const one = scramVerifier("x");
    expect(one).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(scramVerifier("x")).not.toBe(one);
    expect(one).not.toContain("x$");
  });

  it("escapes pgpass fields as libpq reads them, and refuses line breaks", () => {
    expect(pgpassField("a:b\\c")).toBe("a\\:b\\\\c");
    expect(() => pgpassField("a\nb")).toThrow();
  });

  it("puts new lines first, keeps the old ones, and makes the file 0600", () => {
    const file = join(folder, "sub", "pgpass");
    writeFileSync(join(folder, "x"), "");
    addPgpassEntries(file, [
      { host: "h", port: "5432", database: "d", user: "u", password: "p:1" },
    ]);
    addPgpassEntries(file, [{ host: "h", port: "5432", database: "d", user: "v", password: "p2" }]);
    expect(readFileSync(file, "utf8")).toBe("h:5432:d:v:p2\nh:5432:d:u:p\\:1\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the existing file's bytes exactly, and takes back only the lines it added", () => {
    const file = join(folder, "pgpass");
    const old = Buffer.from([0x68, 0x3a, 0x31, 0x3a, 0x64, 0x3a, 0x75, 0x3a, 0xe9, 0x0a]); // a Latin-1 password
    writeFileSync(file, old, { mode: 0o644 });
    const added = addPgpassEntries(file, [
      { host: "h", port: "1", database: "d", user: "v", password: "p" },
    ]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    removePgpassLines(file, added);
    expect(readFileSync(file).equals(old)).toBe(true);
  });

  it("finds the pgpass file where libpq looks", () => {
    expect(pgpassPath("linux", {}, "/home/a")).toBe("/home/a/.pgpass");
    expect(pgpassPath("win32", { APPDATA: "C:\\R" }, "C:\\h")).toBe(
      join("C:\\R", "postgresql", "pgpass.conf"),
    );
    expect(pgpassPath("linux", { PGPASSFILE: "/given" }, "/home/a")).toBe("/given");
  });

  it("makes addresses for the new roles with no password, on the same host and port", () => {
    const address = addressFor(
      "postgresql://postgres:secret@db.example:5433/postgres?sslmode=require",
      "oculus_app",
      "oculus",
    );
    expect(address).toBe("postgresql://oculus_app@db.example:5433/oculus?sslmode=require");
    expect(pgpassTarget(address)).toEqual({ host: "db.example", port: "5433" });
    expect(addressFor("postgresql://p@h/postgres?user=x&dbname=y&host=%2Fs", "o", "oculus")).toBe(
      "postgresql://o@h/oculus?host=%2Fs",
    );
    expect(pgpassTarget("postgresql://a@localhost/oculus?host=%2Ftmp%2Fs")).toEqual({
      host: "/tmp/s",
      port: "5432",
    });
  });
});

describe("npm run desktop:database, then npm run desktop", () => {
  let server: { url: string; stop: () => void };

  beforeAll(async () => {
    const helper = (await import(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "scripts",
        "test-database.mjs",
      )
    )) as {
      findPostgresBin: () => string | undefined;
      startTestDatabase: (o: { bin: string; log: () => void; password: string }) => {
        url: string;
        stop: () => void;
      };
    };
    const bin = helper.findPostgresBin();
    if (bin === undefined) throw new Error("No initdb and pg_ctl for a password server.");
    server = helper.startTestDatabase({ bin, log: () => undefined, password: ADMIN_PASSWORD });
  }, 120_000);
  afterAll(() => {
    server.stop();
  });

  const names = (tag: string) => ({
    database: `t057_${tag}`,
    owner: `t057_${tag}_owner`,
    writer: `t057_${tag}_app`,
    reader: `t057_${tag}_public`,
  });

  /** A GET to 127.0.0.1:<port> as a browser at http://localhost:<port> sends it. */
  function getAs(port: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port: Number(port), path, headers: { host: `localhost:${port}` } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, body });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  }

  function answers(list: (string | undefined)[]) {
    const asked: string[] = [];
    return {
      asked,
      ask: (question: string) => {
        asked.push(question);
        return Promise.resolve(list.shift());
      },
    };
  }

  function env(extra: Record<string, string> = {}) {
    return {
      OCULUS_DESKTOP_HOME: folder,
      OCULUS_DESKTOP_ADMIN_URL: server.url,
      PGPASSFILE: join(folder, "pgpass"),
      OCULUS_SETUP_ORGANIZATION: "Invented Historical Society",
      OCULUS_SETUP_SITE: "Invented Archive",
      OCULUS_SETUP_NAME: "Invented Root",
      OCULUS_SETUP_EMAIL: "root@example.org",
      ...extra,
    };
  }

  it("makes the roles and database, saves the passwords, sets up, and the launcher then runs as the writer", async () => {
    const n = names("ok");
    const lines: string[] = [];
    const { ask } = answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]);
    const code = await runDesktopDatabase({
      env: env(),
      ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(lines.join("\n")).not.toContain("ERR");
    expect(code).toBe(0);

    const settings = JSON.parse(readFileSync(join(folder, "desktop.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(settings.databaseUrl).toContain(`${n.writer}@`);
    expect(settings.ownerDatabaseUrl).toContain(`${n.owner}@`);
    expect(settings.publicDatabaseUrl).toContain(`${n.reader}@`);
    expect(JSON.stringify(settings)).not.toMatch(/:[^/@]+@/); // no passwords
    const pgpass = readFileSync(join(folder, "pgpass"), "utf8");
    expect(pgpass.split("\n").filter((l) => l.includes(n.database))).toHaveLength(3);
    expect(pgpass).not.toContain(ADMIN_PASSWORD);
    const printed = lines.join("\n");
    expect(printed).not.toContain(ADMIN_PASSWORD);
    for (const line of pgpass.split("\n").filter(Boolean)) {
      expect(printed).not.toContain(line.split(":").at(-1));
    }

    // The writer signs in with its pgpass password and is a proper writer.
    const passwordFor = (user: string) => {
      const line = pgpass.split("\n").find((l) => l.includes(`:${user}:`));
      return line?.split(":").at(-1) ?? "";
    };
    const writerUrl = new URL(settings.databaseUrl ?? "");
    writerUrl.password = passwordFor(n.writer);
    const writer = openDatabase(writerUrl.href, { max: 1 });
    try {
      expect(await checkWriterConnection(writer)).toEqual([]);
      const [count] = await writer.rows<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM public.users`,
      );
      expect(count?.n).toBe("1");
    } finally {
      await writer.close();
    }
    // The public reader (T-071, D-080): can read no table, passes the public check.
    const readerUrl = new URL(settings.publicDatabaseUrl ?? "");
    readerUrl.password = passwordFor(n.reader);
    const reader = openDatabase(readerUrl.href, { max: 1 });
    try {
      expect(await checkPublicReaderConnection(reader)).toEqual([]);
      await expect(reader.rows(sql`SELECT 1 FROM public.users LIMIT 1`)).rejects.toThrow();
    } finally {
      await reader.close();
    }

    // As after an update whose migration adds a table: the writer lacks a
    // privilege the launcher must grant, not refuse (missing_privilege).
    const ownerUrl = new URL(settings.ownerDatabaseUrl ?? "");
    ownerUrl.password = passwordFor(n.owner);
    const owner = openDatabase(ownerUrl.href, { max: 1 });
    try {
      await owner.execute(sql`REVOKE INSERT ON public.records FROM t057_ok_app`);
      const writerCheck = openDatabase(writerUrl.href, { max: 1 });
      try {
        expect((await checkWriterConnection(writerCheck)).map((p) => p.code)).toContain(
          "missing_privilege",
        );
      } finally {
        await writerCheck.close();
      }
    } finally {
      await owner.close();
    }

    // The launcher reads desktop.json and pgpass, and serves as the writer.
    const adminDir = join(folder, "admin-build");
    rmSync(adminDir, { recursive: true, force: true });
    mkdirSync(adminDir);
    writeFileSync(join(adminDir, "index.html"), "<!doctype html><title>Invented admin</title>");
    const out: string[] = [];
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    // pg reads the pgpass file named by the process's own PGPASSFILE.
    process.env.PGPASSFILE = join(folder, "pgpass");
    const run = runDesktop({
      env: { OCULUS_DESKTOP_HOME: folder, PGPASSFILE: join(folder, "pgpass") },
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      findBrowser: () => undefined,
      openDefault: () => undefined,
      stopRequested: () => stopped,
      adminDir,
    });
    for (let i = 0; i < 400 && !out.some((l) => l.startsWith("Oculus is running")); i++) {
      if (out.some((l) => l.startsWith("ERR"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(out.join("\n")).not.toContain("ERR");
    const address = out.find((l) => l.startsWith("Oculus is running at "))?.slice(21) ?? "";
    // Signing in works as the writer (the first step answers; no error).
    const reply = await fetch(new URL("/api/sign-in", address), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(address).origin },
      body: JSON.stringify({ email: "root@example.org", password: ACCOUNT_PASSWORD }),
    });
    expect(reply.status).toBe(200);
    expect(((await reply.json()) as { next?: string }).next).toBe("set_up");
    // The site's public side (T-071): its own port on 127.0.0.1, as localhost.
    const line = out.find((l) => l.startsWith('Public site "Invented Archive": ')) ?? "";
    const publicAddress = line.slice('Public site "Invented Archive": '.length);
    expect(publicAddress).toMatch(/^http:\/\/localhost:\d+\/$/);
    const port = new URL(publicAddress).port;
    const home = await getAs(port, "/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("<h1>Invented Archive</h1>");
    // The staff API isn't there (D-090), and the port is kept for next time.
    expect((await getAs(port, "/api/me")).status).toBe(404);
    const kept = JSON.parse(readFileSync(join(folder, "desktop.json"), "utf8")) as {
      publicPorts?: Record<string, number>;
    };
    expect(Object.values(kept.publicPorts ?? {})).toEqual([Number(port)]);
    stop();
    expect(await run).toBe(0);

    // Next start, with another program on that port: the site gets another
    // free port, is served there, and the new port is kept (T-071 review).
    const squatter = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => squatter.listen(Number(port), "127.0.0.1", resolve));
    try {
      const again: string[] = [];
      let stopAgain: () => void = () => undefined;
      const stoppedAgain = new Promise<void>((resolve) => {
        stopAgain = resolve;
      });
      const second = runDesktop({
        env: { OCULUS_DESKTOP_HOME: folder, PGPASSFILE: join(folder, "pgpass") },
        out: (l) => again.push(l),
        err: (l) => again.push(`ERR ${l}`),
        findBrowser: () => undefined,
        openDefault: () => undefined,
        stopRequested: () => stoppedAgain,
        adminDir,
      });
      for (let i = 0; i < 400 && !again.some((l) => l.startsWith("Oculus is running")); i++) {
        if (again.some((l) => l.startsWith("ERR"))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(again.join("\n")).not.toContain("ERR");
      const moved =
        again
          .find((l) => l.startsWith('Public site "Invented Archive": '))
          ?.slice('Public site "Invented Archive": '.length) ?? "";
      const movedPort = new URL(moved).port;
      expect(movedPort).not.toBe(port);
      expect((await getAs(movedPort, "/")).body).toContain("<h1>Invented Archive</h1>");
      const keptAgain = JSON.parse(readFileSync(join(folder, "desktop.json"), "utf8")) as {
        publicPorts?: Record<string, number>;
      };
      expect(Object.values(keptAgain.publicPorts ?? {})).toEqual([Number(movedPort)]);
      stopAgain();
      expect(await second).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        squatter.close(() => {
          resolve();
        });
      });
    }
    // The grant was put back before serving.
    const writerAfter = openDatabase(writerUrl.href, { max: 1 });
    try {
      expect(await checkWriterConnection(writerAfter)).toEqual([]);
    } finally {
      await writerAfter.close();
    }
  });

  it("keeps the database when a setup answer goes wrong, and finishes the questions on the next run", async () => {
    const n = names("resume");
    writeFileSync(join(folder, "desktop.json"), '{"port":4999}');
    const first = answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, "a different password"]);
    const lines: string[] = [];
    const code = await runDesktopDatabase({
      env: env(),
      ask: first.ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Run this again");
    const settings = JSON.parse(readFileSync(join(folder, "desktop.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings.port).toBe(4999);

    // The launcher sees the unfinished setup and says so with exit code 3.
    process.env.PGPASSFILE = join(folder, "pgpass");
    const launcher: string[] = [];
    const three = await runDesktop({
      env: { OCULUS_DESKTOP_HOME: folder },
      out: (l) => launcher.push(l),
      err: (l) => launcher.push(l),
      findBrowser: () => undefined,
      openDefault: () => undefined,
      stopRequested: () => new Promise(() => undefined),
    });
    expect(three).toBe(3);
    expect(launcher.join("\n")).toContain("desktop:database");

    const second = answers([ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]);
    const again = await runDesktopDatabase({
      env: env(),
      ask: second.ask,
      out: () => undefined,
      err: () => undefined,
      names: n,
    });
    expect(again).toBe(0);
    expect(second.asked.some((q) => q.includes("postgres"))).toBe(false);
    // A third run has nothing to do.
    const third = answers([]);
    expect(
      await runDesktopDatabase({
        env: env(),
        ask: third.ask,
        out: () => undefined,
        err: () => undefined,
        names: n,
      }),
    ).toBe(0);
    expect(third.asked).toEqual([]);
  });

  it("removes what it made, pgpass lines included, when making the database fails", async () => {
    // An upper-case writer name is refused by grantWriterRole after both roles and the database exist.
    const n = {
      database: "t057_undo",
      owner: "t057_undo_owner",
      writer: "T057_Undo_App",
      reader: "t057_undo_public",
    };
    writeFileSync(join(folder, "pgpass"), "keep:me:please:x:y\n", { mode: 0o600 });
    const lines: string[] = [];
    const code = await runDesktopDatabase({
      env: env(),
      ask: answers([ADMIN_PASSWORD]).ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("removed");
    expect(existsSync(join(folder, "desktop.json"))).toBe(false);
    expect(readFileSync(join(folder, "pgpass"), "utf8")).toBe("keep:me:please:x:y\n");
    const adminUrl = new URL(server.url);
    adminUrl.password = encodeURIComponent(ADMIN_PASSWORD);
    const admin = openDatabase(adminUrl.href, { max: 1 });
    try {
      const left = await admin.rows(sql`
        SELECT 1 FROM pg_database WHERE datname = ${n.database}
        UNION ALL SELECT 1 FROM pg_roles WHERE rolname IN (${n.owner}, ${n.writer}, ${n.reader})`);
      expect(left).toEqual([]);
    } finally {
      await admin.close();
    }
  });

  it("adds the public reader to a database an earlier version made (T-071)", async () => {
    const n = names("older");
    const made = await runDesktopDatabase({
      env: env(),
      ask: answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]).ask,
      out: () => undefined,
      err: () => undefined,
      names: n,
    });
    expect(made).toBe(0);
    // As an earlier version left it: no reader role, no publicDatabaseUrl.
    const file = join(folder, "desktop.json");
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete settings.publicDatabaseUrl;
    writeFileSync(file, JSON.stringify(settings));
    const pgpassFile = join(folder, "pgpass");
    const kept = readFileSync(pgpassFile, "utf8")
      .split("\n")
      .filter((l) => !l.includes(":t057_older_public:"))
      .join("\n");
    writeFileSync(pgpassFile, kept, { mode: 0o600 });
    process.env.PGPASSFILE = join(folder, "pgpass");
    const owner = openDatabase(String(settings.ownerDatabaseUrl), { max: 1 });
    try {
      await owner.execute(sql`REVOKE USAGE ON SCHEMA public FROM t057_older_public`);
    } finally {
      await owner.close();
    }
    const adminUrl = new URL(server.url);
    adminUrl.password = encodeURIComponent(ADMIN_PASSWORD);
    const admin = openDatabase(adminUrl.href, { max: 1 });
    try {
      await admin.execute(sql`DROP ROLE t057_older_public`);
    } finally {
      await admin.close();
    }

    const lines: string[] = [];
    const again = answers([ADMIN_PASSWORD]);
    const code = await runDesktopDatabase({
      env: env(),
      ask: again.ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(lines.join("\n")).not.toContain("ERR");
    expect(code).toBe(0);
    expect(again.asked).toHaveLength(1);
    const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(after.publicDatabaseUrl).toContain(`${n.reader}@`);
    const reader = openDatabase(after.publicDatabaseUrl ?? "", { max: 1 });
    try {
      expect(await checkPublicReaderConnection(reader)).toEqual([]);
    } finally {
      await reader.close();
    }
    // Once there, a further run has nothing to do.
    const none = answers([]);
    expect(
      await runDesktopDatabase({
        env: env(),
        ask: none.ask,
        out: () => undefined,
        err: () => undefined,
        names: n,
      }),
    ).toBe(0);
    expect(none.asked).toEqual([]);
  });

  it("takes back the reader it made and granted when saving it fails, exits 5 and calls finished once (T-071)", async () => {
    const n = names("rollback");
    expect(
      await runDesktopDatabase({
        env: env(),
        ask: answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]).ask,
        out: () => undefined,
        err: () => undefined,
        names: n,
      }),
    ).toBe(0);
    // As an earlier version left it. The pgpass file the helper writes to is
    // a folder this time, so saving the reader's line fails after the role
    // is made and granted (pg itself still reads the real file).
    const file = join(folder, "desktop.json");
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete settings.publicDatabaseUrl;
    writeFileSync(file, JSON.stringify(settings));
    const realOwner = String(settings.ownerDatabaseUrl);
    const unwritable = join(folder, "pgpass-folder");
    mkdirSync(unwritable);
    const pgpassFile = join(folder, "pgpass");
    process.env.PGPASSFILE = pgpassFile;
    const owner = openDatabase(realOwner, { max: 1 });
    try {
      await owner.execute(sql`REVOKE USAGE ON SCHEMA public FROM t057_rollback_public`);
    } finally {
      await owner.close();
    }
    const adminUrl = new URL(server.url);
    adminUrl.password = encodeURIComponent(ADMIN_PASSWORD);
    const admin = openDatabase(adminUrl.href, { max: 1 });
    try {
      await admin.execute(sql`DROP ROLE t057_rollback_public`);
      const pgpassBefore = readFileSync(pgpassFile, "utf8");
      const lines: string[] = [];
      let finishedCalls = 0;
      const code = await runDesktopDatabase({
        env: env({ PGPASSFILE: unwritable }),
        ask: answers([ADMIN_PASSWORD]).ask,
        out: (l) => lines.push(l),
        err: (l) => lines.push(`ERR ${l}`),
        names: n,
        finished: () => {
          finishedCalls++;
        },
      });
      expect(code).toBe(READER_ONLY_FAILED);
      expect(finishedCalls).toBe(1);
      expect(lines.join("\n")).toContain("What was made has been removed");
      const left = await admin.rows(
        sql`SELECT 1 FROM pg_roles WHERE rolname = 't057_rollback_public'`,
      );
      expect(left).toEqual([]);
      expect(readFileSync(pgpassFile, "utf8")).toBe(pgpassBefore);
      const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(after.publicDatabaseUrl).toBeUndefined();
    } finally {
      await admin.close();
    }
    // Oculus still starts as before, without public sites, and says how to add them.
    const adminDir = join(folder, "admin-build");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, "index.html"), "<!doctype html><title>Invented admin</title>");
    const out: string[] = [];
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = runDesktop({
      env: { OCULUS_DESKTOP_HOME: folder, PGPASSFILE: pgpassFile },
      out: (l) => out.push(l),
      err: (l) => out.push(`ERR ${l}`),
      findBrowser: () => undefined,
      openDefault: () => undefined,
      stopRequested: () => stopped,
      adminDir,
    });
    for (let i = 0; i < 400 && !out.some((l) => l.startsWith("Oculus is running")); i++) {
      if (out.some((l) => l.startsWith("ERR"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(out.join("\n")).not.toContain("ERR");
    expect(out.some((l) => l.startsWith("The public sites aren't set up"))).toBe(true);
    expect(out.some((l) => l.startsWith("Public site "))).toBe(false);
    stop();
    expect(await run).toBe(0);
  });

  it("leaves a role of the reader's name alone when it already exists, and exits 5 (T-071)", async () => {
    const n = names("clash");
    expect(
      await runDesktopDatabase({
        env: env(),
        ask: answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]).ask,
        out: () => undefined,
        err: () => undefined,
        names: n,
      }),
    ).toBe(0);
    const file = join(folder, "desktop.json");
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete settings.publicDatabaseUrl;
    writeFileSync(file, JSON.stringify(settings));
    process.env.PGPASSFILE = join(folder, "pgpass");
    // The reader role from the first run is still there: someone else's now.
    const code = await runDesktopDatabase({
      env: env(),
      ask: answers([ADMIN_PASSWORD]).ask,
      out: () => undefined,
      err: () => undefined,
      names: n,
    });
    expect(code).toBe(READER_ONLY_FAILED);
    const adminUrl = new URL(server.url);
    adminUrl.password = encodeURIComponent(ADMIN_PASSWORD);
    const admin = openDatabase(adminUrl.href, { max: 1 });
    try {
      const kept = await admin.rows(
        sql`SELECT 1 FROM pg_roles WHERE rolname = 't057_clash_public'`,
      );
      expect(kept).toHaveLength(1);
    } finally {
      await admin.close();
    }
  });

  it("changes nothing when the postgres password is wrong", async () => {
    const n = names("wrong");
    const lines: string[] = [];
    const code = await runDesktopDatabase({
      env: env(),
      ask: answers(["not it"]).ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Couldn't sign in");
    expect(existsSync(join(folder, "desktop.json"))).toBe(false);
    expect(existsSync(join(folder, "pgpass"))).toBe(false);
  });

  it("changes nothing when a role or the database already exists", async () => {
    const n = names("exists");
    const first = await runDesktopDatabase({
      env: env(),
      ask: answers([ADMIN_PASSWORD, ACCOUNT_PASSWORD, ACCOUNT_PASSWORD]).ask,
      out: () => undefined,
      err: () => undefined,
      names: n,
    });
    expect(first).toBe(0);
    // A second folder, same names: refused before anything is made.
    rmSync(join(folder, "desktop.json"));
    const before = readFileSync(join(folder, "pgpass"), "utf8");
    const lines: string[] = [];
    const again = await runDesktopDatabase({
      env: env(),
      ask: answers([ADMIN_PASSWORD]).ask,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      names: n,
    });
    expect(again).toBe(1);
    expect(lines.join("\n")).toContain("already has");
    expect(readFileSync(join(folder, "pgpass"), "utf8")).toBe(before);
  });

  it("refuses when desktop.json already names a database, before asking anything", async () => {
    writeFileSync(join(folder, "desktop.json"), '{"databaseUrl":"postgresql://a@localhost/b"}');
    const { ask, asked } = answers([]);
    const code = await runDesktopDatabase({
      env: env(),
      ask,
      out: () => undefined,
      err: () => undefined,
      names: names("set"),
    });
    expect(code).toBe(1);
    expect(asked).toEqual([]);
  });
});
