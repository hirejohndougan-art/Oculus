// A throwaway PostgreSQL server for the gate (D-049, D-057): initdb into a new
// temporary directory, listen only on a Unix socket in that directory (no TCP
// port), trust authentication on that private socket (no password anywhere),
// fsync off. `stop()` stops the server and deletes the directory; if the
// server can't be stopped, the directory is left in place and reported rather
// than deleted under a running server.
//
// Under uid 0 (the build sandbox runs as root, and initdb refuses root) the
// server commands run as the `postgres` system user through `runuser`, with the
// directory owned by that user. Either way they get a minimal environment, not
// the caller's, and the server settings go on pg_ctl's command line; nothing
// is written into the data directory by this process.
import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The directory holding initdb and pg_ctl, or undefined if none is found. */
export function findPostgresBin(env = process.env) {
  const usable = (dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"));
  if (env.PG_BIN) return usable(env.PG_BIN) ? env.PG_BIN : undefined;
  try {
    const dir = execFileSync("pg_config", ["--bindir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return usable(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** A connection URL for a Unix socket directory, as pg-connection-string reads it. */
export function socketUrl(socketDir, database = "postgres") {
  return `postgresql://postgres@localhost/${database}?host=${encodeURIComponent(socketDir)}`;
}

/** The only environment the server commands see. */
export function serverEnvironment(env = process.env) {
  return { PATH: env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}

/**
 * pg_ctl hands `-o` to a shell, so the directory (the socket path) may hold
 * only characters that need no quoting there.
 */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** The postgres options: no TCP, socket in `dir` (owner only), durability off. */
export function serverOptions(dir) {
  if (!SAFE_PATH.test(dir)) {
    throw new Error(`The temporary directory ${dir} has characters pg_ctl can't pass on safely.`);
  }
  return [
    "-h ''",
    `-k ${dir}`,
    "-F",
    "-c unix_socket_permissions=0700",
    "-c synchronous_commit=off",
    "-c full_page_writes=off",
    "-c max_connections=100",
  ].join(" ");
}

/**
 * Starts a throwaway server. Returns `{ url, dir, stop }`. Throws (after
 * cleaning up) if the server can't be started.
 */
export function startTestDatabase({ bin, log = console.log } = {}) {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const dir = mkdtempSync(join(tmpdir(), "oculus-pg-"));
  const data = join(dir, "data");
  const logFile = join(dir, "server.log");
  const env = serverEnvironment();
  let started = false;
  let stopped = false;

  const run = (program, args) => {
    const [cmd, argv] = asRoot
      ? ["runuser", ["-u", "postgres", "--", join(bin, program), ...args]]
      : [join(bin, program), args];
    const result = spawnSync(cmd, argv, { cwd: dir, env, encoding: "utf8" });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(`${program} failed (${result.status ?? result.signal}): ${output}`);
    }
  };

  const running = () => {
    try {
      run("pg_ctl", ["-D", data, "status"]);
      return true;
    } catch {
      return false;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (started) {
      for (const mode of ["fast", "immediate"]) {
        try {
          run("pg_ctl", ["-D", data, "-m", mode, "-w", "-t", "30", "stop"]);
          break;
        } catch (error) {
          if (!running()) break;
          console.error(`Could not stop the test database (${mode}): ${error.message}`);
        }
      }
      if (running()) {
        console.error(
          `The test database in ${dir} is still running, so its directory was not deleted. Stop it with: pg_ctl -D ${data} -m immediate stop`,
        );
        return;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const options = serverOptions(dir);
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
    started = true;
    run("pg_ctl", ["-D", data, "-l", logFile, "-o", options, "-w", "-t", "60", "start"]);
    log(`Started a throwaway PostgreSQL in ${dir} (socket only).`);
    return { url: socketUrl(dir), dir, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
