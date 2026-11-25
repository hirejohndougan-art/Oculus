/**
 * The virus scanner's settings from the environment (S-040, D-113). Scanning
 * is on only when one of these says where clamd listens:
 *
 * - `OCULUS_CLAMD_SOCKET`: clamd's Unix socket (its `LocalSocket`), an
 *   absolute path; or
 * - `OCULUS_CLAMD_HOST` and `OCULUS_CLAMD_PORT` (default 3310): TCP on the
 *   loopback address only (`127.0.0.1` or `::1`, written as an address),
 *   since the bytes go unencrypted. Not both a socket and a host.
 *
 * and, optionally:
 *
 * - `OCULUS_CLAMD_TIMEOUT_SECONDS` (default 120, 1 to 3600): one scan's
 *   whole time limit;
 * - `OCULUS_CLAMD_STREAM_MAX_MIB` (default 100, current clamd's own
 *   default, 1 to 4095): set it to clamd's `StreamMaxLength` (or less), and
 *   keep clamd's `MaxFileSize` at least as large (clamd passes a file over
 *   it unscanned as OK). Larger files are `failed` (`too_large`) and never
 *   served while scanning is on: raise both to scan them;
 * - `OCULUS_CLAMD_CONCURRENCY` (default 2, 1 to 16): scans at once.
 *
 * None set: no scanner, files are `not_scanned` and served as before (the
 * desktop trial needs no ClamAV). A malformed value refuses the start,
 * naming the variable, never the value.
 */
import {
  CLAMD_DEFAULT_STREAM_MAX_BYTES,
  DEFAULT_SCAN_CONCURRENCY,
  clamdAddressProblem,
  type ClamdAddress,
  type ClamdOptions,
} from "@oculus/service";

export const CLAMD_SOCKET_ENV = "OCULUS_CLAMD_SOCKET";
export const CLAMD_HOST_ENV = "OCULUS_CLAMD_HOST";
export const CLAMD_PORT_ENV = "OCULUS_CLAMD_PORT";
export const CLAMD_TIMEOUT_ENV = "OCULUS_CLAMD_TIMEOUT_SECONDS";
export const CLAMD_STREAM_MAX_ENV = "OCULUS_CLAMD_STREAM_MAX_MIB";
export const CLAMD_CONCURRENCY_ENV = "OCULUS_CLAMD_CONCURRENCY";

/** clamd's usual TCP port. */
export const CLAMD_DEFAULT_PORT = 3310;
/** One scan's default time limit: 2 minutes. */
export const CLAMD_DEFAULT_TIMEOUT_SECONDS = 120;

export interface ScannerSettings {
  readonly clamd: ClamdOptions;
  readonly concurrency: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function setting(env: Env, name: string): string | undefined {
  const text = env[name];
  return text === undefined || text.trim() === "" ? undefined : text.trim();
}

function whole(env: Env, name: string, min: number, max: number): number | undefined {
  const text = setting(env, name);
  if (text === undefined) return undefined;
  if (!/^[0-9]{1,10}$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(
      `refusing to start: ${name} must be a whole number from ${String(min)} to ${String(max)}.`,
    );
  }
  return Number(text);
}

/** The scanner's settings, or `undefined` when none is set up; throws on a malformed one. */
export function scannerFromEnv(env: Env): ScannerSettings | undefined {
  const socket = setting(env, CLAMD_SOCKET_ENV);
  const host = setting(env, CLAMD_HOST_ENV);
  const port = whole(env, CLAMD_PORT_ENV, 1, 65_535);
  const timeout = whole(env, CLAMD_TIMEOUT_ENV, 1, 3600);
  const streamMax = whole(env, CLAMD_STREAM_MAX_ENV, 1, 4095);
  const concurrency = whole(env, CLAMD_CONCURRENCY_ENV, 1, 16);
  if (socket !== undefined && host !== undefined) {
    throw new Error(`refusing to start: set ${CLAMD_SOCKET_ENV} or ${CLAMD_HOST_ENV}, not both.`);
  }
  if (socket === undefined && host === undefined) {
    const stray = [
      CLAMD_PORT_ENV,
      CLAMD_TIMEOUT_ENV,
      CLAMD_STREAM_MAX_ENV,
      CLAMD_CONCURRENCY_ENV,
    ].filter((name) => setting(env, name) !== undefined);
    if (stray.length > 0) {
      throw new Error(
        `refusing to start: ${stray[0] ?? ""} is set but neither ${CLAMD_SOCKET_ENV} nor ${CLAMD_HOST_ENV} says where clamd is.`,
      );
    }
    return undefined;
  }
  let address: ClamdAddress;
  let name: string;
  if (socket !== undefined) {
    if (port !== undefined) {
      throw new Error(
        `refusing to start: ${CLAMD_PORT_ENV} goes with ${CLAMD_HOST_ENV}, not a socket.`,
      );
    }
    address = { socket };
    name = CLAMD_SOCKET_ENV;
  } else {
    address = { host: host ?? "", port: port ?? CLAMD_DEFAULT_PORT };
    name = CLAMD_HOST_ENV;
  }
  const problem = clamdAddressProblem(address);
  if (problem !== undefined) throw new Error(`refusing to start: ${name}: ${problem}.`);
  return Object.freeze({
    clamd: Object.freeze({
      address,
      timeoutMs: (timeout ?? CLAMD_DEFAULT_TIMEOUT_SECONDS) * 1000,
      streamMaxBytes:
        streamMax === undefined ? CLAMD_DEFAULT_STREAM_MAX_BYTES : streamMax * 1024 * 1024,
    }),
    concurrency: concurrency ?? DEFAULT_SCAN_CONCURRENCY,
  });
}
