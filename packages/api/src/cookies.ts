/**
 * Cookies: read only Oculus's own, write only through one helper (D-051, D-052).
 *
 * - No cookie plugin is registered, so `request.cookies` doesn't exist and no
 *   other cookie is ever parsed. `readOculusCookie` reads one of
 *   `OCULUS_COOKIES` from the raw header (D-058: `@fastify/cookie` dropped,
 *   because its `setCookie` parses every cookie into `request.cookies` and
 *   its parser keeps the first of two copies).
 * - A request that sends any Oculus cookie name more than once (the exact
 *   name, as cookie names are compared) is refused with 400: a second copy
 *   can be planted by a script on the same origin, and picking either one
 *   would be a guess. The cost (D-058): whoever can plant such a copy can
 *   make the browser's requests fail until it is cleared. A cookie whose
 *   name only case-folds to an Oculus name (`__host-oculus_session`) is
 *   another cookie: it is never read and never counted (S-024), because a
 *   sibling subdomain can plant one (a browser that checks the `__Host-`
 *   prefix case-sensitively lets `__host-` carry `Domain`) and would
 *   otherwise block every request, sign-in included.
 * - `Max-Age` is at most 400 days, in the writer and in the check alike.
 * - Values are base64url text only (session tokens are random bytes); any
 *   other value reads as absent. Names, values and the Cookie header must be
 *   `typeof "string"` before any other check (an object's `toString` could
 *   pass the check and then write something else).
 * - `setOculusCookie` and `clearOculusCookie` (reached through the route
 *   reply, server.ts) are the only writers; they write the header text
 *   themselves. Every cookie gets the `__Host-` prefix (it is part of the
 *   name), `Secure`, `HttpOnly`, `SameSite` (`Lax` unless `Strict` is asked
 *   for), `Path=/` and no `Domain` (ASVS 5.0 3.3.1–3.3.4).
 * - Just before a reply is sent, every `Set-Cookie` value must be one the
 *   writer issued for that reply and must pass `setCookieProblem`; otherwise
 *   it is removed and the reply becomes a 500.
 */
import type { FastifyReply } from "fastify";
import { Refusal } from "./errors.js";

export const OCULUS_COOKIES = {
  session: "__Host-oculus_session",
} as const;

export type OculusCookieName = (typeof OCULUS_COOKIES)[keyof typeof OCULUS_COOKIES];

const NAMES: ReadonlySet<string> = new Set(Object.values(OCULUS_COOKIES));
const VALUE = /^[A-Za-z0-9_-]{1,512}$/;

function cookiePairs(header: string | undefined): { name: string; value: string }[] {
  // Only a string is read: no array, boxed String or object with a toString.
  if (typeof header !== "string" || header === "") return [];
  return header.split(";").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1
      ? { name: pair.trim(), value: "" }
      : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  });
}

/**
 * Refuses a Cookie header that names any Oculus cookie more than once, by
 * exact name: other cookies, case variants of Oculus names included, are
 * ignored (S-024).
 */
export function cookieHeaderProblem(header: string | undefined): Refusal | undefined {
  const seen = new Set<string>();
  for (const { name } of cookiePairs(header)) {
    if (!NAMES.has(name)) continue;
    if (seen.has(name)) return new Refusal(400, "duplicate_cookie");
    seen.add(name);
  }
  return undefined;
}

function checkName(name: string): void {
  if (typeof name !== "string" || !NAMES.has(name))
    throw new Error(`not an Oculus cookie: ${name}`);
}

/** The value of one Oculus cookie in a `Cookie` header, or `undefined` when absent or malformed. */
export function readOculusCookie(
  header: string | undefined,
  name: OculusCookieName,
): string | undefined {
  checkName(name);
  if (cookieHeaderProblem(header) !== undefined) return undefined;
  const pair = cookiePairs(header).find((p) => p.name === name);
  return pair !== undefined && VALUE.test(pair.value) ? pair.value : undefined;
}

/**
 * The longest `Max-Age`: 400 days, the cap browsers apply (RFC 6265bis
 * §5.6.2). The writer and the check before sending use the same limit.
 */
