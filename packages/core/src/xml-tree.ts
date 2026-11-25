/**
 * Reading untrusted XML safely, into a small tree (D-107, D-110).
 *
 * Built on `saxes` (ISC), a streaming, non-validating parser that never
 * fetches anything and knows only XML's five predefined entities. On top of
 * that this module:
 * - refuses a DOCTYPE with an internal subset (`<!DOCTYPE x [ ... ]>`), the
 *   only place entities could be declared, so "billion laughs" and XXE
 *   payloads never get as far as an entity; an external DTD named in a
 *   DOCTYPE (`SYSTEM "ead.dtd"`) is allowed and ignored, never fetched;
 * - refuses any entity it doesn't know (`&nbsp;`, `&mdash;`) instead of
 *   guessing what a DTD would have said;
 * - caps the input size, element nesting, element count, attributes per
 *   element and attribute length, and stops at the first limit reached;
 * - decodes bytes only in the encodings listed below, strictly (a broken
 *   byte is an error, not a replacement character).
 *
 * Comments and processing instructions are not content and are left out.
 * CDATA sections become text. Never throws: every problem is an `Issue`.
 */
import { SaxesParser, type SaxesTagNS } from "saxes";
import { issue, type Validated } from "./issues.js";
import { shown } from "./plain-data.js";

/** The largest file read: 50 MiB (D-107). */
export const MAX_XML_BYTES = 50 * 1024 * 1024;
/** Element nesting, counted from the root (D-110: 64 levels of units plus their description). */
export const MAX_XML_DEPTH = 128;
/** Elements in one file. */
export const MAX_XML_ELEMENTS = 500_000;
/** Attributes on one element. */
export const MAX_XML_ATTRIBUTES = 64;
/** The longest attribute value. */
export const MAX_XML_ATTRIBUTE_LENGTH = 10_000;
/**
 * Attributes in the whole file. Each one costs far more memory than its
 * bytes, so a file of empty attributes could otherwise exhaust memory.
 */
export const MAX_XML_TOTAL_ATTRIBUTES = 1_000_000;

export interface XmlAttribute {
  /** Local name, without a prefix. */
  readonly name: string;
  /** Namespace URI, or "" for none. */
  readonly ns: string;
  readonly value: string;
}

export interface XmlElement {
  /** Local name, without a prefix. */
  readonly name: string;
  /** Namespace URI, or "" for none. */
  readonly ns: string;
  readonly attributes: readonly XmlAttribute[];
  /** Child elements and text, in document order. Adjacent text is joined. */
  readonly children: readonly (XmlElement | string)[];
  /** The line the start tag was on, for messages. */
  readonly line: number;
}

/** Encodings accepted in a byte input's XML declaration (WHATWG labels). */
const ENCODINGS: ReadonlyMap<string, string> = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["us-ascii", "utf-8"],
  ["ascii", "utf-8"],
  ["iso-8859-1", "windows-1252"],
  ["latin1", "windows-1252"],
  ["windows-1252", "windows-1252"],
  ["cp1252", "windows-1252"],
  ["utf-16", "utf-16le"],
  ["utf-16le", "utf-16le"],
  ["utf-16be", "utf-16be"],
]);

const CHUNK = 64 * 1024;

class Stop extends Error {}

interface Building {
  readonly name: string;
  readonly ns: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: (XmlElement | string)[];
  readonly line: number;
}

/** Turn bytes into text, honoring a BOM or the XML declaration's encoding. */
function decode(bytes: Uint8Array): Validated<string> {
  let label = "utf-8";
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    label = "utf-16le";
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    label = "utf-16be";
    start = 2;
  } else if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    label = "utf-16le";
  } else if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    label = "utf-16be";
  } else {
    // The declaration is ASCII in every ASCII-compatible encoding.
    const head = String.fromCharCode(...bytes.subarray(0, 200));
    const declared = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head);
    if (declared?.[1] !== undefined) {
      const wanted = ENCODINGS.get(declared[1].toLowerCase());
      if (wanted === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              [],
              "unsupported_encoding",
              `The file says it is in the ${shown(declared[1])} encoding, which can't be read. Save it as UTF-8 and try again.`,
            ),
          ],
        };
      }
      label = wanted;
    }
  }
  try {
    return {
      ok: true,
      value: new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start)),
    };
  } catch {
    return {
      ok: false,
      issues: [
        issue(
          [],
          "bad_encoding",
          `The file has bytes that aren't valid ${label === "windows-1252" ? "Latin-1" : label.toUpperCase()}.`,
        ),
      ],
    };
  }
}

