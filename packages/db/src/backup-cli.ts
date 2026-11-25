/**
 * `npm run db:backup -- <new file>` and
 * `npm run db:restore -- [--allow-superuser] [--no-privileges] <file>`
 * (D-064), for the database named by OCULUS_DATABASE_URL. The URL is never
 * printed or put on a command line. A relative path is taken from the
 * directory npm was run in (INIT_CWD), else the current one. SIGINT, SIGTERM
 * and SIGHUP stop the tool, remove every temporary file and exit 1; a second
 * signal, or the stop taking longer than 30 seconds, exits at once, still
 * killing the tool and removing the temporary files synchronously
 * (backup-cleanup.ts). A restore that had already committed when the stop
 * came is checked and reported, and exits 0 if it is good.
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
  /** Restore only: called once pg_restore has committed. */
  onCommitted?: () => void;
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
  const flags = new Set(["--allow-superuser", "--no-privileges"]);
  const allowSuperuser = args.includes("--allow-superuser");
  const noPrivileges = args.includes("--no-privileges");
  const rest = args.filter((a) => !flags.has(a));
  const [arg] = rest;
  if (rest.length !== 1 || !usable(arg)) {
    err(
      "Usage: npm run db:restore -- [--allow-superuser] [--no-privileges] <backup file>   (into the empty database in OCULUS_DATABASE_URL)",
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
      noPrivileges,
      ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
      log: safe.out,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    });
    const rows = result.manifest.tables.reduce((sum, t) => sum + BigInt(t.rows), 0n);
    if (result.stoppedAfterCommit) {
      safe.err(
        "The stop came after pg_restore had committed, so the restore was not undone; it was checked and is complete.",
      );
    }
    safe.out(
      `Done: restored and checked ${String(result.manifest.tables.length)} tables, ${String(rows)} rows, ${String(result.manifest.migrations.length)} migrations.`,
    );
    const out = result.signedOut;
    safe.out(
      `Everyone is signed out: sign-ins from before the restore no longer work (${String(out.accounts)} accounts, ${String(out.sessions)} sessions from the backup ended, ${String(out.resetLinks)} pending password reset links cancelled).`,
    );
    safe.out(
      `Everything changed since the backup (made ${result.manifest.createdAt}) is undone, including passwords, two-step set-ups, recovery codes used since, roles, and accounts disabled since: check them in People before people sign in again.`,
    );
    if (out.pendingInvitations > 0) {
      safe.out(
        `${String(out.pendingInvitations)} invitation(s) from the backup are still pending: revoke in People any that shouldn't stand.`,
      );
    }
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

/** Signals this close to the first are the same stop (one Ctrl-C can arrive twice). */
export const SAME_STOP_MS = 1000;

const command = process.argv[1];
if (command !== undefined && import.meta.url === pathToFileURL(command).href) {
  const [verb, ...rest] = process.argv.slice(2);
  const run = verb === "restore" ? runRestoreCli : verb === "backup" ? runBackupCli : undefined;
  if (run === undefined) {
    console.error("Usage: node backup-cli.js backup|restore <file>");
    process.exitCode = 2;
  } else {
    // Before pg_restore commits (and for a backup), a signal stops the tool
    // and cleans up; a second one, or the grace period passing, exits at
    // once. Exiting runs backup-cleanup.ts's synchronous handler: the tool's
    // group is killed and every temporary file removed. Once pg_restore has
    // committed, a stop can't undo the restore, so the check of the restored
    // database is let finish (no grace period); a second signal then exits 3
    // saying the database was restored but NOT checked.
    // One Ctrl-C can arrive as two signals a few milliseconds apart (the
    // terminal's to the whole process group, and npm or a service manager
    // passing its own on), so signals within SAME_STOP_MS of the first are the
    // same stop; only a later one counts as a second. Once the command has
    // finished, signals are ignored, so none can replace its exit code.
    // (OCULUS_STOP_GRACE_MS shortens the grace, for tests.)
    const grace = Number(process.env.OCULUS_STOP_GRACE_MS ?? "") || 30_000;
    const controller = new AbortController();
    let committed = false;
    let stopAsked = false;
    let firstStopAt = 0;
    let finished = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finishing = (): void => {
      console.error(
        "pg_restore has already committed, so the restore can't be undone; finishing the check of the restored database before exiting. Signal again to exit without the check.",
      );
    };
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(name, () => {
        if (finished) return;
        if (stopAsked && Date.now() - firstStopAt < SAME_STOP_MS) return;
        if (!stopAsked) firstStopAt = Date.now();
        if (committed) {
          if (stopAsked) {
            console.error(
              `Stopping at once (${name}): the backup was restored but NOT checked. Do not use the database until it is checked: drop it and restore again.`,
            );
            process.exit(3);
          }
          stopAsked = true;
          finishing();
          return;
        }
        if (stopAsked) {
          console.error(`Stopping at once (${name}).`);
          process.exit(1);
        }
        stopAsked = true;
        console.error(`Stopping (${name})...`);
        controller.abort();
        graceTimer = setTimeout(() => {
          console.error("Stopping took too long; exiting.");
          process.exit(1);
        }, grace);
        graceTimer.unref();
      });
    }
    const onCommitted = (): void => {
      committed = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (stopAsked) finishing();
    };
    const code = await run(
      rest,
      process.env,
      (line) => {
        console.log(line);
      },
      (line) => {
        console.error(line);
      },
      { signal: controller.signal, onCommitted },
    );
    finished = true;
    process.exitCode = code;
  }
}
