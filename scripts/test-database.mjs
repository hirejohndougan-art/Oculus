// A throwaway PostgreSQL server for the gate (D-049): initdb into a new
// temporary directory, listen only on a Unix socket in that directory (no TCP
// port), trust authentication on that private socket (no password anywhere),
// fsync off. `stop()` always stops the server and deletes the directory.
//
// Under uid 0 (the build sandbox runs as root, and initdb refuses root) the
// server commands run as the `postgres` system user through `runuser`, with the
// directory owned by that user.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chownSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The directory holding initdb and pg_ctl, or undefined if none is found. */
export function findPostgresBin(env = process.env) {
  if (env.PG_BIN) return existsSync(join(env.PG_BIN, "initdb")) ? env.PG_BIN : undefined;
  try {
    const dir = execFileSync("pg_config", ["--bindir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** A connection URL for a Unix socket directory, as pg-connection-string reads it. */
export function socketUrl(socketDir, database = "postgres") {
  return `postgresql://postgres@localhost/${database}?host=${encodeURIComponent(socketDir)}`;
}

/** postgresql.conf string literal. */
function confString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/**
 * Starts a throwaway server. Returns `{ url, stop }`. Throws (after cleaning up)
 * if the server can't be started.
 */
export function startTestDatabase({ bin, log = console.log } = {}) {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const dir = mkdtempSync(join(tmpdir(), "oculus-pg-"));
  const data = join(dir, "data");
  const logFile = join(dir, "server.log");
  let started = false;
  let stopped = false;

  const run = (program, args) => {
    const [cmd, argv] = asRoot
      ? ["runuser", ["-u", "postgres", "--", join(bin, program), ...args]]
      : [join(bin, program), args];
    const result = spawnSync(cmd, argv, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(`${program} failed (${result.status ?? result.signal}): ${output}`);
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (started) {
      try {
        run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      } catch (error) {
        console.error(`Could not stop the test database cleanly: ${error.message}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    if (asRoot) {
      const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
      const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
      chownSync(dir, uid, gid);
    }
    run("initdb", [
      "-D",
      data,
      "-U",
      "postgres",
      "-A",
      "trust",
      "-E",
      "UTF8",
      "--no-locale",
      "--no-sync",
    ]);
    appendFileSync(
      join(data, "postgresql.conf"),
      [
        "",
        "# Throwaway gate server (scripts/test-database.mjs).",
        "listen_addresses = ''",
        `unix_socket_directories = ${confString(dir)}`,
        "unix_socket_permissions = 0700",
        "fsync = off",
        "synchronous_commit = off",
        "full_page_writes = off",
        "max_connections = 100",
        "",
      ].join("\n"),
    );
    started = true;
    run("pg_ctl", ["-D", data, "-l", logFile, "-w", "-t", "60", "start"]);
    log(`Started a throwaway PostgreSQL in ${dir} (socket only).`);
    return { url: socketUrl(dir), stop };
  } catch (error) {
    stop();
    throw error;
  }
}
