/**
 * `npm run db:backup -- <new file>` and `npm run db:restore -- [--allow-superuser] <file>`
 * (D-064), for the database named by OCULUS_DATABASE_URL. The URL is never
 * printed or put on a command line. A relative path is taken from the
 * directory npm was run in (INIT_CWD), else the current one. SIGINT, SIGTERM
 * and SIGHUP stop the tool, remove every temporary file and exit 1.
 * Exit codes: 0 done, 1 refused, failed or stopped, 2 usage. Any scheduler
 * (cron, a host's scheduler) can run them (D-035).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, restore, BackupError } from "./backup.js";
import { redact, secretsOf } from "./backup-connection.js";
import { DATABASE_URL_VARIABLE } from "./migrate-cli.js";

type Line = (line: string) => void;

export interface CliOptions {
  /** Aborted by the signal handlers of the command itself. */
  signal?: AbortSignal;
  /** For tests: where the private temporary directories go. */
  tempDir?: string;
}

function databaseUrl(env: Record<string, string | undefined>, err: Line): string | undefined {
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    err(
      `${DATABASE_URL_VARIABLE} is not set. Set it to the database, e.g. postgresql://user@host:5432/oculus (put any password in ~/.pgpass or PGPASSWORD, not in a file in the repository).`,
    );
    return undefined;
  }
  return url;
}

/**
 * Wraps output so nothing printed can show the URL or its password, whatever
 * a driver or tool put in a message.
 */
export function hideSecrets(
  connectionString: string,
  out: Line,
  err: Line,
): { out: Line; err: Line } {
  const secrets = secretsOf(connectionString);
  return {
    out: (line) => {
      out(redact(line, secrets));
    },
    err: (line) => {
      err(redact(line, secrets));
    },
  };
}

function report(error: unknown, what: string, err: Line): number {
  if (error instanceof BackupError) {
    err(
      `${what} ${error.code === "interrupted" ? "stopped" : "refused"} (${error.code}): ${error.message}`,
    );
  } else {
    const code = (error as { code?: unknown }).code;
    err(
      `${what} failed: ${(error as Error).message}${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }
  return 1;
}

/** The file argument, relative to where npm was run (INIT_CWD), else the current directory. */
export function filePath(arg: string, env: Record<string, string | undefined>): string {
  const base = env.INIT_CWD !== undefined && env.INIT_CWD !== "" ? env.INIT_CWD : process.cwd();
  return resolve(base, arg);
}

const usable = (arg: string | undefined): arg is string =>
  arg !== undefined && arg !== "" && !arg.startsWith("-");

/** Runs `db:backup`; returns the exit code. */
export async function runBackupCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: Line,
  err: Line,
  options: CliOptions = {},
): Promise<number> {
  const [arg] = args;
  if (args.length !== 1 || !usable(arg)) {
    err("Usage: npm run db:backup -- <new backup file, e.g. oculus-2026-11-23.oculus-backup>");
    return 2;
  }
  const connectionString = databaseUrl(env, err);
  if (connectionString === undefined) return 2;
  const safe = hideSecrets(connectionString, out, err);
  try {
    const result = await backup({
      connectionString,
      file: filePath(arg, env),
      env,
      log: safe.out,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    });
    const rows = result.manifest.tables.reduce((sum, t) => sum + BigInt(t.rows), 0n);
    safe.out(
      `Done: ${result.file} (${String(result.manifest.dump.bytes)} bytes of archive, ${String(result.manifest.tables.length)} tables, ${String(rows)} rows, ${String(result.manifest.migrations.length)} migrations).`,
    );
    return 0;
  } catch (error) {
    return report(error, "Backup", safe.err);
  }
}

/** Runs `db:restore`; returns the exit code. */
export async function runRestoreCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: Line,
  err: Line,
  options: CliOptions = {},
): Promise<number> {
  const allowSuperuser = args.includes("--allow-superuser");
  const rest = args.filter((a) => a !== "--allow-superuser");
  const [arg] = rest;
  if (rest.length !== 1 || !usable(arg)) {
    err(
      "Usage: npm run db:restore -- [--allow-superuser] <backup file>   (into the empty database in OCULUS_DATABASE_URL)",
    );
    return 2;
  }
  const connectionString = databaseUrl(env, err);
  if (connectionString === undefined) return 2;
  const safe = hideSecrets(connectionString, out, err);
  try {
    const result = await restore({
      connectionString,
      file: filePath(arg, env),
      env,
      allowSuperuser,
      log: safe.out,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    });
    const rows = result.manifest.tables.reduce((sum, t) => sum + BigInt(t.rows), 0n);
    safe.out(
      `Done: restored and checked ${String(result.manifest.tables.length)} tables, ${String(rows)} rows, ${String(result.manifest.migrations.length)} migrations.`,
    );
    if (result.pending.length > 0) {
      safe.out(
        `This version of Oculus has ${String(result.pending.length)} newer migration(s) (${result.pending.join(", ")}): run npm run db:migrate next.`,
      );
    }
    return 0;
  } catch (error) {
    return report(error, "Restore", safe.err);
  }
}

const command = process.argv[1];
if (command !== undefined && import.meta.url === pathToFileURL(command).href) {
  const [verb, ...rest] = process.argv.slice(2);
  const run = verb === "restore" ? runRestoreCli : verb === "backup" ? runBackupCli : undefined;
  if (run === undefined) {
    console.error("Usage: node backup-cli.js backup|restore <file>");
    process.exitCode = 2;
  } else {
    // A signal stops the tool and cleans up; a second one, or 30 seconds
    // without the clean-up finishing, exits at once (the tools' watchdog
    // still ends them when this process is gone).
    const controller = new AbortController();
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(name, () => {
        if (controller.signal.aborted) process.exit(1);
        console.error(`Stopping (${name})...`);
        controller.abort();
        setTimeout(() => process.exit(1), 30_000).unref();
      });
    }
    const code = await run(
      rest,
      process.env,
      (line) => {
        console.log(line);
      },
      (line) => {
        console.error(line);
      },
      { signal: controller.signal },
    );
    process.exitCode = controller.signal.aborted ? 1 : code;
  }
}
