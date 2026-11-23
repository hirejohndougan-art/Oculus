/**
 * Path refusals and the 405 route table (D-051).
 *
 * `pathProblem` refuses, before any handler runs, a request path that:
 * - doesn't start with `/` (absolute-form `http://host/...` and `*` included)
 * - holds a backslash, NUL or other control character, raw or encoded
 * - holds an encoded slash, backslash, NUL or dot (`%2F`, `%5C`, `%00`, `%2E`),
 *   or is still percent-encoded after one decoding (double encoding)
 * - percent-encodes a letter, digit, `-`, `_` or `~` (`/item%73`): these
 *   never need encoding, so only a client hiding a path from a check sends them
 * - has a `.` or `..` segment, or an empty segment (`//`) anywhere but the end
 * - isn't valid percent-encoded UTF-8
 *
 * `RouteTable` records every route's method and URL pattern so the not-found
 * handler can tell an unknown path (404) from a known path asked with the
 * wrong method (405, with `Allow`). Patterns are kept to what it can match
 * exactly: static segments, whole-segment `:name` parameters and a final `*`.
 * Any other find-my-way syntax (regular expressions, several parameters in
 * one segment, `::` escapes) is refused when the route is added.
 */

/** The path part of a request target: everything before `?` or `#`. */
export function pathOf(rawUrl: string): string {
  const end = rawUrl.search(/[?#]/);
  return end === -1 ? rawUrl : rawUrl.slice(0, end);
}

// eslint-disable-next-line no-control-regex -- control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODED_FORBIDDEN = /%(?:2f|5c|00|2e)/i;
const STILL_ENCODED = /%[0-9a-f]{2}/i;
// %30-%39 digits, %41-%5A and %61-%7A letters, %2D "-", %5F "_", %7E "~".
const ENCODED_UNRESERVED = /%(?:3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|2d|5f|7e)/i;

/** Why a request path is refused, or `undefined` when it is acceptable. */
export function pathProblem(rawUrl: string | undefined): string | undefined {
  if (!rawUrl?.startsWith("/")) return "not an origin-form path";
  const path = pathOf(rawUrl);
  if (path.includes("\\")) return "backslash";
  if (CONTROL.test(path)) return "control character";
  if (ENCODED_FORBIDDEN.test(path)) return "encoded slash, backslash, NUL or dot";
  if (ENCODED_UNRESERVED.test(path)) return "encoded unreserved character";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "bad percent-encoding";
  }
  if (decoded.includes("\\") || CONTROL.test(decoded)) return "backslash or control character";
  if (STILL_ENCODED.test(decoded)) return "double encoding";
  const segments = decoded.split("/");
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "." || segment === "..") return "dot segment";
    if (segment === "" && i < segments.length - 1) return "empty segment";
  }
  return undefined;
}

type Segment =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "param" }
  | { readonly kind: "wildcard" };

const PARAM_NAME = /^:[A-Za-z_][A-Za-z0-9_]*$/;

function compilePattern(url: string): readonly Segment[] {
  if (!url.startsWith("/")) throw new Error(`route URL must start with "/": ${url}`);
  const parts = url.split("/").slice(1);
  return parts.map((part, index): Segment => {
    if (part === "*" && index === parts.length - 1) return { kind: "wildcard" };
    if (PARAM_NAME.test(part)) return { kind: "param" };
    if (/[:*()]/.test(part)) {
      throw new Error(
        `route URL ${url} uses router syntax the HTTP layer doesn't support ` +
          `(only static segments, whole-segment :name parameters and a final *)`,
      );
    }
    return { kind: "static", text: part };
  });
}

function matches(pattern: readonly Segment[], segments: readonly string[], maxParamLength: number) {
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part === undefined) return false;
    const segment = segments[i];
    if (segment === undefined) return false;
    if (part.kind === "wildcard") return true;
    if (
      part.kind === "static"
        ? segment !== part.text
        : segment === "" || segment.length > maxParamLength
    ) {
      return false;
    }
  }
  return segments.length === pattern.length;
}

export class RouteTable {
  readonly #routes = new Map<string, { pattern: readonly Segment[]; methods: Set<string> }>();
  readonly #maxParamLength: number;

  constructor(maxParamLength: number) {
    this.#maxParamLength = maxParamLength;
  }

  /** Records a route; throws for URL syntax the table can't match exactly. */
  add(methods: string | readonly string[], url: string): void {
    let entry = this.#routes.get(url);
    if (entry === undefined) {
      entry = { pattern: compilePattern(url), methods: new Set() };
      this.#routes.set(url, entry);
    }
    for (const method of typeof methods === "string" ? [methods] : methods) {
      entry.methods.add(method.toUpperCase());
      if (method.toUpperCase() === "GET") entry.methods.add("HEAD");
    }
  }

  /** Every method some route accepts for this (already checked) path, sorted. */
  allowedMethods(path: string): string[] {
    let segments: string[];
    try {
      segments = decodeURIComponent(path).split("/").slice(1);
    } catch {
      return [];
    }
    const allowed = new Set<string>();
    for (const { pattern, methods } of this.#routes.values()) {
      if (matches(pattern, segments, this.#maxParamLength)) {
        for (const method of methods) allowed.add(method);
      }
    }
    return [...allowed].sort();
  }
}
