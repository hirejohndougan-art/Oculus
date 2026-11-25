/**
 * Which mode the server runs in. Production is anything but
 * `NODE_ENV=development` or `test`, so a missing `NODE_ENV` gets the strict
 * checks (D-081). Shared by the admin's startup checks and the mail senders
 * (D-085), which refuse the development sender in production.
 */

/** True unless `NODE_ENV` says development or test. */
export function isProduction(env: Readonly<Record<string, string | undefined>>): boolean {
  const mode = env.NODE_ENV;
  return mode !== "development" && mode !== "test";
}