export const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

function isMaxAge(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_COOKIE_AGE_SECONDS;
}

export interface CookieWriteOptions {
  /** Seconds until the browser drops it; omit for a cookie that ends with the browser session. */
  readonly maxAgeSeconds?: number;
  readonly sameSite?: "lax" | "strict";
}

/** The Set-Cookie values the writer issued, per reply. */
const issued = new WeakMap<FastifyReply, string[]>();

function issue(reply: FastifyReply, header: string): void {
  const list = issued.get(reply) ?? [];
  list.push(header);
  issued.set(reply, list);
  void reply.header("set-cookie", [...list]);
}

/** Writes an Oculus cookie with the fixed safe attributes. */
export function setOculusCookie(
  reply: FastifyReply,
  name: OculusCookieName,
  value: string,
  options: CookieWriteOptions = {},
): void {
  checkName(name);
  // typeof first: an object's toString could answer the check one way and
  // the header text another.
  if (typeof value !== "string" || !VALUE.test(value)) {
    throw new Error("cookie values must be 1 to 512 base64url characters");
  }
  const { maxAgeSeconds } = options;
  if (maxAgeSeconds !== undefined && !isMaxAge(maxAgeSeconds)) {
    throw new Error(
      `maxAgeSeconds must be a whole number of seconds from 0 to ${String(MAX_COOKIE_AGE_SECONDS)}`,
    );
  }
  const sameSite = options.sameSite === "strict" ? "Strict" : "Lax";
  const maxAge = maxAgeSeconds === undefined ? "" : `; Max-Age=${String(maxAgeSeconds)}`;
  issue(reply, `${name}=${value}${maxAge}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`);
}

/** Tells the browser to drop an Oculus cookie, with the same attributes. */
export function clearOculusCookie(reply: FastifyReply, name: OculusCookieName): void {
  checkName(name);
  issue(reply, `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

const ATTRIBUTE_NAMES = new Set(["path", "httponly", "secure", "samesite", "max-age"]);

/**
 * Why one `Set-Cookie` value breaks the rules, or `undefined` if it is fine.
 * Attributes are read the way browsers read them (RFC 6265bis §5.6: names
 * without case, spaces trimmed), and each may appear once. Only `Path=/`,
 * `HttpOnly`, `Secure`, `SameSite=Lax|Strict` and `Max-Age` are allowed.
 */
export function setCookieProblem(setCookie: string): string | undefined {
  const [pair = "", ...attributes] = setCookie.split(";");
  const eq = pair.indexOf("=");
  if (eq === -1) return "no name";
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!NAMES.has(name)) return "not an Oculus cookie";
  if (value !== "" && !VALUE.test(value)) return "bad value";
  const seen = new Map<string, string>();
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const val = at === -1 ? "" : attribute.slice(at + 1).trim();
    if (!ATTRIBUTE_NAMES.has(key)) return `attribute not allowed: ${key}`;
    if (seen.has(key)) return `repeated attribute: ${key}`;
    seen.set(key, val);
  }
  if (!seen.has("secure")) return "missing Secure";
  if (!seen.has("httponly")) return "missing HttpOnly";
  if (seen.get("path") !== "/") return "missing Path=/";
  const sameSite = seen.get("samesite")?.toLowerCase();
  if (sameSite !== "lax" && sameSite !== "strict") return "missing SameSite";
  if (seen.get("secure") !== "" || seen.get("httponly") !== "") return "flag with a value";
  const maxAge = seen.get("max-age");
  if (maxAge !== undefined && !(/^\d{1,8}$/.test(maxAge) && isMaxAge(Number(maxAge)))) {
    return "bad Max-Age";
  }
  return undefined;
}

/** Why a reply's Set-Cookie values must not be sent, or `undefined`. */
export function replyCookieProblem(
  reply: FastifyReply,
  header: number | string | string[] | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const values = Array.isArray(header) ? header : [String(header)];
  const mine = issued.get(reply) ?? [];
  for (const value of values) {
    if (!mine.includes(value)) return "not written by the cookie writer";
    const problem = setCookieProblem(value);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
