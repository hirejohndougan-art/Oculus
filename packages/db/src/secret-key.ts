/**
 * The server's secret key, `OCULUS_SECRET_KEY`, and the encryption of TOTP
 * secrets at rest with it (T-038, D-052, D-077).
 *
 * A TOTP secret can't be hashed: the server must read it to check codes. So
 * it is stored sealed with AES-256-GCM (`node:crypto`) under a key that is
 * never in the database or the repository, only in the server's
 * environment. A database leak or a backup alone then gives no secrets.
 *
 * - **The variable** holds at least 32 random bytes, as base64url (43+
 *   characters), standard base64, or hex (64+ characters). Make one with
 *   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
 *   Missing, malformed, shorter than 32 bytes, or with fewer than 16
 *   different byte values (a repeated or typed pattern) is refused with a
 *   `SecretKeyError` that never contains the value: the server must not
 *   start, and nothing can be enrolled without a keyring.
 * - **Key derivation:** HKDF-SHA-256 (RFC 5869) over the decoded bytes,
 *   salt `oculus/OCULUS_SECRET_KEY/v1`, info `totp secret encryption` for
 *   the 32-byte AES key and info `key id` for an 8-byte public fingerprint.
 *   Other uses of the variable later get their own info string, so no two
 *   uses share a key.
 * - **A sealed secret** is `0x01 ‖ key id (8) ‖ nonce (12) ‖ tag (16) ‖
 *   ciphertext`, with a random 96-bit nonce per seal (NIST SP 800-38D) and
 *   the factor's ID and its user's ID as additional data, so a sealed
 *   secret copied to another row or another person doesn't open.
 * - **Rotation:** set the new key in `OCULUS_SECRET_KEY` and the old one(s)
 *   in `OCULUS_SECRET_KEY_PREVIOUS` (comma-separated), run
 *   `resealSecondFactorSecrets` (second-factor.ts) until it reports nothing
 *   left under an old key, then drop the old key. Secrets sealed under a
 *   key that is no longer given can't be opened: those people use a
 *   recovery code, or a system admin resets their second step.
 * - **The key bytes never leave this module:** the keyring object holds
 *   only the current key's public fingerprint; the keys sit in a
 *   module-private WeakMap, so logging or serializing a keyring shows
 *   nothing secret.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const SECRET_KEY_VARIABLE = "OCULUS_SECRET_KEY";
export const PREVIOUS_SECRET_KEYS_VARIABLE = "OCULUS_SECRET_KEY_PREVIOUS";

const MIN_KEY_BYTES = 32;
const MIN_DISTINCT_BYTES = 16;
const MAX_KEY_TEXT = 512;
const SALT = "oculus/OCULUS_SECRET_KEY/v1";
const SEAL_VERSION = 0x01;
const KEY_ID_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES + NONCE_BYTES + TAG_BYTES;

/** Why the key was refused. The message never contains the key. */
export class SecretKeyError extends Error {
  constructor(
    readonly code:
      | "secret_key_missing"
      | "secret_key_malformed"
      | "secret_key_weak"
      | "secret_key_previous_invalid",
    message: string,
  ) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/** The loaded keys. Holds no key bytes itself: only the current key's public fingerprint. */
export interface SecretKeyring {
  /** The current key's 8-byte fingerprint as hex (not secret; tells keys apart). */
  readonly currentKeyId: string;
}

interface DerivedKey {
  readonly id: Buffer;
  readonly key: Buffer;
}

interface KeyMaterial {
  readonly current: DerivedKey;
  readonly all: readonly DerivedKey[];
}

const keyrings = new WeakMap<object, KeyMaterial>();

/** The bytes of a key as written in the variable, or `undefined` if it isn't one of the encodings. */
function decodeKeyText(text: string): Buffer | undefined {
  if (text.length > MAX_KEY_TEXT) return undefined;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 && text.length >= 64) {
    return Buffer.from(text, "hex");
  }
  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    const bytes = Buffer.from(text, "base64url");
    return bytes.toString("base64url") === text ? bytes : undefined;
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const bytes = Buffer.from(text, "base64");
    return bytes.toString("base64") === text ? bytes : undefined;
  }
  return undefined;
}

function derive(bytes: Buffer): DerivedKey {
  const key = Buffer.from(hkdfSync("sha256", bytes, SALT, "totp secret encryption", 32));
  const id = Buffer.from(hkdfSync("sha256", bytes, SALT, "key id", KEY_ID_BYTES));
  return { id, key };
}

