/**
 * Oculus's own body parsers and limits (D-051).
 *
 * Fastify's built-in parsers are removed. In their place:
 * - `application/json` on every route, and `application/x-www-form-urlencoded`
 *   only on routes whose config says `oculus: { form: true }`.
 * - The media type must be exactly one of those, with at most one parameter,
 *   `charset=utf-8`. Anything else, a missing type on a request with a body,
 *   and any `Content-Encoding` other than `identity` (compressed bodies) are
 *   refused with 415. Two `Content-Type` headers are refused with 400.
 * - Bodies must be valid UTF-8. Keys `__proto__`, `constructor` and
 *   `prototype` (the same list as `FORBIDDEN_KEYS` in @oculus/core) are
 *   refused anywhere in a JSON body and in form fields; a form field given
 *   twice is refused too.
 * - Limits are counted in bytes as the body arrives, chunked bodies included
 *   (Fastify counts the raw bytes and also refuses a body longer than its
 *   Content-Length): 1 MiB by default and 8 KiB on routes whose config says
 *   `oculus: { credentials: true }` (sign-in, two-step and site password
 *   posts, D-052). A route can't raise the credentials limit.
 *
 * Every body is still checked again by the core validators (D-051); these
 * parsers only turn bytes into plain values.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Refusal } from "./errors.js";

export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const CREDENTIALS_BODY_LIMIT = 8 * 1024;

export const JSON_TYPE = "application/json";
export const FORM_TYPE = "application/x-www-form-urlencoded";

/** Per-route settings for the HTTP layer, under `config.oculus`. */
export interface OculusRouteConfig {
  /** The route takes HTML form posts (`application/x-www-form-urlencoded`). */
  readonly form?: boolean;
  /** A sign-in, two-step or site password post: the 8 KiB body limit. */
  readonly credentials?: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    oculus?: OculusRouteConfig;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CHARSET_PARAM = /^charset\s*=\s*(?:utf-8|"utf-8")$/i;

/** True when a Content-Type header is exactly `type`, optionally with `charset=utf-8`. */
export function isExactMediaType(header: string | undefined, type: string): boolean {
  if (header === undefined) return false;
  const [mediaType, ...params] = header.split(";");
  if (mediaType?.trim().toLowerCase() !== type) return false;
  if (params.length > 1) return false;
  return params.every((param) => CHARSET_PARAM.test(param.trim()));
}

function decodeUtf8(body: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Refusal(400, "bad_body");
  }
}

/** Parses a JSON body; refuses bad UTF-8, bad JSON and prototype keys anywhere. */
export function parseJsonBody(body: Buffer): unknown {
  const text = decodeUtf8(body);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(400, "bad_body");
  }
  // Walk without recursion, so deep nesting can't overflow the stack.
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item !== "object" || item === null) continue;
    if (Array.isArray(item)) {
      for (const element of item) pending.push(element);
      continue;
    }
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Refusal(400, "forbidden_key");
      pending.push(child);
    }
  }
  return value;
}

/** Parses a form body into one string per field; refuses repeats and prototype keys. */
export function parseFormBody(body: Buffer): Record<string, string> {
  const fields = new URLSearchParams(decodeUtf8(body));
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of fields) {
    if (FORBIDDEN_KEYS.has(key)) throw new Refusal(400, "forbidden_key");
    if (seen.has(key)) throw new Refusal(400, "repeated_field");
    seen.add(key);
    result[key] = value;
  }
  return result;
}

function routeConfig(request: FastifyRequest): OculusRouteConfig | undefined {
  return request.routeOptions.config.oculus;
}

/** Refuses compressed bodies and repeated Content-Type headers (an onRequest check). */
export function bodyHeaderProblem(request: FastifyRequest): Refusal | undefined {
  const encoding = request.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    return new Refusal(415, "unsupported_media_type");
  }
  const raw = request.raw.rawHeaders;
  let contentTypes = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "content-type") contentTypes++;
  }
  return contentTypes > 1 ? new Refusal(400, "bad_request") : undefined;
}

/** Replaces Fastify's parsers with Oculus's two. */
export function registerBodyParsers(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(JSON_TYPE, { parseAs: "buffer" }, (request, body, done) => {
    try {
      if (!isExactMediaType(request.headers["content-type"], JSON_TYPE)) {
        throw new Refusal(415, "unsupported_media_type");
      }
      done(null, parseJsonBody(body as Buffer));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  app.addContentTypeParser(FORM_TYPE, { parseAs: "buffer" }, (request, body, done) => {
    try {
      if (
        routeConfig(request)?.form !== true ||
        !isExactMediaType(request.headers["content-type"], FORM_TYPE)
      ) {
        throw new Refusal(415, "unsupported_media_type");
      }
      done(null, parseFormBody(body as Buffer));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

/** The body limit a route gets: never above 8 KiB on credentials routes. */
export function routeBodyLimit(
  config: OculusRouteConfig | undefined,
  requested: number | undefined,
): number | undefined {
  if (config?.credentials !== true) return requested;
  return Math.min(requested ?? CREDENTIALS_BODY_LIMIT, CREDENTIALS_BODY_LIMIT);
}
