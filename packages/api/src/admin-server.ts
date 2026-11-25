/**
 * The admin's server as one piece (T-045, D-081): the staff API (D-079),
 * the sign-in routes (sign-in-api.ts) and the built admin (admin-files.ts)
 * on the Fastify server of D-051/D-058, with the startup checks D-068 and
 * D-077 ask for. `buildAdminServer` **refuses to start** (throws, naming the
 * variable but never its value) when:
 *
 * - `OCULUS_SECRET_KEY` is missing, malformed or weak (`loadSecretKeyring`,
 *   D-077): two-step sign-in can't work without it;
 * - in production, the client address can't be told apart: no
 *   `OCULUS_TRUSTED_PROXY` is set and `OCULUS_CLIENT_ADDRESS` isn't
 *   `direct` (D-068: behind a proxy not configured as trusted, every client
 *   has the proxy's address and shares one throttle counter, so 20 wrong
 *   passwords by anyone make everyone wait). In development (`NODE_ENV`
 *   `development` or `test`) the server runs on localhost, where one
 *   address is expected;
 * - no mail sender can be made (`mailerFromEnv`, mail.ts, D-085): in
 *   production SMTP must be configured (`OCULUS_SMTP_HOST`,
 *   `OCULUS_MAIL_FROM`, `OCULUS_ADMIN_ORIGIN`) and the development
 *   sender's variables must not be set. In development without SMTP, the
 *   development sender logs only the message's kind, never the token or
 *   the address (D-068's secrecy rule). A `mailer` or `deliverReset` passed
 *   in is used as it is;
 * - `OCULUS_ADMIN_ORIGIN` is set but isn't one of `OCULUS_ORIGINS`, or the
 *   admin build can't be read; in production, it isn't set (T-050a, D-090:
 *   the staff API is then answered on the admin's host only);
 * - `OCULUS_PUBLIC_SITES` is wrong (public-sites.ts), names a site that
 *   doesn't exist, or is set without a public reader connection
 *   (`publicDb`); or that connection, whenever one is given, could read more
 *   than the public read path (`checkPublicReaderConnection`, D-080);
 * - `OCULUS_FILES_DIR` (M-002, D-086) is missing, not an absolute path, or
 *   not an existing writable directory, or the caps `OCULUS_FILE_MAX_MIB`
 *   (default 500) or `OCULUS_FILES_TOTAL_MAX_MIB` (per organization,
 *   default 20480) or the free-space floor `OCULUS_FILES_MIN_FREE_MIB`
 *   (default: 5% of the disk or 2 GiB, whichever is smaller) aren't whole
 *   numbers in range. Stale temporary files and copies no row names are
 *   swept at startup and every 15 minutes.
 *
 * It warns loudly (a `startup_warning` log record) when the database
 * server's `log_parameter_max_length_on_error` is above 0, since pg's
 * error `where` then carries bound values (D-068); Oculus's own logs never
 * write `where` (`redactedError`), but the database's own log would.
 *
 * Production is anything but `NODE_ENV=development` or `test`, so a missing
 * `NODE_ENV` gets the strict checks.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadSecretKeyring,
  sql,
  type Database,
  type EnrolmentDelivery,
  type InvitationDelivery,
  type PasswordResetDelivery,
} from "@oculus/db";
import {
  createService,
  openFileStore,
  type FileStore,
  type FileStoreProblem,
} from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { ADMIN_ORIGIN_ENV, loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { originsFromEnv } from "./origin.js";
import { isProduction } from "./environment.js";
import { mailerFromEnv, type Mailer } from "./mail.js";
import { trustedProxyFromEnv } from "./proxy.js";
import { PUBLIC_DATABASE_URL_ENV, checkPublicSites, publicSitesFromEnv } from "./public-sites.js";
import type { OculusRoute } from "./routes.js";
import { UPLOAD_TIMEOUTS, buildServer, type ServerOptions } from "./server.js";
import { signInRoutes, type SignInApiOptions } from "./sign-in-api.js";
import {
  redactedError,
  serviceErrorLogger,
  staffApiRoutes,
  type ApiLogRecord,
} from "./staff-api.js";
import { updateManagerFromEnv, type UpdateManager } from "./update-manager.js";

export { isProduction };

export const CLIENT_ADDRESS_ENV = "OCULUS_CLIENT_ADDRESS";
export const FILES_DIR_ENV = "OCULUS_FILES_DIR";
export const FILE_MAX_ENV = "OCULUS_FILE_MAX_MIB";
export const FILES_TOTAL_MAX_ENV = "OCULUS_FILES_TOTAL_MAX_MIB";
export const FILES_MIN_FREE_ENV = "OCULUS_FILES_MIN_FREE_MIB";

/** Why the files folder was refused, as the startup error says it (never the path). */
const FILE_STORE_PROBLEMS: Readonly<Record<FileStoreProblem, string>> = {
  no_store: "no files folder is configured.",
  other_install:
    "the folder belongs to another Oculus install (its .oculus-store-id names another database). Give this install a folder of its own.",
  marker_missing:
    "this database has used a files folder before, and this folder has no .oculus-store-id. Set OCULUS_FILES_DIR to the folder this database used (restore that folder from backup if it was lost).",
  not_empty:
    "the folder isn't empty and has no .oculus-store-id. Give Oculus an empty folder of its own.",
};

