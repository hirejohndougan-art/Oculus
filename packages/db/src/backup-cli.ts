/**
 * `npm run db:backup -- <file>`: writes a backup of the database named by
 * OCULUS_DATABASE_URL to a new file (D-064). The URL is never printed or put
 * on a command line. Exit codes: 0 done, 1 refused or failed, 2 usage.
 * Any scheduler (cron, a host's scheduler) can run it (D-035).
 */
import { pathToFileURL } from "node:url";
import { backup, restore, BackupError, hideSecrets } from "./backup.js";
import { DATABASE_URL_VARIABLE } from "./migrate-cli.js";

type Line = (line: string) => void;

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

function report(error: unknown, what: string, err: Line): number {
  if (error instanceof BackupError) {
    err(`${what} refused (${error.code}): ${error.message}`);
  } else {
    const code = (error as { code?: unknown }).code;
    err(
      `${what} failed: ${(error as Error).message}${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }
  return 1;
}

/** Runs `db:backup`; returns the exit code. */
export async function runBackupCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: Line,
  err: Line,
): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0] === "" || args[0].startsWith("-")) {
    err("Usage: npm run db:backup -- <new backup file>");
    return 2;
  }
  const connectionString = databaseUrl(env, err);
  if (connectionString === undefined) return 2;
  ({ out, err } = hideSecrets(connectionString, out, err));
  try {
    const result = await backup({ connectionString, file: args[0], env, log: out });
    const rows = result.manifest.tables.reduce((sum, t) => sum + BigInt(t.rows), 0n);
    out(
      `Done: ${result.file} (${String(result.manifest.dump.bytes)} bytes of archive, ${String(result.manifest.tables.length)} tables, ${String(rows)} rows, ${String(result.manifest.migrations.length)} migrations).`,
    );
    return 0;
  } catch (error) {
    return report(error, "Backup", err);
  }
}

/** Runs `db:restore`; returns the exit code. */
export async function runRestoreCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: Line,
  err: Line,
): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0] === "" || args[0].startsWith("-")) {
    err(
      "Usage: npm run db:restore -- <backup file>   (into the empty database in OCULUS_DATABASE_URL)",
    );
    return 2;
  }
  const connectionString = databaseUrl(env, err);
  if (connectionString === undefined) return 2;
  ({ out, err } = hideSecrets(connectionString, out, err));
  try {
    const result = await restore({ connectionString, file: args[0], env, log: out });
    const rows = result.manifest.tables.reduce((sum, t) => sum + BigInt(t.rows), 0n);
    out(
      `Done: restored and checked ${String(result.manifest.tables.length)} tables, ${String(rows)} rows, ${String(result.manifest.migrations.length)} migrations.`,
    );
    if (result.pending.length > 0) {
      out(
        `This version of Oculus has ${String(result.pending.length)} newer migration(s) (${result.pending.join(", ")}): run npm run db:migrate next.`,
      );
    }
    return 0;
  } catch (error) {
    return report(error, "Restore", err);
  }
}

const command = process.argv[1];
if (command !== undefined && import.meta.url === pathToFileURL(command).href) {
  const [verb, ...rest] = process.argv.slice(2);
  const run = verb === "restore" ? runRestoreCli : verb === "backup" ? runBackupCli : undefined;
  process.exitCode =
    run === undefined
      ? (console.error("Usage: node backup-cli.js backup|restore <file>"), 2)
      : await run(
          rest,
          process.env,
          (line) => {
            console.log(line);
          },
          (line) => {
            console.error(line);
          },
        );
}
