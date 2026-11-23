/**
 * Response headers: what handlers may write, and the defaults on every reply (D-058).
 *
 * - An allowlist: a handler may write only the headers in `HANDLER_HEADERS`,
 *   each with a value of a fixed form, and the Content-Type through
 *   `type()`. Everything else is refused, so no handler can add CORS,
 *   framing, caching, `Refresh`, `Link` (preconnect, preload), `Alt-Svc`,
 *   `NEL`/`Report-To`, `WWW-Authenticate`, proxy instructions
 *   (`X-Accel-Redirect`, `X-Sendfile`) or a header nobody has thought of yet.
 * - Names must be RFC 9110 §5.6.2 tokens and values must hold no control
 *   character other than a tab (the same characters Node accepts), so Node's
 *   own "invalid header" error, which carries the header's text, can never be
 *   reached from a handler.
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

const TOKEN_LIST = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;
// RFC 9110 §8.8.3: an entity tag, strong or weak.
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]*"$/;
// RFC 9110 §5.6.7: the IMF-fixdate form only.
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
// RFC 9110 §8.5: language tags (RFC 5646 letters, digits and hyphens), comma-separated.
const LANGUAGES =
  /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*(?:[ \t]*,[ \t]*[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)*$/;
// RFC 9110 §8.3.1: type/subtype and parameters without quoted strings.
const MEDIA_TYPE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*;[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;

/** True for a same-origin path that is safe as a `Location`. */
function isLocalPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return false;
  // Visible ASCII only: no spaces, backslashes or control characters a browser might reread.
  return /^[\x21-\x7e]+$/.test(value) && !value.includes("\\");
}

/**
 * The headers a handler may write with `header()`, each with the form its
 * value must have (D-058). Nothing else is allowed.
 */
const HANDLER_HEADERS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["content-language", (v: string) => LANGUAGES.test(v)],
  ["etag", (v: string) => ETAG.test(v)],
  ["last-modified", (v: string) => HTTP_DATE.test(v)],
  ["vary", (v: string) => TOKEN_LIST.test(v)],
  ["location", (v: string) => isLocalPath(v)],
  ["retry-after", (v: string) => /^\d{1,9}$/.test(v) || HTTP_DATE.test(v)],
]);

/** The header names `header()` accepts, lowercase. */
export const HANDLER_HEADER_NAMES: readonly string[] = Object.freeze([...HANDLER_HEADERS.keys()]);

/** Why a handler may not write this header, or `undefined` when it may. */
export function replyHeaderProblem(name: unknown, value: unknown): string | undefined {
  if (typeof name !== "string" || !TOKEN.test(name)) return "header names must be tokens";
  if (typeof value !== "string" || !VALUE.test(value)) {
    return "header values must be text without control characters";
  }
  const lower = name.toLowerCase();
  const check = HANDLER_HEADERS.get(lower);
  if (check === undefined) return `header not allowed: ${name}`;
  if (!check(value)) {
    return lower === "location"
      ? "Location must be a same-origin path"
      : `not a valid ${lower} value`;
  }
  return undefined;
}

/** Why a Content-Type may not be set with `type()`, or `undefined` when it may. */
export function contentTypeProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    return "the content type must be a media type with simple parameters";
  }
  return undefined;
}
