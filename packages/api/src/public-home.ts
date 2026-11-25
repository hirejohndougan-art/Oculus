/**
 * A public site's home page until Phase 4's public pages exist (T-070,
 * D-109): `GET /` (and HEAD) on a host `OCULUS_PUBLIC_SITES` maps to a site
 * answers one fixed page that says the site's name and "This public site is
 * being built". Nothing else: no record, no count, no link, no script, no
 * form. It is the address the admin's "View public site" button opens, so
 * that button never lands on a bare error.
 *
 * It is the one HTML page the server builds itself, so it is not a route
 * (handlers still can't send HTML, D-058): the server's not-found handler
 * sends it (server.ts, rule 13) for exactly that path on exactly those
 * hosts, from text made at startup. The only variable part is the site's
 * name as it was when the server started, HTML-escaped. Its headers are the
 * API's with one change: the CSP also allows the page's one inline style,
 * by its SHA-256 hash.
 */
import { createHash } from "node:crypto";
import { SECURITY_HEADERS } from "./headers.js";

/** One public host's home page. */
export interface PublicHome {
  /** The public origin, as `OCULUS_PUBLIC_SITES` lists it. */
  readonly origin: string;
  /** The site's name at startup. */
  readonly siteName: string;
}

const STYLE =
  "body{margin:0;font-family:system-ui,sans-serif;color:#1d232b;background:#f7f6f3}" +
  "main{max-width:40rem;margin:0 auto;padding:4rem 1.5rem}" +
  "h1{font-size:2rem;margin:0 0 1rem}p{font-size:1.125rem;line-height:1.5;margin:0}";

const STYLE_HASH = `sha256-${createHash("sha256").update(STYLE, "utf8").digest("base64")}`;

/** The page's headers: the API's (nosniff, no Referer, no-store), its own CSP. */
export const PUBLIC_HOME_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...SECURITY_HEADERS,
  "content-security-policy": `default-src 'none'; style-src '${STYLE_HASH}'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
});

/** Text made safe for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The page for one site. An empty name reads "This site". */
export function publicHomePage(siteName: string): string {
  const name = siteName.trim() === "" ? "This site" : escapeHtml(siteName.trim());
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    '<head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${name}</title><style>${STYLE}</style></head>\n` +
    `<body><main><h1>${name}</h1><p>This public site is being built.</p></main></body>\n` +
    "</html>\n"
  );
}

/** Each public origin's page, made once (an origin listed twice keeps its first). */
export function publicHomePages(homes: readonly PublicHome[]): ReadonlyMap<string, string> {
  const pages = new Map<string, string>();
  for (const home of homes) {
    if (!pages.has(home.origin)) pages.set(home.origin, publicHomePage(home.siteName));
  }
  return pages;
}
