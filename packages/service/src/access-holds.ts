/**
 * The access-holds pass (T-034f, D-120): keeps records' stored state in step
 * with their accessions' deeds and access restrictions, on each
 * organization's own day (D-103).
 *
 * The public output already refuses a held record the moment it is held
 * (D-043, D-056), whatever its stored state, so nothing private waits for
 * this pass. What it adds is the change log and a state that says what the
 * public sees:
 *
 * - **Withdraw.** A published record the publish check now refuses because
 *   an accession holds it back (`deed_not_signed`, `access_restricted`) is
 *   withdrawn, as its next version, by `ACCESS_HOLDS_ACTOR` with a fixed
 *   reason that names no donor, accession, restriction or date.
 * - **Publish again.** A withdrawn record whose newest change of state is
 *   this pass's own withdrawal is published again, by the same actor, once
 *   the publish check passes on the organization's day: a `closed_until`
 *   date has passed, a deed was signed or the accession let it go. Still
 *   held: it stays withdrawn. Refused for any other reason (a number that no
 *   longer fits, a rights value): it stays withdrawn and is counted as
 *   `blocked`, for staff to look at. A record anyone withdrew, published,
 *   sent for review or returned to draft since is never touched: people's
 *   decisions win.
 *
 * Each record is changed in a transaction of its own, under its row lock
 * (as an edit takes it) and then the organization's holds lock (shared, as
 * the service's publish takes it, D-114), so the order of locks is the
 * service's own and an accession save and this pass never pass each other.
 * Deadlocks and serialization failures run the record again; anything else
 * is counted as `failed` and the pass goes on. A dry run does the same
 * checks and rolls every record back.
 *
 * Runs with the writer's connection (`npm run holds`, the desktop at start),
 * never the public reader's. Not a person's operation: no permission is
 * checked, and the change log names the pass.
 */
import { type OrganizationId, type RecordId } from "@oculus/core";
import {
  changeWorkflowState,
  lockRecordState,
  organizationIds,
  publishCheckIssues,
  publishedPerhapsHeld,
  withdrawnBy,
  MAX_HOLD_CANDIDATES,
  type Database,
  type Queryable,
} from "@oculus/db";

/** The change log's actor for the pass. */
export const ACCESS_HOLDS_ACTOR = "system:access-holds";

/** The reason written with a withdrawal (fixed text: nothing of the accession). */
export const HOLD_WITHDRAW_REASON =
  "Withdrawn automatically: an accession's deed or access restriction holds it back.";
/** The reason written when it is published again. */
export const HOLD_PUBLISH_REASON =
  "Published again automatically: the accession no longer holds it back.";

const HOLD_CODES: ReadonlySet<string> = new Set(["deed_not_signed", "access_restricted"]);
const RETRYABLE: ReadonlySet<string> = new Set(["40P01", "40001"]);

export interface AccessHoldsOptions {
  /** `false`: a dry run, which checks everything and changes nothing. */
  readonly apply: boolean;
  /** Only this organization (default: every one). */
  readonly organizationId?: OrganizationId;
  /** Tries per record on a deadlock or serialization failure (default 3). */
  readonly attempts?: number;
  /** Most candidates of each kind per organization (tests; 1 to `MAX_HOLD_CANDIDATES`). */
  readonly limit?: number;
  /** Told of an unexpected error (never thrown); the record counts as `failed`. */
  readonly onError?: (error: unknown) => void;
}

export interface AccessHoldsReport {
  readonly dryRun: boolean;
  /** Published records withdrawn because an accession now holds them back. */
  readonly withdrawn: number;
  /** Records this pass had withdrawn, published again. */
  readonly published: number;
  /** Records this pass had withdrawn that are still held back. */
  readonly stillHeld: number;
  /** Records this pass had withdrawn, no longer held, that the publish check refuses for another reason. */
  readonly blocked: number;
  /** Records that couldn't be checked or changed (an error; told to `onError`). */
  readonly failed: number;
  /** True when an organization had more candidates than one pass reads: run it again. */
  readonly more: boolean;
}

type Outcome = "withdrawn" | "published" | "still_held" | "blocked" | "skipped" | "failed";