/** Temporary upload files older than this are swept: twice an upload's whole limit. */
export const INCOMING_MAX_AGE_MS = 2 * UPLOAD_TIMEOUTS.request;
/** How often the file sweep runs (and once at startup). */
export const FILE_SWEEP_EVERY_MS = 15 * 60_000;

/** A cap in MiB from the environment, as bytes; throws naming the variable, never the value. */
function mibFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const text = env[name];
  if (text === undefined || text.trim() === "") return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(text.trim())) {
    throw new Error(`refusing to start: ${name} must be a whole number of MiB from 1 to 1048576.`);
  }
  const mib = Number(text.trim());
  if (mib > 1_048_576) {
    throw new Error(`refusing to start: ${name} must be a whole number of MiB from 1 to 1048576.`);
  }
  return mib * 1024 * 1024;
}

/**
 * The file store from `OCULUS_FILES_DIR` and the two caps (D-086). Refuses
 * (throws) without the folder: uploads are part of the admin.
 */
export async function fileStoreFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Promise<FileStore> {
  const dir = env[FILES_DIR_ENV];
  if (dir === undefined || dir.trim() === "") {
    throw new Error(`refusing to start: ${FILES_DIR_ENV} must name the folder files are kept in.`);
  }
  const maxFileBytes = mibFromEnv(env, FILE_MAX_ENV);
  const maxOrganizationBytes = mibFromEnv(env, FILES_TOTAL_MAX_ENV);
  const minFree = env[FILES_MIN_FREE_ENV];
  let minFreeBytes: number | undefined;
  if (minFree !== undefined && minFree.trim() !== "") {
    if (!/^(0|[1-9][0-9]{0,6})$/.test(minFree.trim())) {
      throw new Error(`refusing to start: ${FILES_MIN_FREE_ENV} must be a whole number of MiB.`);
    }
    minFreeBytes = Number(minFree.trim()) * 1024 * 1024;
  }
  try {
    return await openFileStore({
      dir,
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
      ...(maxOrganizationBytes === undefined ? {} : { maxOrganizationBytes }),
      ...(minFreeBytes === undefined ? {} : { minFreeBytes }),
    });
  } catch (error) {
    // openFileStore's messages name no path.
    throw new Error(
      `refusing to start: ${FILES_DIR_ENV}: ${error instanceof Error ? error.message : "unusable"}`,
      { cause: error },
    );
  }
}

/** Where the admin build is, from this file (dist or src, both two levels under the repo's packages). */
export const DEFAULT_ADMIN_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "admin",
  "dist",
);

