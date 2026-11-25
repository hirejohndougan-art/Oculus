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
 *   numbers in range, or `OCULUS_FILES_AUTO_PURGE` is anything but `on` or
 *   `off`. Stale temporary files are swept at startup and every 15
 *   minutes. Removed files are purged only by a system manager's button or
 *   `npm run files:purge`, unless `OCULUS_FILES_AUTO_PURGE=on` (default
 *   off), which runs one purge step every 25 hours (S-052: a day and an
 *   hour, so a second step due a day after the first is never just missed);
 * - the virus scanner's settings (`OCULUS_CLAMD_*`, file-scanning.ts,
 *   S-040, D-113) are malformed. None set is fine: files are then
 *   `not_scanned` and served as before; in production that is logged as a
 *   `startup_warning` (`files_not_scanned`), and a scanner set up but not
 *   answering as `clamd_unreachable` (it is tried again by the queue).
 *
 * Once built, it also runs the background jobs every install needs (S-063),
 * stopped when the server closes: the cleanup of ended sessions, old
 * counters and reset links (cleanup-runner.ts, hourly) and the two-step
 * alert notices (alert-notices.ts, every minute, through the mailer; only
 * when SMTP is set up, since the development sender tells no one). `housekeeping: false` turns both off (tests). The desktop
 * launcher and `npm run admin` both start the server here, so both run them.
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
  databaseIdentity,
  loadSecretKeyring,
  sql,
  type Database,
  type EnrolmentDelivery,
  type InvitationDelivery,
  type PasswordResetDelivery,
} from "@oculus/db";
import {
  AUTOMATIC_PURGE_EVERY_MS,
  clamdScanner,
  createService,
  createThumbnailRenderer,
  FILE_LEASE_RENEW_MS,
  pingClamd,
  openFileStore,
  type FileStore,
  type FileStoreProblem,
} from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { ADMIN_ORIGIN_ENV, loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { startAlertNotices, type AlertNoticeRunner } from "./alert-notices.js";
import { startCleanup } from "./cleanup-runner.js";
import { scannerFromEnv } from "./file-scanning.js";
import { originsFromEnv } from "./origin.js";
import { isProduction } from "./environment.js";
import { MAIL_ENV, mailerFromEnv, type Mailer } from "./mail.js";
import { trustedProxyFromEnv } from "./proxy.js";
import { OAI_ADMIN_EMAIL_ENV, oaiAdminEmail, oaiPmhRoutes } from "./oai-pmh.js";
import { PUBLIC_POOL_SIZE, publicApiRoutes, ReadSlots } from "./public-api.js";
import { PublicSubjects, publicSubjectsRoutes } from "./public-subjects.js";
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
import { updateChangeLog } from "./update-change-log.js";
import { updateManagerFromEnv, type UpdateManager } from "./update-manager.js";

export { isProduction };

export const CLIENT_ADDRESS_ENV = "OCULUS_CLIENT_ADDRESS";
export const FILES_DIR_ENV = "OCULUS_FILES_DIR";
export const FILE_MAX_ENV = "OCULUS_FILE_MAX_MIB";
export const FILES_TOTAL_MAX_ENV = "OCULUS_FILES_TOTAL_MAX_MIB";
export const FILES_MIN_FREE_ENV = "OCULUS_FILES_MIN_FREE_MIB";
/** `on` runs one purge step every 25 hours (S-052); default `off`: nothing purges on a timer. */
export const FILES_AUTO_PURGE_ENV = "OCULUS_FILES_AUTO_PURGE";

/**
 * Whether the automatic purge is turned on: only `on` turns it on; unset,
 * empty or `off` leaves it off; anything else refuses to start.
 */
export function automaticPurgeFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[FILES_AUTO_PURGE_ENV]?.trim() ?? "";
  if (value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new Error(`refusing to start: ${FILES_AUTO_PURGE_ENV} must be on or off.`);
}

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
/** How often the folder's lease moves on (D-086: at most this long until a shared folder shows). */
export const FILE_LEASE_EVERY_MS = FILE_LEASE_RENEW_MS;

/**
 * What a server uses the files folder for: the database's identity, its
 * name and the server's port, so two servers of one database agree and two
 * databases never do. Read before the folder is bound, so nothing in it
 * depends on the binding.
 */
async function serverKey(db: Database): Promise<string> {
  const rows = await db.rows<{ name: string; port: number | null }>(
    sql`SELECT current_database() AS name, inet_server_port() AS port`,
  );
  const identity = await databaseIdentity(db);
  return encodeURIComponent(`${identity}|${rows[0]?.name ?? "-"}|${String(rows[0]?.port ?? "-")}`);
}

/** How often the scan queue looks for due scans (and once at startup; uploads kick it too). */
export const FILE_SCAN_EVERY_MS = 60_000;

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
  /**
   * A small pool of its own on the staff role (S-038): the public Subjects
   * counts are worked out on it in the background. Left out, `/subjects`
   * isn't served.
   */
  readonly countsDb?: Database;
  /**
   * OAI-PMH's own small pool on the staff role (S-051, `oaiPoolOptions`):
   * its list and datestamp reads wait a bounded time for a connection.
   * Left out (tests), they use `db`.
   */
  readonly oaiDb?: Database;
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
  /**
   * Server-side thumbnails (M-003, T-072, D-097): on by default; `false`
   * turns them off, and `GET .../thumbnail` then answers `422 no_thumbnail`.
   */
  readonly thumbnails?: boolean;
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
  /**
   * The background cleanup and two-step alert notices (S-063): on by
   * default; `false` turns both off. Shorter timings are for tests.
   */
  readonly housekeeping?: boolean | HousekeepingTimes;
}