class RollBack extends Error {
  constructor(readonly outcome: Outcome) {
    super("roll back");
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function withdrawIfHeld(
  tx: Queryable,
  org: OrganizationId,
  id: RecordId,
): Promise<{ outcome: Outcome; keep: boolean }> {
  const state = await lockRecordState(tx, org, id);
  if (state?.state !== "published") return { outcome: "skipped", keep: false };
  const issues = await publishCheckIssues(tx, org, id, { lock: true });
  if (!issues.some((i) => HOLD_CODES.has(i.code))) return { outcome: "skipped", keep: false };
  const changed = await changeWorkflowState(tx, org, id, "withdraw", {
    expectedVersion: state.version,
    actor: ACCESS_HOLDS_ACTOR,
    reason: HOLD_WITHDRAW_REASON,
  });
  return changed.ok ? { outcome: "withdrawn", keep: true } : { outcome: "failed", keep: false };
}

async function publishIfFree(
  tx: Queryable,
  org: OrganizationId,
  id: RecordId,
): Promise<{ outcome: Outcome; keep: boolean }> {
  const state = await lockRecordState(tx, org, id);
  if (state?.state !== "withdrawn" || state.lastMoveActor !== ACCESS_HOLDS_ACTOR) {
    return { outcome: "skipped", keep: false };
  }
  const changed = await changeWorkflowState(tx, org, id, "publish", {
    expectedVersion: state.version,
    actor: ACCESS_HOLDS_ACTOR,
    reason: HOLD_PUBLISH_REASON,
  });
  if (!changed.ok) return { outcome: "failed", keep: false };
  // On the record as it is now, published, as the service's publish checks
  // it; any issue rolls the change back.
  const issues = await publishCheckIssues(tx, org, id, { lock: true });
  if (issues.length === 0) return { outcome: "published", keep: true };
  return {
    outcome: issues.some((i) => HOLD_CODES.has(i.code)) ? "still_held" : "blocked",
    keep: false,
  };
}

/**
 * One pass over every organization (or one): withdraws published records an
 * accession now holds back and publishes again those it withdrew that are
 * free. Never throws for a record; a failure to list an organization's
 * candidates is thrown (nothing has been changed for it).
 */
export async function applyAccessHolds(
  db: Database,
  options: AccessHoldsOptions,
): Promise<AccessHoldsReport> {
  const apply = options.apply === true;
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  const limit = Math.max(
    1,
    Math.min(Math.trunc(options.limit ?? MAX_HOLD_CANDIDATES), MAX_HOLD_CANDIDATES),
  );
  const counts: Record<Outcome, number> = {
    withdrawn: 0,
    published: 0,
    still_held: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
  };
  let more = false;

  const one = async (
    org: OrganizationId,
    id: RecordId,
    step: typeof withdrawIfHeld,
  ): Promise<Outcome> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const done = await step(tx, org, id);
          if (!apply || !done.keep) throw new RollBack(done.outcome);
          return done.outcome;
        });
      } catch (error) {
        if (error instanceof RollBack) return error.outcome;
        const state = sqlState(error);
        if (state !== undefined && RETRYABLE.has(state) && attempt < attempts) continue;
        try {
          options.onError?.(error);
        } catch {
          // The log's own failure changes nothing.
        }
        return "failed";
      }
    }
  };

  const orgs =
    options.organizationId === undefined ? await organizationIds(db) : [options.organizationId];
  for (const org of orgs) {
    // Publish again first: a record withdrawn now isn't looked at again in
    // the same pass (it would only be still held).
    const free = await withdrawnBy(db, org, ACCESS_HOLDS_ACTOR, limit + 1);
    const held = await publishedPerhapsHeld(db, org, limit + 1);
    if (free.length > limit || held.length > limit) more = true;
    for (const id of free.slice(0, limit)) counts[await one(org, id, publishIfFree)] += 1;
    for (const id of held.slice(0, limit)) counts[await one(org, id, withdrawIfHeld)] += 1;
  }
  return Object.freeze({
    dryRun: !apply,
    withdrawn: counts.withdrawn,
    published: counts.published,
    stillHeld: counts.still_held,
    blocked: counts.blocked,
    failed: counts.failed,
    more,
  });
}
