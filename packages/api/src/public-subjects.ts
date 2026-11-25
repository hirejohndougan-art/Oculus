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
 * Refreshing: every `checkEveryMs` (default a minute) the cache reads, once
 * per organization, a marker of what public output depends on
 * (`publicOutputMarker`: record versions and identifiers, mappings,
 * templates, identifier types). When it moved since the counts served were
 * made, the site is counted again, at most once every `minGapMs` (default
 * five minutes, so busy cataloguing doesn't mean back-to-back recounts);
 * without a change, once the counts are `maxAgeMs` old (default an hour).
 * Meanwhile the last good result is served, but only for `staleMs` (default
 * 30 minutes) after a change it doesn't reflect, and never past a day: a
 * withdrawn record's subject mustn't stay up because recounts keep being
 * refused. A recount whose public result is unchanged keeps its `asOf`, so
 * the public can't watch staff work. `stop()` stops a count at its next
 * record.
 *
 * Staff see, through `/api/sites/:id/public-subjects` (staff-api.ts), when
 * the counts were made and how many of the site's public records were left
 * out of them and why, by refusal code. That never reaches a public host.
 */
import {
  publicOutputMarker,
  publicTermCountsForStaff,
  writeOaiStamps,
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
  /** At most one count per site this often, changes or not (default 300 000 ms). */
  readonly minGapMs?: number;
  /** Count again after this long even without a change (default 3 600 000 ms). */
  readonly maxAgeMs?: number;
  /**
   * Stop showing counts a change has made out of date after this long
   * without a good recount (default 1 800 000 ms); then `/subjects` is 503.
   */
  readonly staleMs?: number;
  /** Each count's time limit (default 120 000 ms; `publicTermCounts`' ceiling is 300 000). */
  readonly timeLimitMs?: number;
  /**
   * Also store each site's OAI-PMH datestamps from the same pass (S-041,
   * D-108): `buildAdminServer` turns this on when OAI-PMH is served.
   */
  readonly oaiStamps?: boolean;
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
  /** Since when the counts served have been the same (what the public sees), or null before the first. */
  readonly asOf: string | null;
  /** When they were last counted. */
  readonly lastCounted: string | null;
  readonly recordsCounted: number | null;
  /** Records public on the site that were left out, in all and by refusal code. */
  readonly recordsLeftOut: number | null;
  readonly leftOut: Readonly<Record<string, number>>;
  /** The last count that didn't finish, if it came after the counts served. */
  readonly lastProblem: { readonly code: string; readonly at: string } | null;
  readonly counting: boolean;
  /** Whether a public host shows the counts now (false: none yet, or too far out of date). */
  readonly shown: boolean;
}

interface Good extends PublicSubjectsResult {
  readonly at: number;
  /** The marker the counts were made at. */
  readonly marker: string;
  readonly leftOut: Readonly<Record<string, number>>;
  readonly recordsLeftOut: number;
}

interface SiteState {
  readonly site: PublicSite;
  good?: Good | undefined;
  /** The last count attempted, good or not. */
  lastAttempt?: number | undefined;
  /** When a change the counts served don't reflect was first seen. */
  changedSince?: number | undefined;
  problem?: { code: string; at: number } | undefined;
  /** The marker the last refused count was tried at: not tried again at it until maxAgeMs. */
  refusedAt?: string | undefined;
  counting: boolean;
}

const second = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export class PublicSubjects {
  private readonly states: ReadonlyMap<string, SiteState>;
  private readonly byOrigin: ReadonlyMap<string, SiteState>;
  private readonly log: (record: ApiLogRecord) => void;
  private readonly clock: () => number;
  private readonly checkEveryMs: number;
  private readonly minGapMs: number;
  private readonly maxAgeMs: number;
  private readonly staleMs: number;
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
    this.minGapMs = whole(options.minGapMs ?? 300_000, 0, 86_400_000, "minGapMs");
    this.maxAgeMs = whole(options.maxAgeMs ?? 3_600_000, 1000, 604_800_000, "maxAgeMs");
    this.staleMs = whole(options.staleMs ?? 1_800_000, 1000, 86_400_000, "staleMs");
    this.timeLimitMs = whole(options.timeLimitMs ?? 120_000, 1, 300_000, "timeLimitMs");
    if (this.staleMs < this.minGapMs + this.checkEveryMs) {
      throw new RangeError("staleMs must be at least minGapMs + checkEveryMs");
    }
  }

  /** Starts the background checks (the first at once). */
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    const loop = (): void => {
      this.running = this.check()
        .catch(() => undefined)
        .finally(() => {
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

  /**
   * Stops the checks: a count in progress stops at its next record, and no
   * check starts again. Resolves once nothing runs on the pool.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    await Promise.all([...this.inFlight]);
  }

  private readonly inFlight = new Set<Promise<void>>();

  /** One pass: the marker once per organization, then each site that needs a count. */
  async check(): Promise<void> {
    if (this.stopped) return;
    // One pass at a time: a second call waits for the one running.
    const running = [...this.inFlight][0];
    if (running !== undefined) return running;
    const pass = this.pass();
    this.inFlight.add(pass);
    try {
      await pass;
    } finally {
      this.inFlight.delete(pass);
    }
  }

  private async pass(): Promise<void> {
    const markers = new Map<string, string | Error>();
    for (const state of this.states.values()) {
      if (this.stopped) return;
      const org = state.site.organizationId;
      if (!markers.has(org)) {
        try {
          markers.set(org, await publicOutputMarker(this.options.db, org, MARKER_TIME_LIMIT_MS));
        } catch (error) {
          markers.set(org, error instanceof Error ? error : new Error("unknown"));
        }
      }
      const marker = markers.get(org);
      if (marker instanceof Error || marker === undefined) {
        this.failed(state, marker);
        continue;
      }
      await this.checkSite(state, marker);
    }
  }

  private failed(state: SiteState, error: Error | undefined): void {
    const now = this.clock();
    state.problem = { code: "unavailable", at: now };
    state.lastAttempt = now;
    // Whether anything changed is unknown now: treat it as changed, so the
    // counts aren't served stale forever.
    state.changedSince ??= now;
    this.log({
      event: "service_error",
      operation: "publicSubjects",
      name: error?.constructor.name.slice(0, 40) ?? "unknown",
    });
  }

  private async checkSite(state: SiteState, marker: string): Promise<void> {
    if (state.counting || this.stopped) return;
    const now = this.clock();
    const good = state.good;
    if (good?.marker === marker) {
      state.changedSince = undefined;
    } else {
      state.changedSince ??= now;
    }
    const since = now - (state.lastAttempt ?? -Infinity);
    const due =
      good === undefined
        ? // No counts yet: try at once, then every minGap (a refusal at the
          // same marker: every maxAgeMs).
          state.lastAttempt === undefined ||
          since >= (state.refusedAt === marker ? this.maxAgeMs : this.minGapMs)
        : state.changedSince !== undefined
          ? // A change: count again, at most once every minGap, but a count
            // refused at this same marker only once it is maxAgeMs old.
            since >= (state.refusedAt === marker ? this.maxAgeMs : this.minGapMs)
          : // No change: only once the counts are old.
            now - good.at >= this.maxAgeMs && since >= this.minGapMs;
    if (!due) return;
    state.counting = true;
    state.lastAttempt = now;
    const { organizationId, siteId, origin } = state.site;
    try {
      const result = await publicTermCountsForStaff(
        this.options.db,
        organizationId,
        siteId,
        { baseUrl: `${origin}/records/`, terms: SUBJECT_TERMS, timeLimitMs: this.timeLimitMs },
        { shouldStop: () => this.stopped },
      );
      const done = this.clock();
      if (!result.ok) {
        state.problem = { code: result.issues[0]?.code ?? "refused", at: done };
        if (result.issues[0]?.code !== "stopped") state.refusedAt = marker;
        return;
      }
      if (this.options.oaiStamps === true) {
        // From the same snapshot the counts came from: a record whose
        // oai_dc changed gets a new datestamp, one no longer shown is marked.
        await writeOaiStamps(this.options.db, organizationId, siteId, result.value.fingerprints);
      }
      const counts = result.value.counts;
      // The same public result keeps its asOf: a recount after staff work
      // that changed nothing public shows nothing (review of S-038).
      const same =
        good?.recordsCounted === counts.recordsCounted &&
        JSON.stringify(good.counts) === JSON.stringify(counts.counts);
      state.good = Object.freeze({
        counts: counts.counts,
        recordsCounted: counts.recordsCounted,
        asOf: same ? good.asOf : second(done),
        at: done,
        marker,
        leftOut: result.value.leftOut,
        recordsLeftOut: result.value.recordsLeftOut,
      });
      state.problem = undefined;
      state.refusedAt = undefined;
      state.changedSince = undefined;
    } catch (error) {
      this.failed(state, error instanceof Error ? error : undefined);
    } finally {
      state.counting = false;
    }
  }

  /**
   * What a public host's Subjects page shows; null when there are no counts
   * to show: none yet, or the ones made have been out of step with a change
   * for longer than `staleMs` (a withdrawn record's subject mustn't stay up
   * because recounts keep failing), or are a day old.
   */
  forOrigin(origin: string): PublicSubjectsResult | null | undefined {
    const state = this.byOrigin.get(origin);
    if (state === undefined) return undefined;
    const good = state.good;
    if (good === undefined) return null;
    const now = this.clock();
    if (state.changedSince !== undefined && now - state.changedSince > this.staleMs) return null;
    if (now - good.at > MAX_SERVED_MS) return null;
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
      lastCounted: good === undefined ? null : second(good.at),
      recordsCounted: good?.recordsCounted ?? null,
      recordsLeftOut: good?.recordsLeftOut ?? null,
      leftOut: good?.leftOut ?? {},
      lastProblem: problem,
      counting: state.counting,
      shown: this.forOrigin(state.site.origin) !== null,
    };
  }
}

/** The marker's own time limit (it is cheap; past this something holds it up). */
const MARKER_TIME_LIMIT_MS = 30_000;

/** Counts older than this are never shown, whatever happened since (a day). */
const MAX_SERVED_MS = 86_400_000;

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
