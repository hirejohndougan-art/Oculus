/**
 * Cached public Subjects counts (S-038, D-106, on T-034d's D-095).
 *
 * `publicTermCounts` reads every record public on a site, so no public
 * request ever runs it. `PublicSubjects` works the counts out in the
 * background, one site at a time, on a connection pool of its own (the
 * server's staff role, as D-095 requires, but a separate small pool, so
 * staff saves never wait behind it), and keeps the last good result for
 * each public site. `GET /subjects` on a public host answers from that
 * result alone and never touches the database.
 *
 * Refreshing: every `checkEveryMs` (default a minute) the cache reads a
 * cheap marker of what public output depends on (`publicOutputMarker`: the
 * organization's record versions, mappings, templates and identifier
 * types). When it changed since the last count, or the last count is older
 * than `maxAgeMs` (default an hour), the site is counted again. Publishing,
 * withdrawing and editing a published record each write a record version,
 * so each moves the marker. Until the new count is done, and whenever a count
 * is refused (too many records, too slow) or fails, the last good result is
 * still served.
 *
 * Staff see, through `/api/sites/:id/public-subjects` (staff-api.ts), when
 * the counts were made and how many of the site's public records were left
 * out of them and why, by refusal code. That never reaches a public host.
 */
import {
  publicOutputMarker,
  publicTermCountsForStaff,
  type Database,
  type PublicTermCount,
} from "@oculus/db";
import { Refusal } from "./errors.js";
import { clientKey, originOf } from "./public-api.js";
import type { PublicSite } from "./public-sites.js";
import { DEFAULT_RATE_LIMITS, SessionRateLimiter, type RateBucket } from "./rate-limit.js";
import type { OculusRoute } from "./routes.js";
import type { ApiLogRecord } from "./staff-api.js";

/** The Dublin Core term a Subjects page counts. */
export const SUBJECT_TERMS: readonly string[] = Object.freeze(["subject"]);

export interface PublicSubjectsOptions {
  /** A pool of its own on the staff role (one connection is enough), never the public reader. */
  readonly db: Database;
  readonly sites: readonly PublicSite[];
  readonly log?: (record: ApiLogRecord) => void;
  readonly clock?: () => number;
  /** How often to look for changes (default 60 000 ms). */
  readonly checkEveryMs?: number;
  /** Count again after this long even without a change (default 3 600 000 ms). */
  readonly maxAgeMs?: number;
  /** Each count's time limit (default 120 000 ms; `publicTermCounts`' ceiling is 300 000). */
  readonly timeLimitMs?: number;
}

/** What a public site shows. */
export interface PublicSubjectsResult {
  readonly counts: readonly PublicTermCount[];
  readonly recordsCounted: number;
  /** When the counts were made (ISO, to the second). */
  readonly asOf: string;
}

/** What staff see of a public site's counts. */
export interface PublicSubjectsStatus {
  /** When the counts being served were made, or null before the first. */
  readonly asOf: string | null;
  readonly recordsCounted: number | null;
  /** Records public on the site that were left out, in all and by refusal code. */
  readonly recordsLeftOut: number | null;
  readonly leftOut: Readonly<Record<string, number>>;
  /** The last count that didn't finish, if it came after the counts served. */
  readonly lastProblem: { readonly code: string; readonly at: string } | null;
  readonly counting: boolean;
}

interface SiteState {
  readonly site: PublicSite;
  good?: PublicSubjectsResult & {
    readonly at: number;
    readonly leftOut: Readonly<Record<string, number>>;
    readonly recordsLeftOut: number;
  };
  marker?: string;
  problem?: { code: string; at: number } | undefined;
  counting: boolean;
}

