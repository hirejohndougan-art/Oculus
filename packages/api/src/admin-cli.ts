/**
 * `npm run admin` (after `npm run build`): starts the admin's server
 * (admin-server.ts) for the database named by `OCULUS_DATABASE_URL`, on
 * `OCULUS_HOST` (default 127.0.0.1) and `OCULUS_PORT` (default 3000). The
 * URL, the secret key and every other value stay out of the output; a
 * refusal to start prints only its reason and exits 1.
 *
 * Deployment (D-035, T-050, T-051) decides how this runs in production.
 * Email goes through the mailer the environment configures (mail.ts,
 * D-085): SMTP in production (it refuses to start without it), the
 * development sender otherwise. The two-step alert notices run every minute
 * (alert-notices.ts). The notices, the mailer's outbox and the server are
 * closed on SIGINT and SIGTERM.
 */
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { buildAdminServer, defaultLog } from "./admin-server.js";
import { startAlertNotices, type AlertNoticeRunner } from "./alert-notices.js";
import { mailerFromEnv, type Mailer } from "./mail.js";

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
  let mailer: Mailer | undefined;
  let notices: AlertNoticeRunner | undefined;
  try {
    mailer = mailerFromEnv(env, { log: defaultLog });
    const app = await buildAdminServer({ db, env, logger: true, mailer, log: defaultLog });
    // "Someone is guessing your two-step codes" (D-077, D-085), every minute.
    notices = startAlertNotices({ db, deliver: mailer.deliverAlert, log: defaultLog });
    const close = (): void => {
      void app
        .close()
        .then(() => notices?.stop())
        .then(() => mailer?.close())
        .then(() => db.close());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await app.listen({ host: env.OCULUS_HOST ?? "127.0.0.1", port });
    return undefined;
  } catch (error) {
    await notices?.stop();
    await mailer?.close();
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
