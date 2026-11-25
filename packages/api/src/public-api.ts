/**
 * Public record reads (T-050d, D-100, D-034, D-080, D-096): a public host's
 * published records, as their public output only.
 *
 * `GET /records/:id` on a host `OCULUS_PUBLIC_SITES` maps to a site
 * (public-sites.ts) answers with the record's `id` (its public URL),
 * `dublinCore` and `jsonLd`, and nothing else of `publicOutput`'s result:
 * never `staffWarnings` (S-011c). It reads through the public reader pool
 * only (`readPublicRecord`, D-080), with the template's stored Dublin Core
 * mapping (D-096), so it can reach no table and no unpublished record.
 *
 * An item another site (possibly another organization's) shared into the
 * host's site and the site's manager accepted (D-074, D-094) answers too,
 * as its home site shows it (`readSharedPublicRecord`, T-041f, D-111), with
 * `sharedFrom` naming its home site and organization. Its `id` and links
 * are its home site's URLs when that site is one of `OCULUS_PUBLIC_SITES`,
 * so a record has one identity; otherwise this host's. It ends when the
 * share ends or the item leaves publication, and then answers as any
 * unknown record does.
 *
 * Every refusal a public visitor could tell apart is one reply: a host that
 * isn't a public site (the admin's included), a malformed ID, a record that
 * doesn't exist, isn't published, is another site's or organization's, has
 * no mapping, or whose output core refuses all answer `404 not_found`,
 * exactly as an unknown path does. A database fault is `503 unavailable`.
 * Nothing about the record or the request is logged but a fixed code.
 *
 * Each client address may read `DEFAULT_RATE_LIMITS.public` records a
 * minute (rate-limit.ts; IPv6 addresses counted by their /64, which one
 * client usually holds whole), the T-042 note's brake on a public read that
 * can touch up to 10,000 records. And at most `maxConcurrent` reads run at
 * once (the public pool's size): past that a read is refused at once with
 * `503 busy`, so requests never queue for a connection behind slow reads.
 * Each read also has time limits of its own (S-037): its statements run
 * under `readPublicRecord`'s `statement_timeout`, and the pool waits at most
 * `PUBLIC_POOL_WAIT_MS` for a connection (`publicPoolOptions`); either
 * running out is `503 busy` too. A record whose read ran out of time is
 * remembered (`SlowReads`, S-043b) and read with the larger
 * `SLOW_READ_TIME_LIMIT_MS` from then on, so a record that is merely slow
 * is answered on the next try instead of being `busy` for good.
 */
import { isRecordId } from "@oculus/core";
import {
  isDatabaseTimeout,
  MAX_PUBLIC_READ_BUDGET_MS,
  MAX_PUBLIC_READ_TIME_LIMIT_MS,
  PUBLIC_READ_TIME_LIMIT_MS,
  TimeLimitError,
  readPublicRecord,
  readSharedPublicRecord,
  type Database,
  type SharedHome,
} from "@oculus/db";
import { Refusal } from "./errors.js";
import type { PublicSite } from "./public-sites.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";
import type { OculusRequest, OculusRoute } from "./routes.js";
import type { ApiLogRecord } from "./staff-api.js";

/** The public reader pool's connections, and so the public routes' read slots. */
export const PUBLIC_POOL_SIZE = 4;

/** How long the public reader pool waits for a connection, in milliseconds (S-037). */
export const PUBLIC_POOL_WAIT_MS = 5_000;

/**
 * The client-side limit on any one query of the public routes' pools
 * (S-051): above every statement limit they use (at most 60 s), so it only
 * fires when the server or network has stopped answering.
 */
export const PUBLIC_QUERY_TIMEOUT_MS = 90_000;

/**
 * The options every process opens the public reader pool with (S-037):
 * `max` connections, at most `PUBLIC_POOL_WAIT_MS` waiting for one. A
 * route's `maxConcurrent` (or its `ReadSlots`) must not exceed `max`.
 */

export function publicPoolOptions(max = PUBLIC_POOL_SIZE): {
  applicationName: string;
  max: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
} {
  return {
    applicationName: "oculus-public",
    max,
    connectionTimeoutMillis: PUBLIC_POOL_WAIT_MS,
    queryTimeoutMillis: PUBLIC_QUERY_TIMEOUT_MS,
  };
}