const second = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export class PublicSubjects {
  private readonly states: ReadonlyMap<string, SiteState>;
  private readonly byOrigin: ReadonlyMap<string, SiteState>;
  private readonly log: (record: ApiLogRecord) => void;
  private readonly clock: () => number;
  private readonly checkEveryMs: number;
  private readonly maxAgeMs: number;
  private readonly timeLimitMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: PublicSubjectsOptions) {
    const states = new Map<string, SiteState>();
    const byOrigin = new Map<string, SiteState>();
    for (const site of options.sites) {
      const state = states.get(site.siteId) ?? { site, counting: false };
      states.set(site.siteId, state);
      byOrigin.set(site.origin, state);
    }
    this.states = states;
    this.byOrigin = byOrigin;
    this.log = options.log ?? (() => undefined);
    this.clock = options.clock ?? Date.now;
    this.checkEveryMs = whole(options.checkEveryMs ?? 60_000, 1000, 86_400_000, "checkEveryMs");
    this.maxAgeMs = whole(options.maxAgeMs ?? 3_600_000, 1000, 604_800_000, "maxAgeMs");
    this.timeLimitMs = whole(options.timeLimitMs ?? 120_000, 1, 300_000, "timeLimitMs");
  }

  /** Starts the background checks (the first at once). */
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    const loop = (): void => {
      this.running = this.check().finally(() => {
        this.running = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(loop, this.checkEveryMs);
          this.timer.unref();
        }
      });
    };
    this.timer = setTimeout(loop, 0);
    this.timer.unref();
  }

  /** Stops the checks and waits for a count in progress to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One pass over every public site: count the ones that changed or are old. */
  async check(): Promise<void> {
    for (const state of this.states.values()) {
      if (this.stopped) return;
      await this.checkSite(state);
    }
  }

  private async checkSite(state: SiteState): Promise<void> {
    if (state.counting) return;
    state.counting = true;
    const { organizationId, siteId, origin } = state.site;
    try {
      // Read before counting, so a change made during the count is seen next time.
      const marker = await publicOutputMarker(this.options.db, organizationId);
      // The last attempt, good or refused: a refused count (too many
      // records, too slow) isn't tried again every minute, only after a
      // change or once it is old.
      const last = Math.max(state.good?.at ?? -Infinity, state.problem?.at ?? -Infinity);
      const old = this.clock() - last >= this.maxAgeMs;
      if (!old && marker === state.marker) return;
      const result = await publicTermCountsForStaff(this.options.db, organizationId, siteId, {
        baseUrl: `${origin}/records/`,
        terms: SUBJECT_TERMS,
        timeLimitMs: this.timeLimitMs,
      });
      const now = this.clock();
      if (!result.ok) {
        state.problem = { code: result.issues[0]?.code ?? "refused", at: now };
        state.marker = marker;
        return;
      }
      state.good = Object.freeze({
        counts: result.value.counts.counts,
        recordsCounted: result.value.counts.recordsCounted,
        asOf: second(now),
        at: now,
        leftOut: result.value.leftOut,
        recordsLeftOut: result.value.recordsLeftOut,
      });
      state.problem = undefined;
      state.marker = marker;
    } catch (error) {
      // Keep the last good result; try again at the next check.
      state.problem = { code: "unavailable", at: this.clock() };
      this.log({
        event: "service_error",
        operation: "publicSubjects",
        name: error instanceof Error ? error.constructor.name.slice(0, 40) : "unknown",
      });
    } finally {
      state.counting = false;
    }
  }

  /** What a public host's Subjects page shows, or undefined before the first count. */
  forOrigin(origin: string): PublicSubjectsResult | null | undefined {
    const state = this.byOrigin.get(origin);
    if (state === undefined) return undefined;
    const good = state.good;
    if (good === undefined) return null;
    return { counts: good.counts, recordsCounted: good.recordsCounted, asOf: good.asOf };
  }

  /** What staff see of a site's counts; undefined unless it is one of the organization's public sites. */
  statusFor(organizationId: string, siteId: string): PublicSubjectsStatus | undefined {
    const state = this.states.get(siteId);
    if (state?.site.organizationId !== organizationId) return undefined;
    const good = state.good;
    const problem =
      state.problem !== undefined && (good === undefined || state.problem.at >= good.at)
        ? { code: state.problem.code, at: second(state.problem.at) }
        : null;
    return {
      asOf: good?.asOf ?? null,
      recordsCounted: good?.recordsCounted ?? null,
      recordsLeftOut: good?.recordsLeftOut ?? null,
      leftOut: good?.leftOut ?? {},
      lastProblem: problem,
      counting: state.counting,
    };
  }
}

function whole(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${String(min)} to ${String(max)}`);
  }
  return value;
}

/** `GET /subjects` on a public host: the cached counts only (no database). */
export function publicSubjectsRoutes(options: {
  readonly subjects: PublicSubjects;
  readonly rateLimits?: Partial<Record<RateBucket, number>>;
  readonly clock?: () => number;
}): OculusRoute[] {
  const limiter = new SessionRateLimiter(
    { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    options.clock,
  );
  return [
    {
      method: "GET",
      path: "/subjects",
      handler: (request, reply) => {
        const origin = originOf(request);
        const result = origin === undefined ? undefined : options.subjects.forOrigin(origin);
        if (result === undefined) throw new Refusal(404, "not_found");
        if (!limiter.take(clientKey(request.ip), "public")) {
          throw new Refusal(429, "rate_limited");
        }
        if (result === null) {
          reply.status(503).header("retry-after", "30");
          return { error: "not_ready" };
        }
        return {
          subjects: result.counts.map((c) => ({
            label: c.label,
            ...(c.uri === undefined ? {} : { uri: c.uri }),
            records: c.records,
          })),
          recordsCounted: result.recordsCounted,
          asOf: result.asOf,
        };
      },
    },
  ];
}
