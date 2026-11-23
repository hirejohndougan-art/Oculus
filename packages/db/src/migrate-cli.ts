/**
 * `npm run db:migrate`: applies every pending migration to the database named
 * by the OCULUS_DATABASE_URL environment variable (D-057). The URL is never
 * printed, since it may hold a password.
 */
import { pathToFileURL } from "node:url";
import { migrate, MigrationError } from "./migrate.js";

export const DATABASE_URL_VARIABLE = "OCULUS_DATABASE_URL";

/** Runs the command; returns the exit code. */
export async function runMigrateCli(
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const connectionString = env[DATABASE_URL_VARIABLE];
  if (connectionString === undefined || connectionString.trim() === "") {
    err(
      `${DATABASE_URL_VARIABLE} is not set. Set it to the database to migrate, e.g. postgresql://user@host:5432/oculus (put any password in ~/.pgpass or PGPASSWORD, not in a file in the repository).`,
    );
    return 2;
  }
  try {
    const result = await migrate({ connectionString, log: out });
    out(`Done: ${String(result.applied.length)} migration(s) applied.`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      err(`Migration refused (${error.code}): ${error.message}`);
    } else {
      const code = (error as { code?: unknown }).code;
      err(
        `Migration failed: ${(error as Error).message}${typeof code === "string" ? ` (${code})` : ""}`,
      );
    }
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMigrateCli(
    process.env,
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