export interface AdminServerOptions {
  /** The writer's pool (D-067). */
  readonly db: Database;
  /**
   * The public sites' pool, connected as a public reader role (D-080,
   * T-050a): checked at startup; required when `OCULUS_PUBLIC_SITES` lists
   * any. Never used for anything else.
   */
  readonly publicDb?: Database;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The mail sender (mail.ts, D-085); default: `mailerFromEnv(env)`. Whoever
   * passes one closes it.
   */
  readonly mailer?: Mailer;
  /** Sends password reset links in place of the mailer's (tests). */
  readonly deliverReset?: PasswordResetDelivery;
  /**
   * Send invitations and the set-up token after a reset of two-step sign-in
   * in place of the mailer's (tests). By default the mailer's (D-085). A
   * test that passes only `deliverReset` gets no mailer, and the matching
   * people route then answers 503 `delivery_unavailable`.
   */
  readonly deliverInvitation?: InvitationDelivery;
  readonly deliverEnrolment?: EnrolmentDelivery;
  /** The admin build's folder (default: packages/admin/dist). */
  readonly adminDir?: string;
  /** Already-loaded admin files (tests). */
  readonly adminFiles?: AdminFiles;
  /** Fixed-shape log records; default: one JSON line on standard error. */
  readonly log?: (record: ApiLogRecord) => void;
  /** Fastify's request log (method and path only, D-058). */
  readonly logger?: ServerOptions["logger"];
  /** Routes of the program that starts the server (the desktop launcher's instance check, D-088). */
  readonly extraRoutes?: readonly OculusRoute[];
  /** Passed on to the sign-in routes (tests). */
  readonly signIn?: Pick<SignInApiOptions, "rateLimits" | "clock" | "resetOptions">;
  /**
   * Software updates (T-060, D-092). Default: built from `OCULUS_UPDATE_DIR`
   * and the other `OCULUS_UPDATE_*` variables (none set: the screen says how
   * to set it up). `null` turns the routes off (tests).
   */
  readonly updates?: UpdateManager | null;
  /** Asked for after an install or rollback when `OCULUS_UPDATE_RESTART=exit` (admin-cli.ts). */
  readonly requestRestart?: () => void;
}

/** The default log: one JSON line on standard error. */
export function defaultLog(record: ApiLogRecord): void {
  try {
    process.stderr.write(`${JSON.stringify({ oculus: record })}\n`);
  } catch {
    // Logging can't stop the server.
  }
}

/**
 * Why the client address can't be relied on, or `undefined` (D-068): in
 * production a trusted proxy must be named, or `OCULUS_CLIENT_ADDRESS=direct`
 * must say the server faces clients itself.
 */
export function clientAddressProblem(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const proxy = trustedProxyFromEnv(env);
  const declared = env[CLIENT_ADDRESS_ENV];
  if (declared !== undefined && declared !== "direct") {
    return `${CLIENT_ADDRESS_ENV} may only be "direct"`;
  }
  if (!isProduction(env) || proxy !== false || declared === "direct") return undefined;
  return (
    "refusing to start: the client address can't be told apart. Behind a proxy, set " +
    "OCULUS_TRUSTED_PROXY to its address; facing clients directly, set OCULUS_CLIENT_ADDRESS=direct. " +
    "Otherwise every client shares one sign-in throttle (D-068)."
  );
}

