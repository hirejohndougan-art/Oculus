/**
 * `npm run admin` (after `npm run build`): starts the admin's server
 * (admin-server.ts) for the database named by `OCULUS_DATABASE_URL`, on
 * `OCULUS_HOST` (default 127.0.0.1) and `OCULUS_PORT` (default 3000), with
 * the public sites' reader connection from `OCULUS_PUBLIC_DATABASE_URL`
 * when it is set (T-050a, D-090), and then a one-connection staff pool for
 * the public Subjects counts (S-038, D-106). The
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
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { buildAdminServer, defaultLog } from "./admin-server.js";
import { startAlertNotices, type AlertNoticeRunner } from "./alert-notices.js";
import { mailerFromEnv, type Mailer } from "./mail.js";
import { PUBLIC_DATABASE_URL_ENV } from "./public-sites.js";
import { publicPoolOptions } from "./public-api.js";

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
  const publicUrl = env[PUBLIC_DATABASE_URL_ENV];
  let publicDb: ReturnType<typeof openDatabase> | undefined;
  if (publicUrl !== undefined && publicUrl.trim() !== "") {
    try {
      publicDb = openDatabase(publicUrl, publicPoolOptions(4));
    } catch {
      await db.close();
      err(`${PUBLIC_DATABASE_URL_ENV} is not a usable postgresql:// URL (its value is not shown).`);
      return 2;
    }
  }
  // The public Subjects counts' own pool on the staff role (S-038): one
  // connection, so a count never takes one from staff saves.
  const countsDb =
    publicDb === undefined
      ? undefined
      : openDatabase(url, { applicationName: "oculus-counts", max: 1 });
  const closePools = async (): Promise<void> => {
    // All of them, whatever happens to any.
    await Promise.allSettled([db.close(), publicDb?.close(), countsDb?.close()]);
  };
  let mailer: Mailer | undefined;
  let notices: AlertNoticeRunner | undefined;
  // Closed on a failed start too, so the Subjects counts stop before the pools (S-038).
  let built: { close: () => Promise<unknown> } | undefined;
  try {
    mailer = mailerFromEnv(env, { log: defaultLog });
    // After an update with OCULUS_UPDATE_RESTART=exit (T-060, D-092): stop
    // cleanly so the host's process manager starts the new version.
    let restarting = false;
    const restart = (): void => {
      if (restarting) return;
      restarting = true;
      void app
        .close()
        .then(() => notices?.stop())
        .then(() => mailer?.close())
        .then(closePools)
        .finally(() => process.exit(0));
    };
    const app = await buildAdminServer({
      db,
      env,
      logger: true,
      mailer,
      log: defaultLog,
      requestRestart: restart,
      ...(publicDb === undefined ? {} : { publicDb }),
      ...(countsDb === undefined ? {} : { countsDb }),
    });
    built = app;
    // "Someone is guessing your two-step codes" (D-077, D-085), every minute.
    const outbox = mailer.outbox;
    notices = startAlertNotices({
      db,
      deliver: mailer.deliverAlert,
      log: defaultLog,
      room: () => outbox.room("notice"),
    });
    const close = (): void => {
      void app
        .close()
        .then(() => notices?.stop())
        .then(() => mailer?.close())
        .then(closePools);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await app.listen({ host: env.OCULUS_HOST ?? "127.0.0.1", port });
    return undefined;
  } catch (error) {
    await built?.close().catch(() => undefined);
    await notices?.stop();
    await mailer?.close();
    await closePools();
    // Startup refusals name the variable and the reason, never a value.
    err(`Oculus did not start: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

// Through a link too: the host starts `<updates folder>/current/…` (T-060), and
// Node gives this module its real path.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const code = await runAdminCli(process.env, (line) => {
    console.error(line);
  });
  if (code !== undefined) process.exitCode = code;
}
