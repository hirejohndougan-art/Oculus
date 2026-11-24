/**
 * The built admin (packages/admin's `dist`, D-073) served by the same
 * Fastify server on the admin's own origin (D-034, D-052), with a CSP of its
 * own (T-045, D-081).
 *
 * - `loadAdminFiles(dir)` reads the build **once, at startup**, into memory:
 *   only regular files with a known extension, at most `MAX_ADMIN_FILES`
 *   files and `MAX_ADMIN_BYTES` in all, no symbolic links, no dot files. The
 *   server then answers from that table by exact path, so no request ever
 *   reaches the file system (no traversal, no race with a rebuild).
 * - Only on the admin origin (`OCULUS_ADMIN_ORIGIN`, which must be one of
 *   `OCULUS_ORIGINS`): a request whose host is another origin's (a public
 *   site) gets the ordinary JSON 404.
 * - `GET`/`HEAD` of a listed path answers that file; any other path whose
 *   last segment has no `.` (a screen of the single-page app, `/sign-in`,
 *   `/sites/x`) answers `index.html`; `/api/…` and `/health` never do.
 * - Its replies carry `ADMIN_SECURITY_HEADERS` in place of the API's
 *   `default-src 'none'`: scripts, styles, fonts and images from the admin's
 *   own origin only (no inline script or style, no third party), `data:`
 *   images (the set-up QR code may use one), fetches to the same origin,
 *   no framing, no forms posted anywhere, no `<base>`. The API's replies
 *   keep their own policy unchanged. `Cache-Control: no-store` stays on
 *   these too (caching is a later decision, D-058).
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const ADMIN_ORIGIN_ENV = "OCULUS_ADMIN_ORIGIN";

/** The admin's own policy (D-073): same-origin scripts, styles, fonts and images only. */
export const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Set on every reply of an admin file in place of the API's `SECURITY_HEADERS`. */
export const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": ADMIN_CSP,
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
});

/** The file types the admin's build may hold, with what they are served as. */
export const ADMIN_FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

export const MAX_ADMIN_FILES = 500;
export const MAX_ADMIN_BYTES = 32 * 1024 * 1024;

export interface AdminFile {
  readonly type: string;
  readonly body: Buffer;
}

/** The admin build, read once: served path (`/assets/x.js`) to file. */
export type AdminFiles = ReadonlyMap<string, AdminFile>;

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Reads the built admin from `dir` into memory. Throws (so the server
 * doesn't start) when there is no `index.html`, when a file has an unknown
 * type or an unsafe name, on a symbolic link, or past the size limits.
 */
export function loadAdminFiles(dir: string): AdminFiles {
  const files = new Map<string, AdminFile>();
  let bytes = 0;
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (!SAFE_SEGMENT.test(entry.name)) {
        throw new Error(`admin build: unsafe file name ${JSON.stringify(entry.name)}`);
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("admin build: symbolic links are not served");
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) throw new Error("admin build: only regular files are served");
      const dot = entry.name.lastIndexOf(".");
      const type = dot > 0 ? ADMIN_FILE_TYPES[entry.name.slice(dot)] : undefined;
      if (type === undefined) {
        throw new Error(`admin build: no served type for ${JSON.stringify(entry.name)}`);
      }
      const body = readFileSync(full);
      bytes += body.length;
      if (files.size >= MAX_ADMIN_FILES || bytes > MAX_ADMIN_BYTES) {
        throw new Error("admin build: too many files or too large");
      }
      files.set(`/${relative(dir, full).split(sep).join("/")}`, Object.freeze({ type, body }));
    }
  };
  walk(dir);
  if (!files.has("/index.html")) throw new Error("admin build: index.html is missing");
  return files;
}

/**
 * The admin file for a `GET`/`HEAD` path, or `undefined`: the listed file,
 * else `index.html` for a screen path (no `.` in its last segment). Never
 * for `/api`, `/api/…` or `/health`.
 */
export function adminFileFor(files: AdminFiles, path: string): AdminFile | undefined {
  if (path === "/api" || path.startsWith("/api/") || path === "/health") return undefined;
  const listed = files.get(path);
  if (listed !== undefined) return listed;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") ? undefined : files.get("/index.html");
}