export interface PublicApiOptions {
  /** The public reader's pool (D-080), checked at startup (public-sites.ts). */
  readonly db: Database;
  /** The public hosts and their sites, resolved at startup (`checkPublicSites`). */
  readonly sites: readonly PublicSite[];
  readonly log?: (record: ApiLogRecord) => void;
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  readonly clock?: () => number;
  /** Reads allowed at once, at most the public pool's size (default 4, as `admin-cli.ts` opens it). */
  readonly maxConcurrent?: number;
  /** Slots shared with the OAI-PMH routes (T-050c), in place of `maxConcurrent`. */
  readonly slots?: ReadSlots;
  /** Each read's statement time limit (S-037); `readPublicRecord`'s default when left out. */
  readonly timeLimitMs?: number;
  /** Records known to be slow (S-043b), shared with the OAI-PMH routes; one of its own when left out. */
  readonly slowReads?: SlowReads;
}

/** The time limit a record known to be slow is read with (S-043b), per statement and gap. */
export const SLOW_READ_TIME_LIMIT_MS = 10_000;
/**
 * The whole time a known-slow record's read may take (S-043b): with the
 * staff connection's reads around it, it stays inside the server's 30 s
 * reply time (`SERVER_TIMEOUTS.handler`), so a slow read ends as `busy`, never cut off.
 */
export const SLOW_READ_BUDGET_MS = 18_000;
/** The whole time any other public request's reads may take (S-043b). */
export const PUBLIC_READ_BUDGET_MS = 15_000;
/** How long a record stays known as slow after its last read that ran out of time. */
export const SLOW_READ_MEMORY_MS = 24 * 60 * 60 * 1000;
/** The most records remembered as slow; the longest unseen is forgotten first. */
export const SLOW_READ_MAX_RECORDS = 1_000;
/** Strikes against a record count at most this often (S-043b), so one slow spell is one strike. */
export const SLOW_READ_STRIKE_GAP_MS = 5 * 60_000;

/**
 * The records whose public reads ran out of time (S-043b), in this
 * process's memory. A record whose read timed out is read with the larger
 * `limitMs` (and `budgetMs`) from then on: a larger limit for single
 * reads, the record's own. `strike` counts the OAI-PMH lists' reads at
 * that larger limit that ran out of time, at most one per
 * `SLOW_READ_STRIKE_GAP_MS`, so the lists step past a record that is
 * always too slow and not one caught in a short slow spell; a read at the
 * larger limit that answers clears them. Forgotten `SLOW_READ_MEMORY_MS`
 * after its last timeout, or on restart; only a record's site and ID are
 * kept, never anything a visitor sent.
 */
export class SlowReads {
  readonly limitMs: number;
  readonly budgetMs: number;
  private readonly clock: () => number;
  private readonly marks = new Map<string, { strikes: number; at: number; struckAt?: number }>();
  constructor(options: { limitMs?: number; budgetMs?: number; clock?: () => number } = {}) {
    this.limitMs = options.limitMs ?? SLOW_READ_TIME_LIMIT_MS;
    checkTimeLimit(this.limitMs);
    this.budgetMs = options.budgetMs ?? Math.max(SLOW_READ_BUDGET_MS, this.limitMs);
    if (
      !Number.isInteger(this.budgetMs) ||
      this.budgetMs < this.limitMs ||
      this.budgetMs > MAX_PUBLIC_READ_BUDGET_MS
    ) {
      throw new RangeError("budgetMs must be a whole number from limitMs to 120000");
    }
    this.clock = options.clock ?? Date.now;
  }
  private mark(key: string): { strikes: number; at: number; struckAt?: number } | undefined {
    const found = this.marks.get(key);
    if (found !== undefined && this.clock() - found.at > SLOW_READ_MEMORY_MS) {
      this.marks.delete(key);
      return undefined;
    }
    return found;
  }
  /** Whether the record's read ran out of time (and isn't forgotten yet). */
  isSlow(key: string): boolean {
    return this.mark(key) !== undefined;
  }
  /** The strikes against it so far (0 when none, or not known slow). */
  strikes(key: string): number {
    return this.mark(key)?.strikes ?? 0;
  }
  /** A read of the record ran out of time: known slow from now on. */
  timedOut(key: string): void {
    const found = this.mark(key) ?? { strikes: 0, at: 0 };
    found.at = this.clock();
    // Re-inserted, so the Map's order is least recently timed out first.
    this.marks.delete(key);
    this.marks.set(key, found);
    while (this.marks.size > SLOW_READ_MAX_RECORDS) {
      const oldest = this.marks.keys().next().value;
      if (oldest === undefined) break;
      this.marks.delete(oldest);
    }
  }
  /**
   * A list's read at the larger limit ran out of time (after `timedOut`):
   * a strike, unless the last came less than `SLOW_READ_STRIKE_GAP_MS` ago.
   * Gives the strikes.
   */
  strike(key: string): number {
    const found = this.mark(key);
    if (found === undefined) return 0;
    const now = this.clock();
    if (found.struckAt === undefined || now - found.struckAt >= SLOW_READ_STRIKE_GAP_MS) {
      found.strikes += 1;
      found.struckAt = now;
    }
    return found.strikes;
  }
  /** A read at the larger limit came back in time: still slow, no strikes. */
  answered(key: string): void {
    const found = this.mark(key);
    if (found === undefined) return;
    found.strikes = 0;
    delete found.struckAt;
  }
}

