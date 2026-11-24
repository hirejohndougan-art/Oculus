// S-017: every URL-based connection (migrations, cleanup, the app's pool) gets
// the same TLS rule as backups (D-064). Before the fix, `clientConfig` handed
// the URL to node-pg, which connects in cleartext when there is no sslmode
// and skips certificate checks for `sslmode=no-verify` or libpq-compatible
// `require`, so someone on the network path could read session tables, pose
// as the server and capture a `password`-auth password.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionError } from "./backup-connection.js";
import { runCleanupCli } from "./cleanup-cli.js";
import { clientConfig, openDatabase, openSession, withDatabaseName } from "./client.js";
import { runMigrateCli } from "./migrate-cli.js";
import { sql } from "./sql.js";

const FAKE_PASSWORD = "invented-db-password";
const REMOTE = `postgresql://oculus:${FAKE_PASSWORD}@db.example.invalid/oculus`;

describe("clientConfig applies the backup TLS rule to every URL (S-017)", () => {
  it("never hands the URL to the driver", () => {
    const config = clientConfig(REMOTE);
    expect(config).not.toHaveProperty("connectionString");
    expect(config).toMatchObject({
      host: "db.example.invalid",
      port: 5432,
      database: "oculus",
      user: "oculus",
      password: FAKE_PASSWORD,
    });
  });

  it("verifies the certificate of a remote host with no sslmode, prefer or require", () => {
    for (const query of ["", "?sslmode=prefer", "?sslmode=require", "?sslmode=verify-full"]) {
      const { ssl } = clientConfig(REMOTE + query);
      expect(ssl, query).toMatchObject({ rejectUnauthorized: true });
      expect(ssl, query).not.toHaveProperty("checkServerIdentity");
    }
  });

  it("refuses the URL forms that would turn TLS off or skip the certificate check", () => {
    for (const query of [
      "?sslmode=disable",
      "?sslmode=allow",
      "?sslmode=no-verify",
      "?uselibpqcompat=true&sslmode=require",
      "?ssl=true",
      "?ssl=false",
      "?options=-c%20search_path%3Dx",
      "?hostaddr=10.0.0.1",
    ]) {
      expect(() => clientConfig(REMOTE + query), query).toThrow(ConnectionError);
    }
  });

  it("keeps a Unix socket and this machine without TLS", () => {
    expect(clientConfig("postgresql://postgres@localhost/db?host=%2Ftmp%2Fsock").ssl).toBe(false);
    expect(clientConfig("postgresql://u@localhost/db").ssl).toBe(false);
    expect(clientConfig("postgresql://u@127.0.0.1:5433/db").ssl).toBe(false);
  });

  it("puts no part of a refused URL in the error", () => {
    let error: unknown;
    try {
      openDatabase(`${REMOTE}?sslmode=no-verify`);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).not.toContain(FAKE_PASSWORD);
    expect((error as Error).message).not.toContain("db.example.invalid");
  });
});

/**
 * A server on 127.0.0.2 (loopback, but not one of the hosts treated as this
 * machine) that answers an SSLRequest with "N" (no TLS), as an attacker in the
 * path would, and records every byte it receives.
 */
let server: Server | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        resolve();
      });
    } else resolve();
  });
  server = undefined;
});

async function downgradingServer(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      // SSLRequest: length 8, code 80877103. Refuse TLS.
      if (chunk.length >= 8 && chunk.readInt32BE(4) === 80877103) socket.write("N");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.2", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, received };
}

describe("a server refusing TLS never gets the startup message or password (S-017)", () => {
  it("openSession (db:migrate's connection) asks for TLS and gives up when refused", async () => {
    const { port, received } = await downgradingServer();
    const url = `postgresql://oculus:${FAKE_PASSWORD}@127.0.0.2:${String(port)}/oculus?connect_timeout=5`;
    await expect(openSession(url)).rejects.toThrow();
    const bytes = Buffer.concat(received);
    expect(bytes.length).toBe(8);
    expect(bytes.readInt32BE(4)).toBe(80877103);
    expect(bytes.includes(Buffer.from("oculus"))).toBe(false);
    expect(bytes.includes(Buffer.from(FAKE_PASSWORD))).toBe(false);
  });

  it("openDatabase (db:cleanup's and the app's pool) does the same", async () => {
    const { port, received } = await downgradingServer();
    const url = `postgresql://oculus:${FAKE_PASSWORD}@127.0.0.2:${String(port)}/oculus?connect_timeout=5`;
    const db = openDatabase(url, { max: 1 });
    try {
      await expect(db.rows(sql`SELECT 1`)).rejects.toThrow();
    } finally {
      await db.close();
    }
    const bytes = Buffer.concat(received);
    expect(bytes.length).toBe(8);
    expect(bytes.includes(Buffer.from(FAKE_PASSWORD))).toBe(false);
  });
});

describe("the commands refuse a URL that would skip TLS (S-017)", () => {
  it("db:cleanup exits 2 without printing the URL", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCleanupCli(
      { OCULUS_DATABASE_URL: `${REMOTE}?sslmode=disable` },
      (line) => out.push(line),
      (line) => err.push(line),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/^Cleanup refused \(bad_url\)/);
    expect([...out, ...err].join("\n")).not.toContain(FAKE_PASSWORD);
  });

  it("db:migrate fails without connecting or printing the URL", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMigrateCli(
      { OCULUS_DATABASE_URL: `${REMOTE}?sslmode=no-verify` },
      (line) => out.push(line),
      (line) => err.push(line),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("bad_url");
    expect([...out, ...err].join("\n")).not.toContain(FAKE_PASSWORD);
    expect([...out, ...err].join("\n")).not.toContain("db.example.invalid");
  });
});

describe("withDatabaseName (S-017)", () => {
  it("drops a dbname in the query, which would otherwise win over the new name", () => {
    const url = withDatabaseName("postgresql://u@localhost/a?dbname=b", "c");
    expect(clientConfig(url).database).toBe("c");
  });
});
