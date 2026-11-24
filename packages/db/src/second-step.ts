/**
 * The only way a session waiting for its second step becomes a full session
 * (T-037, D-052, D-068, D-069).
 *
 * `signIn` only says the password was right (`secondStep: "required"`), and
 * `beginSession` turns that into a session in the `second_step` stage, which
 * grants nothing but completing the second step. `promoteSession`
 * (sessions.ts) makes it full, and it needs a `SecondStepProof`: a value made
 * here by `passedSecondStep`, for one session and one user, used once,
 * within a minute. A copy, a look-alike object or a proof for another
 * session is refused.
 *
 * **Only T-038's verifier may call `passedSecondStep`**, after it has
 * checked a TOTP or recovery code for that user. Until T-038 exists nothing
 * in the product calls it, so no session can become full: that is
 * deliberate (D-068: a full session must never be granted on the password
 * alone). Neither function is exported from `@oculus/db`'s index, and
 * `sessions.second-step.test.ts` fails if any source file other than
 * sessions.ts and the session tests imports this module. T-038 adds its
 * verifier to that list in the same change, with its own review.
 */
import type { SessionId, UserId } from "@oculus/core";

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
}

const proofs = new WeakMap<object, ProofRecord>();

/**
 * Records that `userId` passed the second step for `sessionId`.
 * **T-038's verifier only**, after checking the code against the session's
 * own user; see the module comment.
 */
export function passedSecondStep(sessionId: SessionId, userId: UserId): SecondStepProof {
  const proof: SecondStepProof = Object.freeze({ sessionId, userId });
  proofs.set(proof, { sessionId, userId, madeAt: performance.now() });
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