function keyFromText(text: string, previous: boolean): DerivedKey {
  const fail = (code: "secret_key_malformed" | "secret_key_weak", message: string): never => {
    throw new SecretKeyError(previous ? "secret_key_previous_invalid" : code, message);
  };
  const name = previous ? PREVIOUS_SECRET_KEYS_VARIABLE : SECRET_KEY_VARIABLE;
  const bytes = decodeKeyText(text);
  if (bytes === undefined) {
    return fail(
      "secret_key_malformed",
      `${name} must be base64url, base64 or hex text of at least 32 random bytes, with no spaces.`,
    );
  }
  try {
    if (bytes.length < MIN_KEY_BYTES) {
      return fail("secret_key_weak", `${name} must hold at least 32 random bytes.`);
    }
    if (new Set(bytes).size < MIN_DISTINCT_BYTES) {
      return fail(
        "secret_key_weak",
        `${name} doesn't look random. Make a new one from random bytes.`,
      );
    }
    return derive(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Reads `OCULUS_SECRET_KEY` (and `OCULUS_SECRET_KEY_PREVIOUS`, if set) from
 * `env` and derives the keys. Throws `SecretKeyError` if the key is missing,
 * malformed or weak, or a previous key is: **the server must refuse to start
 * then** (T-045, T-051 call this at startup), and two-step sign-in can't be
 * set up without a keyring.
 */
export function loadSecretKeyring(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretKeyring {
  const text = env[SECRET_KEY_VARIABLE];
  if (typeof text !== "string" || text === "") {
    throw new SecretKeyError(
      "secret_key_missing",
      `${SECRET_KEY_VARIABLE} is not set. Two-step sign-in needs it to protect TOTP secrets; set it to at least 32 random bytes (base64url) before starting Oculus.`,
    );
  }
  const current = keyFromText(text, false);
  const all = [current];
  const previousText = env[PREVIOUS_SECRET_KEYS_VARIABLE];
  if (typeof previousText === "string" && previousText !== "") {
    for (const part of previousText.split(",")) {
      const key = keyFromText(part, true);
      if (!all.some((k) => k.id.equals(key.id))) all.push(key);
    }
  }
  const keyring: SecretKeyring = Object.freeze({ currentKeyId: current.id.toString("hex") });
  keyrings.set(keyring, Object.freeze({ current, all: Object.freeze(all) }));
  return keyring;
}

/** True for a keyring `loadSecretKeyring` made. */
export function isSecretKeyring(value: unknown): value is SecretKeyring {
  return typeof value === "object" && value !== null && keyrings.has(value);
}

function material(keyring: unknown): KeyMaterial {
  const found = typeof keyring === "object" && keyring !== null ? keyrings.get(keyring) : undefined;
  if (found === undefined) {
    throw new TypeError("Two-step sign-in needs the keyring from loadSecretKeyring.");
  }
  return found;
}

/** Throws unless `keyring` came from `loadSecretKeyring`. */
export function assertSecretKeyring(keyring: unknown): asserts keyring is SecretKeyring {
  material(keyring);
}

/** Seals `plaintext` under the current key, bound to `context` (additional data). */
export function sealSecret(keyring: SecretKeyring, plaintext: Uint8Array, context: string): Buffer {
  const { current } = material(keyring);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", current.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), current.id, nonce, cipher.getAuthTag(), body]);
}

/**
 * Opens a sealed secret with whichever loaded key sealed it, checking
 * `context`; `undefined` if it is malformed, sealed under a key not loaded,
 * or doesn't authenticate (changed, or copied from another row). Never
 * throws for a bad box.
 */
export function openSecret(
  keyring: SecretKeyring,
  box: Uint8Array,
  context: string,
): Buffer | undefined {
  const { all } = material(keyring);
  const sealed = Buffer.from(box);
  if (sealed.length <= HEADER_BYTES || sealed[0] !== SEAL_VERSION) return undefined;
  const id = sealed.subarray(1, 1 + KEY_ID_BYTES);
  const key = all.find((k) => k.id.equals(id));
  if (key === undefined) return undefined;
  const nonce = sealed.subarray(1 + KEY_ID_BYTES, 1 + KEY_ID_BYTES + NONCE_BYTES);
  const tag = sealed.subarray(1 + KEY_ID_BYTES + NONCE_BYTES, HEADER_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  }
}

/** True if `box` is sealed under a key other than the current one (rotation still to do). */
export function sealedUnderOldKey(keyring: SecretKeyring, box: Uint8Array): boolean {
  const { current } = material(keyring);
  const sealed = Buffer.from(box);
  return !(sealed.length > HEADER_BYTES && current.id.equals(sealed.subarray(1, 1 + KEY_ID_BYTES)));
}
