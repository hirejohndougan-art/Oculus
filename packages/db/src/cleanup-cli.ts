/**
 * `npm run db:cleanup`: deletes ended sessions and sign-in counters no longer
 * needed (T-037, D-052, D-068, D-069) in the database named by
 * OCULUS_DATABASE_URL. Any scheduler can run it (D-035); hourly is plenty,
 * and lookups refuse ended sessions whether or not it runs. Connect as the
 * writer role. The URL is never printed, since it may hold a password.
 */
import { pathToFileURL } from "node:url";
import { ConnectionError } from "./backup-connection.js";
import { openDatabase, type Database } from "./client.js";
import { DATABASE_URL_VARIABLE } from "./migrate-cli.js";
import { runCleanup } from "./sessions.js";

/** Runs the command; returns the exit code. */
export async function runCleanupCli(
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const connectionString = env[DATABASE_URL_VARIABLE];
  if (connectionString === undefined || connectionString.trim() === "") {
    err(
      `${DATABASE_URL_VARIABLE} is not set. Set it to the database to clean up, connecting as the writer role (put any password in ~/.pgpass or PGPASSWORD, not in a file in the repository).`,
    );
    return 2;
  }
  let db: Database;
  try {
    db = openDatabase(connectionString, { max: 1, applicationName: "oculus-cleanup" });
  } catch (error) {
    // A URL refused before connecting (S-017): its message never shows a value.
    if (error instanceof ConnectionError) {
      err(`Cleanup refused (${error.code}): ${error.message}`);
      return 2;
    }
    throw error;
  }
  try {
    const done = await runCleanup(db);
    out(
      `Done: ${String(done.sessions)} ended session(s) and ${String(done.signInThrottles)} old sign-in counter(s) deleted; ${String(done.secondStepThrottles)} old wrong-code counter(s) deleted.`,
    );
    return 0;
  } catch (error) {
    // The SQLSTATE only: a driver message can name the host or the role.
    const code = (error as { code?: unknown }).code;
    err(`Cleanup failed${typeof code === "string" ? ` (${code})` : ""}.`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCleanupCli(
    process.env,
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
