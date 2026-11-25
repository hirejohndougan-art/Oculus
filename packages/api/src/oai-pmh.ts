/**
 * OAI-PMH 2.0 for a public host's published records (T-050c, D-105).
 *
 * `GET /oai` on a host `OCULUS_PUBLIC_SITES` maps to a site answers the six
 * verbs (Identify, ListMetadataFormats, ListSets, ListIdentifiers,
 * ListRecords, GetRecord) with `oai_dc` only, and no sets. On any other
 * host it is the unknown path's 404. It is mounted only when
 * `OCULUS_OAI_ADMIN_EMAIL` names the address Identify must give.
 *
 * Every record shown is read through the public reader (`readPublicRecord`,
 * D-080) with the template's stored mapping (D-096), as `GET /records/:id`
 * reads it (D-100): its `oai_dc` is core's `oaiDcXml`. The lists come from
 * the staff connection (`listPublishedForOai`, as D-095 counts subjects), in
 * datestamp order, and every listed record is read again through the public
 * reader; one that doesn't come back (public output holds it back) is left
 * out, so neither its metadata nor its ID leaves.
 *
 * The replies are `text/xml`, which D-058 and S-025 refuse as active content:
 * they go out only through `oaiPmhReply` (file-replies.ts), whose document
 * is checked to be an OAI-PMH root with no processing instruction or
 * declaration, with nosniff and the sandboxing CSP. Every value written into
 * the XML is escaped here, and characters XML 1.0 can't hold are refused
 * (in arguments) or dropped (in stored names).
 *
 * Choices (D-105): identifiers `oai:<host>:<record ID>`; datestamps to the
 * second; `deletedRecord` `no`; no sets; GET only (rule 5 needs an `Origin`
 * on POST); stateless resumption tokens of 25 records; each client address
 * may make `DEFAULT_RATE_LIMITS.oai` requests a minute (429 with
 * `Retry-After`), and a request holds one of the public pool's slots for
 * its whole page (503 `busy` with `Retry-After` when none is free).
 */
import { isRecordId } from "@oculus/core";
import {
  listPublishedForOai,
  oaiDatestamp,
  oaiRepository,
  readPublicRecord,
  type Database,
  type OaiCandidate,
} from "@oculus/db";
import { Refusal } from "./errors.js";
import { oaiPmhReply, OAI_PMH_PROLOGUE } from "./file-replies.js";
import { clientKey, originOf, ReadSlots } from "./public-api.js";
import type { PublicSite } from "./public-sites.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";
import type { OculusRequest, OculusReply, OculusRoute } from "./routes.js";
import type { ApiLogRecord } from "./staff-api.js";

/** The environment variable naming Identify's `adminEmail`. */
export const OAI_ADMIN_EMAIL_ENV = "OCULUS_OAI_ADMIN_EMAIL";

/** Records (or headers) on one page of a list. */
export const OAI_PAGE_SIZE = 25;
/** The most listed records one request reads, shown or held back. */
export const OAI_MAX_SCAN = 200;

const OAI_NS = "http://www.openarchives.org/OAI/2.0/";
const OAI_SCHEMA = "http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd";
const OAI_DC_PREFIX = "oai_dc";
const OAI_DC_SCHEMA = "http://www.openarchives.org/OAI/2.0/oai_dc.xsd";
const OAI_DC_NAMESPACE = "http://www.openarchives.org/OAI/2.0/oai_dc/";
/** A lower bound for every datestamp when the site has no records yet. */
const NO_RECORDS_EARLIEST = "1970-01-01T00:00:00Z";

export interface OaiPmhOptions {
  /** The public reader's pool (D-080): every record shown is read through it. */
  readonly publicDb: Database;
  /** The staff connection: the lists and datestamps only (oai.ts). */
  readonly db: Database;
  readonly sites: readonly PublicSite[];
  /** Identify's `adminEmail` (`OCULUS_OAI_ADMIN_EMAIL`). */
  readonly adminEmail: string;
  readonly log?: (record: ApiLogRecord) => void;
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  readonly clock?: () => number;
  /** The public pool's slots, shared with `GET /records/:id`. */
  readonly slots?: ReadSlots;
}

