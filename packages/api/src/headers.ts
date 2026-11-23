/**
 * Response headers: what handlers may write, and the defaults on every reply (D-058).
 *
 * - Names must be RFC 9110 §5.6.2 tokens and values must hold no control
 *   character other than a tab (the same characters Node accepts), so Node's
 *   own "invalid header" error, which carries the header's text, can never be
 *   reached from a handler.
 * - Refused outright: `Set-Cookie` (cookies.ts writes it), the framing and
 *   connection headers (`Content-Length`, `Transfer-Encoding`, `Trailer`,
 *   `Connection` and the like), CORS (`Access-Control-*`), `Refresh`, and the
 *   security headers this module sets itself, so no handler can loosen them.
 * - `Location` only as a same-origin path (`/x`, never `//host` or `/\host`),
 *   so no handler can make an open redirect.
 * - Every reply, error replies and Node-level errors included, gets
 *   `SECURITY_HEADERS`: no MIME sniffing, no Referer, a Content-Security-Policy
 *   that loads nothing and can't be framed, and `Cache-Control: no-store`.
 *   Pages that need a looser policy or caching (public pages, images) are a
 *   later decision.
 */

/** Set on every reply; handlers can't change them. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
});

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Node's own rule (lib/_http_common.js checkInvalidHeaderChar): tab, visible ASCII, obs-text.
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

const REFUSED = new Set([
  "set-cookie",
  "set-cookie2",
  "content-length",
  "transfer-encoding",
  "trailer",
  "te",
  "connection",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "http2-settings",
  "content-encoding",
  "date",
  "refresh",
  "strict-transport-security",
  "x-frame-options",
  "x-xss-protection",
  "x-permitted-cross-domain-policies",
  "permissions-policy",
  "feature-policy",
  "origin-agent-cluster",
  "clear-site-data",
  "timing-allow-origin",
  "service-worker-allowed",
  ...Object.keys(SECURITY_HEADERS),
]);
const REFUSED_PREFIXES = ["access-control-", "content-security-policy", "cross-origin-", "sec-"];

/** True for a same-origin path that is safe as a `Location`. */
function isLocalPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
  // Visible ASCII only: no spaces, backslashes or control characters a browser might reread.
  return /^[\x21-\x7e]+$/.test(value) && !value.includes("\\");
}

/** Why a handler may not write this header, or `undefined` when it may. */
export function replyHeaderProblem(name: unknown, value: unknown): string | undefined {
  if (typeof name !== "string" || !TOKEN.test(name)) return "header names must be tokens";
  if (typeof value !== "string" || !VALUE.test(value)) {
    return "header values must be text without control characters";
  }
  const lower = name.toLowerCase();
  if (REFUSED.has(lower) || REFUSED_PREFIXES.some((p) => lower.startsWith(p))) {
    return `header not allowed: ${name}`;
  }
  if (lower === "location" && !isLocalPath(value)) return "Location must be a same-origin path";
  return undefined;
}