/** The key `SlowReads` remembers a site's record under. */
export function slowKey(site: PublicSite, id: string): string {
  return `${site.organizationId}:${site.siteId}:${id}`;
}

/**
 * The public pool's connections, counted: a read takes a slot or is refused
 * at once, so requests never queue for a connection behind slow reads. The
 * record reads and OAI-PMH (T-050c, D-105) share one, as they share the pool.
 */
export class ReadSlots {
  private running = 0;
  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw new RangeError("maxConcurrent must be a whole number from 1 to 100");
    }
  }
  /** Takes a slot, or false when every slot is in use. */
  take(): boolean {
    if (this.running >= this.size) return false;
    this.running += 1;
    return true;
  }
  give(): void {
    if (this.running > 0) this.running -= 1;
  }
}

/**
 * A read's `timeLimitMs` and `budgetMs` (S-043b): the routes' own limit
 * (or `readPublicRecord`'s default) with at most `PUBLIC_READ_BUDGET_MS` in
 * all, or for a record known to be slow `slowReads`'s larger limit (never
 * below the routes' own) and its budget.
 */
export function readLimit(
  timeLimitMs: number | undefined,
  slowReads: SlowReads | undefined,
): { timeLimitMs: number; budgetMs: number } {
  const own = timeLimitMs ?? PUBLIC_READ_TIME_LIMIT_MS;
  if (slowReads === undefined) {
    return { timeLimitMs: own, budgetMs: Math.min(3 * own, PUBLIC_READ_BUDGET_MS) };
  }
  const limit = Math.max(slowReads.limitMs, own);
  return {
    timeLimitMs: limit,
    budgetMs: Math.max(slowReads.budgetMs, Math.min(limit, PUBLIC_READ_BUDGET_MS)),
  };
}

/** What is left of `budgetMs` since `started`; none left is a time limit (S-043b). */
function leftOf(budgetMs: number, started: number): number {
  const left = budgetMs - (Date.now() - started);
  if (left < 1) throw new TimeLimitError();
  return Math.floor(left);
}

/** Refuses at build time a time limit `readPublicRecord` would refuse on every read. */
export function checkTimeLimit(timeLimitMs: number | undefined): void {
  if (timeLimitMs === undefined) return;
  if (
    !Number.isInteger(timeLimitMs) ||
    timeLimitMs < 1 ||
    timeLimitMs > MAX_PUBLIC_READ_TIME_LIMIT_MS
  ) {
    throw new RangeError(
      `timeLimitMs must be a whole number from 1 to ${String(MAX_PUBLIC_READ_TIME_LIMIT_MS)}`,
    );
  }
}