/** The background jobs' timings (S-063); each left out keeps its default. */
export interface HousekeepingTimes {
  /** Default `CLEANUP_FIRST_AFTER_MS` (cleanup-runner.ts). */
  readonly cleanupFirstAfterMs?: number;
  /** Default `CLEANUP_EVERY_MS`. */
  readonly cleanupEveryMs?: number;
  /** Default 60 s (alert-notices.ts). */
  readonly noticesEveryMs?: number;
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
  // Made here, so closed by the server's close (S-063). A start refused
  // after this leaves it idle: its outbox has nothing queued and no timer.
  let ownMailer: Mailer | undefined;
  if (deliverReset === undefined) {
    if (options.mailer === undefined) {
      ownMailer = mailerFromEnv(env, { log });
      mailer = ownMailer;
    } else {
      mailer = options.mailer;
    }
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
  // connection or site never serves a request. The public read routes
  // (T-050d) use them.
  const publicHosts = publicSitesFromEnv(env, originsFromEnv(env), adminOrigin);
  if (publicHosts.length > 0 && options.publicDb === undefined) {
    throw new Error(
      `refusing to start: OCULUS_PUBLIC_SITES lists public sites but ${PUBLIC_DATABASE_URL_ENV} gives no public reader connection (D-080).`,
    );
  }
  const publicDb = options.publicDb;
  const publicSites =
    publicDb === undefined ? [] : await checkPublicSites(options.db, publicDb, publicHosts);
  // One count of the public pool's connections for every public route (D-100, D-105).
  const publicSlots = new ReadSlots(PUBLIC_POOL_SIZE);
  const oaiEmail = oaiAdminEmail(env[OAI_ADMIN_EMAIL_ENV]);
  // OAI-PMH's lists read the datestamps the background pass stores (S-041):
  // without its pool they would stay empty, so refuse rather than serve that.
  if (oaiEmail !== undefined && publicSites.length > 0 && options.countsDb === undefined) {
    throw new Error(
      `refusing to start: ${OAI_ADMIN_EMAIL_ENV} turns on OAI-PMH, which needs the background counts' own connection (countsDb, D-108).`,
    );
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
          // Installs and rollbacks in the change log (T-060a).
          changeLog: updateChangeLog(options.db, "admin"),
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

  // Public Subjects counts (S-038, D-106): counted in the background on their
  // own pool, served from memory, stopped when the server closes.
  const publicSubjects =
    options.countsDb === undefined || publicSites.length === 0
      ? undefined
      : new PublicSubjects({
          db: options.countsDb,
          sites: publicSites,
          log,
          // OAI-PMH's lists read the datestamps this pass stores (S-041, D-108).
          oaiStamps: oaiEmail !== undefined,
        });

  const files = await fileStoreFromEnv(env);
  // Virus scanning (S-040, D-113): only with clamd set up.
  const scanning = scannerFromEnv(env);
  if (scanning === undefined && production) {
    log({ event: "startup_warning", code: "files_not_scanned" });
  }
  // Uploads over the scanner's limit are refused while scanning is on
  // (S-040 review S1): the file cap is then really the scanner's.
  if (scanning !== undefined && files.maxFileBytes > scanning.clamd.streamMaxBytes) {
    log({ event: "startup_warning", code: "file_cap_over_scan_limit" });
  }
  // Thumbnails (M-003, T-072, D-097): one renderer (a decoder child
  // process at a time), stopped with the server. Turned off, none is made.
  const thumbnailsOn = options.thumbnails !== false;
  const thumbnails = thumbnailsOn ? createThumbnailRenderer() : undefined;
  const service = createService(options.db, {
    onError: serviceErrorLogger(log),
    files,
    thumbnailsEnabled: thumbnailsOn,
    ...(thumbnails === undefined ? {} : { thumbnails }),
    ...(scanning === undefined
      ? {}
      : {
          scanner: clamdScanner(scanning.clamd),
          scanQueue: { concurrency: scanning.concurrency },
        }),
  });
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
      ...(publicSubjects === undefined ? {} : { publicSubjects }),
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
    ...(publicDb === undefined || publicSites.length === 0
      ? []
      : publicApiRoutes({ db: publicDb, sites: publicSites, log, slots: publicSlots })),
    // OAI-PMH (T-050c, D-105): only with an adminEmail for Identify.
    ...(publicDb === undefined || publicSites.length === 0 || oaiEmail === undefined
      ? []
      : oaiPmhRoutes({
          db: options.oaiDb ?? options.db,
          publicDb,
          sites: publicSites,
          adminEmail: oaiEmail,
          log,
          slots: publicSlots,
        })),
    ...(publicSubjects === undefined ? [] : publicSubjectsRoutes({ subjects: publicSubjects })),
    ...(options.extraRoutes ?? []),
  ];
  // The files folder (D-086). First this server's note in it, so a second
  // server with another database is refused before it changes anything
  // there (not the marker, not the lease); then the folder must be this
  // install's (review B1).
  const prepared = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      // A file system error's message holds the path: only its code is shown.
      const code = (error as { code?: unknown }).code;
      throw new Error(
        `refusing to start: ${FILES_DIR_ENV}: the folder couldn't be prepared (${typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : "error"}).`,
        { cause: error },
      );
    }
  };
  const automaticPurge = automaticPurgeFromEnv(env);
  const key = await serverKey(options.db);
  const claim = await prepared(() => files.claimServer(key));
  if (!claim.ok) {
    throw new Error(
      `refusing to start: ${FILES_DIR_ENV}: another Oculus server on this computer uses this folder with another database. Give each database a folder of its own.`,
    );
  }
  let bound: Awaited<ReturnType<typeof service.bindFileStore>>;
  try {
    bound = await prepared(() => service.bindFileStore());
  } catch (error) {
    claim.release();
    throw error;
  }
  if (!bound.ok) {
    claim.release();
    throw new Error(`refusing to start: ${FILES_DIR_ENV}: ${FILE_STORE_PROBLEMS[bound.problem]}`);
  }
  if (bound.warning !== undefined) {
    // Another database uses this folder, or this one was restored, copied
    // or upgraded, or its identity can't be read, or the lease lock was
    // busy: it starts; the purge refuses until an operator adopts the
    // folder (or, when busy, the renewal tried again within a minute).
    log({ event: "startup_warning", code: bound.warning });
  }
  const renew = async (): Promise<void> => {
    try {
      if (!(await service.renewFileLease())) {
        log({ event: "startup_warning", code: "files_shared_or_restored" });
      }
    } catch (error) {
      log({ event: "service_error", operation: "renewFileLease", ...redactedError(error) });
    }
  };
  const sweep = async (): Promise<void> => {
    try {
      const swept = await service.sweepFiles(INCOMING_MAX_AGE_MS);
      if (swept.failed > 0)
        log({ event: "service_error", operation: "sweepFiles", code: "partial" });
    } catch (error) {
      log({ event: "service_error", operation: "sweepFiles", ...redactedError(error) });
    }
  };
  await sweep();
  const scan = async (): Promise<void> => {
    try {
      await service.scanQueuedFiles();
    } catch (error) {
      log({ event: "service_error", operation: "scanQueuedFiles", ...redactedError(error) });
    }
  };
  // The background jobs (S-063), started once the server is built and
  // stopped by its close, before the mailer they send through.
  let cleanup: ReturnType<typeof startCleanup> | undefined;
  let notices: AlertNoticeRunner | undefined;
  let app: FastifyInstance;
  try {
    app = await buildServer({
      env,
      routes,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(admin === undefined ? {} : { admin }),
      // Stopped before the server's close finishes: the public counts and
      // the scans running now (S-040 review L5).
      onClose: async () => {
        await publicSubjects?.stop();
        await service.stopFileScans();
        await Promise.allSettled([cleanup?.stop(), notices?.stop()]);
        await ownMailer?.close();
      },
    });
  } catch (error) {
    claim.release();
    throw error;
  }
  // Started once the server is built, so a start that fails counts nothing.
  publicSubjects?.start();
  const timer = setInterval(() => void sweep(), FILE_SWEEP_EVERY_MS);
  timer.unref();
  const lease = setInterval(() => void renew(), FILE_LEASE_EVERY_MS);
  lease.unref();
  // Another server held the lease lock at the start: the renewal is tried
  // again within a minute, not only at the hour (S-052 third review).
  const retry =
    bound.warning === "files_lease_busy" ? setTimeout(() => void renew(), 30_000) : undefined;
  retry?.unref();
  // The purge on a timer only when turned on (S-052; default off).
  const purge = async (): Promise<void> => {
    try {
      const purged = await service.purgeFiles({ apply: true, via: "timer" });
      if (!purged.ok) log({ event: "startup_warning", code: `files_purge_${purged.problem}` });
    } catch (error) {
      log({ event: "service_error", operation: "purgeFiles", ...redactedError(error) });
    }
  };
  const purgeTimer = automaticPurge
    ? setInterval(() => void purge(), AUTOMATIC_PURGE_EVERY_MS)
    : undefined;
  purgeTimer?.unref();
  // The scan queue (S-040): what is due now, then every minute. A scanner
  // that doesn't answer is logged; its scans fail and are tried again.
  let scans: ReturnType<typeof setInterval> | undefined;
  if (scanning !== undefined) {
    void pingClamd({ ...scanning.clamd, timeoutMs: Math.min(scanning.clamd.timeoutMs, 5000) })
      .then((answered) => {
        if (!answered) log({ event: "startup_warning", code: "clamd_unreachable" });
      })
      .catch(() => undefined);
    void scan();
    scans = setInterval(() => void scan(), FILE_SCAN_EVERY_MS);
    scans.unref();
  }
  // Started once the server is built, so a start that fails counts nothing.
  publicSubjects?.start();
  if (options.housekeeping !== false) {
    const times: HousekeepingTimes =
      typeof options.housekeeping === "object" ? options.housekeeping : {};
    cleanup = startCleanup({
      db: options.db,
      log,
      ...(times.cleanupFirstAfterMs === undefined
        ? {}
        : { firstAfterMs: times.cleanupFirstAfterMs }),
      ...(times.cleanupEveryMs === undefined ? {} : { intervalMs: times.cleanupEveryMs }),
    });
    // "Someone is guessing your two-step codes" (D-077, D-085), every minute,
    // through the mailer's notice lane. Only with a real sender (SMTP): the
    // development sender tells no one, and a notice it "sent" would hold
    // that person's next one back a day, so the alerts wait until email is
    // set up (S-063 review). With no mailer (tests) there is none either.
    if (mailer !== undefined && (env[MAIL_ENV.host]?.trim() ?? "") !== "") {
      const outbox = mailer.outbox;
      notices = startAlertNotices({
        db: options.db,
        deliver: mailer.deliverAlert,
        log,
        room: () => outbox.room("notice"),
        ...(times.noticesEveryMs === undefined ? {} : { intervalMs: times.noticesEveryMs }),
      });
    }
  }
  app.server.once("close", () => {
    clearInterval(timer);
    clearInterval(lease);
    if (purgeTimer !== undefined) clearInterval(purgeTimer);
    if (retry !== undefined) clearTimeout(retry);
    if (scans !== undefined) clearInterval(scans);
    claim.release();
    void thumbnails?.close();
  });
  return app;
}