/** An address fit for `adminEmail`, or undefined: plain, short, nothing XML must escape. */
export function oaiAdminEmail(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) {
    throw new Error(
      `refusing to start: ${OAI_ADMIN_EMAIL_ENV} must be one plain email address (D-105).`,
    );
  }
  return value;
}

// ---------------------------------------------------------------- XML

/** Characters XML 1.0 can hold (§2.2), lone surrogates excluded. */
const XML_CHAR = /^[\t\n\r -퟿-�\u{10000}-\u{10FFFF}]*$/u;
const NOT_XML_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

function escape(text: string): string {
  return text
    .replace(NOT_XML_CHAR, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;");
}

function element(name: string, text: string): string {
  return `<${name}>${escape(text)}</${name}>`;
}

/** A second-granularity UTC datestamp. */
function secondsOf(stamp: string): string {
  return `${stamp.slice(0, 19)}Z`;
}

type OaiError =
  | "badArgument"
  | "badResumptionToken"
  | "badVerb"
  | "cannotDisseminateFormat"
  | "idDoesNotExist"
  | "noRecordsMatch"
  | "noMetadataFormats"
  | "noSetHierarchy";

const ERROR_TEXT: Readonly<Record<OaiError, string>> = {
  badArgument: "The request has an argument that is missing, repeated, unknown or malformed.",
  badResumptionToken: "The resumption token is not valid.",
  badVerb: "The verb is missing, repeated or not an OAI-PMH verb.",
  cannotDisseminateFormat: "This repository offers oai_dc only.",
  idDoesNotExist: "No public record has this identifier.",
  noRecordsMatch: "No public records match.",
  noMetadataFormats: "No metadata formats are available for this item.",
  noSetHierarchy: "This repository has no sets.",
};

function documentOf(
  responseDate: string,
  baseUrl: string,
  request: Readonly<Record<string, string>> | undefined,
  body: string,
): string {
  const attributes =
    request === undefined
      ? ""
      : Object.entries(request)
          .map(([name, value]) => ` ${name}="${escape(value)}"`)
          .join("");
  return [
    `${OAI_PMH_PROLOGUE} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${OAI_NS} ${OAI_SCHEMA}">`,
    element("responseDate", responseDate),
    `<request${attributes}>${escape(baseUrl)}</request>`,
    body,
    "</OAI-PMH>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- arguments

const VERBS: Readonly<Record<string, readonly string[]>> = {
  Identify: [],
  ListMetadataFormats: ["identifier"],
  ListSets: ["resumptionToken"],
  GetRecord: ["identifier", "metadataPrefix"],
  ListIdentifiers: ["metadataPrefix", "from", "until", "set", "resumptionToken"],
  ListRecords: ["metadataPrefix", "from", "until", "set", "resumptionToken"],
};

class OaiFailure extends Error {
  constructor(
    readonly code: OaiError,
    /** Whether the request element may echo the arguments (not for badVerb or badArgument). */
    readonly echo: boolean,
  ) {
    super(code);
  }
}

const fail = (code: OaiError, echo = true): never => {
  throw new OaiFailure(code, echo);
};

/** The longest argument value read; anything longer is a bad argument. */
const MAX_ARGUMENT = 512;

/** The request's arguments, each once, as plain strings; or the OAI-PMH error. */
function argumentsOf(query: OculusRequest["query"]): {
  verb: string;
  args: Record<string, string>;
} {
  const verb = query.verb;
  if (typeof verb !== "string" || !Object.hasOwn(VERBS, verb)) return fail("badVerb", false);
  const allowed = VERBS[verb] ?? [];
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (name === "verb") continue;
    if (!allowed.includes(name)) return fail("badArgument", false);
    if (
      typeof value !== "string" ||
      value === "" ||
      value.length > MAX_ARGUMENT ||
      !XML_CHAR.test(value)
    ) {
      return fail("badArgument", false);
    }
    args[name] = value;
  }
  return { verb, args };
}

/** `from` and `until` as instants: from inclusive, `before` exclusive. */
interface Window {
  readonly from?: string;
  readonly before?: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function instantOf(value: string): { at: number; day: boolean } | undefined {
  const day = DAY.test(value);
  if (!day && !SECOND.test(value)) return undefined;
  const at = Date.parse(day ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(at)) return undefined;
  // A date that rolls over (2026-02-30) isn't one.
  const back = new Date(at).toISOString();
  if ((day ? back.slice(0, 10) : `${back.slice(0, 19)}Z`) !== value) return undefined;
  return { at, day };
}

function windowOf(from: string | undefined, until: string | undefined): Window {
  const f = from === undefined ? undefined : instantOf(from);
  const u = until === undefined ? undefined : instantOf(until);
  if ((from !== undefined && f === undefined) || (until !== undefined && u === undefined)) {
    return fail("badArgument");
  }
  if (f !== undefined && u !== undefined && f.day !== u.day) return fail("badArgument");
  if (f !== undefined && u !== undefined && f.at > u.at) return fail("badArgument");
  const before = u === undefined ? undefined : u.at + (u.day ? 86_400_000 : 1000);
  return {
    ...(f === undefined ? {} : { from: new Date(f.at).toISOString() }),
    ...(before === undefined ? {} : { before: new Date(before).toISOString() }),
  };
}

// ---------------------------------------------------------------- tokens

interface Cursor {
  readonly window: Window;
  readonly after: OaiCandidate;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tokenOf(cursor: Cursor): string {
  const plain = [
    cursor.window.from ?? "",
    cursor.window.before ?? "",
    cursor.after.stamp,
    cursor.after.id,
  ];
  return Buffer.from(JSON.stringify(plain), "utf8").toString("base64url");
}

function cursorOf(token: string): Cursor {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(token)) return fail("badResumptionToken");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) return fail("badResumptionToken");
  let plain: unknown;
  try {
    plain = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("badResumptionToken");
  }
  if (!Array.isArray(plain) || plain.length !== 4 || !plain.every((p) => typeof p === "string")) {
    return fail("badResumptionToken");
  }
  const [from, before, stamp, id] = plain as [string, string, string, string];
  const stampOk = (value: string): boolean =>
    STAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  if (
    (from !== "" && !stampOk(from)) ||
    (before !== "" && !stampOk(before)) ||
    !stampOk(stamp) ||
    !isRecordId(id)
  ) {
    return fail("badResumptionToken");
  }
  return {
    window: { ...(from === "" ? {} : { from }), ...(before === "" ? {} : { before }) },
    after: { stamp, id },
  };
}

// ---------------------------------------------------------------- routes

/** A record's identifier on this host. */
function identifierFor(host: string, id: string): string {
  return `oai:${host}:${id}`;
}

/** The record ID an identifier on this host names, or undefined. */
function recordIdOf(host: string, identifier: string): string | undefined {
  const prefix = `oai:${host}:`;
  if (!identifier.startsWith(prefix)) return undefined;
  const id = identifier.slice(prefix.length);
  return isRecordId(id) ? id : undefined;
}

const NOT_FOUND = (): Refusal => new Refusal(404, "not_found");

/** The OAI-PMH route, for `buildServer({ routes })` beside the public record reads. */
export function oaiPmhRoutes(options: OaiPmhOptions): OculusRoute[] {
  const byOrigin = new Map(options.sites.map((site) => [site.origin, site]));
  const limiter = new SessionRateLimiter(
    { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    options.clock,
  );
  const log = options.log ?? (() => undefined);
  const clock = options.clock ?? Date.now;
  const slots = options.slots ?? new ReadSlots(4);
  const adminEmail = oaiAdminEmail(options.adminEmail);
  if (adminEmail === undefined) throw new Error("oaiPmhRoutes needs an admin email");
  const email: string = adminEmail;

  /** The public output of a record public on the site, or undefined. */
  async function publicRecord(site: PublicSite, id: string) {
    if (!isRecordId(id)) return undefined;
    const result = await readPublicRecord(options.publicDb, site.organizationId, site.siteId, id, {
      baseUrl: `${site.origin}/records/`,
    });
    return result.ok ? result.value : undefined;
  }

  function header(host: string, id: string, stamp: string): string {
    return `<header>${element("identifier", identifierFor(host, id))}${element("datestamp", secondsOf(stamp))}</header>`;
  }

  function metadata(oaiDcXml: string): string {
    // Core's document without its XML declaration; its root is oai_dc:dc.
    const body = oaiDcXml.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, "");
    if (!body.startsWith("<oai_dc:dc ") || body.includes("<?") || body.includes("<!")) {
      throw new Error("core's oai_dc record is not as expected");
    }
    return `<metadata>\n${body.trimEnd()}\n</metadata>`;
  }

  async function identify(site: PublicSite, baseUrl: string): Promise<string> {
    const repository = await oaiRepository(options.db, site.organizationId, site.siteId);
    if (repository === undefined) throw new Error("the public site is gone");
    return [
      "<Identify>",
      element("repositoryName", repository.name),
      element("baseURL", baseUrl),
      element("protocolVersion", "2.0"),
      element("adminEmail", email),
      element(
        "earliestDatestamp",
        repository.earliest === undefined ? NO_RECORDS_EARLIEST : secondsOf(repository.earliest),
      ),
      element("deletedRecord", "no"),
      element("granularity", "YYYY-MM-DDThh:mm:ssZ"),
      "</Identify>",
    ].join("\n");
  }

  function formats(): string {
    return [
      "<ListMetadataFormats>",
      "<metadataFormat>",
      element("metadataPrefix", OAI_DC_PREFIX),
      element("schema", OAI_DC_SCHEMA),
      element("metadataNamespace", OAI_DC_NAMESPACE),
      "</metadataFormat>",
      "</ListMetadataFormats>",
    ].join("\n");
  }

  async function getRecord(site: PublicSite, host: string, args: Record<string, string>) {
    const { identifier, metadataPrefix } = args;
    if (identifier === undefined || metadataPrefix === undefined) return fail("badArgument", false);
    const id = recordIdOf(host, identifier);
    const output = id === undefined ? undefined : await publicRecord(site, id);
    if (id === undefined || output === undefined) return fail("idDoesNotExist");
    if (metadataPrefix !== OAI_DC_PREFIX) return fail("cannotDisseminateFormat");
    const stamp = await oaiDatestamp(options.db, site.organizationId, site.siteId, id);
    if (stamp === undefined) return fail("idDoesNotExist");
    return [
      "<GetRecord>",
      "<record>",
      header(host, id, stamp),
      metadata(output.oaiDcXml),
      "</record>",
      "</GetRecord>",
    ].join("\n");
  }

  async function list(
    site: PublicSite,
    host: string,
    verb: "ListIdentifiers" | "ListRecords",
    args: Record<string, string>,
  ): Promise<string> {
    let cursor: { window: Window; after?: OaiCandidate };
    const token = args.resumptionToken;
    if (token !== undefined) {
      // resumptionToken is exclusive (OAI-PMH §3.5).
      if (Object.keys(args).length !== 1) return fail("badArgument", false);
      cursor = cursorOf(token);
    } else {
      if (args.metadataPrefix === undefined) return fail("badArgument", false);
      if (args.metadataPrefix !== OAI_DC_PREFIX) return fail("cannotDisseminateFormat");
      if (args.set !== undefined) return fail("noSetHierarchy");
      cursor = { window: windowOf(args.from, args.until) };
    }
    const shown: string[] = [];
    let after = cursor.after;
    let scanned = 0;
    let exhausted = false;
    while (shown.length < OAI_PAGE_SIZE && scanned < OAI_MAX_SCAN && !exhausted) {
      const want = Math.min(OAI_PAGE_SIZE - shown.length + 5, OAI_MAX_SCAN - scanned);
      const candidates = await listPublishedForOai(options.db, site.organizationId, site.siteId, {
        ...cursor.window,
        ...(after === undefined ? {} : { after }),
        limit: want,
      });
      if (candidates.length < want) exhausted = true;
      for (const candidate of candidates) {
        if (shown.length >= OAI_PAGE_SIZE) {
          exhausted = false;
          break;
        }
        scanned += 1;
        after = candidate;
        const output = await publicRecord(site, candidate.id);
        if (output === undefined) continue;
        shown.push(
          verb === "ListIdentifiers"
            ? header(host, candidate.id, candidate.stamp)
            : `<record>\n${header(host, candidate.id, candidate.stamp)}\n${metadata(output.oaiDcXml)}\n</record>`,
        );
      }
    }
    if (shown.length === 0 && exhausted) return fail("noRecordsMatch");
    let resumption = "";
    if (!exhausted && after !== undefined) {
      resumption = element("resumptionToken", tokenOf({ window: cursor.window, after }));
    } else if (token !== undefined) {
      // The last page of a list that was resumed ends with an empty token.
      resumption = "<resumptionToken/>";
    }
    return [`<${verb}>`, ...shown, ...(resumption === "" ? [] : [resumption]), `</${verb}>`].join(
      "\n",
    );
  }

  async function answer(
    site: PublicSite,
    host: string,
    verb: string,
    args: Record<string, string>,
    baseUrl: string,
  ): Promise<string> {
    switch (verb) {
      case "Identify":
        return identify(site, baseUrl);
      case "ListMetadataFormats": {
        const identifier = args.identifier;
        if (identifier !== undefined) {
          const id = recordIdOf(host, identifier);
          if (id === undefined || (await publicRecord(site, id)) === undefined) {
            return fail("idDoesNotExist");
          }
        }
        return formats();
      }
      case "ListSets":
        return args.resumptionToken === undefined
          ? fail("noSetHierarchy")
          : fail("badResumptionToken");
      case "GetRecord":
        return getRecord(site, host, args);
      case "ListIdentifiers":
      case "ListRecords":
        return list(site, host, verb, args);
      default:
        return fail("badVerb", false);
    }
  }

  return [
    {
      method: "GET",
      path: "/oai",
      handler: async (request: OculusRequest, reply: OculusReply) => {
        const origin = originOf(request);
        const site = origin === undefined ? undefined : byOrigin.get(origin);
        if (site === undefined || origin === undefined) throw NOT_FOUND();
        if (!limiter.take(clientKey(request.ip), "oai")) {
          reply.status(429).header("retry-after", "60");
          return { error: "rate_limited" };
        }
        if (!slots.take()) {
          reply.status(503).header("retry-after", "5");
          return { error: "busy" };
        }
        const host = new URL(origin).hostname;
        const baseUrl = `${origin}/oai`;
        const responseDate = `${new Date(clock()).toISOString().slice(0, 19)}Z`;
        let echoed: Record<string, string> | undefined;
        let body: string;
        try {
          const { verb, args } = argumentsOf(request.query);
          echoed = { verb, ...args };
          body = await answer(site, host, verb, args, baseUrl);
        } catch (thrown) {
          if (!(thrown instanceof OaiFailure)) {
            log({
              event: "service_error",
              operation: "oaiPmh",
              name: thrown instanceof Error ? thrown.constructor.name.slice(0, 40) : "unknown",
            });
            throw new Refusal(503, "unavailable");
          }
          if (!thrown.echo) echoed = undefined;
          body = `<error code="${thrown.code}">${escape(ERROR_TEXT[thrown.code])}</error>`;
        } finally {
          slots.give();
        }
        return oaiPmhReply(documentOf(responseDate, baseUrl, echoed, body));
      },
    },
  ];
}
