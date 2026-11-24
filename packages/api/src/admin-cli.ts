/**
 * `npm run admin` (after `npm run build`): starts the admin's server
 * (admin-server.ts) for the database named by `OCULUS_DATABASE_URL`, on
 * `OCULUS_HOST` (default 127.0.0.1) and `OCULUS_PORT` (default 3000). The
 * URL, the secret key and every other value stay out of the output; a
 * refusal to start prints only its reason and exits 1.
 *
 * Deployment (D-035, T-050, T-051) decides how this runs in production; this
 * command has no email sender, so it refuses to start in production until
 * T-040 gives it one (development only logs that a reset link was made).
 */
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { buildAdminServer } from "./admin-server.js";

const DATABASE_URL_VARIABLE = "OCULUS_DATABASE_URL";

/** Starts the server; resolves with the exit code if it doesn't start. */
export async function runAdminCli(
  env: Readonly<Record<string, string | undefined>>,
  err: (line: string) => void,
): Promise<number | undefined> {
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    err(`${DATABASE_URL_VARIABLE} is not set.`);
    return 2;
  }
  const port = Number(env.OCULUS_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    err("OCULUS_PORT must be a port number.");
    return 2;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(url, { applicationName: "oculus-admin" });
  } catch {
    // The parser's message can quote the URL, which may hold a password.
    err(`${DATABASE_URL_VARIABLE} is not a usable postgresql:// URL (its value is not shown).`);
    return 2;
  }
  try {
    const app = await buildAdminServer({ db, env, logger: true });
    const close = (): void => {
      void app.close().then(() => db.close());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await app.listen({ host: env.OCULUS_HOST ?? "127.0.0.1", port });
    return undefined;
  } catch (error) {
    await db.close();
    // Startup refusals name the variable and the reason, never a value.
    err(`Oculus did not start: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runAdminCli(process.env, (line) => {
    console.error(line);
  });
  if (code !== undefined) process.exitCode = code;
}
