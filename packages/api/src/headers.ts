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
 * - Values are at most `MAX_HEADER_VALUE_LENGTH` characters; dates must be
 *   real dates; `Retry-After` at most a day; no `Vary: *`.
 * - `type()` refuses active content (`isActiveType`: HTML, any XML type,
 *   script types, XSL, `multipart/x-mixed-replace`) and any charset other
 *   than UTF-8, until server-built public pages and feeds get their own
 *   decision.
 * - Every reply, error replies and Node-level errors included, gets
 *   `SECURITY_HEADERS`: no MIME sniffing, no Referer, a Content-Security-Policy
 *   that loads nothing, can't be framed, posts no form and sets no base URL,
 *   and `Cache-Control: no-store`.
 *   Pages that need a looser policy or caching (public pages, images) are a
 *   later decision.
 */

/** Set on every reply; handlers can't change them. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
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

/** The longest value a handler may give an allowlisted header. */
export const MAX_HEADER_VALUE_LENGTH = 1024;

/** The longest `Retry-After` a handler may ask for: one day, in seconds. */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/** An IMF-fixdate naming a real moment: `Mon, 30 Feb 2026 …` or a wrong weekday is refused. */
function isRealDate(value: string): boolean {
  if (!HTTP_DATE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toUTCString() === value;
}

function isRetryAfter(value: string): boolean {
  if (/^\d{1,9}$/.test(value)) return Number(value) <= MAX_RETRY_AFTER_SECONDS;
  return isRealDate(value) && Date.parse(value) - Date.now() <= MAX_RETRY_AFTER_SECONDS * 1000;
}

/** A list of header names; `*` (which makes every response uncacheable by anyone) is refused. */
function isVary(value: string): boolean {
  return TOKEN_LIST.test(value) && !value.split(",").some((name) => name.trim() === "*");
}

/**
 * The headers a handler may write with `header()`, each with the form its
 * value must have (D-058). Nothing else is allowed.
 */
const HANDLER_HEADERS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["content-language", (v: string) => LANGUAGES.test(v)],
  ["etag", (v: string) => ETAG.test(v)],
  ["last-modified", isRealDate],
  ["vary", isVary],
  ["location", isLocalPath],
  ["retry-after", isRetryAfter],
]);

/** The header names `header()` accepts, lowercase. */
export const HANDLER_HEADER_NAMES: readonly string[] = Object.freeze([...HANDLER_HEADERS.keys()]);

/** Why a handler may not write this header, or `undefined` when it may. */
export function replyHeaderProblem(name: unknown, value: unknown): string | undefined {
  if (typeof name !== "string" || !TOKEN.test(name)) return "header names must be tokens";
  if (typeof value !== "string" || !VALUE.test(value)) {
    return "header values must be text without control characters";
  }
  if (value.length > MAX_HEADER_VALUE_LENGTH) return "header value too long";
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

/**
 * Media types a browser may run script from, or render as a document that
 * can (D-058, S-025): refused until server-built public pages and XML feeds
 * (OAI-PMH, T-050) get their own decision (D-034). By essence, lower case:
 * - HTML, and `multipart/x-mixed-replace` (whose parts a browser renders);
 * - MHTML and mail (`message/rfc822`, `multipart/related`,
 *   `application/x-mimearchive`), HTML components (`text/x-component`),
 *   Flash, and XSLT's older names (`text/x-xslt`, `application/x-xslt`);
 * - every XML type: `text/xml`, `application/xml`, their `-…` variants
 *   (`text/xml-external-parsed-entity`), and any `+xml` suffix (SVG, XHTML,
 *   XSLT, MathML, RSS, Atom …), since a browser renders XML with an XHTML,
 *   SVG or XSLT root as a document with script; and `text/xsl`;
 * - the JavaScript MIME types of the WHATWG MIME Sniffing standard (§4.6),
 *   which another page could load from Oculus's origin as a script.
 */
const ACTIVE_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "multipart/x-mixed-replace",
  // Web archives and mail a browser may open as a page (MHTML), HTML
  // components, Flash, and XSLT under its older names (S-025 review).
  "message/rfc822",
  "multipart/related",
  "application/x-mimearchive",
  "text/x-component",
  "application/x-shockwave-flash",
  "text/x-xslt",
  "application/x-xslt",
  "text/xsl",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/** True for an essence (`type/subtype`) a browser may run script from (`ACTIVE_TYPES`). */
export function isActiveType(essence: string): boolean {
  const lower = essence.trim().toLowerCase();
  if (ACTIVE_TYPES.has(lower)) return true;
  const subtype = lower.slice(lower.indexOf("/") + 1);
  return subtype === "xml" || subtype.startsWith("xml-") || subtype.endsWith("+xml");
}

/** Why a Content-Type may not be set with `type()`, or `undefined` when it may. */
export function contentTypeProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    return "the content type must be a media type with simple parameters";
  }
  if (value.length > MAX_HEADER_VALUE_LENGTH) return "the content type is too long";
  const [essence = "", ...parameters] = value.split(";");
  if (isActiveType(essence)) {
    return "active content types (HTML, XML, scripts) are not allowed";
  }
  for (const parameter of parameters) {
    const [name = "", setting = ""] = parameter.trim().split("=");
    if (name.toLowerCase() === "charset" && setting.toLowerCase() !== "utf-8") {
      return "the only charset allowed is utf-8";
    }
  }
  return undefined;
}
