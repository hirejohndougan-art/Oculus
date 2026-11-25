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
 * - in production, no `deliverReset` is given (T-040 makes the email
 *   sender). In development, the default only logs that a link was made,
 *   never the token or the address (D-068's secrecy rule);
 * - `OCULUS_ADMIN_ORIGIN` is set but isn't one of `OCULUS_ORIGINS`, or the
 *   admin build can't be read; in production, it isn't set (T-050a, D-089:
 *   the staff API is then answered on the admin's host only);
 * - `OCULUS_PUBLIC_SITES` is wrong (public-sites.ts), names a site that
 *   doesn't exist, or is set without a public reader connection
 *   (`publicDb`); or that connection, whenever one is given, could read more
 *   than the public read path (`checkPublicReaderConnection`, D-080).
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
import { createService } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { ADMIN_ORIGIN_ENV, loadAdminFiles, type AdminFiles } from "./admin-files.js";
import { originsFromEnv } from "./origin.js";
import { trustedProxyFromEnv } from "./proxy.js";
import { PUBLIC_DATABASE_URL_ENV, checkPublicSites, publicSitesFromEnv } from "./public-sites.js";
import { buildServer, type ServerOptions } from "./server.js";
import { signInRoutes, type SignInApiOptions } from "./sign-in-api.js";
import { serviceErrorLogger, staffApiRoutes, type ApiLogRecord } from "./staff-api.js";

export const CLIENT_ADDRESS_ENV = "OCULUS_CLIENT_ADDRESS";

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
  /** Sends password reset links (T-040). Required in production. */
  readonly deliverReset?: PasswordResetDelivery;
  /**
   * Send invitations and the set-up token after a reset of two-step sign-in
   * (T-040). In development each defaults to logging that a message was
   * made (never its token or address); in production, without one, the
   * matching people route answers 503 `delivery_unavailable`.
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
  /** Passed on to the sign-in routes (tests). */
  readonly signIn?: Pick<SignInApiOptions, "rateLimits" | "clock" | "resetOptions">;
}

function defaultLog(record: ApiLogRecord): void {
  try {
    process.stderr.write(`${JSON.stringify({ oculus: record })}\n`);
  } catch {
    // Logging can't stop the server.
  }
}

/** Development only: says a message was made, never its token or address (D-068). */
function developmentDelivery(
  log: (record: ApiLogRecord) => void,
  event: "invitation_produced" | "set_up_link_produced",
): () => Promise<void> {
  return () => {
    log({ event });
    return Promise.resolve();
  };
}

/** True unless `NODE_ENV` says development or test. */
export function isProduction(env: Readonly<Record<string, string | undefined>>): boolean {
  const mode = env.NODE_ENV;
  return mode !== "development" && mode !== "test";
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

  let deliverReset = options.deliverReset;
  if (deliverReset === undefined) {
    if (production) {
      throw new Error(
        "refusing to start: no password reset sender (deliverReset) is configured (T-040).",
      );
    }
    deliverReset = () => {
      // Development only: say a link was made, never the token or the address.
      log({ event: "reset_link_produced" });
      return Promise.resolve();
    };
  }

  const adminOrigin = env[ADMIN_ORIGIN_ENV];
  if (production && (adminOrigin === undefined || adminOrigin === "")) {
    throw new Error(
      `refusing to start: ${ADMIN_ORIGIN_ENV} must name the admin's own origin in production, so the staff API answers on that host only (D-052, D-089).`,
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

  const service = createService(options.db, { onError: serviceErrorLogger(log) });
  const routes = [
    ...staffApiRoutes({
      db: options.db,
      service,
      log,
      people: {
        keys,
        deliverReset,
        ...(options.deliverInvitation !== undefined
          ? { deliverInvitation: options.deliverInvitation }
          : production
            ? {}
            : { deliverInvitation: developmentDelivery(log, "invitation_produced") }),
        ...(options.deliverEnrolment !== undefined
          ? { deliverEnrolment: options.deliverEnrolment }
          : production
            ? {}
            : { deliverEnrolment: developmentDelivery(log, "set_up_link_produced") }),
      },
    }),
    ...signInRoutes({
      db: options.db,
      keys,
      service,
      deliverReset,
      log,
      warnSharedAddress: production,
      ...options.signIn,
    }),
  ];
  return buildServer({
    env,
    routes,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(admin === undefined ? {} : { admin }),
  });
}