/** The key a client is braked by: an IPv4 address, or an IPv6 address's /64. */
export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  // Expand "::" so the first four groups are the /64.
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]?.split("::") ?? [];
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** The request's origin as `URL.origin` writes it, or undefined. */
export function originOf(request: OculusRequest): string | undefined {
  try {
    const url = new URL(`${request.protocol}://${request.host}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

const NOT_FOUND = (): Refusal => new Refusal(404, "not_found");

/** The public read routes, for `buildServer({ routes })` beside the admin's. */
export function publicApiRoutes(options: PublicApiOptions): OculusRoute[] {
  const byOrigin = new Map(options.sites.map((site) => [site.origin, site]));
  const limiter = new SessionRateLimiter(
    { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    options.clock,
  );
  const log = options.log ?? (() => undefined);
  const slots = options.slots ?? new ReadSlots(options.maxConcurrent ?? PUBLIC_POOL_SIZE);
  checkTimeLimit(options.timeLimitMs);
  const slowReads =
    options.slowReads ?? new SlowReads(options.clock === undefined ? {} : { clock: options.clock });
  /** A shared item's home site's public origin, when it is one of this server's public sites. */
  const homeOrigin = (home: SharedHome): string | undefined =>
    options.sites.find((s) => s.siteId === home.siteId && s.organizationId === home.organizationId)
      ?.origin;

  return [
    {
      method: "GET",
      path: "/records/:id",
      handler: async (request) => {
        const origin = originOf(request);
        const site = origin === undefined ? undefined : byOrigin.get(origin);
        // Not a public host (the admin's or an unlisted one): an unknown path.
        if (site === undefined) throw NOT_FOUND();
        if (!limiter.take(clientKey(request.ip), "public")) {
          throw new Refusal(429, "rate_limited");
        }
        const id = request.params.id ?? "";
        if (!isRecordId(id)) throw NOT_FOUND();
        if (!slots.take()) throw new Refusal(503, "busy");
        let result: Awaited<ReturnType<typeof readPublicRecord>>;
        let shared: Awaited<ReturnType<typeof readSharedPublicRecord>> | undefined;
        let operation = "readPublicRecord";
        // A record whose read ran out of time before gets the larger limit (S-043b).
        const key = slowKey(site, id);
        const slow = slowReads.isSlow(key);
        const limit = readLimit(options.timeLimitMs, slow ? slowReads : undefined);
        // Both reads below share one budget, so the request ends inside the server's reply time.
        const started = Date.now();
        try {
          result = await readPublicRecord(options.db, site.organizationId, site.siteId, id, {
            baseUrl: `${site.origin}/records/`,
            ...limit,
          });
          if (!result.ok) {
            // Not the site's own: maybe an item shared into it (T-041f).
            operation = "readSharedPublicRecord";
            shared = await readSharedPublicRecord(
              options.db,
              site.organizationId,
              site.siteId,
              id,
              {
                baseUrlFor: (home) => `${homeOrigin(home) ?? site.origin}/records/`,
                timeLimitMs: limit.timeLimitMs,
                budgetMs: leftOf(limit.budgetMs, started),
              },
            );
          }
          if (slow) slowReads.answered(key);
        } catch (error) {
          if (isDatabaseTimeout(error)) {
            // A time limit ran out (S-037): busy, as when every slot is taken,
            // and the record is read with the larger limit next time (S-043b).
            slowReads.timedOut(key);
            log({ event: "service_error", operation, name: "timeout" });
            throw new Refusal(503, "busy");
          }
          // The class name only (a database fault and a bug look different), never the message.
          log({
            event: "service_error",
            operation,
            name: error instanceof Error ? error.constructor.name.slice(0, 40) : "unknown",
          });
          throw new Refusal(503, "unavailable");
        } finally {
          slots.give();
        }
        if (result.ok) {
          const out = result.value;
          return { id: out.id, dublinCore: out.dublinCore, jsonLd: out.jsonLd };
        }
        if (shared?.ok === true) {
          const out = shared.value.output;
          const home = shared.value.home;
          return {
            id: out.id,
            dublinCore: out.dublinCore,
            jsonLd: out.jsonLd,
            sharedFrom: { site: home.siteName, organization: home.organizationName },
          };
        }
        // Staff-only reasons (D-016, S-007) never leave; the public sees "not found".
        throw NOT_FOUND();
      },
    },
  ];
}
