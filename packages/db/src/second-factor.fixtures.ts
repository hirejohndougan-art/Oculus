/**
 * Test helpers for two-step sign-in (T-038). The key is made from an
 * obviously fake phrase at test time; it protects nothing real.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  hashRecoveryCode,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  type UserId,
} from "@oculus/core";
import type { Database } from "./client.js";
import { ratchetLink, secretContext } from "./second-factor.js";
import { loadSecretKeyring, sealSecret, type SecretKeyring } from "./secret-key.js";
import { sql } from "./sql.js";

/** A fake key for tests: SHA-256 of a phrase that says what it is. Not a secret. */
export const FAKE_TEST_SECRET_KEY = createHash("sha256")
  .update("FAKE OCULUS TEST KEY - NOT A SECRET - DO NOT USE", "utf8")
  .digest("base64url");

/** A second fake key, for rotation tests. */
export const FAKE_TEST_SECRET_KEY_2 = createHash("sha256")
  .update("SECOND FAKE OCULUS TEST KEY - NOT A SECRET", "utf8")
  .digest("base64url");

/** The keyring of `FAKE_TEST_SECRET_KEY`. */
export function testKeyring(): SecretKeyring {
  return loadSecretKeyring({ OCULUS_SECRET_KEY: FAKE_TEST_SECRET_KEY });
}

/** A person's test factor: its ID, the secret (for computing codes) and unused recovery codes. */
export interface TestFactor {
  readonly factorId: string;
  readonly secret: Uint8Array;
  readonly codes: string[];
}

/**
 * As the owner, gives `userId` an active TOTP factor and `count` recovery
 * codes without the set-up flow, so session tests can sign in many times
 * quickly (each sign-in uses up a code). The guard triggers are off only
 * inside this transaction and back on ALWAYS before it commits (D-067).
 */
export async function giveTestFactor(
  owner: Database,
  keys: SecretKeyring,
  userId: UserId,
  count = 60,
): Promise<TestFactor> {
  const factorId = randomUUID();
  const secret = newTotpSecret();
  const codes = Array.from({ length: count }, () => newRecoveryCode());
  const hashes = codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c) ?? ""));
  await owner.transaction(async (q) => {
    await q.execute(
      sql`ALTER TABLE public.second_factors DISABLE TRIGGER second_factors_check_new`,
    );
    await q.execute(sql`ALTER TABLE public.second_step_recovery_codes
      DISABLE TRIGGER second_step_recovery_codes_check_new`);
    await q.execute(sql`ALTER TABLE public.second_step_recovery_codes
      DISABLE TRIGGER second_step_recovery_codes_supersede`);
    await q.execute(sql`
      INSERT INTO public.second_factors
        (id, user_id, kind, state, secret_box, ratchet_anchor, ratchet_generation, last_step,
         enrol_session_id, created_at, confirmed_at, confirmed_xact)
      VALUES (${factorId}::uuid, ${userId}::uuid, 'totp', 'active',
              ${sealSecret(keys, secret, secretContext(factorId, userId))},
              ${createHash("sha256")
                .update(ratchetLink(secret, factorId, 0n))
                .digest()}, 0, -1,
              gen_random_uuid(), clock_timestamp(), clock_timestamp(), pg_current_xact_id())`);
    const setId = randomUUID();
    await q.execute(sql`
      INSERT INTO public.second_step_recovery_codes
        (user_id, factor_id, set_id, code_hash, created_at, created_xact)
      SELECT ${userId}::uuid, ${factorId}::uuid, ${setId}::uuid, h, clock_timestamp(),
             pg_current_xact_id()
      FROM unnest(${hashes}::bytea[]) AS h`);
    await q.execute(
      sql`ALTER TABLE public.second_factors ENABLE ALWAYS TRIGGER second_factors_check_new`,
    );
    await q.execute(sql`ALTER TABLE public.second_step_recovery_codes
      ENABLE ALWAYS TRIGGER second_step_recovery_codes_check_new`);
    await q.execute(sql`ALTER TABLE public.second_step_recovery_codes
      ENABLE ALWAYS TRIGGER second_step_recovery_codes_supersede`);
  });
  return { factorId, secret, codes };
}