/**
 * Parse untrusted XML text or bytes into a tree, or report why it can't be.
 * The result is the root element.
 */
export function parseXml(input: string | Uint8Array): Validated<XmlElement> {
  const fail = (code: string, message: string): Validated<XmlElement> => ({
    ok: false,
    issues: [issue([], code, message)],
  });
  let text: string;
  if (typeof input === "string") {
    if (input.length > MAX_XML_BYTES || Buffer.byteLength(input, "utf8") > MAX_XML_BYTES) {
      return fail("too_large", "The file is larger than 50 MB.");
    }
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_XML_BYTES)
      return fail("too_large", "The file is larger than 50 MB.");
    const decoded = decode(input);
    if (!decoded.ok) return decoded;
    text = decoded.value;
  } else {
    return fail("not_xml", "Expected the text or bytes of an XML file.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack: Building[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let attributeCount = 0;
  let problem: { code: string; message: string } | undefined;
  const stop = (code: string, message: string): never => {
    problem = { code, message };
    throw new Stop(message);
  };

  parser.on("error", (err: Error) => {
    stop("not_well_formed", `The file isn't well-formed XML: ${err.message}`);
  });
  parser.on("doctype", (doctype: string) => {
    // Quoted public and system identifiers may hold a "[" of their own.
    if (doctype.replace(/"[^"]*"|'[^']*'/g, "").includes("[")) {
      stop(
        "doctype_subset",
        "The file declares its own entities or DTD rules (a DOCTYPE with [ ... ]). That isn't allowed: remove the internal DTD subset and try again.",
      );
    }
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) {
      stop("too_many_elements", `The file has more than ${String(MAX_XML_ELEMENTS)} elements.`);
    }
    if (stack.length >= MAX_XML_DEPTH) {
      stop("too_deep", `Elements are nested more than ${String(MAX_XML_DEPTH)} levels deep.`);
    }
    const attributes: XmlAttribute[] = [];
    for (const attr of Object.values(tag.attributes)) {
      // Namespace declarations are how names are read, not data.
      if (attr.prefix === "xmlns" || attr.name === "xmlns") continue;
      attributeCount += 1;
      if (attributeCount > MAX_XML_TOTAL_ATTRIBUTES) {
        stop(
          "too_many_attributes",
          `The file has more than ${String(MAX_XML_TOTAL_ATTRIBUTES)} attributes.`,
        );
      }
      if (attributes.length >= MAX_XML_ATTRIBUTES) {
        stop(
          "too_many_attributes",
          `An element has more than ${String(MAX_XML_ATTRIBUTES)} attributes.`,
        );
      }
      if (attr.value.length > MAX_XML_ATTRIBUTE_LENGTH) {
        stop(
          "attribute_too_long",
          `An attribute is longer than ${String(MAX_XML_ATTRIBUTE_LENGTH)} characters.`,
        );
      }
      attributes.push({ name: attr.local, ns: attr.uri, value: attr.value });
    }
    stack.push({
      name: tag.local,
      ns: tag.uri,
      attributes,
      children: [],
      line: parser.line,
    });
  });
  const addText = (value: string): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) return; // whitespace around the root
    const last = top.children[top.children.length - 1];
    if (typeof last === "string") top.children[top.children.length - 1] = last + value;
    else top.children.push(value);
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  parser.on("closetag", () => {
    const done = stack.pop();
    if (done === undefined) return;
    const element: XmlElement = {
      name: done.name,
      ns: done.ns,
      attributes: done.attributes,
      children: done.children,
      line: done.line,
    };
    const parent = stack[stack.length - 1];
    if (parent === undefined) root = element;
    else parent.children.push(element);
  });

  try {
    for (let i = 0; i < text.length; i += CHUNK) parser.write(text.slice(i, i + CHUNK));
    parser.close();
  } catch (err) {
    if (problem !== undefined) return fail(problem.code, problem.message);
    return fail("not_well_formed", `The file isn't well-formed XML: ${(err as Error).message}`);
  }
  if (root === undefined) return fail("not_xml", "The file has no XML root element.");
  return { ok: true, value: root };
}
