/**
 * The only way a session waiting for its second step becomes a full session
 * (T-037, T-038, D-052, D-068, D-069, D-077), and the only code that writes
 * a passed second step to the database.
 *
 * `signIn` only says the password was right (`secondStep: "required"`), and
 * `beginSession` turns that into a session in the `second_step` stage, which
 * grants nothing but completing the second step. `promoteSession`
 * (sessions.ts) makes it full, and it needs a `SecondStepProof`: a value
 * made here by `passedSecondStep`, for one session and one user, used once,
 * within a minute. A copy, a look-alike object or a proof for another
 * session is refused.
 *
 * A proof carries the **pass**: what the database needs to record the
 * second step (0014): the next link of the factor's TOTP ratchet, or a
 * recovery code. `promoteSession` writes it with `writeSecondStepPass`
 * inside its own transaction, just before the session's UPDATE, and the
 * database refuses the promotion without a pass for that session and user
 * made in that transaction. So the in-process proof is the first lock and
 * the database the second: neither direct SQL with the writer role's
 * password nor a forged proof can make a session full.
 *
 * **Only the verifier (second-factor.ts) may call `passedSecondStep`**,
 * after it has checked a TOTP code or recovery code for that session's own
 * user. Neither function is exported from `@oculus/db`'s index, and a test
 * in `sessions.test.ts` fails if any source file (packages, scripts, tools)
 * other than sessions.ts, second-factor.ts, this file and their tests
 * mentions this module, `passedSecondStep` or `promoteSession`. That test
 * is a speed bump that catches accidents; code review is the real control
 * (D-069).
 */
import type { SessionId, UserId } from "@oculus/core";
import type { Queryable } from "./client.js";
import { sql } from "./sql.js";
import { randomUUID } from "node:crypto";

/** What the database needs to record a passed second step (0014). Never stored as such. */
export type PassMaterial =
  | {
      readonly method: "totp";
      readonly factorId: string;
      /** The TOTP step the code matched. */
      readonly step: bigint;
      /** The ratchet's next link, r_g; must hash to the stored anchor. */
      readonly reveal: Uint8Array;
      /** sha256(r_{g+1}), the new anchor. */
      readonly nextAnchor: Uint8Array;
    }
  | {
      readonly method: "recovery";
      readonly factorId: string;
      /** The recovery code in canonical form (core's `normalizeRecoveryCode`). */
      readonly code: string;
    };

/** Why a pass is written. */
export type PassPurpose = "sign_in" | "reauth" | "recovery_codes" | "admin_reset";

/** A second step that passed, for one session. Opaque: only this module can make one. */
export interface SecondStepProof {
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** How long a proof may wait before `promoteSession` uses it. */
export const SECOND_STEP_PROOF_MS = 60_000;

interface ProofRecord {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly madeAt: number;
  readonly pass: PassMaterial;
  /** Run in the promotion's transaction after the pass is written (set-up's recovery codes). */
  readonly afterPass: ((tx: Queryable) => Promise<void>) | undefined;
}

const proofs = new WeakMap<object, ProofRecord>();

/**
 * Records that `userId` passed the second step for `sessionId`, with the
 * pass the database will check. **The verifier only** (second-factor.ts),
 * after checking the code against the session's own user; see the module
 * comment.
 */
export function passedSecondStep(
  sessionId: SessionId,
  userId: UserId,
  pass: PassMaterial,
  afterPass?: (tx: Queryable) => Promise<void>,
): SecondStepProof {
  const proof: SecondStepProof = Object.freeze({ sessionId, userId });
  proofs.set(proof, { sessionId, userId, madeAt: performance.now(), pass, afterPass });
  return proof;
}

/**
 * The record behind a proof made here, still fresh, or `undefined`. A proof
 * past its minute is forgotten.
 */
export function readSecondStepProof(proof: unknown): ProofRecord | undefined {
  if (typeof proof !== "object" || proof === null) return undefined;
  const record = proofs.get(proof);
  if (record === undefined) return undefined;
  if (performance.now() - record.madeAt > SECOND_STEP_PROOF_MS) {
    proofs.delete(proof);
    return undefined;
  }
  return record;
}

/** Uses a proof up: it can't promote anything again. */
export function spendSecondStepProof(proof: SecondStepProof): void {
  proofs.delete(proof);
}

/**
 * Writes a passed second step inside `tx` and returns its ID: the database
 * checks the pass (0014's `second_step_passes_check_new`: the ratchet link
 * or the recovery code, the session, the account) and moves the ratchet or
 * uses the code up. It counts only in this transaction. A refusal throws
 * (constraint `second_step_passes_*`, `second_factors_*` or
 * `second_step_recovery_codes_*`); the caller rolls back.
 */
export async function writeSecondStepPass(
  tx: Queryable,
  who: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly purpose: PassPurpose;
    readonly targetUserId?: UserId;
  },
  pass: PassMaterial,
): Promise<string> {
  const id = randomUUID();
  const totp = pass.method === "totp" ? pass : undefined;
  const recovery = pass.method === "recovery" ? pass : undefined;
  await tx.execute(sql`
    INSERT INTO public.second_step_passes
      (id, user_id, factor_id, session_id, purpose, method, target_user_id, step,
       created_at, created_xact, reveal, next_anchor, recovery_code)
    VALUES (${id}::uuid, ${who.userId}::uuid, ${pass.factorId}::uuid, ${who.sessionId}::uuid,
            ${who.purpose}, ${pass.method}, ${who.targetUserId ?? null}::uuid,
            ${totp === undefined ? null : totp.step.toString()}::bigint,
            clock_timestamp(), pg_current_xact_id(),
            ${totp?.reveal ?? null}::bytea, ${totp?.nextAnchor ?? null}::bytea,
            ${recovery?.code ?? null})`);
  return id;
}

/** True for a refusal by 0014's second-step guards (a code used meanwhile, a race lost). */
export function secondStepGuardRefused(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return (
    (code === "23000" || code === "23514") &&
    typeof constraint === "string" &&
    /^(second_step_passes_|second_factors_|second_step_recovery_codes_|sessions_second_step_pass|sessions_reauth_pass)/.test(
      constraint,
    )
  );
}
