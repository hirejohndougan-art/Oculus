/**
 * Cookies: read only Oculus's own, write only through one helper (D-051, D-052).
 *
 * - `@fastify/cookie` is registered with its parsing hook off, so
 *   `request.cookies` is never filled and no other cookie is read.
 *   `readOculusCookie` reads one of `OCULUS_COOKIES` from the raw header.
 * - A request that sends any Oculus cookie name more than once (compared
 *   without regard to case, so `__host-oculus_session` counts) is refused
 *   with 400: a second copy can be planted by a sibling site or script, and
 *   picking either one would be a guess.
 * - Values are base64url text only (session tokens are random bytes); any
 *   other value reads as absent.
 * - `setOculusCookie` and `clearOculusCookie` are the only writers. Every
 *   cookie gets the `__Host-` prefix (it is part of the name), `Secure`,
 *   `HttpOnly`, `SameSite` (`Lax` unless `Strict` is asked for), `Path=/`
 *   and no `Domain` (ASVS 5.0 3.3.1–3.3.4).
 * - `setCookieProblem` checks every `Set-Cookie` header just before a reply
 *   is sent; a cookie written any other way (a plugin, a raw header) is
 *   removed and the reply becomes a 500.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Refusal } from "./errors.js";

export const OCULUS_COOKIES = {
  session: "__Host-oculus_session",
} as const;

export type OculusCookieName = (typeof OCULUS_COOKIES)[keyof typeof OCULUS_COOKIES];

const NAMES: ReadonlySet<string> = new Set(Object.values(OCULUS_COOKIES));
const LOWERCASE_NAMES: ReadonlySet<string> = new Set([...NAMES].map((n) => n.toLowerCase()));
const VALUE = /^[A-Za-z0-9_-]{1,512}$/;

function cookiePairs(header: string | undefined): { name: string; value: string }[] {
  if (header === undefined || header === "") return [];
  return header.split(";").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1
      ? { name: pair.trim(), value: "" }
      : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  });
}

/** Refuses a Cookie header that names any Oculus cookie more than once. */
export function cookieHeaderProblem(header: string | undefined): Refusal | undefined {
  const counts = new Map<string, number>();
  for (const { name } of cookiePairs(header)) {
    const lower = name.toLowerCase();
    if (!LOWERCASE_NAMES.has(lower)) continue;
    const count = (counts.get(lower) ?? 0) + 1;
    if (count > 1) return new Refusal(400, "duplicate_cookie");
    counts.set(lower, count);
  }
  return undefined;
}

function checkName(name: string): void {
  if (!NAMES.has(name)) throw new Error(`not an Oculus cookie: ${name}`);
}

/** The value of one Oculus cookie, or `undefined` when absent or malformed. */
export function readOculusCookie(
  request: FastifyRequest,
  name: OculusCookieName,
): string | undefined {
  checkName(name);
  const header = request.headers.cookie;
  if (cookieHeaderProblem(header) !== undefined) return undefined;
  const pair = cookiePairs(header).find((p) => p.name === name);
  return pair !== undefined && VALUE.test(pair.value) ? pair.value : undefined;
}

export interface CookieWriteOptions {
  /** Seconds until the browser drops it; omit for a cookie that ends with the browser session. */
  readonly maxAgeSeconds?: number;
  readonly sameSite?: "lax" | "strict";
}

/** Writes an Oculus cookie with the fixed safe attributes. */
export function setOculusCookie(
  reply: FastifyReply,
  name: OculusCookieName,
  value: string,
  options: CookieWriteOptions = {},
): void {
  checkName(name);
  if (!VALUE.test(value)) throw new Error("cookie values must be 1 to 512 base64url characters");
  const { maxAgeSeconds } = options;
  if (maxAgeSeconds !== undefined && (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0)) {
    throw new Error("maxAgeSeconds must be a whole number of seconds, 0 or more");
  }
  reply.setCookie(name, value, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: options.sameSite ?? "lax",
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  });
}

/** Tells the browser to drop an Oculus cookie, with the same attributes. */
export function clearOculusCookie(reply: FastifyReply, name: OculusCookieName): void {
  checkName(name);
  reply.clearCookie(name, { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
}

/** Why one `Set-Cookie` value breaks the rules, or `undefined` if it is fine. */
export function setCookieProblem(setCookie: string): string | undefined {
  const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
  const name = pair.slice(0, Math.max(pair.indexOf("="), 0));
  if (!NAMES.has(name)) return "not an Oculus cookie";
  const lower = attributes.map((a) => a.toLowerCase());
  if (!lower.includes("secure")) return "missing Secure";
  if (!lower.includes("httponly")) return "missing HttpOnly";
  if (!lower.includes("path=/")) return "missing Path=/";
  if (!lower.some((a) => a === "samesite=lax" || a === "samesite=strict"))
    return "missing SameSite";
  if (lower.some((a) => a.startsWith("domain="))) return "has Domain";
  if (lower.some((a) => a.startsWith("path=") && a !== "path=/")) return "second Path";
  return undefined;
}

/** Every Set-Cookie value on a reply, as a list. */
export function setCookieValues(header: number | string | string[] | undefined): string[] {
  if (header === undefined) return [];
  if (Array.isArray(header)) return header;
  return [String(header)];
}