/** Builds the admin's server, ready to `listen` (or `inject` in tests). */
export async function buildAdminServer(options: AdminServerOptions): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const log = options.log ?? defaultLog;
  const production = isProduction(env);

  // D-077: refuse to start without a usable key. The error names the
  // variable and the reason, never the value.
  const keys = loadSecretKeyring(env);

  const addressProblem = clientAddressProblem(env);
  if (addressProblem !== undefined) throw new Error(addressProblem);

  // D-085: a real sender in production, the development one (which logs
  // the kind only) elsewhere. Made before anything else starts, so a
  // refusal leaves nothing running.
  let deliverReset = options.deliverReset;
  let mailer: Mailer | undefined;
  if (deliverReset === undefined) {
    mailer = options.mailer ?? mailerFromEnv(env, { log });
    deliverReset = mailer.deliverReset;
  }
  const deliverInvitation = options.deliverInvitation ?? mailer?.deliverInvitation;
  const deliverEnrolment = options.deliverEnrolment ?? mailer?.deliverEnrolment;

  const adminOrigin = env[ADMIN_ORIGIN_ENV];
  if (production && (adminOrigin === undefined || adminOrigin === "")) {
    throw new Error(
      `refusing to start: ${ADMIN_ORIGIN_ENV} must name the admin's own origin in production, so the staff API answers on that host only (D-052, D-090).`,
    );
  }
  // Public hosts and their reader (T-050a): checked now, so a wrong
  // connection or site never serves a request. T-050b's public routes use them.
  const publicHosts = publicSitesFromEnv(env, originsFromEnv(env), adminOrigin);
  if (publicHosts.length > 0 && options.publicDb === undefined) {
    throw new Error(
      `refusing to start: OCULUS_PUBLIC_SITES lists public sites but ${PUBLIC_DATABASE_URL_ENV} gives no public reader connection (D-080).`,
    );
  }
  if (options.publicDb !== undefined) {
    await checkPublicSites(options.db, options.publicDb, publicHosts);
  }

  let admin: ServerOptions["admin"];
  if (adminOrigin !== undefined && adminOrigin !== "") {
    admin = {
      origin: adminOrigin,
      files: options.adminFiles ?? loadAdminFiles(options.adminDir ?? DEFAULT_ADMIN_DIR),
    };
  }

  try {
    const rows = await options.db.rows<{ setting: string }>(
      sql`SELECT current_setting('log_parameter_max_length_on_error') AS setting`,
    );
    if (rows[0]?.setting !== "0") {
      log({ event: "startup_warning", code: "log_parameter_max_length_on_error" });
    }
  } catch {
    log({ event: "startup_warning", code: "database_unreadable" });
  }

  // D-092: a malformed update setting stops the start, naming the variable only.
  const updates =
    options.updates === null
      ? null
      : (options.updates ??
        updateManagerFromEnv(env, {
          ...(options.requestRestart === undefined
            ? {}
            : { requestRestart: options.requestRestart }),
          log: (event, fields) => {
            log({
              event: "update_event",
              operation: event,
              ...(fields.version === undefined ? {} : { code: fields.version }),
            });
          },
        }));

  const files = await fileStoreFromEnv(env);
  const service = createService(options.db, { onError: serviceErrorLogger(log), files });
  const routes = [
    ...staffApiRoutes({
      db: options.db,
      service,
      log,
      files,
      people: {
        keys,
        deliverReset,
        // D-085: the mailer feeds every people route that sends mail.
        ...(deliverInvitation === undefined ? {} : { deliverInvitation }),
        ...(deliverEnrolment === undefined ? {} : { deliverEnrolment }),
      },
      ...(updates === null ? {} : { updates: { manager: updates } }),
    }),
    ...signInRoutes({
      db: options.db,
      keys,
      service,
      deliverReset,
      ...(mailer === undefined ? {} : { deliverPasswordChanged: mailer.deliverPasswordChanged }),
      log,
      warnSharedAddress: production,
      ...options.signIn,
    }),
    ...(options.extraRoutes ?? []),
  ];
  // Stale temporary files and copies no row names (D-086): now, then on a
  // timer that stops with the server.
  // The files folder must be this install's (D-086, review B1).
  let bound: Awaited<ReturnType<typeof service.bindFileStore>>;
  try {
    bound = await service.bindFileStore();
  } catch (error) {
    // A file system error's message holds the path: only its code is shown.
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `refusing to start: ${FILES_DIR_ENV}: the folder couldn't be prepared (${typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : "error"}).`,
      { cause: error },
    );
  }
  if (bound.ok && bound.warning === "database_changed") {
    // A restored or copied database on this folder: it starts, but it
    // never sweeps until an operator says this is the database now (D-086).
    log({ event: "startup_warning", code: "files_database_changed" });
  }
  if (!bound.ok) {
    throw new Error(`refusing to start: ${FILES_DIR_ENV}: ${FILE_STORE_PROBLEMS[bound.problem]}`);
  }
  const sweep = async (): Promise<void> => {
    try {
      const swept = await service.sweepFiles(INCOMING_MAX_AGE_MS);
      if (swept.skipped > 0) log({ event: "startup_warning", code: "files_sweep_skipped" });
      if (swept.halted !== undefined) {
        log({ event: "startup_warning", code: `files_sweep_${swept.halted}` });
      }
      if (swept.failed > 0)
        log({ event: "service_error", operation: "sweepFiles", code: "partial" });
    } catch (error) {
      log({ event: "service_error", operation: "sweepFiles", ...redactedError(error) });
    }
  };
  await sweep();
  const app = await buildServer({
    env,
    routes,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(admin === undefined ? {} : { admin }),
  });
  const timer = setInterval(() => void sweep(), FILE_SWEEP_EVERY_MS);
  timer.unref();
  app.server.once("close", () => {
    clearInterval(timer);
  });
  return app;
}
