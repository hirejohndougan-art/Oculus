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
 * second, stored (S-041, D-108); `deletedRecord` `transient`; no sets; GET only (rule 5 needs an `Origin`
 * on POST); sealed resumption tokens of 25 records; each client address
 * may make `DEFAULT_RATE_LIMITS.oai` requests a minute (429 with
 * `Retry-After`), and a request holds one of the public pool's slots for
 * its whole page, OAI-PMH at most `OAI_MAX_SLOTS` of them (503 `busy` with
 * `Retry-After` when none is free). A read past its time limit (each
 * public read's `statement_timeout`, the public pool's wait for a
 * connection; S-037; the staff connection's statements, S-043a) is the same
 * `503 busy`. A list page's reading time runs on the routes' `clock`.
 *
 * A record whose public read ran out of time is remembered as slow
 * (`SlowReads`, shared with `GET /records/:id`; S-043b) and read with the
 * larger `SLOW_READ_TIME_LIMIT_MS` (in `SLOW_READ_BUDGET_MS` all told) from
 * then on: a list page reads it only with that whole budget left (else it
 * is the next page's first read). One whose list reads run out of time even
 * then, `OAI_SKIP_AFTER_STRIKES` times at least `SLOW_READ_STRIKE_GAP_MS`
 * apart with no read answering in between, is left out of the list (as a held-back record is: no header, nothing of
 * it leaves) and logged for staff as `oai_record_skipped` with its ID, so
 * a harvest goes on past it instead of stopping there for good. GetRecord
 * never skips: it answers `503 busy`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isRecordId } from "@oculus/core";
import {
  isDatabaseTimeout,
  listPublishedForOai,
  oaiRepository,
  oaiStoredStamp,
  readPublicRecord,
  TimeLimitError,
  type Database,
  type OaiCandidate,
} from "@oculus/db";
import { Refusal } from "./errors.js";
import { oaiPmhReply, OAI_PMH_PROLOGUE } from "./file-replies.js";
import {
  checkTimeLimit,
  clientKey,
  originOf,
  publicPoolOptions,
  ownTimeout,
  ReadSlots,
  readLimit,
  slowKey,
  SlowReads,
} from "./public-api.js";
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
/**
 * How long one list page may spend reading records (S-037). Past it the page
 * ends with what it has and a resumption token, so a slow database can't keep
 * a harvest in a slot for `OAI_MAX_SCAN` reads; at least one is always read.
 */
export const OAI_PAGE_TIME_LIMIT_MS = 15_000;
/** The longest one list read may take (the page's first; later ones get what is left). */
const LIST_READ_LIMIT_MS = 30_000;
/**
 * The real time a list request's reads may take in all (S-043b): the list
 * reads and the record reads, so a page ends (with a token, or `503 busy`
 * when nothing was read) inside the server's 30 s reply time
 * (`SERVER_TIMEOUTS.handler`), never cut off by it.
 */
export const OAI_REQUEST_BUDGET_MS = 25_000;

/**
 * A list leaves out a record whose list reads at the larger limit (S-043b)
 * ran out of time this many times, at least `SLOW_READ_STRIKE_GAP_MS` apart
 * and with none answering between, so a database that is only briefly slow
 * doesn't drop a record from a harvest.
 */
export const OAI_SKIP_AFTER_STRIKES = 2;

/** The most of the public pool's slots OAI-PMH holds at once. */
export const OAI_MAX_SLOTS = 2;

/**
 * The options for OAI-PMH's own pool on the staff role (S-051): one
 * connection per OAI slot, a bounded wait for one (then `503 busy`, as the
 * public pool), and the client-side query limit, so a request holding an
 * OAI slot and a shared public slot never waits without end.
 */
export function oaiPoolOptions(): {
  applicationName: string;
  max: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
} {
  return { ...publicPoolOptions(OAI_MAX_SLOTS), applicationName: "oculus-oai" };
}

const OAI_NS = "http://www.openarchives.org/OAI/2.0/";
const OAI_SCHEMA = "http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd";
const OAI_DC_PREFIX = "oai_dc";
const OAI_DC_SCHEMA = "http://www.openarchives.org/OAI/2.0/oai_dc.xsd";
const OAI_DC_NAMESPACE = "http://www.openarchives.org/OAI/2.0/oai_dc/";

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
  /**
   * Each read's statement time limit (S-037): every record read through the
   * public reader, and the staff connection's one-record reads and
   * Identify's (S-043a). Their defaults (5 s) when left out.
   */
  readonly timeLimitMs?: number;
  /** A list page's reading time (S-037); `OAI_PAGE_TIME_LIMIT_MS` when left out. */
  readonly pageTimeLimitMs?: number;
  /** Records known to be slow (S-043b), shared with `GET /records/:id`; one of its own when left out. */
  readonly slowReads?: SlowReads;
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

/** An attribute value: also tabs and line ends, which parsers would turn into spaces. */
function attribute(text: string): string {
  return escape(text).replace(/\t/g, "&#9;").replace(/\n/g, "&#10;");
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
          .map(([name, value]) => ` ${name}="${attribute(value)}"`)
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

/** The last instant a stamp can name (9999-12-31T23:59:59.999Z). */
const LATEST = Date.parse("9999-12-31T23:59:59.999Z");
/** The first instant PostgreSQL can hold in these terms (0001-01-01). */
const EARLIEST = Date.parse("0001-01-01T00:00:00.000Z");

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
  // Before year 1 (PostgreSQL has no year 0): `from` is no bound, and an
  // `until` there leaves nothing.
  if (u !== undefined && u.at < EARLIEST) return fail("noRecordsMatch");
  const start = f === undefined || f.at < EARLIEST ? undefined : f.at;
  const end = u === undefined ? undefined : u.at + (u.day ? 86_400_000 : 1000);
  // Past year 9999 (until=9999-12-31) there is no bound to give.
  const before = end === undefined || end > LATEST ? undefined : end;
  return {
    ...(start === undefined ? {} : { from: new Date(start).toISOString() }),
    ...(before === undefined ? {} : { before: new Date(before).toISOString() }),
  };
}

// ---------------------------------------------------------------- tokens

interface Cursor {
  readonly window: Window;
  readonly after: OaiCandidate;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Tokens are sealed (AES-256-GCM under a key made when the routes are),
 * since the last record a page scanned may be one public output holds back:
 * its ID and datestamp must not leave (D-105). A token from before a restart
 * is `badResumptionToken`, and the harvest starts again.
 */
class TokenSeal {
  private readonly key = randomBytes(32);

  seal(cursor: Cursor, site: string): string {
    const plain = [
      cursor.window.from ?? "",
      cursor.window.before ?? "",
      cursor.after.stamp,
      cursor.after.id,
    ];
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    // Tied to the site: another site's token is refused.
    cipher.setAAD(Buffer.from(site, "utf8"));
    const body = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
  }

  open(token: string, site: string): Cursor {
    if (!/^[A-Za-z0-9_-]{40,400}$/.test(token)) return fail("badResumptionToken");
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token || bytes.length < 29) {
      return fail("badResumptionToken");
    }
    let plain: unknown;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      decipher.setAAD(Buffer.from(site, "utf8"));
      const text = Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8");
      plain = JSON.parse(text);
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
  // OAI-PMH may hold at most two of the shared slots, so harvests (each
  // up to OAI_MAX_SCAN reads) never leave `GET /records/:id` without one.
  checkTimeLimit(options.timeLimitMs);
  const pageTimeLimitMs = options.pageTimeLimitMs ?? OAI_PAGE_TIME_LIMIT_MS;
  if (!Number.isInteger(pageTimeLimitMs) || pageTimeLimitMs < 1 || pageTimeLimitMs > 120_000) {
    throw new RangeError("pageTimeLimitMs must be a whole number from 1 to 120000");
  }
  const oaiSlots = new ReadSlots(Math.max(1, Math.min(OAI_MAX_SLOTS, slots.size - 1)));
  const tokens = new TokenSeal();
  const adminEmail = oaiAdminEmail(options.adminEmail);
  if (adminEmail === undefined) throw new Error("oaiPmhRoutes needs an admin email");
  const email: string = adminEmail;

  const slowReads =
    options.slowReads ?? new SlowReads(options.clock === undefined ? {} : { clock: options.clock });
  /** The whole time a record known to be slow may take to read (S-043b). */
  const slowBudgetMs = readLimit(options.timeLimitMs, slowReads).budgetMs;
  /** A read within this was quick again: no longer known slow (S-043b). */
  const normalLimitMs = readLimit(options.timeLimitMs, undefined).timeLimitMs;

  /**
   * The public output of a record public on the site, or undefined. A
   * record known to be slow is read with the larger limit (S-043b); a read
   * that runs out of time is remembered (`SlowReads`) and thrown on.
   */
  async function publicRecord(site: PublicSite, id: string, capMs?: number) {
    if (!isRecordId(id)) return undefined;
    const key = slowKey(site, id);
    const slow = slowReads.isSlow(key);
    const limit = readLimit(options.timeLimitMs, slow ? slowReads : undefined);
    // Never past what is left of the request (S-043b); nothing left is busy,
    // and not the record's doing, so it isn't remembered.
    const budgetMs = Math.min(limit.budgetMs, Math.floor(capMs ?? limit.budgetMs));
    if (budgetMs < 1) throw new TimeLimitError();
    const started = Date.now();
    let result: Awaited<ReturnType<typeof readPublicRecord>>;
    try {
      result = await readPublicRecord(options.publicDb, site.organizationId, site.siteId, id, {
        baseUrl: `${site.origin}/records/`,
        timeLimitMs: limit.timeLimitMs,
        budgetMs,
      });
    } catch (thrown) {
      if (ownTimeout(thrown)) slowReads.timedOut(key);
      throw thrown;
    }
    if (slow) slowReads.answered(key, Date.now() - started <= normalLimitMs);
    return result.ok ? result.value : undefined;
  }

  function header(host: string, id: string, stamp: string, deleted = false): string {
    return `<header${deleted ? ' status="deleted"' : ""}>${element("identifier", identifierFor(host, id))}${element("datestamp", secondsOf(stamp))}</header>`;
  }

  /** The staff reads' time limit (S-043a), as the public reads'. */
  const staffRead = options.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs };

  /** A record the pass has marked as no longer shown on the site, or undefined (S-041). */
  async function tombstone(site: PublicSite, id: string): Promise<string | undefined> {
    const stored = await oaiStoredStamp(
      options.db,
      site.organizationId,
      site.siteId,
      id,
      staffRead,
    );
    return stored?.deleted === true ? stored.stamp : undefined;
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
    const repository = await oaiRepository(options.db, site.organizationId, site.siteId, staffRead);
    if (repository === undefined) throw new Error("the public site is gone");
    return [
      "<Identify>",
      element("repositoryName", repository.name),
      element("baseURL", baseUrl),
      element("protocolVersion", "2.0"),
      element("adminEmail", email),
      element("earliestDatestamp", secondsOf(repository.earliest)),
      element("deletedRecord", "transient"),
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
    if (id === undefined) return fail("idDoesNotExist");
    const output = await publicRecord(site, id);
    // A record the site has shown has a stored datestamp (S-041); one it
    // never showed has none and is unknown, never "deleted".
    const stored = await oaiStoredStamp(
      options.db,
      site.organizationId,
      site.siteId,
      id,
      staffRead,
    );
    if (output === undefined) {
      // Not shown now: a deleted header once the pass has marked it (with a
      // datestamp of its own); until then, or for a record the site never
      // showed, unknown (as the lists skip it).
      if (stored?.deleted !== true) return fail("idDoesNotExist");
      if (metadataPrefix !== OAI_DC_PREFIX) return fail("cannotDisseminateFormat");
      return [
        "<GetRecord>",
        "<record>",
        header(host, id, stored.stamp, true),
        "</record>",
        "</GetRecord>",
      ].join("\n");
    }
    if (metadataPrefix !== OAI_DC_PREFIX) return fail("cannotDisseminateFormat");
    // Before the site's first background pass there is no stored datestamp:
    // the site's lower bound stands in, never a time computed from record
    // versions, which would tell a harvester when staff saved (S-046).
    let stamp = stored?.stamp;
    if (stamp === undefined) {
      const repository = await oaiRepository(
        options.db,
        site.organizationId,
        site.siteId,
        staffRead,
      );
      stamp = repository?.earliest;
    }
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
      cursor = tokens.open(token, `${site.organizationId}:${site.siteId}`);
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
    let outOfTime = false;
    // On the routes' clock (S-043a), as the brake and responseDate are.
    const deadline = clock() + pageTimeLimitMs;
    // In real time, as the server's reply time is (S-043b).
    const requestEnd = Date.now() + OAI_REQUEST_BUDGET_MS;
    while (shown.length < OAI_PAGE_SIZE && scanned < OAI_MAX_SCAN && !exhausted && !outOfTime) {
      const want = Math.min(OAI_PAGE_SIZE - shown.length + 5, OAI_MAX_SCAN - scanned);
      // The page's time bounds each list read too (S-051): checked before the
      // call, and the call gets only what is left (the first, the full limit).
      const left = deadline - clock();
      // (A break leaves `exhausted` false, so the page ends with a token.)
      if (scanned > 0 && left < 1) break;
      let candidates: OaiCandidate[];
      try {
        candidates = await listPublishedForOai(options.db, site.organizationId, site.siteId, {
          ...cursor.window,
          ...(after === undefined ? {} : { after }),
          limit: want,
          timeLimitMs: Math.max(
            1,
            Math.min(
              scanned === 0 ? LIST_READ_LIMIT_MS : Math.min(LIST_READ_LIMIT_MS, left),
              // At least a slow record's whole budget is kept for the reads after it.
              Math.floor(requestEnd - Date.now() - slowBudgetMs),
            ),
          ),
        });
      } catch (thrown) {
        // Past the page's first, a list read that runs out of time ends the
        // page here; the token resumes after the last record shown.
        if (scanned === 0 || !isDatabaseTimeout(thrown)) throw thrown;
        break;
      }
      if (candidates.length < want) exhausted = true;
      for (const candidate of candidates) {
        if (shown.length >= OAI_PAGE_SIZE) {
          exhausted = false;
          break;
        }
        if (scanned > 0 && clock() >= deadline) {
          // Out of time (S-037): this candidate and the rest come on the next page.
          exhausted = false;
          outOfTime = true;
          break;
        }
        if (candidate.deleted === true) {
          // Stopped being shown (S-041): a deleted header, in both lists
          // (OAI-PMH §2.5.1); nothing to read.
          scanned += 1;
          after = candidate;
          const gone = header(host, candidate.id, candidate.stamp, true);
          shown.push(verb === "ListIdentifiers" ? gone : `<record>\n${gone}\n</record>`);
          continue;
        }
        const key = slowKey(site, candidate.id);
        const wasSlow = slowReads.isSlow(key);
        // What is left of the request: a read gets at most that (S-043b).
        const capMs = requestEnd - Date.now();
        if (scanned > 0 && (capMs < 1 || (wasSlow && capMs < slowBudgetMs))) {
          exhausted = false;
          outOfTime = true;
          break;
        }
        if (scanned > 0 && wasSlow && deadline - clock() < slowBudgetMs) {
          // Known to be slow (S-043b): read only with its whole larger limit
          // left, so the page's first read next time if not.
          exhausted = false;
          outOfTime = true;
          break;
        }
        let output: Awaited<ReturnType<typeof publicRecord>>;
        try {
          output = await publicRecord(site, candidate.id, capMs);
        } catch (thrown) {
          if (!isDatabaseTimeout(thrown)) throw thrown;
          // A strike only for the record's own slowness: a statement or gap
          // past the larger limit, never the pool's wait for a connection.
          if (
            wasSlow &&
            capMs >= slowBudgetMs &&
            ownTimeout(thrown) &&
            slowReads.strike(key) >= OAI_SKIP_AFTER_STRIKES
          ) {
            // Too slow even at the larger limit, again (S-043b): left out,
            // as a held-back record is, and logged for staff; the token
            // moves past it so the harvest goes on.
            log({
              event: "oai_record_skipped",
              operation: "oaiPmh",
              name: "slow_record",
              code: candidate.id,
            });
            scanned += 1;
            after = candidate;
            continue;
          }
          // A read past the page's first that ran out of time (S-037): the
          // page ends before this candidate, which is read first next time,
          // so one slow read is retried instead of failing the page. The
          // page's first read timing out is the request's 503 busy.
          if (scanned === 0) throw thrown;
          exhausted = false;
          outOfTime = true;
          break;
        }
        // Only now: `after` (the token's place) moves past this candidate.
        scanned += 1;
        after = candidate;
        // Shown when the pass last ran, not now: skipped until the next pass
        // marks it deleted with a datestamp of its own. A deleted header here,
        // at the old datestamp, would make a harvester drop a record that
        // comes back before that pass for good (review of S-047). Only records
        // the site has shown have rows (S-041), so a run of skipped ones tells
        // nothing about records that were never public.
        if (output === undefined) continue;
        shown.push(
          verb === "ListIdentifiers"
            ? header(host, candidate.id, candidate.stamp)
            : `<record>\n${header(host, candidate.id, candidate.stamp)}\n${metadata(output.oaiDcXml)}\n</record>`,
        );
      }
    }
    // A fresh list with nothing to show is noRecordsMatch; a resumed one
    // whose rest is all held back just ends (§3.5), with the empty token below.
    if (shown.length === 0 && exhausted && token === undefined) return fail("noRecordsMatch");
    let resumption = "";
    if (!exhausted && after !== undefined) {
      resumption = element(
        "resumptionToken",
        tokens.seal({ window: cursor.window, after }, `${site.organizationId}:${site.siteId}`),
      );
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
          if (
            id === undefined ||
            ((await publicRecord(site, id)) === undefined &&
              (await tombstone(site, id)) === undefined)
          ) {
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
        // Worked out before any slot is taken, so nothing between taking and
        // the `finally` below can throw.
        const host = new URL(origin).hostname;
        const baseUrl = `${origin}/oai`;
        const responseDate = `${new Date(clock()).toISOString().slice(0, 19)}Z`;
        if (!limiter.take(clientKey(request.ip), "oai")) {
          reply.status(429).header("retry-after", "60");
          return { error: "rate_limited" };
        }
        // A busy refusal has already spent this request's rate token, as a
        // harvester retrying after Retry-After should.
        if (!oaiSlots.take()) {
          reply.status(503).header("retry-after", "5");
          return { error: "busy" };
        }
        if (!slots.take()) {
          oaiSlots.give();
          reply.status(503).header("retry-after", "5");
          return { error: "busy" };
        }
        let echoed: Record<string, string> | undefined;
        let body: string;
        try {
          const { verb, args } = argumentsOf(request.query);
          echoed = { verb, ...args };
          body = await answer(site, host, verb, args, baseUrl);
        } catch (thrown) {
          if (isDatabaseTimeout(thrown)) {
            // A time limit ran out (S-037): busy, as when no slot is free.
            log({ event: "service_error", operation: "oaiPmh", name: "timeout" });
            reply.status(503).header("retry-after", "5");
            return { error: "busy" };
          }
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
          oaiSlots.give();
        }
        return oaiPmhReply(documentOf(responseDate, baseUrl, echoed, body));
      },
    },
  ];
}
