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
 * - Bodies must be valid UTF-8 without a byte order mark. Keys `__proto__`,
 *   `constructor` and `prototype` (the same list as `FORBIDDEN_KEYS` in
 *   @oculus/core) are refused anywhere in a JSON body and in form fields.
 *   JSON keys repeated within one object, nesting deeper than 64 and numbers
 *   too large for a double (`1e400`) are refused; so are form fields given
 *   twice and form text with bad percent-encoding.
 * - Limits are counted in bytes as the body arrives, chunked bodies included
 *   (Fastify counts the raw bytes and also refuses a body longer than its
 *   Content-Length): 1 MiB by default and 8 KiB on routes whose config says
 *   `oculus: { credentials: true }` (sign-in, two-step and site password
 *   posts, D-052). Routes can't choose their own limit (server.ts).
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

/** How deeply JSON arrays and objects may nest. */
export const MAX_JSON_DEPTH = 64;

/**
 * True when a Content-Type header is exactly `type`, optionally followed by
 * `charset=utf-8`. Whitespace follows RFC 9110 §8.3.1: spaces or tabs only
 * around `;`, none around `=`.
 */
export function isExactMediaType(header: string | undefined, type: string): boolean {
  if (header === undefined) return false;
  const lower = header.toLowerCase();
  if (!lower.startsWith(type)) return false;
  const rest = lower.slice(type.length);
  return rest === "" || /^[ \t]*;[ \t]*charset=(?:utf-8|"utf-8")$/.test(rest);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8(body: Uint8Array): string {
  try {
    return UTF8.decode(body);
  } catch {
    throw new Refusal(400, "bad_body");
  }
}

function hasBom(body: Uint8Array): boolean {
  return body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
}

/**
 * Checks valid JSON text in one pass, without recursion: nesting depth,
 * prototype keys, keys repeated within one object (compared after unescaping,
 * so "a" and "a" are the same key) and numbers too large for a double.
 */
function checkJsonText(text: string): void {
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{" || c === "[") {
      stack.push({ keys: c === "{" ? new Set() : null, expectKey: c === "{" });
      if (stack.length > MAX_JSON_DEPTH) throw new Refusal(400, "too_deep");
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i++;
    } else if (c === "," || c === ":") {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = c === ",";
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (FORBIDDEN_KEYS.has(key)) throw new Refusal(400, "forbidden_key");
        if (top.keys.has(key)) throw new Refusal(400, "repeated_key");
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
    } else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9eE+.-]/.test(text[j] ?? "")) j++;
      if (!Number.isFinite(Number(text.slice(i, j)))) throw new Refusal(400, "bad_number");
      i = j;
    } else {
      i++;
    }
  }
}

/**
 * Parses a JSON body. Refuses a byte order mark, bad UTF-8, bad JSON, nesting
 * deeper than 64, prototype keys, repeated keys and non-finite numbers.
 */
export function parseJsonBody(body: Uint8Array): unknown {
  if (hasBom(body)) throw new Refusal(400, "bad_body");
  const text = decodeUtf8(body);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(400, "bad_body");
  }
  checkJsonText(text);
  return value;
}

/** Strict form decoding: `+` is a space, `%` must start two hex digits, bytes must be UTF-8. */
function decodeFormPart(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0x2b) {
      out[n++] = 0x20;
    } else if (b === 0x25) {
      const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Refusal(400, "bad_body");
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return decodeUtf8(out.subarray(0, n));
}

/** Parses a form body into one string per field; refuses repeats, prototype keys and bad encoding. */
export function parseFormBody(body: Uint8Array): Record<string, string> {
  if (hasBom(body)) throw new Refusal(400, "bad_body");
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  let start = 0;
  while (start <= body.length) {
    let end = body.indexOf(0x26, start);
    if (end === -1) end = body.length;
    const pair = body.subarray(start, end);
    start = end + 1;
    if (pair.length === 0) continue;
    const eq = pair.indexOf(0x3d);
    const key = decodeFormPart(eq === -1 ? pair : pair.subarray(0, eq));
    const value = eq === -1 ? "" : decodeFormPart(pair.subarray(eq + 1));
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
